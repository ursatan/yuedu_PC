/**
 * `#467` 源 header 规则求值唯一实现的回归锁。
 *
 * 判据（对齐 Legado `BaseSource.getHeaderMap`）：
 * `extractInlineJs(header)?.let { evalJS(it) } ?: header` → 对象解析 → Record<string,string>；
 * 任何失败/非对象 ⇒ 空头且**不阻断请求**（上游 runCatching）。
 *
 * 这一份是「两引擎 + /api/proxy 共用」的根锁：engine-rss `source-header.test.ts`、
 * engine-legado `ajax-source-headers.test.ts` 只锁各侧接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSourceHeaderResolver,
  createVariableStore,
  evaluateSourceHeaderRule,
  evaluateSourceHeaderRuleAsync,
  isScriptSourceHeader,
  parseStaticSourceHeader,
  readSourceHeaderMemo,
} from '../index';

test('静态 JSON：对象通过；数组/标量/畸形/脚本形态一律 null', () => {
  assert.deepEqual(parseStaticSourceHeader('{"A":"1","B":2}'), { A: '1', B: '2' });
  assert.equal(parseStaticSourceHeader('[{"A":1}]'), null);
  assert.equal(parseStaticSourceHeader('"hello"'), null);
  assert.equal(parseStaticSourceHeader('{bad json'), null);
  assert.equal(parseStaticSourceHeader('@js:({})'), null);
  assert.equal(parseStaticSourceHeader('<JS>{"a":1}</JS>'), null, '大写脚本包裹也必须识别为脚本形态');
  assert.deepEqual(parseStaticSourceHeader('  '), null);
});

test('脚本形态识别：@js: / <js></js>，大小写不敏感', () => {
  assert.equal(isScriptSourceHeader('@js:x'), true);
  assert.equal(isScriptSourceHeader('<js>x</js>'), true);
  assert.equal(isScriptSourceHeader('<JS>x</JS>'), true);
  assert.equal(isScriptSourceHeader('{"a":1}'), false);
  assert.equal(isScriptSourceHeader(''), false);
});

test('evaluate：静态对象直通', () => {
  assert.deepEqual(evaluateSourceHeaderRule({ raw: '{"X":1}' }), { X: '1' });
});

test('evaluate：@js 返回对象 / JSON 字符串都归一', () => {
  assert.deepEqual(evaluateSourceHeaderRule({ raw: '@js:({A:1})', evalJs: () => ({ A: 1, B: null }) }), { A: '1' });
  assert.deepEqual(evaluateSourceHeaderRule({ raw: '<js>JSON.stringify({"A":"x"})</js>', evalJs: () => '{"A":"x"}' }), { A: 'x' });
});

test('evaluate：抛错 ⇒ {} + eval 留痕（带 cause），不抛出', () => {
  const warns: Array<[string, string, unknown]> = [];
  const boom = new Error('boom');
  const out = evaluateSourceHeaderRule({
    raw: '@js:throw new Error("boom")',
    evalJs: () => { throw boom; },
    warn: (c, m, cause) => warns.push([c, m, cause]),
  });
  assert.deepEqual(out, {});
  assert.equal(warns[0]?.[0], 'eval');
  assert.match(warns[0]?.[1] ?? '', /boom/);
  assert.equal(warns[0]?.[2], boom);
});

test('evaluate：无求值器的脚本 ⇒ {} + eval 留痕；返回非对象 ⇒ shape 留痕；静态畸形 ⇒ static 留痕', () => {
  const ch: string[] = [];
  assert.deepEqual(evaluateSourceHeaderRule({ raw: '@js:1', warn: (c) => ch.push(c) }), {});
  assert.deepEqual(evaluateSourceHeaderRule({ raw: '@js:1', evalJs: () => [1, 2], warn: (c) => ch.push(c) }), {});
  assert.deepEqual(evaluateSourceHeaderRule({ raw: '{bad', warn: (c) => ch.push(c) }), {});
  assert.deepEqual(ch, ['eval', 'shape', 'static']);
});

test('evaluateAsync：await 求值器的 Promise 结果', async () => {
  const out = await evaluateSourceHeaderRuleAsync({
    raw: '@js:1',
    evalJs: async () => ({ Q: 'v' }),
  });
  assert.deepEqual(out, { Q: 'v' });
  const fromString = await evaluateSourceHeaderRuleAsync({
    raw: '@js:1',
    evalJs: async () => '{"Q":"w"}',
  });
  assert.deepEqual(fromString, { Q: 'w' });
});

test('resolver：每请求只求值一次（memo 落 variables）', () => {
  const variables = createVariableStore();
  let calls = 0;
  const r = createSourceHeaderResolver({
    variables,
    getRaw: () => '@js:({A:"1"})',
    evalJs: () => { calls += 1; return { A: '1' }; },
  });
  assert.deepEqual(r.get(), { A: '1' });
  assert.deepEqual(r.get(), { A: '1' });
  assert.equal(calls, 1);
  assert.equal(r.hasMemo(), true);
  assert.deepEqual(readSourceHeaderMemo(variables), { A: '1' });
});

test('resolver：防重入 —— header 脚本内部再取头 ⇒ 空头而不是无限递归', () => {
  const variables = createVariableStore();
  const r = createSourceHeaderResolver({
    variables,
    getRaw: () => '@js:1',
    evalJs: () => r.get(),
  });
  assert.deepEqual(r.get(), {});
});

test('resolver：readStatic 绝不跑脚本（无 memo ⇒ 空），memo 写入后立刻可见', () => {
  const variables = createVariableStore();
  let evalCalls = 0;
  const r = createSourceHeaderResolver({
    variables,
    getRaw: () => '@js:1',
    evalJs: () => { evalCalls += 1; return { X: '1' }; },
  });
  assert.deepEqual(r.readStatic(), {});
  assert.equal(evalCalls, 0, '同步出口不允许触发脚本求值（防 java.ajax 递归）');
  variables.set('__srcHeaders', JSON.stringify({ X: '1' }));
  assert.deepEqual(r.readStatic(), { X: '1' });
});

test('resolver：静态 JSON 形态 readStatic 直接解析（无 memo 也给头）', () => {
  const variables = createVariableStore();
  const r = createSourceHeaderResolver({
    variables,
    getRaw: () => '{"X":"static"}',
    evalJs: () => { throw new Error('不该被调用'); },
  });
  assert.deepEqual(r.readStatic(), { X: 'static' });
});

test('resolver.prime：worker 池异步求值落 memo；之后 get 不再调同步求值器', async () => {
  const variables = createVariableStore();
  let syncCalls = 0;
  let asyncCalls = 0;
  const r = createSourceHeaderResolver({
    variables,
    getRaw: () => '@js:1',
    evalJs: () => { syncCalls += 1; return { SYNC: '1' }; },
  });
  await r.prime(async () => { asyncCalls += 1; return { ASYNC: '1' }; });
  assert.equal(asyncCalls, 1);
  assert.deepEqual(r.get(), { ASYNC: '1' });
  assert.equal(syncCalls, 0, 'prime 落地后同步安全网不应被触发');
});

test('resolver.prime：失败也落空头 memo（同请求不重试）；静态形态不调求值器', async () => {
  const variables = createVariableStore();
  let asyncCalls = 0;
  const r = createSourceHeaderResolver({
    variables,
    getRaw: () => '@js:1',
    evalJs: () => ({ S: '1' }),
    warn: () => { /* 留痕在引擎侧测 */ },
  });
  await r.prime(async () => { asyncCalls += 1; throw new Error('x'); });
  assert.equal(asyncCalls, 1);
  assert.deepEqual(r.get(), {}, '失败后 get 命中空头 memo，不再走同步求值');

  const variables2 = createVariableStore();
  let touched = false;
  const r2 = createSourceHeaderResolver({
    variables: variables2,
    getRaw: () => '{"J":1}',
    evalJs: () => { touched = true; return {}; },
  });
  assert.deepEqual(await r2.prime(async () => { touched = true; return {}; }), { J: '1' });
  assert.equal(touched, false, '静态形态 prime 不碰求值器');
});
