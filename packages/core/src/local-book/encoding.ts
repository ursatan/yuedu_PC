/**
 * 本地书**编码探测**（`#202`）
 *
 * 对应上游 `utils/EncodingDetect.kt` + `Book.fileCharset()`（`Book.kt`）。
 *
 * ## 判据顺序（照上游语义，先定死的再说猜的）
 * 1. **BOM**：`EF BB BF` → UTF-8 · `FF FE` → UTF-16LE · `FE FF` → UTF-16BE。BOM 是**事实**，优先级最高。
 * 2. **无 BOM 时按「能不能严格解成 UTF-8」判**：纯 ASCII 与合法 UTF-8 都能过 ⇒ 判 UTF-8；
 *    一旦出现非法序列 ⇒ 判**中文老编码**。这是上游 `EncodingDetect` 同一思路的简化版
 *    （上游还会按字节频率区分 GBK/BIG5；我们**只在中日韩候选里选 GB18030 兜底**，
 *    因为 GB18030 是 GBK 的超集、覆盖率最高，选错时至少不会解出乱码字符而是尽量还原）。
 *
 * ⚠️ 为什么用 `TextDecoder('gb18030')` 而不是 `iconv` 之类的依赖：Node ≥22 自带 full-icu，
 *    `TextDecoder` 直接支持 `gbk`/`gb18030`/`big5`/`utf-16le|be`（已实测）。零依赖即可。
 *
 * ⚠️ **探测只看文件头部**（默认 512KB）：整文件扫描对 20MB 的 txt 太慢，而编码在文件内
 *    不一致本身就不是正常文件。上游同样只读一个 buffer（`TextFile.kt` 的 `bufferSize`）。
 */

/** 我们支持的本地书编码（`ShelfBook.charset` 存的是这里的值） */
export type BookCharset = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'big5' | 'ascii';

/** 探测用的最大头部长度 */
const SNIFF_BYTES = 512 * 1024;

function hasBom(buf: Uint8Array): BookCharset | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  return null;
}

/**
 * 判断一段字节**是不是**合法 UTF-8（严格模式）。
 *
 * 为什么不用 `TextDecoder('utf-8')` 直接解：它默认 `fatal:false`，遇到非法序列会**插入 `` 而不报错**，
 * 于是「GBK 文件」也会"成功"解成一片乱码 ⇒ 探测失效。必须用 `fatal:true` 才能把「非法」暴露出来。
 */
function isValidUtf8(buf: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 内容是否几乎全是 ASCII（这种情况判 UTF-8 一定安全） */
function isMostlyAscii(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 65536);
  let bad = 0;
  for (let i = 0; i < n; i++) if (buf[i]! > 0x7f) bad++;
  return n === 0 || bad / n < 0.002;
}

/**
 * 探测编码。**不抛错** —— 探测不出来一律给 `gb18030`（中文书站/文档最常见，且是 GBK 超集）。
 */
export function detectCharset(buf: Uint8Array): BookCharset {
  const bom = hasBom(buf);
  if (bom) return bom;
  const head = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
  if (isMostlyAscii(head)) return 'utf-8';
  if (isValidUtf8(head)) return 'utf-8';
  // UTF-16 无 BOM：出现大量 0x00 且位置规律（ASCII 文本在 UTF-16 里隔字节为 0）
  let zerosOdd = 0;
  let zerosEven = 0;
  for (let i = 0; i < Math.min(head.length, 4096); i++) {
    if (head[i] === 0) (i % 2 === 0 ? zerosEven++ : zerosOdd++);
  }
  const half = Math.min(head.length, 4096) / 2;
  if (zerosOdd > half * 0.6) return 'utf-16le';
  if (zerosEven > half * 0.6) return 'utf-16be';
  return 'gb18030';
}

/** 按指定编码解码（未知编码名或解码失败 ⇒ 回落到 gb18030，绝不抛错） */
export function decodeBuffer(buf: Uint8Array, charset: string | null | undefined): string {
  const cs = normaliseCharset(charset);
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      // 最后兜底：latin1 一定成功（虽然可能乱码，但不至于让整本书打不开）
      return Buffer.from(buf).toString('latin1');
    }
  }
}

/** 把外部来的编码名归一成 `TextDecoder` 认的名字（大小写/别名/`utf8`→`utf-8` 等） */
export function normaliseCharset(charset: string | null | undefined): BookCharset {
  const s = String(charset ?? '').trim().toLowerCase();
  if (!s) return 'utf-8';
  if (s === 'utf8' || s === 'utf-8' || s === 'utf8mb4') return 'utf-8';
  if (s === 'utf-16' || s === 'utf-16le' || s === 'utf16le') return 'utf-16le';
  if (s === 'utf-16be') return 'utf-16be';
  if (s === 'gbk' || s === 'gb2312' || s === 'gb18030' || s === 'gb-2312' || s === 'cp936') return 'gb18030';
  if (s === 'big5' || s === 'big-5' || s === 'cp950') return 'big5';
  if (s === 'ascii' || s === 'us-ascii') return 'ascii';
  return 'gb18030';
}
