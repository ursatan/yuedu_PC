/**
 * 源级限频 `concurrentRate`（`#321`）—— **唯一实现**，对齐上游
 * `F:\legado\app\src\main\java\io\legado\app\help\ConcurrentRateLimiter.kt`（2026-10-08 逐行抄录）。
 *
 * ## 上游语义（别按名字猜，以下是源码事实）
 * - 取值两形态：
 *   · `"N/M"` ⇒ M 毫秒窗口内最多 N 次（`fetchStart` 的 `accessLimit`/`interval`）；
 *   · `"M"`（纯整数 >0） ⇒ 1 次 / M 毫秒（accessLimit=1）；
 *   · `"0"` / 空串 / null / 解析失败 ⇒ **不限**（`fetchStart` 直接 return null；
 *     `updateConcurrentRate` 对 ≤0 抛 NumberFormatException 保持旧记录）。
 * - 记录按 **源键**（上游 `getKey()` = `bookSourceUrl`/`sourceUrl` ⇒ 本仓 = 源 `id`）全局一份：
 *   `{time, accessLimit, interval, frequency}`。
 * - 放行判定（`fetchStart`，synchronized 原子）：
 *   1) 新记录 ⇒ frequency=1，**放行**（创建者占第一个名额）；
 *   2) `now >= time + interval` ⇒ 重置 time=now、frequency=1，放行；
 *   3) `frequency < accessLimit` ⇒ frequency++，放行；
 *   4) 否则 ⇒ **等待 `time + interval - now` 毫秒**再重试（上游 ConcurrentException +
 *      `delay(waitTime)` 循环，直到放行）。
 * - 上游在 `AnalyzeUrl.getStrResponseAwait`（:449）与 `getResponseAwait`（:577）两处
 *   `withLimit` 包住**每一次源请求** ⇒ 本仓等价落点 = `ctx.http.request` 的包闸
 *   （facade `makeContext`，见 `#321` 提交说明），三引擎 + worker `java.ajax` 全覆盖。
 *
 * ## 本仓的取舍（留痕，不静默）
 * - **`source.putConcurrent(v)` 已实现**（`#331`）：上游语义 = `updateConcurrentRate(getKey(), v)`
 *   （BaseSource.kt:401 → ConcurrentRateLimiter.kt:16-44，**改限频**，与 callBackJs 无关——
 *   backlog 旧注「书架刷新事件」是误记）。本仓接线：legado/rss 两引擎的 source 桩与
 *   worker 的 sourceCall 全部落到 `updateConcurrentRate(ctx.sourceId, v)`；生效机制见
 *   `updateConcurrentRate` 注释（记录表 keyed by sourceId，tryAcquire 优先用 rec.spec）。
 * - **L1 同步路径（curl）不生效**：L1 是同步语义，等待会阻塞整个事件循环（本仓 L1 已有
 *
 * ## 并发正确性（JS 与 JVM 的差异）
 * 判定+计数必须**原子**：JS 在 `await` 点会让出，若「读 frequency → 判断 → 写 frequency」
 * 中间隔着 await，两个并发请求会同时判「还能过」⇒ 超发。所以判定段**纯同步**完成，
 * 只有「确定要等」之后才 `await` sleep；醒来回到循环顶部重新判定（与上游
 * `getConcurrentRecord` 的 while-retry 同构）。
 */

/** 解析后的限频：窗口 interval 毫秒内最多 accessLimit 次 */
export interface ConcurrentRateSpec {
  accessLimit: number;
  interval: number;
}

/**
 * 解析 `concurrentRate` 字段（对齐上游两处解析的**并集语义**：
 * `updateConcurrentRate` 的「≤0 抛异常⇒不限」+ `fetchStart` 的「解析失败⇒不限」）。
 * 返回 null = 不限频。
 */
export function parseConcurrentRate(v: unknown): ConcurrentRateSpec | null {
  if (v == null) return null;
  const s = typeof v === 'string' ? v.trim() : String(v);
  if (!s || s === '0') return null;
  const slash = s.indexOf('/');
  try {
    if (slash > 0) {
      const accessLimit = Number.parseInt(s.slice(0, slash), 10);
      const interval = Number.parseInt(s.slice(slash + 1), 10);
      if (!Number.isFinite(accessLimit) || !Number.isFinite(interval)) return null;
      if (accessLimit <= 0 || interval <= 0) return null;
      return { accessLimit, interval };
    }
    const interval = Number.parseInt(s, 10);
    if (!Number.isFinite(interval) || interval <= 0) return null;
    return { accessLimit: 1, interval };
  } catch {
    return null;
  }
}

/** 每源记录（对齐上游 ConcurrentRecord：time/frequency + 规格） */
interface ConcurrentRecord {
  /** 窗口起点（毫秒时间戳） */
  time: number;
  /** 本窗口已放行数 */
  frequency: number;
  spec: ConcurrentRateSpec;
}

/** 全局记录表（键 = 源 `id`；对齐上游 `concurrentRecordMap` 的 ConcurrentHashMap） */
const recordMap = new Map<string, ConcurrentRecord>();

/**
 * 取一次放行名额（同步判定段）。返回需等待的毫秒数（0 = 已放行）。
 * ⚠️ **必须保持同步**：这里同时完成「判定 + 计数」，调用方拿到 0 才算占到了名额。
 */
function tryAcquire(key: string, spec: ConcurrentRateSpec): number {
  const now = Date.now();
  const rec = recordMap.get(key);
  if (!rec) {
    // 新记录 ⇒ 占第一个名额（上游 computeIfAbsent 里 frequency=1）
    recordMap.set(key, { time: now, frequency: 1, spec });
    return 0;
  }
  if (now >= rec.time + rec.spec.interval) {
    // 过了限制时间 ⇒ 重置窗口（上游 fetchStart 分支 2）
    rec.time = now;
    rec.frequency = 1;
    rec.spec = spec; // 规格以最新一次的解析为准（源编辑后 raw 变了）
    return 0;
  }
  if (rec.frequency < rec.spec.accessLimit) {
    rec.frequency++;
    return 0;
  }
  return rec.time + rec.spec.interval - now;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 异步取名额：拿到为止（对齐上游 `getConcurrentRecord` 的 while-retry）。
 * `rate` 为空/`0`/解析失败 ⇒ 立即返回（不限频）。
 */
export async function acquireConcurrentSlot(key: string, rate: unknown): Promise<void> {
  const spec = parseConcurrentRate(rate);
  if (!spec || !key) return;
  for (;;) {
    const waitMs = tryAcquire(key, spec);
    if (waitMs <= 0) return;
    await sleep(waitMs);
  }
}

/** 运行期改限频（上游 `updateConcurrentRate`；当前仅测试/诊断用） */
export function setConcurrentRate(key: string, rate: unknown): void {
  const spec = parseConcurrentRate(rate);
  if (!spec) {
    recordMap.delete(key);
    return;
  }
  const rec = recordMap.get(key);
  if (rec) rec.spec = spec;
  else recordMap.set(key, { time: Date.now(), frequency: 0, spec });
}

/** 诊断：读某源的当前记录（引擎 `/api/diag` 之类可接） */
export function concurrentRateState(key: string): { time: number; frequency: number; spec: ConcurrentRateSpec } | null {
  const rec = recordMap.get(key);
  return rec ? { time: rec.time, frequency: rec.frequency, spec: { ...rec.spec } } : null;
}

/**
 * `#331` 运行期改限频 —— 对齐上游 `ConcurrentRateLimiter.updateConcurrentRate`
 * （ConcurrentRateLimiter.kt:16-44，`source.putConcurrent(value)` 的唯一落点）：
 *  · `a/b` 形态：accessLimit=a、interval=b（任一 ≤0 视为解析失败）；
 *  · 纯数字 n>0：accessLimit=1、interval=n；
 *  · **解析失败 ⇒ 记录原样保留**（上游 catch NumberFormatException → record）；
 *  · 成功 ⇒ 新规格，但 **time / frequency 原样继承**（上游 record?.time ?: now、record?.frequency ?: 0）
 *    —— 改限频不该顺手把「本窗口已发出的请求」计数清零，否则会瞬间超发。
 * 与 `setConcurrentRate`（测试/诊断用，重置窗口）语义不同，别混用。
 */
export function updateConcurrentRate(key: string, value: unknown): boolean {
  if (!key) return false;
  const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
  let spec: ConcurrentRateSpec | null = null;
  if (s) {
    const slash = s.indexOf('/');
    try {
      if (slash > 0) {
        const accessLimit = Number.parseInt(s.slice(0, slash), 10);
        const interval = Number.parseInt(s.slice(slash + 1), 10);
        if (accessLimit > 0 && interval > 0) spec = { accessLimit, interval };
      } else {
        const interval = Number.parseInt(s, 10);
        if (interval > 0) spec = { accessLimit: 1, interval };
      }
    } catch {
      spec = null;
    }
  }
  if (!spec) return false; // 上游：解析失败 → record 原样保留
  const rec = recordMap.get(key);
  if (rec) {
    rec.spec = spec;
  } else {
    recordMap.set(key, { time: Date.now(), frequency: 0, spec });
  }
  return true;
}

/**
 * 诊断快照：全部源记录（`/api/diag` 的 `concurrentRate` 段）。
 * `ageMs` = 窗口起点距今毫秒（> interval 即「下次请求会开新窗口」）。
 */
export function concurrentRateSnapshot(): Record<string, { frequency: number; ageMs: number; spec: ConcurrentRateSpec }> {
  const now = Date.now();
  const out: Record<string, { frequency: number; ageMs: number; spec: ConcurrentRateSpec }> = {};
  for (const [key, rec] of recordMap) {
    out[key] = { frequency: rec.frequency, ageMs: now - rec.time, spec: { ...rec.spec } };
  }
  return out;
}

/** 测试/换配置时清空（上游无对应——记录表随进程存活） */
export function resetConcurrentRate(key?: string): void {
  if (key) recordMap.delete(key);
  else recordMap.clear();
}
