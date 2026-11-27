/**
 * 页面卷曲引擎：**一套几何 + 两套光栅器**（WebGL / Canvas2D）。
 *
 * 几何模型（单页阅读：**书脊在页面左缘**，不是 Turn.js 的「CSS 旋转 + 渐变阴影」近似）：
 *   · 折线是**一条平行于书脊的竖线**，按进度从右缘**线性**扫到左缘（不是按弧长加速），
 *     所以 p=0.5 时折线正好在页宽中点，翻过的面积与进度严格成正比；
 *   · 平展的正面**永远在折线左侧**（靠书脊），下一页**永远从折线右侧**露出；
 *     正向 p:0→1 = 当前页被卷走，回翻 p:1→0 = 上一页从书脊向右铺开 —— **同一套几何**；
 *   · 折线右侧的纸面绕**半径 R 的半圆柱**卷过去（弧长 = 到折线的距离）；
 *     超过 πR 的部分视为卷进圆柱（退化、不绘制），纸背只出现在折边附近，
 *     **不会平铺盖住左半页**：`#849` 首版的回翻「左半屏没字 / 末尾白纸背」就是那一段被铺开造成的，
 *     `#854` 修正（几何不再按方向镜像 + 超过 πR 钳在 φ=π）；
 *   · 顶点带真实 z（卷起高度）与法线 ⇒ 正反面、受光、折角阴影都是算出来的；
 *   · 前端只负责给「进度 0~1 / 方向 / 三张纹理（前页 / 背面 / 后页）」。
 *
 * 为什么默认 Canvas2D：
 *   · 用户实测 Canvas2D 的卷曲观感优于 WebGL（折边/纸背的明暗更连贯）；
 *   · WebGL 降为**可选加速档**：只有显式 `renderer: 'webgl'` 才尝试，
 *     创建失败或软件渲染（SwiftShader）自动退回 Canvas2D；
 *   · 降级链（Canvas2D → WebGL(可选) → CSS 透视 → 无动画）由 `PageCurl.vue` 负责。
 *
 * 性能纪律：
 *   · 光栅化像素比默认**封顶 1.5**（`maxDpr`）：HiDPI dpr=2 的像素量降 ~44%，
 *     `#854` 实测 Canvas2D 43→55 fps；页面纹理仍按宿主 dpr 绘制（清晰度不跟着降）；
 *   · 顶点数 = (cols+1)*(rows+1)，20×10=231 / 32×16=561，CPU 侧每帧重算可以忽略；
 *   · WebGL 每帧 2 个 draw call（后页底板 + 卷曲纸面），纹理只在换页时上传；
 *   · Canvas2D 按三角形裁剪绘制，20×10 约 400 次 drawImage，是**降级路径**而不是主路径。
 */

const PI = Math.PI;
const LIGHT = normalize3(-0.35, -0.55, 0.76);
const FLAT_DOT = LIGHT[2];

export type CurlRendererName = 'webgl' | 'canvas2d';
export type CurlTextureSource =
  | HTMLCanvasElement
  | HTMLImageElement
  | ImageBitmap
  | OffscreenCanvas;

export interface CurlLayout {
  /** 页面（正文区）宽，CSS px */
  width: number;
  /** 页面高，CSS px */
  height: number;
  /** 四周透明留白，给卷角留出画面；默认 56 */
  padding?: number;
  /** 绘制分辨率倍数；默认 1（阅读器里可按 devicePixelRatio 传 2） */
  dpr?: number;
}

export interface CurlTextures {
  /** 当前页正面 */
  front: CurlTextureSource | null;
  /** 当前页背面（翻过去以后看到的那一面） */
  back: CurlTextureSource | null;
  /** 翻页完成后露出的下一页 */
  next: CurlTextureSource | null;
}

export interface CurlDegradeInfo {
  from: CurlRendererName;
  reason: 'no-webgl' | 'software' | 'fps';
  fps: number;
}

export interface CurlPerfConfig {
  /** 统计窗口帧数，默认 60 */
  window?: number;
  /** 低于该帧率即记一个坏窗口，默认 50 */
  fps?: number;
  /** 连续坏窗口数达到该值触发降级，默认 2 */
  consecutive?: number;
}

export interface CurlEngineOptions {
  layout: CurlLayout;
  renderer?: CurlRendererName | 'auto';
  /** [列, 行]；默认 [20, 10] */
  grid?: [number, number];
  /**
   * 圆柱半径 / 页宽，默认 **0.12**（用户 2026-11-09：0.075 观感像薄纸，
   * 折角要有肉眼可见的「卷曲厚度」）。Canvas2D 与 WebGL 共用同一个 R，
   * 只改这一处即可保证两个光栅器的几何一致。
   */
  radiusRatio?: number;
  /** 透视焦距（px），默认 1500 */
  focal?: number;
  /** 折线倾角（弧度），默认 0 = 竖直折线（平行书脊）；非 0 会得到斜折线的「揭页」观感 */
  tilt?: number;
  /**
   * 卷曲层的**光栅化像素比上限**，默认 1.5。
   * `layout.dpr` 超过它时按最大值渲染（HiDPI dpr=2 走 1.5，像素量降 ~44%）：
   * 核显上 dpr=2 的 Canvas2D 只有 43–49 fps，封 1.5 后回到 vsync 附近；
   * 页面纹理仍按宿主 dpr 绘制（更清晰），这里只限制合成底图。
   */
  maxDpr?: number;
  perf?: CurlPerfConfig;
  onDegrade?: (info: CurlDegradeInfo) => void;
}

export interface CurlStats {
  renderer: CurlRendererName;
  glName: string;
  software: boolean;
  progress: number;
  grid: [number, number];
  /** 实际使用的光栅化像素比（已按 `maxDpr` 封顶） */
  dpr: number;
  lastDrawMs: number;
  lastUploadMs: number;
}

interface MeshData {
  /** stride = 8: px, py, z, u, v, lightFront, lightBack, ao */
  data: Float32Array;
  indices: Uint16Array;
}

const VERTEX_STRIDE = 8;
/** Canvas2D 三角形裁剪外扩量（px，CSS 像素）：压掉相邻三角形之间的抗锯齿亮缝 */
const CLIP_GROW = 0.8;

function expand(p: { x: number; y: number }, cx: number, cy: number, by: number): { x: number; y: number } {
  const dx = p.x - cx;
  const dy = p.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  return { x: p.x + (dx / len) * by, y: p.y + (dy / len) * by };
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + (log ?? ''));
  }
  return sh;
}

function makeProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('program link failed: ' + (log ?? ''));
  }
  return prog;
}

const VS = `
attribute vec2 a_pos;
attribute float a_z;
attribute vec2 a_uv;
attribute vec2 a_light;
attribute float a_ao;
uniform vec2 u_center;
uniform vec2 u_css;
uniform float u_focal;
uniform float u_depth;
varying vec2 v_uv;
varying vec2 v_light;
varying vec2 v_page;
varying float v_ao;
void main() {
  float s = u_focal / (u_focal - a_z);
  vec2 p = u_center + (a_pos - u_center) * s;
  vec2 clip = vec2(p.x / u_css.x * 2.0 - 1.0, 1.0 - p.y / u_css.y * 2.0);
  gl_Position = vec4(clip.x, clip.y, u_depth - a_z * 0.0012, 1.0);
  v_uv = a_uv;
  v_light = a_light;
  v_page = a_pos;
  v_ao = a_ao;
}
`;

const FS = `
precision mediump float;
uniform sampler2D u_front;
uniform sampler2D u_back;
uniform sampler2D u_next;
uniform float u_isSheet;
uniform vec2 u_shadowOrigin;
uniform vec2 u_shadowDir;
uniform float u_shadowStrength;
varying vec2 v_uv;
varying vec2 v_light;
varying vec2 v_page;
varying float v_ao;
void main() {
  if (u_isSheet > 0.5) {
    if (gl_FrontFacing) {
      vec4 t = texture2D(u_front, v_uv);
      gl_FragColor = vec4(t.rgb * v_light.x * v_ao, 1.0);
    } else {
      vec4 t = texture2D(u_back, vec2(1.0 - v_uv.x, v_uv.y));
      gl_FragColor = vec4(t.rgb * v_light.y * v_ao, 1.0);
    }
  } else {
    vec4 t = texture2D(u_next, v_uv);
    float d = dot(v_page - u_shadowOrigin, u_shadowDir);
    float sh = d > 0.0 ? exp(-d / 90.0) * u_shadowStrength : 0.0;
    gl_FragColor = vec4(t.rgb * (1.0 - sh), 1.0);
  }
}
`;

export class PageCurlEngine {
  private canvas: HTMLCanvasElement;
  private opts: Required<Omit<CurlEngineOptions, 'renderer' | 'onDegrade' | 'perf'>> & {
    renderer: CurlRendererName | 'auto';
    onDegrade?: (info: CurlDegradeInfo) => void;
    perf: Required<CurlPerfConfig>;
  };

  private pageW: number;
  private pageH: number;
  private pad: number;
  private dpr: number;
  private maxDpr: number;
  private cssW: number;
  private cssH: number;

  private renderer: CurlRendererName = 'canvas2d';
  private gl: WebGLRenderingContext | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  /** Canvas2D 的纸面离屏层（明暗统一在上面做，避免逐格色块） */
  private sheetCanvas: HTMLCanvasElement | null = null;
  private sheetCtx2d: CanvasRenderingContext2D | null = null;
  private prog: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private glTextures: (WebGLTexture | null)[] = [null, null, null];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private attribs: Record<string, number> = {};
  private glName = '';
  private software = false;

  private textures: CurlTextures = { front: null, back: null, next: null };
  private texDirty = true;
  private lastUploadMs = 0;

  private progress = 0;
  private direction: 1 | -1 = 1;
  private grid: [number, number];
  private tilt: number;

  private lastDrawMs = 0;
  private perfBuf: number[] = [];
  private badWindows = 0;
  private degraded = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: CurlEngineOptions) {
    this.canvas = canvas;
    this.pageW = Math.max(1, options.layout.width);
    this.pageH = Math.max(1, options.layout.height);
    this.pad = options.layout.padding ?? 56;
    this.maxDpr = Math.max(1, options.maxDpr ?? 1.5);
    this.dpr = Math.min(options.layout.dpr ?? 1, this.maxDpr);
    this.cssW = this.pageW + this.pad * 2;
    this.cssH = this.pageH + this.pad * 2;
    this.grid = options.grid ?? [20, 10];
    this.tilt = options.tilt ?? 0;
    this.opts = {
      layout: options.layout,
      grid: this.grid,
      radiusRatio: options.radiusRatio ?? 0.12,
      focal: options.focal ?? 1500,
      tilt: this.tilt,
      maxDpr: this.maxDpr,
      perf: {
        window: options.perf?.window ?? 60,
        fps: options.perf?.fps ?? 50,
        consecutive: options.perf?.consecutive ?? 2,
      },
      renderer: options.renderer ?? 'auto',
      onDegrade: options.onDegrade,
    };

    canvas.width = Math.round(this.cssW * this.dpr);
    canvas.height = Math.round(this.cssH * this.dpr);
    canvas.style.width = `${this.cssW}px`;
    canvas.style.height = `${this.cssH}px`;

    this.createRenderer();
  }

  // ---------------------------------------------------------------- renderer

  private createRenderer(): void {
    const want = this.opts.renderer;
    // 默认（'auto' / 'canvas2d'）直接走 Canvas2D：观感更好，也不再依赖 WebGL。
    // 只有显式要 'webgl' 时才探针 + 拿上下文；失败 / 软件渲染自动退回 Canvas2D。
    if (want === 'webgl') {
      // ⚠️ 先在一张**临时 canvas** 上探针：一旦在真画布上拿到 webgl 上下文，
      // 这张画布就再也拿不到 2d 上下文了（同一 canvas 只能绑定一种上下文）。
      // 软件渲染（SwiftShader / llvmpipe）直接判负，走 Canvas2D。
      const probe = this.probeWebGL();
      if (probe.ok && !probe.software) {
        const gl = this.acquireGL();
        if (gl) {
          this.renderer = 'webgl';
          this.gl = gl;
          this.initGL(gl);
          return;
        }
      }
      this.opts.onDegrade?.({
        from: 'webgl',
        reason: probe.ok ? 'software' : 'no-webgl',
        fps: 0,
      });
    }
    this.renderer = 'canvas2d';
    this.ctx2d = this.canvas.getContext('2d', { alpha: true });
    if (!this.ctx2d) throw new Error('Canvas2D context unavailable');
  }

  /** 临时画布上探 WebGL 可用性与 GPU 名称（探完立刻 loseContext，不留上下文） */
  private probeWebGL(): { ok: boolean; name: string; software: boolean } {
    let probe: HTMLCanvasElement | null = null;
    let gl: WebGLRenderingContext | null = null;
    try {
      probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      gl = probe.getContext('webgl', {
        alpha: true,
        antialias: false,
        preserveDrawingBuffer: false,
      }) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return { ok: false, name: '', software: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '')
      : String(gl.getParameter(gl.RENDERER) ?? '');
    const software = /swiftshader|software|basic render|llvmpipe/i.test(name);
    this.glName = name;
    this.software = software;
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* 探针画布本来就要丢掉 */
    }
    return { ok: true, name, software };
  }

  private acquireGL(): WebGLRenderingContext | null {
    try {
      return this.canvas.getContext('webgl', {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
        depth: true,
        preserveDrawingBuffer: false,
      }) as WebGLRenderingContext | null;
    } catch {
      return null;
    }
  }

  private initGL(gl: WebGLRenderingContext): void {
    this.prog = makeProgram(gl, VS, FS);
    gl.useProgram(this.prog);
    this.attribs.pos = gl.getAttribLocation(this.prog, 'a_pos');
    this.attribs.z = gl.getAttribLocation(this.prog, 'a_z');
    this.attribs.uv = gl.getAttribLocation(this.prog, 'a_uv');
    this.attribs.light = gl.getAttribLocation(this.prog, 'a_light');
    this.attribs.ao = gl.getAttribLocation(this.prog, 'a_ao');
    for (const key of [
      'u_center',
      'u_css',
      'u_focal',
      'u_depth',
      'u_front',
      'u_back',
      'u_next',
      'u_isSheet',
      'u_shadowOrigin',
      'u_shadowDir',
      'u_shadowStrength',
    ]) {
      this.uniforms[key] = gl.getUniformLocation(this.prog, key);
    }
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.uniform1i(this.uniforms.u_front ?? null, 0);
    gl.uniform1i(this.uniforms.u_back ?? null, 1);
    gl.uniform1i(this.uniforms.u_next ?? null, 2);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // 页面坐标 y 向下；投到 clip 后 y 翻转，所以顺时针才是正面
    gl.frontFace(gl.CW);
    gl.clearColor(0, 0, 0, 0);
  }

  // ------------------------------------------------------------------ public

  setTextures(textures: CurlTextures): void {
    this.textures = textures;
    this.texDirty = true;
  }

  setProgress(progress: number): void {
    this.progress = clamp(progress, 0, 1);
  }

  setDirection(direction: 1 | -1): void {
    this.direction = direction === -1 ? -1 : 1;
  }

  setTilt(rad: number): void {
    this.tilt = clamp(rad, -0.42, 0.42);
  }

  setGrid(grid: [number, number]): void {
    this.grid = [Math.max(2, Math.round(grid[0])), Math.max(2, Math.round(grid[1]))];
  }

  getStats(): CurlStats {
    return {
      renderer: this.renderer,
      glName: this.glName,
      software: this.software,
      progress: this.progress,
      grid: this.meshGrid(),
      dpr: this.dpr,
      lastDrawMs: this.lastDrawMs,
      lastUploadMs: this.lastUploadMs,
    };
  }

  /**
   * 基准测试用：把 **WebGL** 队列跑空，拿到真实单帧核显耗时。
   *
   * ⚠️ Canvas2D 故意**不**做同步：实测在核显上用 `getImageData(0,0,1,1)` 强推一次
   * 光栅化落地会把单帧拉到 1.3s（Chromium 的 canvas 回读路径在无 `willReadFrequently`
   * 时是整体回读）。那条路只能测「回读开销」而不是「卷曲开销」，所以 Canvas2D 的
   * 真实帧率只认 rAF 节奏（见 `tmp/page-curl/bench-results.json`）。
   */
  flush(): void {
    this.gl?.finish();
  }

  /**
   * 自动降级：只在卷曲活跃的帧上调用（静止平面页不需要统计）。
   * 连续 `window × consecutive` 帧的中位帧率低于 `fps` ⇒ 回调一次。
   */
  noteFrame(dtMs: number): void {
    if (this.degraded || !this.opts.onDegrade) return;
    if (!(dtMs > 0) || dtMs > 4000) return;
    this.perfBuf.push(dtMs);
    if (this.perfBuf.length < this.opts.perf.window) return;
    const sorted = this.perfBuf.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
    const fps = 1000 / median;
    this.perfBuf.length = 0;
    if (fps < this.opts.perf.fps) {
      this.badWindows += 1;
      if (this.badWindows >= this.opts.perf.consecutive) {
        this.degraded = true;
        this.opts.onDegrade({ from: this.renderer, reason: 'fps', fps });
      }
    } else {
      this.badWindows = 0;
    }
  }

  resetPerf(): void {
    this.perfBuf.length = 0;
    this.badWindows = 0;
    this.degraded = false;
  }

  dispose(): void {
    this.disposed = true;
    const gl = this.gl;
    if (gl) {
      for (const t of this.glTextures) if (t) gl.deleteTexture(t);
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.ibo) gl.deleteBuffer(this.ibo);
      if (this.prog) gl.deleteProgram(this.prog);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.ctx2d = null;
  }

  resize(layout: CurlLayout): void {
    this.pageW = Math.max(1, layout.width);
    this.pageH = Math.max(1, layout.height);
    this.pad = layout.padding ?? this.pad;
    this.dpr = Math.min(layout.dpr ?? this.dpr, this.maxDpr);
    this.cssW = this.pageW + this.pad * 2;
    this.cssH = this.pageH + this.pad * 2;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.texDirty = true;
  }

  // ----------------------------------------------------------------- geometry

  /**
   * 实际使用的网格。
   *
   * Canvas2D 每帧要对每个小格做一次三角形裁剪 + `drawImage`（2·cols·rows 次），
   * 32×16 在核显上会掉到自动降级阈值以下（`tmp/page-curl/bench-results.json`），
   * 所以 **Canvas2D 封顶 20×10**；WebGL 走 GPU 光栅化，按宿主给的网格（桌面 32×16）。
   */
  private meshGrid(): [number, number] {
    if (this.renderer !== 'canvas2d') return this.grid;
    return [Math.min(this.grid[0], 20), Math.min(this.grid[1], 10)];
  }

  /**
   * 折线到「右缘」的有符号距离。
   *
   * 书脊在**页面左缘**：起点 = 0（折线正好压在右缘 ⇒ 整页平展），
   * 终点 = 页面最远点（左缘）的 u 值。**线性**走完页宽跨度，所以 p=0.5 时折线
   * 正好在页宽中点，「翻过的面积 / 页面总面积」≈ progress。
   *
   * ★ 两个方向共用同一套几何（不再按 direction 镜像屏幕）：
   *   平展正面永远在折线左侧，下一页永远在折线右侧；回翻只是 progress 1→0，
   *   于是上一页从书脊（左缘）向右铺开，而不是「从右边长出来」。
   */
  private creaseOffset(): number {
    const cos = Math.cos(this.tilt);
    const sin = Math.sin(this.tilt);
    const span = this.pageW * cos + this.pageH * sin;
    return -this.progress * span;
  }

  private buildMesh(): MeshData {
    const [cols, rows] = this.meshGrid();
    const R = this.opts.radiusRatio * this.pageW;
    const cos = Math.cos(this.tilt);
    const sin = Math.sin(this.tilt);
    const cornerX = this.pad + this.pageW;
    const cornerY = this.pad + this.pageH;
    const uf = this.creaseOffset();
    const data = new Float32Array((cols + 1) * (rows + 1) * VERTEX_STRIDE);
    let o = 0;

    for (let j = 0; j <= rows; j += 1) {
      const sy = this.pad + (j / rows) * this.pageH;
      for (let i = 0; i <= cols; i += 1) {
        const sx = this.pad + (i / cols) * this.pageW;
        const u = (sx - cornerX) * cos + (sy - cornerY) * sin;
        let outX = sx;
        let outY = sy;
        let z = 0;
        let phi = 0;
        let nearCrease = 0;

        // 折线右侧的纸面绕半圆柱卷过去；弧长超过 πR 后视为「卷进圆柱」：
        // 位置钳在 φ=π 的同一点 ⇒ 三角形退化、不绘制。**不再**把多余的纸
        // 平铺到折线左侧（那会盖住正文，回翻时整块白纸背就是这个来源）。
        if (u > uf) {
          const d = u - uf;
          nearCrease = Math.max(0, 1 - d / 10);
          phi = Math.min(PI, d / R);
          const uNew = uf - R + R * Math.cos(phi);
          const disp = uNew - u;
          outX = sx + cos * disp;
          outY = sy + sin * disp;
          z = R * Math.sin(phi);
        }

        const nx = -Math.sin(phi) * cos;
        const ny = -Math.sin(phi) * sin;
        const nz = Math.cos(phi);
        const dotF = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        const dotB = Math.max(0, -nx * LIGHT[0] - ny * LIGHT[1] - nz * LIGHT[2]);
        // 环境光占大头：纸是强漫反射材质，背光面也不该压成灰黑（DBL 实测 0.34 太暗）
        const brightF = clamp(0.52 + (0.48 * dotF) / FLAT_DOT, 0.42, 1.08);
        const brightB = clamp(0.56 + (0.44 * dotB) / FLAT_DOT, 0.46, 1.05);
        const ao = (1 - 0.1 * (phi / PI)) * (1 - 0.2 * nearCrease);

        data[o] = outX;
        data[o + 1] = outY;
        data[o + 2] = z;
        data[o + 3] = (sx - this.pad) / this.pageW;
        data[o + 4] = (sy - this.pad) / this.pageH;
        data[o + 5] = brightF;
        data[o + 6] = brightB;
        data[o + 7] = ao;
        o += VERTEX_STRIDE;
      }
    }

    const indices = new Uint16Array(cols * rows * 6);
    let k = 0;
    // 画序**从左到右**：先平展正面、后折边/纸背（纸背叠在正面之上）。
    // WebGL 有深度测试兜底；Canvas2D 没有，靠这个顺序保证折边压住正面。
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        const a = j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = c;
        indices[k++] = b;
        indices[k++] = d;
        indices[k++] = c;
      }
    }
    return { data, indices };
  }

  /**
   * Canvas2D 用的投影。
   *
   * 只在 x 方向做透视（卷边抬高时横向外扩，模拟离镜头更近）；y 向不外扩，
   * 这样卷边不会在页面上下留白里溢出，省掉一层全时段 clip（Chromium 慢合成路径）。
   */
  private project(x: number, y: number, z: number): { x: number; y: number } {
    const cx = this.pad + this.pageW / 2;
    const f = this.opts.focal;
    const s = f / (f - z);
    return { x: cx + (x - cx) * s, y };
  }

  /** 折线在页面中线处的屏幕 x（两种光栅器共用的折边基准） */
  private creaseX(): number {
    const cos = Math.cos(this.tilt);
    const sin = Math.sin(this.tilt);
    const cornerX = this.pad + this.pageW;
    const cornerY = this.pad + this.pageH;
    const uf = this.creaseOffset();
    const midY = this.pad + this.pageH / 2;
    return cornerX + (uf + (midY - cornerY) * sin) / cos;
  }

  private shadowParams(): { origin: { x: number; y: number }; dir: { x: number; y: number }; strength: number } {
    const cos = Math.cos(this.tilt);
    const sin = Math.sin(this.tilt);
    const strength = 0.36 * clamp(this.progress / 0.12, 0, 1) * (1 - 0.25 * this.progress);
    // 影子永远落在折线**右侧**（下一页），与翻页方向无关
    return { origin: { x: this.creaseX(), y: this.pad + this.pageH / 2 }, dir: { x: cos, y: sin }, strength };
  }

  // ------------------------------------------------------------------- render

  render(): void {
    if (this.disposed) return;
    const t0 = performance.now();
    if (this.renderer === 'webgl' && this.gl) this.renderGL();
    else this.render2D();
    this.lastDrawMs = performance.now() - t0;
  }

  private uploadTextures(): void {
    const gl = this.gl;
    if (!gl) return;
    const t0 = performance.now();
    const sources: (CurlTextureSource | null)[] = [this.textures.front, this.textures.back, this.textures.next];
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    for (let i = 0; i < 3; i += 1) {
      const src = sources[i];
      if (!src) continue;
      let tex = this.glTextures[i];
      if (!tex) {
        tex = gl.createTexture();
        this.glTextures[i] = tex;
      }
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    }
    this.texDirty = false;
    this.lastUploadMs = performance.now() - t0;
  }

  private renderGL(): void {
    const gl = this.gl;
    const prog = this.prog;
    if (!gl || !prog) return;
    if (this.texDirty) this.uploadTextures();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);

    const cx = this.pad + this.pageW / 2;
    const cy = this.pad + this.pageH / 2;
    gl.uniform2f(this.uniforms.u_center ?? null, cx, cy);
    gl.uniform2f(this.uniforms.u_css ?? null, this.cssW, this.cssH);
    gl.uniform1f(this.uniforms.u_focal ?? null, this.opts.focal);

    const sh = this.shadowParams();
    gl.uniform2f(this.uniforms.u_shadowOrigin ?? null, sh.origin.x, sh.origin.y);
    gl.uniform2f(this.uniforms.u_shadowDir ?? null, sh.dir.x, sh.dir.y);
    gl.uniform1f(this.uniforms.u_shadowStrength ?? null, sh.strength);

    // 后页底板：固定四边形，永远在纸面后面
    if (this.textures.next) {
      gl.uniform1f(this.uniforms.u_isSheet ?? null, 0);
      gl.uniform1f(this.uniforms.u_depth ?? null, 0.9);
      const base = new Float32Array([
        this.pad, this.pad, 0, 0, 0, 1, 1, 1,
        this.pad + this.pageW, this.pad, 0, 1, 0, 1, 1, 1,
        this.pad, this.pad + this.pageH, 0, 0, 1, 1, 1, 1,
        this.pad + this.pageW, this.pad + this.pageH, 0, 1, 1, 1, 1, 1,
      ]);
      const baseIdx = new Uint16Array([0, 1, 2, 2, 1, 3]);
      this.bindAttribs(prog, base);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, baseIdx, gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    // 卷曲纸面
    gl.uniform1f(this.uniforms.u_isSheet ?? null, 1);
    gl.uniform1f(this.uniforms.u_depth ?? null, 0);
    const mesh = this.buildMesh();
    this.bindAttribs(prog, mesh.data);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STREAM_DRAW);
    // 纸面裁剪在页面矩形内：折边抬高后透视会让它在上下/左缘溢出页面（落到留白里），
    // 这里用 scissor 直接切掉（GPU 上等于一次矩形裁剪，没有额外开销）。
    const dpr = this.dpr;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.round(this.pad * dpr),
      Math.round((this.cssH - this.pad - this.pageH) * dpr),
      Math.round(this.pageW * dpr),
      Math.round(this.pageH * dpr),
    );
    gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.SCISSOR_TEST);
  }

  private bindAttribs(prog: WebGLProgram, data: Float32Array): void {
    const gl = this.gl;
    if (!gl) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    const stride = VERTEX_STRIDE * 4;
    const en = (name: string, size: number, offset: number): void => {
      const loc = this.attribs[name] ?? -1;
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
    };
    en('pos', 2, 0);
    en('z', 1, 2);
    en('uv', 2, 3);
    en('light', 2, 5);
    en('ao', 1, 7);
  }

  private render2D(): void {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    if (this.textures.next) {
      ctx.drawImage(this.textures.next, this.pad, this.pad, this.pageW, this.pageH);
    } else {
      ctx.fillStyle = '#f7f4ec';
      ctx.fillRect(this.pad, this.pad, this.pageW, this.pageH);
    }

    const sh = this.shadowParams();
    if (sh.strength > 0) {
      const g = ctx.createLinearGradient(
        sh.origin.x,
        sh.origin.y,
        sh.origin.x + sh.dir.x * 140,
        sh.origin.y + sh.dir.y * 140,
      );
      g.addColorStop(0, `rgba(0,0,0,${sh.strength.toFixed(3)})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(this.pad, this.pad, this.pageW, this.pageH);
    }

    // 纸面先画到离屏画布，再用**一整块渐变**以 multiply 压暗，最后合成回主画布。
    // 为什么不在每个三角形上 tint：逐格填充必然在格边留下色块（20×10 都看得出来）；
    // 离屏画布的透明区域在 multiply 下不受影响，所以渐变可以铺满整张离屏而不弄脏下一页。
    const sheet = this.sheetCtx();
    if (!sheet) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    sheet.setTransform(1, 0, 0, 1, 0, 0);
    sheet.clearRect(0, 0, this.canvas.width, this.canvas.height);
    sheet.setTransform(dpr, 0, 0, dpr, 0, 0);

    const mesh = this.buildMesh();
    const [cols, rows] = this.meshGrid();
    const stride = VERTEX_STRIDE;

    // 固定从左到右画：平展正面先落、折边/纸背后落（Canvas2D 没有深度测试）
    for (let i = 0; i < cols; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        const a = (j * (cols + 1) + i) * stride;
        const b = (j * (cols + 1) + i + 1) * stride;
        const c = ((j + 1) * (cols + 1) + i) * stride;
        const d = ((j + 1) * (cols + 1) + i + 1) * stride;
        this.drawCell2D(sheet, mesh.data, a, b, c, d);
      }
    }

    this.shadeSheet(sheet, sh);
    sheet.setTransform(1, 0, 0, 1, 0, 0);
    // 与 WebGL 同一口径：纸面只保留页面矩形内的部分（见 renderGL 的 scissor）。
    // 折边宽 2R，只有折线扫到离左缘不足 2R（回翻是离右缘不足 2R）时才会溢出页面；
    // 其余时刻不加 clip，否则 Chromium 会切到较慢的合成路径
    // （实测 Canvas2D 20×10 单帧 5.6 → 11.7ms）。
    const R = this.opts.radiusRatio * this.pageW;
    const overflow = this.tilt !== 0 || this.creaseX() - 2 * R - 24 < this.pad;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (overflow) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        Math.round(dpr * this.pad),
        Math.round(dpr * this.pad),
        Math.round(dpr * this.pageW),
        Math.round(dpr * this.pageH),
      );
      ctx.clip();
      ctx.drawImage(this.sheetCanvas!, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(this.sheetCanvas!, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private sheetCtx(): CanvasRenderingContext2D | null {
    if (!this.sheetCanvas) {
      this.sheetCanvas = document.createElement('canvas');
      this.sheetCtx2d = this.sheetCanvas.getContext('2d', { alpha: true });
    }
    if (this.sheetCanvas.width !== this.canvas.width || this.sheetCanvas.height !== this.canvas.height) {
      this.sheetCanvas.width = this.canvas.width;
      this.sheetCanvas.height = this.canvas.height;
    }
    return this.sheetCtx2d;
  }

  /**
   * 卷曲面受光：沿 `u`（垂直于折线、指向卷起方向）铺一条渐变。
   * 折线处最暗（背光），弧顶回落，更远（已经落平的部分）不再压暗。
   */
  private shadeSheet(
    sheet: CanvasRenderingContext2D,
    sh: { origin: { x: number; y: number }; dir: { x: number; y: number }; strength: number },
  ): void {
    if (this.progress < 0.02 || sh.strength <= 0) return;
    const R = this.opts.radiusRatio * this.pageW;
    // 只压折边附近：折线处最深，往外 ~1.5R 就收干净。纸背本身是浅色纸，
    // 压太宽会变成一条灰板（用户看到的「灰色卷轴」，不是「纸背」）。
    const lead = R * 1.5;
    const span = R * 2.6;
    const L = lead + span;
    const sx = sh.origin.x - sh.dir.x * lead;
    const sy = sh.origin.y - sh.dir.y * lead;
    const g = sheet.createLinearGradient(sx, sy, sx + sh.dir.x * L, sy + sh.dir.y * L);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(lead / L, 'rgba(0,0,0,0.30)');
    g.addColorStop(Math.min(1, (lead + span * 0.55) / L), 'rgba(0,0,0,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    const prev = sheet.globalCompositeOperation;
    sheet.globalCompositeOperation = 'multiply';
    sheet.fillStyle = g;
    sheet.fillRect(0, 0, this.cssW, this.cssH);
    sheet.globalCompositeOperation = prev;
  }

  private drawCell2D(
    ctx: CanvasRenderingContext2D,
    data: Float32Array,
    a: number,
    b: number,
    c: number,
    d: number,
  ): void {
    const p00 = this.project(data[a], data[a + 1], data[a + 2]);
    const p10 = this.project(data[b], data[b + 1], data[b + 2]);
    const p01 = this.project(data[c], data[c + 1], data[c + 2]);
    const p11 = this.project(data[d], data[d + 1], data[d + 2]);
    const area =
      (p10.x - p00.x) * (p01.y - p00.y) - (p10.y - p00.y) * (p01.x - p00.x);
    // 屏幕绕序（y 向下）为正 = 平展的正面；卷过半圆柱后绕序反过来 = 纸背
    const front = area > 0;
    const tex = front ? this.textures.front : this.textures.back;
    if (!tex) return;

    const w = this.textureWidth(tex);
    const h = this.textureHeight(tex);
    const u0 = data[a + 3];
    const u1 = data[b + 3];
    const v0 = data[a + 4];
    const v1 = data[c + 4];
    const y0 = Math.min(v0, v1) * h;
    const y1 = Math.max(v0, v1) * h;

    // 背面纹理要水平镜像（翻过来的纸背对读者是正的）
    const mapX = front
      ? (u: number): number => u * w
      : (u: number): number => (1 - u) * w;
    const s00 = mapX(u0);
    const s10 = mapX(u1);

    this.drawTriangle2D(
      ctx,
      tex,
      { x: s00, y: y0 },
      { x: s10, y: y0 },
      { x: s00, y: y1 },
      p00,
      p10,
      p01,
    );
    this.drawTriangle2D(
      ctx,
      tex,
      { x: s10, y: y0 },
      { x: s10, y: y1 },
      { x: s00, y: y1 },
      p10,
      p11,
      p01,
    );
  }

  private drawTriangle2D(
    ctx: CanvasRenderingContext2D,
    tex: CurlTextureSource,
    s0: { x: number; y: number },
    s1: { x: number; y: number },
    s2: { x: number; y: number },
    d0: { x: number; y: number },
    d1: { x: number; y: number },
    d2: { x: number; y: number },
  ): void {
    const den =
      s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(den) < 0.001) return;
    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / den;
    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / den;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / den;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / den;
    const e = d0.x - a * s0.x - c * s0.y;
    const f = d0.y - b * s0.x - d * s0.y;

    const w = this.textureWidth(tex);
    const h = this.textureHeight(tex);
    const bx = Math.max(0, Math.floor(Math.min(s0.x, s1.x, s2.x)) - 1);
    const by = Math.max(0, Math.floor(Math.min(s0.y, s1.y, s2.y)) - 1);
    const bw = Math.min(w - bx, Math.ceil(Math.max(s0.x, s1.x, s2.x)) - bx + 1);
    const bh = Math.min(h - by, Math.ceil(Math.max(s0.y, s1.y, s2.y)) - by + 1);
    if (bw < 1 || bh < 1) return;

    const dpr = this.dpr;
    // 每个三角形都向外胀 0.8px：Canvas2D 的 clip 抗锯齿会在相邻三角形之间
    // 留下 1px 级的亮缝（WebGL 走 GPU 光栅化没有这个问题），胀开后互相压住就看不出来。
    const cx = (d0.x + d1.x + d2.x) / 3;
    const cy = (d0.y + d1.y + d2.y) / 3;
    const q0 = expand(d0, cx, cy, CLIP_GROW);
    const q1 = expand(d1, cx, cy, CLIP_GROW);
    const q2 = expand(d2, cx, cy, CLIP_GROW);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(q0.x, q0.y);
    ctx.lineTo(q1.x, q1.y);
    ctx.lineTo(q2.x, q2.y);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
    // 变换把「纹理像素坐标」映射到屏幕，所以目标矩形也用纹理坐标
    ctx.drawImage(tex, bx, by, bw, bh, bx, by, bw, bh);
    ctx.restore();
  }

  private textureWidth(tex: CurlTextureSource): number {
    return 'width' in tex ? tex.width : 0;
  }

  private textureHeight(tex: CurlTextureSource): number {
    return 'height' in tex ? tex.height : 0;
  }
}

export default PageCurlEngine;
