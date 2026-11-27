/**
 * `#771` **冻结定向探针** —— 回答「`[stall]` 的 5s 里主线程到底停在哪」。
 *
 * ## 为什么需要（`#770` 的缺口）
 * `#770` 已证：七猫 940 章 58.64s 里 85.5% 是主线程停摆，且停摆期间 `blockCounters()` 不涨
 * （最大一次 `fast-expr` 526ms 只是「计时器把停顿包进去了」）。也就是说：**停摆不在已埋点的
 * 同步调用里**。要定位只剩两条路：
 *  ① 把「当前开着却没退出的同步段」记录下来，冻结点出现时看门狗一次性输出（本模块）；
 *  ② 把「进程/主线程在这段时间到底有没有在跑」量化出来（`stall-watch` 里的 CPU/内存快照）。
 *
 * ## 设计约束（用户明确要求）
 *  · **默认关**：`YUEDU_FREEZE_PROBE=1` 才开；关时每个埋点只是一次布尔判断（可忽略）。
 *  · **不做全量无差别 wrap**：只在可疑边界（SSE 序列化/`res.write`、章节循环、regex/`fast-expr`、
 *    CSS/jsoup、`postMessage` 克隆、KV 快照、sqlite、图片解密）打 **同步段** 标记。
 *  · ⚠️ **只许包同步段**：`probeEnter` / `probeLeave` 必须成对出现在同一个 tick 内
 *    （中间不能 `await`）。栈是全局 LIFO，跨 await 会把别人的标记弹掉 ⇒ 现场失真。
 *    跨异步的边界请用 `probePoint(label)`（只更新「最近一次经过」）。
 *
 * ## 输出形态
 * 看门狗在 `[stall]` / `[stall] recover` 行里追加：
 * `freeze={d=<深度> open=<栈> last=<最后完成/经过> topAge=<ms> idle=<ms>}`。
 * 判据：
 *  · `d>0` ⇒ 就冻结在 `open` 里最里层那一段（`topAge` 就是它的年龄）；
 *  · `d=0` + `last=<某边界>` ⇒ 边界已退出，冻结发生在**同步段之外**（await/定时器/GC/内核）。
 *
 * ## GC
 * 用 `PerformanceObserver('gc')` 记录最近一次 GC 的 `kind/duration/结束时刻`（V8 的 GC 是
 * 同步跑在主线程上的，JS 回调在 GC 结束后才会跑 ⇒ 只能事后归因，但这正好够：若 `recover`
 * 行里 `gc=<major> xx ms ago≈0`，那这次停摆就是 GC）。
 */
import { PerformanceObserver } from 'node:perf_hooks';

/** 看门狗一侧收到的一次「现场」；由 `apps/server/src/stall-watch.ts` 写进共享内存 */
export interface FreezeSnapshot {
  /** 当前同步段嵌套深度（0 = 没有开着的同步段） */
  depth: number;
  /** 开着的同步段（外→内，`>` 连接，单段 ≤ 24 字符） */
  open: string;
  /** 最近一次**退出/经过**的标记 */
  last: string;
  /** 最内层同步段的进入时刻（epoch ms；depth=0 时为 0） */
  topAt: number;
  /** 最近一次标记变化时刻（epoch ms） */
  lastAt: number;
  /** 最近一次 GC 结束时刻 / 耗时 / kind（无则 0） */
  gcAt: number;
  gcMs: number;
  gcKind: number;
}

type Sink = (s: FreezeSnapshot) => void;

interface MarkStat {
  n: number;
  totalMs: number;
  maxMs: number;
}

let enabled = process.env['YUEDU_FREEZE_PROBE'] === '1';
const stack: Array<{ label: string; t0: number }> = [];
let lastLabel = '';
let lastAt = Date.now();
let sink: Sink | null = null;
let publishedAt = 0;
let gcAt = 0;
let gcMs = 0;
let gcKind = 0;
let gcInstalled = false;
const stats = new Map<string, MarkStat>();

/** 栈深上限：防御（只会被错配的异步用法撑大） */
const MAX_DEPTH = 32;
/** 发布节流：同步段平均 0.08ms，8ms 足够把「同步段序列」压成有意义的现场，又不会刷爆 SAB */
const PUBLISH_MIN_GAP_MS = 8;

function snapshot(): FreezeSnapshot {
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  return {
    depth: stack.length,
    open: stack.map((s) => s.label.slice(0, 24)).join('>'),
    last: lastLabel.slice(0, 48),
    topAt: top ? top.t0 : 0,
    lastAt,
    gcAt,
    gcMs,
    gcKind,
  };
}

function publish(force: boolean): void {
  if (!enabled || !sink) return;
  const now = Date.now();
  if (!force && now - publishedAt < PUBLISH_MIN_GAP_MS) return;
  publishedAt = now;
  try {
    sink(snapshot());
  } catch {
    /* 取证设施：任何失败都不许影响业务 */
  }
}

function bump(label: string, ms: number): void {
  let s = stats.get(label);
  if (!s) {
    if (stats.size >= 200) return; // 标签集合有界（正常只有十来个）
    s = { n: 0, totalMs: 0, maxMs: 0 };
    stats.set(label, s);
  }
  s.n += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
}

export function isFreezeProbeEnabled(): boolean {
  return enabled;
}

/** 运行时开关（只用于本地复现/测试；生产用环境变量，默认关） */
export function setFreezeProbeEnabled(v: boolean): void {
  enabled = v;
  if (!v) {
    stack.length = 0;
    lastLabel = '';
  }
  publish(true);
}

/** 看门狗注册「写 SAB」的落点；传 null 解绑 */
export function setFreezeSink(fn: Sink | null): void {
  sink = fn;
  publish(true);
}

/**
 * 进入一个**同步段**（必须与 `probeLeave` 在同一个 tick 内成对）。
 * 关时开销：一次函数调用 + 一次布尔判断。
 */
export function probeEnter(label: string): void {
  if (!enabled) return;
  stack.push({ label, t0: Date.now() });
  if (stack.length > MAX_DEPTH) stack.splice(0, stack.length - MAX_DEPTH);
  publish(true);
}

/** 退出最近一个同步段；同时累计该段的 n/总耗时/最坏耗时（`/api/diag.freeze`） */
export function probeLeave(): void {
  if (!enabled) return;
  const f = stack.pop();
  if (f) {
    const ms = Date.now() - f.t0;
    bump(f.label, ms);
    lastLabel = f.label;
    lastAt = Date.now();
  }
  publish(false);
}

/** 只记「经过这里」（跨异步边界的安全做法）；不参与深度 */
export function probePoint(label: string): void {
  if (!enabled) return;
  lastLabel = label;
  lastAt = Date.now();
  publish(false);
}

/** `/api/diag` 用：各标记的 n / 累计 / 最坏（按累计耗时降序） */
export function freezeProbeReport(): {
  enabled: boolean;
  marks: Array<{ label: string; n: number; totalMs: number; maxMs: number }>;
} {
  return {
    enabled,
    marks: [...stats.entries()]
      .map(([label, s]) => ({ label, n: s.n, totalMs: s.totalMs, maxMs: s.maxMs }))
      .sort((a, b) => b.totalMs - a.totalMs),
  };
}

/** 装 GC 观测（主线程调用；探针关时 no-op） */
export function installGcProbe(): void {
  if (!enabled || gcInstalled) return;
  gcInstalled = true;
  try {
    const obs = new PerformanceObserver((list) => {
      const entries = list.getEntries() as unknown as Array<{ duration: number; detail?: { kind?: number } }>;
      for (const e of entries) {
        gcAt = Date.now();
        gcMs = Math.round(e.duration);
        gcKind = Number(e.detail?.kind ?? 0);
      }
      publish(true);
    });
    obs.observe({ entryTypes: ['gc'] });
  } catch {
    /* 取证设施：不支持就算了 */
  }
}
