<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSearchStore } from '../stores/search';
import { useSourcesStore } from '../stores/sources';
import { useReaderStore } from '../stores/reader';
import { useVodStore } from '../stores/vod';
import type { MergedHit, RawSearchItem, SourceHitRef } from '../utils/search-merge';
import {
  engineOptionsOf, typeOptionsOf, groupOptionsOf, filterCandidates, searchableSources, itemKindLabel,
} from '../utils/search-scope';
// `#276`：候选源条直接复用发现页分类条组件（横向 chips + 右端▾全量下拉带筛选框）—— 同一套观感
import CategoryScroller, { type CatOption } from '../components/CategoryScroller.vue';
// `#280` 引擎/类型/分组筛选统一组件（弹层样式与 SourceGroupFilter 一致）
import FilterDropdown from '../components/FilterDropdown.vue';
import SourceGroupFilter from '../components/SourceGroupFilter.vue';
// `#280` 筛选框字段口径（名称/URL/注释/分组）唯一实现
import { matchSourceQuery } from '../utils/source-query';

// 封面统一走服务端代理（防盗链 Referer + 源图片解密 + 动图原样透传）——见 utils/img.ts
import CoverImage from '../components/CoverImage.vue'; /* `#163` 封面统一出口 */
import { itemAuthor } from '../utils/list-item';
const route = useRoute();
const ss = useSearchStore();
const st = useSourcesStore();
const reader = useReaderStore();
const vod = useVodStore();

/** `#510-②` 处理「从发现页带 source 跳进来」：先收窄到该单源，再进行搜索 */
function applyQuerySource(): void {
  const src = route.query.source;
  if (typeof src !== 'string' || !src) return;
  // 只在「首次落地」时消费：用户随后自己改选源时不要再被 query 拽回去
  if (ss.pickedSourceId && ss.pickedSourceId !== src) return;
  ss.pickedSourceId = src;
}
onMounted(() => {
  void st.loadMeta();
  applyQuerySource();
  const q = route.query.q as string;
  if (q && q !== ss.keyword && !ss.viewHitCount) void ss.doSearch(q);
  nextTick(setupObserver);
});
watch(() => route.query.q, (q) => {
  if (typeof q === 'string' && q && q !== ss.keyword && !ss.viewHitCount) void ss.doSearch(q);
});

/* ---------------- `#275` 三级筛选 options（计数口径 = 该筛选链下的候选源数） ---------------- */
const poolAll = computed(() => searchableSources(st.sources));
const engOpts = computed(() => engineOptionsOf(poolAll.value));
const typeOpts = computed(() => typeOptionsOf(poolAll.value, ss.scopeEngine));
const grpOpts = computed(() => groupOptionsOf(poolAll.value, ss.scopeEngine, ss.scopeType));
/** `#280` 「全部分组」行计数 = 引擎+类型下钻后的池子（与选中后能看到的候选数一致） */
const grpAllCount = computed(() =>
  filterCandidates(poolAll.value, { engine: ss.scopeEngine, type: ss.scopeType, group: '' }).length,
);
/** 筛选后的候选数（工具栏提示 + 空态文案共用） */
const candidateCount = computed(() =>
  filterCandidates(poolAll.value, { engine: ss.scopeEngine, type: ss.scopeType, group: ss.scopeGroup }).length,
);

/* ---------------- `#276` 源列表下拉（工具栏）+ 候选源分类条（发现页样式） ---------------- */
const srcListOpen = ref(false);
/**
 * `#290` bug1（用户 2026-10-05：输入中文时弹窗突然失焦关闭，英文正常）：
 * 原来靠 `@mouseleave` 收起 —— IME 候选窗是**原生窗口**（非 DOM 子孙），它一出现在鼠标
 * 位置下，浏览器就判鼠标已离开 popup ⇒ 弹窗连输入框一起被拆掉。改成 document 级
 * 「点击外部关闭」（与 FilterDropdown / SourceGroupFilter 同模式），不再依赖鼠标悬停位置。
 */
const srcPanelEl = ref<HTMLElement | null>(null);
function onSrcDocClick(e: MouseEvent): void {
  if (!srcListOpen.value) return;
  const t = e.target;
  if (t instanceof Node && srcPanelEl.value?.contains(t)) return;
  srcListOpen.value = false;
}
onMounted(() => document.addEventListener('click', onSrcDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onSrcDocClick));
/** 筛选框（源列表下拉内用）：定位到单一源 */
const srcFilter = ref('');
/** 经三级筛选后的候选源（分类条与下拉共用同一池；下拉里再叠加 srcFilter 文本筛选）。
 *  `#280` 带上 comment/group —— 筛选框字段口径 = 名称/URL/注释/分组（与其它四页一致） */
const scopedSources = computed(() =>
  filterCandidates(poolAll.value, { engine: ss.scopeEngine, type: ss.scopeType, group: ss.scopeGroup })
    .map((s) => ({ id: s.id, name: s.name || s.id, kind: s.kind, comment: s.comment, group: s.group })),
);
const panelSources = computed(() => scopedSources.value.filter((s) => matchSourceQuery(s, srcFilter.value)));
function panelStatus(id: string): string {
  return ss.sourceStatus[id]?.status ?? 'idle';
}
/**
 * `#278` 位置1：选中单源后按钮显示**原名称**（如「🎨51漫画」）。
 * 不能只查 `sourceStatus[id].name` —— 它在 doSearch 时整体清空、选中后未搜索前是空的，
 * 会退化显示原始 id（= bookSourceUrl 规范化，用户看到的就是一串 URL）。
 */
const pickedName = computed(() => {
  const id = ss.pickedSourceId;
  if (!id) return '';
  return scopedSources.value.find((x) => x.id === id)?.name
    ?? poolAll.value.find((x) => x.id === id)?.name
    ?? ss.sourceStatus[id]?.name
    ?? id;
});
/**
 * `#277` 源列表下拉 = **最后一层筛选**：点行 = 选中/取消该单源（不直接搜）——
 * 选中后按钮显示源名、分类条只加载该源，「聚合搜索」只对该源发起；
 * 不选 ⇒ 分类条加载整个筛选后分组，搜索对该分组发起。
 */
function pickSource(id: string) {
  ss.pickedSourceId = ss.pickedSourceId === id ? null : id;
  if (!ss.pickedSourceId) srcFilter.value = '';
}
/** 分类条 chips：选中单源 ⇒ 只加载该源；否则 全部 + 筛选后分组内各源（label 追加命中数） */
const srcChips = computed<CatOption[]>(() => {
  if (ss.pickedSourceId) {
    const s = scopedSources.value.find((x) => x.id === ss.pickedSourceId);
    return s ? [{ label: s.name, rawLabel: s.name, value: s.id }] : [];
  }
  // `#279` a2：移除「全部」chip —— 它绑定的「回聚合视图」已由结果区类型 tab +
  // 单源工具条「返回聚合结果」按钮覆盖，留着只会让人疑惑它指向哪个页面
  return scopedSources.value.map((s) => {
    const n = ss.sourceStatus[s.id]?.count ?? 0;
    return { label: n > 0 ? `${s.name} ${n}` : s.name, rawLabel: s.name, value: s.id };
  });
});
const curChip = computed<CatOption | null>(() => {
  const id = ss.viewSourceId;
  if (!id) return null;
  const hit = srcChips.value.find((c) => c.value === id);
  return hit ? { ...hit } : null;
});
function onChipPick(c: CatOption) {
  if (!c.value) { ss.viewSourceId = null; return; }
  openSourceView(c.value);
}

/* ---------------- `#277` 实时统计行（OmniFlow 口径）：命中组数 / 成功完成 / 搜索中 / 待手动点击 ---------------- */
const stOk = computed(() => Object.values(ss.sourceStatus).filter((s) => s.status === 'ok').length);
const stPending = computed(() => Object.values(ss.sourceStatus).filter((s) => s.status === 'pending').length);
const stDead = computed(() => Object.values(ss.sourceStatus).filter((s) => s.status === 'dead').length);
const stIdle = computed(() => ss.idleSourceIds.length);
// `#279` a4：判据 = 是否**真的发起过**搜索（searchedKeyword 只在 doSearch 落地时写）；
// 旧判据 `!!ss.keyword` 会把「正在输入」当「搜过」⇒ 空态误报「没有命中「kw」（成功 0/0）」
const searchStarted = computed(() => !!ss.searchedKeyword);
const hitsCapped = computed(() => ss.filteredHits.length >= 200); // aggregatePerSrc maxHits=200 截断上限

/** 从归并引用组装「原始 item 形状」—— 详情/阅读入口复用同一份打开逻辑 */
function openRef(ref0: SourceHitRef, kind: string) {
  const it = { sourceId: ref0.sourceId, payload: ref0.payload, title: ref0.title, cover: ref0.cover, kind };
  if (kind === 'video') {
    vod.openDetail({ sourceId: ref0.sourceId, payload: ref0.payload, title: ref0.title, cover: ref0.cover });
    return;
  }
  /**
   * `#572` **文章类（RSS 单网址源）与发现页统一为「直达阅读」**。
   *
   * 症状（用户 2026-10-23）：同一类源，从发现页点卡片直达阅读器，从搜索结果点却先出详情页
   * →（自动选目录）→阅读器。根因是**两个入口两套路由**（`#356` 只修了发现页）。
   * 判据：`kind === 'article'` 就是订阅源文章（`UnifiedItem.kind` 枚举），它没有「详情页」这个中间态
   * （上游 `ReadRssActivity` 点文章就是直接进正文）。
   */
  if (kind === 'article') {
    void reader.readFirstDirect(ref0.sourceId, it);
    return;
  }
  reader.openDetail(ref0.sourceId, it);
}
function openMerged(hit: MergedHit, ref0?: SourceHitRef) {
  openRef(ref0 ?? hit.sources[0], hit.kind);
}
function openRaw(it: RawSearchItem) {
  const kind = String(it.kind ?? '');
  if (kind === 'video') {
    vod.openDetail({ sourceId: String(it.sourceId ?? ''), payload: it.payload ?? {}, title: String(it.title ?? ''), cover: it.cover ? String(it.cover) : undefined });
    return;
  }
  if (kind === 'article') {
    void reader.readFirstDirect(String(it.sourceId ?? ''), it);
    return;
  }
  reader.openDetail(String(it.sourceId ?? ''), it);
}
function readFirst(it: RawSearchItem) {
  if (String(it.kind) === 'video') { openRaw(it); return; }
  // `#572` 文章类同样直达（与发现页同一口径）
  if (String(it.kind) === 'article') { void reader.readFirstDirect(String(it.sourceId ?? ''), it); return; }
  void reader.readFirst(String(it.sourceId ?? ''), it);
}
/** 封面悬浮「开始阅读/播放」：进入**第一个来源**的正文 */
function readMergedFirst(hit: MergedHit) {
  const r = hit.sources[0];
  if (!r) return;
  if (hit.kind === 'video') { openRef(r, hit.kind); return; }
  if (hit.kind === 'article') {
    void reader.readFirstDirect(r.sourceId, { sourceId: r.sourceId, payload: r.payload, title: r.title, cover: r.cover, kind: hit.kind });
    return;
  }
  void reader.readFirst(r.sourceId, { sourceId: r.sourceId, payload: r.payload, title: r.title, cover: r.cover, kind: hit.kind });
}

/* ---------------- 聚合视图：按 kind 分组（「书籍 共N组 · M条「kw」」） ---------------- */
const kindGroups = computed(() => {
  const m = new Map<string, MergedHit[]>();
  for (const h of ss.filteredHits) {
    const arr = m.get(h.kind);
    if (arr) arr.push(h);
    else m.set(h.kind, [h]);
  }
  return [...m.entries()]
    .map(([kind, hits]) => ({
      kind, label: itemKindLabel(kind), hits,
      // `#278` 全量口径：该类型**原始**条数（不 dedup，含单源动态加载的分话/重复数据）
      raw: ss.rawKindCounts[kind] ?? 0,
    }))
    .sort((a, b) => b.hits.length - a.hits.length);
});

/* ---------------- `#279` a1：结果分 tab（书籍/漫画/影视…） ----------------
 * kindGroups 天然只含**有结果**的类型 ⇒ 「没有结果的不显示 tab」自动成立；
 * 默认选中组数最多的一类（排在第一位），点击 tab 切换 —— 不再一次性平铺所有类型。
 */
const activeKind = ref('');
watch(kindGroups, (gs) => {
  // 当前选中的类型在新结果里消失（重新搜索/筛选变化）⇒ 回落到组数最多的那类
  if (!gs.some((g) => g.kind === activeKind.value)) activeKind.value = gs[0]?.kind ?? '';
}, { immediate: true });
const activeGroup = computed(() => kindGroups.value.find((g) => g.kind === activeKind.value) ?? null);

/** 来源 chip 文案 = **源名**（不是书名 —— `#275` 用户实测纠偏）+ 出结果耗时 */
function srcName(id: string): string {
  return ss.sourceStatus[id]?.name ?? id;
}
function srcMs(id: string): number | undefined {
  return ss.sourceStatus[id]?.ms;
}

/* ---------------- 单源视图 ---------------- */
const singleScope = computed(() => (ss.viewSourceId ? ss.perSrc[ss.viewSourceId] : undefined));
const flatPages = computed(() => singleScope.value?.pages.flat() ?? []);
/** 点源：切到该源视图；未搜过的**自动发起搜索**（`#275` 修「要点两次」） */
function openSourceView(id: string) {
  srcListOpen.value = false;
  ss.viewSourceId = id;
  if (ss.idleSourceIds.includes(id)) void ss.ensureSourceSearched(id);
  else if (!ss.perSrc[id]) void ss.refreshSource(id); // 不在 idle 又没数据（异常兜底）⇒ 直接重搜
}

/* ---------------- 滚动到底自动翻页（OmniFlow loadMore 语义） ---------------- */
const scrollEl = ref<HTMLElement | null>(null);
const sentinelEl = ref<HTMLElement | null>(null);
let io: IntersectionObserver | null = null;
function tryAutoLoad() {
  const sid = ss.viewSourceId;
  if (!sid) return;
  const scope = ss.perSrc[sid];
  if (!scope || scope.noMore || scope.cursor < 1) return;
  if (ss.busySourceIds.has(sid)) return;
  void ss.loadMoreForSource(sid);
}
function setupObserver() {
  io?.disconnect();
  io = null;
  if (!sentinelEl.value || !scrollEl.value) return;
  io = new IntersectionObserver(
    (entries) => { for (const en of entries) if (en.isIntersecting) tryAutoLoad(); },
    { root: scrollEl.value, rootMargin: '140px' },
  );
  io.observe(sentinelEl.value);
}
watch(() => ss.viewSourceId, () => nextTick(setupObserver));
// 翻页后 sentinel 可能仍停在视口内 ⇒ 重新挂观察（下一页自动续载）
watch(() => (ss.viewSourceId ? ss.perSrc[ss.viewSourceId]?.cursor : 0), () => nextTick(setupObserver));
// `#278`：翻页空桶不推进 cursor（只涨 failCount）⇒ 上面两条 watcher 都不触发、
// observer 不重挂 —— 若 sentinel 仍在视口内且无滚动，连续 3 次空桶重试永远不发生（单源假性卡住）。
// 盯 failCount：空桶后重挂 observer，sentinel 还在视口里就立刻重试。
watch(() => (ss.viewSourceId ? ss.perSrc[ss.viewSourceId]?.failCount : 0), () => nextTick(setupObserver));
onBeforeUnmount(() => io?.disconnect());
</script>

<template>
  <div class="disc-layout">
    <div class="card main-card">
      <!-- `#275` 工具栏：引擎筛选 / 类型筛选 / 分组筛选 / 源筛选框 / 搜索框 / 聚合搜索 —— 同一行 -->
      <div class="toolbar searchbar">
        <!-- `#280` 引擎/类型/分组筛选统一组件：FilterDropdown（引擎/类型）+ SourceGroupFilter（分组，
             与书院/影院/工坊/源管理**同一份组件**），弹层样式一致、高度统一 32px -->
        <FilterDropdown
          v-model="ss.scopeEngine"
          :options="engOpts"
          label="引擎"
          empty-text="暂无引擎"
        />
        <FilterDropdown
          v-model="ss.scopeType"
          :options="typeOpts"
          label="类型"
          empty-text="该引擎下暂无类型"
        />
        <span class="tb-grp" :title="`该类型下的源分组（计数 = 命中源数；未选类型 = 全部候选）`">
          <SourceGroupFilter
            v-model="ss.scopeGroup"
            :options="grpOpts"
            :all-count="grpAllCount"
            :shown-count="candidateCount"
            label="分组"
            empty-text="该类型下暂无分组"
          />
        </span>
        <!-- `#277` 位置1：源列表下拉 = 最后一层筛选 —— 点行选中/取消单源（不直接搜）；
             选中 ⇒ 按钮显示源名、分类条只加载该源、「聚合搜索」只对该源发起 -->
        <span ref="srcPanelEl" class="src-panel tb-src">
          <button class="btn mini tb-src-btn" :class="{ on: srcListOpen || ss.pickedSourceId }" title="源列表：最后一层筛选，选中单源后点「聚合搜索」只搜该源" @click="srcListOpen = !srcListOpen">
            {{ ss.pickedSourceId ? '◉ ' + pickedName : `▤ 源列表（${candidateCount}）▾` }}
          </button>
          <transition name="fade">
            <!-- `#290` bug1：收起不再用 @mouseleave（IME 候选窗会误触发，见 script）——
                 document 点击外部关闭 + 右上 × -->
            <div v-if="srcListOpen" class="src-popup">
              <div class="sp-head">
                <b>源列表 · {{ panelSources.length }} 项</b>
                <span class="sp-close" @click="srcListOpen = false">×</span>
              </div>
              <div class="sp-search"><input v-model="srcFilter" placeholder="搜索 名称 / URL / 注释 / 分组…" /></div>
              <div class="sp-list">
                <div class="sp-row sp-all" :class="{ on: !ss.pickedSourceId }" @click="ss.pickedSourceId = null; srcFilter = ''">
                  <span class="r-idx">⊗</span>
                  <span class="r-label">全部候选（{{ candidateCount }}，按分组搜）</span>
                  <span v-if="!ss.pickedSourceId" class="r-on">● 当前</span>
                </div>
                <div
                  v-for="(s, i) in panelSources" :key="s.id"
                  class="sp-row" :class="{ on: ss.pickedSourceId === s.id }"
                  :title="s.name + '（' + panelStatus(s.id) + '）'"
                  @click="pickSource(s.id)"
                >
                  <span class="r-idx">{{ i + 1 }}</span>
                  <span class="dot" :class="'st-' + panelStatus(s.id)"></span>
                  <span class="r-label">{{ s.name }}</span>
                  <span v-if="ss.sourceStatus[s.id]?.count" class="r-n">{{ ss.sourceStatus[s.id].count }}</span>
                  <span v-if="ss.sourceStatus[s.id]?.ms != null" class="r-ms">{{ ss.sourceStatus[s.id].ms }}ms</span>
                  <span v-if="ss.pickedSourceId === s.id" class="r-on">● 已选</span>
                </div>
                <div v-if="!panelSources.length" class="sp-empty">无匹配源（调整筛选或关键词）</div>
              </div>
            </div>
          </transition>
        </span>
        <input
          v-model="ss.keyword"
          class="kw"
          :placeholder="ss.keyword ? `上次搜索：${ss.keyword}` : '输入书名 / 片名，Enter 发起跨源聚合搜索'"
          @keyup.enter="ss.doSearch()"
        />
        <button class="btn primary" :disabled="ss.searching" @click="ss.doSearch()">
          {{ ss.searching ? '⏳ 搜索中…' : '⌕ 聚合搜索' }}
        </button>
      </div>

      <!-- `#276` 位置2：经筛选后的源 —— 发现页分类条样式（横向 chips + 右端▾全量下拉带筛选框），
           点「全部」回聚合视图，点源 chip 对该单源发起搜索 -->
      <!-- `#278` 位置2：分类条**独占一行**（1 个源也扩充占整行）—— 不再与候选数/首批/并发/统计挤同一行 -->
      <div class="src-bar-row">
        <CategoryScroller
          class="src-bar"
          :categories="srcChips"
          :model-value="curChip"
          pop-title="候选源"
          empty-hint="无候选源（调整筛选）"
          @change="onChipPick"
        />
      </div>
      <div class="sr-meta" style="margin-top: 8px">
        <span class="tag acc">{{ ss.pickedSourceId ? '单源定搜：只对选中源发起' : `候选 ${candidateCount} 源（首批 ${Math.min(ss.initialPoolSize, candidateCount)} · 其余点源名懒加载）` }}</span>
        <label v-if="!ss.pickedSourceId" class="lim">首批
          <select v-model.number="ss.initialPoolSize">
            <option :value="6">6</option><option :value="9">9</option>
            <option :value="12">12</option><option :value="20">20</option>
          </select>
        </label>
        <label class="lim">并发
          <select v-model.number="ss.concurrency">
            <option :value="2">2</option><option :value="4">4</option>
            <option :value="8">8</option><option :value="16">16</option>
          </select>
        </label>
        <span class="flex1"></span>
        <!-- `#277` 实时统计行（OmniFlow 口径）；`#278` 补**全量原始条数**：
             组数是 dedup 后的，漫画源分话/重复数据 135 条只涨极少组 —— 条数并排才看得见「全量」 -->
        <span v-if="searchStarted && !ss.status.startsWith('搜索出错')" class="status live-stats">
          命中 {{ ss.filteredHits.length }}{{ hitsCapped ? '+' : '' }} 组 · {{ ss.rawHitCount }} 条<template v-if="ss.searchedKeyword">「{{ ss.searchedKeyword }}」</template> · {{ ss.searching ? '搜索中…' : '完成' }}
          ｜成功完成：{{ stOk }}/{{ ss.candidates.length }}
          ｜搜索中：{{ stPending }}
          ｜待手动点击：{{ stIdle }}<template v-if="stDead">｜失败：{{ stDead }}</template>
        </span>
        <span v-else-if="ss.status" class="status" :class="{ err: ss.status.startsWith('搜索出错') }">{{ ss.status }}</span>
        <span v-else class="status">候选源 {{ st.eligible }} 个（已启用且开搜索）</span>
        <span v-if="ss.elapsedMs" class="tag">{{ (ss.elapsedMs / 1000).toFixed(1) }}s</span>
        <button v-if="ss.scan && stDead" class="btn mini ghost" @click="ss.failedOpen = !ss.failedOpen">
          {{ ss.failedOpen ? '收起失败' : '展开失败(' + stDead + ')' }}
        </button>
      </div>
      <ul v-if="ss.failedOpen && ss.scan" class="fail-list">
        <li v-for="(reason, id) in ss.scan.failed" :key="id"><code>{{ id }}</code> → {{ reason }}</li>
      </ul>
    </div>

    <!-- 结果区（固定高度容器内滚动，不把页面撑高） -->
    <div ref="scrollEl" class="result-scroll">
      <!-- ⚠️ 单源视图优先：viewSourceId 非空时**永远**走单源模板 ——
           否则 0 条的源（死源/搜索中）会命中下面全局空态，内容区「不更新」（#275 用户实测） -->
      <div v-if="!ss.viewSourceId && !ss.viewHitCount && !ss.searching" class="card empty">
        <template v-if="searchStarted">
          没有命中「{{ ss.searchedKeyword }}」<template v-if="stDead">（成功 {{ stOk }}/{{ ss.candidates.length }} · 失败 {{ stDead }}）</template><template v-else>（成功 {{ stOk }}/{{ ss.candidates.length }}）</template>
          <div class="empty-sub">调整三级筛选或关键词后重新聚合搜索；也可在「源列表」选中单源单独搜。</div>
        </template>
        <template v-else>
          输入关键词开始聚合搜索。首批 {{ ss.initialPoolSize }} 个源并发，其余源在「候选源」面板点按需加载。
        </template>
      </div>

      <!-- 聚合视图：`#279` a1 结果分 tab —— 每个有结果的类型一个 tab（无结果的不出现），
           tab 上带 组数·条数；选中 tab 内保留分组头（`#278` 的全量条数口径不变） -->
      <template v-else-if="!ss.viewSourceId">
        <div v-if="kindGroups.length" class="kind-tabs">
          <button
            v-for="g in kindGroups" :key="g.kind"
            class="ktab" :class="{ on: g.kind === activeKind }"
            @click="activeKind = g.kind"
          >
            {{ g.label }}<span class="kt-n">{{ g.hits.length }}{{ hitsCapped ? '+' : '' }} 组 · {{ g.raw }} 条</span>
          </button>
        </div>
        <template v-if="activeGroup">
          <div class="grp-head" :title="hitsCapped ? '已达聚合显示上限 200 组，仅展示可信度最高的前 200 组' : ''">
            <b>{{ activeGroup.label }}</b>
            <span class="gh-n">共 {{ activeGroup.hits.length }}{{ hitsCapped ? '+' : '' }} 组 · {{ activeGroup.raw }} 条「{{ ss.searchedKeyword }}」</span>
          </div>
          <div v-for="hit in activeGroup.hits" :key="hit.dedupId" class="item-card">
            <div class="cover-wrap">
              <CoverImage class="cover" :cover="String(hit.cover ?? '')" :source-id="String(hit.sources[0]?.sourceId ?? '')" :title="hit.title" :index="0" @click="openMerged(hit)" />
              <!-- 悬浮操作条（`#276`：与发现页内容卡片**同款** —— 底部渐变条 + ghost/primary 双按钮横排）：
                   详情 / 阅读·播放（进第一个来源） -->
              <div class="cover-actions">
                <button class="cover-btn" @click.stop="openMerged(hit)">ⓘ 详情</button>
                <button class="cover-btn primary" @click.stop="readMergedFirst(hit)">▶ {{ hit.kind === 'video' ? '播放' : '阅读' }}</button>
              </div>
            </div>
            <div class="body">
              <div class="title" @click="openMerged(hit)">
                {{ hit.title }}
                <span class="kind-tag">{{ itemKindLabel(hit.kind) }}</span>
                <span class="tag acc" style="margin-left: 6px">{{ hit.sources.length }} 源</span>
              </div>
              <div class="summary" v-if="hit.summary">{{ hit.summary }}</div>
              <div class="tag-row" v-if="hit.tags.length">
                <span v-for="t in hit.tags" :key="t" class="tag">{{ t }}</span>
              </div>
              <!-- 来源列表：**源名 + 出结果耗时**；点源名以该源打开详情 -->
              <div class="tag-row src-row">
                <button
                  v-for="(r, ri) in hit.sources" :key="r.sourceId + '|' + ri"
                  class="src-btn" :title="r.title || r.sourceId"
                  @click.stop="openRef(r, hit.kind)"
                >
                  <span class="dot ok"></span>{{ srcName(r.sourceId) }}
                  <em v-if="srcMs(r.sourceId) != null">{{ srcMs(r.sourceId) }}ms</em>
                </button>
              </div>
            </div>
          </div>
        </template>
      </template>

      <!-- 单源视图：该源结果 1→3 列自适应 + 滚动到底自动翻页 -->
      <template v-else>
        <div class="single-head">
          <span class="sh-q">🔍 当前查询: <b>「{{ ss.searchedKeyword }}」</b></span>
          <span class="sh-meta">
            （{{ singleScope?.totalCount ?? 0 }} 条命中 · 已拉 {{ singleScope?.cursor ?? 0 }} 页{{ singleScope?.noMore ? ' · 已到底' : '' }}）
          </span>
          <span class="flex1"></span>
          <!-- `#285`：单源定搜（源列表选中后点搜索）时结果只有这一个源，没有聚合可回 ⇒ 藏掉本按钮；
               多源聚合里点源名进来的（viewSourceId 有聚合背景）才显示 -->
          <button v-if="!ss.pickedSourceId" class="btn mini" @click="ss.viewSourceId = null">⧉ 返回聚合结果（合并所有已拉取数据）</button>
          <button class="btn mini" :disabled="ss.busySourceIds.has(ss.viewSourceId)" @click="ss.refreshSource(ss.viewSourceId)">
            ⟳ 刷新本源
          </button>
        </div>
        <div v-if="ss.busySourceIds.has(ss.viewSourceId) && !flatPages.length" class="card empty">
          ⏳ 正在搜索该源…
        </div>
        <div v-else-if="!flatPages.length" class="card empty">
          🔍 单源「{{ srcName(ss.viewSourceId) }}」没有更多的「{{ ss.keyword }}」
          <div v-if="!ss.pickedSourceId" class="empty-sub">换个关键词？或 <a class="lnk" @click="ss.viewSourceId = null">返回聚合视图</a></div>
          <div v-else class="empty-sub">换个关键词试试。</div>
        </div>
        <div v-else class="single-grid">
          <div v-for="(it, ix) in flatPages" :key="ss.viewSourceId + '|' + ix" class="item-card sg-card">
            <div class="cover-wrap">
              <CoverImage class="cover" :cover="String(it.cover ?? '')" :source-id="String(it.sourceId ?? '')" :title="String(it.title ?? '')" :author="itemAuthor(it)" :index="ix" @click="openRaw(it)" />
              <!-- `#276`：详情/阅读 hover 浮现在封面上（与发现页卡片同款），不再单独占一行 -->
              <div class="cover-actions">
                <button class="cover-btn" @click.stop="openRaw(it)">ⓘ 详情</button>
                <button class="cover-btn primary" @click.stop="readFirst(it)">▶ {{ String(it.kind) === 'video' ? '播放' : '阅读' }}</button>
              </div>
            </div>
            <div class="body">
              <div class="title" @click="openRaw(it)">
                {{ it.title }}
                <span class="kind-tag">{{ itemKindLabel(String(it.kind ?? '')) }}</span>
              </div>
              <div class="sub" v-if="it.subtitle">{{ it.subtitle }}</div>
              <div class="summary" v-if="it.summary">{{ it.summary }}</div>
              <div class="tag-row" v-if="Array.isArray(it.tags) && (it.tags as string[]).length">
                <span v-for="t in it.tags as string[]" :key="t" class="tag">{{ t }}</span>
              </div>
              <div class="tag-row src-row">
                <span class="src-btn as-span">
                  <span class="dot ok"></span>{{ srcName(String(it.sourceId ?? '')) }}
                  <em v-if="srcMs(String(it.sourceId ?? '')) != null">{{ srcMs(String(it.sourceId ?? '')) }}ms</em>
                </span>
              </div>
            </div>
          </div>
        </div>
        <!-- 滚动到底自动翻页哨兵（IntersectionObserver） -->
        <div ref="sentinelEl" class="load-sentinel">
          <!-- `#510-④` 首屏搜索（还没有任何数据）时**不叫「加载下一页」**——那时上方正在显示
               「⏳ 正在搜索该源…」，两行同时出现会让用户以为翻页逻辑在乱跑。
               判据加上 `flatPages.length`：只有已经有数据、再拉下一页时才说「加载下一页」。 -->
          <span v-if="ss.busySourceIds.has(ss.viewSourceId) && flatPages.length">⏳ 正在加载下一页…</span>

          <span v-else-if="singleScope?.noMore">— 已加载全部 —</span>
          <span v-else-if="flatPages.length">下拉加载更多</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.main-card { padding: 14px 18px; margin-bottom: 14px; }
/* `#277`：去掉 overflow-x:auto（它会把 .src-popup 绝对定位下拉**整块裁掉**）——
   改 wrap 兜窄屏；下拉 z-index 30 浮在分类条/结果区之上 */
.searchbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.searchbar .kw { flex: 1; min-width: 220px; padding: 9px 14px; font-size: 13px; }
.tb-sel {
  background: var(--bg-3); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 8px; font-size: 12px; outline: none; max-width: 190px; flex: none;
}
/* `#280` 工具栏里的分组筛选（SourceGroupFilter）：去掉左栏兜底的 margin-bottom；弹层与其它页同款 */
.tb-grp { flex: none; }
.tb-grp :deep(.sg-wrap) { margin-bottom: 0; }
/* `#276` 工具栏「源列表」下拉（旧 tb-filter 输入框已移入下拉内） */
.tb-src { flex: none; }
/* `#278` 位置1：按钮高度与两侧 select 一致（.btn.mini 的 2px padding 比下拉矮一截；
   提一级特异性压过 theme.css 的 .btn.mini） */
.searchbar .btn.tb-src-btn { padding: 7px 10px; font-size: 12px; border-radius: 8px; }
/* `#278` 位置2：分类条独占一行 —— 1 个源也扩充占整行（cs-track 是 flex:1，容器给满宽即撑满） */
.src-bar-row { margin-top: 10px; width: 100%; }
.src-bar { width: 100%; }
.lim { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; flex: none; }
.sr-meta { display: flex; gap: 8px; align-items: center; margin-top: 8px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.flex1 { flex: 1; }
.status.err { color: var(--danger, #ef4444); }
.fail-list { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: var(--danger); line-height: 1.7; }
.fail-list code { color: var(--gold); }

/* 结果滚动容器：固定高度内滚，不撑高页面 */
.result-scroll { max-height: calc(100vh - 250px); overflow: auto; padding: 2px 4px 12px 2px; }

/* 聚合视图：类型分组头 */
.grp-head {
  display: flex; align-items: baseline; gap: 10px;
  margin: 14px 2px 8px; padding: 7px 12px;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px;
  position: sticky; top: 0; z-index: 2;
}
.grp-head b { font-size: 14px; }
.gh-n { font-size: 12px; color: var(--muted); }

/* `#279` a1：结果类型 tab（书籍/漫画/影视…），只渲染有结果的类型 */
.kind-tabs { display: flex; gap: 8px; margin: 2px 2px 10px; overflow-x: auto; }
.ktab {
  flex: none; display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 14px; border-radius: 9px; cursor: pointer; font-size: 13px;
  background: var(--bg-2); border: 1px solid var(--border); color: var(--muted);
  white-space: nowrap;
}
.ktab:hover { color: var(--text); }
.ktab.on { background: var(--brand-soft); border-color: var(--acc-dim); color: var(--brand); }
.kt-n { font-size: 11px; font-family: var(--mono); opacity: 0.78; }

/* 卡片封面悬浮操作条（`#276` 照抄发现页；`#277` 结果卡较小 ⇒ 双按钮**竖排**一上一下，
   靠右对齐不遮书名区） */
/* `#290` bug2（用户：信息较多时悬浮按钮脱离封面位置）：`.item-card`（theme.css:191）是
   display:flex 且默认 align-items:stretch ⇒ `.cover-wrap` 被拉伸到**卡片全高**（正文
   summary/来源行越多越高），`bottom:0` 的悬浮条便落在卡片底而不是封面底。`align-self`
   让 wrap 缩回封面内容自身的高度。聚合视图与单源视图共用本类，一并修。 */
.cover-wrap { position: relative; flex: none; border-radius: 10px; overflow: hidden; align-self: flex-start; }
.cover-actions {
  position: absolute; right: 0; bottom: 0;
  display: flex; flex-direction: column; gap: 5px; padding: 8px;
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.72), transparent);
  opacity: 0; transition: opacity 0.18s;
}
.item-card:hover .cover-actions { opacity: 1; }
.cover-btn {
  width: 72px; padding: 5px 0; border-radius: 7px; white-space: nowrap;
  border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(255, 255, 255, 0.12);
  color: #fff; font-size: 11px; cursor: pointer; backdrop-filter: blur(4px);
}
.cover-btn.primary { background: var(--brand); border-color: var(--brand); }
.cover-btn:hover { filter: brightness(1.15); }

/* 类型标签（书名后附加「书」） */
.kind-tag {
  display: inline-block; margin-left: 6px; padding: 0 6px;
  font-size: 11px; border-radius: 6px; line-height: 18px;
  background: var(--bg-3); color: var(--muted); border: 1px solid var(--border);
}

/* 来源 chip：源名 + 耗时（不是书名） */
.src-row { margin-top: 4px; }
.src-btn {
  display: inline-flex; align-items: center; gap: 5px;
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.src-btn em { font-style: normal; color: var(--muted); font-size: 11px; }
.src-btn .dot, .src-btn.as-span .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green, #22c55e); flex: none; }
.src-btn.as-span { cursor: default; }

/* 单源视图：1→3 列自适应网格 */
.single-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 2px 10px; padding: 9px 12px;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px;
  font-size: 12.5px;
  /* `#279` a3：工具条固定在滚动容器顶部，不随内容滚走（sticky 于最近滚动祖先 .result-scroll） */
  position: sticky; top: 0; z-index: 6;
}
.sh-q b { color: var(--text); }
.sh-meta { color: var(--muted); }
.single-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.sg-card { break-inside: avoid; }
.empty-sub { margin-top: 8px; font-size: 12px; color: var(--muted); }
.lnk { cursor: pointer; color: var(--acc, #4f8cff); text-decoration: underline; }
.load-sentinel { text-align: center; padding: 14px 0 6px; color: var(--muted); font-size: 12px; }

/* 候选源下拉面板（发现页分类条样式） */
.src-panel { position: relative; }
.btn.on { border-color: rgba(79, 140, 255, 0.55); color: var(--text); }
.src-popup {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 30;
  min-width: 300px; max-width: min(560px, calc(100vw - 48px));
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 12px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
  display: flex; flex-direction: column; overflow: hidden;
}
.sp-head { display: flex; justify-content: space-between; align-items: center; padding: 9px 13px; border-bottom: 1px solid var(--border); font-size: 13px; }
.sp-close { cursor: pointer; font-size: 19px; color: var(--muted); padding: 0 4px; line-height: 1; }
.sp-close:hover { color: var(--text); }
.sp-search { padding: 8px 13px; border-bottom: 1px solid var(--border); }
.sp-search input { width: 100%; height: 32px; border: 1px solid var(--border-strong); background: var(--bg-2); color: var(--text); border-radius: 8px; padding: 0 10px; font-size: 12.5px; outline: none; }
.sp-list { max-height: 46vh; overflow: auto; padding: 5px 4px; }
.sp-row {
  display: grid; grid-template-columns: 30px 12px 1fr auto auto auto;
  align-items: center; gap: 6px;
  padding: 6px 9px; border-radius: 8px; font-size: 12.5px; cursor: pointer;
}
.sp-row:hover { background: var(--bg-2); }
.sp-row.on { background: linear-gradient(135deg, rgba(79, 140, 255, 0.18), rgba(160, 112, 255, 0.18)); }
.sp-row .r-idx { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: center; background: var(--bg-2); border-radius: 6px; padding: 2px 0; }
.sp-row .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.sp-row .dot.st-ok { background: var(--green, #22c55e); }
.sp-row .dot.st-dead { background: var(--danger, #ef4444); }
.sp-row .dot.st-pending { background: var(--gold, #d08700); animation: pulse 1s infinite alternate; }
.sp-row .dot.st-idle { opacity: 0.5; }
@keyframes pulse { from { opacity: 0.4; } to { opacity: 1; } }
.sp-row .r-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-row .r-n { color: var(--muted); font-size: 11px; }
.sp-row .r-ms { color: var(--muted); font-size: 11px; font-family: var(--mono); }
.sp-row .r-on { color: var(--green, #22c55e); font-size: 11px; font-weight: 600; }
.sp-empty { text-align: center; color: var(--muted); padding: 16px 10px; font-size: 12px; }
.fade-enter-active, .fade-leave-active { transition: opacity 120ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
