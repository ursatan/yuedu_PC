/**
 * M4 @put/@get 测试 —— 语义对齐 Legado AnalyzeRule：
 *  - @put:{...}：JSON 映射从规则文本剥离；值是「规则串」，经 getString 求值
 *    （返回字符串）后存入变量（Legado: splitPutRule → putRule → put(key, getString(value))）
 *  - @get:{key}：整段规则 → 直接返回变量值（Legado getRuleType 段）
 *  - {{expr}}：整段规则 → JS 求值（Legado jsRuleType 段），this.get 可读变量
 *  - 变量跨 getString 调用持久（同一 VariableStore = Legado 的 chapter/book 变量）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnalyzeRule, createJsEvaluator, createVariableStore, parseHtml } from '../index';
import type { AnalyzeEnv } from '../index';

const HTML = `<html><body><h1>剑来</h1><span class="cnt">10</span></body></html>`;
const JSON_DOC = JSON.stringify({ title: '剑来', cnt: 10 });

function makeEnv(): AnalyzeEnv {
  const variables = createVariableStore();
  return {
    baseUrl: 'https://x.com/',
    variables,
    jsEval: createJsEvaluator({ variables }),
  };
}

test('@put: 值按规则求值后写入变量（字符串，对齐 put(key, getString(value))）', async () => {
  const env = makeEnv();
  const r = new AnalyzeRule(env).setContent(JSON_DOC);
  const out = await r.getString('$.title@put:{"n":"$.cnt"}');
  assert.equal(out, '剑来'); // @put 文本已剥离
  assert.equal(env.variables.get('n'), '10'); // getString 返回字符串 —— 对齐 Legado
});

test('@put: CSS 规则值同样求值后入库（HTML 文档）', async () => {
  const env = makeEnv();
  const dom = parseHtml(HTML, 'https://x.com/');
  const r = new AnalyzeRule(env).setContent(dom.root);
  const out = await r.getString('h1@text@put:{"name":".cnt@text"}');
  assert.equal(out, '剑来');
  assert.equal(env.variables.get('name'), '10');
});

test('@get: 整段规则直接返回变量值；跨 getString 调用持久（跨阶段传递）', async () => {
  const env = makeEnv();
  const dom = parseHtml(HTML, 'https://x.com/');
  const r = new AnalyzeRule(env).setContent(dom.root);

  // 阶段 1（如详情页）：把字段写入变量
  await r.getString('.cnt@text@put:{"pageCount":".cnt@text"}');
  // 阶段 2（如目录页）：整段 @get 读出 —— Legado getRuleType 语义
  const v = await r.getString('@get:{pageCount}');
  assert.equal(v, '10');
});

test('{{}}: 整段 JS 求值；this.get 可读变量（Legado jsRuleType 语义）', async () => {
  const env = makeEnv();
  env.variables.set('kw', '剑来');
  const r = new AnalyzeRule(env).setContent(JSON_DOC);
  const out = await r.getString("{{ this.get('kw') + '-p' + (1+1) }}");
  assert.equal(out, '剑来-p2');
});

test('@put 的键写入但结果不受污染', async () => {
  const env = makeEnv();
  const r = new AnalyzeRule(env).setContent(JSON_DOC);
  const out = await r.getString('$.title@put:{"a":"$.cnt"}');
  assert.equal(out, '剑来');
  assert.equal(env.variables.get('a'), '10');
  // 变量可被后续整段 @get 消费
  assert.equal(await r.getString('@get:{a}'), '10');
});

// ---- M4 复合段：字面文本 + @get/{{}} 拼接（对齐 Legado makeUpRule）----

test('复合段: 字面 + @get + {{}} 拼成 URL（getString 输出拼接文本）', async () => {
  const env = makeEnv();
  env.variables.set('kw', '剑来');
  const r = new AnalyzeRule(env).setContent(JSON_DOC);
  const url = await r.getString('https://x.com/api?kw=@get:{kw}&p={{1+1}}', true);
  assert.equal(url, 'https://x.com/api?kw=剑来&p=2');
});

test('复合段: {{}} 内容是规则串时按规则求值（Legado isRule 分支）', async () => {
  const env = makeEnv();
  const r = new AnalyzeRule(env).setContent(JSON_DOC);
  const out = await r.getString('前缀:{{$.title}}:后缀');
  assert.equal(out, '前缀:剑来:后缀');
});

test('复合段: @get 与 ## 清洗组合（Legado makeUpRule 末尾分离 ##）', async () => {
  const env = makeEnv();
  const dom = parseHtml(HTML, 'https://x.com/');
  const r = new AnalyzeRule(env).setContent(dom.root);
  await r.getString('.cnt@text@put:{"a":".cnt@text"}');
  // ## 格式为 ##正则##替换（三段，对齐 Legado rule.split("##")）
  const out = await r.getString('@get:{a}##10##20');
  assert.equal(out, '20');
});

test('复合段: 纯字面含 {{}} 于 ## 之后时不参与拼接（前缀含 ## 的守卫条件）', async () => {
  const env = makeEnv();
  const r = new AnalyzeRule(env).setContent(JSON_DOC);
  // ## 之后的 {{1}} 属于 replacement 文本，走普通规则路径（resolvePlaceholders 文本替换）
  const out = await r.getString('$.title##title|{{1+1}}集');
  assert.equal(out, '剑来');
});
