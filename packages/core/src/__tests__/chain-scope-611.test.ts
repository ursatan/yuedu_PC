/**
 * `#611` **求值作用域 chainTo 化（step 1）**回归锁。
 *
 * ★ 上游依据：`modules/rhino/.../ScriptBindings.kt:32-46` —— jsLib 求值进**独立 bindings**，
 *   每次规则求值 `bindings.chainTo(sharedScope)` ⇒ **父层可读（jsLib 走原型链）+ 写落本层**。
 *
 * step 1 只做最小一步：**jsLib 的顶层声明不再写到真 `globalThis`**（旧行为的架构性缺陷，
 * 是 `#595`/`#601` 两条事故链的根），规则求值层用 `Object.create(libScope)` 当本层。
 * step 2（2026-10-25）真源码验收（32 个真实 jsLib 对拍 32/32 一致）后 **翻为默认开**，
 * 关 = `YUEDU_JS_CHAINSCOPE=0`（`#491` 纪律：核心 eval 路径必须可回退）。
 * 所以本文件**两种模式都测**：关 = 锁旧行为不倒退，开 = 锁新语义成立。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

/** 语料真形态：源库自己实现 `function Map`（qyyuapi 系聚合源 / 晋江文学都这么写） */
const LIB = [
  'function Map(e){ return "LIB:" + e; }',
  'function myLibFn(x){ return "fn:" + x; }',
  'var libVar = "var-ok";',
].join('\n');

function makeEval(chain: boolean) {
  const prev = process.env['YUEDU_JS_CHAINSCOPE'];
  // step 2 之后**默认是开** ⇒ 关必须显式给 '0'
  process.env['YUEDU_JS_CHAINSCOPE'] = chain ? '1' : '0';
  try {
    return createJsEvaluator({ variables: createVariableStore(), lib: LIB }) as (
      code: string,
      bindings: Record<string, unknown>,
    ) => unknown;
  } finally {
    if (prev === undefined) delete process.env['YUEDU_JS_CHAINSCOPE'];
    else process.env['YUEDU_JS_CHAINSCOPE'] = prev;
  }
}

test('#611 step1 · 关闭时（默认）：jsLib 声明仍挂 globalThis（旧行为不倒退）', () => {
  const ev = makeEval(false);
  assert.equal(ev('myLibFn("x")', {}), 'fn:x');
  assert.equal(ev('this.myLibFn("x")', {}), 'fn:x');
  // 旧语义：求值作用域里能看到 globalThis 上的同名字（= 污染源，此处只锁行为不倒退）
  assert.equal(ev('String(Object.prototype.hasOwnProperty.call(globalThis, "myLibFn"))', {}), 'true');
});

test('#611 step1 · 开启时：jsLib 声明**不再**成为 globalThis 自有属性（独立 bindings）', () => {
  const ev = makeEval(true);
  // ① 语义不能变：直接调、this 调、var 都能取到
  assert.equal(ev('myLibFn("x")', {}), 'fn:x');
  assert.equal(ev('this.myLibFn("x")', {}), 'fn:x');
  assert.equal(ev('String(libVar)', {}), 'var-ok');
  // ② 架构判据：globalThis **不再**被 jsLib 写脏（上游「独立 bindings」）
  assert.equal(ev('String(Object.prototype.hasOwnProperty.call(globalThis, "myLibFn"))', {}), 'false');
  assert.equal(ev('String(Object.prototype.hasOwnProperty.call(globalThis, "libVar"))', {}), 'false');
});

test('#611 step1 · 开启时：`Map` 双语义仍成立（防 #595 / #601 回归）', () => {
  const ev = makeEval(true);
  // 源库调用形态：`Map(x)` → 源库版
  assert.equal(ev('Map("a")', {}), 'LIB:a');
  // 宿主/数据结构形态：`new Map()` → 原生（shim 的 new.target 分流）
  assert.equal(ev('String(new Map([["k",1]]).get("k"))', {}), '1');
  // 求值结束后 globalThis.Map 必须是原生（两种模式同判据）
  assert.equal(typeof Map, 'function');
  assert.equal(new Map([['k', 1]]).get('k'), 1);
});

test('#611 step1 · 开启时：绑定（java / source / result）在作用域内仍然可见', () => {
  const ev = makeEval(true);
  assert.equal(ev('typeof java', {}), 'object');
  assert.equal(ev('typeof source', {}), 'object');
  assert.equal(ev('typeof source.getHeaderMap', {}), 'function');
  assert.equal(ev('String(typeof this.source)', {}), 'object');
  // 传入的绑定也要能读到（result 是 Legado 规则链的入口变量）
  assert.equal(ev('String(result)', { result: 'R' }), 'R');
});

/**
 * `#611` step3 补丁（2026-10-25）—— step2 翻默认后**实测抓到的两个回归**（探针
 * `tmp/probe-this-access.mts` / `tmp/probe-let-selfref.mts` 两种模式对拍）：
 * ① 规则代码**自己**的顶层函数/var-fn 经 `this.` 调用断（legacy 的 this=g 能用，
 *    chain 的 this=本层对象，属性查找不到 globalThis 上 hoist 的声明）；
 * ② `#398b` 的 `let start=start()`（Rhino 无 let-TDZ）改写目标是 `globalThis["start"]()`，
 *    而 chain 模式下 jsLib 声明已不在 globalThis ⇒ 必炸。
 * 语料两个模式都是 0 命中（482 源 + 已导入源都扫过），但都是**上游 Rhino 语义**，
 * 且 `#398b` 修过真源 ⇒ 按「语义漂移就是 bug」修 + 上锁，两种模式都测。
 */
test('#611 step3 补丁 · 规则代码自身的顶层函数经 this. 调用（两种模式同判据）', () => {
  for (const chain of [false, true]) {
    const ev = makeEval(chain);
    assert.equal(ev('function foo(){ return "F"; }\nthis.foo()', {}), 'F', `chain=${chain} fn decl`);
    assert.equal(ev('var f = function(){ return "VF"; };\nthis.f()', {}), 'VF', `chain=${chain} var fn`);
    assert.equal(ev('var g = () => "AF";\nthis.g()', {}), 'AF', `chain=${chain} arrow fn`);
  }
});

test('#611 step3 补丁 · #398b let 自引用（jsLib 全局函数）两种模式同判据', () => {
  const lib2 = 'function start() { return "LIB-START"; }';
  for (const chain of [false, true]) {
    const prev = process.env['YUEDU_JS_CHAINSCOPE'];
    process.env['YUEDU_JS_CHAINSCOPE'] = chain ? '1' : '0';
    try {
      const ev = createJsEvaluator({ variables: createVariableStore(), lib: lib2 }) as (
        code: string,
        bindings: Record<string, unknown>,
      ) => unknown;
      // Rhino 无 let-TDZ：初始化器里的 start 解析到**外层全局函数**（jsLib 入口）
      assert.equal(ev('let start = start(); start', {}), 'LIB-START', `chain=${chain}`);
      // 嵌套函数里同样成立（不能用 this["start"] 的理由见 fixRhinoLetSelfRef 注释）
      assert.equal(ev('function wrap(){ let start = start(); return start; }\nwrap()', {}), 'LIB-START', `chain=${chain} nested`);
    } finally {
      if (prev === undefined) delete process.env['YUEDU_JS_CHAINSCOPE'];
      else process.env['YUEDU_JS_CHAINSCOPE'] = prev;
    }
  }
});
