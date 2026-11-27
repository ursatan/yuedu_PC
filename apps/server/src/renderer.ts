/**
 * WebView 替代方案（分层渲染器）——回答「webview 依赖的字段在 web/服务端怎么办」。
 *
 * Legado 里依赖 Android WebView 的能力与我们的分层替代：
 *  ① `java.webView(url)` / `java.startBrowserAwait(url)` / `java.startBrowser(url)`
 *     —— 取「JS 执行后的 DOM」：**L2 无头 Chromium 可完整覆盖**
 *  ② `ContentRule.webJs` / URL 尾巴 `,{"webJs":"…"}`（AnalyzeUrl.kt:483 `javaScript = webJs ?: jsStr`）
 *     —— 需在页面里注入 JS 并取返回值：L3（CDP）或 L4（桌面桥）
 *  ③ `ContentRule.sourceRegex`（BackstageWebView.kt:343 `onLoadResource` 命中正则 → 取该资源 URL）
 *     —— 需子资源拦截：L3/L4；L2 退化为「在渲染后的 HTML 里正则找 URL」
 *  ④ `callBackJs`（eventListener 事件回调，如验证码/登录回调）—— 需真实交互：仅 L4
 *  ⑤ `payAction`（购买页操作）—— 不实现（属用户交互）
 *
 * 分层（按可用性自动选择，全部失败再静态抓取兜底）：
 *  L1 静态抓取           —— 无依赖（原有行为）
 *  L2 无头 Chromium      —— 零 npm 依赖：调用本机 Chrome/Edge/Chromium `--dump-dom`
 *  L3 CDP 渲染（可选）    —— 装了 playwright-core / puppeteer-core 且给到浏览器可执行文件时启用，
 *                           支持 js 注入 / 子资源拦截（sourceRegex）
 *  L4 桌面 WebViewProvider 桥 —— 桌面端注册渲染口（/api/internal/renderer），最忠实
 *  R  远端渲染服务        —— `YUEDU_RENDER_URL`（自建 browserless/puppeteer 服务）
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildDumpDomArgs, findChromium } from '@yuedu/core';
// `#568` P3 站点定制：渲染输出补注入（与 Web 阅读壳 `injectSiteCustomize` **同一份实现**）
import { injectSiteCustomize, type SiteCustomize } from '@yuedu/core';
// `#453`（D13 = A+B）：常驻浏览器会话 —— 有该源的会话就用真浏览器渲染（登录态/cookie/TLS 指纹都带得上）
import { liveSessionCount, render as renderWithSession } from './browser-session';

export interface RenderRequest {
  /** 在页面里注入执行的 JS（Legado webJs / jsStr）——仅 L3/L4 支持 */
  js?: string;
  /** 子资源 URL 正则（Legado sourceRegex）——L3 走拦截；L2 退化为在渲染后 HTML 里匹配 */
  sourceRegex?: string;
  /** 额外等待（毫秒）——L2 用 --virtual-time-budget 近似 */
  delayMs?: number;
  /** 附加请求头（L3/L4 支持） */
  headers?: Record<string, string>;
  /**
   * 源身份（`#453`）：有值时优先走**该源的常驻会话**（L3:常驻），
   * 否则沿用原有分层。由 hub 的 `makeContext` 统一注入，引擎侧零改动。
   */
  sourceId?: string;
  /**
   * `#731` 渲染目的（与 core `WebRendererHook.kind` 同名同义）：
   * `cookie` ⇒ 宿主必须保证会话存在（建不出就抛），不许用空串让脚本静默走失败分支。
   */
  kind?: 'show' | 'cookie';
}

export interface WebRenderer {
  (url: string, opts?: RenderRequest): Promise<string>;
  /** 当前生效的渲染层（用于诊断/trace） */
  readonly layer: () => string;
}

const DEFAULT_TIMEOUT_MS = 25_000;

/** L2：无头 Chromium `--dump-dom`（零依赖，覆盖「取渲染后 DOM」这一最大类需求） */
async function renderWithChromium(exe: string, url: string, req: RenderRequest): Promise<string> {
  const profile = mkdtempSync(join(tmpdir(), 'yuedu-cr-'));
  const args = [
    // delayMs 在 dump-dom 层不支持（见 core/net/render.ts 说明）——需要等待请走 L3 CDP
    ...buildDumpDomArgs(exe, { profileDir: profile }),
    url,
  ];
  try {
    const html = await new Promise<string>((resolve, reject) => {
      execFile(exe, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: DEFAULT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) reject(err);
        else resolve(String(stdout ?? ''));
      });
    });
    // sourceRegex 退化：dump 出来的 DOM 里找匹配的绝对 URL
    if (req.sourceRegex) {
      const m = new RegExp(req.sourceRegex).exec(html);
      if (m) return m[0];
    }
    return html;
  } finally {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows 句柄占用时忽略 */
    }
  }
}

/** L3：CDP 渲染（可选依赖；装了才启用。支持 js 注入与子资源拦截） */
async function loadCdpDriver(): Promise<null | {
  render: (url: string, req: RenderRequest, exe: string | null) => Promise<string>;
}> {
  const require = createRequire(import.meta.url);
  const pick = (names: string[]): string | null => {
    for (const n of names) {
      try {
        require.resolve(n);
        return n;
      } catch {
        /* 未安装 */
      }
    }
    return null;
  };
  const mod = pick(['playwright-core', 'playwright', 'puppeteer-core', 'puppeteer']);
  if (!mod) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lib: any = require(mod);
    return {
      async render(url, req, exe) {
        const isPw = mod.includes('playwright');
        const timeout = DEFAULT_TIMEOUT_MS;
        if (isPw) {
          const browser = await lib.chromium.launch(exe ? { executablePath: exe } : {});
          try {
            const page = await browser.newPage();
            const hit: { url?: string } = {};
            if (req.sourceRegex) {
              page.on('request', (r: { url: () => string }) => {
                const u = r.url();
                if (!hit.url && new RegExp(req.sourceRegex as string).test(u)) hit.url = u;
              });
            }
            await page.goto(url, { waitUntil: 'load', timeout });
            if (req.js) {
              const ret = await page.evaluate(req.js).catch(() => '');
              if (ret) return typeof ret === 'string' ? ret : JSON.stringify(ret);
            }
            if (req.delayMs) await page.waitForTimeout(req.delayMs);
            if (req.sourceRegex) return hit.url ?? '';
            return await page.content();
          } finally {
            await browser.close();
          }
        }
        const browser = await lib.launch(exe ? { executablePath: exe, headless: 'new' } : { headless: 'new' });
        try {
          const page = await browser.newPage();
          if (req.headers) await page.setExtraHTTPHeaders?.(req.headers);
          const hit: { url?: string } = {};
          if (req.sourceRegex) {
            page.on('request', (r: { url: () => string }) => {
              const u = r.url();
              if (!hit.url && new RegExp(req.sourceRegex as string).test(u)) hit.url = u;
            });
          }
          await page.goto(url, { waitUntil: 'load', timeout });
          if (req.js) {
            const ret = await page.evaluate(req.js).catch(() => '');
            if (ret) return typeof ret === 'string' ? ret : JSON.stringify(ret);
          }
          if (req.delayMs) await new Promise((r) => setTimeout(r, req.delayMs));
          if (req.sourceRegex) return hit.url ?? '';
          return await page.content();
        } finally {
          await browser.close();
        }
      },
    };
  } catch {
    return null;
  }
}

/** 静态抓取（L1 兜底；也是所有渲染层失败时的最后退路） */
async function fetchStatic(url: string, req: RenderRequest): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: req.headers, redirect: 'follow', signal: ctrl.signal });
    return r.ok ? await r.text() : '';
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

export interface RendererOptions {
  /** 桌面端注册的渲染桥端口（行时注册会覆盖） */
  bridgePort?: () => number;
  /**
   * `#568` 站点定制解析器：给 URL 返回该站的 CSS/JS（无 ⇒ null）。
   * 由 `index.ts` 注入（读本地配置），渲染器本身**不持有**配置，避免两处真相源。
   */
  customizeFor?: (url: string) => SiteCustomize | null;
}

/** 结果像 HTML 才补注入（`sourceRegex` 命中的是 URL，不能往里塞标签）。 */
function looksLikeHtml(s: string): boolean {
  return /<(?:!doctype|html|head|body|div|article|p)\b/i.test(s);
}

/** 组装分层渲染器（返回的函数签名与 hub 的 webRenderer 兼容，额外接受 RenderRequest） */
export function createLayeredRenderer(opts: RendererOptions = {}): WebRenderer {
  const chromium = findChromium();
  // 桌面桥端口由运行时注册（/api/internal/renderer）
  const bridgePort = opts.bridgePort ?? (() => Number(process.env.YUEDU_RENDER_PORT ?? 0));
  const remoteUrl = (process.env.YUEDU_RENDER_URL ?? '').trim();

  /**
   * `#568` **注入点只有这一处**：所有层返回后统一补 —— 分层多、逐层改必漏
   * （本仓「同一语义只做一条路径」踩过多次：`#341`/`#419`）。
   * 只对 HTML 注入；URL/纯文本原样返回。
   */
  const withCustomize = (url: string, out: string): string => {
    if (!out || !opts.customizeFor) return out;
    if (!looksLikeHtml(out)) return out;
    const cfg = opts.customizeFor(url);
    return cfg ? injectSiteCustomize(out, cfg) : out;
  };

  const renderRaw = async (url: string, req: RenderRequest = {}): Promise<string> => {
    // R：远端渲染服务（自建 browserless / puppeteer 服务）
    if (remoteUrl) {
      try {
        const r = await fetch(remoteUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url, ...req }),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (r.ok) {
          const text = await r.text();
          if (text) return text;
        }
      } catch {
        /* 落到下一层 */
      }
    }
    // L4：桌面 WebViewProvider 桥
    const port = bridgePort();
    if (port > 0) {
      try {
        const qs = new URLSearchParams({ url });
        if (req.js) qs.set('js', req.js);
        if (req.sourceRegex) qs.set('sourceRegex', req.sourceRegex);
        // `#453`：把源身份带给桌面桥 —— 桌面端据此选中该源的常驻 WebContentsView（登录态/cookie 复用）
        if (req.sourceId) qs.set('sourceId', req.sourceId);
        const r = await fetch(`http://127.0.0.1:${port}/render?${qs.toString()}`, {
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (r.ok) {
          const text = await r.text();
          if (text) return text;
        }
      } catch {
        /* 落到下一层 */
      }
    }
    // L3：常驻会话（`#453`）——该源已有真浏览器会话时**优先**：登录态 / cookie / TLS 指纹都在里面，
    // 这正是「过 JS challenge / 人机验证 / 防盗链」的关键。没有会话时它立刻返回 '' ⇒ 无副作用回落。
    if (req.sourceId) {
      try {
        const out = await renderWithSession(url, {
          sourceId: req.sourceId,
          /**
           * `#731` `startBrowserAwait`/`webView`（`kind:'cookie'`）**没有会话就建一个**，
           * 而不是返回 '' 让脚本静默失败；建不出（或中途会话死亡）⇒ 抛明确错误（下面 rethrow）。
           */
          ...(req.kind === 'cookie' ? { ensureSession: true } : {}),
          /**
           * `#664` **有会话就优先用「可见页」**（同 URL 直接读、同源不同 URL 导航它），
           * 而不是新开一个 render tab 重新导航 —— 新 tab 没有 clearance，必然再吃一次挑战，
           * 于是每个请求都要「渲染一次→撞盾→有头重放一次」，Web 端因此明显比浏览器慢。
           */
          preferVisible: true,
          settleMs: 8_000,
          ...(req.js ? { js: req.js } : {}),
          ...(req.sourceRegex ? { sourceRegex: req.sourceRegex } : {}),
          ...(req.delayMs ? { delayMs: req.delayMs } : {}),
        });
        if (out) return out;
      } catch (e) {
        /**
         * `#731` `kind:'cookie'` 的失败**必须冒泡**（core 的 render 分支会原样抛给脚本）：
         * 吞掉就退化成「空正文」，正是用户看到的「验证会话已结束或浏览器不可用」。
         */
        if (req.kind === 'cookie') throw e instanceof Error ? e : new Error(String(e));
        /* 其它渲染失败落到下一层 */
      }
    }
    // L3：CDP 渲染（可选依赖）
    if (req.js || req.sourceRegex) {
      const cdp = await loadCdpDriver();
      if (cdp) {
        try {
          const out = await cdp.render(url, req, chromium);
          if (out) return out;
        } catch {
          /* 落到下一层 */
        }
      }
    }
    // L2：无头 Chromium dump-dom（零依赖，覆盖绝大多数「取渲染后 DOM」）
    if (chromium) {
      try {
        const out = await renderWithChromium(chromium, url, req);
        if (out) return out;
      } catch {
        /* 落到静态 */
      }
    }
    // L1：静态抓取
    return fetchStatic(url, req);
  };

  /** `#568` 对外入口：所有分层结果统一过定制注入（见 `withCustomize` 头注）。 */
  const render = async (url: string, req: RenderRequest = {}): Promise<string> =>
    withCustomize(url, await renderRaw(url, req));

  const fn = render as WebRenderer;
  Object.defineProperty(fn, 'layer', {
    value: () => {
      const live = liveSessionCount();
      return [
        remoteUrl ? 'R:远端' : '',
        bridgePort() > 0 ? 'L4:桌面桥' : '',
        live > 0 ? `L3:常驻(${live})` : '',
        chromium ? `L2:无头(${chromium.split(/[\\/]/).slice(-2).join('/')})` : '',
        'L1:静态',
      ]
        .filter(Boolean)
        .join(' + ');
    },
  });
  return fn;
}
