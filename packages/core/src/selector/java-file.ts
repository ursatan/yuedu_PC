/**
 * `#613` / `#615` —— `java.getFile` / `readFile` / `getTxtInFolder` / `unzipFile` / `getZip*Content`。
 *
 * ★ 上游依据（`F:\legado`，今日版 `app/src/main/java/io/legado/app/help/JsExtensions.kt`）：
 *   · `getFile(path)`（`:802-816`）：相对路径 → `appCtx.externalCache + path` 的 `File`；
 *     **越出 `externalCache.parentFile` 抛 `SecurityException("非法路径")`**；
 *   · `readFile(path)`（`:818-825`）：`file.exists()` ⇒ `file.readBytes()`，否则 `null`；
 *   · `readTxtFile(path[, charset])`（`:827-842`）：同上，按 `EncodingDetect` 自动判编码；
 *   · `deleteFile(path)`（`:846`）、`getTxtInFolder(path)`（`:907-925`，读目录内所有文本、`\n` 连接，**读后删目录**）；
 *   · `unArchiveFile/unzipFile`（`:877-886`）：解压到 `TEMP_FOLDER/<md5Encode16(文件名)>`，返回**相对路径**；
 *   · `getZipByteArrayContent(url, path)`（`:973-995`）：`url` 是绝对 URL ⇒ `AnalyzeUrl.getByteArray()`，
 *     否则按 **hex 字符串**解码；再 `ZipInputStream` 逐条比对 `entry.name == path` 取字节；
 *   · `getZipStringContent(url, path[, charset])`（`:928-943`）：上者的字节 → 字符串（自动判编码或指定）。
 *
 * ## 本仓落地（与上游的差异都写明）
 *   1. **安全目录**：上游是 App 的 `externalCache`；本仓是 `YUEDU_JAVA_FILE_DIR`
 *      （默认 `<DATA_DIR>/java-files`）。**同样做越界检查**，越界抛「非法路径」——
 *      不给书源脚本任意路径读文件的能力（与 `#612` 的 ClassShutter 同一立场）。
 *   2. **读顺序**：① 文件层（`js-file.ts`，`downloadFile`/`importScript`/`cacheFile` 的落点，
 *      与既有 `readTxtFile` 行为一致、**不回退**）→ ② 真文件系统（安全目录内）。
 *      PC/服务端有文件系统，本地书 txt/epub 走 ②。
 *   3. **不删目录**：上游 `getTxtInFolder` 读完 `FileUtils.delete(folder)`；本仓**不删**
 *      （源脚本触发的删除不可控，且读后即删对调试极不友好）—— 有意偏离，注释写明。
 *   4. **zip 只做 zip**：`un7zFile`/`unrarFile`/`getRarStringContent`/`get7zStringContent` 需要
 *      7z/rar 解码器，本仓没有（上游靠 `LibArchiveUtils`）；语料 0 命中 ⇒ 暂不实现，
 *      调用时留痕返回空（不静默）。
 *   5. **URL 分支只取文本面**：本仓同步传输（curl/`hostRpc http`）只有文本面
 *      （与 `java.downloadFile` 单参形态同一限制，见 `js.ts` 注释）⇒ zip 的 URL 分支
 *      按文本取回后转字节，**二进制可能受损**，故留痕 warn。hex 分支（语料主要形态）无损。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { fileCacheKey, readScriptFile } from './js-file';
import type { ScriptFileLayer } from './js-file';
import { readCentralDirectory, readEntryBy } from '../local-book/zip';

/** 上游 `MD5Utils.md5Encode16`（unArchiveFile 的目录名用） */
function md5Encode16Text(s: string): string {
  return createHash('md5').update(s, 'utf-8').digest('hex').slice(8, 24);
}

/** 安全目录（上游 `appCtx.externalCache`） */
export function javaFileRoot(): string {
  const dir = process.env['YUEDU_JAVA_FILE_DIR'] || path.join(process.env['YUEDU_DATA_DIR'] || 'data', 'java-files');
  return path.resolve(dir);
}

/**
 * 相对路径 → 安全目录内的绝对路径；**越界返回 null**（上游抛 `SecurityException("非法路径")`）。
 * 上游还有「`parentFile` 内即可」的宽松判定，本仓收紧到「必须在安全目录内」。
 */
export function resolveJavaFilePath(p: unknown): { abs: string; rel: string } | null {
  const rel = String(p ?? '').replace(/^[/\\]+/, '');
  const root = javaFileRoot();
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return { abs, rel: rel || '' };
}

function securityError(p: unknown): Error {
  return new Error(`非法路径（安全目录 ${javaFileRoot()}）：${String(p ?? '').slice(0, 120)}`);
}

/** 文件层里存的可能是 `data:` URL（downloadFile 的落点）⇒ 还原成字节 */
function layerBytes(layer: ScriptFileLayer | undefined, key: string): Uint8Array | null {
  const text = readScriptFile(layer, key);
  if (text == null) return null;
  const m = /^data:[^;,]*;base64,([\s\S]*)$/i.exec(text);
  if (m) {
    try {
      return new Uint8Array(Buffer.from(m[1] as string, 'base64'));
    } catch {
      return null;
    }
  }
  return new Uint8Array(Buffer.from(text, 'utf-8'));
}

function fsBytes(abs: string): Uint8Array | null {
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return new Uint8Array(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/** ① 文件层 → ② 文件系统 */
function readBytesOf(layer: ScriptFileLayer | undefined, p: unknown): Uint8Array | null {
  const r = resolveJavaFilePath(p);
  if (!r) throw securityError(p);
  return layerBytes(layer, fileCacheKey(String(p ?? ''))) ?? fsBytes(r.abs);
}

function decodeText(bytes: Uint8Array, charset?: unknown): string {
  const cs = String(charset ?? '').trim();
  if (cs) {
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch {
      /* 未知编码名：落到 utf-8 */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** zip 字节来源：绝对 URL ⇒ 同步取文本再转字节；否则按 hex 解码（上游 `HexUtil.decodeHex`） */
function zipSourceBytes(src: string, fetchText?: (url: string) => string): Uint8Array | null {
  const s = String(src ?? '').trim();
  if (/^https?:\/\//i.test(s)) {
    if (!fetchText) return null;
    return new Uint8Array(Buffer.from(fetchText(s), 'utf-8'));
  }
  // hex（上游非 URL 分支）
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  if (!hex || hex.length % 2 !== 0) return null;
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function zipEntryBytes(bytes: Uint8Array, entryPath: string): Uint8Array | null {
  try {
    const arch = readCentralDirectory(bytes);
    const e = arch.byName.get(entryPath);
    if (!e) return null;
    return readEntryBy(bytes, e);
  } catch {
    return null;
  }
}

export interface JavaFileApiHooks {
  /** 同步 HTTP（文本面）：`getZip*Content` 的 URL 分支用 */
  fetchText?: (url: string) => string;
  warn?: (tag: string, msg: string) => void;
}

/**
 * `#613`/`#615` 的 `java.*` 面。
 *
 * @param layer 文件层（与 `makeScriptFileApi` 同一份：`downloadFile`/`importScript`/`cacheFile` 的落点）
 */
export function makeJavaFileApi(layer: ScriptFileLayer | undefined, hooks: JavaFileApiHooks = {}) {
  const warn = hooks.warn ?? (() => undefined);
  const fetchText = hooks.fetchText;

  /**
   * `java.getFile(path)` → 上游是 `java.io.File`；本仓无 JDK 对象，给**同形态的 JS 对象**
   * （`exists/getName/getPath/getAbsolutePath/getCanonicalPath/length/readBytes/list` +
   * `toString()` = 绝对路径）。语料里的用法就是 `String(f)` / `f.getAbsolutePath()`
   * （`data/imported-sources.json`：千白羽系拼 `file://` 绝对路径）。
   */
  const getFile = (p: unknown): Record<string, unknown> => {
    const r = resolveJavaFilePath(p);
    if (!r) throw securityError(p);
    const bytes = readBytesOf(layer, p);
    const isDir = (() => {
      try {
        return fs.existsSync(r.abs) && fs.statSync(r.abs).isDirectory();
      } catch {
        return false;
      }
    })();
    return {
      exists: () => bytes != null || isDir,
      isFile: () => bytes != null,
      isDirectory: () => isDir,
      getName: () => path.basename(r.abs),
      getPath: () => r.abs,
      getAbsolutePath: () => r.abs,
      getCanonicalPath: () => r.abs,
      length: () => bytes?.byteLength ?? 0,
      readBytes: () => bytes ?? null,
      readText: (charset?: unknown) => (bytes ? decodeText(bytes, charset) : ''),
      toString: () => r.abs,
    };
  };

  const readFile = (p: unknown): Uint8Array | null => {
    const r = resolveJavaFilePath(p);
    if (!r) throw securityError(p);
    return readBytesOf(layer, p);
  };

  /** `readTxtFile(path[, charset])`：文件层 → FS → 空串（与既有行为一致） */
  const readTxtFile = (p: unknown, charset?: unknown): string => {
    const bytes = readBytesOf(layer, p);
    if (!bytes) return '';
    return decodeText(bytes, charset);
  };

  /**
   * `getTxtInFolder(path)`：目录内所有文本 `\n` 连接。
   * ★ 有意偏离：上游读完 `FileUtils.delete(folder)`，本仓**不删**（见文件头第 3 条）。
   */
  const getTxtInFolder = (p: unknown): string => {
    const r = resolveJavaFilePath(p);
    if (!r) throw securityError(p);
    try {
      if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isDirectory()) return '';
      const names = fs.readdirSync(r.abs).sort();
      const parts: string[] = [];
      for (const n of names) {
        const b = fsBytes(path.join(r.abs, n));
        if (b) parts.push(decodeText(b));
      }
      return parts.join('\n');
    } catch {
      return '';
    }
  };

  /**
   * `unArchiveFile` / `unzipFile`：解压到 `tmp/<md5Encode16(文件名)>`，返回**相对路径**
   * （上游 `ArchiveUtils.TEMP_FOLDER_NAME + "/" + MD5Utils.md5Encode16(zipFile.name)`）。
   * 7z/rar 无解码器 ⇒ 留痕返回空（上游靠 `LibArchiveUtils`）。
   */
  const unArchiveFile = (zipPath: unknown, kind = 'zip'): string => {
    const rel = String(zipPath ?? '');
    if (!rel) return '';
    const bytes = readBytesOf(layer, zipPath);
    if (!bytes) {
      warn(`unzip:${rel.slice(0, 60)}`, `java.${kind}File('${rel.slice(0, 120)}') 源 zip 不存在`);
      return '';
    }
    if (kind !== 'zip') {
      warn(`unzip:${kind}`, `java.${kind}File 需要 ${kind} 解码器，本仓没有（上游 LibArchiveUtils）`);
      return '';
    }
    try {
      const arch = readCentralDirectory(bytes);
      const dir = path.join('tmp', md5Encode16Text(path.basename(rel)));
      const out = resolveJavaFilePath(dir);
      if (!out) return '';
      fs.mkdirSync(out.abs, { recursive: true });
      for (const e of arch.entries) {
        if (e.name.endsWith('/')) continue;
        const target = path.resolve(out.abs, e.name);
        if (!target.startsWith(out.abs + path.sep)) continue; // 防 zip slip（上游也没有，但本仓必须挡）
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, readEntryBy(bytes, e));
      }
      return dir;
    } catch (e) {
      warn(`unzip:${rel.slice(0, 60)}`, `解压失败：${e instanceof Error ? e.message : String(e)}`);
      return '';
    }
  };

  /** `getZipByteArrayContent(url, path)`（上游 `:973-995`） */
  const getZipByteArrayContent = (url: unknown, entryPath: unknown): Uint8Array | null => {
    const src = String(url ?? '');
    const bytes = zipSourceBytes(src, fetchText);
    if (!bytes) {
      warn(`zip:${src.slice(0, 60)}`, `java.getZip*Content 取不到 zip 字节（URL 分支需要 fetchText；非 URL 分支按 hex 解码）`);
      return null;
    }
    if (/^https?:\/\//i.test(src)) {
      warn(
        `zip:url:${src.slice(0, 60)}`,
        'java.getZip*Content 的 URL 分支走文本面同步传输，二进制 zip 可能受损（本仓同步传输只有文本面）',
      );
    }
    const hit = zipEntryBytes(bytes, String(entryPath ?? ''));
    if (!hit) warn(`zip:entry:${String(entryPath).slice(0, 60)}`, `zip 内没有条目 ${String(entryPath).slice(0, 120)}`);
    return hit;
  };

  /** `getZipStringContent(url, path[, charset])`（上游 `:928-943`） */
  const getZipStringContent = (url: unknown, entryPath: unknown, charset?: unknown): string => {
    const b = getZipByteArrayContent(url, entryPath);
    return b ? decodeText(b, charset) : '';
  };

  return {
    getFile,
    readFile,
    readTxtFile,
    getTxtInFolder,
    unzipFile: (p: unknown) => unArchiveFile(p, 'zip'),
    unArchiveFile: (p: unknown) => unArchiveFile(p, 'zip'),
    un7zFile: (p: unknown) => unArchiveFile(p, '7z'),
    unrarFile: (p: unknown) => unArchiveFile(p, 'rar'),
    getZipStringContent,
    getZipByteArrayContent,
  };
}
