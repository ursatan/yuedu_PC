/**
 * **内置 Edge 在线音色 —— 朗读引擎适配**。
 *
 * 为什么不新写一套播放状态机：Edge 与 HTTP TTS 的差别只有「文本 → 音频字节」这一步
 * （`/api/tts/edge/speak` vs `/api/tts/speak`），预取、代际作废、`cancel()` 不得叠声
 * 这些纪律完全一样 ⇒ 直接复用 `createHttpTtsEngine` 的实现，只注入取数函数。
 *
 * 联网与失败：Edge 音色是**云端**合成，断网/被拦截会失败；
 * 失败经 `TtsApiError` 转成中文文案上浮到朗读条（`describeTtsError` 已含各错误码），
 * 用户可以一键切回「本机系统语音」—— 这里不做静默回退（否则用户听不到声音也不知道为什么）。
 */
import type { SpeechEngine } from '../stores/read-aloud';
import { createHttpTtsEngine } from './http-tts-engine';
import { speakEdgeTts, TtsApiError } from './tts';

export interface EdgeTtsEngineOptions {
  /** 当前 Edge 音色短名（`zh-CN-XiaoxiaoNeural`）；空 ⇒ 报「还没选音色」 */
  voice: () => string | null;
  /** 当前语速（0.5~2.0） */
  speed: () => number;
}

export function createEdgeTtsEngine(o: EdgeTtsEngineOptions): SpeechEngine {
  return createHttpTtsEngine({
    engineId: 'edge',
    speed: o.speed,
    speak: (text, speed, signal) => {
      const voice = o.voice();
      if (!voice) {
        return Promise.reject(
          new TtsApiError('TTS_EDGE_VOICE_INVALID', '还没有选择 Edge 音色', 400),
        );
      }
      return speakEdgeTts({ text, voice, speed }, signal);
    },
  });
}
