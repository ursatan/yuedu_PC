/**
 * `#146` 书内全文搜索的纯逻辑回归锁（不碰 DOM / 不碰 IndexedDB）。
 *
 * 重点锁四类**容易静默错**的东西：
 *  ① 片段裁剪的边界（关键词在章首/章尾时 `queryIndexInResult` 必须还对得上）；
 *  ② **正则零宽匹配不能死循环**（上游 Kotlin 的 `findAll` 没这问题，JS 的 `exec` 有）；
 *  ③ 正则非法必须**返回 `null`（可区分）**，不能和「真的没命中」混成一个空数组；
 *  ④ 命中数上限触顶要能**看出来**（`truncated`），不许静默截断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_HITS_PER_CHAPTER,
  SEARCH_PAD,
  chapterTextOf,
  findPositions,
  searchChapterContent,
  snippetAt,
  sortHits,
} from '../src/utils/book-search';

test('chapterTextOf：段落用 `\\n` 连接（与 chapter-text 同一坐标系）', () => {
  assert.equal(chapterTextOf(['第一段', '第二段']), '第一段\n第二段');
  assert.equal(chapterTextOf([]), '');
});

test('findPositions：普通模式找出全部出现（含相邻/重叠边界）', () => {
  assert.deepEqual(findPositions('abcabc', 'abc'), [0, 3]);
  assert.deepEqual(findPositions('aaaa', 'aa'), [0, 2], 'indexOf 循环不重叠：0 之后从 2 继续');
  assert.deepEqual(findPositions('abc', 'z'), []);
  assert.deepEqual(findPositions('abc', ''), [], '空查询词不产生命中');
  assert.deepEqual(findPositions('', 'a'), []);
});

test('findPositions：正则模式 —— 零宽匹配**不能死循环**（这条是真会挂的）', () => {
  const out = findPositions('abc', '^', true);
  assert.ok(out !== null && out.length >= 1, '零宽匹配应返回而不是卡死');
  const out2 = findPositions('aXbXc', 'X', true);
  assert.deepEqual(out2, [1, 3]);
  // 前瞻断言全是零宽匹配
  const out3 = findPositions('abc', '(?=b)', true);
  assert.deepEqual(out3, [1]);
});

test('findPositions：正则非法返回 `null`（与「没命中」必须分得开）', () => {
  assert.equal(findPositions('abc', '([', true), null);
  assert.deepEqual(findPositions('abc', '([', false), [], '普通模式就是普通字符，不当正则');
});

test('findPositions：触到上限即停，且**恰好**上限条', () => {
  const content = 'a'.repeat(MAX_HITS_PER_CHAPTER + 50);
  const out = findPositions(content, 'a');
  assert.equal(out?.length, MAX_HITS_PER_CHAPTER);
});

test('snippetAt：左右各 20 字，两端按边界夹紧，`queryIndexInResult` 对得上', () => {
  const content = `${'x'.repeat(50)}KEY${'y'.repeat(50)}`; // KEY 在 50..52
  const s = snippetAt(content, 50, 3);
  assert.equal(SEARCH_PAD, 20);
  assert.equal(s.text, `${'x'.repeat(20)}KEY${'y'.repeat(20)}`, '前缀 20 + 关键词 + 后缀 20');
  assert.equal(s.queryIndexInResult, 20);
  assert.equal(s.text.slice(s.queryIndexInResult, s.queryIndexInResult + 3), 'KEY');

  // 章首：前缀被夹到 0
  const head = snippetAt(`KEY${'y'.repeat(50)}`, 0, 3);
  assert.equal(head.queryIndexInResult, 0);
  assert.equal(head.text.slice(0, 3), 'KEY');
  assert.equal(head.text.length, 3 + 20);

  // 章尾：后缀被夹到末尾
  const tail = snippetAt(`${'x'.repeat(50)}KEY`, 50, 3);
  assert.equal(tail.text.length, 20 + 3);
  assert.equal(tail.text.slice(tail.queryIndexInResult, tail.queryIndexInResult + 3), 'KEY');
});

test('searchChapterContent：命中片段可反查、按位置排序、章信息带上', () => {
  const content = '甲甲_KEY1_乙乙_乙_KEY2_丙丙';
  const { result, regexError } = searchChapterContent({
    content,
    query: 'KEY',
    chapterIndex: 3,
    chapterTitle: '第三章',
  });
  assert.equal(regexError, false);
  assert.equal(result.truncated, false);
  assert.equal(result.hits.length, 2);
  for (const h of result.hits) {
    // ★ 防空转：`chapterPos` + `queryIndexInResult` 必须能**反查回**片段里的关键词
    assert.equal(
      content.slice(h.chapterPos, h.chapterPos + h.query.length),
      h.query,
      'chapterPos 必须指向关键词本身',
    );
    assert.equal(h.text.slice(h.queryIndexInResult, h.queryIndexInResult + h.query.length), h.query);
    assert.equal(h.chapterIndex, 3);
    assert.equal(h.chapterTitle, '第三章');
  }
  assert.ok(result.hits[0]!.chapterPos < result.hits[1]!.chapterPos, '按正文位置排序');
});

test('searchChapterContent：空查询词 ⇒ 无命中（不炸、不产生空片段）', () => {
  const { result } = searchChapterContent({
    content: 'abc', query: '', chapterIndex: 0, chapterTitle: 't',
  });
  assert.equal(result.hits.length, 0);
});

test('searchChapterContent：正则非法 ⇒ `regexError`（调用方据此提示用户）', () => {
  const { result, regexError } = searchChapterContent({
    content: 'abc',
    query: '([',
    chapterIndex: 0,
    chapterTitle: 't',
    isRegex: true,
  });
  assert.equal(regexError, true);
  assert.equal(result.hits.length, 0);
});

test('searchChapterContent：触到上限 ⇒ `truncated` 标记（不静默截断）', () => {
  const { result } = searchChapterContent({
    content: 'a'.repeat(MAX_HITS_PER_CHAPTER + 10),
    query: 'a',
    chapterIndex: 0,
    chapterTitle: 't',
  });
  assert.equal(result.truncated, true);
  assert.equal(result.hits.length, MAX_HITS_PER_CHAPTER);
});

test('sortHits：先按章、再按位置（跨章结果排序）', () => {
  const mk = (chapterIndex: number, chapterPos: number) => ({
    chapterIndex, chapterPos, chapterTitle: '', text: '', queryIndexInResult: 0, query: '',
  });
  const sorted = sortHits([mk(2, 5), mk(0, 9), mk(0, 1), mk(1, 0)]);
  assert.deepEqual(sorted.map((h) => [h.chapterIndex, h.chapterPos]), [
    [0, 1], [0, 9], [1, 0], [2, 5],
  ]);
});
