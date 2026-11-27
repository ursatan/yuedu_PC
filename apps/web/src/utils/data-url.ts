/**
 * `data:` URL → 内联 HTML 文本（**唯一实现**）。
 *
 * ## 为什么需要（用户实测 `#392`）
 * 源作者常把**一整页 HTML** 内联成 data URL 交给浏览器 API。实测 RSS 源 `˃̶͈ ꇴ ˂̶͈`：
 * ```js
 * function update(u) { … java.startBrowser('data:text/html;base64,' + nk, '更新'); }
 * ```
 * 那一页里带「导入书源」链接（`legado://import/bookSource?src=…`）。
 *
 * ## 为什么必须「我们自己解码 + srcdoc 渲染」而不是把 data URL 塞给 iframe
 * 直接把 `data:` 交给 `<iframe src>` ⇒ **不透明 origin**，我们**注入不了**壳层导航桥，
 * 页面里的 `legado://` 链接点了没人接（用户原话：「外部浏览器的话书源更新页面，有书源
 * 导入按钮，也无法起作用了」；RSS 的「源仓库」能导入，正是因为它走**应用内**壳层）。
 * 解码成文本后交给 `buildHtmlDoc()`（无条件注入导航桥 + 存储垫片）即可。
 *
 * ## 支持范围（RFC 2397）
 * - `data:text/html;base64,<b64>`（语料形态；**必须按 UTF-8 还原**，直接 `atob` 会让中文乱码）
 * - `data:text/html,<percent-encoded>` 与 `;charset=utf-8` 等参数
 * - 其它（`data:image/png…` / `https://…` / 空）⇒ `null`，调用方走 iframe 直连或报不支持
 */
export function dataUrlHtml(url: string | undefined | null): string | null {
  const raw = String(url ?? '');
  if (!/^data:/i.test(raw)) return null;
  // 逗号前的参数段（可含 `;base64` / `;charset=utf-8`）；正文按**第一个逗号**切分
  const comma = raw.indexOf(',');
  if (comma < 0) return null;
  const head = raw.slice(5, comma).toLowerCase();
  const body = raw.slice(comma + 1);
  if (!/^text\/html(;|$)/.test(head)) return null;
  try {
    if (head.includes(';base64')) {
      const bin = atob(body.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(body);
  } catch {
    return null; // 坏 base64 / 坏百分号编码 ⇒ 交回调用方（不抛，别把登录界面弄崩）
  }
}
