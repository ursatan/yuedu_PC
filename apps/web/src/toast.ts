/**
 * 极简全局 Toast（零依赖，替代 Legado App 里的 Android Toast）。
 *
 * 为什么需要它：源的登录 UI 按钮（禁漫天堂「切换分流线路」等）**只靠 toast 反馈** ——
 * 动作不改 Cookie、不改登录头，服务端把这些文本收集在 `result.toasts` 里回传。
 * 前端若只更新对话框里一行小字，用户会以为「点了没反应」。
 *
 * 用法：
 *   import { toast } from '../toast';
 *   toast('已切换分流', 'ok');
 * 宿主组件：`<ToastHost />`（挂在 App.vue 根部，全局唯一）。
 */
import { ref } from 'vue';

export type ToastLevel = 'info' | 'ok' | 'warn' | 'error';

/**
 * `#552` **可点的一跳**（源医生巡检播报的「详情」）。
 *
 * 为什么必须给 toast 加动作：巡检只在 toast 里说「N 个源规则异常」，
 * 用户看到后**没有路可走**（要自己想起来去源管理、还得回忆是哪几个源）——
 * 那这条播报的价值就只剩「知道出事了」。给一个「详情」直达源管理筛选，闭环才成立。
 */
export interface ToastAction {
  label: string;
  /** vue-router 的 `to`（如 `{ name: 'source-mgr', query: { doctor: '1' } }`） */
  to: string | Record<string, unknown>;
}

export interface ToastItem {
  id: number;
  text: string;
  level: ToastLevel;
  /** 自动消失毫秒数 */
  ttl: number;
  /** 可选的一跳按钮（点了就跳，并关掉本条） */
  action?: ToastAction;
}

const items = ref<ToastItem[]>([]);
let seq = 0;

/** 每条 toast 最多 240 字（脚本可能把整段 HTML/JSON 塞进来） */
const MAX_TEXT = 240;
/** 同屏最多 6 条，超出丢最早 */
const MAX_ITEMS = 6;

export function toast(text: string, level: ToastLevel = 'info', ttl = 4200, action?: ToastAction): number {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return -1;
  const body = s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
  // 连续重复去重：脚本在循环里 toast 同一句时不该刷屏
  const last = items.value[items.value.length - 1];
  if (last && last.text === body) return last.id;
  const id = ++seq;
  // 带动作的 toast 给更长的停留时间（用户要点它，一闪而过等于没有）
  const realTtl = action ? Math.max(ttl, 8_000) : ttl;
  items.value.push({ id, text: body, level, ttl: realTtl, ...(action ? { action } : {}) });
  if (items.value.length > MAX_ITEMS) items.value.splice(0, items.value.length - MAX_ITEMS);
  globalThis.setTimeout(() => dismiss(id), ttl);
  return id;
}

export function dismiss(id: number): void {
  const i = items.value.findIndex((t) => t.id === id);
  if (i >= 0) items.value.splice(i, 1);
}

/** 组件内用：`const { items, toast, dismiss } = useToasts()` */
export function useToasts(): { items: typeof items; toast: typeof toast; dismiss: typeof dismiss } {
  return { items, toast, dismiss };
}
