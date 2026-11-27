/**
 * `#825` 分页状态机：**重建可中断、可节流、可取消**。
 *
 * 组件只做三件事：给我「一页的尺寸 + 排版变量 + 章文本」，我给你页码；
 * 翻页**不经过这里**（翻页只改组件里的 `curPage`，零测量）。
 *
 * 三条纪律：
 * 1. **签名缓存**：宽高 / 字号 / 行距 / 段距 / 字体族 / 章 id 没变 ⇒ 直接复用上一份页；
 * 2. **token 取消**：切模式、换章、再次重建都会 abort 在途重建，**旧结果绝不覆盖新章**；
 * 3. **让出主线程**：`measureChapterPages` 内部按页 `requestAnimationFrame` 分片。
 */
import { computed, ref, shallowRef } from 'vue';
import { measureChapterPages, pagedSignature, type MeasureInput, type PageChunk } from '../utils/paged-layout';

export function usePagedChapter() {
  /** 页码 → 该页的切片列表。用 `shallowRef`：页内部结构不做响应式追踪（翻页不该重算别的页） */
  const pages = shallowRef<PageChunk[][]>([]);
  /** 是否已有可用布局 */
  const ready = ref(false);
  /** 正在重建（用于显示「排版中…」而不是空白） */
  const measuring = ref(false);
  /** 最近一次重建耗时（ms）—— 探针取数用 */
  const lastMs = ref(0);
  /** 最近一次重建的页数 */
  const lastPageCount = ref(0);

  let token = 0;
  let signature = '';
  let ctrl: AbortController | null = null;

  const pageCount = computed(() => Math.max(1, pages.value.length));

  /** 取消在途重建（切模式 / 换章 / 卸载时调用） */
  function cancel(): void {
    token += 1;
    ctrl?.abort();
    ctrl = null;
    measuring.value = false;
  }

  /** 彻底清空（回到滚动模式、关闭阅读器） */
  function reset(): void {
    cancel();
    pages.value = [];
    ready.value = false;
    signature = '';
    lastMs.value = 0;
    lastPageCount.value = 0;
  }

  /**
   * 重建（或命中签名缓存直接返回）。
   * @returns `true` = 本次之后 `pages` 是**当前输入**的结果；`false` = 被取消 / 尺寸非法 / 失败
   */
  async function rebuild(input: MeasureInput, force = false): Promise<boolean> {
    const sig = pagedSignature(input);
    if (!force && sig === signature && pages.value.length > 0) return true;
    cancel();
    const my = token;
    const ac = new AbortController();
    ctrl = ac;
    measuring.value = true;
    try {
      const res = await measureChapterPages({ ...input, signal: ac.signal });
      if (my !== token || ac.signal.aborted) return false;
      if (!res) {
        measuring.value = false;
        return false;
      }
      signature = sig;
      pages.value = res.pages;
      lastMs.value = res.ms;
      lastPageCount.value = res.pages.length;
      ready.value = true;
      measuring.value = false;
      return true;
    } catch {
      if (my === token) measuring.value = false;
      return false;
    } finally {
      if (my === token) ctrl = null;
    }
  }

  /** 页码 → 切片（越界返回空数组，别让模板炸） */
  function chunksOf(pageNo: number): PageChunk[] {
    return pages.value[pageNo - 1] ?? [];
  }

  /**
   * 章内段落下标 → 页码（**该段开头所在页**）。
   *
   * ★ 必须优先命中 `start === 0` 的那一片：跨页段落在前一页末尾也有一片（`cont`），
   * 只按「第一个含该段的页」返回 ⇒ 书签跳到「上一页的末尾」而不是「这一段开始的那页」。
   */
  function pageOfPara(para: number): number {
    const list = pages.value;
    let first = -1;
    for (let k = 0; k < list.length; k += 1) {
      for (const c of list[k]!) {
        if (c.para !== para) continue;
        if (c.start === 0) return k + 1;
        if (first < 0) first = k + 1;
      }
    }
    return first >= 0 ? first : (para >= 0 ? list.length || 1 : 1);
  }

  /**
   * `(段下标, 段内偏移)` → 页码：命中**包含该偏移的那一片**（不区分是不是续片）。
   *
   * 重建后「回到原来那段」用它：跨页段的开头在第 1 页、续片在第 2 页，
   * 用 `pageOfPara` 会把读者从第 2 页拽回第 1 页（`#825` 实测「翻一页就回去」的根因）。
   */
  function pageOfChunk(para: number, start: number): number {
    const list = pages.value;
    for (let k = 0; k < list.length; k += 1) {
      for (const c of list[k]!) {
        if (c.para === para && start >= c.start && start < c.end) return k + 1;
      }
    }
    return pageOfPara(para);
  }

  /** 页码 → 该页第一个正文段（重建后「回到原来那段」用；标题块 `-1` 跳过） */
  function firstParaOfPage(pageNo: number): number {
    for (const c of chunksOf(pageNo)) if (c.para >= 0) return c.para;
    return -1;
  }

  /** 页码 → 该页第一个正文片的**起点**（`para + 段内偏移`，跨页续片也能精确回到原处） */
  function firstChunkOfPage(pageNo: number): { para: number; start: number } | null {
    for (const c of chunksOf(pageNo)) {
      if (c.para >= 0) return { para: c.para, start: c.start };
    }
    return null;
  }

  return {
    pages,
    pageCount,
    ready,
    measuring,
    lastMs,
    lastPageCount,
    rebuild,
    cancel,
    reset,
    chunksOf,
    pageOfPara,
    pageOfChunk,
    firstParaOfPage,
    firstChunkOfPage,
  };
}
