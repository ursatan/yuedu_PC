/**
 * 常驻浏览器会话的**纯逻辑回归锁**（不起浏览器，秒级）。
 *
 * 锁两件事：
 *  ① `sessionKeyOf`：源身份 → 会话键（无源身份必须落到 `anon`，否则登录态与匿名渲染会互相串）；
 *  ② `profileDirForKey`：`'src:<id>'` 必须仍落到 `<id>` 的**同一个 profile 目录** ——
 *     这是磁盘兼容性的硬约束（改了就等于让所有老用户重登一次）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserProfileDir, profileDirForKey, sessionKeyOf, navGuardEnabled, navHostOf, installNavGuard, browserContextEnabled, setBrowserContextMode, type BrowserSession } from '../browser-session';

const SRC = readFileSync(join(process.cwd(), 'src/browser-session.ts'), 'utf8');

test('会话键：有源身份用 src:<id>，无源身份落 anon', () => {
  assert.equal(sessionKeyOf('abc'), 'src:abc');
  assert.equal(sessionKeyOf(''), 'anon');
  assert.equal(sessionKeyOf(undefined), 'anon');
  assert.equal(sessionKeyOf('   '), 'anon');
  // 空白要 trim 掉（否则 `src: abc` 与 `src:abc` 会被当成两个会话）
  assert.equal(sessionKeyOf(' abc '), 'src:abc');
});

test('会话键 → profile 目录：与既有磁盘 profile 保持同一个目录（不重登）', () => {
  assert.equal(profileDirForKey('src:abc'), browserProfileDir('abc'));
  assert.equal(profileDirForKey('anon'), browserProfileDir('anon'));
  // 以 `src:` 开头的**源号本身**不能被再切一刀（只切一层前缀）
  assert.equal(profileDirForKey('src:src:x'), browserProfileDir('src:x'));
});

test('profile 目录名做了字符白名单（分隔符 / 冒号不会逃出目录层级）', () => {
  assert.equal(browserProfileDir('a/b'), browserProfileDir('a_b'));
  assert.equal(browserProfileDir('a:b'), browserProfileDir('a_b'));
});

/* ---------------------------------- `#459` ----------------------------------
 * 两条硬约束在**源码层**锁住（真起浏览器只能证「能跑」，证不了「不会抢用户的 tab」）。
 * 用户原话（2026-10-14）：「长时间不加载，服务状态卡离线，一段时间后恢复在线」。
 */
test('#459 渲染走自己的 tab，不碰登录窗的 pageTargetId', () => {
  assert.match(SRC, /renderTargetId\?: string/, '必须有渲染专用 target 字段');
  // 渲染入口**不许**出现 `pickPageTarget(` 调用（它会把用户的 tab 认领走）
  const render = SRC.slice(SRC.indexOf('async function renderInSession'));
  assert.doesNotMatch(render, /await pickPageTarget\(/, 'renderInSession 不得复用/认领用户的 tab');
  assert.match(render, /createRenderTarget\(s, cdp, url,/, '必须为渲染新建自己的 tab');
  assert.match(render, /await closeRenderTarget\(\);/, '渲染结束（含超时）必须关掉该 tab');
  // 认领已有标签时也要排除渲染 tab（否则登录窗会把渲染 tab 当自己的）
  assert.match(SRC, /t\.targetId !== s\.renderTargetId/, 'pickPageTarget 必须排除 renderTargetId');
  assert.match(SRC, /t\.targetId !== s\.renderTargetId && \/\^about:blank\$\/i/, 'closeBlankTabs 不得收走渲染 tab');
});

test('#459 渲染有调用方预算：到点返回空串并回落（不再挂 25s）', () => {
  assert.match(SRC, /const RENDER_BUDGET_MS = 8_000;/, '预算必须是显式常量（旧值 25s 无上限）');
  assert.doesNotMatch(SRC, /RENDER_TIMEOUT_MS/, '旧的 25s 渲染上限必须消失');
  assert.match(SRC, /timeoutMs\?: number;/, 'SessionRenderOptions 必须让调用方给时限');
  // 整个渲染（连 CDP 命令）都在 race 里 —— 否则卡在读 DOM 那一步照样超预算
  assert.match(SRC, /Promise\.race\(\[run\(\), guard\]\)/, '必须整段 race，而不是只给 waitForLoad 设时限');
  assert.match(SRC, /waitForLoad\(cdp, sid, Math\.max\(1000, deadline - Date\.now\(\)\)\)/, 'waitForLoad 受同一 deadline 约束');
  assert.match(SRC, /Math\.min\(opts\.delayMs, Math\.max\(0, deadline - Date\.now\(\)\)\)/, 'delayMs 也受预算约束');
});

/* ------------------------------ 2026-10-15 开窗失败 ------------------------------
 * 用户实测：「登录界面点【打开登录窗口】提示打开登录窗口失败，多次尝试可打开」。
 * 真因＝同一会话键上的 `acquire` 并发（登录窗与同键渲染会话共用一个 profile）⇒ 双双 spawn
 * 同一个 `--user-data-dir`，被 Chromium 的 profile 单例锁顶掉 ⇒ 调试端口 20s 不就绪。
 * 只能靠源码层锁（真起浏览器的测试只能证「能开」，证不了「并发不会两个进程抢 profile」）。
 */
test('开窗失败：同键 acquire 必须串行，且 spawn 失败要复查一次', () => {
  assert.match(SRC, /const acquireLocks = new Map<string, Promise<unknown>>\(\);/,
    '必须有按会话键的串行锁（否则并发 spawn 抢同一 profile）');
  // 真实实现搬进 acquireLocked，acquire 只剩串行壳
  assert.match(SRC, /async function acquireLocked\(key: string, opts: AcquireOptions = \{\}\)/,
    'acquire 必须只做串行 + 委托');
  const acquireFn = SRC.slice(SRC.indexOf('export async function acquire('), SRC.indexOf('async function acquireLocked('));
  assert.doesNotMatch(acquireFn, /spawnBrowser\(/, 'acquire 本身不得直接 spawn（必须走 acquireLocked）');
  assert.match(SRC, /const again = await getSession\(key\);\s*\n\s*if \(!again\) throw e;/,
    'spawn 失败必须复查一次会话（别人已拉起来就直接复用）');
});

/* ---------------------------------- `#465` 跳转拦截 ---------------------------------- */

test('#465 开关矩阵：缺省只护无头非 pin；env 可强制全开/全关', () => {
  const mk = (headless: boolean, pinned: boolean): BrowserSession =>
    ({ key: 'k', url: 'https://a.com/', headless, pinned, startedAt: 0, lastUsedAt: 0 } as unknown as BrowserSession);
  const prev = process.env.YUEDU_NAV_GUARD;
  try {
    delete process.env.YUEDU_NAV_GUARD;
    assert.equal(navGuardEnabled(mk(true, false)), true, '无头渲染会话默认要护');
    assert.equal(navGuardEnabled(mk(true, true)), false, 'pin 住的（登录窗）不拦');
    assert.equal(navGuardEnabled(mk(false, false)), false, '有头非 pin 也不拦（可能是用户在看的）');
    process.env.YUEDU_NAV_GUARD = '1';
    assert.equal(navGuardEnabled(mk(false, true)), true, '=1 强制全会话拦');
    process.env.YUEDU_NAV_GUARD = '0';
    assert.equal(navGuardEnabled(mk(true, false)), false, '=0 全关');
  } finally {
    if (prev === undefined) delete process.env.YUEDU_NAV_GUARD;
    else process.env.YUEDU_NAV_GUARD = prev;
  }
});

test('#465 主机判据：忽略 scheme/port/userinfo，取不到主机名返回空（空=放行）', () => {
  assert.equal(navHostOf('https://www.Example.com:8080/a?b=1'), 'www.example.com');
  assert.equal(navHostOf('http://u:p@sub.host.cn/x'), 'sub.host.cn');
  assert.equal(navHostOf('about:blank'), '');
  assert.equal(navHostOf(''), '');
  assert.equal(navHostOf(undefined), '');
  // 判据是主机名：http→https 同站跳转**不**算跨主机（不会误拦）
  assert.equal(navHostOf('https://a.com/x'), navHostOf('http://a.com:80/x'));
});

test('#465 拦截决策：跨主机顶栏拦、同主机放、iframe 放、非 Document 放、弹窗跨主机关', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown>; sid?: string }> = [];
  const handlers = new Map<string, Array<(p: unknown, sid?: string) => void>>();
  const fake = {
    send: (method: string, params: Record<string, unknown> = {}, sid?: string) => {
      sent.push({ method, params, ...(sid ? { sid } : {}) });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'MAIN' } } });
      return Promise.resolve({});
    },
    subscribe: (method: string, cb: (p: unknown, sid?: string) => void) => {
      const arr = handlers.get(method) ?? [];
      arr.push(cb);
      handlers.set(method, arr);
      return () => undefined;
    },
  };
  const s = { key: 'k', url: 'https://src.com/book/1', headless: true, pinned: false, startedAt: 0, lastUsedAt: 0 } as unknown as BrowserSession;
  await installNavGuard(s, fake as never, 'SID1');

  // Fetch.enable 只暂停 Document
  const fe = sent.find((x) => x.method === 'Fetch.enable');
  assert.ok(fe, '必须启用 Fetch');
  assert.deepEqual((fe!.params as { patterns: Array<{ resourceType: string }> }).patterns[0]!.resourceType, 'Document', '只拦文档导航');
  assert.equal(fe!.sid, 'SID1', 'Fetch 必须开在页面会话上');

  const fire = (method: string, params: unknown, sid: string | undefined): void => {
    for (const cb of handlers.get(method) ?? []) cb(params, sid);
  };
  const failOrContinue = (): { method: string; errorReason?: string } => {
    const last = sent.filter((x) => x.method === 'Fetch.failRequest' || x.method === 'Fetch.continueRequest').pop();
    return { method: last!.method, errorReason: (last!.params as { errorReason?: string }).errorReason };
  };

  // ① 跨主机顶栏导航 ⇒ 拦
  fire('Fetch.requestPaused', { requestId: 'r1', resourceType: 'Document', frameId: 'MAIN', request: { url: 'https://evil.com/x' } }, 'SID1');
  assert.deepEqual(failOrContinue(), { method: 'Fetch.failRequest', errorReason: 'BlockedByClient' }, '跨主机顶栏导航必须拦');
  // ② 同主机导航 ⇒ 放
  fire('Fetch.requestPaused', { requestId: 'r2', resourceType: 'Document', frameId: 'MAIN', request: { url: 'https://src.com/book/2' } }, 'SID1');
  assert.equal(failOrContinue().method, 'Fetch.continueRequest', '同主机导航必须放');
  // ③ 跨主机 **iframe** ⇒ 放（跨域嵌入是常态）
  fire('Fetch.requestPaused', { requestId: 'r3', resourceType: 'Document', frameId: 'IFRAME', request: { url: 'https://ads.com/x' } }, 'SID1');
  assert.equal(failOrContinue().method, 'Fetch.continueRequest', 'iframe 的文档请求不拦');
  // ④ 非 Document（XHR/媒体）⇒ 放
  fire('Fetch.requestPaused', { requestId: 'r4', resourceType: 'XHR', frameId: 'MAIN', request: { url: 'https://api.com/x' } }, 'SID1');
  assert.equal(failOrContinue().method, 'Fetch.continueRequest', '非文档资源不拦');
  // ⑤ 别的会话的事件 ⇒ 完全不理
  const before = sent.length;
  fire('Fetch.requestPaused', { requestId: 'r5', resourceType: 'Document', frameId: 'MAIN', request: { url: 'https://evil.com/x' } }, 'OTHER');
  assert.equal(sent.length, before, '别会话的 requestPaused 不得处理');
  // ⑥ window.open 跨主机弹窗 ⇒ 关；同主机 ⇒ 不关
  fire('Target.targetCreated', { targetInfo: { targetId: 'T1', type: 'page', url: 'https://popup.com/' } }, undefined);
  assert.ok(sent.some((x) => x.method === 'Target.closeTarget' && x.params['targetId'] === 'T1'), '跨主机弹窗必须关');
  fire('Target.targetCreated', { targetInfo: { targetId: 'T2', type: 'page', url: 'https://src.com/verify' } }, undefined);
  assert.ok(!sent.some((x) => x.method === 'Target.closeTarget' && x.params['targetId'] === 'T2'), '同主机弹窗不关（合法验证流）');
  fire('Target.targetCreated', { targetInfo: { targetId: 'T3', type: 'page', url: 'about:blank' } }, undefined);
  assert.ok(!sent.some((x) => x.method === 'Target.closeTarget' && x.params['targetId'] === 'T3'), 'about:blank 弹窗留给 closeBlankTabs');
});

test('#465 装挂点：主路 attach 与渲染 tab attach 都装（源码层锁）', () => {
  assert.match(SRC, /await installNavGuard\(s, cdp, att\.sessionId\);/, 'attachPageSession 必须装跳转拦截');
  assert.match(SRC, /await installNavGuard\(s, cdp, sid\);/, '渲染 tab attach 必须装跳转拦截');
  // 只拦 Document：媒体/XHR 不能被暂停（否则渲染页直接残）
  assert.match(SRC, /resourceType: 'Document', requestStage: 'Request'/, 'Fetch 模式必须收窄到 Document');
});


test('#525 context 模式默认开（观察期满改默认；三种途径的优先级锁）', () => {
  const env0 = process.env['YUEDU_BROWSER_CONTEXT'];
  try {
    // ① 无 override、无 env ⇒ 默认开（#525：10-21 起观察 2 天，10-23 期满无异常）
    setBrowserContextMode(null);
    delete process.env['YUEDU_BROWSER_CONTEXT'];
    assert.equal(browserContextEnabled(), true, '默认必须为开（#525 观察期满改默认）');
    // ② env=0 钉死关（CI / 排障用）
    process.env['YUEDU_BROWSER_CONTEXT'] = '0';
    assert.equal(browserContextEnabled(), false, 'YUEDU_BROWSER_CONTEXT=0 必须能钉死关');
    // ③ 设置页 override 优先级最高：盖过 env、也盖过默认
    setBrowserContextMode(true);
    assert.equal(browserContextEnabled(), true, '设置页开必须盖过 env=0');
    setBrowserContextMode(false);
    assert.equal(browserContextEnabled(), false, '设置页关必须盖过默认开');
  } finally {
    setBrowserContextMode(null);
    if (env0 === undefined) delete process.env['YUEDU_BROWSER_CONTEXT'];
    else process.env['YUEDU_BROWSER_CONTEXT'] = env0;
  }
});
