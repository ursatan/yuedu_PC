/**
 * Legado 手机端备份互通 + 本仓完整备份（zip）
 *
 * 设计依据：`docs/ref/legado-backup-interop-2026-11-24.md`（含真实样本实测）。
 *
 * ## 两条硬边界
 * 1. **Legado 兼容模式只做 Legado 支持的项目**：CMS 影视源不进去（Legado 没这个概念）。
 * 2. **书架/进度只互通可确定性重建的书**：网络书且源已存在；本地书、影视书明确跳过并在预检里列明。
 *
 * ## 合并口径（用户 2026-11-24 拍板）
 * - 同名同作者但 `bookUrl` 不同 ⇒ **认领本机已有书**（不新建、不覆盖，只把进度对过去），并给出清单。
 * - 高亮规则不整表替换，按 `uuid` 合并（复用 `importSnapshot` 的 merge 语义）。
 * - `readTime` 首次合并取两边较大值（复用 `importSnapshot` 的 readRecords 规则）。
 * - `read_records` 主键不扩 `author`：同 `(deviceId, bookName)` 但作者不一致 ⇒ 预检阶段拦掉。
 * - 阅读设置只做白名单映射（themeMode / 简繁 / 默认净化 / 手动替换集）。
 *
 * ## 与上游格式
 * 手机端 zip 是「一实体一 JSON」、UTF-8、Gson pretty-print（2 空格）、null 字段省略。
 * 本模块解析时把字段一律当可缺省；导出时写 2 空格缩进。
 */

import {
  BookType,
  LOCAL_TAG,
  emptyBookReadConfig,
  emptyShelfBook,
  encodeItemKey,
  importSnapshot,
  type BookReadConfig,
  type GlobalReaderPrefs,
  type ReadRecord,
  type ShelfBook,
  type UserDataStore,
} from '@yuedu/core';
import { createZip, parseImportText, readZip, type ImportRow } from '@yuedu/facade';
import { SNAPSHOT_ENTRY, readBackupArchive, type BackupOptionId, type BackupSnapshot } from './backup-build';
import { buildSnapshot } from './user-snapshot';

type Rec = Record<string, unknown>;

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v));
const nullableStr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : v == null ? d : v === 'true' || v === 1);
const asList = (v: unknown): Rec[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Rec[]) : []);
const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

/** 主键解码（`encodeItemKey` 的逆） */
export function decodeItemKey(key: string): string {
  return key.replace(/%(00|25)/g, (m) => (m === '%00' ? '\u0000' : '%'));
}

/* ------------------------------------------------------------------ *
 * 勾选项
 * ------------------------------------------------------------------ */

export type LegadoOptionId = 'sources' | 'bookshelf' | 'annotations' | 'rules' | 'history' | 'settings';

export interface OptionMeta {
  id: string;
  label: string;
  desc: string;
  defaultOn: boolean;
  /** 依赖项：勾了本项就必须同时勾这些（成组） */
  requires?: string[];
  sensitive?: boolean;
}

export const LEGADO_OPTIONS: readonly OptionMeta[] = [
  { id: 'sources', label: '书源与订阅源', desc: 'bookSource.json + rssSources.json', defaultOn: true },
  {
    id: 'bookshelf',
    label: '书架与阅读进度',
    desc: '仅「网络书 + 源已存在」；本地书、影视书跳过并在预检里列出',
    defaultOn: true,
  },
  {
    id: 'annotations',
    label: '书签、划线、备注、高亮规则',
    desc: '书签/划线/书内备注跟随书籍；高亮规则按 uuid 合并，不整表替换',
    defaultOn: true,
    requires: ['bookshelf'],
  },
  { id: 'rules', label: '净化 / 字典 / TTS 规则', desc: 'replaceRule / dictRule / httpTTS', defaultOn: true },
  {
    id: 'history',
    label: '阅读记录与搜索历史',
    desc: 'readRecord.json（同主键取较大 readTime）+ searchHistory.json',
    defaultOn: true,
  },
  {
    id: 'settings',
    label: '阅读设置（白名单）',
    desc: '主题模式 / 简繁转换 / 默认净化 / 手动替换规则集',
    defaultOn: true,
  },
];

export type FullOptionId =
  | 'bookshelf'
  | 'chapters'
  | 'annotations'
  | 'rules'
  | 'history'
  | 'settings'
  | 'sources'
  | 'cmsSources'
  | 'tts'
  | 'cookies'
  | 'sourceVariables';

export const FULL_OPTIONS: readonly OptionMeta[] = [
  { id: 'bookshelf', label: '书架与进度', desc: '含本地书/影视书索引（正文与音频缓存不在备份里）', defaultOn: true },
  { id: 'chapters', label: '书籍目录', desc: '体量大；不含正文', defaultOn: false, requires: ['bookshelf'] },
  {
    id: 'annotations',
    label: '书签、标注与书内备注',
    desc: '书签 / 划线 / 书内备注 / 高亮规则（按主键合并）',
    defaultOn: true,
    requires: ['bookshelf'],
  },
  { id: 'rules', label: '规则与工具', desc: '替换净化 + 字典规则', defaultOn: true },
  { id: 'history', label: '阅读记录与搜索历史', desc: '各书累计阅读时长 + 搜索历史', defaultOn: true },
  { id: 'settings', label: '阅读设置', desc: '全局阅读偏好', defaultOn: true },
  { id: 'sources', label: '书源与订阅源', desc: '全部书源 + RSS 订阅源', defaultOn: true },
  { id: 'cmsSources', label: 'CMS 影视源', desc: '本项目独有数据', defaultOn: true },
  {
    id: 'tts',
    label: 'TTS 引擎',
    desc: '引擎配置（不含 header 里的 API Key）',
    defaultOn: true,
  },
  {
    id: 'cookies',
    label: '持久 Cookie',
    desc: '需口令；AES 加密存放',
    defaultOn: false,
    sensitive: true,
  },
  {
    id: 'sourceVariables',
    label: '源变量',
    desc: '需口令；AES 加密存放',
    defaultOn: false,
    sensitive: true,
  },
];

export class BackupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

function normalizeOptions(input: unknown, meta: readonly OptionMeta[]): string[] {
  if (input === undefined || input === null) return meta.filter((o) => o.defaultOn).map((o) => o.id);
  if (!Array.isArray(input)) throw new BackupError('BAD_OPTIONS', '勾选项必须是数组');
  const known = new Set(meta.map((o) => o.id));
  const out: string[] = [];
  const unknown: string[] = [];
  for (const raw of input) {
    const id = String(raw ?? '').trim();
    if (!id) continue;
    if (!known.has(id)) unknown.push(id);
    else if (!out.includes(id)) out.push(id);
  }
  if (unknown.length) throw new BackupError('UNKNOWN_OPTION', `未知的备份内容：${unknown.join('、')}`);
  if (out.length === 0) throw new BackupError('EMPTY_OPTIONS', '至少要勾选一项备份内容');
  for (const o of meta) {
    if (out.includes(o.id) && o.requires?.some((r) => !out.includes(r))) {
      throw new BackupError(
        'DEPENDENCY',
        `「${o.label}」依赖 ${o.requires.map((r) => meta.find((m) => m.id === r)?.label ?? r).join('、')}，必须一起勾选`,
      );
    }
  }
  return out;
}

export function normalizeLegadoOptions(input: unknown): LegadoOptionId[] {
  return normalizeOptions(input, LEGADO_OPTIONS) as LegadoOptionId[];
}

export function normalizeFullOptions(input: unknown): FullOptionId[] {
  return normalizeOptions(input, FULL_OPTIONS) as FullOptionId[];
}

/* ------------------------------------------------------------------ *
 * 源索引
 * ------------------------------------------------------------------ */

export interface SourceRuntimeEntry {
  id: string;
  kind: string;
  raw: Rec;
}

export interface SourceIndexSource {
  id: string;
  kind: string;
  name: string;
  identity: string;
  raw: Rec;
}

export interface SourceIndex {
  byIdentity: Map<string, SourceIndexSource[]>;
  byId: Map<string, SourceIndexSource>;
  all: SourceIndexSource[];
}

export function buildSourceIndex(rows: readonly SourceRuntimeEntry[]): SourceIndex {
  const all: SourceIndexSource[] = [];
  const byIdentity = new Map<string, SourceIndexSource[]>();
  const byId = new Map<string, SourceIndexSource>();
  for (const r of rows) {
    const raw = (r.raw ?? {}) as Rec;
    const identity = str(raw['bookSourceUrl'] ?? raw['sourceUrl'] ?? raw['api']);
    const name = str(raw['bookSourceName'] ?? raw['sourceName'] ?? raw['name']);
    const item: SourceIndexSource = { id: r.id, kind: r.kind, name, identity, raw };
    all.push(item);
    byId.set(r.id, item);
    if (identity) {
      const arr = byIdentity.get(identity) ?? [];
      arr.push(item);
      byIdentity.set(identity, arr);
    }
  }
  return { byIdentity, byId, all };
}

/* ------------------------------------------------------------------ *
 * 解析 Legado zip
 * ------------------------------------------------------------------ */

const ENTRY_ALIASES: Record<string, string[]> = {
  books: ['bookshelf.json', 'books.json'],
  bookGroups: ['bookGroup.json', 'bookGroups.json'],
  bookmarks: ['bookmark.json', 'bookmarks.json'],
  highlights: ['highlight.json', 'highlights.json'],
  highlightRules: ['highlightRule.json', 'highlightRules.json'],
  bookSources: ['bookSource.json', 'bookSources.json'],
  rssSources: ['rssSources.json', 'rssSource.json'],
  replaceRules: ['replaceRule.json', 'replaceRules.json'],
  dictRules: ['dictRule.json', 'dictRules.json'],
  httpTts: ['httpTTS.json', 'httpTts.json'],
  readRecords: ['readRecord.json', 'readRecords.json'],
  searchHistory: ['searchHistory.json'],
  txtTocRules: ['txtTocRule.json'],
  keyboardAssists: ['keyboardAssists.json'],
  autoTasks: ['autoTask.json'],
  coverRules: ['coverRule.json'],
  servers: ['servers.json'],
  bookMemo: ['bookMemo.json'],
};

const KNOWN_ENTRY_NAMES = new Set([
  ...Object.values(ENTRY_ALIASES).flat(),
  'config.xml',
  'videoConfig.xml',
  'readConfig.json',
  'shareReadConfig.json',
  'themeConfig.json',
  'cookies.json',
  'runtimeSourceCache.json',
]);

export interface ParsedLegadoArchive {
  files: Map<string, Uint8Array>;
  present: Set<string>;
  unknownEntries: string[];
  parseErrors: Array<{ entry: string; error: string }>;
  books: Rec[];
  bookGroups: Rec[];
  bookmarks: Rec[];
  highlights: Rec[];
  highlightRules: Rec[];
  bookSources: Rec[];
  rssSources: Rec[];
  replaceRules: Rec[];
  dictRules: Rec[];
  httpTts: Rec[];
  readRecords: Rec[];
  searchHistory: Rec[];
  txtTocRules: Rec[];
  keyboardAssists: Rec[];
  autoTasks: Rec[];
  coverRules: Rec[];
  servers: Rec[];
  bookMemo: Rec[];
  configXml: string | null;
  /** 老版书源格式（对象 map，不是数组） */
  legacyBookSourceMap: boolean;
}

function basename(name: string): string {
  return String(name).split(/[\\/]/).pop() ?? String(name);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

export function readLegadoArchive(bytes: Uint8Array): ParsedLegadoArchive {
  let files: Map<string, Uint8Array>;
  try {
    files = readZip(bytes);
  } catch (e) {
    throw new BackupError('NOT_A_ZIP', `这不是有效的 zip：${e instanceof Error ? e.message : String(e)}`);
  }
  const byBase = new Map<string, Uint8Array>();
  for (const [name, data] of files) byBase.set(basename(name), data);

  const present = new Set(byBase.keys());
  const unknownEntries = [...present].filter((n) => !KNOWN_ENTRY_NAMES.has(n) && !/^(covers|bg|readRecordCovers)\//.test(n));
  const parseErrors: ParsedLegadoArchive['parseErrors'] = [];

  const readList = (keys: string[], legacyMap = false): Rec[] => {
    for (const k of keys) {
      const buf = byBase.get(k);
      if (!buf) continue;
      try {
        const v = JSON.parse(decodeUtf8(buf)) as unknown;
        if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object') as Rec[];
        if (legacyMap && v && typeof v === 'object') return Object.values(v).filter((x) => x && typeof x === 'object') as Rec[];
        parseErrors.push({ entry: k, error: '不是 JSON 数组' });
        return [];
      } catch (e) {
        parseErrors.push({ entry: k, error: e instanceof Error ? e.message : String(e) });
        return [];
      }
    }
    return [];
  };

  const out: ParsedLegadoArchive = {
    files,
    present,
    unknownEntries,
    parseErrors,
    books: readList(ENTRY_ALIASES.books!),
    bookGroups: readList(ENTRY_ALIASES.bookGroups!),
    bookmarks: readList(ENTRY_ALIASES.bookmarks!),
    highlights: readList(ENTRY_ALIASES.highlights!),
    highlightRules: readList(ENTRY_ALIASES.highlightRules!),
    bookSources: readList(ENTRY_ALIASES.bookSources!, true),
    rssSources: readList(ENTRY_ALIASES.rssSources!),
    replaceRules: readList(ENTRY_ALIASES.replaceRules!),
    dictRules: readList(ENTRY_ALIASES.dictRules!),
    httpTts: readList(ENTRY_ALIASES.httpTts!),
    readRecords: readList(ENTRY_ALIASES.readRecords!),
    searchHistory: readList(ENTRY_ALIASES.searchHistory!),
    txtTocRules: readList(ENTRY_ALIASES.txtTocRules!),
    keyboardAssists: readList(ENTRY_ALIASES.keyboardAssists!),
    autoTasks: readList(ENTRY_ALIASES.autoTasks!),
    coverRules: readList(ENTRY_ALIASES.coverRules!),
    servers: readList(ENTRY_ALIASES.servers!),
    bookMemo: readList(ENTRY_ALIASES.bookMemo!),
    configXml: null,
    legacyBookSourceMap: false,
  };
  const cfg = byBase.get('config.xml');
  if (cfg) out.configXml = decodeUtf8(cfg);
  const srcRaw = byBase.get('bookSource.json') ?? byBase.get('bookSources.json');
  if (srcRaw) {
    try {
      const v = JSON.parse(decodeUtf8(srcRaw)) as unknown;
      out.legacyBookSourceMap = !!v && typeof v === 'object' && !Array.isArray(v);
    } catch {
      /* 已在 readList 里记录 */
    }
  }
  return out;
}

/** 判断一个 zip 是不是 Legado 备份（本仓完整备份一定带 `yuedu-snapshot.json`） */
export function detectArchiveKind(files: Map<string, Uint8Array>): 'legado' | 'full' {
  for (const name of files.keys()) if (basename(name) === SNAPSHOT_ENTRY) return 'full';
  return 'legado';
}

/* ------------------------------------------------------------------ *
 * 书籍判定 / 映射
 * ------------------------------------------------------------------ */

export function isLocalBook(rawUrl: string, origin: string, type: number, bookUrl?: string): boolean {
  if (origin === LOCAL_TAG) return true;
  if ((type & BookType.local) !== 0) return true;
  if (/^(content:|data:|file:)/i.test(rawUrl)) return true;
  if (/^[A-Za-z]:[\\/]/.test(rawUrl)) return true;
  if (bookUrl && decodeItemKey(bookUrl).startsWith(`${LOCAL_TAG}\u0000`)) return true;
  if (origin.startsWith('webDav::')) return true;
  return false;
}

export function isVideoBook(type: number): boolean {
  return (type & BookType.video) !== 0;
}

function mapBookReadConfig(raw: unknown): BookReadConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Rec;
  const out = emptyBookReadConfig();
  for (const key of Object.keys(out) as Array<keyof BookReadConfig>) {
    const v = src[key];
    if (v === undefined || v === null) continue;
    if (key === 'manualReplaceRuleIds') {
      if (Array.isArray(v)) out.manualReplaceRuleIds = v.map((x) => num(x, 0)).filter((x) => x > 0);
      continue;
    }
    (out as unknown as Rec)[key] = v;
  }
  return out;
}

function jsonText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 高亮样式：Legado ARGB 整数 ↔ 本仓 CSS 串
 * ------------------------------------------------------------------ */

/**
 * ARGB 整数 → CSS 颜色串。
 *
 * `0` 在上游是「不画 / 跟随文字色」的双关哨兵（`HighlightStyle.kt`：`fill=0` 不画、
 * `Deco.color=0` 用 fallbackColor）⇒ 这里统一返回 `null`，由调用方按通道决定语义。
 */
export function argbToCss(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  const u = n >>> 0; // 负数 ARGB（Java Int）按无符号解释
  const a = (u >>> 24) & 0xff;
  const r = (u >>> 16) & 0xff;
  const g = (u >>> 8) & 0xff;
  const b = u & 0xff;
  return `rgba(${r},${g},${b},${Number((a / 255).toFixed(3))})`;
}

function hex2(v: string): number {
  return Number.parseInt(v, 16);
}

/** CSS 颜色串（`#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`）→ ARGB 整数；认不出 ⇒ 0 */
export function cssToArgb(css: unknown): number {
  if (typeof css !== 'string') return 0;
  const s = css.trim();
  if (!s) return 0;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) h = `ff${h}`;
    if (h.length !== 8) return 0;
    return (((hex2(h.slice(0, 2)) << 24) | (hex2(h.slice(2, 4)) << 16) | (hex2(h.slice(4, 6)) << 8) | hex2(h.slice(6, 8))) | 0);
  }
  const m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return 0;
  const clamp = (x: number, max: number) => Math.max(0, Math.min(max, Math.round(x)));
  const r = clamp(Number(m[1]), 255);
  const g = clamp(Number(m[2]), 255);
  const b = clamp(Number(m[3]), 255);
  let a = 1;
  if (m[4] !== undefined) {
    a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (!Number.isFinite(a)) a = 1;
    a = Math.max(0, Math.min(1, a));
  }
  // Legado 是 Java Int（ARGB 常为负数）⇒ 这里也返回有符号 32 位
  return ((Math.round(a * 255) << 24) | (r << 16) | (g << 8) | b) | 0;
}

const LEGADO_SHAPES: Record<string, string> = {
  RECTANGLE: 'rectangle', ROUNDED: 'rounded', PILL: 'pill',
  MARKER: 'marker', HALF: 'half', BASELINE: 'baseline',
};
const CSS_SHAPE_TO_LEGADO: Record<string, string> = {
  rectangle: 'RECTANGLE', rounded: 'ROUNDED', pill: 'PILL',
  marker: 'MARKER', half: 'HALF', baseline: 'BASELINE',
};
const LEGADO_UNDERLINES: Record<string, string> = {
  SOLID: 'solid', WAVY: 'wavy', DASHED: 'dashed', DOTTED: 'dotted', DOUBLE: 'double',
};
const CSS_UNDERLINE_TO_LEGADO: Record<string, string> = {
  solid: 'SOLID', wavy: 'WAVY', dashed: 'DASHED', dotted: 'DOTTED', double: 'DOUBLE',
};

/** Legado `style`（JSON 字符串或对象）→ 本仓 `BookHighlight.style`（CSS 样式 JSON 串） */
export function legadoHighlightStyleToCss(raw: unknown): string {
  let o: Rec | null = null;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw) as Rec;
    } catch {
      o = null;
    }
  } else if (raw && typeof raw === 'object') {
    o = raw as Rec;
  }
  if (!o) return '';
  const out: Rec = {};
  const fill = argbToCss(o['fill']);
  if (fill) out['fill'] = fill;
  out['fillShape'] = LEGADO_SHAPES[str(o['fillShape']).toUpperCase()] ?? 'rectangle';
  const textColor = argbToCss(o['textColor']);
  if (textColor) out['textColor'] = textColor;
  const u = o['underline'];
  if (u && typeof u === 'object') {
    const uo = u as Rec;
    const width = num(uo['width'], 1);
    // 上游 `width <= 0` ⇒ 不画（不是「最细的一条」）
    if (width > 0) {
      out['underline'] = {
        kind: LEGADO_UNDERLINES[str(uo['kind']).toUpperCase()] ?? 'solid',
        color: argbToCss(uo['color']),
        width,
        distance: num(uo['distance'], 0),
      };
    }
  }
  for (const key of ['strike', 'box', 'emphasis'] as const) {
    const d = o[key];
    // 对象存在 = 通道开启；color=0 ⇒ 跟随文字色（null）
    if (d && typeof d === 'object') out[key] = { color: argbToCss((d as Rec)['color']) };
  }
  const sh = o['shadow'];
  if (sh && typeof sh === 'object') {
    const so = sh as Rec;
    out['shadow'] = {
      radius: num(so['radius'], 3),
      dx: num(so['dx'], 2),
      dy: num(so['dy'], 2),
      color: argbToCss(so['color']) ?? 'rgba(0,0,0,.5)',
    };
  }
  if (o['bold'] === true) out['bold'] = true;
  if (o['italic'] === true) out['italic'] = true;
  return JSON.stringify(out);
}

/** 本仓 `BookHighlight.style`（CSS 串）→ Legado `HighlightStyle` 对象（导出写回手机端） */
export function cssHighlightStyleToLegado(raw: unknown): Rec {
  let o: Rec = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      o = JSON.parse(raw) as Rec;
    } catch {
      o = {};
    }
  } else if (raw && typeof raw === 'object') {
    o = raw as Rec;
  }
  const out: Rec = {
    fill: cssToArgb(o['fill']),
    fillShape: CSS_SHAPE_TO_LEGADO[str(o['fillShape'])] ?? 'RECTANGLE',
    textColor: cssToArgb(o['textColor']),
    fontPath: '',
    bold: o['bold'] === true,
    italic: o['italic'] === true,
    strike: null,
    underline: null,
    box: null,
    emphasis: null,
    shadow: null,
  };
  const u = o['underline'];
  if (u && typeof u === 'object') {
    const uo = u as Rec;
    const width = num(uo['width'], 1);
    if (width > 0) {
      out['underline'] = {
        kind: CSS_UNDERLINE_TO_LEGADO[str(uo['kind'])] ?? 'SOLID',
        color: cssToArgb(uo['color']),
        width,
        distance: num(uo['distance'], 0),
      };
    }
  }
  for (const key of ['strike', 'box', 'emphasis'] as const) {
    const d = o[key];
    if (d === true) out[key] = { color: 0 };
    else if (d && typeof d === 'object') out[key] = { color: cssToArgb((d as Rec)['color']) };
  }
  const sh = o['shadow'];
  if (sh && typeof sh === 'object') {
    const so = sh as Rec;
    out['shadow'] = {
      radius: num(so['radius'], 3),
      dx: num(so['dx'], 2),
      dy: num(so['dy'], 2),
      color: cssToArgb(so['color']),
    };
  }
  return out;
}

function shelfFromLegadoBook(raw: Rec, src: SourceIndexSource, rawUrl: string): ShelfBook {
  const b = emptyShelfBook();
  b.bookUrl = encodeItemKey(`${src.id}\u0000${rawUrl}`);
  b.tocUrl = str(raw['tocUrl']);
  b.origin = src.id;
  b.originName = src.name || str(raw['originName']);
  b.name = str(raw['name']);
  b.author = str(raw['author']);
  b.kind = nullableStr(raw['kind']);
  b.customTag = nullableStr(raw['customTag']);
  b.coverUrl = nullableStr(raw['coverUrl']);
  b.customCoverUrl = nullableStr(raw['customCoverUrl']);
  b.intro = nullableStr(raw['intro']);
  b.customIntro = nullableStr(raw['customIntro']);
  b.charset = nullableStr(raw['charset']);
  b.type = num(raw['type'], BookType.text);
  b.group = num(raw['group'], 0);
  b.latestChapterTitle = nullableStr(raw['latestChapterTitle']);
  b.latestChapterTime = num(raw['latestChapterTime'], 0);
  b.lastCheckTime = num(raw['lastCheckTime'], 0);
  b.lastCheckCount = num(raw['lastCheckCount'], 0);
  b.totalChapterNum = num(raw['totalChapterNum'], 0);
  b.durChapterTitle = nullableStr(raw['durChapterTitle']);
  b.durChapterIndex = num(raw['durChapterIndex'], 0);
  b.durVolumeIndex = num(raw['durVolumeIndex'], 0);
  b.chapterInVolumeIndex = num(raw['chapterInVolumeIndex'], 0);
  b.durChapterPos = num(raw['durChapterPos'], 0);
  b.durChapterTime = num(raw['durChapterTime'], 0);
  b.wordCount = nullableStr(raw['wordCount']);
  b.canUpdate = bool(raw['canUpdate'], true);
  b.order = num(raw['order'], 0);
  b.originOrder = num(raw['originOrder'], 0);
  b.variable = jsonText(raw['variable']);
  b.readConfig = mapBookReadConfig(raw['readConfig']);
  b.syncTime = 0;
  b.persistedCoverUrl = null;
  b.payload = JSON.stringify({ bookUrl: rawUrl });
  b.readStyle = null;
  b.progressSec = undefined;
  b.durationSec = undefined;
  return b;
}

interface BookPlanEntry {
  raw: Rec;
  rawUrl: string;
  name: string;
  author: string;
  type: number;
  sourceId: string | null;
  sourceName: string;
  bookUrl: string | null;
  action: 'create' | 'progress' | 'claim' | 'skipLocal' | 'skipVideo' | 'skipSource';
  /** claim/progress 时的本机目标 */
  targetBookUrl?: string;
  targetOrigin?: string;
  /** 本次是否会推进进度 */
  progressNewer?: boolean;
}

function progressNewer(incoming: Rec, existing: ShelfBook | undefined): boolean {
  if (!existing) return true;
  const t = num(incoming['durChapterTime'], 0);
  if (t <= 0) return false;
  return t > existing.durChapterTime;
}

/**
 * 书架的预检 + 执行计划（不写库）。
 *
 * 规则：同名同作者但 `bookUrl` 不同 ⇒ 认领本机已有网络书（不新建、不覆盖），只把进度对过去。
 */
export function planLegadoBooks(
  incoming: readonly Rec[],
  index: SourceIndex,
  existingBooks: readonly ShelfBook[],
): BookPlanEntry[] {
  const existingByUrl = new Map(existingBooks.map((b) => [b.bookUrl, b]));
  const claimable = new Map<string, ShelfBook>();
  for (const b of existingBooks) {
    if (isLocalBook('', b.origin, b.type, b.bookUrl) || isVideoBook(b.type)) continue;
    const key = `${b.name}\u0000${b.author}`;
    if (!claimable.has(key)) claimable.set(key, b);
  }
  const out: BookPlanEntry[] = [];
  for (const raw of incoming) {
    const rawUrl = str(raw['bookUrl']);
    const origin = str(raw['origin']);
    const type = num(raw['type'], BookType.text);
    const name = str(raw['name']);
    const author = str(raw['author']);
    const base: BookPlanEntry = {
      raw, rawUrl, name, author, type, sourceId: null, sourceName: str(raw['originName']),
      bookUrl: null, action: 'skipSource',
    };
    if (!rawUrl) {
      base.action = 'skipSource';
      out.push(base);
      continue;
    }
    if (isLocalBook(rawUrl, origin, type)) {
      base.action = 'skipLocal';
      out.push(base);
      continue;
    }
    if (isVideoBook(type)) {
      base.action = 'skipVideo';
      out.push(base);
      continue;
    }
    const src = index.byIdentity.get(origin)?.[0];
    if (!src) {
      base.action = 'skipSource';
      out.push(base);
      continue;
    }
    const bookUrl = encodeItemKey(`${src.id}\u0000${rawUrl}`);
    base.sourceId = src.id;
    base.sourceName = src.name || base.sourceName;
    base.bookUrl = bookUrl;
    const same = existingByUrl.get(bookUrl);
    if (same) {
      base.action = 'progress';
      base.targetBookUrl = same.bookUrl;
      base.targetOrigin = same.origin;
      base.progressNewer = progressNewer(raw, same);
      out.push(base);
      continue;
    }
    const claimed = claimable.get(`${name}\u0000${author}`);
    if (claimed && claimed.bookUrl !== bookUrl) {
      base.action = 'claim';
      base.targetBookUrl = claimed.bookUrl;
      base.targetOrigin = claimed.origin;
      base.progressNewer = progressNewer(raw, claimed);
      out.push(base);
      continue;
    }
    base.action = 'create';
    out.push(base);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 阅读记录预检
 * ------------------------------------------------------------------ */

export interface ReadRecordConflict {
  deviceId: string;
  bookName: string;
  authors: string[];
  reason: 'incoming-multi-author' | 'local-different-author';
}

export function splitReadRecords(incoming: readonly Rec[], existing: readonly ReadRecord[]): {
  ok: Rec[];
  conflicts: ReadRecordConflict[];
} {
  const local = new Map(existing.map((r) => [`${r.deviceId}\u0000${r.bookName}`, r]));
  const groups = new Map<string, Rec[]>();
  for (const r of incoming) {
    const deviceId = str(r['deviceId']);
    const bookName = str(r['bookName']);
    if (!bookName) continue;
    const key = `${deviceId}\u0000${bookName}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const ok: Rec[] = [];
  const conflicts: ReadRecordConflict[] = [];
  for (const [key, rows] of groups) {
    const authors = [...new Set(rows.map((r) => str(r['author'])).filter(Boolean))];
    const [deviceId = '', bookName = ''] = key.split('\u0000');
    if (authors.length > 1) {
      conflicts.push({ deviceId, bookName, authors, reason: 'incoming-multi-author' });
      continue;
    }
    const ex = local.get(key);
    if (ex && ex.author && authors[0] && ex.author !== authors[0]) {
      conflicts.push({ deviceId, bookName, authors: [ex.author, authors[0]], reason: 'local-different-author' });
      continue;
    }
    ok.push(...rows);
  }
  return { ok, conflicts };
}

/* ------------------------------------------------------------------ *
 * 设置白名单（config.xml）
 * ------------------------------------------------------------------ */

const SETTINGS_MAP: ReadonlyArray<{
  xml: string;
  prefs: keyof GlobalReaderPrefs;
  label: string;
  type: 'string' | 'int' | 'boolean';
}> = [
  { xml: 'themeMode', prefs: 'themeMode', label: '主题模式', type: 'string' },
  { xml: 'chineseConverterType', prefs: 'chineseConverterType', label: '简繁转换', type: 'int' },
  { xml: 'replaceEnableDefault', prefs: 'replaceEnableDefault', label: '默认启用净化', type: 'boolean' },
  { xml: 'manualReplaceRule', prefs: 'manualReplaceRuleEnabled', label: '手动替换规则集', type: 'boolean' },
];

export interface ParsedSetting {
  xml: string;
  label: string;
  value: string;
  prefs: keyof GlobalReaderPrefs;
  parsed: string | number | boolean;
}

export function parseLegadoSettings(xml: string | null): { mapped: ParsedSetting[]; unmapped: string[] } {
  if (!xml) return { mapped: [], unmapped: [] };
  const values = new Map<string, string>();
  const selfClosing = /<(int|string|boolean|long|float|set)\s+name="([^"]+)"\s+value="([^"]*)"/g;
  for (const m of xml.matchAll(selfClosing)) values.set(m[2]!, m[3]!);
  const textForm = /<string\s+name="([^"]+)"\s*>([^<]*)<\/string>/g;
  for (const m of xml.matchAll(textForm)) values.set(m[1]!, m[2]!);
  const mapped: ParsedSetting[] = [];
  const used = new Set<string>();
  for (const def of SETTINGS_MAP) {
    const v = values.get(def.xml);
    if (v === undefined) continue;
    used.add(def.xml);
    let parsed: string | number | boolean;
    if (def.type === 'int') parsed = num(v, 0);
    else if (def.type === 'boolean') parsed = bool(v, true);
    else parsed = v;
    mapped.push({ xml: def.xml, label: def.label, value: v, prefs: def.prefs, parsed });
  }
  const unmapped = [...values.keys()].filter((k) => !used.has(k));
  return { mapped, unmapped };
}

/* ------------------------------------------------------------------ *
 * 预检报告
 * ------------------------------------------------------------------ */

export interface LegadoPreview {
  mode: 'legado';
  token: string;
  entries: Array<{ name: string; bytes: number; recognized: boolean }>;
  unknownEntries: string[];
  parseErrors: Array<{ entry: string; error: string }>;
  options: Array<OptionMeta & { count: number }>;
  books: {
    total: number;
    rebuildable: number;
    create: number;
    progress: number;
    claimed: number;
    local: number;
    video: number;
    sourceMissing: number;
    claimItems: Array<{ name: string; author: string; incoming: string; localBookUrl: string; localOrigin: string }>;
    progressItems: Array<{ name: string; author: string; incoming: string; localBookUrl: string }>;
    skippedItems: Array<{ name: string; author: string; rawUrl: string; why: string }>;
  };
  annotations: {
    bookmarks: number;
    orphanBookmarks: number;
    highlights: number;
    orphanHighlights: number;
    /** 书内备注（Legado `bookMemo.json`） */
    bookMemos: number;
    orphanBookMemos: number;
    highlightRules: number;
    highlightRuleConflicts: number;
  };
  rules: { replaceRules: number; replaceConflicts: number; dictRules: number; httpTts: number };
  history: { readRecords: number; conflicts: number; conflictItems: ReadRecordConflict[]; searchHistory: number };
  settings: { mapped: ParsedSetting[]; unmapped: number };
  skipped: Array<{ entry: string; why: string; count: number }>;
  warnings: string[];
}

/** 预检（不写库）。token 由调用方（路由）注入，便于“确认页”复用同一份已解析内容。 */
export async function previewLegado(
  archive: ParsedLegadoArchive,
  optionsInput: unknown,
  store: UserDataStore,
  sources: SourceIndex,
  token = '',
): Promise<LegadoPreview> {
  const options = normalizeLegadoOptions(optionsInput);
  const has = (id: LegadoOptionId) => options.includes(id);
  const existingBooks = has('bookshelf') ? await store.listBooks() : [];
  const plan = has('bookshelf') ? planLegadoBooks(archive.books, sources, existingBooks) : [];
  const create = plan.filter((p) => p.action === 'create');
  const progress = plan.filter((p) => p.action === 'progress');
  const claim = plan.filter((p) => p.action === 'claim');
  const local = plan.filter((p) => p.action === 'skipLocal');
  const video = plan.filter((p) => p.action === 'skipVideo');
  const noSource = plan.filter((p) => p.action === 'skipSource');

  // 标注：先算“可落地的书”
  const existingByName = new Set(existingBooks.map((b) => `${b.name}\u0000${b.author}`));
  const existingByNameOnly = new Set(existingBooks.map((b) => b.name));
  for (const p of [...create, ...progress, ...claim]) {
    existingByName.add(`${p.name}\u0000${p.author}`);
    existingByNameOnly.add(p.name);
  }
  const rawToTarget = new Map<string, string>();
  for (const b of existingBooks) {
    const dec = decodeItemKey(b.bookUrl);
    const i = dec.indexOf('\u0000');
    if (i > 0) rawToTarget.set(dec.slice(i + 1), b.bookUrl);
  }
  for (const p of [...create, ...progress, ...claim]) {
    if (p.bookUrl) rawToTarget.set(p.rawUrl, p.bookUrl);
  }
  const ornamentsEnabled = has('annotations');
  const orphanBookmarks = ornamentsEnabled
    ? archive.bookmarks.filter((b) => {
        const n = str(b['bookName']);
        const a = str(b['bookAuthor']);
        return !(existingByName.has(`${n}\u0000${a}`) || existingByNameOnly.has(n));
      }).length
    : 0;
  const orphanHighlights = ornamentsEnabled
    ? archive.highlights.filter((h) => !rawToTarget.has(str(h['bookUrl']))).length
    : 0;
  const orphanBookMemos = ornamentsEnabled
    ? archive.bookMemo.filter((m) => {
        const n = str(m['bookName']);
        const a = str(m['bookAuthor']);
        return !(existingByName.has(`${n}\u0000${a}`) || existingByNameOnly.has(n));
      }).length
    : 0;
  const localRuleUuids = new Set(
    ornamentsEnabled ? (await store.listHighlightRules()).map((r) => r.uuid.toLowerCase()) : [],
  );
  const highlightRuleConflicts = ornamentsEnabled
    ? archive.highlightRules.filter((r) => localRuleUuids.has(str(r['uuid']).toLowerCase())).length
    : 0;

  const localRules = has('rules') ? await store.listReplaceRules() : [];
  const localRuleById = new Map(localRules.map((r) => [r.id, r]));
  const replaceConflicts = has('rules')
    ? archive.replaceRules.filter((r) => {
        const ex = localRuleById.get(num(r['id'], -1));
        return !!ex && (ex.name !== str(r['name']) || ex.pattern !== str(r['pattern']) || ex.replacement !== str(r['replacement']));
      }).length
    : 0;

  const localRead = has('history') ? await store.listReadRecords() : [];
  const readSplit = has('history') ? splitReadRecords(archive.readRecords, localRead) : { ok: [], conflicts: [] };
  const settings = has('settings') ? parseLegadoSettings(archive.configXml) : { mapped: [], unmapped: [] };

  const skipped: LegadoPreview['skipped'] = [];
  const addSkip = (entry: string, why: string, count: number) => {
    if (count > 0) skipped.push({ entry, why, count });
  };
  addSkip('txtTocRule.json', '本仓没有 TXT 目录规则（本地书按章节正则解析，不读该表）', archive.txtTocRules.length);
  addSkip('keyboardAssists.json', 'PC 端无键盘辅助方案概念', archive.keyboardAssists.length);
  addSkip('autoTask.json', '本仓无自动任务', archive.autoTasks.length);
  addSkip('coverRule.json', '本仓封面来自源 URL，无封面规则表', archive.coverRules.length);
  addSkip('servers.json', '本仓 WebDAV 配置是独立文件且含密码，不导入手机端 servers', archive.servers.length);
  addSkip('本地书', '手机端绝对路径无法映射到本机文件，需在 PC 端重新导入', local.length);
  addSkip('影视书', 'Legado 兼容模式不含 CMS 影视源', video.length);
  addSkip('源不存在', '手机端书源 URL 在本机源库中不存在，无法重建 bookUrl', noSource.length);

  const warnings: string[] = [];
  if (archive.legacyBookSourceMap) warnings.push('bookSource.json 是老版「对象 map」格式，已按值数组读取');
  if (archive.parseErrors.length) warnings.push(`有 ${archive.parseErrors.length} 个条目解析失败（见 parseErrors）`);
  if (progress.length && claim.length) warnings.push('存在同名同作者的认领项：只迁移进度，不新建、不覆盖本机书');
  if (readSplit.conflicts.length) warnings.push(`有 ${readSplit.conflicts.length} 条阅读记录因 author 冲突被拦下（主键不含 author）`);

  const entries = [...archive.files.entries()].map(([name, data]) => ({
    name: basename(name),
    bytes: data.length,
    recognized: KNOWN_ENTRY_NAMES.has(basename(name)),
  }));

  const opts: Array<OptionMeta & { count: number }> = LEGADO_OPTIONS.map((o) => ({
    ...o,
    count:
      o.id === 'sources'
        ? archive.bookSources.length + archive.rssSources.length
        : o.id === 'bookshelf'
          ? archive.books.length
          : o.id === 'annotations'
            ? archive.bookmarks.length + archive.highlights.length + archive.bookMemo.length + archive.highlightRules.length
            : o.id === 'rules'
              ? archive.replaceRules.length + archive.dictRules.length + archive.httpTts.length
              : o.id === 'history'
                ? archive.readRecords.length + archive.searchHistory.length
                : settings.mapped.length,
  }));

  return {
    mode: 'legado',
    token,
    entries,
    unknownEntries: archive.unknownEntries,
    parseErrors: archive.parseErrors,
    options: opts,
    books: {
      total: archive.books.length,
      rebuildable: create.length + progress.length + claim.length,
      create: create.length,
      progress: progress.length,
      claimed: claim.length,
      local: local.length,
      video: video.length,
      sourceMissing: noSource.length,
      claimItems: claim.slice(0, 200).map((p) => ({
        name: p.name,
        author: p.author,
        incoming: p.rawUrl,
        localBookUrl: p.targetBookUrl ?? '',
        localOrigin: p.targetOrigin ?? '',
      })),
      progressItems: progress.slice(0, 200).map((p) => ({
        name: p.name,
        author: p.author,
        incoming: p.rawUrl,
        localBookUrl: p.targetBookUrl ?? '',
      })),
      skippedItems: [...local, ...video, ...noSource].slice(0, 200).map((p) => ({
        name: p.name,
        author: p.author,
        rawUrl: p.rawUrl,
        why: p.action === 'skipLocal' ? '本地书' : p.action === 'skipVideo' ? '影视书' : '源不存在',
      })),
    },
    annotations: {
      bookmarks: archive.bookmarks.length,
      orphanBookmarks,
      highlights: archive.highlights.length,
      orphanHighlights,
      bookMemos: archive.bookMemo.length,
      orphanBookMemos,
      highlightRules: archive.highlightRules.length,
      highlightRuleConflicts,
    },
    rules: {
      replaceRules: archive.replaceRules.length,
      replaceConflicts,
      dictRules: archive.dictRules.length,
      httpTts: archive.httpTts.length,
    },
    history: {
      readRecords: archive.readRecords.length,
      conflicts: readSplit.conflicts.length,
      conflictItems: readSplit.conflicts.slice(0, 100),
      searchHistory: archive.searchHistory.length,
    },
    settings: { mapped: settings.mapped, unmapped: settings.unmapped.length },
    skipped,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 执行导入
 * ------------------------------------------------------------------ */

/**
 * 备份里的源 raw 数组 → `hub.importRows` 需要的 `ImportRow`（含 id/kind/name）。
 *
 * ★ 为什么必须转：`hub.importRows` 吃的是「解析后的行」，不是裸 raw 对象。
 * 早先直接把 `bookSource.json` 的 raw 数组丢进去 ⇒ `row.raw` 为 undefined ⇒
 * 每条都 `failed`（实测重导自己的导出：`failed: 746`）。这里复用**导入唯一实现**
 * `parseImportText`，id 派生 / 默认分组 / kind 判定与正常导入完全一致。
 */
function sourceRows(raws: readonly Rec[], format: 'legado' | 'rss' | 'maccms'): ImportRow[] {
  if (!raws.length) return [];
  return parseImportText(raws as unknown[], { format }).rows;
}

export interface ImportDeps {
  sources: {
    list(): SourceRuntimeEntry[];
    importRows(rows: ImportRow[], opts: { dedupe: 'skip' | 'overwrite' }): {
      inserted: number;
      updated: number;
      skipped: number;
      failed: number;
      results: Array<{ ok: boolean; id?: string; action?: string }>;
    };
    persist(): Promise<void> | void;
  };
  tts?: {
    upsertEngine(input: unknown): { ok: true; engine: unknown } | { ok: false; error: string; message?: string };
  };
  setCookies?: (sourceId: string, cookie: string) => boolean;
  setSourceVariable?: (sourceId: string, value: string) => boolean;
}

export interface LegadoApplyResult {
  mode: 'legado';
  sources: { inserted: number; updated: number; skipped: number; failed: number };
  books: {
    created: number;
    progressUpdated: number;
    claimed: number;
    skippedLocal: number;
    skippedVideo: number;
    skippedSource: number;
    progressKept: number;
  };
  annotations: {
    bookmarks: number;
    highlights: number;
    bookMemos: number;
    highlightRules: number;
    skippedOrphans: number;
    kept: number;
  };
  rules: { replaceRules: number; dictRules: number; httpTts: number; kept: number; failed: number };
  history: { written: number; conflicts: number; searchHistory: number };
  settings: { applied: number };
  claims: Array<{ name: string; author: string; incoming: string; localBookUrl: string; progress: boolean }>;
  warnings: string[];
}

function progressPatchOf(raw: Rec) {
  return {
    durChapterIndex: num(raw['durChapterIndex'], 0),
    durChapterPos: num(raw['durChapterPos'], 0),
    durChapterTime: num(raw['durChapterTime'], 0),
    durChapterTitle: nullableStr(raw['durChapterTitle']),
    durVolumeIndex: num(raw['durVolumeIndex'], 0),
    chapterInVolumeIndex: num(raw['chapterInVolumeIndex'], 0),
  };
}

export async function applyLegado(
  archive: ParsedLegadoArchive,
  optionsInput: unknown,
  store: UserDataStore,
  deps: ImportDeps,
  password = '',
): Promise<LegadoApplyResult> {
  const options = normalizeLegadoOptions(optionsInput);
  const has = (id: LegadoOptionId) => options.includes(id);
  const warnings: string[] = [];

  // 1) 源先入库：书的重建依赖「源已存在」
  let sourceCounts = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  if (has('sources')) {
    const rows = [
      ...sourceRows(archive.bookSources, 'legado'),
      ...sourceRows(archive.rssSources, 'rss'),
    ];
    if (rows.length) {
      const r = deps.sources.importRows(rows, { dedupe: 'overwrite' });
      sourceCounts = { inserted: r.inserted, updated: r.updated, skipped: r.skipped, failed: r.failed };
      deps.sources.persist();
      await Promise.resolve();
    }
  }
  const index = buildSourceIndex(deps.sources.list());

  // 2) 书架 + 进度
  const result: LegadoApplyResult = {
    mode: 'legado',
    sources: sourceCounts,
    books: { created: 0, progressUpdated: 0, claimed: 0, skippedLocal: 0, skippedVideo: 0, skippedSource: 0, progressKept: 0 },
    annotations: { bookmarks: 0, highlights: 0, bookMemos: 0, highlightRules: 0, skippedOrphans: 0, kept: 0 },
    rules: { replaceRules: 0, dictRules: 0, httpTts: 0, kept: 0, failed: 0 },
    history: { written: 0, conflicts: 0, searchHistory: 0 },
    settings: { applied: 0 },
    claims: [],
    warnings,
  };

  const existingBooks = await store.listBooks();
  const existingByUrl = new Map(existingBooks.map((b) => [b.bookUrl, b]));
  const plan = has('bookshelf') ? planLegadoBooks(archive.books, index, existingBooks) : [];
  const inserts: ShelfBook[] = [];
  const progressWrites: Array<{ target: string; raw: Rec; label: string }> = [];
  for (const p of plan) {
    if (p.action === 'skipLocal') result.books.skippedLocal++;
    else if (p.action === 'skipVideo') result.books.skippedVideo++;
    else if (p.action === 'skipSource') result.books.skippedSource++;
    else if (p.action === 'create' && p.bookUrl && p.sourceId) {
      const src = index.byId.get(p.sourceId);
      if (!src) { result.books.skippedSource++; continue; }
      inserts.push(shelfFromLegadoBook(p.raw, src, p.rawUrl));
      result.books.created++;
    } else if (p.action === 'progress' || p.action === 'claim') {
      if (p.action === 'claim') {
        result.books.claimed++;
        result.claims.push({
          name: p.name,
          author: p.author,
          incoming: p.rawUrl,
          localBookUrl: p.targetBookUrl ?? '',
          progress: !!p.progressNewer,
        });
      }
      if (p.targetBookUrl) {
        const existing = existingByUrl.get(p.targetBookUrl);
        if (p.progressNewer && num(p.raw['durChapterTime'], 0) > 0) {
          progressWrites.push({ target: p.targetBookUrl, raw: p.raw, label: p.name });
        } else if (existing) {
          result.books.progressKept++;
        }
      }
    }
  }
  if (inserts.length) {
    await store.upsertBooks(inserts);
    for (const b of inserts) existingByUrl.set(b.bookUrl, b);
  }
  for (const w of progressWrites) {
    const ok = await store.saveProgress(w.target, progressPatchOf(w.raw));
    if (ok) result.books.progressUpdated++;
  }

  // 3) 标注（跟随书籍）
  if (has('annotations')) {
    const shelf = await store.listBooks();
    const byName = new Map(shelf.map((b) => [`${b.name}\u0000${b.author}`, b]));
    const byNameOnly = new Map<string, ShelfBook>();
    for (const b of shelf) if (!byNameOnly.has(b.name)) byNameOnly.set(b.name, b);
    const rawToTarget = new Map<string, string>();
    for (const b of shelf) {
      const dec = decodeItemKey(b.bookUrl);
      const i = dec.indexOf('\u0000');
      if (i > 0) rawToTarget.set(dec.slice(i + 1), b.bookUrl);
    }
    const bookmarks: Rec[] = [];
    for (const b of archive.bookmarks) {
      const n = str(b['bookName']);
      const a = str(b['bookAuthor']);
      if (!(byName.has(`${n}\u0000${a}`) || byNameOnly.has(n))) { result.annotations.skippedOrphans++; continue; }
      // 手机端书签 chapterPos 是**含标题**的布局偏移；本仓书签存正文偏移 ⇒ 落库前减掉
      const titleLen = str(b['chapterName']).length ? str(b['chapterName']).length + 1 : 0;
      bookmarks.push({ ...b, chapterPos: Math.max(0, num(b['chapterPos'], 0) - titleLen) });
    }
    const highlights: Rec[] = [];
    for (const h of archive.highlights) {
      const target = rawToTarget.get(str(h['bookUrl']));
      if (!target) { result.annotations.skippedOrphans++; continue; }
      // 手机端的 style 是 ARGB 整数 JSON，本仓存 CSS 串 ⇒ 必须显式转换（否则样式静默丢失）
      // 坐标同理：chapterPos 含标题，落库前减 layoutTitleLength 并归零（本仓正文坐标系不含标题）
      const titleLen = Math.max(0, num(h['layoutTitleLength'], 0));
      const pos = Math.max(0, num(h['chapterPos'], 0) - titleLen);
      const posEnd = Math.max(pos, num(h['chapterPosEnd'], pos) - titleLen);
      highlights.push({
        ...h,
        bookUrl: target,
        chapterPos: pos,
        chapterPosEnd: posEnd,
        layoutTitleLength: 0,
        style: legadoHighlightStyleToCss(h['style']),
      });
    }
    const bookMemos: Rec[] = [];
    for (const m of archive.bookMemo) {
      const n = str(m['bookName']);
      const a = str(m['bookAuthor']);
      const target = byName.get(`${n}\u0000${a}`) ?? byNameOnly.get(n);
      if (!target || !num(m['time'], 0)) { result.annotations.skippedOrphans++; continue; }
      bookMemos.push({ ...m, bookUrl: target.bookUrl });
    }
    const rules = archive.highlightRules.filter((r) => str(r['uuid']).trim());
    if (bookmarks.length || highlights.length || bookMemos.length || rules.length) {
      const r = await storeImport(store, { bookmarks, highlights, bookMemos, highlightRules: rules });
      result.annotations.bookmarks = r.bookmarks.added + r.bookmarks.updated;
      result.annotations.highlights = r.highlights.added + r.highlights.updated;
      result.annotations.bookMemos = r.bookMemos.added + r.bookMemos.updated;
      result.annotations.highlightRules = r.highlightRules.added + r.highlightRules.updated;
      result.annotations.kept = r.bookmarks.kept + r.highlights.kept + r.bookMemos.kept + r.highlightRules.kept;
      result.annotations.skippedOrphans += r.bookmarks.skipped + r.highlights.skipped + r.bookMemos.skipped + r.highlightRules.skipped;
    }
  }

  // 4) 规则 / TTS
  if (has('rules')) {
    const r = await storeImport(store, { replaceRules: archive.replaceRules, dictRules: archive.dictRules });
    result.rules.replaceRules = r.replaceRules.added;
    result.rules.dictRules = r.dictRules.added;
    result.rules.kept = r.replaceRules.kept + r.dictRules.kept;
    if (deps.tts) {
      for (const t of archive.httpTts) {
        const url = str(t['url']);
        if (!url) { result.rules.failed++; continue; }
        const res = deps.tts.upsertEngine({
          name: str(t['name']) || url,
          url,
          ...(t['contentType'] ? { contentType: str(t['contentType']) } : {}),
          ...(t['pauseDuration'] !== undefined ? { pauseDuration: num(t['pauseDuration'], 0) } : {}),
          ...(t['enabledCookieJar'] !== undefined ? { enabledCookieJar: bool(t['enabledCookieJar']) } : {}),
          ...(t['concurrentRate'] ? { concurrentRate: str(t['concurrentRate']) } : {}),
        });
        if (res.ok) result.rules.httpTts++;
        else result.rules.failed++;
      }
    }
  }

  // 5) 阅读记录（同主键取较大 readTime；author 冲突预检拦掉）+ 搜索历史
  if (has('history')) {
    const localRead = await store.listReadRecords();
    const split = splitReadRecords(archive.readRecords, localRead);
    result.history.conflicts = split.conflicts.length;
    const searchHistory = archive.searchHistory
      .map((e) => ({
        word: str(e['word']).trim(),
        lastUseTime: num(e['lastUseTime'], 0) || Date.now(),
        usage: Math.max(1, num(e['usage'], 1)),
      }))
      .filter((e) => !!e.word);
    if (split.ok.length || searchHistory.length) {
      const r = await storeImport(store, { readRecords: split.ok, searchHistory });
      result.history.written = r.readRecords.added + r.readRecords.updated;
      result.history.searchHistory = r.searchHistory.added + r.searchHistory.updated;
    }
  }

  // 6) 设置（白名单）
  if (has('settings') && archive.configXml) {
    const parsed = parseLegadoSettings(archive.configXml);
    if (parsed.mapped.length) {
      const patch: Record<string, unknown> = {};
      for (const s of parsed.mapped) patch[s.prefs] = s.parsed;
      await store.setReaderPrefs(patch as Partial<GlobalReaderPrefs>);
      result.settings.applied = parsed.mapped.length;
    }
  }

  if (password) warnings.push('Legado 兼容模式不导入 cookies / servers（手机端这两项与 PC 登录态语义不同）');
  return result;
}

/** 小包装：只为了类型上把 `importSnapshot` 的返回值收窄 */
async function storeImport(store: UserDataStore, snap: Rec) {
  return importSnapshot(store, snap as never, { overwrite: false });
}

/* ------------------------------------------------------------------ *
 * Legado 兼容导出
 * ------------------------------------------------------------------ */

function splitShelfBookUrl(bookUrl: string): { sourceId: string; raw: string } | null {
  const dec = decodeItemKey(bookUrl);
  const i = dec.indexOf('\u0000');
  if (i <= 0) return null;
  const sourceId = dec.slice(0, i);
  let raw = dec.slice(i + 1);
  if (raw.startsWith('{')) {
    try {
      const p = JSON.parse(raw) as Rec;
      if (typeof p['bookUrl'] === 'string' && p['bookUrl']) raw = p['bookUrl'];
      else if (typeof p['url'] === 'string' && p['url']) raw = p['url'];
      else return null;
    } catch {
      return null;
    }
  }
  return { sourceId, raw };
}

function legadoBookFromShelf(b: ShelfBook, identity: string, originName: string): Rec {
  const parts = splitShelfBookUrl(b.bookUrl);
  return {
    bookUrl: parts?.raw ?? b.bookUrl,
    tocUrl: b.tocUrl,
    origin: identity,
    originName,
    name: b.name,
    author: b.author,
    ...(b.kind ? { kind: b.kind } : {}),
    ...(b.customTag ? { customTag: b.customTag } : {}),
    ...(b.coverUrl ? { coverUrl: b.coverUrl } : {}),
    ...(b.customCoverUrl ? { customCoverUrl: b.customCoverUrl } : {}),
    ...(b.intro ? { intro: b.intro } : {}),
    ...(b.customIntro ? { customIntro: b.customIntro } : {}),
    ...(b.charset ? { charset: b.charset } : {}),
    type: b.type,
    group: b.group,
    ...(b.latestChapterTitle ? { latestChapterTitle: b.latestChapterTitle } : {}),
    latestChapterTime: b.latestChapterTime,
    lastCheckTime: b.lastCheckTime,
    lastCheckCount: b.lastCheckCount,
    totalChapterNum: b.totalChapterNum,
    ...(b.durChapterTitle ? { durChapterTitle: b.durChapterTitle } : {}),
    durChapterIndex: b.durChapterIndex,
    durVolumeIndex: b.durVolumeIndex,
    chapterInVolumeIndex: b.chapterInVolumeIndex,
    durChapterPos: b.durChapterPos,
    durChapterTime: b.durChapterTime,
    ...(b.wordCount ? { wordCount: b.wordCount } : {}),
    canUpdate: b.canUpdate,
    order: b.order,
    originOrder: b.originOrder,
    ...(b.variable ? { variable: b.variable } : {}),
    ...(b.readConfig ? { readConfig: b.readConfig } : {}),
    syncTime: b.syncTime,
  };
}

function configXmlFromPrefs(prefs: GlobalReaderPrefs): string {
  const lines = [`<?xml version='1.0' encoding='utf-8' standalone='yes' ?>`, '<map>'];
  lines.push(`    <string name="themeMode">${String(prefs.themeMode)}</string>`);
  lines.push(`    <int name="chineseConverterType" value="${Number(prefs.chineseConverterType) || 0}" />`);
  lines.push(`    <boolean name="replaceEnableDefault" value="${prefs.replaceEnableDefault ? 'true' : 'false'}" />`);
  lines.push(`    <boolean name="manualReplaceRule" value="${prefs.manualReplaceRuleEnabled ? 'true' : 'false'}" />`);
  lines.push('</map>');
  return lines.join('\n');
}

export interface LegadoExportResult {
  zip: Uint8Array;
  entries: Array<{ name: string; bytes: number }>;
  included: LegadoOptionId[];
  stats: {
    books: number;
    skippedBooks: number;
    bookGroups: number;
    bookmarks: number;
    highlights: number;
    bookMemos: number;
    highlightRules: number;
    bookSources: number;
    rssSources: number;
    replaceRules: number;
    dictRules: number;
    httpTts: number;
    readRecords: number;
    searchHistory: number;
  };
  warnings: string[];
}

export interface TtsRuntime {
  read(): {
    enabled: boolean;
    dualVoice?: boolean;
    defaultEngineId?: string | null;
    engines: readonly unknown[];
  };
}

export async function exportLegado(
  store: UserDataStore,
  optionsInput: unknown,
  sources: SourceIndex,
  tts: TtsRuntime | undefined,
  now = Date.now(),
): Promise<LegadoExportResult> {
  const options = normalizeLegadoOptions(optionsInput);
  const has = (id: LegadoOptionId) => options.includes(id);
  const enc = new TextEncoder();
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const add = (name: string, value: unknown) => files.push({ name, data: enc.encode(pretty(value)) });
  const stats: LegadoExportResult['stats'] = {
    books: 0, skippedBooks: 0, bookGroups: 0, bookmarks: 0, highlights: 0, bookMemos: 0, highlightRules: 0,
    bookSources: 0, rssSources: 0, replaceRules: 0, dictRules: 0, httpTts: 0, readRecords: 0, searchHistory: 0,
  };
  const warnings: string[] = [];

  if (has('bookshelf')) {
    const books = await store.listBooks();
    const out: Rec[] = [];
    for (const b of books) {
      const parts = splitShelfBookUrl(b.bookUrl);
      if (!parts) { stats.skippedBooks++; continue; }
      if (isLocalBook(parts.raw, b.origin, b.type, b.bookUrl) || isVideoBook(b.type)) { stats.skippedBooks++; continue; }
      const src = sources.byId.get(parts.sourceId);
      if (!src || !src.identity) { stats.skippedBooks++; continue; }
      out.push(legadoBookFromShelf(b, src.identity, b.originName || src.name));
    }
    stats.books = out.length;
    if (out.length) add('bookshelf.json', out);
    const groups = (await store.listBookGroups()).map((g) => ({ ...g }));
    stats.bookGroups = groups.length;
    if (groups.length) add('bookGroup.json', groups);
    if (stats.skippedBooks) warnings.push(`有 ${stats.skippedBooks} 本本地书/影视书/源缺失的书未导出（手机端无法重建）`);
  }

  if (has('annotations')) {
    const bookmarks = (await store.listBookmarks()).map((b) => {
      // 本仓书签存正文偏移；手机端 chapterPos 含标题 ⇒ 导出时加回标题长度（含换行）
      const titleLen = b.chapterName ? b.chapterName.length + 1 : 0;
      return { ...b, chapterPos: b.chapterPos + titleLen };
    });
    stats.bookmarks = bookmarks.length;
    if (bookmarks.length) add('bookmark.json', bookmarks);
    const shelf = new Map((await store.listBooks()).map((b) => [b.bookUrl, b]));
    const highs: Rec[] = [];
    for (const h of await store.listHighlights()) {
      const target = shelf.get(h.bookUrl);
      if (!target) continue;
      const parts = splitShelfBookUrl(h.bookUrl);
      if (!parts) continue;
      const src = sources.byId.get(parts.sourceId);
      if (!src?.identity) continue;
      // 本仓（含导入后归一化的）坐标不含标题 ⇒ 导出加回 titleLen 并写 layoutTitleLength；
      // 若入参本来就带 layoutTitleLength（旧数据/外部直接写入），保持原样不动。
      const ownCoords = !h.layoutTitleLength || h.layoutTitleLength <= 0;
      const titleLen = ownCoords && h.chapterName ? h.chapterName.length + 1 : 0;
      highs.push({
        ...h,
        bookUrl: parts.raw,
        chapterPos: h.chapterPos + titleLen,
        chapterPosEnd: h.chapterPosEnd + titleLen,
        layoutTitleLength: ownCoords ? titleLen : h.layoutTitleLength,
        // 上游 `BookHighlight.style` 是 **String** 字段（Gson 里是一段转义过的 JSON 串）⇒
        // 导出必须序列化成字符串，直接给对象会让手机端反序列化失败（实测样本即 `"style": "{...}"`）
        style: JSON.stringify(cssHighlightStyleToLegado(h.style)),
      });
    }
    stats.highlights = highs.length;
    if (highs.length) add('highlight.json', highs);
    // 书内备注：Legado 实体没有 bookUrl ⇒ 导出时去掉（回导时按书名+作者认领）
    const memos = (await store.listBookMemos()).map((m) => {
      const { bookUrl: _bookUrl, ...rest } = m;
      return rest as Rec;
    });
    stats.bookMemos = memos.length;
    // 上游对 bookMemo.json 显式 writeEmpty ⇒ 空也写 []
    add('bookMemo.json', memos);
    const rules = (await store.listHighlightRules()).map((r) => ({ ...r }));
    stats.highlightRules = rules.length;
    // 上游对 highlightRule.json 显式 writeEmpty ⇒ 空也写 []
    add('highlightRule.json', rules);
  }

  if (has('sources')) {
    const bookSources = sources.all.filter((s) => s.kind !== 'maccms' && s.kind !== 'rss').map((s) => s.raw);
    const rss = sources.all.filter((s) => s.kind === 'rss').map((s) => s.raw);
    stats.bookSources = bookSources.length;
    stats.rssSources = rss.length;
    if (bookSources.length) add('bookSource.json', bookSources);
    if (rss.length) add('rssSources.json', rss);
  }

  if (has('rules')) {
    const repl = await store.listReplaceRules();
    stats.replaceRules = repl.length;
    if (repl.length) add('replaceRule.json', repl);
    const dict = await store.listDictRules();
    stats.dictRules = dict.length;
    if (dict.length) add('dictRule.json', dict);
    const engines = (tts?.read().engines ?? []).map((raw) => {
      const e = raw as Rec;
      return {
        id: num(e['id'], 0),
        name: str(e['name']),
        url: str(e['url']),
        ...(e['contentType'] ? { contentType: str(e['contentType']) } : {}),
        ...(e['pauseDuration'] !== undefined ? { pauseDuration: num(e['pauseDuration'], 0) } : {}),
        ...(e['enabledCookieJar'] !== undefined ? { enabledCookieJar: bool(e['enabledCookieJar']) } : {}),
        ...(e['concurrentRate'] ? { concurrentRate: str(e['concurrentRate']) } : {}),
      };
    });
    stats.httpTts = engines.length;
    if (engines.length) add('httpTTS.json', engines);
    if (engines.length) warnings.push('TTS 引擎导出了配置，但未导出 header 里的 API Key');
  }

  if (has('history')) {
    const recs = (await store.listReadRecords()).map((r) => ({ ...r }));
    stats.readRecords = recs.length;
    if (recs.length) add('readRecord.json', recs);
    const search = (await store.listSearchHistory()).map((e) => ({ ...e }));
    stats.searchHistory = search.length;
    // 空数组也写：手机上「清空搜索历史」是有效意图；不写会让旧文件残留
    add('searchHistory.json', search);
  }

  if (has('settings')) {
    files.push({ name: 'config.xml', data: enc.encode(configXmlFromPrefs(await store.getReaderPrefs())) });
  }

  const zip = createZip(files, { mtime: new Date(now) });
  return {
    zip,
    entries: files.map((f) => ({ name: f.name, bytes: f.data.length })),
    included: options,
    stats,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 本仓完整备份（zip）
 * ------------------------------------------------------------------ */

export const FULL_SNAPSHOT_ENTRY = SNAPSHOT_ENTRY;
export const FULL_SOURCES_ENTRY = 'yuedu-sources.json';
export const FULL_TTS_ENTRY = 'yuedu-tts.json';

export interface FullArchive {
  snapshot: BackupSnapshot;
  included: BackupOptionId[];
  legacy: boolean;
  cookies?: Record<string, string>;
  sourceVariables?: Record<string, string>;
  sources?: { bookSources: Rec[]; rssSources: Rec[]; cmsSources: Rec[] };
  tts?: Rec;
}

export function readFullArchive(bytes: Uint8Array, password = ''): FullArchive {
  const read = readBackupArchive(bytes, password);
  const files = readZip(bytes);
  const byBase = new Map<string, Uint8Array>();
  for (const [n, d] of files) byBase.set(basename(n), d);
  const out: FullArchive = {
    snapshot: read.snapshot,
    included: read.included,
    legacy: read.legacy,
    ...(read.cookies ? { cookies: read.cookies } : {}),
    ...(read.sourceVariables ? { sourceVariables: read.sourceVariables } : {}),
  };
  const srcRaw = byBase.get(FULL_SOURCES_ENTRY);
  if (srcRaw) {
    try {
      const v = JSON.parse(decodeUtf8(srcRaw)) as Rec;
      out.sources = {
        bookSources: asList(v['bookSources']),
        rssSources: asList(v['rssSources']),
        cmsSources: asList(v['cmsSources']),
      };
    } catch { /* 忽略损坏附件 */ }
  }
  const ttsRaw = byBase.get(FULL_TTS_ENTRY);
  if (ttsRaw) {
    try {
      out.tts = JSON.parse(decodeUtf8(ttsRaw)) as Rec;
    } catch { /* 忽略 */ }
  }
  return out;
}

export interface FullExportDeps {
  sources: { list(): SourceRuntimeEntry[] };
  tts?: TtsRuntime;
  cookies?: () => Record<string, string>;
  sourceVariables?: () => Record<string, string>;
}

function redactTtsEngine(raw: unknown): unknown {
  const out = { ...(raw as Rec) };
  delete out['header'];
  delete out['headers'];
  return out;
}

export async function exportFull(
  store: UserDataStore,
  optionsInput: unknown,
  deps: FullExportDeps,
  password = '',
  now = Date.now(),
): Promise<{ zip: Uint8Array; entries: Array<{ name: string; bytes: number }>; included: FullOptionId[]; stats: Rec; warnings: string[] }> {
  const options = normalizeFullOptions(optionsInput);
  const has = (id: FullOptionId) => options.includes(id);
  if ((has('cookies') || has('sourceVariables')) && !password) {
    throw new BackupError('PASSWORD_REQUIRED', '勾了 Cookie / 源变量时，必须设置非空的备份口令');
  }
  const full = await buildSnapshot(store, { includeChapters: has('chapters'), now });
  const snapshot: BackupSnapshot = {
    version: full.version,
    exportedAt: now,
    included: options.filter(
      (id): id is BackupOptionId =>
        id === 'bookshelf' ||
        id === 'chapters' ||
        id === 'annotations' ||
        id === 'rules' ||
        id === 'history' ||
        id === 'settings' ||
        id === 'cookies' ||
        id === 'sourceVariables',
    ),
  };
  if (has('bookshelf')) {
    snapshot.books = full.books;
    snapshot.bookGroups = full.bookGroups;
  }
  if (has('annotations')) {
    snapshot.bookmarks = full.bookmarks;
    snapshot.highlights = full.highlights;
    snapshot.highlightRules = full.highlightRules;
    snapshot.bookMemos = full.bookMemos;
  }
  if (has('rules')) {
    snapshot.replaceRules = full.replaceRules;
    snapshot.dictRules = full.dictRules;
  }
  if (has('history')) {
    snapshot.readRecords = full.readRecords;
    snapshot.searchHistory = full.searchHistory;
  }
  if (has('settings')) snapshot.prefs = full.prefs as GlobalReaderPrefs;
  if (has('chapters') && full.chapters) snapshot.chapters = full.chapters;

  const enc = new TextEncoder();
  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: FULL_SNAPSHOT_ENTRY, data: enc.encode(JSON.stringify(snapshot)) },
  ];
  const warnings: string[] = [];
  let sourcesOut: Rec | undefined;
  if (has('sources') || has('cmsSources')) {
    const all = deps.sources.list();
    const bookSources = has('sources') ? all.filter((s) => s.kind !== 'maccms' && s.kind !== 'rss').map((s) => s.raw) : [];
    const rssSources = has('sources') ? all.filter((s) => s.kind === 'rss').map((s) => s.raw) : [];
    const cmsSources = has('cmsSources') ? all.filter((s) => s.kind === 'maccms').map((s) => s.raw) : [];
    sourcesOut = { bookSources, rssSources, cmsSources };
    files.push({ name: FULL_SOURCES_ENTRY, data: enc.encode(pretty(sourcesOut)) });
  }
  let ttsOut: Rec | undefined;
  if (has('tts') && deps.tts) {
    const cfg = deps.tts.read();
    ttsOut = {
      enabled: cfg.enabled,
      dualVoice: cfg.dualVoice ?? false,
      defaultEngineId: cfg.defaultEngineId ?? null,
      engines: cfg.engines.map(redactTtsEngine),
    };
    files.push({ name: FULL_TTS_ENTRY, data: enc.encode(pretty(ttsOut)) });
    warnings.push('TTS 引擎已导出，但 header / headers 里的 API Key 未写入备份');
  }
  if (has('cookies')) {
    const data = deps.cookies?.() ?? {};
    if (Object.keys(data).length) {
      const { encryptBackupText } = await import('./backup-aes');
      files.push({ name: 'cookies.json', data: enc.encode(encryptBackupText(JSON.stringify(data), password)) });
    } else warnings.push('本机没有已保存的 Cookie，cookies.json 未生成');
  }
  if (has('sourceVariables')) {
    const data = deps.sourceVariables?.() ?? {};
    if (Object.keys(data).length) {
      const { encryptBackupText } = await import('./backup-aes');
      files.push({ name: 'runtimeSourceCache.json', data: enc.encode(encryptBackupText(JSON.stringify(data), password)) });
    } else warnings.push('本机没有源变量，runtimeSourceCache.json 未生成');
  }

  const zip = createZip(files, { mtime: new Date(now) });
  return {
    zip,
    entries: files.map((f) => ({ name: f.name, bytes: f.data.length })),
    included: options,
    stats: {
      books: snapshot.books?.length ?? 0,
      chapters: has('chapters') ? Object.keys(snapshot.chapters ?? {}).length : 0,
      bookmarks: snapshot.bookmarks?.length ?? 0,
      highlights: snapshot.highlights?.length ?? 0,
      highlightRules: snapshot.highlightRules?.length ?? 0,
      bookMemos: snapshot.bookMemos?.length ?? 0,
      replaceRules: snapshot.replaceRules?.length ?? 0,
      dictRules: snapshot.dictRules?.length ?? 0,
      readRecords: snapshot.readRecords?.length ?? 0,
      searchHistory: snapshot.searchHistory?.length ?? 0,
      bookSources: sourcesOut ? (sourcesOut['bookSources'] as unknown[]).length : 0,
      rssSources: sourcesOut ? (sourcesOut['rssSources'] as unknown[]).length : 0,
      cmsSources: sourcesOut ? (sourcesOut['cmsSources'] as unknown[]).length : 0,
      tts: ttsOut ? (ttsOut['engines'] as unknown[]).length : 0,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 本仓完整恢复
 * ------------------------------------------------------------------ */

export interface FullPreview {
  mode: 'full';
  token: string;
  included: string[];
  legacy: boolean;
  stats: {
    books: number;
    localBooks: number;
    videoBooks: number;
    chapters: number;
    bookmarks: number;
    highlights: number;
    highlightRules: number;
    /** 书内备注 */
    bookMemos: number;
    replaceRules: number;
    dictRules: number;
    bookGroups: number;
    readRecords: number;
    /** 搜索历史 */
    searchHistory: number;
    sources: number;
    cmsSources: number;
    tts: number;
  };
  books: {
    sameKey: number;
    claimed: number;
    claimItems: Array<{ name: string; author: string; incoming: string; localBookUrl: string }>;
    localBooks: number;
  };
  history: { conflicts: number; conflictItems: ReadRecordConflict[] };
  warnings: string[];
  entries: Array<{ name: string; bytes: number }>;
}

function planFullBooks(books: readonly ShelfBook[], existing: readonly ShelfBook[]) {
  const byUrl = new Map(existing.map((b) => [b.bookUrl, b]));
  const claimable = new Map<string, ShelfBook>();
  for (const b of existing) {
    const key = `${b.name}\u0000${b.author}`;
    if (!claimable.has(key)) claimable.set(key, b);
  }
  const plan: Array<{ book: ShelfBook; action: 'same' | 'new' | 'claim'; target?: string }> = [];
  for (const b of books) {
    if (byUrl.has(b.bookUrl)) {
      plan.push({ book: b, action: 'same' });
      continue;
    }
    const claimed = claimable.get(`${b.name}\u0000${b.author}`);
    if (claimed) {
      plan.push({ book: b, action: 'claim', target: claimed.bookUrl });
      continue;
    }
    plan.push({ book: b, action: 'new' });
  }
  return plan;
}

export function previewFull(archive: FullArchive, storeBooks: readonly ShelfBook[]): FullPreview {
  const snap = archive.snapshot;
  const books = (snap.books ?? []) as ShelfBook[];
  const plan = planFullBooks(books, storeBooks);
  const localBooks = books.filter((b) => isLocalBook('', b.origin, b.type, b.bookUrl)).length;
  const videoBooks = books.filter((b) => isVideoBook(b.type)).length;
  const conflicts = splitReadRecords((snap.readRecords ?? []) as Rec[], []).conflicts;
  return {
    mode: 'full',
    token: '',
    included: archive.included,
    legacy: archive.legacy,
    stats: {
      books: books.length,
      localBooks,
      videoBooks,
      chapters: snap.chapters ? Object.keys(snap.chapters).length : 0,
      bookmarks: (snap.bookmarks ?? []).length,
      highlights: (snap.highlights ?? []).length,
      highlightRules: (snap.highlightRules ?? []).length,
      bookMemos: (snap.bookMemos ?? []).length,
      replaceRules: (snap.replaceRules ?? []).length,
      dictRules: (snap.dictRules ?? []).length,
      bookGroups: (snap.bookGroups ?? []).length,
      readRecords: (snap.readRecords ?? []).length,
      searchHistory: (snap.searchHistory ?? []).length,
      sources: archive.sources ? archive.sources.bookSources.length + archive.sources.rssSources.length : 0,
      cmsSources: archive.sources?.cmsSources.length ?? 0,
      tts: (archive.tts?.['engines'] as unknown[] | undefined)?.length ?? 0,
    },
    books: {
      sameKey: plan.filter((p) => p.action === 'same').length,
      claimed: plan.filter((p) => p.action === 'claim').length,
      claimItems: plan.filter((p) => p.action === 'claim').slice(0, 200).map((p) => ({
        name: p.book.name,
        author: p.book.author,
        incoming: p.book.bookUrl,
        localBookUrl: p.target ?? '',
      })),
      localBooks,
    },
    history: { conflicts: conflicts.length, conflictItems: conflicts.slice(0, 100) },
    warnings: [
      ...(localBooks ? [`备份含 ${localBooks} 本本地书：只恢复索引，正文需重新导入`] : []),
      ...(archive.legacy ? ['这是旧格式备份（无 included），按实际字段恢复'] : []),
    ],
    entries: [],
  };
}

/** 恢复时默认勾选：按备份里实际带了什么推断（不替用户多勾） */
export function defaultFullRestoreOptions(archive: FullArchive): FullOptionId[] {
  const snap = archive.snapshot;
  const out: FullOptionId[] = [];
  if (snap.books || snap.bookGroups || archive.legacy) out.push('bookshelf');
  if (snap.chapters) {
    if (!out.includes('bookshelf')) out.push('bookshelf');
    out.push('chapters');
  }
  if (snap.bookmarks || snap.highlights || snap.highlightRules || snap.bookMemos) out.push('annotations');
  if (snap.replaceRules || snap.dictRules) out.push('rules');
  if (snap.readRecords || snap.searchHistory) out.push('history');
  if (snap.prefs) out.push('settings');
  if (archive.sources?.bookSources.length || archive.sources?.rssSources.length) out.push('sources');
  if (archive.sources?.cmsSources.length) out.push('cmsSources');
  if (archive.tts) out.push('tts');
  if (archive.cookies) out.push('cookies');
  if (archive.sourceVariables) out.push('sourceVariables');
  // `included` 为空的旧备份：至少把实际存在的项勾上
  if (!out.length) out.push('bookshelf');
  return out;
}

export async function applyFull(
  archive: FullArchive,
  optionsInput: unknown,
  store: UserDataStore,
  deps: ImportDeps,
): Promise<Rec> {
  const options = normalizeFullOptions(optionsInput);
  const has = (id: FullOptionId) => options.includes(id);
  const snap = archive.snapshot;
  const warnings: string[] = [];
  // 1) 源
  let sourceCounts = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  if (archive.sources && (has('sources') || has('cmsSources'))) {
    const rows = [
      ...(has('sources') ? sourceRows(archive.sources.bookSources, 'legado') : []),
      ...(has('sources') ? sourceRows(archive.sources.rssSources, 'rss') : []),
      ...(has('cmsSources') ? sourceRows(archive.sources.cmsSources, 'maccms') : []),
    ];
    if (rows.length) {
      const r = deps.sources.importRows(rows, { dedupe: 'overwrite' });
      sourceCounts = { inserted: r.inserted, updated: r.updated, skipped: r.skipped, failed: r.failed };
      deps.sources.persist();
    }
  }
  // 2) 书架（同名同作者不同 bookUrl ⇒ 认领，只把进度对过去）
  let created = 0, replaced = 0, claimed = 0, claimedProgress = 0;
  if (has('bookshelf')) {
    const existing = await store.listBooks();
    const plan = planFullBooks((snap.books ?? []) as ShelfBook[], existing);
    for (const p of plan) {
      if (p.action === 'claim') {
        claimed++;
        const b = p.book;
        const ex = existing.find((x) => x.bookUrl === p.target);
        if (ex && b.durChapterTime > ex.durChapterTime) {
          await store.saveProgress(ex.bookUrl, progressPatchOf(b as unknown as Rec));
          claimedProgress++;
        }
        continue;
      }
      await store.clearBookTombstone(p.book.bookUrl);
      await store.upsertBook(p.book);
      if (p.action === 'same') replaced++;
      else created++;
    }
  }
  // 3) 其余实体（覆盖语义；高亮规则仍按 uuid 合并）
  const payload: Rec = {};
  if (has('chapters') && snap.chapters) payload['chapters'] = snap.chapters;
  if (has('annotations')) {
    if (snap.bookmarks) payload['bookmarks'] = snap.bookmarks;
    if (snap.highlights) payload['highlights'] = snap.highlights;
    if (snap.highlightRules) payload['highlightRules'] = snap.highlightRules;
    if (snap.bookMemos) payload['bookMemos'] = snap.bookMemos;
  }
  if (has('rules')) {
    if (snap.replaceRules) payload['replaceRules'] = snap.replaceRules;
    if (snap.dictRules) payload['dictRules'] = snap.dictRules;
  }
  if (has('bookshelf') && snap.bookGroups) payload['bookGroups'] = snap.bookGroups;
  if (has('settings') && snap.prefs) payload['prefs'] = snap.prefs;
  if (has('history') && snap.readRecords) {
    const split = splitReadRecords(snap.readRecords as unknown as Rec[], await store.listReadRecords());
    payload['readRecords'] = split.ok;
    if (split.conflicts.length) warnings.push(`${split.conflicts.length} 条阅读记录因 author 冲突被拦下`);
  }
  if (has('history') && snap.searchHistory) payload['searchHistory'] = snap.searchHistory;
  const counts = await importSnapshot(store, payload as never, { overwrite: true });
  // 4) TTS
  let ttsRestored = 0;
  if (has('tts') && archive.tts && deps.tts) {
    const engines = asList(archive.tts['engines']);
    for (const e of engines) {
      const r = deps.tts.upsertEngine(e);
      if (r.ok) ttsRestored++;
    }
  }
  // 5) Cookie / 源变量
  let cookiesRestored = 0;
  if (has('cookies') && archive.cookies && deps.setCookies) {
    for (const [id, v] of Object.entries(archive.cookies)) if (deps.setCookies(id, v)) cookiesRestored++;
  }
  let varsRestored = 0;
  if (has('sourceVariables') && archive.sourceVariables && deps.setSourceVariable) {
    for (const [id, v] of Object.entries(archive.sourceVariables)) if (deps.setSourceVariable(id, v)) varsRestored++;
  }
  return {
    sources: sourceCounts,
    books: { created, replaced, claimed, claimedProgress },
    counts,
    ttsRestored,
    cookiesRestored,
    varsRestored,
    warnings,
  };
}
