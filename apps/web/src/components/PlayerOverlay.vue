<script setup lang="ts">
/**
 * PlayerOverlay —— 视频**播放浮窗**（影视 + Legado 视频源共用）。
 *
 * 覆盖原来 `views/PlayerView.vue` 的整页跳转形态（用户要求「播放页也变成浮窗」）。
 * 播放/选集/上下集由 `stores/player.ts` 驱动（解析分两种模式，见该 store 注释），
 * 真正的媒体元素交给 `MediaPlayer.vue`（artplayer + hls.js，含备选线路自动切换）。
 *
 * 挂在 MainLayout 根部 ⇒ 跨路由常驻、切换页面不断播。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { usePlayerStore } from '../stores/player';
import { useReaderStore } from '../stores/reader';
import { useSourcesStore } from '../stores/sources';
import MediaPlayer from './MediaPlayer.vue';
import { imgSrc } from '../utils/img';
import { pushEscLayer } from '../utils/esc-layer';

const p = usePlayerStore();
const reader = useReaderStore();
const st = useSourcesStore();
const router = useRouter();
/** `#513` 当前视频源名称（播放页「上一集」前展示，点击跳规则工坊） */
const playerSourceName = computed(() => {
  const id = p.session?.sourceId;
  if (!id) return '';
  return st.sources.find((x) => x.id === id)?.name || id;
});
function openSourceWorkshop(): void {
  const id = p.session?.sourceId;
  if (!id) return;
  p.close();
  void router.push({ name: 'workshop', query: { id } });
}
/** 播放器自身报错（与 store 的解析错误分开显示，便于定位是「拿不到地址」还是「地址放不出来」） */
const playerErr = computed(() => p.err);

/**
 * **选集浮层的筛选 / 正倒序**（用户 B：与书源目录同一套交互）。
 *
 * ⚠️ 与目录列表同一个坑：筛选与倒序都**不能重编号** —— `epShown` 带的是**原始下标 i**，
 * 点它才对应 `p.playAt(i)`。按展示顺序 `p.playAt(展示序)` 会点错集。
 */
const epFilter = ref('');
const epDesc = ref(false);
const epShown = computed(() => {
  const items = p.session?.items ?? [];
  const kw = epFilter.value.trim().toLowerCase();
  const idx = items.map((it, i) => ({ it, i }));
  const filtered = kw ? idx.filter(({ it }) => String(it.title ?? '').toLowerCase().includes(kw)) : idx;
  return epDesc.value ? filtered.slice().reverse() : filtered;
});
function toggleOrder(): void {
  epDesc.value = !epDesc.value;
  void nextTick(scrollListToCurrent);
}

/** 把**当前集**滚进浮层可视区（只滚这个列表，不用 `scrollIntoView` —— 那会连带滚动祖先） */
const listBodyEl = ref<HTMLElement | null>(null);
function scrollListToCurrent(): void {
  const body = listBodyEl.value;
  const cur = body?.querySelector<HTMLElement>('.pl-li.on');
  if (!body || !cur) return;
  body.scrollTop = Math.max(0, cur.offsetTop - body.clientHeight / 2 + cur.clientHeight / 2);
}
/** 选集按钮：开/关浮层；打开时**复位筛选**并把当前集滚进可视区 */
function toggleList(): void {
  if (p.listOpen) {
    p.listOpen = false;
    return;
  }
  epFilter.value = '';
  p.listOpen = true;
  void nextTick(scrollListToCurrent);
}
/** 换集/换片后浮层若开着，让高亮跟着走 */
watch(
  () => p.session?.index,
  () => {
    if (p.listOpen) void nextTick(scrollListToCurrent);
  },
);

/**
 * `#689` **本集播完**：开了「自动连播」且有下一集就切过去。
 *
 * 为什么放在这一层而不是播放器里：连播要**重新解析下一集直链**（`playAt`），
 * 那是 store 的职责；播放器只负责说「这一集结束了」（`MediaPlayer` 的 `ended` 事件）。
 * 关掉开关时**什么都不做**（停在最后一帧，用户自己点选集），也不弹提示 —— 开关状态本身就是答案。
 */
function onEnded(): void {
  if (!p.autoNext) return;
  if (p.hasNext) p.next();
}

/**
 * 播放进度 → 观影历史 / 影视收藏（对齐 OmniFlow 的 `progressSec`/`durationSec`）。
 * 仅 `play` 模式（CMS/影视源）有此语义：`content` 模式（Legado 视频源）没有「整部影片」payload。
 * 节流在 `MediaPlayer` 内部做（≥4s 一次 + 暂停/播完强制补）。
 */
function onProgress(sec: number, dur: number): void {
  const s = p.session;
  if (!s || s.mode !== 'play' || !s.vodPayload) return;
  reader.recordProgress(s.sourceId, s.vodPayload, sec, dur);
}

/**
 * Esc 关闭 —— `#459` 改走**共享 Esc 栈**（`utils/esc-layer`）。
 *
 * 旧实现是「只有阅读浮层没开时才关」（靠 `document.querySelector('.se-mask')` 探测 DOM）。
 * 那只解决了阅读/播放这一对；再叠一层就不灵了。现在按「打开即入栈、关闭即出栈」表达层级：
 * 本浮窗后开 ⇒ 栈顶 ⇒ 一次 Esc 只关它，阅读浮层留在原位（用户 2026-10-14 的口径：
 * 「只关闭/退出当前」）。
 */
let popEsc: (() => void) | null = null;
watch(
  () => p.open && !!p.session,
  (on) => {
    if (on && !popEsc) popEsc = pushEscLayer(() => p.close());
    else if (!on && popEsc) { popEsc(); popEsc = null; }
  },
  { immediate: true },
);
onBeforeUnmount(() => { popEsc?.(); popEsc = null; });
</script>

<template>
  <!-- `#459`：去掉「点遮罩关闭」—— 只能由「关闭」按钮 / Esc（且只退当前层）关闭 -->
  <div v-if="p.open && p.session" class="pl-mask">
    <div class="pl-panel">
      <div class="pl-head">
        <img
          v-if="p.session.cover" class="pl-cover"
          :src="imgSrc(p.session.cover, { sourceId: p.session.sourceId, cover: true })" alt=""
          @error="($event.target as HTMLImageElement).style.display = 'none'"
        />
        <div class="pl-titlewrap">
          <div class="pl-title">{{ p.session.title }}</div>
          <div class="pl-sub">
            <span v-if="p.cur" class="tag cy" :data-tip="p.cur.title">{{ p.cur.title }}</span>
            <span v-if="p.session.subtitle" class="tag">{{ p.session.subtitle }}</span>
            <!-- `#352` direct（嗅探）会话 items 恒空 ⇒ 不显示「1 / 0」这种序号 -->
            <span v-if="p.total" class="pl-idx">{{ p.session.index + 1 }} / {{ p.total }}</span>
          </div>
        </div>
        <span style="flex: 1"></span>
        <!-- `#352` direct（嗅探）会话没有选集语义 ⇒ 整组按钮不渲染（只有一个播放器 + 关闭） -->
        <template v-if="p.total">
          <!-- `#513` 当前视频源（用户要求：「上一集」按钮前；太长截断 + 悬浮全名；点击跳规则工坊） -->
          <button
            v-if="playerSourceName"
            class="btn mini"
            :title="`视频源：${playerSourceName}（点击打开规则工坊）`"
            style="max-width: 8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
            @click="openSourceWorkshop()"
          >{{ playerSourceName }}</button>
          <button class="btn mini" :disabled="!p.hasPrev" @click="p.prev()">‹ 上一集</button>

          <button class="btn mini" :disabled="!p.hasNext" @click="p.next()">下一集 ›</button>
          <button class="btn mini" :class="{ on: p.listOpen }" @click="toggleList()">
            选集（{{ p.total }}）
          </button>
          <!-- ① 播放页的「刷新」= **重新解析当前这一集的播放地址**（用户 2026-09-27 要求与详情页隔离：
               详情页刷新重拉详情+选集，播放页刷新只重拉当前集的直链）。地址过期/线路抖时一键重试。 -->
          <button
            class="btn mini" :disabled="p.loading"
            title="重新解析当前这一集的播放地址（不动选集与线路）" @click="p.playAt(p.session.index)"
          >{{ p.loading ? '⟳ 解析中…' : '↻ 刷新' }}</button>
        </template>
        <button class="btn mini" @click="p.close()">关闭</button>
      </div>

      <div class="pl-body">
        <div class="pl-stage">
          <MediaPlayer
            v-if="p.url"
            :key="p.url"
            :src="p.url"
            :alternatives="p.alternatives"
            :format="p.format"
            :source-id="p.session.sourceId"
            :referer="p.referer"
            @error="p.setError($event)"
            @progress="onProgress"
            @ended="onEnded"
          />
          <div v-else class="pl-hint">
            <span v-if="p.loading">🔍 解析播放地址中…</span>
            <span v-else-if="p.err" class="err-text">{{ p.err }}</span>
            <span v-else class="err-text">未取到媒体地址</span>
          </div>
          <div v-if="p.url && playerErr" class="pl-err">{{ playerErr }}</div>
        </div>

        <!-- 选集浮层（用户 B）：**浮在播放区右侧**，不再当 flex 兄弟挤窄视频。
             含 正序/倒序 开关 + 筛选框；打开时把**当前集**滚进可视区并高亮。 -->
        <transition name="pl-slide">
          <div v-if="p.listOpen" class="pl-list">
            <div class="pl-list-head">
              <span>选集（{{ epShown.length }}/{{ p.total }}）</span>
              <span style="flex: 1"></span>
              <!-- `#689` 自动连播开关（用户要求放在选集列表标题栏）：
                   与下方「正序/倒序」同一套 `.pl-switch` 样式，避免出现两种开关长相。 -->
              <span
                class="pl-autonext"
                :title="p.autoNext ? '本集播完自动播放下一集（点击关闭）' : '本集播完停住（点击开启自动连播）'"
              >
                <span class="pl-order-label" :class="{ on: p.autoNext }">自动连播</span>
                <button
                  class="pl-switch" :class="{ on: p.autoNext }" role="switch" :aria-checked="p.autoNext"
                  @click="p.setAutoNext(!p.autoNext)"
                ><span class="pl-knob"></span></button>
              </span>
              <button class="btn mini" @click="p.listOpen = false">✕</button>
            </div>
            <div class="pl-list-tools">
              <input
                v-model="epFilter" class="pl-ep-filter" type="search"
                :placeholder="`筛选集数（共 ${p.total}）`"
              />
              <div class="pl-order" :title="epDesc ? '当前：倒序（最大的在前）' : '当前：正序（第 1 集在前）'">
                <span class="pl-order-label" :class="{ on: !epDesc }">正序</span>
                <button
                  class="pl-switch" :class="{ on: epDesc }" role="switch" :aria-checked="epDesc"
                  @click="toggleOrder()"
                ><span class="pl-knob"></span></button>
                <span class="pl-order-label" :class="{ on: epDesc }">倒序</span>
              </div>
            </div>
            <div class="pl-list-body" ref="listBodyEl">
              <!-- ② 长集名会被截断 ⇒ `data-tip` 悬停看全名（见 components/HoverTip.vue）
                   ⚠️ `i` 必须是**原始下标**（筛选/倒序都不重编号），否则点错集 -->
              <button
                v-for="({ it, i }) in epShown" :key="i"
                class="pl-li" :class="{ on: i === p.session.index }" :data-tip="it.title"
                @click="p.playAt(i)"
              >{{ it.title }}</button>
              <div v-if="!epShown.length" class="pl-list-empty">没有匹配「{{ epFilter }}」的集数</div>
            </div>
          </div>
        </transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pl-mask {
  position: fixed; inset: 0; z-index: 1010;
  /**
   * `#682` **播放页遮罩也换成「50% 压暗 + 高斯模糊」**（用户要求）。
   * 与详情页/影视详情页同一套：见 `VDetailOverlay.vue` 的 `.vd-mask` 注释。
   */
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 4vh 16px;
}
/* `#682` 与影视详情页一致：默认就是 92vh（原来只有 max-height，内容少时面板缩得很小） */
.pl-panel {
  height: 92vh;
  width: min(1100px, 100%); max-height: 92vh;
  display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow);
  animation: fadein 0.18s ease;
}
.pl-head {
  display: flex; gap: 8px; align-items: center;
  padding: 10px 14px; border-bottom: 1px solid var(--border);
}
.pl-cover { width: 30px; height: 42px; object-fit: cover; border-radius: 5px; flex: none; background: var(--bg-3); }
.pl-titlewrap { min-width: 0; }
.pl-title { font-size: 14.5px; font-weight: 700; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-sub { display: flex; gap: 6px; align-items: center; margin-top: 3px; flex-wrap: wrap; }
.pl-idx { font-size: 11.5px; color: var(--faint); font-family: var(--mono); }
/* `position: relative`：选集浮层以**播放区**为边界（用户 B：不再挤压视频） */
.pl-body { position: relative; display: flex; min-height: 0; flex: 1; }
/* `#684` 舞台**居中**：视频盒子现在由 MediaPlayer 按内容比例算出（不再是 100% 宽），
   不居中就会贴在左边、右边空一块。padding 保留，`clientHeight` 才是可用高度。 */
.pl-stage {
  flex: 1; min-width: 0; padding: 12px 14px 14px;
  display: flex; align-items: center; justify-content: center;
}
.pl-hint { display: flex; align-items: center; justify-content: center; min-height: 220px; font-size: 13px; color: var(--muted); }
.pl-err { margin-top: 8px; font-size: 12px; color: var(--red); line-height: 1.6; }
/* 选集浮层：绝对定位盖在播放区右侧（视频宽度不变）。
   ⚠️ z-index 必须**高于 artplayer 内部层级**（它自己的浮层用到 90，见 dist 里的 `.art-settings`），
   否则播放器控制条会画在列表上面（实拍可见：右下角几个按钮压在列表背景上）。
   ⚠️ `bottom: 60px` = 播放区 padding-bottom(14) + artplayer 控制条高(46，`--art-control-height`)：
   让浮层**停在控制条上方**，否则列表会盖住全屏/画中画/清晰度那几个按钮（开着列表就没法全屏）。 */
.pl-list {
  position: absolute; top: 0; right: 0; bottom: 60px; z-index: 100;
  width: min(320px, 78%);
  display: flex; flex-direction: column;
  background: var(--bg-1); border-left: 1px solid var(--border-strong);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.3);
}
.pl-slide-enter-active, .pl-slide-leave-active { transition: transform 0.16s ease, opacity 0.16s ease; }
.pl-slide-enter-from, .pl-slide-leave-to { transform: translateX(16px); opacity: 0.4; }
.pl-list-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; font-weight: 700; color: var(--text-0);
  padding: 8px 10px; border-bottom: 1px solid var(--border);
}
.pl-list-tools { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
/* `#689` 自动连播开关（标题栏右侧）：与「正序/倒序」同款间距与字号 */
.pl-autonext { display: flex; align-items: center; gap: 5px; flex: none; user-select: none; cursor: pointer; }
.pl-ep-filter {
  flex: 1 1 auto; min-width: 0; padding: 5px 8px; border-radius: 7px;
  background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0);
  font-family: var(--font); font-size: 12px; outline: none;
}
.pl-ep-filter:focus { border-color: var(--acc-dim); }
.pl-order { display: flex; align-items: center; gap: 5px; flex: none; user-select: none; }
.pl-order-label { font-size: 11px; color: var(--muted); }
.pl-order-label.on { color: var(--text-0); font-weight: 600; }
.pl-switch {
  position: relative; width: 34px; height: 18px; flex: none; cursor: pointer;
  border-radius: 999px; border: 1px solid var(--line); background: var(--bg-3); padding: 0;
}
.pl-switch.on { background: var(--brand); border-color: var(--brand); }
.pl-knob {
  position: absolute; top: 1px; left: 1px; width: 14px; height: 14px;
  border-radius: 50%; background: #fff; transition: left 0.16s;
}
.pl-switch.on .pl-knob { left: 17px; }
/* `#440` ⚠️ **必须 `position: relative`**：`scrollListToCurrent()` 用 `cur.offsetTop` 定位当前集，
   而 `offsetTop` 是相对**最近的定位祖先**的 —— 这里若为 `static`，offsetParent 会跳到
   外层的 `.pl-list`（`position:absolute`）⇒ 算出来的 offsetTop 多出「标题行 + 筛选行」那 ~80px
   ⇒ 每次点选集都会把列表**向上多滚 ~80px**（用户实测「点选集滚动条向上跳动、第 1 集被筛选框遮住」）。
   自己成为定位祖先 ⇒ offsetTop 与 scrollTop 同坐标系，居中公式才成立。 */
.pl-list-body { position: relative; flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 12px; }
.pl-li {
  display: block; width: 100%; text-align: left; margin-top: 3px;
  padding: 7px 9px; border-radius: 7px; cursor: pointer;
  background: transparent; border: 1px solid transparent;
  color: var(--text-1); font-size: 12.5px; font-family: var(--font);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pl-li:hover { background: var(--bg-3); color: var(--text-0); }
.pl-li.on { background: var(--brand-soft); border-color: var(--brand); color: #fff; }
.pl-list-empty { font-size: 12px; color: var(--muted); padding: 10px 4px; }
.btn.on { background: var(--brand-soft); color: #fff; }
@media (max-width: 860px) {
  .pl-stage { padding-bottom: 14px; }
  .pl-list { width: min(280px, 88%); }
}
</style>
