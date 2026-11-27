/**
 * `#642`（`#11`）**挑战页升级 needVerification** —— 三件事必须一起锁住：
 *
 * ① **判据**：CF 硬拦截页（`Attention Required` / `cf-error-details` / `Error 1020`）
 *    常回 **404**，且没有 `Just a moment`、没有 `challenge-platform` ⇒ 旧代码的
 *    「403/503+弱特征」与「任意状态+强特征」两条分支**一条都不进** ⇒ 不重放、不记任何东西
 *    ⇒ 引擎把拦截页当正文解析 ⇒ **静默 0 条**（用户报的就是这个）。
 * ② **记账**：重放失败（渲染空 / 抛错 / 冷却中）时把 URL 记进 `netChallenge`，
 *    这是服务端「开验证窗 + 回 needVerification」的唯一输入。
 * ③ **不误报**：重放成功、以及普通页面，都**不能**带 `netChallenge`
 *    ——否则前端会给正常源乱弹验证浮层（`#564` 的残留脚本教训）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineHub, noopSandbox, type HubOptions } from '../index';
import type { RuleEngine, EngineContext, UnifiedRequest, UnifiedListResult } from '@yuedu/core';

/** 真实的 CF「Access Denied（1020 / 1015）」页头（截自 CF 默认错误页，非 JS 挑战） */
const CF_BLOCK_BODY =
  '<!DOCTYPE html><html><head><title>Access denied | www.example.com used Cloudflare</title></head>' +
  '<body><h1>Attention Required! | Cloudflare</h1>' +
  '<div id="cf-error-details"><span>Error 1020</span> Ray ID: 8a1b2c3d4e5f</div></body></html>';

/** 普通正文页（含站点自己的「验证」字样也要判成非挑战 —— 判据看盾方特征，不看这个词） */
const NORMAL_BODY =
  '<html><head><title>玄幻小说排行榜</title></head><body>' +
  '<div class="col-md-6"><dl><dd><h3><a href="/b/1/">开局一座神秘岛</a></h3></dd></dl></div>' +
  '<p>本站已开启邮箱验证</p></body></html>';

/** 只发一次请求、把响应体整个塞进卡片标题的探针引擎（能直观看出「引擎拿到了什么」） */
function makeProbeEngine(kind: string, url: string): RuleEngine<unknown, unknown> {
  return {
    kind,
    version: '0.0.0',
    capabilities: ['home'],
    detect: (raw: unknown) => (raw as Record<string, unknown>)?.['__kind'] === kind,
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    async home(_rule: unknown, _req: UnifiedRequest, ctx: EngineContext): Promise<UnifiedListResult> {
      const r = await ctx.http.request(url);
      return {
        items: [{ id: 'x', kind: 'book', title: String(r.body ?? ''), layout: 'grid-card', payload: {} }],
        page: { page: 1, pageCount: 1, total: 1, hasMore: false },
      };
    },
  } as unknown as RuleEngine<unknown, unknown>;
}

interface ChallengeMarker {
  count: number;
  via: string;
  urls: string[];
}

test('`#642` ①：404 + CF 硬拦截页（无 Just a moment）⇒ **仍要认成挑战页并尝试重放**', async () => {
  let replayCalls = 0;
  const kind = 'probe642a';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 404, headers: {}, body: CF_BLOCK_BODY, url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      replayCalls += 1;
      return { html: '<html><body><div class="col-md-6">真页面</div></body></html>' };
    },
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, 'https://m.example.test/list/1.html'));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'P642A' });

  const r = (await hub.run('home', 'P642A', { action: 'home', page: 1 })) as UnifiedListResult & {
    netChallenge?: ChallengeMarker;
  };
  assert.equal(replayCalls, 1, '404 也要进重放（修复前两条判据都不认 ⇒ 重放次数为 0）');
  assert.equal(r.netChallenge, undefined, '重放成功 ⇒ 不得带 netChallenge（否则前端乱弹验证浮层）');
  assert.ok(String(r.items[0]!.title).includes('真页面'), '引擎拿到的是渲染后的真页面');
});

test('`#642` ②：重放拿不到东西 ⇒ 结果带 `netChallenge`（服务端据此开验证窗）', async () => {
  const kind = 'probe642b';
  const url = 'https://m.example.test/list/1.html';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 404, headers: {}, body: CF_BLOCK_BODY, url: '' } as never;
      },
    }),
    // 有头 Chrome 也没过盾：`antibotPassPage` 失败时就是返回 null（同时已开好验证会话）
    antibotReplay: async () => null,
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, url));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'P642B' });

  const r = (await hub.run('home', 'P642B', { action: 'home', page: 1 })) as UnifiedListResult & {
    netChallenge?: ChallengeMarker;
  };
  assert.ok(r.netChallenge, '必须带 netChallenge（修复前这里是 undefined ⇒ 前端只见 0 条）');
  assert.equal(r.netChallenge!.urls[0], url, '带上的必须是引擎真正撞盾的那个 URL');
  assert.match(r.netChallenge!.via, /Cloudflare/, 'via 要能让人看出是哪一类拦截');
  assert.equal(r.netChallenge!.count, 1);
});

test('`#642` ②b：重放抛错 / 冷却中 也照样记账（这三种失败都是一回事）', async () => {
  const kind = 'probe642c';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 403, headers: {}, body: '<title>Just a moment...</title>', url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      throw new Error('未找到可用的完整浏览器');
    },
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, 'https://waf.test/a'));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'P642C' });

  const r1 = (await hub.run('home', 'P642C', { action: 'home', page: 1 })) as { netChallenge?: ChallengeMarker };
  assert.ok(r1.netChallenge, '重放抛错 ⇒ 记账（开不出验证窗的原因要能被上游看到）');

  // 同一 URL 10 分钟内第二次：走冷却分支，仍然要给 marker（不能让用户「第二次就静默」）
  const r2 = (await hub.run('home', 'P642C', { action: 'home', page: 2 })) as { netChallenge?: ChallengeMarker };
  assert.ok(r2.netChallenge, '冷却中直接回退 ⇒ 仍要带 marker');
});

test('`#642` ③：普通正文页 ⇒ 完全不进重放、不带 `netChallenge`（不误伤）', async () => {
  let replayCalls = 0;
  const kind = 'probe642d';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 200, headers: {}, body: NORMAL_BODY, url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      replayCalls += 1;
      return { html: '<html>x</html>' };
    },
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, 'https://ok.test/list/1.html'));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'P642D' });

  const r = (await hub.run('home', 'P642D', { action: 'home', page: 1 })) as { netChallenge?: ChallengeMarker };
  assert.equal(replayCalls, 0, '正常页不该触发渲染（省额度、也避免误弹浮层）');
  assert.equal(r.netChallenge, undefined);
});
