/**
 * P2 纯计算层回归锁（A1–A7 / B1）。
 *
 * web 包没有 jsdom（见 `in-app-browser.test.ts` 的约定），这里只测纯函数：
 * 日期键运算、窗口累计、星期×时段折叠、最长连续、作者聚合、会话间隔/时长分桶。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BookReadStat, ReadSession, UserReadStat } from '@yuedu/core/contract';
import {
  addDayKey,
  authorRows,
  bookDailySeries,
  bookPeriodMs,
  dayKeyOf,
  dominantPeriod,
  gapBuckets,
  lengthBuckets,
  longestValidStreak,
  localDayKey,
  recentSessions,
  weekdayIndexOf,
  weekdayPeriodRows,
  windowStats,
} from '../src/utils/read-stats-p2';

function day(dayKey: string, patch: Partial<UserReadStat> = {}): UserReadStat {
  return {
    day: dayKey,
    totalMs: 0,
    effectiveMs: 0,
    visualMs: 0,
    listenMs: 0,
    autoMs: 0,
    dawnMs: 0,
    morningMs: 0,
    afternoonMs: 0,
    nightMs: 0,
    sessionCount: 0,
    pageCount: 0,
    wordCount: 0,
    ...patch,
  };
}

function book(patch: Partial<BookReadStat> = {}): BookReadStat {
  return {
    bookUrl: 'u',
    bookName: '书',
    author: '',
    totalMs: 0,
    effectiveMs: 0,
    visualMs: 0,
    listenMs: 0,
    autoMs: 0,
    dawnMs: 0,
    morningMs: 0,
    afternoonMs: 0,
    nightMs: 0,
    sessionCount: 0,
    pageCount: 0,
    wordCount: 0,
    firstReadAt: 0,
    lastReadAt: 0,
    ...patch,
  };
}

function session(patch: Partial<ReadSession> = {}): ReadSession {
  return {
    sessionId: Math.random().toString(36).slice(2),
    deviceId: 'yu-test',
    bookUrl: 'book-a',
    bookName: '书 A',
    bookAuthor: '',
    chapterIndex: 0,
    chapterTitle: '',
    startAt: 0,
    endAt: 0,
    totalMs: 0,
    effectiveMs: 0,
    readWords: 0,
    readPageCount: 0,
    mode: 'visual',
    startProgress: 0,
    endProgress: 0,
    tzOffsetMin: 480,
    createdAt: 0,
    ...patch,
  };
}

test('日期键运算：加减天数跨月、星期序号以周一为 0', () => {
  assert.equal(addDayKey('2026-11-09', -1), '2026-11-08');
  assert.equal(addDayKey('2026-03-01', -1), '2026-02-28');
  assert.equal(addDayKey('2026-12-31', 1), '2027-01-01');
  assert.equal(localDayKey(new Date(2026, 10, 9, 12)), '2026-11-09');
  assert.equal(weekdayIndexOf('2026-11-09'), 0, '11-09 是周一');
  assert.equal(weekdayIndexOf('2026-11-08'), 6, '11-08 是周日');
});

test('窗口累计：含端点，前一周与本周各自求和', () => {
  const days = [
    day('2026-11-02', { effectiveMs: 100, totalMs: 200, listenMs: 300, sessionCount: 1 }),
    day('2026-11-03', { effectiveMs: 200, totalMs: 400, listenMs: 0, sessionCount: 2 }),
    day('2026-11-08', { effectiveMs: 300, totalMs: 500, listenMs: 100, sessionCount: 3 }),
    day('2026-11-09', { effectiveMs: 400, totalMs: 600, listenMs: 200, sessionCount: 4 }),
    day('2026-11-10', { effectiveMs: 999 }), // 窗口外（未来）
  ];
  const cur = windowStats(days, '2026-11-09', 2);
  assert.deepEqual(
    { e: cur.effectiveMs, t: cur.totalMs, l: cur.listenMs, n: cur.sessionCount },
    { e: 700, t: 1100, l: 300, n: 7 },
  );
  const prev = windowStats(days, '2026-11-07', 7);
  assert.equal(prev.effectiveMs, 300, '窗口外的前一周只有 11-02、11-03 两天');
});

test('星期 × 四时段：按周几折叠，四桶同时累加', () => {
  const days = [
    day('2026-11-08', { effectiveMs: 300, dawnMs: 0, morningMs: 100, afternoonMs: 150, nightMs: 50 }),
    day('2026-11-09', { effectiveMs: 400, dawnMs: 20, morningMs: 380, afternoonMs: 0, nightMs: 0 }),
    day('2026-11-15', { effectiveMs: 500, dawnMs: 0, morningMs: 0, afternoonMs: 0, nightMs: 500 }),
  ];
  const rows = weekdayPeriodRows(days);
  assert.equal(rows.length, 7);
  assert.equal(rows[6].totalMs, 800, '两个周日（11-08、11-15）合并');
  assert.deepEqual(rows[6].cells, { dawn: 0, morning: 100, afternoon: 150, night: 550 });
  assert.equal(rows[0].totalMs, 400);
  assert.equal(rows[0].cells.morning, 380);
  assert.equal(rows[1].totalMs, 0);
});

test('最长连续有效日：只数真正相邻的日期，缺一天即断', () => {
  const days = [
    day('2026-11-01', { effectiveMs: 120_000 }),
    day('2026-11-02', { effectiveMs: 120_000 }),
    day('2026-11-03', { effectiveMs: 30_000 }), // 未达标 → 断
    day('2026-11-04', { effectiveMs: 90_000 }),
    day('2026-11-05', { effectiveMs: 90_000 }),
    day('2026-11-06', { effectiveMs: 90_000 }),
  ];
  assert.equal(longestValidStreak(days, 60_000), 3, '11-04..06 连续 3 天');
  assert.equal(longestValidStreak([], 60_000), 0);
});

test('按书时段：四桶取值与最常读时段（全 0 返回 null）', () => {
  const b = book({ dawnMs: 10, morningMs: 50, afternoonMs: 30, nightMs: 0 });
  assert.deepEqual(bookPeriodMs(b), { dawn: 10, morning: 50, afternoon: 30, night: 0 });
  assert.equal(dominantPeriod(bookPeriodMs(b)), 'morning');
  assert.equal(dominantPeriod(bookPeriodMs(book())), null);
});

test('常读作者：同作者合并且跳过空作者', () => {
  const books = [
    book({ bookUrl: 'b1', author: '作者甲', effectiveMs: 600 }),
    book({ bookUrl: 'b2', author: '作者甲', effectiveMs: 300 }),
    book({ bookUrl: 'b3', author: '作者乙', effectiveMs: 700 }),
    book({ bookUrl: 'b4', author: '  ', effectiveMs: 9000 }),
    book({ bookUrl: 'b5', author: '', effectiveMs: 9000 }),
  ];
  const rows = authorRows(books, 5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].author, '作者甲');
  assert.equal(rows[0].effectiveMs, 900, '同作者两本合并后应排在 700 之前');
  assert.equal(rows[0].bookCount, 2);
  assert.equal(rows[1].author, '作者乙');
  assert.equal(rows[1].effectiveMs, 700);
});

test('会话间隔分桶：边界值落在上界桶，负间隔按 0 处理', () => {
  const base = 1_800_000_000_000;
  let cursor = base;
  /** 每条会话固定 1 分钟长；`gap` 是「上一条结束 → 这一条开始」的间隔 */
  const s = (i: number, gap: number): ReadSession => {
    const startAt = cursor + gap;
    const endAt = startAt + 60_000;
    cursor = endAt;
    return session({ sessionId: `s${i}`, startAt, endAt });
  };
  const list = [
    s(0, 0),
    s(1, 4 * 60_000), // 4 分 → <5m
    s(2, 5 * 60_000), // 5 分 → 5–30m（边界进上界桶）
    s(3, 30 * 60_000), // 30 分 → 30m–2h
    s(4, 2 * 3_600_000), // 2h → 2h–6h
    s(5, 6 * 3_600_000), // 6h → >6h
    s(6, -10_000), // 重叠 → 按 0 → <5m
  ];
  const rows = gapBuckets(list);
  assert.deepEqual(rows.map((r) => r.count), [2, 1, 1, 1, 1]);
});

test('单次有效时长分桶：只统计目视会话，听书/自动不进', () => {
  const list = [
    session({ effectiveMs: 4 * 60_000 }),
    session({ effectiveMs: 5 * 60_000 }),
    session({ effectiveMs: 16 * 60_000 }),
    session({ effectiveMs: 40 * 60_000 }),
    session({ effectiveMs: 61 * 60_000 }),
    session({ effectiveMs: 30 * 60_000, mode: 'listen' }),
    session({ effectiveMs: 0 }),
  ];
  const rows = lengthBuckets(list);
  assert.deepEqual(rows.map((r) => r.count), [1, 1, 1, 1, 1]);
});

test('单书逐日曲线：按会话开始时刻（含时区）归日', () => {
  // 2026-11-08 17:00Z = 东八区 11-09 01:00 → 不同时区归到不同日
  const t = Date.UTC(2026, 10, 8, 17, 0);
  const list = [
    session({ startAt: t, effectiveMs: 600_000, tzOffsetMin: 480 }),
    session({ startAt: t, effectiveMs: 600_000, tzOffsetMin: 0 }),
    session({ startAt: t, effectiveMs: 900_000, mode: 'listen', tzOffsetMin: 480 }),
  ];
  assert.equal(dayKeyOf(t, 480), '2026-11-09');
  assert.equal(dayKeyOf(t, 0), '2026-11-08');

  const series = bookDailySeries(list, '2026-11-09', 2);
  assert.deepEqual(series, [
    { key: '2026-11-08', ms: 600_000 },
    { key: '2026-11-09', ms: 600_000 },
  ], '听书不计入；各自按自己的 tz 归日');
});

test('最近会话按开始时间降序', () => {
  const list = [
    session({ sessionId: 'a', startAt: 100 }),
    session({ sessionId: 'b', startAt: 300 }),
    session({ sessionId: 'c', startAt: 200 }),
  ];
  assert.deepEqual(recentSessions(list, 2).map((s) => s.sessionId), ['b', 'c']);
});
