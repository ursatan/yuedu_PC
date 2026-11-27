/**
 * 统一错误
 *
 * Legado 的做法：所有面向用户的错误都是 NoStackTraceException，
 * 消息是中文、直接显示给用户、不打堆栈。
 * 我们同样不让堆栈泄漏到界面上，但保留 trace 供调试面板查看。
 */

import type { PipelineStage } from './types';
import type { TraceEntry } from '../trace';

export type EngineErrorCode =
  | 'SOURCE_INVALID' // 源配置不合法
  | 'RULE_PARSE' // 规则解析失败
  | 'NETWORK' // 请求失败
  | 'SELECTOR_MISS' // 选择器未命中
  | 'JS_ERROR' // 脚本抛错
  | 'JS_TIMEOUT' // 脚本超时
  | 'DECODE' // 解密 / 解码失败
  | 'ANTI_BOT' // 反爬 / 人机验证页（HTML 而非 JSON）
  | 'UNSUPPORTED_ACTION' // 引擎不支持该 action
  | 'SOURCE_NOT_FOUND' // 源不在注册表
  | 'SOURCE_DISABLED' // 源被禁用（总开关 / 搜索 / 发现）
  | 'CANCELLED'; // 用户中断

/** 哪些错误值得重试 */
const RETRYABLE: ReadonlySet<EngineErrorCode> = new Set<EngineErrorCode>([
  'NETWORK',
  'JS_TIMEOUT',
]);

export interface EngineErrorDetail {
  engine: string;
  sourceId: string;
  /** 出错的规则原文，直接展示给用户 */
  rule?: string;
  input?: unknown;
  /**
   * 内层异常的类型 + 栈（已剔除引擎自身的包装帧）。
   *
   * 为什么必须有：`EngineError` 只保留 code/stage，内层异常的**栈与出错行**全丢，
   * 导致 `RULE_PARSE@parse` 这类报错只能看到一句 message（实测归因 #103 时，
   * 「可乐小说 nodeName」在服务端返回里连一个有效帧都没有）。**只在失败路径填充**。
   */
  cause?: string;
  /** 最后 N 条执行轨迹 */
  trace: TraceEntry[];
  retryable: boolean;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly stage: PipelineStage;
  readonly detail: EngineErrorDetail;

  constructor(code: EngineErrorCode, stage: PipelineStage, detail: Omit<EngineErrorDetail, 'retryable'> & { retryable?: boolean }) {
    super(`${code}@${stage}${detail.rule ? `: ${detail.rule}` : ''}`);
    this.name = 'EngineError';
    this.code = code;
    this.stage = stage;
    this.detail = {
      ...detail,
      retryable: detail.retryable ?? RETRYABLE.has(code),
    };
  }

  /** 给 HTTP 接口用的序列化形式 */
  toJSON(): { code: string; stage: string; message: string; detail: EngineErrorDetail } {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      detail: this.detail,
    };
  }
}

/** 判断任意异常是不是 EngineError */
export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}

/** 把任意异常包装成 EngineError（保留原始 trace） */
export function wrapError(
  e: unknown,
  code: EngineErrorCode,
  stage: PipelineStage,
  base: Omit<EngineErrorDetail, 'trace' | 'retryable'>,
  trace: TraceEntry[],
): EngineError {
  if (isEngineError(e)) return e;
  return new EngineError(code, stage, {
    ...base,
    input: e instanceof Error ? e.message : String(e),
    trace,
  });
}
