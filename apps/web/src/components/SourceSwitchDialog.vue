<script setup lang="ts">
/**
 * `#274` **换源对话框**（参考 OmniFlow `SourceSwitchDialog.vue`，结构适配本仓）。
 * `#286` **界面重构**（用户 2026-10-05）：
 * · **分组筛选**：换分组 = 对该分组内的源重新发起搜索（默认搜索在弹窗打开时已发起）；
 * · **☑ 校验作者**：聚合时把作者并进 dedup key —— 「同名书但作者不是一个人」拆成不同卡，
 *   各源 chip 上直接显示作者，同名不同作者一眼可辨；
 * · **☑ 按响应时间排序**：卡片按「源出结果耗时」升序（快的在前）——
 *   搜索阶段引擎**不返回更新时间戳**（legado/maccms 列表项都没有时间字段），响应速度是
 *   换源场景下最接近「哪个源更好用」的可排序信号；卡内 chip 显示最新章节文本可肉眼比对更新；
 * · **⟳ 重新搜索**：对当前分组内的源重新搜索；
 * · **结果卡**：聚合卡内每源一枚 chip =「源名称 · 作者 · 最新章节」；点 chip 走既有
 *   `reader.switchBookSource`（进同名章节，找不到回落第一章 —— 复用 #274 逻辑）。
 *
 * ## 与全局搜索的关系 —— **会话隔离**
 * 自己收 SSE 事件、本地 `bySrc` 归并，**不碰** search store 的任何状态
 * （OmniFlow `runSearchScoped` 同语义：弹窗搜索不污染全局搜索会话）。
 *
 * ## 限定同类源
 * 只搜当前类型（book/video 互不串源）—— 换源必须换到「能打开同一种详情」的源。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { aggregateSearch } from '../api';
import { aggregatePerSrc, itemAuthorKey, type MergedHit, type RawSearchItem } from '../utils/search-merge';
import { useSourcesStore } from '../stores/sources';
import { matchSourceGroup, sourceGroupOptions } from '../source-groups';
// `#310`「能不能搜」判据唯一实现（能力门 hasSearch + 用户开关 + 源 enabled）
// `B6`：候选池按体检质量分排序，`dead` 未过期的源直接不进换源候选
import { searchableSources } from '../utils/search-scope';
import { effectiveSourceQuality } from '@yuedu/core/contract';
import SourceGroupFilter from './SourceGroupFilter.vue';

const props = defineProps<{
  open: boolean;
  /** 当前书类型（'book' | 'video'）—— 只搜同类源 */
  kind: string;
  currentSourceId: string;
  /** 用当前书的标题做关键词 */
  keyword: string;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'pick', payload: { sourceId: string; payload: unknown; title: string }): void;
}>();

const st = useSourcesStore();
const loading = ref(false);
const bySrc = ref<Record<string, RawSearchItem[]>>({});
/** 每源「出结果耗时」ms（该源首个 items 事件落地时刻 - 请求起点）；`#286` 响应时间排序用 */
const srcMs = ref<Record<string, number>>({});
/** 首次打开才开始搜（会话内保留结果，重开不重搜；换书/换分组/重新搜索才重搜） */
const searched = ref(false);
const searchedKw = ref('');

/**
 * ★ **item kind → 引擎 kind 映射**：服务端聚合搜索按**源**过滤，而源的 kind 是**引擎名**
 * （'demo' / 'legado' / 'maccms' —— 实测 `/api/sources`），不是 item 的 'book'/'video'。
 * ⚠️ 直接传 `kinds:['book']` 会过滤成空池 ⇒「没有其它源的版本」恒出现。
 */
const ENGINE_KINDS_BY_ITEM: Record<string, string[]> = {
  book: ['legado', 'demo'],
  video: ['maccms', 'demo'],
};

/* ---------------- `#286` 分组筛选 ---------------- */
/**
 * 同类源池（引擎过滤在服务端做；这里只取同类、**可搜索**的源供分组下拉计数）。
 *
 * `#310`（用户 2026-10-07 需求 ②）：判据换成 `utils/source-gate.ts` 的 `searchUsable` ——
 * 它比原来的 `enabled && searchEnabled` 多一道**能力门** `hasSearch`：
 * 「禁用搜索的源 / **没有搜索规则的源**，换源搜索都不应出现在源列表」。
 * 此前这里是手写的一份拷贝，与聚合搜索页那份已经漂移（那处也漏了能力门）。
 */
const pool = computed(() =>
  // `B6` `searchableSources` 内含能力门 + `dead` 跳过 + 质量分降序（与服务端同一判据）
  searchableSources(
    st.sources.filter((s) => (ENGINE_KINDS_BY_ITEM[props.kind] ?? [props.kind]).includes(s.kind)),
  ),
);
const groupOpts = computed(() => sourceGroupOptions(pool.value, { includeUngrouped: true }));
/** `''` = 全部分组；换分组 ⇒ 对该分组内的源重新搜索（watch） */
const groupSel = ref('');
/**
 * ★ 本次要搜的源：分组筛过后的**前 N 个**（原 openSwitch 实现就是 limit 30，全量跑要等几分钟）。
 * `#289`（用户 2026-10-05 问「这个 30 的修改接口在哪里」）⇒ 提为控制行下拉：
 * 10/20/30/50/100/全部，改了即对当前分组重搜。
 */
const maxSrcs = ref(30);
const targetIds = computed(() => {
  const ids = pool.value.filter((s) => matchSourceGroup(s, groupSel.value)).map((s) => s.id);
  return maxSrcs.value >= 9999 ? ids : ids.slice(0, maxSrcs.value);
});

const authorAware = ref(false); // ☑ 校验作者：作者并进 dedup key
const byMs = ref(false); // ☑ 按响应时间排序（快的在前）

/** `B6` 源质量分（换源候选卡内多源顺序 + 同档次要排序） */
function srcQuality(id: string): number {
  return effectiveSourceQuality(st.sources.find((s) => s.id === id)?.health);
}
const hits = computed<MergedHit[]>(() =>
  aggregatePerSrc(bySrc.value, 200, { authorAware: authorAware.value, sourceQuality: srcQuality }),
);
/** `#286` 按响应时间排序：卡片取其各源里最快的 ms 升序（没量到的排最后，保持原序兜底） */
const sortedHits = computed<MergedHit[]>(() => {
  if (!byMs.value) return hits.value;
  const fastest = (h: MergedHit): number => {
    const ms = h.sources.map((s) => srcMs.value[s.sourceId]).filter((x): x is number => x !== undefined);
    return ms.length ? Math.min(...ms) : Number.POSITIVE_INFINITY;
  };
  return [...hits.value].sort((a, b) => fastest(a) - fastest(b));
});
/** 排除「只有当前源」的卡 —— 换不出别的源，列表里没意义 */
const switchable = computed(() => sortedHits.value.filter((h) => h.sources.some((s) => s.sourceId !== props.currentSourceId)));

watch(() => props.open, (open) => {
  // `#292` 会话收尾：序号自增让在途请求的 finally 失效 + 清掉 loading
  //（否则关闭时中止后 `loading` 会卡在 true，重开一直转圈；同 SourceSearchDialog 的注释）
  seq += 1;
  loading.value = false;
  // `#286` 换了书（keyword 变）⇒ 旧结果是别的书的，必须重搜；同书重开沿用会话
  if (open && (!searched.value || searchedKw.value !== props.keyword)) void doSearch();
  // `#292` 关闭 = 会话结束：中止未完成的搜索（旧代码里它会**照跑到底**，与下一次搜索抢带宽，
  // 用户实测「换源搜索很卡」有一部分就是它）。换源弹窗与搜索浮层同属一类，一并修。
  if (!open) { ac?.abort(); ac = null; dropPending(); }
});
/** 换分组 = 对该分组内的源重新发起搜索（用户 2026-10-05 明确要求） */
watch(groupSel, () => { if (props.open) void doSearch(); });
/** `#289` 改搜索源数 = 范围变了 ⇒ 已搜过就重搜（同换分组的语义） */
watch(maxSrcs, () => { if (props.open && searched.value) void doSearch(); });

/* ---------------- `#292` 渲染合批 + 可中止（与 SourceSearchDialog 同一套，理由见那边注释） ----------------
 * 换源是 30 源 × 每条源多个 items 的搜索，逐条写响应式状态会让归并 computed 反复全量重算。 */
let pending: Record<string, RawSearchItem[]> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 120;
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
/** `#292` 当前搜索会话的中止句柄 + 序号（见 SourceSearchDialog 里 `seq` 的注释） */
let ac: AbortController | null = null;
let seq = 0;
onBeforeUnmount(() => { seq += 1; ac?.abort(); ac = null; dropPending(); });

async function doSearch(): Promise<void> {
  if (!props.keyword.trim() || !targetIds.value.length) return;
  // `#292` 新搜索先中止上一次 + 丢弃上一轮缓冲（换分组/改源数会连续触发，不能串台）
  ac?.abort();
  const myAc = new AbortController();
  ac = myAc;
  const mySeq = ++seq;
  dropPending();
  loading.value = true;
  searched.value = true;
  searchedKw.value = props.keyword;
  bySrc.value = {};
  srcMs.value = {};
  const t0 = Date.now();
  try {
    await aggregateSearch(
      props.keyword.trim(),
      // ★ 源白名单 = 分组筛过后的同类源（前 30）。白名单模式服务端跳过 limit 截断（`#273`）。
      // ★ `#292` 并发 8→4：这是本仓唯一的「网络护栏」（facade 侧 `limit = concurrency`）。
      //   30 个源 × 8 并发会把上行带宽和连接数打满、连浏览其它页面都变卡；
      //   降到 4 后总耗时变化不大（瓶颈是慢源），但界面明显更顺。
      { kinds: ENGINE_KINDS_BY_ITEM[props.kind] ?? [props.kind], sourceIds: targetIds.value, concurrency: 4, signal: myAc.signal },
      (ev) => {
        if (myAc.signal.aborted) return; // 已被新一轮/关闭取代 ⇒ 丢弃在途事件
        if (ev.type === 'items') {
          const sid = String(ev.sourceId);
          if (srcMs.value[sid] === undefined) srcMs.value[sid] = Date.now() - t0;
          pushItems(sid, (ev.items ?? []) as RawSearchItem[]);
        } else if (ev.type === 'scan') {
          loading.value = false; // scan = 终态事件
        }
      },
    );
  } catch {
    /* `#292` 中止（关闭/重搜）或出错 ⇒ 静默；loading 由 finally 收 */
  } finally {
    flushNow();
    if (seq === mySeq) loading.value = false; // `#292` 序号判「我还是不是最新那一次」
  }
}

/** 源显示名（源列表维护的唯一名字；chip 上第一行就是它 —— 用户 2026-10-05 要求） */
function srcName(id: string): string {
  return st.sources.find((s) => s.id === id)?.name || id;
}
/** chip 上该源的作者 / 最新章节（搜索阶段引擎写在 payload：legado `engine.ts` 列表阶段两字段都带） */
function refAuthor(r: MergedHit['sources'][number]): string {
  const p = r.payload;
  return p && typeof p === 'object' ? String((p as Record<string, unknown>)['author'] ?? '').trim() : '';
}
function refLast(r: MergedHit['sources'][number]): string {
  const p = r.payload;
  return p && typeof p === 'object' ? String((p as Record<string, unknown>)['lastChapter'] ?? '').trim() : '';
}
function refMs(r: MergedHit['sources'][number]): number | undefined {
  return srcMs.value[r.sourceId];
}

function pick(hit: MergedHit, ref0: MergedHit['sources'][number]): void {
  emit('pick', { sourceId: ref0.sourceId, payload: ref0.payload, title: ref0.title || hit.title });
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>换源</b>
        <span class="sub">同类源搜索「{{ keyword }}」· 同作品多源归并 · 点源名切换</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <!-- `#286` 控制行：分组筛选（换组重搜）+ 两个复选框 + 源数（#289 可调）+ 重新搜索
          （`#289`：按钮文案从「⟳ 刷新」改回「⟳ 重新搜索」——更符合交互逻辑，用户 2026-10-05） -->
      <div class="sw-ctrl">
        <SourceGroupFilter
          v-model="groupSel"
          :options="groupOpts"
          :all-count="pool.length"
          :shown-count="targetIds.length"
          label="分组"
          pop-title="换源分组"
        />
        <label class="sw-ck" title="同名书但作者不是一个人的，拆成不同卡（并进归并判据）">
          <input v-model="authorAware" type="checkbox" /> 校验作者
        </label>
        <label class="sw-ck" title="按各源出结果的耗时的升序排卡（快的在前）">
          <input v-model="byMs" type="checkbox" /> 按响应时间
        </label>
        <span style="flex: 1"></span>
        <!-- `#289` 搜索源数可调（原硬编码 30；9999 = 不截断） -->
        <select v-model.number="maxSrcs" class="btn sm sw-n" title="对分组内前 N 个源发起搜索（全量跑要等几分钟）">
          <option :value="10">前 10 源</option>
          <option :value="20">前 20 源</option>
          <option :value="30">前 30 源</option>
          <option :value="50">前 50 源</option>
          <option :value="100">前 100 源</option>
          <option :value="9999">全部（{{ pool.length }}）</option>
        </select>
        <span class="sw-scope">对 {{ targetIds.length }} 个源搜索</span>
        <!-- `#295` 同 `SourceSearchDialog`：搜索中**不禁用**重新搜索按钮（点它 = 中止当前这一发
             并立刻重开）。禁用会让「慢源挂住」时的用户没有中止手段，且症状与
             `#292` 修掉的「`loading` 卡死 ⇒ 按钮永久禁掉」无法区分。 -->
        <button
          class="btn sm"
          :title="loading ? '正在搜索：点击可中止当前搜索并重新搜索' : '对当前分组内的源重新搜索'"
          @click="doSearch"
        >⟳ 重新搜索</button>
      </div>

      <div class="dlg-body">
        <div v-if="loading && !switchable.length" class="hint">⏳ 正在跨源搜索同类源…</div>
        <div v-else-if="!switchable.length" class="hint">没有其它源的版本（当前源可能已是唯一命中）</div>

        <div v-for="hit in switchable" :key="hit.dedupId" class="sw-card">
          <div class="sw-title">
            {{ hit.title }}
            <span class="tag acc">{{ hit.sources.length }} 源</span>
          </div>
          <!-- `#286` 每源一枚 chip = 源名称 · 作者 · 最新章节（+响应 ms）；点 chip 切到该源 -->
          <div class="sw-refs">
            <button
              v-for="(r, i) in hit.sources" :key="r.sourceId + '|' + i"
              class="sw-chip" :class="{ cur: r.sourceId === currentSourceId }"
              :disabled="r.sourceId === currentSourceId"
              :title="r.sourceId"
              @click="pick(hit, r)"
            >
              <b class="sw-nm">{{ srcName(r.sourceId) }}<template v-if="r.sourceId === currentSourceId">（当前）</template></b>
              <span v-if="refAuthor(r)" class="sw-ln">{{ refAuthor(r) }}</span>
              <span v-if="refLast(r)" class="sw-ln">最新：{{ refLast(r) }}</span>
              <em v-if="refMs(r) !== undefined" class="sw-ms">{{ refMs(r) }}ms</em>
            </button>
          </div>
        </div>
      </div>

      <div class="dlg-foot">
        <!-- `#286` 复选框行已有 ⟳ 刷新（= 原来的「重新搜索」，用户指出功能重叠）⇒ 底部只留关闭 -->
        <button class="btn sm ghost" @click="emit('close')">关闭</button>
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
.dlg { width: min(760px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px;
}
.dlg-head .sub { color: var(--muted); font-size: 12px; }
/* `#286` 控制行：分组筛选 + 复选框 + 重新搜索（与对话框头分开，body 只放结果） */
.sw-ctrl {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
}
.sw-ck { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--text); cursor: pointer; white-space: nowrap; }
.sw-scope { font-size: 12px; color: var(--muted); white-space: nowrap; }
.dlg-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; max-height: 60vh; overflow: auto; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.hint { font-size: 12px; color: var(--muted); }
.sw-card { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.sw-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.sw-refs { display: flex; gap: 6px; flex-wrap: wrap; }
/* `#286` 源 chip：两行（源名 / 作者·最新章节）+ 右下角响应 ms */
.sw-chip {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  max-width: 220px; padding: 5px 9px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-2); cursor: pointer;
  text-align: left; font-size: 12px; color: var(--text);
}
.sw-chip:hover:not(:disabled) { border-color: var(--brand); }
.sw-chip.cur { opacity: 0.55; cursor: default; }
.sw-nm { font-weight: 600; }
.sw-ln { font-size: 11.5px; color: var(--muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-ms { font-size: 10.5px; color: var(--muted); font-style: normal; }
</style>
