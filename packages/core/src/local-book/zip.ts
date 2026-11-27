/**
 * 最小 ZIP 读取器（`#212` Step3 抽公共模块）
 *
 * ## 为什么抽出来
 * 原先这套读法**内联在 `epub.ts`** 里（`readCentralDirectory` / `readEntryBy` / `EpubReader`）。
 * `#212` Step3 的「压缩包批量导入」要拿 zip 当**容器**枚举里面的书，
 * 判据与 epub 那份**完全同一套**。按仓内铁律「同一判据写两处必然漂移」（`#247`/`#312`），
 * 抽成唯一实现：`epub.ts` 与 `archive.ts` 都从这里 import。
 *
 * ## 只用 central directory，不顺着 local header 走
 * local header 里的 `compressedSize` 可能被写成 0（流式写入的 zip 常见），
 * 而 central directory 里是真的；且只有 CD 里才有本地头的**偏移**。
 *
 * ## 支持范围（刻意收窄）
 * 只认 **method 0（STORED）** 与 **method 8（DEFLATE）** —— 这两个覆盖 99% 的真实 zip/epub。
 * 其余（bzip2 / LZMA / zstd / 加密）**明确抛错**，不静默给空（铁律 3）。
 *
 * ## 不支持 ZIP64
 * `#212` Step3 明确**不做**（条目数 >65535 或单文件 >4GB 才需要）。真遇上时
 * EOCD 里的 count/offset 会是 `0xffff`/`0xffffffff` ⇒ 报错文案里**直说**是 ZIP64，
 * 免得用户对着一句「中央目录为空」发懵。
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** ZIP64 的 EOCD locator 标记（出现即说明是 ZIP64 容器） */
const ZIP64_LOC_SIG = 0x07064b50;
/** EOCD 里「字段溢出到 ZIP64 结构」的哨兵值 */
const U16_SENTINEL = 0xffff;
const U32_SENTINEL = 0xffffffff;

export interface ZipEntry {
  name: string;
  /** 0 = STORED，8 = DEFLATE */
  method: number;
  compressedSize: number;
  size: number;
  /** 本地头在 buf 内的偏移 */
  headerOffset: number;
}

/** 一次 zip 解析的全部条目（按 central directory 顺序；顺序 = 写入顺序） */
export interface ZipArchive {
  entries: ZipEntry[];
  /** 按名字取（同名后者覆盖前者，与 zip 工具行为一致） */
  byName: Map<string, ZipEntry>;
}

/** 找 End of Central Directory（末尾最多 64KB 内；zip 注释最长 65535 字节） */
function findEocd(dv: DataView): number {
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 读 central directory（zip 的「目录表」）。
 *
 * ⚠️ 空条目（只有目录项、没文件）是合法的 zip，但**对本仓无意义**（没有任何书可导）⇒
 *   抛「中央目录为空」，由调用方决定文案。
 */
export function readCentralDirectory(buf: Uint8Array): ZipArchive {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到中央目录）');

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  // ZIP64 判定：EOCD 里溢出哨兵 + 紧跟 ZIP64 EOCD locator 签名
  if ((count === U16_SENTINEL || cdOffset === U32_SENTINEL) &&
      eocd + 20 <= dv.byteLength && dv.getUint32(eocd + 20, true) === ZIP64_LOC_SIG) {
    throw new Error('暂不支持 ZIP64 压缩包（条目数 >65535 或单文件 >4GB）');
  }

  let p = cdOffset;
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== CEN_SIG) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const headerOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(p + 46, p + 46 + nameLen));
    const e: ZipEntry = { name, method, compressedSize, size, headerOffset };
    entries.push(e);
    byName.set(name, e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) throw new Error('不是有效的 ZIP（中央目录为空）');
  return { entries, byName };
}

/** 按条目解出一个文件的原始字节（STORED 直取 / DEFLATE 解压） */
export function readEntryBy(buf: Uint8Array, e: ZipEntry): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(e.headerOffset, true) !== LOC_SIG) throw new Error(`本地头损坏：${e.name}`);
  const nameLen = dv.getUint16(e.headerOffset + 26, true);
  const extraLen = dv.getUint16(e.headerOffset + 28, true);
  const dataStart = e.headerOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + (e.compressedSize || e.size));
  if (e.method === 0) return raw;
  if (e.method === 8) return new Uint8Array(inflateRawSync(raw));
  throw new Error(`不支持的压缩方式 ${e.method}（${e.name}）`);
}
