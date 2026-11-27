/**
 * **音频离线任务历史**（只落失败 / 取消，B2 拍板方案 2）。
 *
 * 为什么只落失败任务：
 *  · 成功任务的结果已经由「磁盘文件 + 云朵 + index.json」证明，落历史只会重复占盘；
 *  · 失败 / 取消才是**排障信息**（重启后内存任务表清空，用户只记得「昨天有一章没下下来」）。
 *
 * 存储：`<DATA_DIR>/audio-job-history.json`，独立文件，**不进** `audio-cache/`，
 * 也不写用户源库。写入用「临时文件 + rename」原子替换（同 `source-subscriptions.json`）。
 *
 * 清理策略（用户拍板）：按 `updatedAt` 保留 **7 天**，且最多 **最近 200 条**。
 * 同一章节（`id` = `bookKey:chapterKey`）重复失败只留最新一条 —— 否则一本坏源
 * 连续重试 200 次就会把整份历史挤成同一章，等于没有历史。
 *
 * 文件损坏 / 手改坏单条一律跳过，**不因历史数据导致服务起不来**。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 历史保留时长：7 天 */
export const AUDIO_JOB_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 历史条数上限：最近 200 条 */
export const AUDIO_JOB_HISTORY_MAX = 200;

export type AudioJobHistoryStatus = 'error' | 'cancelled';

export interface AudioJobHistoryEntry {
  /** 任务键（`bookKey:chapterKey`，与内存任务表同口径） */
  id: string;
  bookUrl: string;
  chapterUrl: string;
  title: string;
  mode: 'stream' | 'manual';
  status: AudioJobHistoryStatus;
  /** 失败原因 / 取消说明（服务端短码或短句，可直接给用户看） */
  error: string;
  bytes: number;
  totalBytes: number;
  startedAt: number;
  updatedAt: number;
}

/** `record()` 的输入：接受内存任务（含额外字段）的结构子集 */
export interface AudioJobHistoryInput {
  id: string;
  bookUrl?: string;
  chapterUrl?: string;
  title?: string;
  mode?: string;
  status?: string;
  error?: string;
  bytes?: number;
  totalBytes?: number;
  startedAt?: number;
  updatedAt?: number;
}

interface AudioJobHistoryFile {
  version: 1;
  jobs: AudioJobHistoryEntry[];
}

export interface AudioJobHistoryOptions {
  /** JSON 文件绝对路径 */
  file: string;
  /** 时钟（测试注入） */
  now?: () => number;
}

export interface AudioJobHistoryListOptions {
  /** 只取某本书（`bookUrl` 精确匹配） */
  bookUrl?: string;
  /** 最多返回条数（默认全部，已按时间倒序） */
  limit?: number;
}

const isFailureStatus = (s: unknown): s is AudioJobHistoryStatus => s === 'error' || s === 'cancelled';

function text(v: unknown, max: number): string {
  return (typeof v === 'string' ? v : '').trim().slice(0, max);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 单条宽松解析：形状不对返回 null（坏一条不影响其它条目） */
function normalizeEntry(raw: unknown): AudioJobHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = text(r['id'], 200);
  const status = r['status'];
  if (!id || !isFailureStatus(status)) return null;
  const updatedAt = num(r['updatedAt']);
  if (!updatedAt) return null;
  return {
    id,
    bookUrl: text(r['bookUrl'], 2000),
    chapterUrl: text(r['chapterUrl'], 4000),
    title: text(r['title'], 300),
    mode: r['mode'] === 'manual' ? 'manual' : 'stream',
    status,
    error: text(r['error'], 300) || '未知原因',
    bytes: num(r['bytes']),
    totalBytes: num(r['totalBytes']),
    startedAt: num(r['startedAt']) || updatedAt,
    updatedAt,
  };
}

export class AudioJobHistory {
  private readonly file: string;
  private readonly now: () => number;
  private entries: AudioJobHistoryEntry[] = [];

  constructor(opts: AudioJobHistoryOptions) {
    this.file = opts.file;
    this.now = opts.now ?? Date.now;
    this.entries = this.prune(this.load());
  }

  private load(): AudioJobHistoryEntry[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      return [];
    }
    const jobs = (parsed as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(jobs)) return [];
    const out: AudioJobHistoryEntry[] = [];
    for (const raw of jobs) {
      const e = normalizeEntry(raw);
      if (e) out.push(e);
    }
    return out;
  }

  /** 去重（同 id 留最新）→ 按时间倒序 → 丢 7 天前 → 截到 200 条 */
  private prune(list: AudioJobHistoryEntry[]): AudioJobHistoryEntry[] {
    const latest = new Map<string, AudioJobHistoryEntry>();
    for (const e of list) {
      const prev = latest.get(e.id);
      if (!prev || e.updatedAt >= prev.updatedAt) latest.set(e.id, e);
    }
    const cutoff = this.now() - AUDIO_JOB_HISTORY_TTL_MS;
    return [...latest.values()]
      .filter((e) => e.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, AUDIO_JOB_HISTORY_MAX);
  }

  /** 原子落盘；失败只影响排障信息，不影响下载/播放本身 */
  private persist(): void {
    const body: AudioJobHistoryFile = { version: 1, jobs: this.entries };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* 磁盘满 / 权限不足：内存里的历史仍可用于本次运行 */
    }
  }

  /**
   * 记一条失败/取消。非终态失败（`done` / `unsupported` 等）直接忽略。
   * 返回写入后的条目；忽略时返回 null。
   */
  record(input: AudioJobHistoryInput): AudioJobHistoryEntry | null {
    if (!isFailureStatus(input.status)) return null;
    const id = text(input.id, 200);
    if (!id) return null;
    const updatedAt = num(input.updatedAt) || this.now();
    const entry: AudioJobHistoryEntry = {
      id,
      bookUrl: text(input.bookUrl, 2000),
      chapterUrl: text(input.chapterUrl, 4000),
      title: text(input.title, 300),
      mode: input.mode === 'manual' ? 'manual' : 'stream',
      status: input.status,
      error: text(input.error, 300) || (input.status === 'cancelled' ? '已取消' : '下载失败'),
      bytes: num(input.bytes),
      totalBytes: num(input.totalBytes),
      startedAt: num(input.startedAt) || updatedAt,
      updatedAt,
    };
    const next = this.entries.filter((e) => e.id !== id);
    next.push(entry);
    this.entries = this.prune(next);
    this.persist();
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /** 按时间倒序返回；`bookUrl` 精确过滤，`limit` 截断 */
  list(opts: AudioJobHistoryListOptions = {}): AudioJobHistoryEntry[] {
    const bookUrl = String(opts.bookUrl ?? '').trim();
    const list = bookUrl ? this.entries.filter((e) => e.bookUrl === bookUrl) : this.entries;
    const limit = num(opts.limit);
    return limit > 0 ? list.slice(0, Math.floor(limit)) : list;
  }
}

export function createAudioJobHistory(opts: AudioJobHistoryOptions): AudioJobHistory {
  return new AudioJobHistory(opts);
}
