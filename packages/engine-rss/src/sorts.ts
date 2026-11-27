/**
 * RSS 分类（`sortUrl` → `[名称, url]`）—— 对齐上游 `RssSourceExtensions.kt`（2026-10-07 精读全文 113 行）。
 *
 * ## 上游三段（逐条对照，不猜测）
 *  1. `isRssSortScript` / `extractRssSortScript`（:29-47）：
 *     `@js:` ⇒ 取前缀之后**全部**；`<js>…</js>` ⇒ 取**首标签之后、`lastIndexOf("</js>")` 之前**。
 *     ⚠️ 上游这两处 `startsWith` **大小写敏感**（`RssViewModel.getSingleUrl` 那个才是
 *     忽略大小写 —— 同一字段两处口径不同，本文件照 `isRssSortScript` 走，保持敏感）。
 *  2. `resolveRssSortUrls`（:63-83）：是脚本 ⇒ 用**缓存结果**或执行脚本（异常吞掉 → null）；
 *     不是脚本 ⇒ 原值。`RssSource.sortUrls()` 负责 ACache 缓存（本仓进程内缓存，见 engine.ts）。
 *  3. `parseRssSortUrls`（:49-61）：按 `(?:&&|\r?\n)+` 切分；每项 `substringAfter("::")` 的 **trim 非空
 *     才算一条**，名称 = `substringBefore("::")` 的 trim；**一条都解析不出 ⇒ 回落 `[['', sourceUrl]]`**
 *     （= 一个无名分类，url 就是源地址）。
 *
 * ## 与本仓分工
 * 这里**只**产出「名称 + 相对/绝对 url 模板」—— 绝对化、`{{page}}` 求值、`,{options}` 剥离
 * 仍由 `env.buildFeedUrl` 在真正请求时做（与上游 `AnalyzeUrl(baseUrl=sourceUrl)` 同序）。
 * 所以 `url` 可以长成 `/Articles`（相对）、`https://…/page/{{page}}`（带模板）、甚至空串。
 *
 * ## 为什么单独一个文件
 * `parseRssSortUrls` / `rssSortScript` 是**纯函数**（可单测、零 IO），
 * 而「执行 JS 取分类串」要 env/求值器（在 engine.ts）—— 分开才能既测准又不绕大圈。
 */

import type { RssSourceRule } from './model/rss-source';

/** 上游 `sortSeparator = Regex("(?:&&|\\r?\\n)+")` —— 连续的 `&&`/换行合起来算**一个**分隔符 */
const SORT_SEPARATOR = /(?:&&|\r?\n)+/;

/**
 * 取出 sortUrl 里的脚本正文（不是脚本型 ⇒ null）。
 * 对齐上游 `extractRssSortScript`：脚本体为空 ⇒ null（上游 `takeIf { it.isNotBlank() }`）。
 */
export function rssSortScript(sortUrl: string | null | undefined): string | null {
  const s = sortUrl ?? '';
  if (s.startsWith('@js:')) {
    const code = s.slice(4).trim();
    return code || null;
  }
  if (s.startsWith('<js>')) {
    const close = s.lastIndexOf('</js>');
    if (close < 4) return null; // 没有闭合标签（上游同：closeIndex < prefix.length ⇒ null）
    const code = s.slice(4, close).trim();
    return code || null;
  }
  return null;
}

/**
 * 切分分类串 → `[名称, url]` 列表（对齐上游 `parseRssSortUrls`）。
 *
 * ★ 上游语义里**名称可以为空**（回落项），所以调用方必须能处理「无名分类」——
 *   本仓把它交给前端「单分类无名 ⇒ 不渲染分类条」的判据（见 DiscoverView）。
 *
 * ## 回落为什么不直接照抄上游的 `sourceUrl`
 * 上游 `parseRssSortUrls` 的 `ifEmpty { listOf("" to sourceUrl) }` 是给
 * `RssSource.sortUrls()` 这条路径用的。但**非空、且没有 `::` 可切的单 URL sortUrl**
 * 在上游另有明确语义 —— 都是「原样当请求地址」：
 *  · `RssViewModel.getSingleUrl`（`ui/main/rss/RssViewModel.kt:67-71`）：
 *    `if (sortUrl.contains("::")) split("::")[1] else sortUrl`；
 *  · `RssSortActivity.upFragments`（`ui/rss/article/RssSortActivity.kt:361`）：
 *    `listOf(Pair("", url))`（单个无名分类，url 就是它本身）。
 * 本仓只有一条路径，若也回落 `sourceUrl`，用户配的单 URL `sortUrl` 会被**静默忽略**
 * （表现为「配了 sortUrl 却按 sourceUrl 请求」）—— 所以这里按后者处理。
 * 真正的空 `sortUrl` 仍回落 `sourceUrl`（与上游一致）。
 */
export function parseRssSortUrls(
  value: string | null | undefined,
  sourceUrl: string,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const item of (value ?? '').split(SORT_SEPARATOR)) {
    const idx = item.indexOf('::');
    // 上游 `substringAfter("::", "")`：没有 `::` ⇒ 空串 ⇒ 该条被丢弃
    const url = (idx < 0 ? '' : item.slice(idx + 2)).trim();
    if (!url) continue;
    const name = (idx < 0 ? item : item.slice(0, idx)).trim();
    entries.push([name, url]);
  }
  if (entries.length) return entries;
  const raw = (value ?? '').trim();
  return [['', raw || sourceUrl]];
}

/** 供 engine 使用：rule.sortUrl 为空时也走「无名单分类 = 源地址」的回落语义 */
export function fallbackSorts(sourceUrl: string): Array<{ name: string; url: string }> {
  return [{ name: '', url: sourceUrl }];
}

/** 源是否有「可解析的分类」（非空 sortUrl）—— 前端/引擎据它决定是否显示分类条 */
export function hasConfiguredSortUrl(rule: Pick<RssSourceRule, 'sortUrl'>): boolean {
  return !!rule.sortUrl?.trim();
}
