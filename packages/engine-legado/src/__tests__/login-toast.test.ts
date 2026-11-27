/**
 * 登录 UI 按钮的 toast 反馈（对齐 Legado `java.toast` / `java.longToast`）。
 *
 * 背景（用户上报）：禁漫天堂登录对话框里「切换分流线路」「切换国际线路」等按钮点击后
 * **毫无提示**。原因是这些按钮的动作只调 `log(...)` → `java.longToast(...)`，既不改 Cookie
 * 也不改登录头；服务端早期把 toast 静默丢弃 → 前端拿不到任何反馈。
 *
 * 本测试锁住三件事：
 *  1. `java.toast` / `java.longToast` 的文本按序收集进 `result.toasts`；
 *  2. 按钮动作（loginAction）跑通即视为成功（不再误报「登录态与登录前一致」）；
 *  3. 无 toast 时 `toasts` 字段不下发（避免前端弹空 toast）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegadoEngine } from '../index';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
} from '@yuedu/core';

const noopSandbox: JsSandboxPool = { async eval() { throw new Error('no sandbox'); } };
const noopHttp: HttpClient = { async request() { throw new Error('no network in test'); } };

function makeCtx(): EngineContext {
  return {
    reqId: 't', sourceId: 'src', signal: new AbortController().signal,
    http: noopHttp, sandbox: noopSandbox, trace: createTraceSink(),
    variables: createVariableStore(), storage: createMemoryKeyValueStore(),
  };
}

const engine = new LegadoEngine();

/** 复刻禁漫天堂的形态：loginUi 按钮面板 + loginUrl 脚本（按钮动作只弹 toast） */
function makeBtnSrc(): NonNullable<ReturnType<typeof engine.compile>['rule']> {
  const out = engine.compile({
    bookSourceUrl: 'https://btn.test',
    bookSourceName: '按钮源',
    bookSourceType: 0,
    searchUrl: 'https://btn.test/s?q={{key}}',
    loginUi: JSON.stringify([
      { name: '账号', type: 'text' },
      { name: '密码', type: 'password' },
      { name: '切换分流线路(1-4)', type: 'button', action: 'toggleShunt()' },
      { name: '关闭', type: 'button', action: 'goBlank()' },
    ]),
    loginUrl: [
      'function log(m) { java.longToast(m); }',
      'function toggleShunt() { log("【分流切换提示】已切换分流: 1 -> 2，请刷新探索页"); }',
      'function goBlank() { }',
      'function login() { java.put("done", "1"); }',
    ].join('\n'),
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
  });
  assert.ok(out.ok && out.rule, 'compile 应通过');
  return out.rule!;
}

test('登录按钮：java.longToast 的文本收集进 result.toasts', async () => {
  const r = await engine.login(makeBtnSrc(), { action: 'detail', loginAction: 'toggleShunt()' } as never, makeCtx());
  assert.deepEqual(r.toasts, ['【分流切换提示】已切换分流: 1 -> 2，请刷新探索页']);
});

test('登录按钮：动作跑通即成功（不再误报「登录态与登录前一致」）', async () => {
  const r = await engine.login(makeBtnSrc(), { action: 'detail', loginAction: 'toggleShunt()' } as never, makeCtx());
  assert.equal(r.ok, true);
  assert.equal(r.action, 'server');
  assert.equal(r.message, '【分流切换提示】已切换分流: 1 -> 2，请刷新探索页', 'message 回退为最后一条 toast');
});

test('登录按钮：java.toast（短）也收集，顺序与调用一致', async () => {
  const out = engine.compile({
    bookSourceUrl: 'https://btn2.test',
    bookSourceName: '按钮源2',
    searchUrl: 'https://btn2.test/s?q={{key}}',
    loginUrl: 'function two() { java.toast("第一"); java.longToast("第二"); }',
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
  });
  assert.ok(out.ok && out.rule);
  const r = await engine.login(out.rule!, { action: 'detail', loginAction: 'two()' } as never, makeCtx());
  assert.deepEqual(r.toasts, ['第一', '第二']);
});

test('登录按钮：没有 toast 时不下发 toasts 字段', async () => {
  const r = await engine.login(makeBtnSrc(), { action: 'detail', loginAction: 'goBlank()' } as never, makeCtx());
  assert.equal(r.toasts, undefined);
  assert.equal(r.ok, true);
});
