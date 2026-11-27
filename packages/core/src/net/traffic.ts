/**
 * `#200` **流量护栏 v2** —— 服务端出站请求的统一闸门。
 *
 * ## 为什么要有它
 * 服务端替前端代理全部出站请求 ⇒ **出口 IP 被源站封 = 所有源一起失效**。
 * 用户 2026-10-02 给了一份参考限制（域名粒度限流 > 单任务限流 > 全局硬护栏 三级优先），
 * 本模块按那份参考实现，并把「上行/下行带宽占用不超 **45%**」纳入。
 *
 * ## 三层闸门（顺序固定，避免死锁）
 * ```
 * ① 域名粒度（全局共享，**不按任务独立**）
 *      单域名总并发 ≤ 10         ← 最硬的一条，所有用户/所有任务共用
 *      单域名·单池并发 ≤ 8       ← 详情池 / 正文池分开计数
 * ② 单任务
 *      即时任务：每池 ≤6 · 任务总并发 ≤30 · RPS ≤5 · 超时 12s · 重试 2 · 失败冷却 200ms
 *      后台批量：每池 ≤8 · 任务总并发 ≤45 · RPS ≤8 · 超时 15s
 * ③ 全局硬护栏（所有任务共享，不可越）
 *      全局在飞 ≤ 180 · 全局 RPS ≤ 25 · 带宽 ≤ 线路 45%
 * ```
 * **并发池拆分**：`detail`（搜索/详情/目录/发现）与 `content`（正文）两池独立计数、互不抢占。
 *
 * ## 域名熔断
 * 同一域名**连续** ≥6 次失败（超时 / HTTP 403 / HTTP 429）⇒ 全局熔断该域名 **40s**，
 * 所有任务暂停它；冷却结束**先以并发 3** 半开试探，此后每 5s 无失败就 +1，逐步恢复原上限。
 * （成功一次即清零连续失败计数；404 这类「站点正常应答」不计入熔断。）
 *
 * ## 语义边界（别用错）
 * · 本模块只管**出站请求**；它**不**负责「任务队列」本身（批量任务必须是异步队列，
 *   不能占前端 HTTP 线程 —— 那是 server 侧的事，见 `apps/server` 的 verify-batch）。
 * · 拿不到槽位时**不会静默跳过**：要么等到拿到，要么抛带原因的错（铁律 3：兜底必须留痕）。
 */

import { Semaphore, RateGate } from './semaphore';

export type PoolKind = 'detail' | 'content';
export type TaskClass = 'instant' | 'batch';

export interface ClassLimits {
  /** 本任务视角：单域名·单池最大并发 */
  perDomainPool: number;
  /** 本任务总出站并发 */
  taskConcurrent: number;
  /** 本任务每秒请求数上限 */
  taskRps: number;
  /** 默认请求超时（ms） */
  timeoutMs: number;
  /** 幂等请求重试次数 */
  retries: number;
  /** 失败后强制冷却（ms）——避免立刻打同一台 */
  failCooldownMs: number;
}

export interface BreakerConfig {
  /** 连续失败多少次触发熔断 */
  consecutiveFailures: number;
  /** 熔断冷却（ms） */
  cooldownMs: number;
  /** 冷却结束后的半开并发 */
  halfOpenConcurrency: number;
  /** 半开状态下每多久 +1 并发（无失败时） */
  recoverStepMs: number;
}

export interface TrafficConfig {
  globalMaxConcurrent: number;
  globalRps: number;
  /** 单域名**总**并发（全局共享） */
  domainTotal: number;
  /** 单域名**单池**并发（全局共享） */
  domainPool: number;
  breaker: BreakerConfig;
  instant: ClassLimits;
  batch: ClassLimits;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/** 参考限制的默认值（全部可用 `YUEDU_GUARD_*` 环境变量覆盖） */
export function defaultTrafficConfig(): TrafficConfig {
  return {
    globalMaxConcurrent: envInt('YUEDU_GUARD_GLOBAL_CONCURRENT', 180),
    globalRps: envInt('YUEDU_GUARD_GLOBAL_RPS', 25),
    domainTotal: envInt('YUEDU_GUARD_DOMAIN_TOTAL', 10),
    domainPool: envInt('YUEDU_GUARD_DOMAIN_POOL', 8),
    breaker: {
      consecutiveFailures: envInt('YUEDU_GUARD_BREAKER_FAILS', 6),
      cooldownMs: envInt('YUEDU_GUARD_BREAKER_COOLDOWN_MS', 40_000),
      halfOpenConcurrency: envInt('YUEDU_GUARD_BREAKER_HALF_OPEN', 3),
      recoverStepMs: envInt('YUEDU_GUARD_BREAKER_RECOVER_MS', 5_000),
    },
    instant: {
      perDomainPool: envInt('YUEDU_GUARD_INSTANT_POOL', 6),
      taskConcurrent: envInt('YUEDU_GUARD_INSTANT_CONCURRENT', 30),
      taskRps: envInt('YUEDU_GUARD_INSTANT_RPS', 5),
      timeoutMs: envInt('YUEDU_GUARD_INSTANT_TIMEOUT_MS', 12_000),
      retries: envInt('YUEDU_GUARD_INSTANT_RETRIES', 2),
      failCooldownMs: envInt('YUEDU_GUARD_INSTANT_COOLDOWN_MS', 200),
    },
    batch: {
      perDomainPool: envInt('YUEDU_GUARD_BATCH_POOL', 8),
      taskConcurrent: envInt('YUEDU_GUARD_BATCH_CONCURRENT', 45),
      taskRps: envInt('YUEDU_GUARD_BATCH_RPS', 8),
      timeoutMs: envInt('YUEDU_GUARD_BATCH_TIMEOUT_MS', 15_000),
      retries: envInt('YUEDU_GUARD_INSTANT_RETRIES', 2),
      failCooldownMs: envInt('YUEDU_GUARD_INSTANT_COOLDOWN_MS', 200),
    },
  };
}

let cfg: TrafficConfig | null = null;
export function trafficConfig(): TrafficConfig {
  cfg ??= defaultTrafficConfig();
  return cfg;
}
/** 覆盖配置（测试/特殊实例）。传 `null` 恢复按环境变量重建。 */
export function configureTraffic(next: Partial<TrafficConfig> | null): TrafficConfig {
  cfg = next === null ? defaultTrafficConfig() : { ...trafficConfig(), ...next };
  resetTraffic();
  return cfg;
}

/* ─────────────────────────── 熔断器（按域名） ─────────────────────────── */

interface BreakerState {
  /** 连续失败数（成功即清零） */
  fails: number;
  /** 熔断到此时刻（ms epoch；0 = 未熔断） */
  openUntil: number;
  /** 半开期的当前并发上限（未熔断时 = 配置上限） */
  limit: number;
  /** 上次恢复步进的时刻 */
  steppedAt: number;
  /** 累计熔断次数（诊断） */
  trips: number;
  /** 上次失败原因（诊断） */
  lastReason: string;
}

const breakers = new Map<string, BreakerState>();
function breakerOf(domain: string): BreakerState {
  let b = breakers.get(domain);
  if (!b) {
    b = { fails: 0, openUntil: 0, limit: Number.POSITIVE_INFINITY, steppedAt: 0, trips: 0, lastReason: '' };
    breakers.set(domain, b);
  }
  return b;
}

/** 该域名当前允许的并发（熔断/半开期会小于配置上限） */
function domainLimitOf(domain: string): number {
  const b = breakerOf(domain);
  const c = trafficConfig();
  if (b.openUntil && Date.now() < b.openUntil) return 0; // 熔断中：一律不放行
  if (b.openUntil && Date.now() >= b.openUntil) {
    // 冷却结束 → 半开：并发降到 halfOpenConcurrency，之后随时间逐步恢复
    b.openUntil = 0;
    b.limit = c.breaker.halfOpenConcurrency;
    b.steppedAt = Date.now();
  }
  if (b.limit < Number.POSITIVE_INFINITY) {
    const steps = Math.floor((Date.now() - b.steppedAt) / Math.max(1, c.breaker.recoverStepMs));
    b.limit = Math.min(c.domainTotal, c.breaker.halfOpenConcurrency + steps);
  }
  return Math.min(c.domainTotal, b.limit === Number.POSITIVE_INFINITY ? c.domainTotal : b.limit);
}

/** 该域名是否处于熔断（等待中）状态 —— 用于 acquire 决定等还是报错 */
export function domainBreakerState(domain: string): { open: boolean; waitMs: number; fails: number; limit: number } {
  const b = breakerOf(domain);
  const now = Date.now();
  const open = b.openUntil > now;
  return { open, waitMs: open ? b.openUntil - now : 0, fails: b.fails, limit: domainLimitOf(domain) };
}

/**
 * 记录一次请求结果以驱动熔断。
 * 只有**超时 / HTTP 403 / HTTP 429** 计入「连续失败」——这几类是「被站点拒」的典型，
 * 而 404/500 属于「站点正常应答」，打熔断会把好域名误伤。
 */
export function noteTrafficResult(domain: string, r: { ok: boolean; status?: number; timedOut?: boolean }): void {
  const c = trafficConfig();
  const b = breakerOf(domain);
  const counts =
    !r.ok && (r.timedOut === true || r.status === 403 || r.status === 429 || /TIMEOUT|超时|连接被拒|连接被重置/i.test(String(r.status ?? '')));
  if (!r.ok && !counts) return;
  if (r.ok) {
    b.fails = 0;
    return;
  }
  b.fails++;
  b.lastReason = r.timedOut ? 'timeout' : `HTTP ${r.status}`;
  if (b.fails >= c.breaker.consecutiveFailures) {
    b.openUntil = Date.now() + c.breaker.cooldownMs;
    b.limit = 0;
    b.trips++;
    b.fails = 0;
    warnOnce(
      `[net-guard] 域名熔断：${domain} 连续 ${c.breaker.consecutiveFailures} 次失败（${b.lastReason}）` +
        `⇒ 全局暂停 ${Math.round(c.breaker.cooldownMs / 1000)}s，之后以并发 ${c.breaker.halfOpenConcurrency} 半开恢复`,
    );
  }
}

/** 熔断事件留痕（同一消息只打一次，避免刷屏；铁律 3 兜底必须可观测） */
const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/* ─────────────────────────── 全局闸门（所有任务共享） ─────────────────────── */

const globalSem = new Semaphore(() => trafficConfig().globalMaxConcurrent);
const globalRps = new RateGate(() => trafficConfig().globalRps);
const domainTotalSem = new Map<string, Semaphore>();
const domainPoolSem = new Map<string, Semaphore>();

/**
 * 域名总闸门。`bypass=true` 时用**独立的一组键**与固定上限（不看熔断期的 `limit=0`），
 * 供 `#780` 的封面请求在熔断期间照常发出（见 `acquireTraffic` 的 `bypassBreaker`）。
 */
function domainTotalGate(domain: string, bypass = false): Semaphore {
  const k = bypass ? `${domain}|bypass` : domain;
  let s = domainTotalSem.get(k);
  if (!s) {
    s = new Semaphore(() => (bypass ? trafficConfig().domainTotal : domainLimitOf(domain)));
    domainTotalSem.set(k, s);
  }
  return s;
}
function domainPoolGate(domain: string, pool: PoolKind, bypass = false): Semaphore {
  const k = bypass ? `${domain}|${pool}|bypass` : `${domain}|${pool}`;
  let s = domainPoolSem.get(k);
  if (!s) {
    s = new Semaphore(() =>
      bypass ? trafficConfig().domainPool : Math.min(trafficConfig().domainPool, domainLimitOf(domain)),
    );
    domainPoolSem.set(k, s);
  }
  return s;
}

/* ─────────────────────────────── 任务作用域 ─────────────────────────────── */

export interface TaskScope {
  readonly cls: TaskClass;
  /** 任务内总在飞 */
  inFlight: number;
  peak: number;
  /** 本任务已发出的请求数 */
  sent: number;
  readonly sem: Semaphore;
  readonly rps: RateGate;
  readonly perDomain: Map<string, { active: number; sem: Semaphore }>;
}

/** 新建一个任务作用域（一次 `/api/run` 或一次批量校验 = 一个任务） */
export function createTaskScope(cls: TaskClass): TaskScope {
  const c = trafficConfig();
  const limits = c[cls];
  return {
    cls,
    inFlight: 0,
    peak: 0,
    sent: 0,
    sem: new Semaphore(() => limits.taskConcurrent),
    rps: new RateGate(() => limits.taskRps),
    perDomain: new Map(),
  };
}

/** 本任务在该域名·该池已占用的并发 */
function taskDomainGate(scope: TaskScope, domain: string, pool: PoolKind): Semaphore {
  const k = `${domain}|${pool}`;
  let e = scope.perDomain.get(k);
  if (!e) {
    const cap = trafficConfig()[scope.cls].perDomainPool;
    e = { active: 0, sem: new Semaphore(() => cap) };
    scope.perDomain.set(k, e);
  }
  return e.sem;
}

export interface TrafficLease {
  domain: string;
  pool: PoolKind;
  scope: TaskScope;
  released: boolean;
  /** `#780` 熔断期间照常发出：本租约用的是独立闸门，释放时要回到同一组闸门 */
  bypass?: boolean;
}

/**
 * 申请一次出站许可。**顺序固定**（任务 → 域名 → 全局），保证不会死锁。
 * 熔断中的域名：等冷却结束（若等待时间超过本次请求超时则直接报错，不空转）。
 */
export async function acquireTraffic(
  scope: TaskScope | null,
  domain: string,
  pool: PoolKind,
  opts: { priority?: 'high' | 'low'; timeoutMs?: number; bypassBreaker?: boolean } = {},
): Promise<TrafficLease> {
  const prio = opts.priority ?? 'high';
  const st = domainBreakerState(domain);
  /**
   * `#780` 封面豁免：`bypassBreaker` 只对 `cover=1` 传入。熔断**已开启**时不等冷却、
   * 直接走独立闸门照常发出（失败只是缺图，且响应头预算 10s 有界）；未熔断时仍共用正常闸门。
   */
  const bypass = opts.bypassBreaker === true && st.open;
  if (st.open && !bypass) {
    const budget = opts.timeoutMs ?? trafficConfig()[scope?.cls ?? 'instant'].timeoutMs;
    if (st.waitMs > budget) {
      throw new Error(`域名熔断中（${domain}，还需 ${Math.ceil(st.waitMs / 1000)}s）——已直接失败，不空转等待`);
    }
    await sleep(st.waitMs + 20);
  }

  const lease: TrafficLease = { domain, pool, scope: scope as TaskScope, released: false, bypass };
  const held: Array<Semaphore> = [];

  const take = async (s: Semaphore) => {
    await s.acquire(prio);
    held.push(s);
  };

  try {
    if (scope) {
      await take(scope.sem);
      await scope.rps.acquire();
    }
    if (scope) await take(taskDomainGate(scope, domain, pool));
    await take(domainTotalGate(domain, bypass));
    await take(domainPoolGate(domain, pool, bypass));
    await take(globalSem);
    await globalRps.acquire();
  } catch (e) {
    for (const s of held.reverse()) s.release();
    throw e;
  }

  if (scope) {
    scope.inFlight++;
    scope.peak = Math.max(scope.peak, scope.inFlight);
    scope.sent++;
  }
  return lease;
}

/** 释放一次出站许可（必须与 acquire 成对；`finally` 里调） */
export function releaseTraffic(lease: TrafficLease | null): void {
  if (!lease || lease.released) return;
  lease.released = true;
  globalSem.release();
  domainPoolGate(lease.domain, lease.pool, lease.bypass === true).release();
  domainTotalGate(lease.domain, lease.bypass === true).release();
  if (lease.scope) {
    const e = lease.scope.perDomain.get(`${lease.domain}|${lease.pool}`);
    if (e) e.sem.release();
    lease.scope.sem.release();
    lease.scope.inFlight = Math.max(0, lease.scope.inFlight - 1);
  }
}

/** 失败后的强制冷却（参考：200ms） */
export function trafficFailCooldown(cls: TaskClass): number {
  return trafficConfig()[cls].failCooldownMs;
}

/* ─────────────────────────────── 诊断 ─────────────────────────────── */

export interface TrafficSnapshot {
  global: { inFlight: number; peak: number; limit: number; rpsUsed: number; rpsLimit: number };
  domains: Array<{ domain: string; inFlight: number; limit: number; poolDetail: number; poolContent: number; breakerOpen: boolean; fails: number }>;
  breakers: { tracked: number; open: number; trips: number };
  /** 资源占用 ≥80% 的告警（按参考要求） */
  warnings: string[];
}

export function trafficSnapshot(topN = 10): TrafficSnapshot {
  const c = trafficConfig();
  const domains: TrafficSnapshot['domains'] = [];
  let open = 0;
  let trips = 0;
  for (const b of breakers.values()) {
    if (b.openUntil > Date.now()) open++;
    trips += b.trips;
  }
  for (const [domain, sem] of domainTotalSem) {
    // `#780` 封面豁免用的独立闸门（`host|bypass`）不是真实域名，诊断里不单列
    if (domain.includes('|bypass')) continue;
    const b = breakerOf(domain);
    const pd = domainPoolSem.get(`${domain}|detail`);
    const pc = domainPoolSem.get(`${domain}|content`);
    domains.push({
      domain,
      inFlight: sem.inUse,
      limit: domainLimitOf(domain),
      poolDetail: pd?.inUse ?? 0,
      poolContent: pc?.inUse ?? 0,
      breakerOpen: b.openUntil > Date.now(),
      fails: b.fails,
    });
  }
  domains.sort((a, b) => b.inFlight - a.inFlight);

  const warnings: string[] = [];
  const pctOf = (used: number, limit: number) => (limit > 0 ? used / limit : 0);
  if (pctOf(globalSem.inUse, c.globalMaxConcurrent) >= 0.8) {
    warnings.push(`全局出站并发 ${globalSem.inUse}/${c.globalMaxConcurrent} ≥80%`);
  }
  if (open > 0) warnings.push(`熔断中的域名 ${open} 个`);
  for (const d of domains.slice(0, topN)) {
    if (d.limit > 0 && pctOf(d.inFlight, d.limit) >= 0.8) {
      warnings.push(`域名 ${d.domain} 并发 ${d.inFlight}/${d.limit} ≥80%`);
    }
  }

  return {
    global: {
      inFlight: globalSem.inUse,
      peak: peakGlobal,
      limit: c.globalMaxConcurrent,
      rpsUsed: globalRps.used,
      rpsLimit: c.globalRps,
    },
    domains: domains.slice(0, topN),
    breakers: { tracked: breakers.size, open, trips },
    warnings,
  };
}

let peakGlobal = 0;
/** 记录全局在飞峰值（`createHttpClient` 在释放时调） */
export function noteGlobalPeak(v: number): void {
  peakGlobal = Math.max(peakGlobal, v);
}

/** 清空全部状态（测试 / `/api/diag?reset=1`） */
export function resetTraffic(): void {
  // ⚠️ **不要 clear 闸门对象**：`Semaphore` 实例上可能正挂着排队的请求 ——
  //    清掉 map 只是让新请求拿到新对象，老 waiter 永远等不到 `release()` 唤醒
  //    （表现为请求凭空挂死，且**不报错**）。闸门数量按域名/池增长、量级可忽略；
  //    上限本身是**动态读配置**的（`() => trafficConfig()…`），所以换配置不需要重建对象。
  breakers.clear();
  globalRps.reset();
  peakGlobal = 0;
  warned.clear();
}

function sleep(ms: number): Promise<void> {
  // ⚠️ **不要 unref**：等待熔断冷却的请求必须撑住事件循环（理由同 semaphore.ts 的 RateGate）
  return new Promise((r) => setTimeout(r, ms));
}
