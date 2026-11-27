/**
 * `#208` **阅读进度的远端形态与合并规则**（纯函数）—— 对齐上游
 * `F:\legado\app\src\main\java\io\legado\app\data\entities\BookProgress.kt`（6 字段）
 * 与 `AppWebDav.kt:308-337`（`downloadAllBookProgress`）。
 *
 * ## 为什么单独一个文件
 * 进度是**跨端共享的数据**：本地在 SQLite（`ShelfBook` 的 `dur*` 字段），远端是 WebDAV 上的一个小 json。
 * 「哪边更新」这条判据一旦被写侧和读侧各写一遍就会漂移（本仓 `#247` 的教训）⇒ 抽成**一个纯函数**，
 * 上传与下载共用。
 *
 * ## 上游语义（逐条）
 * - `BookProgress` **恰 6 字段**：`name` / `author` / `durChapterIndex` / `durChapterPos` /
 *   `durChapterTime` / `durChapterTitle`（可空）。
 * - **只前进不后退**（`AppWebDav.kt:323`）：
 *   `remote.durChapterIndex > local.durChapterIndex || (相等 && remote.durChapterPos > local.durChapterPos)`。
 *   ⇒ 注意：**判据只看 (index, pos)**，`durChapterTime` 不参与（时间大不代表读得更远，
 *   比如本地先读了后面又翻回去）。
 */

import type { ShelfBook } from './contract/user-data';

/** 远端进度 json 的形状（上游 `BookProgress`，字段名一字不差） */
export interface BookProgress {
  name: string;
  author: string;
  /** 当前章节索引 */
  durChapterIndex: number;
  /** 章节内首行字符位置 */
  durChapterPos: number;
  /** 最近一次阅读时间（毫秒） */
  durChapterTime: number;
  /** 当前章节标题（上游可空） */
  durChapterTitle: string | null;
}

/** 能从 `ShelfBook` 直接投影出来的那部分 */
export type BookProgressSource = Pick<
  ShelfBook,
  'name' | 'author' | 'durChapterIndex' | 'durChapterPos' | 'durChapterTime' | 'durChapterTitle'
>;

/** 上游 `BookProgress(book)` */
export function bookProgressOf(book: BookProgressSource): BookProgress {
  return {
    name: book.name,
    author: book.author,
    durChapterIndex: book.durChapterIndex,
    durChapterPos: book.durChapterPos,
    durChapterTime: book.durChapterTime,
    durChapterTitle: book.durChapterTitle ?? null,
  };
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 解析远端 json（上游：`json.isJson()` → `GSON.fromJsonObject<BookProgress>().getOrNull()`）。
 *
 * ⚠️ **任何一处不对就返回 `null`，不做「尽力修复」** —— 一个写坏的进度文件若被半解读出来，
 * 会把用户的章节位置改到一个莫名其妙的地方（比不同步更糟）。调用方拿到 `null` 时
 * 应当**留痕**（`warnOnce`）并跳过这本书。
 */
export function parseBookProgress(text: string): BookProgress | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    return null;
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (typeof o['name'] !== 'string' || typeof o['author'] !== 'string') return null;
  if (!isFiniteInt(o['durChapterIndex']) || !isFiniteInt(o['durChapterPos'])) return null;
  if (!isFiniteInt(o['durChapterTime'])) return null;
  const title = o['durChapterTitle'];
  return {
    name: o['name'],
    author: o['author'],
    durChapterIndex: o['durChapterIndex'],
    durChapterPos: o['durChapterPos'],
    durChapterTime: o['durChapterTime'],
    durChapterTitle: typeof title === 'string' ? title : null,
  };
}

/** 上游 `AppWebDav.kt:323` 的判据：**远端是否比本地读得更远**（只前进不后退） */
export function isProgressAhead(remote: BookProgress, local: BookProgress): boolean {
  if (remote.durChapterIndex > local.durChapterIndex) return true;
  if (remote.durChapterIndex === local.durChapterIndex && remote.durChapterPos > local.durChapterPos) return true;
  return false;
}

/** 两者进度位置是否一致（`durChapterTime` 不算 —— 它变不代表读得更远） */
export function sameProgress(a: BookProgress, b: BookProgress): boolean {
  return (
    a.durChapterIndex === b.durChapterIndex &&
    a.durChapterPos === b.durChapterPos &&
    (a.durChapterTitle ?? null) === (b.durChapterTitle ?? null)
  );
}

export type MergeOutcome = {
  /** 合并后**应当生效**的进度（只前进不后退 ⇒ 要么 local 要么 remote） */
  progress: BookProgress;
  /** 是否采用了远端（true = 远端更远，本地要被改写） */
  adoptedRemote: boolean;
  /** 相对本地是否有变化（false ⇒ 不需要写库） */
  changed: boolean;
};

/**
 * 合并本地与远端进度。
 *
 * ★ 与上游的一处**有意差异**：上游 `uploadBookProgress` 是**无条件把本地写上去**
 * （`AppWebDav.kt:244-278`），如果远端更新就已经**把远端冲掉了**。本仓让上传前先合一次：
 * 远端更远 ⇒ 先采用远端、再把合并结果传回去 ⇒ 两端都满足「只前进不后退」。
 * 这是**同一次同步内**的判据，不是新增状态，不需要落库。
 */
export function mergeBookProgress(local: BookProgress, remote: BookProgress): MergeOutcome {
  if (isProgressAhead(remote, local)) {
    // 采用远端，但**保留本地的时间戳语义**：章节位置取远端，阅读时间取两者较新的
    const progress: BookProgress = {
      ...remote,
      durChapterTime: Math.max(remote.durChapterTime, local.durChapterTime),
    };
    return { progress, adoptedRemote: true, changed: true };
  }
  // 本地不落后 ⇒ **本地原样保留**（不需要写库）；远端会被随后那次上传带成与本地一致
  return { progress: { ...local }, adoptedRemote: false, changed: false };
}
