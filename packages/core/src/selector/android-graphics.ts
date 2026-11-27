/**
 * `android.graphics` 位图桥（2026-09-24 新增）。
 *
 * ## 为什么需要它
 * 部分漫画源把整页图**按 N 条横向切分后乱序存放**，正文里靠 `ruleContent.imageDecode`
 * 的脚本还原（Android 端正常）。🎨🔞禁漫天堂（`jmcomicui.net`）就是这种：
 *
 * ```js
 * var Magua = new JavaImporter();
 * Magua.importPackage(Packages.java.io, Packages.android.graphics);
 * with (Magua) {
 *   …
 *   var img = BitmapFactory.decodeByteArray(result, 0, result.length);
 *   var y = Math.floor(height / num);
 *   var newImg = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
 *   var canvas = new Canvas(newImg);
 *   for (var i = 1; i <= num; i++) canvas.drawBitmap(Bitmap.createBitmap(img, 0, y*(i-1), width, y+h), 0, height - y*i - h, null);
 *   var newbit = new ByteArrayOutputStream();
 *   newImg.compress(Bitmap.CompressFormat.PNG, 100, newbit);
 *   newbit.toByteArray();
 * }
 * ```
 * 我们的 java 桥此前**只有** `android.util.Base64` / `android.text.TextUtils`：
 * `Packages.android.graphics` 落到 `nest()` 兜底 ⇒ `BitmapFactory` 是空串 ⇒ 第 25 行
 * `BitmapFactory.decodeByteArray(...)` 抛 `BitmapFactory is not defined`
 * ⇒ `decodeImage` 回退原图 ⇒ **用户看到错乱的横条**（实测留痕见挂账 `#117`）。
 *
 * ## 实现取向
 * 只实现「**解码 → 像素搬运 → 重新编码**」这条最小闭环（脚本用到的全部），
 * 不模拟 Android 的完整 Bitmap API：
 *   · 像素格式统一 **RGBA8888**（`Bitmap.Config.ARGB_8888`；Android 的 ARGB 在内存里
 *     也是 R,G,B,A 顺序的 `int`，对「搬运像素」这类操作等价）；
 *   · 解码支持 **JPEG / PNG / WebP**（`jpeg-js` / `pngjs` / 内联 libwebp wasm，全纯 JS ⇒ Electron 打包安全）；
 *   · 编码支持 **PNG / JPEG**；
 *   · 脚本请求 `compress(PNG)` 时，宿主按**体积策略**默认改输出 JPEG（见下 `BITMAP_OUTPUT`，`#128`）。
 *
 * ⚠️ **只在 L1 生效**：脚本含 `JavaImporter` / `Packages.`（禁漫天堂两条都有）⇒
 * `JAVA_BRIDGE_RE` 强制留 L1；worker 侧没有 Node 编解码器，也不该有。
 */

import { decode as jpegDecode, encode as jpegEncode } from 'jpeg-js';
import { PNG } from 'pngjs';
import { decodeWebp } from './webp';

/**
 * 位图**输出格式**策略（`#128`：解密还原后体积膨胀 ~11×）。
 *
 * ## 成因（必须先理解，否则会以为是 bug）
 * 图片解密脚本按 Legado 语义调 `Bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)`
 * —— 在 Android 上这是「最保险、无损」的选择。但解密还原的是**照片类**图像（漫画页），
 * 而 **PNG 是无损格式**，对连续色调照片的压缩率极低：
 *
 * | 形态 | 字节 | 说明 |
 * |---|---|---|
 * | 站点原图 webp（有损 VP8） | 216,924 | 细节已被丢弃，换取高压缩比 |
 * | 解码后位图 RGBA（1280×1790×4） | 9,164,800 | 内存里的真实像素量 |
 * | 脚本 compress(PNG) 输出 | 2,478,347 | DEFLATE 只能压到 3.7:1（照片上几乎无效） |
 *
 * ⇒ 实测 **11.4×**。一话 30 张 ≈ 70MB，而用户实测**部分章回 200+ 张 ⇒ 单话 ~480MB**，
 * 浏览器加载必然卡死。**膨胀不是缺陷，是格式选错了**：有损源图不该用无损格式承载。
 * 正解是继续用有损格式 ⇒ 输出 JPEG（本仓已有 `jpeg-js` 编码器，**零新依赖**）。
 *
 * ## 为什么可以替脚本改格式（影响面已核实）
 * 全语料**只有 1 个源**（禁漫天堂）调用 `Bitmap.compress`，且脚本拿到字节后只做
 * base64 回传给引擎，**不解析图片头、不依赖 PNG 的透明通道**（漫画页无透明）
 * ⇒ 改输出格式对脚本**完全无感**，语义损失为零。
 *
 * ## 开关
 * `YUEDU_BITMAP_OUTPUT=png` 切回无损（排障用）；`YUEDU_BITMAP_QUALITY` 调质量（默认 85）。
 */
function bitmapOutputFormat(): 'jpeg' | 'png' {
  return String(process.env.YUEDU_BITMAP_OUTPUT ?? 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpeg';
}
/** PNG→JPEG 替代时的质量：85 在漫画（线稿+网点）上肉眼几乎无差，体积约 1/5 */
function bitmapJpegQuality(): number {
  const q = Number(process.env.YUEDU_BITMAP_QUALITY ?? 85);
  return Number.isFinite(q) && q > 0 && q <= 100 ? q : 85;
}
/** 「脚本请求 PNG 但被改写成 JPEG」只留痕一次，避免每张图刷屏 */
let lossySubstitutionLogged = false;

/** 接受源脚本可能传来的各种字节形态（Uint8Array / Buffer / Array / 数字数组） */
function toBytes(v: unknown): Uint8Array {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return new Uint8Array(v.map((x) => Number(x) & 0xff));
  if (typeof v === 'string') return new Uint8Array(Buffer.from(v, 'binary'));
  if (typeof v === 'object' && 'buffer' in (v as Record<string, unknown>)) {
    const b = (v as { buffer: ArrayBufferLike; byteOffset?: number; byteLength?: number }).buffer;
    try {
      return new Uint8Array(b);
    } catch {
      return new Uint8Array(0);
    }
  }
  return new Uint8Array(0);
}

function magicOf(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'webp';
  }
  return `unknown(${Array.from(b.slice(0, 4)).map((x) => x.toString(16)).join(' ')})`;
}

/** 位图像素容器（RGBA8888，`data` 长度 = width*height*4） */
export class AndroidBitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  private recycled = false;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    const need = this.width * this.height * 4;
    this.data = data && data.length >= need ? data.subarray(0, need) : new Uint8Array(need);
  }

  // ---- Android Bitmap API（脚本实际用到的） ----
  getWidth(): number {
    return this.width;
  }
  getHeight(): number {
    return this.height;
  }
  getConfig(): string {
    return 'ARGB_8888';
  }
  getByteCount(): number {
    return this.width * this.height * 4;
  }
  isRecycled(): boolean {
    return this.recycled;
  }
  recycle(): void {
    this.recycled = true;
  }
  /** `getPixels(pixels, offset, stride, x, y, width, height)` —— 脚本少见，补上以免 NOT_A_FUNCTION */
  getPixels(pixels: unknown, offset = 0, _stride = 0, x = 0, y = 0, w?: number, h?: number): void {
    const out = toBytes(pixels);
    const cw = w ?? this.width - x;
    const ch = h ?? this.height - y;
    let k = Number(offset) || 0;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        const o = ((y + j) * this.width + (x + i)) * 4;
        // Android 里 pixels 是 ARGB int（不是字节）；这里按字节序回写，够脚本做简单判断
        out[k++] = this.data[o] ?? 0;
        out[k++] = this.data[o + 1] ?? 0;
        out[k++] = this.data[o + 2] ?? 0;
        out[k++] = this.data[o + 3] ?? 0;
      }
    }
  }

  /**
   * 编码并写入 `ByteArrayOutputStream`（对齐 Android `Bitmap.compress(format, quality, stream)`）。
   * 脚本的返回值取的是 `newbit.toByteArray()`，所以**必须**把字节真的写进流。
   */
  compress(format: unknown, quality: unknown, stream: unknown): boolean {
    const fmt = String(format ?? 'PNG').toUpperCase();
    const q = Number.isFinite(Number(quality)) ? Number(quality) : 100;
    const bytes = this.encode(fmt, q);
    const w = stream as { write?: (b: unknown) => void } | null | undefined;
    if (!w || typeof w.write !== 'function') {
      throw new Error('Bitmap.compress: 第 3 个参数必须是 ByteArrayOutputStream');
    }
    w.write(bytes);
    return true;
  }

  private encode(fmt: string, quality: number): Uint8Array {
    if (fmt.includes('PNG')) {
      /**
       * 体积策略（`#128`）：脚本按 Legado 语义要**无损 PNG**，但解密还原的是**照片类**图像
       * ⇒ 默认改输出有损 JPEG（一次成像的细节本来就在源 webp 里丢过，无损只是把
       * 9.2MB 像素用 2.4MB「装回去」）。详见本文件头 `bitmapOutputFormat` 的注释。
       */
      if (bitmapOutputFormat() === 'jpeg') {
        const q = bitmapJpegQuality();
        if (!lossySubstitutionLogged) {
          lossySubstitutionLogged = true;
          console.log(
            `[legado] Bitmap.compress(PNG) → JPEG(q=${q})：解密产物为照片类，` +
              `无损 PNG 会让体积膨胀约 11×（#128）。设 YUEDU_BITMAP_OUTPUT=png 可切回无损。`,
          );
        }
        return this.encodeJpeg(q);
      }
      const png = new PNG({ width: this.width, height: this.height });
      png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.length);
      return new Uint8Array(PNG.sync.write(png));
    }
    if (fmt.includes('JPEG')) return this.encodeJpeg(quality);
    throw new Error(
      `Bitmap.compress: 不支持的 CompressFormat「${fmt}」（已实现 PNG/JPEG；WebP 编码未实现——本仓内联的只有解码器）`,
    );
  }

  /** JPEG 编码（jpeg-js 期望 RGBA 输入，内部自行转 RGB；quality 取 1~100） */
  private encodeJpeg(quality: number): Uint8Array {
    const out = jpegEncode(
      { data: Buffer.from(this.data.buffer, this.data.byteOffset, this.data.length), width: this.width, height: this.height },
      quality,
    );
    return new Uint8Array(out.data);
  }
}

/** `BitmapFactory`：只实现 `decodeByteArray`（脚本用的就是它） */
function makeBitmapFactory(): Record<string, unknown> {
  return {
    decodeByteArray(bytes: unknown, offset?: unknown, length?: unknown): AndroidBitmap {
      const all = toBytes(bytes);
      const off = Math.max(0, Number(offset) || 0);
      const len = length == null ? all.length - off : Math.max(0, Number(length) || 0);
      const buf = all.subarray(off, Math.min(all.length, off + len));
      const kind = magicOf(buf);
      if (kind === 'jpeg') {
        const d = jpegDecode(buf, { useTArray: true, formatAsRGBA: true });
        return new AndroidBitmap(d.width, d.height, d.data);
      }
      if (kind === 'png') {
        const d = PNG.sync.read(Buffer.from(buf));
        return new AndroidBitmap(d.width, d.height, d.data);
      }
      /**
       * webp（2026-09-25 补）：禁漫天堂那类源的正文图现在是 **webp（有损 VP8）**，
       * 而切条还原脚本必须拿到像素才能重排 ⇒ 缺 webp 解码就会抛错回退原图
       * （用户症状：「图片还是切条的，没有解密」；实测直连/经代理字节 sha1 全等 = 原样回退）。
       * `decodeWebp` 是**同步**的纯 wasm 实现（见 webp.ts 的说明）。
       */
      if (kind === 'webp') {
        const d = decodeWebp(buf);
        return new AndroidBitmap(d.width, d.height, d.data);
      }
      throw new Error(
        `BitmapFactory.decodeByteArray: 不支持的图片格式「${kind}」（已实现 JPEG/PNG/WebP；` +
          `gif 未实现 —— 源规则通常对 gif 走 result 直返）`,
      );
    },
  };
}

/**
 * `Rect`（`#587`）：新版禁漫天堂系 `imageDecode` 的切条乱序还原写
 *   `canvas.drawBitmap(bmp, new Rect(0, ys, w, ys + m2), new Rect(0, yd, w, yd + m2), paint)`
 * 我们此前 `android.graphics` 没有 `Rect` ⇒ `new undefined` 抛
 * 「Rect is not a constructor」⇒ 整段解密被源脚本的 try 吞掉 ⇒ 回原图
 * （用户实测「🖼 图解码失败: TypeError: Packages.android.graphics.Rect is not a constructor」）。
 *
 * Android 的 `Rect` 是**公共 int 字段**（left/top/right/bottom）而非 getter；源脚本两种
 * 写法都可能出现（字段直读 / `width()`/`height()`），这里都实现。构造**不做归一**
 * （与 Android 一致；要归一显式调 `sort()`）。
 */
function makeRectCtor(): unknown {
  class Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    constructor(left = 0, top = 0, right = 0, bottom = 0) {
      this.left = Math.floor(Number(left) || 0);
      this.top = Math.floor(Number(top) || 0);
      this.right = Math.floor(Number(right) || 0);
      this.bottom = Math.floor(Number(bottom) || 0);
    }
    /** Android 语义：right/bottom 必须 ≥ left/top */
    sort(): void {
      if (this.left > this.right) {
        const t = this.left;
        this.left = this.right;
        this.right = t;
      }
      if (this.top > this.bottom) {
        const t = this.top;
        this.top = this.bottom;
        this.bottom = t;
      }
    }
    set(left: number, top: number, right: number, bottom: number): void {
      this.left = Math.floor(Number(left) || 0);
      this.top = Math.floor(Number(top) || 0);
      this.right = Math.floor(Number(right) || 0);
      this.bottom = Math.floor(Number(bottom) || 0);
    }
    width(): number {
      return this.right - this.left;
    }
    height(): number {
      return this.bottom - this.top;
    }
    centerX(): number {
      return (this.left + this.right) >> 1;
    }
    centerY(): number {
      return (this.top + this.bottom) >> 1;
    }
    isEmpty(): boolean {
      return this.left >= this.right || this.top >= this.bottom;
    }
    contains(x: number, y: number): boolean {
      return x >= this.left && x < this.right && y >= this.top && y < this.bottom;
    }
    intersect(other: Rect): boolean {
      this.left = Math.max(this.left, other.left);
      this.top = Math.max(this.top, other.top);
      this.right = Math.min(this.right, other.right);
      this.bottom = Math.min(this.bottom, other.bottom);
      return !this.isEmpty();
    }
    /** `inset(dx, dy)`：四边向内收（Android 语义） */
    inset(dx: number, dy: number): void {
      this.left += Math.floor(Number(dx) || 0);
      this.top += Math.floor(Number(dy) || 0);
      this.right -= Math.floor(Number(dx) || 0);
      this.bottom -= Math.floor(Number(dy) || 0);
    }
    offset(dx: number, dy: number): void {
      this.left += Math.floor(Number(dx) || 0);
      this.right += Math.floor(Number(dx) || 0);
      this.top += Math.floor(Number(dy) || 0);
      this.bottom += Math.floor(Number(dy) || 0);
    }
    toString(): string {
      return `Rect(${this.left}, ${this.top} - ${this.right}, ${this.bottom})`;
    }
  }
  return Rect;
}

/** 鸭子类型判 Rect（跨 realm 也可能传来；四个 int 字段齐了就当 Rect） */
function isRectLike(x: unknown): x is { left: number; top: number; right: number; bottom: number } {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.left === 'number' &&
    typeof r.top === 'number' &&
    typeof r.right === 'number' &&
    typeof r.bottom === 'number'
  );
}

/** `Canvas`：只支持「构造于 Bitmap + drawBitmap」，够还原切条乱序 */
function makeCanvasCtor(): unknown {
  class Canvas {
    private readonly target: AndroidBitmap;
    constructor(target: unknown) {
      if (!(target instanceof AndroidBitmap)) {
        throw new Error('Canvas: 构造参数必须是 Bitmap（本实现只支持位图画布，不支持 View/Surface）');
      }
      this.target = target;
    }
    /**
     * `drawBitmap` 两种形态（Android 都有）：
     *  ① `(bmp, left, top, paint)` —— 整图贴到 (left, top)；
     *  ② `(bmp, srcRect, dstRect, paint)`（`#587`）—— srcRect 区域**缩放**铺进 dstRect
     *     （禁漫天堂传等大矩形 ⇒ 1:1；最近邻缩放，无滤镜，与源脚本 setAntiAlias(false) 一致）。
     */
    drawBitmap(src: unknown, a?: unknown, b?: unknown, _paint?: unknown): void {
      if (!(src instanceof AndroidBitmap)) throw new Error('Canvas.drawBitmap: 第 1 个参数必须是 Bitmap');
      if (isRectLike(a) && isRectLike(b)) {
        this.drawRegion(src, a, b);
        return;
      }
      const dx = Math.floor(Number(a) || 0);
      const dy = Math.floor(Number(b) || 0);
      const { width: tw, height: th } = this.target;
      for (let y = 0; y < src.height; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= th) continue;
        for (let x = 0; x < src.width; x++) {
          const tx = dx + x;
          if (tx < 0 || tx >= tw) continue;
          this.blend(src, x, y, tx, ty);
        }
      }
    }
    /** 把源图像素 (sx,sy) 混写到目标 (tx,ty)（SRC_OVER；调用方已做边界检查） */
    private blend(src: AndroidBitmap, sx: number, sy: number, tx: number, ty: number): void {
      const { width: tw, data: td } = this.target;
      const s = (sy * src.width + sx) * 4;
      const d = (ty * tw + tx) * 4;
      const sa = (src.data[s + 3] ?? 255) / 255;
      if (sa >= 1) {
        td[d] = src.data[s]!;
        td[d + 1] = src.data[s + 1]!;
        td[d + 2] = src.data[s + 2]!;
        td[d + 3] = 255;
      } else if (sa > 0) {
        td[d] = Math.round(src.data[s]! * sa + td[d]! * (1 - sa));
        td[d + 1] = Math.round(src.data[s + 1]! * sa + td[d + 1]! * (1 - sa));
        td[d + 2] = Math.round(src.data[s + 2]! * sa + td[d + 2]! * (1 - sa));
        td[d + 3] = Math.max(td[d + 3]!, Math.round(sa * 255));
      }
    }
    /** `#587` 六参形态的区域搬运：srcRect 区域按**最近邻**缩放进 dstRect */
    private drawRegion(
      src: AndroidBitmap,
      srcRect: { left: number; top: number; right: number; bottom: number },
      dstRect: { left: number; top: number; right: number; bottom: number },
    ): void {
      const sw = Math.max(0, srcRect.right - srcRect.left);
      const sh = Math.max(0, srcRect.bottom - srcRect.top);
      const dw = Math.max(0, dstRect.right - dstRect.left);
      const dh = Math.max(0, dstRect.bottom - dstRect.top);
      if (sw === 0 || sh === 0 || dw === 0 || dh === 0) return;
      const { width: tw, height: th } = this.target;
      for (let y = 0; y < dh; y++) {
        const ty = dstRect.top + y;
        if (ty < 0 || ty >= th) continue;
        const sy = srcRect.top + Math.min(sh - 1, Math.floor((y * sh) / dh));
        for (let x = 0; x < dw; x++) {
          const tx = dstRect.left + x;
          if (tx < 0 || tx >= tw) continue;
          const sx = srcRect.left + Math.min(sw - 1, Math.floor((x * sw) / dw));
          this.blend(src, sx, sy, tx, ty);
        }
      }
    }
    /** 少数源会先铺底色；`drawColor(colorInt)` 按 ARGB int 解包 */
    drawColor(color: unknown): void {
      const c = Number(color) >>> 0;
      const a = (c >>> 24) & 0xff;
      const r = (c >>> 16) & 0xff;
      const g = (c >>> 8) & 0xff;
      const b = c & 0xff;
      const { data: td } = this.target;
      for (let i = 0; i < td.length; i += 4) {
        td[i] = r;
        td[i + 1] = g;
        td[i + 2] = b;
        td[i + 3] = a;
      }
    }
  }
  return Canvas;
}

/**
 * `Paint`（`#577`）：只做**状态容器**，不做抗锯齿/滤镜的真实渲染。
 *
 * 为什么必须有：新版禁漫天堂系 `imageDecode` 会写
 *   `var paint = new Paint(); paint.setAntiAlias(false); canvas.drawBitmap(bmp, x, y, paint);`
 * 我们此前 `android.graphics` 只有 BitmapFactory/Bitmap/Canvas ⇒ `Packages.android.graphics.Paint`
 * 是 `undefined` ⇒ `new undefined` 抛「Paint is not a constructor」⇒ 整段解密被 try 吞掉
 * ⇒ 用户看到「图片按横向条分割」。像素搬运不依赖抗锯齿（脚本自己传 false），状态存着即可。
 */
function makePaintCtor(): unknown {
  class Paint {
    antiAlias = false;
    filterBitmap = false;
    dither = false;
    color = 0xff000000;
    alpha = 255;
    style = 'FILL';
    strokeWidth = 0;

    setAntiAlias(v: unknown): void { this.antiAlias = !!v; }
    isAntiAlias(): boolean { return this.antiAlias; }
    setFilterBitmap(v: unknown): void { this.filterBitmap = !!v; }
    isFilterBitmap(): boolean { return this.filterBitmap; }
    setDither(v: unknown): void { this.dither = !!v; }
    isDither(): boolean { return this.dither; }
    setColor(c: unknown): void { this.color = Number(c) >>> 0; }
    getColor(): number { return this.color; }
    setAlpha(a: unknown): void { this.alpha = Math.max(0, Math.min(255, Number(a) || 0)); }
    getAlpha(): number { return this.alpha; }
    setStyle(s: unknown): void { this.style = String(s ?? 'FILL'); }
    getStyle(): string { return this.style; }
    setStrokeWidth(w: unknown): void { this.strokeWidth = Number(w) || 0; }
    getStrokeWidth(): number { return this.strokeWidth; }
    reset(): void {
      this.antiAlias = false;
      this.filterBitmap = false;
      this.dither = false;
      this.color = 0xff000000;
      this.alpha = 255;
      this.style = 'FILL';
      this.strokeWidth = 0;
    }
  }
  return Paint;
}

/**
 * `Packages.android.graphics` 命名空间。
 *
 * ⚠️ 必须是**真对象**（不是 Proxy）：`JavaImporter.importPackage()` 靠 `Object.keys(pkg)`
 * 取类名挂裸名（见 java-bridge 的 `makeJavaImporterCtor`）。
 */
export function makeAndroidGraphicsNs(): Record<string, unknown> {
  const BitmapFactory = makeBitmapFactory();
  const Canvas = makeCanvasCtor();
  const Paint = makePaintCtor();
  const Rect = makeRectCtor();
  /** `Bitmap` 既被当工厂用（`Bitmap.createBitmap`），也承载两个常量表 */
  const Bitmap = {
    /**
     * 两种形态（脚本只用这两种）：
     *   ① `createBitmap(width, height, config)` → 空白位图
     *   ② `createBitmap(src, x, y, width, height)` → 裁剪（越界自动收敛，Android 同样会夹取）
     */
    createBitmap(a: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown): AndroidBitmap {
      if (a instanceof AndroidBitmap) {
        const x = Math.max(0, Math.floor(Number(b) || 0));
        const y = Math.max(0, Math.floor(Number(c) || 0));
        const w = Math.min(Math.floor(Number(d) || 0), a.width - x);
        const h = Math.min(Math.floor(Number(e) || 0), a.height - y);
        const out = new AndroidBitmap(Math.max(0, w), Math.max(0, h));
        for (let j = 0; j < out.height; j++) {
          const sy = y + j;
          const srcOff = (sy * a.width + x) * 4;
          out.data.set(a.data.subarray(srcOff, srcOff + out.width * 4), j * out.width * 4);
        }
        return out;
      }
      if (typeof a === 'number' && typeof b === 'number') return new AndroidBitmap(a, b);
      throw new Error('Bitmap.createBitmap: 参数形态不支持（已实现 (w,h,config) 与 (src,x,y,w,h)）');
    },
    Config: { ARGB_8888: 'ARGB_8888', RGB_565: 'RGB_565', ALPHA_8: 'ALPHA_8', RGBA_F16: 'RGBA_F16' },
    CompressFormat: { PNG: 'PNG', JPEG: 'JPEG', WEBP: 'WEBP' },
  };
  return { BitmapFactory, Bitmap, Canvas, Paint, Rect };
}
