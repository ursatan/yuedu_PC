/**
 * 执行轨迹（Trace）—— 错误和调试共用的唯一数据源
 *
 * 设计要点（这是从 Legado Debug.kt 学来的）：
 * Legado 的错误接口只有一个 printLog(state, msg)，调试入口却有 7 个
 * （searchDebug / exploreDebug / infoDebug / ... / rssContentDebug）。
 * 本质上它们是同一件事：把「每一步做了什么」打出来。
 *
 * 所以这里只做一套：每次执行都往 TraceSink 里写条目。
 *   - 正常：静默丢弃（或只留最后 N 条）
 *   - 出错：取最后 N 条塞进 EngineError.detail.trace，就是「错误接口」
 *   - 调试：全量通过 SSE 推给前端，就是「单源调试面板」
 *
 * 一套数据喂两个场景，不写两遍代码。
 */

import type { PipelineStage } from './contract/types';

export interface TraceEntry {
  /** 属于哪个阶段 */
  stage: PipelineStage;
  /**
   * `#696` **一行人类可读的调试文本**（对齐 Legado `Debug.log(msg)`）。
   *
   * 为什么不是复用 `rule/input/output`：上游调试信息流是**给人看**的一句话
   * （`┌获取书名` / `└光阴之外` / `︽详情页解析完成`），带层级符号与时间轴；
   * 而 `rule/input/output` 是**给程序看**的结构化现场（出错时塞进 `EngineError.trace`）。
   * 两者混用会得到「既不好读也不好查」的东西 —— 所以并存：`msg` 走信息流，
   * 其余照旧走错误详情。
   */
  msg?: string;
  /** `msg` 的级别（默认 info）：error ⇒ 信息流里标红并终止该段展示 */
  level?: 'info' | 'warn' | 'error';
  /** 这一步用的规则原文（出错时直接展示给用户，他知道该改哪条） */
  rule?: string;
  /** 输入（截断，避免把整个 HTML 塞进错误信息） */
  input?: unknown;
  /** 输出（截断） */
  output?: unknown;
  /** 耗时毫秒 */
  ms?: number;
  error?: string;
  /** 发生时间 */
  at: number;
}

export interface TraceSink {
  /** 写一条轨迹 */
  push(entry: Omit<TraceEntry, 'at'>): void;

  /** 统计阶段耗时：返回一个函数，调用即结束计时并写入 */
  begin(stage: PipelineStage, rule?: string, input?: unknown): TraceTimer;

  /** 取最后 n 条（出错时组装 EngineError 用） */
  tail(n: number): TraceEntry[];

  /** 取全部（调试面板用） */
  all(): TraceEntry[];

  /** 订阅（调试面板实时推送用） */
  subscribe?(fn: (e: TraceEntry) => void): () => void;
}

export interface TraceTimer {
  /** 结束计时。output 为产出，err 为异常 */
  end(output?: unknown, err?: unknown): void;
}

const MAX_ENTRIES = 500;
const MAX_VALUE_LEN = 2000;

function truncate(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return v.length > MAX_VALUE_LEN ? `${v.slice(0, MAX_VALUE_LEN)}…(截断 ${v.length} 字符)` : v;
}

export function createTraceSink(opts: { onEntry?: (e: TraceEntry) => void } = {}): TraceSink {
  const entries: TraceEntry[] = [];
  const listeners = new Set<(e: TraceEntry) => void>();

  function push(entry: Omit<TraceEntry, 'at'>): void {
    const full: TraceEntry = {
      ...entry,
      input: truncate(entry.input),
      output: truncate(entry.output),
      at: Date.now(),
    };
    entries.push(full);
    if (entries.length > MAX_ENTRIES) entries.shift();
    opts.onEntry?.(full);
    for (const fn of listeners) fn(full);
  }

  return {
    push,

    begin(stage, rule, input) {
      const t0 = performance.now();
      return {
        end(output, err) {
          push({
            stage,
            rule,
            input,
            output,
            ms: Math.round(performance.now() - t0),
            error: err ? String(err instanceof Error ? err.message : err) : undefined,
          });
        },
      };
    },

    tail(n) {
      return entries.slice(-n);
    },

    all() {
      return [...entries];
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
