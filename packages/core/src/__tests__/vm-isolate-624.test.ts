/**
 * `#624` **vm 真隔离回归锁**（worker 路径）。
 *
 * 取证背景（tmp/probe-624-worker-surface.mts，2026-10-25）：worker 线程里 `require`
 * 是 Node **注入**的 ⇒ 书源脚本 `require("os").userInfo().username` 实测返回 "SATAN"
 * ⇒ `#612` 审计里「缓解＝默认跑 worker」对 RCE 是**错的**（只对 process.exit() 成立）。
 * 本锁保证：求值 realm 切到 `node:vm` 后，process/require/Buffer 对脚本不可见，
 * 而 `java.*`（宿主函数跨上下文）照旧可用；`YUEDU_JS_VM=0` 仍可回退旧行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/**
 * ①/②/④ 锁的是 **vm 开时**的隔离面（require/process/Buffer 不可见、Web 面按需注入）。
 * `YUEDU_JS_VM=0` 是显式回退开关（旧行为：求值落在 worker 全局）⇒ 这三条在回退配置下
 * 按设计就**不成立**（⑥ 正锁着这个反差）。故回退配置下显式 skip，而不是留红 ——
 * 默认配置（无环境变量）照常全跑，回退配置跑 `pnpm -F @yuedu/core test` 也全绿。
 */
const VM_OFF = process.env['YUEDU_JS_VM'] === '0';

function makeWorkerEval(): (code: string, bindings?: Record<string, unknown>) => Promise<unknown> {
  const pool = createWorkerSandboxPool({ size: 1 });
  return createHybridJsEvaluator({ variables: createVariableStore(), pool }) as (
    code: string,
    bindings?: Record<string, unknown>,
  ) => Promise<unknown>;
}

test('#624 ① 危险全局对脚本不可见（require/process/Buffer/global）', { skip: VM_OFF }, async () => {
  const ev = makeWorkerEval();
  assert.equal(await ev('typeof require', {}), 'undefined');
  assert.equal(await ev('typeof process', {}), 'undefined');
  assert.equal(await ev('typeof Buffer', {}), 'undefined');
  assert.equal(await ev('typeof global', {}), 'undefined');
  // 换名字绕：globalThis.process / Function('return process')()
  assert.equal(await ev('typeof globalThis.process', {}), 'undefined');
  assert.equal(await ev('Function("return typeof require")()', {}), 'undefined');
});

test('#624 ② 真实 RCE 尝试被挡掉（worker 线程里 require 本是注入可用的）', { skip: VM_OFF }, async () => {
  const ev = makeWorkerEval();
  // 取证时这两个表达式在旧路径下**真能执行**（返回 "SATAN" / true）
  await assert.rejects(() => ev('require("os").userInfo().username', {}), /require is not defined/);
  await assert.rejects(() => ev('require("fs").existsSync("package.json")', {}), /require is not defined/);
  // 最难缠的逃逸：构造器回调（vm 里直接 is not a function）
  await assert.rejects(() => ev('({}).constructor("return typeof require")()', {}));
});

test('#624 ③ 宿主函数仍能穿过上下文边界（java.* 活路没被切断）', async () => {
  const ev = makeWorkerEval();
  assert.equal(await ev('java.md5Encode("abc")', {}), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(await ev('java.base64Encode("hi")', {}), 'aGk=');
  // 规则桥（RPC 回宿主）同样要在
  assert.deepEqual(await ev('java.getStringList("$.a")', {}), []);
});

test('#624 ④ 无害 Web/Node 面按需注入（URL 可无 new 调用 = Rhino 语义）', { skip: VM_OFF }, async () => {
  const ev = makeWorkerEval();
  assert.equal(await ev('typeof fetch', {}), 'function');
  assert.equal(await ev('URL("http://a.b/c?d=1").host', {}), 'a.b');
  assert.equal(await ev('typeof structuredClone', {}), 'function');
  assert.equal(await ev('typeof setTimeout', {}), 'function');
});

test('#624 ⑤ 跨求值复位：隐式全局不泄漏、内置被覆盖可恢复', async () => {
  const ev = makeWorkerEval();
  assert.equal(await ev('foo = 123; typeof foo', {}), 'number');
  assert.equal(await ev('typeof foo', {}), 'undefined'); // 上一条的隐式全局已被复位
  await ev('Array = 1; typeof Array', {}); // 脚本覆盖内置
  assert.equal(await ev('Array.isArray([])', {}), true); // 下一条求值里内置已恢复
});

test('#624 ⑥ 回退开关 YUEDU_JS_VM=0：旧行为可复现（证明开关真的在切换 realm）', async () => {
  const prev = process.env['YUEDU_JS_VM'];
  try {
    process.env['YUEDU_JS_VM'] = '0';
    const ev = makeWorkerEval();
    // 旧路径（worker 全局）里 require 本就可达 —— 这正是 #624 要关的面
    assert.equal(await ev('typeof require', {}), 'function');
    assert.equal(await ev('typeof process', {}), 'object');
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JS_VM'];
    else process.env['YUEDU_JS_VM'] = prev;
  }
});
