/**
 * `#611` step3 **worker 侧 chainTo 语义**回归锁。
 *
 * 上游依据：`ScriptBindings.kt:32-46` —— jsLib 求值进独立 bindings，规则求值
 * `chainTo(sharedScope)`（父可读 / 写落本层）。L1 侧已由 step1/step2 落地并翻默认；
 * 本锁锁 worker 侧同语义（此前 worker 是「宿主把 lib 拼进 code 同一 eval 作用域」）。
 *
 * 三条核心语义（与 L1 的 chain-scope-611.test.ts 同判据，防两侧漂移）：
 *  ① lib 声明**不污染**求值 realm 全局（跨求值不可见）；
 *  ② `this.*` 在 worker 里可用（lib 函数重绑到求值层）；
 *  ③ 内置名双语义：`new Map` 原生 / `Map(x)` 源库版（`#601` 那条链）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/**
 * ①/②/④ 锁的是 **chain 开时**（默认）的 chainTo 语义：lib 声明不进求值全局、
 * 内置名双语义经 libScope 的 shim 落地。`YUEDU_JS_CHAINSCOPE=0` 是显式回退开关
 * （旧行为：宿主把 lib 拼进 code、with(求值全局) 求值）⇒ 这三条按设计不成立
 * （⑤ 正锁着这个反差：旧路径 libFn 可用）。故回退配置下显式 skip；默认配置照常全跑。
 *
 * ⚠️ 已知边界（回退配置固有，非 #611 引入）：旧路径的 with(求值全局) 会把 lib 的
 * 内置名函数声明遮蔽在全局原生之后 ⇒ new Map 仍走原生，但 Map(x) 取不到源库版
 * （L1 旧路径没有 with、不受影响；worker 旧路径与 L1 旧路径仅在这一条上不对拍）。
 */
const CHAIN_OFF = process.env['YUEDU_JS_CHAINSCOPE'] === '0';

const LIB = [
  'function libFn(x){ return "L:" + x; }',
  'function Map(e){ return { tag: "LIBMAP", e: e }; }',
  'function usesThis(){ return this.libFn("viaThis"); }',
  'var HJ_B = "https://www.huangjinwu.org";', // 源库常态：基址/开关是 var 不是函数（#563 锁的根因）
].join('\n');

function makeWorkerEval(lib = LIB): (code: string, bindings?: Record<string, unknown>) => Promise<unknown> {
  const pool = createWorkerSandboxPool({ size: 1 });
  return createHybridJsEvaluator({ variables: createVariableStore(), pool, lib }) as (
    code: string,
    bindings?: Record<string, unknown>,
  ) => Promise<unknown>;
}

test('#611 step3 ① worker：lib 声明不进求值全局（原型链可读 = 父可读）', { skip: CHAIN_OFF }, async () => {
  const ev = makeWorkerEval();
  assert.equal(await ev('this.libFn("x")', {}), 'L:x'); // 本层可用
  // chainTo 语义：**原型链可读**（父可读）⇒ typeof 是 function；但**不落 globalThis**
  assert.equal(await ev('typeof libFn', {}), 'function');
  assert.equal(
    await ev('String(Object.prototype.hasOwnProperty.call(globalThis, "libFn"))', {}),
    'false',
  );
  assert.equal(await ev('typeof globalThis.libFn', {}), 'undefined');
  // 写只落本层/全局，不改 lib 层（上游「写落本层」）
  assert.equal(await ev('libFn = 1; typeof libFn', {}), 'number');
  assert.equal(await ev('typeof libFn', {}), 'function'); // 下一条求值：lib 层未被改写
});

test('#611 step3 ② worker：内置名双语义（new Map 原生 / Map(x) 源库版）', { skip: CHAIN_OFF }, async () => {
  const ev = makeWorkerEval();
  // 源库自带 function Map ⇒ new 必须走**原生**（#601：否则 this 是新实例、没有宿主方法）
  assert.equal(await ev('(new Map([["a", 1]])).get("a")', {}), 1);
  // 普通调用必须走**源库版**
  assert.equal(await ev('Map("S").tag', {}), 'LIBMAP');
  assert.equal(await ev('Map("S").e', {}), 'S');
});

test('#611 step3 ③ worker：lib 的 var 声明也进作用域（黄金屋 HJ_B 形态，#563 根因）', async () => {
  const ev = makeWorkerEval();
  // var HJ_B 必须经原型链可读（L1 collect 覆盖 libFns ∪ libVars，worker 同判据）
  assert.equal(await ev('HJ_B', {}), 'https://www.huangjinwu.org');
  assert.equal(await ev('typeof globalThis.HJ_B', {}), 'undefined'); // 但不落全局
});

test('#611 step3 ④ worker：lib 函数经 this / 裸调用都拿得到求值层', async () => {
  const ev = makeWorkerEval();
  assert.equal(await ev('usesThis()', {}), 'L:viaThis'); // lib 内 this.* 走属性查找
  assert.equal(await ev('libFn("y")', {}), 'L:y'); // 裸调用（重绑后 this=求值层）
});

test('#611 step3 ④ worker：与 L1 对拍（同一份 lib 与用例，结果逐字相同）', { skip: CHAIN_OFF }, async () => {
  const cases = ['this.libFn("x")', 'libFn("y")', 'usesThis()', 'Map("S").tag', '(new Map([["a",1]])).get("a")', 'typeof libFn'];
  const l1 = createHybridJsEvaluator({ variables: createVariableStore(), lib: LIB }) as (
    code: string,
    bindings?: Record<string, unknown>,
  ) => unknown;
  const w = makeWorkerEval();
  for (const code of cases) {
    assert.deepEqual(await w(code, {}), l1(code, {}), `worker/L1 不一致：${code}`);
  }
});

test('#611 step3 ⑤ worker：chain 关（YUEDU_JS_CHAINSCOPE=0）走旧拼接路径仍可用', async () => {
  const prev = process.env['YUEDU_JS_CHAINSCOPE'];
  try {
    process.env['YUEDU_JS_CHAINSCOPE'] = '0';
    const ev = makeWorkerEval();
    assert.equal(await ev('this.libFn("x")', {}), 'L:x'); // 旧路径：lib 拼进 code、hoist 到全局
    assert.equal(await ev('libFn("y")', {}), 'L:y');
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JS_CHAINSCOPE'];
    else process.env['YUEDU_JS_CHAINSCOPE'] = prev;
  }
});
