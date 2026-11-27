/**
 * RSS 正文 HTML → 段落数组（第一批：纯清洗，不做完整 HTML 渲染）
 *
 * 背景：RSS 的 description / content:encoded 是 HTML 片段。上游 Legado 对无
 * ruleContent 的文章走 **webView 渲染**（type=0 网页型）或图片直出（type=1）。
 * 本仓第一批不做 webView ⇒ 文章内嵌正文时清洗成段落下发；纯网页型给出明确提示。
 */

const BLOCK_SPLIT = /<\/?(?:p|div|br|li|section|article|h[1-6]|blockquote|tr)\b[^>]*>/gi;
const ALLOWED_IMG = /<img\s[^>]*src\s*=\s*"([^"]+)"[^>]*>/gi;

/** 剥标签 + 实体解码（&amp; 最后替换；数字实体含中文码位） */
function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** HTML 正文 → 段落数组（空白段丢弃） */
export function htmlToParagraphs(html: string): string[] {
  const out: string[] = [];
  for (const chunk of html.split(BLOCK_SPLIT)) {
    const t = stripTags(chunk).replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

/** 抽出 HTML 里全部图片 URL（type=1 图片型文章用） */
export function extractImageUrls(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(ALLOWED_IMG)) {
    const u = m[1]!.trim();
    if (u) out.push(u);
  }
  return out;
}

/** 简版 URL 模板：{{key}} / {{page}} 替换（完整 AnalyzeUrl 语法留给后续批次） */
export function fillUrlTemplate(
  tpl: string,
  vars: { key?: string; page?: number },
): string {
  return tpl
    .replace(/\{\{key\}\}/g, encodeURIComponent(vars.key ?? ''))
    .replace(/\{\{page\}\}/g, String(vars.page ?? 1));
}
