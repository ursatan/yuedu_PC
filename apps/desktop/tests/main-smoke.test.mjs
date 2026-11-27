/**
 * `#209` 主进程冒烟：**用 Electron 桩**把 `main.js` 真跑一遍。
 *
 * ## 为什么需要它（而不是只靠真机自检）
 * 本机（Agent 沙箱）起不了 Electron（无桌面会话，进程秒退无输出），
 * 但「`main.js` 的模块体能不能跑完 / 启动链有没有走到 `createWindow` / IPC 通道注册了没」
 * 这些**不需要真窗口**就能判 —— 而且正是最容易出问题的地方：
 * `#209` 就在这里抓到 `registerRenderer()` **被调用但从未定义**（`git log -S` 确认自首次提交起），
 * 那句 `ReferenceError` 会把 `whenReady` 的启动链整条打断 ⇒ **桌面端根本打不开窗口**。
 *
 * ## 边界（别把绿当成端到端通过）
 * 桩证明的是「我们的调用序列与参数对」；**窗口真的画出来了 / 托盘真的在任务栏里 /
 * 快捷键真的被系统接受 / 注册表真的写进去了**，只有 `scripts/probe-209-desktop.mjs`
 * （真 Electron + 真注册表读取）与用户手工双击能证明。
 *
 * 跑法：`pnpm --filter @yuedu/desktop test`
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* =========================================================================
 * 桩：只实现 main.js 真正用到的那些面
 * ========================================================================= */

function makeElectronStub(ctx) {
  const handlers = new Map();
  const listeners = new Map();
  const windows = [];

  const push = (map, key, fn) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fn);
  };
  const makeEmitter = () => {
    const ls = new Map();
    return {
      _ls: ls,
      on(ev, fn) { push(ls, ev, fn); return this; },
      once(ev, fn) {
        const wrapped = (...a) => { this.off(ev, wrapped); fn(...a); };
        return this.on(ev, wrapped);
      },
      off(ev, fn) {
        const arr = ls.get(ev) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
        return this;
      },
      emit(ev, ...a) { for (const fn of [...(ls.get(ev) || [])]) fn(...a); },
    };
  };

  class FakeWebContents {
    constructor(win) {
      this.win = win;
      this.em = makeEmitter();
      this.sent = [];
    }
    on(...a) { this.em.on(...a); return this; }
    once(...a) { this.em.once(...a); return this; }
    off(...a) { this.em.off(...a); return this; }
    emit(...a) { this.em.emit(...a); }
    send(channel, ...args) {
      this.sent.push({ channel, args });
      ctx.sends.push({ channel, args });
    }
    setWindowOpenHandler() {}
    setUserAgent() {}
    executeJavaScript() { return Promise.resolve('<html></html>'); }
    getURL() { return this.win.url || 'about:blank'; }
    get session() { return {}; }
    // `#453` 内嵌 view 用到的面（渲染桥路径才会走到；桩测试里由新加的用例覆盖）
    loadURL(url) { this.win.url = url; return Promise.resolve(); }
    isDestroyed() { return false; }
    reload() { this.reloaded = true; }
    close() { this.closed = true; }
    /** 真实 Electron 在用 navigationHistory（32+）；桩返回 null ⇒ main.js 走旧 canGoBack 分支 */
    get navigationHistory() { return null; }
  }

  /**
   * `#453`：`WebContentsView` 的最小桩（真 Electron ≥30 才有）。
   * 与 BrowserWindow **分开**：view 不进 `windows` 列表，否则「正常启动应恰好 1 个窗口」那条会红。
   */
  class FakeWebContentsView {
    constructor(opts = {}) {
      this.opts = opts;
      this.webContents = new FakeWebContents({ url: '' });
      this.bounds = null;
      ctx.views.push(this);
    }
    setBounds(b) { this.bounds = b; }
    getBounds() { return this.bounds; }
  }

  class FakeBrowserWindow {
    constructor(opts = {}) {
      this.opts = opts;
      this.em = makeEmitter();
      this.webContents = new FakeWebContents(this);
      this._visible = !!opts.show;
      this._focused = opts.focusable === false ? false : true;
      this._bounds = {
        x: typeof opts.x === 'number' ? opts.x : 0,
        y: typeof opts.y === 'number' ? opts.y : 0,
        width: opts.width || 1280,
        height: opts.height || 860,
      };
      this.url = '';
      this.destroyed = false;
      windows.push(this);
      ctx.windows.push(this);
    }
    loadURL(url) {
      this.url = url;
      // 真实 Electron 在加载完成后发 ready-to-show；main.js 靠它 show()
      queueMicrotask(() => this.em.emit('ready-to-show'));
      return Promise.resolve();
    }
    /** 桌面歌词窗（透明置顶）：`main.js` 用 loadFile + did-finish-load */
    loadFile(p) {
      this.url = p;
      queueMicrotask(() => this.webContents.emit('did-finish-load'));
      return Promise.resolve();
    }
    show() { this._visible = true; this.em.emit('show'); }
    /** `showInactive()` 不抢焦点 —— 歌词窗必须走这条 */
    showInactive() { this._visible = true; this.em.emit('show'); }
    hide() { this._visible = false; this.em.emit('hide'); }
    isVisible() { return this._visible; }
    isMinimized() { return false; }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this._focused; }
    focus() { this._focused = true; this.em.emit('focus'); }
    blur() { this._focused = false; this.em.emit('blur'); }
    setAlwaysOnTop(v, level) { this._alwaysOnTop = { v: !!v, level: level || null }; }
    isFullScreen() { return this._fullscreen === true; }
    setFullScreen(v) { this._fullscreen = !!v; }
    setMinimumSize(w, h) { this._minSize = { width: w, height: h }; }
    setResizable(v) { this._resizable = !!v; }
    /** 点击穿透：`(ignore, {forward})` 两参都要记，断言「条形默认穿透、常规默认不穿透」 */
    setIgnoreMouseEvents(v, opts) { this._ignore = { v: !!v, opts: opts || null }; }
    isMaximized() { return this._maximized === true; }
    maximize() { this._maximized = true; }
    unmaximize() { this._maximized = false; }
    getBounds() { return { ...this._bounds }; }
    setBounds(b) {
      this._bounds = { ...b };
      this.em.emit('move');
    }
    getContentBounds() {
      return { x: 0, y: 0, width: this.opts.width || 1280, height: this.opts.height || 860 };
    }
    /** `#453`：WebContentsView 的父容器（addChildView / removeChildView） */
    get contentView() {
      if (!this._cv) {
        const children = [];
        this._cv = {
          children,
          addChildView(v) { if (!children.includes(v)) children.push(v); },
          removeChildView(v) { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
        };
      }
      return this._cv;
    }
    restore() {}
    destroy() { this.destroyed = true; this.em.emit('closed'); }
    on(...a) { this.em.on(...a); return this; }
    once(...a) { this.em.once(...a); return this; }
    emit(...a) { this.em.emit(...a); }
    static getAllWindows() { return windows.filter((w) => !w.destroyed); }
  }

  class FakeTray {
    constructor(image) {
      ctx.trayCreated = true;
      ctx.trayImage = image;
      this.em = makeEmitter();
    }
    setToolTip(t) { ctx.trayTooltip = t; }
    setContextMenu(menu) { ctx.trayMenu = menu; }
    on(...a) { this.em.on(...a); return this; }
    displayBalloon(b) { ctx.balloons.push(b); }
  }

  const app = {
    isPackaged: false,
    whenReady: () => ctx.ready,
    on(ev, fn) { push(listeners, ev, fn); return app; },
    emit(ev, ...a) { for (const fn of [...(listeners.get(ev) || [])]) fn(...a); },
    quit() {
      ctx.quitCalled = true;
      app.emit('before-quit');
      app.emit('will-quit');
    },
    getPath(name) { return ctx.paths[name] ?? ctx.paths.userData; },
    getAppPath: () => ctx.repoRoot,
    requestSingleInstanceLock: () => true,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: (o) => { ctx.loginItemSet = o; },
    setAppUserModelId: () => {},
  };

  /** 单屏 1280×800（workArea 底部留空，用于断言默认位置「底部居中」） */
  const fakeDisplay = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 800 } };
  const powerMonitor = makeEmitter();
  ctx.powerMonitor = powerMonitor;

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView, // `#453` 内嵌真浏览器
    screen: {
      getDisplayMatching: () => fakeDisplay,
      getDisplayNearestPoint: () => fakeDisplay,
      getPrimaryDisplay: () => fakeDisplay,
    },
    powerMonitor,
    ipcMain: {
      handle(ch, fn) { handlers.set(ch, fn); },
      on(ch, fn) { push(listeners, 'ipc:' + ch, fn); },
    },
    // `#456`：内嵌 view 的 cookie 读口（`session.fromPartition(...).cookies.get({})`）
    session: {
      fromPartition(partition) {
        ctx.partitions.push(partition);
        return { cookies: { get: async () => ctx.partitionCookies } };
      },
    },
    shell: { openExternal() {} },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ items: template, template }) },
    nativeImage: { createFromPath: (p) => ({ __path: p }) },
    globalShortcut: {
      register(acc, fn) { ctx.shortcutRegistered = acc; ctx.shortcutFn = fn; return ctx.registerResult; },
      isRegistered: (acc) => ctx.registerResult && acc === ctx.shortcutRegistered,
      unregisterAll() { ctx.shortcutRegistered = null; },
    },
    dialog: { showOpenDialog: async () => ctx.dialogResult, showMessageBoxSync: () => 0 },
  };

  return { electron, handlers, listeners, windows, app };
}

const waitFor = async (pred, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/* =========================================================================
 * 环境准备（**一律用临时目录**：不碰用户 3000 端口、不碰仓库 data/）
 * ========================================================================= */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-209-main-'));

/** 假服务端：只回答 main.js 真正会打的两个口，并**记录**渲染桥注册请求 */
const seen = { engines: 0, identity: 0, renderer: [], other: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/api/engines') {
      seen.engines++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    if (req.method === 'GET' && req.url === '/api/system/identity') {
      // 复用判定要求「身份 + 数据目录都匹配」；开发态期望目录就是仓库 data/
      seen.identity++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        app: 'yuedu',
        mode: 'standalone',
        instanceId: 'stub0000',
        pid: 1,
        port: stubPort,
        dataDir: path.resolve(ctx.repoRoot, 'data'),
        sourceDb: path.resolve(ctx.repoRoot, 'data', 'yuedu.db'),
        startedAt: '2026-01-01T00:00:00.000Z',
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/internal/renderer') {
      let j = null;
      try { j = JSON.parse(body); } catch { /* 非 JSON 就是不合规，下面断言会暴露 */ }
      seen.renderer.push(j);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, renderBridgePort: (j && j.port) || 0 }));
      return;
    }
    seen.other.push(`${req.method} ${req.url}`);
    res.writeHead(404);
    res.end('nope');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const stubPort = server.address().port;

/** 待打开的本地书（内容无所谓，main.js 只按字节搬运） */
const bookPath = path.join(tmp, '测试书.txt');
fs.writeFileSync(bookPath, '第一章 起\n' + '正文内容。'.repeat(500) + '\n', 'utf8');

const ctx = {
  ready: null,
  paths: { userData: path.join(tmp, 'userData'), exe: 'C:\\fake\\electron.exe' },
  repoRoot: path.resolve(import.meta.dirname, '..', '..', '..'),
  windows: [],
  views: [], // `#453` WebContentsView 桩
  partitions: [], // `#456` session.fromPartition 收到的 partition 名
  partitionCookies: [{ name: 'sid', value: 'SESSION-42', domain: '.example.com', path: '/' }],
  sends: [],
  balloons: [],
  registerResult: true,
  dialogResult: { canceled: false, filePaths: [bookPath] },
  quitCalled: false,
};
ctx.ready = new Promise((r) => { ctx._resolveReady = r; });

const { electron, handlers, listeners, windows } = makeElectronStub(ctx);

const savedArgv = process.argv.slice();
const savedEnv = { ...process.env };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron;
  // 绝不能真 spawn（会去拉服务端、写用户数据）——桩掉它，同时记录调用便于断言
  if (request === 'node:child_process') {
    return {
      spawn: (...args) => { ctx.spawnArgs = args; return { pid: 4242, on() {}, kill() {} }; },
      // `--server-only` 的退出/重启走 taskkill /T /F；桩里只记录命令，绝不真杀
      spawnSync: (cmd, args) => { ctx.spawnSyncCalls = ctx.spawnSyncCalls || []; ctx.spawnSyncCalls.push({ cmd, args }); return { status: 0 }; },
    };
  }
  return origLoad.apply(this, arguments);
};

process.env.PORT = String(stubPort);
process.env.YUEDU_DESKTOP_PREFS = path.join(tmp, 'desktop-prefs.json');
process.env.YUEDU_ALLOW_MULTI_INSTANCE = '1';
process.env.YUEDU_SELFCHECK = path.join(tmp, 'selfcheck.json');
// 桩测试不需要等导入宽限期（真探针才需要），否则白等 4 秒
process.env.YUEDU_SELFCHECK_GRACE_MS = '0';
delete process.env.ELECTRON_RUN_AS_NODE;
// 双击打开 = 路径在 argv 里（开发态形态：electron . book.txt）
// `#347`：同时带一条「点导入链接唤起」的深链（Windows 形态：URL 作为一个 argv 元素）
const schemeUrl = 'yuedu://import/bookSource?src=https%3A%2F%2Fexample.com%2Fa.json';
process.argv = [savedArgv[0], '.', bookPath, schemeUrl];

require('../main.js');
ctx._resolveReady();

after(() => {
  Module._load = origLoad;
  process.argv = savedArgv;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也无所谓 */ }
});

/* =========================================================================
 * 断言
 * ========================================================================= */

test('启动链走到了开窗（`registerRenderer` 那类「打断启动」的缺陷会在这里红）', async () => {
  await waitFor(() => ctx.windows.length > 0, 5000, 'main.js 没有创建任何窗口');
  assert.equal(ctx.windows.length, 1, '正常启动应恰好 1 个主窗口（渲染桥窗口是按需创建的）');
  assert.equal(ctx.windows[0].url, `http://127.0.0.1:${stubPort}`, '主窗口应加载本机服务地址');
  assert.equal(ctx.windows[0].isVisible(), true, 'ready-to-show 之后必须真的显示出来');
});

test('★ 桌面能力真的被建起来：托盘 + 全局快捷键', async () => {
  await waitFor(() => ctx.trayCreated === true, 3000, '托盘未创建（assets/tray.png 存在吗？）');
  assert.match(String(ctx.trayImage?.__path ?? ''), /assets[\\/]tray\.png$/);
  assert.equal(ctx.trayTooltip, '阅读 YueDu');
  assert.equal(ctx.shortcutRegistered, 'CommandOrControl+Shift+Y', '默认快捷键应来自 desktop-lib 的 DEFAULT_PREFS');
});

test('★ 渲染桥端口真的 POST 给了服务端（这是 `registerRenderer` 修好之前做不到的事）', async () => {
  await waitFor(() => seen.renderer.length > 0, 5000, '没有收到 /api/internal/renderer 的注册请求');
  assert.ok(seen.engines > 0, '先要探测服务（GET /api/engines）才会去注册');
  assert.equal(seen.renderer.length, 1);
  const port = seen.renderer[0]?.port;
  assert.equal(typeof port, 'number');
  assert.ok(port > 0 && port !== stubPort, `注册的应是渲染桥端口（≠ 服务端口 ${stubPort}），实际 ${port}`);
  assert.ok(seen.identity > 0, '复用前必须先核对身份端点（不能只看端口通不通）');
  // 注册失败必须留痕 ⇒ 这条走的是成功路径，不该出现其它未预期的请求
  assert.deepEqual(seen.other, [], `不该有别的请求：${JSON.stringify(seen.other)}`);
});

test('IPC 通道齐备（界面调用前先确认「口子都开着」）', () => {
  const need = [
    'yuedu:ensure-server', 'yuedu:login',
    'yuedu:desktop-status', 'yuedu:desktop-prefs-get', 'yuedu:desktop-prefs-set', 'yuedu:desktop-pick-data-dir',
    'yuedu:open-local-book', 'yuedu:file-assoc-set', 'yuedu:auto-launch-set', 'yuedu:toggle-window',
    // `D4` F11 全屏
    'yuedu:fullscreen',
    // B18 浮窗阅读（独立无边框窗，两态：常规 / 条形）
    'yuedu:float-get', 'yuedu:float-open', 'yuedu:float-mode', 'yuedu:float-close',
    // `#347` 导入链接协议（注册 + 只读查询）
    'yuedu:protocol-assoc-set', 'yuedu:protocol-assoc-get',
    // `#453` 内嵌真浏览器（开/挂/收/导航/执行/状态/关）+ `#456` cookie 读口
    'yuedu:webview-open', 'yuedu:webview-attach', 'yuedu:webview-detach',
    'yuedu:webview-nav', 'yuedu:webview-exec', 'yuedu:webview-status', 'yuedu:webview-close',
    'yuedu:webview-cookies',
  ];
  for (const ch of need) assert.ok(handlers.has(ch), `缺 IPC handle：${ch}`);
  assert.ok((listeners.get('ipc:yuedu:renderer-ready') || []).length > 0, '缺 yuedu:renderer-ready 的 on 监听');
  // 浮窗的「渲染层 → 主进程」单向口子（正文流 / hover 接管 / 按钮命令 / 几何与外观）
  for (const ch of ['yuedu:float-reading', 'yuedu:float-hover', 'yuedu:float-command', 'yuedu:float-move', 'yuedu:float-patch', 'yuedu:float-panel', 'yuedu:float-height', 'yuedu:float-focusable']) {
    assert.ok((listeners.get('ipc:' + ch) || []).length > 0, `缺 IPC on 监听：${ch}`);
  }
});

test('★ `D4` F11 全屏：每次按主窗口实时值取反，并如实回报', async () => {
  const win = windows[0];
  const r1 = await handlers.get('yuedu:fullscreen')(null);
  assert.deepEqual(r1, { ok: true, fullscreen: true });
  assert.equal(win.isFullScreen(), true, '第一次调用必须进全屏');
  const r2 = await handlers.get('yuedu:fullscreen')(null);
  assert.deepEqual(r2, { ok: true, fullscreen: false });
  assert.equal(win.isFullScreen(), false, '第二次调用必须退出全屏');
});

test('★ B18 浮窗阅读两态：常规 / 条形都是独立无边框窗，主窗 hide/show 且几何不被碰，分形态落盘', async () => {
  const win = windows[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.setBounds({ x: 100, y: 80, width: 1100, height: 700 });
  const mainBefore = win.getBounds();

  // 进入常规 ⇒ 主窗 hide、浮窗 showInactive，默认 420×320 居中
  const entered = await handlers.get('yuedu:float-open')(null, 'regular');
  assert.equal(entered.ok, true);
  assert.equal(entered.open, true);
  assert.equal(entered.mode, 'regular');
  assert.equal(win.isVisible(), false, '进入浮窗阅读必须隐藏主窗（不再拿主窗变形）');
  const fw = lyricsWinOf();
  assert.ok(fw, '浮窗必须是独立的 BrowserWindow');
  assert.equal(fw.opts.frame, false);
  assert.equal(fw.opts.transparent, true);
  assert.equal(fw.opts.alwaysOnTop, true);
  assert.equal(fw.opts.skipTaskbar, true);
  assert.equal(fw.opts.focusable, false, '常规态也不抢焦点');
  assert.equal(fw.isVisible(), true);
  assert.deepEqual({ width: fw.getBounds().width, height: fw.getBounds().height }, { width: 420, height: 320 }, '常规默认 420×320');
  assert.deepEqual(fw._minSize, { width: 180, height: 120 }, '常规下限 180×120（与 Web 共用 float-geometry.json）');
  assert.deepEqual(win.getBounds(), mainBefore, '主窗几何全程不被碰');
  // 穿透两键：常规默认不穿透（穿透会漏滚轮、无法选字）
  assert.equal(fw._ignore.v, false, '常规默认不穿透');
  assert.deepEqual(fw._ignore.opts, { forward: false }, '常规/歌词不挂鼠标转发钩子（只有条形档穿透时需要 forward 把 move 送进来）');

  // 程序性 setBounds 的 300ms 保护窗过去后，再模拟用户拖动/缩放
  await sleep(320);
  fw.setBounds({ x: 640, y: 360, width: 500, height: 360 });
  await sleep(320);
  let onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.deepEqual(
    { x: onDisk.floatRegularX, y: onDisk.floatRegularY, w: onDisk.floatRegularW, h: onDisk.floatRegularH },
    { x: 640, y: 360, w: 500, h: 360 },
    '常规几何必须落盘',
  );

  // 切条形 ⇒ 同一扇窗换内容源，按条形态几何；常规几何不得被污染
  const bar = await handlers.get('yuedu:float-mode')(null, 'bar');
  assert.equal(bar.open, true);
  assert.equal(bar.mode, 'bar');
  assert.equal(windows.filter((w) => /lyrics\.html$/.test(String(w.url))).length, 1, '两态共用同一扇浮窗');
  assert.deepEqual({ width: fw.getBounds().width, height: fw.getBounds().height }, { width: 920, height: 140 }, '条形态默认 920×140');
  assert.deepEqual(fw._minSize, { width: 320, height: 48 }, '条形态下限 320×48（窗高由内容实测上报，下限要让三行内容能落地）');
  assert.equal(fw._ignore.v, true, '条形态默认穿透');
  assert.deepEqual(fw._ignore.opts, { forward: true }, '条形态穿透必须带 forward：move 要能进来，hover 才能把交互收回来');
  onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.floatRegularW, 500, '切形态前必须先把常规几何落盘');

  await sleep(320);
  fw.setBounds({ x: 300, y: 200, width: 1000, height: 160 });
  await sleep(320);
  onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.deepEqual(
    { x: onDisk.floatBarX, y: onDisk.floatBarY, w: onDisk.floatBarW, h: onDisk.floatBarH },
    { x: 300, y: 200, w: 1000, h: 160 },
    '条形态几何必须落盘',
  );
  assert.equal(onDisk.floatRegularX, 640, '条形态刷新不得污染常规几何');

  // 退出 ⇒ 浮窗 hide、主窗 show（几何原样，因为从未被改过）
  const exited = await handlers.get('yuedu:float-close')(null);
  assert.equal(exited.open, false);
  assert.equal(fw.isVisible(), false, '退出必须收起浮窗');
  assert.equal(win.isVisible(), true, '退出必须把主窗叫回来');
  assert.deepEqual(win.getBounds(), mainBefore, '主窗几何没被改过 ⇒ 直接回来');
  // 2026-11-14：歌词恒不可「系统缩放」（透明无边框窗没有原生缩放边框）；
  // 手动调宽高改由渲染层贴边发 `yuedu:float-resize`（见下一条测试）。
  assert.equal(fw._resizable, false, '歌词形态不启用系统缩放');
  assert.deepEqual(fw._minSize, { width: 320, height: 48 }, '歌词形态最小尺寸');
  onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.floatBarW, 1000, '退出后条形态记录仍在');
  assert.equal(onDisk.floatRegularW, 500, '退出后常规几何记录仍在');
  assert.equal(onDisk.floatMode, undefined, '形态本身不落盘（重启回正常主窗）');
  assert.equal(onDisk.smallX, undefined, 'mini/small 几何键已彻底删除');
  assert.equal(onDisk.miniX, undefined, 'mini/small 几何键已彻底删除');

  // ★ 2026-11-14：常规态重新亮相时必须**强落**一次穿透值。
  //   场景：窗口隐藏期间 Windows 侧留下了 WS_EX_TRANSPARENT（用户实机：工具条能浮现
  //   ——forward 转发 move；但整条按钮点不动——click 被整窗吞）。窗口值没变 ⇒ 旧实现
  //   靠缓存直接 return，永远纠不回来。
  fw.setIgnoreMouseEvents(true); // 模拟系统侧残留（绕过我们的缓存）
  assert.equal(fw._ignore.v, true);
  const again = await handlers.get('yuedu:float-open')(null, 'regular');
  assert.equal(again.open, true);
  assert.equal(fw._ignore.v, false, '重新亮相必须把交互区接管回来（force 不看缓存）');
});

/**
 * `#453` 内嵌真浏览器：走一遍「开 → 挂进主窗口 → 导航 → 关」的**主进程侧**接线。
 *
 * 桩能证明的：键归一（裸源 id ⇒ `src:<id>`）、bounds 经夹取后交给 view、view 真的进了主窗口
 * 的 contentView、没有该会话时如实报错（不静默）、关掉后资源真的收掉。
 * 桩**证明不了**的：view 真的画出来了 / 焦点与输入法对不对 —— 那只能真机手测。
 */
test('★ `#453` 内嵌真浏览器：开 → 挂 → 导航 → 状态 → 关（主进程侧接线）', async () => {
  // 没给合法 URL ⇒ 明确拒（不许拿一个半成品去开浏览器）
  const bad = await handlers.get('yuedu:webview-open')(null, { sourceId: 'abc', url: 'not-a-url' });
  assert.deepEqual(bad, { ok: false, error: 'BAD_URL' });
  assert.equal(ctx.views.length, 0, 'URL 不合法时不许建 view');

  // 没有该会话的 view ⇒ 如实报 NO_VIEW（而不是假装成功）
  assert.deepEqual(await handlers.get('yuedu:webview-attach')(null, { sourceId: 'nope' }), { ok: false, error: 'NO_VIEW' });
  assert.equal((await handlers.get('yuedu:webview-status')(null, { sourceId: 'nope' })).exists, false);

  // 开：裸源 id 必须被归一成 `src:abc`（与服务端会话键同一口径）
  const op = await handlers.get('yuedu:webview-open')(null, {
    sourceId: 'abc', url: 'https://example.com/a', bounds: { x: 10, y: 20, width: 300, height: 400 },
  });
  assert.equal(op.ok, true, `开 view 失败：${JSON.stringify(op)}`);
  assert.equal(op.key, 'src:abc');
  assert.equal(ctx.views.length, 1, '应恰好建 1 个 view');
  const view = ctx.views[0];
  assert.ok(view.opts.webPreferences.partition.startsWith('persist:'), '必须带持久 partition（登录态才留得住）');
  assert.equal(view.webContents.win.url, 'https://example.com/a', '地址应真的交给 view 的 webContents');
  // 挂进主窗口的 contentView + bounds 夹取（主窗口内容区 1280×860）
  assert.deepEqual(windows[0].contentView.children, [view], 'view 必须真的挂进了主窗口');
  assert.deepEqual(view.bounds, { x: 10, y: 20, width: 300, height: 400 });
  // 越界的 bounds 要被夹回窗口内（x=1200 + width=500 ⇒ 只剩 80）
  await handlers.get('yuedu:webview-attach')(null, { sourceId: 'abc', bounds: { x: 1200, y: 850, width: 500, height: 500 } });
  assert.deepEqual(view.bounds, { x: 1200, y: 850, width: 80, height: 10 });

  // 状态：已挂进主窗口 ⇒ pinned（不许被 TTL/LRU 回收）
  const st = await handlers.get('yuedu:webview-status')(null, { sourceId: 'abc' });
  assert.equal(st.exists, true);
  assert.equal(st.pinned, true, '挂在主窗口上的 view 必须是 pinned');

  // 收起来 ⇒ 回到后台（仍存在，只是 unpin）
  assert.equal((await handlers.get('yuedu:webview-detach')(null, { key: 'src:abc' })).ok, true);
  assert.equal((await handlers.get('yuedu:webview-status')(null, { key: 'src:abc' })).pinned, false);

  // 历史为空 ⇒ back/forward 明确回 NO_HISTORY（桩的 navigationHistory 为 null ⇒ 走旧分支，且恒 false）
  const nav = await handlers.get('yuedu:webview-nav')(null, { key: 'src:abc', action: 'back' });
  assert.deepEqual(nav, { ok: false, error: 'NO_HISTORY' });
  assert.equal((await handlers.get('yuedu:webview-nav')(null, { key: 'src:abc', url: 'https://example.com/b' })).ok, true);
  assert.equal(view.webContents.win.url, 'https://example.com/b');
  assert.equal((await handlers.get('yuedu:webview-exec')(null, { key: 'src:abc', js: '1+1' })).value, '<html></html>');

  // 关：webContents 真的关掉，元数据也从池里清掉（否则残留记录会一直被 TTL 扫）
  assert.equal((await handlers.get('yuedu:webview-close')(null, { key: 'src:abc' })).closed, true);
  assert.equal(view.webContents.closed, true);
  assert.equal((await handlers.get('yuedu:webview-status')(null, { key: 'src:abc' })).exists, false);
  assert.deepEqual(windows[0].contentView.children, [], '关掉后必须从主窗口上摘掉');
});

/**
 * `#456` 内嵌浏览器的 cookie 读口。
 *
 * 主进程在这里**只做一件事**：读它自己拥有的那个 partition。
 * 「回传服务端」（POST `/api/sources/:id/login/cookies`）在渲染进程做 —— 因为网络与域过滤判据
 * 都不该在桌面外壳里重写（`pickLoginCookies` 只有服务端一份）。
 */
test('★ `#456` 读内嵌 view 会话的 cookie：partition 名要对得上，且只读不写', async () => {
  const r = await handlers.get('yuedu:webview-cookies')(null, { sourceId: 'abc' });
  assert.equal(r.ok, true, `读 cookie 失败：${JSON.stringify(r)}`);
  assert.equal(r.key, 'src:abc', '键必须与服务端/桌面端同一口径');
  assert.equal(ctx.partitions.at(-1), 'persist:src_abc', 'partition 必须按会话键推导（每源隔离）');
  assert.deepEqual(r.cookies, [{ name: 'sid', value: 'SESSION-42', domain: '.example.com', path: '/' }]);
});

test('★ 双击 txt：argv 里的文件经「渲染进程握手」后真的被送进去（字节原样）', async () => {
  // 握手前先看：这时文件应还攒在待发队列里（渲染进程没就绪就不能发）
  assert.ok(!ctx.sends.some((s) => s.channel === 'yuedu:open-files'), '渲染进程未握手前不该发送');
  for (const fn of listeners.get('ipc:yuedu:renderer-ready') || []) fn();
  await waitFor(() => ctx.sends.some((s) => s.channel === 'yuedu:open-files'), 2000, '握手后仍未把书文件交给渲染进程');
  const msg = ctx.sends.find((s) => s.channel === 'yuedu:open-files');
  const files = msg.args[0];
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '测试书.txt');
  assert.equal(files[0].path, bookPath);
  // 字节原样：前端要拿它构造 File 上传，差一个字节都算坏
  assert.deepEqual(Buffer.from(files[0].data), fs.readFileSync(bookPath));
  assert.equal(files[0].bytes, fs.statSync(bookPath).size);
});

/**
 * `#347` 点导入链接唤起：Windows 会把 URL 当**第二个进程**的 argv 传进来 ⇒
 * 主进程必须经「渲染进程握手」把它交给界面（与双击文件同一套攒发纪律）。
 * ★ 这里断言的是「**原样转交**」：判型/开对话框在渲染进程（`utils/scheme-import.ts`），
 *   主进程多做一步就是「同一判据写两处」。
 */
test('★ 点导入链接唤起：argv 里的 yuedu:// 深链经握手后原样交给渲染进程', async () => {
  await waitFor(() => ctx.sends.some((s) => s.channel === 'yuedu:scheme-url'), 2000, '深链未被交给渲染进程');
  const msg = ctx.sends.find((s) => s.channel === 'yuedu:scheme-url');
  assert.equal(msg.args[0], schemeUrl, '必须原样转交（主进程不判型、不改写）');
});

test('菜单「打开本地书籍」走的是同一条路（不是另开一套导入）', async () => {
  const r = await handlers.get('yuedu:open-local-book')();
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  const sends = ctx.sends.filter((s) => s.channel === 'yuedu:open-files');
  assert.equal(sends.length, 2, '第二次发送应是菜单挑的那个文件');
});

test('开发态**拒绝**注册文件关联 / 开机自启 / 导入链接协议（不许把 electron.exe 写进用户系统）', async () => {
  const fa = await handlers.get('yuedu:file-assoc-set')(null, true);
  assert.equal(fa.ok, false);
  assert.equal(fa.supported, false);
  assert.match(fa.error, /开发态/);
  // `#347`：协议注册同样是系统级承诺 ⇒ 开发态必须一起拒
  const pa = await handlers.get('yuedu:protocol-assoc-set')(null, true);
  assert.equal(pa.ok, false);
  assert.equal(pa.supported, false);
  assert.match(pa.error, /开发态/);
  const al = await handlers.get('yuedu:auto-launch-set')(null, true);
  assert.equal(al.ok, false);
  assert.equal(al.supported, false);
  assert.equal(ctx.loginItemSet, undefined, '开发态不该调 setLoginItemSettings');
});

test('状态查询把「真实状态」交出去（托盘 ok / 快捷键 ok+held / 打包能力 sup）', async () => {
  const st = await handlers.get('yuedu:desktop-status')();
  assert.deepEqual(st.tray, { ok: true, icon: path.join(import.meta.dirname, '..', 'assets', 'tray.png') });
  assert.equal(st.shortcut.ok, true);
  assert.equal(st.shortcut.held, true, 'register 与 isRegistered 两个判据必须一致');
  assert.equal(st.shortcut.accelerator, 'CommandOrControl+Shift+Y');
  assert.equal(st.fileAssoc.supported, false);
  // `#347`：协议状态也要出现在状态查询里（界面据此渲染「已注册/未注册」）
  assert.equal(st.protocolAssoc.supported, false);
  assert.equal(st.autoLaunch.supported, false);
  assert.equal(st.singleInstance.allowedMulti, true);
  assert.ok(String(st.versions.electron ?? '').length >= 0);
  // 本地服务生效配置必须如实交出去（设置页据此显示「现在跑在哪」）
  assert.equal(st.server.port, Number(process.env.PORT));
  assert.ok(path.isAbsolute(st.server.dataDir), `dataDir 必须是绝对路径：${st.server.dataDir}`);
  assert.equal(st.server.envPort, Number(process.env.PORT));
});

test('偏好写入**真的落盘**（改一项后再读回来是新的）', async () => {
  const r = await handlers.get('yuedu:desktop-prefs-set')(null, { minimizeToTray: true, closeToTray: false });
  assert.equal(r.ok, true);
  assert.equal(r.prefs.minimizeToTray, true);
  assert.equal(r.prefs.closeToTray, false);
  const onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.minimizeToTray, true);
  assert.equal(onDisk.closeToTray, false);
  // 非法值不许写进去，且必须留告警
  const bad = await handlers.get('yuedu:desktop-prefs-set')(null, { shortcut: 'Y' });
  assert.equal(bad.prefs.shortcut, 'CommandOrControl+Shift+Y');
  assert.ok(bad.warnings.some((w) => w.includes('快捷键')), `应有快捷键告警：${JSON.stringify(bad.warnings)}`);
  // 端口/数据目录归一：非法值不落盘，合法值落盘
  const badPort = await handlers.get('yuedu:desktop-prefs-set')(null, { serverPort: 80 });
  assert.equal(badPort.prefs.serverPort, 0);
  assert.ok(badPort.warnings.some((w) => w.includes('serverPort')), `应有端口告警：${JSON.stringify(badPort.warnings)}`);
  const badDir = await handlers.get('yuedu:desktop-prefs-set')(null, { dataDir: 'relative/dir' });
  assert.equal(badDir.prefs.dataDir, '');
  assert.ok(badDir.warnings.some((w) => w.includes('dataDir')), `应有目录告警：${JSON.stringify(badDir.warnings)}`);
});

test('★ 「点 X 收进托盘」：拦得住窗口关闭，并落一次托盘气泡提示', async () => {
  // 前置：上一条测试把 closeToTray 关掉了 —— 这里**显式**开回来（否则测的是另一条分支）
  const pre = await handlers.get('yuedu:desktop-prefs-set')(null, { closeToTray: true });
  assert.equal(pre.prefs.closeToTray, true);
  const win = windows[0];
  let prevented = false;
  win.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'closeToTray 开启且托盘存在时必须拦住关闭');
  assert.equal(win.isVisible(), false, '拦住之后要真的收起来');
  assert.equal(ctx.balloons.length, 1, '第一次收起要弹一次托盘气泡（不然用户以为程序没了）');
  assert.match(ctx.balloons[0].content, /托盘/);
  // 偏好里记下「已经提示过」⇒ 第二次不再打扰
  const onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.trayHintShown, true);
  win.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(ctx.balloons.length, 1, '提示只弹一次');
});

test('关掉 closeToTray 之后不再拦关闭（开关真的是开关）', async () => {
  const win = windows[0];
  const pre = await handlers.get('yuedu:desktop-prefs-set')(null, { closeToTray: false });
  assert.equal(pre.prefs.closeToTray, false);
  let prevented = false;
  win.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  // 复位，免得影响后面的测试（自检报告里 closeToTray 仍是 true）
  await handlers.get('yuedu:desktop-prefs-set')(null, { closeToTray: true });
});

test('退出时不再拦截关闭（否则点「退出」只会把窗口又收起来）', () => {
  const win = windows[0];
  // 真实顺序是 before-quit → 关窗口 → will-quit；置位必须在**第一步**
  for (const fn of listeners.get('before-quit') || []) fn();
  assert.ok((listeners.get('before-quit') || []).length > 0, 'main.js 必须监听 before-quit 才能及时放行关闭');
  let prevented = false;
  win.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

/**
 * 桌面朗读歌词（对比参照项目 `legado-lyrics-overlay` 的 `canShow()`）：
 * 这里验的是**主进程的决策与接线** —— 桩能证明「什么时候建窗/显示/隐藏、参数对不对、
 * 位置有没有落盘」；窗口真的浮在别的应用之上、拖动是否跟手，只能真机手测。
 *
 * ⚠️ `ctx.windows` 里不止主窗口（还有渲染桥的隐藏宿主窗 / 可能的 splash），
 *   所以按 `lyrics.html` 认歌词窗，别按下标猜。
 */
const lib = require('../desktop-lib.js');

const lyricsWinOf = () => windows.find((w) => /lyrics\.html$/.test(String(w.url)));

test('★ 桌面歌词：默认关；开着 + 朗读中即显示（与主窗焦点无关）', async () => {
  const win = windows[0];
  const emitState = (patch = {}) => {
    const state = { active: true, playing: true, paused: false, index: 2, innerPos: 3, prev: '上一句', current: '当前句子', next: '下一句', ...patch };
    for (const fn of listeners.get('ipc:yuedu:lyrics-state') || []) fn({}, state);
  };
  win.focus();
  emitState();
  // 默认偏好是关的 ⇒ 朗读中也不该冒出置顶窗
  assert.equal(JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8')).lyricsEnabled, false, '默认必须是关');
  // 两态/歌词共用同一扇浮窗 ⇒ 窗口可能已经存在（上一条用例建过），但**不许显示**
  assert.ok(!lyricsWinOf() || lyricsWinOf().isVisible() === false, '开关关着时不许显示歌词窗');

  const r = await handlers.get('yuedu:desktop-prefs-set')(null, { lyricsEnabled: true });
  assert.equal(r.prefs.lyricsEnabled, true);
  // 用户 2026-11-08：歌词窗是朗读控制条的一种形态 ⇒ 朗读中就显示，**不再要求主窗失焦**
  const lw = lyricsWinOf();
  assert.ok(lw, '开着 + 朗读中 ⇒ 建窗（主窗有焦点也一样）');
  assert.equal(lw.isVisible(), true, '主窗有焦点也显示');
  assert.equal(lw.opts.transparent, true);
  assert.equal(lw.opts.frame, false);
  assert.equal(lw.opts.alwaysOnTop, true);
  assert.equal(lw.opts.skipTaskbar, true);
  assert.equal(lw.opts.focusable, false, '歌词窗不许抢焦点');
  assert.equal(lw.opts.webPreferences.backgroundThrottling, false, '后台歌词进度不能变慢');
  assert.equal(lw.opts.webPreferences.contextIsolation, true);
  assert.match(String(lw.opts.webPreferences.preload), /lyrics-preload\.js$/);
  // 默认位置：主屏（1280×800）底部居中、留 72px；高度 = 三行文字 + 上下 padding（22px ⇒ 88）
  assert.deepEqual(lw.getBounds(), { x: 280, y: 640, width: 720, height: 88 });

  // 主窗焦点变化不再影响显示（不是「失焦才出现」那套了）
  win.blur();
  assert.equal(lw.isVisible(), true, '失焦仍然显示');
  win.focus();
  assert.equal(lw.isVisible(), true, '回焦也仍然显示');
  assert.equal(lw.isDestroyed(), false, '没有来回销毁重建');
});

test('★ 桌面歌词：暂停不隐藏（2026-11-14）、朗读结束才隐藏；锁屏/休眠隐藏、解锁后才回来', () => {
  const win = windows[0];
  const lw = lyricsWinOf();
  const emitState = (patch = {}) => {
    const state = { active: true, playing: true, paused: false, index: 2, innerPos: 3, prev: '上一句', current: '当前句子', next: '下一句', ...patch };
    for (const fn of listeners.get('ipc:yuedu:lyrics-state') || []) fn({}, state);
  };
  win.blur();
  emitState();
  assert.equal(lw.isVisible(), true, '失焦 + 播放中 ⇒ 显示');

  // 用户 2026-11-14：点「暂停」只停声音，窗必须留在原位（从朗读控制条点「继续」能接着念）
  emitState({ playing: false, paused: true });
  assert.equal(lw.isVisible(), true, '暂停不隐藏（active 仍为 true）');

  emitState({ playing: true, paused: false });
  assert.equal(lw.isVisible(), true, '恢复播放仍显示');

  // 也只有「朗读会话结束」（state=idle ⇒ active=false）才隐藏
  emitState({ active: false, playing: false, paused: false });
  assert.equal(lw.isVisible(), false, '朗读结束（active=false）才隐藏');
  emitState({ playing: true, paused: false });
  assert.equal(lw.isVisible(), true, '重新开始朗读 ⇒ 回来');

  ctx.powerMonitor.emit('lock-screen');
  assert.equal(lw.isVisible(), false, '锁屏必须隐藏（别把歌词留在锁屏界面上）');
  ctx.powerMonitor.emit('unlock-screen');
  assert.equal(lw.isVisible(), true, '解锁后仍失焦 ⇒ 回来');

  ctx.powerMonitor.emit('suspend');
  assert.equal(lw.isVisible(), false, '休眠同样隐藏');
  ctx.powerMonitor.emit('resume');
  assert.equal(lw.isVisible(), true, '唤醒后仍失焦 ⇒ 回来');
});

test('★ 桌面歌词：按钮命令白名单转发；「关闭」只关窗/落盘为关，不退出应用', async () => {
  const win = windows[0];
  const lw = lyricsWinOf();
  win.blur();
  assert.equal(lw.isVisible(), true);

  win.webContents.sent.length = 0;
  for (const fn of listeners.get('ipc:yuedu:lyrics-command') || []) fn({}, 'next');
  assert.deepEqual(win.webContents.sent.at(-1), { channel: 'yuedu:lyrics-command', args: ['next'] }, '下一句要转给主窗口的朗读状态机');
  for (const fn of listeners.get('ipc:yuedu:lyrics-command') || []) fn({}, 'toggle');
  assert.equal(win.webContents.sent.at(-1).args[0], 'toggle');
  // ★ 2026-11-09：控制条新增上一章/下一章，也必须在白名单里
  for (const fn of listeners.get('ipc:yuedu:lyrics-command') || []) fn({}, 'chapterPrev');
  assert.equal(win.webContents.sent.at(-1).args[0], 'chapterPrev', '上一章要转给朗读状态机');
  for (const fn of listeners.get('ipc:yuedu:lyrics-command') || []) fn({}, 'chapterNext');
  assert.equal(win.webContents.sent.at(-1).args[0], 'chapterNext', '下一章要转给朗读状态机');
  // 白名单外的命令不转发（歌词窗被注入脚本时也拿不到额外能力）
  for (const fn of listeners.get('ipc:yuedu:lyrics-command') || []) fn({}, 'quit');
  assert.equal(win.webContents.sent.at(-1).args[0], 'chapterNext', '非法命令必须被丢弃');

  // ★ 2026-11-09：长句换行后按真实内容高度改窗 —— 底边不动、向上长
  const beforeFit = lw.getBounds();
  for (const fn of listeners.get('ipc:yuedu:float-height') || []) fn({}, 240);
  const afterFit = lw.getBounds();
  assert.equal(afterFit.height, 240, '窗口高度跟内容走');
  assert.equal(afterFit.y + afterFit.height, beforeFit.y + beforeFit.height, '底边固定、向上长');
  assert.equal(afterFit.width, beforeFit.width, '横向不动');
  // 程序性 setBounds 的 300ms 防抖窗口过去再往下跑，别把后面的「用户拖动落盘」吞掉
  await new Promise((r) => setTimeout(r, 320));

  win.webContents.sent.length = 0;
  for (const fn of listeners.get('ipc:yuedu:lyrics-close') || []) fn({});
  assert.equal(lw.isVisible(), false, '「关闭」只隐藏歌词窗');
  assert.equal(ctx.quitCalled, false, '「关闭」绝不能退出应用');
  assert.equal(win.webContents.sent.at(-1).channel, 'yuedu:lyrics-enabled');
  assert.equal(win.webContents.sent.at(-1).args[0], false, '要通知设置页开关已变关');
  const onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.lyricsEnabled, false, '关闭必须落盘（不然下次启动又冒出来）');
});

test('★ 桌面歌词：拖动位置落盘；「重置位置」回默认且不被程序性 setBounds 回写', async () => {
  const win = windows[0];
  const lw = lyricsWinOf();
  await handlers.get('yuedu:desktop-prefs-set')(null, { lyricsEnabled: true });
  win.blur();
  assert.equal(lw.isVisible(), true);

  // 用户拖动（250ms 防抖后落盘）
  lw.setBounds({ x: 300, y: 200, width: 720, height: 180 });
  await new Promise((r) => setTimeout(r, 320));
  let onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.floatLyricsX, 300);
  assert.equal(onDisk.floatLyricsY, 200);

  // 重置 ⇒ 回到底部居中；这次 setBounds 属于程序性移动，不能把 null 又写回成坐标
  const r = await handlers.get('yuedu:desktop-prefs-set')(null, { floatLyricsX: null, floatLyricsY: null });
  assert.equal(r.prefs.floatLyricsX, null);
  // 高度跟着字号（22px ⇒ 88），不再固定 180 ⇒ 底边留 72 时 y = 800 - 88 - 72
  assert.deepEqual(lw.getBounds(), { x: 280, y: 640, width: 720, height: 88 });
  await new Promise((r) => setTimeout(r, 320));
  onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.floatLyricsX, null, '程序性 setBounds 不许被当成用户拖动');
  assert.equal(onDisk.floatLyricsY, null);

  // ★ 「重置位置」已收进歌词窗工具条：命令路径与设置页原实现同效（宽也回默认 720）
  const sendIpc = (channel, payload) => {
    for (const fn of listeners.get(`ipc:${channel}`) || []) fn({}, payload);
  };
  // 让主进程记下当前内容高度（真实的渲染层也会这样上报），再故意拖到别处并拉宽
  sendIpc('yuedu:float-height', 88);
  lw.setBounds({ x: 500, y: 300, width: 900, height: 120 });
  await new Promise((r) => setTimeout(r, 320));
  sendIpc('yuedu:float-command', { cmd: 'reset-pos' });
  assert.deepEqual(lw.getBounds(), { x: 280, y: 640, width: 720, height: 88 }, '工具条重置：默认位置 + 内容高度');
  await new Promise((r) => setTimeout(r, 320));
  onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.floatLyricsX, null);
  assert.equal(onDisk.floatLyricsY, null);

  // 锁定态：拖动被拒，但工具条的显式「重置位置」仍受理（锁定只拦拖动/缩放）
  sendIpc('yuedu:float-patch', { floatDragLocked: true });
  lw.setBounds({ x: 500, y: 300, width: 720, height: 88 });
  sendIpc('yuedu:float-command', { cmd: 'reset-pos' });
  assert.deepEqual(lw.getBounds(), { x: 280, y: 640, width: 720, height: 88 }, '锁定不拦重置');
  sendIpc('yuedu:float-patch', { floatDragLocked: false });
  await new Promise((r) => setTimeout(r, 320));
});

test('★ 2026-11-08 浮条：整块可拖（增量 IPC）/ 拖动锁定 / 设置面板开合 / 外观写回同一份 prefs', async () => {
  const lw = lyricsWinOf();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (channel, payload) => {
    for (const fn of listeners.get(`ipc:${channel}`) || []) fn({}, payload);
  };
  await handlers.get('yuedu:desktop-prefs-set')(null, { lyricsEnabled: true });
  assert.ok(lw, '歌词窗已建');
  lw.setBounds({ x: 300, y: 200, width: 720, height: lib.lyricsWindowHeight(22, true) });
  await sleep(320);

  // ① 拖动：渲染层发屏幕增量 ⇒ 主进程 setBounds（不再依赖 app-region）
  send('yuedu:float-move', { dx: 40, dy: -30 });
  assert.deepEqual(lw.getBounds(), { x: 340, y: 170, width: 720, height: 88 }, '按增量移动');
  await sleep(320);
  let onDisk = JSON.parse(fs.readFileSync(process.env.YUEDU_DESKTOP_PREFS, 'utf8'));
  assert.equal(onDisk.floatLyricsX, 340, '拖动位置仍由既有 move 事件落盘');
  assert.equal(onDisk.floatLyricsY, 170);

  // ② 拖动锁定：主进程直接拒绝（渲染层判断只是省一次 IPC）
  send('yuedu:float-patch', { floatDragLocked: true });
  assert.equal(lw._resizable, false, '歌词形态恒不启用系统缩放（改为贴边增量）');
  send('yuedu:float-move', { dx: 100, dy: 100 });
  assert.deepEqual(lw.getBounds(), { x: 340, y: 170, width: 720, height: 88 }, '锁定后纹丝不动');
  assert.equal((await handlers.get('yuedu:desktop-status')()).prefs.floatDragLocked, true, '锁定开关落盘');

  // ③ 外观：背景色/透明度/字号写回同一份 prefs；字号变化 ⇒ 窗高按三行重算、底边不动
  const nextH = lib.lyricsWindowHeight(30, true);
  send('yuedu:float-patch', { floatBgColor: '#1B1B1F', floatBgOpacity: 0.4, floatFontSize: 30 });
  const s = await handlers.get('yuedu:desktop-status')();
  assert.equal(s.prefs.floatBgColor, '#1B1B1F');
  assert.equal(s.prefs.floatBgOpacity, 0.4);
  assert.equal(s.prefs.floatFontSize, 30);
  assert.deepEqual(lw.getBounds(), { x: 340, y: 170 + 88 - nextH, width: 720, height: nextH }, '底边不动，向上长');

  // ④ 设置面板开合：临时加高 168，关掉缩回（歌词窗本身装不下面板）
  send('yuedu:float-panel', true);
  assert.equal(lw.getBounds().height, nextH + 168);
  send('yuedu:float-panel', false);
  assert.equal(lw.getBounds().height, nextH, '关掉面板缩回三行高');

  /**
   * ⑤ 2026-11-14 常规态：顶部 🔒 = 只锁窗口拖动，**不再切整窗点击穿透**。
   * 穿透会让 `setIgnoreMouseEvents(true)` 连滚轮/滚动条一起吞掉（用户实测：锁定后正文滚不动）。
   * 这里同时验证「旧偏好里存过 floatRegularClickThrough=true」也必须失效。
   */
  await handlers.get('yuedu:float-open')(null, 'regular');
  assert.equal(lw._resizable, true, '常规态窗口可缩放（进形态即可拖边框改大小）');
  send('yuedu:float-hover', false);
  assert.equal(lw._ignore.v, false, '常规态默认不穿透');
  send('yuedu:float-patch', { floatRegularClickThrough: true });
  send('yuedu:float-hover', false);
  assert.equal(lw._ignore.v, false, '旧偏好里的常规穿透值必须失效（否则正文滚不动）');
  // ★ 进工具条热区 = 用户马上要点：常规态在这里强落一次 false。
  //   场景同 float-open 的 force：窗口隐藏期间系统侧可能留下 WS_EX_TRANSPARENT，
  //   句柄值没变 ⇒ 普通缓存路径永远纠不回来（工具条能浮现、整条按钮点不动）。
  lw.setIgnoreMouseEvents(true); // 模拟系统侧残留（绕过我们的缓存）
  assert.equal(lw._ignore.v, true);
  send('yuedu:float-hover', true);
  assert.equal(lw._ignore.v, false, 'hover 进交互区必须把常规态交互区接管回来（不靠缓存）');
  send('yuedu:float-patch', { floatDragLocked: true });
  const lockedBounds = lw.getBounds();
  send('yuedu:float-move', { dx: 60, dy: 60 });
  assert.deepEqual(lw.getBounds(), lockedBounds, '锁定只冻结窗口位置');
  send('yuedu:float-patch', { floatDragLocked: false });
  assert.equal(lw._resizable, true, '常规形态仍由系统缩放');

  // ⑥ 条形态的 🔒 是「点击穿透」，不是拖动锁定 ⇒ dragLocked 不能拦条形态拖动
  send('yuedu:float-patch', { floatDragLocked: true });
  await handlers.get('yuedu:float-mode')(null, 'bar');
  const barBefore = lw.getBounds();
  send('yuedu:float-move', { dx: -25, dy: -10 });
  assert.equal(lw.getBounds().x, barBefore.x - 25, '条形态可拖动（锁定拖动只约束歌词/常规）');
  assert.equal(lw.getBounds().y, barBefore.y - 10);
  await handlers.get('yuedu:float-close')();
});

/**
 * ★ 2026-11-14 歌词形态「用户手动尺寸」语义：
 * · 未锁定：贴边增量 IPC 真的能改宽高；手动拉过尺寸后不再按内容自动量高；
 * · 锁定：切回按内容自动量高（底边锚定），且锁定/解锁本身不改 bounds（不跳位置/尺寸）。
 */
test('★ 2026-11-14 歌词未锁定可手动缩放；拉过尺寸后不再自动量高，锁定后恢复', async () => {
  const lw = lyricsWinOf();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (channel, payload) => {
    for (const fn of listeners.get(`ipc:${channel}`) || []) fn({}, payload);
  };
  await handlers.get('yuedu:desktop-prefs-set')(null, { lyricsEnabled: true });
  assert.ok(lw && lw.isVisible(), '歌词窗可见');
  send('yuedu:float-patch', { floatDragLocked: false });
  assert.equal(lw._resizable, false, '歌词不启用系统缩放（没有原生缩放边框，改走贴边增量）');

  await sleep(350); // 等上一条测试的程序性 setBounds 防抖窗口过去（300ms 内不算用户缩放）
  lw.setBounds({ x: 300, y: 300, width: 640, height: 200 });
  lw.emit('resize'); // 用户手动拉过尺寸（真实窗口会由 Electron 发该事件）
  await sleep(20);
  send('yuedu:float-height', 120);
  assert.deepEqual(lw.getBounds(), { x: 300, y: 300, width: 640, height: 200 }, '未锁定：以用户尺寸为准，不再自动量高');

  // 自定义缩放（透明无边框窗没有系统缩放边框，由渲染层贴边发增量）
  send('yuedu:float-resize', { edge: 'e', dx: -100, dy: 0 });
  assert.equal(lw.getBounds().width, 540, '西缘不动、右缘跟手');
  send('yuedu:float-resize', { edge: 's', dx: 0, dy: 60 });
  assert.equal(lw.getBounds().height, 260);
  assert.deepEqual(lw.getBounds(), { x: 300, y: 300, width: 540, height: 260 });

  // 锁定：本身不跳位置/尺寸，之后恢复按内容量高（底边锚定）
  send('yuedu:float-patch', { floatDragLocked: true });
  assert.equal(lw._resizable, false, '锁定后不可缩放');
  assert.deepEqual(lw.getBounds(), { x: 300, y: 300, width: 540, height: 260 }, '锁定本身不改 bounds');
  send('yuedu:float-height', 150);
  const b = lw.getBounds();
  assert.equal(b.height, 150, '锁定后恢复按内容量高');
  assert.equal(b.y + b.height, 300 + 260, '底边固定、向上缩');
  // 锁定状态下缩放/拖动都不再生效
  send('yuedu:float-resize', { edge: 'e', dx: 40, dy: 0 });
  assert.equal(lw.getBounds().width, 540, '锁定后缩放被拒');
});

test('★ 歌词外部开关：便携 exe 同目录旗标运行中即时生效；env 最高；冲突按关闭', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-lyrics-flag-'));
  const prevPortable = process.env.PORTABLE_EXECUTABLE_FILE;
  const prevEnv = process.env.YUEDU_LYRICS;
  const flagOff = path.join(dir, 'lyrics-off.txt');
  const flagOn = path.join(dir, 'lyrics-on.txt');
  const status = () => handlers.get('yuedu:desktop-status')();
  const warnHas = (s, kw) => (s.prefsWarnings || []).some((w) => w.includes(kw));
  try {
    // 先在设置页打开（持久化偏好 true），作为「旗标/env 缺失时的兜底」
    await handlers.get('yuedu:desktop-prefs-set')(null, { lyricsEnabled: true });
    process.env.PORTABLE_EXECUTABLE_FILE = path.join(dir, 'YueDu-portable.exe');
    delete process.env.YUEDU_LYRICS;
    assert.equal((await status()).prefs.lyricsEnabled, true, '无外部配置 ⇒ 听偏好的');

    fs.writeFileSync(flagOff, 'off');
    let s = await status();
    assert.equal(s.prefs.lyricsEnabled, false, 'lyrics-off.txt 必须压过偏好里的「开」');
    assert.ok(warnHas(s, '强制关闭'), '设置页要能知道为什么点了没弹窗');

    fs.writeFileSync(flagOn, 'on');
    s = await status();
    assert.equal(s.prefs.lyricsEnabled, false, '两个旗标冲突 ⇒ 按关闭');
    assert.ok(warnHas(s, '同时发现'), '冲突要给出可自查提示');

    fs.rmSync(flagOff);
    s = await status();
    assert.equal(s.prefs.lyricsEnabled, true, '只剩 lyrics-on.txt ⇒ 强制开');
    assert.ok(warnHas(s, '强制开启'));

    // 环境变量最高：0 压过 lyrics-on.txt；1 也压过残留的 off 旗标
    process.env.YUEDU_LYRICS = '0';
    s = await status();
    assert.equal(s.prefs.lyricsEnabled, false, 'YUEDU_LYRICS=0 必须压过 lyrics-on.txt');
    fs.writeFileSync(flagOff, 'off');
    process.env.YUEDU_LYRICS = '1';
    s = await status();
    assert.equal(s.prefs.lyricsEnabled, true, 'YUEDU_LYRICS=1 必须压过 lyrics-off.txt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevPortable === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = prevPortable;
    if (prevEnv === undefined) delete process.env.YUEDU_LYRICS;
    else process.env.YUEDU_LYRICS = prevEnv;
  }
});

test('自检出口写出的 JSON 与上面看到的事实一致（探针就是读它）', async () => {
  await waitFor(() => fs.existsSync(process.env.YUEDU_SELFCHECK), 8000, 'selfcheck.json 未产出');
  const rep = JSON.parse(fs.readFileSync(process.env.YUEDU_SELFCHECK, 'utf8'));
  assert.equal(rep.ok, true);
  assert.equal(rep.port, stubPort);
  assert.equal(rep.tray.ok, true);
  assert.equal(rep.shortcut.ok, true);
  assert.equal(rep.shortcut.held, true);
  assert.equal(rep.argvBookFiles.length, 1);
  assert.equal(path.basename(rep.argvBookFiles[0]), '测试书.txt');
  // `#347`：深链也要出现在自检报告里（探针据此断「链接唤起」）
  assert.equal(rep.argvSchemeUrls.length, 1);
  assert.equal(rep.argvSchemeUrls[0], schemeUrl);
  assert.equal(rep.prefsFile, process.env.YUEDU_DESKTOP_PREFS);
  /**
   * ★ 这里断言 `isElectron === false` 是**故意的**：本测试跑在普通 node 下（Electron 被桩掉了），
   *   报告里的 `versions.electron` 因此缺失、`isElectron` 为 false。
   *   而 `probe-209-desktop.mjs` 断言的是 `true` —— 同一条判据在两侧都写了一次，
   *   正好证明「报告是不是真 Electron 写出来的」这个区分是有效的。
   */
  assert.equal(rep.isElectron, false);
  assert.equal(typeof rep.versions.node, 'string');
  await waitFor(() => ctx.quitCalled === true, 3000, '自检后应主动退出');
});
