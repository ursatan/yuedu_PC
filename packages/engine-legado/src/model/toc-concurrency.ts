/**
 * `#630` 目录求值并发度：**按路由选档**（抽成纯函数，便于回归锁定）。
 *
 * ## 2026-10-26c 回退：默认恢复固定 4，自适应改为**显式开启**（`YUEDU_TOC_CONC=auto`）
 *
 * 为什么回退：`-26b` 的配对测量是在**空闲机**上做的（4 ⇒ 5.06s、16 ⇒ 3.22s，−36%）。
 * 但用户在**同一台**生产机（4 核 i3-4160，同时跑浏览器 + 本服务 + 源巡检）实测目录 20-30s，
 * 比自适应之前更慢 —— 高并发在**满载**机器上会变成结构化克隆/序列化的争抢，与空闲机结论相反。
 * 用户明确要求「没有改善、反而更慢就取消」⇒ 默认回到 `#509` 的 4（最稳）；
 * 自适应保留为实验开关（`YUEDU_TOC_CONC=auto`），等能在安静环境复测再说。
 *
 * ## 原判据（留档，实验用）
 *  · worker 路由（真并行）：空闲机 4 ⇒ 2.23s、16 ⇒ 1.80s；配对复测 4 ⇒ 3.09/2.61 ms/章、
 *    16 ⇒ 2.61/2.46 ms/章（16 不差于 4，最好快 15%）；32 收益递减。
 *  · L1 路由（同步求值）：**越高越慢**，l1-eval 累计 4 ⇒ 11.8s、16 ⇒ 20.7s、32 ⇒ 26.7s。
 *
 * ⚠️ 为什么不从规则文本猜路由：L1 的判据分散在 `createHybridJsEvaluator` 的 4 个分支里
 * （Java 类桥 / document 成员 / 宿主 DOM 绑定 / 不可克隆 bindings），任一处改动都会让「猜」失效。
 * 唯一可靠的判据是**实际落点计数**（`js.ts` 的 `__yueduRouteStats`）。
 */

/** L1（同步求值）档：不可提高 —— 主线程排队，`#480-a` 的机制。**也是当前默认值**。 */
export const TOC_CONC_L1 = 4;
/** worker（真并行）档默认值：16 是实测拐点，32 收益递减。 */
export const TOC_CONC_WORKER_DEFAULT = 16;
/** worker 档硬顶：即使调高也不许超过（防「收益递减但调度开销继续涨」区间被打开）。 */
export const TOC_CONC_HARD_MAX = 64;
/** 章数低于此值不探测：探测要花一次单章求值，短目录不划算。 */
export const TOC_ADAPT_MIN_CHAPTERS = 32;

/** 探测结果：某次求值前后的路由计数增量。 */
export interface TocRouteProbe {
  l1: number;
  worker: number;
  /** `#633` 快路命中数（纯表达式在宿主按模板缓存执行，7µs 级） */
  fast?: number;
}

export type TocConcMode =
  /** 固定并发（默认）：缺省 4，`YUEDU_TOC_CONC=<n>` 可改。 */
  | { kind: 'fixed'; conc: number }
  /** 自适应（`YUEDU_TOC_CONC=auto`，实验开关）：先探测第 0 章再选档。 */
  | { kind: 'auto' };

export interface TocConcInput {
  mode: TocConcMode;
  /** 目录章数（探测前）。 */
  chapters: number;
  /** 探测章的计数增量；拿不到统计（无混合求值器）⇒ undefined。 */
  probe?: TocRouteProbe | undefined;
  /** `YUEDU_TOC_CONC_MAX`（默认 16，内部 clamp 到 1~64）。原样透传环境变量字符串即可。 */
  maxWorkerConc?: string | number | undefined;
}

export type TocConcRoute = 'fixed' | 'short' | 'worker' | 'l1' | 'fast' | 'unknown';

export interface TocConcDecision {
  conc: number;
  route: TocConcRoute;
  /** 可读原因，日志用。 */
  reason: string;
}

/**
 * 解析 `YUEDU_TOC_CONC`：
 *  · 未设 / 空 / 非法 ⇒ `{kind:'fixed', conc:4}`（**默认不搞自适应**）
 *  · `auto` ⇒ `{kind:'auto'}`（实验开关）
 *  · 正数 ⇒ 固定该值
 */
export function parseConcMode(raw: string | undefined): TocConcMode {
  const s = (raw ?? '').trim();
  if (s.toLowerCase() === 'auto') return { kind: 'auto' };
  if (s === '') return { kind: 'fixed', conc: TOC_CONC_L1 };
  const n = Number(s);
  return Number.isFinite(n) && n > 0
    ? { kind: 'fixed', conc: Math.max(1, Math.trunc(n)) }
    : { kind: 'fixed', conc: TOC_CONC_L1 };
}

/**
 * worker 档取值：默认 16，`YUEDU_TOC_CONC_MAX` 可覆盖，clamp 到 `1 ~ TOC_CONC_HARD_MAX`。
 * ⚠️ 非法值（`abc` / `0` / 负数）一律回落默认 16 —— 不能因为写错环境变量就把并发降到 1。
 */
export function parseMaxWorkerConc(raw: string | number | undefined): number {
  const n = Number(raw ?? NaN);
  const v = Number.isFinite(n) && n >= 1 ? n : TOC_CONC_WORKER_DEFAULT;
  return Math.max(1, Math.min(Math.trunc(v), TOC_CONC_HARD_MAX));
}

/**
 * 选档（只有 `auto` 才探测；固定模式直接返回）：
 *  ① 固定模式 ⇒ 照用（默认 4）；
 *  ② 短目录（< 32 章）⇒ 4，省掉探测；
 *  ③ 拿不到统计、或探测章**没有 JS 求值**（两个计数都没动）⇒ 4（判定不了就最保守）；
 *  ④ 只有「worker 涨、L1 没涨」才算 worker 路 ⇒ 上限档（默认 16）。
 */
export function resolveTocConc(input: TocConcInput): TocConcDecision {
  const mode = input.mode;
  if (mode.kind === 'fixed') {
    return {
      conc: mode.conc,
      route: 'fixed',
      reason: mode.conc === TOC_CONC_L1 ? '默认 conc=4（自适应未开启）' : `固定 conc=${mode.conc}`,
    };
  }
  if (input.chapters < TOC_ADAPT_MIN_CHAPTERS) {
    return { conc: TOC_CONC_L1, route: 'short', reason: `章数 ${input.chapters} < ${TOC_ADAPT_MIN_CHAPTERS}，不探测` };
  }
  const probe = input.probe;
  if (!probe) {
    return { conc: TOC_CONC_L1, route: 'unknown', reason: '无路由统计（非混合求值器）' };
  }
  /**
   * `#633` 快路：探测章走的是纯表达式快路（7µs/次，同步但几乎不占时间）
   * ⇒ 不需要高并发（并发只会在主线程排队），维持 4。
   */
  if ((probe.fast ?? 0) > 0 && probe.l1 === 0 && probe.worker === 0) {
    return { conc: TOC_CONC_L1, route: 'fast', reason: `快路（探测章 fast+${probe.fast}）` };
  }
  if (probe.worker > 0 && probe.l1 === 0) {
    return {
      conc: parseMaxWorkerConc(input.maxWorkerConc),
      route: 'worker',
      reason: `worker 路由（探测章 worker+${probe.worker} / l1+0）`,
    };
  }
  if (probe.worker === 0 && probe.l1 === 0 && (probe.fast ?? 0) === 0) {
    return { conc: TOC_CONC_L1, route: 'unknown', reason: '探测章无 JS 求值，判定不了' };
  }
  return {
    conc: TOC_CONC_L1,
    route: 'l1',
    reason: `L1 路由（探测章 l1+${probe.l1} / worker+${probe.worker}）`,
  };
}
