/**
 * **音频缓存**（对齐上游 legado 的 `AudioCacheManager` / `AudioCacheKey`）。
 *
 * ## 为什么独立于六类缓存
 * 六类缓存（`cache-store.ts`）装的是「可再生的小对象」（封面、正文图、解析结果），
 * 配额按条数 + 字节 + TTL 自动淘汰，丢了只是下次重取。音频是**整章几 MB～几十 MB**
 * 的媒体文件，且用户明确区分「后台顺手缓存（stream）」与「手动离线下载（manual）」，
 * 后者**永不被自动删除**。语义、生命周期、配额口径都不同，所以单独一个模块、单独一个根目录。
 *
 * 根目录：`<YUEDU_DATA_DIR>/audio-cache/`（**不**进 `data/cache/`，也不进浏览器 IndexedDB）。
 *
 * ## 键规则
 * - 书键 `bookKey = md5_16(bookUrl)`（`bookUrl` 缺失时回落 `itemKey`）
 * - 章键 `chapterKey = md5_16(稳定地址)`（`chapterUrl` 缺失时回落 `title`）
 * - **稳定地址** = 去掉签名/一次性查询参数（`sign`/`timestamp`/`token`/`t` 等，
 *   见 {@link VOLATILE_QUERY_PARAMS}）后的 URL。真实源里喜马拉雅、书音M 的
 *   `chapterUrl` 每次详情都会换签名，用原始地址做键会让同一章每次都是新键
 *   （云朵消失、旧文件永远不参与淘汰）—— 2026-11-16 真实源抽测实证。
 * - 老文件兼容：`locate`/`status` 同时尝试「稳定键 → 旧原始键」，升级前落盘的文件
 *   仍能命中、仍能被统计/清理；新写入一律用稳定键。
 * - `md5_16` = 32 位十六进制 MD5 的**中间 16 位**（`slice(8, 24)`）
 *
 * 磁盘布局：`<dir>/<bookKey>/<chapterKey>.<ext>`。
 *
 * ## 权威来源是「文件是否存在」
 * `index.json` 只做 `chapterUrl ↔ key` 映射、标题、大小/模式统计；
 * 它丢了也能靠扫描目录重建（只是映射里的 URL/标题会丢，统计仍然正确）。
 * 因此**任何「是否已缓存」的判断都不依赖 index**：算键 → 看目录里有没有该键的文件。
 *
 * ## P1 不缓存 m3u8
 * HLS 是播放列表 + 分片，落一个 `.m3u8` 文件没有任何离线价值。这里只写一条
 * `unsupported: 'hls'` 的**标记**（不落假缓存文件），供目录云朵提示
 * 「流式源不支持离线」。P3 再做 HLS 打包。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { encodeItemKey } from '@yuedu/core';

/** 默认配额 2GB（用户拍板） */
export const DEFAULT_AUDIO_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
/** 单章音频文件上限（防止某个坏源返回一个几百 GB 的「文件」把盘写满） */
export const AUDIO_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
/** index.json 写盘防抖 */
const PERSIST_DEBOUNCE_MS = 1200;

export type AudioCacheMode = 'stream' | 'manual';

export interface AudioCacheConfig {
  /** 总字节上限；`0` = 不限 */
  maxBytes: number;
}

export interface AudioCacheEntry {
  /** 原始 chapterUrl（index 丢失后为空） */
  chapterUrl: string;
  /** 章节标题（index 丢失后为空） */
  title: string;
  /** 文件名（`<chapterKey>.<ext>`） */
  file: string;
  bytes: number;
  mime: string;
  mode: AudioCacheMode;
  /** 最后使用/写入时间（LRU 依据） */
  at: number;
  /** P1 不缓存的流式源标记（无文件） */
  unsupported?: 'hls';
}

export interface AudioCacheBook {
  bookUrl: string;
  title: string;
  chapters: Record<string, AudioCacheEntry>;
}

interface AudioCacheIndex {
  version: 1;
  books: Record<string, AudioCacheBook>;
}

export interface AudioCacheHit {
  path: string;
  bytes: number;
  mime: string;
  mode: AudioCacheMode;
  /** 命中后把 LRU 时间前移（供调用方需要时显式刷新） */
  chapterKey: string;
  bookKey: string;
}

export interface AudioCacheBookStat {
  bookKey: string;
  bookUrl: string;
  title: string;
  items: number;
  bytes: number;
  /** 手动离线（永不自动淘汰）的章数与字节 */
  manualItems: number;
  manualBytes: number;
}

export interface AudioCacheStats {
  items: number;
  bytes: number;
  books: number;
  maxBytes: number;
  /** P1 不缓存（m3u8）的章节数 */
  unsupported: number;
  /** 按模式拆分：manual 永不自动淘汰（设置页要让用户看得见） */
  manualItems: number;
  manualBytes: number;
  streamItems: number;
  streamBytes: number;
  /** 已超配额且只剩 manual（淘汰已停手）⇒ 设置页如实提示 */
  overQuota: boolean;
  bookList: AudioCacheBookStat[];
}

export interface AudioCachePruneResult {
  /** 清掉的临时文件数（进程中断残留） */
  tmpFiles: number;
  /** 清掉的空书目录数 */
  emptyDirs: number;
  /** 清掉的空索引项（有键无章节） */
  emptyBooks: number;
  bytes: number;
}

/** 无主缓存（书已不在书架）——只用于「给用户看清单 + 确认后删」 */
export interface AudioCacheOrphan {
  bookKey: string;
  bookUrl: string;
  title: string;
  items: number;
  bytes: number;
  /** 其中手动离线（清理时**一起删**，与配额淘汰语义不同） */
  manualItems: number;
  manualBytes: number;
}

export interface AudioCacheRemoveResult {
  books: number;
  items: number;
  bytes: number;
  manualItems: number;
  manualBytes: number;
}

/** 无主扫描结果：只能证明「书不在书架」的才是 orphan；无法归属的单独计数，不进删除清单 */
export interface AudioCacheOrphanScan {
  orphans: AudioCacheOrphan[];
  unattributed: { books: number; items: number; bytes: number };
}

export interface AudioCacheClearResult {
  items: number;
  bytes: number;
}

export interface AudioCacheOptions {
  /** 缓存根目录（`DATA_DIR/audio-cache`） */
  dir: string;
  /** 配额文件（`DATA_DIR/audio-cache-config.json`） */
  configFile?: string;
  now?: () => number;
  /** 写索引防抖；测试可设 0 = 立即写 */
  persistDebounceMs?: number;
}

export interface SaveStreamOptions {
  bookUrl: string;
  bookTitle?: string;
  chapterUrl: string;
  chapterTitle?: string;
  mime: string;
  /** 文件扩展名（不含点；调用方按 MIME/URL 推断） */
  ext: string;
  mode: AudioCacheMode;
  /** 上游字节流（Node Readable / web ReadableStream 均可） */
  stream: AsyncIterable<Uint8Array | Buffer | string>;
  /** 单章上限（默认 `AUDIO_MAX_ENTRY_BYTES`） */
  maxBytes?: number;
  /** 取消信号（手动下载的「取消」按钮）；中断后临时文件会被删掉 */
  signal?: AbortSignal;
  /** 进度回调（已写入字节数；用于下载进度条） */
  onProgress?: (bytes: number) => void;
}

export interface SaveStreamResult {
  saved: boolean;
  bytes: number;
  /** 未保存原因：QUOTA / TOO_LARGE / EMPTY / IO */
  reason?: string;
}

/** 32 位 MD5 的中间 16 位（上游 `MD5Utils.md5Encode16` 同款） */
export function md5_16(input: string): string {
  return createHash('md5').update(input).digest('hex').slice(8, 24);
}

/** 书键：`bookUrl` 优先，缺失回落 `fallback`（通常是 `itemKey`），再缺失用 `unknown` */
export function audioBookKey(bookUrl: string | undefined | null, fallback?: string): string {
  const s = String(bookUrl ?? '').trim() || String(fallback ?? '').trim() || 'unknown';
  return md5_16(s);
}

/**
 * 书架主键与音频缓存的 `bookUrl` **不是同一种形态**：
 *  - 书架存的是 `encodeItemKey('sourceId\u0000bookUrl')`（`%00` 转义，见 core 契约）；
 *  - 播放器传给音频缓存的是引擎原始 `bookUrl`，个别链路给的是**未转义**的 itemKey。
 * 所以两边都展开成「原样 / 转义后 / 反转义后 / 反转义后的尾段」再取交集，
 * 直接字符串相等会把所有缓存都判成无主。
 */
export function audioBookVariants(value: string | null | undefined): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  // 与 `apps/web/src/utils/user-map.ts` 的 decodeItemKey 互逆（encode 侧用 core 的唯一实现）
  const decoded = raw.split('%00').join('\u0000').split('%25').join('%');
  const out = new Set<string>([raw, encodeItemKey(raw), decoded]);
  const tail = decoded.split('\u0000').pop();
  if (tail) out.add(tail);
  return [...out];
}

/** 书架匹配器：返回 true = 这本书还在书架（无主清理要跳过）；空 bookUrl 一律视为无主 */
export function makeShelfMatcher(
  shelfBookUrls: Array<string | null | undefined>,
): (bookUrl: string | null | undefined) => boolean {
  const known = new Set<string>();
  for (const u of shelfBookUrls) {
    for (const v of audioBookVariants(u)) known.add(v);
  }
  return (bookUrl) => audioBookVariants(bookUrl).some((v) => known.has(v));
}

/**
 * 每次详情都会变的签名/一次性查询参数（**按真实源观察到的形态**，见
 * `docs/ref/audio-cache-plan-2026-11-16.md` §6.2）：
 *  · 喜马拉雅：`…m4a?buy_key=…&sign=…&timestamp=…&token=…&duration=…`
 *  · 书音M 章页：`…index.php?act=wapseries&…&t=<epoch>&token=<…>`
 *  · aikeu 媒体：`…api.php?kw=…&t=<epoch>&sign=…`
 * `buy_key` / `duration` 是稳定参数，保留在键里。
 */
const VOLATILE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'sign',
  'signature',
  'sig',
  'timestamp',
  'ts',
  'token',
  'access_token',
  'accesstoken',
  'auth',
  'expires',
  'expire',
  't',
  'nonce',
]);

/**
 * 稳定地址：去掉 {@link VOLATILE_QUERY_PARAMS} 并把剩余参数按名排序。
 * 没有可去参数时**原样返回**（不改变老源/老文件的键）。
 */
export function audioStableChapterUrl(chapterUrl: string): string {
  const s = String(chapterUrl ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s;
  }
  let dropped = false;
  for (const k of [...u.searchParams.keys()]) {
    if (VOLATILE_QUERY_PARAMS.has(k.toLowerCase())) {
      u.searchParams.delete(k);
      dropped = true;
    }
  }
  if (!dropped) return s;
  const pairs = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of pairs) u.searchParams.append(k, v);
  return u.toString();
}

/** 章键：`chapterUrl` 优先（先规范化），缺失回落标题 */
export function audioChapterKey(chapterUrl: string | undefined | null, fallbackTitle?: string): string {
  const s = String(chapterUrl ?? '').trim();
  return md5_16(audioStableChapterUrl(s) || String(fallbackTitle ?? '').trim() || 'unknown');
}

/** 旧口径章键（原始地址原样 md5）：**只用于兼容升级前落盘的文件** */
export function legacyAudioChapterKey(chapterUrl: string | undefined | null, fallbackTitle?: string): string {
  const s = String(chapterUrl ?? '').trim() || String(fallbackTitle ?? '').trim() || 'unknown';
  return md5_16(s);
}

/** 查找顺序：稳定键 → 旧键（两者相同时只留一个） */
export function audioChapterKeys(chapterUrl: string | undefined | null, fallbackTitle?: string): string[] {
  const stable = audioChapterKey(chapterUrl, fallbackTitle);
  const legacy = legacyAudioChapterKey(chapterUrl, fallbackTitle);
  return stable === legacy ? [stable] : [stable, legacy];
}

/** m3u8 / HLS 判定（P1 只标记不缓存） */
export function isStreamOnlyAudio(chapterUrl: string, format?: string): boolean {
  if (String(format ?? '').toLowerCase() === 'm3u8') return true;
  return /\.m3u8(\?|#|$)/i.test(String(chapterUrl ?? ''));
}

const MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** 按 MIME / URL 推断扩展名（只用于落盘命名，不参与播放判定） */
export function audioExtOf(mime: string, url: string): string {
  const m = String(mime ?? '').toLowerCase().split(';')[0]!.trim();
  if (MIME_EXT[m]) return MIME_EXT[m]!;
  const u = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(url ?? ''));
  if (u) {
    const ext = String(u[1] ?? '').toLowerCase();
    if (/^(mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4)$/.test(ext)) return ext;
  }
  if (m.startsWith('audio/')) return 'mp3';
  return 'bin';
}

function clampQuota(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUDIO_QUOTA_BYTES;
  // 上限 8TB：足够大，同时防「手滑输入 1e20」把 Number 精度弄坏
  return Math.min(Math.round(n), 8 * 1024 * 1024 * 1024 * 1024);
}

export function resolveAudioCacheConfig(raw: unknown): AudioCacheConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { maxBytes: clampQuota(src['maxBytes']) };
}

const extOfFile = (file: string): string => {
  const i = file.lastIndexOf('.');
  return i >= 0 ? file.slice(i + 1) : 'bin';
};

export class AudioCache {
  private readonly dir: string;
  private readonly configFile: string;
  private readonly now: () => number;
  private readonly persistDebounceMs: number;
  private readonly indexFile: string;
  private index: AudioCacheIndex = { version: 1, books: {} };
  private config: AudioCacheConfig = { maxBytes: DEFAULT_AUDIO_QUOTA_BYTES };
  private readyPromise: Promise<void> | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistDirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(opts: AudioCacheOptions) {
    this.dir = opts.dir;
    this.configFile = opts.configFile ?? path.join(path.dirname(opts.dir), 'audio-cache-config.json');
    this.now = opts.now ?? Date.now;
    this.persistDebounceMs = opts.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
    this.indexFile = path.join(this.dir, 'index.json');
  }

  init(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.doInit();
    return this.readyPromise;
  }

  private async doInit(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    this.config = await this.loadConfig();
    await this.loadIndex();
    await this.scan();
    await this.evict();
  }

  private async loadConfig(): Promise<AudioCacheConfig> {
    try {
      return resolveAudioCacheConfig(JSON.parse(await fsp.readFile(this.configFile, 'utf-8')));
    } catch {
      return resolveAudioCacheConfig(null);
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.configFile), { recursive: true });
      const tmp = `${this.configFile}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, JSON.stringify(this.config, null, 2));
      await fsp.rename(tmp, this.configFile);
    } catch {
      /* 配额落盘失败不影响本次运行（内存里的值仍生效） */
    }
  }

  private async loadIndex(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(this.indexFile, 'utf-8'));
    } catch {
      parsed = null;
    }
    const books = (parsed as { books?: unknown } | null)?.books;
    if (!books || typeof books !== 'object') return;
    for (const [bookKey, rawBook] of Object.entries(books as Record<string, unknown>)) {
      if (!/^[0-9a-f]{16}$/i.test(bookKey) || !rawBook || typeof rawBook !== 'object') continue;
      const b = rawBook as Record<string, unknown>;
      const chaptersRaw = (b['chapters'] && typeof b['chapters'] === 'object' ? b['chapters'] : {}) as Record<string, unknown>;
      const chapters: Record<string, AudioCacheEntry> = {};
      for (const [chapterKey, rawEntry] of Object.entries(chaptersRaw)) {
        if (!/^[0-9a-f]{16}$/i.test(chapterKey) || !rawEntry || typeof rawEntry !== 'object') continue;
        const e = rawEntry as Record<string, unknown>;
        const file = typeof e['file'] === 'string' ? e['file'] : '';
        const bytes = Number(e['bytes']);
        if (!file || !Number.isFinite(bytes) || bytes <= 0) continue;
        if (!fs.existsSync(path.join(this.dir, bookKey, file))) continue; // 文件被删 ⇒ 索引项作废
        chapters[chapterKey] = {
          chapterUrl: typeof e['chapterUrl'] === 'string' ? e['chapterUrl'] : '',
          title: typeof e['title'] === 'string' ? e['title'] : '',
          file,
          bytes,
          mime: typeof e['mime'] === 'string' ? e['mime'] : 'application/octet-stream',
          mode: e['mode'] === 'stream' ? 'stream' : 'manual',
          at: Number.isFinite(Number(e['at'])) ? Number(e['at']) : this.now(),
        };
      }
      this.index.books[bookKey] = {
        bookUrl: typeof b['bookUrl'] === 'string' ? b['bookUrl'] : '',
        title: typeof b['title'] === 'string' ? b['title'] : '',
        chapters,
      };
    }
  }

  /**
   * 扫描目录，把 index 里没有的文件补进来（**文件是权威**）。
   * index 丢失时这里会重建出「键 + 大小 + 时间」，只是 URL/标题为空。
   * 同时清掉「索引有、文件没了」的条目。
   *
   * ⚠️ 重建条目的模式一律记 `manual`（用户拍板）：索引都丢了就无法证明它是
   * 「播放时顺手缓存的」，宁可让它不参与自动淘汰，也不能把用户手动下载的东西删掉。
   */
  private async scan(): Promise<void> {
    let bookDirs: string[];
    try {
      bookDirs = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const bookKey of bookDirs) {
      if (!/^[0-9a-f]{16}$/i.test(bookKey)) continue;
      const bookDir = path.join(this.dir, bookKey);
      let names: string[];
      try {
        const st = await fsp.stat(bookDir);
        if (!st.isDirectory()) continue;
        names = await fsp.readdir(bookDir);
      } catch {
        continue;
      }
      const book = this.index.books[bookKey] ?? { bookUrl: '', title: '', chapters: {} };
      for (const name of names) {
        if (name.startsWith('.')) continue;
        // 上次进程中断留下的临时文件：不当作缓存，顺手清掉
        if (name.includes('.tmp-')) {
          await fsp.rm(path.join(bookDir, name), { force: true }).catch(() => {});
          continue;
        }
        const chapterKey = name.split('.')[0] ?? '';
        if (!/^[0-9a-f]{16}$/i.test(chapterKey)) continue;
        const full = path.join(bookDir, name);
        let st: fs.Stats;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size <= 0) continue;
        const existing = book.chapters[chapterKey];
        if (existing && existing.file === name) {
          existing.bytes = st.size;
          continue;
        }
        book.chapters[chapterKey] = {
          chapterUrl: '',
          title: '',
          file: name,
          bytes: st.size,
          mime: `audio/${extOfFile(name) === 'mp3' ? 'mpeg' : extOfFile(name)}`,
          // 见方法注释：重建一律按 manual，避免配额把无法归属的文件当后台缓存删掉
          mode: 'manual',
          at: st.mtimeMs || this.now(),
        };
      }
      // 索引里有、磁盘上没有的条目作废
      for (const [chapterKey, e] of Object.entries(book.chapters)) {
        if (!fs.existsSync(path.join(bookDir, e.file))) delete book.chapters[chapterKey];
      }
      if (Object.keys(book.chapters).length || book.bookUrl || book.title) this.index.books[bookKey] = book;
    }
    // index 里有、但目录已被整个删除的书
    for (const [bookKey, b] of Object.entries(this.index.books)) {
      if (!fs.existsSync(path.join(this.dir, bookKey)) && Object.keys(b.chapters).length === 0) {
        delete this.index.books[bookKey];
      }
    }
    this.schedulePersist();
  }

  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistDebounceMs <= 0) {
      void this.flush();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  private flush(): Promise<void> {
    if (!this.persistDirty) return this.writing;
    this.persistDirty = false;
    const snapshot = JSON.stringify(this.index);
    this.writing = this.writing
      .then(async () => {
        const tmp = `${this.indexFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        await fsp.writeFile(tmp, snapshot);
        await fsp.rename(tmp, this.indexFile);
      })
      .catch(() => {
        /* 索引写失败不影响文件缓存本身；下次变更会再试 */
      });
    return this.writing;
  }

  /** 章节文件路径（按扩展名探测；找不到返回 null） */
  private async findChapterFile(bookKey: string, chapterKey: string): Promise<{ path: string; file: string } | null> {
    const bookDir = path.join(this.dir, bookKey);
    let names: string[];
    try {
      names = await fsp.readdir(bookDir);
    } catch {
      return null;
    }
    const hit = names.find((n) => n.startsWith(`${chapterKey}.`) && !n.includes('.tmp-'));
    if (!hit) return null;
    return { path: path.join(bookDir, hit), file: hit };
  }

  /**
   * 索引里「稳定地址 → 章键」的反查表。
   * 升级前落盘的老文件，章键是**原始签名地址**的 md5，无法由当前地址直接算出；
   * 但索引里存了当时的 `chapterUrl`，按稳定地址归并后就能找到那把旧键
   * （= 需求里的「原始地址 → 稳定键」映射，不需要额外持久化字段）。
   */
  private stableKeyIndex(bookKey: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const book = this.index.books[bookKey];
    if (!book) return map;
    for (const [key, entry] of Object.entries(book.chapters)) {
      const raw = String(entry?.chapterUrl ?? '').trim();
      if (!raw) continue;
      const stable = audioStableChapterUrl(raw);
      const list = map.get(stable);
      if (list) list.push(key);
      else map.set(stable, [key]);
    }
    return map;
  }

  /**
   * 查缓存（文件存在即命中）。命中会前移 LRU 时间（异步防抖写索引）。
   * 调用方无需先 `init()`。
   */
  async locate(bookUrl: string, chapterUrl: string, fallbackTitle?: string): Promise<AudioCacheHit | null> {
    await this.init();
    const bookKey = audioBookKey(bookUrl);
    const keys = audioChapterKeys(chapterUrl, fallbackTitle);
    const wanted = audioStableChapterUrl(String(chapterUrl ?? '').trim());
    if (wanted) {
      for (const k of this.stableKeyIndex(bookKey).get(wanted) ?? []) {
        if (!keys.includes(k)) keys.push(k);
      }
    }
    for (const chapterKey of keys) {
      const found = await this.findChapterFile(bookKey, chapterKey);
      if (!found) continue;
      let st: fs.Stats;
      try {
        st = await fsp.stat(found.path);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size <= 0) continue;
      const entry = this.index.books[bookKey]?.chapters[chapterKey];
      if (entry) {
        entry.at = this.now();
        entry.bytes = st.size;
        this.schedulePersist();
      }
      return {
        path: found.path,
        bytes: st.size,
        mime: entry?.mime ?? `audio/${extOfFile(found.file) === 'mp3' ? 'mpeg' : extOfFile(found.file)}`,
        mode: entry?.mode ?? 'manual',
        chapterKey,
        bookKey,
      };
    }
    return null;
  }

  /**
   * 批量状态（目录云朵）：`chapterUrl` 列表 → 已缓存集合 + 流式源（不支持离线）集合。
   * 只读一次目录，逐个键比对；不依赖 index 里的 URL 映射。
   */
  async status(
    bookUrl: string,
    chapters: Array<{ chapterUrl?: string; title?: string }>,
  ): Promise<{ cached: string[]; unsupported: string[] }> {
    await this.init();
    const bookKey = audioBookKey(bookUrl);
    const cached: string[] = [];
    const unsupported: string[] = [];
    let names: string[] = [];
    try {
      names = await fsp.readdir(path.join(this.dir, bookKey));
    } catch {
      names = [];
    }
    const present = new Set<string>();
    for (const n of names) {
      if (n.includes('.tmp-')) continue;
      const k = n.split('.')[0] ?? '';
      if (/^[0-9a-f]{16}$/i.test(k)) present.add(k.toLowerCase());
    }
    const book = this.index.books[bookKey];
    const byStable = this.stableKeyIndex(bookKey);
    for (const ch of chapters) {
      const chapterUrl = String(ch.chapterUrl ?? '');
      const title = String(ch.title ?? '');
      if (!chapterUrl && !title) continue;
      const keys = audioChapterKeys(chapterUrl, title);
      const wanted = audioStableChapterUrl(chapterUrl.trim());
      if (wanted) {
        for (const k of byStable.get(wanted) ?? []) if (!keys.includes(k)) keys.push(k);
      }
      if (keys.some((k) => present.has(k.toLowerCase()))) {
        cached.push(chapterUrl || title);
        continue;
      }
      if (isStreamOnlyAudio(chapterUrl)) {
        unsupported.push(chapterUrl || title);
        continue;
      }
      if (keys.some((k) => book?.chapters[k]?.unsupported === 'hls')) unsupported.push(chapterUrl || title);
    }
    return { cached, unsupported };
  }

  /** 记录「流式源不支持离线」标记（不落文件，只做映射与提示） */
  async markUnsupported(bookUrl: string, chapterUrl: string, title?: string): Promise<void> {
    await this.init();
    const bookKey = audioBookKey(bookUrl);
    const keys = audioChapterKeys(chapterUrl, title);
    const wanted = audioStableChapterUrl(String(chapterUrl ?? '').trim());
    if (wanted) {
      const book0 = this.index.books[bookKey];
      if (book0) {
        for (const k of this.stableKeyIndex(bookKey).get(wanted) ?? []) if (!keys.includes(k)) keys.push(k);
      }
    }
    const book = (this.index.books[bookKey] ??= { bookUrl, title: '', chapters: {} });
    // 任一键下已有真缓存 ⇒ 不覆盖（稳定键/旧键都看）
    for (const k of keys) {
      const e = book.chapters[k];
      if (e && !e.unsupported && e.file) return;
    }
    const chapterKey = keys[0]!;
    book.chapters[chapterKey] = {
      chapterUrl,
      title: String(title ?? ''),
      file: '',
      bytes: 0,
      mime: '',
      mode: 'stream',
      at: this.now(),
      unsupported: 'hls',
    };
    // 旧键下的同章标记清掉，避免 stats 重复计数
    for (const k of keys.slice(1)) {
      const e = book.chapters[k];
      if (e?.unsupported && !e.file) delete book.chapters[k];
    }
    this.schedulePersist();
  }

  /**
   * 把上游字节流写到缓存。成功返回 `saved:true`；配额不足/超单章上限/空文件返回 `false`。
   * 写入用临时文件 + rename，**中断不会留下半截文件被当成已缓存**。
   */
  async saveFromStream(opts: SaveStreamOptions): Promise<SaveStreamResult> {
    await this.init();
    const bookKey = audioBookKey(opts.bookUrl);
    const chapterKey = audioChapterKey(opts.chapterUrl, opts.chapterTitle);
    const bookDir = path.join(this.dir, bookKey);
    await fsp.mkdir(bookDir, { recursive: true });
    const safeExt = String(opts.ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 6) || 'bin';
    const finalFile = `${chapterKey}.${safeExt}`;
    const finalPath = path.join(bookDir, finalFile);
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const maxBytes = Math.min(opts.maxBytes ?? AUDIO_MAX_ENTRY_BYTES, AUDIO_MAX_ENTRY_BYTES);
    let bytes = 0;
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(tmpPath, 'w');
      for await (const chunk of opts.stream) {
        if (opts.signal?.aborted) throw Object.assign(new Error('AUDIO_CANCELLED'), { code: 'CANCELLED' });
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!buf.length) continue;
        bytes += buf.length;
        if (bytes > maxBytes) throw Object.assign(new Error('AUDIO_TOO_LARGE'), { code: 'TOO_LARGE' });
        await fh.write(buf);
        opts.onProgress?.(bytes);
      }
      await fh.close();
      fh = null;
      if (bytes <= 0) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
        return { saved: false, bytes: 0, reason: 'EMPTY' };
      }
      await fsp.rename(tmpPath, finalPath);
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      const code = (e as { code?: string }).code;
      return {
        saved: false,
        bytes,
        reason: code === 'TOO_LARGE' ? 'TOO_LARGE' : code === 'CANCELLED' ? 'CANCELLED' : 'IO',
      };
    }
    const book = (this.index.books[bookKey] ??= { bookUrl: opts.bookUrl, title: opts.bookTitle ?? '', chapters: {} });
    if (!book.bookUrl) book.bookUrl = opts.bookUrl;
    if (!book.title && opts.bookTitle) book.title = opts.bookTitle;
    book.chapters[chapterKey] = {
      chapterUrl: opts.chapterUrl,
      title: String(opts.chapterTitle ?? ''),
      file: finalFile,
      bytes,
      mime: String(opts.mime || 'application/octet-stream'),
      mode: opts.mode,
      at: this.now(),
    };
    // 同一章在旧键下可能残留「不支持离线」标记：已有真文件就清掉，避免 stats 重复计数
    for (const k of audioChapterKeys(opts.chapterUrl, opts.chapterTitle)) {
      if (k === chapterKey) continue;
      const e = book.chapters[k];
      if (e?.unsupported && !e.file) delete book.chapters[k];
    }
    await this.evict(bookKey, chapterKey);
    this.schedulePersist();
    // 淘汰可能把刚写进来的唯一一份 stream 缓存删掉 ⇒ 如实返回
    const still = this.index.books[bookKey]?.chapters[chapterKey];
    if (!still || still.file !== finalFile) return { saved: false, bytes, reason: 'QUOTA' };
    return { saved: true, bytes };
  }

  /**
   * 配额淘汰：**只删 `mode:'stream'`**，`manual` 永不自动删。
   * 超过配额且已经只剩 manual 时停止（宁可超配额，也不删用户手动下载的内容）。
   */
  private async evict(keepBookKey?: string, keepChapterKey?: string): Promise<void> {
    if (this.config.maxBytes <= 0) return;
    let total = this.totalBytes();
    let guard = 0;
    while (total > this.config.maxBytes && guard < 100_000) {
      guard += 1;
      const oldest = this.oldestStream(keepBookKey, keepChapterKey);
      if (!oldest) break;
      total -= oldest.bytes;
      await this.removeEntry(oldest.bookKey, oldest.chapterKey);
    }
  }

  private totalBytes(): number {
    let n = 0;
    for (const book of Object.values(this.index.books)) {
      for (const e of Object.values(book.chapters)) if (e.file) n += e.bytes;
    }
    return n;
  }

  private oldestStream(
    keepBookKey?: string,
    keepChapterKey?: string,
  ): { bookKey: string; chapterKey: string; bytes: number } | null {
    let best: { bookKey: string; chapterKey: string; bytes: number; at: number } | null = null;
    for (const [bookKey, book] of Object.entries(this.index.books)) {
      for (const [chapterKey, e] of Object.entries(book.chapters)) {
        if (!e.file || e.mode !== 'stream') continue;
        if (bookKey === keepBookKey && chapterKey === keepChapterKey) continue;
        if (!best || e.at < best.at) best = { bookKey, chapterKey, bytes: e.bytes, at: e.at };
      }
    }
    return best ? { bookKey: best.bookKey, chapterKey: best.chapterKey, bytes: best.bytes } : null;
  }

  private async removeEntry(bookKey: string, chapterKey: string): Promise<void> {
    const book = this.index.books[bookKey];
    const e = book?.chapters[chapterKey];
    if (!book || !e) return;
    if (e.file) await fsp.rm(path.join(this.dir, bookKey, e.file), { force: true }).catch(() => {});
    delete book.chapters[chapterKey];
    if (!Object.keys(book.chapters).length && !book.bookUrl) delete this.index.books[bookKey];
    this.schedulePersist();
  }

  async stats(): Promise<AudioCacheStats> {
    await this.init();
    const bookList: AudioCacheBookStat[] = [];
    let items = 0;
    let bytes = 0;
    let unsupported = 0;
    let manualItems = 0;
    let manualBytes = 0;
    for (const [bookKey, book] of Object.entries(this.index.books)) {
      let bItems = 0;
      let bBytes = 0;
      let bManualItems = 0;
      let bManualBytes = 0;
      for (const e of Object.values(book.chapters)) {
        if (e.unsupported) {
          unsupported += 1;
          continue;
        }
        if (!e.file) continue;
        bItems += 1;
        bBytes += e.bytes;
        if (e.mode === 'manual') {
          bManualItems += 1;
          bManualBytes += e.bytes;
        }
      }
      if (!bItems) continue;
      items += bItems;
      bytes += bBytes;
      manualItems += bManualItems;
      manualBytes += bManualBytes;
      bookList.push({
        bookKey,
        bookUrl: book.bookUrl,
        title: book.title,
        items: bItems,
        bytes: bBytes,
        manualItems: bManualItems,
        manualBytes: bManualBytes,
      });
    }
    bookList.sort((a, b) => b.bytes - a.bytes);
    return {
      items,
      bytes,
      books: bookList.length,
      maxBytes: this.config.maxBytes,
      unsupported,
      manualItems,
      manualBytes,
      streamItems: items - manualItems,
      streamBytes: bytes - manualBytes,
      overQuota: this.config.maxBytes > 0 && bytes > this.config.maxBytes,
      bookList: bookList.slice(0, 50),
    };
  }

  /**
   * 清理残留：进程中断留下的 `.tmp-*` 文件、空书目录、无章节的空索引项。
   * **不动**任何已记账的音频文件（manual/stream 都不动）。
   */
  async prune(): Promise<AudioCachePruneResult> {
    await this.init();
    let tmpFiles = 0;
    let emptyDirs = 0;
    let emptyBooks = 0;
    let bytes = 0;
    let bookDirs: string[] = [];
    try {
      bookDirs = await fsp.readdir(this.dir);
    } catch {
      bookDirs = [];
    }
    for (const bookKey of bookDirs) {
      if (!/^[0-9a-f]{16}$/i.test(bookKey)) continue;
      const bookDir = path.join(this.dir, bookKey);
      let names: string[] = [];
      try {
        names = await fsp.readdir(bookDir);
      } catch {
        continue;
      }
      let hasCacheFile = false;
      for (const name of names) {
        const full = path.join(bookDir, name);
        if (name.includes('.tmp-')) {
          try {
            const st = await fsp.stat(full);
            if (st.isFile()) bytes += st.size;
            await fsp.rm(full, { force: true });
            tmpFiles += 1;
          } catch {
            /* 已被删/权限不足：跳过 */
          }
          continue;
        }
        if (/^[0-9a-f]{16}\.[a-z0-9]{2,6}$/i.test(name)) hasCacheFile = true;
      }
      if (hasCacheFile) continue;
      // 没有合法缓存文件：目录是空的（或只剩未知残留）才删，未知文件一律不动
      try {
        const rest = await fsp.readdir(bookDir);
        if (!rest.length) {
          await fsp.rmdir(bookDir);
          emptyDirs += 1;
        }
      } catch {
        /* 目录已被删 */
      }
    }
    for (const [bookKey, b] of Object.entries(this.index.books)) {
      if (Object.keys(b.chapters).length === 0 && !b.bookUrl && !b.title) {
        delete this.index.books[bookKey];
        emptyBooks += 1;
      }
    }
    if (tmpFiles || emptyDirs || emptyBooks) this.schedulePersist();
    return { tmpFiles, emptyDirs, emptyBooks, bytes };
  }

  /**
   * 列出「无主缓存」：目录里有、但对应书**已不在书架**（用户拍板：显式清理，不做启动自动删）。
   * 只读，不删任何东西；调用方先给用户看清单再确认。
   *
   * ⚠️ 索引丢失后重建的条目 `bookUrl` 为空，**无法证明它不在书架**：这类只计入
   * `unattributed`，绝不放进删除清单（否则一次确认会把整盘缓存删光，与「索引丢失按
   * manual 兜底」的保护口径冲突）。这类只能走「清空音频缓存」或按书清理。
   */
  async listOrphans(isOnShelf: (bookUrl: string) => boolean): Promise<AudioCacheOrphanScan> {
    await this.init();
    const orphans: AudioCacheOrphan[] = [];
    const unattributed = { books: 0, items: 0, bytes: 0 };
    for (const [bookKey, book] of Object.entries(this.index.books)) {
      let items = 0;
      let bytes = 0;
      let manualItems = 0;
      let manualBytes = 0;
      for (const e of Object.values(book.chapters)) {
        if (!e.file) continue;
        items += 1;
        bytes += e.bytes;
        if (e.mode === 'manual') {
          manualItems += 1;
          manualBytes += e.bytes;
        }
      }
      if (!items) continue; // 只有 unsupported 标记/空索引的书：没有可删文件，不进清单
      if (!book.bookUrl) {
        unattributed.books += 1;
        unattributed.items += items;
        unattributed.bytes += bytes;
        continue;
      }
      if (isOnShelf(book.bookUrl)) continue;
      orphans.push({
        bookKey,
        bookUrl: book.bookUrl,
        title: book.title,
        items,
        bytes,
        manualItems,
        manualBytes,
      });
    }
    return { orphans: orphans.sort((a, b) => b.bytes - a.bytes), unattributed };
  }

  /**
   * 按 `bookKey` 精确删书（无主清理的落点）。
   * ⚠️ 这里**不区分 manual / stream**（用户拍板：无主缓存连手动下载的一起删），
   * 与配额淘汰（只删 stream）是两套完全不同的语义。
   */
  async removeBooks(bookKeys: string[]): Promise<AudioCacheRemoveResult> {
    await this.init();
    const result: AudioCacheRemoveResult = { books: 0, items: 0, bytes: 0, manualItems: 0, manualBytes: 0 };
    for (const bookKey of bookKeys) {
      if (!/^[0-9a-f]{16}$/i.test(bookKey)) continue;
      const book = this.index.books[bookKey];
      if (!book) continue;
      for (const e of Object.values(book.chapters)) {
        if (!e.file) continue;
        result.items += 1;
        result.bytes += e.bytes;
        if (e.mode === 'manual') {
          result.manualItems += 1;
          result.manualBytes += e.bytes;
        }
      }
      await fsp.rm(path.join(this.dir, bookKey), { recursive: true, force: true }).catch(() => {});
      delete this.index.books[bookKey];
      result.books += 1;
    }
    this.schedulePersist();
    return result;
  }

  /**
   * 清理：给 `bookUrl` 只清那一本，不给则全清。
   * 只删 `audio-cache/` 下的音频文件与索引，**不碰**书架/进度/正文缓存。
   */
  async clear(bookUrl?: string): Promise<AudioCacheClearResult> {
    await this.init();
    if (bookUrl) {
      const bookKey = audioBookKey(bookUrl);
      const book = this.index.books[bookKey];
      let items = 0;
      let bytes = 0;
      for (const e of Object.values(book?.chapters ?? {})) {
        if (!e.file) continue;
        items += 1;
        bytes += e.bytes;
      }
      await fsp.rm(path.join(this.dir, bookKey), { recursive: true, force: true }).catch(() => {});
      delete this.index.books[bookKey];
      this.schedulePersist();
      return { items, bytes };
    }
    let items = 0;
    let bytes = 0;
    for (const book of Object.values(this.index.books)) {
      for (const e of Object.values(book.chapters)) {
        if (!e.file) continue;
        items += 1;
        bytes += e.bytes;
      }
    }
    this.index = { version: 1, books: {} };
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!/^[0-9a-f]{16}$/i.test(name)) continue;
      await fsp.rm(path.join(this.dir, name), { recursive: true, force: true }).catch(() => {});
    }
    this.schedulePersist();
    return { items, bytes };
  }

  getConfig(): AudioCacheConfig {
    return this.config;
  }

  /** 更新配额（补丁式）→ 落盘 → 立即按新上限淘汰一次（只淘汰 stream） */
  async updateConfig(patch: unknown): Promise<AudioCacheConfig> {
    await this.init();
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    if (p['maxBytes'] !== undefined) this.config = resolveAudioCacheConfig({ maxBytes: p['maxBytes'] });
    await this.saveConfig();
    await this.evict();
    return this.config;
  }

  /** 进程退出前把索引落盘（测试/优雅关闭用） */
  async close(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistDirty = true;
    await this.flush();
  }
}

export function createAudioCache(opts: AudioCacheOptions): AudioCache {
  return new AudioCache(opts);
}
