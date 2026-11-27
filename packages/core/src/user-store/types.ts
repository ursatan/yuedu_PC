/**
 * 用户数据存储适配器契约（Phase 1.2）
 *
 * ## 为什么要有这层接口
 * 结构化用户数据落 SQLite（`node:sqlite`），但 `node:sqlite` 目前仍带 ExperimentalWarning，
 * 且将来可能换 `better-sqlite3`（原生模块，性能更好但安装失败率高）。
 * 因此**所有业务代码只依赖本接口**，不直接 import `node:sqlite`；
 * 换实现只需要在 {@link openUserStore} 里改一行。
 *
 * ## 与契约层的关系
 * 实体类型（{@link ShelfBook} / {@link ShelfChapter} / …）定义在 `contract/user-data.ts`，
 * 字段与 Legado 实体逐条对齐；本文件只描述**怎么读写**，不重复定义字段。
 *
 * ## 已确认的设计决策（用户拍板，勿改）
 * - **D1**：`books` 表**保留 `(name, author)` 唯一约束** → 同名同作者只存一条
 *   （与 Legado `Book.kt:37` + `BookDao.kt:217` 的 REPLACE 语义一致）。
 * - **D2**：`read_records` **按书名聚合**（主键 `(deviceId, bookName)`，照抄 `ReadRecord.kt:8`）。
 * - **D3**：`books.group` 用**位掩码**（对齐 DAO `WHERE (group & :group) > 0`）。
 *
 * @see docs/移植路线图.md §1.2 / §5.1
 */

import type {
  BookGroup,
  BookHighlight,
  Bookmark,
  BookMemo,
  BookTombstone,
  CacheEntry,
  GlobalReaderPrefs,
  HighlightRule,
  ReadRecord,
  DictRule,
  ReadRecordShow,
  ReadSession,
  ReadStatsSnapshot,
  ReplaceRule,
  SearchHistoryEntry,
  ShelfBook,
  ShelfChapter,
} from '../contract/user-data';

/** 存储实现种类（诊断/上报用） */
export type UserStoreKind = 'sqlite' | 'json';

/** 打开存储的参数 */
export interface UserStoreOptions {
  /** 数据目录（`DATA_DIR`）。DB 与 blob 都会落在这里 */
  dir: string;
  /** 强制指定实现（缺省自动探测：sqlite 优先，不可用回落 json） */
  kind?: UserStoreKind;
  /** 打开时是否执行 `PRAGMA wal_checkpoint(TRUNCATE)` 之外的压缩等维护动作 */
  maintenance?: boolean;
}

/**
 * 书架排序。
 *
 * ⚠️ 这是**我们自定义的枚举**，故意不复刻 Legado 的 `AppConfig.bookshelfSort`（那是"排序菜单下标"，
 * 与菜单顺序耦合，移植到 Web/PC 会立刻错位）。Legado 的默认排序是
 * `order by durChapterTime desc`（`BookDao.kt:56`），对应这里的 `lastRead`。
 */
export type BookshelfSort =
  /** 最近阅读（Legado 默认） */
  | 'lastRead'
  /** 手动排序（`order` 升序） */
  | 'manual'
  /** 书名 */
  | 'name'
  /** 作者 */
  | 'author'
  /** 最近更新章节 */
  | 'latestChapter'
  /** 最近检查更新 */
  | 'updateTime';

/** 书架查询条件 */
export interface BookListQuery {
  /**
   * 按分组筛选。**位掩码**，语义同 Legado `WHERE (group & :group) > 0`（D3）。
   * 传 {@link BookGroupId}-类内置值或用户分组位；不传 = 不筛选。
   */
  group?: number;
  /** 按类型筛选。**位掩码**，`type & :type > 0`（如传 `BookType.video` 只出影视） */
  type?: number;
  /** 名称/作者模糊搜索（`name LIKE %k% OR author LIKE %k%`，对齐 `BookDao.kt:98`） */
  search?: string;
  /** 排序，缺省 `lastRead` */
  sort?: BookshelfSort;
  limit?: number;
  offset?: number;
}

/** 阅读进度写入参数（高频小写，独立于整本 upsert） */
export interface ProgressPatch {
  durChapterIndex: number;
  durChapterPos: number;
  durChapterTime?: number;
  durChapterTitle?: string | null;
  durVolumeIndex?: number;
  chapterInVolumeIndex?: number;
  /**
   * `#208` WebDAV 同步时间（毫秒）。**不传 = 保持原值**（不是清零）。
   *
   * 为什么放在这个 patch 里：`ShelfBook.syncTime` 这个字段**本来就在契约与表结构里**
   * （默认 0，`user-map.ts` 里写着「WebDAV 同步时间，本仓未做」）⇒ 复用它，不另开真相源。
   * ⚠️ 语义是「上次同步的时刻」，用于跳过远端没变化的进度文件（上游 `AppWebDav.kt:319`）；
   * 每次阅读写进度时**不要**传它，否则「上次同步时间」会被阅读动作刷新成现在 ⇒ 跳过逻辑失效。
   */
  syncTime?: number;
}

/** 批量写入结果 */
export interface BatchResult {
  /** 实际写入条数 */
  written: number;
  /**
   * 事件循环让出次数。
   * 用来证明「大批量写入没有卡死事件循环」——`DatabaseSync` 是同步 API，
   * 实测 150 万行一次性导入会阻塞 21.5s（见路线图 §5.1），因此必须分批 + 让出。
   */
  yields: number;
}

/**
 * 书架/观影历史的**删除墓碑**（跨端一致删除的权威凭据）。
 *
 * 形状与语义定义在契约层（`contract/user-data.ts`）—— 前端也要用它过滤本地陈旧副本，
 * 而本文件连着 `node:sqlite` 的运行时依赖，浏览器侧不能 import 这里。
 * 这里只做**转发导出**，保持 `@yuedu/core/user-store` 的既有 import 路径可用。
 */
export type { BookTombstone } from '../contract/user-data';

/**
 * 用户数据存储。
 *
 * **所有方法都是 async**：即使 SQLite 是同步 API，也统一成 Promise 以便
 * ① 将来换异步实现（better-sqlite3 的异步包装、远端存储）② 批量写入时能 `await` 让出事件循环。
 */
export interface UserDataStore {
  /** 实际使用的实现 */
  readonly kind: UserStoreKind;
  /** 数据目录 */
  readonly dir: string;

  // ---------------- 书架（books） ----------------
  listBooks(query?: BookListQuery): Promise<ShelfBook[]>;
  getBook(bookUrl: string): Promise<ShelfBook | null>;
  countBooks(): Promise<number>;
  /**
   * 写入一本书（存在则更新）。
   *
   * ⚠️ **D1 语义**：若已存在**另一本**同 `(name, author)` 的书，会先删除它
   * （连带其目录，外键级联），再写入当前这本 —— 对齐 Legado `save()` + REPLACE。
   *
   * ⚠️ **删除优先**：若该书有墓碑且 `book.durChapterTime < deletedAt` ⇒ **忽略本次写入**
   * （另一端陈旧缓存的复活）。行时间更晚则视为用户重新加入/重新播放，清墓碑后正常写入。
   */
  upsertBook(book: ShelfBook): Promise<void>;
  /** 批量写入（分批 + 让出事件循环） */
  upsertBooks(books: ShelfBook[]): Promise<BatchResult>;
  /**
   * 删除书（目录随外键 CASCADE 一并删除），并留下**墓碑**（{@link BookTombstone}）。
   *
   * 墓碑是跨端一致删除的凭据：另一端的同步会据此把本地陈旧副本也删掉，
   * 且任何 `durChapterTime` 早于 `deletedAt` 的 upsert 都会被拒绝（见 {@link upsertBook}）。
   */
  deleteBook(bookUrl: string, deletedAt?: number): Promise<boolean>;
  /**
   * 轻量写阅读进度（只更新 6 个进度字段，不整本重写）
   */
  saveProgress(bookUrl: string, patch: ProgressPatch): Promise<boolean>;

  // ---------------- 删除墓碑（跨端一致删除） ----------------
  /**
   * 列出墓碑（`deletedAt` 大于 `since` 的全部返回；不传 = 全量）。
   *
   * 全量是默认路径：墓碑只有「主键 + 毫秒」两个字段，量级等于用户删过的书条数，
   * 而增量拉取需要持久化「上次同步到哪一毫秒」——多一份真相源。{@link since} 留给探针/运维。
   */
  listBookTombstones(since?: number): Promise<BookTombstone[]>;
  /**
   * **显式清掉**某本书的墓碑（不经过「行的更新时间更晚」这条自动判据）。
   *
   * 只给「恢复备份」用（`import.ts`）：那是用户**明确要求**把书加回来，
   * 而备份里的 `durChapterTime` 可能是旧的 ⇒ 自动判据会把它当成陈旧复活而拒绝。
   * ⚠️ 普通写入/同步**不要**调它 —— 那等于把删除语义关掉。
   */
  clearBookTombstone(bookUrl: string): Promise<boolean>;

  // ---------------- 目录（chapters） ----------------
  listChapters(bookUrl: string): Promise<ShelfChapter[]>;
  /** 全量替换某书的目录（事务：先删后插；用于目录更新） */
  replaceChapters(bookUrl: string, chapters: ShelfChapter[]): Promise<BatchResult>;
  /** 增量 upsert 目录（PK `(url, bookUrl)` 冲突则替换） */
  upsertChapters(chapters: ShelfChapter[]): Promise<BatchResult>;
  countChapters(bookUrl: string): Promise<number>;

  // ---------------- 书签（bookmarks） ----------------
  listBookmarks(bookName?: string): Promise<Bookmark[]>;
  upsertBookmark(b: Bookmark): Promise<void>;
  deleteBookmark(time: number): Promise<boolean>;

  // ---------------- 高亮/笔记（highlights） ----------------
  listHighlights(bookUrl?: string): Promise<BookHighlight[]>;
  upsertHighlight(h: BookHighlight): Promise<void>;
  deleteHighlight(time: number): Promise<boolean>;

  // ---------------- 书内备注（book_memos，Legado `BookMemo`） ----------------
  /** 全部备注；传 `bookUrl` 只取该书的（按 time 倒序） */
  listBookMemos(bookUrl?: string): Promise<BookMemo[]>;
  upsertBookMemo(m: BookMemo): Promise<void>;
  deleteBookMemo(time: number): Promise<boolean>;

  // ---------------- 搜索历史（search_history，Legado `SearchKeyword`） ----------------
  /** 全部（`lastUseTime` 倒序）；`limit` 缺省 = 全部（服务端接口默认传 20） */
  listSearchHistory(limit?: number): Promise<SearchHistoryEntry[]>;
  /** 记录一次搜索：不存在则新增（usage=1），存在则 usage+1 并刷新 lastUseTime */
  recordSearch(word: string, now?: number): Promise<SearchHistoryEntry | null>;
  /** 置值写一条（导入备份用；不累加 usage） */
  upsertSearchHistory(entry: SearchHistoryEntry): Promise<void>;
  deleteSearchHistory(word: string): Promise<boolean>;
  clearSearchHistory(): Promise<number>;

  // ---------------- 高亮规则（highlightRules，`#262`） ----------------
  /** 全部规则（`order` 升序，同 id 升序 —— 对齐上游 DAO `all` 的 `ORDER BY sortOrder ASC, id ASC`） */
  listHighlightRules(): Promise<HighlightRule[]>;
  /** 主键 id 冲突则整条替换（上游 `@Insert(REPLACE)` 语义） */
  upsertHighlightRule(r: HighlightRule): Promise<void>;
  deleteHighlightRule(id: number): Promise<boolean>;

  // ---------------- 字典规则（dict_rules，`#189`） ----------------
  listDictRules(): Promise<DictRule[]>;
  upsertDictRule(r: DictRule): Promise<void>;
  deleteDictRule(name: string): Promise<boolean>;

  // ---------------- 净化规则（replace_rules） ----------------
  listReplaceRules(): Promise<ReplaceRule[]>;
  upsertReplaceRule(r: ReplaceRule): Promise<void>;
  deleteReplaceRule(id: number): Promise<boolean>;

  // ---------------- 分组（book_groups） ----------------
  listBookGroups(): Promise<BookGroup[]>;
  upsertBookGroup(g: BookGroup): Promise<void>;
  deleteBookGroup(groupId: number): Promise<boolean>;

  // ---------------- 阅读时长（read_records，D2 按书名聚合） ----------------
  listReadRecords(): Promise<ReadRecord[]>;
  /** 累加阅读时长并刷新 lastRead（不存在则新建）。`author` 用于辅助识别（Legado 会合并多作者） */
  addReadTime(deviceId: string, bookName: string, deltaMs: number, author?: string, now?: number): Promise<void>;
  /**
   * **置值**写一条阅读记录（主键 `(deviceId, bookName)` 冲突则整条替换）。
   * `#201` 导入备份用 —— `addReadTime` 是**累加**语义（导入会让时长翻倍），
   * 恢复备份必须是置值；合并/取舍由调用方（`import.ts`）决定后再调这里。
   */
  upsertReadRecord(r: ReadRecord): Promise<void>;
  /** 跨设备聚合视图（对应 `ReadRecordShow`） */
  listReadRecordShows(): Promise<ReadRecordShow[]>;

  // ---------------- 阅读会话统计（P1：read_session / book_read_stat / user_read_stat） ----------------
  /**
   * 追加会话流水并**增量**更新两张聚合表（同一事务）。
   *
   * - 幂等：主键 `session_id` 冲突的会话**整条跳过**，且**不再**重复累加聚合；
   * - 无定时任务：切片与累加都在这里一次完成（切片见 `read-session.ts`）；
   * - 保留策略：顺手删除 `startAt` 早于 365 天的原始会话（聚合永久保留）。
   */
  appendReadSessions(sessions: ReadSession[]): Promise<{ inserted: number; skipped: number }>;
  /** 原始会话（诊断/测试用；`start_at` 降序）；传 `bookUrl` 只取该书 */
  listReadSessions(limit?: number, bookUrl?: string): Promise<ReadSession[]>;
  /** 看板快照（按日 / 按书 / 断点 / 平均单次 / 旧历史总额） */
  getReadStats(): Promise<ReadStatsSnapshot>;

  // ---------------- KV 缓存（caches，带 TTL） ----------------
  cacheGet(key: string, now?: number): Promise<string | null>;
  cacheSet(key: string, value: string | null, ttlMs?: number, now?: number): Promise<void>;
  cacheDelete(key: string): Promise<boolean>;
  /** 清理已过期的条目，返回删除条数（`deadline = 0` 视为永不过期） */
  cacheSweep(now?: number): Promise<number>;
  cacheList(prefix?: string): Promise<CacheEntry[]>;

  // ---------------- 全局阅读偏好（单行） ----------------
  getReaderPrefs(): Promise<GlobalReaderPrefs>;
  setReaderPrefs(patch: Partial<GlobalReaderPrefs>): Promise<GlobalReaderPrefs>;

  // ---------------- 生命周期 ----------------
  /** 关库（幂等）。SQLite 实现会先 checkpoint */
  close(): Promise<void>;
}

/** 打开存储失败（两个实现都不可用 / 目录不可写）时抛这个，便于调用方给用户可操作的提示 */
export class UserStoreOpenError extends Error {
  readonly kind: UserStoreKind | 'none';
  constructor(message: string, kind: UserStoreKind | 'none' = 'none') {
    super(message);
    this.name = 'UserStoreOpenError';
    this.kind = kind;
  }
}
