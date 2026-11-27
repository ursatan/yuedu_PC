/**
 * 常驻浏览器会话管理器（`D13` = A+B 的服务端地基）
 *
 * 为什么需要它：`browser-login.ts` 里那套「手写 CDP 客户端 + 按源持久 profile + `DevToolsActivePort`
 * 接管」本来只服务**登录窗**，会话一旦建好就随用随弃；而「过 JS challenge / 人机验证 / 带登录态抓
 * 内容页」要的是**同一只浏览器、同一份 cookie、长期复用**。于是把底层能力整体迁到这里，并按
 * `sessionKey` 统一管理生命周期 —— 登录窗与内容页渲染共用同一实例、同一 profile。
 *
 * 三层分工：
 *   · 会话层（本文件）：`sessionKey` → `BrowserSession`（cookie / storage / profile 按键隔离）。
 *   · 登录窗（`browser-login.ts`）：本文件的**薄封装**，语义（多标签、接管、harvest 不关窗）原样保留。
 *   · 渲染（`renderer.ts` 的 L3:常驻）：有会话就用它渲染，没有就回落 playwright/puppeteer ⇒ L2 ⇒ L1。
 *
 * ⚠️ 四条实测踩过的坑（都从 browser-login 迁来，别再踩）：
 *  a. **命令行 URL 打开页面不可靠**：`--new-window <url>` 之后 CDP 侧那个 page target 仍是
 *     `about:blank` ——页面**必须**用 `Target.createTarget({url})` 打开。
 *  b. **browser target 上没有 Network 域**：必须 `Target.attachToTarget(flatten)` 拿 page 会话。
 *  c. **harvest 不许顺手关窗**：读写与生命周期必须解耦（关窗只由显式动作触发）。
 *  d. **关窗必须等进程真的退出**：先 `Browser.close` 再等 exit，超时才 `kill()`，否则持久 cookie
 *     没落盘，「关窗后仍能补读」失效。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findFullChromium, isChallengePage } from '@yuedu/core';

export interface BrowserSession {
  /** 会话键（`'src:' + sourceId`；匿名渲染为 `'anon'`） */
  key: string;
  url: string;
  exe: string;
  port: number;
  wsPath: string;
  wsUrl: string;
  profileDir: string;
  /** 我们 spawn 的进程；**接管**（服务重启后认领已在跑的浏览器）时为 undefined */
  child?: ChildProcess;
  startedAt: number;
  /** 登录窗（用户在看的那只）的 tab（接管时不另开新 tab，直接 navigate） */
  pageTargetId?: string;
  /** `#459` 渲染专用 tab（**绝不**复用 `pageTargetId`：渲染是后台行为，不许抢用户正在看的标签） */
  renderTargetId?: string;
  /** 常驻（登录窗这类，用户在用的）：不参与 TTL 回收，也不在进程退出时被收掉 */
  pinned: boolean;
  /** 无头实例（渲染/补读 cookie 用） */
  headless: boolean;
  /**
   * `#514` **共享宿主时的浏览器上下文 ID**（`Target.createBrowserContext` 的产物）。
   *
   * 有值 ⇒ 本会话**没有自己的 Chromium 进程**：`port/wsUrl` 指向宿主（`__host`），
   * cookie / storage 隔离靠这个 context。所有 `Target.createTarget` 与 `Target.getTargets`
   * **必须**带上它（否则会串到默认 context，源之间共享 cookie —— 比不隔离更糟）。
   */
  browserContextId?: string;
  /** 最近一次使用时刻（TTL 回收判据） */
  lastUsedAt: number;
  /**
   * `#526` 已注入过反检测脚本（第二层）的 targetId 集合。
   * `Page.addScriptToEvaluateOnNewDocument` 是**按 page 累积**的注入，重复调用会叠加；
   * 而同一个 page 每次 attach 都会拿到新 sessionId ⇒ 只能靠 targetId 去重。
   */
  stealthTargets?: Set<string>;
}

const sessions = new Map<string, BrowserSession>();

/**
 * `#514` **浏览器拓扑 context 化**开关（P1-2）。
 *
 * ## 为什么需要它（而不是直接改默认）
 * `#491` P1-a 曾经实现过「宿主 + 按源 context」并冒烟通过，但因为**直接改默认路径**被用户
 * 整体回滚（`backup-before-rollback-2110`）。教训写进了纪律：架构级改动必须
 * **设置开关 + 隔离实例 A/B 对照**，数据达标才改默认。
 *
 * ## 收益与代价（A/B 要量化的就是这两项）
 * · 收益：N 个渲染源从 N 个 Chromium 进程 → 1 个（内存 -50% 以上，冷启动只付一次）；
 * · 代价：`BrowserContext` 的 cookie **只在内存**（进程退出即丢），而独立 profile 是落盘的
 *   ⇒ 渲染期拿到的 `cf_clearance` 等挑战凭证不能跨重启复用。P1-3「凭证标准化」
 *   （`Storage.getCookies` 持久化 + 下次 `setCookies`）就是为此准备的。
 *
 * ## 作用范围（有意收窄）
 * 只接管 **`src:` 键 + 无头 + 未被 pin** 的会话（即渲染/抓取）。登录窗（有头、用户在操作）
 * 仍走独立进程 —— 它要落盘 profile、要能接管、要让用户看见窗口，不该被共享宿主拖累。
 */
/**
 * `#515` 设置页开关的**运行时覆盖**（`null` = 跟随环境变量）。
 * 设置页写的就是它 —— 不用重启、不用设 env。
 */
let ctxModeOverride: boolean | null = null;
export function setBrowserContextMode(v: boolean | null): void {
  ctxModeOverride = v;
}
/** 当前是否启用共享宿主（设置页与路由都用这个判据，避免两处口径漂移） */
export function browserContextEnabled(): boolean {
  /**
   * `#525`（10-21 起观察 2 天，10-23 期满无异常 ⇒ 改默认）：缺省**开**。
   * 关的两种途径：设置页开关（`ctxModeOverride`，优先级最高）或
   * `YUEDU_BROWSER_CONTEXT=0` 钉死（CI / 排障用）。
   */
  return ctxModeOverride ?? process.env['YUEDU_BROWSER_CONTEXT'] !== '0';
}
function browserContextMode(): boolean {
  return browserContextEnabled();
}
/** 这个键是否属于 context 模式该接管的那一类（见上） */
function isContextKey(key: string, opts: { headless?: boolean; pinned?: boolean }): boolean {
  return key.startsWith('src:') && opts.headless === true && opts.pinned !== true;
}
/**
 * `#514` 统一构造 `Target.createTarget` 的参数。
 *
 * **唯一入口**：漏掉任何一处，那个 target 会落到默认 context ⇒ 源之间共享 cookie。
 * 非 context 模式下按 `browserContextId` 缺省（行为与旧实现一致）。
 */
function targetParams(s: BrowserSession | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  return s?.browserContextId ? { ...extra, browserContextId: s.browserContextId } : extra;
}
/**
 * `#526` **P1-1b 指纹第二层**（`Page.addScriptToEvaluateOnNewDocument`）。
 *
 * 第一层（`#506`）是启动参数：让 `navigator.webdriver === false`。那只解决**一个**信号，
 * 无头/自动化环境还有三个系统性缺口：
 *   ① `navigator.plugins` / `mimeTypes` 为空（真 Chrome 恒有 5 个内置 PDF 插件）；
 *   ② `navigator.languages` 可能只剩一项；
 *   ③ `window.chrome` 缺失。
 * CF / Akamai / reCAPTCHA 这类会对这几个信号**交叉校验**，缺一项就判「不是普通浏览器」。
 *
 * ★ 与常见 stealth 插件最大的不同：**只补缺失项，绝不篡改已有值**。
 * 为什么要这么保守：硬造一个与真实环境矛盾的指纹（比如 plugins 个数与 UA 不符、
 * languages 与 OS locale 不符）会把「本可放行」的站点变成**必弹验证** —— 这里优先保的是
 * **一致性**，不是「像另一款浏览器」。
 *
 * 开关：`YUEDU_STEALTH=0` 关（排障对照用）；默认开。
 */
function stealthEnabled(): boolean {
  return process.env['YUEDU_STEALTH'] !== '0';
}

const STEALTH_SCRIPT = [
  '(function () {',
  '  var added = [];',
  '  try {',
  '    var nav = navigator;',
  '    var proto = nav ? Object.getPrototypeOf(nav) : null;',
  '    if (proto && nav.webdriver !== false) {',
  "      Object.defineProperty(proto, 'webdriver', { get: function () { return false; }, configurable: true });",
  "      added.push('webdriver');",
  '    }',
  '    if (nav && (!nav.languages || nav.languages.length < 2)) {',
  "      Object.defineProperty(nav, 'languages', { get: function () { return ['zh-CN', 'zh', 'en-US', 'en']; }, configurable: true });",
  "      added.push('languages');",
  '    }',
  '    if (nav && (!nav.plugins || nav.plugins.length === 0)) {',
  '      function mkPlugin(name, desc) {',
  "        var p = { name: name, filename: 'internal-pdf-viewer', description: desc, length: 1 };",
  "        p[0] = { type: 'application/pdf', suffixes: 'pdf', description: desc, enabledPlugin: p };",
  '        return p;',
  '      }',
  "      var pdfDesc = 'Portable Document Format';",
  '      var plugins = [',
  "        mkPlugin('PDF Viewer', pdfDesc),",
  "        mkPlugin('Chrome PDF Viewer', pdfDesc),",
  "        mkPlugin('Chromium PDF Viewer', pdfDesc),",
  "        mkPlugin('Microsoft Edge PDF Viewer', pdfDesc),",
  "        mkPlugin('WebKit built-in PDF', pdfDesc),",
  '      ];',
  '      plugins.item = function (i) { return plugins[i] || null; };',
  '      plugins.namedItem = function (n) {',
  '        for (var i = 0; i < plugins.length; i++) { if (plugins[i].name === n) return plugins[i]; }',
  '        return null;',
  '      };',
  '      plugins.refresh = function () {};',
  '      var mimeTypes = { length: 1 };',
  "      mimeTypes[0] = { type: 'application/pdf', suffixes: 'pdf', description: pdfDesc, enabledPlugin: plugins[0] };",
  '      mimeTypes.item = function (i) { return mimeTypes[i] || null; };',
  '      mimeTypes.namedItem = function () { return mimeTypes[0]; };',
  "      Object.defineProperty(nav, 'plugins', { get: function () { return plugins; }, configurable: true });",
  "      Object.defineProperty(nav, 'mimeTypes', { get: function () { return mimeTypes; }, configurable: true });",
  "      added.push('plugins');",
  '    }',
  "    if (typeof window.chrome === 'undefined') {",
  '      window.chrome = {',
  '        runtime: {},',
  '        app: { isInstalled: false, InstallState: {}, RunningState: {} },',
  '        csi: function () { return { pageT: 1, tran: 15 }; },',
  '        loadTimes: function () {',
  '          var t = Date.now() / 1000;',
  '          return { requestTime: t, startLoadTime: t, commitLoadTime: t, finishDocumentLoadTime: t, finishLoadTime: t,',
  "            firstPaintTime: t, navigationType: 'Other', wasFetchedViaSpdy: false, wasNpnNegotiated: true,",
  "            npnNegotiatedProtocol: 'h2', connectionInfo: 'h2' };",
  '        },',
  '      };',
  "      added.push('chrome');",
  '    }',
  '  } catch (e) { /* 补不了也不能影响加载 */ }',
  "  if (added.length) { window.__yueduStealth = added.join(','); }",
  '})();',
].join('\n');

/**
 * 给某个 page target 注入第二层反检测脚本（**幂等**：按 targetId 只做一次）。
 *
 * 为什么放在 attach 之后而不是 Spawn 时：这个值对所有 future navigation 生效，
 * 而我们常常接管的本来就是**已存在的页面**（服务重启认领），那时早该注入了。
 * 失败一律吞掉 —— 反检测是「加分项」，不能拖累登录/渲染主链路。
 */
async function installPageStealth(s: BrowserSession, cdp: CdpClient, targetId: string, sid: string): Promise<void> {
  if (!stealthEnabled()) return;
  if (s.stealthTargets?.has(targetId)) return;
  try {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SCRIPT }, sid);
    if (!s.stealthTargets) s.stealthTargets = new Set<string>();
    s.stealthTargets.add(targetId);
  } catch {
    /* 老 Chromium / 该 target 已关闭 */
  }
}

/**
 * `#514` 取（必要时拉起）**共享宿主**浏览器 —— 所有 context 会话都挂在它下面。
 * 用 `acquire` 自身拿锁（`__host` 不满足 `isContextKey` ⇒ 不会再进 context 分支，无递归）。
 */
async function acquireHostBrowser(exe: string): Promise<BrowserSession> {
  const { session } = await acquire('__host', { headless: true, exe, pinned: true });
  return session;
}

/** 浏览器 profile 根目录（每个会话一个子目录）；服务端启动时用 `setBrowserProfileRoot` 指向数据目录 */
let profileRoot = join(tmpdir(), 'yuedu-login-profiles');

export function setBrowserProfileRoot(dir: string): void {
  profileRoot = resolve(dir);
}

/** 源 → 其专属 profile 目录（持久：关窗/重启服务都不丢登录态） */
export function browserProfileDir(sourceId: string): string {
  const safe = String(sourceId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'source';
  return join(profileRoot, safe);
}

/** 会话键 → profile 目录（`'src:<id>'` 仍落到 `<id>` 目录 ⇒ 与既有磁盘 profile 兼容，不重登） */
export function profileDirForKey(key: string): string {
  const k = String(key ?? '').trim() || 'anon';
  return browserProfileDir(k.startsWith('src:') ? k.slice(4) : k);
}

/** 源身份 → 会话键（唯一实现；无源身份用 `'anon'`） */
export function sessionKeyOf(sourceId?: string | null): string {
  const id = String(sourceId ?? '').trim();
  return id ? `src:${id}` : 'anon';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 极简 CDP 客户端：命令应答多路复用 + **可选事件订阅**（`Network.requestWillBeSent` 等）。
 * 事件订阅是 `#453` 新加的一小步——`sourceRegex` 的子资源拦截必须靠它。
 */
export class CdpClient {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private subs = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.id == null) {
        // 事件（无 id）：派发给订阅者
        if (msg.method) for (const cb of this.subs.get(msg.method) ?? []) cb(msg.params, msg.sessionId);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'));
      else p.resolve(msg.result);
    });
  }

  /**
   * `#710` 连接**失败即重试一次**。
   *
   * 用户实测（Aff）：Chromium 进程起来了（`DevToolsActivePort` 已写、窗口是 about:blank），
   * 但 `boot` 在 attach 阶段抛错 ⇒ 浮层「验证浏览器启动失败」。
   * 冷启动（大 profile / 组件更新 / 机械盘）时，调试端口刚开的主线程常常几十秒内都很忙，
   * 8s 的连接窗口会白丢一次。连接失败**没有副作用**（没建会话、没注入脚本），重试是安全的；
   * 反倒是把「慢」当「死」，代价是用户重新过闸。
   */
  static async connect(wsUrl: string, timeoutMs = 8000, attempts = 2): Promise<CdpClient> {
    let lastErr = new Error('CDP 连接失败');
    for (let i = 0; i < Math.max(1, attempts); i += 1) {
      const ws = new WebSocket(wsUrl);
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
          ws.addEventListener('open', () => {
            clearTimeout(t);
            resolve();
          });
          ws.addEventListener('error', () => {
            clearTimeout(t);
            reject(new Error('CDP 连接失败'));
          });
        });
        return new CdpClient(ws);
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
        if (i + 1 < attempts) await sleep(600);
      }
    }
    throw lastErr;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} 超时`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload['sessionId'] = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** 订阅 CDP 事件；返回退订函数 */
  subscribe(method: string, cb: (params: unknown, sessionId?: string) => void): () => void {
    const set = this.subs.get(method) ?? new Set();
    set.add(cb);
    this.subs.set(method, set);
    return () => {
      set.delete(cb);
      if (!set.size) this.subs.delete(method);
    };
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 调试端口是否仍然活着（HTTP `/json/version` 探活；进程已退出则失败） */
export async function cdpAlive(port: number, timeoutMs = 800): Promise<boolean> {
  if (!(port > 0)) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 等待 `DevToolsActivePort` 出现（Chromium 用 `--remote-debugging-port=0` 时把实际端口写这里）。
 * 必须**同时探活**：文件可能是上一次运行留下的（陈旧端口）。
 */
export async function waitForDevToolsPort(
  profileDir: string,
  timeoutMs = 10_000,
  /**
   * `#672` **进程是否还活着**。给了它才区分得开两种「端口没出来」：
   *   · 进程已经退出 ⇒ 立刻失败（继续等纯属白等）；
   *   · 进程还活着 ⇒ **慢启动**，多等一会儿（最多 3×timeoutMs，下限 30s）。
   *
   * 为什么必须补这一条（用户实测 菠萝猫 验证码页）：`#665` 把默认 20s 降到 10s
   * 是为了「冷启动别让人干等」，但本机负载高时 Chromium 起来要 10~20s ⇒
   * 直接报 `浏览器未在预期时间内开启调试端口` ⇒ **验证浮层里既没有画面也没有输入框**
   * （用户原话「chromium 已加载该页面，但是没有给到我输入界面」）。
   * 12s 就放弃的代价是整轮过闸失败，远高于多等 10s。
   */
  childAlive?: () => boolean,
): Promise<{ port: number; wsPath: string }> {
  const file = join(profileDir, 'DevToolsActivePort');
  const softDeadline = Date.now() + timeoutMs;
  const hardDeadline = Date.now() + Math.max(timeoutMs * 3, 30_000);
  let slowLogged = false;
  while (Date.now() < hardDeadline) {
    if (existsSync(file)) {
      try {
        const [portLine, pathLine] = readFileSync(file, 'utf-8').split(/\r?\n/);
        const port = Number(portLine);
        if (port > 0 && (await cdpAlive(port))) {
          return { port, wsPath: (pathLine ?? '').trim() || '/devtools/browser/' };
        }
      } catch {
        /* 文件正在写，下一轮再读 */
      }
    }
    if (childAlive && !childAlive()) {
      throw new Error('浏览器进程已退出（未开启调试端口）');
    }
    if (!slowLogged && Date.now() > softDeadline) {
      slowLogged = true;
      const left = Math.round((hardDeadline - Date.now()) / 1000);
      console.warn(`[yuedu] 浏览器启动偏慢（>${timeoutMs}ms，进程仍在）⇒ 再等到 ${left}s 上限`);
    }
    await sleep(250);
  }
  throw new Error('浏览器未在预期时间内开启调试端口');
}

/** 该 profile 是否已有**在跑的**浏览器实例（服务重启后靠它重新接管，不重开新窗口） */
export async function readActivePort(profileDir: string): Promise<{ port: number; wsPath: string } | null> {
  const file = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  try {
    const [portLine, pathLine] = readFileSync(file, 'utf-8').split(/\r?\n/);
    const port = Number(portLine);
    if (port > 0 && (await cdpAlive(port))) {
      return { port, wsPath: (pathLine ?? '').trim() || '/devtools/browser/' };
    }
  } catch {
    /* 读失败按“没有实例”处理 */
  }
  return null;
}

/**
 * 打开前规整 profile：**关掉「恢复上次会话」**。
 *
 * 为什么必须做：我们关窗走 `Browser.close`（正常路径），但开发期重启/异常退出时可能是硬杀。
 * Chromium 一旦认为上次是异常退出，下次启动就会把**上次所有标签页恢复出来**。
 * 做法是写 `Default/Preferences` 的两处（`profile.exit_type=Normal` + `session.restore_on_startup=5`），
 * 再顺手删掉上次会话的标签记录（best-effort，被占用就跳过）。
 */
export function prepareProfile(profileDir: string): void {
  const def = join(profileDir, 'Default');
  try {
    mkdirSync(def, { recursive: true });
  } catch {
    /* 已存在 */
  }
  const prefFile = join(def, 'Preferences');
  let pref: Record<string, unknown> = {};
  try {
    if (existsSync(prefFile)) pref = JSON.parse(readFileSync(prefFile, 'utf-8')) as Record<string, unknown>;
  } catch {
    pref = {};
  }
  pref['profile'] = { ...(pref['profile'] as Record<string, unknown> | undefined), exit_type: 'Normal', exited_cleanly: true };
  pref['session'] = { ...(pref['session'] as Record<string, unknown> | undefined), restore_on_startup: 5, startup_urls: [] };
  try {
    writeFileSync(prefFile, JSON.stringify(pref));
  } catch {
    /* 写不进就靠下面的命令行开关兜底 */
  }
  for (const rel of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try {
      rmSync(join(def, rel), { force: true });
    } catch {
      /* 被占用忽略 */
    }
  }
  try {
    rmSync(join(def, 'Sessions'), { recursive: true, force: true });
  } catch {
    /* 被占用忽略 */
  }
}

/**
 * 拉起一只浏览器（有头=登录窗口；无头=渲染/只读 cookie）。
 * 页面统一由 CDP `Target.createTarget` 打开（见文件头 a 条），这里只开 `about:blank`。
 */
export async function spawnBrowser(
  exe: string,
  profileDir: string,
  opts: {
    headless: boolean;
    extraArgs?: string[];
    /**
     * `#710` 「等调试端口」的软上限（硬上限仍是 `max(3×, 30s)`，见 `waitForDevToolsPort`）。
     * 有头验证窗传 15s（硬上限 45s）：它前面有浮层的「正在拉起验证浏览器…」，多等不伤体验；
     * 而一旦判失败，用户要重新过闸 —— 代价远高于多等 20s。
     */
    startTimeoutMs?: number;
  },
): Promise<{ child: ChildProcess; port: number; wsPath: string }> {
  prepareProfile(profileDir);
  /**
   * `#554` **起前先清扫**：上次异常退出（服务重启 / 硬杀 / 崩溃）可能残留占着这个 profile 的
   * 浏览器进程 ⇒ 新进程抢不到单例锁、`waitForDevToolsPort` 20s 超时（登录窗「关窗后重开 /
   * 补读 cookie」间歇失败的直接现场）。3s 有界：起浏览器在用户操作的临界路径上，不能久等。
   */
  await reapProfileProcesses(profileDir, 3000);
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 关掉「上次异常退出」气泡与自动恢复会话（配合 prepareProfile 里的 Preferences）
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate,MediaRouter',
    /**
     * `#483` **反节流三件套**：CF 的 JS 挑战靠 `setTimeout` 驱动，而 Chromium 对**后台/被遮挡**
     * 的标签页会节流定时器 ⇒ 旧实现只能靠 `activate:true` 把窗口抢到前台（用户每次切分类都
     * 看到浏览器弹一下）。加上这三个开关后，后台标签页的定时器照常跑 ⇒ 重放可以全程后台进行。
     */
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    /**
     * `#506` P1-1 **反检测补丁（第一层）**：`navigator.webdriver` 是 CDP/WebDriver 自动化最明显的
     * 指纹之一 —— 部分站点（含 CF 策略较严的）见到它就弹人工验证。`--disable-blink-features=
     * AutomationControlled` 会让 Blink 不置位该特征（`navigator.webdriver === false`）；
     * `--exclude-switches=enable-automation` 让 `chrome://version` 与自动化探测看不到该开关。
     *
     * 为什么放在**启动参数**而不是每个 tab 注入脚本：参数对**所有** target 生效，
     * 不依赖「每处 attach 都记得调 stealth」——后者漏一处就前功尽弃（本仓已有类似教训）。
     * 第二层（plugins/languages/chrome 痕迹）留作 P1-1b：需要 `Page.addScriptToEvaluateOnNewDocument`。
     */
    '--disable-blink-features=AutomationControlled',
    '--exclude-switches=enable-automation',
  ];
  if (opts.headless) args.push('--headless=new', '--disable-gpu');
  /**
   * `#482` 额外启动参数（验证会话用它把窗口**生在屏幕外**）。
   * ★ 必须在 `about:blank`（URL 参数）**之前**：命令行里 URL 之后的东西不再是开关。
   */
  if (opts.extraArgs?.length) args.push(...opts.extraArgs.filter((a) => typeof a === 'string' && a));
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: opts.headless });
  const startTimeoutMs = opts.startTimeoutMs ?? 10_000;
  const t0 = Date.now();
  try {
    const { port, wsPath } = await waitForDevToolsPort(profileDir, startTimeoutMs, () => child.exitCode === null && !child.killed);
    // `#710` 启动耗时留痕：慢启动（>软上限）时用户下次贴日志就能直接看出预算是否还够
    const cost = Date.now() - t0;
    if (cost > startTimeoutMs) {
      console.warn(`[yuedu] 浏览器启动耗时 ${cost}ms（软上限 ${startTimeoutMs}ms，硬上限 ${Math.max(startTimeoutMs * 3, 30_000)}ms）`);
    }
    return { child, port, wsPath };
  } catch (e) {
    /**
     * `#710` **失败必须收掉这只新进程**。
     *
     * 用户实测（Aff）：浮层报「验证浏览器启动失败」，而桌面上留着一个标题为【无标题】的
     * Chromium 空窗（`about:blank`）—— 就是这里：`spawnBrowser` 抛错后 child 无人管。
     * 它还会**占着 profile 的单例锁**，让下一次「重新拉起」被启动器合并后退出
     * （表现为 `浏览器进程已退出（未开启调试端口）`）。
     */
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[yuedu] 浏览器启动失败（${Date.now() - t0}ms，pid=${String(child.pid)}）：${msg} ⇒ 结束残留进程（避免留下空窗/占锁）`);
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
    await reapProfileProcesses(profileDir, 2000).catch(() => 0);
    throw e;
  }
}

/** target 是否还在（复用 tab 前确认，避免对着已关闭的 target 发命令） */
export async function targetAlive(cdp: CdpClient, targetId: string): Promise<boolean> {
  try {
    const r = await cdp.send<{ targetInfos?: Array<{ targetId: string }> }>('Target.getTargets');
    return (r.targetInfos ?? []).some((t) => t.targetId === targetId);
  } catch {
    return false;
  }
}

/**
 * 挑一个页面 target 给本次用，优先级：
 *  ① 记着的 `pageTargetId`（还活着）；
 *  ② profile 里**已有的非 about:blank 标签** —— 服务重启后内存里的 `pageTargetId` 会丢，
 *     不认领已有标签就会「每点一次开一个」；
 *  ③ 都不行才新建（需要页面时直接用 `createUrl` 建，比先建 about:blank 再 navigate 可靠）。
 */
export async function pickPageTarget(
  cdp: CdpClient,
  s: BrowserSession,
  createUrl?: string,
): Promise<{ targetId: string; created: boolean }> {
  if (s.pageTargetId && (await targetAlive(cdp, s.pageTargetId))) {
    return { targetId: s.pageTargetId, created: false };
  }
  const r = await cdp.send<{ targetInfos?: Array<{ targetId: string; type: string; url: string; browserContextId?: string }> }>(
    'Target.getTargets',
  );
  /**
   * `#514` **必须按 context 过滤**：`Target.getTargets` 返回**所有** context 的 target，
   * 不过滤就会认领别的源的标签（共享宿主下设成「串会话」，比不隔离更糟）。
   * 非 context 模式也加上这条：默认 context 的 target 才归它。
   *
   * ★ `#519` 修正：**默认模式下不能再按 `!browserContextId` 判**——实测 Chromium 的
   * `Target.getTargets` 对默认 context 的 target 也带 `browserContextId` 字段 ⇒ 过滤后
   * 恒为空集 ⇒ ①认领不到已有标签（重启后每操作一次就新开一个）②空白页永远收不掉
   * ③渲染收尾误判「只剩自己」而每次补一个 about:blank。默认模式直接不过滤。
   */
  const inScope = (r.targetInfos ?? []).filter((t) =>
    s.browserContextId ? t.browserContextId === s.browserContextId : true,
  );
  // `#459`：渲染专用 tab（`renderTargetId`）不在候选内 —— 它归渲染用，不该被登录窗认领
  const existing = inScope.find(
    (t) => t.type === 'page' && !/^about:blank$/i.test(t.url) && t.targetId !== s.renderTargetId,
  );
  if (existing) {
    s.pageTargetId = existing.targetId;
    return { targetId: existing.targetId, created: false };
  }
  const c = await cdp.send<{ targetId: string }>(
    'Target.createTarget',
    targetParams(s, { url: createUrl ?? 'about:blank' }),
  );
  s.pageTargetId = c.targetId;
  return { targetId: c.targetId, created: true };
}

/**
 * 在**页面会话**里执行一段 CDP 命令（没有页面就建一个）。
 * 回调第三个参数 = 这个 target 是不是**本次刚建的**（刚建说明它已经带了目标 URL，不必再 navigate）。
 */
/**
 * `#465` **跳转拦截**（`D13` 结案时留下的功能项；属 `#465` 壳层渲染的 P3 子集）。
 *
 * 是什么：渲染/抓取会话里，把**顶栏跨主机导航**与 **跨主机 `window.open` 弹窗**拦在
 * CDP 层 —— 站点过闸/验证途中被跳去外域（广告落地页、第三方登录）会**丢掉会话与
 * 验证态**（`#483` 的反爬重放正是靠「一次清关、后续静默」续命）。
 *
 * 实现（三条，都挂在 `attachPageSession` / 渲染 tab attach 两处，随会话生灭）：
 *  ① `Fetch.enable` 只暂停 **Document** 请求（媒体/XHR 不碰 ⇒ 开销近零）；
 *  ② 主框架（`Page.getFrameTree` + `frameNavigated` 维护）跨主机 ⇒ `Fetch.failRequest
 *     (BlockedByClient)`；iframe 的 Document 不拦（跨域嵌入是常态，拦了会打破页面）；
 *  ③ `Target.targetCreated` 里跨主机新 target 直接 `closeTarget`（同主机验证流不碰；
 *     about:blank 留给 `closeBlankTabs` 收）。
 *
 * 开关：`YUEDU_NAV_GUARD=1` 全开会话都拦 / `=0` 全关；**缺省只护无头非 pin 会话**
 * （登录窗是用户在操作，拦他的跳转=帮倒忙）。判据 = **主机名**（忽略 scheme/port，
 * 避免 http→https 这种同站跳转被误拦）。
 */
export function navGuardEnabled(s: BrowserSession): boolean {
  const v = process.env.YUEDU_NAV_GUARD;
  if (v === '0') return false;
  if (v === '1') return true;
  return s.headless && !s.pinned;
}
/** 取 URL 的主机名（取不到返回空串 —— 空串一律放行，宁放过不误杀） */
export function navHostOf(u: unknown): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(u ?? ''));
  if (!m || !m[1]) return '';
  const host = m[1].split('@').pop() ?? '';
  return host.split(':')[0]?.toLowerCase() ?? '';
}
export async function installNavGuard(s: BrowserSession, cdp: CdpClient, sid: string): Promise<void> {
  if (!navGuardEnabled(s)) return;
  const baseHost = navHostOf(s.url);
  if (!baseHost) return; // 会话没有源 URL（匿名渲染）⇒ 无从判定，不装
  try {
    // ② 主框架 id：只拦顶栏导航（iframe 的 Document 请求放行）
    let mainFrameId = '';
    try {
      const tree = await cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree', {}, sid);
      mainFrameId = tree.frameTree?.frame?.id ?? '';
    } catch {
      /* Page 域未启用也能跑：frameNavigated 会补上 */
    }
    cdp.subscribe('Page.frameNavigated', (params, evSid) => {
      if (evSid !== sid) return;
      const f = (params as { frame?: { id?: string; parentId?: string } }).frame;
      if (f && !f.parentId && f.id) mainFrameId = f.id;
    });
    // ① 只暂停 Document 请求
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
      sid,
    );
    cdp.subscribe('Fetch.requestPaused', (params, evSid) => {
      if (evSid !== sid) return;
      const p = params as { requestId?: string; resourceType?: string; frameId?: string; request?: { url?: string } };
      const rid = p.requestId;
      if (!rid) return;
      const settle = (allow: boolean): void => {
        if (allow) void cdp.send('Fetch.continueRequest', { requestId: rid }, sid).catch(() => undefined);
        else void cdp.send('Fetch.failRequest', { requestId: rid, errorReason: 'BlockedByClient' }, sid).catch(() => undefined);
      };
      if (p.resourceType && p.resourceType !== 'Document') { settle(true); return; }
      if (mainFrameId && p.frameId && p.frameId !== mainFrameId) { settle(true); return; }
      const toHost = navHostOf(p.request?.url);
      settle(!(toHost && toHost !== baseHost));
    });
    // ③ window.open 弹窗：跨主机 target 直接关
    try {
      await cdp.send('Target.setDiscoverTargets', { discover: true });
    } catch {
      /* 老 Chromium 没这个域 ⇒ 弹窗防护静默不生效（导航拦截不受影响） */
    }
    cdp.subscribe('Target.targetCreated', (params) => {
      const info = (params as { targetInfo?: { targetId?: string; type?: string; url?: string; browserContextId?: string } }).targetInfo;
      if (!info || !info.targetId || info.type !== 'page') return;
      if (s.browserContextId && info.browserContextId && info.browserContextId !== s.browserContextId) return;
      const h = navHostOf(info.url);
      if (h && h !== baseHost) void cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
    });
  } catch (e) {
    console.warn(`[yuedu] 跳转拦截安装失败（不影响渲染）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 附加到该会话的页面 target，**不接管 CDP 连接的生命周期**（调用方负责 `cdp.close()`）。
 *
 * `#482` 为什么要它：`withPageSession` 结束就 `cdp.close()`，而 screencast 是**长订阅**
 * （帧事件要在回调结束后继续流过来）⇒ 必须拿到一条能一直活着的连接。
 * 与 `withPageSession` **共用** `pickPageTarget`（页面选派的唯一实现，不许抄第二份）。
 */
export async function attachPageSession(
  s: BrowserSession,
  opts: { createUrl?: string } = {},
): Promise<{ cdp: CdpClient; sessionId: string; targetId: string; created: boolean }> {
  const cdp = await CdpClient.connect(s.wsUrl);
  try {
    const { targetId, created } = await pickPageTarget(cdp, s, opts.createUrl);
    const att = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    // `#526` P1-1b 指纹第二层（幂等、失败不影响主链路）—— see installPageStealth
    await installPageStealth(s, cdp, targetId, att.sessionId);
    // `#465` 跳转拦截（随会话生灭；缺省只护无头渲染会话，见 installNavGuard）
    await installNavGuard(s, cdp, att.sessionId);
    return { cdp, sessionId: att.sessionId, targetId, created };
  } catch (e) {
    cdp.close();
    throw e;
  }
}

/**
 * `#727` 在会话里**另开一个独立标签**（绝不碰 `pageTargetId` / `renderTargetId`）。
 *
 * 为什么必须新开：验证码请求常发生在「用户正在登录窗里操作」或「验证浮层正显示某页」的中途。
 * `pickPageTarget` 会优先复用 `pageTargetId` ⇒ 直接复用它会把用户正在看的页面**导航走**。
 * 这里用 `Target.createTarget` 单独建一个 tab，登录窗 / 验证浮层 / 渲染 tab 一个都不动。
 *
 * 调用方负责 `cdp.close()` 并关闭这个 target（恒留 ≥1 标签页，见 `#483`）。
 */
export async function openAuxTab(
  s: BrowserSession,
  url: string,
): Promise<{ cdp: CdpClient; sessionId: string; targetId: string }> {
  const cdp = await CdpClient.connect(s.wsUrl);
  try {
    const r = await cdp.send<{ targetId: string }>('Target.createTarget', targetParams(s, { url }));
    const att = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: r.targetId, flatten: true });
    /**
     * 只装指纹补丁，**不装** `installNavGuard`：验证码图片/页面可能落在**另一个域**
     * （CDN、专业验证码服务），跳转拦截会把「换一张」的 `Page.navigate` 直接 fail 掉。
     * 这个 tab 只用于看验证码，导航面很小，关掉拦截不会放大风险。
     */
    await installPageStealth(s, cdp, r.targetId, att.sessionId);
    return { cdp, sessionId: att.sessionId, targetId: r.targetId };
  } catch (e) {
    cdp.close();
    throw e;
  }
}

/**
 * `#488` **把浏览器窗口挪出可视区**（保住有头指纹，但用户看不到弹窗）。
 *
 * ★★ 主路径其实是**启动参数** `--window-position=-3200,-2400`（新建进程即屏幕外，见
 *   `AcquireOptions.extraArgs`）；本函数是**兜底**：复用已有浏览器时参数传不进去
 *   （典型：修复前拉起的可见窗口，服务重启后会按 `DevToolsActivePort` 接管它）。
 *   实测 CDP 这条路常因窗口未创建完拿不到 `windowId` ⇒ 只靠它会静默失败。
 *
 * @returns 是否确实挪动了（false = 窗口可能还在屏幕上，调用方应留痕）
 */
export async function moveWindowOffscreen(s: BrowserSession): Promise<boolean> {
  let cdp: CdpClient | undefined;
  try {
    const att = await attachPageSession(s);
    cdp = att.cdp;
    const w = await cdp.send<{ windowId?: number }>('Browser.getWindowForTarget', { targetId: att.targetId });
    if (!w.windowId) {
      console.warn('[yuedu] Browser.getWindowForTarget 未返回 windowId（窗口可能还没创建完）⇒ 挪不出屏幕');
      return false;
    }
    await cdp.send('Browser.setWindowBounds', {
      windowId: w.windowId,
      bounds: { left: -3200, top: -2400, width: 960, height: 720, windowState: 'normal' },
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 兜底的兜底：移不动就最小化（至少不抢前台）
    try {
      if (cdp) {
        const w2 = await cdp.send<{ windowId?: number }>('Browser.getWindowForTarget', { targetId: s.pageTargetId ?? '' });
        if (w2.windowId) {
          await cdp.send('Browser.setWindowBounds', { windowId: w2.windowId, bounds: { windowState: 'minimized' } });
          console.warn(`[yuedu] 窗口移到屏幕外失败（${msg}）⇒ 已最小化兜底`);
          return true;
        }
      }
    } catch {
      /* 两条路都断了，认了 */
    }
    console.warn(`[yuedu] 窗口移出屏幕失败（仍会弹窗，功能不受影响）：${msg}`);
    return false;
  } finally {
    cdp?.close();
  }
}

/**
 * `#489` **把窗口最小化**（验证收尾用：进程要留着给反爬重放，但不能再占屏幕）。
 *
 * 与 `moveWindowOffscreen` 的分工：那个负责「移到屏幕外」（新建进程时其实由启动参数保证），
 * 这个负责「收尾后彻底不占屏幕」—— 两条都失败时（复用时序差）最小化通常还能成。
 */
export async function minimizeWindow(s: BrowserSession): Promise<boolean> {
  try {
    const att = await attachPageSession(s);
    try {
      const w = await att.cdp.send<{ windowId?: number }>('Browser.getWindowForTarget', { targetId: att.targetId });
      if (!w.windowId) return false;
      await att.cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } });
      return true;
    } finally {
      att.cdp.close();
    }
  } catch (e) {
    console.warn(`[yuedu] 窗口最小化失败（不影响功能）：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function withPageSession<T>(
  s: BrowserSession,
  fn: (cdp: CdpClient, sessionId: string, created: boolean) => Promise<T>,
  opts: { createUrl?: string } = {},
): Promise<T> {
  const { cdp, sessionId, created } = await attachPageSession(s, opts);
  try {
    return await fn(cdp, sessionId, created);
  } finally {
    cdp.close();
  }
}

/**
 * 收掉多余的空标签（首次启动 Chromium 会自带一个 about:blank）。
 *
 * ★★ `#167` 收尾：**必须等到它真的从 target 列表里消失再返回**（`Target.closeTarget` 是异步的）。
 */
export async function closeBlankTabs(s: BrowserSession): Promise<void> {
  const cdp = await CdpClient.connect(s.wsUrl);
  try {
    // 最多 10 轮 × 60ms ≈ 600ms（实测 1~2 轮就收敛）；轮空即返回，稳态零开销。
    for (let pass = 0; pass < 10; pass += 1) {
      const r = await cdp.send<{
        targetInfos?: Array<{ targetId: string; type: string; url: string; browserContextId?: string }>;
      }>('Target.getTargets');
      // `#514` 只看**本 context** 的 target（否则会把别的源的空白页当自己的收掉）
      const pages = (r.targetInfos ?? []).filter(
        (t) => t.type === 'page' && (s.browserContextId ? t.browserContextId === s.browserContextId : true),
      );
      const blanks = pages.filter(
        (t) => t.targetId !== s.pageTargetId && t.targetId !== s.renderTargetId && /^about:blank$/i.test(t.url),
      );
      if (blanks.length === 0) return;
      /**
       * ★★ `#483`：**永远留至少一个标签页**（`blanks.length === pages.length` ⇒ 关掉就一个不剩）。
       *
       * Chromium 在最后一个标签页关闭时会**直接退出进程** —— 而反爬重放的收尾恰好是
       * 「关渲染 tab → 收空白 tab」⇒ 浏览器每次用完就死 ⇒ 下一次切分类/点卡片又要重新拉起
       * 一只（用户看到的就是「每次都弹一次浏览器、闪一下又关」）。
       */
      const closable = blanks.length === pages.length ? blanks.slice(1) : blanks;
      if (closable.length === 0) return;
      for (const t of closable) {
        try {
          await cdp.send('Target.closeTarget', { targetId: t.targetId });
        } catch {
          /* 关不掉无所谓 */
        }
      }
      await sleep(60);
    }
    console.warn('[yuedu] 浏览器会话仍有未收掉的空白标签（已重试 10 轮）');
  } finally {
    cdp.close();
  }
}

/** 读回全部 cookie（页面会话级；`Network.enable` 后 `Network.getAllCookies`，再退 `Storage.getCookies`） */
export async function readCookiesViaCdp(s: BrowserSession): Promise<Array<Record<string, unknown>>> {
  return withPageSession(s, async (cdp, sid) => {
    try {
      await cdp.send('Network.enable', {}, sid);
    } catch {
      /* 部分版本不需要显式 enable */
    }
    try {
      const r = await cdp.send<{ cookies?: Array<Record<string, unknown>> }>('Network.getAllCookies', {}, sid);
      if (r.cookies?.length) return r.cookies;
    } catch {
      /* 退到 Storage 域 */
    }
    const s2 = await cdp.send<{ cookies?: Array<Record<string, unknown>> }>('Storage.getCookies', {}, sid);
    return s2.cookies ?? [];
  });
}

/**
 * `#515` **context 凭证持久化**（P1-3 的核心）：cookie 不随进程/context 丢。
 *
 * 背景：`BrowserContext` 的 cookie **只在内存**（进程退出即丢），而独立 profile 是落盘的
 * ⇒ 共享宿主模式下，渲染期拿到的 `cf_clearance` 等挑战凭证不能跨重启复用，撞 CF 的源
 * 每次都要重新过挑战。这是 `#514` 初期保持默认关的唯一原因（`#515` 已修：凭证落盘，
 * `#525` 10-23 观察期满据此改默认开）。
 *
 * 做法：**存在 profileDir 下的 JSON**（不是源 CookieStore —— 那个只存 `name=value`
 * 并且会被拼进 Cookie 请求头，塞完整 cookie 对象会污染请求）。
 *  · 回收前 `Storage.getCookies({browserContextId})` → `ctx-cookies.json`；
 *  · 下次建 context 时 `Storage.setCookies({cookies, browserContextId})` 灌回去。
 *
 * ⚠️ 只回传 CDP 认得的字段：`partitionKey`/`size`/`session` 这类返回字段塞回去会报错。
 */
const CTX_COOKIE_FILE = 'ctx-cookies.json';
const COOKIE_FIELDS = new Set([
  'name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite',
  'priority', 'sameParty', 'sourceScheme', 'sourcePort',
]);
function pickCookieFields(list: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return list.map((c) => {
    const out: Record<string, unknown> = {};
    for (const k of COOKIE_FIELDS) if (c[k] !== undefined) out[k] = c[k];
    return out;
  }).filter((c) => typeof c['name'] === 'string' && String(c['name']));
}

/** 回收前落盘（best-effort：存不下也要让回收继续） */
async function saveContextCookies(s: BrowserSession): Promise<void> {
  if (!s.browserContextId) return;
  try {
    const cdp = await CdpClient.connect(s.wsUrl, 2000);
    try {
      const r = await cdp.send<{ cookies?: Array<Record<string, unknown>> }>('Storage.getCookies', {
        browserContextId: s.browserContextId,
      });
      const list = pickCookieFields(r.cookies ?? []);
      mkdirSync(s.profileDir, { recursive: true });
      writeFileSync(join(s.profileDir, CTX_COOKIE_FILE), JSON.stringify(list));
    } finally {
      cdp.close();
    }
  } catch {
    /* 宿主已关 / context 已失效：都算「没东西可存」 */
  }
}

/** 建 context 后灌回上次的 cookie（在导航**之前**调用，页面首次加载就带登录态/clearance） */
async function restoreContextCookies(s: BrowserSession): Promise<void> {
  if (!s.browserContextId) return;
  const f = join(s.profileDir, CTX_COOKIE_FILE);
  if (!existsSync(f)) return;
  try {
    const list = JSON.parse(readFileSync(f, 'utf8')) as Array<Record<string, unknown>>;
    if (!Array.isArray(list) || !list.length) return;
    const cdp = await CdpClient.connect(s.wsUrl, 2000);
    try {
      await cdp.send('Storage.setCookies', { cookies: pickCookieFields(list), browserContextId: s.browserContextId });
    } finally {
      cdp.close();
    }
  } catch {
    /* 文件损坏 / 字段不兼容 ⇒ 当作没有（不影响新建 context） */
  }
}

/** 在页面会话里预置 cookie（“换账号”场景带上已有会话；best-effort） */
export async function setCookiesViaCdp(s: BrowserSession, cookies: Array<Record<string, unknown>>): Promise<void> {
  await withPageSession(s, async (cdp, sid) => {
    await cdp.send('Network.setCookies', { cookies }, sid);
    try {
      await cdp.send('Page.reload', {}, sid);
    } catch {
      /* 刷新失败不影响已写入的 cookie */
    }
  });
}

/**
 * `#554` 杀掉**命令行里还带着这个 profile** 的浏览器进程，等到一个不剩（有界）。
 *
 * 为什么 killSession 里「等 exit + child.kill()」不够：Chromium 的 storage/utility 子进程
 * 会在父进程（无论优雅退出还是被硬杀）之后仍占着 profile 的 leveldb 句柄与单例锁几秒。
 * 这几秒就是全部病根：同 profile 重开浏览器 ⇒ 抢不到锁、20s 等不到调试端口；
 * 删 profile ⇒ EPERM（`clearLoginBrowserData` 间歇 false）。
 *
 * 按 **profile 路径**匹配 PID 再杀 ⇒ 不存在 PID 复用误伤（命令行里带着我们的 profile 才动）；
 * 非 Windows 直接返回 0（POSIX 子进程随父进程俱退，无此竞态）；
 * 查询/击杀一律 best-effort + 超时 ⇒ 杀不净也不卡死关闭/启动流程（退回改动前的行为）。
 */
async function reapProfileProcesses(profileDir: string, timeoutMs = 6000): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const deadline = Date.now() + timeoutMs;
  let killed = 0;
  for (;;) {
    const pids = await pidsUsingProfile(profileDir);
    if (pids.length === 0) return killed;
    if (Date.now() >= deadline) return killed;
    for (const pid of pids) {
      await killPid(pid);
      killed += 1;
    }
    await sleep(250); // 刚杀的进程可能还在退出中，缓半拍再复查
  }
}

/** 命令行里带该 profile 的浏览器进程 PID（Windows CIM；非 Windows / 查询失败 ⇒ 空数组） */
async function pidsUsingProfile(profileDir: string): Promise<number[]> {
  const ps =
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" ` +
    `| Where-Object { $_.CommandLine -like '*${profileDir}*' } | ForEach-Object { $_.ProcessId }`;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(
        out
          .split(/\r?\n/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
    };
    try {
      const p = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
      p.stdout?.on('data', (d) => {
        out += String(d);
      });
      p.on('error', finish);
      p.on('close', finish);
      setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* ignore */
        }
        finish();
      }, 5000).unref();
    } catch {
      finish();
    }
  });
}

/** taskkill 强杀单个 PID（带 /T 收其子树；best-effort，3s 超时） */
async function killPid(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      p.on('error', () => resolve());
      p.on('exit', () => resolve());
      setTimeout(() => resolve(), 3000).unref();
    } catch {
      resolve();
    }
  });
}

/**
 * 关闭某会话的浏览器进程（profile 默认保留）。
 *
 * ⚠️ 必须**等进程真的退出**再谈“关完了”：先 `Browser.close`（优雅关停，Chromium 借此把
 * cookie DB 落盘），再等 exit；超时才 `kill()`。
 */
export async function killSession(s: BrowserSession, opts: { keepProfile?: boolean } = {}): Promise<void> {
  /**
   * `#514` **共享宿主的会话只能收自己的 context**：
   * `s.child` 是 undefined ⇒ 走下面的逻辑会执行 `Browser.close`，那是**把宿主整个关掉**
   * （其他源的 context 全部失效）。这里改成 `Target.disposeBrowserContext`（等价于
   * 「清掉这个源的 cookie / storage 并关掉它的页面」，宿主进程与别人的 context 毫发无损）。
   */
  if (s.browserContextId) {
    // `#515` 先落盘 cookie 再销毁 context（否则 cf_clearance 等挑战凭证跟着一起没）
    await saveContextCookies(s);
    try {
      const cdp = await CdpClient.connect(s.wsUrl, 2000);
      try {
        await cdp.send('Target.disposeBrowserContext', { browserContextId: s.browserContextId });
      } finally {
        cdp.close();
      }
    } catch {
      /* 宿主已经没了 / context 已被回收：都算「已经关了」 */
    }
    sessions.delete(s.key);
    return;
  }
  const child = s.child;

  const exited = new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
  try {
    const cdp = await CdpClient.connect(s.wsUrl, 2000);
    await cdp.send('Browser.close');
    cdp.close();
  } catch {
    /* 连不上就直接杀进程 */
  }
  // 给浏览器时间做优雅退出（落盘 cookie/清理锁文件），不要在它写盘写到一半时开杀
  await Promise.race([exited, sleep(4000)]);
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await Promise.race([exited, sleep(1500)]);
  }
  /**
   * `#554` **收尾清扫：等到一个占着这个 profile 的 chrome 进程都不剩**（有界 6s）。
   *
   * 上面两条路都可能留下占锁进程（10-22 插桩实测，两条都抓到过现行）：
   *  · 优雅退出（`Browser.close` 后 exitCode=0）：storage/utility 子进程慢半拍，
   *    仍开着 leveldb 句柄（`Default/Collaboration/MessageDB`、`commerce_subscription_db/LOCK` 等）；
   *  · 硬杀：`child.kill()` 只终结父进程，renderer 子进程被孤儿化。
   * 这些进程多数几秒内自灭，但**下一秒**就可能撞上：同 profile 重开浏览器抢不到单例锁
   * ⇒ 20s 等不到调试端口（登录窗「关窗后重开/补读」间歇失败，连跑 4/5）；删 profile 撞
   * EPERM ⇒ `clearLoginBrowserData` 间歇返回 false。按 **profile 路径**匹配 PID 再杀，
   * 不存在 PID 复用误伤（命令行里带着我们的 profile 才动手）。
   */
  await reapProfileProcesses(s.profileDir);
  if (!opts.keepProfile) {
    await sleep(300);
    try {
      rmSync(s.profileDir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄占用忽略（下次开机自动清理临时目录） */
    }
  }
}

/**
 * 取（必要时按 profile 里的活动端口**接管**）某会话；只复用/接管，**不新建**。
 * 接管是关键词：服务重启后内存空，但用户那只浏览器还在跑（`DevToolsActivePort`），必须认领回来。
 */
export async function getSession(key: string): Promise<BrowserSession | null> {
  const cur = sessions.get(key);
  if (cur) {
    if (await cdpAlive(cur.port)) {
      cur.lastUsedAt = Date.now();
      return cur;
    }
    sessions.delete(key);
  }
  /**
   * `#514` context 回话**不做接管**：它没有自己的进程与 `DevToolsActivePort`，
   * 内存里丢了就是没了（宿主还在，重建一个 context 即可）。
   * ⚠️ 若继续走下面的 `readActivePort(profileDir)`，会读到**上一次独立进程**遗留的端口文件
   * ⇒ 认领到一个已经不对应任何 context 的旧浏览器（串 cookie 的隐患）。
   */
  if (browserContextMode() && isContextKey(key, { headless: true })) return null;
  const profileDir = profileDirForKey(key);
  const act = await readActivePort(profileDir);
  if (!act) return null;
  const s: BrowserSession = {
    key,
    url: cur?.url ?? '',
    exe: findFullChromium() ?? '',
    port: act.port,
    wsPath: act.wsPath,
    wsUrl: `ws://127.0.0.1:${act.port}${act.wsPath}`,
    profileDir,
    startedAt: Date.now(),
    pinned: cur?.pinned === true,
    headless: false,
    lastUsedAt: Date.now(),
    ...(cur?.pageTargetId ? { pageTargetId: cur.pageTargetId } : {}),
  };
  sessions.set(key, s);
  return s;
}

export interface AcquireOptions {
  /** 浏览器可执行文件；不传则 `findFullChromium()` */
  exe?: string;
  /** 无头启动（渲染 / 只读 cookie 用；登录窗默认有头） */
  headless?: boolean;
  /** 会话就绪后要导航到的 URL */
  url?: string;
  /** 导航后预置的 cookie（best-effort） */
  cookies?: Array<Record<string, unknown>>;
  /** **常驻**（登录窗这类用户在用的）：不参与 TTL 回收，也不在进程退出时被收掉 */
  pinned?: boolean;
  /**
   * `#488` 额外启动参数（**仅新建进程时生效**；复用已有浏览器时不重开进程 ⇒ 参数无效）。
   * 验证会话用它把窗口生在屏幕外（`--window-position=-3200,-2400`）——比 CDP
   * `Browser.setWindowBounds` 稳：后者依赖窗口已创建，常因时序拿不到 `windowId`。
   */
  extraArgs?: string[];
  /**
   * `#488` 导航后是否 `Page.bringToFront`（默认 **true** = 老行为，登录窗需要）。
   * 反爬重放 / 内嵌验证窗传 `false`：窗口在屏幕外，抢前台只会让它闪出来。
   */
  bringToFront?: boolean;
  /** `#710` 等调试端口的软上限（仅新建进程时生效；见 `spawnBrowser`） */
  startTimeoutMs?: number;
}

/**
 * 取会话，没有就拉起一只（可顺带导航 / 预置 cookie）。
 *
 * `reused` 的语义：**本次调用前该键已有在跑的浏览器**（前端用它区分「新开」与「回到原窗口」）。
 *
 * ★★ **同一会话键上的 `acquire` 必须串行**（用户 2026-10-15 实测：「打开登录窗口」提示失败、
 * 多次尝试才能打开）。真因：两个并发调用（如「打开登录窗口」与同键的内容页渲染会话，
 * `#453` 起登录窗与渲染**共用同一只浏览器、同一份 profile**）同时走到 `getSession() === null`
 * ⇒ **双双 `spawnBrowser` 同一个 `--user-data-dir`** ⇒ Chromium 的 profile 进程级单例锁把后来者
 * 顶掉（新进程立刻退出 / 调试端口永不就绪）⇒ `waitForDevToolsPort` 20s 超时 ⇒ 报「打开登录页失败」。
 * 第二次点击时第一只已经起来了（`getSession` 命中）⇒ 表现为「多试几次才能开」。
 *
 * 串行化 + 入口处的 `getSession` 复查 = 后来者直接复用前一只；下面的 `spawnBrowser` 失败分支
 * 再复查一次（覆盖「上一步刚被判死、其实已被别人拉起来」的窗口）。
 */
const acquireLocks = new Map<string, Promise<unknown>>();

export async function acquire(key: string, opts: AcquireOptions = {}): Promise<{ session: BrowserSession; reused: boolean }> {
  const prev = acquireLocks.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => acquireLocked(key, opts),
    () => acquireLocked(key, opts),
  );
  // 尾链只用于串行化：失败也不许把后续调用带崩
  acquireLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

async function acquireLocked(key: string, opts: AcquireOptions = {}): Promise<{ session: BrowserSession; reused: boolean }> {
  const profileDir = profileDirForKey(key);
  try {
    mkdirSync(profileDir, { recursive: true });
  } catch {
    /* 已存在 */
  }
  let s = await getSession(key);
  const reused = !!s;
  if (!s) {
    const exe = String(opts.exe ?? '').trim() || findFullChromium() || '';
    if (!exe) throw new Error('未找到可用的完整浏览器（Chrome/Chromium/Edge）；可设 YUEDU_CHROMIUM_PATH_FULL 指定');
    /**
     * `#514` **context 模式**（`#525` 10-23 起默认开）：渲染类会话不再各起一只 Chromium，
     * 而是挂在共享宿主下、按源开一个 `BrowserContext`（cookie/storage 隔离）。
     * 见 `browserContextMode()` 的收益/代价说明。
     */
    if (browserContextMode() && isContextKey(key, opts)) {
      const host = await acquireHostBrowser(exe);
      const cdp = await CdpClient.connect(host.wsUrl);
      let contextId = '';
      try {
        const r = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext');
        contextId = r.browserContextId;
      } finally {
        cdp.close();
      }
      s = {
        key,
        url: '',
        exe,
        port: host.port,
        wsPath: host.wsPath,
        wsUrl: host.wsUrl,
        profileDir,
        startedAt: Date.now(),
        // 不 pin：渲染会话该被 TTL 回收（回收时只 disposeContext，不动宿主进程）
        pinned: false,
        headless: true,
        lastUsedAt: Date.now(),
        browserContextId: contextId,
      };
      sessions.set(key, s);
      // `#515` 先把上次落盘的 cookie 灌回这个新 context（在 finishAcquire 导航之前）
      await restoreContextCookies(s);
      return finishAcquire(s, reused, opts);
    }
    let l: { child: ChildProcess; port: number; wsPath: string };
    try {
      l = await spawnBrowser(exe, profileDir, {
        headless: opts.headless === true,
        ...(opts.extraArgs?.length ? { extraArgs: opts.extraArgs } : {}),
        ...(opts.startTimeoutMs ? { startTimeoutMs: opts.startTimeoutMs } : {}),
      });
    } catch (e) {
      // 并发/上一只正在退出时 profile 被占用 ⇒ 复查一次：别人已经拉起来了就直接复用
      const again = await getSession(key);
      if (!again) throw e;
      return finishAcquire(again, reused, opts);
    }
    s = {
      key,
      url: '',
      exe,
      port: l.port,
      wsPath: l.wsPath,
      wsUrl: `ws://127.0.0.1:${l.port}${l.wsPath}`,
      profileDir,
      child: l.child,
      startedAt: Date.now(),
      pinned: opts.pinned === true,
      headless: opts.headless === true,
      lastUsedAt: Date.now(),
    };
    sessions.set(key, s);
    /**
     * `#663` **浏览器意外退出必须留痕并清掉会话**。
     *
     * 用户实测 Aff：「chromium 突然关闭」，而日志里此前刷了一屏
     * `CDP Input.dispatchMouseEvent 超时`（每次 10s）。原因之一就是**没人监听进程退出**：
     * 浏览器死了，`sessions` 里那条记录还在，后续每条 CDP 命令都要白等满 10s 才失败，
     * 浮层表现为「点了没反应」。
     *
     * 这里只做两件事：打一行带 code/signal 的日志、把会话从表里摘掉（profile 保留，
     * 下次拉起还能带着登录态/clearance）。真正的清理仍交给 `killSession`。
     */
    s.child?.on('exit', (code, signal) => {
      void (async () => {
        const cur = sessions.get(key);
        if (cur !== s) return; // 已经被正常回收/替换
        /**
         * `#666` **先确认真死，再清会话**（`#663` 在这里栽过）。
         *
         * Windows 上 `chrome.exe` 经常只是**启动器**：把页面交给「同 profile 的已有实例」后
         * 自己立刻 `code=0` 退出，浏览器本体还在。旧实现一看到 exit 就 `sessions.delete(key)`,
         * 于是每次渲染后被误判成「浏览器退出」⇒ 下一次请求冷启动（`调试端口超时`）+
         * **没有 clearance** ⇒ 正文 403（用户日志里那串 `浏览器进程退出（code=0 signal=null）`
         * 之后紧跟 403，就是这条误判）。
         *
         * 判据只看**调试端口**：还活着 ⇒ 浏览器没死，忽略这次 exit（只留 debug 日志）。
         */
        const alive = await cdpAlive(s.port).catch(() => false);
        if (alive) {
          if (process.env['YUEDU_TABS_DEBUG']) {
            console.log(`[yuedu] 启动器进程退出（code=${String(code)}）但调试端口仍在线 ⇒ 忽略：${key}`);
          }
          return;
        }
        sessions.delete(key);
        console.warn(
          `[yuedu] 浏览器进程退出（code=${String(code)} signal=${String(signal)}，端口已关）⇒ 清理会话 ${key}（profile 保留）`,
        );
      })();
    });
  }
  return finishAcquire(s, reused, opts);
}

/** `acquireLocked` 的后半段：导航 / 预置 cookie（拆出来供「失败后复查复用」那条分支共用） */
async function finishAcquire(
  session: BrowserSession,
  reused: boolean,
  opts: AcquireOptions,
): Promise<{ session: BrowserSession; reused: boolean }> {
  const s = session;
  s.pinned = s.pinned || opts.pinned === true;
  s.lastUsedAt = Date.now();

  const url = String(opts.url ?? '').trim();
  if (url) {
    s.url = url;
    await withPageSession(
      s,
      async (cdp, sid, created) => {
        if (created) return;
        const nav = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sid);
        if (nav.errorText) {
          console.warn(`[yuedu] 导航被拒（${nav.errorText}），改为新开标签打开：${url}`);
          const c = await cdp.send<{ targetId: string }>('Target.createTarget', { url });
          s!.pageTargetId = c.targetId;
          return;
        }
        try {
          /**
           * `#488` **默认才抢前台**：`Page.bringToFront` 会把窗口带到前台 —— 登录窗
           * （用户要看着操作）需要它；而**反爬重放 / 内嵌验证窗**不需要（画面经
           * screencast 推给前端，窗口本就该在屏幕外）⇒ 调用方传 `bringToFront:false` 关掉。
           * 之前是无条件执行，这就是「弹一下又关 / 窗口反复弹出」的直接原因。
           */
          if (opts.bringToFront !== false) await cdp.send('Page.bringToFront', {}, sid);
        } catch {
          /* 部分版本无此命令，忽略 */
        }
      },
      { createUrl: url },
    );
    // 首次启动 Chromium 会自带一个 about:blank 空标签，收掉（用户只该看到目标页）
    await closeBlankTabs(s).catch(() => undefined);
  }
  if (opts.cookies?.length) {
    try {
      await setCookiesViaCdp(s, opts.cookies);
    } catch {
      /* 预置失败不影响打开窗口 */
    }
  }
  return { session: s, reused };
}

/**
 * 拉起一只**临时**实例（不进会话表 ⇒ 不出现在「窗口是否开着」的判定里）。
 * 用途：窗口已关时用同一 profile 补读一次持久 cookie。
 */
export async function openTemp(profileDir: string, opts: { headless?: boolean } = {}): Promise<BrowserSession> {
  const exe = findFullChromium() || '';
  const l = await spawnBrowser(exe, profileDir, { headless: opts.headless !== false });
  return {
    key: 'temp',
    url: '',
    exe,
    port: l.port,
    wsPath: l.wsPath,
    wsUrl: `ws://127.0.0.1:${l.port}${l.wsPath}`,
    profileDir,
    child: l.child,
    startedAt: Date.now(),
    pinned: false,
    headless: true,
    lastUsedAt: Date.now(),
  };
}

/** 关掉并忘掉某会话（profile 默认保留） */
export async function release(key: string, opts: { keepProfile?: boolean } = {}): Promise<void> {
  const s = sessions.get(key) ?? (await getSession(key));
  if (!s) return;
  sessions.delete(key);
  await killSession(s, { keepProfile: opts.keepProfile !== false });
}

/** 内存里活着的会话数（渲染器 `layer()` 用） */
export function liveSessionCount(): number {
  return sessions.size;
}

/** 该键当前是否持有会话（内存态，供同步判据用） */
export function hasLiveSession(key: string): boolean {
  return sessions.has(key);
}

/** 常驻（登录窗）会话的键列表 */
export function pinnedSessionKeys(): string[] {
  return [...sessions.values()].filter((s) => s.pinned).map((s) => s.key);
}

/**
 * 回收「闲着」的**非常驻**会话（TTL 默认 5min）。
 *
 * 为什么必须回收：渲染会话是**无头**的，用完不关就会在用户机器上留下常驻进程（还占着 profile 锁）。
 * 常驻（`pinned`，即登录窗）**不回收** —— 用户可能正在里面做验证。
 */
export async function idleReap(ttlMs = 5 * 60_000): Promise<number> {
  const now = Date.now();
  let n = 0;
  for (const [key, s] of [...sessions.entries()]) {
    if (s.pinned) continue;
    if (now - s.lastUsedAt < ttlMs) continue;
    sessions.delete(key);
    n += 1;
    await killSession(s, { keepProfile: true });
  }
  return n;
}

/** 刷新某会话的「最近使用」时刻（ antibot 重放不经过 `acquire`，得手动续期） */
export function touchSession(key: string): void {
  const s = sessions.get(key);
  if (s) s.lastUsedAt = Date.now();
}

/**
 * `#490` **反爬/验证会话的长 TTL 回收**（连 `pinned` 一起收）。
 *
 * 用户口径（2026-10-17）：「过了验证、cookie 也拿到了，后续就不该再触发验证；我都转到其他源
 * 开始阅读了，这只 Chromium 还在」—— 留着它的唯一价值是「同一只浏览器 + 同一份会话 ⇒ 后续
 * 渲染不再人工过验证」，但用户离开后继续占着进程没有意义。
 *
 * 为什么不用 `idleReap` 直接收： antibot/验证会话是 `pinned:true` 的（防 5min TTL 把进程杀掉
 * 导致 `cf_clearance` 这类**会话级** cookie 丢失、又要重新人工过验证）⇒ 需要一条**更长**的
 * 兜底：`#660` 从 **3min 调到 30min** —— 用户实测「还在浏览该源的发现页，chromium 自己关了」
 * （3 分钟没请求就回收），再点一次又要重新拉起（`浏览器未在预期时间内开启调试端口` ⇒ 正文 403）。
 * 过盾成本远高于占一只浏览器：宁可多留 30 分钟，也不要让用户反复重新过闸。
 * TTL 到了就 `release`（杀进程、**保留 profile** ⇒ 重新拉起时登录态/持久 cookie 还在）。
 *
 * ⚠️ 判「闲置」用的是 `lastUsedAt`，而 antibot 重放**不经过 acquire** ⇒ 调用方每次重放前要
 * `touchSession`（见 `index.ts` 的 antibotReplay），否则连着读书也会被误回收。
 */
export async function idleReapPinned(ttlMs = 30 * 60_000): Promise<number> {
  const now = Date.now();
  let n = 0;
  for (const [key, s] of [...sessions.entries()]) {
    if (!s.pinned) continue;
    if (now - s.lastUsedAt < ttlMs) continue;
    sessions.delete(key);
    n += 1;
    await killSession(s, { keepProfile: true });
    console.log(`[yuedu] 反爬/验证会话闲置超过 ${Math.round(ttlMs / 1000)}s ⇒ 已回收（保留 profile）：${key}`);
  }
  return n;
}

/** 启动 TTL 回收（幂等；`unref` 过 ⇒ 不会拖住进程退出） */
let reaperStarted = false;
export function startIdleReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  const t = setInterval(() => {
    void idleReap().catch(() => undefined);
    // `#490` 反爬/验证会话（pinned）的长 TTL 兜底：用户切走后不该一直开着
    void idleReapPinned().catch(() => undefined);
  }, 60_000);
  t.unref?.();
}

// 进程退出只回收**临时**会话（同步 kill；登录窗要留给用户，服务重启后靠接管继续用）
process.on('exit', () => {
  for (const s of sessions.values()) {
    if (s.pinned) continue;
    try {
      s.child?.kill();
    } catch {
      /* ignore */
    }
  }
});

startIdleReaper();

/**
 * 渲染层（L3:常驻）：用**该源已有的浏览器会话**打开页面、可选注入 JS / 拦子资源。
 *
 * 没有会话就返回 `''`（由 renderer 回落到 playwright ⇒ L2 ⇒ L1）——**绝不**在这里新建浏览器，
 * 否则每个源都会凭空多出一只常驻进程。
 *
 * `#459` 两条硬约束（都不是可选项）：
 *  ① 渲染走**自己的 tab**（`renderTargetId`），**不碰** `pageTargetId` —— 那是用户在登录窗里
 *     看的标签页，渲染把它导航走就等于「用户开着登录窗，点别的源，登录页被顶掉」。
 *  ② 渲染有**调用方预算**（`RENDER_BUDGET_MS`，8s）：到点返回 `''` + 关掉渲染 tab。
 *     旧实现 25s 且无上限，引擎 12s 早已放弃、它却还占着 CDP 与同键队列位。
 */
export interface SessionRenderOptions {
  js?: string;
  sourceRegex?: string;
  delayMs?: number;
  sourceId?: string;
  /** `#459` 调用方预算（缺省 `RENDER_BUDGET_MS`）：到点即放弃并回落下一层 */
  timeoutMs?: number;
  /**
   * `#481` **渲染 tab 带到前台**：后台 tab 会被 Chrome 节流（timer throttling）——
   * Cloudflare 的 JS 挑战恰恰靠 timer 驱动，后台跑会显著变慢甚至挂起。
   * 「过验证」场景（antibotReplay）传 true：用户也能亲眼看到挑战进度。
   */
  activate?: boolean;
  /**
   * `#659` **允许复用/驱动「用户可见的那个标签页」**（过闸场景专用，`antibotPassPage` 传 true）。
   *
   * 只读复用（同 URL）永远生效；这里是「同源但不同 URL」时**把可见页导航过去**——
   * 因为那只页正是过了闸的上下文，而新开 tab 一导航就被 CF 再挑战一次
   * （用户实测 138阅读网/Aff：chromium 明明加载了详情页，我们却取到 challenge）。
   * 普通渲染（webRenderer）不传 ⇒ 保持 `#459`「不抢用户正在看的标签」的原行为。
   */
  preferVisible?: boolean;
  /**
   * `#668` 「用可见页导航后，最多等多久挑战自己过去」（默认 12s）。
   * 已清关的 host 常 1~2s 就出内容 ⇒ 调用方传 6s 即可，避免用户体感「每次都慢一拍」。
   */
  settleMs?: number;
  /**
   * `#731` **没有活会话时必须建一个**（`java.startBrowserAwait` / `webView` 的取页语义）。
   *
   * 旧实现无会话直接 `return ''` ⇒ 脚本拿到空正文，静默走失败分支，用户只看到
   * 「验证会话已结束或浏览器不可用」。`kind:'cookie'` 通路传 true：
   *  · 建不出来 ⇒ **抛明确错误**（`无法创建验证会话：<原因>`），不再让空串冒充成功；
   *  · 中途会话死亡 ⇒ **抛「验证会话已结束：<原因>」**。
   */
  ensureSession?: boolean;
  /**
   * 过闸重放专用：目标不是 HTML 页面（`.js` / `.json` 等）时返回**响应原文**，
   * 而不是浏览器给文本资源包的那层「阅读器 DOM」。原因见 `readRawTextDocument`。
   */
  rawText?: boolean;
}

/** 同一键上的渲染串行化（同一只浏览器上并发渲染会互相踩；详见 `renderInSession` 的 tab 策略） */
const renderQueue = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = renderQueue.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  renderQueue.set(
    key,
    next.catch(() => undefined).then(() => {
      if (renderQueue.get(key) === next) renderQueue.delete(key);
    }),
  );
  return next;
}

/**
 * `#459` 渲染的**调用方预算**：超过就立刻放弃并回落下一层。
 *
 * 为什么从 25s 收到 8s：渲染是引擎某次动作里的**一个环节**，而那次动作的护栏超时只有 12s
 * （`core/net/traffic.ts` 的 `instant.timeoutMs`）。旧值 25s 意味着「引擎早就放弃了，渲染还占着
 * CDP 连接与同键队列位 25 秒」—— 连续几次就把服务端拖到 ping 不通（用户报的「服务状态卡离线」）。
 * 8s 是「本层最多花多久」（`waitForLoad` / `delayMs` 都受它约束）。
 */
const RENDER_BUDGET_MS = 8_000;

/** 渲染专用 tab 的创建（`background` 不被支持时回落普通创建）；`#459` 见 `renderTargetId` 的说明 */
async function createRenderTarget(s: BrowserSession, cdp: CdpClient, url: string, activate = false): Promise<string> {
  /**
   * `#665` pinned 会话**复用**上一次的渲染 tab（因为 `closeRenderTarget` 对它不关页了）。
   * 不这样做就会「每渲染一次多一个 tab」（长阅读几百章 = 几百个 tab）。
   */
  if (s.pinned && s.renderTargetId) {
    try {
      if (await targetAlive(cdp, s.renderTargetId)) {
        const att = await cdp.send<{ sessionId?: string }>('Target.attachToTarget', {
          targetId: s.renderTargetId,
          flatten: true,
        });
        if (att.sessionId) {
          await cdp.send('Page.navigate', { url }, att.sessionId).catch(() => undefined);
          await cdp.send('Target.detachFromTarget', { sessionId: att.sessionId }).catch(() => undefined);
          return s.renderTargetId;
        }
      }
    } catch {
      /* 复用失败 ⇒ 走新建 */
    }
  }
  try {
    const c = await cdp.send<{ targetId: string }>(
      'Target.createTarget',
      targetParams(s, { url, background: !activate }),
    );
    if (activate) await cdp.send('Target.activateTarget', { targetId: c.targetId }).catch(() => undefined);
    return c.targetId;
  } catch {
    const c = await cdp.send<{ targetId: string }>('Target.createTarget', targetParams(s, { url }));
    return c.targetId;
  }
}

async function runtimeEval(cdp: CdpClient, sid: string, expression: string): Promise<string> {  const r = await cdp.send<{ result?: { value?: unknown; description?: string } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  );
  const v = r.result?.value;
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return r.result?.description ?? '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 浏览器打开 `.js` / `.json` 这类**非 HTML 资源**时，会自动包一层「文本阅读器」文档：
 *   `<html><head><meta name="color-scheme" content="light dark"></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">…源码…</pre></body></html>`
 *
 * 过闸重放（`antibotPassPage`）若把这层 DOM 当响应正文交回引擎，脚本拿到的是 HTML ⇒
 * 预编译报 `Unexpected token '<'`（MYCOMIC / Komiic / 热辣漫画 三个源实测），
 * 且 HTML 会被写进 jsLib 镜像与持久层，污染后续所有请求。
 *
 * 这里按 `document.contentType` 判断「非 HTML 文本资源」，再用页面内 `fetch().text()` 取
 * **响应原文**（按响应头 charset 解码、缺省 UTF-8，与 Legado 的 strResponse 口径一致；
 * 直接读 `<pre>` 文本会踩 Chrome 对无 charset 脚本的本地编码猜测，中文变乱码）。
 *
 * @returns 非 HTML 文本资源的原文；HTML 页面 / 取不到时返回 `''`（调用方走原逻辑）
 */
export function isNonHtmlTextContentType(contentType: string): boolean {
  const ct = String(contentType ?? '').toLowerCase();
  if (!ct || ct.includes('html')) return false;
  return /^(text\/|application\/(json|javascript|ecmascript|x-javascript|graphql|xml))/.test(ct);
}

async function readRawTextDocument(cdp: CdpClient, sid: string): Promise<string> {
  let contentType = '';
  try {
    contentType = await runtimeEval(cdp, sid, "String(document.contentType||'')");
  } catch {
    return '';
  }
  if (!isNonHtmlTextContentType(contentType)) return '';
  try {
    return await runtimeEval(
      cdp,
      sid,
      "fetch(location.href,{cache:'force-cache'}).then(function(r){return r.text()}).catch(function(){return String((document.documentElement&&document.documentElement.textContent)||'')})",
    );
  } catch {
    return '';
  }
}

/** 等页面加载完（轮询 `readyState`；`Runtime.evaluate` 在加载中不应答，所以只能轮询） */
async function waitForLoad(cdp: CdpClient, sid: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await runtimeEval(cdp, sid, 'document.readyState');
      if (st === 'complete') return;
    } catch {
      /* 页面还在切，重试 */
    }
    await sleep(200);
  }
}

/** 该页面已加载的子资源 URL（`sourceRegex` 拦截没命中时的兜底） */
async function loadedResourceUrls(cdp: CdpClient, sid: string): Promise<string[]> {
  try {
    const joined = await runtimeEval(
      cdp,
      sid,
      "Array.from(performance.getEntriesByType('resource')).map(function(e){return e.name}).join('\\n')",
    );
    return joined ? joined.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * `#659` **两个 URL 是不是「同一页」**（用于判断可见标签页能否直接复用）。
 *
 * 只比 `origin + pathname`，忽略查询串/哈希/末尾斜杠：站点常用 `?page=1`、`#content` 这类
 * 装饰；把查询串也算进判据会让「刚过闸的详情页」被判不同 ⇒ 又去新开 tab 导航。
 */
/**
 * `#661`/`#662` **挑战页判据 = core 的 `isChallengePage`（唯一实现）**。
 *
 * 本文件原先自带一份正则（`#661`），与 `core/diag/self-fetch` 的签名表**必然漂移**：
 * `#662` 实测那次漂移的后果是 —— 84KB/200KB 的**真页**因为脚本里带 `challenge-platform` /
 * `ddos-guard` 被判成「拦截页」，于是每次取页都先去「过闸」（用户看到的刷屏与反复弹窗）。
 * core 那份现在带**体积门**（这类泛化特征只在小页上算），这里直接复用，不再维护第二份。
 */
function isChallengeHtml(html: string): boolean {
  return isChallengePage(html).challenge;
}

function samePageUrl(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      const x = new URL(u);
      return `${x.origin}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return '';
    }
  };
  const na = norm(a);
  const nb = norm(b);
  return !!na && na === nb;
}

/**
 * `#659` **先读「用户眼前那个页面」**（`pageTargetId`），读得到就不新开 tab。
 *
 * ## 为什么（用户实测 138阅读网 / Aff）
 * 日志里同时出现两件事：验证浮层里 **chromium 已经把详情页/目录页渲染出来了**，
 * 而我们的 `[hub] antibot-replay 渲染后仍是挑战页 / 无结果`。原因在 `#459` 的设计：
 * 渲染固定**新开一个渲染 tab**（`createRenderTarget`）再 `Page.navigate` —— 用户过闸的是
 * `pageTargetId` 那个页，新 tab 一导航，Cloudflare 又给一次「Just a moment」
 * ⇒ 明明已经加载好的内容，我们一次都没读过。
 *
 * ## 边界（宁可不用，也不要读错）
 *  · 只在**没有要求注入 js** 时复用（`opts.js` 的调用方要的是执行结果，不是 DOM）；
 *  · 可见页的 `location.href` 必须与目标**同源同路径**（`samePageUrl`）；
 *  · 内容长度 < 500 或就是挑战页 ⇒ 不复用（交给原路径，调用方自己还有一层判据）；
 *  · 全程只读（attach → Runtime.evaluate → detach），不导航、不改页面。
 */
async function readVisiblePage(
  s: BrowserSession,
  cdp: CdpClient,
  url: string,
  wantJs: boolean,
  preferVisible = false,
  settleMs = 12_000,
  rawText = false,
): Promise<string> {
  if (wantJs || !s.pageTargetId) return '';
  let sid = '';
  try {
    const att = await cdp.send<{ sessionId?: string }>('Target.attachToTarget', {
      targetId: s.pageTargetId,
      flatten: true,
    });
    sid = att.sessionId ?? '';
    if (!sid) return '';
    const probe = await runtimeEval(
      cdp,
      sid,
      "JSON.stringify({href:String(location.href),len:document.documentElement?document.documentElement.outerHTML.length:0})",
    );
    let p: { href?: string; len?: number } = {};
    try {
      p = JSON.parse(probe || '{}') as { href?: string; len?: number };
    } catch {
      return '';
    }
    const href = String(p.href ?? '');
    const len = Number(p.len ?? 0);
    let html = '';
    if (samePageUrl(href, url) && len >= 500) {
      html = await runtimeEval(cdp, sid, 'document.documentElement.outerHTML');
      if (html.length >= 500 && !isChallengeHtml(html)) {
        console.log(`[render] 复用可见标签页（已加载 ${html.length} 字节，免导航）：${url.slice(0, 100)}`);
        if (rawText) {
          const raw = await readRawTextDocument(cdp, sid);
          if (raw) return raw;
        }
        return html;
      }
      if (isChallengeHtml(html)) {
        // 可见页自己就是挑战页 ⇒ 不能复用（否则上层把挑战页当真页，列表恒 0）
        console.warn(`[render] 可见标签页仍是挑战页（${html.length} 字节）⇒ 不复用：${url.slice(0, 90)}`);
      }
    }
    /**
     * `#659` **同源不同 URL**：把可见页导航过去（它就是过了闸的那只上下文）。
     * 前提是当前页**不是**挑战页（否则说明闸还没过，导航过去只会更糟）。
     */
    if (!preferVisible || len < 500) return '';
    try {
      if (new URL(href).origin !== new URL(url).origin) return '';
    } catch {
      return '';
    }
    html = await runtimeEval(cdp, sid, 'document.documentElement.outerHTML');
    if (html.length < 500 || /just a moment|cf_chl|challenge-platform|checking your browser/i.test(html.slice(0, 4000))) {
      return '';
    }
    await cdp.send('Page.navigate', { url }, sid);
    const settleBudget = Math.max(2000, settleMs);
    await waitForLoad(cdp, sid, Math.min(15_000, settleBudget + 3000)).catch(() => undefined);
    await sleep(600);
    /**
     * `#661` **导航后等挑战自己过去**：真浏览器里 CF 的 JS 挑战通常 2~8s 自己放行，
     * 旧实现固定等 600ms 就 dump ⇒ 取到的是 `Just a moment` 空壳（列表 0 条 / 详情 0 章）。
     * 轮询判据与 `verification.ts` 的探针一致：内容不再是挑战页且 ≥500 字节。
     */
    // 上限来自调用方（默认 12s；已清关 host 传 6s）——外层 guard 仍按预算兜底
    const settleDeadline = Date.now() + settleBudget;
    let out = '';
    for (;;) {
      out = await runtimeEval(cdp, sid, 'document.documentElement.outerHTML');
      if (out.length >= 500 && !isChallengeHtml(out)) break;
      if (Date.now() >= settleDeadline) {
        console.warn(`[render] 可见页导航后仍是挑战/空壳（${out.length} 字节）⇒ 放弃复用：${url.slice(0, 90)}`);
        return '';
      }
      await sleep(700);
    }
    console.log(`[render] 用可见标签页导航取页（${out.length} 字节，免开新 tab）：${url.slice(0, 100)}`);
    if (rawText) {
      const raw = await readRawTextDocument(cdp, sid);
      if (raw) return raw;
    }
    return out;
  } catch {
    return '';
  } finally {
    if (sid) await cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => undefined);
  }
}

async function renderInSession(s: BrowserSession, url: string, opts: SessionRenderOptions): Promise<string> {
  const budget = Math.max(1000, opts.timeoutMs ?? RENDER_BUDGET_MS);
  const deadline = Date.now() + budget;
  const cdp = await CdpClient.connect(s.wsUrl);
  let targetId = '';
  /** 关掉渲染专用 tab（超时/结束时都走这里）：`Target.closeTarget` 会连带停掉还在跑的加载 */
  const closeRenderTarget = async (): Promise<void> => {
    if (!targetId) return;
    const id = targetId;
    targetId = '';
    if (s.renderTargetId === id) delete s.renderTargetId;
    /**
     * `#665` **pinned（过闸/验证）会话不关渲染 tab**。
     *
     * 用户实测 138阅读网：每次正文之后都出现
     * `[yuedu] 浏览器进程退出（code=0 signal=null）` —— **正常退出**，即「最后一个标签页被关掉」。
     * 关 tab 的两条收尾路径（关渲染 tab / 清空白 tab）在并发下会把页关到一个不剩，
     * Chromium 随即自行退出；下一次请求要冷启动（`浏览器未在预期时间内开启调试端口`），
     * 而冷启动的浏览器**没有 clearance** ⇒ 正文 403 —— 正好对上用户的症状。
     *
     * 过闸会话是「重开代价最高」的那一只（要人再过一次闸），所以对它**只清登记、不关页**：
     * 多留一个 tab 的成本远低于让用户重新过闸。
     */
    if (s.pinned) {
      if (process.env['YUEDU_TABS_DEBUG']) console.log('[tabs] pinned 会话保留渲染 tab（不关，避免浏览器空标签退出）');
      return;
    }
    try {
      /**
       * ★★ `#483`：关之前先确认「关完还有标签页」——渲染 tab 常常是**唯一**的标签页，
       * 一关 Chromium 就整只退出（⇒ 下一次反爬重放又要重新拉起浏览器，用户看到反复弹窗）。
       * 与 `closeBlankTabs` 同一条纪律：常驻会话必须始终留至少一个标签页。
       */
      const r = await cdp.send<{
        targetInfos?: Array<{ targetId: string; type: string; browserContextId?: string }>;
      }>('Target.getTargets');
      // `#514` 同 context 口径（避免把别的源的标签算成自己的）
      const pages = (r.targetInfos ?? []).filter(
        (t) => t.type === 'page' && (s.browserContextId ? t.browserContextId === s.browserContextId : true),
      );
      if (process.env['YUEDU_TABS_DEBUG']) {
        const allPages = (r.targetInfos ?? []).filter((t) => t.type === 'page');
        console.log(
          `[tabs] close id=${id.slice(0, 8)} scoped=${pages.length} all=${allPages.length} ctx=${String(s.browserContextId ?? '(默认)')}`,
        );
      }
      if (pages.length <= 1) {
        await cdp.send('Target.createTarget', targetParams(s, { url: 'about:blank' })).catch(() => undefined);
      }
      const cr = await cdp.send<{ success?: boolean }>('Target.closeTarget', { targetId: id });
      if (process.env['YUEDU_TABS_DEBUG']) console.log(`[tabs] closeTarget ${id.slice(0, 8)} → success=${String(cr?.success)}`);
      /**
       * `#664` **关完再核一次「还有没有页」**。
       *
       * 用户实测：`[yuedu] 浏览器进程退出（code=0 signal=null）` —— **正常退出**（不是崩溃）。
       * 根因是两条收尾路径**并发**：`closeRenderTarget`（关渲染 tab）与 `closeBlankTabs`
       * （清空白 tab）各自看到「还有 2 个页」都判断可以关，结果各关一个 ⇒ 一个不剩 ⇒
       * Chromium 在空标签时会自己退出（code=0）。随后所有 CDP 命令白等 10s。
       * 这里关完补一次探测：没有 page 就补一个 `about:blank`。
       */
      try {
        const after = await cdp.send<{ targetInfos?: Array<{ type: string; browserContextId?: string }> }>('Target.getTargets');
        const pagesLeft = (after.targetInfos ?? []).filter(
          (t) => t.type === 'page' && (s.browserContextId ? t.browserContextId === s.browserContextId : true),
        );
        if (pagesLeft.length === 0) {
          await cdp.send('Target.createTarget', targetParams(s, { url: 'about:blank' })).catch(() => undefined);
          console.warn('[yuedu] 关 tab 后已无页面（会触发 Chromium 退出）⇒ 已补一个 about:blank 保住会话');
        }
      } catch {
        /* 探测失败不影响收尾 */
      }
    } catch {
      /* 已经没了 */
    }
  };
  /** 从「建 tab」到「取 DOM」的**全部**步骤（连 CDP 命令一起受预算约束，见下面的 guard） */
  const run = async (): Promise<string> => {
    /**
     * `#659` **能复用就不开新 tab**：用户过闸后可见页里就是目标页时，直接读它。
     * 见 `readVisiblePage` 的注释（新 tab 一导航就又被 CF 挑战，是「明明加载了却取不到」的真因）。
     */
    const reused = await readVisiblePage(
      s,
      cdp,
      url,
      !!opts.js,
      opts.preferVisible === true,
      opts.settleMs ?? 12_000,
      opts.rawText === true,
    );
    if (reused) return reused;
    // `#459`：**渲染专用 tab**（不再复用 `s.pageTargetId`）—— 旧实现会把用户正在看的
    // 登录页标签导航走（表现：用户开着登录窗点别的源，登录页被顶掉）
    targetId = await createRenderTarget(s, cdp, url, opts.activate === true);
    s.renderTargetId = targetId;
    const att = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const sid = att.sessionId;
    // `#526` P1-1b 指纹第二层（渲染 tab 也要：站点正是在这一步做 bot 判定）
    await installPageStealth(s, cdp, targetId, sid);
    // `#465` 跳转拦截（渲染 tab 同装：过闸途中被跳走 = 丢会话）
    await installNavGuard(s, cdp, sid);

    let re: RegExp | null = null;
    if (opts.sourceRegex) {
      try {
        re = new RegExp(opts.sourceRegex);
      } catch {
        re = null;
      }
    }
    const hits: string[] = [];
    // 订阅必须**早于**导航（否则子资源请求早已发出）
    const unsub = re
      ? cdp.subscribe('Network.requestWillBeSent', (params, evSid) => {
          if (evSid && evSid !== sid) return;
          const u = (params as { request?: { url?: unknown } } | undefined)?.request?.url;
          if (typeof u === 'string' && re && re.test(u) && hits.length < 50) hits.push(u);
        })
      : () => {};
    try {
      await cdp.send('Network.enable', {}, sid).catch(() => undefined);
      await waitForLoad(cdp, sid, Math.max(1000, deadline - Date.now()));
      if (opts.js) {
        const v = await runtimeEval(cdp, sid, opts.js);
        if (v) return v;
      }
      // `delayMs` 同样受本层预算约束（旧实现给到 10s ⇒ 单独就能撑爆调用方）
      if (opts.delayMs && opts.delayMs > 0) await sleep(Math.min(opts.delayMs, Math.max(0, deadline - Date.now())));
      /**
       * 非 HTML 资源（`.js` / `.json`）尽早取原文：它的 outerHTML 是阅读器包装，
       * 继续走下面的「挑战页 / 空壳」判据只会误判（脚本文本里出现 `challenge-platform`
       * 之类的字符串就会被当成盾），而且调用方要的本来就不是 DOM。
       */
      if (opts.rawText) {
        const raw = await readRawTextDocument(cdp, sid);
        if (raw) {
          console.log(`[render] 非 HTML 文档，返回响应原文（${raw.length} 字符）：${url.slice(0, 100)}`);
          return raw;
        }
      }
      if (re) {
        const first = hits[0] ?? (await loadedResourceUrls(cdp, sid)).find((u) => re && re.test(u));
        return first ?? '';
      }
      /**
       * `#661` **空壳 DOM（<500 字节）不算成功**：实测 Aff 的 story 页渲染回来是
       * `<html><head></head><body></body></html>`（**39 字节**），上层当成「渲染成功」
       * ⇒ 详情 0 章 / 列表 0 条，且没有任何错误可查。
       * 处理：补一次等待再取；仍空壳 ⇒ 返回 `''`，交给调用方的重试/降级（`antibotPassPage`
       * 本来就有 `tooSmall` 复查与 6.5s 重试，`#565`）。
       */
      let out = await runtimeEval(cdp, sid, 'document.documentElement.outerHTML');
      /**
       * `#664` **挑战页也算失败**（不只是空壳）。
       *
       * 实测 138阅读网：`webRenderer` 在会话存在时会先走 L3 渲染 tab，新 tab 导航**必被挑战**
       * （clearance 是可见页那只的），拿回 2.4KB 的 `Just a moment` —— 旧实现照原样返回，
       * 上层判「撞盾」再触发一次有头重放 ⇒ **每个章节都要渲染两次**（Web 端慢的主因之一）。
       * 现在这里返回 `''`，让分层渲染器继续走到上层重放（只走一次会话取页）。
       */
      if (out.length >= 500 && isChallengeHtml(out)) {
        await sleep(1200);
        const again2 = await runtimeEval(cdp, sid, 'document.documentElement.outerHTML');
        if (again2.length > out.length) out = again2;
        if (isChallengeHtml(out)) {
          console.warn(`[render] 渲染 tab 只拿到挑战页（${out.length} 字节）⇒ 视为失败（避免二次渲染）：${url.slice(0, 90)}`);
          return '';
        }
      }
      if (out.length < 500) {
        await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
        const again = await runtimeEval(cdp, sid, 'document.documentElement.outerHTML');
        if (again.length > out.length) out = again;
        if (out.length < 500) {
          console.warn(`[render] 渲染结果过短（${out.length} 字节，疑似空壳）⇒ 视为失败，交调用方重试：${url.slice(0, 90)}`);
          return '';
        }
      }
      if (opts.rawText) {
        const raw = await readRawTextDocument(cdp, sid);
        if (raw) {
          console.log(`[render] 非 HTML 文档，返回响应原文（${raw.length} 字符）：${url.slice(0, 100)}`);
          return raw;
        }
      }
      return out;
    } finally {
      unsub();
    }
  };
  try {
    // `#459` 硬预算：到点就返回 `''`（调用方立刻回落下一层），不等页面（或某条卡住的 CDP 命令）慢完。
    // 超时分支走下面 `finally` 的 `closeRenderTarget()` ⇒ tab 一关，还在跑的加载一并停掉，
    // 不再占着 CDP 连接与同键队列位（旧实现正是这样把服务端拖到 ping 不通的）。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    });
    try {
      const out = await Promise.race([run(), guard]);
      return out ?? '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    await closeRenderTarget();
    cdp.close();
  }
}

/**
 * 用该源（或匿名）的**已有**浏览器会话渲染页面。
 * @returns 渲染结果；**没有会话 / 失败**时返回 `''` ⇒ 调用方回落下一层。
 */
/**
 * `#676` **载入给定 HTML、以 baseUrl 为 origin 执行 JS、返回 JS 的结果**
 * （上游 `JsExtensions.webView(html, url, js)` 的宿主实现）。
 *
 * 三段 CDP，缺一不可：
 *   ① `Target.createTarget(baseUrl)` → 新 tab **先真导航到站点**（拿到 origin）；
 *      ⚠️ 不导航的话文档 origin 是 null，源脚本里的**相对路径 XHR**（`xhr.open('POST','/conapi.php')`）
 *      会被浏览器直接拒发 —— 这正是爱看吧「html 给了、脚本也跑了、结果空」的原因。
 *   ② `Page.setDocumentContent(frameId, html)` → 用源给的 html 覆盖文档（保留 origin）；
 *   ③ `Runtime.evaluate(js, { returnByValue: true, awaitPromise: true })` → 取**脚本返回值**。
 *
 * 与 `render()` 的区别：`render()` 是「给个 URL、要渲染后的 DOM」；这里是「给文档、要脚本输出」。
 * 爱看吧这类源（`res = java.webView(html, baseUrl, script)`）只能走后者。
 */
export async function renderHtmlScript(
  html: string,
  baseUrl: string,
  js: string,
  opts: { sourceId: string; timeoutMs?: number },
): Promise<string> {
  const key = sessionKeyOf(opts.sourceId);
  let s = await getSession(key);
  if (!s) {
    try {
      // 无头 + 不抢前台（这是后台取数据，不该在屏幕上闪一个窗口）
      s = (await acquire(key, { headless: true, bringToFront: false })).session;
    } catch (e) {
      console.warn(`[webview] 开浏览器失败：${e instanceof Error ? e.message : String(e)}`);
      return '';
    }
  }
  const session = s;
  session.lastUsedAt = Date.now();
  const budget = Math.max(3000, opts.timeoutMs ?? 25_000);
  return enqueue(key, async () => {
    const cdp = await CdpClient.connect(session.wsUrl);
    const created = await cdp.send<{ targetId?: string }>(
      'Target.createTarget',
      targetParams(session, { url: baseUrl || 'about:blank' }),
    );
    const tid = created.targetId ?? '';
    if (!tid) return '';
    const att = await cdp.send<{ sessionId?: string }>('Target.attachToTarget', { targetId: tid, flatten: true });
    const sid = att.sessionId ?? '';
    if (!sid) {
      await cdp.send('Target.closeTarget', { targetId: tid }).catch(() => undefined);
      return '';
    }
    try {
      if (baseUrl) await waitForLoad(cdp, sid, Math.min(10_000, budget)).catch(() => undefined);
      const tree = await cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree', {}, sid);
      const frameId = tree.frameTree?.frame?.id ?? '';
      if (!frameId) {
        console.warn('[webview] 拿不到 frameId ⇒ 放弃（页面可能已崩）');
        return '';
      }
      await cdp.send('Page.setDocumentContent', { frameId, html }, sid);
      await new Promise((r) => setTimeout(r, 250));
      const ev = await cdp.send<{
        result?: { value?: unknown; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, sid);
      if (ev.exceptionDetails) {
        const msg = ev.exceptionDetails.exception?.description ?? ev.exceptionDetails.text ?? '脚本抛错';
        console.warn(`[webview] 脚本执行异常：${String(msg).slice(0, 200)}`);
        return `ERR:${String(msg).slice(0, 200)}`;
      }
      const v = ev.result?.value;
      if (v == null) return ev.result?.description === 'undefined' ? '' : String(ev.result?.description ?? '');
      return typeof v === 'string' ? v : String(v);
    } catch (e) {
      console.warn(`[webview] 执行失败：${e instanceof Error ? e.message : String(e)}`);
      return '';
    } finally {
      await cdp.send('Target.closeTarget', { targetId: tid }).catch(() => undefined);
      try {
        cdp.close();
      } catch {
        /* 已断开 */
      }
    }
  });
}

export async function render(url: string, opts: SessionRenderOptions = {}): Promise<string> {
  const key = sessionKeyOf(opts.sourceId);
  let s = await getSession(key);
  /**
   * `#731` `ensureSession`（`kind:'cookie'`）**不能拿空串冒充成功**：
   * 无会话就按需拉起一只（有头 + 屏幕外，与验证/过闸同一只、同一份 profile），
   * 建不出来就抛出带原因的错误，让脚本/前端看到「建不出会话」而不是「正文是空的」。
   */
  if (!s && opts.ensureSession) {
    try {
      const r = await acquire(key, {
        headless: false,
        pinned: true,
        bringToFront: false,
        extraArgs: ['--window-position=-3200,-2400'],
        startTimeoutMs: 15_000,
      });
      s = r.session;
      console.log(`[yuedu] 渲染按需拉起会话（ensureSession，reused=${r.reused} port=${s.port}）：${key}`);
    } catch (e) {
      throw new Error(`无法创建验证会话：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!s) return '';
  s.lastUsedAt = Date.now();
  try {
    const html = await enqueue(key, () => renderInSession(s, url, opts));
    /**
     * `#661` **受控快照**（只在 `YUEDU_DUMP_RENDER=1` 时落盘）：排查「渲染拿到了，但列表 0 条」时，
     * 需要看清拿到的到底是真页面还是别的页（登录墙/挑战页/空壳）。默认零开销、不写盘。
     */
    if (html && process.env['YUEDU_DUMP_RENDER']) {
      try {
        const dir = join(process.cwd(), 'tmp', 'render-dump');
        mkdirSync(dir, { recursive: true });
        const safe = url.replace(/[^\w.-]+/g, '_').slice(0, 80);
        writeFileSync(join(dir, `${Date.now()}-${safe}.html`), html, 'utf-8');
      } catch {
        /* 落盘失败不影响渲染 */
      }
    }
    /**
     * `#731` 断点 3 的最后一截：`ensureSession` 语义是「这次必须由我建会话并取到页」，
     * 空壳/挑战页/预算超时都会让 `renderInSession` 回 `''` —— 这里**必须**抛错，
     * 否则 `java.startBrowserAwait` 又拿空串静默走失败分支（用户只看到「会话已结束」）。
     */
    if (!html && opts.ensureSession) {
      throw new Error(`验证会话已取到空页面（可能仍在挑战/加载或已超时）：${url}`);
    }
    return html;
  } catch (e) {
    /**
     * `#731` 会话中途死亡（CDP 断开 / 页面崩）必须**报「已结束」**，而不是退回空串：
     * 空串会让脚本把「浏览器没了」当成「页面没有内容」。
     */
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.ensureSession) {
      // 已在上面明确分类的错误原样抛出，不二次包装成「会话已结束」
      if (/^(无法创建验证会话|验证会话已取到空页面|验证会话已结束)：/.test(msg)) throw e;
      throw new Error(`验证会话已结束：${msg}`);
    }
    return '';
  }
}
