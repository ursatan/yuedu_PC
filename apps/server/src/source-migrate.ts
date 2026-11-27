/**
 * 旧双存储 → 单一源库的一次性迁移（`#651`）。
 *
 * ## 迁移什么
 * ```
 * data/sources/book-NNN/ 里每个 .json 一源   484 个（1 源 1 文件，id = 文件名）
 * data/imported-sources.json     265 条（JSON 覆盖层，id = deriveId）
 *                     ↓ 按 identity 去重
 * data/yuedu.db  sources / sources_trash
 * ```
 *
 * ## 去重规则（**实测出来的，不是拍的**）
 * 用户实际数据里 749 条只有 747 个唯一 `bookSourceUrl`，2 对重复：
 * · 速读谷：`https___www.shudugu.org`（文件源，**书架里 9 本书挂在它上面**）vs `…org_`（覆盖层）；
 * · 📚木里聚合：90 个下划线（文件源）vs 118 个下划线 + `2026_5_2_16_30`（覆盖层）。
 *
 * ⇒ **同一 identity 以「先到」为准，而目录源先于覆盖层**：
 *   ① 书架 `books.origin` 引用的是**文件源 id**（速读谷那 9 本），若反过来保留覆盖层 id，
 *      这 9 本书就变成「源不存在」；
 *   ② 覆盖层那份通常是**后来再导一次**产生的副本，规则内容与文件源等价（`sameSourceRaw` 判等）。
 *   被丢弃的那条**不静默**：计入 `merged` 并在日志里逐条报出名字与两个 id。
 *
 * ## 幂等
 * `sources` 表非空就直接返回 `{skipped:true}` —— 重复调用不会把库写乱。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceDb } from '@yuedu/core';
import { sourceIdentityOf } from '@yuedu/core';

export interface MigrateResult {
  /** 目录里成功读到的源文件数 */
  files: number;
  /** 覆盖层里的源条目数 */
  overlay: number;
  /** 因 identity 重复被合并掉的条数 */
  merged: number;
  /** 搬进回收站的条数 */
  trash: number;
  /** 覆盖层里有、但对应文件不存在 ⇒ 必须迁入的条数 */
  userOnly: number;
  broken: number;
  /** 表已非空，什么都没做 */
  skipped: boolean;
  /** 被合并掉的具体条目（`名字 | 保留id | 丢弃id`），给日志/审计 */
  mergedDetail: string[];
}

interface Cand {
  id: string;
  name?: string;
  kind: string;
  raw: unknown;
  identity: string;
  origin: 'file' | 'overlay';
  addedAt: number;
  state?: { enabled: boolean; searchEnabled: boolean; exploreEnabled: boolean };
}

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function nameOf(raw: unknown): string | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = r['bookSourceName'] ?? r['sourceName'] ?? r['name'];
  return typeof n === 'string' && n.trim() ? n.trim() : undefined;
}

/** 扫目录（`loadDir` 的读法：**文件名即 id**，历史语义，迁移后不再使用） */
export function scanSourceDirs(dirs: readonly string[]): { rows: Cand[]; broken: number } {
  const rows: Cand[] = [];
  let broken = 0;
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const raw = readJson(path.join(dir, f));
      if (raw === undefined) {
        broken++;
        continue;
      }
      const identity = sourceIdentityOf(raw);
      if (!identity) {
        broken++; // `_index.json` / `_regression_*.json` 这类汇总文件（与 loadDir 同口径）
        continue;
      }
      rows.push({
        id: f.replace(/\.json$/, ''),
        ...(nameOf(raw) ? { name: nameOf(raw) as string } : {}),
        kind: 'legado',
        raw,
        identity,
        origin: 'file',
        addedAt: 0,
      });
    }
  }
  return { rows, broken };
}

/** 读旧覆盖层（`imported-sources.json`，含 `states` / `trash` / `removed`） */
export function readLegacyOverlay(file: string): {
  entries: Cand[];
  states: Record<string, { enabled: boolean; searchEnabled: boolean; exploreEnabled: boolean }>;
  trash: Array<{ id: string; name?: string; kind?: string; raw?: unknown; deletedAt: number; fileBacked: boolean; addedAt?: number }>;
} {
  const out = {
    entries: [] as Cand[],
    states: {} as Record<string, { enabled: boolean; searchEnabled: boolean; exploreEnabled: boolean }>,
    trash: [] as Array<{ id: string; name?: string; kind?: string; raw?: unknown; deletedAt: number; fileBacked: boolean; addedAt?: number }>,
  };
  const j = readJson(file) as
    | {
        sources?: Array<{ id?: string; kind?: string; name?: string; raw?: unknown; state?: unknown; addedAt?: number }>;
        states?: Record<string, unknown>;
        trash?: Array<Record<string, unknown>>;
        removed?: string[];
      }
    | undefined;
  if (!j || typeof j !== 'object') return out;

  for (const e of Array.isArray(j.sources) ? j.sources : []) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    out.entries.push({
      id: e.id,
      ...(typeof e.name === 'string' && e.name ? { name: e.name } : {}),
      kind: typeof e.kind === 'string' ? e.kind : 'legado',
      raw: e.raw,
      identity: sourceIdentityOf(e.raw),
      origin: 'overlay',
      addedAt: Number(e.addedAt ?? 0),
      ...(e.state && typeof e.state === 'object'
        ? {
            state: {
              enabled: (e.state as { enabled?: boolean }).enabled !== false,
              searchEnabled: (e.state as { searchEnabled?: boolean }).searchEnabled !== false,
              exploreEnabled: (e.state as { exploreEnabled?: boolean }).exploreEnabled !== false,
            },
          }
        : {}),
    });
  }
  for (const [id, st] of Object.entries(j.states ?? {})) {
    if (!id || !st || typeof st !== 'object') continue;
    const s = st as { enabled?: boolean; searchEnabled?: boolean; exploreEnabled?: boolean };
    out.states[id] = {
      enabled: s.enabled !== false,
      searchEnabled: s.searchEnabled !== false,
      exploreEnabled: s.exploreEnabled !== false,
    };
  }
  for (const t of Array.isArray(j.trash) ? j.trash : []) {
    if (!t || typeof t.id !== 'string' || !t.id) continue;
    out.trash.push({
      id: t.id,
      ...(typeof t.name === 'string' ? { name: t.name } : {}),
      ...(typeof t.kind === 'string' ? { kind: t.kind } : {}),
      ...(t.raw !== undefined ? { raw: t.raw } : {}),
      deletedAt: Number(t.deletedAt ?? 0),
      fileBacked: t.fileBacked === true,
      ...(t.addedAt !== undefined ? { addedAt: Number(t.addedAt) } : {}),
    });
  }
  for (const id of Array.isArray(j.removed) ? j.removed : []) {
    if (typeof id !== 'string' || !id) continue;
    if (out.trash.some((t) => t.id === id)) continue;
    // 旧字段 `removed` 只有 id（旧版用户源删除即丢）⇒ 只能记成「无 raw 的墓碑」，
    // 迁移后这类条目**不可恢复**（raw 从来没落过盘）。保留它是为了「不再出现在列表里」。
    out.trash.push({ id, deletedAt: 0, fileBacked: true });
  }
  return out;
}

/**
 * 执行迁移。`db` 必须是**已打开**的 `SourceDb`。
 *
 * 写库分两段（各一个事务）：先 `sources`（`upsertMany`），再逐条 `addTrash`。
 */
export function migrateLegacySources(opts: {
  db: SourceDb;
  /** 旧源目录（如 `data/sources/book-482`、`apps/server/sources/cms`） */
  dirs?: readonly string[];
  /** 旧覆盖层文件（`data/imported-sources.json`） */
  overlayFile?: string;
  log?: (msg: string) => void;
}): MigrateResult {
  const log = opts.log ?? (() => {});
  const res: MigrateResult = {
    files: 0,
    overlay: 0,
    merged: 0,
    trash: 0,
    userOnly: 0,
    broken: 0,
    skipped: false,
    mergedDetail: [],
  };
  if (opts.db.count() > 0) {
    res.skipped = true;
    log(`源库已有 ${opts.db.count()} 条，跳过迁移（幂等）`);
    return res;
  }

  const scanned = scanSourceDirs(opts.dirs ?? []);
  res.files = scanned.rows.length;
  res.broken += scanned.broken;
  const ov = opts.overlayFile && fs.existsSync(opts.overlayFile)
    ? readLegacyOverlay(opts.overlayFile)
    : { entries: [], states: {}, trash: [] };
  res.overlay = ov.entries.length;

  // 目录源先入表（同一 identity 时它赢 —— 见文件头「去重规则」）
  const byIdentity = new Map<string, Cand>();
  const finalRows: Cand[] = [];
  for (const c of [...scanned.rows, ...ov.entries]) {
    const st = ov.states[c.id] ?? c.state;
    const row: Cand = st ? { ...c, state: st } : c;
    if (row.identity) {
      const prev = byIdentity.get(row.identity);
      if (prev) {
        res.merged++;
        const detail = `${row.name ?? row.id} | 保留 ${prev.id}(${prev.origin}) | 丢弃 ${row.id}(${row.origin})`;
        res.mergedDetail.push(detail);
        log(`合并重复源：${detail}`);
        continue;
      }
      byIdentity.set(row.identity, row);
    }
    finalRows.push(row);
    if (row.origin === 'overlay') res.userOnly++;
  }

  opts.db.upsertMany(
    finalRows.map((r) => ({
      id: r.id,
      identity: r.identity,
      ...(r.name ? { name: r.name } : {}),
      kind: r.kind,
      raw: r.raw,
      ...(r.state ? { state: r.state } : {}),
      ...(r.addedAt ? { addedAt: r.addedAt } : {}),
    })),
  );

  for (const t of ov.trash) {
    // 文件源墓碑：文件仍在目录里 ⇒ 用文件内容补 raw，才能真正「可恢复」
    let raw = t.raw;
    if (raw === undefined && t.fileBacked) {
      const c = scanned.rows.find((r) => r.id === t.id);
      raw = c?.raw;
    }
    if (raw === undefined) {
      log(`回收站条目 ${t.name ?? t.id} 没有 raw（旧版删除即丢），迁移后不可恢复`);
      continue;
    }
    opts.db.addTrash({
      id: t.id,
      name: t.name,
      kind: t.kind ?? 'legado',
      raw,
      deletedAt: t.deletedAt,
      ...(t.addedAt !== undefined ? { addedAt: t.addedAt } : {}),
    });
    res.trash++;
  }

  log(
    `迁移完成：文件源 ${res.files} · 覆盖层 ${res.overlay} · 合并重复 ${res.merged} · ` +
      `回收站 ${res.trash} · 坏文件 ${res.broken} ⇒ 库内 ${opts.db.count()} 条`,
  );
  return res;
}
