/**
 * 回归锁：**变量作用域与 `this` 作用域面** —— `java.put`/`java.get` 必须跨阶段可读，
 * 且 L1 与 worker 两条路径的 `this.*` 方法面必须一致。
 *
 * —— `java.put` / `java.get` 部分 ——
 *
 * Legado（`AnalyzeRule.kt:853-888`）的变量链是
 *   `chapter.variable → book.variable → ruleData.variable → source.variable`
 * 全部**随对象存活**，所以 `ruleBookInfo` 里 put 的键，`ruleToc` / `ruleContent` 阶段照样 get 得到。
 *
 * 我们无状态：hub 每个 HTTP 动作 new 一个 `variables`（`hub.ts:427`），只写本地那份 = 跨阶段必丢。
 * 实测语料：七猫官方/聚合类源在 search/detail/toc 阶段
 *   `java.put('headers', JSON.stringify({headers: {…, sign: …}}))`
 * 而正文阶段 `java.ajax(url + "," + java.get("headers"))` ——
 * 取不到就是「请求不带签名字段」→ 站点 `验签失败` → 表现为正文空。
 *
 * 修法：`put` 除写本地外，经引擎注入的 `javaExtra.putVariable`（= 按源持久化，
 * 与 `@put:{k:v}` 同一落点）落盘；`get` 本地未命中时回落到 `sourceVariable`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHybridJsEvaluator, createJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/**
 * 包一层计数：两条 worker 用例必须**真的**走池（否则回落 L1 也会通过 → 测试空转）。
 * `__yueduWorkerPool` 品牌标记经 Proxy 透传（hybrid 靠它判定是否启用 worker）。
 */
function countingPool(raw: ReturnType<typeof createWorkerSandboxPool>) {
  const st = { evals: 0 };
  const pool = new Proxy(raw as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          st.evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;
  return { pool, st };
}

test('java.put 必须回流到引擎的持久落点（javaExtra.putVariable）', () => {
  const variables = createVariableStore();
  const persisted: Array<[string, string]> = [];
  const ev = createJsEvaluator({
    variables,
    javaExtra: { putVariable: (k: string, v: string) => persisted.push([k, v]) },
  });
  const out = ev('java.put("headers", JSON.stringify({sign:"abc"})); "done"', {});
  assert.equal(String(out), 'done');
  assert.deepEqual(persisted, [['headers', '{"sign":"abc"}']], `必须回流持久层：${JSON.stringify(persisted)}`);
  assert.equal(variables.get('headers'), '{"sign":"abc"}', '本请求内也必须立即可读');
});

test('java.get 本地未命中 → 回落「按源持久变量」（跨阶段读取）', () => {
  // 模拟「上一个动作」留下的源变量（hub 每请求新建 variables，只有 sourceVariable 被预置）
  const variables = createVariableStore({ sourceVariable: JSON.stringify({ headers: '{"sign":"abc"}', bid: '203436' }) });
  const ev = createJsEvaluator({ variables });
  assert.equal(String(ev('java.get("headers")', {})), '{"sign":"abc"}', '必须能从源变量读回');
  assert.equal(String(ev('java.get("bid")', {})), '203436', 'bid 同理（@put:{bid:id} 的落点）');
  assert.equal(String(ev('java.get("不存在")', {})), '', '未命中仍是空串（Legado 语义）');
});

test('java.get 本地值优先于源变量（本请求内的 put 不被旧值覆盖）', () => {
  const variables = createVariableStore({ sourceVariable: JSON.stringify({ headers: 'old' }) });
  const ev = createJsEvaluator({ variables });
  ev('java.put("headers", "new")', {});
  assert.equal(String(ev('java.get("headers")', {})), 'new', '本请求内的值优先');
});

test('java.get(url, headers) 的 HTTP 语义不受变量回落影响', () => {
  const calls: string[] = [];
  const variables = createVariableStore({ sourceVariable: JSON.stringify({ 'https://x.test': 'should-not-be-used' }) });
  const ev = createJsEvaluator({
    variables,
    syncFetch: (req) => {
      calls.push(req.url);
      return { status: 200, headers: {}, setCookie: [], body: 'OK' };
    },
  });
  const out = ev('java.get("https://x.test/a", {"X-A":"1"})', {});
  assert.equal(String(out), 'OK', '两参形态必须走 HTTP');
  assert.deepEqual(calls, ['https://x.test/a'], `URL 必须原样发出：${JSON.stringify(calls)}`);
});

/**
 * worker 路径（含 java.ajax 的脚本会被路由进 worker 池）：`java.put` / `java.get(key)`
 * 必须与 L1 **同语义** —— 旧实现只在 worker 的 `localVars` 里自留一份，跨阶段直接丢。
 * 语料 11 源（七猫系/聚合）正是「toc 阶段 put headers → content 阶段 get」的形态。
 */
test('worker 路径：java.get(key) 必须回落到宿主变量（跨阶段可读），不得只在 worker 内自留', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore({ sourceVariable: JSON.stringify({ headers: '{"sign":"abc"}' }) });
  const ev = createHybridJsEvaluator({ variables, pool, http: async () => ({ status: 200, headers: {}, body: 'x' }) });
  try {
    // 含 java.ajax 的脚本才进 worker；这里用 java.ajax 触发路由，再读上一阶段 put 的键
    const out = await Promise.resolve(ev('java.ajax("https://h.test/a"); java.get("headers")', {}));
    assert.equal(String(out), '{"sign":"abc"}', `worker 必须能读到宿主持久变量：${String(out)}`);
    assert.ok(st.evals > 0, '必须真的走 worker 池（否则本条测试是空转）');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

test('worker 路径：java.put 必须回流宿主持久落点（javaExtra.putVariable）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const variables = createVariableStore();
  const persisted: Array<[string, string]> = [];
  const ev = createHybridJsEvaluator({
    variables,
    pool,
    javaExtra: { putVariable: (k: string, v: string) => persisted.push([k, v]) },
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    const out = await Promise.resolve(ev('java.ajax("https://h.test/a"); java.put("headers", "SIGNED"); "ok"', {}));
    assert.equal(String(out), 'ok');
    assert.deepEqual(persisted, [['headers', 'SIGNED']], `worker 的 put 必须回流宿主：${JSON.stringify(persisted)}`);
    assert.ok(st.evals > 0, '必须真的走 worker 池（否则本条测试是空转）');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

/**
 * `this` 作用域面：jsLib 里的 `this.xxx()` 在 **L1 与 worker 两路必须同面**。
 *
 * 实测（晋江文学 v3.6+）：jsLib 调 `this.getHeaderMap()` —— L1 有该方法、worker 的 thisScope 里
 * **根本没有** → 走 worker 的规则抛 `NOT_A_FUNCTION: this.getHeaderMap is not a function`
 * （同一份源在「不带 java.ajax 的规则（L1）」与「带 java.ajax 的规则（worker）」上表现不同，
 * 这类「看路径」的失败最难排查）。
 * 另外该方法的**旧实现是空桩 `() => ({})`** → 即便调通也拿不到签名字段（静默缺失）。
 */
test('worker 路径：this.getHeaderMap() 必须可用且返回宿主真值（与 L1 同面）', async () => {
  const { pool, st } = countingPool(createWorkerSandboxPool({ size: 1 }));
  const headers = { 'User-Agent': 'UA-X', sign: 'SIGNED-1' };
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    getSourceHeaders: () => headers,
    http: async () => ({ status: 200, headers: {}, body: 'x' }),
  });
  try {
    // 用 java.ajax 触发 worker 路由
    const out = await Promise.resolve(ev('java.ajax("https://h.test/a"); String(this.getHeaderMap().sign)', {}));
    assert.equal(String(out), 'SIGNED-1', `worker 的 this.getHeaderMap 必须回宿主取真值：${String(out)}`);
    assert.ok(st.evals > 0, '必须真的走 worker 池（否则本条测试是空转）');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

test('L1 路径：this.getHeaderMap() 同样返回宿主真值（不是空桩）', () => {
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    getSourceHeaders: () => ({ sign: 'SIGNED-L1' }),
  });
  assert.equal(String(ev('String(this.getHeaderMap().sign)', {})), 'SIGNED-L1', 'L1 不得是空桩');
});
