/**
 * 回归锁：2026-09-16 修的三个引擎缺陷（均由「Web 端 20+ 源实测」暴露）。
 *
 * 1. `@js:` 规则体含 `{{}}` 时不得提前当字面量返回
 *    —— 否则返回脚本原文，再被 toAbsolute 编码成 `base + '@js:t=%22...'`。
 *    （实测：全免漫画 `ruleSearch.bookUrl`）
 * 2. 「已是绝对 URL」必须原样返回，不得过 `new URL()`
 *    —— 否则 `,{"method":"GET",...}` 选项尾巴里的 `"` 被编码成 `%22`，选项解析失败。
 *    （实测：全免漫画 detail 请求丢签名头）
 * 3. JSONPath 取到**对象/数组**时要返回 JSON 文本，不能 `String()` 成 `[object Object]`
 *    —— 否则「取值后再加工」的源全断（明文、二次解析、解密）。
 *    （实测：全免漫画 chapterList 的 `String(java.getString("$.data"))` + base64/AES 解密）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzeRule } from '../selector/analyze';
import { jsonGetString } from '../selector/jsonpath';
import { resolveUrl } from '../net';
import { createVariableStore } from '../store';

function makeEnv(jsCalls: string[], jsReturn: string) {
  const env = {
    baseUrl: 'https://api.test/',
    variables: createVariableStore(),
    jsEval: async (code: string) => { jsCalls.push(code); return jsReturn; },
    jsEvalSync: (code: string) => { jsCalls.push(code); return jsReturn; },
    toAbsolute: (u: string) => resolveUrl('https://api.test/', u),
  };
  return env as never;
}

test('@js: 规则体含 {{}} 时必须执行脚本，不得提前返回脚本原文', async () => {
  const jsCalls: string[] = [];
  const env = makeEnv(jsCalls, 'https://real.example/api?id=7');
  // 复刻全免漫画 ruleSearch.bookUrl 的形态：@js: + 脚本体里含 {{}}
  const rule = '@js:\nt="https://real.example/api?id={{$.comic_id}}";\nt;';
  const out = await new AnalyzeRule(env)
    .setContent(JSON.stringify({ comic_id: 86351 }), 'https://api.test/')
    .getString(rule, true);
  assert.ok(jsCalls.length > 0, '脚本必须被执行');
  assert.equal(out, 'https://real.example/api?id=7');
  assert.ok(!out.includes('@js:'), `不得返回脚本原文：${out}`);
  assert.ok(!out.includes('%22'), `不得被 URL 编码：${out}`);
});

test('resolveUrl：绝对 URL 原样返回（保留 ,{options} 尾巴里的引号）', () => {
  const url = 'https://api.test/x?y=1,{"method":"GET","headers":{"m-request-id":"abc"}}';
  assert.equal(resolveUrl('https://base/', url), url, '尾巴必须原样保留');
  assert.ok(!resolveUrl('https://base/', url).includes('%22'), '不得出现 %22');

  // 相对路径仍要能正常绝对化
  assert.equal(resolveUrl('https://base/a/b', '../c'), 'https://base/c');
  assert.equal(resolveUrl('https://base/a/', 'd/e'), 'https://base/a/d/e');
  // base 末段是「文件」时按 WHATWG 语义替换（与 Legado URL(base).resolve 一致）
  assert.equal(resolveUrl('https://base/a', 'd/e'), 'https://base/d/e');
  // 协议相对
  assert.equal(resolveUrl('https://base/a', '//cdn.test/x.js'), 'https://cdn.test/x.js');
  // data: 原样
  assert.equal(resolveUrl('https://base/', 'data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
});

test('JSONPath 取到对象/数组时返回 JSON 文本（不是 [object Object]）', () => {
  const json = JSON.stringify({ data: { a: 1, list: [{ x: 1 }, { x: 2 }] }, status: 1 });
  const env = makeEnv([], '');
  const ar = new AnalyzeRule(env).setContent(json, 'https://api.test/');

  const dataText = ar.syncGetString('$.data');
  assert.notEqual(dataText, '[object Object]', '对象取值不得变成 [object Object]');
  assert.deepEqual(JSON.parse(dataText), { a: 1, list: [{ x: 1 }, { x: 2 }] });

  // 标量仍然是普通文本
  assert.equal(ar.syncGetString('$.status'), '1');
  // 数组元素是对象时同样保留 JSON
  const listText = ar.syncGetStringList('$.data.list[*]');
  assert.equal(listText.length, 2);
  assert.deepEqual(JSON.parse(listText[0] as string), { x: 1 });

  // jsonGetString 直连（走同一实现）
  const direct = jsonGetString('$.data', JSON.parse(json), env);
  assert.deepEqual(JSON.parse(direct), { a: 1, list: [{ x: 1 }, { x: 2 }] });
});
