/**
 * `#620` **导出 TXT** —— 逐条移植上游
 * `F:\legado\app\src\main\java\io\legado\app\service\ExportBookService.kt` 的
 * `exportTxt:375-403` + `getAllContents:732-766` + `getExportData:768-796`
 * （配合 `HtmlFormatter.kt:31-52` 的 `format`/`formatIntro`）。
 *
 * ## 成品的形态（照上游一字不差，别「美化」）
 *
 * ```
 * 书名
 * 作者：某某
 * 简介：
 * 第一段简介
 * 第二段简介
 *
 * 　　第一章 标题
 * 　　第一段
 * 　　第二段
 *
 * 　　第二章 标题
 * 　　……
 * ```
 *
 * 三个容易改错的地方：
 *
 * 1. **每章开头是两个换行**（上游 `Pair("\n\n$content1", …)`）。正文段落之间**只有单个换行**
 *    ——`HtmlFormatter.formatText` 把 `\s*\n+\s*` 折成 `\n` + 段首缩进，所以「段间空行」在
 *    上游是不存在的。想加空行会与上游导出的文件不一致。
 * 2. **标题也带段首缩进**（`　　`，两个全角空格）：标题是拼进 `mContent` 之后**整体**过
 *    `format` 的（`ContentProcessor.kt:253` `mContent = title + "\n" + mContent`），不是单独处理。
 * 3. **没正文的章节整块跳过（连标题都不写）**：`getChapterContentForExport` 返回 null 时
 *    上游 `getExportData` 返回 `Pair("", null)`。而**卷**是例外 ——
 *    `resolveExportChapterContent(content, isVolume)`：卷即使没正文也返回 `""`，
 *    于是只写一行卷标题（卷在书里就是个分节标记）。
 *
 * ## 书头里的「简介」
 * 上游 `intro_show` = `简介：%s`，`%s` 是 `"\n" + HtmlFormatter.format(intro)`
 * ⇒ 实际是 `简介：` 换行后跟简介正文，**缩进与正文同为 `　　`**（`getAllContents:741-744` 用的是
 * `format` 而不是 `formatIntro`）。
 *
 * ## 段首缩进落在「每行」而不是「每段」
 * `HtmlFormatter.formatText` 的规则是「`\s*\n+\s*` → `\n` + 缩进」，所以：
 * **首行不缩进**（除非原文就以空白开头），后续行都缩进。这带来一个看着别扭但必须照抄的结果：
 * 章节标题（拼接后是首行）**不带缩进**，正文各段带缩进。前几版注释写成「标题也缩进」是错的，
 * 已按上游 `ContentProcessor.kt:253` + `HtmlFormatter.kt:44-47` 逐行核对改正。
 */

import { sanitizeExportContent, removeExportImages } from './sanitize';

/** 段首缩进（上游 `HtmlFormatter.format` 的 `paragraphIndent`） */
export const TXT_INDENT = '　　';

/** 文件名非法字符（上游 `AppPattern.fileNameRegex2`，注意**不含** `.`） */
const ILLEGAL_FILENAME = /[\\/:*?"<>|]/g;

/**
 * 上游 `Book.getExportFileName`：默认名 = `"{书名} 作者：{作者}.{后缀}"`，再去除非法字符。
 *
 * 注意作者为空时上游**照样**写「作者：」——`getRealAuthor()` 在无作者时返回空串，
 * 于是文件名是 `书名 作者：.txt`。照抄（改成省略会让「导出的文件与手机端不一致」难以解释）。
 */
export function exportFileName(name: string, author: string | undefined, suffix: string): string {
  const raw = `${String(name ?? '').trim() || '未命名'} 作者：${String(author ?? '').trim()}.${suffix}`;
  return raw.replace(ILLEGAL_FILENAME, '_');
}

/**
 * 上游 `HtmlFormatter.formatText` 的**纯文本等价物**（我们的正文已经是 `paragraphs`，
 * 没有 HTML 可剥，只需做「折空行 + 段首缩进」）。
 *
 * 三段替换与上游同序：
 *   · `\s*\n+\s*` → `"\n" + indent`（折掉空行，并给下一行加缩进）
 *   · `^[\n\s]+` → indent（首行缩进）
 *   · `[\n\s]+$` → ``（去尾空白/换行）
 */
export function formatExportText(text: string, indent: string = TXT_INDENT): string {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n+\s*/g, '\n' + indent)
    .replace(/^[\n\s]+/, indent)
    .replace(/[\n\s]+$/, '');
}

/** 导出一章所需的最小形态（`paragraphs == null` = 没有正文，见文件头注 3） */
export interface ExportChapterLike {
  title: string;
  paragraphs?: string[] | null;
  isVolume?: boolean;
}

export interface TxtBuildInput {
  name: string;
  author?: string;
  intro?: string;
  chapters: readonly ExportChapterLike[];
  /** 是否写章节标题（上游 `!AppConfig.exportNoChapterName`，默认 true） */
  includeChapterTitle?: boolean;
  /** 是否写书头（书名 / 作者 / 简介）。上游**恒写**，默认 true；导出单章时可关 */
  includeHeader?: boolean;
}

/**
 * 上游 `resolveExportChapterContent(content, isVolume)`：
 * 有正文 ⇒ 正文；卷 ⇒ `''`；其余 ⇒ `null`（**整章跳过**）。
 */
export function resolveExportChapterContent(c: ExportChapterLike): string | null {
  if (c.paragraphs != null) return c.paragraphs.join('\n');
  return c.isVolume ? '' : null;
}

/** 书头（书名 / 作者 / 简介）—— 上游 `getAllContents:738-746` 的 `qy` */
export function buildTxtHeader(input: Pick<TxtBuildInput, 'name' | 'author' | 'intro'>): string {
  const name = String(input.name ?? '').trim();
  const author = String(input.author ?? '').trim();
  // 上游 `getAllContents:741-744` 用的是 `HtmlFormatter.format`（缩进 `　　`），
  // 不是 `formatIntro`（那个是列表页展示用的、缩进为空）—— 这里必须用前者。
  const intro = formatExportText(String(input.intro ?? '').trim(), TXT_INDENT);
  return sanitizeExportContent(`${name}\n作者：${author}\n简介：\n${intro}`);
}

/** 单章块（含标题；上游 `getExportData` 的 `"\n\n" + format(...)`） */
export function buildTxtChapterBlock(c: ExportChapterLike, includeChapterTitle = true): string | null {
  const body = resolveExportChapterContent(c);
  if (body == null) return null;
  // txt 装不了图 ⇒ 全部 `<img>` 去掉（上游 `removeExportImages`），再剔段评图与不可见字符
  const clean = sanitizeExportContent(removeExportImages(body));
  const title = String(c.title ?? '').replace(/\r?\n+/g, ' ').trim();
  const merged = includeChapterTitle && title ? `${title}\n${clean}` : clean;
  return '\n\n' + formatExportText(merged);
}

/** 整本 txt */
export function buildTxt(input: TxtBuildInput): string {
  const parts: string[] = [];
  if (input.includeHeader !== false) parts.push(buildTxtHeader(input));
  const withTitle = input.includeChapterTitle !== false;
  for (const c of input.chapters) {
    const block = buildTxtChapterBlock(c, withTitle);
    if (block != null) parts.push(block);
  }
  // 上游是逐段 `bw.write(text)` 追加，末尾不会补换行 ⇒ 这里 join 后再补一个（文本文件惯例，
  // 且与「追加多章」的结果一致：块本身以 \n\n 开头，所以 join('') 即可）
  return parts.join('');
}
