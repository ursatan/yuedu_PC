/**
 * `#626` **导出 epub 的正文图片转存** —— 移植上游
 * `F:\legado\app\src\main\java\io\legado\app\service\ExportBookService.kt:1065-1097 fixPic()`
 * 与 `help/book/BookHelp.kt:573-575 getImageSuffix()` / `utils/UrlUtil.kt:154-169 getSuffix()`。
 *
 * ## 上游怎么做的（逐条读出，不猜）
 * ```kotlin
 * content.split("\n").forEach { text ->
 *   while (matcher.find()) {                        // AppPattern.imgPattern
 *     val src = NetworkUtils.getAbsoluteURL(chapter.url, it)   // ① 相对 → 绝对
 *     val href = "Images/${md5Encode16(src)}.${getImageSuffix(src)}"   // ② 目标路径
 *     val vFile = BookHelp.getImage(book, src)      // ③ 本地图片缓存命中才有 Resource
 *     if (vFile.exists()) { resources.add(LazyResource(fp, href, originalHref)) }
 *     text1 = text1.replace(src, "../${href}")      // ④ 正文改成相对路径
 *   }
 * }
 * ```
 * 三个要点（都容易想当然）：
 *  1. **图片必须已经在本机缓存里**（`BookHelp.getImage` 只查缓存，**不下载**）——
 *     上游导出前要求先「缓存封面/图片」。我们这层的等价物是：调用方拿到字节后传进来，
 *     没拿到就**保持原 URL**（不阻断导出）。
 *  2. 改写后的路径是 `../Images/xxx` —— 章节 xhtml 在 `OEBPS/text/`，图片在 `OEBPS/Images/`。
 *  3. 文件名用 `md5Encode16(src)`（32 位 hex 的**第 8~23 位**）—— 同一张图在多章出现
 *     只落一份（去重的关键）。
 *
 * ## 本仓的三处差异（显式，不是遗漏）
 *  a. **命名哈希**：core 不能 import `node:crypto`（前端要打包），这里用 FNV-1a 双路
 *     拼出同样宽度的 16 位 hex。文件名只在 zip 内部可见，去重语义不变。
 *  b. **后缀以字节为准**：上游按 URL 后缀命名（`getSuffix(src, "jpg")`，≤5 位字母数字）。
 *     源站经常「URL 无后缀 / 后缀与真实格式不符」，所以我们先嗅魔数，
 *     嗅不出来才退回 `getSuffix` 的口径 —— **媒体类型决定阅读器能不能显示**。
 *  c. **不下载**：这层是纯函数，只做「谁该转存 / 转了叫什么 / 正文怎么改」。
 *     真去取字节由 web 层（带源 Referer/Cookie 的 `/api/proxy`）做，见
 *     `apps/web/src/utils/book-export.ts` 的 `fetchImage`。
 */

import { sanitizeExportContent, EXPORT_IMG_PATTERN } from './sanitize';
import { urlBodyOf } from '../source-match';

/** 一张要转存进 epub 的图片（`data` 已取到；取不到的图不要放进来） */
export interface ExportImageAsset {
  /**
   * 正文里 `<img src="…">` 的**原样值**（可能带 `,{...}` 尾巴、可能是相对地址）。
   * 它是改写时的查找键 —— 必须与 `collectExportImages` 给出的值逐字相同。
   */
  src: string;
  data: Uint8Array;
  /**
   * `src` **补全后的绝对地址**（可选）。给了就用它定名与去重（同一张图在正文里
   * 有相对/绝对两种写法的情形）；不给则用 `src`。
   */
  url?: string;
}

/** 嗅出来的图片类型 */
export interface ExportImageType {
  mediaType: string;
  /** 扩展名（不含点，小写） */
  ext: string;
}

/** 扩展名 → 媒体类型（嗅不出魔数时的兜底） */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/** `getSuffix` 的合法后缀判据：`[a-zA-Z0-9]` 且长度 ≤ 5（上游 `fileSuffixRegex`） */
const LEGAL_SUFFIX = /^[a-zA-Z0-9]{1,5}$/;

/**
 * 上游 `UrlUtil.getSuffix(src, "jpg")`：取最后一段路径里最后一个 `.` 之后的部分，
 * 合法（≤5 位字母数字）就用它，否则用默认值 `jpg`。
 *
 * 注意先剥 `,{...}` 尾巴（上游 `CustomUrl(str).getUrl()` 就在做这件事）——
 * 否则尾巴里的 `{`、`"` 会让后缀变成垃圾串。
 */
export function imageSuffixOf(src: string): string {
  const url = urlBodyOf(String(src ?? ''));
  const lastSeg = url.substring(url.lastIndexOf('/') + 1);
  const noQuery = lastSeg.split('?')[0]!.split('#')[0]!;
  const dot = noQuery.lastIndexOf('.');
  const suffix = dot >= 0 ? noQuery.slice(dot + 1) : '';
  return LEGAL_SUFFIX.test(suffix) ? suffix.toLowerCase() : 'jpg';
}

/**
 * 按魔数判断图片类型（**权威**，优先于 URL 后缀）。
 *
 * 为什么值得写这 20 行：源站的图片地址常见 `?v=2`、无后缀、`.jpg` 实际是 webp
 * （很多图床按 UA 协商格式）。缀错了阅读器直接不显示，而这类问题在导出的
 * zip 里**看不出来**（只能靠肉眼翻）。
 */
export function sniffImageType(bytes: Uint8Array): ExportImageType | undefined {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mediaType: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mediaType: 'image/png', ext: 'png' };
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { mediaType: 'image/gif', ext: 'gif' };
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) {
    return { mediaType: 'image/webp', ext: 'webp' };
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { mediaType: 'image/bmp', ext: 'bmp' };
  if (b.length >= 12 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66) {
    return { mediaType: 'image/avif', ext: 'avif' }; // '....ftypavif'
  }
  // SVG 是文本：跳过 BOM/空白后看是否以 `<svg` 或 `<?xml` 开头（很多源直接把 svg 内联）
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(b.subarray(0, Math.min(256, b.length)))
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) {
    return { mediaType: 'image/svg+xml', ext: 'svg' };
  }
  return undefined;
}

/**
 * 把正文里的图片 `src` 补全成**可请求的绝对地址**（上游 `NetworkUtils.getAbsoluteURL(chapter.url, it)`）。
 *
 * 两种都要处理：
 *  · `src` 带 `,{...}` 尾巴 ⇒ 先剥（请求不能带尾巴；尾巴是给引擎的选项，不是 URL 的一部分）；
 *  · 协议相对 `//host/x.jpg` ⇒ 补 `https:`（`new URL('//h/x', 'https://a/')` 也对，
 *    但没有 base 时会变成 `//h/x`，proxy 收不了）。
 */
export function imageFetchUrlOf(chapterUrl: string, rawSrc: string): string {
  const body = urlBodyOf(String(rawSrc ?? '')).trim();
  if (!body) return '';
  if (/^https?:\/\//i.test(body)) return body;
  if (body.startsWith('//')) return `https:${body}`;
  const base = urlBodyOf(String(chapterUrl ?? '')).trim();
  if (!base) return body;
  try {
    return new URL(body, base).toString();
  } catch {
    return body;
  }
}

/** 决定这张图在 zip 里叫什么（`Images/<16 hex>.<ext>`，与上游 `fixPic` 同目录同宽度） */
export function imageFileNameOf(src: string, type?: ExportImageType): string {
  const t = type ?? { mediaType: `image/${imageSuffixOf(src)}`, ext: imageSuffixOf(src) };
  return `Images/${hash16(src)}.${t.ext}`;
}

/** 媒体类型：嗅得出用嗅到的，否则按 URL 后缀映射（未知 ⇒ `application/octet-stream`） */
export function imageMediaTypeOf(src: string, sniffed?: ExportImageType): string {
  if (sniffed) return sniffed.mediaType;
  return MIME_BY_EXT[imageSuffixOf(src)] ?? 'application/octet-stream';
}

/**
 * 16 位 hex 的稳定哈希（对齐上游 `md5Encode16` 的**宽度**，不追求同值）。
 * 两路 FNV-1a（不同初值/乘子）拼起来，图片名冲突概率可忽略。
 */
function hash16(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const hx = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return `${hx(h1)}${hx(h2)}`;
}

/**
 * 收集**该转存**的图片 src（去重、保序、**已过导出净化**）。
 *
 * 关键点：先跑 `sanitizeExportContent` 再取 `<img>` —— 段评图在导出里根本不进正文，
 * 抓它纯属浪费一次请求（且慢源上就是几十秒）。这条判据必须与 epub 渲染同源，
 * 否则会出现「抓了 6 张、正文里 5 张」的对不上账。
 */
export function collectExportImages(paragraphs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paragraphs) {
    const p = String(raw ?? '');
    if (!p || p.indexOf('<img') < 0) continue;
    const clean = sanitizeExportContent(p);
    if (clean.indexOf('<img') < 0) continue;
    EXPORT_IMG_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXPORT_IMG_PATTERN.exec(clean))) {
      const src = m[1];
      if (!src || seen.has(src)) continue;
      seen.add(src);
      out.push(src);
    }
  }
  return out;
}

/**
 * 把正文里命中 `map` 的 `<img src>` 改写成 epub 内相对路径。
 *
 * 未命中的（没取到字节 / 不是图片）**原样保留** —— 上游 `fixPic` 只对
 * `vFile.exists()` 的图改写，缺失的保持远程地址（阅读器联网仍能看）。
 */
export function rewriteImgSrc(html: string, map: ReadonlyMap<string, string>): string {
  if (!html || map.size === 0) return html;
  EXPORT_IMG_PATTERN.lastIndex = 0;
  return html.replace(EXPORT_IMG_PATTERN, (tag: string, src: string) => {
    const href = map.get(src);
    if (!href) return tag;
    // 只换 src 属性值（不要整只标签重建：源里常有 style/class/width 等要保住的属性）
    return tag.replace(`src="${src}"`, `src="../${href}"`);
  });
}
