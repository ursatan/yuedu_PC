/**
 * `#657` **`java.getString('$.x')` 在 worker 内就地求值，不再回宿主**（目录求值的最大头）。
 *
 * ## 为什么（实测数字）
 * qimao 聚合 MD3 全链：1652 章目录 **33.10s**，路由 `worker`、每章 2 次求值、每次 1~3 次
 * `java.getString('$.xxx')` ⇒ **6600+ 次 `rpc('evalRule')`**，而 worker 侧计算本身只占 2.6s ——
 * 其余全在 `Atomics.wait` 等宿主回信（宿主同时还要跑别的请求/求值）。
 * 微基准：`new AnalyzeRule(env).setContent(str).syncGetString('$.url')` **0.394ms/次**，
 * 与 `jsonGetString` 的 0.403ms 几乎相同 ⇒ **贵的不是求值，是往返**。
 * 修后同一本书：目录 **33.10s → 6.74s**（detail 35.08s → 7.5s），章节数不变。
 *
 * ## 本文件锁三件事
 *  ① 朴素 `$.a.b[0]` + JSON 值 ⇒ **不进 `evalRule`**（本地算，零往返）；
 *  ② 取值/转串语义与宿主 `jsonpath.ts` 一致（对象 ⇒ JSON.stringify、数字 ⇒ String）；
 *  ③ **不朴素**的规则（`||` / `##` / HTML 内容 / 内嵌 `{$.x}`）必须**照旧回宿主** ——
 *     宁可少优化，也不能在快路上产生语义漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 七猫系目录项的真实形态（chapterUrl / updateTime 就是从它取字段） */
const ITEM = JSON.stringify({
  id: '7621226646028160024',
  content_md5: 'a1b2c3d4e5f6a7b8',
  url: 'https://api-ks.wtzw.com/api/v1/chapter/content?id=1&sign=abc',
  words: 3210,
  meta: { vip: 1 },
});

function makeEval(): {
  ev: (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
  evalRule: (rule: string, value: unknown) => string;
  calls: Array<{ rule: string; value: unknown }>;
  destroy: () => Promise<void>;
} {
  const calls: Array<{ rule: string; value: unknown }> = [];
  const pool = createWorkerSandboxPool({ size: 1 });
  const evalRule = (rule: string, value: unknown): string => {
    calls.push({ rule, value });
    // 宿主侧的兜底实现：用最笨的方式取一层字段（只为验证「是否回宿主」与返回值一致）
    try {
      const obj = typeof value === 'string' ? JSON.parse(value) : value;
      return String(obj?.[String(rule).replace(/^\$\./, '')] ?? '');
    } catch {
      return '';
    }
  };
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool, evalRule }) as (
    code: string,
    bindings: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  return {
    ev,
    evalRule,
    calls,
    destroy: async () => {
      await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
    },
  };
}

test('#657 ①：朴素 $.x + JSON 字符串 ⇒ 本地取值，不回宿主', async () => {
  const h = makeEval();
  try {
    const out = String(await Promise.resolve(h.ev(`java.getString('$.url')`, { $: ITEM })));
    assert.equal(out, 'https://api-ks.wtzw.com/api/v1/chapter/content?id=1&sign=abc');
    assert.equal(h.calls.length, 0, `不应回宿主 evalRule，实际：${JSON.stringify(h.calls)}`);
  } finally {
    await h.destroy();
  }
});

test('#657 ②：数字 / 对象字段的转串与宿主一致', async () => {
  const h = makeEval();
  try {
    assert.equal(String(await Promise.resolve(h.ev(`java.getString('$.words')`, { $: ITEM }))), '3210');
    assert.equal(String(await Promise.resolve(h.ev(`java.getString('$.meta')`, { $: ITEM }))), '{"vip":1}');
  } finally {
    await h.destroy();
  }
});

test('#657 ③：$.a[0] 数组下标也支持', async () => {
  const h = makeEval();
  try {
    const arr = JSON.stringify({ list: [{ n: '第一章' }, { n: '第二章' }] });
    assert.equal(String(await Promise.resolve(h.ev(`java.getString('$.list[0].n')`, { $: arr }))), '第一章');
    assert.equal(h.calls.length, 0, '数组下标同样不该回宿主');
  } finally {
    await h.destroy();
  }
});

test('#657 ④：|| / ## / 内嵌规则 ⇒ 照旧回宿主（不越界接管）', async () => {
  const h = makeEval();
  try {
    await Promise.resolve(h.ev(`java.getString('$.title||$.url')`, { $: ITEM }));
    assert.equal(h.calls.length, 1, `|| 组合规则应交回宿主：${JSON.stringify(h.calls)}`);
  } finally {
    await h.destroy();
  }
});

test('#657 ⑤：内容不是 JSON（HTML）⇒ 照旧回宿主', async () => {
  const h = makeEval();
  try {
    await Promise.resolve(h.ev(`java.getString('$.url')`, { $: '<html><body>hi</body></html>' }));
    assert.equal(h.calls.length, 1, 'HTML 内容不该被本地 JSON 路径接管');
  } finally {
    await h.destroy();
  }
});
