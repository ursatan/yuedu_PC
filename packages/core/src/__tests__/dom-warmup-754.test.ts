/**
 * `#754` A 第二批回归锁：DOM worker **启动预热** + 空闲 TTL 回收。
 *
 * 覆盖四件事：
 *  ① 默认（`YUEDU_DOM_WARMUP` 未设置）⇒ 完全不预热（返回 null、0 个 worker）—— 保持 `#745` 现状；
 *  ② `YUEDU_DOM_WARMUP=2` ⇒ 预热 2 个且**真实求值器复用**它们（不再新起线程）；
 *  ③ 预热个数被池大小钳制（`=5` + `YUEDU_DOM_POOL=2` ⇒ 只起 2）；
 *  ④ 空闲 TTL：**没有 client** 的槽位被回收；**有 client** 的槽位绝不拆（nid 身份不可恢复）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDomClient, disposeDomBackend, domBackendStatus, prewarmDomBackend } from '../sandbox/dom-backend';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

const PAGE = '<html><body><ol class="ls"><li><a href="/1">甲</a></li><li><a href="/2">乙</a></li></ol></body></html>';

async function evalToc(): Promise<unknown> {
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => ({ status: 200, headers: {}, body: '' }),
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  const out = await Promise.resolve(
    ev(
      [
        "var doc = org.jsoup.Jsoup.parse(String(result));",
        "var as = doc.select('ol.ls li a');",
        'var list = [];',
        'for (var i = 0; i < as.size(); i++) {',
        '  list.push(String(as.get(i).text()));',
        '}',
        'result = list;',
      ].join('\n'),
      { result: PAGE },
    ),
  );
  await (pool as unknown as { dispose?: () => Promise<void> }).dispose?.();
  return out;
}

function cleanEnv(): void {
  delete process.env['YUEDU_DOM_WARMUP'];
  delete process.env['YUEDU_DOM_TTL_MS'];
  delete process.env['YUEDU_DOM_WORKER'];
}

test('#754 默认不预热（YUEDU_DOM_WARMUP 未设置）', async () => {
  cleanEnv();
  await disposeDomBackend();
  const r = await prewarmDomBackend();
  assert.equal(r, null, '未设置预热个数时必须完全不动作');
  const s = domBackendStatus();
  assert.equal(s.active, 0, `默认不得起 worker（实际 ${s.active}）`);
  assert.equal(s.warmup.wanted, 0);
});

test('#754 预热 2 个：后台起线程，真实求值器复用同一批 worker', async () => {
  cleanEnv();
  await disposeDomBackend();
  process.env['YUEDU_DOM_WORKER'] = '1';
  process.env['YUEDU_DOM_WARMUP'] = '2';
  try {
    const r = await prewarmDomBackend();
    assert.ok(r, '开启预热后必须有结果');
    assert.equal(r.wanted, 2);
    assert.equal(r.warmed, 2, `两个槽位都要 ping 成功（${JSON.stringify(r)}）`);
    const afterWarm = domBackendStatus();
    assert.equal(afterWarm.active, 2, `应有 2 个常驻 worker（实际 ${afterWarm.active}）`);

    assert.equal(String(await evalToc()), '甲,乙');
    const afterEval = domBackendStatus();
    assert.equal(afterEval.active, 2, '真实求值必须复用预热的槽位（不得再起线程）');
    assert.ok(afterEval.calls > r.warmed, `求值应发生 worker RPC（${afterEval.calls}）`);
  } finally {
    cleanEnv();
    await disposeDomBackend();
  }
});

test('#754 预热个数被池大小钳制（=5 / pool=2 ⇒ 2）', async () => {
  cleanEnv();
  await disposeDomBackend();
  process.env['YUEDU_DOM_WORKER'] = '1';
  process.env['YUEDU_DOM_WARMUP'] = '5';
  try {
    const r = await prewarmDomBackend();
    assert.ok(r);
    assert.equal(r.wanted, 2, `必须钳到池大小 2（实际 ${r.wanted}）`);
    assert.equal(r.warmed, 2);
  } finally {
    cleanEnv();
    await disposeDomBackend();
  }
});

test('#754 空闲 TTL 回收：无 client 的槽位被拆，有 client 的槽位不动', async () => {
  cleanEnv();
  await disposeDomBackend();
  process.env['YUEDU_DOM_WORKER'] = '1';
  process.env['YUEDU_DOM_WARMUP'] = '1';
  process.env['YUEDU_DOM_TTL_MS'] = '100';
  try {
    await prewarmDomBackend();
    assert.equal(domBackendStatus().active, 1);
    // 无 client ⇒ TTL 到点应回收（tick = ttl/2 = 50ms）
    await new Promise((r) => setTimeout(r, 400));
    const afterIdle = domBackendStatus();
    assert.equal(afterIdle.active, 0, `空闲预热槽位应被回收（实际 ${afterIdle.active}）`);
    assert.ok(afterIdle.reclaimed >= 1, `应有回收计数（${afterIdle.reclaimed}）`);

    // 有 client（求值器会话）⇒ TTL 绝不能拆线程，否则活节点表 nid 全部失效
    const c = createDomClient();
    assert.ok(c, '回收后仍应能懒起 worker');
    const root = (await c.call({ op: 'parse', html: PAGE })) as number;
    const lis = (await c.call({ op: 'select', nid: root, sel: 'li' })) as Array<{ nid: number }>;
    assert.equal(lis.length, 2);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(domBackendStatus().active, 1, '有 client 的槽位不得被 TTL 回收');
    const text = (await c.call({ op: 'text', nid: lis[0]!.nid })) as string;
    assert.equal(text, '甲', '跨 TTL 后活节点表必须仍然有效');
  } finally {
    cleanEnv();
    await disposeDomBackend();
  }
});
