/**
 * `#457`「这段响应体到底是不是**能当文档渲染**的 HTML」—— 唯一判据（宿主与 worker 无关，纯字符串）。
 *
 * ## 为什么必须有（2026-10-14 用户实测的「源仓库导入失败」）
 * `/api/proxy` 会给 HTML 文档注入两道修补（`<base href>` + `history.replaceState`，见 `#435`），
 * 判据原先只看**响应头** `content-type` 含 `html`。而语料里就有站点在 `text/html` 下回**纯文本**：
 * 实测 `https://www.yckceo.com/index/durl/add.html?data=…` 的响应体只有 **62 字节**，内容就是一行
 * 「临时生成地址」的 URL。于是修补被注入到纯文本前面：
 *
 *   `<base href="…add.html?data=…"><script>…replaceState…</script>https://www.yckceo.com/d/e5d4…`
 *
 * 页面自己的脚本是**经壳层 NET 桥 `fetch` 这个地址**的（沙箱 iframe 里同源请求也要走代理），
 * 拿到的就是上面这串被污染的"HTML" ⇒ 弹层里显示的地址变成那段标记 ⇒ 用户复制到「粘贴 URL」
 * 导入框就被「请输入 http(s) 开头的地址」拒掉。**只看 content-type 不够，必须看 body 形状。**
 *
 * ## 判据（保守：宁可少注入，也不污染内容）
 *  · 首字符是 `{` / `[` ⇒ 不是文档（JSON）；
 *  · 前 2KB 内出现 `<!doctype html` / `<html` / `<head` / `<body` 任一标签 ⇒ 是文档；
 *  · 其余（纯文本、一行 URL、清单、CSV、m3u8 清单）⇒ **不是文档** ⇒ 调用方按原样透传。
 */
export function looksLikeHtmlDocument(body: string): boolean {
  const s = String(body ?? '');
  if (!s) return false;
  const head = s.slice(0, 2048);
  if (/^\s*[{[]/.test(head)) return false;
  return /<(?:!doctype\s+html|html|head|body)[\s>]/i.test(head);
}
