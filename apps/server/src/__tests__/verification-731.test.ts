/**
 * `#731` 验证窗「无标题 / 不导航 / 会话被提前判死」的回归锁（纯逻辑 + 源码层，秒级）。
 *
 * 用户实测（纯 Web + server，无桌面端）：
 *  · 服务端拉起 Chromium 后窗口一直【无标题】，页面没打开站点；
 *  · 浮层先「正在拉起验证浏览器…」再「验证会话已结束或浏览器不可用」。
 *
 * 三条可证缺陷（都在 `verification.ts` / `browser-session.ts`）：
 *  ① `live.session` 在 `attachPageSession` **之后**才赋值 ⇒ attach 失败时没人收掉新进程（留下空窗）；
 *  ② `mark('ready')` 不等 `document.readyState` ⇒ 慢机把 about:blank 当已就绪；
 *  ③ `startScreencast` 超时被计入 CDP 连续失败 ⇒ 慢机把活着的浏览器判死并结束会话。
 *  ④ `render()` 无会话直接返回空串 ⇒ `startBrowserAwait` 静默失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDocReady } from '../verification';

const VERIFY = readFileSync(join(process.cwd(), 'src/verification.ts'), 'utf8');
const SESSION = readFileSync(join(process.cwd(), 'src/browser-session.ts'), 'utf8');

test('#731 ① 页面就绪判据：about:blank / 空 URL / loading 一律不算', () => {
  assert.equal(isDocReady({ url: 'about:blank', readyState: 'complete' }), false, 'about:blank 不算页面到了');
  assert.equal(isDocReady({ url: '', readyState: 'interactive' }), false);
  assert.equal(isDocReady({ url: 'chrome://newtab/', readyState: 'complete' }), false);
  assert.equal(isDocReady({ url: 'https://www.asianfanfics.com/', readyState: 'loading' }), false);
  assert.equal(isDocReady({ url: 'https://www.asianfanfics.com/', readyState: 'interactive' }), true);
  assert.equal(isDocReady({ url: 'https://www.asianfanfics.com/', readyState: 'complete' }), true);
});

test('#731 ② 会话引用必须在 attach 之前登记（否则 attach 失败留下空窗）', () => {
  const boot = VERIFY.slice(VERIFY.indexOf('async function bootInto'));
  const acquire = boot.indexOf('await acquire(');
  const assigned = boot.indexOf('live.session = session');
  const attach = boot.indexOf('await attachPageSession(');
  assert.ok(acquire > 0 && assigned > 0 && attach > 0, '三处都必须存在');
  assert.ok(assigned > acquire, '会话赋值要在 acquire 之后');
  assert.ok(assigned < attach, '会话赋值必须在 attachPageSession 之前（#731 根因）');
  assert.match(boot, /live\.bootReused = reused;\s*\n\s*live\.ua = opts\.ua;/, 'bootReused 也必须同步早登记');
});

test('#731 ③ mark(ready) 前必须等 document.readyState（不能再直接置就绪）', () => {
  const boot = VERIFY.slice(VERIFY.indexOf('async function bootInto'));
  const wait = boot.indexOf('await waitDocReady(');
  // 注释里也提到 `mark('ready')` ⇒ 取**最后一次**（真正的调用在 waitDocReady 之后）
  const ready = boot.lastIndexOf("mark('ready')");
  assert.ok(wait > 0, '必须有 waitDocReady');
  assert.ok(ready > wait, 'mark(ready) 必须在页面就绪之后');
  assert.match(boot, /readyState=\$\{st\.readyState\}/, '就绪日志必须带 readyState');
  assert.match(boot, /标题=\$\{st\.title \|\| '(\(空\))'\}/, '就绪日志必须带标题（排查「无标题」）');
  assert.match(boot, /Page\.navigate 返回错误/, 'Page.navigate 的 errorText 必须留痕');
  assert.match(boot, /logTargets\(live, 'attach'\)/, 'attach 后要打印 target 列表');
  assert.match(boot, /logTargets\(live, 'ready'\)/, '就绪后要打印 target 列表');
});

test('#731 ④ 录屏超时不再计入「CDP 连续失败」（慢机不能因此被结束会话）', () => {
  const casting = VERIFY.slice(VERIFY.indexOf('async function setCasting'), VERIFY.indexOf('function startProbe'));
  const catchIdx = casting.lastIndexOf('} catch (e) {');
  const tail = casting.slice(catchIdx);
  assert.doesNotMatch(tail, /noteCdpResult\(live, false\)/, 'startScreencast 失败不得判死');
  assert.match(tail, /不影响会话存活/, '失败日志要说明「不影响会话存活」');
});

test('#731 ⑤ UA 同源：验证会话接收 ua / acceptLanguage 并注入', () => {
  assert.match(VERIFY, /export async function openVerification\(opts: \{[^}]*ua\?: string;/s, 'openVerification 要接收源 UA');
  const boot = VERIFY.slice(VERIFY.indexOf('async function bootInto'));
  assert.match(boot, /Emulation\.setUserAgentOverride/, '必须用 CDP 覆盖 UA');
  assert.match(boot, /Net\.?work\.setExtraHTTPHeaders/, 'Accept-Language 要与引擎对齐');
  assert.match(boot, /已让引擎跟随浏览器 UA/, '源未声明 UA 时要反向登记浏览器 UA');
});

test('#731 ⑥ render 无会话必须按需创建；建不出/中途死亡要抛明确错误', () => {
  const render = SESSION.slice(SESSION.indexOf('export async function render(url'), SESSION.indexOf('export', SESSION.indexOf('export async function render(url') + 10));
  assert.match(render, /if \(!s && opts\.ensureSession\)/, '无会话 + ensureSession 走创建');
  assert.match(render, /await acquire\(key, \{/, '必须 acquire 该源会话');
  assert.match(render, /无法创建验证会话：/, '创建失败要抛明确错误（不许空串）');
  assert.match(render, /验证会话已结束：/, '中途死亡要报「会话已结束」');
  assert.match(render, /if \(!html && opts\.ensureSession\)\s*\{?\s*throw new Error\(`验证会话已取到空页面/, '空壳/挑战页也不许拿空串冒充成功');
  // 顺序：ensureSession 分支必须在「无会话直接返回空串」之前（否则永远走不到创建）
  const ensure = render.indexOf('if (!s && opts.ensureSession)');
  const empty = render.indexOf("if (!s) return '';");
  assert.ok(ensure > 0 && empty > 0 && ensure < empty, 'ensureSession 分支必须在空串兜底之前');
  // 明确分类的错误不得被二次包装成「会话已结束」
  assert.match(render, /无法创建验证会话\|验证会话已取到空页面\|验证会话已结束/);
});

test('#731 ⑦ UA 注入失败要重试并在两次失败后报错；复用实例 attach 过慢要重建', () => {
  const boot = VERIFY.slice(VERIFY.indexOf('async function bootInto'));
  // 用户 3000 日志：Emulation.setUserAgentOverride 超时后仍打印「已对齐」⇒ 指纹其实没对上
  assert.match(boot, /for \(let i = 0; i < 2 && !uaOk; i \+= 1\)/, 'UA 注入必须重试一次');
  assert.match(boot, /无法对齐验证会话 UA：/, '两次都失败要抛明确错误（不许静默继续）');
  assert.match(boot, /reused && attachMs > ATTACH_SLOW_MS/, '复用实例 attach 过慢要判半死');
  assert.match(boot, /重建会话/, '过慢必须重建，不在半死实例上继续');
  const attachCalls = boot.match(/await attachPageSession\(/g) ?? [];
  assert.ok(attachCalls.length >= 2, '重建后必须重新 attach（首次 + 重建各一次）');
});
