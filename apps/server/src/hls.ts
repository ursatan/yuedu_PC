/**
 * HLS（m3u8）播放列表的处理 —— 供 `/api/proxy` 回传播放列表时使用。
 *
 * 为什么单独成文件：这两个函数是**纯字符串处理**（无 IO、无状态），抽出来才能单测。
 * 放在 `index.ts` 里的话测试必须引入整个服务端（会在 import 时起监听端口），
 * 于是这类「边界条件多、最容易写错」的逻辑就只能靠手工验证 —— 那正是 bug 的温床。
 */

/**
 * 播放列表识别：按 content-type 或 URL。
 *
 * ⚠️ URL 判定**必须含 query**：🎬🔞麻豆传媒AI 的直链形如
 * `https://mdcmai4.xyz/api/v1/m3u8/proxy?path=…/xxx.m3u8` —— pathname 里根本没有 m3u8。
 */
export function isHlsPlaylist(type: string, url: string): boolean {
  if (/mpegurl|x-mpegURL/i.test(type)) return true;
  return /\.m3u8/i.test(url);
}

/**
 * `#432` **实体判据**：这段文本是不是**真的**播放列表。
 *
 * 合法 m3u8 必须以 `#EXTM3U` 起头（允许 BOM 与前导空行）。
 *
 * ## 为什么必须与 `isHlsPlaylist` 分开（而不是合并）
 * `isHlsPlaylist` 是**只看 URL/type 的粗筛**（URL 判定必须含 query —— 麻豆的
 * `/api/v1/m3u8/proxy?path=x.m3u8` pathname 里没有 m3u8）。但 URL 里含 `.m3u8`
 * **不代表实体是播放列表**：实测（91视频，2026-10-13）页面把**播放器页**写上
 * `ifa.src="https://ha2.dd.frcfwb.cn/t2player.html?url=https://…/xxx.m3u8"`
 * —— 这条 URL 含 `.m3u8` 于是被判成清单，HTML 被逐行当分片地址改写
 * （`https://ha2.dd.frcfwb.cn/%3Chtml%3E…`）并以 `application/vnd.apple.mpegurl` 回传
 * ⇒ hls.js `manifestParsingError`（用户症状），且**连原样的 HTML 都没给回去**。
 * ⇒ 重写前必须用**实体**再确认一次；不是清单就**原样回传**（type 也不改）。
 */
export function looksLikeHlsBody(text: string): boolean {
  return /^\uFEFF?\s*#EXTM3U/.test(text);
}

/**
 * 把播放列表里的**相对地址改写成绝对地址**（基于上游 URL）。
 *
 * 为什么必须做（2026-09-25，播放器改造的一部分）：
 *  ① **播放列表必须经服务端代理** —— 实测该 m3u8 在浏览器里**直连被 CORS 拦掉**
 *     （`Failed to fetch`），只有服务端能绕过；
 *  ② 而 hls.js 解析相对分片时是相对**它拿到的播放列表 URL** 的 —— 那个 URL 现在是
 *     `/api/proxy?u=https%3A%2F%2F…`，相对地址会被解析成 `/api/proxy?u=…/seg1.ts` 这种垃圾地址；
 *  ③ 所以代理在回传前把 `#EXT-X-KEY/#EXT-X-MAP/#EXT-X-MEDIA` 的 `URI="…"` 与
 *     **裸地址行（分片/子播放列表）**统一补成绝对上游地址 ⇒ hls.js 无论怎么解析都拿到正确地址。
 *
 * 已是绝对地址的行**原样保留**（本仓实测的那份列表就是绝对地址，不改变其语义）；
 * `data:`/`blob:` 等同理（它们本就无需补基址）。
 */
export function rewriteHlsPlaylist(text: string, base: string): string {
  const abs = (u: string): string => {
    const s = u.trim();
    if (!s || /^(https?:|data:|blob:)/i.test(s)) return u;
    try {
      return new URL(s, base).toString();
    } catch {
      return u;
    }
  };
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      // 标签行：只动 URI="…"（EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA 等）
      if (t.startsWith('#')) return line.replace(/URI="([^"]*)"/gi, (_m, u: string) => `URI="${abs(u)}"`);
      // 裸地址行 = 分片或子播放列表（子播放列表会被再次请求，届时同样走本路由）
      return abs(t);
    })
    .join('\n');
}
