/**
 * `/api/proxy` 的 **上游状态码 → 代理响应状态码** 判定（抽成纯函数以便回归锁定）。
 *
 * ## 为什么需要（`#378` 缺陷类别）
 *
 * 旧实现是「`res.status >= 400` **一律** `reply.code(502)`」。这是一个**类别错误**：
 * 502 的语义是「网关/代理自己没从上游拿到有效响应」（中介故障），而 **4xx 是上游
 * 成功回应了、只是明确拒绝**。把拒伪装成故障，会让**读状态码的调用方**做出错误判断。
 *
 * 真实案例（2026-10-09，momoa.cc.cd「阅读 · 全版本汇总」）：
 *   页内「测试版」卡片由 JS `fetch('https://api.github.com/repos/<o>/<r>/releases/...')`
 *   直连取得（iframe 内经 NET 桥改写到本路由）。GitHub **未认证 API 限流 60 次/小时/IP**
 *   （实测 `remaining:5, used:55`），而页面一次加载要拉 ~10 仓库 × 2 类（stable+beta）
 *   ≈ 20+ 次 ⇒ 几分钟打满 ⇒ 上游回 **403**（`x-ratelimit-remaining: 0`）。
 *   旧行为把它包成 502 ⇒ 站点脚本 `if(!res.ok) throw new Error('HTTP '+res.status)`
 *   显示「⚠️ 获取失败 HTTP 502」（文案属站点，状态码来自我们）。
 *   **「上午能加载、下午又 502」= 限流重置 ↔ 耗尽**，不是站点故障。
 *
 * ## 规则
 *
 * - **4xx**：**原样透传**（`403` 就回 403、`404` 就回 404、`429` 就回 429）。
 *   调用方能识别「限流 / 防盗链 / 不存在」等语义；诊断头（`Retry-After`、
 *   `X-RateLimit-*`）与正文一并回传。
 * - **5xx**：仍回 **502**（真正的中介故障 —— 上游自己坏了，我们没拿到有效响应）。
 * - **< 400**：正常透传（调用方按 200/206 等处理）。
 *
 * ## 为什么这对既有场景安全
 *
 * 图片/媒体代理的消费方是 `<img>` / `<video>` / `<audio>`，它们**只关心能否解码**，
 * 不读状态码；而脚本类调用方（本 case）恰恰**需要**看到真实状态码。故透传是净收益。
 */

/** 代理对上游状态码采取的动作 */
export type ProxyStatusAction = 'pass' | 'passthrough-4xx' | 'gateway-502';

/**
 * 判定 `/api/proxy` 对一个上游状态码应采取的动作。
 *
 * @param upstreamStatus 上游返回的 HTTP 状态码
 */
export function proxyStatusAction(upstreamStatus: number): ProxyStatusAction {
  if (upstreamStatus >= 500) return 'gateway-502';
  if (upstreamStatus >= 400) return 'passthrough-4xx';
  return 'pass';
}

/**
 * 上游 4xx 是否属于**限流**（换 UA / 换 Referer 都无用，只能等窗口重置）。
 *
 * 判据（两选一，任一成立即可）：
 *   · `429 Too Many Requests`（RFC 6585 的标准限流码）；
 *   · 声明 `x-ratelimit-remaining: 0`（GitHub 等用 403 + 该头表达「配额耗尽」，
 *     与防盗链的 403 无法仅凭状态码区分 —— 故**必须**读头）。
 *
 * ⚠️ 判据必须**唯一**：换 Referer 阶梯与换 UA 兜底两处都要用，各写一遍必然漂移。
 *
 * @param upstreamStatus 上游状态码
 * @param headers 上游响应头（大小写不敏感；取值只看 string）
 */
export function isRateLimited(
  upstreamStatus: number,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (upstreamStatus === 429) return true;
  const raw = headers['x-ratelimit-remaining'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === '0';
}

/**
 * **值得换 UA 重试**的上游状态码（`#367` 蓝奏云 + `#378` 扩展）。
 *
 * - `400`：蓝奏云 WAF 按 UA 分流（手机 UA 被赶到 lanzoum → 400；桌面 UA 200）。
 * - `403` / `429`：WAF「UA 不在允许列表」的常见表达（GitHub 无 UA 即 403
 *   `Request forbidden by administrative rules`）。**限流除外**（见 {@link isRateLimited}）。
 */
export const UA_RETRY_STATUS: ReadonlySet<number> = new Set([400, 403, 429]);
