/**
 * `#594` **`source` 绑定的兜底**：调用方显式传 `source: undefined` 时，脚本里的
 * `source.getLoginInfoMap()` 不能 TypeError。
 *
 * ## 为什么单独钉这一条
 * 2026-10-24 全量基线（737 源）里 **65 个源**挂在
 * `Cannot read properties of undefined (reading 'getLoginInfoMap')` —— 是当轮**引擎侧第一类问题**。
 * 取证（`tmp/nullderef-evidence.json`）显示连「规则里根本没写 getLoginInfoMap」的源也中招
 * ⇒ 不是源规则的问题，是**求值环境里 `source` 这个 binding 不存在**。
 *
 * 根因：求值器先写默认值 `source: defaultSourceStub`，再 `...bindings` 展开；
 * 而对象展开是**后胜**的 —— 调用方只要带了 `source: undefined` 这个**键**
 * （如 `engine-rss` 的 `source: env.sourceData` 而 sourceData 缺失），
 * 默认值就被 undefined 顶掉。上游 Rhino 里 `source` 是**恒存在**的 binding，缺失即我方缺陷。
 *
 * ⇒ 修复：展开后统一兜底 —— **可以读不到登录信息，但不能没有 `source` 这个对象**。
 * L1（`selector/js.ts`）与 worker（`sandbox/worker-pool.ts`）两条路径**都要**兜，
 * 所以两个用例各测一条（同一判据写两处必然漂移 ⇒ 用同一组断言钉住）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJsEvaluator, createHybridJsEvaluator } from '../selector/js';
import { attachJsonMapMethods } from '../selector/json-map';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';

/**
 * worker 那条锁的是 **chain 开时**（默认）的双语义：lib 的 function Map 进 libScope
 * （new Map 原生 / Map(x) 源库版）。`YUEDU_JS_CHAINSCOPE=0` 回退旧拼接路径时，
 * with(求值全局) 会把 lib 的内置名声明遮蔽在全局原生之后 ⇒ 按设计不成立，显式 skip
 * （L1 那条没有 with、两种配置都跑，正是两侧差异的对照）。
 */
const CHAIN_OFF = process.env['YUEDU_JS_CHAINSCOPE'] === '0';

/** 脚本：拿登录信息（源规则里最常见的写法，方括号与 .get() 都要能用） */
const CODE = 'JSON.stringify(source.getLoginInfoMap().get("账号") || "")';

test('L1：bindings.source 显式为 undefined ⇒ 兜底桩生效，不抛 TypeError', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  // 修复前：这里抛 `Cannot read properties of undefined (reading 'getLoginInfoMap')`
  const out = ev(CODE, { source: undefined });
  assert.equal(String(out), '""');
});

test('L1：给了真桩 ⇒ 仍用真桩（兜底不能遮蔽真登录信息）', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  const out = ev(CODE, {
    source: { getLoginInfoMap: () => ({ 账号: 'u1', get: (k: string) => ({ 账号: 'u1' })[k] ?? '' }) },
  });
  assert.equal(String(out), '"u1"');
});

test('worker 路径：未下发 __yueduSourceFields ⇒ source 仍存在', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool,
      http: async () => ({ status: 200, headers: {}, body: '{}' }),
    }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
    // 不带 java.ajax ⇒ 走 worker 池；bindings 里没有 source 描述符 ⇒ 走兜底分支
    const out = String(await Promise.resolve(ev(CODE, { source: undefined })));
    assert.equal(out, '""');
  } finally {
    await (pool as unknown as { close?: () => Promise<void> }).close?.();
  }
});

/** Java List.toArray()（全量基线：`result.toArray is not a function`） */
test('JSON 列表绑定：toArray() 可用（Java List 语义）', () => {
  const arr = attachJsonMapMethods(['a', 'b']) as unknown as { toArray: () => unknown[] };
  assert.deepEqual(arr.toArray(), ['a', 'b']);
});

/**
 * ★★ **真因（2026-10-24 二次取证，上面三条兜底只是「别崩」不是「修好」）**
 *
 * `tmp/repro-595.ts` 的最小复现栈（决定性）：
 * ```text
 * at new Map (js.ts …)            ← **宿主桩里的** `new Map([['账号','u1']])`
 * at Object.getLoginInfoMap (宿主桩)
 * at Map (jsLib)                  ← 源库自己实现的 `function Map(e)`
 * ```
 * ⇒ 报错的 `undefined` 不是 `source`，而是**宿主自己的 `Map` 被源库函数顶掉了**：
 *   聚合类源的 jsLib 普遍自带 `function Map(e){ const {source}=this; … }`（qyyuapi 系都有），
 *   而 L1 为了让 Rhino「函数声明即全局」把 jsLib 的每个函数 `globalThis[n]=n`，
 *   **`Map` 正好是 Node 的内置构造器** ⇒ 求值期间宿主被回调的桩代码 `new Map(...)`
 *   调到源库版 ⇒ 源库版里 `this` 是新实例、没有 `source` ⇒ `undefined.getLoginInfoMap`。
 *   `finally` 的还原**救不了**（污染发生在求值过程中，宿主的回调正是那时跑的）。
 *
 * ⇒ 修复：`hoistStmts`（宿主）与 `__yueduHoist`（worker）**跳过内置全局名**。
 *   语义不退化：jsLib 函数本来就在求值作用域里可见（`with(__yueduScope)` / fn 作用域）。
 */
const LIB_WITH_MAP = [
  'function Map(e) {',
  '  var src = this && this.source;',
  '  var infomap = src.getLoginInfoMap();',
  '  return String(infomap && infomap.get(e) ? infomap.get(e) : "");',
  '}',
].join('\n');

/** 宿主桩：**故意**用 `new Map(...)` —— 这正是被源库 `Map` 杀掉的那一行 */
const SRC_WITH_NATIVE_MAP = {
  getLoginInfoMap: () => new Map<string, string>([['账号', 'u1']]),
};

const MIXED_CODE = [
  'JSON.stringify({',
  '  login: source.getLoginInfoMap().get("账号"),',
  '  libMap: String(Map("年份：")),',
  '  newOk: String(new Map([["a", 1]]).get("a")),',
  '})',
].join('\n');

test('L1：jsLib 的 `function Map(e)` 不得覆盖宿主内置 Map（#595 真因）', () => {
  const savedMap = globalThis.Map;
  const ev = createJsEvaluator({ variables: createVariableStore(), lib: LIB_WITH_MAP });
  const j = JSON.parse(String(ev(MIXED_CODE, { source: SRC_WITH_NATIVE_MAP }))) as Record<string, unknown>;
  assert.equal(j['login'], 'u1', '宿主桩里的 new Map 必须仍用内置 Map');
  assert.equal(j['libMap'], '', '脚本里的 Map 仍须解析到源库版本（语义不能退化）');
  assert.equal(j['newOk'], '1', 'new Map 必须走原生（判定看行为，不看 String(Map)）');
  assert.equal(globalThis.Map, savedMap, '求值结束必须还原（不得留下 shim）');
});

test('worker：同一份内置名单（worker 自己的 Map 也不被覆盖）', { skip: CHAIN_OFF }, async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool,
      lib: LIB_WITH_MAP,
      http: async () => ({ status: 200, headers: {}, body: '{}' }),
    }) as (code: string, bindings: Record<string, unknown>) => unknown | Promise<unknown>;
    const j = JSON.parse(String(await Promise.resolve(ev(MIXED_CODE, { source: SRC_WITH_NATIVE_MAP })))) as Record<string, unknown>;
    assert.equal(j['login'], 'u1');
    assert.equal(j['libMap'], '');
    assert.equal(j['newOk'], '1', 'worker 的 new Map 也必须走原生');
  } finally {
    await (pool as unknown as { close?: () => Promise<void> }).close?.();
  }
});

/**
 * 反向守卫：源**明确**写 `this.<内置名>(…)` 时才放行 hoist。
 * 语料唯一例（🏷晋江文学）：jsLib 定义 `function Map`，另一个 jsLib 函数里 `this.Map("fl")`。
 * 放行 ⇒ 允许覆盖宿主 `Map`（旧行为），不能为了治 65 源而把这一源打挂。
 */
const LIB_THIS_MAP = [
  'function Map(e) { return "lib-" + e; }',
  'function callIt() { return String(this.Map("fl")); }',
].join('\n');

test('源写 this.Map() ⇒ 放行 hoist（晋江文学那 1 例不牺牲），且求值后仍还原内置 Map', () => {
  const savedMap = globalThis.Map;
  const ev = createJsEvaluator({ variables: createVariableStore(), lib: LIB_THIS_MAP });
  assert.equal(String(ev('String(this.Map("fl"))', { source: SRC_WITH_NATIVE_MAP })), 'lib-fl');
  assert.equal(String(ev('callIt()', { source: SRC_WITH_NATIVE_MAP })), 'lib-fl', 'jsLib 内部的 this.Map() 同样要能用');
  assert.equal(globalThis.Map, savedMap, '求值结束必须还原宿主 Map');
});


