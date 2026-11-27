/**
 * `#620` **最小 ZIP 写入器**（只写 / STORE + 可选 DEFLATE）
 *
 * ## 为什么要自己写
 * 导出 txt 不需要容器，导出 **epub 必须**（epub 就是一个按固定结构排布 zip）。
 * 仓内既有的 `local-book/zip.ts` 是**只读**的、且 import 了 `node:zlib`
 * ⇒ 浏览器里用不了。导出要在**前端**跑（见 `buildTxt` 头注：替换规则住在 web），
 * 所以这里零依赖、纯 `Uint8Array`，两端通用。
 *
 * ## 刻意收窄的范围（与 `local-book/zip.ts` 对称）
 * - 只写 method 0（STORED）与 8（DEFLATE）；不写 ZIP64（条目 >65535 / 单文件 >4GB 直接抛）
 * - 不写加密、不写数据描述符（data descriptor）—— 大小在写头时就已知
 * - 时间戳固定用调用方传入的 `mtime`（默认 1980-01-01，与 `zip -X` 的确定性输出一致：
 *   同一份书稿导出两次**字节相同**，diff 才可 review）
 */

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

export interface ZipInputFile {
  /** 归档内路径（`/` 分隔，不能以 `/` 开头） */
  path: string;
  data: Uint8Array;
  /** 强制不压缩（epub 的 `mimetype` **必须**是 STORED 且排在第一个） */
  store?: boolean;
}

/** DEFLATE 压缩钩子：返回 undefined 表示「压不动/不可用」，退回 STORED */
export type DeflateFn = (data: Uint8Array) => Promise<Uint8Array | undefined>;

let CRC_TABLE: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

/** CRC-32（IEEE 802.3，zip 用的那个） */
export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间/日期（`zip -X` 风格：默认 1980-01-01 00:00） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  // DOS 时间从 1980 年起；更早的一律夹到 1980-01-01（zip 规范如此）
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

class ByteSink {
  private buf: Uint8Array;
  private len = 0;
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
  }
  private grow(need: number): void {
    if (this.len + need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u16(v: number): void {
    this.grow(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }
  u32(v: number): void {
    this.grow(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }
  bytes(b: Uint8Array): void {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  get length(): number {
    return this.len;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export interface ZipWriteOptions {
  /** 压缩钩子；不给 ⇒ 全部 STORED（体积大但**永远成功**） */
  deflate?: DeflateFn;
  /** 时间戳（默认 1980-01-01，保证同输入同字节） */
  mtime?: Date;
}

/** 已决定好压缩方式的条目（`assembleZip` 的输入） */
export interface ZipPreparedEntry {
  path: string;
  /** 原始字节（写进「未压缩大小」字段） */
  data: Uint8Array;
  /** 实际写入的字节（STORED = data，DEFLATE = 压缩结果） */
  payload: Uint8Array;
  /** 0 = STORED，8 = DEFLATE */
  method: 0 | 8;
}

interface ZipCentralRecord {
  name: Uint8Array;
  crc: number;
  csize: number;
  size: number;
  method: number;
  offset: number;
}

/**
 * **ZIP 容器的唯一装配实现**（本地头 + 数据 + 中央目录 + EOCD）。
 *
 * 同步、纯字节操作。压缩方式由调用方事先决定：
 * - 浏览器/异步侧 → `zipFiles`（`CompressionStream`）
 * - 服务端/同步侧 → `zipFilesSync`（`node:zlib.deflateRawSync`，facade 的 `createZip` 用它）
 *
 * 两条路径共用本函数，所以「同一份字节流格式」只有一处实现（`#621` 收拢，
 * 此前 core 与 facade 各写了一套 ~120 行的头字段装配）。
 */
export function assembleZip(entries: readonly ZipPreparedEntry[], opts: { mtime?: Date } = {}): Uint8Array {
  if (entries.length > 0xffff) throw new Error(`zip: 条目数 ${entries.length} 超过 65535（本实现不写 ZIP64）`);
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(opts.mtime ?? new Date(1980, 0, 1, 0, 0, 0));
  const out = new ByteSink();
  const central: ZipCentralRecord[] = [];

  for (const f of entries) {
    const name = enc.encode(f.path);
    if (f.data.length > 0xffffffff) throw new Error(`zip: 单文件 >4GB（本实现不写 ZIP64）：${f.path}`);
    if (f.payload.length > 0xffffffff) throw new Error(`zip: 单文件 >4GB（本实现不写 ZIP64）：${f.path}`);
    const crc = crc32(f.data);
    const offset = out.length;
    out.u32(LOC_SIG);
    out.u16(20); // version needed
    out.u16(0x0800); // flags: UTF-8 文件名
    out.u16(f.method);
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(f.payload.length);
    out.u32(f.data.length);
    out.u16(name.length);
    out.u16(0); // extra len
    out.bytes(name);
    out.bytes(f.payload);
    central.push({ name, crc, csize: f.payload.length, size: f.data.length, method: f.method, offset });
  }

  const cdStart = out.length;
  for (const c of central) {
    out.u32(CEN_SIG);
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(0x0800);
    out.u16(c.method);
    out.u16(time);
    out.u16(date);
    out.u32(c.crc);
    out.u32(c.csize);
    out.u32(c.size);
    out.u16(c.name.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk
    out.u16(0); // internal attrs
    out.u32(0); // external attrs
    out.u32(c.offset);
    out.bytes(c.name);
  }
  const cdSize = out.length - cdStart;
  out.u32(EOCD_SIG);
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(cdSize);
  out.u32(cdStart);
  out.u16(0);
  return out.result();
}

/** 校验归档内路径（两条写入路径共用同一条规则，避免一边收一边拒） */
function checkPath(path: string): void {
  if (!path) throw new Error('zip: 条目名不能为空');
  if (path.includes('\\')) throw new Error(`zip: 归档内路径请用 / 分隔：${path}`);
  if (path.startsWith('/')) throw new Error(`zip: 归档内路径不能以 / 开头：${path}`);
}

/**
 * 打包成 zip 字节（**异步**；用压缩钩子）。
 *
 * `files[0]` 若是 `mimetype`，务必设 `store: true`（epub 规范要求它**第一个且不压缩**）。
 */
export async function zipFiles(files: readonly ZipInputFile[], opts: ZipWriteOptions = {}): Promise<Uint8Array> {
  const prepared: ZipPreparedEntry[] = [];
  for (const f of files) {
    checkPath(f.path);
    let method: 0 | 8 = 0;
    let payload = f.data;
    if (!f.store && opts.deflate) {
      const z = await opts.deflate(f.data);
      // 压不动（或压缩钩子不可用）⇒ STORED，不写「压缩后更大」的蠢结果
      if (z && z.length < f.data.length) {
        method = 8;
        payload = z;
      }
    }
    prepared.push({ path: f.path, data: f.data, payload, method });
  }
  return assembleZip(prepared, { mtime: opts.mtime });
}

/**
 * 同步版（**服务端**用：`node:zlib` 的 `deflateRawSync`）。浏览器里没有 zlib，
 * 所以这条路径由调用方注入压缩函数，core 本身仍不 import 任何 Node 模块。
 */
export function zipFilesSync(
  files: readonly ZipInputFile[],
  deflate?: (data: Uint8Array) => Uint8Array | undefined,
  opts: { mtime?: Date } = {},
): Uint8Array {
  const prepared: ZipPreparedEntry[] = [];
  for (const f of files) {
    checkPath(f.path);
    let method: 0 | 8 = 0;
    let payload = f.data;
    if (!f.store && deflate) {
      const z = deflate(f.data);
      if (z && z.length < f.data.length) {
        method = 8;
        payload = z;
      }
    }
    prepared.push({ path: f.path, data: f.data, payload, method });
  }
  return assembleZip(prepared, opts);
}

/**
 * 浏览器/Node 通用的 `deflate-raw` 钩子（拿不到就返回 undefined ⇒ 调用方退回 STORED）。
 *
 * 用 `CompressionStream`（浏览器 + Node 18+）而不是 zlib：core 里**不能** import `node:zlib`
 * （前端打包会报模块解析失败）。可用的压缩方式映射见 `epub.ts` 的调用点。
 */
export async function browserDeflate(data: Uint8Array): Promise<Uint8Array | undefined> {
  const Ctor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!Ctor) return undefined;
  try {
    const cs = new Ctor('deflate-raw');
    const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return undefined;
  }
}
