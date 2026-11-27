/**
 * EPUB 本地书解析（`#202`）
 *
 * 上游用 `epublib`（`me.ag2s.epublib`）读 epub，这里**自己解析 zip + OPF + TOC**，
 * 不引第三方依赖。原因：epub 的结构本身很简单（zip 容器 + 两份 XML + 若干 XHTML），
 * 而 Node 自带 `zlib.inflateRawSync` ⇒ 自己写比引依赖**更可控**（也少一个要审计的包）。
 * （zip 读取器自 `#212` Step3 起抽到同目录 `zip.ts`，与压缩包批量导入共用唯一实现。）
 *
 * ## 解析顺序（照 EPUB 2/3 规范，逐条可对照）
 * 1. `META-INF/container.xml` → `<rootfile full-path>` 拿到 **OPF 路径**；
 * 2. OPF：`<manifest>`（id → href/media-type）、`<spine>`（阅读顺序）、`<metadata>`（dc:title/creator/description）；
 * 3. 目录：**优先 EPUB3 的 `<nav epub:type="toc">`**（manifest 里 `properties` 含 `nav` 的那项），
 *    没有则退回 EPUB2 的 `toc.ncx`（`navMap/navPoint`，**递归**展开嵌套层级）；
 *    两者都没有 ⇒ 用 spine 顺序 + 各文件 `<title>` 兜底（上游 `getChapterList` 同一兜底分支）；
 * 4. 第一个目录目标**之前**的 spine 文件（封面/扉页/版权页）**也各补一章**（上游 `parseFirstPage()`）。
 *
 * ## 正文取法（照上游 `getContent()` 的遍历，逐条对应）
 * 从本章文件开始沿 spine 往后走：
 * - 本章文件：按 `startFragmentId` 起、`endFragmentId` 止（两者都可能是 null ⇒ 整个文件）；
 * - 若下一章**不在**本章文件里，继续把中间的文件整份并入本章（一章跨多文件的书写法）；
 * - 到下一章的文件即停（若下一章在该文件里有 fragment，只取到 fragment 之前）。
 *
 * ## 与上游的差异（写明理由）
 * - **不出图**：上游返回带 `<img>` 的 HTML 并另开 `getImage()` 通道；本仓正文通道只给
 *   **纯文本段落**（阅读器段落渲染不接受内联 HTML/图片）。挂账 `#212`。
 * - **不支持 DRM 加密**（`META-INF/encryption.xml`）⇒ **明确报错**，不静默给空正文（铁律 3）。
 * - **fragment 截取用 DOM 遍历**（上游对序列化 HTML 做字符串切分）：同一段标签文本在文中
 *   出现两次时，字符串查找会切错位置，DOM 遍历不会。
 *
 * ⚠️ `parseHtml`（jsdom）每调用一次常驻约 1MB（见 `dom/index.ts` 注释）⇒ 本文件
 *    **一次解析一份 XHTML**，不在循环里反复 parse 同一份。
 */

import { parseHtml } from '../dom';
import { readCentralDirectory, readEntryBy, type ZipEntry } from './zip';

/** epub 里的一条目录条目 */
export interface ParsedEpubChapter {
  title: string;
  /** 章节地址：`<文件路径>#<fragment>`（没有 fragment 时只有文件路径） */
  url: string;
  /** 文件路径（不含 fragment；zip 内相对路径，已规范化） */
  href: string;
  /** 该章在文件内从哪个 id 开始（无则 null） */
  startFragmentId: string | null;
  /** 该章在文件内到哪个 id 结束（无则 null；由「下一章是否同文件」推导） */
  endFragmentId: string | null;
}

export interface ParsedEpub {
  title: string;
  author: string;
  intro: string;
  /** 封面图片在 zip 内的路径（`#212` 出图前先记着，不展示） */
  coverHref: string | null;
  chapters: ParsedEpubChapter[];
  /** spine 顺序（文件路径列表）—— 存进 `ShelfBook.variable`，取正文时要知道「下一章在哪个文件」 */
  spine: string[];
}

/* ------------------------------------------------------------------ *
 * 一、zip 读取器（`#212` Step3 已抽到 `zip.ts`，与压缩包批量导入共用唯一实现）
 * ------------------------------------------------------------------ */

/** 一个已打开的 epub（同一次解析里复用 entries，避免反复解压同一文件） */
class EpubReader {
  private readonly entries: Map<string, ZipEntry>;
  private readonly cache = new Map<string, string>();

  constructor(private readonly buf: Uint8Array) {
    this.entries = readCentralDirectory(buf).byName;
  }

  /** 读文本文件（XHTML/XML）；不存在返回 null */
  text(name: string): string | null {
    const hit = this.cache.get(name);
    if (hit !== undefined) return hit;
    const e = this.entries.get(name);
    if (!e) return null;
    const s = decodeText(readEntryBy(this.buf, e));
    this.cache.set(name, s);
    return s;
  }

  /**
   * 读**二进制**资源（`#212` Step2：图片/字体等）；不存在返回 null。
   *
   * ⚠️ 不与 `text()` 共缓存：文本缓存存的是 `string`，二进制存 `Uint8Array`，
   *   混在一张表里会让类型与「同一路径被两种方式读」互相污染。二进制本身由
   *   调用方按需再取（每章正文的图各自读一次），不做全量缓存（一本漫画 epub 会撑爆内存）。
   */
  bytes(name: string): Uint8Array | null {
    const e = this.entries.get(name);
    if (!e) return null;
    return readEntryBy(this.buf, e);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** 全部条目名（`#212` Step2：资源端点要能列出/校验路径） */
  names(): string[] {
    return [...this.entries.keys()];
  }
}

const decodeText = (b: Uint8Array): string => {
  // epub 规范要求 XML/XHTML 为 UTF-8；非法时按宽松模式解（不抛错，避免整本书打不开）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('utf-8').decode(b);
  }
};

/* ------------------------------------------------------------------ *
 * 二、路径与 OPF / TOC
 * ------------------------------------------------------------------ */

/** `a/b/../c.xhtml` → `a/c.xhtml`；去掉 `./` 与开头的 `/` */
export function normaliseHref(base: string, href: string): string {
  const cleaned = (href.split('#')[0] ?? '').trim();
  if (!cleaned) return '';
  const stack = base ? base.split('/').slice(0, -1) : [];
  for (const seg of cleaned.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}

const toLower = (s: string | null): string => (s ?? '').toLowerCase();

interface OpfInfo {
  title: string;
  author: string;
  intro: string;
  coverHref: string | null;
  navHref: string | null;
  ncxHref: string | null;
  spine: string[];
}

function parseOpf(opfPath: string, xml: string): OpfInfo {
  const doc = parseHtml(xml, undefined).document;
  const text = (tag: string): string => (doc.getElementsByTagName(tag)[0]?.textContent ?? '').trim();

  const hrefById = new Map<string, string>();
  let navHref: string | null = null;
  let ncxHref: string | null = null;
  let coverHref: string | null = null;
  let coverMetaId: string | null = null;

  for (const item of Array.from(doc.getElementsByTagName('item'))) {
    const id = item.getAttribute('id') ?? '';
    const href = normaliseHref(opfPath, item.getAttribute('href') ?? '');
    if (id && href) hrefById.set(id, href);
    const props = (item.getAttribute('properties') ?? '').split(/\s+/);
    if (props.includes('nav')) navHref = href || null;
    if ((item.getAttribute('media-type') ?? '').includes('dtbncx')) ncxHref = href || null;
    if (props.includes('cover-image')) coverHref = href || null;
  }
  // EPUB2 的封面写在 `<meta name="cover" content="<manifest id>" />`
  if (!coverHref) {
    for (const m of Array.from(doc.getElementsByTagName('meta'))) {
      if (toLower(m.getAttribute('name')) === 'cover') {
        coverMetaId = m.getAttribute('content');
        break;
      }
    }
    if (coverMetaId) coverHref = hrefById.get(coverMetaId) ?? null;
  }

  const spine: string[] = [];
  for (const ref of Array.from(doc.getElementsByTagName('itemref'))) {
    const href = hrefById.get(ref.getAttribute('idref') ?? '');
    if (href) spine.push(href);
  }

  return {
    title: text('dc:title') || text('title'),
    author: text('dc:creator') || text('creator'),
    intro: text('dc:description') || text('description'),
    coverHref,
    navHref,
    ncxHref,
    spine,
  };
}

/** 从 `<nav epub:type="toc">` 取目录（EPUB3） */
function parseNav(navHref: string, html: string): ParsedEpubChapter[] {
  const doc = parseHtml(html, undefined).document;
  let nav: Element | null = null;
  for (const n of Array.from(doc.getElementsByTagName('nav'))) {
    const type = n.getAttribute('epub:type') ?? n.getAttribute('type') ?? '';
    if (type.split(/\s+/).includes('toc')) {
      nav = n;
      break;
    }
  }
  if (!nav) nav = doc.getElementsByTagName('nav')[0] ?? null; // 有些书没写 epub:type
  if (!nav) return [];
  const out: ParsedEpubChapter[] = [];
  for (const a of Array.from(nav.getElementsByTagName('a'))) {
    const raw = a.getAttribute('href') ?? '';
    if (!raw) continue;
    const [path, frag] = raw.split('#');
    const href = normaliseHref(navHref, path ?? '');
    if (!href) continue;
    out.push({
      title: (a.textContent ?? '').trim() || '无标题章节',
      url: frag ? `${href}#${frag}` : href,
      href,
      startFragmentId: frag || null,
      endFragmentId: null,
    });
  }
  return out;
}

/** 从 `toc.ncx` 取目录（EPUB2；navPoint **递归**展开） */
function parseNcx(ncxHref: string, xml: string): ParsedEpubChapter[] {
  const doc = parseHtml(xml, undefined).document;
  const out: ParsedEpubChapter[] = [];
  const walk = (navPoint: Element): void => {
    const label = navPoint.getElementsByTagName('navLabel')[0];
    const title = (label?.getElementsByTagName('text')[0]?.textContent ?? '').trim();
    const src = navPoint.getElementsByTagName('content')[0]?.getAttribute('src') ?? '';
    if (src) {
      const [path, frag] = src.split('#');
      const href = normaliseHref(ncxHref, path ?? '');
      if (href) {
        out.push({
          title: title || '无标题章节',
          url: frag ? `${href}#${frag}` : href,
          href,
          startFragmentId: frag || null,
          endFragmentId: null,
        });
      }
    }
    for (const child of Array.from(navPoint.children)) {
      if ((child.tagName ?? '').toLowerCase() === 'navpoint') walk(child);
    }
  };
  for (const np of Array.from(doc.getElementsByTagName('navPoint'))) {
    // 只从顶层进（嵌套的交给 walk 递归），避免同一节点被处理两次
    if ((np.parentElement?.tagName ?? '').toLowerCase() === 'navpoint') continue;
    walk(np);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 三、正文提取
 * ------------------------------------------------------------------ */

/** 会被当作「段落边界」的标签 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'tr', 'td', 'th', 'section', 'article', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'figure', 'figcaption', 'dt', 'dd', 'hr',
]);

/**
 * `#212` Step2：**保留图片**的正文净化（段落出口 `htmlToParagraphs` 的姊妹版）。
 *
 * ## 与「只留图片」（上游 `HtmlFormatter.formatKeepImg`）的区别
 * 上游 epub 走的是 `formatKeepImg` —— **只留 `<img>`、正文文字全丢**（它给的是「图片式阅读器」）。
 * 本仓阅读器是**文字为主 + 文中插图**，所以口径是「**留文字也留图**」：
 * 去掉 `script/style/title/rp/rt`（危险/无意义）与**所有属性**（class/id/style 是排版脏数据，
 * 且可能带源站样式），只保留结构性标签与 `img` 的 `src`/`alt`。
 *
 * ## 为什么必须重写 `<img src>`（本函数的**唯一职责里最要紧的一条**）
 * epub 里图片是 `zip 内相对路径`（如 `../Images/001.jpg`，相对**该 XHTML 文件**）。
 * iframe 里这个相对地址解析不到任何东西 ⇒ 必须换成服务端资源端点地址。
 * 由调用方（`readLocalBookContent`）给出 `toAssetUrl(zipPath)` 把 zip 路径映射成可取的 URL。
 *
 * @param html     一段 body 内 HTML
 * @param baseHref 这段 HTML 来自哪个 zip 文件（解析相对 `src` 的基准）
 * @param toAssetUrl 把 **zip 内路径** 映射成前端可取地址；返回 `''` 表示这张图映射不了（丢弃该 `img`）
 */
export function sanitizeEpubHtml(
  html: string,
  baseHref: string,
  toAssetUrl: (zipPath: string) => string,
): string {
  const doc = parseHtml(html, undefined).document;
  const body = doc.body;
  if (!body) return '';
  for (const sel of ['script', 'style', 'title', 'rp', 'rt']) {
    for (const el of Array.from(body.getElementsByTagName(sel))) el.remove();
  }
  // 上游 EpubFile.kt:282 同款：SVG 里的 `<image xlink:href>` 等价于 `<img src>`
  for (const el of Array.from(body.getElementsByTagName('image'))) {
    const href = el.getAttribute('xlink:href') ?? el.getAttribute('href');
    const img = doc.createElement('img');
    if (href) img.setAttribute('src', href);
    el.replaceWith(img);
  }
  const KEEP_ATTR = new Set(['src', 'alt']);
  for (const el of Array.from(body.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const src = (el.getAttribute('src') ?? '').trim();
      /**
       * 只处理**书内相对路径**。带 scheme 的（`https:` / `data:` / `blob:` …）一律丢弃：
       * - `data:`/`blob:` 在服务端渲染的 HTML 里活得下来，但 epub 里出现它们基本是源文件的脏数据；
       * - 外链图片要么取不到（离线场景），要么把阅读行为泄漏给第三方站点 —— 本仓不代取外部图
       *   （阅读器的外链图有自己的代理通路 `imgSrc`，那属于源正文，不属于本地书内嵌资源）。
       * ⚠️ 判据必须在这里拦：`normaliseHref()` 会把 `https://a/b.png` 当普通路径拼成
       *   `OEBPS/Text/https:/a/b.png`（实测）⇒ 会拿着这个假路径去查 zip，永远查不到却又
       *   产生一个「看起来合法」的资产地址。
       */
      const mapped = /^[a-z][a-z0-9+.-]*:/i.test(src) ? '' : src ? toAssetUrl(normaliseHref(baseHref, src)) : '';
      if (!mapped) {
        el.remove(); // 映射不了（图不在 zip 里 / 是外链）⇒ 丢掉，别留个破图占位
        continue;
      }
      const alt = el.getAttribute('alt') ?? '';
      for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
      el.setAttribute('src', mapped);
      if (alt) el.setAttribute('alt', alt);
      continue;
    }
    // 非 img：属性只留白名单（结构性标签本身不需要任何属性）
    for (const a of Array.from(el.attributes)) {
      if (!KEEP_ATTR.has(a.name.toLowerCase())) el.removeAttribute(a.name);
    }
  }
  return body.innerHTML;
}

/**
 * 从一段 HTML 提**段落文本**。
 *
 * 口径：块级元素之间断开成段 · 去掉 `script/style/title/rp/rt`（`rp/rt` 是日语注音，
 * 不删会在正文里插一堆假名）· 段落 trim 后为空则丢弃。
 */
export function htmlToParagraphs(html: string): string[] {
  const body = parseHtml(html, undefined).document.body;
  if (!body) return [];
  for (const sel of ['script', 'style', 'title', 'rp', 'rt']) {
    for (const el of Array.from(body.getElementsByTagName(sel))) el.remove();
  }
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
      } else if (child.nodeType === 1) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock && tag !== 'br') flush();
        walk(el);
        if (isBlock) flush();
      }
    }
  };
  walk(body);
  flush();
  return parts;
}

/**
 * 按 fragment 截取 body 的一段（`startId` **含**、`endId` **不含**）。
 *
 * 用 DOM 遍历而不是对 `innerHTML` 做字符串查找：同一段标签文本在文中出现两次时，
 * 字符串查找会切错位置。
 */
export function sliceBodyHtml(html: string, startId: string | null, endId: string | null): string {
  const body = parseHtml(html, undefined).document.body;
  if (!body) return html;
  if (!startId && !endId) return body.innerHTML;
  let emitting = !startId;
  let stopped = false;
  const out: string[] = [];
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (stopped) return;
      if (child.nodeType === 1) {
        const el = child as Element;
        if (startId && el.id === startId) emitting = true;
        if (endId && endId !== startId && el.id === endId) {
          stopped = true;
          return;
        }
        if (emitting) out.push(el.outerHTML);
        else walk(el);
      } else if (emitting && child.nodeType === 3) {
        out.push(
          (child.textContent ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!),
        );
      }
    }
  };
  walk(body);
  return out.join('');
}

/** 从 `href#frag` 拆出文件与 fragment */
export function splitHref(url: string): { href: string; frag: string | null } {
  const [p, f] = url.split('#');
  return { href: p ?? '', frag: f || null };
}

/**
 * 统计**每一章的正文字数**（`#212`，上游 epub 走 `getContent()` 后再 `wordCount`）。
 *
 * ## 为什么要单独一个函数（不在 `parseEpub` 里顺手算）
 * `parseEpub` 只读 OPF + 目录（快）；正文要**读全部 XHTML 并解析**（慢）。
 * 本仓的口径是「正文不落库、打开时才取」，所以「算字数」是**一次性的额外开销**，
 * 让调用方（`importLocalBook`）决定要不要付这个代价 —— 与上游「导入时全量算」不同，
 * 但结果字段一致（`ShelfChapter.wordCount`）。
 *
 * ## 实现口径
 * 逐章复用 `readEpubContent` 的同一遍历（**不重写第二套取正文逻辑** —— 否则字数与正文必然漂移），
 * 数的是**段落字符数**（`paragraphs.join('').length`，与 txt 的「字符数」口径对齐）。
 * 字体空白/换行不计（`htmlToParagraphs` 已 trim 过段内空白）。
 *
 * ⚠️ 复杂度：每章都要走一遍 spine，最坏 O(n²)。实测一本 300 章的小说在**导入时**可接受
 * （一次性、且 zip 条目有缓存，见 `EpubReader.cache`）；真正的超长书由调用方按需裁剪。
 */
export function epubChapterWordCounts(
  buf: Uint8Array,
  chapters: readonly { url: string }[],
  nextUrls: readonly (string | null)[],
  spine: readonly string[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < chapters.length; i++) {
    try {
      const ps = readEpubContent(buf, chapters[i]!.url, nextUrls[i] ?? null, spine);
      out.push(ps.reduce((a, p) => a + p.length, 0));
    } catch {
      out.push(0); // 单章读不出 ⇒ 0（不让一个字数为难整本书的导入）
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 四、对外入口
 * ------------------------------------------------------------------ */

/** 解析一份 epub（书名/作者/简介/封面路径 + 目录 + spine 顺序） */
export function parseEpub(buf: Uint8Array): ParsedEpub {
  const r = new EpubReader(buf);

  const containerXml = r.text('META-INF/container.xml');
  if (!containerXml) throw new Error('不是有效的 EPUB（缺 META-INF/container.xml）');
  const opfPath = /full-path\s*=\s*"([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath) throw new Error('不是有效的 EPUB（container.xml 里没有 rootfile）');
  const opfXml = r.text(opfPath);
  if (!opfXml) throw new Error(`EPUB 缺 OPF 文件：${opfPath}`);
  const opf = parseOpf(opfPath, opfXml);

  if (r.has('META-INF/encryption.xml')) {
    // 不静默给空正文（铁律 3）：DRM 的 epub 解出来必然是乱码
    throw new Error('该 EPUB 带 DRM 加密（META-INF/encryption.xml），本仓不支持解密');
  }

  let chapters: ParsedEpubChapter[] = [];
  const navXml = opf.navHref ? r.text(opf.navHref) : null;
  if (opf.navHref && navXml) chapters = parseNav(opf.navHref, navXml);
  if (!chapters.length && opf.ncxHref) {
    const ncxXml = r.text(opf.ncxHref);
    if (ncxXml) chapters = parseNcx(opf.ncxHref, ncxXml);
  }
  if (!chapters.length) chapters = chaptersFromSpine(r, opf.spine);
  if (!chapters.length) throw new Error('该 EPUB 解析不出任何章节（目录与 spine 都为空）');

  // 第一个目录目标之前的 spine 文件（封面/扉页/版权页）各补一章（照上游 parseFirstPage）
  const spineIdx = opf.spine.indexOf(chapters[0]!.href);
  if (spineIdx > 0) {
    const head: ParsedEpubChapter[] = [];
    for (let i = 0; i < spineIdx; i++) {
      const href = opf.spine[i]!;
      const title = fileTitle(r, href);
      head.push({
        title: title || (i === 0 ? '封面' : `页面 ${i + 1}`),
        url: href,
        href,
        startFragmentId: null,
        endFragmentId: null,
      });
    }
    chapters = [...head, ...chapters];
  }

  // `endFragmentId`：**下一章在同一个文件里**才有意义
  for (let i = 0; i < chapters.length; i++) {
    const cur = chapters[i]!;
    const next = chapters[i + 1];
    cur.endFragmentId = next && next.href === cur.href ? next.startFragmentId : null;
  }

  return {
    title: opf.title,
    author: opf.author,
    intro: opf.intro,
    coverHref: opf.coverHref,
    chapters,
    spine: opf.spine,
  };
}

/** 目录/spine 都拿不到时的兜底章节列表 */
function chaptersFromSpine(r: EpubReader, spine: readonly string[]): ParsedEpubChapter[] {
  return spine.map((href, i) => ({
    title: fileTitle(r, href) || (i === 0 ? '封面' : `第 ${i + 1} 节`),
    url: href,
    href,
    startFragmentId: null,
    endFragmentId: null,
  }));
}

/** 取某个 XHTML 文件的 `<title>`（读不到就空串） */
function fileTitle(r: EpubReader, href: string): string {
  const html = r.text(href);
  if (!html) return '';
  try {
    return (parseHtml(html, undefined).document.getElementsByTagName('title')[0]?.textContent ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 取某一章的正文**HTML 片段列表**（每段附来源文件路径）。
 *
 * `nextUrl` = 下一章的地址（章表里存的 `variable.nextUrl`）；没有下一章时传 null。
 * `spine` 用来回答「本章内容是否还延续到后面的 XHTML 文件」——一章跨多文件的书写法。
 *
 * 遍历口径与上游 `EpubFile.getContent()` 完全一致（见文件头「正文取法」）。
 * **返回 `href` 是必须的**：正文里的 `<img src="../Images/a.jpg">` 是**相对该文件**的，
 * 少了它就解析不出图片在 zip 里的真实路径（`#212` Step2）。
 */
function epubChapterHtmlParts(
  buf: Uint8Array,
  chapterUrl: string,
  nextUrl: string | null,
  spine: readonly string[],
): Array<{ href: string; html: string }> {
  const r = new EpubReader(buf);
  const { href, frag } = splitHref(chapterUrl);
  const next = nextUrl ? splitHref(nextUrl) : null;
  const nextHref = next?.href || null;

  const html = r.text(href);
  if (!html) throw new Error(`EPUB 里找不到章节文件：${href}`);

  const out: Array<{ href: string; html: string }> = [];
  const startIdx = Math.max(0, spine.indexOf(href));
  let found = false;
  for (let i = startIdx; i < spine.length; i++) {
    const file = spine[i]!;
    if (!found) {
      if (file !== href) continue;
      found = true;
      out.push({ href: file, html: sliceBodyHtml(html, frag, nextHref === href ? (next?.frag ?? null) : null) });
      if (!nextHref || nextHref === href) break;
      continue;
    }
    if (file === nextHref) {
      if (next?.frag) {
        const tail = r.text(file);
        if (tail) out.push({ href: file, html: sliceBodyHtml(tail, null, next.frag) });
      }
      break;
    }
    const mid = r.text(file);
    if (mid) out.push({ href: file, html: sliceBodyHtml(mid, null, null) });
  }
  return out;
}

/**
 * 取某一章的正文段落（纯文本出口）。
 *
 * ⚠️ `#212` Step2 起，**epub 正文优先走 {@link readEpubChapter}（HTML 出口）**：
 * 纯文本出口会丢掉 `<img>`，含图的章走它会「图没了」。本函数保留给
 * 「调用方明确只要文本」的场景（字数统计、无图兜底）。
 */
export function readEpubContent(
  buf: Uint8Array,
  chapterUrl: string,
  nextUrl: string | null,
  spine: readonly string[],
): string[] {
  return epubChapterHtmlParts(buf, chapterUrl, nextUrl, spine).flatMap((p) => htmlToParagraphs(p.html));

}

/**
 * `#212` Step2：取某一章的正文 **HTML**（含插图，`<img>` 已改写为服务端资源端点地址）。
 *
 * 返回 `{ html, hasImage }`：
 * - `html`：多文件章拼成的一段 HTML（各自净化后拼接）；无正文时为空串。
 * - `hasImage`：本章是否**真的有图**。调用方据此决定「走 HTML 出口还是段落出口」——
 *   无图的章仍走 `paragraphs`（保住字号/行距/高亮等段落级能力，见 `readLocalBookContent`）。
 *
 * `toAssetUrl` 由调用方给（服务端把它映射到 `/api/local-books/asset?…`）；
 * core 不认识 HTTP 端点，只认识「zip 内路径 → 一个可取地址」这个抽象。
 */
export function readEpubChapter(
  buf: Uint8Array,
  chapterUrl: string,
  nextUrl: string | null,
  spine: readonly string[],
  toAssetUrl: (zipPath: string) => string,
): { html: string; hasImage: boolean } {
  const parts = epubChapterHtmlParts(buf, chapterUrl, nextUrl, spine);
  const blocks: string[] = [];
  let hasImage = false;
  for (const p of parts) {
    const s = sanitizeEpubHtml(p.html, p.href, toAssetUrl);
    if (!s) continue;
    if (!hasImage && /<img[\s>]/i.test(s)) hasImage = true;
    blocks.push(s);
  }
  return { html: blocks.join('\n'), hasImage };
}

/**
 * `#212` Step2：读 epub 内嵌的二进制资源（图片/封面）。
 *
 * `zipPath` 为 zip 内**规范化**路径（与 `parseEpub().coverHref`、`<img src>` 解析结果同一口径）。
 * 不存在返回 `null`（调用方回 404，不静默给空）。
 */
export function readEpubAsset(buf: Uint8Array, zipPath: string): Uint8Array | null {
  return new EpubReader(buf).bytes(zipPath);
}
