/**
 * 阻塞埋点（Phase 0.1 诊断用）。
 *
 * 为什么需要：`java.ajax` 在 L1 路径走 `execFileSync('curl')`，会**同步阻塞 Node 事件循环**；
 * `render.ts` 的 `spawnSync`（Chromium --dump-dom）同理。这类阻塞会让「同时进行的其他请求」
 * 整体卡住 —— 表现为服务假死、并发一高就大面积 TIMEOUT。
 *
 * ⚠️ **不要用「stdout 重定向到文件 + grep」来统计**：Node 的 stdout 写文件是异步的，
 * 高并发下会交错甚至截断，据此得出的结论是错的（本项目已踩过这个坑）。所以走进程内计数器。
 *
 * 开销：一次 `Date.now()` 对 + 一次数组 push，可忽略；无需环境变量开关。
 */

export interface BlockSample {
  /** 阻塞类型：curl / render-spawnSync / worker-spawn / l1-eval */
  kind: string;
  /** 阻塞时长（毫秒） */
  ms: number;
  /** 发生时刻（Date.now） */
  at: number;
  /** 归因细节（URL / 脚本片段） */
  detail: string;
}

interface Counter {
  n: number;
  totalMs: number;
  maxMs: number;
}

const MAX_SAMPLES = 400;
const samples: BlockSample[] = [];
const counters = new Map<string, Counter>();

/** 记录一次阻塞。`ms` 为阻塞时长。 */
export function recordBlock(kind: string, ms: number, detail = ''): void {
  let c = counters.get(kind);
  if (!c) {
    c = { n: 0, totalMs: 0, maxMs: 0 };
    counters.set(kind, c);
  }
  c.n += 1;
  c.totalMs += ms;
  if (ms > c.maxMs) c.maxMs = ms;
  samples.push({ kind, ms, at: Date.now(), detail: detail.slice(0, 200) });
  if (samples.length > MAX_SAMPLES) samples.shift();
}

/** 最近的阻塞样本（顺序：旧 → 新）。 */
export function blockSamples(): BlockSample[] {
  return samples.slice();
}

/** 分类汇总。 */
export function blockCounters(): Array<{ kind: string } & Counter> {
  return [...counters.entries()]
    .map(([kind, c]) => ({ kind, ...c }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** 清空（一次测量开始前调用）。 */
export function resetBlocks(): void {
  samples.length = 0;
  counters.clear();
}

/** 人类可读的汇总文本（诊断脚本用）。 */
export function formatBlocks(): string {
  const rows = blockCounters();
  if (!rows.length) return '（无阻塞记录）';
  const lines = rows.map(
    (r) => `  ${r.kind.padEnd(18)} n=${String(r.n).padStart(4)}  total=${String(r.totalMs).padStart(6)}ms  max=${r.maxMs}ms`,
  );
  const worst = samples
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((s) => `    ${String(s.ms).padStart(6)}ms  ${s.kind}  ${s.detail}`);
  return [`阻塞汇总：`, ...lines, `  最重的 5 次：`, ...worst].join('\n');
}

export interface LagReport {
  /** 观测到的最大单次事件循环滞后（毫秒）——约等于最长的一次同步阻塞 */
  maxLagMs: number;
  /** 超过阈值的滞后事件数 */
  stalls: number;
  /** 各次滞后（毫秒），仅保留超过阈值的 */
  gaps: number[];
  /**
   * **被阻塞总时长的下界估算**（毫秒）。
   * 为什么需要：主线程若被**连续**阻塞，定时器一次都跑不到，逐次滞后恒为 0（假阴性！）。
   * 用「应跑周期数 - 实跑周期数」× 周期 兜底，即使一个 tick 都没跑到也能报出来。
   */
  estBlockedMs: number;
  /** 实跑周期数 / 应跑周期数（诊断用） */
  ticks: number;
  expectedTicks: number;
}

/**
 * 事件循环滞后探测：自调度 setTimeout，滞后 = 实际触发时刻 - 期望时刻。
 *
 * ⚠️ 单看 `maxLagMs` 会漏报**连续阻塞**（定时器跑不到 → 恒 0），故同时用
 * 「缺失周期数」估算被阻塞总时长（`estBlockedMs`），两者互补。
 */
export function startLagMonitor(intervalMs = 40, thresholdMs = 80): { stop: () => LagReport } {
  const started = Date.now();
  let expected = started + intervalMs;
  let ticks = 0;
  let maxLagMs = 0;
  const gaps: number[] = [];
  const timer = setInterval(() => {
    const now = Date.now();
    ticks += 1;
    const lag = now - expected;
    if (lag > thresholdMs) {
      gaps.push(lag);
      if (lag > maxLagMs) maxLagMs = lag;
    }
    expected = now + intervalMs;
  }, intervalMs);
  return {
    stop: (): LagReport => {
      clearInterval(timer);
      const elapsed = Date.now() - started;
      const expectedTicks = Math.max(0, Math.floor(elapsed / intervalMs));
      const missed = Math.max(0, expectedTicks - ticks);
      // 缺失的周期意味着这段时间循环没跑 → 阻塞时长下界
      const estBlockedMs = missed * intervalMs;
      if (estBlockedMs > maxLagMs) maxLagMs = estBlockedMs;
      return {
        maxLagMs,
        stalls: gaps.length + (missed > 1 ? 1 : 0),
        gaps: gaps.slice(0, 40),
        estBlockedMs,
        ticks,
        expectedTicks,
      };
    },
  };
}
