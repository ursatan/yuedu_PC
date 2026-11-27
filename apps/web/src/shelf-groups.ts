/**
 * 书架分组 —— **模型 + 语义 + 纯函数**（前端；存储暂时仍是 localStorage）。
 *
 * ## 为什么字段名与取值照抄契约，而不是自己设计一套
 * 服务端已经有 `BookGroup`（`packages/core/src/contract/user-data.ts:609`，表 `book_groups`，
 * **8 个字段**）与 `/api/user/groups` 三个端点。前端书架目前还是 localStorage
 * （Phase 1.4「前端 shelf/watchHistory 迁到 `/api/user/*`」尚未开工，见交接文档 §4.8c），
 * 所以这里用**同一套字段名、同一套取值**，把 localStorage 当临时存储 ——
 * 将来迁移只换存储层，UI 与排序语义一行都不用动。
 *
 * ## 三条必须照 Legado 的语义（照抄会分叉的地方）
 * ① **`group` 挂在书上，是位掩码**：Legado `Book.group: Long`（`Book.kt:78`），
 *    归属判据 `(book.group & groupId) > 0`（`BookshelfGroupItem.kt:63`）；
 *    加组 `group | groupId`、移组 `group - groupId where group & groupId > 0`
 *    （`BookDao.kt:363-367`）⇒ **groupId 必须是 2 的幂**，一本书可同时属于多个组。
 * ② **新 groupId 的分配**：Legado `BookGroupDao.getUnusedId()` —— 从 1 开始不断左移，
 *    取**第一个没被占用的位**。
 * ③ **「未分组」的判据**：不是「group == 0」，而是
 *    「**不属于任何一个用户分组**」—— Legado `flowNetNoGroup`：
 *    `(SELECT sum(groupId) FROM book_groups WHERE groupId > 0) & book.group = 0`
 *    （`BookDao.kt:77-81`）。因为用户删掉组时只 `group - groupId`，历史数据里可能有
 *    指向已不存在分组的位。
 *
 * ## ⚠️ 与 Legado 的一处**有意偏离**：分组上限
 * Legado 用 Kotlin `Long`（64 位），上限 **63** 个组（`BookGroupDao.canAddGroup`）。
 * JS 的 `Number` 只能**精确**表示到 `2^53`，而从 1 起按位分配用到第 52 个组时
 * 掩码就到了 `2^51`（求和仍精确）。所以这里把上限设为 **52**（见 {@link SHELF_GROUP_MAX}），
 * 并在 UI 上如实提示 —— 绝不悄悄用一个会失真的数字（`&` 运算符在 JS 里还是 32 位，
 * 所以本文件**一律不用位运算符**，改等价算术，见 {@link hasGroupBit}）。
 */

import type { BookGroup } from '@yuedu/core/contract';

/** 书架分组。字段与 `@yuedu/core` 的 `BookGroup` 同名同义（本仓 UI 只用前 5 个） */
export interface ShelfGroup {
  /** 分组 ID。**主键，必须是 2 的幂**（位掩码模型的硬要求） */
  groupId: number;
  /** 分组名 */
  groupName: string;
  /** 分组排序（小的在前）。Legado 新建时取 `maxOrder + 1`（排在最后） */
  order: number;
  /** 是否在书架的左侧分组列表里显示 */
  show: boolean;
  /** 组内书籍排序方式，见 {@link BOOK_SORT_OPTIONS}；`-1` = 跟随全局 */
  bookSort: number;
  // —— 契约里有、本仓 UI 暂不用的三个（`BookGroup.cover/enableRefresh/onlyUpdateRead`）——
  cover?: string | null;
  enableRefresh?: boolean;
  onlyUpdateRead?: boolean;
}

/**
 * `ShelfGroup` → 契约 `BookGroup`（`PUT /api/user/groups` 的请求体）。
 *
 * 逐条对照契约的 **8 个字段**（`packages/core/src/contract/user-data.ts:609-626`）：
 *
 * | 契约字段 | 本仓 | 处理 |
 * |---|---|---|
 * | `groupId` | 同名 | 原样（主键；路由缺它会 400 `GROUP_ID_REQUIRED`）|
 * | `groupName` | 同名 | 原样 |
 * | `cover` | 可选 | `?? null`（契约默认 null）|
 * | `order` | 同名 | 原样 |
 * | `enableRefresh` | 可选 | `?? true`（契约默认 **true**）|
 * | `show` | 同名 | 原样 |
 * | `bookSort` | 同名 | 原样（契约默认 **-1**）|
 * | `onlyUpdateRead` | 可选 | `?? false`（契约默认 false）|
 *
 * 服务端 `PUT /api/user/groups` 是**按 groupId upsert**（`index.ts:593-606` + `store.upsertBookGroup`），
 * 且会用 `emptyBookGroup(groupId)` 补默认值 —— 所以这里显式带上默认，避免「靠服务端兜」而分叉。
 */
export function shelfGroupToContract(g: ShelfGroup): BookGroup {
  return {
    groupId: g.groupId,
    groupName: g.groupName,
    cover: g.cover ?? null,
    order: g.order,
    enableRefresh: g.enableRefresh ?? true,
    show: g.show,
    bookSort: g.bookSort,
    onlyUpdateRead: g.onlyUpdateRead ?? false,
  };
}

/** 契约 `BookGroup` → `ShelfGroup`（服务端读回时用；8 → 5 个常用字段 + 3 个可选原样保留） */
export function contractToShelfGroup(b: BookGroup): ShelfGroup {
  return {
    groupId: b.groupId,
    groupName: b.groupName,
    order: b.order,
    show: b.show,
    bookSort: b.bookSort,
    cover: b.cover,
    enableRefresh: b.enableRefresh,
    onlyUpdateRead: b.onlyUpdateRead,
  };
}

/** 「全部」虚拟分组（Legado `BookGroup.IdAll` = -1） */
export const SHELF_ALL = -1;
/** 「未分组」虚拟分组（Legado `BookGroup.IdNetNone` = -4；本仓书架只有网络书，故用网络未分组） */
export const SHELF_UNGROUPED = -4;
/**
 * 分组数量上限。Legado 是 63（Kotlin Long）；JS `Number` 精确整数上限 `2^53`
 * ⇒ 第 52 个组的 id 是 `2^51`，掩码求和仍精确，故取 52。
 */
export const SHELF_GROUP_MAX = 52;

/** 分组内书籍排序方式（`bookSort`）。取值与 Legado **严格一致**，多出的 `6` 是本仓扩展 */
export interface BookSortOption {
  value: number;
  label: string;
  /** 悬停提示：写清 Legado 的原始语义与我们的近似口径 */
  hint: string;
}

/**
 * ⚠️ 数值**必须**保持与 Legado 一致（`bookSort` 是要存起来、将来要同步的字段）：
 * ```kotlin
 * when (bookSort) {                       // BooksFragment.kt:222-236
 *     1 -> sortedByDescending { it.latestChapterTime }
 *     2 -> sortedWith { o1, o2 -> o1.name.cnCompare(o2.name) }
 *     3 -> sortedBy { it.order }          // 手动排序（书架内拖拽）
 *     4 -> sortedByDescending { max(it.latestChapterTime, it.durChapterTime) }
 *     5 -> sortedWith { ...author.cnCompare... }
 *     else -> sortedByDescending { it.durChapterTime }
 * }
 * ```
 * `3`（手动排序）**本仓不提供**：书架没有拖拽排序，给了就是骗人；数据里若出现 `3`
 * 按「未知值」回落默认（见 {@link resolveBookSort}）。
 */
export const BOOK_SORT_OPTIONS: readonly BookSortOption[] = [
  { value: -1, label: '跟随全局', hint: 'Legado：bookSort<0 时用全局 bookshelfSort' },
  { value: 0, label: '最近阅读', hint: 'Legado：按 durChapterTime 倒序（读到哪里）' },
  { value: 1, label: '更新时间', hint: 'Legado：按 latestChapterTime 倒序（最近一次加载目录的时间）' },
  { value: 2, label: '书名', hint: 'Legado：按书名中文比较（cnCompare）' },
  { value: 4, label: '综合排序', hint: 'Legado issue #3192：max(更新时间, 最近阅读) 倒序' },
  { value: 5, label: '作者', hint: 'Legado：按作者中文比较（cnCompare）' },
  { value: 6, label: '进度', hint: '★ 本仓扩展（Legado 无此项）：进度大的在前，无进度排最后' },
];

/** 全局默认排序（`bookSort < 0` 时的回落值）。Legado 对应 `AppConfig.bookshelfSort` */
export const DEFAULT_BOOK_SORT = 0;

/** 把存储值解析成**可执行的**排序值：`-1`（跟随全局）/ `3`（手动，未支持）/ 未知值 → 默认 */
export function resolveBookSort(bookSort: number | undefined): number {
  if (bookSort === undefined || bookSort < 0) return DEFAULT_BOOK_SORT;
  if (bookSort === 3) return DEFAULT_BOOK_SORT;
  return BOOK_SORT_OPTIONS.some((o) => o.value === bookSort) ? bookSort : DEFAULT_BOOK_SORT;
}

export function bookSortLabel(bookSort: number | undefined): string {
  const v = bookSort === undefined ? -1 : bookSort;
  return BOOK_SORT_OPTIONS.find((o) => o.value === v)?.label ?? `未知(${v})`;
}

/* ------------------------------------------------------------------ *
 * 位掩码算术 —— **不用 `&`/`|`**（JS 的位运算符是 32 位有符号）
 * ------------------------------------------------------------------ */

/** `mask` 的第 `bit` 位是否为 1（`bit` 是 2 的幂）。等价 `(mask & bit) > 0`，但支持到 2^52 */
export function hasGroupBit(mask: number, bit: number): boolean {
  if (!(bit > 0) || !(mask > 0)) return false;
  return Math.floor(mask / bit) % 2 === 1;
}

/** 加组：等价 `mask | bit`（已置位则原样返回） */
export function addGroupBit(mask: number, bit: number): number {
  return hasGroupBit(mask, bit) ? mask : mask + bit;
}

/** 移组：等价 `mask - bit where mask & bit > 0`（未置位则原样返回） */
export function removeGroupBit(mask: number, bit: number): number {
  return hasGroupBit(mask, bit) ? mask - bit : mask;
}

/** 所有用户分组的 id 之和（= 并集掩码；groupId 两两不同且都是 2 的幂，故求和即按位或） */
export function userGroupMask(groups: readonly ShelfGroup[]): number {
  return groups.reduce((s, g) => s + g.groupId, 0);
}

/** 该书是否**不属于任何用户分组**（Legado `flowNetNoGroup` 的判据） */
export function isUngrouped(mask: number | undefined, groups: readonly ShelfGroup[]): boolean {
  return !hasAnyUserGroup(mask, groups);
}

function hasAnyUserGroup(mask: number | undefined, groups: readonly ShelfGroup[]): boolean {
  const m = mask ?? 0;
  if (!(m > 0)) return false;
  return groups.some((g) => hasGroupBit(m, g.groupId));
}

/** 该书是否属于分组 `groupId`（虚拟分组走 {@link isUngrouped}） */
export function isInGroup(mask: number | undefined, groupId: number): boolean {
  return groupId > 0 && hasGroupBit(mask ?? 0, groupId);
}

/**
 * 分配一个新的 groupId：从 1 开始左移，取**第一个未被占用的位**（照 Legado `getUnusedId`）。
 * 返回 `0` 表示已达上限（调用方给提示，不要静默截断）。
 */
export function nextGroupId(groups: readonly ShelfGroup[]): number {
  let id = 1;
  for (let i = 0; i < SHELF_GROUP_MAX; i++) {
    if (!groups.some((g) => g.groupId === id)) return id;
    id *= 2;
  }
  return 0;
}

/** 分组名去重（同名容易点错，新建时自动加序号） */
export function uniqueGroupName(name: string, groups: readonly ShelfGroup[]): string {
  const base = name.trim();
  if (!base) return base;
  let out = base;
  let n = 2;
  while (groups.some((g) => g.groupName === out)) {
    out = `${base}(${n++})`;
  }
  return out;
}

/** 可排序的书（结构类型：只要求这几个字段，避免把 store 的类型拖进来） */
export interface SortableBook {
  title: string;
  author?: string;
  /** ≈ Legado `durChapterTime`：最近一次阅读时间（我们存 `updatedAt`） */
  updatedAt?: number;
  /** ≈ Legado `latestChapterTime`：最近一次加载目录的时间（近似口径，见 reader store） */
  latestChapterTime?: number;
  /** 0~100 进度（本仓扩展的「进度」排序用） */
  progressPercent?: number;
}

/**
 * 按 `bookSort` 排序（返回新数组，**元素仍是原对象** —— 调用方靠引用做增删）。
 * 中文比较用 `localeCompare(…, 'zh')` 近似 Legado `cnCompare`。
 *
 * `progressOf` 用于「按进度」：进度不是书自带的字段（要按 kind 现算），
 * 所以用回调注入，**不要在调用处 `map` 出副本**（那会破坏引用相等的增删逻辑）。
 */
export function sortBooks<T extends SortableBook>(
  list: readonly T[],
  bookSort?: number,
  progressOf?: (b: T) => number,
): T[] {
  const out = list.slice();
  const by = resolveBookSort(bookSort);
  const progress = (b: T) => progressOf?.(b) ?? b.progressPercent ?? -1;
  const nameCmp = (a: string | undefined, b: string | undefined) =>
    (a ?? '').localeCompare(b ?? '', 'zh');
  switch (by) {
    case 1:
      out.sort((a, b) => (b.latestChapterTime ?? 0) - (a.latestChapterTime ?? 0));
      break;
    case 2:
      out.sort((a, b) => nameCmp(a.title, b.title));
      break;
    case 4:
      out.sort(
        (a, b) =>
          Math.max(b.latestChapterTime ?? 0, b.updatedAt ?? 0) -
          Math.max(a.latestChapterTime ?? 0, a.updatedAt ?? 0),
      );
      break;
    case 5:
      out.sort((a, b) => nameCmp(a.author, b.author));
      break;
    case 6:
      out.sort((a, b) => progress(b) - progress(a));
      break;
    default:
      out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }
  return out;
}
