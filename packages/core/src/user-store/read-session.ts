/**
 * 阅读会话的**时段/跨日切片**（P1 纯函数，零依赖、可单测）。
 *
 * ## 为什么要在服务端切片
 * 会话流水只存 `start_at/end_at`（epoch ms）+ `tz_offset_min`。若按服务端本地时区切日，
 * 远端部署在不同时区时「今天」会与用户看到的日期错位 ⇒ 日键/时段一律用**会话自带的 offset**。
 *
 * ## 分配规则
 * 只知会话的 `total_ms` / `effective_ms` 总量，没有逐秒事件 ⇒ 按**墙钟重叠比例**分配到各切片，
 * 用累积取整保证「各切片之和 = 原总量」（不会因为四舍五入多几毫秒或少几毫秒）。
 *
 * 时段边界：`dawn 0–6 / morning 6–12 / afternoon 12–18 / night 18–24`（本地墙钟）。
 * 跨日也切（23:50–00:10 各记各的日键）。
 *
 * @see docs/ref/read-stats-system-feasibility-2026-11-08.md §3.3
 */
import type { ReadSession, ReadSessionMode, ReadTimeBucket } from '../contract/user-data';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BUCKET_MS = 6 * HOUR_MS;

/** 切片顺序与展示顺序一致 */
export const READ_TIME_BUCKETS: readonly ReadTimeBucket[] = ['dawn', 'morning', 'afternoon', 'night'];

export interface SessionSlice {
  /** 用户时区的日键 `YYYY-MM-DD` */
  day: string;
  bucket: ReadTimeBucket;
  totalMs: number;
  effectiveMs: number;
}

/** 把 epoch ms 换算成**用户时区**的日键（`tzOffsetMin` = `-Date#getTimezoneOffset()`，东八区 480） */
export function readDayKey(epochMs: number, tzOffsetMin: number): string {
  const d = new Date(epochMs + tzOffsetMin * MINUTE_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 时段桶（本地墙钟） */
export function readTimeBucket(epochMs: number, tzOffsetMin: number): ReadTimeBucket {
  const local = epochMs + tzOffsetMin * MINUTE_MS;
  const hour = Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
  if (hour < 6) return 'dawn';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'night';
}

/** 原始会话保留天数（D-7：一年；聚合表永久保留） */
export const READ_SESSION_KEEP_DAYS = 365;

const READ_SESSION_MODES = new Set<ReadSessionMode>(['visual', 'auto', 'listen']);

/** 字符串 → 会话模式的类型守卫（DB 读回用） */
export function isReadSessionMode(v: string): v is ReadSessionMode {
  return READ_SESSION_MODES.has(v as ReadSessionMode);
}

/** 非负整数兜底（外部输入可能缺字段/NaN/负数） */
const nonNegInt = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0;
};

/**
 * 校验并归一一条会话（两个存储实现共用）。
 *
 * 返回 `null` 表示**这条不写**（缺 `sessionId`/`bookUrl`、时间倒挂）——
 * 宁可不记，也不要写出一条聚合对不上的坏账。
 */
export function normalizeReadSession(s: ReadSession): ReadSession | null {
  if (!s || typeof s.sessionId !== 'string' || s.sessionId.trim() === '') return null;
  if (typeof s.bookUrl !== 'string' || s.bookUrl === '') return null;
  const startAt = nonNegInt(s.startAt);
  const endAt = nonNegInt(s.endAt);
  if (endAt < startAt) return null;
  const mode = READ_SESSION_MODES.has(s.mode) ? s.mode : 'visual';
  const totalMs = nonNegInt(s.totalMs);
  const effectiveMs = Math.min(totalMs, nonNegInt(s.effectiveMs));
  return {
    sessionId: s.sessionId.slice(0, 128),
    deviceId: String(s.deviceId ?? 'local').slice(0, 128),
    bookUrl: s.bookUrl,
    bookName: typeof s.bookName === 'string' ? s.bookName : '',
    bookAuthor: typeof s.bookAuthor === 'string' ? s.bookAuthor : '',
    chapterIndex: nonNegInt(s.chapterIndex),
    chapterTitle: typeof s.chapterTitle === 'string' ? s.chapterTitle : '',
    startAt,
    endAt,
    totalMs,
    effectiveMs,
    readWords: nonNegInt(s.readWords),
    readPageCount: nonNegInt(s.readPageCount),
    mode,
    startProgress: Number.isFinite(s.startProgress) ? s.startProgress : 0,
    endProgress: Number.isFinite(s.endProgress) ? s.endProgress : 0,
    tzOffsetMin: Number.isFinite(s.tzOffsetMin) ? Math.max(-840, Math.min(840, Math.round(s.tzOffsetMin))) : 480,
    createdAt: nonNegInt(s.createdAt) || startAt,
  };
}

const clamp = (v: number, lo: number, hi: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/** 切片在时间轴上的起止 → 按累积比例取整（保证总和精确） */
function alloc(total: number, from: number, to: number, span: number): number {
  if (span <= 0 || total <= 0) return 0;
  return Math.round((total * to) / span) - Math.round((total * from) / span);
}

/**
 * 把一个会话的 `[startAt, endAt]` 切成「按日 × 时段」的若干段。
 *
 * - `totalMs` 不会超过墙钟跨度（防上层传入异常值把小计撑爆）；
 * - `effectiveMs` 不会超过 `totalMs`（有效是总量的子集）；
 * - 跨时段/跨日都按墙钟比例分，各段之和精确等于传入总量。
 */
export function sliceSessionWindows(
  startAt: number,
  endAt: number,
  totalMs: number,
  effectiveMs: number,
  tzOffsetMin: number,
): SessionSlice[] {
  const span = endAt - startAt;
  const total = clamp(totalMs, 0, Math.max(0, span));
  const eff = clamp(effectiveMs, 0, total);
  if (span <= 0) {
    if (total <= 0) return [];
    return [{ day: readDayKey(startAt, tzOffsetMin), bucket: readTimeBucket(startAt, tzOffsetMin), totalMs: total, effectiveMs: eff }];
  }

  const shiftedStart = startAt + clamp(tzOffsetMin, -840, 840) * MINUTE_MS;
  const shiftedEnd = startAt + span + clamp(tzOffsetMin, -840, 840) * MINUTE_MS;
  // 对齐到 6 小时网格（0/6/12/18 点就是桶边界）
  let cursor = Math.floor(shiftedStart / BUCKET_MS) * BUCKET_MS;
  const out: SessionSlice[] = [];
  while (cursor < shiftedEnd) {
    const segStart = Math.max(cursor, shiftedStart);
    const segEnd = Math.min(cursor + BUCKET_MS, shiftedEnd);
    if (segEnd > segStart) {
      const from = segStart - shiftedStart;
      const to = segEnd - shiftedStart;
      const t = alloc(total, from, to, span);
      const e = alloc(eff, from, to, span);
      if (t > 0 || e > 0) {
        const hour = Math.floor((((cursor % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
        const bucket: ReadTimeBucket =
          hour < 6 ? 'dawn' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'night';
        out.push({
          day: readDayKey(cursor, 0),
          bucket,
          totalMs: t,
          effectiveMs: e,
        });
      }
    }
    cursor += BUCKET_MS;
  }
  return out;
}
