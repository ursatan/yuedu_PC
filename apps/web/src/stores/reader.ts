import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { runAction, runDetailStream } from '../api';

// `#207`：取数统一口（下载中心与阅读器共用同一份，见文件头说明）
import { fetchBookContent, isLocalBookSource } from '../utils/book-fetch';
// 离线缓存（IndexedDB）：章节正文的读写 + 详情/目录本地化，见 utils/chapter-cache.ts 的语义说明
import {
  getCachedChapter, putCachedChapter, countCached, clearCached, cachedChapterKeys,
  getBookMeta, putBookMeta, deleteBookMeta, setPrecacheKeys, deleteCachedByKeys, hasCachedChapter,
  chapterKey,
} from '../utils/chapter-cache';
import {
  DEFAULT_BOOK_SORT, addGroupBit, contractToShelfGroup, isInGroup, isUngrouped, nextGroupId,
  removeGroupBit, shelfGroupToContract, uniqueGroupName, type ShelfGroup,
} from '../shelf-groups';
// Phase 1.4（#66）：分组 / 书架 / 书签改为「本地缓存 + 服务端」。端点封装见 user-data.ts，
// 策略见 utils/server-sync.ts，字段映射见 utils/user-map.ts。
// ⚠️ `deleteGroup` / `listGroups` / `removeBookmark` 在本文件已有同名动作，故一律起 `Remote` 后缀别名。
import {
  deleteBook as deleteBookRemote,
  deleteBookmark as deleteBookmarkRemote,
  deleteGroup as deleteGroupRemote,
  deleteHighlight as deleteHighlightRemote,
  listBookmarks as listBookmarksRemote,
  listBooks as listBooksRemote,
  listDeletedBooks as listDeletedBooksRemote,
  listGroups as listGroupsRemote,
  listHighlights as listHighlightsRemote,
  listChapters as listChaptersRemote,
  // `#207`：`getLocalBookContent` 已并入 `utils/book-fetch.ts` 的本地书分支（不再在这里直接调）
  putBook as putBookRemote,
  putBookmark as putBookmarkRemote,
  putGroup as putGroupRemote,
  putHighlight as putHighlightRemote,
} from '../user-data';
import {
  contractToBookmark, contractToShelfBook, bookmarkToContract, encodeItemKey, shelfBookToContract,
} from '../utils/user-map';
// `#750` 详情合并语义抽成纯函数（含回归锁），语义说明见 utils/detail-merge.ts 文件头
import { mergeDetail } from '../utils/detail-merge';
import {
  getPrefs as getPrefsRemote,
  patchPrefs as patchPrefsRemote,
  putReadTime as putReadTimeRemote,
} from '../user-data';
import { createReadTimeMeter } from '../utils/read-time';
import { fetchWebDoc } from '../utils/web-doc';
// `#249` 背景图：内置图清单 + 取值解析（不认识的字符串一律当无效，见模块头注释）
import { resolveReaderBgUrl } from '../utils/reader-bg';
import { withAlpha as withAlpha01 } from '../styles/ui-theme';
import {
  mergeThemeList, inspectThemeBundle, serializeThemeBundle,
  type ThemeImportResult,
} from '../utils/theme-transfer';
import {
  createPusher, pull as pullEntity, pullObject, pushDiff, pushObject, readLocal, readLocalObject,
  reconcile as reconcileEntity, registerSyncTarget, writeLocal, writeLocalObject,
  type SyncObjectPlan, type SyncPlan, type SyncSource,
} from '../utils/server-sync';
// `#224` 视图模式（滚动 / 分页）：落 localStorage，白名单校验见模块内注释
import {
  loadInfiniteScroll, loadReaderViewMode, normalizeReaderViewMode, saveInfiniteScroll,
  saveReaderViewMode, type ReaderViewMode,
} from '../utils/reader-view-mode';
import {
  // `#163` 界面主题：判槽 / 墨水屏派生 / CSS 变量换算 / 封面参数（纯函数，见 styles/ui-theme.ts）
  coverParamsFor,
  effectiveUiTheme,
  isLightColor,
  uiNightActive,
  uiThemeVars as uiThemeVarsOf,
} from '../styles/ui-theme';
import {
  emptyGlobalReaderPrefs,
  fillGlobalReaderPrefs,
  isDefaultGlobalReaderPrefs,
  mergeReadStyle,
  effectiveReadStyleOverride,
  // `#207`：`LOCAL_TAG` 判据已并入 `utils/book-fetch.ts` 的 `isLocalBookSource()`
  localBookPayload,
  pickReadStyle,
  renderReaderInfoTemplate,
  readTipDefaultTemplate,
  type BookHighlight,
  type GlobalReaderPrefs,
  type ReadStyle,
  type ReadStyleOverride,
  type ReaderInfoValues,
  type UiCoverConfig,
  type UiThemeConfig,
  type UnifiedChapter,
  type ContentUiMark,
} from '@yuedu/core/contract';
import {
  convertChinese,
  convertChineseBatch,
  isChineseConvertOn,
} from '../utils/chinese-convert';
// `#146` 书内全文搜索（纯逻辑：片段裁剪 / 定位 / 正则护栏，见该文件顶部说明）
import {
  MAX_HITS_PER_CHAPTER,
  chapterTextOf,
  searchChapterContent,
  sortHits,
  type SearchHit,
} from '../utils/book-search';
// `#256` 高亮样式（与阅读样式的「全局下划线」**互不读写**，理由见该模块头注释）
import {
  parseHighlightStyle,
  serializeHighlightStyle,
  visibleHighlightStyle,
  type HighlightStyleView,
} from '../utils/highlight-style';
import {
  READER_COLORS,
  accentColorOf,
  normalizeThemeMode,
  readStyleColors,
  readerColorSet,
  readerContentVars,
  readerTipVars as readerTipVarsOf,
  tipVarsOf as tipVarsOfTheme,
  readerUnderlineVars,
  textColorOf,
  titleColorOf,
  type ReaderThemeMode,
} from '../styles/reader-theme';
/** `#144`：用户全局净化（替换）规则 —— 正文 / 标题的唯一应用入口见下面的 `purify()` */
import { useReplaceRulesStore } from './replaceRules';
import { useReplaceRuleFor } from '../utils/replace-rules';
export type { ShelfGroup };

/**
 * 书签（用户 4-4）。字段**照 Legado `Bookmark.kt` 逐条对齐**：
 * `time`(主键) / `bookName` / `bookAuthor` / `chapterIndex` / `chapterPos` /
 * `chapterName` / `bookText`(章节名快照) / `content`(选中文本)。
 * 本仓另加 `sourceId` —— Legado 用「书名+作者」定位书，同名书会串；加源 id 更稳。
 */
export interface Bookmark {
  time: number;
  sourceId: string;
  bookName: string;
  bookAuthor: string;
  chapterIndex: number;
  chapterPos: number;
  chapterName: string;
  bookText: string;
  content: string;
}

/** 书架条目（localStorage 持久化）。kind: book(默认)/video——影视收藏走 video */
export interface ShelfBook {  /**
   * 唯一键（`itemKey(sourceId, payload)`）。
   *
   * ⚠️ 早期版本**用书名当键**，导致两个真 bug（2026-09-16 修）：
   *  ① 同名书（不同源 / 同源不同版本）互相覆盖书架与续读进度；
   *  ② 续读定位靠"索引用"，跨书复用 → 「打开 B 书，目录却定位到 A 书读过的第 3 章」。
   * Legado 用 `bookUrl` 作 `Book` 表主键，这里是它的等价物。
   */
  key?: string;
  sourceId: string; payload: unknown; title: string; author?: string; cover?: string; kind?: string;
  /**
   * ★ `#204` 契约字段透传：`customCoverUrl`（用户换的自定义封面）+ `persistedCoverUrl`（存到本地的源封面）。
   * 展示优先级由契约层 `displayCover()` 统一编码（persisted > custom > coverUrl），
   * `contractToShelfBook` 已在用 —— **这里必须留字段**，否则「换封面」在书架上无从判断
   * 「现在是自定义封面还是源封面」（清除按钮就没法决定该不该亮）。
   */
  customCoverUrl?: string | null;
  persistedCoverUrl?: string | null;
  lastChapter?: { title: string; payload: unknown }; lastIdx?: number; updatedAt?: number;
  /**
   * `lastIdx` = 已读到第几章（**0 基**）—— 对应 Legado `Book.durChapterIndex`。
   * 未读章节数 / 阅读进度条都由它 + `totalChapterNum` 推出，判据见 `readProgressOf` / `unreadOf`。
   */
  /**
   * 播放进度（秒）。**对齐 OmniFlow** 的 `progressSec`/`durationSec`（影视库进度条用）。
   * 仅视频类会写；由 `PlayerOverlay` 节流上报（见 `recordProgress`）。
   */
  progressSec?: number;
  durationSec?: number;
  /**
   * **未收藏**（`#141`，对齐 Legado `BookType.notShelf` 位）—— 观影历史行：
   * 看过但没加入书架的剧也进服务端 `books`（同一张表、同一个主键 ⇒ 一部剧一行，
   * 不会出现「收藏行与历史行互相删」）。书架/影视库的收藏列表**不过滤**它也会被
   * `kind === 'video'` 之外的分支排除……⚠️ 消费方必须**自行排除 notShelf 行**。
   */
  notShelf?: boolean;
  /**
   * **分组位掩码**（契约 `ShelfBook.group`，见 `shelf-groups.ts` 顶部注释）。
   * 一本书可同时属于多个分组；`0` = 未分组。
   */
  group?: number;
  /**
   * 「更新时间」排序用 —— ⚠️ **本仓是近似口径**：取**最近一次成功加载这本书目录的时间**。
   *
   * 为什么不能照 Legado 取真值：Legado 的 `latestChapterTime` 来自目录刷新时对章节
   * `updateTime` 的解析，而我们的引擎把 `ruleToc.updateTime` 输出成**字符串** `chapter.tag`
   * （`packages/core/src/contract/types.ts:228` 注释：更新时间/字数等），**没有时间戳**。
   * 与其编一个数字，不如如实记录「我们最后一次确认它的目录是什么时候」，UI 提示里写清。
   */
  latestChapterTime?: number;
  /** 目录章节总数（加载目录时记录）—— 对应 Legado `Book.totalChapterNum`；给「按进度」排序算百分比 */
  totalChapterNum?: number;
  /**
   * **允许更新**（对应 Legado `Book.canUpdate`，默认 `true`）。
   * 「更新」按钮/批量「更新详情目录」会**跳过** `canUpdate === false` 的书（用户 5-3 的「禁止更新」）。
   */
  canUpdate?: boolean;
  /**
   * 上一次检查更新时**新增的章节数**（对应 Legado `Book.lastCheckCount`）。
   * > 0 时未读角标**高亮**（Legado `BooksAdapterGrid.kt:100` `bvUnread.setHighlight(lastCheckCount > 0)`）。
   * 每次「更新」后按 `新章节数 - 旧章节数` 重算；用户读完最新章节后清零。
   */
  lastCheckCount?: number;
  /**
   * **这本书的阅读样式覆盖**（`#164`）—— ⚠️ **本仓扩展字段**，上游没有（理由见契约
   * `ShelfBook.readStyle` 的长注释：上游阅读样式是全局的，`Book.ReadConfig` 19 字段里不含字号/字距/行距）。
   *
   * `undefined` / `null` = **不覆盖，跟随全局**。合并规则**唯一实现**是契约的 `mergeReadStyle`
   * （逐键覆盖，`undefined` 的键不覆盖）—— 别在这里再写一份 `{ ...global, ...override }`：
   * 那个版本连 `undefined` 一起覆盖，于是「只改了字号」会顺手把颜色抹空。
   */
  readStyle?: ReadStyleOverride | null;
  /**
   * **这本书要不要用净化（替换）规则** —— 对齐上游 `Book.ReadConfig.useReplaceRule`
   * （`Book.kt:499`，可空，见 `Book.getUseReplaceRule()` `Book.kt:226-236`）。
   *
   * - `null` / `undefined` = **跟随全局** `GlobalReaderPrefs.replaceEnableDefault`（设置 → 净化）；
   * - `true` / `false` = 本书显式覆盖（阅读界面「更多 → 替换净化」写的就是这里）。
   *
   * ## 为什么能直接落地（`#260`）
   * 上游这个字段就在 `books.readConfig` 那一列里（JSON），而本仓的 `readConfig` 列
   * **早就在 DDL 里**（`sqlite.ts:137`）、契约 `BookReadConfig.useReplaceRule` 也**早就定义**
   * （`contract/user-data.ts:144-145`）、持久层也已往返（`sqlite.ts:674` / `:719`）
   * ⇒ **不需要加列、不需要迁移**，缺的只是前端映射（`utils/user-map.ts`）与消费点。
   * 原先映射层把它写成恒 `null`（`user-map.ts:146`），于是「本书级」永远退化成「跟全局」。
   */
  useReplaceRule?: boolean | null;

  /**
   * `#261` **手动规则集**：这本书勾中的净化规则 id —— 对齐上游
   * `Book.ReadConfig.manualReplaceRuleIds`（`Book.kt:513`，默认空数组）。
   *
   * ⚠️ 只在**全局手动模式**打开（`GlobalReaderPrefs.manualReplaceRuleEnabled`）时才起作用；
   * 一旦非空就**接管**：全局规则一条都不跑，且跑不跑由它决定（书的开关与全局默认失效），
   * 取规则只按 id（**无视 `isEnabled` 与 `scope`**）。详见 `utils/replace-rules.ts` 的
   * `manualReplaceSets`（纯函数 + 单测）。
   */
  manualReplaceRuleIds?: number[] | null;
}

/** 观影历史（影视详情/播放时记录） */
export interface WatchEntry {
  key?: string;
  sourceId: string; payload: unknown; title: string; cover?: string;
  lastEpisode?: { title: string; payload: unknown };
  updatedAt?: number;
  /** 播放进度（秒）—— 影视库「继续观看」的进度条 / 续播定位用 */
  progressSec?: number;
  durationSec?: number;
}
const WATCH_KEY = 'yuedu-watch-history';

/**
 * 书/剧的唯一标识 = 源 + 内容标识。
 *
 * 优先级：legado 书 `bookUrl` → maccms 影视 `vodId` → 通用 `url` → 兜底「键排序后的稳定 JSON」。
 * 为什么不能只用标题：同名不同源是两本书（Legado 亦如此），用书名会把它们并成一条。
 */
export function itemKey(sourceId: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  let id: string;
  if (typeof p.bookUrl === 'string' && p.bookUrl) id = p.bookUrl;
  else if (p.vodId != null && p.vodId !== '') id = `vod:${String(p.vodId)}`;
  else if (typeof p.url === 'string' && p.url) id = p.url;
  else {
    try {
      id = JSON.stringify(p, Object.keys(p).sort());
    } catch {
      id = String(p);
    }
  }
  return `${sourceId}\u0000${id}`;
}

/** 阅读链全局状态：详情 → 目录 → 正文（+ 换源 / 书架续读）。
 *  做成 pinia store + 全局浮层（MainLayout 挂 ReaderOverlay），
 *  任何视图的卡片都能一键打开，跨路由切换不丢状态。 */
export const useReaderStore = defineStore('reader', () => {
  /** `#144`：净化规则（另一个 store）—— 只在 `purify()` 里读它的「应用」方法 */
  const replaceRules = useReplaceRulesStore();
  const open = ref(false);
  const sourceId = ref('');
  /**
   * 详情数据（**引擎契约字段为准**）。
   *
   * ⚠️ 字段名必须与 `@yuedu/core` 的 `UnifiedDetail` 一致：作者 = `subtitle`、简介 = `summary`
   * （引擎 `engine.ts` 的 detail 组装：`subtitle: author 规则`、`summary: intro 规则`）。
   * 这里曾声明/渲染成 `author` / `intro` —— 引擎从不返回这两个名字，且**没有映射层**，
   * 结果书籍详情页的**作者与简介永远不显示**（只剩书名/封面/标签/meta，与影视详情页行为不一致）。
   * `author` / `intro` 仅作**兼容别名**保留（`normalizeDetail` 会把契约字段填进来）。
   */
  const detail = ref<{
    id?: string;
    title?: string;
    /** 引擎契约：作者 */
    subtitle?: string;
    /** 引擎契约：简介 */
    summary?: string;
    /** 兼容别名（= subtitle / summary，由 normalizeDetail 填） */
    author?: string;
    intro?: string;
    cover?: string;
    kind?: string;
    coverDecode?: boolean;
    chapters?: Array<{
      title: string; payload: unknown;
      isVolume?: boolean; isVip?: boolean; isPay?: boolean; tag?: string;
    }>;
    /**
     * **目录阶段的失败原因**（`#161`）。引擎侧已把「目录抛错」与「详情字段」隔离 ⇒
     * 现在目录炸了不再吞掉书名/封面/简介，而是留一个原因在这里。
     * ⚠️ 目录为空 + 本字段非空 ⇒ 「解析失败」；两者都空 ⇒ 「源没配目录规则」。
     * 不显示它的话，这两种情况在界面上长得一模一样。
     */
    tocError?: string;
    /** `#152`：本次请求有文本响应被体积护栏截断（内容可能不完整，与「站点返回空」区分） */
    netTruncated?: { count: number; urls: string[] };
    meta?: Record<string, string>; tags?: string[];
  } | null>(null);
  const detailLoading = ref(false);
  /**
   * `#344` 直达阅读中（RSS 卡片点击）—— 详情就绪、但首章还没到位时，浮层显示「加载中…」
   * 而不是详情页（避免「卡片→详情页→阅读页」的过渡观感）。首章 openChapter 成功后自动复位。
   */
  const directRead = ref(false);
  /**
   * `#370` **当前正文是「网页即正文」的合成会话**（`openWeb`：网页型订阅源 / 极简浏览器入口）。
   *
   * openWeb 的「详情」是**合成的**（目录只有这一张网页、无简介无封面）⇒ 不存在真实详情层，
   * 「返回详情」（reset）会落在一个空壳详情页上 ⇒ 关闭语义必须**整关**（close），
   * 见 `ReaderOverlay.closeTopLayer`。普通路径（openDetail → openChapter）恒为 false。
   */
  const webDoc = ref(false);
  /**
   * `#399` **当前会话是 RSS 文章直达阅读**（`readFirstDirect`：订阅源卡片点文章）。
   *
   * 订阅源**没有「详情页」中间态**（上游 `ReadRssActivity` 点文章直接进正文）⇒ 关闭 / 返回
   * 必须**整关回列表**（`close`），不能落在合成的详情页上（旧行为：`closeTopLayer` 走 `reset`
   * ⇒ 返回详情页）。语义与 `webDoc`（网页即正文）同族 ⇒ 两处判定一并使用。
   */
  const rssArticle = ref(false);
  const detailErr = ref('');
  const chapter = ref<{
    title?: string; paragraphs?: string[]; subContent?: string; imageStyle?: string; imageDecode?: boolean;
    /**
     * `#308` 正文 HTML（与 `paragraphs` 互斥）—— 订阅源/组装型正文走它。
     * ⚠️ 有它时 `ReaderOverlay` 默认必须走 `<iframe srcdoc>`（`v-html` **不执行 `<script>`**）。
     * `#712` 例外：该站点开了「阅读模式」时书籍正文会被抽成 `paragraphs` 并置
     * `readerModeText`（见该字段），此时改走文本分支，`html` 只留作原始来源（看源码/关掉后恢复）。
     */
    html?: string;
    /** `#308` `html` 的相对地址基准 */
    htmlBaseUrl?: string;
    /**
     * `#712` 本 HTML 章**已按阅读模式抽成文本**：`paragraphs` 是抽取结果，`html` 保留原文。
     *
     * `ReaderOverlay` 见到它为 true ⇒ **不走 iframe**，改走文本分支（阅读样式/划词/高亮/分页全接管）。
     * 只在内存里生效，写缓存仍存引擎原文（与简繁转换同一条纪律）。
     */
    readerModeText?: boolean;
    /** `#712` 应用阅读模式前的原始段落（退出阅读模式时还原；HTML 章通常为空数组） */
    readerModeRawParagraphs?: string[];
    /**
     * `#583` 正文里的「源脚本 UI 按钮」（段评 / 本章说 / 神评 / 书评）——
     * 与 `paragraphs` 并存：正文仍按段落渲染，按钮挂在对应段落末尾（`para: -1` = 章末）。
     */
    uiMarks?: ContentUiMark[];
    /** `#152`：本次正文请求有文本响应被截断（可能缺后半段） */
    netTruncated?: { count: number; urls: string[] };
    /**
     * 媒体直链（音频/视频源）。
     * ⚠️ `alternatives` / `format` 是引擎**确实会输出**、`MediaPlayer.vue` **确实在消费**的两个字段
     * （`MediaPlayer.vue:37-38` props）—— 此前这里漏声明，于是模板里 `r.chapter.media.alternatives`
     * 一直报 TS2339。**类型漏声明不改运行时行为**（模板照样取值），但会让「以后谁去修它」变成猜谜。
     */
    media?: { url: string; headers?: Record<string, string>; alternatives?: string[]; format?: string };
  } | null>(null);
  const contentLoading = ref(false);
  /**
   * 当前阅读到的章节下标（-1 = 未进入任何章节）。
   *
   * ⚠️ 必须随「换书」清零：`ReaderOverlay` 的目录用 `chapterIdx === i` 标记当前章，
   * 不清则打开另一本书时目录仍高亮上一本的章节（实测症状「目录定位到第 3 章」，跨多个源）。
   */
  const chapterIdx = ref(-1);
  /**
   * `#294` **上次读到第几章**（0 基；-1 = 无进度）—— 与 {@link chapterIdx} 分开存。
   *
   * ## 为什么不能直接用 `chapterIdx`
   * `chapterIdx` 是「**当前打开的正文**是哪一章」，没打开正文时恒 -1。而「详情页」正是
   * 这种情况：从书架点进详情（`openShelfBook(b, { read: false })`）不会打开任何章节，
   * `chapterIdx` 保持 -1 ⇒ 目录里**没有一章是选中态**、也不会滚到进度处
   * （用户 2026-10-05 实测：「书架书籍打开详情页，目录列表：当前阅读章节应该在可视区域，
   * 且处于选中态」）。
   *
   * `lastReadIdx` 由书架记录（`lastChapter.payload.chapterUrl` 优先，回落 `lastIdx`）算出来，
   * **不打开正文、不写任何阅读状态**；目录高亮在「未打开正文」时用它、打开正文后用 `chapterIdx`。
   */
  const lastReadIdx = ref(-1);

  /* ---------------- 阅读偏好（`#145`）：字号 / 主题 / 排版 —— 本地缓存 + 服务端 ----------------
   * 策略与书架/分组**同一份**（`utils/server-sync.ts`）：启动读服务端 → 服务端非默认以服务端为准 →
   * 默认且本地有 ⇒ 一次性搬迁 → 写入「本地缓存 + 推服务端」→ 离线留 `pendingSync`。
   * ⚠️ 单对象实体用 `pullObject`/`pushObject`（数组端点那套靠「返回空数组」判空，
   *    而 `GET /api/user/prefs` 总会补默认值 ⇒ 必须显式判「等于默认」）。 */

  /** 本地缓存键（服务端数据的镜像） */
  const PREFS_LOCAL_KEY = 'yuedu-reader-prefs';
  const PREFS_PENDING_KEY = 'yuedu-sync-pending-prefs';
  /** 旧的两个设备项 —— `#145` 起降级为「一次性迁移来源」，不再写 */
  const LEGACY_FONT_KEY = 'yuedu-reader-font';
  const LEGACY_THEME_KEY = 'yuedu-reader-theme';

  const prefs = ref<GlobalReaderPrefs>(emptyGlobalReaderPrefs());

  /**
   * 「服务端还没存过」的判据。
   * ⚠️ `#163` 起改走契约的 {@link isDefaultGlobalReaderPrefs}（**键排序后的稳定 JSON 比较**）：
   *  · 不能用 `JSON.stringify` 直接比 —— 键序不保证一致；
   *  · 也不能用「端点返回 null」：`GET /api/user/prefs` 的实现是
   *    `jsonOf(…, emptyGlobalReaderPrefs())` ⇒ **永远返回一份补齐过默认值的对象**；
   *  · 更不能用「逐键 `!==` 浅比较」—— `#163` 起有嵌套结构（`cover` / `uiDayTheme` / …），
   *    嵌套对象按引用比较恒不相等 ⇒ 永远判「非默认」⇒ 「一次性搬迁」永远不触发。
   */
  const PREFS_PLAN: SyncObjectPlan<GlobalReaderPrefs> = {
    localKey: PREFS_LOCAL_KEY,
    pendingKey: PREFS_PENDING_KEY,
    get: () => getPrefsRemote(),
    set: (v) => patchPrefsRemote(v as unknown as Record<string, unknown>),
    isDefault: isDefaultGlobalReaderPrefs,
  };

  /**
   * 旧的两个设备项 → prefs（`#145` 一次性迁移）。
   * **两个键都不在 ⇒ 返回 null**（不要凭空造一个「非默认」的值，否则会把服务端的默认值覆盖掉）。
   * 映射规则见契约 `user-data.ts` 末尾的映射表：`readerFont → textSize`（本地已有值优先）、
   * `'dark' → '2'` / `'sepia' → '1'`。
   */
  function migrateLegacyDevicePrefs(): GlobalReaderPrefs | null {
    let font: string | null = null;
    let theme: string | null = null;
    try {
      font = localStorage.getItem(LEGACY_FONT_KEY);
      theme = localStorage.getItem(LEGACY_THEME_KEY);
    } catch {
      return null; // 隐私模式：读不到就当没有
    }
    if (font === null && theme === null) return null;
    const p = emptyGlobalReaderPrefs();
    const n = Number(font);
    if (font !== null && Number.isFinite(n)) p.textSize = Math.min(80, Math.max(8, Math.round(n)));
    if (theme !== null) p.themeMode = normalizeThemeMode(theme);
    return p;
  }

  function setPrefsLocal(next: GlobalReaderPrefs): void {
    prefs.value = next;
    writeLocalObject(PREFS_LOCAL_KEY, next);
  }

  /** 写一项偏好：**本地缓存 + 推服务端**（离线留 pendingSync，由阶段 1.5 的重传兜底） */
  function patchPrefs(patch: Partial<GlobalReaderPrefs>): void {
    setPrefsLocal({ ...prefs.value, ...patch });
    void pushObject(PREFS_PLAN, prefs.value).catch((e) =>
      console.warn('[reader] 阅读偏好推送失败（本地已保存，数据未丢）：', e),
    );
  }

  // 服务端恢复后由阶段 1.5 的心跳触发重传（与书架/书签/分组同一套登记表）
  registerSyncTarget({
    localKey: PREFS_LOCAL_KEY,
    pendingKey: PREFS_PENDING_KEY,
    label: '阅读偏好',
    resync: () => pushObject(PREFS_PLAN, prefs.value),
  });

  /**
   * 启动对齐（`main.ts` 在 **mount 之前** await）。
   * 顺序与数组版一致：`pending` ⇒ 本地为准重传；服务端非默认 ⇒ 服务端为准；默认且本地有 ⇒ 一次性搬迁。
   */
  async function hydratePrefs(): Promise<SyncSource> {
    const fromCache = readLocalObject<GlobalReaderPrefs>(PREFS_LOCAL_KEY);
    const legacy = fromCache ? null : migrateLegacyDevicePrefs();
    const local = fromCache ?? legacy;
    const r = await pullObject(PREFS_PLAN, local);
    // ⚠️ fillGlobalReaderPrefs：服务端可能是旧版本落的数据（没有 `#163` 的嵌套键），
    //    不补齐的话 `prefs.value.cover.xxx` 会直接 TypeError。
    const next = r.value === null ? (local ? fillGlobalReaderPrefs(local) : null) : fillGlobalReaderPrefs(r.value);
    if (next) {
      setPrefsLocal(next);
      if (legacy) {
        // 迁移完成 ⇒ 旧键退场。留着会让后来者读到一份**过期副本**（改了字号旧键不变）。
        try {
          localStorage.removeItem(LEGACY_FONT_KEY);
          localStorage.removeItem(LEGACY_THEME_KEY);
        } catch { /* 隐私模式：不影响主流程 */ }
      }
    }
    console.info(`[reader] 阅读偏好对齐来源：${r.source}`);
    return r.source;
  }

  /** 正文字号（读自 prefs；写入走 `setFont`） */
  const readerFont = computed(() => prefs.value.textSize);
  /** 主题档位（读自 prefs；写入走 `setThemeMode`） */
  const themeMode = computed(() => prefs.value.themeMode);

  /** 系统是否偏好深色 —— 只在 `themeMode === '0'`（跟随系统）时参与决定 */
  const prefersDark = ref(false);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    prefersDark.value = mq.matches;
    mq.addEventListener('change', (e) => {
      prefersDark.value = e.matches;
    });
  }

  /** 生效的颜色集（`'day' | 'night' | 'eink'`） */
  const readerColorSetName = computed(() => readerColorSet(themeMode.value, prefersDark.value));

  /* ---------------- 生效阅读样式 = 全局默认 ⊕ 每本覆盖（`#164`） ----------------
   * ⚠️ 下面几个 computed 里引用了**声明在后面**的 `it0` / `shelf`（第 550/564 行）。
   *    这是**安全**的：`computed` 的求值是**惰性**的（Vue 只在第一次被读取时调 getter，
   *    而那时 setup 早已跑完）。**但别把这个函数体的写法抄到非惰性场合**（那会踩 TDZ）。
   */

  /** 当前打开的书在书架里的条目（不在书架 / 没开书 ⇒ null） */
  const currentShelfBook = computed<ShelfBook | null>(() => {
    const q = { sourceId: sourceId.value, payload: it0.value?.payload };
    if (!sourceId.value) return null;
    const k = itemKey(q.sourceId, q.payload);
    return shelf.value.find((b) => b.key === k) ?? null;
  });

  /** 当前这本书的覆盖（`null` = 没有覆盖 / 书不在书架）—— **「本书已改过样式」的唯一判据** */
  const currentReadStyleOverride = computed<ReadStyleOverride | null>(
    () => currentShelfBook.value?.readStyle ?? null,
  );

  /** 当前这本书**能不能**单独设样式（= 它在书架里）。不能时界面要如实说明，而不是让改动静默丢弃。 */
  const canOverrideReadStyle = computed(() => currentShelfBook.value !== null);

  /** 当前这本书**是否已经**设过覆盖（界面用它决定显示「恢复跟随全局」按钮） */
  const hasBookReadStyle = computed(() => Object.keys(currentReadStyleOverride.value ?? {}).length > 0);

  /* ---------------- `#260` 本书级净化开关（上游 `Book.ReadConfig.useReplaceRule`） ----------------
   * 上游语义（`Book.kt:226-236` `getUseReplaceRule()`），三级回落：
   *   ① 本书设过（非 null）⇒ 用它；
   *   ② 图片书源（本仓另外把「没正文的媒体书」也算进来）⇒ **默认关**；
   *   ③ 否则跟全局 `AppConfig.replaceEnableDefault`（设置 → 净化那个复选框）。
   *
   * ⚠️ 判据**只此一处**，实际算值的是 `utils/replace-rules.ts` 的 `useReplaceRuleFor()`
   * （纯函数 + 单测）。别在这里再写一份 —— 两份判据必然漂移（本仓已因「写侧改了读侧没改」返工过）。
   */
  const currentBookUseReplaceRule = computed<boolean | null>(
    () => currentShelfBook.value?.useReplaceRule ?? null,
  );

  /** `#261` 当前这本书勾中的手动规则 id（空/null = 不启用手动集） */
  const currentBookManualRuleIds = computed<number[] | null>(
    () => currentShelfBook.value?.manualReplaceRuleIds ?? null,
  );

  /** 当前这本书**生效的**净化开关（界面显示「开/关」读它，别直接读 `prefs`） */
  const replaceEnabled = computed(() =>
    useReplaceRuleFor(
      {
        useReplaceRule: currentBookUseReplaceRule.value,
        isImage: detail.value?.kind === 'image',
      },
      prefs.value.replaceEnableDefault,
    ),
  );

  /**
   * 当前章**真正起效**的净化规则 id（上游 `TextChapter.effectiveReplaceRules`）。
   *
   * 语义要对准上游：「起效」= **实际改动了正文的**规则（`ContentProcessor.kt:193`
   * `if (mContent != tmp) effectiveReplaceRules.add(item)`）—— 不是「被选中的」，
   * 更不是「库里启用的」。所以这个值只能由 `purify()` 在跑完替换后**回填**，别处不许猜。
   *
   * ⚠️ 只收**正文**规则（上游那个 List 也只来自 `getContent` 的正文替换，不含标题）——
   * 见 `EffectiveReplacesDialog`（只读 `curTextChapter.effectiveReplaceRules`）。
   */
  const effectiveReplaceIds = ref<number[]>([]);

  /**
   * **生效的阅读样式**（渲染正文只认它；不要直接读 `prefs`）。
   * ⚠️ 不需要自己加记忆化 —— `computed` 本身就是**依赖不变就不重算**的缓存；
   * 手写一层 Map 缓存会引入「缓存键怎么算」这个新问题（键算错就会串样式）。
   *
   * ★★ `#248-A` **`shareLayout` 必须参与「读哪一份」的判断**（用户 2026-10-03 22:00 实测）。
   *
   * ## 现象
   * 书架里绝大多数书的 `readStyle` 是 `null` ⇒ 改全局预设**都即时生效**；
   * 但「病宠成瘾」「夜无疆」两本**有覆盖**（点过预设，被写成了本书覆盖），
   * 于是**改全局对它们毫无影响** —— 用户看到的正是「只有这一本不生效」。
   *
   * ## 根因
   * 原来这里恒用「全局 ⊕ 本书覆盖」，**完全不看 `shareLayout`**。
   * 而上游 Legado 是**二选一**（`ReadBookConfig.kt:434`）：
   * `val config get() = if (shareLayout) shareConfig else durConfig`
   * ⇒ 勾了共用布局就**根本不读** `durConfig`（本书覆盖），不是「读了再被覆盖」。
   * 本仓上半圈（面板的 `effectiveTarget`）已经按二选一处理了，**读取端却没跟上** ——
   * 结果「写进全局了，但本书的旧覆盖还盖在上面」，用户勾了共用布局却看不到任何变化。
   *
   * ## 为什么不能靠「删掉本书覆盖」解决
   * 那是**破坏性**的：用户可能是有意给某本书单独配的。共享布局的语义是
   * 「**暂时**不读这本书的覆盖」，而不是「把覆盖扔了」。
   */
  const readStyle = computed<ReadStyle>(() =>
    // ★ 判据在契约的 `effectiveReadStyleOverride` 里（与单测共用同一条规则 —— `#248` 的
    //   「写侧改了读侧没改」正是这种半截实现的产物）。对齐上游
    //   `ReadBookConfig.kt:434`：`if (shareLayout) shareConfig else durConfig`，**二选一不是叠加**。
    mergeReadStyle(prefs.value, effectiveReadStyleOverride(prefs.value.shareLayout, currentReadStyleOverride.value)),
  );

  /** 生效的三色（`#164` 起**从偏好取**，不再是从常量表取；见 `styles/reader-theme.ts`） */
  /**
   * `#249` 内置背景图的 URL 前缀。
   * ⚠️ 用 `location.origin` 而不是硬写 `/reader-bg/...`：Electron 打包后页面可能跑在
   * `file://` 或非根路径下，绝对路径会 404。
   */
  function originOf(): string {
    return typeof window === 'undefined' ? '' : window.location.origin;
  }

  /**
   * `#249` 把背景色按 `bgAlpha` **预先混出等效色**，而不是给元素加 `opacity`。
   *
   * ## 为什么不能靠 `opacity`
   * 上游 `PageView.kt:343` 是 `bg.alpha = bgAlpha/100*255` —— 作用在 **Drawable** 上，
   * 文字画在 Drawable **之上**、不受影响。CSS 里给祖先加 `opacity` 会**连文字一起淡**，
   * 只给 `.rd-content` 加则只淡正文 ⇒ 两者都不是上游语义。
   * 混色是唯一能在「单元素」里表达「只淡背景」的办法。
   */
  function mixAlpha(color: string, percent: number): string {
    if (percent >= 100) return color;
    return withAlpha01(color, Math.max(0, Math.min(1, percent / 100)));
  }

  /**
   * `#250` 把 `bgAlpha` / 栏位 alpha **夹到 0–100** 再用。
   *
   * ★ 为什么要夹而不是直接 `Number(x ?? 100)`：`Number(null) === 0`、`Number('') === 0`
   *   ⇒ 服务端 merge 后的 `null` 会把「没设过」变成「全透明」，背景整块消失且无任何报错。
   *   （与 `reader-theme.ts` 的 `clampNum` 同一个坑，那边已有先例。）
   */
  function clampBgAlpha(v: unknown): number {
    if (v === null || v === undefined || typeof v === 'boolean') return 100;
    if (typeof v === 'string' && v.trim() === '') return 100;
    const n = Number(v);
    if (!Number.isFinite(n)) return 100;
    return Math.min(100, Math.max(0, n));
  }

  const readerColors = computed(() => readStyleColors(readStyle.value, readerColorSetName.value));

  /** 正文区的 CSS 自定义属性 + 前景色（供 `ReaderOverlay` 直接绑 `:style`）
   *
   * ★★ `#249` **`background` 已从正文移除**，改由 {@link readerBackdropVars} 挂在**滚动容器**上。
   * 上游依据：`PageView.kt:329-336` 把 `LayerDrawable(均色, 背景图)` 挂在 **`vwRoot`**
   * （`view_book_page.xml` 里它含 `ll_header` + 正文 + `ll_footer`），
   * 而 `ll_header` / `ll_footer` **自身没有 background** ⇒ 透明 ⇒ 背景图透上来。
   * ⇒ 本仓等价物：背景挂 `.se-scroll`（页眉+正文+页脚三层），`.rd-content` **透明**。
   * ⚠️ `.se-head`（工具栏）**保持自身背景** —— 上游的工具栏不在 PageView 里，
   * 让它透图会导致白底按钮/图标不可读。
   */
  const readerStyleVars = computed<Record<string, string>>(() => ({
    ...readerContentVars(readStyle.value),
    ...readerUnderlineVars(readStyle.value, readerColorSetName.value),
    color: textColorOf(readStyle.value, readerColorSetName.value),
    '--rd-accent': accentColorOf(readStyle.value, readerColorSetName.value),
  }));

  /**
   * `#249` **整个阅读界面的背景**（`.se-scroll` 的 `:style`）：底色 + 可选背景图 + 透明度。
   *
   * ## ★★ `#250` `bgAlpha` 改成只淡**图片**，底色不参与
   * 上游依据（`PageView.kt:329-336` + `:342-344`）：
   * ```kotlin
   * binding.vwRoot.background = LayerDrawable(arrayOf(bgMeanColor.toDrawable(), ReadBookConfig.bg))
   * fun upBgAlpha() { ReadBookConfig.bg?.alpha = (bgAlpha / 100f * 255).toInt() }
   * ```
   * ⇒ alpha 只设给**第二层**（`bg` = 当前背景 Drawable）；第一层 `bgMeanColor`（图片均色）**恒不透明**。
   * ⇒ 有图时 = 「图片变淡、底色不变」；无图时 `bg` 就是那个 ColorDrawable = 底色变淡。
   *
   * ## 为什么图片透明度用 `opacity` 而底色用预混色
   * 图片是 `<img>`/背景图，CSS 里只能整体 `opacity`（会连**同层文字**一起淡）⇒ 所以图片
   * 必须**独占一层**才能淡：这里用 `::before`（`background-image` + `opacity`）承载图片，
   * `.se-scroll` 自身的 `background-color` 只放底色。两者分离后各调各的，互不干扰。
   * ⚠️ 之前把 `bgAlpha` 混进**底色**（`mixAlpha(base, alpha)`）⇒ 有背景图时拖这个滑块
   *   **底色在淡、图纹丝不动** —— 用户 2026-10-04 报的正是这个。
   */
  const readerBackdropVars = computed<Record<string, string>>(() => {
    const set = readerColorSetName.value;
    const alpha = clampBgAlpha(readStyle.value.bgAlpha);
    const base = readStyleColors(readStyle.value, set).bg;
    const imgKey = set === 'eink' ? 'bgImgPathEInk' : set === 'night' ? 'bgImgPathNight' : 'bgImgPath';
    const url = resolveReaderBgUrl(readStyle.value[imgKey], originOf());
    const out: Record<string, string> = { background: base };
    if (url) {
      // ★ 有图：底色**不透明**（对齐上游 `bgMeanColor` 那层），透明度全部交给图片层。
      //   CSS 侧在 `.se-scroll::before` 上消费 `--rd-bg-img` / `--rd-bg-img-alpha`。
      out['--rd-bg-img'] = `url("${url}")`;
      out['--rd-bg-img-alpha'] = String(alpha / 100);
    } else {
      // 无图：`bg` 本身就是那个 ColorDrawable ⇒ alpha 调底色（与上游同义）。
      out.background = mixAlpha(base, alpha);
    }
    // 栏位底色（页眉 / 页脚 / 标题栏在**不透明**模式下要各自铺一层）——
    // `#250`：这三处的底色统一取**当前背景色**，与上游「工具栏跟正文同一套配色」一致。
    out['--rd-bar-bg'] = base;
    return out;
  });

  /**
   * `#250` **栏位透明开关 + 各自不透明度** → CSS 变量。
   *
   * ## 变量为什么用「回退值」而不是二选一
   * `toolbarTransparent` 等是 boolean，样式表里判不了「关掉时用多少不透明度」⇒
   * 这里把三个开关各折成一个**颜色变量**（透明时给 `transparent`，不透明时给预混色），
   * 样式表只写 `background: var(--rd-bar-head-bg)` 一句，判据全在 JS 这边（可单测）。
   *
   * ## 底色用「预混」而不是 `opacity`
   * 页眉页脚/标题栏里都有文字（章节名、页码、按钮）；给元素加 `opacity` 会**连文字一起淡**
   * ⇒ 只把它们自己的 `background-color` 调淡（`mixAlpha`），文字保持满不透明。
   */
  const readerBarVars = computed<Record<string, string>>(() => {
    const base = readStyleColors(readStyle.value, readerColorSetName.value).bg;
    const one = (transparent: unknown, alpha: unknown): string =>
      transparent === false ? mixAlpha(base, clampBgAlpha(alpha)) : 'transparent';
    return {
      '--rd-bar-head-bg': one(readStyle.value.toolbarTransparent, readStyle.value.toolbarAlpha),
      '--rd-bar-header-bg': one(readStyle.value.headerTransparent, readStyle.value.headerAlpha),
      '--rd-bar-footer-bg': one(readStyle.value.footerTransparent, readStyle.value.footerAlpha),
    };
  });

  /**
   * **章节标题**的 CSS 变量（`#164`）。
   *
   * ⚠️ 必须与 {@link readerStyleVars} **分开**，不能复用：后者带 `background`，
   * 而标题是正文卡片**外面**的兄弟元素 —— 套上正文底色会把它渲染成**一条色带**（`#164` 踩过）。
   * 标题只需要「字体 / 字号 / 颜色 / 间距 / 下划线」这几类。
   */
  const readerTitleVars = computed<Record<string, string>>(() => ({
    ...readerContentVars(readStyle.value),
    ...readerUnderlineVars(readStyle.value, readerColorSetName.value),
    color: titleColorOf(readStyle.value, readerColorSetName.value),
  }));

  /**
   * **页眉 / 页脚**的 CSS 变量（`#221`）。
   *
   * 与 {@link readerTitleVars} 同理要**分开**：页眉页脚的字号/颜色是**独立的一套**
   * （上游 `tipTextSize` / `tipColor`，`ReadBookConfig.kt:944-945`），跟随正文会让「12px 的页脚」
   * 跟着字号滑块一起变成 40px —— 那不是用户要的。
   */
  const readerTipVars = computed<Record<string, string>>(() =>
    readerTipVarsOf(readStyle.value, readerColorSetName.value),
  );
  /**
   * `#235` 页眉 / 页脚**各自**的 CSS 变量（字号 · 文字色 · 分隔线色 · 线型）。
   *
   * 为什么 store 要再包一层：`tipVarsOf` 是纯函数，zone 是**入参**；
   * 组件里直接 `r.tipVarsOf(props.zone)` 会在 zone 变化时重建 computed ⇒ 缓存失效。
   * 这里做成一个返回函数的 computed，Vue 能对它做依赖追踪（`computed` 本身被缓存，
   * 内部读到的 `readStyle` / `readerColorSetName` 变化时才重算）。
   */
  const tipVarsOf = (zone: 'header' | 'footer'): Record<string, string> =>
    tipVarsOfTheme(readStyle.value, readerColorSetName.value, zone);

  /* ---------------- 界面主题（`#163`）----------------
   * ★ 这是**界面**用的（色调 + 壁纸），不是上面那套**正文**的 —— 用户 2026-09-30 纠正过的概念模型。
   *   上游对应 `ThemeConfig`（`ThemeConfig.kt`），字段与语义见契约 `UiThemeConfig` 的注释。
   *
   * ## 日 / 夜是两个独立的槽（照抄上游，别合并成一个）
   * 上游存的是 `colorPrimary…` 与 `colorPrimaryNight…` **两组偏好**（`ThemeConfig.getDayTheme`/
   * `getNightTheme`，`ThemeConfig.kt:320-386`），用哪个由 `themeMode` 经 `isNightTheme` 决定。
   * 「跟随系统」意味着两个槽**都得有值**、运行时按系统偏好挑 —— 这就是为什么不能只存一份。
   */

  /** 生效的那套界面主题（墨水屏强制黑白，不取槽 —— `ThemeConfig.kt:398-406`） */
  const uiTheme = computed<UiThemeConfig>(() =>
    effectiveUiTheme(prefs.value.themeMode, prefersDark.value, prefs.value.uiDayTheme, prefs.value.uiNightTheme),
  );
  /** 现在算「夜间」吗（照抄 `AppConfig.isNightTheme` 的 getter —— **由 themeMode 决定**，不是由配色深浅猜） */
  const uiIsNight = computed(() => uiNightActive(prefs.value.themeMode, prefersDark.value));
  /** 生效主题的背景是不是亮底（**只给 CSS 用**：文字色 / `html.dark`。配色和标记可能不一致，底色不会骗人） */
  const uiBgIsLight = computed(() => isLightColor(uiTheme.value.backgroundColor));
  /** 界面主题 → CSS 变量（`App.vue` 写到 `<html>` 上） */
  const uiThemeVars = computed<Record<string, string>>(() => uiThemeVarsOf(uiTheme.value));
  /** 生效的封面参数（日/夜槽各取各的 —— 照抄 `BookCover.upDefaultCover()`，`BookCover.kt:66-83`） */
  const uiCoverParams = computed(() => coverParamsFor(prefs.value.cover, uiIsNight.value));
  /** 当前生效的主题名（「跟随系统」下日/夜槽可能各有一个名字；上游也这样 —— `dThemeName`/`dNThemeName`） */
  const activeUiThemeName = computed(() => {
    if (prefs.value.themeMode === '3') return ''; // 墨水屏不是一套主题
    return uiIsNight.value ? prefs.value.uiNightTheme.themeName : prefs.value.uiDayTheme.themeName;
  });

  /**
   * 把一套主题**写进对应的槽**（不落命名主题列表 —— 列表另用 {@link saveUiThemeAs}）。
   * ⚠️ 同时按上游 `AppConfig.isNightTheme` 的 **setter**（`AppConfig.kt:179-185`）回写 `themeMode`：
   * `isNightTheme=true → "2"`（暗色）/ `false → "1"`（亮色）。
   * 不这么做的话，把一套亮色主题写进日槽后 `themeMode` 还停在 `"2"`，界面根本不会用日槽 ——
   * 上游 `ThemeConfig.applyConfig()` 的最后一行正是 `AppConfig.isNightTheme = isNightTheme`。
   */
  function writeUiThemeSlot(t: UiThemeConfig): void {
    const night = t.isNightTheme;
    patchPrefs({
      [night ? 'uiNightTheme' : 'uiDayTheme']: { ...t },
      themeMode: night ? '2' : '1',
    } as unknown as Partial<GlobalReaderPrefs>);
  }

  /** 应用一个**已保存**的命名主题（上游 `ThemeConfig.applyConfig()`，按名字在列表里找） */
  function applyUiTheme(themeName: string): void {
    const t = prefs.value.uiThemes.find((x) => x.themeName === themeName);
    if (!t) {
      console.warn(`[reader] 界面主题「${themeName}」不在保存列表里，忽略`);
      return;
    }
    writeUiThemeSlot(t);
  }

  /** 改**当前生效**的那套颜色/壁纸（上游的「主题设置」就是直接改槽，不自动存进列表） */
  function patchUiTheme(patch: Partial<UiThemeConfig>): void {
    const t: UiThemeConfig = { ...uiTheme.value, ...patch };
    // 墨水屏模式下没有可编辑的槽（它是派生的黑白）⇒ 落到当前昼夜对应的槽，退出墨水屏后仍保留
    const night = prefs.value.themeMode === '3' ? false : t.isNightTheme;
    patchPrefs({
      [night ? 'uiNightTheme' : 'uiDayTheme']: { ...t, isNightTheme: night },
    } as unknown as Partial<GlobalReaderPrefs>);
  }

  /**
   * 把**当前生效**的那套另存为命名主题（上游「保存主题配置」`saveDayTheme`/`saveNightTheme`）。
   * 同名即覆盖 —— 照抄 `ThemeConfig.addConfig()`（`ThemeConfig.kt:171-187`）按 `themeName` 找旧项替换。
   */
  function saveUiThemeAs(themeName: string): void {
    const name = themeName.trim();
    if (!name) return;
    const t: UiThemeConfig = { ...uiTheme.value, themeName: name };
    const rest = prefs.value.uiThemes.filter((x) => x.themeName !== name);
    patchPrefs({ uiThemes: [...rest, t] } as unknown as Partial<GlobalReaderPrefs>);
  }

  /** 删除一个命名主题（上游 `ThemeConfig.delConfig`；当前正在用的那份**槽**不受影响） */
  function deleteUiTheme(themeName: string): void {
    patchPrefs({ uiThemes: prefs.value.uiThemes.filter((x) => x.themeName !== themeName) } as unknown as Partial<GlobalReaderPrefs>);
  }

  /* ---------------- `#206` 主题导入 / 导出 ----------------
   * 校验与序列化全在 `utils/theme-transfer.ts`（那儿还写着上游 `ThemeConfig.addConfigs`
   * 的逐条依据），这里只负责「把结果写进偏好」与「触发下载」——
   * 与 `#224-b` 的预设编辑器同一套分工：**决策只此一份**。
   */

  /** 导出**全部命名主题**（上游 `themeConfig.json` 就是这个数组，不是「当前槽」） */
  function exportUiThemesText(): string {
    return serializeThemeBundle(prefs.value.uiThemes);
  }

  /**
   * 从文件文本导入主题。
   *
   * ## 为什么默认 `mode: 'merge'`（同名覆盖）
   * 照抄上游 `ThemeConfig.addConfigs`（`ThemeConfig.kt:189-205`）：按 `themeName`
   * 找旧项**替换**、没有则追加。同名覆盖是「导入 = 用对方那份」的直觉，
   * 也让「导出→改→导回」这个往返可用。
   *
   * @param exists 本机文件存在性判定（Web 端无法同步读 fs ⇒ 由调用方注入，
   *               生产传「只对 data:/http(s) 返回 true」的宽松判定即可，见 SettingsView）
   */
  function importUiThemes(
    text: string,
    mode: 'merge' | 'keepExisting' = 'merge',
    exists: (absPath: string) => boolean = () => false,
  ): ThemeImportResult {
    const { valid, rejected, error } = inspectThemeBundle(text);
    if (error) return { ok: false, imported: 0, rejected, wallpaperDropped: [], error };
    if (!valid.length) {
      return {
        ok: false,
        imported: 0,
        rejected,
        wallpaperDropped: [],
        error: rejected.length ? '文件里没有一套可用的主题（每条都没通过校验）' : '文件里没有主题',
      };
    }
    return importThemeRules(valid, mode, exists, rejected);
  }

  /**
   * `#272`：按**已解析**的主题列表导入（预览对话框在 `parseThemeInput` 之后调用这里，
   * 保证「预览说什么，导入就进什么」）。`rejected` 原样带回（报告文案里要如实列出）。
   */
  function importThemeRules(
    valid: UiThemeConfig[],
    mode: 'merge' | 'keepExisting' = 'merge',
    exists: (absPath: string) => boolean = () => false,
    rejected: { index: number; reason: string }[] = [],
  ): ThemeImportResult {
    if (!valid.length) {
      return { ok: false, imported: 0, rejected, wallpaperDropped: [], error: '没有可导入的主题' };
    }
    const merged = mergeThemeList(prefs.value.uiThemes, valid, exists, mode);
    const before = prefs.value.uiThemes.length;
    patchPrefs({ uiThemes: merged.list } as unknown as Partial<GlobalReaderPrefs>);
    return {
      ok: true,
      imported:
        merged.list.length === before ? merged.added.length : merged.added.length + merged.replaced.length,
      rejected,
      wallpaperDropped: merged.wallpaperDropped,
    };
  }

  /** 把**当前生效的这一套**追加进命名主题列表（导出「单套」时的入口；名字沿用当前主题名） */
  function exportCurrentUiThemeText(): string {
    return serializeThemeBundle([uiTheme.value]);
  }

  /** 改封面配置（`pref_config_cover.xml` 那组；全局，不分日夜 —— 日夜在 `coverParamsFor` 里取） */
  function patchCover(patch: Partial<UiCoverConfig>): void {
    patchPrefs({ cover: { ...prefs.value.cover, ...patch } } as unknown as Partial<GlobalReaderPrefs>);
  }

  /* ---------------- 简繁转换（`#146`）----------------
   * 上游只在**两处**转换：正文（`ContentProcessor.kt:153-163`）与章节显示名
   * （`BookChapter.getDisplayTitle()`，`BookChapter.kt:131-136`）⇒ 我们照做，**不改内存里的原文**。
   *
   * ⚠️ 为什么另存一份「转换后」而不是就地改 `chapter`：
   *  ① 换设置/关设置时能**立刻回到原文**（就地改就得重新拉一次章节）；
   *  ② 离线缓存（IndexedDB）存的是**原文** —— 转换只影响显示，不污染缓存。
   * ⚠️ 转换是**异步**的（词典按需 `import()`，见 `utils/chinese-convert.ts`），
   *   所以写完前要**复核「这期间没换章、设置也没改」**，否则会把旧结果盖到新章上。
   */

  /** 转换后的当前章（`null` = 没开转换 / 还没转完） */
  const convertedChapter = ref<{ title: string; paragraphs: string[] } | null>(null);
  /** 转换后的目录标题（按 `detail.chapters` 的下标对齐；`null` = 没开转换 / 还没转完） */
  const convertedTocTitles = ref<string[] | null>(null);

  /** 要显示的章节标题（转换优先，回落原文） */
  const displayTitle = computed(() => convertedChapter.value?.title ?? chapter.value?.title ?? '');
  /** 要显示的正文段落（转换优先，回落原文） */
  const displayParagraphs = computed(
    () => convertedChapter.value?.paragraphs ?? chapter.value?.paragraphs ?? [],
  );
  /** 目录第 `i` 项要显示的标题 */
  function tocTitleAt(i: number): string {
    return convertedTocTitles.value?.[i] ?? detail.value?.chapters?.[i]?.title ?? '';
  }

  async function applyChineseConvert(): Promise<void> {
    const type = prefs.value.chineseConverterType;
    const ch = chapter.value;
    if (!isChineseConvertOn(type) || !ch) {
      convertedChapter.value = null;
      return;
    }
    const [title, paragraphs] = await Promise.all([
      convertChinese(ch.title ?? '', type),
      convertChineseBatch(ch.paragraphs ?? [], type),
    ]);
    // 复核：这段时间里没换章、也没关掉转换
    if (chapter.value !== ch || !isChineseConvertOn(prefs.value.chineseConverterType)) return;
    convertedChapter.value = { title, paragraphs };
  }

  async function applyChineseConvertToc(): Promise<void> {
    const type = prefs.value.chineseConverterType;
    const d = detail.value;
    const chs = d?.chapters;
    if (!isChineseConvertOn(type) || !chs?.length) {
      convertedTocTitles.value = null;
      return;
    }
    const titles = await convertChineseBatch(
      chs.map((c) => c.title ?? ''),
      type,
    );
    if (detail.value !== d || !isChineseConvertOn(prefs.value.chineseConverterType)) return;
    convertedTocTitles.value = titles;
  }

  /**
   * 三个触发点，用 watcher 统一挂（`chapter`/`detail` 各有 3+ 处赋值点，
   * 逐个加调用很容易漏 —— 漏一处就表现为「这一条路径下转换不生效」）。
   * 设置改动后也要重算：用户切一下就得看到效果。
   */
  watch(prefs, () => {
    void applyChineseConvert();
    void applyChineseConvertToc();
  }, { deep: true });
  watch(chapter, () => void applyChineseConvert());
  watch(detail, () => void applyChineseConvertToc());

  const it0 = ref<Record<string, unknown> | null>(null);

  /**
   * 书架。**存储 = 本地缓存（localStorage）+ 服务端**（Phase 1.4 / `#66`，策略见 `utils/server-sync.ts`）。
   *
   * ※ 用 `readLocal` 而不是裸 `JSON.parse`：缓存先坏掉（写一半、被别的扩展改过）时
   * **不能把整个 store 带崩**（那会白屏）—— 解析失败按空数组 + `console.warn` 留痕。
   */
  const SHELF_KEY = 'yuedu-bookshelf';
  const shelf = ref<ShelfBook[]>(readLocal<ShelfBook>(SHELF_KEY));

  /** 书架条目的主键：`key` 缺失时按 `itemKey` 现算（历史条目见文件末尾的补算块） */
  const shelfKeyOf = (b: ShelfBook): string => b.key ?? itemKey(b.sourceId, b.payload);
  /** 「上次没推上服务端」标记（`utils/server-sync.ts` 的 pendingSync） */
  const SHELF_PENDING_KEY = 'yuedu-bookshelf-pending';

  /**
   * 书架的同步方案。
   *
   * ⚠️ **推送走增量（`createPusher` → `pushDiff`），不是 `reconcile`**：
   * `saveShelf()` 被 12 处调用，其中 `saveProgress`（每翻一章）与 `recordProgress`（播放中节流上报）
   * 是热路径；`reconcile` 每次都要 `1 GET + N PUT`（100 本 = 101 个请求）⇒ 会打出请求风暴。
   * 分组只有几十条、改动低频，才继续用 `reconcile`。
   *
   * 主键 = `key`（= `itemKey(sourceId, payload)`）**经 `encodeItemKey` 转义**后放进契约 `bookUrl`。
   * ★ 转义是必需的，不是洁癖：`itemKey` 的分隔符是 `\u0000`，而 `node:sqlite` **读回时在 NUL 处截断**
   * （实测见 `utils/user-map.ts` 的 `encodeItemKey`）—— 不转义会让服务端读回的主键只剩 sourceId。
   * `idOf` 与 `toRemote` 必须用**同一个**转义后的形态，否则 `pushDiff` 会把同一条当成两条。
   */
  const SHELF_PLAN: SyncPlan<ShelfBook> = {
    localKey: SHELF_KEY,
    pendingKey: SHELF_PENDING_KEY,
    list: async () => (await listBooksRemote()).map(contractToShelfBook),
    put: (b) => putBookRemote(b as Parameters<typeof putBookRemote>[0]),
    remove: (id) => deleteBookRemote(id),
    toRemote: (b) => shelfBookToContract(b, shelfKeyOf(b)) as unknown as Record<string, unknown>,
    idOf: (b) => encodeItemKey(shelfKeyOf(b)),
  };
  const pushShelf = createPusher(SHELF_PLAN, () => shelf.value, '书架');
  // 阶段 1.5（`#143`）：登记给 `resyncAll()`（增量推，书架是热路径）
  registerSyncTarget({
    localKey: SHELF_KEY,
    pendingKey: SHELF_PENDING_KEY,
    label: '书架',
    resync: () => pushDiff(SHELF_PLAN, shelf.value),
  });

  function saveShelf() {
    writeLocal(SHELF_KEY, shelf.value); // ① 本地缓存（服务端没起时的安全网）
    pushShelf(); // ② 增量推服务端（防重入 + 合并，见 utils/server-sync.ts）
  }

  /**
   * 契约 **42 个字段**里没有对应项、只能由本地缓存承载的三项：
   * `lastChapter.payload`（引擎章节 payload）/ `progressSec` / `durationSec`（影视播放秒数）。
   *
   * 对齐时从「对齐前的本地」回填，否则：
   *  · 「继续阅读」从「按章节 URL 精确命中」降级为「按章节索引」（跨设备时无所谓，同设备本可精确）；
   *  · 影视库的续播进度条归零。
   *
   * 章节 payload 只在**章节标题一致**时才回填 —— 标题不同说明服务端那份进度更新，
   * 拿旧 payload 去配新章节会指到错的章节（宁可退化成按索引）。
   */
  function mergeLocalExtras(remote: ShelfBook, local: readonly ShelfBook[]): ShelfBook {
    const l = local.find((x) => shelfKeyOf(x) === shelfKeyOf(remote));
    if (!l) return remote;
    const out: ShelfBook = { ...remote };
    if (l.lastChapter?.payload && out.lastChapter && l.lastChapter.title === out.lastChapter.title) {
      out.lastChapter = { title: out.lastChapter.title, payload: l.lastChapter.payload };
    }
    if (out.progressSec === undefined && l.progressSec !== undefined) out.progressSec = l.progressSec;
    if (out.durationSec === undefined && l.durationSec !== undefined) out.durationSec = l.durationSec;
    return out;
  }

  /**
   * 启动时与服务端对齐（Phase 1.4 / `#66`）。返回对齐来源，便于探针/日志断言。
   * 离线时**保持本地不动**（不抛错）—— 服务端没起是常态（用户关窗即停）。
   *
   * ⚠️ **必须在任何用户写入之前完成**（`main.ts` 在 `mount` 前 await 它）：
   * 否则「服务端非空 ⇒ 以服务端为准」这一步会把用户刚加的书覆盖掉。
   *
   * ★ **删除墓碑**（用户 2026-11-08，跨端一致删除）：对齐前先拉墓碑，把「比墓碑更旧」的
   * 本地条目剔除 —— `pull({ mergeLocal: true })` 的合并语义只做加法，它**无法区分**
   * 「本地新增还没推」与「另一端删了但本地缓存还在」。不先剔除，本地陈旧副本会被
   * **立即 PUT 回服务端** ⇒ 已删的历史/书复活。服务端侧也会拒绝这类写入（双保险）。
   */
  async function hydrateShelf(): Promise<SyncSource> {
    const local = shelf.value.slice();
    const tombstones = await loadShelfTombstones();
    const tombstoned = (b: ShelfBook): boolean => {
      const d = tombstones.get(encodeItemKey(shelfKeyOf(b)));
      return d !== undefined && (b.updatedAt ?? 0) < d;
    };
    // ① 先清本地陈旧副本（即使后面 pull 失败/离线，这一步也要生效）
    const alive = tombstones.size ? shelf.value.filter((b) => !tombstoned(b)) : shelf.value;
    if (alive.length !== shelf.value.length) {
      shelf.value = alive;
      writeLocal(SHELF_KEY, shelf.value);
    }
    // `#191`：合并语义（服务端 + 本地独有）⇒ 离线新增/一端新增未同步都不会被另一端覆盖
    const r = await pullEntity(SHELF_PLAN, shelf.value, { mergeLocal: true });
    if (r.items) {
      // ② 服务端返回的条目也过一遍墓碑（服务端已拒绝陈旧 upsert，这里是兜底）
      const items = tombstones.size ? r.items.filter((b) => !tombstoned(b)) : r.items;
      shelf.value = items.map((it) => mergeLocalExtras(it, local));
      writeLocal(SHELF_KEY, shelf.value);
      // `#141`：服务端的 notShelf 行（别的设备记的观影历史）回填本地历史列表。
      // 只补本地没有的 key（本地已有的以本地为准——它可能有更细的 lastEpisode）。
      let wChanged = false;
      for (const b of shelf.value) {
        if (b.kind !== 'video' || !b.notShelf) continue;
        const k = shelfKeyOf(b);
        if (!watchHistory.value.some((x) => (x.key ?? itemKey(x.sourceId, x.payload)) === k)) {
          watchHistory.value.unshift({
            key: k, sourceId: b.sourceId, payload: b.payload, title: b.title, cover: b.cover,
            lastEpisode: b.lastChapter ? { ...b.lastChapter } : undefined,
            progressSec: b.progressSec, durationSec: b.durationSec,
            updatedAt: b.updatedAt,
          });
          wChanged = true;
        }
      }
      if (wChanged) {
        watchHistory.value.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        saveWatch();
      }
    }
    // ③ 观影历史是**独立**的 localStorage 键（不随书架覆盖）⇒ 必须同样剔除已删条目
    if (tombstones.size) {
      const before = watchHistory.value.length;
      watchHistory.value = watchHistory.value.filter((w) => {
        const d = tombstones.get(encodeItemKey(w.key ?? itemKey(w.sourceId, w.payload)));
        return d === undefined || (w.updatedAt ?? 0) >= d;
      });
      if (watchHistory.value.length !== before) saveWatch();
    }
    if (r.source !== 'server') {
      console.info(`[reader] 书架对齐来源：${r.source}（共 ${shelf.value.length} 本）`);
    }
    return r.source;
  }

  /**
   * 拉服务端的**删除墓碑**（`bookUrl → deletedAt`）。
   *
   * 失败时返回空表并**留痕**，理由与 `pull` 的离线分支相同：
   * 服务端没起是日常（用户关窗即停），此时本地照常可用；空表等于「本次不做墓碑过滤」，
   * 而服务端侧的拒绝写入仍能挡住复活（只是本地陈旧副本要等下一次启动才被清掉）。
   * ⚠️ 失败必须留痕（`console.warn`）—— 静默失败会让「删除不同步」看起来像「删了又出现」。
   */
  async function loadShelfTombstones(): Promise<Map<string, number>> {
    try {
      const list = await listDeletedBooksRemote();
      return new Map(list.map((t) => [t.bookUrl, t.deletedAt]));
    } catch (e) {
      console.warn(`[reader] 拉取删除墓碑失败（本次不做过期副本清理）：${String((e as Error)?.message ?? e)}`);
      return new Map();
    }
  }

  /**
   * 书签（用户 4-4；字段照 Legado `Bookmark.kt` 逐条对齐）。
   *
   * Legado 的字段与我们的落点：
   *   · `time`（主键，毫秒）→ 我们同样用它当主键（同一毫秒重复由 `at` 兜底去重）;
   *   · `bookName` / `bookAuthor` / `chapterIndex` / `chapterPos` / `chapterName` /
   *     `bookText`（章节名快照）/ `content`（选中文本）→ **原样保留**；
   *   · 额外加 `sourceId`：Legado 用「书名+作者」定位书（同名书会串），我们加源 id 更稳。
   *
   * `chapterPos` 是**选中文本在本章正文里的字符偏移**（Legado 用它把书签跳回原位置），
   * 我们按「本章拼接后的纯文本」算，跳转时用它滚动定位。
   */
  const BOOKMARK_KEY = 'yuedu-bookmarks';
  /**
   * 本地**缓存**里最多留多少条书签。
   *
   * ⚠️ 这是**缓存体积护栏，不是数据上限**：Phase 1.4 之后权威在服务端（契约 `Bookmark` 表没有条数上限，
   * Legado 也没有）。所以内存里的 `bookmarks` **不截断**，只有写进 localStorage 的那份截断 ——
   * 否则「服务端 600 条 → 本地截成 500 → 推送时按差异删掉 100 条」会**静默删用户数据**。
   */
  const BOOKMARK_CACHE_MAX = 500;
  const bookmarks = ref<Bookmark[]>(readLocal<Bookmark>(BOOKMARK_KEY));
  /** 「上次没推上服务端」标记（`utils/server-sync.ts` 的 pendingSync） */
  const BOOKMARKS_PENDING_KEY = 'yuedu-bookmarks-pending';

  /**
   * 书签的同步方案。主键 `time`（毫秒，契约同）。
   *
   * ⚠️ 契约 `Bookmark` **8 个字段里没有 `sourceId`**（Legado 用「书名+作者」定位书，
   * 所以书签按设计就不随换源迁移）。本仓的 `sourceId` 由本地缓存承载，`hydrateBookmarks` 回填。
   */
  const BOOKMARKS_PLAN: SyncPlan<Bookmark> = {
    localKey: BOOKMARK_KEY,
    pendingKey: BOOKMARKS_PENDING_KEY,
    list: async () => (await listBookmarksRemote()).map(contractToBookmark),
    put: (b) => putBookmarkRemote(b as Parameters<typeof putBookmarkRemote>[0]),
    remove: (time) => deleteBookmarkRemote(time),
    toRemote: (b) => bookmarkToContract(b) as unknown as Record<string, unknown>,
    idOf: (b) => String(b.time),
  };
  const pushBookmarks = createPusher(BOOKMARKS_PLAN, () => bookmarks.value, '书签');
  // 阶段 1.5（`#143`）：登记给 `resyncAll()`
  registerSyncTarget({
    localKey: BOOKMARK_KEY,
    pendingKey: BOOKMARKS_PENDING_KEY,
    label: '书签',
    resync: () => pushDiff(BOOKMARKS_PLAN, bookmarks.value),
  });

  function saveBookmarks() {
    writeLocal(BOOKMARK_KEY, bookmarks.value.slice(0, BOOKMARK_CACHE_MAX)); // ① 本地缓存（有体积上限）
    pushBookmarks(); // ② 增量推服务端（推的是**未截断**的完整列表）
  }

  /**
   * 启动时与服务端对齐。**回填 `sourceId`**（契约里没有它）——
   * 不回填的话「打开某本书 → 书签列表空了」（`currentBookmarks` 按 `sourceId` 过滤），
   * 而书签明明还在，用户只会认为「书签丢了」。
   */
  async function hydrateBookmarks(): Promise<SyncSource> {
    const local = bookmarks.value.slice();
    const r = await pullEntity(BOOKMARKS_PLAN, bookmarks.value, { mergeLocal: true }); // `#191`
    if (r.items) {
      bookmarks.value = r.items.map((it) => {
        if (it.sourceId) return it;
        const l = local.find((x) => x.time === it.time);
        return l?.sourceId ? { ...it, sourceId: l.sourceId } : it;
      });
      writeLocal(BOOKMARK_KEY, bookmarks.value.slice(0, BOOKMARK_CACHE_MAX));
    }
    if (r.source !== 'server') {
      console.info(`[reader] 书签对齐来源：${r.source}（共 ${bookmarks.value.length} 条）`);
    }
    return r.source;
  }

  /**
   * 当前这本书的书签（按 time 倒序：最新的在前）。
   *
   * 匹配口径：**优先 `sourceId`**（同名书不串，这是本仓比 Legado 更严的地方），
   * `sourceId` 为空（= 刚从服务端拿回来、本机缓存里没有它的源信息，比如另一台设备加的）
   * 时**回落到按书名**（Legado 的原口径）—— 宁可同名书合并显示，也不要让书签「凭空消失」。
   */
  const currentBookmarks = computed(() => {
    const title = detail.value?.title ?? '';
    return bookmarks.value
      .filter((b) => (b.sourceId ? b.sourceId === sourceId.value && b.bookName === title : b.bookName === title))
      .sort((a, b) => b.time - a.time);
  });
  function addBookmark(p: { chapterIndex: number; chapterPos: number; chapterName: string; content: string }): Bookmark {
    const b: Bookmark = {
      time: Date.now(),
      sourceId: sourceId.value,
      bookName: detail.value?.title ?? '',
      bookAuthor: detail.value?.author ?? detail.value?.subtitle ?? '',
      chapterIndex: p.chapterIndex,
      chapterPos: p.chapterPos,
      chapterName: p.chapterName,
      bookText: p.chapterName,
      content: p.content,
    };
    // ⚠️ 这里**不再** `.slice(0, 500)`：内存里保留完整列表（权威在服务端），
    // 体积护栏只作用于写进 localStorage 的那份缓存（见 BOOKMARK_CACHE_MAX）。
    // 原来的写法在「服务端已有 600 条」时会被推送逻辑当成「用户删了 100 条」而真的删掉。
    bookmarks.value = [b, ...bookmarks.value];
    saveBookmarks();
    return b;
  }
  function removeBookmark(time: number): void {
    bookmarks.value = bookmarks.value.filter((b) => b.time !== time);
    saveBookmarks();
  }
  function hasBookmarkAt(chapterIndex: number, pos: number): boolean {
    return currentBookmarks.value.some((b) => b.chapterIndex === chapterIndex && Math.abs(b.chapterPos - pos) < 2);
  }

  /** 当前正在看的书/剧的键（详情页上下文由 sourceId + it0.payload 决定） */
  const currentKey = computed(() => itemKey(sourceId.value, it0.value?.payload));

  /* ---------------- 划线高亮 / 笔记（`#146`；契约 `BookHighlight` 13 字段） ----------------
   *
   * 与书签同构（同样 `time` 主键、同样「本地缓存 + 服务端」），所以直接复用同一套同步机制，
   * 不再发明第二种。差异只有两处，都已在下面对应位置写明：
   *  ① 契约 `BookHighlight` **自带 `bookUrl` / `bookAuthor`** ⇒ 不需要书签那种 `sourceId` 回填；
   *  ② 定位锚点是**正文偏移**（见 `utils/chapter-text.ts` 的坐标系说明），不是页码。
   */
  const HIGHLIGHT_KEY = 'yuedu-highlights';
  /** 本地缓存条数护栏（同书签：**权威在服务端**，只有写 localStorage 的那份截断） */
  const HIGHLIGHT_CACHE_MAX = 500;
  const highlights = ref<BookHighlight[]>(readLocal<BookHighlight>(HIGHLIGHT_KEY));
  const HIGHLIGHTS_PENDING_KEY = 'yuedu-highlights-pending';

  /**
   * 章节的「次级定位键」（契约 `BookHighlight.chapterUrl`）。
   *
   * 优先取 payload 里的 `chapterUrl`（源给的章节地址；`reader.ts` 的续读定位也按这个口径），
   * 没有再退回 `url`。**都没有就留空** —— 我们不编造 URL：本章的权威锚点是
   * `chapterIndex` + 正文偏移，`chapterUrl` 只为「与 Legado 数据对齐 / 跨源重定位」存在。
   */
  function chapterUrlOf(ch: UnifiedChapter | undefined): string {
    const p = ch?.payload as { chapterUrl?: string; url?: string } | undefined;
    return p?.chapterUrl ?? p?.url ?? '';
  }

  /** 当前这本书的 `bookUrl`（= `encodeItemKey(itemKey(sourceId, payload))`） */
  const currentBookUrl = computed(() => encodeItemKey(currentKey.value));

  const HIGHLIGHTS_PLAN: SyncPlan<BookHighlight> = {
    localKey: HIGHLIGHT_KEY,
    pendingKey: HIGHLIGHTS_PENDING_KEY,
    list: async () => listHighlightsRemote(),
    put: (h) => putHighlightRemote(h),
    remove: (time) => deleteHighlightRemote(time),
    // 契约字段与远端一致（没有本仓扩展字段）⇒ 原样上行，不做映射
    toRemote: (h) => h as unknown as Record<string, unknown>,
    idOf: (h) => String(h.time),
  };
  const pushHighlights = createPusher(HIGHLIGHTS_PLAN, () => highlights.value, '高亮');
  registerSyncTarget({
    localKey: HIGHLIGHT_KEY,
    pendingKey: HIGHLIGHTS_PENDING_KEY,
    label: '高亮',
    resync: () => pushDiff(HIGHLIGHTS_PLAN, highlights.value),
  });

  function saveHighlights(): void {
    writeLocal(HIGHLIGHT_KEY, highlights.value.slice(0, HIGHLIGHT_CACHE_MAX));
    pushHighlights();
  }

  async function hydrateHighlights(): Promise<SyncSource> {
    const r = await pullEntity(HIGHLIGHTS_PLAN, highlights.value, { mergeLocal: true }); // `#191`
    if (r.items) {
      highlights.value = r.items;
      writeLocal(HIGHLIGHT_KEY, highlights.value.slice(0, HIGHLIGHT_CACHE_MAX));
    }
    if (r.source !== 'server') {
      console.info(`[reader] 高亮对齐来源：${r.source}（共 ${highlights.value.length} 条）`);
    }
    return r.source;
  }

  /**
   * 当前这本书的高亮。
   *
   * 匹配口径**优先 `bookUrl`**（`BookHighlight` 自带，也是服务端的过滤器），
   * 为空时回落到「书名+作者」（Legado 的原口径）—— 与书签同一个理由：
   * 宁可同名书合并显示，也不要让用户的划线「凭空消失」。
   */
  const currentHighlights = computed(() => {
    const url = currentBookUrl.value;
    const title = detail.value?.title ?? '';
    const author = detail.value?.author ?? detail.value?.subtitle ?? '';
    return highlights.value
      .filter((h) => (h.bookUrl ? h.bookUrl === url : h.bookName === title && h.bookAuthor === author))
      .sort((a, b) => a.chapterIndex - b.chapterIndex || a.chapterPos - b.chapterPos);
  });

  /** 本章的高亮（渲染用） */
  const currentChapterHighlights = computed(() =>
    currentHighlights.value.filter((h) => h.chapterIndex === chapterIdx.value),
  );

  /**
   * 新建一条划线/笔记。
   *
   * `chapterPos/chapterPosEnd` 是 `utils/chapter-text.ts` 坐标系里的**正文偏移**，
   * 落库时写 `layoutTitleLength = 0`（原因为何如实，见该文件顶部的换算说明）。
   *
   * ★ `#256`：样式不再恒写 `''` —— 取**上次用过的那套**（`prefs.highlightLastStyle`），
   *   没调过才回落到 `HIGHLIGHT_STYLE_DEFAULT`。上游同一机制：
   *   `ReadBookActivity.kt:1272-1277` + `visibleHighlightStyle()`（`:3017-3019`）。
   *   ⇒ 用户调过一次「蓝底胶囊」之后，后面新划的都是蓝底胶囊，不必每条重调。
   */
  function addHighlight(p: {
    chapterIndex: number;
    start: number;
    end: number;
    text: string;
    note?: string;
  }): BookHighlight | null {
    if (!(p.end > p.start) || !p.text.trim()) return null;
    const ch = detail.value?.chapters?.[p.chapterIndex];
    const h: BookHighlight = {
      time: Date.now(),
      bookUrl: currentBookUrl.value,
      chapterUrl: chapterUrlOf(ch),
      bookName: detail.value?.title ?? '',
      bookAuthor: detail.value?.author ?? detail.value?.subtitle ?? '',
      chapterIndex: p.chapterIndex,
      chapterPos: p.start,
      chapterPosEnd: p.end,
      // 我们的正文布局里标题是独立元素 ⇒ 正文里含 0 个标题字符（不等于「未知」的 -1）
      layoutTitleLength: 0,
      chapterName: ch?.title ?? chapter.value?.title ?? '',
      bookText: p.text,
      style: serializeHighlightStyle(lastHighlightStyle()),
      note: p.note ?? '',
    };
    highlights.value = [h, ...highlights.value];
    saveHighlights();
    return h;
  }

  /**
   * 「上次使用的高亮样式」（`#256`）。
   *
   * ★ 判据链与上游 `visibleHighlightStyle()` 一致：`prefs.highlightLastStyle` 解析出来**有东西**就用它，
   *   否则用默认样式。**注意**：`parseHighlightStyle` 对坏 JSON 会回落成「空样式」，
   *   所以这里必须再过一道 `visibleHighlightStyle`，否则一条坏 JSON 会让新建的高亮**完全看不见**。
   */
  function lastHighlightStyle(): HighlightStyleView {
    return visibleHighlightStyle(parseHighlightStyle(prefs.value.highlightLastStyle));
  }

  /** 给已有划线补/改笔记（`time` 是主键，改完仍是同一条） */
  function setHighlightNote(time: number, note: string): void {
    highlights.value = highlights.value.map((h) => (h.time === time ? { ...h, note } : h));
    saveHighlights();
  }

  /**
   * 给已有划线改样式（JSON 字符串，`HighlightStyle.kt` 的子集）。
   *
   * ★ `#256`：同时把它记成「上次样式」⇒ 下一条新划的沿用（上游 `PreferKey.highlightLastStyle`）。
   *   样式编辑是**实时预览**（改一下写一下）⇒ 这里会被频繁调用；`patchPrefs` 走的是防抖落盘，
   *   高频调用不会打爆请求（见 `utils/server-sync.ts` 的 `pushObject`）。
   */
  function setHighlightStyle(time: number, style: string): void {
    highlights.value = highlights.value.map((h) => (h.time === time ? { ...h, style } : h));
    saveHighlights();
    patchPrefs({ highlightLastStyle: style });
  }

  function removeHighlight(time: number): void {
    highlights.value = highlights.value.filter((h) => h.time !== time);
    saveHighlights();
  }

  /* ---------------- 书内全文搜索（`#146` 第三步） ----------------
   *
   * 对齐上游 `ui/book/searchContent/`：
   *  · **逐章顺序**扫描，**只搜已有正文的章节**（上游看磁盘章节文件，我们看 IndexedDB）——
   *    绝不「没有缓存就去抓」：那会把一次搜索变成几百次站点请求。
   *  · 每章取正文 → 找全部命中 → 每处产出一条（片段 = 关键词左右各 20 字，纯逻辑在 `utils/book-search.ts`）。
   *  · **增量出结果**（搜到就追加，用户不用等整本扫完）+ 可中止 + 进度可见。
   *
   * ★ **刻意没有「净化替换」开关**：上游有 `replaceEnabled`，但本仓引擎还没有净化规则的任何
   *   应用点（全仓只有 `listReplaceRules()` 与端点）⇒ 给了就是「一个不起作用的设置」。等 `#144` 落地再加。
   * ★ **正则**开关有（纯前端 `RegExp`），非法正则会**明确提示**而不是静默返回 0 条。
   */
  const bookSearchOpen = ref(false);
  const bookSearchQuery = ref('');
  const bookSearchRegex = ref(false);
  const bookSearchRunning = ref(false);
  const bookSearchHits = ref<SearchHit[]>([]);
  /** 给用户看的一句说明（正则非法 / 可搜章节数 / 结果被截断）——**不静默** */
  const bookSearchNote = ref('');
  const bookSearchProgress = ref({ done: 0, total: 0, cached: 0, truncated: 0 });
  /** 中止标记（`ref` 不必要：只有搜索循环自己读它） */
  let bookSearchAbort = false;

  function cancelBookSearch(): void {
    bookSearchAbort = true;
    bookSearchRunning.value = false;
  }

  function closeBookSearch(): void {
    cancelBookSearch();
    bookSearchOpen.value = false;
  }

  async function runBookSearch(): Promise<void> {
    const q = bookSearchQuery.value.trim();
    const chs = detail.value?.chapters ?? [];
    bookSearchHits.value = [];
    bookSearchNote.value = '';
    bookSearchProgress.value = { done: 0, total: chs.length, cached: 0, truncated: 0 };
    if (!q) { bookSearchNote.value = '请输入要搜索的内容'; return; }
    if (!chs.length) { bookSearchNote.value = '目录还没加载，无法搜索'; return; }

    // 只搜「已缓存正文」的章节 —— 一次游标扫出 key 集合（逐章查是 2000 次 IndexedDB 往返）
    const keys = await cachedChapterKeys(sourceId.value);
    bookSearchAbort = false;
    bookSearchRunning.value = true;

    const type = prefs.value.chineseConverterType;
    const convert = isChineseConvertOn(type);
    const acc: SearchHit[] = [];
    let cachedCount = 0;
    let truncatedChapters = 0;

    for (let i = 0; i < chs.length; i += 1) {
      if (bookSearchAbort) break;
      const ch = chs[i];
      const cached = ch && !ch.isVolume && keys.has(chapterKey(sourceId.value, ch.payload))
        ? await getCachedChapter(sourceId.value, ch.payload)
        : null;
      if (!cached?.paragraphs?.length) {
        bookSearchProgress.value = { ...bookSearchProgress.value, done: i + 1, cached: cachedCount, truncated: truncatedChapters };
        continue;
      }
      cachedCount += 1;
      /**
       * ★ 开着简繁时**转换正文**再搜（与正文渲染用同一个 `convertChineseBatch`）：
       * 这样 `chapterPos` 落在**显示层坐标系**里，点结果能精确跳转；
       * 若改成「转查询词」，位置会落回原文坐标，开着简繁时跳转会偏。
       */
      const paras = convert ? await convertChineseBatch(cached.paragraphs, type) : cached.paragraphs;
      const content = chapterTextOf(paras);
      const { result, regexError } = searchChapterContent({
        content,
        query: q,
        chapterIndex: i,
        // 章名也用显示层（上游同样在搜索路径里转 chapter.title）
        chapterTitle: convertedTocTitles.value?.[i] ?? ch?.title ?? '',
        isRegex: bookSearchRegex.value,
      });
      if (regexError) {
        bookSearchNote.value = '正则表达式无效，请检查写法';
        bookSearchRunning.value = false;
        return;
      }
      if (result.truncated) truncatedChapters += 1;
      if (result.hits.length) {
        acc.push(...result.hits);
        bookSearchHits.value = sortHits(acc); // 增量出结果
      }
      bookSearchProgress.value = { done: i + 1, total: chs.length, cached: cachedCount, truncated: truncatedChapters };
      // 每 20 章让出一次主线程：否则一本 2000 章的书会把界面冻住（进度条也刷不出来）
      if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
    }

    bookSearchRunning.value = false;
    const p = bookSearchProgress.value;
    const notes: string[] = [];
    if (p.cached === 0) {
      /**
       * ⚠️ 这句必须**说清怎么才能有缓存** —— 本仓与上游有个真实分歧：
       * 上游 Legado **阅读时就会把正文写盘**，所以它「只搜已缓存」是对的；
       * 本仓**刻意不在阅读时偷偷攒缓存**（见 `openChapter` 的 `mode` 说明）。
       * ⇒ 「已缓存」只有两个来源：用户手动「⬇ 离线缓存」，以及**书架内书籍的自动预缓存窗口**
       *   （`#5-5`，默认当前章之后 20 章，见 `precacheCount`）。
       * 所以对一本**没入书架**的书，这里必然 0 条 —— 不能让用户以为「搜索坏了」。
       */
      notes.push(
        '还没有已缓存的正文可搜。两种办法：① 把它加入书架（会自动预缓存当前章之后的章节）；'
        + '② 用「⬇ 离线缓存」手动缓存一段',
      );
    } else {
      notes.push(`已扫 ${p.cached}/${p.total} 章（只搜已缓存的正文，未缓存的章节不会联网抓）`);
    }
    if (truncatedChapters) notes.push(`有 ${truncatedChapters} 章的命中过多、已按每章 ${MAX_HITS_PER_CHAPTER} 条截断`);
    if (bookSearchAbort) notes.push('已中止');
    if (!bookSearchHits.value.length && p.cached > 0) notes.push('没有找到匹配内容');
    bookSearchNote.value = notes.join(' · ');
  }

  /**
   * 「已收藏」判据。★ `#141`：**必须排除 notShelf 行**——观影历史行也在 `shelf.value`
   * 里（同一张表），不排除的话「看过没收藏」的剧会误报已收藏（图标亮、再点变取消）。
   */
  function hasInShelf(key: string): boolean {
    return !!key && shelf.value.some((b) => b.key === key && !b.notShelf);
  }
  const inCurrentShelf = computed(() => hasInShelf(currentKey.value));

  /**
   * 把一本书的**详情 / 目录**本地化（用户 5-2/5-4；`#434` 补「没有就主动拉一次」）。
   *
   * 用户口径（2026-10-13）：**点击加入书架时，详情/目录即缓存本地** —— 之后从书架打开
   * 应当零等待（本地命中直接铺），不该再联网拉一次，更不该卡在 `NETWORK@request 连接超时`。
   *
   * 三种情形（旧实现**只有第 ① 种** ⇒ 从卡片加入的书 / 详情加载失败时加入的书永远没有本地
   * 目录，之后每次打开书架的书都重新联网 —— 正是用户实测的形态）：
   *  ① 内存里已有本书目录（用户就是"看了详情才加入"）⇒ **零网络**直接落盘；
   *  ② 本地索引里已有 ⇒ 幂等跳过（不重复拉）；
   *  ③ 都没有 ⇒ **主动拉一次**详情再落盘（这是 `#434` 新增的那条）。
   *
   * 失败**不抛**（加入书架是本地动作，不该被网络拖挂，也不该让书架条目消失）——
   * 控制台留痕即可，用户下次从书架打开时会照常按现有回落逻辑重试。
   * 落盘同时把章节总数写进书架条目（进度条 / 未读角标立刻有数，判据见 `noteTocLoaded`）。
   */
  async function localizeBook(b: ShelfBook): Promise<void> {
    const key = b.key ?? itemKey(b.sourceId, b.payload);
    let d: ReaderDetail | null = null;
    if (currentKey.value === key && detail.value?.chapters?.length) {
      d = detail.value;                                   // ① 内存已有：零网络
    } else {
      const cached = await getBookMeta<ReaderDetail>(key);
      if (cached?.detail?.chapters?.length) return;       // ② 本地已有：幂等跳过
      try {
        const r = await fetchDetail(b.sourceId, b.payload, key);   // ③ 主动拉一次
        if (r?.chapters?.length) d = r;
      } catch (e) {
        console.warn('[shelf] 加入书架后拉取详情失败（本地化跳过，不影响书架条目）', e);
        return;
      }
    }
    if (!d?.chapters?.length) return;
    if ((b.totalChapterNum ?? 0) < d.chapters.length) b.totalChapterNum = d.chapters.length;
    if (!b.title && d.title) b.title = d.title;
    saveShelf();
    await putBookMeta(key, d);
    // 用户是**先读了几章再收藏**的（当前会话就是这本书）⇒ 立刻按窗口向后预缓存
    // （默认 20 章，用户 5-5；窗口维护见 `prefetchWindow`）。没在读则等打开时再触发。
    if (currentKey.value === key) schedulePrefetch();
  }

  /**
   * `#436` **同名同作者：继承阅读进度**（对齐 Legado `BookInfoViewModel.addToBookshelf:545-549`）。
   *
   * 上游语义：`BookDao.kt:125` 的 `getBook(name, author)`（`WHERE name = :name and author = :author`）
   * —— 加入书架时若库里已有**同名同作者**的书，就把它的
   * `durChapterIndex/durChapterPos/durChapterTitle` **搬过来**（**仍插新行**：书架主键是 `bookUrl`，
   * 同名不同源本来就是两行，见 `#435` ⑤ 的查证）。
   *
   * 为什么有用：一本书的源加载失败时，用户会去**跨源搜索**里重新加入同名书 ——
   * 进度不该因此清零（上游同样会继承）。
   *
   * ⚠️ **只在目标行还没有进度时**继承：本仓有「观影历史行转正」这条上游没有的路径，
   * 那种行自带进度，覆盖它是错的。
   * ⚠️ `lastChapter.payload` 是**源相关**的（换源后对不上），真正起作用的是
   * {@link resolveProgressIdx} 的 `lastIdx` 兜底与 UI 显示的 `title` —— 照抄即可，不必"修正"。
   */
  function inheritProgressByNameAuthor(b: ShelfBook): void {
    if (!b.title || b.lastIdx !== undefined || b.lastChapter) return;
    const name = b.title.trim();
    const author = (b.author ?? '').trim();
    if (!name || !author) return; // 上游 SQL 要求 name+author 同时相等；作者缺失**不猜**
    const from = shelf.value.find(
      (x) => x.key !== b.key && !x.notShelf && x.title.trim() === name &&
        (x.author ?? '').trim() === author && (x.lastIdx !== undefined || !!x.lastChapter),
    );
    if (!from) return;
    if (from.lastChapter) b.lastChapter = { ...from.lastChapter };
    if (from.lastIdx !== undefined) b.lastIdx = from.lastIdx;
  }

  function toggleShelf() {
    const d = detail.value;
    if (!d?.title) return;
    const key = currentKey.value;
    if (hasInShelf(key)) {
      shelf.value = shelf.value.filter((b) => b.key !== key);
      saveShelf();
      return;
    }
    /**
     * `#141`：已有观影历史行（看过没收藏）⇒ **转正**为收藏行（进度/最后观看的集保留）。
     * 一部剧一行是 D1-B 的前提，新建第二行会「同主键两行互相删」。
     */
    const hist = shelf.value.find((x) => x.key === key);
    if (hist) {
      hist.notShelf = false;
      hist.author = hist.author ?? d.author;
      hist.cover = hist.cover ?? d.cover;
      hist.updatedAt = Date.now();
      saveShelf();
      void localizeBook(hist);
      return;
    }
    const b: ShelfBook = {
      key,
      sourceId: sourceId.value,
      payload: (it0.value ?? {}).payload ?? {},
      title: d.title,
      author: d.author,
      cover: d.cover,
      kind: (it0.value?.kind as string) ?? 'book',
      // `updatedAt` ≈ Legado `durChapterTime`，其默认值就是「当前时间」（`Book.kt:87`）——
      // 排序（最近阅读）与影视库都靠它，新加入的书不该是 0
      updatedAt: Date.now(),
    };
    // `#436`：同名同作者 ⇒ 继承另一本书的阅读进度（对齐上游 addToBookshelf）
    inheritProgressByNameAuthor(b);
    shelf.value.unshift(b);
    saveShelf();
    // 5-2 / `#434`：**入架当下就把详情/目录本地化**（内存没有就主动拉一次，见 {@link localizeBook}）。
    // 不做的话，「加入书架」后第一次打开还得重新拉一次详情，用户反馈的「每次都重新拉」就是这个形态。
    void localizeBook(b);
  }
  function removeFromShelf(b: ShelfBook) {
    void removeBooks([b]);
  }

  /**
   * **加入书架并可指定分组**（「加入书架」对话框的落地动作；用户实测 ①-3）。
   * 已在书架时只更新分组（同一个入口也能当「改分组」用）。
   */
  function addToShelf(groupId?: number): void {
    const d = detail.value;
    if (!d?.title) return;
    const key = currentKey.value;
    let b = shelf.value.find((x) => x.key === key && !x.notShelf);
    if (!b) {
      // `#141`：有历史行（看过没收藏）⇒ 转正（一部剧一行）；都没有才新建
      const hist = shelf.value.find((x) => x.key === key && x.notShelf);
      if (hist) {
        b = hist;
        b.notShelf = false;
        b.author = b.author ?? d.author;
        b.cover = b.cover ?? d.cover;
        b.updatedAt = Date.now();
      } else {
        b = {
          key,
          sourceId: sourceId.value,
          payload: (it0.value ?? {}).payload ?? {},
          title: d.title,
          author: d.author,
          cover: d.cover,
          kind: (it0.value?.kind as string) ?? 'book',
          updatedAt: Date.now(),
        };
        // `#436`：同名同作者 ⇒ 继承另一本书的阅读进度（对齐上游 `addToBookshelf`）
        inheritProgressByNameAuthor(b);
        shelf.value.unshift(b);
      }
    }
    if (groupId !== undefined) setBookGroup(b, groupId);
    saveShelf();
    // `#434`：入架即本地化详情/目录（内存没有就主动拉一次，见 {@link localizeBook}）
    void localizeBook(b);
  }

  /* ------------------------------------------------------------------ *
   * 书架分组（模型与语义见 `apps/web/src/shelf-groups.ts` 顶部）
   * ------------------------------------------------------------------ */

  const GROUPS_KEY = 'yuedu-shelf-groups';
  /**
   * 全局书架排序（对应 Legado `AppConfig.bookshelfSort`）：分组 `bookSort < 0`（跟随全局）时用它。
   * 「全部 / 未分组」这两个虚拟视图没有自己的组，也走这个值。
   */
  const SHELF_SORT_KEY = 'yuedu-bookshelf-sort';
  const shelfSort = ref<number>(Number(localStorage.getItem(SHELF_SORT_KEY) ?? String(DEFAULT_BOOK_SORT)));
  function setShelfSort(v: number): void {
    shelfSort.value = v;
    localStorage.setItem(SHELF_SORT_KEY, String(v));
  }
  const groups = ref<ShelfGroup[]>(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]'));
  /** 「上次没推上服务端」标记（`utils/server-sync.ts` 的 pendingSync） */
  const GROUPS_PENDING_KEY = 'yuedu-shelf-groups-pending';
  /**
   * 分组的同步方案（策略见 `utils/server-sync.ts` 顶部：服务端非空则服务端为准、
   * 服务端空且有本地数据做一次性搬迁、写入走「本地缓存 + 推服务端」、离线留 pendingSync）。
   *
   * 主键统一**字符串化**：契约 `BookGroup.groupId` 是 number，而 DELETE 的 query 参数是字符串
   * （`apps/server/src/index.ts:607` 用 `qNum` 解析），两边都按 `String(groupId)` 对齐。
   */
  const GROUPS_PLAN: SyncPlan<ShelfGroup> = {
    localKey: GROUPS_KEY,
    pendingKey: GROUPS_PENDING_KEY,
    list: async () => (await listGroupsRemote()).map(contractToShelfGroup),
    put: (g) => putGroupRemote(g as never),
    remove: (id) => deleteGroupRemote(id),
    toRemote: (g) => shelfGroupToContract(g) as unknown as Record<string, unknown>,
    idOf: (g) => String(g.groupId),
  };
  // 阶段 1.5（`#143`）：登记给 `resyncAll()` —— 服务端恢复后按当前本地状态重推这一份。
  registerSyncTarget({
    localKey: GROUPS_KEY,
    pendingKey: GROUPS_PENDING_KEY,
    label: '书架分组',
    resync: () => reconcileEntity(GROUPS_PLAN, groups.value),
  });
  /**
   * 写盘：**先写本地缓存**（保证服务端没起时也能用），再推服务端。
   * 推送失败只在**离线**时留痕 + 标记 pendingSync（下次启动重传）；其它错误由 `reconcile` 抛给调用方。
   */
  function saveGroups() {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups.value));
    void reconcileEntity(GROUPS_PLAN, groups.value)
      .then((r) => {
        if (r.offline) {
          console.warn('[reader] 分组已存本地，服务端不可达 ⇒ 标记 pendingSync，下次启动重传');
        }
      })
      .catch((e) => console.warn('[reader] 分组推送服务端失败（本地已保存，数据未丢）：', e));
  }
  /**
   * 启动时与服务端对齐（Phase 1.4 / `#66`）。返回对齐来源，便于探针/日志断言。
   * 离线时**保持本地不动**（不抛错）—— 服务端没起是常态（用户关窗即停）。
   */
  async function hydrateGroups(): Promise<SyncSource> {
    const r = await pullEntity(GROUPS_PLAN, groups.value, { mergeLocal: true }); // `#191`
    if (r.items) {
      groups.value = r.items;
      localStorage.setItem(GROUPS_KEY, JSON.stringify(groups.value));
    }
    if (r.source !== 'server') {
      console.info(`[reader] 书架分组对齐来源：${r.source}（共 ${groups.value.length} 个分组）`);
    }
    return r.source;
  }
  /** 按 `order` 排好的分组（管理页与左栏共用，保证两处顺序一致） */
  const groupsSorted = computed(() =>
    groups.value.slice().sort((a, b) => a.order - b.order || a.groupId - b.groupId),
  );
  /** 左栏只显示 `show` 的分组（Legado `BookGroup.show` + `BookGroupDao.flowShow`） */
  const groupsVisible = computed(() => groupsSorted.value.filter((g) => g.show));

  /**
   * 书架页**实际展示**的书（不含影视收藏）。
   *
   * 影视有自己的页面（`views/VideoLibView.vue`），但收藏条目和书共用 `shelf` 数组
   * （`toggleShelf` 只按 `kind` 区分）。分组计数**必须用同一个池子**，否则会出现
   * 「全部分组 2 本、未分组 3 本」这种自相矛盾的数字（实测过）。
   */
  const shelfPool = computed(() => shelf.value.filter((b) => b.kind !== 'video'));
  function groupBookCount(groupId: number): number {
    return shelfPool.value.filter((b) => isInGroup(b.group, groupId)).length;
  }
  const ungroupedCount = computed(
    () => shelfPool.value.filter((b) => isUngrouped(b.group, groups.value)).length,
  );
  /**
   * **在列书**（用户 2026-11-24 拍板的口径）：
   * = 未分组的书 + 所有**显示中**分组里的书，**不含被隐藏分组里的书**。
   *
   * · 隐藏一个分组 = 把里面的书一起藏起来，统计跟着变；未分组的书始终计入；
   * · 去重：一本书同时在两个在列分组里只算**一次**（「全部分组」是书的并集）；
   * · 只属于隐藏分组的书既不在「全部分组」也不在「未分组」（它确实归了组，只是组被藏了）；
   * · 指向已删分组的残位按「未分组」处理（`isUngrouped` 与 {@link ungroupedCount} 同判据）。
   *
   * 书架页**只用这一份口径**：标题「共 N 本」、「全部分组」的数字与列表。
   * ⚠️ 各分组行是「组内计数」（多分组书在每个组各计一次，Legado 位掩码语义），
   * 所以各分组行之和可能大于本数 —— 不是笔误。
   */
  const visibleBooks = computed(() => {
    const vis = groupsVisible.value;
    return shelfPool.value.filter(
      (b) => isUngrouped(b.group, groups.value) || vis.some((g) => isInGroup(b.group, g.groupId)),
    );
  });
  const visibleBookCount = computed(() => visibleBooks.value.length);

  /** 新建分组（照 Legado `GroupViewModel.addGroup`：`order = maxOrder + 1` ⇒ 排在最后） */
  function createGroup(name: string, bookSort = -1, show = true): ShelfGroup | null {
    const gid = nextGroupId(groups.value);
    if (!gid) return null; // 已达上限（见 shelf-groups.ts 的 SHELF_GROUP_MAX）
    const g: ShelfGroup = {
      groupId: gid,
      groupName: uniqueGroupName(name, groups.value),
      order: groups.value.reduce((m, x) => Math.max(m, x.order), 0) + 1,
      show,
      bookSort,
    };
    groups.value = [...groups.value, g];
    saveGroups();
    return g;
  }

  function updateGroup(groupId: number, patch: Partial<Omit<ShelfGroup, 'groupId'>>): void {
    const g = groups.value.find((x) => x.groupId === groupId);
    if (!g) return;
    const next: Partial<ShelfGroup> = { ...patch };
    if (patch.groupName !== undefined) next.groupName = patch.groupName.trim() || g.groupName;
    Object.assign(g, next);
    saveGroups();
  }

  /**
   * 删除分组。**两步都要做**（照 Legado `GroupViewModel.delGroup`）：
   * ① 从每本书上清掉这一位；② 删组。
   * 只删组不清位 ⇒ 书上留着指向不存在分组的位 ⇒ 该书在「未分组」里查不到、
   * 又不在任何分组里，变成**看不见的书**（Legado 的 `flowNetNoGroup` 判据正是为这种情况兜底）。
   */
  function deleteGroup(groupId: number): void {
    for (const b of shelf.value) b.group = removeGroupBit(b.group ?? 0, groupId);
    groups.value = groups.value.filter((g) => g.groupId !== groupId);
    saveShelf();
    saveGroups();
  }

  /** 分组排序：与相邻分组交换位置，并把 order 重写成紧凑的 1..N（持久化/迁移都干净） */
  function moveGroup(groupId: number, delta: number): void {
    const list = groupsSorted.value.slice();
    const i = list.findIndex((g) => g.groupId === groupId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const moved = list.splice(i, 1)[0];
    if (!moved) return;
    list.splice(j, 0, moved);
    // 注意：`list` 里的对象就是 `groups` 里的对象（slice 只复制数组），改 order 直接生效
    list.forEach((g, idx) => {
      g.order = idx + 1;
    });
    saveGroups();
  }

  /**
   * 设置书的分组（**下拉单选语义**：先清掉所有用户分组位，再置目标位；`groupId <= 0` = 未分组）。
   *
   * ⚠️ Legado 原始的「加入书架」对话框是**多选**（直接改位掩码，一本书可同时在多个组）；
   * 用户实测 ①-3 要求「现有分组**下拉列表**选择」⇒ 这里是单选语义。
   * 字段仍是位掩码（见 `shelf-groups.ts`），将来要做多选不用改数据。
   */
  function setBookGroup(b: ShelfBook, groupId: number): void {
    let mask = b.group ?? 0;
    for (const g of groups.value) mask = removeGroupBit(mask, g.groupId);
    if (groupId > 0) mask = addGroupBit(mask, groupId);
    b.group = mask;
    saveShelf();
  }

  /**
   * 阅读进度（`0~1`），**照 Legado `BookExtensions.kt:403-409` 逐条对齐**：
   * ```kotlin
   * fun Book.readProgress(): Float? {
   *     if (durChapterIndex == 0 && durChapterPos == 0) return null   // 未开始 ⇒ 不显示进度条
   *     val chapterCount = simulatedTotalChapterNum()
   *     if (chapterCount <= 1) return 1f                              // 只有 1 章视为读完
   *     val lastChapterIndex = chapterCount - 1
   *     return (durChapterIndex.toFloat() / lastChapterIndex).coerceIn(0f, 1f)
   * }
   * ```
   * ⚠️ 两个容易搞错的点（都照抄 Legado，不要"顺手改合理"）：
   *  ① 分母是 **`total - 1`**，不是 `total`（读完最后一章才是 100%）；
   *  ② **未开始返回 `null`** —— 这是**语义层**的口径（Legado 拿到 null 就 `gone()`）。
   *    本仓 UI（书架卡片的封面进度条）**按用户 2026-09-28 要求**把 `null` 也渲染成
   *    「一条 0% 的空槽」（`.pc-prog` + `i` 宽 0%），所以**不要**因为「空槽没宽度」就删掉那层 DOM。
   *    「有没有在读」与「画不画槽」是两件事：判断是否未开始，请看 `=== null`，别看宽度。
   * `simulatedTotalChapterNum()` 只在本仓不支持的「模拟阅读」模式下与 `totalChapterNum` 不同，
   * 故这里直接用 `totalChapterNum`。
   */
  function readProgressOf(b: ShelfBook): number | null {
    if ((b.lastIdx ?? 0) === 0) return null;
    const total = b.totalChapterNum ?? 0;
    if (total <= 1) return 1;
    return Math.min(1, Math.max(0, (b.lastIdx ?? 0) / (total - 1)));
  }

  /**
   * 未读章节数，**照 Legado `Book.kt:172`**：`max(simulatedTotalChapterNum - durChapterIndex - 1, 0)`。
   * ⇒ `未读 = max(total - lastIdx - 1, 0)`（读完最后一章为 0）。
   * 目录还没加载过（`totalChapterNum` 为空）时返回 `null` ⇒ UI 不显示角标（**不编数字**）。
   */
  function unreadOf(b: ShelfBook): number | null {
    const total = b.totalChapterNum ?? 0;
    if (total <= 0) return null;
    return Math.max(total - (b.lastIdx ?? 0) - 1, 0);
  }

  /** 0~100 进度：「按进度」排序用。视频按 播放秒/总秒；书籍用 Legado 口径的 `readProgressOf` */
  function progressPercentOf(b: ShelfBook): number {
    if (b.durationSec && b.durationSec > 0 && b.progressSec) {
      return Math.min(100, Math.round((100 * b.progressSec) / b.durationSec));
    }
    const p = readProgressOf(b);
    return p === null ? 0 : Math.min(100, Math.round(p * 100));
  }

  /**
   * 目录加载成功 → 记「更新时间」与章节总数（只对**已在书架**的书生效）。
   *
   * 口径与 Legado 一致（不是编的）：`BookChapterList.kt:173` 在（重新）加载目录后
   * `book.latestChapterTime = System.currentTimeMillis()`；章节数对应 `Book.totalChapterNum`。
   */
  function noteTocLoaded(chapterCount: number): void {
    if (!(chapterCount > 0)) return;
    const b = shelf.value.find((x) => x.key === currentKey.value);
    if (!b) return;
    /**
     * `lastCheckCount` 照 Legado `BookChapterList.kt:168-174`：**只在目录变长时**写
     * `list.size - totalChapterNum`（本次发现的新增章节数），随后 `latestChapterTime = now`。
     * 没变长就保持原值（Legado 也没清零 —— 清零发生在「开始阅读」那一步，见 `saveProgress`）。
     */
    if ((b.totalChapterNum ?? 0) < chapterCount) {
      b.lastCheckCount = chapterCount - (b.totalChapterNum ?? 0);
      b.latestChapterTime = Date.now();
    }
    b.totalChapterNum = chapterCount;
    saveShelf();
  }

  function saveProgress(ch: { title: string; payload: unknown }) {
    const b = shelf.value.find((x) => x.key === currentKey.value);
    if (!b) return;
    b.lastChapter = { title: ch.title, payload: ch.payload };
    b.lastIdx = chapterIdx.value;
    b.updatedAt = Date.now();
    // 照 Legado `ReadBook.saveRead()`：保存阅读进度时清零「有更新」高亮
    b.lastCheckCount = 0;
    saveShelf();
    if (b.kind === 'video') {
      recordWatch(b.sourceId, b.payload, b.title, b.cover, ch);
    } else {
      // ★ `#144`：翻章 = 阅读时长结算点（上游 `upReadTime` 就挂在翻章路径 `ReadBook.kt:925`）。
      //   影视不计「阅读时长」（它有观看历史自己的进度通道）。
      readMeter.lap();
    }
  }

  // ---- 阅读时长上报（`#144` 主线收尾）----
  // 语义照抄 `ReadBook.upReadTime()`（ReadBook.kt:616-627）：结算即重启、墙钟、
  // 门控 `AppConfig.enableReadRecord`（契约 `prefs.enableReadRecord`，默认 true）。
  // 可注入实现在 `utils/read-time.ts`（单测 6 条锁住累计/失败攒账/门控/换书）。
  const READTIME_PENDING_KEY = 'yuedu-readtime-pending';
  let readWarnedOffline = false; // warnOnce 留痕（铁律 3：静默兜底是温床）
  const readMeter = createReadTimeMeter({
    now: () => Date.now(),
    getPendingMs: () => Number(localStorage.getItem(READTIME_PENDING_KEY) ?? '0') || 0,
    setPendingMs: (ms) => {
      if (ms > 0) localStorage.setItem(READTIME_PENDING_KEY, String(ms));
      else localStorage.removeItem(READTIME_PENDING_KEY);
    },
    async put(bookName, author, deltaMs) {
      try {
        await putReadTimeRemote({ bookName, author, deltaMs });
        readWarnedOffline = false;
      } catch (e) {
        // 失败已由 meter 攒进 pending（下次结算先冲），这里只留痕——不静默
        if (!readWarnedOffline) {
          readWarnedOffline = true;
          console.warn(`[reader] 阅读时长上报失败（已攒账，恢复后自动补发）：${String((e as Error)?.message ?? e)}`);
        }
      }
    },
    enabled: () => prefs.value.enableReadRecord !== false,
  });
  /** 进入阅读界面（`ReaderOverlay` 挂载时调）。书名/作者取当前书（聚合主键按**书名**，D2） */
  function beginReadSession(): void {
    const d = detail.value;
    readMeter.begin({ bookName: d?.title ?? '', author: d?.author });
  }
  /** 离开阅读界面（`ReaderOverlay` 卸载时调）：结算并停表 */
  function endReadSession(): void {
    readMeter.end();
  }
  // 页面隐藏/恢复：结算暂停，可见且还在阅读则继续（观感对齐上游「离开界面就停」）
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) readMeter.pause();
      else readMeter.resume();
    });
    // 关页前的最后一搏（sendBeacon 级别的尽力而为；失败仍走攒账）
    window.addEventListener('pagehide', () => readMeter.end());
  }

  // ---- 观影历史 ----
  const watchHistory = ref<WatchEntry[]>(JSON.parse(localStorage.getItem(WATCH_KEY) ?? '[]'));
  function saveWatch() {
    localStorage.setItem(WATCH_KEY, JSON.stringify(watchHistory.value));
  }
  /**
   * 影视：**真正起播**时记录（`stores/player.ts#playAt`）；播放章节时更新进度。
   *
   * ⚠️ 不要挪回「详情打开即记录」：那会让用户**显式删除**的历史在下次打开详情时
   * 被无条件重建（删除语义失效，见 `removeWatch` / `clearHistory`）。
   *
   * ★ `#141`：**同时 upsert `shelf` 里的 `notShelf` 行**（D1-B，对齐 Legado
   * `books` + `BookType.notShelf` 位）—— 观影历史因此**自动上服务端**（复用书架的
   * 增量推送，无新端点）。一部剧一行：已有**收藏行**就只刷新时间/集数（收藏行的
   * notShelf 位保持 false，收藏语义不被历史覆盖）；没有才新建 notShelf 行。
   */
  function recordWatch(sid: string, payload: unknown, title: string, cover?: string, ep?: { title: string; payload: unknown }) {
    const key = itemKey(sid, payload);
    let e = watchHistory.value.find((x) => x.key === key);
    if (!e) {
      e = { key, sourceId: sid, payload, title, cover };
      watchHistory.value.unshift(e);
    }
    e.updatedAt = Date.now();
    if (ep) e.lastEpisode = { title: ep.title, payload: ep.payload };
    if (cover) e.cover = cover;
    saveWatch();
    // `#141`：观影历史并入 shelf（notShelf 行）⇒ 随书架增量推上服务端
    const sb = shelf.value.find((x) => shelfKeyOf(x) === key);
    if (sb) {
      sb.updatedAt = Date.now();
      if (ep) sb.lastChapter = { title: ep.title, payload: ep.payload };
      if (cover) sb.cover = sb.cover ?? cover;
      saveShelf();
    } else {
      shelf.value.unshift({
        key, sourceId: sid, payload, title, cover, kind: 'video', notShelf: true,
        lastChapter: ep ? { title: ep.title, payload: ep.payload } : undefined,
        updatedAt: Date.now(),
      });
      saveShelf();
    }
  }
  function removeWatch(e: WatchEntry) {
    watchHistory.value = watchHistory.value.filter((x) => x !== e);
    saveWatch();
    // `#141`：历史行在 shelf 里有对应的 notShelf 行 ⇒ 一并删（服务端也删）。
    // ⚠️ 收藏行（notShelf 为假）**绝不动**——「删除一条历史」不等于「取消收藏」。
    const k = e.key ?? itemKey(e.sourceId, e.payload);
    const before = shelf.value.length;
    shelf.value = shelf.value.filter((x) => !(shelfKeyOf(x) === k && x.notShelf));
    if (shelf.value.length !== before) saveShelf();
  }
  /** 清空观影历史（**保留影视收藏** —— 收藏在 shelf 里，见影视库「清空历史」按钮） */
  function clearHistory() {
    watchHistory.value = [];
    saveWatch();
    // `#141`：notShelf 行是历史的服务端副本 ⇒ 全部删掉（收藏行保留，语义同上）
    const before = shelf.value.length;
    shelf.value = shelf.value.filter((x) => !x.notShelf);
    if (shelf.value.length !== before) saveShelf();
  }
  /**
   * 记录播放进度（秒）。对齐 OmniFlow：`progressSec` / `durationSec` 写入观影历史，
   * 影视库据此画进度条、「继续观看」据此续播。
   *
   * ⚠️ 由播放器**节流**后调用（见 `PlayerOverlay`）：`timeupdate` 每秒触发 4 次，
   * 每次都写 localStorage 会明显卡顿。
   * 同时更新架上的影视条目（收藏卡片也要进度条）。
   */
  function recordProgress(sid: string, payload: unknown, sec: number, dur: number) {
    if (!Number.isFinite(sec) || !Number.isFinite(dur) || dur <= 0) return;
    const key = itemKey(sid, payload);
    const w = watchHistory.value.find((x) => x.key === key);
    if (w) {
      w.progressSec = sec;
      w.durationSec = dur;
      w.updatedAt = Date.now();
      saveWatch();
    }
    let b = shelf.value.find((x) => x.key === key);
    if (!b) {
      // `#141`：不在书架（看过没收藏）⇒ upsert 一条 notShelf 行，进度才会上服务端
      const w = watchHistory.value.find((x) => x.key === key);
      b = {
        key, sourceId: sid, payload,
        title: w?.title ?? '', cover: w?.cover, kind: 'video', notShelf: true,
        progressSec: sec, durationSec: dur, updatedAt: Date.now(),
      };
      shelf.value.unshift(b);
    } else {
      b.progressSec = sec;
      b.durationSec = dur;
    }
    b.updatedAt = Date.now();
    saveShelf();
  }

  // ---- 老数据迁移：早期条目没有 key（当时按书名识别）→ 按新规则补算 ----
  {
    let changed = false;
    for (const b of shelf.value) {
      if (!b.key) {
        b.key = itemKey(b.sourceId ?? '', b.payload);
        changed = true;
      }
    }
    if (changed) saveShelf();
    let wChanged = false;
    for (const w of watchHistory.value) {
      if (!w.key) {
        w.key = itemKey(w.sourceId ?? '', w.payload);
        wChanged = true;
      }
    }
    if (wChanged) saveWatch();
  }

  const watchSorted = computed(() => watchHistory.value.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  const shelfSorted = computed(() => shelf.value.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  const bookShelf = computed(() => shelfSorted.value.filter((b) => b.kind !== 'video'));
  // `#141`：notShelf 行是观影历史（服务端副本），不是收藏 ⇒ 必须排除
  const videoShelf = computed(() => shelfSorted.value.filter((b) => b.kind === 'video' && !b.notShelf));

  type ReaderDetail = NonNullable<typeof detail.value>;

  /** 本次详情是否来自**本地缓存**（UI 用它提示「本地数据 · 点刷新重新拉取」，用户 5-4） */
  const detailFromCache = ref(false);

  /* ---- `#202` 本地书：详情/正文都走服务端本地书通道，**不经过引擎**（本地书没有 sourceId） ---- */

  /**
   * 本地书的详情/目录：目录早就由导入端点**落库**了，这里只是读回来。
   *
   * 为什么必须单独一条口：引擎的 `detail` 要 `sourceId`，而本地书**没有源**；
   * 硬走引擎只会得到「源不存在」。
   */
  async function fetchLocalBookDetail(src: string, payload: unknown, key?: string): Promise<ReaderDetail> {
    const shelfKey = key ?? itemKey(src, payload);
    const book = shelf.value.find((x) => x.key === shelfKey);
    const rows = await listChaptersRemote(encodeItemKey(shelfKey));
    return {
      title: book?.title ?? '',
      ...(book?.author ? { author: book.author } : {}),
      ...(book?.cover ? { cover: book.cover } : {}),
      /**
       * ★ `#212` Step4：`kind` 必须透传 —— 阅读器的 `isComic` / `isPdfChapter` 都读
       *   `detail.kind`。PDF 的书架条目 `kind='image'`（由契约 `bookTypeToKind(type)` 得出），
       *   这里漏掉 ⇒ 正文取回来一堆 `/api/local-books/pdf-page` 地址却没人认得
       *   ⇒ 落进段落分支显示成一串 URL 文本。
       */
      ...(book?.kind ? { kind: book.kind } : {}),
      chapters: rows.map((c) => ({ title: c.title, payload: localChapterId(c.index, shelfKey) })),
    } as ReaderDetail;
  }

  /**
   * 本地书某一章在前端侧的 payload（取正文只用 `index`）。
   *
   * ★ 2026-11-10 修「一次导入两本 PDF，打开任意一本都是同一本的内容」：
   *   正文离线缓存的键是 `chapterKey(sourceId, payload)` = `loc_book|{"index":0}` ——
   *   本地书的 `sourceId` 恒为 `loc_book`，只带 `index` 的 payload 在**所有本地书之间完全相同**
   *   ⇒ 两本书的第 0 章共用同一条缓存 ⇒ 打开 B 命中的是 A 的正文（PDF 更明显：页标记里的
   *   `bookUrl` 也是 A 的，整本章都是 A 的页）。
   *   把书键一并放进 payload（它会参与缓存键序列化）⇒ 每本书的每章键唯一。
   *   取正文只读 `index`（见 `utils/book-fetch.ts`），多带这个字段不影响任何调用方。
   */
  function localChapterId(index: number, bookKey: string): { index: number; book: string } {
    return { index, book: encodeItemKey(bookKey) };
  }

  /**
   * 旧缓存（`books` store 里的详情/目录）是修复前写下的：本地书章节 payload 只有 `{ index }`。
   * 打开时补上书本键，否则**旧缓存里的章节仍会串书**（缓存是本地优先读取的）。
   * 返回是否发生了迁移（调用方据此回写一次）。
   */
  function migrateLocalChapterPayloads(chapters: Array<{ payload: unknown }>, bookKey: string): boolean {
    let changed = false;
    for (const c of chapters) {
      const p = (c.payload ?? {}) as { index?: unknown; book?: unknown };
      if (typeof p.index === 'number' && !p.book) {
        c.payload = localChapterId(p.index, bookKey);
        changed = true;
      }
    }
    return changed;
  }

  /** 详情取数统一口：本地书 → 本地通道；其余 → 引擎 */
  /**
   * `#512` **分阶段取详情**：优先走流式（`info` 先到 ⇒ 详情头部立即渲染，目录随后补齐）；
   * 流式不可用（老服务端 / 流中断 / 需要人工验证）**自动回退**普通 `runAction`，
   * 保留验证浮层重试、toast、截断提示等既有语义。
   */
  async function fetchDetail(
    src: string,
    payload: unknown,
    key?: string,
    onInfo?: (d: ReaderDetail) => void,
  ): Promise<ReaderDetail> {
    if (isLocalBookSource(src)) return fetchLocalBookDetail(src, payload, key);
    const id = JSON.stringify(payload);
    if (onInfo) {
      try {
        return (await runDetailStream(src, id, (d) => onInfo(d as ReaderDetail))) as ReaderDetail;
      } catch {
        /* 回退：走普通请求（语义与旧实现完全一致） */
      }
    }
    return (await runAction(src, 'detail', { id })) as ReaderDetail;
  }

  /**
   * 正文取数统一口（同上）。
   *
   * `#207`：实现已抽到 `utils/book-fetch.ts` —— **下载中心与阅读器必须走同一份**，
   * 否则会出现「阅读读得到、下载下来是空的」这类偏差。这里只负责补上本地书的 `bookUrl`。
   */
  async function fetchContent(
    src: string,
    bookPayload: unknown,
    ch: { title?: string; payload: unknown },
    signal?: AbortSignal,
  ): Promise<{ title?: string; paragraphs?: string[]; html?: string; htmlBaseUrl?: string; uiMarks?: ContentUiMark[]; subContent?: string; imageStyle?: string; imageDecode?: boolean; media?: { url: string; format?: string; alternatives?: string[]; headers?: Record<string, string> } }> {
    return fetchBookContent(
      src, bookPayload, ch,
      {
        ...(isLocalBookSource(src) ? { localBookUrl: encodeItemKey(itemKey(src, bookPayload)) } : {}),
        ...(signal ? { signal } : {}),
      },
    );
  }

  /**
   * 详情/目录：**已在书架的书优先读本地**（用户 5-2/5-4）。
   *
   * 语义（照用户口径）：
   *  · 书架里的书 → 打开时**直接用本地化的详情+目录**（不请求上游）；只有 `force`（点「↻ 刷新详情」/
   *    「↻ 更新目录」）才重新拉取，并把新结果**回写本地**。
   *  · 不在书架的书（从发现页/搜索打开）→ 行为不变，每次都拉（本地化只服务书架，避免展示陈旧目录）。
   *  · 本地读失败/没有 → 回落请求，成功后回写。
   */
  async function loadDetail(it: Record<string, unknown>, opts: { force?: boolean } = {}) {
    // `#674` 换书 ⇒ 在途的读章请求全部作废（否则旧书正文会落到新书界面上）
    chapterSeq++;
    // `#675` 并且**真的中断**它（`#674` 只是不采用结果，请求还在跑、服务端还在抓）
    contentAbort?.abort();
    const payload = (it.payload ?? {}) as unknown;
    const key = itemKey(sourceId.value, payload);
    const inShelf = shelf.value.some((x) => x.key === key);
    detailLoading.value = true;
    try {
      if (!opts.force && inShelf) {
        const local = await getBookMeta<ReaderDetail>(key);
        if (local?.detail?.chapters?.length) {
          detail.value = mergeDetail(detail.value, local.detail);
          detailFromCache.value = true;
          noteTocLoaded(detail.value?.chapters?.length ?? 0);
          return;
        }
      }
      /**
       * `#512` **info 先渲染**：`onInfo` 在目录还在解析时就到（服务端 `ctx.onPartial`）。
       * 此时只更新详情头部（标题/作者/简介/封面），目录为空 ⇒ 章节列表继续显示加载中
       * （`detailLoading` 仍为 true，最后由 finally 复位）。
       */
      const r = await fetchDetail(sourceId.value, payload, undefined, (partial) => {
        detail.value = mergeDetail(detail.value, partial);
      });
      detail.value = mergeDetail(detail.value, r);
      detailFromCache.value = false;
      // 目录到位 → 记「更新时间」与章节总数（只对已在书架的书生效，见 noteTocLoaded）
      noteTocLoaded(detail.value?.chapters?.length ?? 0);
      // **回写本地**：详情+目录本地化（用户 5-2）。写失败不影响本次阅读。
      if (inShelf && detail.value?.chapters?.length) void putBookMeta(key, detail.value);
      // 影视：**不**在详情打开时写观影历史 —— 只有真正起播才记录（`stores/player.ts#playAt`）。
      // 否则「删掉的观影历史」会在用户再打开一次详情时被无条件重建。
    } catch (e) {
      detailErr.value = '详情加载失败：' + String(e instanceof Error ? e.message : e);
    } finally {
      detailLoading.value = false;
      // `#294` 目录到位 ⇒ 同步「上次读到哪」，详情页的目录据此高亮 + 滚到该章
      syncLastReadIdx();
    }
  }

  /**
   * 打开一章。
   *
   * `opts.cache`（默认 `'read'`）：
   *   · `'read'`  → 先查**离线缓存**，命中直接用（断网/离线也能读）；未命中才请求并**不写**缓存；
   *   · `'refresh'` → **绕过缓存**（用户点「↻ 刷新正文」就是想要最新的）；
   *   · `'write'`  → 请求后**写入缓存**（后台批量缓存用，见 `cacheChapters`）。
   * 只有显式点「离线缓存」才会写盘 —— 不在阅读时偷偷攒缓存（对源站不礼貌、也占用户磁盘）。
   */
  /**
   * `#674` **读章代次**（防「正文串了」）。
   *
   * 缺陷形态（用户实测）：先开 63书阁一本（站点慢、content 请求挂 9~60s）→ 关阅读、关详情 →
   * 切到媚色MM 打开卡片 ⇒ 图集/标题混在一起：**书名是新的、章节标题和正文是旧的**。
   * 真因：两次 `openChapter` 并发，旧请求晚到后照样 `chapter.value = …` 覆盖了新的。
   *
   * 服务端那边也会继续重试旧源（日志里 `src:m.63sg.com content 已 9s` 一串），
   * 所以「旧响应永远不来」不能作为前提 —— 前端必须自己丢弃过期结果。
   */
  let chapterSeq = 0;
  /** `#675` 在途取正文的控制器（新开一章/换书时 abort 上一次） */
  let contentAbort: AbortController | null = null;

  /** `#489` 阅读回写的在途去重（同一章连续重开只排一次） */
  const readCacheWrites = new Set<string>();

  /**
   * `#489` **读过即缓存**（对齐上游：正文加载成功后 `BookHelp.saveContent`）。
   *
   * - 只在 `read` 模式、网络取回且正文非空时调用；缓存命中路径无需重写。
   * - 用 `requestIdleCallback` 把写盘排到渲染/翻页之后，正文展示不被 IndexedDB 序列化拖住；
   *   不支持时退化为 `setTimeout(0)`。失败静默（缓存尽力而为）。
   * - 写盘成功后 `putCachedChapter` 会发 `chapter-cache` 事件 ⇒ 开着的目录实时消云朵。
   * - 这些章**不登记**到预缓存窗口（`windowKeys`）⇒ 窗口滑动只删窗口自己补的章，读过的章保留。
   */
  function scheduleReadCacheWrite(
    sid: string,
    payload: unknown,
    data: Parameters<typeof putCachedChapter>[2],
  ): void {
    const k = chapterKey(sid, payload);
    if (readCacheWrites.has(k)) return;
    readCacheWrites.add(k);
    const run = (): void => {
      void putCachedChapter(sid, payload, data).finally(() => readCacheWrites.delete(k));
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 0);
  }

  async function openChapter(ch: { title: string; payload: unknown }, opts: { cache?: 'read' | 'refresh' | 'write' } = {}) {
    const seq = ++chapterSeq;
    /**
     * `#675` **切走即中断**：先 abort 上一章的在途请求，再开新的。
     * 顺序必须是「先 ++seq 再 abort」—— 被 abort 的那次会在 catch 里看到 `stale()` 为真而直接 return，
     * 不会把 AbortError 当成「正文加载失败」显示给用户。
     */
    contentAbort?.abort();
    const ac = new AbortController();
    contentAbort = ac;
    /** 本次调用是否已被更新的调用取代（取代后一律不写任何状态） */
    const stale = (): boolean => seq !== chapterSeq;
    const chs = detail.value?.chapters ?? [];
    chapterIdx.value = chs.findIndex((c) => c.payload === ch.payload || JSON.stringify(c.payload) === JSON.stringify(ch.payload));
    // `#260`：「起效的替换规则」是**每章**的结论 ⇒ 换章先清空，
    // 否则抓取失败（`purify()` 没跑到）时会留着上一章的结论，界面显示成「这些规则在起效」。
    effectiveReplaceIds.value = [];
    const mode = opts.cache ?? 'read';
    if (mode === 'read') {
      // `#669` 先看内存预载（同步命中 ⇒ 切章无等待），未命中再读 IndexedDB
      const memKey = chapterKey(sourceId.value, ch.payload);
      const hit = preloadBuf.get(memKey) ?? (await getCachedChapter(sourceId.value, ch.payload));
      if (stale()) return; // `#674` 期间用户已切到别的章/书 ⇒ 这次结果作废
      /**
       * `#583` **旧缓存自愈**：`uiMarks` 是 10-23 才加的字段，之前写入的章节没有它。
       * 若照旧直接命中 ⇒ 「目录点进去的第一章有本章说，切到第二章就没了」（用户实测）。
       * 判据：**只有字段存在**（哪怕是空数组）才算「这份缓存知道按钮的事」；
       * 缺字段 ⇒ 当作未命中，走网络重拉；该章之后由预缓存 / 显式缓存回写（`read` 模式本身不写盘）。
       */
      /**
       * `#670` **命中也要看有没有正文**：旧版本把空正文也落了盘（用户第 3 章就是这么坏的），
       * 这里把「三样全无」的缓存当未命中 ⇒ 直接走网络，下一次成功后就覆盖掉那条坏缓存。
       */
      const hitHasContent = !!hit && !!(hit.paragraphs?.length || hit.html || hit.media?.url);
      /**
       * `#744` **旧缓存自愈**：`#744` 之前引擎在「图片源」分支会把图片 URL 的 `,{…}` 选项尾巴
       * （里面就有 `Host`）整个丢掉 ⇒ 旧缓存里的漫画段落是**裸 `http(s)://<IP>/…`**；
       * 阅读器 `imgSrc` 拿不到 `Host` ⇒ `/api/proxy` 按 `Host: <IP>` 建连 ⇒ CF
       * `403 error code: 1003`，图永远裂（且缓存命中路径不会自己好）。
       * 判据只认「IP 字面量 URL 且**没有** `,{`」这一种形态：普通站点图片（域名）与
       * 文本段落都不受影响，宁可多拉一次也不要把用户的离线正文清掉。
       */
      const staleImgTail = (hit?.paragraphs ?? []).some(
        (p) => /^https?:\/\/(?:\d{1,3}\.){3}\d{1,3}\//.test(p) && !p.includes(',{'),
      );
      if (hit && hit.uiMarks !== undefined && hitHasContent && !staleImgTail) {
        /**
         * `#144`：缓存里存的是**原文**（净化只在展示时做，见 `utils/replace-rules.ts` 文件头）
         * ⇒ **读缓存这条路径也必须过一遍净化**，否则会变成「第一次读净化了、再读就没有」——
         * 一个不报错、但用户一定会当成 bug 的现象。
         */
        const p = purify(hit.title ?? ch.title, hit.paragraphs ?? []);
        chapter.value = {
          title: p.title, paragraphs: p.paragraphs,
          html: hit.html, htmlBaseUrl: hit.htmlBaseUrl, // `#308` 缓存的 HTML 正文（订阅源/组装型）
          uiMarks: hit.uiMarks, // `#583` 源按钮（缓存命中也要保留）
          subContent: hit.subContent,
          imageStyle: hit.imageStyle, imageDecode: hit.imageDecode, media: hit.media,
        };
        // `#308`：有 html 也算有正文 —— 否则订阅源/播放器章节会被盖上「正文为空」
        detailErr.value = !hit.paragraphs?.length && !hit.html && !hit.media?.url ? '正文为空' : '';
        contentLoading.value = false;
        saveProgress(ch);
        /**
         * `#669` **缓存命中也要推进预缓存窗口**。
         *
         * 缺陷形态（用户实测 138阅读网）：开读时缓存了「后 3 章」；接着读的 2~4 章**都命中缓存**
         * 直接 return ⇒ 从不触发 `schedulePrefetch()` ⇒ 窗口一直停在最初的 2/3/4；
         * 翻到第 5 章才走网络（卡 1~2s），取回后才又补 6/7/8 ——
         * 用户看到的就是「读一章、再缓存三章」的突发式，而不是「读一章补一章」的递进。
         *
         * 这里补一次（内部 800ms 防抖，命中路径连翻也不会打爆源站）。
         */
        schedulePrefetch();
        return;
      }
    }
    contentLoading.value = true;
    detailErr.value = '';
    /**
     * `#667` **失败自动重试一次 + 明确提示**（用户实测：键盘翻下一章时章没加载，界面静默停在上一章，
     * 看起来像快捷键没反应，实际是那一章请求失败）。
     *
     * 为什么值得重试：这类失败多来自「站点瞬时限流 / 挑战页正好在过闸」——服务端 `#664`/`#665`/`#666`
     * 已把大部分收拾掉，剩下的一次抖动重试往往就过了；重试仍失败才把错误交给 `detailErr`（可见提示）。
     * 只对**抛错**重试（`正文为空` 属于内容结论，不该重试）。
     */
    try {
      let r: Awaited<ReturnType<typeof fetchContent>> | null = null;
      let firstErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          r = await fetchContent(sourceId.value, it0.value?.payload, ch, ac.signal);
          break;
        } catch (e) {
          firstErr = e;
          if (attempt === 0) {
            // 给服务端一点喘息（也避开「同一 URL 冷却」的边界），再试一次
            await new Promise((res) => setTimeout(res, 700));
          }
        }
        /**
         * `#674` 每次 await 之后都要判代次：用户可能在这一秒里切了书/章
         * （切走后还继续重试一次 = 白打源站一次请求）。
         */
        if (stale()) return;
      }
      if (stale()) return;
      if (!r) throw firstErr ?? new Error('正文加载失败');
      // 引擎的 ContentRule.title 会修正章节名（有些站点标题只能在正文页取到）
      const p = purify(r.title ?? ch.title, r.paragraphs ?? []);
      chapter.value = {
        title: p.title, paragraphs: p.paragraphs,
        html: r.html, htmlBaseUrl: r.htmlBaseUrl, // `#308` HTML 正文（订阅源 / 组装型）
        uiMarks: r.uiMarks, // `#583` 源按钮（段评 / 本章说 / 神评 / 书评）
        subContent: r.subContent, imageStyle: r.imageStyle, imageDecode: r.imageDecode, media: r.media,
      };
      /**
       * `#670` **空正文绝不写缓存**（否则会「毒化」：以后每点这一章都命中空缓存、显示「正文为空」，
       * 而且早先「刷新正文」还绕不过缓存 ⇒ 永远自愈不了）。
       * 判据与 `正文为空` 一致：paragraphs / html / media 三样全无 ⇒ 不写。
       */
      const hasContent = !!(r.paragraphs?.length || r.html || r.media?.url);
      directRead.value = false; // `#344` 首章到位 ⇒ 退出「直达阅读」过渡态（浮层已切正文）
      /**
       * 「正文为空」只在**真的什么都没有**时报。
       *
       * ⚠️ 媒体类章节（视频/m3u8/文件）`paragraphs` **本来就是空的** —— 内容在 `media` 里。
       * 旧判断只看 paragraphs ⇒ 播放器上方永远挂一条「正文为空」，
       * 看着像出错（用户实测 🎬🔞麻豆传媒AI 打开后就是这个观感）。
       */
      if (!r.paragraphs?.length && !r.html && !r.media?.url) {
        detailErr.value = '正文为空';
      } else {
        detailErr.value = '';
        saveProgress(ch);
      }
      /**
       * `#489` **读过即缓存**：`read` 模式网络取回成功后异步回写（对齐上游 `WebBook` 的
       * `BookHelp.saveContent`）。放空闲帧、不 await ⇒ 正文先上屏，写盘不拖滚动/翻页；
       * 写成功由 `putCachedChapter` 发事件，目录开着时立即消掉这一章的云朵。
       */
      if (mode === 'read' && hasContent) {
        scheduleReadCacheWrite(sourceId.value, ch.payload, {
          ...(r.title ? { title: r.title } : {}),
          paragraphs: r.paragraphs ?? [],
          ...(r.html ? { html: r.html } : {}),
          ...(r.htmlBaseUrl ? { htmlBaseUrl: r.htmlBaseUrl } : {}),
          uiMarks: r.uiMarks ?? [],
          ...(r.subContent ? { subContent: r.subContent } : {}),
          ...(r.imageStyle ? { imageStyle: r.imageStyle } : {}),
          ...(r.imageDecode !== undefined ? { imageDecode: r.imageDecode } : {}),
          ...(r.media ? { media: r.media } : {}),
        });
      }
      /**
       * `#670` **刷新成功要回写缓存**：用户点「刷新正文」的动机就是「这一章坏了」，
       * 不写回的话，下次再点这一章又会命中那条坏缓存（或每次都重新拉）。
       * 只在有正文时写（与 ② 同判据）。
       */
      if (mode === 'refresh' && hasContent) {
        try {
          await putCachedChapter(sourceId.value, ch.payload, {
            ...(r.title ? { title: r.title } : {}),
            paragraphs: r.paragraphs ?? [],
            ...(r.html ? { html: r.html } : {}),
            ...(r.htmlBaseUrl ? { htmlBaseUrl: r.htmlBaseUrl } : {}),
            uiMarks: r.uiMarks ?? [],
            ...(r.subContent ? { subContent: r.subContent } : {}),
            ...(r.imageStyle ? { imageStyle: r.imageStyle } : {}),
            ...(r.imageDecode !== undefined ? { imageDecode: r.imageDecode } : {}),
            ...(r.media ? { media: r.media } : {}),
          });
        } catch {
          /* 写盘失败不影响本次展示 */
        }
      }
      // 5-5：真实抓过一章后维护预缓存窗口（只对书架内书籍生效 + 防抖 800ms）
      schedulePrefetch();
      if (mode === 'write' && hasContent) {
        await putCachedChapter(sourceId.value, ch.payload, {
          ...(r.title ? { title: r.title } : {}),
          paragraphs: r.paragraphs ?? [],
          // `#308`：HTML 正文一并落缓存（离线再读也能出播放器/图集）
          ...(r.html ? { html: r.html } : {}),
          ...(r.htmlBaseUrl ? { htmlBaseUrl: r.htmlBaseUrl } : {}),
          // `#583` **必须写**（空数组也算已知）——旧缓存自愈靠这个字段是否存在
          uiMarks: r.uiMarks ?? [],
          ...(r.subContent ? { subContent: r.subContent } : {}),
          ...(r.imageStyle ? { imageStyle: r.imageStyle } : {}),
          ...(r.imageDecode !== undefined ? { imageDecode: r.imageDecode } : {}),
          ...(r.media ? { media: r.media } : {}),
        });
      }
    } catch (e) {
      // `#674` 过期请求的失败不该污染当前章（否则新的正文正常、却挂着旧书的报错）
      if (stale()) return;
      /**
       * `#667` 提示里写明「已自动重试」——否则用户只会看到一句技术错误，
       * 误以为「快捷键坏了 / 卡在上一章」。
       */
      detailErr.value = '正文加载失败（已自动重试一次）：' + String(e instanceof Error ? e.message : e);
    } finally {
      // `#674` 只有「最新那次」才有资格结束 loading（否则旧请求一结束就把转圈关掉，新章还在路上）
      if (!stale()) contentLoading.value = false;
    }
  }

  /**
   * `#712` 书籍 HTML 正文的「阅读模式文本化」（**显示层**，不写缓存）。
   *
   * 与简繁转换同族：只在内存里改写 `chapter.paragraphs`，缓存仍存引擎给的原文
   * （写入点在 `openChapter` 的 `putCachedChapter`，用的是网络结果 `r`，不读本函数结果）。
   *
   * - 传段落 ⇒ 置 `readerModeText`，`html` **保留**（站点定制弹窗要看原始 HTML，
   *   关掉阅读模式也要能恢复 iframe）；
   * - 传 `null` ⇒ 还原成应用前的原始段落（用户关掉该站点的阅读模式时）。
   *
   * ⚠️ 只对「本来就有 `html` 的章」生效 —— 纯文本章没有可抽的东西，也不该被改写。
   * ⚠️ 抽取结果与引擎给的 `uiMarks.para` 下标体系不一致 ⇒ 调用方不得再渲染 `uiMarks`
   * （`ReaderOverlay` 的 `uiMarksAt` 已按本标记短路）。
   *
   * `#726` 三条约束：
   *  ① 入参是**未净化**的抽取原文，这里统一走 `purifyReaderModeParagraphs()`（否则全局替换规则失效）；
   *  ② `readerModeRawParagraphs` 只存**关掉时要还原的引擎段落**，绝不存抽取/净化结果
   *     ⇒ 还原拿到的是原文，再次应用也不会「净化两次」；
   *  ③ 改写 `chapter` 后清掉 `convertedChapter`：简繁转换的重算是异步的，不清掉会让
   *     旧段落的转换结果在新正文之前显示一帧（`displayParagraphs` 优先读转换缓存）。
   */
  function applyReaderModeText(paragraphs: string[] | null): void {
    const ch = chapter.value;
    if (!ch?.html) return;
    if (paragraphs?.length) {
      const purified = purifyReaderModeParagraphs(paragraphs);
      const cur = ch.paragraphs ?? [];
      // 相同内容不重复赋值（watcher 每次重算都会走到这里，避免无谓的渲染风暴）
      if (ch.readerModeText && cur.length === purified.length && cur.every((x, i) => x === purified[i])) return;
      chapter.value = {
        ...ch,
        paragraphs: purified,
        readerModeText: true,
        // 首次应用时备份原始段落；后续切换不能覆盖备份（否则还原会丢原文）
        readerModeRawParagraphs: ch.readerModeRawParagraphs ?? cur,
      };
      convertedChapter.value = null;
      return;
    }
    if (!ch.readerModeText) return;
    chapter.value = {
      ...ch,
      paragraphs: ch.readerModeRawParagraphs ?? [],
      readerModeText: false,
    };
    convertedChapter.value = null;
  }

  /**
   * `#726` 净化规则的书/全局上下文 —— `purify()` 与 `purifyReaderModeParagraphs()` 的**唯一构造点**。
   *
   * 两处各拼一份 `book`（含手动规则集、本书开关、`isImage`）就是漂移的开始，所以抽出来。
   */
  function replaceContext(title: string, ci = chapterIdx.value): {
    book: {
      name: string; origin: string; useReplaceRule: boolean | null; isImage: boolean;
      manualRuleIds: number[] | null; manualMode: boolean;
    };
    g: boolean;
    jsCtx: {
      chapter: { title: string; index: number; isVolume: boolean; isVip: boolean; isPay: boolean; tag: string };
      book: { name: string; origin: string; author: string; kind: string; intro: string; coverUrl: string };
    };
  } {
    const book = {
      name: detail.value?.title ?? '',
      origin: sourceId.value,
      useReplaceRule: currentBookUseReplaceRule.value,
      isImage: detail.value?.kind === 'image',
      // `#261` 手动规则集：本书勾选的 ids + 全局开关（非空即接管 ⇒ 全局规则一条不跑）
      manualRuleIds: currentBookManualRuleIds.value,
      manualMode: prefs.value.manualReplaceRuleEnabled,
    };
    const g = prefs.value.replaceEnableDefault;
    /**
     * `#257`：`@js:` 脚本的 `chapter` / `book` 绑定。
     *
     * ⚠️ **这是「最小对象」，不是字段对齐** —— 只填本仓**确实拿得到**的字段，
     * 键名尽量与上游一致（`BookChapter` / `ReplaceBook`）。上游传的是完整实体；
     * 本仓不给的键读出来是 `undefined`（脚本会抛错 ⇒ 该规则被跳过并留痕，**不会静默出错**）。
     * 实测用户库 21 条 `@js:` 规则**没有一条**读 `chapter` / `book`，故先做到这一步。
     */
    const rec = ci >= 0 ? detail.value?.chapters?.[ci] : undefined;
    const jsCtx = {
      chapter: {
        title: rec?.title ?? chapter.value?.title ?? title,
        index: ci,
        isVolume: rec?.isVolume ?? false,
        isVip: rec?.isVip ?? false,
        isPay: rec?.isPay ?? false,
        tag: rec?.tag ?? '',
      },
      book: {
        name: book.name,
        origin: book.origin,
        author: detail.value?.author ?? '',
        kind: detail.value?.kind ?? '',
        intro: detail.value?.intro ?? '',
        coverUrl: detail.value?.cover ?? '',
      },
    };
    return { book, g, jsCtx };
  }

  /**
   * `#726` 把净化规则应用到**阅读模式抽取出的段落**（`applyReaderModeText` 的唯一入口）。
   *
   * 为什么必须走这里：`openChapter` 的 `purify()` 处理的是**引擎给的** `r.paragraphs`；
   * 书籍 HTML 章文本化后 `paragraphs` 被抽取结果整体替换 ⇒ 不重新净化就会「全局替换/净化规则失效」
   * （且 `#712` 的 `readerModeRawParagraphs` 备份的是**引擎段落**，不能把净化结果写进去，
   * 否则关闭还原时拿到的是净化文本）。
   */
  function purifyReaderModeParagraphs(paragraphs: string[]): string[] {
    const { book, g, jsCtx } = replaceContext(chapter.value?.title ?? '');
    const c = replaceRules.applyContent(paragraphs, book, g, jsCtx);
    // 「起效的替换规则」列表的数据源（上游 `TextChapter.effectiveReplaceRules`）：只收正文。
    effectiveReplaceIds.value = c.used;
    return c.paragraphs;
  }

  /**
   * **`#144` 用户全局净化规则的应用入口（唯一）**。
   *
   * ⚠️ 只在**展示时**用，写缓存时**必须用原文**（`putCachedChapter` 那里直接写 `r.paragraphs`）：
   * 上游 `BookHelp` 存的也是原文、`ContentProcessor` 在展示时处理 ——
   * 反过来做的话，用户关掉规则后缓存里仍是净化过的正文，而且**没有任何提示**。
   *
   * ⚠️ 本书级开关（`BookReadConfig.useReplaceRule`）**`#260` 起已接上** ——
   * 值来自 `ShelfBook.useReplaceRule`（`null` = 跟随全局），判据走 `useReplaceRuleFor()`。
   */
  function purify(title: string, paragraphs: string[]): { title: string; paragraphs: string[] } {
    const { book, g, jsCtx } = replaceContext(title);
    const t = replaceRules.applyTitle(title, book, g, jsCtx);
    const c = replaceRules.applyContent(paragraphs, book, g, jsCtx);
    // 「起效的替换规则」列表的数据源（上游 `TextChapter.effectiveReplaceRules`）：只收正文。
    effectiveReplaceIds.value = c.used;
    return { title: t.title, paragraphs: c.paragraphs };
  }

  /**
   * **抓正文并写缓存**，但**不碰任何阅读状态**（不动 `chapter` / `chapterIdx`）。
   *
   * ⚠️ 为什么必须与 `openChapter` 分开：`openChapter` 会把结果写进 `chapter.value` 并重设
   * `chapterIdx` —— 后台批量缓存/预缓存若复用它，**界面会被"劫持"**：用户正在读第 5 章，
   * 后台缓到第 25 章时正文就跳成第 25 章了。这个坑原先就存在于「⬇ 离线缓存」的批量路径里
   * （`cacheChapters` 调的是 `openChapter`），5-5 的自动预缓存会让它必现，所以这里拆开。
   */
  /**
   * `#669` **内存预载缓冲**（切章不再等 IndexedDB / 网络）。
   *
   * 用户实测「切章有一瞬卡顿」：命中磁盘缓存时仍要 `getCachedChapter`（IndexedDB 异步读）
   * + 反序列化 + `purify`。预缓存窗口本来就已经把**后面几章的正文**取回来了，
   * 顺手留一份在内存里，切到下一章时**同步就能渲染**。
   *
   * 容量 8：只覆盖「往后翻几章」的常见操作；旧的自然淘汰（FIFO），内存占用与一章正文同级。
   */
  const PRELOAD_MAX = 8;
  const preloadBuf = new Map<string, Awaited<ReturnType<typeof getCachedChapter>>>();

  /**
   * 预抓一章并落盘。
   *
   * `ctx` 由窗口调用方**捕获当时**的 `sourceId` / 书 payload / 书键传入 —— 抓取是异步的，
   * 期间用户可能切书；若继续读 `sourceId.value`，旧书正文会被写进新书的键空间
   * （`sourceId|payload` 前缀变了 ⇒ 新书目录凭空多出缓存、旧书反倒没有）。
   * `stale()` 为真时连内存缓冲都不写，返回前直接丢弃这次结果。
   */
  async function fetchAndCacheChapter(
    ch: { title: string; payload: unknown },
    ctx?: { sid: string; bookPayload: unknown; stale?: () => boolean },
  ): Promise<void> {
    const sid = ctx?.sid ?? sourceId.value;
    const bookPayload = ctx?.bookPayload ?? it0.value?.payload;
    const r = await fetchContent(sid, bookPayload, ch);
    if (ctx?.stale?.()) return;
    // `#669` 顺手进内存缓冲（切章同步可读）
    try {
      const k = chapterKey(sid, ch.payload);
      preloadBuf.set(k, {
        title: r.title ?? ch.title,
        paragraphs: r.paragraphs ?? [],
        ...(r.html ? { html: r.html } : {}),
        ...(r.htmlBaseUrl ? { htmlBaseUrl: r.htmlBaseUrl } : {}),
        uiMarks: r.uiMarks ?? [],
        ...(r.subContent ? { subContent: r.subContent } : {}),
        ...(r.imageStyle ? { imageStyle: r.imageStyle } : {}),
        ...(r.media ? { media: r.media } : {}),
        at: Date.now(),
      } as never);
      while (preloadBuf.size > PRELOAD_MAX) {
        const first = preloadBuf.keys().next().value;
        if (first === undefined) break;
        preloadBuf.delete(first);
      }
    } catch {
      /* 缓冲失败不影响写盘 */
    }
    /**
     * `#670` 预抓取同理：**空正文不落盘**（用户第 3 章就是被预缓存写坏的）。
     * 不写 ⇒ 下一轮窗口还会再试；写了 ⇒ 永远命中空缓存、再也不会重试。
     */
    if (!(r.paragraphs?.length || r.html || r.media?.url)) return;
    if (ctx?.stale?.()) return;
    await putCachedChapter(sid, ch.payload, {
      ...(r.title ? { title: r.title } : {}),
      paragraphs: r.paragraphs ?? [],
      // `#308`：HTML 正文同 `openChapter`，一并落缓存
      ...(r.html ? { html: r.html } : {}),
      ...(r.htmlBaseUrl ? { htmlBaseUrl: r.htmlBaseUrl } : {}),
      // `#583` **必须写**（空数组也算已知）：否则预缓存的章节缺字段 ⇒ 切章后评论按钮消失
      uiMarks: r.uiMarks ?? [],
      ...(r.subContent ? { subContent: r.subContent } : {}),
      ...(r.imageStyle ? { imageStyle: r.imageStyle } : {}),
      ...(r.imageDecode !== undefined ? { imageDecode: r.imageDecode } : {}),
      ...(r.media ? { media: r.media } : {}),
    });
  }

  /* ============================ 5-5 正文预缓存窗口 ============================ */

  const PRECACHE_KEY = 'yuedu-precache-count';
  const PRECACHE_DEFAULT = 20;
  /**
   * `#489` **未进书架、只是点开阅读的书**的预缓存窗口（章）。
   * 用户口径：「方便阅读」——顺着读下去时后面几章已经在了，不必每次现抓；
   * 但既然没进书架，就不该按书架那 20 章占空间。取 **3** 章（当前章之后）。
   */
  const PRECACHE_GUEST = 3;
  const clampPrecache = (n: number): number =>
    (Number.isFinite(n) ? Math.max(0, Math.min(200, Math.floor(n))) : PRECACHE_DEFAULT);

  /**
   * 预缓存窗口大小（章）。**0 = 关闭**；默认 **20**（用户 5-5 明确要求）。
   * 入口在「设置 → 阅读设置」。语义：保持「当前章之后的 N 章未读正文」在本地，随阅读进度向后滑动。
   */
  const precacheCount = ref<number>(clampPrecache(Number(localStorage.getItem(PRECACHE_KEY) ?? PRECACHE_DEFAULT)));
  function setPrecacheCount(n: number): void {
    precacheCount.value = clampPrecache(n);
    localStorage.setItem(PRECACHE_KEY, String(precacheCount.value));
  }

  /** 每本书「预缓存窗口」当前持有的章节键：内存 + 落盘（窗口滑动时据此**精确**删除掉出窗口的） */
  const windowKeys = new Map<string, string[]>();
  let precacheSeq = 0;
  /** 预缓存进度（给 UI 显示「后台缓存中 x/y」，可与用户手动缓存并存） */
  const precacheState = ref<{ running: boolean; bookKey: string; done: number; total: number }>(
    { running: false, bookKey: '', done: 0, total: 0 },
  );
  let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 维护正文预取窗口：**当前章前 2 章 + 之后 N 章**（书架 N=20 / 非书架固定 3）。
   *
   * 用户口径（5-5）：*默认保持 20 章未读章节正文缓存，随阅读进度继续向后缓存*；
   * 2026-11-09 对齐上游后补两处：回跳方向也预取 2 章、**不再自动删除**任何预取章。
   *
   * 每次滑动只做一件事：**补** —— 窗口内还没缓存的章逐个抓（`hasCachedChapter` 先跳过，省流量），
   * 并发 2，够快也不打源站。删除已取消（上游从不删预取章），磁盘只增不减，见函数内说明。
   */
  async function prefetchWindow(): Promise<void> {
    const chs = detail.value?.chapters ?? [];
    if (!chs.length || chapterIdx.value < 0) return;
    const key = currentKey.value;
    if (!key) return;
    // 用户在设置里关掉了预缓存（0）⇒ 书架书与非书架书都不再后台抓
    if (precacheCount.value <= 0) return;
    /**
     * `#489` **换书代次**：把「窗口计算时」的书源 / 书 payload / 书键捕获下来，
     * 抓回来的正文只有仍属于同一本书时才允许写盘。
     *
     * 不做这件事的后果：预取是异步的，用户在抓取途中切书 ⇒ 旧书正文被写进新书的键空间
     * （`sourceId|payload` 前缀都变了）：新书目录凭空多出「已缓存」，旧书反倒丢掉刚抓到的章。
     * `precacheSeq` 每次维护窗口都递增（作废上一轮 worker），`currentKey` 变化同样视为过期。
     */
    const sid = sourceId.value;
    const bookPayload = it0.value?.payload;
    const my = ++precacheSeq;
    /**
     * 只按**书身份**判过期：同一本书里新一轮窗口把上一轮 worker 停掉（`precacheSeq`）是正常的，
     * 但上一轮**已经抓到手**的正文仍然有效，不该白白丢掉再重拉一次（那会白打源站）。
     */
    const stale = (): boolean => currentKey.value !== key || sourceId.value !== sid;
    /**
     * `#489` 书架里的书按用户设置的窗口（默认 20）；**没进书架、只是点开阅读的**按
     * `PRECACHE_GUEST`（3 章）小窗口跟随。判据复用 `hasInShelf`（**同一判据只写一处**，
     * 它还负责排除 `notShelf` 的观影历史行）。
     */
    const inShelf = hasInShelf(key);
    const n = inShelf ? precacheCount.value : PRECACHE_GUEST;

    const cur = chapterIdx.value;
    /** 前向窗口：当前章之后 N 章（书架 20 / 非书架 3，参数不动） */
    const forward = chs
      .slice(cur + 1, cur + 1 + n)
      .filter((c) => !c.isVolume)
      .map((c) => ({ ch: c, k: chapterKey(sid, c.payload) }));
    /**
     * `#489` **向后预取**（对齐上游 `dur-2 .. dur-min(5,N)`）：往回翻也应该是热的。
     * 上游窗口本来就含当前章前 2 章；本仓前向 20 章是用户 5-5 定的、不动，只额外补这 2 章。
     * 命中已缓存时 `hasCachedChapter` 会跳过 ⇒ 正常顺序阅读不会因此多打源站请求。
     */
    const BACK_N = 2;
    const backward = chs
      .slice(Math.max(0, cur - BACK_N), cur)
      .filter((c) => !c.isVolume)
      .map((c) => ({ ch: c, k: chapterKey(sid, c.payload) }));
    const win = [...backward, ...forward];

    /**
     * `#489` **不删预取章**（对齐上游：上游从不删预取缓存）。
     *
     * 旧口径会把「回跳后落在窗口外且未读」的章删掉（`#516` 后是刻意取舍：用离线命中率换磁盘）。
     * 现在只维护窗口清单（供「清理本书缓存」用），**不做任何自动删除**。
     *
     * ⚠️ 磁盘影响：正文缓存只增不减 —— 读过的、预取过的章都会留在盘上，
     * 直到用户手动「清理本书缓存」或在「设置 → 缓存治理」清理正文。不做 LRU / TTL / 配额强删。
     */
    windowKeys.set(key, win.map((x) => x.k));
    void setPrecacheKeys(key, win.map((x) => x.k));

    const todo: typeof win = [];
    for (const w of win) {
      if (!(await hasCachedChapter(w.k))) todo.push(w);
    }
    if (!todo.length) {
      // 本轮作废了上一轮（`precacheSeq` 已递增）却没有要抓的章 ⇒ 由这里收尾，
      // 否则上一轮的 `finally` 因代次不符不再复位，设置页会永远停在「后台缓存中」。
      if (precacheState.value.running) {
        precacheState.value = { running: false, bookKey: key, done: 0, total: 0 };
      }
      return;
    }

    precacheState.value = { running: true, bookKey: key, done: 0, total: todo.length };
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (my !== precacheSeq) return;
        const i = next++;
        const t = todo[i];
        if (!t) return;
        try {
          await fetchAndCacheChapter(t.ch, { sid, bookPayload, stale });
        } catch {
          /* 单章失败不影响其它（源站抖动/章节需要登录等）——不静默改全局状态 */
        }
        if (my === precacheSeq) precacheState.value.done += 1;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(2, todo.length) }, worker));
    } finally {
      if (my === precacheSeq) precacheState.value.running = false;
    }
  }

  /** 防抖触发（翻章很频繁，别每章都立刻跑一轮） */
  function schedulePrefetch(): void {
    if (precacheCount.value <= 0) return;
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null;
      void prefetchWindow();
    }, 800);
  }


  /** `#207`：批量缓存的实现已迁到 `stores/downloads.ts`（**整本下载中心**）——
   *  阅读器的「⬇ 缓存」与书架的「⬇ 下载整本」现在是同一个任务，进度在下载管理里可见。
   *  这里**不再有第二份 `cacheChapters`**：两份实现必然漂移（本仓已因这个返工过）。 */

  /* ---------------- `#833` 无限滚动：相邻章正文（**不切换当前章**） ---------------- */

  /** 给无限滚动拼接用的相邻章（已净化、纯文本；HTML/媒体章走「打开本章」而不是拼接） */
  type NeighborChapter = {
    idx: number;
    title: string;
    paragraphs: string[];
    subContent: string;
    /**
     * 用户 2026-11-10：源按钮 / **本章说**（`uiMarks`，`para = -1` 是章末条）。
     * 拼接段必须带上它：否则交接后旧章变成拼接段时那条「本章说」会从 DOM 里消失，
     * 往回滚又交接回来才重新出现（用户实测的「本章说闪没 / 正文抖一下」）。
     */
    uiMarks: ContentUiMark[];
  };

  /**
   * 相邻章正文的**单飞**表（键 = 书源 + 章 payload）。
   *
   * ★ 快速来回滚动会在同一帧附近反复触发哨兵 ⇒ 同一章必须只发一次请求；
   *   失败时删除条目，下一次触发才会重新尝试（而不是永久卡在「加载中」）。
   */
  const neighborJobs = new Map<string, Promise<NeighborChapter>>();

  /**
   * `#833` 取**相邻章**正文（不碰 `chapter` / `chapterIdx` / `contentLoading`）。
   *
   * 与 `openChapter` 分开的理由和 `fetchAndCacheChapter` 相同：无限滚动是**预取**，
   * 若复用 `openChapter`，用户在章末刚滚一下就会把正文切走（目录高亮、页眉、进度全跳）。
   *
   * 顺序：内存预载 → IndexedDB 缓存（`uiMarks` 字段存在才算命中，同 `openChapter` 的旧缓存自愈）
   * → 网络（失败重试一次，与 `openChapter` 的 700ms 退避一致）。
   *
   * 净化**不写 `effectiveReplaceIds`**：那是「当前章起效规则」的展示数据源，
   * 预取邻章不该改写用户正在看的这一章的结论。
   */
  async function loadNeighborChapter(idx: number): Promise<NeighborChapter> {
    const chs = detail.value?.chapters ?? [];
    const ch = chs[idx];
    if (!ch || ch.isVolume) throw new Error('没有可读的相邻章节');
    const key = chapterKey(sourceId.value, ch.payload);
    const pending = neighborJobs.get(key);
    if (pending) return pending;
    const job = (async (): Promise<NeighborChapter> => {
      const usable = (x: unknown): boolean => {
        const o = x as { paragraphs?: string[]; html?: string; media?: { url?: string } } | null;
        return !!o && !!(o.paragraphs?.length || o.html || o.media?.url);
      };
      let raw = preloadBuf.get(key);
      if (!usable(raw)) {
        try {
          const hit = await getCachedChapter(sourceId.value, ch.payload);
          // `uiMarks` 缺字段 = 旧版本缓存（与 `openChapter` 的判据同一口径）
          if (usable(hit) && hit!.uiMarks !== undefined) raw = hit ?? undefined;
        } catch {
          /* 缓存读失败 ⇒ 走网络 */
        }
      }
      if (!usable(raw)) {
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await fetchAndCacheChapter(ch);
            raw = preloadBuf.get(key);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (attempt === 0) await new Promise((res) => setTimeout(res, 700));
          }
        }
        if (lastErr) throw new Error(String(lastErr instanceof Error ? lastErr.message : lastErr));
      }
      if (!usable(raw)) throw new Error('相邻章正文为空');
      if (raw!.html || raw!.media?.url) {
        const err = new Error('该章不是纯文本正文');
        (err as Error & { code?: string }).code = 'INF_NOT_TEXT';
        throw err;
      }
      const { book, g, jsCtx } = replaceContext(raw!.title ?? ch.title, idx);
      const t = replaceRules.applyTitle(raw!.title ?? ch.title, book, g, jsCtx);
      const c = replaceRules.applyContent(raw!.paragraphs ?? [], book, g, jsCtx);
      let title = t.title || ch.title;
      let paragraphs = c.paragraphs;
      /**
       * `#833` 拼接段要**先做与当前章同一套简繁转换**：否则交接时 `displayParagraphs`
       * 从原文切到转换结果，520 段的累计行高差会把阅读位置推走（实测 ~250px）。
       */
      const convType = prefs.value.chineseConverterType;
      if (isChineseConvertOn(convType)) {
        const [ct, cp] = await Promise.all([convertChinese(title, convType), convertChineseBatch(paragraphs, convType)]);
        title = ct;
        paragraphs = cp;
      }
      return {
        idx,
        title,
        paragraphs,
        subContent: raw!.subContent ?? '',
        // 与「当前章」同一份渲染口径：原样带给拼接段（`ReaderOverlay` 负责按段/章末摆放）
        uiMarks: raw!.uiMarks ?? [],
      };
    })().finally(() => {
      neighborJobs.delete(key);
    });
    neighborJobs.set(key, job);
    return job;
  }

  /**
   * 上下章：跳过卷标题行（卷没有正文页，对齐 Legado 阅读器行为）。
   *
   * ★ `#829` 返回本次开章的 Promise：分页「上一章末页」要等正文真正到位才能量页；
   *   失败也会 resolve（错误写 `detailErr`），调用方自己判。越界 / 无可读章 ⇒ `undefined`。
   */
  function chOffset(delta: number): Promise<void> | undefined {
    const chs = detail.value?.chapters ?? [];
    let next = chapterIdx.value + delta;
    while (next >= 0 && next < chs.length && chs[next]?.isVolume) next += delta > 0 ? 1 : -1;
    if (next < 0 || next >= chs.length) return undefined;
    return openChapter(chs[next]!);
  }

  /** 第一个非卷章节（自动开始阅读用） */
  function firstReadableIndex(): number {
    const chs = detail.value?.chapters ?? [];
    return chs.findIndex((c) => !c.isVolume);
  }

  /**
   * 切换「当前书/剧」时的状态清理。**必须清 `chapterIdx`** ——
   * 否则目录高亮会沿用上一本的章节下标（跨书串位，见 chapterIdx 注释）。
   */
  function reset() {
    chapter.value = null;
    detailErr.value = '';
    directRead.value = false; // `#344` 换书/重开必须复位直达标志
    webDoc.value = false; // `#370` 换书后不再处于「网页即正文」会话
    rssArticle.value = false; // `#399` 换书后不再处于「RSS 文章直达」会话
    chapterIdx.value = -1;
    lastReadIdx.value = -1; // `#294` 换书必须一并清（否则目录高亮串到上一本的进度章）
  }
  function close() {
    /**
     * `#520` **未入书架的书籍：关闭详情页即清掉它的本地缓存**。
     *
     * 用户口径：从发现页随手翻的书（没加书架）不该长期占着 IndexedDB —— 「30 分钟/1 小时超时」
     * 或「关闭详情页直接清」都可以。这里选**立即清**：零定时器、零额外状态、行为确定。
     *
     * 判定：书架键（`key ?? itemKey(sourceId, payload)`）与当前书键相同 ⇒ 在书架 ⇒ **保留**
     * （书架书籍有默认 20 章预取，属于「要长期用」的）。不在书架 ⇒ 清正文缓存 + 目录元数据。
     *
     * ⚠️ 取舍（已与用户确认）：立即清 ⇒ 重新打开这本**未入书架**的书要重新拉目录/正文。
     * 在书架的书不受影响；「返回详情」（`reset()`）也不触发（不是关闭详情页）。
     */
    const closingKey = currentKey.value;
    const closingSourceId = sourceId.value;
    const closingPayload = (it0.value?.payload ?? {}) as unknown;
    const inShelf = !!closingKey && shelf.value.some((b) => (b.key ?? itemKey(b.sourceId, b.payload)) === closingKey);
    open.value = false;
    chapter.value = null;
    detail.value = null;
    directRead.value = false;
    webDoc.value = false; // `#370`
    rssArticle.value = false; // `#399`
    chapterIdx.value = -1;
    lastReadIdx.value = -1;
    if (closingKey && !inShelf) {
      // fire-and-forget：清理是后台 IndexedDB 事务，不阻塞关闭动画
      void clearBookCache({
        key: closingKey,
        sourceId: closingSourceId,
        payload: closingPayload,
      } as unknown as ShelfBook).catch(() => undefined);
    }
  }

  /**
   * `#294` 从书架记录里算出「上次读到第几章」（-1 = 算不出）。
   * 口径与「继续阅读」的定位**同一套**：`lastChapter.payload.chapterUrl` 优先
   * （标题会变、下标会因目录更新漂移，URL 最稳），再回落 payload 深比较，最后回落 `lastIdx`。
   */
  function resolveProgressIdx(
    b: { lastChapter?: { payload: unknown }; lastIdx?: number },
    chs: Array<{ payload: unknown }>,
  ): number {
    if (!chs.length) return -1;
    const want = (b.lastChapter?.payload ?? {}) as { chapterUrl?: string };
    let idx = want.chapterUrl
      ? chs.findIndex((c) => (c.payload as { chapterUrl?: string } | undefined)?.chapterUrl === want.chapterUrl)
      : -1;
    if (idx < 0 && b.lastChapter) {
      idx = chs.findIndex((c) => JSON.stringify(c.payload) === JSON.stringify(b.lastChapter!.payload));
    }
    if (idx < 0 && b.lastIdx !== undefined && b.lastIdx < chs.length) idx = b.lastIdx;
    return idx;
  }

  /** `#294` 详情/目录就绪后同步「上次读到哪」—— 详情页据此高亮该章并滚进可视区（**不打开正文**） */
  function syncLastReadIdx(): void {
    const chs = detail.value?.chapters ?? [];
    const b = shelf.value.find((x) => x.key === currentKey.value);
    lastReadIdx.value = b && chs.length ? resolveProgressIdx(b, chs) : -1;
  }

  /**
   * `#335` **直接以一张网页打开阅读页**（网页型订阅源 / 「极简浏览器」入口）。
   *
   * ## 为什么需要这条通路
   * `singleUrl === true` 的订阅源（全版本汇总 / 源仓库 / XH发布页）**点开就是一张网页** ——
   * 上游 WebView 直接 `loadUrl`。本仓此前只有「分类 → 卡片 → 详情 → 正文」一条链，
   * 走到正文处会因为「无内嵌正文且 `ruleContent` 空」抛 `UNSUPPORTED`（服务端无渲染层），
   * 用户看到的是**报错**而不是网页（用户实测原文：「这类型，应该在源列表点击就直接打开阅读页」）。
   *
   * ★ 所以这类源**不该有自己的正文规则** —— 正文就是网页本身，取页即正文
   * （见 `utils/web-doc.ts` 文件头：取页不该套正文语义）。
   *
   * ## 目录为什么只有一章
   * 保持与 `openChapter` 一致的形态（阅读页的进度/目录都按 `chapterIdx` 寻址），
   * 这一章就是这张网页本身 ⇒ 翻章按钮不会出现第二页，语义与上游「一篇文章 = 一个 URL」相同。
   */
  async function openWeb(src: string, url: string, title: string) {
    const payload = { link: url, title };
    open.value = true;
    sourceId.value = src;
    it0.value = { title, payload };
    reset();
    webDoc.value = true; // `#370`：reset 复位后重新武装 —— 本会话的「详情」是合成的，关闭语义见 closeTopLayer
    /**
     * `#414` 网页型订阅源也要走 **RSS 简化阅读页**（与 `readFirstDirect` 同款工具栏）。
     *
     * 症状（用户 2026-10-12 报）：XH发布页 / 源仓库这类 `singleUrl` 源，点卡片走 `openWeb`
     * 岔路后，`rssArticle` 仍是 `false` ⇒ `ReaderOverlay` 的工具栏回落成**书籍版**
     * （三目录 / 换源 / 更多 / 按钮显示设置…），而不是订阅源该有的精简版。
     * 这里补上会话标志：本会话同样**没有真实详情页**（合成的单章），
     * 语义与 `readFirstDirect` 完全一致 —— 关闭/返回整关回列表（见 closeTopLayer）。
     */
    rssArticle.value = true; // `#414`
    detail.value = { title, chapters: [{ title, payload }] };
    chapterIdx.value = 0;
    lastReadIdx.value = 0;
    contentLoading.value = true;
    detailErr.value = '';
    try {
      /**
       * `#453`（D13 = A+B）「有 view 走 view」的本会话落点：**取页优先走该源的真浏览器会话**
       * （`fetchWebDoc` 内部先试 `POST /api/sessions/render`，没有会话 / 失败再回落 `/api/proxy`）。
       *
       * 为什么不改成「把整页塞进 `WebContentsView`」：本会话的显示全靠 `buildHtmlDoc` 的壳
       * （正文工具、导航桥、懒加载修正、源规则排版），整页塞进真 view 会把这些**全部丢掉**；
       * 而这里真正要的只是「**用真浏览器取页**」—— 登录态 / cookie / TLS 指纹都在那只浏览器里。
       * 真 view 的「打开一个 URL 给人自己点」由 `InAppBrowser` 的 view 模式承接（启动页外链、登录页）。
       */
      const doc = await fetchWebDoc(url, src);
      chapter.value = { title, paragraphs: [], html: doc, htmlBaseUrl: url };
    } catch (e) {
      // 兜底必须留痕（铁律 3）：取页失败要给可见原因，不能留一片空白
      chapter.value = { title, paragraphs: [] };
      detailErr.value = String(e instanceof Error ? e.message : e);
    } finally {
      contentLoading.value = false;
    }
  }

  /** 打开详情（搜索/发现卡片「详情」按钮） */
  function openDetail(src: string, it: Record<string, unknown>) {
    if (!src || !it.payload) return;
    open.value = true;
    sourceId.value = src;
    it0.value = it;
    reset();
    detail.value = { title: it.title ? String(it.title) : undefined, cover: it.cover ? String(it.cover) : undefined };
    void loadDetail(it);
  }

  /** 直接进阅读：打开详情后自动读第一章（卡片「阅读」按钮） */
  async function readFirst(src: string, it: Record<string, unknown>) {
    openDetail(src, it);
    // 等 detail 拉完再开第一章
    while (detailLoading.value) {
      await new Promise((r) => setTimeout(r, 120));
    }
    const chs = detail.value?.chapters ?? [];
    const i0 = firstReadableIndex();
    const ch0 = i0 >= 0 ? chs[i0] : undefined;
    if (ch0) void openChapter(ch0);
  }

  /**
   * `#344` **直达阅读**：跳过详情页展示，直接铺第一章。
   *
   * 用户 2026-10-08 复测反馈（RSS 发现页）：「点击卡片还是会经过详情页…虽然自动继续打开了阅读页，
   * 但**还是书院/影院的逻辑**：点击卡片->详情页->阅读/播放页；RSS 源应该是直达阅读/播放页」。
   *
   * 与 `readFirst` 的区别只在**过渡期画面的呈现**：
   *  · `readFirst`：`openDetail` 先把详情页铺出来（目录/简介），`detailLoading` 期间用户看到的就是详情页，
   *    章节到位后才切正文 ⇒ 观感就是「卡片 → 详情页 → 阅读页」；
   *  · `readFirstDirect`：置 `directRead=true`，浮层在**详情就绪但首章还没到时**显示「加载中…」
   *    而不是详情页 ⇒ 观感是「卡片 → 阅读页」（首章到位即 `directRead` 自动复位）。
   *
   * ★ 只对**订阅源（RSS）**卡片生效 —— 书籍/影视仍是「卡片→详情→正文」的两步（那是它们的原生语义）。
   */
  async function readFirstDirect(src: string, it: Record<string, unknown>) {
    /**
     * ★★ `#366` **先 openDetail 再武装**（顺序缺陷，#344 症状三轮报障的最后一环）：
     *
     * 旧写法先 `directRead=true` 再调 `openDetail` —— 而 `openDetail` 内部的
     * `reset()`（换书清理，2430 行）**会把 directRead 清回 false** ⇒ 详情就绪时
     * `!r.directRead` 恒成立 ⇒ 浮层铺出**详情页**（ReaderOverlay 3185 行），
     * 用户看到的就是「卡片 → 详情页 →（自动跳）阅读页」。#344/#356 都只修了
     * 「路由确实走 readFirstDirect」，过渡抑制标志却每次都被 reset() 吃掉。
     *
     * 修法：openDetail 的同步段跑完（reset 清掉旧态、loadDetail 已置 detailLoading=true，
     * 2109 行）**之后**再武装标志 —— Vue 批处理保证首帧渲染前标志已就位，
     * 过渡期浮层走「加载中…」分支而不是详情页。
     */
    openDetail(src, it);
    directRead.value = true;
    rssArticle.value = true; // `#399`：本会话无详情页 ⇒ 关闭/返回整关回列表（见 closeTopLayer）
    while (detailLoading.value) {
      await new Promise((r) => setTimeout(r, 120));
    }
    const chs = detail.value?.chapters ?? [];
    const i0 = firstReadableIndex();
    const ch0 = i0 >= 0 ? chs[i0] : undefined;
    if (ch0) {
      await openChapter(ch0);
      return;
    }
    /**
     * `#356` **订阅源文章本身就是一章** —— 详情没给出目录时**不能退回详情页**。
     *
     * 用户 2026-10-08 第三次报同一个现象：「RSS 卡片点进去还是先详情、再阅读」。
     * 根因之一就在这里：RSS 的「详情」常常**没有目录**（文章不是书，没有章节列表），
     * 于是 `ch0` 为空 ⇒ 直接复位 `directRead` ⇒ 浮层铺出详情页 —— 用户看到的就是
     * 「卡片 → 详情页」，再手动点一次才进正文。
     *
     * 修法：拿**卡片自己的 payload** 合成一章直接读（这正是订阅源的语义：点文章 = 读这篇）。
     * 只有当连 payload 都没有（无从取正文）时才退回详情页，避免对着「加载中…」无处可去。
     */
    if (it.payload) {
      await openChapter({ title: String(it.title ?? ''), payload: it.payload });
      return;
    }
    directRead.value = false;
  }

  /** 发现页卡片（源固定） */
  function openFromDiscover(it: Record<string, unknown>) {
    openDetail(sourceId.value, it);
  }

  /**
   * 打开书架里的书。
   *
   * `opts.read`（默认 `true`）= 「继续阅读」：详情到位后**直接打开上次读到的章节**；
   * `false` = 「详情」：只把详情/目录铺出来，停在详情页。
   *
   * 两条路径都**优先读本地**（用户 5-2/5-4：书架里的书，详情/目录已本地化，不该每点一次就重新拉）。
   * 只有本地没有（或用户点了刷新）才请求上游，并把结果回写本地。
   */
  async function openShelfBook(b: ShelfBook, opts: { read?: boolean; force?: boolean } = {}) {
    const read = opts.read ?? true;
    open.value = true;
    sourceId.value = b.sourceId;
    /**
     * ★★★ 修「本地书正文永远取不到」（用户 2026-10-02 实测发现，探针 `probe-220-highlight.mjs` 定位）：
     * 原来写 `it0.value = { payload: b.payload }` —— 但 **`b.payload` 本身就已经是载荷**
     * （`ShelfBook.payload`，本地书是 `{ fileName }`），这里**又包了一层** ⇒
     * `it0.value.payload` 变成 `{ payload: { fileName } }`
     * ⇒ `itemKey(src, { payload: {...} })`（`fetchContent` / `currentKey` 都用它）算出**错误的 bookUrl**
     * ⇒ `GET /api/local-books/content` 用这个错 key 查不到章
     * ⇒ 抛「本地书章节缺少章号」被兜底成「正文为空」⇒ **导入/目录都正常，正文一片空白**。
     *
     * 正解：`it0` 就是「书条目」结构本身（`{ key, sourceId, payload, title, kind, ... }`），
     * **整本铺进去即可**，不要再手工碰 `payload`（它已经是载荷，碰就多包一层）。
     */
    it0.value = { ...b };
    reset();
    detail.value = { title: b.title, author: b.author, cover: b.cover };
    detailFromCache.value = false;
    detailLoading.value = true;
    const key = b.key ?? itemKey(b.sourceId, b.payload);
    try {
      // ---- ① 本地优先（详情+目录） ----
      let used = false;
      if (!opts.force) {
        const local = await getBookMeta<ReaderDetail>(key);
        if (local?.detail?.chapters?.length) {
          // 本地书旧缓存的章节 payload 缺书本键 ⇒ 补上并落盘（否则仍会命中别的本地书的正文缓存）
          if (isLocalBookSource(b.sourceId) && migrateLocalChapterPayloads(local.detail.chapters, key)) {
            void putBookMeta(key, local.detail);
          }
          detail.value = mergeDetail(detail.value, local.detail);
          detailFromCache.value = true;
          used = true;
        }
      }
      // ---- ② 本地没有才请求上游，并回写 ----
      if (!used) {
        const r = await fetchDetail(b.sourceId, b.payload, key);
        if (r) detail.value = mergeDetail(detail.value, r);
        if (detail.value?.chapters?.length) void putBookMeta(key, detail.value);
      }
      noteTocLoaded(detail.value?.chapters?.length ?? 0);
      const chs = detail.value?.chapters ?? [];
      /**
       * `#294` 「上次读到哪」**两条路径都要算**（原先只在 `read` 分支里算）——
       * 详情页（`read: false`）同样要把它高亮出来并滚进可视区，用户 2026-10-05 明确要求。
       * 定位口径见 {@link resolveProgressIdx}；这里不打开正文，也不写任何阅读状态。
       */
      const lastIdx0 = chs.length ? resolveProgressIdx(b, chs) : -1;
      lastReadIdx.value = lastIdx0;
      if (read && lastIdx0 >= 0) void openChapter(chs[lastIdx0]!);
    } catch (e) {
      // 本地有数据时网络失败不该把已有目录抹掉（离线也能继续读）
      detailErr.value = detailFromCache.value ? '' : '详情加载失败：' + String(e instanceof Error ? e.message : e);
    } finally {
      detailLoading.value = false;
      // `#294` 异常路径也同步一次（本地有缓存时 detail 仍可用）
      syncLastReadIdx();
    }
  }

  /* ============================ 5-3 书架维护（更新 / 批量操作） ============================ */

  /** 「更新」进度：更新一批书的详情/目录（UI 显示 x/y） */
  const shelfUpdate = ref<{ running: boolean; done: number; total: number; failed: number }>(
    { running: false, done: 0, total: 0, failed: 0 },
  );
  let shelfUpdateSeq = 0;

  /**
   * 更新一批书的**详情/目录**并**写回本地**（用户 5-3 的「更新」按钮与批量「更新详情目录」）。
   *
   * 照 Legado 两条语义：
   *  · `canUpdate === false` 的书**跳过** —— Legado `Book.canUpdate` 就是给「禁止更新」用的；
   *  · 目录变长时 `lastCheckCount = 新章节数 - 旧总数`（`BookChapterList.kt:172`），
   *    未读角标据此**高亮**（`BooksAdapterGrid.kt:100`）；读完一次即清零（`saveProgress`）。
   */
  async function updateShelfBooks(books: ShelfBook[]): Promise<void> {
    // 本地书 `canUpdate === false`（导入时按上游语义置的），再显式排一次本地书，语义更清楚
    const targets = books.filter((b) => b.canUpdate !== false && !isLocalBookSource(b.sourceId));
    const my = ++shelfUpdateSeq;
    shelfUpdate.value = { running: true, done: 0, total: targets.length, failed: 0 };
    for (const b of targets) {
      if (my !== shelfUpdateSeq) return;
      const key = b.key ?? itemKey(b.sourceId, b.payload);
      try {
        const r = await fetchDetail(b.sourceId, b.payload, key);
        const chapters = r?.chapters ?? [];
        if (chapters.length) {
          const before = b.totalChapterNum ?? 0;
          await putBookMeta(key, r);
          b.totalChapterNum = chapters.length;
          if (before < chapters.length) {
            b.lastCheckCount = chapters.length - before;
            b.latestChapterTime = Date.now();
          }
          if (!b.cover && r?.cover) b.cover = r.cover;
          if (!b.author && (r?.author ?? r?.subtitle)) b.author = r.author ?? r.subtitle;
        }
        shelfUpdate.value.done += 1;
      } catch {
        shelfUpdate.value.failed += 1;
      }
    }
    shelfUpdate.value.running = false;
    saveShelf();
  }

  /** 清掉某本书的**本地化缓存**（详情/目录 + 预缓存窗口持有的正文；不碰用户手动「⬇ 缓存」的那批） */
  /**
   * `#516` 清掉**这本书**的全部本地缓存（详情/目录 + 正文）。
   *
   * 旧实现只删 `precacheKeys`（预取窗口持有的那批）—— 漏了两类：
   *  · 用户点「⬇ 缓存」手动下的章节（不在这份集合里）；
   *  · **已读章节**（修好预取窗口后它们会长期留着，见 `prefetchWindow`）。
   * 新口径：用**目录里的每章 payload 算键**逐个删（键 = `sourceId|payload`），
   * 有则删、无则跳过 —— 这才是「清理该书籍缓存」的语义。
   */
  async function clearBookCache(
    b: ShelfBook,
    /**
     * 目录**当时**的章节（可选）。非书架书不会 `putBookMeta`（见 `loadDetail` 的 `inShelf` 判据），
     * 只靠本地 meta 会算不出键 ⇒ 「清理本书」对没收藏的书永远返回 0。详情页清缓存时把
     * 内存里的目录传进来即可（同一份章节，键口径与预取/下载一致）。
     */
    extraChapters?: Array<{ payload: unknown; isVolume?: boolean }>,
  ): Promise<number> {
    const key = b.key ?? itemKey(b.sourceId, b.payload);
    const meta = await getBookMeta<ReaderDetail>(key);
    const chs = [
      ...((meta?.detail?.chapters ?? []) as Array<{ payload: unknown; isVolume?: boolean }>),
      ...(extraChapters ?? []),
    ];
    const keys = new Set<string>([
      ...(windowKeys.get(key) ?? []),
      ...(meta?.precacheKeys ?? []),
      ...chs.filter((c) => !c.isVolume).map((c) => chapterKey(b.sourceId, c.payload)),
    ]);
    const removed = keys.size ? await deleteCachedByKeys([...keys]) : 0;
    // 内存预载也要作废：否则清完再从内存命中，看起来像「没清掉」
    for (const k of keys) preloadBuf.delete(k);
    windowKeys.delete(key);
    await deleteBookMeta(key);
    return removed;
  }

  /** `#516` 详情页「清理本书缓存」按钮：按当前书清（返回清掉的章节数，0 = 本来就没缓存） */
  async function clearCurrentBookCache(): Promise<number> {
    const key = currentKey.value;
    if (!key) return 0;
    const b = {
      key,
      sourceId: sourceId.value,
      payload: (it0.value?.payload ?? {}) as unknown,
    } as unknown as ShelfBook;
    const chs = (detail.value?.chapters ?? []).filter((c) => !c.isVolume);
    return clearBookCache(b, chs);
  }

  /** 批量移出书架（顺带清本地化缓存，不留残渣） */
  async function removeBooks(books: ShelfBook[]): Promise<void> {
    const keys = new Set(books.map((b) => b.key ?? itemKey(b.sourceId, b.payload)));
    for (const b of books) await clearBookCache(b);
    shelf.value = shelf.value.filter((x) => !keys.has(x.key ?? itemKey(x.sourceId, x.payload)));
    saveShelf();
  }

  /** 批量「允许更新 / 禁止更新」（Legado `Book.canUpdate`） */
  function setBooksAllowUpdate(books: ShelfBook[], allow: boolean): void {
    for (const b of books) b.canUpdate = allow;
    saveShelf();
  }

  /** 批量移入分组（复用位掩码数据层 `setBookGroup`） */
  function moveBooksToGroup(books: ShelfBook[], groupId: number): void {
    for (const b of books) setBookGroup(b, groupId);
  }

  /* ---------------- `#274` 换源：执行器（搜索/归并在 SourceSwitchDialog 组件内） ---------------- */

  /**
   * 切到另一源的同一本书（对齐 OmniFlow `bookSession.switchBookSource` L450-542 的本仓语义）。
   *
   * ★ 与旧版（迁移式：把书架条目的 key **改写**成新源）的行为差异 —— **双写**：
   *   旧源条目**原样保留**（同书不同源都留在书架、都可续读），另建新源条目并复制
   *   分组 / 更新标记；两个条目各自记各自的进度。
   *
   * ★ 续读定位：记住切换前的**章节名**，新源目录加载后按名匹配 —— 命中跳同一章，
   *   找不到（两源目录命名不同/章节更少）回落第一章（OmniFlow L509-520 同规则）。
   */
  async function switchBookSource(r: { sourceId: string; payload: unknown; title?: string }): Promise<void> {
    const fromKey = currentKey.value;
    const entry = shelf.value.find((x) => x.key === fromKey);
    const keepChapterName = chapter.value?.title ?? null;
    sourceId.value = r.sourceId;
    it0.value = { payload: r.payload };
    reset();
    detailLoading.value = true;
    try {
      const d = await fetchDetail(r.sourceId, r.payload);
      if (d) detail.value = mergeDetail(detail.value, d);
      noteTocLoaded(detail.value?.chapters?.length ?? 0);
      // ★ 双写：旧条目不动；新条目 = 旧条目拷贝 + 换键/换源（分组、可更新标记、阅读进度初值随行）
      if (entry) {
        const toKey = itemKey(r.sourceId, r.payload);
        if (toKey !== fromKey && !shelf.value.some((x) => x.key === toKey)) {
          shelf.value.push({
            ...entry,
            key: toKey,
            sourceId: r.sourceId,
            payload: r.payload,
            title: r.title || entry.title,
            updatedAt: Date.now(),
          });
          saveShelf();
        }
      }
      // ★ 按章节名在新目录定位续读；找不到回落第一章
      const toc = detail.value?.chapters ?? [];
      let target = toc[0];
      if (keepChapterName) {
        const hit = toc.find((c) => c.title === keepChapterName);
        if (hit) target = hit;
      }
      if (target) await openChapter(target);
    } catch (e) {
      detailErr.value = '换源失败：' + String(e instanceof Error ? e.message : e);
    } finally {
      detailLoading.value = false;
    }
  }

  /** 改正文字号（`#145`：落进 prefs ⇒ 本地缓存 + 推服务端） */
  function setFont(v: number) {
    const n = Number(v);
    if (!Number.isFinite(n)) return; // 脏值不写（`Number(null)===0` 会把字号改成 8）
    patchPrefs({ textSize: Math.min(80, Math.max(8, Math.round(n))) });
  }

  /** 改主题档位（4 档，取值见 `styles/reader-theme.ts`） */
  function setThemeMode(m: ReaderThemeMode | string) {
    patchPrefs({ themeMode: normalizeThemeMode(m) });
  }

  /* ---------------- `#224` 视图模式（滚动 / 分页） ----------------
   * ⚠️ **不进契约**（上游 Legado 根本没有这个开关 —— 它的阅读器本来就是分页 View，
   * 「滚动」只是 `PageAnim.scrollPageAnim` 那一档）。所以落 localStorage，
   * 读写 + 白名单校验全在 `utils/reader-view-mode.ts`（与 navMode / discoverViewMode 同类）。
   *
   * 为什么放 store 而不是 `ReaderOverlay` 的组件 ref：分页要跨「关浮层 → 重开」保留，
   * 组件 ref 会被卸载清掉（`discover-view-mode` 当初就是因为这个才放 store 的）。
   */
  const viewMode = ref<ReaderViewMode>(loadReaderViewMode());

  function setViewMode(m: ReaderViewMode): void {
    const next = normalizeReaderViewMode(m);
    if (viewMode.value === next) return;
    viewMode.value = next;
    // 落盘失败（隐私模式/配额满）时**内存里仍生效**，只是不跨会话 ——
    // 不抛：视图切换是次要功能，为它打断阅读体验更糟（与 saveViewMode 同一判断）。
    saveReaderViewMode(next);
  }

  /**
   * `#833` **滚动模式「无限滚动」开关**（默认关）。
   *
   * 与 `viewMode` 同一层语义：本地偏好、不进契约、关浮层再开也保留。
   * 真正干活的是 `ReaderOverlay`（哨兵 + 拼接 + 锚点补偿），这里只持有开关状态。
   */
  const infiniteScroll = ref<boolean>(loadInfiniteScroll());

  function setInfiniteScroll(on: boolean): void {
    if (infiniteScroll.value === on) return;
    infiniteScroll.value = on;
    saveInfiniteScroll(on);
  }

  /* ---------------- 阅读样式：全局默认 vs 每本覆盖（`#164`） ----------------
   * 两件事**必须分开**（用户 2026-09-30 明确要求）：
   *  · **设置页 → 改全局默认**（`patchReadStyle`）：所有「没单独设过」的书都跟着变；
   *  · **阅读界面 → 改当前这本书**（`patchBookReadStyle`）：只影响这一本，写进 `ShelfBook.readStyle`。
   * 两者写的是**不同的存储**：前者进 `prefs`（服务端 `/api/user/prefs`），
   * 后者进书架条目（随书架的 pushDiff 一起上服务端）——所以**「本书覆盖」换设备也在**。
   */

  /** 去掉 `undefined` 的键 —— 合并时「没给」必须是**不覆盖**，不能是「覆盖成 undefined」 */
  function definedOnly<T extends object>(patch: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) out[k] = v;
    }
    return out as Partial<T>;
  }

  /** 改**全局默认**阅读样式（设置页用）。只写阅读样式的键，界面主题/封面不受影响。 */
  function patchReadStyle(patch: ReadStyleOverride): void {
    const cur = pickReadStyle(prefs.value) as Record<string, unknown>;
    patchPrefs({ ...cur, ...definedOnly(patch) } as Partial<GlobalReaderPrefs>);
  }

  /**
   * 改**当前这本书**的阅读样式覆盖（阅读界面用）。
   *
   * ⚠️ 书**不在书架**时**不写**（返回 `false`）—— 因为可覆盖的样式存在书架条目上，
   * 没有条目就没有地方存。这里**不偷偷把书加进书架**（那是用户没要求的副作用），
   * 而是让界面如实提示「加入书架后可单独设置」。调用方拿返回值决定提示文案。
   */
  function patchBookReadStyle(patch: ReadStyleOverride): boolean {
    const b = currentShelfBook.value;
    if (!b) return false;
    b.readStyle = { ...(b.readStyle ?? {}), ...definedOnly(patch) };
    saveShelf();
    return true;
  }

  /**
   * 清掉当前这本书的覆盖（回到「跟随全局」）。
   * ⚠️ 赋 `null` 而不是 `{}`：`{}` 在语义上是「覆盖了、但一个键都没有」，
   * 与「从没覆盖过」不可区分（契约 `ShelfBook.readStyle` 的注释写了这条）。
   */
  function clearBookReadStyle(): boolean {
    const b = currentShelfBook.value;
    if (!b) return false;
    b.readStyle = null;
    saveShelf();
    return true;
  }

  /* ---------------- `#260` 本书级净化开关：写 + 立即重跑本章 ---------------- */

  /**
   * 设**当前这本书**的净化开关（阅读界面「更多 → 替换净化」用）。
   *
   * @param v `true`/`false` = 本书显式覆盖；`null` = 清掉覆盖、回到跟随全局。
   * @returns 是否写入成功 —— 书**不在书架**时返回 `false`（覆盖只能存在书架条目上）。
   *          调用方必须据此如实提示，**不要**偷偷把书加进书架（那是用户没要求的副作用，
   *          同 `patchBookReadStyle` 的约定）。
   */
  function setBookUseReplaceRule(v: boolean | null): boolean {
    const b = currentShelfBook.value;
    if (!b) return false;
    b.useReplaceRule = v;
    saveShelf();
    return true;
  }

  /**
   * `#261` 写本书的手动规则集。
   * @returns 是否写入成功 —— 书**不在书架**时返回 `false`（与 `setBookUseReplaceRule` 同约定：
   *          不偷偷把书加进书架）。调用方据此如实提示。
   */
  function setBookManualRuleIds(ids: number[] | null): boolean {
    const b = currentShelfBook.value;
    if (!b) return false;
    b.manualReplaceRuleIds = ids && ids.length ? [...ids] : null;
    saveShelf();
    return true;
  }

  /**
   * 用**离线缓存里的原文**重新跑一遍当前章 —— **不联网**（`cache:'read'`）。
   *
   * ★ 为什么必须有这一步：净化只在**展示时**做、缓存里存的是**原文**
   * （见 `utils/replace-rules.ts` 文件头）⇒ 改了开关或规则后，正在看的这一章
   * **不会自己变**。不重跑就等于「点了没反应」，用户只会以为功能坏了。
   */
  function reloadCurrentChapter(): void {
    const ch = (detail.value?.chapters ?? [])[chapterIdx.value];
    if (ch) void openChapter(ch, { cache: 'read' });
  }

  return {
    firstReadableIndex,
    open, sourceId, detail, detailLoading, detailErr, chapter, contentLoading, chapterIdx, lastReadIdx, webDoc, rssArticle,
    // 阅读偏好（`#145`：字号 / 主题 / 排版 —— 本地缓存 + 服务端）
    prefs, readerFont, themeMode, readerColors, readerColorSetName, readerStyleVars, readerTitleVars, readerTipVars, tipVarsOf, prefersDark,
    // `#249` 整个阅读界面的背景（页眉+正文+页脚共用；`.se-scroll` 用）
    readerBackdropVars,
    // `#250` 栏位透明（标题栏 / 页眉 / 页脚）：透明时给 `transparent`，不透明时给预混底色
    readerBarVars,
    // 阅读样式（`#164`）：生效样式 / 全局默认写入 / 每本覆盖
    readStyle, currentReadStyleOverride, canOverrideReadStyle, hasBookReadStyle,
    patchReadStyle, patchBookReadStyle, clearBookReadStyle,
    // `#260` 本书级净化开关 + 「起效的替换规则」+ 改完不联网重跑本章
    replaceEnabled, currentBookUseReplaceRule, setBookUseReplaceRule,
    // `#261` 手动规则集
    currentBookManualRuleIds, setBookManualRuleIds,
    effectiveReplaceIds, reloadCurrentChapter,
    /**
     * `#620` 净化**唯一实现**对外暴露（导出用）。导出必须与屏幕上的正文一致，
     * 所以它不能在前端另写一份「导出专用净化」—— 那正是「同一判据两处漂移」。
     * ⚠️ 调用会改写 `effectiveReplaceIds`（「起效的替换规则」面板的数据源），
     * 批量调用方（导出）结束后要自行还原。
     */
    purify,
    // 界面主题 / 封面配置（`#163`）
    uiTheme, uiIsNight, uiBgIsLight, uiThemeVars, uiCoverParams, activeUiThemeName,
    applyUiTheme, patchUiTheme, saveUiThemeAs, deleteUiTheme, patchCover,
    exportUiThemesText, importUiThemes, importThemeRules, exportCurrentUiThemeText,
    // 简繁转换（`#146`）：显示层转换，不动 `chapter`/缓存里的原文
    displayTitle, displayParagraphs, tocTitleAt, convertedChapter, convertedTocTitles,
    // `#712` 阅读模式文本化（显示层，同上：不动缓存原文）
    applyReaderModeText,
    it0, shelf,
    watchHistory, watchSorted, recordWatch, removeWatch, clearHistory, recordProgress, bookShelf, videoShelf,
    beginReadSession, endReadSession,
    saveShelf, currentKey, hasInShelf, inCurrentShelf, toggleShelf, removeFromShelf, addToShelf,
    // 书架分组（见 shelf-groups.ts）
    groups, groupsSorted, groupsVisible, groupBookCount, ungroupedCount,
    visibleBooks, visibleBookCount, shelfSort, setShelfSort,
    createGroup, updateGroup, deleteGroup, moveGroup, setBookGroup, progressPercentOf, noteTocLoaded,
    // Phase 1.4（#66）：启动时与服务端对齐（main.ts 在 mount 前 await；离线则保持本地）
    hydrateGroups, hydrateShelf, hydrateBookmarks, hydrateHighlights,
    // `#145`：阅读偏好对齐（prefs 端点；策略同上）
    hydratePrefs,
    // 5-1 进度条 / 未读角标（判据照 Legado，见各函数注释）
    readProgressOf, unreadOf,
    // 5-3 书架维护
    shelfUpdate, updateShelfBooks, clearBookCache, removeBooks, setBooksAllowUpdate, moveBooksToGroup,
    // 5-5 正文预缓存窗口
    precacheCount, setPrecacheCount, precacheState, prefetchWindow,
    // `loadDetail` 必须导出：详情浮层的「↻ 刷新」按钮（③-2）要重新拉一次详情/目录
    openDetail, readFirst, readFirstDirect, directRead, openFromDiscover, openShelfBook, openWeb, loadDetail, detailFromCache,
    openChapter, chOffset, loadNeighborChapter, switchBookSource, close, reset,
    // `#207`：离线缓存 / 整本下载 → 统一由 `stores/downloads.ts` 承载（见文件内注释）
    countCached, clearCached,
    // `#516` 详情页「清理本书缓存」
    clearCurrentBookCache,
    // 书签（4-4）
    bookmarks, currentBookmarks, addBookmark, removeBookmark, hasBookmarkAt,
    // 划线高亮/笔记（`#146`；与书签同构：本地缓存 + 服务端，见 HIGHLIGHTS_PLAN）
    highlights, currentHighlights, currentChapterHighlights,
    addHighlight, setHighlightNote, setHighlightStyle, removeHighlight,
    lastHighlightStyle,
    // 书内全文搜索（`#146` 第三步）
    bookSearchOpen, bookSearchQuery, bookSearchRegex, bookSearchRunning,
    bookSearchHits, bookSearchNote, bookSearchProgress,
    runBookSearch, cancelBookSearch, closeBookSearch,
    setFont, setThemeMode, patchPrefs,
    // `#224`：视图模式（滚动 / 分页）
    viewMode, setViewMode,
    // `#833`：滚动模式「无限滚动」开关（默认关）
    infiniteScroll, setInfiniteScroll,
  };
});
