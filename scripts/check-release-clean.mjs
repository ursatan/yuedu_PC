#!/usr/bin/env node
/**
 * `#153` 发布前自检：**产物里不许有任何源**。
 *
 * ## 为什么需要它
 * 用户已定「源只由用户自己导入/新建；**发布正式版时清除所有源**」（见 `NOTICE.md`）。
 * 打包开关 `YUEDU_RELEASE=1 node apps/desktop/prepare-dist.mjs` 已经做了，
 * 但**约定不是检查** —— 忘了带 `YUEDU_RELEASE=1`，`apps/desktop/` 就会留下上次开发构建的
 * `book-482/`（482 个源）与 `cms/`，**直接打包就带源发布**。
 *
 * ## 判据（写成两档，别混）
 * **失败档（硬证据，判 exit 1）**
 *  A. 产物里存在源目录：`book-482/` · `cms/`（`prepare-dist.mjs` 开发模式的产物）
 *  B. 存在**能 JSON 解析出 `bookSourceName` 字符串字段的文件**（= 真的是源）
 *     ⚠️ 必须走「解析 JSON 再查字段」，**不能全文 grep `bookSourceName`** ——
 *     前端 bundle 里本来就有这个字符串（`WorkshopEditor.vue` 的字段标签
 *     「源名称 (bookSourceName)」）⇒ 全文 grep 会把**每个正常产物**都判失败（本脚本第一版就踩了）。
 * **提示档（不判失败）**：其它文件里出现 `bookSourceName`（例如压缩后的前端 bundle）——
 * 只打印出来让人自己确认，因为它无法区分「界面标签」与「藏起来的源」。
 *
 * 首次运行就抓到过真事：`apps/desktop/release/win-unpacked/resources/book-482` 里有 **477 个源**
 * ——一个**已经打出来的包**带着源。这就是本检查存在的意义。
 *
 * 用法：
 *   node scripts/check-release-clean.mjs                 # 默认查 apps/desktop
 *   node scripts/check-release-clean.mjs dist out        # 查指定目录（可多个）
 * 退出码：0 = 干净；1 = 发现源（**此时不要发布**）
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['apps/desktop'];

/** 源目录名（`prepare-dist.mjs` 开发模式会拷进去） */
const SOURCE_DIRS = ['book-482', 'cms'];
/** 单文件扫描上限：超过就不读（源都是小 JSON，产物里的大文件是二进制/压缩包） */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

const failures = [];
const notices = [];
let scannedJson = 0;

/** 是否是「源对象」：能解析出 JSON 且带 bookSourceName 字符串字段 */
function isSourceJson(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  if (text.includes('\u0000')) return false;
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    const j = JSON.parse(t);
    const objs = Array.isArray(j) ? j : [j];
    return objs.some((o) => o && typeof o === 'object' && typeof o.bookSourceName === 'string');
  } catch {
    return false;
  }
}

function scanFile(path) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (!st.isFile() || st.size > MAX_SCAN_BYTES) return;
  const rel = relative(ROOT, path);

  if (extname(path).toLowerCase() === '.json') {
    scannedJson++;
    if (isSourceJson(path)) failures.push({ kind: '源文件（能解析出 bookSourceName）', path: rel });
    return;
  }
  // 非 JSON：只做「提示档」，绝不判失败（前端 bundle 里就有这个词，见文件头）
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  if (text.includes('\u0000')) return;
  if (text.includes('bookSourceName')) notices.push(rel);
}

function walk(dir) {
  const base = dir.split(/[\\/]/).pop() ?? '';
  if (SOURCE_DIRS.includes(base)) {
    failures.push({ kind: `源目录 ${base}/ 仍在产物里`, path: relative(ROOT, dir) });
    return; // 整个目录都不该出现在产物里
  }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else scanFile(p);
  }
}

console.log('发布前自检：产物里不应有任何源\n');
for (const t of targets) {
  const abs = join(ROOT, t);
  if (!existsSync(abs)) { console.log(`  ⚠️ ${t} 不存在（跳过）`); continue; }
  walk(abs);
}

console.log(`  已解析 ${scannedJson} 个 JSON；硬证据 ${failures.length} 处；提示 ${notices.length} 处\n`);

if (notices.length) {
  console.log('ℹ️ 提示（**不算失败**）：下列非 JSON 文件里出现了 `bookSourceName` ——');
  console.log('   若是压缩后的前端 bundle，多半只是界面字段标签（如「源名称 (bookSourceName)」）；');
  console.log('   但**请自己扫一眼确认**没有把源内联进去：');
  for (const n of notices.slice(0, 10)) console.log(`   · ${n}`);
  if (notices.length > 10) console.log(`   …另有 ${notices.length - 10} 处`);
  console.log('');
}

if (failures.length) {
  console.log('❌ **产物里发现了源 —— 不要发布**：');
  for (const p of failures.slice(0, 30)) console.log(`   · [${p.kind}] ${p.path}`);
  if (failures.length > 30) console.log(`   …另有 ${failures.length - 30} 处`);
  console.log('\n修法：产物目录是在**开发模式**下生成的 ⇒ 用发布模式重跑一次再打包：');
  console.log('     node apps/desktop/prepare-dist.mjs                    # 开发（会拷源，仅本机调试用）');
  console.log('     YUEDU_RELEASE=1 node apps/desktop/prepare-dist.mjs    # ★ 发布（不拷源 + 清掉上次残留）');
  process.exit(1);
}
console.log('✅ 干净：未发现源文件 / 源目录。可以打包发布。');
