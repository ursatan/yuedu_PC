/**
 * `#614` 测试夹具：**自己造两只最小 TTF**（不下载真字体、不把几 MB 二进制塞进仓库）。
 *
 * 造法就是站点字体反爬的做法：
 *  · 「正确字体」cmap 把 `一(U+4E00)` → 轮廓 A、`丁(U+4E01)` → 轮廓 B；
 *  · 「错误字体」**glyf 字节完全相同**，只把 cmap 反过来。
 * 于是「按轮廓串匹配」能还原文字，「按字形索引匹配」会原样返回 —— 两种实现一眼可分。
 *
 * 之所以要造：TTF 解析器的正确性没法靠「看代码」证明，必须有可逐字节核对的输入。
 */

/** 极简大字端写入器（只实现造字体需要的几种） */
class W {
  bytes: number[] = [];
  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }
  u32(v: number): this {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  raw(a: ArrayLike<number>): this {
    for (let i = 0; i < a.length; i++) this.bytes.push(a[i]! & 0xff);
    return this;
  }
  ascii(s: string): this {
    for (const c of s) this.bytes.push(c.charCodeAt(0));
    return this;
  }
  get length(): number {
    return this.bytes.length;
  }
  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export type Point = [number, number];

/** 轮廓 A（2 个点） */
export const SHAPE_A: Point[] = [
  [10, 10],
  [30, 30],
];
/** 轮廓 B（3 个点，与 A 必须不同 —— 否则两只字形会撞键） */
export const SHAPE_B: Point[] = [
  [50, 5],
  [70, 25],
  [90, 45],
];

/** 一个简单字形（1 个轮廓；坐标是**相对增量**，与上游存储语义一致） */
function simpleGlyph(points: Point[]): number[] {
  const w = new W();
  w.i16(1); // numberOfContours
  w.i16(0).i16(0).i16(100).i16(100); // bbox（不参与匹配）
  w.u16(points.length - 1); // endPtsOfContours
  w.u16(0); // instructionLength
  for (let i = 0; i < points.length; i++) w.u8(0x01); // flags：on-curve，x/y 走 int16 增量
  for (const [x] of points) w.i16(x);
  for (const [, y] of points) w.i16(y);
  if (w.length % 2) w.u8(0); // loca(short) 要求偶数偏移
  return w.bytes;
}

/**
 * 造一只最小 TTF（表：cmap/glyf/head/loca/maxp）。
 * @param cmap `[codepoint, glyphId]`
 * @param glyphs 每个 glyphId 的点（undefined = 空字形）
 */
export function buildTtf(cmap: Array<[number, number]>, glyphs: Array<Point[] | undefined>): Uint8Array {
  const glyf = new W();
  const loca: number[] = [];
  for (const g of glyphs) {
    loca.push(glyf.length);
    if (g) glyf.raw(simpleGlyph(g));
  }
  loca.push(glyf.length);

  const locaW = new W();
  for (const off of loca) locaW.u16(off / 2); // indexToLocFormat = 0（short）

  // head：54 字节，indexToLocFormat 在偏移 50
  const head = new W();
  head.u32(0x00010000).u32(0).u32(0).u32(0x5f0f3cf5).u16(0).u16(1000);
  head.u32(0).u32(0).u32(0).u32(0); // created / modified 各 8 字节
  head.i16(0).i16(0).i16(100).i16(100); // bbox
  head.u16(0).u16(8).i16(2); // macStyle / lowestRecPPEM / fontDirectionHint
  head.i16(0); // ★ indexToLocFormat
  head.i16(0); // glyphDataFormat

  // maxp：v1.0，numGlyphs 在偏移 4，maxContours 在偏移 8
  const maxp = new W();
  maxp.u32(0x00010000).u16(glyphs.length).u16(8).u16(1);
  while (maxp.length < 32) maxp.u16(0);

  // cmap：version0 + 1 条记录 + format4 子表（每个码位一段 + 0xFFFF 哨兵）
  const segs: Array<[number, number, number]> = cmap.map(([cp, gid]) => [cp, (gid - cp) & 0xffff, 0]);
  segs.push([0xffff, 1, 0]);
  const segCount = segs.length;
  let pow2 = 1;
  let entrySelector = 0;
  while (pow2 * 2 <= segCount) {
    pow2 *= 2;
    entrySelector += 1;
  }
  const sub = new W();
  sub.u16(4).u16(16 + segCount * 8).u16(0);
  sub.u16(segCount * 2).u16(pow2 * 2).u16(entrySelector).u16(segCount * 2 - pow2 * 2);
  for (const [end] of segs) sub.u16(end);
  sub.u16(0); // reservedPad
  for (const [start] of segs) sub.u16(start);
  for (const [, delta] of segs) sub.i16(delta);
  for (const [, , rangeOff] of segs) sub.u16(rangeOff);
  const cmapW = new W();
  cmapW.u16(0).u16(1).u16(3).u16(1).u32(12).raw(sub.bytes);

  // 表目录（按 tag 升序，规范建议）
  const tables: Array<[string, number[]]> = (
    [
      ['cmap', cmapW.bytes],
      ['glyf', glyf.bytes],
      ['head', head.bytes],
      ['loca', locaW.bytes],
      ['maxp', maxp.bytes],
    ] as Array<[string, number[]]>
  ).sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const headerLen = 12 + tables.length * 16;
  let offset = headerLen;
  const offsets: number[] = [];
  for (const [, data] of tables) {
    offsets.push(offset);
    offset += data.length + ((4 - (data.length % 4)) % 4);
  }
  let pow = 1;
  let es = 0;
  while (pow * 2 <= tables.length) {
    pow *= 2;
    es += 1;
  }
  const out = new W();
  out.u32(0x00010000).u16(tables.length).u16(pow * 16).u16(es).u16(tables.length * 16 - pow * 16);
  tables.forEach(([tag, data], i) => {
    out.ascii(tag).u32(0).u32(offsets[i]!).u32(data.length);
  });
  tables.forEach(([, data], i) => {
    while (out.length < offsets[i]!) out.u8(0);
    out.raw(data);
  });
  return out.toBytes();
}

/** 正确字体：一 → 轮廓 A，丁 → 轮廓 B */
export const TTF_CORRECT = buildTtf(
  [
    [0x4e00, 1],
    [0x4e01, 2],
  ],
  [undefined, SHAPE_A, SHAPE_B],
);

/** 错误字体：glyf 与正确字体**逐字节相同**，cmap 互换（= 站点字体反爬） */
export const TTF_OBFUSCATED = buildTtf(
  [
    [0x4e00, 2],
    [0x4e01, 1],
  ],
  [undefined, SHAPE_A, SHAPE_B],
);

export const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
