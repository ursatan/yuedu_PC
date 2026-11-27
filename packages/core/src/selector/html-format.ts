/**
 * HTML 实体解码 + `HtmlFormatter` 的文本格式化（对齐 Legado）。
 *
 * 为什么需要这个模块（2026-09-22 用户实测清单 ④⑤）：
 *   · ④ 🎨51漫画 简介 `.comic-cate-intor@html` → 我们的字段里**留着一整段 `<div class="…">…</div>`**；
 *   · ⑤ 多源「简介换行被吞」+ `&lrm;` 原样出现。
 * 两者在 Legado 都由 **intro 的后处理**解决 —— `BookInfo.kt:123-133`：
 *
 * ```kotlin
 * val intro = analyzeRule.getString(infoRule.intro)
 * val introTrimS = intro.trimStart()
 * if (introTrimS.startsWith("<usehtml>") || introTrimS.startsWith("<md>") || introTrimS.startsWith("<useweb>")) {
 *     book.intro = introTrimS            // 三种标记：原样保留，交给 UI 渲染（WebView/Markdown）
 * } else {
 *     HtmlFormatter.formatIntro(intro)   // 否则：剥标签 + 块级标签换行 + 实体解码
 * }
 * ```
 * 我们此前**完全没有**这层 ⇒ 标签与 `&lrm;` 直接进字段、换行也没了。
 *
 * `formatIntro` 与 `format` 的差别只有「段落缩进」：`formatIntro` 用 `""`、`format` 用 `"　　"`。
 * 正文（`BookContent.kt:249`）用的是 `formatKeepImg`（`format` + 保留 `<img>`），
 * 我们正文另有段落化管线，本模块暂不接管（见 `formatText` 的 `preserveImg` 开关）。
 */
import { HTML4_ENTITY_MAP } from './html-entities.generated';

/**
 * Apache commons-text `StringEscapeUtils.unescapeHtml4` 的等价实现。
 *
 * 权威定义（commons-text `StringEscapeUtils.java`）：
 * ```java
 * UNESCAPE_HTML4 = new AggregateTranslator(
 *     new LookupTranslator(EntityArrays.BASIC_UNESCAPE),
 *     new LookupTranslator(EntityArrays.ISO8859_1_UNESCAPE),
 *     new LookupTranslator(EntityArrays.HTML40_EXTENDED_UNESCAPE),
 *     new NumericEntityUnescaper());   // DEFAULT_OPTIONS = { semiColonRequired }
 * ```
 * 三条语义要点（都对齐上面这份实现）：
 *  1. **命名实体必须带 `;`**（LookupTranslator 的 key 全是 `&xxx;`）；`&amp` 不解码。
 *  2. **数字实体也必须带 `;`**（`NumericEntityUnescaper.DEFAULT_OPTIONS = { semiColonRequired }`），
 *     支持 `&#123;` 与 `&#x1F;` / `&#X1F;`。
 *  3. **单遍扫描、不递归解码**：`&amp;lt;` → `&lt;`（不会继续解成 `<`）。
 */
export function unescapeHtml4(input: string): string {
  if (!input || input.indexOf('&') < 0) return input;
  let out = '';
  let i = 0;
  for (;;) {
    const amp = input.indexOf('&', i);
    if (amp < 0) {
      out += input.slice(i);
      return out;
    }
    out += input.slice(i, amp);
    // —— 数字实体：&#DDD; / &#xHHH; / &#XHHH;（分号必需）——
    const num = /^&#([0-9]+|[xX][0-9a-fA-F]+);/.exec(input.slice(amp));
    if (num) {
      const body = num[1] as string;
      const hex = body[0] === 'x' || body[0] === 'X';
      const cp = parseInt(hex ? body.slice(1) : body, hex ? 16 : 10);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
        out += String.fromCodePoint(cp);
        i = amp + num[0].length;
        continue;
      }
      out += '&';
      i = amp + 1;
      continue;
    }
    // —— 命名实体：取到第一个 `;`，整段命中才解码 ——
    const semi = input.indexOf(';', amp + 1);
    if (semi > 0) {
      const cand = input.slice(amp, semi + 1);
      const hit = HTML4_ENTITY_MAP.get(cand);
      if (hit !== undefined) {
        out += hit;
        i = semi + 1;
        continue;
      }
    }
    out += '&';
    i = amp + 1;
  }
}

/* ── Legado `HtmlFormatter.kt` 的正则表（逐字对齐，勿"优化"）──────────────────────── */
/**
 * `#435` **`<style>` / `<script>` 的「内容」先整段删掉**（本仓**扩展**，上游没有这两条）。
 *
 * 为什么必须补：上游 `formatText` 只把 `<style>`/`<script>` 的**标签**删掉
 * （`otherHtmlRegex`），**块内文本原样留下** ⇒ 当源把 `ruleDescription`/`rulePubDate`
 * 写成**整页 HTML**（实测「影视聚合(资源站)」：`<style>*{margin:0;padding:0;…}</style>`）
 * 时，卡片上就会直接显示 CSS 源码 —— 用户实测报障「有非简介信息暴露：CSS？`</p>`标签？」。
 * ★ 这是**刻意偏离上游**（上游也有同样的脏显示），理由：卡片/简介是**给人看的短文本**，
 *   把样式表与脚本源码当内容渲染没有任何场景需要；引擎侧 `parser/html-text.ts` 的
 *   `stripTags` 早就这么做（两处口径现在一致）。
 * ⚠️ 必须在 `WRAP_HTML_RE`/`OTHER_HTML_RE` **之前**执行：标签一旦先被删掉，块内文本就没法定位了。
 */
const STYLE_BLOCK_RE = /<style[\s\S]*?<\/style>/gi;
const SCRIPT_BLOCK_RE = /<script[\s\S]*?<\/script>/gi;
/** `(&nbsp;)+` → 空格（连续多个合并成一个） */
const NBSP_RE = /(&nbsp;)+/g;
/** `&ensp;`/`&emsp;` → 空格 */
const ESP_RE = /(&ensp;|&emsp;)/g;
/** 不打印字符：`&thinsp;` `&zwnj;` `&zwj;` 与裸 U+2009/U+200C/U+200D → 删 */
const NO_PRINT_RE = /(&thinsp;|&zwnj;|&zwj;|\u2009|\u200C|\u200D)/g;
/** 块级标签 → 换行（**换行就是这么来的**：`<div>a</div><div>b</div>` → `a\nb`） */
const WRAP_HTML_RE = /<\/?(?:div|p|br|hr|h\d|article|dd|dl)[^>]*>/g;
/** HTML 注释 → 删 */
const COMMENT_RE = /<!--[^>]*-->/g;
/** 除 `<img>` 外的标签 → 删（保留图片，正文格式化用） */
const NOT_IMG_HTML_RE = /<\/?(?!img)[a-zA-Z]+(?=[ >])[^<>]*>/g;
/** 所有标签 → 删（简介格式化用） */
const OTHER_HTML_RE = /<\/?[a-zA-Z]+(?=[ >])[^<>]*>/g;
/** 行内空白规整：`\s*\n+\s*` → 单个换行（+缩进） */
const INDENT1_RE = /\s*\n+\s*/g;
/** 开头空白/换行 → 缩进 */
const INDENT2_RE = /^[\n\s]+/;
/** 结尾空白/换行 → 删 */
const LAST_RE = /[\n\s]+$/;

/**
 * Legado `HtmlFormatter.formatText` 的等价实现（正则顺序与替换规则逐条对齐）。
 *
 * @param preserveImg `true` = `formatKeepImg` 的标签策略（保留 `<img>`，其余删）
 */
export function formatText(html: string, paragraphIndent: string, preserveImg = false): string {
  if (!html) return '';
  return html
    .replace(STYLE_BLOCK_RE, '')      // `#435` 样式表内容整段删（本仓扩展，见常量注释）
    .replace(SCRIPT_BLOCK_RE, '')     // `#435` 脚本内容整段删（同上）
    .replace(NBSP_RE, ' ')
    .replace(ESP_RE, ' ')
    .replace(NO_PRINT_RE, '')
    .replace(WRAP_HTML_RE, '\n')
    .replace(COMMENT_RE, '')
    .replace(preserveImg ? NOT_IMG_HTML_RE : OTHER_HTML_RE, '')
    .replace(INDENT1_RE, `\n${paragraphIndent}`)
    .replace(INDENT2_RE, paragraphIndent)
    .replace(LAST_RE, '');
}

/** Legado `HtmlFormatter.formatIntro`：简介专用（无段落缩进）。 */
export function formatIntro(html: string): string {
  return formatText(html, '');
}

/** Legado `HtmlFormatter.format`：通用（首行缩进 `　　`）。 */
export function formatHtml(html: string): string {
  return formatText(html, '\u3000\u3000');
}

/**
 * Legado `BookInfo.kt:123-133` 的 intro 归一化：
 * `<usehtml>` / `<md>` / `<useweb>` 开头 → **原样保留**（UI 负责渲染）；
 * 其余 → `formatIntro` 剥标签并还原换行。
 *
 * ⚠️ 判据是 **`trimStart()` 后**以这三个标记开头（Legado 用的 `introTrimS`），
 * 而不是 contains —— 否则正文里偶然出现 `<useweb>` 字样的普通简介会被误判。
 */
export function normalizeIntro(intro: string): string {
  const t = (intro ?? '').trimStart();
  if (t.startsWith('<usehtml>') || t.startsWith('<md>') || t.startsWith('<useweb>')) return t;
  return formatIntro(intro ?? '');
}

/** 该字符串是否是「需要 UI 渲染」的富文本简介（`<usehtml>`/`<md>`/`<useweb>` 标记） */
export function isRichIntro(intro: string): boolean {
  const t = (intro ?? '').trimStart();
  return t.startsWith('<usehtml>') || t.startsWith('<md>') || t.startsWith('<useweb>');
}
