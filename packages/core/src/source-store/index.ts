/**
 * 源库存储模块入口（`#651`）。
 *
 * 唯一实现是 `sqlite.ts`（见那里的文件头：为什么统一到 SQLite、上游口径、2000 源实测）。
 * 这里只做转出，避免业务层直接摸到 `node:sqlite`。
 */
export {
  SourceDb,
  sourceIdentityOf,
  SOURCE_STORE_SCHEMA_VERSION,
  type SourceDbOpenResult,
  type SourceDbState,
  type SourceRow,
  type SourceTrashRow,
} from './sqlite';
