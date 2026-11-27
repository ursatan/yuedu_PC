/**
 * `/api/proxy` **封面失败采样日志**（`#780` ③：只观测，零行为变化）。
 *
 * ## 为什么需要
 *
 * `#780` 现场（哔咔 40 封面固定 26 成功 / 14 失败）里，代理**不记录上游状态码**：
 *   · 4xx 会走 `[proxy] 上游 <status>，换 Referer 重试`（401/403/404 必留痕）；
 *   · 5xx → 502、429 → 原样透传，都**静默**；
 *   · 连接/响应头超时抛在请求调用处，只留 `PROXY_FAIL`、没有 status。
 * 于是「14 张到底是 404、429、5xx 还是超时」无法从日志判断（见
 * `docs/rounds/2026-11-05-02-pica-cover-mirror-780.md`）。
 *
 * 本模块只做一件事：**按 host 限速采样**一行结构化失败日志，补上缺失的状态维度。
 * 明确**不做**：不改重试策略、不调超时、不改响应。熔断计数由 `/api/proxy` 侧豁免
 * （`#780` 融合方案，`countBreaker:false`），本模块只在行尾打 `breaker=exempt` 标记，
 * 让日志能明确说明「这些封面失败没有喂给域名熔断」。
 *
 * ## 采样口径
 *
 * 每 host **每 60s 最多 5 条**（窗口内滑动）；超出的丢弃。图片洪峰时 40 张 / 秒
 * 也不会刷屏，但足以判断「这一批是 429 还是超时」。
 */

export interface CoverFailureInput {
  /** 目标主机（`URL.host`） */
  host: string;
  /** 上游 HTTP 状态码；连接/超时时拿不到 → undefined */
  status?: number;
  /** 是否超时（连接、响应头或响应体预算） */
  timedOut: boolean;
  /** 从进入 `/api/proxy` 到失败的耗时 */
  ms: number;
  /** 目标 URL（只用于截断后放进日志） */
  url: string;
}

export interface CoverFailureSamplerOptions {
  windowMs?: number;
  maxPerHost?: number;
  /** 注入口（单测用） */
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_HOST = 5;

/** 从 URL 取 host（IP、端口都保留）；不可解析 → 空串。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 失败是否属于「超时」一类。
 *
 * 覆盖：core 的 `BODY_DEADLINE`、undici 的 `UND_ERR_CONNECT_TIMEOUT` /
 * `UND_ERR_HEADERS_TIMEOUT` / `ETIMEDOUT`、AbortController（客户端断开不在此列 ——
 * 这里只判超时语义），以及中文兜底文案「请求超时 / 超时」。
 */
export function isTimeoutLikeError(e: unknown): boolean {
  const code = (e as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /TIMEOUT|DEADLINE/i.test(code)) return true;
  const msg = String((e as { message?: unknown } | undefined)?.message ?? e ?? '');
  return /TIMEOUT|超时|DEADLINE/i.test(msg);
}

export interface CoverFailureGateInput {
  /** 原始 `cover` 查询值（`req.query.cover`，只有字符串 `'1'` 才算封面请求） */
  cover: unknown;
  /** 上游 HTTP 状态码；连接/超时时拿不到 → undefined */
  status?: number;
  /** 是否走了抛错路径（连接失败 / 连接、响应头、响应体超时等） */
  hasError: boolean;
}

/**
 * 唯一判据：这次失败该不该进采样日志。
 *
 * - `cover≠1` → 一律不记（封面池之外的普通代理请求不进这个桶）；
 * - 拿得到状态码时只记 **≥400**（2xx/3xx 不是失败，不能因为「调用点恰好路过」就记）；
 * - 拿不到状态码时只在**抛错路径**才记（超时/连接失败）。
 *
 * 抽成纯函数是为了单测能锁住「2xx 不打印」与「cover≠1 不打印」两条。
 */
export function shouldNoteCoverFailure(input: CoverFailureGateInput): boolean {
  if (input.cover !== '1') return false;
  if (typeof input.status === 'number') return input.status >= 400;
  return input.hasError;
}

/** 一行（不含前缀）的稳定格式；字段顺序固定，便于 grep 与后续解析。 */
export function formatCoverFailure(input: CoverFailureInput): string {
  const status = typeof input.status === 'number' ? String(input.status) : '-';
  return (
    `[proxy-fail] host=${input.host || '-'} status=${status} timeout=${input.timedOut ? 1 : 0}` +
    ` cover=1 breaker=exempt ms=${Math.max(0, Math.round(input.ms))} u=${input.url.slice(0, 110)}`
  );
}

/** 按 host 的滑动窗口限速器；`note()` 返回要打印的行，被丢弃时返回 `null`。 */
export function createCoverFailureSampler(opts: CoverFailureSamplerOptions = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPerHost = opts.maxPerHost ?? DEFAULT_MAX_PER_HOST;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number[]>();

  return {
    note(input: CoverFailureInput): string | null {
      const key = input.host || '-';
      const t = now();
      const recent = (seen.get(key) ?? []).filter((at) => t - at < windowMs);
      recent.push(t);
      seen.set(key, recent);
      if (recent.length > maxPerHost) return null;
      return formatCoverFailure(input);
    },
  };
}

/** 进程级单例（`/api/proxy` 用）。 */
export const coverFailureSampler = createCoverFailureSampler();
