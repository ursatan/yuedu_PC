/**
 * **整本下载调度器**（`#207`）—— 纯逻辑，**不 import vue / 不碰 DOM / 不碰 IndexedDB**。
 *
 * ## 为什么做成「纯逻辑 + 依赖注入」
 *  · 可测：`apps/web/tests/downloads.test.ts` 直接注入假的取数/缓存实现，不开浏览器
 *    （本仓 web 包用 `tsx --test` 跑，没有 jsdom —— 见 `apps/web/package.json`）。
 *  · 可换：真环境的取数（`utils/book-fetch.ts` + `utils/chapter-cache.ts`）由
 *    `stores/downloads.ts` 注入，本文件不知道它们存在。
 *
 * ## 语义（**逐条对齐上游 `CacheBook.kt`** —— 用户要求「优先参考 legado，不重复造轮子」）
 * | 上游 | 这里 |
 * |---|---|
 * | `cacheBookMap: Map<bookUrl, CacheBookModel>` | `tasks: Map<key, Task>`（每本书一个任务） |
 * | `waitDownloadSet` / `onDownloadSet` | `pending[]` / `active`（正在跑的本数） |
 * | `startProcessJob` 的 `onEachParallel(AppConfig.threadCount)` | `maxBooks`（同时下载几本，默认 2） |
 * | 每本内 `Coroutine.async` 并发 | `CH_CONCURRENCY = 3`（沿用既有「⬇ 缓存」的并发，不打源站） |
 * | `workingState`（全局暂停开关） | `pausedAll` |
 * | `onPostError`：**重试 3 次**、失败后 `delay(1000)` 重新入队 | `MAX_RETRY = 3` / `RETRY_DELAY_MS = 1000` |
 * | `BookHelp.hasContent(book, chapter)` 已有正文则跳过（只补图片） | `hasCached(key)` 命中即跳过（省流量） |
 * | `chapter.isVolume` 直接剔除 | 同上（`isVolume` 行不进队列） |
 * | `downloadSummary`「正在下载/等待中/失败/成功」 | `summary()` |
 * | 前台 Service，进程被杀即丢 | ⚠️ **差异**：任务落 IndexedDB，刷新后恢复；但「运行中/排队中」恢复为 **已暂停** —— 不自动续跑，免得重启就对源站发起几百次请求 |
 */
import type { UnifiedChapter } from '@yuedu/core/contract';

export type DownloadState =
  /** 排队中（等待并发槽位） */
  | 'queued'
  /** 正在下载 */
  | 'running'
  /** 已暂停（可续跑：已下的章节保留，未下的留在队列里） */
  | 'paused'
  /** 全部成功 */
  | 'done'
  /** 跑完了但有失败章节 */
  | 'error'
  /** 用户取消（队列清空，已下的保留） */
  | 'canceled';

/** 任务的**可序列化**快照（落 IndexedDB 的就是它） */
export interface DownloadTask {
  /** 书键（`itemKey(sourceId, payload)`） */
  key: string;
  sourceId: string;
  payload: unknown;
  title: string;
  author?: string;
  cover?: string;
  /** 请求范围（**0 基**，含端点） */
  from: number;
  to: number;
  /** 范围内**非卷**章节总数 */
  total: number;
  /** 本次跑成功写入缓存的章数 */
  done: number;
  /** 重试 3 次后仍失败的章数 */
  failed: number;
  /** 已有缓存被跳过的章数（不重复下载，省流量） */
  skipped: number;
  state: DownloadState;
  /** 失败的章节下标（供「重试失败」用） */
  failedIdx: number[];
  /** 还没抓的章节下标（暂停/刷新后据此续跑） */
  pending: number[];
  createdAt: number;
  updatedAt: number;
  err?: string;
}

/** 建任务时的入参 */
export interface DownloadSeed {
  key: string;
  sourceId: string;
  payload: unknown;
  title: string;
  author?: string;
  cover?: string;
  /** 0 基、含端点；不传 = 整本 */
  from?: number;
  to?: number;
  /** `true` = 已缓存的章节也重抓一遍（默认跳过） */
  force?: boolean;
  /** 本地书的 `bookUrl`（已 `encodeItemKey`）—— 只有本地书需要，而本地书本就不该下载 */
  localBookUrl?: string;
}

export interface DownloadDeps {
  /** 取目录（调用方应先读本地化的目录，读不到再问引擎 —— 与阅读同一口径） */
  loadChapters(key: string, src: string, payload: unknown): Promise<UnifiedChapter[]>;
  /**
   * 取正文并**写缓存**（由调用方保证写的是原文，见 `stores/replaceRules.ts` 文件头）。
   *
   * 返回 `skipped: true` = 这一章**已经有缓存了，没发请求**（对齐上游 `BookHelp.hasContent`
   * 「已有正文就跳过」）⇒ 计入 `skipped` 而不是 `done`，这样进度条满格但「新下载 0 章」
   * 这件事是**看得见**的。
   */
  downloadChapter(
    src: string,
    payload: unknown,
    ch: UnifiedChapter,
    opts: { force?: boolean; localBookUrl?: string },
  ): Promise<{ skipped: boolean }>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** 状态变化时通知（UI 靠它刷新）。**已去抖**（500ms），不会每章都刷 */
  onChange?(tasks: DownloadTask[]): void;
  /** 落盘（同样是去抖后的整表写入） */
  persist?(tasks: DownloadTask[]): void;
}

/** 每本书内部的章节并发**上限**（沿用既有「⬇ 缓存」的 3；再高就成爬虫了） */
const CH_CONCURRENCY = 3;
/** 对齐上游 `onPostError` 的「重试3次」 */
const MAX_RETRY = 3;
/** 对齐上游「出现错误等待一秒后重新加入待下载列表」 */
const RETRY_DELAY_MS = 1000;
/** `D6` 限速退避起点：1s / 2s / 4s / 8s …（封顶 30s） */
const RATE_LIMIT_BASE_MS = 1000;
/** `D6` 退避/`Retry-After` 的单次等待上限 */
const RATE_LIMIT_MAX_MS = 30_000;
/** 状态通知 / 落盘的去抖窗口 */
const FLUSH_MS = 500;
/** 默认同时下载几本书（上游 `AppConfig.threadCount` 默认更大，但这里是浏览器 + 源站，别太猛） */
export const DEFAULT_MAX_BOOKS = 2;

interface InternalTask extends DownloadTask {
  chapters: UnifiedChapter[];
  /** 每章已尝试次数（≤ MAX_RETRY） */
  attempts: Record<number, number>;
  /**
   * **正在取数**的章节（还没落地，所以既不在 `pending` 也不在 `done`）。
   *
   * ⚠️ 必须有这个集合：合并范围时要判断「这一章是不是正在下载」，否则在途的章节会被
   * **再塞回队列一次** ⇒ 同一章下载两遍（`done` 超过 `total`，进度条爆表）。
   */
  inflight: Set<number>;
  force: boolean;
  localBookUrl?: string;
  /**
   * `D6` **自适应并发**：当前允许同时取数的章节数（1 ~ `CH_CONCURRENCY`）。
   * 收到 429 立刻降到 1；之后每成功一章回升 1，直到上限。
   */
  limit: number;
  /** `D6` 每章单独累计的 429 次数（**不占** `MAX_RETRY` 配额，也不计入 `failed`） */
  rateLimits: Record<number, number>;
  /** 等着并发槽位的 worker（`limit` 变化 / 暂停 / 取消时要唤醒它们重新判定） */
  waiters: Array<() => void>;
}

export interface DownloadSummary {
  running: number;
  waiting: number;
  failed: number;
  success: number;
}

/** 已完成/已取消/失败 —— 可从列表里清掉，但**不删缓存** */
const FINISHED: DownloadState[] = ['done', 'error', 'canceled'];

function snapshot(t: InternalTask): DownloadTask {
  return {
    key: t.key, sourceId: t.sourceId, payload: t.payload, title: t.title,
    ...(t.author ? { author: t.author } : {}),
    ...(t.cover ? { cover: t.cover } : {}),
    from: t.from, to: t.to, total: t.total,
    done: t.done, failed: t.failed, skipped: t.skipped, state: t.state,
    failedIdx: [...t.failedIdx],
    /**
     * ★ 对外的 `pending` = **队列 ∪ 在途**。
     *
     * 为什么必须并上在途的：在途章节已从队列 `shift` 出来、但**还没落地**。快照里若不含它们，
     * 刷新（标签页/进程消失）后这几章就**既不在队列也不在缓存** —— 不报错、不重试，静默少几章
     * （探针 E 段实测：10 章只落地 7 章）。对齐上游 `onCancel(index)` 的口径：在途的**回到待下载集合**。
     * 代价最多是这几章被重下一次（写缓存幂等，且已落地的会被 `hasCached` 跳过 ⇒ 计入 `skipped`）。
     */
    pending: [...new Set([...t.pending, ...t.inflight])],
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    ...(t.err ? { err: t.err } : {}),
  };
}

export function createDownloadManager(deps: DownloadDeps) {
  const tasks = new Map<string, InternalTask>();
  /** 正在跑 `runTask` 的书（占并发槽位） */
  const active = new Set<string>();
  let maxBooks = DEFAULT_MAX_BOOKS;
  let pausedAll = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const now = (): number => (deps.now ? deps.now() : Date.now());
  const sleep = (ms: number): Promise<void> =>
    deps.sleep ? deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));

  /** 等一个章节并发槽位（`limit` 变化、暂停、取消都会被 `wakeSlots` 唤醒重判） */
  function waitSlot(t: InternalTask): Promise<void> {
    return new Promise((resolve) => t.waiters.push(resolve));
  }
  /** 唤醒所有等槽位的 worker —— 它们会重新检查 `state` / `limit` */
  function wakeSlots(t: InternalTask): void {
    const ws = t.waiters;
    if (!ws.length) return;
    t.waiters = [];
    for (const w of ws) w();
  }

  /** 429 指数退避：1s / 2s / 4s / 8s …（封顶 30s） */
  function rateLimitBackoffMs(n: number): number {
    return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** Math.max(0, n - 1));
  }

  /**
   * `D6` 识别 429 / `Retry-After`。
   *
   * 引擎把源站异常统一包成 `Error(message)`，所以既看结构化字段（如果上游给）也看文案；
   * `Retry-After` 可以是秒数（数字/数字字符串）或 HTTP 日期。
   */
  function rateLimitInfo(e: unknown): { retryAfterMs?: number } | null {
    const err = e as {
      status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown;
      retryAfter?: unknown; retryAfterMs?: unknown;
      headers?: Record<string, unknown>;
    };
    const status = Number(err?.status ?? err?.statusCode ?? NaN);
    const msg = String(err?.message ?? '');
    const is429 =
      status === 429 ||
      (err?.code !== undefined && String(err.code).toUpperCase() === 'TOO_MANY_REQUESTS') ||
      /(?:^|[^\d])429(?:[^\d]|$)|too[\s_-]?many[\s_-]?requests|rate[\s_-]?limit(?:ed|ing)?/i.test(msg);
    if (!is429) return null;

    const explicitMs = Number(err?.retryAfterMs);
    if (Number.isFinite(explicitMs)) {
      return { retryAfterMs: Math.min(RATE_LIMIT_MAX_MS, Math.max(0, explicitMs)) };
    }
    const raw =
      err?.retryAfter ??
      err?.headers?.['retry-after'] ??
      err?.headers?.['Retry-After'];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return { retryAfterMs: Math.min(RATE_LIMIT_MAX_MS, Math.max(0, raw * 1000)) };
    }
    if (typeof raw === 'string' && raw.trim()) {
      const asNumber = Number(raw.trim());
      if (Number.isFinite(asNumber)) {
        return { retryAfterMs: Math.min(RATE_LIMIT_MAX_MS, Math.max(0, asNumber * 1000)) };
      }
      const at = Date.parse(raw);
      if (Number.isFinite(at)) {
        return { retryAfterMs: Math.min(RATE_LIMIT_MAX_MS, Math.max(0, at - Date.now())) };
      }
    }
    return {};
  }

  /** 去抖刷新：通知 UI + 落盘（每章都刷会让 IndexedDB 写入次数爆炸） */
  function flush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const all = list();
      deps.onChange?.(all);
      deps.persist?.(all);
    }, FLUSH_MS);
  }
  /** 立即刷一次（任务的**状态**变了必须立刻可见/落盘，否则暂停按钮像没反应） */
  function flushNow(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const all = list();
    deps.onChange?.(all);
    deps.persist?.(all);
  }

  function list(): DownloadTask[] {
    return Array.from(tasks.values()).map(snapshot);
  }

  function summary(): DownloadSummary {
    let running = 0, waiting = 0, failed = 0, success = 0;
    for (const t of tasks.values()) {
      if (t.state === 'running') running += 1;
      if (t.state === 'queued') waiting += 1;
      failed += t.failed;
      success += t.done;
    }
    return { running, waiting, failed, success };
  }

  /** 章节 worker：从本任务的队列里取下标，失败按上游口径重试（`D6`：429 走独立退避） */
  async function chapterWorker(t: InternalTask): Promise<void> {
    for (;;) {
      if (t.state !== 'running') return; // 被暂停 / 被取消 / 被新任务取代
      if (!t.pending.length) return;
      // `D6` 自适应并发：`limit` 被 429 降到 1 时，其余 worker 在这里等着
      while (t.inflight.size >= Math.max(1, t.limit)) {
        if (t.state !== 'running') return;
        await waitSlot(t);
        if (t.state !== 'running') return;
      }
      const idx = t.pending.shift();
      if (idx === undefined) return;
      const ch = t.chapters[idx];
      if (!ch) continue;
      t.inflight.add(idx);
      try {
        const r = await deps.downloadChapter(t.sourceId, t.payload, ch, {
          force: t.force,
          ...(t.localBookUrl ? { localBookUrl: t.localBookUrl } : {}),
        });
        if (r?.skipped) t.skipped += 1;
        else t.done += 1;
        // 成功 ⇒ 并发逐步回升（1 → 2 → 3）
        t.limit = Math.min(CH_CONCURRENCY, t.limit + 1);
        wakeSlots(t);
      } catch (e) {
        const rl = rateLimitInfo(e);
        if (rl) {
          /**
           * `D6` 限速：**不占** `MAX_RETRY` 配额（`attempts` 不动、不计 `failed`），
           * 单独累计 429 次数；并发立刻降到 1，退避后重新入队。
           */
          const n = (t.rateLimits[idx] ?? 0) + 1;
          t.rateLimits[idx] = n;
          t.limit = 1;
          wakeSlots(t); // 让其它 worker 重新判定（现在只能 1 个在途）
          t.err = String(e instanceof Error ? e.message : e);
          const delay = rl.retryAfterMs ?? rateLimitBackoffMs(n);
          await sleep(delay);
          // 暂停 → 章节回到队列；取消 → 队列保持清空（对齐 `cancel()` 语义）
          if (t.state === 'running' || t.state === 'paused') t.pending.push(idx);
          wakeSlots(t);
        } else {
          const n = (t.attempts[idx] ?? 0) + 1;
          t.attempts[idx] = n;
          if (n < MAX_RETRY) {
            t.pending.push(idx); // 放队尾，先跑别的
            t.err = String(e instanceof Error ? e.message : e);
            await sleep(RETRY_DELAY_MS);
          } else {
            t.failed += 1;
            t.failedIdx.push(idx);
            t.err = String(e instanceof Error ? e.message : e);
          }
        }
      } finally {
        t.inflight.delete(idx);
      }
      t.updatedAt = now();
      flush();
    }
  }

  /** `total` = 当前范围 `[from, to]` 内的**非卷**章节数（合并范围后必须重数，否则进度条会爆表） */
  function recountTotal(t: InternalTask): void {
    let n = 0;
    for (let i = Math.max(0, t.from); i <= Math.min(t.chapters.length - 1, t.to); i += 1) {
      if (!t.chapters[i]?.isVolume) n += 1;
    }
    t.total = n;
  }

  async function runTask(t: InternalTask): Promise<void> {
    t.state = 'running';
    t.limit = CH_CONCURRENCY; // 新一轮从满速开始（429 会在本轮内把它降下来）
    t.updatedAt = now();
    flushNow();
    try {
      // 刷新后恢复的任务没有目录（`chapters` 是空的）⇒ 先补拉一次，再接着跑
      if (!t.chapters.length) {
        t.chapters = await deps.loadChapters(t.key, t.sourceId, t.payload);
      }
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(CH_CONCURRENCY, t.pending.length || 1)) }, () => chapterWorker(t)),
      );
    } catch (e) {
      // `loadChapters` 失败（源挂了/目录取不到）⇒ 整本书标失败，别静默变「已完成」
      t.err = String(e instanceof Error ? e.message : e);
      t.state = 'error';
    } finally {
      active.delete(t.key);
      if (t.state === 'running') {
        if (t.pending.length) t.state = 'queued'; // workers 提前退出（并发数 > 队列长度等边界）
        else t.state = t.failed > 0 ? 'error' : 'done';
      }
      t.updatedAt = now();
      flushNow();
      pump(); // 让出槽位给下一本
    }
  }

  /** 调度：给排队中的任务分配并发槽位（对齐上游 `startProcessJob` 的循环） */
  function pump(): void {
    if (pausedAll) return;
    for (const [key, t] of tasks) {
      if (active.size >= maxBooks) return;
      if (active.has(key)) continue;
      if (t.state !== 'queued' || !t.pending.length) continue;
      active.add(key);
      void runTask(t);
    }
  }

  /**
   * 建/扩展一个下载任务。
   *
   * 同一本书**已在跑**时按上游 `addDownload` 的口径**合并范围**（把缺的下标补进队列），
   * 而不是「再来一个任务」—— 否则两拨 worker 会同时打同一本书。
   */
  async function enqueue(seed: DownloadSeed): Promise<DownloadTask> {
    const ts = now();
    const chapters = await deps.loadChapters(seed.key, seed.sourceId, seed.payload);
    const lo = Math.max(0, seed.from ?? 0);
    const hi = Math.min(Math.max(0, chapters.length - 1), seed.to ?? chapters.length - 1);
    const idxs: number[] = [];
    for (let i = lo; i <= hi; i += 1) {
      if (!chapters[i]?.isVolume) idxs.push(i); // 卷没有正文页
    }
    const existing = tasks.get(seed.key);
    if (existing && (existing.state === 'running' || existing.state === 'queued')) {
      for (const i of idxs) {
        if (existing.pending.includes(i) || existing.inflight.has(i)) continue; // 别把在途的再排一次
        existing.pending.push(i);
      }
      existing.from = Math.min(existing.from, lo);
      existing.to = Math.max(existing.to, hi);
      recountTotal(existing); // ★ 重数：否则「已下 + 在途」会超过 total
      existing.updatedAt = ts;
      if (seed.force) existing.force = true;
      pump();
      flushNow();
      return snapshot(existing);
    }
    const t: InternalTask = {
      key: seed.key, sourceId: seed.sourceId, payload: seed.payload, title: seed.title,
      ...(seed.author ? { author: seed.author } : {}),
      ...(seed.cover ? { cover: seed.cover } : {}),
      from: lo, to: hi, total: idxs.length,
      done: 0, failed: 0, skipped: 0, state: 'queued',
      failedIdx: [], pending: idxs,
      createdAt: ts, updatedAt: ts,
      chapters, attempts: {}, inflight: new Set<number>(), force: !!seed.force,
      limit: CH_CONCURRENCY, rateLimits: {}, waiters: [],
      ...(seed.localBookUrl ? { localBookUrl: seed.localBookUrl } : {}),
    };
    tasks.set(seed.key, t);
    pump();
    flushNow();
    return snapshot(t);
  }

  function pause(key: string): void {
    const t = tasks.get(key);
    if (!t || (t.state !== 'running' && t.state !== 'queued')) return;
    t.state = 'paused';
    wakeSlots(t); // 等槽位的 worker 要能立刻看到「已暂停」并退出
    t.updatedAt = now();
    flushNow();
  }

  function resume(key: string): void {
    const t = tasks.get(key);
    if (!t || t.state !== 'paused') return;
    t.state = 'queued';
    t.updatedAt = now();
    flushNow();
    pump();
  }

  function cancel(key: string): void {
    const t = tasks.get(key);
    if (!t) return;
    t.pending = [];
    t.state = 'canceled';
    wakeSlots(t); // 等槽位的 worker 退出；在途的 429 退避醒来后也不会再入队
    t.updatedAt = now();
    flushNow();
  }

  /** 重试失败章节（失败计数清零，失败下标回到队尾） */
  function retryFailed(key: string): void {
    const t = tasks.get(key);
    if (!t || !t.failedIdx.length) return;
    for (const i of t.failedIdx) {
      t.attempts[i] = 0;
      t.pending.push(i);
    }
    t.failed -= t.failedIdx.length;
    t.failedIdx = [];
    t.state = 'queued';
    t.updatedAt = now();
    flushNow();
    pump();
  }

  /** 从列表移除（**不删缓存** —— 要删缓存走书架的「🧹 清理缓存」） */
  function remove(key: string): void {
    tasks.delete(key);
    flushNow();
  }

  /** 清掉已结束的任务记录（保留缓存） */
  function clearFinished(): number {
    let n = 0;
    for (const [key, t] of [...tasks]) {
      if (FINISHED.includes(t.state)) { tasks.delete(key); n += 1; }
    }
    if (n) flushNow();
    return n;
  }

  function pauseAll(): void {
    pausedAll = true;
    for (const t of tasks.values()) {
      if (t.state === 'running' || t.state === 'queued') {
        t.state = 'paused';
        wakeSlots(t);
      }
    }
    flushNow();
  }

  function resumeAll(): void {
    pausedAll = false;
    for (const t of tasks.values()) {
      if (t.state === 'paused' && t.pending.length) t.state = 'queued';
    }
    flushNow();
    pump();
  }

  /** 从 IndexedDB 恢复（`hydrate`）：进行中的一律落成「已暂停」，**不自动续跑** */
  function restore(saved: DownloadTask[]): void {
    for (const s of saved) {
      const state: DownloadState = s.state === 'running' || s.state === 'queued' ? 'paused' : s.state;
      tasks.set(s.key, {
        ...s, state, chapters: [], attempts: {}, inflight: new Set<number>(), force: false,
        limit: CH_CONCURRENCY, rateLimits: {}, waiters: [],
        ...(s.pending ? { pending: [...s.pending] } : { pending: [] }),
        ...(s.failedIdx ? { failedIdx: [...s.failedIdx] } : { failedIdx: [] }),
      });
    }
    flushNow();
  }

  return {
    list, summary, enqueue, pause, resume, cancel, retryFailed, remove, clearFinished,
    pauseAll, resumeAll, restore, pump,
    get maxBooks(): number { return maxBooks; },
    setMaxBooks(n: number): void {
      maxBooks = Math.max(1, Math.min(4, Math.floor(n) || DEFAULT_MAX_BOOKS));
      pump();
    },
    get pausedAll(): boolean { return pausedAll; },
    /** 仅供测试：把内部状态摊平（含 `chapters` 长度） */
    debug(): Array<{
      key: string; state: DownloadState; pending: number; done: number; failed: number; skipped: number;
      /** `D6` 当前自适应并发上限 */
      limit: number;
      /** `D6` 429 次数合计（每章单独累计） */
      rateLimited: number;
    }> {
      return Array.from(tasks.values()).map((t) => ({
        key: t.key, state: t.state, pending: t.pending.length,
        done: t.done, failed: t.failed, skipped: t.skipped,
        limit: t.limit,
        rateLimited: Object.values(t.rateLimits).reduce((a, b) => a + b, 0),
      }));
    },
  };
}

export type DownloadManager = ReturnType<typeof createDownloadManager>;
