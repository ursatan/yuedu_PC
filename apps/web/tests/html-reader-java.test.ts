/**
 * `#408(b)` **正文页 `java` 垫片**的回归锁 —— 直接**执行**壳层生成的那段脚本，断言语义。
 *
 * ## 缺陷类别（用户语料：18AV，WebView 型 RSS）
 * 这类源的 `ruleContent` 是**源作者写的整页播放器脚本**：
 * `eval(await window.importScriptAwait('…/artplayer.js'))`、`await playu(url)`、
 * `java.openVideoPlayer(u,title,true)`、`source.get/put(...)`。上游把这些符号
 * （`preloadJs`：`window.java/source/importScriptAwait/playu`）注入 WebView 全局；
 * 本仓正文 iframe 是 opaque origin ⇒ 必须由壳层垫片补上，否则页面脚本 ReferenceError。
 *
 * ## 为什么真跑（而不是 grep 字符串）
 * 垫片的核心是**行为**：postMessage 报文的形状（`m`/`args`/`id`）、RPC 的回填回路、
 * `source/cache` 的内存语义 —— 只对字符串做断言锁不住这些。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContentJavaShim, buildHtmlDoc } from '../src/utils/html-shell';

interface Msg {
  yueduReaderJava: { m: string; args: unknown[]; id: number };
}

/** 在假沙箱里执行垫片；返回 win / 发往父页的报文 / 触发 message 的入口 / 定时器记录 */
function run(org = '', sid = '') {
  const toParent: Msg[] = [];
  const listeners: Array<(e: { data?: unknown }) => void> = [];
  const timers: Array<{ ms: number }> = [];
  const fetches: string[] = [];
  /** 打桩 fetch 的返回是否 ok（`#449` ajaxAwait 依赖 `r.ok` 判成败） */
  const state = { ok: true };
  const win = { addEventListener: (_t: string, f: (e: { data?: unknown }) => void) => listeners.push(f) } as Record<
    string,
    unknown
  >;
  const parent = { postMessage: (m: Msg) => toParent.push(m) };
  const fetchFn = async (u: string) => {
    fetches.push(String(u));
    return { ok: state.ok, status: state.ok ? 200 : 403, text: async () => 'SCRIPT:' + String(u) };
  };
  const setTimeoutStub = (_fn: () => void, ms: number) => {
    timers.push({ ms });
    return 0;
  };
  /** `#446` 垫片会接管 `history.back`（宿主出口）⇒ 必须给一个可写对象 */
  const history: { back?: () => void; length: number } = { length: 1 };
  /** `#449` `ajaxAwait` 用 `document.baseURI` 把相对 URL 解析成绝对 */
  const documentStub = { baseURI: 'https://bbs.xiaoxiaoshuo8.com/forum.php?mod=viewthread&tid=348' };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window',
    'parent',
    'fetch',
    'Promise',
    'setTimeout',
    'btoa',
    'atob',
    'unescape',
    'escape',
    'navigator',
    'history',
    'document',
    buildContentJavaShim({ origin: org, sid }),
  );
  fn(
    win,
    parent,
    fetchFn,
    Promise,
    setTimeoutStub,
    btoa,
    atob,
    unescape,
    escape,
    { userAgent: 'UA-test' },
    history,
    documentStub,
  );
  const fire = (data: unknown) => listeners.forEach((f) => f({ data }));
  return { win, toParent, fire, timers, history, fetches, state };
}

test('#408(b) java.openVideoPlayer/openUrl/toast/base64 ⇒ 按规定形状 postMessage 给宿主', () => {
  const { win, toParent } = run();
  const java = win['java'] as {
    openVideoPlayer: (u: string, t: string, a: boolean) => void;
    openUrl: (u: string, m: string) => void;
    longToast: (m: string) => void;
    base64Encode: (s: string) => string;
    base64Decode: (s: string) => string;
  };
  java.openVideoPlayer('https://cdn.test/a.m3u8', '第1集', true);
  java.openUrl('https://cdn.test/b.mp4', 'video/*');
  java.longToast('未获取到播放链接');
  assert.deepEqual(toParent[0], {
    yueduReaderJava: { m: 'openVideoPlayer', args: ['https://cdn.test/a.m3u8', '第1集', true], id: 0 },
  });
  assert.deepEqual(toParent[1], {
    yueduReaderJava: { m: 'openUrl', args: ['https://cdn.test/b.mp4', 'video/*'], id: 0 },
  });
  assert.deepEqual(toParent[2], { yueduReaderJava: { m: 'toast', args: ['未获取到播放链接', true], id: 0 } });
  // base64 往返（源脚本用它拼 data: 分类 URL）
  assert.equal(java.base64Decode(java.base64Encode('/zh/chinese_list/all/1.html')), '/zh/chinese_list/all/1.html');
});

test('#408(b) source/cache 内存态：put→get 一致；未命中返回空串；cache.delete 不抛', () => {
  const { win } = run();
  const source = win['source'] as { get: (k: string) => string; put: (k: string, v: string) => string };
  const cache = win['cache'] as { get: () => string; delete: () => void };
  assert.equal(source.get('av18x'), '', '未命中 = 空串（源用 `if (!srcurl)` 判定）');
  assert.equal(source.put('av18x', 'https://cdn.test/1.m3u8'), 'https://cdn.test/1.m3u8');
  assert.equal(source.get('av18x'), 'https://cdn.test/1.m3u8');
  assert.equal(cache.get(), '');
  assert.doesNotThrow(() => cache.delete());
});

test('#408(b) importScriptAwait ⇒ fetch 文本（NET 桥已把 http(s) 改写到 /api/proxy）', async () => {
  const { win } = run();
  const f = win['importScriptAwait'] as (u: string) => Promise<string>;
  assert.equal(await f('https://unpkg.com/artplayer/dist/artplayer.js'), 'SCRIPT:https://unpkg.com/artplayer/dist/artplayer.js');
});

test('#408(b) playu ⇒ RPC：带 id 的 resolve 报文 + 宿主回填 yueduReaderJavaResult 后兑现', async () => {
  const { win, toParent, fire, timers } = run();
  const playu = win['playu'] as (u: string) => Promise<string>;
  const p = playu('https://18av.test/zh/x/1.html');
  const sent = toParent.at(-1)!.yueduReaderJava;
  assert.equal(sent.m, 'resolve');
  assert.deepEqual(sent.args, ['https://18av.test/zh/x/1.html']);
  assert.ok(sent.id > 0, 'RPC 必须带非 0 id（宿主据此回填）');
  assert.equal(timers.at(-1)?.ms, 15000, '超时兜底 15s（不挂住页面）');
  // 宿主回填
  fire({ yueduReaderJavaResult: { id: sent.id, value: 'https://cdn.test/real.m3u8' } });
  assert.equal(await p, 'https://cdn.test/real.m3u8');
});

test('#408(b) playu 对偶：宿主回空（解析失败）⇒ 兑现空串（源走「未获取到播放链接」分支）', async () => {
  const { win, toParent, fire } = run();
  const playu = win['playu'] as (u: string) => Promise<string>;
  const p = playu('https://18av.test/bad.html');
  const id = toParent.at(-1)!.yueduReaderJava.id;
  fire({ yueduReaderJavaResult: { id, value: '' } });
  assert.equal(await p, '');
});

test('#408(b) webViewGetSourceAwait 与 playu 同通道（源 preloadJs 用它取 m3u8）', async () => {
  const { win, toParent } = run();
  const w = win['webViewGetSourceAwait'] as (u: string) => Promise<string>;
  void w('https://18av.test/zh/x/2.html');
  assert.equal(toParent.at(-1)!.yueduReaderJava.m, 'resolve');
});

// ---------------------------------------------------------------------------
// 壳层注入的自门控（普通正文一字不改）
// ---------------------------------------------------------------------------

test('#408(b) buildHtmlDoc：含 WebView 型符号的正文才注入垫片；普通正文不注入', () => {
  const withApi = buildHtmlDoc('<body><script>setTimeout(async()=>{await playu("u")},50)</script></body>', {
    origin: 'http://127.0.0.1:3000',
    sid: 's',
  });
  assert.ok(withApi.includes('yueduReaderJava'), 'WebView 型正文必须注入垫片');

  const plain = buildHtmlDoc('<p>普通正文，没有播放器脚本</p>', { origin: 'http://127.0.0.1:3000', sid: 's' });
  assert.ok(!plain.includes('yueduReaderJava'), '普通正文不得注入（零回归面）');
});

test('#408(b) 垫片生成文本不含反引号 / 字面 script 闭合标签（srcdoc 拼接纪律）', () => {
  assert.doesNotMatch(buildContentJavaShim(), /`/);
  assert.doesNotMatch(buildContentJavaShim(), /<\/script/i);
});

// ---------------------------------------------------------------------------
// `#446`（2026-10-14）千白羽论坛：源自绘 UI 的动作类出口（返回 / 一键跳转）
// ---------------------------------------------------------------------------

test('#446 java.open / startBrowser ⇒ 动作类报文（宿主据此走源解析 / 页内浏览器）', () => {
  const { win, toParent } = run();
  const java = win['java'] as {
    open: (t: string, u: string, x: string) => void;
    startBrowser: (u: string, t: string) => void;
  };
  java.open('rss', 'https://bbs.test/index.php?mobile=2', '论坛');
  java.startBrowser('https://other.test/a', '一键跳转');
  assert.deepEqual(toParent[0], {
    yueduReaderJava: {
      m: 'open',
      args: ['rss', 'https://bbs.test/index.php?mobile=2', '论坛'],
      id: 0,
    },
  });
  assert.deepEqual(toParent[1], {
    yueduReaderJava: { m: 'startBrowser', args: ['https://other.test/a', '一键跳转'], id: 0 },
  });
});

test('#446 history.back 必须被垫片接管 ⇒ 报给宿主（否则与 Vue 的 navStack 脱同步）', () => {
  const { history, toParent } = run();
  assert.equal(typeof history.back, 'function', '垫片必须接管 history.back');
  history.back!();
  assert.deepEqual(toParent.at(-1)!.yueduReaderJava, { m: 'back', args: [], id: 0 });
});

test('#446 门控放宽：页内只出现 `java.某方法`（无播放器符号）也要注入垫片', () => {
  const withJava = buildHtmlDoc('<body><script>java.open("rss","https://x.test/")</script></body>', {
    origin: 'http://127.0.0.1:3000',
    sid: 's',
  });
  assert.ok(withJava.includes('yueduReaderJava'), '源自绘 UI 的动作类页面必须注入垫片');

  const plain = buildHtmlDoc('<p>普通正文，没有脚本</p>', { origin: 'http://127.0.0.1:3000', sid: 's' });
  assert.ok(!plain.includes('yueduReaderJava'), '普通正文不得注入（零回归面）');
});

// ---------------------------------------------------------------------------
// `#448` ② 「下载 HTML」的落盘位（用户复测：①③④ 通了、② 仍不出文件）
// ---------------------------------------------------------------------------

test('#449② window.ajaxAwait 由垫片提供（源「有就用」）⇒ 受控走 /api/proxy，失败要 reject + 留痕', async () => {
  const { win, toParent, fetches, state } = run('http://127.0.0.1:3000', 'sid1');
  const aw = win['ajaxAwait'] as (u: string, m?: string, b?: string, h?: unknown) => Promise<string>;
  assert.equal(typeof aw, 'function', '必须垫上（否则源自己装坏包装，退回依赖 NET 桥的 fetch）');
  // 相对 URL 按 document.baseURI 解析成绝对，再打代理（源抓楼层就是这种相对 URL）
  const txt = await aw('forum.php?mod=viewthread&tid=348&page=2&mobile=2');
  assert.equal(fetches.length, 1);
  assert.equal(
    fetches[0],
    'http://127.0.0.1:3000/api/proxy?u=' +
      encodeURIComponent('https://bbs.xiaoxiaoshuo8.com/forum.php?mod=viewthread&tid=348&page=2&mobile=2') +
      '&sid=sid1',
  );
  assert.match(txt, /^SCRIPT:/);
  // 非 2xx ⇒ **必须 reject**（返回空串会让源把「空响应」当成功、不再退回）+ toast 留痕
  state.ok = false;
  await assert.rejects(() => aw('forum.php?mod=viewthread&tid=348&page=3&mobile=2'), /HTTP 403/);
  const last = toParent.at(-1)!.yueduReaderJava;
  assert.equal(last.m, 'toast');
  assert.match(String(last.args[0]), /页面数据请求失败：HTTP 403/);
  // ORG 为空（file:// 态）⇒ 明确 reject，不静默直连
  const bare = run('', '');
  const aw2 = bare.win['ajaxAwait'] as (u: string) => Promise<string>;
  await assert.rejects(() => aw2('https://x.test/a'), /bad url/);
});

test('#448② java.downloadFile ⇒ 就地解码（hex / data:base64）并报文给宿主顶层落盘', () => {
  const { win, toParent } = run();
  const java = win['java'] as { downloadFile: (c: string, u?: string) => string };
  // 源第①通道：`java.downloadFile(_dlHex(html), 'https://…/_x8dl_<tid>.html,{"type":"html"}')`
  // '帖子' 的 UTF-8 字节 = e5 b8 96 e5 ad 90
  const rel = java.downloadFile('e5b896e5ad90', 'https://bbs.test/_x8dl_348.html,{"type":"html"}');
  assert.equal(rel, '_x8dl_348.html', '必须**同步**返回非空文件名（源据此判 `if(rel) ok=true`）');
  assert.deepEqual(toParent.at(-1), {
    yueduReaderJava: { m: 'downloadFile', args: ['_x8dl_348.html', '帖子'], id: 0 },
  });
  // 源第②通道：`java.downloadFile('data:text/html;base64,<b64>,{"type":"html"}')`（注意：内容就是第 1 参）
  const b64 = btoa(unescape(encodeURIComponent('<p>你好</p>'))); // 与源 `_dlB64` 同口径（UTF-8 字节的 base64）
  const rel2 = java.downloadFile(`data:text/html;base64,${b64},{"type":"html"}`);
  assert.equal(rel2, 'download.html', '取不到 url 时给默认名（仍非空）');
  assert.equal((toParent.at(-1)!.yueduReaderJava.args as string[])[1], '<p>你好</p>');
});
