/**
 * 阅读统计 P2 的**纯计算层**（A1–A7 / B1 用）。
 *
 * 输入只有服务端快照 `ReadStatsSnapshot` 的 `days` / `books`，以及只读会话流水的
 * `ReadSession[]`；所有函数不碰 DOM、不读时钟（日期/时区都从入参来），便于单测。
 *
 * 口径沿用已拍板的 P1（见 `docs/ref/read-stats-system-feasibility-2026-11-08.md`）：
 *  · 「有效」= `effective_ms`（目视）；`total_ms` 是前台在线（含听书/自动段）；
 *  · 日期键一律是**用户时区**的 `YYYY-MM-DD`（服务端已按会话 tz 切好，前端只做运算）；
 *  · 会话流水的日归属按**会话开始时刻**（下钻曲线会标注这一点，不与主图切片口径混用）。
 */
import type { BookReadStat, ReadSession, UserReadStat } from '@yuedu/core/contract';

export type PeriodKey = 'dawn' | 'morning' | 'afternoon' | 'night';

export const PERIOD_KEYS: readonly PeriodKey[] = ['dawn', 'morning', 'afternoon', 'night'];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  dawn: '凌晨',
  morning: '上午',
  afternoon: '下午',
  night: '晚上',
};

/** 一周从**周一**开始（中文习惯）；index 0 = 周一 … 6 = 周日 */
export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/** 一个日期窗口（含端点）的四类累计 */
export interface StatWindow {
  totalMs: number;
  effectiveMs: number;
  listenMs: number;
  autoMs: number;
  sessionCount: number;
}

export interface WeekdayPeriodRow {
  index: number;
  label: string;
  totalMs: number;
  cells: Record<PeriodKey, number>;
}

export interface AuthorRow {
  author: string;
  effectiveMs: number;
  bookCount: number;
}

export interface BucketRow {
  key: string;
  label: string;
  count: number;
}

export interface DayPoint {
  key: string;
  ms: number;
}

/* ------------------------------------------------------------------ *
 * 日期键运算（用 UTC 做日历加减，避免夏令时把某天算成 23/25 小时）
 * ------------------------------------------------------------------ */

/** `YYYY-MM-DD` 加减天数 */
export function addDayKey(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** 浏览器本地时区的今天（与服务端日键同一日历语义） */
export function localDayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日期键 → 周一为 0 的星期序号（纯日历运算，不受运行时时区影响） */
export function weekdayIndexOf(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  const sundayFirst = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

/** epoch ms + 会话自带时区 → 日期键（下钻曲线按会话开始日归属） */
export function dayKeyOf(epochMs: number, tzOffsetMin: number): string {
  const shifted = new Date(epochMs + tzOffsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* ------------------------------------------------------------------ *
 * A1 / A2：窗口累计与环比
 * ------------------------------------------------------------------ */

/** 取 `[endKey-(count-1), endKey]` 内按日累计（日键是 ISO 字符串，可直接比较） */
export function windowStats(days: UserReadStat[], endKey: string, count: number): StatWindow {
  const start = addDayKey(endKey, -(Math.max(1, count) - 1));
  const out: StatWindow = { totalMs: 0, effectiveMs: 0, listenMs: 0, autoMs: 0, sessionCount: 0 };
  for (const d of days) {
    if (d.day < start || d.day > endKey) continue;
    out.totalMs += d.totalMs;
    out.effectiveMs += d.effectiveMs;
    out.listenMs += d.listenMs;
    out.autoMs += d.autoMs;
    out.sessionCount += d.sessionCount;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A3：星期 × 四时段
 * ------------------------------------------------------------------ */

/** 把「日 × 四桶」折叠成「星期 × 四桶」（范围由调用方筛好后传入） */
export function weekdayPeriodRows(days: UserReadStat[]): WeekdayPeriodRow[] {
  const rows: WeekdayPeriodRow[] = WEEKDAY_LABELS.map((label, index) => ({
    index,
    label,
    totalMs: 0,
    cells: { dawn: 0, morning: 0, afternoon: 0, night: 0 },
  }));
  for (const d of days) {
    const row = rows[weekdayIndexOf(d.day)];
    row.totalMs += d.effectiveMs;
    row.cells.dawn += d.dawnMs;
    row.cells.morning += d.morningMs;
    row.cells.afternoon += d.afternoonMs;
    row.cells.night += d.nightMs;
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * A5：最长连续有效日
 * ------------------------------------------------------------------ */

/**
 * 最长连续「有效日」（单日 effective > `minMs`）。
 * 只数连续日期；中间缺一天（无记录）即断。
 */
export function longestValidStreak(days: UserReadStat[], minMs: number): number {
  const valid = days
    .filter((d) => d.effectiveMs > minMs)
    .map((d) => d.day)
    .sort();
  let best = 0;
  let run = 0;
  let prev = '';
  for (const key of valid) {
    run = prev && addDayKey(prev, 1) === key ? run + 1 : 1;
    prev = key;
    if (run > best) best = run;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * A6：按书 × 时段
 * ------------------------------------------------------------------ */

/** 一本书四时段的毫秒（只含目视有效，服务端已保证） */
export function bookPeriodMs(b: BookReadStat): Record<PeriodKey, number> {
  return { dawn: b.dawnMs, morning: b.morningMs, afternoon: b.afternoonMs, night: b.nightMs };
}

/** 最常读时段；四桶全 0 返回 `null` */
export function dominantPeriod(ms: Record<PeriodKey, number>): PeriodKey | null {
  let best: PeriodKey | null = null;
  let max = 0;
  for (const k of PERIOD_KEYS) {
    if (ms[k] > max) {
      max = ms[k];
      best = k;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * A7：常读作者
 * ------------------------------------------------------------------ */

/** 作者聚合（同作者多本书合并）；空作者不计，按目视有效降序 */
export function authorRows(books: BookReadStat[], limit = 5): AuthorRow[] {
  const map = new Map<string, AuthorRow>();
  for (const b of books) {
    const author = b.author.trim();
    if (!author) continue;
    const row = map.get(author) ?? { author, effectiveMs: 0, bookCount: 0 };
    row.effectiveMs += b.effectiveMs;
    row.bookCount += 1;
    map.set(author, row);
  }
  return [...map.values()]
    .sort((a, b) => b.effectiveMs - a.effectiveMs || a.author.localeCompare(b.author))
    .slice(0, Math.max(1, limit));
}

/* ------------------------------------------------------------------ *
 * B1：会话节奏（间隔 / 单次时长）
 * ------------------------------------------------------------------ */

/**
 * 相邻两次阅读的间隔（`下一次开始 - 上一次结束`，负值按 0 处理）。
 *
 * 说明：跨夜/跨天的长间隔也会进「> 6 小时」桶 —— 这是阅读节奏的一部分，
 * 不额外裁剪；会话流水保留 365 天（D-7），样本量足够。
 */
export function gapBuckets(sessions: ReadSession[]): BucketRow[] {
  const sorted = [...sessions].sort((a, b) => a.startAt - b.startAt);
  const rows: BucketRow[] = [
    { key: 'lt5m', label: '< 5 分钟', count: 0 },
    { key: '5m30m', label: '5–30 分钟', count: 0 },
    { key: '30m2h', label: '30 分钟–2 小时', count: 0 },
    { key: '2h6h', label: '2–6 小时', count: 0 },
    { key: 'gt6h', label: '> 6 小时', count: 0 },
  ];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = Math.max(0, sorted[i].startAt - sorted[i - 1].endAt);
    if (gap < 5 * 60_000) rows[0].count += 1;
    else if (gap < 30 * 60_000) rows[1].count += 1;
    else if (gap < 2 * 3_600_000) rows[2].count += 1;
    else if (gap < 6 * 3_600_000) rows[3].count += 1;
    else rows[4].count += 1;
  }
  return rows;
}

/** 单次目视有效时长分布（只看 `mode='visual'` 且 >0 的会话） */
export function lengthBuckets(sessions: ReadSession[]): BucketRow[] {
  const rows: BucketRow[] = [
    { key: 'lt5m', label: '< 5 分钟', count: 0 },
    { key: '5m15m', label: '5–15 分钟', count: 0 },
    { key: '15m30m', label: '15–30 分钟', count: 0 },
    { key: '30m60m', label: '30–60 分钟', count: 0 },
    { key: 'gt60m', label: '> 60 分钟', count: 0 },
  ];
  for (const s of sessions) {
    if (s.mode !== 'visual' || s.effectiveMs <= 0) continue;
    if (s.effectiveMs < 5 * 60_000) rows[0].count += 1;
    else if (s.effectiveMs < 15 * 60_000) rows[1].count += 1;
    else if (s.effectiveMs < 30 * 60_000) rows[2].count += 1;
    else if (s.effectiveMs < 60 * 60_000) rows[3].count += 1;
    else rows[4].count += 1;
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * B2：单书下钻
 * ------------------------------------------------------------------ */

/**
 * 一本书逐日目视有效（按**会话开始时刻**归日）。
 *
 * 与主图不同：主图读服务端的切片聚合（跨日会话会拆到两天）；下钻只有原始行，
 * 为避免前端重写一套切片算法，这里按开始日整段归属，并在界面标注。
 */
export function bookDailySeries(
  sessions: ReadSession[],
  endKey: string,
  count: number,
): DayPoint[] {
  const out: DayPoint[] = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push({ key: addDayKey(endKey, -i), ms: 0 });
  const index = new Map(out.map((p) => [p.key, p]));
  for (const s of sessions) {
    if (s.mode !== 'visual' || s.effectiveMs <= 0) continue;
    const key = dayKeyOf(s.startAt, s.tzOffsetMin);
    const p = index.get(key);
    if (p) p.ms += s.effectiveMs;
  }
  return out;
}

/** 最近会话（开始时间降序） */
export function recentSessions(sessions: ReadSession[], limit = 8): ReadSession[] {
  return [...sessions].sort((a, b) => b.startAt - a.startAt).slice(0, Math.max(1, limit));
}
