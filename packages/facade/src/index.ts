/**
 * @yuedu/facade 公共出口
 */
export {
  EngineHub,
  pickFirstExploreUrl,
  type HubOptions,
  type AggregateEvent,
  type VerifyOutcome,
  type VerifyStage,
} from './hub';
export { SourceStore, type HubSource } from './source-store';
// `#616` 登录态落盘加密（对齐上游 `BaseSource.kt:255-325` 的 AES `userInfo`）
export {
  createVaultStore,
  sealSecret,
  openSecret,
  isSealed,
  sealJsonFile,
  openJsonFile,
  vaultKey,
  VAULT_PREFIX,
  VAULT_KEY_PREFIXES,
} from './secret-vault';
export {
  deriveId,
  safeSourceId,
  detectImportFormat,
  parseImportText,
  type ImportFormat,
  type ImportFormatHint,
  type ImportRow,
  type ImportParseResult,
  type ImportPreview,
  type ImportPreviewItem,
} from './importer';
export { noopSandbox } from './sandbox';
// `#208` 直链上传（规则模型在 @yuedu/core；这里是执行层：multipart 组装 + 规则求值）
export {
  uploadDirectLink,
  uploadSourceJson,
  buildDirectLinkForm,
  applyDirectLinkDownloadRule,
  type UploadFile,
  type DirectLinkUploadOptions,
  type DirectLinkUploadResult,
} from './direct-link-upload';
// `#208` 最小 zip 读写器（写：直链上传 compress + 整库备份；读：恢复备份）
export {
  createZip,
  zipSingleFile,
  crc32,
  readZip,
  readZipEntry,
  listZipEntries,
  type ZipEntryInput,
  type ZipWriteOptions,
  type ZipReadEntry,
} from './zip-writer';
// `#208` WebDAV 客户端（执行层：PROPFIND/MKCOL/GET/PUT/DELETE + 207 解析；纯逻辑在 @yuedu/core 的 webdav.ts）
export {
  WebDavClient,
  WebDavError,
  parsePropFind,
  type WebDavHttp,
  type WebDavClientOptions,
  type WebDavCheckResult,
} from './webdav';
