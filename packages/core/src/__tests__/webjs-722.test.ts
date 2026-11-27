/**
 * `@webjs:` 规则模式回归锁（`#722`，对齐 Legado `AnalyzeRule.getWebJsResult`）。
 *
 * 上游 `getWebJsResult`（`AnalyzeRule.kt:180-199`）用 `BackstageWebView(url=baseUrl, html=content, js)`
 * 取脚本返回值；本仓把这条能力收口成 `AnalyzeEnv.webJsRender`（引擎注入 `ctx.renderHtmlScript`）。
 *
 * 关键口径：**渲染器不可用或抛错 ⇒ 该段降级为空串 + `@webjs degraded` 留痕，不抛整条规则**
 * （此前两处 `throw new Error('WebJs/WebView 不在 L1 范围')` 会让整字段求值炸掉）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore } from '../index';

function ruleOn(content: unknown, webJsRender?: (html: string, baseUrl: string, js: string) => Promise<string>) {
  const variables = createVariableStore();
  const env = {
    baseUrl: 'https://x.test/',
    variables,
    jsEval: createJsEvaluator({ variables }),
    ...(webJsRender ? { webJsRender } : {}),
  };
  return new AnalyzeRule(env as never).setContent(content as never, 'https://x.test/');
}

test('渲染器不可用 ⇒ 空串，不抛（不再炸整条规则）', async () => {
  const out = await ruleOn('<div id="a">x</div>').getString('@webjs:document.title');
  assert.equal(out, '');
});

test('渲染器抛错 ⇒ 空串 + 降级（不抛）', async () => {
  const out = await ruleOn('<div id="a">x</div>', async () => {
    throw new Error('no cdp');
  }).getString('@webjs:document.title');
  assert.equal(out, '');
});

test('渲染器可用 ⇒ 走通道，html/baseUrl/js 三参如实传入，返回脚本结果', async () => {
  let seen: { html?: string; baseUrl?: string; js?: string } = {};
  const ar = ruleOn('<div id="a">x</div>', async (html, baseUrl, js) => {
    seen = { html, baseUrl, js };
    return 'TITLE';
  });
  const out = await ar.getString('@webjs:document.title');
  assert.equal(out, 'TITLE');
  assert.equal(seen.baseUrl, 'https://x.test/');
  assert.equal(seen.js, 'document.title');
  assert.ok(String(seen.html).includes('id="a"'), `html 应为原内容：${seen.html}`);
});
