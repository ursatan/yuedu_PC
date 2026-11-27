/**
 * `#345b` **动态资源改写桥**的回归锁 —— 直接**执行**壳层生成的那段脚本，断言语义。
 *
 * ## 为什么这么测（而不是看字符串）
 * 桥要跑的现场：**源作者脚本**在 opaque-origin iframe 里 `box.innerHTML += html`
 * 动态插入 `<img>`（24 系列 `www.myao.cc`）。缺陷现象是「阅读页图片全部失败」
 * （`/LoadImage.ashx/…` 盗链防护，裸取 403）⇒ 必须断言「动态插入的绝对地址**真的**
 * 被改写成了 `/api/proxy`」，而不是断言「源码里出现了 MutationObserver 字样」。
 *
 * 所以用「最小假 DOM」真跑一遍：MutationObserver 立即回调一次（模拟 DOM 变动），
 * 断言节点属性最终值。
 *
 * ⚠️ 不引 jsdom（web 包没有它）。桥只用到 MutationObserver / document / 元素
 * `nodeType`·`tagName`·`getAttribute`·`setAttribute`·`removeAttribute`·
 * `querySelectorAll` —— 手搓足够，且断言的是**语义**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildResourceBridge, buildHtmlDoc } from '../src/utils/html-shell';

const ORIGIN = 'http://127.0.0.1:3000';
const SID = 'sid-1';

/** 最小假元素 */
function el(tagName: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
  return new FakeEl(tagName, attrs, children);
}
class FakeEl {
  nodeType = 1;
  constructor(
    public tagName: string,
    private attrs: Record<string, string> = {},
    private children: FakeEl[] = [],
  ) {}
  getAttribute(n: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? (this.attrs[n] as string) : null;
  }
  setAttribute(n: string, v: string): void {
    this.attrs[n] = v;
  }
  removeAttribute(n: string): void {
    delete this.attrs[n];
  }
  /** `#442`：桥要枚举 `data-*` 找「真图」属性 ⇒ 假 DOM 也要给这个方法 */
  getAttributeNames(): string[] {
    return Object.keys(this.attrs);
  }
  querySelectorAll(_sel: string): FakeEl[] {
    // 桥只用它遍历后代；本测试直接把要断言的子节点当「后代列表」返回。
    return this.children;
  }
  /** 断言用：读最终属性值 */
  attr(n: string): string | null {
    return this.getAttribute(n);
  }
}

/** 在最小假环境里跑桥，返回「观察到的 DOM 变动回调」与「被 observe 的根」 */
function runBridge() {
  const records: Array<{ type: string; addedNodes?: FakeEl[]; target?: FakeEl }> = [];
  let observeRoot: unknown = null;
  let observeOpts: unknown = null;
  let domReady: (() => void) | null = null;

  class FakeMO {
    constructor(private cb: (muts: unknown[], _o: unknown) => void) {}
    observe(root: unknown, opts: unknown) {
      observeRoot = root;
      observeOpts = opts;
    }
    /** 测试驱动：把一批变动喂给桥的回调 */
    emit(muts: unknown[]) {
      this.cb(muts, this);
    }
  }

  const body = el('body');
  const document = {
    documentElement: el('html'),
    body,
    addEventListener: (t: string, fn: () => void) => {
      if (t === 'DOMContentLoaded') domReady = fn;
    },
  };

  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'MutationObserver', buildResourceBridge(ORIGIN, SID));
  const win = {} as Record<string, unknown>;
  fn(win, document, FakeMO);

  return {
    records,
    observeRoot: () => observeRoot,
    observeOpts: () => observeOpts as { childList?: boolean; subtree?: boolean; attributeFilter?: string[] } | null,
    fireDomReady: () => domReady?.(),
    body,
  };
}

/** 走一遍「桥在 DOMContentLoaded 前的初始 scan」 */
function bridgeWithBody(body: FakeEl) {
  const records: Array<{ type: string; addedNodes?: FakeEl[]; target?: FakeEl }> = [];
  let domReady: (() => void) | null = null;
  let mo: FakeMO | null = null;
  class FakeMO {
    constructor(private cb: (muts: unknown[], _o: unknown) => void) {
      mo = this;
    }
    observe() {
      /* noop */
    }
    emit(muts: unknown[]) {
      this.cb(muts, this);
    }
  }
  const document = {
    documentElement: el('html'),
    body,
    addEventListener: (t: string, fn: () => void) => {
      if (t === 'DOMContentLoaded') domReady = fn;
    },
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'MutationObserver', buildResourceBridge(ORIGIN, SID));
  fn({} as Record<string, unknown>, document, FakeMO);
  return {
    records,
    domReady: () => domReady?.(),
    emit: (muts: unknown[]) => mo!.emit(muts),
  };
}

test('资源桥 · 脚本**动态插入**的绝对 img 被改写成 /api/proxy（24 系列核心）', () => {
  const r = bridgeWithBody(el('body'));
  const img = el('img', { src: 'https://www.myao.cc/LoadImage.ashx/abc.jpg' });
  r.emit([{ type: 'childList', addedNodes: [img] }]);
  const src = img.attr('src') ?? '';
  assert.match(src, /^http:\/\/127\.0\.0\.1:3000\/api\/proxy\?u=/, '动态插入的图片必须走代理，否则裸取 403');
  assert.equal(decodeURIComponent(src.split('u=')[1]!.split('&')[0]!), 'https://www.myao.cc/LoadImage.ashx/abc.jpg');
  assert.match(src, /sid=sid-1/, '要带 sid，服务端才知道用哪个源的 Referer/UA/Cookie');
});

test('资源桥 · 插入的是**容器**时，其后代 img 也被扫到（querySelectorAll 通路）', () => {
  const r = bridgeWithBody(el('body'));
  const inner = el('img', { src: 'https://cdn.x.com/a.jpg' });
  const box = el('div', {}, [inner]);
  r.emit([{ type: 'childList', addedNodes: [box] }]);
  assert.match(inner.attr('src') ?? '', /\/api\/proxy\?u=/, '容器插入也必须递归扫后代');
});

test('资源桥 · 相对地址 / 非图片 data: / 已是代理地址 ⇒ **不动**（防重入 + 交给 base href）', () => {
  const r = bridgeWithBody(el('body'));
  const rel = el('img', { src: '/LoadImage.ashx/rel.jpg' });
  const textData = el('img', { src: 'data:text/plain;base64,aGVsbG8=' });
  const already = el('img', { src: 'http://127.0.0.1:3000/api/proxy?u=https%3A%2F%2Fx.com%2Fa.jpg' });
  r.emit([{ type: 'childList', addedNodes: [rel, textData, already] }]);
  assert.equal(rel.attr('src'), '/LoadImage.ashx/rel.jpg', '相对地址由 <base href> 解析，桥不该碰');
  assert.equal(textData.attr('src'), 'data:text/plain;base64,aGVsbG8=', '非图片 data: 不代理');
  assert.equal(already.attr('src'), 'http://127.0.0.1:3000/api/proxy?u=https%3A%2F%2Fx.com%2Fa.jpg', '防重入');
});

/**
 * `#441` ⚠️ **口径变更**：`data:image/…` **带 SID 时改为走代理**（旧锁断言它「不动」）。
 *
 * 实测（91视频）：正文/封面图片的 `src` 是 `data:image/jpeg;base64,<AES-ECB 密文>`，
 * 站点靠自己的 JS 解密后才渲染 ⇒ 直连渲染就是裂图。判据**必须有 SID**
 * （没有源上下文的内联图不吃这一跳，见 `imgSrc` 的对偶锁），且**体积 ≤200KB**
 * （整串进查询串，超长会被中间层拒）。
 */
test('#441 资源桥：带 SID 的 `data:image/…` 走 `/api/proxy`（源可声明图片解密）', () => {
  const r = bridgeWithBody(el('body'));
  const inline = el('img', { src: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' });
  r.emit([{ type: 'childList', addedNodes: [inline] }]);
  const src = inline.attr('src') ?? '';
  assert.match(src, /^http:\/\/127\.0\.0\.1:3000\/api\/proxy\?u=/, '内联图必须经服务端解密');
  assert.equal(decodeURIComponent(src.split('u=')[1]!.split('&')[0]!), 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  assert.match(src, /sid=sid-1/);
});

test('#441 对偶：超大内联图（>200KB）不吃这一跳（查询串放不下）', () => {
  const r = bridgeWithBody(el('body'));
  const big = el('img', { src: 'data:image/png;base64,' + 'A'.repeat(200001) });
  r.emit([{ type: 'childList', addedNodes: [big] }]);
  assert.doesNotMatch(big.attr('src') ?? '', /\/api\/proxy/, '超长 data URL 保持原样');
});

/**
 * `#442` **站点自定义懒加载属性**（91 系列实测）：
 * ```html
 * <img src="/usr/plugins/tbxw/zw.png" data-xuid="1"
 *      data-xkrkllgl="https://pic.hdhwqx.cn/upload_01/xiao/20261013/…jpeg">
 * ```
 * 真图在**防爬随机命名**的 `data-*` 里、`src` 只是占位图 ⇒ 只改写 `src`（+ 已知 4 个懒加载名）
 * 会永远显示占位图（用户实测：正文里全是灰色水印占位图）。判据不能写死名字 ⇒ 用「未知的
 * `data-*` + 值像图片」识别，并把真图**提升为 `src`**。
 */
test('#442 未知 `data-*` 里的真图：写回代理 + 提升为 `src`（占位图被顶替）', () => {
  const r = bridgeWithBody(el('body'));
  const img = el('img', {
    src: '/usr/plugins/tbxw/zw.png',
    'data-xuid': '1',
    'data-xkrkllgl': 'https://pic.hdhwqx.cn/upload_01/xiao/a.jpeg',
  });
  r.emit([{ type: 'childList', addedNodes: [img] }]);
  const lazy = img.attr('data-xkrkllgl') ?? '';
  assert.match(lazy, /\/api\/proxy\?u=/, '真图属性要写回代理地址（站点自己的 lazyload 若在跑也能用）');
  assert.equal(
    decodeURIComponent(lazy.split('u=')[1]!.split('&')[0]!),
    'https://pic.hdhwqx.cn/upload_01/xiao/a.jpeg',
  );
  assert.match(img.attr('src') ?? '', /\/api\/proxy\?u=/, '占位 src 必须被真图顶替');
  assert.equal(decodeURIComponent((img.attr('src') ?? '').split('u=')[1]!.split('&')[0]!), 'https://pic.hdhwqx.cn/upload_01/xiao/a.jpeg');
});

test('#442 对偶：24 系列那种**已知**懒加载名（`data-original`）**不动 src**', () => {
  const r = bridgeWithBody(el('body'));
  const img = el('img', { src: '/grey.gif', 'data-original': 'https://www.myao.cc/LoadImage.ashx/1.jpg' });
  r.emit([{ type: 'childList', addedNodes: [img] }]);
  assert.equal(img.attr('src'), '/grey.gif', '★ 已知懒加载名由站点 lazyload 自己换，改 src 会让它认不出占位');
  assert.match(img.attr('data-original') ?? '', /\/api\/proxy\?u=/, '属性值仍要改写走代理');
});

test('#442 对偶：未知 `data-*` 但值不是图片 URL ⇒ 不碰（防误伤站点脚本数据）', () => {
  const r = bridgeWithBody(el('body'));
  const img = el('img', { src: '/x/p.png', 'data-num': '12345', 'data-json': '{"a":1}' });
  r.emit([{ type: 'childList', addedNodes: [img] }]);
  assert.equal(img.attr('src'), '/x/p.png', '相对地址在没有 base 时原样保留（桥不猜）');
  assert.equal(img.attr('data-json'), '{"a":1}');
});

test('资源桥 · 本服务 /api/ 根相对地址：**原样放行**（`#212` Step2 epub 插图）', () => {
  /**
   * epub 正文的插图 src 是 `/api/local-books/asset?bookUrl=…&path=…`。
   * srcdoc 里没有 `<base>`（本地书章节没 base）⇒ `document.baseURI=about:srcdoc`
   * ⇒ `new URL('/api/x','about:srcdoc')` 会抛 ⇒ 不特判就被丢掉（图裂）。
   * 服务端把它改写成根相对是为了**同源直取**；桥必须**不代理**（否则服务端去 fetch 自己）。
   */
  const r = bridgeWithBody(el('body'));
  const asset = el('img', { src: '/api/local-books/asset?bookUrl=loc_book&path=OEBPS%2Fa.png' });
  r.emit([{ type: 'childList', addedNodes: [asset] }]);
  assert.equal(
    asset.attr('src'),
    'http://127.0.0.1:3000/api/local-books/asset?bookUrl=loc_book&path=OEBPS%2Fa.png',
    '★ 本服务 /api/ 端点要补成绝对（ORG 兜底）且**不套** /api/proxy',
  );
  assert.doesNotMatch(asset.attr('src') ?? '', /\/api\/proxy/, '再代理一层会让服务端 fetch 自己');
});

test('资源桥 · 对偶：站点自己的根相对图**不**被当成 /api（仍交给 base 解析）', () => {
  // 与上一条构成对偶：判据是 `/api/` 前缀，不是「首字符是 /」——
  // 若写成 charAt(0)==='/'，站点根相对图会被拼到本服务 origin ⇒ 代理到 127.0.0.1 ⇒ 404。
  const r = bridgeWithBody(el('body'));
  const site = el('img', { src: '/Uploads/allimg/1.jpg' });
  r.emit([{ type: 'childList', addedNodes: [site] }]);
  const got = site.attr('src') ?? '';
  assert.equal(got, '/Uploads/allimg/1.jpg', '站点根相对图必须保持原样（交给 <base href> + 由 prox 代理回源）');
  assert.doesNotMatch(got, /127\.0\.0\.1:3000/, '★ 不能拼进本服务 origin');
});

test('资源桥 · 属性变动（脚本改 .src）走 attributes 通路', () => {
  const r = bridgeWithBody(el('body'));
  const img = el('img', { src: 'https://www.myao.cc/LoadImage.ashx/lazy.jpg' });
  r.emit([{ type: 'attributes', target: img }]);
  assert.match(img.attr('src') ?? '', /\/api\/proxy\?u=/);
});

test('资源桥 · srcset 被移除（相对/绝对混排会取到坏图）', () => {
  const r = bridgeWithBody(el('body'));
  const img = el('img', { src: 'https://www.myao.cc/LoadImage.ashx/s.jpg', srcset: '/a.jpg 1x, /b.jpg 2x' });
  r.emit([{ type: 'childList', addedNodes: [img] }]);
  assert.equal(img.attr('srcset'), null, 'srcset 不处理 ⇒ 浏览器会优先用未代理的它取到 403');
});

test('资源桥 · video/source/iframe 的 src 与 poster 同样改写', () => {
  const r = bridgeWithBody(el('body'));
  const v = el('video', { src: 'https://cdn.x.com/m.mp4', poster: 'https://cdn.x.com/p.jpg' });
  const s = el('source', { src: 'https://cdn.x.com/s.m3u8' });
  r.emit([{ type: 'childList', addedNodes: [v, s] }]);
  assert.match(v.attr('src') ?? '', /\/api\/proxy\?u=/);
  assert.match(v.attr('poster') ?? '', /\/api\/proxy\?u=/);
  assert.match(s.attr('src') ?? '', /\/api\/proxy\?u=/);
});

test('资源桥 · observe 覆盖 childList+subtree+attributes（否则脚本插入的节点看不见）', () => {
  const r = runBridge();
  const opts = r.observeOpts();
  assert.ok(opts, 'MutationObserver 必须被 observe');
  assert.equal(opts!.childList, true);
  assert.equal(opts!.subtree, true);
  assert.deepEqual(
    (opts as unknown as { attributeFilter?: string[] }).attributeFilter,
    // `#345b` 后扩展过（html-shell.ts `attrsOf` 同源注释）：懒加载真地址
    // `data-original`（24 系列 jquery.lazyload）+ `data-lazy`/`data-echo`；
    // 旧断言（5 项、data-original 排 src 之后）已与唯一实现脱节 ⇒ 按现状修正。
    ['src', 'data-original', 'data-src', 'data-lazy', 'data-echo', 'poster', 'srcset'],
  );
  assert.ok(r.observeRoot(), '必须有观察根');
});

test('资源桥 · 生成的脚本**不能有反引号**（会截断拼接它的模板串）', () => {
  assert.doesNotMatch(buildResourceBridge(ORIGIN, SID), /`/);
  assert.doesNotMatch(buildResourceBridge(ORIGIN, SID), /<\/script/i, '字面 script 闭合标签会提前切断 SFC');
});

test('壳 · 资源桥**与 NET 桥分开注入**：无脚本的正文也要注入（盗链与有没有脚本无关）', () => {
  const doc = buildHtmlDoc('<p>纯文本无脚本</p>', { origin: ORIGIN, sid: SID });
  assert.match(doc, /MutationObserver/, '无脚本正文同样需要动态资源改写（对偶：NET 桥此时不注入）');
  // 对偶断言：正文无脚本 ⇒ NET 桥（fetch/XHR 覆写）确实**没有**注入
  assert.doesNotMatch(doc, /XMLHttpRequest\.prototype\.open/, 'NET 桥的门控是「含脚本」，此处不该出现');
});

test('壳 · origin 为空（file:// 态）⇒ 资源桥也不注入（没有可代理的服务端）', () => {
  const doc = buildHtmlDoc('<p>x</p>', { sid: SID });
  // `#376`：判定标记用资源桥**独有**的 `data-echo`（懒加载属性集合）—— 旧标记
  // `MutationObserver` 与 LIVE 观察桥撞车（它无 origin 依赖、file:// 态照常注入）。
  assert.doesNotMatch(doc, /data-echo/, '没有 origin 就没有 /api/proxy 可去 ⇒ 资源桥不注入');
  assert.doesNotMatch(doc, /XMLHttpRequest\.prototype\.open/, 'NET 桥同理不注入');
});
