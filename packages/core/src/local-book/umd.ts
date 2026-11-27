/**
 * UMD 本地书解析（`#212` ②a）
 *
 * 上游对应：`UmdFile.kt` → `modules/book/.../me/ag2s/umdlib`（Java，933 行，第三方库）。
 * 本仓**零依赖自研**：UMD 结构简单（一串「`#` 分块 + `$` 附加块」+ zlib 正文），
 * 自己写比移植一个 Java 库更可控，也少一个要审计的依赖 —— 与 epub 的取舍一致。
 *
 * ## 格式（逐条对照上游 `UmdReader.java` / `UmdChapters.java`）
 * ```
 * 89 9b 9a de                       ← magic（LE 读 = 0xde9a9b89）
 * '#' 01 00  00 08  01  <rand2>     ← 块1：头部（umdType=01 文本 / 02 图片 + 2 随机字节）
 * '#' 02 00  00  <len+5> <UTF16LE>  ← 标题（3=作者 4=年 5=月 6=日 7=类型 8=出版商 9=零售商）
 * '#' 0b 00  00 09 <int32 LE>       ← type 11 = 正文总字节长度
 * '#' 83 00  00 09 <int32 LE>       ← type 131 = 章节偏移块（首 4 字节 = 校验数 checkNum）
 *   '$' <4B checkNum> <int32 LE len+9> <int32 LE × n>   ← 各章正文**字节偏移**（相对拼接后的正文）
 * '#' 84 00  01 09 <int32 LE>       ← type 132 = 标题/正文块（首 4 字节 = checkNum）
 *   '$' <4B checkNum> <int32 LE len+9> <1B titleLen> <UTF16LE title> ×n   ← checkNum **相同** ⇒ 标题
 *   '$' <4B rand>     <int32 LE len+9> <zlib 压缩正文分片>              ← checkNum **不同** ⇒ 正文分片
 * '#' 81 …                          ← type 129 = 正文结束
 * '#' f1 …                          ← 分片结束标记
 * ```
 * 正文：所有分片解压后**按顺序拼接**成一个字节流，再按偏移块切成每章（`UmdChapters.getContent`）。
 * `0x2029`（Unicode 段分隔符）在上游被替换成 `\n`（`getContentString`）—— 本仓照做。
 *
 * ## 与上游的差异
 * - 上游 `read()` 是有状态对象 + `InputStream`；这里一次性读入 `Uint8Array` 顺序解析（本仓正文不落库，
 *   每次取正文都重新读文件，见 `index.ts` 的说明）。
 * - 上游对未知分块 `default: break`（**不读**内容 ⇒ 游标错位风险）；这里**照样读满再跳**，更强壮。
 * - 图片型 UMD（`umdType == 0x02`）在 `importLocalBook` 层**明确报错**（本仓正文通道是纯文本）。
 */

import { inflateSync } from 'node:zlib';

/** UMD 文件魔数（文件上是 LE 字节 89 9b 9a de） */
const MAGIC = 0xde9a9b89;

export interface ParsedUmdChapter {
  title: string;
  /** 该章正文在**拼接后字节流**里的起始偏移 */
  start: number;
  /** 结束偏移（下一章起始，或正文总长度） */
  end: number;
}

export interface ParsedUmd {
  title: string;
  author: string;
  /** 上游 `header.bookType`（小说类型），当 `intro` 兜底用 */
  bookType: string;
  chapters: ParsedUmdChapter[];
  /** 拼接后的正文字节流（**未**按章切；取正文时按 `start/end` 切） */
  content: Uint8Array;
  /** 封面 JPEG 字节（无则 null） */
  cover: Uint8Array | null;
}

/** 解析游标（顺序读，越界即抛 —— 与上游 `StreamReader` 同一心智，但更严格） */
class Cursor {
  p = 0;
  constructor(private readonly b: Uint8Array) {}
  get left(): number {
    return this.b.length - this.p;
  }
  byte(): number {
    if (this.p >= this.b.length) throw new Error('UMD 解析越界（文件被截断）');
    return this.b[this.p++]!;
  }
  /** 看一眼下一字节但不推进（游标越界返回 -1） */
  peek(): number {
    return this.p < this.b.length ? this.b[this.p]! : -1;
  }
  intLE(): number {
    if (this.p + 4 > this.b.length) throw new Error('UMD 解析越界（读 int32 时文件结束）');
    const v = this.b[this.p]! | (this.b[this.p + 1]! << 8) | (this.b[this.p + 2]! << 16) | (this.b[this.p + 3]! << 24);
    this.p += 4;
    return v >>> 0;
  }
  /** 2 字节 LE（上游 `readShortLe`；主块类型用） */
  shortLE(): number {
    const lo = this.byte();
    return (lo | (this.byte() << 8)) & 0xffff;
  }
  bytes(n: number): Uint8Array {
    if (n < 0) throw new Error('UMD 解析越界（负长度）');
    if (this.p + n > this.b.length) throw new Error(`UMD 解析越界（要读 ${n} 字节，剩 ${this.left}）`);
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  skip(n: number): void {
    if (n > 0) this.bytes(n);
  }
}

/** UTF-16LE 解码（UMD 所有文本都是 UTF-16LE） */
function utf16le(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i]! | (b[i + 1]! << 8));
  return s;
}

/** 拼接若干 Uint8Array */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * 解析一份 UMD。抛错的都是「这个文件确实解析不了」，文案直接面向用户。
 *
 * ⚠️ 正文用 **zlib 解压**（`node:zlib` 的 `inflateSync` 认 zlib 头，与 Java `Inflater` 一致）——
 *   **不是** `inflateRawSync`（epub 里 zip 条目是裸 deflate，两者不同，别混用）。
 */
export function parseUmd(buf: Uint8Array): ParsedUmd {
  const c = new Cursor(buf);
  if (c.intLE() !== MAGIC) throw new Error('不是有效的 UMD 文件（魔数不匹配）');

  let title = '';
  let author = '';
  let bookType = '';
  let totalContentLen = 0;
  let contentLengths: number[] = [];
  const titles: string[] = [];
  let cover: Uint8Array | null = null;
  /** 正文分片（解压后），按出现顺序拼接（上游 `UmdChapters.contents`） */
  const chunks: Uint8Array[] = [];
  /**
   * 最新主块里读到的 4 字节「校验数」（上游 `_AdditionalCheckNumber`）。
   * 区分 type 132 的两种附加块：附加块内的 checkNum **等于它 ⇒ 标题**，不等 ⇒ 正文分片。
   */
  let currentCheck = -1;

  /** 解压一片正文；坏片**跳过并留痕**（不让一片坏块毁掉整本） */
  const pushChunk = (raw: Uint8Array): void => {
    try {
      chunks.push(new Uint8Array(inflateSync(raw)));
    } catch {
      console.warn('[local-book] UMD 正文分片解压失败，已跳过该片');
    }
  };

  while (c.left > 0 && c.peek() === 0x23) {
    c.byte(); // '#'
    const segType = c.shortLE();
    c.byte(); // segFlag
    const len = c.byte() - 5; // 该字节 = 内容长度 + 5
    if (len < 0) throw new Error('UMD 主块长度非法');

    switch (segType) {
      case 1: // 头部：umdType + 2 随机 + 4 字节块随机
        c.byte();
        c.skip(2);
        if (len > 3) c.skip(len - 3);
        break;
      case 2: title = utf16le(c.bytes(len)); break;
      case 3: author = utf16le(c.bytes(len)); break;
      case 7: bookType = utf16le(c.bytes(len)); break;
      case 11: totalContentLen = c.intLE(); if (len > 4) c.skip(len - 4); break;
      case 129: // 正文
      case 130: // 封面
      case 131: // 章节偏移
      case 132: // 标题/正文分片
        // 主块载荷 = [4B checkNum] + 余量。**必须把余量跳完**再进附加块循环，
        // 否则游标停在块中间，后续 `$`/`#` 识别全部错位（129 的正文就在余量里）。
        currentCheck = c.intLE();
        if (len > 4) c.skip(len - 4);
        break;
      case 135: // PageOffset：fontSize + screenWidth + 4 字节块随机
        c.byte(); c.byte(); c.skip(4);
        break;
      default:
        if (len > 0) c.skip(len);
    }

    // 紧随其后的 `$` 附加块（0 或多个）
    while (c.left > 0 && c.peek() === 0x24) {
      c.byte(); // '$'
      const check = c.intLE();
      const alen = c.intLE() - 9;
      if (alen < 0) break;
      if (segType === 131) {
        contentLengths = [];
        for (let i = 0; i + 4 <= alen; i += 4) contentLengths.push(c.intLE());
        c.skip(alen - (contentLengths.length * 4));
      } else if (segType === 132) {
        if (check === currentCheck) {
          // 标题块：n 个 [1B 长度][UTF16LE]，**长度是字符数 ⇒ 字节数 = 长度 × 2**
          const end = c.p + alen;
          const n = contentLengths.length;
          for (let i = 0; i < n && c.p < end; i++) {
            const tl = c.byte();
            if (c.p + tl * 2 > end) break;
            titles.push(utf16le(c.bytes(tl * 2)));
          }
          c.skip(end - c.p); // 余量（异常文件）跳掉，保证游标对齐
        } else {
          pushChunk(c.bytes(alen));
        }
      } else if (segType === 130) {
        cover = c.bytes(alen).slice();
      } else {
        c.skip(alen); // 129 / 其它
      }
    }
  }

  // ---- 拼接正文 + 按偏移切章 ----
  const content = concat(chunks);
  const total = totalContentLen > 0 && totalContentLen <= content.length ? totalContentLen : content.length;
  const offsets = contentLengths.length ? contentLengths : content.length ? [0] : [];
  const chapters: ParsedUmdChapter[] = offsets.map((start, i) => ({
    title: titles[i] ?? '',
    start,
    end: i + 1 < offsets.length ? offsets[i + 1]! : total,
  }));
  if (!chapters.length) throw new Error('该 UMD 解析不出任何章节（可能不是文本型 UMD 或文件损坏）');

  return { title, author, bookType, chapters, content, cover };
}

/**
 * 取某一章的正文（按**字节偏移**切拼接后的正文流）。
 *
 * `content` 来自 `parseUmd().content`；这里按 `start/end` 切，再 UTF-16LE 解码，
 * 并把 `0x2029`（Unicode 段分隔符）换成 `\n`（上游 `getContentString` 同款）。
 */
export function readUmdContent(content: Uint8Array, start: number, end: number): string {
  const s = Math.max(0, Math.min(start, content.length));
  const e = Math.max(s, Math.min(end, content.length));
  return utf16le(content.subarray(s, e)).replace(/\u2029/g, '\n');
}
