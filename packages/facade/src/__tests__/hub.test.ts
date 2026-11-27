/**
 * EngineHub 自测：用内置 mock 引擎验证「导入 / 状态强制 / 聚合搜索」。
 * 不依赖任何具体引擎包，保证 facade 的引擎无关性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EngineHub,
  SourceStore,
  noopSandbox,
  pickFirstExploreUrl,
  type HubOptions,
} from '../index';
import type {
  RuleEngine,
  EngineContext,
  UnifiedRequest,
  UnifiedListResult,
  UnifiedDetail,
  UnifiedContent,
  EngineAction,
  UnifiedItem,
} from '@yuedu/core';
import { LOGIN_INFO_PREFIX, LOGIN_HEADER_PREFIX } from '@yuedu/core';

// ---- mock 引擎：认领 kind=echo，search 返回源 id 拼关键字 ----
function makeEchoEngine(): RuleEngine<unknown, unknown> {
  const itemsFor = (sourceId: string, kw: string): UnifiedItem[] => [
    { id: `${sourceId}::1`, kind: 'book', title: `${kw}-A`, layout: 'grid-card', payload: {} },
    { id: `${sourceId}::2`, kind: 'book', title: `${kw}-B`, layout: 'grid-card', payload: {} },
  ];
  return {
    kind: 'echo',
    version: '0.0.0',
    capabilities: ['search', 'home', 'category'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'echo',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async search(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedListResult> {
      const sourceId = _ctx.sourceId;
      return {
        items: itemsFor(sourceId, req.keyword ?? ''),
        page: { page: req.page ?? 1, pageCount: 1, total: 2, hasMore: false },
      };
    },
    async home(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedListResult> {
      return { items: itemsFor(_ctx.sourceId, 'home'), page: { page: req.page ?? 1, pageCount: 1, total: 2, hasMore: false } };
    },
  };
}

function makeHub(opts: HubOptions = {}): EngineHub {
  const hub = new EngineHub({ sandbox: noopSandbox, ...opts });
  hub.registerEngine(makeEchoEngine());
  return hub;
}

const RAW_A = { __kind: 'echo', name: '源A' };
const RAW_B = { __kind: 'echo', name: '源B' };

test('importSource: 自动 detect + compile + 入库', () => {
  const hub = makeHub();
  const a = hub.importSource(RAW_A, { id: 'A' });
  assert.equal(a.kind, 'echo');
  assert.equal(a.id, 'A');
  assert.equal(hub.listSources().length, 1);
  assert.equal(hub.listSources({ kind: 'echo' }).length, 1);
});

test('SourceState: 禁用总开关后 search 抛 SOURCE_DISABLED', async () => {
  const hub = makeHub();
  hub.importSource(RAW_A, { id: 'A' });
  hub.setSourceState('A', { enabled: false });
  await assert.rejects(() => hub.search('A', 'x'), (e: Error) => e.message.includes('SOURCE_DISABLED'));
});

/**
 * `#428`（`D12`=A，用户 2026-10-12 拍板）**按源忽略 TLS 校验**的接线锁。
 *
 * 两半语义都要锁：
 *  ① `resolveSourceState` 里它是**唯一默认 false 的开关**（安全默认，与另三条相反）；
 *  ② 开了它 ⇒ `hub.makeContext` **唯一接线点**给每个请求注入 `allowInsecureTls: true`
 *     （三引擎 + worker `java.ajax` 全经 `ctx.http`，一处包住即全覆盖）。
 * 只锁①的话，接错层（比如漏包 httpFactory）也能过。
 */
test('#428 SourceState.allowInsecureTls：默认关（安全默认）', () => {
  const hub = makeHub();
  const a = hub.importSource(RAW_A, { id: 'A' });
  assert.equal(a.state.allowInsecureTls, false, '没显式开 ⇒ 保持校验');
  assert.equal(hub.sources.get('A')?.state.allowInsecureTls, false);
  hub.setSourceState('A', { allowInsecureTls: true });
  assert.equal(hub.sources.get('A')?.state.allowInsecureTls, true, '显式开 ⇒ 生效');
  hub.setSourceState('A', { allowInsecureTls: false });
  assert.equal(hub.sources.get('A')?.state.allowInsecureTls, false, '可关回');
});

/**
 * `#704` 假页面必须**像真页面的长度**（>500 字节）。
 *
 * 这里原来写的是 `'<html>真页面内容</html>'`（18 字符），于是从 `a13045c`（`#668`）起这条用例必红：
 * 那次治理给「重放成功缓存」加了「内容 <500 字节 ⇒ 视为空壳、丢弃」的守卫（防「渲染出登录页/空壳」
 * 被当成成功缓存反复返回），18 字符的假页面写进缓存当场被判空壳删掉 ⇒ 第二次请求又重放一次
 * ⇒ 「同 URL 只渲染一次」永远等于 2。**是假页面不真实，不是缓存坏了**
 * （对照取证 `tmp/probe704-481-fixture.mts`：18 字符 → 2 次 / 577 字符 → 1 次）。
 */
const REPLAY_HTML = `<html><head><title>真页面</title></head><body>${'<p>正文段落占位文字</p>'.repeat(40)}</body></html>`;

/**
 * `#704` 「403 挑战页 + 重放」骨架：`#481`/`#518` 那组用例共用。
 * `home` 里连发两次同一个 URL（= 用户回看已读章节 / 点刷新正文），把两次拿到的字节数写进标题。
 */
function makeWafHub(replayHtml: string): { hub: EngineHub; calls: string[] } {
  const calls: string[] = [];
  const engine: RuleEngine<unknown, unknown> = {
    kind: 'probe704',
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'probe704',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      const r1 = await ctx.http.request('https://x.test/list/1');
      const r2 = await ctx.http.request('https://x.test/list/1');
      return {
        items: [
          { id: 'x', kind: 'book', title: `b1=${String(r1.body).length} b2=${String(r2.body).length}`, layout: 'grid-card', payload: {} },
        ],
        page: { page: req.page ?? 1, pageCount: 1, total: 0, hasMore: false },
      };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 403, headers: {}, body: '<!DOCTYPE html><title>Just a moment...</title>cloudflare challenge', url: '' } as never;
      },
    }),
    antibotReplay: async (url: string, sourceId: string) => {
      calls.push(`${sourceId}|${url}`);
      return { html: replayHtml };
    },
  } as unknown as HubOptions);
  hub.registerEngine(engine);
  hub.importSource({ __kind: 'probe704', name: 'p' }, { id: 'P' });
  return { hub, calls };
}

/** `#704` 白盒通道：成功缓存是私有 Map，改时间戳/内容才能在毫秒级验证 TTL 与内容守卫 */
function antibotBag(hub: EngineHub): Map<string, { html: string; at: number }> {
  return (hub as unknown as { antibotHtml: Map<string, { html: string; at: number }> }).antibotHtml;
}

test('`#481`/`#518` ctx.http：403+WAF ⇒ 重放；**同一 URL 第二次命中成功缓存（不再 403）**', async () => {
  const calls: string[] = [];
  const engine: RuleEngine<unknown, unknown> = {
    kind: 'probe481',
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'probe481',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      const r1 = await ctx.http.request('https://x.test/list/1');
      // `#518` 同 URL 第二次（= 用户回看已读章节 / 点刷新正文）必须仍拿到真页面，
      // 不能因为「重放过的 URL 进冷却」而返回 403 —— 这正是用户实测立案的缺陷。
      const r2 = await ctx.http.request('https://x.test/list/1');
      return {
        items: [
          { id: 'x', kind: 'book', title: `b1=${String(r1.body).length} b2=${String(r2.body).length}`, layout: 'grid-card', payload: {} },
        ],
        page: { page: req.page ?? 1, pageCount: 1, total: 0, hasMore: false },
      };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        // WAF 挑战页：403 + 特征文本（title 在前 2048 字内）
        return { status: 403, headers: {}, body: '<!DOCTYPE html><title>Just a moment...</title>cloudflare challenge', url: '' } as never;
      },
    }),
    antibotReplay: async (url: string, sourceId: string) => {
      calls.push(`${sourceId}|${url}`);
      return { html: REPLAY_HTML };
    },
  } as unknown as HubOptions);
  hub.registerEngine(engine);
  hub.importSource({ __kind: 'probe481', name: 'p' }, { id: 'P' });
  const r = (await hub.run('home', 'P', { action: 'home', page: 9 })) as UnifiedListResult;
  const n = REPLAY_HTML.length;
  assert.equal(r.items[0]!.title, `b1=${n} b2=${n}`, `两次都拿到 ${n} 字真页面（修复前第二次是 403 挑战页 66 字）`);
  assert.equal(calls.length, 1, '同 URL 只渲染一次（第二次命中成功缓存，不重复消耗渲染额度）');
});

test('`#704` 成功缓存过了 TTL ⇒ 重新渲染（缓存不能变成永久）', async () => {
  const { hub, calls } = makeWafHub(REPLAY_HTML);
  await hub.run('home', 'P', { action: 'home', page: 1 });
  assert.equal(calls.length, 1, '前置：第一次请求走重放');
  const key = 'P|https://x.test/list/1';
  const cur = antibotBag(hub).get(key);
  assert.ok(cur, '前置：重放成功必须留下成功缓存（否则「回看不再 403」无从谈起）');
  // 把时间戳推到 TTL 之外（10 分钟），模拟「用户十分钟后回看本章」
  antibotBag(hub).set(key, { html: cur!.html, at: Date.now() - 11 * 60_000 });
  /**
   * ⚠️ 必须 `noCache: true`：`#480` 的**浏览缓存**（home/category 120s）会让第二次 run
   * 直接返回上次的结果 —— 引擎根本不会再发请求，于是这条用例测到的其实是浏览缓存，
   * 而不是 `#518` 的重放缓存（第一版就是这么假绿的：calls 卡在 1）。
   */
  const r = (await hub.run('home', 'P', { action: 'home', page: 1 }, undefined, { noCache: true })) as UnifiedListResult;
  assert.equal(calls.length, 2, '过期 ⇒ 必须重新渲染，不能拿过期 HTML 当成功结果');
  assert.equal(String(r.items[0]!.title), `b1=${REPLAY_HTML.length} b2=${REPLAY_HTML.length}`, '重渲染后仍返回真页面');
});

test('`#704` 缓存里已是挑战页 ⇒ 丢弃并重渲染（`#668` 守卫，也是上一条假页面必须够长的原因）', async () => {
  const { hub, calls } = makeWafHub(REPLAY_HTML);
  await hub.run('home', 'P', { action: 'home', page: 1 });
  const key = 'P|https://x.test/list/1';
  assert.equal(calls.length, 1);
  // 长度够、但内容仍是挑战页：模拟「TTL 内站点重新立闸 / 渲染出验证页」——不能被当成功缓存返回
  antibotBag(hub).set(key, {
    html: `<html><head><title>Just a moment...</title></head><body>${'x'.repeat(600)}</body></html>`,
    at: Date.now(),
  });
  /**
   * ⚠️ 必须 `noCache: true`：`#480` 的**浏览缓存**（home/category 120s）会让第二次 run
   * 直接返回上次的结果 —— 引擎根本不会再发请求，于是这条用例测到的其实是浏览缓存，
   * 而不是 `#518` 的重放缓存（第一版就是这么假绿的：calls 卡在 1）。
   */
  const r = (await hub.run('home', 'P', { action: 'home', page: 1 }, undefined, { noCache: true })) as UnifiedListResult;
  assert.equal(calls.length, 2, '缓存内容是挑战页 ⇒ 丢弃并重新渲染');
  assert.equal(
    String(r.items[0]!.title),
    `b1=${REPLAY_HTML.length} b2=${REPLAY_HTML.length}`,
    '返回给引擎的必须是真页面，不是那份挑战页',
  );
});

test('`#519` preflight 命中 ⇒ **跳过 HTTP 直连**，直接走重放', async () => {
  let httpCalls = 0;
  let replayCalls = 0;
  const engine: RuleEngine<unknown, unknown> = {
    kind: 'probe519',
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'probe519',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      const r = await ctx.http.request('https://waf.test/chapter/1');
      return {
        items: [
          { id: 'x', kind: 'book', title: `body=${String(r.body)}`, layout: 'grid-card', payload: {} },
        ],
        page: { page: req.page ?? 1, pageCount: 1, total: 0, hasMore: false },
      };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        httpCalls += 1;
        return { status: 403, headers: {}, body: '<title>Just a moment...</title>', url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      replayCalls += 1;
      return { html: '<html>rendered</html>' };
    },
    antibotPreflight: () => true,
  } as unknown as HubOptions);
  hub.registerEngine(engine);
  hub.importSource({ __kind: 'probe519', name: 'p519' }, { id: 'P519' });
  const r = (await hub.run('home', 'P519', { action: 'home', page: 1 })) as UnifiedListResult;
  assert.equal(r.items[0]!.title, 'body=<html>rendered</html>', '直接返回渲染结果');
  assert.equal(httpCalls, 0, '命中 preflight ⇒ 一次 HTTP 都不该发');
  assert.equal(replayCalls, 1, '只渲染一次');
});

test('`#518` 重放**失败**仍进 10 分钟冷却（防打爆渲染额度，语义不能丢）', async () => {
  let calls = 0;
  const engine: RuleEngine<unknown, unknown> = {
    kind: 'probe518',
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'probe518',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      const r1 = await ctx.http.request('https://x.test/fail/1');
      const r2 = await ctx.http.request('https://x.test/fail/1');
      return {
        items: [
          {
            id: 'x',
            kind: 'book',
            title: `s1=${r1.status} s2=${r2.status}`,
            layout: 'grid-card',
            payload: {},
          },
        ],
        page: { page: req.page ?? 1, pageCount: 1, total: 0, hasMore: false },
      };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 403, headers: {}, body: '<title>Just a moment...</title>cloudflare', url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      calls += 1;
      return null; // 渲染也过不了 ⇒ 失败
    },
  } as unknown as HubOptions);
  hub.registerEngine(engine);
  hub.importSource({ __kind: 'probe518', name: 'p518' }, { id: 'P518' });
  const r = (await hub.run('home', 'P518', { action: 'home', page: 1 })) as UnifiedListResult;
  assert.equal(r.items[0]!.title, 's1=403 s2=403', '失败时两次都是原 403（不伪造成功）');
  assert.equal(calls, 1, '失败后进冷却：同一 URL 10 分钟内只尝试渲染一次');
});

test('`#483` 反爬重放**中途回收**的 cookie：本次 run 的后续请求必须带上（cookie store 不许抓快照）', async () => {
  const seen: string[] = [];
  const engine: RuleEngine<unknown, unknown> = {
    kind: 'probe483',
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'probe483',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      // 与 engine-legado 同一手法：请求头里的 Cookie 取自 `ctx.cookies.header()`
      const h = (): Record<string, string> => {
        const ck = ctx.cookies?.header?.() ?? '';
        return ck ? { Cookie: ck } : {};
      };
      await ctx.http.request('https://waf.test/list/1', { headers: h() });
      await ctx.http.request('https://waf.test/list/2', { headers: h() });
      return { items: [], page: { page: req.page ?? 1, pageCount: 1, total: 0, hasMore: false } };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  let hub2: EngineHub;
  const hub2Ref = () => hub2;
  hub2 = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request(url: string, opts?: Record<string, unknown>) {
        const headers = (opts?.['headers'] ?? {}) as Record<string, string>;
        seen.push(`${url} :: ${JSON.stringify(headers)}`);
        // 恒返回 CF 挑战页 ⇒ 每个 URL 都会触发一次重放（真站就是这么表现的）
        return { status: 403, headers: {}, body: '<!DOCTYPE html><title>Just a moment...</title>', url: '' } as never;
      },
    }),
    antibotReplay: async (_url: string, sourceId: string) => {
      // 模拟 server 侧的 cookie 回收（`hub.mergeSourceCookies`）
      hub2Ref().mergeSourceCookies(sourceId, { cf_clearance: 'TOKEN-483' });
      return { html: '<html>ok</html>' };
    },
  } as unknown as HubOptions);
  hub2.registerEngine(engine);
  hub2.importSource({ __kind: 'probe483', name: 'p' }, { id: 'P' });
  await hub2.run('home', 'P', { action: 'home' });
  assert.equal(seen.length, 2, '两次请求都发出去了');
  assert.doesNotMatch(seen[0]!, /cf_clearance/, '第一次请求时还没有 cookie（此时才刚撞挑战）');
  /**
   * ★ 修前这里是 `{}`：makeCookieStore 在源尚无 cookie 时抓到一个**游离**的 `{}`，
   *   而 mergeSourceCookies 把 cookie 写进了另一个对象 ⇒ 后续请求一个都看不到
   *   ⇒ 真站表现：日志一直「回收 cookie 4 条」，但每个 URL 依旧撞 CF、每次都弹浏览器。
   */
  assert.match(seen[1]!, /cf_clearance=TOKEN-483/, '第二次请求必须带上刚回收的 cookie');
});

test('`#481` ctx.http：403 但无 WAF 特征 ⇒ 不重放，原响应返回', async () => {
  let called = 0;
  const engine: RuleEngine<unknown, unknown> = {
    kind: 'probe481b',
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'probe481b',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      const r = await ctx.http.request('https://x.test/plain403');
      assert.equal(r.status, 403);
      return { items: [], page: { page: 1, pageCount: 1, total: 0, hasMore: false } };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 403, headers: {}, body: '普通 403 页（无特征词）', url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      called++;
      return { html: '<html>x</html>' };
    },
  } as unknown as HubOptions);
  hub.registerEngine(engine);
  hub.importSource({ __kind: 'probe481b', name: 'p' }, { id: 'P' });
  await hub.run('home', 'P', { action: 'home', page: 9 });
  assert.equal(called, 0, '无特征词不重放');
});

test('#428 ctx.http：源开了 allowInsecureTls ⇒ 每个请求都带上该选项', async () => {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const engine: RuleEngine<unknown, unknown> = {
    kind: 'probe428',
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'probe428',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      await ctx.http.request('https://x.test/a', { headers: { A: '1' } });
      return { items: [], page: { page: req.page ?? 1, pageCount: 1, total: 0, hasMore: false } };
    },
  } as unknown as RuleEngine<unknown, unknown>;
  const hub = new EngineHub({
    sandbox: noopSandbox,
    // 记录每次请求的 opts（`httpFactory` 是 hub 造 ctx.http 的入口 ⇒ 正好验证接线层）
    httpFactory: () => ({
      async request(_url: string, opts?: Record<string, unknown>) {
        seen.push(opts);
        return { status: 200, headers: {}, body: '', url: '' } as never;
      },
    }),
  } as unknown as HubOptions);
  hub.registerEngine(engine);
  hub.importSource({ __kind: 'probe428', name: 'p' }, { id: 'P' });

  //  浏览缓存后：两次 home 需不同 page 才会真发请求
  await hub.home('P');
  assert.equal(seen.at(-1)?.['allowInsecureTls'], undefined, '默认：不注入（保持严格校验）');

  hub.setSourceState('P', { allowInsecureTls: true });
  await hub.home('P', 2);
  assert.equal(seen.at(-1)?.['allowInsecureTls'], true, '开了 ⇒ 该源每个请求都注入');
  assert.equal((seen.at(-1)?.['headers'] as Record<string, string>)?.['A'], '1', '原有 opts 不能被覆盖掉');
  assert.equal(seen.length, 2, '两次 home 各发一次请求 —— 必须真的走过 httpFactory（否则本用例空转）');
});

test('SourceState: 仅禁用搜索但启用发现，search 失败 / home 成功', async () => {
  const hub = makeHub();
  hub.importSource(RAW_A, { id: 'A' });
  hub.setSourceState('A', { searchEnabled: false });
  await assert.rejects(() => hub.search('A', 'x'), (e: Error) => e.message.includes('SOURCE_DISABLED'));
  const h = await hub.home('A');
  assert.equal(h.items.length, 2);
});

test('run: 不支持的 action 抛 UNSUPPORTED_ACTION', async () => {
  const hub = makeHub();
  hub.importSource(RAW_A, { id: 'A' });
  await assert.rejects(() => hub.run('play' as EngineAction, 'A', { action: 'play' }), (e: Error) =>
    e.message.includes('UNSUPPORTED_ACTION'),
  );
});

test('aggregateSearch: 并发遍历已启用源，逐源产出 items', async () => {
  const hub = makeHub();
  hub.importSource(RAW_A, { id: 'A' });
  hub.importSource(RAW_B, { id: 'B' });
  const events: string[] = [];
  let itemCount = 0;
  for await (const ev of hub.aggregateSearch('狼', { concurrency: 2 })) {
    events.push(ev.type);
    if (ev.type === 'items') itemCount += ev.items.length;
  }
  // 两个源都 done + 各自 items；item 总数 2*2
  assert.equal(itemCount, 4);
  assert.ok(events.filter((t) => t === 'done').length >= 2);
});

test('aggregateSearch: 禁用搜索的源不参与聚合', async () => {
  const hub = makeHub();
  hub.importSource(RAW_A, { id: 'A' });
  hub.importSource(RAW_B, { id: 'B', state: { searchEnabled: false } });
  let itemCount = 0;
  for await (const ev of hub.aggregateSearch('狼', { concurrency: 2 })) {
    if (ev.type === 'items') itemCount += ev.items.length;
  }
  assert.equal(itemCount, 2); // 仅 A 贡献
});

test('SourceStore: 缺省 state 归一为全 true', () => {
  const store = new SourceStore();
  const s = store.add({ id: 'x', kind: 'echo', raw: {}, rule: {} });
  assert.equal(s.state.enabled, true);
  assert.equal(s.state.searchEnabled, true);
  assert.equal(s.state.exploreEnabled, true);
  store.setState('x', { exploreEnabled: false });
  assert.equal(store.get('x')!.state.exploreEnabled, false);
  assert.equal(store.get('x')!.state.searchEnabled, true);
});

// ---- M5：源编辑 / 删除 / 批量校验 ----

test('replaceSource: 替换 raw 重新编译，id 与 state 保持', () => {
  const hub = makeHub();
  hub.importSource(RAW_A, { id: 'A' });
  hub.setSourceState('A', { searchEnabled: false });

  const r = hub.replaceSource('A', { __kind: 'echo', name: '源A改' });
  assert.equal(r.id, 'A');
  assert.equal(r.kind, 'echo');
  assert.equal(r.name, '源A改');
  // 开关保留
  assert.equal(hub.listSources()[0]!.state.searchEnabled, false);
  // raw 已替换
  assert.equal((hub.sources.get('A')!.raw as Record<string, unknown>)['name'], '源A改');
});

test('replaceSource: 不存在的 id 抛 SOURCE_NOT_FOUND', () => {
  const hub = makeHub();
  assert.throws(() => hub.replaceSource('nope', RAW_A), /SOURCE_NOT_FOUND/);
});

test('removeSource: 删除后列表减少、get 返回 undefined', () => {
  const hub = makeHub();
  hub.importSource(RAW_A, { id: 'A' });
  hub.importSource(RAW_B, { id: 'B' });
  assert.equal(hub.removeSource('A'), true);
  assert.equal(hub.removeSource('A'), false); // 幂等
  assert.equal(hub.sources.get('A'), undefined);
  assert.equal(hub.listSources().length, 1);
});

test('validateAll: 引擎未实现 validate 时视为通过', () => {
  const hub = makeHub(); // echo 引擎没有 validate
  hub.importSource(RAW_A, { id: 'A' });
  hub.importSource(RAW_B, { id: 'B', state: { enabled: false } });
  const r = hub.validateAll();
  assert.equal(r.total, 2);
  assert.equal(r.okCount, 2);
  assert.equal(r.failedCount, 0);
});

test('validateAll: 带 validate 的引擎按 issue.level 判定', () => {
  const hub = makeHub();
  // 给 echo 引擎补 validate：raw.name 为空时给 error
  const engine = hub.registry.get('echo')!;
  (engine as { validate?: unknown }).validate = (rule: unknown) =>
    (rule as Record<string, unknown>)['name'] ? [] : [{ level: 'error', path: 'name', message: '名称必填' }];
  hub.importSource(RAW_A, { id: 'A' }); // 有 name → ok
  hub.importSource({ __kind: 'echo' }, { id: 'C' }); // 无 name → error
  const r = hub.validateAll();
  assert.equal(r.total, 2);
  assert.equal(r.okCount, 1);
  assert.equal(r.failedCount, 1);
const failed = r.results.find((x) => x.id === 'C')!;
assert.equal(failed.ok, false);
});

// ---- 源校验（复刻 Legado CheckSourceService）----

function makeChainEngine(): RuleEngine<unknown, unknown> {
  return {
    kind: 'echo',
    version: '0.0.0',
    capabilities: ['search', 'detail', 'content'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'echo',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async search(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedListResult> {
      const empty = (req.keyword ?? '') === '空源';
      return {
        items: empty ? [] : [{ id: '0', kind: 'book', title: '书A', layout: 'grid-card', payload: { bookUrl: '/book/a' } }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    },
    async detail(_rule: unknown, _req: UnifiedRequest, _ctx: EngineContext) {
      return {
        title: '书A', author: '作者', intro: '', cover: undefined, tocUrl: '/book/a',
        chapters: [{ title: '第1章', payload: { chapterUrl: '/book/a/1' } }],
      } as never;
    },
    async content(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext) {
      const empty = String(req.id).includes('empty');
      return { paragraphs: empty ? [] : ['第一段', '第二段'], nextContentUrl: undefined } as never;
    },
  };
}

test('verifySource: 全链通过（搜索→详情→目录→正文）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const r = await hub.verifySource('A', { keyword: '测试' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '校验成功');
  assert.equal(r.stages.search?.ok, true);
  assert.equal(r.stages.info?.ok, true);
  assert.equal(r.stages.toc?.ok, true);
  assert.equal(r.stages.content?.ok, true);
  assert.ok(r.respondTime >= 0);
});

test('verifySource: 搜索 0 条 → 搜索失效，后续阶段不跑', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const r = await hub.verifySource('A', { keyword: '空源' });
  assert.equal(r.ok, false);
  assert.match(r.message, /搜索失效/);
  assert.equal(r.stages.info, undefined); // 详情未执行
});

test('verifySource: 正文为空 → 正文失效但目录通过', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  // 通过 content 的 id 注入空正文：detail 返回的 chapterUrl 含 'empty'
  const engine = hub.registry.get('echo')!;
  const origDetail = engine.detail?.bind(engine);
  (engine as { detail?: unknown }).detail = async (_rule: unknown, req: UnifiedRequest, ctx: EngineContext) => {
    const d = await origDetail?.(_rule, req, ctx);
    return { ...d, chapters: [{ title: '第1章', payload: { chapterUrl: '/book/a/empty' } }] } as never;
  };
  const r = await hub.verifySource('A', { keyword: '测试' });
  assert.equal(r.ok, false);
  assert.equal(r.stages.toc?.ok, true);
  assert.equal(r.stages.content?.ok, false);
  assert.match(r.message, /正文失效/);
});

// ---- `#694` 全链试跑的三个口径：关键词优先级 · 分段计时 · 分类显示名 ----

test('#694 ① 工坊调试：用户输入的关键词**优先于**源的 checkKeyWord', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource(
    { __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}', ruleSearch: { checkKeyWord: '仙逆' } },
    { id: 'A' },
  );
  const r = await hub.verifySource('A', { keyword: '剑来' });
  // detail 里写的就是**实际用过的关键词**（旧实现把 checkKeyWord 报出来，静态误导）
  assert.match(String(r.stages.search?.detail), /剑来/);
  assert.doesNotMatch(String(r.stages.search?.detail), /仙逆/);
});

test('#694 ② 自动校验：不传 keyword ⇒ 用源自己的 checkKeyWord（上游 getCheckKeyword 语义）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource(
    { __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}', ruleSearch: { checkKeyWord: '仙逆' } },
    { id: 'A' },
  );
  const r = await hub.verifySource('A', { checkSearch: true, checkInfo: false });
  assert.match(String(r.stages.search?.detail), /仙逆/);
});

test('#694 ③ checkKeyWord 不合法（含 `::`/`http`/`++`/`--`）⇒ 回落「我的」，显式关键词仍优先', async () => {
  for (const bad of ['http://x.com/k', 'a::b', 'a++b', 'a--b']) {
    const hub = new EngineHub({ sandbox: noopSandbox });
    hub.registerEngine(makeChainEngine());
    hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}', ruleSearch: { checkKeyWord: bad } }, { id: 'A' });
    const r = await hub.verifySource('A', { checkInfo: false });
    assert.match(String(r.stages.search?.detail), /我的/, `checkKeyWord=${bad} 应回落「我的」`);
  }
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}', ruleSearch: { checkKeyWord: 'a::b' } }, { id: 'A' });
  const r = await hub.verifySource('A', { keyword: '输入词', checkInfo: false });
  assert.match(String(r.stages.search?.detail), /输入词/);
});

test('#694 ④ 目录段没有独立请求 ⇒ 不报 ms（否则四段相加 ≠ 汇总耗时）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const r = await hub.verifySource('A', { keyword: '测试' });
  assert.equal(r.stages.toc?.ok, true);
  assert.equal(typeof r.stages.info?.ms, 'number', '详情段有自己的耗时');
  assert.equal(r.stages.toc?.ms, undefined, '目录段不能复用详情的耗时');
  assert.match(String(r.stages.toc?.detail), /随详情返回/);
});

test('#694 ⑤ 发现链：自动挑选的分类把**显示名**带进结果（不再只给 URL）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeKindsOnlyEngine());
  hub.importSource({ __kind: 'kinds-only', name: '只回分类的源', exploreUrl: 'https://x.com/c/{{page}}' }, { id: 'K' });
  const out = await hub.verifySource('K', {
    checkSearch: false, checkInfo: false, checkContent: false, checkCategory: false, checkDiscoveryDeep: false,
  });
  assert.equal(out.stages.explore?.ok, true, out.message);
  assert.match(String(out.stages.explore?.detail), /分类「玄幻」/);
});

test('#694 ⑥ 发现链深校验：exploreToc 同搜索链不报 ms；explorePick 带 name 时显示分类名', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeKindsOnlyEngine());
  hub.importSource({ __kind: 'kinds-only', name: '只回分类的源', exploreUrl: 'https://x.com/c/{{page}}' }, { id: 'K' });
  const out = await hub.verifySource('K', {
    checkSearch: false,
    checkDiscoveryDeep: true,
    explorePick: { key: '分类', value: 'https://x.com/class/1.html', name: '玄幻' },
  });
  assert.equal(out.stages.exploreToc?.ok, true, out.message);
  assert.equal(out.stages.exploreToc?.ms, undefined);
  assert.match(String(out.stages.exploreToc?.detail), /随详情返回/);
  assert.match(String(out.stages.explore?.detail), /分类「玄幻」/);
});

test('#694 ⑦ pickFirstExploreUrl 顺带带出分类名（没有 name 时不凭空造键）', () => {
  assert.deepStrictEqual(pickFirstExploreUrl([{ key: 'k', options: [{ name: '热血', value: 'u1' }] }]), {
    key: 'k', value: 'u1', name: '热血',
  });
  assert.deepStrictEqual(pickFirstExploreUrl([{ key: 'k', options: [{ value: 'u1' }] }]), { key: 'k', value: 'u1' });
  assert.deepStrictEqual(pickFirstExploreUrl([{ key: 'k', options: [{ name: '  ', value: 'u1' }] }]), { key: 'k', value: 'u1' });
});

// ---- `#695` 流式校验：逐段回调 ----

test('#695 ① onStage 按执行顺序逐段回调，且与最终 stages 完全一致', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const seen: Array<{ stage: string; ok: boolean; ms?: number; detail?: string }> = [];
  const r = await hub.verifySource('A', { keyword: '测试', onStage: (stage, s) => seen.push({ stage, ...s }) });
  assert.deepEqual(seen.map((x) => x.stage), ['search', 'info', 'toc', 'content'], '顺序 = 执行顺序');
  for (const x of seen) {
    const final = r.stages[x.stage as keyof typeof r.stages];
    assert.deepEqual({ ok: x.ok, ms: x.ms, detail: x.detail }, { ok: final?.ok, ms: final?.ms, detail: final?.detail });
  }
});

test('#695 ② 失败段也回调（否则界面只能等到最后才知道卡在哪）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const seen: string[] = [];
  const r = await hub.verifySource('A', { keyword: '空源', onStage: (stage) => seen.push(stage) });
  assert.equal(r.ok, false);
  assert.deepEqual(seen, ['search'], '搜索就挂了 ⇒ 只该有这一段');
});

test('#695 ③ 回调抛异常不影响校验结论（流式通道故障 ≠ 源坏了）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const r = await hub.verifySource('A', {
    keyword: '测试',
    onStage: () => {
      throw new Error('SSE 写失败');
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.stages.content?.ok, true);
});

// ---- `#696` 调试信息流（对齐 Legado Debug.log）----

test('#696 ① 编排行齐全且顺序正确（⇒访问 → ︾解析 → ︽完成，详情/目录由 onPartial 分段）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const seen: Array<{ msg: string; level?: string; at: number }> = [];
  const r = await hub.verifySource('A', { keyword: '测试', onLog: (l) => seen.push(l) });
  assert.equal(r.ok, true);
  const msgs = seen.map((x) => x.msg);
  for (const want of [
    '⇒开始搜索关键字:测试',
    '︾开始解析搜索页',
    '︽搜索页解析完成',
    '︾开始解析详情页',
    '︽详情页解析完成',
    '︾开始解析目录页',
    '︽目录页解析完成',
    '︾开始解析正文页',
    '︽正文页解析完成',
  ]) {
    assert.ok(msgs.includes(want), `缺少信息流行「${want}」，实际：${msgs.join(' | ')}`);
  }
  // 详情完成与目录开始必须**相邻**（这是 onPartial 那个分界点的意义，否则两行会排在目录日志之后）
  assert.equal(msgs.indexOf('︾开始解析目录页'), msgs.indexOf('︽详情页解析完成') + 1);
  // 时间戳单调不减（前端据此算 [mm:ss.mmm]）
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.at >= seen[i - 1]!.at);
});

test('#696 ② 引擎侧 ctx.trace 里带 msg 的条目会变成信息流一行（┌/└ 来自引擎而不是门面）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const engine = hub.registry.get('echo')!;
  const origSearch = engine.search!.bind(engine);
  (engine as { search?: unknown }).search = async (...args: unknown[]) => {
    const ctx = args[2] as EngineContext;
    ctx.trace.push({ stage: 'parse', msg: '┌获取书籍列表' });
    ctx.trace.push({ stage: 'parse', msg: '└列表大小:1' });
    return origSearch(...(args as [never, never, never]));
  };
  const seen: string[] = [];
  await hub.verifySource('A', { keyword: '测试', checkInfo: false, onLog: (l) => seen.push(l.msg) });
  assert.ok(seen.includes('┌获取书籍列表'), seen.join(' | '));
  assert.ok(seen.includes('└列表大小:1'), seen.join(' | '));
});

test('#696 ③ 失败也要有结论行（搜索 0 条 ⇒ ︽未获取到书籍 + level=error）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const seen: Array<{ msg: string; level?: string }> = [];
  const r = await hub.verifySource('A', { keyword: '空源', onLog: (l) => seen.push(l) });
  assert.equal(r.ok, false);
  const last = seen[seen.length - 1]!;
  assert.match(last.msg, /未获取到书籍/);
  assert.equal(last.level, 'error');
});

test('#696 ④ 不传 onLog ⇒ 零开销（不抛错、结论不变）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const r = await hub.verifySource('A', { keyword: '测试' });
  assert.equal(r.ok, true);
});

// ---- `#697` 订阅源（rss）全链 + 中断 + 正文 html 形态 ----

/** mock 订阅源引擎：home 只回分类（sortUrl），category 给文章，detail 单篇，content 给 HTML 文档 */
function makeRssEngine(): RuleEngine<unknown, unknown> {
  return {
    kind: 'rss',
    version: '0.0.0',
    capabilities: ['home', 'category', 'search', 'detail', 'content'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'rss',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(): Promise<UnifiedListResult> {
      return {
        items: [],
        page: { page: 1, pageCount: 1, total: 0, hasMore: false },
        filters: [{ name: '分类', key: 'explore', options: [{ name: '写真', value: '/c/13' }] }],
      };
    },
    async category(): Promise<UnifiedListResult> {
      return {
        items: [{ id: '0', kind: 'article', title: '文章A', layout: 'text-row', payload: { link: '/a/1', title: '文章A' } }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    },
    async search(): Promise<UnifiedListResult> {
      return {
        items: [{ id: '0', kind: 'article', title: '搜到的文章', layout: 'text-row', payload: { link: '/a/2', title: '搜到的文章' } }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    },
    async detail(): Promise<UnifiedDetail> {
      return {
        title: '文章A', author: '', meta: {},
        chapters: [{ title: '文章A', payload: { link: '/a/1' } }],
      } as unknown as UnifiedDetail;
    },
    async content(): Promise<UnifiedContent> {
      // 订阅源的正文是 **HTML 文档**（`paragraphs` 与 `html` 互斥）
      return { paragraphs: [], html: '<p>正文</p>' } as unknown as UnifiedContent;
    },
  };
}

test('#697/#698 ① 订阅源：发现链只有「列表 + 内容页」两段（上游 RSS 调试口径）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeRssEngine());
  hub.importSource({ __kind: 'rss', sourceName: '订阅A', sourceUrl: 'https://x.test/', sortUrl: '写真::/c/13' }, { id: 'R' });
  assert.equal(hub.sources.get('R')?.kind, 'rss', '前置：源是 rss 类型');
  const out = await hub.verifySource('R', { checkSearch: false, checkDiscovery: true, checkDiscoveryDeep: true });
  assert.equal(out.stages.explore?.ok, true, `列表段应执行并成功，实际：${out.message}`);
  assert.equal(out.stages.exploreContent?.ok, true, '内容页应通过');
  assert.match(String(out.stages.exploreContent?.detail), /HTML 正文/, '正文形态是 HTML');
  // ★ 订阅源**没有**详情页/目录页（上游 Debug.kt 的 RSS 分支只有两段）
  assert.equal(out.stages.exploreInfo, undefined, '不应有「详情」段');
  assert.equal(out.stages.exploreToc, undefined, '不应有「目录」段');
});

test('#698 ⑤ 订阅源：信息流顺序与上游一致（⇒访问 → ︾解析 → 列表回执 → ︽列表页解析完成 → ︾内容页 → ︽完成）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeRssEngine());
  hub.importSource({ __kind: 'rss', sourceName: '订阅A', sourceUrl: 'https://x.test/', sortUrl: '写真::/c/13' }, { id: 'R' });
  const seen: string[] = [];
  const out = await hub.verifySource('R', { checkSearch: false, checkDiscovery: true, onLog: (l) => seen.push(l.msg) });
  assert.equal(out.ok, true, out.message);
  const iVisit = seen.findIndex((m) => m.startsWith('⇒开始访问分类页:'));
  const iParse = seen.indexOf('︾开始解析分类页');
  const iListDone = seen.indexOf('︽列表页解析完成');
  const iContentStart = seen.indexOf('︾开始解析内容页');
  const iContentDone = seen.indexOf('︽内容页解析完成');
  assert.ok(iVisit >= 0 && iParse === iVisit + 1, `⇒必须在︾之前且相邻：${seen.join(' | ')}`);
  assert.ok(iListDone > iParse && iListDone < iContentStart, '列表完成 → 内容页开始');
  assert.ok(iContentDone > iContentStart, '内容页完成在后');
  assert.ok(!seen.some((m) => /︾开始解析详情页|︾开始解析目录页/.test(m)), '订阅源不应出现详情/目录行');
});

test('#697 ② 订阅源：没配 searchUrl ⇒ 「搜索URL为空」（上游 Debug.kt:388，不是「搜索失效」）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeRssEngine());
  hub.importSource({ __kind: 'rss', sourceName: '订阅A', sourceUrl: 'https://x.test/', sortUrl: '写真::/c/13' }, { id: 'R' });
  const seen: string[] = [];
  const out = await hub.verifySource('R', { keyword: '美女', checkDiscovery: false, onLog: (l) => seen.push(l.msg) });
  assert.equal(out.ok, false);
  assert.match(out.message, /搜索URL为空/);
  assert.ok(seen.some((m) => /搜索URL为空/.test(m)), seen.join(' | '));
});

test('#697/#698 ③ 订阅源：有 searchUrl ⇒ 搜索链「列表 + 内容页」两段', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeRssEngine());
  hub.importSource(
    { __kind: 'rss', sourceName: '订阅A', sourceUrl: 'https://x.test/', searchUrl: '/s?k={{key}}', sortUrl: '写真::/c/13' },
    { id: 'R' },
  );
  const out = await hub.verifySource('R', { keyword: '美女', checkDiscovery: false });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.stages.search?.ok, true);
  assert.equal(out.stages.content?.ok, true);
  assert.equal(out.stages.info, undefined, '订阅源不跑详情页');
  assert.equal(out.stages.toc, undefined, '订阅源不跑目录页');
});

test('#698 ⑥ 订阅源：ruleDescription 有值 ⇒ 不解析内容页（上游 Debug.kt:341-350）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeRssEngine());
  hub.importSource(
    { __kind: 'rss', sourceName: '订阅A', sourceUrl: 'https://x.test/', searchUrl: '/s?k={{key}}', ruleDescription: '.desc@text' },
    { id: 'R' },
  );
  const seen: string[] = [];
  const out = await hub.verifySource('R', { keyword: 'a', checkDiscovery: false, onLog: (l) => seen.push(l.msg) });
  assert.equal(out.stages.search?.ok, true);
  assert.equal(out.stages.content, undefined, '描述规则已给正文 ⇒ 不跑内容页');
  assert.ok(seen.includes('⇒存在描述规则，不解析内容页'), seen.join(' | '));
});

test('#697 ④ 中断信号：opts.signal 透传到引擎 ctx.signal（换源/关页能真的停）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeRssEngine());
  hub.importSource({ __kind: 'rss', sourceName: '订阅A', sourceUrl: 'https://x.test/', searchUrl: '/s?k={{key}}' }, { id: 'R' });
  const engine = hub.registry.get('rss')!;
  const ac = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const origSearch = engine.search!.bind(engine);
  (engine as { search?: unknown }).search = async (...args: unknown[]) => {
    seenSignal = (args[2] as EngineContext).signal;
    ac.abort(); // 模拟「跑的时候用户换源了」
    return origSearch(...(args as [never, never, never]));
  };
  await hub.verifySource('R', { keyword: 'a', checkDiscovery: false, signal: ac.signal }).catch(() => undefined);
  assert.ok(seenSignal, '引擎侧必须拿到 signal');
  assert.equal(seenSignal!.aborted, true, '外部 abort 必须传播成 ctx.signal.aborted');
});

test('verifySources: 批量并发，单源失败不影响其它', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeChainEngine());
  hub.importSource({ __kind: 'echo', name: '源A', searchUrl: '/s/{{key}}' }, { id: 'A' });
  const r = await hub.verifySources(['A', '不存在的源'], { keyword: '测试', concurrency: 2 });
  assert.equal(r.length, 2);
  const byId = new Map(r.map((x) => [x.id, x.outcome]));
  assert.equal(byId.get('A')!.ok, true);
  assert.equal(byId.get('不存在的源')!.ok, false);
});

// ---------------------------------------------------------------------------
// 上下文存储必须跨请求存活（源变量 / 发现页 infoMap）——曾经每请求 new 一个内存 store
// ---------------------------------------------------------------------------

/** 会读写「源变量」的 mock 引擎：home 先读后写，用 storage + variables 模拟真实引擎行为 */
function makeVarEngine(): RuleEngine<unknown, unknown> {
  return {
    kind: 'varprobe',
    version: '0.0.0',
    capabilities: ['home', 'category', 'search'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'varprobe',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      // 模拟引擎的 primeSourceVariable / persistSourceVariable
      const saved = (await ctx.storage.get(`source-var:${ctx.sourceId}`)) ?? '{}';
      ctx.variables.set('sourceVariable', saved);
      const n = Number((JSON.parse(saved) as Record<string, string>)['hits'] ?? '0') + 1;
      ctx.variables.set('sourceVariable', JSON.stringify({ hits: String(n) }));
      await ctx.storage.set(`source-var:${ctx.sourceId}`, String(ctx.variables.get('sourceVariable')));
      return {
        items: [{ id: 'x', kind: 'book', title: `hits=${n}`, layout: 'grid-card', payload: {} }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    },
    async search(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      const saved = (await ctx.storage.get(`source-var:${ctx.sourceId}`)) ?? '(empty)';
      return {
        items: [{ id: 'x', kind: 'book', title: `read:${saved}`, layout: 'grid-card', payload: {} }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    },
  };
}

function makeVarHub(opts: HubOptions = {}): EngineHub {
  const hub = new EngineHub({ sandbox: noopSandbox, ...opts });
  hub.registerEngine(makeVarEngine());
  const { id } = hub.importSource({ __kind: 'varprobe', name: '变量源' });
  return Object.assign(hub, { __id: id }) as EngineHub & { __id: string };
}

test('storage 跨请求存活：源变量写入后下次请求可读到（七猫分组场景）', async () => {
  const hub = makeVarHub();
  const id = (hub as unknown as { __id: string }).__id;
  const first = (await hub.run('home', id, { action: 'home' })) as UnifiedListResult;
  assert.equal(first.items[0]?.title, 'hits=1');
  //  浏览缓存后：同 key 二次 home 会命中缓存，用 page:2 绕开（验证语义不变：任一次真发请求都能读到上次写入的源变量）
  const second = (await hub.run('home', id, { action: 'home', page: 2 })) as UnifiedListResult;
  assert.equal(second.items[0]?.title, 'hits=2', '第二次请求读到上次写入的源变量');
  const third = (await hub.run('search', id, { action: 'search' })) as UnifiedListResult;
  assert.equal(third.items[0]?.title, 'read:{"hits":"2"}', '无关 action 也能读到持久值');
});

test('storage 按源隔离：不同源互不影响', async () => {
  const hub = makeVarHub();
  const idA = (hub as unknown as { __id: string }).__id;
  const { id: idB } = hub.importSource({ __kind: 'varprobe', name: '变量源2', bookSourceUrl: 'https://b.test' });
  await hub.run('home', idA, { action: 'home' });
  await hub.run('home', idA, { action: 'home', page: 2 });
  const b1 = (await hub.run('home', idB, { action: 'home' })) as UnifiedListResult;
  assert.equal(b1.items[0]?.title, 'hits=1', 'B 源有自己的计数，不受 A 源影响');
});

test('sourceVariable 写回：引擎在 variables 里改的源变量会同步回 hub', async () => {
  const hub = makeVarHub();
  const id = (hub as unknown as { __id: string }).__id;
  await hub.run('home', id, { action: 'home' });
  await hub.run('home', id, { action: 'home', page: 2 });
  assert.equal(hub.getSourceVariable(id), '{"hits":"2"}', 'hub.getSourceVariable 与引擎写入一致');
});

/**
 * `§4.8d` 缺口 A：**删源必须清理源级运行时数据**。
 *
 * 旧实现删源只做 `sources.remove(id)`（一句 `map.delete`）⇒ 登录信息 / 登录头 / Cookie /
 * 源变量 / 源级 KV / 源缓存**全部残留**。症状是「删掉源、过几天重新导入同一个源，
 * **旧登录态与变量复活**」。用户 2026-09-25 决策：删源即清数据；源本身可从回收站恢复，
 * 但**数据不还原**（需重新登录/重新设置）。
 *
 * 键名与引擎的 `sourceStorageKeys()` 一致 —— 由服务端在 DELETE 端点组装后传入
 * （facade 不依赖 engine-legado，所以这里写死并加注释；端到端验证在服务端侧做）。
 */
test('§4.8d 缺口 A：purgeSourceData 清掉源级持久数据（登录信息/登录头/源变量/KV/缓存）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  const store = (hub as unknown as {
    storage: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };
  }).storage;
  const sid = 'src-purge';
  const engineKeys = [`source-var:${sid}`, `source-kv:${sid}`, `source-cache:${sid}`];
  const loginKeys = [`${LOGIN_INFO_PREFIX}${sid}`, `${LOGIN_HEADER_PREFIX}${sid}`];
  for (const k of [...engineKeys, ...loginKeys]) await store.set(k, 'x');

  // 同时塞内存态：不清这层，本进程后续请求仍会读到「已删除源」的旧值
  // （cache 内存层是**全局**一份，不按源 → 不在此列，见 purgeSourceData 头注）
  const mem = hub as unknown as {
    sourceVariables: Map<string, string>;
    sourceLoginInfo: Map<string, unknown>;
    sourceCookies: Map<string, unknown>;
  };
  mem.sourceVariables.set(sid, '{}');
  mem.sourceLoginInfo.set(sid, {});
  mem.sourceCookies.set(sid, {});

  const cleared = await hub.purgeSourceData(sid, engineKeys);
  assert.equal(cleared.length, 5, `应清掉 5 个持久键，实际 ${cleared.length}：${cleared.join(',')}`);
  for (const k of [...engineKeys, ...loginKeys]) {
    const v = await store.get(k);
    assert.ok(v == null || v === '', `${k} 必须被清掉（残留就是「旧登录态复活」的根因）`);
  }
  assert.equal(mem.sourceVariables.has(sid), false, '内存态源变量也要清');
  assert.equal(mem.sourceLoginInfo.has(sid), false, '内存态登录信息也要清');
  assert.equal(mem.sourceCookies.has(sid), false, '内存态 Cookie 也要清');
});

test('§4.8d 缺口 A：不传引擎键时只清登录类数据（不误删其它源的数据）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  const store = (hub as unknown as {
    storage: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };
  }).storage;
  await store.set(`source-var:other`, 'keep');
  await store.set(`${LOGIN_INFO_PREFIX}other`, 'keep');
  await hub.purgeSourceData('other'); // 不传 engineKeys
  // 不传引擎键 ⇒ 引擎侧数据不动（这是「调用方漏传」的可见后果，而不是静默全清）
  assert.equal(await store.get('source-var:other'), 'keep', '未传引擎键时不得顺手清掉引擎数据');
  assert.ok(
    (await store.get(`${LOGIN_INFO_PREFIX}other`)) == null,
    '登录信息无论如何都要清（它在 hub 的职责范围内）',
  );
});

// ---- `#152`：运行窗口内的文本截断 ⇒ 结果带 netTruncated（与「站点返回空」在界面分得开） ----
import { __resetTruncatedLogForTest, recordTruncatedFetch } from '@yuedu/core';

test('hub.run：运行期间登记的截断 ⇒ 结果附 netTruncated（水位取自引擎开跑前）', async () => {
  __resetTruncatedLogForTest();
  // 引擎在**运行中**登记截断（真实形态：net 层在引擎的 fetch 期间调 recordTruncatedFetch）
  const truncating: RuleEngine<unknown, unknown> = {
    kind: 'echo', version: '0', capabilities: ['search'],
    detect: (raw) => (raw as Record<string, unknown>)?.['__kind'] === 'echo',
    compile: (raw) => ({ ok: true, rule: raw, issues: [] }),
    async search(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      recordTruncatedFetch(`https://api.test/big?src=${ctx.sourceId}&chapter=1`, 12345);
      recordTruncatedFetch(`https://api.test/big?src=${ctx.sourceId}&chapter=2`, 23456);
      return { items: [], page: { page: 1, pageCount: 0, total: 0, hasMore: false } };
    },
  };
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(truncating);
  hub.importSource(RAW_A, { id: 'A' });
  // 防空转（成对断言的另一半）：先跑一次不登记的引擎 ⇒ 字段不许无条件出现
  const cleanHub = makeHub();
  cleanHub.importSource(RAW_A, { id: 'A' });
  const clean = await cleanHub.search('A', 'clean') as { netTruncated?: unknown };
  assert.equal(clean.netTruncated, undefined, '没有截断就不许挂 netTruncated');
  const r = await hub.search('A', 'with-trunc') as { netTruncated?: { count: number; urls: string[] } };
  assert.ok(r.netTruncated, '运行窗口内有截断 ⇒ 必须带 netTruncated');
  assert.equal(r.netTruncated?.count, 2);
  assert.deepEqual(r.netTruncated?.urls, ['https://api.test/big?src=A&chapter=1', 'https://api.test/big?src=A&chapter=2']);
});

/* ===================== `#199` 发现链判据：home → category 两步 =====================
 * 旧实现只打 `home` 并断言 `items > 0`。但**多数源的 home 只返回分类清单**
 * （`filters[].options[]`，items 为空）—— 前端 `stores/discover.ts` 的发现链正是两步。
 * ⇒ 这类源被误判「发现失效」，再被 `markOnError` 打上「校验失败」标签（好源被误伤）。
 *
 * 上游权威口径：`CheckSourceService.kt:361-370`
 *   `exploreKinds().firstOrNull { !it.url.isNullOrBlank() }?.url` → `exploreBookAwait(source, url)`
 */

/** mock 引擎：`home` 只回分类清单（items 空），`category` 才给列表 —— 复现真实源的形态 */
function makeKindsOnlyEngine(): RuleEngine<unknown, unknown> {
  return {
    kind: 'kinds-only',
    version: '0.0.0',
    capabilities: ['search', 'home', 'category', 'detail', 'content'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'kinds-only',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async search(): Promise<UnifiedListResult> {
      return { items: [], page: { page: 1, pageCount: 1, total: 0, hasMore: false } };
    },
    async home(): Promise<UnifiedListResult> {
      return {
        items: [],
        page: { page: 1, pageCount: 1, total: 0, hasMore: false },
        filters: [
          {
            name: '分类',
            key: '分类',
            options: [
              // 分组标题项（url 为空 / type:"text"）——上游口径要**跳过**
              { name: '热门', value: '', header: true },
              // 非 url 控件：值要靠 $input 回传，直接当分类请求必然空
              { name: '地区', value: 'bj', kind: 'select', chars: ['bj', 'sh'] },
              { name: '玄幻', value: 'https://x.com/class/1.html' },
            ],
          },
        ],
      };
    },
    async category(_rule: unknown, req: UnifiedRequest): Promise<UnifiedListResult> {
      const f = (req.filters ?? {}) as Record<string, string>;
      if (!f['分类']) {
        return { items: [], page: { page: 1, pageCount: 1, total: 0, hasMore: false } };
      }
      return {
        items: [{ id: 'c1', kind: 'book', title: '玄幻-1', layout: 'grid-card', payload: {} }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    },
    // ★ 返回类型必须匹配 `RuleEngine` 的签名（`UnifiedDetail` / `UnifiedContent`），
    //   写成自定义交叉类型会报 TS2322 —— 引擎接口不是 `any`。
    async detail(): Promise<UnifiedDetail> {
      return { title: '书', author: 'a', chapters: [{ title: '第1章', url: 'u1' }] } as unknown as UnifiedDetail;
    },
    async content(): Promise<UnifiedContent> {
      return { paragraphs: ['正文'] } as unknown as UnifiedContent;
    },
  };
}

test('#199 ① 挑选：跳过 header 与非 url 控件，取第一个有值的 url 项（对齐上游 firstOrNull{url非空}）', () => {
  const got = pickFirstExploreUrl([
    {
      key: '分类',
      options: [
        { value: '', header: true },
        { value: 'bj', kind: 'select' },
        { value: 'https://x.com/class/1.html' },
      ],
    },
  ]);
  assert.deepStrictEqual(got, { key: '分类', value: 'https://x.com/class/1.html' });
});

test('#199 ② kind 缺省视为 url（FilterOption 只在非 url 控件时才写 kind）', () => {
  assert.deepStrictEqual(pickFirstExploreUrl([{ key: 'k', options: [{ value: 'u1' }] }]), { key: 'k', value: 'u1' });
  assert.deepStrictEqual(pickFirstExploreUrl([{ key: 'k', options: [{ value: 'u1', kind: 'url' }] }]), { key: 'k', value: 'u1' });
});

test('#199 ③ 拿不到就返回 null，**不猜也不抛**（空 filters / 全是标题 / value 空白）', () => {
  assert.equal(pickFirstExploreUrl(undefined), null);
  assert.equal(pickFirstExploreUrl([]), null);
  assert.equal(pickFirstExploreUrl([{ key: 'k', options: [] }]), null);
  assert.equal(pickFirstExploreUrl([{ key: 'k', options: [{ value: '', header: true }] }]), null);
  assert.equal(pickFirstExploreUrl([{ key: 'k', options: [{ value: '   ' }] }]), null, '纯空白也算没有');
  assert.equal(pickFirstExploreUrl([{ key: '', options: [{ value: 'u' }] }]), null, '空 key 不可提交');
  assert.deepStrictEqual(
    pickFirstExploreUrl([{ key: 'a', options: [{ value: '' }] }, { key: 'b', options: [{ value: 'u2' }] }]),
    { key: 'b', value: 'u2' },
    '第一个分组没有可用项时要**继续往后找**，不能一遇空就返回 null',
  );
});

test('#199 ④ ★ 端到端：home 只回分类的源，校验**不再**被误判「发现失效」', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeKindsOnlyEngine());
  hub.importSource(
    { __kind: 'kinds-only', name: '只回分类的源', exploreUrl: 'https://x.com/class/{{page}}.html' },
    { id: 'K' },
  );
  // 前置：这条源必须真的「home 空 + category 有货」，否则下面的通过是假通过
  const h = await hub.home('K');
  assert.equal(h.items.length, 0, '前置：home 确实没给列表');
  assert.equal(h.filters?.length, 1, '前置：home 确实给了分类清单');
  const picked = pickFirstExploreUrl(h.filters);
  assert.ok(picked, '前置：能挑出分类');
  const c = await hub.category('K', { [picked.key]: picked.value }, 1);
  assert.equal(c.items.length, 1, '前置：打这个分类能拿到列表');

  const out = await hub.verifySource('K', { checkSearch: false, checkInfo: false, checkContent: false, checkCategory: false });
  assert.equal(out.stages.explore?.ok, true, `发现链应通过，实际：${out.message}`);
});

test('#199 ⑤ ★ 防空转：真正「两个动作都空」的源仍要判失败（不能为了修误判而放水）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  const base = makeKindsOnlyEngine();
  const broken: RuleEngine<unknown, unknown> = {
    ...base,
    kind: 'broken-explore',
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'broken-explore',
    async category(): Promise<UnifiedListResult> {
      // 分类请求打到了，但站点返回空 ⇒ 这才是真失效
      return { items: [], page: { page: 1, pageCount: 1, total: 0, hasMore: false } };
    },
  };
  hub.registerEngine(broken);
  hub.importSource({ __kind: 'broken-explore', name: '真失效源', exploreUrl: 'https://x.com/e' }, { id: 'B' });
  const out = await hub.verifySource('B', { checkSearch: false, checkInfo: false, checkContent: false, checkCategory: false });
  assert.equal(out.stages.explore?.ok, false, '两步都空 ⇒ 必须判失败');
  assert.equal(out.ok, false);
});

test('#199 ⑥ ★ home 已经有列表的源走**短路**（不多打一次 category，省一次站点请求）', async () => {
  let categoryCalls = 0;
  const hub = new EngineHub({ sandbox: noopSandbox });
  const base = makeEchoEngine();
  const counting: RuleEngine<unknown, unknown> = {
    ...base,
    kind: 'counting',
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'counting',
    async category(): Promise<UnifiedListResult> {
      categoryCalls += 1;
      return { items: [], page: { page: 1, pageCount: 1, total: 0, hasMore: false } };
    },
  };
  hub.registerEngine(counting);
  hub.importSource({ __kind: 'counting', name: '直出源', exploreUrl: 'https://x.com/h' }, { id: 'D' });
  const out = await hub.verifySource('D', { checkSearch: false, checkInfo: false, checkContent: false, checkCategory: false });
  assert.equal(out.stages.explore?.ok, true);
  assert.equal(categoryCalls, 0, 'home 已给列表 ⇒ 不该再打 category');
});

/**
 * `#354`：登录按钮动作可能**只改源变量**（禁漫天堂「切换国际线路 / 东南亚线路」——
 * `loginUi` 的 button `action` 跑 `loginUrl` 里的函数，函数内 `source.setVariable(...)`
 * 把 base url / shunt 写回）。
 *
 * 缺陷：`login()` 曾是 `return engine.login(rule, req, this.makeContext(id))`，**不回写**
 * hub 的内存映射 ⇒ `hub.getSourceVariable(id)` 读到旧值，且下次 `makeContext` 注入的
 * 也是旧值（虽然引擎 `primeSourceVariable` 会从 storage 补救，但那是「依赖下游」）。
 *
 * 本锁：`login()` 后内存映射必须与引擎写入一致（修前恒空 ⇒ 本用例必红）。
 */
function makeLoginEngine(): RuleEngine<unknown, unknown> {
  const base = makeEchoEngine();
  return {
    ...base,
    kind: 'loginable',
    capabilities: ['search', 'login'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'loginable',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async login(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext) {
      // 模拟源脚本：按钮动作只改源变量（不改 Cookie / 登录头）
      const cur = String(ctx.variables.get('sourceVariable') ?? '');
      const next = cur ? JSON.stringify({ ...JSON.parse(cur), shunt: 2 }) : JSON.stringify({ url: 'https://x.org', shunt: 2 });
      ctx.variables.set('sourceVariable', next);
      return { ok: true, action: 'server' as const, message: '按钮动作已执行（改了源变量，未涉及 Cookie）' };
    },
  };
}

test('#354 login(): 按钮动作改的源变量必须回写 hub 内存映射（修前恒空）', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeLoginEngine());
  hub.importSource({ __kind: 'loginable', name: '可登录源', loginUrl: '/*js*/' }, { id: 'L' });

  assert.equal(hub.getSourceVariable('L'), '', '动作前应无源变量');

  const r = await hub.login('L', { action: 'toggleShunt()' });
  assert.equal(r.ok, true);

  const after = hub.getSourceVariable('L');
  assert.notEqual(after, '', 'login() 必须回写源变量（修前这里恒空）');
  assert.equal((JSON.parse(after) as { shunt?: number }).shunt, 2, '回写的值要与引擎写入一致');

  // 对偶：不同源的源变量不得串（回写必须按 sourceId 隔离）
  assert.equal(hub.getSourceVariable('L2'), '', '未登录的源不得被污染');
});

/**
 * `#412`：登录流程的 **toast 收集槽**（与 `run()` 同一份约定）。
 *
 * 缺陷（2026-10-12 用户实测，苹果MCS·影视小说聚合）：`hub.login` 新建 ctx 时**没有** `ctx.toastSink`，
 * 而 RSS 引擎的 `makeRssEnv.onToast` 只写 `ctx.toastSink`（并打一条 `[rss-toast]` 日志）
 * ⇒ cmd 窗口看得到 toast、登录对话框只能显示兜底文案「按钮动作已执行」
 * （用户原话：「toast 信息未正确显示，反而 cmd 窗口信息正确显示了」）。
 * legado 引擎的登录会**显式传**自己的 toasts 数组，所以这条缺失只在 RSS 侧暴露 —— 也正因如此，
 * 光测引擎（自己塞 toastSink）测不出来，必须在 **hub 这一层**锁住。
 */
function makeToastLoginEngine(): RuleEngine<unknown, unknown> {
  const base = makeEchoEngine();
  return {
    ...base,
    kind: 'toastlogin',
    capabilities: ['search', 'login'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === 'toastlogin',
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async login(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext) {
      // 逐字模拟 engine-rss 的 onToast：**只写 ctx.toastSink**（宿主不给就只剩 cmd 日志）
      ctx.toastSink?.push('✅ 已切换：无尽');
      return { ok: true, action: 'server' as const, toasts: (ctx.toastSink ?? []).slice() };
    },
  };
}

test('#412 login(): hub 必须给 ctx.toastSink，否则源脚本的 toast 到不了登录界面', async () => {
  const hub = new EngineHub({ sandbox: noopSandbox });
  hub.registerEngine(makeToastLoginEngine());
  hub.importSource({ __kind: 'toastlogin', name: '带 toast 的源', loginUrl: '/*js*/' }, { id: 'T' });

  const r = await hub.login('T', { action: 'switchLine()' });
  assert.deepEqual(r.toasts, ['✅ 已切换：无尽'], '登录结果的 toasts 必须带上源脚本的原话（修前为 undefined）');
});
