/**
 * **音频缓存**的前端接线（服务端实现见 `apps/server/src/audio-cache.ts`）。
 *
 * 口径（用户拍板）：
 *  · 播放即后台整章落盘（策略 A：首播不阻塞，下次本地秒开、可离线）；
 *  · 云朵按 `chapterUrl` 查**真实文件**，不再用「正文库里带 media.url」近似；
 *  · P1 不缓存 m3u8：不落假缓存，只提示「流式源不支持离线」。
 *
 * 所有接口都是同源相对地址（音频不走图片代理的另一个 origin）。
 */

export interface AudioCacheChapterRef {
  chapterUrl?: string;
  title?: string;
}

export interface AudioCacheStatus {
  /** 已缓存（按 `chapterUrl`，缺失时回落 `title`） */
  cached: string[];
  /** 流式源（m3u8）：P1 不支持离线 */
  unsupported: string[];
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
  unsupported: number;
  /** 按模式拆分：manual 永不自动淘汰 */
  manualItems: number;
  manualBytes: number;
  streamItems: number;
  streamBytes: number;
  /** 已超配额且只剩 manual（淘汰已停手） */
  overQuota: boolean;
  bookList: AudioCacheBookStat[];
}

export interface AudioCachePruneResult {
  tmpFiles: number;
  emptyDirs: number;
  emptyBooks: number;
  bytes: number;
}

/** 无主缓存（书已不在书架）：清理时**含手动下载**，需用户确认 */
export interface AudioOrphan {
  bookKey: string;
  bookUrl: string;
  title: string;
  items: number;
  bytes: number;
  manualItems: number;
  manualBytes: number;
}

export interface AudioOrphanTotals {
  books: number;
  items: number;
  bytes: number;
  manualItems: number;
  manualBytes: number;
}

export interface AudioPurgeResult {
  cleared: { books: number; items: number; bytes: number; manualItems: number; manualBytes: number };
  skipped: number;
}

/** 本地缓存直出地址（未命中返回 404，调用方回落到普通 `/api/proxy` 流式播放） */
export function audioCacheUrl(opts: {
  bookUrl: string;
  chapterUrl: string;
  title?: string;
}): string {
  const p = new URLSearchParams({ bookUrl: opts.bookUrl });
  if (opts.chapterUrl) p.set('chapterUrl', opts.chapterUrl);
  if (opts.title) p.set('title', opts.title);
  return `/api/audio?${p.toString()}`;
}

/** 批量查缓存状态（目录云朵用；一次目录扫描，不逐章打接口） */
export async function fetchAudioCacheStatus(
  bookUrl: string,
  chapters: AudioCacheChapterRef[],
): Promise<AudioCacheStatus> {
  if (!bookUrl || !chapters.length) return { cached: [], unsupported: [] };
  try {
    const r = await fetch('/api/audio/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookUrl, chapters }),
      // 打开书时要等它（毫秒级本地读）；给个上限，接口异常不拖住首播
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return { cached: [], unsupported: [] };
    const data = (await r.json()) as Partial<AudioCacheStatus>;
    return {
      cached: Array.isArray(data.cached) ? data.cached.filter((x): x is string => typeof x === 'string') : [],
      unsupported: Array.isArray(data.unsupported)
        ? data.unsupported.filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch {
    return { cached: [], unsupported: [] };
  }
}

/**
 * 播放时触发后台整章落盘（**不 await**：首播不等下载）。
 * 服务端按 `bookUrl + chapterUrl` 去重，重复调用不会重复下载。
 */
export function prefetchAudioChapter(opts: {
  sid: string;
  bookUrl: string;
  bookTitle?: string;
  chapterUrl: string;
  chapterTitle?: string;
  payload?: unknown;
  mode?: 'stream' | 'manual';
}): void {
  if (!opts.sid || !opts.bookUrl || !opts.chapterUrl) return;
  try {
    void fetch('/api/audio/prefetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sid: opts.sid,
        bookUrl: opts.bookUrl,
        ...(opts.bookTitle ? { bookTitle: opts.bookTitle } : {}),
        chapterUrl: opts.chapterUrl,
        ...(opts.chapterTitle ? { chapterTitle: opts.chapterTitle } : {}),
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
        mode: opts.mode ?? 'stream',
      }),
    }).catch(() => undefined);
  } catch {
    /* 网络异常不影响播放（缓存只是加速/离线，不是播放前提） */
  }
}

/** P1.5 离线任务状态（服务端内存任务，`/api/audio/jobs` 口径） */
export type AudioDownloadStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'unsupported';

export interface AudioDownloadJob {
  id: string;
  bookUrl: string;
  chapterUrl: string;
  title: string;
  mode: 'stream' | 'manual';
  status: AudioDownloadStatus;
  bytes: number;
  totalBytes: number;
  /** 失败原因 / 取消说明（服务端给的是可读短句或错误码） */
  error?: string;
  /** 手动内容已超出配额（但不会被自动淘汰） */
  quotaOver?: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface StartAudioDownloadResult {
  ok: boolean;
  /** 已经在本机（含刚被自动预取下好的章）——调用方不该再排队 */
  cached?: boolean;
  /** 流式源不支持离线（m3u8） */
  unsupported?: 'hls';
  jobId?: string;
  mode?: string;
  bytes?: number;
  error?: string;
}

/**
 * 手动离线一章（`mode:'manual'`，**永不参与配额自动淘汰**）。
 *
 * 服务端先在主线程给出「已缓存 / 流式源」的立即结论，其余进入任务队列；
 * 返回 `jobId` 后由调用方轮询 `/api/audio/jobs` 显示进度。
 */
export async function startAudioDownload(opts: {
  sid: string;
  bookUrl: string;
  bookTitle?: string;
  chapterUrl: string;
  chapterTitle?: string;
  payload?: unknown;
}): Promise<StartAudioDownloadResult> {
  if (!opts.bookUrl || !opts.chapterUrl) return { ok: false, error: 'BAD_BODY' };
  try {
    const r = await fetch('/api/audio/prefetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sid: opts.sid,
        bookUrl: opts.bookUrl,
        ...(opts.bookTitle ? { bookTitle: opts.bookTitle } : {}),
        chapterUrl: opts.chapterUrl,
        ...(opts.chapterTitle ? { chapterTitle: opts.chapterTitle } : {}),
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
        mode: 'manual',
      }),
    });
    const data = (await r.json().catch(() => ({}))) as Partial<StartAudioDownloadResult>;
    if (!r.ok) return { ok: false, error: String((data as { error?: string }).error ?? `HTTP_${r.status}`) };
    return {
      ok: true,
      ...(data.cached ? { cached: true } : {}),
      ...(data.unsupported ? { unsupported: data.unsupported } : {}),
      ...(data.jobId ? { jobId: data.jobId } : {}),
      ...(data.mode ? { mode: data.mode } : {}),
      ...(typeof data.bytes === 'number' ? { bytes: data.bytes } : {}),
    };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

/** 拉某本书的离线任务（关闭界面后重新打开靠它恢复「还在下/已下完/失败原因」） */
export async function fetchAudioDownloads(bookUrl: string): Promise<AudioDownloadJob[]> {
  if (!bookUrl) return [];
  try {
    const r = await fetch(`/api/audio/jobs?bookUrl=${encodeURIComponent(bookUrl)}`, {
      // 轮询要轻：给个短上限，接口异常不拖住 UI
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { jobs?: AudioDownloadJob[] };
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

/** 取消排队中/下载中的一章（已完成/已失败的取消是空操作） */
export async function cancelAudioDownload(opts: {
  bookUrl: string;
  chapterUrl: string;
  chapterTitle?: string;
}): Promise<{ ok: boolean; cancelled: boolean; status?: string }> {
  try {
    const r = await fetch('/api/audio/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bookUrl: opts.bookUrl,
        chapterUrl: opts.chapterUrl,
        ...(opts.chapterTitle ? { chapterTitle: opts.chapterTitle } : {}),
      }),
    });
    if (!r.ok) return { ok: false, cancelled: false };
    return (await r.json()) as { ok: boolean; cancelled: boolean; status?: string };
  } catch {
    return { ok: false, cancelled: false };
  }
}

/** 通知阅读浮层「这本书的缓存文件变了」⇒ 云朵按真实文件重判（事件名见 ReaderOverlay 的监听） */
export function emitAudioCacheChanged(bookUrl: string): void {
  try {
    window.dispatchEvent(new CustomEvent('yuedu:audio-cache-changed', { detail: { bookUrl } }));
  } catch {
    /* 非浏览器环境（单测）忽略 */
  }
}

export async function fetchAudioCacheStats(): Promise<AudioCacheStats | null> {
  try {
    const r = await fetch('/api/audio/stats');
    if (!r.ok) return null;
    return (await r.json()) as AudioCacheStats;
  } catch {
    return null;
  }
}

/** 改配额（字节）；服务端按新上限立刻淘汰一次（只淘汰 stream） */
export async function setAudioCacheQuota(maxBytes: number): Promise<AudioCacheStats | null> {
  try {
    const r = await fetch('/api/audio/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxBytes }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { stats?: AudioCacheStats };
    return data.stats ?? null;
  } catch {
    return null;
  }
}

/**
 * 清空音频缓存：不带参数 = 全清；带 `bookUrl` = 按书清；
 * `bookKey` = 按目录精确清（索引重建后 `bookUrl` 为空的条目只能走这条）。
 */
export async function clearAudioCache(
  bookUrl?: string,
  bookKey?: string,
): Promise<{ items: number; bytes: number } | null> {
  try {
    const r = await fetch('/api/audio/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(bookUrl ? { bookUrl } : {}),
        ...(bookKey ? { bookKey } : {}),
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { cleared?: { items: number; bytes: number } };
    return data.cleared ?? null;
  } catch {
    return null;
  }
}

/**
 * P2：清理残留（中断的临时文件 / 空书目录 / 空索引项）。
 * 与 `clearAudioCache` 不同：**不会删除任何已记账的音频文件**。
 */
export async function pruneAudioCache(): Promise<AudioCachePruneResult | null> {
  try {
    const r = await fetch('/api/audio/prune', { method: 'POST' });
    if (!r.ok) return null;
    const data = (await r.json()) as { pruned?: AudioCachePruneResult };
    return data.pruned ?? null;
  } catch {
    return null;
  }
}

/** 无主缓存预览（只读）：返回待删清单与合计，由 UI 展示后让用户确认 */
export async function fetchAudioOrphans(): Promise<{
  orphans: AudioOrphan[];
  totals: AudioOrphanTotals;
  /** 索引丢失、无法归属的书：不进删除清单，只做展示 */
  unattributed: { books: number; items: number; bytes: number };
} | null> {
  try {
    const r = await fetch('/api/audio/orphans', { method: 'POST' });
    if (!r.ok) return null;
    return (await r.json()) as {
      orphans: AudioOrphan[];
      totals: AudioOrphanTotals;
      unattributed: { books: number; items: number; bytes: number };
    };
  } catch {
    return null;
  }
}

/** 删除无主缓存（**含手动下载**）；服务端会二次校验，已回到书架的书自动跳过 */
export async function purgeAudioOrphans(bookKeys: string[]): Promise<AudioPurgeResult | null> {
  if (!bookKeys.length) return null;
  try {
    const r = await fetch('/api/audio/purge-orphans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookKeys }),
    });
    if (!r.ok) return null;
    return (await r.json()) as AudioPurgeResult;
  } catch {
    return null;
  }
}
