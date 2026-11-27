/**
 * 源库存储（`#651`）—— **运行时唯一的源存储**，对齐 legado 上游。
 *
 * ## 为什么要这个模块（用户 2026-10-27 定案）
 * 此前源分散在**两个地方**，两者都在启动时被加载进同一个内存 hub：
 *  · `data/sources/book-482/*.json`（484 个，1 源 1 文件）——id 就是**文件名**；
 *  · `data/imported-sources.json`（265 条，覆盖层）——id 是 `deriveId(bookSourceUrl)`。
 *
 * 后果（实测，非推测）：749 条里只有 747 个唯一 `bookSourceUrl` —— 有 **2 个源在两地
 * 各存一份、id 还不一样**（速读谷 `https___www.shudugu.org` vs `…www.shudugu.org_`；
 * 📚木里聚合 90 个下划线 vs 118 个下划线 + 导入时间戳）。
 * 用户的原话是「我告诉你源名称，你却找不到源文件/源规则」——
 * 因为同一个源可能只存在于我没去翻的那一处。
 *
 * ## 上游口径（`F:\legado`，逐条对照）
 * · 唯一存储：Room/SQLite 表 `book_sources`（`BookSource.kt:29` `@Entity(tableName="book_sources")`）；
 * · 唯一标识：**`bookSourceUrl` 直接作主键**（`BookSource.kt:33-35` `@PrimaryKey`），不做任何安全化；
 * · 去重：`@Insert(onConflict = REPLACE)`（`BookSourceDao.kt:276`）⇒ 主键相同即覆盖；
 * · 删除：`delete from book_sources where bookSourceUrl = :key`（`BookSourceDao.kt:347`）；
 * · 导出/备份：**单个 JSON 数组** `bookSource.json`（`Backup.kt:286`）；
 * · `book_sources_part` 是 `@DatabaseView` 视图（`BookSourcePart.kt:11`），**不是第二份存储**。
 * ⇒ 上游**根本没有「源文件」概念**：没有目录、没有 1 源 1 文件、没有「文件名即 id」。
 *
 * ## 本模块的三条设计决定
 * 1. **`identity` 列（= `bookSourceUrl`/`sourceUrl`/`apiUrl` 去空白）唯一索引** —— 与上游主键同义。
 *    唯一性由数据库强制，不再靠「字符串安全化后不撞」这种概率保证。
 * 2. **`id` 只是路由别名**：沿用历史值（书架 `books.origin`、cookies、置顶名单全都引用它，
 *    换掉就要连带迁移四张表），但**不再由文件名派生**，因此不会再漂移。
 * 3. **同表存开关状态**：`enabled / search_enabled / explore_enabled` 三列。
 *    旧实现里文件源的开关只能寄存在覆盖层 `states` 里（raw 里通常没有这些字段），
 *    多一套映射就多一处能对不上的地方。
 *
 * ## 2000 源实测（`tmp/bench-store.mjs`，单源均 12.8KB / 共 25.1MB）
 * | 操作 | 单文件 JSON | 1 源 1 文件 | 本模块（SQLite） |
 * |---|---|---|---|
 * | 首建全量 | 638ms | 14584ms | 3151ms |
 * | 启动读全量 | 559ms | 4872ms | **410ms** |
 * | 改 1 源 | 1123ms（全量重写） | 9ms | **40ms** |
 * | 按名找 1 源 | 559ms（只能全读） | 3405ms | **24ms** |
 * | 落盘体积 | 27.3MB | — | 28.4MB |
 *
 * ## 复用与边界
 * · 复用 `data/yuedu.db`（`node:sqlite`，已有 `user-store/sqlite.ts` 在用）——不新增依赖、单一数据文件；
 * · **不碰 `PRAGMA user_version`**（那是 user-store 的版本号，它 `version > SCHEMA_VERSION` 就拒绝启动）。
 *   本模块的版本记在自己的 `source_meta` 表里，两套迁移互不干扰；
 * · 读 TEXT 的 NUL 截断：`raw` 是 `JSON.stringify` 的产物，NUL 会被转义成 `\u0000` 六个字符，
 *   落库文本里**没有真正的 0x00**，所以不受该缺陷影响。坏行（JSON.parse 失败）跳过并计入 `broken`，
 *   不阻断整库加载（与 `loadDir` 的「坏文件跳过」同口径）。
 */

/** 本模块自己维护的 schema 版本（**不是** `PRAGMA user_version`，见文件头「复用与边界」） */
export const SOURCE_STORE_SCHEMA_VERSION = 1;

/**
 * 源身份（唯一标识）—— 与 `facade/source-store.ts` 的 `sourceIdentity` **同一判据**。
 *
 * 为什么不共用一份实现：本文件在 `core`，facade 反向依赖 core ⇒ 只能 core 出实现。
 * 现在由 `facade` 转调这里（`sourceIdentity` 已改为 re-export），全域只有这一份。
 */
export function sourceIdentityOf(raw: unknown): string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const v = r['bookSourceUrl'] ?? r['sourceUrl'] ?? r['apiUrl'];
  return typeof v === 'string' ? v.trim() : '';
}

/** 一行的开关状态（存 3 个 INTEGER，读回成对象） */
export interface SourceDbState {
  enabled: boolean;
  searchEnabled: boolean;
  exploreEnabled: boolean;
}

/** 一条源（`raw` 已解析） */
export interface SourceRow {
  id: string;
  /** 唯一标识 = bookSourceUrl（去空白）。空串表示「这个源没有身份字段」（历史坏数据，仍允许存在） */
  identity: string;
  name?: string;
  kind: string;
  raw: unknown;
  state: SourceDbState;
  addedAt: number;
  updatedAt: number;
  customOrder: number;
}

/** 回收站条目：**一定带 `raw`**（数据库里没有「文件还在磁盘」这回事了） */
export interface SourceTrashRow {
  id: string;
  identity: string;
  name?: string;
  kind: string;
  raw: unknown;
  deletedAt: number;
  addedAt: number;
}

export interface SourceDbOpenResult {
  db: SourceDb;
  /** 打开时的告警（库版本过新 / 坏行数），调用方决定怎么喊 */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 最小化 SQL 接口（不把 node:sqlite 的类型泄漏到公开签名）
 * ------------------------------------------------------------------ */

interface SqlStatement {
  run(...args: unknown[]): { changes: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown;
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { enableForeignKeyConstraints?: boolean; readOnly?: boolean }) => SqlDatabase;
}

/**
 * 同步取 `node:sqlite`。
 *
 * 为什么不用 `await import('node:sqlite')`（user-store 是那样写的）：本模块的调用方
 * （`hub.apply()` 启动装载、CLI 的单条查询）都是同步路径，为了一个 import 把整条链改成
 * async 不值当。`process.getBuiltinModule` 是 Node ≥22.3 的内置同步入口，且 esbuild 不会
 * 动它（不产生 import 语句 ⇒ 打包后仍然可用）。
 */
function loadSqlite(): SqliteModule {
  const g = process as unknown as { getBuiltinModule?: (id: string) => unknown };
  const mod = typeof g.getBuiltinModule === 'function' ? (g.getBuiltinModule('node:sqlite') as SqliteModule | undefined) : undefined;
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    throw new Error('当前 Node 不支持 node:sqlite（需 ≥22.5）；源库已改存 SQLite，请升级 Node');
  }
  return mod;
}

const SQL = {
  createSources: `CREATE TABLE IF NOT EXISTS sources (
    id             TEXT PRIMARY KEY,
    identity       TEXT NOT NULL DEFAULT '',
    name           TEXT,
    kind           TEXT NOT NULL DEFAULT 'legado',
    raw            TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    search_enabled INTEGER NOT NULL DEFAULT 1,
    explore_enabled INTEGER NOT NULL DEFAULT 1,
    custom_order   INTEGER NOT NULL DEFAULT 0,
    added_at       INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL DEFAULT 0
  )`,
  /**
   * `identity` 唯一索引。
   *
   * ⚠️ **不能**写成 `identity TEXT UNIQUE`：SQLite 的 UNIQUE 允许多个 NULL，但这里是 `''`，
   * 而历史数据里确实有**没有身份字段**的源（RSS/CMS 之外的实验源）⇒ 用**部分索引**
   * （`WHERE identity <> ''`）只约束「有身份的」，空身份的行各留各的，不互相顶掉。
   */
  createIdentityIndex: `CREATE UNIQUE INDEX IF NOT EXISTS ux_sources_identity
    ON sources(identity) WHERE identity <> ''`,
  createNameIndex: 'CREATE INDEX IF NOT EXISTS ix_sources_name ON sources(name)',
  createTrash: `CREATE TABLE IF NOT EXISTS sources_trash (
    id         TEXT PRIMARY KEY,
    identity   TEXT NOT NULL DEFAULT '',
    name       TEXT,
    kind       TEXT NOT NULL DEFAULT 'legado',
    raw        TEXT NOT NULL,
    deleted_at INTEGER NOT NULL DEFAULT 0,
    added_at   INTEGER NOT NULL DEFAULT 0
  )`,
  createMeta: 'CREATE TABLE IF NOT EXISTS source_meta (key TEXT PRIMARY KEY, value TEXT)',
  getMeta: 'SELECT value FROM source_meta WHERE key = ?',
  setMeta: 'INSERT INTO source_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',

  allSources: `SELECT id, identity, name, kind, raw, enabled, search_enabled, explore_enabled,
      custom_order, added_at, updated_at FROM sources ORDER BY custom_order ASC, id ASC`,
  getById: `SELECT id, identity, name, kind, raw, enabled, search_enabled, explore_enabled,
      custom_order, added_at, updated_at FROM sources WHERE id = ?`,
  getByIdentity: `SELECT id, identity, name, kind, raw, enabled, search_enabled, explore_enabled,
      custom_order, added_at, updated_at FROM sources WHERE identity = ?`,
  count: 'SELECT count(*) AS c FROM sources',

  /**
   * 写入（**不是** `INSERT OR REPLACE`）。
   *
   * 为什么：REPLACE = 「删掉冲突行再插入」。本表现在没有子表，删了也不会级联，
   * 但这个习惯在 `user-store/sqlite.ts` 里已经踩过一次（`books` 有 `ON DELETE CASCADE`
   * ⇒ 每次刷新书籍都清空目录）。全仓统一用 `ON CONFLICT ... DO UPDATE`，少一类隐患。
   *
   * 冲突键选 `id`（主键）：`id` 是路由与书架引用的锚点。`identity` 若撞了**另一个 id**，
   * 说明「同一个源被导成了两条」——那属于调用方该先合并的事，这里让它**报错**而不是静默覆盖
   * （静默覆盖会悄悄改掉用户的书架关联）。
   */
  upsert: `INSERT INTO sources(id, identity, name, kind, raw, enabled, search_enabled, explore_enabled,
      custom_order, added_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      identity = excluded.identity, name = excluded.name, kind = excluded.kind, raw = excluded.raw,
      enabled = excluded.enabled, search_enabled = excluded.search_enabled,
      explore_enabled = excluded.explore_enabled, custom_order = excluded.custom_order,
      updated_at = excluded.updated_at`,
  setState: `UPDATE sources SET enabled = ?, search_enabled = ?, explore_enabled = ?, updated_at = ?
    WHERE id = ?`,
  remove: 'DELETE FROM sources WHERE id = ?',
  renameIdentity: 'UPDATE sources SET identity = ? WHERE id = ?',

  allTrash: `SELECT id, identity, name, kind, raw, deleted_at, added_at FROM sources_trash
    ORDER BY deleted_at DESC`,
  putTrash: `INSERT INTO sources_trash(id, identity, name, kind, raw, deleted_at, added_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET identity = excluded.identity, name = excluded.name,
      kind = excluded.kind, raw = excluded.raw, deleted_at = excluded.deleted_at,
      added_at = excluded.added_at`,
  delTrash: 'DELETE FROM sources_trash WHERE id = ?',
};

/** 库里的行形状（snake_case） */
interface RawRow {
  id: string;
  identity: string;
  name: string | null;
  kind: string;
  raw: string;
  enabled: number;
  search_enabled: number;
  explore_enabled: number;
  custom_order: number;
  added_at: number;
  updated_at: number;
}

/**
 * 从 raw 里取展示名（与 `hub.importSource` 的优先级同序：`bookSourceName` → `sourceName` → `name`）。
 *
 * 为什么库层也要取一次：`name` 是**独立列**（按名字查用得上索引），调用方没传又不能空着 ——
 * 空名字会让 `src.mts find <名字>` 直接找不到，正是用户报的那个问题。
 */
function nameOfRaw(raw: unknown): string | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  const v = r['bookSourceName'] ?? r['sourceName'] ?? r['name'];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function toRow(r: RawRow): SourceRow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(r.raw);
  } catch {
    return null; // 坏行：跳过（调用方计入 broken）
  }
  return {
    id: r.id,
    identity: r.identity ?? '',
    ...(r.name != null ? { name: r.name } : {}),
    kind: r.kind || 'legado',
    raw,
    state: {
      enabled: r.enabled !== 0,
      searchEnabled: r.search_enabled !== 0,
      exploreEnabled: r.explore_enabled !== 0,
    },
    customOrder: Number(r.custom_order ?? 0),
    addedAt: Number(r.added_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

function stateColumns(s: SourceDbState | undefined): [number, number, number] {
  return [s?.enabled === false ? 0 : 1, s?.searchEnabled === false ? 0 : 1, s?.exploreEnabled === false ? 0 : 1];
}

/**
 * 源库（同步 API）。
 *
 * 用法（server 启动一次、CLI 每次打开一次）：
 * ```ts
 * const { db, warnings } = SourceDb.open({ file: join(DATA_DIR, 'yuedu.db') });
 * for (const row of db.all()) hub.importSource(row.raw, { id: row.id, state: row.state });
 * db.upsert({ ...row, raw: edited });   // 改动即时落库（单行 40ms / 2000 行库）
 * db.close();
 * ```
 */
export class SourceDb {
  private constructor(
    private readonly conn: SqlDatabase,
    readonly file: string,
  ) {}

  static open(opts: { file: string; create?: boolean }): SourceDbOpenResult {
    const { DatabaseSync } = loadSqlite();
    const conn = new DatabaseSync(opts.file);
    // WAL：读写不互斥（user-store 也用这个；同一文件两个连接是正常用法）
    conn.exec('PRAGMA journal_mode = WAL');
    /**
     * `#757` E：`synchronous=NORMAL`（与 user-store 的既定选择一致）。
     *
     * 实测（`data/yuedu.db` 副本、F 盘、100 次单行 UPDATE）：
     * 默认 `FULL` p50 **17.1ms** / p90 25.7ms（每次提交都 fsync WAL）；`NORMAL` p50 **0.31ms**。
     * 源开关/编辑/巡检收尾都是「一次点击 = 一次提交」⇒ FULL 下每点一下主线程就停 17ms。
     *
     * 耐久性取舍（WAL + NORMAL 的标准语义）：**进程崩溃不丢已提交事务**；只有 OS 崩溃/断电
     * 可能丢最后一个事务（WAL 已写但 fsync 未完成）。本仓已用 `stopFile`/WAL 承担进程级恢复，
     * 且用户级数据（书架/进度）走 user-store 同为 NORMAL —— 这里与它对齐，不再让源库单独更严格。
     */
    conn.exec('PRAGMA synchronous = NORMAL');
    conn.exec('PRAGMA busy_timeout = 5000');
    conn.exec(SQL.createSources);
    conn.exec(SQL.createIdentityIndex);
    conn.exec(SQL.createNameIndex);
    conn.exec(SQL.createTrash);
    conn.exec(SQL.createMeta);

    const db = new SourceDb(conn, opts.file);
    const warnings: string[] = [];
    const got = conn.prepare(SQL.getMeta).get('schema_version') as { value?: string } | undefined;
    const version = got?.value ? Number(got.value) : 0;
    if (version > SOURCE_STORE_SCHEMA_VERSION) {
      warnings.push(
        `源库 schema 版本 ${version} 比本代码支持的 ${SOURCE_STORE_SCHEMA_VERSION} 新（用新版开过库）。` +
          `继续读写可能丢字段，请升级应用。`,
      );
    } else if (version < SOURCE_STORE_SCHEMA_VERSION) {
      conn.prepare(SQL.setMeta).run('schema_version', String(SOURCE_STORE_SCHEMA_VERSION));
    }
    return { db, warnings };
  }

  /**
   * `#746` **只读打开**（B1 批处理子进程专用）。
   *
   * 与 {@link open} 的差别只有一条：**不写库**。
   * `open()` 会建表、写 `schema_version`、设 `journal_mode=WAL` —— 这些都是写操作，
   * 而 B1 的约定是「子进程只读、结果经 IPC 交回主进程写」（单写者）。
   * `busy_timeout` 是连接级 PRAGMA（不落盘），保留以保证与主进程同时读时不立即报锁。
   */
  static openReadOnly(file: string): SourceDbOpenResult {
    const { DatabaseSync } = loadSqlite();
    const conn = new DatabaseSync(file, { readOnly: true });
    conn.exec('PRAGMA busy_timeout = 5000');
    return { db: new SourceDb(conn, file), warnings: [] };
  }

  /* ---------------- 读 ---------------- */

  /**
   * `#757` E 连接级 PRAGMA 读数（**只读诊断**，给 `/api/diag` 与回归锁用）。
   * `synchronous` 是连接级设置，从外部另开连接查不到本连接的取值 ⇒ 必须由本实例报。
   */
  pragma(name: 'journal_mode' | 'synchronous' | 'busy_timeout'): string {
    const row = this.conn.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return String(row?.[name] ?? '');
  }

  /** 全量读（启动装载 / 导出）。坏行跳过（调用方用 {@link loadWithStats} 拿计数） */
  all(): SourceRow[] {
    return this.loadWithStats().rows;
  }

  /** 全量读 + 坏行计数（`#651`：坏行必须能被看见，不能静默少几条） */
  loadWithStats(): { rows: SourceRow[]; broken: number } {
    const rows: SourceRow[] = [];
    let broken = 0;
    for (const r of this.conn.prepare(SQL.allSources).all() as RawRow[]) {
      const row = toRow(r);
      if (row) rows.push(row);
      else broken++;
    }
    return { rows, broken };
  }

  get(id: string): SourceRow | undefined {
    const r = this.conn.prepare(SQL.getById).get(id) as RawRow | undefined;
    return r ? (toRow(r) ?? undefined) : undefined;
  }

  /** 按唯一标识取（同一 `bookSourceUrl` 理论上一行；历史多行时取第一行并留痕由调用方处理） */
  getByIdentity(identity: string): SourceRow | undefined {
    if (!identity) return undefined;
    const r = this.conn.prepare(SQL.getByIdentity).get(identity) as RawRow | undefined;
    return r ? (toRow(r) ?? undefined) : undefined;
  }

  count(): number {
    const r = this.conn.prepare(SQL.count).get() as { c: number | bigint };
    return Number(r.c);
  }

  /**
   * **统一查找**（人和 agent 都走这里）：
   *  ① 精确 `id` → ② 精确 `identity` → ③ 名字**包含**（不区分大小写的子串）
   *  ④ 都没有再按 `identity` 子串兜一次（用户可能只记得域名）。
   *
   * 为什么按名字还要兜 identity：用户的说法常常是「那个 xxx 站点」，而 `bookSourceName`
   * 可能叫「📚木里聚合s.11.20[公益正式]」——只按名字找会漏。
   */
  find(q: string): SourceRow[] {
    const key = String(q ?? '').trim();
    if (!key) return [];
    const all = this.all();
    const exact: SourceRow[] = [];
    const byName: SourceRow[] = [];
    const byIdentity: SourceRow[] = [];
    const lower = key.toLowerCase();
    for (const r of all) {
      if (r.id === key) exact.push(r);
      else if (r.identity === key) exact.push(r);
      else if (String(r.name ?? '').toLowerCase().includes(lower)) byName.push(r);
      else if (r.identity && r.identity.toLowerCase().includes(lower)) byIdentity.push(r);
    }
    return [...exact, ...byName, ...byIdentity];
  }

  /* ---------------- 写 ---------------- */

  /**
   * 写入/更新一行。
   * @throws 当**另一个 id** 已占用同一个 `identity` 时抛错（见 {@link SQL.upsert} 注释）。
   */
  upsert(row: {
    id: string;
    identity?: string;
    name?: string;
    kind?: string;
    raw: unknown;
    state?: SourceDbState;
    customOrder?: number;
    addedAt?: number;
    updatedAt?: number;
  }): void {
    const identity = row.identity || sourceIdentityOf(row.raw);
    if (identity) {
      const holder = this.getByIdentity(identity);
      if (holder && holder.id !== row.id) {
        throw new Error(
          `源身份冲突：'${identity}' 已由 id=${holder.id}（${holder.name ?? '未命名'}）占用，` +
            `不能再用 id=${row.id} 存第二份。请先合并（同一 bookSourceUrl 只允许一条）。`,
        );
      }
    }
    const now = Date.now();
    const [e, s, x] = stateColumns(row.state);
    this.conn
      .prepare(SQL.upsert)
      .run(
        row.id,
        identity,
        row.name ?? nameOfRaw(row.raw) ?? null,
        row.kind ?? 'legado',
        JSON.stringify(row.raw ?? null),
        e,
        s,
        x,
        row.customOrder ?? 0,
        row.addedAt || now,
        row.updatedAt || now,
      );
  }

  /** 批量写入（**一个事务**，2000 条 ≈ 3.1s；单条 upsert 40ms/2000 库） */
  upsertMany(rows: Parameters<SourceDb['upsert']>[0][]): number {
    const stmt = this.conn.prepare(SQL.upsert);
    let n = 0;
    this.conn.exec('BEGIN');
    try {
      for (const row of rows) {
        const identity = row.identity || sourceIdentityOf(row.raw);
        const [e, s, x] = stateColumns(row.state);
        const now = Date.now();
        stmt.run(
          row.id,
          identity,
          row.name ?? nameOfRaw(row.raw) ?? null,
          row.kind ?? 'legado',
          JSON.stringify(row.raw ?? null),
          e,
          s,
          x,
          row.customOrder ?? 0,
          row.addedAt || now,
          row.updatedAt || now,
        );
        n++;
      }
      this.conn.exec('COMMIT');
    } catch (e) {
      this.conn.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  /** 只改开关（不碰 raw —— 用户拖一下开关不该重写 25MB） */
  setState(id: string, st: Partial<SourceDbState>): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    const merged: SourceDbState = { ...cur.state, ...st };
    const [e, s, x] = stateColumns(merged);
    const r = this.conn.prepare(SQL.setState).run(e, s, x, Date.now(), id);
    return Number(r.changes) > 0;
  }

  remove(id: string): boolean {
    const r = this.conn.prepare(SQL.remove).run(id);
    return Number(r.changes) > 0;
  }

  /**
   * 修一条身份（`identity`）。
   *
   * 用途：历史数据里同一源两行、其中一行身份为空或写错（例如手改过 `bookSourceUrl`），
   * 迁移/修复脚本要把它对齐到正确身份上。
   */
  setIdentity(id: string, identity: string): void {
    const holder = this.getByIdentity(identity);
    if (holder && holder.id !== id) {
      throw new Error(`源身份冲突：'${identity}' 已被 id=${holder.id} 占用`);
    }
    this.conn.prepare(SQL.renameIdentity).run(identity, id);
  }

  /* ---------------- 回收站 ---------------- */

  trashList(): SourceTrashRow[] {
    const out: SourceTrashRow[] = [];
    for (const r of this.conn.prepare(SQL.allTrash).all() as Array<{
      id: string; identity: string; name: string | null; kind: string; raw: string;
      deleted_at: number; added_at: number;
    }>) {
      let raw: unknown;
      try {
        raw = JSON.parse(r.raw);
      } catch {
        continue;
      }
      out.push({
        id: r.id,
        identity: r.identity ?? '',
        ...(r.name != null ? { name: r.name } : {}),
        kind: r.kind || 'legado',
        raw,
        deletedAt: Number(r.deleted_at ?? 0),
        addedAt: Number(r.added_at ?? 0),
      });
    }
    return out;
  }

  /** 删除 → 进回收站（**整行 raw 一起存**，所以永远可恢复） */
  moveToTrash(row: SourceRow | { id: string; identity?: string; name?: string; kind?: string; raw: unknown; addedAt?: number }): void {
    const stmt = this.conn.prepare(SQL.putTrash);
    stmt.run(
      row.id,
      ('identity' in row ? row.identity : undefined) || sourceIdentityOf(row.raw) || '',
      row.name ?? nameOfRaw(row.raw) ?? null,
      row.kind ?? 'legado',
      JSON.stringify(row.raw ?? null),
      Date.now(),
      ('addedAt' in row ? row.addedAt : undefined) ?? Date.now(),
    );
    this.remove(row.id);
  }

  /** 从回收站取一条（不含删除动作，供恢复用） */
  trashGet(id: string): SourceTrashRow | undefined {
    return this.trashList().find((t) => t.id === id);
  }

  /**
   * 直接往回收站写一条（**不移除 `sources` 里的同 id 行**）。
   *
   * 用途只有一个：迁移脚本把旧覆盖层的 `trash` / `removed`（历史墓碑）搬进来。
   * 运行期的「删除」必须走 {@link moveToTrash}（它会连带删掉正表那一行）。
   */
  addTrash(row: {
    id: string;
    identity?: string;
    name?: string;
    kind?: string;
    raw: unknown;
    deletedAt?: number;
    addedAt?: number;
  }): void {
    this.conn
      .prepare(SQL.putTrash)
      .run(
        row.id,
        row.identity || sourceIdentityOf(row.raw),
        row.name ?? nameOfRaw(row.raw) ?? null,
        row.kind ?? 'legado',
        JSON.stringify(row.raw ?? null),
        row.deletedAt ?? Date.now(),
        row.addedAt ?? Date.now(),
      );
  }

  /** 回收站里移除（恢复或永久删除都走它） */
  dropTrash(id: string): boolean {
    const r = this.conn.prepare(SQL.delTrash).run(id);
    return Number(r.changes) > 0;
  }

  /** 清空回收站（永久删除全部）—— CLI `empty-trash` 用 */
  purgeAll(): number {
    let n = 0;
    for (const t of this.trashList()) if (this.dropTrash(t.id)) n++;
    return n;
  }

  /* ---------------- 导出 / 导入（Legado JSON 数组） ---------------- */

  /** 导出为 Legado 兼容 JSON（**数组**，与上游 `Backup.kt` 的 `bookSource.json` 同形） */
  exportJson(ids?: readonly string[]): string {
    const want = ids && ids.length ? new Set(ids) : undefined;
    const rows = this.all().filter((r) => !want || want.has(r.id));
    return JSON.stringify(rows.map((r) => r.raw), null, 1);
  }

  close(): void {
    try {
      this.conn.close();
    } catch {
      /* 已关或锁住：忽略 */
    }
  }
}
