/**
 * `#822` B2 HTTP TTS —— **阅读页朗读引擎实现**（把 `/api/tts/speak` 的音频接到现有朗读状态机）。
 *
 * 设计要点：
 *  · 与系统语音（Web Speech）实现同一 `SpeechEngine` 接口 ⇒ 阅读页状态机/高亮/自动换章零改动；
 *  · 每次 `speak()` 只拉**一个分段**的音频（分段由 `read-aloud` store 用内核 `segmentTtsText` 切好）；
 *  · `cancel()` 必须让**在途请求/已加载音频都作废**：换段、暂停、关浮层都可能打断，
 *    晚到的响应绝不能触发 `onEnd`（否则状态机会「自己跳段」）。
 *
 * `#842` 下一段预取：
 *  · `prefetch(text)` 在**当前段起播后**就把下一段拉回来，`ended` 后 `speak()` 直接命中缓存；
 *  · 预取失败**只吞掉**，下一次 `speak()` 走原来的串行请求 —— 不允许预取失败变成朗读中断；
 *  · 代际纪律：`epoch` 随 `cancel()` 递增，旧代预取结果一律丢弃；`gen` 仍守 utterance 回调。
 */
import type { SpeechEngine } from '../stores/read-aloud';
import { speakTts, TtsApiError } from './tts';

export interface HttpTtsEngineOptions {
  engineId: string;
  /** 当前语速（0.5~2.0；服务端会再夹一次） */
  speed: () => number;
  /**
   * 可选：自定义「文本 → 音频」取数函数（不传就走 `/api/tts/speak`）。
   *
   * 用途：内置 Edge 音色（`/api/tts/edge/speak`）与本引擎**共用**预取 / 代际 / 起播逻辑，
   * 只有「拉字节」这一步不同 ⇒ 抽一个函数，不复制第二份播放状态机。
   */
  speak?: (text: string, speed: number, signal: AbortSignal) => Promise<Blob>;
}

interface PrefetchEntry {
  /** 创建预取时的代（`cancel()` 会让它失效） */
  epoch: number;
  text: string;
  ctrl: AbortController;
  /** 失败一律解析为 `null`，由 `speak()` 回退串行请求 */
  promise: Promise<Blob | null>;
}

export function createHttpTtsEngine(o: HttpTtsEngineOptions): SpeechEngine {
  let seq = 0;
  /** 预取代：只有 `cancel()` 递增；正常 `onEnd` 推进时预取仍然有效 */
  let epoch = 0;
  let ctrl: AbortController | null = null;
  let audio: HTMLAudioElement | null = null;
  let objectUrl = '';
  let prefetchEntry: PrefetchEntry | null = null;
  /**
   * 即使 `prefetchEntry` 已被 `speak()` 认领（置空），在途请求仍要能被 `cancel()` 中止 ⇒
   * 单独留一个 controller 引用，直到 promise 落地或取消。
   */
  let prefetchCtrl: AbortController | null = null;

  /** 统一的取数入口：默认 `/api/tts/speak`，Edge 等引擎可注入自己的实现 */
  const requestAudio = (text: string, signal: AbortSignal): Promise<Blob> =>
    o.speak
      ? o.speak(text, o.speed(), signal)
      : speakTts({ engineId: o.engineId, text, speed: o.speed() }, signal).then((r) => r.blob);

  const releaseAudio = () => {
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
      audio = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = '';
    }
  };

  const abortPrefetch = () => {
    prefetchCtrl?.abort();
    prefetchCtrl = null;
    prefetchEntry = null;
  };

  /** 取出与当前文本 + 当代匹配的预取；不匹配的预取一律作废（用户跳句/换章了） */
  const takePrefetch = (text: string): Promise<Blob | null> | null => {
    const p = prefetchEntry;
    if (!p || p.epoch !== epoch || p.text !== text || p.ctrl.signal.aborted) {
      abortPrefetch();
      return null;
    }
    prefetchEntry = null; // 已认领；prefetchCtrl 继续保留，供 cancel() 中止
    return p.promise;
  };

  return {
    available: () => true,
    voices: () => [],
    prefetch(text) {
      if (!text) return;
      if (prefetchEntry && prefetchEntry.epoch === epoch && prefetchEntry.text === text) return;

      abortPrefetch();
      const e = epoch;
      const c = new AbortController();
      prefetchCtrl = c;
      const entry: PrefetchEntry = {
        epoch: e,
        text,
        ctrl: c,
        promise: Promise.resolve(null),
      };
      entry.promise = requestAudio(text, c.signal)
        .then((blob) => (e === epoch && !c.signal.aborted ? blob : null))
        .catch(() => null) // 预取失败不上浮：speak() 会回退到串行请求
        .finally(() => {
          // ★ 只释放 controller，**不清 entry**：提前到达的成功结果要留给下一次 speak() 命中
          if (prefetchCtrl === c) prefetchCtrl = null;
        });
      prefetchEntry = entry;
    },
    speak(text, cb) {
      const gen = ++seq;
      ctrl?.abort();
      const c = new AbortController();
      ctrl = c;
      cb.onStart();
      const cached = takePrefetch(text);
      void (async () => {
        try {
          let blob: Blob | null = cached ? await cached : null;
          if (gen !== seq || c.signal.aborted) return;
          if (!blob) {
            // 没预取 / 预取失败 / 预取被取消 ⇒ 回退串行请求（原有路径，不中断朗读）
            blob = await requestAudio(text, c.signal);
            if (gen !== seq || c.signal.aborted) return;
          }

          // ★ 先停掉上一段再起播：这是「不得叠声」的硬保证
          releaseAudio();
          objectUrl = URL.createObjectURL(blob);
          const a = new Audio(objectUrl);
          audio = a;
          a.onended = () => {
            if (gen !== seq) return;
            releaseAudio();
            cb.onEnd();
          };
          a.onerror = () => {
            if (gen !== seq) return;
            releaseAudio();
            cb.onError('浏览器无法解码这段音频（对方返回的格式可能不对）');
          };
          await a.play();
          if (gen !== seq || c.signal.aborted) releaseAudio();
        } catch (e) {
          if (gen !== seq || c.signal.aborted) return;
          releaseAudio();
          if (e instanceof TtsApiError) {
            cb.onError(e.message);
          } else if (e instanceof DOMException && e.name === 'NotAllowedError') {
            cb.onError('浏览器拦截了自动播放，请点一下播放按钮');
          } else {
            cb.onError(`朗读请求失败：${e instanceof Error ? e.message : String(e)}`);
          }
        }
      })();
    },
    cancel() {
      seq += 1;
      epoch += 1; // 旧代预取一律作废
      ctrl?.abort();
      ctrl = null;
      abortPrefetch();
      releaseAudio();
    },
  };
}
