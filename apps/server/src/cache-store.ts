/**
 * `#816` B5 **六类缓存的分区记账 / 配额 / LRU 驱逐 / 单类清理**。
 *
 * 六类划分来自 `docs/ref/external-capability-synthesis-2026-11-06.md` §3-B5：
 *
 * | 键 | 名称 | 存储 | 装什么 |
 * |---|---|---|---|
 * | `cover` | 封面缓存 | 服务端磁盘 | `/api/proxy?cover=1` 取回的封面字节（含源解密后的字节） |
 * | `toc` | 目录缓存 | 浏览器 IndexedDB | 书籍详情 + 章节目录本地化（`books` store） |
 * | `content` | 正文缓存 | 浏览器 IndexedDB | 已缓存/预缓存的章节正文（`chapters` store） |
 * | `manga` | 漫画缓存 | 服务端磁盘 | 漫画/图集源（Legado `bookSourceType=2`）的页面图片 |
 * | `image` | 图片缓存 | 服务端磁盘 | 正文/详情里的普通图片 |
 * | `localbook` | 本地书缓存 | 服务端磁盘 | 本地书章节的**解析结果**（书文件本身不在缓存里） |
 *
 * ## 为什么浏览器端两类不做自动驱逐
 * `toc` / `content` 的权威数据在用户浏览器里：正文缓存里既有预缓存窗口的章节，也有用户
 * 手动点「⬇ 离线缓存」的那批（后者在当前实现里**没有标记**）。自动 LRU 会把两者一视同仁，
 * 删掉手动缓存属于**不可逆的用户数据损失**（断了网就读不到）。所以这两类在本模块只有
 * 「配额配置」，统计与清理由设置页在浏览器侧完成；配额是**提示阈值**，不是硬删线。
 *
 * ## 服务端四类怎么守上限
 * - 每类 `maxItems` / `maxBytes` / `ttlMs` 都可调（设置页有入口），`0` 表示**关闭该类缓存**；
 * - 另有一条**总上限** `totalMaxBytes`（`0` = 不限），跨四类按 LRU 统一淘汰；
 * - 命中也算一次使用（`at` 前移），所以正在用的封面不会被大图挤掉。
 *
 * 元数据（键 → 文件 / 字节 / 类型 / 最后使用时间）记在 `index.json`（防抖写盘 + 原子替换），
 * 缓存字节一个键一个文件（`<sha1>.bin`）。索引丢了只会丢「键 → 文件」映射，启动时清掉孤儿文件，
 * 不会把错图当对图发出去。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const CACHE_CATEGORIES = ['cover', 'toc', 'content', 'manga', 'image', 'localbook'] as const;
export type CacheCategory = (typeof CACHE_CATEGORIES)[number];
export type CacheStorage = 'server' | 'browser';

/** 服务端落盘的四类（`toc`/`content` 在浏览器里） */
export const SERVER_CACHE_CATEGORIES = ['cover', 'manga', 'image', 'localbook'] as const;
export type ServerCacheCategory = (typeof SERVER_CACHE_CATEGORIES)[number];

export interface CacheLimits {
  /** 条目数上限；`0` = 关闭该类缓存 */
  maxItems: number;
  /** 字节上限；`0` = 关闭该类缓存 */
  maxBytes: number;
  /** 过期时间（毫秒）；`0` = 不按时间过期 */
  ttlMs: number;
}

export interface CacheConfig {
  /** 服务端四类合计字节上限；`0` = 不限 */
  totalMaxBytes: number;
  categories: Record<CacheCategory, CacheLimits>;
}

export interface CacheCategorySpec {
  key: CacheCategory;
  label: string;
  storage: CacheStorage;
  /** 给设置页的「清的是什么」文案（唯一来源，别在前端再抄一份） */
  describe: string;
  maxItems: number;
  maxBytes: number;
  ttlMs: number;
}

/** 单条缓存的最大字节（超过就不进缓存 —— 一张 8K 漫画大图/超长扫描件没有缓存价值） */
export const CACHE_MAX_ENTRY_BYTES = 12 * 1024 * 1024;

const MB = 1024 * 1024;
const MIN = 60_000;

/**
 * 默认值照 §3-B5 的拍板建议（300/50MB、200/20MB、200/50MB、1000/150MB、500/100MB、50/30MB，
 * 总上限 200MB）。注意：四类服务端缓存的**分项字节合计 330MB > 总上限 200MB** —— 这是
 * 有意的「分项是天花板、总量才是闸门」：谁在被用谁留下，其余按 LRU 让位。
 */
export const CACHE_CATEGORY_SPECS: readonly CacheCategorySpec[] = [
  {
    key: 'cover',
    label: '封面缓存',
    storage: 'server',
    describe: '发现页/详情页的封面图字节（含源解密后的版本）。清掉只会让下次重新取图，不影响书架。',
    maxItems: 300,
    maxBytes: 50 * MB,
    ttlMs: 30 * MIN,
  },
  {
    key: 'toc',
    label: '目录缓存',
    storage: 'browser',
    describe: '书籍详情 + 章节目录的本地化副本（浏览器 IndexedDB）。清掉后下次打开书会重新拉目录，阅读进度不受影响。',
    maxItems: 200,
    maxBytes: 20 * MB,
    ttlMs: 0,
  },
  {
    key: 'content',
    label: '正文缓存',
    storage: 'browser',
    describe: '已缓存的章节正文（含预缓存窗口与手动「离线缓存」）。清掉后离线读不了、需要重新联网缓存；阅读进度/书签不受影响。',
    maxItems: 200,
    maxBytes: 50 * MB,
    ttlMs: 0,
  },
  {
    key: 'manga',
    label: '漫画缓存',
    storage: 'server',
    describe: '漫画/图集源的页面图片。清掉只会让下次翻页重新取图。',
    maxItems: 1000,
    maxBytes: 150 * MB,
    ttlMs: 7 * 24 * 60 * MIN,
  },
  {
    key: 'image',
    label: '图片缓存',
    storage: 'server',
    describe: '正文/详情里的普通图片（非封面、非漫画页）。清掉只会让下次重新取图。',
    maxItems: 500,
    maxBytes: 100 * MB,
    ttlMs: 7 * 24 * 60 * MIN,
  },
  {
    key: 'localbook',
    label: '本地书缓存',
    storage: 'server',
    describe: '本地书章节的解析结果（txt 切章 / epub 解压后的正文）。清掉只会重建一次解析，导入的书文件与阅读进度都保留。',
    maxItems: 50,
    maxBytes: 30 * MB,
    ttlMs: 24 * 60 * MIN,
  },
];

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  totalMaxBytes: 200 * MB,
  categories: CACHE_CATEGORY_SPECS.reduce((acc, spec) => {
    acc[spec.key] = { maxItems: spec.maxItems, maxBytes: spec.maxBytes, ttlMs: spec.ttlMs };
    return acc;
  }, {} as Record<CacheCategory, CacheLimits>),
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  // 低于下界（如负数/小数舍入前的 -1）视为**非法输入**，回落默认值；
  // 只有显式给的 0 才表示「关闭该类缓存 / 不限总量」这类语义值。
  if (n < min) return fallback;
  return Math.min(max, Math.round(n));
}

function isServerCategory(v: unknown): v is ServerCacheCategory {
  return typeof v === 'string' && (SERVER_CACHE_CATEGORIES as readonly string[]).includes(v);
}

/**
 * 把任意来源（配置文件的旧版本、用户 PUT 的补丁）归一到合法配置。
 * 每个字段独立 clamp，坏字段回落默认值 —— 不允许「一处写错整份配置作废」。
 */
export function resolveCacheConfig(raw: unknown): CacheConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawCats = (src['categories'] && typeof src['categories'] === 'object'
    ? src['categories']
    : {}) as Record<string, unknown>;
  const categories = {} as Record<CacheCategory, CacheLimits>;
  for (const spec of CACHE_CATEGORY_SPECS) {
    const d = DEFAULT_CACHE_CONFIG.categories[spec.key];
    const c = (rawCats[spec.key] && typeof rawCats[spec.key] === 'object'
      ? rawCats[spec.key]
      : {}) as Record<string, unknown>;
    categories[spec.key] = {
      maxItems: clampInt(c['maxItems'], 0, 200_000, d.maxItems),
      maxBytes: clampInt(c['maxBytes'], 0, 8 * 1024 * MB, d.maxBytes),
      ttlMs: clampInt(c['ttlMs'], 0, 90 * 24 * 60 * MIN, d.ttlMs),
    };
  }
  return {
    totalMaxBytes: clampInt(src['totalMaxBytes'], 0, 8 * 1024 * MB, DEFAULT_CACHE_CONFIG.totalMaxBytes),
    categories,
  };
}

/** 合并一份补丁（只覆盖显式给出的字段），再走 `resolveCacheConfig` 做 range 校验 */
export function mergeCacheConfig(base: CacheConfig, patch: unknown): CacheConfig {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const nextCats = { ...base.categories } as Record<CacheCategory, CacheLimits>;
  const pCats = (p['categories'] && typeof p['categories'] === 'object'
    ? p['categories']
    : {}) as Record<string, unknown>;
  for (const spec of CACHE_CATEGORY_SPECS) {
    const pc = (pCats[spec.key] && typeof pCats[spec.key] === 'object'
      ? pCats[spec.key]
      : {}) as Record<string, unknown>;
    const cur = nextCats[spec.key];
    nextCats[spec.key] = {
      maxItems: spec.key in pCats && pc['maxItems'] !== undefined ? (pc['maxItems'] as number) : cur.maxItems,
      maxBytes: spec.key in pCats && pc['maxBytes'] !== undefined ? (pc['maxBytes'] as number) : cur.maxBytes,
      ttlMs: spec.key in pCats && pc['ttlMs'] !== undefined ? (pc['ttlMs'] as number) : cur.ttlMs,
    };
  }
  return resolveCacheConfig({
    totalMaxBytes: p['totalMaxBytes'] !== undefined ? p['totalMaxBytes'] : base.totalMaxBytes,
    categories: nextCats,
  });
}

interface CacheEntry {
  cat: ServerCacheCategory;
  key: string;
  file: string;
  bytes: number;
  type: string;
  /** 最后使用时间（命中也刷新，供 LRU 用） */
  at: number;
}

export interface CacheGetResult {
  buf: Buffer;
  type: string;
  at: number;
}

export interface CacheStatsRow extends CacheCategorySpec {
  items: number | null;
  bytes: number | null;
}

export interface CacheStats {
  categories: CacheStatsRow[];
  total: { bytes: number; maxBytes: number };
  /** 浏览器端两类由设置页本地补齐；服务端只回自己的账 */
  config: CacheConfig;
}

export interface CacheClearResult {
  items: number;
  bytes: number;
}

export interface CacheStoreOptions {
  /** 缓存根目录（`DATA_DIR/cache`） */
  dir: string;
  /** 配额配置文件（`DATA_DIR/cache-config.json`） */
  configFile: string;
  now?: () => number;
  /** 单条最大字节（测试可调小） */
  maxEntryBytes?: number;
  /** 写索引的防抖窗口；测试里可设 0 = 立即写 */
  persistDebounceMs?: number;
}

const mapKey = (cat: CacheCategory, key: string): string => `${cat}\n${key}`;
const fileOf = (cat: CacheCategory, key: string): string =>
  `${createHash('sha256').update(`${cat}|${key}`).digest('hex').slice(0, 40)}.bin`;

export class CacheStore {
  private readonly dir: string;
  private readonly configFile: string;
  private readonly now: () => number;
  private readonly maxEntryBytes: number;
  private readonly persistDebounceMs: number;
  private readonly indexFile: string;
  private readonly entries = new Map<string, CacheEntry>();
  private config: CacheConfig = DEFAULT_CACHE_CONFIG;
  private readyPromise: Promise<void> | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistDirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(opts: CacheStoreOptions) {
    this.dir = opts.dir;
    this.configFile = opts.configFile;
    this.now = opts.now ?? Date.now;
    this.maxEntryBytes = opts.maxEntryBytes ?? CACHE_MAX_ENTRY_BYTES;
    this.persistDebounceMs = opts.persistDebounceMs ?? 1500;
    this.indexFile = path.join(this.dir, 'index.json');
  }

  /** 幂等初始化（`get`/`put`/`stats` 内部都会 await 它） */
  init(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.doInit();
    return this.readyPromise;
  }

  private async doInit(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    for (const cat of SERVER_CACHE_CATEGORIES) {
      await fsp.mkdir(path.join(this.dir, cat), { recursive: true });
    }
    this.config = await this.loadConfig();
    await this.loadIndex();
    await this.pruneOrphanFiles();
    await this.evict();
  }

  private async loadConfig(): Promise<CacheConfig> {
    try {
      const text = await fsp.readFile(this.configFile, 'utf-8');
      return resolveCacheConfig(JSON.parse(text));
    } catch {
      return resolveCacheConfig(DEFAULT_CACHE_CONFIG);
    }
  }

  private async loadIndex(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(this.indexFile, 'utf-8'));
    } catch {
      parsed = null;
    }
    const list = Array.isArray((parsed as { entries?: unknown } | null)?.entries)
      ? ((parsed as { entries: unknown[] }).entries)
      : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (!isServerCategory(e['cat'])) continue;
      if (typeof e['key'] !== 'string' || !e['key']) continue;
      if (typeof e['file'] !== 'string' || !e['file']) continue;
      const bytes = Number(e['bytes']);
      const at = Number(e['at']);
      const type = typeof e['type'] === 'string' ? e['type'] : 'application/octet-stream';
      if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(at)) continue;
      const full = path.join(this.dir, e['cat'], e['file']);
      if (!fs.existsSync(full)) continue; // 文件被手动删了 ⇒ 索引项作废
      this.entries.set(mapKey(e['cat'], e['key']), {
        cat: e['cat'],
        key: e['key'],
        file: e['file'],
        bytes,
        type,
        at,
      });
    }
  }

  /** 索引丢了/旧了 ⇒ 清掉没人认领的缓存文件，避免磁盘越用越多 */
  private async pruneOrphanFiles(): Promise<void> {
    const known = new Set<string>();
    for (const e of this.entries.values()) known.add(path.join(e.cat, e.file));
    for (const cat of SERVER_CACHE_CATEGORIES) {
      let names: string[];
      try {
        names = await fsp.readdir(path.join(this.dir, cat));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.bin')) continue;
        if (known.has(path.join(cat, name))) continue;
        await fsp.rm(path.join(this.dir, cat, name), { force: true }).catch(() => {});
      }
    }
  }

  private filePath(e: CacheEntry): string {
    return path.join(this.dir, e.cat, e.file);
  }

  private async removeEntry(e: CacheEntry): Promise<void> {
    this.entries.delete(mapKey(e.cat, e.key));
    await fsp.rm(this.filePath(e), { force: true }).catch(() => {});
    this.schedulePersist();
  }

  private async writeEntryFile(e: CacheEntry, buf: Buffer): Promise<void> {
    const dir = path.join(this.dir, e.cat);
    await fsp.mkdir(dir, { recursive: true });
    const full = path.join(dir, e.file);
    const tmp = `${full}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, full);
  }

  /** 取缓存（命中刷新 LRU 时间；过期条目顺手删掉） */
  async get(cat: CacheCategory, key: string): Promise<CacheGetResult | null> {
    await this.init();
    if (!isServerCategory(cat)) return null;
    const e = this.entries.get(mapKey(cat, key));
    if (!e) return null;
    const limits = this.config.categories[cat];
    const now = this.now();
    if (limits.ttlMs > 0 && now - e.at > limits.ttlMs) {
      await this.removeEntry(e);
      return null;
    }
    try {
      const buf = await fsp.readFile(this.filePath(e));
      e.at = now;
      e.bytes = buf.length;
      this.schedulePersist();
      return { buf, type: e.type, at: now };
    } catch {
      await this.removeEntry(e);
      return null;
    }
  }

  /**
   * 存缓存。返回 true = 已落盘；false = 被策略拒收（该类关闭 / 超单条上限 / 超该类字节上限）。
   * 写入后立刻做一次淘汰（先分类、后总量）。
   */
  async put(cat: ServerCacheCategory, key: string, buf: Buffer, type: string): Promise<boolean> {
    await this.init();
    const limits = this.config.categories[cat];
    if (limits.maxItems <= 0 || limits.maxBytes <= 0) return false;
    if (buf.length === 0 || buf.length > this.maxEntryBytes || buf.length > limits.maxBytes) return false;
    const e: CacheEntry = {
      cat,
      key,
      file: fileOf(cat, key),
      bytes: buf.length,
      type: type || 'application/octet-stream',
      at: this.now(),
    };
    await this.writeEntryFile(e, buf);
    this.entries.set(mapKey(cat, key), e);
    await this.evict();
    this.schedulePersist();
    return true;
  }

  /**
   * 淘汰：① 每类按 `maxItems` / `maxBytes` 删最久没用的；② 再按总上限跨类删最久没用的。
   * 不删「刚进来的那条」以外的保护逻辑不单独做 —— 单条已经过 `maxEntryBytes` / `maxBytes` 两道闸。
   */
  private async evict(): Promise<void> {
    for (const cat of SERVER_CACHE_CATEGORIES) {
      const limits = this.config.categories[cat];
      const list = this.listOf(cat);
      let bytes = list.reduce((n, e) => n + e.bytes, 0);
      while (
        (limits.maxItems > 0 && list.length > limits.maxItems) ||
        (limits.maxBytes > 0 && bytes > limits.maxBytes)
      ) {
        const oldest = list.shift();
        if (!oldest) break;
        bytes -= oldest.bytes;
        await this.removeEntry(oldest);
      }
    }
    if (this.config.totalMaxBytes > 0) {
      let total = this.serverBytes();
      while (total > this.config.totalMaxBytes) {
        const oldest = this.oldestOfAll();
        if (!oldest) break;
        total -= oldest.bytes;
        await this.removeEntry(oldest);
      }
    }
  }

  private listOf(cat: ServerCacheCategory): CacheEntry[] {
    const out: CacheEntry[] = [];
    for (const e of this.entries.values()) if (e.cat === cat) out.push(e);
    return out.sort((a, b) => a.at - b.at);
  }

  private oldestOfAll(): CacheEntry | undefined {
    let oldest: CacheEntry | undefined;
    for (const e of this.entries.values()) {
      if (!oldest || e.at < oldest.at) oldest = e;
    }
    return oldest;
  }

  private serverBytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }

  async stats(): Promise<CacheStats> {
    await this.init();
    await this.sweepExpired();
    const counts = new Map<CacheCategory, { items: number; bytes: number }>();
    for (const cat of CACHE_CATEGORIES) counts.set(cat, { items: 0, bytes: 0 });
    for (const e of this.entries.values()) {
      const c = counts.get(e.cat);
      if (!c) continue;
      c.items += 1;
      c.bytes += e.bytes;
    }
    return {
      categories: CACHE_CATEGORY_SPECS.map((spec) => {
        const limits = this.config.categories[spec.key];
        const c = counts.get(spec.key) ?? { items: 0, bytes: 0 };
        return {
          ...spec,
          maxItems: limits.maxItems,
          maxBytes: limits.maxBytes,
          ttlMs: limits.ttlMs,
          items: spec.storage === 'server' ? c.items : null,
          bytes: spec.storage === 'server' ? c.bytes : null,
        };
      }),
      total: { bytes: this.serverBytes(), maxBytes: this.config.totalMaxBytes },
      config: this.config,
    };
  }

  private async sweepExpired(): Promise<void> {
    const now = this.now();
    for (const e of [...this.entries.values()]) {
      const limits = this.config.categories[e.cat];
      if (limits.ttlMs > 0 && now - e.at > limits.ttlMs) await this.removeEntry(e);
    }
  }

  getConfig(): CacheConfig {
    return this.config;
  }

  /** 更新配额（补丁式）→ 落盘 → 立刻按新上限淘汰一次 */
  async updateConfig(patch: unknown): Promise<CacheConfig> {
    await this.init();
    this.config = mergeCacheConfig(this.config, patch);
    await this.saveConfig();
    await this.evict();
    this.schedulePersist();
    return this.config;
  }

  private async saveConfig(): Promise<void> {
    await fsp.mkdir(path.dirname(this.configFile), { recursive: true });
    const tmp = `${this.configFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fsp.writeFile(tmp, JSON.stringify(this.config, null, 2));
    await fsp.rename(tmp, this.configFile);
  }

  /**
   * 清一类 / 全部（只动服务端四类；浏览器两类由设置页在本地清）。
   * `toc`/`content` 传进来会返回 0 —— 接口层会先拦下并说明原因。
   */
  async clear(cat: CacheCategory | 'all'): Promise<CacheClearResult> {
    await this.init();
    const targets: ServerCacheCategory[] =
      cat === 'all'
        ? [...SERVER_CACHE_CATEGORIES]
        : isServerCategory(cat)
          ? [cat]
          : [];
    let items = 0;
    let bytes = 0;
    for (const c of targets) {
      for (const e of this.listOf(c)) {
        items += 1;
        bytes += e.bytes;
        await this.removeEntry(e);
      }
    }
    await this.flush();
    return { items, bytes };
  }

  /** 把防抖中的索引立即落盘（测试 / 退出前用） */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistDirty) {
      await this.writing;
      return;
    }
    this.persistDirty = false;
    const snapshot = JSON.stringify(
      { version: 1, entries: [...this.entries.values()] },
      null,
      2,
    );
    const tmp = `${this.indexFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const task = (async () => {
      await fsp.mkdir(path.dirname(this.indexFile), { recursive: true });
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, this.indexFile);
    })().catch(() => {
      /* 索引写失败不影响缓存读取：下次启动按孤儿文件清理即可 */
    });
    this.writing = task;
    await task;
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
    // 不要因为一个延迟写索引的定时器把进程钉住（CLI / 测试会等不到退出）
    this.persistTimer.unref?.();
  }

  async dispose(): Promise<void> {
    await this.flush();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }
}

export function createCacheStore(opts: CacheStoreOptions): CacheStore {
  return new CacheStore(opts);
}
