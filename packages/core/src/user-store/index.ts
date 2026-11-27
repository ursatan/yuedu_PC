/**
 * 用户数据层的统一入口（Phase 1.2）
 *
 * ```ts
 * const store = await openUserStore({ dir: DATA_DIR });
 * await store.upsertBook(book);
 * const blobs = createBlobStore(DATA_DIR);
 * ```
 *
 * 业务代码只认 {@link UserDataStore} 接口，不直接 import `node:sqlite` ——
 * 将来换 `better-sqlite3` 或远端存储只需改本文件。
 */

export * from './types';
export { createBlobStore, type BlobMeta, type BlobStore, type BlobSweepPolicy, type BlobSweepResult } from './blobs';
export { createJsonUserStore, jsonStoreFile } from './json';
export { importSnapshot, type ImportCounts, type ImportOptions, type ImportResult, type UserSnapshotInput } from './import';
export { createSqliteUserStore, hasSqliteSupport, USER_STORE_SCHEMA_VERSION } from './sqlite';

import { createJsonUserStore } from './json';
import { createSqliteUserStore, hasSqliteSupport } from './sqlite';
import { UserStoreOpenError, type UserDataStore, type UserStoreOptions } from './types';

/** 打开存储时的诊断信息（便于 `/api/user/_health` 之类端点上报） */
export interface OpenUserStoreResult {
  store: UserDataStore;
  /** 是否发生了回落（true = 没能用上 SQLite） */
  degraded: boolean;
  /** 回落原因（人类可读） */
  reason?: string;
}

/**
 * 打开用户数据存储。
 *
 * 策略：`kind` 未指定时**优先 SQLite**；若 `node:sqlite` 不可用或建库失败 → **回落 JSON 实现**
 * 并在返回值里标 `degraded`（宁可慢，也不能让书架/进度完全不可用）。
 * 显式传 `kind: 'sqlite'` 时**不回落**，直接抛错（便于测试与故障排查）。
 */
export async function openUserStore(opts: UserStoreOptions): Promise<OpenUserStoreResult> {
  if (opts.kind === 'json') {
    return { store: await createJsonUserStore(opts), degraded: true, reason: '显式指定 kind=json' };
  }
  try {
    return { store: await createSqliteUserStore(opts), degraded: false };
  } catch (e) {
    if (opts.kind === 'sqlite') throw e;
    const reason = e instanceof Error ? e.message : String(e);
    const supported = await hasSqliteSupport();
    const why = supported
      ? `SQLite 建库失败：${reason}`
      : `运行时无 node:sqlite（需要 Node ≥22 / Electron ≥35）：${reason}`;
    console.warn('[user-store] 回落 JSON 实现 ——', why);
    return { store: await createJsonUserStore(opts), degraded: true, reason: why };
  }
}

/** 只返回 store 的便捷写法（不需要诊断信息时用） */
export async function openUserStoreOrThrow(opts: UserStoreOptions): Promise<UserDataStore> {
  const r = await openUserStore(opts);
  if (!r.store) throw new UserStoreOpenError('用户数据存储打开失败', 'none');
  return r.store;
}
