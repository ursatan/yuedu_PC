/**
 * `#552` 离线巡检的汇总/差分回归锁。
 *
 * 三条最容易被写坏的判据钉在这里：
 *  ① **首轮不播报**（全量实测 error 级 36 个源是存量，弹它 = 念一遍存量）；
 *  ② **只播 error 级**（warn/info 进快照但不弹，否则每 6h 刷屏）；
 *  ③ **「码变多」也算新增**（同一个源又坏了一种，往往是用户刚改出来的）。
 * 每条都配反例 —— 只测正例会退化成「每轮全报」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnapshot,
  diffSnapshots,
  patrolToastText,
  STRUCT_CODE_PREFIX,
  type PatrolRow,
} from '../diag/patrol';

const rows: PatrolRow[] = [
  {
    id: 'a',
    name: '书山聚合',
    kind: 'legado',
    lint: [
      { ruleId: 'L002', severity: 'error', field: 'ruleBookInfo.intro', message: 'JS 片段含 3 个不可见字符' },
      { ruleId: 'L007', severity: 'warn', field: 'exploreUrl', message: 'POST body 非 String' },
    ],
  },
  { id: 'b', name: '光遇聚合', kind: 'legado', struct: [{ level: 'error', path: 'bookSourceUrl', message: '源地址为空' }] },
  { id: 'c', name: '干净的源', kind: 'legado', lint: [{ ruleId: 'L009', severity: 'info', field: 'searchUrl', message: '严格模式必填' }] },
];

test('汇总：只把 error 级收进 issues，warn 进 warned，info 只记条数', () => {
  const s = buildSnapshot(rows, 1_000, 12);
  assert.equal(s.sources, 3);
  assert.deepEqual(s.counts, { error: 2, warn: 1, info: 1 });
  assert.deepEqual(
    s.issues.map((i) => i.id),
    ['a', 'b'],
    '只有 error 级进播报列表（c 只有 info，不该进）',
  );
  assert.equal(s.issues[0]?.codes[0], 'L002');
  assert.equal(s.issues[1]?.codes[0], `${STRUCT_CODE_PREFIX}bookSourceUrl`);
  assert.deepEqual(
    s.warned.map((w) => w.id),
    ['a'],
    'warn 进 warned（详情可见）但不进 issues（不播报）',
  );
});

test('汇总：同一源多条 error ⇒ codes 去重升序、count 记条数', () => {
  const s = buildSnapshot(
    [
      {
        id: 'x',
        name: 'X',
        kind: 'legado',
        lint: [
          { ruleId: 'L008', severity: 'error', field: 'jsLib', message: '语法错 A' },
          { ruleId: 'L008', severity: 'error', field: 'ruleToc.chapterList', message: '语法错 B' },
          { ruleId: 'L001', severity: 'error', field: 'ruleSearch.bookList', message: '解构箭头缺括号' },
        ],
      },
    ],
    1_000,
    3,
  );
  assert.deepEqual(s.issues[0]?.codes, ['L001', 'L008'], '去重 + 升序');
  assert.equal(s.issues[0]?.count, 3);
  assert.match(s.issues[0]?.sample ?? '', /语法错 A/, 'sample 取第一条，播报时给具体例子');
});

test('★ 首轮（prev=null）只建基线：added 恒为空、baseline=true、不弹', () => {
  const next = buildSnapshot(rows, 2_000, 9);
  const d = diffSnapshots(null, next);
  assert.equal(d.baseline, true);
  assert.deepEqual(d.added, [], '首轮那 36 个是存量，不能当新发现播出去');
  assert.deepEqual(d.fixed, []);
  assert.deepEqual(d.persisted, ['a', 'b']);
  assert.equal(patrolToastText(d), null, '首轮不弹 toast');
});

test('新增：新出现的源 ⇒ added；存量的源 ⇒ persisted（不重复播）', () => {
  const prev = buildSnapshot([rows[1]!], 1_000, 5); // 上轮只有 b 有问题
  const next = buildSnapshot(rows, 2_000, 7); // 这轮 a、b 都有
  const d = diffSnapshots(prev, next);
  assert.deepEqual(
    d.added.map((i) => i.id),
    ['a'],
    '只有新出现的 a 该被播报',
  );
  assert.deepEqual(d.persisted, ['b'], 'b 是存量，不该每 6h 重播一次');
  assert.deepEqual(d.fixed, []);
  assert.match(patrolToastText(d)?.text ?? '', /1 个源规则异常/);
});

test('★ 码变多也算新增（同一个源又坏了一种 ⇒ 往往是刚改出来的）', () => {
  const prev = buildSnapshot(
    [{ id: 'a', name: '书山', kind: 'legado', lint: [{ ruleId: 'L002', severity: 'error', field: 'f', message: '不可见字符' }] }],
    1_000,
    4,
  );
  const next = buildSnapshot(
    [
      {
        id: 'a',
        name: '书山',
        kind: 'legado',
        lint: [
          { ruleId: 'L002', severity: 'error', field: 'f', message: '不可见字符' },
          { ruleId: 'L008', severity: 'error', field: 'g', message: '语法错' },
        ],
      },
    ],
    2_000,
    4,
  );
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.added.map((i) => i.id), ['a'], '新增了一种错 ⇒ 要报');
  assert.deepEqual(d.persisted, []);
  assert.deepEqual(d.fixed, []);
});

test('反例：码一模一样 ⇒ persisted，不是 added（否则每轮全报）', () => {
  const a = buildSnapshot(rows, 1_000, 1);
  const b = buildSnapshot(rows, 9_000, 1);
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.fixed, []);
  assert.deepEqual(d.persisted, ['a', 'b']);
  assert.equal(patrolToastText(d), null, '没有任何变化时不该弹');
});

test('恢复：error 全没了 ⇒ fixed，且给正反馈（ok 口吻）', () => {
  const prev = buildSnapshot(rows, 1_000, 1);
  const next = buildSnapshot([rows[2]!], 2_000, 1); // 只剩没问题的 c
  const d = diffSnapshots(prev, next);
  assert.deepEqual(d.fixed, ['a', 'b']);
  const t = patrolToastText(d);
  assert.equal(t?.level, 'ok');
  assert.match(t?.text ?? '', /规则异常已修复/);
});

test('文案：多条时折叠（超过 maxNames 用「等 N 个」，不把 36 个源名塞进一条 toast）', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    name: `源${i}`,
    kind: 'legado',
    lint: [{ ruleId: 'L001', severity: 'error' as const, field: 'f', message: '缺括号' }],
  }));
  const d = diffSnapshots(null, buildSnapshot([], 1, 1));
  // 手工造一个「30 个新增」的 delta（等价于上一轮全空、这一轮全坏，但 **不是首轮**）
  const delta = { ...d, baseline: false, added: buildSnapshot(many, 2, 1).issues };
  const t = patrolToastText(delta, { maxNames: 3 });
  assert.match(t?.text ?? '', /^源医生：30 个源规则异常 —— /);
  assert.match(t?.text ?? '', / 等 30 个$/, '超出 maxNames 要折叠，不能把 30 个源名塞进一条 toast');
  assert.equal((t?.text.match(/、/g) ?? []).length, 2, '只列 3 个名字（2 个顿号）');
  assert.equal(t?.level, 'warn');
  // **错得多的先展示**（不是按 id：id 是规范化 URL，对人无意义 ⇒ 按它取前 3 个等于随机抽样）
  const mixed = [
    { id: 'z', name: '错1条', kind: 'legado', lint: [{ ruleId: 'L001', severity: 'error' as const, field: 'f', message: '缺括号' }] },
    {
      id: 'y',
      name: '错3条',
      kind: 'legado',
      lint: [
        { ruleId: 'L008', severity: 'error' as const, field: 'a', message: '语法错1' },
        { ruleId: 'L008', severity: 'error' as const, field: 'b', message: '语法错2' },
        { ruleId: 'L002', severity: 'error' as const, field: 'c', message: '不可见字符' },
      ],
    },
  ];
  const t2 = patrolToastText({ ...d, baseline: false, added: buildSnapshot(mixed, 2, 1).issues });
  assert.match(t2?.text ?? '', /错3条、错1条/, 'count 大的排前面');
  // 单个时给具体例子（只报码用户不知道发生了什么）
  const one = patrolToastText({ ...d, baseline: false, added: buildSnapshot([many[0]!], 2, 1).issues });
  assert.match(one?.text ?? '', /L001/);
  assert.match(one?.text ?? '', /缺括号/);
});
