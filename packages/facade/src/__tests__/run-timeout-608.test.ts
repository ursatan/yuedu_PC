/**
 * `#608` **动作总预算（runTimeout）**的行为锁。
 *
 * ## 背景
 * 上游 Legado 只有**单请求** `callTimeout=60s`（`HttpHelper.kt:62`），没有「一次动作」的总预算
 * ⇒ 慢源在 App 里能一直等。本仓为了让 HTTP 请求有界（否则一次 `/api/run` 挂死几分钟，前端心跳判
 * 「服务离线」）设了 `HubOptions.runTimeoutMs`（默认 120s，`YUEDU_RUN_TIMEOUT_MS` 可覆盖）。
 *
 * ## 锁两条
 * ① 超预算 ⇒ `NETWORK@request`，且 `detail.input` 是**字符串**（前端 `api.ts` 只渲染字符串 input，
 *    原先是对象 ⇒ 用户只看到「请求失败」，看不出是预算用尽）；
 * ② 预算内 ⇒ 正常返回（闸不该误伤快源）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineHub, noopSandbox } from '../index';
import type { RuleEngine, EngineContext, UnifiedRequest, UnifiedListResult } from '@yuedu/core';

/** 慢引擎：search/home 都挂 delay 毫秒（模拟「一串请求累计太慢」） */
function makeSlowEngine(delay: number): RuleEngine<unknown, unknown> {
  return {
    kind: 'slow',
    version: '0.0.0',
    capabilities: ['search'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'slow',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async search(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      await new Promise((r) => setTimeout(r, delay));
      return { items: [], page: { page: 1, pageCount: 0, total: 0, hasMore: false }, ...(ctx.sourceId ? {} : {}) };
    },
  };
}

test('#608 超预算：NETWORK@request 且 input 是**字符串**（前端才渲染得出）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox, runTimeoutMs: 120 });
  hub.registerEngine(makeSlowEngine(600));
  hub.importSource({ __kind: 'slow', name: '慢源' }, { id: 'S' });
  await assert.rejects(
    () => hub.search('S', 'x'),
    (e: unknown) => {
      const err = e as { message: string; detail?: { input?: unknown } };
      assert.match(err.message, /NETWORK@request/);
      const input = err.detail?.input;
      assert.equal(typeof input, 'string', 'input 必须是字符串（前端只渲染字符串）');
      assert.match(String(input), /预算/);
      assert.match(String(input), /YUEDU_RUN_TIMEOUT_MS/, '文案要说清可调项');
      return true;
    },
  );
});

test('#608 预算内：正常返回（闸不误伤快源）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox, runTimeoutMs: 5_000 });
  hub.registerEngine(makeSlowEngine(10));
  hub.importSource({ __kind: 'slow', name: '快源' }, { id: 'F' });
  const r = await hub.search('F', 'x');
  assert.ok(r && typeof r === 'object', '预算内应正常返回结果');
});

test('#608 缺省 120s：不传 runTimeoutMs 时用默认值（不影响既有调用方）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeSlowEngine(10));
  hub.importSource({ __kind: 'slow', name: '默认' }, { id: 'D' });
  const r = await hub.search('D', 'x');
  assert.ok(r && typeof r === 'object');
});
