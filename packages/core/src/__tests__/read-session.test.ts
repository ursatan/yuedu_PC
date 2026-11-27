/**
 * 会话时段/跨日切片的回归锁（P1）。
 *
 * 全部用显式 UTC 构造 + 东八区 offset，避免测试机时区影响结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readDayKey,
  readTimeBucket,
  sliceSessionWindows,
} from '../user-store/read-session';

/** 东八区（+480）本地时间 → epoch ms */
const cst = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Date.UTC(y, m - 1, d, h - 8, min, 0, 0);
const TZ = 480;

test('切片：23:50 → 次日 00:10 按日拆分，总和精确', () => {
  const start = cst(2026, 11, 8, 23, 50);
  const end = cst(2026, 11, 9, 0, 10);
  const s = sliceSessionWindows(start, end, 1_200_000, 600_000, TZ);
  assert.deepEqual(
    s.map((x) => [x.day, x.bucket, x.totalMs, x.effectiveMs]),
    [
      ['2026-11-08', 'night', 600_000, 300_000],
      ['2026-11-09', 'dawn', 600_000, 300_000],
    ],
  );
});

test('切片：05:59–06:01 跨 dawn/morning', () => {
  const s = sliceSessionWindows(cst(2026, 11, 8, 5, 59), cst(2026, 11, 8, 6, 1), 120_000, 120_000, TZ);
  assert.deepEqual(s.map((x) => [x.bucket, x.totalMs]), [['dawn', 60_000], ['morning', 60_000]]);
});

test('切片：11:59–12:01 跨 morning/afternoon', () => {
  const s = sliceSessionWindows(cst(2026, 11, 8, 11, 59), cst(2026, 11, 8, 12, 1), 120_000, 90_000, TZ);
  assert.deepEqual(s.map((x) => [x.bucket, x.totalMs, x.effectiveMs]), [
    ['morning', 60_000, 45_000],
    ['afternoon', 60_000, 45_000],
  ]);
});

test('切片：17:59–18:01 跨 afternoon/night', () => {
  const s = sliceSessionWindows(cst(2026, 11, 8, 17, 59), cst(2026, 11, 8, 18, 1), 120_000, 120_000, TZ);
  assert.deepEqual(s.map((x) => [x.bucket, x.totalMs]), [['afternoon', 60_000], ['night', 60_000]]);
});

test('切片：非 6 小时整数比例也精确求和（四舍五入不丢毫秒）', () => {
  const start = cst(2026, 11, 8, 13, 17);
  const end = cst(2026, 11, 8, 21, 41);
  const total = 500_001;
  const s = sliceSessionWindows(start, end, total, 333_333, TZ);
  assert.equal(s.reduce((a, x) => a + x.totalMs, 0), total);
  assert.equal(s.reduce((a, x) => a + x.effectiveMs, 0), 333_333);
  assert.ok(s.every((x) => x.effectiveMs <= x.totalMs));
});

test('切片：effectiveMs 超过 totalMs 时被钳住；totalMs 超过墙钟跨度也被钳住', () => {
  const start = cst(2026, 11, 8, 10, 0);
  const end = start + 60_000;
  const s = sliceSessionWindows(start, end, 600_000, 900_000, TZ);
  assert.equal(s.reduce((a, x) => a + x.totalMs, 0), 60_000, 'totalMs 不得超过墙钟跨度');
  assert.equal(s.reduce((a, x) => a + x.effectiveMs, 0), 60_000, 'effectiveMs 不得超过 totalMs');
});

test('日期/时段工具：日键按传入 offset，而不是运行时时区', () => {
  const t = cst(2026, 11, 8, 7, 0);
  assert.equal(readDayKey(t, TZ), '2026-11-08');
  assert.equal(readDayKey(t, 0), '2026-11-07', '同一时刻在 UTC 仍是前一天 23:00');
  assert.equal(readTimeBucket(t, TZ), 'morning');
  assert.equal(readTimeBucket(t, 0), 'night');
});

test('切片：零时长会话返回空数组', () => {
  assert.deepEqual(sliceSessionWindows(cst(2026, 11, 8, 8), cst(2026, 11, 8, 8), 0, 0, TZ), []);
});
