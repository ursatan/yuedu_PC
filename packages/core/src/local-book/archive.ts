/**
 * 压缩包批量导入（`#212` Step3）
 *
 * ## 做什么
 * 把一个 `.zip` 当**容器**：枚举其中的条目，挑出可导入的本地书文件
 * （`.txt` / `.epub` / `.umd`），逐本调用 `importLocalBook` 装配成「待入库」结果。
 *
 * ## 为什么只做 zip，不做 rar/7z
 * zip 的**中央目录 + STORED/DEFLATE** 用 Node 自带 `zlib` 就能读完（见 `zip.ts`）；
 * rar / 7z 的压缩算法（RAR 专有 / LZMA）**没有纯 JS 实现**，要么引原生二进制、
 * 要么引大依赖。`#212` 的口径是「**移植优先、允许引 npm 包**」，但 Native 依赖在
 * Electron + Web 自托管两条线上都会带来额外的分发问题 ⇒ **先只做 zip**，
 * rar/7z 遇到时**明确报错**并说清原因（铁律 3，不静默跳过）。
 *
 * ## 关键口径（都与「想当然」不同）
 * 1. **不递归进子目录是错的** —— 真实书库常是「分类/书.zip」两层，所以要**递归**枚举。
 * 2. **跳过 macOS 打包垃圾**：`__MACOSX/`、`._*`、`.DS_Store` —— 它们是资源派生文件，
 *    会被误判成书（`.txt` 只是个空壳文件），导入进去就是几本空书。
 * 3. **单个条目失败不中断整包** —— 一个坏 epub 不该让另外 50 本导不进来；
 *    失败条目**逐条带原因**返回（铁律 3：兜底必须留痕）。
 * 4. **本函数不落库** —— 与 `importLocalBook` 同一分层，只产出「待入库」数据，
 *    由服务端决定写盘与 upsert（与既有单本导入路径完全一致）。
 * 5. **上限护栏** —— 一个 zip 里可能塞几千个文件（有人把整个书库打成一个包）；
 *    `maxBooks` 默认 300，超出**不静默丢弃**，而是在结果里标记 `truncated`。
 */

import { importLocalBook, isSupportedLocalBook, type ImportLocalBookOptions, type LocalBookImport } from './index';
import { readCentralDirectory, readEntryBy } from './zip';

/** 压缩包里一个条目的导入结果 */
export interface ArchiveItemResult {
  /** zip 内的路径（带子目录） */
  entry: string;
  /** 成功时的解析结果（与单本导入同型） */
  book?: LocalBookImport;
  /** 失败原因（面向用户） */
  error?: string;
}

export interface ArchiveImportResult {
  /** 逐条结果（成功 + 失败混排，保持 zip 内顺序） */
  items: ArchiveItemResult[];
  /** 成功导入的条目数 */
  ok: number;
  /** 失败的条目数 */
  failed: number;
  /** 因超过 `maxBooks` 而**未尝试**的条目数（>0 时调用方应提示用户） */
  skipped: number;
}

export interface ArchiveImportOptions extends ImportLocalBookOptions {
  /**
   * 最多尝试导入几本（默认 300）。
   *
   * ⚠️ 不是「最多能解析几本」的技术限制，而是**防止一次请求打爆内存/CPU**：
   *    每个 epub 解析都要读全部 XHTML 算字数（见 `epubChapterWordCounts` 注释）。
   */
  maxBooks?: number;
  /**
   * 单本文件名解析用（zip 内的 basename；`analyzeFileName` 靠它猜书名/作者）。
   * 不传则用条目路径的 basename。
   */
  charsetHint?: string | null;
}

const DEFAULT_MAX_BOOKS = 300;

/** macOS / 资源派生垃圾（这些路径里不会有真书） */
function isJunkEntry(name: string): boolean {
  if (name.endsWith('/')) return true; // 目录项
  if (name.startsWith('__MACOSX/')) return true;
  if (name.includes('/__MACOSX/')) return true;
  if (name.startsWith('._') || name.includes('/._')) return true;
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini') return true;
  return false;
}

/** 从 zip 内路径取 basename（`importLocalBook` 只认文件名，不认路径） */
function baseNameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 枚举 zip 里**可导入的条目**（保持 zip 内顺序）。
 *
 * 只做筛选，不解压 —— 交给后续 `parseArchive` / 调用方按需解。
 */
export function listArchiveBooks(buf: Uint8Array): { entry: string; name: string }[] {
  const { entries } = readCentralDirectory(buf);
  const out: { entry: string; name: string }[] = [];
  for (const e of entries) {
    if (isJunkEntry(e.name)) continue;
    const base = baseNameOf(e.name);
    if (!isSupportedLocalBook(base)) continue;
    out.push({ entry: e.name, name: base });
  }
  return out;
}

/**
 * 批量解析一个压缩包（不落库）。
 *
 * `opts.charsetHint` 透传给 txt 解析；`opts.epubWordCount` 若显式传 `false`
 * 可显著提速（批量导入时字数不是必需）。
 */
export function importLocalBookArchive(buf: Uint8Array, opts: ArchiveImportOptions = {}): ArchiveImportResult {
  const maxBooks = opts.maxBooks ?? DEFAULT_MAX_BOOKS;
  const candidates = listArchiveBooks(buf);
  const { byName } = readCentralDirectory(buf);

  const items: ArchiveItemResult[] = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of candidates) {
    if (ok + failed >= maxBooks) {
      skipped++;
      continue;
    }
    const e = byName.get(c.entry);
    if (!e) {
      // 理论上不可达（listArchiveBooks 就是从同一张表来的）；留痕不静默
      items.push({ entry: c.entry, error: '条目在解压前消失了（zip 内同名重复？）' });
      failed++;
      continue;
    }
    try {
      const bytes = readEntryBy(buf, e);
      if (!bytes.length) throw new Error('条目是空的');
      const parsed = importLocalBook(bytes, c.name, opts.charsetHint ?? null, {
        epubWordCount: opts.epubWordCount,
        splitLongChapter: opts.splitLongChapter,
      });
      items.push({ entry: c.entry, book: parsed });
      ok++;
    } catch (err) {
      items.push({ entry: c.entry, error: String(err instanceof Error ? err.message : err) });
      failed++;
    }
  }

  return { items, ok, failed, skipped };
}
