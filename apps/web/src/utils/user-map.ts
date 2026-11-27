/**
 * 「本仓前端模型 ↔ 服务端契约」的字段映射（Phase 1.4 / `#66`）—— **纯函数，无副作用**。
 *
 * ## 为什么单独一个文件
 * 映射要**逐字段**说清「同义 / 改名 / 丢失」，写在 store 里会被业务逻辑淹掉；
 * 放在这里可以被单测直接覆盖（`apps/web/tests/user-map.test.ts`），
 * 而且 `reader.ts` 只负责调用，不再出现第二套字段表。
 *
 * ## ⚠️ 类型为什么是 `import type`（编译期擦除）
 * `ShelfBook` / `Bookmark` 定义在 `stores/reader.ts`，而 `reader.ts` 会**运行时** import 本文件。
 * 这里用 `import type` ⇒ 编译期擦除、**不产生运行时依赖**，所以不是真的循环引用。
 * （同理 `user-data.ts` 的类型来自 `@yuedu/core/contract` 也只 `import type`，
 * 否则浏览器 bundle 里会混进 `node:sqlite`。）
 *
 * ## 契约是唯一权威
 * 所有字段名、默认值都取自 `packages/core/src/contract/user-data.ts`（照 Legado `Book.kt` /
 * `Bookmark.kt` 逐条提取，且被测试锁住字段数）。**别在这里自创字段名。**
 */
import { BookType, displayCover, emptyBookReadConfig, encodeItemKey as coreEncodeItemKey } from '@yuedu/core/contract';
import type {
  Bookmark as ContractBookmark,
  BookReadConfig,
  ShelfBook as ContractShelfBook,
} from '@yuedu/core/contract';
import type { Bookmark, ShelfBook } from '../stores/reader';

/* ------------------------------------------------------------------ *
 * 主键转义 —— 本仓的 `key` **不能**直接当契约 `bookUrl` 用（缺陷类BU）
 * ------------------------------------------------------------------ */

/**
 * 本仓 `itemKey()` 的唯一标识（`ShelfBook.key`）→ 可以安全持久化的字符串。
 *
 * ## ⚠️ 为什么必须转义（实测，不是推测）
 * `itemKey(sourceId, payload)` 返回 `` `${sourceId}\u0000${id}` `` —— **分隔符是一个 NUL**。
 * 实测（2026-09-28，探针 `scripts/probe-shelf-bm-sync.mjs` 首轮 7 条失败全部由此而来）：
 *
 * ```
 * node:sqlite › DatabaseSync：写入含 NUL 的 TEXT → 读回「在第一个 NUL 处截断」
 *   入参长度 52 → 读出长度 22，读出值 = "https://s1.example.com"
 *   但 `WHERE k = ?` 用**原值**查仍能命中 ⇒ 写入是完整的，**只有读回被切**
 * ```
 *
 * 后果：书架主键 `sourceId\0bookUrl` 存进服务端后变成 `sourceId` ⇒ 读回来
 * `key` 全错 ⇒ `hasInShelf` / 进度 / 分组全部对不上（界面表现是「书架的书互相串」）。
 * 另一个理由：JSON 回落实现（`user-store/json.ts`）不会有这个截断
 * ⇒ 两个后端行为不一致，属于「换个环境就变」的隐蔽 bug。
 *
 * ## 转义方案：可逆的百分号转义
 * `%` → `%25`（**先做**，否则会把下面生成的 `%00` 再转义一次）、`\u0000` → `%00`。
 * 全是可打印 ASCII，任何持久层/URL query/JSON 都不会碰它；且**无歧义**：
 * 字面量 `%00` 会被先转成 `%2500`，与真正的 NUL 编码 `%00` 不会混。
 * 不做 base64：那会让主键彻底不可读，排查问题时要多解一层。
 *
 * ## `#212` Step3：实现已下沉到契约层（服务端压缩包导入要用同一份）
 * 本函数改为委派 `@yuedu/core/contract` 的 `encodeItemKey()`，**对外签名不变**。
 */
export function encodeItemKey(key: string): string {
  return coreEncodeItemKey(key);
}

/** {@link encodeItemKey} 的逆运算（服务端读回时用） */
export function decodeItemKey(s: string): string {
  return s.split('%00').join('\u0000').split('%25').join('%');
}

/* ------------------------------------------------------------------ *
 * 类型（`BookType` 位掩码）↔ 本仓 `kind` 字符串
 * ------------------------------------------------------------------ */

/**
 * 本仓 `kind` → 契约 `ShelfBook.type`（位掩码，取值见 `contract/user-data.ts:33-52`）。
 *
 * 本仓的 `kind` 是**引擎给的展示用字符串**（`it0.value.kind`，实测取值 `book` / `video` / `image`），
 * 契约的 `type` 是 Legado 的**检索用位掩码**。两者不是同一层概念，所以必须显式映射，
 * 不能直接把 `kind` 塞进 `type`（那样 `type` 会变成 `NaN`/字符串，`type & :type > 0` 查询全失效）。
 */
export function kindToBookType(kind?: string): number {
  switch (kind) {
    case 'video':
      return BookType.video;
    case 'image':
      return BookType.image;
    case 'audio':
      return BookType.audio;
    default:
      return BookType.text;
  }
}

/**
 * 契约 `ShelfBook.type` → 本仓 `kind`。
 *
 * ⚠️ **只还原本仓 UI 真正用到的三类**（`video` 走影视库、`image` 走漫画、其余按 `book`）。
 * 为什么不做「按位逐项判断」：Legado 的 `type` 会**叠加**位（例如「更新失败 16」可以与 `text 8` 并存，
 * `BookType.kt` 的 `updateError` 就是这么用的），而本仓的 `kind` 是**单值**字符串 ——
 * 逐位拆会造出一个本仓不存在的模型。这里只按「主类型位」判定，其余一律 `book`。
 */
export function bookTypeToKind(type: number | undefined): string {
  const t = type ?? BookType.text;
  // 用等价算术而不是 `&`（JS 位运算是 32 位有符号；本仓在 shelf-groups.ts 已立过这条规矩）
  const has = (bit: number) => bit > 0 && Math.floor(t / bit) % 2 === 1;
  if (has(BookType.video)) return 'video';
  if (has(BookType.image)) return 'image';
  if (has(BookType.audio)) return 'audio';
  return 'book';
}

/* ------------------------------------------------------------------ *
 * 书架条目
 * ------------------------------------------------------------------ */

/**
 * 本仓 `ShelfBook` → 契约 `ShelfBook`（`PUT /api/user/books` 的请求体）。
 *
 * `key` 由调用方传入（`key = itemKey(sourceId, payload)`），因为 `ShelfBook.key` 是可选的，
 * 而契约 `bookUrl` 是**必填主键**（缺失服务端会 400 `BOOK_URL_REQUIRED`）。
 *
 * ## 逐字段对照（契约 **42** 个字段，`contract/user-data.ts:179-273`）
 *
 * | 契约字段 | 本仓来源 | 处理 |
 * |---|---|---|
 * | `bookUrl` | `key` | **主键**。本仓用 `itemKey`（源+payload 派生），语义与 Legado `bookUrl` 一致：唯一标识一本书。⚠️ **必须过 {@link encodeItemKey}**（内含 `\u0000`，SQLite 读回会截断） |
 * | `tocUrl` | — | `''`：本仓不存目录 URL（详情阶段现取） |
 * | `origin` | `sourceId` | 书源标识 |
 * | `originName` | — | `''`：源名由 UI 从 sources store 现查，本仓书架条目不存（存了会与源列表失联） |
 * | `name` | `title` | |
 * | `author` | `author` | `?? ''` |
 * | `kind` | — | `null`：Legado 的「分类信息」本仓不存（发现页/详情页用 `payload.tags`） |
 * | `customTag` / `customCoverUrl` / `customIntro` | — | `null`：用户改分类/封面/简介的功能未做 |
 * | `coverUrl` | `cover` | `?? null` |
 * | `intro` | — | `null` |
 * | `charset` | — | `null`（仅本地书用） |
 * | `type` | `kind` | 经 {@link kindToBookType} |
 * | `group` | `group` | `?? 0`（位掩码，`0` = 未分组） |
 * | `latestChapterTitle` | — | `null` ⚠️ **不是** `lastChapter.title` —— 见下方「两个 lastChapter 易混点」 |
 * | `latestChapterTime` | `latestChapterTime` | `?? 0`（本仓是近似口径，见 `reader.ts` 字段注释） |
 * | `lastCheckTime` | `latestChapterTime` | 同一含义（「最近一次更新书籍信息的时间」），复用 |
 * | `lastCheckCount` | `lastCheckCount` | `?? 0` |
 * | `totalChapterNum` | `totalChapterNum` | `?? 0` |
 * | `durChapterTitle` | `lastChapter.title` | ★ **读到的那一章** |
 * | `durChapterIndex` | `lastIdx` | ★ |
 * | `durVolumeIndex` / `chapterInVolumeIndex` | — | `0`（本仓目录不区分卷里卷外索引） |
 * | `durChapterPos` | — | `0`：本仓**不在书架条目里**存章内位置（只有书签存 `chapterPos`） |
 * | `durChapterTime` | `updatedAt` | ★ ≈ 「最近一次阅读时间」 |
 * | `wordCount` | — | `null` |
 * | `canUpdate` | `canUpdate` | `?? true`（契约默认 true） |
 * | `order` / `originOrder` | — | `0`（本仓无手动排序，见 `shelf-groups.ts` 的 `bookSort` 说明） |
 * | `variable` | — | `null`：那是**给源规则**的命名空间，不能借用（语料 10 个源在用 `book.getVariable()`） |
 * | `readConfig` | `useReplaceRule` | ★ `#260`：**只用来装「这本书要不要净化」**（上游 `Book.ReadConfig.useReplaceRule`）。其余 18 个字段本仓仍未做 ⇒ 写回时只有这一个键，不会伪装成「整套阅读设置都支持了」 |
 * | `syncTime` | — | `0`（WebDAV 同步时间，本仓未做） |
 * | `persistedCoverUrl` | — | `null`（「把封面存到本地」未做） |
 * | `payload` | `payload` | `JSON.stringify` —— 契约里**显式标注的本仓扩展字段** |
 *
 * ## ⚠️「两个 lastChapter」易混点（写错会让书架显示成别的书的进度）
 * 契约里 `latestChapterTitle` 是**这本书最新章节的标题**（目录上的），
 * 而本仓 `lastChapter` 是**用户读到的那一章**（`saveProgress` 写的，见 `reader.ts:541-551`）。
 * 两者恰好都叫「chapter」，照名字对会让「读到第 3 章」显示成「最新章节」。
 * 真正对应「读到的那一章」的是 `durChapterTitle`。
 *
 * ## 哪些字段**无法**往返（本地缓存兜着，见 `reader.ts` 的 `hydrateShelf`）
 * `lastChapter.payload`（引擎章节 payload）、`progressSec` / `durationSec`（影视播放秒数）
 * 在 42 个契约字段里**没有对应项** ⇒ 它们继续由 localStorage 缓存承载，
 * 对齐时从本地缓存回填（否则跨设备「继续阅读」的精确度与影视续播进度会退化成按索引）。
 */
export function shelfBookToContract(b: ShelfBook, key: string): ContractShelfBook {
  return {
    // ⚠️ 必须转义：`key` 里含 `\u0000`，过不了 SQLite 持久层（见 encodeItemKey 的实测记录）
    bookUrl: encodeItemKey(key),
    tocUrl: '',
    origin: b.sourceId,
    originName: '',
    name: b.title,
    author: b.author ?? '',
    kind: null,
    customTag: null,
    coverUrl: b.cover ?? null,
    customCoverUrl: null,
    intro: null,
    customIntro: null,
    charset: null,
    // `#141`：notShelf 位（观影历史行=未收藏）必须随 type 往返，否则「看过没收藏」的剧
    // 会被服务端对齐当成普通书塞回书架。
    type: kindToBookType(b.kind) | (b.notShelf ? BookType.notShelf : 0),
    group: b.group ?? 0,
    latestChapterTitle: null,
    latestChapterTime: b.latestChapterTime ?? 0,
    lastCheckTime: b.latestChapterTime ?? 0,
    lastCheckCount: b.lastCheckCount ?? 0,
    totalChapterNum: b.totalChapterNum ?? 0,
    durChapterTitle: b.lastChapter?.title ?? null,
    durChapterIndex: b.lastIdx ?? 0,
    durVolumeIndex: 0,
    chapterInVolumeIndex: 0,
    durChapterPos: 0,
    durChapterTime: b.updatedAt ?? 0,
    wordCount: null,
    canUpdate: b.canUpdate ?? true,
    order: 0,
    originOrder: 0,
    variable: null,
    /**
     * ★ `#260`：**只写 `useReplaceRule` 这一个键**（上游 `Book.ReadConfig.useReplaceRule`）。
     *
     * ⚠️ 为什么不用 `b.readConfig` 整份透传：本仓没有「每本书阅读设置」界面，
     * 其余 18 个字段本来就没数据源；整份透传会把契约默认值（`emptyBookReadConfig()`）
     * 当成「用户设置」写进库里 —— 看起来像功能已支持，实际是无中生有。
     * `b.useReplaceRule == null` ⇒ **整列为 null**（= 跟随全局），与「设置成 false」可区分。
     */
    readConfig: readConfigFromBook(b),
    syncTime: 0,
    persistedCoverUrl: null,
    payload: payloadToJson(b.payload),
    // 每本书的阅读样式覆盖（`#164`，契约里显式标注的本仓扩展字段）。
    // ⚠️ 必须**双向**映射 —— 漏了任何一边，用户改的「本书样式」就会在下次对齐时静默丢掉
    // （服务端对齐是「服务端为准」，丢一边＝覆盖被服务端的旧值抹掉）。回归锁 `read-style.test.ts` 盯着这条。
    readStyle: b.readStyle ?? null,
    // `#141`：影视进度（秒）——此前「契约 42 字段里没有对应项」的注释已过时（本轮补上契约字段）。
    // 契约字段是 optional（不是 null）：undefined 在 JSON 序列化时被丢弃 ⇒ 服务端存 NULL
    progressSec: b.progressSec ?? undefined,
    durationSec: b.durationSec ?? undefined,
  };
}

/**
 * 契约 `ShelfBook` → 本仓 `ShelfBook`（服务端读回时用）。
 *
 * `lastChapter.payload` 填 `{}`（= 「引擎 payload 未知」）—— 它只在 `reader.ts:1049-1055`
 * 当**次级**定位键用：先按 `chapterUrl` 找，找不到再比整段 payload，最后回落到 `lastIdx`。
 * 所以 `{}` 不会毁掉续读，只是「跨设备时精确到章 URL」的能力降级为「按章节索引」。
 * 本地缓存里若还留着真 payload，`hydrateShelf` 会**回填**（见其注释）。
 */
export function contractToShelfBook(c: ContractShelfBook): ShelfBook {
  return {
    key: c.bookUrl ? decodeItemKey(c.bookUrl) : undefined,
    sourceId: c.origin,
    payload: jsonToPayload(c.payload),
    title: c.name,
    author: c.author || undefined,
    // ★ `#204`：走契约层的 `displayCover`，它编码了展示优先级
    //   **persistedCoverUrl > customCoverUrl > coverUrl**。
    //   原先这里直接 `c.coverUrl` ⇒ 用户换的自定义封面**存了但永远不显示**
    //   （字段全链路都通，唯独这一行没接上，属于典型的「最后一段没接线」）。
    cover: displayCover(c) ?? undefined,
    // ★ `#204`：这两个也要透传，不能只给 `cover`（合成后的结果）——
    //   「清除自定义」按钮要知道当前是不是自定义封面，就得有原字段可判。
    customCoverUrl: c.customCoverUrl,
    persistedCoverUrl: c.persistedCoverUrl,
    kind: bookTypeToKind(c.type),
    lastChapter: c.durChapterTitle ? { title: c.durChapterTitle, payload: {} } : undefined,
    lastIdx: c.durChapterIndex,
    updatedAt: c.durChapterTime,
    group: c.group,
    latestChapterTime: c.latestChapterTime,
    totalChapterNum: c.totalChapterNum,
    canUpdate: c.canUpdate,
    lastCheckCount: c.lastCheckCount,
    // `#164`：每本覆盖。`null` 原样保留（= 不覆盖）——
    // ⚠️ 别写成 `c.readStyle ?? undefined`：`undefined` 在写回本地缓存时会被 JSON 丢掉，
    // 而 `null` 会留下来，两者对「这份数据到底有没有这回事」的可见性不同；
    // 语义上两者都表示「不覆盖」，所以这里保留服务端给的形状即可。
    readStyle: c.readStyle ?? null,
    // `#141`：notShelf 位（观影历史行）与影视进度（秒）——双向映射，漏一边就会在对齐时静默丢。
    notShelf: !!(c.type & BookType.notShelf),
    progressSec: c.progressSec ?? undefined,
    durationSec: c.durationSec ?? undefined,
    /**
     * ★ `#260`：本书级净化开关（上游 `Book.ReadConfig.useReplaceRule`）。**双向**映射。
     * ⚠️ 服务端空列读回的是 `emptyBookReadConfig()`（不是 `null`，见 `sqlite.ts:719`）
     * ⇒ 这里必须 `?? null` 把「契约默认值 null」归一成「跟随全局」，
     * 否则会在界面上显示成「本书显式设为…」而其实用户从没设过。
     */
    useReplaceRule: c.readConfig?.useReplaceRule ?? null,
    /**
     * ★ `#261` 手动规则集（上游 `Book.ReadConfig.manualReplaceRuleIds`）。**双向**映射 ——
     *   第一版只映射了 `useReplaceRule` ⇒ 界面勾了能生效、重启就丢（探针 M3 抓到）。
     * ⚠️ 空数组归一成 `null`（与「没设过」同义），避免每次对齐都写一堆 `[]` 噪音。
     */
    manualReplaceRuleIds: c.readConfig?.manualReplaceRuleIds?.length ? c.readConfig.manualReplaceRuleIds : null,
  };
}

/**
 * 本仓 `ShelfBook` → 契约 `readConfig` 列（`#260` / `#261`）。
 *
 * 只有 `useReplaceRule != null` **或** 勾了手动规则集时才写列（整列 JSON），否则写 `null`。
 * 其余字段用契约默认值占位 —— 它们**没有数据源**，写进去也不会被读回（读回时只看这两个键）。
 */
function readConfigFromBook(b: ShelfBook): BookReadConfig | null {
  const manual = b.manualReplaceRuleIds?.length ? b.manualReplaceRuleIds : null;
  if (b.useReplaceRule == null && !manual) return null;
  return {
    ...emptyBookReadConfig(),
    useReplaceRule: b.useReplaceRule ?? null,
    manualReplaceRuleIds: manual ?? [],
  };
}

/** 引擎 payload（任意 JSON）→ 契约的 `payload`（**JSON 字符串**或 `null`） */
export function payloadToJson(p: unknown): string | null {
  if (p === undefined || p === null) return null;
  try {
    return JSON.stringify(p);
  } catch (e) {
    // 循环引用等：留痕，别静默变成一个假 payload（铁律 3）
    console.warn('[user-map] payload 无法序列化，按 null 处理：', e);
    return null;
  }
}

/** 契约的 `payload`（JSON 字符串）→ 引擎 payload（对象）。解析失败留痕并回落 `{}` */
export function jsonToPayload(s: string | null): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s) as unknown;
  } catch (e) {
    console.warn('[user-map] payload 不是合法 JSON，按 {} 处理：', e);
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * 书签
 * ------------------------------------------------------------------ */

/**
 * 本仓 `Bookmark` → 契约 `Bookmark`（`PUT /api/user/bookmarks`）。
 *
 * 契约 **8 个字段**（`contract/user-data.ts:481-498`，照 `Bookmark.kt` 逐条提取）：
 * `time`(主键) / `bookName` / `bookAuthor` / `chapterIndex` / `chapterPos` /
 * `chapterName` / `bookText` / `content` —— **全部同名同义，直接对应**。
 *
 * ⚠️ **本仓扩展字段 `sourceId` 在契约里没有对应项**（Legado 就是靠「书名+作者」定位书，
 * 所以书签**不随换源迁移**；我们加 `sourceId` 是为了同名书不串）。
 * ⇒ 它由 localStorage 缓存承载、`hydrateBookmarks` 回填 —— **不要**塞进 `content`/`bookText`
 * （那是用户可见的文本，塞进去会显示成乱码）。
 */
export function bookmarkToContract(b: Bookmark): ContractBookmark {
  return {
    time: b.time,
    bookName: b.bookName,
    bookAuthor: b.bookAuthor,
    chapterIndex: b.chapterIndex,
    chapterPos: b.chapterPos,
    chapterName: b.chapterName,
    bookText: b.bookText,
    content: b.content,
  };
}

/** 契约 `Bookmark` → 本仓 `Bookmark`。`sourceId` 置 `''`（由本地缓存回填，见 `hydrateBookmarks`） */
export function contractToBookmark(c: ContractBookmark): Bookmark {
  return {
    time: c.time,
    sourceId: '',
    bookName: c.bookName,
    bookAuthor: c.bookAuthor,
    chapterIndex: c.chapterIndex,
    chapterPos: c.chapterPos,
    chapterName: c.chapterName,
    bookText: c.bookText,
    content: c.content,
  };
}
