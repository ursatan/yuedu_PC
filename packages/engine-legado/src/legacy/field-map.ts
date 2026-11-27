/**
 * 旧版书源（v1，扁平 ruleXxx 字段）→ 新版（v3，嵌套 ruleXxx 对象）字段映射表
 *
 * 数据来源（逐条提取，未经推断）：
 *   LegadoTeam/legado @3.26082823
 *   app/src/main/java/io/legado/app/help/storage/ImportOldData.kt
 *   fun fromOldBookSource(jsonItem: DocumentContext): BookSource   L176-264
 *
 * 旧版判定依据（BookSourceEditViewModel.importSource L113 / L121）：
 *   JSON 文本包含 "ruleSearchUrl" 或 "ruleFindUrl" 即视为旧版
 */

/** 转换器名称，对应 migrate.ts 中的实现 */
export type ConverterName =
  | 'toNewRule'
  | 'toNewUrl'
  | 'toNewUrls'
  | 'uaToHeader'
  | 'contentDollar'
  | 'legacyTypeFromString';

export interface LegacyFieldMapping {
  /** 旧版扁平字段名 */
  readonly legacy: string;
  /** 新版 JSON 路径（点分） */
  readonly path: string;
  /** 需要的转换器；缺省表示纯字段搬运 */
  readonly convert?: ConverterName;
  /** 多个转换器时按顺序执行 */
  readonly convertChain?: readonly ConverterName[];
  readonly note?: string;
}

export const LEGACY_FIELD_MAP: readonly LegacyFieldMapping[] = [
  // ── BookSource 顶层（7 条）──────────────────────────────
  { legacy: 'bookSourceUrl', path: 'bookSourceUrl', note: '缺失即抛「格式不对」' },
  { legacy: 'bookSourceName', path: 'bookSourceName' },
  { legacy: 'bookSourceGroup', path: 'bookSourceGroup' },
  { legacy: 'loginUrl', path: 'loginUrl' },
  { legacy: 'loginUi', path: 'loginUi' },
  { legacy: 'loginCheckJs', path: 'loginCheckJs' },
  { legacy: 'coverDecodeJs', path: 'coverDecodeJs' },
  { legacy: 'bookSourceComment', path: 'bookSourceComment' },
  { legacy: 'ruleBookUrlPattern', path: 'bookUrlPattern' },
  { legacy: 'serialNumber', path: 'customOrder', note: 'Int，缺失为 0' },
  { legacy: 'httpUserAgent', path: 'header', convert: 'uaToHeader', note: '裸 UA 串 → {"User-Agent":"..."} JSON' },
  { legacy: 'ruleSearchUrl', path: 'searchUrl', convert: 'toNewUrl' },
  { legacy: 'ruleFindUrl', path: 'exploreUrl', convert: 'toNewUrls' },
  {
    legacy: 'bookSourceType',
    path: 'bookSourceType',
    convert: 'legacyTypeFromString',
    note: '旧版为字符串，仅 "AUDIO" → 1，其余一律 0',
  },
  { legacy: 'enable', path: 'enabled', note: 'Boolean，缺失为 true' },

  // ── ruleSearch（8 条）───────────────────────────────────
  { legacy: 'ruleSearchList', path: 'ruleSearch.bookList', convert: 'toNewRule' },
  { legacy: 'ruleSearchName', path: 'ruleSearch.name', convert: 'toNewRule' },
  { legacy: 'ruleSearchAuthor', path: 'ruleSearch.author', convert: 'toNewRule' },
  { legacy: 'ruleSearchIntroduce', path: 'ruleSearch.intro', convert: 'toNewRule' },
  { legacy: 'ruleSearchKind', path: 'ruleSearch.kind', convert: 'toNewRule' },
  { legacy: 'ruleSearchNoteUrl', path: 'ruleSearch.bookUrl', convert: 'toNewRule' },
  { legacy: 'ruleSearchCoverUrl', path: 'ruleSearch.coverUrl', convert: 'toNewRule' },
  { legacy: 'ruleSearchLastChapter', path: 'ruleSearch.lastChapter', convert: 'toNewRule' },

  // ── ruleExplore（8 条）──────────────────────────────────
  { legacy: 'ruleFindList', path: 'ruleExplore.bookList', convert: 'toNewRule' },
  { legacy: 'ruleFindName', path: 'ruleExplore.name', convert: 'toNewRule' },
  { legacy: 'ruleFindAuthor', path: 'ruleExplore.author', convert: 'toNewRule' },
  { legacy: 'ruleFindIntroduce', path: 'ruleExplore.intro', convert: 'toNewRule' },
  { legacy: 'ruleFindKind', path: 'ruleExplore.kind', convert: 'toNewRule' },
  { legacy: 'ruleFindNoteUrl', path: 'ruleExplore.bookUrl', convert: 'toNewRule' },
  { legacy: 'ruleFindCoverUrl', path: 'ruleExplore.coverUrl', convert: 'toNewRule' },
  { legacy: 'ruleFindLastChapter', path: 'ruleExplore.lastChapter', convert: 'toNewRule' },

  // ── ruleBookInfo（8 条）─────────────────────────────────
  { legacy: 'ruleBookInfoInit', path: 'ruleBookInfo.init', convert: 'toNewRule' },
  { legacy: 'ruleBookName', path: 'ruleBookInfo.name', convert: 'toNewRule' },
  { legacy: 'ruleBookAuthor', path: 'ruleBookInfo.author', convert: 'toNewRule' },
  { legacy: 'ruleIntroduce', path: 'ruleBookInfo.intro', convert: 'toNewRule' },
  { legacy: 'ruleBookKind', path: 'ruleBookInfo.kind', convert: 'toNewRule' },
  { legacy: 'ruleCoverUrl', path: 'ruleBookInfo.coverUrl', convert: 'toNewRule' },
  { legacy: 'ruleBookLastChapter', path: 'ruleBookInfo.lastChapter', convert: 'toNewRule' },
  { legacy: 'ruleChapterUrl', path: 'ruleBookInfo.tocUrl', convert: 'toNewRule' },

  // ── ruleToc（4 条）──────────────────────────────────────
  { legacy: 'ruleChapterList', path: 'ruleToc.chapterList', convert: 'toNewRule' },
  { legacy: 'ruleChapterName', path: 'ruleToc.chapterName', convert: 'toNewRule' },
  {
    legacy: 'ruleContentUrl',
    path: 'ruleToc.chapterUrl',
    convert: 'toNewRule',
    note: '⚠️ 旧版 ruleContentUrl 映射到 TocRule.chapterUrl，不是 ContentRule。命名易混淆',
  },
  { legacy: 'ruleChapterUrlNext', path: 'ruleToc.nextTocUrl', convert: 'toNewRule' },

  // ── ruleContent（3 条）──────────────────────────────────
  {
    legacy: 'ruleBookContent',
    path: 'ruleContent.content',
    convertChain: ['toNewRule', 'contentDollar'],
    note: '先规则语法迁移，再处理 $ 前缀',
  },
  { legacy: 'ruleBookContentReplace', path: 'ruleContent.replaceRegex', convert: 'toNewRule' },
  { legacy: 'ruleContentUrlNext', path: 'ruleContent.nextContentUrl', convert: 'toNewRule' },
] as const;

/** 旧版判定：含任一关键词即为 v1 格式 */
export const LEGACY_MARKERS = ['ruleSearchUrl', 'ruleFindUrl'] as const;

export function isLegacySourceObject(text: string): boolean {
  return LEGACY_MARKERS.some((m) => text.includes(m));
}

/** 旧版源里出现、但新版须丢弃或特殊处理的字段 */
export const LEGACY_DROPPED_FIELDS = [
  'ruleSearchUrl',
  'ruleFindUrl',
  'httpUserAgent',
  'serialNumber',
  'enable',
] as const;
