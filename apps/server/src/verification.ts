/**
 * `#482` **Web 端内嵌验证窗（服务端半边）**
 *
 * 用户口径（2026-10-17）：过 Cloudflare / 验证码**不要弹独立 Chrome**，要在 Web 端里弹页面。
 * 桌面端已有 `WebContentsView` 内嵌（`embedded-webview`），**Web 纯浏览器端没有**——
 * 直接 `<iframe>` 会被 CF 的 `X-Frame-Options` / `frame-ancestors` 拒掉（这也是为什么
 * 之前只能「弹一只独立 Chrome 给用户看」）。
 *
 * 通路：服务端那只**常驻会话浏览器**（`browser-session.ts`，与反爬重放同一只、同一份 profile）
 * 　├ 用 CDP `Page.startScreencast` 抓 JPEG 帧 → 经 SSE 推给前端 canvas（≈10fps）
 * 　├ 前端的鼠标/键盘 → `POST /api/verify/:id/input` → CDP `Input.*` 回灌
 * 　└ 轮询页面特征判「是否已清关」→ `phase` 变化推给前端 ⇒ 前端自动重试原请求
 *
 * ★ 为什么**不**用无头：实测（`#481`）L2 无头 shell **过不了 CF**（指纹被判机器人）。
 *   所以仍是**有头**完整 Chromium 以保住指纹，但用 `Browser.setWindowBounds` 把窗口
 *   移到屏幕外 ⇒ 用户全程看不到弹窗，只在 Web 端的浮层里看到同一只浏览器的画面。
 *
 * ★ 为什么用 SSE 而不是 WebSocket：仓库里没有 ws 依赖，且 SSE 与现有
 *   `/api/aggregate/search` 的流式聚合**同一套机制**（代理友好、零新依赖）；
 *   输入是低频事件，走普通 POST 即可（延迟无感）。
 */
import { randomUUID } from 'node:crypto';
import { findFullChromium, harvestHosts } from '@yuedu/core';
import {
  acquire,
  attachPageSession,
  closeBlankTabs,
  getSession,
  minimizeWindow,
  moveWindowOffscreen,
  release,
  sessionKeyOf,
  type BrowserSession,
} from './browser-session';
import { harvestLoginCookies } from './browser-login';
import { normalizeNavUrl } from './nav-url';
import type { CdpClient } from './browser-session';

export type VerifyPhase = 'starting' | 'challenge' | 'cleared' | 'failed' | 'closed';

export interface VerifySessionMeta {
  id: string;
  sourceId: string;
  url: string;
  phase: VerifyPhase;
  startedAt: number;
  /** 判到「已清关」的时刻（前端据此自动重试原请求） */
  clearedAt?: number;
  error?: string;
  /** 最近一帧的页面 CSS 尺寸（前端换算点击坐标用） */
  width: number;
  height: number;
  /** 浏览器窗口是否已被移到屏幕外（`offscreen:true` 时的实际结果） */
  offscreen: boolean;
  /** 最近一次推帧时刻（用于「还有没有人在线」的判据） */
  lastFrameAt?: number;
}

export type VerifyEvent =
  | { type: 'frame'; data: string; w: number; h: number }
  | { type: 'phase'; phase: VerifyPhase; url?: string; error?: string }
  | { type: 'closed' };

interface Live {
  meta: VerifySessionMeta;
  session: BrowserSession;
  cdp: CdpClient;
  targetId: string;
  cdpSession: string;
  unsub: Array<() => void>;
  subs: Set<(e: VerifyEvent) => void>;
  timer?: ReturnType<typeof setInterval>;
  /** screencast 是否正在跑（订阅者归零时停，省流量；有人订阅再起） */
  casting: boolean;
  /**
   * `#488` **boot 完成门**：前端在浏览器就绪前就会连帧流、点「刷新」/「填入」
   * （那时 `cdp` 还是 undefined）⇒ 老实现立刻返回 false，浮层上表现为
   * `VERIFY_NAV_FAILED` + 永远空白的画面。现在所有依赖 `cdp` 的操作都先等这扇门。
   */
  ready: Promise<void>;
  markReady: () => void;
  /** 是否已把「清关后」的浏览器 Cookie 收割回引擎（每会话只做一次） */
  harvested?: boolean;
  /** `#657` 连续 CDP 失败计数（-1 = 已判定浏览器死亡并收摊） */
  cdpFails?: number;
  /** 会话 id（`noteCdpResult` 收摊时用） */
  id: string;
  /**
   * `#710` boot 是否正在跑。
   * 失败后用户点「刷新」会重新拉起浏览器；这个标志防止「启动中又点刷新」叠出第二只
   * （同 profile 单例锁会把后来的顶掉，反而更像「启动失败」）。
   */
  bootRunning?: boolean;
  /** `#710` 本次 boot 是否复用了已有浏览器（false = 这次新拉起的进程，失败时要收掉避免空窗） */
  bootReused?: boolean;
  /** `#710` 重启中（`rebootLive` 的防重入） */
  rebooting?: boolean;
  /** `#731` 该源请求指纹（重开时沿用，避免每次「刷新」都换 UA 让 clearance 失效） */
  ua?: string;
  acceptLanguage?: string;
}

const lives = new Map<string, Live>();
/** sourceId → 验证会话 id（同一源只开一个，避免多只浏览器互抢 profile） */
const bySource = new Map<string, string>();

/**
 * **类CB（2026-10-26）「过了验证但引擎还是 403/challenge」的收口点**。
 *
 * 用户实测（Aff / `asianfanfics.com`）：浮层显示「站点安全验证：已通过验证，正在重试刚才的请求…」
 * 然后**又回到验证页**，无限循环，同时服务端堆了 8 条 `/api/verify/:id/stream` 永不关闭。
 *
 * 真因不是判据错，而是**过了验证之后什么也没做**：浏览器（与登录窗同一 profile）里已经有了
 * 放行 Cookie，但引擎的源 CookieStore 还是空的 ⇒ 重试原请求又被挑战 ⇒ 又开验证 ⇒ 死循环。
 * 登录链路早有 `harvestLoginCookies`，验证链路从来没调过 —— 这里补上。
 *
 * 解耦方式：verification 不认识 hub，只把收割结果交给注入的 sink（index.ts 注册）。
 */
let cookieSink: ((sourceId: string, map: Record<string, string>) => void) | null = null;
export function setVerifyCookieSink(fn: (sourceId: string, map: Record<string, string>) => void): void {
  cookieSink = fn;
}

/**
 * `#658` **过闸那只浏览器的 UA** 也要收割（不只是 Cookie）。
 *
 * Cloudflare 的 `cf_clearance` **与 UA 绑定**：验证窗里用桌面 Chrome 过的闸，若引擎随后用
 * 源 header 里的移动 UA 去请求，clearance 直接作废 ⇒ 403 ⇒ 又被判「需要人工」再弹一次窗。
 * 实测 138阅读网就是这样死循环（jar 里 `cf_clearance` 明明存在、正文仍 403）。
 */
let uaSink: ((sourceId: string, ua: string) => void) | null = null;
export function setVerifyUaSink(fn: (sourceId: string, ua: string) => void): void {
  uaSink = fn;
}

/** 读活动页面的 UA（失败返回空串：宁可不改，也不要写进一个假 UA） */
async function readSessionUa(live: Live): Promise<string> {
  if (!live.cdp) return '';
  try {
    const r = await live.cdp.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'navigator.userAgent', returnByValue: true },
      live.cdpSession,
    );
    const ua = typeof r.result?.value === 'string' ? r.result.value : '';
    return ua.trim();
  } catch {
    return '';
  }
}

/** 清关后收割一次 Cookie 回引擎（失败只留痕，不影响浮层） */
async function harvestAfterCleared(live: Live): Promise<void> {
  if (live.harvested || !cookieSink) return;
  live.harvested = true;
  try {
    const hosts = harvestHosts([live.meta.url]);
    const h = await harvestLoginCookies(live.meta.sourceId, hosts);
    if (!h.ok) {
      console.warn(`[verify] 清关后收割 Cookie 失败：${h.error}`);
      return;
    }
    const map: Record<string, string> = {};
    for (const c of h.cookies) map[c.name] = c.value;
    const n = Object.keys(map).length;
    /**
     * `#658` UA 与 Cookie 一起收割（顺序：先 UA 后 Cookie，保证下一次请求两者一致）。
     * 没有 UA 就不写 —— 让引擎继续用源 header 的 UA（宁可 403 也不要假装成别的浏览器）。
     */
    const ua = await readSessionUa(live);
    if (ua && uaSink) {
      uaSink(live.meta.sourceId, ua);
      console.log(`[verify] 清关 ⇒ 已收割会话 UA 回引擎（${ua.slice(0, 60)}…）`);
    }
    if (n) {
      cookieSink(live.meta.sourceId, map);
      console.log(`[verify] 清关 ⇒ 已收割 ${n} 个 Cookie 回引擎（${hosts.join(',')}）`);
    } else {
      console.log(`[verify] 清关但浏览器里没有匹配 ${hosts.join(',')} 的 Cookie（引擎侧可能仍被挑战）`);
    }
  } catch (e) {
    console.warn(`[verify] 清关后收割异常：${e instanceof Error ? e.message : String(e)}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `#731` **复用实例的 attach 阈值**：正常的 `Target.attachToTarget` 是百毫秒级；
 * 用户 3000 日志里复用实例 attach 用了 10.5s，紧接着 `Emulation.setUserAgentOverride` 超时
 * ⇒ 那只实例已经半死。超过这个值就重建会话（判据是同一调用实测耗时，不是进程存活/延时）。
 */
const ATTACH_SLOW_MS = 8_000;

/**
 * CF / 常见人机验证页的特征词。
 * ★ 与 `index.ts` 里 antibotReplay 的判据**同源**（同一份正则语义），但那个判定发生在
 *   一次性渲染结果上，这个是**轮询活页面**，所以单独留一份并注明：改一处要改两处 ⇒
 *   判据短且稳定，不做花活（新增特征词请同步两处）。
 */
const CHALLENGE_RE =
  /just a moment|cf_chl|challenge-platform|cf-browser-verification|attention required|checking your browser|verify you are human|are you a robot|enable javascript and cookies to continue|__wafcaptcha|acw_sc__v2|aliyungf_tc|wafcaptcha|访问频率太高|访问过于频繁|请输入验证码|\/\.safeline\//i;

/** 页面探针：一次 `Runtime.evaluate` 拿回「是不是挑战页 + 页面规模 + 当前地址」 */
const PROBE_EXPR = `JSON.stringify({
  href: String(location.href),
  len: document.documentElement ? document.documentElement.outerHTML.length : 0,
  head: document.documentElement ? document.documentElement.outerHTML.slice(0, 3000) : '',
  title: String(document.title || ''),
  ready: String(document.readyState || '')
})`;

/**
 * `#731` **「页面真的到了」的判据**（导出为纯函数供回归锁）。
 *
 * 为什么不能只看 `Page.navigate` 返回：慢机器上 `Target.createTarget` 建出 target 后
 * 页面还在 about:blank / 加载中，旧实现立刻 `mark('ready')` + 起 screencast + 起探针
 * ⇒ 探针把 about:blank 当挑战页（`len < 2000`）⇒ 浮层永远「正在拉起验证浏览器…」，
 * 窗口标题也一直是空的（用户看到的「无标题」）。
 */
export function isDocReady(state: { url?: string; readyState?: string }): boolean {
  const u = String(state.url ?? '').trim();
  const rs = String(state.readyState ?? '').trim();
  if (!/^https?:/i.test(u)) return false;
  return rs === 'interactive' || rs === 'complete';
}

const DOC_EXPR = `JSON.stringify({
  url: String(location.href),
  readyState: String(document.readyState || ''),
  title: String(document.title || ''),
  len: document.documentElement ? document.documentElement.outerHTML.length : 0
})`;

/** 读一次目标页状态（导航中会失败 ⇒ 返回 null，由调用方下一轮再读） */
async function readDocState(live: Live): Promise<{ url: string; readyState: string; title: string; len: number } | null> {
  if (!live.cdp) return null;
  try {
    const r = await live.cdp.send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: DOC_EXPR, returnByValue: true },
      live.cdpSession,
    );
    const raw = r.result?.value;
    const p = (typeof raw === 'string' ? JSON.parse(raw) : null) as
      | { url?: string; readyState?: string; title?: string; len?: number }
      | null;
    if (!p) return null;
    return {
      url: String(p.url ?? ''),
      readyState: String(p.readyState ?? ''),
      title: String(p.title ?? ''),
      len: Number(p.len ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * `#731` **有界等「页面真的到了」**：`document.readyState ∈ interactive|complete` 且 URL 是 http(s)。
 *
 * 只等「就绪」，不等「清关」：挑战页本身也是就绪的（`readyState=complete`），
 * 清关判定仍由 `startProbe` 负责（两者语义不同，不能合并）。
 */
async function waitDocReady(live: Live, budgetMs: number): Promise<{ url: string; title: string; readyState: string }> {
  const deadline = Date.now() + Math.max(1000, budgetMs);
  let last: { url: string; readyState: string; title: string } = { url: '', readyState: '', title: '' };
  while (Date.now() < deadline) {
    const st = await readDocState(live);
    if (st) {
      last = st;
      if (isDocReady(st)) return st;
    }
    await sleep(250);
  }
  throw new Error(
    `导航未完成（${Math.round(budgetMs / 1000)}s）：最终 url=${last.url || '(空)'} · readyState=${last.readyState || '(空)'} · 标题=${last.title || '(空)'}`,
  );
}

/** `#731` target 现场（type/url/title）：窗口「无标题」时一眼看出是不是另一个空 target 被认领了 */
async function logTargets(live: Live, label: string): Promise<void> {
  if (!live.cdp) return;
  try {
    const r = await live.cdp.send<{
      targetInfos?: Array<{ targetId: string; type: string; url: string; title: string }>;
    }>('Target.getTargets');
    const rows = (r.targetInfos ?? [])
      .filter((t) => t.type === 'page')
      .map((t) => `${t.targetId.slice(0, 8)} ${t.url || '(空)'} "${t.title || '(空标题)'}"`);
    console.log(`[verify] targets@${label}: ${rows.length ? rows.join(' | ') : '(无 page target)'}`);
  } catch (e) {
    console.warn(`[verify] targets@${label} 读取失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

function broadcast(live: Live, e: VerifyEvent): void {
  for (const cb of live.subs) {
    try {
      cb(e);
    } catch {
      /* 单个订阅者挂了不影响别人 */
    }
  }
}

function setPhase(live: Live, phase: VerifyPhase, extra: { error?: string; url?: string } = {}): void {
  if (live.meta.phase === phase && !extra.error) return;
  live.meta.phase = phase;
  if (phase === 'cleared') {
    live.meta.clearedAt = Date.now();
    // 类CB：清关那一刻就把浏览器 Cookie 收割回引擎（前端随后会重试原请求）
    void harvestAfterCleared(live);
  }
  if (extra.error) live.meta.error = extra.error;
  if (extra.url) live.meta.url = extra.url;
  broadcast(live, { type: 'phase', phase, ...(extra.error ? { error: extra.error } : {}), ...(extra.url ? { url: extra.url } : {}) });
}

/**
 * `#657` **僵尸会话检测**：CDP 连续超时 ⇒ 判浏览器已死，**立刻结束会话并给明确原因**。
 *
 * ## 事故（用户实测 Aff）
 * 日志一整串都是「每个操作各卡 9~10s 然后失败」：
 *   `[verify] startScreencast 失败：CDP Page.startScreencast 超时`
 *   `[verify] 导航失败（…/login）：CDP Page.navigate 超时`
 *   `[yuedu] 浏览器会话仍有未收掉的空白标签（已重试 10 轮）`
 * 原因：`CdpClient.send` 的超时是 10s，浏览器一旦卡死（zombie），会话**仍然活着**
 * ⇒ 用户点一次卡 10s、再点再卡 10s，浮层最后报 `VERIFY_NAV_FAILED`「验证会话已结束或
 * 浏览器不可用」，而真正该做的是**把这只浏览器扔掉重开**。
 *
 * 修法：连续 3 次 CDP 失败即收摊（`-1` = 已判定死亡）。用户下一次点开就是一只新浏览器，
 * 不用再白等两轮 10s。
 *
 * `#660` **判据只认「主动命令」**（`Page.navigate` / `Page.startScreencast`）：
 * 探针心跳（`Runtime.evaluate`）与输入回灌（`Input.*`）在「页面正在导航」时超时是**正常现象**，
 * 把它们算进去会在一片正常的翻章过程中把会话杀掉（用户实测就撞上了）。
 */
const CDP_DEAD_AFTER = 3;
function noteCdpResult(live: Live, ok: boolean): void {
  if (ok) {
    live.cdpFails = 0;
    return;
  }
  live.cdpFails = (live.cdpFails ?? 0) + 1;
  /**
   * `#667` **判死前做一次「能力探测」**：`Runtime.evaluate('1')` 2s 内能回 ⇒ 浏览器还活着。
   *
   * 为什么补这一步：`#665`/`#666` 两次教训都是「用间接信号推断浏览器死活」。
   * 这里的失败计数同样可能被「页面正在重导航」刷满（导航中 navigate/screencast 都会超时），
   * 而杀掉一个活着的会话代价很高（用户重新过闸）。
   */
  if ((live.cdpFails ?? 0) >= CDP_DEAD_AFTER && live.meta.phase !== 'closed' && live.meta.phase !== 'failed') {
    void (async () => {
      try {
        const ok = await Promise.race([
          live.cdp!.send('Runtime.evaluate', { expression: '1', returnByValue: true }, live.cdpSession),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), 2000)),
        ]);
        if (ok) {
          live.cdpFails = 0;
          console.warn('[verify] 命令连续失败但浏览器仍可应答（Runtime.evaluate 通）⇒ 不判死，计数清零');
          return;
        }
      } catch {
        /* 探测也失败 ⇒ 继续走判死 */
      }
      if (live.meta.phase === 'closed' || live.meta.phase === 'failed') return;
    console.warn(`[verify] 浏览器无响应（CDP 连续 ${live.cdpFails} 次失败）⇒ 结束会话 ${live.id}，下次会重新拉起浏览器`);
      live.cdpFails = -1;
      live.meta.phase = 'failed';
      live.meta.error = '浏览器无响应（已结束会话）— 请重新打开验证窗，会自动拉起新的浏览器';
      broadcast(live, { type: 'phase', phase: 'failed', error: live.meta.error });
      void closeVerification(live.id).catch(() => undefined);
    })();
  }
}

/** 起/停 screencast（订阅者驱动，无人看时不白烧 CPU 与带宽） */
async function setCasting(live: Live, on: boolean): Promise<void> {
  if (live.casting === on) return;
  /**
   * ★ 浏览器还没就绪（`boot` 在后台跑）时**静默跳过**：`live.cdp` 尚为 undefined，
   * 直接 `send` 会抛 `Cannot read properties of undefined`（冒烟实测踩到）。
   * `boot` 末尾会按 `subs.size` 补启，语义不丢。
   */
  if (!live.cdp) return;
  try {
    if (on) {
      await live.cdp.send(
        'Page.startScreencast',
        { format: 'jpeg', quality: 55, maxWidth: 960, maxHeight: 720, everyNthFrame: 1 },
        live.cdpSession,
      );
    } else {
      await live.cdp.send('Page.stopScreencast', {}, live.cdpSession);
    }
    live.casting = on;
    noteCdpResult(live, true);
  } catch (e) {
    if (on) {
      console.warn(`[verify] startScreencast 失败（不影响会话存活，稍后可重试）：${e instanceof Error ? e.message : String(e)}`);
      /**
       * `#731` **录屏超时不再计入「CDP 连续失败」**。
       *
       * 用户实测 Aff（慢机器）：`boot ready +55s` 之后紧跟一条
       * `startScreencast 失败：CDP Page.startScreencast 超时`，旧实现 `noteCdpResult(false)`
       * 把它算作一轮失败；紧接着导航/探针也超时 ⇒ 凑满 3 次 ⇒ 能力探测也超时 ⇒
       * 判「浏览器无响应」并**关掉整个验证会话** ⇒ 前端只剩「验证会话已结束或浏览器不可用」。
       * 但浏览器其实活着，只是慢。录屏是**可选增强**（没有帧浮层仍可显示阶段文案），
       * 不能作为判死证据；判死只留给 `Page.navigate` 这类会改变页面状态主动命令。
       */
    }
  }
}

/**
 * 轮询页面判「清关」。
 *
 * 为什么轮询而不是等事件：CF 挑战通过后是**页面自身跳转**（可能同页 DOM 改写，不发任何
 * 我们能订阅的确定性事件），而 `Page.loadEventFired` 在挑战页阶段也会触发 ⇒ 不可信。
 * 取页面前 3KB 特征 + 整体长度是唯一稳的判据（挑战页 <2KB 且带特征词）。
 */
function startProbe(live: Live): void {
  const tick = async (): Promise<void> => {
    if (live.meta.phase === 'closed' || live.meta.phase === 'failed') return;
    try {
      const r = await live.cdp.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: PROBE_EXPR, returnByValue: true },
        live.cdpSession,
      );
      const raw = r.result?.value;
      const p = (typeof raw === 'string' ? JSON.parse(raw) : {}) as { href?: string; len?: number; head?: string };
      const len = Number(p.len ?? 0);
      const head = String(p.head ?? '');
      if (p.href && p.href !== live.meta.url && /^https?:/i.test(p.href)) live.meta.url = p.href;
      if (CHALLENGE_RE.test(head)) {
        setPhase(live, 'challenge');
        return;
      }
      // 挑战页都很小（CF 的 "Just a moment" 约 10~20KB，且已被上面的特征词拦下）
      if (len > 2000) setPhase(live, 'cleared');
      else if (live.meta.phase === 'starting') setPhase(live, 'challenge');
    } catch {
      /**
       * 页面正在导航，下一轮再看。
       *
       * `#660` **不要在这里判死**（`#657` 引入的回归）：探针每 900ms 跑一次 `Runtime.evaluate`，
       * 而反爬重放会**不停地给可见页导航**（每章一次）—— 导航中的 evaluate 必然超时，
       * 连续两次就把会话判死。用户实测：正读着书，日志刷一串
       * `输入回灌失败（wheel）：CDP Input.dispatchMouseEvent 超时` 之后
       * `浏览器无响应（CDP 连续 2 次失败）⇒ 结束会话`，浏览器被我们自己关掉，
       * 下一次点击又要重新拉起（甚至 `浏览器未在预期时间内开启调试端口` ⇒ 正文 403）。
       * 判死的证据只能是**导航/录屏**这类主动命令连续失败，不能是心跳。
       */
    }
  };
  live.timer = setInterval(() => void tick(), 900);
  void tick();
}


/**
 * 开一个验证会话（同一源复用；已存在则导航到新 URL）。
 *
 * ★ **不阻塞到浏览器就绪**：先登记 meta 让前端能立刻连上帧流，浏览器启动在后台跑，
 *   失败以 `phase:'failed'` + `error` 推给前端（拉一只 Chromium 要 3~8s，同步等会把
 *   `/api/run` 拖进长尾）。
 */
export async function openVerification(opts: {
  sourceId: string;
  url: string;
  /** 窗口移出屏幕（默认 true：这就是「不弹独立 Chrome」的那一半） */
  offscreen?: boolean;
  /**
   * `#731` **该源当前请求的 UA**：验证会话必须与引擎请求同源指纹。
   *
   * 断点：源 header 写的是移动 UA，验证窗里过闸的是桌面 Chrome ⇒ clearance 与 UA 绑定，
   * 收割回来也没用（`#658` 的同一类事故）。这里把「引擎正在用的 UA」注入验证会话，
   * 让两边从一开始就是同一个字符串；不传则**反向**：boot 完成后把浏览器 UA 登记回引擎。
   */
  ua?: string;
  /** `#731` 与 UA 配套的 `Accept-Language`（同样影响指纹） */
  acceptLanguage?: string;
}): Promise<VerifySessionMeta> {
  const sourceId = String(opts.sourceId ?? '').trim();
  /**
   * `#731` 入参可能是 `sourceKey|`url``（hub 的缓存键被误当 URL 传进来）⇒
   * 统一在这里解析成纯 URL；非法就直接抛，不让 Chromium 看到复合串。
   */
  const url = normalizeNavUrl(opts.url);
  const ua = String(opts.ua ?? '').trim();
  const acceptLanguage = String(opts.acceptLanguage ?? '').trim();
  const prevId = bySource.get(sourceId);
  const prev = prevId ? lives.get(prevId) : undefined;
  if (prev && prev.meta.phase !== 'closed' && prev.meta.phase !== 'failed') {
    if (url && url !== prev.meta.url) void navigateVerification(prev.meta.id, url);
    return prev.meta;
  }

  const id = randomUUID();
  const meta: VerifySessionMeta = {
    id,
    sourceId,
    url,
    phase: 'starting',
    startedAt: Date.now(),
    width: 960,
    height: 720,
    offscreen: false,
  };
  // 占位：让 `verificationForSource` / `getVerification` 在浏览器就绪前就有答案（接线用）
  // `#657`：带上 `id` 与 `cdpFails`，僵尸检测（noteCdpResult）才能在收摊时定位会话
  // `#710`：`ready` 门由 `resetReady` 统一建（失败重开时也要能重建）
  const shell = { id, meta, subs: new Set(), unsub: [], ready: Promise.resolve(), markReady: (): void => undefined, cdpFails: 0 } as unknown as Live;
  lives.set(id, shell);
  bySource.set(sourceId, id);

  /**
   * `#710` 启动统一走 `runBoot`：它负责「开门、失败留痕、失败收进程、可重开」。
   * 老实现把这几件事散在 `openVerification` 与 `boot` 两处 ⇒ 失败路径没人管。
   */
  resetReady(shell);
  void runBoot(shell, { sourceId, url, offscreen: opts.offscreen !== false, ua, acceptLanguage });

  return meta;
}

/** `#710` 重设 boot 完成门（重开时前端可能还挂在旧的 `ready` 上） */
function resetReady(live: Live): void {
  let markReady = (): void => undefined;
  const ready = new Promise<void>((r) => {
    markReady = r;
  });
  live.ready = ready;
  live.markReady = markReady;
}

/**
 * `#710` 跑一次 boot：调度、失败留痕、失败收尾。
 *
 * **为什么失败要收掉浏览器**：用户实测（Aff）浮层报「验证浏览器启动失败」时，桌面上还留着一个
 * 【无标题】空窗（about:blank）。那是这只**新拉起**的进程：boot 抛错后没人再管它。
 * 它既占屏幕又占 profile 单例锁（下次重开会被启动器合并后退出 ⇒ 又报「未开启调试端口」）。
 * 复用的旧浏览器（`reused=true`，可能正被反爬重放用着）不动。
 */
interface BootOpts {
  sourceId: string;
  url: string;
  offscreen: boolean;
  /** `#731` 源当前请求 UA / Accept-Language（不传 = boot 完成后反向登记浏览器 UA） */
  ua?: string;
  acceptLanguage?: string;
}

async function runBoot(live: Live, opts: BootOpts): Promise<void> {
  if (live.bootRunning) return;
  live.bootRunning = true;
  const t0 = Date.now();
  try {
    await bootInto(live, opts, t0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    live.meta.phase = 'failed';
    live.meta.error = msg;
    broadcast(live, { type: 'phase', phase: 'failed', error: msg });
    console.warn(`[verify] 验证浏览器启动失败（${Date.now() - t0}ms，源 ${opts.sourceId}）：${msg}`);
    /**
     * `#731` 失败回收条件修正：`live.session` 现在在 `acquire` 之后**立刻**赋值（attach 之前），
     * 所以 attach/导航失败也能收掉这只新进程。
     * 老实现把赋值放在 attach 之后 ⇒ attach 抛错时条件不成立 ⇒ 桌面上留下一个
     * 【无标题】的 about:blank 空窗（用户实测的那只），还占着 profile 单例锁。
     */
    if (live.session && live.bootReused !== true) {
      const key = live.session.key;
      // 有界收尾：失败路径上最多多等 killSession 的 ~10s（前端此时已经看到 failed 文案）
      await release(key, { keepProfile: true }).catch(() => undefined);
      console.warn(`[verify] 已结束本次新拉起的浏览器（避免留下空窗/占锁）：${key}`);
    }
  } finally {
    live.bootRunning = false;
    // 成功/失败都要开门：否则前端会永远等在这扇门上（表现为浮层一直转圈）
    live.markReady();
  }
}

/**
 * `#710` 失败态下重新拉起浏览器（复用**同一个会话 id**）。
 *
 * 为什么需要：浮层里的「刷新」按钮走的是 `/api/verify/:id/navigate`。失败态下 `live.cdp`
 * 是 undefined ⇒ 老实现直接 `return false` ⇒ `VERIFY_NAV_FAILED`，用户只能关掉浮层重来。
 * 这里把「刷新」升级成「重新拉起」：前端不用换 sessionId，画面继续用同一条 SSE。
 */
function rebootLive(live: Live, url: string): boolean {
  if (live.rebooting || live.bootRunning) return true; // 已经在启动/重开 ⇒ 当前端点在语义上已成功
  live.rebooting = true;
  live.meta.phase = 'starting';
  delete live.meta.error;
  if (url) live.meta.url = url;
  broadcast(live, { type: 'phase', phase: 'starting', ...(url ? { url } : {}) });
  void runBoot(live, {
    sourceId: live.meta.sourceId,
    url,
    offscreen: live.meta.offscreen,
    ...(live.ua ? { ua: live.ua } : {}),
    ...(live.acceptLanguage ? { acceptLanguage: live.acceptLanguage } : {}),
  }).finally(() => {
    live.rebooting = false;
  });
  return true;
}

/** 清掉上一轮的 CDP 句柄/定时器/订阅（重开前必须做，否则会用到僵尸连接与重复事件） */
function dropBootArtifacts(live: Live): void {
  if (live.timer) {
    clearInterval(live.timer);
    live.timer = undefined;
  }
  for (const u of live.unsub) {
    try {
      u();
    } catch {
      /* 忽略 */
    }
  }
  live.unsub = [];
  try {
    live.cdp?.close();
  } catch {
    /* 已断开 */
  }
  // 运行时各消费点都有 `if (!live.cdp)` 守卫；这里的类型断言只为表达「回到未就绪态」
  (live as unknown as { cdp?: CdpClient }).cdp = undefined;
  /**
   * `#731` **重开前把上一轮的会话引用与「是否复用」清掉**：
   * 否则 `runBoot` 的失败回收会拿旧会话去 release（旧会话可能是别人正在用的那只会话）。
   * 新值在 `acquire` 返回后立刻写回（见 `bootInto`）。
   */
  (live as unknown as { session?: BrowserSession }).session = undefined;
  live.bootReused = undefined;
  live.casting = false;
}

async function bootInto(live: Live, opts: BootOpts, t0: number): Promise<void> {
  /** `#710` 分阶段耗时留痕：下次用户贴日志时能一眼看出卡在「端口/连接/target/导航」哪一步 */
  const mark = (stage: string, extra = ''): void => {
    console.log(`[verify] boot ${stage} +${Date.now() - t0}ms${extra ? ` · ${extra}` : ''}`);
  };
  dropBootArtifacts(live);
  const exe = findFullChromium();
  if (!exe) throw new Error('未找到可用的完整浏览器（Chrome/Chromium/Edge）；可设 YUEDU_CHROMIUM_PATH_FULL 指定');

  // 与登录窗/反爬重放**同一只**浏览器（同 profile、同 cookie ⇒ 过一次验证，重放就能用）
  /**
   * ★ 这里**不传 `url`**（`#710`）：`finishAcquire` 会先开一条 CDP、建 target、导航，
   * 紧接着下面的 `attachPageSession` 又开一条 CDP 再认领 —— 冷启动时每一步都可能超时。
   * 页面统一由下面的 `Target.createTarget` 打开（本文件头 a 条：命令行 URL 不可靠），
   * 少一次连接/导航就少一处失败面。
   */
  const acqOpts = {
    exe,
    headless: false,
    pinned: true,
    /**
     * `#482` 窗口**生在屏幕外**（用户口径：不要弹独立 Chrome）。
     * ⚠️ 只在**新建进程**时生效（复用已有浏览器不会重开）⇒ CDP 兜底见 `moveWindowOffscreen`。
     *
     * `#488` `bringToFront:false`：不抢前台（抢了会让屏幕外的窗口闪出来）；
     * 用户要看画面时看 screencast 帧，不是看这只窗口。
     */
    ...(opts.offscreen ? { extraArgs: ['--window-position=-3200,-2400'] } : {}),
    bringToFront: false,
    /** `#710` 有头验证窗多给启动预算（软 15s / 硬 45s），慢机器上别把「慢」判成「死」 */
    startTimeoutMs: 15_000,
  };
  let { session, reused } = await acquire(sessionKeyOf(opts.sourceId), acqOpts);
  /**
   * `#731` **acquire 返回就立刻登记会话**（attach 之前）。
   * attach / 导航失败时 `runBoot` 才收得掉这只新进程 —— 否则桌面上留下【无标题】空窗，
   * 还占着 profile 单例锁（用户实测的那只就是它）。
   */
  live.session = session;
  live.bootReused = reused;
  live.ua = opts.ua;
  live.acceptLanguage = opts.acceptLanguage;
  mark('acquire', `reused=${reused} port=${session.port} ua=${opts.ua ? opts.ua.slice(0, 48) : '(未声明)'}`);
  session.url = opts.url;

  /**
   * `#731` **注入 UA 时要先开空白页再导航**：`Target.createTarget` 带的 URL 会立刻发出请求，
   * 那时 `Emulation.setUserAgentOverride` 还没生效 ⇒ 首个请求仍是默认 UA，等于没对齐。
   */
  const needUaInject = !!opts.ua;
  const attachT0 = Date.now();
  let att = await attachPageSession(session, { createUrl: needUaInject ? 'about:blank' : opts.url });
  const attachMs = Date.now() - attachT0;
  /**
   * `#731` **复用实例 attach 过慢 ⇒ 重建会话**（用户 3000 日志：`reused=true`、`created=false`、
   * attach 10.5s、随后 `Emulation.setUserAgentOverride` 超时 ⇒ 该实例已半死）。
   * 判据只用「同一次 CDP 调用的实测耗时」，不用进程存活/固定延时（`#665`/`#666` 的纪律）。
   */
  if (reused && attachMs > ATTACH_SLOW_MS) {
    console.warn(`[verify] 复用实例 attach 过慢（${attachMs}ms > ${ATTACH_SLOW_MS}ms）⇒ 重建会话`);
    try {
      att.cdp.close();
    } catch {
      /* 已断开 */
    }
    await release(session.key).catch(() => undefined);
    const fresh = await acquire(sessionKeyOf(opts.sourceId), acqOpts);
    session = fresh.session;
    reused = fresh.reused;
    live.session = session;
    live.bootReused = reused;
    mark('rebuild', `attach=${attachMs}ms port=${session.port}`);
    att = await attachPageSession(session, { createUrl: needUaInject ? 'about:blank' : opts.url });
  }
  const { cdp, sessionId: cdpSession, targetId, created } = att;
  live.cdp = cdp;
  live.cdpSession = cdpSession;
  live.targetId = targetId;
  live.casting = false;
  mark('attach', `target=${targetId.slice(0, 8)} created=${created}`);
  await logTargets(live, 'attach');

  if (needUaInject) {
    /**
     * `#731` 验证会话与引擎请求**同源指纹**（断点 2）：
     * UA 对齐到该源当前请求的那一条，`Accept-Language` 一并带上（CF/WAF 的 clearance 与它们绑定）。
     *
     * ★ **失败不能静默继续**（用户 3000 日志：`Emulation.setUserAgentOverride 超时` 之后
     *   仍然打印「已对齐」⇒ 指纹其实没对上，收割回来的 clearance 必然无效）。
     * 重试一次；两次都失败就抛明确错误，让 runBoot 收口，而不是带着不同指纹去撞 WAF。
     */
    let uaOk = false;
    let uaErr = '';
    for (let i = 0; i < 2 && !uaOk; i += 1) {
      try {
        await cdp.send(
          'Emulation.setUserAgentOverride',
          { userAgent: opts.ua, ...(opts.acceptLanguage ? { acceptLanguage: opts.acceptLanguage } : {}) },
          cdpSession,
        );
        uaOk = true;
      } catch (e) {
        uaErr = e instanceof Error ? e.message : String(e);
        console.warn(`[verify] 注入 UA 失败（第 ${i + 1}/2 次）：${uaErr}`);
      }
    }
    if (!uaOk) throw new Error(`无法对齐验证会话 UA：${uaErr || 'setUserAgentOverride 失败'}`);
    if (opts.acceptLanguage) {
      await cdp
        .send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': opts.acceptLanguage } }, cdpSession)
        .catch(() => undefined);
    }
    console.log(`[verify] 浏览器 UA 已对齐引擎 UA：${String(opts.ua).slice(0, 70)}`);
  }

  if (!created || needUaInject) {
    /**
     * `#731` **导航失败必须留痕**：`Page.navigate` 的 `errorText`（如 `net::ERR_CERT_*`）
     * 是「窗口起来了但没加载站点」的唯一直接证据，旧实现 `.catch(() => undefined)` 全吞。
     */
    const nav = await cdp
      .send<{ frameId?: string; errorText?: string }>('Page.navigate', { url: opts.url }, cdpSession)
      .catch((e: unknown) => ({ errorText: e instanceof Error ? e.message : String(e) }));
    if (nav?.errorText) console.warn(`[verify] Page.navigate 返回错误：${nav.errorText} · ${opts.url.slice(0, 100)}`);
    mark('navigate', nav?.errorText ? `error=${nav.errorText}` : 'ok');
  }
  await cdp.send('Page.enable', {}, cdpSession).catch(() => undefined);
  await cdp.send('Runtime.enable', {}, cdpSession).catch(() => undefined);

  if (opts.offscreen) {
    const moved = await moveWindowOffscreen(session);
    /**
     * 判据：CDP 移成功 ⇒ true；CDP 没成功但**本次是新建进程** ⇒ 启动参数已把窗口生在屏幕外，
     * 同样算 true。只有「复用已有浏览器 + CDP 也失败」才是真的会弹窗（记为 false）。
     */
    live.meta.offscreen = moved || !reused;
  }
  // 拉起时自带的 about:blank 收掉（但恒留 ≥1 标签页，见 `#483`）
  await closeBlankTabs(session).catch(() => undefined);

  /**
   * `#731` **等页面真的到了再算 ready**（旧实现直接 `mark('ready')`）：
   * 慢机器上这时可能还在 about:blank/加载中 ⇒ 窗口「无标题」、探针把空文档当挑战页。
   * 有界 15s；到点仍未就绪 ⇒ 抛明确错误（带最终 url/readyState/标题），由 runBoot 收口。
   */
  const st = await waitDocReady(live, 15_000);
  console.log(`[verify] 页面就绪：url=${st.url.slice(0, 100)} · readyState=${st.readyState} · 标题=${st.title || '(空)'}`);
  if (st.url && st.url !== live.meta.url && /^https?:/i.test(st.url)) live.meta.url = st.url;
  await logTargets(live, 'ready');
  mark('ready');

  /**
   * `#731` **源未声明 UA ⇒ 反向对齐**：把验证会话实际用的 UA 登记回引擎（`#658` 的同一语义），
   * 让后续引擎请求跟着这只浏览器走，而不是两边各用一套指纹。
   */
  if (!opts.ua) {
    const ua = await readSessionUa(live);
    if (ua && uaSink) {
      uaSink(opts.sourceId, ua);
      console.log(`[verify] 源未声明 UA ⇒ 已让引擎跟随浏览器 UA：${ua.slice(0, 70)}`);
    }
  }

  live.unsub.push(
    cdp.subscribe('Page.screencastFrame', (params, sid) => {
      const p = params as { data?: string; sessionId?: string; metadata?: { deviceWidth?: number; deviceHeight?: number } };
      if (sid && sid !== cdpSession) return;
      const data = String(p.data ?? '');
      if (!data) return;
      live.meta.width = Number(p.metadata?.deviceWidth ?? live.meta.width) || live.meta.width;
      live.meta.height = Number(p.metadata?.deviceHeight ?? live.meta.height) || live.meta.height;
      live.meta.lastFrameAt = Date.now();
      // ★ 必须 ack，否则 Chrome 认为上一帧还没被消费，**后续帧全部停发**
      void cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId ?? sid ?? '' }, cdpSession).catch(() => undefined);
      broadcast(live, { type: 'frame', data: `data:image/jpeg;base64,${data}`, w: live.meta.width, h: live.meta.height });
    }),
  );

  startProbe(live);
  if (live.subs.size) await setCasting(live, true);
}

export function getVerification(id: string): VerifySessionMeta | null {
  return lives.get(id)?.meta ?? null;
}

/** 该源当前有没有在跑的验证会话（`/api/run` 带 `needVerification` 用） */
export function verificationForSource(sourceId: string): VerifySessionMeta | null {
  const id = bySource.get(String(sourceId ?? '').trim());
  if (!id) return null;
  const l = lives.get(id);
  if (!l) return null;
  if (l.meta.phase === 'closed' || l.meta.phase === 'failed') return null;
  return l.meta;
}

/** 订阅该会话的事件流；返回的退订函数会在无人订阅时自动停掉 screencast */
export function subscribeVerification(id: string, cb: (e: VerifyEvent) => void): () => void {
  const live = lives.get(id);
  if (!live) return () => undefined;
  live.subs.add(cb);
  void setCasting(live, true);
  return () => {
    live.subs.delete(cb);
    if (live.subs.size === 0) void setCasting(live, false);
  };
}

/** 导航到另一个 URL（同一源切分类/点卡片时复用同一只浏览器，不重开） */
export async function navigateVerification(id: string, url: string): Promise<boolean> {
  const live = lives.get(id);
  if (!live) return false;
  /**
   * `#731` 同样走唯一清洗入口：前端/调用方传复合键时解析成纯 URL；
   * 非法 URL 直接判失败（返回 false ⇒ 浮层 `VERIFY_NAV_FAILED`），不下发给 CDP。
   */
  let u: string;
  try {
    u = normalizeNavUrl(url);
  } catch (e) {
    console.warn(`[verify] 忽略非法导航 URL：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  /**
   * `#488` **等 boot 完成**：用户常常在浏览器还没拉起（3~8s）时就点了「刷新」，
   * 老实现在 `live.cdp` 还是 undefined 时直接 return false ⇒ 浮层报 `VERIFY_NAV_FAILED`
   * 且画面永远空白。boot 失败时这扇门也会开（`markReady` 在 finally）⇒ 不会永久挂住。
   *
   * `#710` 两处收紧：
   *  ① 等待有界 3s —— 启动预算已放宽到软 15s/硬 45s，不能让一个 HTTP 请求挂那么久；
   *  ② **失败态下的「刷新」= 重新拉起浏览器**（同一个 sessionId，前端无需换浮层）。
   */
  if (live.bootRunning) {
    await Promise.race([live.ready.catch(() => undefined), sleep(3000)]);
  }
  if (live.meta.phase === 'failed' || !live.cdp) {
    console.warn(
      `[verify] 会话不可用（phase=${live.meta.phase}${live.meta.error ? ` · ${live.meta.error}` : ''}）⇒ 「刷新」改为重新拉起浏览器`,
    );
    return rebootLive(live, u);
  }
  live.meta.url = u;
  live.meta.phase = 'starting';
  delete live.meta.clearedAt;
  broadcast(live, { type: 'phase', phase: 'starting', url: u });
  try {
    await live.cdp.send('Page.navigate', { url: u }, live.cdpSession);
    noteCdpResult(live, true);
    startProbe(live);
    return true;
  } catch (e) {
    console.warn(`[verify] 导航失败（${u.slice(0, 80)}）：${e instanceof Error ? e.message : String(e)}`);
    noteCdpResult(live, false);
    return false;
  }
}

export interface VerifyInput {
  type: 'click' | 'move' | 'wheel' | 'text' | 'key';
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  code?: string;
  deltaY?: number;
}

/** 前端输入回灌（坐标为**页面 CSS 像素**，与 screencast 的 deviceWidth/Height 同坐标系） */
export async function verificationInput(id: string, ev: VerifyInput): Promise<boolean> {
  const live = lives.get(id);
  if (!live) return false;
  /**
   * `#488` 同 `navigateVerification`：boot 未完成时等待，别让早期点击静默失败。
   * `#710` 但等待必须有界：启动预算已到软 15s/硬 45s，不能让一次点击的 HTTP 请求挂几十秒
   * （前端本来就只在画面上有帧时才点得到；没帧时它显示的是阶段文案）。
   */
  if (live.bootRunning) {
    await Promise.race([live.ready.catch(() => undefined), sleep(3000)]);
  }
  if (!live.cdp) return false;
  const x = Number(ev.x ?? 0);
  const y = Number(ev.y ?? 0);
  /**
   * `#663` **输入回灌必须短超时**（`CdpClient.send` 默认 10s）。
   *
   * 用户实测 Aff：在验证浮层里滚动，日志刷了一屏
   * `[verify] 输入回灌失败（wheel）：CDP Input.dispatchMouseEvent 超时`，
   * 每条都是 **10 秒**——页面在导航/重绘时输入命令本来就可能迟迟不回，
   * 而前端每个滚轮事件都挂 10 秒，浮层整个卡住（用户原话「卡住了」）。
   *
   * 语义：`move`/`wheel` 是**尽力而为**（丢了无所谓，下一次还有），给 1200ms；
   * `click`/`text`/`key` 影响正确性，给 4000ms。超时只是**不再等**，
   * 底层 promise 由 CDP 自己的 10s 兜底（不会泄漏连接）。
   */
  const quickSend = (method: string, params: Record<string, unknown>, ms: number): Promise<unknown> =>
    Promise.race([
      live.cdp.send(method, params, live.cdpSession),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`输入超时（${ms}ms）`)), ms)),
    ]);
  const bestEffort = ev.type === 'move' || ev.type === 'wheel';
  const send = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    quickSend(method, params, bestEffort ? 1200 : 4000);
  try {
    switch (ev.type) {
      case 'move':
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        return true;
      case 'click':
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        return true;
      case 'wheel':
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Number(ev.deltaY ?? 0) });
        return true;
      case 'text':
        await send('Input.insertText', { text: String(ev.text ?? '') });
        return true;
      case 'key': {
        const key = String(ev.key ?? 'Enter');
        const code = String(ev.code ?? (key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`));
        const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : key === 'Enter' ? 13 : 0;
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        return true;
      }
      default:
        return false;
    }
  } catch (e) {
    /**
     * `#663` **降噪**：`move`/`wheel` 在导航期间高频失败是常态，刷屏会淹掉真问题（用户日志里
     * 一屏都是它）。这里只让「影响正确性」的类型留痕。
     */
    if (!bestEffort) {
      console.warn(`[verify] 输入回灌失败（${ev.type}）：${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }
}

/** 收尾：停帧、关 tab（**保留浏览器进程与 profile** —— 后续反爬重放还要用同一只） */
export async function closeVerification(id: string): Promise<boolean> {
  const live = lives.get(id);
  if (!live) return false;
  if (live.timer) clearInterval(live.timer);
  for (const u of live.unsub) {
    try {
      u();
    } catch {
      /* 忽略 */
    }
  }
  live.unsub = [];
  try {
    if (live.casting) await live.cdp.send('Page.stopScreencast', {}, live.cdpSession).catch(() => undefined);
  } catch {
    /* 忽略 */
  }
  /**
   * ★★ 恒留 ≥1 标签页（`#483`）：最后一个标签页一关，Chromium 会**整只退出**
   * ⇒ 下一次重放/验证又要重新拉起（用户看到的「弹一下又关」）。
   */
  try {
    const s = await getSession(sessionKeyOf(live.meta.sourceId));
    if (s) {
      const r = await live.cdp.send<{ targetInfos?: Array<{ targetId: string; type: string }> }>('Target.getTargets');
      const pages = (r.targetInfos ?? []).filter((t) => t.type === 'page');
      if (pages.length > 1) {
        await live.cdp.send('Target.closeTarget', { targetId: live.targetId }).catch(() => undefined);
        if (s.pageTargetId === live.targetId) delete s.pageTargetId;
      }
    }
  } catch {
    /* 关不掉无所谓 */
  }
  try {
    live.cdp.close();
  } catch {
    /* 忽略 */
  }
  /**
   * `#489` **收尾把窗口最小化**：验证完成后窗口仍留着（进程与 profile 要给后续反爬重放用，
   * 见 `#483`），但用户真机复测发现「过了验证窗口也不关、一直存在」⇒ 这里补一道保险：
   * 即便 `--window-position` / `moveWindowOffscreen` 都没生效（典型：复用旧进程且 CDP
   * 拿不到 windowId），最小化也能让它不再占屏幕。用户要看的画面在 screencast 浮层里。
   */
  try {
    const s = await getSession(sessionKeyOf(live.meta.sourceId));
    if (s) await minimizeWindow(s);
  } catch {
    /* 最小化失败不影响收尾 */
  }
  live.meta.phase = 'closed';
  broadcast(live, { type: 'closed' });
  live.subs.clear();
  lives.delete(id);
  if (bySource.get(live.meta.sourceId) === id) bySource.delete(live.meta.sourceId);
  return true;
}

/** 进程退出 / 源删除时的兜底清理（不等待） */
export function closeAllVerifications(): void {
  for (const id of [...lives.keys()]) void closeVerification(id);
}

/** 会话是否还活着（浏览器已崩/被接管时用来判断要不要重开） */
export async function verificationAlive(id: string): Promise<boolean> {
  const live = lives.get(id);
  if (!live || !live.cdp) return false;
  const s = await getSession(sessionKeyOf(live.meta.sourceId));
  return !!s;
}

export const __test = { lives, bySource, CHALLENGE_RE, sleep };
