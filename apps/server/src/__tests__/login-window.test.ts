/**
 * 登录窗口的**浏览器端到端回归锁**（本机没有完整 Chromium 时自动跳过）。
 *
 * 锁的是用户实测报过的四条，都属「生命周期 / 读写耦合 / 浏览器行为」类，纯单测锁不住：
 *  ① **harvest 不许关窗**：旧实现 harvest 的 finally 里关窗，而前端每 5s 轮询一次 harvest
 *     → 窗口开 5 秒就被关掉，用户来不及做完安全验证（腾讯漫画实测：12 个进程 → 0 个）。
 *  ② **页面必须真的是登录页**：命令行 `--new-window <url>` 在本机 Chromium 上不生效，
 *     CDP 侧那个 target 停在 `about:blank`（用户看到「登录页会自动打开 about:blank」；
 *     因为停在 about:blank，cookie 也恒为 0）。
 *  ③ **标签数不累加**：服务重启后内存里的 `pageTargetId` 会丢，不认领已有标签就会每点一次开一个
 *     （用户看到「打开时会有多个标签页」）。
 *  ④ **关窗不丢登录态**：profile 持久化 → 关窗后仍能用同一 profile 补读到**持久 cookie**。
 *
 * 不用外网站点：本地起一个只做两件事的 HTTP 服务（返回登录页 + Set-Cookie），
 * 不依赖网络、结果确定。用无头模式跑，避免测试时弹窗干扰用户。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findFullChromium } from '@yuedu/core';
import {
  browserProfileDir,
  clearLoginBrowserData,
  closeLoginWindow,
  harvestLoginCookies,
  loginWindowStatus,
  openLoginWindow,
  setBrowserProfileRoot,
} from '../browser-login';

const hasBrowser = !!findFullChromium();
const testOpts: { skip?: string } = hasBrowser
  ? {}
  : { skip: '本机没有完整 Chromium（findFullChromium 返回 null），跳过浏览器端到端' };

/** 本地“登录站点”：/login 返回一个会写持久 cookie 的页面 */
async function startSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/login')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // 关键：带 Max-Age → **持久 cookie**（关窗后仍在磁盘 profile 里）
        'set-cookie': ['sid=SESSION-42; Path=/; Max-Age=3600', 'theme=dark; Path=/; Max-Age=3600'],
      });
      res.end('<html><body><h1>登录页</h1><p>请在窗口里完成登录</p></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, origin: `http://127.0.0.1:${port}` };
}

interface CdpMsg {
  id?: number;
  result?: {
    targetInfos?: Array<{ targetId: string; type: string; url: string }>;
    sessionId?: string;
    result?: { value?: unknown; description?: string };
  };
}

/**
 * 直连 profile 的 browser WS，看**页面标签实况**（数量 + 实际 href）。
 *
 * ⚠️ 两个实测坑（不加就会让整轮测试挂死而不是给出失败）：
 *  · 每个 CDP 命令必须有**超时**；
 *  · `Runtime.evaluate` 在**页面还在加载时不会应答**（实测打开后立刻调 → 5s 超时；等 3s → 13ms 返回），
 *    所以要**重试**而不是一次定生死。
 */
async function pageTargets(profileDir: string): Promise<Array<{ id: string; href: string }>> {
  const attempt = async (): Promise<Array<{ id: string; href: string }>> => {
    const lines = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf-8').split(/\r?\n/);
    const ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]?.trim() ?? ''}`);
    let seq = 0;
    const pend = new Map<number, (m: CdpMsg) => void>();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as CdpMsg;
      if (m.id && pend.has(m.id)) {
        pend.get(m.id)?.(m);
        pend.delete(m.id);
      }
    });
    const call = (method: string, params: Record<string, unknown> = {}, sid?: string): Promise<CdpMsg> =>
      new Promise((res, rej) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pend.delete(id);
          rej(new Error(`CDP ${method} 超时`));
        }, 4000);
        pend.set(id, (m) => {
          clearTimeout(timer);
          res(m);
        });
        ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
      });
    try {
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 4000);
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          res();
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          rej(new Error('CDP 连接失败'));
        });
      });
      const out: Array<{ id: string; href: string }> = [];
      const tg = await call('Target.getTargets');
      for (const t of (tg.result?.targetInfos ?? []).filter((x) => x.type === 'page')) {
        const att = await call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const rr = await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, att.result?.sessionId ?? '');
        out.push({ id: t.targetId.slice(0, 8), href: String(rr.result?.result?.value ?? '?') });
      }
      return out;
    } finally {
      ws.close();
    }
  };

  let last: Error | null = null;
  for (let i = 0; i < 6; i++) {
    try {
      return await attempt();
    } catch (e) {
      last = e as Error;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last ?? new Error('读取页面标签失败');
}

test('登录窗口：harvest 只读不关窗 + 页面真到登录页 + 标签不累加 + 关窗仍能补读 cookie', testOpts, async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuedu-login-e2e-'));
  setBrowserProfileRoot(root);
  const sourceId = 'e2e-login-window';
  const { server, origin } = await startSite();
  const loginUrl = `${origin}/login`;

  try {
    // ① 打开窗口（无头，避免弹窗干扰）
    const o = await openLoginWindow({ sourceId, url: loginUrl, headless: true });
    assert.equal(o.ok, true, `打开登录窗口失败：${o.ok ? '' : o.error}`);
    assert.equal(o.ok && o.reused, false, '首次打开不应是复用');

    const st1 = await loginWindowStatus(sourceId);
    assert.equal(st1.open, true, '打开后状态应为 open');
    assert.equal(st1.hasProfile, true, 'profile 目录应已建立');
    const profileDir = browserProfileDir(sourceId);
    assert.ok(existsSync(profileDir), 'profile 目录必须存在');

    // ② ★回归锁：页面必须真的到了登录页，且只有一个标签（旧实现停在 about:blank）
    const tabs1 = await pageTargets(profileDir);
    assert.equal(tabs1.length, 1, `登录窗口应只有 1 个标签，实际 ${JSON.stringify(tabs1)}`);
    assert.equal(tabs1[0]?.href, loginUrl, `页面必须导航到登录页（旧实现停在 about:blank）：${JSON.stringify(tabs1)}`);

    // ③ profile 必须**关掉“恢复上次会话”**（否则硬杀后下次启动会把历史标签全恢复出来）
    const pref = JSON.parse(readFileSync(join(profileDir, 'Default', 'Preferences'), 'utf-8')) as {
      profile?: { exit_type?: string };
      session?: { restore_on_startup?: number };
    };
    assert.equal(pref.profile?.exit_type, 'Normal', 'Preferences 必须标记为正常退出（不弹恢复气泡）');
    assert.equal(pref.session?.restore_on_startup, 5, '必须关掉「恢复上次会话」（5 = 新标签页）');

    // ④ 读 cookie：站点写入的两条都要拿到（cookie 是页面写的 → 同时也证明页面真加载了）
    const h1 = await harvestLoginCookies(sourceId, ['127.0.0.1']);
    assert.equal(h1.ok, true, `harvest 失败：${h1.ok ? '' : h1.error}`);
    const names = h1.ok ? h1.cookies.map((c) => c.name).sort() : [];
    assert.deepEqual(names, ['sid', 'theme'], `应读到站点写入的两条 cookie，实际 ${JSON.stringify(names)}`);

    // ⑤ ★回归锁：harvest 之后窗口必须**仍然开着**（旧实现在这里把浏览器关掉了）
    assert.equal((await loginWindowStatus(sourceId)).open, true, 'harvest 不得关闭登录窗口');

    // ⑥ 反复 harvest 仍只读不关（前端 5s 轮询就是这个节奏）
    const h2 = await harvestLoginCookies(sourceId, ['127.0.0.1']);
    assert.equal(h2.ok, true);
    assert.equal((await loginWindowStatus(sourceId)).open, true, '反复 harvest 也不得关窗');

    // ⑦ ★回归锁：再点一次「打开登录窗口」不得新增标签（旧实现每次开一个）
    const o2 = await openLoginWindow({ sourceId, url: loginUrl, headless: true });
    assert.equal(o2.ok, true, `复用打开失败：${o2.ok ? '' : o2.error}`);
    assert.equal(o2.ok && o2.reused, true, '第二次打开应当是复用');
    const tabs2 = await pageTargets(profileDir);
    assert.equal(tabs2.length, 1, `复用打开不得新增标签，实际 ${JSON.stringify(tabs2)}`);
    assert.equal(tabs2[0]?.href, loginUrl, '复用后仍应停在登录页');

    // ⑧ 显式关窗：窗口关掉、profile 保留
    await closeLoginWindow(sourceId);
    const st3 = await loginWindowStatus(sourceId);
    assert.equal(st3.open, false, '显式关窗后状态应为 closed');
    assert.equal(st3.hasProfile, true, '关窗后 profile 必须保留（登录态才不丢）');
    assert.ok(existsSync(profileDir), '关窗不得删除 profile 目录');

    // ⑨ 关窗后 harvest：用同一 profile 起无头实例补读 → 持久 cookie 还能拿回来
    const h3 = await harvestLoginCookies(sourceId, ['127.0.0.1']);
    assert.equal(h3.ok, true, `关窗后补读失败：${h3.ok ? '' : h3.error}`);
    assert.equal(h3.ok && h3.fromProfile, true, '关窗后的补读应标记 fromProfile');
    assert.deepEqual(
      h3.ok ? h3.cookies.map((c) => c.name).sort() : [],
      ['sid', 'theme'],
      '持久 cookie（带 Max-Age）关窗后必须仍在磁盘 profile 里',
    );
    assert.equal((await loginWindowStatus(sourceId)).open, false, '补读用的无头实例用完必须关掉，不能算“窗口开着”');

    // ⑩ 关窗后重开：仍复用同一 profile（登录态在），且仍是 1 个标签
    const o3 = await openLoginWindow({ sourceId, url: loginUrl, headless: true });
    assert.equal(o3.ok, true, `复开失败：${o3.ok ? '' : o3.error}`);
    const tabs3 = await pageTargets(profileDir);
    assert.equal(tabs3.length, 1, `关窗重开后应仍是 1 个标签，实际 ${JSON.stringify(tabs3)}`);
    assert.equal(tabs3[0]?.href, loginUrl, '关窗重开后应停在登录页');
    const after = await harvestLoginCookies(sourceId, ['127.0.0.1']);
    assert.deepEqual(
      after.ok ? after.cookies.map((c) => c.name).sort() : [],
      ['sid', 'theme'],
      '复开必须沿用同一 profile（登录态还在）',
    );

    // ⑪ 清除浏览器数据：profile 目录被删；之后再 harvest 给出明确错误（而不是静默空）
    assert.equal(await clearLoginBrowserData(sourceId), true, '清除浏览器数据应返回 removed=true');
    assert.equal(existsSync(profileDir), false, 'profile 目录应被删除');
    const h4 = await harvestLoginCookies(sourceId, ['127.0.0.1']);
    assert.equal(h4.ok, false, '没有 profile 时 harvest 必须明确报错');
    assert.match(h4.ok ? '' : h4.error, /登录窗口|登录数据/, `错误文案要可行动，实际：${h4.ok ? '' : h4.error}`);
  } finally {
    await closeLoginWindow(sourceId).catch(() => undefined);
    // 必须收掉残留连接再 close：Chromium 的 keep-alive 会让 server.close() 一直等（整轮测试挂死）
    server.closeAllConnections?.();
    server.close();
    server.unref();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 句柄占用忽略 */
    }
  }
});
