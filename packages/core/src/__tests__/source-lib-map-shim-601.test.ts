/**
 * `#595` 的残留 + `#601`：**源库自定义 `Map` 与宿主内置 `Map` 共存**。
 *
 * ## 现象（全量基线 2026-10-24）
 * - `#595`：65 源 `Cannot read properties of undefined (reading 'getLoginInfoMap')`
 * - `#601`：晋江/剧迷/得奇等 `this.getHeaderMap is not a function`
 *
 * 两者是**同一条链**：源库 jsLib 普遍自定义 `function Map(e){ … }`（qyyuapi 系、晋江都有），
 * L1 为仿真 Rhino「函数声明即全局」把它挂到 `globalThis.Map` ⇒ **宿主内置 `Map` 被顶掉**。
 * 求值**期间**宿主被回调（`source.getLoginInfoMap()` 桩里 `new Map([...])`）就调到源库版：
 *  · 源库版里 `const {source}=this` ⇒ `undefined.getLoginInfoMap`（#595）
 *  · 源库版里 `this.getHeaderMap()` ⇒ `new` 出来的实例没有这方法（#601）
 * 取证栈（决定性）：`at new Map (jsLib 定义处) ← at Object.getLoginInfoMap (宿主桩)`。
 *
 * ## 修法
 * 内置名 hoist 时用 **`new.target` 双语义 shim**：
 *  · `Map(x)` / `this.Map(x)` ⇒ 源库版（源库语义不退化）
 *  · `new Map(x)` ⇒ **原生**（宿主桩、以及把 Map 当数据结构的代码都靠它）
 * 原生引用来自模块加载时的快照（`NATIVE_GLOBALS` / worker 的 `__yueduNativeGlobals`），永不被污染。
 *
 * ⚠️ 已知边界（源自身缺陷，不修）：源库**在自己的函数体里** `new Map(...)` 时走词法作用域里的
 * 函数声明，绕过 `globalThis` ⇒ 仍是源库版。上游 Rhino 同样如此（jsLib scope 也是函数声明）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsEvaluator, createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/** 晋江式 jsLib：自定义 `Map`，内部读 header；另一个函数用 `this.Map(...)` */
const LIB = [
  'function Map(e) { return String(this.getHeaderMap()[e]); }',
  'function readFl() { return String(this.Map("fl")); }',
].join('\n');

/** 宿主桩：**故意**用 `new Map(...)` —— 生产里 `getLoginInfoMap()` 就是这么实现的，也正是被杀的那行 */
const SRC = {
  getLoginInfoMap: () => new Map<string, string>([['账号', 'u1']]),
};

const CODE = [
  'JSON.stringify({',
  '  h: typeof this.getHeaderMap,',
  '  gh: typeof globalThis.getHeaderMap,',
  '  libMap: String(this.Map("fl")),',          // 源库语义：读 header 映射
  '  viaThis: readFl(),',                       // 源库内部 this.Map
  '  login: source.getLoginInfoMap().get("账号"),', // 宿主桩里的 new Map（关键断言）
  '  newOk: String(new Map([["a", 1]]).get("a")),', // 规则里的 new Map
  '})',
].join('\n');

const OPTS = { getSourceHeaders: () => ({ fl: '9,10' }) };

function parse(out: unknown): Record<string, string> {
  return JSON.parse(String(out)) as Record<string, string>;
}

test('L1：#595/#601 源库 Map 与宿主 new Map 共存（桩里的 new Map 不被劫持）', () => {
  const savedMap = globalThis.Map;
  const ev = createJsEvaluator({ variables: createVariableStore(), lib: LIB, ...OPTS });
  const j = parse(ev(CODE, { source: SRC, baseUrl: 'https://m.jjwxc.net/', page: 1 }));
  assert.equal(j['login'], 'u1', '宿主桩里的 new Map 必须仍用原生 Map');
  assert.equal(j['libMap'], '9,10', '`this.Map()` 必须走源库版（语义不能退化）');
  assert.equal(j['viaThis'], '9,10', 'jsLib 内部 `this.Map()` 同样可用');
  assert.equal(j['newOk'], '1', '规则里的 `new Map(...)` 必须是原生');
  assert.equal(globalThis.Map, savedMap, '求值结束必须还原宿主 Map');
});

/**
 * worker 那条锁的是 **chain 开时**（默认）的双语义（lib 的 function Map 进 libScope）。
 * `YUEDU_JS_CHAINSCOPE=0` 回退旧拼接路径时 with(求值全局) 遮蔽 lib 声明 ⇒ 按设计
 * 不成立，显式 skip（L1 那条没有 with、两种配置都跑，正是两侧差异的对照）。
 */
const CHAIN_OFF = process.env['YUEDU_JS_CHAINSCOPE'] === '0';

test('worker：同一条 shim 判据', { skip: CHAIN_OFF }, async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool,
      lib: LIB,
      ...OPTS,
      http: async () => ({ status: 200, headers: {}, body: '{}' }),
    }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
    const j = parse(await Promise.resolve(ev(CODE, { source: SRC, baseUrl: 'https://m.jjwxc.net/', page: 1 })));
    assert.equal(j['login'], 'u1');
    assert.equal(j['libMap'], '9,10');
    assert.equal(j['viaThis'], '9,10');
    assert.equal(j['newOk'], '1');
  } finally {
    await (pool as unknown as { close?: () => Promise<void> }).close?.();
  }
});

/**
 * 反向守卫：源把**内置名当变量名**（🎨热辣/包子/MYCOMIC/再漫画 的 header 脚本
 * `var Proxy = Map('代理：').split(",")`）时，不能把这个字符串 hoist 到 `globalThis.Proxy`
 * —— 否则后续任何 `new Proxy(...)` 都报「Proxy is not a constructor」（基线 r2，4 源）。
 *
 * 这条同时锁住「内置名清单必须单一来源」：worker 侧原手写 28 个名字、漏了 Proxy，
 * 宿主 68 个 —— 漂移就复现。现在名单由宿主下发（`__yueduNativeNames`）。
 */
const PROXY_POLLUTE_1 = 'var Proxy = "1,2,3";';
const PROXY_POLLUTE_2 =
  'JSON.stringify({ p: (function(){ try { new Proxy({}, {}); return "ok"; } catch (e) { return "E:" + e.message; } })() })';

test('L1：`var Proxy = "1,2"` 不得污染 globalThis.Proxy', () => {
  const savedProxy = globalThis.Proxy;
  const ev = createJsEvaluator({ variables: createVariableStore() });
  ev(PROXY_POLLUTE_1, {});
  const j = parse(ev(PROXY_POLLUTE_2, {}));
  assert.equal(j['p'], 'ok', '`new Proxy(...)` 必须仍可用');
  assert.equal(globalThis.Proxy, savedProxy, '求值结束必须还原 Proxy');
});

test('worker：同一条（名单由宿主下发，不得漂移）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool,
      http: async () => ({ status: 200, headers: {}, body: '{}' }),
    }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
    await Promise.resolve(ev(PROXY_POLLUTE_1, {}));
    // 同一条 worker 上再跑一次（globalThis 污染会跨作业留存，正是要防的）
    const j = parse(await Promise.resolve(ev(PROXY_POLLUTE_2, {})));
    assert.equal(j['p'], 'ok');
  } finally {
    await (pool as unknown as { close?: () => Promise<void> }).close?.();
  }
});
