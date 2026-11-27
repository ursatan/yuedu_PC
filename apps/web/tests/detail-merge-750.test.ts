/**
 * `#750` 详情合并语义回归锁（七猫「卡片封面 → 详情封面」空白一闪的根因之一）。
 *
 * 背景（上游对照）：`BookInfo.kt:68-148` 是在**同一个 Book 对象上原地赋值** ——
 * 书名/作者/封面**只有非空才覆盖**；`BookInfoViewModel.kt:157-176` 先投递列表 Book
 * （带列表封面），详情规则求值后再原地刷新封面。
 *
 * 本仓旧实现的缺陷：`openDetail` 的「卡片种子」（`{ title, cover }`，没有 `id`）遇到
 * `if (!prev?.id || …) return n` ⇒ 被整体替换 ⇒ 详情规则封面为空时连卡片封面一起丢。
 * 这里锁住「换书才丢弃、同书缺失项回落旧值」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeDetail, normalizeDetail } from '../src/utils/detail-merge';

const CARD_COVER = 'https://cdn.wtzw.com/bookimg/public/images/cover/65bb2c9e6f315_288x384.jpg';
const DETAIL_COVER = 'https://cdn.wtzw.com/bookimg/public/images/cover/65bb2c9e6f315_600x800.jpg?f=webp&q=60';

test('#750 normalizeDetail：subtitle/summary 补成 author/intro（原字段仍保留）', () => {
  const out = normalizeDetail({ title: 'x', subtitle: '作者', summary: '简介' });
  assert.equal(out.author, '作者');
  assert.equal(out.intro, '简介');
  assert.equal(out.subtitle, '作者');
  assert.equal(out.summary, '简介');
});

test('#750 卡片种子（无 id）+ 详情封面为空 ⇒ 保留卡片封面（不再整体替换）', () => {
  const out = mergeDetail(
    { title: '显微镜下的大明', cover: CARD_COVER },
    { title: '显微镜下的大明', cover: undefined, chapters: [{ title: '第1章', payload: {} }] },
  );
  assert.equal(out.cover, CARD_COVER);
  assert.equal(out.title, '显微镜下的大明');
  assert.equal(out.chapters?.length, 1);
});

test('#750 卡片种子 + 详情给出更高清封面 ⇒ 用详情封面（上游「非空才替换」）', () => {
  const out = mergeDetail(
    { title: '显微镜下的大明', cover: CARD_COVER },
    { title: '显微镜下的大明', cover: DETAIL_COVER },
  );
  assert.equal(out.cover, DETAIL_COVER);
});

test('#750 同书（id 相同）+ 新值为空 ⇒ 回落到旧值', () => {
  const out = mergeDetail(
    { id: 'book-1', title: 'A', cover: DETAIL_COVER, tags: ['小说'], chapters: [{ title: 'c', payload: 1 }] },
    { id: 'book-1', title: undefined, cover: '', tags: [], chapters: [] },
  );
  assert.equal(out.cover, DETAIL_COVER);
  assert.equal(out.title, 'A');
  assert.deepEqual(out.tags, ['小说']);
  assert.equal(out.chapters?.length, 1);
});

test('#750 换书（id 不同）⇒ 用新对象，绝不带上本书的封面/目录', () => {
  const out = mergeDetail(
    { id: 'book-1', title: 'A', cover: CARD_COVER, chapters: [{ title: 'c', payload: 1 }] },
    { id: 'book-2', title: 'B', cover: undefined },
  );
  assert.equal(out.cover, undefined);
  assert.equal(out.title, 'B');
  assert.equal(out.chapters, undefined);
});
