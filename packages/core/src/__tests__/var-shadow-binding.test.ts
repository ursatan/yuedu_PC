/**
 * 注入绑定**不得被脚本里的同名 `var` 遮蔽**（Rhino 语义回归锁）。
 *
 * 背景（⚡📂书荒小说 正文全空）：
 *   正文规则是 `<js>var bes = result.match(/PHA\+…/g); if (!bes) {…} else { var result = []; … }</js>`
 *   —— `result` 是注入的页面内容。V8 会把整段 eval 里的 `var result` **提升为 fn 作用域的本地变量**，
 *   本地变量遮蔽 `globalThis` 上的绑定，于是第一行 `result.match(...)` 读到 undefined →
 *   `Cannot read properties of undefined (reading 'match')`。
 *   而 Rhino 的 `var` 落在作用域对象上、不会把已有属性清成 undefined —— 所以同一份源在 Legado 里是好的。
 *
 * 修法：对「同时是绑定名」的 var 名，在 eval 前按绑定值**预置初值**
 * （`var result=globalThis["result"];`），L1 与 worker 两条路径同逻辑。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHybridJsEvaluator, createJsEvaluator, createVariableStore } from '../index';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';

const CONTENT = 'PHA+ZGF0YTwvcD4=';

/** 语料结构：先读 result，再在分支里 `var result = []`（旧实现会在第一行就抛 undefined） */
const CODE =
  'var bes = result.match(/PHA\\+[A-Za-z0-9+\\/]+={0,2}/g);\n' +
  'if (!bes) {\n' +
  "  var txt = 'NO-MATCH';\n" +
  '} else {\n' +
  '  var out = [];\n' +
  '  for (var i = 0; i < bes.length; i++) { var result = []; out.push(bes[i]); }\n' +
  "  var txt = out.join('|');\n" +
  '}\n' +
  'txt;';

/** 让 `pnpm exec tsx --test` 里的 `java.ajax` 不真的打网络 */
const httpStub = async (): Promise<{ status: number; headers: Record<string, string>; body: string }> => ({
  status: 200,
  headers: {},
  body: 'x',
});

test('L1：脚本里同名 var 不得遮蔽注入的 result（书荒小说正文形态）', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables });
  const out = ev(CODE, { result: CONTENT });
  assert.equal(String(out), CONTENT, `result 必须仍是注入内容：${String(out)}`);
});

test('worker：同一脚本经 worker 求值结果一致（两条路径同语义）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  let evals = 0;
  const counting = new Proxy(pool as unknown as Record<string, unknown>, {
    get(t, p: string) {
      const v = Reflect.get(t, p) as unknown;
      if (p === 'eval') {
        return (...a: unknown[]) => {
          evals++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as ReturnType<typeof createWorkerSandboxPool>;
  const ev = createHybridJsEvaluator({ variables: createVariableStore(), pool: counting, http: httpStub });
  try {
    // 含 java.ajax → 路由到 worker
    const out = await Promise.resolve(ev(`java.ajax("https://h.test/x"); ${CODE}`, { result: CONTENT }));
    assert.equal(String(out), CONTENT, `worker 路径 result 也必须仍是注入内容：${String(out)}`);
    assert.ok(evals > 0, '必须真的走 worker 池（否则本条测试是空转）');
  } finally {
    await (pool as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
});

test('var 提升仍然生效（脚本内赋值要能回写 globalThis，供后续 this.xxx 使用）', () => {
  const variables = createVariableStore();
  const ev = createJsEvaluator({ variables });
  const out = ev('var helper = function () { return "H"; }; helper();', {});
  assert.equal(String(out), 'H');
});
