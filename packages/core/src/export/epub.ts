/**
 * `#620` **导出 EPUB** —— 移植上游 `ExportBookService.kt` 的
 * `exportEpub:814-834` / `setEpubMetadata:1099-1109` / `setEpubContent:987-1050`
 * （上游用 `me.ag2s.epublib`，本仓自己拼容器 —— 依赖体积与浏览器兼容都不允许引它）。
 *
 * ## 与上游一致的点
 * - **元数据**：`dc:title` = 书名、`dc:creator` = 作者、`dc:language` = `zh`、
 *   `dc:publisher` = `Legado`、`dc:description` = 简介（上游 `setEpubMetadata` 就这五项）。
 * - **每章一个 xhtml**，**标题单独成行**（`<h2>`），正文段落是 `<p>`
 *   —— 上游是 `includeTitle = false` + 由模板渲染 section 标题，效果等价。
 * - **卷**（`isVolume`）⇒ 一个只有标题的分节页（上游 `resolveExportChapterContent` 对卷返回 `""`）。
 * - **没正文的章节整章跳过**（同 txt）。
 * - **段评图剔掉**（`sanitizeExportContent`），普通插图**保留**（txt 才删图）。
 *
 * ## 与上游的已知差异（显式挂账，不假装一致）
 * `#626` 起**正文图片与封面会转存进 epub**（上游 `fixPic()` / `setCover()` 的等价物），
 * 但仍有三处差异：
 *  1. 上游「图片必须已在本机缓存」（`BookHelp.getImage` 只查缓存、不下载）⇒ 我们由调用方
 *     取字节后传入；**取不到的图保持原 URL**（阅读器联网仍能显示，不阻断导出）。
 *  2. 上游还有 `Text/intro.html`（简介页）与 `Styles/fonts.css`、`Images/logo.png` 等资源，
 *     我们只有封面页 + 正文页（简介已写进 `dc:description`）。
 *  3. 上游按 URL 后缀命名图片，我们**先嗅魔数**再退回后缀（源站后缀常年不可信）。
 *
 * ## 容器结构（EPUB 3 + 兼容 EPUB 2 的 NCX）
 * ```
 * mimetype                       ← 必须第一项且 STORED（不压缩）
 * META-INF/container.xml
 * OEBPS/content.opf              ← manifest / spine / metadata
 * OEBPS/toc.ncx                  ← EPUB2 阅读器（静读天下老版本）靠它出目录
 * OEBPS/nav.xhtml                ← EPUB3 导航
 * OEBPS/style.css
 * OEBPS/text/cover.xhtml         ← `#626`：有封面时才有
 * OEBPS/text/chapter-0001.xhtml …
 * OEBPS/Images/<md5-16>.<ext>    ← `#626`：转存的正文图与封面
 * ```
 */

import { zipFiles, browserDeflate, type DeflateFn, type ZipInputFile } from './zip-write';
import { sanitizeExportContent } from './sanitize';
import {
  imageFileNameOf,
  imageMediaTypeOf,
  imageSuffixOf,
  rewriteImgSrc,
  sniffImageType,
  type ExportImageAsset,
} from './images';
import type { ExportChapterLike } from './txt';

const enc = new TextEncoder();

function xmlEscape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 正文段落 → xhtml 片段：图片行原样保留 `<img>`，其余按段落包 `<p>` */
function paragraphsToXhtml(paragraphs: readonly string[], images: ReadonlyMap<string, string>): string {
  const out: string[] = [];
  for (const raw of paragraphs) {
    const p = String(raw ?? '');
    if (!p.trim()) continue;
    // 上游 `sanitizeExportContent`：剔掉段评图（点开是评论，不是内容）
    const clean = sanitizeExportContent(p).trim();
    if (!clean) continue;
    // `#626`：命中已转存的图片 ⇒ 改写成 `../Images/…`（未命中的保持原地址）
    const body = images.size ? rewriteImgSrc(clean, images) : clean;
    if (/^\s*<img\b/i.test(body)) {
      // 整段是一张图（图片/漫画源）⇒ 包一层 div，不做段落缩进
      out.push(`<div class="img">${body}</div>`);
    } else {
      out.push(`<p>${body.replace(/\n+/g, '<br/>')}</p>`);
    }
  }
  return out.join('\n');
}

/** 稳定的 UUID（不引入 crypto：同书同作者导出两次应得到同一个 id，便于去重） */
function stableId(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c * (i + 7)) * 0x85ebca6b;
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  // 8-4-4-4-12 的形态（版本位固定 4 ⇒ urn:uuid 合法）
  return `${hex(h1)}-${hex(h2).slice(0, 4)}-4${hex(h1 ^ h2).slice(1, 4)}-a${hex(h2 ^ 0x9e3779b9).slice(1, 4)}-${hex(h1 * 3)}${hex(h2 * 5).slice(0, 4)}`;
}

export interface EpubBuildInput {
  name: string;
  author?: string;
  intro?: string;
  chapters: readonly ExportChapterLike[];
  /** 是否写章节标题（默认 true；关掉后正文里不再有 `<h2>`） */
  includeChapterTitle?: boolean;
  /** 语言（默认 `zh`，上游 `metadata.language = "zh"`） */
  language?: string;
  /** 出版者（默认 `Legado`，与上游一致） */
  publisher?: string;
  /**
   * `#626` 正文图片（已取到字节）。键是正文里 `<img src>` 的**原样值**，
   * 用 `collectExportImages()` 取（保证与渲染同一条判据）。
   */
  images?: readonly ExportImageAsset[];
  /** `#626` 封面（上游 `setCover`；取不到就别传，不生成封面页） */
  cover?: ExportImageAsset;
}

export interface EpubBuildOptions {
  /** 压缩钩子（默认 `browserDeflate`；给 `null` 则全部 STORED） */
  deflate?: DeflateFn | null;
}

/** 单章 → xhtml 文档 */
function chapterXhtml(
  title: string,
  paragraphs: readonly string[],
  withTitle: boolean,
  isVolume: boolean,
  images: ReadonlyMap<string, string>,
): string {
  const h = withTitle && title ? `<h2>${xmlEscape(title)}</h2>` : '';
  const body = isVolume ? '' : paragraphsToXhtml(paragraphs, images);
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><meta charset="utf-8"/><title>${xmlEscape(title)}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body${isVolume ? ' class="volume"' : ''}>
${h}
${body}
</body>
</html>`;
}

/**
 * 生成 epub 字节。
 *
 * 章节过滤与 txt 同一口径：`paragraphs == null` 且非卷 ⇒ 跳过（上游 `Pair("", null)`）。
 */
export async function buildEpub(input: EpubBuildInput, opts: EpubBuildOptions = {}): Promise<Uint8Array> {
  const lang = input.language ?? 'zh';
  const publisher = input.publisher ?? 'Legado';
  const id = stableId(`${input.name}\u0000${input.author ?? ''}`);
  const withTitle = input.includeChapterTitle !== false;

  const chapters = input.chapters.filter((c) => c.paragraphs != null || c.isVolume);
  const files: ZipInputFile[] = [];

  /**
   * ① `#626` 图片清单：**先按字节嗅类型再定名**。
   *
   * 两个 map 各管一事（别合并）：
   *  · `imgBySrc` —— 改写正文用，键是正文里的**原样 src**；
   *  · `imgByHref` —— 落盘用，键是归档内路径（同图不同 src 写法会得到不同 href，
   *    与上游 `md5Encode16(src)` 的行为一致）。
   */
  const imgBySrc = new Map<string, string>();
  const imgByHref = new Map<string, { data: Uint8Array; mediaType: string }>();
  for (const a of input.images ?? []) {
    const src = String(a?.src ?? '');
    const data = a?.data;
    if (!src || !data || !data.length || imgBySrc.has(src)) continue;
    const nameKey = String(a.url ?? '') || src; // 有绝对地址就按它定名（同一张图两种写法只落一份）
    const t = sniffImageType(data);
    const href = imageFileNameOf(nameKey, t);
    imgBySrc.set(src, href);
    if (!imgByHref.has(href)) imgByHref.set(href, { data, mediaType: imageMediaTypeOf(nameKey, t) });
  }

  /** 封面（上游 `setCover` 失败是 `runCatching` 静默的 —— 我们同样「没字节就没有封面页」） */
  const coverData = input.cover?.data;
  const coverKey = String(input.cover?.url ?? '') || String(input.cover?.src ?? '');
  const cover =
    coverData && coverData.length
      ? (() => {
          const t = sniffImageType(coverData);
          const ext = t?.ext ?? imageSuffixOf(coverKey);
          return { href: `Images/cover.${ext}`, data: coverData, mediaType: imageMediaTypeOf(coverKey, t) };
        })()
      : undefined;

  // ② mimetype 必须第一个且 STORED（EPUB OCF 规范的硬要求，压缩了就判非法）
  files.push({ path: 'mimetype', data: enc.encode('application/epub+zip'), store: true });

  files.push({
    path: 'META-INF/container.xml',
    data: enc.encode(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
  });

  files.push({
    path: 'OEBPS/style.css',
    data: enc.encode(`body { margin: 0 1em; line-height: 1.6; }
h1, h2 { font-weight: bold; margin: 0.6em 0 0.4em; }
h2 { font-size: 1.15em; }
p { margin: 0; text-indent: 2em; }
div.img { margin: 0.4em 0; text-align: center; }
div.img img { max-width: 100%; height: auto; }
body.volume h2 { text-align: center; font-size: 1.4em; margin: 2em 0; }
body.cover { margin: 0; text-align: center; }
body.cover img { max-width: 100%; max-height: 100vh; }`),
  });

  // ③ 封面页 + 正文图片（两者都 `store: true`：jpg/png 已经是压缩格式，再 deflate 纯粹烧 CPU）
  const spine: { id: string; href: string }[] = [];
  if (cover) {
    files.push({ path: `OEBPS/${cover.href}`, data: cover.data, store: true });
    files.push({
      path: 'OEBPS/text/cover.xhtml',
      data: enc.encode(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${xmlEscape(input.name)}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body class="cover"><div class="img"><img src="../${cover.href}" alt="${xmlEscape(input.name)}"/></div></body>
</html>`),
    });
    spine.push({ id: 'cover', href: 'text/cover.xhtml' });
  }
  for (const [href, f] of imgByHref) files.push({ path: `OEBPS/${href}`, data: f.data, store: true });

  // ④ 章节
  const navPoints: { id: string; title: string; href: string }[] = [];
  chapters.forEach((c, i) => {
    const n = String(i + 1).padStart(4, '0');
    const cid = `ch${n}`;
    const href = `text/chapter-${n}.xhtml`;
    files.push({
      path: `OEBPS/${href}`,
      data: enc.encode(chapterXhtml(c.title, c.paragraphs ?? [], withTitle, !!c.isVolume, imgBySrc)),
    });
    spine.push({ id: cid, href });
    navPoints.push({ id: `nav${n}`, title: c.title || `第 ${i + 1} 节`, href });
  });

  // ⑤ nav.xhtml（EPUB3）
  files.push({
    path: 'OEBPS/nav.xhtml',
    data: enc.encode(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>目录</h1>
<ol>
${navPoints.map((p) => `<li><a href="${p.href}">${xmlEscape(p.title)}</a></li>`).join('\n')}
</ol>
</nav>
</body>
</html>`),
  });

  // ④ toc.ncx（EPUB2 兼容；老阅读器只认它）
  files.push({
    path: 'OEBPS/toc.ncx',
    data: enc.encode(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${id}"/></head>
<docTitle><text>${xmlEscape(input.name)}</text></docTitle>
<navMap>
${navPoints
  .map(
    (p, i) =>
      `<navPoint id="${p.id}" playOrder="${i + 1}"><navLabel><text>${xmlEscape(p.title)}</text></navLabel><content src="${p.href}"/></navPoint>`,
  )
  .join('\n')}
</navMap>
</ncx>`),
  });

  // ⑥ content.opf
  const manifestItems = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...(cover
      ? [`<item id="cover-img" href="${cover.href}" media-type="${cover.mediaType}" properties="cover-image"/>`]
      : []),
    ...[...imgByHref].map(
      ([href, f], i) =>
        `<item id="img${String(i + 1).padStart(3, '0')}" href="${href}" media-type="${f.mediaType}"/>`,
    ),
    ...spine
      .filter((s) => s.id !== 'cover')
      .map((s) => `<item id="${s.id}" href="${s.href}" media-type="application/xhtml+xml"/>`),
    ...(cover ? ['<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>'] : []),
  ];
  files.push({
    path: 'OEBPS/content.opf',
    data: enc.encode(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>
<dc:title>${xmlEscape(input.name)}</dc:title>
<dc:creator>${xmlEscape(input.author ?? '')}</dc:creator>
<dc:language>${xmlEscape(lang)}</dc:language>
<dc:publisher>${xmlEscape(publisher)}</dc:publisher>
<dc:description>${xmlEscape(input.intro ?? '')}</dc:description>
${cover ? '<meta name="cover" content="cover-img"/>' : ''}
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>
${manifestItems.join('\n')}
</manifest>
<spine toc="ncx">
${spine.map((s) => `<itemref idref="${s.id}"/>`).join('\n')}
</spine>
</package>`),
  });

  const deflate = opts.deflate === null ? undefined : (opts.deflate ?? browserDeflate);
  return zipFiles(files, { deflate });
}
