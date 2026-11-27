/**
 * `#842` 句间停顿（方案 4）回归：
 *  · 0 = 紧接（与旧行为一致）；
 *  · >0 时先留白再推进；
 *  · 暂停/停止必须清掉待执行的停顿定时器（不能暂停后又自己念下一句）；
 *  · 0~800ms 收敛，默认 200ms。
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { createFakeEngine, useReadAloudStore } from '../src/stores/read-aloud';
import { useReaderStore } from '../src/stores/reader';
import { DEFAULT_GAP_MS, clampGapMs } from '../src/utils/read-aloud-core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Node 测试环境没有 localStorage；reader/read-aloud store 初始化会读它 */
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
  // 本文件只测「句间停顿」：章标题留空，避免开播时多出一条标题 utterance 干扰计数
  reader.chapter = { title: '', paragraphs: ['甲。乙。丙。'] } as never;
  const al = useReadAloudStore();
  const engine = createFakeEngine();
  al.__setEngine(engine);
  return { al, engine };
}

beforeEach(() => { setActivePinia(createPinia()); });

test('clampGapMs：0~800，非法回落 0', () => {
  assert.equal(clampGapMs(0), 0);
  assert.equal(clampGapMs(200), 200);
  assert.equal(clampGapMs(801), 800);
  assert.equal(clampGapMs(-10), 0);
  assert.equal(clampGapMs(Number.NaN), 0);
});

test('默认句间停顿是 200ms', () => {
  setActivePinia(createPinia());
  const al = useReadAloudStore();
  assert.equal(al.prefs.gapMs, DEFAULT_GAP_MS);
});

test('gap=0：ended 后立刻念下一句', () => {
  const { al, engine } = setup();
  al.setGapMs(0);
  al.play();
  assert.equal(engine.spoken.length, 1);
  engine.emitEnd();
  assert.equal(engine.spoken.length, 2);
  al.stop();
});

test('gap=120：留白期间不推进，到点才念下一句', async () => {
  const { al, engine } = setup();
  al.setGapMs(120);
  al.play();
  assert.equal(engine.spoken.length, 1);
  engine.emitEnd();
  await sleep(60);
  assert.equal(engine.spoken.length, 1, '60ms 时还在留白中');
  await sleep(90);
  assert.equal(engine.spoken.length, 2, '120ms 后应进入下一句');
  al.stop();
});

test('留白期间 pause：定时器被清掉，不会自己念下一句', async () => {
  const { al, engine } = setup();
  al.setGapMs(100);
  al.play();
  engine.emitEnd();
  al.pause();
  await sleep(150);
  assert.equal(engine.spoken.length, 1, '暂停后不得再推进');
  assert.equal(al.state, 'paused');
  al.stop();
});

test('setGapMs 收敛并写入 prefs', () => {
  const { al } = setup();
  al.setGapMs(9999);
  assert.equal(al.prefs.gapMs, 800);
  al.setGapMs(-5);
  assert.equal(al.prefs.gapMs, 0);
  al.setGapMs(200);
  al.stop();
});
