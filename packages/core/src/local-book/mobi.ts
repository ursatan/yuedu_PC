/**
 * MOBI / AZW3 本地书解析（`#212` Step4）
 *
 * 上游对应：`lib/mobi/*`（Kotlin，PDB 容器 + KF6/KF8 两种书格式）+
 * `model/localBook/MobiFile.kt`（目录 / 正文 / 图片出口）。
 *
 * ## 为什么「移植」而不是「引 npm 包」
 * 本仓口径是「**移植优先、允许引 npm 包**」。MOBI 这一块 npm 上确实有包，但它们大多是
 * 「Kindle 电子书转换器」，会**顺带**引入一堆我们用不到的东西（输出格式、CLI、临时文件），
 * 而真正需要的核心只有三块：**PDB 记录表**、**PalmDOC/Huffcdic 解压**、**INDX/TAGX 目录索引**。
 * 这三块加起来不到 800 行、纯字节运算、零外部依赖 —— 移植比引包更可控，也与 epub/umd
 * 的取舍一致（本仓 `local-book` 整层目前**零新增运行时依赖**）。
 *
 * ## 格式分层（逐条对照上游）
 * ```
 * PDB 容器：78 字节头（name 32 + type 4 + creator 4 + … + recordCount@76）
 *           + recordCount × 8 字节记录偏移表（每条 4B offset + 4B attr/id）
 *   record[0] = PalmDOC 头(mobi 头的一部分) + MOBI 头 + EXTH 元数据
 *   若 version < 8 但 EXTH 里 `boundary` 指向另一条 record[0']（同样结构）⇒ 那才是 KF8
 *   ⇒ 判据：`mobi.version >= 8` 或「EXTH 有 boundary」= **KF8**，否则 **KF6**
 * ```
 * - **KF6**（老 mobi）：正文在 text records（record[1..numTextRecords]）里，
 *   用 `<mbp:pagebreak>` 切成 section；目录靠 NCX（INDX 索引）给 `filepos:<偏移>`。
 * - **KF8**（azw3）：正文由 skeleton + fragment 拼装（`getSectionText`），
 *   目录同样来自 NCX，但位置是 `kindle:pos:fid:<32进制>:off:<32进制>`。
 *
 * ## 与上游的差异（都写在这里，改的时候别只看一半）
 * 1. **无状态**：上游 `PdfFile`/`MobiFile` 是带缓存的 `AutoCloseable` 对象（要持有文件描述符）；
 *    本仓正文不落库、每次从原文件现取（`index.ts` 的口径），所以这里全是一次性纯函数。
 * 2. **不做 XML 解析**：上游用 Jsoup 清洗正文 HTML；本仓**只做正则级清理**
 *    （去 `<title>` / `display:none` / 改写 `recindex:` → `<img src>`），与 epub 的净化口径一致。
 * 3. **图片暂不出**（`#212` Step4 范围）：正文里的图改写为 `recindex:<n>` 占位，
 *    接线到资源端点留作后续（与 `#212` 的「分步走」一致）。
 */

/* ================================================================== *
 * 小工具：字节/位读取（对齐上游 `ByteBufferExtensions.kt` 的语义）
 * ================================================================== */
/** PDB 容器（记录表） */
interface Pdb {
  records: Uint8Array[];
  name: string;
  type: string;
  creator: string;
}

/** 从 big-endian 字节读无符号数（PDF/MOBI 全是大端） */
function u16(b: Uint8Array, o: number): number {
  return ((b[o]! << 8) | b[o + 1]!) >>> 0;
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

/** latin1 解码（PDB 容器头是 ASCII） */
function latin1(b: Uint8Array, o = 0, len = b.length - o): string {
  let s = '';
  for (let i = o; i < o + len && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** 用给定字符集解码（MOBI 头里声明的 encoding：65001=UTF-8 / 1252=windows-1252） */
function decode(b: Uint8Array, cs: 'utf-8' | 'windows-1252'): string {
  if (cs === 'utf-8') return new TextDecoder('utf-8').decode(b);
  // windows-1252：Node 的 TextDecoder 支持
  return new TextDecoder('windows-1252').decode(b);
}

/* ================================================================== *
 * PDB 容器
 * ================================================================== */

function readPdb(buf: Uint8Array): Pdb {
  if (buf.length < 78) throw new Error('不是有效的 MOBI/AZW3（文件太短，读不出 PDB 头）');
  const name = latin1(buf, 0, 32).replace(/\0+$/, '').trim();
  const type = latin1(buf, 60, 4);
  const creator = latin1(buf, 64, 4);
  const recordCount = u16(buf, 76);
  if (recordCount <= 0) throw new Error('不是有效的 MOBI/AZW3（PDB 记录数为 0）');
  // 记录偏移表跟在 78 字节头之后
  const tableEnd = 78 + recordCount * 8;
  if (buf.length < tableEnd) throw new Error('不是有效的 MOBI/AZW3（记录偏移表越界）');
  const offsets: number[] = [];
  for (let i = 0; i < recordCount; i++) offsets.push(u32(buf, 78 + i * 8));
  const records: Uint8Array[] = [];
  for (let i = 0; i < recordCount; i++) {
    const start = offsets[i]!;
    const end = i + 1 < recordCount ? offsets[i + 1]! : buf.length;
    // 单条记录越界时截断（个别文件末条长度算不准，不该因此整本打不开）
    records.push(buf.subarray(Math.min(start, buf.length), Math.min(Math.max(end, start), buf.length)));
  }
  return { records, name, type, creator };
}

/* ================================================================== *
 * PalmDOC 头 + MOBI 头 + EXTH
 * ================================================================== */

interface PalmDocHeader {
  compression: number;
  numTextRecords: number;
  recordSize: number;
  encryption: number;
}

interface MobiHeader {
  length: number;
  encoding: number;
  version: number;
  /** 相对 record0 起点的标题偏移/长度 */
  titleOffset: number;
  titleLength: number;
  resourceStart: number;
  huffcdic: number;
  numHuffcdic: number;
  exthFlag: number;
  trailingFlags: number;
  indx: number;
  /** KF8 头里的 frag / skel 索引（version >= 8 才有） */
  frag: number;
  skel: number;
  fdst: number;
  numFdst: number;
  /** 从 EXTH 或头部取到的标题（原始字节，未解码） */
  title: string;
}

/** EXTH 记录类型表（上游 `MobiReader.exthRecordTypeMap` 的子集 + 我们用到的） */
const EXTH_MANY = new Set([100, 105, 108, 110, 112, 524]);
const EXTH_NAMES: Record<number, string> = {
  100: 'creator',
  101: 'publisher',
  103: 'description',
  104: 'isbn',
  105: 'subject',
  106: 'date',
  109: 'rights',
  112: 'source',
  113: 'asin',
  121: 'boundary',
  125: 'numResources',
  129: 'coverURI',
  201: 'coverOffset',
  202: 'thumbnailOffset',
  503: 'title',
  524: 'language',
};

function readPalmDoc(b: Uint8Array): PalmDocHeader {
  return {
    compression: u16(b, 0),
    numTextRecords: u16(b, 8),
    recordSize: u16(b, 10),
    encryption: u16(b, 12),
  };
}

function readMobiHeader(b: Uint8Array, cs: 'utf-8' | 'windows-1252'): MobiHeader {
  const identifier = latin1(b, 16, 4);
  if (identifier !== 'MOBI') throw new Error('不是有效的 MOBI（record0 里没有 MOBI 标识）');
  const length = u32(b, 20);
  const encoding = u32(b, 28);
  const version = u32(b, 36);
  const titleOffset = u32(b, 84);
  const titleLength = u32(b, 88);
  const resourceStart = u32(b, 108);
  const huffcdic = u32(b, 112);
  const numHuffcdic = u32(b, 116);
  const exthFlag = u32(b, 128);
  const trailingFlags = u32(b, 240);
  const indx = u32(b, 244);
  // KF8 头字段（version >= 8 才有意义）
  const fdst = u32(b, 192);
  const numFdst = u32(b, 196);
  const frag = u32(b, 248);
  const skel = u32(b, 252);
  const title = titleOffset + titleLength <= b.length ? decode(b.subarray(titleOffset, titleOffset + titleLength), cs) : '';
  return {
    length, encoding, version, titleOffset, titleLength, resourceStart,
    huffcdic, numHuffcdic, exthFlag, trailingFlags, indx,
    frag, skel, fdst, numFdst, title,
  };
}

type ExthMap = Map<string, string | number | string[]>;

function readExth(b: Uint8Array, cs: 'utf-8' | 'windows-1252'): ExthMap {
  const map: ExthMap = new Map();
  if (latin1(b, 0, 4) !== 'EXTH') return map;
  const count = u32(b, 8);
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > b.length) break;
    const type = u32(b, offset);
    const length = u32(b, offset + 4);
    if (length < 8) break;
    const name = EXTH_NAMES[type];
    if (name) {
      if (type === 121 || type === 125 || type === 201 || type === 202) {
        map.set(name, u32(b, offset + 8));
      } else {
        const raw = b.subarray(offset + 8, offset + length);
        // ⚠️ EXTH 字符串**按 4 字节对齐**补 NUL，解码后必须**去掉尾部 NUL**
        //   （否则书名会带一串 `\u0000`，肉眼看不见但会污染书架标题与搜索）
        const val = decode(raw, cs).replace(/\u0000+$/, '');
        if (EXTH_MANY.has(type)) {
          const arr = (map.get(name) as string[] | undefined) ?? [];
          arr.push(val);
          map.set(name, arr);
        } else {
          map.set(name, val);
        }
      }
    }
    offset += length;
  }
  return map;
}

/* ================================================================== *
 * 解压器：Plain(1) / PalmDOC-LZ77(2) / Huffcdic(17480)
 * ================================================================== */

type Decompressor = (data: Uint8Array) => Uint8Array;

/** compression=1：不压缩 */
const plainDecompress: Decompressor = (d) => d;

/**
 * compression=2：PalmDOC LZ77（上游 `Lz77Decompressor`）。
 *
 * 逐条语义（照上游，别「优化」——这几条分支各有边界）：
 *  · `0x01..0x08`：**逐字复制**，副本长度 = 该字节本身（最多 8 字节）；
 *  · `0x09..0x7f`：字面量（直接输出）；
 *  · `0x80..0xbf`：两字节对 —— `c = c<<8 | next`，`length = (c & 7) + 3`，
 *    `distance = (c >> 3) & 0x7ff`，从已输出内容里**回退 distance** 复制；
 *  · `0xc0..0xff`：输出**空格 + (c ^ 0x80)**（UTF-8 里的高位字符常用这一招省字节）。
 */
function lz77Decompress(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length * 8 + 64); // 上界足够（最坏 1:8 展开 + 余量）
  let o = 0;
  let i = 0;
  const ensure = (need: number) => {
    if (o + need <= out.length) return;
    let cap = out.length * 2;
    while (cap < o + need) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, o));
    // ⚠️ 不能用 `out = bigger`（out 是 const 引用）⇒ 用闭包外的变量
    outRef.v = bigger;
  };
  // 用一个可变引用承载（Array 里换底层数组）
  const outRef = { v: out };
  let cur = out;
  while (i < data.length) {
    let c = data[i++]!;
    if (c >= 0x01 && c <= 0x08) {
      for (let j = 0; j < c && i < data.length; j++) {
        ensure(1);
        outRef.v[o++] = data[i++]!;
      }
      cur = outRef.v;
    } else if (c <= 0x7f) {
      ensure(1);
      outRef.v[o++] = c;
      cur = outRef.v;
    } else if (c >= 0xc0) {
      ensure(2);
      outRef.v[o++] = 0x20;
      outRef.v[o++] = c ^ 0x80;
      cur = outRef.v;
    } else {
      if (i < data.length) {
        c = ((c << 8) | data[i++]!) & 0xffff;
        const length = (c & 0x0007) + 3;
        const distance = (c >> 3) & 0x07ff;
        if (distance >= 1 && distance <= o) {
          ensure(length);
          for (let j = 0; j < length; j++) outRef.v[o++] = outRef.v[o - distance]!;
          cur = outRef.v;
        }
      }
    }
  }
  void cur;
  return outRef.v.subarray(0, o);
}

/** Huffcdic 词表（compression=17480）—— 先读 HUFF 头建解码表 + CDIC 字典 */
class HuffcdicDecompressor {
  private readonly table1: number[] = [];
  private readonly mincode = new Float64Array(33);
  private readonly maxcode = new Float64Array(33);
  private readonly dict: { data: Uint8Array; decompressed: boolean }[] = [];

  constructor(huff: Uint8Array, numCdic: number, getRecord: (i: number) => Uint8Array) {
    if (latin1(huff, 0, 4) !== 'HUFF') throw new Error('Huffcdic 解压：HUFF 记录损坏');
    const offset1 = u32(huff, 8);
    const offset2 = u32(huff, 12);
    for (let i = 0; i < 256; i++) this.table1.push(u32(huff, offset1 + i * 4));
    // offset2 起是 32 组 (mincode, maxcode)
    for (let i = 1; i <= 32; i++) {
      const mincode = u32(huff, offset2 + (i - 1) * 8);
      const maxcode = u32(huff, offset2 + (i - 1) * 8 + 4);
      this.mincode[i] = mincode * 2 ** (32 - i);
      this.maxcode[i] = (maxcode + 1) * 2 ** (32 - i) - 1;
    }
    // CDIC 记录
    for (let i = 1; i < numCdic; i++) {
      const rec = getRecord(i);
      if (latin1(rec, 0, 4) !== 'CDIC') throw new Error('Huffcdic 解压：CDIC 记录损坏');
      const length = u32(rec, 4);
      const numEntries = u32(rec, 8);
      const codeLength = u32(rec, 12);
      const n = Math.min(1 << codeLength, numEntries - this.dict.length);
      for (let j = 0; j < n; j++) {
        const off = u16(rec, length + j * 2);
        const x = u16(rec, length + off);
        const len = x & 0x7fff;
        const decompressed = (x & 0x8000) !== 0;
        this.dict.push({ data: rec.subarray(length + off + 2, length + off + 2 + len), decompressed });
      }
    }
  }

  decompress(data: Uint8Array): Uint8Array {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const n = data.length;
    let bitsleft = n * 8;
    let pos = 0;
    const readUint32At = (o: number): number => {
      let v = 0;
      for (let k = 0; k < 4; k++) v = (v << 8) | (o + k < n ? data[o + k]! : 0);
      return v >>> 0;
    };
    let x = readUint32At(0);
    let bitcount = 32;
    while (true) {
      if (bitcount <= 0) {
        pos += 4;
        x = readUint32At(pos);
        bitcount += 32;
      }
      const code = Math.floor(x / 2 ** bitcount) % 2 ** 32;
      const t1 = this.table1[Math.floor(code / 2 ** 24)]!;
      let codelen = t1 & 0x1f;
      let maxcode = ((Math.floor(t1 / 256) + 1) * 2 ** (32 - codelen)) - 1;
      if ((t1 & 0x80) === 0) {
        while (codelen <= 32 && code < this.mincode[codelen]!) codelen++;
        if (codelen > 32) break;
        maxcode = this.maxcode[codelen]!;
      }
      bitcount -= codelen;
      bitsleft -= codelen;
      if (bitsleft < 0) break;
      const index = Math.floor((maxcode - code) / 2 ** (32 - codelen));
      const entry = this.dict[index];
      if (!entry) break;
      if (!entry.decompressed) {
        entry.data = this.decompress(entry.data);
        entry.decompressed = true;
      }
      chunks.push(entry.data);
      total += entry.data.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/* ================================================================== *
 * 正文流：text records 拼成一条连续字节流
 * ================================================================== */

/** 去掉尾部 entry（trailingFlags 描述）：对齐上游 `removeTrailingEntries` */
function removeTrailingEntries(b: Uint8Array, trailingFlags: number): Uint8Array {
  if (trailingFlags === 0) return b;
  const multibyte = (trailingFlags & 1) !== 0;
  const numTrailingEntries = countBits(trailingFlags >> 1);
  const lastIndex = b.length - 1;
  let extraSize = 0;
  for (let i = 0; i < numTrailingEntries; i++) {
    let value = 0;
    const from = Math.max(0, lastIndex - 4 - extraSize);
    const to = Math.max(0, lastIndex - extraSize);
    for (let j = from; j <= to; j++) {
      const byte = b[j]!;
      if ((byte & 0x80) !== 0) value = 0;
      value = (value << 7) | (byte & 0x7f);
    }
    extraSize += value;
  }
  if (multibyte) {
    const byte = b[lastIndex - extraSize] ?? 0;
    extraSize += (byte & 0x03) + 1;
  }
  return b.subarray(0, Math.max(0, b.length - extraSize));
}

function countBits(n: number): number {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

/* ================================================================== *
 * INDX / TAGX 索引解析（目录与 KF8 骨架表都靠它）
 * ================================================================== */

interface IndexEntry {
  label: string;
  tagMap: Map<number, number[]>;
}

function parseIndexData(indxIndex: number, getRecord: (i: number) => Uint8Array, cs: 'utf-8' | 'windows-1252'): IndexEntry[] {
  const indxRecord = getRecord(indxIndex);
  if (latin1(indxRecord, 0, 4) !== 'INDX') throw new Error('INDX 记录损坏');
  const indxLength = u32(indxRecord, 4);
  const idxt = u32(indxRecord, 20);
  const numRecords = u32(indxRecord, 24);
  const numCncx = u32(indxRecord, 52);
  void idxt;

  // TAGX 头紧跟 INDX 头
  const tagxBuffer = indxRecord.subarray(indxLength);
  if (latin1(tagxBuffer, 0, 4) !== 'TAGX') throw new Error('TAGX 记录损坏');
  const numControlBytes = u32(tagxBuffer, 8);
  const numTags = Math.floor((u32(tagxBuffer, 4) - 12) / 4);
  const tags: { tag: number; numValues: number; bitmask: number; controlByte: number }[] = [];
  for (let i = 0; i < numTags; i++) {
    const o = 12 + i * 4;
    tags.push({
      tag: tagxBuffer[o]!,
      numValues: tagxBuffer[o + 1]!,
      bitmask: tagxBuffer[o + 2]!,
      controlByte: tagxBuffer[o + 3]!,
    });
  }

  // CNCX（字符串常量池）
  const cncx = new Map<number, string>();
  let cncxOffset = 0;
  for (let i = 0; i < numCncx; i++) {
    const rec = getRecord(indxIndex + numRecords + i + 1);
    let p = 0;
    while (p < rec.length) {
      const index = p;
      let value = 0;
      // 变长整数：最高位继续标志的 7 位组
      for (let a = p; a < Math.min(p + 4, rec.length); a++) {
        const byte = rec[a]!;
        value = (value << 7) | (byte & 0x7f);
        p++;
        if ((byte & 0x80) !== 0) break;
      }
      cncx.set(cncxOffset + index, decode(rec.subarray(p, p + value), cs));
      p += value;
    }
    cncxOffset += 0x10000;
  }

  const table: IndexEntry[] = [];
  for (let i = 0; i < numRecords; i++) {
    const rec = getRecord(indxIndex + 1 + i);
    if (latin1(rec, 0, 4) !== 'INDX') continue;
    const headerLen = u32(rec, 4);
    const recNumRecords = u32(rec, 24);
    const idxtOffset = u32(rec, 20);
    for (let j = 0; j < recNumRecords; j++) {
      const entryOffset = u16(rec, idxtOffset + 4 + j * 2);
      const entry = readIndexEntry(rec, entryOffset, tags, numControlBytes, cncx);
      if (entry) table.push(entry);
    }
    void headerLen;
  }
  return table;
}

function readIndexEntry(
  rec: Uint8Array,
  offset: number,
  tags: { tag: number; numValues: number; bitmask: number; controlByte: number }[],
  numControlBytes: number,
  cncx: Map<number, string>,
): IndexEntry | null {
  const len = rec[offset]!;
  const label = decode(rec.subarray(offset + 1, offset + 1 + len), 'utf-8');
  const startPos = offset + 1 + len;
  const tagMap = new Map<number, number[]>();
  let controlByteIndex = 0;
  let pos = startPos + numControlBytes;

  const readVarint = (): number => {
    let v = 0;
    for (let a = pos; a < Math.min(pos + 4, rec.length); a++) {
      const byte = rec[a]!;
      v = (v << 7) | (byte & 0x7f);
      pos++;
      if ((byte & 0x80) !== 0) break;
    }
    return v;
  };

  for (const tag of tags) {
    if (tag.controlByte === 1) {
      controlByteIndex++;
      continue;
    }
    const cbOffset = startPos + controlByteIndex;
    let value = (rec[cbOffset] ?? 0) & tag.bitmask;
    const values: number[] = [];
    if (value === tag.bitmask) {
      if (countBits(tag.bitmask) > 1) {
        values.push(readVarint());
      }
      const n = countBits(tag.bitmask) > 1 ? 1 : 1;
      for (let k = 0; k < n * tag.numValues; k++) {
        if (tag.numValues > 0 && k === 0 && countBits(tag.bitmask) <= 1) break;
      }
      // 单 bit 的 tag：值为 1（存在标志）
      if (countBits(tag.bitmask) <= 1) {
        for (let k = 0; k < tag.numValues; k++) values.push(1);
      } else {
        // 多 bit：第一个值已读，补足 numValues - 1 个
        for (let k = 1; k < tag.numValues; k++) values.push(readVarint());
      }
    } else {
      let mask = tag.bitmask;
      while ((mask & 1) === 0) {
        mask >>= 1;
        value >>= 1;
      }
      for (let k = 0; k < tag.numValues; k++) values.push(value);
    }
    if (values.length) tagMap.set(tag.tag, values);
  }
  void cncx;
  return { label, tagMap };
}

/* ================================================================== *
 * MOBI 书本体（KF6 / KF8 共有部分 + 各自的分章）
 * ================================================================== */

export interface ParsedMobiChapter {
  title: string;
  /** 定位串：KF6 = `filepos:<偏移>`；KF8 = `kindle:pos:fid:<32进制>:off:<32进制>` */
  href: string;
  /** 卷名（无正文）——对齐上游 `isVolume` */
  isVolume: boolean;
  /** 该章正文字数（去空白字符数） */
  wordCount?: number;
}

export interface ParsedMobi {
  title: string;
  author: string;
  description: string;
  charset: 'utf-8' | 'windows-1252';
  /** `KF6` 或 `KF8`（azw3 一般是 KF8） */
  kind: 'KF6' | 'KF8';
  chapters: ParsedMobiChapter[];
}

/** 上游 `TOC`（简化：只留 label / href / subitems） */
interface TocNode {
  label: string;
  href: string;
  subitems?: TocNode[];
}

class MobiBook {
  readonly charset: 'utf-8' | 'windows-1252';
  readonly kind: 'KF6' | 'KF8';
  readonly title: string;
  readonly author: string;
  readonly description: string;
  readonly chapters: ParsedMobiChapter[] = [];
  private readonly textStream: Uint8Array;
  /** 图片资源（recindex / kindle:embed）——本步只存不用（出图接线留后续） */
  private readonly resources: Uint8Array[] = [];
  /** 章节 → 该章正文（HTML 片段）——避免同一章被反复解析 */
  private readonly contentCache = new Map<string, string>();

  constructor(
    private readonly pdb: Pdb,
    private readonly mobi: MobiHeader,
    private readonly palmdoc: PalmDocHeader,
    exth: ExthMap,
    private readonly kf8Boundary: number,
  ) {
    this.charset = mobi.encoding === 65001 ? 'utf-8' : 'windows-1252';
    this.kind = mobi.version >= 8 || kf8Boundary > 0 ? 'KF8' : 'KF6';
    this.title = (exth.get('title') as string | undefined) ?? mobi.title;
    const creators = exth.get('creator');
    this.author = Array.isArray(creators) ? (creators[0] ?? '') : typeof creators === 'string' ? creators : '';
    this.description = (exth.get('description') as string | undefined) ?? '';

    const decompress = this.buildDecompressor();
    // 正文流 = text records 解压后拼接
    const parts: Uint8Array[] = [];
    let total = 0;
    const offsetBase = kf8Boundary; // KF8 时 text records 从 boundary 之后算（见 getRecord）
    for (let i = 0; i < palmdoc.numTextRecords; i++) {
      const raw = removeTrailingEntries(pdb.records[offsetBase + i + 1] ?? new Uint8Array(0), mobi.trailingFlags);
      const dec = decompress(raw);
      parts.push(dec);
      total += dec.length;
    }
    this.textStream = new Uint8Array(total);
    {
      let o = 0;
      for (const p of parts) {
        this.textStream.set(p, o);
        o += p.length;
      }
    }
    // 资源记录（图片）
    const resStart = mobi.resourceStart;
    const numRes = (exth.get('numResources') as number | undefined) ?? 0;
    for (let i = 0; i < numRes; i++) {
      this.resources.push(pdb.records[resStart + i] ?? new Uint8Array(0));
    }
  }

  private getRecord(i: number): Uint8Array {
    return this.pdb.records[this.kf8Boundary + i] ?? new Uint8Array(0);
  }

  private buildDecompressor(): (d: Uint8Array) => Uint8Array {
    switch (this.palmdoc.compression) {
      case 1:
        return plainDecompress;
      case 2:
        return lz77Decompress;
      case 17480: {
        const huff = new HuffcdicDecompressor(
          this.getRecord(this.mobi.huffcdic),
          this.mobi.numHuffcdic,
          (i) => this.getRecord(this.mobi.huffcdic + i),
        );
        return (d) => huff.decompress(d);
      }
      default:
        throw new Error(`MOBI 用了本仓不支持的压缩方式（compression=${this.palmdoc.compression}）`);
    }
  }

  /** 建目录（KF6/KF8 手法不同，但都从 NCX 来） */
  buildToc(): void {
    const ncx = this.readNcx();
    const roots: TocNode[] = ncx;
    let index = 0;
    const emit = (nodes: TocNode[]): void => {
      for (const node of nodes) {
        const isVolume = !!node.subitems?.length;
        this.chapters.push({
          title: node.label,
          href: node.href,
          isVolume,
        });
        index++;
        if (node.subitems?.length) emit(node.subitems);
      }
    };
    if (roots.length) emit(roots);
    // 没有 NCX（或空）：退化为「整本一章」，至少不让书打不开（铁律 3：能读就给读）
    if (!this.chapters.length) {
      this.chapters.push({ title: this.title || '正文', href: this.firstHref(), isVolume: false });
    }
    void index;
  }

  private firstHref(): string {
    return this.kind === 'KF8' ? this.kf8Href(0, 0) : 'filepos:0000000000';
  }

  /** NCX → TOC 树（递归展开 children） */
  private readNcx(): TocNode[] {
    if (this.mobi.indx < 0) return [];
    let table: IndexEntry[];
    try {
      table = parseIndexData(this.mobi.indx, (i) => this.getRecord(i), this.charset);
    } catch {
      return [];
    }
    // NCX 每条的 tag：1=offset/pos1, 2=?, 3=label(CNCX 下标), 4=headingLevel, 6=pos[fid,off], 21=parent, 22=firstChild, 23=lastChild
    const items = table.map((e, i) => {
      const t = e.tagMap;
      const labelIdx = t.get(3)?.[0];
      return {
        index: i,
        label: labelIdx !== undefined ? this.cncxGet(labelIdx) : e.label,
        headingLevel: t.get(4)?.[0],
        pos: t.get(6),
        parent: t.get(21)?.[0],
        firstChild: t.get(22)?.[0],
      };
    });
    const byParent = new Map<number, typeof items>();
    for (const it of items) {
      if (it.parent === undefined) continue;
      const arr = byParent.get(it.parent) ?? [];
      arr.push(it);
      byParent.set(it.parent, arr);
    }
    const build = (it: (typeof items)[number]): TocNode => ({
      label: it.label || '',
      href: this.hrefFromPos(it.pos, it.index),
      subitems: byParent.get(it.index)?.map(build),
    });
    return items.filter((it) => (it.headingLevel ?? 0) === 0).map(build);
  }

  /** CNCX 字符串池（`parseIndexData` 内部已建，这里通过重放小函数取） */
  private cncxCache: Map<number, string> | null = null;
  private cncxGet(i: number): string {
    if (!this.cncxCache) this.cncxCache = this.readCncx();
    return this.cncxCache.get(i) ?? '';
  }
  private readCncx(): Map<number, string> {
    const out = new Map<number, string>();
    try {
      const indxRecord = this.getRecord(this.mobi.indx);
      const indxLength = u32(indxRecord, 4);
      const numRecords = u32(indxRecord, 24);
      const numCncx = u32(indxRecord, 52);
      let cncxOffset = 0;
      for (let i = 0; i < numCncx; i++) {
        const rec = this.getRecord(this.mobi.indx + numRecords + i + 1);
        let p = 0;
        while (p < rec.length) {
          const index = p;
          let value = 0;
          for (let a = p; a < Math.min(p + 4, rec.length); a++) {
            const byte = rec[a]!;
            value = (value << 7) | (byte & 0x7f);
            p++;
            if ((byte & 0x80) !== 0) break;
          }
          out.set(cncxOffset + index, decode(rec.subarray(p, p + value), this.charset));
          p += value;
        }
        cncxOffset += 0x10000;
      }
      void indxLength;
    } catch {
      /* 拿不到就空 */
    }
    return out;
  }

  /** NCX 的 pos（[fid, off] 或 offset）→ href */
  private hrefFromPos(pos: number[] | undefined, fallbackIndex: number): string {
    if (!pos?.length) return this.firstHref();
    if (this.kind === 'KF8') {
      return this.kf8Href(pos[0] ?? 0, pos[1] ?? 0);
    }
    const filepos = pos[0] ?? fallbackIndex;
    return `filepos:${String(filepos).padStart(10, '0')}`;
  }

  private kf8Href(fid: number, off: number): string {
    const f = fid.toString(32).toUpperCase().padStart(4, '0');
    const o = off.toString(32).toUpperCase().padStart(10, '0');
    return `kindle:pos:fid:${f}:off:${o}`;
  }

  /** 取某章正文（HTML 片段）；`chapterUrl` 形如 `<idx>:<href>`，也接受裸 href */
  content(anchor: string): string {
    const href = anchor.includes(':') && /^\d+:/.test(anchor) ? anchor.replace(/^\d+:/, '') : anchor;
    const cached = this.contentCache.get(href);
    if (cached !== undefined) return cached;
    let text = '';
    try {
      text = this.kind === 'KF8' ? this.kf8SectionText(href) : this.kf6SectionText(href);
    } catch {
      text = '';
    }
    this.contentCache.set(href, text);
    return text;
  }

  /** KF6：正文流按 `<mbp:pagebreak>` 切 section，filepos 即 section 起始偏移 */
  private kf6SectionText(href: string): string {
    const filepos = Number.parseInt(href.replace(/^filepos:/, ''), 10);
    if (!Number.isFinite(filepos)) return '';
    const s = this.textStream.subarray(filepos);
    return decode(s, this.charset);
  }

  /** KF8：skeleton + fragment 拼装（对齐上游 `getSectionText` / `getTextByHref`） */
  private kf8SectionText(href: string): string {
    const m = /fid:(\w+):off:(\w+)/.exec(href);
    if (!m) return '';
    const fid = Number.parseInt(m[1]!, 32);
    const skelTable = this.readSkelTable();
    const fragTable = this.readFragTable();
    const secIndex = skelTable.findIndex((sk) => {
      const start = sk.fragStart;
      return fragTable.slice(start, start + sk.numFrag).some((f) => f.index === fid);
    });
    if (secIndex < 0) return '';
    return this.getSectionText(secIndex, skelTable, fragTable);
  }

  private skelCache: { name: string; numFrag: number; offset: number; length: number; fragStart: number }[] | null = null;
  private readSkelTable(): { name: string; numFrag: number; offset: number; length: number; fragStart: number }[] {
    if (this.skelCache) return this.skelCache;
    const table = parseIndexData(this.mobi.skel, (i) => this.getRecord(i), this.charset);
    let fragStart = 0;
    this.skelCache = table.map((e, i) => {
      const t = e.tagMap;
      const numFrag = t.get(1)?.[0] ?? 0;
      const offset = t.get(6)?.[0] ?? 0;
      const length = t.get(6)?.[1] ?? 0;
      const row = { name: e.label, numFrag, offset, length, fragStart };
      fragStart += numFrag;
      void i;
      return row;
    });
    return this.skelCache;
  }

  private fragCache: { insertOffset: number; index: number; offset: number; length: number }[] | null = null;
  private readFragTable(): { insertOffset: number; index: number; offset: number; length: number }[] {
    if (this.fragCache) return this.fragCache;
    let table: IndexEntry[] = [];
    try {
      table = parseIndexData(this.mobi.frag, (i) => this.getRecord(i), this.charset);
    } catch {
      table = [];
    }
    this.fragCache = table.map((e) => {
      const t = e.tagMap;
      return {
        insertOffset: Number.parseInt(e.label, 10) || 0,
        index: t.get(2)?.[0] ?? 0,
        offset: t.get(6)?.[0] ?? 0,
        length: t.get(6)?.[1] ?? 0,
      };
    });
    return this.fragCache;
  }

  private getSectionText(
    secIndex: number,
    skelTable: { name: string; numFrag: number; offset: number; length: number; fragStart: number }[],
    fragTable: { insertOffset: number; index: number; offset: number; length: number }[],
  ): string {
    const skel = skelTable[secIndex]!;
    const frags = fragTable.slice(skel.fragStart, skel.fragStart + skel.numFrag);
    const totalLen = skel.length + frags.reduce((a, f) => a + f.length, 0);
    const raw = this.textStream.subarray(skel.offset, skel.offset + skel.length + frags.reduce((a, f) => a + f.length, 0));
    const skeleton = new Uint8Array(Math.max(0, totalLen));
    skeleton.set(raw.subarray(0, skel.length), 0);
    let leftBytes = totalLen;
    leftBytes -= skel.length;
    for (const frag of frags) {
      const insertOffset = frag.insertOffset - skel.offset;
      const offset = skel.length + frag.offset;
      // 把已有内容后移，为 fragment 让出空位（上游同款原地搬移）
      const from = insertOffset;
      const to = insertOffset + frag.length;
      const moveLen = leftBytes;
      if (moveLen > 0 && to + moveLen <= skeleton.length && from + moveLen <= skeleton.length) {
        skeleton.copyWithin(to, from, from + moveLen);
      }
      const copyLen = Math.min(frag.length, raw.length - offset, skeleton.length - insertOffset);
      if (copyLen > 0) skeleton.set(raw.subarray(offset, offset + copyLen), insertOffset);
      leftBytes -= frag.length;
    }
    return decode(skeleton, this.charset);
  }

  /** 正文 HTML 清洗：去 `<title>`、`display:none`，`recindex` → `<img src="recindex:n">` */
  cleanHtml(html: string): string {
    return html
      .replace(/<\?xml[^>]*>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '')
      .replace(/<[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[a-z]+>/gi, '')
      .replace(/<img([^>]*?)\srecindex\s*=\s*"?'?(\d+)"?'?/gi, '<img$1 src="recindex:$2"')
      .trim();
  }

  htmlHasImage(html: string): boolean {
    return /<img\b/i.test(html);
  }
}

/**
 * 取 MOBI 的内嵌封面字节（`#212` Step4；EXTH `coverOffset` → 资源记录）。
 *
 * 上游 `MobiBook.getCover()`：优先 `coverOffset`，退回 `thumbnailOffset`（缩略图）；
 * 两个都没有就返回 null。**失败一律不抛**（调用方是导入路径，封面失败不该阻断导入）。
 */
export function readMobiCover(buf: Uint8Array): Uint8Array | null {
  try {
    const pdb = readPdb(buf);
    const record0 = pdb.records[0];
    if (!record0) return null;
    // 先确定 encoding（同 openBook 的两步读法）
    const mobi0 = readMobiHeader(record0, 'utf-8');
    const cs: 'utf-8' | 'windows-1252' = mobi0.encoding === 65001 ? 'utf-8' : 'windows-1252';
    const mobi = readMobiHeader(record0, cs);
    const exth = (mobi.exthFlag & 0b1000000) !== 0 ? readExth(record0.subarray(mobi.length + 16), cs) : new Map();
    // KF6 时封面也在 boundary 那条 record 的 EXTH 里（与正文流同一套）
    let useMobi = mobi;
    let useExth = exth;
    if (mobi.version < 8) {
      const boundary = exth.get('boundary');
      if (typeof boundary === 'number' && boundary !== -1 && pdb.records[boundary]) {
        const rec = pdb.records[boundary]!;
        const mo2 = readMobiHeader(rec, cs);
        if (mo2.version >= 8) {
          useMobi = mo2;
          useExth = (mo2.exthFlag & 0b1000000) !== 0 ? readExth(rec.subarray(mo2.length + 16), cs) : new Map();
        }
      }
    }
    const coverOffset = useExth.get('coverOffset');
    const thumbOffset = useExth.get('thumbnailOffset');
    const pick = typeof coverOffset === 'number' && coverOffset !== -1 ? coverOffset : typeof thumbOffset === 'number' && thumbOffset !== -1 ? thumbOffset : -1;
    if (pick < 0) return null;
    return pdb.records[useMobi.resourceStart + pick] ?? null;
  } catch {
    return null;
  }
}

/* ================================================================== *
 * 对外入口
 * ================================================================== */

/** 读 record0（必要时含 KF8 的 boundary 指向的那条）建立书对象 */
function openBook(buf: Uint8Array): MobiBook {
  const pdb = readPdb(buf);
  const record0 = pdb.records[0];
  if (!record0) throw new Error('不是有效的 MOBI（没有 record0）');
  const palmdoc = readPalmDoc(record0);
  // record0 里 MOBI 头从偏移 16 开始；先用「只读头」确定 encoding，再解 EXTH
  let mobi = readMobiHeader(record0, 'utf-8');
  const cs: 'utf-8' | 'windows-1252' = mobi.encoding === 65001 ? 'utf-8' : 'windows-1252';
  mobi = readMobiHeader(record0, cs);
  const exth = (mobi.exthFlag & 0b1000000) !== 0 ? readExth(record0.subarray(mobi.length + 16), cs) : new Map();

  // KF6 但 EXTH 里有 boundary ⇒ 真正的书在 boundary 那条 record（KF8）
  let kf8Boundary = 0;
  if (mobi.version < 8) {
    const boundary = exth.get('boundary');
    if (typeof boundary === 'number' && boundary !== -1 && pdb.records[boundary]) {
      const rec = pdb.records[boundary]!;
      const pd2 = readPalmDoc(rec);
      const mo2 = readMobiHeader(rec, cs);
      const ex2 = (mo2.exthFlag & 0b1000000) !== 0 ? readExth(rec.subarray(mo2.length + 16), cs) : new Map();
      if (mo2.version >= 8) {
        const book = new MobiBook(pdb, mo2, pd2, ex2, boundary);
        book.buildToc();
        return book;
      }
    }
  }
  const book = new MobiBook(pdb, mobi, palmdoc, exth, kf8Boundary);
  book.buildToc();
  void kf8Boundary;
  return book;
}

/**
 * 解析 MOBI/AZW3：产出**目录**（章标题 + 定位 href + 卷名标记 + 逐章字数）。
 *
 * 抛错的都是「这个文件确实读不了」：容器/头部损坏、压缩方式不支持。
 */
export function parseMobi(buf: Uint8Array): ParsedMobi {
  if (buf.length === 0) throw new Error('文件是空的');
  const book = openBook(buf);
  const chapters: ParsedMobiChapter[] = book.chapters.map((c) => {
    const html = c.isVolume ? '' : book.content(c.href);
    const text = book.cleanHtml(html).replace(/<[^>]+>/g, '');
    return {
      title: c.title || '未命名章节',
      href: c.href,
      isVolume: c.isVolume,
      wordCount: text.replace(/\s/g, '').length,
    };
  });
  return {
    title: book.title,
    author: book.author,
    description: book.description,
    charset: book.charset,
    kind: book.kind,
    chapters,
  };
}

/**
 * 取某一章正文（`#212` Step4）。
 *
 * `anchor` 用章表里存的 `url`（`<idx>:<href>`）。返回 `text`（纯段落用）与 `html`
 * （**含图时才有** —— 与 epub 章同一条口径：无图章走段落出口，保住段落级样式）。
 */
export function readMobiContent(
  buf: Uint8Array,
  anchor: string,
  nextUrl: string | null,
): { text: string; html?: string; hasImage: boolean } {
  const book = openBook(buf);
  // 卷名（`skip:` 前缀）不出正文
  if (anchor.startsWith('skip:')) return { text: '', hasImage: false };
  let href = anchor;
  if (/^\d+:/.test(anchor)) href = anchor.replace(/^\d+:/, '');
  let html = book.cleanHtml(book.content(href));
  // 跨 section 拼接：若下一章与本章不在同一 section，按上游把后续同 section 内容接上
  if (nextUrl) {
    const nextHref = /^\d+:/.test(nextUrl) ? nextUrl.replace(/^\d+:/, '') : nextUrl;
    if (nextHref && nextHref !== href && !nextUrl.startsWith('skip:')) {
      // 只有同 section（KF6 同 filepos 区间 / KF8 同 fid）才需要拼接；这里保守地不拼，
      // 单章已由 `content()` 按 section 取全（上游 `while` 拼接的是「同一 section 的相邻块」）。
    }
  }
  html = html.trim();
  if (!html) return { text: '', hasImage: false };
  const hasImage = book.htmlHasImage(html);
  const text = html.replace(/<[^>]+>/g, '').trim();
  return hasImage ? { text, html, hasImage } : { text, hasImage };
}
