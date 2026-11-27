/**
 * 朗读（TTS）的**纯逻辑**（`#203`）—— 不含任何 Web API 调用，可单测。
 *
 * ## 上游对应（逐条可核对，不猜）
 * | 本文件 | 上游 | 出处 |
 * |---|---|---|
 * | `isNotReadAloud` | `AppPattern.notReadAloudRegex` | `constant/AppPattern.kt:60` = `^(\s\|\p{C}\|\p{P}\|\p{Z}\|\p{S})+$` |
 * | `speechRateOf` | `upSpeechRate()` | `service/TTSReadAloudService.kt:181` = `(AppConfig.ttsSpeechRate + 5) / 10f` |
 * | `DEFAULT_SPEECH_RATE` | `AppConfig.defaultSpeechRate` | `help/config/AppConfig.kt:398` = **5** |
 * | `SPEECH_RATE_MAX` | 语速滑条 | `res/layout/dialog_read_aloud.xml` 的 `seek_tts_speechRate android:max=` **45** |
 * | `TIMER_MAX_MIN` | 定时滑条 | 同文件 `seek_timer android:max=` **180** |
 * | `speechRateLabel` | `upTtsSpeechRateText` | `ui/book/read/config/ReadAloudDialog.kt` = `((value + 5) / 10f).toString()` |
 *
 * ## 与上游的两处**有意**差异（都写明理由）
 * 1. **分句用 `Intl.Segmenter`**（上游是 Java `BreakIterator.getSentenceInstance()`）。两者都做「按句切」，
 *    语言相关的边界规则不可能逐字节一致；取不到 `Intl.Segmenter` 时退化为「按中英句末标点切」，**绝不抛错**。
 * 2. **不做按页朗读**（上游 `readAloudByPage`）：Web 端阅读器是**连续滚动**，没有「页」这个稳定单位；
 *    跟随位置改为「滚动到当前段落」。
 */

/** 一条朗读单元（= 上游 `contentList` 的一项）。`start/end` 是**章内字符偏移**，与 `utils/chapter-text.ts` 同一坐标系。 */
export interface Sentence {
  text: string;
  start: number;
  end: number;
}

/** 上游 `AppConfig.defaultSpeechRate`（`AppConfig.kt:398`）—— 也是「跟随系统语速」时的值 */
export const DEFAULT_SPEECH_RATE = 5;
/** 上游语速滑条上限（`dialog_read_aloud.xml` 的 `seek_tts_speechRate android:max`） */
export const SPEECH_RATE_MAX = 45;
/** 上游定时滑条上限（分钟，0 = 关闭）—— `seek_timer android:max` */
export const TIMER_MAX_MIN = 180;

/**
 * `#842` 句间停顿（毫秒）：默认 200ms（听感自然的中间值），上限 800，0 = 紧接。
 * 只影响两段朗读之间的留白，不改变音频内容；用户设置落 localStorage。
 */
export const DEFAULT_GAP_MS = 200;
export const GAP_MAX_MS = 800;

/**
 * `#847` 音色语言筛选。
 * 默认只显示中文音色（`zh-*` / `cmn-*` / `yue-*`），可切「全部语言」；筛选档位持久化。
 * 已选音色被筛掉时**不能被当成「未选」**：界面会额外保留一条「已选 · 当前筛选外」。
 */
export type VoiceLangScope = 'zh' | 'all';
export const DEFAULT_VOICE_SCOPE: VoiceLangScope = 'zh';
const CHINESE_LANG_RE = /^(?:zh|cmn|yue)(?:$|[-_])/i;

/** BCP-47 语言码是否中文（含普通话 `cmn`、粤语 `yue`） */
export function isChineseVoiceLang(lang: string): boolean {
  return CHINESE_LANG_RE.test(String(lang ?? '').trim());
}

/** localStorage / 外部输入 → 合法筛选档位（非法值回落默认「仅中文」） */
export function normalizeVoiceScope(v: unknown): VoiceLangScope {
  return v === 'all' ? 'all' : DEFAULT_VOICE_SCOPE;
}

/** 按档位筛音色；`all` 原样返回 */
export function filterVoicesByScope<T extends { lang: string }>(
  voices: T[],
  scope: VoiceLangScope,
): T[] {
  return scope === 'all' ? voices : voices.filter((v) => isChineseVoiceLang(v.lang));
}

/** 当前选中的音色是否「存在、但被当前筛选挡住了」 */
export function isVoiceFilteredOut<T extends { id: string; lang: string }>(
  voices: T[],
  voiceId: string | null,
  scope: VoiceLangScope,
): boolean {
  if (!voiceId) return false;
  if (!voices.some((v) => v.id === voiceId)) return false; // 音色列表还没加载/ID 失效 ≠ 被筛掉
  return !filterVoicesByScope(voices, scope).some((v) => v.id === voiceId);
}

/**
 * 上游 `AppPattern.notReadAloudRegex`（`AppPattern.kt:60`）：
 * **整串**只由空白 / 控制 / 标点 / 分隔 / 符号组成 ⇒ 不值得朗读（跳过它）。
 */
const NOT_READ_ALOUD = /^(?:\s|\p{C}|\p{P}|\p{Z}|\p{S})+$/u;

/** 该单元是否「不朗读」（上游 `text.matches(AppPattern.notReadAloudRegex)`） */
export function isNotReadAloud(text: string): boolean {
  // 空串：上游那条正则需要 **1 个以上**字符，所以 `''` 在它下面判为「可朗读」。
  // 那是没有意义的（切分器永远不会产出空单元，见 `splitSentences` 的过滤）⇒ 这里加一条**明确**的空串守卫，
  // 让「没有内容可读」这件事永远判为跳过（否则会向引擎提交一次空朗读，静默无反应）。
  if (text === '') return true;
  return NOT_READ_ALOUD.test(text);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/** 把语速值收进滑条范围（0~45） */
export function clampSpeechRate(v: number): number {
  return clampInt(v, 0, SPEECH_RATE_MAX);
}

/** 把句间停顿收进 0~800ms（非法值回落 0） */
export function clampGapMs(v: number): number {
  return clampInt(v, 0, GAP_MAX_MS);
}

/**
 * 语速值 → 引擎速率（上游 `upSpeechRate()`：`(ttsSpeechRate + 5) / 10f`）。
 *
 * `followSystem`（上游 `ttsFlowSys`，默认 **true**）为真时**忽略用户值**、固定用 `defaultSpeechRate`
 * ⇒ 速率恒 `1.0`（界面应同时禁用语速控件 —— 上游 `upTtsSpeechRateEnabled(enabled)` 就是这么做的）。
 */
export function speechRateOf(value: number, followSystem: boolean): number {
  const v = followSystem ? DEFAULT_SPEECH_RATE : clampSpeechRate(value);
  return (v + 5) / 10;
}

/** 语速值 → 显示文案（上游 `upTtsSpeechRateText`：`((value + 5) / 10f).toString()`） */
export function speechRateLabel(value: number, followSystem: boolean): string {
  return String(speechRateOf(value, followSystem));
}

/**
 * 章内正文 → 句子列表（偏移与 `utils/chapter-text.ts` 的 body 坐标一致）。
 *
 * ⚠️ **不吞字符**：任何情况下 `sentences.map(s => s.text).join('') === text`
 * —— 否则「当前句偏移 → 高亮/滚动位置」会整体漂移（这类错法是**静默**的）。
 */
export function splitSentences(text: string): Sentence[] {
  if (!text) return [];
  const seg = segmenterFor();
  if (seg) {
    const out: Sentence[] = [];
    let cursor = 0;
    for (const s of seg.segment(text)) {
      const start = cursor;
      cursor += s.segment.length; // 累加长度 ⇒ 区间**首尾相接**，不吞字符
      if (s.segment) out.push({ text: s.segment, start, end: cursor });
    }
    if (out.length) return out;
  }
  return fallbackSplit(text);
}

function segmenterFor(): { segment(s: string): Iterable<{ segment: string }> } | null {
  try {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => unknown }).Segmenter;
    if (!Seg) return null;
    return new Seg('zh', { granularity: 'sentence' }) as { segment(s: string): Iterable<{ segment: string }> };
  } catch {
    return null; // 环境不支持 ⇒ 走退化切分，绝不抛错
  }
}

/** 退化切分：中英句末标点之后断开（`Intl.Segmenter` 不可用 / 没切出任何句子时） */
function fallbackSplit(text: string): Sentence[] {
  const out: Sentence[] = [];
  const push = (s: number, e: number): void => {
    if (e > s) out.push({ text: text.slice(s, e), start: s, end: e });
  };
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!'。！？!?…\n'.includes(text[i]!)) continue;
    // 连续标点（如 `……」`）并进同一句
    let end = i + 1;
    while (end < text.length && '。！？!?…」』”）)\'"\n'.includes(text[end]!)) end += 1;
    push(start, end);
    start = end;
    i = end - 1;
  }
  push(start, text.length);
  return out;
}

/**
 * 从 `from` 起（含）找下一个**值得朗读**的句子下标；到章尾返回 `-1`（调用方据此「换下一章」）。
 * 对应上游 `TTSUtteranceListener.nextParagraph()` 里那个 `do { … } while (notReadAloudRegex)` 跳段循环。
 */
export function nextSpeakableIndex(list: readonly Sentence[], from: number): number {
  for (let i = Math.max(0, from); i < list.length; i += 1) {
    if (!isNotReadAloud(list[i]!.text)) return i;
  }
  return -1;
}

/** 从 `from` 起（含）往前找上一个值得朗读的句子；到头返回 `-1` */
export function prevSpeakableIndex(list: readonly Sentence[], from: number): number {
  for (let i = Math.min(from, list.length - 1); i >= 0; i -= 1) {
    if (!isNotReadAloud(list[i]!.text)) return i;
  }
  return -1;
}

/**
 * 章内字符偏移 → 落在哪一句 / 句内偏移（上游 `nowSpeak` 与 `paragraphStartPos` 的求法）。
 *
 * 偏移落在句间空隙（理论上不会，分句不吞字符）时向后取最近的句子，**绝不返回 null**。
 */
export function locateSentence(list: readonly Sentence[], bodyPos: number): { index: number; innerPos: number } {
  if (!list.length) return { index: -1, innerPos: 0 };
  const pos = Math.max(0, bodyPos);
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i]!;
    if (pos < s.end) return { index: i, innerPos: Math.max(0, pos - s.start) };
  }
  const last = list.length - 1;
  return { index: last, innerPos: list[last]!.text.length };
}

/** 章节停：已读完 `chaptersFinished` 章后是否该停（`stopCount <= 0` = 关闭，永不停） */
export function chapterStopReached(chaptersFinished: number, stopCount: number): boolean {
  return stopCount > 0 && chaptersFinished >= stopCount;
}

/** 定时剩余毫秒 → 分钟（向上取整；`<= 0` 表示不设或已到点） */
export function timerMinutesLeft(remainMs: number): number {
  return remainMs > 0 ? Math.ceil(remainMs / 60_000) : 0;
}

/** 定时文案（对齐上游 `R.string.timer_m` 的「%d 分钟」语义；`0` = 未设置） */
export function timerLabel(minute: number): string {
  return minute > 0 ? `${minute} 分钟` : '未设置';
}
