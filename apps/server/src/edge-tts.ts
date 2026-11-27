/**
 * 内置 **Edge 在线音色**（微软 Edge「大声朗读」同源的 neural voices）。
 *
 * 背景：Electron/Chromium 的 `speechSynthesis.getVoices()` 只能枚举本机 SAPI 语音包，
 * 枚举不到 Edge 的云端音色。这里直接走 Edge 朗读服务的 WebSocket 协议取 MP3，
 * 因此 Web 与桌面端能共用同一份完整音色表。
 *
 * 约束：
 * - 非官方接口，必须联网，文本会发往微软；默认不启用，由用户在朗读面板显式选择；
 * - 不内置任何 Key（协议本身免 Key），也不写入书源/规则文件；
 * - 2026 年微软把签名升级为 v2（`<CS64>-<SHA256>`），旧版 403，故此处按新算法实现。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import https from 'node:https';
import type { Duplex } from 'node:stream';

const EDGE_TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
/** 与 edge-tts 7.x 对齐的 Chromium 版本号，服务端会校验签名版本。 */
const EDGE_SEC_MS_GEC_VERSION = '2-143.0.3650.75';
const EDGE_VOICE_LIST_URL =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${EDGE_TRUSTED_TOKEN}`;
const EDGE_WSS_HOST = 'speech.platform.bing.com';
const EDGE_WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const VOICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VOICE_LIST_TIMEOUT_MS = 15_000;
const SPEAK_TIMEOUT_MS = 25_000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 5_000;

// ---------------------------------------------------------------------------
// Sec-MS-GEC v2（edge-tts drm.py 的等价实现；用 BigInt 保证 64 位乘加精度）
// ---------------------------------------------------------------------------

const U32 = 0xffffffffn;

const DRM_SHA_INITIAL = [
  0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an,
  0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n,
] as const;
const DRM_SHA_STATE = [
  0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an,
  0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n,
] as const;
const DRM_SHA_SCHEDULE = [
  0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban,
  0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n, 0xf9e70ab6n,
  0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n,
  0xd258b060n, 0x72766564n,
] as const;
const DRM_ROUND = [
  0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn, 0x59f111f1n, 0x923f82a4n,
  0xab1c5ed5n, 0xd807aa98n, 0x12835b01n, 0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen,
  0x9bdc06a7n, 0xc19bf174n, 0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn, 0x2de92c6fn,
  0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan, 0x983e5152n, 0xa831c66dn, 0xb00327c8n, 0xbf597fc7n,
  0xc6e00bf3n, 0xd5a79147n, 0x06ca6351n, 0x14292967n, 0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn,
  0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n, 0xa2bfe8a1n, 0xa81a664bn,
  0xc24b8b70n, 0xc76c51a3n, 0xd192e819n, 0xd6990624n, 0xf40e3585n, 0x106aa070n, 0x19a4c116n,
  0x1e376c08n, 0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn, 0x682e6ff3n,
  0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n, 0x90befffan, 0xa4506cebn, 0xbef9a3f7n,
  0xc67178f2n,
] as const;
const DRM_ADJUSTMENT = 0xc9dc06a7n;
const DRM_BLOCK = [...DRM_ROUND.slice(0, 14), DRM_ADJUSTMENT, ...DRM_ROUND.slice(15)] as const;
const DRM_SIGMA0_ADJ = 0x059c0b80n;
const DRM_SIGMA1_ADJ = 0x000b92c0n;

const DRM_CS_COEF = [
  [0xe82e91b1n, 0xb32700d0n], [0x44de24c6n, 0x88dff51dn], [0x3beb65bcn, 0x29514038n],
  [0xc89c5933n, 0xb328cbdfn], [0x8d1ec211n, 0xd405b4d5n], [0x314ef5d5n, 0x26e55f3cn],
  [0xe92491b1n, 0x607801c6n], [0xf0a5b9d5n, 0x82b2c1fbn], [0x06064cf3n, 0xfa51a3dan],
  [0xda79fa60n, 0x207cc464n], [0xbed20560n, 0x3c3c74f3n], [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n], [0xcb49e3c6n, 0xc5626167n],
] as const;
const DRM_CS_FACTOR = 0x82893933n;
const DRM_CS_ADJ0 = 0xf2f90b1an;
const DRM_CS_ADJ1 = 0x0b1a0000n;

function rol16(v: bigint): bigint {
  const x = v & U32;
  return ((x << 16n) | (x >> 16n)) & U32;
}

function drmSigma0(v: bigint): bigint {
  return ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & U32;
}

function drmSigma1(v: bigint): bigint {
  return ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & U32;
}

function drmRounds(state: readonly bigint[], words: readonly bigint[], firstRound = 0): bigint[] {
  let [a, b, c, d, e, f, g, h] = state as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const constants = firstRound === 14 ? DRM_BLOCK : DRM_ROUND;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);
  for (let index = firstRound; index < aligned; index++) {
    const rotE = e * 0x100000001n;
    const rotA = a * 0x100000001n;
    const t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (g ^ (e & (f ^ g))) + constants[index]! + words[index]!;
    const t2 = ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)));
    [a, b, c, d, e, f, g, h] = [(t1 + t2) & U32, a, b, c, (d + t1) & U32, e, f, g];
  }
  // 未滚动的 8 轮一组（与 edge-tts drm.py 的寄存器轮换保持一致）
  for (let index = aligned; index < 64; index += 8) {
    let rotE = e * 0x100000001n;
    let rotA = a * 0x100000001n;
    let t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (g ^ (e & (f ^ g))) + constants[index]! + words[index]!;
    d = (d + t1) & U32;
    h = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))) & U32;
    rotE = d * 0x100000001n;
    rotA = h * 0x100000001n;
    t1 = g + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (f ^ (d & (e ^ f))) + constants[index + 1]! + words[index + 1]!;
    c = (c + t1) & U32;
    g = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((h & a) | (b & (h | a)))) & U32;
    rotE = c * 0x100000001n;
    rotA = g * 0x100000001n;
    t1 = f + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (e ^ (c & (d ^ e))) + constants[index + 2]! + words[index + 2]!;
    b = (b + t1) & U32;
    f = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((g & h) | (a & (g | h)))) & U32;
    rotE = b * 0x100000001n;
    rotA = f * 0x100000001n;
    t1 = e + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (d ^ (b & (c ^ d))) + constants[index + 3]! + words[index + 3]!;
    a = (a + t1) & U32;
    e = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((f & g) | (h & (f | g)))) & U32;
    rotE = a * 0x100000001n;
    rotA = e * 0x100000001n;
    t1 = d + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (c ^ (a & (b ^ c))) + constants[index + 4]! + words[index + 4]!;
    h = (h + t1) & U32;
    d = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((e & f) | (g & (e | f)))) & U32;
    rotE = h * 0x100000001n;
    rotA = d * 0x100000001n;
    t1 = c + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (b ^ (h & (a ^ b))) + constants[index + 5]! + words[index + 5]!;
    g = (g + t1) & U32;
    c = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((d & e) | (f & (d | e)))) & U32;
    rotE = g * 0x100000001n;
    rotA = c * 0x100000001n;
    t1 = b + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (a ^ (g & (h ^ a))) + constants[index + 6]! + words[index + 6]!;
    f = (f + t1) & U32;
    b = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((c & d) | (e & (c | d)))) & U32;
    rotE = f * 0x100000001n;
    rotA = b * 0x100000001n;
    t1 = a + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
      + (h ^ (f & (g ^ h))) + constants[index + 7]! + words[index + 7]!;
    e = (e + t1) & U32;
    a = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((b & c) | (d & (b | c)))) & U32;
  }
  return [a, b, c, d, e, f, g, h];
}

function drmExpand(words: bigint[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2]!;
    const y = words[index - 15]!;
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    words.push((s1 + words[index - 7]! + s0 + words[index - 16]!) & U32);
  }
}

function drmShaInit(data: Buffer): bigint[] {
  const words: bigint[] = new Array<bigint>(14).fill(0n);
  words.push(BigInt(data.readUIntBE(0, 3)));
  words.push(BigInt(data.readUIntBE(3, 4)));
  for (let index = 16; index < 30; index++) {
    let value = DRM_SHA_SCHEDULE[index - 16]!;
    if (index - 2 >= 14) {
      const s = drmSigma1(words[index - 2]!);
      value += index === 16 ? s ^ DRM_SIGMA1_ADJ : s;
    }
    if (index - 7 >= 14) value += words[index - 7]!;
    if (index - 15 >= 14) {
      const s = drmSigma0(words[index - 15]!);
      value += index === 29 ? s ^ DRM_SIGMA0_ADJ : s;
    }
    words.push(value & U32);
  }
  words.push(
    (drmSigma1(words[28]!) + words[23]! + drmSigma0(words[15]!)
      + words[14]! + DRM_ADJUSTMENT - DRM_ROUND[14]!) & U32,
  );
  drmExpand(words, 31);
  const working = drmRounds(DRM_SHA_STATE, words, 14);
  return DRM_SHA_INITIAL.map((x, i) => (x + working[i]!) & U32);
}

function drmShaDigest(data: Buffer): Buffer {
  const length = 57 + data.length;
  const bits = Buffer.alloc(8);
  bits.writeBigUInt64BE(BigInt(length * 8));
  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc((((55 - length) % 64) + 64) % 64),
    bits,
  ]);
  let state = drmShaInit(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: bigint[] = [];
    for (let i = 0; i < 16; i++) words.push(BigInt(padded.readUInt32BE(offset + i * 4)));
    drmExpand(words);
    const working = drmRounds(state, words);
    state = state.map((x, i) => (x + working[i]!) & U32);
  }
  const out = Buffer.alloc(32);
  state.forEach((v, i) => out.writeUInt32BE(Number(v), i * 4));
  return out;
}

function drmCs64Digest(data: Buffer, digest: Buffer): [bigint, bigint] {
  const keyA = BigInt(digest.readUInt32LE(0) | 1);
  const keyB = BigInt(digest.readUInt32LE(4) | 1);
  const factors = [(keyA * DRM_CS_FACTOR) & U32, (keyB * DRM_CS_FACTOR) & U32];
  const terms: bigint[] = DRM_CS_COEF.map(([coeff], i) => (coeff * factors[i % 2]!) & U32);
  const offsets: bigint[] = DRM_CS_COEF.map(([, off]) => off);

  const raw = Buffer.concat([Buffer.from([0]), data]);
  const words: bigint[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    const slice = raw.subarray(i, Math.min(i + 4, raw.length));
    const buf = Buffer.concat([slice, Buffer.alloc(4 - slice.length)]);
    words.push(BigInt(buf.readUInt32LE(0)));
  }
  if (words.length % 2) words.push(0n);

  words.forEach((word, index) => {
    const even = index % 2 === 0;
    let term = word * (even ? keyA : keyB);
    let offset = rol16(word) * (even ? 0xef0569fbn : 0xc31713dbn);
    if (index === 0) {
      term += DRM_CS_ADJ0 * factors[0]!;
      offset += DRM_CS_ADJ1;
    }
    terms.push(term & U32);
    offsets.push(offset & U32);
  });

  let swapAcc = 0n;
  let swapLast = 0n;
  let state = 0n;
  let acc = 0n;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]!;
    const y = terms[index + 1]!;
    let t = rol16((offsets[index]! + x) & U32);
    let q = (t * 0x76f50f34n) & U32;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & U32;
    t = rol16((offsets[index + 1]! + y) & U32);
    q = (t * 0x1881ce3cn) & U32;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & U32;
    swapAcc = (swapAcc + swapLast) & U32;
    state = (state * keyA + x) & U32;
    state = (rol16(state) * 0xcf98b111n) & U32;
    state = (rol16(state) * 0x87085b9fn) & U32;
    state = (rol16(state) * 0x12ceb96dn) & U32;
    state = (rol16(state) * 0x257e1d83n) & U32;
    acc += state;
    t = (state * keyB + y) & U32;
    t = (rol16(t) * 0xa27416f5n) & U32;
    t = (rol16(t) * 0xd38396ffn) & U32;
    state = (rol16((rol16(t) * 0x7c932b89n) & U32) * 0xbfa49f69n) & U32;
    acc = (acc + state) & U32;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

/** 生成 5 分钟一档的 `Sec-MS-GEC` v2 签名；同档内复用。 */
function generateSecMsGec(now = Date.now()): string {
  let ticks = now / 1000 + 11_644_473_600;
  ticks -= ticks % 300;
  ticks *= 1e7;
  const input = Buffer.from(`${Math.floor(ticks)}${EDGE_TRUSTED_TOKEN}`, 'ascii');
  const digest = drmShaDigest(input);
  const [w0, w1] = drmCs64Digest(input, digest);
  const cs = Buffer.alloc(8);
  cs.writeUInt32LE(Number(w0 & 0xffffffffn), 0);
  cs.writeUInt32LE(Number(w1 & 0xffffffffn), 4);
  return `${cs.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

let gecCache: { bucket: number; value: string } | null = null;

function secMsGec(): string {
  const bucket = Math.floor(Date.now() / 1000 / 300);
  if (gecCache?.bucket === bucket) return gecCache.value;
  const value = generateSecMsGec();
  gecCache = { bucket, value };
  return value;
}

// ---------------------------------------------------------------------------
// 音色列表
// ---------------------------------------------------------------------------

export interface EdgeVoice {
  /** `ShortName`，例如 `zh-CN-XiaoxiaoNeural`，合成时直接作为 voice 名 */
  id: string;
  /** 展示名，优先 `FriendlyName` */
  name: string;
  locale: string;
  localeName: string;
  gender: string;
}

interface RawEdgeVoice {
  ShortName?: unknown;
  FriendlyName?: unknown;
  Gender?: unknown;
  Locale?: unknown;
  LocaleName?: unknown;
}

let voiceCache: { at: number; voices: EdgeVoice[] } | null = null;

function normalizeVoice(raw: RawEdgeVoice): EdgeVoice | null {
  if (typeof raw.ShortName !== 'string' || typeof raw.Locale !== 'string') return null;
  return {
    id: raw.ShortName,
    name: typeof raw.FriendlyName === 'string' && raw.FriendlyName
      ? raw.FriendlyName
      : raw.ShortName,
    locale: raw.Locale,
    localeName: typeof raw.LocaleName === 'string' ? raw.LocaleName : raw.Locale,
    gender: typeof raw.Gender === 'string' ? raw.Gender : '',
  };
}

/** 中文排前面，其余按 locale 排，便于界面直接分组。 */
function sortVoices(voices: EdgeVoice[]): EdgeVoice[] {
  return [...voices].sort((a, b) => {
    const za = a.locale.toLowerCase().startsWith('zh') ? 0 : 1;
    const zb = b.locale.toLowerCase().startsWith('zh') ? 0 : 1;
    if (za !== zb) return za - zb;
    return a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id);
  });
}

export async function listEdgeVoices(force = false): Promise<{ voices: EdgeVoice[]; cachedAt: number }> {
  if (!force && voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_TTL_MS) {
    return { voices: voiceCache.voices, cachedAt: voiceCache.at };
  }
  let response: Response;
  try {
    response = await fetch(EDGE_VOICE_LIST_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(VOICE_LIST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EdgeTtsError(502, 'TTS_EDGE_OFFLINE', `Edge 音色列表获取失败：${describeError(error)}`);
  }
  if (!response.ok) {
    throw new EdgeTtsError(502, 'TTS_EDGE_OFFLINE', `Edge 音色列表返回 HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new EdgeTtsError(502, 'TTS_EDGE_OFFLINE', `Edge 音色列表不是合法 JSON：${describeError(error)}`);
  }
  if (!Array.isArray(payload)) {
    throw new EdgeTtsError(502, 'TTS_EDGE_OFFLINE', 'Edge 音色列表格式异常');
  }
  const voices = sortVoices(
    payload.map((raw) => normalizeVoice(raw as RawEdgeVoice)).filter((v): v is EdgeVoice => v !== null),
  );
  if (!voices.length) {
    throw new EdgeTtsError(502, 'TTS_EDGE_OFFLINE', 'Edge 音色列表为空');
  }
  voiceCache = { at: Date.now(), voices };
  return { voices, cachedAt: voiceCache.at };
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

export class EdgeTtsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'EdgeTtsError';
    this.status = status;
    this.code = code;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function dateToString(date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${p(date.getUTCDate())} `
    + `${date.getUTCFullYear()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} `
    + 'GMT+0000 (Coordinated Universal Time)';
}

function cleanText(text: string): string {
  return text
    // 服务端不接受控制字符（尤其垂直制表符），会直接报错
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .trim();
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0.5–2.0 倍速 → Edge prosody rate（百分比）。 */
function speedToRate(speed: number): string {
  const clamped = Number.isFinite(speed) ? Math.min(2, Math.max(0.5, speed)) : 1;
  const pct = Math.round((clamped - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function buildWebSocketFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let head: Buffer;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) body[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([head, mask, body]);
}

export interface EdgeSpeakInput {
  text: string;
  voice: string;
  /** 1 = 原速 */
  speed?: number;
}

const VOICE_ID_PATTERN = /^[A-Za-z]{2,3}-[A-Za-z0-9-]{2,64}$/;

export function validateEdgeVoiceId(voice: string): boolean {
  return VOICE_ID_PATTERN.test(voice);
}

/** 一段文字 → MP3 字节；失败抛 `EdgeTtsError`。 */
export function synthesizeEdge(input: EdgeSpeakInput): Promise<Buffer> {
  const text = cleanText(input.text ?? '');
  if (!text) throw new EdgeTtsError(400, 'TTS_TEXT_EMPTY', '朗读文本为空');
  if (text.length > MAX_TEXT_CHARS) {
    throw new EdgeTtsError(413, 'TTS_TEXT_TOO_LONG', `单段文本过长（上限 ${MAX_TEXT_CHARS} 字）`);
  }
  if (!validateEdgeVoiceId(input.voice)) {
    throw new EdgeTtsError(400, 'TTS_EDGE_VOICE_INVALID', `音色无效：${input.voice}`);
  }

  const connectionId = randomBytes(16).toString('hex');
  const query = new URLSearchParams({
    TrustedClientToken: EDGE_TRUSTED_TOKEN,
    ConnectionId: connectionId,
    'Sec-MS-GEC': secMsGec(),
    'Sec-MS-GEC-Version': EDGE_SEC_MS_GEC_VERSION,
  });
  const major = EDGE_SEC_MS_GEC_VERSION.split('-')[1]!.split('.')[0]!;
  const muid = randomBytes(16).toString('hex').toUpperCase();

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let socket: Duplex | null = null;
    let audio = Buffer.alloc(0);
    let pending = Buffer.alloc(0);
    let fragments: Buffer[] = [];

    const finish = (error: EdgeTtsError | null, result?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* ignore */ }
      if (error) reject(error);
      else resolve(result ?? Buffer.alloc(0));
    };

    const fail = (code: string, message: string, status = 502): void => {
      finish(new EdgeTtsError(status, code, message));
    };

    const timer = setTimeout(() => {
      fail('TTS_EDGE_TIMEOUT', 'Edge 在线音色合成超时（请检查网络或切回系统语音）', 504);
    }, SPEAK_TIMEOUT_MS);

    const handleMessage = (payload: Buffer, binary: boolean): void => {
      if (!binary) {
        if (payload.toString('utf8').includes('Path:turn.end')) {
          if (!audio.length) fail('TTS_EMPTY_AUDIO', 'Edge 在线音色没有返回音频');
          else finish(null, audio);
        }
        return;
      }
      if (payload.length < 2) return;
      const headerLength = payload.readUInt16BE(0);
      const headerEnd = 2 + headerLength;
      if (payload.length < headerEnd) return;
      const header = payload.subarray(2, headerEnd).toString('utf8');
      if (!header.includes('Path:audio')) return;
      const chunk = payload.subarray(headerEnd);
      audio = Buffer.concat([audio, chunk]);
      if (audio.length > MAX_AUDIO_BYTES) {
        fail('TTS_EDGE_TOO_LARGE', 'Edge 在线音色返回音频过大');
      }
    };

    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const fin = (pending[0]! & 0x80) !== 0;
        const opcode = pending[0]! & 0x0f;
        const masked = (pending[1]! & 0x80) !== 0;
        let length = pending[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        let maskKey: Buffer | null = null;
        if (masked) {
          if (pending.length < offset + 4) return;
          maskKey = pending.subarray(offset, offset + 4);
          offset += 4;
        }
        if (length < 0 || length > MAX_AUDIO_BYTES + 65536) {
          fail('TTS_EDGE_PROTOCOL', 'Edge 在线音色返回帧异常');
          return;
        }
        if (pending.length < offset + length) return;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
        pending = pending.subarray(offset + length);

        if (opcode === 0x9) {
          socket?.write(buildWebSocketFrame(0xa, payload));
          continue;
        }
        if (opcode === 0x8) {
          /**
           * ★ 收到关闭帧：有音频 ⇒ 正常结束；**一字节都没有 ⇒ 失败**。
           * 以前这里直接 `finish(null, audio)` ⇒ 未知音色（Edge 握手成功但立刻关连接）
           * 会被当成「合成成功」，路由回 200 + 空 body，前端只能猜「对方返回空响应」。
           */
          if (audio.length) finish(null, audio);
          else fail('TTS_EDGE_VOICE_INVALID', 'Edge 没有为该音色返回音频（音色可能无效）');
          return;
        }
        if (opcode === 0x0) {
          fragments.push(payload);
          if (fin) {
            handleMessage(Buffer.concat(fragments), true);
            fragments = [];
          }
          continue;
        }
        if (!fin) {
          fragments = [payload];
          continue;
        }
        handleMessage(payload, opcode === 0x2);
      }
    };

    const req = https.request({
      host: EDGE_WSS_HOST,
      path: `${EDGE_WSS_PATH}?${query.toString()}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
          + `Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${muid};`,
      },
    });

    req.on('upgrade', (response, upgradedSocket) => {
      if (response.statusCode !== 101) {
        fail('TTS_EDGE_HANDSHAKE', `Edge 在线音色握手失败（HTTP ${response.statusCode}）`);
        return;
      }
      socket = upgradedSocket;
      socket.on('data', onData);
      socket.on('error', (error) => {
        fail('TTS_EDGE_NETWORK', `Edge 在线音色连接中断：${describeError(error)}`);
      });
      socket.on('close', () => {
        if (!settled) {
          if (audio.length) finish(null, audio);
          else fail('TTS_EDGE_NETWORK', 'Edge 在线音色连接被关闭');
        }
      });

      const timestamp = dateToString();
      const config = `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\n`
        + 'Path:speech.config\r\n\r\n'
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: EDGE_OUTPUT_FORMAT,
              },
            },
          },
        }) + '\r\n';
      socket.write(buildWebSocketFrame(0x1, Buffer.from(config, 'utf8')));

      const ssml = '<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'en-US\'>'
        + `<voice name='${input.voice}'><prosody pitch='+0Hz' rate='${speedToRate(input.speed ?? 1)}' volume='+0%'>`
        + `${escapeXml(text)}</prosody></voice></speak>`;
      const ssmlMessage = `X-RequestId:${randomUUID().replace(/-/g, '')}\r\n`
        + 'Content-Type:application/ssml+xml\r\n'
        + `X-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${ssml}`;
      socket.write(buildWebSocketFrame(0x1, Buffer.from(ssmlMessage, 'utf8')));
    });

    req.on('response', (response) => {
      response.resume();
      fail('TTS_EDGE_HANDSHAKE', `Edge 在线音色握手被拒绝（HTTP ${response.statusCode}）`);
    });
    req.on('error', (error) => {
      fail('TTS_EDGE_NETWORK', `Edge 在线音色连接失败：${describeError(error)}`);
    });
    req.end();
  });
}
