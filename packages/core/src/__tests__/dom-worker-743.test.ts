/**
 * `#743` A 轮回归锁：DOM 后端（常驻 worker）vs 宿主回落。
 *
 * 覆盖第一批 5 个 op 的**语义等价**：
 *   parse   —— `select` 无 nid 分支会在 worker 内 `parse` 一棵游离树（`#646` 缓存）
 *   select  —— `.box > p`
 *   text    —— `Element.text()`
 *   attr    —— `Element.attr('class')`
 *   html    —— `Element.html()`
 * 另加 `remove + outerHtml`（`#333` 活节点身份）：如果 worker 不是**同一个** `JsoupDom`，
 * remove 会作用在临时树，outerHtml 会把被删节点吐回来 —— 用例直接断言这一点。
 *
 * 三条路径必须结果一致（`#745` 起默认关，开关只认显式 `=1`）：
 *   ⓪ **默认（不设环境变量）** = 宿主路径，`domBackendStatus().calls` 增量 0、`dom-select > 0`；
 *   ① 显式 `YUEDU_DOM_WORKER=1` = 有 backend，`calls > 0`，宿主 `dom-select` 计数为 0；
 *   ② 显式 `YUEDU_DOM_WORKER=0` = 无 backend，宿主执行，`dom-select > 0`，worker 调用为 0。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { blockCounters } from '../diag/block-stats';
import { domBackendStatus } from '../sandbox/dom-backend';

const PAGE =
  '<html><body><div class="box">' +
  '<p class="a">第一段<span class="cnt">0</span></p>' +
  '<p class="b">第二段</p>' +
  '</div></body></html>';

const RULE_BRIDGE_NODES = [{ outerHTML: PAGE, innerHTML: PAGE, text: '第一段第二段', attrs: {} }];

/** 5 个 op + 一次 remove/outerHtml（活节点身份） */
const CODE = [
  "var doc = java.getElements('@css:html');", // 规则桥：无 nid 描述符
  "var ps = doc.select('.box > p');", // select（+ 内部 parse 游离树）
  'var e = ps.get(0);',
  "var t = String(e.text());", // text
  "var c = String(e.attr('class'));", // attr
  'var h = String(e.html());', // html（inner）
  "var clean = ps.clone(); clean.select('span.cnt').remove();", // 活节点身份
  "[t, c, h, String(clean.outerHtml())].join('|');",
].join('\n');

function count(kind: string): number {
  return blockCounters().find((b) => b.kind === kind)?.n ?? 0;
}

async function run(): Promise<{ out: string; calls: number; domSelect: number }> {
  const before = { calls: domBackendStatus().calls, domSelect: count('dom-select') };
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    ruleBridge: async () => RULE_BRIDGE_NODES,
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  const out = String(await Promise.resolve(ev(CODE, { baseUrl: 'https://s.test' })));
  const calls = domBackendStatus().calls - before.calls;
  const domSelect = count('dom-select') - before.domSelect;
  await (pool as unknown as { dispose?: () => Promise<void> }).dispose?.();
  return { out, calls, domSelect };
}

function assertOutput(out: string): void {
  const [t = '', c = '', h = '', outer = ''] = out.split('|');
  assert.equal(t, '第一段0', `text：${t}`);
  assert.equal(c, 'a', `attr：${c}`);
  assert.ok(h.includes('第一段'), `html：${h}`);
  assert.ok(!outer.includes('cnt'), `remove 必须作用在同一棵活树：${outer}`);
}

/**
 * `#745` **默认关闭锁**（用户拍板：先默认关，等合并/预算收口后再评估默认开）。
 *
 * 缺省值不是 `0` 而是「非 1 一律关」—— 未设置也必须走宿主。这条锁就是防有人把
 * 判据改回 `=== '0'`（那会让「不设环境变量」的默认行为悄悄变成起 worker）。
 */
test('#745 默认（不设 YUEDU_DOM_WORKER）走宿主路径，只有显式 =1 才起 worker', async () => {
  delete process.env['YUEDU_DOM_WORKER'];
  const { out, calls, domSelect } = await run();
  assertOutput(out);
  assert.equal(calls, 0, `默认必须走宿主（实际调用 worker ${calls} 次）`);
  assert.ok(domSelect > 0, `默认应记宿主 dom-select（实际 ${domSelect}）`);
});

test('#745 worker 路径（YUEDU_DOM_WORKER=1）：parse/select/text/attr/html + remove 身份正确（宿主不阻塞）', async () => {
  process.env['YUEDU_DOM_WORKER'] = '1';
  try {
    const { out, calls, domSelect } = await run();
    assertOutput(out);
    assert.ok(calls > 0, `显式 =1 应走 DOM worker（实际 calls=${calls}）`);
    assert.equal(domSelect, 0, `worker 路径不应在宿主记 dom-select（实际 ${domSelect}）`);
  } finally {
    delete process.env['YUEDU_DOM_WORKER'];
  }
});

test('#743 宿主回落（YUEDU_DOM_WORKER=0）：同一份代码，结果一致', async () => {
  process.env['YUEDU_DOM_WORKER'] = '0';
  try {
    const { out, calls, domSelect } = await run();
    assertOutput(out);
    assert.equal(calls, 0, `回落路径不应调用 worker（实际 ${calls}）`);
    assert.ok(domSelect > 0, `回落路径应记 dom-select（实际 ${domSelect}）`);
  } finally {
    delete process.env['YUEDU_DOM_WORKER'];
  }
});
