/**
 * `#208` 最小 ZIP **读写**器（服务端 / 桌面侧）—— 写：直链上传的 `compress` 与 `#208` ④ 整库备份；读：④ 的恢复。
 *
 * ## 为什么自己写
 * 与读侧（`core/src/local-book/epub.ts`）同一理由：ZIP 容器格式本身很简单
 * （本地头 + 数据 + 中央目录 + EOCD），而 Node 自带 `zlib.deflateRawSync`
 * ⇒ 自己写比引依赖更可控，也少一个要审计的包。（读侧注释见 `epub.ts:1-8`。）
 *
 * - **写**：`createZip` / `zipSingleFile` —— 给直链上传的 `compress` 与 `#208` ④ 的整库备份用。
 * - **读**：`readZip` / `readZipEntry` —— 给 `#208` ④ 的**恢复**用（把备份 zip 解回快照 json）。
 *   读的实现与 `epub.ts` 同源（先找 EOCD、再走中央目录、按 method 0/8 解），
 *   但 epub 那份是**私有**的（绑死在 epub 解析上），这里做成通用出入口。
 *
 * ## 上游对照
 * `DirectLinkUpload.upLoad()` 在 `rule.compress == true` 时调
 * `ZipUtils.zipByteArray(bytes, fileName)`（`app/src/main/java/io/legado/app/utils/compress/ZipUtils.kt:37`）：
 * `ZipOutputStream` + `putNextEntry(ZipEntry(fileName))` + `write(bytes)` ——
 * 即**单个条目、条目名 = 原文件名、默认 DEFLATED 压缩**。本文件 `zipSingleFile` 与之逐条对应。
 *
 * ## 与上游的两处有意差异（写明理由）
 * 1. **压缩后反而更大时退回 STORED（method 0）**。上游 `ZipOutputStream` 不会退，
 *    但源文件 json 只有几 KB 时 deflate 头部开销会超过收益 —— 退不退都能正常解压，
 *    这里选「体积更小」的那一种，属于无害优化。
 * 2. **时间戳可注入**（`mtime`）。上游取系统当前时间；这里默认也取当前时间，
 *    但允许传固定值 ⇒ 单测可以逐字节断言产物（否则每次跑出来的字节都不同）。
 *
 * ⚠️ 一个必须记住的边界：本实现**不写 ZIP64**。单条目 ≥ 4GiB 时字段会溢出
 * ⇒ 明确抛错，而不是生成一个「看起来是 zip 但解不开」的文件（铁律 3：不静默兜底）。
 *
 * ## `#621`：装配实现已收拢到 `@yuedu/core` 的 `assembleZip`
 * 原先 facade 与 core（`core/src/export/zip-write.ts`，`#620` 为导出 epub 而写）各有一套
 * 本地头/中央目录/EOCD 的字段装配 —— 两套实现意味着**一处改了另一处没改**就会产出
 * 「本仓自己都读不回来」的 zip。按 `#247`/`#588` 的教训（同一判据不写两处），
 * 这里只保留**服务端注入口**：压缩函数用 `node:zlib`，装配交给 core。
 * 本文件仍导出 `crc32`（core 那份的转发），因为读侧与外部调用方在用它。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32, zipFilesSync } from '@yuedu/core';

export { crc32 };

export interface ZipEntryInput {
  /** zip 内条目名（**用 `/` 分隔**，不要用 `\`） */
  name: string;
  data: Uint8Array;
}

export interface ZipWriteOptions {
  /** 条目时间（写进 DOS 时间字段）；默认当前时间（与上游 `ZipOutputStream` 一致） */
  mtime?: Date;
}

/**
 * 打一个 zip。每个条目**独立**决定用 DEFLATED(8) 还是 STORED(0)（取体积更小者）。
 */
export function createZip(entries: readonly ZipEntryInput[], opts: ZipWriteOptions = {}): Uint8Array {
  return zipFilesSync(
    entries.map((e) => ({ path: e.name, data: e.data })),
    (d) => new Uint8Array(deflateRawSync(d, { level: 6 })),
    // 上游 `ZipOutputStream` 用当前时间；core 默认 1980（为「同输入同字节」），
    // 所以这里显式把 facade 的既有语义（默认当前时间）喂回去，不改动外部可见行为。
    { mtime: opts.mtime ?? new Date() },
  );
}

/** 单条目 zip —— 对齐上游 `ZipUtils.zipByteArray(bytes, fileName)` */
export function zipSingleFile(name: string, data: Uint8Array, opts: ZipWriteOptions = {}): Uint8Array {
  return createZip([{ name, data }], opts);
}

/* ------------------------------------------------------------------ *
 * 读侧（`#208` ④ 恢复备份用）
 * ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export interface ZipReadEntry {
  name: string;
  /** 0 = STORED，8 = DEFLATED */
  method: number;
  size: number;
  compressedSize: number;
}

/** 找 End of Central Directory（末尾最多 64KB 内；zip 注释最长 65535 字节） */
function findEocd(dv: DataView): number {
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 65557); i -= 1) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 读出 zip 的**条目表**（不解压数据）。
 *
 * 为什么不顺着 local header 走：local header 的 `compressedSize` 可能被写成 0
 * （流式写入的 zip 常见），而中央目录里是真的，且只有中央目录才有本地头的偏移。
 */
export function listZipEntries(buf: Uint8Array): ZipReadEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipReadEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== CEN_SIG) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, size, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 取一个条目的原始字节（按需解压） */
export function readZipEntry(buf: Uint8Array, name: string): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== CEN_SIG) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const headerOffset = dv.getUint32(p + 42, true);
    const entryName = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (entryName === name) {
      if (dv.getUint32(headerOffset, true) !== LOC_SIG) throw new Error(`本地头损坏：${name}`);
      const lNameLen = dv.getUint16(headerOffset + 26, true);
      const lExtraLen = dv.getUint16(headerOffset + 28, true);
      const dataStart = headerOffset + 30 + lNameLen + lExtraLen;
      const csize = dv.getUint32(p + 20, true);
      const raw = buf.subarray(dataStart, dataStart + (csize || size));
      if (method === 0) return raw;
      if (method === 8) return new Uint8Array(inflateRawSync(raw));
      throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 里没有这个条目：${name}`);
}

/** 便捷：把整个 zip 解成 `名字 → 字节`（**只解 STORED/DEFLATED**；其它 method 抛错） */
export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const e of listZipEntries(buf)) out.set(e.name, readZipEntry(buf, e.name));
  return out;
}
