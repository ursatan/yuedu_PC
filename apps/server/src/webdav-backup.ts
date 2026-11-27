/**
 * `#208` ④ **整库备份 / 恢复**（WebDAV 版）—— 对齐上游
 * `AppWebDav.kt` 的 `backUpWebDav()` / `getBackupNames()` / `restoreWebDav()` / `lastBackUp()`
 * 与 `Backup.kt` 的备份文件命名。
 *
 * ## 上游语义（逐条）
 * - 备份文件名 = `backup${yyyy-MM-dd}.zip`（带设备名时是 `backup${yyyy-MM-dd}-${deviceName}.zip`，
 *   见 `Backup.kt:123-129`）⇒ **判「是不是备份」靠前缀 `backup`**（`getBackupNames` 就是这么筛的）。
 * - 备份放在**根目录**（不是子目录）：`putUrl = rootWebDavUrl + fileName`。
 * - 恢复 = 下载 zip → 解压到 backup 目录 → `Restore.restoreLocked()`。
 *
 * ## 本仓的形态（**`D6`=A**）
 * 上游备份的是一堆分实体的 json；本仓已经有**一份完整快照**（`#201` 的 `/api/user/snapshot`，
 * 组装逻辑在 `user-snapshot.ts`）⇒ 备份 = **快照 json 打成一个条目的 zip**，
 * 恢复 = 解出那份 json → `importSnapshot(store, body, { overwrite: true })`。
 *
 * ★★ **恢复默认走非累加管线**（`importSnapshot` 的 `overwrite: true`）：
 * 累加型 API 不能用于「恢复备份」—— 那样只会把旧的记录再插一遍，删掉的东西回不来。
 * `B7` ③ 起用户可选「合并」：`overwrite: false` ⇒ 只补缺失、不覆盖现有（跨设备合并用），
 * 但仍不删除本机多出来的记录。两种模式都在确认框里写明后果。
 *
 * ## 为什么恢复要 `confirm=1`
 * 恢复是**破坏性**操作（会覆盖同名主键的数据）。一个误触的 POST 不该把书架改写，
 * 所以端点要求显式带 `confirm=1`；这里也把「先备份当前」的动作留给上层决定（不自动做，
 * 自动做会在用户没预期时多占网盘空间并拖慢恢复）。
 *
 * ## `#621` 起：备份带「可勾选内容 + 口令」
 * 打包/解密全部收拢到 `./backup-build.ts`（勾选项语义、AES 参数、`included` 兼容都在那里，
 * 见该文件头注）。本文件只负责三件事：**取网盘客户端 / 命名 / 把结果转成 HTTP 可说的形状**。
 * 恢复时：
 * - 快照按备份声明的 `included` 裁剪后再 `importSnapshot`（不声明的字段绝不动）
 * - Cookie / 源变量解出来后经注入的回调写回（`hub` 在服务端，这里不直接依赖它）
 */

import { importSnapshot, type ImportResult } from '@yuedu/core';
import { WebDavClient, type WebDavHttp } from '@yuedu/facade';
import type { UserDataStore } from '@yuedu/core';
import { clampBackupKeep, type WebDavConfigStore } from './webdav-sync';
import {
  SNAPSHOT_ENTRY,
  buildBackup,
  defaultBackupOptions,
  filterSnapshotByIncluded,
  readBackupArchive,
  type BackupOptionId,
  type BuildBackupResult,
  type SensitiveProviders,
} from './backup-build';

/**
 * zip 里的快照条目名（`#621` 起由 `backup-build.SNAPSHOT_ENTRY` 定义，这里只是别名 ——
 * 旧调用方/旧测试仍在用这个名字）。
 */
export const BACKUP_ENTRY_NAME = SNAPSHOT_ENTRY;

/** 上游：`backup${yyyy-MM-dd}.zip`（本地日期，不是 UTC —— 用户按本地日历找备份） */
export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `backup${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

/** 是不是备份文件（上游判据：`name.startsWith("backup")`） */
export function isBackupName(name: string): boolean {
  return name.startsWith('backup');
}

export interface BackupItem {
  name: string;
  size: number;
  lastModify: number;
}

export interface BackupResult {
  fileName: string;
  /** zip 字节数 */
  bytes: number;
  /** 快照里的书数（便于界面核对「备份了多少」） */
  books: number;
  /** `#621`：实际勾选的内容（界面回显「这份备份带了什么」） */
  included: BackupOptionId[];
  /** `#621`：zip 里的条目（含加密标记） */
  entries: BuildBackupResult['entries'];
  /** `#621`：勾了但本机没数据的敏感项（必须告诉用户，别以为登录态备份上了） */
  skippedSensitive: BuildBackupResult['skippedSensitive'];
}

export interface RestoreResult {
  fileName: string;
  /**
   * `importSnapshot` 的逐实体计数（契约 `ImportResult`：`books/chapters/…` 各含
   * `added/updated/kept/skipped` + `prefs` 的策略）。界面据此显示「写入了多少」。
   */
  counts: ImportResult;
  /** `#621`：这份备份声明带了哪些内容（未声明的字段本次**未改动**） */
  included: BackupOptionId[];
  /** 这份备份是旧格式（`#208` ④，无 `included`） */
  legacy: boolean;
  /** 写回的 Cookie 条数 / 源变量条数（调用方没注入回调时为 0 且 `warnings` 里有说明） */
  cookiesRestored: number;
  sourceVariablesRestored: number;
  /** 恢复过程中的非致命提示（例如「备份带 Cookie 但当前宿主没注入写回能力」） */
  warnings: string[];
}

/** 恢复时可注入的「写回能力」（`hub` 在服务端；本模块不直接依赖它，单测才好写） */
export interface RestoreDeps {
  http?: WebDavHttp;
  /** 写回某源的 Cookie（`hub.setSourceCookies`）；返回 false = 该源未注册 */
  setCookies?: (sourceId: string, cookie: string) => boolean;
  /** 写回某源的变量（`hub.setSourceVariable`） */
  setSourceVariable?: (sourceId: string, value: string) => boolean;
}

function clientOf(store: WebDavConfigStore, http?: WebDavHttp): WebDavClient {
  const cfg = store.getConfig();
  if (!cfg) throw new Error('WebDAV 还没配置（先填账号密码并点「测试」）');
  return new WebDavClient(cfg, http ? { http } : {});
}

export interface BackupBuildOptions extends SensitiveProviders {
  /** `#621` 勾选内容；不传 ⇒ 默认勾选（见 `backup-build.defaultBackupOptions`） */
  options?: readonly string[] | null;
  /** 备份口令（只有勾了 Cookie/源变量才需要） */
  password?: string | null;
  /** `#208` ④ 的旧参数：等价于在 options 里加上 `chapters` */
  includeChapters?: boolean;
  /** 固定时间（测试用；同时决定 zip 时间戳与文件名日期） */
  now?: number;
}

/**
 * 造一份备份 zip（不上传 —— 纯产物，便于单测与「先看看多大」）。
 *
 * `#621` 起委托给 `backup-build.buildBackup`：勾选项裁剪、AES、条目布局全在那里，
 * 这里只做「旧参数 `includeChapters` → 新勾选项」的兼容翻译。
 */
export async function buildBackupZip(
  store: UserDataStore,
  opts: BackupBuildOptions = {},
): Promise<BuildBackupResult> {
  const options =
    opts.options !== undefined && opts.options !== null
      ? opts.options
      : opts.includeChapters
        ? [...defaultBackupOptions(), 'chapters']
        : undefined;
  return buildBackup(store, options as readonly string[] | undefined, {
    now: opts.now,
    password: opts.password,
    cookies: opts.cookies,
    sourceVariables: opts.sourceVariables,
  });
}

/** 上传一份备份到 WebDAV 根目录 */
export async function uploadBackup(
  store: UserDataStore,
  configStore: WebDavConfigStore,
  opts: BackupBuildOptions & { http?: WebDavHttp } = {},
): Promise<BackupResult> {
  const built = await buildBackupZip(store, opts);
  const fileName = backupFileName(opts.now === undefined ? new Date() : new Date(opts.now));
  const client = clientOf(configStore, opts.http);
  await client.upload(`${client.root}${fileName}`, built.zip, 'application/zip');
  return {
    fileName,
    bytes: built.zip.length,
    books: built.books,
    included: built.included,
    entries: built.entries,
    skippedSensitive: built.skippedSensitive,
  };
}

/** 列出远端所有备份（按时间倒序 —— 最新的在前，界面直接照这个顺序显示） */
export async function listBackups(
  configStore: WebDavConfigStore,
  opts: { http?: WebDavHttp } = {},
): Promise<BackupItem[]> {
  const client = clientOf(configStore, opts.http);
  const files = await client.listFiles(client.root);
  return files
    .filter((f) => !f.isDir && isBackupName(f.displayName))
    .map((f) => ({ name: f.displayName, size: f.size, lastModify: f.lastModify }))
    .sort((a, b) => b.lastModify - a.lastModify || b.name.localeCompare(a.name));
}

/** `B7` ③ 恢复方式：覆盖（默认）= 同主键用备份替换；合并 = 只补缺失、现有内容保留 */
export type RestoreMode = 'overwrite' | 'merge';

/** `B7` ④ 轮转结果（界面用来回显「删了哪几份 / 留了哪几份」） */
export interface PruneResult {
  keep: number;
  kept: string[];
  deleted: string[];
}

/**
 * `B7` ④ 按「保留份数」清理旧备份：保留最新的 N 份，其余删除。
 *
 * 只在**一次成功备份之后**调用（由路由决定），不在读取列表时偷偷删：
 * 删除是不可逆动作，必须与「刚写了一份新备份」绑定，用户才说得清为什么少了文件。
 * 默认 N=1 ⇒ 每次备份成功后只留最新一份（同一天覆盖的场景本来就只剩一份）。
 *
 * @param keep 1~10（越界会被夹紧；不传按 1）
 */
export async function pruneBackups(
  configStore: WebDavConfigStore,
  keep: unknown = 1,
  opts: { http?: WebDavHttp } = {},
): Promise<PruneResult> {
  const n = clampBackupKeep(keep);
  const files = await listBackups(configStore, opts);
  const stale = files.slice(n);
  const client = clientOf(configStore, opts.http);
  const deleted: string[] = [];
  for (const f of stale) {
    // 逐份删：单个失败不阻断其余（下一轮还会重试到它）
    try {
      await client.remove(`${client.root}${f.name}`);
      deleted.push(f.name);
    } catch {
      /* 删不掉就留着，下次备份再清 */
    }
  }
  return { keep: n, kept: files.slice(0, n).map((f) => f.name), deleted };
}

/**
 * 从远端恢复一份备份。
 *
 * @param name 备份文件名（先用 `listBackups` 列出来，别让用户手打）
 * @param opts.password 备份口令（备份里带了加密的 Cookie/源变量时必须给）
 * @param opts.mode `B7` ③：`overwrite`（默认）或 `merge`（只补缺失、不覆盖现有）
 */
export async function restoreBackup(
  store: UserDataStore,
  configStore: WebDavConfigStore,
  name: string,
  opts: RestoreDeps & { password?: string | null; mode?: RestoreMode } = {},
): Promise<RestoreResult> {
  if (!isBackupName(name)) throw new Error(`「${name}」不是备份文件（备份文件名以 backup 开头）`);
  const client = clientOf(configStore, opts.http);
  const bytes = await client.downloadBytes(`${client.root}${name}`);

  // ★ 解包/解密全在 `readBackupArchive`：错误信息已经写成「用户能自救」的样子
  //   （不是备份 zip / 口令不对 / 需要口令 / 手机端格式不同）
  const read = readBackupArchive(bytes, opts.password);

  // ★★ 默认非累加：`overwrite = true` —— 累加型导入不适合「恢复」（删掉的东西回不来）。
  //    `B7` ③ 用户选「合并」时改 `overwrite = false`：只补缺失，现有记录一律保留。
  //    并按 `included` 裁剪：没声明的字段一个都不碰（否则「只备份书签」的恢复会写空书架字段）
  const payload = filterSnapshotByIncluded(read.snapshot, read.included);
  const overwrite = opts.mode !== 'merge';
  const counts = await importSnapshot(store, payload as never, { overwrite });

  const warnings: string[] = [];
  let cookiesRestored = 0;
  let sourceVariablesRestored = 0;

  if (read.cookies) {
    if (!opts.setCookies) {
      warnings.push('备份里有 Cookie，但当前宿主没有提供写回能力 ⇒ 未写入（登录态需要重新登录）');
    } else {
      for (const [id, value] of Object.entries(read.cookies)) {
        if (opts.setCookies(id, value)) cookiesRestored += 1;
      }
      if (cookiesRestored < Object.keys(read.cookies).length) {
        warnings.push(
          `有 ${Object.keys(read.cookies).length - cookiesRestored} 个源的 Cookie 没能写回（源未注册/已删除）`,
        );
      }
    }
  }
  if (read.sourceVariables) {
    if (!opts.setSourceVariable) {
      warnings.push('备份里有源变量，但当前宿主没有提供写回能力 ⇒ 未写入');
    } else {
      for (const [id, value] of Object.entries(read.sourceVariables)) {
        if (opts.setSourceVariable(id, value)) sourceVariablesRestored += 1;
      }
    }
  }

  return {
    fileName: name,
    counts,
    included: read.included,
    legacy: read.legacy,
    cookiesRestored,
    sourceVariablesRestored,
    warnings,
  };
}
