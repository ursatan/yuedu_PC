/**
 * 源分组语义的回归锁 —— `src/source-groups.ts`。
 *
 * 为什么值得单测：它现在是**三个页面共用的一份实现**（发现页左栏下拉、源管理页下拉、
 * 规则工坊下拉）。它写错的表现不是报错，而是「下拉里的分组点进去 0 条」
 * 或「未分组把别名当成了真分组」——用户只能看到「筛选坏了」。
 *
 * 其中最值钱的是最后那条**性质断言**：对每个列出的分组，用它去筛池子，
 * 得到的条数必须**等于**下拉里显示的计数。这条能一次钉死整类口径问题。
 *
 * 运行：`pnpm --filter @yuedu/web test`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_GROUP_UNGROUPED, hasSourceGroup, matchSourceGroup, sourceGroupLabel,
  sourceGroupOptions, sourceGroupsOf,
} from '../src/source-groups';

test('sourceGroupsOf：`,`/`，`/`&` 都算分隔符，并丢掉空项', () => {
  assert.deepEqual(sourceGroupsOf({ group: '玄幻,都市' }), ['玄幻', '都市']);
  assert.deepEqual(sourceGroupsOf({ group: '玄幻，都市' }), ['玄幻', '都市']);
  assert.deepEqual(sourceGroupsOf({ group: '玄幻&都市' }), ['玄幻', '都市']);
  assert.deepEqual(sourceGroupsOf({ group: ' 玄幻 ,, 都市 , ' }), ['玄幻', '都市'], '空项必须丢掉（否则下拉里出现点不中的空行）');
  assert.deepEqual(sourceGroupsOf({ group: '' }), []);
  assert.deepEqual(sourceGroupsOf({}), [], '缺字段 = 未分组');
  // 顺序保持书写顺序（调用方要排序自己排）
  assert.deepEqual(sourceGroupsOf({ group: 'B,A' }), ['B', 'A']);
});

test('sourceGroupOptions：计数正确、按「多的在前」排、「未分组」在最后且可选', () => {
  const pool = [
    { group: '玄幻' },
    { group: '玄幻,都市' },
    { group: '都市' },
    { group: '' },        // 未分组
    { group: undefined }, // 未分组
    { group: '冷门' },
  ];
  const opts = sourceGroupOptions(pool, { includeUngrouped: true });
  const byName = new Map(opts.map((o) => [o.name, o]));
  assert.equal(byName.get('玄幻')?.count, 2);
  assert.equal(byName.get('都市')?.count, 2);
  assert.equal(byName.get('冷门')?.count, 1);
  assert.equal(byName.get(SOURCE_GROUP_UNGROUPED)?.count, 2);
  assert.equal(opts[opts.length - 1]?.name, SOURCE_GROUP_UNGROUPED, '「未分组」是兜底桶，必须排最后');

  // 不要求时就没有「未分组」（源管理页不要它 —— 那是书架分组的概念）
  const noUng = sourceGroupOptions(pool);
  assert.ok(!noUng.some((o) => o.name === SOURCE_GROUP_UNGROUPED));
  assert.equal(noUng.length, 3);
});

test('sourceGroupOptions：**计数必须等于「用它筛出来的条数」**（口径防线）', () => {
  const pool = [
    { group: '玄幻,都市' },
    { group: '玄幻' },
    { group: '' },
    { group: 'a & b' },
    { group: 'b' },
  ];
  for (const includeUngrouped of [true, false]) {
    for (const o of sourceGroupOptions(pool, { includeUngrouped })) {
      const matched = pool.filter((s) => matchSourceGroup(s, o.name)).length;
      assert.equal(matched, o.count, `分组「${o.label}」下拉显示 ${o.count} 条，实际筛出 ${matched} 条`);
    }
  }
});

test('matchSourceGroup：`""` = 不筛选；未分组只看「一个组都没有」的源', () => {
  assert.equal(matchSourceGroup({ group: '玄幻' }, ''), true, '空 = 全部分组');
  assert.equal(matchSourceGroup({ group: '' }, ''), true);
  assert.equal(matchSourceGroup({ group: '玄幻,都市' }, '都市'), true, '多组源按成员判定');
  assert.equal(matchSourceGroup({ group: '玄幻' }, '都市'), false);
  assert.equal(matchSourceGroup({ group: '' }, SOURCE_GROUP_UNGROUPED), true);
  assert.equal(matchSourceGroup({}, SOURCE_GROUP_UNGROUPED), true, '缺字段也算未分组');
  assert.equal(matchSourceGroup({ group: '玄幻' }, SOURCE_GROUP_UNGROUPED), false);
  // ★ 关键：哨兵不能与真实分组名混淆（它是不可打印字符，正常源写不出来）
  assert.notEqual(SOURCE_GROUP_UNGROUPED, '');
  assert.notEqual(SOURCE_GROUP_UNGROUPED, '未分组');
});

test('sourceGroupLabel / hasSourceGroup', () => {
  assert.equal(sourceGroupLabel(SOURCE_GROUP_UNGROUPED), '未分组');
  assert.equal(sourceGroupLabel('玄幻'), '玄幻');

  const opts = [{ name: '玄幻' }, { name: SOURCE_GROUP_UNGROUPED }];
  assert.equal(hasSourceGroup(opts, ''), true, '空 = 全部分组，永远算「还有效」');
  assert.equal(hasSourceGroup(opts, '玄幻'), true);
  assert.equal(hasSourceGroup(opts, '不存在'), false, '清掉失效分组要靠它（否则列表空着看不出原因）');
});
