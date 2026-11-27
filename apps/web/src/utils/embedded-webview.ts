/**
 * `#453` **内嵌真浏览器（桌面端 `WebContentsView`）的渲染进程侧唯一出口**。
 *
 * ## 两条纪律
 * ① **不 import 任何 Electron API**：能力探测只看 preload 白名单挂在 `window.yuedu` 上的那几个方法。
 *    浏览器里（web 端）`window.yuedu` 不存在 ⇒ 全部返回「不可用」⇒ 调用方**维持既有 iframe 通路**
 *    （这就是「保留现有 web 实现」的落点：不是降级实现，而是同一条回落分支）。
 * ② **同一个会话键全局只有一只 view**（`main.js` 的常驻池保证）。所以组件卸载时**必须** `detach`
 *    —— 把 view 挂回后台（**不销毁**：TTL 内重开还是同一个页面、同一份登录态），别让它占着屏幕。
 *
 * ## 谁负责挂载（bounds 从哪来）
 * `bounds` 是**相对窗口内容区**的 CSS 像素，由**调用方从自己的占位元素**量出来（`getBoundingClientRect`）；
 * 主进程还会再夹一次（`lib-webview-pool` 的 `clampBounds`），越界也不会跑到看不见的地方。
 * 也就是说：渲染进程负责「位置」，主进程负责「真浏览器」。
 *
 * ## 事件为什么「只报不判」
 * 主进程在 `will-navigate` / 新窗口一律先 `preventDefault()`，然后经 `onEmbeddedEvent` 上报。
 * **判据在渲染进程**：
 *  · `legado:` / `yuedu:` 深链 ⇒ 交 `dispatchSchemeImport`（这是应用内浏览器的既有价值，见 InAppBrowser 头注）；
 *  · 其余页面内跳转 ⇒ 由调用方决定（内嵌浏览器里放行、阅读页里按同站判据分流）。
 * 同站判据全仓只有一份（`utils/source-site.ts` 的 `sameSite()`），这里**不重复实现**。
 */

export interface WebviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WebviewEventType = 'navigate' | 'open' | 'navigated' | 'title';

export interface WebviewEvent {
  /** 会话键（`src:<sourceId>` / `anon`） */
  key: string;
  type: WebviewEventType;
  url?: string;
  /** `type: 'open'` 时来自 Electron（`foreground-tab` / `new-window` …） */
  disposition?: string;
  title?: string;
}

export interface WebviewResult {
  ok: boolean;
  key?: string;
  url?: string;
  value?: unknown;
  exists?: boolean;
  pinned?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  closed?: boolean;
  error?: string;
}

/** 一条 cookie（Electron `session.cookies.get()` 的子集，够服务端 `pickLoginCookies` 用） */
export interface WebviewCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

/** preload.js 暴露的那几个方法（**唯一事实来源是 `apps/desktop/preload.js`**，改了要同步） */
interface WebviewBridge {
  webviewOpen(o: { key?: string; sourceId?: string; url: string; bounds?: WebviewBounds }): Promise<WebviewResult>;
  webviewAttach(o: { key?: string; sourceId?: string; bounds?: WebviewBounds }): Promise<WebviewResult>;
  webviewDetach(o: { key?: string; sourceId?: string }): Promise<WebviewResult>;
  webviewNav(o: { key?: string; sourceId?: string; url?: string; action?: 'back' | 'forward' | 'reload' }): Promise<WebviewResult>;
  webviewExec(o: { key?: string; sourceId?: string; js: string }): Promise<WebviewResult>;
  /** `#568` P3 站点定制：给当前 view 注入 CSS/JS（每次导航后由前端按新地址重新解析后调用） */
  webviewInject(o: { key?: string; sourceId?: string; css?: string; js?: string }): Promise<WebviewResult>;
  webviewStatus(o: { key?: string; sourceId?: string }): Promise<WebviewResult>;
  webviewClose(o: { key?: string; sourceId?: string }): Promise<WebviewResult>;
  /** `#456` 只读该会话 partition 里的 cookie（桌面端独有；回传服务端由本文件负责） */
  webviewCookies(o: { key?: string; sourceId?: string }): Promise<WebviewResult & { cookies?: WebviewCookie[] }>;
  onWebviewEvent(cb: (ev: WebviewEvent) => void): () => void;
}

function bridge(): WebviewBridge | null {
  if (typeof window === 'undefined') return null;
  const w = (window as { yuedu?: Partial<WebviewBridge> }).yuedu;
  // 用 `webviewOpen` 作为能力判据：老版本桌面端（Electron < 30）没有它 ⇒ 一律回落
  return w && typeof w.webviewOpen === 'function' ? (w as WebviewBridge) : null;
}

/** 真 view 是否可用（桌面端 Electron ≥ 30 才有；浏览器里恒 false） */
export function embeddedAvailable(): boolean {
  return bridge() != null;
}

/** 源身份 → 会话键（与服务端 `sessionKeyOf` / 桌面端 `normalizeKey` 同一口径） */
export function embeddedKeyOf(sourceId?: string): string {
  const id = String(sourceId ?? '').trim();
  return id ? `src:${id}` : 'anon';
}

/** 打开（或复用）某会话的 view 并挂到主窗口上 */
export const embeddedOpen = (o: { sourceId?: string; url: string; bounds?: WebviewBounds }): Promise<WebviewResult> =>
  bridge()?.webviewOpen(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

/** 只调位置/尺寸（窗口缩放、布局变化时调；不重新加载） */
export const embeddedAttach = (o: { sourceId?: string; bounds?: WebviewBounds }): Promise<WebviewResult> =>
  bridge()?.webviewAttach(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

/** 收起（挂回后台，**不销毁**） */
export const embeddedDetach = (o: { sourceId?: string }): Promise<WebviewResult> =>
  bridge()?.webviewDetach(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

export const embeddedNav = (o: { sourceId?: string; url?: string; action?: 'back' | 'forward' | 'reload' }): Promise<WebviewResult> =>
  bridge()?.webviewNav(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

/** 页面内执行脚本（代点按钮 / 取数据） */
export const embeddedExec = (o: { sourceId?: string; js: string }): Promise<WebviewResult> =>
  bridge()?.webviewExec(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

/**
 * `#568` 站点定制：给真 view 注入 CSS/JS。
 * 每次**导航完成后**都要再调一次（页面换了，旧的样式/脚本随文档销毁）。
 * 拿不到 `webviewInject`（老桌面端）⇒ 静默跳过：iframe 通路仍会注入，不是功能缺失。
 */
export const embeddedInject = (o: { sourceId?: string; css?: string; js?: string }): Promise<WebviewResult> =>
  bridge()?.webviewInject?.(o) ?? Promise.resolve({ ok: true, key: '' });

export const embeddedStatus = (o: { sourceId?: string }): Promise<WebviewResult> =>
  bridge()?.webviewStatus(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

/** 关掉某会话的 view（partition 保留：登录态在磁盘上，重开即复用） */
export const embeddedClose = (o: { sourceId?: string }): Promise<WebviewResult> =>
  bridge()?.webviewClose(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

/** 订阅页内事件（返回退订函数）；浏览器里恒返回一个空退订 */
export function onEmbeddedEvent(cb: (ev: WebviewEvent) => void): () => void {
  return bridge()?.onWebviewEvent(cb) ?? (() => undefined);
}

/* ------------------------------------------------------------------ *
 * `#456` 内嵌 view 的 Cookie → 回传服务端（**harvest 通道**）
 * ------------------------------------------------------------------ */

/**
 * 只读该会话 partition 的 cookie（桌面端独有）。
 * 浏览器里 / 老桌面端 ⇒ `{ ok:false, error:'NOT_SUPPORTED' }`。
 */
export const embeddedCookies = (o: { sourceId?: string }): Promise<WebviewResult & { cookies?: WebviewCookie[] }> =>
  bridge()?.webviewCookies(o) ?? Promise.resolve({ ok: false, error: 'NOT_SUPPORTED' });

export interface HarvestResult {
  ok: boolean;
  /** 真正写进源 CookieStore 的条数 */
  count?: number;
  /** 被筛掉的域名（诊断用） */
  total?: number;
  picked?: string[];
  error?: string;
  message?: string;
}

/**
 * **PC 端内嵌浏览器 → 服务端 CookieStore** 的唯一通道。
 *
 * 为什么必须显式搬一次：桌面端内嵌 view 的 cookie 在 Electron 的 `persist:src-<id>` partition 里，
 * 服务端的登录窗 cookie 在**另一只 Chromium 进程**的 profile 里 —— 服务端的 `/login/harvest`
 * 读的是后者，对桌面端这份**看不见**。所以这里「读出 partition → POST 给服务端」，
 * 域过滤 / 同名去重 / 合并 / 落盘全部在服务端（`pickLoginCookies` + `mergeSourceCookies` + `COOKIES_FILE`），
 * **本文件不重写任何判据**。
 *
 * @param hosts 可选：覆写候选域名（默认由服务端按登录页 + 源站推算，与登录窗 harvest 同一条式子）
 */
export async function embeddedHarvest(sourceId: string, hosts: string[] = []): Promise<HarvestResult> {
  const id = String(sourceId ?? '').trim();
  if (!id) return { ok: false, error: 'NO_SOURCE' };
  const read = await embeddedCookies({ sourceId: id });
  if (!read.ok) return { ok: false, error: read.error ?? 'READ_FAILED' };
  const cookies = (read.cookies ?? []).filter((c) => c?.name);
  if (!cookies.length) {
    return { ok: false, error: 'NO_COOKIES', message: '内嵌浏览器里还没有 Cookie——先在页面里完成登录/验证' };
  }
  try {
    // 同源相对路径：界面本身就是由这台服务提供的（桌面端与浏览器端都一样）
    const res = await fetch(`/api/sources/${encodeURIComponent(id)}/login/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookies, ...(hosts.length ? { hosts } : {}) }),
    });
    const j = (await res.json().catch(() => null)) as (HarvestResult & { count?: number }) | null;
    if (!res.ok || !j) return { ok: false, error: `HTTP_${res.status}`, message: j?.message };
    return {
      ok: j.ok === true,
      ...(typeof j.count === 'number' ? { count: j.count } : {}),
      ...(typeof j.total === 'number' ? { total: j.total } : {}),
      ...(j.picked ? { picked: j.picked } : {}),
      ...(j.message ? { message: j.message } : {}),
    };
  } catch (e) {
    return { ok: false, error: 'NETWORK', message: e instanceof Error ? e.message : String(e) };
  }
}
