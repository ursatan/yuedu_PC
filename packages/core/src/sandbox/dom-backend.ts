/**
 * `#743` A 轮 / `#745` 第二批：DOM 后端（常驻 worker）的宿主侧客户端。
 *
 * 设计要点（与 `#333` 的对齐）：
 *  · 全部 dom op 打到 worker 内**同一个** `client` 的 `JsoupDom` 上 —— 不拆表，否则 nid 失效；
 *  · 宿主只做转发 + 超时 + 计数，主线程不再跑 jsdom；
 *  · **默认不启用**（`#745` 用户拍板：先默认关，等合并/预算收口后再评估默认开）。
 *    只有显式 `YUEDU_DOM_WORKER=1` 才起 worker；否则 `createDomClient()` 返回 null，
 *    调用方回落宿主 `JsoupDom`，行为与 `#743` 之前逐字一致；
 *  · worker 起不来 ⇒ null（静默回落宿主）；运行期崩溃 ⇒ 节点表已不可信，后续调用**显式报错**。
 *
 * `#745` 池化：多个源并发时不能都排在同一个 worker 后面（每个 client 的顺序 RPC 会串行化）。
 * 槽位按 `YUEDU_DOM_POOL`（默认 2）惰性增长：单源只起 1 个 worker；并发源超过 1 个时才加位。
 * 一个 client 固定绑一个槽位（保证它那一份 `JsoupDom` 不跨线程漂移）。
 *
 * 入口解析三档（按顺序）：
 *  1. `YUEDU_DOM_WORKER_FILE`（探针/测试显式指定）；
 *  2. 同目录 `dom-worker-entry.ts`（开发/测试：tsx 可直接加载 .ts 的 Worker）；
 *  3. 同目录 `dom-worker.mjs`（桌面 bundle：build-server 额外产出的自包含 ESM worker）。
 * 都找不到 ⇒ 视为不可用（回落宿主）。
 */
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DomClient {
  readonly id: number;
  call(args: unknown): Promise<unknown>;
}

interface Pending {
  slot: Slot;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Slot {
  w: Worker | null;
  broken: boolean;
  clients: number;
  /** 最近一次派发/热身的时间（空闲 TTL 回收的判据）。 */
  lastUsed: number;
}

const stats = { workers: 0, calls: 0, errors: 0, lastMs: 0, warmed: 0, reclaimed: 0 };

/** 池大小（惰性增长，不是预分配）：单源 1 个，多源按需加到上限。 */
const POOL_SIZE = Math.max(1, Number(process.env['YUEDU_DOM_POOL'] ?? 2) || 2);
/** client 映射表上限（求值器是长生命周期的，老条目在没调用后就不再需要）。 */
const MAX_CLIENT_SLOTS = 4096;

const slots: Slot[] = [];
const clientSlot = new Map<number, number>();
const pending = new Map<number, Pending>();
let disabled = false;
let seq = 1;
let clientSeq = 1;
/**
 * **主动释放**的 worker 集合：`terminate()` 也会触发 `exit(code!=0)`，若不区分，
 * 一次正常释放就会被当成崩溃（`broken=true`）——后续调用全 reject。
 * 实测症状：`node:test` 里自动收尾先释放一次，用例随后再调 DOM 就报
 * 「DOM worker 退出（code=1）」。
 */
const stopping = new WeakSet<Worker>();

/** `import.meta.url` 在桌面 bundle 里会被 esbuild 替换成裸路径（非 file URL），两形态都兜住。 */
function selfDir(): string {
  const u = import.meta.url;
  if (u.startsWith('file:')) return path.dirname(fileURLToPath(u));
  return path.dirname(u);
}

function resolveEntry(): string | null {
  const forced = process.env['YUEDU_DOM_WORKER_FILE'];
  if (forced && fs.existsSync(forced)) return forced;
  const dir = selfDir();
  for (const name of ['dom-worker-entry.ts', 'dom-worker.mjs', 'dom-worker.cjs']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function failSlot(slot: Slot, err: Error): void {
  for (const [id, p] of pending) {
    if (p.slot !== slot) continue;
    clearTimeout(p.timer);
    p.reject(err);
    pending.delete(id);
  }
}

function ensureWorker(slot: Slot): Worker | null {
  if (disabled || slot.broken) return null;
  if (slot.w) return slot.w;
  const entry = resolveEntry();
  if (!entry) {
    disabled = true;
    return null;
  }
  try {
    const w = new Worker(entry);
    w.unref();
    w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string; ms?: number }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      stats.lastMs = m.ms ?? 0;
      if (m.ok) p.resolve(m.result);
      else {
        stats.errors += 1;
        p.reject(new Error(`DOM worker: ${m.error ?? 'unknown'}`));
      }
    });
    w.on('error', (e) => {
      if (stopping.has(w)) return; // 主动释放引发的 error/exit 不算崩溃
      slot.broken = true;
      if (slot.w === w) slot.w = null;
      failSlot(slot, new Error(`DOM worker 崩溃：${String(e?.message ?? e)}`));
    });
    w.on('exit', (code) => {
      if (stopping.has(w)) return;
      if (slot.w === w) slot.w = null;
      if (code !== 0) {
        slot.broken = true;
        failSlot(slot, new Error(`DOM worker 退出（code=${code}）`));
      }
    });
    slot.w = w;
    slot.lastUsed = Date.now();
    stats.workers += 1;
    return w;
  } catch {
    disabled = true;
    return null;
  }
}

/**
 * 给新 client 选槽位：没有就建一个；并发源已占满已有槽位且未到上限时加位；
 * 否则选当前 client 最少的那个（尽量不把新源排在同一队的队尾）。
 */
function assignSlot(): number {
  if (!slots.length) {
    slots.push({ w: null, broken: false, clients: 0, lastUsed: Date.now() });
    return 0;
  }
  if (slots.length < POOL_SIZE && slots.every((s) => s.clients >= 1)) {
    slots.push({ w: null, broken: false, clients: 0, lastUsed: Date.now() });
    return slots.length - 1;
  }
  let best = 0;
  for (let i = 1; i < slots.length; i += 1) {
    if ((slots[i] as Slot).clients < (slots[best] as Slot).clients) best = i;
  }
  return best;
}

/** 原始派发（`post` 与预热共用）；调用方负责给出已解析的槽位。 */
function callSlot(slot: Slot, client: number, args: unknown): Promise<unknown> {
  const w = ensureWorker(slot);
  if (!w) {
    return Promise.reject(new Error(slot.broken ? 'DOM worker 已崩溃，活节点表不可恢复' : 'DOM worker 不可用'));
  }
  slot.lastUsed = Date.now();
  const id = seq++;
  const timeoutMs = Math.max(1000, Number(process.env['YUEDU_DOM_TIMEOUT_MS'] ?? 30_000) || 30_000);
  stats.calls += 1;
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      stats.errors += 1;
      reject(new Error(`DOM worker 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    pending.set(id, { slot, resolve, reject, timer });
    w.postMessage({ id, client, args });
  });
}

function post(client: number, args: unknown): Promise<unknown> {
  const idx = clientSlot.get(client);
  const slot = idx === undefined ? undefined : slots[idx];
  if (!slot) {
    return Promise.reject(new Error('DOM worker 不可用'));
  }
  return callSlot(slot, client, args);
}

/** 新建一个 client（= 一个求值器的 DOM 会话）；worker 不可用时返回 null。 */
export function createDomClient(): DomClient | null {
  // `#745`：默认关。缺省值不是 `0` 而是「非 1 一律关」——包括未设置。
  if (process.env['YUEDU_DOM_WORKER'] !== '1') return null;
  const idx = assignSlot();
  const slot = slots[idx] as Slot;
  if (!ensureWorker(slot)) return null;
  const id = clientSeq++;
  if (clientSlot.size >= MAX_CLIENT_SLOTS) {
    const oldest = clientSlot.keys().next().value;
    if (oldest !== undefined) clientSlot.delete(oldest);
  }
  clientSlot.set(id, idx);
  slot.clients += 1;
  return { id, call: (args: unknown) => post(id, args) };
}

/** 预热个数：默认 0（保持 `#745` 的「不预热」现状）；上限 = 池大小。 */
function warmupCount(): number {
  if (process.env['YUEDU_DOM_WORKER'] !== '1') return 0;
  const raw = Number(process.env['YUEDU_DOM_WARMUP'] ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(POOL_SIZE, Math.max(0, Math.round(raw)));
}

/** 空闲 TTL（默认 120s；0 = 不回收）。 */
function idleTtlMs(): number {
  const raw = Number(process.env['YUEDU_DOM_TTL_MS'] ?? 120_000);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/** 预热专用的 client id：worker 侧 `ping` **不建** `JsoupDom`（见 dom-worker-entry）。 */
const WARMUP_CLIENT = -1;

export interface DomWarmupResult {
  /** 配置想预热几个 */
  wanted: number;
  /** 本次实际起/复用的槽位 */
  spawned: number;
  /** `ping` 成功的个数（jsdom 模块装载与线程启动已付掉） */
  warmed: number;
  ms: number;
}

let warmupRunning: Promise<DomWarmupResult | null> | null = null;

/**
 * `#754` A 第二批：**启动预热**。
 *
 * 只付「worker 线程启动 + jsdom 模块装载」这笔钱（`ping` 不建文档），不跑任何源规则；
 * 后台进行（先让出一拍），不占启动关键路径。默认 `YUEDU_DOM_WARMUP=0` ⇒ 完全不预热，
 * 行为与 `#745` 一致。重复调用共享同一个在飞 Promise。
 */
export function prewarmDomBackend(): Promise<DomWarmupResult | null> {
  if (warmupRunning) return warmupRunning;
  const wanted = warmupCount();
  if (wanted <= 0) return Promise.resolve(null);
  const run = (async (): Promise<DomWarmupResult> => {
    const t0 = Date.now();
    // 给启动路径（listen/子进程 ready 日志）让路：Worker 构造与首条消息都排到下一拍。
    await new Promise<void>((r) => setTimeout(r, 0));
    const targets: Slot[] = [];
    for (let i = 0; i < wanted; i += 1) {
      if (!slots[i]) slots.push({ w: null, broken: false, clients: 0, lastUsed: Date.now() });
      const slot = slots[i] as Slot;
      if (!ensureWorker(slot)) break;
      targets.push(slot);
    }
    const settled = await Promise.allSettled(targets.map((s) => callSlot(s, WARMUP_CLIENT, { op: 'ping' })));
    const warmed = settled.filter((r) => r.status === 'fulfilled').length;
    stats.warmed += warmed;
    const ms = Date.now() - t0;
    console.log(`[dom] 预热完成 ${warmed}/${wanted} 个 worker · ${ms}ms`);
    armTtl();
    return { wanted, spawned: targets.length, warmed, ms };
  })();
  warmupRunning = run
    .catch((e): DomWarmupResult | null => {
      console.warn(`[dom] 预热失败（不影响功能）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    })
    .finally(() => { warmupRunning = null; });
  return warmupRunning;
}

let ttlTimer: NodeJS.Timeout | null = null;

/** 空闲回收：**只拆没有 client 的槽位**（有求值器会话 ⇒ 拆线程会带走 nid，`#745` 结论）。 */
function armTtl(): void {
  if (ttlTimer) return;
  const ttl = idleTtlMs();
  if (!ttl) return;
  const tick = Math.max(50, Math.min(30_000, Math.floor(ttl / 2)));
  ttlTimer = setInterval(() => { void reclaimIdle(ttl); }, tick);
  ttlTimer.unref?.();
}

async function reclaimIdle(ttl: number): Promise<void> {
  const now = Date.now();
  for (const slot of slots) {
    if (!slot.w || slot.broken || slot.clients > 0) continue;
    if (now - slot.lastUsed < ttl) continue;
    let busy = false;
    for (const [, p] of pending) if (p.slot === slot) { busy = true; break; }
    if (busy) continue;
    const w = slot.w;
    slot.w = null;
    stopping.add(w);
    stats.reclaimed += 1;
    await w.terminate().catch(() => undefined);
    console.log(`[dom] 空闲回收 worker（ttl=${ttl}ms，累计 ${stats.reclaimed}）`);
  }
}

/** 诊断/测试用：worker 是否被启用、调用计数。 */
export function domBackendStatus(): {
  enabled: boolean;
  broken: boolean;
  entry: string | null;
  active: number;
  slots: number;
  warmup: { wanted: number; ttlMs: number };
} & typeof stats {
  return {
    enabled: slots.some((s) => !!s.w),
    broken: slots.some((s) => s.broken),
    entry: resolveEntry(),
    active: slots.filter((s) => !!s.w).length,
    slots: slots.length,
    warmup: { wanted: warmupCount(), ttlMs: idleTtlMs() },
    ...stats,
  };
}

/** 释放常驻 worker（测试收尾 / 进程退出）。生产是常驻的，不会主动调用。 */
export async function disposeDomBackend(): Promise<void> {
  if (ttlTimer) {
    clearInterval(ttlTimer);
    ttlTimer = null;
  }
  const all = slots.map((s) => s.w).filter((w): w is Worker => !!w);
  // 释放后所有 client 的活节点表都已不存在 ⇒ 计数一并清零（否则新会话会被旧计数挡住 TTL/选槽）
  for (const s of slots) {
    s.w = null;
    s.clients = 0;
    s.lastUsed = Date.now();
  }
  clientSlot.clear();
  for (const [, p] of pending) clearTimeout(p.timer);
  pending.clear();
  for (const w of all) {
    stopping.add(w);
    await w.terminate().catch(() => undefined);
  }
}

/**
 * `node:test` 的收尾兼容：`worker.unref()` 在「父线程与 worker 交换过消息」后仍会留下
 * 一个 ref 的 MessagePort ⇒ 测试子进程不退出（`tsx --test` 实测挂死）。
 *
 * ⚠️ **不能**用「空闲 N ms 就 `terminate`」：全量并行跑时用例之间的间隔会超过 N，
 * 中途拆 worker 会把该 client 的活节点表（`nid`）带走 ⇒ `#646` 的
 * `remove`/`outerHtml` 用例直接失败（实测）。`#333` 的身份语义要求拆表只发生在
 * 「这个求值器彻底不用了」的时刻。
 *
 * 正确做法：在测试上下文里挂 `node:test` 的 `after` —— **本文件所有用例跑完**才释放。
 * 生产（长驻服务）不触发；非测试文件上下文（独立脚本）退回 `beforeExit` 兜底。
 */
let testHookArmed = false;
function armTestCleanup(): void {
  if (testHookArmed || !process.env['NODE_TEST_CONTEXT']) return;
  testHookArmed = true;
  void import('node:test').then((t) => {
    try {
      t.after(async () => { await disposeDomBackend(); });
    } catch {
      /* 不在测试文件上下文 ⇒ 交给 beforeExit */
    }
  }).catch(() => undefined);
}

// 一次性脚本：事件循环空了就收掉 worker（生产是长驻服务，不会走到这里）。
process.once('beforeExit', () => { void disposeDomBackend(); });
armTestCleanup();
