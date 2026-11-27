/**
 * `#315` 登录执行流程共享件回归锁。
 * 背景：`loginPlanEarlyResult` / `loginFormGate` / `buildLoginScript` / `needBrowserFromError`
 * 此前在 engine-legado 与 engine-rss 各写一遍（needBrowser 正则抄了三处）——
 * 判据写两处必然漂移（`#247`）⇒ 收敛到 core 唯一实现，引擎只留真正不同的部分。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loginPlanEarlyResult,
  loginFormGate,
  buildLoginScript,
  needBrowserFromError,
  notAFunctionFromError,
} from '../login-flow';
import { classifyLoginUrl, parseLoginUiText, type LoginPlan } from '../login-model';

const plan = (overrides: Partial<LoginPlan>): LoginPlan => ({
  kind: 'js',
  url: '',
  js: '',
  needBrowser: false,
  uiIsScript: false,
  uiRaw: '',
  fields: [],
  ...overrides,
});

test('#315 形态早退：none ⇒ ok:false / action:none，名词进文案（源 vs 订阅源）', () => {
  const p = plan({ kind: 'none' });
  const a = loginPlanEarlyResult(p, '源');
  const b = loginPlanEarlyResult(p, '订阅源');
  assert.equal(a?.ok, false);
  assert.equal(a?.action, 'none');
  assert.match(a?.message ?? '', /该源未配置登录/);
  assert.match(b?.message ?? '', /该订阅源未配置登录/);
});

test('#315 形态早退：url / config-url ⇒ action:browser 带登录页地址（Cookie 自动保存文案两引擎同一条）', () => {
  for (const kind of ['url', 'config-url'] as const) {
    const r = loginPlanEarlyResult(plan({ kind, url: 'https://x.example/login.html' }), '源');
    assert.equal(r?.ok, false);
    assert.equal(r?.action, 'browser');
    assert.equal(r?.url, 'https://x.example/login.html');
    assert.match(r?.message ?? '', /Cookie 会自动保存/);
  }
});

test('#315 形态早退：js / ui ⇒ null（继续走引擎各自执行流程）', () => {
  assert.equal(loginPlanEarlyResult(plan({ kind: 'js' }), '源'), null);
  assert.equal(loginPlanEarlyResult(plan({ kind: 'ui' }), '源'), null);
});

test('#315 表单闸门：有输入行 + 未填写 + 非按钮动作 ⇒ 先要表单（必须带 fields，#347）', () => {
  const fields = [
    { name: 'u', type: 'text' as const },
    { name: 'p', type: 'password' as const },
  ];
  const r = loginFormGate(fields, { loginAction: '', hasLoginInfo: false });
  assert.equal(r?.ok, false);
  assert.equal(r?.action, 'form');
  assert.deepEqual(r?.fields, fields);
  assert.match(r?.message ?? '', /请先填写登录信息/);
});

test('#315 表单闸门放行三形态：已填写 / 按钮动作 / 无输入行 ⇒ null', () => {
  const fields = [{ name: 'u', type: 'text' as const }];
  assert.equal(loginFormGate(fields, { loginAction: '', hasLoginInfo: true }), null);
  assert.equal(loginFormGate(fields, { loginAction: 'someAction', hasLoginInfo: false }), null);
  const buttonOnly = [{ name: 'b', type: 'button' as const }];
  assert.equal(loginFormGate(buttonOnly, { loginAction: '', hasLoginInfo: false }), null);
});

test('#315 拼脚本：按钮动作 = loginJs + action；确定 = login.apply(this)，缺函数按上游报错', () => {
  assert.equal(buildLoginScript('JS', 'actA'), 'JS\nactA');
  const code = buildLoginScript('JS', '');
  assert.match(code, /if \(typeof login === 'function'\) \{ login\.apply\(this\); \}/);
  // 上游原句（Legado BaseSource）：没有 login 函数时的报错文案逐字保留
  assert.match(code, /Function login not implements!!!/);
});

test('#315 needBrowser：只看错误本身指向 WebView API（七猫案例：无关函数里的 startBrowser 不算）', () => {
  for (const msg of [
    'startBrowser is not defined',
    '调用 startBrowserAwait 失败',
    'TypeError: webView is null',
    'getVerificationCode not found',
    'openVideoPlayer undefined',
  ]) {
    assert.equal(needBrowserFromError(msg), true, msg);
  }
  // 真正报错是别的（startBrowser 只出现在无关函数里）⇒ 不误报
  assert.equal(needBrowserFromError('this.setcsh is not a function'), false);
  assert.equal(needBrowserFromError(''), false);
});

test('#315 notAFunction：脚本引用未提供函数的定性（7 猫真实报错形态）', () => {
  assert.equal(notAFunctionFromError('this.setcsh is not a function'), true);
  assert.equal(notAFunctionFromError('undefined is not a function'), true);
  assert.equal(notAFunctionFromError('not implemented'), true);
  assert.equal(notAFunctionFromError('network timeout'), false);
});

test('#315 对偶：classifyLoginUrl 产出的 plan 直接喂早退 —— 三形态判据与执行流程共享件不漂移', () => {
  // 空 loginUrl/loginUi ⇒ none；纯 URL ⇒ url —— 判据在 core login-model，早退在 core login-flow
  const nonePlan = classifyLoginUrl(undefined, undefined);
  assert.equal(nonePlan.kind, 'none');
  assert.equal(loginPlanEarlyResult(nonePlan, '源')?.action, 'none');
  const urlPlan = classifyLoginUrl('https://x.example/login');
  assert.equal(urlPlan.kind, 'url');
  assert.equal(loginPlanEarlyResult(urlPlan, '源')?.action, 'browser');
});

/**
 * `#411`：`loginUi` 行的解析必须是 **GSON 宽松口径**（`parseJsonLoose`），不是 JS eval。
 *
 * 实测 18AV（`tmp/src-18AV.json`）：`loginUi` 是 `` @js: `[...]` ``，求值后是一段对象字面量文本，
 * 里头有 `"layout_wrapBefore": flase`（作者笔误，**裸标识符**）与 `chars:['默认','阅读','外部']`
 * （单引号）——旧的 `new Function('return (' + t + ')')` 对前者抛 ReferenceError ⇒ 整段返回 `[]`
 * ⇒ **登录界面空白**（App 里 GSON 宽松把它当字符串 `"flase"`，所以作者那边是好的）。
 */
test('#411 loginUi 行：裸标识符（flase）与单引号必须按 GSON 宽松解析（18AV 实测形态）', () => {
  const text = `[
    { name: "网址", type: "text" },
    { name: "ArtPlayer V5.4.0", type: "button", action: "bfq()",
      style: { "layout_flexGrow": 1, "layout_flexBasisPercent": 0.4, "layout_wrapBefore": true } },
    { name: "播放器", type: "select", chars:['默认','阅读','外部'], default:"默认",
      style: { "layout_wrapBefore": flase } },
    { name: "双击⏭️时间", type: "select", chars:[5,10,15], default: "10" },
  ]`;
  const fields = parseLoginUiText(text);
  assert.equal(fields.length, 4, '整段不能被一个笔误打成空（旧实现 return []）');
  assert.deepEqual(fields.map((f) => f.type), ['text', 'button', 'select', 'select']);
  assert.equal(fields[1]!.action, 'bfq()', 'button 的 action 要带出来');
  assert.deepEqual(fields[2]!.chars, ['默认', '阅读', '外部'], '单引号字符串');
  assert.deepEqual(fields[3]!.chars, ['5', '10', '15'], '数字 chars 归一成字符串');
  assert.equal(fields[1]!.style?.flexBasisPercent, 0.4, 'style.layout_* 归一');
});
