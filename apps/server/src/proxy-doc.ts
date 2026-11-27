/**
 * `/api/proxy` 回传 **HTML 文档**时的两道修补（纯字符串、无 IO —— 抽出来才能单测）。
 *
 * ## 为什么需要（`#435`，91视频「播放器全黑」的根因）
 *
 * 正文里的 `<iframe src>` 会被壳层的**动态资源改写桥**换成 `/api/proxy?u=…&sid=…`
 * （`apps/web/src/utils/html-shell.ts` 的 `buildResourceBridge`，`#363` 为 AGE 那个
 * 「按 Referer 分流」的解析站加的）。于是**站点播放器页的文档 URL 变成了我们的代理地址**，
 * 而这类播放器页有两个致命假设：
 *
 *  ① **相对路径引自己的 JS**：实测 `ha2.dd.frcfwb.cn/t2player.html` 里
 *     `<script src="hls7.min.js">`、`<link href="./plyr2.css?1.0.2">`。
 *     文档 URL 是 `…/api/proxy?u=…` ⇒ 相对地址被解析到**本服务** ⇒ `hls7.min.js` 404
 *     ⇒ `Hls` undefined ⇒ 页面那句 `if (Hls.isSupported())` 抛错
 *     ⇒ **video 永远没有源 = 用户看到的「播放器全黑」**。
 *  ② **从自己的 query 里读参数**：`var rawSource = getQueryVariable("url")` 读的是
 *     `window.location.search`（= 我们的 `?u=<编码后的上游整串>`）⇒ 取不到 `url=` ⇒
 *     即使 hls.js 加载成功也拿不到播放地址。
 *
 * ## 两道修补
 *  · `<base href="上游URL">` —— 让**相对路径的资源**回到站点去取（真机 CDP 实测：
 *    注入后 `typeof Hls` 由 `undefined` 变 `function`）；
 *  · `history.replaceState(…, location.pathname + 上游 search)` —— 让**页内脚本读到的
 *    `location.search` 就是上游那份**（`?url=…m3u8&t=…`），`getQueryVariable("url")` 恢复可用。
 *    ⚠️ 只还原 **search**，不还原 pathname（`/api/proxy` 是**我们**必须保留的路由；
 *    相对路径由 `<base>` 负责，与 pathname 无关）。
 *
 * ## 边界
 *  · 只在响应体是 **HTML** 时调用（不是 m3u8 清单、不是图片、不是 206 切片）；
 *  · 注入在 `<head>` 之后（没有 `<head>` 就 `<html>` 之后，再没有就前置）——
 *    ★ 必须**排在页面自己的脚本之前**，否则 `DOMContentLoaded` 里读 `location.search` 时还没还原；
 *  · 上游 URL 解析不了 / 为空 ⇒ 原样返回（不猜）。
 */

/** 属性值转义（`<base href>` 只用得到这几个） */
function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 生成要注入 `<head>` 开头的片段（上游 URL 不可解析 ⇒ 空串 = 不注入）。
 * 单独导出是为了让测试能直接比对片段，不必构造整页 HTML。
 */
export function docPatchHead(upstream: string): string {
  let u: URL;
  try {
    u = new URL(String(upstream));
  } catch {
    return '';
  }
  const base = `<base href="${attrEscape(upstream)}">`;
  // ⚠️ JSON 化后再把 `</` 转义（生成的 JS 文本里不能出现字面的 script 闭合标签）
  const searchLit = JSON.stringify(u.search).replace(/<\//g, '<\\/');
  /**
   * ⚠️ **必须是绝对地址**（`location.origin + location.pathname + search`）。
   * `history.replaceState` 的第三个参数按**文档的 base URL** 解析 —— 而我们刚把 `<base>`
   * 指到了上游站点 ⇒ 写成相对路径会被解析成 `https://上游/api/proxy…` ⇒ **跨源**
   * ⇒ `SecurityError: A history state object with URL … cannot be created in a document
   * with origin …`（真机踩过：`search` 还原静默失效，症状与没注入一样）。
   */
  const restore = u.search
    ? `<script>(function(){try{history.replaceState(history.state,'',location.origin+location.pathname+${searchLit});}catch(e){}})();<\/script>`
    : '';
  return base + restore;
}

/** 把两道修补注入到 HTML 文档里（位置见文件头注：必须在页面自己的脚本之前） */
export function injectProxiedDocPatches(html: string, upstream: string): string {
  const patch = docPatchHead(upstream);
  if (!patch) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + patch + html.slice(at);
  }
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + patch + html.slice(at);
  }
  return patch + html;
}