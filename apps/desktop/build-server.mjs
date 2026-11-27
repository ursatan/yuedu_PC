#!/usr/bin/env node
/**
 * `build-server.sh` 的 Windows 原生 node 等价入口（不依赖 sh/sed/cp）。
 *
 * 用法：
 *   node apps/desktop/build-server.mjs
 *
 * 产物：apps/desktop/server-bundle.mjs（electron 外置；jsdom/css-tree 内联 + patch-bundle 后置补丁）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
process.chdir(root);

const out = path.join(here, 'server-bundle.mjs');
execFileSync(process.execPath, [
  'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild',
  'apps/server/src/index.ts',
  '--bundle', '--platform=node', '--format=esm',
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  `--outfile=${out}`,
  '--external:electron',
], { stdio: 'inherit' });

// sh 版用 sed 把 esbuild 的 import_meta = {} 补成带 url 的对象
let src = fs.readFileSync(out, 'utf8');
const patched = src.replace(
  /import_meta(\d*) = \{ ?\};/g,
  (_, d) => `import_meta${d} = { url: require("node:url").pathToFileURL(__filename).href };`,
);
if (patched !== src) fs.writeFileSync(out, patched);
console.log(`[build] server-bundle.mjs ${(fs.statSync(out).size / 1048576).toFixed(1)}MB`);

fs.mkdirSync(path.join(here, 'data'), { recursive: true });
fs.copyFileSync(
  'node_modules/.pnpm/css-tree@3.2.1/node_modules/css-tree/data/patch.json',
  path.join(here, 'data/patch.json'),
);

let worker;
try {
  worker = execFileSync(process.execPath, ['-e', "console.log(require.resolve('jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js'))"], { encoding: 'utf8' }).trim();
} catch {
  worker = undefined;
}
if (worker && fs.existsSync(worker)) {
  fs.copyFileSync(worker, path.join(here, 'xhr-sync-worker.js'));
} else {
  console.log('[build] warn: 未找到 jsdom 的 xhr-sync-worker.js（仅同步 XHR 用；bundle 其余功能不受影响）');
}

execFileSync(process.execPath, [path.join(here, 'patch-bundle.mjs')], { stdio: 'inherit' });

// `#743` A 轮：DOM 后端常驻 worker —— 单独产出自包含的 dom-worker.mjs（jsdom 内联），
// 与 server-bundle.mjs 同目录；`dom-backend.ts` 在桌面版按同目录 `dom-worker.mjs` 解析入口。
// 必须用 ESM（和主 bundle 同形态）：css-tree 的 `createRequire(import.meta.url)` 只有 ESM +
// 下面的 import_meta 补丁才成立；CJS 下 import.meta.url 是 undefined，worker 一启动就崩。
const workerOut = path.join(here, 'dom-worker.mjs');
execFileSync(process.execPath, [
  'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild',
  'packages/core/src/sandbox/dom-worker-entry.ts',
  '--bundle', '--platform=node', '--format=esm',
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  `--outfile=${workerOut}`,
  '--external:electron',
], { stdio: 'inherit' });
let wsrc = fs.readFileSync(workerOut, 'utf8');
const wpatched = wsrc.replace(
  /import_meta(\d*) = \{ ?\};/g,
  (_, d) => `import_meta${d} = { url: require("node:url").pathToFileURL(__filename).href };`,
);
if (wpatched !== wsrc) fs.writeFileSync(workerOut, wpatched);
console.log(`[build] dom-worker.mjs ${(fs.statSync(workerOut).size / 1048576).toFixed(1)}MB`);
execFileSync(process.execPath, [path.join(here, 'patch-bundle.mjs'), 'dom-worker.mjs', '1'], { stdio: 'inherit' });

// `#746` B1：批处理子进程 —— 同样单独产出（`fork()` 直接跑，不经过主 bundle）。
// 入口解析见 `apps/server/src/batch-runner.ts`：桌面版按同目录 `batch-child.mjs` 命中。
const batchOut = path.join(here, 'batch-child.mjs');
execFileSync(process.execPath, [
  'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild',
  'apps/server/src/batch-child.ts',
  '--bundle', '--platform=node', '--format=esm',
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  `--outfile=${batchOut}`,
  '--external:electron',
], { stdio: 'inherit' });
let bsrc = fs.readFileSync(batchOut, 'utf8');
const bpatched = bsrc.replace(
  /import_meta(\d*) = \{ ?\};/g,
  (_, d) => `import_meta${d} = { url: require("node:url").pathToFileURL(__filename).href };`,
);
if (bpatched !== bsrc) fs.writeFileSync(batchOut, bpatched);
console.log(`[build] batch-child.mjs ${(fs.statSync(batchOut).size / 1048576).toFixed(1)}MB`);
execFileSync(process.execPath, [path.join(here, 'patch-bundle.mjs'), 'batch-child.mjs', '1'], { stdio: 'inherit' });
