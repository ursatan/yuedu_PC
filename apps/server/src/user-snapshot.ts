/**
 * `#208` ④ / `#201` **用户数据快照的组装**（服务��侧唯一实现）。
 *
 * ## 为什么抽出来
 * 快照原本只在 `/api/user/snapshot` 端点里就地拼一次。`#208` ④ 的**整库备份**要把同一份快照
 * 打成 zip 传上网盘 —— 若两处各拼一遍，字段迟早漂移（本仓 `#247` 的教训：
 * 「同一判据被写侧和读侧各写一遍」必然不一致）⇒ 抽成一个函数，**导出与备份共用同一份**。
 *
 * ## 内容边界（与端点注释一致，别在别处另立口径）
 * 快照 = 书架 + 书签 + 高亮 + 净化/高亮规则 + 分组 + 阅读记录 + 阅读偏好；
 * **默认不含章节**（`includeChapters=1` 才带）—— 正文从来不在快照里，最深只到目录。
 */

import type { ShelfChapter, ShelfBook, UserDataStore } from '@yuedu/core';

/** 快照格式版本（破坏性变更时 +1；导入端据此决定兼容策略） */
export const SNAPSHOT_VERSION = 1;

export interface UserSnapshot {
  version: number;
  exportedAt: number;
  books: ShelfBook[];
  /** 仅 `includeChapters` 时出现：`bookUrl → 章节列表` */
  chapters?: Record<string, ShelfChapter[]>;
  bookmarks: unknown[];
  highlights: unknown[];
  replaceRules: unknown[];
  highlightRules: unknown[];
  /** `#621`：字典规则（`dict_rules` 表）。`importSnapshot` 早就支持这个字段，导出侧此前漏了 */
  dictRules: unknown[];
  bookGroups: unknown[];
  readRecords: unknown[];
  /** 书内备注（Legado `BookMemo`；表 `book_memos`） */
  bookMemos: unknown[];
  /** 搜索历史（Legado `SearchKeyword`；表 `search_history`） */
  searchHistory: unknown[];
  prefs: unknown;
}

export interface BuildSnapshotOptions {
  /** 是否带上目录（默认 false —— 带目录时体量可能几十 MB） */
  includeChapters?: boolean;
  /** 注入当前时间（测试可固定） */
  now?: number;
}

export async function buildSnapshot(store: UserDataStore, opts: BuildSnapshotOptions = {}): Promise<UserSnapshot> {
  const books = await store.listBooks();
  const out: UserSnapshot = {
    version: SNAPSHOT_VERSION,
    exportedAt: opts.now ?? Date.now(),
    books,
    bookmarks: await store.listBookmarks(),
    highlights: await store.listHighlights(),
    replaceRules: await store.listReplaceRules(),
    highlightRules: await store.listHighlightRules(),
    dictRules: await store.listDictRules(),
    bookGroups: await store.listBookGroups(),
    readRecords: await store.listReadRecords(),
    bookMemos: await store.listBookMemos(),
    searchHistory: await store.listSearchHistory(),
    prefs: await store.getReaderPrefs(),
  };
  if (opts.includeChapters) {
    const chapters: Record<string, ShelfChapter[]> = {};
    for (const b of books) chapters[b.bookUrl] = await store.listChapters(b.bookUrl);
    out.chapters = chapters;
  }
  return out;
}
