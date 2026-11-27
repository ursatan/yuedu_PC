/**
 * `#336` **页内导航桥**的回归锁 —— 直接**执行**壳层生成那段脚本，不是看字符串。
 *
 * ## 为什么这么测
 * 桥是一段要跑在 opaque-origin iframe 里的代码，父页读不到内部 DOM ⇒ 这类缺陷
 * （链接仍跳新标签 / `legado://` 没被识别 / 锚点被误拦）**只能靠内容侧的行为断言**。
 * 所以用「最小假 DOM」真跑一遍生成的函数：断言 `postMessage` 出来什么、以及默认行为
 * 有没有被 `preventDefault` 拦住。
 *
 * ⚠️ 不引 jsdom（web 包没有它）：桥只用到 `document.addEventListener` /
 * `getAttribute` / `parentNode` / `nodeType` / `window.open` / `URL`，手搓足够，
 * 且**断言的是语义**（拦了什么、放过了什么），不是 DOM 实现细节。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNavBridge, buildHtmlDoc } from '../src/utils/html-shell';

/** 在最小假 DOM 里跑桥脚本，返回「报上去的跳转」与「默认行为是否被拦」 */
function runBridge(opts: { shouldOverride?: (url: string) => boolean; javaOpen?: (...a: unknown[]) => void } = {}) {
  const sent: Array<{ url: string; kind: string }> = [];
  /** `#449` `shouldOverride` 探针重放出来的 `java.open` 参数 */
  const replayed: unknown[][] = [];
  /** `#391`：文档内「有名字」的元素（`<iframe name>` / `<form name>`）—— 由用例按需登记 */
  const inDocNames = new Set<string>();
  const parent = {
    postMessage: (m: unknown) => {
      const n = (m as { yueduNav?: { url: string; kind: string } } | null)?.yueduNav;
      if (n) sent.push(n);
    },
  };
  const handlers: Array<(e: unknown) => void> = [];
  const document = {
    baseURI: 'https://a.com/p/',
    addEventListener: (t: string, fn: (e: unknown) => void) => {
      if (t === 'click') handlers.push(fn);
    },
    getElementsByName: (n: string) => (inDocNames.has(n) ? [{}] : []),
  };
  let realOpen: string | null = null;
  let realOpenName: string | null = null;
  const window = {
    open: (u: string, n?: string) => {
      realOpen = u;
      realOpenName = n ?? null;
      return null;
    },
    ...(opts.shouldOverride ? { __yueduShouldOverride: opts.shouldOverride } : {}),
    ...(opts.javaOpen
      ? { java: { open: (...a: unknown[]) => { replayed.push(a); opts.javaOpen?.(...a); } } }
      : {}),
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'parent', 'URL', buildNavBridge());
  fn(window, document, parent, URL);

  let prevented = false;
  /** 模拟点一个 `<a href target>`（只给桥需要的那几个属性） */
  const clickHref = (href: string | null, target?: string) => {
    prevented = false;
    const anchor = {
      nodeType: 1,
      getAttribute: (n: string) => (n === 'href' ? href : n === 'target' ? (target ?? null) : null),
      parentNode: null,
    };
    for (const h of handlers) {
      h({
        target: anchor,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {},
      });
    }
  };
  return {
    sent,
    clickHref,
    /**
     * `#444` 模拟点「一键导入」按钮：站点把它做成 **无 href 的 `span`**，地址写在
     * `title`（`rn()`）或 `data-u`（`annImp()`）上，点击时自己 `location.href='legado://import/…'`。
     */
    clickImport(attrs: { title?: string; dataU?: string }) {
      prevented = false;
      const el: { nodeType: number; parentNode: null; onclick: unknown; getAttribute: (n: string) => string | null } = {
        nodeType: 1,
        parentNode: null,
        onclick: 'site-handler',
        getAttribute: (n: string) =>
          n === 'data-u' ? (attrs.dataU ?? null) : n === 'title' ? (attrs.title ?? null) : null,
      };
      for (const h of handlers) {
        h({
          target: el,
          preventDefault: () => {
            prevented = true;
          },
          stopPropagation: () => {},
          stopImmediatePropagation: () => {},
        });
      }
      return el;
    },
    inDocNames,
    wasPrevented: () => prevented,
    open: (u: string) => {
      realOpen = null;
      realOpenName = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).open(u);
    },
    openNamed: (u: string, n: string) => {
      realOpen = null;
      realOpenName = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).open(u, n);
    },
    realOpen: () => realOpen,
    realOpenName: () => realOpenName,
    /** `#449` 探针要用：让用例在「求值期间」去调 `window.java.open`（此时它已被探针接管） */
    win: window,
    /** `#449` 探针重放出来的 `java.open` 参数（每元素一项） */
    replayed,
  };
}

/**
 * `#449` **源的 `shouldOverrideUrlLoading` 优先**（用户口径：「为什么是 D13 的事？现在不能支持么？」）。
 *
 * 上游语义 = 导航前跑源那行 JS（`url` 在作用域），**true 就拦下来**、由源自己 `java.open('rss',url)`
 * 交源规则重新解析。锁三条语义：
 *  · 判 true（表达式形态）⇒ **拦原生跳转**（不 preventDefault 就会真的换页）+ 不进 `yueduNav`；
 *  · 判 true 且源自己调了 `java.open`（语句形态）⇒ **原样重放一次**（探针期间不报文 ⇒ 不重复处理）；
 *  · 判 false（或源没声明）⇒ 完全回落到通用分流（`yueduNav` 照发）。
 */
test('导航桥 · 源 shouldOverrideUrlLoading 判 true ⇒ 拦截并交出路由（不重复报文）', () => {
  const opened: unknown[][] = [];
  const b = runBridge({
    javaOpen: (...a: unknown[]) => opened.push(a),
    shouldOverride: (u) => u.includes('mod=viewthread'),
  });
  b.clickHref('https://a.com/forum.php?mod=viewthread&tid=1');
  assert.equal(b.wasPrevented(), true, '源说接管就必须拦下原生跳转');
  assert.deepEqual(b.sent, [], '不再发 yueduNav（路由由源自己的 java.open 报文负责）');
  assert.deepEqual(opened, [], '这条源只是返回 true、没调 java.open ⇒ 不该凭空重放');
  // 判 false ⇒ 回落通用分流（照旧上报）
  b.clickHref('https://b.com/x');
  assert.deepEqual(b.sent, [{ url: 'https://b.com/x', kind: 'http' }]);
});

test('导航桥 · 源写成「语句列表」形态（只调 java.open、无返回值）⇒ 也算接管且原样重放一次', () => {
  const opened: unknown[][] = [];
  const b = runBridge({
    javaOpen: (...a: unknown[]) => opened.push(a),
    // 复刻「纯副作用」源：求值期间调 java.open，返回 undefined（`#449` 的 eval 对两形态都容）
    shouldOverride: ((u: string) => {
      (b.win as { java?: { open?: (...a: unknown[]) => void } }).java?.open?.('rss', u, '');
      return undefined;
    }) as unknown as (u: string) => boolean,
  });
  b.clickHref('https://a.com/x');
  assert.equal(b.wasPrevented(), true, '副作用已发生 ⇒ 也算源接管');
  assert.deepEqual(b.sent, []);
  assert.deepEqual(opened, [['rss', 'https://a.com/x', '']], '探针记录到的调用必须**原样重放**一次（路由不变）');
});

test('导航桥 · 绝对 http(s) 链接 ⇒ 拦住默认行为并上报（不再跳新标签）', () => {
  const b = runBridge();
  b.clickHref('https://b.com/x');
  assert.deepEqual(b.sent, [{ url: 'https://b.com/x', kind: 'http' }]);
  assert.equal(b.wasPrevented(), true, '不 preventDefault 就还是会开新标签 —— 这正是用户报的现象');
});

test('导航桥 · 相对链接按 baseURI 解析成绝对地址', () => {
  const b = runBridge();
  b.clickHref('./y?a=1');
  assert.deepEqual(b.sent, [{ url: 'https://a.com/p/y?a=1', kind: 'http' }]);
});

test('导航桥 · `legado://` 单独标记为 legado（父窗口据此唤起书源导入）', () => {
  const b = runBridge();
  b.clickHref('legado://import/bookSource?src=https%3A%2F%2Fx.com%2Fa.json');
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0]!.kind, 'legado');
  assert.match(b.sent[0]!.url, /^legado:\/\//i);
});

test('导航桥 · 锚点 / javascript: / mailto: **不拦**（它们本来就不是导航）', () => {
  const b = runBridge();
  b.clickHref('#top');
  assert.equal(b.sent.length, 0, '页内锚点放过去，别把用户的页内定位吃掉');
  assert.equal(b.wasPrevented(), false);
  b.clickHref('javascript:void(0)');
  assert.equal(b.sent.length, 0);
  b.clickHref('mailto:a@b.com');
  assert.equal(b.sent.length, 0);
});

test('导航桥 · `window.open` 改为上报，且**不再真的开窗**', () => {
  const b = runBridge();
  const r = b.open('https://c.com/z');
  assert.equal(r, null, '返回 null = 没拿到真实窗口句柄');
  assert.deepEqual(b.sent, [{ url: 'https://c.com/z', kind: 'http' }]);
  assert.equal(b.realOpen(), null, '底层 window.open 不该被调用');
});

// ---------------------------------------------------------------------------
// `#444` `.json` 一键导入按钮（千白羽论坛）—— 站点用 `location.href` 导不出沙箱
// ---------------------------------------------------------------------------

test('导航桥 · `.json` 一键导入按钮 ⇒ 掐掉站点 onclick 并派发 legado 导入', () => {
  const b = runBridge();
  const el = b.clickImport({ title: 'https://dns.jingluo.love/2026/6aca27d896b5e.json' });
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0]!.kind, 'legado');
  assert.equal(
    b.sent[0]!.url,
    'legado://import/any?src=' + encodeURIComponent('https://dns.jingluo.love/2026/6aca27d896b5e.json'),
  );
  assert.equal(b.wasPrevented(), true, '不拦 ⇒ 站点自己的 location.href 仍会跑（导不出去 = 用户看到的「点按钮没反应」）');
  assert.equal(el.onclick, null, '站点自己的处理器必须先被掐掉');
});

test('导航桥 · `data-u` 形态的导入按钮同样命中', () => {
  const b = runBridge();
  b.clickImport({ dataU: 'https://x.test/a.json?v=1' });
  assert.equal(b.sent[0]?.kind, 'legado');
});

test('导航桥 · 非 `.json` 的 title/data-u ⇒ 不误伤（对偶）', () => {
  const b = runBridge();
  b.clickImport({ title: 'https://x.test/a.png' });
  assert.equal(b.sent.length, 0, '图片 title 不该被当导入');
  b.clickImport({ dataU: 'not-a-url' });
  assert.equal(b.sent.length, 0);
});

test('壳 · 导航桥**无条件注入**（不依赖 server origin，也不要求正文含脚本）', () => {
  const doc = buildHtmlDoc('<p>纯文本</p>');
  assert.match(doc, /yueduNav/, '没有它 ⇒ 正文里的链接仍会跳系统浏览器');
  // 对偶：它是内容而不是被当成选择器/样式注入 —— 必须包在脚本标签里
  assert.match(doc, /<script>\s*\(function\(\)\{/);
  assert.doesNotMatch(buildNavBridge(), /`/, '反引号会截断拼接它的模板串（本仓踩过多次）');
});

// ---------------------------------------------------------------------------
// `#391` 页内命名 target（AGE动漫选集）—— 用户实测：「点击选集会跳转解析云播放器页面」
// ---------------------------------------------------------------------------

/**
 * 真源（AGE动漫 `ruleContent`）合成的播放页里：
 *   `<iframe name="ageplayer" id="ageplayer" src="…/m3u8/?url=…">`
 *   `<a href="…/m3u8/?url=…" target="ageplayer" class="ep-btn" onclick="savePlayHistory(…)">第01集</a>`
 * 浏览器的原生语义 = 把新地址装进那个 iframe（**播放区就地换集**）。
 * 我们一律 preventDefault + `navGo` ⇒ 整页被换成解析页（用户被带离）。
 */
test('#391 页内命名 target：`<a target="ageplayer">` + 页内有 `<iframe name="ageplayer">` ⇒ 放行（就地换 iframe）', () => {
  const b = runBridge();
  b.inDocNames.add('ageplayer');
  b.clickHref('https://jx.ejtsyc.com:8443/m3u8/?url=age_xxx', 'ageplayer');
  assert.equal(b.wasPrevented(), false, '拦下来就没有「就地换集」了 —— 这正是用户报的现象');
  assert.deepEqual(b.sent, [], '不该上报给宿主（上报 ⇒ 宿主 navGo ⇒ 整页跳走）');
});

test('#391 对偶：`_blank` / 文档里不存在的 target ⇒ 仍然拦截并上报（不误放行）', () => {
  const b = runBridge();
  // ① `_blank` 是下划线保留字 ⇒ 绝不是页内目标
  b.clickHref('https://b.com/x', '_blank');
  assert.equal(b.wasPrevented(), true);
  assert.deepEqual(b.sent, [{ url: 'https://b.com/x', kind: 'http' }]);
  // ② 名字没登记（页内没有同名元素）⇒ 不是页内目标
  b.clickHref('https://b.com/y', 'nope');
  assert.equal(b.wasPrevented(), true);
  assert.equal(b.sent.length, 2);
  // ③ 无 target 的普通链接照旧
  b.clickHref('https://b.com/z');
  assert.equal(b.wasPrevented(), true);
  assert.equal(b.sent.length, 3);
});

test('#391 `window.open(u, "ageplayer")` 命中页内 name ⇒ 走**原生** open（不拦截）', () => {
  const b = runBridge();
  b.inDocNames.add('ageplayer');
  b.openNamed('https://jx.ejtsyc.com:8443/m3u8/?url=age_yyy', 'ageplayer');
  assert.equal(b.realOpen(), 'https://jx.ejtsyc.com:8443/m3u8/?url=age_yyy', '页内命名目标 ⇒ 交给浏览器');
  assert.equal(b.realOpenName(), 'ageplayer');
  assert.deepEqual(b.sent, [], '不得上报');
  // 对偶：名字不在文档里 ⇒ 仍然拦截（维持 `#336` 的「不跳新标签」）
  b.openNamed('https://c.com/z', 'other');
  assert.deepEqual(b.sent, [{ url: 'https://c.com/z', kind: 'http' }]);
});
