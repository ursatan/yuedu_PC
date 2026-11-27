/**
 * 阅读会话合成器（P1 `#863`）。
 *
 * ## 它解决什么
 * B1 的本地日桶只能产出「今天多少秒」；本模块把一次连续阅读拆成**可落库的会话流水**：
 * `total_ms`（前台在线）与 `effective_ms`（**本模式**的有效时长）分开，且 `visual` / `listen` / `auto`
 * **各自独立成会话**（切模式即拆，不给「半段归属不清」留口子）。
 *
 * ## 有效时长口径（D-3 / D-6）
 * - `visual`：只在「页面可见 + 最近 120s 内有过活动事件」时累计。活动 = 翻页/滚动/切章/点击/键盘
 *   都算——**不是「必须翻页」**（滚动阅读没有翻页，照抄那个口径会永远算 0）；
 * - 单次 tick 最多记 120s（浏览器把后台定时器节流到几分钟一次时，不能把整段空档补记进来）；
 * - `listen`：播放中才累计；`auto`：自动滚动开启时累计。二者都**不进**目视有效。
 *
 * ## 崩溃兜底
 * 每 2 分钟把未结束会话写 localStorage 检查点（`session_id` 固定）。重进阅读页时：
 * - 同一本书且 `endAt` 距今 ≤ 10 分钟 ⇒ **续接**（不重复起会话）；
 * - 否则把检查点当一条已结束会话**补传**，再起新会话。
 *
 * 会话**结束时**才 POST（幂等，`session_id` 由客户端生成）；失败进本地队列，下次进阅读页重试。
 *
 * ## 归属
 * 只给 `ReaderOverlay` 用（文本阅读）。漫画/PDF 在 P1 不统计（D-8），由调用方门控。
 */
import type { ReadSession, ReadSessionMode } from '@yuedu/core/contract';

import { appendReadSessions } from '../user-data';

/** 空闲超时：最近一次活动事件之后最多记这么久（D-6） */
export const IDLE_TIMEOUT_MS = 120_000;
/** 单次 tick 最多累计的墙钟时长（防后台节流后补记整段空档） */
export const MAX_STEP_MS = 120_000;
/** 检查点写盘间隔 */
export const CHECKPOINT_INTERVAL_MS = 120_000;
/** 检查点有效期：超过就不续接，直接结算 */
export const CHECKPOINT_TTL_MS = 600_000;

export const DEVICE_ID_KEY = 'yuedu.deviceId.v1';
export const SESSION_CHECKPOINT_KEY = 'yuedu.readSession.v1';
export const SESSION_QUEUE_KEY = 'yuedu.readSessionQueue.v1';
/** 离线队列上限（超出丢最老，防止 localStorage 被撑爆） */
export const SESSION_QUEUE_LIMIT = 200;

export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageOrNull(s?: SessionStorage): SessionStorage | null {
  if (s) return s;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function uuid(): string {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* 极老运行时/非安全上下文 → 走下面的兜底 */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 每 origin 一个稳定设备标识（D-10，仅用于排重；不注册、不上报） */
export function ensureDeviceId(s?: SessionStorage): string {
  const st = storageOrNull(s);
  if (!st) return 'local';
  try {
    const cur = st.getItem(DEVICE_ID_KEY);
    if (cur && cur.length <= 128) return cur;
    const id = `yu-${uuid()}`;
    st.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return 'local';
  }
}

/** 会话的静态元信息 */
export interface ReadSessionMeta {
  bookUrl: string;
  bookName: string;
  bookAuthor: string;
  chapterIndex: number;
  chapterTitle: string;
  /** 会话开始时的整体进度（0~1） */
  startProgress: number;
}

export interface ReadSessionTrackerOptions {
  meta: ReadSessionMeta;
  mode: ReadSessionMode;
  /** 注入时间源（测试用） */
  now?: () => number;
  deviceId?: string;
  storage?: SessionStorage;
  /** 恢复检查点时指定（保证续接的会话 id 不变） */
  sessionId?: string;
  /** 恢复检查点时指定（避免把上次累计丢掉） */
  restored?: Pick<ReadSession, 'startAt' | 'totalMs' | 'effectiveMs' | 'readPageCount'>;
}

/**
 * 一次会话的计时器。
 *
 * 调用约定：外部每 15s 调 `tick()`；任何用户动作调 `markActivity()`；
 * 页面隐藏/卸载先 `finish()` 再落库。
 */
export class ReadSessionTracker {
  readonly sessionId: string;
  readonly meta: ReadSessionMeta;
  readonly startedAt: number;
  readonly deviceId: string;
  private readonly now: () => number;
  private mode: ReadSessionMode;
  private lastTickAt: number;
  private lastActivityAt: number;
  private totalMs: number;
  private effectiveMs: number;
  private pageCount: number;
  private chapterIndex: number;
  private chapterTitle: string;
  private endProgress: number;
  private visible = true;
  private modeActive = true;
  private finished = false;

  constructor(opts: ReadSessionTrackerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sessionId = opts.sessionId ?? uuid();
    this.meta = { ...opts.meta };
    this.mode = opts.mode;
    this.deviceId = opts.deviceId ?? ensureDeviceId(opts.storage);
    this.chapterIndex = opts.meta.chapterIndex;
    this.chapterTitle = opts.meta.chapterTitle;
    this.endProgress = opts.meta.startProgress;
    this.startedAt = opts.restored?.startAt ?? this.now();
    this.totalMs = opts.restored?.totalMs ?? 0;
    this.effectiveMs = opts.restored?.effectiveMs ?? 0;
    this.pageCount = opts.restored?.readPageCount ?? 0;
    this.lastTickAt = this.now();
    this.lastActivityAt = this.lastTickAt;
  }

  get modeName(): ReadSessionMode {
    return this.mode;
  }

  /** 累计到 `now`（默认当前时刻） */
  tick(now = this.now()): void {
    if (this.finished) return;
    if (!this.visible) {
      this.lastTickAt = now;
      return;
    }
    const raw = now - this.lastTickAt;
    if (raw <= 0) {
      this.lastTickAt = now;
      return;
    }
    // D-6 单窗口上限：一次最多补记 120s（后台节流回来时不能把空档全算上）
    const delta = Math.min(raw, MAX_STEP_MS);
    this.totalMs += delta;
    if (this.modeActive) {
      if (this.mode === 'visual') {
        // 只在「最近一次活动 + 120s」之内记有效：既不会把挂机算满，也不要求必须翻页
        const effectiveEnd = Math.min(now, this.lastActivityAt + IDLE_TIMEOUT_MS);
        const creditedEnd = Math.min(effectiveEnd, this.lastTickAt + delta);
        if (creditedEnd > this.lastTickAt) this.effectiveMs += creditedEnd - this.lastTickAt;
      } else {
        this.effectiveMs += delta;
      }
    }
    this.lastTickAt = now;
  }

  /** 用户活动（翻页/滚动/切章/点击/键盘）——只在 visual 下影响有效判定 */
  markActivity(now = this.now()): void {
    this.lastActivityAt = now;
  }

  /** 页面可见性变化：隐藏前会先把已发生的时长结清 */
  setVisible(visible: boolean, now = this.now()): void {
    if (visible) {
      this.visible = true;
      this.lastTickAt = now;
      this.lastActivityAt = Math.max(this.lastActivityAt, now);
      return;
    }
    this.tick(now);
    this.visible = false;
  }

  /** listen/auto 的「正在播放 / 自动滚动进行中」开关；visual 恒为 true */
  setModeActive(active: boolean, now = this.now()): void {
    const was = this.modeActive;
    this.modeActive = active;
    if (was && !active) this.tick(now);
  }

  /** 分页模式下翻过一页（滚动模式不调用） */
  addPage(): void {
    this.pageCount += 1;
  }

  /** 切章：**不结束会话**，只更新断点信息 */
  setChapter(index: number, title: string, progress: number): void {
    this.chapterIndex = index;
    this.chapterTitle = title;
    this.endProgress = progress;
    this.markActivity();
  }

  /** 当前会话的快照（用于检查点；不会把会话标记为结束） */
  snapshot(now = this.now()): ReadSession {
    this.tick(now);
    return {
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      bookUrl: this.meta.bookUrl,
      bookName: this.meta.bookName,
      bookAuthor: this.meta.bookAuthor,
      chapterIndex: this.chapterIndex,
      chapterTitle: this.chapterTitle,
      startAt: this.startedAt,
      endAt: now,
      totalMs: Math.round(this.totalMs),
      effectiveMs: Math.round(this.effectiveMs),
      readWords: 0,
      readPageCount: this.pageCount,
      mode: this.mode,
      startProgress: this.meta.startProgress,
      endProgress: this.endProgress,
      tzOffsetMin: -new Date(now).getTimezoneOffset(),
      createdAt: this.startedAt,
    };
  }

  /** 结束会话；总时长为 0 时不落库（打开即关/切走不算阅读） */
  finish(now = this.now()): ReadSession | null {
    if (this.finished) return null;
    this.tick(now);
    this.finished = true;
    if (this.totalMs < 1000) return null;
    return this.snapshot(now);
  }
}

/* ------------------------------------------------------------------ *
 * 检查点 / 离线队列（localStorage）
 * ------------------------------------------------------------------ */

export interface SessionCheckpoint {
  v: 1;
  draft: ReadSession;
}

export function saveCheckpoint(draft: ReadSession, s?: SessionStorage): void {
  const st = storageOrNull(s);
  if (!st) return;
  try {
    st.setItem(SESSION_CHECKPOINT_KEY, JSON.stringify({ v: 1, draft }));
  } catch {
    /* 配额满/隐私模式 → 放弃检查点（不影响正常计时） */
  }
}

export function loadCheckpoint(s?: SessionStorage): ReadSession | null {
  const st = storageOrNull(s);
  if (!st) return null;
  try {
    const raw = st.getItem(SESSION_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionCheckpoint> | null;
    const d = parsed?.v === 1 ? parsed.draft : null;
    if (!d || typeof d !== 'object') return null;
    if (typeof d.sessionId !== 'string' || typeof d.bookUrl !== 'string') return null;
    if (!Number.isFinite(d.startAt) || !Number.isFinite(d.endAt)) return null;
    return d;
  } catch {
    return null;
  }
}

export function clearCheckpoint(s?: SessionStorage): void {
  const st = storageOrNull(s);
  if (!st) return;
  try {
    st.removeItem(SESSION_CHECKPOINT_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 取检查点并判断能否续接。
 *
 * - `resumable`：同一本书 + 同一模式 + 距今 ≤ 10 分钟 ⇒ 用同 `sessionId` 继续计时；
 * - 否则 `stale`：调用方应把它当一条已结束会话补传（避免崩溃那一段永久丢失）。
 */
export function takeCheckpoint(
  bookUrl: string,
  mode: ReadSessionMode,
  now = Date.now(),
  s?: SessionStorage,
): { draft: ReadSession; resumable: boolean } | null {
  const draft = loadCheckpoint(s);
  if (!draft) return null;
  if (draft.bookUrl !== bookUrl || draft.mode !== mode) {
    clearCheckpoint(s);
    return { draft, resumable: false };
  }
  if (now - draft.endAt > CHECKPOINT_TTL_MS) {
    clearCheckpoint(s);
    return { draft, resumable: false };
  }
  return { draft, resumable: true };
}

function readQueue(s?: SessionStorage): ReadSession[] {
  const st = storageOrNull(s);
  if (!st) return [];
  try {
    const raw = st.getItem(SESSION_QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is ReadSession => {
      const d = x as Partial<ReadSession> | null;
      return !!d && typeof d.sessionId === 'string' && typeof d.bookUrl === 'string';
    });
  } catch {
    return [];
  }
}

function writeQueue(list: ReadSession[], s?: SessionStorage): void {
  const st = storageOrNull(s);
  if (!st) return;
  try {
    st.setItem(SESSION_QUEUE_KEY, JSON.stringify(list.slice(-SESSION_QUEUE_LIMIT)));
  } catch {
    /* 忽略 */
  }
}

/** 把会话放进离线队列（服务端不可达/请求失败时） */
export function enqueueSession(draft: ReadSession, s?: SessionStorage): void {
  const list = readQueue(s);
  if (list.some((x) => x.sessionId === draft.sessionId)) return;
  list.push(draft);
  writeQueue(list, s);
}

/**
 * 上报一条已结束会话；失败进队列，等下次进阅读页/下次成功时补传。
 *
 * 刻意**不 await 阻塞阅读页**：调用方应 `void reportSession(...)`。
 */
export async function reportSession(draft: ReadSession, s?: SessionStorage): Promise<void> {
  try {
    await appendReadSessions([draft]);
  } catch {
    enqueueSession(draft, s);
  }
}

/** 补传离线队列（阅读页挂载/网络恢复时调用） */
export async function flushSessionQueue(s?: SessionStorage): Promise<void> {
  const list = readQueue(s);
  if (list.length === 0) return;
  try {
    await appendReadSessions(list);
    writeQueue([], s);
  } catch {
    /* 还不可达：保留队列，下次再试 */
  }
}
