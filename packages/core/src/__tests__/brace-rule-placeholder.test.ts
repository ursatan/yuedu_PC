/**
 * `{{...}}` 里**本身是一条规则**时必须当规则求值（对齐 Legado `AnalyzeRule.makeUpRule:791-808`）。
 *
 * 规则：`{{expr}}` 的 expr 以 `@` / `$.` / `$[` / `//` 起头 = `isRule` → 走 `getString(rule)`；
 * 否则才是 `evalJS(expr)`。
 *
 * 实测背景（⚡📂英文小说（英）正文全空）：
 *   content 规则是 `{{@css:.text-content1 .c-en@text||.text-content1@text}}`，
 *   旧实现把它当 JS 编译 → `Invalid or unexpected token`（`@` 在 JS 里非法）。
 *   语料该形态 21 处：`@` 前缀 12（`{{@@h1@text}}` / `{{@class.train-number@text}}`）+
 *   JSONPath 起头 9（`{{$.intro}}` / `{{$.cover||$.novel_cover}}`）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtml } from '../index';
import type { AnalyzeEnv } from '../index';
import { splitSourceRule } from '../selector/rule-analyzer';

const HTML = '<html><body><div class="text-content1"><p class="c-en">Hello world</p></div></html>';

function makeEnv(): AnalyzeEnv {
  const variables = createVariableStore();
  return { baseUrl: 'https://x.com/', variables, jsEval: createJsEvaluator({ variables }) };
}

test('分派：{{规则}} 走规则模式（含 @@/@css:/JSONPath），{{纯JS}} 才走 Js 段', () => {
  const css = splitSourceRule('{{@css:.a .b@text||.c@text}}');
  assert.equal(css.length, 1);
  assert.equal(css[0]?.mode, 'Default', '`@css:` 前缀必须落默认(CSS)模式');
  assert.equal(css[0]?.isCss, true, 'isCss 必须置位（后端据此剥离前缀）');
  assert.ok(!css[0]?.rawRule.startsWith('{{'), '求值部分不得再带 {{}} 外壳');

  const at2 = splitSourceRule('{{@@h1@text}}');
  assert.equal(at2[0]?.mode, 'Default');
  assert.ok(!at2[0]?.rawRule.includes('@@'), '`@@` 前缀应在切段时剥离');

  const json = splitSourceRule('{{$.intro}}');
  assert.equal(json[0]?.mode, 'Json', '`$.` 起头是 JSONPath 规则');

  const js = splitSourceRule('{{java.timeFormatUTC(java.getString("$.t")*1000,"yyyy-MM-dd",8)}}');
  assert.equal(js[0]?.mode, 'Js', '真 JS 表达式必须仍走 Js 段');

  const js2 = splitSourceRule("{{'💬点击地址栏下载'}}");
  assert.equal(js2[0]?.mode, 'Js', '字符串字面量 JS 表达式仍走 Js 段');
});

test('端到端：{{@css:…}} 正文规则不再被当 JS 求值（旧实现抛 Invalid or unexpected token）', async () => {
  const env = makeEnv();
  const dom = parseHtml(HTML, 'https://x.com/');
  const r = new AnalyzeRule(env).setContent(dom.root);
  const out = await r.getString('{{@css:.text-content1 .c-en@text||.text-content1@text}}');
  assert.equal(out, 'Hello world', `CSS 规则应取到正文文本：${out}`);
});

test('端到端：{{@@选择器@text}} 同样按规则求值', async () => {
  const env = makeEnv();
  const dom = parseHtml(HTML, 'https://x.com/');
  const r = new AnalyzeRule(env).setContent(dom.root);
  assert.equal(await r.getString('{{@@.c-en@text}}'), 'Hello world');
});
