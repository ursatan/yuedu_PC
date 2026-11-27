/**
 * 无头渲染（core 层，供各引擎复用）——Legado Android WebView 的**零依赖替代**。
 *
 * 为什么需要两套：
 *  - **同步**（本文件 `syncRenderHtml`）：L1 进程内求值路径（`java.webView(...)` 在脚本里是
 *    同步语义，同 `syncHttp` 用 curl 的道理）——用 execFileSync 调本机 Chromium `--dump-dom`。
 *  - **异步**（宿主 `EngineContext.webRenderer`）：worker 池路径与请求构造路径（可 await），
 *    由 app 层注入（apps/server/src/renderer.ts 的分层渲染器）。
 *
 * 覆盖范围与缺口（对齐 Legado 语义）：
 *  - ✅ `java.webView(url)` / `startBrowserAwait(url)`：取 JS 执行后的 DOM
 *  - ✅ `java.webViewGetSource(html,url,js,sourceRegex)`：降级实现——渲染 url 后在 DOM 里
 *       按 `sourceRegex` 找绝对 URL（Legado 是拦截**子资源请求**，需 CDP，见 app 层 L3）
 *  - ❌ `,{"webJs":"…"}`（页面内注入 JS 取返回值）：dump-dom 无法注入 → 需 L3（playwright-core）
 */
import { spawn, spawnSync } from 'node:child_process';
import { recordBlock } from '../diag/block-stats';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 常见本机 Chromium 位置（Windows / macOS / Linux + Playwright 下载目录） */
/**
 * 「完整浏览器」探测（交互式登录用）——**必须整只浏览器**：
 * `chrome-headless-shell` 无法开有头窗口供人工登录。
 * 顺序：Playwright 完整 Chromium → 系统 Chrome → Edge。
 */
export function findFullChromium(): string | null {
  const fromEnv = process.env.YUEDU_CHROMIUM_PATH_FULL ?? process.env.YUEDU_CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv) && !/headless[-_]shell/i.test(fromEnv)) return fromEnv;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const bases = [join(home, 'AppData/Local/ms-playwright'), join(home, '.cache/ms-playwright')];
  const fullSubs = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    // chromium-1234（完整版）——排除 chromium_headless_shell-*
    const fulls = readdirSync(base).filter((d) => d.startsWith('chromium-') && !d.includes('headless')).sort().reverse();
    for (const ver of fulls) for (const sub of fullSubs) {
      const p = join(base, ver, sub);
      if (existsSync(p)) return p;
    }
  }
  const direct = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const p of direct) if (existsSync(p)) return p;
  return null;
}

export function findChromium(): string | null {
  const fromEnv = process.env.YUEDU_CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  // 优先 Playwright 下载的纯净 Chromium（无 Edge/系统配置干扰，启动更快），再系统 Chrome / Edge
  const bases = [join(home, 'AppData/Local/ms-playwright'), join(home, '.cache/ms-playwright')];
  // ① chrome-headless-shell（专为无头设计：直接 --dump-dom，进程干净，实测 3-6s）
  const shellSubs = ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-linux/headless_shell', 'chrome-mac/chrome-headless-shell'];
  // ② 完整 Chromium（需 --headless=old 才输出 dump-dom）
  const fullSubs = [
    'chrome-win64/chrome.exe',
    'chrome-win/chrome.exe',
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const entries = readdirSync(base);
    const shells = entries.filter((d) => d.includes('headless_shell')).sort().reverse();
    for (const ver of shells) for (const sub of shellSubs) {
      const p = join(base, ver, sub);
      if (existsSync(p)) return p;
    }
    const fulls = entries.filter((d) => d.startsWith('chromium-') && !d.includes('headless')).sort().reverse();
    for (const ver of fulls) for (const sub of fullSubs) {
      const p = join(base, ver, sub);
      if (existsSync(p)) return p;
    }
  }
  const direct = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const p of direct) if (existsSync(p)) return p;
  return null;
}

/** 是否 chrome-headless-shell（本身即无头，不能再传 --headless=old，否则不输出） */
export function isHeadlessShell(exe: string): boolean {
  return /headless[-_]shell/i.test(exe);
}

/** 统一构造 `--dump-dom` 参数（sync/async 两层共用，避免参数漂移） */
export function buildDumpDomArgs(exe: string, opts: { profileDir: string }): string[] {
  const args = [
    // 完整 Chrome/Chromium 必须用 old headless 才输出 dump-dom；headless-shell 不需要该开关
    ...(isHeadlessShell(exe) ? [] : ['--headless=old']),
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--user-data-dir=${opts.profileDir}`,
  ];
  // ⚠️ 不加 `--virtual-time-budget`：实测在 **hash 路由的 SPA**（如 http://host/#/path）上会返回空 DOM
  //    （2026-09-14 复现：root/budget0 ✅ · root/budget5000 ✅ · hash/budget0 ✅ · hash/budget5000 ❌）。
  //    需要「等 JS 跑更久」的场景属 L3（CDP 渲染）职责，不在 dump-dom 层模拟。
  args.push('--dump-dom');
  return args;
}

export interface SyncRenderOptions {
  /** 让页面 JS 跑完的虚拟时间预算（ms），默认 6000 */
  budgetMs?: number;
  /** 硬超时（ms），默认 25000 */
  timeoutMs?: number;
  /** 子资源 URL 正则（Legado sourceRegex）：在渲染后的 DOM 里找匹配的绝对 URL 返回 */
  sourceRegex?: string;
}

/**
 * `#198` **非阻塞清理 Chromium profile 目录**。
 *
 * ## 为什么不能直接 `rmSync(recursive: true)`（这是本条最硬的实测发现）
 * 删一个刚跑过的 Chromium profile（Windows 上**几千个文件**）实测阻塞 **18360ms** ——
 * 比 `spawnSync` 本身（8896ms）**还严重一倍**，而且两者是**叠加**的
 * （实测 `渲染 + rmSync` = 21360ms 阻塞，而只渲染 = 1080ms）。
 *
 * ★★ `#194` 当年只埋了 `render-spawnSync`（spawnSync 那一段），**没包住 finally 里的
 *   `rmSync`** ⇒ 诊断时完全看不到这 18 秒。这是本条最重要的一条教训：
 *   **埋点必须覆盖「清理」这类收尾动作**，否则最慢的一段永远是隐形的。
 *
 * ## 做法
 * 走 `rmdir /s /q`（Windows）/ `rm -rf`（POSIX）子进程 —— **不阻塞事件循环**。
 * 失败（句柄占用 / 权限）**静默忽略**：临时目录留着，总比把服务卡死强。
 * 埋点 `render-cleanup` 只记「发起清理」的耗时（子进程本身在后台跑完）。
 */
function cleanupProfileAsync(profile: string): void {
  const startedAt = Date.now();
  const isWin = process.platform === 'win32';
  try {
    const child = spawn(isWin ? 'cmd' : 'rm', isWin ? ['/c', 'rmdir', '/s', '/q', profile] : ['-rf', profile], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {
      /* ignore：临时目录留着即可 */
    });
    child.unref();
  } catch {
    /* ignore */
  }
  recordBlock('render-cleanup', Date.now() - startedAt, profile);
}

/**
 * 同步渲染（⚠️ 阻塞事件循环，仅用于 L1 脚本内同步语义）。
 * 实测要点（Windows / chromium_headless_shell 1234，2026-09-14）：
 *  · 只用 `chrome-headless-shell`（或完整 Chromium 的 `--headless=old`）——`--headless=new` 的 `--dump-dom` 恒空；
 *  · stderr 必须保持 pipe（设为 ignore 时 Chromium 会提前退出、stdout 变空）；
 *  · 不能用 `--virtual-time-budget`（hash 路由 SPA 上返回空），需要等待请用 L3 CDP 层。
 */
/**
 * `#198` **异步渲染 + 串行化**（`spawn`，不阻塞事件循环）。
 *
 * ## 为什么要有这个
 * `syncRenderHtml` 用 `spawnSync` 起 Chromium —— 整段进程生命周期（实测单次 **8896ms**）
 * **完全阻塞** Node 事件循环，阻塞窗口内**任何**请求都进不来（连探活都不行）
 * ⇒ 批量跑源时表现为「服务端假死 / 拒绝新连接」（`#194` 的 `render-spawnSync` 埋点）。
 *
 * ## 为什么**串行**而不是放开并发
 * Chromium `--dump-dom` 每个实例要吃几百 MB；并发 4~8 个会直接把内存打满，
 * 反而更慢、更容易整体失稳。**排队是这里的最优解**：吞吐不变，事件循环始终可响应。
 * 排队深度 `MAX_QUEUE`：超了直接返回空串（调用方会走静态抓取兜底），
 * 不无限堆积 —— 否则「请求越慢排队越长 ⇒ 内存越涨」是个正反馈。
 *
 * ## 与同步版的关系
 * 两条路**并存**（`syncRenderHtml` 保留给显式 `YUEDU_SYNC_RENDER=1` 的老行为与单测）。
 * 生产路径（宿主 `apps/server/src/renderer.ts`）用的是它自己的 `execFile` 版，
 * 本函数是给「core 层需要自己渲染」的场景用的**非阻塞替代**。
 */
const RENDER_QUEUE_MAX = 4;
let renderQueueLen = 0;

export async function asyncRenderHtml(url: string, opts: SyncRenderOptions = {}): Promise<string> {
  const exe = findChromium();
  if (!exe) return '';
  if (renderQueueLen >= RENDER_QUEUE_MAX) {
    // 队列已满：**不硬塞**。返回空串让调用方回落静态抓取（铁律 3：兜底要留痕）
    recordBlock('render-queue-full', 0, url);
    return '';
  }
  renderQueueLen += 1;
  const profile = mkdtempSync(join(tmpdir(), 'yuedu-cr-async-'));
  const startedAt = Date.now();
  try {
    const html = await new Promise<string>((resolve) => {
      const child = spawn(exe, [...buildDumpDomArgs(exe, { profileDir: profile }), url], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const out: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => {
        out.push(d);
        // 体积护栏：与同步版的 maxBuffer 同量级，防一个畸形页面把内存吃光
        if (out.reduce((n, b2) => n + b2.length, 0) > 64 * 1024 * 1024) child.kill();
      });
      // stderr 保持 pipe（实测：设 ignore 会让 Chromium 提前退出、stdout 变空）
      child.stderr.resume();
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 25_000);
      const done = (): void => {
        clearTimeout(timer);
        // Chromium 常以非零码退出但 stdout 是完整 DOM —— 不能因退出码丢结果
        resolve(Buffer.concat(out).toString('utf-8'));
      };
      child.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.on('close', done);
    });
    if (opts.sourceRegex) {
      try {
        const m = new RegExp(opts.sourceRegex).exec(html);
        if (m) return m[0];
      } catch {
        /* 正则非法 → 原样返回 */
      }
    }
    return html;
  } finally {
    renderQueueLen -= 1;
    // ★ `#198`：同步删 profile 会阻塞 18s（实测），改走子进程异步清理
    cleanupProfileAsync(profile);
    recordBlock('render-async', Date.now() - startedAt, url);
  }
}

export function syncRenderHtml(url: string, opts: SyncRenderOptions = {}): string {
  const exe = findChromium();
  if (!exe) return '';
  const profile = mkdtempSync(join(tmpdir(), 'yuedu-cr-sync-'));
  // spawnSync：Chromium 常以非零码退出但 stdout 是完整 DOM —— 不能因退出码丢结果
  const runOnce = (): string => {
    // ⚠️ 必须保留 stderr 为 pipe：把 stderr 设为 ignore 会让 Chromium 提前退出（实测 stdout 变空）
    const startedAt = Date.now();
    try {
      const r = spawnSync(exe, [...buildDumpDomArgs(exe, { profileDir: profile }), url], {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 25_000,
        windowsHide: true,
      });
      return String(r.stdout ?? '');
    } finally {
      // 埋点：spawnSync 是**同步**的，整段 Chromium 生命周期都会阻塞事件循环（可达数十秒）
      recordBlock('render-spawnSync', Date.now() - startedAt, url);
    }
  };
  let out = '';
  try {
    out = runOnce();
  } finally {
    // ★ `#198`：同步删 profile 会阻塞 18s（实测 18360ms，比 spawnSync 本身还久一倍）⇒ 改异步
    cleanupProfileAsync(profile);
  }
  const html = out;
  if (opts.sourceRegex) {
    try {
      const m = new RegExp(opts.sourceRegex).exec(html);
      if (m) return m[0];
    } catch {
      /* 正则非法 → 原样返回 */
    }
  }
  return html;
}

/** 渲染层可用性描述（诊断用） */
export function renderLayerInfo(): string {
  const exe = findChromium();
  return exe ? `无头 Chromium：${exe}` : '无头 Chromium：未找到（java.webView 将退化为静态抓取）';
}
