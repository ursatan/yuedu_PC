/**
 * Legado 书源数据模型（L1 需要的最小子集）
 *
 * 字段名对齐官方 BookSource / SearchRule / BookInfoRule / TocRule / ContentRule。
 * 全部可选：导入时允许字段缺失（见 docs/01-开发计划.md §5.9 对象/字符串双形态）。
 */

import { isLegacyFlatSource, migrateLegacySource } from '../legacy/migrate';
import { isLegadoBookSource } from '@yuedu/core/contract';

export interface RuleSearch {
  bookList?: string;
  name?: string;
  author?: string;
  coverUrl?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
  bookUrl?: string;
  wordCount?: string;
  searchUrl?: string;
  checkKeyWord?: string;
  nextUrl?: string;
}

export interface RuleExplore {
  bookList?: string;
  name?: string;
  author?: string;
  coverUrl?: string;
  intro?: string;
  kind?: string;
  bookUrl?: string;
  [k: string]: string | undefined;
}

export interface RuleBookInfo {
  name?: string;
  author?: string;
  coverUrl?: string;
  intro?: string;
  kind?: string;
  lastChapter?: string;
  bookUrl?: string;
  wordCount?: string;
  tocUrl?: string;
  [k: string]: string | undefined;
}

export interface RuleToc {
  /** 目录更新前脚本（Legado：更新目录时执行，可用 java.refreshTocUrl / java.reGetBook） */
  preUpdateJs?: string;
  chapterList?: string;
  chapterName?: string;
  chapterUrl?: string;
  /** 章节名格式化 JS（bindings: index / gInt / title / chapter），返回值作为章节名 */
  formatJs?: string;
  /** 卷标题判定（命中即为分节标题，无正文） */
  isVolume?: string;
  isVip?: string;
  isPay?: string;
  updateTime?: string;
  nextTocUrl?: string;
  [k: string]: string | undefined;
}

export interface RuleContent {
  content?: string;
  /** 副文规则：歌词 / 弹幕 / 追加正文（值为 http 开头时先抓该 URL） */
  subContent?: string;
  /** 章节标题规则（有些站点只能在正文页取标题；命中 <img> 时拆出图片） */
  title?: string;
  nextContentUrl?: string;
  /** 正文页 JS（抓下一页时作为 AnalyzeUrl 的 jsStr 注入） */
  webJs?: string;
  sourceRegex?: string;
  replaceRegex?: string;
  /** 图片展示样式：DEFAULT / FULL / TEXT / SINGLE */
  imageStyle?: string;
  /** 图片 bytes 二次解密 JS（返回解密后的 bytes） */
  imageDecode?: string;
  /** 购买操作：js 或含 {{js}} 的 url */
  payAction?: string;
  /** 事件回调 JS */
  callBackJs?: string;
  [k: string]: string | undefined;
}

/**
 * 段评规则（`#539` 字段对齐上游 `ReviewRule.kt`，2026-10-20 对差）。
 *
 * 上游口径：`data/entities/rule/ReviewRule.kt` —— 30 个可选字段，分四组：
 *  · 基础：reviewUrl / avatarRule / contentRule / postTimeRule / reviewQuoteUrl
 *  · 互动：voteUpUrl / voteDownUrl / postReviewUrl / postQuoteUrl / deleteUrl
 *  · 摘要：reviewSummaryUrl / summaryListRule / summaryParagraphIndexRule /
 *    summaryParagraphDataRule / summaryCountRule
 *  · 详情+回复：reviewDetailUrl / reviewDetailNextPageUrl / detailListRule / detailIdRule /
 *    detailAvatarRule / detailNameRule / detailBadgeRule / detailContentRule /
 *    replyListRule / replyIdRule / replyAvatarRule / replyNameRule / replyBadgeRule /
 *    replyContentRule
 *
 * ⚠️ 只做**字段对齐**（导入/编辑/导出不丢数据）；段评的引擎求值与 UI **未实现**
 *    （语料 0 覆盖；上游自己的注释也写「这些功能将在以上功能完成以后实现」）⇒
 *    处置记录见 `docs/live/capability-inventory.md`。
 *
 * 上游 `jsonDeserializer` 兼容**字符串旧格式**（整个值就是 reviewUrl）⇒ 编译时规范化成对象。
 */
export interface ReviewRule {
  reviewUrl?: string;
  avatarRule?: string;
  contentRule?: string;
  postTimeRule?: string;
  reviewQuoteUrl?: string;
  voteUpUrl?: string;
  voteDownUrl?: string;
  postReviewUrl?: string;
  postQuoteUrl?: string;
  deleteUrl?: string;
  enabled?: boolean;
  reviewSummaryUrl?: string;
  summaryListRule?: string;
  summaryParagraphIndexRule?: string;
  summaryParagraphDataRule?: string;
  summaryCountRule?: string;
  reviewDetailUrl?: string;
  reviewDetailNextPageUrl?: string;
  detailListRule?: string;
  detailIdRule?: string;
  detailAvatarRule?: string;
  detailNameRule?: string;
  detailBadgeRule?: string;
  detailContentRule?: string;
  replyListRule?: string;
  replyIdRule?: string;
  replyAvatarRule?: string;
  replyNameRule?: string;
  replyBadgeRule?: string;
  replyContentRule?: string;
  [k: string]: unknown;
}

export interface BookSource {
  bookSourceName?: string;
  /** 封面图片二次解密 JS（Legado BaseSource.coverDecodeJs，ImageUtils.getRuleJs） */
  coverDecodeJs?: string;
  bookSourceUrl?: string;
  bookSourceType?: number; // 0文本 1音频 2图片 3文件 4视频
  bookSourceGroup?: string;
  enabledExplore?: boolean;
  enabledCookieJar?: boolean;
  /** 启用状态（启用/禁用、搜索、发现）—— 见 @yuedu/core SourceState */
  state?: import('@yuedu/core').SourceState;
  header?: string;
  jsLib?: string;
  searchUrl?: string;
  exploreUrl?: string;
  /**
   * **详情页 URL 正则**（上游 `data/entities/BookSource.kt:43` `var bookUrlPattern: String?`）。
   *
   * 语义（`#617`，对齐 `BookList.kt:62-78`）：搜索时若这个正则**整串匹配**响应 URL，
   * 说明「搜索」拿回来的其实已经是**详情页** ⇒ 不走 `ruleSearch.bookList` 列表规则，
   * 直接用 `ruleBookInfo` 解析单本（上游 `getInfoItem`）。
   *
   * 语料覆盖 `data/sources/book-482`：**106/485** 源带该字段（文本 91 / 图片 15 /
   * 音频·文件 0）——典型形态是「搜索接口直接回一本书的详情 JSON/HTML」（晋江、
   * 小米阅读、恋听网、听友M、爱丽丝书屋…），这些源过去被当列表页解析 ⇒ 0 条。
   *
   * ⚠️ 迁移键：旧版是 `ruleBookUrlPattern`（见 `legacy/field-map.ts` + `legacy/migrate.ts`）。
   */
  bookUrlPattern?: string;
  ruleSearch?: RuleSearch;
  ruleExplore?: RuleExplore;
  ruleBookInfo?: RuleBookInfo;
  ruleToc?: RuleToc;
  ruleContent?: RuleContent;
  /** `#539` 段评规则（字段对齐上游 ReviewRule.kt；功能未实现，仅保数据不丢） */
  ruleReview?: ReviewRule;
  // 其余 117 字段容错：允许任意附加字段
  [k: string]: unknown;
}

/** 编译后的书源（一期仅做规范化 + 校验，规则仍是字符串，运行时由选择器引擎解析） */
export type CompiledBookSource = BookSource;

/**
 * 判定一份配置是不是 Legado 书源。
 *
 * ★ 判据**不在这里** —— 唯一实现在 `@yuedu/core/contract` 的 `isLegadoBookSource`
 *   （`#312`：此前 facade 的 `looksLegado` 与本函数各写一份，且**已经漂移**，
 *   同一个源在导入层与引擎层会得到相反结论）。本函数只作引擎侧入口的薄包装。
 *
 * 上游口径（逐字）：`BookSourceImport.kt:122-126` `requireBookSourceUrl()` —— **主键非空即书源**；
 * 官方测试里 `{"bookSourceUrl":"…","bookSourceName":"One"}`（**无任何规则字段**）判有效。
 * ⚠️ 本仓曾自我发明「必须有 searchUrl/ruleSearch/ruleBookInfo/ruleToc 之一」
 *   ⇒ 纯发现源（只有 exploreUrl）被判「不是 Legado 书源」而导入失败（`#312`）。
 */
export function detectBookSource(raw: unknown): boolean {
  return isLegadoBookSource(raw);
}

export interface CompileOutcome {
  ok: boolean;
  rule?: CompiledBookSource;
  issues: Array<{ level: 'error' | 'warn' | 'info'; path?: string; message: string }>;
}

/** 预编译：规范化类型 + 静态校验（不抛错，问题写入 issues） */
/**
 * HTML 分发源包容错：还原规则字段里的 HTML 实体。
 *
 * 背景（2026-09-17 实测）：中文源包常以**网页形式**分发，字段里会残留实体
 * （`&lt;js&gt;`、`&amp;`）。Legado 的 `<js>` 标记一旦变成 `&lt;js&gt;` 就**不再被识别为内联脚本**
 * → 引擎把整段脚本文本当 URL 请求 → 分类条恒空（实测「松鹤庭沐·言璃版」：
 * 还原前 0 分类、且真的去请求了 `https://so.html5.qq.com/&lt;js&gt;var%20U=…`；还原后 **121 分类 + 20 条内容**）。
 *
 * ⚠️ **必须窄**（踩过的坑，别放宽）：
 * 1. **不动 `jsLib`**：实测把 jsLib 一起还原会让脚本报 `Invalid or unexpected token`
 *    （实体还原会把 JS 字符串字面量里的 `&quot;` 变成引号 → 字符串提前闭合）。
 * 2. **不动 `ruleContent`**：正文规则里可能出现 `/&amp;/g` 这类**要用实体本身做匹配**的正则，
 *    还原会把它改成 `/&/` 从而改坏规则。
 * 因此只处理「URL / 选择器 / 登录」这类字段，且只在该字段确实含实体时才改写。
 */
const HTML_ENTITY_FIELDS = [
  'searchUrl',
  'exploreUrl',
  'tocUrl',
  'nextTocUrl',
  'bookUrl',
  'header',
  'loginUrl',
  'loginCheckJs',
] as const;

/** `rule*` 里可安全还原的子字段所属规则（不含 ruleContent，理由见上） */
const HTML_ENTITY_RULES = ['ruleSearch', 'ruleExplore', 'ruleBookInfo', 'ruleToc'] as const;

function unescapeEntitiesInRules(src: Record<string, unknown>): number {
  let changed = 0;
  const fix = (s: string): string => {
    if (!/&(lt|gt|amp|nbsp|quot|apos|#\d+);/.test(s)) return s;
    changed++;
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, '&');
  };
  for (const k of HTML_ENTITY_FIELDS) {
    const v = src[k];
    if (typeof v === 'string') src[k] = fix(v);
  }
  for (const rk of HTML_ENTITY_RULES) {
    const obj = src[rk];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [kk, vv] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof vv === 'string') (obj as Record<string, unknown>)[kk] = fix(vv);
    }
  }
  return changed;
}

export function compileBookSource(raw: unknown): CompileOutcome {
  const issues: CompileOutcome['issues'] = [];
  // 旧版扁平格式（v1 / ruleChapterList 时代）先迁移到新版结构（对齐 Legado ImportOldData.kt）——
  // 此前迁移器从未被调用（死代码），旧格式源导入后 ruleToc/ruleContent 全空 → 详情 0 章。
  // 注意：detectBookSource 只认新格式结构，必须先迁移再判定。
  const normalized = isLegacyFlatSource(raw) ? migrateLegacySource(raw as Record<string, unknown>) : raw;
  if (!detectBookSource(normalized)) {
    return { ok: false, issues: [{ level: 'error', message: '不是 Legado 书源' }] };
  }
  const src = normalized as BookSource;
  // HTML 分发源包容错：还原规则字段里的实体（`&lt;js&gt;` → `<js>`、`&amp;` → `&`）——
  // 否则 `<js>` 内联脚本不被识别，整段脚本文本会被当 URL 请求（实测「松鹤庭沐」分类条恒空）。
  const unescaped = unescapeEntitiesInRules(src as unknown as Record<string, unknown>);
  if (unescaped > 0) {
    issues.push({
      level: 'info',
      path: 'rule',
      message: `已还原 ${unescaped} 处 HTML 实体（源包以网页形式分发，字段残留 &lt;js&gt;/&amp; 等）`,
    });
  }
  // 规范化数字
  if (src.bookSourceType != null && typeof src.bookSourceType === 'string') {
    src.bookSourceType = Number(src.bookSourceType);
  }
  // `#539` 段评字符串旧格式规范化（上游 jsonDeserializer 同语义：整个值就是 reviewUrl）
  if (typeof src.ruleReview === 'string') {
    src.ruleReview = { reviewUrl: src.ruleReview };
  }
  // 校验：搜索至少需要一个入口
  const hasSearch = !!(src.searchUrl || src.ruleSearch?.searchUrl || src.ruleSearch?.bookList);
  if (!hasSearch) {
    issues.push({ level: 'warn', path: 'ruleSearch', message: '缺少搜索入口（searchUrl / ruleSearch）' });
  }
  // 校验：详情至少需要 toc 或 bookInfo
  if (!src.ruleBookInfo && !src.ruleToc) {
    issues.push({ level: 'info', path: 'ruleBookInfo', message: '未配置详情/目录规则' });
  }
  const ok = !issues.some((i) => i.level === 'error');
  return { ok, rule: src, issues };
}
