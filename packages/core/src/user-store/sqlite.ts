/**
 * SQLite 用户数据存储（Phase 1.2）
 *
 * 用 **`node:sqlite`**（Node ≥22 内置模块，零安装/零依赖/单文件）。
 * 实测基准见 `docs/移植路线图.md` §5.1：1000 本 × 1500 章下书架列表 2ms、写进度 2ms。
 *
 * ## 四条纪律
 * 1. **不 import 具体实现到业务层**：本文件只被 `openUserStore` 使用。
 * 2. **分批 + 让出事件循环**：`DatabaseSync` 是同步 API，150 万行一次性导入实测阻塞 21.5s。
 *    因此所有批量写入都按 {@link YIELD_EVERY} 分批，批间 `await setImmediate`。
 * 3. **动态 import**：`node:sqlite` 仍标 Experimental，且并非所有运行时都有 →
 *    用 `await import('node:sqlite')` 探测，拿不到就抛 {@link UserStoreOpenError} 让上层回落。
 * 4. ⚠️ **写 `books` 绝不能用 `INSERT OR REPLACE`**：REPLACE 的语义是「删除冲突行再插入」，
 *    而 `chapters` 对 `books` 有 `ON DELETE CASCADE` → **每次刷新书籍信息都会清空目录**。
 *    必须用 `INSERT ... ON CONFLICT(bookUrl) DO UPDATE`（真正走 UPDATE，不触发级联）。
 *    叶子表（bookmarks/highlights/…）没有子表，用 REPLACE 是安全的。
 * 5. ★ **读 TEXT 必须走 {@link all}/{@link one}**（别直接 `stmt(sql).get()`）：
 *    `node:sqlite` 读回时**在第一个 NUL 处截断**，这两个口是**统一防护点**（缺陷类BU）。
 *    绕过它们 = 任何含 `\u0000` 的字段静默丢后半段。
 *
 * ## 与 Legado 的对应
 * 表结构逐条来自 `F:\legado` 的 Room 实体（`books` / `chapters` / `bookmarks` / `highlights` /
 * `replace_rules` / `book_groups` / `readRecord` / `caches`），字段名与默认值见 `contract/user-data.ts`。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
// `#771` 冻结探针（默认关；`YUEDU_FREEZE_PROBE=1` 开）
import { probeEnter, probeLeave } from '../diag/freeze-probe';

import {
  emptyBookReadConfig,
  fillGlobalReaderPrefs,
  type BookGroup,
  type BookHighlight,
  type Bookmark,
  type BookMemo,
  type BookReadConfig,
  type BookReadStat,
  type CacheEntry,
  type DictRule,
  type GlobalReaderPrefs,
  type HighlightRule,
  type ReadBreakPoint,
  type ReadRecord,
  type ReadRecordShow,
  type ReadSession,
  type ReadSessionMode,
  type ReadStatsSnapshot,
  type ReadStyleOverride,
  type ReplaceRule,
  type SearchHistoryEntry,
  type ShelfBook,
  type ShelfChapter,
  type UserReadStat,
} from '../contract/user-data';
import { isReadSessionMode, normalizeReadSession, READ_SESSION_KEEP_DAYS, sliceSessionWindows } from './read-session';
import { AGGREGATE_SEPARATOR, displayAuthors, mergeAuthors } from './author-agg';
import {
  UserStoreOpenError,
  type BatchResult,
  type BookListQuery,
  type BookshelfSort,
  type BookTombstone,
  type ProgressPatch,
  type UserDataStore,
  type UserStoreOptions,
} from './types';

/** 每批写入条数；批间让出事件循环。权衡：太小 → 事务开销大；太大 → 单次卡顿变长 */
const YIELD_EVERY = 2000;
/** 当前 schema 版本（写进 `PRAGMA user_version`）
 *  · v2 → v3（`#164`）：`books` 增加扩展列 `readStyle`（每本书的阅读样式覆盖，JSON）。
 *  · v3 → v4（`#141`）：`books` 增加扩展列 `progressSec`/`durationSec`（影视播放进度/时长，秒）。
 *  · v4 → v5（`#189`）：新增表 `dict_rules`（字典规则，此前只存前端 localStorage ⇒ 跨 origin 不同步）。
 *  · v6 → v7（`#863` 阅读统计 P1）：新增表 `read_session` / `book_read_stat` / `user_read_stat`。
 *    这三张表由 {@link DDL} 的 `CREATE TABLE IF NOT EXISTS` 幂等建立，v7 主要是版本标记。
 *  · v7 → v8：新增表 `book_memos`（书内备注，Legado `BookMemo`）与 `search_history`
 *    （搜索历史，Legado `SearchKeyword`）。同样是幂等建表，v8 主要是版本标记。 */
const SCHEMA_VERSION = 8;

/**
 * 让出事件循环。
 *
 * ⚠️ **必须用 `setTimeout(0)` 而不是 `setImmediate`**：`setImmediate` 的回调在**同一轮**的 check 阶段执行，
 * `await` 的续体是微任务、紧随其后就恢复 → 事件循环根本走不到 **timers 阶段**，
 * 结果定时器（HTTP 超时、防抖落盘、心跳）依然被饿死。
 * 实测：用 `setImmediate` 让出时，一个 1ms 的 `setInterval` 在 2500 条批量写入期间**一次都没触发**。
 * `setTimeout(0)`（Node 实际按 1ms 处理）才会真正过一轮完整循环。批量写入的让出次数很少（每
 * {@link YIELD_EVERY} 条一次），多出的毫秒级开销远小于"服务器假死"的代价。
 */
const yieldNow = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ *
 * 行值转换（SQLOutputValue 是未知联合类型，必须显式收窄）
 * ------------------------------------------------------------------ */

const s = (v: unknown): string => (v == null ? '' : String(v));
const ns = (v: unknown): string | null => (v == null ? null : String(v));
/** 数值：SQLite 可能返回 bigint */
const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const nn = (v: unknown): number | null => (v == null ? null : n(v));
/** SQLite 无 boolean → 存 0/1 */
const b = (v: unknown): boolean => n(v) !== 0;
const bv = (v: boolean): number => (v ? 1 : 0);

function jsonOf<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    const parsed = JSON.parse(v) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * `#863` 阅读会话统计：入参归一 + 行映射
 * ------------------------------------------------------------------ */

function sessionParams(s: ReadSession): Record<string, SqlValue> {
  return {
    sessionId: s.sessionId,
    deviceId: s.deviceId,
    bookUrl: s.bookUrl,
    bookName: s.bookName,
    bookAuthor: s.bookAuthor,
    chapterIndex: s.chapterIndex,
    chapterTitle: s.chapterTitle,
    startAt: s.startAt,
    endAt: s.endAt,
    totalMs: s.totalMs,
    effectiveMs: s.effectiveMs,
    readWords: s.readWords,
    readPageCount: s.readPageCount,
    mode: s.mode,
    startProgress: s.startProgress,
    endProgress: s.endProgress,
    tzOffsetMin: s.tzOffsetMin,
    createdAt: s.createdAt,
  };
}

function rowToReadSession(r: Record<string, unknown>): ReadSession {
  return {
    sessionId: s(r['session_id']),
    deviceId: s(r['device_id']),
    bookUrl: s(r['book_url']),
    bookName: s(r['book_name']),
    bookAuthor: s(r['book_author']),
    chapterIndex: n(r['chapter_index']),
    chapterTitle: s(r['chapter_title']),
    startAt: n(r['start_at']),
    endAt: n(r['end_at']),
    totalMs: n(r['total_ms']),
    effectiveMs: n(r['effective_ms']),
    readWords: n(r['read_words']),
    readPageCount: n(r['read_page_count']),
    mode: isReadSessionMode(s(r['mode'])) ? (s(r['mode']) as ReadSessionMode) : 'visual',
    startProgress: n(r['start_progress']),
    endProgress: n(r['end_progress']),
    tzOffsetMin: n(r['tz_offset_min']),
    createdAt: n(r['created_at']),
  };
}

function rowToUserReadStat(r: Record<string, unknown>): UserReadStat {
  return {
    day: s(r['day']),
    totalMs: n(r['total_ms']),
    effectiveMs: n(r['effective_ms']),
    visualMs: n(r['visual_ms']),
    listenMs: n(r['listen_ms']),
    autoMs: n(r['auto_ms']),
    dawnMs: n(r['dawn_ms']),
    morningMs: n(r['morning_ms']),
    afternoonMs: n(r['afternoon_ms']),
    nightMs: n(r['night_ms']),
    sessionCount: n(r['session_count']),
    pageCount: n(r['page_count']),
    wordCount: n(r['word_count']),
  };
}

function rowToBookReadStat(r: Record<string, unknown>): BookReadStat {
  return {
    bookUrl: s(r['book_url']),
    bookName: s(r['book_name']),
    author: s(r['author']),
    totalMs: n(r['total_ms']),
    effectiveMs: n(r['effective_ms']),
    visualMs: n(r['visual_ms']),
    listenMs: n(r['listen_ms']),
    autoMs: n(r['auto_ms']),
    dawnMs: n(r['dawn_ms']),
    morningMs: n(r['morning_ms']),
    afternoonMs: n(r['afternoon_ms']),
    nightMs: n(r['night_ms']),
    sessionCount: n(r['session_count']),
    pageCount: n(r['page_count']),
    wordCount: n(r['word_count']),
    firstReadAt: n(r['first_read_at']),
    lastReadAt: n(r['last_read_at']),
  };
}

/* ------------------------------------------------------------------ *
 * 建表 DDL
 * ------------------------------------------------------------------ */

const DDL = `
CREATE TABLE IF NOT EXISTS books (
  bookUrl              TEXT PRIMARY KEY,
  tocUrl               TEXT NOT NULL DEFAULT '',
  origin               TEXT NOT NULL DEFAULT 'loc_book',
  originName           TEXT NOT NULL DEFAULT '',
  name                 TEXT NOT NULL DEFAULT '',
  author               TEXT NOT NULL DEFAULT '',
  kind                 TEXT,
  customTag            TEXT,
  coverUrl             TEXT,
  customCoverUrl       TEXT,
  intro                TEXT,
  customIntro          TEXT,
  charset              TEXT,
  type                 INTEGER NOT NULL DEFAULT 8,
  "group"              INTEGER NOT NULL DEFAULT 0,
  latestChapterTitle   TEXT,
  latestChapterTime    INTEGER NOT NULL DEFAULT 0,
  lastCheckTime        INTEGER NOT NULL DEFAULT 0,
  lastCheckCount       INTEGER NOT NULL DEFAULT 0,
  totalChapterNum      INTEGER NOT NULL DEFAULT 0,
  durChapterTitle      TEXT,
  durChapterIndex      INTEGER NOT NULL DEFAULT 0,
  durVolumeIndex       INTEGER NOT NULL DEFAULT 0,
  chapterInVolumeIndex INTEGER NOT NULL DEFAULT 0,
  durChapterPos        INTEGER NOT NULL DEFAULT 0,
  durChapterTime       INTEGER NOT NULL DEFAULT 0,
  wordCount            TEXT,
  canUpdate            INTEGER NOT NULL DEFAULT 1,
  "order"              INTEGER NOT NULL DEFAULT 0,
  originOrder          INTEGER NOT NULL DEFAULT 0,
  variable             TEXT,
  readConfig           TEXT,
  syncTime             INTEGER NOT NULL DEFAULT 0,
  persistedCoverUrl    TEXT,
  -- ⚠️ 本仓扩展列（Legado 的 books 表没有）：引擎 payload（JSON 字符串）。
  -- 为什么与 variable 分开存：variable 是**源脚本的命名空间**（语料 10 个源在用 book.getVariable()），
  -- 借它存引擎数据会撞车。详见 contract/user-data.ts 的同名字段注释。
  payload              TEXT,
  -- ⚠️ 本仓扩展列（Legado 的 books 表没有）：每本书的**阅读样式覆盖**（JSON，#164）。
  -- ⚠️ 本 DDL 是**模板字符串**：注释里**禁反引号**（一个反引号就会截断整段 DDL，报 TS1127）。
  -- 为什么不复用上面的 readConfig：readConfig 的语义是「这本书用**哪一套**命名样式」（引用），
  -- 而这里存的是「样式**本身**」（值）—— 塞进去就是语义撞车 + 第二份真相源。
  -- 详见 contract/user-data.ts 的 ShelfBook.readStyle 注释。
  readStyle            TEXT,
  -- ⚠️ 本仓扩展列（Legado 没有）：影视播放进度/时长（秒，#141）。只对 type 含 video 位
  -- 的行有意义；一部剧一行（观看历史 = type 含 notShelf 位的行，见 contract #141 注释）。
  progressSec          INTEGER,
  durationSec          INTEGER
);
-- D1：同名同作者视为同一本书（Legado Book.kt:37 的唯一索引 + BookDao REPLACE 语义）。
-- 实现细则：排除「书名与作者都为空」的占位行 —— Legado 不会插入空书，我们的新建流程可能，
-- 若不做此排除，第二本空书就会撞唯一约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_name_author
  ON books(name, author) WHERE NOT (name = '' AND author = '');

-- 书架/观影历史的**删除墓碑**（跨端一致删除）。见 types.ts 的 BookTombstone 注释。
-- 为什么要单独一张表（而不是 books 加 deleted 列）：墓碑**必须能在行已不存在时继续存在**
-- （「服务端没有」无法区分「没推过」与「被删了」），而 books 的行会被真正删掉。
CREATE TABLE IF NOT EXISTS book_tombstones (
  bookUrl   TEXT PRIMARY KEY,
  deletedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  url             TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  isVolume        INTEGER NOT NULL DEFAULT 0,
  baseUrl         TEXT NOT NULL DEFAULT '',
  bookUrl         TEXT NOT NULL DEFAULT '',
  "index"         INTEGER NOT NULL DEFAULT 0,
  isVip           INTEGER NOT NULL DEFAULT 0,
  isPay           INTEGER NOT NULL DEFAULT 0,
  resourceUrl     TEXT,
  tag             TEXT,
  wordCount       TEXT,
  start           INTEGER,
  "end"           INTEGER,
  startFragmentId TEXT,
  endFragmentId   TEXT,
  variable        TEXT,
  imgUrl          TEXT,
  PRIMARY KEY (url, bookUrl),
  FOREIGN KEY (bookUrl) REFERENCES books(bookUrl) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(bookUrl);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_book_index ON chapters(bookUrl, "index");

CREATE TABLE IF NOT EXISTS bookmarks (
  time         INTEGER PRIMARY KEY,
  bookName     TEXT NOT NULL DEFAULT '',
  bookAuthor   TEXT NOT NULL DEFAULT '',
  chapterIndex INTEGER NOT NULL DEFAULT 0,
  chapterPos   INTEGER NOT NULL DEFAULT 0,
  chapterName  TEXT NOT NULL DEFAULT '',
  bookText     TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(bookName, bookAuthor);

CREATE TABLE IF NOT EXISTS highlights (
  time              INTEGER PRIMARY KEY,
  bookUrl           TEXT NOT NULL DEFAULT '',
  chapterUrl        TEXT NOT NULL DEFAULT '',
  bookName          TEXT NOT NULL DEFAULT '',
  bookAuthor        TEXT NOT NULL DEFAULT '',
  chapterIndex      INTEGER NOT NULL DEFAULT 0,
  chapterPos        INTEGER NOT NULL DEFAULT 0,
  chapterPosEnd     INTEGER NOT NULL DEFAULT 0,
  layoutTitleLength INTEGER NOT NULL DEFAULT -1,
  chapterName       TEXT NOT NULL DEFAULT '',
  bookText          TEXT NOT NULL DEFAULT '',
  style             TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(bookUrl);

-- 书内备注（Legado BookMemo，bookMemo.json）。主键 time。
-- bookUrl 是本仓扩展列（Legado 实体没有），用来稳定挂书；跨端按书名+作者认领。
CREATE TABLE IF NOT EXISTS book_memos (
  time         INTEGER PRIMARY KEY,
  bookUrl      TEXT NOT NULL DEFAULT '',
  bookName     TEXT NOT NULL DEFAULT '',
  bookAuthor   TEXT NOT NULL DEFAULT '',
  chapterIndex INTEGER NOT NULL DEFAULT 0,
  chapterPos   INTEGER NOT NULL DEFAULT 0,
  chapterName  TEXT NOT NULL DEFAULT '',
  bookText     TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_book_memos_book ON book_memos(bookUrl);
CREATE INDEX IF NOT EXISTS idx_book_memos_name ON book_memos(bookName, bookAuthor);

-- 搜索历史（Legado SearchKeyword，searchHistory.json）。主键 word。
CREATE TABLE IF NOT EXISTS search_history (
  word        TEXT PRIMARY KEY,
  lastUseTime INTEGER NOT NULL DEFAULT 0,
  usage       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_search_history_time ON search_history(lastUseTime DESC);

-- #189 字典规则（主键 = 字典名，与前端 store 的 upsertRule 一致）
CREATE TABLE IF NOT EXISTS dict_rules (
  name          TEXT PRIMARY KEY,
  urlRule       TEXT NOT NULL DEFAULT '',
  showRule      TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  sortNumber    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS replace_rules (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL DEFAULT '',
  "group"            TEXT,
  pattern            TEXT NOT NULL DEFAULT '',
  replacement        TEXT NOT NULL DEFAULT '',
  scope              TEXT,
  scopeTitle         INTEGER NOT NULL DEFAULT 0,
  scopeSource        INTEGER NOT NULL DEFAULT 0,
  scopeContent       INTEGER NOT NULL DEFAULT 1,
  excludeScope       TEXT,
  isEnabled          INTEGER NOT NULL DEFAULT 1,
  isRegex            INTEGER NOT NULL DEFAULT 1,
  timeoutMillisecond INTEGER NOT NULL DEFAULT 3000,
  "order"            INTEGER NOT NULL DEFAULT -2147483648
);

-- #262 高亮规则（契约：HighlightRule，12 字段）。
-- 列名对齐上游 Room 实体（HighlightRule.kt）：字段 order 在列名上叫 sortOrder
-- （@ColumnInfo(name = "sortOrder")）—— 直接导入 Legado 的 JSON 时字段名能对上。
CREATE TABLE IF NOT EXISTS highlightRules (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid               TEXT NOT NULL DEFAULT '',
  name               TEXT NOT NULL DEFAULT '',
  pattern            TEXT NOT NULL DEFAULT '',
  isRegex            INTEGER NOT NULL DEFAULT 0,
  scope              TEXT,
  isEnabled          INTEGER NOT NULL DEFAULT 1,
  style              TEXT NOT NULL DEFAULT '',
  sortOrder          INTEGER NOT NULL DEFAULT -2147483648,
  timeoutMillisecond INTEGER NOT NULL DEFAULT 3000,
  applyToTitle       INTEGER NOT NULL DEFAULT 0,
  applyToBody        INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_highlightRules_uuid ON highlightRules(uuid);

CREATE TABLE IF NOT EXISTS book_groups (
  groupId        INTEGER PRIMARY KEY,
  groupName      TEXT NOT NULL DEFAULT '',
  cover          TEXT,
  "order"        INTEGER NOT NULL DEFAULT 0,
  enableRefresh  INTEGER NOT NULL DEFAULT 1,
  show           INTEGER NOT NULL DEFAULT 1,
  bookSort       INTEGER NOT NULL DEFAULT -1,
  onlyUpdateRead INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS read_records (
  deviceId TEXT NOT NULL DEFAULT '',
  bookName TEXT NOT NULL DEFAULT '',
  author   TEXT NOT NULL DEFAULT '',
  readTime INTEGER NOT NULL DEFAULT 0,
  lastRead INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deviceId, bookName)
);

-- #863 阅读统计 P1 -------------------------------------------------------------------
-- 流水：一次「连续阅读」一行；主键是客户端 UUID ⇒ 重放幂等（INSERT OR IGNORE）。
-- ⚠️ 段外键不指向 books：会话可能来自已删除的书，统计仍应保留（聚合永久）。
CREATE TABLE IF NOT EXISTS read_session (
  session_id      TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL DEFAULT 'local',
  book_url        TEXT NOT NULL DEFAULT '',
  book_name       TEXT NOT NULL DEFAULT '',
  book_author     TEXT NOT NULL DEFAULT '',
  chapter_index   INTEGER NOT NULL DEFAULT 0,
  chapter_title   TEXT NOT NULL DEFAULT '',
  start_at        INTEGER NOT NULL DEFAULT 0,
  end_at          INTEGER NOT NULL DEFAULT 0,
  total_ms        INTEGER NOT NULL DEFAULT 0,
  effective_ms    INTEGER NOT NULL DEFAULT 0,
  read_words      INTEGER NOT NULL DEFAULT 0,
  read_page_count INTEGER NOT NULL DEFAULT 0,
  mode            TEXT NOT NULL DEFAULT 'visual',
  start_progress  REAL NOT NULL DEFAULT 0,
  end_progress    REAL NOT NULL DEFAULT 0,
  tz_offset_min   INTEGER NOT NULL DEFAULT 480,
  created_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_read_session_book_time ON read_session(book_url, start_at);
CREATE INDEX IF NOT EXISTS idx_read_session_start ON read_session(start_at);

-- 按书聚合（会话结束时增量 upsert；永久保留，不随原始会话清理而回退）
CREATE TABLE IF NOT EXISTS book_read_stat (
  book_url      TEXT PRIMARY KEY,
  book_name     TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  total_ms      INTEGER NOT NULL DEFAULT 0,
  effective_ms  INTEGER NOT NULL DEFAULT 0,
  visual_ms     INTEGER NOT NULL DEFAULT 0,
  listen_ms     INTEGER NOT NULL DEFAULT 0,
  auto_ms       INTEGER NOT NULL DEFAULT 0,
  dawn_ms       INTEGER NOT NULL DEFAULT 0,
  morning_ms    INTEGER NOT NULL DEFAULT 0,
  afternoon_ms  INTEGER NOT NULL DEFAULT 0,
  night_ms      INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  page_count    INTEGER NOT NULL DEFAULT 0,
  word_count    INTEGER NOT NULL DEFAULT 0,
  first_read_at INTEGER NOT NULL DEFAULT 0,
  last_read_at  INTEGER NOT NULL DEFAULT 0
);

-- 按日全局（日键是**用户时区** YYYY-MM-DD）
CREATE TABLE IF NOT EXISTS user_read_stat (
  day          TEXT PRIMARY KEY,
  total_ms     INTEGER NOT NULL DEFAULT 0,
  effective_ms INTEGER NOT NULL DEFAULT 0,
  visual_ms    INTEGER NOT NULL DEFAULT 0,
  listen_ms    INTEGER NOT NULL DEFAULT 0,
  auto_ms      INTEGER NOT NULL DEFAULT 0,
  dawn_ms      INTEGER NOT NULL DEFAULT 0,
  morning_ms   INTEGER NOT NULL DEFAULT 0,
  afternoon_ms INTEGER NOT NULL DEFAULT 0,
  night_ms     INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  page_count   INTEGER NOT NULL DEFAULT 0,
  word_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS caches (
  key      TEXT PRIMARY KEY,
  value    TEXT,
  deadline INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_caches_key ON caches(key);

CREATE TABLE IF NOT EXISTS prefs (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL DEFAULT '{}'
);
`;

/* ------------------------------------------------------------------ *
 * 语句
 * ------------------------------------------------------------------ */

/** `books` 的全部列（顺序即 INSERT 参数顺序） */
const BOOK_COLUMNS = [
  'bookUrl', 'tocUrl', 'origin', 'originName', 'name', 'author', 'kind', 'customTag',
  'coverUrl', 'customCoverUrl', 'intro', 'customIntro', 'charset', 'type', '"group"',
  'latestChapterTitle', 'latestChapterTime', 'lastCheckTime', 'lastCheckCount', 'totalChapterNum',
  'durChapterTitle', 'durChapterIndex', 'durVolumeIndex', 'chapterInVolumeIndex', 'durChapterPos',
  'durChapterTime', 'wordCount', 'canUpdate', '"order"', 'originOrder', 'variable', 'readConfig',
  'syncTime', 'persistedCoverUrl', 'payload', 'readStyle', 'progressSec', 'durationSec',
] as const;

const BOOK_PARAMS = BOOK_COLUMNS.map((c) => ':' + c.replace(/"/g, '')).join(', ');
/** `DO UPDATE SET` 子句：除主键外的所有列（用 `excluded.` 取新值）
 *  ⚠️ 列名若在 SQL 里需要引号（如 `"group"`/`"order"` 是关键字），`excluded.` 后面**也必须带引号**，
 *  否则 `excluded.group` 会报 `near "group": syntax error`。 */
const BOOK_DO_UPDATE = BOOK_COLUMNS.filter((c) => c !== 'bookUrl')
  .map((c) => `  ${c} = excluded.${c}`)
  .join(',\n');

const SQL = {
  /** ⚠️ 不能用 INSERT OR REPLACE —— 会触发 chapters 的 ON DELETE CASCADE（见文件头第 4 条） */
  upsertBook: `INSERT INTO books (${BOOK_COLUMNS.join(', ')}) VALUES (${BOOK_PARAMS})
ON CONFLICT(bookUrl) DO UPDATE SET
${BOOK_DO_UPDATE}`,
  deleteSameNameAuthor: 'DELETE FROM books WHERE name = :name AND author = :author AND bookUrl <> :bookUrl',
  getBook: 'SELECT * FROM books WHERE bookUrl = ?',
  deleteBook: 'DELETE FROM books WHERE bookUrl = ?',
  // 墓碑：删除优先（LWW）判据的来源。重复删除取**较大** deletedAt（时间不许倒退）。
  getBookTombstone: 'SELECT deletedAt FROM book_tombstones WHERE bookUrl = ?',
  upsertTombstone: `INSERT INTO book_tombstones (bookUrl, deletedAt) VALUES (:bookUrl, :deletedAt)
ON CONFLICT(bookUrl) DO UPDATE SET deletedAt = MAX(book_tombstones.deletedAt, excluded.deletedAt)`,
  deleteTombstone: 'DELETE FROM book_tombstones WHERE bookUrl = ?',
  listTombstones: 'SELECT bookUrl, deletedAt FROM book_tombstones ORDER BY deletedAt DESC',
  listTombstonesSince: 'SELECT bookUrl, deletedAt FROM book_tombstones WHERE deletedAt > ? ORDER BY deletedAt DESC',
  countBooks: 'SELECT COUNT(*) AS c FROM books',
  // `#208`：`syncTime = COALESCE(:syncTime, syncTime)` —— 不传就**保持原值**。
  // 写成 `:syncTime` 会让「每次读一章」把同步时间悄悄刷成现在 ⇒ 远端更新的进度被误判为「已同步过」而跳过。
  saveProgress: `UPDATE books SET durChapterIndex = :durChapterIndex, durChapterPos = :durChapterPos,
      durChapterTime = :durChapterTime, durChapterTitle = :durChapterTitle,
      durVolumeIndex = :durVolumeIndex, chapterInVolumeIndex = :chapterInVolumeIndex,
      syncTime = COALESCE(:syncTime, syncTime)
    WHERE bookUrl = :bookUrl`,

  listChapters: 'SELECT * FROM chapters WHERE bookUrl = ? ORDER BY "index" ASC',
  countChapters: 'SELECT COUNT(*) AS c FROM chapters WHERE bookUrl = ?',
  deleteChapters: 'DELETE FROM chapters WHERE bookUrl = ?',
  /** chapters 是叶子表 → REPLACE 安全（还能顺带解决 (bookUrl,index) 唯一冲突） */
  insertChapter: `INSERT OR REPLACE INTO chapters
    (url, title, isVolume, baseUrl, bookUrl, "index", isVip, isPay, resourceUrl, tag, wordCount,
     start, "end", startFragmentId, endFragmentId, variable, imgUrl)
    VALUES (:url, :title, :isVolume, :baseUrl, :bookUrl, :index, :isVip, :isPay, :resourceUrl, :tag,
     :wordCount, :start, :end, :startFragmentId, :endFragmentId, :variable, :imgUrl)`,

  upsertBookmark: `INSERT OR REPLACE INTO bookmarks
    (time, bookName, bookAuthor, chapterIndex, chapterPos, chapterName, bookText, content)
    VALUES (:time, :bookName, :bookAuthor, :chapterIndex, :chapterPos, :chapterName, :bookText, :content)`,
  deleteBookmark: 'DELETE FROM bookmarks WHERE time = ?',

  upsertHighlight: `INSERT OR REPLACE INTO highlights
    (time, bookUrl, chapterUrl, bookName, bookAuthor, chapterIndex, chapterPos, chapterPosEnd,
     layoutTitleLength, chapterName, bookText, style, note)
    VALUES (:time, :bookUrl, :chapterUrl, :bookName, :bookAuthor, :chapterIndex, :chapterPos,
     :chapterPosEnd, :layoutTitleLength, :chapterName, :bookText, :style, :note)`,
  deleteHighlight: 'DELETE FROM highlights WHERE time = ?',

  upsertBookMemo: `INSERT OR REPLACE INTO book_memos
    (time, bookUrl, bookName, bookAuthor, chapterIndex, chapterPos, chapterName, bookText, title, content)
    VALUES (:time, :bookUrl, :bookName, :bookAuthor, :chapterIndex, :chapterPos, :chapterName, :bookText, :title, :content)`,
  deleteBookMemo: 'DELETE FROM book_memos WHERE time = ?',

  upsertSearchHistory: `INSERT OR REPLACE INTO search_history (word, lastUseTime, usage)
    VALUES (:word, :lastUseTime, :usage)`,
  recordSearch: `INSERT INTO search_history (word, lastUseTime, usage) VALUES (:word, :now, 1)
    ON CONFLICT(word) DO UPDATE SET lastUseTime = excluded.lastUseTime, usage = search_history.usage + 1`,
  deleteSearchHistory: 'DELETE FROM search_history WHERE word = ?',
  clearSearchHistory: 'DELETE FROM search_history',

  upsertReplaceRule: `INSERT OR REPLACE INTO replace_rules
    (id, name, "group", pattern, replacement, scope, scopeTitle, scopeSource, scopeContent,
     excludeScope, isEnabled, isRegex, timeoutMillisecond, "order")
    VALUES (:id, :name, :group, :pattern, :replacement, :scope, :scopeTitle, :scopeSource,
     :scopeContent, :excludeScope, :isEnabled, :isRegex, :timeoutMillisecond, :order)`,
  deleteReplaceRule: 'DELETE FROM replace_rules WHERE id = ?',
  listDictRules: 'SELECT * FROM dict_rules ORDER BY sortNumber ASC, name ASC',
  upsertDictRule: `INSERT OR REPLACE INTO dict_rules
    (name, urlRule, showRule, enabled, sortNumber)
    VALUES (@name, @urlRule, @showRule, @enabled, @sortNumber)`,
  deleteDictRule: 'DELETE FROM dict_rules WHERE name = ?',

  upsertBookGroup: `INSERT OR REPLACE INTO book_groups
    (groupId, groupName, cover, "order", enableRefresh, show, bookSort, onlyUpdateRead)
    VALUES (:groupId, :groupName, :cover, :order, :enableRefresh, :show, :bookSort, :onlyUpdateRead)`,
  deleteBookGroup: 'DELETE FROM book_groups WHERE groupId = ?',

  getReadRecord: 'SELECT * FROM read_records WHERE deviceId = ? AND bookName = ?',
  insertReadRecord: `INSERT INTO read_records (deviceId, bookName, author, readTime, lastRead)
    VALUES (:deviceId, :bookName, :author, :readTime, :lastRead)`,
  updateReadRecord: `UPDATE read_records SET readTime = :readTime, lastRead = :lastRead, author = :author
    WHERE deviceId = :deviceId AND bookName = :bookName`,
  listReadRecords: 'SELECT * FROM read_records ORDER BY lastRead DESC',
  upsertReadRecord: `INSERT OR REPLACE INTO read_records (deviceId, bookName, author, readTime, lastRead)
    VALUES (@deviceId, @bookName, @author, @readTime, @lastRead)`,

  /* ---- `#863` 阅读会话统计（P1） ---- */
  insertReadSession: `INSERT OR IGNORE INTO read_session
    (session_id, device_id, book_url, book_name, book_author, chapter_index, chapter_title,
     start_at, end_at, total_ms, effective_ms, read_words, read_page_count, mode,
     start_progress, end_progress, tz_offset_min, created_at)
    VALUES (:sessionId, :deviceId, :bookUrl, :bookName, :bookAuthor, :chapterIndex, :chapterTitle,
     :startAt, :endAt, :totalMs, :effectiveMs, :readWords, :readPageCount, :mode,
     :startProgress, :endProgress, :tzOffsetMin, :createdAt)`,
  listReadSessions: 'SELECT * FROM read_session ORDER BY start_at DESC LIMIT ?',
  listReadSessionsByBook: 'SELECT * FROM read_session WHERE book_url = ? ORDER BY start_at DESC LIMIT ?',
  pruneReadSessions: 'DELETE FROM read_session WHERE start_at < ?',
  listUserReadStat: 'SELECT * FROM user_read_stat ORDER BY day ASC',
  listBookReadStat: 'SELECT * FROM book_read_stat ORDER BY effective_ms DESC, last_read_at DESC',
  // 每本书最近一条会话（断点）；同 end_at 的并列在 TS 侧按 book_url 去重
  latestSessionsPerBook: `SELECT rs.* FROM read_session rs
    JOIN (SELECT book_url, MAX(end_at) AS mx FROM read_session GROUP BY book_url) t
      ON rs.book_url = t.book_url AND rs.end_at = t.mx
    ORDER BY rs.end_at DESC LIMIT 40`,
  visualSessionAvg: `SELECT COUNT(*) AS c, COALESCE(SUM(effective_ms), 0) AS total
    FROM read_session WHERE mode = 'visual' AND effective_ms > 0`,
  legacyReadTotal: 'SELECT COALESCE(SUM(readTime), 0) AS total FROM read_records',

  /**
   * 按日聚合的**增量** upsert。四时段列全部传参（只有本切片的那个桶非 0）⇒
   * 不需要按列名拼 SQL（避免白名单拼错），`excluded.*` 对 0 值就是「加 0」。
   */
  addUserReadStat: `INSERT INTO user_read_stat
    (day, total_ms, effective_ms, visual_ms, listen_ms, auto_ms,
     dawn_ms, morning_ms, afternoon_ms, night_ms, session_count, page_count, word_count)
    VALUES (:day, :totalMs, :effectiveMs, :visualMs, :listenMs, :autoMs,
     :dawnMs, :morningMs, :afternoonMs, :nightMs, :sessions, :pages, :words)
    ON CONFLICT(day) DO UPDATE SET
      total_ms = user_read_stat.total_ms + excluded.total_ms,
      effective_ms = user_read_stat.effective_ms + excluded.effective_ms,
      visual_ms = user_read_stat.visual_ms + excluded.visual_ms,
      listen_ms = user_read_stat.listen_ms + excluded.listen_ms,
      auto_ms = user_read_stat.auto_ms + excluded.auto_ms,
      dawn_ms = user_read_stat.dawn_ms + excluded.dawn_ms,
      morning_ms = user_read_stat.morning_ms + excluded.morning_ms,
      afternoon_ms = user_read_stat.afternoon_ms + excluded.afternoon_ms,
      night_ms = user_read_stat.night_ms + excluded.night_ms,
      session_count = user_read_stat.session_count + excluded.session_count,
      page_count = user_read_stat.page_count + excluded.page_count,
      word_count = user_read_stat.word_count + excluded.word_count`,
  addBookReadStat: `INSERT INTO book_read_stat
    (book_url, book_name, author, total_ms, effective_ms, visual_ms, listen_ms, auto_ms,
     dawn_ms, morning_ms, afternoon_ms, night_ms, session_count, page_count, word_count,
     first_read_at, last_read_at)
    VALUES (:bookUrl, :bookName, :author, :totalMs, :effectiveMs, :visualMs, :listenMs, :autoMs,
     :dawnMs, :morningMs, :afternoonMs, :nightMs, :sessions, :pages, :words,
     :firstReadAt, :lastReadAt)
    ON CONFLICT(book_url) DO UPDATE SET
      book_name = CASE WHEN excluded.book_name <> '' THEN excluded.book_name ELSE book_read_stat.book_name END,
      author = CASE WHEN excluded.author <> '' THEN excluded.author ELSE book_read_stat.author END,
      total_ms = book_read_stat.total_ms + excluded.total_ms,
      effective_ms = book_read_stat.effective_ms + excluded.effective_ms,
      visual_ms = book_read_stat.visual_ms + excluded.visual_ms,
      listen_ms = book_read_stat.listen_ms + excluded.listen_ms,
      auto_ms = book_read_stat.auto_ms + excluded.auto_ms,
      dawn_ms = book_read_stat.dawn_ms + excluded.dawn_ms,
      morning_ms = book_read_stat.morning_ms + excluded.morning_ms,
      afternoon_ms = book_read_stat.afternoon_ms + excluded.afternoon_ms,
      night_ms = book_read_stat.night_ms + excluded.night_ms,
      session_count = book_read_stat.session_count + excluded.session_count,
      page_count = book_read_stat.page_count + excluded.page_count,
      word_count = book_read_stat.word_count + excluded.word_count,
      first_read_at = CASE
        WHEN book_read_stat.first_read_at <= 0 THEN excluded.first_read_at
        ELSE MIN(book_read_stat.first_read_at, excluded.first_read_at)
      END,
      last_read_at = MAX(book_read_stat.last_read_at, excluded.last_read_at)`,

  cacheGet: 'SELECT value, deadline FROM caches WHERE key = ?',
  cacheSet: 'INSERT OR REPLACE INTO caches (key, value, deadline) VALUES (:key, :value, :deadline)',
  cacheDelete: 'DELETE FROM caches WHERE key = ?',
  cacheSweep: 'DELETE FROM caches WHERE deadline > 0 AND deadline <= ?',
  cacheListAll: 'SELECT * FROM caches ORDER BY key ASC',
  cacheListPrefix: 'SELECT * FROM caches WHERE substr(key, 1, length(?)) = ? ORDER BY key ASC',

  getPrefs: 'SELECT value FROM prefs WHERE id = 1',
  setPrefs: 'INSERT OR REPLACE INTO prefs (id, value) VALUES (1, ?)',

  userVersion: 'PRAGMA user_version',
} as const;

/** 排序 → ORDER BY。映射是白名单，杜绝 SQL 注入 */
const ORDER_BY: Record<BookshelfSort, string> = {
  lastRead: 'durChapterTime DESC',
  manual: '"order" ASC, durChapterTime DESC',
  name: 'name ASC',
  author: 'author ASC',
  latestChapter: 'latestChapterTime DESC',
  updateTime: 'lastCheckTime DESC',
};

/* ------------------------------------------------------------------ *
 * 最小化 SQL 接口（避免把 node:sqlite 的类型泄漏到公开签名）
 * ------------------------------------------------------------------ */

type SqlValue = null | number | bigint | string | Uint8Array;

interface SqlStatement {
  setAllowBareNamedParameters(enabled: boolean): void;
  run(...args: unknown[]): { changes: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown;
  /** 列元数据（`node:sqlite` 有；NUL 安全读取靠它拿列名与声明类型） */
  columns?(): Array<{ column: string; type?: string | null }>;
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { enableForeignKeyConstraints?: boolean }) => SqlDatabase;
}

/** 动态加载 node:sqlite；不可用返回 null（不抛，由调用方决定回落策略） */
async function importSqliteModule(): Promise<SqliteModule | null> {
  try {
    const mod = (await import('node:sqlite')) as unknown as SqliteModule;
    return typeof mod.DatabaseSync === 'function' ? mod : null;
  } catch {
    return null;
  }
}

/**
 * 建表 + 版本校验。
 * - `user_version = 0` → 首次运行：建表后置为 {@link SCHEMA_VERSION}
 * - 大于当前代码支持的版本 → 抛错（用户用新版建过库，回退代码会读坏数据）
 */
function migrate(db: SqlDatabase): void {
  const row = db.prepare(SQL.userVersion).get() as { user_version?: number | bigint } | undefined;
  const version = row?.user_version === undefined ? 0 : Number(row.user_version);
  if (version > SCHEMA_VERSION) {
    throw new UserStoreOpenError(
      `数据目录里的 yuedu.db 版本更新（user_version=${version}，本代码支持 ${SCHEMA_VERSION}）。请升级应用，或换一个数据目录。`,
      'sqlite',
    );
  }
  db.exec(DDL);
  /**
   * v1 → v2：`books` 增加扩展列 `payload`（Phase 1.4 用；见 contract/user-data.ts 的同名字段）。
   *
   * 为什么需要 ALTER：`CREATE TABLE IF NOT EXISTS` 对**已存在的表**不会补列，
   * 而用户的数据目录里已经有 v1 的 `yuedu.db`。
   */
  if (version === 1) {
    try {
      db.exec('ALTER TABLE books ADD COLUMN payload TEXT');
    } catch (e) {
      // 只有「列已存在」可以吞（幂等重跑）；其它错误必须冒泡 —— 否则会「迁移看起来成功、
      // 但列没加上」⇒ 后续所有 payload 读写静默失败。
      if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  }
  /**
   * v1/v2 → v3（`#164`）：`books` 增加扩展列 `readStyle`。
   *
   * ⚠️ 判据是 `version <= 2` 而**不是** `version === 2` —— 从 v1 直接升到 v3 的用户
   * （中间那版从没跑过）**同样**要拿到这一列。写成 `=== 2` 会让这批用户的 `readStyle` 永远加不上，
   * 而症状是「每本覆盖存了就丢」，不报任何错。
   */
  if (version <= 2) {
    try {
      db.exec('ALTER TABLE books ADD COLUMN readStyle TEXT');
    } catch (e) {
      if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  }
  /**
   * v1/v2/v3 → v4（`#141`）：`books` 增加扩展列 `progressSec`/`durationSec`（影视播放进度/时长，秒）。
   * ⚠️ 与 v3 同理用 `version <= 3`：老数据目录可能跳版直升。
   */
  if (version <= 3) {
    for (const col of ['progressSec', 'durationSec']) {
      try {
        db.exec(`ALTER TABLE books ADD COLUMN ${col} INTEGER`);
      } catch (e) {
        if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    }
  }
  /**
   * v4 → v5（`#189`）：新增 `dict_rules` 表。
   * 与 v4 的 ALTER 不同，这里是**建表** ⇒ 用 `CREATE TABLE IF NOT EXISTS` 天然幂等。
   */
  if (version <= 4) {
    db.exec(`CREATE TABLE IF NOT EXISTS dict_rules (
      name          TEXT PRIMARY KEY,
      urlRule       TEXT NOT NULL DEFAULT '',
      showRule      TEXT NOT NULL DEFAULT '',
      enabled       INTEGER NOT NULL DEFAULT 1,
      sortNumber    INTEGER NOT NULL DEFAULT 0
    )`);
  }
  /**
   * v5 → v6（`#262`）：新增 `highlightRules` 表（高亮规则）。
   * 与 dict_rules 同理是**建表** ⇒ `CREATE TABLE IF NOT EXISTS` 幂等。
   */
  if (version <= 5) {
    db.exec(`CREATE TABLE IF NOT EXISTS highlightRules (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid               TEXT NOT NULL DEFAULT '',
      name               TEXT NOT NULL DEFAULT '',
      pattern            TEXT NOT NULL DEFAULT '',
      isRegex            INTEGER NOT NULL DEFAULT 0,
      scope              TEXT,
      isEnabled          INTEGER NOT NULL DEFAULT 1,
      style              TEXT NOT NULL DEFAULT '',
      sortOrder          INTEGER NOT NULL DEFAULT -2147483648,
      timeoutMillisecond INTEGER NOT NULL DEFAULT 3000,
      applyToTitle       INTEGER NOT NULL DEFAULT 0,
      applyToBody        INTEGER NOT NULL DEFAULT 1
    )`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_highlightRules_uuid ON highlightRules(uuid)');
  }
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/* ------------------------------------------------------------------ *
 * 主体
 * ------------------------------------------------------------------ */

export async function createSqliteUserStore(opts: UserStoreOptions): Promise<UserDataStore> {
  const mod = await importSqliteModule();
  if (!mod) {
    throw new UserStoreOpenError(
      'node:sqlite 不可用（需要 Node ≥22；Electron 需 ≥35）。请升级运行时，或改用 kind="json" 回落实现。',
    );
  }

  mkdirSync(opts.dir, { recursive: true });
  const dbPath = join(opts.dir, 'yuedu.db');
  const db = new mod.DatabaseSync(dbPath, {
    // 外键必须开启，否则 chapters 的 ON DELETE CASCADE 不生效（SQLite 默认关闭）
    enableForeignKeyConstraints: true,
  });

  // WAL：读写并发更好、崩溃恢复更稳；synchronous=NORMAL 是 WAL 下的推荐折中
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);

  /* ---------------- 语句缓存与事务 ---------------- */

  const stmtCache = new Map<string, SqlStatement>();
  const stmt = (sql: string): SqlStatement => {
    let cached = stmtCache.get(sql);
    if (!cached) {
      cached = db.prepare(sql);
      cached.setAllowBareNamedParameters(true);
      stmtCache.set(sql, cached);
    }
    return cached;
  };
  /* ------------------------------------------------------------------ *
   * NUL 安全读取 —— 缺陷类BU 的**统一防护**（所有读都走 all/one 两个口）
   * ------------------------------------------------------------------ */

  /**
   * `node:sqlite` 读 TEXT 时**在第一个 NUL 处截断**。
   *
   * 实测（2026-09-28，node v22.22.2 · `DatabaseSync`）：
   * ```
   * 写入含 \u0000 的 TEXT（52 字符）→ 读回 22 字符（截到 NUL 前）
   * 但 WHERE k = ? 用**原值**仍能命中 ⇒ 写入是完整的，只有读回被切
   * ```
   * 静默、无异常、无日志 —— 是最坏的一类缺陷（本项目的 `itemKey()` 分隔符正是 `\u0000`，
   * 书架主键就踩在上面，代价是「书架的书互相串」）。
   *
   * ## 防护做法：读的时候把 TEXT 列包成 BLOB
   * `CAST(col AS BLOB)` 拿回的是**原始字节**（含 NUL），`Buffer.from(u8).toString('utf8')`
   * 就能完整还原。因为不能对 `SELECT *` 整体 CAST，这里用 `stmt.columns()` 取列名与**声明类型**，
   * 再包一层子查询：
   * ```sql
   * SELECT CAST("a" AS BLOB) AS "a", "b", … FROM (<原 SQL>)
   * ```
   * 只 CAST **TEXT 列**，其余列原样 —— 避免把 INTEGER 读成 BLOB（实测那样会变成 `object`）。
   *
   * ## 两个刻意的保守点（宁可少保护，也不要读错数据）
   * 1. **列名重复时不改写**（`SELECT a, a` 或带 JOIN 的同名列）：子查询里无法按列位区分，
   *    改写会把第二列读成第一列的值。此时退回普通读并 `console.warn` 留痕。
   * 2. **没有 TEXT 列时不改写**（如 `SELECT COUNT(*) AS c`）：省掉无谓的子查询。
   *
   * 结果按 SQL 文本缓存；改写只在**第一次**执行某条 SQL 时算一次。
   */
  const nulSafeCache = new Map<string, { sql: string; blobCols: string[] } | null>();
  const nulWarned = new Set<string>();
  const warnOnceSql = (sql: string, msg: string, e?: unknown): void => {
    if (nulWarned.has(sql)) return;
    nulWarned.add(sql);
    // 兜底必须留痕（铁律 3）：跳过保护意味着「这条读可能被截断」，不能悄悄过去
    console.warn(`[user-store/sqlite] ${msg}：${sql}`, e ?? '');
  };

  function nulSafeRead(sql: string): { sql: string; blobCols: string[] } | null {
    const cached = nulSafeCache.get(sql);
    if (cached !== undefined) return cached;
    let out: { sql: string; blobCols: string[] } | null = null;
    try {
      const cols = stmt(sql).columns?.() ?? [];
      const names = cols.map((c) => String(c.column));
      const textCols = cols.filter((c) => String(c.type ?? '').toUpperCase() === 'TEXT').map((c) => String(c.column));
      if (!textCols.length) {
        out = null;
      } else if (new Set(names).size !== names.length) {
        warnOnceSql(sql, '该查询有重名列，跳过 NUL 安全读取（避免把同名第二列读成第一列）');
      } else {
        const sel = cols
          .map((c) =>
            textCols.includes(String(c.column))
              ? `CAST("${c.column}" AS BLOB) AS "${c.column}"`
              : `"${c.column}"`,
          )
          .join(', ');
        out = { sql: `SELECT ${sel} FROM (${sql})`, blobCols: textCols };
      }
    } catch (e) {
      warnOnceSql(sql, '取列元数据失败，跳过 NUL 安全读取', e);
      out = null;
    }
    nulSafeCache.set(sql, out);
    return out;
  }

  /** 把 TEXT 列读回的 BLOB 还原成字符串（NUL 完整保留）；非 BLOB 值原样返回 */
  function unblobText(row: Record<string, unknown>, blobCols: readonly string[]): Record<string, unknown> {
    for (const c of blobCols) {
      const v = row[c];
      if (v instanceof Uint8Array) row[c] = Buffer.from(v).toString('utf8');
    }
    return row;
  }

  const all = (sql: string, ...params: SqlValue[]): Record<string, unknown>[] => {
    // `#771`：`node:sqlite` 是**同步**驱动；一次大表扫描会直接占住主线程
    probeEnter('sqlite:query');
    try {
      const safe = nulSafeRead(sql);
      if (!safe) return stmt(sql).all(...params) as Record<string, unknown>[];
      return (stmt(safe.sql).all(...params) as Record<string, unknown>[]).map((r) => unblobText(r, safe.blobCols));
    } finally {
      probeLeave();
    }
  };
  const one = (sql: string, ...params: SqlValue[]): Record<string, unknown> | undefined => {
    probeEnter('sqlite:query');
    try {
      const safe = nulSafeRead(sql);
      if (!safe) return stmt(sql).get(...params) as Record<string, unknown> | undefined;
      const r = stmt(safe.sql).get(...params) as Record<string, unknown> | undefined;
      return r === undefined ? undefined : unblobText(r, safe.blobCols);
    } finally {
      probeLeave();
    }
  };

  /** 嵌套安全的事务（SQLite 的 BEGIN 不可嵌套，SAVEPOINT 可以） */
  let depth = 0;
  const tx = <T>(fn: () => T): T => {
    const name = `sp${depth}`;
    db.exec(`SAVEPOINT ${name}`);
    depth += 1;
    try {
      const out = fn();
      depth -= 1;
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      depth -= 1;
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        /* 回滚失败（如连接已断）→ 让上层拿到原始错误 */
      }
      throw e;
    }
  };

  /* ---------------- 书架映射 ---------------- */

  const bookParams = (bk: ShelfBook): Record<string, SqlValue> => ({
    bookUrl: bk.bookUrl,
    tocUrl: bk.tocUrl,
    origin: bk.origin,
    originName: bk.originName,
    name: bk.name,
    author: bk.author,
    kind: bk.kind,
    customTag: bk.customTag,
    coverUrl: bk.coverUrl,
    customCoverUrl: bk.customCoverUrl,
    intro: bk.intro,
    customIntro: bk.customIntro,
    charset: bk.charset,
    type: bk.type,
    group: bk.group,
    latestChapterTitle: bk.latestChapterTitle,
    latestChapterTime: bk.latestChapterTime,
    lastCheckTime: bk.lastCheckTime,
    lastCheckCount: bk.lastCheckCount,
    totalChapterNum: bk.totalChapterNum,
    durChapterTitle: bk.durChapterTitle,
    durChapterIndex: bk.durChapterIndex,
    durVolumeIndex: bk.durVolumeIndex,
    chapterInVolumeIndex: bk.chapterInVolumeIndex,
    durChapterPos: bk.durChapterPos,
    durChapterTime: bk.durChapterTime,
    wordCount: bk.wordCount,
    canUpdate: bv(bk.canUpdate),
    order: bk.order,
    originOrder: bk.originOrder,
    variable: bk.variable,
    readConfig: bk.readConfig ? JSON.stringify(bk.readConfig) : null,
    syncTime: bk.syncTime,
    persistedCoverUrl: bk.persistedCoverUrl,
    payload: bk.payload ?? null,
    // 同 readConfig：对象列 → JSON 字符串。`null` 表示「不覆盖，跟随全局」（**不要**存 `'{}'`，
    // 那样「没设置过」与「设置成空」不可区分 ⇒ 用户点「恢复默认」会留下一个空对象而不是清掉）。
    readStyle: bk.readStyle ? JSON.stringify(bk.readStyle) : null,
    // `#141`：影视进度（秒）。缺省存 NULL（与「没看过」可区分，前端按 undefined 处理）。
    progressSec: bk.progressSec ?? null,
    durationSec: bk.durationSec ?? null,
  });

  const rowToBook = (r: Record<string, unknown>): ShelfBook => ({
    bookUrl: s(r['bookUrl']),
    tocUrl: s(r['tocUrl']),
    origin: s(r['origin']),
    originName: s(r['originName']),
    name: s(r['name']),
    author: s(r['author']),
    kind: ns(r['kind']),
    customTag: ns(r['customTag']),
    coverUrl: ns(r['coverUrl']),
    customCoverUrl: ns(r['customCoverUrl']),
    intro: ns(r['intro']),
    customIntro: ns(r['customIntro']),
    charset: ns(r['charset']),
    type: n(r['type']),
    group: n(r['group']),
    latestChapterTitle: ns(r['latestChapterTitle']),
    latestChapterTime: n(r['latestChapterTime']),
    lastCheckTime: n(r['lastCheckTime']),
    lastCheckCount: n(r['lastCheckCount']),
    totalChapterNum: n(r['totalChapterNum']),
    durChapterTitle: ns(r['durChapterTitle']),
    durChapterIndex: n(r['durChapterIndex']),
    durVolumeIndex: n(r['durVolumeIndex']),
    chapterInVolumeIndex: n(r['chapterInVolumeIndex']),
    durChapterPos: n(r['durChapterPos']),
    durChapterTime: n(r['durChapterTime']),
    wordCount: ns(r['wordCount']),
    canUpdate: b(r['canUpdate']),
    order: n(r['order']),
    originOrder: n(r['originOrder']),
    variable: ns(r['variable']),
    // 空 → 按 Legado `Book.config` 语义惰性给默认值（只影响返回对象，不回写库）
    readConfig: r['readConfig'] == null
      ? emptyBookReadConfig()
      : jsonOf<BookReadConfig>(r['readConfig'], emptyBookReadConfig()),
    syncTime: n(r['syncTime']),
    persistedCoverUrl: ns(r['persistedCoverUrl']),
    // 本仓扩展列（列见 DDL 注释）：JSON 字符串原样带回，前端自己 JSON.parse
    payload: ns(r['payload']),
    // 本仓扩展列（`#164`）：对象列 → 解析回对象。**`null` 必须原样保留**（= 不覆盖），
    // 不能因为「解析失败就退回 `{}`」把 `null` 吞掉 —— 那会把「跟随全局」变成「覆盖成空」。
    readStyle: r['readStyle'] == null ? null : jsonOf<ReadStyleOverride>(r['readStyle'], {}),
    // `#141`：影视进度（秒）。NULL ⇒ undefined（与「没看过」可区分）。
    progressSec: r['progressSec'] == null ? undefined : n(r['progressSec']),
    durationSec: r['durationSec'] == null ? undefined : n(r['durationSec']),
  });

  /** 写一本书：先按 D1 删掉同名同作者的「另一本」，再 upsert（UPSERT 不触发级联） */
  const writeBookOne = (bk: ShelfBook): void => {
    // 删除优先（LWW）：墓碑比这一行「更新」⇒ 陈旧副本的复活写入，忽略。
    // 行更晚 ⇒ 用户确实在删除之后重新加入/重新播放 ⇒ 清墓碑、正常写入。
    const tomb = one(SQL.getBookTombstone, bk.bookUrl)?.['deletedAt'];
    if (tomb !== undefined && tomb !== null) {
      if (n(bk.durChapterTime) < n(tomb)) return;
      stmt(SQL.deleteTombstone).run(bk.bookUrl);
    }
    if (bk.name !== '' || bk.author !== '') {
      stmt(SQL.deleteSameNameAuthor).run({ name: bk.name, author: bk.author, bookUrl: bk.bookUrl });
    }
    stmt(SQL.upsertBook).run(bookParams(bk));
  };

  /* ---------------- 章节映射 ---------------- */

  const chapterParams = (c: ShelfChapter): Record<string, SqlValue> => ({
    url: c.url,
    title: c.title,
    isVolume: bv(c.isVolume),
    baseUrl: c.baseUrl,
    bookUrl: c.bookUrl,
    index: c.index,
    isVip: bv(c.isVip),
    isPay: bv(c.isPay),
    resourceUrl: c.resourceUrl,
    tag: c.tag,
    wordCount: c.wordCount,
    start: c.start,
    end: c.end,
    startFragmentId: c.startFragmentId,
    endFragmentId: c.endFragmentId,
    variable: c.variable,
    imgUrl: c.imgUrl,
  });

  const rowToChapter = (r: Record<string, unknown>): ShelfChapter => ({
    url: s(r['url']),
    title: s(r['title']),
    isVolume: b(r['isVolume']),
    baseUrl: s(r['baseUrl']),
    bookUrl: s(r['bookUrl']),
    index: n(r['index']),
    isVip: b(r['isVip']),
    isPay: b(r['isPay']),
    resourceUrl: ns(r['resourceUrl']),
    tag: ns(r['tag']),
    wordCount: ns(r['wordCount']),
    start: nn(r['start']),
    end: nn(r['end']),
    startFragmentId: ns(r['startFragmentId']),
    endFragmentId: ns(r['endFragmentId']),
    variable: ns(r['variable']),
    imgUrl: ns(r['imgUrl']),
  });

  /** 通用分批写入：每 {@link YIELD_EVERY} 条提交一次事务并让出事件循环 */
  const writeBatched = async <T>(items: T[], writeOne: (item: T) => void): Promise<BatchResult> => {
    let written = 0;
    let yields = 0;
    for (let i = 0; i < items.length; i += YIELD_EVERY) {
      const chunk = items.slice(i, i + YIELD_EVERY);
      tx(() => {
        for (const it of chunk) writeOne(it);
      });
      written += chunk.length;
      if (i + YIELD_EVERY < items.length) {
        yields += 1;
        await yieldNow();
      }
    }
    return { written, yields };
  };

  const readPrefs = (): GlobalReaderPrefs =>
    // ⚠️ 必须走 fillGlobalReaderPrefs：旧落库的 JSON 没有 `#163` 的嵌套键（cover/uiDayTheme/…），
    //    直接返回会让前端读 `prefs.value.cover.xxx` 抛 TypeError（见契约里该函数的说明）。
    fillGlobalReaderPrefs(jsonOf<unknown>(one(SQL.getPrefs)?.['value'], null));

  /* ---------------- 实现 ---------------- */

  const store: UserDataStore = {
    kind: 'sqlite',
    dir: opts.dir,

    /* ---- 书架 ---- */

    async listBooks(query: BookListQuery = {}): Promise<ShelfBook[]> {
      const where: string[] = [];
      const params: SqlValue[] = [];
      // D3：位掩码筛选，语义同 Legado `WHERE (group & :group) > 0`
      if (query.group !== undefined) {
        where.push('("group" & ?) > 0');
        params.push(query.group);
      }
      if (query.type !== undefined) {
        where.push('(type & ?) > 0');
        params.push(query.type);
      }
      if (query.search) {
        where.push('(name LIKE ? OR author LIKE ?)');
        params.push(`%${query.search}%`, `%${query.search}%`);
      }
      const order = ORDER_BY[query.sort ?? 'lastRead'];
      let sql = `SELECT * FROM books${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`;
      if (query.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(query.limit);
        if (query.offset !== undefined) {
          sql += ' OFFSET ?';
          params.push(query.offset);
        }
      }
      return all(sql, ...params).map(rowToBook);
    },

    async getBook(bookUrl: string): Promise<ShelfBook | null> {
      const r = one(SQL.getBook, bookUrl);
      return r ? rowToBook(r) : null;
    },

    async countBooks(): Promise<number> {
      return n(one(SQL.countBooks)?.['c']);
    },

    async upsertBook(book: ShelfBook): Promise<void> {
      tx(() => writeBookOne(book));
    },

    async upsertBooks(books: ShelfBook[]): Promise<BatchResult> {
      return writeBatched(books, writeBookOne);
    },

    async deleteBook(bookUrl: string, deletedAt: number = Date.now()): Promise<boolean> {
      return tx(() => {
        const removed = n(stmt(SQL.deleteBook).run(bookUrl).changes) > 0;
        // 墓碑**即使删不到行也要留**：见 types.ts `BookTombstone` 的说明（「没有」不等于「没被删」）
        stmt(SQL.upsertTombstone).run({ bookUrl, deletedAt });
        return removed;
      });
    },

    async clearBookTombstone(bookUrl: string): Promise<boolean> {
      return n(stmt(SQL.deleteTombstone).run(bookUrl).changes) > 0;
    },

    async listBookTombstones(since?: number): Promise<BookTombstone[]> {
      const rows = since === undefined ? all(SQL.listTombstones) : all(SQL.listTombstonesSince, since);
      return rows.map((r) => ({ bookUrl: s(r['bookUrl']), deletedAt: n(r['deletedAt']) }));
    },

    async saveProgress(bookUrl: string, patch: ProgressPatch): Promise<boolean> {
      const r = stmt(SQL.saveProgress).run({
        bookUrl,
        durChapterIndex: patch.durChapterIndex,
        durChapterPos: patch.durChapterPos,
        durChapterTime: patch.durChapterTime ?? Date.now(),
        durChapterTitle: patch.durChapterTitle ?? null,
        durVolumeIndex: patch.durVolumeIndex ?? 0,
        chapterInVolumeIndex: patch.chapterInVolumeIndex ?? 0,
        // `#208`：null ⇒ SQL 侧 COALESCE 保持原值（见 SQL.saveProgress 的注释）
        syncTime: patch.syncTime ?? null,
      });
      return n(r.changes) > 0;
    },

    /* ---- 目录 ---- */

    async listChapters(bookUrl: string): Promise<ShelfChapter[]> {
      return all(SQL.listChapters, bookUrl).map(rowToChapter);
    },

    async countChapters(bookUrl: string): Promise<number> {
      return n(one(SQL.countChapters, bookUrl)?.['c']);
    },

    async replaceChapters(bookUrl: string, chapters: ShelfChapter[]): Promise<BatchResult> {
      // 全量替换：先删后插，避免 (bookUrl, index) 唯一约束冲突
      stmt(SQL.deleteChapters).run(bookUrl);
      return writeBatched(chapters, (c) => {
        stmt(SQL.insertChapter).run(chapterParams({ ...c, bookUrl }));
      });
    },

    async upsertChapters(chapters: ShelfChapter[]): Promise<BatchResult> {
      return writeBatched(chapters, (c) => {
        stmt(SQL.insertChapter).run(chapterParams(c));
      });
    },

    /* ---- 书签 ---- */

    async listBookmarks(bookName?: string): Promise<Bookmark[]> {
      const list = bookName === undefined
        ? all('SELECT * FROM bookmarks ORDER BY time DESC')
        : all('SELECT * FROM bookmarks WHERE bookName = ? ORDER BY time DESC', bookName);
      return list.map((r) => ({
        time: n(r['time']),
        bookName: s(r['bookName']),
        bookAuthor: s(r['bookAuthor']),
        chapterIndex: n(r['chapterIndex']),
        chapterPos: n(r['chapterPos']),
        chapterName: s(r['chapterName']),
        bookText: s(r['bookText']),
        content: s(r['content']),
      }));
    },

    async upsertBookmark(bk: Bookmark): Promise<void> {
      stmt(SQL.upsertBookmark).run({
        time: bk.time,
        bookName: bk.bookName,
        bookAuthor: bk.bookAuthor,
        chapterIndex: bk.chapterIndex,
        chapterPos: bk.chapterPos,
        chapterName: bk.chapterName,
        bookText: bk.bookText,
        content: bk.content,
      });
    },

    async deleteBookmark(time: number): Promise<boolean> {
      return n(stmt(SQL.deleteBookmark).run(time).changes) > 0;
    },

    /* ---- 高亮 ---- */

    async listHighlights(bookUrl?: string): Promise<BookHighlight[]> {
      const list = bookUrl === undefined
        ? all('SELECT * FROM highlights ORDER BY time DESC')
        : all('SELECT * FROM highlights WHERE bookUrl = ? ORDER BY chapterIndex ASC, chapterPos ASC', bookUrl);
      return list.map((r) => ({
        time: n(r['time']),
        bookUrl: s(r['bookUrl']),
        chapterUrl: s(r['chapterUrl']),
        bookName: s(r['bookName']),
        bookAuthor: s(r['bookAuthor']),
        chapterIndex: n(r['chapterIndex']),
        chapterPos: n(r['chapterPos']),
        chapterPosEnd: n(r['chapterPosEnd']),
        layoutTitleLength: n(r['layoutTitleLength']),
        chapterName: s(r['chapterName']),
        bookText: s(r['bookText']),
        style: s(r['style']),
        note: s(r['note']),
      }));
    },

    async upsertHighlight(h: BookHighlight): Promise<void> {
      stmt(SQL.upsertHighlight).run({
        time: h.time,
        bookUrl: h.bookUrl,
        chapterUrl: h.chapterUrl,
        bookName: h.bookName,
        bookAuthor: h.bookAuthor,
        chapterIndex: h.chapterIndex,
        chapterPos: h.chapterPos,
        chapterPosEnd: h.chapterPosEnd,
        layoutTitleLength: h.layoutTitleLength,
        chapterName: h.chapterName,
        bookText: h.bookText,
        style: h.style,
        note: h.note,
      });
    },

    async deleteHighlight(time: number): Promise<boolean> {
      return n(stmt(SQL.deleteHighlight).run(time).changes) > 0;
    },

    /* ---- 书内备注 ---- */

    async listBookMemos(bookUrl?: string): Promise<BookMemo[]> {
      const list = bookUrl === undefined
        ? all('SELECT * FROM book_memos ORDER BY time DESC')
        : all('SELECT * FROM book_memos WHERE bookUrl = ? ORDER BY time DESC', bookUrl);
      return list.map((r) => ({
        time: n(r['time']),
        bookUrl: s(r['bookUrl']),
        bookName: s(r['bookName']),
        bookAuthor: s(r['bookAuthor']),
        chapterIndex: n(r['chapterIndex']),
        chapterPos: n(r['chapterPos']),
        chapterName: s(r['chapterName']),
        bookText: s(r['bookText']),
        title: s(r['title']),
        content: s(r['content']),
      }));
    },

    async upsertBookMemo(m: BookMemo): Promise<void> {
      stmt(SQL.upsertBookMemo).run({
        time: m.time,
        bookUrl: m.bookUrl ?? '',
        bookName: m.bookName ?? '',
        bookAuthor: m.bookAuthor ?? '',
        chapterIndex: m.chapterIndex ?? 0,
        chapterPos: m.chapterPos ?? 0,
        chapterName: m.chapterName ?? '',
        bookText: m.bookText ?? '',
        title: m.title ?? '',
        content: m.content ?? '',
      });
    },

    async deleteBookMemo(time: number): Promise<boolean> {
      return n(stmt(SQL.deleteBookMemo).run(time).changes) > 0;
    },

    /* ---- 搜索历史 ---- */

    async listSearchHistory(limit?: number): Promise<SearchHistoryEntry[]> {
      const rows = typeof limit === 'number' && limit > 0
        ? all('SELECT * FROM search_history ORDER BY lastUseTime DESC LIMIT ?', limit)
        : all('SELECT * FROM search_history ORDER BY lastUseTime DESC');
      return rows.map((r) => ({
        word: s(r['word']),
        lastUseTime: n(r['lastUseTime']),
        usage: n(r['usage']),
      }));
    },

    async recordSearch(word: string, now: number = Date.now()): Promise<SearchHistoryEntry | null> {
      const w = String(word ?? '').trim();
      if (!w) return null;
      stmt(SQL.recordSearch).run({ word: w, now });
      const row = one('SELECT * FROM search_history WHERE word = ?', w);
      return row ? { word: s(row['word']), lastUseTime: n(row['lastUseTime']), usage: n(row['usage']) } : null;
    },

    async upsertSearchHistory(entry: SearchHistoryEntry): Promise<void> {
      const w = String(entry?.word ?? '').trim();
      if (!w) return;
      stmt(SQL.upsertSearchHistory).run({
        word: w,
        lastUseTime: entry.lastUseTime ?? Date.now(),
        usage: entry.usage ?? 1,
      });
    },

    async deleteSearchHistory(word: string): Promise<boolean> {
      return n(stmt(SQL.deleteSearchHistory).run(word).changes) > 0;
    },

    async clearSearchHistory(): Promise<number> {
      return n(stmt(SQL.clearSearchHistory).run().changes);
    },

    /* ---- 净化规则 ---- */

    async listDictRules(): Promise<DictRule[]> {
      return all(SQL.listDictRules).map((r) => ({
        name: String(r['name'] ?? ''),
        urlRule: String(r['urlRule'] ?? ''),
        showRule: String(r['showRule'] ?? ''),
        enabled: !!n(r['enabled']),
        sortNumber: n(r['sortNumber']),
      }));
    },

    async upsertDictRule(r: DictRule): Promise<void> {
      stmt(SQL.upsertDictRule).run({
        name: r.name,
        urlRule: r.urlRule,
        showRule: r.showRule,
        enabled: r.enabled ? 1 : 0,
        sortNumber: r.sortNumber,
      });
    },

    async deleteDictRule(name: string): Promise<boolean> {
      return n(stmt(SQL.deleteDictRule).run(name).changes) > 0;
    },

    async listReplaceRules(): Promise<ReplaceRule[]> {
      return all('SELECT * FROM replace_rules ORDER BY "order" ASC, id ASC').map((r) => ({
        id: n(r['id']),
        name: s(r['name']),
        group: ns(r['group']),
        pattern: s(r['pattern']),
        replacement: s(r['replacement']),
        scope: ns(r['scope']),
        scopeTitle: b(r['scopeTitle']),
        scopeSource: b(r['scopeSource']),
        scopeContent: b(r['scopeContent']),
        excludeScope: ns(r['excludeScope']),
        isEnabled: b(r['isEnabled']),
        isRegex: b(r['isRegex']),
        timeoutMillisecond: n(r['timeoutMillisecond']),
        order: n(r['order']),
      }));
    },

    async upsertReplaceRule(r: ReplaceRule): Promise<void> {
      stmt(SQL.upsertReplaceRule).run({
        id: r.id,
        name: r.name,
        group: r.group,
        pattern: r.pattern,
        replacement: r.replacement,
        scope: r.scope,
        scopeTitle: bv(r.scopeTitle),
        scopeSource: bv(r.scopeSource),
        scopeContent: bv(r.scopeContent),
        excludeScope: r.excludeScope,
        isEnabled: bv(r.isEnabled),
        isRegex: bv(r.isRegex),
        timeoutMillisecond: r.timeoutMillisecond,
        order: r.order,
      });
    },

    async deleteReplaceRule(id: number): Promise<boolean> {
      return n(stmt(SQL.deleteReplaceRule).run(id).changes) > 0;
    },

    /* ---- 高亮规则（`#262`） ---- */

    async listHighlightRules(): Promise<HighlightRule[]> {
      // 对齐上游 DAO `all`：ORDER BY sortOrder ASC, id ASC
      return all('SELECT * FROM highlightRules ORDER BY sortOrder ASC, id ASC').map((r) => ({
        id: n(r['id']),
        uuid: s(r['uuid']),
        name: s(r['name']),
        pattern: s(r['pattern']),
        isRegex: b(r['isRegex']),
        scope: ns(r['scope']),
        isEnabled: b(r['isEnabled']),
        style: s(r['style']),
        order: n(r['sortOrder']),
        timeoutMillisecond: n(r['timeoutMillisecond']),
        applyToTitle: b(r['applyToTitle']),
        applyToBody: b(r['applyToBody']),
      }));
    },

    async upsertHighlightRule(r: HighlightRule): Promise<void> {
      // uuid 有唯一索引 ⇒ ON CONFLICT(uuid) 更新（保留本地 id 不被覆盖 —— 与上游
      // `mergeImportedHighlightRules`「沿用本地 id」一致）。id 由调用方生成
      // （前端用 Date.now()，同 replace-rules 模式）；<=0 传 NULL 走 AUTOINCREMENT 兜底。
      stmt(`INSERT INTO highlightRules
        (id, uuid, name, pattern, isRegex, scope, isEnabled, style, sortOrder, timeoutMillisecond, applyToTitle, applyToBody)
        VALUES (:id, :uuid, :name, :pattern, :isRegex, :scope, :isEnabled, :style, :sortOrder, :timeoutMillisecond, :applyToTitle, :applyToBody)
      ON CONFLICT(uuid) DO UPDATE SET
        name = excluded.name, pattern = excluded.pattern, isRegex = excluded.isRegex,
        scope = excluded.scope, isEnabled = excluded.isEnabled, style = excluded.style,
        sortOrder = excluded.sortOrder, timeoutMillisecond = excluded.timeoutMillisecond,
        applyToTitle = excluded.applyToTitle, applyToBody = excluded.applyToBody`).run({
        id: r.id > 0 ? r.id : null,
        uuid: r.uuid,
        name: r.name,
        pattern: r.pattern,
        isRegex: bv(r.isRegex),
        scope: r.scope,
        isEnabled: bv(r.isEnabled),
        style: r.style,
        sortOrder: r.order,
        timeoutMillisecond: r.timeoutMillisecond,
        applyToTitle: bv(r.applyToTitle),
        applyToBody: bv(r.applyToBody),
      });
    },

    async deleteHighlightRule(id: number): Promise<boolean> {
      return n(stmt('DELETE FROM highlightRules WHERE id = ?').run(id).changes) > 0;
    },

    /* ---- 分组 ---- */

    async listBookGroups(): Promise<BookGroup[]> {
      return all('SELECT * FROM book_groups ORDER BY "order" ASC, groupId ASC').map((r) => ({
        groupId: n(r['groupId']),
        groupName: s(r['groupName']),
        cover: ns(r['cover']),
        order: n(r['order']),
        enableRefresh: b(r['enableRefresh']),
        show: b(r['show']),
        bookSort: n(r['bookSort']),
        onlyUpdateRead: b(r['onlyUpdateRead']),
      }));
    },

    async upsertBookGroup(g: BookGroup): Promise<void> {
      stmt(SQL.upsertBookGroup).run({
        groupId: g.groupId,
        groupName: g.groupName,
        cover: g.cover,
        order: g.order,
        enableRefresh: bv(g.enableRefresh),
        show: bv(g.show),
        bookSort: g.bookSort,
        onlyUpdateRead: bv(g.onlyUpdateRead),
      });
    },

    async deleteBookGroup(groupId: number): Promise<boolean> {
      return n(stmt(SQL.deleteBookGroup).run(groupId).changes) > 0;
    },

    /* ---- 阅读时长（D2：按书名聚合） ---- */

    async listReadRecords(): Promise<ReadRecord[]> {
      return all(SQL.listReadRecords).map((r) => ({
        deviceId: s(r['deviceId']),
        bookName: s(r['bookName']),
        author: s(r['author']),
        readTime: n(r['readTime']),
        lastRead: n(r['lastRead']),
      }));
    },

    async addReadTime(deviceId: string, bookName: string, deltaMs: number, author?: string, now = Date.now()): Promise<void> {
      // 照抄 Legado：主键 (deviceId, bookName)，同名书共用一条；author 按 ReadRecordAuthors 规则合并
      const cur = one(SQL.getReadRecord, deviceId, bookName);
      if (cur) {
        stmt(SQL.updateReadRecord).run({
          deviceId,
          bookName,
          author: author ? mergeAuthors(s(cur['author']), author) : s(cur['author']),
          readTime: n(cur['readTime']) + deltaMs,
          lastRead: now,
        });
      } else {
        stmt(SQL.insertReadRecord).run({
          deviceId,
          bookName,
          author: author ? mergeAuthors('', author) : '',
          readTime: deltaMs,
          lastRead: now,
        });
      }
    },

    async upsertReadRecord(r: ReadRecord): Promise<void> {
      stmt(SQL.upsertReadRecord).run({
        deviceId: r.deviceId,
        bookName: r.bookName,
        author: r.author,
        readTime: r.readTime,
        lastRead: r.lastRead,
      });
    },

    async listReadRecordShows(): Promise<ReadRecordShow[]> {
      // 跨设备聚合：同名书 readTime 求和、lastRead 取最大，author 用 \u001F 串联后交给展示层去重
      const map = new Map<string, { readTime: number; lastRead: number; authors: string[] }>();
      for (const r of all(SQL.listReadRecords)) {
        const name = s(r['bookName']);
        const cur = map.get(name) ?? { readTime: 0, lastRead: 0, authors: [] };
        cur.readTime += n(r['readTime']);
        cur.lastRead = Math.max(cur.lastRead, n(r['lastRead']));
        cur.authors.push(s(r['author']));
        map.set(name, cur);
      }
      return [...map.entries()]
        .map(([bookName, v]) => ({
          bookName,
          readTime: v.readTime,
          lastRead: v.lastRead,
          author: displayAuthors(v.authors.join(AGGREGATE_SEPARATOR)),
        }))
        .sort((a, x) => x.lastRead - a.lastRead);
    },

    /* ---- `#863` 阅读会话统计（P1） ---- */

    async appendReadSessions(sessions: ReadSession[]): Promise<{ inserted: number; skipped: number }> {
      let inserted = 0;
      let skipped = 0;
      const cutoff = Date.now() - READ_SESSION_KEEP_DAYS * 86_400_000;
      tx(() => {
        for (const raw of sessions) {
          const s = normalizeReadSession(raw);
          if (!s) {
            skipped += 1;
            continue;
          }
          const changes = n(stmt(SQL.insertReadSession).run(sessionParams(s)).changes);
          if (changes === 0) {
            // 幂等：同一 session_id 重放 ⇒ 整条跳过，且不再重复累加聚合
            skipped += 1;
            continue;
          }
          inserted += 1;
          const slices = sliceSessionWindows(s.startAt, s.endAt, s.totalMs, s.effectiveMs, s.tzOffsetMin);
          let first = true;
          let totalMs = 0;
          let visualMs = 0;
          let dawnMs = 0;
          let morningMs = 0;
          let afternoonMs = 0;
          let nightMs = 0;
          for (const sl of slices) {
            const eff = s.mode === 'visual' ? sl.effectiveMs : 0;
            stmt(SQL.addUserReadStat).run({
              day: sl.day,
              totalMs: sl.totalMs,
              effectiveMs: eff,
              visualMs: s.mode === 'visual' ? sl.effectiveMs : 0,
              listenMs: s.mode === 'listen' ? sl.effectiveMs : 0,
              autoMs: s.mode === 'auto' ? sl.effectiveMs : 0,
              dawnMs: sl.bucket === 'dawn' ? eff : 0,
              morningMs: sl.bucket === 'morning' ? eff : 0,
              afternoonMs: sl.bucket === 'afternoon' ? eff : 0,
              nightMs: sl.bucket === 'night' ? eff : 0,
              sessions: first ? 1 : 0,
              pages: first ? s.readPageCount : 0,
              words: first ? s.readWords : 0,
            });
            totalMs += sl.totalMs;
            visualMs += eff;
            if (sl.bucket === 'dawn') dawnMs += eff;
            else if (sl.bucket === 'morning') morningMs += eff;
            else if (sl.bucket === 'afternoon') afternoonMs += eff;
            else nightMs += eff;
            first = false;
          }
          stmt(SQL.addBookReadStat).run({
            bookUrl: s.bookUrl,
            bookName: s.bookName,
            author: s.bookAuthor,
            totalMs,
            effectiveMs: visualMs,
            visualMs,
            listenMs: s.mode === 'listen' ? s.effectiveMs : 0,
            autoMs: s.mode === 'auto' ? s.effectiveMs : 0,
            dawnMs,
            morningMs,
            afternoonMs,
            nightMs,
            sessions: 1,
            pages: s.readPageCount,
            words: s.readWords,
            firstReadAt: s.startAt,
            lastReadAt: s.endAt,
          });
        }
        stmt(SQL.pruneReadSessions).run(cutoff);
      });
      return { inserted, skipped };
    },

    async listReadSessions(limit = 200, bookUrl?: string): Promise<ReadSession[]> {
      const n = Math.max(1, Math.min(2000, Math.floor(limit)));
      const rows = bookUrl ? all(SQL.listReadSessionsByBook, bookUrl, n) : all(SQL.listReadSessions, n);
      return rows.map(rowToReadSession);
    },

    async getReadStats(): Promise<ReadStatsSnapshot> {
      const days = all(SQL.listUserReadStat).map(rowToUserReadStat);
      const books = all(SQL.listBookReadStat).map(rowToBookReadStat);
      const byBook = new Map(books.map((b) => [b.bookUrl, b]));
      const breakPoints: ReadBreakPoint[] = [];
      const seen = new Set<string>();
      for (const r of all(SQL.latestSessionsPerBook)) {
        const s = rowToReadSession(r);
        if (seen.has(s.bookUrl)) continue;
        seen.add(s.bookUrl);
        breakPoints.push({
          bookUrl: s.bookUrl,
          bookName: s.bookName,
          chapterIndex: s.chapterIndex,
          chapterTitle: s.chapterTitle,
          lastReadAt: s.endAt,
          effectiveMs: byBook.get(s.bookUrl)?.effectiveMs ?? 0,
        });
        if (breakPoints.length >= 20) break;
      }
      const avgRow = one(SQL.visualSessionAvg);
      const cnt = n(avgRow?.['c']);
      const sum = n(avgRow?.['total']);
      return {
        days,
        books,
        breakPoints,
        avgVisualSessionMs: cnt > 0 ? Math.round(sum / cnt) : 0,
        visualSessionCount: cnt,
        legacyReadMs: n(one(SQL.legacyReadTotal)?.['total']),
        firstDay: days[0]?.day ?? '',
      };
    },

    /* ---- KV 缓存 ---- */

    async cacheGet(key: string, now = Date.now()): Promise<string | null> {
      const r = one(SQL.cacheGet, key);
      if (!r) return null;
      const deadline = n(r['deadline']);
      if (deadline > 0 && deadline <= now) {
        // 惰性过期：命中已过期条目顺手删掉
        stmt(SQL.cacheDelete).run(key);
        return null;
      }
      return ns(r['value']);
    },

    async cacheSet(key: string, value: string | null, ttlMs?: number, now = Date.now()): Promise<void> {
      // deadline = 0 表示永不过期（照抄 Legado `Cache.deadline`）
      const deadline = ttlMs === undefined || ttlMs <= 0 ? 0 : now + ttlMs;
      stmt(SQL.cacheSet).run({ key, value, deadline });
    },

    async cacheDelete(key: string): Promise<boolean> {
      return n(stmt(SQL.cacheDelete).run(key).changes) > 0;
    },

    async cacheSweep(now = Date.now()): Promise<number> {
      return n(stmt(SQL.cacheSweep).run(now).changes);
    },

    async cacheList(prefix?: string): Promise<CacheEntry[]> {
      const list = prefix === undefined
        ? all(SQL.cacheListAll)
        : all(SQL.cacheListPrefix, prefix, prefix);
      return list.map((r) => ({ key: s(r['key']), value: ns(r['value']), deadline: n(r['deadline']) }));
    },

    /* ---- 全局偏好 ---- */

    async getReaderPrefs(): Promise<GlobalReaderPrefs> {
      return readPrefs();
    },

    async setReaderPrefs(patch: Partial<GlobalReaderPrefs>): Promise<GlobalReaderPrefs> {
      const next: GlobalReaderPrefs = { ...readPrefs(), ...patch };
      stmt(SQL.setPrefs).run(JSON.stringify(next));
      return next;
    },

    /* ---- 生命周期 ---- */

    async close(): Promise<void> {
      try {
        // 把 WAL 合并回主库文件，避免留下 -wal/-shm 残留
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* 关闭路径不抛错 */
      }
      stmtCache.clear();
      db.close();
    },
  };

  if (opts.maintenance) {
    await store.cacheSweep();
  }

  return store;
}

/** 探测当前运行时是否支持 `node:sqlite`（供 `openUserStore` 与诊断端点使用） */
export async function hasSqliteSupport(): Promise<boolean> {
  return (await importSqliteModule()) !== null;
}

/** 当前 schema 版本（测试/诊断用） */
export const USER_STORE_SCHEMA_VERSION = SCHEMA_VERSION;
