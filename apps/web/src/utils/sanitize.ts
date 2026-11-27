/**
 * 远端 HTML 的**最小消毒**（字典站点返回的正文）。
 *
 * 用途：字典规则 `showRule` 产出的通常是 HTML（Legado 也是按 HTML 渲染在 WebView 里），
 * 我们要用 `v-html` 渲染它 —— 但那是**远端内容**，直接 v-html 会把 `<script>` / `onerror=` 带进页面。
 *
 * 策略（够用即可，不假装是完整 sanitizer）：
 *   · 去掉 script/style/iframe/object/embed/link/meta **成对与自闭合**两种形态；
 *   · 去掉全部 `on*=` 事件属性（`onclick`/`onerror`/`onload`…）；
 *   · `href|src="javascript:…"` 换成 `#`。
 * 其余标签（`<h1> <br> <p> <b> <a> <table>` 等）保留 —— 排版需要。
 *
 * ⚠️ 别用它处理**用户自己的**内容或需要完整 XSS 防护的场景；那是 DOMPurify 的活。
 */
export function sanitizeHtml(html: string): string {
  return String(html ?? '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}
