/**
 * 源库落盘层（`#651`）—— 把 `hub` 的内存态与 **唯一** 的 SQLite 源库对起来。
 *
 * 这个文件是 `source-overlay.ts`（旧的 JSON 覆盖层）的**替代品**，方法名保持一一对应，
 * 目的是让 `index.ts` 的改动尽量小、可审查（同一个调用点只换实现，不换语义）。
 *
 * ## 旧实现的两个硬伤（为什么必须换）
 * 1. **两处存储**：文件源 `data/sources/book-482/*.json`（id = 文件名）+ 用户源
 *    `data/imported-sources.json`（id = `deriveId(bookSourceUrl)`）。同一个源可能在两处
 *    各存一份且 id 不同（实测 速读谷 / 📚木里聚合）⇒ 按名字去一处找就会「找不到」。
 * 2. **文件名当身份**：文件名必须 `safeSourceId` 安全化，而安全化是**多对一**的
 *    （`#640` 已因此加指纹补偿）。身份被文件名绑架，是 id 漂移的根。
 *
 * ## 现在的语义
 * · 一行一源：`id`（路由/书架引用的别名）+ `identity`（= `bookSourceUrl`，唯一索引，对齐上游主键）；
 * · 删除 = 整行搬进 `sources_trash`（**raw 一起搬**）⇒ 任何源都可恢复，不再分「文件源/用户源」；
 * · 开关 = 同一行的三个 int 列，不再有「文件源的开关寄存在覆盖层」这种两套映射。
 *
 * @see packages/core/src/source-store/sqlite.ts  存储本体（含上游口径与 2000 源实测）
 */
import type { EngineHub } from '@yuedu/facade';
import type { SourceDb, SourceTrashRow } from '@yuedu/core';

/** `index.ts` 用到的回收站展示结构（字段与旧 overlay 相同，前端不用改） */
export interface TrashItem {
  id: string;
  name?: string;
  kind?: string;
  deletedAt: number;
  /** 恒为 false：数据库里没有「文件还在磁盘」这回事，保留字段只为前端/旧接口兼容 */
  fileBacked: boolean;
  hasRaw: boolean;
}

export interface ApplyResult {
  /** 从库里恢复到 hub 的条数 */
  restored: number;
  /** 库里压根没有、因此「压不住」的条数（旧实现的墓碑概念，这里恒 0，保留字段兼容日志） */
  tombstoned: number;
  failed: number;
  /** 开关回填条数（现在开关与 raw 同行，理论上不再需要单独回填；字段保留给日志） */
  restated: number;
}

export class SourceDbLayer {
  /** 待落盘的 id（`remember` 攒、`persist` 一次事务写） */
  private pending = new Set<string>();

  constructor(
    private readonly db: SourceDb,
    private readonly hub: EngineHub,
  ) {}

  /** 全库条数（诊断/日志用） */
  get size(): number {
    return this.db.count();
  }

  /**
   * 启动装载：把库里每一行 `importSource` 进 hub。
   *
   * ⚠️ 必须在 Cookie 恢复**之前**调用（`#483`：源没注册就先恢复 Cookie ⇒ 静默全丢）。
   * ⚠️ 编译失败的源不能拖垮整个启动：逐条 try，失败计数 + 打名字（铁律 3：兜底必须留痕）。
   */
  apply(): ApplyResult {
    const { rows, broken } = this.db.loadWithStats();
    let restored = 0;
    let failed = 0;
    /** `#652` 装载时纠正过 kind 的行（落盘一次，别每次启动都靠兜底） */
    const retyped: Array<{ id: string; from: string; to: string; name?: string }> = [];
    const failedNames: string[] = [];
    for (const row of rows) {
      try {
        const got = this.hub.importSource(row.raw, {
          id: row.id,
          preferred: row.kind,
          state: row.state,
          ...(row.name ? { name: row.name } : {}),
        });
        restored++;
        /**
         * `#652` **kind 列存错要写回**：`registry.detect` 现在把 `preferred` 当提示（认不出就自动识别），
         * 于是「kind=legado 但 raw 其实是 RSS/CMS」的源能装起来了 —— 但库里那列仍是错的
         * （界面显示错引擎、每次启动都要走一次兜底）。这里按实际识别结果回写，
         * 一条日志说明改了什么（铁律：兜底必须留痕）。
         */
        if (got.kind !== row.kind) {
          this.db.upsert({
            id: row.id,
            identity: row.identity,
            name: row.name,
            kind: got.kind,
            raw: row.raw,
            state: row.state,
            addedAt: row.addedAt,
            updatedAt: Date.now(),
          });
          retyped.push({ id: row.id, from: row.kind, to: got.kind, ...(row.name ? { name: row.name } : {}) });
        }
      } catch (e) {
        failed++;
        if (failedNames.length < 10) failedNames.push(`${row.name ?? row.id}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
      }
    }
    if (retyped.length) {
      console.log(
        `[yuedu] 源库里 ${retyped.length} 条 kind 与内容不符，已按实际识别写回：` +
          retyped.map((r) => `${r.name ?? r.id}(${r.from}→${r.to})`).join('、'),
      );
    }
    if (failed) {
      console.error(`[yuedu] 源库里有 ${failed} 条编译失败，已跳过（不影响其它源）：\n  ` + failedNames.join('\n  '));
    }
    if (broken) {
      console.error(`[yuedu] 源库里有 ${broken} 行 raw 不是合法 JSON，已跳过（可用 scripts/src.mts 查看）`);
    }
    return { restored, tombstoned: 0, failed, restated: 0 };
  }

  /**
   * 记一条改动（**只排队，不写盘**）。
   * 批量导入时调用方会循环 `remember` 再 `persist` ⇒ 一次事务写完（2000 条 ≈ 3.1s）。
   */
  remember(id: string): void {
    if (!this.hub.sources.has(id)) return;
    this.pending.add(id);
  }

  /** 把排队的改动落盘（一个事务）。失败要喊出来 —— 静默失败等于「导出成功但重启就丢」。 */
  persist(): void {
    if (!this.pending.size) return;
    const rows: Array<Parameters<SourceDb['upsert']>[0]> = [];
    for (const id of this.pending) {
      const s = this.hub.sources.get(id);
      if (!s) continue; // 已被删：不写（删除走 forget）
      rows.push({
        id: s.id,
        // identity 交给库里按 raw 现算（`sourceIdentityOf`）——避免这里再造一份判据
        ...(s.name ? { name: s.name } : {}),
        kind: s.kind,
        raw: s.raw,
        state: s.state,
        addedAt: s.addedAt,
        updatedAt: Date.now(),
      });
    }
    this.pending.clear();
    if (!rows.length) return;
    try {
      this.db.upsertMany(rows);
    } catch (e) {
      console.error('[yuedu] 源库落盘失败（改动只在内存，重启会丢）：', e instanceof Error ? e.message : e);
    }
  }

  /** 兼容旧调用：同步 API 下 persist 已经是同步的，「等写完」立刻兑现 */
  whenIdle(): Promise<void> {
    this.persist();
    return Promise.resolve();
  }

  /** 退出前最后刷一次（`index.ts` 的 shutdown 钩子） */
  flushSync(): void {
    this.persist();
  }

  /** 只改开关（不重写 raw：用户拖一下开关不该动 2000 行库） */
  setState(id: string, state: Parameters<SourceDb['setState']>[1]): boolean {
    return this.db.setState(id, state);
  }

  /**
   * 删除 → 进回收站。
   *
   * 调用顺序与旧实现一致：`index.ts` 是**先 `hub.removeSource` 再调这里**，
   * 所以 `snap` 是唯一还能拿到 raw 的来源（hub 里已经没了）。拿不到就退化成
   * 「从库里查一行」——数据库里一定有（除非刚建还没落盘）。
   */
  forget(
    id: string,
    snap?: { kind?: string; name?: string; raw?: unknown; state?: unknown; addedAt?: number },
  ): void {
    const stored = this.db.get(id);
    const raw = stored?.raw ?? snap?.raw;
    if (raw === undefined) {
      // 两边都没有 raw（极端的「刚 import 还没 persist 就删」）⇒ 只能记个 id 进回收站，
      // 但恢复不了。必须留痕，否则用户会以为是静默丢数据。
      console.warn(`[yuedu] 删除源 ${id} 时拿不到 raw，回收站里这条将无法恢复`);
    }
    this.pending.delete(id);
    this.db.moveToTrash({
      id,
      identity: stored?.identity ?? '',
      ...(stored?.name ?? snap?.name ? { name: (stored?.name ?? snap?.name) as string } : {}),
      kind: stored?.kind ?? snap?.kind ?? 'legado',
      raw: raw ?? null,
      addedAt: stored?.addedAt ?? snap?.addedAt ?? Date.now(),
    });
  }

  /** 回收站清单（前端回收站对话框直接吃这个） */
  trashList(): TrashItem[] {
    return this.db.trashList().map((t: SourceTrashRow) => ({
      id: t.id,
      ...(t.name ? { name: t.name } : {}),
      ...(t.kind ? { kind: t.kind } : {}),
      deletedAt: t.deletedAt,
      fileBacked: false,
      hasRaw: true,
    }));
  }

  /** 回收站里的 id（前端用它判断「恢复入口」要不要显示） */
  removedIds(): string[] {
    return this.db.trashList().map((t) => t.id);
  }

  /**
   * 恢复所选（`#269`/`#645` 语义保持：只恢复所选，不是清空）。
   *
   * 恢复动作 = 从回收站搬回 `sources` + 重新 `importSource` 进 hub。
   * 编译不过（raw 被改坏）⇒ 搬回回收站，不让用户白白丢一条。
   */
  restoreSome(ids: readonly string[]): number {
    let n = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      const t = this.db.trashGet(id);
      if (!t) continue;
      try {
        this.hub.importSource(t.raw, {
          id: t.id,
          preferred: t.kind,
          ...(t.name ? { name: t.name } : {}),
        });
      } catch (e) {
        console.error('[yuedu] 回收站恢复失败（编译不过，留在回收站）：', t.name ?? t.id, e instanceof Error ? e.message : e);
        continue;
      }
      /**
       * 只 `dropTrash` 不 `upsert`：`importSource` 之后这一行要**重新落盘**，
       * 直接交给 `remember` + `persist`（同一次改动只写一遍）。
       */
      this.db.dropTrash(id);
      this.remember(id);
      n++;
    }
    if (n) this.persist();
    return n;
  }

  /** 恢复全部（旧接口 `clear-removed` 的语义） */
  clearRemoved(): number {
    return this.restoreSome(this.removedIds());
  }

  /**
   * 永久删除：从回收站丢掉。
   * 与旧实现的差别：旧版对「文件源」只记墓碑、**文件不删**；现在没有文件了 ⇒ 一律真删。
   */
  purgeSome(ids: readonly string[]): number {
    let n = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue;
      if (this.db.dropTrash(id)) n++;
    }
    return n;
  }

  /** 直接暴露底层库（迁移脚本/诊断用） */
  get raw(): SourceDb {
    return this.db;
  }
}
