/**
 * `#267` 字典规则导入的纯解析（`utils/dict-transfer.ts`）。
 *
 * 与净化规则导入（`replace-rule-import.test.ts`，core）同一套纪律：
 * 预览与入库同一份解析实现；判重 key = `name`（Legado `DictRule.kt` 的 `@PrimaryKey`）；
 * **sortNumber 一律丢弃**（Legado 导出的 0/1/2 会与内置三条撞号 ⇒ ↑↓ 失效，这是 store
 * 里早就有的语义，拆纯函数时一并带走）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dictDedupeKey, parseDictRulesJson } from '../src/utils/dict-transfer';

test('⑴ 数组导入：逐条规范化，sortNumber 丢弃、enabled 宽容化', () => {
  const p = parseDictRulesJson(JSON.stringify([
    { name: '海词', urlRule: 'http://x/{{key}}', showRule: '$.', enabled: 1, sortNumber: 99 },
    { name: '汉典', urlRule: 'http://y/{{key}}', enabled: 'false' },
  ]));
  assert.equal(p.parsedTotal, 2);
  assert.equal(p.errors.length, 0);
  assert.equal(p.rules[0]!.sortNumber, 0, '★ 导入件的 sortNumber 必须丢弃（撞号会让 ↑↓ 失效）');
  assert.equal(p.rules[0]!.enabled, true, '数字 1 ⇒ true');
  assert.equal(p.rules[1]!.enabled, false, '字符串 "false" ⇒ false');
});

test('⑵ 错误分类：缺 name/urlRule、非对象、整体不是 JSON', () => {
  const mixed = parseDictRulesJson(JSON.stringify([
    { name: '好', urlRule: 'u' },
    { name: '缺url' },
    '字符串',
  ]));
  assert.equal(mixed.parsedTotal, 3);
  assert.equal(mixed.rules.length, 1);
  assert.equal(mixed.errors.length, 2);
  assert.deepEqual(mixed.errors.map((e) => e.index), [2, 3], '错误条目的序号是 1-based 原始位置');

  const bad = parseDictRulesJson('不是 JSON');
  assert.equal(bad.rules.length, 0);
  assert.ok(bad.errors[0]!.reason.includes('JSON 解析失败'));

  const empty = parseDictRulesJson('   ');
  assert.ok(empty.errors[0]!.reason.includes('JSON 解析失败'), '空白串也按 JSON 失败走（有明确原因，不静默）');
});

test('⑶ 判重 key = name（Legado 主键）；单对象也接受', () => {
  assert.equal(dictDedupeKey({ name: 'A' }), dictDedupeKey({ name: 'A' }));
  assert.notEqual(dictDedupeKey({ name: 'A' }), dictDedupeKey({ name: 'B' }));

  const p = parseDictRulesJson(JSON.stringify({ name: '单条', urlRule: 'u' }));
  assert.equal(p.parsedTotal, 1);
  assert.equal(p.rules.length, 1);
  assert.equal(p.rules[0]!.name, '单条');
});
