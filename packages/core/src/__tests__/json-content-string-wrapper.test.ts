/**
 * 回归锁：**内容判定 `isJson` 不能按 `typeof` 判**（缺陷类AK，2026-09-23）。
 *
 * 权威语义（Legado `AnalyzeRule.setContent:104-107`）：
 *     `isJSON = when (content) { is Node -> false; else -> content.toString().isJson() }`
 * 即「**先字符串化，再判是不是 JSON**」；只有 DOM Node 例外。
 *
 * 我们此前写的是 `typeof v === 'object'` → true，对**字符串包装对象**判错：
 *   · `src` 绑定 = `bridgeDom(content)` = `new String(html)` + jsoup 方法；
 *   · `java.ajax` 返回 = `new String(body)` + `.body()/.code()`。
 * 它们的 `typeof` 是 `'object'` 但语义是**字符串**。
 * 一旦判成 JSON，`detectMode`（`rule-analyzer.ts:248` 的 `isContentJson || …`）
 * 会把**任何规则**归到 JSONPath 后端 ⇒ CSS 规则**静默返空**。
 *
 * 实测症状（🎨51漫画「单章目录 0 章」）：源的目录回退分支
 *     `[{ title: book.name, url: java.getString(".btn-read@href", src) }]`
 * `java.getString(rule, mContent)` → `new AnalyzeRule(env).setContent(mContent)`，
 * 内容正是 HTML 的 String 包装 ⇒ `.btn-read@href` 走 JSONPath ⇒ 恒空
 * ⇒ 章节 url/标题全空 ⇒ 被 `if (!ct) continue` 滤掉 ⇒ 0 章。
 * 引擎内探针对照（同一份 HTML）：原始字符串 → `/comic/10944/chapter/28643` ✅；String 包装 → `""` ❌。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtml } from '../index';
import type { AnalyzeEnv } from '../index';

const HTML = `<html><body><div class="comic"><a class="btn-read" href="/comic/10944/chapter/28643">开始阅读</a></div></body></html>`;

function makeEnv(): AnalyzeEnv {
  const variables = createVariableStore();
  return { baseUrl: 'https://51acgs.com/', variables, jsEval: createJsEvaluator({ variables }) };
}

/** 近似 `bridgeDom(string)` 的形态：String 包装 + toString 还原原文 */
function stringWrapper(html: string): unknown {
  const w = new String(html) as unknown as Record<string, unknown>;
  for (const k of ['toString', 'valueOf'] as const) {
    Object.defineProperty(w, k, { value: () => html, writable: true, configurable: true });
  }
  Object.defineProperty(w, Symbol.toPrimitive, { value: () => html, writable: true, configurable: true });
  return w;
}

test('String 包装内容上的 CSS 规则必须求值（旧实现判成 JSON → 恒空）', () => {
  const r = new AnalyzeRule(makeEnv()).setContent(stringWrapper(HTML), 'https://51acgs.com/comic/10944');
  assert.equal(r.syncGetString('.btn-read@href'), '/comic/10944/chapter/28643');
});

test('String 包装内容是 HTML 时不得按 JSON 后端求值（回归锁：与原始字符串同解）', () => {
  const env = makeEnv();
  const raw = new AnalyzeRule(env).setContent(HTML, 'https://51acgs.com/comic/10944').syncGetString('.btn-read@href');
  const wrapped = new AnalyzeRule(makeEnv()).setContent(stringWrapper(HTML), 'https://51acgs.com/comic/10944').syncGetString('.btn-read@href');
  assert.equal(wrapped, raw);
  assert.equal(raw, '/comic/10944/chapter/28643');
});

test('String 包装内容是 JSON 文本时仍按 JSON 后端（不能被这次修复改坏）', () => {
  const r = new AnalyzeRule(makeEnv()).setContent(stringWrapper('{"title":"剑来","cnt":10}')).syncGetString('$.title');
  assert.equal(r, '剑来');
});

test('DOM 元素数组不是 JSON（Legado：Elements.toString() = outerHTML，以 < 起头）', () => {
  const dom = parseHtml(HTML, 'https://51acgs.com/');
  const els = Array.from(dom.root.querySelectorAll('a'));
  assert.equal(els.length, 1);
  const r = new AnalyzeRule(makeEnv()).setContent(els, 'https://51acgs.com/').syncGetString('@href');
  assert.equal(r, '/comic/10944/chapter/28643');
});

test('普通 JSON 对象数组仍按 JSON 后端（缺陷类V 的能力不得回退）', () => {
  const r = new AnalyzeRule(makeEnv()).setContent([{ title: 'A' }, { title: 'B' }]).syncGetString('$[1].title');
  assert.equal(r, 'B');
});
