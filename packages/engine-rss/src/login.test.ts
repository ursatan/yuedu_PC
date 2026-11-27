/**
 * `#314`（2026-10-07）：RSS 订阅源**登录链路**回归锁。
 *
 * 用户报障原文：
 *   ① 「我在登录界面切换下拉列表项，点保存并登录，提示：**引擎 rss 不支持登录**」；
 *   ② 「关闭登录界面，刷新分类，**并没有加载新源站（登录页下拉列表对应）的分类**」；
 *   ③ `SELECTOR_MISS@parse: $.data||$.list · 列表规则解析为 0 条`。
 *
 * 真跑取证（`tmp/probe-rss-login.log`）⇒ ③ 是同一条链的下游，根因是 ①+② 背后的**整块能力缺失**：
 *   · `makeRssSourceStub` 暴露 43 个键、**没有 `getLoginInfoMap`**，而源脚本第一行就在调它
 *     ⇒ `source.getLoginInfoMap is not a function` ⇒ **分类脚本整段崩** ⇒ 分类退化成「整源」；
 *   · `RssEngine.capabilities` 没有 `login` ⇒ hub 直接回「引擎 rss 不支持登录」；
 *   · `resolveSorts` 的进程内缓存键 = `sourceUrl + sortUrl`（**不含登录信息**）
 *     ⇒ 就算前两条修好，切换源站后刷新仍会命中旧缓存。
 *
 * 对偶（防空转）见每个用例的第二段断言：**没有**登录信息时必须给出**另一条**分类，
 * 否则「分类变了」可能只是分类恒定的假象。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTraceSink, createVariableStore, parseLoginUiText, LOGIN_UI_RENDER_ACTION, type EngineContext, type UnifiedRequest } from '@yuedu/core';
import { RssEngine } from './engine';
import { makeRssEnv, makeRssSourceStub } from './env';
import { compileRssSource, type RssSourceRaw } from './model/rss-source';

/** 引擎动作入参（`action` 是必填项，这里只是占位 —— 用例直接调方法、不走 hub 分发） */
const REQ = { action: 'home' } as unknown as UnifiedRequest;

/** 够用的 EngineContext（storage 用内存 Map；本组用例零网络） */
function makeCtx(
  init?: { variables?: Record<string, string>; loginInfo?: Map<string, string>; store?: Record<string, string> },
): { ctx: EngineContext; store: Map<string, string> } {
  const variables = createVariableStore();
  for (const [k, v] of Object.entries(init?.variables ?? {})) variables.set(k, v);
  const store = new Map<string, string>(Object.entries(init?.store ?? {}));
  const ctx = {
    reqId: 'test',
    sourceId: 'rss-1',
    signal: new AbortController().signal,
    http: {
      async request() {
        throw new Error('本组用例不应发请求（分类脚本是纯脚本）');
      },
    },
    sandbox: { async eval() { return undefined; } }, // 本机起不了子进程 ⇒ hybrid 会回落 L1
    trace: createTraceSink(),
    variables,
    storage: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
    toastSink: [],
    ...(init?.loginInfo ? { loginInfo: init.loginInfo } : {}),
  } as unknown as EngineContext;
  return { ctx, store };
}

/**
 * 分类脚本：**按登录信息选源站**（与语料 `影视聚合(资源站)` 的结构同形 —— 它读
 * `loginInfo["选择影视源站"]` 后 `split("-")[0]` 当 `SITE_CONFIG` 下标）。
 * 这里用「把登录值直接拼进分类名」的写法，让「读到 vs 没读到」在断言里一目了然。
 */
const SORT_TPL = '@js:(function () { var m = source.getLoginInfoMap(); var pick = m["站点"] || "无"; return pick + "::https://a.test/feed"; })()';

function sortRule() {
  return compileRssSource({ sourceUrl: 'https://a.test/feed', sourceName: '测试订阅', sortUrl: SORT_TPL } as RssSourceRaw);
}

test('#314：source 桩必须有 getLoginInfoMap，且**方括号**取键能命中（旧实现 43 个键里没有它）', () => {
  const { ctx } = makeCtx({ loginInfo: new Map([['站点', '乙站']]) });
  const rule = sortRule();
  const stub = makeRssSourceStub(ctx, rule, () => ({})) as Record<string, unknown>;
  assert.equal(typeof stub['getLoginInfoMap'], 'function', 'BaseSource.kt:257 是**所有源**的公共能力，rss 桩不能缺');
  const m = (stub['getLoginInfoMap'] as () => Record<string, unknown>)();
  // 方括号 = 源脚本的写法（语料 10 处）；旧实现（返回 JS Map / 整块缺失）在这里必然失败
  assert.equal(m['站点'], '乙站', '方括号取键必须命中');
  assert.equal((m as unknown as { get: (k: string) => unknown }).get('站点'), '乙站', '.get() 也必须命中');
  assert.equal(typeof stub['getLoginInfo'], 'function', 'getLoginInfo 同族方法不能缺');
  assert.equal(typeof stub['getLoginHeaderMap'], 'function');
  assert.equal((stub['hasLogin'] as () => boolean)(), false, '本测试源没配 loginUrl/loginUi ⇒ hasLogin() 为 false');
});

test('#314：分类随**登录信息**变化（缓存键必须含登录信息，否则切源站后刷新纹丝不动）', async () => {
  const engine = new RssEngine();
  const rule = sortRule();
  const sortsOf = async (login: Map<string, string> | undefined) => {
    const { ctx } = makeCtx(login ? { loginInfo: login } : undefined);
    const r = await engine.home(rule, REQ, ctx);
    return r.filters?.[0]?.options.map((o) => o.name) ?? [];
  };
  // ① 带登录信息 → 分类名 = 登录值
  assert.deepEqual(await sortsOf(new Map([['站点', '甲站']])), ['甲站']);
  // ② 对偶：**不带**登录信息 → 必须是另一条（证明 ① 不是「分类恒定」的假象）
  assert.deepEqual(await sortsOf(undefined), ['无'], '没有登录信息时脚本必须走另一分支');
  // ③ 关键：同一源、同一 sortUrl，**只改登录信息** → 必须重算（旧缓存键不含登录信息 ⇒ 这里会拿到 '甲站'）
  assert.deepEqual(
    await sortsOf(new Map([['站点', '丙站']])),
    ['丙站'],
    '切换源站后分类必须重算（缓存键含登录信息指纹）',
  );
});

test('#314：引擎能力位含 login；登录表单行直接来自 loginUi（不再回「引擎 rss 不支持登录」）', async () => {
  const engine = new RssEngine();
  assert.ok(engine.capabilities.includes('login'), 'capabilities 必须含 login（否则 hub 直接拒绝）');
  assert.equal(typeof engine.login, 'function', 'hub.login 的早退条件就是 `!engine?.login`');

  const loginUi = JSON.stringify([
    { name: '选择影视源站', type: 'select', chars: ['0-红牛资源', '2-豪华资源'] },
  ]);
  // loginUrl 与语料实测一致：`function login(){ … return true; }`
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '测试订阅',
    loginUrl: 'function login(){\n  return true;\n}\n',
    loginUi,
  } as RssSourceRaw);
  const { ctx } = makeCtx({ loginInfo: new Map([['选择影视源站', '2-豪华资源']]) });
  const r = await engine.login(rule, REQ, ctx);
  assert.equal(r.ok, true, `login() 应成功，实际：${JSON.stringify(r)}`);
  assert.equal(r.action, 'server');
  assert.equal(r.hasLoginInfo, true, '下拉选项已被 hub 落盘（hub.login 在调引擎**之前**就 setSourceLoginInfo）');
  const sel = r.fields?.find((f) => f.type === 'select');
  assert.ok(sel, '必须把 select 行下发（前端靠它渲染下拉）');
  assert.deepEqual(sel?.chars, ['0-红牛资源', '2-豪华资源'], '选项来自 chars');
  assert.equal(sel?.options, undefined, 'chars 与 options 是**两个**字段，别把选项写成 options');

  // 对偶：完全没配登录的源 → 明确回答「未配置」，而不是伪造一个空表单
  const bare = compileRssSource({ sourceUrl: 'https://a.test/feed', sourceName: '裸' } as RssSourceRaw);
  const r2 = await engine.login(bare, REQ, makeCtx().ctx);
  assert.equal(r2.ok, false);
  assert.equal(r2.action, 'none', '没配登录必须回 action=none（对齐 legado 引擎同文案）');
});

test('#314：真语料实证 —— select 行的选项**只**在 chars 里（options 恒为空）', () => {
  // `#651`：语料只剩 `data/seed/rssSource.json`（单数组；原 `tests/fixtures/sources/rss/` 已删）
  // 该语料是第三方订阅源的转载集，不进公开仓库（本地自备）⇒ 缺失时跳过，而不是 ENOENT。
  const corpusFile = join(import.meta.dirname, '../../../data/seed/rssSource.json');
  if (!existsSync(corpusFile)) {
    console.log(`[#314 真语料实证] 跳过：${corpusFile} 不在仓库内（本地自备）`);
    return;
  }
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as Array<Record<string, unknown>>;
  const rows: Array<{ name: string; chars: number; options: number }> = [];
  {
    const arr = Array.isArray(corpus) ? corpus : [corpus];
    for (const raw of arr) {
      const ui = String(raw['loginUi'] ?? '');
      // 宽松匹配（`"type":"select"` / `"type": "select"` 两种写法都要认）
      if (!/"select"/.test(ui)) continue;
      for (const fld of parseLoginUiText(ui)) {
        if (fld.type === 'select') rows.push({ name: fld.name, chars: fld.chars?.length ?? 0, options: fld.options?.length ?? 0 });
      }
    }
  }
  // fixtures 快照里 1 个（`影视聚合(资源站)`）；`data/imported-sources.json` 快照里有 3 个
  // —— 两个快照的新旧不同，这里按 fixtures 的实际值断言（不编数）。
  assert.ok(rows.length >= 1, `语料里的 select 行应 ≥1，实际 ${rows.length}`);
  for (const r of rows) {
    assert.ok(r.chars > 0, `${r.name}：select 行的选项必须在 chars（实际 ${r.chars}）`);
    assert.equal(r.options, 0, `${r.name}：options 恒为空 —— 前端若读 options 就是空下拉（#311 已修）`);
  }
});

test('#314：登录态从 storage prime（重启后登录信息不丢）', async () => {
  const engine = new RssEngine();
  const rule = sortRule();
  // storage 里有登录信息、ctx.loginInfo **没有**（模拟「重启进程后」）
  const { ctx } = makeCtx({ store: { 'login-info:rss-1': JSON.stringify({ 站点: '丁站' }) } });
  const r = await engine.home(rule, REQ, ctx);
  assert.deepEqual(r.filters?.[0]?.options.map((o) => o.name), ['丁站'], '必须从 storage prime 出登录信息');
});

test('#314：登录头注入后续请求（对齐 getHeaderMap(hasLoginHeader = true)）', async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const engine = new RssEngine();
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '带登录头的源',
    header: '{"X-Site-Header":"h1"}',
  } as RssSourceRaw);
  // ⚠️ 登录头走**持久层**（`prepare()` 会从 storage 读 `login-header:<id>` 覆盖变量 —— 生产路径
  //    里 hub 不通过 ctx 注入登录头，storage 是唯一来源）；直接塞变量会被 prepare 覆盖成空。
  const { ctx } = makeCtx({ store: { 'login-header:rss-1': '{"X-Token":"t1","X-Site-Header":"login"}' } });
  (ctx as unknown as { http: { request: unknown } }).http = {
    async request(_url: string, opts?: { headers?: Record<string, string> }) {
      seen.push(opts?.headers);
      // 必须给**至少一条 item**：0 条会被 `listArticles` 判成 SELECTOR_MISS（引擎的防空转判据）
      return {
        status: 200,
        headers: {},
        body: '<rss version="2.0"><channel><title>t</title><item><title>a</title><link>https://a.test/1</link></item></channel></rss>',
      };
    },
  };
  await engine.home(rule, REQ, ctx);
  // home 不发请求；这里直接验证请求头拼装路径：跑一次 category（feed 用源 URL 回落）
  await engine.category(rule, REQ, ctx);
  assert.ok(seen.length > 0, 'category 必须真的发请求');
  const h = seen[0] ?? {};
  assert.equal(h['X-Token'], 't1', '登录头必须注入（源脚本 putLoginHeader 的值要能进请求）');
  assert.equal(h['X-Site-Header'], 'login', '同名头以登录头为准（与 legado 引擎一致）');
});

// ---------------------------------------------------------------------------
// 空表兜底（对偶）：没有登录信息时不得抛异常
// ---------------------------------------------------------------------------
test('#314：没有任何登录信息时 getLoginInfoMap() 是空表（不抛 TypeError）', () => {
  const rule = compileRssSource({ sourceUrl: 'https://a.test/feed', sourceName: 'x' } as RssSourceRaw);
  const env = makeRssEnv(makeCtx().ctx, rule, rule.sourceUrl);
  const m = (env.sourceData as Record<string, unknown>)['getLoginInfoMap'] as () => Record<string, unknown>;
  assert.equal(Object.keys(m()).length, 0);
});

// ---------------------------------------------------------------------------
// `#387`：登录按钮的「打开浏览器」语义（订阅源按钮行 = java.startBrowser）
// ---------------------------------------------------------------------------
/**
 * 用户报障原文（RSS 源 ˃̶͈ ꇴ ˂̶͈）：
 *   「登录页，按钮行为不对，比如「密匙」按钮，应打开页面，获取密匙，返回填到输入框。
 *     目前点击登录界面 4 个按钮，都只有一个登录成功提示。」
 *
 * 真因（引擎侧）：`makeRssEnv` 只接了 `onToast`、**没接 `onBrowserOpen`**，且 `login()` 的返回里
 * **从不读 `__browserUrl`** ⇒ `java.startBrowser(url,'密钥')` 既不开窗也不报错，
 * 5 个按钮一律落进「按钮动作跑通即成功」（`ok = !!loginAction`）那条路。
 * 对照 `engine-legado`：两处都齐（`onBrowserOpen` + 步骤 ④ 回 `action:'browser'`）。
 */
test('#387：登录按钮的 java.startBrowser 必须回 action=browser（此前只弹提示、不弹窗）', async () => {
  const engine = new RssEngine();
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '订阅登录按钮',
    loginUrl: [
      'function login(){ return true; }',
      // 纯提示型按钮（语料 `O()`）—— 用来做**对偶**：不得被误判成「要浏览器」
      'O = () => { java.toast("这个按钮是用来看的"); };',
      // 密钥型按钮（语料 `my()`）—— 语义 = 打开页面拿密钥
      "my = () => { var url = 'http://x.test/miyao.html'; java.startBrowser(url, '密钥'); };",
    ].join('\n'),
    loginUi: JSON.stringify([
      { name: '密钥：', type: 'text' },
      { name: '✐密钥✐', type: 'button', action: 'my()' },
      { name: '点我', type: 'button', action: 'O()' },
    ]),
  } as RssSourceRaw);
  const loginReq = (a: string) => ({ action: 'login', loginAction: a }) as unknown as UnifiedRequest;

  // ① 目标：密钥按钮 → 必须把 URL 交回前端（前端据 action=browser 自动弹登录窗）
  const r = await engine.login(rule, loginReq('my()'), makeCtx().ctx);
  assert.equal(r.action, 'browser', `密钥按钮必须回 action=browser，实际：${JSON.stringify(r)}`);
  assert.equal(r.url, 'http://x.test/miyao.html', '必须把脚本给出的地址原样回传');
  assert.equal(r.needBrowser, true);
  assert.equal(
    r.browserKind,
    'show',
    `startBrowser 是 fire-and-forget「打开给人看」⇒ browserKind 必须是 show（前端用应用内浏览器），实际：${JSON.stringify(r)}`,
  );
  assert.equal(r.ok, false, '人工操作还没做完 ⇒ ok 必须 false（不能伪装成「已登录」）');

  // ② 对偶（防空转）：不调浏览器 API 的按钮 → 仍走原有「跑通即成功」，不得误报 browser
  const r2 = await engine.login(rule, loginReq('O()'), makeCtx().ctx);
  assert.equal(r2.action, 'server', `纯 toast 按钮不得被误判成要浏览器，实际：${JSON.stringify(r2)}`);
  assert.equal(r2.ok, true);
});

/**
 * `#464`（用户 2026-10-15 实测 18AV「🌐获取网址」）：
 * ```
 * let Info={}; Info['网址'] = surl; java.upLoginData(Info);
 * ```
 * 脚本把新域名写进 `java.upLoginData` ⇒ 登录结果必须带 `loginData`（前端据此**回填输入框**）。
 * 此前 core 整条 API 未实现（Proxy 兜底空函数）⇒ 静默空转 ⇒ 用户看到「toast 说已填写、输入框仍空」。
 *
 * 对偶（防空转）：**没调** upLoginData 的动作不得多带 `loginData`（否则前端会乱回填）。
 */
test('#464：java.upLoginData 的值必须随登录结果回传（前端回填登录表单）', async () => {
  const engine = new RssEngine();
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '订阅登录按钮',
    loginUrl: [
      'function login(){ return true; }',
      // 语料 `fabuye()` 的同形：算出一个新域名 → upLoginData 填进「网址」行
      "fabu = () => { let Info={}; Info['网址']='https://new.site/'; java.upLoginData(Info); java.longToast('已填写最新网址'); };",
      'O = () => { java.toast("这个按钮是用来看的"); };',
    ].join('\n'),
    loginUi: JSON.stringify([
      { name: '网址', type: 'text' },
      { name: '🌐获取网址', type: 'button', action: 'fabu()' },
      { name: '点我', type: 'button', action: 'O()' },
    ]),
  } as RssSourceRaw);
  const loginReq = (a: string) => ({ action: 'login', loginAction: a }) as unknown as UnifiedRequest;

  const r = await engine.login(rule, loginReq('fabu()'), makeCtx().ctx);
  assert.deepEqual(r.loginData, { 网址: 'https://new.site/' }, `upLoginData 的值必须回传，实际：${JSON.stringify(r)}`);
  // 对偶：同源另一个按钮不调 upLoginData ⇒ 不得多带
  const r2 = await engine.login(rule, loginReq('O()'), makeCtx().ctx);
  assert.equal(r2.loginData, undefined, '没调 upLoginData 的动作不得带 loginData');
});

/**
 * `#393` 用户实测追问：「登录界面打开的网页，能否像 RSS 源打开源仓库那样用**应用内浏览器**，
 * 而不是跳转 Chrome？」—— 关键在于**打开它是为了什么**：
 *
 *  · `java.startBrowser(url,'密钥')`（语料 `my()` / `H()` / `M()` / `ck()` 四个按钮全是它）
 *    = **fire-and-forget**，就是「打开给人看」：拿密钥、看发布页、看源作者内联的
 *    `data:text/html;base64` 更新页（那页里有「导入书源」按钮 —— **只有应用内**点了才有用）
 *    ⇒ `show` ⇒ 应用内极简浏览器。
 *  · `java.startBrowserAwait(...)` = **在等浏览器里的结果**（上游返回 StrResponse，源常接着
 *    `cookie.getKey(url,"token")` 取 token）⇒ `cookie` ⇒ 必须本机真浏览器：
 *    跨域站点的 Cookie 无法从应用内 iframe 取回（浏览器 cookie ≠ 服务端 cookie jar）。
 *
 * ⚠️ 判据在引擎侧（`BrowserOpenKind`），**不要让前端去猜**：前端只看 `browserKind`。
 */
test('#393：browserKind 区分 —— startBrowser ⇒ show（应用内浏览器）；startBrowserAwait ⇒ cookie（真浏览器）', async () => {
  const engine = new RssEngine();
  const mk = (js: string) =>
    compileRssSource({
      sourceUrl: 'https://a.test/feed',
      sourceName: '浏览器通道',
      loginUrl: ['function login(){ return true; }', js].join('\n'),
      loginUi: JSON.stringify([{ name: '密钥：', type: 'text' }, { name: '打开', type: 'button', action: 'go()' }]),
    } as RssSourceRaw);
  const req = { action: 'login', loginAction: 'go()' } as unknown as UnifiedRequest;

  // ① 展示型（真语料 `my()` 的写法）⇒ show
  const a = await engine.login(
    mk("go = () => { java.startBrowser('http://x.test/miyao.html', '密钥'); };"),
    req,
    makeCtx().ctx,
  );
  assert.equal(a.action, 'browser');
  assert.equal(a.browserKind, 'show', `startBrowser ⇒ show，实际：${JSON.stringify(a)}`);

  // ② 等待型（真语料 `setzt()` 的写法：拿 URL 交给它，之后 `cookie.getKey(url,'token')`）⇒ cookie
  //    站点指向 127.0.0.1:1（必然拒绝）—— 本用例只关心**目的**，渲染/抓取结果无所谓。
  const b = await engine.login(
    mk("go = () => { java.startBrowserAwait('http://127.0.0.1:1/x', '密钥'); };"),
    req,
    makeCtx().ctx,
  );
  assert.equal(b.action, 'browser');
  assert.equal(b.browserKind, 'cookie', `startBrowserAwait ⇒ cookie，实际：${JSON.stringify(b)}`);
});

/**
 * `#397`（2026-10-11）：登录结果必须带 **wroteLoginState**（本次运行是否**新写了**登录态）。
 *
 * 用户实测 ˃̶͈ ꇴ ˂̶͈：点「书源更新」「点击试试」这类**纯动作按钮**（脚本不写 Cookie/登录头，
 * 只可能重写与上次相同的 loginInfo），前端却弹「✅ 登录成功」—— 因为旧判据用的是
 * `hasLoginInfo`/`count`（**当前状态**：源之前写过的「密钥」loginInfo、会话 jar 里已有的
 * Cookie 都会让它们为真）。前端判「按钮动作是否真登录」只认 `wroteLoginState`。
 */
test('#397：按钮动作重写同样的 loginInfo ⇒ wroteLoginState=false（不算「真登录」）', async () => {
  const engine = new RssEngine();
  // loginUrl：login() 与按钮动作都只 putLoginInfo（内容与已有的一致）
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '测试订阅',
    loginUrl: 'function login(){ source.putLoginInfo(JSON.stringify({"密钥：":"abc"})); return true; }',
    loginUi: JSON.stringify([
      { name: '密钥：', type: 'text' },
      { name: '书源更新', type: 'button', action: 'H()' },
    ]),
  } as RssSourceRaw);
  // ctx 里**已有**同样的登录信息（= 源之前写过 ⇒ hasLoginInfo 为真）。
  // ⚠️ prime 到 `variables['__loginInfo']`（脚本 putLoginInfo 的写读同层）——
  // `readLoginInfo` = variables ⊕ ctx.loginInfo（后者优先），ctx.loginInfo 是 hub 的
  // 「UI 刚提交」真值层，会覆盖脚本写入 ⇒ 不适合模拟「源之前写过的旧状态」。
  const { ctx } = makeCtx({ variables: { __loginInfo: JSON.stringify({ '密钥：': 'abc' }) } });
  const r = await engine.login(rule, REQ, ctx);
  assert.equal(r.ok, true, `动作按钮跑通即 ok：${JSON.stringify(r)}`);
  assert.equal(r.hasLoginInfo, true, 'loginInfo 已存在（状态为真）');
  assert.equal(
    r.wroteLoginState,
    false,
    `但本次**没有新写**任何登录态 ⇒ wroteLoginState 必须为 false：${JSON.stringify(r)}`,
  );

  // 对偶：动作**真的写了新内容** ⇒ wroteLoginState=true（否则真登录会被误判成纯动作）
  const { ctx: ctx2 } = makeCtx({ variables: { __loginInfo: JSON.stringify({ '密钥：': '旧值' }) } });
  const r2 = await engine.login(rule, REQ, ctx2);
  assert.equal(r2.wroteLoginState, true, `loginInfo 内容变了 ⇒ 必须为 true：${JSON.stringify(r2)}`);
});

/**
 * `#411`：动态 `loginUi` 求值失败的**原因必须回传 message**（不再只写一行服务端日志）。
 *
 * 用户可见症状（18AV）：登录对话框空白/只剩「打开登录窗口」，而**对话框里一个字都不说为什么**。
 * 本锁用「脚本直接抛错」复现（18AV 真实形态是 `java.importScript(...).match(...)[1]` 取不到；
 * 那条链的回归锁在 core：`java-file-411.test.ts` + `login-flow.test.ts`）。
 */
test('#411：订阅源动态 loginUi 求值失败 → 原因进 message（对话框可见）', async () => {
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '测试订阅',
    loginUrl: 'function login(){\n  return true;\n}\n',
    loginUi: '@js:(function(){ throw new Error("boom-importScript"); })()',
  } as RssSourceRaw);
  const r = await new RssEngine().login(rule, REQ, makeCtx().ctx);
  assert.match(String(r.message), /登录界面（loginUi）脚本求值失败/, `必须看到原因：${r.message}`);
  assert.match(String(r.message), /boom-importScript/, '原始错误信息要带上，便于定位');
  assert.equal(r.fields?.length ?? 0, 0, '没有行可渲染');
});

/**
 * `#423`：**打开对话框**（`GET /login`）要能拿到脚本型 `loginUi` 的行 —— 用显式伪动作
 * 「只渲染、不执行登录脚本」（读接口零副作用）。
 */
test('#423：LOGIN_UI_RENDER_ACTION 只渲染 loginUi，不执行登录脚本（打开对话框即出表单）', async () => {
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '测试订阅',
    // 登录脚本会写源变量（有副作用）——「只渲染」必须**不触发**它
    loginUrl: 'function login(){ source.setVariable("RAN"); return true; }\n',
    loginUi: '@js:JSON.stringify([{name:"账号",type:"text"},{name:"登录",type:"button",action:"login()"}])',
  } as RssSourceRaw);
  const { ctx } = makeCtx();
  const r = await new RssEngine().login(
    rule,
    { action: 'login', loginAction: LOGIN_UI_RENDER_ACTION } as unknown as UnifiedRequest,
    ctx,
  );
  assert.equal(r.action, 'form', `应回表单行：${JSON.stringify(r)}`);
  assert.equal(r.fields?.length, 2, `行数组要来自 loginUi：${JSON.stringify(r.fields)}`);
  assert.equal(r.ok, true);
  assert.equal(String(ctx.variables.get('sourceVariable') ?? ''), '', '读接口零副作用：登录脚本不得被执行');
});

test('#423【对偶】：不带伪动作时行为不变（表单闸门仍给「请先填写登录信息再登录」）', async () => {
  const rule = compileRssSource({
    sourceUrl: 'https://a.test/feed',
    sourceName: '测试订阅',
    loginUrl: 'function login(){ return true; }\n',
    loginUi: '@js:JSON.stringify([{name:"账号",type:"text"}])',
  } as RssSourceRaw);
  const r = await new RssEngine().login(rule, REQ, makeCtx().ctx);
  assert.match(String(r.message), /请先填写登录信息/, `闸门语义不得被本次改动影响：${r.message}`);
  assert.equal(r.fields?.length, 1);
});
