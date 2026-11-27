/**
 * M3 占位沙箱：L1 选择器 / T1 JSON 都不需要 JS 沙箱。
 * M4 会替换成 worker_threads + vm 的池化实现（带硬中断 + 复用）。
 */
import type { JsSandboxPool } from '@yuedu/core';

export const noopSandbox: JsSandboxPool = {
  async eval<T = unknown>(opts: {
    code: string;
    bindings?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<T> {
    throw new Error('Sandbox 未启用（M4 将接入 worker 池）：' + opts.code.slice(0, 40));
  },
};
