/**
 * `#780` `/api/proxy` 的**上游响应头预算**（只算到「收到响应头」，不含响应体）。
 *
 * 用户 2026-11-05 第二轮拍板「融合方案」：
 *   · **图片类一律 10s** —— `cover=1`、正文图（浏览器 `<img>` 的 `Accept: image/*`）、
 *     `retry=1`（正文图点击重试）全部 10s；`cover=1&retry=1` 同样 10s；
 *   · **`range` 60s 不动**（区段/媒体直链首包本来慢，且与图片不是同一类）；
 *   · **普通非图片代理 20s 不动**（HTML/JS/JSON 等）；
 *   · **响应体预算是另一条线**（`imageDeadline`，见 index.ts），这里绝不改它。
 *
 * 为什么不给正文图单独加查询标记：`imgSrc()` 同时被「正文图（`<img>`）」与
 * 「音频中转（XHR/`new Audio`）」复用，硬加 `img=1` 会把长音频首包的预算也砍到 10s。
 * 浏览器对 `<img>` 必定发 `Accept: image/*`，用它判定「图片类」零改动且不会误伤音频。
 */
export const PROXY_HEADER_TIMEOUT_MS = {
  /** 图片类（封面 / 正文图 / 重试）统一 10s */
  image: 10_000,
  /** 普通非图片代理（既有行为，不动） */
  normal: 20_000,
  /** Range 区段/媒体（既有行为，不动） */
  range: 60_000,
} as const;

/**
 * 本次 `/api/proxy` 是否属于**图片类**请求。
 *
 * - `cover=1` / `retry=1`：显式图片语义（前端只有图片会用这两个参数）；
 * - 其余：看浏览器请求头 `Accept` 是否带 `image/`（`<img>` / CSS 背景图必带）。
 */
export function isImageProxyRequest(q: { cover?: unknown; retry?: unknown }, accept?: string): boolean {
  if (q.cover === '1' || q.retry === '1') return true;
  return /image\//i.test(accept ?? '');
}

export function proxyHeaderTimeoutMs(
  q: { cover?: unknown; retry?: unknown; image?: boolean },
  range: boolean,
): number {
  if (range) return PROXY_HEADER_TIMEOUT_MS.range;
  if (q.cover === '1' || q.retry === '1' || q.image === true) return PROXY_HEADER_TIMEOUT_MS.image;
  return PROXY_HEADER_TIMEOUT_MS.normal;
}
