/**
 * `#208` **源分享口令**（encode/decode）—— 逐条对齐上游
 * `F:\legado\app\src\main\java\io\legado\app\help\SourceSharePassphrase.kt`（169 行，2026-10-05 读源码提取）。
 *
 * ## 口令是什么
 * 把**一个可下载源文件 json 的 url** 混淆成一段可复制的中英混口令，形如：
 *   `复制口令到阅读导入{混淆url}！sy©{过期戳}¥Legado^`
 * 接收方粘贴口令 → decode 还原 url/类型/过期 → 下载 json → 按类型导入。
 * **混淆可逆**：url 里的 `. / % https:// json com cn …` 按映射表换成同音字/emoji；
 * decode 靠反查表还原（认**所有**替身，不依赖 encode 时随机选中了哪个）。
 *
 * ## 与上游的对齐点（逐条，勿删）
 * - 前缀 `复制口令到阅读导入`；固定尾词 `Legado`（customWord 字段，decode 原样读出）。
 * - 映射表 **17 组**、替身个数与顺序与上游一致（`linkedMapOf` 保序；encode 按 key 长度降序
 *   匹配、decode 按替身长度降序反查 —— 与上游同规则）。
 * - 类型代码 7 种：sy 书源 / dy 订阅(RSS) / zd 字典规则 / jh 替换规则 / ml 目录规则 /
 *   ld 朗读(TTS) / rw 自动任务。一期只**生成** sy，decode 认全部（上游如此）。
 * - 过期戳 = `expiresAt` 毫秒 ÷ 1e6 后**取前 7 位**（上游 `expiresAt.toString().take(7)`，
 *   decode 侧 ×1e6 还原）；`0` = 永久；decode 兼容 1 / 7 / 10 / 13 位四种历史长度。
 * - 过期判定：`expiresAt > 0 && expiresAt < now` ⇒ `expired`。
 * - `canEncode`：url 必须 http(s) 且 host 非空，且**不含**任何替身字面量与 `！©¥^`
 *   （否则口令会被 decode 误切分 ⇒ 拒绝编码）。
 * - 替身随机选择：上游用 `Random(time)`（种子=毫秒时间戳）——decode 不依赖序列，
 *   这里用同种子的简单 LCG 保持「同 url 同时刻 ⇒ 同口令」的可复现性即可，不逐位复刻 XORWOW。
 *
 * ⚠️ 本文件**零 import**（根层纯函数，先例 `json-loose.ts`）—— Web/服务端两端共用。
 */

/** 口令前缀（上游 `PREFIX`） */
export const SOURCE_SHARE_PREFIX = '复制口令到阅读导入';
/** 固定尾词（上游 `CUSTOM_WORD`） */
export const SOURCE_SHARE_CUSTOM_WORD = 'Legado';
/** 有效期上限（天）＝上游 `MAX_EXPIRY_DAYS` */
export const SOURCE_SHARE_MAX_EXPIRY_DAYS = 36500;

const HTTPS_MARKER = '#L:';
const HTTP_MARKER = '#L0:';

/** 口令支持的内容类型（上游 `Type` 枚举，code 一字不差） */
export const SOURCE_SHARE_TYPES = {
  /** 书源 */
  BOOK_SOURCE: 'sy',
  /** 订阅源（RSS） */
  RSS_SOURCE: 'dy',
  /** 字典规则 */
  DICT_RULE: 'zd',
  /** 替换规则 */
  REPLACE_RULE: 'jh',
  /** 目录规则 */
  TOC_RULE: 'ml',
  /** 朗读规则（TTS） */
  TTS_RULE: 'ld',
  /** 自动任务 */
  AUTO_TASK: 'rw',
} as const;

export type SourceShareType = (typeof SOURCE_SHARE_TYPES)[keyof typeof SOURCE_SHARE_TYPES];

export interface SourceShareValue {
  url: string;
  type: SourceShareType;
  /** 过期毫秒时间戳；0 = 永久 */
  expiresAt: number;
  /** 口令尾词（上游恒 `Legado`；decode 原样读出，不参与校验） */
  customWord: string;
}

export type SourceShareDecodeResult =
  | { kind: 'success'; value: SourceShareValue }
  | { kind: 'not-found' }
  | { kind: 'invalid' }
  | { kind: 'expired' };

/** 映射表（上游 `mappings`，17 组；每组替身列表顺序与上游一致） */
const MAPPINGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['https://', [HTTPS_MARKER]],
  ['http://', [HTTP_MARKER]],
  ['.', ['电', '店', '垫', '殿', '。']],
  ['%', ['白', '百', '拜', '摆', '💯']],
  ['/', ['杠', '刚', '钢', '岗', '🎹']],
  ['zip', ['压', '亚', '呀', '牙', '🦆']],
  ['json', ['串', '穿', '船', '传', '🚢']],
  ['4', ['四', '是', '时', '丝', '🕓']],
  ['5', ['五', '武', '误', '勿', '🕔']],
  ['6', ['六', '刘', '留', '陆', '🕕']],
  ['0', ['零', '另', '玲', '灵', '⏰']],
  ['com', ['🛜1', '🌐1', '🌏1']],
  ['cn', ['🛜2', '🌐2', '🌏2']],
  ['net', ['🛜3', '🌐3', '🌏3']],
  ['org', ['🛜7', '🌐7', '🌏7']],
  ['xyz', ['🛜8', '🌐8', '🌏8']],
  ['me', ['🛜9', '🌐9', '🌏9']],
];

/** encode 按 key 长度降序匹配（上游 `encodeKeys`） */
const ENCODE_KEYS = [...MAPPINGS]
  .map(([k]) => k)
  .sort((a, b) => b.length - a.length);
const KEY_TO_REPLACEMENTS = new Map(MAPPINGS);

/** decode 按「替身长度降序」反查（上游 `reverseMappings`） */
const REVERSE: ReadonlyArray<readonly [string, string]> = MAPPINGS.flatMap(
  ([original, replacements]) => replacements.map((r) => [r, original] as const),
).sort((a, b) => b[0].length - a[0].length);

/** encode 拒绝名单 = 全部替身 + 切分符（上游 `unsafeUrlTokens`） */
const UNSAFE_URL_TOKENS: readonly string[] = [
  ...MAPPINGS.flatMap(([, reps]) => reps),
  '！', '©', '¥', '^',
];

/** url 能否被安全编码成口令（上游 `canEncode`） */
export function canEncodeSourceShareUrl(url: string): boolean {
  if (!isSupportedUrl(url)) return false;
  return UNSAFE_URL_TOKENS.every((t) => !url.includes(t));
}

/**
 * 「有效期天数 → 过期毫秒时间戳」的**唯一实现**（`0` = 永久）。
 *
 * 为什么要抽出来：口令里的过期戳是 `String(expiresAt).slice(0, 7)`，
 * 也就是**只精确到 1e6 毫秒（≈16.7 分钟）**。界面要显示「有效期至 X」时若自己算一遍
 * `now + days*86400000`，就会和口令里实际携带的时间**差最多 1e6 毫秒**
 * ⇒ 用户看到的时间与对方 decode 出来的时间不一致（本仓最忌讳的「两个地方各算一遍」）。
 */
export function sourceShareExpiresAt(expiryDays: number, time: number = Date.now()): number {
  const safeDays = Math.max(0, Math.min(expiryDays, SOURCE_SHARE_MAX_EXPIRY_DAYS));
  if (safeDays === 0) return 0;
  const expiresAt = time + safeDays * 24 * 60 * 60 * 1000;
  // 与口令 token 同一精度：先截成 7 位再 ×1e6 还原
  return Number(String(expiresAt).slice(0, 7)) * 1_000_000;
}

/**
 * 生成口令（上游 `encode`）。
 * @param url      可公网下载的源文件地址（http/https）
 * @param type     内容类型（一期生成只传 `'sy'`）
 * @param expiryDays 有效期天数；0 = 永久；超上限按上限收
 * @param time     当前毫秒（随机种子与过期基准；默认 `Date.now()`）
 */
export function encodeSourceSharePassphrase(
  url: string,
  type: SourceShareType,
  expiryDays: number,
  time: number = Date.now(),
): string {
  if (!canEncodeSourceShareUrl(url)) {
    throw new Error('该链接无法安全生成口令（含口令保留字符或非 http/https）');
  }
  const encodedUrl = encodeUrl(url, time);
  const expiresAt = sourceShareExpiresAt(expiryDays, time);
  const expiryToken = String(expiresAt).slice(0, 7); // 上游 take(7)
  return `${SOURCE_SHARE_PREFIX}${encodedUrl}！${type}©${expiryToken}¥${SOURCE_SHARE_CUSTOM_WORD}^`;
}

/** 解析口令（上游 `decode`；text 可含口令之外的其它文字） */
export function decodeSourceSharePassphrase(text: string, time: number = Date.now()): SourceShareDecodeResult {
  const prefixIndex = text.indexOf(SOURCE_SHARE_PREFIX);
  if (prefixIndex < 0) return { kind: 'not-found' };
  const markerSearchStart = prefixIndex + SOURCE_SHARE_PREFIX.length;
  const urlStart = [HTTPS_MARKER, HTTP_MARKER]
    .map((m) => text.indexOf(m, markerSearchStart))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (urlStart === undefined) return { kind: 'invalid' };

  const typeSeparator = text.indexOf('！', urlStart);
  if (typeSeparator <= urlStart) return { kind: 'invalid' };
  const metaSeparator = text.indexOf('©', typeSeparator + 1);
  if (metaSeparator <= typeSeparator + 1) return { kind: 'invalid' };
  const expirySeparator = text.indexOf('¥', metaSeparator + 1);
  if (expirySeparator <= metaSeparator + 1) return { kind: 'invalid' };
  const suffixEnd = text.indexOf('^', expirySeparator + 1);
  if (suffixEnd <= expirySeparator + 1) return { kind: 'invalid' };

  const typeCode = text.slice(typeSeparator + 1, metaSeparator);
  if (!isSourceShareType(typeCode)) return { kind: 'invalid' };

  const expiryToken = text.slice(metaSeparator + 1, expirySeparator);
  if (!/^[0-9]+$/.test(expiryToken)) return { kind: 'invalid' };
  // 上游兼容 1 / 7 / 10 / 13 位四种历史长度
  let expiresAt: number;
  if (expiryToken.length === 1) {
    if (expiryToken !== '0') return { kind: 'invalid' };
    expiresAt = 0;
  } else if (expiryToken.length === 7) {
    expiresAt = Number(expiryToken) * 1_000_000;
  } else if (expiryToken.length === 10) {
    expiresAt = Number(expiryToken) * 1_000;
  } else if (expiryToken.length === 13) {
    expiresAt = Number(expiryToken);
  } else {
    return { kind: 'invalid' };
  }
  if (expiresAt > 0 && expiresAt < time) return { kind: 'expired' };

  const url = decodeUrl(text.slice(urlStart, typeSeparator).trim());
  if (!isSupportedUrl(url)) return { kind: 'invalid' };
  return {
    kind: 'success',
    value: { url, type: typeCode, expiresAt, customWord: text.slice(expirySeparator + 1, suffixEnd) },
  };
}

/** 正向编码：逐段查映射表（替身按 LCG(time) 随机挑，上游是 Random(time)） */
function encodeUrl(url: string, time: number): string {
  let random = (time >>> 0) || 1; // LCG 状态（0 种子无妨，decode 不依赖序列）
  const nextRand = (n: number): number => {
    // 数值上与上游不可比的伪随机；只保证确定性与均匀性
    random = (Math.imul(random, 1103515245) + 12345) >>> 0;
    return random % n;
  };
  let out = '';
  let index = 0;
  while (index < url.length) {
    const key = ENCODE_KEYS.find((k) => url.startsWith(k, index));
    if (key === undefined) {
      out += url[index];
      index += 1;
    } else {
      const reps = KEY_TO_REPLACEMENTS.get(key)!;
      out += reps[nextRand(reps.length)];
      index += key.length;
    }
  }
  return out;
}

/** 反查还原（替身长度降序 ⇒ 长替身优先，避免短替身抢先误吞） */
function decodeUrl(value: string): string {
  let out = '';
  let index = 0;
  while (index < value.length) {
    const mapping = REVERSE.find(([r]) => value.startsWith(r, index));
    if (mapping === undefined) {
      out += value[index];
      index += 1;
    } else {
      out += mapping[1];
      index += mapping[0].length;
    }
  }
  return out;
}

/** http(s) 且 host 非空（上游 `isSupportedUrl`） */
function isSupportedUrl(url: string): boolean {
  if (!url.startsWith('https://') && !url.startsWith('http://')) return false;
  try {
    return new URL(url).host.length > 0;
  } catch {
    return false;
  }
}

function isSourceShareType(code: string): code is SourceShareType {
  return (Object.values(SOURCE_SHARE_TYPES) as string[]).includes(code);
}
