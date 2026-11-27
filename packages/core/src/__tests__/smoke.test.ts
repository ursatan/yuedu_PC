/**
 * 冒烟测试：验证核心契约层能跑通。
 *
 * 这里不测试任何真实引擎，只验证「骨架」本身：
 *   1. 引擎能注册、能被自动识别
 *   2. 能分发请求并返回统一结构
 *   3. 认不出的源会抛统一错误
 *   4. trace 能记录每一步
 *
 * 运行：pnpm -F @yuedu/core test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EngineRegistry,
  EngineError,
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
} from '../index';
import type {
  RuleEngine,
  EngineContext,
  HttpClient,
  JsSandboxPool,
  UnifiedRequest,
  UnifiedListResult,
  EngineAction,
} from '../index';

// ---- 假引擎：只用来验证骨架，没有真实解析逻辑 ----

interface DummyRule {
  name: string;
}

class DummyEngine implements RuleEngine<DummyRule, Record<string, unknown>> {
  readonly kind = 'dummy';
  readonly version = '0.0.1';
  readonly capabilities: EngineAction[] = ['search'];

  detect(raw: Record<string, unknown>): boolean {
    return raw['engine'] === 'dummy';
  }

  compile(raw: Record<string, unknown>) {
    return {
      ok: true,
      rule: { name: String(raw['name'] ?? 'unnamed') },
      issues: [],
    };
  }

  async search(rule: DummyRule, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
    const t = ctx.trace.begin('parse', 'fake.rule', req.keyword);
    const items = [
      {
        id: '1',
        kind: 'book' as const,
        title: `${rule.name}-${req.keyword}-p${req.page ?? 1}`,
        layout: 'grid-card' as const,
        payload: { url: 'https://example.com/1' },
      },
    ];
    t.end(items);
    return {
      items,
      page: { page: req.page ?? 1, pageCount: 1, total: 1, hasMore: false },
    };
  }
}

function makeCtx(sourceId: string): EngineContext {
  const http: HttpClient = {
    async request() {
      throw new Error('冒烟测试不发真实请求');
    },
  };
  const sandbox: JsSandboxPool = {
    async eval() {
      throw new Error('冒烟测试不跑 JS');
    },
  };
  return {
    reqId: 'req-1',
    sourceId,
    signal: new AbortController().signal,
    http,
    sandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

test('引擎注册后能被列出', () => {
  const reg = new EngineRegistry();
  reg.register(new DummyEngine());
  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.kind, 'dummy');
  assert.deepEqual(list[0]?.capabilities, ['search']);
});

test('重复注册同名引擎会抛错', () => {
  const reg = new EngineRegistry();
  reg.register(new DummyEngine());
  assert.throws(() => reg.register(new DummyEngine()), /已注册/);
});

test('detect 能认出自己支持的源', () => {
  const reg = new EngineRegistry();
  reg.register(new DummyEngine());
  const engine = reg.detect({ engine: 'dummy', name: '测试源' });
  assert.equal(engine.kind, 'dummy');
});

test('认不出的源抛 SOURCE_INVALID', () => {
  const reg = new EngineRegistry();
  reg.register(new DummyEngine());
  assert.throws(
    () => reg.detect({ engine: 'unknown' }),
    (e: unknown) => e instanceof EngineError && e.code === 'SOURCE_INVALID',
  );
});

test('invoke 能分发请求并返回统一结构', async () => {
  const reg = new EngineRegistry();
  reg.register(new DummyEngine());
  const ctx = makeCtx('https://example.com/source');

  const res = await reg.invoke(
    { engine: 'dummy', name: '测试源' },
    { action: 'search', keyword: '斗破', page: 2 },
    ctx,
  );

  assert.equal(res.items.length, 1);
  assert.equal(res.items[0]?.title, '测试源-斗破-p2');
  assert.equal(res.items[0]?.kind, 'book');
  assert.equal(res.page.page, 2);
});

test('trace 记录了执行过程，出错时能取到最后 N 条', async () => {
  const reg = new EngineRegistry();
  reg.register(new DummyEngine());
  const ctx = makeCtx('src-1');

  await reg.invoke({ engine: 'dummy', name: 'S' }, { action: 'search', keyword: 'k' }, ctx);

  const all = ctx.trace.all();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.stage, 'parse');
  assert.equal(all[0]?.rule, 'fake.rule');
  assert.equal(typeof all[0]?.ms, 'number');
  assert.deepEqual(ctx.trace.tail(20), all);
});

test('引擎不支持的动作抛 UNSUPPORTED_ACTION', async () => {
  const reg = new EngineRegistry();
  reg.register(new DummyEngine());
  const ctx = makeCtx('src-1');

  await assert.rejects(
    reg.invoke({ engine: 'dummy', name: 'S' }, { action: 'home' }, ctx),
    (e: unknown) => e instanceof EngineError && e.code === 'UNSUPPORTED_ACTION',
  );
});

test('EngineError 的可重试判断：网络错误可重试，规则解析错误不可', () => {
  const net = new EngineError('NETWORK', 'request', { engine: 'dummy', sourceId: 's', trace: [] });
  const rule = new EngineError('RULE_PARSE', 'parse', { engine: 'dummy', sourceId: 's', trace: [] });
  assert.equal(net.detail.retryable, true);
  assert.equal(rule.detail.retryable, false);
  assert.match(net.message, /^NETWORK@request/);
});
