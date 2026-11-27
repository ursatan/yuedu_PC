import { createDecipheriv } from 'node:crypto';

/**
 * 图片二次解密的 `result` 绑定 —— **照抄上游 `ImageUtils.decode` 的双形态语义**。
 *
 * ## 为什么必须有两种形态（读源码得出，不是猜）
 * 上游 `OkHttpStreamFetcher.kt:129-146` 对同一个 `ImageUtils.decode` 传了**两种类型**：
 * ```kotlin
 * if (manga) {
 *     ImageUtils.decode(url, responseBody.bytes(),      isCover = false, source, ReadManga.book)  // ← ByteArray
 * } else {
 *     ImageUtils.decode(analyzedUrl, responseBody.byteStream(), isCover = true, source)           // ← InputStream
 * }
 * ```
 * · **正文图（`imageDecode`）** → `ByteArray` ⇒ 源脚本用**下标**：`result[0] === 0xFF && result[1] === 0xD8`；
 * · **封面（`coverDecodeJs`）** → `InputStream` ⇒ 源脚本用**流方法**：`result.readAllBytes()`。
 *
 * 本仓此前两条路都只给 `Uint8Array`。下标用法照样能跑（于是「正文图解密」一直正常、
 * 没有暴露这个缺口），而**封面**那类源调用 `result.readAllBytes()` 直接
 * `TypeError: result.readAllBytes is not a function` ⇒ 解密失败 ⇒ 回传**未解密的乱码字节** ⇒
 * 浏览器 `@error` ⇒ 卡片显示默认封面（用户 2026-10-01 实测：🥝猕猴桃漫画 49 项封面全空）。
 * ⚠️ 症状是「站点图片没打乱」与「我们没解密」**完全不可分辨**，所以必须按上游把类型补齐。
 *
 * ## 语料实证（`data/sources/book-482` + `data/imported-sources.json`，2026-10-01 统计）
 * `coverDecodeJs` 共 3 个源，**2 个**用 `readAllBytes`（🥝猕猴桃漫画 / 漫蛙，两者脚本逐字相同）；
 * 剩下 1 个（🎨51漫画）把 `result` 转进自己函数的形参再 `decrypt(src)`。
 * ⇒ `readAllBytes` 缺失不是「一个源的问题」，是**一整类封面解密写法在本仓不可用**。
 *
 * ## 做法：**不改变 `Uint8Array` 本体**，只挂非枚举的流方法
 * 直接返回 Proxy 或包装对象会破坏 `result[0]`（下标写法仍要能用）与
 * 结构化克隆（worker 池那条路要把它当普通字节传过去），所以走「同一个数组 + 挂方法」：
 * · 下标 / `.length` / `slice()` / `decrypt()` 全部照旧；
 * · 新增 `readAllBytes()` / `available()` / `readBytes()` / `close()`（上游 `InputStream` 用得到的那几个）；
 * · 方法一律 **非枚举** —— 不引入新的可枚举属性（`Uint8Array` 自带的 `'0'..'n'` 索引改前就有）。
 *
 * ⚠️ **`#759` 之后这条路径可以进 worker**：宿主不再把「挂了方法的 Uint8Array」当绑定下发
 * （结构化克隆会丢方法），而是下发 {@link IMAGE_BYTES_KEY} 描述符里的**裸字节**，
 * worker 用同一份 {@link IMAGE_BYTES_SOURCE} 重建方法面。L1 侧仍由
 * {@link materializeImageBindings} 就地还原成带方法的数组 ⇒ 两种路由语义一致。
 *
 * @param bytes 图片原始字节
 * @returns 同一个 `Uint8Array`，额外带 `InputStream` 方法（幂等：重复调用不会重复挂）
 */
export function asImageStreamResult(bytes: Uint8Array): Uint8Array {
  const b = bytes as Uint8Array & {
    readAllBytes?: () => Uint8Array;
    available?: () => number;
    readBytes?: (n: number) => Uint8Array;
    close?: () => void;
  };
  if (typeof b.readAllBytes === 'function') return b;
  /**
   * ⚠️ `readAllBytes()` 上游返回的是**新数组**（Java `InputStream.readAllBytes` 语义：
   * 读掉流的内容并返回副本）。返回副本而不是 `this`，是为了让源脚本里
   * `const view = result.readAllBytes(); const iv = view.slice(0, 16)` 这种
   * 「拿副本再切片」写法与上游一致（若返回 `this`，`view` 与 `result` 同源，
   * 某些源对 `view` 做 `reverse()` 之类原地操作时会连`result` 一起改掉）。
   */
  const def = (name: string, fn: (...args: unknown[]) => unknown): void => {
    Object.defineProperty(b, name, { value: fn, enumerable: false, writable: false, configurable: true });
  };
  def('readAllBytes', () => b.slice());
  /** Java `InputStream.available()` = 「不阻塞就能读到的字节数」，对内存字节恒为全长 */
  def('available', () => b.length);
  /** `readBytes(n)`（Android `InputStream` 扩展）= 取前 n 字节 */
  def('readBytes', (n?: unknown) => b.slice(0, Math.max(0, Number(n) || 0)));
  /** 内存字节没有「关闭」，给个空实现让 `try/finally` 结构的源脚本能跑完 */
  def('close', () => undefined);
  /**
   * `#452` **补齐 `InputStream` 的游标方法**（用户口径：「图片解密的规则方面，我们要兼容 legado 写法」）。
   * 语料里常见的 Legado 写法是「按字节读」：
   * `var b=[];for(var x=result.read();x!==-1;x=result.read())b.push(x&255);`
   * —— 没有 `read()/skip()/readNBytes()` 时这类脚本直接 TypeError（症状与「站点图片本来就没加密」无法分辨）。
   *
   * ⚠️ **与上游的一处已知差异**（刻意保留）：`readAllBytes()` 依然**非破坏性**——语料实证源常写
   * `var view=result.readAllBytes(); …view.slice(0,16)…` 之后**还要用 result**；故这里的 `read()`
   * 走**独立游标**，不与 `readAllBytes()` 共享读写位置。
   */
  let cursor = 0;
  /**
   * `#690` **`read()` 的两种重载都要支持**（Java `InputStream.read(byte[])`）。
   *
   * 用户实测 黄果短剧🔞 的 `coverDecodeJs` 就是标准 Java 写法：
   * ```js
   * var baos = new Packages.java.io.ByteArrayOutputStream();
   * var buf  = new Packages.java.lang.String('0'.repeat(32)).getBytes();
   * var n = result.read(buf);
   * while (n > 0) { baos.write(buf, 0, n); n = result.read(buf); }
   * ```
   * 旧实现只有一个无参 `read()`（返回**一个字节**）：`read(buf)` 传参被忽略 ⇒ `n` 是字节值（9 之类），
   * 随后 `write(buf,0,n)` 把这 9 个字节写进去 ⇒ 拼出来的「密文」是垃圾 ⇒ 解密后魔数不对 ⇒
   * 规则返回**原始字节** ⇒ 浏览器裂图。症状与「站点没加密」完全不可分辨。
   */
  def('read', (...args: unknown[]) => {
    if (!args.length) return cursor < b.length ? b[cursor++] : -1;
    const buf = args[0];
    const target = buf as { length?: number; set?: unknown };
    if (!target || typeof target !== 'object' || typeof target.length !== 'number') {
      return cursor < b.length ? b[cursor++] : -1;
    }
    const off = Math.max(0, Number(args[1] ?? 0) || 0);
    const len = Math.max(0, Math.min(Number(args[2] ?? target.length - off) || 0, target.length - off));
    const avail = Math.max(0, Math.min(len, b.length - cursor));
    if (avail === 0) return -1;
    const chunk = b.subarray(cursor, cursor + avail);
    if (target instanceof Uint8Array) target.set(chunk, off);
    else if (Array.isArray(buf)) for (let i = 0; i < avail; i++) (buf as number[])[off + i] = chunk[i] as number;
    else {
      const t = buf as Record<number, number>;
      for (let i = 0; i < avail; i++) t[off + i] = chunk[i] as number;
    }
    cursor += avail;
    return avail;
  });
  def('skip', (n?: unknown) => {
    const want = Math.max(0, Number(n) || 0);
    const moved = Math.min(want, b.length - cursor);
    cursor += moved;
    return moved;
  });
  def('readNBytes', (n?: unknown) => {
    const want = Math.max(0, Number(n) || 0);
    const out = b.slice(cursor, cursor + want);
    cursor += out.length;
    return out;
  });
  return b;
}

/**
 * `#759` 图片解密绑定描述符：宿主把**裸字节**放进这个键下发。
 *
 * 为什么不直接下发 `asImageStreamResult()` 的结果：结构化克隆对 TypedArray 只复制元素，
 * 挂在数组上的 `readAllBytes()` 等方法会**静默丢失** ⇒ worker 里脚本立刻 TypeError。
 * 描述符里的字节是普通 TypedArray（structuredClone 支持），worker 侧用
 * {@link IMAGE_BYTES_SOURCE} 重建同一套方法。
 */
export const IMAGE_BYTES_KEY = '__yueduImageBytes';

export interface ImageBytesResult {
  readonly [IMAGE_BYTES_KEY]: Uint8Array;
}

/** 构造 `AnalyzeRule.runJs` 的 extra bindings（`result` + `src`，对齐 Legado `ImageUtils.decode`） */
export function imageDecodeBindings(
  bytes: Uint8Array,
  url: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { result: { [IMAGE_BYTES_KEY]: bytes } as ImageBytesResult, src: url, ...extra };
}

// ──────────────────────────────────────────────────────────────────────────────
// `D2` **标准参数 `decode{}`** —— 对象/JSON 形式的图片解密
//
// 语料里的解密脚本大多只是「自己拼 key/iv，再 AES-CBC」；这类脚本写成字符串既难维护，
// 也无法把 **key** 留在服务端（前端拿到 `imageDecode: true` 就够）。标准参数把可声明的部分
// 抽出来：
// ```json
// { "js": "java.getString('img_key')", "ivPrefixBytes": 16, "keyEncoding": "base64" }
// ```
// 语义：`js` 求值得到 **key**（字符串或字节）；图片前 `ivPrefixBytes` 字节是 IV；
// 剩余字节是 AES-CBC 密文。**解密在服务端 `node:crypto` 完成，key 不下发前端**。
// ──────────────────────────────────────────────────────────────────────────────

/** key 的文本编码（`utf8` 是兼容旧写法的默认值） */
export type ImageKeyEncoding = 'base64' | 'hex' | 'utf8';

/** `decode{}` 标准参数（对象形式，也接受等价的 JSON 字符串） */
export interface ImageDecodeSpec {
  /** 返回 key 的 JS（旧语义下也可以是完整解密脚本） */
  js: string;
  /** 图片前缀多少字节当 IV（不传 = 旧语义：JS 自己解密并返回字节） */
  ivPrefixBytes?: number;
  /** `js` 返回的 key 文本如何解码为字节（默认 `utf8`） */
  keyEncoding?: ImageKeyEncoding;
}

const KEY_ENCODINGS: readonly ImageKeyEncoding[] = ['base64', 'hex', 'utf8'];

function normalizeSpec(raw: Record<string, unknown>): ImageDecodeSpec | null {
  const js = typeof raw['js'] === 'string' ? raw['js'].trim() : '';
  if (!js || js === 'null') return null;
  const out: ImageDecodeSpec = { js };
  const iv = Number(raw['ivPrefixBytes']);
  if (Number.isFinite(iv) && iv > 0) out.ivPrefixBytes = Math.floor(iv);
  const enc = raw['keyEncoding'];
  if (typeof enc === 'string' && (KEY_ENCODINGS as readonly string[]).includes(enc)) {
    out.keyEncoding = enc as ImageKeyEncoding;
  }
  return out;
}

/**
 * 解析 `imageDecode` / `coverDecodeJs`：
 * · 普通字符串 ⇒ `{ js }`（旧写法完全不变）；
 * · 对象或 JSON 字符串 `{js, ivPrefixBytes, keyEncoding}` ⇒ 标准参数。
 *
 * ⚠️ 只把**能 parse 成对象且 `js` 是字符串**的 `{…}` 当 JSON：脚本本身也可能以 `{` 开头
 * （块语句 / 对象字面量），不能见 `{` 就 `JSON.parse` 后失败当错。
 */
export function parseImageDecodeSpec(raw: unknown): ImageDecodeSpec | null {
  if (raw && typeof raw === 'object' && !(raw instanceof Uint8Array) && !Array.isArray(raw)) {
    return normalizeSpec(raw as Record<string, unknown>);
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text === 'null') return null;
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const spec = normalizeSpec(obj as Record<string, unknown>);
        if (spec) return spec;
      }
    } catch {
      /* 不是 JSON ⇒ 当作普通 JS 脚本文本 */
    }
  }
  return { js: text };
}

/**
 * key 文本 → 字节。`keyEncoding` 只支持 base64 / hex / utf8（默认 utf8，兼容旧写法）。
 * `Uint8Array` / 数字数组直接当字节用。
 */
export function decodeImageKeyBytes(
  key: string | Uint8Array | number[],
  encoding: ImageKeyEncoding = 'utf8',
): Uint8Array {
  if (key instanceof Uint8Array) return key;
  if (Array.isArray(key)) return Uint8Array.from(key);
  const text = String(key ?? '');
  if (encoding === 'base64') return new Uint8Array(Buffer.from(text, 'base64'));
  if (encoding === 'hex') return new Uint8Array(Buffer.from(text, 'hex'));
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** 按 `ivPrefixBytes` 切出 IV 与密文（前缀不足/超长一律夹到合法区间） */
export function splitImageCipherBytes(
  bytes: Uint8Array,
  ivPrefixBytes: number,
): { iv: Uint8Array; ciphertext: Uint8Array } {
  const n = Math.max(0, Math.min(bytes.length, Math.floor(ivPrefixBytes) || 0));
  return { iv: bytes.subarray(0, n), ciphertext: bytes.subarray(n) };
}

/** AES-CBC 解密（服务端 `node:crypto`；默认 PKCS7 自动去填充） */
export function aesCbcDecryptBytes(input: {
  key: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  padding?: boolean;
}): Uint8Array {
  const { key, iv, ciphertext } = input;
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new Error(`AES key 长度非法（${key.length} 字节，需 16/24/32）`);
  }
  if (iv.length !== 16) throw new Error(`AES-CBC IV 长度非法（${iv.length} 字节，需 16）`);
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  decipher.setAutoPadding(input.padding !== false);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/**
 * 标准参数解密：`keyMaterial` 是 JS 求值出的 key（字符串/字节），
 * `spec.ivPrefixBytes` 指定图片前缀做 IV，其余为密文。
 */
export function decryptImageWithSpec(
  bytes: Uint8Array,
  spec: ImageDecodeSpec,
  keyMaterial: string | Uint8Array | number[],
): Uint8Array {
  if (!spec.ivPrefixBytes) throw new Error('decode{} 缺少 ivPrefixBytes');
  const key = decodeImageKeyBytes(keyMaterial, spec.keyEncoding ?? 'utf8');
  const { iv, ciphertext } = splitImageCipherBytes(bytes, spec.ivPrefixBytes);
  return aesCbcDecryptBytes({ key, iv, ciphertext });
}

/** 判定 `result` 是否是 {@link imageDecodeBindings} 下发的描述符 */
export function isImageBytesResult(v: unknown): v is ImageBytesResult {
  if (!v || typeof v !== 'object') return false;
  return (v as Record<string, unknown>)[IMAGE_BYTES_KEY] instanceof Uint8Array;
}

/** L1 侧还原：把描述符换回「同一个数组 + InputStream 方法」（未命中则原样返回） */
export function materializeImageBindings(bindings: Record<string, unknown>): Record<string, unknown> {
  const r = bindings?.['result'];
  if (!isImageBytesResult(r)) return bindings;
  return { ...bindings, result: asImageStreamResult(r[IMAGE_BYTES_KEY]) };
}

/**
 * `#759` worker 侧的字节→流重建函数源码（注入 `sandbox/worker-pool.ts` 的 `WORKER_SRC`）。
 *
 * ⚠️ **不能用 `String(asImageStreamResult)`**：构建链（tsx / esbuild keepNames）会往函数体里
 * 注入 `__name(...)` 辅助调用，worker 加载期直接 `__name is not defined`（实测踩过）。
 * 所以这里手写一份 ES5 等价的源码，并用 `image-decode-worker-759.test.ts` 逐方法对拍。
 *
 * 语义必须与上面的 `asImageStreamResult` **逐字一致**（改一边必须改另一边）：
 * 同一个 `Uint8Array` + 非枚举的 `readAllBytes/available/readBytes/close/read/skip/readNBytes`，
 * 独立游标，`read(buf[,off,len])` 支持 Uint8Array / Array / 下标对象三种目标。
 */
export const IMAGE_BYTES_SOURCE = String.raw`
const __yueduImageStream = function (bytes) {
  var b = bytes;
  if (typeof b.readAllBytes === 'function') return b;
  var def = function (name, fn) {
    Object.defineProperty(b, name, { value: fn, enumerable: false, writable: false, configurable: true });
  };
  def('readAllBytes', function () { return b.slice(); });
  def('available', function () { return b.length; });
  def('readBytes', function (n) { return b.slice(0, Math.max(0, Number(n) || 0)); });
  def('close', function () { return undefined; });
  var cursor = 0;
  def('read', function () {
    var args = arguments;
    if (!args.length) return cursor < b.length ? b[cursor++] : -1;
    var buf = args[0];
    if (!buf || typeof buf !== 'object' || typeof buf.length !== 'number') {
      return cursor < b.length ? b[cursor++] : -1;
    }
    var off = Math.max(0, Number(args[1] === undefined || args[1] === null ? 0 : args[1]) || 0);
    var want = args[2] === undefined || args[2] === null ? buf.length - off : args[2];
    var len = Math.max(0, Math.min(Number(want) || 0, buf.length - off));
    var avail = Math.max(0, Math.min(len, b.length - cursor));
    if (avail === 0) return -1;
    var chunk = b.subarray(cursor, cursor + avail);
    if (buf instanceof Uint8Array) buf.set(chunk, off);
    else if (Array.isArray(buf)) { for (var i = 0; i < avail; i++) buf[off + i] = chunk[i]; }
    else { for (var j = 0; j < avail; j++) buf[off + j] = chunk[j]; }
    cursor += avail;
    return avail;
  });
  def('skip', function (n) {
    var want = Math.max(0, Number(n) || 0);
    var moved = Math.min(want, b.length - cursor);
    cursor += moved;
    return moved;
  });
  def('readNBytes', function (n) {
    var want = Math.max(0, Number(n) || 0);
    var out = b.slice(cursor, cursor + want);
    cursor += out.length;
    return out;
  });
  return b;
};
`;

/**
 * worker 里是否**不适合**跑图片解密脚本（`#759`）。
 *
 * worker 的 vm realm **不注入 `Buffer` / `process` / `require` / `module`**（`#624` 起刻意隔离）。
 * 源脚本只要引用这些名字就留在 L1：宁可不省这一次主线程阻塞，也不能把「能解密」变成
 * `Buffer is not defined` ⇒ 回传密文（症状与「站点没加密」不可分辨）。
 *
 * 其余能力（`Packages.javax.crypto`、`android.graphics`、`java.ajax`、`CryptoJS`）由
 * `js.ts` 的既有路由判据决定：能在 worker 的进 worker，判不了的自动回落 L1。
 */
const IMAGE_WORKER_UNSAFE_RE = /\bBuffer\b|\bprocess\b|\brequire\s*\(|\bmodule\b|\bglobalThis\b/;

/**
 * 默认 **auto**：大图（≥1MB）或「该解密函数在 L1 实测慢过（≥80ms）」才下移 worker。
 *
 * 为什么不是无条件 on：实测 51 漫画 40 张真实封面（平均 144KB）L1 解密 P95=30ms，
 * 无条件下移反而把单张墙钟从 13ms 抬到 42ms（结构化克隆 + 线程往返），解密总时长
 * 0.53s→1.68s（洪峰仍由网络主导，但纯属白花）。而用户日志里的 `m=3268ms` 属于
 * 「大图 / 重循环」——按「体积 + 实测慢」两条判据命中，普通源零开销。
 *
 * `#782`：冷规则的**第一张**改成「先在 worker 探测一次」——旧行为必须让主线程跑完
 * 才能量出 ≥80ms，慢函数（3s 级）因此每进程首图都冻一次事件循环。现在探测样本改为
 * worker 往返墙钟，主线程零阻塞；探测到便宜（<80ms）就记 `fast`，后续小图回 L1。
 *
 * 开关：
 * · 未设置 / `auto` ⇒ 自动；
 * · `1` / `on` ⇒ 强制下移（除脚本碰 worker 隔离全局）；
 * · `0` / `off` ⇒ 强制旧行为（全部 L1）。
 */
export function imageDecodeWorkerMode(): 'auto' | 'on' | 'off' {
  const v = process.env['YUEDU_IMAGE_DECODE_WORKER'];
  if (v === '0' || v === 'off') return 'off';
  if (v === '1' || v === 'on') return 'on';
  return 'auto';
}

/** 兼容旧判据：开关是否允许使用 worker（不看单图成本） */
export function imageDecodeWorkerEnabled(): boolean {
  return imageDecodeWorkerMode() !== 'off';
}

/**
 * 大图阈值：**1MB**（`#759`，轮次 797 实测标定，2026-11-06）。
 *
 * 判据是「L1 这一次同步解码要占主线程多久」，取 {@link IMAGE_WORKER_SLOW_MS}（80ms）为界：
 * · 空载交叉点：逐字节变换 ≈**2.2MB**、纯 base64 ≈**3.5MB** 才到 80ms —— 这是**上界**，
 *   空载机器上 1MB 并不吃亏（L1 19.1ms / 32.9ms），但机器不会一直空载；
 * · 有负载下包络：降到 **≈1.0~1.2MB**（1MB 逐字节变换 **L1 首样本 82.9ms**，
 *   base64 512KB 23.0ms / 1MB 59.6ms）⇒ 取 **1MB** 作为「最坏负载下也会撞线」的包络。
 *
 * 口径（别把这条阈值当成「worker 更快」的门槛）：worker 的墙钟**恒慢**
 * （纯计算 L1 + 1~11ms 的结构化克隆 + 排队往返 ⇒ 单张只慢不快），它**只买「主线程不阻塞」**。
 * 所以这里按「主线程被同步占住多久才值得付跨线程开销」定价，不按体积拍脑袋：
 * 小图（51 漫画 40 张真实封面平均 144KB、P95 解密 30ms）留 L1，大图才下移。
 *
 * ⚠️ **标定样本必须包进 IIFE**：L1 求值的外层是 `with(scope)`，**顶层**代码里每次变量
 * 读写都走 Proxy（实测顶层 `for` 100k 次 **2,150ms**，同一循环放进函数体 **10.7ms**，
 * 差 ~200 倍）；直接拿顶层写法计时会把「编译/代理开销」当解密成本，阈值会算成全错。
 * 真实源规则都是「定义函数再调用」（如 51漫画 `decryptCover(src){…}`），IIFE/函数
 * 才是同一口径 —— `tmp/bench-796.ts` 的样本即按此写法。
 */
const IMAGE_WORKER_SIZE_THRESHOLD = 1024 * 1024;

/** 「该解密函数在 L1 慢过」的阈值（与 `#747` 的 `cover-decode max≈3.3s` 同一量级以下） */
const IMAGE_WORKER_SLOW_MS = 80;

const IMAGE_COST_CACHE_LIMIT = 64;

/** 解密函数标识（js + lib 的轻量 FNV-1a）—— 按规则缓存成本，不按源写死 */
function imageRuleKey(js: string, lib: string): string {
  const s = `${js.length}:${js}\u0000${lib.length}:${lib}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

const imageSlowRules = new Map<string, number>();
/**
 * `#782` 冷规则「首图探测」的结果：`fast` = 实测一次后确认便宜，后续小图继续留 L1；
 * 不记的话每个小图都会重新探测（永远 worker），比 L1 还慢。
 */
const imageFastRules = new Set<string>();
/** 正在探测中的规则（并发同函数只认第一张的样本，其余只借 worker 跑、不重复计时） */
const imageProbingRules = new Set<string>();

/**
 * 记录一次 **L1** 解密墙钟（宿主同步 ⇒ 墙钟≈CPU），供 `auto` 在下次判「这个函数慢」。
 *
 * ⚠️ 这是**同步**口径，worker 的往返耗时不能记进来（否则 auto 会自我强化成「永远
 * worker」）。worker 探测样本走 {@link recordImageDecodeProbeCost}，另行取阈值。
 */
export function recordImageDecodeL1Cost(js: string, lib: string, ms: number): void {
  const key = imageRuleKey(js, lib);
  // 探测一旦落到 L1（通常就是 worker 失败后的回落）⇒ 这次就是该规则的样本，清掉探测标记
  imageProbingRules.delete(key);
  if (!Number.isFinite(ms) || ms < IMAGE_WORKER_SLOW_MS) return;
  imageFastRules.delete(key);
  imageSlowRules.delete(key);
  imageSlowRules.set(key, ms);
  if (imageSlowRules.size > IMAGE_COST_CACHE_LIMIT) {
    const oldest = imageSlowRules.keys().next().value;
    if (oldest !== undefined) imageSlowRules.delete(oldest);
  }
}

/**
 * `#782` 记录一次 **worker 探测** 的往返墙钟（冷规则首图）。
 *
 * 为什么用往返而不是纯计算：宿主侧拿不到 worker 内部的 `computeMs`（协议只回值），
 * 而往返 = 排队 + 计算 + 传输；对「3s 级慢函数」远大于开销，对 13ms 级快函数
 * 实测约 42ms（仍低于 80ms 阈值），足以区分两档。
 *
 * 只认第一份样本：已判定（慢/快）的规则、或并发探测的后续样本一律丢弃
 * ⇒ 「同函数只测一次」。
 */
export function recordImageDecodeProbeCost(js: string, lib: string, ms: number): void {
  const key = imageRuleKey(js, lib);
  if (imageSlowRules.has(key) || imageFastRules.has(key)) {
    imageProbingRules.delete(key);
    return;
  }
  imageProbingRules.delete(key);
  if (!Number.isFinite(ms)) return;
  if (ms >= IMAGE_WORKER_SLOW_MS) {
    imageSlowRules.set(key, ms);
    if (imageSlowRules.size > IMAGE_COST_CACHE_LIMIT) {
      const oldest = imageSlowRules.keys().next().value;
      if (oldest !== undefined) imageSlowRules.delete(oldest);
    }
    return;
  }
  imageFastRules.add(key);
  if (imageFastRules.size > IMAGE_COST_CACHE_LIMIT) {
    const oldest = imageFastRules.values().next().value;
    if (oldest !== undefined) imageFastRules.delete(oldest);
  }
}

/**
 * `#782` worker 探测失败（抛错 → 调用方回落 L1）时清掉探测标记，
 * 让下次仍可重新探测；成功的 L1 样本由 {@link recordImageDecodeL1Cost} 顺手清。
 */
export function abortImageDecodeProbe(js: string, lib: string): void {
  imageProbingRules.delete(imageRuleKey(js, lib));
}

/** 仅测试用：清空成本缓存，避免用例之间互相污染 */
export function resetImageDecodeCostCache(): void {
  imageSlowRules.clear();
  imageFastRules.clear();
  imageProbingRules.clear();
}

/**
 * `#759` 图片解密能否交给 worker。
 *
 * `#782` 起 `auto` 的冷规则（小图、从未测过）也返回 `true`：首图先在 worker 跑一次
 * 拿样本，**主线程不再为「测出它慢」付出一次秒级阻塞**；样本见
 * {@link recordImageDecodeProbeCost}。实测下来便宜的函数会被记成 `fast`，
 * 后续小图回到 L1（见 {@link planImageDecode}）。
 *
 * @param bytesLen 原图字节数（`auto` 的核心判据之一）
 */
export function canDecodeImageInWorker(js: string, lib = '', bytesLen = 0): boolean {
  const mode = imageDecodeWorkerMode();
  if (mode === 'off') return false;
  if (IMAGE_WORKER_UNSAFE_RE.test(js) || IMAGE_WORKER_UNSAFE_RE.test(lib)) return false;
  if (mode === 'on') return true;
  if (bytesLen >= IMAGE_WORKER_SIZE_THRESHOLD) return true;
  const key = imageRuleKey(js, lib);
  if (imageFastRules.has(key)) return false;
  // slow / 冷规则（探测）都先下移
  return true;
}

/**
 * `#782` 路由计划（比 {@link canDecodeImageInWorker} 多一个 `probe` 标记）。
 *
 * `probe=true` 只发给**冷规则的第一张**：调用方要把这次 worker 往返记进
 * {@link recordImageDecodeProbeCost}。并发进来的同函数后续请求仍然走 worker
 * （不阻塞主线程），但 `probe=false`，不重复取样。
 */
export function planImageDecode(js: string, lib = '', bytesLen = 0): { useWorker: boolean; probe: boolean } {
  if (!canDecodeImageInWorker(js, lib, bytesLen)) return { useWorker: false, probe: false };
  if (imageDecodeWorkerMode() === 'on') return { useWorker: true, probe: false };
  if (bytesLen >= IMAGE_WORKER_SIZE_THRESHOLD) return { useWorker: true, probe: false };
  const key = imageRuleKey(js, lib);
  if (imageSlowRules.has(key)) return { useWorker: true, probe: false };
  if (imageProbingRules.has(key)) return { useWorker: true, probe: false };
  imageProbingRules.add(key);
  return { useWorker: true, probe: true };
}

/**
 * `#759` worker 失败/超时是否值得回落宿主（保证不出「密文当原图」的错图）。
 *
 * **只要 worker 侧抛了错就回落**：宿主 L1 是旧行为本体，最坏只是同一段脚本再跑一次
 * （慢），但能兜住「worker 环境缺能力」这一类真实差异 —— 例如脚本用到 `Buffer` /
 * 某个只有 L1 才有的 `Packages.*` 类 ⇒ worker 抛 ReferenceError ⇒ 不回落就会返回
 * `null`（调用方回传密文，症状与「站点没加密」不可分辨）。
 *
 * 代价：本来就必然抛错的脚本会被跑两次（worker + L1）。`auto` 只在大图/实测慢时才下移，
 * 这类源很少；`=1` 强制下移时由用户自担。
 */
export function shouldRetryImageDecodeInL1(e: unknown): boolean {
  return e !== null && e !== undefined;
}