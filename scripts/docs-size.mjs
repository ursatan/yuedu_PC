#!/usr/bin/env node
/**
 * docs 阈值体检（`#263`）
 *
 * 口径（`docs/README.md` §阈值维护）：
 *   - live/   单文件正文**非空白字符** 目标 3000~4500、容忍到 **5000**
 *   - archive/ 是快照区（含 2026-11-25 并入的 `archive/logs/` 旧流水），**不设上限**（只列出来看规模）
 *   - notes-xxx / agent-notes 属 live，同 5000
 *
 * 为什么要这个脚本：`#263` 的教训是「阈值只能靠人肉记」⇒ 三个月内两次超标都没人发现。
 * 落成脚本后 `pnpm check:docs` 一跑就出表，超标项 exit 1（可挂 CI / 提交前自检）。
 *
 * ★ 计数用**非空白字符**（`\s` 全去掉）—— 与 `#257` 收尾时的实测口径一致，
 *   **不是**字节数、也**不是**行数。中文一字算 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

// 用户 2026-10-20 拍板：全部放宽 ×1.5（5000→7500 · 8000→12000）
export const LIMIT_LIVE = 7500;
export const LIMIT_LOGS = 12000;

/**
 * 用户 2026-10-24 拍板：**评估 / 调研 / 比对类报告要详细、全面，不做字数限制**。
 *
 * 但「完全不设上限」会让这类文件悄悄长成没人敢改的巨物（`#263` 的教训是阈值要可执行），
 * 所以给一个**远大于普通 live** 的上限（30000 非空白字符 ≈ 普通 live 的 4 倍）：
 *  · 足够写完「上游全清单 + 本仓对表 + 编号任务 + 验收标准」（实测需要 15000~25000）；
 *  · 又仍然是一条能触发轮换/拆分的硬线，不会无限膨胀。
 * 识别方式：文件名带 `-parity-` / `-gaps-` / `-sample-` / `-audit-` 的 live 文档。
 * 若哪天真要写超 30000，按日志的惯例**拆成 `-2` / `-3` 续篇**（而不是把上限再抬）。
 */
export const LIMIT_REPORT = 30000;
/** 评估/调研/比对报告的文件名特征（live 目录内生效） */
export const REPORT_NAME_RE = /-(?:parity|gaps|sample|audit)-/;

/** 非空白字符数 —— 本仓统一口径 */
export function nonWsChars(s) {
  return s.replace(/\s/g, '').length;
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * @returns {Array<{rel:string, chars:number, limit:number|null, over:boolean, bucket:string, mtime:number}>}
 *
 * ★ **logs 豁免规则**（`#263` → `#632` 冻结）：logs 铁律是「**只追加、绝不修改删除已有内容**」⇒ 已封存日志
 *   根本没法「精简」，超标是**历史事实**、不是待办。2026-10-26 起 logs 全目录冻结（新记录改走 `rounds/`），
 *   因此**整个 logs/ 一律豁免**（不再有「mtime 最新的那个 = 正在写的」这种判断）。
 */
export function scan() {
  const rows = [];
  for (const abs of walk(DOCS)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const chars = nonWsChars(fs.readFileSync(abs, 'utf8'));
    const mtime = fs.statSync(abs).mtimeMs;
    let limit = null;
    let bucket = 'other';
    if (rel.startsWith('docs/live/')) {
      limit = REPORT_NAME_RE.test(path.basename(rel)) ? LIMIT_REPORT : LIMIT_LIVE;
      bucket = 'live';
    } else if (rel.startsWith('docs/rounds/')) {
      // #632 轮次文件＝历史事实：只追加、永不修改 ⇒ 不设上限（只统计）
      bucket = 'rounds';
    } else if (rel.startsWith('docs/archive/')) {
      bucket = 'archive';
    }
    rows.push({ rel, chars, limit, over: limit !== null && chars > limit, bucket, mtime });
  }

  rows.sort((a, b) => b.chars - a.chars);
  return rows;
}

// ---- CLI ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rows = scan();
  const pad = (n, w) => String(n).padStart(w);
  console.log('bucket    chars  limit  mark  file');
  console.log('--------  -----  -----  ----  ----');
  for (const r of rows) {
    const mark = r.over ? '  ✗ 超' : r.limit ? '  ok' : '  -';
    console.log(
      r.bucket.padEnd(8) + '  ' + pad(r.chars, 5) + '  ' + pad(r.limit ?? '-', 5) + mark + '  ' + r.rel,
    );
  }
  const over = rows.filter((r) => r.over);
  console.log('\n合计 ' + rows.length + ' 个 .md；超标 ' + over.length + ' 个');
  if (over.length) {
    console.log('超标清单：');
    for (const r of over) console.log('  ' + r.rel + '  ' + r.chars + ' > ' + r.limit);
    process.exitCode = 1;
  }
}
