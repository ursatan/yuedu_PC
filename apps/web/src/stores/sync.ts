/**
 * 同步状态（阶段 1.5 · `#143`）—— 界面上的「离线 / 有 N 项待同步」指示与**自动重传**。
 *
 * ## 为什么需要它
 * `server-sync.ts` 的降级路径（离线不抛、本地照写、留 `pendingSync`）早就有了，
 * 但**用户看不见**：服务端没起时界面与平时一模一样，改了东西也不知道有没有存到服务端；
 * 而且重传只发生在**下一次启动**（`pull` 里的 `isPending` 分支）——
 * 「关掉 bat 再打开」这种最常见的用法，用户得自己重启页面才能同步。
 *
 * ## 三件事，各自只有一处实现
 * 1. **状态**：`online`（最后一次请求是否可达）+ `pendingCount`（有 `pendingSync` 标记的实体数）。
 *    两者都从 `server-sync.ts` 派生（那边是唯一真相源），本 store **只做响应式镜像**。
 * 2. **自动重传**：`start()` 之后每 {@link PING_MS} 心跳一次；服务端一旦可达且有待同步 ⇒ `resyncAll()`。
 *    ⚠️ 判据只能是**我们自己发请求**，不是 `navigator.onLine` —— 服务端是本机 3000，
 *    网线拔了它也是「在线」，而服务端窗口一关它就是「不可达」。
 * 3. **手动重试**：界面上那个「⟳ 重试」按钮（用户不想等心跳时用）。
 *
 * ## 为什么是**固定心跳**（而不是「只在离线时轮询」）
 * 侧栏底部原本就有一个「服务在线/离线」指示，它自己有一套 `ping` + 15s 定时器
 * —— 与这里要维护的「可达性」是**同一个语义**。合并进来后只有一份：
 * 心跳负责「发现服务端挂了」（用户Idle时也要发现），`reportServerReachable` 负责
 * 「我们的请求刚失败/成功」（立刻反映，不等心跳）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  isServerOffline,
  onSyncStateChange,
  pendingTargets,
  reportServerReachable,
  reportServerReachableNow,
  resyncAll,
} from '../utils/server-sync';

/** 心跳间隔（沿用侧栏底部原有的 15s，不额外加一路请求） */
const PING_MS = 15_000;
/**
 * ping 自己的超时。
 *
 * `#178`（用户 2026-10-01 实测「多次出现：服务离线 · 627 源 ⚠ 离线（本地可用）」）：
 * 服务端是**单进程 Node**，忙着跑大搜索 / 封面解密时 `/api/engines` 会排在后面；
 * 旧的 4s 超时会让「服务端只是忙」被判成「已离线」⇒ 界面闪现离线。
 * 本机 3000 正常响应是毫秒级 ⇒ **15s 远大于最忙的情况**，只在真的听不到时才失败。
 * ⚠️ 不能设成无限：真离线时要能及时反映。
 */
const PING_TIMEOUT_MS = 15_000;

/* ============================================================================
 * `#178` 离线判定去抖 —— **计数逻辑在 `server-sync.ts`**（`reportServerReachable`，
 * 那是所有标记离线的地方唯一的入口，5 处业务请求 + 心跳都走它）。
 * 这里只负责「什么时候去探」。
 *
 * ## 服务端**没有**掉线（实测连续 20 次 `/api/engines` 全 200）
 * 是前端把「一次 ping 失败」当成「已离线」了。切分类/滚动加载封面时最容易触发
 * —— 那正是服务端最忙的时候。
 *
 * ## 恢复为什么必须快（一次成功就翻回在线）
 * 误报的代价全在「显示离线」这一侧：用户看到会以为改动没存上，
 * 会去检查数据、甚至重做一遍操作 ⇒ 宁可偶尔多显示在线。
 * ============================================================================ */

export const useSyncStore = defineStore('sync', () => {
  const online = ref(!isServerOffline());
  const pendingLabels = ref<string[]>(pendingTargets().map((t) => t.label));
  const busy = ref(false);
  const msg = ref('');

  const pendingCount = computed(() => pendingLabels.value.length);
  /** 要不要在界面上显示指示器（在线且无待同步时**不显示**，别占地方） */
  const visible = computed(() => !online.value || pendingCount.value > 0);
  /** 一句话文案（离线 / 待同步 两种情况分开说，避免用户以为是同一件事） */
  const text = computed(() => {
    const who = pendingCount.value ? `待同步 ${pendingCount.value} 项（${pendingLabels.value.join('、')}）` : '';
    if (!online.value) return who ? `离线 · ${who}` : '离线（本地可用）';
    return who;
  });

  /** 从 `server-sync.ts` 刷新镜像（它是唯一真相源） */
  function refresh(): void {
    online.value = !isServerOffline();
    pendingLabels.value = pendingTargets().map((t) => t.label);
  }

  /**
   * 探一次服务端（**唯一**的「可达性」判据）。
   *
   * ⚠️ 判据是「我们自己发请求」，不是 `navigator.onLine`
   *   （那是本机网络状态，服务端窗口一关它也还是 true）。
   * 超时见 {@link PING_TIMEOUT_MS}的说明（`#178`：4s 会在服务端忙时误报）。
   */
  async function ping(): Promise<boolean> {
    try {
      const r = await fetch('/api/engines', { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * 心跳判定：调 {@link reportServerReachable}（它内部已带去抖：连续失败 N 次才置离线）。
   * ⚠️ 这里**不要自己再做一层计数** —— 计数必须唯一，否则会出现两套阈值互相干扰。
   * @see {@link reportServerReachable} 里的去抖说明
   */
  async function probe(): Promise<boolean> {
    const ok = await ping();
    reportServerReachable(ok);   // 去抖与「恢复要立刻」都在那一层实现
    return ok;
  }

  /**
   * 手动探活（用户主动点的「⟳ 重试」）：**立刻如实反映**，跳过去抖。
   * ⚠️ 用 `reportServerReachableNow` —— 它还会清空 failStreak，
   *   否则手动的失败会喂给心跳计数（手动 1 次 + 心跳 2 次 = 误判离线）。
   */
  async function probeNow(): Promise<boolean> {
    const ok = await ping();
    reportServerReachableNow(ok);
    return ok;
  }

  /**
   * 重试同步（按钮与轮询共用）。
   * 先探活（避免明知不可达还去发一串必失败的写请求），再把所有待同步实体重推一遍。
   */
  async function retry(): Promise<{ ok: boolean; message: string }> {
    if (busy.value) return { ok: false, message: '正在重试…' };
    busy.value = true;
    try {
      // `#178`：走 probeNow（立刻如实反映），不走心跳的去抖 —— 用户是主动来问的
      if (!(await probeNow())) {
        refresh();
        return { ok: false, message: '服务端仍不可达（本地改动已保存，不会丢）' };
      }
      const list = pendingTargets();
      if (!list.length) return { ok: true, message: '没有待同步的数据' };
      const results = await resyncAll();
      refresh();
      const failed = results.filter((r) => !r.ok);
      return failed.length
        ? { ok: false, message: `仍有 ${failed.length} 项没同步成功：${failed.map((f) => f.label).join('、')}` }
        : { ok: true, message: `已同步 ${results.length} 项` };
    } finally {
      busy.value = false;
      refresh();
    }
  }

  let timer: number | undefined;
  let started = false;

  /** 启动监听（`main.ts` 调一次；重复调用无副作用） */
  function start(): void {
    if (started) return;
    started = true;
    onSyncStateChange(refresh);
    refresh();

    const tick = async (): Promise<void> => {
      const ok = await probe();
      if (!ok) return;
      // 服务端可达：还有待同步的就重推（`resyncAll` 内部只处理打了标记的实体）
      if (pendingTargets().length) {
        const r = await retry();
        if (!r.ok) console.warn('[sync] 自动重传未全部成功：', r.message);
        else msg.value = r.message;
      }
    };
    timer = window.setInterval(() => void tick(), PING_MS);

    // 切回前台立刻探一次：用户「关掉 bat → 打开 bat → 切回浏览器」是最高频的场景，
    // 等满一个心跳周期（15s）会让人以为「没生效」。
    const onWake = (): void => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
  }

  /** 仅供测试/探针：停掉轮询 */
  function stop(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    started = false;
  }

  return { online, pendingLabels, pendingCount, busy, msg, visible, text, refresh, ping, retry, start, stop };
});
