/**
 * 朗读（TTS）状态机 + Web Speech 引擎适配（`#203`）。
 *
 * ## 与上游的对应关系（语义对齐，实现不同 —— 逐条写明）
 * | 本文件 | 上游 | 说明 |
 * |---|---|---|
 * | 逐**句**提交 `speak()` | `TTSReadAloudService.play()` | 上游也是一句一条 utterance（`contentList` 逐条 `speak`） |
 * | `pause()` = `cancel()` + 记住位置 | `pauseReadAloud()` → `playStop()` | ★ **不是** `speechSynthesis.pause()`：Web Speech 的 pause/resume 在 Chromium 上不可靠（长文本会停、resume 常不生效）⇒ 与上游一样用「停止 + 记住 `nowSpeak`/`paragraphStartPos`」实现可续读的暂停 |
 * | `onboundary` 记句内偏移 | `TTSUtteranceListener.onRangeStart` | 断点续读精度到「词」；取不到 boundary 事件时从句子开头续读（降级而非报错） |
 * | 读完本章 ⇒ `nextChapter(auto)` | `nextParagraph()` 末尾 `nextChapter(auto = true)` | 自动续章 |
 * | 定时 / 章节停 | `timeMinute` / `chapterToStop` | `resetTimer` / `setChapterStop` |
 *
 * ## 三条不变量
 * 1. **只有一个 utterance 在飞**：每次 `speak` 前先 `cancel()`（否则会叠着念）。
 * 2. **`state` 是唯一真相**：`speaking()` 由引擎自己报，可能与我们的 `state` 短暂不一致 ⇒ 只信 `state`。
 * 3. **换章/换书必须重置**：不清 `sentences`/`index` 会拿旧章的偏移去新章取文本（静默念错内容）。
 *
 * ## 偏好持久化
 * 上游这些偏好都在 `AppConfig`/`Preference` 里（`ttsSpeechRate` / `ttsFollowSys` / `ttsTimer` / `ttsEngine`），
 * 而**本仓契约里没有对应实体** ⇒ 按项目约定**留在 localStorage**（不硬塞 user 端点、不造第二份真相源）。
 */
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useReaderStore } from './reader';
import { bodyPosToPara, buildChapterText } from '../utils/chapter-text';
import {
  DEFAULT_GAP_MS,
  DEFAULT_SPEECH_RATE,
  GAP_MAX_MS,
  SPEECH_RATE_MAX,
  TIMER_MAX_MIN,
  chapterStopReached,
  clampGapMs,
  clampSpeechRate,
  isNotReadAloud,
  locateSentence,
  nextSpeakableIndex,
  prevSpeakableIndex,
  speechRateOf,
  splitSentences,
  type Sentence,
} from '../utils/read-aloud-core';
import { getTtsConfig, segmentForReadAloud, ttsBackendSignature, DEFAULT_EDGE_VOICE } from '../utils/tts';
import { createHttpTtsEngine } from '../utils/http-tts-engine';
import { createEdgeTtsEngine } from '../utils/edge-tts-engine';

/** 一档可选音色（= 上游 `TextToSpeech.getVoices()` 的一项） */
export interface SpeechVoice {
  id: string;
  name: string;
  lang: string;
}

/** 引擎抽象 —— 生产用 `createWebSpeechEngine()`；单测/探针注入替身（`createFakeEngine()`） */
export interface SpeechEngine {
  /** 环境有没有这个能力（没有 ⇒ 界面如实说明，别让按钮点了没反应） */
  available(): boolean;
  voices(): SpeechVoice[];
  speak(text: string, opts: {
    rate: number;
    voiceId: string | null;
    onStart: () => void;
    /** 正在读到的**句内**字符偏移（词级）；引擎不支持时不会回调 */
    onBoundary: (charIndex: number) => void;
    onEnd: () => void;
    onError: (message: string) => void;
  }): void;
  /**
   * `#842` 预取下一段音频（可选）。只有 HTTP TTS 引擎实现；系统语音没有预取概念。
   * 预取失败不能让朗读中断 ⇒ 由引擎内部吞掉，真正 `speak()` 时回退到串行请求。
   */
  prefetch?(text: string): void;
  cancel(): void;
}

export type ReadAloudState = 'idle' | 'playing' | 'paused';

/**
 * 音色来源（用户 2026-11-10 要求「用上 Edge 浏览器那套完整音色」）。
 *
 * · `system`：本机语音包（Chromium `speechSynthesis` / Windows SAPI）—— 默认，离线可用；
 * · `edge`：服务端内置的 Edge 云端 neural voices（免 Key、需联网，322 条）。
 *
 * ★ 为什么不是「往系统音色里多塞几条」：两者来源不同（本机 SAPI vs 云端），
 *   系统接口根本枚举不到 Edge 音色 ⇒ 只能作为**另一条合成后端**并存。
 */
export type VoiceSource = 'system' | 'edge';

const PREF_KEY = 'yuedu-read-aloud';

interface Prefs {
  rate: number;
  followSystem: boolean;
  voiceId: string | null;
  /** 音色来源：默认本机系统语音（不联网也能读） */
  voiceSource: VoiceSource;
  /** Edge 音色短名（`zh-CN-XiaoxiaoNeural`）；只在 `voiceSource === 'edge'` 时用 */
  edgeVoiceId: string | null;
  timerMinutes: number;
  chapterStop: number;
  followPosition: boolean;
  /** `#842` 两段之间的留白（ms；0 = 紧接） */
  gapMs: number;
}

const DEFAULT_PREFS: Prefs = {
  rate: DEFAULT_SPEECH_RATE,
  followSystem: true,
  voiceId: null,
  voiceSource: 'system',
  edgeVoiceId: null,
  timerMinutes: 0,
  chapterStop: 0,
  followPosition: true,
  gapMs: DEFAULT_GAP_MS,
};

/** localStorage 是**外部输入**（控制台手改 / 旧版本残留）⇒ 逐字段白名单校验，非法就回落默认 */
function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<Prefs>;
    const num = (v: unknown, min: number, max: number, dflt: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : dflt;
    return {
      rate: clampSpeechRate(num(raw.rate, 0, SPEECH_RATE_MAX, DEFAULT_PREFS.rate)),
      followSystem: typeof raw.followSystem === 'boolean' ? raw.followSystem : DEFAULT_PREFS.followSystem,
      voiceId: typeof raw.voiceId === 'string' && raw.voiceId ? raw.voiceId : null,
      voiceSource: raw.voiceSource === 'edge' ? 'edge' : 'system',
      edgeVoiceId: typeof raw.edgeVoiceId === 'string' && raw.edgeVoiceId ? raw.edgeVoiceId : null,
      timerMinutes: num(raw.timerMinutes, 0, TIMER_MAX_MIN, 0),
      chapterStop: num(raw.chapterStop, 0, 999, 0),
      followPosition: typeof raw.followPosition === 'boolean' ? raw.followPosition : DEFAULT_PREFS.followPosition,
      gapMs: clampGapMs(num(raw.gapMs, 0, GAP_MAX_MS, DEFAULT_PREFS.gapMs)),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * Web Speech 的错误码 → 人话（`#835`：不再把 `interrupted` / `synthesis-failed`
 * 这类英文原名直接怼到界面上）。
 * `interrupted` / `canceled` 是**我们自己 cancel() 的副产物** ⇒ 返回空串表示内部消化。
 */
function describeSpeechError(code: string): string {
  const c = String(code ?? '').trim().toLowerCase();
  if (!c || c === 'interrupted' || c === 'canceled' || c === 'cancelled') return '';
  switch (c) {
    case 'not-allowed':
      return '浏览器拦截了语音播放（请先点一下页面再试）';
    case 'audio-busy':
      return '音频设备忙，稍后再试';
    case 'audio-hardware':
      return '没有可用的音频输出设备';
    case 'network':
      return '系统语音合成网络错误';
    case 'synthesis-failed':
      return '系统语音合成失败（可换一个音色或改用在线引擎）';
    case 'language-unavailable':
      return '系统缺少该语言的语音包';
    case 'voice-unavailable':
      return '系统缺少这个音色（换一个音色再试）';
    case 'text-too-long':
      return '这一段太长，系统语音念不了';
    case 'invalid-argument':
      return '系统语音参数无效';
    default:
      return `系统语音出错（${c}）`;
  }
}

/** 生产引擎：`window.speechSynthesis` 的薄包装 */
export function createWebSpeechEngine(): SpeechEngine {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  /**
   * ★★ `#835` **代际号**：每次 `speak()` / `cancel()` 都递增。
   *
   * 为什么必须有：`speechSynthesis.cancel()` 会**异步**触发上一条 utterance 的
   * `onerror('interrupted')`；而朗读状态机在「上句/下句/右键朗读本段/章末换章」里
   * 都是「先 cancel 再 speak」。旧 utterance 的错误回调晚到 ⇒ 被当成**新播放**出错：
   * `onError` 把刚起播的声音 pause 掉，界面显示「朗读出错：interrupted」。
   * 用户实机四条路径（右键朗读本段 / 上句 / 下句 / 章末自动换章）全是这个时序。
   *
   * 规则：**回调只认自己这一代**。旧代的 onstart/onend/onboundary/onerror 一律丢弃，
   * 这类「被自己打断」的错误根本不该到达状态机。
   */
  let gen = 0;
  return {
    available: () => !!synth && typeof SpeechSynthesisUtterance !== 'undefined',
    voices: () => {
      if (!synth) return [];
      return synth.getVoices().map((v) => ({ id: v.voiceURI || v.name, name: v.name, lang: v.lang }));
    },
    speak(text, o) {
      const my = ++gen;
      if (!synth) {
        o.onError('当前浏览器没有语音合成能力');
        return;
      }
      // ① 先清干净：否则上一次的 utterance 还在队列里 ⇒ 叠着念
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = o.rate;
      if (o.voiceId) {
        const hit = synth.getVoices().find((v) => (v.voiceURI || v.name) === o.voiceId);
        if (hit) u.voice = hit;
      }
      u.onstart = () => { if (my === gen) o.onStart(); };
      u.onend = () => { if (my === gen) o.onEnd(); };
      u.onerror = (e) => {
        if (my !== gen) return; // 旧代（已被 cancel/新 speak 顶掉）⇒ 内部消化
        const friendly = describeSpeechError(String((e as SpeechSynthesisErrorEvent)?.error ?? 'speech error'));
        if (!friendly) return; // `interrupted` / `canceled`：自己打断自己，不报给用户
        o.onError(friendly);
      };
      // Chromium 支持词级 boundary（其余浏览器可能只给 word/sentence 或不给）⇒ 有就用，没有就降级
      u.onboundary = (e) => {
        if (my !== gen) return;
        if (typeof e.charIndex === 'number') o.onBoundary(e.charIndex);
      };
      synth.speak(u);
    },
    cancel: () => {
      gen += 1; // 让在途 utterance 的所有回调失效（错误不再上浮）
      synth?.cancel();
    },
  };
}

/** 替身引擎：单测/探针用（不发声，可手动推进） */
export function createFakeEngine(): SpeechEngine & { emitEnd(): void; spoken: string[] } {
  const spoken: string[] = [];
  let end: (() => void) | null = null;
  return {
    spoken,
    available: () => true,
    voices: () => [{ id: 'fake', name: '测试音色', lang: 'zh-CN' }],
    speak(text, o) {
      spoken.push(text);
      o.onStart();
      end = o.onEnd;
    },
    cancel: () => {
      end = null;
    },
    emitEnd() {
      const f = end;
      end = null;
      f?.();
    },
  };
}

export const useReadAloudStore = defineStore('readAloud', () => {
  const reader = useReaderStore();

  const prefs = ref<Prefs>(readPrefs());
  const state = ref<ReadAloudState>('idle');
  /** 当前章的句子表（`splitSentences(chapterText)`） */
  const sentences = ref<Sentence[]>([]);
  /** 正在朗读的句子下标（= 上游 `nowSpeak`） */
  const index = ref(0);
  /** 句内已读到的偏移（= 上游 `paragraphStartPos`；暂停后从这里续读） */
  const innerPos = ref(0);
  /**
   * 当前章标题（**与阅读页页眉同一处**：`reader.displayTitle` —— 简繁转换后的显示标题）。
   * 歌词窗 / 朗读控制条 / 条形窗都用这一份，不再各自去拼 `detail.title + chapter.title`。
   */
  const chapterTitle = computed(() => (reader.displayTitle ?? '').trim());
  /** 本章标题是否已经念过（换章 / 停止 / 复位后清零 ⇒ 每章只在开头念一次） */
  const titleSpoken = ref(false);
  /** 正在念章节标题（界面据此把标题当作「当前行」显示） */
  const speakingTitle = ref(false);
  /** 本次播放已读完的章数（章节停用） */
  const chaptersDone = ref(0);
  /** 定时剩余毫秒（0 = 未设） */
  const timerRemainMs = ref(0);
  /** 最近的错误（界面要如实显示，不静默） */
  const error = ref('');
  /**
   * 当前朗读后端：
   * · `web` = 本机系统语音（`speechSynthesis`）；
   * · `http` = 设置页配置的 HTTP TTS 引擎（优先级最高：它是全局显式配置）；
   * · `edge` = 内置 Edge 云端音色（朗读设置里显式选「Edge 在线音色」才走）。
   */
  const backend = ref<'web' | 'http' | 'edge'>('web');
  /** HTTP 模式下正在用的引擎（界面显示「在线 · 名字」） */
  const backendEngineId = ref('');
  const backendName = ref('');
  /** 引擎（可在测试里替换） */
  let engine: SpeechEngine = createWebSpeechEngine();
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  /**
   * `#842` 句间停顿定时器。
   * 暂停/停止/跳句/换章/切引擎必须清掉 —— 否则定时器会在用户已经离开后
   * 再执行一次 `advance()`，表现为「暂停了又自己念下一句」。
   */
  let gapTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * **真实起播**指针：已出声的句子下标（`-1` = 还没有任何一句真正开始出声）。
   *
   * ★ 为什么单独一个下标：`index` 是「正在排队/正在合成」的句子，网络引擎（Edge / HTTP）
   *   从发请求到出声有 0.3~1.5s 的窗口。若高亮/歌词直接读 `index`，就会「按了播放、
   *   声音还没来，已读色已经开始跑」—— 用户 2026-11-10 明确要求着色由**真实播放**驱动。
   *   所以：`index` 可以提前指到下一句，但 `currentText` / `currentPos` 只认 `audibleIndex`。
   */
  const audibleIndex = ref(-1);
  /** 章节标题这条 utterance 是否**已经出声**（标题也会提前排队，同样不能抢跑） */
  const titleAudible = ref(false);
  /**
   * 已排队但**尚未起播**的句子下标（新句在 `onStart` 才提交到 `index`）。
   * 提交延迟到起播前一刻 ⇒ 任何按 `index` 推进的消费者（歌词/高亮）都不会提前跳。
   */
  let pendingIndex: number | null = null;

  const isPlaying = computed(() => state.value === 'playing');
  const isPaused = computed(() => state.value === 'paused');
  const active = computed(() => state.value !== 'idle');

  /**
   * 当前**已出声**的句子文本（界面显示「正在念：…」；念标题阶段就是标题）。
   * 未起播时返回空串 —— 宁可短暂空一行，也不能让歌词/着色先跑。
   */
  const currentText = computed(() => {
    if (speakingTitle.value) return titleAudible.value ? chapterTitle.value : '';
    return audibleIndex.value >= 0 ? (sentences.value[audibleIndex.value]?.text ?? '') : '';
  });
  /** 当前**已出声**句的章内字符偏移（与正文渲染同一坐标系 ⇒ 可直接给滚动/高亮用） */
  const currentPos = computed(() => {
    const s = sentences.value[audibleIndex.value];
    return s ? s.start + innerPos.value : 0;
  });
  /** 当前句落在第几段（`data-p` 用的下标；跟随滚动靠它） */
  const currentParagraph = computed(() => {
    if (audibleIndex.value < 0) return -1; // 还没出声 ⇒ 不点亮任何段（不许抢跑）
    const paras = reader.displayParagraphs ?? [];
    if (!paras.length) return -1;
    return bodyPosToPara(buildChapterText(paras), currentPos.value).para;
  });
  /** 语速显示值（上游 `upTtsSpeechRateText`） */
  const rateLabel = computed(() => String(speechRateOf(prefs.value.rate, prefs.value.followSystem)));
  /** 当前是否走 HTTP TTS（界面据此隐藏系统音色、显示引擎名） */
  const usingHttpTts = computed(() => backend.value === 'http');
  /** 当前是否走内置 Edge 在线音色（界面显示 Edge 音色列表 + 联网提示） */
  const usingEdgeTts = computed(() => backend.value === 'edge');
  /** 当前是否走本机系统语音（只有它能离线、能枚举 `getVoices()`） */
  const usingSystemTts = computed(() => backend.value === 'web');
  const engineLabel = computed(() => {
    if (usingHttpTts.value) return backendName.value || '未选择';
    if (usingEdgeTts.value) return `Edge · ${prefs.value.edgeVoiceId ?? '未选音色'}`;
    return '系统语音';
  });
  /** HTTP 模式但没得用：`missing` = 没选默认引擎；`disabled` = 选了但没启用 */
  const backendBlocked = ref<'' | 'missing' | 'disabled'>('');
  /**
   * `#873` 设置面 → 朗读后端的**变化指纹**（换引擎/换音色槽/改配置/改开关）。
   * 只比 engineId 会把「同引擎改配置」「切副音色槽」漏掉 ⇒ 换了设置却还用旧引擎念。
   */
  const backendSignature = ref('');
  /** `#873` 引擎级段间静音（Legado `pauseDuration`；0 = 用全局 `gapMs`） */
  const httpPauseMs = ref(0);
  /** `#873` 切换反馈（朗读条短暂显示；空 = 无提示） */
  const engineNotice = ref('');
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  function noticeEngine(text: string): void {
    engineNotice.value = text;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      engineNotice.value = '';
    }, 4000);
  }
  /** 定时显示（分钟；0 = 未设置） */
  const timerMinutes = computed(() => (timerRemainMs.value > 0 ? Math.ceil(timerRemainMs.value / 60_000) : 0));

  function savePrefs(): void {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs.value));
    } catch {
      /* 存不下不影响朗读本身（铁律 3：这里不需要打断用户，但偏好会在下次回落默认） */
    }
  }

  /** 章内正文（**显示层**：与渲染、划线、搜索同一份文本） */
  function chapterBody(): string {
    return buildChapterText(reader.displayParagraphs ?? []).text;
  }

  /**
   * 重新切句（换章 / 简繁切换 / 首次朗读都要走这里）。
   *
   * ★ HTTP TTS 用**内核分段**（`segmentTtsText`，最长 240 字/段）而不是客户端逐句：
   *   一次合成请求覆盖一段，句间就不会有「每句一个网络往返」的长停顿。
   *   分段失败（整章只有标点等）回落到逐句，让原有的「没有可朗读内容」路径继续生效。
   *
   * ★★ **Edge 不走分段**（用户 2026-11-10 实测纠正）：分段会把 3~5 句合并成
   *   「一整段长文字」，朗读条/歌词窗一次跳一大块，和系统语音的逐句体验不一致。
   *   Edge 仍是「一句一次请求」，靠 `engine.prefetch()` 预取下一句抵消网络延迟
   *   ⇒ 耳朵听到的仍是逐句，歌词与高亮也逐句推进。
   */
  function rebuild(): void {
    const text = chapterBody();
    if (backend.value === 'http') {
      const segs = segmentForReadAloud(text);
      sentences.value = segs.length ? segs : splitSentences(text);
      return;
    }
    sentences.value = splitSentences(text);
  }

  /**
   * 切换朗读后端（系统语音 ⇄ HTTP TTS ⇄ Edge 在线音色）。
   *
   * ★ 换引擎**不重置进度**：按当前章内偏移在新分段表里重新定位（`locateSentence`），
   *   正在播就接着播 —— 设置页改了默认引擎后，用户不该被弹回本章开头。
   */
  function applyEngine(
    next: SpeechEngine,
    kind: 'web' | 'http' | 'edge',
    id: string,
    name: string,
    blocked: '' | 'missing' | 'disabled' = '',
    signature = '',
    pauseMs = 0,
  ): void {
    const pos = active.value ? currentPos.value : 0;
    const wasPlaying = state.value === 'playing';
    const wasActive = active.value;
    const prevKind = backend.value;
    const prevId = backendEngineId.value;
    const prevSig = backendSignature.value;
    clearGapTimer();
    // ★ 代际作废：`engine.cancel()` 会把在飞 utterance / 已预取音频的 seq 作废，旧引擎不会再出声
    engine.cancel();
    engine = next;
    backend.value = kind;
    backendEngineId.value = id;
    backendName.value = name;
    backendBlocked.value = blocked;
    backendSignature.value = signature;
    httpPauseMs.value = kind === 'http' ? Math.max(0, Math.min(pauseMs, 10_000)) : 0;
    if (wasActive) {
      rebuild();
      const loc = locateSentence(sentences.value, pos);
      index.value = loc.index < 0 ? 0 : loc.index;
      innerPos.value = loc.index < 0 ? 0 : loc.innerPos;
      /**
       * 换引擎后句子表已换新：旧 `audibleIndex` 指向的文本已不存在。
       * 播放中先清空（等新引擎真正出声再点亮），暂停/空闲时直接对齐到定位句。
       */
      pendingIndex = null;
      audibleIndex.value = wasPlaying ? -1 : (loc.index < 0 ? -1 : loc.index);
      if (wasPlaying) { state.value = 'playing'; speakCurrent(); }
    }
    /**
     * `#873` 切换反馈：只有「用户改设置引发的切换」才提示（`prevSig` 非空且变了）。
     * 开朗读前的首次解析不打扰；切换本身已由上面的 `cancel()+speakCurrent()` 立即生效。
     */
    if (wasActive && prevSig && signature !== prevSig) {
      const tail = wasPlaying ? '，从当前句继续' : '，继续朗读时生效';
      if (blocked === 'disabled') noticeEngine(`所选引擎「${name || '未命名'}」未启用${tail}`);
      else if (blocked === 'missing') noticeEngine(`默认朗读引擎已取消${tail}`);
      else if (kind === 'http' && (prevKind !== 'http' || prevId !== id)) noticeEngine(`已切换到「${name || id}」${tail}`);
      else if (kind === 'http') noticeEngine(`已应用「${name}」的新配置${tail}`);
      else if (kind === 'edge') noticeEngine(`已切换到 Edge 在线音色（需联网）${tail}`);
      else noticeEngine(prevKind !== 'web' ? `已回到本机系统语音（离线可用）${tail}` : `朗读设置已更新${tail}`);
    }
  }

  /** 读设置页的 TTS 配置并切换后端（阅读页每次开朗读前调一次；设置页改完也会回灌） */
  let backendLoading: Promise<void> | null = null;
  function refreshTtsBackend(): Promise<void> {
    if (backendLoading) return backendLoading;
    backendLoading = (async () => {
      try {
        const cfg = await getTtsConfig();
        const target = cfg.engines.find((e) => e.id === cfg.defaultEngineId);
        const speed = () => speechRateOf(prefs.value.rate, prefs.value.followSystem);
        /**
         * ★ 指纹里必须带上**音色来源**：只比 HTTP 设置的话，
         *   用户把来源从「系统语音」切到「Edge」时指纹不变 ⇒ 这里直接 return，切换静默失效。
         */
        const edgeSig = prefs.value.voiceSource === 'edge' ? `edge:${prefs.value.edgeVoiceId ?? ''}` : 'system';
        const signature = `${ttsBackendSignature(cfg, target)}|src:${edgeSig}`;
        // 设置没变 ⇒ 不重建/不重启（打开阅读页时不会把正在念的句子打断）
        if (backendSignature.value === signature) return;
        // ① 设置页显式配置的 HTTP TTS 引擎优先级最高（全局开关 + 默认引擎）
        if (cfg.enabled) {
          if (target?.enabled) {
            applyEngine(
              createHttpTtsEngine({ engineId: target.id, speed }),
              'http',
              target.id,
              target.name,
              '',
              signature,
              target.pauseDuration ?? 0,
            );
          } else {
            applyEngine(
              createHttpTtsEngine({ engineId: '', speed }),
              'http',
              '',
              target?.name || '',
              target ? 'disabled' : 'missing',
              signature,
            );
          }
          return;
        }
        // ② 朗读设置里显式选了 Edge 在线音色（免 Key、需联网）
        if (prefs.value.voiceSource === 'edge') {
          applyEngine(
            createEdgeTtsEngine({ voice: () => prefs.value.edgeVoiceId, speed }),
            'edge',
            '',
            'Edge 在线音色',
            '',
            signature,
          );
          return;
        }
        // ③ 默认：本机系统语音（离线可用）
        applyEngine(createWebSpeechEngine(), 'web', '', '', '', signature);
      } catch {
        // 旧服务端没有 `/api/tts/*`（或一时网络抖动）：回落系统语音，别把朗读入口变成死按钮
        if (backend.value !== 'web') {
          applyEngine(createWebSpeechEngine(), 'web', '', '', '', backendSignature.value);
          // Edge 是服务端能力 ⇒ 解析失败时如实说明已回落（不静默改变用户听到的声音）
          if (prefs.value.voiceSource === 'edge') {
            error.value = '在线音色暂时不可用（服务端无响应），已切回本机系统语音';
          }
        }
      }
    })();
    return backendLoading.finally(() => { backendLoading = null; });
  }

  function clearTimers(): void {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  /** 清掉句间停顿时钟（停/暂停/跳句/换章/切引擎都调） */
  function clearGapTimer(): void {
    if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  }

  /** `onEnd` 后的推进：先留静默，再念下一段（引擎级 `pauseDuration` 优先，0 = 全局 `gapMs`） */
  function scheduleAdvance(): void {
    clearGapTimer();
    const ms = backend.value === 'http' && httpPauseMs.value > 0 ? httpPauseMs.value : prefs.value.gapMs;
    if (ms <= 0) { advance(); return; }
    gapTimer = setTimeout(() => {
      gapTimer = null;
      advance();
    }, ms);
  }

  function finish(reason?: string): void {
    clearGapTimer();
    engine.cancel();
    clearTimers();
    state.value = 'idle';
    index.value = 0;
    innerPos.value = 0;
    // 停止 = 没有任何一句在出声 ⇒ 着色/歌词的「真实起播」指针一并清掉
    audibleIndex.value = -1;
    titleAudible.value = false;
    pendingIndex = null;
    titleSpoken.value = false;
    speakingTitle.value = false;
    sentences.value = [];
    timerRemainMs.value = 0;
    /**
     * ★ 本次播放已读完的章数必须归零。
     *   上游在 `BaseReadAloudService.onCreate()`（服务启动）与 `onDestroy()` 里都写
     *   `chapterToStopTimer.clear(); chapterToStop = 0` ⇒ **每次重新开始朗读都从零数**。
     *   漏了这一步的后果很隐蔽：用户设「读 2 章停」，读了 1 章手动停止，再开始时
     *   计数是 1 ⇒ **读完第 1 章就停**（用户以为设的是 2 章）。
     *   由 `scripts/probe-203-read-aloud.mjs` J 段抓到。
     */
    chaptersDone.value = 0;
    if (reason) error.value = reason;
  }

  /**
   * 从 `index`/`innerPos` 处开始念一句，并在结束时推进。
   * ★ 每次只提交**一句**：这样 `pause` 的「停住 + 记住位置」才是精确的（上游同款做法）。
   *
   * ★★ 跳段用 **while 循环**而不是「跳一段就 `advance()` 再进来」的递归：
   *   一章里「整句都是标点」的连续段（表格线、装饰符号、引文残片）能有几百句，
   *   递归深度 = 句数 ⇒ 爆栈。这是**静默**故障（只在特定正文上出现），必须避免。
   */
  function speakCurrent(target?: number): void {
    if (state.value !== 'playing') return;
    // 任何「正在起播」都必须先取消待执行的句间停顿（否则会多推进一句）
    clearGapTimer();
    const list = sentences.value;
    if (!list.length) {
      void nextChapter(true);
      return;
    }
    /**
     * 每章开头先念**章节标题**（用户 2026-11-10：朗读/歌词都缺标题）。
     * 标题不属于正文（不占 `buildChapterText` 的字符偏移），所以**单独一条 utterance**：
     * 念完再进第一句，`currentText`/歌词窗在标题期间把标题当当前行，天然复用三行轨道。
     * `titleSpoken` 保证每章只念一次；换章 / 停止 / 复位时清掉。
     *
     * ★ 上游依据（`F:\legado`）：`TextChapterLayout` 把标题排成独立的 `title:*` 段落项，
     *   且标题文字同样 append 进章文本（`stringBuilder.append(lineText)`），
     *   `ParagraphSpeechQueue.build` 只过滤图片/空白/纯标点 ⇒ **标题会作为正文前的第一段被念**。
     *   但上游是「按当前进度位置起播」（`ParagraphPosition.findItemIndex(items, position)`），
     *   所以只有**从章首起播**才念标题；从中间段落起播（「朗读本段」）不回头念，这里按同一口径。
     */
    if (!titleSpoken.value) {
      const atChapterStart = (target ?? index.value) === 0 && innerPos.value === 0;
      const title = atChapterStart ? chapterTitle.value : '';
      if (title) {
        speakingTitle.value = true;
        // ★ 与正文句同一纪律：标题也是「先排队、后出声」⇒ 出声前不许点亮
        titleAudible.value = false;
        engine.speak(title, {
          rate: speechRateOf(prefs.value.rate, prefs.value.followSystem),
          voiceId: prefs.value.voiceId,
          onStart: () => { error.value = ''; titleAudible.value = true; },
          onBoundary: () => { /* 标题按整行高亮，不需要词级进度 */ },
          onEnd: () => {
            speakingTitle.value = false;
            titleAudible.value = false;
            titleSpoken.value = true;
            speakCurrent();
          },
          onError: (msg) => {
            speakingTitle.value = false;
            titleAudible.value = false;
            error.value = `朗读出错：${msg}`;
            pause();
          },
        });
        return;
      }
      // 本章没有标题，或本次是从章中间起播（标题已在身后）⇒ 别为它反复进这个分支
      titleSpoken.value = true;
    }
    speakingTitle.value = false;
    /**
     * 从 `target`（默认当前句）向前找第一句「有内容且不是纯标点」的。
     *
     * ★★ **不在这里写 `index`**：网络引擎（Edge / HTTP）从提交到出声有一个等待窗口，
     *   提前写 `index` 会让歌词/高亮先跳 —— 用户 2026-11-10 报的「声音没来着色先跑」。
     *   新句只记到 `pendingIndex`，等引擎 `onStart` 再落到 `index` / `innerPos`。
     */
    let i = Math.max(0, Math.min(target ?? index.value, list.length - 1));
    let base = i === index.value ? Math.min(innerPos.value, list[i]!.text.length) : 0;
    let text = list[i]!.text.slice(base);
    while (!text.trim() || isNotReadAloud(text)) {
      i += 1;
      if (i >= list.length) {
        void nextChapter(true); // 章尾 ⇒ 自动续下一章
        return;
      }
      base = 0;
      text = list[i]!.text;
    }
    const cur = list[i]!;
    if (i !== index.value) pendingIndex = i;
    engine.speak(text, {
      rate: speechRateOf(prefs.value.rate, prefs.value.followSystem),
      voiceId: prefs.value.voiceId,
      onStart: () => {
        error.value = '';
        // ★ 真实起播的这一刻才提交「当前句」：着色/歌词从这一帧开始，不许提前
        if (pendingIndex !== null) {
          index.value = pendingIndex;
          innerPos.value = 0;
          pendingIndex = null;
        }
        audibleIndex.value = index.value;
      },
      /**
       * ★★ `charIndex` 是**相对本次 utterance 文本的绝对索引**，不是增量 ——
       *   Web Speech 规范原文：「the zero-based character index into the **original utterance
       *   string** that most closely approximates the current speaking position」。
       *   以前这里写成 `innerPos.value + charIndex`（**累加**）⇒ 位置**成倍放大**：
       *   恢复朗读时 `innerPos` 已是句内偏移，再累加一个绝对索引就冲到很后面
       *   ⇒ 表现正是用户报的「读的是第 2 段，高亮却跑到第 3 段，然后自己继续向下跑」。
       *   正确换算：句内偏移 = 起始基准 `base` + `charIndex`（**赋值，不是累加**）。
       *
       * ★ 参考做法（用户提供的起点听书脚本）：它是**每个段落一个 utterance**，
       *   高亮与朗读都按**同一个段号**推进 ⇒ 天然同步，不存在偏移换算问题。
       *   本仓按**句**切分（更细，跟随更准），所以必须自己守住这个换算。
       */
      onBoundary: (charIndex) => {
        // 收敛到句长内：charIndex 超界时（少数引擎会报句末）不该把高亮甩到下一段
        innerPos.value = Math.max(0, Math.min(base + charIndex, cur.text.length));
      },
      onEnd: () => {
        // 少数引擎不给 `onStart` ⇒ 在这里补提交，别让 `index` 卡在上一句
        if (pendingIndex !== null) {
          index.value = pendingIndex;
          innerPos.value = 0;
          pendingIndex = null;
        }
        // 读完保持句末（着色不回拨）；下一句起播时 `onStart` 再归零
        innerPos.value = cur.text.length;
        scheduleAdvance();
      },
      onError: (msg) => {
        // 不静默：「念不出来」必须让用户看见（铁律 3）
        error.value = `朗读出错：${msg}`;
        pause();
      },
    });
    /**
     * `#842` 起播成功后立刻预取**下一段**。
     * 旧行为是等 `ended` 之后才请求下一段 ⇒ 间隙里白等一个完整网络往返。
     * 这里提前把下一段拉回来；`onEnd` 后 `speak()` 命中引擎缓存，间隙只剩句间停顿。
     * 预取失败由引擎吞掉，下一次 `speak()` 仍走原来的串行请求（不中断朗读）。
     * ★ Edge 为逐句请求，这一步是它不掉队的**关键**（否则每句都等一次网络往返）。
     */
    const nextIdx = nextSpeakableIndex(list, i + 1);
    if (nextIdx >= 0) engine.prefetch?.(list[nextIdx]!.text);
  }

  /**
   * 推进到**当前句之后**第一个可朗读的句子；越过章尾 ⇒ 自动续章。
   *
   * ⚠️ `from` 是「**从哪一句开始找（含）**」，调用方必须传 `index + 1` 之类的相对位置。
   * ★ 第一版这里写的是 `advance(1)`（把「1」当成「往后一步」）⇒ 每次句末都从**第 1 句**重新找，
   *   于是永远返回同一下标、`index` 卡在 1 不动 —— 表现是「一直重复念同一句」，
   *   而且**不报任何错**（探针 `probe-203-read-aloud.mjs` C/E 段抓到）。故这里改成**无参**，
   *   由本函数自己算 `index + 1`，从根上不给「传错成绝对下标」的机会。
   */
  function advance(): void {
    if (state.value !== 'playing') return;
    const next = nextSpeakableIndex(sentences.value, index.value + 1);
    if (next < 0) {
      void nextChapter(true);
      return;
    }
    // ★ 只排队，不写 `index`：真正跳行发生在下一句 `onStart`（见 `speakCurrent`）
    speakCurrent(next);
  }

  function startTicker(): void {
    clearTimers();
    // 定时（分钟）：到点即停
    if (timerRemainMs.value > 0) {
      ticker = setInterval(() => {
        timerRemainMs.value = Math.max(0, timerRemainMs.value - 1000);
        if (timerRemainMs.value === 0) finish();
      }, 1000);
    }
    /**
     * ★ Chromium 的 `speechSynthesis` 有一个长期问题：连续说话时可能「停住不再出声」。
     * 社区通行做法是周期性 `resume()` 把队列唤醒（对已经是 speaking 的状态是幂等的）。
     * 这是**平台缺陷的规避**，不是上游语义（Android 的 TextToSpeech 不需要这一步）。
     */
    if (backend.value === 'web') {
      keepAlive = setInterval(() => {
        if (state.value !== 'playing') return;
        const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
        try { synth?.resume(); } catch { /* 引擎不支持就算了，不影响正常路径 */ }
      }, 5000);
    }
  }

  /** 开始/继续朗读当前章 */
  function play(): void {
    if (backend.value === 'http' && backendBlocked.value) {
      error.value = backendBlocked.value === 'disabled'
        ? '这条朗读引擎没启用（去「设置 → 朗读」里打开它）'
        : '还没有选择朗读引擎（去「设置 → 朗读」里选一条）';
      return;
    }
    if (!engine.available()) {
      error.value = '当前浏览器没有语音合成能力（speechSynthesis 不可用）';
      return;
    }
    if (state.value === 'playing') return;
    if (!reader.chapter?.paragraphs?.length) {
      error.value = '当前章节没有可朗读的正文';
      return;
    }
    if (!sentences.value.length) {
      rebuild();
      // 续读：没有历史位置就从第一句有字的开始
      const first = nextSpeakableIndex(sentences.value, 0);
      index.value = first < 0 ? 0 : first;
    }
    // ★ 本次播放的着色从「第一声真正出来」开始：起播前 `audibleIndex = -1`
    audibleIndex.value = -1;
    titleAudible.value = false;
    pendingIndex = null;
    state.value = 'playing';
    error.value = '';
    startTicker();
    speakCurrent();
  }

  /** 暂停（记住位置；`resume()` 从这里继续） */
  function pause(): void {
    if (state.value !== 'playing') return;
    clearGapTimer();
    engine.cancel();
    /**
     * 已排队但还没出声的句子：暂停时把它**提交**为当前位置，
     * 这样 `resume()` 会从这一句重新开始（而不是把上一句再念一遍）。
     * 此时没有声音 ⇒ 不设 `audibleIndex`，着色仍停在上一句（暂停不该跳跃）。
     */
    if (pendingIndex !== null) {
      index.value = pendingIndex;
      innerPos.value = 0;
      pendingIndex = null;
    }
    // 标题这条 utterance 也被取消了 ⇒ 不再处于「正在念标题」；恢复时从头念标题（titleSpoken 仍为 false）
    speakingTitle.value = false;
    titleAudible.value = false;
    clearTimers();
    state.value = 'paused';
  }

  function resume(): void {
    play();
  }

  function stop(): void {
    finish();
  }

  /** 上一段 / 下一段（段 = 句，对齐上游 `prevParagraph`/`nextParagraph`） */
  function prevParagraph(): void {
    if (!sentences.value.length) return;
    if (speakingTitle.value) return; // 已在章首（标题就是本章第一行）
    const i = prevSpeakableIndex(sentences.value, index.value - 1);
    if (i < 0) return;
    if (state.value === 'playing') {
      // 播放中：只排队，`index`/着色等下一句真正出声再跳
      engine.cancel();
      speakCurrent(i);
      return;
    }
    index.value = i;
    innerPos.value = 0;
    audibleIndex.value = i; // 暂停态下手动切句：没有声音，界面就地跟随用户操作
    pendingIndex = null;
  }
  function nextParagraph(): void {
    if (!sentences.value.length) return;
    // 正在念标题：标题不是正文句 ⇒「下一句」= 进入本章第一句（不是跳过第一句）
    if (speakingTitle.value) {
      titleSpoken.value = true;
      speakingTitle.value = false;
      if (state.value === 'playing') { engine.cancel(); speakCurrent(); }
      return;
    }
    const i = nextSpeakableIndex(sentences.value, index.value + 1);
    if (i < 0) { void nextChapter(true); return; }
    if (state.value === 'playing') {
      engine.cancel();
      speakCurrent(i);
      return;
    }
    index.value = i;
    innerPos.value = 0;
    audibleIndex.value = i;
    pendingIndex = null;
  }

  /** 上一章 / 下一章（`auto` = 朗读到章尾自动续；自动续章不计入「章节停」以外的干预） */
  async function stepChapter(delta: number, auto: boolean): Promise<void> {
    const chs = reader.detail?.chapters ?? [];
    const at = reader.chapterIdx;
    const target = at + delta;
    if (at < 0 || target < 0 || target >= chs.length) {
      if (auto) finish('已到最后一章，朗读结束');
      return;
    }
    if (auto) {
      chaptersDone.value += 1;
      if (chapterStopReached(chaptersDone.value, prefs.value.chapterStop)) {
        finish(`已朗读 ${chaptersDone.value} 章（章节停）`);
        return;
      }
    }
    const wasPlaying = state.value === 'playing';
    sentences.value = [];
    index.value = 0;
    innerPos.value = 0;
    audibleIndex.value = -1; // 新章还没出声 ⇒ 不许点亮
    titleAudible.value = false;
    pendingIndex = null;
    titleSpoken.value = false; // 新章 ⇒ 标题重新念
    speakingTitle.value = false;
    await reader.openChapter(chs[target]!);
    rebuild();
    if (wasPlaying) { state.value = 'playing'; speakCurrent(); }
  }
  const nextChapter = (auto = false) => stepChapter(1, auto);
  const prevChapter = () => stepChapter(-1, false);

  /* ---- 偏好设置（全部落 localStorage） ---- */
  function setRate(v: number): void {
    prefs.value.rate = clampSpeechRate(v);
    savePrefs();
    if (state.value === 'playing') { engine.cancel(); speakCurrent(); } // 立即生效
  }
  function setFollowSystem(v: boolean): void {
    prefs.value.followSystem = !!v;
    savePrefs();
    if (state.value === 'playing') { engine.cancel(); speakCurrent(); }
  }
  function setVoice(v: string | null): void {
    prefs.value.voiceId = v || null;
    savePrefs();
  }
  /**
   * 切换音色来源（本机系统语音 ⇄ Edge 在线音色）。
   *
   * 切到 Edge 时若还没选过音色 ⇒ 落到默认中文音色，避免「切过去却没声音」。
   * 真正的引擎切换交给 `refreshTtsBackend()`（它会把正在播的那句接着念完）。
   */
  function setVoiceSource(v: VoiceSource): void {
    const next: VoiceSource = v === 'edge' ? 'edge' : 'system';
    if (next === 'edge' && !prefs.value.edgeVoiceId) prefs.value.edgeVoiceId = DEFAULT_EDGE_VOICE;
    if (prefs.value.voiceSource === next) return;
    prefs.value.voiceSource = next;
    savePrefs();
    void refreshTtsBackend();
  }
  /** 选 Edge 音色（只在来源为 Edge 时生效；正在读会从当前句重起，立刻换声） */
  function setEdgeVoice(id: string | null): void {
    const next = id || null;
    if (prefs.value.edgeVoiceId === next) return;
    prefs.value.edgeVoiceId = next;
    savePrefs();
    if (prefs.value.voiceSource === 'edge') void refreshTtsBackend();
  }
  function setFollowPosition(v: boolean): void {
    prefs.value.followPosition = !!v;
    savePrefs();
  }
  /** 定时：`minute = 0` ⇒ 关闭 */
  function setTimer(minute: number): void {
    const m = Math.max(0, Math.min(TIMER_MAX_MIN, Math.round(minute) || 0));
    prefs.value.timerMinutes = m;
    timerRemainMs.value = m * 60_000;
    savePrefs();
    if (state.value === 'playing') startTicker();
  }
  /** 章节停：`count = 0` ⇒ 关闭 */
  function setChapterStop(count: number): void {
    prefs.value.chapterStop = Math.max(0, Math.min(999, Math.round(count) || 0));
    chaptersDone.value = 0;
    savePrefs();
  }
  /** `#842` 句间停顿：0~800ms，0 = 紧接 */
  function setGapMs(v: number): void {
    prefs.value.gapMs = clampGapMs(v);
    savePrefs();
  }

  /** 换书/关浮层时复位（不清偏好） */
  function reset(): void {
    clearGapTimer();
    engine.cancel();
    clearTimers();
    state.value = 'idle';
    sentences.value = [];
    index.value = 0;
    innerPos.value = 0;
    audibleIndex.value = -1;
    titleAudible.value = false;
    pendingIndex = null;
    titleSpoken.value = false;
    speakingTitle.value = false;
    chaptersDone.value = 0;
    error.value = '';
  }

  /** 章内容变化（换章 / 简繁转换 / 净化）⇒ 重新切句；正在朗读则从新章第一句继续 */
  watch(
    () => reader.displayParagraphs,
    () => {
      if (!active.value) return;
      const wasPlaying = state.value === 'playing';
      clearGapTimer();
      if (wasPlaying) engine.cancel();
      titleSpoken.value = false; // 章内容换了（换章 / 简繁转换）⇒ 标题重新念
      speakingTitle.value = false;
      titleAudible.value = false;
      pendingIndex = null;
      rebuild();
      const first = nextSpeakableIndex(sentences.value, 0);
      index.value = first < 0 ? 0 : first;
      innerPos.value = 0;
      audibleIndex.value = wasPlaying ? -1 : (first < 0 ? -1 : first);
      if (wasPlaying) { state.value = 'playing'; speakCurrent(); }
    },
  );
  /** 关阅读浮层 ⇒ 停朗读（否则声音会在关掉界面后继续） */
  watch(() => reader.open, (v) => { if (!v) reset(); });

  /** 仅测试/探针用：替换引擎（同时把后端标记回系统语音，避免和真实 TTS 配置串味） */
  function __setEngine(e: SpeechEngine): void {
    engine = e;
    backend.value = 'web';
    backendEngineId.value = '';
    backendName.value = '';
    backendBlocked.value = '';
  }

  return {
    prefs, state, isPlaying, isPaused, active, sentences, index, innerPos, error, engineNotice,
    chapterTitle, titleSpoken, speakingTitle,
    currentText, currentPos, currentParagraph, rateLabel, timerMinutes, chaptersDone,
    usingHttpTts, usingEdgeTts, usingSystemTts, engineLabel,
    play, pause, resume, stop, prevParagraph, nextParagraph, nextChapter, prevChapter,
    setRate, setFollowSystem, setVoice, setVoiceSource, setEdgeVoice,
    setFollowPosition, setTimer, setChapterStop, setGapMs, reset,
    refreshSentences: rebuild, refreshTtsBackend,
    __setEngine,
  };
});
