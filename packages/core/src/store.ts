/**
 * 内存版存储实现（后面会换成按 sourceId 隔离 + 持久化的版本）
 * 现阶段先让引擎能跑起来。
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { VariableStore, KeyValueStore } from './contract/engine';
// `#771` 冻结探针（默认关；`YUEDU_FREEZE_PROBE=1` 开）
import { probeEnter, probeLeave } from './diag/freeze-probe';

export function createVariableStore(init: Record<string, unknown> = {}): VariableStore {
  const map = new Map<string, unknown>(Object.entries(init));
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    has: (k) => map.has(k),
    delete: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
    load: (vars) => {
      for (const [k, v] of Object.entries(vars)) map.set(k, v);
    },
  };
}

export function createMemoryKeyValueStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

/** `#757` E：落盘写队列的可观测计数（`/api/diag.kv`） */
export interface StoreWriteStats {
  /** 累计 set/delete 调用次数 */
  writes: number;
  /** 累计提交给写队列的快照次数 */
  queued: number;
  /** 成功落盘次数 */
  flushed: number;
  /** 因已有一个在飞/已排队的快照而被合并掉的写入次数 */
  coalesced: number;
  /** 失败次数（worker 异常 / 写盘异常） */
  errors: number;
  /** 当前是否有快照在飞（0/1） */
  inFlight: number;
  /** 当前是否有未落盘的新数据（0/1） */
  pending: number;
  /** 最近一次落盘耗时（worker 侧实测，毫秒） */
  lastFlushMs: number;
  /** 最近一次落盘的字节数 */
  lastBytes: number;
  /** 最近一次落盘时间戳 */
  lastFlushAt: number;
  /** 写线程状态：on=就绪 / off=尚未启动 / broken=不可用（回落主线程异步写） */
  writer: 'on' | 'off' | 'broken';
}

/** `#757` E：带异步写队列的文件存储（`KeyValueStore` 的超集） */
export interface FileKeyValueStore extends KeyValueStore {
  stats(): StoreWriteStats;
  /** 立即落盘并等待完成（测试 / 关键节点用） */
  flush(): Promise<void>;
  /** **同步**落盘（仅进程退出/桌面关闭这类不能 await 的路径） */
  flushSync(): void;
  /** flushSync + 停掉写线程 */
  close(): void;
}

export interface FileKeyValueStoreOptions {
  /** 防抖窗口（默认 300ms，与历史行为一致） */
  debounceMs?: number;
  /** 是否保留 `.bak` 上一版（默认 true，D9 方案的兜底） */
  keepBackup?: boolean;
  /** `flushSync` 等待写线程的最长时间（默认 3000ms） */
  syncWriteTimeoutMs?: number;
}

/**
 * 写线程（内联源码，`eval: true`）—— 把 **JSON 序列化 + 写临时文件 + rename + .bak 备份**
 * 全部挪出主线程。
 *
 * 为什么连序列化也要挪：`kv.json` 实测 6.0MB / 2197 键，单次 flush 拆开是
 * 序列化 26.5ms + 备份 6ms + 写 41.9ms（p50 合计 ≈ 65ms，p90 ≈ 119ms）。
 * 只把 I/O 改成异步仍会留下 ~26ms 的 CPU 阻塞；整段交给写线程后主线程只剩
 * `postMessage` 的结构化克隆（实测 p50 7.7ms）。
 *
 * 原子性：写 `<file>.tmp-w` 再 `rename` 覆盖（同卷 rename 原子）⇒ 断电/强杀不会留下半截 JSON。
 * FIFO：同一 worker 的消息顺序 = 提交顺序，`flushSync` 依赖这一点保证「退出时最后一次写最后落盘」。
 */
const WRITER_WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
function ack(signal, ok) {
  if (!signal) return;
  Atomics.store(signal, 0, ok ? 1 : 2);
  Atomics.notify(signal, 0);
}
parentPort.on('message', (m) => {
  const t0 = performance.now();
  let bytes = 0;
  try {
    const text = JSON.stringify(m.obj);
    bytes = Buffer.byteLength(text);
    if (m.bak) {
      try { fs.copyFileSync(m.file, m.file + '.bak'); } catch { /* 首次无旧文件 */ }
    }
    const tmp = m.file + '.tmp-w';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, m.file);
    ack(m.signal, true);
    parentPort.postMessage({ seq: m.seq, ok: true, ms: performance.now() - t0, bytes });
  } catch (e) {
    ack(m.signal, false);
    parentPort.postMessage({
      seq: m.seq,
      ok: false,
      ms: performance.now() - t0,
      bytes,
      error: String((e && e.message) || e),
    });
  }
});
`;

/**
 * 文件版键值存储（跨请求、跨进程重启持久）—— 宿主注入给 `ctx.storage` 用。
 *
 * 为什么必须持久：引擎里有三类「按源」的状态都走 storage：
 *  ① 源变量 `source-var:<id>`（Legado `BaseSource.variable`，七猫分组等）
 *  ② 发现页交互输入 `explore-input:<id>`（Legado `InfoMap`）
 *  ③ 其他引擎私有缓存
 * 此前 hub 每个请求 new 一个内存 store → 这些状态**请求结束即丢**（表现为「切换分组后再点二级控件又跳回默认」）。
 *
 * ## 实现（`#757` E）
 * 内存 Map 为**唯一真源** + 300ms 防抖 + **写线程异步落盘**：
 *  · 读：永远读内存 ⇒ 写完立刻读一定读得到（落盘只影响重启后的可见性）；
 *  · 写：`set` 只改内存并排一个**快照**（同一防抖窗口内的连续写只落最后一次）；
 *  · 队列有界：同键写入合并成一个整文件快照，最多 1 个在飞 + 1 个待排（不存在无界堆积）；
 *  · 退出：`flushSync()` 把最终快照排到 worker 队尾并 `Atomics.wait` 等它落完
 *    （FIFO ⇒ 最后写入的一定是最终状态；超时/worker 不可用才回落主线程同步写）。
 */
export function createFileKeyValueStore(
  filePath: string,
  opts: FileKeyValueStoreOptions = {},
): FileKeyValueStore {
  const debounceMs = opts.debounceMs ?? 300;
  const keepBackup = opts.keepBackup !== false;
  const syncWriteTimeoutMs = opts.syncWriteTimeoutMs ?? 3000;

  const map = new Map<string, string>();
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) if (v != null) map.set(k, String(v));
  } catch {
    /* 首次运行 / 文件损坏 → 空存储 */
  }

  const stats: StoreWriteStats = {
    writes: 0,
    queued: 0,
    flushed: 0,
    coalesced: 0,
    errors: 0,
    inFlight: 0,
    pending: 0,
    lastFlushMs: 0,
    lastBytes: 0,
    lastFlushAt: 0,
    writer: 'off',
  };

  let dirty = false;
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failStreak = 0;

  let worker: Worker | null = null;
  let workerBroken = false;
  let seqNo = 0;
  const pendingAcks = new Map<number, (ok: boolean) => void>();

  /** 主线程同步写（只在写线程不可用/超时时兜底） */
  function writeFallbackSync(snap: Record<string, string>): boolean {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const text = JSON.stringify(snap);
      if (keepBackup) {
        try {
          copyFileSync(filePath, filePath + '.bak');
        } catch {
          /* 首次无旧文件 */
        }
      }
      const tmp = filePath + '.tmp-m';
      writeFileSync(tmp, text, 'utf-8');
      renameSync(tmp, filePath);
      stats.lastFlushMs = 0; // 同步路径没有单独计时（调用方场景极少）
      stats.lastBytes = Buffer.byteLength(text);
      stats.lastFlushAt = Date.now();
      return true;
    } catch {
      stats.errors += 1;
      return false;
    }
  }

  /** 主线程异步写（写线程不可用时的回落，仍不阻塞事件循环） */
  async function writeFallbackAsync(snap: Record<string, string>): Promise<boolean> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      const text = JSON.stringify(snap);
      if (keepBackup) {
        try {
          await copyFile(filePath, filePath + '.bak');
        } catch {
          /* 首次无旧文件 */
        }
      }
      const tmp = filePath + '.tmp-m';
      await writeFile(tmp, text, 'utf-8');
      await rename(tmp, filePath);
      stats.lastBytes = Buffer.byteLength(text);
      stats.lastFlushAt = Date.now();
      return true;
    } catch {
      stats.errors += 1;
      return false;
    }
  }

  function ensureWorker(): boolean {
    if (worker) return true;
    if (workerBroken) return false;
    try {
      const w = new Worker(WRITER_WORKER_SRC, { eval: true });
      // 写线程不持有进程生命周期（否则一次延后写会让服务无法退出）
      w.unref();
      w.on('message', (m: { seq: number; ok: boolean; ms?: number; bytes?: number }) => {
        const resolve = pendingAcks.get(m.seq);
        if (!resolve) return; // flushSync 的快照不走这张表
        pendingAcks.delete(m.seq);
        if (m.ok) {
          stats.flushed += 1;
          stats.lastFlushMs = Math.round(m.ms ?? 0);
          stats.lastBytes = m.bytes ?? 0;
          stats.lastFlushAt = Date.now();
        } else {
          stats.errors += 1;
        }
        resolve(!!m.ok);
      });
      w.on('error', (e) => {
        // 写线程异常 ⇒ 标坏，后续改写主线程异步回落（数据不能因此丢掉）
        stats.errors += 1;
        workerBroken = true;
        if (worker === w) worker = null;
        stats.writer = 'broken';
        for (const resolve of pendingAcks.values()) resolve(false);
        pendingAcks.clear();
        console.warn(`[kv] 写线程异常，已回落主线程异步写：${e instanceof Error ? e.message : String(e)}`);
      });
      w.on('exit', (code) => {
        if (worker !== w) return; // close() 主动停掉的不算异常
        if (code !== 0) {
          stats.errors += 1;
          workerBroken = true;
          worker = null;
          stats.writer = 'broken';
          for (const resolve of pendingAcks.values()) resolve(false);
          pendingAcks.clear();
          console.warn(`[kv] 写线程退出（code=${code}），已回落主线程异步写`);
        }
      });
      worker = w;
      stats.writer = 'on';
      return true;
    } catch (e) {
      workerBroken = true;
      stats.writer = 'broken';
      stats.errors += 1;
      console.warn(`[kv] 写线程启动失败，已回落主线程异步写：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async function writeSnapshot(snap: Record<string, string>): Promise<boolean> {
    if (ensureWorker() && worker) {
      const w = worker;
      const seq = ++seqNo;
      const p = new Promise<boolean>((resolve) => pendingAcks.set(seq, resolve));
      try {
        w.postMessage({ obj: snap, file: filePath, seq, bak: keepBackup });
        if (await p) return true;
      } catch {
        pendingAcks.delete(seq);
      }
      // 写线程报错（磁盘满/EACCES 等）⇒ 主线程异步再兜底一次，仍失败才把 dirty 立回去重试
    }
    return writeFallbackAsync(snap);
  }

  function schedule(): void {
    if (closing) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void runFlush();
    }, debounceMs);
  }

  function markDirty(): void {
    stats.writes += 1;
    // 已有一次「在飞 / 已排队」的快照 ⇒ 这次写会被合并（不额外产生一次落盘）
    if (timer || inFlight) stats.coalesced += 1;
    dirty = true;
    stats.pending = 1;
    schedule();
  }

  function runFlush(): Promise<void> {
    if (inFlight) return inFlight;
    if (!dirty) return Promise.resolve();
    dirty = false;
    stats.pending = 0;
    // `#771`：整文件快照 `Object.fromEntries` + `postMessage` 的**结构化克隆**都在主线程同步做
    // （kv.json 实测 6MB/2197 键）⇒ 单独打点，避免把它的停顿记到目录头上
    probeEnter('kv:snap');
    let snap: Record<string, string>;
    try {
      snap = Object.fromEntries(map);
    } finally {
      probeLeave();
    }
    stats.queued += 1;
    stats.inFlight = 1;
    inFlight = (async () => {
      try {
        const ok = await writeSnapshot(snap);
        if (!ok) {
          // 落盘失败 ⇒ 把「未落盘」标记立回去（最多连续重试 5 次，避免磁盘故障时空转）
          failStreak += 1;
          dirty = true;
          stats.pending = 1;
        } else {
          failStreak = 0;
        }
      } finally {
        inFlight = null;
        stats.inFlight = 0;
        if (dirty && !closing && failStreak <= 5) schedule();
      }
    })();
    return inFlight;
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // 有界：落盘持续失败时 dirty 会被立回，不能让这里无限等（最多尝试 5 次）
    let attempts = 0;
    while ((inFlight || dirty) && attempts < 5) {
      attempts += 1;
      if (inFlight) await inFlight;
      else await runFlush();
    }
  }

  /**
   * 同步落盘（进程退出/桌面关闭专用）。
   *
   * 顺序保证：写线程按 FIFO 处理消息 ⇒ 把「当前快照」排在队尾并等它 ack，
   * 前面任何在飞的旧快照都一定先落盘，最终文件就是此刻的内存态。
   */
  function flushSync(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty && !inFlight) return;
    dirty = false;
    stats.pending = 0;
    const snap = Object.fromEntries(map);
    stats.queued += 1;
    if (ensureWorker() && worker) {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const seq = ++seqNo;
      try {
        worker.postMessage({ obj: snap, file: filePath, seq, bak: keepBackup, signal });
        Atomics.wait(signal, 0, 0, syncWriteTimeoutMs);
        const code = Atomics.load(signal, 0);
        if (code === 1) {
          stats.flushed += 1;
          stats.lastFlushAt = Date.now();
          return;
        }
        stats.errors += 1;
        console.warn('[kv] 退出同步落盘等待超时/失败，回落主线程同步写');
      } catch (e) {
        stats.errors += 1;
        console.warn(`[kv] 退出同步落盘投递失败，回落主线程同步写：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    writeFallbackSync(snap);
  }

  function close(): void {
    closing = true;
    try {
      flushSync();
    } catch {
      /* 退出路径失败不能反过来阻断退出 */
    }
    const w = worker;
    worker = null;
    if (w) {
      try {
        void w.terminate();
      } catch {
        /* ignore */
      }
    }
    stats.writer = 'off';
  }

  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
      markDirty();
    },
    delete: async (k) => {
      map.delete(k);
      markDirty();
    },
    stats: () => ({ ...stats }),
    flush,
    flushSync,
    close,
  };
}
