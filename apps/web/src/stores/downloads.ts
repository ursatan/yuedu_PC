/**
 * **整本下载中心**（`#207`）—— pinia 壳：把 `utils/download-manager.ts` 的纯调度器
 * 接到**真环境**（引擎取数 + IndexedDB 缓存 + 任务落盘）上。
 *
 * ## 边界
 *  · 本文件**只做接线与持久化**，调度语义（队列 / 暂停续跑 / 重试 3 次 / 并发）
 *    全在 `utils/download-manager.ts`，且**逐条对齐上游 `CacheBook.kt`**（见那里的对照表）。
 *  · **不重复实现取数与缓存**：取数走 `utils/book-fetch.ts`（与阅读器同一份），
 *    缓存读写走 `utils/chapter-cache.ts`（与预缓存窗口同一份）。
 *  · **本地书不接受下载**（正文本就在本机）—— 对齐上游 `CacheBook.start()` 的 `if (!book.isLocal)`。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { runAction } from '../api';
import { fetchBookContent, isLocalBookSource } from '../utils/book-fetch';
import {
  chapterKey, getBookMeta, hasCachedChapter, listDownloadTasks, putCachedChapter, putDownloadTasks,
} from '../utils/chapter-cache';
import {
  createDownloadManager, DEFAULT_MAX_BOOKS,
  type DownloadSeed, type DownloadState, type DownloadTask,
} from '../utils/download-manager';
import type { UnifiedChapter } from '@yuedu/core/contract';

/** 并发偏好（同时下载几本）——**不是**契约实体，落 localStorage（见 project-status 第 4 条） */
const MAX_BOOKS_KEY = 'yuedu-download-max-books';
const clampMaxBooks = (n: number): number =>
  Number.isFinite(n) ? Math.max(1, Math.min(4, Math.floor(n))) : DEFAULT_MAX_BOOKS;

function readMaxBooks(): number {
  try {
    return clampMaxBooks(Number(localStorage.getItem(MAX_BOOKS_KEY) ?? DEFAULT_MAX_BOOKS));
  } catch {
    return DEFAULT_MAX_BOOKS; // 隐私模式：`localStorage` 可能直接抛
  }
}

/** 引擎 `detail` 响应里我们关心的部分（其余字段透传回写用） */
interface DetailLike {
  chapters?: UnifiedChapter[];
}

export const useDownloadsStore = defineStore('downloads', () => {
  const tasks = ref<DownloadTask[]>([]);
  const maxBooks = ref<number>(readMaxBooks());

  const manager = createDownloadManager({
    /**
     * 取目录：**优先本地化的目录**（用户 5-2/5-4：书架里的书打开不请求上游）。
     * 本地没有才问引擎 —— 与 `stores/reader.ts` 的 `loadDetail` 同一口径，
     * 这样「下载用的目录」和「阅读看到的目录」必然是同一份。
     *
     * ⚠️ 这里**不回写** `putBookMeta`：下载是后台行为，不该顺手改「详情本地化」这份状态
     * （那会让书架的「本地数据」角标在没打开过书的情况下亮起来）。
     */
    async loadChapters(key: string, src: string, payload: unknown): Promise<UnifiedChapter[]> {
      const local = await getBookMeta<DetailLike>(key);
      const cached = local?.detail?.chapters;
      if (cached?.length) return cached;
      const d = (await runAction(src, 'detail', { id: JSON.stringify(payload) })) as DetailLike | null;
      return d?.chapters ?? [];
    },

    /**
     * 抓一章并写缓存。
     *
     * ★ 写进去的必须是**原文**：净化规则只在展示时应用，缓存里存净化后的正文会变成
     * 「关掉规则后缓存里仍是净化过的」（见 `stores/replaceRules.ts` 文件头与 `#144`）。
     */
    async downloadChapter(
      src: string,
      payload: unknown,
      ch: UnifiedChapter,
      opts: { force?: boolean; localBookUrl?: string },
    ): Promise<{ skipped: boolean }> {
      const ck = chapterKey(src, ch.payload);
      if (!opts.force && (await hasCachedChapter(ck))) return { skipped: true };
      const c = await fetchBookContent(src, payload, ch, opts.localBookUrl ? { localBookUrl: opts.localBookUrl } : {});
      await putCachedChapter(src, ch.payload, {
        ...(c.title ? { title: c.title } : {}),
        paragraphs: c.paragraphs ?? [],
        ...(c.subContent ? { subContent: c.subContent } : {}),
        ...(c.imageStyle ? { imageStyle: c.imageStyle } : {}),
        ...(c.imageDecode !== undefined ? { imageDecode: c.imageDecode } : {}),
        ...(c.media ? { media: c.media } : {}),
      });
      return { skipped: false };
    },

    onChange: (list) => { tasks.value = list; },
    persist: (list) => { void putDownloadTasks(list as unknown as Array<Record<string, unknown>>); },
  });

  function sync(): void {
    tasks.value = manager.list();
  }

  /** 从 IndexedDB 恢复任务（进行中的会被落成「已暂停」，**不自动续跑**） */
  async function hydrate(): Promise<void> {
    const saved = (await listDownloadTasks()) as unknown as DownloadTask[];
    if (saved.length) manager.restore(saved);
    sync();
  }

  /**
   * 建/扩展任务。
   * @returns 任务快照；`null` = 这本书**不能下载**（本地书 / 没有源）。
   */
  async function enqueue(seed: DownloadSeed): Promise<DownloadTask | null> {
    if (isLocalBookSource(seed.sourceId)) return null;
    if (!seed.key || !seed.sourceId) return null;
    const t = await manager.enqueue(seed);
    sync();
    return t;
  }

  function pause(key: string): void { manager.pause(key); sync(); }
  function resume(key: string): void { manager.resume(key); sync(); }
  function cancel(key: string): void { manager.cancel(key); sync(); }
  function retryFailed(key: string): void { manager.retryFailed(key); sync(); }
  function remove(key: string): void { manager.remove(key); sync(); }
  function clearFinished(): void { manager.clearFinished(); sync(); }
  function pauseAll(): void { manager.pauseAll(); sync(); }
  function resumeAll(): void { manager.resumeAll(); sync(); }

  function setMaxBooks(n: number): void {
    maxBooks.value = clampMaxBooks(n);
    try { localStorage.setItem(MAX_BOOKS_KEY, String(maxBooks.value)); } catch { /* 隐私模式忽略 */ }
    manager.setMaxBooks(maxBooks.value);
  }

  /** 「进度 x/y」的百分比（0~100）；`total` 为 0 时给 0（避免除零出 NaN） */
  function percentOf(t: DownloadTask): number {
    if (!t.total) return 0;
    const n = t.done + t.failed + t.skipped;
    return Math.min(100, Math.round((n / t.total) * 100));
  }

  const summary = computed(() => manager.summary());
  const pausedAll = computed(() => manager.pausedAll);
  /** 有任务正在跑/排队（UI 用它决定「全部暂停」还是「全部继续」） */
  const hasActive = computed(() => tasks.value.some((t) => t.state === 'running' || t.state === 'queued'));
  /** 已完成/已取消/失败的记录（「清理已完成」按钮的判据） */
  const finishedCount = computed(
    () => tasks.value.filter((t) => t.state === 'done' || t.state === 'error' || t.state === 'canceled').length,
  );
  /** 某本书当前的任务（阅读器的「⬇ 缓存」进度 chip 用它） */
  function jobOf(key: string): DownloadTask | undefined {
    return tasks.value.find((t) => t.key === key);
  }
  /** 这本书能不能下载（本地书：正文本就在本机 ⇒ 不需要） */
  function canDownload(sourceId: string): boolean {
    return !!sourceId && !isLocalBookSource(sourceId);
  }

  return {
    tasks, summary, maxBooks, pausedAll, hasActive, finishedCount,
    hydrate, enqueue, pause, resume, cancel, retryFailed, remove, clearFinished,
    pauseAll, resumeAll, setMaxBooks, percentOf, jobOf, canDownload, sync,
    // 状态文案集中在这里（视图与阅读器共用，避免两处各写一套）
    stateLabel: (s: DownloadState): string =>
      ({
        queued: '排队中', running: '下载中', paused: '已暂停',
        done: '已完成', error: '有失败', canceled: '已取消',
      })[s] ?? s,
  };
});
