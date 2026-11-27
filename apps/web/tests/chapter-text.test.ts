/**
 * `#146` 章节正文坐标系的回归锁（纯函数，不碰 DOM）。
 *
 * 为什么这批断言值得写：坐标算错**不会报错**，只会表现成
 * 「划线划歪一个字」「书签跳错段」「两个高亮重叠后字变重」—— 全是看起来像玄学的问题。
 * 所以这里逐条锁住：段边界、分隔符归属、重叠合并、空区间丢弃、文本纠偏。
 *
 * 浏览器侧（真选区 → 真 DOM → 真落库）由 `scripts/probe-146-highlight.mjs` 验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAPTER_PARA_SEP,
  bodyPosToPara,
  buildChapterText,
  normalizeRanges,
  paraPosToBody,
  localRangesForPara,
  reanchor,
  trimRange,
  segmentText,
} from '../src/utils/chapter-text';

const PARAS = ['第一段', '第二段吗', '第三段'];

test('buildChapterText：分隔符计入偏移，段起点逐个对得上', () => {
  const l = buildChapterText(PARAS);
  assert.equal(CHAPTER_PARA_SEP, '\n');
  assert.equal(l.text, '第一段\n第二段吗\n第三段');
  // 第一段 3 字 → 起点 0；分隔符占 1 位 ⇒ 第二段起点 4；第二段 4 字 + 分隔符 ⇒ 第三段起点 9
  assert.deepEqual(l.starts, [0, 4, 9]);
  assert.deepEqual(l.lengths, [3, 4, 3]);
  assert.deepEqual(buildChapterText([]), { text: '', starts: [], lengths: [] });
  assert.deepEqual(buildChapterText(['单段']).starts, [0]);
});

test('paraPosToBody / bodyPosToPara：互为逆运算（段内任意位置）', () => {
  const l = buildChapterText(PARAS);
  for (let para = 0; para < PARAS.length; para += 1) {
    const len = (PARAS[para] ?? '').length;
    for (let char = 0; char <= len; char += 1) {
      const body = paraPosToBody(l.starts, para, char);
      assert.deepEqual(
        bodyPosToPara(l, body),
        { para, char },
        `段 ${para} 的第 ${char} 字应能原路返回`,
      );
    }
  }
});

test('bodyPosToPara：偏移落在分隔符上时归到**前一段末尾**（闭区间语义）', () => {
  const l = buildChapterText(PARAS);
  // 偏移 3 是第一段的 `\n`（第 3、8 位是分隔符）
  assert.deepEqual(bodyPosToPara(l, 3), { para: 0, char: 3 });
  assert.deepEqual(bodyPosToPara(l, 8), { para: 1, char: 4 });
  // 越界（比正文长）不炸、夹到最后一段末尾
  assert.deepEqual(bodyPosToPara(l, 999), { para: 2, char: 3 });
  assert.deepEqual(bodyPosToPara(buildChapterText([]), 0), { para: 0, char: 0 });
});

test('normalizeRanges：裁剪越界、丢弃空区间、合并**真重叠**（相接不合并）', () => {
  const out = normalizeRanges(
    [
      [5, 9],
      [0, 3],
      [3, 5], // 与 [0,3] **相接**（不重叠）⇒ 必须保持独立，否则点上去分不清删哪条
      [7, 15], // 与 [5,9] 重叠 ⇒ 合并成 [5,15]
      [12, 12], // 空区间 ⇒ 丢弃
      [-5, 2], // 左越界 ⇒ 裁成 [0,2]，与 [0,3] 重叠 ⇒ 合并成 [0,3]
      [20, 999], // 右越界 ⇒ 裁到 len=100
    ],
    100,
  );
  assert.deepEqual(out, [
    [0, 3],
    [3, 5],
    [5, 15],
    [20, 100],
  ]);
  assert.deepEqual(normalizeRanges([[3, 1]], 100), [[1, 3]], '反选按交换处理（丢弃会「划了却没东西」）');
  assert.deepEqual(normalizeRanges([[10, 20]], 5), [], '整段越界 ⇒ 空');
  // 完全重合的两条（同一段文字被划两次）⇒ 合并成一条
  assert.deepEqual(normalizeRanges([[2, 5], [2, 5]], 100), [[2, 5]]);
});

test('segmentText：切出「普通/高亮」交替，且**拼接回来一字不差**', () => {
  const text = buildChapterText(PARAS).text; // '第一段\n第二段吗\n第三段'（12 字）
  const segs = segmentText(text, [[1, 6]]); // 下标 1..5 = '一段\n第二'
  assert.deepEqual(
    segs.map((s) => [s.text, s.hl]),
    [
      ['第', false],
      ['一段\n第二', true],
      ['段吗\n第三段', false],
    ],
  );
  // ★ 防空转：无论怎么切，拼回来必须等于原文（少了字符 = 正文被吃掉）
  assert.equal(segs.map((s) => s.text).join(''), text);
  // 高亮段的 `at` 要能反查回区间
  const hl = segs.filter((s) => s.hl);
  assert.deepEqual(hl.map((s) => [s.at, s.text.length]), [[1, 5]]);
});

test('segmentText：区间覆盖全长 / 无区间 / 空文本三种边界', () => {
  assert.deepEqual(segmentText('abc', [[0, 3]]), [{ text: 'abc', hl: true, at: 0 }]);
  assert.deepEqual(segmentText('abc', []), [{ text: 'abc', hl: false, at: 0 }]);
  assert.deepEqual(segmentText('', []), []);
  assert.deepEqual(segmentText('', [[0, 5]]), []);
});

test('localRangesForPara：跨段区间**在每段都裁出**一段，段外为空', () => {
  const l = buildChapterText(PARAS); // starts [0,4,9]
  // 段 0 的尾部到段 1 的头部（偏移 2~6）
  assert.deepEqual(localRangesForPara(l, [[2, 6]], 0), [[2, 3]]);
  assert.deepEqual(localRangesForPara(l, [[2, 6]], 1), [[0, 2]]);
  assert.deepEqual(localRangesForPara(l, [[2, 6]], 2), [], '完全在段外 ⇒ 空');
  // 整章覆盖 ⇒ 每段都是全长
  assert.deepEqual(localRangesForPara(l, [[0, 12]], 0), [[0, 3]]);
  assert.deepEqual(localRangesForPara(l, [[0, 12]], 1), [[0, 4]]);
  assert.deepEqual(localRangesForPara(l, [[0, 12]], 2), [[0, 3]]);
  assert.deepEqual(localRangesForPara(l, [], 1), []);
});

test('trimRange：裁掉首尾空白（区间与 bookText 必须同源）', () => {
  //            012345678
  const t = '  ab cd  '; // 长度 9
  assert.deepEqual(trimRange(t, 0, 9), [2, 7], '两端空白各裁掉 ⇒ 「ab cd」');
  assert.deepEqual(trimRange(t, 2, 7), [2, 7], '两端都不是空白 ⇒ 不动');
  assert.deepEqual(trimRange(t, 0, 3), [2, 3], '尾部空白裁掉 ⇒ 「a」');
  assert.deepEqual(trimRange(t, 6, 8), [6, 7], '尾部空白裁掉 ⇒ 「d」');
  assert.deepEqual(trimRange(t, 5, 2), [2, 4], '反选先归位再裁（[2,5)=「ab c」⇒ 尾部空格裁掉=「ab」）');
  assert.deepEqual(trimRange('   ', 0, 3), [3, 3], '全是空白 ⇒ 空区间（调用方据此禁用划线）');
  assert.deepEqual(trimRange('', 0, 0), [0, 0]);
});

test('reanchor：对得上就原样返回；对不上**只在附近**找最近一次出现', () => {
  const text = 'abcdefghij';
  assert.deepEqual(reanchor(text, 2, 5, 'cde'), [2, 5]);
  // 偏移位移了（例如切换简繁后长度变了）⇒ 按 bookText 找正
  assert.deepEqual(reanchor(text, 0, 3, 'fgh'), [5, 8]);
  // 找不到就**不要动**（宁可位置偏一点，也不能把用户的划线弄丢）
  assert.deepEqual(reanchor(text, 2, 5, 'zzz'), [2, 5]);
  assert.deepEqual(reanchor(text, 2, 5, ''), [2, 5]);

  /**
   * ★★ 这条是那个真 bug 的回归锁：同一句话在章节里出现多次时，
   * **全章第一次出现**（这里在开头）不等于「用户划的那一处」（这里在 600 字之后）。
   * 早先的实现在这里会把 [600,606) 纠到 [0,6)。
   */
  const twice = `${'x'.repeat(600)}TARGET${'y'.repeat(600)}`;
  assert.deepEqual(reanchor(twice, 600, 606, 'TARGET'), [600, 606], '本来就对 ⇒ 不动');
  assert.deepEqual(
    reanchor(twice, 601, 607, 'TARGET'),
    [600, 606],
    '差 1 个字 ⇒ 纠到**最近的**那次（600），而不是更早的 0',
  );
  // 窗口之外的出现**不接受**（宁可偏差，也不要跳到别处）
  assert.deepEqual(
    reanchor(`${'z'.repeat(5)}TARGET${'z'.repeat(2000)}`, 1000, 1006, 'TARGET'),
    [1000, 1006],
    '目标远在窗口之外 ⇒ 原样返回，绝不跳到 5',
  );
});
