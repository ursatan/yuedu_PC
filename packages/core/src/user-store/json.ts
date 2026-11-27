/**
 * JSON 文件用户数据存储（Phase 1.2 的**回落实现**）
 *
 * ## 什么时候会用到
 * `node:sqlite` 需要 **Node ≥22 / Electron ≥35**。若运行时更老（或用了裁剪过的 Node 构建），
 * SQLite 实现不可用，此时 `openUserStore` 回落到这里 —— 宁可慢，也不能让书架/进度**完全不可用**。
 *
 * ## 定位与代价（写清楚，避免误用）
 * - 全部数据装在**一个 JSON 文件**（`DATA_DIR/user-data.json`）并常驻内存 → 体积与启动解析成本随数据线性增长。
 *   实测对比见 `docs/移植路线图.md` §5.1：1000 本 × 1500 章时书架列表要 **4228ms**（SQLite 2ms）。
 * - 因此**只作为降级兜底**，不要在生产路径主动选它。
 * - 写盘是**防抖**的（{@link FLUSH_DELAY_MS}），`close()` 会强制 flush；进程被 kill 可能丢最后几百毫秒的写入。
 * - 不实现 `blobs`（二进制走 `blobs.ts`，两种实现共用）。
 *
 * ## 语义一致性
 * D1/D2/D3 三条决策与本文件同样生效（同名同作者只留一条、阅读记录按书名聚合、`group` 位掩码），
 * 逻辑与 `sqlite.ts` **刻意保持同构**，便于交叉验证。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  emptyBookReadConfig,
  emptyGlobalReaderPrefs,
  fillGlobalReaderPrefs,
  type BookReadStat,
  type BookGroup,
  type BookHighlight,
  type Bookmark,
  type BookMemo,
  type CacheEntry,
  type DictRule,
  type GlobalReaderPrefs,
  type HighlightRule,
  type ReadBreakPoint,
  type ReadRecord,
  type ReadRecordShow,
  type ReadSession,
  type ReadStatsSnapshot,
  type ReplaceRule,
  type SearchHistoryEntry,
  type ShelfBook,
  type ShelfChapter,
  type UserReadStat,
} from '../contract/user-data';
import { AGGREGATE_SEPARATOR, displayAuthors, mergeAuthors } from './author-agg';
import { normalizeReadSession, READ_SESSION_KEEP_DAYS, sliceSessionWindows } from './read-session';
import type {
  BatchResult,
  BookListQuery,
  BookshelfSort,
  BookTombstone,
  ProgressPatch,
  UserDataStore,
  UserStoreOptions,
} from './types';

/** 写盘防抖窗口 */
const FLUSH_DELAY_MS = 250;
/** 文件结构版本 */
const DOC_VERSION = 1;

interface UserDataDoc {
  version: number;
  books: ShelfBook[];
  chapters: ShelfChapter[];
  bookmarks: Bookmark[];
  highlights: BookHighlight[];
  /** 书内备注（Legado `BookMemo`） */
  bookMemos: BookMemo[];
  /** 搜索历史（Legado `SearchKeyword`） */
  searchHistory: SearchHistoryEntry[];
  replaceRules: ReplaceRule[];
  /** `#262` 高亮规则 */
  highlightRules: HighlightRule[];
  /** `#189` 字典规则 */
  dictRules: DictRule[];
  bookGroups: BookGroup[];
  readRecords: ReadRecord[];
  caches: CacheEntry[];
  prefs: GlobalReaderPrefs;
  /** 书架/观影历史的**删除墓碑**（跨端一致删除，见 `types.ts` 的 `BookTombstone`） */
  bookTombstones: BookTombstone[];
  /** `#863` 阅读会话流水（原始，保留 365 天） */
  readSessions: ReadSession[];
  /** `#863` 按书聚合（永久） */
  bookReadStats: BookReadStat[];
  /** `#863` 按日聚合（永久） */
  userReadStats: UserReadStat[];
}

function emptyDoc(): UserDataDoc {
  return {
    version: DOC_VERSION,
    books: [],
    chapters: [],
    bookmarks: [],
    highlights: [],
    bookMemos: [],
    searchHistory: [],
    replaceRules: [],
    highlightRules: [],
    dictRules: [],
    bookGroups: [],
    readRecords: [],
    caches: [],
    prefs: emptyGlobalReaderPrefs(),
    bookTombstones: [],
    readSessions: [],
    bookReadStats: [],
    userReadStats: [],
  };
}

/** `#863` 空日桶（列名与 SQLite 表保持一致） */
function emptyUserReadStat(day: string): UserReadStat {
  return {
    day,
    totalMs: 0,
    effectiveMs: 0,
    visualMs: 0,
    listenMs: 0,
    autoMs: 0,
    dawnMs: 0,
    morningMs: 0,
    afternoonMs: 0,
    nightMs: 0,
    sessionCount: 0,
    pageCount: 0,
    wordCount: 0,
  };
}

/** `#863` 空按书聚合行 */
function emptyBookReadStat(s: ReadSession): BookReadStat {
  return {
    bookUrl: s.bookUrl,
    bookName: s.bookName,
    author: s.bookAuthor,
    totalMs: 0,
    effectiveMs: 0,
    visualMs: 0,
    listenMs: 0,
    autoMs: 0,
    dawnMs: 0,
    morningMs: 0,
    afternoonMs: 0,
    nightMs: 0,
    sessionCount: 0,
    pageCount: 0,
    wordCount: 0,
    firstReadAt: 0,
    lastReadAt: 0,
  };
}

/**
 * 字符串比较：**按 UTF-16 码元**（`<`/`>`），与 SQLite 默认的 BINARY 排序一致，也对齐 Legado。
 *
 * ⚠️ 刻意**不用 `localeCompare`** —— 那会按拼音排序，导致 SQLite 与 JSON 两个实现给出不同的书架顺序。
 * 中文按拼音排序需要在插入时维护额外排序键（或注册 collation），属 Phase 2 书架体验的事，届时两个实现一起改。
 */
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const SORTERS: Record<BookshelfSort, (a: ShelfBook, b: ShelfBook) => number> = {
  lastRead: (a, b) => b.durChapterTime - a.durChapterTime,
  manual: (a, b) => a.order - b.order || b.durChapterTime - a.durChapterTime,
  name: (a, b) => cmpStr(a.name, b.name),
  author: (a, b) => cmpStr(a.author, b.author),
  latestChapter: (a, b) => b.latestChapterTime - a.latestChapterTime,
  updateTime: (a, b) => b.lastCheckTime - a.lastCheckTime,
};

export async function createJsonUserStore(opts: UserStoreOptions): Promise<UserDataStore> {
  mkdirSync(opts.dir, { recursive: true });
  const file = join(opts.dir, 'user-data.json');

  let doc: UserDataDoc;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UserDataDoc>;
    // ⚠️ 必须走 fillGlobalReaderPrefs：旧落库的 JSON 没有 `#163` 的嵌套键（见契约里该函数的说明）
    doc = {
      ...emptyDoc(),
      ...parsed,
      prefs: fillGlobalReaderPrefs(parsed.prefs),
      // 旧文件没有墓碑字段（2026-11-08 新增）⇒ 必须补数组，否则 `findIndex` 会抛 TypeError
      bookTombstones: Array.isArray(parsed.bookTombstones) ? parsed.bookTombstones : [],
      // `#863` 旧文件没有会话统计 ⇒ 补空数组（否则 appendReadSessions 直接 TypeError）
      readSessions: Array.isArray(parsed.readSessions) ? parsed.readSessions : [],
      bookReadStats: Array.isArray(parsed.bookReadStats) ? parsed.bookReadStats : [],
      userReadStats: Array.isArray(parsed.userReadStats) ? parsed.userReadStats : [],
      // 旧文件没有备注/搜索历史 ⇒ 补空数组（否则 findIndex 直接 TypeError）
      bookMemos: Array.isArray(parsed.bookMemos) ? parsed.bookMemos : [],
      searchHistory: Array.isArray(parsed.searchHistory) ? parsed.searchHistory : [],
    };
  } catch {
    // 首次运行 / 文件损坏 → 空文档（不删旧文件，便于人工抢救）
    doc = emptyDoc();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      writeFileSync(file, JSON.stringify(doc), 'utf-8');
    } catch {
      /* 落盘失败不阻断运行（下次写再试） */
    }
  };
  const touch = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushNow, FLUSH_DELAY_MS);
  };

  /** `#863` 取/建日桶 */
  const upsertDayStat = (day: string): UserReadStat => {
    let row = doc.userReadStats.find((d) => d.day === day);
    if (!row) {
      row = emptyUserReadStat(day);
      doc.userReadStats.push(row);
    }
    return row;
  };

  /** `#863` 取/建按书聚合，并按切片累加（与 SQLite 的 `addBookReadStat` 同口径） */
  const upsertBookStat = (s: ReadSession): BookReadStat => {
    let row = doc.bookReadStats.find((b) => b.bookUrl === s.bookUrl);
    if (!row) {
      row = emptyBookReadStat(s);
      doc.bookReadStats.push(row);
    }
    if (s.bookName) row.bookName = s.bookName;
    if (s.bookAuthor) row.author = s.bookAuthor;
    row.totalMs += s.totalMs;
    if (s.mode === 'visual') {
      row.effectiveMs += s.effectiveMs;
      row.visualMs += s.effectiveMs;
    } else if (s.mode === 'listen') {
      row.listenMs += s.effectiveMs;
    } else {
      row.autoMs += s.effectiveMs;
    }
    for (const sl of sliceSessionWindows(s.startAt, s.endAt, s.totalMs, s.effectiveMs, s.tzOffsetMin)) {
      if (s.mode === 'visual') row[`${sl.bucket}Ms`] += sl.effectiveMs;
    }
    row.firstReadAt = row.firstReadAt > 0 ? Math.min(row.firstReadAt, s.startAt) : s.startAt;
    row.lastReadAt = Math.max(row.lastReadAt, s.endAt);
    return row;
  };

  /** D1：同名同作者只留一条 —— 删掉「另一本」并连带其目录 */
  const dropDuplicateTitles = (book: ShelfBook): void => {
    if (book.name === '' && book.author === '') return;
    const victims = doc.books.filter(
      (b) => b.bookUrl !== book.bookUrl && b.name === book.name && b.author === book.author,
    );
    for (const v of victims) doc.chapters = doc.chapters.filter((c) => c.bookUrl !== v.bookUrl);
    doc.books = doc.books.filter((b) => !victims.includes(b));
  };

  const writeBookOne = (book: ShelfBook): void => {
    // 删除优先（LWW）：墓碑比这一行「更新」⇒ 这是陈旧副本的复活写入，直接忽略。
    // 行更晚 ⇒ 用户确实在删除之后重新加入/重新播放 ⇒ 清墓碑、正常写入。
    const ti = doc.bookTombstones.findIndex((t) => t.bookUrl === book.bookUrl);
    if (ti >= 0) {
      if (book.durChapterTime < doc.bookTombstones[ti]!.deletedAt) return;
      doc.bookTombstones.splice(ti, 1);
    }
    dropDuplicateTitles(book);
    const i = doc.books.findIndex((b) => b.bookUrl === book.bookUrl);
    if (i >= 0) doc.books[i] = { ...book };
    else doc.books.push({ ...book });
  };

  const writeChapters = (chapters: ShelfChapter[]): BatchResult => {
    for (const c of chapters) {
      const i = doc.chapters.findIndex((x) => x.url === c.url && x.bookUrl === c.bookUrl);
      if (i >= 0) doc.chapters[i] = { ...c };
      else doc.chapters.push({ ...c });
    }
    return { written: chapters.length, yields: 0 };
  };

  const store: UserDataStore = {
    kind: 'json',
    dir: opts.dir,

    /* ---- 书架 ---- */

    async listBooks(query: BookListQuery = {}): Promise<ShelfBook[]> {
      let out = doc.books.slice();
      // D3：位掩码筛选
      if (query.group !== undefined) out = out.filter((b) => (b.group & query.group!) > 0);
      if (query.type !== undefined) out = out.filter((b) => (b.type & query.type!) > 0);
      if (query.search) {
        const k = query.search.toLowerCase();
        out = out.filter((b) => b.name.toLowerCase().includes(k) || b.author.toLowerCase().includes(k));
      }
      out.sort(SORTERS[query.sort ?? 'lastRead']);
      const offset = query.offset ?? 0;
      if (query.limit !== undefined) out = out.slice(offset, offset + query.limit);
      else if (offset) out = out.slice(offset);
      // 与 SQLite 实现一致：readConfig 为空时惰性给默认值
      return out.map((b) => ({ ...b, readConfig: b.readConfig ?? emptyBookReadConfig() }));
    },

    async getBook(bookUrl: string): Promise<ShelfBook | null> {
      const b = doc.books.find((x) => x.bookUrl === bookUrl);
      return b ? { ...b, readConfig: b.readConfig ?? emptyBookReadConfig() } : null;
    },

    async countBooks(): Promise<number> {
      return doc.books.length;
    },

    async upsertBook(book: ShelfBook): Promise<void> {
      writeBookOne(book);
      touch();
    },

    async upsertBooks(books: ShelfBook[]): Promise<BatchResult> {
      for (const b of books) writeBookOne(b);
      touch();
      return { written: books.length, yields: 0 };
    },

    async deleteBook(bookUrl: string, deletedAt: number = Date.now()): Promise<boolean> {
      const before = doc.books.length;
      doc.books = doc.books.filter((b) => b.bookUrl !== bookUrl);
      // 外键 CASCADE 的等价物：手写实现必须自己删目录
      doc.chapters = doc.chapters.filter((c) => c.bookUrl !== bookUrl);
      // 墓碑：**即使这一行本来就不存在也要留**（保存端可能只是还没收到这条，
      // 「服务端没有」无法区分「没推过」与「被删了」，只有墓碑能表达后者）。
      // 重复删除取**较大**的 deletedAt：时间不能倒退，否则陈旧副本又能通过 LWW 比较。
      const i = doc.bookTombstones.findIndex((t) => t.bookUrl === bookUrl);
      if (i >= 0) doc.bookTombstones[i]!.deletedAt = Math.max(doc.bookTombstones[i]!.deletedAt, deletedAt);
      else doc.bookTombstones.push({ bookUrl, deletedAt });
      touch();
      return doc.books.length < before;
    },

    async clearBookTombstone(bookUrl: string): Promise<boolean> {
      const before = doc.bookTombstones.length;
      doc.bookTombstones = doc.bookTombstones.filter((t) => t.bookUrl !== bookUrl);
      touch();
      return doc.bookTombstones.length < before;
    },

    async listBookTombstones(since?: number): Promise<BookTombstone[]> {
      const list = since === undefined ? doc.bookTombstones : doc.bookTombstones.filter((t) => t.deletedAt > since);
      return list.map((t) => ({ ...t }));
    },

    async saveProgress(bookUrl: string, patch: ProgressPatch): Promise<boolean> {
      const b = doc.books.find((x) => x.bookUrl === bookUrl);
      if (!b) return false;
      b.durChapterIndex = patch.durChapterIndex;
      b.durChapterPos = patch.durChapterPos;
      b.durChapterTime = patch.durChapterTime ?? Date.now();
      if (patch.durChapterTitle !== undefined) b.durChapterTitle = patch.durChapterTitle;
      if (patch.durVolumeIndex !== undefined) b.durVolumeIndex = patch.durVolumeIndex;
      if (patch.chapterInVolumeIndex !== undefined) b.chapterInVolumeIndex = patch.chapterInVolumeIndex;
      // `#208`：不传 = 保持原值（与 SQLite 侧 COALESCE 同语义 —— 两者必须一致，否则两种实现对不上）
      if (patch.syncTime !== undefined) b.syncTime = patch.syncTime;
      touch();
      return true;
    },

    /* ---- 目录 ---- */

    async listChapters(bookUrl: string): Promise<ShelfChapter[]> {
      return doc.chapters.filter((c) => c.bookUrl === bookUrl).sort((a, b) => a.index - b.index).map((c) => ({ ...c }));
    },

    async countChapters(bookUrl: string): Promise<number> {
      return doc.chapters.filter((c) => c.bookUrl === bookUrl).length;
    },

    async replaceChapters(bookUrl: string, chapters: ShelfChapter[]): Promise<BatchResult> {
      doc.chapters = doc.chapters.filter((c) => c.bookUrl !== bookUrl);
      const r = writeChapters(chapters.map((c) => ({ ...c, bookUrl })));
      touch();
      return r;
    },

    async upsertChapters(chapters: ShelfChapter[]): Promise<BatchResult> {
      const r = writeChapters(chapters);
      touch();
      return r;
    },

    /* ---- 书签 ---- */

    async listBookmarks(bookName?: string): Promise<Bookmark[]> {
      const list = bookName === undefined ? doc.bookmarks : doc.bookmarks.filter((b) => b.bookName === bookName);
      return list.slice().sort((a, b) => b.time - a.time).map((b) => ({ ...b }));
    },

    async upsertBookmark(bk: Bookmark): Promise<void> {
      const i = doc.bookmarks.findIndex((x) => x.time === bk.time);
      if (i >= 0) doc.bookmarks[i] = { ...bk };
      else doc.bookmarks.push({ ...bk });
      touch();
    },

    async deleteBookmark(time: number): Promise<boolean> {
      const before = doc.bookmarks.length;
      doc.bookmarks = doc.bookmarks.filter((b) => b.time !== time);
      touch();
      return doc.bookmarks.length < before;
    },

    /* ---- 高亮 ---- */

    async listHighlights(bookUrl?: string): Promise<BookHighlight[]> {
      const list = bookUrl === undefined ? doc.highlights : doc.highlights.filter((h) => h.bookUrl === bookUrl);
      return list.slice().sort((a, b) => a.chapterIndex - b.chapterIndex || a.chapterPos - b.chapterPos).map((h) => ({ ...h }));
    },

    async upsertHighlight(h: BookHighlight): Promise<void> {
      const i = doc.highlights.findIndex((x) => x.time === h.time);
      if (i >= 0) doc.highlights[i] = { ...h };
      else doc.highlights.push({ ...h });
      touch();
    },

    async deleteHighlight(time: number): Promise<boolean> {
      const before = doc.highlights.length;
      doc.highlights = doc.highlights.filter((h) => h.time !== time);
      touch();
      return doc.highlights.length < before;
    },

    /* ---- 书内备注 ---- */

    async listBookMemos(bookUrl?: string): Promise<BookMemo[]> {
      const list = bookUrl === undefined ? doc.bookMemos : doc.bookMemos.filter((m) => m.bookUrl === bookUrl);
      return list.slice().sort((a, b) => b.time - a.time).map((m) => ({ ...m }));
    },

    async upsertBookMemo(m: BookMemo): Promise<void> {
      const i = doc.bookMemos.findIndex((x) => x.time === m.time);
      if (i >= 0) doc.bookMemos[i] = { ...m };
      else doc.bookMemos.push({ ...m });
      touch();
    },

    async deleteBookMemo(time: number): Promise<boolean> {
      const before = doc.bookMemos.length;
      doc.bookMemos = doc.bookMemos.filter((m) => m.time !== time);
      touch();
      return doc.bookMemos.length < before;
    },

    /* ---- 搜索历史 ---- */

    async listSearchHistory(limit?: number): Promise<SearchHistoryEntry[]> {
      const list = doc.searchHistory.slice().sort((a, b) => b.lastUseTime - a.lastUseTime);
      const sliced = typeof limit === 'number' && limit > 0 ? list.slice(0, limit) : list;
      return sliced.map((e) => ({ ...e }));
    },

    async recordSearch(word: string, now: number = Date.now()): Promise<SearchHistoryEntry | null> {
      const w = String(word ?? '').trim();
      if (!w) return null;
      const i = doc.searchHistory.findIndex((x) => x.word === w);
      let row: SearchHistoryEntry;
      if (i >= 0) {
        row = { ...doc.searchHistory[i]!, usage: doc.searchHistory[i]!.usage + 1, lastUseTime: now };
        doc.searchHistory[i] = row;
      } else {
        row = { word: w, lastUseTime: now, usage: 1 };
        doc.searchHistory.push(row);
      }
      touch();
      return { ...row };
    },

    async upsertSearchHistory(entry: SearchHistoryEntry): Promise<void> {
      const w = String(entry?.word ?? '').trim();
      if (!w) return;
      const i = doc.searchHistory.findIndex((x) => x.word === w);
      const row: SearchHistoryEntry = { ...entry, word: w };
      if (i >= 0) doc.searchHistory[i] = row;
      else doc.searchHistory.push(row);
      touch();
    },

    async deleteSearchHistory(word: string): Promise<boolean> {
      const before = doc.searchHistory.length;
      doc.searchHistory = doc.searchHistory.filter((x) => x.word !== word);
      if (doc.searchHistory.length !== before) touch();
      return doc.searchHistory.length !== before;
    },

    async clearSearchHistory(): Promise<number> {
      const n = doc.searchHistory.length;
      doc.searchHistory = [];
      if (n) touch();
      return n;
    },

    /* ---- 字典规则（`#189`） ---- */

    async listDictRules(): Promise<DictRule[]> {
      return doc.dictRules.slice().sort((a, b) => a.sortNumber - b.sortNumber).map((r) => ({ ...r }));
    },

    async upsertDictRule(r: DictRule): Promise<void> {
      const i = doc.dictRules.findIndex((x) => x.name === r.name);
      if (i >= 0) doc.dictRules[i] = { ...r };
      else doc.dictRules.push({ ...r });
      touch();
    },

    async deleteDictRule(name: string): Promise<boolean> {
      const before = doc.dictRules.length;
      doc.dictRules = doc.dictRules.filter((x) => x.name !== name);
      if (doc.dictRules.length !== before) touch();
      return doc.dictRules.length !== before;
    },

    /* ---- 净化规则 ---- */

    async listReplaceRules(): Promise<ReplaceRule[]> {
      return doc.replaceRules.slice().sort((a, b) => a.order - b.order || a.id - b.id).map((r) => ({ ...r }));
    },

    async upsertReplaceRule(r: ReplaceRule): Promise<void> {
      const i = doc.replaceRules.findIndex((x) => x.id === r.id);
      if (i >= 0) doc.replaceRules[i] = { ...r };
      else doc.replaceRules.push({ ...r });
      touch();
    },

    async deleteReplaceRule(id: number): Promise<boolean> {
      const before = doc.replaceRules.length;
      doc.replaceRules = doc.replaceRules.filter((r) => r.id !== id);
      touch();
      return doc.replaceRules.length < before;
    },

    /* ---- 高亮规则（`#262`） ---- */

    async listHighlightRules(): Promise<HighlightRule[]> {
      // 排序口径与 sqlite 一致：order（=sortOrder）升序，同 id 升序
      return doc.highlightRules.slice().sort((a, b) => a.order - b.order || a.id - b.id).map((r) => ({ ...r }));
    },

    async upsertHighlightRule(r: HighlightRule): Promise<void> {
      // 与 sqlite 同口径：uuid 命中（不分大小写）⇒ 覆盖更新（沿用本地 id）；否则按 id 插入
      const key = r.uuid.toLowerCase();
      const existing = doc.highlightRules.find((x) => x.uuid.toLowerCase() === key);
      if (existing) {
        const merged = { ...r, id: existing.id || r.id };
        doc.highlightRules = doc.highlightRules.map((x) => (x.uuid.toLowerCase() === key ? merged : x));
      } else {
        doc.highlightRules.push({ ...r });
      }
      touch();
    },

    async deleteHighlightRule(id: number): Promise<boolean> {
      const before = doc.highlightRules.length;
      doc.highlightRules = doc.highlightRules.filter((r) => r.id !== id);
      touch();
      return doc.highlightRules.length < before;
    },

    /* ---- 分组 ---- */

    async listBookGroups(): Promise<BookGroup[]> {
      return doc.bookGroups.slice().sort((a, b) => a.order - b.order || a.groupId - b.groupId).map((g) => ({ ...g }));
    },

    async upsertBookGroup(g: BookGroup): Promise<void> {
      const i = doc.bookGroups.findIndex((x) => x.groupId === g.groupId);
      if (i >= 0) doc.bookGroups[i] = { ...g };
      else doc.bookGroups.push({ ...g });
      touch();
    },

    async deleteBookGroup(groupId: number): Promise<boolean> {
      const before = doc.bookGroups.length;
      doc.bookGroups = doc.bookGroups.filter((g) => g.groupId !== groupId);
      touch();
      return doc.bookGroups.length < before;
    },

    /* ---- 阅读时长（D2：按书名聚合） ---- */

    async listReadRecords(): Promise<ReadRecord[]> {
      return doc.readRecords.slice().sort((a, b) => b.lastRead - a.lastRead).map((r) => ({ ...r }));
    },

    async addReadTime(deviceId: string, bookName: string, deltaMs: number, author?: string, now = Date.now()): Promise<void> {
      const cur = doc.readRecords.find((r) => r.deviceId === deviceId && r.bookName === bookName);
      if (cur) {
        cur.readTime += deltaMs;
        cur.lastRead = now;
        if (author) cur.author = mergeAuthors(cur.author, author);
      } else {
        doc.readRecords.push({
          deviceId,
          bookName,
          author: author ? mergeAuthors('', author) : '',
          readTime: deltaMs,
          lastRead: now,
        });
      }
      touch();
    },

    async upsertReadRecord(r: ReadRecord): Promise<void> {
      const i = doc.readRecords.findIndex((x) => x.deviceId === r.deviceId && x.bookName === r.bookName);
      if (i >= 0) doc.readRecords[i] = { ...r };
      else doc.readRecords.push({ ...r });
      touch();
    },

    async listReadRecordShows(): Promise<ReadRecordShow[]> {
      const map = new Map<string, { readTime: number; lastRead: number; authors: string[] }>();
      for (const r of doc.readRecords) {
        const cur = map.get(r.bookName) ?? { readTime: 0, lastRead: 0, authors: [] };
        cur.readTime += r.readTime;
        cur.lastRead = Math.max(cur.lastRead, r.lastRead);
        cur.authors.push(r.author);
        map.set(r.bookName, cur);
      }
      return [...map.entries()]
        .map(([bookName, v]) => ({
          bookName,
          readTime: v.readTime,
          lastRead: v.lastRead,
          author: displayAuthors(v.authors.join(AGGREGATE_SEPARATOR)),
        }))
        .sort((a, b) => b.lastRead - a.lastRead);
    },

    /* ---- `#863` 阅读会话统计（语义与 sqlite 实现同构） ---- */

    async appendReadSessions(sessions: ReadSession[]): Promise<{ inserted: number; skipped: number }> {
      let inserted = 0;
      let skipped = 0;
      const cutoff = Date.now() - READ_SESSION_KEEP_DAYS * 86_400_000;
      for (const raw of sessions) {
        const s = normalizeReadSession(raw);
        if (!s) {
          skipped += 1;
          continue;
        }
        if (doc.readSessions.some((x) => x.sessionId === s.sessionId)) {
          skipped += 1;
          continue;
        }
        doc.readSessions.push(s);
        inserted += 1;
        const slices = sliceSessionWindows(s.startAt, s.endAt, s.totalMs, s.effectiveMs, s.tzOffsetMin);
        let first = true;
        for (const sl of slices) {
          const eff = s.mode === 'visual' ? sl.effectiveMs : 0;
          const day = upsertDayStat(sl.day);
          day.totalMs += sl.totalMs;
          day.effectiveMs += eff;
          day.visualMs += s.mode === 'visual' ? sl.effectiveMs : 0;
          day.listenMs += s.mode === 'listen' ? sl.effectiveMs : 0;
          day.autoMs += s.mode === 'auto' ? sl.effectiveMs : 0;
          day[`${sl.bucket}Ms`] += eff;
          if (first) {
            day.sessionCount += 1;
            day.pageCount += s.readPageCount;
            day.wordCount += s.readWords;
          }
          first = false;
        }
        const book = upsertBookStat(s);
        book.sessionCount += 1;
        book.pageCount += s.readPageCount;
        book.wordCount += s.readWords;
      }
      doc.readSessions = doc.readSessions.filter((x) => x.startAt >= cutoff);
      touch();
      return { inserted, skipped };
    },

    async listReadSessions(limit = 200, bookUrl?: string): Promise<ReadSession[]> {
      return [...doc.readSessions]
        .filter((s) => !bookUrl || s.bookUrl === bookUrl)
        .sort((a, b) => b.startAt - a.startAt)
        .slice(0, Math.max(1, Math.min(2000, Math.floor(limit))));
    },

    async getReadStats(): Promise<ReadStatsSnapshot> {
      const days = [...doc.userReadStats].sort((a, b) => cmpStr(a.day, b.day));
      const books = [...doc.bookReadStats].sort(
        (a, b) => b.effectiveMs - a.effectiveMs || b.lastReadAt - a.lastReadAt,
      );
      const byBook = new Map(books.map((b) => [b.bookUrl, b]));
      const latest = [...doc.readSessions].sort((a, b) => b.endAt - a.endAt);
      const breakPoints: ReadBreakPoint[] = [];
      const seen = new Set<string>();
      for (const s of latest) {
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
      const visual = doc.readSessions.filter((x) => x.mode === 'visual' && x.effectiveMs > 0);
      const sum = visual.reduce((a, x) => a + x.effectiveMs, 0);
      return {
        days,
        books,
        breakPoints,
        avgVisualSessionMs: visual.length > 0 ? Math.round(sum / visual.length) : 0,
        visualSessionCount: visual.length,
        legacyReadMs: doc.readRecords.reduce((a, r) => a + r.readTime, 0),
        firstDay: days[0]?.day ?? '',
      };
    },

    /* ---- KV 缓存 ---- */

    async cacheGet(key: string, now = Date.now()): Promise<string | null> {
      const i = doc.caches.findIndex((c) => c.key === key);
      const c = i >= 0 ? doc.caches[i] : undefined;
      if (!c) return null;
      if (c.deadline > 0 && c.deadline <= now) {
        doc.caches.splice(i, 1);
        touch();
        return null;
      }
      return c.value;
    },

    async cacheSet(key: string, value: string | null, ttlMs?: number, now = Date.now()): Promise<void> {
      const deadline = ttlMs === undefined || ttlMs <= 0 ? 0 : now + ttlMs;
      const i = doc.caches.findIndex((c) => c.key === key);
      if (i >= 0) doc.caches[i] = { key, value, deadline };
      else doc.caches.push({ key, value, deadline });
      touch();
    },

    async cacheDelete(key: string): Promise<boolean> {
      const before = doc.caches.length;
      doc.caches = doc.caches.filter((c) => c.key !== key);
      touch();
      return doc.caches.length < before;
    },

    async cacheSweep(now = Date.now()): Promise<number> {
      const before = doc.caches.length;
      doc.caches = doc.caches.filter((c) => !(c.deadline > 0 && c.deadline <= now));
      const removed = before - doc.caches.length;
      if (removed) touch();
      return removed;
    },

    async cacheList(prefix?: string): Promise<CacheEntry[]> {
      const list = prefix === undefined ? doc.caches : doc.caches.filter((c) => c.key.startsWith(prefix));
      return list.slice().sort((a, b) => a.key.localeCompare(b.key)).map((c) => ({ ...c }));
    },

    /* ---- 全局偏好 ---- */

    async getReaderPrefs(): Promise<GlobalReaderPrefs> {
      return { ...doc.prefs };
    },

    async setReaderPrefs(patch: Partial<GlobalReaderPrefs>): Promise<GlobalReaderPrefs> {
      doc.prefs = { ...doc.prefs, ...patch };
      touch();
      return { ...doc.prefs };
    },

    /* ---- 生命周期 ---- */

    async close(): Promise<void> {
      flushNow();
    },
  };

  return store;
}

/** JSON 回落实现在内存里持有整份数据 —— 暴露给诊断端点用（体积预警） */
export function jsonStoreFile(dir: string): string {
  return join(dir, 'user-data.json');
}
