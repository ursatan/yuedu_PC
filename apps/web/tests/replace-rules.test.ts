/**
 * 用户全局净化（替换）规则内核 —— 回归锁（`#144`）。
 *
 * 每条都对应一处**照抄上游时最容易错**的地方：
 *   ② 正则必须**全替换**（JS 不带 `g` 只换第一处，最经典的照抄错误）；
 *   ③ 非正则是**字面**替换（`$1` 不能被当分组引用）；
 *   ④ 作用域口径（空 scope = 匹配所有；excludeScope 优先）；
 *   ⑤ `@js:` 替换**求值**（`#257`；此前是「跳过并留痕」）；组引用走 Java 语义（`$0` = 整个匹配）；
 *   ⑥ 「本书设置 vs 全局默认」的三分支（照抄 `Book.getUseReplaceRule()`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyReplaceRules, effectiveRules, useReplaceRuleFor,
  // `#261`
  manualReplaceSets, manualCandidates,
} from '../src/utils/replace-rules';
import { emptyReplaceRule, type ReplaceRule } from '@yuedu/core/contract';

function rule(p: Partial<ReplaceRule> & { id: number }): ReplaceRule {
  return {
    id: p.id,
    name: p.name ?? `r${p.id}`,
    group: p.group ?? null,
    pattern: p.pattern ?? '',
    replacement: p.replacement ?? '',
    scope: p.scope ?? null,
    scopeTitle: p.scopeTitle ?? false,
    scopeSource: p.scopeSource ?? false,
    scopeContent: p.scopeContent ?? true,
    excludeScope: p.excludeScope ?? null,
    isEnabled: p.isEnabled ?? true,
    isRegex: p.isRegex ?? true,
    timeoutMillisecond: p.timeoutMillisecond ?? 3000,
    order: p.order ?? 0,
  };
}

const T = { name: '斗破苍穹', origin: 'src-a' };

/**
 * ① **顺序由 `effectiveRules` 保证**（上游是 SQL 的 `order by sortOrder`），
 * `applyReplaceRules` 只按**传入顺序**跑 —— 所以这里必须先过 `effectiveRules`。
 */
test('① 按 order 升序依次应用，并返回真正生效的规则 id', () => {
  const rs = [
    rule({ id: 1, pattern: 'A', replacement: 'B', order: 2 }),
    rule({ id: 2, pattern: 'B', replacement: 'C', order: 1 }),
  ];
  const out = applyReplaceRules('A', effectiveRules(rs, 'content', T));
  assert.equal(out.text, 'B', 'order 小的先跑（B→C 对 "A" 无作用），再跑 A→B');
  assert.deepEqual(out.used, [1]);
});

test('② ★ 正则必须替换**全部**匹配（JS 不带 g 只换第一处）', () => {
  const out = applyReplaceRules('aXa aXa', [rule({ id: 1, pattern: 'a', replacement: '-' })]);
  assert.equal(out.text, '-X- -X-');
});

test('③ 非正则 = 字面全替换，`$1` 不应被当分组引用', () => {
  const out = applyReplaceRules('a.b a.b', [
    rule({ id: 1, pattern: '.', replacement: '$1', isRegex: false }),
  ]);
  assert.equal(out.text, 'a$1b a$1b');
});

test('③-b 正则下 `$1` 是分组引用（与字面模式行为不同）', () => {
  const out = applyReplaceRules('ab cd', [
    rule({ id: 1, pattern: '(\\w)(\\w)', replacement: '$2$1' }),
  ]);
  assert.equal(out.text, 'ba dc');
});

/**
 * ④ 作用域口径（照抄 `ReplaceRuleDao` 的 SQL）。
 *
 * ⚠️ **子串方向别搞反**：SQL 是 `scope LIKE '%' || :name || '%'` ⇒ **`scope` 里必须包含完整的
 * 书名（或完整来源）**，在 scope 里填书名的**一部分**（如「斗破」配《斗破苍穹》）**不会命中**。
 * 这是上游行为（不是本仓的简化），别顺手改成「互相包含」—— 那会让用户的「斗破」规则突然生效在他没指定的书上。
 */
test('④ 作用域：空 scope 匹配所有；命中书名或来源任一即可；excludeScope 优先', () => {
  const rs = [
    rule({ id: 1, scope: null }),                          // 全部
    rule({ id: 2, scope: '斗破苍穹' }),                     // 命中书名
    rule({ id: 2.1 as unknown as number, scope: '斗破' }),  // ★ 书名片段：不命中（见上面注释）
    rule({ id: 3, scope: 'src-a' }),                        // 命中来源
    rule({ id: 4, scope: '别的书' }),                        // 不命中
    rule({ id: 5, scope: null, excludeScope: '斗破苍穹' }),  // 被排除
    rule({ id: 6, isEnabled: false }),                      // 未启用
    rule({ id: 7, scopeContent: false, scopeTitle: true }),  // 只作用于标题
  ];
  assert.deepEqual(effectiveRules(rs, 'content', T).map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(effectiveRules(rs, 'title', T).map((r) => r.id), [7]);
  assert.deepEqual(effectiveRules(rs, 'source', T).map((r) => r.id), [], '本仓未做 scopeSource 的手动校正');
});

/**
 * ④-b `pattern` 为空要跳过；`isEnabled` **由 `effectiveRules` 负责**
 * （上游是 DAO 的 WHERE 做的，`ContentProcessor` 里不再判 —— 别在两处都判，会漂）。
 */
test('④-b pattern 为空的规则不参与；isEnabled 由 effectiveRules 过滤', () => {
  const rs = [rule({ id: 1, pattern: '', replacement: 'X' }), rule({ id: 2, pattern: 'a', replacement: 'X' })];
  assert.equal(applyReplaceRules('abc', effectiveRules(rs, 'content', T)).text, 'Xbc');
  assert.equal(applyReplaceRules('abc', [rule({ id: 1, pattern: '', replacement: 'X' })]).text, 'abc');
  assert.deepEqual(effectiveRules([rule({ id: 3, pattern: 'a', isEnabled: false })], 'content', T), []);
});

test('⑤ ★ `@js:` 替换：求值（`#257` 起实现）+ 计入 used；脚本报错时才跳过并留痕', () => {
  // ① 正常求值：`@js:result+"!"` ⇒ `abc!`
  const ok = applyReplaceRules('正文abc', [
    rule({ id: 99, name: 'js好', pattern: 'abc', replacement: '@js:result+"!"' }),
  ]);
  assert.equal(ok.text, '正文abc!');
  assert.deepEqual(ok.used, [99], '真正改动了正文 ⇒ 必须计入 used（「起效替换」列表读它）');

  // ② 脚本报错 ⇒ 该规则本次不生效 + 留痕（**不能不响**）
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => warns.push(String(m));
  try {
    const bad = applyReplaceRules('正文abc', [
      rule({ id: 98, name: 'js坏', pattern: 'abc', replacement: '@js:zzz.nope()' }),
    ]);
    assert.equal(bad.text, '正文abc', '报错 ⇒ 正文保持原样（照抄上游 catch 后的行为）');
    assert.deepEqual(bad.used, []);
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => w.includes('@js:') && w.includes('js坏')), `必须留痕，实际：${JSON.stringify(warns)}`);
});

test('⑤-b 正则编译失败：跳过 + 留痕，不把整个正文弄丢', () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => warns.push(String(m));
  try {
    const out = applyReplaceRules('正文', [rule({ id: 7, pattern: '([a-' })]);
    assert.equal(out.text, '正文');
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => w.includes('无法编译')), `必须留痕，实际：${JSON.stringify(warns)}`);
});

test('⑥ 启用替换时逐行 trim（上游副作用；关闭时不 trim）', () => {
  const out = applyReplaceRules('  a  \n  b  ', [], { trimLines: true });
  assert.equal(out.text, 'a\nb');
  assert.equal(applyReplaceRules('  a  \n  b  ', []).text, '  a  \n  b  ', '不传就不 trim');
});

test('⑦ ★ 本书开关 vs 全局默认（照抄 Book.getUseReplaceRule）', () => {
  assert.equal(useReplaceRuleFor({ useReplaceRule: false }, true), false, '本书显式关闭 ⇒ 关');
  assert.equal(useReplaceRuleFor({ useReplaceRule: true }, false), true, '本书显式开启 ⇒ 开（盖过全局）');
  assert.equal(useReplaceRuleFor({ useReplaceRule: null }, true), true, 'null ⇒ 走全局');
  assert.equal(useReplaceRuleFor({ useReplaceRule: null }, false), false);
  assert.equal(useReplaceRuleFor({ isImage: true }, true), false, '图片书源默认关闭净化');
});

/* --------- `#261` 手动规则集（上游 ReadBook.manualReplaceRules） --------- */
const mkRule = (id: number, patch: Partial<ReplaceRule>): ReplaceRule => ({
  ...emptyReplaceRule(id),
  id, name: 'R' + id, pattern: 'p' + id, replacement: '',
  ...patch,
});

test('#261 手动集：只按 id 取 ⇒ 无视 isEnabled / scope（上游现状，不是本仓发明）', () => {
  const all = [
    mkRule(1, { isEnabled: false, scopeContent: true }),          // 停用 ⇒ 全局会被跳过，手动集照样跑
    mkRule(2, { scope: '别的书名', scopeContent: true }),          // scope 不匹配 ⇒ 全局会跳过，手动集照样跑
    mkRule(3, { scopeTitle: true, scopeContent: false }),
    mkRule(4, { scopeContent: true }),
  ];
  const s = manualReplaceSets(all, [1, 2, 3, 4]);
  assert.equal(s.enabled, true);
  assert.deepEqual(s.content.map((r) => r.id), [1, 2, 4], '停用 + scope 不匹配的规则仍然进了正文集');
  assert.deepEqual(s.title.map((r) => r.id), [3], '按 scopeTitle 分流（唯一还生效的开关）');
  // 防空转：同一批在「全局规则」口径下会少两条
  const globalContent = effectiveRules(all, 'content', { name: '当前书', origin: 'origin' });
  assert.ok(globalContent.length < s.content.length, '★ 手动集与全局规则的差异不是巧合');
});

test('#261 手动集为空 ⇒ enabled=false（书的开关/全局默认此时照常生效）', () => {
  assert.equal(manualReplaceSets([mkRule(1, { scopeContent: true })], []).enabled, false);
  // id 全都不存在 ⇒ 也是空集
  assert.equal(manualReplaceSets([mkRule(1, { scopeContent: true })], [999]).enabled, false);
});

test('#261 候选列表：排除「纯书源规则」，但**不**排除已停用的', () => {
  const all = [
    mkRule(1, { scopeContent: true }),
    mkRule(2, { isEnabled: false, scopeContent: true }),
    // ⚠️ emptyReplaceRule 默认 scopeContent: true ⇒ 造「纯源规则」必须显式关掉
    mkRule(3, { scopeSource: true, scopeContent: false, scopeTitle: false }), // 纯源规则 ⇒ 排除
    mkRule(4, { scopeSource: true, scopeContent: true }),          // 同时作用正文 ⇒ 保留
  ];
  assert.deepEqual(manualCandidates(all).map((r) => r.id), [1, 2, 4]);
});
