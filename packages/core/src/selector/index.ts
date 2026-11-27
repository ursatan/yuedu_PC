/**
 * 选择器层公共出口
 */
export * from './types';
export * from './rule-analyzer';
export * from './analyze';
export { cssGetString, cssGetStringList, cssGetElements } from './css';
export { unescapeHtml4, formatText, formatIntro, formatHtml, normalizeIntro, isRichIntro } from './html-format';
export { HTML4_ENTITIES, HTML4_ENTITY_MAP } from './html-entities.generated';
export { xpathGetString, xpathGetStringList, xpathGetElements } from './xpath';
// `jsonGetObject` = 上游 `getObject`（`ctx.read` 原文，对象也算命中），与 `jsonGetList` 是两条路径，见 `#309`
export { jsonGetString, jsonGetList, jsonGetObject } from './jsonpath';
export { regexGetString, regexGetElements, compileKotlinRegex } from './regex';
export { createJsEvaluator, createHybridJsEvaluator, syncRenderEnabled, makeStrResponse, isStrResponse, readStrResponse, makeInfoMapBinding, normalizeRhinoSyntax, cloneableFieldsOf, curlSyncFetch, makeCacheOps, contentComputeEvalTimeoutMs } from './js';
// `#344`：jsLib 三形态解析（JSON 映射表 / 单 URL / 内联 JS）—— 两引擎共用的唯一实现
export { parseJsLibMap, isAbsUrl, jsLibUrls, resolveJsLibText } from './js-lib';
/**
 * `#636` 第二层：**外部脚本取数的「重试 + 预算」**（`Reload()` / `java.importScript` /
 * `java.cacheFile` 的共用判据，唯一实现在 `js-file.ts`）。
 * 导出给：① worker 宿主 rpc 用；② `engine-legado` 的 jsLib 预下载复用同一个「瞬时错误」判词，
 * 避免两处正则各写一套（漂移过一次就算 bug）。
 */
export {
  fetchScriptTextRetry,
  isTransientScriptFetchError,
  shouldRetryScriptFetch,
  isBlankScriptBody,
  scriptFetchBackoffMs,
  SCRIPT_FETCH_POLICY,
} from './js-file';
export type { ScriptFetchPolicy, ScriptFetchAttempt, ScriptFetchOutcome } from './js-file';
// `#313`：规则桥的唯一实现（两引擎 + 测试桩共用，消除三处重复）
export { makeRuleBridge, describeRuleNode } from './rule-bridge';
/**
 * `#314`：JSON 绑定的「Java Map / List 方法」补齐（非枚举、幂等）—— 对**外可见**了。
 * 为什么要导出：源登录信息 `getLoginInfoMap()` 在上游是 Java `MutableMap`，脚本里
 * `map["键"]` 与 `map.get("键")` 都要能用 ⇒ 两个引擎的 source 桩都用这份实现挂方法，
 * 而不是各自手写一套 `wrapped.get = …`（那样方法会变成**可枚举**，`Object.keys(map)` 会多出键）。
 */
export { attachJsonMapMethods } from './json-map';
export {
  asImageStreamResult,
  IMAGE_BYTES_KEY,
  IMAGE_BYTES_SOURCE,
  imageDecodeBindings,
  isImageBytesResult,
  materializeImageBindings,
  imageDecodeWorkerMode,
  imageDecodeWorkerEnabled,
  canDecodeImageInWorker,
  // `#782` 冷规则首图探测：路由计划 + 探测样本 + 失败清标记
  planImageDecode,
  recordImageDecodeProbeCost,
  abortImageDecodeProbe,
  recordImageDecodeL1Cost,
  resetImageDecodeCostCache,
  shouldRetryImageDecodeInL1,
  // `D2` 标准参数 `decode{}`（对象/JSON 形式）+ 服务端 AES-CBC
  parseImageDecodeSpec,
  decodeImageKeyBytes,
  splitImageCipherBytes,
  aesCbcDecryptBytes,
  decryptImageWithSpec,
} from './image-bytes';
export type { ImageBytesResult, ImageDecodeSpec, ImageKeyEncoding } from './image-bytes';
// #160：缺省同步 HTTP（worker 版，不依赖子进程）+ curl 兜底与开关，单独导出以便诊断/测试
export { defaultSyncFetch, workerSyncFetch, canUseWorkerSyncFetch, disposeSyncFetchWorker } from '../net/sync-fetch-worker';
export type { CacheOps } from './js';
export type { SyncHttpRequest, SyncHttpResponse } from './js';
export type { StrResponseParts } from './js';
// `#313`：规则桥的元素描述符与 `op='object'` 的两种返回形态（引擎实现 ruleBridge 时用）
export type { RuleNodeDescriptor, RuleBridgeObjectResult, RuleBridgeResult } from './js';
