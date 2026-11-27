/**
 * `#727` **`java.getVerificationCode(imageUrl)` 的服务端半边（人工输入 + Cookie 回收）**
 *
 * ## 语义（对齐 Legado `JsExtensions.kt:442-449`）
 * 上游是「App 弹 WebView 加载验证码图片，用户看图后输入，**同步返回**这个字符串」。本仓是
 * JS 求值 + worker 架构，所以做成**有界等待的同步语义**：
 *   worker 里 `java.getVerificationCode(url)` → 同步 RPC（`Atomics.wait` 阻塞 worker 线程）
 *   → 本模块拉起/复用**该源的常驻 Chromium** → 桌面端内置窗口显示画面 → 用户提交
 *   → 回收浏览器 Cookie（与登录流程同一条落点）→ 把 code 回给 worker。
 * 宿主等待期间暂停 worker 的 JS 预算（见 `runChunk` 的 `beginHostWork/endHostWork`）。
 *
 * ## 三条不能违反的边界
 *   ① **有界**：默认 60s（`YUEDU_VERIFY_CODE_TIMEOUT_MS` 覆盖），超时 reject「验证码超时」；
 *   ② **可取消**：用户关窗 / 点取消 ⇒ reject「验证码输入已取消」；
 *   ③ **绝不返回空串**：空验证码会让登录脚本提交上去，表现成「密码错」。
 *
 * ## 与登录验证窗（`#710`）的关系（为什么不直接复用一个窗口）
 * 两者**共用同一只 Chromium 会话**（同一 profile、同一份 Cookie），但**不共用标签页**：
 *   · 登录窗/验证浮层用的是 `session.pageTargetId`；
 *   · 这里用 `openAuxTab` **另开一个 tab**（`Target.createTarget`），绝不导航用户正在操作的页面。
 *   同一源串行（`serialize`）⇒ 不会同时出现两个验证码请求抢同一个 tab；
 *   不同源各自 profile + 自己的 tab ⇒ 并发互不串号。
 *   桌面端窗口也是独立的 `BrowserWindow`（见 `apps/desktop/main.js` 的轮询），不碰登录窗。
 */
import { randomUUID } from 'node:crypto';
import { findFullChromium, harvestHosts } from '@yuedu/core';
import {
  acquire,
  openAuxTab,
  sessionKeyOf,
  type BrowserSession,
  type CdpClient,
} from './browser-session';
import { harvestLoginCookies } from './browser-login';

export type VerifyCodeState = 'waiting' | 'submitted' | 'cancelled' | 'timeout' | 'failed';

/**
 * `#740` 谁打开了输入界面（认领语义：先认领者独占，另一端不再弹窗）。
 * `desktop` = 桌面端主进程开的独立 `BrowserWindow`；`web` = 纯 Web 端的浮层。
 */
export type VerifyCodeConsumer = 'web' | 'desktop';

export interface VerifyCodeMeta {
  id: string;
  sourceId: string;
  imageUrl: string;
  createdAt: number;
  expiresAt: number;
  state: VerifyCodeState;
  error?: string;
  /** `#740` 已认领的一方（缺省 = 尚未认领，两端都可尝试） */
  claimedBy?: VerifyCodeConsumer;
  /** `#740` 认领时间（诊断用） */
  claimedAt?: number;
}

/** 桌面端内置窗口要显示的画面（截图 data URL） */
export interface CodeTab {
  capture(): Promise<{ frame: string; width: number; height: number }>;
  /** 页面 UA（与 Cookie 一起收割：`cf_clearance` 这类凭据与 UA 绑定） */
  ua(): Promise<string>;
  reload(url: string): Promise<void>;
  close(): Promise<void>;
}

type Deps = {
  startTab: (sourceId: string, url: string) => Promise<CodeTab>;
  harvest: (sourceId: string, urls: string[]) => Promise<Record<string, string>>;
  timeoutMs: number;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 默认 60s；测试/现场可用环境变量调整 */
function envTimeoutMs(): number {
  const raw = Number(process.env.YUEDU_VERIFY_CODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** 把浏览器里的 Cookie 收回该源 CookieStore（index.ts 注册；与 `setVerifyCookieSink` 同一落点） */
let codeSink: ((sourceId: string, map: Record<string, string>, ua?: string) => void) | null = null;
export function setVerificationCodeSink(
  fn: (sourceId: string, map: Record<string, string>, ua?: string) => void,
): void {
  codeSink = fn;
}

interface Entry {
  meta: VerifyCodeMeta;
  /** 收割 Cookie 的域候选（源站 + 验证码地址；空数组 = 该源 profile 里的全部 Cookie） */
  hosts: string[];
  tab?: CodeTab;
  start: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  resolveCode: (code: string) => void;
  rejectCode: (e: Error) => void;
  settled: boolean;
  submitting?: boolean;
  frame?: string;
  frameAt?: number;
}

const entries = new Map<string, Entry>();
/** sourceId → 当前等待中的请求 id（同源串行） */
const bySource = new Map<string, string>();
/** 同源串行链：前一个请求结束（成功/取消/超时）后，才允许下一个开始 */
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 尾链只用于串行化：失败不许把后续调用带崩
  chains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/** 当前等待用户输入的请求（桌面端/网页端轮询这个列表） */
export function pendingVerificationCodes(consumer?: VerifyCodeConsumer): VerifyCodeMeta[] {
  /**
   * `#740` 认领过滤：被**另一端**认领的请求不再下发（避免桌面端与网页端双开窗口）。
   * 不传 `consumer` 时按 `desktop` 处理 ⇒ **老桌面端（无 consumer 参数）行为不变**。
   */
  const who = normalizeVerifyCodeConsumer(consumer);
  return [...entries.values()]
    .filter((e) => e.meta.state === 'waiting' && (!e.meta.claimedBy || e.meta.claimedBy === who))
    .map((e) => ({ ...e.meta }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 把外部传入的 consumer 归一：只认 `web`，其余（含缺省/脏值）都按 `desktop`（向后兼容） */
export function normalizeVerifyCodeConsumer(v: unknown): VerifyCodeConsumer {
  return String(v ?? '').trim().toLowerCase() === 'web' ? 'web' : 'desktop';
}

export interface VerifyCodeClaimResult {
  ok: boolean;
  claimedBy?: VerifyCodeConsumer;
  error?: 'NOT_PENDING' | 'CLAIMED';
  message?: string;
}

/**
 * `#740` 认领请求：**先认领者独占**。
 *
 * 语义：
 *  · 未认领 ⇒ 认领成功（记 `claimedBy`/`claimedAt`）；
 *  · 同一端重复认领 ⇒ 幂等成功（网页刷新后可以接着显示同一张验证码）；
 *  · 已被另一端认领 ⇒ `CLAIMED`（调用方据此**不再弹窗**）；
 *  · 请求已结束（提交/取消/超时，entry 已删除）⇒ `NOT_PENDING`。
 *
 * 释放不单开接口：entry 在提交/取消/超时/失败时删除，认领信息随之消失（60s 内有界）。
 */
export function claimVerificationCode(id: string, consumer?: VerifyCodeConsumer): VerifyCodeClaimResult {
  const who = normalizeVerifyCodeConsumer(consumer);
  const e = entries.get(String(id ?? '').trim());
  if (!e || e.meta.state !== 'waiting') {
    return { ok: false, error: 'NOT_PENDING', message: '验证码请求已结束' };
  }
  const cur = e.meta.claimedBy;
  if (cur && cur !== who) {
    return {
      ok: false,
      error: 'CLAIMED',
      claimedBy: cur,
      message: cur === 'desktop' ? '桌面端已打开该验证码窗口' : '网页端已打开该验证码浮层',
    };
  }
  e.meta.claimedBy = who;
  e.meta.claimedAt = Date.now();
  return { ok: true, claimedBy: who };
}

export function getVerificationCodeMeta(id: string): VerifyCodeMeta | null {
  const e = entries.get(String(id ?? '').trim());
  return e ? { ...e.meta } : null;
}

/**
 * 发起一次「等用户输入验证码」。
 *
 * 返回的 Promise 有界：超时 / 取消 / 浏览器不可用都会 reject；成功时 resolve 用户输入的字符串。
 * 同源请求串行（第二个请求会排队到第一个结束），不同源并发互不影响。
 */
export function requestVerificationCode(
  sourceId: string,
  imageUrl: string,
  opts: { timeoutMs?: number; hosts?: string[] } = {},
): Promise<string> {
  const sid = String(sourceId ?? '').trim();
  const url = String(imageUrl ?? '').trim();
  if (!sid) return Promise.reject(new Error('java.getVerificationCode 缺少源 id'));
  if (!/^https?:\/\//i.test(url)) {
    return Promise.reject(new Error('java.getVerificationCode 需要一个 http/https 的验证码地址'));
  }
  /**
   * 收割域候选：调用方（index.ts）给「源站 + 验证码地址」。只给验证码地址是不够的 ——
   * 有些站点的验证码图挂在 CDN/第三方域，按它筛会把源站本次新种的 Cookie 一起丢掉。
   * 没给就退回「只看验证码地址」。
   */
  const hosts = (opts.hosts ?? harvestHosts([url])).map((h) => String(h ?? '').trim()).filter(Boolean);
  /**
   * 超时来源：显式 `opts.timeoutMs` > 测试注入的 `deps.timeoutMs` > 环境变量/默认 60s。
   * （`deps.timeoutMs` 是 `__setVerifyCodeDeps({timeoutMs})` 的注入点，超时用例靠它。）
   */
  return serialize(sid, () => startRequest(sid, url, opts.timeoutMs ?? deps.timeoutMs, hosts));
}

function startRequest(sourceId: string, imageUrl: string, timeoutMs: number, hosts: string[]): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const meta: VerifyCodeMeta = {
    id,
    sourceId,
    imageUrl,
    createdAt: now,
    expiresAt: now + timeoutMs,
    state: 'waiting',
  };
  let resolveCode!: (code: string) => void;
  let rejectCode!: (e: Error) => void;
  const done = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const entry: Entry = { meta, hosts, start: Promise.resolve(), resolveCode, rejectCode, settled: false };
  entries.set(id, entry);
  bySource.set(sourceId, id);
  const secs = Math.max(1, Math.round(timeoutMs / 1000));
  entry.timer = setTimeout(() => {
    settleError(entry, 'timeout', `java.getVerificationCode 验证码超时（${secs}s 未收到输入）`);
  }, timeoutMs);
  entry.timer.unref?.();
  entry.start = openTab(entry);
  void entry.start.catch(() => undefined);
  return done;
}

async function openTab(entry: Entry): Promise<void> {
  try {
    const tab = await deps.startTab(entry.meta.sourceId, entry.meta.imageUrl);
    /**
     * 超时/取消可能发生在「浏览器还在起」的 15s 里：此时 entry 已被 cleanup 摘掉，
     * 若直接把 tab 挂上去就再也没人关它（孤儿标签页留在常驻会话里）。所以这里补一次关闭。
     */
    if (entry.settled) {
      await tab.close().catch(() => undefined);
      return;
    }
    entry.tab = tab;
  } catch (e) {
    settleError(entry, 'failed', `java.getVerificationCode 无法打开验证码窗口：${msg(e)}`);
  }
}

function settleOk(entry: Entry, code: string): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.meta.state = 'submitted';
  if (entry.timer) clearTimeout(entry.timer);
  entry.resolveCode(code);
  void cleanup(entry);
}

function settleError(entry: Entry, state: Exclude<VerifyCodeState, 'submitted'>, message: string): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.meta.state = state;
  entry.meta.error = message;
  if (entry.timer) clearTimeout(entry.timer);
  entry.rejectCode(new Error(message));
  void cleanup(entry);
}

async function cleanup(entry: Entry): Promise<void> {
  /**
   * 关 tab 必须有界：浏览器可能已经卡死（CDP 10s 默认超时）。收尾失败没关系，
   * 会话本身是 pinned 的，下一次请求会复用/重新拉起。
   */
  if (entry.tab) {
    await Promise.race([entry.tab.close().catch(() => undefined), sleep(3000)]);
  }
  entries.delete(entry.meta.id);
  if (bySource.get(entry.meta.sourceId) === entry.meta.id) bySource.delete(entry.meta.sourceId);
}

/** 抓一帧给桌面端窗口显示（1.2s 内复用缓存，避免每次轮询都打一次 CDP） */
export async function captureVerificationCodeFrame(
  id: string,
): Promise<{ ok: boolean; frame?: string; error?: string }> {
  const e = entries.get(String(id ?? '').trim());
  if (!e || e.meta.state !== 'waiting') return { ok: false, error: 'NOT_PENDING' };
  if (!e.tab) return { ok: false, error: 'STARTING' };
  const now = Date.now();
  if (e.frame && now - (e.frameAt ?? 0) < 1200) return { ok: true, frame: e.frame };
  try {
    const f = await Promise.race([
      e.tab.capture(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('截屏超时')), 6000)),
    ]);
    if (!f.frame) return { ok: false, error: 'EMPTY_FRAME' };
    e.frame = f.frame;
    e.frameAt = now;
    return { ok: true, frame: f.frame };
  } catch (err) {
    return { ok: false, error: msg(err) };
  }
}

/**
 * 用户提交验证码。
 *
 * 顺序很重要：**先收割 Cookie，再 resolve**。脚本拿到 code 后会立刻发下一个请求
 * （多半就是「带验证码登录/查询」），此时 Cookie 必须已经在源 CookieStore 里。
 * 收割失败不吞掉用户输入 —— code 照样返回（下一次请求会自然补上）。
 */
export async function submitVerificationCode(
  id: string,
  code: string,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const e = entries.get(String(id ?? '').trim());
  if (!e || e.meta.state !== 'waiting') return { ok: false, error: 'NOT_PENDING', message: '验证码请求已结束' };
  const c = String(code ?? '').trim();
  if (!c) return { ok: false, error: 'EMPTY_CODE', message: '验证码不能为空' };
  if (e.submitting) return { ok: false, error: 'BUSY', message: '正在提交，请稍候' };
  e.submitting = true;
  try {
    await Promise.race([e.start.catch(() => undefined), sleep(5000)]);
    let map: Record<string, string> = {};
    try {
      map = await Promise.race([
        deps.harvest(e.meta.sourceId, e.hosts),
        sleep(8000).then(() => ({}) as Record<string, string>),
      ]);
    } catch (err) {
      console.warn(`[verify-code] 收割 Cookie 失败（不影响返回验证码）：${msg(err)}`);
    }
    let ua = '';
    try {
      if (e.tab) ua = await Promise.race([e.tab.ua(), sleep(3000).then(() => '')]);
    } catch {
      /* UA 取不到就留空（宁可不改，也不要写假 UA） */
    }
    if ((map && Object.keys(map).length) || ua) {
      try {
        codeSink?.(e.meta.sourceId, map ?? {}, ua);
      } catch {
        /* sink 失败不影响脚本 */
      }
    }
    settleOk(e, c);
    return { ok: true };
  } finally {
    e.submitting = false;
  }
}

/** 用户取消（桌面端关窗 / 窗口里点「取消」） */
export function cancelVerificationCode(id: string, reason = '用户关闭了验证码窗口'): boolean {
  const e = entries.get(String(id ?? '').trim());
  if (!e) return false;
  if (e.meta.state === 'waiting') {
    settleError(e, 'cancelled', `java.getVerificationCode 验证码输入已取消（${reason}）`);
  }
  return true;
}

/** 「换一张」：重新加载验证码地址（某些站点的图片是一次性的） */
export async function refreshVerificationCode(id: string): Promise<boolean> {
  const e = entries.get(String(id ?? '').trim());
  if (!e || e.meta.state !== 'waiting' || !e.tab) return false;
  e.frame = undefined;
  e.frameAt = 0;
  try {
    await e.tab.reload(e.meta.imageUrl);
    return true;
  } catch {
    return false;
  }
}

/* =========================================================================
 * 默认实现：复用该源常驻 Chromium + 另开一个 tab（不动登录窗/验证浮层的页）
 * ========================================================================= */

async function defaultStartTab(sourceId: string, url: string): Promise<CodeTab> {
  const exe = findFullChromium();
  if (!exe) throw new Error('未找到可用的完整浏览器（Chrome/Chromium/Edge）；可设 YUEDU_CHROMIUM_PATH_FULL 指定');
  const { session } = await acquire(sessionKeyOf(sourceId), {
    exe,
    /**
     * 有头（保住指纹/Cookie 语义），但**生在屏幕外** —— 用户看的是桌面端内置窗口里的截图，
     * 不是这只 Chromium 窗口（与验证浮层 `#482` 同一条约定）。
     */
    headless: false,
    pinned: true,
    extraArgs: ['--window-position=-3200,-2400'],
    bringToFront: false,
    startTimeoutMs: 15_000,
  });
  const tab = await openAuxTab(session, url);
  await tab.cdp.send('Page.enable', {}, tab.sessionId).catch(() => undefined);
  await tab.cdp.send('Runtime.enable', {}, tab.sessionId).catch(() => undefined);
  await waitFirstPaint(tab.cdp, tab.sessionId, 2500);
  return makeTab(session, tab.cdp, tab.sessionId, tab.targetId);
}

/** 等一次 `Page.loadEventFired`，最多等 `ms`（超时也返回，让用户看到当前画面） */
async function waitFirstPaint(cdp: CdpClient, sessionId: string, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        unsub();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    let unsub = (): void => undefined;
    try {
      unsub = cdp.subscribe('Page.loadEventFired', (_p, sid) => {
        if (!sid || sid === sessionId) finish();
      });
    } catch {
      finish();
    }
  });
}

function makeTab(
  session: BrowserSession,
  cdp: CdpClient,
  sessionId: string,
  targetId: string,
): CodeTab {
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    cdp.send<T>(method, params, sessionId);
  return {
    async capture() {
      const r = await send<{ data?: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
      return {
        frame: r.data ? `data:image/jpeg;base64,${r.data}` : '',
        width: 0,
        height: 0,
      };
    },
    async ua() {
      const r = await send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: 'navigator.userAgent',
        returnByValue: true,
      });
      return typeof r.result?.value === 'string' ? r.result.value.trim() : '';
    },
    async reload(url: string) {
      await send('Page.navigate', { url });
    },
    async close() {
      // 关本 tab；恒留 ≥1 标签页（最后一个一关 Chromium 会整只退出，见 `#483`）
      try {
        const r = await cdp.send<{ targetInfos?: Array<{ targetId: string; type: string }> }>('Target.getTargets');
        const pages = (r.targetInfos ?? []).filter((t) => t.type === 'page');
        if (pages.length > 1) await cdp.send('Target.closeTarget', { targetId });
        if (session.pageTargetId === targetId) delete session.pageTargetId;
      } catch {
        /* 关不掉无所谓 */
      }
      try {
        cdp.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 默认的 Cookie 收割：复用登录流程那一套（过滤/同名去重都在 core 里） */
async function defaultHarvest(sourceId: string, urls: string[]): Promise<Record<string, string>> {
  const h = await harvestLoginCookies(sourceId, urls, {});
  if (!h.ok) throw new Error(h.error);
  const map: Record<string, string> = {};
  for (const c of h.cookies) map[c.name] = c.value;
  return map;
}

let deps: Deps = {
  startTab: defaultStartTab,
  harvest: defaultHarvest,
  timeoutMs: envTimeoutMs(),
};

/**
 * 单测注入点（同 `verification.ts` 的 `__test` 口径：只给测试用，不改生产默认值）。
 * 传 `timeoutMs` 会改变默认超时（用于「超时」用例）。
 */
export function __setVerifyCodeDeps(patch: Partial<Deps>): void {
  deps = { ...deps, ...patch };
}
export function __resetVerifyCodeDeps(): void {
  deps = { startTab: defaultStartTab, harvest: defaultHarvest, timeoutMs: envTimeoutMs() };
}

/* =========================================================================
 * 桌面端内置窗口的 HTML（服务端直出，无需前端构建产物）
 * ========================================================================= */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 给 Electron `BrowserWindow` 加载的输入页：画面 + 输入框 + 提交/取消/换一张 */
export function renderVerificationCodePage(meta: VerifyCodeMeta): string {
  const sid = esc(meta.sourceId);
  const idJson = JSON.stringify(meta.id);
  const expiresIn = Math.max(0, Math.round((meta.expiresAt - Date.now()) / 1000));
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>验证码 · 请输入</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#14161b;color:#e5e7eb;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{padding:14px 16px 18px}
  h1{margin:0 0 4px;font-size:16px;font-weight:600}
  .sub{margin:0 0 10px;color:#94a3b8;font-size:12px;word-break:break-all}
  .shot{background:#0b0d12;border:1px solid #2a2f3a;border-radius:8px;min-height:180px;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .shot img{max-width:100%;max-height:320px;display:block}
  #hint{margin:10px 0 0;color:#fbbf24;font-size:12px;min-height:18px}
  form{display:flex;gap:8px;margin-top:10px}
  input{flex:1;min-width:0;padding:9px 11px;border-radius:8px;border:1px solid #333a47;background:#1b1f27;color:#e5e7eb;font-size:16px;letter-spacing:1px;outline:none}
  input:focus{border-color:#6366f1}
  button{padding:9px 14px;border-radius:8px;border:1px solid #333a47;background:#262c37;color:#e5e7eb;font-size:13px;cursor:pointer}
  button.primary{background:#6366f1;border-color:#6366f1;color:#fff;font-weight:600}
  button:disabled{opacity:.55;cursor:default}
  .row{display:flex;align-items:center;gap:8px;margin-top:10px}
  .row .grow{flex:1}
  .foot{color:#64748b;font-size:11px;margin-top:12px}
</style>
</head>
<body>
<div class="wrap">
  <h1>需要输入验证码</h1>
  <p class="sub">源 ${sid} · 输入后浏览器 Cookie 会自动保存，验证码会返回给脚本</p>
  <div class="shot"><img id="shot" alt="验证码画面"></div>
  <p id="hint">画面加载中…</p>
  <form id="f" autocomplete="off">
    <input id="code" placeholder="输入图中的验证码" autofocus>
    <button class="primary" id="ok" type="submit">提交</button>
  </form>
  <div class="row">
    <button id="refresh" type="button">换一张</button>
    <button id="cancel" type="button">取消</button>
    <span class="grow"></span>
    <span id="count" style="color:#64748b;font-size:12px">剩余 ${expiresIn}s</span>
  </div>
  <div class="foot">关掉本窗口 = 取消这次验证码输入（脚本会收到「验证码输入已取消」）。</div>
</div>
<script>
(function(){
  var ID = ${idJson};
  var base = '/api/verify-code/' + encodeURIComponent(ID);
  var shot = document.getElementById('shot');
  var hint = document.getElementById('hint');
  var code = document.getElementById('code');
  var okBtn = document.getElementById('ok');
  var count = document.getElementById('count');
  var done = false;
  function stop(){ done = true; }
  function closeSoon(text){
    hint.textContent = text;
    stop();
    setTimeout(function(){ try { window.close(); } catch(e){} }, 500);
  }
  function frame(){
    if (done) return;
    fetch(base + '/frame', {cache:'no-store'}).then(function(r){ return r.json(); }).then(function(j){
      if (done) return;
      if (j && j.ok && j.frame) { shot.src = j.frame; hint.textContent = '请在下方输入图中的验证码'; }
      else if (j && j.error === 'NOT_PENDING') { closeSoon('验证码请求已结束'); }
    }).catch(function(){});
  }
  function state(){
    if (done) return;
    fetch(base + '/state', {cache:'no-store'}).then(function(r){ return r.json(); }).then(function(j){
      if (done) return;
      if (!j || !j.ok) { closeSoon('验证码请求已结束'); return; }
      if (j.state !== 'waiting') { closeSoon(j.error || '已完成'); return; }
      var left = Math.max(0, Math.round((j.expiresAt - Date.now())/1000));
      count.textContent = '剩余 ' + left + 's';
      if (j.starting) hint.textContent = '正在启动浏览器…';
    }).catch(function(){});
  }
  document.getElementById('f').addEventListener('submit', function(e){
    e.preventDefault();
    if (done) return;
    var c = (code.value || '').trim();
    if (!c) { hint.textContent = '请先输入验证码'; code.focus(); return; }
    okBtn.disabled = true;
    hint.textContent = '正在提交…';
    fetch(base, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({code:c})})
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (j && j.ok) { closeSoon('验证码已提交，正在关闭窗口…'); }
        else { okBtn.disabled = false; hint.textContent = (j && j.message) || '提交失败'; }
      })
      .catch(function(){ okBtn.disabled = false; hint.textContent = '提交失败（服务端不可达）'; });
  });
  document.getElementById('refresh').addEventListener('click', function(){
    fetch(base + '/refresh', {method:'POST'}).catch(function(){});
    setTimeout(frame, 300);
  });
  document.getElementById('cancel').addEventListener('click', function(){
    stop();
    fetch(base, {method:'DELETE'}).catch(function(){});
    closeSoon('已取消');
  });
  frame(); state();
  setInterval(frame, 1500);
  setInterval(state, 1500);
})();
</script>
</body>
</html>`;
}
