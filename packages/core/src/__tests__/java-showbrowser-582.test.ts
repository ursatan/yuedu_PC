/**
 * `#582` `java.showBrowser(url, html)` —— 七猫评论面板（段评/本章评）依赖的 API。
 *
 * 源 jsLib 自绘评论：内容里的 SVG 气泡图带 `{"click":"qmC_OpenComment(...)"}`，
 * 该函数调 `java.showBrowser('https://api-cmnt.wtzw.com/', html, …)`。
 * 我们此前没有这个 API（Proxy 兜底空函数）⇒ 点击静默无反应。
 *
 * 锁三处（引擎 L1 / worker / 页面内 java 垫片）都有它，且语义一致：
 * html → data URL（http base 补 `<base href>`）、走 `browser` 通道、fire-and-forget。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('#582 L1 java 桩：showBrowser 把 HTML 包成 data URL 并通知宿主', () => {
  const JS = read('selector/js.ts');
  assert.match(JS, /showBrowser: \(url: unknown, html: unknown\)/, 'L1 必须有 showBrowser');
  assert.match(JS, /htmlToDataUrl\(body, base\)/, '必须复用 HTML→data URL 的唯一实现');
  assert.match(JS, /function htmlToDataUrl\([\s\S]*?data:text\/html;base64,/, 'data URL 前缀必须是 text/html;base64');
  assert.match(JS, /<base href="' \+ base\.replace\(\/"\/g, '&quot;'\)/, 'http base 必须补 <base href>');
  assert.match(JS, /onBrowserOpen\?\.\(target, 'show'\)/, 'fire-and-forget ⇒ kind=show（应用内浏览器）');
});

test('#582 worker 侧：showBrowser 同名语义（模板串内禁止反引号）', () => {
  const W = read('sandbox/worker-pool.ts');
  assert.match(W, /showBrowser: \(url, html\) =>/, 'worker 必须有 showBrowser');
  assert.match(W, /rpcNoWait\('browser', \{ url: u, kind: 'show' \}\)/, 'worker 也要走 browser 通道');
  assert.match(W, /'data:text\/html;base64,' \+ Buffer\.from\(h, 'utf8'\)\.toString\('base64'\)/, 'worker 也要转 data URL');
});

test('#582 页面内 java 垫片：内容/启动页两条通路都提供 showBrowser', () => {
  const SHELL = readFileSync(new URL('../../../../apps/web/src/utils/html-shell.ts', import.meta.url), 'utf8');
  const hits = SHELL.match(/showBrowser:function\(u,h\)/g) ?? [];
  assert.ok(hits.length >= 2, `内容垫片与启动页垫片都应提供 showBrowser（实际 ${hits.length} 处）`);
  assert.match(SHELL, /btoa\(unescape\(encodeURIComponent\(t\)\)\)/, '沙箱里必须用 btoa 编 base64');
  assert.match(SHELL, /'startBrowser'/, '展示出口与 startBrowser 同一条报文');
});
