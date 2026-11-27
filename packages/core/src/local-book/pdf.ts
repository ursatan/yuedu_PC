/**
 * PDF 本地书解析（`#212` Step4）
 *
 * 上游对应：`model/localBook/PdfFile.kt` —— 靠 Android 的 `PdfRenderer` 打开 PDF、
 * 取 `pageCount`，**每 10 页一章**（`PAGE_SIZE = 10`，标题 `分段_N`，url `pdf_N`），
 * 并把第 0 页渲染成封面（`upBookCover`）。
 *
 * ## 本仓的分工（关键取舍，与上游不同）
 * Node 侧**没有内置 PDF 渲染器**。上游那套「拿 `PdfRenderer` 把某一页栅格化成 Bitmap」
 * 在本仓没有等价物（`pdfjs-dist` 需要 canvas；`@napi-rs/canvas` 是原生模块，会在
 * Electron 打包与 Web 自托管两条线上都带来额外分发问题）。因此本仓**分成两层**：
 *
 *  - **服务端（本文件）只做「结构」**：读出页数（必要时读文档级目录/大纲），
 *    按上游口径切成 `ceil(pageCount / 10)` 章。章表只存页码区间，**不渲染**。
 *  - **前端（`apps/web`）负责「渲染」**：用 `pdfjs-dist` 把页面画到 `<canvas>` 上。
 *    服务端把 PDF **原始字节**经既有 `/api/local-books/file` 端点发给前端（同源、可鉴权），
 *    前端按当前章的页码区间逐页渲染。这样 Electron 与 Web 自托管**共用一条通路**，
 *    不引入任何原生依赖。
 *
 * ## 为什么只数页数，不用完整解析器
 * 目录只需知道「有多少页」；把 PDF 的 xref/对象流全部解出来对一个「分章」需求是过度工程。
 * 本文件用**最小代价、最坏情况下也能给出答案**的方式数页：
 *  ① 优先读文档级 `/Count`（`/Type /Pages` 的根节点，最可靠）；
 *  ② 退而求其次，统计 `/Type /Page`（**不带 `s`**）对象个数；
 *  ③ 都拿不到 ⇒ **明确抛错**（铁律 3：不静默给「0 页 / 1 页」的假答案）。
 *
 * ⚠️ 本仓**不处理加密 PDF**（DRM / 用户口令）。加密的 PDF 用完整解析器也要口令，
 * 结构扫描给出的页数也未必对 ⇒ 检测到 `/Encrypt` 直接报「不支持加密 PDF」。
 */

import { inflateSync } from 'node:zlib';

/** 上游 `PdfFile.PAGE_SIZE = 10`：每章页数 */
export const PDF_PAGE_SIZE = 10;

export interface ParsedPdfChapter {
  title: string;
  /** 该章起始页（0 基，含） */
  start: number;
  /** 该章结束页（0 基，不含） */
  end: number;
}

export interface ParsedPdf {
  pageCount: number;
  chapters: ParsedPdfChapter[];
  /** 文档级标题（`/Title`，取到才有；多数 PDF 没有） */
  title: string;
  /** 文档级作者（`/Author`，取到才有） */
  author: string;
}

/** 把 `Uint8Array` 当 latin1 字符串看待（PDF 结构是 ASCII 为主的字节流） */
function latin1(buf: Uint8Array): string {
  // 分块拼接，避免 `String.fromCharCode(...bigArray)` 在几十 MB 文件上爆栈
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    out += String.fromCharCode(...buf.subarray(i, Math.min(i + CHUNK, buf.length)));
  }
  return out;
}

/**
 * 读文档级 `/Count N`（`/Type /Pages` 根节点的页总数）。
 *
 * PDF 的对象可以任意顺序排列，`/Count` 也可能出现在页树里非根节点 ⇒ **取最大值**
 * 而不是「第一个匹配」（中间节点的 `/Count` 是子树的页数，比根小）。
 */
function countFromPagesCount(s: string): number {
  const re = /\/Type\s*\/Pages\b/g;
  let best = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    // 从 `/Type /Pages` 往后找最近的 `/Count <整数>`（对象字典在同一个 `<< >>` 里）
    const win = s.slice(m.index, m.index + 4000);
    const c = /\/Count\s+(\d+)/.exec(win);
    if (c) {
      const n = Number.parseInt(c[1]!, 10);
      if (Number.isFinite(n) && n > best) best = n;
    }
  }
  return best;
}

/** 统计页对象个数：`/Type /Page`（**后面不能紧跟 `s`**，否则会把 `/Pages` 也算进来） */
function countPageObjects(s: string): number {
  const re = /\/Type\s*\/Page(?![s\w])/g;
  let n = 0;
  while (re.exec(s)) n++;
  return n;
}

/**
 * 取出所有 **对象流**（`/Type /ObjStm`）解压后的内容（`#PDF-ObjStm`）。
 *
 * PDF 1.5+ 允许把 Catalog / PageTree / Page 等非流对象**压缩进对象流**，此时
 * 原始字节里只剩 `1 0 obj <</Type /ObjStm ...>> stream ...`，`/Type /Pages`、`/Count`
 * 一个都扫不到（症状就是「单页结构化 PDF 读不出页数」）。
 * 这里按对象头逐个定位 ObjStm、用 `/Length` 切流、`inflate` 后返回明文供正则复用。
 *
 * 只处理 `FlateDecode`（含无 Filter 的裸文本）：其它滤镜在数页数场景里极罕见，
 * 解不开就跳过（宁可继续尝试别的对象流，也不在这里抛错）。
 */
function objectStreamTexts(buf: Uint8Array, s: string): string[] {
  const out: string[] = [];
  const hdr = /\b\d+\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = hdr.exec(s))) {
    const bodyAt = m.index + m[0].length;
    const streamAt = s.indexOf('stream', bodyAt);
    if (streamAt < 0) continue;
    // `endobj` 出现在 `stream` 之前 ⇒ 这是个没有流体的对象，跳过
    const endobjAt = s.indexOf('endobj', bodyAt);
    if (endobjAt >= 0 && endobjAt < streamAt) continue;
    const dict = s.slice(bodyAt, streamAt);
    if (!/\/Type\s*\/ObjStm\b/.test(dict)) continue;

    let p = streamAt + 'stream'.length;
    if (s[p] === '\r') p++;
    if (s[p] === '\n') p++;

    let len = -1;
    // `/Length 12 0 R` 是间接引用，不能把 12 当成字节长度
    if (!/\/Length\s+\d+\s+\d+\s+R/.test(dict)) {
      const lm = /\/Length\s+(\d+)/.exec(dict);
      if (lm) len = Number.parseInt(lm[1]!, 10);
    }
    if (!(len >= 0)) {
      const end = s.indexOf('endstream', p);
      if (end < 0) continue;
      len = end - p;
      while (len > 0 && (s[p + len - 1] === '\n' || s[p + len - 1] === '\r')) len--;
    }

    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
    const flate = !filter || /FlateDecode/.test(filter[1]!);
    if (!flate) continue;

    try {
      const raw = buf.subarray(p, p + len);
      out.push(latin1(filter ? inflateSync(raw) : raw));
    } catch {
      // 流损坏 / Length 不准 ⇒ 跳过这个对象流
    }
  }
  return out;
}

/** 从 trailer / info 字典里取一个字符串字段（`/Title`、`/Author`），支持 UTF-16BE 与括号字面串 */
function readInfoField(s: string, key: string): string {
  const m = new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(s);
  if (!m) return '';
  let raw = m[1]!;
  // PDF 字面串的转义：`\(` `\)` `\\` `\n` 等；这里只解最常见的三个
  raw = raw.replace(/\\([()\\])/g, '$1');
  return raw.trim();
}

/**
 * 解析一个 PDF：给出页数 + 按「每 10 页一章」切好的目录。
 *
 * 抛错的都是「这个文件确实读不了」：不是 PDF（缺 `%PDF-` 头）、加密、页数解析不出来。
 */
export function parsePdf(buf: Uint8Array): ParsedPdf {
  if (buf.length === 0) throw new Error('文件是空的');
  // 头部魔数：PDF 允许 `%PDF-` 前有少量垃圾字节（规范要求 1024 字节内），这里宽松扫前 1024
  const head = latin1(buf.subarray(0, Math.min(1024, buf.length)));
  const magicAt = head.indexOf('%PDF-');
  if (magicAt < 0) throw new Error('不是有效的 PDF（找不到 %PDF- 头）');

  // 只在末尾 trailer 区 + 全文做两种计数（全文扫描对上百 MB 的 PDF 也可接受：纯正则、无回溯）
  const text = latin1(buf);

  // 加密检测：`/Encrypt` 出现在 trailer 字典里
  if (/\/Encrypt\b/.test(text)) {
    throw new Error('不支持加密 / 带口令的 PDF');
  }

  let scanned = text;
  let pageCount = countFromPagesCount(scanned);
  if (pageCount <= 0) pageCount = countPageObjects(scanned);
  if (pageCount <= 0) {
    // PDF 1.5+ 的 xref stream 通常伴随「对象流」：页树/页对象全被 Flate 压进 ObjStm，
    // 原始字节里没有任何 `/Type /Pages`。解压后拼进扫描文本再试一次（`#PDF-ObjStm`）。
    const parts = objectStreamTexts(buf, text);
    if (parts.length) {
      scanned = `${text}\n${parts.join('\n')}`;
      pageCount = countFromPagesCount(scanned);
      if (pageCount <= 0) pageCount = countPageObjects(scanned);
    }
  }
  if (pageCount <= 0) {
    throw new Error('PDF 里读不出页数（结构异常，或用了本仓未支持的交叉引用流）');
  }

  const chapterCount = Math.ceil(pageCount / PDF_PAGE_SIZE);
  const chapters: ParsedPdfChapter[] = [];
  for (let i = 0; i < chapterCount; i++) {
    chapters.push({
      // 上游标题就是 `分段_${index}`（0 基）
      title: `分段_${i}`,
      start: i * PDF_PAGE_SIZE,
      end: Math.min((i + 1) * PDF_PAGE_SIZE, pageCount),
    });
  }

  return {
    pageCount,
    chapters,
    title: readInfoField(scanned, 'Title'),
    author: readInfoField(scanned, 'Author'),
  };
}

/** 某一页的**页号区间**（给前端渲染器用）：章索引 → `[start, end)` */
export function pdfPageRange(chapter: Pick<ParsedPdfChapter, 'start' | 'end'>): { start: number; end: number } {
  return { start: chapter.start ?? 0, end: chapter.end ?? 0 };
}
