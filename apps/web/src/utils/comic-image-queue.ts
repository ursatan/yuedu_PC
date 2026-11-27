/**
 * 漫画图片**客户端加载队列**（`#834`）。
 *
 * ## 为什么要单独一条队列（不改服务端 per-host）
 * 用户实机：漫画图经 `/api/proxy` 多张要 8~10s 才超时。服务端图片链路是
 * `packages/core/src/net/index.ts:197` 的 `maxPerHost=2` + 图片头 10s / 体 10s
 * ⇒ 同源几十张图会被排成几十批，单张慢就整批等；浏览器同源还有 6 条连接上限，
 * 画面里几十个 `<img>` 一起发只会把连接和队列都堵死。
 *
 * 本模块只做**客户端闸门**：在飞 ≤ `maxInflight`（默认 3）、失败按退避重试、
 * 超时主动放弃。全局 `maxPerHost` **不动**（那是正文/封面共享的服务端配额，见
 * `docs/ref/2026-11-07-reader-pagination-scroll-comic-research.md` Q4）。
 *
 * ## 为什么用 `new Image()` 预取、而不是直接给 DOM `<img>` 设 src
 * ① **并发可控**：队列只让 ≤3 张在飞，DOM 里其余图片仍是占位；
 * ② **先拿到宽高**：预取完成即知 `naturalWidth/naturalHeight`，占位按真实宽高比
 *    撑开 ⇒ 图片入画时不改变版面（长图不裁切、不跳动）；
 * ③ **不重复下载**：`/api/proxy` 图片响应带 `cache-control: public, max-age=3600`
 *    （`apps/server/src/index.ts:6985`），预取成功后 DOM `<img>` 命中缓存。
 *
 * ## 与 DOM 的关系
 * 本模块不知道 DOM：只负责「按 key 取一组候选地址、逐个尝试、回报状态」。组件用
 * `onUpdate` 把状态写回响应式表；候选地址由组件构造（代理 → 直连 → 带 `retry=1` 的代理）。
 */

/** 单张图的加载状态（`idle` = 还没进预取窗口） */
export type ComicImgStatus = 'idle' | 'queued' | 'loading' | 'ok' | 'err';

/** 图片原始像素尺寸（用于占位宽高比） */
export interface ComicImgDim {
  w: number;
  h: number;
}

/** 队列状态变更（组件据此更新模板） */
export interface ComicImgUpdate {
  key: string;
  status: ComicImgStatus;
  /** 已经尝试到第几个候选地址（0 起；仅用于诊断/探针） */
  attempt: number;
  /** `ok` 时给出最终成功的地址；其余状态为 undefined */
  url?: string;
  /** `ok` 时给出真实像素尺寸 */
  dim?: ComicImgDim;
}

/** 一次底层加载的句柄（可 abort，用于换章/关面板时取消在飞请求） */
export interface ComicLoadHandle {
  promise: Promise<ComicImgDim>;
  abort: () => void;
}

/** 可注入的底层加载器（测试注入假实现；生产用 `defaultComicImageLoad`） */
export type ComicImageLoad = (url: string, timeoutMs: number) => ComicLoadHandle;

export interface ComicImageQueueOptions {
  /** 同时最多几张在飞（默认 3 —— 服务端 per-host 2 之外留 1 个余量给切换） */
  maxInflight?: number;
  /** 每次失败后到下一发之间的延迟（默认 600ms / 1800ms = 指数退避两档） */
  retryDelaysMs?: number[];
  /** 单发超时（默认 12s：服务端图片头/体各 10s ⇒ 留 2s 余量） */
  timeoutMs?: number;
  load?: ComicImageLoad;
  onUpdate?: (u: ComicImgUpdate) => void;
}

/** 默认并发上限 */
export const COMIC_IMG_MAX_INFLIGHT = 3;
/** 默认退避（第一次失败等 600ms，第二次等 1800ms） */
export const COMIC_IMG_RETRY_DELAYS_MS = [600, 1800];
/** 默认单发超时（> 服务端图片 10s 预算） */
export const COMIC_IMG_TIMEOUT_MS = 12_000;

/**
 * 默认加载器：`new Image()` 预取，只取尺寸、不保留元素。
 *
 * ⚠️ **必须带超时**：`/api/proxy` 服务端虽然会在 10s 放弃，但浏览器本身可能把
 * 连接挂更久；没有客户端超时，一张坏图会长期占住一个并发槽（其余图全部排队）。
 */
export function defaultComicImageLoad(url: string, timeoutMs: number): ComicLoadHandle {
  const im = new Image();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortFn: () => void = () => {};
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    im.onload = null;
    im.onerror = null;
  };
  const promise = new Promise<ComicImgDim>((resolve, reject) => {
    const fail = (why: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try { im.removeAttribute('src'); } catch { /* 某些环境不支持，忽略 */ }
      reject(new Error(why));
    };
    abortFn = () => fail('abort');
    im.onload = () => {
      if (settled) return;
      const w = im.naturalWidth;
      const h = im.naturalHeight;
      if (!w || !h) { fail('empty'); return; }
      settled = true;
      cleanup();
      resolve({ w, h });
    };
    im.onerror = () => fail('error');
    timer = setTimeout(() => fail('timeout'), timeoutMs);
    im.decoding = 'async';
    im.src = url;
  });
  return { promise, abort: () => abortFn() };
}

interface QueueJob {
  urls: string[];
  attempt: number;
}

export class ComicImageQueue {
  private readonly maxInflight: number;

  private readonly retryDelaysMs: number[];

  private readonly timeoutMs: number;

  private readonly load: ComicImageLoad;

  private readonly onUpdate?: (u: ComicImgUpdate) => void;

  /** 待启动的 key（FIFO）；重试到点后也会回到队尾 */
  private queue: string[] = [];

  /** key → 本次加载的候选地址与进度 */
  private jobs = new Map<string, QueueJob>();

  private statuses = new Map<string, ComicImgStatus>();

  private dims = new Map<string, ComicImgDim>();

  /** key → 真正成功的地址（DOM `<img src>` 用它） */
  private resolved = new Map<string, string>();

  private inflight = new Set<string>();

  private aborts = new Map<string, () => void>();

  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: ComicImageQueueOptions = {}) {
    this.maxInflight = Math.max(1, opts.maxInflight ?? COMIC_IMG_MAX_INFLIGHT);
    this.retryDelaysMs = opts.retryDelaysMs?.length ? opts.retryDelaysMs : [...COMIC_IMG_RETRY_DELAYS_MS];
    this.timeoutMs = opts.timeoutMs ?? COMIC_IMG_TIMEOUT_MS;
    this.load = opts.load ?? defaultComicImageLoad;
    this.onUpdate = opts.onUpdate;
  }

  statusOf(key: string): ComicImgStatus {
    return this.statuses.get(key) ?? 'idle';
  }

  dimOf(key: string): ComicImgDim | undefined {
    return this.dims.get(key);
  }

  urlOf(key: string): string | undefined {
    return this.resolved.get(key);
  }

  /** 在飞张数（探针/测试用） */
  inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * 请求加载一张图。
   * · 已成功 / 在飞 / 排队中 ⇒ **不重复请求**（快速来回滚动不会重复打同一张）；
   * · `err` ⇒ 允许再次请求（用户滚动回来看见时自动再试一次，等价于「重试」）。
   */
  request(key: string, urls: string[]): void {
    const st = this.statusOf(key);
    if (st === 'ok' || st === 'loading' || st === 'queued') return;
    const list = urls.filter((u) => typeof u === 'string' && u.length > 0);
    if (!list.length) { this.setStatus(key, 'err'); return; }
    this.jobs.set(key, { urls: list, attempt: 0 });
    this.queue.push(key);
    this.setStatus(key, 'queued');
    this.pump();
  }

  /** 手动重试（清掉旧状态，从第一个候选重新开始） */
  retry(key: string, urls: string[]): void {
    this.forget(key);
    this.request(key, urls);
  }

  /** 把一张已经 `ok` 的图标记为失败（DOM `<img>` 命中缓存却仍报错时用） */
  markError(key: string): void {
    this.forget(key);
    this.setStatus(key, 'err');
  }

  /** 取消全部在飞/排队/待重试（换章、关面板）：不影响已经加载完的图 */
  cancelAll(): void {
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const abort of this.aborts.values()) {
      try { abort(); } catch { /* 已结束，忽略 */ }
    }
    this.aborts.clear();
    this.inflight.clear();
    this.queue = [];
    this.jobs.clear();
  }

  /** 换章：取消在飞并清空全部状态 */
  reset(): void {
    this.cancelAll();
    this.statuses.clear();
    this.dims.clear();
    this.resolved.clear();
  }

  private forget(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.retryTimers.delete(key);
    this.queue = this.queue.filter((k) => k !== key);
    const abort = this.aborts.get(key);
    if (abort) {
      try { abort(); } catch { /* 已结束，忽略 */ }
    }
    this.aborts.delete(key);
    this.inflight.delete(key);
    this.jobs.delete(key);
    this.statuses.delete(key);
    this.dims.delete(key);
    this.resolved.delete(key);
  }

  private setStatus(key: string, status: ComicImgStatus): void {
    this.statuses.set(key, status);
    this.emit(key);
  }

  private emit(key: string): void {
    if (!this.onUpdate) return;
    const status = this.statusOf(key);
    const job = this.jobs.get(key);
    this.onUpdate({
      key,
      status,
      attempt: job?.attempt ?? 0,
      ...(status === 'ok' ? { dim: this.dims.get(key), url: this.resolved.get(key) } : {}),
    });
  }

  private pump(): void {
    while (this.inflight.size < this.maxInflight && this.queue.length) {
      const key = this.queue.shift()!;
      const job = this.jobs.get(key);
      if (!job) continue;
      const url = job.urls[job.attempt];
      if (!url) { this.finishFailure(key, job); continue; }
      this.inflight.add(key);
      this.setStatus(key, 'loading');
      let handle: ComicLoadHandle;
      try {
        handle = this.load(url, this.timeoutMs);
      } catch {
        this.inflight.delete(key);
        this.scheduleRetry(key, job);
        continue;
      }
      this.aborts.set(key, handle.abort);
      handle.promise.then(
        (dim) => {
          // ★ 用 **job 对象引用**判过期：换章 `reset()` / 手动 `retry()` 会换掉/删掉 job，
          //   旧的 promise 回调必须整段丢弃（否则会把新队列的进度往后推一格）。
          if (this.jobs.get(key) !== job) return;
          this.inflight.delete(key);
          this.aborts.delete(key);
          this.dims.set(key, dim);
          this.resolved.set(key, url);
          this.jobs.delete(key);
          this.setStatus(key, 'ok');
          this.pump();
        },
        () => {
          if (this.jobs.get(key) !== job) return;
          this.inflight.delete(key);
          this.aborts.delete(key);
          this.scheduleRetry(key, job);
          this.pump();
        },
      );
    }
  }

  /** 还有下一发候选 ⇒ 退避后回队尾；否则终态 `err` */
  private scheduleRetry(key: string, job: QueueJob): void {
    job.attempt += 1;
    if (job.attempt >= job.urls.length) { this.finishFailure(key, job); return; }
    const delay = this.retryDelaysMs[Math.min(job.attempt - 1, this.retryDelaysMs.length - 1)] ?? 0;
    this.setStatus(key, 'queued');
    if (delay <= 0) {
      this.queue.push(key);
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (this.jobs.get(key) !== job) return;
      this.queue.push(key);
      this.pump();
    }, delay);
    this.retryTimers.set(key, timer);
  }

  private finishFailure(key: string, job: QueueJob): void {
    if (this.jobs.get(key) !== job) return;
    this.jobs.delete(key);
    this.queue = this.queue.filter((k) => k !== key);
    this.setStatus(key, 'err');
  }
}
