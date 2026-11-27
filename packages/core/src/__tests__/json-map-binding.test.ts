/**
 * 回归锁 #76：JSON 内容绑定必须同时支持「属性访问」与「Java Map/List API」。
 *
 * Legado 的 `result`（JSON 内容）是 **GSON LinkedTreeMap**，在 Rhino 里是 NativeJavaObject
 * → 源脚本**既能** `result.k`，**也能** `result.get("k")` / `size()` / `keySet()`。
 * 实测（点众阅读 `ruleBookInfo.kind`）：
 *   `[result.get("statusTips"), result.get("comScore") + "分"].concat(result.get("tags"))`
 * 我们传普通 JS 对象 → `result.get is not a function` → 整条详情 RULE_PARSE。
 *
 * 两条纪律（本测试锁定）：
 * ① 方法**必须非枚举** —— 宿主用 `Object.values()` 判「可结构化克隆」（`isCloneable`），
 *    枚举的函数会让含 JSON 的脚本被推回 L1（并发退化）。
 * ② 宿主与 worker **各挂一次**（非枚举属性不会随 structuredClone 过去）→ 用同一份注入源码。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { attachJsonMapMethods, JSON_MAP_METHODS_SOURCE } from '../selector/json-map';
import { createJsEvaluator, createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { blockSamples, resetBlocks } from '../diag/block-stats';

const JSON_CONTENT = JSON.stringify({
  statusTips: '连载中',
  comScore: '8.7',
  tags: ['玄幻', '热血'],
});

/** 真实 JS 求值器（L1） */
function makeEnv() {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables }) as (code: string, b: Record<string, unknown>) => unknown;
  return {
    baseUrl: 'https://t.test/',
    variables,
    jsEval: async (code: string, b: Record<string, unknown>) => ev(code, b),
    jsEvalSync: (code: string, b: Record<string, unknown>) => ev(code, b),
    toAbsolute: (u: string) => u,
  } as never;
}

test('#76 L1：对象内容支持 result.get / 属性 / keySet（点众阅读 kind 形态）', async () => {
  // ⚠️ 真实来源是 `ruleBookInfo.init = "$.bookDetail"` 之后的**对象**内容（Legado 的 LinkedTreeMap）；
  //    原始 JSON **字符串**在 Legado 下也没有 .get()（`result is NativeObject` 分支不成立）——
  //    别把测试建在错误前提上。
  const rule =
    '@js:\nlet a = [result.get("statusTips"), result.get("comScore") + "分"];\nJSON.stringify(a.concat(result.get("tags")))';
  const out = await new AnalyzeRule(makeEnv())
    .setContent(JSON.parse(JSON_CONTENT), 'https://t.test/')
    .getString(rule, false);
  assert.equal(String(out), JSON.stringify(['连载中', '8.7分', '玄幻', '热血']), `kind 规则应取得 Java Map 语义：${String(out)}`);
});

test('#76 Map 方法必须非枚举（否则 isCloneable 判失败 → 脚本被推回 L1）', () => {
  const o = { a: 1, b: 2 };
  attachJsonMapMethods(o);
  const vals = Object.values(o);
  assert.deepEqual(vals, [1, 2], `Object.values 不得带上方法：${JSON.stringify(vals)}`);
  assert.equal(Object.keys(o).length, 2, 'keys 不得增加');
  // 方法仍可用
  assert.equal((o as unknown as { get: (k: string) => unknown }).get('a'), 1);
  assert.equal((o as unknown as { size: () => number }).size(), 2);
  // 幂等
  attachJsonMapMethods(o);
  assert.equal(Object.keys(o).length, 2);
});

test('#76 List：数组绑定支持 get(i) / size()，且不影响 length 语义', () => {
  const arr = ['x', 'y'];
  attachJsonMapMethods(arr);
  const a = arr as unknown as { get: (i: number) => unknown; size: () => number };
  assert.equal(a.get(1), 'y');
  assert.equal(a.size(), 2);
  assert.equal(JSON.stringify(arr), '["x","y"]', 'JSON 序列化不得带上方法');
});

test('#76 注入源码与宿主实现同语义（防两处漂移）', () => {
  const f = new Function(`${JSON_MAP_METHODS_SOURCE}; return __yueduAttachJsonMap;`)() as (v: unknown) => Record<string, unknown>;
  const o = f({ k: 'v' }) as unknown as { get: (k: string) => unknown; size: () => number; keySet: () => string[] };
  assert.equal(o.get('k'), 'v');
  assert.equal(o.size(), 1);
  assert.deepEqual(o.keySet(), ['k']);
  assert.deepEqual(Object.values(f({ k: 'v' })), ['v'], '注入实现同样必须非枚举');
});

test('#76 worker：走 worker 的脚本（含 java.ajax）也能用 Java Map 方法', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  let httpCalls = 0;
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    http: async () => {
      httpCalls++;
      return { status: 200, headers: {}, body: 'BODY' };
    },
  }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;

  // 绑定模拟真实情形：宿主 analyze.ts 已挂过方法，但**非枚举属性不会被 structuredClone 带走**
  // → worker 侧必须用同一份注入源码再挂一次。
  const bindings = { $: { statusTips: '连载中' }, result: { statusTips: '连载中' } };
  const code = ["var j = java.ajax('https://t.test/x');", "JSON.stringify([result.get('statusTips'), j])"].join('\n');

  resetBlocks();
  const out = String(await Promise.resolve(ev(code, bindings)));
  assert.equal(out, JSON.stringify(['连载中', 'BODY']), `worker 内也必须有 Map 方法：${out}`);
  assert.equal(httpCalls, 1, 'java.ajax 应经宿主 HTTP 发出（证明走的是 worker 路径）');

  const l1 = blockSamples().filter((s) => s.kind === 'l1-eval');
  assert.equal(l1.length, 0, `含 java.ajax 的脚本不应回退 L1：${JSON.stringify(l1)}`);

  await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
});
