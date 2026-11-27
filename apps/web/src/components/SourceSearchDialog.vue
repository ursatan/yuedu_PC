<script setup lang="ts">
/**
 * `#287` **源搜索浮层**（源管理 / 发现页共用 —— 用户 2026-10-05：「搜索界面（浮层）…和发现页
 * 展示效果相同(复用)」）。
 *
 * ## 形态
 * 输入框 + 搜索按钮 + 结果封面卡片网格 + ⟳ 刷新（重新拉取搜索结果）。
 * 卡片 = 发现页同款：封面（悬浮浮现「ⓘ 详情 / ▶ 阅读·播放」）+ 下方三行信息
 * ①书名 ②作者（影视：分类）③最新章节（影视：最新集）—— 字段出处与发现页一致
 * （`payload.author` / `payload.lastChapter`，⚠️ 不是 `it.author`，见 `utils/list-item.ts`）。
 *
 * ## 搜索范围 = 调用方给的源白名单
 * 服务端 `/api/aggregate/search` 的 `sourceIds` 白名单（`#273`）。调用方决定范围：
 * · 源管理：当前筛选后的源列表（`shownSources`）；· 发现页：左栏当前筛选的源。
 * ★ 白名单**截前 30 个**（原换源搜索同口径 —— 几百个源全量跑要等几分钟；截前 30 个 =
 *  `#282` 排序后的列表头部）。范围在浮层标题行写明，不玩隐形截断。
 *
 * ## 归并
 * 结果按 dedupId 跨源合并（`utils/search-merge.ts` 纯函数，与搜索页同一份实现）——
 * 同一作品 30 个源命中只出一张卡，右上角标「N 源」。
 *
 * ## 会话隔离
 * 自己收 SSE 事件、本地归并，不碰 search store（与换源对话框同语义）。
 * ⚠️ 与换源弹窗的差别（用户 2026-10-05）：换源是「打开即搜」；本浮层**打开 = 全新会话**
 * （输入框/结果/页码全清），必须用户输入关键词、点搜索才发起 —— `#291`。
 * 翻页按「title+bookUrl」去重，全是重复条目 ⇒ 判到底（很多源不支持翻页，第 2 页原样回第 1 页）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  aggregateSearch,
  getSearchHistory,
  recordSearchHistory,
  deleteSearchHistory,
  clearSearchHistory,
} from '../api';
import { aggregatePerSrc, type MergedHit, type RawSearchItem } from '../utils/search-merge';
import { itemAuthor, itemLastChapter } from '../utils/list-item';
import CoverImage from './CoverImage.vue';
import { useReaderStore } from '../stores/reader';
import { useVodStore } from '../stores/vod';

const props = defineProps<{
  open: boolean;
  /** 搜索范围：源 id 白名单（调用方按当前页筛选给） */
  scopeIds: string[];
  /** 范围说明（标题行展示，如「当前筛选 12 源」） */
  scopeLabel?: string;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const reader = useReaderStore();
const vod = useVodStore();

const MAX_SRCS = 30;
const kw = ref('');
const loading = ref(false);
const bySrc = ref<Record<string, RawSearchItem[]>>({});
const status = ref('');
/** 本轮是否已搜索过（控制空态/刷新按钮；打开浮层即重置 —— `#291` 全新会话） */
const searched = ref(false);
/** `#288` 发起搜索时的关键词（输入框随开随清，但空态/无结果文案还要引用它） */
const searchedKw = ref('');

const ids = computed(() => props.scopeIds.slice(0, MAX_SRCS));

// `#618` 聚合去重键恒含作者（对齐上游 `SearchModel.mergeItems` 的 `name + author` 判据）
const hits = computed<MergedHit[]>(() => aggregatePerSrc(bySrc.value, 200, { authorAware: true }));

/* ---------------- `#288` 搜索历史（**服务端**，跨端可用；平铺 chips + 单删 + 清空，参考上游 legado） ---------------- */
/** 旧版纯本地的键：首次加载时迁移到服务端，随后删除（一次性） */
const LEGACY_HISTORY_KEY = 'yuedu.srcSearchHistory';
const HISTORY_MAX = 20;
const history = ref<string[]>([]);
const histOpen = ref(false);

/** 拉服务端历史；本地旧数据只在服务端为空时迁一次（不覆盖已有多端数据） */
async function loadHistory(): Promise<void> {
  try {
    const list = await getSearchHistory(HISTORY_MAX);
    history.value = list.map((e) => e.word).slice(0, HISTORY_MAX);
    if (history.value.length) return;
    let legacy: string[] = [];
    try {
      const v = JSON.parse(localStorage.getItem(LEGACY_HISTORY_KEY) ?? '[]') as unknown;
      legacy = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_MAX) : [];
    } catch { legacy = []; }
    if (!legacy.length) return;
    // 旧数组是「新→旧」；从旧到新写，服务端按 lastUseTime 排序后才不会倒过来
    for (const word of [...legacy].reverse()) {
      try { await recordSearchHistory(word); } catch { return; }
    }
    history.value = legacy;
    try { localStorage.removeItem(LEGACY_HISTORY_KEY); } catch { /* ignore */ }
  } catch { /* 服务端不可用：保留内存里的列表，搜索本身不受影响 */ }
}

function saveHistory(k: string): void {
  history.value = [k, ...history.value.filter((x) => x !== k)].slice(0, HISTORY_MAX);
  void recordSearchHistory(k).catch(() => { /* 记录失败不影响搜索 */ });
}
function delHistory(k: string): void {
  history.value = history.value.filter((x) => x !== k);
  void deleteSearchHistory(k).catch(() => { /* ignore */ });
}
function clearHistory(): void {
  history.value = [];
  void clearSearchHistory().catch(() => { /* ignore */ });
}
function pickHistory(k: string): void {
  histOpen.value = false;
  kw.value = k;
  void doSearch();
}
/** 点击外部收起历史面板（与 FilterDropdown 同模式；不在 input blur 上做，避开 IME 时序） */
const barEl = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent): void {
  if (!histOpen.value) return;
  const t = e.target;
  if (t instanceof Node && barEl.value?.contains(t)) return;
  histOpen.value = false;
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  void loadHistory();
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  // `#292` 组件被整个卸载（如从源管理切走路由）⇒ 同样中止搜索会话
  ac?.abort();
  ac = null;
  dropPending();
});

/* ---------------- `#288` 滚动到底自动加载下一页（发现页同款：IO 哨兵 + scroll 兜底 + 不足一屏自动续载） ---------------- */
/** 已拉到的页码（doSearch 归 1；loadNext 递增） */
const page = ref(0);
/** 还有下一页吗：本轮（page 请求）有 items 到达就认为可能有下一页；空轮 ⇒ false */
const hasMore = ref(false);
const loadingMore = ref(false);
/** 内容滚动容器（弹窗主体；IO root 指向它 —— 发现页踩过「root 必须是滚动容器本身」的坑） */
const bodyEl = ref<HTMLElement | null>(null);
const sentinelEl = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let loadingNext = false;

/** 条目身份 = title + payload.bookUrl（与 firstRaw 的匹配口径一致）。
 *  `#291`：很多书源的搜索规则不支持翻页，请求第 2 页会**原样回第 1 页的内容**——
 *  不去重的话「重复条目」也算有收获（got>0）⇒ 自动续载连拉数页、页码飙升而内容一行不涨。 */
function itemKey(it: RawSearchItem): string {
  return String(it['title'] ?? '') + '\u0000' + String((it['payload'] as Record<string, unknown> | undefined)?.['bookUrl'] ?? '');
}

/* ---------------- `#292` 渲染合批（修「搜索很卡」） ---------------- */
/**
 * items 事件**不逐条写响应式状态**，先攒进普通对象，120ms 提交一次（本轮收尾时再强刷一次）。
 *
 * 为什么必须合批：`bySrc` 是响应式的，`hits` 是从它算出来的 computed —— `aggregatePerSrc`
 * 要遍历**全部**已到条目。旧实现每收到一条 items 就 `bySrc.value[sid] = [...]`（整体换新对象），
 * 一次 30 源搜索会重算 + 重渲染**几十次**，条目越多单次越贵 ⇒ 事件数 × 条目数 的二次方开销，
 * 表现就是「搜索时界面一顿一顿」。
 *
 * ⚠️ `srcMs`（响应时间排序用的每源耗时）仍按**事件到达那一刻**记，不受合批影响 ——
 * 否则排序信号会被加上最多 `FLUSH_MS` 的假延迟，把「哪个源快」判错。
 */
let pending: Record<string, RawSearchItem[]> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 120;
/** 立即把缓冲提交到响应式状态（本轮结束/关闭会话时必须调，否则最后一批结果看不到） */
function flushNow(): void {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  const p = pending;
  pending = {};
  const keys = Object.keys(p);
  if (!keys.length) return;
  const next = { ...bySrc.value };
  for (const sid of keys) next[sid] = [...(next[sid] ?? []), ...(p[sid] ?? [])];
  bySrc.value = next;
}
function dropPending(): void {
  pending = {};
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
}
function pushItems(sid: string, arr: RawSearchItem[]): void {
  if (!arr.length) return;
  (pending[sid] ??= []).push(...arr);
  if (flushTimer === null) flushTimer = setTimeout(flushNow, FLUSH_MS);
}

/**
 * `#292` 当前搜索会话的中止句柄。
 * · 关闭浮层 / 发起新搜索 ⇒ `abort()`：本会话**未开始**的源不再搜（服务端 `res.close → abort`
 *   后，facade 的 worker 循环会在下一个源之前退出）。
 * · 这也回答「关掉浮层再点另一个源搜索，前一个会干扰吗」：会 —— 旧代码里前一发**照跑到底**，
 *   两波一起抢带宽。现在关掉即中止（已在途的那 ≤ concurrency 个源会跑完，见 facade 注释）。
 */
let ac: AbortController | null = null;
/**
 * `#292` 搜索会话序号。
 *
 * ⚠️ 为什么需要它（探针实测抓到的缺陷）：中止后 `doSearch` 的 `finally` 里
 * `if (ac === myAc) loading = false` **不成立**（关闭时已把 `ac` 置空）⇒ `loading` 卡在
 * `true` 不放。后果有两个，都很隐蔽：① 重开浮层一直显示「⏳ 正在搜索…」；
 * ② **搜索按钮 `:disabled="loading"` ⇒ 之后点搜索根本没反应**（用户会以为界面卡死）。
 * 用序号判定「我是不是最新那一次」才能安全收尾。
 */
let seq = 0;

async function loadNext(): Promise<void> {
  const k = searchedKw.value.trim();
  if (loadingNext || loading.value || !hasMore.value || !k || !ids.value.length) return;
  loadingNext = true;
  loadingMore.value = true;
  try {
    const nextPage = page.value + 1;
    let got = 0;
    await aggregateSearch(
      k,
      { sourceIds: ids.value, concurrency: 8, page: nextPage, signal: ac?.signal },
      (ev) => {
        if (ev.type === 'items') {
          const sid = String(ev.sourceId);
          // `#291` 只收「本源此前没见过的」条目；全是重复 ⇒ got=0 ⇒ 判到底。
          // ⚠️ 去重池必须把**还没提交的缓冲**也算上（`#292` 合批后 pending 里可能有上一批）
          const seen = new Set([...(bySrc.value[sid] ?? []), ...(pending[sid] ?? [])].map(itemKey));
          const fresh = ((ev.items ?? []) as RawSearchItem[]).filter((it) => !seen.has(itemKey(it)));
          got += fresh.length;
          pushItems(sid, fresh);
        }
      },
    );
    // `#291` 空轮（0 条新内容）⇒ 判到底且**页码不前进**（此前页码照加，
    // 出现「第 7 页却什么都没加载」的假页码）
    if (got > 0) page.value = nextPage;
    else hasMore.value = false;
  } catch (e) {
    if (ac?.signal.aborted) return; // `#292` 主动中止不是错误
    status.value = '翻页出错：' + String(e instanceof Error ? e.message : e);
  } finally {
    flushNow();
    loadingMore.value = false;
    loadingNext = false;
  }
}

/** 内容不足一屏时自动续载（否则没有滚动条 ⇒ 哨兵永不触发）；上限 4 页防失控 */
let filling = false;
async function fillViewport(): Promise<void> {
  if (filling) return;
  filling = true;
  try {
    await nextTick();
    for (let guard = 0; guard < 4; guard++) {
      const el = bodyEl.value;
      if (!el || !hasMore.value || loadingMore.value) break;
      if (el.scrollHeight > el.clientHeight + 50) break; // 已有滚动条，交给用户滚动
      const before = Object.values(bySrc.value).reduce((n, a) => n + a.length, 0);
      await loadNext();
      const after = Object.values(bySrc.value).reduce((n, a) => n + a.length, 0);
      if (after === before) break;
    }
  } finally {
    filling = false;
  }
}
function bindObserver(): void {
  observer?.disconnect();
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.05)) void loadNext();
    }, { root: bodyEl.value ?? null, rootMargin: '400px 0px', threshold: [0.05, 0.2] });
  }
  if (sentinelEl.value) observer.observe(sentinelEl.value);
}
watch(sentinelEl, () => bindObserver(), { flush: 'post' });
/** scroll 事件兜底（发现页同款「scroll + IO 双保险」——headless / IO 未渲染帧时仍能翻页） */
function onBodyScroll(): void {
  const el = bodyEl.value;
  if (!el) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadNext();
}

watch(() => props.open, (open) => {
  // `#292` 会话收尾统一在这里：中止 + 序号自增（让在途 doSearch 的 finally 失效）+
  // 清掉三个「进行中」标志（否则 `loading` 卡住会把搜索按钮一直禁掉，见 `seq` 的注释）
  seq += 1;
  loading.value = false;
  loadingMore.value = false;
  loadingNext = false;
  if (!open) {
    histOpen.value = false;
    // `#292` 关闭 = 会话结束：中止未完成的搜索（否则它会一直跑下去，和下一次搜索抢带宽）
    ac?.abort();
    ac = null;
    dropPending();
    return;
  }
  // `#291`（用户 2026-10-05）：打开 = **全新会话** —— 输入框 / 结果 / 页码全部清空，
  // **绝不自动搜索**。此前「范围变了 ⇒ 用 searchedKw 自动重搜」是换源弹窗的语义
  //（换源是「打开即搜」），浮层不是换源：必须用户输入关键词、点搜索才发起。
  // 这同时修掉「换源后重开 ⇒ 自动对上一次的关键词发起搜索」的 bug。
  kw.value = '';
  dropPending();
  bySrc.value = {};
  page.value = 0;
  hasMore.value = false;
  searched.value = false;
  searchedKw.value = '';
  status.value = '';
  histOpen.value = false;
});

async function doSearch(): Promise<void> {
  // `#288` 输入框随开随清 ⇒ 「⟳ 刷新」在框空时回落到上次搜索的关键词（= 重新拉取本轮结果）
  const k = (kw.value.trim() || searchedKw.value).trim();
  if (!k || !ids.value.length) return;
  // `#292` 新搜索先中止上一次 + 丢弃上一轮未提交的缓冲（防串台）
  ac?.abort();
  const myAc = new AbortController();
  ac = myAc;
  const mySeq = ++seq;
  dropPending();
  loading.value = true;
  status.value = '搜索中…';
  searched.value = true;
  searchedKw.value = k;
  saveHistory(k); // `#288` 搜索历史
  histOpen.value = false;
  bySrc.value = {};
  page.value = 1;
  hasMore.value = false; // scan 终态后再按本轮收成判定
  let got = 0;
  try {
    await aggregateSearch(
      k,
      { sourceIds: ids.value, concurrency: 8, signal: myAc.signal },
      (ev) => {
        if (myAc.signal.aborted) return; // 已被新一轮/关闭取代 ⇒ 丢弃在途事件
        if (ev.type === 'items') {
          const sid = String(ev.sourceId);
          const arr = (ev.items ?? []) as RawSearchItem[];
          got += arr.length;
          pushItems(sid, arr);
        } else if (ev.type === 'scan') {
          loading.value = false; // scan = 终态事件
          status.value = '';
        }
      },
    );
    flushNow();
    // `#288` 有收成 ⇒ 可能还有下一页；收尾后做一次「不足一屏自动续载」
    hasMore.value = got > 0;
    void fillViewport();
  } catch (e) {
    flushNow();
    if (myAc.signal.aborted) return; // `#292` 主动中止（关窗/换关键词）不是错误
    status.value = '搜索出错：' + String(e instanceof Error ? e.message : e);
  } finally {
    if (seq === mySeq) loading.value = false; // `#292` 序号判「我还是不是最新那一次」
  }
}

/* ---------------- 卡片信息三行（与发现页同口径） ---------------- */
function tagsOf(it: RawSearchItem): string {
  return Array.isArray(it['tags']) ? (it['tags'] as unknown[]).map(String).join(' · ') : '';
}
function line2(it: RawSearchItem): string {
  if (String(it['kind']) === 'video') return tagsOf(it); // 影视 ②：分类
  const a = itemAuthor(it);
  if (a) return a;
  const sub = it['subtitle'] ? String(it['subtitle']).trim() : '';
  const l3 = line3(it);
  return sub && sub !== l3 ? sub : '';
}
function line3(it: RawSearchItem): string {
  if (String(it['kind']) === 'video') return it['subtitle'] ? String(it['subtitle']).trim() : ''; // 影视 ③：最新集
  return itemLastChapter(it);
}
/** 聚合卡的信息行取「第一个有数据的源」的原始条目（payload 里带 author/lastChapter） */
function firstRaw(hit: MergedHit): RawSearchItem {
  for (const r of hit.sources) {
    const arr = bySrc.value[r.sourceId];
    const it = arr?.find((x) => String(x['title'] ?? '') === r.title || String((x['payload'] as Record<string, unknown>)?.['bookUrl'] ?? '') === String((r.payload as Record<string, unknown>)?.['bookUrl'] ?? ''));
    if (it) return it;
  }
  return {};
}

/* ---------------- 打开详情 / 直接阅读（与搜索页同一套出口） ---------------- */
function openRef(r: MergedHit['sources'][number], kind: string): void {
  const it = { sourceId: r.sourceId, payload: r.payload, title: r.title, cover: r.cover, kind };
  if (kind === 'video') {
    vod.openDetail({ sourceId: r.sourceId, payload: r.payload, title: r.title, cover: r.cover });
    return;
  }
  /**
   * `#572` **文章类（RSS 单网址源）与发现页/搜索页统一为「直达阅读」**。
   *
   * 用户 2026-10-23 报「同一类源两套行为」：本浮层（发现页右栏的「⌕ 搜索」）此前用
   * `reader.openDetail` ⇒ 先铺详情页（自动选中目录项）再切正文；而发现页卡片走
   * `readFirstDirect` 直达。订阅源没有「详情页」这个中间态（上游 `ReadRssActivity`
   * 点文章就是直接进正文）⇒ 与 `#356`/`#572` 同一判据：`kind === 'article'` 直达。
   */
  if (kind === 'article') {
    void reader.readFirstDirect(r.sourceId, it);
    return;
  }
  reader.openDetail(r.sourceId, it);
}
function openMerged(hit: MergedHit, ref0?: MergedHit['sources'][number]): void {
  const r = ref0 ?? hit.sources[0];
  if (r) openRef(r, hit.kind);
}
function readMergedFirst(hit: MergedHit): void {
  const r = hit.sources[0];
  if (!r) return;
  if (hit.kind === 'video') { openRef(r, hit.kind); return; }
  // `#572` 文章类直达（与 `openRef` 同一口径：订阅源没有详情页中间态）
  if (hit.kind === 'article') {
    void reader.readFirstDirect(r.sourceId, { sourceId: r.sourceId, payload: r.payload, title: r.title, cover: r.cover, kind: hit.kind });
    return;
  }
  void reader.readFirst(r.sourceId, { sourceId: r.sourceId, payload: r.payload, title: r.title, cover: r.cover, kind: hit.kind });
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>⌕ 搜索</b>
        <span class="sub">{{ scopeLabel || `对 ${ids.length} 个源搜索` }}<template v-if="ids.length < scopeIds.length">（取列表前 {{ MAX_SRCS }} 个）</template></span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <!-- `#288` 搜索栏：历史面板（点输入框弹出，平铺 chips + 单删 + 清空） -->
      <div ref="barEl" class="ss-bar">
        <div class="kw-wrap">
          <input
            v-model="kw"
            class="kw"
            placeholder="输入书名 / 片名，Enter 发起搜索"
            @keyup.enter="doSearch"
            @focus="histOpen = true"
            @click="histOpen = true"
          />
          <div v-if="histOpen && history.length" class="hist-panel">
            <div class="hist-head">
              <b>搜索历史</b>
              <button class="hist-clear" @click="clearHistory">清空历史</button>
            </div>
            <div class="hist-chips">
              <span v-for="k in history" :key="k" class="hist-chip" :title="'搜索「' + k + '」'" @click="pickHistory(k)">
                {{ k }}
                <i class="hist-x" title="删除该条" @click.stop="delHistory(k)">×</i>
              </span>
            </div>
          </div>
        </div>
        <!-- `#292` 搜索中**不禁用**搜索按钮（`#295` 修正）。
             点它 = 中止当前搜索并立刻重开一发（`doSearch` 里 `ac?.abort()` + `seq` 自增已实现
             「后发取代先发」）。为什么不禁用：搜索挂在某个慢源上时可能几十秒不出结果，
             按钮一灰用户就**没有任何中止手段**，只能关掉浮层重开；而「按钮点不动」这个
             **症状**与 `#292` 修掉的「`loading` 卡死 ⇒ 按钮永久禁掉」**完全一样**，
             用户分不出是「忙」还是「坏了」。禁用只换来「防连点」，代价是丢掉中止能力。 -->
        <button
          class="btn primary"
          :title="loading ? '正在搜索：点击可中止当前搜索并重新搜索' : '搜索'"
          @click="doSearch"
        >{{ loading ? '⏳ 搜索中…' : '⌕ 搜索' }}</button>
        <button class="btn" :disabled="!searched" title="用当前输入的关键词重新搜索" @click="doSearch">⟳ 刷新</button>
      </div>

      <div ref="bodyEl" class="dlg-body" @scroll.passive="onBodyScroll">
        <div v-if="status" class="hint" :class="{ err: status.startsWith('搜索出错') || status.startsWith('翻页出错') }">{{ status }}</div>
        <div v-if="loading && !hits.length" class="hint">⏳ 正在搜索…</div>
        <div v-else-if="searched && !hits.length" class="hint">没有命中「{{ searchedKw }}」。</div>
        <div v-else-if="!searched" class="hint">输入关键词开始搜索（范围：{{ scopeLabel || `${ids.length} 个源` }}）。</div>

        <!-- 结果网格：发现页同款封面卡片（悬浮 详情/阅读 + 三行信息） -->
        <div v-else class="poster-grid">
          <div v-for="(hit, i) in hits" :key="hit.dedupId" class="pcard">
            <div class="poster-wrap" @click="openMerged(hit)">
              <CoverImage
                class="poster"
                :cover="String(hit.cover ?? '')"
                :source-id="String(hit.sources[0]?.sourceId ?? '')"
                :title="hit.title"
                :author="line2(firstRaw(hit))"
                :index="i"
              />
              <div class="cover-actions">
                <button class="cover-btn ghost" @click.stop="openMerged(hit)">ⓘ 详情</button>
                <button class="cover-btn primary" @click.stop="readMergedFirst(hit)">
                  ▶ {{ hit.kind === 'video' ? '播放' : '阅读' }}
                </button>
              </div>
            </div>
            <div class="pc-title" :data-tip="hit.title" @click="openMerged(hit)">
              {{ hit.title }}
              <span v-if="hit.sources.length > 1" class="tag acc">{{ hit.sources.length }} 源</span>
            </div>
            <div class="pc-line2" :data-tip="line2(firstRaw(hit))">{{ line2(firstRaw(hit)) }}</div>
            <div class="pc-line3" :data-tip="line3(firstRaw(hit))">{{ line3(firstRaw(hit)) }}</div>
          </div>
        </div>

        <!-- `#291`（用户 2026-10-05）：对齐发现页——**没有「加载下一页」按钮**，全自动：
             不足一屏 fillViewport 主动续载填满可视区，之后滚动/IO 触底续载（去重后空轮判到底）。
             这里只留「加载中」提示；到底后显示「已到底（共 N 页）」。 -->
        <div v-if="hits.length && hasMore && loadingMore" class="load-more">
          <span class="hint">⏳ 正在加载下一页…</span>
        </div>
        <div v-if="hits.length && !hasMore && page > 1" class="hint" style="text-align: center">已到底（共 {{ page }} 页）</div>
        <div v-if="hits.length && hasMore" ref="sentinelEl" class="load-sentinel"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 6vh 16px; overflow: auto;
}
.dlg { width: min(920px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px;
}
.dlg-head .sub { color: var(--muted); font-size: 12px; }
.ss-bar { display: flex; gap: 8px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); }
.ss-bar .kw { flex: 1; padding: 8px 12px; font-size: 13px; }
/* `#288` 历史面板（点输入框弹出；上游 legado 同思路：平铺 chips + 单删 + 清空） */
.kw-wrap { flex: 1; position: relative; min-width: 0; }
.kw-wrap .kw { width: 100%; }
.hist-panel {
  position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 5;
  background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; box-shadow: var(--shadow);
}
.hist-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; font-size: 12.5px; }
.hist-clear { border: none; background: none; color: var(--muted); font-size: 12px; cursor: pointer; }
.hist-clear:hover { color: var(--danger, #ef4444); }
.hist-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.hist-chip {
  display: inline-flex; align-items: center; gap: 5px;
  max-width: 220px; padding: 4px 6px 4px 10px; border-radius: 8px;
  background: var(--bg-2); border: 1px solid var(--border);
  font-size: 12.5px; cursor: pointer; overflow: hidden; white-space: nowrap;
}
.hist-chip:hover { border-color: var(--acc-dim); }
.hist-x {
  font-style: normal; width: 16px; height: 16px; line-height: 14px; text-align: center;
  border-radius: 50%; background: var(--bg-3); color: var(--muted); font-size: 12px; flex: none;
}
.hist-x:hover { background: var(--danger, #ef4444); color: #fff; }
/* `#288` 触底加载区 */
.load-more { text-align: center; padding: 12px 0 4px; }
.load-sentinel { height: 1px; }
.dlg-body { padding: 12px 16px; max-height: 68vh; overflow: auto; }
.hint { font-size: 12.5px; color: var(--muted); padding: 6px 0; }
.hint.err { color: var(--danger, #ef4444); }

/* 封面卡片网格（与发现页 .poster-grid 同构：多列自适应） */
.poster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 14px 12px; }
.pcard { min-width: 0; }
.poster-wrap { position: relative; cursor: pointer; }
.poster {
  width: 100%; aspect-ratio: 3 / 4; object-fit: cover; border-radius: 8px; display: block;
  /* ★ `#292` 必须写 `background-color` **长写**，不能写 `background` 简写。
     简写会把 `background-size`/`background-position` 重置成 `auto`/`0% 0%`，
     而生成封面的底图缩放正是靠 `CoverImage` 里 `.cv-gen { background-size: cover }` 做的
     （那条是 scoped 样式，编译后与这里同为 (0,2,0) 特异性 ⇒ **谁在样式表里靠后谁赢**）。
     一旦简写写在这里，底图就退回**原始尺寸**（内置默认封面 600×900）绘制，
     表现就是用户实测的「默认占位封面只显示了图片的左上角一小块」。
     ⚠️ `styles/theme.css` 的 `.poster`/`.item-card .cover` 早有同一条血泪注释（`#186`），
        这里是第三次踩同一个坑 —— 新写封面容器样式时**一律用长写**。 */
  background-color: var(--bg-2);
}
.pc-title {
  margin-top: 6px; font-size: 12.5px; font-weight: 600; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.pc-line2, .pc-line3 {
  font-size: 11.5px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 悬浮操作条：与发现页 / 搜索页卡片同款（封面底部渐变条 + 双按钮） */
.cover-actions {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  display: flex; gap: 6px; justify-content: center;
  padding: 22px 4px 6px; border-radius: 0 0 8px 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
  opacity: 0; transition: opacity 0.15s ease;
}
.poster-wrap:hover .cover-actions { opacity: 1; }
.cover-btn {
  flex: 1; max-width: 88px; padding: 4px 0; font-size: 11.5px;
  border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(20, 20, 20, 0.55); color: #fff; cursor: pointer;
}
.cover-btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
</style>
