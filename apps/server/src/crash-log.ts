/**
 * `#210` **崩溃日志**——「进程没死但出了大错」也要留痕。
 *
 * ## 为什么必须有
 * 此前 `uncaughtException` / `unhandledRejection` 只 `console.error`：
 * ① `start-server.bat` 的窗口一关，证据就没了；② 桌面端（Electron 托管）根本**没有**控制台；
 * ③ 用户报障时只会说「用着用着不对了」，没有当时的错误文本就只能靠猜。
 *
 * ## 两份产物
 * - **内存 ring**（最近 50 条）：给界面「运维」分区直接展示，不读文件、零延迟。
 * - **月度文件** `data/logs/crash-YYYY-MM.log`（追加写）：给事后归因（跨重启还在）。
 *   按月分文件 ⇒ 单文件天然有界，不需要轮换逻辑。
 *
 * ## 设计约束
 * - **绝不能抛**：崩溃处理器里再抛异常 = 二次崩溃。所有 IO 都套 try。
 * - **不能用防抖队列**：进程崩了就没了，必须同步追加写（`appendFileSync`）。
 *   单条错误几 KB、崩溃本身是低频事件，同步写的代价可忽略。
 * - **`uncaughtException` 不退出**：保留现有行为（`index.ts` 原本就不退出）——
 *   Fastify 服务的偶发空指针退出反而更伤（用户正在看书）。退不退是 `start-server.bat`
 *   循环 + 看门狗的事，这里只管记。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 单条崩溃记录 */
export interface CrashEntry {
  /** ISO 时间 */
  at: string;
  /** 来源：未捕获异常 / 未处理的 Promise 拒绝 / 业务主动记录（如书架更新连续失败） */
  kind: 'uncaughtException' | 'unhandledRejection' | 'record';
  /** 单行消息（多行压成一行，方便表格展示） */
  message: string;
  /** 堆栈前 4 行（首行是 message 本身，跳过） */
  stack?: string;
}

const RING_MAX = 50;
const ring: CrashEntry[] = [];

/** 月度日志文件名（crash-2026-10.log） */
function monthFile(dir: string): string {
  const d = new Date();
  return path.join(dir, `crash-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.log`);
}

/** 多行压一行 + 控制长度（消息本体可能带整段 HTML/规则文本，截断到 600 字符） */
function oneLine(s: string, max = 600): string {
  return s.replace(/\s*\r?\n\s*/g, ' ⏎ ').slice(0, max);
}

/** 记录一条错误（ring + 文件）。**任何情况都不抛**。 */
export function recordCrash(kind: CrashEntry['kind'], err: unknown, logDir?: string): CrashEntry {
  const e = err as { message?: unknown; stack?: unknown };
  // ★ 逐层防御：JSON.stringify(undefined) 返回 undefined（不是字符串！）
  //   ⇒ 崩溃处理器里再抛 = 二次崩溃，这里宁可多写一层 String()
  let msg: string;
  try {
    msg = e instanceof Error ? String(e.message) : typeof e === 'string' ? e : String(JSON.stringify(e) ?? String(e));
  } catch {
    msg = String(e); // 循环引用 stringify 会抛 ⇒ 退回 String 形式
  }
  const stackLines =
    typeof e?.stack === 'string' ? (e.stack as string).split('\n').slice(1, 5).map((l) => l.trim()) : [];
  const entry: CrashEntry = {
    at: new Date().toISOString(),
    kind,
    message: oneLine(msg),
    ...(stackLines.length ? { stack: stackLines.join('\n') } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  if (logDir) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const line = `${entry.at} [${entry.kind}] ${entry.message}${entry.stack ? `\n  ${entry.stack.split('\n').join('\n  ')}` : ''}\n`;
      fs.appendFileSync(monthFile(logDir), line);
    } catch {
      /* 磁盘满 / 权限：连日志都写不进去时，保命要紧，什么都不做 */
    }
  }
  return entry;
}

/** 最近 N 条（给 /api/system/errors） */
export function recentCrashes(limit = 20): CrashEntry[] {
  return ring.slice(-Math.max(1, Math.min(limit, RING_MAX)));
}

/** 列出崩溃日志文件（给界面「打开日志目录」/下载） */
export function listCrashLogs(dir: string): { name: string; sizeKB: number; mtime: string }[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('crash-') && f.endsWith('.log'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, sizeKB: Math.max(1, Math.round(st.size / 1024)), mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch {
    return [];
  }
}
