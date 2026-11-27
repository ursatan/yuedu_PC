/**
 * `#691` **CryptoJS 兼容层**（上游 App 内置 `app/src/main/assets/scripts/cryptojs.min.js`，我们此前完全没有）。
 *
 * ## 为什么必须补
 * Legado 的脚本环境里 `CryptoJS` 是**全局可用的**（`SharedJsScope.loadCryptoJs()` 读 assets 里的
 * cryptojs.min.js，编译进每次求值的 scope）。所以一大批源的 jsLib 直接写：
 * ```js
 * var k = CryptoJS.enc.Utf8.parse(AESKEY);
 * var d = CryptoJS.AES.decrypt({ciphertext: CryptoJS.enc.Base64.parse(b64)}, k, {iv: iv});
 * var plain = d.toString(CryptoJS.enc.Utf8);
 * ```
 * 我们没有 ⇒ `ReferenceError: CryptoJS is not defined` ⇒ 整个源在第一步就断（实测 野果短剧：
 * `RULE_PARSE@parse · CryptoJS is not defined`）。
 *
 * ## 实现口径：**只做 CryptoJS 的 API 语义，不自己发明算法**
 * 底层一律用 `node:crypto`（AES 分块模式 / MD5 / SHA / HMAC 都是平台实现），
 * 本文件只负责三件事：
 *  ① **WordArray**（`words` 32 位整数数组 + `sigBytes`，CryptoJS 的字节容器）；
 *  ② **编码器** Hex / Latin1 / Utf8 / Base64 的 `parse` / `stringify`；
 *  ③ **Cipher 外壳**：`encrypt` / `decrypt` 的入参归一（String 口令走 OpenSSL KDF、WordArray 走裸密钥）、
 *     模式（CBC/ECB/CFB/OFB/CTR）、填充（Pkcs7/NoPadding/ZeroPadding/Iso10126/Iso97971/AnsiX923）。
 *
 * ## 与上游的差异（写清楚，不默默少做）
 * · 只实现**对称加密 + 摘要 + HMAC**：`AES/DES/TripleDES` 里只做 AES（语料里其余为 0 处），
 *   `Rabbit/RC4/RabbitLegacy`、`x64`、`algo.*` 的渐进式 API（`create()/update()/finalize()`）**没做**；
 * · `CryptoJS.lib.WordArray.random` 用 `randomBytes` 实现（上游用 `SecureRandom`）。
 * 用到未实现成员时会拿到 `undefined`（与「上游没有该方法」同症状），不会静默返回错值。
 *
 * ## 为什么只挂在 L1
 * 这是**对象型 API**（`WordArray` 是带方法的对象），而 worker 的绑定必须结构化可克隆
 * ⇒ 无法跨线程传递。故 `needsJavaBridgeL1()` 把含 `CryptoJS` 的脚本路由到 L1
 * （与 JavaImporter/Bitmap 同一处理：正确性优先，代价是这段时间占主线程）。
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/** CryptoJS 的 `WordArray`（`words` 是有符号 32 位整数数组，`sigBytes` 是有效字节数） */
interface WordArray {
  words: number[];
  sigBytes: number;
  toString(encoder?: Encoder): string;
  concat(other: WordArray): WordArray;
  clamp(): void;
  clone(): WordArray;
}

interface Encoder {
  stringify(wa: WordArray): string;
  parse(str: string): WordArray;
}

/** 与 `CryptoJS.pad.*` 同形：`{pad, unpad}`，但我们的 pad 作用在**字节**上（不是 WordArray） */
interface Padding {
  name: string;
}

interface CipherCfg {
  iv?: WordArray;
  mode?: { name: string };
  padding?: Padding;
  format?: unknown;
}

const BLOCK = 16;

function bytesOf(wa: WordArray): Uint8Array {
  const out = new Uint8Array(wa.sigBytes);
  for (let i = 0; i < wa.sigBytes; i++) {
    out[i] = (wa.words[i >>> 2]! >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return out;
}

function wordArrayFrom(bytes: Uint8Array): WordArray {
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] = ((words[i >>> 2] ?? 0) | (bytes[i]! << (24 - (i % 4) * 8))) | 0;
  }
  return makeWordArray(words, bytes.length);
}

function makeWordArray(words: number[], sigBytes: number): WordArray {
  const wa: WordArray = {
    words,
    sigBytes,
    toString(encoder?: Encoder): string {
      return (encoder ?? HEX).stringify(this);
    },
    concat(other: WordArray): WordArray {
      const a = bytesOf(this);
      const b = bytesOf(other);
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      const merged = wordArrayFrom(out);
      this.words = merged.words;
      this.sigBytes = merged.sigBytes;
      return this;
    },
    clamp(): void {
      const excess = (this.sigBytes % 4) * 8;
      if (excess && this.words.length) {
        const i = this.sigBytes >>> 2;
        this.words[i] = (this.words[i] ?? 0) & (0xffffffff << excess);
      }
    },
    clone(): WordArray {
      return makeWordArray([...this.words], this.sigBytes);
    },
  };
  return wa;
}

const utf8Encoder = new TextEncoder();
const utf8DecoderStrict = new TextDecoder('utf-8', { fatal: true });
const utf8DecoderLoose = new TextDecoder('utf-8');

const HEX: Encoder = {
  stringify(wa: WordArray): string {
    return [...bytesOf(wa)].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
  parse(str: string): WordArray {
    const clean = str.replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return wordArrayFrom(bytes);
  },
};

const LATIN1: Encoder = {
  stringify(wa: WordArray): string {
    return [...bytesOf(wa)].map((b) => String.fromCharCode(b)).join('');
  },
  parse(str: string): WordArray {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    return wordArrayFrom(bytes);
  },
};

const UTF8: Encoder = {
  stringify(wa: WordArray): string {
    const bytes = bytesOf(wa);
    try {
      return utf8DecoderStrict.decode(bytes);
    } catch {
      /**
       * CryptoJS 在 UTF-8 非法时抛 `Malformed UTF-8 data`；我们抛同文案，
       * 让源脚本里 `try{…toString(Utf8)}catch(e){…}` 的分支与上游一致。
       */
      throw new Error('Malformed UTF-8 data');
    }
  },
  parse(str: string): WordArray {
    return wordArrayFrom(utf8Encoder.encode(str));
  },
};

const BASE64: Encoder = {
  stringify(wa: WordArray): string {
    return Buffer.from(bytesOf(wa)).toString('base64');
  },
  parse(str: string): WordArray {
    const clean = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    return wordArrayFrom(new Uint8Array(Buffer.from(clean, 'base64')));
  },
};

const PADS: Record<string, Padding> = {
  Pkcs7: { name: 'Pkcs7' },
  NoPadding: { name: 'NoPadding' },
  ZeroPadding: { name: 'ZeroPadding' },
  Iso10126: { name: 'Iso10126' },
  Iso97971: { name: 'Iso97971' },
  AnsiX923: { name: 'AnsiX923' },
};
// CryptoJS 的别名（`SigBytes` 系列在旧源里见过）
PADS['Pkcs5'] = PADS['Pkcs7']!;

function padBytes(data: Uint8Array, padding: Padding): Uint8Array {
  const block = BLOCK;
  const rem = data.length % block;
  switch (padding.name) {
    case 'NoPadding':
      return data;
    case 'ZeroPadding': {
      if (rem === 0) return data;
      const out = new Uint8Array(data.length + (block - rem));
      out.set(data, 0);
      return out;
    }
    case 'Iso10126': {
      const n = block - rem;
      const out = new Uint8Array(data.length + n);
      out.set(data, 0);
      out.set(randomBytes(n - 1), data.length);
      out[out.length - 1] = n;
      return out;
    }
    case 'Iso97971': {
      const n = block - rem;
      const out = new Uint8Array(data.length + n);
      out.set(data, 0);
      out[data.length] = 0x80;
      return out;
    }
    case 'AnsiX923': {
      const n = block - rem;
      const out = new Uint8Array(data.length + n);
      out.set(data, 0);
      out[out.length - 1] = n;
      return out;
    }
    case 'Pkcs7':
    default: {
      const n = block - rem;
      const out = new Uint8Array(data.length + n);
      out.set(data, 0);
      out.fill(n, data.length);
      return out;
    }
  }
}

function unpadBytes(data: Uint8Array, padding: Padding): Uint8Array {
  if (!data.length) return data;
  switch (padding.name) {
    case 'NoPadding':
      return data;
    case 'ZeroPadding': {
      let end = data.length;
      while (end > 0 && data[end - 1] === 0) end--;
      return data.subarray(0, end);
    }
    case 'Iso97971': {
      let end = data.length;
      while (end > 0 && data[end - 1] === 0) end--;
      if (end > 0 && data[end - 1] === 0x80) end--;
      return data.subarray(0, end);
    }
    case 'Pkcs7':
    case 'Iso10126':
    case 'AnsiX923':
    default: {
      const n = data[data.length - 1]!;
      // 非法填充：CryptoJS 会照样截断（不校验），这里跟随，避免与上游分叉
      if (n < 1 || n > BLOCK) return data;
      return data.subarray(0, data.length - n);
    }
  }
}

const MODE_NAME: Record<string, string> = {
  CBC: 'cbc',
  ECB: 'ecb',
  CFB: 'cfb',
  OFB: 'ofb',
  CTR: 'ctr',
};

/** `EVP_BytesToKey`（OpenSSL KDF，CryptoJS 在口令模式下用的就是它） */
function evpBytesToKey(password: Uint8Array, salt: Uint8Array, keyLen: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let prev = new Uint8Array(0);
  let total = 0;
  while (total < keyLen) {
    const h = createHash('md5');
    h.update(prev);
    h.update(password);
    if (salt.length) h.update(salt);
    prev = new Uint8Array(h.digest());
    chunks.push(prev);
    total += prev.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.subarray(0, keyLen);
}

interface CipherParams extends WordArray {
  ciphertext: WordArray;
  iv?: WordArray;
  salt?: WordArray;
  key?: WordArray;
}

function isWordArray(v: unknown): v is WordArray {
  return !!v && typeof v === 'object' && Array.isArray((v as WordArray).words) && typeof (v as WordArray).sigBytes === 'number';
}

function toWordArray(v: unknown, fallbackEnc: Encoder = BASE64): WordArray {
  if (isWordArray(v)) return v;
  if (v && typeof v === 'object' && isWordArray((v as { ciphertext?: unknown }).ciphertext)) {
    return (v as { ciphertext: WordArray }).ciphertext;
  }
  if (typeof v === 'string') return fallbackEnc.parse(v);
  return makeWordArray([], 0);
}

/**
 * 建一个 AES 门面。`encrypt` 返回 CipherParams（带 `ciphertext`），`decrypt` 返回 WordArray ——
 * 与 CryptoJS 的返回类型逐一对齐（源脚本常在返回值上直接 `.toString(CryptoJS.enc.Utf8)`）。
 */
function makeAes() {
  function run(data: Uint8Array, keyBytes: Uint8Array, ivBytes: Uint8Array, modeName: string, enc: boolean): Uint8Array {
    const alg = `aes-${keyBytes.length * 8}-${modeName}`;
    const iv = modeName === 'ecb' ? null : ivBytes.subarray(0, 16);
    const c = enc
      ? createCipheriv(alg, keyBytes, iv as unknown as Uint8Array)
      : createDecipheriv(alg, keyBytes, iv as unknown as Uint8Array);
    c.setAutoPadding(false);
    return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
  }

  return {
    encrypt(message: unknown, key: unknown, cfg: CipherCfg = {}): CipherParams {
      const plain = toWordArray(message, UTF8);
      const mode = MODE_NAME[cfg.mode?.name ?? 'CBC'] ?? 'cbc';
      const padding = cfg.padding ?? PADS['Pkcs7']!;
      const plainBytes = padding.name === 'NoPadding' || mode !== 'cbc' && mode !== 'ecb'
        ? bytesOf(plain)
        : padBytes(bytesOf(plain), padding);

      let keyBytes: Uint8Array;
      let ivBytes: Uint8Array;
      let salt: Uint8Array | undefined;
      if (isWordArray(key)) {
        keyBytes = bytesOf(key).subarray(0, 32);
        ivBytes = cfg.iv ? bytesOf(cfg.iv) : new Uint8Array(16);
      } else {
        // 口令模式：随机 8 字节 salt → EVP_BytesToKey（48 字节：key 32 + iv 16）
        salt = new Uint8Array(randomBytes(8));
        const derived = evpBytesToKey(bytesOf(UTF8.parse(String(key))), salt, 48);
        keyBytes = derived.subarray(0, 32);
        ivBytes = derived.subarray(32, 48);
      }
      const ct = run(plainBytes, keyBytes, ivBytes, mode, true);
      const out: Uint8Array = salt
        ? (() => {
            const b = new Uint8Array(16 + ct.length);
            b.set(bytesOf(UTF8.parse('Salted__')), 0);
            b.set(salt!, 8);
            b.set(ct, 16);
            return b;
          })()
        : ct;
      const params = wordArrayFrom(out) as CipherParams;
      params.ciphertext = wordArrayFrom(ct);
      params.iv = cfg.iv ?? wordArrayFrom(ivBytes);
      if (salt) params.salt = wordArrayFrom(salt);
      params.key = wordArrayFrom(keyBytes);
      /**
       * ★ **`CipherParams.toString()` 的默认编码器不是 Hex，而是 OpenSSL 格式器**
       * （CryptoJS `CipherParams.toString(formatter = formatOpenSSL)`）：
       * 有 salt ⇒ `base64("Salted__" + salt + ciphertext)`，无 salt ⇒ `base64(ciphertext)`。
       * 若沿用 WordArray 的默认 Hex，`AES.decrypt(AES.encrypt(x,'pwd').toString(),'pwd')`
       * 这种**口令往返**会拿到一串 hex 再当 base64 解 ⇒ `wrong final block length`。
       */
      params.toString = (encoder?: Encoder): string =>
        encoder ? encoder.stringify(params) : BASE64.stringify(params);
      return params;
    },

    decrypt(ciphertext: unknown, key: unknown, cfg: CipherCfg = {}): WordArray {
      const raw = toWordArray(ciphertext, BASE64);
      const mode = MODE_NAME[cfg.mode?.name ?? 'CBC'] ?? 'cbc';
      const padding = cfg.padding ?? PADS['Pkcs7']!;
      let data = bytesOf(raw);
      let keyBytes: Uint8Array;
      let ivBytes: Uint8Array;

      if (isWordArray(key)) {
        keyBytes = bytesOf(key).subarray(0, 32);
        ivBytes = cfg.iv ? bytesOf(cfg.iv) : new Uint8Array(16);
      } else {
        // OpenSSL 口令模式：密文必须以 "Salted__" 开头，salt 在 8..16
        const salted = data.length > 16 && new TextDecoder().decode(data.subarray(0, 8)) === 'Salted__';
        const salt = salted ? data.subarray(8, 16) : new Uint8Array(0);
        const derived = evpBytesToKey(bytesOf(UTF8.parse(String(key))), salt, 48);
        keyBytes = derived.subarray(0, 32);
        ivBytes = derived.subarray(32, 48);
        if (salted) data = data.subarray(16);
      }
      const out = run(data, keyBytes, ivBytes, mode, false);
      const needPad = mode === 'cbc' || mode === 'ecb';
      return wordArrayFrom(needPad ? unpadBytes(out, padding) : out);
    },
  };
}

function digest(algo: string) {
  return (message: unknown): WordArray => {
    const bytes = isWordArray(message) ? bytesOf(message) : bytesOf(toWordArray(message, UTF8));
    const h = createHash(algo);
    h.update(bytes);
    return wordArrayFrom(new Uint8Array(h.digest()));
  };
}

function hmac(algo: string) {
  return (message: unknown, key: unknown): WordArray => {
    const msgBytes = isWordArray(message) ? bytesOf(message) : bytesOf(toWordArray(message, UTF8));
    const keyBytes = isWordArray(key) ? bytesOf(key) : bytesOf(toWordArray(key, UTF8));
    const h = createHmac(algo, keyBytes);
    h.update(msgBytes);
    return wordArrayFrom(new Uint8Array(h.digest()));
  };
}

export interface CryptoJsGlobal {
  lib: { WordArray: unknown; CipherParams: unknown };
  enc: { Hex: Encoder; Latin1: Encoder; Utf8: Encoder; Base64: Encoder };
  mode: Record<string, { name: string }>;
  pad: Record<string, Padding>;
  AES: ReturnType<typeof makeAes>;
  MD5: (m: unknown) => WordArray;
  SHA1: (m: unknown) => WordArray;
  SHA256: (m: unknown) => WordArray;
  SHA512: (m: unknown) => WordArray;
  HmacMD5: (m: unknown, k: unknown) => WordArray;
  HmacSHA1: (m: unknown, k: unknown) => WordArray;
  HmacSHA256: (m: unknown, k: unknown) => WordArray;
  kdf: { OpenSSL: { execute: (password: string, keySize: number, ivSize: number, salt?: WordArray) => WordArray } };
}

let cached: CryptoJsGlobal | null = null;

/** 取（并缓存）CryptoJS 兼容对象。挂到 L1 的全局 `CryptoJS` 上（见 `js.ts` 的 `base.CryptoJS`）。 */
export function createCryptoJs(): CryptoJsGlobal {
  if (cached) return cached;
  cached = {
    lib: {
      WordArray: {
        create(words?: number[] | unknown, sigBytes?: number): WordArray {
          if (Array.isArray(words)) return makeWordArray(words as number[], sigBytes ?? (words as number[]).length * 4);
          if (words instanceof Uint8Array) return wordArrayFrom(words);
          return makeWordArray([], 0);
        },
        random(nBytes: number): WordArray {
          return wordArrayFrom(new Uint8Array(randomBytes(nBytes)));
        },
      },
      CipherParams: {
        create(obj: { ciphertext?: WordArray } & Partial<CipherParams>): CipherParams {
          const ct = obj.ciphertext ?? makeWordArray([], 0);
          const p = ct as CipherParams;
          p.ciphertext = ct;
          if (obj.iv) p.iv = obj.iv;
          if (obj.salt) p.salt = obj.salt;
          return p;
        },
      },
    },
    enc: { Hex: HEX, Latin1: LATIN1, Utf8: UTF8, Base64: BASE64 },
    // `CryptoJS.mode.CBC` 只是**标识对象**（源脚本把它当 cfg.mode 传回来）
    mode: { CBC: { name: 'CBC' }, ECB: { name: 'ECB' }, CFB: { name: 'CFB' }, OFB: { name: 'OFB' }, CTR: { name: 'CTR' } },
    pad: PADS,
    AES: makeAes(),
    MD5: digest('md5'),
    SHA1: digest('sha1'),
    SHA256: digest('sha256'),
    SHA512: digest('sha512'),
    HmacMD5: hmac('md5'),
    HmacSHA1: hmac('sha1'),
    HmacSHA256: hmac('sha256'),
    kdf: {
      OpenSSL: {
        execute(password: string, keySize: number, ivSize: number, salt?: WordArray): WordArray {
          const saltBytes = salt ? bytesOf(salt) : new Uint8Array(randomBytes(8));
          const derived = evpBytesToKey(bytesOf(UTF8.parse(password)), saltBytes, keySize + ivSize);
          const wa = wordArrayFrom(derived) as WordArray & { salt?: WordArray };
          wa.salt = wordArrayFrom(saltBytes);
          return wa;
        },
      },
    },
  };
  return cached;
}

/** UTF-8 宽松解码（导出给测试/诊断用；脚本侧不会用到） */
export const __testing = { utf8DecoderLoose, bytesOf, wordArrayFrom };
