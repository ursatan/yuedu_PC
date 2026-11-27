/**
 * `#273` 跨源搜索归并纯函数 —— 回归锁。
 * 语义参考 OmniFlow aggregate-search.ts（dedup 规范化 / 合并补缺 / 排序 / 截断）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregatePerSrc, dedupIdOf, normalizeTitleForDedup, searchTier, type RawSearchItem,
} from '../src/utils/search-merge';

const item = (over: Partial<RawSearchItem> & { title: string }): RawSearchItem => ({
  kind: 'book',
  payload: { url: `/${over.title}` },
  ...over,
});

test('规范化：去空格/括号/标点/集号，保留季词缀', () => {
  assert.equal(normalizeTitleForDedup('《凡人修仙传》（精校版）'), '凡人修仙传精校版');
  assert.equal(normalizeTitleForDedup('凡人修仙传 第1集'), normalizeTitleForDedup('凡人修仙传'));
  assert.equal(normalizeTitleForDedup('某剧 EP12'), normalizeTitleForDedup('某剧'));
  // 「第一季」是区分作品的词缀 ⇒ 保留
  assert.notEqual(normalizeTitleForDedup('某剧 第一季'), normalizeTitleForDedup('某剧'));
  assert.equal(normalizeTitleForDedup('  ABC  '), 'abc');
});

test('dedupId：kind 参与区分（同名书/同名片不合并）', () => {
  assert.notEqual(dedupIdOf('book', '斗破苍穹'), dedupIdOf('video', '斗破苍穹'));
  assert.equal(dedupIdOf('book', '斗破 苍穹'), dedupIdOf('book', '《斗破苍穹》'));
});

test('聚合：同作品跨源合并，sources 追加 + 补封面/简介', () => {
  const now = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '斗破苍穹', cover: 'a.jpg', kind: 'book' })]] },
    // ⚠️ OmniFlow 规范化只删括号**字符**、保留括号内文字（「（精校）」≠ 原标题 ⇒ 不同条目）
    'src-b': { pages: [[item({ title: '斗破苍穹', summary: '简介B', kind: 'book' })]] },
    'src-c': { pages: [[item({ title: '斗破 苍穹', cover: 'c.jpg', kind: 'book' })]] },
  });
  assert.equal(now.length, 1);
  assert.equal(now[0].sources.length, 3);
  assert.equal(now[0].cover, 'a.jpg'); // 首个命中即有封面 ⇒ 不补
  assert.equal(now[0].summary, '简介B');
  // 括号内文字不同 = 版本不同 ⇒ 不合并（OmniFlow 原语义）
  const withVariant = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '斗破苍穹' })]] },
    'src-b': { pages: [[item({ title: '斗破苍穹（精校）' })]] },
  });
  assert.equal(withVariant.length, 2);
  // 单源视图数据不受影响：原样保留
});

test('聚合：不同作品不合并；不同 kind 同名不合并', () => {
  const hits = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '斗破苍穹' }), item({ title: '武动乾坤' })]] },
    'src-b': { pages: [[item({ title: '斗破苍穹', kind: 'video' })]] },
  });
  assert.equal(hits.length, 3);
});

test('排序：被越多源收录越靠前；同 sources 数按 updatedAt 降序', () => {
  const hits = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '孤品' }), item({ title: '热门' })]] },
    'src-b': { pages: [[item({ title: '热门' })]] },
    'src-c': { pages: [[item({ title: '热门' })]] },
  });
  assert.equal(hits[0].title, '热门');
  assert.equal(hits[1].title, '孤品');
});

test('截断：maxHits 生效', () => {
  const pages: RawSearchItem[][] = [Array.from({ length: 30 }, (_, i) => item({ title: `书${i}` }))];
  const hits = aggregatePerSrc({ 'src-a': { pages } }, 10);
  assert.equal(hits.length, 10);
});

test('同源同标题（翻页重叠）在聚合视图去重，但 per-src 原样保留', () => {
  const perSrc = {
    'src-a': { pages: [[item({ title: '书X' })], [item({ title: '书X' })]] },
  };
  const hits = aggregatePerSrc(perSrc);
  assert.equal(hits[0].sources.length, 1, '聚合视图同源同标题只留一个 ref');
  assert.equal(perSrc['src-a'].pages.flat().length, 2, 'per-src 原始数据不动');
});

test('空安全：空对象 / 缺 title 条目跳过', () => {
  assert.deepEqual(aggregatePerSrc({}), []);
  assert.deepEqual(aggregatePerSrc({ 'src-a': { pages: [[{ kind: 'book', payload: {} }]] } }), []);
});

/* ---- `#286` 校验作者：作者并进 dedup key（换源对话框用） ---- */

test('authorAware：同名书不同作者拆成不同卡；默认（关）仍合并', () => {
  const perSrc = {
    'src-a': { pages: [[item({ title: '夜无疆', payload: { author: '甲' } })]] },
    'src-b': { pages: [[item({ title: '夜无疆', payload: { author: '乙' } })]] },
    'src-c': { pages: [[item({ title: '夜无疆', payload: { author: '甲' } })]] },
  };
  // 默认：同名即同作品（旧行为不变）
  assert.equal(aggregatePerSrc(perSrc).length, 1);
  // 开校验：作者参与判据 —— 甲/乙分两张卡，甲的两个源并一张
  const aware = aggregatePerSrc(perSrc, 200, { authorAware: true });
  assert.equal(aware.length, 2);
  const bySources = aware.map((h) => h.sources.length).sort((a, b) => b - a);
  assert.deepEqual(bySources, [2, 1]);
});

test('authorAware：缺作者的条目不与有作者的合并（各成卡）', () => {
  const hits = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '书Q', payload: { author: '甲' } })]] },
    'src-b': { pages: [[item({ title: '书Q', payload: {} })]] },
  }, 200, { authorAware: true });
  assert.equal(hits.length, 2);
  assert.equal(aggregatePerSrc({
    'src-a': { pages: [[item({ title: '书Q', payload: { author: '甲' } })]] },
    'src-b': { pages: [[item({ title: '书Q', payload: {} })]] },
  }).length, 1, '默认关：仍然合并');
});

/* ---- `#618` 多源聚合：去重键 + 四档分级（对齐上游 SearchModel.mergeItems） ---- */

test('#618 同名同作者跨源合并成一张卡，sources 记全（点进去能换源）', () => {
  const hits = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '夜无疆', payload: { author: '辰东', bookUrl: 'https://a/1' } })]] },
    'src-b': { pages: [[item({ title: '夜无疆', payload: { author: '辰东', bookUrl: 'https://b/9' } })]] },
  }, 200, { authorAware: true });
  assert.equal(hits.length, 1, '同书同作者应合并');
  assert.equal(hits[0].sources.length, 2);
  // 合并后仍保留各源的 payload（换源要用各自的 bookUrl）
  assert.deepEqual(
    hits[0].sources.map((s) => (s.payload as Record<string, string>)['bookUrl']).sort(),
    ['https://a/1', 'https://b/9'],
  );
});

test('#618 同名**不同作者**不合并（上游 name+author 判据）', () => {
  const hits = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '同名书', payload: { author: '甲' } })]] },
    'src-b': { pages: [[item({ title: '同名书', payload: { author: '乙' } })]] },
    'src-c': { pages: [[item({ title: '同名书', payload: { author: '甲' } })]] },
  }, 200, { authorAware: true });
  assert.equal(hits.length, 2, '甲/乙两本书不能并成一张卡');
  assert.deepEqual(hits.map((h) => h.author).sort(), ['乙', '甲']);
  assert.deepEqual(hits.map((h) => h.sources.length).sort((a, b) => b - a), [2, 1]);
});

test('#618 分档：完全同名 > 标签命中 > 包含关键词 > 其余（相关性优先于来源数）', () => {
  // 「擦边」条目被 3 个源收录，完全同名的只有 1 个源 —— 上游仍让完全同名排第一
  const hits = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '诡秘之主' })]] },
    'src-b': { pages: [[item({ title: '某书', tags: ['诡秘之主同人'] })]] },
    'src-c': { pages: [[item({ title: '关于诡秘之主的评论' })]] },
    'src-d': { pages: [[item({ title: '无关书' })]] },
    'src-e': { pages: [[item({ title: '无关书' })]] },
    'src-f': { pages: [[item({ title: '无关书' })]] },
  }, 200, { keyword: '诡秘之主' });
  assert.deepEqual(hits.map((h) => h.title), ['诡秘之主', '某书', '关于诡秘之主的评论', '无关书']);
  // 档内仍按来源数降序
  assert.equal(hits[3].sources.length, 3);
});

test('#618 作者命中关键词也算「完全命中」档（上游 author == key）', () => {
  const hits = aggregatePerSrc({
    'src-a': { pages: [[item({ title: '随便什么书名', payload: { author: '辰东' } })]] },
    'src-b': { pages: [[item({ title: '辰东新书速递' })]] },
  }, 200, { keyword: '辰东' });
  assert.equal(hits[0].title, '随便什么书名', '作者全等属第 0 档，应压过书名包含');
});

test('#618 precision（上游「精确搜索」偏好）：丢掉完全不沾关键词的档', () => {
  const perSrc = {
    'src-a': { pages: [[item({ title: '诡秘之主' }), item({ title: '完全无关' })]] },
  };
  assert.equal(aggregatePerSrc(perSrc, 200, { keyword: '诡秘之主' }).length, 2, '默认保留其它档');
  const strict = aggregatePerSrc(perSrc, 200, { keyword: '诡秘之主', precision: true });
  assert.equal(strict.length, 1);
  assert.equal(strict[0].title, '诡秘之主');
});

test('#618 searchTier：四档编号与边界（空关键词一律 0 档）', () => {
  assert.equal(searchTier('诡秘之主', '', [], '诡秘之主'), 0);
  assert.equal(searchTier('别的书名', '诡秘之主', [], '诡秘之主'), 0);
  assert.equal(searchTier('别的书名', '', ['诡秘之主同人'], '诡秘之主'), 1);
  assert.equal(searchTier('关于诡秘之主', '', [], '诡秘之主'), 2);
  assert.equal(searchTier('无关', '', [], '诡秘之主'), 3);
  assert.equal(searchTier('无关', '', [], ''), 0, '空关键词不分档（退化成来源数优先）');
});

test('B6 质量分：同档/同源数时高质量优先；卡内多源按质量分降序', () => {
  const qualities: Record<string, number> = { 'src-hi': 96, 'src-lo': 20, 'src-mid': 70 };
  const perSrc = {
    'src-lo': { pages: [[item({ title: '低分书' })]] },
    'src-hi': { pages: [[item({ title: '高分书' })]] },
    // 同一作品在两个源：卡内顺序应由质量分决定（hi 在前）
    'src-mid': { pages: [[item({ title: '双源书' })]] },
  };
  const q = (id: string) => qualities[id] ?? 50;
  const hits = aggregatePerSrc(perSrc, 200, { sourceQuality: q });
  assert.deepEqual(hits.map((h) => h.title).filter((t) => t !== '双源书'), ['高分书', '低分书']);

  const twoSrc = aggregatePerSrc(
    { 'src-lo': { pages: [[item({ title: '双源书' })]] }, 'src-hi': { pages: [[item({ title: '双源书' })]] } },
    200,
    { sourceQuality: q },
  )[0];
  assert.deepEqual(twoSrc.sources.map((s) => s.sourceId), ['src-hi', 'src-lo']);
});
