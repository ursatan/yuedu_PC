/**
 * `#314`（2026-10-07）：源登录信息族（Legado `BaseSource`）**唯一实现**的回归锁。
 *
 * 背景（用户报障 → 真跑取证）：订阅源 `影视聚合(资源站)` 的 `sortUrl` 脚本第一行是
 *   `let loginInfo = source.getLoginInfoMap(); … loginInfo["选择影视源站"]`
 * 而 rss 引擎的 source 桩**整块没有** `getLoginInfoMap` ⇒ `is not a function`
 * ⇒ 整个分类脚本崩、分类退化成「整源」（`tmp/probe-rss-login.log` 实测）。
 *
 * 三个必须由一处决定、否则必然漂移的点（详见 `source-login.ts` 头注）：
 *  ① 合并规则：`variables['__loginInfo']` ⊕ `ctx.loginInfo`（后者优先）；
 *  ② JS 可见形态：**方括号与 `.get()` 都要能用**（上游 Rhino 桥 `java.util.Map`；
 *     语料 45 处里 `.get("键")` 35 处、`["键"]` 10 处）且 Map 方法**非枚举**；
 *  ③ 落盘：空表也写（否则 `removeLoginInfo` 只清内存，下次 prime 又"复活"）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineContext } from '../contract/engine';
import { createVariableStore } from '../store';
import { loginInfoMapForJs, makeSourceLoginStub, persistSourceLogin, readLoginInfo } from '../source-login';

/** 造一个够用的 EngineContext（storage 用内存 Map，可断言落盘结果） */
function makeCtx(init?: {
  variables?: Record<string, string>;
  loginInfo?: Map<string, string>;
  store?: Record<string, string>;
}): { ctx: EngineContext; store: Map<string, string> } {
  const variables = createVariableStore();
  for (const [k, v] of Object.entries(init?.variables ?? {})) variables.set(k, v);
  const store = new Map<string, string>(Object.entries(init?.store ?? {}));
  const ctx = {
    reqId: 'test',
    sourceId: 'src-1',
    signal: new AbortController().signal,
    http: { async request() { return { status: 200, headers: {}, body: '' }; } },
    sandbox: { async eval() { return undefined; } },
    trace: { tail: () => [] },
    variables,
    storage: {
      async get(k: string) { return store.get(k) ?? null; },
      async set(k: string, v: string) { store.set(k, v); },
      async delete(k: string) { store.delete(k); },
    },
    ...(init?.loginInfo ? { loginInfo: init.loginInfo } : {}),
  } as unknown as EngineContext;
  return { ctx, store };
}

test('#314：readLoginInfo 合并「变量里的」与「宿主注入的」，宿主优先', () => {
  const { ctx } = makeCtx({
    variables: { __loginInfo: JSON.stringify({ 账号: 'old', 只读: 'x' }) },
    loginInfo: new Map([['账号', 'new']]),
  });
  assert.deepEqual(readLoginInfo(ctx), { 账号: 'new', 只读: 'x' }, '同名键必须由 ctx.loginInfo 覆盖');
  assert.deepEqual(readLoginInfo(makeCtx().ctx), {}, '都没有时必须是空对象（不是 undefined）');
});

test('#314：getLoginInfoMap() 的**方括号**与 .get() 都要能用（上游 Rhino 的 java.util.Map 语义）', () => {
  const { ctx } = makeCtx({ loginInfo: new Map([['选择影视源站', '2-豪华资源']]) });
  const m = loginInfoMapForJs(ctx) as Record<string, unknown> & { get: (k: string) => unknown; size: () => number };
  // ① 方括号 —— 这是订阅源脚本的写法（语料 10 处），旧实现返回 JS Map 时**恒 undefined**
  assert.equal(m['选择影视源站'], '2-豪华资源', '方括号取键必须命中（旧实现这里恒 undefined）');
  // ② .get() —— 语料里 35 处这么写
  assert.equal(m.get('选择影视源站'), '2-豪华资源', '.get() 必须命中');
  assert.equal(m.size(), 1, 'size() 必须给键数（对齐 Java Map）');
  // ③ 对偶：Map 方法必须**非枚举**，否则 Object.keys(map) 会多出 get/put/size 等键
  assert.deepEqual(Object.keys(m), ['选择影视源站'], 'Object.keys 只能有真键（方法必须非枚举）');
});

test('#314：makeSourceLoginStub 的读写语义（putLoginInfo / removeLoginInfo / getLoginInfo）', () => {
  const { ctx } = makeCtx();
  const stub = makeSourceLoginStub(ctx) as {
    putLoginInfo: (v: unknown) => boolean;
    removeLoginInfo: () => void;
    getLoginInfo: () => string;
    getLoginInfoMap: () => Record<string, unknown>;
  };
  assert.equal(stub.putLoginInfo('{"a":"1"}'), true, '合法 JSON 对象必须写入成功');
  assert.equal(stub.putLoginInfo('[1,2]'), false, '数组不是合法登录信息（Legado 同义拒绝）');
  assert.equal(stub.putLoginInfo('not json'), false);
  assert.deepEqual(JSON.parse(stub.getLoginInfo()), { a: '1' }, 'getLoginInfo 必须回读到写入值');
  assert.equal(stub.getLoginInfoMap()['a'], '1');
  stub.removeLoginInfo();
  assert.deepEqual(JSON.parse(stub.getLoginInfo()), {}, 'removeLoginInfo 后必须是空对象');
});

test('#314：persistSourceLogin 空表也落盘（否则下次 prime 会把旧值"复活"）', async () => {
  const { ctx, store } = makeCtx({ variables: { __loginInfo: '{"a":"1"}' } });
  await persistSourceLogin(ctx);
  assert.equal(store.get('login-info:src-1'), '{"a":"1"}', '有值必须写');
  ctx.variables.set('__loginInfo', '{}');
  await persistSourceLogin(ctx);
  assert.equal(store.has('login-info:src-1'), false, '空表必须**删除**（写 {} 会让旧值复活）');
  // 登录头同款
  ctx.variables.set('__loginHeader', '{"X-Token":"t1"}');
  await persistSourceLogin(ctx);
  assert.equal(store.get('login-header:src-1'), '{"X-Token":"t1"}');
  ctx.variables.set('__loginHeader', '');
  await persistSourceLogin(ctx);
  assert.equal(store.has('login-header:src-1'), false);
});
