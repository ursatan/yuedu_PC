/**
 * 回归锁：**JSON 文档归一化**（2026-09-22，用户实测 ①宜搜小说正文空 / 51漫画目录 0 章的同一根因）。
 *
 * 背景：复合规则的**段间**会把上段结果当作下段的文档。段 1 常是 `<js>`（返回 JSON 字符串），
 * 段 2 是 `$.content` / `$[*]` 这类 JSONPath。旧实现只对「纯字符串」解析，两个缺口：
 *  · **String 包装对象**：`java.ajax` 返回的是 `StrResponse = new String(body) + 方法`，
 *    `typeof` 为 `'object'` → 旧 `asJson` 走 `typeof v === 'object' → return v` → JSONPath 在包装对象上找字段 → **恒空**；
 *  · jsonpath 层不归一化文档，`jsonGetList` 直接吃字符串。
 *
 * 权威依据（Legado `AnalyzeByJSonPath.kt:18-22`）：
 * ```kotlin
 * fun parse(json: Any): ReadContext = when {
 *     is String -> JsonPath.parse(json)      // 字符串按 JSON 文本解析
 *     else -> JsonPath.parse(json)
 * }
 * ```
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';
import { jsonGetList, jsonGetString, jsonGetStringList } from '../selector/jsonpath';

const env = { variables: createVariableStore() } as never;

test('jsonpath：文档是 JSON 字符串时必须解析（段间传递的常见形态）', () => {
  const doc = '{"content":"FROM-STRING","list":[{"t":"A"},{"t":"B"}]}';
  assert.equal(jsonGetString('$.content', doc, env), 'FROM-STRING');
  assert.equal(jsonGetList('$.list[*]', doc, env).length, 2);
  assert.deepEqual(jsonGetStringList('$.list[*].t', doc, env), ['A', 'B']);
});

test('jsonpath：文档是 String 包装对象（StrResponse 形态）时同样要解析', () => {
  // eslint-disable-next-line no-new-wrappers
  const wrapped = new String('{"content":"FROM-WRAP","list":[{"t":"A"}]}');
  (wrapped as unknown as Record<string, unknown>)['body'] = function () {
    return String(this);
  };
  assert.equal(jsonGetString('$.content', wrapped, env), 'FROM-WRAP');
  assert.equal(jsonGetList('$.list[*]', wrapped, env).length, 1);
});

test('jsonpath：非 JSON 文档（HTML/纯文本）不猜、不抛错', () => {
  assert.equal(jsonGetString('$.content', '<html><body>x</body></html>', env), '');
  assert.equal(jsonGetString('$.content', 'plain text', env), '');
  assert.equal(jsonGetList('$.a[*]', 'plain text', env).length, 0);
});

test('复合规则段间：`<js>JSON.stringify(...)</js>$.content` 必须取到值（①宜搜正文形态）', () => {
  const variables = createVariableStore();
  const jsEval = createJsEvaluator({ variables });
  const ar = new AnalyzeRule({ variables, jsEvalSync: jsEval, jsEval } as never).setContent('x');
  assert.equal(ar.syncGetString('<js>JSON.stringify({content:"FROM-JS"})</js>$.content'), 'FROM-JS');
  // 51漫画目录形态：`<js>JSON.stringify(array)</js>\n$[*]`
  assert.deepEqual(ar.syncGetStringList('<js>JSON.stringify(["A","B"])</js>\n$[*]'), ['A', 'B']);
});

test('复合规则段间：段 1 返回 String 包装对象（java.ajax 形态）→ 段 2 仍能取字段', () => {
  const variables = createVariableStore();
  const jsEval = createJsEvaluator({ variables });
  const ar = new AnalyzeRule({ variables, jsEvalSync: jsEval, jsEval } as never).setContent('x');
  const seg1 = 'var r = new String(JSON.stringify({content:"FROM-AJAX"})); r.body=function(){return String(this);}; r';
  assert.equal(ar.syncGetString(`<js>${seg1}</js>$.content`), 'FROM-AJAX');
});

test('文档本身就是对象（已是 JSON）时照常工作——归一化不得破坏原有路径', () => {
  assert.equal(jsonGetString('$.content', { content: 'OBJ' }, env), 'OBJ');
});
