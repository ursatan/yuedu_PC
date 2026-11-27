/**
 * 章节标题朗读回归（用户 2026-11-10：朗读 / 歌词窗都没有标题）。
 *
 * 上游依据（`F:\legado`）：
 *  · `TextChapterLayout` 把标题排成独立的 `title:*` 段落项，标题文字同时 append 进章文本；
 *  · `ParagraphSpeechQueue.build` 只过滤图片 / 空白 / 纯标点 ⇒ 标题排在正文之前被念；
 *  · 但起播位置按阅读进度（`ParagraphPosition.findItemIndex(items, position)`），
 *    所以**只有从章首起播**才念标题。
 *
 * 本仓同口径：章首开播 → 先念标题再念第一句；从章中某句起播 → 不回头念标题；
 * 标题期间 `speakingTitle` 为真（歌词窗据此把标题当成当前行），结束后只念一次正文第一句。
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { createFakeEngine, useReadAloudStore } from '../src/stores/read-aloud';
import { useReaderStore } from '../src/stores/reader';

/** Node 测试环境没有 localStorage；store 初始化会读它 */
const memory = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  get length() { return memory.size; },
  clear: () => memory.clear(),
  getItem: (k: string) => memory.get(k) ?? null,
  key: (i: number) => [...memory.keys()][i] ?? null,
  removeItem: (k: string) => { memory.delete(k); },
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
};

function setup() {
  setActivePinia(createPinia());
  const reader = useReaderStore();
  reader.chapter = { title: '第一章 启程', paragraphs: ['甲。乙。丙。'] } as never;
  const al = useReadAloudStore();
  const engine = createFakeEngine();
  al.__setEngine(engine);
  return { al, engine };
}

beforeEach(() => { setActivePinia(createPinia()); });

test('chaptTitle 与阅读页页眉同源（displayTitle）', () => {
  const { al } = setup();
  assert.equal(al.chapterTitle, '第一章 启程');
});

test('章首开播：先念标题，再念正文第一句，且只念一次标题', () => {
  const { al, engine } = setup();
  al.setGapMs(0);
  al.play();
  assert.deepEqual(engine.spoken, ['第一章 启程']);
  assert.equal(al.speakingTitle, true);
  assert.equal(al.currentText, '第一章 启程', '歌词窗标题期间把标题当当前行');

  engine.emitEnd();
  assert.equal(al.speakingTitle, false);
  assert.deepEqual(engine.spoken.slice(1), ['甲。']);
  assert.equal(al.currentText, '甲。');

  engine.emitEnd(); // 第二句：不应再念标题
  assert.deepEqual(engine.spoken.slice(1), ['甲。', '乙。']);
  al.stop();
});

test('从章中起播：不回头念标题（对齐上游按进度位置起播）', () => {
  const { al, engine } = setup();
  al.refreshSentences();
  al.index = 2;
  al.play();
  assert.deepEqual(engine.spoken, ['丙。'], '不念标题，直接念当前段');
  assert.equal(al.speakingTitle, false);
  assert.equal(al.titleSpoken, true, '标题已在身后 ⇒ 本章不再补念');
  al.stop();
});

test('停止 / 复位后标题状态清零（下次开播重新念）', () => {
  const { al, engine } = setup();
  al.play();
  engine.emitEnd();
  al.stop();
  assert.equal(al.titleSpoken, false);
  assert.equal(al.speakingTitle, false);

  al.play();
  assert.deepEqual(engine.spoken.at(-1), '第一章 启程', '重新开播先念标题');
  al.stop();
});

test('念标题时按下一句：进入本章第一句而不是跳过', () => {
  const { al, engine } = setup();
  al.play();
  al.nextParagraph();
  assert.equal(al.speakingTitle, false);
  assert.equal(al.currentText, '甲。');
  assert.deepEqual(engine.spoken.at(-1), '甲。');
  al.stop();
});
