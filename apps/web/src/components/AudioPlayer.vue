<script setup lang="ts">
/**
 * AudioPlayer —— 音频迷你浮窗（挂在 MainLayout 根部，**跨路由常驻**）。
 *
 * 职责边界：本组件只是 `stores/audio.ts` 的遥控器 —— 媒体元素、播放列表、
 * 进度记忆、定时关闭、系统媒体键全在 store 里，所以「收起浮窗」甚至「切路由」
 * 都不会打断播放。
 *
 * 两种形态：
 *   · 迷你条（`minimized`）：一行胶囊（封面 + 曲名 + 播放/暂停 + 展开 + 关闭）
 *   · 展开卡：封面/曲名/进度条/上一首下一首/音量/倍速/定时关闭/播放列表
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAudioStore } from '../stores/audio';
import { imgSrc } from '../utils/img';

const a = useAudioStore();

/* ---- 浮窗拖动 / 位置记忆 / 贴边隐藏 ----
 *
 * 设计取舍：
 *  · **位置状态放 store**（`floatPos`），因为组件会随路由卸载 —— 放组件里切页就丢；
 *  · **拖动过程只写本地 `live`**，松手才落 localStorage：`pointermove` 每秒几十次，
 *    每次都写盘既卡又无意义；
 *  · **拖动面 = 整块浮窗**，但排除 `button/input/select`（否则点按钮会变成拖拽）。
 *    比单独做一条「拖拽条」更好用 —— 迷你条那么矮，专门留条会挤掉信息。
 *  · **贴边判定用「元素边缘离视窗边缘 ≤ EDGE_SNAP px」**，命中后吸附到边界并半隐，
 *    鼠标移上去自动展开（CSS `:hover`）。
 */
const EDGE_SNAP = 24;
const wrapEl = ref<HTMLElement | null>(null);
/** 拖动中的实时位置（松手后清空、以 store 的持久值接管） */
const live = ref<{ x: number; y: number } | null>(null);
const dragging = ref(false);
let startX = 0;
let startY = 0;
let originX = 0;
let originY = 0;

/** 浮窗定位样式：无记忆位置时返回 null，交给 CSS 的右下角默认位 */
const posStyle = computed<Record<string, string> | null>(() => {
  const p = live.value ?? a.floatPos;
  if (!p) return null;
  return { left: `${p.x}px`, top: `${p.y}px`, right: 'auto', bottom: 'auto' };
});
/** 置顶开关：`false` 时降到阅读浮层（z-index 1000）之下 */
const layerStyle = computed(() => ({ zIndex: a.onTop ? 1200 : 500 }));

function dragStart(e: PointerEvent): void {
  const t = e.target as HTMLElement | null;
  // 面板/按钮/输入控件上按下时**不拖动**（否则控件点不动）
  // `#470` 补 `.ap-li`（播放列表歌曲行）：div 不在旧排除表里 ⇒ pointerdown 即被
  // `setPointerCapture` 抢走 ⇒ 后续 click 落在浮窗根元素 ⇒ 歌曲行的 @click 永远不触发
  // （用户实测「播放列表点歌无效、不切换」）。列表容器整体排除，行内未来加控件也不怕。
  if (t?.closest('button, input, select, a, .ap-list')) return;
  const el = wrapEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  dragging.value = true;
  a.setEdgeDock(null); // 一旦开始拖就退出贴边态，否则会「拖着半隐的窗」
  startX = e.clientX;
  startY = e.clientY;
  originX = r.left;
  originY = r.top;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
}
function dragMove(e: PointerEvent): void {
  if (!dragging.value) return;
  const el = wrapEl.value;
  if (!el) return;
  // 边界收敛：整个浮窗必须留在视窗内（否则拖出屏幕就再也抓不回来）
  const maxX = Math.max(0, window.innerWidth - el.offsetWidth);
  const maxY = Math.max(0, window.innerHeight - el.offsetHeight);
  live.value = {
    x: Math.min(Math.max(0, originX + e.clientX - startX), maxX),
    y: Math.min(Math.max(0, originY + e.clientY - startY), maxY),
  };
}
function dragEnd(): void {
  if (!dragging.value) return;
  dragging.value = false;
  const el = wrapEl.value;
  const p = live.value;
  live.value = null;
  if (!el || !p) return;
  const w = el.offsetWidth;
  const rightGap = window.innerWidth - (p.x + w);
  if (p.x <= EDGE_SNAP) {
    a.setFloatPos({ x: 0, y: p.y });
    a.setEdgeDock('left');
  } else if (rightGap <= EDGE_SNAP) {
    a.setFloatPos({ x: Math.max(0, window.innerWidth - w), y: p.y });
    a.setEdgeDock('right');
  } else {
    a.setFloatPos(p);
  }
}
/** 视窗尺寸变化：把记忆位置重新收敛回可见区域（浏览器窗口缩小后可能已在屏外） */
function clampToViewport(): void {
  const p = a.floatPos;
  const el = wrapEl.value;
  if (!p || !el) return;
  const maxX = Math.max(0, window.innerWidth - el.offsetWidth);
  const maxY = Math.max(0, window.innerHeight - el.offsetHeight);
  const nx = Math.min(p.x, maxX);
  const ny = Math.min(p.y, maxY);
  if (nx !== p.x || ny !== p.y) a.setFloatPos({ x: nx, y: ny });
}

/** 拖动进度条时的本地值（避免每个 input 事件都真 seek，那会卡顿） */
const dragPos = ref<number | null>(null);
const shownPos = computed(() => (dragPos.value ?? a.position));

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '00:00';
  const s = Math.floor(t % 60);
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function onSeekInput(e: Event): void {
  dragPos.value = Number((e.target as HTMLInputElement).value);
}
function onSeekCommit(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  dragPos.value = null;
  a.seek(v);
}
watch(() => a.index, () => {
  dragPos.value = null;
});

/** 定时关闭剩余时间 */
const sleepLabel = computed(() => {
  if (!a.sleepEndAt) return '';
  const l = a.sleepLeft;
  return l >= 60 ? `${Math.floor(l / 60)} 分 ${l % 60} 秒后暂停` : `${l} 秒后暂停`;
});
const SLEEP_OPTS = [
  { v: 0, t: '不定时' },
  { v: 15, t: '15 分钟' },
  { v: 30, t: '30 分钟' },
  { v: 60, t: '60 分钟' },
  { v: 90, t: '90 分钟' },
];
const RATES = [0.75, 1, 1.25, 1.5, 2];
function onSleep(e: Event): void {
  a.setSleep(Number((e.target as HTMLSelectElement).value));
}
function onRate(e: Event): void {
  a.setRate(Number((e.target as HTMLSelectElement).value));
}

/* ---- P1.5 离线到本机（`mode:'manual'`，永不参与配额自动淘汰）----
 *
 * 入口选在播放列表（而不是目录浮层）：这里是音频专属的操作面，
 * 且单章/整本都能就地触发，不用把音频控件塞进阅读器目录。
 */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/** 正在排队/下载中的章数 */
const dlActive = computed(
  () => Object.values(a.downloadJobs).filter((j) => j.status === 'queued' || j.status === 'running').length,
);
/** 已缓存 / 还没缓存（整本按钮的可用性） */
const dlDone = computed(() => a.tracks.filter((t) => a.isCachedTrack(t)).length);
const dlPending = computed(() => a.tracks.length - dlDone.value);
/**
 * 播放列表逐行的离线状态（一次性算好，模板里不重复调 store 方法）。
 * 文案口径：排队中 / xx% / 已缓存 / 失败(带原因) / 已取消 / 流式不支持。
 */
const rows = computed(() =>
  a.tracks.map((t, i) => {
    const job = a.jobOf(t);
    const cached = a.isCachedTrack(t);
    const active = a.isActiveJob(job);
    const pct = a.downloadPct(job);
    let label = '';
    let tone = '';
    let title = '';
    if (cached) {
      label = '已缓存';
      tone = 'ok';
      title = '已在本机（重新下载会跳过）';
    } else if (job) {
      if (job.status === 'queued') {
        label = '排队中';
        tone = 'run';
      } else if (job.status === 'running') {
        label = pct >= 0 ? `${pct}%` : '下载中';
        tone = 'run';
        title = job.totalBytes > 0 ? `${fmtBytes(job.bytes)} / ${fmtBytes(job.totalBytes)}` : '源未提供文件大小';
      } else if (job.status === 'done') {
        label = '已缓存';
        tone = 'ok';
      } else if (job.status === 'unsupported') {
        label = '流式不支持';
        tone = 'warn';
        title = '流式源不支持离线（m3u8 需要后续 HLS 打包）';
      } else if (job.status === 'error') {
        label = '失败';
        tone = 'bad';
        title = a.explainJobError(job);
      } else {
        label = '已取消';
        tone = 'warn';
      }
    }
    return { t, i, job, cached, active, label, tone, title };
  }),
);
// 打开播放列表时补拉一次服务端任务：关掉界面再打开，也能看到「还在下/已下完/失败原因」
watch(
  () => a.listOpen,
  (v) => {
    if (v) void a.refreshDownloadJobs();
  },
);

onMounted(() => window.addEventListener('resize', clampToViewport));
onBeforeUnmount(() => window.removeEventListener('resize', clampToViewport));
// 浮窗重新出现时（换书/重新打开）也要收敛一次：上一轮可能是窄窗拖到右边的位置
watch(() => a.visible, (v) => { if (v) requestAnimationFrame(clampToViewport); });
</script>

<template>
  <div
    v-if="a.visible"
    ref="wrapEl"
    class="ap-wrap"
    :class="{
      mini: a.minimized,
      dragging,
      'dock-left': a.edgeDock === 'left',
      'dock-right': a.edgeDock === 'right',
    }"
    :style="{ ...posStyle, ...layerStyle }"
    title="拖动可移动位置；拖到左右边缘会自动贴边隐藏"
    @pointerdown="dragStart"
    @pointermove="dragMove"
    @pointerup="dragEnd"
    @pointercancel="dragEnd"
  >
    <!-- 迷你条 -->
    <div v-if="a.minimized" class="ap-mini">
      <img v-if="a.book?.cover" class="ap-mini-cover" :src="imgSrc(a.book.cover, { sourceId: a.book.sourceId, cover: true })" alt="" />
      <div class="ap-mini-txt">
        <div class="t">{{ a.cur?.title ?? a.book?.title }}</div>
        <div class="s">{{ a.book?.title }}</div>
      </div>
      <button class="ap-btn" :title="a.playing ? '暂停' : '播放'" @click="a.toggle()">{{ a.playing ? '⏸' : '▶' }}</button>
      <button class="ap-btn" title="展开" @click="a.minimized = false">⤢</button>
      <button class="ap-btn" :class="{ on: a.onTop }" :title="a.onTop ? '取消置顶' : '置顶显示'" @click="a.setOnTop(!a.onTop)">📌</button>
      <button class="ap-btn" title="关闭（停止播放并退出）" @click="a.close()">✕</button>
    </div>

    <!-- 展开卡 -->
    <div v-else class="ap-card">
      <div class="ap-head">
        <span class="hd-grip" title="按住拖动">⠿</span>
        <div class="hd-t" :title="a.book?.title">{{ a.book?.title }}</div>
        <button class="ap-btn" :class="{ on: a.onTop }" :title="a.onTop ? '取消置顶' : '置顶显示'" @click="a.setOnTop(!a.onTop)">📌</button>
        <button class="ap-btn" title="收起" @click="a.minimized = true">⤡</button>
        <button class="ap-btn" title="关闭（停止播放并退出）" @click="a.close()">✕</button>
      </div>

      <div class="ap-main">
        <img v-if="a.book?.cover" class="ap-cover" :src="imgSrc(a.book.cover, { sourceId: a.book.sourceId, cover: true })" alt="" />
        <div v-else class="ap-cover ph">♪</div>
        <div class="ap-info">
          <div class="cur-t">{{ a.cur?.title ?? '未选择曲目' }}</div>
          <div class="cur-s">{{ a.book?.author || '' }}</div>
          <input
            class="ap-range" type="range" min="0" :max="a.duration || 0" step="0.5"
            :value="shownPos"
            @input="onSeekInput" @change="onSeekCommit"
          />
          <div class="ap-time">
            <span>{{ fmt(shownPos) }}</span>
            <span>{{ fmt(a.duration) }}</span>
          </div>
        </div>
      </div>

      <div v-if="a.err" class="ap-err">{{ a.err }}</div>
      <div v-if="a.loading" class="ap-hint">解析媒体地址中…</div>

      <div class="ap-ctrl">
        <button class="ap-btn" :disabled="!a.hasPrev" title="上一首" @click="a.prev()">⏮</button>
        <button class="ap-btn big" :title="a.playing ? '暂停' : '播放'" @click="a.toggle()">{{ a.playing ? '⏸' : '▶' }}</button>
        <button class="ap-btn" :disabled="!a.hasNext" title="下一首" @click="a.next()">⏭</button>
        <span class="ap-pos">{{ a.index + 1 }} / {{ a.tracks.length }}</span>
        <button class="ap-btn" :class="{ on: a.listOpen }" title="播放列表" @click="a.listOpen = !a.listOpen">☰</button>
      </div>

      <div class="ap-opt">
        <label class="ap-lab">音量
          <input
            class="ap-vol" type="range" min="0" max="1" step="0.05" :value="a.volume"
            @input="a.setVolume(Number(($event.target as HTMLInputElement).value))"
          />
        </label>
        <label class="ap-lab">倍速
          <select class="ap-sel" :value="a.rate" @change="onRate">
            <option v-for="r in RATES" :key="r" :value="r">{{ r }}×</option>
          </select>
        </label>
        <label class="ap-lab">定时
          <select class="ap-sel" :value="a.sleepEndAt ? -1 : 0" @change="onSleep">
            <option v-for="o in SLEEP_OPTS" :key="o.v" :value="o.v">{{ o.t }}</option>
            <option v-if="a.sleepEndAt" :value="-1" disabled>{{ sleepLabel }}</option>
          </select>
        </label>
      </div>
      <div v-if="a.sleepEndAt" class="ap-sleep">⏰ {{ sleepLabel }}</div>

      <!-- 播放列表（目录） -->
      <div v-if="a.listOpen" class="ap-list">
        <div class="li-bar">
          <span class="bar-t">
            离线到本机
            <template v-if="dlDone">· 已缓存 {{ dlDone }}/{{ a.tracks.length }}</template>
          </span>
          <span v-if="dlActive" class="bar-s">下载中 {{ dlActive }}</span>
          <button
            v-if="a.batchRunning || dlActive"
            class="li-btn wide"
            title="取消排队中/下载中的离线任务"
            @click.stop="a.cancelAllDownloads()"
          >{{ a.batchRunning ? '取消整本' : '全部取消' }}</button>
          <button
            v-else
            class="li-btn wide"
            :disabled="dlPending <= 0"
            :title="dlPending <= 0 ? '本节目录已全部缓存' : '把未缓存的章节加入离线队列（跳过已缓存）'"
            @click.stop="a.downloadAll()"
          >⬇ 整本未缓存</button>
        </div>
        <div
          v-for="r in rows" :key="r.i"
          class="ap-li" :class="{ on: r.i === a.index }"
          @click="a.playAt(r.i)"
        >
          <span class="li-i">{{ r.i + 1 }}</span>
          <span class="li-t">{{ r.t.title }}</span>
          <span class="li-r">
            <span v-if="r.label" class="li-tag" :class="r.tone" :title="r.title">{{ r.label }}</span>
            <button
              v-if="r.active"
              class="li-btn" title="取消这一章的离线" @click.stop="a.cancelDownload(r.t)"
            >✕</button>
            <button
              v-else-if="!r.cached && (!r.job || r.job.status === 'error' || r.job.status === 'cancelled')"
              class="li-btn"
              :title="r.job ? `重试离线（${r.title || '上次失败'}）` : '离线到本机'"
              @click.stop="a.downloadTrack(r.i)"
            >⬇</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ap-wrap {
  position: fixed; right: 18px; bottom: 18px;
  /* z-index 由内联样式控制（`a.onTop`：置顶 1200 / 普通 500）——
   * ⚠️ 原来的固定 900 **低于阅读浮层的 1000**，所以「浮窗被详情页盖住」是必然的。 */
  transition: transform 0.18s ease;
  touch-action: none;
}
.ap-wrap.dragging { cursor: grabbing; user-select: none; }
.ap-wrap.dragging .ap-btn { cursor: grabbing; }
/* 贴边隐藏：只留 16px 在视窗内，鼠标移上去自动滑出 */
.ap-wrap.dock-left { transform: translateX(calc(-100% + 16px)); }
.ap-wrap.dock-right { transform: translateX(calc(100% - 16px)); }
.ap-wrap.dock-left:hover,
.ap-wrap.dock-right:hover { transform: translateX(0); }
.hd-grip { color: var(--faint); font-size: 13px; cursor: grab; flex: none; padding: 0 2px; user-select: none; }
.ap-mini {
  display: flex; align-items: center; gap: 8px;
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: 999px; padding: 6px 10px 6px 6px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  max-width: 340px;
}
.ap-mini-cover { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; flex: none; background: var(--bg-3); }
.ap-mini-txt { min-width: 0; }
.ap-mini-txt .t { font-size: 12.5px; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-mini-txt .s { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ap-card {
  width: 330px; background: var(--bg-1);
  border: 1px solid var(--border-strong); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  padding: 10px 12px 12px;
}
.ap-head { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
.hd-t { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-main { display: flex; gap: 10px; }
.ap-cover { width: 64px; height: 64px; border-radius: 8px; object-fit: cover; flex: none; background: var(--bg-3); }
.ap-cover.ph { display: flex; align-items: center; justify-content: center; font-size: 26px; color: var(--muted); }
.ap-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.cur-t { font-size: 13px; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cur-s { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.ap-range { width: 100%; accent-color: var(--brand); cursor: pointer; }
.ap-time { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--faint); font-family: var(--mono); }

.ap-ctrl { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
.ap-btn {
  background: transparent; border: 1px solid transparent; color: var(--text-1);
  border-radius: 7px; cursor: pointer; font-size: 13px; padding: 4px 7px;
  font-family: var(--font); line-height: 1;
}
.ap-btn:hover:not(:disabled) { background: var(--bg-3); color: var(--text-0); }
.ap-btn:disabled { opacity: 0.35; cursor: default; }
.ap-btn.big { font-size: 16px; padding: 5px 10px; background: var(--brand-soft); border-color: var(--brand); color: #fff; }
.ap-btn.on { background: var(--brand-soft); color: #fff; }
.ap-pos { font-size: 11px; color: var(--faint); margin-left: auto; font-family: var(--mono); }

.ap-opt { display: flex; gap: 10px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.ap-lab { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 4px; }
.ap-vol { width: 68px; accent-color: var(--brand); }
.ap-sel {
  background: var(--bg-2); color: var(--text-1); border: 1px solid var(--border);
  border-radius: 6px; font-size: 11px; padding: 2px 4px; font-family: var(--font);
}
.ap-sleep { font-size: 11px; color: var(--orange, #e6a23c); margin-top: 6px; }
.ap-err { font-size: 11.5px; color: var(--red); margin-top: 8px; line-height: 1.5; }
.ap-hint { font-size: 11.5px; color: var(--muted); margin-top: 8px; }

.ap-list { max-height: 210px; overflow: auto; margin-top: 8px; border-top: 1px solid var(--border); padding-top: 6px; }
.li-bar { display: flex; align-items: center; gap: 8px; padding: 0 6px 6px; }
.bar-t { font-size: 11px; color: var(--muted); }
.bar-s { font-size: 11px; color: var(--brand); }
.li-btn {
  background: transparent; border: 1px solid var(--border); color: var(--text-1);
  border-radius: 6px; cursor: pointer; font-size: 11px; padding: 2px 6px;
  font-family: var(--font); line-height: 1.35; flex: none;
}
.li-btn:hover:not(:disabled) { background: var(--bg-3); color: var(--text-0); }
.li-btn:disabled { opacity: 0.4; cursor: default; }
.li-btn.wide { margin-left: auto; }
.ap-li .li-btn { margin-left: 0; }
.li-r { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
/* 状态标签：已缓存 / 排队中 / 进度 / 失败 / 流式不支持 */
.li-tag { font-size: 10.5px; color: var(--faint); font-family: var(--mono); white-space: nowrap; }
.li-tag.ok { color: var(--green, #4caf7d); }
.li-tag.run { color: var(--brand); }
.li-tag.warn { color: var(--orange, #e6a23c); }
.li-tag.bad { color: var(--red); cursor: help; }
.ap-li { display: flex; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 12px; color: var(--text-1); }
.ap-li:hover { background: var(--bg-3); color: var(--text-0); }
.ap-li.on { background: var(--brand-soft); color: #fff; }
.li-i { color: var(--faint); font-family: var(--mono); font-size: 11px; min-width: 22px; }
.li-t { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
