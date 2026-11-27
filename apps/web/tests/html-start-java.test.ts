/**
 * `#418` **RSS 启动页 `java` 垫片**的回归锁 —— 直接**执行**壳层生成的那段脚本，断言语义。
 *
 * ## 缺陷类别（用户报障）
 * 「📖 Lofter 启动页按钮点击无法正确加载信息」。LOFTER（`rss/json/id/901`）的启动页是一整页
 * SPA：`loadRank` / `loadSubscrCols` / `updateColCount` / `updateAuthor` 全走 `Host.ajax(url)`
 * → **同步** `java.ajax`；标签/合集/历史走 `source.getVariable/putVariable/get/put`。
 * 旧垫片只垫了 `open`/`base64`/`toast` ⇒ 点按钮全部静默无效。
 *
 * ## 为什么必须**真跑**（而不是 grep 字符串）
 * 两半语义都只有跑起来才看得到：① `java.ajax` 是**同步**语义 ⇒ 必须发 `sync XHR`；
 * ② `source.getVariable()` 必须**同步**返回预置值（`postMessage` 回不来值）。
 * 只锁字符串的话，把 `ajax` 换成异步实现、或把 `getVariable` 写成走 RPC 都能过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStartPageJavaShim, buildHtmlDoc } from '../src/utils/html-shell';

interface Req { m: string; u: string; h: Record<string, string>; b: unknown }

/** 假环境里跑垫片；返回 window 视图、发出的 XHR 请求与 postMessage 报文 */
function run(opts: { origin?: string; sid?: string; variable?: string; status?: number } = {}) {
  const reqs: Req[] = [];
  const msgs: unknown[] = [];
  const win = {} as Record<string, any>;
  class XHR {
    m = ''; u = ''; h: Record<string, string> = {}; b: unknown = null;
    open(m: string, u: string) { this.m = m; this.u = u; }
    setRequestHeader(k: string, v: string) { this.h[k] = v; }
    send(b: unknown) { this.b = b; reqs.push({ m: this.m, u: this.u, h: this.h, b }); }
    get status() { return opts.status ?? 200; }
    get responseText() { return '{"ok":1}'; }
  }
  const parent = { postMessage: (m: unknown) => msgs.push(m) };
  const src = buildStartPageJavaShim({
    origin: opts.origin ?? 'http://127.0.0.1:3000',
    sid: opts.sid ?? 'rss_lof',
    variable: opts.variable ?? '',
  });
  // eslint-disable-next-line no-new-func
  new Function('window', 'parent', 'XMLHttpRequest', 'btoa', 'atob', 'unescape', src)(
    win, parent, XHR,
    (x: string) => Buffer.from(x, 'binary').toString('base64'),
    (x: string) => Buffer.from(x, 'base64').toString('binary'),
    (x: string) => decodeURIComponent(x),
  );
  return { win, reqs, msgs };
}

test('#418 垫片 · `source.getVariable()` 同步返回预置的源变量快照', () => {
  const { win } = run({ variable: '{"tags":["a"]}' });
  assert.equal(win['source'].getVariable(), '{"tags":["a"]}');
  // 从未设置过 ⇒ 空串（对齐 BaseSource.getVariable()，**不是** '{}'）
  assert.equal(run({}).win['source'].getVariable(), '');
});

test('#418 垫片 · `source.setVariable()` 同时更新闭包值与回宿主持久化', () => {
  const { win, msgs } = run({ variable: '' });
  win['source'].setVariable('{"k":1}');
  assert.equal(win['source'].getVariable(), '{"k":1}', '沙箱页内必须立刻读得到新值');
  assert.deepEqual(msgs, [{ yueduStartJava: { m: 'putVariable', args: ['{"k":1}'] } }]);
});

test('#418 垫片 · `java.ajax` GET → 同步 XHR 打 `/api/proxy`（带 sid，无 body）', () => {
  const { win, reqs } = run({ sid: 'rss_lof' });
  const out = win['java'].ajax('https://api.lofter.com/newapi/hotsearch/ranklist.json?product=x');
  assert.equal(out, '{"ok":1}');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.m, 'GET');
  assert.ok(reqs[0]!.u.startsWith('http://127.0.0.1:3000/api/proxy?u='), '必须走服务端代理（opaque origin 直连读不到）');
  assert.ok(reqs[0]!.u.includes('&sid=rss_lof'), 'sid 用于服务端补源级 header');
  assert.ok(reqs[0]!.u.includes(encodeURIComponent('https://api.lofter.com/newapi/hotsearch/ranklist.json?product=x')));
  assert.equal(reqs[0]!.b, null);
});

test('#418 垫片 · `java.ajax` 带 `,{method:POST,body}` 尾巴 ⇒ POST + 表单体', () => {
  const { win, reqs } = run({});
  win['java'].ajax('https://api.lofter.com/v2.0/blogHomePage.api?product=x,{"method":"POST","body":"targetblogid=1&postid=2"}');
  assert.equal(reqs[0]!.m, 'POST');
  assert.equal(reqs[0]!.b, 'targetblogid=1&postid=2');
  // text/plain = CORS 简单请求（不触发预检）；服务端再改写回 urlencoded 转发上游
  assert.equal(reqs[0]!.h['Content-Type'], 'text/plain;charset=UTF-8');
  assert.ok(reqs[0]!.u.includes(encodeURIComponent('https://api.lofter.com/v2.0/blogHomePage.api?product=x')), 'URL 本体不含 `,{…}` 尾巴');
});

test('#418 垫片 · `java.ajax` 无 origin / 非 http(s) / 上游 4xx ⇒ 空串（不抛）', () => {
  assert.equal(run({ origin: '' }).win['java'].ajax('https://api.lofter.com/x.json'), '', 'file:// 态没有可代理的服务端');
  assert.equal(run({}).win['java'].ajax('data:;base64,AAA'), '', '非 http(s) 不发请求');
  assert.equal(run({ status: 502 }).win['java'].ajax('https://api.lofter.com/x.json'), '', '上游失败按空串（源侧自会 toast）');
});

test('#418 垫片 · `java.open(kind,url,title)` 三名一起回宿主（title 供阅读页标题）', () => {
  const { win, msgs } = run({});
  win['java'].open('rss', 'https://api.lofter.com/oldapi/post/detail.api?x=1', '某篇热文');
  assert.deepEqual(msgs, [
    { yueduStartJava: { m: 'open', args: ['rss', 'https://api.lofter.com/oldapi/post/detail.api?x=1', '某篇热文'] } },
  ]);
});

test('#418 垫片 · `java.openUrl` / `java.startBrowser` / `androidId` 就位', () => {
  const { win, msgs } = run({});
  win['java'].openUrl('https://www.lofter.com/x');
  win['java'].startBrowser('https://www.lofter.com/front/account/login', '');
  assert.deepEqual(msgs.map((m) => (m as { yueduStartJava: { m: string } }).yueduStartJava.m), ['openUrl', 'startBrowser']);
  assert.equal(win['java'].androidId(), '0000000000000000', '与引擎桩同值');
});

test('#418 垫片 · 宿主注入顺序：`startDoc` 的 extraHead 里垫片在 startJs（extraBody）之前', () => {
  const shim = buildStartPageJavaShim({ origin: 'http://127.0.0.1:3000', sid: 's' });
  const doc = buildHtmlDoc('<div id="list-content"></div>', {
    origin: 'http://127.0.0.1:3000',
    sid: 's',
    extraHead: '<script>' + shim + '<\/script>',
    extraBody: '<script>window.__START_JS__=1<\/script>',
  });
  const atShim = doc.indexOf('yueduStartJava');
  const atJs = doc.indexOf('__START_JS__');
  assert.ok(atShim > 0 && atJs > 0);
  assert.ok(atShim < atJs, '垫片必须先于源作者的 startJs 就位（否则 `java` 未定义）');
});

test('#418 垫片 · 生成的脚本**不能有反引号**与字面 script 闭合标签', () => {
  const s = buildStartPageJavaShim({ origin: 'http://127.0.0.1:3000', sid: 's', variable: '{"a":1}' });
  assert.doesNotMatch(s, /`/);
  assert.doesNotMatch(s, /<\/script/i);
});