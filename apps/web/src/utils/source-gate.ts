/**
 * `#310` 源的「能不能用」判据 —— **唯一实现**（源管理页 / 发现页 / 聚合搜索 / 换源搜索共用）。
 *
 * ## 为什么必须收敛到一处
 * 「这个源该不该出现在某个列表里」这句话在四个页面各写过一遍，而且四处的判据**互相不一致**：
 *  · 源管理页看 `enabled`；· 发现页看 `enabled + exploreEnabled + hasExplore`；
 *  · 聚合搜索看 `enabled + searchEnabled`（**漏了 `hasSearch`**）；
 *  · 换源搜索又是 `enabled + searchEnabled` 的一份拷贝。
 * 于是同一个源在不同页面「时有时无」，而且**没有任何一处能解释为什么**。
 *
 * ## 两层必须分开（这是本仓反复踩的坑）
 *  · **能力门**（`hasSearch` / `hasExplore`）：源里**有没有这条规则** —— 服务端算好的**事实**。
 *    没有规则就是不能，给个开关也不会有结果。
 *  · **用户开关**（`searchEnabled` / `exploreEnabled`）：用户**要不要**用。
 * 「没有规则自动禁用」= 能力门关；「有规则可以自己禁用」= 用户开关关。两者正交。
 *
 * ## ⚠️ RSS 没有「发现」开关（用户 2026-10-07 需求 ①）
 * 上游 `RssSource`（`RssSource.kt:15-117`，45 个字段）**只有** `enabled` 与 `searchUrl`，
 * **没有** `enabledExplore`（`BookSource.kt:52` 才有 `enabledExplore`）。所以：
 *  · 源管理页不给 RSS 显示「发现」滑块；
 *  · **发现页也不能读 RSS 的 `exploreEnabled`** —— 否则一旦它被写成 `false`
 *    （历史数据、批量操作、旧版本），源就从发现页消失，而界面上**没有任何开关能把它恢复**
 *    （本仓 `#247` 踩过一模一样的坑：「用 `v-if` 藏元素前先问一句，出问题时它是不是唯一出路」）。
 */
import type { SrcState } from '../api';

/** 判据需要的字段子集（`SourceInfo` 天然满足；纯函数好测） */
export interface GateSource {
  kind: string;
  /**
   * ⚠️ `exploreEnabled` 是**可选**的：搜索侧调用方（`utils/search-scope.ts` 的 `ScopePoolSource`）
   * 只需要 `enabled`/`searchEnabled` 两个字段，硬要它带 `exploreEnabled` 会逼调用方
   * 把用不上的字段也塞进类型（本仓 `#263` 那类「为满足类型而造数据」的开端）。
   * 缺省按 `true` 处理（与 `source-overlay.ts` 落盘口径一致）。
   */
  state: Pick<SrcState, 'enabled' | 'searchEnabled'> & { exploreEnabled?: boolean };
  /** 服务端算好的能力事实：源里有搜索规则（`searchUrl` / `ruleSearch.searchUrl`） */
  hasSearch?: boolean;
  /** 服务端算好的能力事实：源里有发现规则（legado：`exploreUrl`；rss/cms：恒 true） */
  hasExplore?: boolean;
  /**
   * `#335` 服务端算好的能力事实：**网页型订阅源**（`singleUrl === true`）。
   * 判据唯一实现 = 服务端 `source-caps.ts` 的 `computeWebViewOnly`（与引擎 `singleUrlOnly` 同条）。
   */
  webViewOnly?: boolean;
}

/**
 * **能力门**：这个源能不能搜。
 * ⚠️ `hasSearch` 缺失（老 bundle / 草稿源）按「能搜」处理 —— 与 `#293` 同口径，
 *   否则一次前端优先发布就会让全部源的搜索入口一起消失。
 */
export function canSearch(s: Pick<GateSource, 'hasSearch'>): boolean {
  return s.hasSearch !== false;
}

/**
 * `#335` **是不是网页型订阅源**（点开就是一张网页，没有「分类 → 卡片」这一层）。
 *
 * 缺失（老 bundle / 非 rss 源）按 `false` 处理 ⇒ 走既有链路，不会让入口凭空消失
 * （与 `canSearch` 的「缺失按可用」同向的保守原则：宁可多走一步，不可少给入口）。
 */
export function isWebViewOnly(s: Pick<GateSource, 'webViewOnly'>): boolean {
  return s.webViewOnly === true;
}

/** **能力门**：这个源能不能发现 */
export function canExplore(s: Pick<GateSource, 'hasExplore'>): boolean {
  return s.hasExplore !== false;
}

/**
 * 这个源**有没有**「发现」用户开关。
 *
 * RSS 订阅源没有（上游无 `enabledExplore`；它的分类由 `sortUrl` 规则/脚本解析出来，
 * 是「必然有」而不是「用户可选」，见文件头注释）。
 */
export function hasExploreSwitch(kind: string): boolean {
  return kind !== 'rss';
}

/** 搜索**实际可用**：源已启用 + 用户没关 + 源里真有搜索规则 */
export function searchUsable(s: GateSource): boolean {
  return s.state.enabled && s.state.searchEnabled && canSearch(s);
}

/**
 * 发现**实际可用**：源已启用 + 能力具备 + （有开关时）用户没关。
 * 没有开关的 kind（rss）**跳过用户开关那一层**，理由见文件头。
 */
export function exploreUsable(s: GateSource): boolean {
  if (!s.state.enabled || !canExplore(s)) return false;
  return hasExploreSwitch(s.kind) ? s.state.exploreEnabled !== false : true;
}

/**
 * 「发现」滑块**能不能被用户点**（用户在源管理页改设置的入口）。
 *
 * 用户口径（2026-10-07 需求 ③）：「**禁用**，源不可用，发现、搜索都不可用，
 * **且不可更改设置**」⇒ 源整体禁用后，两个滑块都点不动（要先启用源）。
 */
export function exploreSwitchEnabled(s: GateSource): boolean {
  return s.state.enabled && canExplore(s) && hasExploreSwitch(s.kind);
}

/** 「搜索」滑块能不能被用户点 —— 与上面同构（无搜索规则的源滑块是灰色不可点） */
export function searchSwitchEnabled(s: GateSource): boolean {
  return s.state.enabled && canSearch(s);
}
