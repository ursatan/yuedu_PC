/**
 * `#553`：`bindings["source"]` 源桩的**唯一实现**（`core/source-stub.ts`）。
 *
 * 为什么锁这组：
 *  · 桩原先长在 `engine-legado/src/engine.ts` 里且**未导出** ⇒ `#551` 的试跑探针只好另写
 *    「字段快照 + 自补 getKey」半套。实测踩到 `source.getKey()` **静默返回空串**
 *    （`entityStub` 对取不到的方法回落成「调用返回 ''」的嵌套桩）。
 *  · 收敛后**唯一需要锁的**就是「探针与引擎真的是同一份」+ 三处有意隔离的副作用。
 *
 * 本文件锁四类：
 *  ① 桩面齐全且语义对（`getVariable()` 未设置回**空串**、`get/put` 与 `getVariable` 两套命名空间）
 *  ② 副作用隔离（`putConcurrent` 默认不碰限频表；`getHeaderMap()` 默认 `{}`）
 *  ③ **探针端到端**拿到的是真桩（`#551` 静默空串的反向锁）
 *  ④ 反例：不给 source 就不该凭空造桩
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSourceStub, SOURCE_KV_SLOT } from '../source-stub';
import { createVariableStore } from '../store';
import { concurrentRateState } from '../net/concurrent-rate';
import { probeField } from '../diag/probe';

const RAW = {
  bookSourceUrl: 'https://kv.test',
  bookSourceName: '测试源',
  bookSourceGroup: '分组A',
  bookSourceType: 0,
  loginUrl: 'https://kv.test/login',
  bookSourceComment: '一句注释',
  ruleSearch: { bookList: '.book' },
};

function mk(rule: Record<string, unknown> = RAW, opts?: Parameters<typeof makeSourceStub>[2]) {
  const variables = createVariableStore({});
  const stub = makeSourceStub({ variables }, rule, opts)!;
  return { stub, variables };
}

/* ---------------- ① 桩面与语义 ---------------- */

test('① 桩面齐全：字段归一 + BaseSource 方法都在（不再是可下钻空桩）', () => {
  const { stub } = mk();
  // 字段：这次是「归一化后的同名副本」，源脚本读 source.bookSourceUrl 不该拿到 undefined
  assert.equal(stub['bookSourceUrl'], 'https://kv.test');
  assert.equal(stub['bookSourceName'], '测试源');
  assert.equal(stub['bookSourceType'], 0);
  // 规则字段原样带进来（ruleSearch 等）
  assert.deepEqual(stub['ruleSearch'], { bookList: '.book' });
  // getKey：方法 + bean 属性两种写法（42 源用方法、26 源用属性）
  assert.equal(typeof stub['getKey'], 'function');
  assert.equal((stub['getKey'] as () => string)(), 'https://kv.test');
  assert.equal(stub['key'], 'https://kv.test');
  for (const m of [
    'getVariable',
    'setVariable',
    'get',
    'put',
    'getLoginInfoMap',
    'getLoginInfo',
    'getHeaderMap',
    'getComment',
    'hasLogin',
    'putConcurrent',
    'refreshExplore',
    'refreshJSLib',
  ]) {
    assert.equal(typeof stub[m], 'function', `缺方法 ${m}`);
  }
  assert.equal((stub['getComment'] as () => string)(), '一句注释');
  assert.equal((stub['hasLogin'] as () => boolean)(), true);
});

test('① getVariable() 未设置时必须是**空串**（不是 `{}`）—— 上游 BaseSource.kt:336', () => {
  const { stub } = mk();
  // 这条是 #148 的判据：返回 '{}' 会让 `JSON.parse` 成功 ⇒ 源脚本里的 catch 永不触发 ⇒
  // 回填逻辑跳过 url/name ⇒ 拼出 `undefined/albums`。必须保持空串。
  assert.equal((stub['getVariable'] as () => string)(), '');
  assert.equal(stub['variable'], '');
});

test('① get/put 与 getVariable/setVariable 是**两套互不相干的命名空间**', () => {
  const { stub, variables } = mk();
  (stub['put'] as (k: string, v: unknown) => string)('device', 'abc');
  assert.equal((stub['get'] as (k: string) => string)('device'), 'abc');
  // put 落的是 __sourceKV 槽，不碰 sourceVariable
  assert.notEqual(variables.get(SOURCE_KV_SLOT), undefined);
  assert.equal(variables.get('sourceVariable'), undefined);
  // 反向：setVariable 不写进 kv 槽
  (stub['setVariable'] as (v: unknown) => void)(JSON.stringify({ a: 1 }));
  assert.equal((stub['get'] as (k: string) => string)('a'), '');
  // 取不到 ⇒ 空串（不是 undefined，也不回退到源字段）
  assert.equal((stub['get'] as (k: string) => string)('nope'), '');
});

test('① put 返回写入值（语料 `return source.put(...)` 依赖）', () => {
  const { stub } = mk();
  assert.equal((stub['put'] as (k: string, v: unknown) => string)('k', 42), '42');
});

test('① getLoginInfoMap：方括号与 .get() 都能用（Rhino Java-Map 视图）', () => {
  const variables = createVariableStore({});
  const stub = makeSourceStub({ variables, loginInfo: new Map([['账号', 'u1']]) }, RAW)!;
  const m = (stub['getLoginInfoMap'] as () => Record<string, unknown>)();
  assert.equal(m['账号'], 'u1');
  assert.equal((m['get'] as (k: string) => unknown)('账号'), 'u1');
});

/* ---------------- ② 副作用隔离 ---------------- */

test('② putConcurrent 默认**不碰**本进程限频表（试跑不该顺手改限频）', () => {
  const { stub } = mk();
  assert.equal((stub['putConcurrent'] as (v: unknown) => boolean)('2/1000'), true);
  // 脚本视角与真跑一致（返回 true），但记录表没被写进去
  assert.equal(concurrentRateState('https://kv.test'), null);
});

test('② 注入 onPutConcurrent 后才真改（引擎走这条路）', () => {
  const calls: unknown[] = [];
  const { stub } = mk(RAW, { onPutConcurrent: (v) => calls.push(v) });
  (stub['putConcurrent'] as (v: unknown) => boolean)('3/2000');
  assert.deepEqual(calls, ['3/2000']);
});

test('② getHeaderMap 默认 `{}`（探针无源 header/登录头上下文）+ 注入后给真值', () => {
  assert.deepEqual((mk().stub['getHeaderMap'] as () => Record<string, string>)(), {});
  const s2 = mk(RAW, { sourceHeaders: () => ({ Referer: 'https://kv.test/' }) }).stub;
  assert.equal((s2['getHeaderMap'] as () => Record<string, string>)().Referer, 'https://kv.test/');
});

/* ---------------- ③ 探针端到端：真桩 ---------------- */

const HTML = '<div class="x">y</div>';

test('③ 探针里 source.getKey() 解出**真值**（`#551` 静默空串的反向锁）', async () => {
  const r = await probeField({ rule: '@js: source.getKey()', content: HTML, source: RAW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 'https://kv.test');
});

test('③ 探针里 source.getVariable() 是空串、source.variable 同值（不是 undefined/`{}`）', async () => {
  const a = await probeField({ rule: '@js: String(source.getVariable())', content: HTML, source: RAW });
  assert.equal(a.value, '');
  const b = await probeField({ rule: '@js: String(source.variable)', content: HTML, source: RAW });
  assert.equal(b.value, '');
});

test('③ 探针里 source.get(k) 读 `__sourceKV` 槽（与引擎同一落点）', async () => {
  const r = await probeField({
    rule: '@js: source.get("device")',
    content: HTML,
    source: RAW,
    vars: { [SOURCE_KV_SLOT]: JSON.stringify({ device: 'dev-1' }) },
  });
  assert.equal(r.value, 'dev-1');
});

test('③ 探针里字段绑定与源规则字段一致（source.bookSourceName / source.ruleSearch）', async () => {
  const r = await probeField({
    rule: '@js: source.bookSourceName + "|" + source.ruleSearch.bookList',
    content: HTML,
    source: RAW,
  });
  assert.equal(r.value, '测试源|.book');
});

test('③ 探针里 putConcurrent 也**不改**限频表（与桩的隔离一致）', async () => {
  const r = await probeField({ rule: '@js: String(source.putConcurrent("1/500"))', content: HTML, source: RAW });
  assert.equal(r.value, 'true');
  assert.equal(concurrentRateState('https://kv.test'), null);
});

/* ---------------- ④ 反例 ---------------- */

test('④ 不给 source ⇒ `source.getKey()` 只能得到空串，且必须**报成 EMPTY_CONTENT**（不静默当成功）', async () => {
  const r = await probeField({ rule: '@js: String(source.getKey())', content: HTML });
  assert.equal(r.value, '');
  // 关键：不是 ok:true —— 空结论要可见（否则用户会以为「这条规则解出空是源的问题」）
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EMPTY_CONTENT');
});

test('④ ★ 不能用 `typeof source.getKey` 判断「桩在不在」——两种情况都是 function', async () => {
  const without = await probeField({ rule: '@js: typeof source.getKey', content: HTML });
  const withs = await probeField({ rule: '@js: typeof source.getKey', content: HTML, source: RAW });
  // 两个都是 'function'（无 source 时 entityStub 给「可下钻空桩」，调用返回 ''）
  // ⇒ `#551` 那个静默空串 bug 之所以没被 type of 检查抓到，根源就在这里。
  assert.equal(without.value, 'function');
  assert.equal(withs.value, 'function');
  // 能区分的只有**值**：
  const a = await probeField({ rule: '@js: String(source.getKey())', content: HTML });
  const b = await probeField({ rule: '@js: String(source.getKey())', content: HTML, source: RAW });
  assert.equal(a.value, '');
  assert.equal(b.value, 'https://kv.test');
});

test('④ 桩不修改传入的原始源对象（快照语义，避免把方法写回语料）', () => {
  const raw: Record<string, unknown> = { bookSourceUrl: 'https://kv.test' };
  makeSourceStub({ variables: createVariableStore({}) }, raw);
  assert.deepEqual(Object.keys(raw), ['bookSourceUrl']);
});
