/**
 * `#275` 跨源搜索 · 候选源筛选链 —— **纯函数层**（store 与视图共用，语义只写一遍）。
 *
 * ## 三级筛选（用户口径，2026-10-05）
 * 1. **引擎筛选**：`s.kind`（legado / maccms / demo…—— 源的 kind = 引擎名，`#274` 实测）
 * 2. **类型筛选**：`s.sourceType`（文本/音频/图片/文件/视频；缺省 = text，与服务端 `sourceTypeOf` 一致）
 * 3. **分组筛选**：`bookSourceGroup`（`,`/`，`/`&` 多组字符串；「未分组」哨兵见 `source-groups.ts`）
 *
 * ⚠️ **下拉计数的口径 = 「该筛选链下的候选源数」**（用户原话：「分组内命中源数目，
 * 不是分组内全部源数目」）—— 每一级的 options 都必须用**前几级已过滤的池子**算，
 * 否则又是本仓反复出现的「下拉里有这一项、选中却 0 条」。
 */
import { matchSourceGroup, sourceGroupOptions, type SourceGroupOption } from '../source-groups';
// `#310`「能不能搜」判据唯一实现（能力门 hasSearch + 用户开关 searchEnabled + 源 enabled）
import { searchUsable } from './source-gate';
// `B6` 质量分/`dead` 跳过口径（与服务端同一实现，避免两边漂移）
import {
  effectiveSourceQuality,
  isSourceHealthDeadActive,
  type SourceHealth,
} from '@yuedu/core/contract';

/** 搜索页候选池的最小源结构（`SourceInfo` 的子集，避免把 api 类型拖进来） */
export interface ScopePoolSource {
  id: string;
  kind: string;
  name?: string;
  sourceType?: string;
  group?: string;
  state: { enabled: boolean; searchEnabled: boolean };
  /**
   * `#310` **能力事实**：源里有没有搜索规则（服务端 `publicSource` 算好）。
   *
   * ⚠️ 此前这个接口**没有**这个字段，于是「候选池」只看了用户开关 ⇒
   * 没有搜索规则的源照样出现在聚合搜索/换源的源列表里，点下去永远搜不出东西。
   * 与 `#293` 在源管理页/发现页修的是同一类缺陷，只是那两处修了、这两处漏了。
   */
  hasSearch?: boolean;
  /** `B6` 体检结果（质量分参与候选池排序；`dead` 未过期的源不进候选池） */
  health?: SourceHealth;
}

/** 引擎显示名（与 `stores/sources.ts` 的 ENGINE_LABELS 同文案；demo 是内置演示源） */
export const ENGINE_LABELS: Record<string, string> = {
  legado: 'Legado 书源',
  maccms: 'CMS 影视',
  demo: '演示源',
};

/** 源类型文案（用户口径：文本 / 音频 / 图片 / 文件 / 视频） */
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  text: '文本',
  audio: '音频',
  image: '图片',
  file: '文件',
  video: '视频',
};

/** UnifiedItem kind → 中文标签（结果卡「书名后附加类型信息」用） */
export const ITEM_KIND_LABELS: Record<string, string> = {
  book: '书籍',
  video: '影视',
  audio: '音频',
  image: '漫画',
  article: '文章',
  file: '文件',
};

export function engineLabel(kind: string): string {
  return ENGINE_LABELS[kind] ?? kind;
}
export function typeLabel(t: string): string {
  return SOURCE_TYPE_LABELS[t] ?? t;
}
export function itemKindLabel(kind: string): string {
  return ITEM_KIND_LABELS[kind] ?? kind;
}

/**
 * 可搜索池：**能力门 + 用户开关**（搜索页 / 聚合搜索 / 换源搜索的唯一入口判据）。
 *
 * `#310`（用户 2026-10-07 需求 ②）：补上 `hasSearch` 能力门 ——
 * 「禁用搜索的源 / **没有搜索规则的源**，聚合搜索页源列表不应出现」。
 * 判据实现移交给 `source-gate.ts`，不再与源管理页/发现页各写一遍。
 */
export function searchableSources<T extends ScopePoolSource>(sources: readonly T[]): T[] {
  return sources
    .filter((s) => searchUsable(s))
    // `B6` `dead` 且未过 3 天跳过期的源不参与搜索/换源（服务端同样跳，前端这里保证列表不出现）
    .filter((s) => !isSourceHealthDeadActive(s.health))
    // `B6` **质量分参与排序**：高→低；同分按源名稳定排序（未体检源取中性分，不会被压到底）
    .sort(
      (a, z) =>
        effectiveSourceQuality(z.health) - effectiveSourceQuality(a.health) ||
        (a.name ?? a.id).localeCompare(z.name ?? z.id, 'zh'),
    );
}

export interface ScopeFilters {
  /** 'all' = 全部引擎 */
  engine: string;
  /** '' = 全部类型 */
  type: string;
  /** '' = 全部分组（可为「未分组」哨兵） */
  group: string;
}

/** 三级筛选链（engine → type → group）作用后的候选源 */
export function filterCandidates<T extends ScopePoolSource>(pool: readonly T[], f: ScopeFilters): T[] {
  let list: T[] = [...pool];
  if (f.engine !== 'all') list = list.filter((s) => s.kind === f.engine);
  if (f.type) list = list.filter((s) => (s.sourceType ?? 'text') === f.type);
  if (f.group) list = list.filter((s) => matchSourceGroup(s, f.group));
  return list;
}

/** 下拉里的一项：value + 文案 + 该筛选链下的候选源数 */
export interface ScopeOption {
  value: string;
  label: string;
  count: number;
}

/** 引擎下拉：全部（N）+ 各引擎（带候选数）；按候选数降序、同数按名序 */
export function engineOptionsOf(pool: readonly ScopePoolSource[]): ScopeOption[] {
  const m = new Map<string, number>();
  for (const s of pool) m.set(s.kind, (m.get(s.kind) ?? 0) + 1);
  const list = [...m.entries()]
    .map(([value, count]) => ({ value, label: engineLabel(value), count }))
    .sort((a, z) => z.count - a.count || a.value.localeCompare(z.value));
  // `#280`：文案修正 —— 这一行是「全部**引擎**」（原写成「全部类型」，复制粘贴残留）
  return [{ value: 'all', label: '全部引擎', count: pool.length }, ...list];
}

/** 类型下拉：必须传**引擎已过滤**的池子；只列该引擎下真实存在的类型（count>0） */
export function typeOptionsOf(pool: readonly ScopePoolSource[], engine: string): ScopeOption[] {
  const sub = engine === 'all' ? pool : pool.filter((s) => s.kind === engine);
  const m = new Map<string, number>();
  for (const s of sub) {
    const t = s.sourceType ?? 'text';
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  const list = [...m.entries()]
    .map(([value, count]) => ({ value, label: typeLabel(value), count }))
    .sort((a, z) => z.count - a.count || a.value.localeCompare(z.value));
  return [{ value: '', label: '全部类型', count: sub.length }, ...list];
}

/**
 * 分组下拉：必须传**引擎 + 类型已过滤**的池子 ⇒ 每组计数 = 「该类型下命中源数」
 * （不是组内全部源数）。无此类型源的分组自然不出现（池子里没有就不进 options）。
 */
export function groupOptionsOf(pool: readonly ScopePoolSource[], engine: string, type: string): SourceGroupOption[] {
  const sub = filterCandidates(pool, { engine, type, group: '' });
  return sourceGroupOptions(sub, { includeUngrouped: true });
}
