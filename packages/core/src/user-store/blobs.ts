/**
 * 二进制内容缓存（Phase 1.2 的「文件 blob」部分）
 *
 * ## 为什么与用户数据分开，而不是把索引放进 yuedu.db
 * 路线图 §1.2 原计划是「二进制 → 文件，**库内只存索引**」。实现时改为**独立模块 + 独立索引文件**，
 * 理由（三条都是运维层面的硬约束，不是偷懒）：
 * 1. **生命周期完全不同**：blob 是**可随时丢弃的缓存**（正文/图片/封面），用户数据丢了是事故、缓存丢了只是变慢。
 *    放在同一份 DB 里，`VACUUM`/备份/导出会连缓存一起搬，用户数据体积被无谓放大。
 * 2. **清理策略不同**：缓存需要按「总容量上限 + LRU」自动淘汰（见 {@link BlobStore.sweep}），
 *    这与用户数据的「永不自动删除」语义相反，混在一起容易误删。
 * 3. **不需要事务/外键/联表**：blob 只按 key 存取，索引是纯映射，用 DB 换不来任何能力。
 *
 * ## 结构
 * ```
 * <dir>/blobs/<sha256 前2位>/<sha256>     ← 实际内容（分片目录，避免单目录上万文件）
 * <dir>/blobs-index.json                  ← { version, entries: { key: {size, mtime, type} } }
 * ```
 * key 用 `sha256(key)` 落盘 → 天然规避路径穿越与非法字符；原 key 只在索引里出现。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 索引写盘防抖窗口 */
const FLUSH_DELAY_MS = 250;
const INDEX_VERSION = 1;

export interface BlobMeta {
  /** 字节数 */
  size: number;
  /** 写入/最后访问时间（毫秒）—— LRU 淘汰依据 */
  mtime: number;
  /** 可选的内容类型（图片/文本），便于上层设置响应头 */
  type?: string;
}

interface BlobIndex {
  version: number;
  entries: Record<string, BlobMeta>;
}

export interface BlobSweepPolicy {
  /** 容量上限（字节）；超出则按 LRU 从最旧开始删 */
  maxBytes?: number;
  /** 最久未访问时长（毫秒）；超过则删 */
  maxAgeMs?: number;
}

export interface BlobSweepResult {
  removed: number;
  freedBytes: number;
}

export interface BlobStore {
  readonly dir: string;
  /** 写入（覆盖）。`type` 可选，用于图片等需要 content-type 的场景 */
  put(key: string, data: string | Uint8Array, type?: string): void;
  /** 读取内容；不存在返回 null */
  get(key: string): Uint8Array | null;
  /** 读取为文本；不存在返回 null */
  getText(key: string): string | null;
  has(key: string): boolean;
  stat(key: string): BlobMeta | null;
  delete(key: string): boolean;
  /** 列出索引（可按 key 前缀过滤） */
  list(prefix?: string): Record<string, BlobMeta>;
  /** 已用总字节数 */
  totalSize(): number;
  /** 按策略淘汰（LRU）。返回删除条数与释放字节数 */
  sweep(policy: BlobSweepPolicy): BlobSweepResult;
  /** 立即落索引（`close()` 会调用） */
  flush(): void;
  close(): void;
}

/** key → 落盘文件名（sha256 hex，天然安全） */
function keyToFile(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function createBlobStore(dir: string): BlobStore {
  const root = join(dir, 'blobs');
  const indexFile = join(dir, 'blobs-index.json');
  mkdirSync(root, { recursive: true });

  let index: BlobIndex;
  try {
    const parsed = JSON.parse(readFileSync(indexFile, 'utf-8')) as Partial<BlobIndex>;
    index = { version: INDEX_VERSION, entries: parsed.entries ?? {} };
  } catch {
    index = { version: INDEX_VERSION, entries: {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      writeFileSync(indexFile, JSON.stringify(index), 'utf-8');
    } catch {
      /* 写索引失败不阻断读取（内容文件仍在） */
    }
  };
  const touch = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_DELAY_MS);
  };

  const pathOf = (key: string): string => {
    const hash = keyToFile(key);
    return join(root, hash.slice(0, 2), hash);
  };

  const store: BlobStore = {
    dir: root,

    put(key: string, data: string | Uint8Array, type?: string): void {
      const file = pathOf(key);
      mkdirSync(join(root, keyToFile(key).slice(0, 2)), { recursive: true });
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
      writeFileSync(file, buf);
      index.entries[key] = {
        size: buf.byteLength,
        mtime: Date.now(),
        ...(type === undefined ? {} : { type }),
      };
      touch();
    },

    get(key: string): Uint8Array | null {
      const file = pathOf(key);
      try {
        const buf = readFileSync(file);
        // 命中即刷新 mtime（LRU 需要"最近访问"）
        const meta = index.entries[key];
        if (meta) {
          meta.mtime = Date.now();
          touch();
        }
        return buf;
      } catch {
        // 索引说有、磁盘没有（被外部删了）→ 顺手修索引
        if (index.entries[key]) {
          delete index.entries[key];
          touch();
        }
        return null;
      }
    },

    getText(key: string): string | null {
      const buf = store.get(key);
      return buf === null ? null : Buffer.from(buf).toString('utf-8');
    },

    has(key: string): boolean {
      return index.entries[key] !== undefined && existsSync(pathOf(key));
    },

    stat(key: string): BlobMeta | null {
      const meta = index.entries[key];
      if (!meta) return null;
      try {
        const st = statSync(pathOf(key));
        return { ...meta, size: st.size };
      } catch {
        return null;
      }
    },

    delete(key: string): boolean {
      const existed = index.entries[key] !== undefined;
      delete index.entries[key];
      try {
        rmSync(pathOf(key), { force: true });
      } catch {
        /* 文件已不在 → 视作删除成功 */
      }
      touch();
      return existed;
    },

    list(prefix?: string): Record<string, BlobMeta> {
      if (prefix === undefined) return { ...index.entries };
      const out: Record<string, BlobMeta> = {};
      for (const [k, v] of Object.entries(index.entries)) if (k.startsWith(prefix)) out[k] = { ...v };
      return out;
    },

    totalSize(): number {
      let sum = 0;
      for (const meta of Object.values(index.entries)) sum += meta.size;
      return sum;
    },

    sweep(policy: BlobSweepPolicy): BlobSweepResult {
      const { maxBytes, maxAgeMs } = policy;
      const now = Date.now();
      let removed = 0;
      let freedBytes = 0;

      const drop = (key: string, size: number): void => {
        delete index.entries[key];
        try {
          rmSync(pathOf(key), { force: true });
        } catch {
          /* 忽略 */
        }
        removed += 1;
        freedBytes += size;
      };

      // 1) 按年龄（最久未访问）
      if (maxAgeMs !== undefined) {
        for (const [key, meta] of Object.entries(index.entries)) {
          if (now - meta.mtime > maxAgeMs) drop(key, meta.size);
        }
      }
      // 2) 按容量：LRU 从最旧开始删
      if (maxBytes !== undefined && store.totalSize() > maxBytes) {
        const sorted = Object.entries(index.entries).sort((a, b) => a[1].mtime - b[1].mtime);
        for (const [key, meta] of sorted) {
          if (store.totalSize() <= maxBytes) break;
          drop(key, meta.size);
        }
      }
      if (removed) touch();
      return { removed, freedBytes };
    },

    flush,
    close(): void {
      flush();
    },
  };

  return store;
}
