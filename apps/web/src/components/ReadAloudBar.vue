<script setup lang="ts">
/**
 * 朗读（TTS）浮条（`#203`）—— 阅读浮层内的底部控制条 + 设置面板。
 *
 * ## 为什么单独一个组件
 * `ReaderOverlay.vue` 已有 1600+ 行，朗读是**独立功能**（一条状态机 + 一组偏好），
 * 再堆进去会让那个文件更难读。组件只做「显示 store 状态 + 转发用户动作」，
 * **不含任何朗读逻辑**（逻辑全在 `stores/read-aloud.ts`，可单测）。
 *
 * ## 与上游的对应
 * 上游 `ReadAloudDialog`（`ui/book/read/config/ReadAloudDialog.kt`）是一条底部浮条：
 * 上一段 / 播放暂停 / 下一段 / 上一章 / 下一章 / 语速 / 定时 / 更多设置。
 * 本组件按 Web 端重排为「一行主控 + 可展开设置」，语义逐项对齐（**没有音调**：
 * 上游全仓无 pitch 控件，已核对 `dialog_read_aloud.xml`）。
 *
 * ## 一条硬纪律：不静默
 * 引擎不可用 / 朗读出错 / 已到最后一章 —— 一律显示在浮条上，
 * 不用 console 吞掉（否则用户只会看到「点了没反应」）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  useReadAloudStore,
  type SpeechVoice,
} from '../stores/read-aloud';
import {
  DEFAULT_VOICE_SCOPE,
  SPEECH_RATE_MAX,
  TIMER_MAX_MIN,
  filterVoicesByScope,
  isVoiceFilteredOut,
  normalizeVoiceScope,
  timerLabel,
  speechRateLabel,
  type VoiceLangScope,
} from '../utils/read-aloud-core';
import { toast } from '../toast';
import { listEdgeVoices, type EdgeVoice } from '../utils/tts';

const emit = defineEmits<{
  (e: 'follow', bodyPos: number): void;
  (e: 'update:open', v: boolean): void;
  (e: 'toggle-lyrics'): void;
  /** 请 ReaderOverlay 重新从 desktop-prefs 拉一次歌词开关（真源在那边，本组件不另存） */
  (e: 'lyrics-refresh'): void;
}>();

const al = useReadAloudStore();
const settingsOpen = ref(false);
/**
 * 整条控制条是否铺开（用户 2026-10-02 纠错：「朗读组件和朗读设置组件挤占了阅读界面」）。
 *
 * ## 为什么默认折叠
 * 原来这条是 `.se-panel` 的 flex 子项（走正常流）⇒ **占掉正文上缘一整行**；
 * 设置面板 `.al-set` 也在流内 ⇒ 展开时正文被压窄。现在整条改为**绝对定位悬浮层**，
 * 脱离文档流 ⇒ `.se-body` 不知道它存在 ⇒ **正文宽高一字不变**。
 * 但即使改成悬浮，一整条横跨的控件仍然视觉上「压着」正文 ⇒ 默认只留一枚
 * 右下角圆形 FAB（`▶` / `⏸`），点它才铺开。
 *
 * ## 为什么朗读中**不**自动展开
 * 用户要的是「别挡我看书」，不是「一朗读就铺开控制条」。
 * 需要调语速/音色/定时时点 FAB 即可 ⇒ 主动权在用户。
 */
const expanded = ref(false);
/** 拖动结束后紧跟的那个 click（FAB 上会误触播放/暂停）⇒ 吃掉它（见下方拖动实现） */
let suppressFabClick = false;

/** B18：迷你态点气泡 = 直接播放/暂停（没有空间展开整条） */
function onFabClick(): void {
  // 刚拖动过气泡 ⇒ 这次 click 是拖动的尾巴，不当作「播放/暂停」
  if (suppressFabClick) return;
  if (compact.value) {
    if (al.isPlaying) al.pause();
    else al.play();
    return;
  }
  expanded.value = true;
}

/**
 * 停止朗读**并彻底收起**（用户 2026-10-02：主动停止也该有「收手感」）。
 *
 * ★ 这里 emit `update:open=false` 是**对的**（与上面那个 watch 相反）：
 *   停止 ⇒ 用户明确表示「不听了」⇒ 连那枚「▶ 朗读」圆钮也不该留着占版面。
 *   折叠（⌄ 收起条）是「暂时不想看这排按钮，但等下还要接着听」⇒ 组件必须留着。
 *   ★ 这两种「收起」语义不同，别混成一条。
 */
function stopAndCollapse(): void {
  al.stop();
  settingsOpen.value = false;
  expanded.value = false;
  emit('update:open', false);
}

/* ---- 与外层（ReaderOverlay 工具条入口）的双向联动 ----
   ★★ **刻意不用 defineModel** —— 它拿到的是**解包后的 boolean**，不是 ref：
     父组件 alOpen.value = true 时，这个 false→true 的变化**发生在父侧**，
     子组件内部那个 model ref 并未被同步改写 ⇒ watch 永远不 fire
     （实测症状：入口点了、按钮文案已变「收起朗读」、FAB 出现了，但整条不展开
       —— 很像坏了，其实在等一个不会来的 watch）。
     显式 prop + emit 才可靠。 */
const props = defineProps<{
  open?: boolean;
  compact?: boolean;
  /** 歌词浮窗此刻是否开启（**真源在 ReaderOverlay**：桌面 = desktop-prefs.lyricsEnabled，Web = webLyricsOpen） */
  lyricsEnabled?: boolean;
  /** 是否桌面外壳（只有桌面才有独立歌词窗，Web 是页内浮窗） */
  lyricsDesktop?: boolean;
}>();

/* ------------------------------------------------------------------ *
 * 歌词浮窗入口（用户 2026-11-08：从「阅读界面 → 更多」搬到朗读控制条 → 设置面板）
 * · 开关状态**不在这里另存一份**：显示用 prop，点击 emit 回 ReaderOverlay 改真源；
 * · 2026-11-14：字号 / 透明度 / 显示前后句 三项控件已移除（歌词窗自己有这些功能），
 *   本组件不再读写 desktop-prefs，只保留开关与「刷新真源」。
 * ------------------------------------------------------------------ */
const lyricsOn = computed(() => props.lyricsEnabled === true);
const lyricsDesktop = computed(() => props.lyricsDesktop === true);

// 设置面板一开就刷新开关真源
watch([settingsOpen, lyricsOn], () => {
  if (!settingsOpen.value) return;
  emit('lyrics-refresh');
}, { immediate: true });
/**
 * B18：迷你态**只做显示层覆盖** —— 整条控制条强制折叠成圆形气泡，
 * 不改用户的 `expanded`/`open` 偏好；退出迷你后原来展开的条会自己回来。
 */
const compact = computed(() => props.compact === true);
/** 真正铺开的判据：用户要展开 **且** 不在迷你态 */
const showBar = computed(() => expanded.value && !compact.value);
watch(() => props.open, (v) => { if (v) expanded.value = true; }, { immediate: true });
watch(compact, (v) => { if (v) settingsOpen.value = false; });
/**
 * ★★ **刻意不做「收起 ⇒ emit update:open false」** —— 那是拆自己的招：
 * `v-if` 在 ReaderOverlay 里是 `(alOpen || al.active)`，一旦 emit false 就把**整个组件卸载**，
 * 而折叠态的那枚 FAB **是组件内部的元素** ⇒ 收起 = FAB 也一起消失（实测：点「⌄ 收起条」后
 * 整条和圆钮都没了，用户失去「再听回去」的入口）。
 *
 * 正确语义：**折叠只是「展开态 ↔ 圆钮态」的切换，组件始终挂着**（只要还在正文里）。
 * 只有「离开正文」才由 ReaderOverlay 那个 watch 把 `alOpen` 置 false —— 那时机是对的。
 */
watch(expanded, () => { /* 保持挂载：不改 open */ });

/* ---- B18 浮条可拖动 ----
 * 用户 2026-11-08：朗读控制条要能「脱离窗口的浮条」并拖动。
 *  · **Web**：真正的跨窗口脱离走「小窗阅读」浮窗（ReaderMiniBar，入口在「更多」菜单）；
 *    页面内的这条控制条自身支持拖动（本例）。
 *  · **桌面**：本轮只做**窗内拖动**；OS 级独立控制条窗口需要第二个渲染进程 + 朗读状态双向同步，
 *    未在本轮实现（歌词窗那条路按用户要求暂不重构，避免与另一条会话冲突）。
 *
 * 位置存 localStorage（`left/top` 像素，相对 `.se-mask` 这块 fixed 整屏），
 * 拖动时钳在视口内；窗口 resize 后再夹一次。按钮/输入/下拉不参与拖动（避免误触）。
 */
const AL_POS_KEY = 'yuedu.read-aloud-bar-pos';
interface AlPos { x: number; y: number; vw: number; vh: number }
function loadAlPos(): AlPos | null {
  try {
    const raw = localStorage.getItem(AL_POS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<AlPos>;
    if (typeof o?.x === 'number' && typeof o?.y === 'number' && Number.isFinite(o.x) && Number.isFinite(o.y)) {
      return {
        x: o.x,
        y: o.y,
        // 旧格式没有 vw/vh ⇒ 按当前视口当作同一尺度，随后靠 clamp 兜底
        vw: typeof o.vw === 'number' && o.vw > 0 ? o.vw : window.innerWidth,
        vh: typeof o.vh === 'number' && o.vh > 0 ? o.vh : window.innerHeight,
      };
    }
  } catch { /* 坏数据 = 没存过 */ }
  return null;
}
const alPos = ref<AlPos | null>(loadAlPos());
const fabEl = ref<HTMLButtonElement | null>(null);
const barEl = ref<HTMLElement | null>(null);
/** 有位置时用 left/top；没拖过时退回 CSS 的 right/bottom 默认位 */
const posStyle = computed(() => (alPos.value
  ? { left: `${alPos.value.x}px`, top: `${alPos.value.y}px`, right: 'auto', bottom: 'auto' }
  : undefined));

const DRAG_THRESHOLD = 6;
let dragState: {
  pointerId: number; startX: number; startY: number; baseX: number; baseY: number; moved: boolean;
} | null = null;

function clampPos(x: number, y: number, el: HTMLElement | null): AlPos {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  return {
    x: Math.min(maxX, Math.max(0, Math.round(x))),
    y: Math.min(maxY, Math.max(0, Math.round(y))),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}
function onDragPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const root = e.currentTarget as HTMLElement | null;
  if (!root) return;
  const target = e.target as HTMLElement | null;
  // 气泡（FAB）整颗可拖；展开条只在非交互区拖（按钮/输入/下拉/链接不抢事件）
  if (!root.classList.contains('al-fab') && target?.closest('button,input,select,textarea,label,a')) return;
  const rect = root.getBoundingClientRect();
  dragState = {
    pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
    baseX: rect.left, baseY: rect.top, moved: false,
  };
  try { root.setPointerCapture(e.pointerId); } catch { /* 老浏览器：拖出元素即停，可接受 */ }
}
function onDragPointerMove(e: PointerEvent): void {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragState.moved = true;
  }
  e.preventDefault();
  alPos.value = clampPos(dragState.baseX + dx, dragState.baseY + dy, e.currentTarget as HTMLElement | null);
}
function onDragPointerEnd(e: PointerEvent): void {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const moved = dragState.moved;
  dragState = null;
  if (!moved) return;
  const p = alPos.value;
  try { localStorage.setItem(AL_POS_KEY, JSON.stringify(p)); } catch { /* 存不下只影响下次默认 */ }
  suppressFabClick = true;
  window.setTimeout(() => { suppressFabClick = false; }, 0);
}
/**
 * 视口变化后重新落位：**相对位置 + 边界钳制**。
 *
 * 用记录时的视口尺寸把像素换回「可移动范围内的比例」，再按当前视口重算像素，
 * 最后 `clampPos` 夹进边界 —— 缩窗口不会把浮条留在屏幕外，也不会因为比例换算跑出边界。
 */
function reclampAlPos(): void {
  const p = alPos.value;
  if (!p) return;
  const el = showBar.value ? barEl.value : fabEl.value;
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  const vw = p.vw > 0 ? p.vw : window.innerWidth;
  const vh = p.vh > 0 ? p.vh : window.innerHeight;
  const rx = Math.min(1, Math.max(0, p.x / Math.max(1, vw - w)));
  const ry = Math.min(1, Math.max(0, p.y / Math.max(1, vh - h)));
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  alPos.value = {
    x: Math.round(rx * maxX),
    y: Math.round(ry * maxY),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}
/**
 * 收缩（整条 → 气泡）/ 展开（气泡 → 整条）**保持视觉锚点**：
 * 用户 2026-11-08：「收缩成按钮时坐标按左上角收缩，按钮跑到了控制条左上角」。
 *
 * 做法：在 DOM 切换**之前**（watch 默认 `flush: pre`）量旧元素的中心点，
 * 切换后（`nextTick`）把新元素的**中心**摆回同一点，再夹进边界。
 * 不能只共用 `left/top` —— 两个形态尺寸差很多（整条 500×90 vs 气泡 42×42）。
 */
watch(showBar, (expand) => {
  if (!alPos.value) return; // 没拖过：两个形态都按 CSS 右下角定位，无需换算
  const oldEl = expand ? fabEl.value : barEl.value;
  const rect = oldEl?.getBoundingClientRect();
  const cx = rect ? rect.left + rect.width / 2 : null;
  const cy = rect ? rect.top + rect.height / 2 : null;
  void nextTick(() => {
    const el = expand ? barEl.value : fabEl.value;
    if (!el || cx == null || cy == null) { reclampAlPos(); return; }
    const p = clampPos(cx - el.offsetWidth / 2, cy - el.offsetHeight / 2, el);
    alPos.value = { ...p, vw: window.innerWidth, vh: window.innerHeight };
  });
});

/* ---- 音色列表 ----
   ★ Chromium 的 `getVoices()` **首次调用常返回空数组**，要等 `voiceschanged` 事件
     （上游是 Android `TextToSpeech.getVoices()`，同步就有 —— 这是平台差异，不是我们的取舍）。 */
const voices = ref<SpeechVoice[]>([]);
function loadVoices(): void {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth) return;
  const list = synth.getVoices() ?? [];
  if (list.length) voices.value = list.map((v) => ({ id: v.voiceURI || v.name, name: v.name, lang: v.lang }));
}
onMounted(() => {
  loadVoices();
  // 控制条挂上就先对齐一次歌词开关（否则入口文案可能停留在旧值）
  if (lyricsDesktop.value) emit('lyrics-refresh');
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  synth?.addEventListener('voiceschanged', loadVoices);
  window.addEventListener('resize', reclampAlPos);
  // 上次的位置可能是在更大的窗口里记的 ⇒ 挂载时先夹回当前视口
  reclampAlPos();
});
/* ⚠️ `onBeforeUnmount` **必须与 `onMounted` 平级**（写在 `onMounted` 回调里不会被注册，
   监听器会泄漏 —— 浮层反复开关时每次多挂一个 `voiceschanged` 监听）。 */
onBeforeUnmount(() => {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  synth?.removeEventListener('voiceschanged', loadVoices);
  window.removeEventListener('resize', reclampAlPos);
});

/* ---- 音色语言筛选（`#847`）----
 * Chromium 的 `getVoices()` 会把系统里**所有语言**的音色都列出来（Windows 常见几十条）。
 * 默认只显示中文（`zh-*` / `cmn-*` / `yue-*`），可切「全部语言」。
 * 筛选档位单独落 localStorage（`yuedu-read-aloud-voice-scope`）；已选音色仍由朗读偏好保存。
 * ★ 已选音色被筛掉时，下拉里额外保留一条「已选 · 当前筛选外」并给出提示，
 *   绝不能把 `:value` 落到空选项上（那会被误读成「用户没选音色」）。
 */
const VOICE_SCOPE_KEY = 'yuedu-read-aloud-voice-scope';
function readVoiceScope(): VoiceLangScope {
  try {
    return normalizeVoiceScope(localStorage.getItem(VOICE_SCOPE_KEY));
  } catch {
    return DEFAULT_VOICE_SCOPE;
  }
}
const voiceScope = ref<VoiceLangScope>(readVoiceScope());
function onVoiceScopeChange(e: Event): void {
  voiceScope.value = normalizeVoiceScope((e.target as HTMLSelectElement).value);
  try {
    localStorage.setItem(VOICE_SCOPE_KEY, voiceScope.value);
  } catch {
    /* 存不下只影响下次默认，不影响本次筛选 */
  }
}
const filteredVoices = computed(() => filterVoicesByScope(voices.value, voiceScope.value));
const selectedVoice = computed(() => voices.value.find((v) => v.id === al.prefs.voiceId) ?? null);
const selectedHidden = computed(() =>
  isVoiceFilteredOut(voices.value, al.prefs.voiceId, voiceScope.value));

/* ---- 跟随朗读位置（上游 `followReadAloud` 的 Web 版）----
   Web 阅读器是**连续滚动**、没有「页」，所以跟随 = 滚动到当前句所在段（`utils/chapter-text` 同一坐标系）。 */
const lastFollowed = ref(-1);
watch(
  () => (al.prefs.followPosition ? al.currentParagraph : -1),
  (para) => {
    if (para < 0 || para === lastFollowed.value) return;
    lastFollowed.value = para;
    emit('follow', al.currentPos);
  },
);

/* ---- 播放 / 暂停 ---- */
function toggle(): void {
  if (al.isPlaying) al.pause();
  else al.play();
}

/** 语速滑条：0~45（上游 `seek_tts_speechRate`），「跟随系统」时禁用（上游 `upTtsSpeechRateEnabled(false)`） */
const rateValue = computed({
  get: () => al.prefs.rate,
  set: (v: number) => al.setRate(v),
});
const rateText = computed(() => speechRateLabel(al.prefs.rate, al.prefs.followSystem));

/** 定时（分钟）。输入非法 ⇒ 回落 0（关闭），不让 NaN 进去 */
const timerText = ref(String(al.prefs.timerMinutes));
watch(() => al.prefs.timerMinutes, (v) => { timerText.value = String(v); });
function commitTimer(): void {
  const n = Math.round(Number(timerText.value));
  al.setTimer(Number.isFinite(n) ? n : 0);
  if (!Number.isFinite(n) || n < 0) timerText.value = '0';
  toast(n > 0 ? `朗读定时：${timerLabel(n)}` : '已关闭朗读定时');
}

/** 章节停：读完 N 章后停（0 = 不限） */
const stopText = ref(String(al.prefs.chapterStop));
watch(() => al.prefs.chapterStop, (v) => { stopText.value = String(v); });
function commitStop(): void {
  const n = Math.round(Number(stopText.value));
  al.setChapterStop(Number.isFinite(n) ? n : 0);
  if (!Number.isFinite(n) || n < 0) stopText.value = '0';
  toast(n > 0 ? `朗读 ${n} 章后停止` : '已取消章节停');
}

function onVoiceChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  al.setVoice(v || null);
}

/* ---- Edge 在线音色（用户 2026-11-10：PC 端也要能用 Edge 那套完整音色）----
 * 为什么不能直接塞进 `getVoices()`：本机 Web Speech 只能枚举系统语音包（Windows SAPI），
 * Edge「大声朗读」的音色是**云端 neural voices**，系统接口里根本不存在。
 * 所以这里单独拉 `/api/tts/edge/voices`（免 Key），合成走 `/api/tts/edge/speak`。
 * 列表是懒加载的：用户不切到 Edge 就不发请求（离线/服务端旧版时不影响系统语音）。
 */
const edgeVoices = ref<(EdgeVoice & { lang: string })[]>([]);
const edgeLoading = ref(false);
const edgeError = ref('');

async function loadEdgeVoices(force = false): Promise<void> {
  if (edgeLoading.value) return;
  edgeLoading.value = true;
  edgeError.value = '';
  try {
    const r = await listEdgeVoices(force);
    // `filterVoicesByScope` 按 `lang` 筛 ⇒ 把 Edge 的 `locale` 映射成 `lang`（同一套中文判定）
    edgeVoices.value = r.voices.map((v) => ({ ...v, lang: v.locale }));
  } catch (e) {
    edgeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    edgeLoading.value = false;
  }
}

const edgeFiltered = computed(() => filterVoicesByScope(edgeVoices.value, voiceScope.value));
const edgeSelected = computed(() =>
  edgeVoices.value.find((v) => v.id === al.prefs.edgeVoiceId) ?? null);
const edgeSelectedHidden = computed(() =>
  isVoiceFilteredOut(edgeVoices.value, al.prefs.edgeVoiceId, voiceScope.value));

function onVoiceSourceChange(e: Event): void {
  al.setVoiceSource((e.target as HTMLSelectElement).value === 'edge' ? 'edge' : 'system');
}
function onEdgeVoiceChange(e: Event): void {
  al.setEdgeVoice((e.target as HTMLSelectElement).value || null);
}
/** 切到 Edge（或一打开设置就是 Edge）时再拉列表；失败不清空已有列表 */
watch(
  () => [al.prefs.voiceSource, settingsOpen.value] as const,
  ([src, open]) => {
    if (src !== 'edge' || !open) return;
    if (!edgeVoices.value.length) void loadEdgeVoices();
  },
  { immediate: true },
);
function onRateFollowChange(e: Event): void {
  al.setFollowSystem((e.target as HTMLInputElement).checked);
}
function onFollowPosChange(e: Event): void {
  al.setFollowPosition((e.target as HTMLInputElement).checked);
}

/** 顶部工具条那个入口的标题：把「为什么不能读」直接说出来，而不是让用户点了没反应 */
const engineHint = ref('');
function checkEngine(): void {
  // `#822`：在线引擎与系统语音无关 —— 走 HTTP TTS / Edge 时不再报「浏览器没有 speechSynthesis」
  if (al.usingHttpTts || al.usingEdgeTts) {
    engineHint.value = '';
    return;
  }
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
    engineHint.value = '当前浏览器不支持语音合成（speechSynthesis 不可用），无法朗读';
  } else if (!voices.value.length) {
    loadVoices();
    engineHint.value = voices.value.length
      ? ''
      : '系统还没有可用音色（Windows 一般自带，Linux/部分精简版可能没有）';
  }
}
onMounted(checkEngine);
watch(() => [al.usingHttpTts, al.usingEdgeTts], checkEngine);
</script>

<template>
  <!-- ★ 用户 2026-10-02：折叠态只留一枚圆形 FAB（悬浮右下角），点它才铺开整条浮条。
       不铺开的原因：常驻的一条控制条会横跨正文上缘（用户原话「挤占了阅读界面」）。
       出现条件：正在朗读（`al.active`）时**自动出现** —— 此时用户最需要那枚「暂停」；
       空闲时只有主动点工具条那个「🔊 朗读」入口才会挂载（见 ReaderOverlay 的 v-if）。 -->
  <button
    v-if="!showBar"
    ref="fabEl"
    class="al-fab" :class="{ playing: al.isPlaying, compact }"
    :style="posStyle"
    data-al-fab
    :title="compact
      ? (al.isPlaying ? '正在朗读 — 点此暂停（迷你窗：控制条已收成气泡）' : '点此继续/开始朗读（迷你窗：控制条已收成气泡）')
      : (al.isPlaying ? '正在朗读 — 点此暂停' : '朗读本章 — 点此展开控制条')"
    @pointerdown="onDragPointerDown"
    @pointermove="onDragPointerMove"
    @pointerup="onDragPointerEnd"
    @pointercancel="onDragPointerEnd"
    @click="onFabClick"
  >
    <span aria-hidden="true">{{ al.isPlaying ? '⏸' : '▶' }}</span>
    <i v-if="al.active && !al.isPlaying" class="al-fab-dot" aria-label="已暂停"></i>
    <span class="sr-only">{{ al.isPlaying ? '暂停朗读' : '朗读本章' }}</span>
  </button>

  <div
    v-else ref="barEl"
    class="al-bar" :class="{ active: al.active }"
    :style="posStyle"
    data-al-bar
    @pointerdown="onDragPointerDown"
    @pointermove="onDragPointerMove"
    @pointerup="onDragPointerEnd"
    @pointercancel="onDragPointerEnd"
  >
    <!-- 错误 / 提示：★ 不静默 -->
    <div v-if="al.error || engineHint" class="al-err" data-al-error>
      {{ al.error || engineHint }}
    </div>

    <!-- `#873` 设置页切换引擎后的即时反馈（几秒后自动消失，不占常驻空间） -->
    <div v-if="al.engineNotice" class="al-note" data-al-notice>
      {{ al.engineNotice }}
    </div>

    <!-- 当前正在读的一句（截断显示，便于确认「它在念哪」） -->
    <div v-if="al.active" class="al-now" data-al-now :title="al.currentText">
      <span class="al-now-label">{{ al.isPlaying ? '正在读' : '已暂停' }}</span>
      <span class="al-now-text">{{ al.currentText || '（本句无正文）' }}</span>
    </div>

    <div class="al-row">
      <!-- B18：拖动把手（也是整个浮条的拖动区之一；按钮/输入/下拉不参与拖动） -->
      <span class="al-drag" data-al-drag title="按住拖动浮条（位置会记住）" aria-hidden="true">⠿</span>
      <button class="btn mini" :disabled="al.chaptersDone < 0" title="上一章" @click="al.prevChapter()">⏮ 章</button>
      <button class="btn mini" title="上一句" data-al-prev @click="al.prevParagraph()">◀ 句</button>
      <button class="btn mini primary" data-al-toggle :title="al.isPlaying ? '暂停（记住位置）' : '朗读本章'" @click="toggle">
        {{ al.isPlaying ? '⏸ 暂停' : '▶ 朗读' }}
      </button>
      <button class="btn mini" title="下一句" data-al-next @click="al.nextParagraph()">句 ▶</button>
      <button class="btn mini" title="下一章（本章读完自动续下一章）" @click="al.nextChapter(false)">章 ⏭</button>

      <span class="al-sep"></span>

      <span class="al-rate" :title="`语速 ${rateText}（上游换算 (值+5)/10）`">
        语速 <b data-al-rate-label>{{ rateText }}</b>
      </span>
      <!-- `#822`：走 HTTP TTS 时把「当前引擎」放在明面上，用户才知道声音不是系统的 -->
      <span
        v-if="al.usingHttpTts" class="al-chip online" data-al-engine
        :title="`在线朗读引擎：${al.engineLabel}（在「设置 → 朗读」更换）`"
      >🔌 {{ al.engineLabel }}</span>
      <!-- Edge 在线音色（云端）：把「现在不是系统语音」放在明面上，避免用户误以为是本机音色 -->
      <span
        v-if="al.usingEdgeTts" class="al-chip online" data-al-edge-chip
        :title="`Edge 在线音色：${al.prefs.edgeVoiceId ?? '未选'}（需联网；可在朗读设置里切回本机语音）`"
      >☁ Edge · {{ al.prefs.edgeVoiceId ?? '未选音色' }}</span>
      <span v-if="al.timerMinutes > 0" class="al-chip" data-al-timer>⏲ {{ al.timerMinutes }} 分钟</span>
      <span v-if="al.chaptersDone > 0" class="al-chip optional">已读 {{ al.chaptersDone }} 章</span>

      <span style="flex: 1"></span>

      <button class="btn mini" data-al-settings-toggle :title="settingsOpen ? '关闭设置' : '朗读设置（音色 / 语速 / 定时 / 章节停）'" @click="settingsOpen = !settingsOpen">
        {{ settingsOpen ? '✕ 收起' : '⚙ 设置' }}
      </button>
      <!-- ★ 「停止」同时**收起整条**：用户 2026-10-02 要求「关闭阅读界面朗读应自动停止、收起」，
           这里让「主动停止」也有同样的收手感（上游 `stop()` 只停，收起由 `bottomDialog` 独立管）。 -->
      <button class="btn mini" title="停止朗读并收起" data-al-stop @click="stopAndCollapse()">■ 停止</button>
      <button class="btn mini" title="收起控制条（不停止朗读）" data-al-collapse @click="expanded = false">⌄ 收起条</button>
    </div>

    <!-- 设置面板：浮在浮条上方（同一坐标系；浮在正文之上，不挤压正文） -->
    <div v-if="settingsOpen" class="al-set" data-al-settings>
      <!-- 用户 2026-10-02：「右上角增加关闭按钮」——
           之前只能点浮条上的「✕ 收起」或再点「⚙ 设置」才关，而面板浮在正文上方时
           那两个按钮离它很远 ⇒ 必须自带一个关闭入口。 -->
      <button class="al-set-x" title="关闭设置" aria-label="关闭设置" data-al-settings-close @click="settingsOpen = false">✕</button>
      <!-- `#822`：HTTP TTS 的音色由引擎配置决定（不支持双音色），这里只展示当前引擎 -->
      <div v-if="al.usingHttpTts" class="al-set-row" data-al-engine-row>
        <span class="al-set-label">引擎</span>
        <span class="al-set-engine" :title="al.engineLabel">{{ al.engineLabel }}</span>
        <span class="al-set-unit">在「设置 → 朗读」里更换</span>
      </div>
      <template v-else>
        <!-- 音色来源（用户 2026-11-10）：本机系统语音（离线）⇄ Edge 在线音色（云端，需联网） -->
        <label class="al-set-row">
          <span class="al-set-label">来源</span>
          <select class="al-select" data-al-voice-source :value="al.prefs.voiceSource" @change="onVoiceSourceChange">
            <option value="system">本机系统语音（离线可用）</option>
            <option value="edge">Edge 在线音色（需联网）</option>
          </select>
          <span class="al-set-unit">
            {{ al.prefs.voiceSource === 'edge' ? '云端神经音色，免 Key' : '系统语音包，不联网' }}
          </span>
        </label>
        <label class="al-set-row">
          <span class="al-set-label">语言</span>
          <select class="al-select" data-al-voice-scope :value="voiceScope" @change="onVoiceScopeChange">
            <option value="zh">仅中文</option>
            <option value="all">全部语言</option>
          </select>
          <span class="al-set-unit">默认仅中文；切换后记住</span>
        </label>

        <!-- 本机系统语音 -->
        <label v-if="al.prefs.voiceSource !== 'edge'" class="al-set-row">
          <span class="al-set-label">音色</span>
          <select class="al-select" data-al-voice :value="al.prefs.voiceId ?? ''" @change="onVoiceChange">
            <!-- ★ 已选但被筛掉：保留一条可见项，避免下拉落到「系统默认」被误读成未选 -->
            <option v-if="selectedHidden && selectedVoice" :value="selectedVoice.id">
              {{ selectedVoice.name }}（{{ selectedVoice.lang }}）· 已选，当前筛选外
            </option>
            <option value="">系统默认</option>
            <option v-for="v in filteredVoices" :key="v.id" :value="v.id">{{ v.name }}（{{ v.lang }}）</option>
          </select>
        </label>
        <template v-if="al.prefs.voiceSource !== 'edge'">
          <p v-if="!voices.length" class="al-set-tip">
            还没取到音色。Windows / macOS / Android 一般自带；若持续为空，说明系统未安装中文语音包。
          </p>
          <p v-else-if="!filteredVoices.length" class="al-set-tip" data-al-voice-empty-scope>
            当前筛选下没有音色；切到「全部语言」查看（已选音色不会被清掉）。
          </p>
          <p v-if="selectedHidden && selectedVoice" class="al-set-tip" data-al-voice-hidden>
            已选音色「{{ selectedVoice.name }}」不在当前筛选（{{ selectedVoice.lang }}）；切到「全部语言」可重新选它。
          </p>
        </template>

        <!-- Edge 在线音色 -->
        <template v-else>
          <label class="al-set-row">
            <span class="al-set-label">音色</span>
            <select
              class="al-select" data-al-edge-voice
              :value="al.prefs.edgeVoiceId ?? ''" :disabled="edgeLoading && !edgeVoices.length"
              @change="onEdgeVoiceChange"
            >
              <option v-if="edgeSelectedHidden && edgeSelected" :value="edgeSelected.id">
                {{ edgeSelected.name }}（{{ edgeSelected.locale }}）· 已选，当前筛选外
              </option>
              <option v-for="v in edgeFiltered" :key="v.id" :value="v.id">
                {{ v.name }}（{{ v.locale }}）
              </option>
            </select>
            <button class="btn mini" data-al-edge-refresh :disabled="edgeLoading" @click="loadEdgeVoices(true)">
              {{ edgeLoading ? '…' : '刷新' }}
            </button>
          </label>
          <p v-if="edgeError" class="al-set-tip" data-al-edge-error>
            Edge 音色列表获取失败：{{ edgeError }}。离线时请切回「本机系统语音」。
          </p>
          <p v-else-if="edgeLoading && !edgeVoices.length" class="al-set-tip">正在获取 Edge 音色列表…</p>
          <p v-else-if="!edgeFiltered.length" class="al-set-tip" data-al-edge-empty-scope>
            当前筛选下没有 Edge 音色；切到「全部语言」查看（共 {{ edgeVoices.length }} 个）。
          </p>
          <p v-else class="al-set-tip" data-al-edge-count>
            共 {{ edgeFiltered.length }} 个可选（全部语言 {{ edgeVoices.length }} 个）；云端合成，断网时切回本机语音。
          </p>
          <p v-if="edgeSelectedHidden && edgeSelected" class="al-set-tip" data-al-edge-hidden>
            已选音色「{{ edgeSelected.name }}」不在当前筛选（{{ edgeSelected.locale }}）；切到「全部语言」可重新选它。
          </p>
        </template>
      </template>
      <p v-if="al.usingHttpTts && al.engineLabel === '未选择'" class="al-set-tip">
        还没有选择在线引擎：去「设置 → 朗读」里选一条并启用；或关闭总开关改用系统语音。
      </p>

      <label class="al-set-row">
        <span class="al-set-label">语速</span>
        <input
          class="al-range" data-al-rate type="range" min="0" :max="SPEECH_RATE_MAX" step="1"
          v-model.number="rateValue" :disabled="al.prefs.followSystem"
        />
        <span class="al-set-num">{{ al.prefs.rate }}</span>
      </label>
      <label class="al-set-check">
        <input type="checkbox" data-al-rate-follow :checked="al.prefs.followSystem" @change="onRateFollowChange" />
        跟随系统语速（固定 1.0 倍；勾选时上面的滑条不可用）
      </label>

      <label class="al-set-row">
        <span class="al-set-label">定时</span>
        <input class="al-num" data-al-timer-input v-model="timerText" inputmode="numeric" placeholder="分钟" />
        <span class="al-set-unit">分钟（0 = 不限，上限 {{ TIMER_MAX_MIN }}）</span>
        <button class="btn mini" data-al-timer-commit @click="commitTimer">确定</button>
      </label>

      <label class="al-set-row">
        <span class="al-set-label">章节停</span>
        <input class="al-num" data-al-stop-input v-model="stopText" inputmode="numeric" placeholder="章数" />
        <span class="al-set-unit">章（0 = 一直读下去）</span>
        <button class="btn mini" data-al-stop-commit @click="commitStop">确定</button>
      </label>

      <label class="al-set-check">
        <input type="checkbox" data-al-follow-pos :checked="al.prefs.followPosition" @change="onFollowPosChange" />
        跟随朗读位置（自动滚动到当前句所在段）
      </label>

      <!-- ★ 歌词浮窗入口（用户 2026-11-08：从「阅读界面 → 更多」搬到这里）。
           开关真源在 ReaderOverlay；本组件只显示 prop、点击 emit，不另存状态。 -->
      <label class="al-set-row" data-al-lyrics-row>
        <span class="al-set-label">歌词浮窗</span>
        <button
          class="btn mini"
          type="button"
          data-al-lyrics-toggle
          :aria-pressed="lyricsOn ? 'true' : 'false'"
          @click="emit('toggle-lyrics')"
        >{{ lyricsOn ? '已开启' : '关闭' }}</button>
        <span class="al-set-unit">{{ lyricsDesktop ? '朗读时另开置顶浮窗' : '朗读时页内浮窗显示当前句' }}</span>
      </label>

    </div>
  </div>
</template>

<style scoped>
/* ============================================================================
 * 布局（用户 2026-10-02 纠错：「朗读组件和朗读设置组件挤占了阅读界面」）
 *
 * ## 之前：作为 `.se-panel` 的 flex 子项走正常流
 * 后果两条（都实测过）：
 *   ① 浮条本身占正文**上缘一整行**（截图里的那条）—— 竖屏/小窗口时尤其明显；
 *   ② 设置面板 `.al-set` 也在流内（`max-height: min(46vh, 320px)`）⇒ 展开时正文被压窄。
 *
 * ## 现在：整条改为**绝对定位的悬浮层**
 * ★ 定位上下文 = 挂载点所在的 `.se-mask`（`position:fixed`，覆盖整屏）。
 *   `right/bottom` 用 `clamp()` **夹在屏幕内** —— 组件挂在遮罩层里，若按面板宽度算，
 *   窄面板时会横向溢出（实测 505px 宽的条右缘 1426 > 面板右缘 1180）。
 * ★ 脱离文档流 ⇒ `.se-body` 不知道它存在 ⇒ **正文宽度/高度一字不变**。
 *   这才是「不挤占阅读界面」的正解（负 margin / 收窄正文只是把挤压转移到别处）。
 *
 * ★ 折叠形态：默认只留一枚「▶ 朗读 / ⏸ 暂停」圆形按钮悬浮在右下角，
 *   展开才铺开整条。理由：单按钮的视觉重心最低，正文几乎不被干扰。
 * ========================================================================== */
.al-bar {
  position: absolute;
  right: clamp(12px, 3vw, 28px);
  bottom: clamp(56px, 8vh, 96px);
  z-index: 20;
  width: max-content; max-width: calc(100vw - 32px);
  padding: 8px 12px 9px;
  background: var(--bg-2);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.38);
  user-select: none; font-size: 12px;
}
/* B18：拖动把手 —— 明确告诉用户「这条可以挪」，同时给出可拖的抓取光标 */
.al-drag {
  flex: none;
  padding: 0 2px;
  color: var(--muted);
  cursor: grab;
  touch-action: none;
  font-size: 13px;
  letter-spacing: 1px;
}
.al-drag:active { cursor: grabbing; }

/* ★ 控制条本身也要**收窄**（用户 2026-10-02：不能挤占阅读界面）。
   实测全展开时一行要 505px（面板 920px）—— 虽然绝对定位不挤压正文，
   但一条半屏宽的控件横在右下角，视觉上仍然「压着书」。
   ⇒ 把**可省略的信息**在浮条里隐藏：语速数值（有 title 提示）、已读章数（状态 chip）。
      主控（章/句/播放/句/章）+ 语速标签 + 三个按钮保留。 */
.al-rate b { display: none; }        /* 语速数值在 title 里，点设置面板可看 */
.al-chip.optional { display: none; } /* 「已读 N 章」这类可选信息 */

/* 折叠态：只剩一枚圆形播放/暂停钮 —— 悬浮在右下角，不横跨正文 */
.al-fab {
  position: absolute;
  right: clamp(12px, 3vw, 28px);
  bottom: clamp(56px, 8vh, 96px);
  z-index: 20;
  width: 42px; height: 42px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; cursor: grab; touch-action: none;
  background: var(--bg-2); color: var(--text-0);
  border: 1px solid var(--border-strong);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
}
/* 只给读屏软件读的文本（图标按钮没有可见文字，需要它） */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.al-fab:hover { border-color: var(--accent); }
/* B18 迷你窗：气泡贴右下角且缩小（240×180 里 42px 圆钮太占正文） */
.al-fab.compact {
  right: 10px;
  bottom: 10px;
  width: 34px;
  height: 34px;
  font-size: 13px;
}
.al-fab.playing { background: var(--brand-soft); border-color: var(--accent); }
.al-fab .al-fab-dot {
  position: absolute; top: -1px; right: -1px;
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--accent); border: 1px solid var(--bg-2);
}

.al-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.al-sep { width: 1px; height: 18px; background: var(--border-strong); margin: 0 2px; }
.al-rate { color: var(--muted); white-space: nowrap; }
.al-rate b { color: var(--text-0); font-family: var(--mono); }
.al-chip {
  padding: 2px 7px; border-radius: 999px; white-space: nowrap;
  background: var(--brand-soft); color: var(--text-0);
}
/* `#822` 在线引擎标记：与「定时 / 已读章数」区分开（这是「声音来自哪里」） */
.al-chip.online {
  background: rgba(34, 211, 238, 0.12); color: #7ce7f7;
  max-width: 120px; overflow: hidden; text-overflow: ellipsis;
}
.al-set-engine {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--cy);
}
/* 正在读的那句：单行截断（长句会撑破浮条） */
.al-now { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; min-width: 0; }
.al-now-label { color: var(--accent); flex: none; font-weight: 600; }
.al-now-text {
  color: var(--text-1); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: min(46ch, 60vw);
}
.al-err {
  margin-bottom: 6px; padding: 5px 8px; border-radius: 6px;
  background: rgba(239, 93, 96, 0.14); color: #ff9a9c;
}
.al-note {
  margin-bottom: 6px; padding: 5px 8px; border-radius: 6px;
  background: rgba(99, 179, 237, 0.14); color: #8cc7f5;
}

/* ---------------------------------------------------------------------------
 * 设置面板：浮在浮条**上方**（锚点是 `.se-mask`，与浮条同一坐标系）
 *
 * 为什么不留在浮条里纵向铺开：那样它会**把正文压窄**（用户原话「挤占了阅读界面」）。
 * 浮在正文之上，正文的宽度与滚动完全不受影响。
 * ★ 用**媒体查询**而不是 `@container` —— 后者要求祖先显式声明 `container-type`，
 *   而 `.se-panel` 没有 ⇒ 规则不会生效（静默失效，比不写还坏）。
 *   触发点对齐上游的 600dp 断点。
 * ------------------------------------------------------------------------- */
.al-set {
  position: absolute;
  right: clamp(12px, 3vw, 28px);
  bottom: calc(clamp(56px, 8vh, 96px) + 56px);
  z-index: 21;
  width: min(320px, calc(100vw - 32px)); max-height: min(52vh, 420px); overflow: auto;
  margin: 0; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 7px;
  background: var(--bg-2);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42);
}
.al-set-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* 面板右上角的关闭按钮（用户 2026-10-02 要求）。
   `position:absolute` 脱离文档流 ⇒ 不占面板内一行的宽度，也不会把第一行（音色）挤窄。 */
.al-set-x {
  position: absolute; top: 6px; right: 6px; z-index: 1;
  width: 24px; height: 24px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; cursor: pointer; font-size: 12px; line-height: 1;
  background: transparent; color: var(--muted);
  border: 1px solid transparent;
}
.al-set-x:hover { background: var(--bg-3); color: var(--text-0); border-color: var(--border-strong); }
/* 面板首行是「音色」下拉，右侧要给它留出按钮的位置（否则长音色名会被压到按钮下面） */
.al-set > .al-set-row:first-of-type { padding-right: 30px; }
.al-set-label { width: 42px; flex: none; color: var(--muted); }
.al-set-unit { color: var(--faint); }
.al-set-num { font-family: var(--mono); color: var(--text-0); min-width: 26px; }
.al-set-check { display: flex; gap: 6px; align-items: center; color: var(--text-1); }
/* 「歌词浮窗」四个字比常规 42px 标签宽，单独放宽，避免折行 */
[data-al-lyrics-row] > .al-set-label { width: 56px; }
.al-set-tip { margin: 0; color: var(--faint); }
.al-select, .al-num {
  padding: 3px 6px; border-radius: 6px; font-family: var(--font); font-size: 12px;
  color: var(--text-0); background: var(--bg-1); border: 1px solid var(--border-strong);
}
.al-num { width: 78px; }
.al-range { flex: 1; min-width: 120px; accent-color: var(--brand); }

/* 窄窗口：设置面板改为**占满可用宽度**（320px 在手机上会溢出） */
@media (max-width: 720px) {
  .al-set { right: clamp(8px, 3vw, 28px); left: clamp(8px, 3vw, 28px); width: auto; }
}
</style>
