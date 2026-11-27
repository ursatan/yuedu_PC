/**
 * bundle 后置补丁：让 server-bundle.mjs / dom-worker.mjs 彻底自包含（零外部文件依赖）。
 *  1. jsdom 的 default-stylesheet.css fs.readFileSync → 内联 css 内容
 *  2. css-tree 的 createRequire("../data/patch.json") → 内联 JSON
 * 每个补丁必须命中，否则抛错（构建失败早暴露）。
 *
 * 用法：node patch-bundle.mjs [目标文件] [最少命中数]
 *   · 默认 apps/desktop/server-bundle.mjs，最少 3/3；
 *   · `#743` 的 dom-worker.mjs 只用到 jsdom 解析/选择，可能不含 css-tree 两处 ⇒ `--min=1`。
 *
 * ★ 匹配 esbuild 重命名后的 `fs2` / `path10` / `require4` 这类名字时用 `\d*`（**不能**用 `\d?`）：
 *   编号是 esbuild 按「bundle 里有几个同名 import」排的，新增任何一个 `import fs from 'node:fs'`
 *   的模块都可能让它从个位涨到两位（实测：加一个 `apps/server/src/local-book-file.ts`
 *   ⇒ `fs.readFileSync` 变 `fs10.readFileSync` ⇒ `\d?` 失配 ⇒ 构建以「命中 2/3」失败）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argTarget = process.argv[2];
const minPatched = Number(process.argv[3] ?? 3) || 3;
const bundlePath = argTarget ? path.resolve(here, argTarget) : path.join(here, 'server-bundle.mjs');
let src = fs.readFileSync(bundlePath, 'utf-8');
let patched = 0;

// 1) default-stylesheet.css 内联
let cssPath = path.resolve(here, '../../node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css');
if (!fs.existsSync(cssPath)) {
  // 兼容 .pnpm 布局
  const alt = path.resolve(here, '../../node_modules/.pnpm/jsdom@30.0.1/node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css');
  if (fs.existsSync(alt)) { cssPath = alt; } else { throw new Error('找不到 jsdom default-stylesheet.css'); }
}
const css = fs.readFileSync(cssPath, 'utf-8');
const cssRe = /fs\d*\.readFileSync\(\s*path\d*\.resolve\(__dirname,\s*"\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\s*\{\s*encoding:\s*"utf-8"\s*\}\s*\)/;
if (cssRe.test(src)) {
  src = src.replace(cssRe, () => JSON.stringify(css));
  patched++;
}

// 2) css-tree patch.json 内联（require2 为 createRequire(import.meta.url) 的实例）
const patchPath = path.resolve(here, 'data/patch.json');
if (!fs.existsSync(patchPath)) throw new Error('找不到 apps/data/patch.json（先跑 build-server.sh）');
const patchJson = JSON.stringify(JSON.parse(fs.readFileSync(patchPath, 'utf-8')));
const patchRe = /require\d*\("\.\.\/data\/patch\.json"\)/;
if (patchRe.test(src)) {
  src = src.replace(patchRe, () => patchJson);
  patched++;
}

// 3) css-tree version.js：createRequire 相对定位在 bundle 中错位 → 内联版本号
let cssTreePkg = path.resolve(here, '../../node_modules/css-tree/package.json');
if (!fs.existsSync(cssTreePkg)) {
  const alt = path.resolve(here, '../../node_modules/.pnpm/css-tree@3.2.1/node_modules/css-tree/package.json');
  if (fs.existsSync(alt)) cssTreePkg = alt;
}
const cssTreeVersion = JSON.parse(fs.readFileSync(cssTreePkg, 'utf-8')).version;
const verRe = /\(\{ version \} = require\d*\("\.\.\/package\.json"\)\);/;
if (verRe.test(src)) {
  src = src.replace(verRe, `({ version } = { version: ${JSON.stringify(cssTreeVersion)} });`);
  patched++;
}

// 4) css-tree data.js 依赖的三份 mdn-data JSON：bundle 里 `require3("mdn-data/css/…")`
//    在仓库内能顺着 node_modules 解析到，**打包态**（便携 exe 解包到 %TEMP%，旁边没有 node_modules）
//    必崩 `Cannot find module 'mdn-data/css/at-rules.json'`（#764 实测）⇒ 与上面同理内联。
let mdnDir = path.resolve(here, '../../node_modules/mdn-data');
if (!fs.existsSync(mdnDir)) {
  const pnpmRoot = path.resolve(here, '../../node_modules/.pnpm');
  const hit = fs.existsSync(pnpmRoot) ? fs.readdirSync(pnpmRoot).find((n) => n.startsWith('mdn-data@')) : undefined;
  if (hit) mdnDir = path.join(pnpmRoot, hit, 'node_modules/mdn-data');
}
if (!fs.existsSync(mdnDir)) throw new Error('找不到 mdn-data（css-tree 的 CSS 数据依赖）');
for (const name of ['at-rules', 'properties', 'syntaxes']) {
  const json = JSON.stringify(JSON.parse(fs.readFileSync(path.join(mdnDir, 'css', `${name}.json`), 'utf-8')));
  const re = new RegExp(`require\\d*\\("mdn-data/css/${name}\\.json"\\)`);
  if (re.test(src)) {
    src = src.replace(re, () => json);
    patched++;
  }
}

if (patched < minPatched) throw new Error(`补丁未全部命中（命中 ${patched}，要求 ≥${minPatched}）——esbuild 输出形态可能变化`);
fs.writeFileSync(bundlePath, src);
console.log(`${path.basename(bundlePath)} 补丁完成：${patched} 处（要求 ≥${minPatched}），最终大小 ${(src.length / 1048576).toFixed(1)}MB`);
