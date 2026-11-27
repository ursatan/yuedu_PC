/**
 * SPDX-License-Identifier: GPL-3.0-only
 *
 * 桥接契约回归（用户 2026-11-08 P0：`e.toggleSmall is not a function`）。
 *
 * 背景：Web 产物与 Electron 外壳可以各自更新 —— 打包后的 `preload.js` 属于外壳，
 * 而页面 JS 可能来自更新的 Web bundle。两边方法名漂移时，运行期只会得到一句
 * `xxx is not a function`，单测/页面探针都拦不住（它们跑在浏览器，不走 preload）。
 *
 * 这组测试把 preload **真正执行**在一个假 electron 沙盒里，拿到
 * `contextBridge.exposeInMainWorld('yuedu', …)` 的**实际方法清单**，然后：
 *  ① 断言小窗/浮条/歌词的关键方法都在；
 *  ② 断言 `apps/web/src/desktop.ts` 里出现的 `b.<method>()` 调用**每一个**都能在 preload 里找到；
 *  ③ 断言关键 IPC 通道在 `main.js` 里有对应 handler（防止 preload 发了没人收）。
 *
 * ⚠️ 证明边界：这保证「名字对齐」，不保证「打包产物真的用了这份 preload」。
 * 后者只能靠重新构建桌面端（`pnpm --filter desktop build` / electron-builder）后实测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const WEB_DESKTOP_TS = path.resolve(DESKTOP, '..', 'web', 'src', 'desktop.ts');

function loadExposed() {
  const sent = [];
  const invoked = [];
  const fakeIpc = {
    on: () => {},
    off: () => {},
    send: (channel, payload) => sent.push({ channel, payload }),
    invoke: (channel, payload) => { invoked.push({ channel, payload }); return Promise.resolve({ ok: true }); },
  };
  const exposed = {};
  const sandbox = {
    require: (name) => {
      if (name === 'electron') {
        return {
          contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
          ipcRenderer: fakeIpc,
        };
      }
      throw new Error(`unexpected require(${name})`);
    },
    console,
  };
  const src = fs.readFileSync(path.join(DESKTOP, 'preload.js'), 'utf8');
  vm.runInNewContext(src, sandbox, { filename: 'preload.js' });
  return { exposed: exposed.yuedu, sent, invoked };
}

test('preload 暴露浮窗两态（常规 / 条形）/ 歌词的完整方法清单', () => {
  const { exposed } = loadExposed();
  assert.ok(exposed && typeof exposed === 'object', '必须 exposeInMainWorld("yuedu")');
  for (const name of [
    'getFloatState', 'toggleFloat', 'setFloatMode', 'closeFloat', 'onFloatState',
    'floatReading', 'onFloatCommand',
    'lyricsState', 'onLyricsCommand', 'onLyricsEnabled',
  ]) {
    assert.equal(typeof exposed[name], 'function', `preload 缺少方法 ${name}（前端会报 is not a function）`);
  }
  // 旧的小窗三档整套必须消失（不留双轨）
  for (const name of ['getSmallState', 'toggleSmall', 'setSmallTier', 'onSmallState', 'getFloatSettings']) {
    assert.equal(exposed[name], undefined, `preload 不该再暴露旧方法 ${name}`);
  }
});

test('浮窗 / 歌词方法真的发到主进程对应通道', () => {
  const { exposed, invoked, sent } = loadExposed();
  exposed.setFloatMode('bar');
  assert.equal(invoked.at(-1).channel, 'yuedu:float-mode');
  exposed.getFloatState();
  assert.equal(invoked.at(-1).channel, 'yuedu:float-get');
  exposed.toggleFloat(true);
  assert.equal(invoked.at(-1).channel, 'yuedu:float-open');
  exposed.closeFloat();
  assert.equal(invoked.at(-1).channel, 'yuedu:float-close');
  exposed.floatReading({ lines: ['x'], index: 0, total: 1, updatedAt: 1 });
  assert.equal(sent.at(-1).channel, 'yuedu:float-reading');
  exposed.lyricsState({});
  assert.equal(sent.at(-1).channel, 'yuedu:lyrics-state');
});

test('desktop.ts 里所有 b.<method>() 都能在 preload 找到（拦截命名漂移）', () => {
  const { exposed } = loadExposed();
  const src = fs.readFileSync(WEB_DESKTOP_TS, 'utf8');
  const calls = new Set();
  for (const m of src.matchAll(/\bb\.([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
  for (const m of src.matchAll(/\bbridge\(\)\?\.([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
  assert.ok(calls.size > 0, '应当能在 desktop.ts 里找到桥接调用');
  // 这些是**旧外壳**的兼容回退名（`getMiniState` 那代 + 冻结中的 ReaderOverlay 仍引用的
  // `getSmallState` 那代）：当前 preload 刻意不再暴露，调用前有 typeof 守卫。
  // 除了它们，desktop.ts 里出现但 preload 没有的方法都属于真实漂移。
  const LEGACY_FALLBACKS = new Set([
    'getMiniState', 'toggleMini', 'onMiniState',
    'getSmallState', 'toggleSmall', 'setSmallTier', 'onSmallState',
  ]);
  for (const name of calls) {
    if (LEGACY_FALLBACKS.has(name)) continue;
    assert.equal(typeof exposed[name], 'function', `desktop.ts 调用了 preload 没有的 ${name}()`);
  }
});

test('关键 IPC 通道在 main.js 里有 handler / 发送点', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  for (const channel of [
    'yuedu:float-get', 'yuedu:float-open', 'yuedu:float-mode', 'yuedu:float-close', 'yuedu:float-state',
    'yuedu:float-reading', 'yuedu:float-command', 'yuedu:float-hover', 'yuedu:float-update',
    'yuedu:float-move', 'yuedu:float-patch', 'yuedu:float-panel', 'yuedu:float-height', 'yuedu:float-focusable',
    'yuedu:lyrics-state', 'yuedu:lyrics-command', 'yuedu:lyrics-enabled', 'yuedu:lyrics-close',
  ]) {
    assert.ok(src.includes(channel), `main.js 缺少通道 ${channel}（preload 发了没人收）`);
  }
});
