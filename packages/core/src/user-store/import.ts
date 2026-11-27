/**
 * 用户数据**导入 / 合并**（`#201`）
 *
 * 与 `GET /api/user/snapshot`（导出）配对：把一份快照**合并**回存储。
 *
 * ## 为什么单独成模块
 * 合并规则要能被**单测**锁死（放服务端就没法在 core 的回归里跑）；而且它是纯粹的
 * 「存储层策略」，不该混进 HTTP 路由里。服务端端点只做「解析 + 转调 + 报错」。
 *
 * ## 合并语义（两条，刻意都不删）
 * - **合并（默认）**：只补**服务端没有的**条目（按主键）；已存在的一律**不动**。
 *   理由与 `#191`（多端同步合并语义）同源：导入的备份可能**比线上旧**，
 *   覆盖会把用户后来的进度/笔记倒退回去，而且**不可恢复**。
 * - **覆盖同名（`overwrite: true`）**：主键冲突时以**快照**为准（仍是 upsert，不删除
 *   任何条目）。用于「换设备恢复」这种「服务端本来就是空的」场景，也用于用户
 *   明确想把备份覆盖回来。
 *
 * ⚠️ **本模块永不删除任何数据** —— 删除只能由用户在界面上显式操作（与 `#191` 一致）。
 *
 * ## 逐实体的主键与取舍
 * | 实体 | 主键 | 合并（默认） | 覆盖 |
 * |---|---|---|---|
 * | books | `bookUrl` | 只补新增 | 以快照为准 |
 * | chapters | `(url, bookUrl)` | 只补新增 | 以快照为准 |
 * | bookmarks | `time` | 只补新增 | 以快照为准 |
 * | highlights | `time` | 只补新增 | 以快照为准 |
 * | replaceRules | `id` | 只补新增 | 以快照为准 |
 * | highlightRules | `uuid` | 只补新增（覆盖时沿用本地 id） | 以快照为准 |
 * | dictRules | `name` | 只补新增 | 以快照为准 |
 * | bookGroups | `groupId` | 只补新增 | 以快照为准 |
 * | readRecords | `(deviceId, bookName)` | **取阅读时长更大者**（相等则取更晚 lastRead） | 以快照为准 |
 * | prefs | 单行 | **只填「服务端仍是默认值」的字段** | 以快照为准 |
 *
 * readRecords 与 prefs 之所以不是「一律不动」：它们是**累积型/全局型**数据，
 * 「一律不动」会让换设备恢复**看起来什么也没恢复**。两条规则都写明了判据，可复现。
 */

import {
  emptyBookGroup,
  emptyBookHighlight,
  emptyBookMemo,
  emptyBookmark,
  emptyGlobalReaderPrefs,
  emptyHighlightRule,
  emptyReplaceRule,
  emptySearchHistoryEntry,
  emptyShelfBook,
  emptyShelfChapter,
  type BookGroup,
  type BookHighlight,
  type BookMemo,
  type Bookmark,
  type DictRule,
  type ImportCounts,
  type ImportResult,
  type GlobalReaderPrefs,
  type ReadRecord,
  type ReplaceRule,
  type SearchHistoryEntry,
  type ShelfBook,
  type ShelfChapter,
} from '../contract/user-data';
import type { UserDataStore } from './types';

/** 最小快照形状（比导出端点更宽松：缺字段按「没有」处理） */
export interface UserSnapshotInput {
  version?: number;
  exportedAt?: number;
  books?: unknown[];
  chapters?: Record<string, unknown[]>;
  bookmarks?: unknown[];
  highlights?: unknown[];
  replaceRules?: unknown[];
  highlightRules?: unknown[];
  dictRules?: unknown[];
  bookGroups?: unknown[];
  readRecords?: unknown[];
  /** 书内备注（Legado `BookMemo`） */
  bookMemos?: unknown[];
  /** 搜索历史（Legado `SearchKeyword`） */
  searchHistory?: unknown[];
  prefs?: Record<string, unknown>;
}

export type { ImportCounts, ImportResult } from '../contract/user-data';

export interface ImportOptions {
  /** true = 主键冲突时以快照为准；缺省 false = 只补新增（见文件头说明） */
  overwrite?: boolean;
}

const zero = (): ImportCounts => ({ added: 0, updated: 0, kept: 0, skipped: 0 });

/**
 * 用 `base` 的**键集**从 `raw` 取值装配对象。
 *
 * 为什么不直接 `{ ...base, ...raw }`：那样会把快照里的**未知/多余字段**一并写进存储
 * （历史备份、手改过的 JSON、上游字段名变更都会带来），既污染数据又可能撞上 SQL 列校验。
 * 这里只认当前契约的字段 ⇒ 老备份也能安全导入。
 */
function fill<T extends object>(base: T, raw: unknown): T {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...base } as Record<string, unknown>;
  for (const k of Object.keys(base as Record<string, unknown>)) {
    const v = src[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out as T;
}

const numOf = (v: unknown, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const strOf = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? d : String(v));

/**
 * 把一份快照合并进存储。**永不删除**；逐实体规则见文件头表格。
 *
 * 调用方（服务端）负责解析 JSON 与鉴权；本函数只做存储动作，失败会向上抛。
 */
export async function importSnapshot(
  store: UserDataStore,
  snap: UserSnapshotInput,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const overwrite = opts.overwrite === true;
  const res: ImportResult = {
    books: zero(),
    chapters: zero(),
    bookmarks: zero(),
    highlights: zero(),
    replaceRules: zero(),
    highlightRules: zero(),
    dictRules: zero(),
    bookGroups: zero(),
    readRecords: zero(),
    bookMemos: zero(),
    searchHistory: zero(),
    prefs: { applied: false, fields: 0, policy: 'none' },
  };

  /* ---- 书架 ---- */
  {
    const cur = new Set((await store.listBooks()).map((b) => b.bookUrl));
    for (const raw of snap.books ?? []) {
      const b: ShelfBook = fill(emptyShelfBook(), raw);
      if (!b.bookUrl) {
        res.books.skipped++;
        continue;
      }
      if (!cur.has(b.bookUrl)) {
        await store.clearBookTombstone(b.bookUrl);
        await store.upsertBook(b);
        cur.add(b.bookUrl);
        res.books.added++;
      } else if (overwrite) {
        await store.clearBookTombstone(b.bookUrl);
        await store.upsertBook(b);
        res.books.updated++;
      } else {
        res.books.kept++;
      }
    }
  }

  /* ---- 目录（按书分组；主键 `(url, bookUrl)`）---- */
  for (const [bookUrl, list] of Object.entries(snap.chapters ?? {})) {
    if (!bookUrl || !Array.isArray(list)) continue;
    const exist = new Set((await store.listChapters(bookUrl)).map((c) => c.url));
    const write: ShelfChapter[] = [];
    list.forEach((raw, i) => {
      const ch: ShelfChapter = fill(emptyShelfChapter(bookUrl, i), raw);
      if (!ch.url) {
        res.chapters.skipped++;
        return;
      }
      if (exist.has(ch.url)) {
        if (overwrite) {
          write.push(ch);
          res.chapters.updated++;
        } else res.chapters.kept++;
      } else {
        write.push(ch);
        exist.add(ch.url);
        res.chapters.added++;
      }
    });
    if (write.length) await store.upsertChapters(write);
  }

  /* ---- 书签（主键 time）---- */
  {
    const cur = new Set((await store.listBookmarks()).map((b) => String(b.time)));
    for (const raw of snap.bookmarks ?? []) {
      const b: Bookmark = fill(emptyBookmark(), raw);
      if (!b.time) {
        res.bookmarks.skipped++;
        continue;
      }
      if (!cur.has(String(b.time))) {
        await store.upsertBookmark(b);
        cur.add(String(b.time));
        res.bookmarks.added++;
      } else if (overwrite) {
        await store.upsertBookmark(b);
        res.bookmarks.updated++;
      } else res.bookmarks.kept++;
    }
  }

  /* ---- 划线高亮（主键 time）---- */
  {
    const cur = new Set((await store.listHighlights()).map((h) => String(h.time)));
    for (const raw of snap.highlights ?? []) {
      const h: BookHighlight = fill(emptyBookHighlight(), raw);
      if (!h.time) {
        res.highlights.skipped++;
        continue;
      }
      if (!cur.has(String(h.time))) {
        await store.upsertHighlight(h);
        cur.add(String(h.time));
        res.highlights.added++;
      } else if (overwrite) {
        await store.upsertHighlight(h);
        res.highlights.updated++;
      } else res.highlights.kept++;
    }
  }

  /* ---- 书内备注（主键 time）---- */
  {
    const cur = new Set((await store.listBookMemos()).map((m) => String(m.time)));
    for (const raw of snap.bookMemos ?? []) {
      const m: BookMemo = fill(emptyBookMemo(), raw);
      if (!m.time) {
        res.bookMemos.skipped++;
        continue;
      }
      if (!cur.has(String(m.time))) {
        await store.upsertBookMemo(m);
        cur.add(String(m.time));
        res.bookMemos.added++;
      } else if (overwrite) {
        await store.upsertBookMemo(m);
        res.bookMemos.updated++;
      } else res.bookMemos.kept++;
    }
  }

  /* ---- 搜索历史（主键 word）---- */
  {
    const cur = new Set((await store.listSearchHistory()).map((e) => e.word));
    for (const raw of snap.searchHistory ?? []) {
      const e: SearchHistoryEntry = fill(emptySearchHistoryEntry(), raw);
      if (!e.word) {
        res.searchHistory.skipped++;
        continue;
      }
      if (!cur.has(e.word)) {
        await store.upsertSearchHistory(e);
        cur.add(e.word);
        res.searchHistory.added++;
      } else if (overwrite) {
        await store.upsertSearchHistory(e);
        res.searchHistory.updated++;
      } else res.searchHistory.kept++;
    }
  }

  /* ---- 净化规则（主键 id）---- */
  {
    const cur = new Set((await store.listReplaceRules()).map((r) => String(r.id)));
    for (const raw of snap.replaceRules ?? []) {
      const r: ReplaceRule = fill(emptyReplaceRule(), raw);
      if (!r.id) {
        res.replaceRules.skipped++;
        continue;
      }
      if (!cur.has(String(r.id))) {
        await store.upsertReplaceRule(r);
        cur.add(String(r.id));
        res.replaceRules.added++;
      } else if (overwrite) {
        await store.upsertReplaceRule(r);
        res.replaceRules.updated++;
      } else res.replaceRules.kept++;
    }
  }

  /* ---- 字典规则（主键 name）---- */
  {
    const cur = new Set((await store.listDictRules()).map((d) => d.name));
    for (const raw of snap.dictRules ?? []) {
      const d: DictRule = fill(EMPTY_DICT, raw);
      if (!d.name) {
        res.dictRules.skipped++;
        continue;
      }
      if (!cur.has(d.name)) {
        await store.upsertDictRule(d);
        cur.add(d.name);
        res.dictRules.added++;
      } else if (overwrite) {
        await store.upsertDictRule(d);
        res.dictRules.updated++;
      } else res.dictRules.kept++;
    }
  }

  /* ---- 高亮规则（主键 uuid，`#262`）----
   * ⚠️ 与其它实体不同：uuid 命中（不分大小写）时**只有 overwrite 才覆盖**，
   * 且走 store 的 upsertHighlightRule（按 uuid 冲突更新、沿用本地 id）。 */
  {
    const cur = new Map((await store.listHighlightRules()).map((r) => [r.uuid.toLowerCase(), r]));
    for (const raw of snap.highlightRules ?? []) {
      const r = fill(emptyHighlightRule(), raw);
      if (!r.uuid || !r.pattern) {
        res.highlightRules.skipped++;
        continue;
      }
      const key = r.uuid.toLowerCase();
      const prev = cur.get(key);
      if (!prev) {
        await store.upsertHighlightRule(r);
        cur.set(key, r);
        res.highlightRules.added++;
      } else if (overwrite) {
        // 沿用本地 id（与上游 mergeImportedHighlightRules 一致）
        await store.upsertHighlightRule({ ...r, id: prev.id });
        res.highlightRules.updated++;
      } else res.highlightRules.kept++;
    }
  }

  /* ---- 分组（主键 groupId）---- */
  {
    const cur = new Set((await store.listBookGroups()).map((g) => String(g.groupId)));
    for (const raw of snap.bookGroups ?? []) {
      const g: BookGroup = fill(emptyBookGroup(), raw);
      if (!g.groupId) {
        res.bookGroups.skipped++;
        continue;
      }
      if (!cur.has(String(g.groupId))) {
        await store.upsertBookGroup(g);
        cur.add(String(g.groupId));
        res.bookGroups.added++;
      } else if (overwrite) {
        await store.upsertBookGroup(g);
        res.bookGroups.updated++;
      } else res.bookGroups.kept++;
    }
  }

  /* ---- 阅读时长（主键 deviceId+bookName）---- */
  {
    const cur = new Map((await store.listReadRecords()).map((r) => [`${r.deviceId}\u0000${r.bookName}`, r]));
    for (const raw of snap.readRecords ?? []) {
      const src = (raw ?? {}) as Record<string, unknown>;
      const key = `${strOf(src['deviceId'])}\u0000${strOf(src['bookName'])}`;
      if (!strOf(src['deviceId']) && !strOf(src['bookName'])) {
        res.readRecords.skipped++;
        continue;
      }
      const prev = cur.get(key);
      const r: ReadRecord = {
        deviceId: strOf(src['deviceId']),
        bookName: strOf(src['bookName']),
        author: strOf(src['author']),
        readTime: numOf(src['readTime'], 0),
        // 备份里没有 lastRead 时：沿用同一主键已有值，再退化到 now（不要写 0，否则会被判成「很旧」）
        lastRead: numOf(src['lastRead'], 0) || prev?.lastRead || Date.now(),
      };
      if (!prev) {
        await store.upsertReadRecord(r);
        cur.set(key, r);
        res.readRecords.added++;
      } else if (overwrite) {
        await store.upsertReadRecord(r);
        cur.set(key, r);
        res.readRecords.updated++;
      } else if (r.readTime > prev.readTime || (r.readTime === prev.readTime && r.lastRead > prev.lastRead)) {
        // 合并口径：取**时长更大**的一条（相等则更晚 lastRead）—— 两边都在读同一本书时不让备份倒退
        await store.upsertReadRecord(r);
        cur.set(key, r);
        res.readRecords.updated++;
      } else {
        res.readRecords.kept++;
      }
    }
  }

  /* ---- 全局偏好（单行）---- */
  if (snap.prefs && typeof snap.prefs === 'object') {
    const def = emptyGlobalReaderPrefs();
    const cur = await store.getReaderPrefs();
    const incoming: Record<string, unknown> = {};
    for (const k of Object.keys(def as unknown as Record<string, unknown>)) {
      const v = (snap.prefs as Record<string, unknown>)[k];
      if (v !== undefined && v !== null) incoming[k] = v;
    }
    if (overwrite) {
      await store.setReaderPrefs(incoming as Partial<GlobalReaderPrefs>);
      res.prefs = { applied: true, fields: Object.keys(incoming).length, policy: 'overwrite' };
    } else {
      // 合并口径：**只填「服务端仍是默认值」的字段** —— 用户在本机改过的设置不被备份覆盖，
      // 而换设备（服务端全是默认值）时备份里的设置能整片恢复。
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(incoming)) {
        const isDefault = JSON.stringify((cur as unknown as Record<string, unknown>)[k]) === JSON.stringify((def as unknown as Record<string, unknown>)[k]);
        if (isDefault) patch[k] = v;
      }
      if (Object.keys(patch).length) await store.setReaderPrefs(patch as Partial<GlobalReaderPrefs>);
      res.prefs = { applied: Object.keys(patch).length > 0, fields: Object.keys(patch).length, policy: 'fill-default' };
    }
  }

  return res;
}

/** 字典规则没有 `empty*` 工厂（`#189` 加的实体），这里给一份等价默认值 */
const EMPTY_DICT: DictRule = { name: '', urlRule: '', showRule: '', enabled: true, sortNumber: 0 };
