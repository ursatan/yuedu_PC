/**
 * `#569` **P3 阅读模式**：从「网页即正文」的整页 HTML 里抽出正文并重排（唯一实现）。
 *
 * ## 作用范围（`#712` 起两类会话共用本模块）
 *  · `web`（`openWeb` 网页即正文）：抽正文 → 仍走 iframe（源脚本/播放器要执行）；
 *  · `book`（RSS 文章 / 组装型 / 本地 epub 含图章）：抽正文 → **降级为 paragraphs**
 *    （`paragraphsOf`），交给阅读样式体系接管。
 * 抽正文会丢掉章内播放器 / 漫画图组 / 源自绘 UI ⇒ 必须由用户对该站点**显式开启**
 * `readerMode`；本模块只负责「给定 HTML 抽正文」，不判断作用范围（闸门在 core）。
 *
 * ## 为什么用 DOMParser 而不是正则
 * 正文判定要看**结构**（段落密度、链接占比、容器嵌套）。正则只能做到「删标签」，
 * 在真实站点的 `div` 套 `div` 面前必然选错容器。浏览器原生 `DOMParser` 零依赖、够快；
 * 测试里注入 jsdom 的 `document`，与线上**同一份代码**（避免两套实现漂移）。
 *
 * ## 输出约定（交给 `buildHtmlDoc` 继续补壳）
 * - `html` 是**正文容器**的 innerHTML（不含 `<html>/<head>`）；
 * - 已去掉脚本/样式/表单/导航/侧栏/广告/评论等噪声，并清掉 `on*` 属性与 `javascript:` 链接；
 * - 图片保留（懒加载 `data-src` 由壳层的资源改写桥处理）；
 * - 抽不出足够正文（`textLength < minTextLength`）⇒ 返回 `null`，调用方**回落原文**。
 */

export interface ReaderModeResult {
  /** 标题：优先 `h1`，其次 `<title>` */
  title: string;
  /** 正文容器的 innerHTML */
  html: string;
  /** 抽出正文的纯文本长度（验收/诊断用） */
  textLength: number;
  /**
   * `#712` 正文的**纯文本段落**（书籍 HTML 正文走文本分支时用它）。
   *
   * 与 `html` 同时产出：网页型正文仍用 `html` 走 iframe；书籍正文改用这份段落，
   * 让字号/行距/主题/划词/高亮/分页全部由阅读样式体系接管。
   */
  paragraphs: string[];
}

export interface ReaderModeOptions {
  /** 测试注入用（线上用全局 DOMParser）。 */
  document?: Document;
  /** 正文最少字数；低于它判「抽失败」，默认 200。 */
  minTextLength?: number;
}

/** 噪声容器：语义标签 + 常见 class/id 关键词（保守命中，避免误删正文）。 */
const NOISE_SELECTOR = [
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'svg', 'canvas',
  'form', 'nav', 'header', 'footer', 'aside', 'button', 'input', 'select', 'textarea',
  '[role="navigation"]', '[role="banner"]', '[role="complementary"]', '[role="search"]',
  '[aria-hidden="true"]',
  // class / id 关键词（用属性子串匹配，覆盖 `ad-box` / `ads` / `advert` / `ad_1`）
  '[class*="ad-"]', '[class*="ads"]', '[class*="advert"]', '[class*="sidebar"]',
  '[class*="comment"]', '[class*="share"]', '[class*="related"]', '[class*="recommend"]',
  '[class*="breadcrumb"]', '[class*="nav"]', '[class*="footer"]', '[class*="header"]',
  '[id*="ad-"]', '[id*="ads"]', '[id*="advert"]', '[id*="sidebar"]', '[id*="comment"]',
  '[id*="share"]', '[id*="nav"]', '[id*="footer"]', '[id*="header"]',
].join(',');

/** 候选容器：正文通常落在这些语义容器里。 */
const CANDIDATE_SELECTOR = 'article, main, [role="main"], section, div';

/** 单个节点的「正文分」：文字量 − 链接文字量（链接多 = 导航/列表）+ 段落密度。 */
function scoreNode(el: Element): number {
  const text = (el.textContent ?? '').trim();
  if (!text) return 0;
  let linkLen = 0;
  for (const a of Array.from(el.querySelectorAll('a'))) linkLen += (a.textContent ?? '').trim().length;
  // 段落/图片是「正文结构」的强信号；纯 div 里塞满短链接的多半是导航
  const paras = el.querySelectorAll('p, li, h2, h3, blockquote, pre').length;
  const imgs = el.querySelectorAll('img').length;
  return text.length - linkLen * 1.5 + paras * 30 + imgs * 20;
}

/** 若唯一子节点的分已接近父节点（≥90%），下钻到子节点 —— 避免选中层层包裹的外壳。 */
function descend(el: Element, bestScore: number): Element {
  let cur = el;
  for (let guard = 0; guard < 8; guard += 1) {
    const kids = Array.from(cur.children).filter((c) => !/^(script|style|noscript)$/i.test(c.tagName));
    if (kids.length !== 1) break;
    const kid = kids[0]!;
    const s = scoreNode(kid);
    if (s < bestScore * 0.9) break;
    cur = kid;
  }
  return cur;
}

/** 清掉会执行脚本的属性（壳层 iframe 是 `allow-scripts`，不清理等于给第三方页面留口子）。 */
function sanitize(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    // `<a target>` 会把壳层 iframe 甩到站外 —— 壳层导航桥只接得住当前文档内的点击
    if (/^a$/i.test(el.tagName)) el.removeAttribute('target');
  }
}

/**
 * 抽取正文。抽不出（字数不足 / 没有候选）⇒ `null`（调用方回落原文）。
 */
export function extractReaderContent(html: string, opts: ReaderModeOptions = {}): ReaderModeResult | null {
  const raw = String(html ?? '');
  if (!raw.trim()) return null;
  const minLen = opts.minTextLength ?? 200;
  const doc = opts.document
    ?? (typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(raw, 'text/html') : undefined);
  if (!doc) return null;

  // 标题：h1 优先（很多站 `<title>` 带站点名后缀）
  const h1 = doc.querySelector('h1');
  const title = ((h1?.textContent ?? doc.title ?? '') as string).trim().replace(/\s+/g, ' ').slice(0, 200);

  // 正文抽取在**克隆树上**做，避免改动调用方文档（测试里传的是 jsdom 文档）
  const body = doc.body;
  if (!body) return null;
  const work = body.cloneNode(true) as Element;

  // 先删噪声（顺序：外层语义容器 → class/id 关键词）
  for (const n of Array.from(work.querySelectorAll(NOISE_SELECTOR))) {
    // 正文容器本身命中噪声词（如 `class="article-header"` 挂在 article 上）不删
    if (/^(article|main)$/i.test(n.tagName)) continue;
    n.remove();
  }

  let best: Element | null = null;
  let bestScore = -1;
  for (const el of Array.from(work.querySelectorAll(CANDIDATE_SELECTOR))) {
    // 太短的容器不必算（导航条、按钮行）
    const s = scoreNode(el);
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }
  // 极端情况：整页就是一段文字（没有 div/article）
  if (!best || bestScore <= 0) {
    const text = (work.textContent ?? '').trim();
    if (text.length < minLen) return null;
    sanitize(work);
    return { title, html: work.innerHTML, textLength: text.length, paragraphs: paragraphsOf(work) };
  }

  const content = descend(best, bestScore);
  sanitize(content);
  const textLength = ((content.textContent ?? '').trim()).length;
  if (textLength < minLen) return null;
  stripTitleHeading(content, title);
  return { title, html: content.innerHTML, textLength, paragraphs: paragraphsOf(content) };
}

/**
 * `#712` 删掉正文里与「已抽出标题」同名的 `h1`。
 *
 * 不删的话，书籍正文（文本分支）会显示成「章节标题 + 正文第一段又是同一个标题」；
 * 网页型也少一层重复（`readerModeDocument` 会自己补一个 `rd-article-title`）。
 */
function stripTitleHeading(root: Element, title: string): void {
  if (!title) return;
  for (const h of Array.from(root.querySelectorAll('h1'))) {
    const t = (h.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (t === title) h.remove();
  }
}

/** 块级标签：与 core `htmlToParagraphs` 同一口径（段内空白折叠、空段丢弃）。 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'table', 'tr', 'td', 'th', 'figure', 'figcaption',
]);

/**
 * `#712` 正文容器 → 段落文本（图片给 `[图]` 占位，与引擎同口径）。
 *
 * 为什么用 DOM 遍历而不是 `innerHTML` 正则：块级边界必须看结构，
 * 正则切 `<div>` 套 `<div>` 必然切错（与本模块正文抽取同一条理由）。
 */
function paragraphsOf(root: Element): string[] {
  const parts: string[] = [];
  let buf = '';
  const flush = (): void => {
    const t = buf.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (t) parts.push(t);
    buf = '';
  };
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        buf += child.textContent ?? '';
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      // 换行 = 断段（`<br>` 本身没有文本）
      if (tag === 'br') {
        flush();
        continue;
      }
      /**
       * 图片无法进段落文本 ⇒ 用 `[图]` 占位（既保留「这里有一张图」，又与引擎
       * `extractFromRaw` 的口径一致）。不带 `src` 的图同样给占位 —— 它也是源给的图位。
       */
      if (tag === 'img') {
        flush();
        parts.push('[图]');
        continue;
      }
      if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) flush();
      walk(el);
      if (isBlock) flush();
    }
  };
  walk(root);
  flush();
  return parts;
}

/** 给阅读壳用：把抽取结果包成「标题 + 正文」的最小文档（与原文一样走 `buildHtmlDoc`）。 */
export function readerModeDocument(r: ReaderModeResult): string {
  const t = r.title ? `<h1 class="rd-article-title">${escapeText(r.title)}</h1>` : '';
  return `<article class="rd-article">${t}${r.html}</article>`;
}

/**
 * `#726` 该章**能不能**做书籍阅读模式文本化（唯一判据；`ReaderOverlay` 与单测共用）。
 *
 * 为什么必须排除漫画/PDF：文本化会把 `<img>` 变成 `[图]` 占位，
 * 图集章交给图集分支后只剩一张占位图（破图）；PDF 章走版式阅读器，同理不能抽成文本。
 * `webDoc`（网页即正文）仍走 iframe，也不在这里抽。
 */
export function canExtractBookHtml(opts: {
  html?: string;
  isComic?: boolean;
  isPdf?: boolean;
  webDoc?: boolean;
}): boolean {
  if (!opts.html) return false;
  if (opts.webDoc) return false;
  if (opts.isComic) return false;
  if (opts.isPdf) return false;
  return true;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
