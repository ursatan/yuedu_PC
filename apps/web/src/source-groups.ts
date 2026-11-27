/**
 * 源分组（Legado `bookSourceGroup`）的**语义唯一实现**。
 *
 * ## 为什么要单独一个文件
 * 这份语义此前在**两个地方各写了一遍**（编码完全相同、注释各不相同 ⇒ 迟早分叉）：
 * · `stores/sources.ts` 的 `groupOptions` / `shownSources`（源管理页的 `<select>`）
 * · `views/DiscoverView.vue` 的 `groupsOf` / `groupOptions` / `filteredSources`（发现页左栏下拉）
 * 现在都从这里取。**新增第三个消费方（规则工坊）时不要再抄一遍。**
 *
 * ## 三条语义（照 Legado）
 * 1. **一个源可属多个分组**：字段是**字符串**，用 `,` / `，` / `&` 分隔（Legado 的 `bookSourceGroup`
 *    就是逗号分隔的字符串，不是数组）。
 * 2. **空组名要丢掉**：`"a,,b"` / `"a, "` 这类要跳过空串，否则下拉里会出现一个点不中的空项。
 * 3. **「未分组」是兜底桶，不是某个组名**：Legado 的书源管理里没有「未分组」这个选项
 *    （那是**书架**分组的概念），但发现页左栏需要它（否则没有分组的源无法被单独筛出来）。
 *    这里用 {@link SOURCE_GROUP_UNGROUPED} 哨兵值 —— **不能用 `''`**，因为 `''` 已经被
 *    「全部分组」占用了（见 `v-model` 语义：`''` = 不筛选）。
 */

/** 「未分组」哨兵。★ 刻意用不可打印字符：它不可能与真实分组名相同 */
export const SOURCE_GROUP_UNGROUPED = '\u0000__ungrouped__';

/** 源的最小结构（只要能取到分组字段即可 —— 避免把 store 的类型拖进来） */
export interface GroupableSource {
  group?: string;
}

/**
 * 取一个源的所有分组。`s.group` 是 `,`/`，`/`&` 分隔的字符串，**归一化后去空**。
 * 返回顺序 = 书写顺序（调用方要排序自己排）。
 */
export function sourceGroupsOf(s: GroupableSource): string[] {
  return String(s.group ?? '')
    .split(/[,，&]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 下拉里的一项：`name` 是给 `v-model` 的值，`label` 是给人看的文案 */
export interface SourceGroupOption {
  /** 选中值（可能是 {@link SOURCE_GROUP_UNGROUPED}） */
  name: string;
  /** 展示文案（未分组会被译成「未分组」） */
  label: string;
  /** 该分组在 `pool` 里的源数 */
  count: number;
}

/** 分组名的展示文案（把哨兵译成人话） */
export function sourceGroupLabel(name: string): string {
  return name === SOURCE_GROUP_UNGROUPED ? '未分组' : name;
}

/**
 * 从一组源里算出**可选的分组**（含计数），按「源多的在前、同数按中文序」排。
 *
 * ⚠️ **`pool` 决定了计数的口径**，这一步是「下拉里列了这个分组、选中却是 0 条」的唯一防线：
 * 传进来的必须是**当前其它筛选已经作用过的池子**（例如发现页的「该 kind 的源」、
 * 源管理页的「当前分类的源」）。别传全量源，否则计数会与实际列表对不上。
 *
 * @param includeUngrouped 是否把「未分组」作为兜底桶放在**最后**（发现页要，源管理页不要）
 */
export function sourceGroupOptions(
  pool: readonly GroupableSource[],
  opts: { includeUngrouped?: boolean } = {},
): SourceGroupOption[] {
  const m = new Map<string, number>();
  let ungrouped = 0;
  for (const s of pool) {
    const gs = sourceGroupsOf(s);
    if (!gs.length) ungrouped += 1;
    for (const g of gs) m.set(g, (m.get(g) ?? 0) + 1);
  }
  const list = [...m.entries()]
    .map(([name, count]) => ({ name, label: name, count }))
    .sort((a, z) => z.count - a.count || a.name.localeCompare(z.name, 'zh'));
  // 「未分组」排最后：它是兜底桶，不该抢占头部（源多得多的真分组更该在前面）
  if (opts.includeUngrouped && ungrouped) {
    list.push({ name: SOURCE_GROUP_UNGROUPED, label: '未分组', count: ungrouped });
  }
  return list;
}

/**
 * 一个源是否命中分组筛选。`group` 为空 = **不筛选**（全部分组）⇒ 恒真。
 * 这是 `v-model` 语义的唯一判据，别在调用处再写一遍 `=== UNGROUPED` 的分支。
 */
export function matchSourceGroup(s: GroupableSource, group: string): boolean {
  if (!group) return true;
  const gs = sourceGroupsOf(s);
  if (group === SOURCE_GROUP_UNGROUPED) return gs.length === 0;
  return gs.includes(group);
}

/** 该分组是否还存在于 `options` 里（用于「切换分类后把已失效的分组清掉」） */
export function hasSourceGroup(options: readonly { name: string }[], group: string): boolean {
  return !group || options.some((o) => o.name === group);
}
