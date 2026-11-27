/**
 * 交互式登录窗口（人工/安全验证 → Cookie 自动回传）
 *
 * 为什么需要它：`loginUrl` 里 52 个源是**登录页链接**（还有 42 个脚本内部 `startBrowserAwait`），
 * 这些登录要么要人工输验证码，要么整页 JS 只有真浏览器跑得起来 —— 服务端渲染（headless
 * `--dump-dom`）只能取静态内容，cookie 也回不来。
 *
 * 做法（**零 npm 依赖**）：在本机拉起一只**有头 Chromium**（每个源一个**独立持久 profile**，
 * 不碰用户日常浏览器），开 `--remote-debugging-port=0`，用 CDP 直连：
 *   1. 打开登录页，交给用户人工完成登录/验证码；
 *   2. 读 Cookie 走**页面会话** → 按登录域名 + 站点域名过滤 → 写进该源的 CookieStore + 登录头；
 *      **harvest 只读、不关窗**；
 *   3. 关窗 = 销毁 Chromium 进程，但 **profile 留在磁盘**：重开即复用（登录态还在）、
 *      窗口已关也能用同一 profile 起无头实例补抓一次。
 *
 * ★ `#453`（D13 = A+B）后，本文件是 `browser-session.ts` 的**薄封装**：CDP 客户端 / 接管 /
 *   profile / 生命周期全部搬去了那边（登录窗与内容页渲染**共用同一只浏览器、同一份 cookie**
 *   才是这一期要的东西）。这里只保留**登录专属语义**（三条实测坑，别再踩）：
 *   a. 页面必须由 `Target.createTarget({url})` 打开（命令行 `--new-window <url>` 在本机 Chromium 上不生效）；
 *   b. 读 cookie 必须在 page 会话里（browser target 上没有 Network 域）；
 *   c. **harvest 不许顺手关窗**（前端每 5s 轮询一次；读写与生命周期必须解耦）；
 *   d. 关窗**保留 profile**（持久 cookie 在磁盘上，重开即复用）。
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findFullChromium, pickLoginCookies } from '@yuedu/core';
import {
  acquire,
  browserProfileDir,
  getSession,
  killSession,
  openTemp,
  pinnedSessionKeys,
  readCookiesViaCdp,
  release,
  sessionKeyOf,
  setBrowserProfileRoot,
  type BrowserSession,
} from './browser-session';

export interface LoginCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

// 这两个是**给旧调用点/回归测试的兼容出口**（实现已迁到 browser-session，语义不变）
export { browserProfileDir, setBrowserProfileRoot };

/**
 * 打开交互式登录窗口。
 * 同一源重复调用：已有在跑的浏览器 → **复用**（导航到目标 URL / 把窗口拉到前台），不重开新进程。
 */
export async function openLoginWindow(opts: {
  sourceId: string;
  url: string;
  /** 预置 cookie（可选，例如源里已导入过） */
  cookies?: Array<{ name: string; value: string; domain: string }>;
  /** 无头启动（CI / 无显示环境 / 自动化测试用；默认 false = 有头窗口） */
  headless?: boolean;
}): Promise<{ ok: true; url: string; exe: string; pid?: number; reused: boolean } | { ok: false; error: string }> {
  const exe = findFullChromium();
  if (!exe) {
    return { ok: false, error: '未找到可用的完整浏览器（Chrome/Chromium/Edge）；可设 YUEDU_CHROMIUM_PATH_FULL 指定' };
  }
  const url = String(opts.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: '登录地址无效（需要 http/https 链接）' };
  }
  try {
    const { session, reused } = await acquire(sessionKeyOf(opts.sourceId), {
      exe,
      headless: opts.headless === true,
      url,
      // 登录窗是**常驻**的：用户在里头做验证时不能被 TTL 回收 / 退出钩子收掉
      pinned: true,
      ...(opts.cookies?.length ? { cookies: opts.cookies } : {}),
    });
    return {
      ok: true,
      url: session.url,
      exe: session.exe,
      reused,
      ...(session.child?.pid ? { pid: session.child.pid } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes('调试端口') ? `浏览器调试端口未就绪：${msg}` : `打开登录页失败：${msg}` };
  }
}

/** 当前登录窗口状态（**按调试端口探活**判定，而不是 child.exitCode —— 复用的进程可能早已退出） */
export async function loginWindowStatus(
  sourceId: string,
): Promise<{ open: boolean; url?: string; startedAt?: number; hasProfile: boolean; profileDir: string }> {
  const profileDir = browserProfileDir(sourceId);
  // 原判据：profile 里已有 `Default`（登录数据）或 `DevToolsActivePort`（在跑的实例）
  const hasProfile = existsSync(join(profileDir, 'Default')) || existsSync(join(profileDir, 'DevToolsActivePort'));
  const s = await getSession(sessionKeyOf(sourceId));
  if (!s) return { open: false, hasProfile, profileDir };
  return { open: true, url: s.url, startedAt: s.startedAt, hasProfile, profileDir };
}

/**
 * 抓取窗口里的 cookie。**默认不关窗**（关窗只由 `{close:true}` 或 DELETE 端点触发）。
 * 过滤规则：域名后缀匹配（登录域名常与内容域名不同，如 account.qq.com vs ac.qq.com，故允许传多个 hosts）。
 * 窗口已关时：用**同一 profile** 起一只无头实例读一次（只能拿到**持久 cookie**；
 * 会话级 cookie 随进程消失 —— 所以“窗口开着时周期 harvest”仍是主路径）。
 */
export async function harvestLoginCookies(
  sourceId: string,
  hosts: string[],
  opts: { close?: boolean } = {},
): Promise<
  | { ok: true; cookies: LoginCookie[]; total: number; fromProfile?: boolean }
  | { ok: false; error: string }
> {
  const normalized = hosts.map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean);
  const key = sessionKeyOf(sourceId);
  let s = await getSession(key);
  let temp: BrowserSession | null = null;

  if (!s) {
    const exe = findFullChromium();
    if (!exe) return { ok: false, error: '未找到可用的完整浏览器（Chrome/Chromium/Edge）' };
    const profileDir = browserProfileDir(sourceId);
    if (!existsSync(profileDir)) {
      return { ok: false, error: '登录窗口未打开（或已关闭），且该源还没有浏览器登录数据 —— 请先点「打开登录窗口」完成登录' };
    }
    try {
      temp = await openTemp(profileDir, { headless: true });
      s = temp;
    } catch (e) {
      return { ok: false, error: `窗口已关闭；用该源的登录数据重开浏览器读 Cookie 失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const session = s;
  try {
    const all = await readCookiesViaCdp(session);
    // 域名筛选/同名去重是纯逻辑，放 core 便于单测（见 core/src/net/login-hosts.ts）
    const { picked } = pickLoginCookies(all, normalized);
    return { ok: true, cookies: picked, total: all.length, ...(temp ? { fromProfile: true } : {}) };
  } catch (e) {
    return { ok: false, error: `读取 Cookie 失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    if (temp) await killSession(temp, { keepProfile: true });
    if (opts.close) await closeLoginWindow(sourceId);
  }
}

/** 关闭登录窗口（**保留 profile**：登录态与持久 cookie 都在磁盘上，重开即复用） */
export async function closeLoginWindow(sourceId: string): Promise<void> {
  await release(sessionKeyOf(sourceId), { keepProfile: true });
}

/** 清除该源的浏览器登录数据（profile 目录整个删掉；下次要重新登录） */
export async function clearLoginBrowserData(sourceId: string): Promise<boolean> {
  await closeLoginWindow(sourceId);
  const dir = browserProfileDir(sourceId);
  if (!existsSync(dir)) return false;
  await new Promise((r) => setTimeout(r, 400));
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 显式关闭所有登录窗口。
 *
 * ⚠️ **不要挂在进程退出钩子上**：用户很可能正在窗口里做安全验证（扫码/短信），
 * 开发期一次服务重启就把窗口收掉，等于把用户输入毁掉。profile 是持久的，
 * 重启后 `getSession` 会按 `DevToolsActivePort` **重新接管**同一只浏览器，窗口继续可用。
 */
export function closeAllLoginWindows(): void {
  for (const key of pinnedSessionKeys()) void release(key, { keepProfile: true });
}
