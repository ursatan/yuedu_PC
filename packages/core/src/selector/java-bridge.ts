/**
 * Rhino Java 类互操作桩（Task #77）—— 按**语料实证**的调用面实现，不猜：
 *
 * 语料统计（484 源）：`Packages.` 40+ 种访问、`JavaImporter` 10 源、`getBytes` 全部 UTF-8、
 * `javax.crypto` 4 源、`Thread.sleep` 9 源、`MessageDigest` 1 源、zip 流 1 源（暂缓，见文末）。
 *
 * 两个真实调用形态（回归测试即按此编写）：
 *   A. 直接访问（七猫四合一）：
 *      `new Packages.java.lang.String(KEY).getBytes('UTF-8')` → **真字节**
 *      `Packages.android.util.Base64.decode(b64, 0)` → 字节
 *      `Packages.java.util.Arrays.copyOfRange(raw, 0, 16)` → 字节切片
 *      `Packages.javax.crypto.Cipher.getInstance('AES/CBC/PKCS5Padding').init(2, key, iv).doFinal(ct)`
 *   B. `with(JavaImporter)`（七猫官方）：
 *      `var ji = new JavaImporter(); ji.importPackage(Packages.java.lang, …); with (ji) { … }`
 *      → 裸类名（`Cipher`/`SecretKeySpec`/`Arrays`/**`String`**）经 with 作用域解析到 importer 自身，
 *      且构造器**无 new 也能调**（Rhino 允许）；`String("242c…").getBytes()` 之所以能工作，
 *      正是 importPackage(java.lang) 后裸 `String` 被解析成 java.lang.String。
 *
 * ⚠️ byte[] 语义 = Uint8Array：`String(bytes)` 走 JString 构造器还原文本；
 *    直接拼 `''+bytes` 会得到 "1,2,3"（源不会这么写，但要防 toString 污染）。
 */
import * as nodeCrypto from 'node:crypto';
import { recordBlock } from '../diag/block-stats';
// `Packages.android.graphics` 的位图实现（图片切条还原，禁漫天堂等）——只在 L1 生效
import { makeAndroidGraphicsNs } from './android-graphics';
// `#612` 上游 ClassShutter 黑名单（RhinoClassShutter.kt:47-191）
import { isShutteredJavaPath, JAVA_SYSTEM_PROTECTED } from './java-shutter';

function asBytes(buf: Buffer): Uint8Array {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

/** 任意输入 → 字节（byte[] 语义） */
export function toJavaBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  if (typeof v === 'string') return new Uint8Array(Buffer.from(v, 'utf-8'));
  if (Array.isArray(v)) return new Uint8Array(v.map((x) => Number(x) & 0xff));
  if (v instanceof Number || typeof v === 'number') return new Uint8Array([Number(v) & 0xff]);
  return new Uint8Array(0);
}

function bytesToText(b: Uint8Array, charset?: unknown): string {
  try {
    return new TextDecoder(charset == null ? 'utf-8' : String(charset)).decode(b);
  } catch {
    return Buffer.from(b).toString('utf-8');
  }
}

function textToBytes(s: string, charset?: unknown): Uint8Array {
  const cs = charset == null ? 'utf-8' : String(charset).toLowerCase().replace(/^iso-?8859-1$/i, 'latin1');
  try {
    if (cs === 'utf-8' || cs === 'utf8' || cs === 'ascii' || cs === 'latin1' || cs === 'utf-16le') {
      return new Uint8Array(Buffer.from(s, cs));
    }
  } catch { /* fallthrough */ }
  return new Uint8Array(Buffer.from(s, 'utf-8')); // 语料只用 UTF-8；其余编码兜底（避免崩规则）
}

/** java.lang.String：字符串 ↔ 字节 的双面体（new / 无 new 均可） */
export function makeJString(): (...a: unknown[]) => unknown {
  class JStringImpl {
    readonly text: string;
    constructor(a?: unknown, b?: unknown) {
      if (a instanceof Uint8Array || Buffer.isBuffer(a) || a instanceof ArrayBuffer) {
        this.text = bytesToText(a as Uint8Array, b); // new String(bytes, 'UTF-8')
      } else {
        this.text = String(a ?? '');
      }
    }
    getBytes(charset?: unknown): Uint8Array {
      return textToBytes(this.text, charset);
    }
    length(): number {
      return this.text.length;
    }
    charAt(i: unknown): string {
      return this.text.charAt(Number(i) || 0);
    }
    /**
     * `#508` **补齐 java.lang.String 的常用方法**（3.9.61 的正文解密链踩出来的）。
     *
     * 为什么必须有：源脚本写 `with (new JavaImporter()) { importPackage(Packages.java.lang) … }`
     * 时，`String` 被 importPackage 复制进 with 作用域 ⇒ 脚本里的 `String(x)` 解析成
     * **`java.lang.String(x)`**（Java 语义，返回对象）而不是 JS 原生 String。
     * Legado 里那是真 Java String（有全套方法），我们只实现了 6 个 ⇒ 脚本调 `.indexOf` 就炸
     * （七猫 3.9.61 正文：`qmText.indexOf("PK")` ⇒ RULE_PARSE@parse）。
     * ⇒ 按 java.lang.String 的常用子集补齐（只读方法，不改 `text`）。
     */
    indexOf(s: unknown, from?: unknown): number {
      return this.text.indexOf(String(s ?? ''), from == null ? 0 : Number(from));
    }
    lastIndexOf(s: unknown, from?: unknown): number {
      return from == null ? this.text.lastIndexOf(String(s ?? '')) : this.text.lastIndexOf(String(s ?? ''), Number(from));
    }
    startsWith(s: unknown, pos?: unknown): boolean {
      return this.text.startsWith(String(s ?? ''), pos == null ? 0 : Number(pos));
    }
    endsWith(s: unknown): boolean {
      return this.text.endsWith(String(s ?? ''));
    }
    contains(s: unknown): boolean {
      return this.text.includes(String(s ?? ''));
    }
    equals(o: unknown): boolean {
      return this.text === (o instanceof JStringImpl ? o.text : String(o ?? ''));
    }
    equalsIgnoreCase(o: unknown): boolean {
      return this.text.toLowerCase() === String(o ?? '').toLowerCase();
    }
    isEmpty(): boolean {
      return this.text.length === 0;
    }
    /** Java 的 `replace` 是**字面量全替换**（不是正则，与 JS 不同） */
    replace(a: unknown, b: unknown): string {
      return this.text.split(String(a ?? '')).join(String(b ?? ''));
    }
    replaceAll(re: unknown, b: unknown): string {
      return this.text.replace(new RegExp(String(re ?? ''), 'g'), String(b ?? ''));
    }
    split(re: unknown, limit?: unknown): string[] {
      const out = this.text.split(new RegExp(String(re ?? '')));
      return limit == null ? out : out.slice(0, Number(limit));
    }
    toUpperCase(): string {
      return this.text.toUpperCase();
    }
    toLowerCase(): string {
      return this.text.toLowerCase();
    }
    concat(s: unknown): string {
      return this.text + String(s ?? '');
    }
    matches(re: unknown): boolean {
      return new RegExp(String(re ?? '')).test(this.text);
    }
    /** 隐式转换：`qmText == "x"` / 模板拼接 / `+` 都按 Java String 的值走 */
    valueOf(): string {
      return this.text;
    }
    [Symbol.toPrimitive](): string {
      return this.text;
    }
    substring(a?: unknown, b?: unknown): string {
      return this.text.substring(Number(a) || 0, b == null ? undefined : Number(b));
    }
    trim(): string {
      return this.text.trim();
    }
    toString(): string {
      return this.text;
    }
  }
  const ctor = function JString(a?: unknown, b?: unknown) {
    return new JStringImpl(a, b); // new / 无 new 都返回实例（Rhino 允许无 new 调构造器）
  } as unknown as ((a?: unknown, b?: unknown) => unknown) & Record<string, unknown>;
  // `#508` 静态方法（与 java.lang.String 同名同义）。⚠️ 用 Record 断言：`valueOf` 与 Object 原型签名冲突
  const ctorStatic = ctor as unknown as Record<string, unknown>;
  ctorStatic['valueOf'] = (x: unknown): string => (x == null ? 'null' : String(x));
  ctorStatic['join'] = (sep: unknown, ...items: unknown[]): string => items.map((i) => String(i ?? '')).join(String(sep ?? ''));
  return ctor;
}

/* ---- javax.crypto.spec ---- */
export function makeSpecNs(): Record<string, unknown> {
  function holder(name: string, keys: string[]) {
    // 工厂：new X(...) / X(...) 都返回实例；实例带 getBytes 等 JDK 风格访问器
    const Impl = class {
      constructor(...args: unknown[]) {
        Object.assign(this, { _name: name });
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i] as string;
          const a = args[i];
          (this as Record<string, unknown>)[k] = k === 'bytes' || k === 'iv' ? toJavaBytes(a) : a;
        }
      }
      getBytes(): Uint8Array {
        return (this as unknown as { bytes: Uint8Array }).bytes;
      }
      getIV(): Uint8Array {
        return (this as unknown as { iv: Uint8Array }).iv;
      }
      getTLen(): number {
        return Number((this as unknown as { tLen: number }).tLen ?? 128);
      }
      getAlgorithm(): string {
        return String((this as unknown as { algo: unknown }).algo ?? '');
      }
    };
    Object.defineProperty(Impl, 'name', { value: name });
    const ctor = function (...args: unknown[]) {
      return new Impl(...args);
    } as unknown as { new (...a: unknown[]): unknown; (...a: unknown[]): unknown };
    return ctor;
  }
  return {
    SecretKeySpec: holder('SecretKeySpec', ['bytes', 'algo']),
    IvParameterSpec: holder('IvParameterSpec', ['iv']),
    GCMParameterSpec: holder('GCMParameterSpec', ['tLen', 'iv']),
    // PBEKeySpec 等罕见形态走 nest 兜底
  };
}

/* ---- javax.crypto.Cipher ---- */
interface CipherSpec {
  algo: string;
  mode: 'cbc' | 'ecb' | 'gcm' | 'chacha20';
  padding: boolean;
  /** AEAD 认证标签字节数（`ChaCha20-Poly1305` = 16）；0/缺省 = 无标签 */
  tagLen?: number;
}
function parseTransformation(t: unknown): CipherSpec {
  const s = String(t ?? 'AES/CBC/PKCS5Padding');
  const m = /^(AES|DES|DESede|RSA)\/(CBC|ECB|GCM|CTR)\/(NoPadding|PKCS5Padding|ISO10126Padding)$/i.exec(s.trim());
  if (m) {
    return {
      algo: m[1] === 'DESede' ? 'des-ede3' : m[1]!.toLowerCase(),
      mode: m[2]!.toLowerCase() as CipherSpec['mode'],
      padding: !/NoPadding/i.test(m[3]!),
    };
  }
  /**
   * `ChaCha20-Poly1305`（JDK 11 起的 AEAD 变换；**变换串只有算法名，没有 `/mode/padding` 段**）。
   * 实测（听友M 发现页分类条 0 卡片）：源脚本 `Cipher.getInstance("ChaCha20-Poly1305")` 此前直接抛
   * 「不支持的变换」⇒ 整条解密链断 ⇒ 列表恒空。对齐 JDK 语义：
   *   · 密钥 32 字节、IV 12 字节；AEAD 密文 = ciphertext || tag(16)（与 GCM 同形）；
   *   · `ChaCha20`（无认证）也一并接受：Node 的 `chacha20` 要 16 字节 IV ⇒ 12 字节 nonce 前补 4 字节计数器。
   */
  const c = /^(ChaCha20-Poly1305|ChaCha20)$/i.exec(s.trim());
  if (c) {
    const aead = /poly1305/i.test(c[1]!);
    return { algo: 'chacha20', mode: 'chacha20', padding: false, ...(aead ? { tagLen: 16 } : {}) };
  }
  throw new Error(
    `Cipher.getInstance: 不支持的变换 ${s}（已实现 AES/CBC|ECB|GCM + PKCS5/NoPadding、ChaCha20-Poly1305）`,
  );
}
function aesVariant(key: Uint8Array): string {
  const bits = key.length * 8;
  if (bits === 128 || bits === 192 || bits === 256) return `aes-${bits}`;
  throw new Error(`Cipher: AES 密钥长度须为 16/24/32 字节，实际 ${key.length}`);
}

/**
 * `ChaCha20` / `ChaCha20-Poly1305` 的 `doFinal`。
 * JDK AEAD 的密文形状与 GCM 相同（`ciphertext || tag`）；无认证的 `ChaCha20` 是流密码，无标签。
 */
function chacha20Final(
  mode: number,
  keyBytes: Uint8Array,
  ivBytes: Uint8Array | undefined,
  spec: CipherSpec,
  data: Uint8Array,
): Uint8Array {
  const tagLen = spec.tagLen ?? 0;
  const key = Buffer.from(keyBytes);
  const iv = Buffer.from(ivBytes ?? new Uint8Array(12));
  // Node 的 `chacha20` 要 16 字节 IV（4 字节计数器 ‖ 12 字节 nonce）；JDK 给的是 12 字节
  const iv16 = iv.length === 16 ? iv : Buffer.concat([Buffer.alloc(4), iv]);
  type Aead = {
    setAuthTag: (t: Buffer) => void;
    getAuthTag: () => Buffer;
    update: (b: Buffer) => Buffer;
    final: () => Buffer;
  };
  if (tagLen > 0) {
    if (mode === 2) {
      const ct = data.subarray(0, data.length - tagLen);
      const tag = data.subarray(data.length - tagLen);
      const d = nodeCrypto.createDecipheriv('chacha20-poly1305', key, iv, {
        authTagLength: tagLen,
      }) as unknown as Aead;
      d.setAuthTag(Buffer.from(tag));
      return asBytes(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
    }
    const e = nodeCrypto.createCipheriv('chacha20-poly1305', key, iv, {
      authTagLength: tagLen,
    }) as unknown as Aead;
    const ct = Buffer.concat([e.update(Buffer.from(data)), e.final()]);
    return asBytes(Buffer.concat([ct, e.getAuthTag()]));
  }
  const d =
    mode === 2
      ? nodeCrypto.createDecipheriv('chacha20', key, iv16)
      : nodeCrypto.createCipheriv('chacha20', key, iv16);
  return asBytes(Buffer.concat([d.update(Buffer.from(data)), d.final()]));
}

function makeCipherInstance(spec: CipherSpec): Record<string, unknown> {
  let mode = 1; // ENCRYPT_MODE
  let keyBytes: Uint8Array = new Uint8Array(0);
  let ivBytes: Uint8Array<ArrayBuffer> | undefined;
  let gcmTagLen = 128;
  return {
    init(m: unknown, keySpec: unknown, parameterSpec?: unknown): void {
      mode = Number(m);
      const ks = keySpec as { getBytes?: () => Uint8Array };
      keyBytes = (ks?.getBytes ? ks.getBytes() : toJavaBytes(keySpec)) as Uint8Array<ArrayBuffer>;
      if (parameterSpec != null) {
        const ps = parameterSpec as { getIV?: () => Uint8Array; getTLen?: () => number };
        if (ps.getIV) ivBytes = ps.getIV() as Uint8Array<ArrayBuffer>;
        else ivBytes = toJavaBytes(parameterSpec) as Uint8Array<ArrayBuffer>;
        if (ps.getTLen) gcmTagLen = ps.getTLen();
      }
    },
    doFinal(input?: unknown): Uint8Array {
      const data = input == null ? new Uint8Array(0) : toJavaBytes(input);
      // ChaCha20 分支不走 AES 密钥长度判据（32 字节才对，AES 只认 16/24/32）
      if (spec.mode === 'chacha20') return chacha20Final(mode, keyBytes, ivBytes, spec, data);
      const variant = aesVariant(keyBytes);
      if (spec.mode === 'gcm') {
        // Java GCM：密文 = ct || tag（tag 由 GCMParameterSpec.getTLen 指定位数）
        const tagLen = Math.floor(gcmTagLen / 8);
        if (mode === 2) {
          const ct = data.subarray(0, data.length - tagLen);
          const tag = data.subarray(data.length - tagLen);
          const d = nodeCrypto.createDecipheriv(`${variant}-gcm`, Buffer.from(keyBytes), Buffer.from(ivBytes ?? new Uint8Array(12))) as unknown as { setAuthTag: (t: Buffer) => void; update: (b: Buffer) => Buffer; final: () => Buffer };
          d.setAuthTag(Buffer.from(tag));
          return asBytes(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
        }
        const e = nodeCrypto.createCipheriv(`${variant}-gcm`, Buffer.from(keyBytes), Buffer.from(ivBytes ?? new Uint8Array(12))) as unknown as { getAuthTag: () => Buffer; update: (b: Buffer) => Buffer; final: () => Buffer };
        const ct = Buffer.concat([e.update(Buffer.from(data)), e.final()]);
        return asBytes(Buffer.concat([ct, e.getAuthTag()]));
      }
      const algo = spec.mode === 'ecb' ? `${variant}-ecb` : `${variant}-cbc`;
      const d = mode === 2
        ? nodeCrypto.createDecipheriv(algo, Buffer.from(keyBytes), ivBytes ? Buffer.from(ivBytes) : null)
        : nodeCrypto.createCipheriv(algo, Buffer.from(keyBytes), ivBytes ? Buffer.from(ivBytes) : null);
      d.setAutoPadding(spec.padding);
      return asBytes(Buffer.concat([d.update(Buffer.from(data)), d.final()]));
    },
  };
}
export function makeCipherNs(): Record<string, unknown> {
  return {
    getInstance: (t: unknown) => makeCipherInstance(parseTransformation(t)),
    ENCRYPT_MODE: 1,
    DECRYPT_MODE: 2,
  };
}

/* ---- java.security.MessageDigest ---- */
/**
 * `Packages.java.security.MessageDigest`（**按 Java 公共契约移植**，不是只留个 digest）。
 *
 * ## 为什么必须补齐（2026-10-24 全量基线 r2）
 * 🍅番茄短剧·漫剧(APP) / 🍅番茄漫画(APP) 的 jsLib：
 * ```js
 * function HG_md5(u8){ var d=Packages.java.security.MessageDigest.getInstance('MD5');
 *   d.update(HG_jb(u8)); return HG_j2u(d.digest()); }
 * ```
 * 本仓此前只实现了 `digest(input?)` 一个方法 ⇒ `d.update is not a function`（2 源）。
 *
 * ## 上游依据
 * legado 里这是**真 Java 类**（`java.security.MessageDigest`，Rhino 直通），所以
 * `update(byte) / update(byte[]) / update(byte[],off,len) / digest() / digest(byte[]) /
 * digest(byte[],off,len) / reset() / getAlgorithm() / getDigestLength() / clone()` **全都在**。
 * 移植时按这组签名对齐（`java.security.MessageDigest` JDK 契约）：
 *  · `update` 累积、返回 void；`digest()` 返回摘要**并自动 reset**（Java 明语义）；
 *  · `digest(input)` = 先 update 再 digest。
 */
export function makeMessageDigestNs(): Record<string, unknown> {
  const norm = (a: unknown) => String(a ?? '').toUpperCase().replace(/-/g, '');
  const map: Record<string, string> = { MD5: 'md5', SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
  /** Java `getDigestLength()`：摘要字节数（固定值，不必真算一次） */
  const lenOf: Record<string, number> = { md5: 16, sha1: 20, sha256: 32, sha512: 64 };

  /** `byte[] buf, int offset, int len` 三元组的切片（Java 的重载语义） */
  const slice = (data: Uint8Array, off?: unknown, len?: unknown): Uint8Array => {
    if (off == null) return data;
    const o = Math.max(0, Number(off) || 0);
    const n = len == null ? data.length - o : Math.max(0, Number(len) || 0);
    return data.subarray(o, o + n);
  };

  const makeDigest = (impl: string, algo: string, initial?: ReturnType<typeof nodeCrypto.createHash>) => {
    // digest() 之后 Java 会自动 reset ⇒ 用一个可重建的 hash 句柄模拟
    let h = initial ?? nodeCrypto.createHash(impl);
    const update = (input?: unknown, off?: unknown, len?: unknown): void => {
      h.update(Buffer.from(slice(toJavaBytes(input), off, len)));
    };
    const digest = (input?: unknown, off?: unknown, len?: unknown): Uint8Array => {
      if (input != null) update(input, off, len);
      const out = asBytes(h.digest());
      h = nodeCrypto.createHash(impl); // Java: digest() 后自动 reset
      return out;
    };
    return {
      update,
      digest,
      reset: (): void => {
        h = nodeCrypto.createHash(impl);
      },
      getAlgorithm: (): string => algo,
      getDigestLength: (): number => lenOf[impl] ?? 0,
      /** Java `clone()`：**复制当前累积状态**（Node 的 `hash.copy()` 正好同语义） */
      clone: () => makeDigest(impl, algo, h.copy()),
    };
  };

  return {
    getInstance: (algo: unknown) => {
      const impl = map[norm(algo)];
      if (!impl) throw new Error(`MessageDigest: 不支持的算法 ${String(algo)}（已实现 MD5/SHA-1/SHA-256/SHA-512）`);
      return makeDigest(impl, String(algo ?? ''));
    },
    /** Java `MessageDigest.isEqual(byte[], byte[])`（常量时间比较） */
    isEqual: (a: unknown, b: unknown): boolean => {
      const x = toJavaBytes(a);
      const y = toJavaBytes(b);
      if (x.length !== y.length) return false;
      let diff = 0;
      for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
      return diff === 0;
    },
  };
}

/* ---- java.security.SecureRandom（`#577`） ---- */
/**
 * `new Packages.java.security.SecureRandom()` + `nextInt(bound)` / `nextBytes(bytes)`。
 *
 * 为什么必须有：🏷微信读书二合一本地源的登录脚本（`wrDeviceState`）用
 * `new Packages.java.security.SecureRandom()` 生成 28~38 位设备号；宿主 `security` 命名空间
 * 此前**只有 MessageDigest** ⇒ 属性落到 `nest()` 兜底（不是构造函数）⇒ 游客登录 / 微信扫码
 * 都抛「SecureRandom is not a constructor」，登录界面两个按钮全部无效。
 *
 * 语义对齐 Java：`nextInt(bound)` ∈ [0, bound)；`nextBytes(bytes)` **就地填充**传入数组
 * （返回 undefined）。用 `crypto.randomInt/randomBytes`（真随机源，不是 Math.random）。
 */
export function makeSecureRandomCtor(): unknown {
  class SecureRandom {
    nextInt(bound?: unknown): number {
      const n = Math.floor(Number(bound));
      if (!Number.isFinite(n) || n <= 0) return nodeCrypto.randomInt(0, 0x7fffffff);
      return nodeCrypto.randomInt(0, n);
    }
    nextLong(): number {
      // Java 是 64 位；JS number 安全整数范围内取值即可满足源脚本（常见用于拼 ID）
      return nodeCrypto.randomInt(0, Number.MAX_SAFE_INTEGER);
    }
    nextDouble(): number {
      return nodeCrypto.randomInt(0, 2 ** 48) / 2 ** 48;
    }
    nextBytes(bytes: unknown): void {
      const len = Array.isArray(bytes)
        ? bytes.length
        : (bytes instanceof Uint8Array ? bytes.length : -1);
      if (len < 0) throw new Error('SecureRandom.nextBytes: 参数必须是 byte[]');
      const rnd = nodeCrypto.randomBytes(len);
      if (Array.isArray(bytes)) {
        for (let i = 0; i < len; i++) bytes[i] = rnd[i]!;
      } else {
        (bytes as Uint8Array).set(rnd);
      }
    }
  }
  return SecureRandom;
}

/* ---- cn.hutool（2026-09-23 补，缺陷类AO） ---- */

/** hutool 摘要算法名 → Node 名（与 `makeMessageDigestNs` 同一张表） */
function hutoolAlgo(a: unknown): string | undefined {
  const key = String(a ?? '').toUpperCase().replace(/-/g, '');
  return { MD5: 'md5', SHA1: 'sha1', SHA: 'sha1', SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512' }[key];
}

/** `DigestUtil.md5Hex(x)` 等：hutool 统一返回**小写 hex 串** */
function hutoolDigestHex(algo: unknown, data: unknown): string {
  const impl = hutoolAlgo(algo);
  if (!impl) throw new Error(`DigestUtil: 不支持的算法 ${String(algo)}（已实现 MD5/SHA-1/SHA-256/SHA-384/SHA-512）`);
  return nodeCrypto.createHash(impl).update(Buffer.from(toJavaBytes(data))).digest('hex');
}

/**
 * `cn.hutool.*` 命名空间。
 *
 * ⚠️ **为什么必须真实现**（2026-09-23 修，缺陷类AO）：`makeJavaPackages` 对**未知顶级包**
 * 走的是 `nest()` 兜底 —— 一个「任何属性访问都返回自身、调用一律返回 `''`」的 Proxy。
 * 于是 `Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex(x)` **静默返回空串**。
 *
 * 实测症状（🏷七猫四合一本地版「发现页无内容卡片：站点返回 {"Status":"Unauthorized"}」）：
 * 该源 jsLib 的签名链是
 *     `qmSign(v) = qmMd5(v + QM_SECRET)`；`qmMd5(v) = Packages.cn.hutool.crypto.digest.DigestUtil.md5Hex(v)`
 * 空串顺着链子传下去 ⇒ `sign` 头、`qm-request-id` 头、以及 URL 上的 `sign=` 查询参数**全是空串**
 * （留痕实测：三个字段长度均为 0）⇒ 站点判签名缺失 ⇒ 401 `{"Status":"Unauthorized"}`。
 * 而**登录接口不校验签名**，所以同一轮里 `POST /api/v1/login/tourist` 还是 200 登录成功 ——
 * 正是这种「一半成功一半失败」的形态最容易把类缺陷误读成「站点改版」。
 *
 * 语料实证（484 源）用到 `cn.hutool` 的只有 4 个源，调用面就这几项：
 *   · `crypto.digest.DigestUtil.md5(key)`（阅文集团）
 *   · `crypto.digest.DigestUtil.md5Hex(str)`（七猫四合一本地版）
 *   · `core.codec.Base64.encode(str)`（长佩文学）
 *   · `importPackage(Packages.cn.hutool.core.util / core.codec / crypto.digest)` + 裸类名
 *     `StrUtil` / `Base64` / `DigestUtil`（木里聚合——它同时 import 了 `Packages.okhttp3`，那部分仍未实现）
 * 所以这里返回的是**真实对象**（不是 Proxy）：`JavaImporter.importPackage` 靠 `Object.keys` 取类名，
 * Proxy 没有 own keys ⇒ 裸类名一个都挂不上。
 */
function makeHutoolNs(): Record<string, unknown> {
  const DigestUtil = {
    md5: (d: unknown) => hutoolDigestHex('MD5', d),
    md5Hex: (d: unknown) => hutoolDigestHex('MD5', d),
    sha1: (d: unknown) => hutoolDigestHex('SHA-1', d),
    sha1Hex: (d: unknown) => hutoolDigestHex('SHA-1', d),
    sha256: (d: unknown) => hutoolDigestHex('SHA-256', d),
    sha256Hex: (d: unknown) => hutoolDigestHex('SHA-256', d),
    /** 源里常见写法：`DigestUtil.digester("MD5").digestHex(str)` */
    digester: (algo: unknown) => ({
      digestHex: (d: unknown) => hutoolDigestHex(algo, d),
      digestHex16: (d: unknown) => hutoolDigestHex(algo, d),
      digest: (d: unknown) => new Uint8Array(Buffer.from(hutoolDigestHex(algo, d), 'hex')),
    }),
  };
  const Base64 = {
    // hutool `Base64.encode(String)` → String；`Base64.encode(byte[])` → byte[]（base64 的 ASCII 字节）
    encode: (v: unknown): unknown =>
      typeof v === 'string' ? Buffer.from(v, 'utf-8').toString('base64') : asBytes(Buffer.from(Buffer.from(toJavaBytes(v)).toString('base64'))),
    encodeStr: (v: unknown, charset?: unknown) => Buffer.from(bytesToText(toJavaBytes(v), charset)).toString('base64'),
    encodeString: (v: unknown) => Buffer.from(String(v ?? ''), 'utf-8').toString('base64'),
    decode: (s: unknown) => new Uint8Array(Buffer.from(String(s ?? ''), 'base64')),
    decodeStr: (s: unknown) => Buffer.from(String(s ?? ''), 'base64').toString('utf-8'),
  };
  const StrUtil = {
    isEmpty: (s: unknown) => s == null || String(s).length === 0,
    isNotEmpty: (s: unknown) => s != null && String(s).length > 0,
    isBlank: (s: unknown) => s == null || String(s).trim().length === 0,
    isNotBlank: (s: unknown) => s != null && String(s).trim().length > 0,
    cleanBlank: (s: unknown) => String(s ?? '').replace(/\s+/g, ''),
    sub: (s: unknown, from: unknown, to: unknown) =>
      String(s ?? '').slice(Math.max(0, Number(from) || 0), to == null ? undefined : Number(to) || 0),
    format: (tpl: unknown, ...args: unknown[]) =>
      String(tpl ?? '').replace(/\{(\d*)\}/g, (_m, i: string) => String(i === '' ? args.shift() : args[Number(i)]) ?? ''),
  };
  return {
    hutool: {
      crypto: { digest: { DigestUtil } },
      core: { codec: { Base64 }, util: { StrUtil } },
    },
  };
}

/**
 * 未实现的 Java 类/成员**留痕**（铁律 3：允许兜底，但兜底必须可观测）。
 *
 * 为什么必需：`nest()` 是「任何路径都存在、调用一律返回空串」的兜底 —— 它让**类缺失**
 * 与**站点返回空**在症状上完全一样。缺陷类AO（`cn.hutool.DigestUtil` 缺失 → 签名空 →
 * 401 Unauthorized）之所以能潜伏很久，就是因为这里一声不响。每条路径只报一次，量级可控。
 */
const warnedJavaClasses = new Set<string>();

/**
 * `#196` **当前求值的源身份**（给下面的留痕用）。
 *
 * 为什么需要：类AO 这类缺陷的症状是「静默空值」，唯一的线索就是这行 warn；
 * 不带源身份时，几百个源里谁触发的根本无从查起（用户 2026-10-02 明确指出：
 * `[java-bridge] 未实现的 Java 类/成员：Packages.org` 看不出是哪个源）。
 *
 * ★ 为什么可以用模块级变量：**L1 求值是同步的** ⇒ 在同步块内「设 → 求值 → 复位」
 * 不会被并发的其它源插队（worker 路径另有一个实例，也不相干）。
 * 设置方见 `selector/js.ts` 的 `createJsEvaluator`（每次 eval 前后设置/复位）。
 */
let javaBridgeSourceLabel = '';

/** 设置当前源身份（返回复位函数；`label` 建议形如 `源名(https___x.com)`） */
export function setJavaBridgeSourceLabel(label: string): () => void {
  const prev = javaBridgeSourceLabel;
  javaBridgeSourceLabel = label || '';
  return () => {
    javaBridgeSourceLabel = prev;
  };
}
/** JS/Proxy 内部协议属性 —— 它们被访问不代表源脚本要用某个 Java 类 */
const JAVA_NEST_SKIP = new Set<string | symbol>([
  'prototype', 'then', 'toString', 'valueOf', 'constructor', 'inspect',
  'toJSON', 'length', 'name', 'call', 'apply', 'bind', 'nodeType', 'hasOwnProperty',
]);

/**
 * 缺失 Java 类/成员的统一留痕入口（每路径一次）。
 *
 * `#612`：返回 `true` = 该路径被**上游 ClassShutter 拒绝**（`RhinoClassShutter.kt:47-191`），
 * 调用方必须返回 `undefined`（= 类不可见）而**不是**「调用返回空串」的兜底桩 ——
 * 上游 Rhino 的语义就是「取不到」，继续往下点会 TypeError，我们逐字对齐。
 */
function warnMissingJavaClass(path: string): boolean {
  const shuttered = isShutteredJavaPath(path);
  if (warnedJavaClasses.has(path)) return shuttered;
  warnedJavaClasses.add(path);
  // eslint-disable-next-line no-console
  // `#196`：带上「是哪个源」—— 重名源靠 id 区分（id = bookSourceUrl 的规范化形态）
  const src = javaBridgeSourceLabel ? ` · 源 ${javaBridgeSourceLabel}` : '';
  console.warn(
    shuttered
      ? `[java-bridge]${src} ClassShutter 拒绝访问：Packages.${path}` +
          `（上游 RhinoClassShutter.kt 黑名单 ⇒ 对脚本不可见，与上游一致返回 undefined）`
      : `[java-bridge]${src} 未实现的 Java 类/成员：Packages.${path} —— 访问被兜底成空串` +
          `（源脚本若依赖它，症状是**静默空值**，不是报错；需要时在 makeJavaPackages 里补实现）`,
  );
  return shuttered;
}

/** 未知包/类的兜底 Proxy（任何路径都存在、调用一律返回空串），带路径留痕 */
function nest(path = ''): unknown {
  return new Proxy(function () { return ''; } as unknown as Record<string, unknown>, {
    get: (_t, prop: string | symbol) => {
      if (prop === 'prototype') return undefined;
      if (typeof prop === 'string' && !JAVA_NEST_SKIP.has(prop)) {
        const full = path ? `${path}.${prop}` : prop;
        if (warnMissingJavaClass(full)) return undefined;
        return nest(full);
      }
      return undefined;
    },
    apply: () => '',
  });
}

/**
 * 已实现命名空间的包装：**真键可枚举 + 未知子路径走留痕兜底**。
 *
 * 两个约束必须同时满足，所以不能图省事只用其中一种：
 *   · `JavaImporter.importPackage(pkg)` 靠 `Object.keys(pkg)` 取类名 → 必须是**真对象**
 *     （纯 Proxy 的 ownKeys 为空 ⇒ 裸类名一个都挂不上，木里聚合那种写法直接失效）；
 *   · 但真对象上取不存在的成员会得到 `undefined`，再往下点就 **TypeError**
 *     （`Packages.cn.hutool.definitely.not.implemented()` → `Cannot read properties of undefined`）
 *     —— 与「未实现的能力一律兜底成空串」的历史语义不一致，会把「静默空」变成「硬报错」。
 * 做法：Proxy 转发真实属性（ownKeys/描述符也转发），未命中则回落到 `nest()` 并留痕。
 *
 * `#474b` 导出：`org` 命名空间同款（js.ts 的 `makeOrgStub` 结果必须经此包装 ——
 * 否则 `Packages.org.test196.p1` 这类**未知子命名空间**取到 undefined 再往下点就
 * TypeError（#196 回归锁当场抓获）。worker 模板里同语义的 nestOrg 已自带，无需引这里。
 */
export function nsProxy(obj: Record<string, unknown>, path = ''): Record<string, unknown> {
  return new Proxy(obj, {
    get: (t, prop: string | symbol) => {
      if (typeof prop === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(t, prop)) return (t as Record<string, unknown>)[prop];
      if (prop === 'prototype' || JAVA_NEST_SKIP.has(prop)) return undefined;
      const full = path ? `${path}.${prop}` : prop;
      if (warnMissingJavaClass(full)) return undefined;
      return nest(full);
    },
  });
}

/** 递归包装：让**每一级**都已实现对象都具备「未知路径兜底」能力 */
function deepNsProxy(obj: Record<string, unknown>, path = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepNsProxy(v as Record<string, unknown>, p) : v;
  }
  return nsProxy(out, path);
}

/* ---- java.lang.Thread / System ---- */
let sleepWarned = false;
/** 当前是否运行在 worker 线程（worker-pool 的 WORKER_SRC 会置位） */
function inWorkerThread(): boolean {
  return (globalThis as { __yueduInWorker?: boolean }).__yueduInWorker === true;
}
function threadNs(): Record<string, unknown> {
  return {
    /**
     * Legado 语义 = 阻塞当前线程；我们**宿主是单线程**，真睡会把整个事件循环拖住
     * —— 表现为「其它源全部请求超时」（2026-09-21 实测归因：全量基线里 120 起
     * `连接超时` / 60 起 60s 超时，除网络因素外，主线程被同步阻塞也是放大器）。
     *
     * 分级上限（缺陷类T 的一部分）：
     *  · **worker 线程内**：只阻塞本脚本 → 保留 3s（Legado 保真）
     *  · **L1/主线程内**：限 200ms —— 把「一条源睡 3s」对全局的影响压到可接受，
     *    同时 `recordBlock` 留痕，避免变成静默行为退化。
     */
    sleep: (msRaw: unknown): void => {
      const inWorker = inWorkerThread();
      const cap = inWorker ? 3_000 : 200;
      const raw = Math.max(0, Number(msRaw) || 0);
      const ms = Math.min(cap, raw);
      if (raw > cap && !sleepWarned) {
        sleepWarned = true;
        console.warn(
          `[java-bridge] Thread.sleep(${raw}ms) 被截断为 ${cap}ms（${inWorker ? 'worker' : '主线程/L1'}）——` +
            '主线程阻塞会拖慢所有并发源，见 docs/archive/handover-changelog-20260928.md 缺陷类T',
        );
      }
      if (ms > 0) {
        const sab = new Int32Array(new SharedArrayBuffer(4));
        const started = Date.now();
        Atomics.wait(sab, 0, 0, ms);
        if (!inWorker) recordBlock('thread-sleep', Date.now() - started, 'java.lang.Thread.sleep（主线程）');
      }
    },
  };
}
function systemNs(): Record<string, unknown> {
  /**
   * `#612` 上游 `systemClassProtectedName`（`RhinoClassShutter.kt:122`）：
   * `System` 只额外挡 `load`/`loadLibrary`/`exit` 三个方法 —— 其余（currentTimeMillis 等）照常。
   * 这里给它们显式桩：**抛错**（而不是「不是函数」的 TypeError），错误信息指明依据，便于归因。
   */
  const out: Record<string, unknown> = {};
  for (const name of JAVA_SYSTEM_PROTECTED) {
    out[name] = (): never => {
      throw new Error(
        `java.lang.System.${name} 被禁止：上游 RhinoClassShutter.kt:122 systemClassProtectedName`,
      );
    };
  }
  return Object.assign(out, {
    currentTimeMillis: (): number => Date.now(),
    nanoTime: (): number => Number(process.hrtime.bigint()),
    lineSeparator: (): string => '\n',
    getProperty: (k: unknown) => ({ 'line.separator': '\n', 'file.separator': '/', 'os.name': 'Linux' }[String(k)] as string | undefined),
  });
}

/* ---- java.io 字节流（语料 3 源） ---- */
export function makeIoNs(): Record<string, unknown> {
  class ByteArrayOutputStream {
    private buf = Buffer.alloc(0);
    write(b: unknown, off?: unknown, len?: unknown): void {
      if (off != null || len != null) {
        const bytes = toJavaBytes(b);
        this.buf = Buffer.concat([this.buf, Buffer.from(bytes.subarray(Number(off) || 0, (Number(off) || 0) + (Number(len) || 0)))]);
      } else {
        this.buf = Buffer.concat([this.buf, Buffer.from(toJavaBytes(b))]);
      }
    }
    size(): number {
      return this.buf.length;
    }
    toByteArray(): Uint8Array {
      return new Uint8Array(this.buf);
    }
    toString(cs?: unknown): string {
      return bytesToText(new Uint8Array(this.buf), cs ?? 'utf-8');
    }
    reset(): void {
      this.buf = Buffer.alloc(0);
    }
  }
  class ByteArrayInputStream {
    private buf: Uint8Array;
    private pos = 0;
    constructor(b?: unknown) {
      this.buf = toJavaBytes(b);
    }
    read(): number {
      return this.pos < this.buf.length ? this.buf[this.pos++]! : -1;
    }
    available(): number {
      return this.buf.length - this.pos;
    }
  }
  return { ByteArrayOutputStream, ByteArrayInputStream, ...makeJavaIoStreamNs() };
}

/* ---- java.util 集合（原 js.ts 实现迁移，避免两处漂移） ---- */
class JavaArrayList {
  private a: unknown[] = [];
  add(x: unknown): boolean { this.a.push(x); return true; }
  push(x: unknown): void { this.a.push(x); }
  size(): number { return this.a.length; }
  get(i: number): unknown { return this.a[i]; }
  isEmpty(): boolean { return this.a.length === 0; }
  toArray(): unknown[] { return this.a.slice(); }
  clear(): void { this.a = []; }
  toString(): string { return String(this.a); }
}
class JavaHashMap {
  private m = new Map<string, unknown>();
  put(k: unknown, v: unknown): unknown { const p = this.m.get(String(k)); this.m.set(String(k), v); return p; }
  get(k: unknown): unknown { return this.m.get(String(k)); }
  containsKey(k: unknown): boolean { return this.m.has(String(k)); }
  remove(k: unknown): unknown { const p = this.m.get(String(k)); this.m.delete(String(k)); return p; }
  size(): number { return this.m.size; }
  isEmpty(): boolean { return this.m.size === 0; }
  keySet(): string[] { return [...this.m.keys()]; }
}

/**
 * **类BZ（2026-10-26）`@js:` 返回 `java.util` 集合 ⇒ 必须展开成数组**。
 *
 * 上游权威语义（`AnalyzeRule.kt:453-500` `getElements`）：
 * ```kotlin
 * Mode.Js -> evalJS(rule, result)          // 返回 Rhino 的真 ArrayList
 * …
 * is List<*> -> { if (value.none{it==null}) return value as List<Any> … }
 * ```
 * Rhino 里 `new Packages.java.util.ArrayList()` **本身就是 `java.util.List`**，所以
 * `is List<*>` 命中 ⇒ 逐项成为「元素」。我们的 `JavaArrayList` 只是一个普通 class 实例
 * （`Array.isArray` 为 false），宿主既认不出也不会展开 ⇒ **整个列表塌成 1 个元素**。
 *
 * 实测（📚海棠搜书🔞蓝海搜书，`+@js:` 把 100 个 `<li>` 塞进 ArrayList）：
 * 页面 100 条、`getElements` 只回 1 条（`ctor=JavaArrayList`），
 * `getStringList` 更退化成 601 段字符串碎片 ⇒ 目录 0 章。
 *
 * 判据取**鸭子类型**：`toArray()` + `size()` 同时存在。这样 worker 侧同一份模板串
 * （`worker-pool.ts` 的 `__yueduSendable`）可以照抄同样的判断，而 vm realm 里跨上下文
 * 的实例（`instanceof` 为 false）也能命中。
 *
 * ## ⚠️ 必须先排除两类「也带 toArray+size」的非集合值（否则误伤，实测过两次）
 *  1. **jsoup 字符串人格**（`analyze.ts#strWithJsoup`）：它把 `new String(html)` 挂上 jsoup
 *     方法（含 `toArray()` / `size()`）再定义 `toString`/`Symbol.toPrimitive` 还原纯文本。
 *     一旦被当集合展开，返回值就变成 `[root]` 数组 ⇒ 字符串人格失效 ⇒ `String(result)`
 *     落回 `outerHTML` ⇒ 纯文本正文被包成 `<html><head></head><body>…</body></html>`
 *     且 `<img …{"style":…}>` 被重排成 `<img …{" style="…>`（HTML 序列化的典型指纹）。
 *     实测：`#583` 七猫段评（`uiMarks` 全丢、正文出现 `[图]`）。
 *  2. **jsoup 元素 / Elements 桥**（`nodeType` 是数字）：上游对它们走的是
 *     `is Elements` / `getElements` 的元素通道，不是 `is List` 的展开通道。
 */
export function expandJavaCollection(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  // 字符串人格（跨 realm 也适用：`[object String]` 对 String 包装是标准结果）
  if (Object.prototype.toString.call(v) === '[object String]') return v;
  const o = v as { toArray?: unknown; size?: unknown; nodeType?: unknown };
  if (typeof o.nodeType === 'number') return v;
  if (typeof o.toArray !== 'function' || typeof o.size !== 'function') return v;
  try {
    const arr = (o.toArray as () => unknown)();
    return Array.isArray(arr) ? arr : v;
  } catch {
    return v;
  }
}

/* ---- 包命名空间（Packages.xxx） ---- */
export function makeJavaPackages(): Record<string, unknown> {
  const specNs = makeSpecNs();
  const javaNs: Record<string, unknown> = {
    lang: {
      String: makeJString(),
      Integer: { parseInt: (s: unknown) => parseInt(String(s), 10) || 0, valueOf: (s: unknown) => parseInt(String(s), 10) || 0 },
      System: systemNs(),
      Thread: threadNs(),
    },
    util: {
      ArrayList: JavaArrayList,
      HashMap: JavaHashMap,
      List: JavaArrayList,
      Map: JavaHashMap,
      /** `#605`：`java.util.zip.GZIPInputStream`（番茄系 hpost 解压；见 java-net.ts） */
      zip: makeJavaZipNs(),
      Arrays: {
        asList: (a: unknown) => (Array.isArray(a) ? a : [a]),
        toString: (a: unknown) => String(a),
        // 真字节切片（七猫四合一 qmDecryptChapterBytes 依赖其 .length 与再切片）
        copyOfRange: (b: unknown, from: unknown, to: unknown): Uint8Array => {
          const bytes = toJavaBytes(b);
          const f = Math.max(0, Number(from) || 0);
          const t = Math.min(bytes.length, Number(to) || 0);
          return f >= t ? new Uint8Array(0) : bytes.subarray(f, t);
        },
        copyOf: (b: unknown, n: unknown): Uint8Array => {
          const bytes = toJavaBytes(b);
          const len = Math.max(0, Number(n) || 0);
          const out = new Uint8Array(len);
          out.set(bytes.subarray(0, Math.min(len, bytes.length)));
          return out;
        },
      },
      UUID: { randomUUID: () => ({ toString: () => (globalThis.crypto?.randomUUID?.() ?? '') }) },
      Base64: {
        getEncoder: () => ({ encodeToString: (s: unknown) => Buffer.from(toJavaBytes(s)).toString('base64') }),
        getUrlEncoder: () => ({ encodeToString: (s: unknown) => Buffer.from(toJavaBytes(s)).toString('base64url') }),
        getDecoder: () => ({ decode: (s: unknown): Uint8Array => new Uint8Array(Buffer.from(String(s ?? ''), 'base64')) }),
        getUrlDecoder: () => ({ decode: (s: unknown): Uint8Array => new Uint8Array(Buffer.from(String(s ?? ''), 'base64url')) }),
      },
    },
    security: {
      MessageDigest: makeMessageDigestNs(),
      SecureRandom: makeSecureRandomCtor(),
    },
    io: makeIoNs(),
    /** `#605`：`new Packages.java.net.URL(u).openConnection()`（番茄系 / 花花短剧 6 源） */
    net: makeJavaNetNs(nest),
    nio: {
      ByteBuffer: {
        allocate: (n: unknown) => {
          const buf = Buffer.alloc(Number(n) || 0);
          return { put: (b: unknown) => { Buffer.from(toJavaBytes(b)).copy(buf); return buf; }, array: () => new Uint8Array(buf), toString: () => bytesToText(new Uint8Array(buf)) };
        },
      },
    },
  };
  const javaxNs: Record<string, unknown> = { crypto: { Cipher: makeCipherNs(), spec: specNs } };
  const androidNs: Record<string, unknown> = {
    /**
     * `Packages.android.graphics`（2026-09-24 新增）—— 图片切条还原（禁漫天堂等漫画源）。
     * 实现见 `android-graphics.ts`；**只在 L1 可用**（用到 Node 侧的 JPEG/PNG 编解码器）。
     */
    graphics: makeAndroidGraphicsNs(),
    util: {
      Base64: {
        decode: (input: unknown, _flags?: unknown): Uint8Array => new Uint8Array(Buffer.from(String(input ?? ''), 'base64')),
        encode: (input: unknown, _flags?: unknown): Uint8Array => new Uint8Array(Buffer.from(Buffer.from(toJavaBytes(input)).toString('base64'), 'base64')),
        encodeToString: (input: unknown, _flags?: unknown): string => Buffer.from(toJavaBytes(input)).toString('base64'),
        NO_WRAP: 2,
        DEFAULT: 0,
      },
    },
    text: {
      TextUtils: { isEmpty: (s: unknown) => s == null || String(s).length === 0 },
    },
  };
  // StrResponse（loginCheckJs 重建响应用，沿用原实现语义）
  const StrResponseCtor = function StrResponse(u?: unknown, b?: unknown, c?: unknown) {
    // 延迟引用避免循环依赖：由 wire 处注入真实 makeStrResponse
    return strResponseFactory!(String(u ?? ''), b == null ? '' : String(b), typeof c === 'number' ? c : 200);
  };
  const ioLegadoNs: Record<string, unknown> = {
    legado: {
      app: { help: { http: { StrResponse: StrResponseCtor, StrResponseKt: StrResponseCtor } } },
      kazusa: { utils: { TimeoutCancellationException: function TimeoutCancellationException(msg?: unknown) { return new Error(String(msg ?? 'TimeoutCancellationException')); } } },
    },
  };
  const cnNs: Record<string, unknown> = deepNsProxy(makeHutoolNs(), 'cn');
  return new Proxy(
    { java: javaNs, javax: javaxNs, android: androidNs, okhttp3: makeOkhttp3Ns(), io: ioLegadoNs, cn: cnNs } as Record<string, unknown>,
    // 顶级未实现包（`Packages.xxx`）同样留痕兜底
    { get: (t, prop: string) => (prop in t ? t[prop] : (warnMissingJavaClass(prop), nest(prop))) },
  );
}

/**
 * `#605` `java.net.URL` / `HttpURLConnection` 与配套流（`BufferedReader` 等）。
 * 实现见 `java-net.ts`（上游是真 JDK 类；番茄系手写 HTTP 客户端整条链都压在这几个类上）。
 */
import { makeJavaNetNs, makeJavaIoStreamNs, makeJavaZipNs } from './java-net';

/** StrResponse 工厂注入点（由 js.ts wire，避免循环 import） */
export let strResponseFactory: ((url: string, body: string, code: number) => unknown) | null = null;
export function wireStrResponseFactory(f: (url: string, body: string, code: number) => unknown): void {
  strResponseFactory = f;
}

/**
 * `#538` okhttp3 桥的**同步传输**注入点（由 js.ts wire）。
 * 复用 L1 唯一同步出口 `syncHttp` ⇒ 与 `java.ajax` 同一条：源级默认头 / 闸页静默过闸 /
 * 同步预算 / 超时自动一致，不另起第二条 HTTP 通道（`#529` jsoup 桥同纪律）。
 *
 * ⚠️ 字节保真边界：`syncHttp` 是**字符串契约**（utf8 解码）⇒ L1 侧 `body().bytes()`
 * 对二进制响应是 best-effort；生产路径（worker）走 raw 模式**字节保真**
 * （见 `sandbox/worker-pool.ts` 的 `#538`）。文本响应两条路逐字一致。
 */
export type OkhttpTransport = (
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
) => { body: string; code: number; headers: Record<string, string> };
let okhttpTransport: OkhttpTransport | null = null;
export function wireOkhttpTransport(f: OkhttpTransport): void {
  okhttpTransport = f;
}

/**
 * `#538` okhttp3 桥（L1 侧；收口 `#473` 剩余 3 源：阅文集团 / 大灰狼聚合 / 木里聚合）。
 * API 面 = 语料实测最小集，与 worker 侧（`sandbox/worker-pool.ts` 的 `okhttp3Ns`）逐项对齐。
 */
export function makeOkhttp3Ns(): Record<string, unknown> {
  function transport(method: string, url: string, body: string | undefined, headers: Record<string, string>) {
    if (!okhttpTransport) throw new Error('okhttp3: 同步传输未注入（wireOkhttpTransport 未被调用）');
    return okhttpTransport(method, url, body, headers);
  }
  const MediaType = {
    parse: (s: unknown) => ({ __mediaType: String(s ?? '') }),
  };
  function RequestBody(this: Record<string, unknown>, content: unknown, contentType: unknown) {
    const self = this instanceof RequestBody ? this : ({} as Record<string, unknown>);
    self.__content = content == null ? '' : content;
    self.__contentType =
      contentType && typeof contentType === 'object' && '__mediaType' in contentType
        ? String((contentType as { __mediaType?: unknown }).__mediaType ?? '')
        : String(contentType ?? '');
    return self;
  }
  RequestBody.create = (content: unknown, contentType: unknown) => new (RequestBody as unknown as new (c: unknown, t: unknown) => Record<string, unknown>)(content, contentType);

  function Request(this: Record<string, unknown>, u: unknown) {
    const self = this instanceof Request ? this : ({} as Record<string, unknown>);
    self.__url = String(u ?? '');
    self.__method = 'GET';
    self.__body = null as Record<string, unknown> | null;
    self.__headers = {} as Record<string, string>;
    return self;
  }
  function RequestBuilder(this: Record<string, unknown>) {
    const self = this instanceof RequestBuilder ? this : ({} as Record<string, unknown>);
    self.__r = new (Request as unknown as new (u: unknown) => Record<string, unknown>)('');
    return self;
  }
  const rp = (b: Record<string, unknown>): Record<string, unknown> => b.__r as Record<string, unknown>;
  RequestBuilder.prototype.url = function (this: Record<string, unknown>, u: unknown) { rp(this).__url = String(u ?? ''); return this; };
  RequestBuilder.prototype.get = function (this: Record<string, unknown>) { const r = rp(this); r.__method = 'GET'; r.__body = null; return this; };
  RequestBuilder.prototype.post = function (this: Record<string, unknown>, body: unknown) {
    const r = rp(this);
    r.__method = 'POST';
    r.__body = body instanceof RequestBody ? (body as unknown as Record<string, unknown>) : (RequestBody as unknown as { create: (c: unknown, t: unknown) => Record<string, unknown> }).create(body, null);
    return this;
  };
  RequestBuilder.prototype.put = function (this: Record<string, unknown>, body: unknown) {
    const r = rp(this);
    r.__method = 'PUT';
    r.__body = body instanceof RequestBody ? (body as unknown as Record<string, unknown>) : (RequestBody as unknown as { create: (c: unknown, t: unknown) => Record<string, unknown> }).create(body, null);
    return this;
  };
  RequestBuilder.prototype.addHeader = function (this: Record<string, unknown>, k: unknown, v: unknown) {
    (rp(this).__headers as Record<string, string>)[String(k)] = String(v ?? '');
    return this;
  };
  RequestBuilder.prototype.header = function (this: Record<string, unknown>, k: unknown, v: unknown) { return (this as unknown as { addHeader: (a: unknown, b: unknown) => unknown }).addHeader(k, v); };
  RequestBuilder.prototype.headers = function (this: Record<string, unknown>, m: unknown) {
    if (m && typeof m === 'object') for (const [k, v] of Object.entries(m as Record<string, unknown>)) (rp(this).__headers as Record<string, string>)[k] = String(v ?? '');
    return this;
  };
  RequestBuilder.prototype.build = function (this: Record<string, unknown>) { return rp(this); };
  (Request as unknown as { Builder: unknown }).Builder = RequestBuilder;

  function ResponseBody(this: Record<string, unknown>, text: string) {
    const self = this instanceof ResponseBody ? this : ({} as Record<string, unknown>);
    self.__text = text == null ? '' : String(text);
    return self;
  }
  ResponseBody.prototype.string = function (this: Record<string, unknown>) { return this.__text; };
  ResponseBody.prototype.bytes = function (this: Record<string, unknown>) {
    // L1 字符串契约：utf8 文本的字节视图（二进制响应保真见 worker 侧 raw 模式）
    return new Uint8Array(Buffer.from(String(this.__text), 'utf8'));
  };

  function Response(this: Record<string, unknown>, code: number, headers: Record<string, string>, text: string) {
    const self = this instanceof Response ? this : ({} as Record<string, unknown>);
    self.__code = Number(code) || 0;
    self.__headers = headers || {};
    self.__body = new (ResponseBody as unknown as new (t: string) => Record<string, unknown>)(text);
    return self;
  }
  Response.prototype.code = function (this: Record<string, unknown>) { return this.__code; };
  Response.prototype.message = function () { return ''; };
  Response.prototype.isSuccessful = function (this: Record<string, unknown>) { const c = Number(this.__code) || 0; return c >= 200 && c < 300; };
  Response.prototype.body = function (this: Record<string, unknown>) { return this.__body; };
  Response.prototype.header = function (this: Record<string, unknown>, name: unknown) {
    const hs = (this.__headers || {}) as Record<string, string>;
    const lower = String(name ?? '').toLowerCase();
    for (const k of Object.keys(hs)) if (k.toLowerCase() === lower) return hs[k];
    return null;
  };

  function Call(this: Record<string, unknown>, request: Record<string, unknown>) {
    const self = this instanceof Call ? this : ({} as Record<string, unknown>);
    self.__req = request;
    return self;
  }
  Call.prototype.execute = function (this: Record<string, unknown>) {
    const req = this.__req as Record<string, unknown>;
    const headers = { ...(req.__headers as Record<string, string>) };
    const body = req.__body as Record<string, unknown> | null;
    if (body && body.__contentType && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = String(body.__contentType);
    const r = transport(String(req.__method), String(req.__url), body ? (body.__content == null ? '' : String(body.__content)) : undefined, headers);
    return new (Response as unknown as new (c: number, h: Record<string, string>, t: string) => Record<string, unknown>)(r.code, r.headers, r.body);
  };
  function OkHttpClient(this: Record<string, unknown>) { return this instanceof OkHttpClient ? this : {}; }
  OkHttpClient.prototype.newCall = function (this: Record<string, unknown>, request: unknown) {
    return new (Call as unknown as new (r: unknown) => Record<string, unknown>)(request);
  };

  // HttpUrl：eTLD+1 启发式（小后缀表 + 默认末二段）—— 与 worker 侧同一张表
  const MULTI_SUFFIX = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'co.uk', 'org.uk', 'ac.uk', 'co.jp', 'com.jp', 'com.hk', 'com.tw', 'com.au', 'co.kr'];
  const topPrivateDomain = (host: unknown): string => {
    const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
    if (!h) return '';
    const parts = h.split('.');
    if (parts.length <= 2) return h;
    const last2 = parts.slice(-2).join('.');
    const last3 = parts.slice(-3).join('.');
    if (MULTI_SUFFIX.includes(last2)) return parts.length >= 3 ? last3 : h;
    if (MULTI_SUFFIX.includes(last3) && parts.length >= 4) return parts.slice(-4).join('.');
    return last2;
  };
  function HttpUrl(this: Record<string, unknown>, u: unknown) {
    const self = this instanceof HttpUrl ? this : ({} as Record<string, unknown>);
    const s = String(u ?? '');
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(s);
    const authority = m && m[1] ? m[1] : '';
    self.__u = s;
    self.__host = authority ? (authority.split('@').pop() ?? '').split(':')[0] ?? '' : '';
    return self;
  }
  HttpUrl.parse = (u: unknown) => new (HttpUrl as unknown as new (u: unknown) => Record<string, unknown>)(u);
  HttpUrl.prototype.host = function (this: Record<string, unknown>) { return this.__host; };
  HttpUrl.prototype.topPrivateDomain = function (this: Record<string, unknown>) { return topPrivateDomain(this.__host); };
  HttpUrl.prototype.scheme = function (this: Record<string, unknown>) { const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(String(this.__u)); return m && m[1] ? m[1].toLowerCase() : ''; };
  HttpUrl.prototype.queryParameter = function (this: Record<string, unknown>, name: unknown) {
    const q = /\?([^#]*)/.exec(String(this.__u));
    const qs = q && q[1] ? q[1] : '';
    if (!qs) return null;
    for (const pair of qs.split('&')) {
      const kv = pair.split('=');
      if (kv[0] !== undefined && decodeURIComponent(kv[0].replace(/\+/g, ' ')) === String(name)) {
        return kv.length > 1 ? decodeURIComponent(kv.slice(1).join('=').replace(/\+/g, ' ')) : '';
      }
    }
    return null;
  };
  HttpUrl.prototype.toString = function (this: Record<string, unknown>) { return String(this.__u); };

  return {
    OkHttpClient,
    Request,
    RequestBody,
    MediaType,
    Response,
    ResponseBody,
    Call,
    HttpUrl,
  };
}

/**
 * JavaImporter：`importPackage(pkg)` 把包对象的 own 属性挂到 importer 自身 ——
 * `with (importer) { 裸类名 }` 便经 with 作用域解析到这些属性（Rhino 语义）。
 */
export function makeJavaImporterCtor(): unknown {
  const attach = (target: Record<string, unknown>, pkg: unknown): void => {
    if (pkg == null || typeof pkg !== 'object') return;
    for (const k of Object.keys(pkg as Record<string, unknown>)) {
      if (target[k] == null) target[k] = (pkg as Record<string, unknown>)[k];
    }
  };
  /**
   * `#691` **`importClass` 必须存在**（Rhino 的 `JavaImporter` 实例同时有
   * `importPackage` 与 `importClass` 两个方法）。
   *
   * 实测（自用极品书源 珍藏版 的 jsLib）：它按大类名逐个导入，写法是
   * ```js
   * var javaImport = CompatibilityUtils.safeImport(new JavaImporter());
   * with(javaImport) { … }
   * // safeImport 内部：javaImport.importClass(eval('Packages.' + className))
   * ```
   * 我们此前只给了 `importPackage` ⇒ `importClass is not a function` ⇒ 它的 catch 打出
   * 一片 `[legado-js] 无法导入类: android.util.Base64 / java.lang.String / java.net.URL /
   * okhttp3.HttpUrl`，`with` 作用域里一个类都没绑上（后面一用就 `is not defined`）。
   *
   * 语义按 Rhino：把类的**简单名**绑到作用域。名字来源三种（按可靠性排序）：
   * ① 传字符串（`'java.lang.String'`）；② 类对象自带 `__yueduClassName` / `getName()`；
   * ③ 退化成对象上的 `name`/`displayName`。都不认识就**静默跳过** ——
   * 与 Rhino 抛 `TypeError` 不同，这里选择不打断脚本（源普遍用 try/catch 包着，抛了反而多一层日志）。
   */
  function classSimpleName(cls: unknown): string {
    if (typeof cls === 'string') return cls.split('.').pop() ?? '';
    if (cls && typeof cls === 'object') {
      const o = cls as Record<string, unknown>;
      const declared = o['__yueduClassName'];
      if (typeof declared === 'string' && declared) return declared.split('.').pop() ?? '';
      const gn = o['getName'];
      if (typeof gn === 'function') {
        try {
          const n = String((gn as () => unknown).call(cls));
          if (n) return n.split('.').pop() ?? '';
        } catch {
          /* 忽略：某些类的 getName 需要参数 */
        }
      }
    }
    const asFn = cls as { name?: string; displayName?: string };
    if (typeof asFn?.name === 'string' && asFn.name && asFn.name !== 'anonymous') return asFn.name;
    if (typeof asFn?.displayName === 'string' && asFn.displayName) return asFn.displayName;
    return '';
  }
  function JavaImporter(this: Record<string, unknown>, ...pkgs: unknown[]) {
    const self: Record<string, unknown> = this instanceof JavaImporter ? this : {};
    self.importPackage = (...more: unknown[]): void => {
      for (const p of [...pkgs, ...more]) attach(self, p);
    };
    self.importClass = (cls: unknown): void => {
      const name = classSimpleName(cls);
      if (!name) return;
      /**
       * 传**字符串**时（`importClass('java.lang.String')`）只给个字符串毫无用处 ——
       * Rhino 里它绑的是类。我们的 `Packages.java.lang.String` 这类宿主垫片是**同名全局**
       * 的包装（`String` / `URL` / `Base64`），因此按名字回落到 `globalThis[name]`；
       * 找不到就静默跳过（宁可少绑，也不绑一个「一用就炸」的字符串）。
       */
      if (typeof cls === 'string') {
        const g = (globalThis as Record<string, unknown>)[name];
        if (g !== undefined) self[name] = g;
        return;
      }
      self[name] = cls;
    };
    for (const p of pkgs) attach(self, p);
    return self;
  }
  return JavaImporter;
}

/**
 * 路由守卫：用到 Java 类桥的**整段脚本**（`lib`(jsLib) + `code`）必须留在 L1。
 *
 * ① 为什么连 `lib` 一起判：语言的类引用与调用是分开的——四合一/聚合类源把
 *    `JavaImporter`/`Packages.javax.crypto.*` 全写在 **jsLib** 里，规则代码只有一句
 *    `qmReadContent.call(this, result, baseUrl)`（语料实测：11 源桥在 jsLib、其中 7 源
 *    规则代码里一个字都看不到）。只看 `code` → 判不中 → 落 worker → 类桩缺失 → 静默失败。
 * ② 为什么**不能**简单窄化成「有 `Packages.` 就回 L1、否则 worker」：语料里同批源混用
 *    `cn.hutool.core.codec.Base64` / `io.legado.app.help.http.StrResponse` 等 worker 桩**没有**的名字，
 *    窄化会把它们从「可用」变成「静默返回 ''」。⇒ 见下方 `needsJavaBridgeL1()`：
 *    **只放行「worker 与 L1 逐项比对过、成员语义完全一致」的那几个命名空间**，其余一律留 L1。
 *    ⚠️ 本注释 2026-09-29（`#158`）修订过一次：原文写着「`java.lang.Thread.sleep` 是 worker 桩没有的名字」，
 *    但 worker 侧**后来补上了** `lang.Thread`（`worker-pool.ts:916`，为 ⚡📂️独阅读网 补的）——
 *    **那个前提已经过期**，于是 Linpx 等 6 个源被一条不再成立的理由长期锁在 L1 上。
 * ③ 代价（保留）：L1 的 `java.ajax` 走 `execFileSync` curl，会阻塞事件循环；
 *    jsLib 内同时有 `java.ajax` 的源（实测 3 个：微信读书二合一 / 大灰狼聚合 / 木里聚合）
 *    会因此变慢 —— 但它们在 worker 里本来就是**失败**的，先要正确性。
 *    彻底解法见挂账「worker 侧 Java 桥补全」。
 * ④ `android.graphics`（2026-09-24 补）：`Bitmap`/`BitmapFactory`/`Canvas` 的实现在
 *    `android-graphics.ts`，**依赖 Node 侧的 JPEG/PNG 编解码器 ⇒ 只在 L1 存在**。
 *    故把这三个裸类名也纳入判定：否则脚本若写成 `BitmapFactory.decodeByteArray(...)`
 *    （不带 `Packages.`/`JavaImporter` 前缀）会落 worker → 类桩缺失 → **静默回原图**。
 *    影响面极小：语料里只有 🎨🔞禁漫天堂 1 个源用这几个名字。
 *
 * ⚠️ **路由判定请用 `needsJavaBridgeL1()`**；本正则保留只作「硬桥/宽口径」的显式名单，
 *    直接拿它做判定会把 `Packages.java.lang.Thread` 也锁进 L1（即 `#158` 修掉的那个问题）。
 */
export const JAVA_BRIDGE_RE = /\bJavaImporter\b|\bPackages\s*\.|\bBitmapFactory\b|\bCanvas\b|\bBitmap\b/;

/**
 * worker 侧**已实现、且与 L1 的成员语义逐项一致**的 `Packages.*` 命名空间（`#158`，2026-09-29）。
 *
 * ## 白名单为什么这么窄
 * worker 的 `javaNs` 是**手写桩**，L1 的是**另一份手写实现** —— 两边会漂移。判据是
 * 「**worker 覆盖 L1 的全部成员且语义相同**」，缺一个成员就会从「L1 能跑」变成
 * worker 里的 `undefined is not a function`（更糟的是未知成员会落到 `nest()` 的空串工厂 ⇒ **静默**）。
 * 逐项比对结果（L1 = `java-bridge.ts:500-537`，worker = `worker-pool.ts:880-925`）：
 *
 * | 命名空间 | 结论 |
 * |---|---|
 * | `lang.Thread`  | ✅ worker 是 L1 的**超集**（`sleep` 同语义：worker 内真睡、上限 3s + `currentThread`） |
 * | `lang.System`  | ✅ 四个成员（`currentTimeMillis`/`nanoTime`/`lineSeparator`/`getProperty`）**完全一致** |
 * | `lang.Integer` | ❌ worker 缺 `valueOf` |
 * | `lang.String`  | ❌ 语义不同：L1 的 `makeJString()` 有 `getBytes/length/charAt`…；worker 那个只当 base64 解码用 |
 * | `util.Arrays`  | ❌ worker 缺 `copyOfRange`/`copyOf` |
 * | `util.Base64`  | ❌ worker 缺 `getUrlEncoder`/`getUrlDecoder` |
 * | `util.UUID`    | ❌ 返回类型不同（L1 给 `{toString()}`，worker 给字符串） |
 * | `util.ArrayList` / `HashMap` / `List` / `Map` | ❌ 成员集未逐项对齐（L1 是完整类） |
 *
 * ## 量级（`data/sources/book-482`，485 源，2026-09-29 实测）
 * 硬桥（`JavaImporter`/`Bitmap`/`Canvas`）必须 L1 的 **11 源**；
 * 仅因 `Packages.` 被推回 L1 的 **21 源**；其中**本白名单可放行 6 源**：
 * ⚡📂️独阅读网 · 🔞兽人小说站 · 🔞 Linpx · 🏷晋江文学 · ⚡📂清风小说网 · 📂书文小说。
 * （另 2 源 🏷书旗小说 / 📚海棠搜书 只有**宽**白名单才放行，成员集不一致 ⇒ **刻意不放**。）
 *
 * ## 收益
 * ① 这些源的 `java.ajax` 改走 **worker 的 RPC**（宿主异步 fetch）⇒ **不再依赖本机能否 spawn curl**
 *    （见 `#159`：本机 `execFileSync('curl')` 恒 `EBUSY` 时，L1 的 `java.ajax` 全空）。
 * ② 不再阻塞宿主事件循环（Phase 0.1 的性能坑）。
 */
const WORKER_EQUIVALENT_NS_RE = /Packages\s*\.\s*java\s*\.\s*lang\s*\.\s*(?:Thread|System)\b/g;

/**
 * 该脚本（`lib + code`）是否**必须**留在 L1（进程内）求值。
 *
 * 与旧的 `JAVA_BRIDGE_RE.test()` 相比：只把「worker 已实现且语义一致」的 `Packages.java.lang.{Thread,System}`
 * 从判定里排除，其余一切照旧。
 *
 * ⚠️ 替换成 `'__worker_ok__'`（**不带 `Packages.`**）—— 若替换成含 `Packages.` 的字样，
 * 后面的检查会立刻又命中自己（这个坑很隐蔽）。
 */
/**
 * `#500` **worker 已实现的 `Packages.` 路径前缀表**。
 *
 * ⚠️ 必须与 `sandbox/packages-ns.ts` 的 `IMPL` 表**同步维护**：这里放行的源会进 worker 求值，
 * 那边没实现 ⇒ 静默空串（有 warn 留痕，但功能等于坏）。加路径时两边一起加，并注明是哪个源的需要。
 * 覆盖范围按「语料高频」选：hutool 摘要/编码（qm 系签名）· java.lang/util 常用 ·
 * javax.crypto（AES/DES）· android.util.Base64 · Uri/URL 编解码。
 */
export const WORKER_PACKAGES_PREFIXES: readonly string[] = [
  /* —— `#501` P0-1a-2：按「逐源缺口分析」扩展（每行注释 = 该路径能解放几个源）—— */
  'cn.hutool.crypto.digest.DigestUtil',
  'cn.hutool.core.codec.Base64',
  'cn.hutool.core.util.CharsetUtil',
  'cn.hutool.core.util.HexUtil',
  'cn.hutool.core.util.StrUtil',
  /* java.lang.*（#501 已与宿主对齐：String 双语义 / Integer / Long / System / Thread / StringBuilder） */
  // ⚠️ 裸 'java' 也要放行：源里常见特性检测 `!!Packages.java`（纸间）；worker 的 java 树覆盖
  //    lang/util/security/math/nio/io/net/zip，未知子路径走 nest() 空串 —— 与宿主 makeJavaPackages
  //    对未知包的「空串 + warn」同语义，不会更差。
  'java',
  'java.lang.String', // +16 源
  'java.lang.Integer',
  'java.lang.Long',
  'java.lang.System',
  'java.lang.Thread',
  'java.lang.StringBuilder', // +5 源
  'java.util.Base64',
  'java.util.Arrays',
  'java.util.HashMap',
  'java.util.UUID', // #501 worker 已改为返回 {toString()} 对象（对齐宿主）
  'java.util.zip.GZIPInputStream',
  'java.util.zip.GZIPOutputStream',
  'java.util.zip.Inflater',
  'java.util.zip.InflaterInputStream',
  'java.security.MessageDigest', // +12 源
  'java.security.SecureRandom', // +5 源
  'java.math.BigInteger', // +4 源
  'java.nio.charset.Charset',
  'java.nio.ByteBuffer',
  'java.io.ByteArrayOutputStream', // +7 源
  'java.io.ByteArrayInputStream',
  'java.io.BufferedReader', // +7 源
  'java.io.InputStreamReader', // +7 源
  'java.net.URL', // +4 源
  'java.net.InetAddress', // +4 源
  'java.net.Socket',
  'java.net.InetSocketAddress',
  'java.net.URLEncoder',
  'java.net.URLDecoder',
  'javax.crypto.Cipher',
  'javax.crypto.spec.SecretKeySpec',
  'javax.crypto.spec.GCMParameterSpec', // +2 源（AEAD）
  'javax.crypto.spec.IvParameterSpec',
  // #526 包级条目：`with(JavaImporter)` 里常写「包名」而非类名（七猫/茄子/星空都用
  // `importPackage(Packages.javax.crypto.spec)`），类级前缀匹配不上 ⇒ 会白锁 L1。
  'javax.crypto.spec',
  'javax.crypto',
  'javax.net.ssl.SSLSocketFactory', // +4 源
  'android.util.Base64',
  'android.net.Uri',
  'android.text.TextUtils',
  // #526 worker 侧 android.graphics 已由 rpc('bitmap') 回宿主实现（与 L1 同一份像素代码）
  'android.graphics',
  // ⚠️ 两种拼写都真实存在：io.legado（官方，1 源）+ io.legato（社区常见拼错，5 源）⇒ 两条都挂
  'io.legado.kazusa.utils.TimeoutCancellationException',
  'io.legato.kazusa.utils.TimeoutCancellationException',
  // 包级条目：源里常写到「包名」而非类名（如 cn.hutool.core.util），类级前缀匹配不上
  'cn.hutool.core.util',
  'cn.hutool.core.codec',
  'cn.hutool.crypto.digest',
  'cn.hutool.crypto',
  'javax.crypto.Mac', // +1 源（HMAC）
  /* `#522` **org.jsoup**（语料 10 源）：worker 侧早有 `__ORG_NS` / `__yueduJsoup`（与 L1 同一份 Jsoup
     语义，DOM 经 `rpc('dom')` 回宿主），此前**前缀表缺这几条** ⇒ 源白锁 L1（主线程同步）。
     只放行**已实现/已对齐**的路径：`Jsoup.parse` · `Jsoup` · `nodes.Document` · `nodes.Element` ·
     `parser.Parser`（`unescapeEntities` 经 `rpc('dom','unescapeEntities')` 回宿主用 commons-text 表解码）。
     ⚠️ **`Jsoup.connect` 刻意不放**（HTTP 客户端语义，两侧都未实现）—— 相关源继续留 L1（保守：宁留也不静默半残）。
     ⚠️ 已核语料：无 `Packages.org.jsoup.Jsoup.connect` / `.parseBodyFragment` 写法 ⇒ 放行裸 `org.jsoup.Jsoup`
     不会把 connect 源误送进 worker。 */
  'org.jsoup.Jsoup.parse',
  'org.jsoup.Jsoup',
  'org.jsoup.nodes.Document',
  'org.jsoup.nodes.Element',
  'org.jsoup.parser.Parser',
  /* `#528` `org.jsoup.select.Elements`（找书啦·求书互助）：两侧均已实现
     （`new Elements()` + `add(el)`；`Element.clone()`/`text(写)`/`child(i)`/`Jsoup.parseBodyFragment` 同批补齐）。 */
  'org.jsoup.select.Elements',
  /* `#529` `org.jsoup.Connection.Method.*`（Aff：`connect(...).method(Connection.Method.DELETE)`）。
     `Jsoup.connect` 本身已被 `org.jsoup.Jsoup` 前缀覆盖；两侧实现见 `makeJsoupConnection` / `makeWorkerJsoupConnection`。 */
  'org.jsoup.Connection',
  /* `#522` **io.legado.app.help.http.StrResponse**（语料 4 源：爱丽丝书屋×3 / 点众阅读 / 聚合书库）：
     worker 侧已补 ctor（复用本文件的 `strResponse`，与 `java.ajax` 同一条 HTTP 语义），
     与宿主 `StrResponseCtor` 同面。⚠️ **只放行 StrResponse**：`…http.CookieStore.setCookie`
     等其它子路径仍未实现 ⇒ 前缀不覆盖它们，用它们的源继续留 L1。 */
  'io.legado.app.help.http.StrResponse',
  'io.legado.app.help.http.StrResponseKt',
  /* `#538` **okhttp3**（收口 #473 剩余 3 源：阅文集团 / 大灰狼聚合 / 木里聚合）：
     worker 侧 `okhttp3Ns` + L1 侧 `makeOkhttp3Ns()` 同面（传输各复用本侧同步 HTTP 出口）。
     覆盖 `importPackage(Packages.okhttp3)`（阅文/木里）与 `eval('Packages.okhttp3.HttpUrl')`
     （大灰狼的 hasJavaClass 守卫形态）两种写法。 */
  'okhttp3',
];


/**
 * `#500` 脚本里出现的全部 `Packages.<路径>` 字面量（去空白）。
 * 只认**字面量**——动态拼接（`Packages[xxx]`）不在此列，那种源继续留 L1（保守）。
 */
function packagesPaths(libPlusCode: string): string[] {
  const out: string[] = [];
  const re = /\bPackages\s*\.\s*([\w$]+(?:\s*\.\s*[\w$]+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(libPlusCode)) !== null) out.push((m[1] ?? '').replace(/\s+/g, ''));
  return out;
}

/**
 * `#526` **硬桥开关**（回退用）：`YUEDU_WORKER_HARDBRIDGE=0` ⇒ 退回「JavaImporter / Bitmap 一律 L1」。
 * 口径同 `#509` 的 `YUEDU_JS_LIBSCOPE`：架构级改动必须带一键回退，且默认值是**新行为**。
 */
function workerHardBridgeOff(): boolean {
  return String(process.env.YUEDU_WORKER_HARDBRIDGE ?? '1') === '0';
}

/**
 * `#526` **`with (JavaImporter)` 作用域可安全放行的命名空间**。
 *
 * 判据仍是老规矩「worker 覆盖 L1 的全部成员且语义相同」，只是一个能静态判定的近似：
 * `importPackage` 之后裸类名走 with 作用域，静态看不到用了哪个类 ⇒ 只能按**命名空间**兜。
 * 因此名单刻意只收「worker 侧是完整实现、缺成员概率极低」的包：
 *
 * | 命名空间 | worker 侧实现 |
 * |---|---|
 * | `java.lang` | String / Integer / Long / StringBuilder / System / Thread（#508 已与宿主逐项对齐） |
 * | `java.util` | Base64 / Arrays / ArrayList / HashMap / List / Map / UUID / zip（**不全**，故配下方 deny 名单） |
 * | `java.io` | ByteArrayOutputStream / ByteArrayInputStream / BufferedReader / InputStreamReader |
 * | `java.security` | MessageDigest / SecureRandom |
 * | `javax.crypto`(+`.spec`) | Cipher（AES/DES/ChaCha）+ SecretKeySpec / IvParameterSpec / GCMParameterSpec |
 * | `android.util` / `android.text` | Base64 / TextUtils |
 * | `android.graphics` | #526 起由 rpc('bitmap') 回宿主，与 L1 同一份实现 |
 * | `cn.hutool.*` | digest.DigestUtil / codec.Base64 / util.{CharsetUtil,HexUtil,StrUtil} |
 *
 * **刻意不收**：`java.util.concurrent` / `java.security.spec` / `java.security.interfaces` /
 * `java.net`（成员集不全）/ `okhttp3`（整层 HTTP 客户端语义，挂账待排）。
 * 语料实测：海棠搜书（concurrent）、西瓜小说（security.spec）、乐读（security.interfaces）、
 * 阅文/木里（okhttp3）因此**继续留 L1** —— 这不是漏做，是「宁留 L1 也不静默半残」。
 */
const WORKER_WITH_SAFE_NS: readonly string[] = [
  'java.lang',
  'java.util',
  'java.io',
  'java.security',
  'javax.crypto',
  'javax.crypto.spec',
  'android.util',
  'android.text',
  'android.graphics',
  'cn.hutool.core.codec',
  'cn.hutool.core.util',
  'cn.hutool.crypto',
  // `#538` okhttp3 桥（worker/L1 两侧同面）⇒ 收口 #473 剩余 3 源（阅文/大灰狼/木里）
  'okhttp3',
];

/**
 * `#526` **显式黑名单**：安全名单是**前缀**匹配（`java.util` 会顺带放行 `java.util.zip` 这类
 * 真子包），但下面这些是**独立的 Java 包**、worker 里没有实现 ⇒ 必须先一步否掉，
 * 否则 `java.util.concurrent` 会被 `java.util` 顺带放行（源从「L1 能跑」变成 worker 里报错）。
 */
const WORKER_WITH_UNSAFE_NS: readonly string[] = [
  'java.util.concurrent',
  'java.util.concurrent.atomic',
  'java.util.concurrent.locks',
  'java.util.stream',
  'java.security.spec',
  'java.security.interfaces',
  'java.security.cert',
  'javax.crypto.interfaces',
  'okio',
];

/**
 * `#526` 抽出 `with (importer) { … }` 的**花括号正文**（可能多段）。
 *
 * 为什么必须限定作用域：反向安全网（下面的 deny 名单）若在**整段脚本**上跑会被
 * `new Date()` / `Math.random()` 这类**纯 JS 写法**误伤（七猫 3.9.61 的 jsLib 里就有
 * `new Date().getTime()`）⇒ 源被一条不成立理由锁在 L1（正是 `#158` 修过的那类问题）。
 * 只有落在 with 正文里的裸名才可能被 with 作用域解析成 Java 类。
 */
function withBodies(src: string): string {
  // 跳过字符串字面量再找 "with (" —— 免得把正则/字符串里的 with 当真
  const lines: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i += 1;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (src.startsWith('with', i) && /^with\s*\(/.test(src.slice(i))) {
      const open = src.indexOf('(', i);
      let depth = 0;
      let bodyStart = -1;
      for (let j = open; j < src.length; j += 1) {
        const c = src[j]!;
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            const k = src.indexOf('{', j);
            if (k > 0) bodyStart = k;
            break;
          }
        }
      }
      if (bodyStart > 0) {
        let d = 0;
        let end = -1;
        for (let j = bodyStart; j < src.length; j += 1) {
          const c = src[j]!;
          if (c === '{') d += 1;
          else if (c === '}') {
            d -= 1;
            if (d === 0) {
              end = j;
              break;
            }
          }
        }
        if (end > 0) lines.push(src.slice(bodyStart, end + 1));
        i = end > 0 ? end + 1 : open + 1;
        continue;
      }
    }
    i += 1;
  }
  return lines.join('\n');
}

/**
 * `#526` **反向安全网**：`java.util` 在 worker 里只有子集，脚本若在 with 正文里用到这些类名就必须留 L1。
 * 命中即留 —— 宁可牺牲一点性能，也不让源从「L1 能跑」变成 worker 里 `Collections is not defined`。
 */
const WORKER_WITH_DENY_RE =
  /\b(?:Collections|Iterator|ListIterator|HashSet|TreeSet|LinkedHashSet|LinkedList|TreeMap|Hashtable|Vector|Stack|Date|Calendar|Random|Scanner|Properties|Enumeration|Comparator|Collectors|StringTokenizer)\b/;

/**
 * `#526` 从脚本里提取 `JavaImporter` 的导入命名空间。
 *
 * 三种写法都认：`new JavaImporter(Packages.a, …)`、`ji.importPackage(Packages.a, …)`、
 * `importClass(Packages.a.B)`。返回 `null` = **没找到可判定的导入**（动态拼接 / 空导入）⇒ 调用方留 L1。
 */
function importerNamespaces(src: string): string[] | null {
  const re = /\b(?:JavaImporter|importPackage|importClass)\s*\(([^)]*)\)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  let seen = false;
  while ((m = re.exec(src)) !== null) {
    seen = true;
    const inner = m[1] ?? '';
    const pkgRe = /\bPackages\s*\.\s*([\w$]+(?:\s*\.\s*[\w$]+)*)/g;
    let p: RegExpExecArray | null;
    while ((p = pkgRe.exec(inner)) !== null) out.add((p[1] ?? '').replace(/\s+/g, ''));
  }
  if (!seen || out.size === 0) return null;
  return [...out];
}

export function needsJavaBridgeL1(libPlusCode: string): boolean {
  const hardBridgeOff = workerHardBridgeOff();
  /**
   * `#691` **含 `CryptoJS` 的脚本必须留 L1**。
   *
   * 上游 App 把 `assets/scripts/cryptojs.min.js` 编译进每次求值的 scope（`SharedJsScope`），
   * 所以源可以直接用 `CryptoJS.AES.decrypt(...)`。我们的实现（`selector/cryptojs.ts`）
   * 返回的是**带方法的 WordArray 对象**，不可结构化克隆 ⇒ worker 的绑定传不过去。
   * 判据与 Bitmap/Canvas 同一类：正确性优先，代价是这段时间占用主线程。
   */
  if (/\bCryptoJS\b/.test(libPlusCode)) return true;
  /**
   * `#526` 硬桥（JavaImporter / Bitmap / Canvas）**不再无条件留 L1**：
   *  · `JavaImporter`：worker 侧已实现 ctor + with 作用域（worker-pool 的 __yueduJavaImporterCtor），
   *    这里只按 importPackage 的命名空间逐个判「worker 有没有全套实现」；
   *  · `Bitmap/Canvas`：worker 侧走 rpc('bitmap') 回宿主，与 L1 **同一份像素实现**
   *    （android-graphics.ts）⇒ 语义零差异。
   * 判不准（动态导入 / 空导入 / 命中 deny 名单）仍然留 L1。
   */
  if (/\bJavaImporter\b/.test(libPlusCode)) {
    if (hardBridgeOff) return true;
    const nss = importerNamespaces(libPlusCode);
    if (!nss) return true;
    const unsafe = nss.some((ns) => WORKER_WITH_UNSAFE_NS.some((bad) => ns === bad || ns.startsWith(bad + '.')));
    if (unsafe) return true;
    const allSafe = nss.every((ns) => WORKER_WITH_SAFE_NS.some((safe) => ns === safe || ns.startsWith(safe + '.')));
    if (!allSafe) return true;
    // 只在 with 正文里判 deny（整段脚本上的 new Date() 是纯 JS，会误伤）
    if (WORKER_WITH_DENY_RE.test(withBodies(libPlusCode))) return true;
  }
  if (/\bBitmapFactory\b|\bCanvas\b|\bBitmap\b/.test(libPlusCode) && hardBridgeOff) return true;
  /**
   * `#500` **纯 `Packages.` 且路径全部命中 worker 前缀表 ⇒ 放去 worker**。
   * 这类源此前全被强留主线程 L1（37 源 = 15%），而 L1 的 `execFileSync(curl)` /
   * `spawnSync(Chromium)` 正是 `#497` 实证的 stall 主因。worker 的 HTTP 走 RPC 回宿主，
   * 同步等待不阻塞主线程 ⇒ 搬过去语义不变、 stall 归零（这一类里）。
   * 判据取「全部命中」：只要有一条路径没实现就整体留 L1（保守，避免半残功能）。
   */
  const paths = packagesPaths(libPlusCode);
  if (paths.length > 0) {
    const allCovered = paths.every((p) =>
      WORKER_PACKAGES_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '.')),
    );
    if (allCovered) return false;
  }
  return /\bPackages\s*\./.test(libPlusCode.replace(WORKER_EQUIVALENT_NS_RE, '__worker_ok__'));
}
