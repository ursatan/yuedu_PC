/**
 * `B6` **书源体检：五态 + 质量分 + `dead` 3 天跳过**（服务端唯一口径）。
 *
 * 落库 `data/source-health.json`（`tmp` + `rename`），只存「体检结果」，
 * 不进源定义（raw 会被导出/导入带走，体检结论是本机事实）。
 *
 * 五态判定（`SourceHealthState`）：域名不可达 / 连续失败 ≥3 ⇒ `dead`；
 * 搜索（核心）失败 ⇒ `broken`；搜索通过但其它环节失败 ⇒ `degraded`；
 * 全通过但慢 ⇒ `slow`；其余 ⇒ `ok`。质量分由五态 + 响应时间 + 失败环节数推导。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  SOURCE_DEAD_FAILURE_LIMIT,
  SOURCE_DEAD_SKIP_MS,
  SOURCE_SLOW_RESPOND_MS,
  isSourceHealthDeadActive,
  type SourceHealth,
  type SourceHealthState,
} from '@yuedu/core';
import type { VerifyOutcome } from '@yuedu/facade';

export interface SourceHealthRecord extends SourceHealth {
  id: string;
}

export interface SourceHealthStore {
  /** 单个源的体检结果（无记录 ⇒ undefined） */
  get(id: string): SourceHealth | undefined;
  /** 全量（按 id 排序，便于稳定展示） */
  list(): SourceHealthRecord[];
  /** 该源是否仍在 `dead` 跳过期内（体检/搜索/换源据此排除） */
  isDeadActive(id: string, now?: number): boolean;
  /** 写入一条体检结果（通过一次清零连续失败；连续失败 ≥3 判 dead） */
  apply(id: string, outcome: VerifyOutcome, now?: number): SourceHealth;
  /** 删除（源被删时调用） */
  remove(id: string): void;
}

const VALID_STATES: ReadonlySet<string> = new Set(['ok', 'slow', 'degraded', 'broken', 'dead']);

/** 发现链路（深校验）失败的扣分档位；搜索失败单独走 `broken` 基线 */
function stagePenalty(key: string): number {
  if (key === 'info' || key === 'toc') return 8;
  if (key === 'content') return 6;
  if (key === 'explore') return 5;
  return 4; // exploreInfo / exploreToc / exploreContent
}

/**
 * 从一次 `hub.verifySource` 的结果推导五态 + 质量分。
 * `prev` 用于连续失败计数（`dead` 的唯一累积判据）。
 */
export function computeSourceHealth(
  outcome: VerifyOutcome,
  prev?: SourceHealth | null,
  now = Date.now(),
): SourceHealth {
  const failures = outcome.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  const stages = outcome.stages || {};
  const domainFailed = !!stages.domain && !stages.domain.ok;
  const searchFailed = !!stages.search && !stages.search.ok;
  // 没有 search 分段（如 RSS/文章类）时，整体失败即视为核心失败
  const coreFailed = searchFailed || (!stages.search && !outcome.ok);

  let state: SourceHealthState;
  if (domainFailed || failures >= SOURCE_DEAD_FAILURE_LIMIT) state = 'dead';
  else if (!outcome.ok) state = coreFailed ? 'broken' : 'degraded';
  else state = outcome.respondTime >= SOURCE_SLOW_RESPOND_MS ? 'slow' : 'ok';

  let quality: number;
  if (state === 'dead') {
    quality = 0;
  } else {
    quality = coreFailed ? 35 : !outcome.ok ? 70 : 100;
    for (const [key, stage] of Object.entries(stages)) {
      if (!stage || stage.ok || key === 'domain' || key === 'search') continue;
      quality -= stagePenalty(key);
    }
    if (outcome.respondTime >= 5000) quality -= 30;
    else if (outcome.respondTime >= SOURCE_SLOW_RESPOND_MS) quality -= 15;
    else if (outcome.respondTime >= 1200) quality -= 5;
    quality = Math.max(0, Math.min(100, Math.round(quality)));
  }

  const message =
    state === 'dead' && domainFailed
      ? `域名不可达：${stages.domain?.error || outcome.message || '请求失败'}`
      : state === 'dead'
        ? `连续 ${failures} 次失败，已跳过体检/搜索/换源 3 天：${outcome.message || '未通过'}`
        : outcome.message || (outcome.ok ? '通过' : '未通过');

  return {
    state,
    quality,
    checkedAt: now,
    respondTime: Math.max(0, Math.round(outcome.respondTime || 0)),
    consecutiveFailures: failures,
    ...(state === 'dead' ? { deadUntil: now + SOURCE_DEAD_SKIP_MS } : {}),
    message,
  };
}

function normalizeEntry(raw: unknown): SourceHealth | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Partial<SourceHealth>;
  if (typeof it.state !== 'string' || !VALID_STATES.has(it.state)) return null;
  if (typeof it.checkedAt !== 'number' || !Number.isFinite(it.checkedAt)) return null;
  const q = Number(it.quality);
  return {
    state: it.state as SourceHealthState,
    quality: Number.isFinite(q) ? Math.max(0, Math.min(100, Math.round(q))) : 0,
    checkedAt: it.checkedAt,
    respondTime: typeof it.respondTime === 'number' && Number.isFinite(it.respondTime) ? it.respondTime : 0,
    ...(typeof it.consecutiveFailures === 'number' && Number.isFinite(it.consecutiveFailures)
      ? { consecutiveFailures: Math.max(0, Math.round(it.consecutiveFailures)) }
      : {}),
    ...(typeof it.deadUntil === 'number' && Number.isFinite(it.deadUntil) ? { deadUntil: it.deadUntil } : {}),
    ...(typeof it.message === 'string' && it.message ? { message: it.message.slice(0, 240) } : {}),
  };
}

export function createSourceHealthStore(file: string): SourceHealthStore {
  let cache: Record<string, SourceHealth> | null = null;

  const load = (): Record<string, SourceHealth> => {
    if (cache) return cache;
    cache = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      const entries = raw && typeof raw === 'object' ? (raw as { entries?: unknown }).entries : null;
      if (entries && typeof entries === 'object') {
        for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
          const entry = normalizeEntry(value);
          if (entry) cache[id] = entry;
        }
      }
    } catch {
      // 文件不存在/损坏：从空表开始（损坏文件留给人工，下一次写入才覆盖）
    }
    return cache;
  };

  const persist = (): void => {
    if (!cache) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: cache }, null, 0), 'utf-8');
      fs.renameSync(tmp, file);
    } catch {
      // 落库失败不阻断体检结果（内存里仍是最新值，下一次写入重试）
    }
  };

  return {
    get(id) {
      return load()[String(id)];
    },
    list() {
      const all = load();
      const out: SourceHealthRecord[] = [];
      for (const id of Object.keys(all).sort()) {
        const entry = all[id];
        if (entry) out.push({ id, ...entry });
      }
      return out;
    },
    isDeadActive(id, now = Date.now()) {
      return isSourceHealthDeadActive(load()[String(id)], now);
    },
    apply(id, outcome, now = Date.now()) {
      const key = String(id);
      const prev = load()[key];
      const entry = computeSourceHealth(outcome, prev, now);
      load()[key] = entry;
      persist();
      return entry;
    },
    remove(id) {
      const key = String(id);
      const all = load();
      if (!all[key]) return;
      delete all[key];
      persist();
    },
  };
}
