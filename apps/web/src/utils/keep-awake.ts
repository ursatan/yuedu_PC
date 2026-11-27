/**
 * B8 **屏幕常亮**（Screen Wake Lock）。
 *
 * ## 口径（用户 2026-11-07 拍板）
 * · **默认关**；偏好持久化在 localStorage（换书/重开阅读仍按用户上次选择）；
 * · 只在**阅读浮层打开**期间生效 —— 关掉阅读就释放锁，不把整个应用变成「永不熄屏」；
 * · 标签页隐藏时浏览器会**自动释放**锁；回到前台若仍开着则重新申请。
 *
 * ## 与上游的关系（`F:\legado`，GPL-3.0，只参考机制）
 * 上游 `ReadBookActivity.kt:3449-3464` 用 `WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON`
 * （`screenTimeOut = -1` = Always）实现；`ReadBookActivity.kt:2071-2072` 在开自动翻页时
 * 强制 `screenTimeOut = -1L`。Web 端没有这个 Flag，等价物是 **Screen Wake Lock API**
 * （Chromium 84+ / 需安全上下文）。本文件只做「申请 / 释放 / 重申请」，不含任何阅读逻辑。
 *
 * ## 不支持时怎么办
 * 不伪造（不用隐藏视频等 trick）—— 界面如实标注「当前环境不支持」，并保持开关值本身，
 * 免得用户以为「开了但没生效」。`file://` 与部分内嵌浏览器可能拿不到该 API。
 */

import { ref } from 'vue';

export const KEEP_AWAKE_KEY = 'yuedu.reader.keepAwake';

/** 最小化的 Wake Lock 类型（不依赖 lib.dom 的版本，老 TS 也能过） */
interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
};

function loadPref(): boolean {
  try {
    return localStorage.getItem(KEEP_AWAKE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 用户偏好（默认关）。界面开关绑它；改完立刻申请/释放 */
export const keepAwakePref = ref<boolean>(loadPref());
/** 当前是否真的持有屏幕锁（供界面显示「已生效」） */
export const keepAwakeHeld = ref(false);
/** 环境是否提供 Screen Wake Lock（不支持时界面如实提示） */
export const keepAwakeSupported = typeof navigator !== 'undefined'
  && !!(navigator as WakeLockNavigator).wakeLock
  && typeof document !== 'undefined';

/** 阅读页是否打开（由 `ReaderOverlay` 喂入；没有它时不申请锁） */
let wanted = false;
let sentinel: WakeLockSentinelLike | null = null;
let pending = false;

function release(): void {
  const s = sentinel;
  sentinel = null;
  keepAwakeHeld.value = false;
  if (s && !s.released) void s.release().catch(() => { /* 已释放/环境回收：忽略 */ });
}

async function acquire(): Promise<void> {
  if (!wanted || !keepAwakePref.value || !keepAwakeSupported) return;
  // 隐藏标签页申请必然失败；等 `visibilitychange` 恢复后再取
  if (document.visibilityState !== 'visible') return;
  if (sentinel && !sentinel.released) return;
  if (pending) return;
  pending = true;
  try {
    const nav = navigator as WakeLockNavigator;
    const s = await nav.wakeLock?.request('screen');
    if (!s) return;
    sentinel = s;
    keepAwakeHeld.value = true;
    // 系统/浏览器可能随时回收（切后台、电量策略）⇒ 清掉本地引用，等下一次显式申请
    s.addEventListener('release', () => {
      if (sentinel === s) {
        sentinel = null;
        keepAwakeHeld.value = false;
      }
    });
  } catch {
    keepAwakeHeld.value = false;
  } finally {
    pending = false;
  }
}

/** 阅读页开/关时调用：`true` = 阅读中且用户开了常亮 */
export function setReaderAwake(active: boolean): void {
  wanted = active;
  if (active) void acquire();
  else release();
}

/** 界面开关：写偏好并立即生效（申请本身是异步，失败只体现在 `keepAwakeHeld`） */
export function setKeepAwakePref(on: boolean): void {
  keepAwakePref.value = !!on;
  try { localStorage.setItem(KEEP_AWAKE_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
  if (on) void acquire();
  else release();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void acquire();
    else keepAwakeHeld.value = false; // 浏览器已自动释放，锁不可再用
  });
}
