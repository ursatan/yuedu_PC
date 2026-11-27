/**
 * 本地书（txt / epub）统一入口（`#202`）
 *
 * 上游对应：`model/localBook/LocalBook.kt`（`importFile()` / `getChapterList()` / `getContent()`）。
 *
 * ## 本模块做什么
 * 把「一个上传上来的文件 + 文件名」变成**可以直接入库的两张表**：
 * `books` 一行（`origin = loc_book`、`type = text|local`）+ `chapters` 若干行。
 * 以及反向的「按章取正文」。
 *
 * ## 三条设计口径（都与上游不同，理由在此）
 * 1. **不执行文件里的任何脚本**。上游支持「用户 JS 规则」改写书名/章节名（`AppConfig.bookImportFileName`
 *    / `tocUrl` 里的 JS 片段）—— 本仓的本地书导入**只做正则**，因为导入的是**外来文件**，
 *    没有理由让它的内容变成可执行代码（安全边界）。
 * 2. **正文只在读取时解析一次，不落库**。仓库里 `chapters` 表存的是**定位信息**
 *    （txt：字符偏移 `start/end`；epub：`url` + `startFragmentId/endFragmentId`），
 *    正文每次从原文件现取 —— 一本 20MB 的 txt 全量落库会让 SQLite 与备份快照都爆炸。
 * 3. **文件是唯一真相**。删除本地书时**不删原文件**（用户上传的文件归用户），只删库里的行；
 *    文件被删掉后再打开会得到**明确报错**（而不是空白）。
 */

import {
  BookType,
  LOCAL_TAG,
  localBookPayload,
  localBookUrlOf,
  emptyShelfBook,
  emptyShelfChapter,
  type ShelfBook,
  type ShelfChapter,
} from '../contract/user-data';
import { detectCharset, type BookCharset } from './encoding';
import {
  epubChapterWordCounts,
  htmlToParagraphs,
  parseEpub,
  readEpubChapter,
  readEpubContent,
  splitHref,
} from './epub';
import { parseMobi, readMobiContent } from './mobi';
import { parsePdf, PDF_PAGE_SIZE } from './pdf';
import { analyzeFileName, parseTxt, readTxtContent, wordCountFormat } from './txt';
import { parseUmd, readUmdContent } from './umd';

/** 本地书的 `bookUrl` 前缀（`bookUrl` 是主键，用前缀把本地书和网络书彻底隔开） */
export const LOCAL_BOOK_URL_PREFIX = 'loc_book://';

/**
 * 本仓支持的本地书后缀（`#212` Step4 起含 pdf / mobi / azw3）。
 *
 * ⚠️ 改动这里要**同步**三处（上游 `AppPattern.bookFileRegex` 是同样一份）：
 *  ① 服务端 `import` 端点的 `LOCAL_BOOK_RE`（决定文件落盘名）；
 *  ② 桌面端「双击打开」的文件关联登记（`apps/desktop/main.js`，见 `notes-desktop.md` §6）；
 *  ③ 前端导入对话框的 `accept`（`ShelfView.vue`）。
 * 少改一处就会「登记了却导不进 / 导得进却不登记」——那种 bug 排查起来很折磨。
 */
export const SUPPORTED_LOCAL_BOOK_EXT = ['.txt', '.epub', '.umd', '.pdf', '.mobi', '.azw3'];

/**
 * 本地书主键（`bookUrl`）。**唯一实现 = 契约层的 {@link localBookUrlOf}**（`#212` Step3 下沉）。
 *
 * ⚠️ 历史遗留：早期这里返回 `loc_book://<文件名>`，与前端算的
 * `encodeItemKey(itemKey('loc_book', {fileName}))` **不是同一个式子** ⇒ 走这条路（脚本/curl
 * 直导、压缩包批量导入）进来的书，前端会判成「不在书架」。现在改为调用契约函数，
 * 两条路统一。`fileNameFromLocalBookUrl()` 仍保留对老形态 `loc_book://` 的兼容。
 */
export function defaultLocalBookUrl(fileName: string): string {
  return localBookUrlOf(fileName);
}

/**
 * **`#228` 从 `bookUrl` 反推本地书文件名**（拿不到时返回空串）。
 *
 * ## 为什么需要它（`#217` 的根因，这轮实测坐实）
 * 本仓的本地书主键是**前端算的** `encodeItemKey(itemKey('loc_book', {fileName}))`
 * ⇒ 形如 `loc_book\0{"fileName":"a.txt"}`（`encodeItemKey` 把 NUL 写成 `%00`）。
 * 而 `ShelfBook.originName`（服务端用它拼文件路径）**前端契约里根本没有** ——
 * 前端每次 `PUT /api/user/books`（同步进度 / 改分组 / 换封面）都会用
 * `{...emptyShelfBook(), ...body}` 把它**覆盖成空串**。
 * 一旦为空，`localBookPath('')` 会抛「文件名越界」，而那句 throw 在 try 之外
 * ⇒ Fastify 兜成 **500 Internal Server Error**（实测：`originName:""` + 打 content = 500）。
 *
 * ⇒ 这个函数是**读时兜底**：拿不到 `originName` 就从主键里把文件名捞回来。
 * ⚠️ 三种形态都要认（都实际存在过）：
 *  · `loc_book\0{"fileName":"a.txt"}` —— Fastify **已解码**的真实 NUL；
 *  · `loc_book%00{"fileName":"a.txt"}` —— 未经解码的字面 `%00`；
 *  · `loc_book://a.txt` —— 服务端 `defaultLocalBookUrl()` 的形态（脚本/curl 直导）。
 */
export function fileNameFromLocalBookUrl(bookUrl: string): string {
  const raw = String(bookUrl ?? '');
  // ⚠️ 判据用 `loc_book` **不带 `//`**：`LOCAL_BOOK_URL_PREFIX` 是 `loc_book://`（服务端形态），
  //   而前端算出来的主键是 `loc_book\0{...}`（**没有那两个斜杠**）。
  //   写成 `startsWith(LOCAL_BOOK_URL_PREFIX)` 会一个都认不出来 —— 这就是「先量再改」的另一个例子。
  if (!raw.startsWith('loc_book')) return '';
  // 形态 ③：`loc_book://文件名`（`LOCAL_BOOK_URL_PREFIX` 本身就带 `//`，别再手写一遍）
  if (raw.startsWith(LOCAL_BOOK_URL_PREFIX)) {
    return safeDecode(raw.slice(LOCAL_BOOK_URL_PREFIX.length));
  }
  // 形态 ①②：NUL 之后是 JSON payload
  const nul = raw.indexOf('\0');
  if (nul >= 0) return fileNameFromPayload(raw.slice(nul + 1));
  const lit = raw.indexOf('%00');
  // ⚠️ 切片要从 `%00` **之后**开始：带着 `%00` 去 decodeURIComponent 会抛 URIError
  //   （`%00` 不是合法转义序列），safeDecode 会原样返回 ⇒ payload 仍不以 `{` 开头 ⇒ 解析失败。
  if (lit >= 0) return fileNameFromPayload(safeDecode(raw.slice(lit + 3)));
  return '';
}

function fileNameFromPayload(json: string): string {
  const t = json.trim();
  if (!t.startsWith('{')) return '';
  try {
    const p = JSON.parse(t) as { fileName?: unknown };
    return typeof p.fileName === 'string' ? p.fileName : '';
  } catch {
    // 解析失败**不抛**：调用方要的是「拿不到就回退」，不是「再制造一个 500」
    return '';
  }
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * **`#217` 写时归一：保证 `originName` 与 `bookUrl` 自洽**（写库前唯一的收敛点）。
 *
 * ## 要解决的整类缺陷
 * `ShelfBook.originName`（服务端用它拼磁盘路径 / 判格式）**前端契约里根本没有这个字段**
 * （见 `web/utils/user-map.ts` 的字段表：`originName` 恒写 `''`）⇒ **任何**前端主导的写库
 * 路径（`PUT /api/user/books` 同步进度 / 改分组、`POST /api/user/books/batch` 批量对齐、
 * 快照导入、cover 三端点）都会把它覆盖成空串。空了以后：
 *  · `content`/`file` 端点靠 {@link fileNameFromLocalBookUrl} **读时兜底**救得回来（已实测）；
 *  · 但 `asset` 端点**先**用 `extOf(originName)` 判「是不是 epub」，**后**才兜底
 *    ⇒ 一本真 epub 会被误判成「非 epub」回 400，内嵌插图/封面**整批取不到**（实测复现）。
 *
 * ## 为什么单独一个函数（而不是在每个端点各补一行）
 * 「同一判据写两处必然漂移」（本仓 `#247`/`#312` 的教训）。`originName` 的自洽性是
 * **一条**不变量，就该有**一个**实现：写库前调它，所有写路径自动一致。
 *
 * ## 语义（三条，缺一条就会制造新 bug）
 * 1. **已有非空 `originName` ⇒ 原样返回**（哪怕与 `bookUrl` 不一致）——
 *    用户/源侧显式写进来的值优先级最高，这里只补空、不纠正。
 * 2. **空 ⇒ 由 `bookUrl` 反推**；推不出返回空串（**不猜、不抛**）。
 * 3. **非本地书 ⇒ 原样返回**（`fileNameFromLocalBookUrl` 对非 `loc_book` 前缀返回空串，
 *    天然不会碰网络书的 `originName` = 源名）。
 *
 * 返回**新对象**（不改入参）：调用点可能有共享引用，就地把别人的数据改掉是隐藏耦合。
 */
export function normalizeLocalBookOriginName(book: ShelfBook): ShelfBook {
  if (book.originName) return book;
  const fromUrl = fileNameFromLocalBookUrl(book.bookUrl);
  if (!fromUrl) return book;
  return { ...book, originName: fromUrl };
}

export interface LocalBookImport {
  /** 待入库的书（未落库，调用方决定 upsert 与否） */
  book: ShelfBook;
  /** 待入库的目录（`index` 已按顺序编好） */
  chapters: ShelfChapter[];
  /**
   * 探测/声明的字符集。
   *
   * ⚠️ 比 `BookCharset` 多一个 `windows-1252`：MOBI 头里的 `encoding` 字段可以是
   *   1252（老 Kindle 书），它不是 txt 那套探测出来的编码，而是**格式自带**的声明。
   *   写成 `BookCharset` 会迫使这里把 1252 谎报成别的编码（解码已由 `mobi.ts` 做完，
   *   本字段只是落库标记）。
   */
  charset: BookCharset | 'windows-1252';
  /** 解析摘要（给界面显示「分了多少章 / 用的哪条目录规则」） */
  summary: {
    format: 'txt' | 'epub' | 'umd' | 'pdf' | 'mobi';
    chapterCount: number;
    wordCount: number;
    tocRuleName: string;
  };
}

/** 取小写后缀（含点） */
export function extOf(fileName: string): string {
  const m = /\.[^.\\/]+$/.exec(fileName);
  return m ? m[0].toLowerCase() : '';
}

/** 该文件名是不是本仓支持的本地书 */
export function isSupportedLocalBook(fileName: string): boolean {
  return SUPPORTED_LOCAL_BOOK_EXT.includes(extOf(fileName));
}

/**
 * 解析一个本地书文件，产出**待入库**的书 + 目录。
 *
 * `charsetHint` 仅对 txt 有意义（epub 规范固定 UTF-8）。
 * `opts.epubWordCount` 控制是否给 epub 算每章字数（`#212` ④；默认 true，见下）。
 * 抛错的都是「这个文件确实解析不了」的情况，错误文案直接面向用户。
 */
export interface ImportLocalBookOptions {
  /**
   * 是否给 epub 统计每章字数（默认 `true`）。
   *
   * ⚠️ 这是**唯一一处会读全部 XHTML** 的路径（O(n²) 最坏），一本 300 章的书在导入时
   *  多花几百 ms。之所以选「默认开」：上游导入即全量算，且**书架/详情页的字数展示**
   *   依赖它；关掉的结果是「字数恒空」，用户看不出所以然。批量导入超大书库时可由调用方
   *   显式传 `false` 提速。
   */
  epubWordCount?: boolean;
  /**
   * txt 是否拆分超长章节（默认 `false`，上游是 `book.getSplitLongChapter()` 开关）。
   *
   * 上游默认值由 `AppConfig.splitLongChapter` 决定（**默认关**）；本仓跟随「默认关」，
   * 需要时（一章几百万字的排版）由调用方开启。开启后原超长章变卷名 + 若干 `(1)(2)…` 子章。
   */
  splitLongChapter?: boolean;
}

export function importLocalBook(
  buf: Uint8Array,
  fileName: string,
  charsetHint?: string | null,
  opts: ImportLocalBookOptions = {},
): LocalBookImport {
  const ext = extOf(fileName);
  if (!SUPPORTED_LOCAL_BOOK_EXT.includes(ext)) {
    throw new Error(`暂不支持的文件类型 ${ext || '(无后缀)'}（当前支持 ${SUPPORTED_LOCAL_BOOK_EXT.join(' / ')}）`);
  }
  if (buf.length === 0) throw new Error('文件是空的');

  const bookUrl = defaultLocalBookUrl(fileName);
  const fromName = analyzeFileName(fileName);
  const now = Date.now();
  const base = emptyShelfBook(now);
  base.bookUrl = bookUrl;
  base.origin = LOCAL_TAG;
  base.payload = JSON.stringify(localBookPayload(fileName));
  base.originName = fileName;
  base.type = BookType.text | BookType.local;
  base.latestChapterTime = now;
  base.lastCheckTime = now;

  if (ext === '.txt') {
    const parsed = parseTxt(buf, charsetHint ?? null, opts.splitLongChapter === true);
    base.charset = parsed.charset;
    base.name = fromName.name || fileName;
    base.author = fromName.author;
    base.intro = parsed.intro || null;
    base.wordCount = wordCountFormat(parsed.wordCount) || null;
    base.totalChapterNum = parsed.chapters.length;
    base.latestChapterTitle = parsed.chapters.at(-1)?.title ?? null;
    base.durChapterTitle = parsed.chapters[0]?.title ?? null;
    // 目录规则存在 `tocUrl`（沿用上游的字段用途：本地书的 tocUrl 存「分章规则」）
    base.tocUrl = parsed.tocRule ? parsed.tocRule.rule : '';
    base.canUpdate = false; // 本地书没有「更新」概念（上游同样不动本地书的更新）

    const chapters = parsed.chapters.map((c, i) => {
      const row = emptyShelfChapter(bookUrl, i);
      row.title = c.title;
      row.isVolume = c.isVolume;
      row.url = `t:${i}`; // 主键之一；偏移才是定位真相，url 只是稳定标识
      row.start = c.start;
      row.end = c.end;
      row.wordCount = c.wordCount || null;
      return row;
    });
    return {
      book: base,
      chapters,
      charset: parsed.charset,
      summary: { format: 'txt', chapterCount: chapters.length, wordCount: parsed.wordCount, tocRuleName: parsed.tocRuleName },
    };
  }

  // ---- umd（`#212` ②a；零依赖自研，见 `umd.ts`） ----
  if (ext === '.umd') {
    const parsed = parseUmd(buf);
    base.charset = 'utf-16le'; // UMD 内部文本固定 UTF-16LE（走「拼接后的字节流」早已解码成字符，仅作标记）
    base.name = parsed.title || fromName.name || fileName;
    base.author = parsed.author || fromName.author;
    base.intro = parsed.bookType || null; // UMD 无简介字段，用「小说类型」兜底（上游亦然）
    base.totalChapterNum = parsed.chapters.length;
    base.latestChapterTitle = parsed.chapters.at(-1)?.title ?? null;
    base.durChapterTitle = parsed.chapters[0]?.title ?? null;
    base.canUpdate = false;
    // 封面：UMD 里可能就是 JPEG 字节。本仓**不落库**，只记「有没有」（`#212` ① 出图前先不展示）
    base.variable = JSON.stringify({ umdCover: parsed.cover ? true : false });

    let totalWords = 0;
    const chapters = parsed.chapters.map((ch, i) => {
      const row = emptyShelfChapter(bookUrl, i);
      row.title = ch.title || `第 ${i + 1} 节`;
      row.url = `u:${i}`; // 稳定标识；start/end 才是定位真相（与 txt 的 `t:` 一个套路）
      row.start = ch.start;
      row.end = ch.end;
      const text = readUmdContent(parsed.content, ch.start, ch.end);
      const wc = text.replace(/\s/g, '').length;
      totalWords += wc;
      row.wordCount = wordCountFormat(wc) || null;
      return row;
    });
    base.wordCount = wordCountFormat(totalWords) || null;
    return {
      book: base,
      chapters,
      charset: 'utf-16le',
      summary: { format: 'umd', chapterCount: chapters.length, wordCount: totalWords, tocRuleName: '' },
    };
  }

  // ---- pdf（`#212` Step4；服务端只做结构，渲染在前端） ----
  if (ext === '.pdf') {
    const parsed = parsePdf(buf);
    /**
     * ★ 类型位必须切成 `image | local`（不再叠 `text`）。
     *
     * 前端 `bookTypeToKind()` 按「主类型位」反推 `kind`，`image` 优先于 `text`
     * （见 `utils/user-map.ts`）⇒ 书架这条书会带 `kind: 'image'` ⇒ 阅读器走**漫画通路**
     * （`.rd-comic` 逐图渲染）。若沿用 txt 的 `text | local`，PDF 会被当成文本书、
     * 正文按纯文本切行 ⇒ 用户看到一坨乱码。
     */
    base.type = BookType.image | BookType.local;
    base.charset = 'utf-8'; // PDF 结构扫描走 latin1，但书本身的字符集标记无意义，占位即可
    base.name = parsed.title || fromName.name || fileName;
    base.author = parsed.author || fromName.author;
    base.intro = null;
    base.totalChapterNum = parsed.chapters.length;
    base.latestChapterTitle = parsed.chapters.at(-1)?.title ?? null;
    base.durChapterTitle = parsed.chapters[0]?.title ?? null;
    base.canUpdate = false;
    // 页数存进 `variable`（前端渲染器要它来算总页/进度；章节行里的 start/end 是单章区间）
    base.variable = JSON.stringify({ pdfPageCount: parsed.pageCount, pdfPageSize: PDF_PAGE_SIZE });

    const chapters = parsed.chapters.map((c, i) => {
      const row = emptyShelfChapter(bookUrl, i);
      row.title = c.title;
      row.url = `pdf_${i}`; // 上游同款 url
      // ★ `start`/`end` 复用为**页码区间**（0 基，含头不含尾）——与 txt 的字符偏移、
      //   epub 的 fragment 一样，都是「定位真相」。正文（渲染）由前端按这个区间做。
      row.start = c.start;
      row.end = c.end;
      row.wordCount = null; // PDF 是图，没有字数概念
      return row;
    });
    return {
      book: base,
      chapters,
      charset: 'utf-8',
      summary: { format: 'pdf', chapterCount: chapters.length, wordCount: 0, tocRuleName: `${parsed.pageCount} 页` },
    };
  }

  // ---- mobi / azw3（`#212` Step4；零依赖自研，见 `mobi.ts`） ----
  if (ext === '.mobi' || ext === '.azw3') {
    const parsed = parseMobi(buf);
    base.type = BookType.text | BookType.local; // 正文是 HTML 文本 ⇒ 与 epub 同类
    base.charset = parsed.charset; // 'utf-8' 或 'windows-1252'
    base.name = parsed.title || fromName.name || fileName;
    base.author = parsed.author || fromName.author;
    base.intro = parsed.description || null;
    base.totalChapterNum = parsed.chapters.length;
    base.latestChapterTitle = parsed.chapters.at(-1)?.title ?? null;
    base.durChapterTitle = parsed.chapters[0]?.title ?? null;
    base.canUpdate = false;
    // 正文用 `url` 定位（KF6 = `filepos:` / KF8 = `kindle:pos:`），和 epub 一样存 `nextUrl` 串
    base.variable = JSON.stringify({ mobiKind: parsed.kind });

    let totalWords = 0;
    const chapters = parsed.chapters.map((ch, i) => {
      const row = emptyShelfChapter(bookUrl, i);
      row.title = ch.title;
      row.url = `${i}:${ch.href}`; // 与上游一致：`<章号>:<href>`
      row.isVolume = ch.isVolume;
      const wc = ch.wordCount ?? 0;
      totalWords += wc;
      row.wordCount = wordCountFormat(wc) || null;
      const next = parsed.chapters[i + 1];
      // `skip:` 前缀 = 卷名与下一章同址（上游 KF6/KF8 用同样的手法避免重复取正文）
      if (next) row.variable = JSON.stringify({ nextUrl: next.isVolume && next.href === ch.href ? `skip:${i + 1}:${next.href}` : `${i + 1}:${next.href}` });
      return row;
    });
    base.wordCount = wordCountFormat(totalWords) || null;
    return {
      book: base,
      chapters,
      charset: parsed.charset,
      summary: { format: 'mobi', chapterCount: chapters.length, wordCount: totalWords, tocRuleName: parsed.kind },
    };
  }

  // ---- epub ----
  const parsed = parseEpub(buf);
  base.charset = 'utf-8';
  base.name = parsed.title || fromName.name || fileName;
  base.author = parsed.author || fromName.author;
  base.intro = parsed.intro || null;
  base.totalChapterNum = parsed.chapters.length;
  base.latestChapterTitle = parsed.chapters.at(-1)?.title ?? null;
  base.durChapterTitle = parsed.chapters[0]?.title ?? null;
  base.canUpdate = false;
  // spine 顺序必须存起来 —— 取正文时要知道「下一章的文件」在哪（`ShelfBook.variable` 就是干这个的）
  base.variable = JSON.stringify({ epubSpine: parsed.spine });

  // `#212` ④：每章字数（上游 epub 也算；我们让调用方按需付这个代价，见 `epubChapterWordCounts`）
  const wantCounts = opts.epubWordCount !== false;
  const nextUrls = parsed.chapters.map((_, i) => parsed.chapters[i + 1]?.url ?? null);
  const counts = wantCounts
    ? epubChapterWordCounts(buf, parsed.chapters, nextUrls, parsed.spine)
    : parsed.chapters.map(() => 0);
  const totalWords = counts.reduce((a, n) => a + n, 0);
  base.wordCount = wordCountFormat(totalWords) || null;

  const chapters = parsed.chapters.map((c, i) => {
    const row = emptyShelfChapter(bookUrl, i);
    row.title = c.title;
    row.url = c.url;
    row.startFragmentId = c.startFragmentId;
    row.endFragmentId = c.endFragmentId;
    row.baseUrl = c.href;
    row.wordCount = wordCountFormat(counts[i] ?? 0) || null;
    // 下一章地址（上游同样把 `nextUrl` 放在章节变量里）
    const next = parsed.chapters[i + 1];
    if (next) row.variable = JSON.stringify({ nextUrl: next.url });
    return row;
  });

  return {
    book: base,
    chapters,
    charset: 'utf-8',
    summary: { format: 'epub', chapterCount: chapters.length, wordCount: totalWords, tocRuleName: '' },
  };
}

/** 从书里取回 epub 的 spine 顺序（存不上/写坏了都退回空数组 —— 空数组会让跨文件章节少尾巴，不会报错） */
export function epubSpineOf(book: Pick<ShelfBook, 'variable'>): string[] {
  try {
    const v = JSON.parse(book.variable ?? '{}') as { epubSpine?: unknown };
    return Array.isArray(v.epubSpine) ? v.epubSpine.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 从章里取回 `nextUrl` */
export function nextUrlOf(chapter: Pick<ShelfChapter, 'variable'>): string | null {
  try {
    const v = JSON.parse(chapter.variable ?? '{}') as { nextUrl?: unknown };
    return typeof v.nextUrl === 'string' ? v.nextUrl : null;
  } catch {
    return null;
  }
}

/**
 * 按章取正文（本地书）。
 *
 * 凭 `book.originName` 判格式（**不是** `bookUrl`：`bookUrl` 可能被用户改过，而 `originName`
 * 就是原文件名）。
 *
 * ## ★ `#217`：拿不到后缀时**明确报错**，不再「先 txt 后 epub」瞎试
 * 旧实现对 `.txt` 之外/未知后缀走试探分支（`try asTxt() catch asEpub()`）。这条兜底
 * **看起来稳，实际有毒**（`#312`：有兜底的函数不能反推判据）：
 * `asTxt()` 对任意字节都**不抛**（它就是按字节偏移切片再解码）⇒ 一本 epub 被当纯文本切，
 * 返回的「正文」其实是 **zip 二进制**（`PK\x03\x04…mimetype application/epub+zip`），
 * 而且因为 `paragraphs.length > 0`，**连下面那条「解析不出正文」的报错都绕过了** ——
 * 用户看到一屏乱码，排查时完全看不出是判据丢了。
 *
 * 触发条件真实存在：`originName` 前端契约里没有，任何前端写库都会把它冲成空。
 * ⇒ 现在：**后缀为空 ⇒ 直接抛**，错误文案点明「文件名缺失」。调用方（服务端）负责
 * 在调用前用 `fileNameFromLocalBookUrl` 把 `originName` 补上 —— 判据只在一个地方推导。
 *
 * ## `#212` Step2：epub 含图章的 HTML 出口
 * `opts.assetUrl` 给了「zip 内路径 → 可取地址」的映射时，epub 章会**顺带算一份 HTML**
 * （`html` 字段，`<img>` 已指向该地址）。**只在章里真有图时才返回 `html`**：
 * 无图的章保持 `paragraphs` 出口 ⇒ 保住字号/行距/高亮等段落级能力（见 `readEpubChapter`）。
 * 不给 `assetUrl` ⇒ 行为与从前完全一致（只出 `paragraphs`），调用方（如字数统计）零改动。
 */
export function readLocalBookContent(
  buf: Uint8Array,
  book: Pick<ShelfBook, 'originName' | 'charset' | 'variable'>,
  chapter: Pick<ShelfChapter, 'url' | 'start' | 'end' | 'variable'>,
  opts: {
    assetUrl?: (zipPath: string) => string;
    /**
     * `#212` Step4：PDF 某一页 → 可取地址（**唯一实现**由服务端提供）。
     * 不给时回退成 `pdf-page:<n>` 这样的占位串（便于单测断言，不会当成真地址请求）。
     */
    pdfPageUrl?: (page: number) => string;
  } = {},
): { title: string; paragraphs: string[]; html?: string } {
  const ext = extOf(book.originName ?? '');
  const asTxt = (): string[] => {
    const s = chapter.start ?? 0;
    const e = chapter.end ?? Number.MAX_SAFE_INTEGER;
    const text = readTxtContent(buf, book.charset ?? detectCharset(buf), s, e);
    // 正文按行拆段（txt 的分段就是换行；空行丢掉，保留缩进）
    return text
      .split(/\r\n|\r|\n/)
      .map((l) => l.replace(/[\u00a0]+/g, ' ').trim())
      .filter((l) => l.length > 0);
  };
  const asEpub = (): string[] => readEpubContent(buf, chapter.url, nextUrlOf(chapter), epubSpineOf(book));
  /**
   * `#212` ②a UMD：章表里只存了 `start/end`（相对**拼接后正文流**的字节偏移）。
   * 每次取正文都要重新 `parseUmd` 一次（正文不落库 ⇒ 只能从原文件现取）；
   * 代价集中在 zlib 解压全文，一本几 MB 的 UMD 可接受。
   */
  const asUmd = (): string[] => {
    const umd = parseUmd(buf);
    const text = readUmdContent(umd.content, chapter.start ?? 0, chapter.end ?? Number.MAX_SAFE_INTEGER);
    return text
      .split(/\r\n|\r|\n/)
      .map((l) => l.replace(/[\u00a0]+/g, ' ').trim())
      .filter((l) => l.length > 0);
  };

  let paragraphs: string[];
  let html: string | undefined;
  if (ext === '.epub') {
    const spine = epubSpineOf(book);
    if (opts.assetUrl) {
      const r = readEpubChapter(buf, chapter.url, nextUrlOf(chapter), spine, opts.assetUrl);
      // 只在**真有图**时给 html（无图章继续走段落出口，保住段落级阅读能力）
      if (r.hasImage) html = r.html;
    }
    paragraphs = html ? htmlToParagraphs(html) : asEpub();
  } else if (ext === '.umd') paragraphs = asUmd();
  // `#212` Step4：PDF 走**图片章**出口（与漫画通路同形）。
  //   服务端只做**结构**（数页数、切章），把该章覆盖的**页码**算出来（`start`/`end` 就是
  //   页码区间，见 `importLocalBook`），生成**根相对**的资源地址
  //   （`/api/local-books/pdf-page?bookUrl=…&page=N`），一张图一个 URL
  //   ⇒ `paragraphs = [图url, …]`，与漫画通路**完全同形**，前端 `.rd-comic` 分支零改动。
  //   ⚠️ 渲染位置（与上游不同）：本仓**在前端渲染**（`pdfjs-dist` 画到 `<canvas>`），
  //   不引 `@napi-rs/canvas` 这类原生模块 —— 那会在 Electron 打包与 Web 自托管两条线上
  //   都带来额外分发问题。这里的 `pdf-page` 地址由服务端**转交原始 PDF 字节**，前端自己画。
  else if (ext === '.pdf') {
    const start = chapter.start ?? 0;
    const end = chapter.end ?? start;
    paragraphs = [];
    for (let p = start; p < end; p++) paragraphs.push(opts.pdfPageUrl ? opts.pdfPageUrl(p) : `pdf-page:${p}`);
  } else if (ext === '.mobi' || ext === '.azw3') {
    const r = readMobiContent(buf, chapter.url, nextUrlOf(chapter));
    if (r.hasImage) html = r.html;
    paragraphs = html ? htmlToParagraphs(html) : (r.text ? r.text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l.length > 0) : []);
  } else if (ext === '.txt') paragraphs = asTxt();
  else {
    // ★ `#217`：**不再试探**。详见函数头注释 —— `asTxt()` 对 zip 字节不抛错，
    //   试探的「成功」其实是把二进制当文本切，比报错坏得多。
    throw new Error(
      `无法判断本地书格式（缺少文件名后缀：${ext || '(空)'}）—— 记录里的文件名丢了，重新导入一次即可`,
    );
  }
  if (!paragraphs.length && !html) {
    // 铁律 3：不静默给空白 —— 说清楚是哪一种「空」
    const { href } = splitHref(chapter.url ?? '');
    throw new Error(`本章解析不出正文（${ext || '未知格式'}${href ? ` · ${href}` : ''}）—— 文件可能已被移动或损坏`);
  }
  return html ? { title: '', paragraphs, html } : { title: '', paragraphs };
}

/**
 * `#212` Step4：从 `variable` 里取回 PDF 页数（前端渲染器要它来算总页 / 进度）。
 *
 * 拿不到 / 写坏了都回 `0`（不抛）—— 渲染器按「当前章区间」逐页画，页数只用于显示，
 * 缺了顶多是进度条不准，不该让整章打不开。
 */
export function pdfPageCountOf(book: Pick<ShelfBook, 'variable'>): number {
  try {
    const v = JSON.parse(book.variable ?? '{}') as { pdfPageCount?: unknown };
    return typeof v.pdfPageCount === 'number' && v.pdfPageCount > 0 ? v.pdfPageCount : 0;
  } catch {
    return 0;
  }
}

/* ---- 转出子模块的公开符号（调用方只 import `local-book` 一处即可） ---- */
export { detectCharset, decodeBuffer, normaliseCharset, type BookCharset } from './encoding';
export {
  analyzeFileName,
  expandGroupRefs,
  parseTxt,
  pickTocRule,
  readTxtContent,
  wordCountFormat,
  type ParsedChapter,
  type ParsedTxt,
} from './txt';
export { parseSanitize, type SanitizeOp } from './sanitize';
export {
  epubChapterWordCounts,
  htmlToParagraphs,
  normaliseHref,
  parseEpub,
  readEpubAsset,
  readEpubChapter,
  readEpubContent,
  sanitizeEpubHtml,
  sliceBodyHtml,
  splitHref,
  type ParsedEpub,
  type ParsedEpubChapter,
} from './epub';
export { DEFAULT_ENABLED_TXT_TOC_RULES, TXT_TOC_RULES, type TxtTocRule } from './toc-rules';
export { parseUmd, readUmdContent, type ParsedUmd, type ParsedUmdChapter } from './umd';
// `#212` Step4：PDF（结构解析 — 页数 + 每 10 页一章）与 MOBI/AZW3（PDB 容器 + KF6/KF8）
export { parsePdf, pdfPageRange, PDF_PAGE_SIZE, type ParsedPdf, type ParsedPdfChapter } from './pdf';
export { parseMobi, readMobiContent, readMobiCover, type ParsedMobi, type ParsedMobiChapter } from './mobi';
// `#212` Step3：压缩包批量导入（zip 读取器也从此处对外，供 zip 容器/其他容器复用）
export {
  importLocalBookArchive,
  listArchiveBooks,
  type ArchiveImportOptions,
  type ArchiveImportResult,
  type ArchiveItemResult,
} from './archive';
export { readCentralDirectory, readEntryBy, type ZipArchive, type ZipEntry } from './zip';
// 主键算法（唯一实现在 contract）——从本地书入口再导出，调用方不必知道它住在 contract
export { localBookUrlOf, encodeItemKey, localBookItemKey } from '../contract/user-data';
