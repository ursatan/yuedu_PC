import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchableSources, filterCandidates, engineOptionsOf, typeOptionsOf, groupOptionsOf, itemKindLabel,
} from '../src/utils/search-scope';
import { SOURCE_GROUP_UNGROUPED } from '../src/source-groups';

/** 造源（缺省 = 启用、开搜索、text 类型、无分组） */
function src(o: Partial<Parameters<typeof filterCandidates>[0][number]> & { id: string }) {
  return {
    kind: 'legado',
    name: o.id,
    state: { enabled: true, searchEnabled: true },
    ...o,
  } as Parameters<typeof filterCandidates>[0][number];
}

const POOL = [
  src({ id: 'a', kind: 'legado', group: '起点, 正版' }),
  src({ id: 'b', kind: 'legado', group: '起点' }),
  src({ id: 'c', kind: 'legado', sourceType: 'audio' }),
  src({ id: 'd', kind: 'legado' }), // 未分组
  src({ id: 'e', kind: 'maccms', sourceType: 'video', group: '影视' }),
  src({ id: 'f', kind: 'legado', state: { enabled: false, searchEnabled: true } }), // 停用 ⇒ 不进池
  src({ id: 'g', kind: 'legado', state: { enabled: true, searchEnabled: false } }), // 关搜索 ⇒ 不进池
];

test('searchableSources：只留启用且开搜索的源', () => {
  const pool = searchableSources(POOL);
  assert.deepEqual(pool.map((s) => s.id).sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('filterCandidates：三级筛选链 engine → type → group', () => {
  const pool = searchableSources(POOL);
  assert.equal(filterCandidates(pool, { engine: 'all', type: '', group: '' }).length, 5);
  assert.deepEqual(filterCandidates(pool, { engine: 'maccms', type: '', group: '' }).map((s) => s.id), ['e']);
  assert.deepEqual(filterCandidates(pool, { engine: 'legado', type: 'audio', group: '' }).map((s) => s.id), ['c']);
  assert.deepEqual(filterCandidates(pool, { engine: 'legado', type: '', group: '起点' }).map((s) => s.id), ['a', 'b']);
  // 引擎 + 类型 + 分组叠加：类型不匹配的分组自然过滤为空
  assert.equal(filterCandidates(pool, { engine: 'legado', type: 'audio', group: '起点' }).length, 0);
});

test('engineOptionsOf：全部（N）+ 各引擎计数，停用/关搜索不计入', () => {
  const opts = engineOptionsOf(searchableSources(POOL));
  assert.equal(opts[0].value, 'all');
  assert.equal(opts[0].count, 5);
  const legado = opts.find((o) => o.value === 'legado');
  assert.equal(legado?.count, 4);
  const maccms = opts.find((o) => o.value === 'maccms');
  assert.equal(maccms?.count, 1);
});

test('typeOptionsOf：该引擎下真实存在的类型（计数口径 = 引擎过滤后池子）', () => {
  const pool = searchableSources(POOL);
  const legadoTypes = typeOptionsOf(pool, 'legado');
  // legado 池 = a/b/d(text×3) + c(audio×1)
  assert.equal(legadoTypes.find((o) => o.value === '')?.count, 4);
  assert.equal(legadoTypes.find((o) => o.value === 'text')?.count, 3);
  assert.equal(legadoTypes.find((o) => o.value === 'audio')?.count, 1);
  assert.equal(legadoTypes.find((o) => o.value === 'video'), undefined); // legado 下没有 ⇒ 不出现
  const cmsTypes = typeOptionsOf(pool, 'maccms');
  assert.equal(cmsTypes.find((o) => o.value === 'video')?.count, 1);
});

test('groupOptionsOf：分组计数 = 该类型下命中源数（不是组内全部源数）；未分组兜底', () => {
  const pool = searchableSources(POOL);
  const opts = groupOptionsOf(pool, 'legado', '');
  const qidian = opts.find((o) => o.name === '起点');
  assert.equal(qidian?.count, 2);
  const un = opts.find((o) => o.name === SOURCE_GROUP_UNGROUPED);
  assert.equal(un?.label, '未分组');
  assert.equal(un?.count, 2); // c（audio、无分组）+ d，共 2 个
  // 类型过滤后分组跟着变：audio 下没有任何分组 ⇒ 只剩未分组哨兵（c）
  const audioOpts = groupOptionsOf(pool, 'legado', 'audio');
  assert.deepEqual(audioOpts.map((o) => o.name), [SOURCE_GROUP_UNGROUPED]);
  assert.equal(audioOpts[0].count, 1);
});

test('itemKindLabel：UnifiedItem kind → 中文标签（结果卡类型标记）', () => {
  assert.equal(itemKindLabel('book'), '书籍');
  assert.equal(itemKindLabel('video'), '影视');
  assert.equal(itemKindLabel('image'), '漫画');
  assert.equal(itemKindLabel(''), ''); // 空 kind 回落空串
  assert.equal(itemKindLabel('unknown-x'), 'unknown-x'); // 未知回落原文
});

test('B6 searchableSources：dead 未过期不进池、质量分降序（未体检取中性分）', () => {
  const now = Date.now();
  const dead = { state: 'dead' as const, quality: 0, checkedAt: now, respondTime: 0, deadUntil: now + 3600_000 };
  const expired = { state: 'dead' as const, quality: 0, checkedAt: now, respondTime: 0, deadUntil: now - 1 };
  const pool = [
    src({ id: 'low', health: { state: 'broken', quality: 35, checkedAt: now, respondTime: 100 } }),
    src({ id: 'high', health: { state: 'ok', quality: 98, checkedAt: now, respondTime: 100 } }),
    src({ id: 'unknown' }),
    src({ id: 'dead', health: dead }),
    src({ id: 'expired', health: expired }),
  ];
  const out = searchableSources(pool);
  // dead 未过期 ⇒ 连候选都不出现；已过期 ⇒ 回来按中性分（50）与未体检源同分（同分按源名）
  assert.deepEqual(out.map((s) => s.id), ['high', 'expired', 'unknown', 'low']);
});
