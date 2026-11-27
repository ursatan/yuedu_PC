<script setup lang="ts">
/**
 * VDetailOverlay —— 影视**详情浮窗**（原 `views/VDetailView.vue` 的浮窗化）。
 *
 * 用户要求：「影院发现页 → 点击内容卡片 → **浮窗**详情页 → 点击播放（选集）→ **浮窗**播放页」，
 * 与书籍详情页→阅读页同一套交互。原实现是 `router.push('/v-detail')` 整页跳转，
 * 会把影院发现页顶掉（用户说的「内嵌页效果」）。
 *
 * 挂在 MainLayout 根部、显隐由 `stores/vod.ts` 的 `detailOpen` 控制，
 * 与 `ReaderOverlay` / `PlayerOverlay` / `AudioPlayer` 同一形态。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { runAction, runDetailStream } from '../api';
import { useVodStore } from '../stores/vod';
import { usePlayerStore, type PlayItem } from '../stores/player';
import CoverImage from './CoverImage.vue'; /* `#163` 封面统一出口 */
import RichIntro from './RichIntro.vue';
import { useReaderStore, itemKey } from '../stores/reader';
import { imgSrc } from '../utils/img';
import { pushEscLayer } from '../utils/esc-layer';

const vod = useVodStore();
const player = usePlayerStore();
const reader = useReaderStore();

const loading = ref(false);
/**
 * `#684` **目录还在路上**（详情头部已渲染）。
 *
 * 用户要求「详情信息和目录信息分开回传、先完成先加载」，与阅读浮层的 `#512` 同一形态：
 * 服务端 `/api/run/stream` 在**目录开始解析前**推一帧 info（引擎 `ctx.onPartial`），
 * 这一帧只有标题/封面/作者/简介 —— 够渲染头部；选集区这时显示「目录加载中…」，
 * 而不是整页一个「加载中…」把详情也一起挡住。
 */
const tocPending = ref(false);
const errMsg = ref('');
/**
 * 详情返回体（`runAction(..., 'detail')` 的结果）。
 *
 * ⚠️ 为什么单独起个名字，而不是 `as NonNullable<typeof detail.value>`：
 * 那个写法在本仓**推断成了 `never`**（vue-tsc 报「Property 'title' does not exist on type 'never'」，
 * 即 `r.title` / `r.cover` 全部失类型）—— 显式类型既准确又能被读懂。
 */
interface VodDetail {
  title?: string; cover?: string; subtitle?: string; summary?: string;
  tags?: string[]; meta?: Record<string, string>;
  chapters?: Array<{ title: string; payload: unknown }>;
}
const detail = ref<VodDetail | null>(null);

const session = computed(() => vod.detail);
const episodes = computed(() => detail.value?.chapters ?? []);
// 收藏态按「源 + 影视标识」判定（按剧名会同名误判）
const inShelf = computed(() => {
  const s = session.value;
  return !!s && reader.hasInShelf(itemKey(s.sourceId, s.payload));
});

async function load(): Promise<void> {
  const s = session.value;
  if (!s) return;
  loading.value = true;
  errMsg.value = '';
  detail.value = null;
  tocPending.value = false;
  const id = JSON.stringify(s.payload ?? {});
  try {
    /**
     * `#684` 先拿「只有详情」的那一帧：到了就把头部铺出来（`loading` 归 false），
     * 目录继续在后台解析，`done` 帧到了再补选集。流式不可用时回退到普通请求。
     */
    let r: VodDetail;
    try {
      r = (await runDetailStream(s.sourceId, id, (info) => {
        const d = info as VodDetail;
        detail.value = { ...d, ...(d.chapters?.length ? { chapters: d.chapters } : {}) };
        tocPending.value = true;
        loading.value = false;
      })) as VodDetail;
    } catch {
      r = (await runAction(s.sourceId, 'detail', { id })) as VodDetail;
    }
    tocPending.value = false;
    detail.value = r;
    // 观影历史只在**真正起播**时记录（见 `stores/player.ts` 的 `playAt`）。
    // 打开详情只是浏览：删掉的历史记录不能因为「再看一眼详情」就被重建。
    // 影视库「▶ 播放 / 续播」：详情到位后直接起播（按线路名 + 集标题定位，见 VodDetailSession.autoPlay）
    if (s.autoPlay) {
      const li = Math.max(0, lines.value.findIndex((l) => l.name === s.autoPlay?.line));
      const eps = lines.value[li]?.episodes ?? [];
      const ei = eps.findIndex((e) => e.title === s.autoPlay?.ep);
      playAt(li, ei < 0 ? 0 : ei);
    }
  } catch (e) {
    errMsg.value = '详情加载失败：' + String(e instanceof Error ? e.message : e);
  } finally {
    loading.value = false;
  }
}

// 浮窗打开时加载（会话变了也重载）—— 不用 onMounted：组件常驻，只显隐
watch(
  () => [vod.detailOpen, session.value?.sourceId, session.value?.payload] as const,
  ([open]) => {
    if (open) void load();
  },
  { immediate: true },
);

// ---- 多线路分组（payload.from；m3u8 线路优先） ----
interface EpLine {
  name: string;
  isM3u8: boolean;
  episodes: PlayItem[];
}
const lines = computed<EpLine[]>(() => {
  const map = new Map<string, EpLine>();
  for (const ch of detail.value?.chapters ?? []) {
    const p = (ch.payload ?? {}) as Record<string, unknown>;
    const name = String(p['from'] ?? '默认线路');
    if (!map.has(name)) map.set(name, { name, isM3u8: /m3u8/i.test(name), episodes: [] });
    map.get(name)!.episodes.push({ title: ch.title, payload: ch.payload });
  }
  const list = [...map.values()];
  // m3u8 线路排最前，其余保持原顺序
  return list.sort((a, b) => Number(b.isM3u8) - Number(a.isM3u8));
});
const activeLine = ref(0);
const curLine = computed(() => lines.value[activeLine.value] ?? null);

/** 点选集 → 交给播放浮窗（不再跳整页） */
function playAt(lineIdx: number, epIdx = 0): void {
  const line = lines.value[lineIdx];
  const s = session.value;
  if (!line || !s) return;
  activeLine.value = lineIdx;
  player.openSession({
    mode: 'play',
    sourceId: s.sourceId,
    title: detail.value?.title ?? s.title,
    subtitle: line.name,
    ...((detail.value?.cover ?? s.cover) ? { cover: detail.value?.cover ?? s.cover } : {}),
    items: line.episodes,
    index: epIdx,
    vodPayload: s.payload ?? {},
  });
}

/**
 * ③-1 **选集筛选 + 正序/倒序**（用户实测：几百集的剧集很需要；线条数多时也更好定位）。
 *
 * ⚠️ 与阅读浮层的目录同一个坑：`playAt(activeLine, i)` 要的是**线路内原始下标**
 * （它直接当 `player.openSession` 的 `index` 用），所以展示列表要带 `i`，
 * 模板用 `i` 而不是 `v-for` 的下标，否则筛选后点第 1 集可能播成别的集。
 */
const epFilter = ref('');
const epDesc = ref(false);
const shownEps = computed(() => {
  const eps = curLine.value?.episodes ?? [];
  const kw = epFilter.value.trim().toLowerCase();
  const idx = eps.map((ep, i) => ({ ep, i }));
  const f = kw ? idx.filter(({ ep }) => String(ep.title ?? '').toLowerCase().includes(kw)) : idx;
  return epDesc.value ? f.slice().reverse() : f;
});

/** ③-2 重新拉取详情/线路/选集 */
const refreshing = ref(false);
async function reloadDetail(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await load();
  } finally {
    refreshing.value = false;
  }
}
function toggleFav(): void {
  const s = session.value;
  if (!s) return;
  // 借用 reader 的书架逻辑（video 条目进影视收藏）
  reader.openDetail(s.sourceId, { payload: s.payload, title: s.title, cover: s.cover, kind: 'video' });
  setTimeout(() => reader.toggleShelf(), 0);
  setTimeout(() => reader.close(), 0);
}
function metaLine(): string {
  const m = detail.value?.meta ?? {};
  return Object.entries(m)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}：${v}`)
    .join(' · ');
}

/**
 * Esc 关闭 —— `#459` 改走**共享 Esc 栈**（`utils/esc-layer`），与 `PlayerOverlay` / `ReaderOverlay`
 * 同一份实现：谁后开谁在栈顶，一次 Esc 只退当前层。
 * 旧实现靠探测 `.pl-mask` / `.se-mask` 让位，多一层就漏（见 `utils/esc-layer.ts` 的说明）。
 */
let popEsc: (() => void) | null = null;
watch(
  () => vod.detailOpen && !!session.value,
  (on) => {
    if (on && !popEsc) popEsc = pushEscLayer(() => vod.closeDetail());
    else if (!on && popEsc) { popEsc(); popEsc = null; }
  },
  { immediate: true },
);
onBeforeUnmount(() => { popEsc?.(); popEsc = null; });
</script>

<template>
  <!-- `#459`：去掉「点遮罩关闭」—— 只能由「关闭」按钮 / Esc（且只退当前层）关闭 -->
  <div v-if="vod.detailOpen && session" class="vd-mask">
    <div class="vd-panel">
      <div class="vd-head">
        <strong>{{ detail?.title ?? session.title }}</strong>
        <!-- `#441` ⚠️ **总集数 = 当前线路的集数**，不是所有线路累加（`episodes` 是全部章节）。
             用户实测：「追天」两条线路各 185 集，头部却显示 370 集；且**各线路集数可以不同**
             （a 线路 7 集、b 线路更新快 8 集）⇒ 累加值既不是任一线路的集数，也无意义。 -->
        <span class="vd-kind" v-if="curLine?.episodes.length">{{ curLine.episodes.length }} 集</span>
        <span style="flex: 1"></span>
        <button class="btn mini" @click="toggleFav()">{{ inShelf ? '★ 已收藏' : '☆ 收藏' }}</button>
        <!-- ③-2 关闭按钮左侧：重新拉取详情/线路/选集 -->
        <button
          class="btn mini" :disabled="refreshing || loading"
          title="重新拉取详情与选集（不动播放状态）" @click="reloadDetail()"
        >{{ refreshing ? '⟳ 刷新中…' : '↻ 刷新' }}</button>
        <button class="btn mini" @click="vod.closeDetail()">关闭</button>
      </div>

      <div class="vd-body">
        <div v-if="loading && !detail" class="empty">加载中…</div>
        <template v-else>
          <div v-if="errMsg" class="err-text" style="margin-bottom: 10px">{{ errMsg }}</div>

          <!-- Hero -->
          <div class="vd-hero">
            <div class="vd-poster" :class="{ ph: !detail?.cover }">
              <!-- `#163`：CoverImage 自带「无封面 / 强制默认 / 加载失败」三种回落，
                   原来那个 v-else 占位块（片名前两字）由生成的默认封面替代。
                   ⚠️ **刻意不传 `author`**：这里 `detail` 是 `VodDetail`（不是 `UnifiedItem`），
                   导演/主演在 `detail.meta` 里，且紧挨着的 `metaLine()` 已经把它们列出来了 ——
                   再画一遍就是同一段字出现两次。别顺手加。 -->
              <CoverImage class="poster-img" :cover="detail?.cover" :source-id="session.sourceId" :title="detail?.title ?? session.title" />
            </div>
            <div class="vd-info">
              <h2 class="vd-title">
                {{ detail?.title ?? session.title }}
                <span class="tag" v-if="detail?.subtitle">{{ detail.subtitle }}</span>
              </h2>
              <div class="vd-meta" v-if="metaLine()">{{ metaLine() }}</div>
              <div class="tag-row" v-if="detail?.tags?.length">
                <span v-for="t in detail.tags" :key="t" class="tag">{{ t }}</span>
              </div>
              <RichIntro :text="detail?.summary" fallback="暂无简介。" />
              <div class="vd-act">
                <button class="btn primary" :disabled="!lines.length" @click="playAt(activeLine, 0)">
                  ▶ 播放{{ curLine ? `（${curLine.name}）` : '' }}
                </button>
              </div>
            </div>
          </div>

          <!-- 线路 + 选集 -->
          <div class="vd-sec-head">
            <h3>选集</h3>
            <span class="sub">{{ curLine?.episodes.length ?? 0 }} 集 · {{ lines.length }} 条线路 · 点选集直接开始播放</span>
            <span style="flex: 1"></span>
            <!-- ③-1 筛选 + 正序/倒序（右侧） -->
            <input
              v-model="epFilter" class="vd-ep-filter" type="search"
              :placeholder="`筛选集数（共 ${curLine?.episodes.length ?? 0}）`"
            />
            <div class="vd-order" :title="epDesc ? '当前：倒序（最新一集在前）' : '当前：正序（第 1 集在前）'">
              <span class="vd-order-label" :class="{ on: !epDesc }">正序</span>
              <button
                class="vd-switch" :class="{ on: epDesc }" role="switch" :aria-checked="epDesc"
                @click="epDesc = !epDesc"
              ><span class="vd-knob"></span></button>
              <span class="vd-order-label" :class="{ on: epDesc }">倒序</span>
            </div>
          </div>
          <div v-if="lines.length > 1" class="vd-lines">
            <span class="vd-line-label">线路</span>
            <button
              v-for="(ln, li) in lines" :key="ln.name"
              class="vd-chip" :class="{ on: activeLine === li }" :data-tip="`${ln.name} · ${ln.episodes.length} 集`"
              @click="activeLine = li"
            >{{ ln.isM3u8 ? '⚡ ' : '' }}{{ ln.name }} <span class="n">{{ ln.episodes.length }}集</span></button>
          </div>
          <div v-if="curLine?.episodes.length" class="vd-eps">
            <!-- ② 长集名会被截断 ⇒ `data-tip` 悬停看全名（见 components/HoverTip.vue） -->
            <button
              v-for="({ ep, i }) in shownEps" :key="i" class="vd-ep" :data-tip="ep.title"
              @click="playAt(activeLine, i)"
            >{{ ep.title }}</button>
            <div v-if="!shownEps.length" class="empty">没有匹配「{{ epFilter }}」的集数</div>
          </div>
          <div v-else-if="tocPending" class="empty">目录加载中…</div>
          <div v-else-if="!loading" class="err-text">没有解析到选集——该源可能未返回播放列表。</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vd-mask {
  position: fixed; inset: 0; z-index: 1005;
  /**
   * `#682` **与详情页同一套遮罩**（用户要求）：50% 压暗 + 高斯模糊。
   * 判据见 `ReaderOverlay.vue` 的 `.se-mask.se-mask-detail`（`#583`）；
   * `backdrop-filter` 只作用于遮罩**背后**，面板本身仍然清晰。
   */
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 4vh 16px;
}
/**
 * `#682` **默认高度就钉 92vh**（用户要求）：原来只有 `max-height` ⇒ 集数少的时候面板缩成一小条，
 * 与阅读/详情页（`#590` 的 `.se-mask.se-mask-detail:not(.rd-view) .se-panel { height: 92vh }`）不一致。
 */
.vd-panel {
  height: 92vh;
  width: min(960px, 100%); max-height: 92vh;
  display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow);
  animation: fadein 0.18s ease;
}
.vd-head { display: flex; gap: 8px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.vd-head strong { font-size: 15px; }
.vd-kind { font-size: 12px; color: var(--muted); }
.vd-body { padding: 14px 18px; overflow: auto; }
.vd-hero { display: flex; gap: 18px; }
.vd-poster {
  width: 170px; aspect-ratio: 2 / 3; flex-shrink: 0;
  border-radius: 10px; overflow: hidden; background: var(--bg-3);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.vd-poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
.vd-poster.ph { display: flex; align-items: center; justify-content: center; }
.vd-ph-in .t { font-size: 38px; font-weight: 800; color: var(--text-0); }
.vd-ph-in .s { font-size: 12px; color: var(--muted); text-align: center; }
.vd-info { flex: 1; min-width: 0; }
.vd-title { margin: 0 0 8px; font-size: 19px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vd-meta { font-size: 12.5px; color: var(--muted); line-height: 1.8; }
.vd-act { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.vd-sec-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 18px 0 8px; }
.vd-sec-head h3 { margin: 0; font-size: 15px; }
/* ③-1 选集筛选 + 正序/倒序（右侧） */
.vd-ep-filter {
  width: 140px; flex: none; padding: 4px 8px; border-radius: 7px;
  background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0);
  font-family: var(--font); font-size: 12px; outline: none;
}
.vd-ep-filter:focus { border-color: var(--acc-dim); }
.vd-order { display: flex; align-items: center; gap: 6px; flex: none; user-select: none; }
.vd-order-label { font-size: 11px; color: var(--faint); }
.vd-order-label.on { color: var(--text-0); font-weight: 600; }
/* 开关（手写 button+span：`<input type="range">` 在 Vue 里 v-model 不自动转数字） */
.vd-switch {
  width: 34px; height: 18px; border-radius: 999px; padding: 2px; flex: none;
  border: 1px solid var(--line); background: var(--bg-3); cursor: pointer;
  display: inline-flex; align-items: center; transition: background 0.16s, border-color 0.16s;
}
.vd-knob { width: 12px; height: 12px; border-radius: 50%; background: var(--muted); transition: transform 0.16s, background 0.16s; }
.vd-switch.on { background: var(--brand-soft); border-color: var(--brand); }
.vd-switch.on .vd-knob { background: var(--brand); transform: translateX(16px); }
.vd-lines { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.vd-line-label { font-size: 12px; color: var(--muted); }
.vd-chip {
  padding: 4px 9px; border-radius: 999px; cursor: pointer;
  background: var(--bg-2); border: 1px solid var(--border);
  color: var(--text-1); font-size: 12px; font-family: var(--font);
}
.vd-chip .n { color: var(--faint); font-size: 11px; }
.vd-chip.on { background: var(--brand-soft); border-color: var(--brand); color: #fff; }
.vd-eps { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
/* 「没有匹配」提示要占满整行（否则会被当成一个网格单元挤在角落） */
.vd-eps .empty { grid-column: 1 / -1; }
.vd-ep {
  padding: 9px 10px; border-radius: 8px;
  background: var(--bg-1); border: 1px solid var(--border);
  color: var(--text-1); font-size: 12.5px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font);
}
.vd-ep:hover { border-color: var(--brand); color: #fff; background: var(--brand-soft); }
@media (max-width: 760px) {
  .vd-hero { flex-direction: column; }
  .vd-poster { width: 140px; }
}
</style>
