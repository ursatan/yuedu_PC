/**
 * `#620` **导出时的正文清洗** —— 逐条移植上游
 * `F:\legado\app\src\main\java\io\legado\app\service\ExportContentSanitizer.kt`
 * （46 行，2026-10-25 读源码提取）。
 *
 * 上游导出链路上有两件与阅读**不同**的清洗，缺一件用户就会看到脏数据：
 *
 * 1. `sanitizeExportContent` —— **剔掉段评图片**。段评（本章说）在正文里是
 *    `<img src="…,{style:'text',reviewCount:3,click:'getDP(1,2)'}">` 这种形态：
 *    阅读时点一下能展开评论，**导出成 txt/epub 就只是一张打不开的碎图**。
 * 2. `removeExportImages` —— txt 导出把**所有** `<img>` 去掉（txt 装不了图）。
 *    epub 则相反：保留图片（上游 `exportPictureFile` 只是额外另存一份图片文件）。
 * 3. 两者都顺带删 `\u200B`（零宽空格）与 `\uFEFF`（BOM）—— 这类字符进了 txt 就是
 *    「看着有空格、实际没有」的排障噩梦。
 *
 * ⚠️ 判据（`isExportReviewImage`）**只认高度特征**：普通插图哪怕来自段评站点也不会被误删。
 * 三种形态按上游顺序：
 *   a. `click` 是 `getDP(\d+,\d+)` 或 `getZP(\d+)`            → 段评
 *   b. `click` 是 `dpshow(n)`/`zpshow(n)`（忽略大小写）**且** `js` 是 `dpurl(…)`/`zpurl(…)` → 段评
 *   c. `style` 为 `text`/`TEXT` **且** `reviewCount > 0` **且** `click` 非空        → 段评
 */

import { urlOptionText } from '../source-match';

/** 上游 `AppPattern.imgPattern`（**只认双引号 src**，上游如此；单引号插图不会被这里处理） */
const IMG_PATTERN = /<img[^>]*src="([^"]*(?:"[^>]+\})?)"[^>]*>/g;

/**
 * 同一只正则 **导出给 `#626`**（图片转存要按 `src` 改写路径）。
 *
 * 为什么必须共用而不是各写一条：这条正则的怪样子（`(?:"[^>]+\})?` 那截）是为
 * 「src 里带 `,{...}` 选项尾巴、内层引号被写成实体」这类真实形态专门调的；
 * 复制一份改一处忘一处，就会出现「净化剔掉了这张图、转存又去抓它」这种自相矛盾。
 */
export const EXPORT_IMG_PATTERN = IMG_PATTERN;
/** 导出前一律删掉的不可见字符 */
const INVISIBLE = /[\u200B\uFEFF]/g;

const REV_CLICK = /^(?:getDP\(\s*\d+\s*,\s*\d+\s*\)|getZP\(\s*\d+\s*\))$/;
const REV_SHOW = /^(?:dp|zp)show\(\s*\d+\s*\)$/i;
const REV_URL = /^(?:dp|zp)url\([\s\S]*\)$/i;

/** 这只 `<img>` 的 src 是不是段评图（上游 `isExportReviewImage`） */
export function isExportReviewImage(src: string | null | undefined): boolean {
  if (!src) return false;
  // src 在 HTML 属性里时，内层引号常被写成实体（`&quot;` / `&#39;`）——
  // 不还原就解析不出 click/style（实测源里两种写法都有）
  const raw = src.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
  const text = urlOptionText(raw);
  if (!text) return false; // 没有 `,{...}` 尾巴 ⇒ 不可能带 click/style/reviewCount
  let opt: Record<string, unknown>;
  try {
    opt = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 上游用 GSON 宽松模式；单引号/无引号键的源确实存在 ⇒ 正则兜底取三个键
    opt = {};
    const grab = (k: string): string | undefined => {
      const m = new RegExp(`["']?${k}["']?\\s*:\\s*(?:["']([^"']*)["']|([-\\w.]+))`).exec(text);
      return m ? (m[1] ?? m[2]) : undefined;
    };
    const click = grab('click');
    const style = grab('style');
    const js = grab('js');
    const cnt = grab('reviewCount');
    if (click !== undefined) opt['click'] = click;
    if (style !== undefined) opt['style'] = style;
    if (js !== undefined) opt['js'] = js;
    if (cnt !== undefined) opt['reviewCount'] = cnt;
  }
  const str = (k: string): string | undefined => (typeof opt[k] === 'string' ? (opt[k] as string) : undefined);
  const click = str('click');
  if (click != null && REV_CLICK.test(click.trim())) return true;
  if (click != null && REV_SHOW.test(click.trim())) {
    const js = str('js')?.trim();
    if (js != null && REV_URL.test(js)) return true;
  }
  const style = str('style');
  const rc = Number.parseInt(String(opt['reviewCount'] ?? ''), 10);
  return (style === 'text' || style === 'TEXT') && Number.isFinite(rc) && rc > 0 && !!(click && click.trim());
}

/** 剔掉段评图 + 不可见字符（上游 `sanitizeExportContent`） */
export function sanitizeExportContent(content: string): string {
  if (!content) return '';
  const out = content.replace(IMG_PATTERN, (m, src: string) => (isExportReviewImage(src) ? '' : m));
  return out.replace(INVISIBLE, '');
}

/** 删掉**所有** `<img>`（txt 导出用；上游 `removeExportImages`） */
export function removeExportImages(content: string): string {
  if (!content) return '';
  return content.replace(IMG_PATTERN, '');
}
