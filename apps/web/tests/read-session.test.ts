/**
 * 阅读会话合成器的回归锁（P1 `#863`）。
 *
 * 全部用**显式时钟**推进，不依赖真实 setInterval；断言直接对应 D-3 / D-6 的口径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKPOINT_TTL_MS,
  IDLE_TIMEOUT_MS,
  ReadSessionTracker,
  SESSION_QUEUE_LIMIT,
  DEVICE_ID_KEY,
  clearCheckpoint,
  ensureDeviceId,
  enqueueSession,
  loadCheckpoint,
  saveCheckpoint,
  takeCheckpoint,
  type SessionStorage,
} from '../src/utils/read-session';

class FakeStorage implements SessionStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

const T0 = 1_700_000_000_000;
const META = {
  bookUrl: 'https://src.test/book/a',
  bookName: '书 A',
  bookAuthor: '作者',
  chapterIndex: 3,
  chapterTitle: '第三章',
  startProgress: 0.2,
};

function makeTracker(over: { mode?: 'visual' | 'listen' | 'auto'; storage?: SessionStorage } = {}) {
  let now = T0;
  const tr = new ReadSessionTracker({
    meta: META,
    mode: over.mode ?? 'visual',
    now: () => now,
    deviceId: 'yu-test',
    storage: over.storage ?? new FakeStorage(),
  });
  return {
    tr,
    advance(ms: number) {
      now += ms;
      return now;
    },
    get now() {
      return now;
    },
  };
}

test('visual：持续活动 ⇒ 有效 = 在线（5 分钟 300s）', () => {
  const { tr, advance } = makeTracker();
  for (let i = 0; i < 20; i += 1) {
    advance(15_000);
    tr.markActivity();
    tr.tick();
  }
  const s = tr.finish()!;
  assert.equal(s.totalMs, 300_000);
  assert.equal(s.effectiveMs, 300_000);
});

test('visual：最后一次活动后最多再记 120s（挂机不被记满）', () => {
  const { tr, advance } = makeTracker();
  // 前 15s 有活动，之后 5 分钟无活动
  for (let i = 0; i < 20; i += 1) {
    advance(15_000);
    if (i === 0) tr.markActivity();
    tr.tick();
  }
  const s = tr.finish()!;
  assert.equal(s.totalMs, 300_000, '在线仍在增长');
  assert.equal(s.effectiveMs, 135_000, '15s 活动内 + 120s 空闲额度');
  assert.equal(IDLE_TIMEOUT_MS, 120_000);
});

test('隐藏页面后不再累计（切后台/锁屏即结束的前置条件）', () => {
  const { tr, advance } = makeTracker();
  advance(60_000);
  tr.markActivity();
  tr.setVisible(false);
  for (let i = 0; i < 20; i += 1) {
    advance(15_000);
    tr.tick();
  }
  const s = tr.finish()!;
  assert.equal(s.totalMs, 60_000);
  assert.equal(s.effectiveMs, 60_000);
});

test('listen：暂停期间不记有效，但在线时长继续', () => {
  const { tr, advance } = makeTracker({ mode: 'listen' });
  advance(60_000);
  tr.tick();
  tr.setModeActive(false);
  advance(120_000);
  tr.tick();
  tr.setModeActive(true);
  advance(60_000);
  tr.tick();
  const s = tr.finish()!;
  assert.equal(s.totalMs, 240_000);
  assert.equal(s.effectiveMs, 120_000, '暂停的 120s 不计入听书有效');
  assert.equal(s.mode, 'listen');
});

test('auto：开启期间计入 auto 有效（不看活动事件）', () => {
  const { tr, advance } = makeTracker({ mode: 'auto' });
  for (let i = 0; i < 8; i += 1) {
    advance(15_000);
    tr.tick();
  }
  const s = tr.finish()!;
  assert.equal(s.totalMs, 120_000);
  assert.equal(s.effectiveMs, 120_000);
});

test('finish：不足 1 秒不落库；切章不结束会话、页数与断点正确', () => {
  const short = makeTracker();
  short.advance(500);
  assert.equal(short.tr.finish(), null);

  const { tr, advance } = makeTracker();
  advance(30_000);
  tr.addPage();
  tr.setChapter(4, '第四章', 0.4);
  advance(30_000);
  tr.addPage();
  const s = tr.finish()!;
  assert.equal(s.chapterIndex, 4);
  assert.equal(s.chapterTitle, '第四章');
  assert.equal(s.readPageCount, 2);
  assert.equal(s.endProgress, 0.4);
  assert.equal(s.startProgress, 0.2);
  assert.equal(s.tzOffsetMin, -new Date(T0 + 60_000).getTimezoneOffset());
  assert.equal(s.sessionId.length > 0, true);
});

test('检查点：同书同模式 10 分钟内可续接，否则判 stale 并清除', () => {
  const st = new FakeStorage();
  const { tr, advance } = makeTracker({ storage: st });
  advance(90_000);
  tr.tick();
  const snap = tr.snapshot();
  saveCheckpoint(snap, st);
  const loaded = loadCheckpoint(st)!;
  assert.equal(loaded.sessionId, snap.sessionId);

  const ok = takeCheckpoint(META.bookUrl, 'visual', snap.endAt + 60_000, st)!;
  assert.equal(ok.resumable, true);

  // 续接：同 sessionId + 已有累计，不丢前 90s；崩溃空档不计入
  const resumed = new ReadSessionTracker({
    meta: META,
    mode: 'visual',
    now: () => snap.endAt + 60_000,
    deviceId: 'yu-test',
    storage: st,
    sessionId: loaded.sessionId,
    restored: { startAt: loaded.startAt, totalMs: loaded.totalMs, effectiveMs: loaded.effectiveMs, readPageCount: loaded.readPageCount },
  });
  resumed.tick();
  const s = resumed.finish()!;
  assert.equal(s.sessionId, snap.sessionId);
  assert.equal(s.totalMs, 90_000, '续接保留 90s；中断的 60s 空档不补记');

  const stale = takeCheckpoint(META.bookUrl, 'visual', snap.endAt + CHECKPOINT_TTL_MS + 1, st)!;
  assert.equal(stale.resumable, false);
  assert.equal(loadCheckpoint(st), null, 'stale 后检查点被清除');

  clearCheckpoint(st);
  assert.equal(loadCheckpoint(st), null);

  // 换书 ⇒ stale（不同书的检查点不能续接）
  saveCheckpoint(snap, st);
  const otherBook = takeCheckpoint('https://src.test/book/b', 'visual', snap.endAt + 1, st)!;
  assert.equal(otherBook.resumable, false);
});

test('离线队列：按 sessionId 去重，超上限只保留最新 200 条', () => {
  const dedupe = new FakeStorage();
  const one = { ...makeTracker().tr.snapshot(), sessionId: 's-1', bookUrl: 'https://b/1' };
  enqueueSession(one, dedupe);
  enqueueSession(one, dedupe);
  const single = JSON.parse(dedupe.getItem('yuedu.readSessionQueue.v1') ?? '[]') as Array<{ sessionId: string }>;
  assert.equal(single.length, 1, '重复 sessionId 不重复入队');

  const st = new FakeStorage();
  const mk = (i: number) => ({ ...makeTracker().tr.snapshot(), sessionId: `s-${i}`, bookUrl: `https://b/${i}` });
  for (let i = 1; i <= SESSION_QUEUE_LIMIT + 10; i += 1) enqueueSession(mk(i), st);
  const raw = JSON.parse(st.getItem('yuedu.readSessionQueue.v1') ?? '[]') as Array<{ sessionId: string }>;
  assert.equal(raw.length, SESSION_QUEUE_LIMIT);
  assert.equal(raw[0]!.sessionId, 's-11', '超出上限时丢最老的');
  assert.equal(raw[raw.length - 1]!.sessionId, `s-${SESSION_QUEUE_LIMIT + 10}`);
});

test('设备标识：每 origin 生成一次并保持稳定', () => {
  const st = new FakeStorage();
  const a = ensureDeviceId(st);
  const b = ensureDeviceId(st);
  assert.equal(a, b);
  assert.ok(a.startsWith('yu-'));
  assert.equal(st.getItem(DEVICE_ID_KEY), a);
});
