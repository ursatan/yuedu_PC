/**
 * 本地书「记录里的文件名 → 磁盘路径」的**唯一实现**（`#228` / `#217`）。
 *
 * ## 为什么抽出来（`#247`：同一判据写两处必然漂移）
 * `content` / `asset` / `file` 三个端点都要做同一件事：
 *   `originName` 为空时**从主键反推**文件名 → 拼路径 → 校验没跳出目录 → 校验文件还在。
 * 这段逻辑以前在三个端点里各内联一遍（`asset` 的注释甚至写着「复用同一套逻辑」，
 * 实际是复制粘贴）⇒ 改一处漏两处只是时间问题。
 *
 * ## ★ `#228`：这个函数**绝不能抛**
 * 症状（`#227` 探针，2026-10-03）：关掉阅读浮层重开后、从详情页点目录进正文 ⇒
 * 前端显示「正文加载失败：Internal Server Error」。
 *
 * 根因链（每一环都实测过）：
 *  1. 本地书主键由**前端**算（`loc_book\0{"fileName":"x.txt"}`），文件名只在 payload 里；
 *  2. **前端契约里没有 `originName`** ⇒ 任何一次 `PUT /api/user/books`（同步进度 /
 *     改分组 / 换封面）都用 `{...emptyShelfBook(), ...body}` 把它**覆盖成 `''`**；
 *  3. 旧代码 `localBookPath(book.originName ?? '')` 直接抛「文件名越界」，
 *     而**那行在 try 之外** ⇒ Fastify 兜成裸 500（没有 JSON 信封，所以前端只能显示
 *     `Internal Server Error` 这么一句说不清的话）。
 *
 * ⇒ 契约：**所有失败都走 `ok:false` + 4xx + 说清原因**，一个异常都不往外冒。
 *   `apps/server/src/index.ts` 不导出任何东西（单体入口，单测 import 不到），
 *   所以这段必须住在一个能被测的文件里 —— 否则 `#228` 永远只是「手工验过一次」。
 *
 * 运行：`pnpm --filter @yuedu/server test`
 */
import fs from 'node:fs';
import path from 'node:path';

import { fileNameFromLocalBookUrl } from '@yuedu/core';

/** 反推 / 校验失败的三种原因 —— 都回 410（不是 500，见文件头 `#228`） */
export type LocalBookFileError =
  | 'LOCAL_FILE_NAME_UNKNOWN'
  | 'LOCAL_FILE_NAME_INVALID'
  | 'FILE_MISSING';

/**
 * 解析结果（判别联合：`ok` 为假时**一定**带 `status`/`error`/`detail`，调用方直接回即可）。
 */
export type LocalBookFile =
  | { ok: true; fileName: string; filePath: string }
  | {
      ok: false;
      status: 410;
      error: LocalBookFileError;
      detail: string;
      fileName: string;
      bookUrl: string;
    };

/**
 * 只保留**文件名**，去掉任何目录成分。
 *
 * 两个必须拦的东西：① `../` 穿越（`path.basename` 去掉目录后仍要再判一次）；
 * ② Windows 非法字符（`:` `*` `?` 等，写文件会直接失败）。
 *
 * ⚠️ 这是**导入侧**用的（把用户给的名字洗成能落盘的名字）；读取侧走 `resolveLocalBookFile`
 * —— 那边**不洗名字**（洗了反而可能找不到库里已存的文件），只做越界校验。
 */
export function safeLocalBookName(raw: string): string {
  let base = raw;
  try {
    base = decodeURIComponent(raw);
  } catch {
    /* 不是合法 URL 编码就按原样用 */
  }
  base = path.basename(base).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  if (!base || base === '.' || base === '..') throw new Error('文件名无效');
  if (base.length > 180) throw new Error('文件名过长（>180 字符）');
  return base;
}

/** 由文件名得到磁盘路径（拼完再校验一次没跳出目录 —— 双保险） */
export function localBookPath(dir: string, fileName: string): string {
  const p = path.resolve(dir, fileName);
  const root = path.resolve(dir) + path.sep;
  if (!p.startsWith(root)) throw new Error('文件名越界');
  return p;
}

/**
 * 这本书**该用哪个文件名** —— 反推的唯一实现（取不到返回 `''`，不抛）。
 *
 * 单独导出是因为 `asset` 端点要**先判格式再取文件**（不是 epub 就 400 NOT_EPUB，
 * 不能等 `resolveLocalBookFile` 先去 `existsSync`）⇒ 它只需要这一步。
 */
export function localBookFileName(
  book: { originName?: string | null } | null | undefined,
  bookUrl: string,
): string {
  // ★ `#217`：**先**反推，**再**用它判任何东西。旧代码先 `extOf(book.originName ?? '')`
  //   判 epub ⇒ `originName` 被前端写空时，一本真 epub 会被误判成「非 epub」回 400。
  return book?.originName || fileNameFromLocalBookUrl(bookUrl);
}

/**
 * ★ 本地书取文件的**唯一入口**：反推 → 拼路径 → 越界校验 → 存在性，一次做完。
 *
 * @param dir  `LOCAL_BOOK_DIR`（`<DATA_DIR>/local-books`）—— 传进来而不是读模块级常量，
 *             是为了让单测能用临时目录跑真文件（`index.ts` 的 `DATA_DIR` 在 import 时就定了）。
 * @param book 书架那一行。**只看它的 `originName`**：为空就从 `bookUrl` 反推。
 *             （`#217`：写时归一在 `normalizeLocalBookOriginName`，这里是读侧的兜底 ——
 *               两处都必须有，因为库里可能躺着老版本写入的脏行。）
 */
export function resolveLocalBookFile(
  dir: string,
  book: { originName?: string | null } | null | undefined,
  bookUrl: string,
): LocalBookFile {
  const fileName = localBookFileName(book, bookUrl);
  if (!fileName) {
    return {
      ok: false,
      status: 410,
      error: 'LOCAL_FILE_NAME_UNKNOWN',
      detail: '这本书的记录里既没有文件名、也从 bookUrl 里解析不出来（数据异常）—— 重新导入一次即可',
      fileName: '',
      bookUrl,
    };
  }
  let filePath = '';
  try {
    filePath = localBookPath(dir, fileName);
  } catch (e) {
    // 越界只可能来自「文件名里有 ../」这类脏数据 ⇒ 给 410 + 原因，不冒充 500
    return {
      ok: false,
      status: 410,
      error: 'LOCAL_FILE_NAME_INVALID',
      detail: `文件名不合法：${String(e instanceof Error ? e.message : e)}`,
      fileName,
      bookUrl,
    };
  }
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      status: 410,
      error: 'FILE_MISSING',
      detail: `本地文件已不在：${fileName}（把文件放回 ${dir} 后重试，或删除这本书）`,
      fileName,
      bookUrl,
    };
  }
  return { ok: true, fileName, filePath };
}
