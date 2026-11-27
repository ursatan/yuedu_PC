/**
 * `#779` hub 侧的**按动作**注入锁：
 *  · `action === 'content'` ⇒ `ctx.jsComputeTimeoutMs` = 20s（可用 `YUEDU_JS_CONTENT_TIMEOUT_MS` 覆盖/回退）；
 *  · `detail` / `search` 等其它动作 ⇒ 字段缺省（引擎不覆盖 ⇒ worker 池默认 10s，行为不变）。
 *
 * 判据只认 `action`（不猜规则文本）；本文件用 mock 引擎直接读 ctx，不依赖具体引擎包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EngineHub, noopSandbox, type HubOptions } from '../index';
import type {
  EngineContext,
  RuleEngine,
  UnifiedContent,
  UnifiedDetail,
  UnifiedListResult,
  UnifiedRequest,
} from '@yuedu/core';

function makeBudgetEngine(seen: Map<string, EngineContext>): RuleEngine<unknown, unknown> {
  return {
    kind: 'budget',
    version: '0.0.0',
    capabilities: ['search', 'detail', 'content'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'budget',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async search(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      seen.set('search', ctx);
      return { items: [{ id: 'b1', kind: 'book', title: '书', layout: 'grid-card', payload: {} }], page: { page: 1, pageCount: 1, total: 1, hasMore: false } };
    },
    async detail(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedDetail> {
      seen.set('detail', ctx);
      return { id: 'b1', kind: 'book', title: '书' };
    },
    async content(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedContent> {
      seen.set('content', ctx);
      return { paragraphs: ['正文'] };
    },
  };
}

function makeHub(): { hub: EngineHub; seen: Map<string, EngineContext> } {
  const seen = new Map<string, EngineContext>();
  const opts: HubOptions = { sandbox: noopSandbox };
  const hub = new EngineHub(opts);
  hub.registerEngine(makeBudgetEngine(seen));
  hub.importSource({ __kind: 'budget', name: '源' }, { id: 'B' });
  return { hub, seen };
}

async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
  if (value === undefined) delete process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
  else process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'];
    else process.env['YUEDU_JS_CONTENT_TIMEOUT_MS'] = prev;
  }
}

test('#779 content：ctx 带 20s 纯计算预算', async () => {
  await withEnv(undefined, async () => {
    const { hub, seen } = makeHub();
    await hub.run('content', 'B', { action: 'content', id: JSON.stringify({ chapterUrl: 'https://x.test/c1' }) });
    assert.equal(seen.get('content')?.jsComputeTimeoutMs, 20_000, 'content 动作默认 20s');
  });
});

test('#779 detail / search 不受影响（不注入纯计算预算）', async () => {
  await withEnv(undefined, async () => {
    const { hub, seen } = makeHub();
    await hub.run('search', 'B', { action: 'search', keyword: 'k' });
    await hub.run('detail', 'B', { action: 'detail', id: JSON.stringify({ bookUrl: 'https://x.test/b1' }) });
    assert.equal(seen.get('search')?.jsComputeTimeoutMs, undefined, 'search 不得被放宽');
    assert.equal(seen.get('detail')?.jsComputeTimeoutMs, undefined, 'detail 走 #769 的 75s 行动预算，求值预算不变');
    // detail 的 75s 行动预算仍然生效（与求值预算互不相干）
    assert.ok((seen.get('detail')?.deadlineAt ?? 0) - Date.now() > 60_000, 'detail 行动预算仍 > 60s');
  });
});

test('#779 环境开关：content 可回退到池默认 10s', async () => {
  await withEnv('10000', async () => {
    const { hub, seen } = makeHub();
    await hub.run('content', 'B', { action: 'content', id: JSON.stringify({ chapterUrl: 'https://x.test/c1' }) });
    assert.equal(seen.get('content')?.jsComputeTimeoutMs, 10_000, '切回 10s（一行回退）');
  });
});

test('#779 环境开关=0：content 字段缺省 ⇒ worker 池默认 10s', async () => {
  await withEnv('0', async () => {
    const { hub, seen } = makeHub();
    await hub.run('content', 'B', { action: 'content', id: JSON.stringify({ chapterUrl: 'https://x.test/c1' }) });
    assert.equal(seen.get('content')?.jsComputeTimeoutMs, undefined, '0 = 不覆盖（与改动前一致）');
  });
});
