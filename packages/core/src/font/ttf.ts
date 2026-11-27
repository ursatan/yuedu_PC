/**
 * `#614` **字体反爬解析** —— 移植上游
 * `F:\legado\app\src\main\java\io\legado\app\model\analyzeRule\QueryTTF.java`（1055 行，2026-10-25 读）。
 *
 * ## 这套东西解决什么问题
 * 站点把正文用自定义字体「加密」：**同一批字形，cmap 被打乱**。所以
 * `<span>甲乙</span>` 实际渲染出来是「乙甲」。解法不是 OCR，而是：
 *  1. 拿**错误字体**（站点下发的那只，正文用的就是它）→ 求出每个 Unicode 的字形数据；
 *  2. 拿**正确字体**（同字体家族的原始版，站点不会改）→ 反过来用字形数据查出真实 Unicode；
 *  3. 逐字替换。
 *
 * ## 三条必须照抄的上游细节（想当然就会全错）
 *  a. **比较的是「轮廓点串」，不是字形索引** —— 索引在两只字体里含义不同（cmap 被打乱了），
 *     但**轮廓点数据**是同一份。上游 `getGlyfById` 把简单字形拼成
 *     `"x0,y0|x1,y1|…"`、复合字形拼成 `"[{flags:…,glyphIndex:…,…}]"`。
 *  b. **坐标是「相对增量」而不是绝对值** —— 上游读 `xCoordinates` 时并没有累加，
 *     直接把 flag 决定的那段 delta 存下来（`case 0x02: -1 * ReadUInt8()` …）。
 *     这在本场景**是对的**：站点通常只改 cmap、loca/glyf 字节完全一致 ⇒ delta 序列逐点相同。
 *     ⚠️ 我们照抄这个语义；若哪天遇到「重新导出过的字体」（轮廓被重算），匹配率会下降，
 *     那时要改成累加成绝对坐标（两侧统一即可）。
 *  c. **`glyphId == 0` 一律跳过** —— 0 是 `.notdef` 保留索引，不是真字形。
 *
 * ## 与上游的差异（显式）
 *  · 只支持 cmap 格式 **0 / 4 / 6**（上游 `readCmapTable` 就这三个）；格式 12（非 BMP）
 *    上游不解析，我们也不解析 —— 遇只带格式 12 的字体，`glyfOf` 恒空，
 *    于是 `replaceFont` **原样返回**（不是抛错，不会打挂正文）。
 *  · 不支持 CFF/CFF2 轮廓（`OTTO`）：上游只读 `glyf` 表，同理 —— 明确抛错，
 *    而不是返回一个空映射让调用方「静默改不动字」。
 *  · 不做 `name` 表解析（上游读了但没人用）。
 */

/** 简单字形的关键数据（只留拼 key 需要的：相对增量 + 点数） */
interface GlyphSimple {
  x: number[];
  y: number[];
}

/** 复合字形的组件（flags / 引用索引 / 参数 / 变换） */
interface GlyphComponent {
  flags: number;
  glyphIndex: number;
  arg1: number;
  arg2: number;
  xScale?: number;
  scale01?: number;
  scale10?: number;
  yScale?: number;
}

interface GlyphLayout {
  simple?: GlyphSimple;
  components?: GlyphComponent[];
}

/** 上游 `BufferReader` 的最小等价物（大端序） */
class Reader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}
  u8(): number {
    if (this.pos >= this.b.length) throw new Error(`TTF 读取越界（u8 @${this.pos}/${this.b.length}）`);
    return this.b[this.pos++]!;
  }
  i8(): number {
    const v = this.u8();
    return v & 0x80 ? v - 0x100 : v;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  i16(): number {
    const v = this.u16();
    return v & 0x8000 ? v - 0x10000 : v;
  }
  u32(): number {
    return ((this.u16() << 16) | this.u16()) >>> 0;
  }
  skip(n: number): void {
    this.pos += n;
    if (this.pos > this.b.length) throw new Error(`TTF 跳过越界（${n} @${this.pos}/${this.b.length}）`);
  }
  /** 定长字节序列（`string` 用 ASCII 更好读，表标签需要） */
  tag(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

/** 表目录项 */
interface TableRecord {
  offset: number;
  length: number;
}

/** 常见「不是 TTF」的头部识别（把 WOFF2/HTML 这类误下的东西说清楚，省一轮排查） */
function describeSfnt(sfnt: number): string {
  const tag = String.fromCharCode((sfnt >>> 24) & 0xff, (sfnt >>> 16) & 0xff, (sfnt >>> 8) & 0xff, sfnt & 0xff);
  if (tag === 'wOF2') return '，是 WOFF2（压缩字体，需先解压）';
  if (tag === 'wOFF') return '，是 WOFF（压缩字体，需先解压）';
  if (tag === '<htm' || tag === '<!DO') return '，是 HTML 页面（地址可能失效/被防盗链拦了）';
  if (tag === '\x89PNG') return '，是 PNG 图片（地址指错了）';
  return '';
}

/** 上游 `isBlankUnicode` 的 12 个空白码位（**逐字**照抄，别顺手改成 `\s`） */
const BLANK_CODES = new Set([
  0x0009, 0x0020, 0x00a0, 0x2002, 0x2003, 0x2007, 0x200a, 0x200b, 0x200c, 0x200d, 0x202f, 0x205f,
]);

export interface QueryTtf {
  /** Unicode → 轮廓索引（找不到 ⇒ 0，与上游同） */
  glyfIdOf(codePoint: number): number;
  /** Unicode → 轮廓点串（找不到 ⇒ null） */
  glyfOf(codePoint: number): string | null;
  /** 轮廓点串 → Unicode（找不到 ⇒ 0） */
  unicodeOfGlyf(glyph: string | null): number;
  /** 上游 `isBlankUnicode` */
  isBlankUnicode(codePoint: number): boolean;
  /** 字体里的字形数（排查用） */
  get numGlyphs(): number;
  /** 建了索引的码位数（排查用：0 ⇒ cmap 没解析出来） */
  get mappedCount(): number;
}

/**
 * 解析一只 TTF，建 Unicode ⇄ 轮廓点串 双向索引。
 *
 * 抛错的两种情形都**必须说清原因**（否则现场表现成「字体处理静默无效」）：
 *  · 不是 sfnt 字体 / 表缺失（`head`/`maxp`/`cmap`/`loca`/`glyf`）；
 *  · CFF 轮廓（`OTTO`）—— 我们没有 CFF 解析器，上游也没有。
 */
export function parseTtf(bytes: Uint8Array): QueryTtf {
  if (!bytes || bytes.length < 12) throw new Error('TTF 数据太短，不是有效字体');
  const head = new Reader(bytes);
  const sfnt = head.u32();
  // 0x00010000 / 'true' 是合法 sfnt；'OTTO' 是 CFF 轮廓；'ttcf' 是字体集合
  const isOtto = sfnt === 0x4f54544f; // 'OTTO'
  const isTtc = sfnt === 0x74746366; // 'ttcf'
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565 && !isOtto && !isTtc) {
    throw new Error(
      `不是 TTF/OTF 字体（sfntVersion=0x${sfnt.toString(16)}${describeSfnt(sfnt)}）`,
    );
  }
  if (isOtto) throw new Error('CFF（OTTO）轮廓字体不支持：上游 QueryTTF 只解析 glyf 表');
  if (isTtc) throw new Error('TTC 字体集合不支持（一只 .ttc 里有多只字体，需先解出单只 TTF）');

  const numTables = head.u16();
  head.skip(6); // searchRange / entrySelector / rangeShift
  const dir = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i++) {
    const tag = head.tag();
    head.u32(); // checkSum
    const offset = head.u32();
    const length = head.u32();
    dir.set(tag, { offset, length });
  }
  const need = (tag: string): TableRecord => {
    const t = dir.get(tag);
    if (!t) throw new Error(`TTF 缺 ${tag} 表（不能做字体反爬匹配）`);
    if (t.offset + t.length > bytes.length) throw new Error(`TTF 的 ${tag} 表越界（表可能被截断）`);
    return t;
  };

  // ── head：indexToLocFormat（偏移 50）决定 loca 是 short 还是 long ──
  const headTable = need('head');
  const headReader = new Reader(bytes);
  headReader.pos = headTable.offset + 50;
  const indexToLocFormat = headReader.i16();
  if (indexToLocFormat !== 0 && indexToLocFormat !== 1) {
    throw new Error(`TTF head.indexToLocFormat=${indexToLocFormat} 非法（只能 0/1）`);
  }

  // ── maxp：numGlyphs（偏移 4）──
  const maxpTable = need('maxp');
  const maxpReader = new Reader(bytes);
  maxpReader.pos = maxpTable.offset + 4;
  const numGlyphs = maxpReader.u16();
  maxpReader.pos = maxpTable.offset + 8;
  const maxContours = maxpReader.u16(); // 非复合字形最大轮廓数（上游用它挡非法字形）

  // ── cmap：Unicode → glyphId ──
  const unicodeToGlyphId = new Map<number, number>();
  const cmapTable = need('cmap');
  {
    const r = new Reader(bytes);
    r.pos = cmapTable.offset;
    r.u16(); // version
    const n = r.u16();
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      r.u16(); // platformID（上游也没按平台筛：把所有子表都并进同一张映射）
      r.u16(); // encodingID
      const subOffset = r.u32();
      if (seen.has(subOffset)) continue;
      seen.add(subOffset);
      if (subOffset + 6 > cmapTable.length) continue;
      const s = new Reader(bytes);
      s.pos = cmapTable.offset + subOffset;
      const format = s.u16();
      const length = s.u16();
      s.u16(); // language
      if (format === 0) {
        // 256 项字节映射（Mac Roman 老字体）
        const count = Math.max(0, length - 6);
        for (let cp = 0; cp < count; cp++) {
          const gid = s.u8();
          if (gid !== 0) unicodeToGlyphId.set(cp, gid); // 排除 .notdef
        }
      } else if (format === 4) {
        const segCountX2 = s.u16();
        const segCount = segCountX2 >> 1;
        s.skip(6); // searchRange / entrySelector / rangeShift
        const endCode: number[] = [];
        for (let k = 0; k < segCount; k++) endCode.push(s.u16());
        s.u16(); // reservedPad
        const startCode: number[] = [];
        for (let k = 0; k < segCount; k++) startCode.push(s.u16());
        const idDelta: number[] = [];
        for (let k = 0; k < segCount; k++) idDelta.push(s.i16());
        const idRangeOffset: number[] = [];
        for (let k = 0; k < segCount; k++) idRangeOffset.push(s.u16());
        // glyphIdArray 长度由子表长度反推（上游同）
        const glyphIdArrayLength = Math.max(0, Math.floor((length - 16 - segCount * 8) / 2));
        const glyphIdArray: number[] = [];
        for (let k = 0; k < glyphIdArrayLength; k++) glyphIdArray.push(s.u16());
        for (let k = 0; k < segCount; k++) {
          const start = startCode[k]!;
          const end = endCode[k]!;
          for (let cp = start; cp <= end && cp <= 0xffff; cp++) {
            let gid = 0;
            if (idRangeOffset[k] === 0) {
              gid = (cp + idDelta[k]!) & 0xffff;
            } else {
              const idx = (idRangeOffset[k]! >> 1) + (cp - start) + k - segCount;
              if (idx >= 0 && idx < glyphIdArrayLength) gid = (glyphIdArray[idx]! + idDelta[k]!) & 0xffff;
            }
            if (gid === 0) continue; // .notdef
            unicodeToGlyphId.set(cp, gid);
          }
        }
      } else if (format === 6) {
        const firstCode = s.u16();
        const entryCount = s.u16();
        for (let k = 0; k < entryCount; k++) {
          const gid = s.u16();
          if (gid !== 0) unicodeToGlyphId.set(firstCode + k, gid);
        }
      }
      // format 12 及其他：上游不解析（见头注差异）
    }
  }

  // ── loca：每个字形的偏移（numGlyphs + 1 项）──
  const locaTable = need('loca');
  const loca: number[] = [];
  {
    const r = new Reader(bytes);
    r.pos = locaTable.offset;
    for (let i = 0; i <= numGlyphs; i++) {
      loca.push(indexToLocFormat === 0 ? r.u16() * 2 : r.u32());
    }
  }

  // ── glyf：逐个字形解析成「点串」──
  const glyfTable = need('glyf');
  const glyphs: (GlyphLayout | undefined)[] = new Array(numGlyphs);
  for (let index = 0; index < numGlyphs; index++) {
    if (loca[index] === loca[index + 1]) continue; // 空字形
    const r = new Reader(bytes);
    r.pos = glyfTable.offset + loca[index]!;
    const numberOfContours = r.i16();
    if (numberOfContours > maxContours) continue; // 上游：超过 maxp 上限 ⇒ 非法字形
    r.skip(8); // xMin/yMin/xMax/yMax
    if (numberOfContours === 0) continue; // 没有轮廓（纯空白）
    if (numberOfContours > 0) {
      const endPts: number[] = [];
      for (let i = 0; i < numberOfContours; i++) endPts.push(r.u16());
      const instructionLength = r.u16();
      r.skip(instructionLength);
      const pointCount = endPts[endPts.length - 1]! + 1;
      const flags: number[] = new Array(pointCount);
      for (let n = 0; n < pointCount; n++) {
        const f = r.u8();
        flags[n] = f;
        if (f & 0x08) {
          // 重复标志：后面的字节是重复次数
          let repeat = r.u8();
          while (repeat-- > 0) flags[++n] = f;
        }
      }
      const x: number[] = new Array(pointCount);
      for (let n = 0; n < pointCount; n++) {
        const f = flags[n]!;
        if (f & 0x02) x[n] = f & 0x10 ? r.u8() : -r.u8();
        else x[n] = f & 0x10 ? 0 : r.i16();
      }
      const y: number[] = new Array(pointCount);
      for (let n = 0; n < pointCount; n++) {
        const f = flags[n]!;
        if (f & 0x04) y[n] = f & 0x20 ? r.u8() : -r.u8();
        else y[n] = f & 0x20 ? 0 : r.i16();
      }
      glyphs[index] = { simple: { x, y } };
    } else {
      const components: GlyphComponent[] = [];
      for (;;) {
        const flags = r.u16();
        const glyphIndex = r.u16();
        let arg1 = 0;
        let arg2 = 0;
        switch (flags & 0b11) {
          case 0b00:
            arg1 = r.u8();
            arg2 = r.u8();
            break;
          case 0b10:
            arg1 = r.i8();
            arg2 = r.i8();
            break;
          case 0b01:
            arg1 = r.u16();
            arg2 = r.u16();
            break;
          default:
            arg1 = r.i16();
            arg2 = r.i16();
            break;
        }
        const c: GlyphComponent = { flags, glyphIndex, arg1, arg2 };
        switch (flags & 0b1100_1000) {
          case 0b0000_1000: {
            const s = r.u16() / 16384;
            c.xScale = s;
            c.yScale = s;
            break;
          }
          case 0b0100_0000:
            c.xScale = r.u16() / 16384;
            c.yScale = r.u16() / 16384;
            break;
          case 0b1000_0000:
            c.xScale = r.u16() / 16384;
            c.scale01 = r.u16() / 16384;
            c.scale10 = r.u16() / 16384;
            c.yScale = r.u16() / 16384;
            break;
          default:
            break;
        }
        components.push(c);
        if ((flags & 0x20) === 0) break; // MORE_COMPONENTS
      }
      glyphs[index] = { components };
    }
  }

  /** 上游 `getGlyfById`：把字形拼成一个**稳定字符串**（两侧字体都用同一函数 ⇒ 可比） */
  const keyOfGlyph = (gid: number): string | null => {
    const g = glyphs[gid];
    if (!g) return null;
    if (g.simple) {
      const { x, y } = g.simple;
      const parts: string[] = new Array(x.length);
      for (let i = 0; i < x.length; i++) parts[i] = `${x[i]},${y[i]}`;
      return parts.join('|');
    }
    return `[${(g.components ?? [])
      .map(
        (c) =>
          `{flags:${c.flags},glyphIndex:${c.glyphIndex},arg1:${c.arg1},arg2:${c.arg2}` +
          `${c.xScale === undefined ? '' : `,xScale:${c.xScale}`}` +
          `${c.scale01 === undefined ? '' : `,scale01:${c.scale01}`}` +
          `${c.scale10 === undefined ? '' : `,scale10:${c.scale10}`}` +
          `${c.yScale === undefined ? '' : `,yScale:${c.yScale}`}` +
          '}',
      )
      .join(',')}]`;
  };

  const unicodeToGlyph = new Map<number, string>();
  const glyphToUnicode = new Map<string, number>();
  for (const [cp, gid] of unicodeToGlyphId) {
    if (gid >= numGlyphs) continue;
    const key = keyOfGlyph(gid);
    if (key === null) continue; // 空字形不进反向表（null 不能当 key，上游同）
    unicodeToGlyph.set(cp, key);
    if (!glyphToUnicode.has(key)) glyphToUnicode.set(key, cp);
  }

  return {
    numGlyphs,
    mappedCount: unicodeToGlyph.size,
    glyfIdOf: (cp: number) => unicodeToGlyphId.get(cp) ?? 0,
    glyfOf: (cp: number) => unicodeToGlyph.get(cp) ?? null,
    unicodeOfGlyf: (g: string | null) => (g === null ? 0 : (glyphToUnicode.get(g) ?? 0)),
    isBlankUnicode: (cp: number) => BLANK_CODES.has(cp),
  };
}

/**
 * 上游 `replaceFont(text, errorQueryTTF, correctQueryTTF, filter)`：
 * 用**错误字体**求出每个字的轮廓，再用**正确字体**反查真实 Unicode。
 *
 * `filter = true` 时，错误字体里「没有轮廓」的字符**直接删掉**（上游语义：
 * 那些字是站点塞的水印/噪声，正常正文不该出现）；`false` 则原样保留。
 *
 * 空字体（null）⇒ 原样返回（上游第一行就 `return text`）——**不抛错**，
 * 因为调用点常在 `try{}catch{}` 里，抛错等于让源作者以为规则写错了。
 */
export function replaceFont(
  text: string,
  errorTtf: QueryTtf | null | undefined,
  correctTtf: QueryTtf | null | undefined,
  filter = false,
): string {
  if (!errorTtf || !correctTtf) return String(text ?? '');
  const chars = Array.from(String(text ?? '')); // 按**码位**切（不能 toCharArray：一个汉字 = 一个码位但代理对占两位）
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const code = ch.codePointAt(0) ?? 0;
    if (errorTtf.isBlankUnicode(code)) continue; // 空白不动
    let glyf = errorTtf.glyfOf(code);
    // 轮廓指向保留索引 0 ⇒ 上游视为「没有轮廓」
    if (errorTtf.glyfIdOf(code) === 0) glyf = null;
    if (filter && glyf === null) {
      chars[i] = '';
      continue;
    }
    const real = correctTtf.unicodeOfGlyf(glyf);
    if (real !== 0) chars[i] = String.fromCodePoint(real);
  }
  return chars.join('');
}
