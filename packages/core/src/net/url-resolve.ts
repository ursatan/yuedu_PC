/**
 * URL 绝对化 —— **零依赖叶子模块**（`#374`）。
 *
 * 为什么要从 `net/index.ts` 拆出来：`media-extract.ts`（同样是纯字符串处理）
 * 需要它做候选绝对化，但 `net/index.ts` 还 re-export 了 `./render`（Chromium
 * spawn）等 node-only 模块 ⇒ 前端经主入口 import 会把 node 依赖拉进浏览器 bundle。
 * 拆成叶子后：`net/index.ts` re-export 保持既有导入面（engine-rss / 测试零改动），
 * `content/media-extract.ts` 改从这里 import ⇒ core 可加 `./media-extract`
 * 窄子路径 export，前端按窄路径复用**同一份判据**（铁律「同一判据写两处必然漂移」）。
 */

/**
 * URL 绝对化：相对地址基于 baseUrl 解析；绝对地址原样返回；空串回退 baseUrl。
 * 对齐 Legado NetworkUtils.getAbsoluteURL（处理 data: 与相对路径）。
 */
export function resolveUrl(base: string | undefined, url: string): string {
  const u = (url ?? '').trim();
  if (!u) return base ?? '';
  if (/^(data:|javascript:|mailto:)/i.test(u)) return u;
  // ⚠️ **已是绝对 URL → 原样返回，绝不走 `new URL()`**（2026-09-16 修）。
  //
  // 为什么关键：书源常把「请求选项」当尾巴直接拼在 URL 后面
  // （`<url>,{"method":"GET","headers":{...}}`，对齐 Legado AnalyzeUrl 的 UrlOption 语法）。
  // 过一遍 `new URL()` 会按 WHATWG 路径规则把尾巴里的 `"` 编码成 `%22`（而 `{`/`}` 不动）
  // → 尾巴不再是合法 JSON → 选项解析失败 → 请求缺必要 header。
  // 实测症状：全免漫画搜索能拿到 bookUrl（含 m-request-id 签名头），但目录为空
  // （detail 请求少了签名头，接口返回不可用数据）。
  // Legado `NetworkUtils.getAbsoluteURL` 同样对绝对 URL 直接 return。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  if (u.startsWith('//')) {
    // 协议相对：借用 base 的 scheme（Legado 同语义）
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(base ?? '')?.[1];
    return `${scheme ?? 'https'}:${u}`;
  }
  try {
    return new URL(u, base || undefined).href;
  } catch {
    return u;
  }
}

/**
 * 站点域（eTLD+1）—— 对齐 Legado `NetworkUtils.getSubDomainOrNull`（`PublicSuffixDatabase`）。
 *
 * ## 用途
 * `AnalyzeUrl.isLoginHeaderSite`（`AnalyzeUrl.kt:154-170`）：**登录头只发给源同站请求**。
 * 封面/图床/CDN 通常在第三方域，带 `Cookie`/`Authorization` 会被风控拦（且等于把登录态外泄）。
 *
 * ## 为什么不引 `tldts`
 * 本模块是**零依赖叶子**（`#374`，前端 bundle 会经窄子路径直接 import），引入 PSL 包会把
 * 数据表打进浏览器包。这里按「常用多级后缀」判定，覆盖书源实际域名（`.com` / `.cn` /
 * `.com.cn` / `.co.uk` …）；未收录的后缀退化为「最后两段」——与上游 `?: host` 的兜底同义。
 * 宁可**少切**也不误切：多级后缀漏收 ⇒ 把 `a.b.com.cn` 判成 `com.cn`（两侧同域）⇒ 放行，
 * 属「仍附加登录头」的正常行为，不会误拦同站请求。
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // 中国
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'com.hk', 'com.tw', 'com.mo', 'com.sg', 'com.my', 'com.ph', 'com.vn',
  // 英联邦/日本/韩国/澳新
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'or.kr',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.in', 'co.za', 'co.il',
  // 美洲/欧洲常见
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'com.ru', 'co.id', 'co.th',
]);

/** IPv4（含 0.0.0.0/127.0.0.1 这类源站调试地址） */
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * 取 URL 的站点域；无法判定（非 http(s)、host 为空、畸形）→ `null`。
 *
 * 与上游一致：**data URL / 相对地址不参与判定**（调用方据此保持「仍附加登录头」的原行为）。
 */
export function siteDomainOf(url: string | null | undefined): string | null {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  // 源把 data URL 包成 `https://host@js:'data:...'`：先截掉 `@js:` 之后的部分（上游 getBaseUrl 同序）
  const jsIndex = raw.toLowerCase().indexOf('@js:');
  const urlToParse = jsIndex >= 0 ? raw.slice(0, jsIndex) : raw;
  if (!/^http:\/\//i.test(urlToParse) && !/^https:\/\//i.test(urlToParse)) return null;
  let host: string;
  try {
    host = new URL(urlToParse).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host) return null;
  // IPv6 形如 `[::1]`（URL.hostname 保留方括号）—— 整串即站点标识
  if (host.startsWith('[') || host.includes(':')) return host;
  if (IPV4_RE.test(host)) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(last2)) {
    const last3 = labels.slice(-3).join('.');
    return labels.length >= 3 ? last3 : host;
  }
  return last2;
}

/**
 * 请求 URL 是否与源同站（对齐 `AnalyzeUrl.isLoginHeaderSite`）。
 *
 * 无法判定任一侧时返回 `true`（上游 `?: return true` 的保守语义：保持旧行为，不误拦）。
 * 注意上游按**二级域**比对（`www.a.com` 与 `api.a.com` 同站；`m.a.com` 也算）。
 */
export function isLoginHeaderSite(
  targetUrl: string | null | undefined,
  sourceUrl: string | null | undefined,
): boolean {
  const src = siteDomainOf(sourceUrl);
  if (!src) return true;
  const tgt = siteDomainOf(targetUrl);
  if (!tgt) return true;
  return tgt === src;
}

/**
 * `#579` **`<1,2,3>` 页码模式**（Legado `AnalyzeUrl.pagePattern`）—— 唯一实现。
 *
 * 语义：`<a,b,c>` 按 `page` 取第 N 项（1 起），**越界取最后一项**；`<单个值>` 不是页码模式，原样保留。
 *
 * 为什么必须抽成共享叶子：规则工坊的 URL 探针（`diag/url-probe.ts`）早就实现了它，
 * 但**引擎真跑**（`engine.ts` 的 `fetchRuleUrl`）没实现 ⇒ 同一条源出现
 * 「工坊试跑全通、发现页该分类没有内容」（用户实测 📥苦瓜书盘）：
 * 真跑把 `/index_1.html` 的 `<,index_1.html>` 当成路径交给 `new URL()`
 * ⇒ 编码成 `%3C,index_1.html%3E` ⇒ 站点 404。
 */
export function pickPagePattern(s: string, page: number): { s: string; used: boolean } {
  if (!s.includes('<') || !s.includes('>')) return { s, used: false };
  const p = Number.isFinite(page) && page > 0 ? Math.trunc(page) : 1;
  let used = false;
  const out = s.replace(/<([^<>]+)>/g, (_m, inner: string) => {
    const parts = String(inner).split(',');
    if (parts.length < 2) return '<' + inner + '>';
    used = true;
    const pick = p < parts.length ? parts[p - 1] : parts[parts.length - 1];
    return String(pick ?? '').trim();
  });
  return { s: out, used };
}

/**
 * 交给 **curl 子进程** 之前必须做的 URL 规范化：非 ASCII（含中文路径/参数）→ UTF-8 percent-encode。
 *
 * ## 上游依据
 * Legado 的 http 栈是 okHttp：`Request.Builder.url(String)` → `HttpUrl.get()`，
 * **非 ASCII 一律按 UTF-8 percent-encode**（`HttpUrl.canonicalize`）。所以上游拿到
 * `https://qyyuapi.com/sy/js/G站漫画/jsLib.js` 这种 URL 能直接下到东西。
 *
 * ## 为什么本仓必须显式做（`#606`，2026-10-24）
 * 本仓有两条路走 curl（`selector/js.ts` 的 `curlSyncFetch` 兜底、`engine-legado` 的 jsLib 下载），
 * curl **不会**自己编码：同一条中文 URL 原样给 curl ⇒ `http_code=000`（0 字节，等满超时）；
 * `encodeURI` 之后 ⇒ `200` / 42618 字节。不编码的症状是「请求恒空」——
 * 表现为 jsLib 拉空 ⇒ 源里的 `Get/Map/Reload` 全未定义（`Reload is not defined`，4 源）。
 *
 * ## 与 okHttp 的差异（可接受）
 * 实现按 `HttpUrl.canonicalize` 的判据走：**已是合法 `%XX` 的原样保留**（大写化），
 * 非 ASCII 与空格按 UTF-8 percent-encode，RFC 3986 的保留字符（`: / ? # [ ] @ ! $ & ' ( ) * + , ; =`）
 * 与 unreserved（`A-Z a-z 0-9 - . _ ~`）不编码。
 *
 * ⚠️ **不能用裸 `encodeURI`**：它会把已经编码的 `%E7` 变成 `%25E7`（二次编码）——
 * 语料里两种形态同时存在（源作者手写 `%20`、以及脚本 `encodeURI` 过的参数），
 * 二次编码会让请求打到不存在的地址。第一版就是这样写错的，被回归测试 `curl-url-encode-606` 抓住。
 */
export function encodeUrlForCurl(url: string): string {
  const u = String(url ?? '');
  if (!u) return u;
  /** RFC 3986 unreserved + gen-delims + sub-delims：这些字符不需要编码 */
  const SAFE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]$/;
  try {
    let out = '';
    let i = 0;
    while (i < u.length) {
      const ch = String.fromCodePoint(u.codePointAt(i) as number);
      if (ch === '%') {
        const hex = u.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out += `%${hex.toUpperCase()}`; // 已是合法转义 ⇒ 保留（只统一大小写）
          i += 3;
          continue;
        }
        out += '%25'; // 孤立 `%`：它本身必须被编码
        i += 1;
        continue;
      }
      out += SAFE.test(ch) ? ch : encodeURIComponent(ch);
      i += ch.length;
    }
    return out;
  } catch {
    // 孤立代理对（`\uD800` 之类）会让 encodeURIComponent 抛 URIError：原样交给 curl，让失败可见
    return u;
  }
}
