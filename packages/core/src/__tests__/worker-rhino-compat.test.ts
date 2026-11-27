/**
 * 回归：**worker 路径必须复刻 L1 的脚本预处理**（2026-09-16）。
 *
 * 背景：Phase 0.1 把「用 jsoup/含 HTTP」的脚本从 L1 挪进 worker 后，暴露出两条**回归**——
 * 因为 worker 只拿到裸 code，没做 L1 的两步预处理：
 *   ① Rhino→V8 语法兼容：`[a,b] => …` 是 Rhino 特有写法，V8 抛
 *      `SyntaxError: Malformed arrow function parameter list`
 *      → 整段脚本语法错（Web 端实测表现：分类条显示 `ERROR：Malformed arrow fun..`）。
 *   ② 顶层声明提升：Rhino 里**函数声明即全局属性**，源脚本大量写 `this.foo()`
 *      → 不提升则 `this.getData is not a function`（独阅读网实测）。
 *
 * 这两个都是「源在 L1 下正常、进了 worker 就坏」的静默回归，必须由测试锁住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator, normalizeRhinoSyntax, inlineVarFnHoistForTest } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

function makeEval(lib?: string) {
  const pool = createWorkerSandboxPool({ size: 1 });
  const ev = createHybridJsEvaluator({
    variables: createVariableStore(),
    pool,
    ...(lib ? { lib } : {}),
    http: async () => ({ status: 200, headers: {}, body: '' }),
  }) as (code: string, b: Record<string, unknown>) => unknown | Promise<unknown>;
  return {
    pool,
    ev,
    destroy: () => (pool as unknown as { destroy?: () => Promise<void> }).destroy?.(),
  };
}

test('worker：Rhino 裸数组解构箭头函数（[a,b] => …）不再语法错', async () => {
  const { ev, destroy } = makeEval();
  // .map([title, id] => …) —— Rhino 接受，V8 原生抛 Malformed arrow function parameter list
  const code = [
    "var src = [['甲', 1], ['乙', 2]];",
    'var out = src.map([t, i] => t + i).join(",");',
    'out;',
  ].join('\n');
  const out = String(await Promise.resolve(ev(code, {})));
  assert.equal(out, '甲1,乙2', `应正常求值：${out}`);
  await destroy();
});

test('worker：jsLib 顶层函数声明经 this.foo() 可调用（Rhino 全局属性语义）', async () => {
  // 对齐独阅读网：jsLib 定义 function getData()，脚本 / lib 内部用 this.getData()
  const { ev, destroy } = makeEval(
    ['function getData(k) { return "D:" + k; }', 'function two() { return this.getData("x"); }'].join('\n'),
  );
  const out = String(await Promise.resolve(ev('this.getData("a") + "|" + this.two();', {})));
  assert.equal(out, 'D:a|D:x', `jsLib 函数应挂在 this 上：${out}`);
  await destroy();
});

test('worker：var f = function(){} 也挂到 this（Rhino 里赋值即全局属性）', async () => {
  const { ev, destroy } = makeEval();
  const out = String(
    await Promise.resolve(ev('var helper = function (n) { return "H" + n; };\nthis.helper(7);', {})),
  );
  assert.equal(out, 'H7', `var 函数表达式应挂到 this：${out}`);
  await destroy();
});

test('宿主预处理函数本身可用（normalizeRhinoSyntax / inlineVarFnHoist 单点验证）', () => {
  assert.equal(normalizeRhinoSyntax('[a, b] => a + b'), '([a, b]) => a + b');
  // 已带括号的不应被二次改写
  assert.equal(normalizeRhinoSyntax('([a, b]) => a + b'), '([a, b]) => a + b');
  assert.equal(inlineVarFnHoistForTest('var f = function () {};'), 'var f=globalThis["f"]=function () {};');
  // 循环变量不应被改写
  assert.equal(inlineVarFnHoistForTest('for (var i = 0; i < 3; i++) ;'), 'for (var i = 0; i < 3; i++) ;');
});
