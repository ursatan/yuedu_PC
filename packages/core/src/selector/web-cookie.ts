/**
 * `#410` `cookie.setWebCookie(url, cookie)` 的**唯一判据实现**（宿主 L1 与 worker 共用）。
 *
 * ## 上游语义（逐行核实，`CookieStore.kt:41-53`）
 * ```kotlin
 * fun setWebCookie(url: String, cookie: String) {
 *     val baseUrl = NetworkUtils.getBaseUrl(url) ?: return      // 解析不出 scheme://host 就静默 return
 *     val cookies = cookie.splitNotBlank(";")                   // 按 ; 切、**丢弃空白项**
 *     val cookieManager = android.webkit.CookieManager.getInstance()
 *     cookieManager.removeSessionCookies(null)                  // 先清会话 cookie
 *     cookies.forEach { cookieManager.setCookie(baseUrl, it) }  // 逐个写给**内置浏览器**
 * }
 * ```
 * 注意它**不落库**（落库的是另一个方法 `setCookie`），写的是 Android WebView 的 cookie 罐。
 *
 * ## 本仓的等价落点（**有意偏离，必须写清楚**）
 * 本仓没有 Android WebView。取**真正生效**的落点 = **源级 CookieStore**（`ctx.cookies`）：
 *   · 上游那条路只影响内置浏览器；本仓这一步同时影响后续所有请求（含 `java.ajax`）。
 *     这是**超集**，且是「给该源记住这个 cookie」在本仓唯一能生效的地方；
 *   · 判据（校验 + 拆分）与上游逐条对齐，**只在这里实现一次**，两侧各自写入自己的存储。
 *
 * ## 铁律 4（兜底必须留痕）
 * 上游 `?: return` 是**静默**的。我们保持「不写」的结果，但把原因**留痕**（`warnOnce` 由调用方做）。
 */
import type { CookieStore } from '../contract/engine';

/** `scheme://host[:port]`（对齐上游 `NetworkUtils.getBaseUrl`）；解析不出返回空串 */
export function baseUrlOf(url: unknown): string {
  const s = String(url ?? '').trim();
  if (!s) return '';
  // 上游允许源把 data URL 包成 `https://host@js:'data:...'`：`@js:` 之前那段才是传输主机
  const jsIdx = s.toLowerCase().indexOf('@js:');
  const head = jsIdx >= 0 ? s.slice(0, jsIdx) : s;
  const m = /^(https?):\/\/([^/?#\s]+)/i.exec(head);
  return m ? `${m[1]}://${m[2]}` : '';
}

/**
 * cookie 串 → 键值对（**去空白项**，对齐上游 `splitNotBlank(";")`）。
 * 与 `makeCookieStub` 的 `parsePairs` 是同一判据 —— 这里是唯一实现。
 */
export function parseCookiePairs(cookie: unknown): Array<[string, string]> {
  return String(cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const eq = s.indexOf('=');
      return eq < 0 ? ([s, ''] as [string, string]) : ([s.slice(0, eq).trim(), s.slice(eq + 1).trim()] as [string, string]);
    })
    .filter(([k]) => !!k);
}

export interface WebCookieResult {
  /** false = 判据没过（**没有写任何东西**），`reason` 供调用方留痕 */
  ok: boolean;
  reason?: 'BAD_URL' | 'EMPTY';
  pairs: Array<[string, string]>;
}

/** 校验 + 拆分（**不写任何存储**）—— 两侧各自把 `pairs` 写进自己的 store */
export function webCookiePairs(url: unknown, cookie: unknown): WebCookieResult {
  if (!baseUrlOf(url)) return { ok: false, reason: 'BAD_URL', pairs: [] };
  const pairs = parseCookiePairs(cookie);
  if (!pairs.length) return { ok: false, reason: 'EMPTY', pairs: [] };
  return { ok: true, pairs };
}

/** 便捷写法：直接把结果写进给定 CookieStore（L1 与 worker 的宿主分支都用它） */
export function applyWebCookie(cookies: CookieStore | undefined, url: unknown, cookie: unknown): WebCookieResult {
  const r = webCookiePairs(url, cookie);
  if (r.ok) for (const [k, v] of r.pairs) cookies?.set(k, v);
  return r;
}