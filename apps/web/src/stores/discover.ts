import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { runAction } from '../api';
import { loadViewMode, saveViewMode, type DiscoverViewMode } from '../utils/discover-view-mode';
// `#310` 门控判据唯一实现（与源管理页/聚合搜索/换源搜索同一份）
import { exploreUsable } from '../utils/source-gate';
import { useSourcesStore } from './sources';

/** 单个发现页（按源类型分桶）的状态 */
interface DiscState {
  sourceId: string;
  loading: boolean;
  err: string;
  items: Array<Record<string, unknown>>;
  /**
   * `#404` **RSS 启动页**（webView 型源的 `startHtml`）—— 非 null 时右栏渲染它而**不是**卡片列表
   * （上游「启动页非空 ⇒ 替换列表页」）。`null` = 无启动页，走常规分类列表。
   * `#418` `variable` = 源变量快照（`source.getVariable()`），启动页垫片预置它（见 `loadStartPage`）。
   */
  startPage: { html: string; style?: string; js?: string; baseUrl: string; variable?: string } | null;
  filters: Array<{
    key: string;
    options: Array<{
      name: string;
      value?: string;
      /** 分组标题（Legado exploreKinds url 为空 / type:text）——不可点 */
      header?: boolean;
      kind?: string;
      /** Legado FlexChildStyle 子集（0.25 → 一行 4 个；1 → 整行标题） */
      layout?: { flexGrow?: number; flexBasisPercent?: number };
      // —— 以下三个与服务端 FilterOption（@yuedu/core contract）对齐 ——
      /** toggle / select 的候选值（Legado ExploreKind.chars）——点一次换下一个 */
      chars?: string[];
      /** 初始值（Legado ExploreKind.default）：UI 未选过时播种进 infoMap */
      default?: string;
      /** 按钮点击动作脚本（Legado ExploreKind.action，如 java.refreshExplore()） */
      action?: string;
    }>;
  }>;
  /**
   * 服务端提示语（如「该源发现页需要先在 App 登录」「分类为空」）。
   * 引擎在 home/category 响应里给 `hint`，UI 工具条展示；没有则为空串。
   */
  hint: string;
  active: { key: string; value?: string } | null;
  /** 最近一次成功加载时间（发现页工具条「同步于 hh:mm」） */
  loadedAt: number;
  /** 分页：当前页 / 是否还有更多 / 追加加载中 */
  page: number;
  hasMore: boolean;
  /**
   * `#306` **跨页通道**：引擎给出的下一页 URL（从页面里解析出的链接，与页码无关）。
   * 翻页时**原样回传**给引擎；换源/换分类/刷新时清空。没有（纯页码递增）则为空字符串。
   */
  nextUrl: string;
  loadingMore: boolean;
  /** 仅「右栏刷新内容」进行中（与 loading 分离，避免左栏「刷新分类」按钮串态） */
  refreshing: boolean;
  /** 交互输入态（Legado infoMap）：控件名 → 当前值；请求时以 filters.$input 回传 */
  inputs: Record<string, string>;
  /**
   * **`#241` 请求序号** —— 每次发起 `load` 自增，用来判断「回来的响应是不是已经过时了」。
   *
   * ## 为什么 AbortController 还要配一个序号
   * `abort()` 之后**旧请求仍有可能已经 resolve**（例如它刚好在 abort 生效前跑完了），
   * 而 JS 的 `await` 无论如何都会拿到那个值 ⇒ 光靠 abort 会出现
   * 「慢请求后到，把新分类的内容覆盖掉」这种**最难查**的竞态。
   * 序号是第二道闸：写 `b.items` 之前先核对 `seq === b.seq`，不是当前这次就直接丢弃。
   */
  seq: number;
  /** `#241` 当前在飞请求的中止器（换分类 / 换源 / 改值时先 abort 上一次） */
  ctrl: AbortController | null;
  /**
   * —— 左侧栏「查看态」（**必须按 kind 分桶**）——
   *
   * ⚠️ 2026-09-26 修（用户实测 ①「筛选框没有隔离」）：书院(`/discovery/books`) 与影院
   * (`/discovery/video`) 用的是**同一个路由组件 DiscoverView**，Vue Router 会**复用组件实例**
   * ⇒ 组件级 `ref('')` 在切换时不会重建，书源里输入的文字会原样出现在影院页。
   *
   * 放进按 kind 分桶的 state（而不是组件 ref、也不是「切 kind 时清空」）的原因：
   * 三者都应当**按发现页各自记住**，且**跨路由往返不丢**（与 `sourceId`/`active` 同一语义）。
   */
  /** 源列表筛选词 */
  srcQuery: string;
  /** 源分组筛选（'' = 全部分组） */
  srcGroup: string;
  /** 内容区视图：多列 / 列表 / 横屏 */
  viewMode: DiscoverViewMode;
}

/**
 * 内容区视图模式（用户 2026-10-01 定义）。
 * · `grid`多列网格，封面竖版（2:3 / 3:4）
 * · `list` 列表卡片，**列数自适应** 1/2/3（宽屏自动多列，避免右侧大片空白）
 * · `wide`  横屏卡片网格，封面横版
 *
 * ⚠️ 「瀑布流」**已按用户要求移除**（原来是个 `seg-disabled` 的占位按钮，从没实现过）。
 * 用户原话：「移除瀑布，保留多列」—— 留着假按钮只会让人以为有这功能。
 *
 * 持久化的读写与白名单校验全在 `utils/discover-view-mode.ts`（**决策只此一份**，
 * 且 `normalizeViewMode` 可单测 —— localStorage 是外部输入，不能靠类型断言蒙过去）。
 */
export type { DiscoverViewMode } from '../utils/discover-view-mode';

function blank(): DiscState {
  return { sourceId: '', loading: false, err: '', items: [], startPage: null, filters: [], hint: '', active: null, loadedAt: 0, page: 1, hasMore: false, nextUrl: '', loadingMore: false, refreshing: false, inputs: {}, seq: 0, ctrl: null, srcQuery: '', srcGroup: '', viewMode: loadViewMode() };
}

/** 发现页状态：home 拉首页 / category 按筛选组拉分类。按 kind 分桶互不干扰、跨路由保留。 */
/**
 * `#505` P0-3 **发现页结果缓存**（切回看过的源/分类不再全量重拉）。
 *
 * 用户口径：「发现页切源卡顿」的另一半是「慢」——`#497` 实证 272 次 stall 之外，切回看过的源
 * 每次都全量重拉（2~5s），体感与卡死接近。这里按（源, 动作, 筛选组）做 TTL 缓存：
 *  · 命中 ⇒ 直接把上次结果写回状态（<200ms，判据见 roadmap P0）；
 *  · `refreshContent`（右栏刷新按钮）**不读缓存**，天然绕过并更新缓存；
 *  · TTL 10 分钟（首页/分类的内容变动没那么快；换源/换分类不冲突，因为是不同 key）。
 *
 * ⚠️ 只在 `load()`（切源 / ensureLoaded / 改筛选）生效；`loadMore` 翻页不缓存（用户已经在往下读）。
 */
type DiscoverCacheEntry = {
  at: number;
  items: DiscState['items'];
  filters: DiscState['filters'];
  hint: string;
  page: number;
  hasMore: boolean;
  nextUrl: string;
  startPage: DiscState['startPage'];
};
const DISCOVER_CACHE = new Map<string, DiscoverCacheEntry>();
const DISCOVER_TTL_MS = 10 * 60_000;
const DISCOVER_CACHE_MAX = 80;
function discoverCacheKey(sourceId: string, act: string, f: Record<string, string> | undefined): string {
  // key 必须含筛选组：切分类 / 改 $input / 控件 $action 都是不同结果集
  return [sourceId, act, JSON.stringify(f ?? {})].join('|');
}
function discoverCacheGet(key: string): DiscoverCacheEntry | null {
  const hit = DISCOVER_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > DISCOVER_TTL_MS) {
    DISCOVER_CACHE.delete(key);
    return null;
  }
  return hit;
}
function discoverCachePut(key: string, entry: DiscoverCacheEntry): void {
  // 简单 LRU：超上限删最早的（Map 保持插入序；命中不重排——够用）
  if (DISCOVER_CACHE.size >= DISCOVER_CACHE_MAX) {
    const oldest = DISCOVER_CACHE.keys().next().value;
    if (oldest !== undefined) DISCOVER_CACHE.delete(oldest);
  }
  DISCOVER_CACHE.set(key, entry);
}
/**
 * `#533` **作废某个源的全部发现页快照**。
 *
 * 用户实测：在规则工坊给源加了 `blacklist`（分类黑名单 blackId）并保存，回到影院发现页点
 * 「↻ 刷新分类」——分类**毫无变化**，只是跳转选中第一个分类；**刷新整页**才生效。
 *
 * 根因不在服务端（整页刷新能生效 ⇒ 服务端已拿到新定义），而在本缓存的 key **不含源定义版本**：
 * `刷新分类` 走的 `onSourceChange → load('home')` 与本页首次进入是同一条 key
 * （`<源>|home|{}`）⇒ 命中 10 分钟 TTL 内的旧快照（含**改 blackId 之前**的 filters）
 * ⇒ 直接回放，连一个请求都没发。整页刷新会清空这个模块级 Map，所以才"好了"。
 */
function discoverCacheClearSource(sourceId: string): void {
  const prefix = sourceId + '|';
  for (const k of [...DISCOVER_CACHE.keys()]) {
    if (k.startsWith(prefix)) DISCOVER_CACHE.delete(k);
  }
}
/** 缓存命中的写回（`active` 保持调用方现值——key 已含筛选组） */
function applyCachedDiscover(b: DiscState, hit: DiscoverCacheEntry): void {
  b.items = hit.items.map((it) => ({ ...it }));
  b.filters = hit.filters;
  b.hint = hit.hint;
  b.page = hit.page;
  b.hasMore = hit.hasMore;
  b.nextUrl = hit.nextUrl;
  b.startPage = hit.startPage;
  b.loadedAt = hit.at;
  b.err = '';
  b.loading = false;
}

export const useDiscoverStore = defineStore('discover', () => {
  const buckets = ref<Record<string, DiscState>>({});

  function bucket(kind: string): DiscState {
    if (!buckets.value[kind]) buckets.value[kind] = blank();
    return buckets.value[kind]!;
  }

  /**
   * 切内容区视图并**落盘**（用户 2026-10-01：「按钮组，持久化（记忆布局）」）。
   *
   * ## 为什么落 localStorage 而不是服务端
   * 契约里**没有对应实体**（与 `navMode` / 字典规则 / 音量倍速同类）⇒ 硬塞进 24 个 user 端点
   * 等于造第二份真相源。而它纯粹是「这台机器上我习惯怎么看列表」，跟账号无关。
   *
   * ## 为什么写这里而不是组件里 watch
   * `bucket()` 在**首次进入某个发现页**时才建桶，而 `viewMode` 是**全局一份**的偏好
   * ⇒ 读时用 `loadViewMode()`播种即可（见 `blank()`）；写时必须集中在一处，
   * 免得某个组件改完忘了落盘（那正是「刷新页面布局又回去了」的成因）。
   */
  function setViewMode(kind: string, mode: DiscoverViewMode) {
    const b = bucket(kind);
    if (b.viewMode === mode) return;
    b.viewMode = mode;
    // 落盘失败（隐私模式/配额满）时**内存里仍生效**，只是不跨会话。
    // ⚠️ 不抛：布局切换是次要功能，为它打断交互反而更糟（这段语义在 saveViewMode 的注释里）。
    saveViewMode(mode);
  }

  async function load(
    kind: string,
    action?: string,
    /**
     * `refreshCats`（`#655`）：**连引擎的分类缓存一起重探**。
     *
     * `force` 只清前端的 `#505` 快照；引擎里还有一层「分类 KV 缓存」（`cms:cats:<源>`，7 天 TTL），
     * 那层不过期就不打站点 ⇒ 用户点了「刷新分类」，站点新增/改名的分类照样看不见。
     * 只有「刷新分类 / 重算分类」这两个**显式**入口需要它；切源、首次进入都不传（要快）。
     */
    opts: { autoPickFirst?: boolean; force?: boolean; refreshCats?: boolean } = {},
  ) {
    const b = bucket(kind);
    if (!b.sourceId) return;
    /**
     * `#241` **中断上一次，立刻发这一次**（2026-10-03 用户实测后定的交互）。
     *
     * ## 之前错在哪（这是本仓第二次在同一处翻车，故完整记录）
     * ① 最早是 `if (b.loading) return;` —— 飞行中改值被**静默吞掉**，
     *    `exploreUrl` 没重跑 ⇒ 「子分类有时展开、有时不展开」（2026-09-23 修过一次）。
     * ② 于是改成**排队**：记下最后一次参数，等当前这次跑完再补跑。
     *    「不丢弃」是对的，但**等待**的体感是坏的：🏷七猫[官方]v3.1 的 exploreUrl
     *    有 41 个 URL 项还要跑游客登录，单次 home 要 2~5s ⇒ 用户点了新分类 / 新源，
     *    界面**干等上一个跑完**才动（用户原话：「感觉点置顶，过了一小会儿才动起来」同类体验）。
     *
     * ## 现在的做法：abort + 序号
     * · `b.ctrl?.abort()` —— 浏览器**立刻丢掉**旧响应，新请求马上发出；
     * · `b.seq` 自增，写 `b.items` 前核对 —— 防「旧请求恰好在 abort 生效前跑完」造成的覆盖。
     *
     * 对齐 Legado：`ExploreAdapter.Type.select.onItemSelected` 写完 infoMap 后
     * **必定执行 `kind.action`**（内部 `java.refreshExplore()` → `clearExploreKindsCache()`
     * + 重跑 `exploreKinds()`），没有任何「等上一次」的路径 —— 上游就是**直接重来**。
     *
     * ⚠️ **不省源站带宽**：abort 只断掉浏览器这一侧的等待与响应体传输，
     *   服务端已经发出去的 HTTP 请求仍会跑完。省的是「用户的等待」和一份响应体，
     *   不是源站侧的流量（真要限流得在服务端做，见 `guard` 与批量基线的网络护栏）。
     */
    b.ctrl?.abort();
    const ctrl = new AbortController();
    b.ctrl = ctrl;
    const seq = ++b.seq;
    b.loading = true;
    /**
     * `#534` **本次 load 作废在途的右栏刷新** ⇒ 顺手把 `refreshing` 复位。
     *
     * 为什么必须在这里复位：`refreshContent` 的 finally 只在 `seq === b.seq` 时清 `refreshing`
     * （否则旧响应会把新请求的转圈取消掉）。而 `load` 一旦自增 `seq`，那次刷新的 finally
     * **永远不满足条件** ⇒ `refreshing` 卡在 true ⇒ 刷新按钮被 `:disabled` 永久禁用
     * （用户症状：「刷新按钮一直处于『刷新中』」）。刷新态只可能由「当次」负责，作废它的 load 负责复位。
     */
    b.refreshing = false;
    b.err = '';
    let autoPicked = false;
    try {
      const act = b.active ? 'category' : 'home';
      const f = buildFilters(b, action);
      // `#505` 命中缓存 ⇒ 直接恢复快照（<200ms），不发请求；finally 会把 loading 复位
      const ck = discoverCacheKey(b.sourceId, act, f);
      /**
       * `#533` **显式刷新（刷新分类 / 重算分类）必须真拉**。
       *
       * 这两个入口要的正是「源侧定义可能变了（用户在规则工坊改了 blackId 等）⇒ 重跑 exploreUrl」，
       * 而命中 `#505` 缓存会直接回放**改动之前**的 filters ⇒ 分类纹丝不动。
       * 非显式路径（首次进入 / 切源）仍吃缓存（那正是 `#505` 要的提速）。
       * 注意要**先删**再读：只跳过读取的话，这条旧快照会一直躺在 Map 里（TTL 内还会被别的路径命中）。
       */
      if (opts.force) discoverCacheClearSource(b.sourceId);
      const cached = opts.force ? null : discoverCacheGet(ck);
      if (cached) {
        applyCachedDiscover(b, cached);
        if (opts.autoPickFirst && act === 'home' && !b.active && cached.filters.length) {
          const g = cached.filters[0];
          const first = g?.options.find((o) => o.value && !o.header && (!o.kind || o.kind === 'url'));
          if (g && first?.value) {
            b.active = { key: g.key, value: first.value };
            await load(kind);
          }
        }
        return;
      }
      const r = (await runAction(b.sourceId, act, {
        filters: f,
        signal: ctrl.signal,
        // `#655` 显式刷新分类 ⇒ 让引擎跳过分类 KV 缓存重新探（切源/首进不传，保持秒开）
        ...(opts.refreshCats && act === 'home' ? { extra: { refreshCategories: true } } : {}),
      })) as {
        items?: Array<Record<string, unknown>>;
        filters?: DiscState['filters'];
        hint?: string;
      };
      // 过时响应：一律不写状态（abort 没赶上它已经回来了的情况）
      if (seq !== b.seq) return;
      // ★ `#306`：**分页状态先写、items 后写** —— 改 items 会立刻触发视图的「首屏铺满」
      //   续载（`fillViewport` ⇒ `loadMore`），晚一步写 `nextUrl` 就会让翻页请求丢掉跨页通道
      //   （引擎退回 page+1 重放 ⇒ 拿回重复的第一页 ⇒ 被判「没有新增」⇒ 永远翻不动）。
      const pg = (r as { page?: { page?: number; hasMore?: boolean; nextUrl?: string } }).page;
      b.page = pg?.page ?? 1;
      b.hasMore = !!pg?.hasMore;
      b.nextUrl = pg?.nextUrl ?? '';
      b.items = (r.items ?? []).map((it) => ({ ...it, sourceId: b.sourceId }));
      b.hint = r.hint ?? '';
      // 分类本地化：category 动作响应不返回 filters，保留已有分类（点「刷新分类」才重新拉取）
      if (r.filters?.length) b.filters = r.filters;
      // 服务端播种的交互初值（Legado default）回填本地，控件才能显示当前选择
      if (r.filters?.length) {
        for (const g of r.filters) {
          for (const o of g.options) {
            if (o.kind && o.kind !== 'url' && o.default && b.inputs[o.name] === undefined) b.inputs[o.name] = o.default;
          }
        }
        // ★ 选源后默认选中并加载第一个有效分类（用户要求：不要停在「未选分类」空内容）
        //   只对「源级重置」触发（ensureLoaded / 换源）；交互控件改值不触发，避免打断用户浏览
        if (opts.autoPickFirst && act === 'home' && !b.active) {
          const g = r.filters[0];
          const first = g?.options.find((o) => o.value && !o.header && (!o.kind || o.kind === 'url'));
          if (g && first?.value) {
            b.active = { key: g.key, value: first.value };
            autoPicked = true;
          }
        }
      }
      b.loadedAt = Date.now();
      // `#505` 写缓存（只缓存首屏；loadMore 翻页不进缓存）
      discoverCachePut(ck, {
        at: b.loadedAt,
        items: b.items.map((it) => ({ ...it })),
        filters: b.filters,
        hint: b.hint,
        page: b.page,
        hasMore: b.hasMore,
        nextUrl: b.nextUrl,
        startPage: b.startPage,
      });
      // （分页状态已在 items 之前写入，见上方注释）
    } catch (e) {
      // 被中断的请求不算错误（用户主动改了分类/源，旧响应没价值）
      if (ctrl.signal.aborted || seq !== b.seq) return;
      b.err = String(e instanceof Error ? e.message : e);
    } finally {
      // 只有「当前这次」能改 loading，否则旧请求的 finally 会把新请求的转圈取消掉
      if (seq === b.seq) {
        b.loading = false;
        b.ctrl = null;
      }
    }
    if (autoPicked) await load(kind); // 选中后立即拉该分类内容卡片
  }

  /** 请求 filters：探索 URL（选中分类）+ 交互输入态（$input）+ 控件动作脚本（$action） */
  function buildFilters(b: DiscState, action?: string): Record<string, string> | undefined {
    const f: Record<string, string> = {};
    if (b.active) f[b.active.key] = b.active.value ?? '';
    if (Object.keys(b.inputs).length) f['$input'] = JSON.stringify(b.inputs);
    if (action) f['$action'] = action;
    return Object.keys(f).length ? f : undefined;
  }

  /**
   * 设置交互输入态（select/toggle/text）→ 重算分类。
   * 对齐 Legado：改值后 ① 写 infoMap ② 执行控件 `action`（可能继续写 infoMap）③ 重跑 exploreUrl 脚本。
   * 因为分组变化会让**分类列表整体改变**，已选中的分类必须清掉（否则会拿旧 URL 去请求，表现为「点了没反应」）。
   */
  function setInput(kind: string, name: string, value: string, action?: string) {
    const b = bucket(kind);
    if (b.inputs[name] === value && !action) return;
    b.inputs = { ...b.inputs, [name]: value };
    b.active = null;
    b.items = [];
    void load(kind, action);
  }

  /**
   * 右栏「刷新」：只重拉当前分类（或首页）内容卡片，分类栏保持本地不动。
   *
   * `#241`：它同样走 `b.ctrl` —— 刷新途中用户改了分类，那次刷新的结果必须作废
   * （否则会把上一个分类的内容盖回来）。序号也共用 `b.seq`，语义与 `load` 一致。
   */
  async function refreshContent(kind: string) {
    const b = bucket(kind);
    if (!b.sourceId || b.loading || b.refreshing) return;
    b.ctrl?.abort();
    const ctrl = new AbortController();
    b.ctrl = ctrl;
    const seq = ++b.seq;
    b.refreshing = true; // 只驱动右栏刷新按钮；左栏「刷新分类」看 b.loading
    b.err = '';
    try {
      const act = b.active ? 'category' : 'home';
      const f = buildFilters(b);
      const r = (await runAction(b.sourceId, act, { filters: f, signal: ctrl.signal })) as {
        items?: Array<Record<string, unknown>>;
        page?: { page?: number; hasMore?: boolean; nextUrl?: string };
      };
      if (seq !== b.seq) return;
      // ★ `#306` 竞态：**分页状态必须先于 items 写入**。
      // 旧写法先赋 `b.items` ⇒ 视图 watcher（`fillViewport`「首屏铺满」）**立刻**触发翻页，
      // 而那一刻 `b.nextUrl` 还没写 ⇒ 翻页请求不带 nextUrl ⇒ 引擎按 page+1 重放 ⇒
      // 拿回重复的第一页 ⇒ 被去重判为「没有新增」⇒ `hasMore` 直接被置 false（永远翻不动）。
      b.page = r.page?.page ?? 1;
      b.hasMore = !!r.page?.hasMore;
      // `#306`：换源/刷新 ⇒ 重新从第一页开始，清掉上一轮的下一页链接
      b.nextUrl = r.page?.nextUrl ?? '';
      b.items = (r.items ?? []).map((it) => ({ ...it, sourceId: b.sourceId }));
      b.loadedAt = Date.now();
      // `#505` 刷新成功后同步更新缓存（否则切回来又看到旧数据）
      discoverCachePut(discoverCacheKey(b.sourceId, act, b.active ? buildFilters(b) : undefined), {
        at: b.loadedAt,
        items: b.items.map((it) => ({ ...it })),
        filters: b.filters,
        hint: b.hint,
        page: b.page,
        hasMore: b.hasMore,
        nextUrl: b.nextUrl,
        startPage: b.startPage,
      });
      // filters 刻意不更新——分类只在「刷新分类」时重建
    } catch (e) {
      if (ctrl.signal.aborted || seq !== b.seq) return;
      b.err = String(e instanceof Error ? e.message : e);
    } finally {
      if (seq === b.seq) {
        b.refreshing = false;
        b.ctrl = null;
      }
    }
  }

  /**
   * 滚动到底追加下一页（仅在有激活分类时；home 无分页）。
   *
   * `#241`：翻页**不参与** abort —— 它是「同一视图的延续」，中途换分类时
   * 由那次 `load` 把 `b.items` 整体换掉；这里用序号挡住「翻页结果晚到、拼到新分类上」。
   * 序号必须共用 `b.seq`：换了分类后这次翻页就是过时的。
   */
  async function loadMore(kind: string) {
    const b = bucket(kind);
    if (!b.sourceId || b.loading || b.loadingMore || !b.hasMore) return;
    const seq = b.seq; // 不自增：只「读」当前这一版的身份
    b.loadingMore = true;
    b.err = '';
    try {
      const nextPage = b.page + 1;
      // 无激活分类时按首页翻页（maccms home 也有分页语义）
      const act = b.active ? 'category' : 'home';
      const filters = buildFilters(b);
      // `#306`：引擎给了下一页 URL（与页码无关的那类源）⇒ **原样回传**，别去重放模板
      const r = (await runAction(b.sourceId, act, {
        page: nextPage,
        ...(filters ? { filters } : {}),
        ...(b.nextUrl ? { nextUrl: b.nextUrl } : {}),
      })) as {
        items?: Array<Record<string, unknown>>;
        page?: { page?: number; hasMore?: boolean; nextUrl?: string };
      };
      if (seq !== b.seq) return; // 期间换了分类/源 ⇒ 这一页属于旧视图，丢弃
      const fresh = (r.items ?? []).filter((n) => !b.items.some((o) => JSON.stringify(o.payload) === JSON.stringify(n.payload)));
      // ★ 同 `#306` 竞态：分页状态**先写**，最后才改 items（改 items 会立刻触发视图的续载）
      b.page = r.page?.page ?? nextPage;
      b.hasMore = !!r.page?.hasMore;
      b.nextUrl = r.page?.nextUrl ?? '';
      // 护栏：源对翻页参数无响应（返回重复内容）时视为没有下一页，避免无限追加
      if (!fresh.length) b.hasMore = false;
      b.items = [...b.items, ...fresh.map((it) => ({ ...it, sourceId: b.sourceId }))];
      // 护栏：源对翻页参数无响应（返回重复内容）时视为没有下一页，避免无限追加
      if (!fresh.length) b.hasMore = false;
    } catch (e) {
      if (seq !== b.seq) return;
      b.err = String(e instanceof Error ? e.message : e);
    } finally {
      b.loadingMore = false;
    }
  }

  function selectExplore(kind: string, key: string, value?: string) {
    const b = bucket(kind);
    b.active = { key, value };
    void load(kind);
  }

  /**
   * 换源（点左栏另一个源 / 点「刷新分类」）。
   *
   * `#241`：旧源那次请求**直接作废**（`load` 里 abort + 序号），不等它跑完 ——
   * 用户问的正是这个：「点另一个源，是中断原来那个，还是等它加载完？」
   * 答：**中断**。理由与 Legado 一致（见 `load()` 的注释）—— 上游换源就是重置后重跑，
   * 没有「排队等前一个」这条路径；等只会在慢源上白等好几秒。
   */
  function onSourceChange(kind: string, opts: { refreshCats?: boolean } = {}) {
    const b = bucket(kind);
    b.active = null;
    b.filters = [];
    b.items = [];
    b.startPage = null; // `#404` 切源先清启动页（有启动页的源由 pickSource 分支重设）
    b.err = '';
    b.inputs = {}; // 切源/刷新分类：交互输入态重置（Legado 按源独立存 infoMap）
    // `#533`：同一个函数还兼任「↻ 刷新分类」按钮 ⇒ 必须 force（否则命中 `#505` 快照，
    // 源侧刚改的 blackId / exploreUrl 不生效）。切源时 force 也无害：新源本就没有缓存。
    void load(kind, undefined, { autoPickFirst: true, force: true, ...(opts.refreshCats ? { refreshCats: true } : {}) });
  }

  /**
   * `#404` 取 RSS 启动页（`startHtml`）并写入本桶状态。
   *
   * 上游「`startHtml` 求值非空 ⇒ 直接进 WebView、**替换**分类列表页」（`RssFragment.openRss:198-211`）。
   * 本仓映射：调 `/api/run action=start`，非空 HTML ⇒ `b.startPage` 置位（右栏渲染它、不拉分类）；
   * 空 / 失败 ⇒ `startPage=null`（**回落常规分类列表**，零回归）。
   * ⚠️ 与 `resetToWebOnlyCard` 同款：必须 `++seq` 作废在途 load，否则旧响应会把卡片盖回来。
   * @returns 是否真的展示了启动页
   */
  async function loadStartPage(kind: string, sourceId: string, baseUrl: string): Promise<boolean> {
    const b = bucket(kind);
    type StartResp = { html?: unknown; style?: unknown; js?: unknown; variable?: unknown };
    let r: StartResp | null = null;
    try {
      r = (await runAction(sourceId, 'start', {})) as StartResp;
    } catch {
      // 启动页是可选增强：失败按「无启动页」处理（引擎侧已 warnOnce 留痕），不打断发现页
      r = null;
    }
    if (!r || typeof r.html !== 'string' || !r.html.trim()) {
      b.startPage = null;
      return false;
    }
    const html = r.html;
    const style = typeof r.style === 'string' && r.style ? r.style : '';
    const js = typeof r.js === 'string' && r.js ? r.js : '';
    // `#418` 源变量快照：启动页垫片要用它预置 `source.getVariable()`（沙箱页读不到引擎的 ctx）
    const variable = typeof r.variable === 'string' ? r.variable : '';
    b.ctrl?.abort();
    b.ctrl = null;
    b.seq++; // 作废在途 load/refreshContent（同 resetToWebOnlyCard）
    b.active = null;
    b.filters = [];
    b.items = [];
    b.err = '';
    b.hint = '';
    b.inputs = {};
    b.loading = false;
    b.refreshing = false;
    b.loadingMore = false;
    b.hasMore = false;
    b.nextUrl = '';
    b.page = 1;
    b.loadedAt = Date.now();
    b.startPage = { html, ...(style ? { style } : {}), ...(js ? { js } : {}), baseUrl, variable };
    return true;
  }

  /**
   * `#404` 启动页里的 `java.open('sort', <分类 obj>)` —— 离开启动页、按**启动页给定的分类**
   * 进入列表（上游 `RssFragment` 启动页点分类 ⇒ `RssSortActivity` 带该分类集）。
   *
   * `obj` 形如 `{ 分类名: urlOrJournal }`（18AV 的值是 `data:;base64,…` 或普通 URL）。
   * 解析失败 / 空对象 ⇒ 回落常规 `onSourceChange`（不静默卡在启动页）。
   */
  function openSortCategories(kind: string, obj: Record<string, string>) {
    const entries = Object.entries(obj ?? {}).filter(([k]) => k) as Array<[string, string]>;
    if (!entries.length) {
      onSourceChange(kind);
      return;
    }
    const b = bucket(kind);
    b.startPage = null; // 离开启动页
    b.filters = [{ key: 'explore', options: entries.map(([name, value]) => ({ name, value: String(value ?? '') })) }];
    b.active = null;
    b.items = [];
    // 选中第一个分类（对齐上游：拿到分类集即展示首个）
    selectExplore(kind, 'explore', entries[0]![1]);
  }

  /**
   * `#371` 网页型订阅源（`singleUrl === true`，判据唯一实现 `utils/source-gate.isWebViewOnly`）
   * 的右侧区域状态：**重置**分类条/卡片区，只放**一张**「打开网页」卡片。
   *
   * 用户原话（2026-10-09）：「点击 XH发布页/阅读·全版本汇总/源仓库(官方纯净) 这一类源时，
   * 右侧分类条、内容卡片区域没有重置空，还保留显示其他源的分类/内容卡片；修正：右侧生成
   * 1 个内容卡片（跟之前一样），点击打开阅读页」。
   *
   * ## 与 `onSourceChange` 的两点不同
   * · **不 load**：网页型源没有 `exploreUrl` 链，`load` 会撞 `UNSUPPORTED`（`#335` 的老结论）；
   * · **必须作废在途请求**（`++seq` + `abort`）：上一个源还在路上的 explore 响应回来时
   *   `seq` 不匹配 → 在 `load` 的 catch/finally 前判掉 —— 不作废就会把残留卡片**盖回来**，
   *   用户看到的「没有重置空」有一半就是这个竞态。
   *
   * 卡片形状与普通内容卡片一致（`title` + `payload.link`），点击由 `DiscoverView.openDetail`
   * 的 `#356` 分支接住（webViewOnly + http link → `reader.openWeb`），这里不另写打开逻辑。
   */
  function resetToWebOnlyCard(kind: string, item: Record<string, unknown>) {
    const b = bucket(kind);
    b.ctrl?.abort();
    b.ctrl = null;
    b.seq++; // 作废在途的 load / refreshContent 响应（它们回来时 seq 不匹配 → 整批丢弃）
    b.active = null;
    b.filters = [];
    b.items = [item];
    b.startPage = null; // `#404` 网页型卡片与启动页互斥
    b.err = '';
    b.hint = '';
    b.inputs = {};
    b.loading = false;
    b.refreshing = false;
    b.loadingMore = false;
    b.hasMore = false;
    b.nextUrl = '';
    b.page = 1;
    b.loadedAt = Date.now();
  }

  /**
   * 「重算分类」按钮：**保留交互输入态**，重跑 `exploreUrl` 脚本（Legado `java.refreshExplore()`
   * → `SourceLoginJsExtensions.Callback.reUiView` → `clearExploreKindsCache()` + 重跑 `exploreKinds()`）。
   *
   * 与 `onSourceChange` 的区别：那个是「换源/重置」（会清掉交互输入态），这个只重算。
   * 交互控件改值会自动重算（见 `load()` 的中断逻辑），所以这个按钮是手动兜底。
   */
  async function reloadCategories(kind: string) {
    const b = bucket(kind);
    if (!b.sourceId) return;
    b.active = null; // 置空 → load 走 home 语义（重跑 exploreUrl），而不是 category
    // `#533`：CatToolbar「↻ 重算分类」与左栏「↻ 刷新分类」是同一条诉求（源定义可能已变）⇒ 同样 force
    await load(kind, undefined, { force: true, refreshCats: true });
  }

  /**
   * **备份恢复 / 快照导入后作废全部发现页内存快照**。
   *
   * 用户实测（2026-11-26）：从 zip 备份恢复后，发现页仍是恢复前的内容，必须重启服务
   * （等价于重开页面）才看得见。根因是内存里有两层缓存不会因为「换了个页面」而失效：
   *  · 本 store 的桶（`items` / `filters` / `loadedAt`）与模块级 `DISCOVER_CACHE`；
   *  · `useSourcesStore` 的 `loaded` 门闩让 `onMounted` 的 `loadMeta()` 直接返回。
   * ⇒ 调用方必须先 `loadMeta(true)` 再调本方法（见 `SettingsView` 的恢复成功分支）。
   *
   * `sourceId` **保留但校验**：恢复通常只是覆盖同一批源，留在原源上更符合预期；
   * 源已不在（备份换了一批源）则清空 ⇒ `ensureLoaded` 会重新挑第一个可用源。
   */
  function resetAll() {
    const ids = new Set(useSourcesStore().sources.map((s) => s.id));
    for (const b of Object.values(buckets.value)) {
      b.ctrl?.abort();
      b.ctrl = null;
      b.seq++; // 作废在途响应（它们回来时 seq 不匹配 ⇒ 整批丢弃）
      b.items = [];
      b.startPage = null;
      b.filters = [];
      b.hint = '';
      b.active = null;
      b.loadedAt = 0;
      b.page = 1;
      b.hasMore = false;
      b.nextUrl = '';
      b.loading = false;
      b.loadingMore = false;
      b.refreshing = false;
      b.err = '';
      if (b.sourceId && !ids.has(b.sourceId)) {
        b.sourceId = '';
        b.inputs = {}; // 旧源的交互输入态（$input）对新源没有意义
      }
    }
    DISCOVER_CACHE.clear();
  }

  /** 首次进入某发现页：按 kind 选默认源（仅「具备发现能力 + 未禁用发现」的源）并加载 */
  function ensureLoaded(kind: string) {
    const b = bucket(kind);
    if (!b.sourceId) {
      const st = useSourcesStore();
      const pool = discoverableSources(kind);
      const pick = pool[0];
      if (pick) b.sourceId = pick.id;
    }
    if (!b.items.length && b.sourceId) void load(kind, undefined, { autoPickFirst: true });
  }

  /**
   * 该发现页可选的源（按 kind）。
   *
   * `#310`（用户 2026-10-07 需求 ②③）：判据统一走 `utils/source-gate.ts` 的 `exploreUsable`，
   * 它把两层分开表达：
   *  · **能力门** `hasExplore`（legado = 有 `exploreUrl`；rss/cms 恒有）；
   *  · **用户开关** `exploreEnabled`，**但 RSS 没有这个开关 ⇒ 跳过它**（见 source-gate 文件头）。
   * 另加 `state.enabled`：**源管理里禁用的源不得出现在发现页源列表**（用户明确要求）。
   */
  function discoverableSources(kind: string) {
    const st = useSourcesStore();
    return st.sources.filter((s) => s.kind === kind && exploreUsable(s));
  }

  /** 该发现页可选的源（按 kind）——列表直接复用发现能力过滤 */
  function sourcesOf(kind: string) {
    return discoverableSources(kind);
  }

  return { buckets, bucket, load, loadMore, refreshContent, selectExplore, onSourceChange, resetToWebOnlyCard, loadStartPage, openSortCategories, reloadCategories, ensureLoaded, resetAll, sourcesOf, discoverableSources, setInput, setViewMode };
});
