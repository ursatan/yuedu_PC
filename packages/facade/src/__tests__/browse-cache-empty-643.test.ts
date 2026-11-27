/**
 * `#643` **空列表不入浏览缓存**（aff `www.asianfanfics.com` 实测）。
 *
 * ## 现象
 * 该源分类走 `…,{"webView":true}` ⇒ 请求**不经过** `ctx.http` 的撞盾闸（渲染层直接给 HTML），
 * 所以 `#642` 的「撞盾就不缓存」兜不住它。渲染层那次拿回的是 CF 的
 * `<title>Just a moment…</title>` ⇒ `items: []` 被钉进 `browseCache`（TTL 120s）
 * ⇒ 盾过了、用户再点分类，**13ms 直接命中空结果**（实测 0 次网络请求），像「源彻底坏了」。
 *
 * ## 锁住三件事
 * ① 空列表：两次相同请求必须都真的执行（`calls === 2`）；
 * ② 非空列表：第二次必须命中缓存（`calls === 1`）—— 别把 `#480` 的加速改没了；
 * ③ 不同 page / 不同 filters 不串（缓存键仍按 (源, 页, filters) 区分）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineHub, noopSandbox, type HubOptions } from '../index';
import type { RuleEngine, EngineContext, UnifiedRequest, UnifiedListResult } from '@yuedu/core';

function makeListEngine(kind: string, items: () => unknown[]): { engine: RuleEngine<unknown, unknown>; calls: () => number } {
  let calls = 0;
  const engine = {
    kind,
    version: '0.0.0',
    capabilities: ['home', 'category'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === kind,
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, _req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedListResult> {
      calls += 1;
      const list = items();
      return {
        items: list as UnifiedListResult['items'],
        page: { page: 1, pageCount: 1, total: list.length, hasMore: false },
      };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  return { engine, calls: () => calls };
}

function makeHub(kind: string, engine: RuleEngine<unknown, unknown>): EngineHub {
  const hub = new EngineHub({ sandbox: noopSandbox } as unknown as HubOptions);
  hub.registerEngine(engine);
  hub.importSource({ __kind: kind, name: 'p' }, { id: `P-${kind}` });
  return hub;
}

test('#643 ①：空列表**不**入浏览缓存（第二次仍要真的跑引擎）', async () => {
  const kind = 'probe643empty';
  const { engine, calls } = makeListEngine(kind, () => []);
  const hub = makeHub(kind, engine);

  const r1 = await hub.run('home', `P-${kind}`, { action: 'home', page: 1 });
  const r2 = await hub.run('home', `P-${kind}`, { action: 'home', page: 1 });
  assert.equal((r1 as UnifiedListResult).items.length, 0);
  assert.equal((r2 as UnifiedListResult).items.length, 0);
  assert.equal(calls(), 2, '空结果被缓存了 ⇒ 撞盾/瞬时空一次会锁死 120s（修复前就是这条红）');
});

test('#643 ②：非空列表照旧命中缓存（`#480` 的加速不能被改没）', async () => {
  const kind = 'probe643full';
  const { engine, calls } = makeListEngine(kind, () => [
    { id: '1', kind: 'book', title: 'A', layout: 'grid-card', payload: {} },
  ]);
  const hub = makeHub(kind, engine);

  await hub.run('home', `P-${kind}`, { action: 'home', page: 1 });
  await hub.run('home', `P-${kind}`, { action: 'home', page: 1 });
  assert.equal(calls(), 1, '非空结果应该命中缓存');
});

test('#643 ③：空→非空 的「自愈」路径（缓存没被空结果占住）', async () => {
  const kind = 'probe643heal';
  let n = 0;
  const { engine } = makeListEngine(kind, () => {
    n += 1;
    return n === 1 ? [] : [{ id: '1', kind: 'book', title: 'B', layout: 'grid-card', payload: {} }];
  });
  const hub = makeHub(kind, engine);

  const r1 = (await hub.run('home', `P-${kind}`, { action: 'home', page: 1 })) as UnifiedListResult;
  const r2 = (await hub.run('home', `P-${kind}`, { action: 'home', page: 1 })) as UnifiedListResult;
  assert.equal(r1.items.length, 0);
  assert.equal(r2.items.length, 1, '第二次必须能拿到新数据（空结果不该挡住自愈）');
});
