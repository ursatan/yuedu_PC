/**
 * `D7` 桌面歌词上报：换章后**句数相同、文本不同**也必须重绘。
 *
 * 缺陷形态：旧实现只 watch `sentences.length` —— 新章句数恰好与旧章相同、`index` 也没变时，
 * 依赖逐项相等 ⇒ 不触发 ⇒ 歌词窗一直显示上一章的内容（静默错内容，不报错）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';

import {
  buildLyricsPayload,
  lyricsFingerprint,
  startLyricsPublisher,
  type LyricsReadAloud,
} from '../src/utils/desktop-lyrics';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('payload：下标夹取 + 前后句取邻近项', () => {
  const al: LyricsReadAloud = {
    state: 'playing',
    index: 1,
    innerPos: 3,
    sentences: [{ text: '第一句' }, { text: '第二句' }, { text: '第三句' }],
  };
  assert.deepEqual(buildLyricsPayload(al), {
    active: true,
    playing: true,
    paused: false,
    index: 1,
    innerPos: 3,
    prev: '第一句',
    current: '第二句',
    next: '第三句',
  });
  // 越界下标夹回最后一句（与旧实现同口径）
  assert.equal(buildLyricsPayload({ ...al, index: 99 }).current, '第三句');
  // 空列表不抛错
  assert.equal(buildLyricsPayload({ ...al, sentences: [] }).current, '');
});

test('★ 句数相同、文本不同 ⇒ 指纹不同（watch 依赖会变化）', () => {
  const before: LyricsReadAloud = {
    state: 'playing',
    index: 0,
    innerPos: 0,
    sentences: [{ text: '旧章第一句' }, { text: '旧章第二句' }],
  };
  const after: LyricsReadAloud = {
    ...before,
    sentences: [{ text: '新章第一句' }, { text: '新章第二句' }],
  };
  assert.equal(before.sentences.length, after.sentences.length, '前置：句数必须相同');
  assert.notEqual(
    lyricsFingerprint(buildLyricsPayload(before)),
    lyricsFingerprint(buildLyricsPayload(after)),
    '文本变了指纹就必须变，否则换章后歌词窗不会重绘',
  );
  // 反例：内容完全一致 ⇒ 指纹一致（不重复推送）
  assert.equal(
    lyricsFingerprint(buildLyricsPayload(before)),
    lyricsFingerprint(buildLyricsPayload({ ...before })),
  );
});

test('★ 换章（句数相同、文本不同）⇒ 真的再推送一次新文本', async () => {
  const al = reactive<LyricsReadAloud>({
    state: 'playing',
    index: 0,
    innerPos: 0,
    sentences: [{ text: '旧章第一句' }, { text: '旧章第二句' }],
  });
  const pushes: string[] = [];
  const stop = startLyricsPublisher(
    () => al,
    (p) => pushes.push(p.current),
    0,
  );
  await sleep(10);
  assert.equal(pushes.length, 1, 'immediate 必须先推一次');
  assert.equal(pushes[0], '旧章第一句');

  // 换章：句数不变、index 不变，只有文本变了
  al.sentences = [{ text: '新章第一句' }, { text: '新章第二句' }];
  await sleep(10);
  assert.equal(pushes.length, 2, '句数相同也必须重绘（缺陷形态就是这里不会推）');
  assert.equal(pushes[1], '新章第一句');

  // 同样的内容再触发一次不该重复推送（内容未变）
  al.index = 0;
  await sleep(10);
  assert.equal(pushes.length, 2, 'payload 未变时不应重复推送');

  stop();
});
