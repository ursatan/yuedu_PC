/**
 * B1 阅读统计 · **前端本地日桶**（用户 2026-11-06 拍板：不进服务端、不上云）。
 *
 * ## 为什么用 localStorage 而不是 IndexedDB
 * 存的是「一天一个秒数」：365 天 ≈ 7KB（实测每行 `"YYYY-MM-DD":123,` 约 19 字节），
 * 一年也远没到 localStorage 的 5MB 量级。收益上，UI 打开时要**同步**算今日/近 N 天/连续天数，
 * localStorage 的同步读一行就能拿到；IDB 只多出异步 API、版本升级与事务样板，没有任何好处。
 * 另外本仓的阅读偏好、pending 时长本来就是 localStorage —— 不引入第二种本地持久化形态。
 *
 * ## 口径（与看板文案必须一致）
 * · **本地时区**的日键（`YYYY-MM-DD`），跨午夜按「结算时刻」归日（结算粒度 ≤15s，误差不会跨天）；
 * · **自动滚动 / 朗读（听书）都不计时** —— 由调用方（`ReaderOverlay`）在计时器里门控，
 *   本模块只负责「收到多少秒就记多少秒」，不做业务判断；
 * · 单日 **sec > 60** 才算「有效日」（连续天数用这个门槛）；
 * · 历史总额不在这里 —— 那仍是服务端按书名累计的 `read-records`（旧数据不能抹掉）。
 *
 * ## 健壮性
 * localStorage 是**外部输入**（控制台手改/旧版本残留/配额已满都可能）⇒ 读取时逐条白名单校验，
 * 写入失败静默（统计不该让阅读页报错）。保留 400 天，超出按日键升序裁掉最老的。
 */

export interface ReadStatsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReadStatsData {
  /** 数据结构版本（将来换存储形态时用；目前只有 1） */
  v: 1;
  /** 本地日期 → 当天阅读秒数（整数） */
  days: Record<string, number>;
}

/** localStorage 键名（清缓存/换浏览器即丢 —— 看板里如实说明） */
export const READ_STATS_KEY = 'yuedu.readStats.v1';
/** 单日「有效日」门槛：严格大于 60 秒（用户 2026-11-06 拍板） */
export const VALID_DAY_MIN_SEC = 60;
/** 最多保留 400 天（防止 JSON 无限增长；年度回顾绰绰有余） */
export const MAX_KEEP_DAYS = 400;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 键必须是**真实存在的本地日期**（`2026-13-40` 这种格式合法但日历非法，同样丢弃） */
function isValidDayKey(k: string): boolean {
  if (!DAY_KEY_RE.test(k)) return false;
  const [y, m, d] = k.split('-').map(Number);
  return localDayKey(new Date(y as number, (m as number) - 1, d as number, 12)) === k;
}

/** 测试注入用；不传就取浏览器 localStorage（不存在/被禁 ⇒ null） */
function storageOrNull(s?: ReadStatsStorage): ReadStatsStorage | null {
  if (s) return s;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 本地时区的日键（不要用 `toISOString()` —— 那会按 UTC 切日，东八区早 8 点前会记到前一天） */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function loadReadStats(s?: ReadStatsStorage): ReadStatsData {
  const st = storageOrNull(s);
  if (!st) return { v: 1, days: {} };
  try {
    const raw = st.getItem(READ_STATS_KEY);
    if (!raw) return { v: 1, days: {} };
    const parsed = JSON.parse(raw) as { days?: unknown } | null;
    const src = parsed && typeof parsed === 'object' ? parsed.days : null;
    const days: Record<string, number> = {};
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (isValidDayKey(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) {
          days[k] = Math.floor(v);
        }
      }
    }
    return { v: 1, days };
  } catch {
    return { v: 1, days: {} };
  }
}

function pruneOldDays(days: Record<string, number>): void {
  const keys = Object.keys(days).sort();
  const extra = keys.length - MAX_KEEP_DAYS;
  for (let i = 0; i < extra; i += 1) delete days[keys[i] as string];
}

export function saveReadStats(data: ReadStatsData, s?: ReadStatsStorage): void {
  const st = storageOrNull(s);
  if (!st) return;
  const days: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.days)) {
    if (isValidDayKey(k) && Number.isFinite(v) && v > 0) days[k] = Math.floor(v);
  }
  pruneOldDays(days);
  try {
    st.setItem(READ_STATS_KEY, JSON.stringify({ v: 1, days }));
  } catch {
    /* 配额满 / 隐私模式：统计是锦上添花，不能把阅读页带崩 */
  }
}

/**
 * 记一段阅读时长（毫秒）。返回实际落桶的秒数（不足 1 秒的部分丢弃，调用方 15s 结算一次，误差可忽略）。
 * `at` 是**结算时刻**，决定这笔账记在哪一天。
 */
export function addReadingMs(ms: number, at: Date = new Date(), s?: ReadStatsStorage): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const sec = Math.floor(ms / 1000);
  if (sec <= 0) return 0;
  const data = loadReadStats(s);
  const k = localDayKey(at);
  data.days[k] = (data.days[k] ?? 0) + sec;
  saveReadStats(data, s);
  return sec;
}

/** 某一天的秒数（键不存在 = 0） */
export function daySec(dayKey: string, s?: ReadStatsStorage): number {
  return loadReadStats(s).days[dayKey] ?? 0;
}

export function todaySec(now: Date = new Date(), s?: ReadStatsStorage): number {
  return daySec(localDayKey(now), s);
}

/** 以「本地正午」为锚做日期加减（正午不受夏令时/时区跳变影响） */
function shiftDay(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta, 12, 0, 0, 0);
}

/** 最近 n 天的日键（**最老 → 最新**，最后一个是今天） */
export function recentDayKeys(n: number, now: Date = new Date()): string[] {
  const cnt = Math.max(0, Math.floor(n));
  const out: string[] = [];
  for (let i = cnt - 1; i >= 0; i -= 1) out.push(localDayKey(shiftDay(now, -i)));
  return out;
}

/** 最近 n 天（含今天）的合计秒数 */
export function sumRecentDays(n: number, now: Date = new Date(), s?: ReadStatsStorage): number {
  const data = loadReadStats(s);
  let total = 0;
  for (const k of recentDayKeys(n, now)) total += data.days[k] ?? 0;
  return total;
}

/** 全部本地日桶合计（仅作参考，不是「历史总额」——后者在服务端） */
export function totalRecordedSec(s?: ReadStatsStorage): number {
  const data = loadReadStats(s);
  let total = 0;
  for (const v of Object.values(data.days)) total += v;
  return total;
}

/**
 * 连续有效日（`sec > 60` 才算一天）。
 *
 * 今天还没到门槛时**从昨天往前数**——否则每天 0 点一过，昨天辛苦攒的连续天数会先变 0，
 * 等读到 61 秒才跳回来，看起来像数据丢了。今天补够了自然会把今天续上。
 */
export function validDayStreak(now: Date = new Date(), s?: ReadStatsStorage): number {
  const data = loadReadStats(s);
  let cursor = shiftDay(now, 0);
  const secOf = (d: Date): number => data.days[localDayKey(d)] ?? 0;
  if (secOf(cursor) <= VALID_DAY_MIN_SEC) cursor = shiftDay(cursor, -1);
  let n = 0;
  while (secOf(cursor) > VALID_DAY_MIN_SEC) {
    n += 1;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

export interface ReadStatsDayRow {
  key: string;
  sec: number;
  /** 当天是否达到「有效日」门槛（`> 60` 秒） */
  valid: boolean;
}

/** 最近 n 天的明细行（**最老 → 最新**），给看板画柱状图用 */
export function recentDayRows(n: number, now: Date = new Date(), s?: ReadStatsStorage): ReadStatsDayRow[] {
  const data = loadReadStats(s);
  return recentDayKeys(n, now).map((key) => {
    const sec = data.days[key] ?? 0;
    return { key, sec, valid: sec > VALID_DAY_MIN_SEC };
  });
}
