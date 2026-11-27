/**
 * 阶段 1.4「localStorage → 服务端」的**同步策略**（用户 2026-09-28 拍板，全仓统一按这一份）。
 *
 * ## 策略（三条，别各自发挥）
 * 1. **启动时读服务端**；服务端**非空 ⇒ 以服务端为准**（覆盖本地缓存）；
 * 2. 服务端**为空且本地有数据** ⇒ 做**一次性搬迁**（把本地推上去，本地保留）；
 * 3. **写入 = 本地缓存 + 推服务端**；推送失败（离线）⇒ 留 `pendingSync` 标记，下次启动**重传**（不丢数据）。
 *
 * ## 为什么是「本地缓存 + 服务端权威」而不是直接改成纯服务端
 * Web 端必须能在**服务端没起来时继续用**（`F:\yuedu_PC\start-server.bat` 关窗即停，用户日常就这么用）。
 * 纯服务端会把「服务端没起」变成「书架空了」——那是数据事故。localStorage 从这里起降级为**缓存**。
 *
 * ## 三条纪律（与铁律一致）
 * - **离线**（`UserDataError.offline`，status=0）⇒ 降级，**不抛**；其余错误⇒**照常抛**（不静默兜底）；
 * - 推送失败必须**留痕**（`console.warn`），静默 = 「迁移没生效」看起来像「数据本来就没有」；
 * - 写入失败时**本地已经写好了**（先写本地再推），所以最坏情况是「服务端落后」，不是「数据丢了」。
 *
 * ## 与 `user-data.ts` 的分工
 * 这一层只管**策略**；端点 URL/方法/信封剥离都在 `user-data.ts`（唯一一份）。
 *
 * ## 两种推送方式（选错会打出请求风暴）
 * | 方式 | 用在哪 | 代价 |
 * |---|---|---|
 * | `reconcile`（全量对齐） | 分组（≤52 条、改动低频）、启动兜底 | 每次写 = 1 GET + N PUT |
 * | `pushDiff`（增量，经 `createPusher`） | **书架**（数百条、翻章就写）、书签 | 每次写只推**变化的那几条** |
 */
import { UserDataError } from '../user-data';

/** 对齐结果来源（用于留痕与探针断言，别拿它做业务判断以外的事） */
export type SyncSource = 'server' | 'migrated' | 'resynced' | 'offline';

/** 一个实体的同步方案 */
export interface SyncPlan<T> {
  /** localStorage 缓存键 */
  localKey: string;
  /** 「上次没推上去」标记键 */
  pendingKey: string;
  /** 读服务端并映射成本地形态（服务端返回空数组表示「那边还没有数据」） */
  list(): Promise<T[]>;
  /** 写一条到服务端 */
  put(item: Record<string, unknown>): Promise<unknown>;
  /** 按主键删服务端一条（主键统一字符串化，与服务端 query 参数一致） */
  remove(id: string): Promise<unknown>;
  /** 本地对象 → 契约形态 */
  toRemote(x: T): Record<string, unknown>;
  /** 主键（字符串化） */
  idOf(x: T): string;
}

export interface PullResult<T> {
  /** `null` = 保持本地（离线）；否则用这份数据替换本地 */
  items: T[] | null;
  source: SyncSource;
}

export interface PushResult {
  ok: boolean;
  /** true = 服务端不可达，已标记 pendingSync（调用方只需留痕，不必重试） */
  offline: boolean;
  /** true = **尚未与这一端对齐**（`pull` 还没跑）⇒ 主动跳过，避免用本地覆盖服务端 */
  skipped?: boolean;
}

export function isOffline(e: unknown): boolean {
  return e instanceof UserDataError && e.offline;
}

export function isPending(pendingKey: string): boolean {
  try {
    return localStorage.getItem(pendingKey) === '1';
  } catch {
    return false;
  }
}

export function markPending(pendingKey: string): void {
  try {
    localStorage.setItem(pendingKey, '1');
  } catch { /* 隐私模式等写不进去：不影响主流程 */ }
  notifySyncChange();
}

export function clearPending(pendingKey: string): void {
  try {
    localStorage.removeItem(pendingKey);
  } catch { /* 同上 */ }
  notifySyncChange();
}

/* ------------------------------------------------------------------ *
 * 阶段 1.5（`#143`）：**离线可见 + 服务端恢复后自动重传**
 * ------------------------------------------------------------------ */

/**
 * 上一次与服务端交互的结果（`true` = 不可达）。
 *
 * ⚠️ 这是**这一端自己的看法**，不是「网络断了」：本仓的服务端是本机 3000 端口，
 * `navigator.onLine` 永远是 true —— 判断依据只能是**我们自己的请求是否抛 status=0**。
 */
let serverOffline = false;
const stateListeners = new Set<() => void>();

/**
 * `#178` 连续失败计数（**唯一真相源在这里**，`stores/sync.ts` 的心跳也调它）。
 *
 * ## 为什么要有去抖（用户 2026-10-01 实测「多次出现：服务离线 · 627 源 ⚠ 离线（本地可用）」）
 * 服务端是**单进程 Node**，忙着跑大搜索/ 封面解密时，轻请求（`/api/engines`）
 * 会排在后面；只要连续几秒没空出响应，浏览器就报超时。
 * 旧实现「**任何一次**请求失败 ⇒ 立刻显示离线」⇒ 服务端一忙就闪现一次。
 * （实测服务端连续 20 次 ping 全 200，确实不是服务端掉线。）
 *
 * ## 为什么去抖**只挡「失败」不挡「恢复」
 * 误报的代价全在「显示离线」这一侧 —— 用户看到会以为改动没存上、
 * 会去检查数据、甚至重做一遍操作。所以：
 * · 失败要**连续 3 次、且持续 ≥30s**（`#462` 加的时间判据）才对外翻面；
 * · 恢复**一次成功就立刻**翻回在线（宁可偶尔多显示一次在线）。
 */
let offlineAfterFailures = 3;
/**
 * `#462` **失败还必须「持续这么久」才翻面**（与次数**双判据**）。
 *
 * 为什么要加时间判据（用户 2026-10-15 实测的 stall 日志）：
 * 服务端是单进程 Node，而**本仓有若干源会在主线程做同步 HTTP**（L1 `java.ajax` 走
 * `Atomics.wait`）⇒ 一忙就是**整秒级**心跳停摆：`[stall] stall ms=5235 / 5045 / 5256 …`
 * （当天十余次），其中一次 `recover ms=47015`。这类停摆里心跳连失 3 次是**常态**，
 * 只按次数判 ⇒ 侧栏「服务离线」在一天里反复闪现（用户报的「出现离线」）。
 * 而只要循环一恢复，一次成功就立刻翻回在线 —— 属于**误报**那一侧的代价。
 *
 * ⇒ 判据补一条：**从第一次失败起至少已过 {@link OFFLINE_MIN_SPAN_MS}**。
 *   短停摆（几秒）不再翻面；真掉线（请求持续打不通）照样会翻。
 */
let offlineMinSpanMs = 30_000;
/** 连续失败计数（任何来源的失败都累加它 —— 心跳与业务请求共享同一个「服务端忙」事实） */
let failStreak = 0;
/** 本轮连续失败里**第一次**失败的时刻（0 = 当前没有失败串） */
let failStreakStartedAt = 0;

/**
 * 覆盖「翻面判据」（**测试用**；与 `configureTraffic` / `configureNetGuard` 同一条路子）。
 * 传 `null` 回到默认（`3` 次 + `30s`）。
 */
export function configureOfflineDebounce(next: { afterFailures?: number; minSpanMs?: number } | null): void {
  offlineAfterFailures = next?.afterFailures ?? 3;
  offlineMinSpanMs = next?.minSpanMs ?? 30_000;
  failStreak = 0;
  failStreakStartedAt = 0;
}

export function isServerOffline(): boolean {
  return serverOffline;
}

/**
 * 记为「服务端可达 / 不可达」，**带去抖**（`#178`）。
 *
 * ⚠️ 这是给**自动**判定用的（心跳、业务请求）：单次失败不翻面。
 * 需要「立刻如实反映」的地方（用户手动点「重试」）用 {@link reportServerReachableNow}。
 */
export function reportServerReachable(reachable: boolean): void {
  if (reachable) {
    // 恢复：一次成功立刻翻回（去抖只挡失败）
    failStreak = 0;
    failStreakStartedAt = 0;
    if (serverOffline) {
      serverOffline = false;
      notifySyncChange();
    }
    return;
  }
  const now = Date.now();
  if (!failStreak) failStreakStartedAt = now;
  failStreak += 1;
  if (failStreak < offlineAfterFailures) return;  // 还没到次数阈值 ⇒ 不翻面
  if (now - failStreakStartedAt < offlineMinSpanMs) return; // `#462` 也没持续够久 ⇒ 不翻面
  if (serverOffline) return;                        // 已经离线了
  serverOffline = true;
  notifySyncChange();
}

/**
 * 记为离线/在线，**跳过去抖立刻生效**（`#178`）。
 *
 * 只给「用户主动问了」的路径用（手动点「⟳ 重试」）—— 此刻用户要的就是真实答案。
 * ⚠️ 无论成败都要**清空 failStreak**：手动探活是独立信号，
 * 不该喂给自动计数（否则「手动失败 1 次 + 心跳失败 2 次」会凑够阈值而误判）。
 */
export function reportServerReachableNow(reachable: boolean): void {
  failStreak = 0;
  if (serverOffline === !reachable) return;
  serverOffline = !reachable;
  notifySyncChange();
}

/** 仅供测试/探针：把连续失败计数清零（不要在业务代码里用） */
export function resetReachabilityStreak(): void {
  failStreak = 0;
  failStreakStartedAt = 0; // `#462`：时间判据的起点也要清，否则「上一轮的起点」会把新的失败串算成持续很久
}

/** 订阅状态变化（离线标记 / 待同步标记发生变化时回调）。返回取消订阅。 */
export function onSyncStateChange(fn: () => void): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

/** 手动通知一次（`markPending`/`clearPending` 已内置调用） */
export function notifySyncChange(): void {
  for (const l of stateListeners) l();
}

/**
 * 一个实体的「重传」句柄 —— 离线恢复后按它把本地变化推回去。
 *
 * 为什么要登记而不是让界面自己去 store 里找：{@link resyncAll} 要在**不知道任何 store** 的前提下
 * 把所有实体重推一遍（`server-sync.ts` 是策略层，不该 import 任何 store —— 那会成环）。
 * 所以由各 store 在初始化时**自愿登记**（`reader.ts` 的 groups / shelf / bookmarks）。
 */
export interface SyncTarget {
  /** 与 `SyncPlan.localKey` 一致 */
  localKey: string;
  /** 与 `SyncPlan.pendingKey` 一致 */
  pendingKey: string;
  /** 给人看的名字（界面上「待同步：书架」） */
  label: string;
  /** 用**当前**本地状态重推一遍 */
  resync(): Promise<PushResult>;
}

const targets = new Map<string, SyncTarget>();

export function registerSyncTarget(t: SyncTarget): void {
  targets.set(t.localKey, t);
}

/** 当前打了「待同步」标记的实体（界面的角标用它） */
export function pendingTargets(): SyncTarget[] {
  return [...targets.values()].filter((t) => isPending(t.pendingKey));
}

/**
 * 把所有「待同步」的实体重推一遍（服务端恢复后调用）。
 *
 * **幂等 + 自愈**：底层 `pushDiff`/`reconcile` 都从**当前状态**现算要推什么，
 * 不依赖「上次推失败」的账本；中途某个体失败只影响它自己，返回明细给调用方留痕。
 */
export async function resyncAll(): Promise<Array<{ label: string; ok: boolean; offline: boolean }>> {
  const out: Array<{ label: string; ok: boolean; offline: boolean }> = [];
  for (const t of pendingTargets()) {
    try {
      const r = await t.resync();
      out.push({ label: t.label, ok: r.ok, offline: r.offline });
      if (r.offline) break; // 还是连不上 ⇒ 后面的不用试了
    } catch (e) {
      // 非离线错误照常留痕（不静默兜底），但不要让一个实体拖住其它实体
      console.warn(`[sync] ${t.label} 重传失败：`, e);
      out.push({ label: t.label, ok: false, offline: false });
    }
  }
  return out;
}

/**
 * 「上次已同步到服务端」的快照：`localKey → (主键 → 契约 JSON)`。
 *
 * 用途只有一处 —— {@link pushDiff} 判断「这一条与上次推的**完全一样**吗」。
 * **它不是账本**：内容完全从当前状态派生、丢了最多多推几次（PUT 是幂等 upsert），
 * 所以不需要持久化，也不需要「哪条没推成功」的记录（那是上一版刻意避开的复杂度）。
 */
const snapshots = new Map<string, Map<string, string>>();

/**
 * 「已经与这一端对齐过」的实体（`localKey`）。
 *
 * ⚠️ **闸门，不是优化**：{@link pushDiff} 在**对齐之前**一律不推。
 * 场景：`reader.ts` 启动时有一段**历史数据补算**（早期书架条目没有 `key`）会调 `saveShelf()`，
 * 那发生在 `main.ts` 的 `hydrateX()` **之前**。若那时就把本地全量推上去，
 * 而策略本来是「服务端非空 ⇒ 以服务端为准」⇒ **本地会把服务端覆盖掉**（静默丢数据）。
 * 对齐之后（无论成功、搬迁还是离线）才放行 —— 离线时本地也没有能覆盖的对象。
 */
const pulled = new Set<string>();
const warnedNotPulled = new Set<string>();

function seedSnapshot<T>(p: SyncPlan<T>, items: readonly T[]): void {
  const m = new Map<string, string>();
  for (const it of items) m.set(p.idOf(it), JSON.stringify(p.toRemote(it)));
  snapshots.set(p.localKey, m);
}

/**
 * **全量对齐**：把本地这份推上去，并删掉服务端多出来的。
 *
 * 为什么是「全量」而不是「逐条增量」：
 *  - 数据量小（分组 ≤52 条），一次 GET + N 次 PUT 完全可接受；
 *  - 它**自带自愈**：不需要追踪「哪一条没推成功」，离线期间的增删改在下次启动时自然收敛；
 *  - 避免「增量推送 + 删除标记」那套没人维护的账本。
 *
 * ⚠️ 书架这类「**条数多（可达数百）、写频繁（翻章就写一次）**」的实体**不要用它当写路径**：
 * 每次写都会 `GET + N 次 PUT`（实测一次 reconcile 对 100 本书是 101 个请求）
 * ⇒ 那种场景用 {@link createPusher}（内部走 {@link pushDiff} 增量）。
 */
export async function reconcile<T>(p: SyncPlan<T>, items: readonly T[]): Promise<PushResult> {
  if (!pulled.has(p.localKey)) {
    if (!warnedNotPulled.has(p.localKey)) {
      warnedNotPulled.add(p.localKey);
      console.warn(`[sync] ${p.localKey} 尚未与服务端对齐（hydrate 未跑）⇒ 本次不推送`);
    }
    return { ok: false, offline: false, skipped: true };
  }
  let remote: T[];
  try {
    remote = await p.list();
    const localIds = new Set(items.map((x) => p.idOf(x)));
    for (const it of items) await p.put(p.toRemote(it));
    for (const r of remote) {
      const id = p.idOf(r);
      if (!localIds.has(id)) await p.remove(id);
    }
    seedSnapshot(p, items);
    clearPending(p.pendingKey);
    reportServerReachable(true);
    return { ok: true, offline: false };
  } catch (e) {
    if (isOffline(e)) {
      markPending(p.pendingKey);
      reportServerReachable(false);
      return { ok: false, offline: true };
    }
    throw e; // 非离线错误照常抛 —— 不静默兜底
  }
}

/**
 * **增量推送**：只推「与上次快照不同」的条目，并删掉快照里有、现在没有的（= 已从书架移除的）。
 *
 * 给书架这类「条数多、写频繁」的实体用（见 {@link reconcile} 的对比）。
 * **自愈性**：快照只用来去重 —— 内容全部从**当前状态**现算，与「上次推失败」无关；
 * 离线失败时 `pendingSync` 会被打上，下次启动的 {@link pull} 走全量 `reconcile` 兜底。
 *
 * ⚠️ 快照**逐条推进**（PUT 成功一条才记一条）：中途失败时已成功的不会重推，
 * 而未成功的下次仍会被判为「有变化」⇒ 不会漏推。
 */
export async function pushDiff<T>(p: SyncPlan<T>, items: readonly T[]): Promise<PushResult> {
  if (!pulled.has(p.localKey)) {
    if (!warnedNotPulled.has(p.localKey)) {
      warnedNotPulled.add(p.localKey);
      console.warn(
        `[sync] ${p.localKey} 尚未与服务端对齐（hydrate 未跑）⇒ 本次不推送。` +
          `这是把「启动瞬间的本地写入」与「服务端已有数据」隔开的闸门，见 server-sync.ts 的 pulled 注释`,
      );
    }
    return { ok: false, offline: false, skipped: true };
  }
  const snap = snapshots.get(p.localKey) ?? new Map<string, string>();
  try {
    const cur = new Map<string, string>();
    for (const it of items) cur.set(p.idOf(it), JSON.stringify(p.toRemote(it)));

    for (const [id, json] of cur) {
      if (snap.get(id) === json) continue;
      await p.put(JSON.parse(json) as Record<string, unknown>);
      snap.set(id, json);
    }
    for (const id of [...snap.keys()]) {
      if (cur.has(id)) continue;
      await p.remove(id);
      snap.delete(id);
    }
    snapshots.set(p.localKey, snap);
    clearPending(p.pendingKey);
    reportServerReachable(true);
    return { ok: true, offline: false };
  } catch (e) {
    if (isOffline(e)) {
      markPending(p.pendingKey);
      reportServerReachable(false);
      return { ok: false, offline: true };
    }
    throw e; // 非离线错误照常抛 —— 不静默兜底
  }
}

/**
 * 把「写本地缓存 + 推服务端」包成**一个可反复调用的 kick()**（书架/书签共用）。
 *
 * ## 为什么需要它（不是过度设计）
 * `saveShelf()` 被 12 处调用，其中 `saveProgress`（每翻一章）与 `recordProgress`（播放中节流上报）
 * 是**热路径**。若每次都起一个 `pushDiff`，同一帧内多次写入会并发发同一批请求。
 * 这里做两件事，都很小但必要：
 *  1. **防重入**：同一实体同时只跑一个推送；
 *  2. **合并**：推送期间又来了新写入 ⇒ 跑完再补一轮（用**最新状态**），不会漏。
 *
 * 返回的函数**同步返回、不抛错**（调用方是 `saveXxx()` 这种 void 的地方）。
 * 失败一律 `console.warn` 留痕 —— 静默兜底会让「迁移没生效」看起来像「数据本来就没有」（铁律 3）。
 */
export function createPusher<T>(
  p: SyncPlan<T>,
  getItems: () => readonly T[],
  label: string,
): () => void {
  let busy = false;
  let again = false;
  return function kick(): void {
    if (busy) {
      again = true; // 跑完用最新状态补一轮
      return;
    }
    busy = true;
    void (async () => {
      try {
        do {
          again = false;
          const r = await pushDiff(p, getItems());
          if (r.skipped) break; // 还没 hydrate（pushDiff 已留痕）—— 别再转第二圈
          if (r.offline) {
            console.warn(`[sync] ${label} 已存本地，服务端不可达 ⇒ 标记 pendingSync，下次启动重传`);
            break; // 离线就不要再转第二圈（避免空转刷日志）
          }
        } while (again);
      } catch (e) {
        console.warn(`[sync] ${label} 推送服务端失败（本地已保存，数据未丢）：`, e);
      } finally {
        busy = false;
      }
    })();
  };
}

/**
 * 启动时对齐（策略 1/2 + pendingSync 重传）。
 *
 * 顺序很重要：**先判 pending**（上次没推成功的以本地为准），再判「服务端空 ⇒ 一次性搬迁」，
 * 最后才是「服务端为准」。否则离线期间的修改会被服务端的旧数据覆盖。
 */
export async function pull<T>(
  p: SyncPlan<T>,
  local: readonly T[],
  opts?: { mergeLocal?: boolean },
): Promise<PullResult<T>> {
  // 放行推送闸门（成功/搬迁/离线都算「已尝试对齐」—— 见 `pulled` 的注释）。
  // 离线也放行的理由：否则「离线启动 → 用户改动」会被永久跳过，永远同步不出去。
  pulled.add(p.localKey);
  try {
    const remote = await p.list();

    if (isPending(p.pendingKey)) {
      // 上次推送失败 ⇒ 以本地为准重传（含删掉服务端多出来的）
      await reconcile(p, local);
      return { items: Array.from(local), source: 'resynced' };
    }
    if (remote.length === 0 && local.length > 0) {
      // 一次性搬迁（本地保留，作为缓存）
      for (const it of local) await p.put(p.toRemote(it));
      seedSnapshot(p, local);
      reportServerReachable(true);
      return { items: Array.from(local), source: 'migrated' };
    }
    seedSnapshot(p, remote);
    reportServerReachable(true);
    /**
     * ★ `#191` **合并语义**（默认关闭，各实体 store 显式开启）：
     * 服务端非空时不再「二选一」，而是 `服务端 + 本地独有`（按 `idOf` 主键），
     * 本地独有的**立即补推**。
     *
     * 为什么需要：多端/多 origin（如 `127.0.0.1:3000` 与 `localhost:5173` 各一份 localStorage）
     * 首开时，先上线的端数据会被后上线的端**静默覆盖** —— 用户实测的「导入的字典丢了」就是这条
     * （`#189` 修补）。书架/书签/高亮/分组/净化规则同理：离线新增或一端新增未同步都被清掉。
     *
     * ⚠️ **删除仍走显式流程**：合并只做「加法」。已删条目两端都不在 ⇒ 不会被复活；
     * 真要删必须走 `removeRule`/`removeFromShelf` 这类显式动作（会删服务端）。
     */
    if (opts?.mergeLocal && local.length) {
      const remoteIds = new Set(remote.map((it) => p.idOf(it)));
      const localOnly = local.filter((it) => !remoteIds.has(p.idOf(it)));
      if (localOnly.length) {
        for (const it of localOnly) await p.put(p.toRemote(it));
        seedSnapshot(p, [...remote, ...localOnly]);
        return { items: [...remote, ...localOnly], source: 'migrated' };
      }
    }
    return { items: remote, source: 'server' };
  } catch (e) {
    if (isOffline(e)) {
      /**
       * 离线：连「服务端现在有什么」都不知道 ⇒ **必须清掉快照**（不是留着旧的）。
       * 留着会让下一次 {@link pushDiff} 判成「本地与服务端一致 ⇒ 无变化」而**什么都不推**，
       * 而服务端其实可能一条都没有 —— 那就成了静默的数据丢失。
       * 清掉最坏也只是「多推一遍」（PUT 幂等 upsert）。
       */
      snapshots.delete(p.localKey);
      reportServerReachable(false);
      return { items: null, source: 'offline' };
    }
    throw e;
  }
}

/** 读本地缓存（解析失败按空处理并留痕） */
export function readLocal<T>(localKey: string): T[] {
  try {
    const raw = localStorage.getItem(localKey);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch (e) {
    console.warn(`[sync] 本地缓存 ${localKey} 解析失败，按空处理：`, e);
    return [];
  }
}

/** 写本地缓存 */
export function writeLocal<T>(localKey: string, items: readonly T[]): void {
  try {
    localStorage.setItem(localKey, JSON.stringify(items));
  } catch (e) {
    // 配额满 / 隐私模式：必须留痕（否则「写不进」会表现成「改了没生效」）
    console.warn(`[sync] 本地缓存 ${localKey} 写入失败：`, e);
  }
}

/* ------------------------------------------------------------------ *
 * 阶段 3（`#145`/`#144`）：**单对象**实体的同步（阅读偏好 prefs）
 * ------------------------------------------------------------------ */

/**
 * 单对象实体的同步方案（`prefs` 这类「整体就是一份 JSON」的东西）。
 *
 * ★ 与 {@link SyncPlan} 的**唯一实质差别**：数组端点靠「返回空数组」表达「服务端还没有数据」，
 * 而单对象端点 `GET /api/user/prefs` **总会把契约默认值补齐返回**（`jsonOf(…, emptyGlobalReaderPrefs())`）
 * ⇒ 必须有一个**显式的**「服务端还没存过」判据，就是 {@link SyncObjectPlan.isDefault}。
 * 少了它，「用户从没设置过」与「用户恰好设置成默认值」不可区分，
 * 「服务端为准」会立刻把本地迁移过来的值抹掉。
 */
export interface SyncObjectPlan<T> {
  /** localStorage 缓存键 */
  localKey: string;
  /** 「上次没推上去」标记键 */
  pendingKey: string;
  /** 读服务端 */
  get(): Promise<T>;
  /** 整体写服务端（幂等） */
  set(v: T): Promise<unknown>;
  /** 「服务端那份还是默认值 ⇒ 用户从没存过」。别指望端点返回 null / 404。 */
  isDefault(v: T): boolean;
}

/**
 * 单对象版 {@link pull} —— **判据顺序与语义完全一致**：
 * ① 先判 `pending`（上次没推成功的以本地为准，否则离线期间的修改会被服务端旧值覆盖）；
 * ② 再判「服务端是默认值 ⇒ 一次性搬迁」；
 * ③ 最后才是「服务端为准」。
 *
 * `local === null` 表示本地什么都没有（首次运行），此时「服务端是默认值」就保持默认值。
 */
export async function pullObject<T>(
  p: SyncObjectPlan<T>,
  local: T | null,
): Promise<{ value: T | null; source: SyncSource }> {
  // 与数组版同理：成功 / 搬迁 / 离线都放行推送闸门（否则离线启动后的改动永远推不出去）
  pulled.add(p.localKey);
  try {
    const remote = await p.get();
    if (isPending(p.pendingKey)) {
      if (local !== null) {
        await p.set(local);
        reportServerReachable(true);
        return { value: local, source: 'resynced' };
      }
      reportServerReachable(true);
      return { value: remote, source: 'server' };
    }
    if (p.isDefault(remote) && local !== null) {
      // 一次性搬迁：本地保留作为缓存
      await p.set(local);
      reportServerReachable(true);
      return { value: local, source: 'migrated' };
    }
    reportServerReachable(true);
    return { value: remote, source: 'server' };
  } catch (e) {
    if (isOffline(e)) {
      reportServerReachable(false);
      // `value: null` = 保持本地（调用方自己决定用缓存还是默认值）
      return { value: null, source: 'offline' };
    }
    throw e; // 非离线错误照常抛 —— 不静默兜底
  }
}

/**
 * 单对象版推送。整体一次 `PATCH`/`PUT`，天然幂等 ⇒ 放热路径上也没问题
 * （但仍受 {@link pulled} 闸门约束，理由见那里的注释）。
 */
export async function pushObject<T>(p: SyncObjectPlan<T>, value: T): Promise<PushResult> {
  if (!pulled.has(p.localKey)) {
    if (!warnedNotPulled.has(p.localKey)) {
      warnedNotPulled.add(p.localKey);
      console.warn(`[sync] ${p.localKey} 尚未与服务端对齐（hydrate 未跑）⇒ 本次不推送`);
    }
    return { ok: false, offline: false, skipped: true };
  }
  try {
    await p.set(value);
    clearPending(p.pendingKey);
    reportServerReachable(true);
    return { ok: true, offline: false };
  } catch (e) {
    if (isOffline(e)) {
      markPending(p.pendingKey);
      reportServerReachable(false);
      return { ok: false, offline: true };
    }
    throw e;
  }
}

/** 读单对象本地缓存（解析失败 / 不是对象 ⇒ null 并留痕） */
export function readLocalObject<T>(localKey: string): T | null {
  try {
    const raw = localStorage.getItem(localKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as T;
  } catch (e) {
    console.warn(`[sync] 本地缓存 ${localKey} 解析失败，按「没有」处理：`, e);
    return null;
  }
}

/** 写单对象本地缓存 */
export function writeLocalObject<T>(localKey: string, value: T): void {
  try {
    localStorage.setItem(localKey, JSON.stringify(value));
  } catch (e) {
    console.warn(`[sync] 本地缓存 ${localKey} 写入失败：`, e);
  }
}
