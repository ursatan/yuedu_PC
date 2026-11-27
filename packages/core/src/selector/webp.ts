/**
 * webp 解码（**同步**、纯 wasm、零外部文件依赖）。
 *
 * ## 为什么需要
 * 🎨🔞禁漫天堂这类源在 `ruleContent.content` 的 `imageDecode` 脚本里做「切条还原」：
 * ```
 * var img = BitmapFactory.decodeByteArray(result, 0, result.length);   // ← 同步调用
 * var mac = src.match(/photos\/(\d+)?\/(\d+)?/);   // 按 jm 号算切片数
 * …位图重排…
 * ```
 * 而站点现在的正文图是 **webp（有损 VP8）** —— `BitmapFactory` 原本只实现 JPEG/PNG，
 * 于是抛 `不支持的图片格式「webp」` ⇒ 回退原图 ⇒ 用户看到「图片还是切条的，没有解密」。
 * 实测直连与经代理**字节 sha1 完全一致**（216924 字节），即确实是「原样回退」。
 *
 * ## 为什么是「内联 wasm + 自写胶水」而不是 require 一个包
 * 上游 `@cwasm/webp@0.1.5`（LinusU/cwasm-webp，MIT，libwebp 编译产物）**是同步 API**，
 * 但它的胶水在**模块顶层**做 `fs.readFileSync(path.join(__dirname, 'webp.wasm'))` ——
 * 本仓服务端用 esbuild 打成 **ESM 单文件**，ESM 里**没有 `__dirname`** ⇒ 顶层抛 ReferenceError
 * ⇒ **整个服务端起不来**。所以把那份 95,255 字节的 wasm 内联成源码常量（`webp-wasm.ts`），
 * 这里用 `WebAssembly.Module` / `Instance` **同步**实例化。
 *
 * ## 调用契约（照抄上游，已核对源码）
 * `WebPDecodeRGBA(dataPtr, dataSize, wPtr, hPtr) -> outPtr`；width/height 是 u32，
 * 写在 `wPtr`/`hPtr`（两个相邻 u32 = 8 字节 metadata）。返回 0 表示失败。
 */
import { WEBP_WASM_BASE64 } from './webp-wasm';

export interface DecodedWebp {
  width: number;
  height: number;
  /** RGBA 像素（长度 = width × height × 4） */
  data: Uint8Array;
}

/** libwebp 的 wasi 导入桩（与上游一致：这三个 syscall 在本用例中不会被调用） */
const WASI_STUBS = {
  fd_close() {
    throw new Error('Syscall fd_close not implemented');
  },
  fd_seek() {
    throw new Error('Syscall fd_seek not implemented');
  },
  fd_write() {
    throw new Error('Syscall fd_write not implemented');
  },
};

interface WebpExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  WebPDecodeRGBA(dataPtr: number, dataSize: number, wPtr: number, hPtr: number): number;
}

/** 单次实例化后复用（wasm 实例无状态，`malloc/free` 成对使用即可） */
let exportsCache: WebpExports | null = null;

/** base64 → 字节：Node 走 Buffer，浏览器/worker 走 atob（两边都可用） */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bufCtor = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  // 统一**拷贝**到由普通 ArrayBuffer 支撑的视图：Node 的 Buffer 常是 pool 切片，
  // 其 `buffer` 类型是 `ArrayBufferLike`，直接交给 `WebAssembly.Module` 会被 TS 拒。
  if (bufCtor?.from) {
    const fromBuf = bufCtor.from(b64, 'base64');
    const copy = new Uint8Array(fromBuf.byteLength);
    copy.set(fromBuf);
    return copy;
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function webpExports(): WebpExports {
  if (exportsCache) return exportsCache;
  const module_ = new WebAssembly.Module(base64ToBytes(WEBP_WASM_BASE64));
  const instance = new WebAssembly.Instance(module_, { wasi_snapshot_preview1: WASI_STUBS });
  exportsCache = instance.exports as unknown as WebpExports;
  return exportsCache;
}

/**
 * 解码 webp（**同步**，任意位深/有损 VP8 / 无损 VP8L 都走 libwebp 同一入口）。
 * @throws 当数据不是合法 webp 或 libwebp 返回空指针时
 */
export function decodeWebp(input: Uint8Array): DecodedWebp {
  const ex = webpExports();
  const inputPtr = ex.malloc(input.byteLength);
  try {
    new Uint8Array(ex.memory.buffer, inputPtr, input.byteLength).set(input);
    const metaPtr = ex.malloc(8);
    try {
      const outPtr = ex.WebPDecodeRGBA(inputPtr, input.byteLength, metaPtr, metaPtr + 4);
      if (outPtr === 0) throw new Error('webp 解码失败（libwebp 返回空指针）');
      try {
        const meta = new Uint32Array(ex.memory.buffer, metaPtr, 2);
        const width = meta[0] ?? 0;
        const height = meta[1] ?? 0;
        if (!width || !height) throw new Error(`webp 解码失败（尺寸为 ${width}x${height}）`);
        // ⚠️ 必须**拷贝**出来（`.slice()`）：wasm 线性内存会被后续 malloc 复用/移动
        const data = new Uint8Array(ex.memory.buffer, outPtr, width * height * 4).slice();
        return { width, height, data };
      } finally {
        ex.free(outPtr);
      }
    } finally {
      ex.free(metaPtr);
    }
  } finally {
    ex.free(inputPtr);
  }
}
