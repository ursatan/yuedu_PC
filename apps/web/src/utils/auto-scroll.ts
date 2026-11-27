/**
 * `#814` 自动滚动的**速度档位**（本机偏好，跨页面共用一份）。
 *
 * ## 为什么单独一个模块
 * `#808` 把这个 `ref` 放在 `ReaderOverlay.vue` 里，设置页就拿不到同一个状态：
 * 设置页只能写 localStorage，而正在开着的阅读页读的是**自己 setup 时**的那份 ⇒ 改完不生效。
 * 抽到这里后，阅读页（`更多 → 样式 → 自动滚动`）与设置页（`设置 → 阅读`）绑的是**同一个 ref**。
 *
 * ## 取值口径
 * · 单位是「px/帧 @60fps」：0.5 ≈ 30 px/s（几乎察觉不到），4 ≈ 240 px/s（约每秒 8 行）；
 * · 越界/坏值一律夹到 `[0.5, 4]`，默认 `1`（与上游「慢速」档接近）；
 * · 只记**速度**：开关是会话态（在设置页「预置为开」没有意义，进阅读页也没有落点）。
 */
import { ref } from 'vue';

export const AUTO_SCROLL_SPEED_KEY = 'yuedu.reader.autoscroll.speed';
export const AUTO_SCROLL_MIN_SPEED = 0.5;
export const AUTO_SCROLL_MAX_SPEED = 4;

function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(AUTO_SCROLL_MIN_SPEED, Math.min(AUTO_SCROLL_MAX_SPEED, v));
}

function loadSpeed(): number {
  try {
    const raw = localStorage.getItem(AUTO_SCROLL_SPEED_KEY);
    if (raw == null) return 1;
    return clampSpeed(Number(raw));
  } catch {
    return 1;
  }
}

/** 当前速度档位（px/帧 @60fps）。两个页面共用这一份 */
export const autoScrollSpeed = ref<number>(loadSpeed());

/** 改速度并落地（存不下不影响滚动） */
export function setAutoScrollSpeed(v: number): void {
  const next = clampSpeed(Number(v));
  autoScrollSpeed.value = next;
  try { localStorage.setItem(AUTO_SCROLL_SPEED_KEY, String(next)); } catch { /* 忽略 */ }
}
