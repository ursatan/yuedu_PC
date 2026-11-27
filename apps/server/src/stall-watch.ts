/**
 * `#460` **卡死取证看门狗** —— 回答「服务端到底是被同步阻塞卡死，还是异步慢」。
 *
 * ## 为什么必须是一个**独立线程**来测
 * 用户 2026-10-15 报：苹果MCS 切分类时服务「卡离线、长时间不恢复、只能重启，**cmd 窗口无任何信息**」。
 * 这类症状有两种完全不同的成因，而它们在前端看**一模一样**：
 *  · **同步阻塞**：主线程被 `Atomics.wait`（`java.ajax` 的 worker 同步取回）/ `execFileSync(curl)` /
 *    `spawnSync` 按住 ⇒ 连 `/api/sources` 都不答，且**日志一行都不会多**（输出也得等循环空下来）；
 *  · **异步饿死**：请求都在等在飞（护栏槽位、慢站、熔断冷却），循环空转 ⇒ 服务还在答，只是慢。
 * ⇒ 判据只有一个：**主线程心跳还在不在**。而心跳只能由**别的线程**来量
 *   （主线程自己的定时器在阻塞期间根本不会跑）。
 *
 * ## 机制（与 `net/sync-fetch-worker.ts` 同一套：共享内存，不经 postMessage）
 *  · 主线程：每 250ms 把 `Date.now()` 写进 `BigInt64Array` 心跳位，并把「在飞动作快照」
 *    写进同一块 SAB 的文本区（主线程阻塞后写完就不再更新 ⇒ 快照正好是**卡死前那一刻**的现场）；
 *  · 看门狗 worker：每 250ms 读心跳。连续 `staleMs` 没动 ⇒ 判定「主线程停摆」，
 *    立刻 `console.error`（**会出现在 cmd 窗口里**，用户不用翻文件）+ 追写报告文件；
 *    恢复时再打一行总时长。
 *  · 同时主线程自己还有一条「慢动作」检测（`slowMs`）：**它会打印说明循环还活着**
 *    —— 与看门狗那行合起来就是定性结论。
 *
 * ⚠️ 这是**取证设施**，不改任何业务行为：开销 = 每 250ms 一次 `Atomics.store` + 一次
 *    小 JSON 序列化；worker 常驻但 `unref()`（不拖住进程退出）。
 * 关闭：`YUEDU_STALL_WATCH=0`。
 *
 * ## `#771` 新增（只加取证字段，不改判定逻辑）
 * `#770` 已证「停摆期间 `blockCounters()` 不涨」⇒ 光有 block 摘要分不出三种情况：
 *  ①**主线程在跑 JS（单个长同步段：GC / `JSON.stringify` / regex）**；
 *  ②**主线程在内核里等**（缺页 / 同步 I/O / `Atomics.wait`）；
 *  ③**主线程根本没被调度**（整机 CPU 抢不到 / 进程被挂起）。
 * 所以在同一块 SAB 里再加三组只读现场，由看门狗在 `[stall]`/`recover` 行一次性输出：
 *  · `main=` 主线程 **本线程** CPU（`process.threadCpuUsage()`）+ 内存（`process.memoryUsage()`）——
 *    主线程自己每 250ms 写一次；冻结期间不更新，`recover` 时再拿到新值 ⇒ 差值就是「冻结期间主线程
 *    到底跑了多少 CPU」。`Δu≈冻结时长` ⇒ 在跑 JS；`Δu≈0` ⇒ 没跑 JS。
 *  · `proc=` **整进程** CPU（`process.cpuUsage()`，worker 侧取）—— 与 `main` 对比可区分
 *    「主线程停但其它线程在忙」（争用）与「整个进程都没跑」（饿死/挂起）。
 *  · `freeze=` `#771` 探针的「最后进入但未退出」的同步段（`packages/core/src/diag/freeze-probe.ts`）
 *    + `gc=` 最近一次 GC。探针默认关，关时这几段为空。
 *  · `recover` 行**延后一个 tick（250ms）**再输出：等主线程的 ticker 把新的 CPU/内存写进 SAB，
 *    这样差值才完整（否则读到的还是冻结前的旧值）。
 */
import { Worker } from 'node:worker_threads';
import { blockCounters, setFreezeSink } from '@yuedu/core';

const HB_OFF = 0;
const LEN_OFF = 8; // Int32
const SNAP_OFF = 16;
const SNAP_CAP = 12 * 1024;
/**
 * `#499` P0-2 **block 摘要区**：主线程每 250ms 把 `blockCounters()`（各类阻塞调用的
 * n/totalMs/maxMs）写进这块共享内存 ⇒ 看门狗判定 stall 时一并写进报告。
 *
 * 为什么必须走 SAB：block 计数器在**主线程**，而主线程停摆时**任何 JS 都不会跑**——
 * 只有独立线程的看门狗能读到「卡死前最后一次更新」的摘要，这正是我们要的现场。
 * （`#497` 实证归因的缺口：风暴时段 block 计数器随重启丢失，归因只能靠推断。）
 */
const BLK_LEN_OFF = SNAP_OFF + SNAP_CAP; // Int32
const BLK_OFF = BLK_LEN_OFF + 4;
const BLK_CAP = 4 * 1024;

/**
 * `#771` **进程/主线程现场区**（全部 8 字节对齐）。
 * `proc` = Float64[6]：主线程 cpu.user(µs) / cpu.system(µs) / rss MB / heapUsed MB / heapTotal MB / external MB。
 */
const PROC_BASE = 16408;
const MARK_TOP_AT_OFF = PROC_BASE + 48; // BigInt64：最内层同步段进入时刻
const MARK_LAST_AT_OFF = MARK_TOP_AT_OFF + 8; // BigInt64：最近一次标记变化时刻
const MARK_GC_AT_OFF = MARK_LAST_AT_OFF + 8; // BigInt64：最近一次 GC 结束时刻
const MARK_INT_OFF = MARK_GC_AT_OFF + 8; // Int32[4]：depth / gcMs / gcKind / textLen
const MARK_OFF = MARK_INT_OFF + 16; // Uint8Array：open=…|last=…
const MARK_CAP = 1024;
const SAB_SIZE = MARK_OFF + MARK_CAP;

/** GC kind 名字（V8 PerformanceObserver('gc') 的 detail.kind） */
const GC_KIND_NAME: Record<number, string> = { 1: 'scavenge', 2: 'major', 4: 'incremental', 8: 'weakcb' };

/**
 * 看门狗线程源码。⚠️ 模板串承载 ⇒ 注释里不能出现反引号；且它是**独立线程**，
 * 主线程停摆时它照跑（这正是整件事成立的前提）。
 */
const WATCHER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { appendFileSync } = require('node:fs');
const sab = workerData.sab;
const hb = new BigInt64Array(sab, ${HB_OFF}, 1);
const len = new Int32Array(sab, ${LEN_OFF}, 1);
const snap = new Uint8Array(sab, ${SNAP_OFF}, ${SNAP_CAP});
const blen = new Int32Array(sab, ${BLK_LEN_OFF}, 1);
const blk = new Uint8Array(sab, ${BLK_OFF}, ${BLK_CAP});
// #771 现场区
const proc = new Float64Array(sab, ${PROC_BASE}, 6);
const mAt = new BigInt64Array(sab, ${MARK_TOP_AT_OFF}, 3);
const mInt = new Int32Array(sab, ${MARK_INT_OFF}, 4);
const mTxt = new Uint8Array(sab, ${MARK_OFF}, ${MARK_CAP});
const staleMs = workerData.staleMs;
const file = workerData.reportFile || '';
const TICK = 250;
let last = Number(Atomics.load(hb, 0));
let stalledSince = 0;
let stallAt = 0;
let stallInfo = null;
let recoverPending = 0;
// #771：在**最后一次心跳**那一刻取整进程 CPU —— 冻结结束时用它的差值 ⇒ proc 的窗口
// 与 main 的窗口（最后一次心跳 → 恢复后第一次心跳）完全对齐，不会被 staleMs 截掉一段
let lastCpu = process.cpuUsage();
let stallWhole = null;
parentPort.postMessage({ ready: true });
setInterval(() => {
  const now = Date.now();
  const v = Number(Atomics.load(hb, 0));
  if (stalledSince) {
    // #771：心跳恢复后**延后一个 tick** 再输出 —— 等主线程 ticker 把新的 CPU/内存写进 SAB，
    // 这样 main/proc 的差值才覆盖整个冻结窗口。
    if (v !== last) {
      last = v;
      lastCpu = process.cpuUsage();
      if (!recoverPending) recoverPending = now;
    }
    if (recoverPending && now - recoverPending >= TICK) {
      emitRecover(now - stalledSince);
      stalledSince = 0;
      stallInfo = null;
      recoverPending = 0;
    }
    return;
  }
  if (v !== last) { last = v; lastCpu = process.cpuUsage(); return; }
  const silent = now - last;
  if (silent >= staleMs) {
    stalledSince = now;
    stallAt = last;
    stallInfo = capture();
    stallWhole = lastCpu;
    emit('stall', silent, snapshot(), freezeText(stallInfo, last), procText(null), wholeProc(null), gcText(stallInfo, now));
  }
}, TICK);
function blocks() {
  try {
    const n = Atomics.load(blen, 0);
    if (!(n > 0)) return '';
    return Buffer.from(blk.subarray(0, Math.min(n, blk.length))).toString('utf8');
  } catch (e) { return ''; }
}
function snapshot() {
  try {
    const n = Atomics.load(len, 0);
    if (!(n > 0)) return '';
    return Buffer.from(snap.subarray(0, Math.min(n, snap.length))).toString('utf8');
  } catch (e) { return ''; }
}
function marker() {
  try {
    const d = Atomics.load(mInt, 0);
    const n = Atomics.load(mInt, 3);
    const txt = n > 0 ? Buffer.from(mTxt.subarray(0, Math.min(n, mTxt.length))).toString('utf8') : '';
    return { d: d, txt: txt, topAt: Number(Atomics.load(mAt, 0)), lastAt: Number(Atomics.load(mAt, 1)) };
  } catch (e) { return { d: 0, txt: '', topAt: 0, lastAt: 0 }; }
}
function capture() {
  const m = marker();
  let gcAt = 0, gcMs = 0, gcKind = 0;
  try { gcAt = Number(Atomics.load(mAt, 2)); gcMs = Atomics.load(mInt, 1); gcKind = Atomics.load(mInt, 2); } catch (e) {}
  return {
    m: m,
    main: { u: proc[0], s: proc[1], rss: proc[2], heapU: proc[3], heapT: proc[4], ext: proc[5] },
    whole: process.cpuUsage(),
    gcAt: gcAt, gcMs: gcMs, gcKind: gcKind,
  };
}
function secs(us) { return (Math.round(us / 1000) / 1000).toFixed(2) + 's'; }
function mb(v) { return (Math.round(v * 10) / 10).toFixed(0); }
function freezeText(info, idleBase) {
  try {
    const m = info.m;
    if (!m.txt && m.d === 0) return '';
    const parts = [];
    parts.push('d=' + m.d);
    if (m.txt) parts.push(m.txt);
    // 注意：idleBase 是**最后一次心跳的时间戳**，而标记可能落在两次心跳之间（<250ms）
    // ⇒ 差值允许为负，这里钳到 0（否则现场出现 topAge=-248ms 这类无意义值）
    if (m.topAt > 0) parts.push('topAge=' + Math.max(0, idleBase - m.topAt) + 'ms');
    if (m.lastAt > 0) parts.push('idle=' + Math.max(0, idleBase - m.lastAt) + 'ms');
    return 'freeze={' + parts.join(' ') + '}';
  } catch (e) { return ''; }
}
function procText(prev) {
  try {
    const cur = { u: proc[0], s: proc[1], rss: proc[2], heapU: proc[3], heapT: proc[4], ext: proc[5] };
    const tag = prev ? 'ΔcpuU=' : 'cpuU=';
    const tagS = prev ? 'ΔcpuS=' : 'cpuS=';
    return 'main={' + tag + secs(prev ? cur.u - prev.u : cur.u) +
      ' ' + tagS + secs(prev ? cur.s - prev.s : cur.s) +
      ' rss=' + mb(cur.rss) + 'MB heap=' + mb(cur.heapU) + '/' + mb(cur.heapT) + 'MB ext=' + mb(cur.ext) + 'MB}';
  } catch (e) { return ''; }
}
function wholeProc(prev) {
  try {
    const c = process.cpuUsage(prev || undefined);
    return 'proc={' + (prev ? 'ΔcpuU=' : 'cpuU=') + secs(c.user) +
      ' ' + (prev ? 'ΔcpuS=' : 'cpuS=') + secs(c.system) + '}';
  } catch (e) { return ''; }
}
function gcText(info, now) {
  try {
    if (!info.gcAt || info.gcAt < stallAt - 1000) return '';
    const names = { 1: 'scavenge', 2: 'major', 4: 'incremental', 8: 'weakcb' };
    return 'gc={' + (names[info.gcKind] || info.gcKind) + ' ' + info.gcMs + 'ms ago=' + (now - info.gcAt) + 'ms}';
  } catch (e) { return ''; }
}
function emitRecover(ms) {
  const info = stallInfo || capture();
  const now = Date.now();
  // GC 用「恢复后」的新现场（冻结期间的 GC 只有结束后才会被观测到）
  const fresh = capture();
  // proc 用「最后一次心跳」的基线 ⇒ 窗口与 main 一致（覆盖整个冻结段）
  const base = stallWhole || info.whole;
  emit('recover', ms, '', freezeText(info, stallAt), procText(info.main), wholeProc(base), gcText(fresh, now));
}
function emit(kind, ms, snap, freeze, mainText, procT, gcT) {
  const b = blocks();
  const line = '[' + new Date().toISOString() + '] [stall] ' + kind + ' ms=' + Math.round(ms) +
    (snap ? ' inflight=' + snap : '') + (b ? ' blocks=' + b : '') +
    (freeze ? ' ' + freeze : '') + (mainText ? ' ' + mainText : '') +
    (procT ? ' ' + procT : '') + (gcT ? ' ' + gcT : '');
  try { process.stderr.write(line + String.fromCharCode(10)); } catch (e) {}
  if (file) { try { appendFileSync(file, line + String.fromCharCode(10)); } catch (e) {} }
}
`;

interface Tracked {
  label: string;
  startedAt: number;
  warned: boolean;
}

const inflight = new Map<string, Tracked>();
let seq = 0;
let hbArr: BigInt64Array | null = null;
let lenArr: Int32Array | null = null;
let snapArr: Uint8Array | null = null;
let blkLenArr: Int32Array | null = null;
let blkArr: Uint8Array | null = null;
let procArr: Float64Array | null = null;
let markAtArr: BigInt64Array | null = null;
let markIntArr: Int32Array | null = null;
let markTxtArr: Uint8Array | null = null;
let worker: Worker | null = null;
let ticker: NodeJS.Timeout | null = null;
let slowTicker: NodeJS.Timeout | null = null;

/** 在飞动作快照（≤ 若干条，按开始时间升序；供看门狗把「卡死前现场」写进报告） */
export function inflightSnapshot(): string {
  const items = [...inflight.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, 8)
    .map((t) => `${t.label}@${Math.round((Date.now() - t.startedAt) / 1000)}s`);
  return items.join(', ');
}

function writeSnapshot(): void {
  if (!snapArr || !lenArr) return;
  const txt = Buffer.from(inflightSnapshot(), 'utf8');
  const n = Math.min(txt.length, snapArr.length);
  snapArr.set(txt.subarray(0, n));
  Atomics.store(lenArr, 0, n);
}

/**
 * `#499` 把 block 计数器摘要写进 SAB（心跳 ticker 每 250ms 调一次）。
 * 摘要只取「分类 + n + totalMs + maxMs」，控制在 4KB 内；失败静默（取证设施不拖累业务）。
 */
function writeBlocks(): void {
  if (!blkArr || !blkLenArr) return;
  try {
    const rows = blockCounters().slice(0, 24).map((r) => ({
      k: r.kind,
      n: r.n,
      t: r.totalMs,
      m: r.maxMs,
    }));
    const txt = Buffer.from(JSON.stringify(rows), 'utf8');
    const n = Math.min(txt.length, blkArr.length);
    blkArr.set(txt.subarray(0, n));
    Atomics.store(blkLenArr, 0, n);
  } catch {
    /* 取证设施：任何失败都不许影响业务 */
  }
}

/** `#771` 主线程**本线程** CPU（µs）；Node 22 有 `process.threadCpuUsage()`，没有就回落整进程 */
function threadCpu(): { user: number; system: number } {
  const fn = (process as unknown as { threadCpuUsage?: () => { user: number; system: number } })
    .threadCpuUsage;
  try {
    if (typeof fn === 'function') return fn.call(process);
  } catch {
    /* ignore */
  }
  return process.cpuUsage();
}

/**
 * `#771` 主线程现状写进 SAB（心跳 ticker 每 250ms 调一次）：
 * 本线程 CPU（µs）+ rss/heap/external（MB）。冻结期间写不进去 ⇒ 看门狗在 `recover`
 * 读到的就是「冻结结束后的值」，差值即冻结期间主线程实际消耗的 CPU。
 */
function writeProcStats(): void {
  if (!procArr) return;
  try {
    const c = threadCpu();
    const m = process.memoryUsage();
    procArr[0] = c.user;
    procArr[1] = c.system;
    procArr[2] = m.rss / (1024 * 1024);
    procArr[3] = m.heapUsed / (1024 * 1024);
    procArr[4] = m.heapTotal / (1024 * 1024);
    procArr[5] = m.external / (1024 * 1024);
  } catch {
    /* 取证设施：任何失败都不许影响业务 */
  }
}

/** `#771` 把探针现场写进 SAB（`freeze-probe` 每 8ms 最多调一次；探针关时根本不会调） */
function writeFreezeMark(s: {
  depth: number;
  open: string;
  last: string;
  topAt: number;
  lastAt: number;
  gcAt: number;
  gcMs: number;
  gcKind: number;
}): void {
  if (!markAtArr || !markIntArr || !markTxtArr) return;
  try {
    Atomics.store(markAtArr, 0, BigInt(s.topAt));
    Atomics.store(markAtArr, 1, BigInt(s.lastAt));
    Atomics.store(markAtArr, 2, BigInt(s.gcAt));
    Atomics.store(markIntArr, 0, s.depth);
    Atomics.store(markIntArr, 1, s.gcMs);
    Atomics.store(markIntArr, 2, s.gcKind);
    const txt = Buffer.from(`open=${s.open}|last=${s.last}`, 'utf8');
    const n = Math.min(txt.length, markTxtArr.length);
    markTxtArr.set(txt.subarray(0, n));
    Atomics.store(markIntArr, 3, n);
  } catch {
    /* 取证设施：任何失败都不许影响业务 */
  }
}

/**
 * 记录一次「在飞动作」；返回**结束函数**（必须调用，否则快照里会留下假现场）。
 * `label` 建议形如 `src:<sourceId> category`。
 */
export function trackStart(label: string): () => void {
  const id = `t${++seq}`;
  inflight.set(id, { label, startedAt: Date.now(), warned: false });
  writeSnapshot();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inflight.delete(id);
    writeSnapshot();
  };
}

/** 启动看门狗（幂等）。`reportFile` 为空则只打 cmd 窗口。 */
export function startStallWatch(opts: { reportFile?: string; staleMs?: number; slowMs?: number } = {}): void {
  if (process.env['YUEDU_STALL_WATCH'] === '0') return;
  if (!worker) {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    hbArr = new BigInt64Array(sab, HB_OFF, 1);
    lenArr = new Int32Array(sab, LEN_OFF, 1);
    snapArr = new Uint8Array(sab, SNAP_OFF, SNAP_CAP);
    blkLenArr = new Int32Array(sab, BLK_LEN_OFF, 1);
    blkArr = new Uint8Array(sab, BLK_OFF, BLK_CAP);
    procArr = new Float64Array(sab, PROC_BASE, 6);
    markAtArr = new BigInt64Array(sab, MARK_TOP_AT_OFF, 3);
    markIntArr = new Int32Array(sab, MARK_INT_OFF, 4);
    markTxtArr = new Uint8Array(sab, MARK_OFF, MARK_CAP);
    Atomics.store(hbArr, 0, BigInt(Date.now()));
    writeSnapshot();
    writeProcStats();
    // `#771`：探针开着时，把「最后进入但未退出」的同步段写进同一块 SAB
    setFreezeSink(writeFreezeMark);
    try {
      worker = new Worker(WATCHER_SRC, {
        eval: true,
        workerData: { sab, staleMs: Math.max(1000, opts.staleMs ?? 5_000), reportFile: opts.reportFile ?? '' },
      });
      worker.unref();
      worker.on('error', (e) => {
        console.warn('[stall-watch] 看门狗线程异常（取证失效，不影响服务）：', String((e as Error)?.message ?? e));
        worker = null;
      });
      worker.on('exit', () => { worker = null; });
    } catch (e) {
      console.warn('[stall-watch] 起不了看门狗线程：', String((e as Error)?.message ?? e));
      worker = null;
    }
  }
  if (!ticker && hbArr) {
    // 心跳：主线程每 250ms 打一次（阻塞期间自然停 ⇒ 看门狗据此判定停摆）
    ticker = setInterval(() => {
      if (hbArr) Atomics.store(hbArr, 0, BigInt(Date.now()));
      // `#499` 顺手把 block 摘要刷进去（与心跳同频，零额外定时器）
      writeBlocks();
      // `#771` 顺手把主线程 CPU/内存刷进去（同上，零额外定时器）
      writeProcStats();
    }, 250);
    ticker.unref?.();
  }
  if (!slowTicker) {
    const slowMs = Math.max(1000, opts.slowMs ?? 8_000);
    // 主线程自己的「慢动作」检测：**这条能打出来就说明循环还活着**（异步慢，不是卡死）
    slowTicker = setInterval(() => {
      const now = Date.now();
      for (const t of inflight.values()) {
        if (t.warned || now - t.startedAt < slowMs) continue;
        t.warned = true;
        console.warn(`[stall] slow（循环仍活）${t.label} 已 ${Math.round((now - t.startedAt) / 1000)}s`);
      }
    }, 2000);
    slowTicker.unref?.();
  }
}

/** 收尾（测试用；服务端不需要）：停线程与定时器 */
export async function disposeStallWatch(): Promise<void> {
  if (ticker) clearInterval(ticker);
  ticker = null;
  if (slowTicker) clearInterval(slowTicker);
  slowTicker = null;
  const w = worker;
  worker = null;
  hbArr = null;
  lenArr = null;
  snapArr = null;
  blkLenArr = null;
  blkArr = null;
  procArr = null;
  markAtArr = null;
  markIntArr = null;
  markTxtArr = null;
  setFreezeSink(null);
  inflight.clear();
  if (w) await w.terminate().catch(() => undefined);
}

/** `#771` GC kind → 名字（供看门狗/文档用；与 WATCHER_SRC 内联表一致） */
export function gcKindName(kind: number): string {
  return GC_KIND_NAME[kind] ?? String(kind);
}
