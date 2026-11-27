/**
 * **`#639`（2026-10-26）** JSONPath 根前缀归一：Jayway 允许省略 `$`，jsonpath-plus 不补 ⇒ 静默 0 条。
 *
 * ## 真站取证（书旗听书本地源（同人），用户实测第 4 条）
 * `ruleExplore.bookList = ".[?(@.bookName)]||.[?(@.title)]"`，`bodyJs` 交出 4061 字真书单
 * `[{"bookId":"8877673","bookName":"全民：亡灵召唤师…"}, …]`。
 * 同一份 body、同一套实现，只差一个 `$`：
 *   · `.[?(@.bookName)]`  → **0 条**（旧）
 *   · `$.[?(@.bookName)]` → 2 条
 *   · `[*]`               → **0 条**（旧）
 *   · `$[*]`              → 3 条
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalyzeRule, createJsEvaluator, createVariableStore } from '../index';

const ARR = JSON.stringify([
  { bookId: '1', bookName: '甲' },
  { bookId: '2', bookName: '乙' },
  { bookId: '3', title: '丙' },
]);

function make(body: string, baseUrl = 'https://x.test/'): AnalyzeRule {
  const variables = createVariableStore();
  const env = { baseUrl, variables, jsEval: createJsEvaluator({ variables }) };
  return new AnalyzeRule(env).setContent(body, baseUrl);
}

test('省略 `$` 的过滤段在数组根上命中', () => {
  assert.equal(make(ARR).syncGetElements('.[?(@.bookName)]').length, 2);
  assert.equal(make(ARR).syncGetElements('.[?(@.bookName)]||.[?(@.title)]').length, 2);
});

test('省略 `$` 的 `[*]` 等价 `$[*]`（不是 jsonpath-plus 的递归下降）', () => {
  assert.equal(make(ARR).syncGetElements('[*]').length, 3);
  assert.equal(make(ARR).syncGetElements('$[*]').length, 3);
});

test('带 `$` 的老写法不变', () => {
  const r = make(ARR);
  assert.equal(r.syncGetElements('$.[?(@.bookName)]').length, 2);
  assert.equal(r.syncGetElements('$[?(@.bookName)]').length, 2);
});

test('无前缀的字段路径按 `$.x` 补齐', () => {
  assert.equal(make('{"data":{"n":7}}').syncGetString('data.n'), '7');
});
