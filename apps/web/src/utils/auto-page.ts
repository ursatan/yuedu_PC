/**
 * B8 **自动翻页档位**（只持久化「几秒翻一页」这一项）。
 *
 * ## 与「自动滚动」的分工（别合并成一个开关）
 * · 自动滚动（`utils/auto-scroll.ts`）= **滚动模式**下匀速下滑，速度是连续量；
 * · 自动翻页（本文件）= **分页模式**下按固定间隔翻一页，档位是**离散秒数**。
 * 两者都属「自动往下看」，但单位与生效模式不同 ⇒ 各自一份偏好，互不覆盖。
 *
 * ## 档位（用户 2026-11-07 拍板）
 * 4 / 8 / 12 / 20 / 30 秒；坏值按「最接近的一档」归一，读不到/非法回落 8 秒。
 *
 * ## 为什么开关不在这里
 * 开关是**会话态**（进阅读页才有意义，设置页「预置为开」没有落点）——
 * 与自动滚动同一条口径：只持久化档位，`autoPageOn` 留在 `ReaderOverlay`。
 */
import { ref } from 'vue';

export const AUTO_PAGE_INTERVAL_KEY = 'yuedu.reader.autopage.interval';
export const AUTO_PAGE_SECONDS = [4, 8, 12, 20, 30] as const;
export const DEFAULT_AUTO_PAGE_SECONDS = 8;

export type AutoPageSeconds = (typeof AUTO_PAGE_SECONDS)[number];

/** 归一：非数字 ⇒ 默认；数字 ⇒ 取**最接近**的合法档位（手改 localStorage 也不会出现 7 秒这种档） */
export function normalizeAutoPageSeconds(v: unknown): AutoPageSeconds {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_AUTO_PAGE_SECONDS;
  let best: AutoPageSeconds = AUTO_PAGE_SECONDS[0];
  for (const s of AUTO_PAGE_SECONDS) {
    if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  }
  return best;
}

function loadInterval(): AutoPageSeconds {
  try {
    return normalizeAutoPageSeconds(localStorage.getItem(AUTO_PAGE_INTERVAL_KEY));
  } catch {
    return DEFAULT_AUTO_PAGE_SECONDS;
  }
}

/** 当前档位（秒）。阅读页与设置页（若将来加入口）共用这一份 */
export const autoPageInterval = ref<AutoPageSeconds>(loadInterval());

/** 改档位并落地（存不下不影响翻页） */
export function setAutoPageInterval(v: unknown): void {
  const next = normalizeAutoPageSeconds(v);
  autoPageInterval.value = next;
  try { localStorage.setItem(AUTO_PAGE_INTERVAL_KEY, String(next)); } catch { /* 忽略 */ }
}
