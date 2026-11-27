/**
 * `#863` 阅读会话统计：两个存储实现（SQLite / JSON）同口径回归。
 *
 * 锁的是「聚合增量正确性」——最容易出错的地方是**跨日/跨时段一条会话被记两遍**或
 * **重放时重复累加**。断言里的期望值都是手算出来的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyShelfBook,
  type ReadSession,
} from '../contract/user-data';
import {
  createJsonUserStore,
  createSqliteUserStore,
  hasSqliteSupport,
  type UserDataStore,
} from '../user-store';

const TZ = 480;
/** 东八区本地时间 → epoch ms */
const cst = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Date.UTC(y, m - 1, d, h - 8, min, 0, 0);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'yuedu-readstat-'));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows 偶发文件占用，交给系统回收 */
  }
}

const BOOK_A = 'https://src.test/book/a';
const BOOK_B = 'https://src.test/book/b';

function session(over: Partial<ReadSession>): ReadSession {
  const startAt = over.startAt ?? cst(2026, 11, 8, 6, 10);
  return {
    sessionId: 's-x',
    deviceId: 'yu-test',
    bookUrl: BOOK_A,
    bookName: '书 A',
    bookAuthor: '作者',
    chapterIndex: 0,
    chapterTitle: '第一章',
    startAt,
    endAt: startAt + 60_000,
    totalMs: 60_000,
    effectiveMs: 60_000,
    readWords: 0,
    readPageCount: 1,
    mode: 'visual',
    startProgress: 0,
    endProgress: 0.1,
    tzOffsetMin: TZ,
    createdAt: startAt,
    ...over,
  };
}

/** 四条覆盖「跨日 / 目视 / 听书 / 自动」的会话 */
const FIXTURES: ReadSession[] = [
  // 1) 跨日：11-08 23:50 → 11-09 00:10，total 1200s，eff 600s
  session({
    sessionId: 's1',
    startAt: cst(2026, 11, 8, 23, 50),
    endAt: cst(2026, 11, 9, 0, 10),
    totalMs: 1_200_000,
    effectiveMs: 600_000,
    chapterIndex: 3,
    chapterTitle: '第三章',
    readPageCount: 10,
    startProgress: 0.2,
    endProgress: 0.3,
  }),
  // 2) 目视 06:10–06:20（书 A）
  session({
    sessionId: 's2',
    startAt: cst(2026, 11, 8, 6, 10),
    endAt: cst(2026, 11, 8, 6, 20),
    totalMs: 600_000,
    effectiveMs: 600_000,
    chapterIndex: 5,
    chapterTitle: '第五章',
    readPageCount: 4,
  }),
  // 3) 听书 06:20–06:30（书 B）：total 600s，有效听书 480s（中途暂停 2 分钟）
  session({
    sessionId: 's3',
    bookUrl: BOOK_B,
    bookName: '书 B',
    startAt: cst(2026, 11, 8, 6, 20),
    endAt: cst(2026, 11, 8, 6, 30),
    totalMs: 600_000,
    effectiveMs: 480_000,
    mode: 'listen',
    chapterIndex: 1,
  }),
  // 4) 自动滚动 12:00–12:05（书 B）
  session({
    sessionId: 's4',
    bookUrl: BOOK_B,
    bookName: '书 B',
    startAt: cst(2026, 11, 8, 12, 0),
    endAt: cst(2026, 11, 8, 12, 5),
    totalMs: 300_000,
    effectiveMs: 300_000,
    mode: 'auto',
    chapterIndex: 2,
  }),
];

async function conformance(store: UserDataStore): Promise<void> {
  // 先写一条旧口径记录，验证「历史总额」只读汇总
  await store.upsertReadRecord({ deviceId: 'local', bookName: '旧书', author: '', readTime: 3_600_000, lastRead: cst(2026, 11, 1, 8) });

  const r1 = await store.appendReadSessions(FIXTURES);
  assert.deepEqual(r1, { inserted: 4, skipped: 0 });

  const snap = await store.getReadStats();
  assert.equal(snap.days.length, 2, '跨日会话必须切成两天');
  assert.equal(snap.firstDay, '2026-11-08');

  const d1 = snap.days.find((d) => d.day === '2026-11-08')!;
  assert.equal(d1.totalMs, 2_100_000, '11-08 在线 = 600k(跨日) + 600k + 600k + 300k');
  assert.equal(d1.effectiveMs, 900_000, '目视有效 = 300k(跨日) + 600k');
  assert.equal(d1.visualMs, 900_000);
  assert.equal(d1.listenMs, 480_000);
  assert.equal(d1.autoMs, 300_000);
  assert.equal(d1.dawnMs, 0);
  assert.equal(d1.morningMs, 600_000, '只有 s2 是目视且落在 morning');
  assert.equal(d1.afternoonMs, 0, '自动滚动不进四时段（D-5）');
  assert.equal(d1.nightMs, 300_000, 's1 前半段是目视 night');
  assert.equal(d1.sessionCount, 4, '按会话开始日计数');
  assert.equal(d1.pageCount, 16, '10 + 4 + 默认 1 + 默认 1');

  const d2 = snap.days.find((d) => d.day === '2026-11-09')!;
  assert.equal(d2.totalMs, 600_000, '跨日会话后半段落在次日');
  assert.equal(d2.effectiveMs, 300_000);
  assert.equal(d2.dawnMs, 300_000);
  assert.equal(d2.sessionCount, 0, '次日没有新会话开始');

  const a = snap.books.find((b) => b.bookUrl === BOOK_A)!;
  assert.equal(a.totalMs, 1_800_000);
  assert.equal(a.effectiveMs, 1_200_000, '按书聚合不按日切片：600k(跨日) + 600k');
  assert.equal(a.sessionCount, 2);
  assert.equal(a.nightMs, 300_000);
  assert.equal(a.morningMs, 600_000);

  const b = snap.books.find((b) => b.bookUrl === BOOK_B)!;
  assert.equal(b.effectiveMs, 0, '听书/自动不进目视有效');
  assert.equal(b.listenMs, 480_000);
  assert.equal(b.autoMs, 300_000);
  assert.equal(b.totalMs, 900_000);

  assert.equal(snap.visualSessionCount, 2);
  assert.equal(snap.avgVisualSessionMs, 600_000);
  assert.equal(snap.legacyReadMs, 3_600_000);

  assert.equal(snap.breakPoints.length, 2);
  assert.equal(snap.breakPoints[0]!.bookUrl, BOOK_A, '书 A 的跨日会话结束最晚（00:10）');
  assert.equal(snap.breakPoints[0]!.chapterTitle, '第三章');

  // 幂等：重放同一批 ⇒ 一条都不新增，聚合不变
  const r2 = await store.appendReadSessions(FIXTURES);
  assert.deepEqual(r2, { inserted: 0, skipped: 4 });
  const snap2 = await store.getReadStats();
  assert.deepEqual(
    snap2.days.map((d) => [d.day, d.totalMs, d.effectiveMs]),
    snap.days.map((d) => [d.day, d.totalMs, d.effectiveMs]),
  );
  assert.equal(snap2.books[0]!.effectiveMs, 1_200_000);

  // 非法会话：缺 bookUrl ⇒ 跳过；effective > total ⇒ 钳住
  const r3 = await store.appendReadSessions([
    session({ sessionId: 'bad', bookUrl: '' }),
    session({ sessionId: 's5', bookUrl: 'https://src.test/book/c', startAt: cst(2026, 11, 10, 8), endAt: cst(2026, 11, 10, 8, 1), totalMs: 60_000, effectiveMs: 999_999 }),
  ]);
  assert.deepEqual(r3, { inserted: 1, skipped: 1 });
  const rows = await store.listReadSessions(20);
  const s5 = rows.find((x) => x.sessionId === 's5')!;
  assert.equal(s5.effectiveMs, 60_000, '有效时长不得超过总时长');

  // B2 单书下钻：bookUrl 过滤只取该书，且排序/limit 同时生效
  const bookBRows = await store.listReadSessions(20, BOOK_B);
  assert.deepEqual(bookBRows.map((x) => x.sessionId).sort(), ['s3', 's4']);
  assert.equal((await store.listReadSessions(1, BOOK_A))[0]!.sessionId, 's1', '书 A 最近一条是跨日会话 s1');

  // 书架行不被统计表污染（两张表独立）
  assert.equal(await store.countBooks(), 0);
  await store.upsertBook({ ...emptyShelfBook(cst(2026, 11, 1, 8)), bookUrl: BOOK_A, name: '书 A' });
  assert.equal(await store.countBooks(), 1);
}

test('阅读会话统计：SQLite 实现', { skip: !hasSqliteSupport() }, async () => {
  const dir = tempDir();
  try {
    const store = await createSqliteUserStore({ dir });
    await conformance(store);
    await store.close();
    // 重开验证 schema 迁移与聚合持久化（v7 表在 DDL 里幂等建立）
    const reopened = await createSqliteUserStore({ dir });
    const snap = await reopened.getReadStats();
    assert.equal(snap.days.length, 3, '重开后聚合仍在（含 s5 的 11-10）');
    assert.equal(snap.books.find((b) => b.bookUrl === BOOK_A)!.effectiveMs, 1_200_000);
    await reopened.close();
  } finally {
    cleanup(dir);
  }
});

test('阅读会话统计：JSON 回落实现语义同构', async () => {
  const dir = tempDir();
  try {
    const store = await createJsonUserStore({ dir });
    await conformance(store);
    await store.close();
  } finally {
    cleanup(dir);
  }
});
