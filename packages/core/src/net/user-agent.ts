/**
 * `#643` **出口请求的默认 User-Agent**。
 *
 * ## 为什么必须有（上游语义）
 * Legado 的三条出口都**自带浏览器 UA**，源作者写规则时默认「对面看到的是浏览器」：
 * · `java.get / post / head / connect` —— 上游 `help/JsExtensions.kt:629-658` 走的是
 *   **`Jsoup.connect(urlStr)`**，而 jsoup 的 `HttpConnection.Request` 在构造时就把
 *   `User-Agent` 初始化成 `HttpConnection.DEFAULT_UA`（浏览器串），源只传自己的头时也**不会**丢掉它；
 * · `java.ajax` —— 上游 `AnalyzeUrl` 会补 `source.getUserAgent()`（缺省是 App 的浏览器 UA）。
 *
 * 我们移植时把「头」当成「源给什么就发什么」⇒ 源没写 UA 时，undici 会填
 * **`user-agent: node`**。2026-10-26 实测（`#643` uu书库 `www.uushuk.com` 目录翻页）：
 * 同一份 POST 体、同一个 Referer，只换 UA 就得到两种完全不同的响应 ——
 * ```
 * UA=Chrome/131 → 307  Location: /WAF/VERIFY/CAPTCHA?…
 * 无 UA / node  → 403  {"code":-1,"msg":"Error","data":[]}（35 字节）
 * ```
 * 后者既没有重定向、也没有挑战页特征 ⇒ 撞盾判据**一格都进不去**，引擎只能当「目录就这么多章」。
 *
 * ## 边界
 * 只补**缺省**：源（或调用方）显式给了 `User-Agent` 就一字不改 —— 这与 jsoup
 * 「`header()` 可覆盖默认值」的语义一致。大小写不敏感匹配，因为 HTTP 头名不区分大小写，
 * 而源里 `user-agent` / `User-Agent` 两种写法都有。
 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * 给一组出口头补默认 UA（已显式给出则原样返回同一个对象，便于调用方继续复用/比对）。
 * 注意：返回新对象，不修改入参 —— 入参可能是源规则的共享对象，就地改会污染下一次请求。
 */
export function withDefaultUserAgent<T extends Record<string, string> | undefined>(
  headers: T,
): Record<string, string> {
  const h = (headers ?? {}) as Record<string, string>;
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === 'user-agent') return h;
  }
  return { ...h, 'User-Agent': DEFAULT_UA };
}
