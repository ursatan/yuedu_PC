/**
 * 用户数据契约（Phase 1.1）
 *
 * ## 为什么有这个文件
 * 书架 / 目录 / 阅读进度 / 收藏 / 净化规则等**此前全在浏览器 localStorage**（`apps/web/src/stores/reader.ts`），
 * 导致「换设备即丢、PC 与 Web 不互通、WebDAV 同步无从下手」。Phase 1 要把它们搬到服务端，
 * 搬之前必须有**一份唯一的字段定义**，否则前端、服务端、同步包会各自长出一套。
 *
 * ## 字段来源纪律（不可违背）
 * 本文件**每个字段都逐条对照 `F:\legado` 的真实实体源码提取**（Legado 3.26082823），
 * 字段名、类型、默认值一律照抄，并在注释里标注来源文件与行号范围。
 * **禁止**凭印象增删字段、禁止按 grep 行数估算（历史上出过 BookSource 38/33、RssSource 40/45 的错）。
 *
 * ## 消费标记
 * - `[P1]` 本期（Phase 1）就要落库并接 REST
 * - `[P2]` / `[P3]` / `[P4]` / `[P5]` 对应路线图阶段，本期只在契约里占位，**不做实现**
 *
 * 存储分层见 `docs/移植路线图.md` §5.1：结构化 → SQLite；正文/图片 → 文件；源/Cookie/KV → JSON。
 *
 * @see F:\legado\app\src\main\java\io\legado\app\data\entities\Book.kt
 * @see F:\legado\app\src\main\java\io\legado\app\data\entities\BookChapter.kt
 * @see docs\移植路线图.md
 */

/* ------------------------------------------------------------------ *
 * 一、常量（照抄 Legado constant/BookType.kt、BookGroup.kt）
 * ------------------------------------------------------------------ */

/**
 * 书籍类型 —— **位掩码**，一本书可同时属于多个类型。
 * Legado：`BookType`（`constant/BookType.kt:10-77`），查询用 `type & :type > 0`。
 */
export const BookType = {
  /** 4 视频 */
  video: 0b100,
  /** 8 文本 */
  text: 0b1000,
  /** 16 更新失败 */
  updateError: 0b10000,
  /** 32 音频 */
  audio: 0b100000,
  /** 64 图片（漫画） */
  image: 0b1000000,
  /** 128 只提供下载服务的网站 */
  webFile: 0b10000000,
  /** 256 本地 */
  local: 0b100000000,
  /** 512 压缩包解压来源 */
  archive: 0b1000000000,
  /** 1024 未正式加入书架的临时阅读书籍 */
  notShelf: 0b100_0000_0000,
} as const;

/** 所有可从网络书源转换的类型（BookType.kt:64） */
export const BOOK_TYPE_ALL =
  BookType.video | BookType.text | BookType.image | BookType.audio | BookType.webFile;

/** 网络 + 本地（BookType.kt:66） */
export const BOOK_TYPE_ALL_LOCAL = BOOK_TYPE_ALL | BookType.local;

/** 本地书籍的「书源」标志（BookType.kt:71） */
export const LOCAL_TAG = 'loc_book';

/**
 * 本地书的 `payload` 约定：`{"fileName":"<原文件名>"}`（`#202`）。
 *
 * ★ 为什么要有这个约定：本仓书架的**主键是前端算的**
 *   （`bookUrl = encodeItemKey(itemKey(origin, payload))`，见 `apps/web/src/utils/user-map.ts`）。
 *   本地书没有「源给的 payload」，就用文件名当 payload —— 这样
 *   「服务端存下的 `bookUrl`」与「前端从书回推的 key」**必然一致**，
 *   续读进度 / 书签 / 高亮才不会因为 key 对不上而串或丢。
 */
export function localBookPayload(fileName: string): { fileName: string } {
  return { fileName };
}

/**
 * 本仓条目主键的组装（`sourceId\0id`）—— `itemKey` 的**契约层唯一实现**（`#212` Step3）。
 *
 * 前端 `stores/reader.ts` 的 `itemKey()` 对**网络书**还要按 `bookUrl`/`vodId`/`url` 优先级
 * 挑 id；本地书的 payload 只有 `fileName` ⇒ 必然走「键排序后的稳定 JSON」分支
 * （= `{"fileName":"x"}`）。压缩包批量导入在**服务端**进行，而服务端拿不到前端那个
 * `itemKey()` ⇒ 把那一段（键排序 JSON 分支）落成契约函数，两边共用，**不再各写一份**
 * （否则就是「同一判据写两处必然漂移」，`#247`/`#312`）。
 */
export function localBookItemKey(fileName: string): string {
  return `${LOCAL_TAG}\u0000${JSON.stringify(localBookPayload(fileName))}`;
}

/**
 * 把主键里的 `\u0000` / `%` 转义（SQLite 读写回会截断 NUL）—— `encodeItemKey` 的**唯一实现**。
 *
 * 前端 `utils/user-map.ts` 的同名函数改为调用它（对外签名不变）；服务端组装
 * 本地书主键时直接用它取代 `defaultLocalBookUrl`（`#212` Step3）。
 */
export function encodeItemKey(key: string): string {
  return key.split('%').join('%25').split('\u0000').join('%00');
}

/**
 * 本地书的**服务端主键**（`#202` 第一条不变量）—— 全仓唯一算法（`#212` Step3 下沉到契约层）。
 *
 * = `encodeItemKey(localBookItemKey(fileName))`。前端 `utils/local-book-key.ts` 的
 * `localBookUrlOf()` 与服务端压缩包批量导入都调它 ⇒ 同一本书无论从哪条路进来，
 * 主键都一致（否则前端会判成「不在书架」，续读/书签/高亮全丢）。
 */
export function localBookUrlOf(fileName: string): string {
  return encodeItemKey(localBookItemKey(fileName));
}

/** WebDAV 书籍的 origin 前缀（BookType.kt:76）——`origin` 以它开头表示可从 WebDAV 更新 */
export const WEBDAV_TAG = 'webDav::';

/**
 * 内置分组 ID（照抄 `BookGroup.kt:32-41`）。
 *
 * ⚠️ 注意：这些是**负数常量**，而普通分组 `groupId` 是**正整数**（Entity 默认 `0b1`）。
 * 用法：内置分组用于虚拟视图（全部/本地/音频…），用户自建分组才是真实行。
 */
export const BookGroupId = {
  /** 根分组（父节点） */
  root: -100,
  /** 全部 */
  all: -1,
  /** 本地 */
  local: -2,
  /** 音频 */
  audio: -3,
  /** 网络书籍·未分组 */
  netNone: -4,
  /** 本地书籍·未分组 */
  localNone: -5,
  /** 视频 */
  video: -6,
  /** 更新失败 */
  error: -11,
} as const;

/** 图片样式（`Book.kt:486-489` 的常量，与引擎 `imageStyle` 同源） */
export const ImageStyle = {
  default: 'DEFAULT',
  full: 'FULL',
  text: 'TEXT',
  single: 'SINGLE',
} as const;

/** 简繁转换类型（`BookChapter.kt:131-136` 的 `when(chineseConverterType)`：1→t2s，2→s2t） */
export const ChineseConvertType = {
  /** 不转换 */
  none: 0,
  /** 繁 → 简 */
  t2s: 1,
  /** 简 → 繁 */
  s2t: 2,
} as const;

/* ------------------------------------------------------------------ *
 * 二、书架（对应 Legado `Book`，表 books）        [P1]
 * ------------------------------------------------------------------ */

/**
 * 每本书的阅读设置（对应 `Book.ReadConfig`，`Book.kt:492-514`，**19 个字段**）。
 *
 * 在 Legado 里以 **JSON 字符串**存在 `books.readConfig` 列（TypeConverter `Book.Converters`），
 * 因此它不是一个独立表。
 */
export interface BookReadConfig {
  /** 目录倒序（`Book.kt:494`，默认 false） */
  reverseToc: boolean;
  /** 目录默认展开（`Book.kt:495`，默认 true） */
  tocExpanded: boolean;
  /** 翻页动画（`Book.kt:496`，默认 null = 跟随全局/图片源走 scroll） */
  pageAnim: number | null;
  /** 重新分段（`Book.kt:497`，默认 false） */
  reSegment: boolean;
  /** 图片样式（`Book.kt:498`，默认 null；取值见 {@link ImageStyle}） */
  imageStyle: string | null;
  /** 正文使用净化替换规则（`Book.kt:499`，默认 null = 走全局 `replaceEnableDefault`） */
  useReplaceRule: boolean | null;
  /** 去除标签位掩码（`Book.kt:500`，默认 0；`hTag=2`、`rubyTag=4`） */
  delTag: number;
  /** TTS 引擎（`Book.kt:501`，默认 null） */
  ttsEngine: string | null;
  /** 超长章节分页（`Book.kt:502`，默认 true） */
  splitLongChapter: boolean;
  /** 阅读模拟（`Book.kt:503`，默认 false） */
  readSimulating: boolean;
  /** 阅读模拟起始日期（`Book.kt:504`，默认 null；Legado 用 `java.time.LocalDate` → 存 ISO `YYYY-MM-DD`） */
  startDate: string | null;
  /** 阅读模拟起始章节（`Book.kt:505`，默认 null） */
  startChapter: number | null;
  /** 阅读模拟每日章节数（`Book.kt:506`，默认 3） */
  dailyChapters: number;
  /** 音频片头（`Book.kt:507`，默认 0，秒） */
  openCredits: number;
  /** 音频片尾（`Book.kt:508`，默认 0，秒） */
  closeCredits: number;
  /** 音频播放模式（`Book.kt:509`，默认 0） */
  playMode: number;
  /** 音频播放速度（`Book.kt:510`，默认 1.0） */
  playSpeed: number;
  /** 音频片头片尾走全局（`Book.kt:511`，默认 false） */
  useGlobalAudioSkip: boolean;
  /** 手动选择的替换规则 id（`Book.kt:513`，默认空数组） */
  manualReplaceRuleIds: number[];
}

/**
 * 书架条目（对应 `Book`，`Book.kt:39-130`，**34 个持久化字段**）。
 *
 * ## 身份（很重要）
 * - **主键 = `bookUrl`**（`Book.kt:41-43`）。
 * - ⚠️ 但 `books` 表另有 **`(name, author)` 唯一索引**（`Book.kt:37`），
 *   且 DAO 用 `@Insert(onConflict = REPLACE)`（`BookDao.kt:217`）+ `save()` 里
 *   `if (has(bookUrl)) update else insert`（`Book.kt:467-473`）。
 *   **含义：同名同作者的书在 Legado 里只会存在一条**（后插入的会 REPLACE 掉前者）。
 *   这是与 Web 端现状（按 `sourceId+bookUrl` 允许同名共存）的**真实差异**，
 *   移植时必须显式决策（见文件末尾「待决策」）。
 * - ⚠️ `equals`/`hashCode` 只比较 `bookUrl`（`Book.kt:132-141`）。
 *
 * ## 阅读进度
 * **进度直接存在本行内**（`durChapterIndex/Pos/Time/Title/durVolumeIndex/chapterInVolumeIndex`），
 * 不另建表 —— 这是 Legado 的原始设计，好处是「书架列表 + 进度」一次查询拿到、无一致性风险。
 * 因此本契约不提供独立的 `ReadProgress` 存储表，只提供派生视图 {@link ReadProgress}。
 */
export interface ShelfBook {
  /** 详情页 URL（本地书源存完整文件路径）。**主键**。默认 `""` */
  bookUrl: string;
  /** 目录页 URL（toc = table of contents）。默认 `""` */
  tocUrl: string;
  /**
   * 书源 URL（`bookSourceUrl`）。默认 **`loc_book``（{@link LOCAL_TAG}）**。
   * 与 `originName` 一起决定「这本书来自哪个源」。
   */
  origin: string;
  /** 书源名称；本地书籍为文件名。默认 `""` */
  originName: string;
  /** 书籍名称（书源获取）。默认 `""` */
  name: string;
  /** 作者名称（书源获取）。默认 `""` */
  author: string;
  /** 分类信息（书源获取）。默认 null */
  kind: string | null;
  /** 分类信息（用户修改）。默认 null */
  customTag: string | null;
  /** 封面 URL（书源获取）。默认 null */
  coverUrl: string | null;
  /** 封面 URL（用户修改）。默认 null */
  customCoverUrl: string | null;
  /** 简介（书源获取）。默认 null */
  intro: string | null;
  /** 简介（用户修改）。默认 null */
  customIntro: string | null;
  /** 自定义字符集名称（**仅本地书籍**）。默认 null */
  charset: string | null;
  /**
   * 类型位掩码，见 {@link BookType}。
   * 默认 = `BookType.text`(8)。⚠️ SQL 列默认值是 `"0"`（历史遗留，只在裸 INSERT 时生效）。
   */
  type: number;
  /**
   * 分组位掩码。默认 `0`。
   *
   * ⚠️ `Book.kt:76-78` 的注释写「自定义分组索引号」，但 **DAO 实际按位掩码查询**：
   * `SELECT * FROM books WHERE (\`group\` & :group) > 0`（`BookDao.kt:95,104`）。
   * 也就是说一本书**可以同时属于多个分组**，字段名照抄但语义是 bitmask。
   */
  group: number;
  /** 最新章节标题。默认 null */
  latestChapterTitle: string | null;
  /** 最新章节标题更新时间（毫秒）。默认 = 当前时间 */
  latestChapterTime: number;
  /** 最近一次更新书籍信息的时间（毫秒）。默认 = 当前时间 */
  lastCheckTime: number;
  /** 最近一次发现新章节的数量。默认 0 */
  lastCheckCount: number;
  /** 书籍目录总数。默认 0 */
  totalChapterNum: number;
  /** 当前章节名称。默认 null */
  durChapterTitle: string | null;
  /** 当前章节索引。默认 0 */
  durChapterIndex: number;
  /** 当前卷索引。默认 0 */
  durVolumeIndex: number;
  /** 相对于卷的索引。默认 0 */
  chapterInVolumeIndex: number;
  /** 当前阅读进度（**首行字符索引位置**）。默认 0 */
  durChapterPos: number;
  /** 最近一次阅读时间（毫秒，打开正文时写）。默认 = 当前时间 */
  durChapterTime: number;
  /** 字数。默认 null。⚠️ **是 String 不是 number**（Legado 原样存站点文本，如「12万字」） */
  wordCount: string | null;
  /** 刷新书架时是否更新书籍信息。默认 true */
  canUpdate: boolean;
  /** 手动排序。默认 0 */
  order: number;
  /** 书源排序。默认 0 */
  originOrder: number;
  /** 书籍变量（JSON 字符串，供书源规则检索）。默认 null */
  variable: string | null;
  /** 每本书的阅读设置。默认 null（读时惰性初始化为 {@link emptyBookReadConfig}） */
  readConfig: BookReadConfig | null;
  /** 同步时间（毫秒）。默认 0 */
  syncTime: number;
  /** 保存到本地的网络封面。默认 null。展示优先级：persistedCoverUrl > customCoverUrl > coverUrl */
  persistedCoverUrl: string | null;
  /**
   * ⚠️ **本仓扩展字段（Legado 没有）** —— 存引擎的 `payload`（JSON 字符串，默认 null）。
   *
   * 为什么必须存：`payload` 是引擎「传给下一阶段的最小上下文」（契约 `types.ts:102-107`，
   * 例如书籍详情页 URL、MacCMS 的 `vod_id`），前端**必须原样回传**才能定位同一本书。
   * 它与 `variable` 不同：`variable` 是**给源规则的**命名空间（按书），`payload` 是**引擎私有**的。
   * 而它**无法重建**：不是 URL 的简单派生（影视源是 `vodId`、有的源是整段 JSON），
   * 重建要再发一次 search（慢 + 站点可能已变 + 得恰好命中同一本），章节 payload 更是只在 toc 那一刻存在。
   *
   * 用户 2026-09-25 决策：**在 `ShelfBook` 上加一个显式标注为本仓扩展的字段**（而非借用 `variable`
   * —— 那会撞源脚本命名空间：语料 10 个源在用 `book.getVariable()`；也不放 KV —— 那是"必需数据进缓存表"）。
   */
  payload: string | null;
  /**
   * ⚠️⚠️ **本仓扩展字段（Legado 没有）** —— 这本书的**阅读样式覆盖**（`#164`）。
   * 默认 `null` = **不覆盖，完全跟随全局默认**（{@link GlobalReaderPrefs}）。
   *
   * ## 为什么是扩展字段（**用户 2026-09-30 已拍板**）
   * 上游的阅读样式**是全局的**，逐条核实过：
   *  · `ReadBookConfig.configList`（6 套命名样式）+ `styleSelect` 都是**全局偏好**；
   *  · `ReadBookConfig.kt:434` `val config get() = if (shareLayout) shareConfig else durConfig`
   *    —— **两条分支取的都是全局对象**；
   *  · `Book.ReadConfig`（**19 字段**）里**没有**字号 / 字距 / 行距 / 颜色。
   *  ⇒ 「每本书独立排版」在上游**没有对应实体**。用户明确授权「有必要可增加」⇒ 以**显式标注的扩展字段**落地。
   *
   * ## 为什么不复用 `readConfig` 列
   * 上游 `Book.readConfig`（{@link BookReadConfig}）的语义是「**这本书用哪一套命名样式**」（引用），
   * 不是「样式本身」（值）。往里塞值就是**语义撞车 + 造第二份真相源**。
   *
   * ## 合并规则（**唯一实现在 {@link mergeReadStyle}**）
   * 生效样式 = `全局默认 ⊕ readStyle`（**逐键覆盖**，`null`/`undefined` 的键**不覆盖**）。
   * 消费点：`apps/web/src/styles/reader-style.ts` 与 `apps/web/src/stores/reader.ts` 的
   * `effectiveReadStyle` —— **别在别处再写一份合并**。
   */
  readStyle: ReadStyleOverride | null;
  /**
   * ⚠️⚠️ **本仓扩展字段（Legado 没有）** —— 影视**播放进度**（秒）（`#141`）。
   *
   * 对齐本地 UI 的 `progressSec`/`durationSec`（OmniFlow 语义，`apps/web/src/stores/reader.ts`）。
   * 为什么放 `ShelfBook` 而不是独立的「观看历史」实体：**一部剧一行**（D1-B，按 Legado
   * `books` + `BookType.notShelf` 位）—— 收藏的剧与「看过但没收藏」的剧共用同一个主键
   * （`bookUrl` = `itemKey`），进度/最后观看的集都写在行内；**两套集合硬接会「同一部剧
   * 两行同主键、两个 plan 互相删」**（`#141` 登记时记下的重启前提）。
   *
   * 只对 `type & BookType.video` 的行有意义；文本书恒为 null/缺省。
   * 前端由播放器节流上报（`PlayerOverlay` → `recordProgress`）。
   */
  progressSec?: number;
  /** ⚠️⚠️ **本仓扩展字段**（同 {@link ShelfBook.progressSec}）—— 该集的**总时长**（秒）。 */
  durationSec?: number;
}

/**
 * 书架/观影历史的**删除墓碑**（跨端一致删除的权威凭据）。
 *
 * ## 为什么放在契约层
 * 前端（`apps/web`）只需要这个**形状**来过滤本地陈旧副本，而 `user-store/types.ts` 连着
 * `node:sqlite` 的运行时依赖 —— 前端只能 import `@yuedu/core/contract`。
 *
 * ## 语义（删除优先 / LWW）
 * 一端删除后，服务端留下一枚 `(bookUrl, deletedAt)`。另一端启动同步时：
 *  · 本地/远端条目若 `durChapterTime < deletedAt` ⇒ 视为**陈旧副本**，删掉且不再上传；
 *  · 若条目的 `durChapterTime >= deletedAt` ⇒ 用户确实在删除之后重新加入/重新播放，墓碑失效。
 * 「服务端没有这条」不能表达「这条被删了」（没推过的新行也是「没有」），所以必须显式记墓碑。
 */
export interface BookTombstone {
  /** 已删除书的契约主键（`ShelfBook.bookUrl`，即前端 `encodeItemKey(key)` 后的形态） */
  bookUrl: string;
  /** 删除时刻（毫秒，服务端时钟） */
  deletedAt: number;
}

/** `Book.ReadConfig` 的默认值（`Book.get() config` 惰性初始化时用 `ReadConfig(useGlobalAudioSkip = true)`，`Book.kt:198-204`） */
export function emptyBookReadConfig(): BookReadConfig {
  return {
    reverseToc: false,
    tocExpanded: true,
    pageAnim: null,
    reSegment: false,
    imageStyle: null,
    useReplaceRule: null,
    delTag: 0,
    ttsEngine: null,
    splitLongChapter: true,
    readSimulating: false,
    startDate: null,
    startChapter: null,
    dailyChapters: 3,
    openCredits: 0,
    closeCredits: 0,
    playMode: 0,
    playSpeed: 1.0,
    useGlobalAudioSkip: false,
    manualReplaceRuleIds: [],
  };
}

/**
 * 新建 `ShelfBook` 的默认值工厂。
 *
 * ⚠️ **不要用对象字面量手写**，否则默认值会在多处漂移。新增字段时只改这里。
 * 三个时间字段（`latestChapterTime`/`lastCheckTime`/`durChapterTime`）Legado 默认取当前时间，
 * 因此这里用参数注入 `now` 以便测试可确定化。
 */
export function emptyShelfBook(now: number = Date.now()): ShelfBook {
  return {
    bookUrl: '',
    tocUrl: '',
    origin: LOCAL_TAG,
    originName: '',
    name: '',
    author: '',
    kind: null,
    customTag: null,
    coverUrl: null,
    customCoverUrl: null,
    intro: null,
    customIntro: null,
    charset: null,
    type: BookType.text,
    group: 0,
    latestChapterTitle: null,
    latestChapterTime: now,
    lastCheckTime: now,
    lastCheckCount: 0,
    totalChapterNum: 0,
    durChapterTitle: null,
    durChapterIndex: 0,
    durVolumeIndex: 0,
    chapterInVolumeIndex: 0,
    durChapterPos: 0,
    durChapterTime: now,
    wordCount: null,
    canUpdate: true,
    order: 0,
    originOrder: 0,
    variable: null,
    readConfig: null,
    syncTime: 0,
    persistedCoverUrl: null,
    payload: null,
    readStyle: null, // 本仓扩展字段（`#164`）：默认不覆盖，跟随全局
  };
}

/** 封面展示优先级（`Book.getDisplayCover()`，`Book.kt:174-176`） */
export function displayCover(b: Pick<ShelfBook, 'persistedCoverUrl' | 'customCoverUrl' | 'coverUrl'>): string | null {
  if (b.persistedCoverUrl) return b.persistedCoverUrl;
  if (b.customCoverUrl) return b.customCoverUrl;
  return b.coverUrl;
}

/** 简介展示优先级（`Book.getDisplayIntro()`，`Book.kt:185`） */
export function displayIntro(b: Pick<ShelfBook, 'customIntro' | 'intro'>): string | null {
  return b.customIntro && b.customIntro.length > 0 ? b.customIntro : b.intro;
}

/** 未读章节数（`Book.getUnreadChapterNum()`，`Book.kt:172`；简化掉 Legado 的「阅读模拟」分支） */
export function unreadChapterNum(b: Pick<ShelfBook, 'totalChapterNum' | 'durChapterIndex'>): number {
  return Math.max(b.totalChapterNum - b.durChapterIndex - 1, 0);
}

/** 类型判定（`BookType` 位掩码） */
export function isBookType(type: number, flag: number): boolean {
  return (type & flag) > 0;
}

/**
 * 阅读进度的**派生视图**（对应 `BookProgress.kt`）。
 *
 * ⚠️ 这不是一张表 —— Legado 的 `BookProgress` 就是个 `data class`，由 `Book` 组装
 * （`BookProgress.kt:12-19`），用于同步/展示。存储仍在 {@link ShelfBook} 行内。
 */
export interface ReadProgress {
  name: string;
  author: string;
  durChapterIndex: number;
  durChapterPos: number;
  durChapterTime: number;
  durChapterTitle: string | null;
}

/** 从书架条目取进度视图（`BookProgress(book)`） */
export function toReadProgress(b: ShelfBook): ReadProgress {
  return {
    name: b.name,
    author: b.author,
    durChapterIndex: b.durChapterIndex,
    durChapterPos: b.durChapterPos,
    durChapterTime: b.durChapterTime,
    durChapterTitle: b.durChapterTitle,
  };
}

/* ------------------------------------------------------------------ *
 * 三、目录（对应 `BookChapter`，表 chapters）     [P1]
 * ------------------------------------------------------------------ */

/**
 * 章节（目录项）。`BookChapter.kt:42-60`，**17 个字段**。
 *
 * ## 表约束（照抄 `BookChapter.kt:29-41`）
 * - 复合主键 `(url, bookUrl)`
 * - 索引 `bookUrl`（非唯一）+ `(bookUrl, index)`（**唯一**）
 * - 外键 `bookUrl → books.bookUrl` **ON DELETE CASCADE** → **删书自动删目录**
 * - ⚠️ **表内不含正文**（正文是文件，见路线图 §5.1）
 *
 * `equals`/`hashCode` 只比较 `url`（`BookChapter.kt:111-118`）。
 */
export interface ShelfChapter {
  /** 章节地址。主键之一。默认 `""` */
  url: string;
  /** 章节标题。默认 `""` */
  title: string;
  /** 是否是卷名（卷没有正文页，阅读器要跳过）。默认 false */
  isVolume: boolean;
  /** 用来拼接相对 URL 的基准。默认 `""` */
  baseUrl: string;
  /** 书籍地址。主键之一，外键。默认 `""` */
  bookUrl: string;
  /** 章节序号（`(bookUrl, index)` 唯一）。默认 0 */
  index: number;
  /** 是否 VIP。默认 false */
  isVip: boolean;
  /** 是否已购买。默认 false */
  isPay: boolean;
  /** 音频真实 URL。默认 null */
  resourceUrl: string | null;
  /** 更新时间或其他章节附加信息。默认 null */
  tag: string | null;
  /** 本章节字数。默认 null。⚠️ **String** */
  wordCount: string | null;
  /** 章节起始位置（本地书）。默认 null */
  start: number | null;
  /** 章节终止位置（本地书）。默认 null */
  end: number | null;
  /** EPUB 当前章节的 fragmentId。默认 null */
  startFragmentId: string | null;
  /** EPUB 下一章节的 fragmentId。默认 null */
  endFragmentId: string | null;
  /** 章节变量（JSON 字符串）。默认 null */
  variable: string | null;
  /** 标题段评图或视频封面。默认 null */
  imgUrl: string | null;
}

/** `ShelfChapter` 默认值工厂（避免字面量散落） */
export function emptyShelfChapter(bookUrl = '', index = 0): ShelfChapter {
  return {
    url: '',
    title: '',
    isVolume: false,
    baseUrl: '',
    bookUrl,
    index,
    isVip: false,
    isPay: false,
    resourceUrl: null,
    tag: null,
    wordCount: null,
    start: null,
    end: null,
    startFragmentId: null,
    endFragmentId: null,
    variable: null,
    imgUrl: null,
  };
}

/* ------------------------------------------------------------------ *
 * 四、书签（对应 `Bookmark`，表 bookmarks）       [P2]
 * ------------------------------------------------------------------ */

/**
 * 书签。`Bookmark.kt:14-24`，**8 个字段**。
 *
 * ⚠️ 身份是 `(bookName, bookAuthor)` 组合（索引，非唯一）+ `time` 主键 —— 不是 `bookUrl`。
 * 所以书签**不随换源迁移**（Legado 原样如此）。
 */
export interface Bookmark {
  /** 创建时间（毫秒）。**主键**。默认 = 当前时间 */
  time: number;
  /** 书名。默认 `""` */
  bookName: string;
  /** 作者。默认 `""` */
  bookAuthor: string;
  /** 章节索引。默认 0 */
  chapterIndex: number;
  /** 章内位置。默认 0 */
  chapterPos: number;
  /** 章节名。默认 `""` */
  chapterName: string;
  /** 所在段落文本。默认 `""` */
  bookText: string;
  /** 用户备注。默认 `""` */
  content: string;
}

/* ------------------------------------------------------------------ *
 * 五、高亮/笔记（对应 `BookHighlight`，表 highlights）  [P2]
 * ------------------------------------------------------------------ */

/**
 * 高亮（划线）与笔记。`BookHighlight.kt:20-38`，**13 个字段**。
 *
 * 与书签的差别：书签是「点」，高亮是「一段区间」+ 样式 + 笔记，且**带 `bookUrl`/`chapterUrl`**
 * （所以能跟着换源走）。
 */
export interface BookHighlight {
  /** 创建时间（毫秒）。**主键**。默认 = 当前时间 */
  time: number;
  /** 书籍地址。默认 `""` */
  bookUrl: string;
  /** 章节地址。默认 `""` */
  chapterUrl: string;
  /** 书名。默认 `""` */
  bookName: string;
  /** 作者。默认 `""` */
  bookAuthor: string;
  /** 章节索引。默认 0 */
  chapterIndex: number;
  /** 选区起点。默认 0 */
  chapterPos: number;
  /** 选区终点。默认 0 */
  chapterPosEnd: number;
  /**
   * 布局期标题长度，用于把「含标题的偏移」换算成「不含标题的正文偏移」。
   * 默认 `-1`（{@link UNKNOWN_TITLE_LENGTH} = 未知），见 `BookHighlight.bodyStart/bodyEnd`。
   */
  layoutTitleLength: number;
  /** 章节名。默认 `""` */
  chapterName: string;
  /** 选中的正文文本。默认 `""` */
  bookText: string;
  /** 样式（**JSON 字符串**，`HighlightStyle`）。默认 `""` */
  style: string;
  /** 笔记内容。默认 `""` */
  note: string;
}

/**
 * 书内备注（Legado `BookMemo`，`bookMemo.json`）。
 *
 * 与书签/划线的区别：备注是**用户自己写的一段文字**，可以脱离正文（`bookText` 可空），
 * 是「书评 / 摘抄本」的载体。主键 `time`（毫秒）。
 *
 * `bookUrl` 是本仓扩展字段（Legado 实体没有）：用来把备注稳定挂到某本书上；
 * 导出 Legado 格式时**不写**该字段（Gson 会忽略多余字段，反向也不读）。
 */
export interface BookMemo {
  /** 创建时间（毫秒）。**主键**。默认 = 当前时间 */
  time: number;
  /** 书籍地址（本仓扩展；Legado 没有该字段，跨端时按书名+作者认领） */
  bookUrl: string;
  /** 书名。默认 `""` */
  bookName: string;
  /** 作者。默认 `""` */
  bookAuthor: string;
  /** 章节索引。默认 0 */
  chapterIndex: number;
  /** 章内位置。默认 0 */
  chapterPos: number;
  /** 章节名。默认 `""` */
  chapterName: string;
  /** 摘录的正文（可空）。默认 `""` */
  bookText: string;
  /** 备注标题。默认 `""` */
  title: string;
  /** 备注正文。默认 `""` */
  content: string;
}

/**
 * 搜索历史（Legado `SearchKeyword`，`searchHistory.json`）。
 *
 * 主键 `word`；`usage` 是使用次数，用于排序（上游按 `lastUseTime` 倒序，次数只做展示）。
 */
export interface SearchHistoryEntry {
  /** 搜索词。**主键** */
  word: string;
  /** 最近使用时间（毫秒）。默认 = 当前时间 */
  lastUseTime: number;
  /** 使用次数。默认 1 */
  usage: number;
}

/** `layoutTitleLength` 的「未知」哨兵值（`BookHighlight.kt:81-83`） */
export const UNKNOWN_TITLE_LENGTH = -1;

/** 把「含标题的布局偏移」换算为「正文偏移」（`BookHighlight.bodyPosition`，`BookHighlight.kt:76-79`） */
export function highlightBodyPos(layoutPos: number, layoutTitleLength: number, currentTitleLength: number): number {
  const len = layoutTitleLength >= 0 ? layoutTitleLength : Math.max(currentTitleLength, 0);
  return Math.max(layoutPos - len, 0);
}

/* ------------------------------------------------------------------ *
 * 五-B、高亮规则（对应 `HighlightRule`，表 highlightRules）  [`#262`]
 * ------------------------------------------------------------------ */

/**
 * 高亮规则：**按 `pattern` 自动高亮**命中的文字（不需要用户划选）。
 *
 * `HighlightRule.kt:23-41`，**12 个字段**，逐条对齐上游（含默认值）。
 * 渲染期匹配语义见 `HighlightRuleMatcher.kt`（本仓移植实现在本仓 core 的
 * `highlight-rule-matcher.ts`，差异已在该文件头注释说明）。
 *
 * ★ 与手工高亮（{@link BookHighlight}）的关系：规则命中**不落 highlights 表**、
 *   不可点动作栏 —— 它是「书一打开就自动亮」的展示层，管理在规则列表里。
 */
export interface HighlightRule {
  /** 主键（自增）。默认 0 = 新建（服务端/存储分配） */
  id: number;
  /**
   * 稳定标识（UUID）。**导入合并的判据**（上游 DAO `mergeImportedHighlightRules` 按
   * `uuid.lowercase()` 对齐，`id` 不参与）。默认 = 随机 UUID。
   */
  uuid: string;
  /** 规则名（展示用，可空 —— 空时列表显示 pattern，`getDisplayName()`）。默认 `""` */
  name: string;
  /** 匹配内容：`isRegex=false` 是字面量（`indexOf`），`true` 是正则。默认 `""` */
  pattern: string;
  /** pattern 是否按正则解释。默认 false */
  isRegex: boolean;
  /**
   * 生效范围：**字符串包含筛选** —— 空（或 null）= 全书全局；
   * 非空时仅当 `scope` 包含书名**或**源 URL（`origin`）才对这本书生效
   * （上游 DAO `findEnabledByBook`：`instr(scope, :name) > 0 OR instr(scope, :origin) > 0`）。
   * 默认 null。
   */
  scope: string | null;
  /** 是否启用。默认 true */
  isEnabled: boolean;
  /** 样式（**JSON 字符串**，`HighlightStyle`）。默认 `""`（= 按默认样式渲染） */
  style: string;
  /**
   * 排序号（小在前）。上游列名 `sortOrder`（`@ColumnInfo(name = "sortOrder")`）、字段名 `order`，
   * **默认 `Int.MIN_VALUE` = -2147483648**（保存时若有此哨兵值则取 `maxOrder + 1`，见编辑对话框 `save()`）。
   */
  order: number;
  /** 正则匹配超时（毫秒）。默认 3000（`DEFAULT_TIMEOUT_MILLISECONDS`） */
  timeoutMillisecond: number;
  /** 是否作用于章节标题。默认 false */
  applyToTitle: boolean;
  /** 是否作用于正文。默认 true */
  applyToBody: boolean;
}

/** 上游 `HighlightRule.DEFAULT_TIMEOUT_MILLISECONDS`（`HighlightRule.kt:98`） */
export const HIGHLIGHT_RULE_DEFAULT_TIMEOUT = 3000;

/** 上游 `HighlightRule` 的 `order` 哨兵（`Int.MIN_VALUE`）：保存时换成 `maxOrder + 1` */
export const HIGHLIGHT_RULE_ORDER_NEW = -2147483648;

/** 生成一个 UUID v4（合并/导入兜底用；Node 22 与浏览器都有 `crypto.randomUUID`） */
export function newHighlightRuleUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 极老环境兜底：凑一个 v4 形状的随机串（只要求唯一性，不要求密码学强度）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 新建一条规则的默认值（对齐上游各字段默认 + 空样式） */
export function emptyHighlightRule(id = 0): HighlightRule {
  return {
    id,
    uuid: newHighlightRuleUuid(),
    name: '',
    pattern: '',
    isRegex: false,
    scope: null,
    isEnabled: true,
    style: '',
    order: HIGHLIGHT_RULE_ORDER_NEW,
    timeoutMillisecond: HIGHLIGHT_RULE_DEFAULT_TIMEOUT,
    applyToTitle: false,
    applyToBody: true,
  };
}

/**
 * 规则是否可用（`HighlightRule.isValid()`，`HighlightRule.kt:69-78`）：
 * pattern 非空；正则时必须能编译。
 *
 * ⚠️ 本仓用 **JS `RegExp`** 编译校验（上游是 Java `Pattern`），两者语法有差异
 * （如命名组 `(?<name>…)`、`\\p{…}` 的可用性随 flag 而定）；这里只做「能不能编译」的
 * 同构校验，不做逐语法翻译。
 */
export function highlightRuleIsValid(r: Pick<HighlightRule, 'pattern' | 'isRegex'>): boolean {
  if (!r.pattern) return false;
  if (!r.isRegex) return true;
  try {
    new RegExp(r.pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * 恢复/导入前的规范化（`normalizeForRestore()`，`HighlightRule.kt:81-95`）：
 * uuid 非法则重生成；style 空则补默认（空 JSON —— 渲染层按默认样式画）；
 * 超时 <=0 回默认。
 */
export function normalizeHighlightRuleForRestore(r: HighlightRule): HighlightRule {
  const uuid = typeof r.uuid === 'string' ? r.uuid.trim() : '';
  r.uuid = /^[0-9a-fA-F-]{36}$/.test(uuid) ? uuid.toLowerCase() : newHighlightRuleUuid();
  r.name = typeof r.name === 'string' ? r.name : '';
  r.pattern = typeof r.pattern === 'string' ? r.pattern : '';
  r.style = typeof r.style === 'string' ? r.style : '';
  if (!r.style.trim()) r.style = '';
  if (!(r.timeoutMillisecond > 0)) r.timeoutMillisecond = HIGHLIGHT_RULE_DEFAULT_TIMEOUT;
  return r;
}

/**
 * 规则对某本书是否生效（上游 DAO `findEnabledByBook` 的 WHERE 子句，`HighlightRuleDao.kt:26-33`）：
 * `isEnabled` 且（scope 空，或 scope 包含书名，或 scope 包含源 URL —— **子串包含**）。
 * ★ 上游在 SQL 里做，本仓规则量小（几十条）⇒ 渲染侧拿全量后用本函数过滤。
 */
export function highlightRuleAppliesToBook(
  r: Pick<HighlightRule, 'isEnabled' | 'scope'>,
  bookName: string,
  origin: string,
): boolean {
  if (!r.isEnabled) return false;
  const scope = (r.scope ?? '').trim();
  if (!scope) return true;
  return (!!bookName && scope.includes(bookName)) || (!!origin && scope.includes(origin));
}

/** 上游 `HighlightRuleFile.TYPE`（`HighlightRule.kt:107`）：导入文件的 `type` 字段必须等于它 */
export const HIGHLIGHT_RULE_FILE_TYPE = 'highlightRule';

/** 导入文件形状（`HighlightRuleFile`，`HighlightRule.kt:102-109`） */
export interface HighlightRuleFile {
  type: string | null;
  rules: Array<HighlightRule | null> | null;
}

/** 一条导入项的判定（对齐上游 `HighlightRuleImportStatus`） */
export type HighlightRuleImportStatus = 'new' | 'update' | 'existing';

/** 导入预览的一行：解析后的规则 + 与本地库比对的判定 */
export interface HighlightRuleImportItem {
  rule: HighlightRule;
  status: HighlightRuleImportStatus;
}

/** `parseHighlightRuleImport` 的结果：成功带 items，失败带 error（不抛异常，调用方直接展示） */
export interface HighlightRuleImportParse {
  ok: boolean;
  items: HighlightRuleImportItem[];
  error?: string;
}

/**
 * 解析高亮规则导入文件并给出**导入预览统计**（对齐 `ImportHighlightRuleViewModel`：
 * `parseHighlightRuleFile` 严格校验 + `compareImportedHighlightRules` 三态判定）。
 *
 * ## 严格校验（照抄上游 `:25-57`，逐字段类型检查）
 * - 根对象 `type === 'highlightRule'` 且 `rules` 是数组；
 * - 每条 `uuid` 必须是合法 UUID（大小写不敏感，批内不得重复）；
 * - `name`/`pattern`/`style` 若出现必须是字符串；`scope` 可为 null/字符串；
 * - `isRegex`/`isEnabled`/`applyToTitle`/`applyToBody` 若出现必须是布尔；
 * - `id`/`timeoutMillisecond` 若出现必须是整数；`order` 若出现必须是整数；
 * - 规范化后 `isValid()` 必须为真（pattern 非空、正则可编译）。
 *
 * ## 三态判定（`compareImportedHighlightRules`，`:82-99`）
 * 按本地库 `uuid.lowercase()` 对齐：本地没有 = `new`；有且**内容完全一致**（忽略 id/order）=
 * `existing`；有但内容不同 = `update`。
 */
export function parseHighlightRuleImport(
  input: string | unknown,
  local: readonly HighlightRule[] = [],
): HighlightRuleImportParse {
  const fail = (error: string): HighlightRuleImportParse => ({ ok: false, items: [], error });
  let root: unknown;
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input);
    } catch {
      return fail('不是合法的 JSON');
    }
  } else {
    root = input;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return fail('根节点不是 JSON 对象');
  const obj = root as Record<string, unknown>;
  if (obj['type'] !== HIGHLIGHT_RULE_FILE_TYPE) {
    return fail(`type 必须是 "${HIGHLIGHT_RULE_FILE_TYPE}"（收到：${JSON.stringify(obj['type']) ?? '无'}）`);
  }
  const rawRules = obj['rules'];
  if (!Array.isArray(rawRules)) return fail('缺少 rules 数组');
  const seenUuids = new Set<string>();
  const rules: HighlightRule[] = [];
  for (let i = 0; i < rawRules.length; i += 1) {
    const el = rawRules[i];
    if (!el || typeof el !== 'object' || Array.isArray(el)) return fail(`第 ${i + 1} 条不是对象`);
    const o = el as Record<string, unknown>;
    const rawUuid = typeof o['uuid'] === 'string' ? o['uuid'] : '';
    if (!/^[0-9a-fA-F-]{36}$/.test(rawUuid)) return fail(`第 ${i + 1} 条 uuid 缺失或不是合法 UUID`);
    const uuid = rawUuid.toLowerCase();
    if (seenUuids.has(uuid)) return fail(`第 ${i + 1} 条 uuid 重复：${rawUuid}`);
    seenUuids.add(uuid);
    for (const f of ['name', 'pattern', 'style'] as const) {
      const v = o[f];
      if (v !== undefined && v !== null && typeof v !== 'string') return fail(`第 ${i + 1} 条 ${f} 必须是字符串`);
    }
    const scope = o['scope'];
    if (scope !== undefined && scope !== null && typeof scope !== 'string') {
      return fail(`第 ${i + 1} 条 scope 必须是字符串或 null`);
    }
    for (const f of ['isRegex', 'isEnabled', 'applyToTitle', 'applyToBody'] as const) {
      const v = o[f];
      if (v !== undefined && v !== null && typeof v !== 'boolean') return fail(`第 ${i + 1} 条 ${f} 必须是布尔`);
    }
    for (const f of ['id', 'timeoutMillisecond', 'order'] as const) {
      const v = o[f];
      if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isInteger(v))) {
        return fail(`第 ${i + 1} 条 ${f} 必须是整数`);
      }
    }
    const rule = normalizeHighlightRuleForRestore({
      ...emptyHighlightRule(typeof o['id'] === 'number' ? o['id'] : 0),
      uuid: rawUuid,
      name: typeof o['name'] === 'string' ? o['name'] : '',
      pattern: typeof o['pattern'] === 'string' ? o['pattern'] : '',
      isRegex: o['isRegex'] === true,
      scope: typeof o['scope'] === 'string' && o['scope'].trim() ? o['scope'] : null,
      isEnabled: o['isEnabled'] !== false,
      style: typeof o['style'] === 'string' ? o['style'] : '',
      order: typeof o['order'] === 'number' ? o['order'] : HIGHLIGHT_RULE_ORDER_NEW,
      timeoutMillisecond: typeof o['timeoutMillisecond'] === 'number' ? o['timeoutMillisecond'] : HIGHLIGHT_RULE_DEFAULT_TIMEOUT,
      applyToTitle: o['applyToTitle'] === true,
      applyToBody: o['applyToBody'] !== false,
    });
    if (!highlightRuleIsValid(rule)) return fail(`第 ${i + 1} 条不可用（pattern 为空或正则无法编译）`);
    rules.push(rule);
  }
  const localByUuid = new Map(local.map((r) => [r.uuid.toLowerCase(), r]));
  const items = rules.map((rule): HighlightRuleImportItem => {
    const existing = localByUuid.get(rule.uuid.toLowerCase());
    const status: HighlightRuleImportStatus =
      existing == null
        ? 'new'
        : highlightRuleContentEquals(existing, rule)
          ? 'existing'
          : 'update';
    return { rule, status };
  });
  return { ok: true, items };
}

/** 导入比对用的内容相等（对齐上游：去掉 id 与 order 后逐字段比对） */
export function highlightRuleContentEquals(a: HighlightRule, b: HighlightRule): boolean {
  const strip = (r: HighlightRule) =>
    JSON.stringify({ ...r, id: 0, order: 0, uuid: r.uuid.toLowerCase() });
  return strip(a) === strip(b);
}

/**
 * 把导入的规则合并进现有库（对齐 DAO `mergeImportedHighlightRules`，`HighlightRuleDao.kt:90-105`）：
 * 按 `uuid.lowercase()` 对齐 —— 本地有的**覆盖更新**（沿用本地 id），没有的新增；
 * 合并结果 **order 重新编号 0..n-1**（全量重排，导入顺序在前的新）。
 */
export function mergeImportedHighlightRules(
  current: readonly HighlightRule[],
  imported: readonly HighlightRule[],
): HighlightRule[] {
  const importedByUuid = new Map(imported.map((r) => [r.uuid.toLowerCase(), r]));
  const currentUuids = new Set(current.map((r) => r.uuid.toLowerCase()));
  const existing = current.map((local) => {
    const inc = importedByUuid.get(local.uuid.toLowerCase());
    return inc ? { ...inc, id: local.id } : { ...local };
  });
  const added = imported.filter((r) => !currentUuids.has(r.uuid.toLowerCase())).map((r) => ({ ...r, id: 0 }));
  return [...existing, ...added].map((r, index) => ({ ...r, order: index }));
}

/* ------------------------------------------------------------------ *
 * 六、净化/替换规则（对应 `ReplaceRule`，表 replace_rules）  [P2]
 * ------------------------------------------------------------------ */

/**
 * 净化（替换）规则。`ReplaceRule.kt:26-65`，**14 个字段**。
 *
 * 作用：正文/标题的文本替换，也用于「字体反爬」之外的通用清洗。
 * `pattern` 与 `replacement` 支持 Legado 规则语法（`{{}}`、`{{$.x}}` 等，求值上下文见 `replaceBook`/章节）。
 */
/**
 * **字典规则**（`#189`，本仓自有实体——Legado 的字典是 `DictRule` 表但字段不同，
 * 这里移植的是**本仓前端已用了一年的形态**，不照抄上游）。
 *
 * ⚠️ 为什么现在才上服务端：此前只存 `localStorage`（`apps/web/src/stores/dict.ts`），
 *   而 `localhost:5173`（vite dev）与 `127.0.0.1:3000` 是**两个 origin** ⇒ localStorage
 *   互不相通 ⇒ 用户看到「3000 有字典、5173 没有」。上服务端后两处同源同数据。
 */
export interface DictRule {
  /** 主键 = 字典名（与 Legado `ReplaceRule` 不同，本仓沿用 `name` 作主键，见 store 的 upsertRule） */
  name: string;
  /** 查词 URL 规则，`{{key}}` 是词条 */
  urlRule: string;
  /** 结果规则（在响应体上求值） */
  showRule: string;
  /** 是否启用 */
  enabled: boolean;
  /** 排序号（小在前；导入的规则常带 0，会与内置的撞号 ⇒ UI 排序另有兜底） */
  sortNumber: number;
}

export interface ReplaceRule {
  /** 主键（自增）。默认 = 当前时间（Legado 用时间戳兜底） */
  id: number;
  /** 名称。默认 `""` */
  name: string;
  /** 分组（逗号分隔可多组）。默认 null */
  group: string | null;
  /** 匹配内容（正则或字面量）。默认 `""` */
  pattern: string;
  /** 替换为。默认 `""` */
  replacement: string;
  /** 作用范围（书名/作者等，Legado 用字符串表达）。默认 null */
  scope: string | null;
  /** 作用于标题。默认 false */
  scopeTitle: boolean;
  /** 作用于书源。默认 false */
  scopeSource: boolean;
  /** 作用于正文。默认 **true** */
  scopeContent: boolean;
  /** 排除范围。默认 null */
  excludeScope: string | null;
  /** 是否启用。默认 **true** */
  isEnabled: boolean;
  /** 是否正则。默认 **true** */
  isRegex: boolean;
  /** 超时（毫秒）。默认 **3000**（≤0 时按 3000 处理，`ReplaceRule.getValidTimeoutMillisecond`） */
  timeoutMillisecond: number;
  /** 排序。默认 `Int.MIN_VALUE`（`-2147483648`） */
  order: number;
}

/** 替换规则有效超时（`ReplaceRule.kt:144-149`） */
export function replaceRuleTimeout(rule: Pick<ReplaceRule, 'timeoutMillisecond'>): number {
  return rule.timeoutMillisecond <= 0 ? 3000 : rule.timeoutMillisecond;
}

/** `ReplaceRule.order` 的默认哨兵（`Int.MIN_VALUE`） */
export const REPLACE_RULE_ORDER_DEFAULT = -2147483648;

/* ------------------------------------------------------------------ *
 * 七、分组（对应 `BookGroup`，表 book_groups）     [P1]
 * ------------------------------------------------------------------ */

/**
 * 书架分组。`BookGroup.kt:15-30`，**8 个字段**。
 *
 * `groupName` 决定是否可删除：内置分组（{@link BookGroupId}）的名字由 `getManageName()` 拼装，不可改。
 */
export interface BookGroup {
  /** 分组 ID。**主键**。默认 `0b1`（=1）。内置分组见 {@link BookGroupId} */
  groupId: number;
  /** 分组名。默认 `""` */
  groupName: string;
  /** 封面。默认 null */
  cover: string | null;
  /** 排序。默认 0 */
  order: number;
  /** 是否启用刷新。默认 true */
  enableRefresh: boolean;
  /** 是否显示。默认 true */
  show: boolean;
  /** 书排序方式；`<0` 表示跟随全局 `bookshelfSort`（`getRealBookSort()`）。默认 **-1** */
  bookSort: number;
  /** 只更新已读。默认 false */
  onlyUpdateRead: boolean;
}

/* ------------------------------------------------------------------ *
 * 八、阅读记录/统计（对应 `ReadRecord`，表 readRecord）  [P1]
 * ------------------------------------------------------------------ */

/**
 * 阅读时长记录。`ReadRecord.kt:9-21`，**5 个字段**。
 *
 * 复合主键 `(deviceId, bookName)` —— ⚠️ **按书名聚合，不是 bookUrl**
 * （源码注释：`书名相同的书籍共用一条记录`，`ReadRecord.kt:12-14`）。
 * 这是与 {@link ShelfBook} 身份口径不一致的地方，移植时不要"顺手统一"。
 * 作者列被复用来存多作者集合（`ReadRecordAuthors`，前缀 `\u001Eauthors:`，分隔符 `\u001F`）。
 */
/**
 * `#201` 用户数据**导入**的逐实体统计（导出见 `GET /api/user/snapshot`）。
 *
 * 放在契约层（而不是 `user-store/import.ts`）是为了让**前端**能直接 import 类型 ——
 * `@yuedu/core/contract` 是纯类型入口，不会把 `node:sqlite` 之类的服务端依赖拖进浏览器包。
 */
export interface ImportCounts {
  /** 新增条数 */
  added: number;
  /** 改动条数（覆盖模式的冲突项 / 阅读记录的「取更大者」） */
  updated: number;
  /** 因已存在且未开覆盖而**原样保留**的条数 */
  kept: number;
  /** 无效条目（缺主键等），未写入 */
  skipped: number;
}

/** `#201` 导入结果：逐实体计数 + 偏好的处理方式 */
export interface ImportResult {
  books: ImportCounts;
  chapters: ImportCounts;
  bookmarks: ImportCounts;
  highlights: ImportCounts;
  replaceRules: ImportCounts;
  highlightRules: ImportCounts;
  dictRules: ImportCounts;
  bookGroups: ImportCounts;
  readRecords: ImportCounts;
  /** 书内备注（主键 time） */
  bookMemos: ImportCounts;
  /** 搜索历史（主键 word） */
  searchHistory: ImportCounts;
  prefs: {
    applied: boolean;
    fields: number;
    /** `overwrite` = 整片覆盖 · `fill-default` = 只填服务端仍是默认值的字段 · `none` = 快照里没有偏好 */
    policy: 'overwrite' | 'fill-default' | 'none';
  };
}

export interface ReadRecord {
  /** 设备 ID。主键之一。默认 `""` */
  deviceId: string;
  /** 书名。主键之一。默认 `""` */
  bookName: string;
  /** 作者（或作者集合的编码串）。默认 `""` */
  author: string;
  /** 累计阅读时长（毫秒）。默认 0 */
  readTime: number;
  /** 最近阅读时间（毫秒）。默认 = 当前时间 */
  lastRead: number;
}

/**
 * 阅读记录的**跨设备聚合视图**（对应 `ReadRecordShow.kt:3-12`）。
 * 由 DAO 聚合而来，不是表。
 */
export interface ReadRecordShow {
  bookName: string;
  readTime: number;
  lastRead: number;
  /** 跨设备聚合后的原始 author 值（旧记录为空串） */
  author: string;
}

/* ------------------------------------------------------------------ *
 * 八·B、阅读会话统计（P1，表 read_session / book_read_stat / user_read_stat）
 *
 * 与上面的 `read_records` **两套口径、不做合并**：`read_records` 是升级前的按书墙钟累计，
 * 冻结为「历史总额」只读展示；本组表从启用日起记录会话粒度数据。
 * 设计依据：`docs/ref/read-stats-system-feasibility-2026-11-08.md`（用户 2026-11-08 拍板 D-1~D-10）。
 * ------------------------------------------------------------------ */

/**
 * 会话模式。**切模式即拆会话**（不用布尔 `isReadAloud`）：
 * 一次连续阅读里用户可能中途切到朗读 ⇒ 半段归属不清。
 */
export type ReadSessionMode = 'visual' | 'auto' | 'listen';

/** 时段桶（本地时区）：dawn 0–6 / morning 6–12 / afternoon 12–18 / night 18–24 */
export type ReadTimeBucket = 'dawn' | 'morning' | 'afternoon' | 'night';

/**
 * 一次「连续阅读」流水。主键是**客户端 UUID** ⇒ 重放天然幂等（`INSERT OR IGNORE`）。
 *
 * - `total_ms`：会话期间前台在线的墙钟时长（可含朗读/自动滚动）；
 * - `effective_ms`：**本模式的**有效时长 —— `visual` 才是「目视有效」，
 *   `listen`/`auto` 的有效时长分别进各自聚合列，**不进** `user_read_stat.effective_ms`。
 */
export interface ReadSession {
  sessionId: string;
  deviceId: string;
  /** 一律用 `bookUrl`（`read_records` 用书名，同名书会串） */
  bookUrl: string;
  bookName: string;
  bookAuthor: string;
  chapterIndex: number;
  chapterTitle: string;
  /** epoch ms */
  startAt: number;
  /** epoch ms */
  endAt: number;
  totalMs: number;
  effectiveMs: number;
  /** P1 恒 0（本仓没有「本次读了多少字」的可靠口径，见可行性分析 §7） */
  readWords: number;
  readPageCount: number;
  mode: ReadSessionMode;
  startProgress: number;
  endProgress: number;
  /** 时区偏移（分钟，东八区 = 480）。日键/时段在服务端按它切，不按服务端本地时区 */
  tzOffsetMin: number;
  createdAt: number;
}

/** 按书聚合（增量 upsert，永久保留） */
export interface BookReadStat {
  bookUrl: string;
  bookName: string;
  author: string;
  totalMs: number;
  /** 目视有效（= `visual` 会话的 `effective_ms`） */
  effectiveMs: number;
  visualMs: number;
  listenMs: number;
  autoMs: number;
  dawnMs: number;
  morningMs: number;
  afternoonMs: number;
  nightMs: number;
  sessionCount: number;
  pageCount: number;
  wordCount: number;
  firstReadAt: number;
  lastReadAt: number;
}

/** 按日全局（日键是**用户时区**的 `YYYY-MM-DD`，永久保留） */
export interface UserReadStat {
  day: string;
  totalMs: number;
  /** 目视有效（有效日门槛读它） */
  effectiveMs: number;
  visualMs: number;
  listenMs: number;
  autoMs: number;
  dawnMs: number;
  morningMs: number;
  afternoonMs: number;
  nightMs: number;
  sessionCount: number;
  pageCount: number;
  wordCount: number;
}

/** 断点（每本书最近一次会话落在哪一章；`books` 的当前进度优先用于展示） */
export interface ReadBreakPoint {
  bookUrl: string;
  bookName: string;
  chapterIndex: number;
  chapterTitle: string;
  /** 最近一次会话的结束时间 */
  lastReadAt: number;
  /** 该书累计目视有效毫秒 */
  effectiveMs: number;
}

/** 看板快照（`GET /api/user/read-stats` 的响应体） */
export interface ReadStatsSnapshot {
  /** 按日，最老 → 最新 */
  days: UserReadStat[];
  /** 按书，`effectiveMs` 降序 */
  books: BookReadStat[];
  /** 每本书最新会话的章节（`lastReadAt` 降序，最多 20 条） */
  breakPoints: ReadBreakPoint[];
  /** 目视会话（`mode='visual'` 且 `effectiveMs>0`）的平均单次有效毫秒；无会话为 0 */
  avgVisualSessionMs: number;
  visualSessionCount: number;
  /** 旧 `read_records` 的总额（只读展示「历史总额」，与上面不做加总） */
  legacyReadMs: number;
  /** 新统计起点（最早的 `user_read_stat.day`；无数据为 `''`） */
  firstDay: string;
}

/* ------------------------------------------------------------------ *
 * 九、RSS 阅读记录（对应 `RssReadRecord`，表 rssReadRecords）  [P5]
 * ------------------------------------------------------------------ */

/**
 * RSS 文章阅读记录。`RssReadRecord.kt:9-27`，**10 个字段**。
 *
 * ⚠️ **Phase 5 才消费** —— 当前 `packages/` 下没有 rss 引擎，
 * 前端 `discovery/rss` 路由点进去是空页（见 `docs/移植路线图.md`）。此处仅占位，避免将来另起一套命名。
 */
export interface RssReadRecord {
  /** 文章链接。**主键** */
  record: string;
  /** 标题。默认 null */
  title: string | null;
  /** 阅读时间（毫秒）。默认 null */
  readTime: number | null;
  /** 是否已读。默认 true */
  read: boolean;
  /** 源（RSS 源 url）。默认 `""` */
  origin: string;
  /** 分类。默认 `""` */
  sort: string;
  /** 封面图。默认 null */
  image: string | null;
  /** 类型 0 网页 / 1 图片 / 2 视频。默认 0 */
  type: number;
  /** 阅读进度。默认 0 */
  durPos: number;
  /** 发布时间。默认 null */
  pubDate: string | null;
}

/* ------------------------------------------------------------------ *
 * 十、KV 缓存（对应 `Cache`，表 caches）          [P1]
 * ------------------------------------------------------------------ */

/**
 * 带 TTL 的键值缓存。`Cache.kt:8-13`，**3 个字段**。
 *
 * Legado 用它存：源变量、登录头、`infoMap`、段落评论、章节缓存索引等
 * （配合 `AppCacheManager` 的 50MB 内存 LRU，注释里写明是为了防 OOM）。
 * `deadline = 0` 表示**不过期**。
 */
export interface CacheEntry {
  /** 键。**主键**，有唯一索引 */
  key: string;
  /** 值。默认 null */
  value: string | null;
  /** 过期时刻（毫秒）；0 = 永不过期。默认 0 */
  deadline: number;
}

/* ------------------------------------------------------------------ *
 * 十之二、界面主题 / 封面配置（`#163`）  [P3]
 * ------------------------------------------------------------------ */

/**
 * **界面主题**（一套颜色 + 壁纸）—— 这是用户说的那个「**主题**」（设置界面里的），
 * **不是** {@link GlobalReaderPrefs.themeMode} 那个「**主题模式**」。
 *
 * ## 字段逐条照抄上游（**已逐行核实，不是推断**）
 * `ThemeConfig.Config` 主构造器 `app/src/main/java/io/legado/app/help/config/ThemeConfig.kt:492-502`
 * —— **9 个字段**，一个不多一个不少：
 * ```
 * data class Config(
 *     var themeName: String,
 *     var isNightTheme: Boolean,
 *     var primaryColor: String,
 *     var accentColor: String,
 *     var backgroundColor: String,
 *     var bottomBackground: String,
 *     var transparentNavBar: Boolean,
 *     var backgroundImgPath: String?,
 *     var backgroundImgBlur: Int
 * )
 * ```
 *
 * ## 三个最容易搞错的语义（都在上游源码里核过，别按字段名猜）
 * 1. `isNightTheme` **不是**「这套颜色深不深」的装饰标记，它是**开关**：
 *    `AppConfig.isNightTheme` 的 setter（`AppConfig.kt:171-183`）在值变化时会**回写 `themeMode`**
 *    （`true → "2"` 暗色 / `false → "1"` 亮色）；`ThemeConfig.applyConfig()`
 *    （`ThemeConfig.kt:299-300`）应用一套主题时正是这么做的。
 *    ⇒ 本仓照抄：**应用一个命名主题会同时改 `themeMode`**。
 * 2. **日 / 夜是两个独立的槽**：`ThemeConfig.getDayTheme` / `getNightTheme`
 *    （`ThemeConfig.kt:320-386`）读的是**两组完全不同的偏好**
 *    （`colorPrimary…` vs `colorPrimaryNight…`）⇒ 本仓对应
 *    {@link GlobalReaderPrefs.uiDayTheme} / {@link GlobalReaderPrefs.uiNightTheme} 两个槽。
 *    用哪一个由 `AppConfig.isNightTheme` 的 **getter** 决定（`AppConfig.kt:172-178`）：
 *    `"1"→false` / `"2"→true` / **`"3"→false`（墨水屏不算夜间）** / 其余（`"0"` 跟随系统）→ 系统日夜偏好。
 * 3. `backgroundImgPath` 既可以是**本机文件路径**也可以是 **http(s) URL**：
 *    `getBgImage()`（`ThemeConfig.kt:117-128`）先判 `path.startsWith("http")` 再下载缓存。
 *
 * ## 本仓对 Android 专属项的处置（**明确不照抄** —— 照抄就是「给了个不起作用的设置」）
 * `pref_config_theme.xml` 里另有 `launcherIcon`（换桌面图标）/ `welcomeStyle` /
 * `transparentStatusBar` / `immNavigationBar` / `barElevation` / `fontScale` /
 * `bottomBarSkin` / `wallpaperColorFollow`（壁纸取色）+ `wallpaperColorAutoUpdate`
 * —— 浏览器里**都没有对应能力**，一律不移植（`#163` 范围里已写明）。
 *
 * ## 颜色格式（**有一个坑**）
 * 上游 `Config()` 的 Kotlin 默认值是 **6 位 hex**（如 `#EEEEEE`），但从**保存过的**主题读回来时
 * `applyConfig` 写的是 `"#${color.hexString}"` —— Android 的 `Color.hexString` 是 **ARGB 8 位**
 * （前两位是 alpha）。已有的 `readConfig.json` 里就能看到 `#ffc0edc6` 这种。
 * ⇒ 消费时必须**先剥 alpha 再交给 CSS**（见 `apps/web/src/styles/ui-theme.ts` 的 `parseHex`）。
 */
export interface UiThemeConfig {
  /** 主题名。上游同名即覆盖（`ThemeConfig.addConfig`，`ThemeConfig.kt:171-187`） */
  themeName: string;
  /** 是否夜间主题。⚠️ **是开关**：应用它会回写 `themeMode`（见接口注释第 1 条） */
  isNightTheme: boolean;
  /** 主色。上游默认 `@color/md_brown_500` = `#795548` */
  primaryColor: string;
  /** 强调色。上游默认 `@color/md_red_600` = `#E53935` */
  accentColor: string;
  /** 界面背景色。上游默认 `@color/md_grey_100` = `#F5F5F5`（夜间 `md_grey_900` = `#212121`） */
  backgroundColor: string;
  /** 底栏背景色。上游默认 `@color/md_grey_200` = `#EEEEEE`（夜间 `md_grey_850`）。
   *  ⚠️ Web 没有「底栏」，映射到**侧栏 + 顶栏**的背景（见 `apps/web/src/styles/ui-theme.ts`）。 */
  bottomBackground: string;
  /** 底栏沉浸（透明）。⚠️ Web 映射：侧栏/顶栏**不铺自己的背景色**，让壁纸透上来 */
  transparentNavBar: boolean;
  /** 背景图。本机路径或 http(s) URL；`null` = 不用背景图 */
  backgroundImgPath: string | null;
  /** 背景图模糊半径（px 语义）。上游 `PreferKey.bgImageBlurring`，默认 0 = 不模糊 */
  backgroundImgBlur: number;
}

/**
 * 内置命名主题。前 4 条**逐字照抄**上游
 * `app/src/main/assets/defaultData/themeConfig.json`（**值、顺序、名字都不改**）：
 * `默认` / `典雅蓝` / `黑白` / `A屏黑`。
 *
 * ⚠️ 那份 JSON 每条**只有 6 个键**（没有 `transparentNavBar` / `backgroundImgPath` /
 * `backgroundImgBlur`）⇒ GSON 反序列化时这三项取 Kotlin 零值（`false` / `null` / `0`）。
 * 这里**显式补齐**，别误以为「文件里有这几项」。
 *
 * ★ 第 1 条 `深色（本仓）` 是**本仓自有**（用户 2026-09-30 授权「有必要可增加自有字段和功能」）：
 * 它就是本仓界面**一直以来的**那套暗色配色（`apps/web/src/styles/theme.css` 的 token）。
 * 加它的理由见 {@link emptyGlobalReaderPrefs} 里 `uiDayTheme` 的注释 —— 一句话：
 * **不加它，用户什么都没做，界面就可能从暗变亮**（那是一次没人要求的视觉变更）。
 */
export const UI_THEME_PRESETS: readonly UiThemeConfig[] = [
  {
    // 本仓自有：复现 `apps/web/src/styles/theme.css` 原来的 `:root` 暗色 token
    themeName: '深色（本仓）',
    isNightTheme: true,
    primaryColor: '#4F8CFF', // theme.css 的 --brand
    accentColor: '#A070FF', // theme.css 的 --accent
    backgroundColor: '#0B0D12', // theme.css 的 --bg-0
    bottomBackground: '#11141B', // theme.css 的 --bg-1（侧栏 / 顶栏）
    transparentNavBar: false,
    backgroundImgPath: null,
    backgroundImgBlur: 0,
  },
  {
    themeName: '默认',
    isNightTheme: false,
    primaryColor: '#795548',
    accentColor: '#E53935',
    backgroundColor: '#F5F5F5',
    bottomBackground: '#EEEEEE',
    transparentNavBar: false,
    backgroundImgPath: null,
    backgroundImgBlur: 0,
  },
  {
    themeName: '典雅蓝',
    isNightTheme: false,
    primaryColor: '#03A9F4',
    accentColor: '#AD1457',
    backgroundColor: '#F5F5F5',
    bottomBackground: '#EEEEEE',
    transparentNavBar: false,
    backgroundImgPath: null,
    backgroundImgBlur: 0,
  },
  {
    themeName: '黑白',
    isNightTheme: true,
    primaryColor: '#303030',
    accentColor: '#E0E0E0',
    backgroundColor: '#424242',
    bottomBackground: '#424242',
    transparentNavBar: false,
    backgroundImgPath: null,
    backgroundImgBlur: 0,
  },
  {
    themeName: 'A屏黑',
    isNightTheme: true,
    primaryColor: '#000000',
    accentColor: '#FFFFFF',
    backgroundColor: '#000000',
    bottomBackground: '#000000',
    transparentNavBar: false,
    backgroundImgPath: null,
    backgroundImgBlur: 0,
  },
];

/** 墨水屏（`themeMode === '3'`）的强制配色 —— 上游 `ThemeConfig.applyTheme()` 的 EInk 分支
 *  （`ThemeConfig.kt:398-406`）：primary/accent/background/bottom 全黑白 + `transparentNavBar=false`。
 *  ⚠️ `themeName` 用**空串**：它不是一套「用户存的主题」，只是模式派生出来的效果（别让它出现在主题列表里）。 */
export const EINK_UI_THEME: UiThemeConfig = {
  themeName: '',
  isNightTheme: false, // AppConfig.kt:175 —— "3" → isNightTheme = false
  primaryColor: '#FFFFFF',
  accentColor: '#000000',
  backgroundColor: '#FFFFFF',
  bottomBackground: '#FFFFFF',
  transparentNavBar: false,
  backgroundImgPath: null,
  backgroundImgBlur: 0,
};

/** {@link UiThemeConfig} 的默认值 = 本仓深色预设（见 {@link UI_THEME_PRESETS} 的说明） */
export function emptyUiThemeConfig(themeName = ''): UiThemeConfig {
  return { ...UI_THEME_PRESETS[0]!, themeName };
}

/**
 * **封面配置**。字段逐条照抄上游 `app/src/main/res/xml/pref_config_cover.xml`
 * 的 `android:key` / `android:defaultValue`（消费点 `BookCover.upDefaultCover()`，`BookCover.kt:66-83`）。
 *
 * ## 有哪些**故意没收录**（记档，防后人当遗漏来补）
 * · `loadCoverOnlyWifi`（`pref_config_cover.xml:6`，默认 false）—— 上游用它「移动流量下不加载封面」
 *   （`SearchAdapter.kt:93` 等三处）。**浏览器里没有「是不是 WiFi」这个概念** ⇒ 移植了就是一个
 *   永远为 true 或永远为 false 的开关。**不收录**。
 * · `coverRule`（`:12`）+ `coverRule.json`（`BookCover.configFileName`）—— 「从书名/作者生成封面文字」
 *   的正则规则表，另有独立对话框 `CoverRuleConfigDialog`。体量独立，**挂账**，不在 `#163`。
 * · `defaultCover` / `defaultCoverDark`（本机图片路径）—— 已收录为
 *   {@link UiCoverConfig.defaultCoverPath} / {@link UiCoverConfig.defaultCoverDarkPath}
 *   （Web 存 URL 或 data URL，与壁纸同一套办法）。
 */
export interface UiCoverConfig {
  /** ★ **强制所有封面都用「生成的默认封面」**（忽略源站给的封面地址）。
   *  上游 `PreferKey.useDefaultCover` / `AppConfig.kt:53`，**默认 false**。
   *  消费点 `BookCover.load()`（`BookCover.kt:95-98`）：为真时直接返回 `defaultDrawable`。 */
  useDefaultCover: boolean;
  /** 默认封面上画书名。`coverShowName`，**默认 true** */
  coverShowName: boolean;
  /** 默认封面上画作者。`coverShowAuthor`，**默认 true**。
   *  ⚠️ 上游 `CoverConfigFragment.kt:52-53`：`coverShowName` 关掉时作者选项**被禁用**
   *  （画布上没地方放）⇒ UI 要跟着 disable，别让它看起来能用。 */
  coverShowAuthor: boolean;
  /** 夜间槽的书名（`coverShowNameN`，**默认 true**）。日夜切换见 {@link UiThemeConfig.isNightTheme} */
  coverShowNameN: boolean;
  /** 夜间槽的作者（`coverShowAuthorN`，**默认 true**） */
  coverShowAuthorN: boolean;
  /** 书名**横排**（`coverHorizontal`，默认 false = 上游的竖排）。
   *  ⚠️ Android 上封面文字默认是**竖排**（`drawBookNameHorizontal = false`，`BookCover.kt:78`）；
   *  Web/PC 上竖排书名观感很怪，但**照抄默认值**、把选择权留给用户（`writing-mode`）。 */
  coverHorizontal: boolean;
  /** 封面文字**保留标点**（`coverKeepPunctuation`，默认 false = 去掉标点） */
  coverKeepPunctuation: boolean;
  /** 默认封面底图（日间槽）。`defaultCover`；`null` = 用本仓的内置渐变（见 `theme.css` 的 `.p1`~`.p8`）。
   *  与 {@link UiThemeConfig.backgroundImgPath} 同一套取值（URL 或 data URL）。 */
  defaultCoverPath: string | null;
  /** 默认封面底图（夜间槽）。`defaultCoverDark` */
  defaultCoverDarkPath: string | null;
}

/** {@link UiCoverConfig} 默认值（逐项来自 `pref_config_cover.xml` 的 `android:defaultValue`） */
export function emptyUiCoverConfig(): UiCoverConfig {
  return {
    useDefaultCover: false, // :21
    coverShowName: true, // :62
    coverShowAuthor: true, // :71
    coverShowNameN: true, // :97
    coverShowAuthorN: true, // :106
    coverHorizontal: false, // :30
    coverKeepPunctuation: false, // :40
    defaultCoverPath: '/assets/default-cover.jpg',
    defaultCoverDarkPath: '/assets/default-cover.jpg',
  };
}

/* ------------------------------------------------------------------ *
 * 十一、全局阅读偏好（应用级，对应 `AppConfig` / `ReadBookConfig` 的全局项）  [P2/P3]
 * ------------------------------------------------------------------ */

/**
 * 全局阅读偏好（**应用级**，与 {@link BookReadConfig} 的「每本书」相对）。
 *
 * ⚠️ 这里**只收录已有源码证据的项**，不预造字段。每项都标注了 Legado 出处与取值语义。
 *
 * ## 与 Legado 的一处**刻意分叉**（2026-09-30，`#145` 落地时记录）
 * Legado 的「阅读样式」（颜色 / 字号 / 行距 …）不是零散偏好，而是**全局的命名主题列表**：
 * `assets/defaultData/readConfig.json` 里 **6 条**（`微信读书` / `预设1`~`预设5`，每条 46 个键，
 * 其余键由 Kotlin 默认值补齐），由 `ReadBookConfig.kt:252` 的 `configs ?: DefaultData.readConfigs` 载入，
 * 每本书再选其中一条（`Book.ReadConfig.config`）。
 * ⇒ 本仓 Web 目前**只取单套样式**（全局一份），**不做命名主题与每本选择** —— 那需要契约里的
 * 「主题列表」实体 + 一套主题编辑 UI，体量另算。
 * 本轮（`#145`）只把**已有 UI 真正需要**的字号/排版项与 `themeMode` 落进本接口；
 * **三套颜色仍在前端 CSS**（白天/夜间/E-Ink），取值照抄上游 `Config()` 的 Kotlin 默认值
 * （`ReadBookConfig.kt:870-885`），出处写在 `apps/web/src/styles/reader-theme.ts` 注释里。
 */
export interface GlobalReaderPrefs {
  /** 主题模式。`AppConfig.themeMode`（`AppConfig.kt:52`）+ `arrays.xml:71` 的 `theme_mode`，
   *  取值 `"0"`=跟随系统 / `"1"`=亮色 / `"2"`=暗色 / `"3"`=E-Ink。默认 `"0"` */
  themeMode: '0' | '1' | '2' | '3';
  /** 简繁转换。`AppConfig.chineseConverterType`（`AppConfig.kt:420`），取值见 {@link ChineseConvertType}。默认 0 */
  chineseConverterType: number;
  /** 书架排序方式索引。`AppConfig.bookshelfSort`（`AppConfig.kt:792`，默认 0）。
   *  ⚠️ Legado 是「排序菜单项下标」，语义与菜单耦合 → 移植时我们**自定义枚举**并在此存储，不复刻下标。 */
  bookshelfSort: number;
  /** 正文默认启用净化（`AppConfig.replaceEnableDefault`，`AppConfig.kt:680`）。默认 true */
  replaceEnableDefault: boolean;
  /**
   * `#261` **手动规则集模式**（上游 `AppConfig.manualReplaceRule`，`AppConfig.kt:682`，默认 **false**）。
   *
   * 打开后（上游语义，逐条照抄）：
   * ① 阅读器菜单里「启用替换」**消失**、换成「手动规则集」（`ReadBookActivity.kt:537-539`）
   *    —— 全局互斥，一开影响**所有书**；
   * ② 每本书 `BookReadConfig.manualReplaceRuleIds` 非空 ⇒ **完全接管**：
   *    `replaceEnabled = manualRules.enabled`（不再是书的 `useReplaceRule` 或全局默认），
   *    且两路规则换成手动集 ⇒ **全局规则一条都不跑**（`ReadBook.kt:1270-1289`）；
   * ③ 取规则只按 id（`ReplaceRuleDao.findByIds`）⇒ **无视 `isEnabled`、无视 `scope`/`excludeScope`**；
   * ④ 但仍按 `scopeTitle`/`scopeContent` 分流到标题 / 正文。
   *
   * ⚠️ 这些「无视」是上游现状（不是本仓发明）⇒ 界面上必须说清，否则用户会觉得规则莫名失效。
   */
  manualReplaceRuleEnabled: boolean;
  /**
   * **高亮「上次使用的样式」**（`#256`）。JSON 字符串，形如
   * `{"fill":"rgba(255,193,7,.28)","fillShape":"rounded","underline":{"kind":"solid",…}}`。默认 `""` = 从没调过样式。
   *
   * ## 出处与语义
   * 上游 `PreferKey.highlightLastStyle`（`PreferKey.kt`）+ `ReadBookActivity.kt:1272-1277`：
   * 点「高亮」新建时取**上次用过的那套样式**，空了才回落到 `HighlightStyles.presets.first()`
   * （`visibleHighlightStyle()`，`:3017-3019`）。
   *
   * ★ 这条正是用户 `#256` 说的「**独立一套配置**」的落地机制：高亮的默认样式来自**它自己**的
   *   上次选择，而不是阅读样式的全局下划线（`underlineMode*`）—— 两者互不读写。
   * ★ 它**不在** {@link READ_STYLE_KEYS} 里：那是「每本书可覆盖」的白名单，而「上次高亮样式」
   *   是**应用级**偏好（跟书走毫无意义，上游也在 `PreferKey` 而非 `ReadBookConfig` 里）。
   */
  highlightLastStyle: string;
  /**
   * **记录阅读时长**（`#144`，`AppConfig.enableReadRecord`，`AppConfig.kt:556-559`）。默认 true。
   * 关 = 不累计也不上报 `read-time`（上游 `ReadBook.upReadTime():617` 的第一行就是这个门）。
   */
  enableReadRecord: boolean;
  /** **适配刘海**（把正文扩展到屏幕缺口区域）。`ReadBookConfig.readBodyToLh`
   *  （声明 `ReadBookConfig.kt:370` · 读取 `AppConfig.kt:107-108`），默认 true。
   *  界面文案见 `strings.xml` 的 `read_body_to_lh` = **「扩展到刘海」/「Extend to cutout」**。
   *  唯一消费点：`BaseReadBookActivity.upLayoutInDisplayCutoutMode()`
   *  （`BaseReadBookActivity.kt:288-295`，在 `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` 与 `..._NEVER` 间切换）。
   *
   *  ⚠️ **2026-09-30 纠正一处我们自己的错误结论**：本字段此前的注释写的是「**正文行距联动**」——
   *  那是**按字段名猜的，错的**。它与行距毫无关系（行距是 `Config.lineSpacingExtra`）。
   *  ⇒ **Web 上无对应能力**（浏览器里没有「刘海布局模式」这种东西，CSS 的 `env(safe-area-inset-*)`
   *  是另一回事）。保留该字段只为契约完整；**移植时不消费、界面也不要为此造一个开关**
   *  （造了就是「给了个不起作用的设置」）。
   */
  readBodyToLh: boolean;
  /** 自动朗读速度（`ReadBookConfig.autoReadSpeed`，`AppConfig.kt:371`）。默认 10 */
  autoReadSpeed: number;
  /** 音频片头（全局，`AppConfig.audioSkipOpenCredits`，`AppConfig.kt:720`）。默认 0 */
  audioSkipOpenCredits: number;
  /** 音频片尾（全局，`AppConfig.audioSkipCloseCredits`，`AppConfig.kt:724`）。默认 0 */
  audioSkipCloseCredits: number;
  /** 翻页动画（`ReadBookConfig.Config.pageAnim`，`PageAnim.kt:9-17`）。
   *  取值：0 覆盖 / 1 滑动 / 2 仿真 / **3 滚动** / 4 无动画。
   *  ⚠️ 本仓 Web 阅读是**滚动式卡片** ⇒ 默认 **3**；其它档位按「章节切换动画」近似实现。 */
  pageAnim: number;
  /** 共用布局（Legado `shareLayout`）。在本仓的表达：**开 = 编辑全局默认**（所有书共用），
   *  关 = 编辑当前书的覆盖。默认 false。 */
  shareLayout: boolean;

  /* ---------------- 排版（`ReadBookConfig.Config`，即 Legado 的「阅读样式」）----------------
   * 字段名 / 默认值 **逐条照抄** `ReadBookConfig.kt:868-917` 的 `Config` 主构造器
   * （下面每项各自标注行号）。单位保持上游语义，映射到 CSS 的方式写在使用处。 */

  /** 正文字号。`ReadBookConfig.kt:891`，Kotlin 默认 **20**（上游注释：文字大小）。
   *  ⚠️ 与 Legado 的其它尺寸一样是 **px 语义**（Android `TextPaint.textSize`）⇒ Web 直接用作 `font-size`。 */
  textSize: number;
  /** 章节标题字号。`ReadBookConfig.kt:897`，Kotlin 默认 **0**。
   *  ⚠️ **`0` 是「不单独设置」的哨兵**（UI 上显示为「跟随正文」）⇒ 消费时必须判 `<= 0` 而不是判 `falsy` 之外的东西。 */
  titleSize: number;
  /** 字重。`ReadBookConfig.kt:890`，Kotlin 默认 **0**（上游注释：0:正常, 1:粗体, 2:细体） */
  textBold: number;
  /** 字间距。`ReadBookConfig.kt:892`，Kotlin 默认 **0.1f**。
   *  ⚠️ 单位是 **em**（Android `TextPaint.letterSpacing`）⇒ CSS 用 `letter-spacing: 0.1em`。 */
  letterSpacing: number;
  /** 行间距**增量**。`ReadBookConfig.kt:893`，Kotlin 默认 **12**（px 语义，加在行高之外）。
   *  ⚠️ 是「额外」不是「总行高」⇒ CSS 用 `line-height: calc(1em + 12px)` 这类写法，别直接当 `line-height` 数值。 */
  lineSpacingExtra: number;
  /** 段间距。`ReadBookConfig.kt:895`，Kotlin 默认 **2**（px） */
  paragraphSpacing: number;
  /** 段落缩进（**直接前置到每段**）。`ReadBookConfig.kt:905`，Kotlin 默认 **`"　　"`**（两个全角空格）。
   *  ⚠️ 是字符串而不是 CSS `text-indent` —— 上游就是这么做的（因为要兼容「无缩进」= 空串）。 */
  paragraphIndent: string;
  /** 正文字体。`ReadBookConfig.kt:888`，Kotlin 默认 **`""`** = 用系统默认字体 */
  textFont: string;
  /** 标题字体。`ReadBookConfig.kt:889`，Kotlin 默认 **`""`**（上游注释：空值**跟随正文字体**） */
  titleFont: string;

  /* ================ 阅读样式全面化（`#164`）================
   * `ReadBookConfig.Config` 主构造器**脚本实数 80 字段**（`ReadBookConfig.kt:869-948`）。
   * 下面按组收录 **Web 有对应能力** 的那些；**每个字段都标了上游行号与默认值**。
   * 明确不移植 / 暂缓的，逐组写在注释里（**不是遗漏，是决策**）—— 造一个「改了看不出变化」的
   * 设置比不做更糟（本仓已有此先例：净化规则开关、本地字典）。
   *
   * ⚠️ **不收录**（Android 专属，Web 无对应能力）：
   *  · `darkStatusIcon` / `darkStatusIconNight` / `darkStatusIconEInk`（`:877-879`）—— 状态栏图标明暗，浏览器无状态栏；
   *  · `reviewIconColor` / `reviewIconSvg` / `reviewIconSvgTemplates` / `reviewIconScale`（`:914-917`）—— **段评**图标，本仓无段评功能；
   *  · ~~`tipHeader*` / `tipFooter*`（6 项，`:932-937`）+ `tip*Template`（6 项，`:938-943`）
   *    + `tipTextSize` / `tipColor` / `tipDividerColor` / `headerMode` / `footerMode`（`:944-948`）
   *    + `headerPadding*` / `footerPadding*`（8 项，`:922-929`）~~
   *    ⇒ **`#221`（2026-10-03）已收录**：阅读界面拆成「顶端标题栏 / 页眉 / 正文 / 页脚」三层后，
   *    页眉页脚在 Web 上有了真实语义（此前判它「不分页、无电量 ⇒ 不收录」的前提**被需求改变了**）。
   *    见下面「页眉 / 页脚」那一段，含与上游的**两处有意差异**。
   *  · `underlineColorSet` / `underlineConfigVersion`（`:908` / `:913`）—— 上游的**迁移 / 兼容标志**
   *    （见 `ReadBookConfig.kt:106-127` 的 `underlineConfig()` 与 `TextLine.kt:50-54` 的取色分支），
   *    没有 Web 语义。本仓把「是否设过颜色」直接表达为 `underlineColor === null`（一个字段表达上游两个）。
   */

  /* ---------------- 背景（3 套色 + 透明度）---------------- */

  /** 白天背景色。`ReadBookConfig.kt:870`，默认 **`#EEEEEE`**。
   *  ⚠️ 上游同名字段还会装**图片路径**（由 `bgType` 决定是色还是图，`:874`）；Web **本轮只做颜色背景** ⇒
   *  类型就是颜色串。`bgType` 那一组见本组末尾的「暂缓」说明。 */
  bgStr: string;
  /** 夜间背景色。`:871`，默认 **`#000000`** */
  bgStrNight: string;
  /** 墨水屏背景色。`:872`，默认 **`#FFFFFF`** */
  bgStrEInk: string;
  /** 背景透明度 **百分比 0–100**。`:873`，默认 **100**。
   *  消费点：`PageView.kt:343` `bg.alpha = (bgAlpha / 100f * 255).toInt()` —— **只作用于背景**，不影响文字。
   *
   * ## ★★ `#250` **它调的是「背景图层」的透明度，不是底色、也不是正文**
   * 上游只在这一处消费，而 `ReadBookConfig.bg` 是**当前背景 Drawable**（`curBgDrawable`，`:1114`）：
   * · `bgType = 0`（纯色）⇒ `bg` 就是那个 `ColorDrawable` ⇒ alpha 调的是**底色不透明度**；
   * · `bgType = 1/2`（图）⇒ `bg` 是 `BitmapDrawable` ⇒ alpha **只作用于图片**。
   * 底色那一层是**独立的**：`upBg()`（`PageView.kt:329-336`）挂的是
   * `LayerDrawable(bgMeanColor, bg)`，而 `bgMeanColor`（图片均色，`:279`）是**第一层、不参与 alpha**。
   *
   * ⇒ **有背景图时：alpha 只淡图片，底色不动** —— 这正是用户 2026-10-04 报的
   * 「背景透明度应该调整的是背景图片的透明度，不是正文区域的透明度」。
   * ⇒ 无图（纯色）时它才等价于「底色不透明度」，与上游同义。
   * ⚠️ 本仓 Web 不做图片均色那一层（`bgMeanColor` 无对应物）⇒ 纯色分支直接调底色。 */
  bgAlpha: number;

  /* ---------------- 背景图片（`#249`，上游 `bgType` 那一组）----------------
   * ⚠️ 此前 `bgStr` 的注释写着「Web **本轮只做颜色背景**」—— `#249` 起补上图片那一半，
   * 但**刻意换了一种表达**：上游是「同一个 `bgStr` 按 `bgType` 装色值或路径」（同槽复用，
   * 见 `ReadBookConfig.kt:814-826`），本仓**另开三个字段**，理由见下。
   */

  /**
   * 白天背景**图片**。默认 `null` = 不用图（用 {@link bgStr} 的颜色）。
   *
   * ## 为什么不用上游的 `bgType` + 同槽复用
   * 上游：`bgType`（0 色 / 1 assets 图 / 2 其它图片）决定 `bgStr` 装的是**色值还是文件路径**。
   * 那个设计在 Android 上成立（GSON 反正都存字符串），但在本仓会踩两处：
   * ① `bgStr` 已经进了 `READ_STYLE_KEYS` 与**下拉/取色器**等一堆按「颜色」用的地方，
   *    塞进路径会让 `<input type=color>` 拿到非法值；
   * ② 合并/校验层无法判断 `bgStr` 到底是色还是路径。
   * ⇒ **拆成独立字段**：`bgStr` 永远是颜色，`bgImgPath` 永远是图片，两套可独立设
   * （「深色文字配浅色图」这种组合上游表达不了）。
   *
   * ## 取值
   * · `null` —— 不用图；
   * · 内置图 id（如 `护眼漫绿`）—— 解析成 `/reader-bg/<id>.jpg`（见 `utils/reader-bg.ts`）；
   * · `http(s)://…` —— 网络图；
   * · `data:image/…` —— 本机图片转的 data URL。
   */
  bgImgPath: string | null;
  /** 夜间背景图片。`:875` 的 `bgTypeNight` 那一半。默认 `null` */
  bgImgPathNight: string | null;
  /** 墨水屏背景图片。默认 `null`。
   *  ⚠️ 上游的墨水屏是**强制黑白**（`EINK_UI_THEME` 那套）—— 墨水屏上放彩色背景图没有意义，
   *  但**保留字段**是为了与日夜对称、避免出现「有图却被静默忽略却找不到开关」的黑洞。 */
  bgImgPathEInk: string | null;

  /* ---------------- 文字颜色（正文 3 套 + 强调 3 套）---------------- */

  /** 白天正文颜色。`:880`，默认 **`#3E3D3B`** */
  textColor: string;
  /** 夜间正文颜色。`:881`，默认 **`#ADADAD`** */
  textColorNight: string;
  /** 墨水屏正文颜色。`:882`，默认 **`#000000`** */
  textColorEInk: string;
  /** 白天强调色（链接 / 关键词等高亮）。`:883`，默认 **`#E53935`** */
  textAccentColor: string;
  /** 夜间强调色。`:884`，默认 **`#FE4D55`** */
  textAccentColorNight: string;
  /** 墨水屏强调色。`:885`，默认 **`#000000`** */
  textAccentColorEInk: string;

  /* ---------------- 正文边距（4 项）---------------- */

  /** 正文上边距。`:921`，默认 **6**（px 语义） */
  paddingTop: number;
  /** 正文左边距。`:919`，默认 **16** */
  paddingLeft: number;
  /** 正文右边距。`:920`，默认 **16** */
  paddingRight: number;
  /** 正文下边距。`:918`，默认 **6** */
  paddingBottom: number;

  /* ---------------- 章节标题系列 ---------------- */

  /** 标题位置。`:896`，默认 **0**：`0` 居左 / `1` 居中 / `2` **隐藏** / `3` 居右。
   *  消费点：`TextChapterLayout.kt:118,165,281`（`titleMode != 2` 才画标题）。 */
  titleMode: number;
  /** 标题颜色。`:898`，默认 **0** = **跟随正文色**。
   *  上游判据 `ReadBookConfig.kt:527`：`titleColor.takeIf { it != 0 } ?: textColor`。
   *  与下划线一样，本仓用 `null` 表达「跟随」⇒ 类型是 `string | null`。 */
  titleColor: string | null;
  /** 标题**上**间距。`:903`，默认 **0** */
  titleTopSpacing: number;
  /** 标题**下**间距。`:904`，默认 **0** */
  titleBottomSpacing: number;
  /** 章节名行距相对字体行高的**偏移**。`:894`，默认 **0**（上游注释：单位 0.1） */
  titleLineSpacingExtra: number;

  /* ---------------- 下划线 ---------------- */

  /** 下划线样式。`:906`（上游注释「旧字段，保留兼容」）。
   *  取值照抄 `ReadBookConfig.kt:41-47`：
   *  `0` 关 / `1` 实线 `SOLID` / `2` 虚线 `DASHED` / `3` 点线 `DOTTED` / `4` 双线 `DOUBLE` /
   *  `5` 波浪 `WAVY` / `6` 双虚线 `DOUBLE_DASHED`。
   *  ⚠️ **`6`（双虚线）CSS 无对应** ⇒ 渲染时**回落为虚线**（已写在 `styles/reader-style.ts` 的映射表注释，界面里也不提供该档）。
   *  生效条件（`TextLine.kt:277-290` 的 `activeUnderlineMode`）：`mode != 0` **且** `underlineWidth > 0`
   *  **且** 当前行属于「正文 / 标题」中被 `underline*Enabled` 放行的那一类。 */
  underlineMode: number;
  /** 下划线颜色。`:907`，默认 **0**。上游是 `underlineColor` + `underlineColorSet` **两个字段**
   *  （`TextLine.kt:50-54`：`if (underlineColorSet) underlineColor else textColor`）——
   *  本仓用 **`null` = 跟随正文色** 表达同一件事，不移植那个兼容标志。 */
  underlineColor: string | null;
  /** 下划线粗细。`:909`，默认 **1**（上游 `DEFAULT_UNDERLINE_WIDTH = 1f`，`:48`）。
   *  ⚠️ `<= 0` 表示**不画**（`TextLine.kt:288`），不是「最细」。 */
  underlineWidth: number;
  /** 下划线与基线之间的距离。`:910`，默认 **4**（上游 `DEFAULT_UNDERLINE_DISTANCE = 4f`，`:51`） */
  underlineDistance: number;
  /** 正文行是否画下划线。`:911`，默认 **true** */
  underlineBodyEnabled: boolean;
  /** 标题行是否画下划线。`:912`，默认 **true**。
   *  ⚠️ 本仓的章节标题是**独立 DOM 元素**（不在正文段落里），所以这一项的实际效果就是「标题要不要下划线」。 */
  underlineTitleEnabled: boolean;

  /* ---------------- 页眉 / 页脚（`#221`，2026-10-03 **翻转**了 `#164` 的决策）----------------
   * `#164` 曾把这一整组判为「Android 分页阅读页专属 ⇒ 不收录」。用户 2026-10-03 明确要求
   * **阅读界面拆分成「顶端标题栏 / 页眉 / 正文 / 页脚」三层**，页眉页脚要能显示书名、章节、进度，
   * 且信息内容用**模板**配置 ⇒ 这一组从此有了 Web 语义，**照抄上游字段**。
   *
   * 上游出处：`ReadBookConfig.kt` 的 `Config` 主构造器 `:922-948` +
   * `ReadTipConfig.kt`（信息位枚举与 `headerMode` / `footerMode` 的取值）+ `ReaderInfoTemplate.kt`（模板语法）。
   *
   * ★ **与上游的两处有意差异**（都已写进下面各自的注释，别当 bug 修）：
   *  ① `headerMode` 的 `0`：上游是「状态栏显示时隐藏」，Web 没有状态栏 ⇒ 映射成**自动隐藏**
   *     （向下滚动看正文时收起、翻章后露出）—— 这正是用户要的「自动隐藏」；
   *  ② 默认信息位：上游默认页眉是「时间 / 电量」（手机状态栏信息），Web 端用户要的是
   *     **书名–作者** ⇒ 默认左=书名、右=章节。**电量**（`{电量}` / `{电量图标}`）在 Web 上
   *     依赖 `navigator.getBattery()`（Chrome/Edge 有，Safari/Firefox 没有）⇒ 保留占位符，
   *     取不到就渲染成空串，不给「假数字」。
   */

  /** 页眉显示模式。`ReadBookConfig.kt:947` + `ReadTipConfig.kt:137-141` 的 `getHeaderModes`：
   *  `0` = **自动隐藏**（上游是「状态栏显示时隐藏」，Web 映射为「向下滚动阅读时收起、翻章后露出」）/
   *  `1` = 始终显示 / `2` = 隐藏。默认 **0**。 */
  headerMode: number;
  /** 页脚显示模式。`:948` + `ReadTipConfig.kt:143-146` 的 `getFooterModes`：`0` = 显示 / `1` = 隐藏。默认 **0** */
  footerMode: number;
  /** 页眉**左**信息位。`:932`，取值 = {@link READ_TIP_VALUES}（`ReadTipConfig.kt:15-27`）。
   *  上游默认 `time`；本仓默认 **`bookName`**（见上面的差异 ②） */
  tipHeaderLeft: number;
  /** 页眉**中**信息位。`:933`，上游默认 `none`；本仓默认 `none` */
  tipHeaderMiddle: number;
  /** 页眉**右**信息位。`:934`，上游默认 `battery`；本仓默认 **`chapterTitle`** */
  tipHeaderRight: number;
  /** 页脚**左**信息位。`:935`，默认 **`chapterTitle`**（与上游一致） */
  tipFooterLeft: number;
  /** 页脚**中**信息位。`:936`，默认 `none`（与上游一致） */
  tipFooterMiddle: number;
  /** 页脚**右**信息位。`:937`，默认 **`pageAndTotal`**（与上游一致） */
  tipFooterRight: number;
  /** 页眉左**自定义模板**。`:938`，`null` = 用 {@link READ_TIP_VALUES} 里那个信息位的默认模板。
   *  语法见 `ReaderInfoTemplate.kt:31-40` 的占位符（`{书名}` `{章节}` `{时间}` `{电量}` `{电量图标}`
   *  `{页码}` `{总页数}` `{阅读进度}` `{章节序号}` `{章节总数}`）。 */
  tipHeaderLeftTemplate: string | null;
  /** 页眉中自定义模板。`:939` */
  tipHeaderMiddleTemplate: string | null;
  /** 页眉右自定义模板。`:940` */
  tipHeaderRightTemplate: string | null;
  /** 页脚左自定义模板。`:941` */
  tipFooterLeftTemplate: string | null;
  /** 页脚中自定义模板。`:942` */
  tipFooterMiddleTemplate: string | null;
  /** 页脚右自定义模板。`:943` */
  tipFooterRightTemplate: string | null;
  /** 页眉页脚字号。`:944`，默认 **12**（`ReadTipConfig.kt:11-12` 夹在 5–50 之间） */
  tipTextSize: number;
  /** 页眉页脚文字颜色。`:945`，默认 **0 = 跟随正文色** ⇒ 本仓用 `null` 表达（同 `titleColor` 的口径） */
  tipColor: string | null;
  /** 页眉页脚分隔线颜色。`:946`，默认 **-1 = 跟随正文色** ⇒ 本仓用 `null` 表达 */
  tipDividerColor: string | null;
  /** 页眉上内边距。`:925`，默认 **0** */
  headerPaddingTop: number;
  /** 页眉左内边距。`:923`，默认 **16** */
  headerPaddingLeft: number;
  /** 页眉右内边距。`:924`，默认 **16** */
  headerPaddingRight: number;
  /** 页眉下内边距。`:922`，默认 **0** */
  headerPaddingBottom: number;
  /** 页脚上内边距。`:929`，默认 **6** */
  footerPaddingTop: number;
  /** 页脚左内边距。`:927`，默认 **16** */
  footerPaddingLeft: number;
  /** 页脚右内边距。`:928`，默认 **16** */
  footerPaddingRight: number;
  /** 页脚下内边距。`:926`，默认 **6** */
  footerPaddingBottom: number;
  /** 页眉下是否画分隔线。`:930`，默认 **false** */
  showHeaderLine: boolean;
  /** 页脚上是否画分隔线。`:931`，默认 **true** */
  showFooterLine: boolean;

  /* ---------------- `#235` 页眉 / 页脚**独立**样式（超出上游的有意增强）----------------
   * ## 为什么要加（用户 2026-10-03：「字号，文字颜色，分隔线颜色应可独立设置；现状：被合并了」）
   * 上游 `ReadBookConfig.kt:944-946` 只有**一份** `tipTextSize` / `tipColor` / `tipDividerColor`
   * ⇒ 页眉与页脚被迫共用一套（`PageView.kt:129-130` 把同一个 `tipDividerColor` 同时刷给
   * `vwTopDivider` 与 `vwBottomDivider`）。本仓 Web 端页眉页脚是**两条独立的信息带**
   * （各自的模板、内边距、显隐），共用一套颜色/字号在实践中很难看（用户原话「被合并了」）。
   *
   * ## 与上游的关系：**纯增量，不改上游字段**
   * 下面 8 个字段**默认为 `null`**，`null` 的语义是「回落到上游那份共用值」⇒
   * · 老配置的行为**一字不变**（不会出现「升级后字号变了」）；
   * · 想要独立设置的用户才显式写值。
   * ⚠️ 别把上游那 3 个字段改成本仓专属 —— 它们还要导出给 App 端对齐用。
   */

  /** 页眉字号（`#235`）。`null` = 跟随 `tipTextSize`。上游夹 5–50（`ReadTipConfig.kt:11-12`） */
  headerTextSize: number | null;
  /** 页眉文字颜色（`#235`）。`null` = 跟随 `tipColor`（再到正文色） */
  headerTextColor: string | null;
  /** 页眉分隔线颜色（`#235`）。`null` = 跟随 `tipDividerColor` */
  headerDividerColor: string | null;
  /** 页脚字号（`#235`）。`null` = 跟随 `tipTextSize` */
  footerTextSize: number | null;
  /** 页脚文字颜色（`#235`）。`null` = 跟随 `tipColor` */
  footerTextColor: string | null;
  /** 页脚分隔线颜色（`#235`）。`null` = 跟随 `tipDividerColor` */
  footerDividerColor: string | null;

  /**
   * 分隔线型（`#235`，用户 2026-10-03：「页眉下画线和页脚上画线分别增加线型设置」）。
   *
   * ★ **上游没有这个概念** —— `PageView.kt` 的 divider 就是一条 `backgroundColor` 实色条。
   *   本条是 Web 端增强（CSS 能画虚线/点线/双线/波浪线，Android `View` 要靠 drawable 资源）。
   *
   * 取值见 `TIP_LINE_STYLE` 枚举；`solid` = 上游那条实线（默认 ⇒ 不改变既有观感）。
   * `double` 用两条 1px 线 + 间隙实现（纯 CSS，不用图片）。
   * `wave` 用 `repeating-linear-gradient` 生成 SVG 风格锯齿。
   */
  headerLineStyle: TipLineStyle;
  /** 页脚分隔线型（`#235`）。语义同 `headerLineStyle` */
  footerLineStyle: TipLineStyle;

  /* ---------------- `#250` 栏位透明（页眉/页脚/标题栏）----------------
   * ## 为什么要加（用户 2026-10-04）
   * 「页眉页脚、标题栏是否透明，在样式界面应有开关入口，并且透明度可调」——
   * `#249` 把背景图扩到整个阅读界面后，页眉/页脚被硬编码成 `background: transparent`（**无开关**），
   * 而标题栏 `.se-head` 保持自己的不透明底色 ⇒ 用户看到的是「页眉能透图、标题栏不能」的自相矛盾行为。
   *
   * ## 与上游的关系：**纯增量，上游没有这些字段**
   * 上游 `view_book_page.xml` 里 `ll_header` / `ll_footer` **自身就没有 `android:background`**
   * ⇒ 它们**恒透明**、不可配置（`PageView.kt:330` 只把背景挂在 `vwRoot` 上）。
   * 而工具栏在**另一个 Activity 层**（`ReadBookActivity` 的 actionbar），上游管不到。
   * ⇒ 本仓 Web 把三者收在同一个浮层里，才需要「透明 / 不透明 + 各自不透明度」这组开关。
   * ⚠️ 别把默认值改成「不透明」：默认透明 = 与上游观感一致（老用户升级后背景图直接铺满）。
   */

  /** 标题栏（`.se-head`，含返回/目录/更多/关闭）是否透明透背景。默认 **true**（`#250`） */
  toolbarTransparent: boolean;
  /** 标题栏**不透明时**的底色不透明度 0–100。默认 **100**。`toolbarTransparent=false` 时才生效 */
  toolbarAlpha: number;
  /** 页眉是否透明透背景。默认 **true**（与上游 `ll_header` 无 background 同义） */
  headerTransparent: boolean;
  /** 页眉不透明时的底色不透明度 0–100。默认 **100** */
  headerAlpha: number;
  /** 页脚是否透明透背景。默认 **true**（与上游 `ll_footer` 无 background 同义） */
  footerTransparent: boolean;
  /** 页脚不透明时的底色不透明度 0–100。默认 **100** */
  footerAlpha: number;

  /* ---------------- 暂缓 / 不做（写清理由，防止后人当「漏了」再查一遍）----------------
   * · `bgType` / `bgTypeNight` / `bgTypeEInk`（`:874-876`，0 颜色 / 1 assets 图片 / 2 其它图片）：
   *   `1`（App 内置 assets）在 Web 无对应；`2`（本地图片）需要「选文件 + 持久化大对象」，与阅读样式不是一件事
   *   ⇒ 本轮只做颜色背景；真要图片背景时按 `bgType` 的形状补，别在本轮塞一个只有 0 档能用的设置。
   * · `pageAnim` / `pageAnimEInk`（`:886-887`）：`PageAnim.kt:9-17` = 0 覆盖 / 1 滑动 / 2 仿真 / **3 滚动** / 4 无动画，
   *   `ReadView.kt:898 isScroll = pageAnim() == 3` —— 上游阅读器是**分页的自定义 View**。
   *   本仓 Web 阅读浮层是**滚动式卡片**（≡ 上游 `pageAnim = 3`）⇒ 给其它档位就是**假设置**；
   *   真要翻页动画 = 把阅读器重做成分页视图，属**独立需求**，不混在这一轮。
   * · `titleNumberSize` / `titleNumberColor` / `titleNumberSpacing`（`:900-902`）：上游用在**分页布局**里
   *   给章节标题算**行内编号**（`ChapterProvider.kt:293` `textSize = textSize + titleNumberSize`、
   *   `TextChapterLayout.kt:100,378`）。本仓的 `ch.title` **本身已是「第 N 章 …」**，再加一个编号会重复
   *   ⇒ 缓做（做之前要先定「编号从哪来、和已有标题怎么共存」）。
   * · `splitChapterTitle`（`:899`）：上游把「第 N 章」与「标题正文」拆成两行分别排版。
   *   与上一条同因（标题形态不同）⇒ 缓做。
   */

  /* ---------------- 界面主题 / 封面配置（`#163`）----------------
   * ★ 这三组与上面的排版项**不是一回事**：上面是**正文**的（阅读样式），这里是**界面**的。
   *   上游也分得很开，只是都落在 SharedPreferences 里（所以在本仓同属 `prefs` 这一个对象）。 */

  /** **界面主题 —— 日间槽**。对应上游 `PreferKey.cPrimary` / `cAccent` / `cBackground` /
   *  `cBBackground` / `tNavBar` / `bgImage` / `bgImageBlurring` 这一组
   *  （`ThemeConfig.getDayTheme()`，`ThemeConfig.kt:320-347`）+ 当前生效的名字 `dThemeName`。 */
  uiDayTheme: UiThemeConfig;
  /** **界面主题 —— 夜间槽**。对应上游 `cNPrimary` / `cNAccent` / `cNBackground` /
   *  `cNBBackground` / `tNavBarN` / `bgImageN` / `bgImageNBlurring` 这一组
   *  （`ThemeConfig.getNightTheme()`，`ThemeConfig.kt:354-386`）+ `dNThemeName`。
   *  **用哪个槽**由 `themeMode` 经 `isNightTheme` 决定（见 {@link UiThemeConfig} 注释第 2 条）。 */
  uiNightTheme: UiThemeConfig;
  /** **保存的命名主题列表**。对应上游 `themeConfig.json` / `ThemeConfig.configList`
   *  （`ThemeConfig.kt:53-56`，默认 {@link UI_THEME_PRESETS}）。
   *  ⚠️ **不含**当前生效的那两个槽 —— 上游也是分开存的（列表是 `themeConfig.json`，
   *  生效的是 `colorPrimary…` 那一堆偏好）。同名即覆盖（`ThemeConfig.addConfig`）。 */
  uiThemes: UiThemeConfig[];
  /** **封面配置**（上游 `pref_config_cover.xml`）。见 {@link UiCoverConfig} */
  cover: UiCoverConfig;
}

/** `GlobalReaderPrefs` 默认值（逐项来自上表注释的 Legado 默认值） */
export function emptyGlobalReaderPrefs(): GlobalReaderPrefs {
  return {
    themeMode: '0',
    chineseConverterType: ChineseConvertType.none,
    bookshelfSort: 0,
    replaceEnableDefault: true,
    manualReplaceRuleEnabled: false, // `#261`：默认关闭（照抄上游 AppConfig.kt:682）
    highlightLastStyle: '', // `#256`：空 = 从没调过样式 ⇒ 新建高亮用 HighlightStyles 的第一套预设
    enableReadRecord: true,
    readBodyToLh: true,
    autoReadSpeed: 10,
    audioSkipOpenCredits: 0,
    audioSkipCloseCredits: 0,
    // ── 阅读行为
    pageAnim: 3, // Web 默认就是滚动（上游 `PageAnim.scrollPageAnim`）
    shareLayout: false,
    // ── 排版：逐条抄 `ReadBookConfig.kt` 的 `Config` 主构造器默认值
    textSize: 20, // :891
    titleSize: 0, // :897（0 = 跟随正文）
    textBold: 0, // :890（0 正常）
    letterSpacing: 0.1, // :892
    lineSpacingExtra: 12, // :893
    paragraphSpacing: 2, // :895
    paragraphIndent: '　　', // :905（两个全角空格）
    textFont: '', // :888
    titleFont: '', // :889（空 = 跟随正文）
    // ── 阅读样式全面化（`#164`）：逐条抄 `ReadBookConfig.kt:869-948` 的构造器默认值
    bgStr: '#EEEEEE', // :870
    bgStrNight: '#000000', // :871
    bgStrEInk: '#FFFFFF', // :872
    bgAlpha: 100, // :873（百分比）
    // `#249` 背景图片三套（与 bgStr 对称）。默认 null = 不用图（此前 Web 只有颜色背景）
    bgImgPath: null,
    bgImgPathNight: null,
    bgImgPathEInk: null,
    textColor: '#3E3D3B', // :880
    textColorNight: '#ADADAD', // :881
    textColorEInk: '#000000', // :882
    textAccentColor: '#E53935', // :883
    textAccentColorNight: '#FE4D55', // :884
    textAccentColorEInk: '#000000', // :885
    paddingTop: 6, // :921
    paddingLeft: 16, // :919
    paddingRight: 16, // :920
    paddingBottom: 6, // :918
    titleMode: 0, // :896（0 居左）
    titleColor: null, // :898（0 = 跟随正文色 ⇒ 本仓用 null 表达）
    titleTopSpacing: 0, // :903
    titleBottomSpacing: 0, // :904
    titleLineSpacingExtra: 0, // :894
    underlineMode: 0, // :906（0 = 关）
    underlineColor: null, // :907（0 = 跟随正文色 ⇒ null）
    underlineWidth: 1, // :909 / DEFAULT_UNDERLINE_WIDTH :48
    underlineDistance: 4, // :910 / DEFAULT_UNDERLINE_DISTANCE :51
    underlineBodyEnabled: true, // :911
    underlineTitleEnabled: true, // :912
    // ── 页眉 / 页脚（`#221`）：逐条抄 `ReadBookConfig.kt:922-948`；★ 标了「本仓」的是有意差异
    headerMode: 0, // :947（0 = 自动隐藏 —— Web 映射为「向下滚动时收起」，见接口注释）
    footerMode: 0, // :948（0 = 显示）
    tipHeaderLeft: READ_TIP.bookName, // :932（上游默认 time；★ 本仓默认「书名」）
    tipHeaderMiddle: READ_TIP.none, // :933
    tipHeaderRight: READ_TIP.chapterTitle, // :934（上游默认 battery；★ 本仓默认「章节名」）
    tipFooterLeft: READ_TIP.chapterTitle, // :935
    tipFooterMiddle: READ_TIP.none, // :936
    tipFooterRight: READ_TIP.pageAndTotal, // :937
    tipHeaderLeftTemplate: null, // :938（null = 用信息位的默认模板）
    tipHeaderMiddleTemplate: null, // :939
    tipHeaderRightTemplate: null, // :940
    tipFooterLeftTemplate: null, // :941
    tipFooterMiddleTemplate: null, // :942
    tipFooterRightTemplate: null, // :943
    tipTextSize: 12, // :944
    tipColor: null, // :945（0 = 跟随正文色 ⇒ null）
    tipDividerColor: null, // :946（-1 = 跟随正文色 ⇒ null）
    headerPaddingTop: 0, // :925
    headerPaddingLeft: 16, // :923
    headerPaddingRight: 16, // :924
    headerPaddingBottom: 0, // :922
    footerPaddingTop: 6, // :929
    footerPaddingLeft: 16, // :927
    footerPaddingRight: 16, // :928
    footerPaddingBottom: 6, // :926
    showHeaderLine: false, // :930
    showFooterLine: true, // :931
    // ── `#235` 页眉/页脚独立样式：默认全 `null`/`solid` ⇒ **行为与上游一字不差**
    //    （null = 回落到 tipTextSize / tipColor / tipDividerColor）
    headerTextSize: null,
    headerTextColor: null,
    headerDividerColor: null,
    footerTextSize: null,
    footerTextColor: null,
    footerDividerColor: null,
    headerLineStyle: TIP_LINE_STYLE.solid, // :235（上游只有实线）
    footerLineStyle: TIP_LINE_STYLE.solid, // :235
    // ── `#250` 栏位透明：默认全透明 ⇒ 背景图铺满整个阅读界面（与上游观感一致）
    toolbarTransparent: true,
    toolbarAlpha: 100,
    headerTransparent: true,
    headerAlpha: 100,
    footerTransparent: true,
    footerAlpha: 100,
    // ── 界面主题 / 封面配置（`#163`）
    // ★ **两个槽的默认值都是「深色（本仓）」而不是上游那套亮色 `默认`** —— 这是**刻意**的：
    //   本仓界面的原生观感就是暗色（`styles/theme.css` 的 OmniFlow token）；
    //   若日间槽默认成上游的 `默认`（背景 `#F5F5F5` 亮色），那么 `themeMode` 默认 `"0"`（跟随系统）
    //   在**系统偏好浅色**的机器上会让整个界面突然变亮 —— 用户什么都没做，界面却变了一次，
    //   而这不是 `#163` 要的效果。上游的 4 套在 {@link UI_THEME_PRESETS} 里原样提供，用户想切随时切。
    uiDayTheme: { ...UI_THEME_PRESETS[0]! },
    uiNightTheme: { ...UI_THEME_PRESETS[0]! },
    uiThemes: UI_THEME_PRESETS.map((t) => ({ ...t })),
    cover: emptyUiCoverConfig(),
  };
}

/**
 * **稳定性 JSON 序列化**（键排序）—— 专门给「默认值比较」用的，不是通用序列化。
 *
 * 为什么不用 `JSON.stringify` 直接比：对象键序不保证一致（服务端 merge / 旧数据回读都会变序），
 * `{a:1,b:2}` 与 `{b:2,a:1}` 语义相同、串却不等 —— `#145` 在 `stores/reader.ts` 的注释里已经踩过这条。
 */
function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/**
 * **补齐 `GlobalReaderPrefs` 的嵌套默认值**。
 *
 * ## 为什么必须做（而不是 `{ ...默认, ...传来的 }` 一层就够）
 * `#163` 起这个对象里有**嵌套**结构（`cover` / `uiDayTheme` / `uiNightTheme` / `uiThemes`）。
 * 旧版本落库的 prefs JSON **没有这些键**，一层 spread 只会把「顶层键」补上、嵌套的仍是 `undefined`
 * ⇒ 前端读 `prefs.value.cover.xxx` 直接 `TypeError`，而且症状是「设置页一片空白」而不是报错指向根因。
 *
 * 三处消费点（**都要走这里，别各写一份**）：
 * · `packages/core/src/user-store/sqlite.ts` 的 `readPrefs()`（**SQLite 落库的旧数据没有新键**）；
 * · `packages/core/src/user-store/json.ts` 的文档装载（同上）；
 * · 前端 `hydratePrefs()`（旧服务端 + 新前端的双保险）。
 */
export function fillGlobalReaderPrefs(v: unknown): GlobalReaderPrefs {
  const d = emptyGlobalReaderPrefs();
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return d;
  const p = v as Partial<GlobalReaderPrefs>;
  return {
    ...d,
    ...p,
    uiDayTheme: { ...d.uiDayTheme, ...(p.uiDayTheme ?? {}) },
    uiNightTheme: { ...d.uiNightTheme, ...(p.uiNightTheme ?? {}) },
    // uiThemes 是数组：整体以传来的为准，但每一项仍要补齐 9 个字段
    uiThemes: Array.isArray(p.uiThemes)
      ? p.uiThemes.map((t) => ({ ...emptyUiThemeConfig(), ...(t ?? {}) }))
      : d.uiThemes,
    cover: { ...d.cover, ...(p.cover ?? {}) },
  };
}

/**
 * 「这份偏好**还等于默认值**吗」—— 即「服务端/用户**从没存过**」的判据。
 *
 * ⚠️ `#163` 起有嵌套结构 ⇒ **不能再用 `Object.keys(d).forEach(k => got[k] !== d[k])` 的浅比较**：
 * 嵌套对象按引用比较恒不相等 ⇒ 永远判「非默认」⇒ 「一次性搬迁」永远不触发，
 * 表现为「换设备/换浏览器后偏好不跟走」，且不报任何错。
 * `stores/reader.ts` 里那份浅比较就是 `#145` 留下的，已随 `#163` 改走这里。
 */
export function isDefaultGlobalReaderPrefs(v: unknown): boolean {
  return stableStringify(fillGlobalReaderPrefs(v)) === stableStringify(emptyGlobalReaderPrefs());
}

/* ------------------------------------------------------------------ *
 * 十一之三、阅读样式：**可覆盖字段的唯一清单**（`#164`）
 * ------------------------------------------------------------------ */

/**
 * 「阅读样式」的全部字段名 —— **全局默认** 与 **每本覆盖** 都只作用于这一集合。
 *
 * ## 为什么要有这份清单（而不是「反正都是 `GlobalReaderPrefs` 的键」）
 * `GlobalReaderPrefs` 里**混着两类东西**（`#163` 起）：
 *  · **阅读样式**（正文用：字号 / 行距 / 背景 / 文字色 / 边距 / 标题 / 下划线）；
 *  · **界面主题 / 封面 / 阅读行为**（`uiDayTheme` / `uiThemes` / `cover` / `themeMode` /
 *    `chineseConverterType` / `bookshelfSort` / `replaceEnableDefault` / `readBodyToLh` / 音频三项）。
 * 「每本书可覆盖」只对**第一类**成立 —— 比如「这本书用夜间配色」是合理的，
 * 「这本书用另一套界面主题」「这本书单独设置简繁转换」就荒谬了（那是应用级偏好）。
 * ⇒ **用白名单显式划界**，而不是把整个 `GlobalReaderPrefs` 都做成可覆盖。
 *
 * ⚠️ 新增阅读样式字段时**必须**同步加进这里，否则它在「每本覆盖」里**静默失效**
 * （表现是「阅读界面改了、退出去再进来又变回去」）—— 回归锁 `read-style.test.ts` 会盯着这件事。
 */
export const READ_STYLE_KEYS = [
  // ── 排版（`#145` 已落地的 9 项）
  'textSize',
  'titleSize',
  'textBold',
  'letterSpacing',
  'lineSpacingExtra',
  'paragraphSpacing',
  'paragraphIndent',
  'textFont',
  'titleFont',
  // ── 翻页动画（`PageAnim.kt:9-17`）
  'pageAnim',
  // ── 背景（`#164`）
  'bgStr',
  'bgStrNight',
  'bgStrEInk',
  'bgAlpha',
  // `#249` 背景图片（3 套，与 bgStr 对称）
  'bgImgPath',
  'bgImgPathNight',
  'bgImgPathEInk',
  // ── 文字颜色（`#164`）
  'textColor',
  'textColorNight',
  'textColorEInk',
  'textAccentColor',
  'textAccentColorNight',
  'textAccentColorEInk',
  // ── 正文边距（`#164`）
  'paddingTop',
  'paddingLeft',
  'paddingRight',
  'paddingBottom',
  // ── 标题（`#164`）
  'titleMode',
  'titleColor',
  'titleTopSpacing',
  'titleBottomSpacing',
  'titleLineSpacingExtra',
  // ── 下划线（`#164`）
  'underlineMode',
  'underlineColor',
  'underlineWidth',
  'underlineDistance',
  'underlineBodyEnabled',
  'underlineTitleEnabled',
  // ── 页眉 / 页脚（`#221`）：`ReadBookConfig.kt:922-948`
  'headerMode',
  'footerMode',
  'tipHeaderLeft',
  'tipHeaderMiddle',
  'tipHeaderRight',
  'tipFooterLeft',
  'tipFooterMiddle',
  'tipFooterRight',
  'tipHeaderLeftTemplate',
  'tipHeaderMiddleTemplate',
  'tipHeaderRightTemplate',
  'tipFooterLeftTemplate',
  'tipFooterMiddleTemplate',
  'tipFooterRightTemplate',
  'tipTextSize',
  'tipColor',
  'tipDividerColor',
  'headerPaddingTop',
  'headerPaddingLeft',
  'headerPaddingRight',
  'headerPaddingBottom',
  'footerPaddingTop',
  'footerPaddingLeft',
  'footerPaddingRight',
  'footerPaddingBottom',
  'showHeaderLine',
  'showFooterLine',
  // `#235` 页眉/页脚独立样式 + 线型
  'headerTextSize',
  'headerTextColor',
  'headerDividerColor',
  'footerTextSize',
  'footerTextColor',
  'footerDividerColor',
  'headerLineStyle',
  'footerLineStyle',
  // `#250` 栏位透明（标题栏 / 页眉 / 页脚）
  'toolbarTransparent',
  'toolbarAlpha',
  'headerTransparent',
  'headerAlpha',
  'footerTransparent',
  'footerAlpha',
] as const;

/**
 * **页眉 / 页脚信息位**（`ReadTipConfig.kt:12-23` 的常量，取值原样照抄）。
 *
 * 上游的 `tipValues`（`:25-28`）里带 `battery` / `batteryPercentage` / `timeBattery` /
 * `timeBatteryPercentage` 四项 —— 它们依赖**电量**：Web 上只有部分浏览器实现了
 * `navigator.getBattery()` ⇒ **保留常量**（照抄契约），但**不进默认模板**，取不到电量时渲染成空串
 * （不给「假数字」比显示一个 0% 更诚实）。
 *
 * ## `textLength`（本仓扩展，用户 2026-10-04 Add）
 *
 * 用户要的是「页眉/页脚的信息位下拉里多一个『正文字数』」⇒ 它是一个**新信息位**，
 * 不只是多一个占位符。取值规则（★ 不猜，读上游定）：
 *  · 上游 `0..11` **已经全占满**（`none`0 / `chapterTitle`1 / `time`2 / `battery`3 / `page`4 /
 *    `totalProgress`5 / `pageAndTotal`6 / `bookName`7 / `timeBattery`8 / `timeBatteryPercentage`9 /
 *    `batteryPercentage`10 / `totalProgress1`11）⇒ `12` 是第一个空号，取它。
 *  · **不插空号**（比如挪用 `3`）：`battery=3` 是上游在用的，撞上会让老配置的语义当场改变。
 * ⚠️ **兼容性**（导出配置给上游）：上游 `ReaderInfoTemplate.fromLegacy` 的兜底是 `else -> ""`
 *   ⇒ 上游看到 `12` 只是**渲染成空串**，不崩、不报错。反向（上游将来也用 12）要以导入导出为准再对齐。
 */
export const READ_TIP = {
  none: 0,
  chapterTitle: 1,
  time: 2,
  battery: 3,
  page: 4,
  totalProgress: 5,
  pageAndTotal: 6,
  bookName: 7,
  timeBattery: 8,
  timeBatteryPercentage: 9,
  batteryPercentage: 10,
  totalProgress1: 11,
  /** 本章正文字数（本仓扩展，上游无此位；见上方 `textLength` 段） */
  textLength: 12,
} as const;
export type ReadTipValue = (typeof READ_TIP)[keyof typeof READ_TIP];

/**
 * `#235` 分隔线型（**本仓 Web 端增强，上游没有**）。
 *
 * 上游 `PageView.kt:129-130` 的 divider 就是一条 `backgroundColor` 实色条 —— 也就是说
 * `solid` 才是「与上游一致」的那一档，其余四档是 CSS 能力（虚线/点线/双线/波浪）。
 * ⚠️ 枚举值用**字符串**而不是数字：以后要加档位不会打乱已有配置的语义。
 */
export const TIP_LINE_STYLE = {
  /** 实线（默认；= 上游那条实色条） */
  solid: 'solid',
  /** 虚线 */
  dashed: 'dashed',
  /** 点线 */
  dotted: 'dotted',
  /** 双线（两条细线 + 一条间隙） */
  double: 'double',
  /** 波浪线（`repeating-linear-gradient` 画锯齿；`repeating-radial-gradient` 画连续波） */
  wave: 'wave',
} as const;
export type TipLineStyle = (typeof TIP_LINE_STYLE)[keyof typeof TIP_LINE_STYLE];

export const TIP_LINE_STYLE_OPTIONS: ReadonlyArray<{ value: TipLineStyle; label: string }> = [
  { value: TIP_LINE_STYLE.solid, label: '实线' },
  { value: TIP_LINE_STYLE.dashed, label: '虚线' },
  { value: TIP_LINE_STYLE.dotted, label: '点线' },
  { value: TIP_LINE_STYLE.double, label: '双线' },
  { value: TIP_LINE_STYLE.wave, label: '波浪线' },
];

/** 未知值（老配置/手改 JSON）⇒ 回落到 `solid`，**不抛** —— 样式不该把阅读界面搞崩 */
export function normaliseTipLineStyle(v: unknown): TipLineStyle {
  const s = String(v ?? '').trim().toLowerCase();
  return (TIP_LINE_STYLE_OPTIONS.some((o) => o.value === s) ? s : TIP_LINE_STYLE.solid) as TipLineStyle;
}

/**
 * `#235` 读出「某一侧」实际生效的字号（独立值 → 上游共用值 → 12）。
 *
 * ★ 为什么要这一层回落而不是直接读字段：`headerTextSize` 默认 `null`，
 *   绝大多数用户的配置里它就是 `null` ⇒ 界面上显示/改的必须是**真正生效的那个值**，
 *   否则用户会看到「字号 5」但实际是 12（改一个不生效的字段，最难查）。
 *   导出为纯函数是为了能单测这层回落。
 */
export function tipTextSizeOf(s: Pick<GlobalReaderPrefs, 'tipTextSize' | 'headerTextSize' | 'footerTextSize'>, zone: 'header' | 'footer'): number {
  const own = zone === 'header' ? s.headerTextSize : s.footerTextSize;
  if (typeof own === 'number' && Number.isFinite(own)) return Math.min(50, Math.max(5, Math.round(own)));
  return Math.min(50, Math.max(5, Math.round(Number(s.tipTextSize) || 12)));
}

/** `#235` 某一侧实际生效的文字色（独立值 → 上游共用值 → `null`＝跟随正文色） */
export function tipColorOf(
  s: Pick<GlobalReaderPrefs, 'tipColor' | 'headerTextColor' | 'footerTextColor'>,
  zone: 'header' | 'footer',
): string | null {
  const own = zone === 'header' ? s.headerTextColor : s.footerTextColor;
  if (typeof own === 'string' && own !== '') return own;
  return s.tipColor ?? null;
}

/** `#235` 某一侧实际生效的分隔线色（独立值 → 上游共用值 → `null`＝跟随正文色） */
export function tipDividerColorOf(
  s: Pick<GlobalReaderPrefs, 'tipDividerColor' | 'headerDividerColor' | 'footerDividerColor'>,
  zone: 'header' | 'footer',
): string | null {
  const own = zone === 'header' ? s.headerDividerColor : s.footerDividerColor;
  if (typeof own === 'string' && own !== '') return own;
  return s.tipDividerColor ?? null;
}

/**
 * 信息位的人读名（界面下拉用；**前 12 项的顺序照抄上游 `tipValues`**，最后一项是本仓扩展）。
 *
 * ★ 位置：前 12 项与上游 `ReadTipConfig.tipValues`（`:25-28`）+ `R.array.read_tip` **一一对应**
 *   ⇒ 界面上看到的下拉顺序与上游一致。`{正文字数}` 是**本仓新增的信息位**，
 *   追加在**末尾**（不插队）—— 插在中间会让「上游第 N 项」与「本仓第 N 项」错位，
 *   以后照着上游截图核对界面就会对不上。
 */
export const READ_TIP_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: READ_TIP.none, label: '不显示' },
  { value: READ_TIP.bookName, label: '书名' },
  { value: READ_TIP.chapterTitle, label: '章节名' },
  { value: READ_TIP.time, label: '时间' },
  { value: READ_TIP.battery, label: '电量图标' },
  { value: READ_TIP.batteryPercentage, label: '电量百分比' },
  { value: READ_TIP.page, label: '页码/总页数' },
  { value: READ_TIP.totalProgress, label: '阅读进度' },
  { value: READ_TIP.totalProgress1, label: '章节序号/总数' },
  { value: READ_TIP.pageAndTotal, label: '页码 + 阅读进度' },
  { value: READ_TIP.timeBattery, label: '时间 + 电量图标' },
  { value: READ_TIP.timeBatteryPercentage, label: '时间 + 电量' },
  // ↓ 本仓扩展（上游没有；取值为 12，见 `READ_TIP` 的注释）
  { value: READ_TIP.textLength, label: '正文字数' },
];

/**
 * 模板占位符（上游 `ReaderInfoTemplate.kt:31-40` 的 10 个 + **本仓追加 `{正文字数}`**）。
 *
 * ★ 顺序 = 上游 `ReaderInfoTemplate.placeholders` 的顺序，本仓新增的**追加在末尾**
 *   ⇒ 界面上「可用占位符：…」那一行的排列与上游一致，新增项一眼能看出是本仓的。
 */
export const READER_INFO_PLACEHOLDERS = {
  bookName: '{书名}',
  chapterTitle: '{章节}',
  time: '{时间}',
  battery: '{电量}',
  batteryIcon: '{电量图标}',
  page: '{页码}',
  totalPages: '{总页数}',
  readProgress: '{阅读进度}',
  chapter: '{章节序号}',
  totalChapters: '{章节总数}',
  /** 本仓扩展（上游无此占位符；与信息位 `READ_TIP.textLength` 配对） */
  textLength: '{正文字数}',
} as const;

/** 模板取值 */
export interface ReaderInfoValues {
  bookName?: string;
  chapterTitle?: string;
  time?: string;
  /** 0–100；**拿不到就传 `null`**（渲染成空串，不显示假电量） */
  battery?: number | null;
  page?: string;
  totalPages?: string;
  readProgress?: string;
  chapter?: string;
  totalChapters?: string;
  /**
   * 本章正文字数（本仓扩展）。
   *
   * ★ **传字符串而不是数字**：占位符替换是纯文本拼接，上游 `ReaderInfoValues` 里
   *   `page` / `totalPages` / `chapter` 这些也全是 `String` —— 沿用同一形状，
   *   不要在渲染里做 `String(n)`（那会把「拿不到」和「0 字」混成同一个 `'0'`）。
   *   拿不到就**不传**（`undefined`）⇒ 渲染成空串。
   */
  textLength?: string;
}

/**
 * 信息位 → **默认模板**（上游 `ReaderInfoTemplate.kt:118-129` 的 `fromLegacy`，逐条照抄）。
 *
 * 用途：用户没写自定义模板时（`tip*Template === null`）用它渲染，
 * 与上游 `ReadTipConfig.effectiveTemplate(template, legacyTip)`（`:107-108`）同一语义。
 *
 * ★ 本仓扩展：`READ_TIP.textLength` ⇒ `{正文字数}`。
 *   上游 `fromLegacy` 对未知值的兜底是 `else -> ""`（**不是报错**）⇒ 我们的默认分支
 *   与上游语义一致：`none` 和「任何认不出的值」都返回空串。
 */
export function readTipDefaultTemplate(tip: number): string {
  const P = READER_INFO_PLACEHOLDERS;
  switch (tip) {
    case READ_TIP.chapterTitle: return P.chapterTitle;
    case READ_TIP.time: return P.time;
    case READ_TIP.battery: return P.batteryIcon;
    case READ_TIP.batteryPercentage: return P.battery;
    case READ_TIP.page: return `${P.page}/${P.totalPages}`;
    case READ_TIP.totalProgress: return P.readProgress;
    case READ_TIP.pageAndTotal: return `${P.page}/${P.totalPages}  ${P.readProgress}`;
    case READ_TIP.bookName: return P.bookName;
    case READ_TIP.timeBattery: return `${P.time}  ${P.batteryIcon}`;
    case READ_TIP.timeBatteryPercentage: return `${P.time} ${P.battery}`;
    case READ_TIP.totalProgress1: return `${P.chapter}/${P.totalChapters}`;
    // ★ `#265`（用户 2026-10-04）：默认展示要带「正文字数：」前缀 —— 光一个裸数字（如「819」）
    //   看不出是什么；上游同类信息位也都自带语境（如 `{页}/{总页}`）。自定义模板不受影响（仍是裸占位符）。
    case READ_TIP.textLength: return `正文字数：${P.textLength}`; // 本仓扩展
    default: return ''; // none（以及任何认不出的值 —— 与上游 `else -> ""` 同语义）
  }
}

/**
 * **渲染页眉/页脚模板**（对齐 `ReaderInfoTemplate.kt:44-116` 的 `parse`）。
 *
 * ⚠️ 三处与上游的**有意**差异：
 *  ① 上游返回 `List<ReaderInfoPart>`（文本片段 + 电量图标对象，要画一个 battery drawable）；
 *     Web 只返回**一个字符串** —— 电量图标退化成 `🔋` 文本（电池矢量图是 Android 资源，Web 没有）。
 *  ② 上游 `{电量}` 拿不到时会怎样没定义；本仓 `battery` 传 `null` ⇒ 渲染成**空串**（不编造电量）。
 *  ③ **本仓扩展 `{正文字数}`**（上游没有这个占位符）⇒ `values.textLength`；
 *     没传就是空串。★ 它**不会**和「未知占位符」混淆：未知的仍然原样吐回去。
 *
 * 未闭合的 `{`、嵌套花括号、未知占位符 ⇒ **原样输出**（与上游 `appendText(token)` 一致），
 * 这样用户写错了能立刻在界面上看见自己写的原文，而不是看到一片空白。
 */
export function renderReaderInfoTemplate(template: string, values: ReaderInfoValues): string {
  let out = '';
  let i = 0;
  const battery = values.battery == null ? null : Math.max(0, Math.min(100, values.battery));
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '{') { out += ch; i += 1; continue; }
    // 找配对的 `}`（处理嵌套：depth 归零才算闭合）
    let depth = 0;
    let close = -1;
    let nested = false;
    let cur = i;
    while (cur < template.length) {
      const c = template[cur];
      if (c === '{') { depth += 1; if (depth > 1) nested = true; }
      else if (c === '}') { depth -= 1; if (depth === 0) { close = cur; break; } }
      cur += 1;
    }
    if (close < 0) { out += '{'; i += 1; continue; } // 没闭合 ⇒ 原样吐出开头的 `{`
    const token = template.slice(i, close + 1);
    const touchesOuter =
      (i > 0 && template[i - 1] === '{') ||
      (close + 1 < template.length && template[close + 1] === '}');
    const P = READER_INFO_PLACEHOLDERS;
    if (nested || touchesOuter) out += token; // `{{...}}` 之类：不是占位符 ⇒ 原样
    else if (token === P.bookName) out += values.bookName ?? '';
    else if (token === P.chapterTitle) out += values.chapterTitle ?? '';
    else if (token === P.time) out += values.time ?? '';
    else if (token === P.battery) out += battery == null ? '' : `${battery}%`;
    else if (token === P.batteryIcon) out += battery == null ? '' : '🔋';
    else if (token === P.page) out += values.page ?? '';
    else if (token === P.totalPages) out += values.totalPages ?? '';
    else if (token === P.readProgress) out += values.readProgress ?? '';
    else if (token === P.chapter) out += values.chapter ?? '';
    else if (token === P.totalChapters) out += values.totalChapters ?? '';
    else if (token === P.textLength) out += values.textLength ?? ''; // 本仓扩展
    else out += token; // 未知占位符 ⇒ 原样
    i = close + 1;
  }
  return out;
}

/** 阅读样式字段名 */
export type ReadStyleKey = (typeof READ_STYLE_KEYS)[number];

/** 从全局偏好里取出的「阅读样式」子集（**全部必填**） */
export type ReadStyle = Pick<GlobalReaderPrefs, ReadStyleKey>;

/**
 * **每本书的阅读样式覆盖**（存 {@link ShelfBook.readStyle}）。
 *
 * ⚠️ 每个键都 `?` —— 「没写」= 跟随全局。**不要**用 `null` 表示「跟随」：
 * `null` 在 `titleColor` / `underlineColor` 上**本身就是一个有意义的取值**（= 跟随正文色），
 * 两者混起来就分不清「没设置」和「设置为跟随」了。所以：
 *  · 键**不存在** ⇒ 不覆盖；
 *  · 键 = `null` ⇒ 覆盖成「跟随正文色」（仅 `titleColor` / `underlineColor` 有此取值）。
 */
export type ReadStyleOverride = Partial<ReadStyle>;

/**
 * 从任意对象里**只挑出**阅读样式的键（丢开界面主题/封面/行为项）。
 *
 * 用途：`GlobalReaderPrefs` → {@link ReadStyle}（渲染层只需要这一小块）；
 * **未给的键不出现在结果里**（配合 {@link mergeReadStyle} 才能表达「不覆盖」）。
 */
export function pickReadStyle(v: unknown): ReadStyleOverride {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of READ_STYLE_KEYS) {
    // ⚠️ 判的是 `k in src` 而不是 `src[k] !== undefined`：两者在 JSON 往返后等价，
    //    但显式写了 `undefined` 的键在这里也该被跳过（它不携带信息）。
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out as ReadStyleOverride;
}

/**
 * **合并规则唯一实现**：生效阅读样式 = `全局默认` ⊕ `每本覆盖`。
 *
 * · 逐键覆盖，**只有 `override` 里存在的键**才生效（`undefined` 不算存在）；
 * · `override` 里的 `null` **是有效值**，会真的覆盖（见 {@link ReadStyleOverride} 的说明）；
 * · `global` 不完整时用 {@link emptyGlobalReaderPrefs} 补齐（旧数据 / 局部对象）。
 *
 * ⚠️ 别在组件或 store 里再写一份 `{ ...global, ...override }`：**那是 `undefined` 也会覆盖的版本**
 * （`{...a, b: undefined}` 会把 `a.b` 抹成 `undefined`），于是「只覆盖了字号」会顺手把颜色清空。
 */
/**
 * ★★ `#248` **读取侧的唯一判据**：勾了「共用布局」就**不读**本书覆盖，否则读。
 *
 * ## 为什么必须是函数、而不是各调用点自己写 `if`
 * `#247` 只修了**写侧**（面板提交时看开关），**读取侧漏了** ——
 * `readStyle = mergeReadStyle(prefs, bookOverride)` 恒按「全局 ⊕ 覆盖」叠加、
 * **完全不看 `shareLayout`** ⇒ 用户实测「**只有『病宠成瘾』这一本样式不生效**」：
 * 那本书被点过一次预设、写下了 9 个键的覆盖，之后改全局对它毫无影响；
 * 而其余书 `readStyle` 为 `null` ⇒ 全部跟全局 ⇒ 全部生效。
 * 「写侧改了、读侧没改」这种半截实现，用**一个共用函数**钉住才不会再次漂移。
 *
 * ## 上游依据（`ReadBookConfig.kt:434`）
 * `val config get() = if (shareLayout) shareConfig else durConfig`
 * —— 上游是**二选一**：共用时**根本不读** `durConfig`，不是「读了再被覆盖」。
 *
 * @param shareLayout  `prefs.shareLayout`
 * @param bookOverride 这本书的覆盖（`ShelfBook.readStyle`；`null`/未给 = 没有）
 * @returns 传给 {@link mergeReadStyle} 的那个 override（`null` = 纯全局）
 */
export function effectiveReadStyleOverride(
  shareLayout: boolean,
  bookOverride?: ReadStyleOverride | null,
): ReadStyleOverride | null {
  // ★ 不是「删除覆盖」，只是「这一轮不读它」—— 用户取消共用后覆盖应当原样回来
  return shareLayout ? null : (bookOverride ?? null);
}

export function mergeReadStyle(global: unknown, override?: ReadStyleOverride | null): ReadStyle {
  const g = pickReadStyle(fillGlobalReaderPrefs(global)) as Record<string, unknown>;
  const o = override && typeof override === 'object' ? override : {};
  const out: Record<string, unknown> = { ...g };
  for (const k of READ_STYLE_KEYS) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as ReadStyle;
}

/* ------------------------------------------------------------------ *
 * 十一之二、各实体的默认值工厂（**唯一来源**）
 * ------------------------------------------------------------------ */

/**
 * 为什么要有这些工厂：服务端 REST 端点/前端迁移期会收到**不完整**的对象，
 * 需要在缺字段时补默认值。若在端点里手写字面量，默认值就会分散到多处漂移
 * （本文件已锁字段数，但**默认值漂移**是另一类更隐蔽的 bug）。
 * 因此：**新建对象一律用工厂**，不要在业务代码里手写 `{ time: Date.now(), ... }`。
 */

/** {@link Bookmark} 默认值（`Bookmark.kt:14-24`） */
export function emptyBookmark(now: number = Date.now()): Bookmark {
  return {
    time: now,
    bookName: '',
    bookAuthor: '',
    chapterIndex: 0,
    chapterPos: 0,
    chapterName: '',
    bookText: '',
    content: '',
  };
}

/** {@link BookHighlight} 默认值（`BookHighlight.kt:20-38`；注意 `layoutTitleLength` 是 -1 哨兵） */
export function emptyBookHighlight(now: number = Date.now()): BookHighlight {
  return {
    time: now,
    bookUrl: '',
    chapterUrl: '',
    bookName: '',
    bookAuthor: '',
    chapterIndex: 0,
    chapterPos: 0,
    chapterPosEnd: 0,
    layoutTitleLength: UNKNOWN_TITLE_LENGTH,
    chapterName: '',
    bookText: '',
    style: '',
    note: '',
  };
}

/** {@link BookMemo} 默认值 */
export function emptyBookMemo(now: number = Date.now()): BookMemo {
  return {
    time: now,
    bookUrl: '',
    bookName: '',
    bookAuthor: '',
    chapterIndex: 0,
    chapterPos: 0,
    chapterName: '',
    bookText: '',
    title: '',
    content: '',
  };
}

/** {@link SearchHistoryEntry} 默认值 */
export function emptySearchHistoryEntry(word = '', now: number = Date.now()): SearchHistoryEntry {
  return { word, lastUseTime: now, usage: 1 };
}

/** {@link ReplaceRule} 默认值（`ReplaceRule.kt:26-65`；`order` 默认 `Int.MIN_VALUE`） */
export function emptyReplaceRule(id: number = Date.now()): ReplaceRule {
  return {
    id,
    name: '',
    group: null,
    pattern: '',
    replacement: '',
    scope: null,
    scopeTitle: false,
    scopeSource: false,
    scopeContent: true,
    excludeScope: null,
    isEnabled: true,
    isRegex: true,
    timeoutMillisecond: 3000,
    order: REPLACE_RULE_ORDER_DEFAULT,
  };
}

/* ---------------- `#266` 净化规则导入：解析与判重（预览 = 入库同一份实现） ----------------
 * 为什么放契约层而不是服务端：规则的**写权威在前端 store**（`useReplaceRulesStore.upsert`
 * → reconcile 全量对齐服务端）⇒ 导入提交走前端既有写路径；解析/判重做成纯函数，
 * 前端预览、服务端 URL 抓取预览、单测三方共用同一份实现，不会出现
 * 「预览说 29 条新增、导入却 0 条」那种两边各写一套的漂移。
 */

/**
 * 判重 key：**同名 + 同查找内容** ⇒ 视为同一条规则。
 *
 * ★ `replacement` **不参与判重**（`#266` 探针 C 段抓到的真缺陷）：判重若把「替换为」也算进
 *   身份，用户导入「同一条规则的修正版」（改了替换内容）会被判成**新增**，「重复 → 覆盖」
 *   永远轮不到 —— 而覆盖要改的**恰恰就是** replacement 这类内容字段。
 *   ⇒ 身份 = 「找什么」（name + pattern）；「换成什么」（replacement / scope / 开关 / 分组）
 *   都是内容，由「跳过 / 覆盖」决定去留。
 * ★ **不做 trim**：pattern 的首尾空白是有语义的（正则里 `\s`、字面量空格），trim 会把
 * 本不相同的两条误判成重复。
 */
export function replaceRuleDedupeKey(r: Pick<ReplaceRule, 'name' | 'pattern'>): string {
  return `${r.name}\u0000${r.pattern}`;
}

/** {@link dedupeReplaceRules} 的结果 */
export interface DedupeReplaceRulesResult {
  /** 去重后的列表（保持原有相对顺序） */
  rules: ReplaceRule[];
  /** 被删掉的重复条目（含其 id，供调用方留痕/上报） */
  removed: ReplaceRule[];
}

/**
 * 按 {@link replaceRuleDedupeKey} 去重净化规则（用户 2026-10-04：先把现有库去重）。
 *
 * ★ **保留哪条 = 用户在界面上看到的顺序**（`order` 升序、`order` 相同比 `id`）——
 * 重复条目通常是后导入的（排在后面），保留最前面那条最不意外。
 * `#191` 的合并按**数字 id** 判「本地独有」⇒ 只删服务端一份会被 localStorage 里另一份 id
 * 复活 ⇒ 去重必须做在前端 store（写权威），去重后的全量再 reconcile 推回去。
 */
export function dedupeReplaceRules(list: readonly ReplaceRule[]): DedupeReplaceRulesResult {
  const sorted = list.slice().sort((a, b) => a.order - b.order || a.id - b.id);
  const seen = new Set<string>();
  const keepIds = new Set<number>();
  const removed: ReplaceRule[] = [];
  for (const r of sorted) {
    const k = replaceRuleDedupeKey(r);
    if (seen.has(k)) {
      removed.push(r);
    } else {
      seen.add(k);
      keepIds.add(r.id);
    }
  }
  return { rules: list.filter((r) => keepIds.has(r.id)), removed };
}

/** 导入解析结果（不含判重 —— 判重要对照「现有库」，由调用方拿 {@link replaceRuleDedupeKey} 做） */
export interface ReplaceRuleImportParse {
  /** 解析出的候选条目总数（含错误条） */
  parsedTotal: number;
  /** 规范化后的规则（`id` 恒为 0 占位 —— 真实 id 由提交方在入库那一刻分配） */
  rules: ReplaceRule[];
  errors: Array<{ index: number; reason: string }>;
  /** 原文前 140 字符（UI 预览） */
  preview: string;
}

/** 布尔字段宽容化：接受 true/false、1/0、"true"/"false"、"1"/"0"（Legado 导出常是布尔，手写清单常是数字） */
function importBool(v: unknown, dflt: boolean): boolean {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return dflt;
}

/**
 * 解析净化规则导入文本（用户 2026-10-04 `#266`）。
 *
 * 接受：规则对象 / 规则对象数组（字段名 = 本仓契约 = 上游 `ReplaceRule.kt` 的 Kotlin 字段名
 * —— 上游实体没有 `@SerializedName`，序列化键就是字段名，两边天然同名）。
 * 缺省字段取 {@link emptyReplaceRule} 的默认值；`pattern` 为空 ⇒ 该条记为**错误**
 * （空规则永不生效，本仓编辑对话框也禁止保存空 pattern —— 同一条纪律）。
 * ⚠️ **不信任输入里的 `id` / `order`**：id 撞上现有库会把无关规则整条覆盖；
 * order 是库内全量排序的槽位，导入件里的值没有意义 ⇒ 两者一律丢弃，入库时重新分配。
 */
export function parseReplaceRuleImport(input: string | unknown): ReplaceRuleImportParse {
  const preview = typeof input === 'string' ? input.trim().slice(0, 140) : JSON.stringify(input ?? '').slice(0, 140);
  let parsed: unknown = input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (!t) {
      return { parsedTotal: 0, rules: [], errors: [{ index: 0, reason: '内容为空' }], preview };
    }
    try {
      parsed = JSON.parse(t);
    } catch {
      return {
        parsedTotal: 0,
        rules: [],
        errors: [{ index: 0, reason: '不是合法的规则 JSON（应为净化规则对象或其数组）' }],
        preview,
      };
    }
  }
  const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const rules: ReplaceRule[] = [];
  const errors: Array<{ index: number; reason: string }> = [];
  const base = emptyReplaceRule(0);
  list.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      errors.push({ index: i + 1, reason: `第 ${i + 1} 条不是 JSON 对象` });
      return;
    }
    const o = it as Record<string, unknown>;
    const pattern = typeof o['pattern'] === 'string' ? o['pattern'] : o['pattern'] == null ? '' : String(o['pattern']);
    if (!pattern) {
      errors.push({ index: i + 1, reason: `第 ${i + 1} 条缺少 pattern（查找内容）—— 空规则永不生效` });
      return;
    }
    const strOf = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
    const nulOrStr = (k: string): string | null => {
      const s = strOf(k).trim();
      return s ? s : null;
    };
    const t = Number(o['timeoutMillisecond']);
    rules.push({
      ...base,
      name: strOf('name'),
      group: nulOrStr('group'),
      pattern,
      replacement: strOf('replacement'),
      scope: nulOrStr('scope'),
      scopeTitle: importBool(o['scopeTitle'], base.scopeTitle),
      scopeSource: importBool(o['scopeSource'], base.scopeSource),
      scopeContent: importBool(o['scopeContent'], base.scopeContent),
      excludeScope: nulOrStr('excludeScope'),
      isEnabled: importBool(o['isEnabled'], base.isEnabled),
      isRegex: importBool(o['isRegex'], base.isRegex),
      timeoutMillisecond: Number.isFinite(t) && t >= 0 ? Math.round(t) : base.timeoutMillisecond,
      order: REPLACE_RULE_ORDER_DEFAULT,
    });
  });
  return { parsedTotal: list.length, rules, errors, preview };
}

/** {@link BookGroup} 默认值（`BookGroup.kt:15-30`；`bookSort = -1` 表示跟随全局） */
export function emptyBookGroup(groupId: number = 1, groupName = ''): BookGroup {
  return {
    groupId,
    groupName,
    cover: null,
    order: 0,
    enableRefresh: true,
    show: true,
    bookSort: -1,
    onlyUpdateRead: false,
  };
}

/** {@link ReadRecord} 默认值（`ReadRecord.kt:9-21`） */
export function emptyReadRecord(deviceId: string, bookName: string, now: number = Date.now()): ReadRecord {
  return { deviceId, bookName, author: '', readTime: 0, lastRead: now };
}

/** {@link CacheEntry} 默认值（`Cache.kt:8-13`；`deadline = 0` 表示永不过期） */
export function emptyCacheEntry(key: string, value: string | null = null, deadline = 0): CacheEntry {
  return { key, value, deadline };
}

/* ------------------------------------------------------------------ *
 * 十二、与现状（localStorage）的映射与待决策
 * ------------------------------------------------------------------ */

/**
 * 现状 → 契约的字段映射（Phase 1.4 迁移时按此执行）。
 *
 * | 现状（`apps/web/src/stores/reader.ts`） | 契约字段 | 说明 |
 * |---|---|---|
 * | `ShelfBook.key`（`itemKey` 产物） | 拆为 `(origin, bookUrl)` | Web 现在把「源 + 内容标识」揉成一个字符串；服务端按 Legado 拆成 `origin`(=sourceId) 与 `bookUrl` |
 * | `ShelfBook.sourceId` | `ShelfBook.origin` | 改名对齐 Legado |
 * | `ShelfBook.payload` | `ShelfBook.variable` / 由 `bookUrl` 重新取详情 | ⚠️ Web 现在把整个 `payload` 塞进 localStorage；服务端应只存 `bookUrl` + 必要的 `variable` |
 * | `ShelfBook.title` | `name` | 改名 |
 * | `ShelfBook.cover` | `coverUrl` | 改名 |
 * | `ShelfBook.kind`（`'book'`/`'video'`） | `BookType` 位掩码（`type`） | Web 的「影视」= `BookType.video`；不要再用字符串 |
 * | `ShelfBook.lastChapter.title` | `durChapterTitle` | |
 * | `ShelfBook.lastChapter.payload` | 目录表（{@link ShelfChapter}） | 由目录重算 |
 * | `ShelfBook.lastIdx` | `durChapterIndex` | ⚠️ `lastIdx` 只是兜底，`durChapterIndex` 才是正解（配合 `durChapterPos`） |
 * | `ShelfBook.updatedAt` | `durChapterTime` | |
 * | `WatchEntry`（`yuedu-watch-history`） | 也是 `ShelfBook`（`type` 含 `video`）+ `durChapterTime` | Web 现在把「书」与「剧」分成两个数组；Legado 只有一个 `books` 表 |
 * | `readerFont`（`yuedu-reader-font`，旧默认 15，区间 12~26） | {@link GlobalReaderPrefs}.`textSize` | ✅ 一对一。⚠️ 上游 `Config.textSize` 默认是 **20** ⇒ **搬迁时「本地已有值优先」**（用户可能已经调过），**不要静默改字号**；只有本地没有时用上游默认 |
 * | `readerTheme`（`yuedu-reader-theme`，`'dark' \| 'sepia'`） | {@link GlobalReaderPrefs}.`themeMode` | ⚠️ **不是一对一**（`#145` 已落地，规则如下）：`'dark'` → `'2'` 暗色；`'sepia'` → `'1'` 亮色。理由：Legado 的 `themeMode` 只有 `跟随系统/亮/暗/墨水屏` **4 档、没有 sepia** ⇒ 不发明第 5 档。**代价**：旧的暖米色（`#f4ecd8`）观感会变成亮色。若日后要做「命名主题」那一期，上游 `预设2`（`bgStr #DDC090` / `textColor #3E3422`）就是这个暖色档，届时可找回 |
 *
 * ## 已决策（2026-09-16 用户拍板，**实现已落地** —— 结论勿再询问）
 *
 * ⚠️ **这一节原本写的是「待决策」，结论一直没有回填，导致 2026-09-25 我又把同样三条拿去问了一遍用户。**
 * 教训：**决策要落在能读到的地方**（契约注释 + 路线图两处都要写），只写一处就会重复询问。
 *
 * | # | 决策 | 实现落点（详见 `docs/移植路线图.md` §1.2「D1/D2/D3 执行结果」） |
 * |---|---|---|
 * | D1 | **保留** `(name, author)` 唯一索引 | `books` 唯一索引 + `upsertBook` 先删「另一本」再 upsert（其目录随级联删除）。**细则**：索引带 `WHERE NOT (name='' AND author='')`，排除双空占位行（Legado 从不插空书，我们可能） |
 * | D2 | **照抄**（按书名聚合，**不搞两个口径**） | `read_records` 主键 `(deviceId, bookName)`；`addReadTime` 累加并合并 `author`；`listReadRecordShows` 跨设备聚合 |
 * | D3 | **位掩码** | `group`/`type` 筛选均为 `(col & ?) > 0`，JSON 实现同构 |
 *
 * ## ⏸ 仍未决策（Phase 1.4 迁移前必须定 —— **只剩这一条**）
 *
 * **`ShelfBook.payload`（引擎 item payload）存哪？** 本契约的 `ShelfBook` 没有对应字段，
 * 而前端必须靠它才能重调引擎（`runAction(sourceId, 'detail', { id: JSON.stringify(payload) })`）。
 * 三个候选的完整对比见 `docs/archive/handover-changelog-20260928.md` §4.8c：
 *   ① 借用 `variable` 字段；② 放 `/api/user/cache`（KV）；③ 在 `ShelfBook` 加一个**显式标注为本仓扩展**的字段。
 *
 * ⚠️ 两条已核实的反对理由：
 *   · ① 会与**源脚本的命名空间**撞车 —— 语料 **10 个源**在用 `book.getVariable()/setVariable()`，
 *     而那个槽是**单独一份字符串**，无法用「再包一层命名空间」隔离（源脚本整体 parse 后取自己的字段）；
 *   · ② 有被 `POST /api/user/cache/sweep` **清掉**的风险 —— 把「必需数据」放「缓存」里是语义错位
 *     （清掉的表现是「书架里的书打不开」），且需要额外一次请求。
 */

export type UserDataMappingDoc = never;
