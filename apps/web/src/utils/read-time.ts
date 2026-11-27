/**
 * 阅读时长「计时 → 结算 → 上报」的可注入实现（`#144`，主线收尾项）。
 *
 * ## 为什么抽成独立模块
 * 计时逻辑要挂在组件生命周期 / `visibilitychange` / 翻章三种事件上，
 * 直接写在 store 里没法单测（要 mock 组件与网络）。这里把**全部状态与 I/O 都注入**，
 * 测试里用假时钟 + 假上报函数就能把「累计 / 翻章结算 / 失败保留 / 门控」逐条锁住。
 *
 * ## 语义对齐上游（逐条）
 * - `ReadBook.upReadTime()`（`ReadBook.kt:616-627`）：
 *   `readTime += now - readStartTime; readStartTime = now; lastRead = now` ——
 *   **结算即重启**（`lap()`），不是清零；触发点 = 翻章（`:925`）。
 * - 门控 `AppConfig.enableReadRecord`（默认 true）：**计时器内部判**
 *   （上游第一行就是 `if (!AppConfig.enableReadRecord) return`）——关闭时连表都不走。
 * - **墙钟时间**：不扣朗读/后台（上游也不扣）；页面隐藏的部分由
 *   `pause()`（`visibilitychange→hidden`）结算掉，观感与上游「离开界面就停」一致。
 *
 * ## 离线不丢
 * 上报失败 ⇒ `deltaMs` 攒进 pending（注入的存储，本仓 = localStorage），
 * 下次任一结算点**先冲 pending 再发新账**；成功才清。
 * （失败留痕：调用方在 `put` 的实现里做 warnOnce，这里保持纯逻辑。）
 */

export interface ReadTimeBookInfo {
  /** 书名（聚合主键的一半，`ReadRecord.kt` 主键 `(deviceId, bookName)`） */
  bookName: string;
  /** 作者（同名书辅助身份；上游 `book?.author.orEmpty()`） */
  author?: string;
}

export interface ReadTimeDeps {
  now(): number;
  /** 读/写「上报失败攒下的未发毫秒数」（本仓 = localStorage 的 `yuedu-readtime-pending`） */
  getPendingMs(): number;
  setPendingMs(ms: number): void;
  /** 上报（本仓 = `PUT /api/user/read-time`）。reject = 失败（攒账） */
  put(bookName: string, author: string | undefined, deltaMs: number): Promise<void>;
  /**
   * 门控（`AppConfig.enableReadRecord`，契约 `GlobalReaderPrefs.enableReadRecord`）。
   * 每次「开始计时/重启表」时实时读 ⇒ 用户中途关开关立即生效。
   */
  enabled(): boolean;
  /** 累计不足这个数不发请求（避免连翻章打出大量 1~2 秒的小请求）。默认 1000 */
  minFlushMs?: number;
}

export interface ReadTimeMeter {
  /** 进入阅读界面（开始计时；已开则幂等） */
  begin(info: ReadTimeBookInfo): void;
  /** 结算并**重启**（翻章；对齐上游 `upReadTime` 语义） */
  lap(): void;
  /** 结算并**停表**（离开阅读界面） */
  end(): void;
  /** 页面隐藏：结算 + 暂停（visible 后由 {@link resume} 恢复） */
  pause(): void;
  /** 页面恢复可见（仅当阅读界面还开着才重启表） */
  resume(): void;
  /** 排查用：当前未发的毫秒数（pending + 未结算段；0 = 没账） */
  unsentMs(): number;
}

export function createReadTimeMeter(deps: ReadTimeDeps): ReadTimeMeter {
  const minFlushMs = deps.minFlushMs ?? 1000;
  let start = 0; // 0 = 停表
  let info: ReadTimeBookInfo | null = null;
  let active = false; // 阅读界面是否开着（决定 resume 要不要重启表）

  function openMs(): number {
    return start > 0 ? Math.max(0, deps.now() - start) : 0;
  }

  /**
   * 结算当前段：**先记账，冲账成功才清**——
   * total = pending + 本段；成功发 total、清 pending；失败把 total 写回 pending。
   * 不足 minFlushMs 的碎片写回 pending 攒着，不 empty-send。
   */
  function settle(restart: boolean): void {
    if (!start) return;
    const delta = openMs();
    start = restart && deps.enabled() ? deps.now() : 0;
    if (!info) return;
    const total = deps.getPendingMs() + delta;
    if (total < minFlushMs) {
      deps.setPendingMs(total);
      return;
    }
    const { bookName, author } = info;
    void deps.put(bookName, author, total)
      .then(() => deps.setPendingMs(0))
      .catch(() => deps.setPendingMs(total));
  }

  return {
    begin(next: ReadTimeBookInfo): void {
      info = next;
      active = true;
      if (!start && deps.enabled()) start = deps.now();
    },
    lap(): void {
      settle(true);
    },
    end(): void {
      active = false;
      settle(false);
    },
    pause(): void {
      settle(false);
    },
    resume(): void {
      if (active && !start && deps.enabled()) start = deps.now();
    },
    unsentMs(): number {
      return deps.getPendingMs() + openMs();
    },
  };
}
