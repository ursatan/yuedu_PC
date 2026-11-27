/**
 * `#476` **TTY 日志卸载** —— 修掉「边听歌/边看视频/边刷发现页时服务整卡 5 秒、甚至几十秒」。
 *
 * ## 真因（stall-report.log 取证后定性）
 * 服务通过 `start-server.bat` 跑在**可见的 cmd 窗口**里，stdout/stderr 是 TTY。
 * Node 往 Windows 控制台写字符是**同步系统调用**（libuv tty 句柄在主线程做阻塞 write）：
 *
 *  1. **日志刷屏**：高负载时每 2s 一批 `[stall] slow` + `[net-guard]` + `[run] 失败` + PoW 行，
 *     conhost 逐行渲染，每次写都占住事件循环，叠加出 5s 级真停摆；
 *  2. **QuickEdit 标记模式**：用户在 cmd 窗口里**点一下 / 拖选文字**，控制台会**暂停输出方**，
 *     write() 卡到用户按 ESC/回车为止 —— 报告里 recover 26s / 35s / **71s** 就是这么来的。
 *
 * 判据闭环：stall 发生时 `inflight` 经常为空、block-stats 四类埋点（l1-eval / worker-spawn /
 * gk-pow / data-persist）全对不上、基线高负载（日志更多）时冻结放大到分钟级 —— 只能是
 * 「事件循环外的同步写」。
 *
 * ## 做法
 * 把**写控制台**这件事整个挪到专用 worker 线程：主线程只做 `postMessage`（异步、拷贝），
 * worker 卡住（conhost 忙 / QuickEdit 暂停）只阻塞它自己，**主线程心跳不受影响**。
 * 同时全量日志异步追加到 `DATA_DIR/server.log`（QuickEdit 暂停期间也不丢、可事后取证）。
 * 背压：worker 待写字节超 2MB ⇒ 控制台侧丢弃并每秒汇总一行；**文件侧不丢**。
 *
 * ## ★ 踩坑实证：worker 里**只能裸 `fs.writeSync(fd)`，不能 `process.stdout.write`**
 * worker_threads 里 `process.stdout.write` 会**折返父线程**，最终又调用父进程被 shim 过的
 * `process.stdout.write` ⇒ `postMessage → worker 写 → 父 shim → postMessage …` 异步无限回环
 * （实测真 TTY：一行日志 4 秒自我复制成 172KB；服务启动块 90 秒灌爆磁盘 100MB+）。
 * worker 继承的是真实控制台 fd，`fs.writeSync(1/2, chunk)` 直接走系统调用、不经任何 Node 流包装，
 * 实测文件恰好一行、回环消失（`.tmp-472/sink-repro*.mjs` 是隔离判据脚本）。
 *
 * ## 边界
 * · stdout/stderr 不是 TTY（electron 内嵌 / 管道 / 重定向到文件）⇒ **零行为变化**（管道写本就异步）；
 * · `YUEDU_LOG_SINK=0` 关闭（故障复现开关）；
 * · `stall-watch` 那个看门狗 worker 自己直写 stderr（本就在别的线程），不经这里，不受影响。
 */
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';

/** 控制台背压上限：worker 待写超过这个字节数就丢控制台、保文件（避免无限攒内存） */
const SINK_CAP_BYTES = 2 * 1024 * 1024;
/** 单个日志文件写到这么大就切下一个（不 rename —— Windows 上 rename 打开中的文件 EBUSY） */
const LOG_FILE_SWITCH_BYTES = 20 * 1024 * 1024;

/**
 * 纯判据（单测直接打这里）：哪些情况下要装卸载层。
 * 非 TTY（管道/文件/electron）不需要 —— libuv 对它们的写天然不阻塞事件循环。
 */
export function shouldInstallLogSink(env: Record<string, string | undefined>, stdoutTty: boolean, stderrTty: boolean): boolean {
  if (env['YUEDU_LOG_SINK'] === '0') return false;
  return stdoutTty || stderrTty;
}

/**
 * 卸载层 worker 源码。
 * ⚠️ 跑在 `eval: true` 的 Worker 里：注释禁用反引号；它的控制台写可以随便卡
 *    （QuickEdit 暂停只冻住本线程，主线程照跑）。
 */
const SINK_WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
parentPort.on('message', function (msg) {
  if (!msg || typeof msg.chunk !== 'string') return;
  // ★ 必须裸 writeSync：process.stdout/stderr.write 在 worker 里会折返父线程 shim 形成回环（见文件头注释）
  try { fs.writeSync(msg.err ? 2 : 1, msg.chunk); } catch (e) { /* 控制台句柄异常不影响任何业务 */ }
  try { parentPort.postMessage({ bytes: msg.bytes || 0 }); } catch (e) { /* 退出中 */ }
});
parentPort.postMessage({ ready: true });
`;

export interface LogSink {
  /** 测试/关停用：返回当前待写字节与累计丢弃字节 */
  stats(): { pending: number; dropped: number; fileBytes: number };
  /**
   * 卸载（主要给测试退进程用）：还原 stdout/stderr.write、停 worker、关文件流。
   * 生产进程长生命周期不会调它；不调也不泄漏（worker/interval 均已 unref，
   * 只有文件流会保活事件循环 —— 这也是测试必须显式 dispose 的原因）。
   */
  dispose(): Promise<void>;
}

/**
 * 安装日志卸载层（幂等：本进程只装一次）。
 * 必须在**大量日志开始之前**调用（服务入口处）；晚装只能覆盖装之后的写。
 */
export function installOffloadedLogSink(opts: { file: string; env?: NodeJS.ProcessEnv }): LogSink | null {
  const env = opts.env ?? process.env;
  if (installed) return sink;
  if (!shouldInstallLogSink(env, !!process.stdout.isTTY, !!process.stderr.isTTY)) return null;
  installed = true;

  let fileStream = openLogStream(opts.file);
  /** 所有打开过的文件流（含切换后的）—— dispose 时统一关，否则 WriteStream 保活事件循环 */
  const streams: fs.WriteStream[] = [];
  if (fileStream) streams.push(fileStream);
  let fileBytes = 0;
  /** 已切到第几号文件（server.log → server-1.log → server-2.log …，无界轮转，不 rename 打开中的文件） */
  let rotateIndex = 0;

  const worker = new Worker(SINK_WORKER_SRC, { eval: true });
  worker.unref();
  worker.on('error', () => { /* worker 崩了也绝不影响业务；最坏退回「日志少了」 */ });

  let pending = 0;
  let dropped = 0;
  worker.on('message', (m: { bytes?: number }) => {
    if (typeof m.bytes === 'number') pending = Math.max(0, pending - m.bytes);
  });

  /** 发一条日志块到文件 + 控制台 worker；背压时只丢控制台、不丢文件 */
  function push(chunk: unknown, isErr: boolean): void {
    // 防线：`String(uint8Array)` 会得到逗号数字串 ⇒ Uint8Array 必须先 Buffer.from 再解码（当前代码库无此调用）
    const s = typeof chunk === 'string' ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString('utf8')
      : chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8')
      : String(chunk ?? '');
    if (!s) return;
    const bytes = Buffer.byteLength(s, 'utf8');
    // 文件侧（异步，QuickEdit 也卡不到它）
    try {
      if (fileStream) {
        fileStream.write(s);
        fileBytes += bytes;
        if (fileBytes > LOG_FILE_SWITCH_BYTES) {
          // 切新文件（不 rename 打开中的旧文件，避开 Windows EBUSY）
          rotateIndex += 1;
          try { fileStream.end(); } catch { /* ignore */ }
          const dot = opts.file.lastIndexOf('.');
          const next = dot > 0
            ? `${opts.file.slice(0, dot)}-${rotateIndex}${opts.file.slice(dot)}`
            : `${opts.file}-${rotateIndex}`;
          fileStream = openLogStream(next);
          if (fileStream) streams.push(fileStream);
          fileBytes = 0;
        }
      }
    } catch { /* 文件写失败不能拖垮业务 */ }
    // 控制台侧（worker 线程；背压满了就丢，每秒汇总）
    if (pending > SINK_CAP_BYTES) {
      dropped += bytes;
      return;
    }
    pending += bytes;
    worker.postMessage({ chunk: s, err: isErr, bytes });
  }

  // 每秒把丢弃量汇总成一行（文件里留痕；控制台只在背压回落时能看到）
  const reporter = setInterval(() => {
    if (dropped <= 0) return;
    const n = dropped;
    dropped = 0;
    const msg = `[log-sink] 控制台背压：丢弃 ${n} 字节屏幕输出（完整日志见 ${opts.file}；cmd 窗口请勿拖选/点中）\n`;
    try { fileStream?.write(msg); } catch { /* ignore */ }
  }, 1000);
  reporter.unref?.();

  /**
   * 替换流的 write。签名兼容三种调用：write(chunk, cb) / write(chunk, enc, cb) / write(chunk)。
   * 回调一律异步成功（语义≈「已收下」），返回 true（背压由我们自己的 2MB 闸门管）。
   */
  function wrap(stream: NodeJS.WriteStream, isErr: boolean): void {
    const patched = function (this: unknown, chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
      try {
        push(chunk, isErr);
      } catch {
        /* 卸载层自身异常绝不能吃掉业务输出 —— 但此时直接写 TTY 又可能阻塞；
           无 TTY 可用时静默（文件侧 push 内部已独立 try 过）。 */
      }
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') {
        queueMicrotask(() => (callback as (err?: Error | null) => void)(null));
      }
      return true;
    };
    stream.write = patched as typeof stream.write;
  }

  const origOutWrite = process.stdout.write;
  const origErrWrite = process.stderr.write;
  wrap(process.stdout, false);
  wrap(process.stderr, true);

  sink = {
    stats: () => ({ pending, dropped, fileBytes }),
    async dispose(): Promise<void> {
      // 先还原 write（避免关流过程中还有日志写进来）
      if (process.stdout.write !== origOutWrite) process.stdout.write = origOutWrite;
      if (process.stderr.write !== origErrWrite) process.stderr.write = origErrWrite;
      clearInterval(reporter);
      try { await worker.terminate(); } catch { /* 退出中 */ }
      await Promise.all(streams.map((st) => new Promise<void>((resolve) => {
        try { st.end(() => resolve()); } catch { resolve(); }
      })));
    },
  };
  return sink;
}

function openLogStream(file: string): fs.WriteStream | null {
  try {
    const st = fs.createWriteStream(file, { flags: 'a' });
    st.on('error', () => { /* 背压/磁盘满：不打断业务 */ });
    return st;
  } catch {
    return null;
  }
}

let installed = false;
let sink: LogSink | null = null;
