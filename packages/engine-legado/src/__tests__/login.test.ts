/**
 * 源登录测试（Legado `BaseSource.login()` / `getLoginJs()` / `getLoginInfoMap()`）
 *
 * 覆盖：
 *   ① loginUrl 形态识别（纯 URL / 源阅 JSON 配置 / 可服务端执行的 JS / 依赖 WebView 的 JS）
 *   ② 服务端执行登录脚本 → Cookie 落进源存储
 *   ③ 凭据走 `source.getLoginInfoMap()`（ctx.loginInfo 注入）
 *   ④ 依赖 WebView → 明确返回 needBrowser（不假装成功）
 *   ⑤ 登录页 URL → action='browser' + url
 *   ⑥ 脚本没实现 login() → `#469①`（用户拍板）改判为「已保存并关闭」：ok + 友好文案（不再抛错）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import { classifyLoginUrl, extractInlineJs } from '../model/login';
import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://lg.test';

function makeCtx(loginInfo?: Record<string, string>): { ctx: EngineContext; jar: Record<string, string> } {
  const jar: Record<string, string> = {};
  const ctx: EngineContext = {
    reqId: 'lg-test',
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
    cookies: {
      get: (k) => jar[k] ?? '',
      set: (k, v) => {
        jar[k] = v;
      },
      remove: (k) => {
        delete jar[k];
      },
      header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    },
    ...(loginInfo ? { loginInfo: new Map(Object.entries(loginInfo)) } : {}),
  };
  return { ctx, jar };
}

function makeSrc(over: Record<string, unknown> = {}) {
  const raw = {
    bookSourceUrl: BASE,
    bookSourceName: '登录测试源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text', tocUrl: '/book/1/' },
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '.con@html' },
    ...over,
  };
  const out = compileBookSource(raw);
  assert.ok(out.ok && out.rule, 'compile 失败');
  return out.rule!;
}

// ---------------------------------------------------------------- ① 形态识别
test('① 形态识别：纯 URL / 源阅 JSON 配置 / 服务端 JS / 需浏览器 JS / 空', () => {
  assert.equal(classifyLoginUrl('https://ac.qq.com/login.shtml?redir=https://ac.qq.com/Home').kind, 'url');
  assert.equal(classifyLoginUrl('{ "url": "https://u.faloo.com/regist/Login.aspx" }').kind, 'config-url');
  assert.equal(classifyLoginUrl('{ "url": "" }').kind, 'none');
  assert.equal(classifyLoginUrl('').kind, 'none');
  assert.equal(classifyLoginUrl('null').kind, 'none');
  // <js> 包裹 → 取内层脚本；纯 HTTP 登录 → 服务端可跑
  const inline = classifyLoginUrl('<js>function login(){ cookie.setCookie("u","k=v"); }</js>');
  assert.equal(inline.kind, 'js');
  assert.equal(inline.needBrowser, false);
  assert.ok(inline.js.startsWith('function login'), '<js> 内层被取出');
  // java.startBrowserAwait → 依赖 WebView
  const browser = classifyLoginUrl('function login(){ java.startBrowserAwait("https://x/y", "登录"); }');
  assert.equal(browser.kind, 'js'); // 不再有 js-browser 类别（静态扫描会误判）
  assert.equal(browser.needBrowser, true, 'needBrowser 作为提示保留');
  assert.equal(browser.needBrowser, true);
  // 非 `<js>` 包裹的裸脚本整体当脚本（Legado getLoginJs 语义）
  assert.equal(classifyLoginUrl('function login(){ return true; }').kind, 'js');
  assert.equal(extractInlineJs('@js:foo()'), 'foo()');
  assert.equal(extractInlineJs('<JS>bar()</JS>'), 'bar()', '不区分大小写');
  assert.equal(extractInlineJs('https://a/b'), null, '非 JS 包裹返回 null');
});

// ---------------------------------------------------------------- ② 服务端执行登录
test('② 服务端执行登录脚本：写入的 Cookie 落进源存储，返回 action=server', async () => {
  const rule = makeSrc({
    loginUrl: 'function login(){ cookie.setCookie("https://lg.test/", "token=tk-1; uid=7"); }',
  });
  const { ctx, jar } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.action, 'server');
  assert.equal(r.count, 2);
  assert.equal(jar['token'], 'tk-1');
  assert.equal(jar['uid'], '7');
});

// ---------------------------------------------------------------- ③ 凭据（账号/密码）
test('③ 凭据：source.getLoginInfoMap() 能读到 ctx.loginInfo 注入的账号密码', async () => {
  const rule = makeSrc({
    loginUrl: `<js>function login(){
  const info = source.getLoginInfoMap();
  java.put('acc', info.get('账号'));
  java.put('pwd', info.get('密码'));
  cookie.setCookie("https://lg.test/", "sid=" + info.get('账号'));
}</js>`,
  });
  const { ctx, jar } = makeCtx({ 账号: 'alice', 密码: 'p@ss' });
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(ctx.variables.get('acc'), 'alice');
  assert.equal(ctx.variables.get('pwd'), 'p@ss');
  assert.equal(jar['sid'], 'alice');
});

/**
 * `#314`（2026-10-07）：**旧锁已反转**。
 *
 * 旧断言是 `String(info.size) === '0'` —— 那条锁的是「返回 JS `Map`」（`size` 是数字属性）。
 * 但上游 `BaseSource.getLoginInfoMap()` 返回 **Java `MutableMap`**：Rhino 下 `size` 是**方法**、
 * 且 `map["键"]` 与 `map.get("键")` **都能用**（`RhinoWrapFactory.kt:80-81` 专门为 `java.util.Map`
 * 做了 `CatchableNativeJavaMap` 视图）；语料实测 45 处里 `.get("键")` 35 处、`["键"]` 10 处。
 * 更关键的是：**worker 路径一直是「方法 + 方括号」形态**（`worker-pool.ts` 的 rpc 包装）
 * ⇒ L1 返 JS Map 属**两路径分岔**。现在两处统一到 `@yuedu/core` 的 `source-login.ts`。
 */
test('③b 未注入 loginInfo 时 getLoginInfoMap() 返回空表（size() 可调、不 TypeError）', async () => {
  const rule = makeSrc({
    loginUrl: `<js>function login(){
  var info = source.getLoginInfoMap();
  java.put('size', String(info.size()));
  java.put('keys', String(Object.keys(info).length));
  cookie.setCookie("https://lg.test/", "sid=" + info.get('账号'));
}</js>`,
  });
  const { ctx, jar } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  assert.equal(ctx.variables.get('size'), '0', '空表而不是报错（size() 是方法，对齐 Java Map）');
  assert.equal(ctx.variables.get('keys'), '0', 'Map 方法必须非枚举（Object.keys 只该有真键）');
  // 缺键 → 空串（`source-login.ts` 的 .get 对缺键给空串）；不抛 TypeError 就说明登录信息表拉通了
  assert.ok('sid' in jar, '没抛 TypeError 就说明信息表拉通了');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'server');
});

// ---------------------------------------------------------------- ④ 需浏览器
test('④ 依赖 WebView 的登录脚本：先尝试服务端执行，未拿到 Cookie 才标记 needBrowser', async () => {
  // 语义变更（对齐本轮修正）：不再用静态正则直接拒绝 —— 七猫那类「login() 是纯本地函数、
  // startBrowser 只出现在无关函数里」的源会被误判。现在一律执行；只有确实没拿到 Cookie
  // 且脚本提到 WebView 时才提示「可能需桌面端」。
  const rule = makeSrc({ loginUrl: 'function login(){ java.startBrowserAwait("https://lg.test/login", "登录"); }' });
  const { ctx, jar } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  assert.equal(r.ok, false, '没拿到 Cookie 不算成功');
  // 语义升级：脚本调用了 startBrowserAwait → 说明要真浏览器，引擎把 URL 交回前端打开
  // （比旧版「返回 server + needBrowser」更有用：前端能直接打开登录页）
  assert.equal(r.action, 'browser', '脚本要求浏览器 → 交回前端打开登录页');
  assert.equal(r.needBrowser, true);
  assert.equal(Object.keys(jar).length, 0, '没有产生 Cookie');
});

test('④b 纯本地 login()（无浏览器调用）→ 服务端正常执行成功（七猫场景）', async () => {
  // 七猫：loginUrl 里既有 gx()/my()（含 startBrowser），也有纯本地的 login()（写 Cookie）
  const script = [
    'function login(){ java.put("csh", "1"); cookie.set("token", "abc123"); return true; }',
    'gx = function(){ java.startBrowser("https://publish.test/page", "发布页"); }',
  ].join('\n');
  const rule = makeSrc({ loginUrl: script });
  const { ctx } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  assert.equal(r.ok, true, '本地 login() 写入 Cookie → 成功');
  assert.equal(r.count !== undefined && r.count > 0, true, '报告 Cookie 条数');
});

// ---------------------------------------------------------------- ⑤ 登录页 URL
test('⑤ 登录页 URL：返回 action=browser + url（交给桌面端开登录窗）', async () => {
  const rule = makeSrc({ loginUrl: 'https://lg.test/login?back=1' });
  const { ctx } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.action, 'browser');
  assert.equal(r.url, 'https://lg.test/login?back=1');
});

// ---------------------------------------------------------------- ⑥ 未实现 login()
test('⑥ 脚本没有 login() 函数 → 「保存并关闭」语义（`#469①`，用户 2026-10-15 拍板）', async () => {
  const rule = makeSrc({ loginUrl: 'function notLogin(){ return 1; }' });
  const { ctx } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  /**
   * 语义变更（用户明确要求）：**有数据存数据、有登录就存 Cookie，然后关登录界面**。
   * 「保存并登录」不该因为源里没写 `login()` 就抛 `Function login not implements!!!`、
   * 把对话框卡成错误态（四季书屋实测）。⇒ 引擎把这条特定错误改判为「已保存并关闭」：
   * `ok:true` + 友好文案（前端「无 action 的成功」分支据此关窗）。
   */
  assert.equal(r.ok, true);
  assert.equal(r.action, 'server');
  assert.match(String(r.message), /没有 login\(\)/);
});

// ---------------------------------------------------------------- ⑦ 未配置
test('⑦ 未配置 loginUrl → action=none', async () => {
  const rule = makeSrc();
  const { ctx } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'detail' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.action, 'none');
});

// ---------------------------------------------------------------------------
// loginUi（Legado SourceLoginDialog / RowUi）+ 登录头 + 脚本要求打开浏览器
// ---------------------------------------------------------------------------

test('⑦ loginUi 静态数组 → kind=ui + 表单行；无表单值先返回 action=form', async () => {
  // 少年梦阅读真实写法：loginUi = [{name:"账号",type:"text"},{name:"密码",type:"password"}]，
  // loginUrl 里用 source.getLoginInfoMap().get("账号") 取凭据
  const rule = makeSrc({
    loginUi: JSON.stringify([
      { name: '账号', type: 'text' },
      { name: '密码', type: 'password' },
    ]),
    loginUrl: '<js>function login(){ var u = source.getLoginInfoMap().get("账号"); cookie.set("u", u); }</js>',
  });
  const plan = classifyLoginUrl((rule as unknown as Record<string, unknown>)['loginUrl'], (rule as unknown as Record<string, unknown>)['loginUi']);
  assert.equal(plan.kind, 'ui');
  assert.deepEqual(plan.fields.map((f) => [f.name, f.type]), [['账号', 'text'], ['密码', 'password']]);

  const { ctx } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'login' }, ctx);
  assert.equal(r.action, 'form', '没填表单 → 先要表单（Legado：渲染登录对话框）');
  assert.equal(r.ok, false);
  assert.equal(r.fields?.length, 2, '回传表单行给前端渲染');
});

test('⑧ 提交表单后脚本能读到 result 与 source.getLoginInfoMap()，凭据写入 Cookie', async () => {
  const rule = makeSrc({
    loginUi: JSON.stringify([{ name: '账号', type: 'text' }, { name: '密码', type: 'password' }]),
    // result 是登录信息 map（Legado getLoginData）；source.getLoginInfoMap() 读同一份
    loginUrl: '<js>function login(){ cookie.set("u", result["账号"]); cookie.set("p", source.getLoginInfoMap().get("密码")); }</js>',
  });
  const { ctx, jar } = makeCtx({ 账号: 'alice', 密码: 's3cret' });
  const r = await new LegadoEngine().login(rule as never, { action: 'login' }, ctx);
  assert.equal(r.ok, true, '拿到 Cookie → 成功');
  assert.deepEqual(jar, { u: 'alice', p: 's3cret' }, 'result 与 getLoginInfoMap 都能取到表单值');
  assert.equal(r.hasLoginInfo, true);
});

test('⑨ loginUi 按钮行：action 是绝对 URL → 前端直接打开（引擎不出网）；JS 动作按 loginJs+action 执行', async () => {
  const rule = makeSrc({
    loginUi: JSON.stringify([
      { name: '官网登录', type: 'button', action: 'https://lg.test/login' },
      { name: '本地登录', type: 'button', action: 'doLogin()' },
    ]),
    loginUrl: '<js>function doLogin(){ cookie.set("token", "T1"); }</js>',
  });
  const plan = classifyLoginUrl((rule as unknown as Record<string, unknown>)['loginUrl'], (rule as unknown as Record<string, unknown>)['loginUi']);
  assert.equal(plan.kind, 'ui');
  assert.equal(plan.fields.length, 2);

  // 点「本地登录」→ loginJs + action（Legado handleButtonClick）
  const { ctx, jar } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'login', loginAction: 'doLogin()' }, ctx);
  assert.equal(jar['token'], 'T1', '按钮脚本被执行');
  assert.equal(r.ok, true);
});

test('⑩ loginUi @js: 动态生成行（Legado evalLoginUi：loginJs + loginUiJs）', async () => {
  const rule = makeSrc({
    loginUi: `@js:
var rows = [];
rows.push({name: '手机号', type: 'text'});
rows.push({name: '验证码', type: 'text', action: 'sendCode()'});
JSON.stringify(rows);`,
    loginUrl: '<js>function login(){ cookie.set("k", "v"); }</js>',
  });
  const { ctx } = makeCtx({ 手机号: '13800000000', 验证码: '1234' });
  const r = await new LegadoEngine().login(rule as never, { action: 'login' }, ctx);
  assert.equal(r.ok, true, '动态行求值后正常执行登录');
  assert.deepEqual(r.fields?.map((f) => f.name), ['手机号', '验证码'], '动态 loginUi 行被解析出来');
});

test('⑪ 登录头（source.putLoginHeader）持久化，并注入后续请求', async () => {
  // 真实写法（书耽 / 微信读书二合一）：登录脚本把抓到的头存进登录头，后续请求自动带上
  const rule = makeSrc({
    loginUrl: '<js>function login(){ source.putLoginHeader(JSON.stringify({"X-Token": "abc", "Cookie": "sid=9"})); }</js>',
  });
  const { ctx, jar } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'login' }, ctx);
  assert.equal(r.ok, true, '登录头写入也算登录成功');
  assert.match(String(r.loginHeader), /X-Token/);
  assert.equal(jar['sid'], '9', '登录头里的 Cookie 同步进 CookieStore');

  // 后续请求应带上登录头（Legado getHeaderMap(hasLoginHeader = true)）
  const seen: Array<Record<string, string>> = [];
  const http = {
    async request(url: string, opts?: { headers?: Record<string, string> }): Promise<HttpResponse> {
      seen.push(opts?.headers ?? {});
      return { status: 200, headers: {}, body: '<html><body><div class="item"><a href="/b/1">书</a></div></body></html>', url };
    },
  };
  const { ctx: ctx2 } = makeCtx();
  ctx2.storage = ctx.storage;
  ctx2.http = http;
  await new LegadoEngine().search(rule as never, { action: 'search', keyword: 'x' }, ctx2);
  assert.equal(seen[0]?.['X-Token'], 'abc', '登录头注入到请求');
  assert.match(String(seen[0]?.['Cookie'] ?? ''), /sid=9/, 'Cookie 也注入');
});

test('⑫ 脚本调用 java.startBrowserAwait → action=browser 并把登录页交回前端', async () => {
  // 66书吧真实写法：login(){ java.startBrowserAwait("https://66shuba.com/login", '66书吧') }
  const rule = makeSrc({
    loginUi: JSON.stringify([{ name: '登陆书源', type: 'button', action: 'login()' }]),
    loginUrl: "<js>function login(){ java.startBrowserAwait('https://66shuba.com/login', '登录'); }</js>",
  });
  const { ctx } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'login' }, ctx);
  assert.equal(r.action, 'browser', '人工登录/验证码要真浏览器 → 交回前端打开');
  assert.equal(r.url, 'https://66shuba.com/login');
  assert.equal(r.needBrowser, true);
});

test('⑬ source.removeLoginHeader / removeLoginInfo：清空登录头与登录信息', async () => {
  const rule = makeSrc({
    loginUrl:
      '<js>function login(){ source.putLoginHeader(JSON.stringify({"X-Token":"a"})); }\n' +
      'function logout(){ source.removeLoginHeader(); source.removeLoginInfo(); }</js>',
  });
  const { ctx } = makeCtx();
  const engine = new LegadoEngine();
  await engine.login(rule as never, { action: 'login' }, ctx);
  const cleared = await engine.login(rule as never, { action: 'login', loginAction: 'logout()' }, ctx);
  assert.equal(cleared.loginHeader, undefined, '登录头已清除');
  assert.equal((await ctx.storage.get('login-header:test')) ?? null, null, '落盘的登录头被删除');
});

/**
 * `#354` 禁漫天堂形态：`loginUi` 的按钮动作**只改源变量**（base url / shunt），
 * 既不动 Cookie 也不动登录头 —— `exploreUrl` 脚本随后 `eval(String(source.loginUrl))`
 * 重建函数、再 `JSON.parse(source.getVariable())` 取线路当 base URL。
 *
 * 上游语义（Legado）：按钮点击 = 跑脚本 + 弹 toast，**跑完就算完成**；源变量的落盘
 * 由 `persistSourceState` 负责，与登录态无关。
 *
 * 本锁覆盖三件事（缺一即「选了线路但分类没变」）：
 *   ① 按钮脚本里的 `source.setVariable(...)` 真的写进了 storage（跨请求可读）；
 *   ② 第二次动作能**读回**上一次写入（`source.getVariable()` 是持久态，不是每次重置）；
 *   ③ toast 原话原样回传（源作者的「请刷新探索页」是用户唯一反馈）。
 */
test('⑭ #354 按钮动作只改源变量：落盘 storage + 跨请求读回 + toast 回传', async () => {
  const rule = makeSrc({
    loginUi: JSON.stringify([
      { name: '切换国际线路', type: 'button', action: 'setLine(2)' },
      { name: '切换分流', type: 'button', action: 'nextShunt()' },
    ]),
    loginUrl:
      '<js>var LINES=["https://a.test","https://b.test","https://c.test"];\n' +
      'function V(){ try{ return JSON.parse(source.getVariable())||{} }catch(e){ return {url:"https://a.test",shunt:1} } }\n' +
      'function save(o){ source.setVariable(JSON.stringify(o,null,"\\t")); }\n' +
      'function setLine(i){ var o=V(); o.url=LINES[i%LINES.length]; o.lineType="国际通用"; save(o);' +
      ' java.longToast("【国际站点】已切换 ("+(i%LINES.length+1)+"/"+LINES.length+"): "+o.url+"\\n\\n请刷新探索页"); }\n' +
      'function nextShunt(){ var o=V(); o.shunt=(o.shunt||1)%4+1; save(o); java.longToast("已切换分流: "+o.shunt); }</js>',
  });
  const { ctx } = makeCtx();
  const engine = new LegadoEngine();

  // ① 首次动作（无源变量）→ 写 url=b.test + lineType；toast 原话回传
  const r1 = await engine.login(rule as never, { action: 'detail', loginAction: 'setLine(1)' }, ctx);
  assert.equal(r1.ok, true, '按钮动作跑通即为成功（Legado：跑完就算完成）');
  assert.ok(
    (r1.toasts ?? []).some((t) => t.includes('已切换') && t.includes('请刷新探索页')),
    `toast 原话应回传（修前源作者提示丢失）：${JSON.stringify(r1.toasts)}`,
  );
  const stored1 = (await ctx.storage.get('source-var:test')) ?? '';
  assert.notEqual(stored1, '', '按钮改的源变量必须落盘 storage（否则下次请求读不到 ⇒ 分类不变）');
  assert.equal((JSON.parse(stored1) as { url?: string }).url, 'https://b.test', '落盘的 url 与脚本写入一致');

  // ② 第二次动作**读回**第一次写入（shunt 从默认 1 → 2，而不是又从 1 开始）
  const r2 = await engine.login(rule as never, { action: 'detail', loginAction: 'nextShunt()' }, ctx);
  assert.equal(r2.ok, true);
  const stored2 = JSON.parse((await ctx.storage.get('source-var:test')) ?? '{}') as { shunt?: number; url?: string };
  assert.equal(stored2.shunt, 2, 'shunt 必须从上次的 1 递增到 2（读不回就会恒为 2，看不出差别时用 url 兜底）');
  assert.equal(stored2.url, 'https://b.test', '第二次动作不得丢掉第一次写的 url（源变量是合并写，不是覆盖）');
});

/**
 * `#411` 动态 `loginUi` **求值失败**必须把原因带回对话框。
 *
 * 旧实现 `catch { return [] }` 是纯静默：18AV（`tmp/src-18AV.json`）的 `loginUi` 第一条就是
 * `java.importScript('https://unpkg.com/artplayer/dist/artplayer.js').match(/artplayer.js.*v(.+)/i)[1]`，
 * 本仓 java 桩缺 `importScript` ⇒ 兜底返回**函数** ⇒ `.match` 不存在 ⇒ TypeError
 * ⇒ 行数组为空 ⇒ 对话框退化成「打开登录窗口」，而**日志里一个字都没有**
 * —— 与「源本来就没写 loginUi」不可分辨。
 *
 * 本锁用同一形态（对 `match()` 的 null 直接下标）复现，断言：
 *   ① 结果 `message` 里必须能看到「登录界面（loginUi）脚本求值失败」；
 *   ② **不**把 UI 渲染失败升级成硬失败（登录脚本仍被执行 —— 有些源点「登录」不需要 UI）。
 */
test('⑮ #411 动态 loginUi 求值失败 → 原因回传前端（不再静默空表单）', async () => {
  const rule = makeSrc({
    loginUi: `@js:JSON.stringify([{name: "ArtPlayer V" + "no-match".match(/artplayer\\.js.*v(.+)/i)[1], type: "button"}])`,
    loginUrl: '<js>function login(){ cookie.set("t", "1"); }</js>',
  });
  const { ctx, jar } = makeCtx();
  const r = await new LegadoEngine().login(rule as never, { action: 'login' }, ctx);
  assert.equal(jar['t'], '1', '登录脚本本身仍执行（UI 渲染失败不升级成硬失败）');
  assert.match(String(r.message), /登录界面（loginUi）脚本求值失败/, `必须看到原因：${r.message}`);
  assert.equal(r.fields?.length ?? 0, 0, '没有行可渲染');
});
