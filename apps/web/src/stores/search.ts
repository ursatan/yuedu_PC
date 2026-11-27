import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { aggregateSearch, runAction, type EngineEvent, type ScanSummary } from '../api';
import { aggregatePerSrc, rawCountByKind, type MergedHit, type RawSearchItem } from '../utils/search-merge';
import { filterCandidates, searchableSources } from '../utils/search-scope';
// `B6` 质量分（搜索候选池排序 + 聚合卡内多源顺序）
import { effectiveSourceQuality } from '@yuedu/core/contract';

/**
 * 聚合搜索状态（`#273` 重构 · `#275` 三级筛选 + 单源交互修复）。
 *
 * ## 数据模型（两层归并，见 `utils/search-merge.ts` 头注释）
 * - **per-src 隔离**：`perSrc[srcId].pages[n-1]` = 第 n 页**原始** items（不跨源合并）
 *   ⇒ 单源视图平铺，卡片数与该源返回数一致；
 * - **聚合视图**：computed 实时 `aggregatePerSrc(perSrc)` 按 dedupId 合并 ⇒ `mergedHits`
 *   （单源翻页 / 懒加载的新页**自动并入**聚合结果 —— computed 链，无需手动同步）。
 *
 * ## `#275` 三级筛选（`utils/search-scope.ts` 纯函数）
 * 引擎（scopeEngine）→ 源类型（scopeType）→ 分组（scopeGroup）；候选 = 三级筛选后的
 * 「启用且开搜索」源。切换上一级 ⇒ 清空下级已选值（防「挂着却 0 条」）。
 *
 * ## 并发池 + idle 懒加载
 * 前 `initialPoolSize`（默认 9）个随 `doSearch` 进初始池，其余 idle —— 点源名才单源搜索
 * （服务端 `sourceIds` 白名单，`#273` 新增；`#275` 起**始终传 sourceIds**，三级筛选在前端定池）。
 * **翻页失败 ≠ 到底**：连续 `LOAD_FAIL_GIVEUP`(3) 次没拿到新数据才 noMore 放弃。
 */

/** 单源一个 scope（OmniFlow `PerSrcScope` 的本仓精简版） */
interface PerSrcScope {
  pages: RawSearchItem[][]; // pages[n-1] = 第 n 页原始 items
  totalCount: number; // sum(pages[*].length)
  noMore: boolean;
  cursor: number; // 已加载到第几页（0=未搜到第 1 页）
  failCount: number; // 连续「没拿到新数据」次数（空桶 / done 失败），成功清零
  lastError?: string;
}

type SrcStatus = 'ok' | 'dead' | 'pending' | 'idle';

const newScope = (): PerSrcScope => ({ pages: [], totalCount: 0, noMore: false, cursor: 0, failCount: 0 });

/** 聚合搜索状态：切页 / 进详情后返回，保留上次结果（对齐 OmniFlow S7 会话保持）。 */
export const useSearchStore = defineStore('search', () => {
  const keyword = ref('');
  /**
   * `#279` a4：最近一次**实际发起**的搜索词（doSearch 真正跑起来才写）。
   * 与 `keyword`（输入框双向绑定，边打字边变）分开 —— 空态/统计文案用它，
   * 否则「刚输入还没点搜索」就会显示「没有命中「kw」（成功 0/0）」，提示失真。
   */
  const searchedKeyword = ref('');
  const searching = ref(false);
  const status = ref('');
  const elapsedMs = ref(0);
  const scan = ref<ScanSummary | null>(null);
  const failedOpen = ref(false);

  // —— `#275` 三级筛选：引擎 → 源类型 → 分组（上一级变化 ⇒ 清下级已选） ——
  const scopeEngine = ref('all');
  const scopeType = ref('');
  const scopeGroup = ref('');
  /**
   * `#277` 源列表下拉 = **最后一层筛选**：选中单源 ⇒ 「聚合搜索」只对该源发起、
   * 分类条只加载该源；不选（null）⇒ 对整个筛选后分组发起。切换三级筛选 ⇒ 清单源已选
   * （单源是分组的子集，层级变了旧选择失效）。
   */
  const pickedSourceId = ref<string | null>(null);
  watch(scopeEngine, () => {
    scopeType.value = '';
    scopeGroup.value = '';
    pickedSourceId.value = null;
  });
  watch(scopeType, () => {
    scopeGroup.value = '';
    pickedSourceId.value = null;
  });
  watch(scopeGroup, () => {
    pickedSourceId.value = null;
  });

  // —— `#273` 并发池 + per-src 隔离 ——
  /** 初始并发池大小（OmniFlow `SEARCH_MAX_CONCURRENT` 默认 9）；其余候选进 idle 懒加载 */
  const initialPoolSize = ref(9);
  /** 服务端并发 worker 数 */
  const concurrency = ref(4);
  /** 本次搜索的候选源（三级筛选后全量，不再用 limit 截断丢源） */
  const candidates = ref<Array<{ id: string; name: string; kind: string }>>([]);
  /** 还没搜过的源（点源名才搜） */
  const idleSourceIds = ref<string[]>([]);
  const perSrc = ref<Record<string, PerSrcScope>>({});
  const sourceStatus = ref<Record<string, { name: string; kind: string; status: SrcStatus; count: number; ms?: number; error?: string }>>({});
  /** null = 聚合视图；否则单源视图 */
  const viewSourceId = ref<string | null>(null);
  /** 单源请求进行中（防重入；与全局 searching 互不阻塞） */
  const busySourceIds = ref<Set<string>>(new Set());

  const LOAD_FAIL_GIVEUP = 3;
  /**
   * 单源最大自动翻页数（`#275` 滚动到底自动加载的护栏）：
   * 有的源/演示源**每页都恒有内容**（永不到底）⇒ 没有上限的话 sentinel 常驻视口会无限请求。
   * 20 页 × 每页若干条已远超单源聚合需要；真到底的源不受影响（空桶/无下一页自然停）。
   */
  const MAX_PAGES_PER_SRC = 20;

  /**
   * `B6` 源质量分缓存（id → 有效质量分）。`doSearch` 拿到源库元信息后同步；
   * 未体检/未收录的源回落到中性分（与 `effectiveSourceQuality(undefined)` 一致）。
   */
  const qualityBySource = ref<Record<string, number>>({});
  function syncQualityFromSources(list: Array<{ id: string; health?: Parameters<typeof effectiveSourceQuality>[0] }>): void {
    const next: Record<string, number> = {};
    for (const s of list) next[s.id] = effectiveSourceQuality(s.health);
    qualityBySource.value = next;
  }

  // —— getters ——
  /** 聚合视图 hits：各源各页 flat → dedupId 合并 → 排序 → 截断（`utils/search-merge.ts`） */
  const mergedHits = computed<MergedHit[]>(() =>
    // `#511` 传「已落地的搜索词」（不是正在输入的 keyword）做匹配度评分；
    // `#618` 去重键恒含作者（对齐上游 `SearchModel.mergeItems` 的 name+author 判据）——
    // 否则「同名不同作者」被并成一张卡，点进去只有其中一家的书。
    // `B6` 质量分只在「档位/匹配度/来源数」打平时参与排序，且决定同卡多源顺序。
    aggregatePerSrc(perSrc.value, 200, {
      keyword: searchedKeyword.value,
      authorAware: true,
      sourceQuality: (id) => qualityBySource.value[id] ?? effectiveSourceQuality(undefined),
    }),
  );

  /**
   * `#275`：聚合结果**按 kind 分组展示在视图层**（「书籍 共N组「kw」」），
   * store 不再做 kind 过滤 —— 旧的 scopeKind 过滤已由三级筛选（引擎维度）取代。
   */
  const filteredHits = computed(() => mergedHits.value);
  /**
   * `#278` 全量口径：所有源所有页的**原始**条数（不 dedup，含初始池 + 点击单源懒加载 +
   * 单源自动翻页的全部数据）。聚合「组数」是 dedup 后的 —— 漫画源分话/重复数据 135 条
   * 只涨极少组，用户会以为「动态加载没并入统计」；组数 + 条数并排才看得见全量。
   */
  const rawKindCounts = computed<Record<string, number>>(() => rawCountByKind(perSrc.value));
  const rawHitCount = computed(() => Object.values(rawKindCounts.value).reduce((a, b) => a + b, 0));
  /** 当前视图应显示的条数（聚合 / 单源） */
  const viewHitCount = computed(() =>
    viewSourceId.value ? perSrc.value[viewSourceId.value]?.totalCount ?? 0 : filteredHits.value.length,
  );

  // —— 内部：写页 + 终态 ——
  function sumPages(scope: PerSrcScope): number {
    return scope.pages.reduce((n, p) => n + p.length, 0);
  }

  /** 把第 `page` 页原始 items 写进该源自己的 scope（**不污染其它源**） */
  function writePage(sid: string, page: number, items: RawSearchItem[]): void {
    /**
     * `#510-③` **补齐 `sourceId`**（用户实测：筛单源后结果的卡片，「详情/阅读/封面」点击无响应，
     * 其他单源同样，而聚合结果可点）。
     *
     * 真因：服务端 `items` **不带 `sourceId`** —— 它在 SSE 事件的 `ev.sourceId` 上。聚合视图靠
     * `search-merge.refOf(sourceId, it)` 显式注入所以正常；单源视图的 `openRaw/readFirst` 直接读
     * `it.sourceId` ⇒ 拿到**空串** ⇒ `reader.openDetail('')` 什么也打不开（表观就是点了没反应）。
     * 在唯一写入点统一注入（服务端将来若自带则以它为准），顺带修好卡片上「源名/耗时」的显示。
     */
    const rows = items.map((it) => (it['sourceId'] ? it : { ...it, sourceId: sid }));
    const scope = perSrc.value[sid] ?? (perSrc.value[sid] = newScope());
    if (page === 1) {
      scope.pages[0] = rows;
      scope.cursor = 1;
      if (!rows.length) scope.noMore = true; // 首页空 = 该源到底（合法空，不重试）
    } else if (rows.length) {
      scope.pages[page - 1] = rows;
      scope.cursor = page;
      scope.failCount = 0; // 成功清零（OmniFlow `_writePerSrcPage` 同规则）
      scope.lastError = undefined;
    } else {
      // 翻页空桶 ≠ 到底：可能是瞬态失败/源翻页抖动，连续 3 次才放弃
      scope.failCount += 1;
      if (scope.failCount >= LOAD_FAIL_GIVEUP) scope.noMore = true;
    }
    scope.totalCount = sumPages(scope);
    if (scope.cursor >= MAX_PAGES_PER_SRC) scope.noMore = true;
    const st = sourceStatus.value[sid];
    if (st) st.count = scope.totalCount;
  }

  function markDone(sid: string, ok: boolean, page: number, errMsg?: string): void {
    const st = sourceStatus.value[sid];
    if (ok) {
      // done 了但没有任何 items 事件（服务端 0 条且空数组事件丢失的兜底）⇒ 补空页
      const scope = perSrc.value[sid] ?? (perSrc.value[sid] = newScope());
      if (scope.cursor < page) writePage(sid, page, []);
      if (st && st.status === 'pending') st.status = 'ok';
    } else {
      // 失败 ≠ 到底：初始池失败源**放回 idle** 可重试（OmniFlow 同语义）
      if (st) {
        st.status = 'dead';
        st.error = errMsg;
      }
      const scope = perSrc.value[sid] ?? (perSrc.value[sid] = newScope());
      scope.failCount += 1;
      scope.lastError = errMsg;
      if (scope.failCount >= LOAD_FAIL_GIVEUP) scope.noMore = true;
      if (page === 1 && !idleSourceIds.value.includes(sid)) idleSourceIds.value.push(sid);
    }
  }

  /**
   * 公共请求链（OmniFlow `_fetchSingleSourcePage` 的本仓版）：
   * 发一次聚合搜索（白名单 `srcIds` + 指定 `page`），事件写回各源自己的 scope。
   * `#275`：始终传 `sourceIds`（三级筛选在前端定池，服务端不再重复过滤）；
   * 每源 `ms` = 该请求发起到**该源首批结果落地**的耗时（出结果用时）。
   */
  async function fetchPages(srcIds: string[], page: number): Promise<void> {
    if (!keyword.value.trim()) return;
    // `#277`：picked 定搜重置过 sourceStatus ⇒ 懒加载/单源刷新的源可能不在状态表 ——
    // 不补注册的话 chip 无命中数/ms、实时统计漏计该源
    if (srcIds.some((id) => !sourceStatus.value[id])) {
      const { useSourcesStore } = await import('./sources');
      const stx = useSourcesStore();
      for (const id of srcIds) {
        if (!sourceStatus.value[id]) {
          const meta = stx.sources.find((x) => x.id === id);
          sourceStatus.value[id] = { name: meta?.name || id, kind: meta?.kind ?? '', status: 'pending', count: 0 };
        }
      }
    }
    const t0 = Date.now();
    await aggregateSearch(
      keyword.value,
      { concurrency: concurrency.value, sourceIds: srcIds, page },
      (ev: EngineEvent) => {
        if (ev.type === 'items') {
          const sid = String(ev.sourceId);
          const st = sourceStatus.value[sid];
          if (st && st.ms === undefined) st.ms = Date.now() - t0;
          writePage(sid, page, (ev.items ?? []) as RawSearchItem[]);
        } else if (ev.type === 'done') {
          markDone(String(ev.sourceId), ev.ok === true, page);
        } else if (ev.type === 'scan') {
          scan.value = { scanned: ev.scanned, ok: ev.ok, failed: ev.failed };
        }
      },
    );
  }

  /** 主搜索：reset → 三级筛选定候选 → 划分初始池 / idle → 前 N 个进池并发 */
  async function doSearch(kw?: string) {
    if (kw !== undefined) keyword.value = kw;
    if (!keyword.value.trim()) return;
    searchedKeyword.value = keyword.value.trim(); // `#279` a4：从这一刻起才算「搜过」
    // ★ 同词重搜 = 全新请求：清掉上次全部 scope/状态/游标（OmniFlow `reset()` 同语义）
    perSrc.value = {};
    sourceStatus.value = {};
    idleSourceIds.value = [];
    viewSourceId.value = null;
    scan.value = null;
    candidates.value = [];
    searching.value = true;
    elapsedMs.value = 0;
    status.value = '搜索中…';
    const t0 = Date.now();
    try {
      // 候选 = 启用 + 开搜索 + 三级筛选（纯函数 `utils/search-scope.ts`，与视图面板同链）
      const { useSourcesStore } = await import('./sources');
      const st = useSourcesStore();
      await st.loadMeta();
      // `B6` 源库元信息 → 质量分缓存（搜索候选池排序 + 聚合卡内多源顺序共用）
      syncQualityFromSources(st.sources);
      const pool = searchableSources(st.sources);
      const picked = filterCandidates(pool, {
        engine: scopeEngine.value, type: scopeType.value, group: scopeGroup.value,
      });
      candidates.value = picked.map((s) => ({ id: s.id, name: s.name || s.id, kind: s.kind }));
      // `#277`：源列表选中了单源 ⇒ 本轮候选收窄为这一个源（统计分母/分类条/搜索范围同源）
      if (pickedSourceId.value) {
        candidates.value = candidates.value.filter((c) => c.id === pickedSourceId.value);
        if (!candidates.value.length) pickedSourceId.value = null; // 选中源不在当前筛选池 ⇒ 失效回落
      }
      const initIds = candidates.value.slice(0, pickedSourceId.value ? 1 : initialPoolSize.value).map((c) => c.id);
      idleSourceIds.value = candidates.value.slice(pickedSourceId.value ? 1 : initialPoolSize.value).map((c) => c.id);
      // `#285` 单源定搜 = 结果**只有这一个源**，没有「聚合」可言 ⇒ 直接进单源视图
      //（列表 1→3 列，与多源聚合点单源后的展示同款）；候选收窄失败（源不在池）时
      // pickedSourceId 已回落 null ⇒ 走聚合视图。
      if (pickedSourceId.value) viewSourceId.value = pickedSourceId.value;
      for (const c of candidates.value) {
        sourceStatus.value[c.id] = {
          name: c.name, kind: c.kind,
          status: initIds.includes(c.id) ? 'pending' : 'idle',
          count: 0,
        };
      }
      await fetchPages(initIds, 1);
    } catch (e) {
      status.value = '搜索出错：' + String(e instanceof Error ? e.message : e);
    } finally {
      searching.value = false;
      elapsedMs.value = Date.now() - t0;
      // pending 残留置 dead（搜索中断/断流兜底）
      for (const [sid, st] of Object.entries(sourceStatus.value)) {
        if (st.status === 'pending') {
          st.status = 'dead';
          st.error = st.error ?? '搜索中断';
          if (!idleSourceIds.value.includes(sid)) idleSourceIds.value.push(sid);
        }
      }
      if (!status.value.startsWith('搜索出错')) {
        status.value = `完成：聚合 ${mergedHits.value.length} 条（候选 ${candidates.value.length} 源）`;
      }
    }
  }

  /** 点 idle 源：只对该源发一次第 1 页（不惊动其它源） */
  async function ensureSourceSearched(srcId: string): Promise<void> {
    if (!keyword.value.trim() || busySourceIds.value.has(srcId)) return;
    if (!idleSourceIds.value.includes(srcId)) return;
    busySourceIds.value.add(srcId);
    const st = sourceStatus.value[srcId];
    if (st) st.status = 'pending';
    try {
      await fetchPages([srcId], 1);
      // 成功 ⇒ 移出 idle；失败（markDone 已放回）⇒ 留在 idle 可重试
      idleSourceIds.value = idleSourceIds.value.filter((x) => x !== srcId);
      if (sourceStatus.value[srcId]?.status === 'dead') idleSourceIds.value.push(srcId);
    } finally {
      busySourceIds.value.delete(srcId);
      const s = sourceStatus.value[srcId];
      if (s?.status === 'pending') s.status = 'dead';
    }
  }

  /** 单源翻下一页（该源 cursor+1）；失败连续 3 次才 noMore（writePage 内）；到 MAX_PAGES 封顶 */
  async function loadMoreForSource(srcId: string): Promise<void> {
    const scope = perSrc.value[srcId];
    if (!scope || scope.noMore || scope.cursor < 1) return;
    if (scope.cursor >= MAX_PAGES_PER_SRC) {
      scope.noMore = true;
      return;
    }
    if (busySourceIds.value.has(srcId)) return;
    busySourceIds.value.add(srcId);
    const st = sourceStatus.value[srcId];
    if (st) st.status = 'pending';
    try {
      await fetchPages([srcId], scope.cursor + 1);
    } finally {
      busySourceIds.value.delete(srcId);
      const s = sourceStatus.value[srcId];
      if (s?.status === 'pending') s.status = 'ok';
    }
  }

  /**
   * `#275` 刷新本源：清掉该源已拉数据后重发第 1 页（其它源不受影响；
   * 新页照常并入聚合视图 —— 同一条 computed 链）。
   */
  async function refreshSource(srcId: string): Promise<void> {
    if (!keyword.value.trim() || busySourceIds.value.has(srcId)) return;
    perSrc.value[srcId] = newScope();
    idleSourceIds.value = idleSourceIds.value.filter((x) => x !== srcId);
    const st = sourceStatus.value[srcId];
    if (st) {
      st.status = 'pending';
      st.count = 0;
      st.ms = undefined;
    }
    busySourceIds.value.add(srcId);
    try {
      await fetchPages([srcId], 1);
      const s = sourceStatus.value[srcId];
      if (s?.status === 'pending') s.status = 'ok';
    } finally {
      busySourceIds.value.delete(srcId);
      const s = sourceStatus.value[srcId];
      if (s?.status === 'pending') s.status = 'dead';
    }
  }

  /* ---------------- 单源调试运行（规则工坊用，`#273` 原样保留） ---------------- */
  const dbgSourceId = ref('');
  const dbgAction = ref('search');
  const dbgKeyword = ref('剑来');
  const dbgRunning = ref(false);
  const dbgOutput = ref('');
  const dbgError = ref('');

  async function doRun() {
    dbgRunning.value = true;
    dbgOutput.value = '';
    dbgError.value = '';
    try {
      const r = await runAction(dbgSourceId.value, dbgAction.value, { keyword: dbgKeyword.value });
      dbgOutput.value = JSON.stringify(r, null, 2);
    } catch (e) {
      dbgError.value = String(e instanceof Error ? e.message : e);
    } finally {
      dbgRunning.value = false;
    }
  }

  return {
    keyword, searchedKeyword, searching, status, elapsedMs, scan, failedOpen,
    // `#275` 三级筛选
    scopeEngine, scopeType, scopeGroup,
    // `#277` 源列表单源定搜
    pickedSourceId,
    doSearch,
    // `#273`
    initialPoolSize, concurrency, candidates, idleSourceIds, perSrc, sourceStatus, viewSourceId,
    busySourceIds, mergedHits, filteredHits, viewHitCount,
    // `#278` 全量口径
    rawKindCounts, rawHitCount,
    ensureSourceSearched, loadMoreForSource,
    // `#275`
    refreshSource,
    dbgSourceId, dbgAction, dbgKeyword, dbgRunning, dbgOutput, dbgError, doRun,
  };
});
