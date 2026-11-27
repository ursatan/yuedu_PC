/**
 * `#448` **「当前源的站地址」与「同站判定」的唯一实现**（原写在 `DiscoverView.vue` 内，抽到这里）。
 *
 * ## 为什么必须抽出来（不是一个判据写两处漂移的小事）
 * 这条判据现在有**两个**调用方，且语义必须完全一致：
 *  · `DiscoverView` 的**启动页外链**分流（`#440`）：同站 ⇒ 交阅读页（`readFirstDirect`）、异站 ⇒ 应用内浏览器；
 *  · `ReaderOverlay` 的**正文内跳转**分流（`#448`）：同站 ⇒ 交**源规则**重渲染、异站 ⇒ 页内浏览器。
 * 同一句「这个网址算不算本源的站内页面」写在两个 SFC 里，早晚会分叉（铁律）。
 *
 * ## 与上游 Legado 的关系
 * 上游是源自己通过 `shouldOverrideUrlLoading` 决定「哪些 URL 拦截下来重新按源规则解析」
 * （语料实证：命中的源里都是 `java.open('rss', url)` + `return true`）。本仓该字段仍标
 * **UNSUPPORTED**（见 `engine-rss/engine.ts` 的能力位），所以这里用**同站**做默认判据 ——
 * 对「源自绘 UI」的源（论坛帖/板块、WordPress 文章）与源作者意图一致。
 *
 * ## `#453`（D13 = A+B）之后本判据仍在，且**只有这一份**
 * 精确到 URL 模式的那一层确实由真 WebView 的常驻会话承接了，但「这个网址算不算本源的站内页面」
 * 仍由本文件回答，只是**判定的位置**变了：
 *  · 主进程只 `preventDefault()` 并**上报**页内导航（`#453` 的 `will-navigate`）——
 *    **不自行判同站**（`apps/desktop/main.js` 的文件头明写）；
 *  · 内嵌真浏览器里的页内跳转一律**放行**（它本来就是浏览器，`InAppBrowser` 负责）；
 *  · 「同站 ⇒ 交源规则渲染 / 异站 ⇒ 应用内浏览器」这条分流仍在
 *    `DiscoverView.openStartPageUrl` 与 `ReaderOverlay` 的正文内跳转上使用 `sameSite()`。
 * ⇒ 真 view 承接的是**能力**（cookie / TLS 指纹 / 原生历史），不是这条判据。
 */

/** 源记录里与本判据相关的最小形状（`stores/sources.ts` 的 `SourceInfo` 是它的超集，`url` 可缺） */
export interface SiteSource {
  id: string;
  url?: string;
}

/**
 * 当前源的**站地址**（`sources` 里那条记录的 `url`）。
 *
 * ⚠️ 不能用 `sourceId` 反解：`id` 是把 `://` 与 `/` 换成 `_` 的**有损**规范化形态，
 * 反解不出原始 host（`#440` 的注释原文）。
 */
export function sourceSiteUrlOf(sources: ReadonlyArray<SiteSource>, sourceId: string): string {
  return sources.find((s) => s.id === sourceId)?.url ?? '';
}

/**
 * 同站判定：去掉 `www.` 后比较 host，且**互为子域也算同站**。
 *
 * 例：源站 `bbs.example.com` ⇒ `bbs.example.com` ✅ / `m.bbs.example.com` ✅ /
 * `example.com` ✅ / `other.com` ❌。任一参数为空或不可解析 ⇒ `false`（保守：当异站处理）。
 */
export function sameSite(a: string, siteUrl: string): boolean {
  if (!a || !siteUrl) return false;
  try {
    const strip = (h: string): string => h.toLowerCase().replace(/^www\./, '');
    const ha = strip(new URL(a).host);
    const hb = strip(new URL(siteUrl).host);
    return !!ha && !!hb && (ha === hb || ha.endsWith('.' + hb) || hb.endsWith('.' + ha));
  } catch {
    return false;
  }
}

/**
 * `#448` 该 URL 是否**像页面**（而不是图片/媒体/压缩包等资源）。
 *
 * 为什么需要：正文里的 `<a>` 不全是「下一篇」——论坛的附件链接（千白羽 `<a class="att" …>`）、
 * 图集的原图链接都是**同站资源**。若一律送去「按源规则解析成正文」，用户点附件会得到一张
 * 解析失败的空白页（新引入的回归）。故资源类后缀**排除在「交源规则」之外**（仍走页内浏览器，
 * 与原行为一致）。
 */
const ASSET_EXT =
  /\.(?:jpe?g|png|gif|webp|bmp|svg|ico|avif|mp4|m4v|mov|webm|mkv|flv|avi|ts|m3u8|mpd|mp3|m4a|aac|flac|wav|ogg|zip|rar|7z|tar|gz|pdf|epub|mobi|apk|css|js|woff2?|ttf|otf)(?:$|[?#])/i;

export function looksLikePageUrl(u: string): boolean {
  if (!/^https?:\/\//i.test(u)) return false;
  try {
    return !ASSET_EXT.test(new URL(u).pathname);
  } catch {
    return false;
  }
}
