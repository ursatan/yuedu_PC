/**
 * `#756` C **交互优先级闸**：前台请求在飞时，让后台图片解密让路（并留下可观测计数）。
 *
 * 背景：`#747` 已经在 `queuedDecodeImage` 里做了「图片解密串行 + 前台忙就暂停」，但
 * 前台计数只由 `/api/run` 维护（搜索/发现/目录/正文）。用户实际点开详情走的是
 * `/api/run/stream`，那条路径**没有登记** ⇒ 受控实验（40 张 300ms 同步解密图）里
 * 流式详情从 0.9s 涨到 6.8~8.4s，正好对上「detail(stream) 8~9s」的观感。
 *
 * 这里只做两件事，不引入新队列/新开关：
 *   · `enter/leave` 前台计数（路由在 try/finally 里成对调用）；
 *   · 图片解密开始前 `waitIdle()`（最多 `yieldMaxMs`，避免持续浏览时图片永远解不出来）。
 *
 * 计数进 `/api/diag.priority`：`busy/peak` 是前台在飞，`decode.queue/peakQueue/runs/deferred/deferredMs`
 * 能直接看出「有多少次解密因为前台忙被推迟、总共让路多久」。
 */
export interface ForegroundSnapshot {
  /** 当前前台在飞请求数 */
  busy: number;
  /** 前台在飞峰值 */
  peak: number;
  decode: {
    /** 排队中/执行中的图片解密数 */
    queue: number;
    /** 排队峰值 */
    peakQueue: number;
    /** 实际执行的解密次数 */
    runs: number;
    /** 因前台忙而推迟过的解密次数 */
    deferred: number;
    /** 推迟累计毫秒（含最多 5s 的封顶等待） */
    deferredMs: number;
  };
}

export interface ForegroundGate {
  enter(): void;
  leave(): void;
  readonly busy: number;
  /** 前台忙时轮询等待；返回实际等待毫秒（空闲时立即返回 0） */
  waitIdle(maxMs?: number): Promise<number>;
  noteDecodeQueued(): void;
  noteDecodeDone(): void;
  noteDecodeRun(): void;
  noteDecodeDeferred(ms: number): void;
  snapshot(): ForegroundSnapshot;
  /** `/api/diag?reset=1`：清峰值与累计量，保留当前状态（busy/queue） */
  resetCounters(): void;
}

export function createForegroundGate(opts: { yieldMaxMs?: number; pollMs?: number } = {}): ForegroundGate {
  const yieldMaxMs = opts.yieldMaxMs ?? 5_000;
  const pollMs = opts.pollMs ?? 50;
  let busy = 0;
  let peak = 0;
  const decode = { queue: 0, peakQueue: 0, runs: 0, deferred: 0, deferredMs: 0 };
  return {
    enter(): void {
      busy += 1;
      if (busy > peak) peak = busy;
    },
    leave(): void {
      if (busy > 0) busy -= 1;
    },
    get busy(): number {
      return busy;
    },
    async waitIdle(maxMs = yieldMaxMs): Promise<number> {
      if (busy <= 0) return 0;
      const start = Date.now();
      const until = start + Math.max(0, maxMs);
      while (busy > 0 && Date.now() < until) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
      }
      return Date.now() - start;
    },
    noteDecodeQueued(): void {
      decode.queue += 1;
      if (decode.queue > decode.peakQueue) decode.peakQueue = decode.queue;
    },
    noteDecodeDone(): void {
      if (decode.queue > 0) decode.queue -= 1;
    },
    noteDecodeRun(): void {
      decode.runs += 1;
    },
    noteDecodeDeferred(ms: number): void {
      if (ms <= 0) return;
      decode.deferred += 1;
      decode.deferredMs += ms;
    },
    snapshot(): ForegroundSnapshot {
      return { busy, peak, decode: { ...decode } };
    },
    resetCounters(): void {
      peak = 0;
      decode.peakQueue = 0;
      decode.runs = 0;
      decode.deferred = 0;
      decode.deferredMs = 0;
    },
  };
}
