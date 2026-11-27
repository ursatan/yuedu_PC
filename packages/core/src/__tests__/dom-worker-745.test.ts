/**
 * `#745` A 第二批回归锁：跨线程 **mutation 语义** + 批量 op + 回流写回。
 *
 * 覆盖四件事：
 *  ① 跨树身份：`clone()` 出来的副本上写，原树不受影响（两份 nid 不能串）；
 *  ② 连续 mutation：同一元素连续两次 `attr(k,v)`，第二次读必须看到第二次写的值；
 *  ③ `Elements.remove()`：批量删除一次打过去，删完 `doc.select` 应为 0；
 *  ④ 批量 `describeAll`：一次往返取 N 个**实时**描述（写之后 attrs 必须是新值）。
 *
 * 另加 ⑤：回流元素（worker → 宿主重建）上的写要**派发回原 worker 树**
 * （断言 worker 调用数增加；树内一致性由 ① 的同一套 dom-rpc 语义保证）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { createDomClient, domBackendStatus, disposeDomBackend } from '../sandbox/dom-backend';

const PAGE =
  '<html><body>' +
  '<p class="a">甲<span>x</span></p>' +
  '<p class="b">乙</p>' +
  '<p class="c">丙</p>' +
  '</body></html>';

const CODE = [
  "var doc = org.jsoup.Jsoup.parse(String(result));",
  "var ps = doc.select('p');",
  'var a = ps.get(0);',
  "a.attr('k', '1');", // 连续 mutation ①
  "a.attr('k', '2');", // 连续 mutation ②
  "var k2 = String(a.attr('k'));",
  'var cl = a.clone();', // 跨树身份
  "cl.attr('k', '9');",
  "var origK = String(a.attr('k'));",
  "var cloneK = String(cl.attr('k'));",
  "var cloneText = String(cl.text());",
  "var cntBefore = String(doc.select('p').size());",
  'ps.remove();', // Elements 批量删除
  "var cntAfter = String(doc.select('p').size());",
  "[k2, origK, cloneK, cloneText, cntBefore, cntAfter].join('|');",
].join('\n');

async function run(): Promise<{ out: string; calls: number }> {
  const before = domBackendStatus().calls;
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool, http: async () => ({ status: 200, headers: {}, body: '' }) }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  const out = String(await Promise.resolve(ev(CODE, { result: PAGE })));
  const calls = domBackendStatus().calls - before;
  await (pool as unknown as { dispose?: () => Promise<void> }).dispose?.();
  return { out, calls };
}

function assertOut(out: string): void {
  const [k2 = '', orig = '', cloneK = '', cloneText = '', before = '', after = ''] = out.split('|');
  assert.equal(k2, '2', `连续两次写后读必须是第二次的值：${k2}`);
  assert.equal(orig, '2', `clone 上的写不得回改原树：${orig}`);
  assert.equal(cloneK, '9', `clone 副本上的写必须生效：${cloneK}`);
  assert.equal(cloneText, '甲x', `clone 必须带原文本：${cloneText}`);
  assert.equal(before, '3', `删除前应有 3 个 p：${before}`);
  assert.equal(after, '0', `Elements.remove() 必须一次批量删净：${after}`);
}

test('#745 worker 模式：clone 身份 / 连续 mutation / Elements 批量删除', async () => {
  process.env['YUEDU_DOM_WORKER'] = '1';
  try {
    const { out, calls } = await run();
    assertOut(out);
    assert.ok(calls > 0, `应走 DOM worker（实际 calls=${calls}）`);
  } finally {
    delete process.env['YUEDU_DOM_WORKER'];
  }
});

test('#745 宿主模式（默认关）：同一份脚本逐字等价', async () => {
  delete process.env['YUEDU_DOM_WORKER'];
  const { out, calls } = await run();
  assertOut(out);
  assert.equal(calls, 0, `默认必须走宿主（实际 ${calls}）`);
});

test('#745 批量 describeAll：一次往返取 N 个实时描述（写后 attrs 是新值）', async () => {
  process.env['YUEDU_DOM_WORKER'] = '1';
  try {
    const c = createDomClient();
    assert.ok(c, '显式 =1 时 createDomClient() 必须有值');
    if (!c) return;
    const root = (await c.call({ op: 'parse', html: PAGE })) as number;
    const els = (await c.call({ op: 'select', nid: root, sel: 'p' })) as Array<{ nid: number }>;
    assert.equal(els.length, 3);
    const nid = els[0]!.nid;
    await c.call({ op: 'setAttr', nid, name: 'k', value: 'v1' });
    const live = (await c.call({ op: 'describeAll', nids: els.map((e) => e.nid) })) as Array<{
      nid: number; text: string; attrs: Record<string, string>;
    }>;
    assert.equal(live.length, 3, 'describeAll 必须逐项返回（不丢项）');
    assert.equal(live[0]?.attrs['k'], 'v1', 'describeAll 必须是实时值（写后可见）');
    assert.equal(live[1]?.text, '乙', `第二项文本：${live[1]?.text}`);
  } finally {
    await disposeDomBackend();
    delete process.env['YUEDU_DOM_WORKER'];
  }
});

test('#745 回流元素：宿主侧写操作必须派发回原 worker 树', async () => {
  process.env['YUEDU_DOM_WORKER'] = '1';
  try {
    const pool = createWorkerSandboxPool({ size: 1 });
    const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool, http: async () => ({ status: 200, headers: {}, body: '' }) }) as (
      code: string,
      bindings: Record<string, unknown>,
    ) => unknown | Promise<unknown>;
    const els = (await Promise.resolve(
      ev("var doc = org.jsoup.Jsoup.parse(String(result)); result = doc.select('p');", { result: PAGE }),
    )) as Array<{ attr: (k: string, v?: string) => unknown }>;
    assert.equal(els.length, 3, '回流元素个数');
    const before = domBackendStatus().calls;
    els[1]!.attr('data-rid', 'ZZZ'); // 宿主副本上的写
    // 写回是 fire-and-forget ⇒ 让出一拍，等它落到 worker
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(domBackendStatus().calls > before, `回流元素上的写应派发回 worker（实际 ${domBackendStatus().calls - before} 次）`);
    await (pool as unknown as { dispose?: () => Promise<void> }).dispose?.();
  } finally {
    delete process.env['YUEDU_DOM_WORKER'];
  }
});
