/**
 * `#561`/`#562` **自取数规则与挑战页判据** —— 零依赖叶子模块。
 *
 * 为什么是叶子：`isSelfFetchingRule` 原在 `diag/explore-probe.ts`（它拖着一整条 probe 链：
 * AnalyzeRule / jsdom / worker），而 **Web 前端**（规则工坊）也要用同一份判据
 * —— 前端只能 import 窄子路径（主出口连着 `node:*`，进浏览器 bundle 会炸 build，
 * 见 `HighlightRuleEditDialog.vue` 对 `@yuedu/core/highlight-rule-matcher` 的同款处理）。
 * 判据写两处必然漂移（`#158`/`#313` 的老教训）⇒ 拆叶子，两端共用。
 */

/**
 * `#559` 判定「自取数列表规则」：JS 形态 + 出现网络调用。
 *
 * 判据故意宽松：`java.ajax` / `java.get` / `java.post` / `java.connect` 之外还认
 * `fetch(`/`XMLHttpRequest`（极少数源这么写）。**只用于文案与「要不要继续跑」**，
 * 不用于决定语义 —— 真跑永远走引擎同一份 `AnalyzeRule`。
 */
export function isSelfFetchingRule(rule: string): boolean {
  const r = String(rule ?? '');
  if (!/^\s*(<js>|@js:)/i.test(r)) return false;
  return /java\.(?:ajax|get|post|connect)\s*\(|\bfetch\s*\(|XMLHttpRequest/.test(r);
}

/**
 * `#561` **自取数规则的试跑占位内容**。
 *
 * 自取数 JS 不读页面内容（它自己发请求），但探针不接受空内容（空 = 「没给物料」）。
 * 三处消费方（字段试跑 / 发现试跑 / 物料链）必须用**同一份**占位，否则日志里
 * 分不清「用户粘的一页」和「自取数占位」。
 */
export const SELF_FETCH_PLACEHOLDER = '<!-- self-fetch: 本规则自行请求接口，页面内容不参与求值 -->';

/**
 * 挑战页特征（按可辨识度排序；命中即算，不追求全）。
 *
 * ⚠️ 只收**足够特异**的特征：泛化的中文词（「安全验证」「人机验证」）在普通站点
 * （登录页的验证码输入框、安全中心文案）里到处都是 ⇒ 收进来会让「已经过盾的正文」
 * 被误判成挑战页 —— 138阅读网实测踩过：过盾后的正文里仍残留 CF 的脚本引用。
 */
const CHALLENGE_SIGNATURES: { via: string; re: RegExp; maxLen?: number }[] = [
  { via: '__sc_clearance（网站安全校验）', re: /__sc_clearance/i },
  { via: '「正在检查您的浏览器」', re: /正在检查您的浏览器|checking your browser/i },
  /**
   * `#662` `turnstile` 单独拎出来并配体积门：`challenges.cloudflare.com/turnstile/v0/api.js`
   * 是**正常页面**（登录/评论组件）也常引的脚本；只有「整个页面就是 Turnstile 校验」时才算挑战页
   * —— 那种页面很小（2~6KB）。旧写法把它并进硬特征里 ⇒ Aff 84KB 正常页被误判。
   */
  { via: 'Cloudflare Turnstile 校验页', re: /turnstile/i, maxLen: 20000 },
  { via: 'Cloudflare（Just a moment）', re: /just a moment|cf-browser-verification|cf_chl_/i },
  /**
   * `#662` **必须配体积门**：`ddos-guard` / `challenge-platform` 这类字样会出现在**正常页面**
   * 的脚本引用里（站点全站挂了 DDoS-Guard 或 Turnstile 组件）——用户实测 Aff 的分类页
   * **84KB、正文页 200KB+** 都被判成「DDoS-Guard 拦截页」⇒ 引擎以为每次都在撞盾，
   * 于是一个请求接一个请求去「过闸」，日志刷屏、还反复弹验证窗。
   * 真正的挑战页只有 2~6KB；用 `maxLen` 把「大页面里的脚本引用」排除掉。
   */
  { via: 'DDoS-Guard / captcha 拦截页', re: /ddos-guard|ddos guard|_ddg_|captcha-delivery|challenge-platform/i, maxLen: 20000 },
  { via: '人机校验页', re: /verify you are human|verify that you are human|are you a robot/i },
  /**
   * `#642` **Cloudflare 硬拦截页**（不是 JS 挑战，是「不放行」那种）。
   *
   * 实测形态（顶点小说 `m.terry-haass.com` 一类）：状态码是 **404/1020**，页面既没有
   * `Just a moment` 也没有 `challenge-platform`，只有 `Attention Required!` +
   * `Ray ID` + `cf-error-details`（1020 = Access Denied，1015 = Rate Limited）。
   * 旧判据完全不认 ⇒ 引擎把它当普通页面解析 ⇒ **静默 0 条**（`#11` 立案的正是这个）。
   *
   * ★ 仍然只收**高特异**特征：`attention required` / `cf-error-details` / `error 102x`
   *   不会出现在正常正文里；不用泛化的 `cloudflare` 字样（CF 前置站点的**成功页**里
   *   到处都有它，会反向误判 —— `#564` 踩过）。
   */
  { via: 'Cloudflare 拦截页（Attention Required / 1020）', re: /attention required|cf-error-details|error 10(?:15|20)\b/i },
  { via: '「请开启 JavaScript 与 Cookie」闸页', re: /enable javascript and cookies to continue/i },
  /**
   * `#643` **站点自带 WAF 的人机验证页**（uu书库 `www.uushuk.com` 实测）。
   *
   * 形态：目录翻页 POST 被 **307** 到 `/WAF/VERIFY/CAPTCHA?info=…`，该页 `<title>Verify Yourself</title>`
   * + 一堆 captcha 脚本。（注意：该验证页对 POST 只回 35 字节 JSON 错误信封，
   * 所以**状态码那条链永远命中不了**，`hub.ts` 另有「最终 URL 落在 waf/verify 路径」的判据。）
   *
   * 把 `verify yourself` 收进内容表的价值在**渲染之后**：`antibotReplay` 渲回来的 HTML
   * 就是这个验证页，`tryReplay` 里的 `isChallengePage(hit.html, via)` 复查靠它判定「还没过盾」。
   *
   * ★ 只收这一句完整短语：`verify yourself` / `verify you are human` 都是验证页标题的
   *   **完整措辞**，正常正文里不会出现（对比：不能收裸 `verify`）。
   */
  { via: 'WAF 人机验证页（Verify Yourself）', re: /verify yourself/i },
  /**
   * `#731` **阿里云 WAF 人机验证页**（用户实测：`401` + 1055 字节挑战页）。
   *
   * 形态：引擎请求回 **401**，页面里是 `__wafcaptcha` / `acw_sc__v2` / `aliyungf_tc`
   * 这类阿里云 WAF 专有 cookie/JS 名，正文还有「访问频率太高」「请输入验证码」。
   * 旧判据（403/503 弱词 / CF 强特征）一条都不命中 ⇒ 挑战页被当正文 ⇒ 列表静默 0 条。
   *
   * ★ 体积门：WAF 人机页很小（实测 1KB 级）；「请输入验证码」单看会误伤登录页，
   *   所以只认**小页面**（6000 字节内），大页面交给 hub 的「401/403/429 + 特征」状态门。
   */
  { via: '阿里云 WAF（__wafcaptcha / acw_sc__v2）', re: /__wafcaptcha|acw_sc__v2|aliyungf_tc|aliyun_waf|wafcaptcha/i, maxLen: 20000 },
  { via: '阿里云 WAF（访问频率太高 / 请输入验证码）', re: /访问频率太高|请输入验证码/i, maxLen: 6000 },
  /**
   * `#705` **SafeLine（雷池 WAF）人机校验页**（厂长资源 `www.cz4k.com` 实测）。
   *
   * 形态：全站（首页与分类页）回 **HTTP 468** + 14,454 字节挑战页；正文 144 字节处就是
   * `/.safeline/static/favicon.png`，尾部加载 `/.safeline/challenge/v2/challenge.js`。
   * 页面里**没有** `captcha`、也没有「安全验证」字样 —— 旧判据（403/503 弱词 / CF 强特征）
   * 一条都不命中 ⇒ 拦截页被当正文解析 ⇒ 列表静默 0 条（`SELECTOR_MISS`，见 `hub.ts` 的 468）。
   *
   * 体积门 20KB：挑战页 14KB；`/.safeline/` 与 `slg-*` 都是 SafeLine 挑战 UI 的专有痕迹，
   * 正常正文页不会引用（对比不能收泛化的 `waf` / `安全` 字样）。
   */
  { via: 'SafeLine（雷池 WAF）人机校验页', re: /\/\.safeline\/|__sc_clearance|\bslg-(?:title|bg|box)\b/i, maxLen: 20000 },
];

/**
 * `#562` **挑战页 / 安全校验页判定**。
 *
 * 场景：138阅读网、黄金屋这类站点，静态取页拿回来的不是正文而是「浏览器校验页」——
 * 页面特征是**体积很小、含挑战脚本、没有正文选择器**。此前探针把它当普通页面：
 * 规则在它上面匹配必然 0 命中，用户看到的是「规则全错」的假象，实际是「页面没拿到」。
 *
 * ★ 判据只看**内容特征**，不看状态码 —— 挑战页可能回 200、403、503。
 */
export function isChallengePage(html: string, onlyVia?: string): { challenge: boolean; via?: string } {
  const h = String(html ?? '');
  if (!h) return { challenge: false };
  /**
   * `onlyVia`：**只复查最初命中的那一条特征**（过盾成功判定用）。
   *
   * 为什么必须能收窄：过盾后的正文里往往仍残留盾方的脚本引用（Cloudflare 的
   * `challenge-platform` 之类）⇒ 用「全部特征」复查会把**成功的结果判成失败**。
   * 判据 = 「当初那一条还在不在」，而不是「页面里还有没有别的盾方字样」。
   */
  const list = onlyVia ? CHALLENGE_SIGNATURES.filter((s) => s.via === onlyVia) : CHALLENGE_SIGNATURES;
  for (const { via, re, maxLen } of list) {
    if (maxLen !== undefined && h.length > maxLen) continue; // 大页面里的盾方脚本引用不算挑战页
    if (re.test(h)) return { challenge: true, via };
  }
  return { challenge: false };
}
