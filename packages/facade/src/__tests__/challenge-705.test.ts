/**
 * `#705` **SafeLine（雷池 WAF）468 挑战页** —— 厂长资源 `www.cz4k.com` 实测（`#638` SELECTOR_MISS 组）。
 *
 * 现场：首页与分类页都回 **HTTP 468**、正文 14,454 字节；头部 144 字节处是
 * `/.safeline/static/favicon.png`，尾部 `/.safeline/challenge/v2/challenge.js`。
 * 页面里**没有** `captcha` / 「安全验证」字样 ⇒ 修复前：
 *   · `CHALLENGE_STATUS` 不含 468；
 *   · `isChallengePage` 的弱词/CF 强特征一条都不命中
 * ⇒ 不重放、不记账 ⇒ 引擎把挑战页当正文解析 ⇒ 列表静默 0 条（`SELECTOR_MISS`）。
 *
 * 本用例锁三件事：
 * ① 468 + SafeLine 页 ⇒ **必须**进反爬重放；
 * ② 重放失败 ⇒ 结果带 `netChallenge`（服务端据此开验证窗，不再静默）；
 * ③ **468 本身不是判据**：468 + 普通页面（无 SafeLine 痕迹）不得触发重放（不误伤）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineHub, noopSandbox, type HubOptions } from '../index';
import type { RuleEngine, EngineContext, UnifiedRequest, UnifiedListResult } from '@yuedu/core';

/** SafeLine 挑战页（按实测页头部与尾部结构裁剪；长度 < 20KB 体积门） */
const SAFELINE_BODY =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<link rel="icon" href="/.safeline/static/favicon.png" type="image/png"><title id="slg-title"></title>' +
  '<style>:root{--primary-color:#3A383F}#slg-bg{background-color:var(--primary-color);position:fixed;inset:0}' +
  '#slg-box{position:fixed;top:50%;left:50%;width:90%;max-width:40rem;height:15rem}</style></head>' +
  '<body><div id="slg-bg"></div><div id="slg-box"></div>' +
  '<script src="/.safeline/challenge/v2/challenge.js"></script></body></html>';

/** 普通正文页（状态码同为 468，但没有任何 SafeLine 痕迹） */
const NORMAL_468_BODY =
  '<html><head><title>最新电影</title></head><body><ul class="bt_img"><li><a href="/x/1.html">某电影</a></li></ul></body></html>';

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

test('`#705` ①：468 + SafeLine 挑战页 ⇒ 必须进重放，拿到真页面后不带 netChallenge', async () => {
  let replayCalls = 0;
  const kind = 'probe705a';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 468, headers: {}, body: SAFELINE_BODY, url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      replayCalls += 1;
      return { html: '<html><body><ul class="bt_img"><li>真页面</li></ul></body></html>' };
    },
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, 'https://www.cz4k.com/zuixindianying/page/1'));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'P705A' });

  const r = (await hub.run('home', 'P705A', { action: 'home', page: 1 })) as UnifiedListResult & {
    netChallenge?: ChallengeMarker;
  };
  assert.equal(replayCalls, 1, '468 必须进重放（修复前 CHALLENGE_STATUS 不含 468 ⇒ 重放次数为 0）');
  assert.equal(r.netChallenge, undefined, '重放成功 ⇒ 不得带 netChallenge');
  assert.ok(String(r.items[0]!.title).includes('真页面'), '引擎拿到的是渲染后的页面');
});

test('`#705` ②：468 + SafeLine、重放拿不到东西 ⇒ 带 netChallenge（via 能看出是 SafeLine）', async () => {
  const kind = 'probe705b';
  const url = 'https://www.cz4k.com/zuixindianying/page/1';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 468, headers: {}, body: SAFELINE_BODY, url: '' } as never;
      },
    }),
    antibotReplay: async () => null,
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, url));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'P705B' });

  const r = (await hub.run('home', 'P705B', { action: 'home', page: 1 })) as UnifiedListResult & {
    netChallenge?: ChallengeMarker;
  };
  assert.ok(r.netChallenge, '必须记账（修复前这里是 undefined ⇒ 前端只见 0 条）');
  assert.equal(r.netChallenge!.urls[0], url);
  assert.match(r.netChallenge!.via, /SafeLine/, 'via 要能让人看出是雷池 WAF');
});

test('`#705` ③：468 本身不是判据 —— 普通页面（无 SafeLine 痕迹）不触发重放', async () => {
  let replayCalls = 0;
  const kind = 'probe705c';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 468, headers: {}, body: NORMAL_468_BODY, url: '' } as never;
      },
    }),
    antibotReplay: async () => {
      replayCalls += 1;
      return { html: '<html>x</html>' };
    },
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, 'https://normal.test/list/1.html'));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'P705C' });

  const r = (await hub.run('home', 'P705C', { action: 'home', page: 1 })) as { netChallenge?: ChallengeMarker };
  assert.equal(replayCalls, 0, '没有 SafeLine 痕迹的 468 不得触发渲染（避免误伤）');
  assert.equal(r.netChallenge, undefined);
});
