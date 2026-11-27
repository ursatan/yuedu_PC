/**
 * Android 风格 Toast 通道 —— **专供源脚本的 `java.toast` / `java.longToast`**。
 *
 * ## 为什么与 `toast.ts`（右上角卡片）分开
 * 两者承载的**不是同一类信息**：
 *  · `toast.ts` 是**应用自己**的反馈（保存成功、切换线路、Cookie 已回传…）；
 *  · 这里承载的是**源脚本**说的话 —— 等价于 Legado App 里脚本调 `java.toast` 时弹出的原生 Toast。
 * 混在一条通道里会让「脚本说什么」和「应用说什么」分不清，而且视觉要求也不同：
 * 用户明确要求 Android 形态 —— **页面底部居中、半透明深色、向下渐隐**。
 *
 * ## 为什么必须由前端渲染（而不能只打服务端日志）
 * 这是旧实现最坑的地方：服务端**没有 UI**，脚本 toast 早期被静默丢弃 ⇒
 * 很多源的关键反馈（禁漫天堂登录按钮 `log()` → `java.longToast`、独阅读网接口 `tip`）全部消失，
 * 用户点按钮「毫无反应」，误以为功能坏了。
 *
 * 用法：
 *   import { androidToast } from './android-toast';
 *   androidToast('已切换分流线路', { long: true });
 * 宿主组件：`<AndroidToastHost />`（挂在 App.vue 根部，全局唯一）。
 */
import { ref } from 'vue';

export interface AndroidToastItem {
  id: number;
  text: string;
  /** 自动消失毫秒数 */
  ttl: number;
}

const items = ref<AndroidToastItem[]>([]);
let seq = 0;

/** 每条最多 300 字（脚本可能把整段 HTML/JSON 塞进来） */
const MAX_TEXT = 300;
/** 同屏最多 3 条（Android 也是排队展示；超出丢最早） */
const MAX_ITEMS = 3;
/** Android `Toast.LENGTH_SHORT` ≈ 2s；`LENGTH_LONG` ≈ 3.5s。这里给得更宽裕一点 */
const TTL_SHORT = 2600;
const TTL_LONG = 5200;

/**
 * 弹一条 Android 风格 Toast。返回 id（-1 = 空文本被忽略）。
 *
 * `long` 对应 Legado 的 `java.longToast`；不传时按文本长度自动判定 ——
 * 源作者写长句往往就是想让用户看清（短句一瞥即过反而读不完）。
 */
export function androidToast(text: string, opts: { long?: boolean; ttl?: number } = {}): number {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return -1;
  const body = s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
  // 连续重复去重：脚本在循环里 toast 同一句时不该刷屏（与 toast.ts 同策略）
  const last = items.value[items.value.length - 1];
  if (last && last.text === body) return last.id;
  const ttl = opts.ttl ?? (opts.long || body.length > 50 ? TTL_LONG : TTL_SHORT);
  const id = ++seq;
  items.value.push({ id, text: body, ttl });
  if (items.value.length > MAX_ITEMS) items.value.splice(0, items.value.length - MAX_ITEMS);
  globalThis.setTimeout(() => dismissAndroidToast(id), ttl);
  return id;
}

export function dismissAndroidToast(id: number): void {
  const i = items.value.findIndex((t) => t.id === id);
  if (i >= 0) items.value.splice(i, 1);
}

/** 组件内用：`const { items, androidToast } = useAndroidToasts()` */
export function useAndroidToasts(): {
  items: typeof items;
  androidToast: typeof androidToast;
  dismiss: typeof dismissAndroidToast;
} {
  return { items, androidToast, dismiss: dismissAndroidToast };
}

/**
 * 探针入口：浏览器控制台 `yueduToast('文本')`。
 *
 * 为什么要把已有函数挂到全局：toast 的**渲染环节**（宿主组件挂载、底部居中定位、向下渐隐动画）
 * 只有浏览器里能验证 —— 服务端没有 UI，而 CDP 探针（`tmp/probe-*.mjs`）需要一个稳定的调用点。
 * 生产环境留着无害（不新增任何权限或行为，只是暴露已有函数）。
 */
(globalThis as { yueduToast?: typeof androidToast }).yueduToast = androidToast;
