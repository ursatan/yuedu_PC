/**
 * 桌面歌词状态上报的纯逻辑 + 订阅（`D7`）。
 *
 * 单独拆出来的原因：`desktop.ts` 会拉起 router（`import ... from './router'` → `.vue`），
 * 单测里无法直接加载；而「换章后句数相同也要重绘」这条判据恰恰必须能被单测锁住。
 *
 * ## 为什么依赖里必须有**文本**
 * 旧实现只 watch `sentences.length`：换章后如果新章句数恰好相同、`index` 也没变，
 * 依赖数组逐项相等 ⇒ 不触发 ⇒ 歌词窗继续显示上一章的内容（静默错内容）。
 * 所以依赖取「句数 + 当前句前后文本」，并在推送前再做一次 payload 指纹比对（相同就不重复发）。
 */
import { watch } from 'vue';

export type DesktopLyricsPlayState = 'idle' | 'playing' | 'paused';

/** 歌词窗需要的朗读状态（字段与 `apps/desktop/desktop-lib.normalizeLyricsState` 对齐） */
export interface DesktopLyricsPayload {
  active: boolean;
  playing: boolean;
  paused: boolean;
  index: number;
  /** 句内已读字符数（来自 Web Speech `onBoundary`，精度到词） */
  innerPos: number;
  prev: string;
  current: string;
  next: string;
}

/** 只读的朗读快照（生产是 read-aloud store；单测可直接构造） */
export interface LyricsReadAloud {
  state: DesktopLyricsPlayState;
  index: number;
  innerPos: number;
  sentences: readonly { text: string }[];
}

/** 把朗读快照归一成歌词窗需要的 payload（下标夹取、前后句取邻近项） */
export function buildLyricsPayload(al: LyricsReadAloud): DesktopLyricsPayload {
  const list = al.sentences;
  const index = list.length ? Math.max(0, Math.min(list.length - 1, al.index)) : 0;
  const current = list[index]?.text ?? '';
  const prev = index > 0 ? (list[index - 1]?.text ?? '') : '';
  const next = index + 1 < list.length ? (list[index + 1]?.text ?? '') : '';
  return {
    active: al.state !== 'idle',
    playing: al.state === 'playing',
    paused: al.state === 'paused',
    index,
    innerPos: al.innerPos,
    prev,
    current,
    next,
  };
}

/** payload 指纹：内容完全一致就不重复推送（句数相同但文本不同时指纹必然不同） */
export function lyricsFingerprint(p: DesktopLyricsPayload): string {
  return [p.active, p.playing, p.paused, p.index, p.innerPos, p.prev, p.current, p.next].join('\u0001');
}

/**
 * 订阅朗读快照并节流上报；返回退订函数。
 *
 * `watch` 的依赖里**必须含当前句文本**（见文件头注）—— 只判句数会让「换章后句数相同」漏更新。
 */
export function startLyricsPublisher(
  get: () => LyricsReadAloud,
  push: (p: DesktopLyricsPayload) => void,
  throttleMs = 40,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey: string | null = null;

  const publish = () => {
    const payload = buildLyricsPayload(get());
    const key = lyricsFingerprint(payload);
    if (key === lastKey) return;
    lastKey = key;
    push(payload);
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      publish();
    }, throttleMs);
  };

  const stopWatch = watch(
    () => {
      const al = get();
      const p = buildLyricsPayload(al);
      return [al.state, al.index, al.innerPos, al.sentences.length, p.prev, p.current, p.next] as const;
    },
    schedule,
    { immediate: true },
  );

  return () => {
    stopWatch();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
