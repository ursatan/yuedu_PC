/**
 * `#746` B1 / `#753` B2：**批处理子进程的宿主侧管理器**。
 *
 * 目标：把「源体检 / 批量校验 / 登录求值」这类后台重活从主进程搬走 —— 它们会跑源 JS、
 * 同步 HTTP，一旦并发起来就会把主线程按死（`stall` + `dom-select` + `sync-http` 全从这条路径来）。
 *
 * 护栏（B1）：
 *  1. **故障隔离**：子进程崩了只是本任务失败 —— 主进程进程照跑，下一次任务**自动重启**子进程；
 *  2. **单次任务超时**：`YUEDU_BATCH_TIMEOUT_MS`（默认 300s）到点 `SIGKILL`，显式拒绝并留日志；
 *  3. **并发在子进程内自控**：主进程侧**串行排队**（批处理本来就是后台，再叠并发只会打凶出口）；
 *     子进程内的并发由 `YUEDU_BATCH_CONCURRENCY`（缺省自适应 CPU/内存）约束；
 *  4. **单写者**：子进程只读 `data/yuedu.db` / `data/kv.json`；它要写的键值通过 `kv-write`、
 *     Cookie 通过 `cookie-write` 交回本模块 → 由主进程的存储执行（子进程自己不落盘）。
 *
 * B2 新增（`YUEDU_B2_PROCESS=1`，默认关）：
 *  · **版本号**：`notifySourcesChanged()` 递增 `version` 并推 `reload`；结果里带回的版本
 *    与当前不一致 ⇒ **直接丢弃**（拒绝在飞任务，调用方回落主进程重算，不会把旧结果写回新状态）；
 *  · **登录** job（`kind:'login'`）；
 *  · **状态上报**：子进程每次任务后回 `status`（并发档位 / RSS / 堆 / worker 内存上限）。
 *
 * 入口解析（与 `dom-backend.ts` 同一套思路）：
 *  1. `YUEDU_BATCH_CHILD_FILE`（测试/探针显式指定）；
 *  2. 同目录 `batch-child.mjs`（桌面 bundle：`apps/desktop/build-server.mjs` 产出）；
 *  3. 同目录 `batch-child.ts`（开发/测试：`fork` 带 `--import tsx`）。
 *
 * 关闭开关：`YUEDU_BATCH_PROCESS=0` ⇒ 调用方走旧的「同进程批处理」，本模块不启动任何子进程。
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BatchChildMessage,
  BatchJobKind,
  BatchJobMessage,
  BatchLoginPayload,
  BatchVerifyPayload,
} from './batch-protocol';

export interface BatchRunnerOptions {
  /** 显式入口（测试用）；不传按上面的三档解析 */
  entry?: string;
  /** 子进程环境（默认继承当前进程；调用方补 `YUEDU_DATA_DIR` 等） */
  env?: Record<string, string | undefined>;
  /** 单次任务超时（ms），默认 `YUEDU_BATCH_TIMEOUT_MS` / 300s */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** 子进程写回的键值（`value === null` = 删除） */
  onKvWrite?: (key: string, value: string | null) => void;
  /** 子进程写回的整源 Cookie（`null` = 清空）——B2 登录路径 */
  onCookieWrite?: (sourceId: string, cookies: Record<string, string> | null) => void;
}

export interface BatchRunnerStatus {
  enabled: boolean;
  entry: string | null;
  pid: number | null;
  running: boolean;
  /** 已开始的子进程数（含重启） */
  spawns: number;
  /** 已结束的任务数（含失败） */
  jobs: number;
  /** 超时被杀次数 */
  timeouts: number;
  /** 异常退出次数（崩溃/OOM/被杀） */
  exits: number;
  /** 因版本不匹配被丢弃的结果数（B2） */
  stale: number;
  /**
   * 子进程发起的 Cookie 写回次数（B2，`#765` 实测补的观测字段）。
   * 计数点在 `cookie-write` 消息到达时 —— 只有子进程**判定 Cookie 有变化**才发，
   * 所以两次登录之间该值不变 = 「无变化不发」。
   */
  cookieWrites: number;
  /** 当前源库版本号（B2） */
  version: number;
  /** 子进程最近一次上报的并发档位（0 = 还没上报） */
  concurrency: number;
  /** 子进程最近一次上报的 RSS（MB） */
  rssMb: number;
  lastMs: number;
  lastError: string | null;
}

interface Pending {
  id: string;
  kind: BatchJobKind;
  /** 发起该任务的子进程 —— 旧进程的 `exit` 不得拒绝新进程上的任务 */
  child: ChildProcess;
  /** 派发时的源库版本（结果必须一致） */
  version: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function batchProcessEnabled(): boolean {
  return process.env['YUEDU_BATCH_PROCESS'] !== '0';
}

/**
 * B2 总开关：**默认关**。关着时所有调用点行为与 `#746` 之后逐字一致
 * （登录仍在主进程、巡检仍回传 raw、子进程并发仍按 `YUEDU_BATCH_CONCURRENCY`）。
 */
export function b2ProcessEnabled(): boolean {
  return process.env['YUEDU_B2_PROCESS'] === '1';
}

function selfDir(): string {
  const u = import.meta.url;
  if (u.startsWith('file:')) return path.dirname(fileURLToPath(u));
  return path.dirname(u);
}

function resolveEntry(forced?: string): string | null {
  if (forced && fs.existsSync(forced)) return forced;
  const env = process.env['YUEDU_BATCH_CHILD_FILE'];
  if (env && fs.existsSync(env)) return env;
  const dir = selfDir();
  for (const name of ['batch-child.mjs', 'batch-child.cjs', 'batch-child.ts']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function createBatchRunner(opts: BatchRunnerOptions = {}) {
  const log = opts.log ?? ((m: string) => console.error(m));
  const timeoutMs = Math.max(
    5_000,
    (opts.timeoutMs ?? Number(process.env['YUEDU_BATCH_TIMEOUT_MS'] ?? '')) || 300_000,
  );
  const entry = resolveEntry(opts.entry);
  const stats = {
    spawns: 0,
    jobs: 0,
    timeouts: 0,
    exits: 0,
    stale: 0,
    cookieWrites: 0,
    concurrency: 0,
    rssMb: 0,
    lastMs: 0,
    lastError: null as string | null,
  };

  let child: ChildProcess | null = null;
  /** 主动停止（`stop()`）期间不把退出算成崩溃 */
  let stopping = false;
  let pending: Pending | null = null;
  let seq = 1;
  /**
   * 源库版本号（B2）。从 1 开始，每次 `notifySourcesChanged()` 递增。
   * 初始任务都带当前版本；子进程回带的版本不一致 ⇒ 结果丢弃。
   */
  let version = 1;
  /** 主进程侧串行队列（批处理是后台任务，不叠并发） */
  let chain: Promise<unknown> = Promise.resolve();

  function killChild(reason: string): void {
    const c = child;
    child = null;
    if (!c) return;
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已退出 */
    }
    log(`[batch] 已终止子进程（${reason}）pid=${c.pid ?? '-'}`);
  }

  function failPending(err: Error): void {
    const p = pending;
    pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    p.reject(err);
  }

  function ensureChild(): ChildProcess {
    if (child) return child;
    if (!entry) throw new Error('批处理子进程入口未找到（batch-child.mjs / batch-child.ts）');
    const isTs = entry.endsWith('.ts');
    const c = fork(entry, [], {
      cwd: path.dirname(entry),
      env: { ...process.env, ...(opts.env ?? {}) },
      // `batch-child.ts` 在开发/测试下由 tsx 装载；bundle 形态不需要
      ...(isTs ? { execArgv: ['--import', 'tsx'] } : {}),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    c.stdout?.setEncoding('utf8');
    c.stderr?.setEncoding('utf8');
    c.stdout?.on('data', (s: string) => {
      for (const line of String(s).split('\n')) if (line.trim()) log(`[batch] ${line.trim()}`);
    });
    c.stderr?.on('data', (s: string) => {
      for (const line of String(s).split('\n')) if (line.trim()) log(`[batch] ${line.trim()}`);
    });
    c.on('message', (m: BatchChildMessage) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'result') {
        const p = pending;
        if (!p || p.id !== m.id) return;
        /**
         * **B2 版本闸**：结果必须对应派发时的源库版本。
         *  · `m.version` 是 number 且不匹配 ⇒ 丢弃（旧子进程用旧快照算出来的结果不能写回新状态）；
         *  · `m.version` 缺失（旧子进程 / 探针）⇒ 按 B1 行为接受（向后兼容，不改变回落语义）。
         */
        if (typeof m.version === 'number' && m.version !== p.version) {
          pending = null;
          clearTimeout(p.timer);
          stats.stale += 1;
          stats.lastError = `结果版本不一致（任务 ${p.version} / 当前 ${version}）`;
          log(`[batch] 丢弃陈旧结果 id=${m.id} · 任务版本 ${p.version} · 当前版本 ${version} · kind=${m.id}`);
          p.reject(new Error(`批处理结果已过期（任务版本 ${p.version} ≠ 当前版本 ${version}）`));
          return;
        }
        pending = null;
        clearTimeout(p.timer);
        stats.lastMs = m.ms ?? 0;
        stats.jobs += 1;
        log(
          `[batch] 任务完成 kind=${p.kind} · ${m.ms ?? 0}ms · 版本 ${p.version}` +
            (m.ok ? '' : ` · 失败：${m.error ?? ''}`),
        );
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? 'batch job failed'));
        return;
      }
      if (m.t === 'kv-write') {
        // 单写者：子进程只发起，真正落盘由主进程做
        try {
          opts.onKvWrite?.(m.key, m.value);
        } catch (e) {
          log(`[batch] 写回失败 ${m.key}：${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      if (m.t === 'cookie-write') {
        stats.cookieWrites += 1;
        // 只打键数与源 id（**不打值**）：Cookie 等同密码，日志会被复制到 issue/群聊
        const keys = m.cookies ? Object.keys(m.cookies).length : 0;
        log(`[batch] Cookie 写回 sourceId=${m.sourceId} · keys=${keys}${m.cookies ? '' : ' · 清空'}`);
        try {
          opts.onCookieWrite?.(m.sourceId, m.cookies);
        } catch (e) {
          log(`[batch] Cookie 写回失败 ${m.sourceId}：${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      if (m.t === 'status') {
        stats.concurrency = m.concurrency;
        stats.rssMb = m.rssMb;
        log(
          `[batch] 子进程状态：并发 ${m.concurrency} · RSS ${m.rssMb}MB · 堆 ${m.heapMb}MB` +
            ` · worker 上限 ${m.workerMemMb ? `${m.workerMemMb}MB` : '未设'}`,
        );
        return;
      }
      if (m.t === 'log') log(`[batch] ${m.msg}`);
    });
    c.on('error', (e) => {
      if (stopping) return;
      stats.exits += 1;
      stats.lastError = String(e?.message ?? e);
      if (child === c) child = null;
      log(`[batch] 子进程错误：${stats.lastError}（下次任务时重启）`);
      if (pending?.child === c) failPending(new Error(`批处理子进程错误：${stats.lastError}`));
    });
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      if (stopping) return;
      stats.exits += 1;
      const detail = `code=${code ?? '-'} signal=${signal ?? '-'}`;
      stats.lastError = `子进程退出（${detail}）`;
      log(`[batch] 子进程异常退出（${detail}），下次任务时重启`);
      if (pending?.child === c) failPending(new Error(`批处理子进程退出（${detail}）`));
    });
    child = c;
    stats.spawns += 1;
    log(`[batch] 子进程已启动 pid=${c.pid ?? '-'} entry=${path.basename(entry)} version=${version}`);
    return c;
  }

  async function runOnce(kind: BatchJobKind, payload: unknown, jobTimeout = timeoutMs): Promise<unknown> {
    const c = ensureChild();
    const id = `b${seq++}`;
    const jobVersion = version;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        stats.timeouts += 1;
        stats.jobs += 1;
        stats.lastError = `任务超时（${jobTimeout}ms）`;
        failPending(new Error(`批处理任务超时（${jobTimeout}ms）`));
        log(`[batch] 任务超时 ${jobTimeout}ms · kind=${kind} · 终止子进程并将在下次任务时重启`);
        killChild('任务超时');
      }, jobTimeout);
      pending = { id, kind, child: c, version: jobVersion, resolve, reject, timer };
      const msg: BatchJobMessage = { t: 'job', id, kind, payload, timeoutMs: jobTimeout, version: jobVersion };
      try {
        c.send(msg);
      } catch (e) {
        failPending(new Error(`派发失败：${e instanceof Error ? e.message : String(e)}`));
        killChild('派发失败');
      }
    });
  }

  /**
   * B2：源库变更后的失效钩子。
   *  · 有子进程 ⇒ 推 `reload`（子进程在飞任务结束后丢 hub 快照，下次任务重建）；
   *  · 没有子进程 ⇒ 只需把版本号递增，下次 `fork` 的第一次任务自然带新版本。
   * 在飞任务不会被中途打断；它的结果版本已旧 ⇒ 到主进程会被 `stale` 闸丢弃。
   */
  function notifySourcesChanged(reason = '源变更'): number {
    version += 1;
    const c = child;
    if (c) {
      try {
        c.send({ t: 'reload', version, reason });
        log(`[batch] 已通知子进程重载源库（version=${version} · ${reason}）`);
      } catch {
        killChild('重载通知失败');
      }
    }
    return version;
  }

  return {
    get entry(): string | null {
      return entry;
    },
    /** 串行执行一个批处理任务（主进程侧排队）；子进程不可用时抛错，调用方决定是否回落 */
    run(kind: BatchJobKind, payload?: unknown, jobTimeout?: number): Promise<unknown> {
      const next = chain.then(() => runOnce(kind, payload, jobTimeout));
      // 队列本身不因单个任务失败而中断
      chain = next.catch(() => undefined);
      return next;
    },
    /** `verify` 的薄封装（让 index.ts 的调用点只关心「跑哪些源」） */
    verify(payload: BatchVerifyPayload, jobTimeout?: number): Promise<unknown> {
      return this.run('verify', payload, jobTimeout);
    },
    /** `login` 的薄封装（B2：只在纯 HTTP 登录脚本时调用） */
    login(payload: BatchLoginPayload, jobTimeout?: number): Promise<unknown> {
      return this.run('login', payload, jobTimeout);
    },
    /** 源库变更钩子（导入/删除/编辑/开关/恢复后调） */
    notifySourcesChanged(reason?: string): number {
      return notifySourcesChanged(reason);
    },
    currentVersion(): number {
      return version;
    },
    status(): BatchRunnerStatus {
      return {
        enabled: batchProcessEnabled(),
        entry,
        pid: child?.pid ?? null,
        running: pending !== null,
        version,
        ...stats,
      };
    },
    /** 优雅停止（服务关停/测试收尾）：拒绝在飞任务并杀掉子进程 */
    async stop(): Promise<void> {
      stopping = true;
      failPending(new Error('批处理子进程已停止'));
      const c = child;
      child = null;
      if (!c) return;
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        c.once('exit', done);
        try {
          c.kill('SIGKILL');
        } catch {
          done();
        }
        // 兜底：2s 内没退出也不阻塞关停
        setTimeout(done, 2000).unref?.();
      });
      stopping = false;
      log('[batch] 子进程已停止');
    },
  };
}

export type BatchRunner = ReturnType<typeof createBatchRunner>;
