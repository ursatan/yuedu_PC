/**
 * 并发计数器（**两级优先 + 各自 FIFO**）——被 `net/index.ts`（v1 护栏）与
 * `net/traffic.ts`（`#200` 流量护栏 v2）共用，所以单独成模块避免循环依赖。
 *
 * 为什么要 FIFO 而不是随便放行：加上限后若乱序放行，先到的请求可能被后来的挤到队尾，
 * 表现为「同一批请求里有的秒回、有的等很久」——FIFO 下耗时更可预期，也更好复现问题。
 *
 * 为什么还要**优先级**：`globalSem`/`hostSem` 是模块级单例 —— 图片代理 `/api/proxy`
 * 与引擎 `/api/run` **共用同一组槽位**。发现页一屏几十张封面会把槽位占满，用户此时点卡片，
 * detail/toc 就被顶在队尾（实测排队成本：服务端 +820ms / 浏览器侧 +1784ms）。
 * 所以给后台资源（封面图）一个低优先通道：**有空槽照样立刻放行**（不影响吞吐），
 * 只有在需要排队时才让位给交互请求。两个队列各自 FIFO，避免同类请求乱序。
 */
export class Semaphore {
  private active = 0;
  private readonly hi: Array<() => void> = [];
  private readonly lo: Array<() => void> = [];
  constructor(private readonly max: () => number) {}

  /** 当前占用数（诊断用） */
  get inUse(): number {
    return this.active;
  }

  /** 当前上限（诊断用） */
  get limit(): number {
    return this.max();
  }

  async acquire(priority: 'high' | 'low' = 'high'): Promise<void> {
    if (this.active < this.max()) {
      this.active++;
      return;
    }
    const q = priority === 'low' ? this.lo : this.hi;
    await new Promise<void>((resolve) => q.push(resolve));
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    // 高优先先出队；高优先队列空了才轮到低优先
    (this.hi.shift() ?? this.lo.shift())?.();
  }
}

/**
 * 滑动窗口速率闸门（每秒放行 N 个）。用于 `#200` 的「单任务 RPS」「全局 RPS」。
 *
 * 实现取**固定窗口 + 等待**：窗口内已放行数 ≥ 上限就让请求等到窗口滚动。
 * 比令牌桶更适合 RPS 语义（要求的是「每秒请求个数」，不是字节速率）。
 */
export class RateGate {
  private windowStart = 0;
  private count = 0;
  private waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly perSec: () => number) {}

  /** 当前窗口内已放行数（诊断用） */
  get used(): number {
    return this.count;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const limit = Math.max(1, this.perSec());
      if (now - this.windowStart >= 1000) {
        this.windowStart = now;
        this.count = 0;
      }
      if (this.count < limit) {
        this.count++;
        this.arm();
        return;
      }
      const waitMs = Math.max(10, 1000 - (now - this.windowStart));
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
      void waitMs;
    }
  }

  /** 窗口结束时唤醒等待者（不依赖调用方轮询） */
  private arm(): void {
    if (this.timer) return;
    const left = Math.max(10, 1000 - (Date.now() - this.windowStart));
    this.timer = setTimeout(() => {
      this.timer = null;
      const ws = this.waiters;
      this.waiters = [];
      for (const w of ws) w();
    }, left);
    // ⚠️ **不要 unref**：等待中的请求必须能撑住事件循环 —— unref 后若没有别的活儿，
    //    进程会在等待者被唤醒前退出（测试里直接表现为 `Promise resolution is still pending
    //    but the event loop has already resolved`，线上则可能让请求永远挂着）。
  }

  /** 测试/换配置时重置 */
  reset(): void {
    this.windowStart = 0;
    this.count = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}
