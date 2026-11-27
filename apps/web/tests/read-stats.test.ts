/**
 * B1 阅读统计本地日桶的回归锁。全部用注入的假存储 + 显式日期，不依赖真实 localStorage。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_KEEP_DAYS,
  READ_STATS_KEY,
  VALID_DAY_MIN_SEC,
  addReadingMs,
  daySec,
  loadReadStats,
  localDayKey,
  recentDayRows,
  sumRecentDays,
  todaySec,
  validDayStreak,
  type ReadStatsStorage,
} from '../src/utils/read-stats';

function memStorage(initial?: string): ReadStatsStorage & { raw(): string | null } {
  let v = initial ?? null;
  return {
    getItem: () => v,
    setItem: (_k, next) => {
      v = next;
    },
    raw: () => v,
  };
}

/** 本地时间构造（不要用 UTC 字符串，否则日键会随东八区错位） */
function at(y: number, m: number, d: number, h = 12): Date {
  return new Date(y, m - 1, d, h, 0, 0, 0);
}

test('B1 日桶：毫秒落到本地日期，跨天各记各的', () => {
  const s = memStorage();
  addReadingMs(90_000, at(2026, 11, 5), s);
  addReadingMs(30_000, at(2026, 11, 6), s);
  const data = loadReadStats(s);
  assert.equal(data.days['2026-11-05'], 90);
  assert.equal(data.days['2026-11-06'], 30);
  assert.equal(daySec('2026-11-05', s), 90);
});

test('B1 日桶：不足 1 秒/非正数不落桶', () => {
  const s = memStorage();
  assert.equal(addReadingMs(400, at(2026, 11, 6), s), 0);
  assert.equal(addReadingMs(-5_000, at(2026, 11, 6), s), 0);
  assert.equal(addReadingMs(Number.NaN, at(2026, 11, 6), s), 0);
  assert.deepEqual(loadReadStats(s).days, {});
});

test('B1 近 N 天：含今天，且只统计窗口内', () => {
  const s = memStorage();
  for (let i = 0; i < 10; i += 1) {
    addReadingMs(60_000, new Date(2026, 10, 6 - i, 12), s);
  }
  assert.equal(todaySec(at(2026, 11, 6), s), 60);
  assert.equal(sumRecentDays(7, at(2026, 11, 6), s), 7 * 60);
  assert.equal(sumRecentDays(30, at(2026, 11, 6), s), 10 * 60);
});

test('B1 有效日门槛：sec > 60（恰好 60 秒不算）', () => {
  const s = memStorage();
  addReadingMs(60_000, at(2026, 11, 5), s);
  addReadingMs(61_000, at(2026, 11, 6), s);
  assert.equal(VALID_DAY_MIN_SEC, 60);
  assert.equal(recentDayRows(2, at(2026, 11, 6), s)[0]?.valid, false);
  assert.equal(recentDayRows(2, at(2026, 11, 6), s)[1]?.valid, true);
  assert.equal(validDayStreak(at(2026, 11, 6), s), 1, '昨天的 60 秒不算有效日 ⇒ 连续天数从今天起算');
});

test('B1 连续天数：今天未达门槛时从昨天往前数（0 点不塌）', () => {
  const s = memStorage();
  addReadingMs(120_000, at(2026, 11, 4), s);
  addReadingMs(120_000, at(2026, 11, 5), s);
  // 今天（11-06）还没读够 ⇒ 仍显示昨天为止的 2 天，而不是 0
  assert.equal(validDayStreak(at(2026, 11, 6, 0), s), 2);
  addReadingMs(70_000, at(2026, 11, 6), s);
  assert.equal(validDayStreak(at(2026, 11, 6, 23), s), 3, '今天补够后自然续上');
});

test('B1 连续天数：断档即停', () => {
  const s = memStorage();
  addReadingMs(120_000, at(2026, 11, 3), s);
  addReadingMs(120_000, at(2026, 11, 4), s);
  // 11-05 没读 ⇒ 11-06 的有效连续天数只能是 0
  assert.equal(validDayStreak(at(2026, 11, 6), s), 0);
});

test('B1 读回时逐字段白名单：坏 JSON / 坏键 / 坏值都丢弃', () => {
  const s = memStorage('{oops');
  assert.deepEqual(loadReadStats(s).days, {});

  const s2 = memStorage(
    JSON.stringify({
      v: 1,
      days: {
        '2026-11-06': 42,
        '2026-13-40': 999,
        make: 'x',
        '2026-11-05': -3,
        '2026-11-04': 12.7,
      },
    }),
  );
  assert.deepEqual(loadReadStats(s2).days, { '2026-11-06': 42, '2026-11-04': 12 });
});

test('B1 天数上限：只保留最近 400 个日键', () => {
  const s = memStorage();
  const days: Record<string, number> = {};
  for (let i = 0; i < MAX_KEEP_DAYS + 20; i += 1) {
    const d = new Date(2026, 10, 6 - i, 12);
    days[localDayKey(d)] = 30;
  }
  const raw = JSON.parse(s.getItem(READ_STATS_KEY) ?? 'null') as { days?: unknown } | null;
  // 先写进去（模拟旧版本留下的超长数据）
  assert.equal(raw, null);
  s.setItem(READ_STATS_KEY, JSON.stringify({ v: 1, days }));
  const loaded = loadReadStats(s);
  assert.equal(Object.keys(loaded.days).length, MAX_KEEP_DAYS + 20, '读取不裁剪（只做校验）');
  addReadingMs(61_000, at(2026, 11, 7), s);
  const after = loadReadStats(s);
  assert.equal(Object.keys(after.days).length, MAX_KEEP_DAYS, '写入时裁到上限');
  assert.equal(after.days['2026-11-07'], 61, '最新的今天必须保留');
});
