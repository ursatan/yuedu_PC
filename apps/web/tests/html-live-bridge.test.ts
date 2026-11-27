/**
 * `#376` **LIVE 媒体观察桥**的回归锁 —— 与 `html-net-bridge.test.ts` 同款：直接
 * **执行**壳层生成的那段脚本（最小假 DOM / 假 MutationObserver / 假 parent），
 * 断言行为，不是看字符串。
 *
 * ## 缺陷背景（用户报障：苹果MCS「嗅探只嗅到一集、页内切集不跟随」）
 * `navSniffMedia` 对**静态 HTML 快照**跑提取 —— 站点脚本页内切集（换 `<video src>` /
 * 换 iframe 播放页）后快照不变 ⇒ 嗅探停在进页那一条。沙箱 opaque origin 父页读不到
 * 内部 DOM ⇒ 内容侧观察 + `postMessage {yueduLiveMedia:{items,cur}}`。
 *
 * ## 判据一致性
 * 桥内两个正则由父页按 core `media-shape` 的 `MEDIA_EXT_RE` / `MEDIA_HINT_RE` 的
 * `.source` 注入 —— 本测试直接用真实导出值构造桥，另断言桥文本里确实嵌了它们
 * （防「参数没接上、正则落空」的静默退化）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLiveMediaBridge } from '../src/utils/html-shell';
import { MEDIA_EXT_RE, MEDIA_HINT_RE, likeMediaUrl } from '@yuedu/core/media-shape';

interface Msg { yueduLiveMedia?: { items: { u: string; t?: string }[]; cur: string } }

/** 最小假媒体元素（runBridge 内部包上桥要用的 getAttribute/querySelector） */
interface FakeEl {
  tagName: string;
  src?: string;
  currentSrc?: string;
  sourceChild?: { src?: string };
  /** `#377②` 带媒体直链的元素（集按钮/链接）：任意属性表 + 可见文本 */
  attrs?: Record<string, string>;
  text?: string;
  /** `#395` 模拟 `display:none` 子树里的元素（offsetWidth/offsetHeight/getClientRects 全零） */
  hidden?: boolean;
}

function mkEl(tagName: string, src = '', extra: Partial<FakeEl> = {}): FakeEl {
  return { tagName, src, ...extra };
}

/** 媒体元素选择器（桥里第一段 querySelectorAll） */
const MEDIA_SEL_TAGS = ['video', 'audio', 'source', 'embed', 'iframe'];

/** 假环境里跑桥脚本：可手动改 DOM 后 flush 节流，观察发出的 postMessage */
function runBridge(opts: { baseURI?: string; elems?: FakeEl[] } = {}) {
  const msgs: Msg[] = [];
  const state = { elems: opts.elems ?? [] };
  const baseURI = opts.baseURI ?? '';
  // 桥的 grab() 用 getAttribute('src') / currentSrc / querySelector('source') —— 假元素必须都有
  const wrap = (e: FakeEl) => ({
    tagName: e.tagName,
    currentSrc: e.currentSrc,
    textContent: e.text ?? '',
    // `#395` vis() 三件套：默认可见；`hidden: true` 模拟 display:none 子树（三者全零）
    offsetWidth: e.hidden ? 0 : 100,
    offsetHeight: e.hidden ? 0 : 50,
    getClientRects: () => (e.hidden ? [] : [{}]),
    getAttribute: (n: string) => {
      if (n === 'src') return e.src ?? '';
      return e.attrs?.[n] ?? null;
    },
    querySelector: (sel: string) =>
      sel === 'source' && e.sourceChild
        ? { getAttribute: (n: string) => (n === 'src' ? e.sourceChild?.src ?? '' : '') }
        : null,
  });
  // 选择器分支：媒体标签段 vs 属性/标签段（`#377②` 的集按钮扫描）
  const match = (sel: string, list: FakeEl[]) => {
    const parts = sel.split(',').map((s) => s.trim());
    return list
      .filter((e) =>
        parts.some((p) => {
          if (MEDIA_SEL_TAGS.includes(p)) return e.tagName === p;
          // [data-url] / [data-src] / … 属性存在即命中
          const am = /^\[([a-z-]+)\]$/.exec(p);
          if (am) return e.attrs?.[am[1]!] != null;
          // a[href] / button
          if (p === 'a[href]') return e.tagName === 'a' && e.attrs?.href != null;
          return e.tagName === p;
        }),
      )
      .map(wrap);
  };
  const document = {
    baseURI,
    documentElement: {},
    querySelectorAll: (sel: string) => match(sel, state.elems),
    querySelector: (sel: string) => match(sel, state.elems)[0],
    addEventListener: () => {},
  };
  const observers: { cb: () => void }[] = [];
  class MutationObserver {
    constructor(cb: () => void) {
      observers.push({ cb });
    }
    observe() {}
    disconnect() {}
  }
  // 节流 setTimeout 不真等：收集起来由 flush() 手动执行（kick → 300ms → scan 的真实时序）
  const pending: (() => void)[] = [];
  const setTimeoutFake = (fn: () => void) => {
    pending.push(fn);
    return pending.length;
  };
  const setIntervalFake = () => ({ unref: () => {} });
  const parent = { postMessage: (m: Msg) => msgs.push(m) };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'window', 'document', 'parent', 'MutationObserver', 'URL', 'setTimeout', 'clearTimeout', 'setInterval',
    buildLiveMediaBridge(MEDIA_EXT_RE.source, MEDIA_HINT_RE.source),
  );
  fn({ addEventListener: () => {} }, document, parent, MutationObserver, URL, setTimeoutFake, () => {}, setIntervalFake);
  /** MutationObserver 回调 → 300ms 节流 flush（桥真实时序：kick → scan） */
  const kick = () => observers.forEach((o) => o.cb());
  const flush = () => {
    while (pending.length) pending.shift()!();
  };
  return {
    msgs,
    kick,
    flush,
    /** 改 DOM：全量替换媒体元素集合（模拟站点切集/换线路） */
    set(elems: FakeEl[]) {
      state.elems = elems;
    },
  };
}

test('LIVE 桥 · 首扫收集媒体元素并报文：cur = 第一个 video/audio 的实际挂载地址', () => {
  const b = runBridge({
    baseURI: 'https://v.com/p/',
    elems: [
      mkEl('iframe', 'https://v.com/play.m3u8?n=1'),
      mkEl('video', '', { currentSrc: 'https://cdn.com/ep1.m3u8' }),
      mkEl('source', 'https://cdn.com/ep0.mp4'),
    ],
  });
  assert.equal(b.msgs.length, 1, '首扫有候选就该发一次');
  const m = b.msgs[0]!.yueduLiveMedia!;
  assert.equal(m.cur, 'https://cdn.com/ep1.m3u8');
  // `#396` 替换语义：video/audio 挂载地址在前（当前在播者），iframe/source/embed 兜底在后
  assert.deepEqual(m.items.map((x) => x.u), [
    'https://cdn.com/ep1.m3u8',
    'https://v.com/play.m3u8?n=1',
    'https://cdn.com/ep0.mp4',
  ]);
});

test('LIVE 桥 · /api/proxy 改写过的 src 还原为原始直链（RES 桥先改写的形态）', () => {
  const raw = 'https://cdn.com/ep2.m3u8';
  // 真机形态（探针实证）：RES 桥写回**绝对** proxy 地址；首扫由该改写触发的 mutation 驱动
  const absProxied = 'http://127.0.0.1:3415/api/proxy?u=' + encodeURIComponent(raw) + '&sid=sid1';
  const b = runBridge({ baseURI: 'https://v.com/p/', elems: [mkEl('video', absProxied)] });
  assert.equal(b.msgs.length, 1);
  assert.equal(b.msgs[0]!.yueduLiveMedia!.cur, raw, '绝对 proxy 地址必须还原（旧正则只认相对形态 ⇒ items 恒空）');
  assert.deepEqual(b.msgs[0]!.yueduLiveMedia!.items.map((x) => x.u), [raw], '还原后才像媒体 ⇒ 收进 items');
  // 相对形态（历史兼容）
  const relProxied = '/api/proxy?u=' + encodeURIComponent('https://cdn.com/ep9.mp4');
  const b2 = runBridge({ baseURI: 'https://v.com/p/', elems: [mkEl('video', relProxied)] });
  assert.equal(b2.msgs[0]!.yueduLiveMedia!.cur, 'https://cdn.com/ep9.mp4');
});

test('LIVE 桥 · 非媒体 URL 不收；相对 URL 按 baseURI 绝对化', () => {
  const b = runBridge({
    baseURI: 'https://v.com/p/',
    elems: [mkEl('iframe', 'https://v.com/static/player.js'), mkEl('video', '/v/ep1.m3u8')],
  });
  assert.equal(b.msgs.length, 1);
  const m = b.msgs[0]!.yueduLiveMedia!;
  assert.deepEqual(m.items.map((x) => x.u), ['https://v.com/v/ep1.m3u8'], 'player.js 不像媒体 ⇒ 不收');
  assert.equal(m.cur, 'https://v.com/v/ep1.m3u8');
});

test('LIVE 桥 · 页内切集跟随：src 换了 ⇒ 列表替换为当前 + cur 更新；无变化不再发', () => {
  const b = runBridge({ baseURI: 'https://v.com/p/', elems: [mkEl('video', 'https://cdn.com/ep1.m3u8')] });
  assert.equal(b.msgs.length, 1);
  assert.equal(b.msgs[0]!.yueduLiveMedia!.cur, 'https://cdn.com/ep1.m3u8');
  // 站点脚本切到第 2 集
  b.set([mkEl('video', 'https://cdn.com/ep2.m3u8')]);
  b.kick();
  b.flush();
  assert.equal(b.msgs.length, 2, '变化才发第二条');
  const m2 = b.msgs[1]!.yueduLiveMedia!;
  // `#396` 替换语义：列表 = 当前可见快照（ep1 已不在 DOM ⇒ 不保留）
  assert.deepEqual(m2.items.map((x) => x.u), ['https://cdn.com/ep2.m3u8']);
  assert.equal(m2.cur, 'https://cdn.com/ep2.m3u8', '切集后 cur 跟随');
  // 再 flush（无变化）⇒ 不重复发
  b.flush();
  assert.equal(b.msgs.length, 2);
});

test('LIVE 桥 · 页内没有媒体 ⇒ 不发报文', () => {
  const b = runBridge({ baseURI: 'https://v.com/p/', elems: [mkEl('iframe', 'https://v.com/about.html')] });
  assert.equal(b.msgs.length, 0);
});

test('LIVE 桥 · video 无 currentSrc/无 src 时退到子 <source> 的 src', () => {
  const b = runBridge({
    baseURI: 'https://v.com/p/',
    elems: [mkEl('video', '', { sourceChild: { src: 'https://cdn.com/ep3.mp4' } })],
  });
  assert.equal(b.msgs.length, 1);
  assert.equal(b.msgs[0]!.yueduLiveMedia!.cur, 'https://cdn.com/ep3.mp4');
});

test('LIVE 桥 · 判据与 core media-shape 唯一实现一致（source 已嵌入桥文本）', () => {
  const text = buildLiveMediaBridge(MEDIA_EXT_RE.source, MEDIA_HINT_RE.source);
  assert.ok(text.includes(JSON.stringify(MEDIA_EXT_RE.source)), '扩展名判据必须来自 media-shape（唯一实现）');
  assert.ok(text.includes(JSON.stringify(MEDIA_HINT_RE.source)), '路径提示判据必须来自 media-shape（唯一实现）');
  // 桥内 like() 的胶水组合 == likeMediaUrl（同输入同输出）
  const samples = [
    'https://a/x.m3u8',
    'https://a/x.mp4?token=1',
    'https://a/jx/m3u8/?url=x',
    'https://a/player.js',
    'https://a/cover.jpg',
    'https://a/video/list',
  ];
  for (const s of samples) {
    assert.equal(MEDIA_EXT_RE.test(s) || MEDIA_HINT_RE.test(s), likeMediaUrl(s), '胶水组合必须与 likeMediaUrl 一致: ' + s);
  }
});

test('LIVE 桥 · 脚本纪律：无反引号、无字面 script 闭合标签', () => {
  const text = buildLiveMediaBridge(MEDIA_EXT_RE.source, MEDIA_HINT_RE.source);
  assert.ok(!text.includes('`'), 'srcdoc 拼接纪律');
  assert.ok(!text.includes('</scr' + 'ipt>'), '字面闭合标签会切断 SFC/HTML');
});

/* ── `#377②` 播放列表整表提取（苹果MCS 双线路多集：每集 <button data-url>）─────────── */

test('LIVE 桥 · 集按钮整表：<button data-url> 全部收进 items（带集名），非媒体链接不收', () => {
  const b = runBridge({
    baseURI: 'https://mcs.com/p/',
    elems: [
      mkEl('video', '', { currentSrc: 'https://cdn.com/e1.m3u8' }),
      mkEl('button', '', { attrs: { 'data-url': 'https://cdn.com/e1.m3u8' }, text: '第01集' }),
      mkEl('button', '', { attrs: { 'data-url': 'https://cdn.com/e2.m3u8' }, text: '第02集' }),
      mkEl('button', '', { attrs: { 'data-url': 'https://cdn.com/e3.m3u8' }, text: '第03集' }),
      // 噪声：普通导航链接 / 广告按钮（不像媒体 ⇒ 必须丢弃）
      mkEl('a', '', { attrs: { href: 'https://mcs.com/about.html' }, text: '关于' }),
      mkEl('button', '', { attrs: { 'data-url': 'https://mcs.com/api/list' }, text: '更多' }),
    ],
  });
  assert.equal(b.msgs.length, 1);
  const m = b.msgs[0]!.yueduLiveMedia!;
  assert.deepEqual(
    m.items.map((x) => x.u),
    ['https://cdn.com/e1.m3u8', 'https://cdn.com/e2.m3u8', 'https://cdn.com/e3.m3u8'],
    '整张播放列表按序收进（同地址去重；非媒体 link 不收）',
  );
  assert.deepEqual(m.items.map((x) => x.t), ['第01集', '第02集', '第03集'], '集名取自按钮文本');
  assert.equal(m.cur, 'https://cdn.com/e1.m3u8', 'cur 仍是 video 实际挂载地址');
});

test('LIVE 桥 · 集名优先级：data-title > title > 文本；同地址重复时首个非空名胜出', () => {
  const b = runBridge({
    baseURI: 'https://mcs.com/p/',
    elems: [
      mkEl('button', '', { attrs: { 'data-url': 'https://cdn.com/x.m3u8', 'data-title': '正片', title: 'ignored' }, text: '文本名' }),
      mkEl('button', '', { attrs: { 'data-url': 'https://cdn.com/x.m3u8' }, text: '第二条同名' }),
    ],
  });
  const m = b.msgs[0]!.yueduLiveMedia!;
  assert.equal(m.items.length, 1, '同地址只留一条');
  assert.equal(m.items[0]!.t, '正片', 'data-title 优先；后续空名不覆盖已有名');
});

test('LIVE 桥 · `<a href>` 媒体直链也收（部分站点用链接承载集）', () => {
  const b = runBridge({
    baseURI: 'https://mcs.com/p/',
    elems: [mkEl('a', '', { attrs: { href: '/v/e1.mp4' }, text: '第1集' })],
  });
  const m = b.msgs[0]!.yueduLiveMedia!;
  assert.deepEqual(m.items.map((x) => x.u), ['https://mcs.com/v/e1.mp4'], '相对 href 绝对化后收进');
});

/* ── `#395` 可见性过滤（AGE 形态：所有线路的选集容器都在 DOM，非当前线路 display:none）── */

test('LIVE 桥 · #395/#396 隐藏容器不收 + 替换语义：切线路 = 清空旧列表、加载当前 tab 列表', () => {
  // AGE 真实形态：line0 容器可见（3 集 + 播放 iframe），line1 容器 display:none
  const line0 = [
    mkEl('iframe', 'https://jx.com/m3u8/?url=ep1code'), // 播放 iframe（可见）
    mkEl('a', '', { attrs: { href: 'https://jx.com/m3u8/?url=ep1code' }, text: '第01集' }),
    mkEl('a', '', { attrs: { href: 'https://jx.com/m3u8/?url=ep2code' }, text: '第02集' }),
    mkEl('a', '', { attrs: { href: 'https://jx.com/m3u8/?url=ep3code' }, text: '第03集' }),
  ];
  const line1 = [
    mkEl('a', '', { attrs: { href: 'https://jx.com/m3u8/?url=l2ep1' }, text: '第01集', hidden: true }),
    mkEl('a', '', { attrs: { href: 'https://jx.com/m3u8/?url=l2ep2' }, text: '第02集', hidden: true }),
  ];
  const b = runBridge({ baseURI: 'https://age.com/c/', elems: [...line0, ...line1] });
  assert.equal(b.msgs.length, 1);
  const m = b.msgs[0]!.yueduLiveMedia!;
  assert.deepEqual(
    m.items.map((x) => x.u),
    [
      'https://jx.com/m3u8/?url=ep1code',
      'https://jx.com/m3u8/?url=ep2code',
      'https://jx.com/m3u8/?url=ep3code',
    ],
    '隐藏线路的集必须跳过；播放 iframe 与第 1 集同地址 ⇒ 去重合并（有集列表时 iframe 不单列条目）',
  );
  assert.deepEqual(m.items.map((x) => x.t), ['第01集', '第02集', '第03集']);
  assert.equal(m.cur, 'https://jx.com/m3u8/?url=ep1code');
  // 用户点另一条线路 tab：line0 容器 display:none、line1 显示 ⇒ `#396` **清空旧列表、
  // 加载当前 tab 的播放列表**（替换，不是追加 —— 旧语义会把 line1 追加到 line0 后面）
  const line0Hidden = line0.map((e, i) => (i === 0 ? e : { ...e, hidden: true }));
  b.set([...line0Hidden, ...line1.map((e) => ({ ...e, hidden: false }))]);
  b.kick();
  b.flush();
  assert.equal(b.msgs.length, 2, '变化才发');
  const m2 = b.msgs[1]!.yueduLiveMedia!;
  assert.deepEqual(
    m2.items.map((x) => x.u),
    ['https://jx.com/m3u8/?url=l2ep1', 'https://jx.com/m3u8/?url=l2ep2'],
    '列表 = 当前 tab 的集（line0 的集与播放 iframe 都被清掉，不追加）',
  );
  assert.deepEqual(m2.items.map((x) => x.t), ['第01集', '第02集']);
  // 旧 cur（ep1code）已不在新列表 ⇒ cur 跟到新列表首条
  assert.equal(m2.cur, 'https://jx.com/m3u8/?url=l2ep1');
});

test('LIVE 桥 · #396 只有内嵌播放页没有集列表时，iframe 挂载地址仍是列表（兜底不丢）', () => {
  const b = runBridge({ baseURI: 'https://v.com/p/', elems: [mkEl('iframe', 'https://cdn.com/play.m3u8')] });
  assert.equal(b.msgs.length, 1);
  const m = b.msgs[0]!.yueduLiveMedia!;
  assert.deepEqual(m.items.map((x) => x.u), ['https://cdn.com/play.m3u8'], '没有集列表 ⇒ iframe 挂载地址兜底成列表');
  assert.equal(m.cur, 'https://cdn.com/play.m3u8');
});

test('LIVE 桥 · #395 媒体元素不过可见性滤（隐藏的 audio/iframe 仍收 —— 播放器可能藏起来播）', () => {
  const b = runBridge({
    baseURI: 'https://v.com/p/',
    elems: [mkEl('audio', 'https://cdn.com/a1.mp3', { hidden: true })],
  });
  assert.equal(b.msgs.length, 1, 'vis() 只用于集按钮通路，video/audio/iframe/source/embed 不受影响');
  assert.equal(b.msgs[0]!.yueduLiveMedia!.cur, 'https://cdn.com/a1.mp3');
});
