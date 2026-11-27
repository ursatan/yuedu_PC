/**
 * `#462` 打包清单锁：**主进程 require 的本仓库文件，必须都在 `build.files` 里**。
 *
 * ## 为什么必须单独锁（用户 2026-10-15 实测）
 * 用户重打后的 exe **打不开**，报 `Error: Cannot find module './lib-webview-pool'`：
 * `#453` 往 `main.js` 加了 `const viewpoolLib = require('./lib-webview-pool')`，
 * 但 `package.json` 的 `build.files` 清单**只列了 main.js / preload.js / desktop-lib.js / …**，
 * 没跟着加 `lib-webview-pool.js` ⇒ electron-builder 不把它打进 asar ⇒ 一启动就崩。
 *
 * ★ 为什么 `main-smoke.test.mjs`（用 Electron 桩真跑 main.js）抓不到：在**开发树**里
 *   `require('./lib-webview-pool')` 当然找得到 —— 桩测的是「调用序列对不对」，
 *   测不到「打包清单漏没漏」。所以这条锁必须**读 package.json 的 files 清单**来判。
 *
 * ⚠️ 判据只覆盖**本仓库的本地文件**（`require('./x')` / `require('../x')`），
 *    第三方包与 `node_modules` 不归它管（electron-builder 自己会带）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = process.cwd(); // apps/desktop（`pnpm --filter @yuedu/desktop test` 的 cwd）
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const FILES = (pkg.build?.files ?? []).filter((f) => typeof f === 'string');

/** 主进程 / preload 里「本仓库文件」的 require 目标 */
function localRequires(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    // 只认「相对路径的 js/mjs/json」；带扩展名就不补
    const withExt = /\.(js|mjs|cjs|json)$/.test(spec) ? spec : `${spec}.js`;
    out.add(withExt.replace(/^\.\//, ''));
  }
  return [...out];
}

/** 极简 glob 匹配：支持 `**` 与 `*`（够用即可，别在这里重造 minimatch） */
function covered(relPath) {
  const name = basename(relPath);
  for (const pattern of FILES) {
    if (pattern === relPath || pattern === name) return true;
    if (/^[*][.][a-z]+$/.test(pattern) && relPath.endsWith(pattern.slice(1))) return true; // "*.js"
    if (pattern.endsWith('/**/*') && relPath.startsWith(pattern.slice(0, -5))) return true; // "dir/**/*"
  }
  return false;
}

test('#462 主进程 require 的本仓库文件都必须在 build.files 里（否则打出来的 exe 一启动就崩）', () => {
  assert.ok(FILES.length > 0, 'build.files 必须是显式清单（空清单会让 electron-builder 用默认规则，另有一堆坑）');
  const all = [...localRequires('main.js'), ...localRequires('preload.js')];
  assert.ok(all.length > 0, '至少应解析到一个本地 require（否则本锁的判据失效，实现可能变了）');
  for (const rel of all) {
    assert.ok(existsSync(join(ROOT, rel)), `require 的目标文件不存在：${rel}（实现与文件已漂移）`);
    assert.ok(covered(rel), `build.files 缺 ${rel} ⇒ 打包后 asar 里没有它，启动即 Cannot find module`);
  }
});

test('#462 用户报障的那个文件必须显式在清单里（回归锁）', () => {
  // 用户 2026-10-15 实测：`Cannot find module './lib-webview-pool'`
  assert.ok(FILES.includes('lib-webview-pool.js'), 'lib-webview-pool.js 必须在 build.files（#453 起 main.js 依赖它）');
  // 运行时**必须**进包的两项（服务端 bundle 与 xhr 同步 worker）
  for (const f of ['server-bundle.mjs', 'xhr-sync-worker.js']) {
    assert.ok(covered(f), `${f} 必须在 build.files（服务端与同步 XHR 都靠它）`);
  }
});

/**
 * ★ release-818 实机：`apps/web/dist` 还是 11/9 的旧构建（只认 small-* API），
 * 而 desktop preload 已是 float-* ⇒ 小窗打不开、报 `desktop-shell-outdated`。
 * 根因之一是 `prepare-dist.mjs` 只在 dist **不存在**时才构建 ⇒ 旧产物被原样打包。
 * 这里锁死：每次打包都必须重建 web 产物，不再有「存在就跳过」的分支。
 */
test('#818 web-dist 每次打包都要重建（旧 dist 会与新 preload 不同代）', () => {
  const src = readFileSync(join(ROOT, 'prepare-dist.mjs'), 'utf8');
  assert.ok(
    !src.includes("if (!fs.existsSync(path.join(webDist, 'index.html')))"),
    '不能再用「dist 存在就跳过构建」——旧产物会混进 release',
  );
  assert.match(src, /'vite', 'build'/, 'prepare-dist 必须调用 web 构建');
});

/**
 * 发布形态（2026-11-25 改版，见 docs/ref/server-shell-form-options-2026-11-24.md）：
 * **只发布 zip** —— 解压即用，首次运行由 main.js 自建「悦读」「悦读服务」两个快捷方式
 * （后者带 `--server-only`，同一份 exe，不额外下载第二个 74 MB）。
 * 安装器（NSIS）**只保留方案描述、不落地**：`setup.exe` 是全新未签名的 hash，
 * SAC 照样拦，套在 zip 里也一样；要出安装包必须等代码签名。
 */
test('发布形态：只发 zip + 两个自建快捷方式；安装器不落地', () => {
  const win = pkg.build?.win ?? {};
  assert.deepEqual(win.target, ['zip'], '之后版本只发布 zip（portable 不再作为发布形态）');
  assert.equal(pkg.build?.nsis, undefined, '安装器只保留方案描述：未签名的新 hash 仍会被 SAC 拦');
  assert.equal(existsSync(join(ROOT, 'installer.nsh')), false, '安装器脚本不应再随代码存在');

  // 服务快捷方式要「看起来是另一个程序」，图标必须是 loose 文件（asar 里的不能当 .lnk 图标）
  const res = pkg.build?.extraResources ?? [];
  assert.ok(
    res.some((r) => r && r.from === 'assets/icon-server.ico'),
    '服务快捷方式图标要作为 extraResources 随包',
  );
  const ico = readFileSync(join(ROOT, 'assets', 'icon-server.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved 字段');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type=1');

  // 自建快捷方式的调用点必须在（纯计划在 desktop-lib，写 .lnk 在 main）
  const mainSrc = readFileSync(join(ROOT, 'main.js'), 'utf8');
  assert.match(mainSrc, /ensureGreenShortcuts\(\)/, 'main.js 必须在启动期调用自建快捷方式');
  assert.match(mainSrc, /--server-only/, '服务入口靠 --server-only 区分（同一份 exe）');
});

