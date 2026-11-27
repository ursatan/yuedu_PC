/**
 * LoginUiV2 端到端（`loginUi = {"version":2}`）—— 对齐 Legado `BaseSource.evalLoginUiV2/
 * evalLoginActionV2` + `SourceLoginV2Delegate` 的完整流程：
 *   ① 形态识别  ② 初始渲染（`loginUi(state)`）  ③ 动作四命令（state/error/login/close）
 *   ④ `state` 回传后**重渲染**   ⑤ `login` 落盘 loginInfo   ⑥ 缺脚本 / 无效命令 / 未知键
 *
 * ⚠️ 语料 484 源精确 `{version:2}` **0 个** → 用合成源锁行为；出现真实源时再补真实验证。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import { classifyLoginUrl } from '../model/login';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://lgv2.test';

/** 源的登录脚本（loginUrl）：必须定义全局 `loginUi(state)` 与 `loginAction(action,state,form)` */
const V2_JS = `
function loginUi(state) {
  var extra = (state && state.step === 2) ? [{ name: '验证码', type: 'text', key: 'code' }] : [];
  return JSON.stringify({ rows: [
    { name: '账号', type: 'text', key: 'user' },
    { name: '密码', type: 'password', key: 'pass' },
    { name: '登录', type: 'button', action: 'doLogin', countdown: 3 }
  ].concat(extra) });
}
function loginAction(action, state, form) {
  if (action === 'doLogin') {
    if (!form.user) return JSON.stringify({ error: { user: '账号不能为空' } });
    return JSON.stringify({ login: { user: form.user, pass: form.pass }, state: { step: 2 } });
  }
  if (action === 'badCmd') return JSON.stringify({ state: 'x' });
  if (action === 'closeMe') return JSON.stringify({ close: true });
  if (action === 'unknownKey') return JSON.stringify({ foo: 1 });
  return JSON.stringify({});
}
`;

function makeCtx(): EngineContext {
  return {
    reqId: 'lgv2-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: {}, body: '<html></html>', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
    cookies: { get: () => '', set: () => undefined, remove: () => undefined, header: () => '' },
  };
}

function makeSrc(over: Record<string, unknown> = {}) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: 'V2 登录合成源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/1/' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.con@html' },
    loginUrl: V2_JS,
    loginUi: '{"version":2}',
    ...over,
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

test('① 形态识别：loginUi={"version":2} → kind=ui + uiV2，且不会被当成 URL/JSON 配置', () => {
  const plan = classifyLoginUrl(V2_JS, '{"version":2}');
  assert.equal(plan.kind, 'ui');
  assert.equal(plan.uiV2, true);
  assert.ok(plan.js.includes('function loginUi'), 'loginUrl 的脚本要原样带出');
  // 回归护栏：v2 若被当成「源阅 JSON 配置」会走「只打开页面」的错误路径
  assert.equal(classifyLoginUrl(V2_JS, '{"url":"https://x.test/login"}').uiV2, false);
});

test('② 初始渲染：loginUi(state) → rows 校验后回传，loginState 原样带回', async () => {
  const eng = new LegadoEngine();
  const res = await eng.login(makeSrc(), { action: 'login' }, makeCtx());
  assert.equal(res.ok, true);
  assert.equal(res.action, 'form');
  assert.equal(res.uiV2, true);
  assert.equal(res.loginState, '{}');
  assert.deepEqual(
    (res.fields ?? []).map((f) => `${f.type}:${f.name}`),
    ['text:账号', 'password:密码', 'button:登录'],
  );
  assert.equal(res.fields?.[2]?.countdown, 3, 'button 的 countdown 要透传（前端做倒计时）');
});

test('③ 动作：error 命令 → ok=false + fieldErrors（不重渲染）', async () => {
  const eng = new LegadoEngine();
  const res = await eng.login(
    makeSrc(),
    { action: 'login', loginAction: 'doLogin', loginForm: '{"user":"","pass":"p"}' },
    makeCtx(),
  );
  assert.equal(res.ok, false);
  assert.equal(res.action, 'server');
  assert.equal(res.fieldErrors?.user, '账号不能为空');
  assert.equal(res.fields, undefined, '无 state 命令时不重渲染');
});

test('④ 动作：login + state → 落盘 loginInfo 且按新 state 重渲染（多出「验证码」行）', async () => {
  const eng = new LegadoEngine();
  const ctx = makeCtx();
  const res = await eng.login(
    makeSrc(),
    { action: 'login', loginAction: 'doLogin', loginForm: '{"user":"alice","pass":"secret"}' },
    ctx,
  );
  assert.equal(res.ok, true, res.message);
  assert.equal(res.loginState, '{"step":2}', 'state 命令要原样回传（前端下次动作带上）');
  assert.equal(res.hasLoginInfo, true);
  assert.ok(
    (res.fields ?? []).some((f) => f.key === 'code' && f.name === '验证码'),
    '按 state 重渲染后应出现验证码行',
  );
  const saved = JSON.parse(String(ctx.variables.get('__loginInfo') ?? '{}')) as Record<string, string>;
  assert.equal(saved.user, 'alice');
  assert.equal(saved.pass, 'secret');
});

test('⑤ 无效命令 / close / 未知键', async () => {
  const eng = new LegadoEngine();
  const bad = await eng.login(makeSrc(), { action: 'login', loginAction: 'badCmd' }, makeCtx());
  assert.equal(bad.ok, false);
  assert.match(String(bad.message), /无效命令/);

  const closed = await eng.login(makeSrc(), { action: 'login', loginAction: 'closeMe' }, makeCtx());
  assert.equal(closed.ok, true);
  assert.equal(closed.close, true);

  const unknown = await eng.login(makeSrc(), { action: 'login', loginAction: 'unknownKey' }, makeCtx());
  assert.equal(unknown.ok, true, '未知命令按 Legado 记日志后忽略，不影响成功判定');
});

test('⑥ 缺 loginUrl 脚本 / 渲染格式错误：都要给明确文案（不得静默成空表单）', async () => {
  const eng = new LegadoEngine();
  const noJs = await eng.login(
    makeSrc({ loginUrl: '', loginUi: '{"version":2}' }),
    { action: 'login' },
    makeCtx(),
  );
  assert.equal(noJs.ok, false);
  assert.match(String(noJs.message), /缺少 loginUi\/loginAction 脚本/);

  const dupKey = `
function loginUi(state) { return JSON.stringify({ rows: [{ name: 'a', type: 'text', key: 'k' }, { name: 'b', type: 'text', key: 'k' }] }); }
function loginAction() { return '{}'; }
`;
  const broken = await eng.login(
    makeSrc({ loginUrl: dupKey }),
    { action: 'login' },
    makeCtx(),
  );
  assert.equal(broken.ok, false);
  assert.match(String(broken.message), /渲染结果格式错误/);
});
