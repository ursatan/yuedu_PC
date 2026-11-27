/**
 * `#266` 净化规则导入：解析与判重（`contract/user-data.ts` 的 `parseReplaceRuleImport`
 * / `replaceRuleDedupeKey`）。
 *
 * ★ 为什么这些用例值得单测：导入是「把外面不可信的 JSON 变成库内规则」的唯一入口，
 *   规范化写错（布尔没宽容、id 被信任、pattern 空值漏判）都会**静默**改变库内容 ——
 *   `#259` 顺带发现的「51 组同名同长度重复」正是旧粘贴路径无判重导致的。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dedupeReplaceRules,
  emptyReplaceRule,
  parseReplaceRuleImport,
  replaceRuleDedupeKey,
  type ReplaceRule,
} from '../contract/user-data.js';

test('⑴ 数组导入：逐条规范化，id/order 丢弃（不信任输入）', () => {
  const r = parseReplaceRuleImport(
    JSON.stringify([
      { id: 999, name: '去广告', pattern: '广告', replacement: '', order: 42, scopeContent: false },
      { name: '正则', pattern: '\\d+', replacement: 'N', isRegex: true, timeoutMillisecond: 1234 },
    ]),
  );
  assert.equal(r.parsedTotal, 2);
  assert.equal(r.errors.length, 0);
  assert.equal(r.rules.length, 2);
  // ★ 输入里的 id=999 / order=42 必须被丢弃：id 撞库会整条覆盖无关规则，order 是库内全量槽位
  for (const x of r.rules) {
    assert.equal(x.id, 0, 'id 是占位 —— 真实 id 由提交方入库那一刻分配');
    assert.equal(x.order, emptyReplaceRule().order, 'order 回默认值，入库时重新排');
  }
  assert.equal(r.rules[0]!.name, '去广告');
  assert.equal(r.rules[0]!.pattern, '广告');
  assert.equal(r.rules[0]!.scopeContent, false, '显式 false 必须保留');
  assert.equal(r.rules[0]!.isEnabled, true, '未给的布尔字段取默认（isEnabled=true）');
  assert.equal(r.rules[1]!.timeoutMillisecond, 1234, '合法数字照收');
});

test('⑵ 布尔宽容化：1/0、"true"/"false" 都认；非法值回落默认', () => {
  const r = parseReplaceRuleImport(
    JSON.stringify([
      { pattern: 'a', isRegex: 0, scopeTitle: 'true' },
      { pattern: 'b', isEnabled: 'yes', isRegex: 'false' },
    ]),
  );
  assert.equal(r.errors.length, 0);
  assert.equal(r.rules[0]!.isRegex, false, '数字 0 ⇒ false');
  assert.equal(r.rules[0]!.scopeTitle, true, '字符串 "true" ⇒ true');
  assert.equal(r.rules[1]!.isEnabled, true, '"yes" 不认识 ⇒ 回默认 true（不猜成 false）');
  assert.equal(r.rules[1]!.isRegex, false, '"false" ⇒ false');
});

test('⑶ 错误分类：非对象、缺 pattern、整体不是 JSON —— 逐条报错且不混入 rules', () => {
  // 整体不是 JSON
  const bad = parseReplaceRuleImport('这不是 JSON');
  assert.equal(bad.parsedTotal, 0);
  assert.equal(bad.rules.length, 0);
  assert.ok(bad.errors[0]!.reason.includes('不是合法的规则 JSON'));

  // 混合：好规则 + 非对象 + 缺 pattern
  const mixed = parseReplaceRuleImport(
    JSON.stringify([{ name: '好', pattern: 'x' }, '字符串', { name: '空pattern' }, 42]),
  );
  assert.equal(mixed.parsedTotal, 4, '候选总数含错误条');
  assert.equal(mixed.rules.length, 1);
  assert.equal(mixed.errors.length, 3);
  assert.deepEqual(
    mixed.errors.map((e) => e.index),
    [2, 3, 4],
    '错误条目的序号是 1-based 原始位置（UI 能对回原文）',
  );

  // 空文本
  assert.ok(parseReplaceRuleImport('   ').errors[0]!.reason.includes('内容为空'));
});

test('⑷ 判重 key：name+pattern 定身份；★ replacement 不参与（否则「修正版」永远判成新增）', () => {
  const a: ReplaceRule = { ...emptyReplaceRule(1), name: 'N', pattern: 'x', replacement: 'y' };
  assert.equal(replaceRuleDedupeKey(a), replaceRuleDedupeKey({ ...a }), '同内容 ⇒ 同 key');
  const b2: ReplaceRule = { ...a, replacement: '' };
  assert.equal(
    replaceRuleDedupeKey(a),
    replaceRuleDedupeKey(b2),
    '★ 替换为不同 ⇒ **同一条**（身份 = name+pattern；内容差异交给「覆盖」处理）',
  );
  assert.notEqual(
    replaceRuleDedupeKey(a),
    replaceRuleDedupeKey({ ...a, pattern: ' x' }),
    '★ pattern 带前导空格 ⇒ 不同 key（trim 会把本不相同的两条误判成重复）',
  );
  assert.notEqual(
    replaceRuleDedupeKey(a),
    replaceRuleDedupeKey({ ...a, name: 'N2' }),
    '名字不同 ⇒ 不同规则（同名不同查找也不该互撞）',
  );
  // group/isEnabled 不参与判重 —— 那是「设置」，不是身份
  const v: ReplaceRule = { ...a, group: '别的组', isEnabled: false };
  assert.equal(
    replaceRuleDedupeKey(a),
    replaceRuleDedupeKey(v),
    'group/开关不同不算重复',
  );
});

test('⑸ 单对象导入（非数组）也接受；多余字段（如上游 previewText）被忽略', () => {
  const r = parseReplaceRuleImport(JSON.stringify({ name: '单条', pattern: 'p', previewText: '解释文字', extra: 1 }));
  assert.equal(r.parsedTotal, 1);
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0]!.name, '单条');
  const keys = Object.keys(r.rules[0]!);
  assert.ok(!keys.includes('extra') && !keys.includes('previewText'), '输出是干净的 ReplaceRule（多余字段不带入库）');
});

test('⑹ `dedupeReplaceRules`：同名同查找 ⇒ 保留界面顺序最前的那条（不意外换内容）', () => {
  // 模拟用户库的真实形态：两批同内容、id 不同（`#259` 实测的 51 组重复）
  const orig: ReplaceRule = { ...emptyReplaceRule(100), name: 'A', pattern: 'p', replacement: 'r1', order: 1 };
  const dupLate: ReplaceRule = { ...emptyReplaceRule(900), name: 'A', pattern: 'p', replacement: 'r1', order: 9 };
  const other: ReplaceRule = { ...emptyReplaceRule(800), name: 'B', pattern: 'q', replacement: '', order: 5 };
  const d = dedupeReplaceRules([dupLate, other, orig]);
  assert.equal(d.rules.length, 2);
  // ★ 保序：输出保持**输入的相对顺序**（去重不重排；展示层自会按 order 排）
  assert.deepEqual(d.rules.map((x) => x.id), [800, 100], '保留原件（100），删后导入的重复（900）');
  assert.deepEqual(d.removed.map((x) => x.id), [900]);
  // 内容不同的「同名同查找」同样算重复 —— 保留界面最前那条（replacement 不会悄悄换）
  const fixed: ReplaceRule = { ...emptyReplaceRule(950), name: 'A', pattern: 'p', replacement: 'r2-fixed', order: 10 };
  const d2 = dedupeReplaceRules([orig, fixed]);
  assert.equal(d2.rules.length, 1);
  assert.equal(d2.rules[0]!.replacement, 'r1', '保留的是 order=1 的那条（不是修正版 —— 修正版该走导入的「覆盖」）');
  assert.deepEqual(d2.removed.map((x) => x.id), [950]);
  // 顺序稳定性：去重不改变保留条目的相对顺序
  const d3 = dedupeReplaceRules([other, orig, dupLate]);
  assert.deepEqual(d3.rules.map((x) => x.id), [800, 100]);
});
