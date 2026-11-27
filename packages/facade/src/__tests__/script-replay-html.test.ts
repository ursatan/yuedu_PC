/**
 * 脚本（`.js`）请求的过闸重放**只能接受脚本原文**，不能接受浏览器阅读器 DOM。
 *
 * 现场：五个 qyyuapi 系漫画源（MYCOMIC / 漫画柜 / Komiic / 拷贝漫画 / 热辣漫画）
 * 同时报 `Unexpected token '<'`，且 chromium 被拉到 `qyyuapi.com/sy/js/...` 上。
 * 根因：`403 + 0 字节`（TLS 指纹拦截）原本认不出 WAF ⇒ 不重放；
 * 偶发重放成功时拿回的是「文本阅读器」DOM ⇒ 当脚本交给引擎 ⇒ 报错并被缓存。
 *
 * 锁三件事：
 *  ① 脚本 403 空体也要进重放（否则这五个源永远走镜像/手动下载）；
 *  ② 重放结果是 HTML ⇒ 丢弃，引擎只拿到原 403（交给镜像兜底），绝不返回 HTML；
 *  ③ 脚本重放失败**不记 netChallenge**（不能把 `.js` URL 丢进人工验证窗）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineHub, noopSandbox, type HubOptions } from '../index';
import type { RuleEngine, EngineContext, UnifiedRequest, UnifiedListResult } from '@yuedu/core';

const JS_URL = 'https://qyyuapi.com/sy/js/热辣漫画/jsLib.js';
const JS_BODY = 'function Get(url) { return url; }\nvar Reload = function (u) { return Get(u); };\n';
/** Chromium 打开 `.js` 时自动生成的阅读器文档 */
const VIEWER_HTML =
  '<html><head><meta name="color-scheme" content="light dark"></head>' +
  '<body><pre style="word-wrap: break-word; white-space: pre-wrap;">' +
  'function Get(url) { return url; }' +
  '</pre></body></html>';

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

test('脚本 403 空体 ⇒ 进重放；重放返回 JS 原文 ⇒ 引擎拿到脚本', async () => {
  let replayCalls = 0;
  const kind = 'probeScriptA';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 403, headers: {}, body: '', url: JS_URL } as never;
      },
    }),
    antibotReplay: async () => {
      replayCalls += 1;
      return { html: JS_BODY };
    },
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, JS_URL));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'SCRIPT_A' });

  const r = (await hub.run('home', 'SCRIPT_A', { action: 'home', page: 1 })) as UnifiedListResult & {
    netChallenge?: { urls: string[] };
  };
  assert.equal(replayCalls, 1, '403 + 0 字节的脚本请求必须进过闸重放');
  assert.equal(r.items[0]!.title, JS_BODY, '引擎必须拿到脚本原文');
  assert.equal(r.netChallenge, undefined);
});

test('脚本重放成了阅读器 HTML ⇒ 丢弃并回退原 403，绝不把 HTML 当脚本', async () => {
  const kind = 'probeScriptB';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 403, headers: {}, body: '', url: JS_URL } as never;
      },
    }),
    antibotReplay: async () => ({ html: VIEWER_HTML }),
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, JS_URL));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'SCRIPT_B' });

  const r = (await hub.run('home', 'SCRIPT_B', { action: 'home', page: 1 })) as UnifiedListResult & {
    netChallenge?: { urls: string[] };
  };
  assert.equal(r.items[0]!.title, '', '丢弃 HTML 后引擎拿到的是原 403 空体，而不是阅读器 DOM');
  assert.equal(r.netChallenge, undefined, '脚本失败不得触发人工验证窗');
});

test('脚本重放失败 ⇒ 不记 netChallenge（不能把 .js URL 丢进验证窗）', async () => {
  const kind = 'probeScriptC';
  const hub = new EngineHub({
    sandbox: noopSandbox,
    httpFactory: () => ({
      async request() {
        return { status: 403, headers: {}, body: '', url: JS_URL } as never;
      },
    }),
    antibotReplay: async () => null,
  } as unknown as HubOptions);
  hub.registerEngine(makeProbeEngine(kind, JS_URL));
  hub.importSource({ __kind: kind, name: 'p' }, { id: 'SCRIPT_C' });

  const r = (await hub.run('home', 'SCRIPT_C', { action: 'home', page: 1 })) as {
    netChallenge?: { urls: string[] };
    items?: Array<{ title?: string }>;
  };
  assert.equal(r.netChallenge, undefined);
});
