import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 影视详情**浮窗**会话。
 *
 * 为什么从「路由页」改成「浮窗」（2026-09-25 用户要求）：
 * 用户要的是「影院发现页 → 点卡片 → **浮窗**详情 → 点播放 → **浮窗**播放」，
 * 与书籍详情页→阅读页同一套交互。原实现是 `router.push('/v-detail')` / `('/player')`
 * 的**整页跳转**，会把影院发现页整块顶掉（用户的「内嵌页效果」就是指这个）。
 *
 * 于是这里只管**会话数据**（跨组件传），显隐由 `detailOpen` 控制、组件挂在 MainLayout 根部，
 * 与 `ReaderOverlay`/`AudioPlayer` 同一形态。
 */
export interface VodDetailSession {
  sourceId: string;
  payload: unknown;
  title: string;
  cover?: string;
  /**
   * 打开详情浮窗后**自动起播**（影视库「▶ 播放 / 续播」按钮用，对齐 OmniFlow 的
   * `pickLine`/`pickEp` 续播语义）。
   *
   * 按**线路名 + 集标题**定位，不用下标：目录会随源更新而漂移（集数增删/线路换序），
   * 下标会指到别的集。找不到就退回「第一条线路的第 1 集」。
   */
  autoPlay?: { line?: string; ep?: string };
}

export const useVodStore = defineStore('vod', () => {
  const detail = ref<VodDetailSession | null>(null);
  /** 详情浮窗是否可见 */
  const detailOpen = ref(false);

  /** 打开影视详情浮窗（各入口唯一入口点：影院发现页 / 影视库 / 首页观看历史 / 跨源搜索） */
  function openDetail(s: VodDetailSession): void {
    detail.value = s;
    detailOpen.value = true;
  }
  function closeDetail(): void {
    detailOpen.value = false;
  }

  return { detail, detailOpen, openDetail, closeDetail };
});
