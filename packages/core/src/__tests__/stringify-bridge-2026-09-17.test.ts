/**
 * 回归锁：**字符串绑定的「字符串人格」必须还在**（2026-09-17 第三轮，类别性缺陷）。
 *
 * 症状簇（三个源、三种表现，同一根因）：
 *   · 腾讯漫画 目录章节名变成 `<html><head></head><body>预告</body></html>`
 *   · 枫叶音乐盒 点分类 → `RULE_PARSE@parse | Unexpected token '<', "<html><hea"... is not valid JSON`
 *   · 绿柠小说 正文 → 同样 `Unexpected token '<'`（此前被误判为「站点返回 HTML」）
 *
 * 根因：`bridgeDom(v)` 对**字符串**返回 `strWithJsoup`（String 包装 + jsoup 方法），
 * 但统一的 `attachJsoupMethods` 把 `toString`/`Symbol.toPrimitive` 写成了**元素语义**
 * （`els[0].outerHTML`）。而 `strWithJsoup` 为了提供 jsoup 方法会把这段字符串 `parseHtml()` 一遍，
 * 于是 `String(包装)` = `parseHtml('{"a":1}').root.outerHTML` = `<html><head></head><body>…</body></html>`
 * → `JSON.parse(result)` 拿到 HTML、`&&` 拼接/模板串把文本包成整页 HTML。
 *
 * Legado 语义：**字符串就是字符串**（`String(x)` 对 String 返回自身）；只有 **Element / Elements**
 * 的 `toString()` 才是 outerHTML。两者不能共用一套。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

/** 真实 JS 求值器（不是桩）：本缺陷只在真求值时暴露 */
function makeEnv() {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables }) as (code: string, b: Record<string, unknown>) => unknown;
  const env = {
    baseUrl: 'https://t.test/',
    variables,
    jsEval: async (code: string, b: Record<string, unknown>) => ev(code, b),
    jsEvalSync: (code: string, b: Record<string, unknown>) => ev(code, b),
    toAbsolute: (u: string) => u,
  };
  return { env: env as never, ev };
}

test('字符串绑定：JSON.parse(result) 必须能解析（不得被包成整页 HTML）', async () => {
  const { env } = makeEnv();
  const out = await new AnalyzeRule(env).setContent('{"a":1,"b":"x"}', 'https://t.test/').getString('@js:JSON.parse(result).a', false);
  assert.equal(String(out), '1', `JSON.parse(result) 失败 → result 被转成了 HTML：${String(out).slice(0, 120)}`);
});

test('字符串绑定：String(result) 必须等于原字符串（文本内容不得变成整页 HTML）', async () => {
  const { env } = makeEnv();
  const out = await new AnalyzeRule(env).setContent('预告', 'https://t.test/').getString('@js:String(result)', false);
  assert.equal(String(out), '预告', `文本被包成 HTML：${String(out).slice(0, 120)}`);
});

test('字符串绑定：result.replace 链式后不得再出现整页 HTML（腾讯漫画 chapterName 形态）', async () => {
  const { env } = makeEnv();
  const html = '<html><body><i class="ui-icon-pay"><a href="/c/1">预告</a></i></body></html>';
  const out = await new AnalyzeRule(env).setContent(html, 'https://t.test/').getString(
    'i@class&&tag.a@text@js:result.replace(/ui-icon-pay/g,"").replace(/\\s*/g,"")',
    false,
  );
  assert.ok(!String(out).includes('<html'), `章节名被包成 HTML：${String(out).slice(0, 120)}`);
  assert.ok(String(out).includes('预告'), `章节名应含正文文本：${JSON.stringify(String(out))}`);
});

test('元素绑定：String(element) 仍必须是 outerHTML（Legado 语义，别被上一个修复带坏）', async () => {
  const { env } = makeEnv();
  const html = '<html><body><div class="box"><a href="/x">甲</a></div></body></html>';
  const out = await new AnalyzeRule(env).setContent(html, 'https://t.test/').getString(
    '@js:String(result.select("a"))',
    false,
  );
  assert.ok(String(out).includes('<a href="/x">'), `元素/元素列表的 String() 应为 outerHTML：${String(out).slice(0, 120)}`);
});
