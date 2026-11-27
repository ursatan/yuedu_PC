/**
 * `#262` 高亮规则：契约纯函数（校验 / 导入解析 / 合并）+ 渲染期匹配器。
 *
 * ★ 为什么值得单测：导入合并的 uuid 判定与匹配器的区间语义写错都会「静默画错地方」；
 *   上游语义逐条对照 `HighlightRule.kt` / `HighlightRuleMatcher.kt` / `HighlightRuleDao.kt`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emptyHighlightRule,
  highlightRuleAppliesToBook,
  highlightRuleContentEquals,
  highlightRuleIsValid,
  mergeImportedHighlightRules,
  normalizeHighlightRuleForRestore,
  parseHighlightRuleImport,
  type HighlightRule,
} from '../contract/user-data.js';
import { matchHighlightRules } from '../highlight-rule-matcher.js';

/* ---------------- isValid / normalize ---------------- */

test('⑴ isValid：pattern 空不可用；字面量恒可用；正则要能编译', () => {
  assert.equal(highlightRuleIsValid({ pattern: '', isRegex: false }), false);
  assert.equal(highlightRuleIsValid({ pattern: '第N话', isRegex: false }), true);
  assert.equal(highlightRuleIsValid({ pattern: '第\\d+话', isRegex: true }), true);
  assert.equal(highlightRuleIsValid({ pattern: '第[\\d+话', isRegex: true }), false);
});

test('⑵ normalize：uuid 非法重生成；timeout<=0 回默认；style 空补空串', () => {
  const r = normalizeHighlightRuleForRestore({
    ...emptyHighlightRule(),
    uuid: 'not-a-uuid',
    timeoutMillisecond: 0,
    style: '  ',
  });
  assert.match(r.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(r.timeoutMillisecond, 3000);
  assert.equal(r.style, '');
});

/* ---------------- scope 语义（上游 DAO findEnabledByBook） ---------------- */

test('⑶ scope：空=全局；scope 字符串里包含书名或源 URL 才生效（instr(scope, name) 语义）', () => {
  assert.equal(highlightRuleAppliesToBook({ isEnabled: true, scope: null }, '斗破苍穹', 'https://x.com'), true);
  // ★ 上游 instr(scope, :name)：在 scope 里找书名 ⇒ scope 是「书名/源URL 的集合串」，
  //   不是「前缀」—— scope 短于书名时不可能命中
  assert.equal(highlightRuleAppliesToBook({ isEnabled: true, scope: '斗破苍穹,另一本' }, '斗破苍穹', 'https://x.com'), true);
  assert.equal(highlightRuleAppliesToBook({ isEnabled: true, scope: 'https://x.com,另一个源' }, '斗破苍穹', 'https://x.com'), true);
  assert.equal(highlightRuleAppliesToBook({ isEnabled: true, scope: '别的书' }, '斗破苍穹', 'https://x.com'), false);
  assert.equal(highlightRuleAppliesToBook({ isEnabled: false, scope: null }, '斗破苍穹', 'https://x.com'), false);
});

/* ---------------- 导入解析 ---------------- */

const mkRule = (over: Partial<HighlightRule>): HighlightRule => ({ ...emptyHighlightRule(1), ...over });

test('⑷ 解析合法文件：type 校验 + 字段补默认 + 三态判定', () => {
  const local = [mkRule({ uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: '旧文案', name: 'n1' })];
  const file = {
    type: 'highlightRule',
    rules: [
      { uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'n1', pattern: '旧文案' }, // existing
      { uuid: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'n2', pattern: '新规则' }, // new
      { uuid: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'n3', pattern: '要更新' }, // update（内容不同）
    ],
  };
  const local2 = [mkRule({ uuid: 'CCCCCCCC-BBBB-4ccc-8ddd-eeeeeeeeeeee', pattern: '别的', name: 'n3' })];
  const r = parseHighlightRuleImport(JSON.stringify(file), [...local, ...local2]);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.status), ['existing', 'new', 'update']);
  // 补默认：isRegex=false / applyToBody=true / timeout=3000
  const it1 = r.items[1]!;
  assert.equal(it1.rule.isRegex, false);
  assert.equal(it1.rule.applyToBody, true);
  assert.equal(it1.rule.applyToTitle, false);
  assert.equal(it1.rule.timeoutMillisecond, 3000);
});

test('⑸ 严格校验：坏 type / 缺 rules / uuid 非法 / 批内重复 / 正则编译不过 都要挡', () => {
  assert.equal(parseHighlightRuleImport('{"type":"other","rules":[]}').ok, false);
  assert.equal(parseHighlightRuleImport('{"type":"highlightRule"}').ok, false);
  const bad = (rules: unknown[]) =>
    parseHighlightRuleImport(JSON.stringify({ type: 'highlightRule', rules })).ok;
  assert.equal(bad([{ uuid: 'x', pattern: 'p' }]), false); // uuid 非法
  assert.equal(
    bad([
      { uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: 'p' },
      { uuid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', pattern: 'q' },
    ]),
    false,
  ); // 大小写不同也算重复（上游按 lowercase 判）
  assert.equal(bad([{ uuid: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: '[坏了', isRegex: true }]), false);
  assert.equal(bad([{ uuid: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: 'p', isRegex: 'yes' }]), false);
});

/* ---------------- 合并 ---------------- */

test('⑹ 合并：uuid 对齐沿用本地 id；新增补入；order 全量重编', () => {
  const a = mkRule({ id: 11, uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: 'p1', order: 5 });
  const b = mkRule({ id: 22, uuid: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: 'p2', order: 6 });
  const incA = mkRule({ id: 999, uuid: 'AAAAAAAA-BBBB-4ccc-8ddd-eeeeeeeeeeee', pattern: 'p1-改' });
  const incNew = mkRule({ uuid: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: 'p3' });
  const merged = mergeImportedHighlightRules([a, b], [incA, incNew]);
  assert.equal(merged.length, 3);
  const m0 = merged[0]!, m1 = merged[1]!, m2 = merged[2]!;
  assert.equal(m0.id, 11, '冲突项沿用本地 id');
  assert.equal(m0.pattern, 'p1-改', '内容以导入为准');
  assert.equal(m1.pattern, 'p2');
  assert.equal(m2.pattern, 'p3');
  assert.deepEqual(merged.map((r) => r.order), [0, 1, 2], 'order 全量重编');
});

test('⑺ 内容相等判据：忽略 id/order，uuid 忽略大小写', () => {
  const x = mkRule({ id: 1, order: 7, uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', pattern: 'p' });
  const y = mkRule({ id: 999, order: 0, uuid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', pattern: 'p' });
  assert.equal(highlightRuleContentEquals(x, y), true);
});

/* ---------------- 匹配器 ---------------- */

const R = (over: Partial<Parameters<typeof matchHighlightRules>[1][number]>): Parameters<typeof matchHighlightRules>[1][number] => ({
  id: 1,
  pattern: '',
  isRegex: false,
  timeoutMillisecond: 3000,
  applyToTitle: false,
  applyToBody: true,
  ...over,
});

test('⑻ 字面量：多命中逐个出区间；applyToBody 不碰标题段', () => {
  const text = '标题段｜正文甲某某甲';
  const titleEnd = 4;
  const bodyOnly = [R({ pattern: '甲', applyToTitle: false, applyToBody: true })];
  const r = matchHighlightRules(text, bodyOnly, titleEnd);
  assert.equal(r.completed, true);
  // 「甲」在正文段的第 6、9 位（0-based）
  assert.deepEqual(r.matches.map((m) => [m.start, m.end]), [[6, 7], [9, 10]]);
  const titleWord = [R({ pattern: '标题', applyToTitle: false, applyToBody: true })];
  assert.equal(matchHighlightRules(text, titleWord, titleEnd).matches.length, 0, '不碰标题段');
  const titleToo = [R({ pattern: '标题', applyToTitle: true, applyToBody: true })];
  assert.equal(matchHighlightRules(text, titleToo, titleEnd).matches.length, 1, '两段都开=全文');
});

test('⑼ 正则：全局多命中；编译失败跳过；超时未完成；maxMatches 截断', () => {
  const r1 = matchHighlightRules('第1话 第12话 第3话', [R({ pattern: '第\\d+话', isRegex: true })], 0);
  assert.deepEqual(r1.matches.map((m) => m.ruleId), [1, 1, 1]);
  const r2 = matchHighlightRules('abc', [R({ pattern: '[坏', isRegex: true })], 0);
  assert.equal(r2.completed, true, '编译失败=跳过（上游 catch return true）');
  assert.equal(r2.matches.length, 0);
  let tick = 0;
  const r3 = matchHighlightRules(
    'aaaa bbbb cccc dddd',
    [R({ pattern: '\\w+', isRegex: true, timeoutMillisecond: 1 })],
    0,
    { now: () => (tick += 1e4) }, // 时钟每次读都跳 10 秒 ⇒ 第一次 exec 后必然超时
  );
  assert.equal(r3.completed, false, '超时=未完成');
  const r4 = matchHighlightRules('x x x x x', [R({ pattern: 'x', applyToBody: true })], 0, { maxMatches: 3 });
  assert.equal(r4.matches.length, 3);
  assert.equal(r4.completed, false);
});

test('⑽ 空匹配防死循环（`a*` 类零宽模式）', () => {
  const r = matchHighlightRules('bbb', [R({ pattern: 'b*', isRegex: true })], 0, { maxMatches: 50 });
  assert.equal(r.completed, true);
  assert.ok(r.matches.length > 0);
});
