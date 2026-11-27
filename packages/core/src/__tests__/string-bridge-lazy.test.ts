/**
 * 缺陷类 R —— 字符串桥接**不得提前解析 HTML**（2026-09-21）。
 *
 * 背景（实测数据见 `tmp/probe-leak5.mts`）：
 * - jsdom 每次 `parseHtml` **常驻约 1MB**（强 GC 两次后仍留存 959KB/次）；
 * - `AnalyzeRule.bindings()` 对**每个 JS 段**的 result 都要桥接，而 `strWithJsoup` 此前
 *   **立刻** `parseHtml(html)`（`$`/`result` 还各来一次）→ **约 2MB/次求值**；
 * - 后果：📂书文小说（1500+ 章 · 目录 16 页）在详情阶段把 2GB 堆打爆（`Reached heap limit`）。
 *
 * 修法：① `attachJsoupMethods` 接受**惰性元素源**（首次真正调用 jsoup 方法才解析、只解析一次）；
 *       ② `bindings()` 的 `$` 与 `result` 复用同一个桥接对象（Legado 里本就是同一个值）。
 *
 * 本测试锁三条不变量：
 * 1. 只用字符串方法（replace/match/JSON.parse）→ **0 次**解析；
 * 2. 真调 jsoup 方法（select/toArray）→ 才解析，且同一包装内**只解析一次**；
 * 3. 字符串人格不变（`String(wrapper)` / `+wrapper` 仍是原文，不是整页 HTML）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtml, parseHtmlStats } from '../index';

function envOf() {
  const variables = createVariableStore();
  const jsEval = createJsEvaluator({ variables });
  return { baseUrl: 'https://www.shuww.com/book/37491/d1.html', variables, jsEval, jsEvalSync: jsEval };
}

/** 前一段产出**字符串**（模拟 `chapterName='text'` 之后的 `@js:` 段），字符串里带 HTML */
const HTML_STR = '<a href="/book/37491/25651880.html" onclick="read_tz(25651880);">第1章 远航</a>';

async function runPair(jsCode: string): Promise<{ out: string; parses: number }> {
  const env = envOf();
  const rule = `#x@html\n@js:\n${jsCode}`;
  const html = `<div id="x">${HTML_STR}</div>`;
  // ⚠️ 内容先解析成**元素**（引擎真实形态：内容早就是已解析的元素），
  //    否则计数会把「解析内容本身」也算进去，测不到**桥接**是否惰性。
  const dom = parseHtml(html, env.baseUrl);
  const el = dom.root.querySelector('#x') as Element;
  parseHtmlStats.count = 0; // 只统计本次求值
  const r = new AnalyzeRule(env).setContent(el as never, env.baseUrl);
  const out = await r.getString(rule);
  return { out, parses: parseHtmlStats.count };
}

test('只用字符串方法 → 不得触发任何 parseHtml（每次求值曾是 ~2MB 泄漏）', async () => {
  const { out, parses } = await runPair('result.replace(/<[^>]+>/g, "")');
  assert.equal(parses, 0, `字符串方法不该解析 HTML，实际解析 ${parses} 次`);
  assert.equal(out, '第1章 远航');
});

test('JSON.parse 场景同样不解析（源脚本把 result 当纯文本）', async () => {
  const { out, parses } = await runPair('JSON.stringify({ t: result.indexOf("onclick") })');
  assert.equal(parses, 0, `不该解析 HTML，实际 ${parses} 次`);
  assert.ok(/"t":\d+/.test(out), `字符串人格必须保留（indexOf 应返回数字）：${out}`);
});

test('真调 jsoup 方法时才解析，且同一包装内只解析一次（惰性生效，不是永不解析）', async () => {
  const { out, parses } = await runPair('result.select("a").attr("href")');
  assert.ok(out.includes('/book/37491/25651880.html'), `jsoup 方法必须可用：${out}`);
  assert.equal(parses, 1, `同一包装内应只解析一次，实际 ${parses} 次`);
});

test('字符串人格：String(wrapper) / 模板拼接仍是原文（不是整页 HTML）', async () => {
  const { out, parses } = await runPair('String(result) + "|" + result.slice(0, 3)');
  assert.equal(parses, 0, `不该解析：${parses}`);
  assert.ok(!out.includes('<html>'), `不得被包成整页 HTML：${out}`);
  assert.ok(out.includes('第1章 远航'), `应保留原文内容：${out}`);
  assert.ok(out.includes('|<di'), `模板拼接应按原文取前 3 字符：${out}`);
});
