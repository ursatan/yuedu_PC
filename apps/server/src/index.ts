/**
 * @yuedu/server —— M3 打通层（Fastify + EngineHub）
 *
 * 职责：把 EngineHub（统一门面）暴露成 REST + SSE，让 Web/CLI 都能驱动双引擎。
 * 引擎本身不在这里；这里只做「注册引擎 → 加载源 → 暴露 API → 流式聚合」。
 *
 * 参考：docs/01-开发计划.md §7 服务端 API
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import { EngineHub, createVaultStore, sealJsonFile, openJsonFile, deriveId, readZip } from '@yuedu/facade';
import { createDoctorPatrol, type PatrolCollectRow } from './doctor-patrol'; // #552 离线巡检（调度/落盘/播报出口）
// `#756` C：交互优先级闸（前台在飞计数 + 图片解密让路 + `/api/diag.priority` 计数）
import { createForegroundGate } from './foreground-gate';
// `#746` B1：源体检 / 批量校验搬到独立子进程（默认由 `YUEDU_BATCH_PROCESS` 控制，`=0` 回落同进程）
// `#753` B2：登录求值 / Cookie 写 / 源变更失效钩子（`YUEDU_B2_PROCESS=1` 才启用，默认关）
import { createBatchRunner, batchProcessEnabled, b2ProcessEnabled, type BatchRunner } from './batch-runner';
import type { BatchLoginResult } from './batch-protocol';
// `D5` 导入分片执行 + 失败聚合（纯逻辑在 import-job.ts，便于单测）
import { runImportInChunks, type ImportRowsBatch } from './import-job';
// `B21` 远程书源订阅：地址簿（只记 URL；内容更新永远走「导入源」的强制预览）
import { createSourceSubsStore } from './source-subscriptions';
// `#816` B5：六类缓存的分区记账 / 配额 / LRU 驱逐（服务端四类落盘，浏览器两类由设置页本地统计）
import { createCacheStore, SERVER_CACHE_CATEGORIES, type ServerCacheCategory } from './cache-store';
// **音频缓存**（对齐上游 `AudioCacheManager`）：独立根目录 + 文件存在即权威 + 后台整章落盘
import { createAudioCache, audioBookKey, audioChapterKey, audioExtOf, isStreamOnlyAudio, makeShelfMatcher } from './audio-cache';
// **音频任务历史**（只落失败/取消）：重启后仍能查到失败原因；7 天 / 最近 200 条
import {
  createAudioJobHistory,
  AUDIO_JOB_HISTORY_MAX,
  AUDIO_JOB_HISTORY_TTL_MS,
} from './audio-job-history';
// `#558` 巡检间隔可配（24h/3天/7天/30天，默认 7 天）
import { patrolHours, setPatrolHours, PATROL_HOUR_OPTIONS, PATROL_DEFAULT_HOURS } from './doctor-patrol';
import { LegadoEngine } from '@yuedu/engine-legado';
import { classifyLoginUrl } from '@yuedu/engine-legado';
import { sourceStorageKeys } from '@yuedu/engine-legado';
import { MacCmsEngine } from '@yuedu/engine-maccms';
import { RssEngine } from '@yuedu/engine-rss';
// 取图/媒体代理必须走**同一份网络护栏**（见 proxyHttp）——此前用裸 fetch，一页 60 张封面
// 就是 60 个无上限的上游请求（用户实测过「同局域网其它设备卡死」的自伤形态）。
import {
  createHttpClient,
  importSnapshot,
  importLocalBook,
  listArchiveBooks,
  normaliseHref,
  parseEpub,
  readCentralDirectory,
  readEntryBy,
  readEpubAsset,
  readLocalBookContent,
  readMobiCover,
  normalizeLocalBookOriginName,
  // `#558` 试跑物料取页链（详情←发现/搜索、目录←详情、正文←目录）+ 物料格式化
  resolveMaterial,
  formatMaterial,
  // `#651` 源库存储（SQLite）
  SourceDb,
  // `B6` 质量分排序/_dead 跳过判定
  effectiveSourceQuality,
  isSourceHealthDeadActive,
} from '@yuedu/core';
import type { LocalBookImport, ReadSession, SiteCustomize, UnifiedDetail, SourceHealth } from '@yuedu/core';
import { DemoEngine } from './demo-engine';
// ★ `#228` / `#217`：本地书「文件名 → 磁盘路径」的唯一实现（可单测，见 local-book-file.ts 头）
import {
  localBookFileName, localBookPath, resolveLocalBookFile, safeLocalBookName,
} from './local-book-file';
import {
  openLoginWindow,
  harvestLoginCookies,
  loginWindowStatus,
  closeLoginWindow,
  clearLoginBrowserData,
} from './browser-login';
// `#453`（D13 = A+B）：常驻浏览器会话（按 `src:<sourceId>` 隔离，登录窗与内容页渲染共用同一实例）
import {
  browserProfileDir,
  closeBlankTabs,
  getSession,
  hasLiveSession,
  acquire as acquireSession,
  moveWindowOffscreen,
  readCookiesViaCdp,
  touchSession,
  release,
  render as renderWithSession,
  sessionKeyOf,
  setBrowserProfileRoot,
  setBrowserContextMode,
  browserContextEnabled,
  renderHtmlScript,
} from './browser-session';
// `#482` Web 端内嵌验证窗（服务端半边：screencast 帧 + 输入回灌 + 清关判据）
import {
  closeVerification,
  getVerification,
  navigateVerification,
  openVerification,
  setVerifyCookieSink,
  setVerifyUaSink,
  subscribeVerification,
  verificationForSource,
  verificationInput,
} from './verification';
// `#727` java.getVerificationCode：人工输入验证码 + Cookie 回收（桌面端内置窗口）
import {
  cancelVerificationCode,
  captureVerificationCodeFrame,
  claimVerificationCode,
  getVerificationCodeMeta,
  normalizeVerifyCodeConsumer,
  pendingVerificationCodes,
  refreshVerificationCode,
  renderVerificationCodePage,
  requestVerificationCode,
  setVerificationCodeSink,
  submitVerificationCode,
} from './verification-code';
import { createLayeredRenderer } from './renderer';
// `#731` 导航 URL 的**唯一清洗入口**（复合键 `sourceKey|`url`` → 纯 URL；非法直接抛）
import { normalizeNavUrl } from './nav-url';
// `#568` P3 站点定制：本地配置存储（per-site CSS/JS · 阅读模式开关）
import { createSiteCustomizeStore } from './site-customize-store';
// `#820` B2 第一批：HTTP TTS（引擎配置存储 / `@js:` 沙箱 / 合成服务 / 路由；UI 留给后续会话）
import { createTtsStore } from './tts-store';
import { createTtsService } from './tts-service';
import { registerTtsRoutes } from './tts-routes';
// `B6` 书源体检结果（五态 + 质量分 + `dead` 3 天跳过）持久化
import { createSourceHealthStore } from './source-health';
// `#460` 卡死取证看门狗（独立线程量主线程心跳；用户报「卡离线 + cmd 无信息」的判据设施）
import { startStallWatch, trackStart } from './stall-watch';
// `#476` TTY 日志卸载：控制台写挪到 worker 线程（Windows conhost 同步写是 5s stall 真因）
import { installOffloadedLogSink } from './log-sink';
// `#651` 源库：运行时唯一的源存储（SQLite，替代旧的 `source-overlay.ts` JSON 覆盖层）
import { SourceDbLayer } from './source-db';
import { migrateLegacySources } from './source-migrate';
// `#310` 能力事实（hasSearch / hasExplore）—— 抽成纯函数以便单测（见 src/source-caps.ts）
import { computeHasSearch, computeHasExplore, computeWebViewOnly, computeHasStartPage } from './source-caps';
// 前端产物目录解析（纯函数，自己一个文件是为了能单测 —— index.ts 有启动副作用）
import { resolveWebDist, staticCacheControl } from './web-dist';
import { isHlsPlaylist, looksLikeHlsBody, rewriteHlsPlaylist } from './hls';
/** `#435`：代理回传 HTML 文档时的两道修补（`<base>` + 还原 `location.search`）—— 见该文件头注 */
import { injectProxiedDocPatches } from './proxy-doc';
// `#394` 解析云二级解析（jx 播放页 → 可播直链）—— 可测模块，index 只做接线
import { resolveMediaPage } from './media-resolve';
import { REFERER_RETRY_STATUS, originOf, refererChain } from './proxy-referer';
// `#378` 代理状态码判据（上游 4xx 透传 / 5xx→502；限流与换 UA 判定）—— 唯一实现
import { UA_RETRY_STATUS, isRateLimited, proxyStatusAction } from './proxy-status';
// `#780` ③：封面失败**采样**日志（只补 status/超时证据，不改行为）
import { coverFailureSampler, hostOf, isTimeoutLikeError, shouldNoteCoverFailure } from './proxy-failure-log';
// `#780` ①：上游**响应头**预算分档（图片类 10s / 普通 20s / range 60s）—— 唯一实现
import { isImageProxyRequest, proxyHeaderTimeoutMs } from './proxy-timeout';
// `#210` 运维：崩溃留痕 + 定时更新书架（两者都可独立单测，index.ts 只做接线）
import { recordCrash, recentCrashes, listCrashLogs } from './crash-log';
import { ShelfUpdater, detailIdFromBookUrl } from './shelf-updater';
import { corsOriginFor, corsPreflightFor } from './cors';
import type {
  EngineAction,
  UnifiedRequest,
  EngineEvent,
  UserDataStore,
  ShelfBook,
  ShelfChapter,
  Bookmark,
  BookHighlight,
  BookMemo,
  ReplaceRule,
  HighlightRule, // `#262` 高亮规则
  DictRule, // #189 字典规则（上服务端时的端点用）
  BookGroup,
  BookshelfSort,
  ProgressPatch,
} from '@yuedu/core';
import {
  createWorkerSandboxPool,
  createFileKeyValueStore,
  harvestHosts,
  // `#456` 内嵌真浏览器回传 cookie 的域过滤（与登录窗 harvest 用同一份，别重写）
  pickLoginCookies,
  openUserStore,
  createBlobStore,
  emptyShelfBook,
  emptyShelfChapter,
  emptyBookmark,
  emptyBookHighlight,
  emptyBookMemo,
  emptyReplaceRule,
  emptyHighlightRule, // `#262`
  highlightRuleIsValid, // `#262`
  newHighlightRuleUuid, // `#262`
  parseReplaceRuleImport,
  emptyBookGroup,
  netGuardConfig,
  netStats,
  netEnvFacts,
  resetNetStats,
  // `#732` 外链脚本连续下载失败 ⇒ 设置页「请手动下载」提示（持久化在 data/jslib-mirror/.hints.json）
  listJsMirrorHints,
  trafficSnapshot,
  blockCounters,
  formatBlocks,
  // `#771` 冻结定向探针：默认关（`YUEDU_FREEZE_PROBE=1` 开），`/api/diag.freeze` + `[stall]` 行输出
  freezeProbeReport,
  installGcProbe,
  probeEnter,
  probeLeave,
  // `#749` D2：`YUEDU_L1_WORKER` 的默认开依据 —— 路由/丢绑定/超时/curl 回退计数（/api/diag 的 `l1`）
  l1StatsSnapshot,
  resetL1Stats,
  // `#743` P0：三个盲区阻塞埋点之一 —— `/api/proxy` 文本通道（解码/补丁/重写）
  recordBlock,
  lintSource, // #550 源医生·编辑器内联诊断（与 #542 同一判据）
  sourceKindOf, // #552 源形态判定的唯一实现（inspect 与离线巡检共用）
  type ValidationIssue,
  concurrentRateSnapshot, // `#321` 源级限频记录快照（/api/diag）
  // `#208` 源分享：直链上传规则的字段级校验 + 解析粘贴配置（内置规则表由 getState() 带出）
  validateDirectLinkUploadRule,
  parseDirectLinkUploadRules,
  // `#208` WebDAV 配置的字段级校验
  validateWebDavConfig,
  // `#386` 引擎接入系统代理（运行期开关，设置页「服务与网络」）
  applySystemProxy,
  systemProxyState,
  validateProxyUrl,
  // `#423`「只渲染登录界面」伪动作（GET /login 打开对话框时求值脚本型 loginUi）
  LOGIN_UI_RENDER_ACTION,
  // `#439` 响应字节的字符集判定/解码（core 唯一实现）—— `/api/proxy` 文本通路
  detectResponseCharset,
  decodeBytes,
  // `#470` 非媒体响应在服务端转缓冲：与 core 同一份令牌桶限速 + 体积护栏 + netStats 计数
  readStreamLimited,
  // `#457`「响应体像不像 HTML 文档」的唯一判据（文档补丁必须先过它）
  looksLikeHtmlDocument,
  // `#467` 源 header 规则解析的唯一实现（与两引擎同一份；代理侧只走静态 JSON 形态）
  parseStaticSourceHeader,
  isScriptSourceHeader,
  // `#551` 源医生 v2-B/C：单字段试跑 + 选择器探针（复用引擎同一份 AnalyzeRule）
  probeField,
  // `#559` 自取数列表判定（`<js>` + java.ajax）：决定「页面 404」是正常形态还是真故障
  isSelfFetchingRule,
  // `#561`/`#562` 自取数占位内容 + 挑战页判定（与字段试跑/物料链同一份判据）
  SELF_FETCH_PLACEHOLDER,
  isChallengePage,
  probeSelector,
  // `#555` 试跑前置判定：搜索关键词口径（URL 求值已改为 `#557` 的 `evalUrlTemplate`）
  defaultSearchKeyword,
  // `#556` 发现规则探针：形态判定 / 真跑分类表 / 语法自动纠正（纯逻辑在 core，端点只做取页）
  autoCorrectExploreRule,
  probeExplore,
  // `#557` URL 模板求值（引擎同一套求值器）+ loginUi 规则校验
  evalUrlTemplate,
  checkLoginUi,
  makeProbeEnv,
  extractInlineJs,
  /**
   * `#625` URL → 书源识别（上游 `BookshelfViewModel.addBookByUrl`：`,{origin}` → 域名 → pattern）。
   * 纯函数在 core（`source-match.ts`），端点只做「把 registry 里的源投影成候选集」。
   */
  resolveSourceByUrls,
  type UrlSourceCandidate,
  // `#754` DOM 后端启动预热（默认关：YUEDU_DOM_WARMUP=0）+ `/api/diag` 的 worker 状态
  prewarmDomBackend,
  domBackendStatus,
  // `#773` DOM 解析统计（count/累计/maxMs+maxLen）——定位「哪份 HTML 最慢」不再靠 trace 日志
  parseHtmlStats,
} from '@yuedu/core';
import { parseImportText, type ImportFormatHint, type ImportRow } from '@yuedu/facade';
// `#424`：`/api/proxy` 的媒体流式分支要把 undici 的 web ReadableStream 转成 Node 流管道给客户端
import { Readable } from 'node:stream';
// `#208` 源分享：配置持久化 + 上传 + 编口令（独立文件，见其文件头注释）
import { DirectLinkUploadConfig, shareSource, testDirectLinkRule } from './share-direct-link';
// `#208` WebDAV：配置持久化 + 阅读进度同步（独立文件；客户端在 @yuedu/facade）
import { WebDavConfigStore, clampBackupKeep, syncBookProgress } from './webdav-sync';
// `#208` ④ 整库备份/恢复 + `#201` 快照组装的唯一实现（导出端点与备份共用，防漂移）
import { buildSnapshot } from './user-snapshot';
// `#208` ④ WebDAV 上的整库备份 / 恢复（zip + 非累加导入）；`B7` ③④ 恢复方式 + 轮转
import {
  listBackups, pruneBackups, restoreBackup, uploadBackup, type RestoreMode,
} from './webdav-backup';
import {
  BACKUP_OPTIONS,
  BackupOptionError,
  UNSUPPORTED_BACKUP_OPTIONS,
  defaultBackupOptions,
} from './backup-build';
import {
  BackupError,
  FULL_OPTIONS,
  LEGADO_OPTIONS,
  applyFull,
  applyLegado,
  buildSourceIndex,
  defaultFullRestoreOptions,
  detectArchiveKind,
  exportFull,
  exportLegado,
  normalizeFullOptions,
  normalizeLegadoOptions,
  previewFull,
  previewLegado,
  readFullArchive,
  readLegadoArchive,
} from './legado-backup';

/**
 * `#868` **控制台代码页自愈**（Windows）。
 *
 * 现象：服务被「非 start-server.bat」的入口拉起时（例如会话里的临时 `Start-Process` 脚本、
 * 或任何给子进程新建控制台的启动器），新 conhost 的默认代码页是 936(GBK)，而
 * `log-sink.ts` 往 fd 1/2 **裸写 UTF-8 字节** ⇒ 中文变成「娓叉煋灞傦細」这类乱码。
 *
 * 为什么放在服务端而不是只靠启动脚本：代码页是**控制台属性**，谁建了这个控制台就得由谁设。
 * `start-server.bat` / `run-node-cpu.ps1` 已在各自路径上设过（#830），但**外部入口**绕不过去；
 * 服务进程在启动瞬间把自己的控制台改成 65001，才能做到「无论从哪条路径启动/重启，输出一致」。
 *
 * 边界（重要）：
 *  · 输出已重定向到文件/管道（`isTTY=false`）时**跳过** —— 那里没有 conhost 解码，不存在乱码，
 *    也免得在无控制台环境里多起一个 chcp 进程；
 *  · `windowsHide` 必须为 false：true 会给 chcp 一个 **CREATE_NO_WINDOW**（没有控制台），
 *    设不到父进程的 conhost 上，等于白跑；
 *  · 不引入第三方编码库，只用系统自带的 `chcp.com`（与启动脚本同一手段）。
 */
function assertUtf8Console(): void {
  if (process.platform !== 'win32') return;
  if (process.stdout.isTTY !== true && process.stderr.isTTY !== true) return;
  try {
    execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'chcp.com'), ['65001'], {
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch {
    /* chcp 不可用（被策略拦/文件缺失）⇒ 保持原样；调用方日志里仍能看到中文是否正常 */
  }
}
// 必须早于任何中文日志输出（log-sink 按控制台 CP 解码裸 UTF-8 字节）
assertUtf8Console();

// 桌面 bundle 中 import.meta.url 会被 esbuild 替换为 __filename（裸路径，非 file URL）→ 双形态兼容；
// 桌面端也可通过 YUEDU_SERVER_DIR 直接指定目录
function computeServerDir(): string {
  if (process.env.YUEDU_SERVER_DIR) return process.env.YUEDU_SERVER_DIR;
  try {
    const u = import.meta.url;
    if (typeof u === 'string' && u.startsWith('file:')) return path.dirname(fileURLToPath(u));
    if (typeof u === 'string' && u) return path.dirname(u);
  } catch {
    /* fallthrough */
  }
  return process.cwd();
}
const __dirname = computeServerDir();

/**
 * 仓库根 = 从 __dirname 向上找第一个含 `pnpm-workspace.yaml` 的目录。
 * 为什么不能写死 `path.resolve(__dirname, '../../..')`：
 *  - 源码运行时 __dirname = `<repo>/apps/server/src` → 上跳 3 层正好是 repo；
 *  - 桌面 bundle 运行时 YUEDU_SERVER_DIR=apps/desktop 是**相对路径**，`path.resolve` 会按 cwd
 *    展开成 `<repo>/apps/desktop`，再上跳 3 层就落到了**盘根**（曾把 imported-sources.json
 *    写到 F://data//）。按标志文件向上找是确定性做法。
 */
function findRepoRoot(start: string): string {
  let d = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return process.cwd();
}
const REPO_ROOT = findRepoRoot(__dirname);
/**
 * `#651` **源只从源库读**：`BOOK_DIR` / `CMS_DIR` / `YUEDU_BOOK_DIR` 全部退役
 * （历史上它们指向「1 源 1 文件」目录，而文件名被当成 id ⇒ 同源两处存、两套 id）。
 * 这里只剩一个`legacySourceDirs()`：给**升级上来的老数据**做一次性搬迁扫描，扫不到就是空。
 */
function legacySourceDirs(): string[] {
  const out: string[] = [];
  const root = path.join(REPO_ROOT, 'data', 'sources');
  try {
    for (const name of fs.readdirSync(root)) {
      if (/^book(-\d+)?$/.test(name) && fs.statSync(path.join(root, name)).isDirectory()) {
        out.push(path.join(root, name));
      }
    }
  } catch {
    /* 没有 data/sources（正常：已迁完并删除） */
  }
  const cms = path.join(REPO_ROOT, 'apps', 'server', 'sources', 'cms');
  if (fs.existsSync(cms)) out.push(cms);
  return out;
}
/** 运行期数据目录（cookies / 用户源覆盖层 / kv）：可用 YUEDU_DATA_DIR 覆盖 */
const DATA_DIR = process.env.YUEDU_DATA_DIR ?? path.join(REPO_ROOT, 'data');
/** `B21` 源订阅地址簿（独立 JSON；内容不缓存） */
const sourceSubsStore = createSourceSubsStore(DATA_DIR);
// 登录窗口的浏览器 profile 根目录（每个源一个持久子目录：关窗/重启服务都不丢登录态）
setBrowserProfileRoot(path.join(DATA_DIR, 'browser-profiles'));
/**
 * `#816` B5 **六类缓存的分区记账**：服务端四类（封面/漫画/图片/本地书）落盘在
 * `DATA_DIR/cache/<类>/`，配额在 `DATA_DIR/cache-config.json`（设置页有入口）。
 * 浏览器两类（目录/正文）的权威数据在 IndexedDB，本模块只提供配额配置。
 * 启动放后台初始化（第一个请求会 await，不阻塞端口监听）。
 */
const cacheStore = createCacheStore({
  dir: path.join(DATA_DIR, 'cache'),
  configFile: path.join(DATA_DIR, 'cache-config.json'),
});
void cacheStore.init().catch(() => {});

/**
 * **音频缓存**（P1）：独立根目录 `DATA_DIR/audio-cache/`，与六类缓存互不相干。
 * 文件存在即已缓存；`index.json` 只做映射与统计。配额默认 2GB，超限只淘汰 `stream`。
 */
const audioCache = createAudioCache({ dir: path.join(DATA_DIR, 'audio-cache') });
void audioCache.init().catch(() => {});
/**
 * **音频任务历史**（B2 方案 2）：只落 `error` / `cancelled`，独立文件，不写源库。
 * 构造时同步读盘并做一次清理（7 天 / 200 条），所以重启后立刻可查。
 */
const audioJobHistory = createAudioJobHistory({ file: path.join(DATA_DIR, 'audio-job-history.json') });

/**
 * `#515` **服务端设置**（目前只有一项）：渲染是否共享宿主浏览器。
 *
 * 为什么不用环境变量：设置页要能直接开关、且重启后保持 ⇒ 必须落盘 + 运行时生效。
 * 文件独立（`data/browser-config.json`），不污染引擎 kv（`data/kv.json` 是源变量）。
 */
const BROWSER_CFG_FILE = path.join(DATA_DIR, 'browser-config.json');
function readBrowserCfg(): { context?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(BROWSER_CFG_FILE, 'utf-8')) as { context?: boolean };
  } catch {
    return {};
  }
}
function writeBrowserCfg(patch: { context?: boolean }): void {
  const next = { ...readBrowserCfg(), ...patch };
  fs.mkdirSync(path.dirname(BROWSER_CFG_FILE), { recursive: true });
  fs.writeFileSync(BROWSER_CFG_FILE, JSON.stringify(next, null, 2));
}
{
  const cfg0 = readBrowserCfg();
  // 只在配置里有明确布尔值时才覆盖环境变量（否则让 env 决定）
  if (typeof cfg0.context === 'boolean') setBrowserContextMode(cfg0.context);
}
const PORT = Number(process.env.PORT ?? 3000);
/**
 * `#460` 起卡死看门狗：主线程停摆（同步阻塞）⇒ **cmd 窗口会直接打出 `[stall] stall ms=…`**，
 * 同时追写 `DATA_DIR/stall-report.log`（带「卡死前在飞的源与动作」）。
 * 关掉：`YUEDU_STALL_WATCH=0`。
 */
/**
 * `#476` **先装日志卸载，再装看门狗**：服务跑在可见 cmd 窗口（stdout=TTY）时，
 * 主线程直写 conhost 会随日志刷屏/QuickEdit 拖选阻塞数秒到 71 秒（stall 报告实证）。
 * 卸载后控制台写在专用 worker 线程，全量日志异步落 `DATA_DIR/server.log`。
 * 非 TTY（electron/管道）自动 no-op。关闭：`YUEDU_LOG_SINK=0`。
 */
installOffloadedLogSink({ file: path.join(DATA_DIR, 'server.log') });
startStallWatch({ reportFile: path.join(DATA_DIR, 'stall-report.log') });
/**
 * `#771` 冻结定向探针（**默认关**）：`YUEDU_FREEZE_PROBE=1` 时在可疑同步边界打标记，
 * 由上面这块 SAB 交给看门狗在 `[stall]`/`recover` 行输出 `freeze=`；同时装 GC 观测。
 * 关着时这里只有一次 `PerformanceObserver` 的短路判断，开销可忽略。
 */
installGcProbe();

// ---------------------------------------------------------------------------
// 用户数据存储（Phase 1.2）：结构化 → SQLite（DATA_DIR/yuedu.db）；二进制 → 文件 blob
// ---------------------------------------------------------------------------
// 为什么异步打开：`openUserStore` 要动态探测 `node:sqlite`（缺了就回落 JSON 实现），
// 探测是异步的；用 promise 持有结果，需要写数据的端点 await 它即可，不必让整个启动阻塞。
// 打不开也不能让服务起不来 —— 书架/进度坏了是"功能降级"，服务整个挂掉是"不可用"。
const blobStore = createBlobStore(DATA_DIR);
const userStoreReady = openUserStore({ dir: DATA_DIR, maintenance: true });
/** 已打开的 store 引用（退出时同步关库并 checkpoint 用；见文件末尾的 signal 处理） */
let userStoreRef: UserDataStore | null = null;
userStoreReady
  .then((r) => {
    userStoreRef = r.store;
    console.log(
      `[yuedu] 用户数据存储：${r.store.kind}（${DATA_DIR}）` +
        (r.degraded ? ` ⚠️ 已降级：${r.reason ?? ''}` : ''),
    );
  })
  .catch((e: unknown) => {
    console.error('[yuedu] 用户数据存储打开失败（书架/进度将不可用）：', e);
  });

// ---------------------------------------------------------------------------
// 启动 EngineHub
// ---------------------------------------------------------------------------
// WebViewProvider 桥：桌面端 Electron 主进程开本地渲染口（环境变量或运行时注册），
// java.webView 经此走真渲染；无桌面端时走**分层渲染器**（远端渲染服务 / 无头 Chromium
// dump-dom / 静态抓取兜底）——见 apps/server/src/renderer.ts。
let renderBridgePort = Number(process.env.YUEDU_RENDER_PORT ?? 0);
/**
 * `#568` P3 站点定制（per-site CSS/JS · 阅读模式开关）的**本地配置存储**。
 * 独立文件（见 `site-customize-store.ts` 头注）；渲染器与阅读壳读同一份。
 */
const siteCustomizeStore = createSiteCustomizeStore(path.join(DATA_DIR, 'site-customize.json'));
/**
 * `B6` **书源体检结果**（五态/质量分/`deadUntil`）。
 * 独立文件：源定义要能干净导入导出，体检结论是「本机事实」，不该随源走。
 */
const sourceHealthStore = createSourceHealthStore(path.join(DATA_DIR, 'source-health.json'));
/**
 * `#820` **HTTP TTS 引擎配置**（默认关：文件不存在 = 一条引擎都没有）。
 * 独立文件而非用户快照：引擎头里可能有 API Key，备份 ZIP 不能带走（见 `tts-store.ts` 头注）。
 */
const ttsStore = createTtsStore(path.join(DATA_DIR, 'tts-engines.json'));
const webRenderer = createLayeredRenderer({
  bridgePort: () => renderBridgePort,
  // `#568` 渲染输出按站点补注入（唯一注入点在 renderer.ts 的 withCustomize）
  customizeFor: (url) => siteCustomizeStore.match(url),
});
console.log(`[yuedu] 渲染层：${webRenderer.layer()}`);


/**
 * `#495` **反爬触发来源留痕**：`/api/run` 记下「最近一次是哪个客户端（UA/来源页）在访问这个源」，
 * antibot 撞 CF 时把它打出来。
 *
 * 为什么需要：用户报「重启 3000 后没多久任务栏弹起 Chromium（预览是 138阅读网），可我根本没开发现页/搜索」
 * —— 说明有**某个页面/客户端**在后台发请求，但旧日志只记了源 id，定位不到是谁。
 * 只在撞 CF（低频）时输出，不刷屏。
 */
const lastClientOf = new Map<string, { ua: string; ref: string; act: string; at: number }>();

/** `#483` 主机级「已过 CF」记忆：host → 上次成功重放时刻（见下面 antibotReplay 的说明） */
/**
 * `#668` 清关状态**只在 hub 里存一份**（`hub.markCleared / isClearedFor`）。
 * 本文件原先另有一张 `clearedHosts`，与 hub 的 `antibotClearedHosts` 各自更新 ⇒
 * 可能出现「预检说已清关、hub 说冷却中」的自相矛盾；而且预检是 host 级、
 * 目录页清关就跳正文的直连（正文有时本来不需要盾，白等一轮渲染）。
 * 现在两边都问 hub，粒度是「host + 首段路径」。
 */

/**
 * `#667` 挑战页判据**统一到 core 的 `isChallengePage`**（本文件原有一份「只扫前 2KB」的副本）。
 *
 * 副本的问题正是 `#662` 那一类假阳性：它把 `challenge-platform` 当硬特征、又不看体积，
 * 而大页面的 `<head>` 里就有 CF/Turnstile 脚本 ⇒ 真页被判「仍是挑战页」⇒ 多走一轮重放/弹窗。
 * core 那份带体积门（泛化特征只在 ≤20KB 时算），语义唯一。性能上多扫几百 KB 可以忽略（毫秒级）。
 */
const looksLikeChallengePage = (h: string): boolean => isChallengePage(String(h ?? '')).challenge;

/**
 * `#564` **有头浏览器过盾（唯一实现）** —— 引擎的 antibot 重放与试跑探针共用这一份。
 *
 * ★ 为什么必须**有头**（`acquireSession` 默认 `headless:false` + `findFullChromium()`）：
 *   用户实测（138阅读网🌟，2026-10-22）：无头（`chrome-headless-shell` 的 `--dump-dom`）
 *   拿回来永远是被 CF 认出来的挑战页；**有头完整 Chrome** 才能跑完 CF 的 JS 挑战拿到正文。
 *   窗口用 `--window-position=-3200,-2400` 挪到屏幕外 + `bringToFront:false` + `activate:false`
 *   ⇒ 用户全程看不到窗口（`#488` 实测口径），看得见的是真正需要人工时的**内嵌验证窗**浮层。
 *
 * 流程：拉起/接管该源的常驻有头会话 → 同一次渲染里 `delayMs` 等挑战跑完（CF 的定时器挑战
 *   在 load 之后还要 3~8s；分两次渲染无效，每次都是新 tab 从头开始）→ 仍是挑战页 ⇒ 冷启动
 *   再等一轮 → 成功则回收会话 cookie 进源 CookieJar → 仍失败则（可选）开内嵌验证窗让用户人工过。
 */
/**
 * `#658` 验证窗**按源冷却**：同一源 2 分钟内不重复开窗（详见调用点注释）。
 * 用户实测 138阅读网：详情/目录/正文三个不同 URL 轮流撞盾 ⇒ 按 URL 去重等于没去重。
 */
const VERIFY_POPUP_COOLDOWN_MS = 120_000;
const verificationPopupAt = new Map<string, number>();
/**
 * `#675` **最近一次为某源开出来的验证窗**（sourceId → 会话）。
 *
 * 用户实测（菠萝猫小说 v2.2）：点分类时浏览器确实起来了、状态栏能看到验证码页面，
 * 但 Web 界面**一点反应都没有**（浮层没弹）⇒ 前端根本没收到 `needVerification`。
 *
 * 真因在这条链上：反爬重放（`antibotPassPage`）自己开了窗，但随后 `run` 抛错，
 * 而 `needVerification()` 只查 `verificationForSource()`（`bySource` 索引）——
 * 一旦会话处于 `failed`/刚被替换/索引没写进去，就返回 undefined ⇒ 前端只会看到一句
 * 「NETWORK@request」，没人告诉他要过验证。
 *
 * 这里多记一份「刚开过的窗」，作为兜底：只要它不是 closed，就照样把 sessionId 交回前端。
 */
const lastOpenedVerify = new Map<string, { id: string; url: string; phase: string }>();
/** `#669` 每个源最近一次「从浏览器收割 Cookie」的时间（节流，见 antibotPassPage） */
const lastCookieHarvestAt = new Map<string, number>();

async function antibotPassPage(
  url: string,
  sourceId: string,
  opts: { openVerification?: boolean; background?: boolean } = {},
): Promise<{ html: string; via?: string; cleared?: boolean }> {
  if (opts.background) return { html: '', via: '后台任务（不起有头）' };
  /**
   * `#731` 这一层是「有头过盾」的唯一入口，上游既有纯 URL 也有**缓存键**
   * （`hub.renderChallenge` 曾经把 `${sourceId}|${url}` 传进来）⇒ 先归一化再渲染/导航。
   * 非法串在这里抛，日志能直接看到原始串，不会再变成 Chromium 的英文 `Cannot navigate to invalid URL`。
   */
  url = normalizeNavUrl(url);
  await acquireSession(sessionKeyOf(sourceId), {
    // `#488` 带上要渲染的 URL：不传 ⇒ `finishAcquire` 不会建/不导航 pageTarget ⇒ 窗口里只剩 about:blank
    url,
    extraArgs: ['--window-position=-3200,-2400'],
    pinned: true,
    bringToFront: false,
  });
  // 接管旧进程也要立刻挪出屏幕（启动参数传不进已存在的进程，用 CDP 兜底挪一次）
  try {
    const sOff = await getSession(sessionKeyOf(sourceId));
    if (sOff) await moveWindowOffscreen(sOff);
  } catch {
    /* 挪不动不影响结果 */
  }
  touchSession(sessionKeyOf(sourceId)); // `#490` 重放不经过 acquire ⇒ 手动续期
  {
    const c = lastClientOf.get(String(sourceId));
    if (c) {
      console.warn(`[hub] antibot 触发来源：${sourceId} · act=${c.act} · ua=${c.ua || '(无)'} · ref=${c.ref || '(无)'}`);
    }
  }
  const warm = hub.isClearedFor(url);
  const waitMs = warm ? 1200 : 6500;
  let html = await renderWithSession(url, { sourceId, delayMs: waitMs, timeoutMs: warm ? 12_000 : 20_000, activate: false, preferVisible: true, settleMs: warm ? 6_000 : 12_000, rawText: true });
  const tooSmall = (h: string): boolean => !h || h.length < 500;
  /**
   * `#565` **「太短」也是没渲出来**（判据与引擎 antibot 同一条：`!h || h.length < 500`）：
   * 清关会话的 1.2s 快路径实测会取到 **39 字节的半截 DOM**（`<html><head></head><body></body></html>`）
   * —— 它不是挑战页（没有盾方特征词）⇒ 只按特征复查就会**把半截页当成功**：
   * 前端拿到 0 卡物料、搜索试跑「过了盾」却列不出东西（黄金屋实测踩到）。
   * 旧代码只在 warm 时重试；冷路径同样可能半截 ⇒ 一并重试一轮再判。
   */
  if (html && (looksLikeChallengePage(html) || tooSmall(html))) {
    await new Promise((r2) => setTimeout(r2, warm ? 3000 : 6000));
    html = await renderWithSession(url, { sourceId, delayMs: 6500, timeoutMs: 20_000, activate: false, preferVisible: true, settleMs: warm ? 6_000 : 12_000, rawText: true });
  }
  /**
   * `#664` **第三次机会**：实测「瞬时限流」的挑战常在 3~8s 内自己过去，
   * 而两次取不到就判「需人工」→ 弹窗 → 用户被挡（日志里同一 URL 几秒后又成功）。
   * 多给一轮（不再加长等待，只多一次取页），成本约 0.5~2s。
   */
  if (html && (looksLikeChallengePage(html) || tooSmall(html))) {
    await new Promise((r3) => setTimeout(r3, 1500));
    html = await renderWithSession(url, { sourceId, delayMs: 4000, timeoutMs: 15_000, activate: false, preferVisible: true, settleMs: 6_000, rawText: true });
  }
  try {
    const sBlank = await getSession(sessionKeyOf(sourceId));
    if (sBlank) await closeBlankTabs(sBlank);
  } catch {
    /* 收不收都不影响结果 */
  }
  if (!html || looksLikeChallengePage(html) || tooSmall(html)) {
    /**
     * `#664` **已清关的 host 本次失败按「瞬时被限流」处理：不弹窗、不清清关标记。**
     *
     * 用户实测 138阅读网：同一 URL 先报 `渲染后仍是挑战页（需人工过验证）` → 弹窗 → `渲染返回空`，
     * 几秒后**同样的 URL 又成功了**（`133508650` 失败，`133508655/657/659` 之后都取到）。
     * 也就是说这批失败是「快速连续翻章触发 CF 限流」，不是闸真的重新立起来 ——
     * 而弹一次窗就把用户正在读的页面盖住，反而更难受。
     *
     * 判据：该 host 在 `CLEARED_TTL_MS`（30min）内渲染成功过 ⇒ 不再弹窗；
     * 也不删 `clearedHosts`（否则预检失效，后面每个请求又要先吃一次 403）。
     */
    const hostFresh = hub.isClearedFor(url);
    if (hostFresh) {
      console.warn(
        `[hub] antibot-replay 本次未取到（疑似瞬时限流）⇒ 已清关 host 不再弹窗：${sourceId} · ${String(url).slice(0, 100)}`,
      );
      return { html: '', via: '本次未取到（已清关 host，不弹窗）' };
    }
    // `#668` 不清清关记忆：瞬时失败不代表闸重新立起来（清了会让后续每个请求白吃一次 403）
    console.warn(`[hub] antibot-replay 渲染后仍是挑战页（需人工过验证）：${sourceId} · ${String(url).slice(0, 100)}`);
    /**
     * `#668` **弹窗判定收敛成单一入口 + 显式优先级**（此前三条抑制规则散落在两处，难推理）：
     *   ① 该 URL 族已清关（`hub.isClearedFor`）⇒ **绝不弹**（本次按瞬时失败处理，上面已 return）；
     *   ② 该源 2 分钟内弹过 ⇒ 不弹（防「详情/目录/正文」三个 URL 轮流弹出盖住页面）；
     *   ③ 其余才弹。
     * 返回值里带上原因，日志与调用方都能直接看出是哪一条生效。
     */
    if (opts.openVerification) {
      /**
       * `#658` **同一源 2 分钟内只弹一次浮层**（用户实测 138阅读网：点内容卡片弹一次、
       * 点目录又弹一次、每次都要等一轮渲染 —— 页面被反复盖住，反而进不去详情页）。
       *
       * 为什么按源而不是按 URL：用户看到的「弹窗风暴」是**一本书的不同请求轮流撞盾**
       * （详情页 / 章节目录 / 正文各一个 URL），按 URL 去重等于没去重。
       * 冷却期内仍然返回空 HTML（调用方照旧降级），只是不再抢焦点开新窗。
       */
      const lastPop = verificationPopupAt.get(sourceId) ?? 0;
      if (Date.now() - lastPop < VERIFY_POPUP_COOLDOWN_MS) {
        const left = Math.ceil((VERIFY_POPUP_COOLDOWN_MS - (Date.now() - lastPop)) / 1000);
        console.warn(`[hub] 验证窗冷却中（${left}s 内不重复弹）⇒ 本次不再开窗：${sourceId} · ${String(url).slice(0, 90)}`);
      } else {
        verificationPopupAt.set(sourceId, Date.now());
        try {
          const v = await openVerification({ sourceId, url, ...(await verificationFingerprint(sourceId)) });
          lastOpenedVerify.set(sourceId, { id: v.id, url: v.url, phase: v.phase });
          console.warn(`[hub] antibot-replay ⇒ 已开内嵌验证窗 ${v.id}（前端弹浮层让用户在页内过验证）`);
        } catch (e) {
          console.warn(`[hub] antibot-replay ⇒ 开内嵌验证窗失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return { html: '', via: '有头也未过盾' };
  }
  hub.markCleared(url);
  /**
   * `#669` **Cookie 回收节流**（用户问：「每次都回收么？不是过闸时拿到就一直用么？」）。
   *
   * 事实：过闸拿到 clearance 后，后续请求确实一直带着同一批 Cookie 在用；
   * 每章都 `Network.getAllCookies` 再 merge 一遍是**多余的往返**（一次 CDP 调用 + 一次落盘）。
   * 现在只在三种情况收：① 该源还从没收到过；② 距上次收割 > 90s；③ 本次是「刚清关」（`warm=false`，
   * 通常正是 clearance 刚拿到那一刻）。
   */
  const lastHarvest = lastCookieHarvestAt.get(sourceId) ?? 0;
  const shouldHarvest = !warm || Date.now() - lastHarvest > 90_000;
  // 只要这一轮决定收割就登记时间（无论 warm 与否）——否则 warm 路径永远不更新，
  // 下一章又会因为「距上次 >90s」再收一次，节流形同虚设。
  if (shouldHarvest) lastCookieHarvestAt.set(sourceId, Date.now());
  try {
    const s = shouldHarvest ? await getSession(sessionKeyOf(sourceId)) : null;
    if (s) {
      const all = await readCookiesViaCdp(s);
      const src = hub.sources.get(sourceId);
      const siteRoot = String((src?.raw as Record<string, unknown> | undefined)?.['bookSourceUrl'] ?? '').split('#')[0] ?? url;
      const hosts = harvestHosts([siteRoot, url]).filter(Boolean);
      const { picked } = pickLoginCookies(
        all.map((c) => ({ name: String(c.name ?? '').trim(), value: String(c.value ?? ''), domain: String(c.domain ?? ''), path: '/' })),
        hosts,
      );
      const map: Record<string, string> = {};
      for (const c of picked) map[c.name] = c.value;
      if (Object.keys(map).length) {
        hub.mergeSourceCookies(sourceId, map);
        try {
          persistSourceCookies();
        } catch {
          /* 落盘失败不影响 */
        }
        console.log(`[hub] antibot-replay 回收 cookie ${Object.keys(map).length} 条 → ${sourceId}`);
      }
    }
  } catch {
    /* 回收失败不影响 */
  }
  return { html, via: warm ? '有头会话（已清关快路径）' : '有头 Chromium 过盾', cleared: true };
}

/**
 * `#658` **过闸会话的 UA**（sourceId → UA；验证清关时由 `setVerifyUaSink` 写入）。
 *
 * 为什么放在 hub 之前：`makeContext` 每个请求都要问它（见 HubOptions.sessionUaOf）。
 *
 * `#731` **必须持久化**：旧实现只放内存，服务一重启（用户日常就会重启）UA 就丢了，
 * 而 `cf_clearance` / `acw_sc__v2` 这类凭据仍留在 cookies.json 里 ⇒ 引擎拿「旧 UA + 有效凭据」
 * 去请求 ⇒ 指纹不匹配 ⇒ 403 ⇒ 又弹验证窗。落盘文件很小（源 id → UA 一行）。
 */
const SESSION_UA_FILE = process.env.YUEDU_SESSION_UA_FILE ?? path.join(DATA_DIR, 'session-ua.json');
const sessionUaBySource = new Map<string, string>();
function loadSessionUa(): void {
  try {
    const o = JSON.parse(fs.readFileSync(SESSION_UA_FILE, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(o ?? {})) {
      if (typeof v === 'string' && v.trim()) sessionUaBySource.set(k, v.trim());
    }
    console.log(`[yuedu] 已加载 ${sessionUaBySource.size} 条过闸 UA（${SESSION_UA_FILE}）`);
  } catch {
    /* 首次运行没有该文件：正常 */
  }
}
function persistSessionUa(): void {
  try {
    fs.mkdirSync(path.dirname(SESSION_UA_FILE), { recursive: true });
    fs.writeFileSync(SESSION_UA_FILE, JSON.stringify(Object.fromEntries(sessionUaBySource), null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn(`[yuedu] 过闸 UA 落盘失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
/** 写入 + 落盘（`setVerifyUaSink` / 验证码回收都走这一条，避免两处各写一遍） */
function setSessionUa(sourceId: string, ua: string): void {
  if (!sourceId || !ua) return;
  sessionUaBySource.set(sourceId, ua);
  persistSessionUa();
}
loadSessionUa();
const sessionUaOf = (id: string): string | undefined => sessionUaBySource.get(id);

/** `#746` 键值存储文件（子进程只读同一份；写回统一由主进程执行） */
const KV_FILE = process.env.YUEDU_KV_FILE ?? path.join(DATA_DIR, 'kv.json');
/**
 * `#757` E：把「文件 KV」本体单独留一份引用 —— 加解密包装层（`createVaultStore`）只暴露
 * `get/set/delete`，拿不到 `stats()/flushSync()`；`/api/diag.kv` 与退出 flush 都要用本体。
 */
const kvStore = createFileKeyValueStore(KV_FILE);
const hubKvStore = createVaultStore(kvStore);

/** `#668` 先声明后赋值：`antibotPreflight` 要回调 `hub` 自己（清关状态唯一真源），
 *  直接 `const hub = new EngineHub({ antibotPreflight: () => hub.… })` 会形成类型自引用（TS7022）。 */
let hub!: EngineHub;
hub = new EngineHub({
  sessionUaOf,
  timeoutMs: 60_000, // Legado callTimeout（HttpHelper.kt:62）
  /**
   * `#608` **单个动作的总超时**（默认 120s，可用 `YUEDU_RUN_TIMEOUT_MS` 覆盖）。
   *
   * 为什么要有：HTTP 请求必须有界，否则慢源把一次 `/api/run` 挂死几分钟，前端心跳判「服务离线」。
   * 与上游的差异：上游只有**单请求** `callTimeout=60s`，没有动作总预算 ⇒ 慢源在 App 里能一直等。
   * 所以这个值是「产品取舍」而不是移植缺失：网络差/慢站多时调大即可（毫秒）。
   */
  ...(Number(process.env.YUEDU_RUN_TIMEOUT_MS) > 0
    ? { runTimeoutMs: Number(process.env.YUEDU_RUN_TIMEOUT_MS) }
    : {}),
  // M4：worker 池沙箱 —— ctx.sandbox 的 JS 在独立线程执行，硬超时自动 terminate
  sandbox: createWorkerSandboxPool({ size: 4, defaultTimeoutMs: 10_000 }),
  webRenderer,
  /**
   * `#676` `java.webView(html, url, js)` → 真浏览器三段 CDP
   * （navigate(base) → setDocumentContent → evaluate(returnByValue)）。
   * 这是爱看吧这类「注入脚本 + 同步 XHR」的源能读到正文的唯一通道。
   */
  renderHtmlScript: (html: string, baseUrl: string, js: string, sid: string) =>
    renderHtmlScript(html, baseUrl, js, { sourceId: sid }),
  /**
   * `#727` `java.getVerificationCode(imageUrl)`：
   * 拉起/复用该源常驻 Chromium（屏幕外）→ 桌面端内置窗口显示验证码画面 → 用户输入 →
   * 回收 Cookie（与登录窗同一落点）→ 把 code 返回给脚本。60s 超时/关窗取消都会 reject。
   */
  verificationCode: (imageUrl: string, sourceId: string) => {
    /**
     * 收割 Cookie 的域候选要把**源站**带上：验证码图常挂在 CDN/第三方域，
     * 只按图片地址筛会把「本次页面加载新种的源站 Cookie」一起丢掉（见 verification-code.ts）。
     */
    const raw = hub.sources.get(sourceId)?.raw as Record<string, unknown> | undefined;
    const srcUrl = String(raw?.['bookSourceUrl'] ?? '');
    return requestVerificationCode(sourceId, imageUrl, { hosts: harvestHosts([imageUrl, srcUrl]) });
  },
  /**
   * `#481` **反爬自动重放**：引擎请求撞 403/503 + WAF 特征页 ⇒ 用该源的 CDP 常驻会话
   * 渲染重放（同一会话 = 带着登录态/已过的人机验证），并把会话 cookie 回收进源 CookieJar
   * （best-effort，落 COOKIES_FILE）。环境开关：`YUEDU_ANTIBOT_REPLAY=0` 关闭。
   */
  antibotReplay:
    String(process.env.YUEDU_ANTIBOT_REPLAY ?? '').toLowerCase() === '0'
      ? undefined
      : async (url, sourceId, ctx) => {
          /**
           *  **后台任务撞 CF ⇒ 不起有头、静默跳过**（用户实测的真凶：
           * 每 60min 遍历书架逐本拉 detail，13txt 那本一撞 CF 就弹出 Chromium —— 而用户根本没在操作）。
           * 后台任务拿到的是「本轮这源没有新内容」，用户主动访问时才会起有头 + 弹验证浮层。
           */
          if (ctx?.background) {
            console.warn(
              `[hub] antibot: 后台任务撞 WAF ⇒ 跳过（不起有头）· ${sourceId} · ${String(url).slice(0, 90)}`,
            );
            return null;
          }
          /**
           *  实现**只留一份**：有头过盾的完整流程在 ；
           * 这里只补「撞盾后要不要开内嵌验证窗」这一条调用方差异。
           */
          const r = await antibotPassPage(url, sourceId, { openVerification: true });
          return r.html ? { html: r.html } : null;
        },

  /**
   * `#519` **已清关 host 直接渲染**：`clearedHosts` 记录「该 host 最近一次渲染成功」，
   * 30 分钟内对该 host 的新 URL 不再先发一次注定 403 的 HTTP（实测 Node fetch 对 13txt
   * 恒 403，curl 同期 200 —— 差异是 TLS 指纹），直接进重放，省一次往返。
   */
  antibotPreflight: (url: string): boolean => hub.isClearedFor(url),
  // 共享存储（落盘）：源变量（七猫分组）、发现页输入（infoMap）等按源状态必须跨请求存活。
  // 路径统一走 DATA_DIR（= REPO_ROOT/data，可用 YUEDU_DATA_DIR 覆盖）——REPO_ROOT 由
  // findRepoRoot 按 pnpm-workspace.yaml 定位，不再靠 __dirname 上跳层数（曾落到盘根）。
  // `#616`：登录信息/登录头**落盘加密**（上游 `BaseSource.kt:255-325` 的 AES `userInfo`）；
  // 包在存储层 ⇒ 引擎侧 6 处读写点无需改动，也不会漏。
  // `#746` B1：`hubKvStore` 同时是「子进程写回」的唯一执行点（单写者：子进程只发起，主进程落盘）。
  storage: hubKvStore,
});
hub.registerEngine(new LegadoEngine());
hub.registerEngine(new MacCmsEngine());
hub.registerEngine(new RssEngine());
hub.registerEngine(new DemoEngine());
// 演示源：仅供本地 UI 验证完整链路（不参与真实解析）
hub.importSource(
  { name: '演示源', kind: 'demo' },
  { id: 'demo', preferred: 'demo', state: { enabled: true, searchEnabled: true, exploreEnabled: true } },
);

const COOKIES_FILE = process.env.YUEDU_COOKIES_FILE ?? path.join(DATA_DIR, 'cookies.json');

/**
 * `#616` **Cookie 落盘加密**：`cookies.json` 里是 `cf_clearance` / 登录 session，
 * 价值等同密码，明文落盘等于「把钥匙放在门垫下」（备份/分享/目录拷贝一次就漏）。
 *
 * 统一收口到这两个函数 —— 之前有 **9 处** `writeFileSync(COOKIES_FILE, JSON.stringify(...))`
 * 散在各端点，逐处改必漏；现在所有写路径都走 `persistSourceCookies()`。
 *
 * 兼容：读到**旧明文文件**时原样返回并就地加密回写一次（迁移），不丢登录态。
 */
function persistSourceCookies(): void {
  try {
    fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
    fs.writeFileSync(COOKIES_FILE, sealJsonFile(hub.exportSourceCookies()));
  } catch {
    /* 持久化失败不影响内存态 */
  }
}
function readSourceCookies(): Record<string, string> {
  try {
    const text = fs.readFileSync(COOKIES_FILE, 'utf-8');
    const { data, sealed, failed } = openJsonFile<Record<string, string>>(text);
    if (failed) {
      /**
       * 换机 / `data/vault.key` 丢失：登录态解不开，只能按没有处理 —— 但**必须留痕**（铁律 3）。
       *
       * **不能就这么放着**（2026-10-26 实测踩到）：`persistSourceCookies()` 会在下一次写 Cookie 时**直接覆盖**
       * 这个文件 ⇒ 万一密钥还在别处（备份 / 另一台机 / 旧 `data/` 拷贝），连找回的机会都没了。
       * 所以这里把它**改名留档**（`cookies.json.bad-<时间戳>`），再按空登录态继续。
       * 同时把两边的 mtime 打出来 —— 「密钥比 Cookie 文件新」就是最直接的判据
       * （2026-10-26 实测：cookies 10-25 11:30 / vault.key 10-25 18:59 ⇒ 密钥被重建过）。
       */
      const keyFile = process.env['YUEDU_VAULT_KEY_FILE'] ?? path.join(DATA_DIR, 'vault.key');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
      const bad = `${COOKIES_FILE}.bad-${stamp}`;
      try {
        fs.renameSync(COOKIES_FILE, bad);
      } catch {
        /* 改名失败也不阻断启动 */
      }
      const mt = (p: string): string => {
        try {
          return new Date(fs.statSync(p).mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
        } catch {
          return '(缺失)';
        }
      };
      console.warn(
        `[yuedu] Cookie 文件解密失败（密钥不匹配？）⇒ 按空登录态启动；` +
          `原文件已留档为 ${bad}\n` +
          `         判据：Cookie 文件 ${mt(bad)} · 密钥文件 ${mt(keyFile)}` +
          `（密钥比 Cookie 新 ⇒ 密钥被重建过，旧登录态无法找回，需重新登录相关源）`,
      );
      return {};
    }
    if (!data) return {};
    if (!sealed) {
      // 旧明文 ⇒ 迁移：加密回写一次
      fs.writeFileSync(COOKIES_FILE, sealJsonFile(data));
    }
    return data;
  } catch {
    return {};
  }
}

/**
 * ★★ `#483`：**Cookie 恢复必须排在源加载之后**（原来在 `hub.loadDir` 之前 ⇒ 全军覆没）。
 *
 * `hub.setSourceCookies()` 的第一行是 `if (!this.sources.has(sourceId)) return false` —— 源还没
 * 注册时它**静默失败**。实测（138阅读网）：`cookies.json` 里明明存着 `cf_clearance`，重启后
 * 每一个 URL 依旧撞 CF 挑战页 ⇒ 又走一遍反爬重放（每切一次分类弹一次浏览器）。
 * 现在挪到 `overlay.apply()` 之后，并给「源不存在」补一条 warn（铁律 3：兜底必须留痕）。
 */
function restoreSourceCookies(): void {
  if (!fs.existsSync(COOKIES_FILE)) return;
  try {
    const saved = readSourceCookies();
    let ok = 0;
    let missed = 0;
    for (const [id, cookie] of Object.entries(saved)) {
      if (hub.setSourceCookies(id, cookie)) ok += 1;
      else missed += 1;
    }
    console.log(`[yuedu] 已恢复 ${ok} 个源的登录 Cookie${missed ? `（${missed} 个源未注册，已跳过）` : ''}`);
  } catch {
    console.warn(`[yuedu] Cookie 文件解析失败，已跳过恢复：${COOKIES_FILE}`);
  }
}

// `#386` 引擎系统代理：独立文件持久化（`#238` 纪律——配置不进 300ms 防抖 KV），启动即恢复
const NETWORK_PROXY_FILE = process.env.YUEDU_NETWORK_PROXY_FILE ?? path.join(DATA_DIR, 'network-proxy.json');
function loadNetworkProxyConfig(): { enabled: boolean; url: string } {
  try {
    const cfg = JSON.parse(fs.readFileSync(NETWORK_PROXY_FILE, 'utf-8')) as { enabled?: boolean; url?: string };
    return { enabled: cfg.enabled === true, url: typeof cfg.url === 'string' ? cfg.url : '' };
  } catch {
    return { enabled: false, url: '' };
  }
}
{
  const cfg = loadNetworkProxyConfig();
  if (cfg.enabled) {
    const r = applySystemProxy(true, cfg.url);
    console.log(`[yuedu] 系统代理已恢复：${r.ok ? (cfg.url || '(环境变量)') : `失败 ${r.error ?? ''}`}`);
  }
}
function saveNetworkProxyConfig(cfg: { enabled: boolean; url: string }): void {
  try {
    fs.mkdirSync(path.dirname(NETWORK_PROXY_FILE), { recursive: true });
    fs.writeFileSync(NETWORK_PROXY_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`[yuedu] 系统代理配置写盘失败：${String((e as Error)?.message ?? e)}`);
  }
}

const LOGIN_INFO_FILE = process.env.YUEDU_LOGIN_INFO_FILE ?? path.join(DATA_DIR, 'login-info.json');
if (fs.existsSync(LOGIN_INFO_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(LOGIN_INFO_FILE, 'utf-8')) as Record<string, Record<string, string>>;
    let n = 0;
    for (const [id, info] of Object.entries(saved)) if (hub.setSourceLoginInfo(id, info)) n++;
    console.log(`[yuedu] 已恢复 ${n} 个源的登录信息（账号/密码）`);
  } catch {
    /* 忽略坏文件 */
  }
}

// ---- 源库（`#651` **单一存储**；旧的「文件源目录 + JSON 覆盖层」已退役）----
/**
 * `#651` 运行时唯一的源存储 = `data/yuedu.db` 的 `sources` / `sources_trash`。
 *
 * 为什么换掉旧的两处（`data/sources/book-482/*.json` + `data/imported-sources.json`）：
 *  · 同一个源可能在两处各存一份、id 还不一样（实测 速读谷 / 📚木里聚合）⇒ 按名字只翻一处
 *    就会「找不到源文件」——这正是用户报的原话；
 *  · 目录形态要求「文件名即 id」，而文件名必须 `safeSourceId` 安全化（多对一）⇒ **身份被文件名绑架**，
 *    id 会漂移。上游 legado 没有这个概念：`book_sources` 表 + `bookSourceUrl` 主键。
 * @see ../packages/core/src/source-store/sqlite.ts  （上游逐条对照 + 2000 源实测）
 * @see ./source-db.ts                                （hub 适配层，方法名与旧覆盖层一一对应）
 */
const SOURCE_DB_FILE = process.env.YUEDU_SOURCE_DB ?? path.join(DATA_DIR, 'yuedu.db');
const sourceDbOpen = SourceDb.open({ file: SOURCE_DB_FILE });
for (const w of sourceDbOpen.warnings) console.warn(`[yuedu] ⚠️ ${w}`);

const IMPORTED_FILE = process.env.YUEDU_IMPORTED_FILE ?? path.join(DATA_DIR, 'imported-sources.json');
const SEED_FILE = process.env.YUEDU_SOURCE_SEED ?? path.join(REPO_ROOT, 'data', 'seed', 'bookSource.json');

/**
 * 首次启动（表空）时从哪儿来，按优先级：
 *  ① **旧数据**（目录 + 覆盖层）→ 一次性搬迁（幂等；搬完这两个位置就可删，`#651` 已删）；
 *  ② `data/seed/bookSource.json`（Legado JSON 数组；**不入库，本机自备**）→ 新机器铺底。
 * 两者都没有 ⇒ 空库启动，但**必须喊出来**（静默空库会让用户以为「源全丢了」）。
 */
function seedFromJsonFile(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { sources?: unknown[] })?.sources)
      ? ((parsed as { sources: unknown[] }).sources)
      : [parsed];
  const rows: Array<Parameters<typeof sourceDbOpen.db.upsert>[0]> = [];
  const now = Date.now();
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    let kind = 'legado';
    try {
      kind = hub.registry.detect(raw).kind;
    } catch {
      /* 识别不了：按 legado 存，加载时再判 */
    }
    rows.push({ id: deriveId(raw, kind), kind, raw, addedAt: now, updatedAt: now });
  }
  sourceDbOpen.db.upsertMany(rows);
  return rows.length;
}

if (sourceDbOpen.db.count() === 0) {
  /**
   * 只扫**真实旧数据**（`data/sources/book-*` 与老 CMS 目录）；`tests/` 已整体删除，
   * 不存在「误把测试夹具当用户源搬进库」的可能了（`#560` 的坑）。
   */
  const legacyDirs = legacySourceDirs();
  const hasLegacy = fs.existsSync(IMPORTED_FILE) || legacyDirs.some((d) => fs.existsSync(d));
  if (hasLegacy) {
    /**
     * 搬迁的**去重规则**（见 `source-migrate.ts` 头注）：同一 `bookSourceUrl` 以目录源为准，
     * 因为书架 `books.origin` 引用的是目录源的 id（实测速读谷有 9 本书挂在它上面）。
     */
    migrateLegacySources({
      db: sourceDbOpen.db,
      dirs: legacyDirs,
      ...(fs.existsSync(IMPORTED_FILE) ? { overlayFile: IMPORTED_FILE } : {}),
      log: (m) => console.log(`[yuedu] ${m}`),
    });
  }
  if (sourceDbOpen.db.count() === 0 && fs.existsSync(SEED_FILE)) {
    try {
      const n = seedFromJsonFile(SEED_FILE);
      console.log(`[yuedu] 源库为空，已从种子导入 ${n} 条：${SEED_FILE}`);
    } catch (e) {
      console.error('[yuedu] 种子导入失败：', e instanceof Error ? e.message : e);
    }
  }
  if (sourceDbOpen.db.count() === 0) {
    console.warn(
      `[yuedu] ⚠️ 源库为空（${SOURCE_DB_FILE}）：既没有旧数据可搬，也没有种子文件 ${SEED_FILE}。` +
        `用界面导入，或 node scripts/src.mts import <文件>。`,
    );
  }
}

const sourceLayer = new SourceDbLayer(sourceDbOpen.db, hub);
const ov = sourceLayer.apply();

// `#483`：源都注册完了才恢复 Cookie（顺序错了会静默全丢，见上面 restoreSourceCookies 的说明）
restoreSourceCookies();

/**
 * `#560` 的教训保留在这里：**起服务必须把「源从哪来、有多少」喊出来**。
 * 旧版喊的是目录（`BOOK_DIR`），现在喊的是库文件 + 条数 + 回收站条数。
 */
console.log(
  `[yuedu] 源库：${SOURCE_DB_FILE}（${sourceLayer.size} 条 · 回收站 ${sourceLayer.removedIds().length} 条）` +
    `；本次装载 ${ov.restored} 条` +
    (ov.failed ? ` / 失败 ${ov.failed}` : '') +
    `；引擎：${hub.registry.list().map((e) => e.kind).join(', ')}`,
);

/**
 * `#746` B1：**批处理子进程**（源体检 / 静态校验 / 批量在线校验）。
 *
 * 为什么搬：这三条路径会跑源 JS + 同步 HTTP（`l1-eval`/`sync-http`），批量时把主线程按死
 * ⇒ 用户侧表现为「看目录时服务卡住」。搬到独立进程后主线程只剩 IPC 收发。
 *
 * 单写者（B1）：子进程只读 `yuedu.db` / `kv.json`；它的 set/delete 经 `onKvWrite` 回到
 * `hubKvStore` 执行，**落盘只发生在主进程**。体检结果/源标记同理（子进程只回结果）。
 *
 * 关停：`YUEDU_BATCH_PROCESS=0` ⇒ 所有调用点回落旧的同进程实现（行为与 `#746` 之前一致）。
 */
const batchRunner: BatchRunner = createBatchRunner({
  env: {
    YUEDU_DATA_DIR: DATA_DIR,
    YUEDU_SOURCE_DB: SOURCE_DB_FILE,
    YUEDU_KV_FILE: KV_FILE,
    YUEDU_COOKIES_FILE: COOKIES_FILE,
    // 子进程不跑定时巡检（巡检调度只在主进程）
    YUEDU_DOCTOR_PATROL: '0',
  },
  log: (m) => console.log(m),
  onKvWrite: (k, v) => {
    void (v === null ? hubKvStore.delete(k) : hubKvStore.set(k, v));
  },
  /**
   * `#753` B2：子进程登录产出的 Cookie 回来 —— **主进程是唯一物理写者**。
   *  · 子进程只回**该源**的 map（不回整份 cookies.json），这里合并进 CookieJar 再统一落盘；
   *  · 登录路由在 B2 路径下**不再自己** `persistSourceCookies()`（同一键只有一条写入发起路径）。
   */
  onCookieWrite: (sourceId, cookies) => {
    if (cookies) hub.mergeSourceCookies(sourceId, cookies);
    else hub.setSourceCookies(sourceId, '');
    persistSourceCookies();
  },
});
if (batchProcessEnabled()) {
  console.log(`[batch] B1 批处理子进程已启用（YUEDU_BATCH_PROCESS=${process.env['YUEDU_BATCH_PROCESS'] ?? '默认开'}）`);
}
if (b2ProcessEnabled()) {
  console.log('[batch] B2 重活下放已启用（YUEDU_B2_PROCESS=1）：登录求值→子进程，源变更→reload+版本闸');
  /**
   * **B2 预热**：子进程第一次任务要装载 763 源（实测 8~10s）。启动后在空闲时先付掉这笔钱，
   * 免得用户第一次点「登录」等 10s（`[stall] slow（循环仍活）` 那条就是这么来的）。
   * 失败只记日志 —— 下次真实任务会重启并装载。
   */
  setTimeout(() => {
    const t0 = Date.now();
    void batchRunner
      .run('warmup')
      .then((r) => console.log(`[batch] B2 预热完成：${JSON.stringify(r)} · ${Date.now() - t0}ms`))
      .catch((e) => console.warn(`[batch] B2 预热失败（不影响功能）：${e instanceof Error ? e.message : String(e)}`));
  }, 1500).unref?.();
}

/**
 * 源改动统一落盘入口（**只有一条路**）：
 *  · raw  → 整行写回源库（`remember` 排队 + `persist` 一次事务）
 *  · state→ 同一行三个列，不再有「文件源开关寄存在覆盖层」的第二套映射
 */
function persistSource(id: string): void {
  sourceLayer.remember(id);
  sourceLayer.persist();
}

/**
 * `#753` B2：源库变更后的**子进程失效钩子**。
 *
 * 只在「用户改了源」的路径上调（导入 / 编辑保存 / 删除 / 恢复 / 开关）——
 * 批量校验的回放打标（`persistSource`）**不算**：那会每跑完一个校验任务就 bump 版本、
 * 让子进程丢一次快照（下次任务白付 6s 冷启动）。
 *
 * 版本号递增后：
 *  · 已有子进程 ⇒ 推 `reload`，在飞任务结束后丢 hub 快照；
 *  · 没有子进程 ⇒ 下次 fork 的第一次任务带新版本；
 *  · 在飞任务的结果版本已旧 ⇒ 到主进程被 `stale` 闸**丢弃**（不会把旧快照结果写回新状态）。
 *  `YUEDU_B2_PROCESS` 关时调用仍安全（只是多一次版本号自增，没人消费；不给子进程推送也无人订阅）。
 */
function markSourcesChanged(reason: string): void {
  if (!b2ProcessEnabled()) return;
  batchRunner.notifySourcesChanged(reason);
}

// ---------------------------------------------------------------------------
// Fastify
// ---------------------------------------------------------------------------
// bodyLimit 上调到 256MB：大源合集（20~30MB 粘贴/上传）不会再被 413 拒。
const app = Fastify({ logger: false, bodyLimit: 256 * 1024 * 1024 });

// CORS：**白名单，不是通配**。判据与理由见 `cors.ts`（那里能测；本文件有 app.listen 副作用、不可测）。
// 一句话版：原先是 `*` 且 `/api` 无鉴权 ⇒ 本机任意网页能读走用户数据与源登录凭据；
// 而前端全部走相对路径 `/api`（开发走 vite proxy、生产同源）⇒ 收紧后合法路径一个都不受影响。
app.addHook('onRequest', async (req, reply) => {
  const allow = corsOriginFor(req.headers.origin);
  if (allow) {
    reply.header('Access-Control-Allow-Origin', allow); // 回显来源，**不是 `*`**
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type');
  } else {
    // `#375` 沙箱 iframe 对 `/api/proxy` 的预检放行（`#326` GET 特例的预检半边）。
    // 判据与安全论证见 `cors.ts` 的 `corsPreflightFor` —— 不满足特例 ⇒ 依旧一个头都不加。
    const pre = corsPreflightFor(
      req.headers.origin,
      req.method,
      req.url,
      req.headers['access-control-request-headers'],
    );
    if (pre) for (const [k, v] of Object.entries(pre)) reply.header(k, v);
  }
  // ★ 不在白名单 ⇒ **一个 CORS 头都不加**，浏览器据此拒绝把响应交给调用方。
  //  （服务端没法阻止请求本身；能阻止的是「被跨源页面读到」。被拦下的写入也会因预检失败而不发生。）
  if (req.method === 'OPTIONS') reply.code(204).send();
});

/* `#477`（2026-10-16）：**全请求埋点** —— TTY 日志之外仍有 5~70s 同步停摆
   （`recover ms=17367/62313/70562`），`diag.blocks` 只对得上 `data-persist`(912ms) ⇒
   还有一条**未埋点的同步路径**，发生在 listen 后 / 首次请求。
   把**每个请求**都变成一个可追踪动作：停摆发生时，看门狗快照（`inflightSnapshot`）
   就能直接点名「卡死时在飞的是哪个请求」—— 首要嫌疑是静态文件服务的
   `fs.readFileSync`（server-bundle 18MB / web dist assets，首访 + Defender 扫描），
   但**先取证再定罪**。收尾走 onSend + onResponse 双保险（trackEnd 幂等，重复调用无害）。 */
type StallEnd = { __stallEnd?: () => void };
app.addHook('onRequest', async (req) => {
  (req as unknown as StallEnd).__stallEnd = trackStart(`req ${req.method} ${String(req.url).slice(0, 90)}`);
});
app.addHook('onSend', async (req) => {
  (req as unknown as StallEnd).__stallEnd?.();
});
app.addHook('onResponse', async (req) => {
  (req as unknown as StallEnd).__stallEnd?.();
});

function publicSource(s: ReturnType<EngineHub['listSources']>[number]) {
  const raw = (s.raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : undefined);
  const num = (k: string) => (typeof raw[k] === 'number' ? (raw[k] as number) : undefined);
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    /**
     * `#335` **源的源地址**（`bookSourceUrl` / `sourceUrl`）。
     * 为什么必须下发：`id` 是它**有损规范化**后的形态（路径里的 `/` 也被换成 `_`），
     * 反解不回原地址；而「网页型订阅源直接打开阅读页」需要**原地址**去取页。
     */
    url: str('bookSourceUrl') ?? str('sourceUrl') ?? '',
    /**
     * `#307` **源图标** —— 用户口径：「legado 订阅源有 `sourceIcon` 项，如果设置了，
     * 应加载该地址指向图标；加载失败，或未设置：按我们目前的形式（首字母头像）」。
     *
     * ★ 字段出处（已核实，不猜测）：上游 `RssSource.sourceIcon`（`RssSource.kt:21`）。
     *   `BookSource` **没有**图标字段（grep `Icon` 零命中）⇒ 书源这边恒空、走首字母头像。
     *   前端只负责「有就显示、失败就回落」，不认上游字段名。
     */
    icon: str('sourceIcon'),
    state: s.state,
    addedAt: s.addedAt,
    group: str('bookSourceGroup') ?? str('group'),
    customOrder: num('customOrder'),
    respondTime: num('respondTime'),
    comment: str('bookSourceComment'),
    loginUrl: str('loginUrl'),
    lastUpdateTime: num('lastUpdateTime'),
    // 登录形态：none / url、config-url（开登录页）· js（执行脚本）· ui（loginUi 表单/按钮）
    // ⚠️ 必须带 loginUi 一起判：`ui` 形态由 loginUi 决定（loginUrl 只是它内部的 login() 脚本）。
    // 只传 loginUrl 时禁漫天堂这类源会被误报成 'js'，前端源列表的登录标记与实际对话框不一致。
    loginKind: classifyLoginUrl(str('loginUrl'), str('loginUi')).kind,
    loginNeedBrowser: classifyLoginUrl(str('loginUrl'), str('loginUi')).needBrowser,
    hasLoginInfo: Object.keys(hub.getSourceLoginInfo(s.id)).length > 0,
    // 是否具备发现能力：对齐 Legado BookSourcePart.hasExploreUrl
    // （`exploreUrl is not null and trim(exploreUrl) <> ''`）+ DAO「发现」查询的
    // `enabledExplore = 1 and hasExploreUrl = 1`。ruleExplore 只是解析规则，
    // 没有 exploreUrl 的源在 Legado 发现页里根本不出现。
    /**
     * ⚠️ 上面这条是 `exploreEnabled`（**用户开关**），与 `hasExplore`（**能力事实**）正交。
     *    RSS 订阅源**没有**发现开关（上游 `RssSource` 无 `enabledExplore`，见 `#310`），
     *    前端据此不为它渲染滑块；同时发现页对 rss **不读** `exploreEnabled`
     *    （`apps/web/src/utils/source-gate.ts` 的 `exploreUsable`）——
     *    否则该值一旦被写脏，源会从发现页消失却没有任何开关能恢复。
     *
     * `#310`：判据已抽到 `./source-caps.ts`（`computeHasExplore`）以便单测。
     */
    hasExplore: computeHasExplore(s.kind, raw),
    /**
     * `#293` **是否具备搜索能力**（源列表的「搜索」滑块 / 🔍 按钮、发现页的 ⌕ 搜索按钮
     * 全部以它为准 —— 没有搜索规则的源点了也没结果，入口不该出现）。
     *
     * `#310`：判据已抽到 `./source-caps.ts`（`computeHasSearch`），
     * 含「补上 `rss` 分支」的完整依据 —— 那边有单测（`src/__tests__/source-caps.test.ts`）。
     */
    hasSearch: computeHasSearch(s.kind, raw),
    /**
     * `#335` **网页型订阅源**（`singleUrl === true`）：点开就是一张网页，
     * 发现页应对它「点源 ⇒ 直接打开阅读页」（判据唯一实现见 `source-caps.ts`）。
     */
    webViewOnly: computeWebViewOnly(s.kind, raw),
    /**
     * `#404` **订阅源有「启动页」**（`startHtml` 非空）—— 发现页据此决定是否去调
     * `action=start` 取启动页 HTML。判据唯一实现见 `source-caps.ts`（静态近似，
     * 真值以 `start` 返回的 `html` 是否非空为准）。
     */
    hasStartPage: computeHasStartPage(s.kind, raw),
    /**
     * `#583` **源自绘 UI 的两个开关**（Legado `BookSource.customButton` / `eventListener`）：
     *  · `customButton`   ⇒ 详情页应显示一枚「源按钮」，点击发 `clickCustomButton`；
     *  · `eventListener`  ⇒ 源会处理 `callBackJs`（七猫：点书名/按钮弹书评面板）。
     *
     * 前端据此决定是否渲染按钮 —— 没有这两个开关的源一个像素都不多。
     */
    customButton: raw['customButton'] === true,
    eventListener: raw['eventListener'] === true,
    /**
     * `#237` **源类型**（文本 / 音频 / 图片 / 文件 / 视频）—— 发现页与规则工坊的筛选下拉要用。
     *
     * ## 数据来源：上游 `BookSource.bookSourceType`（`BookSource.kt:41`，默认 0）
     * ⚠️ **别和 `kind` 搞混**：`kind` 是**引擎**（legado / maccms / demo），
     *   `sourceType` 才是**源产出的内容形态**。两者正交：maccms 源是 `video` 型，
     *   legado 源可以是文本也可以是视频（红牛资源 `bookSourceType=2` 是图片型）。
     *
     * ## 映射照抄引擎侧 `mapKind`（`engine-legado/src/engine.ts:1217`）
     * 1=音频 2=图片 3=文件 4=视频，**其余（含 0 / 缺省）= 文本**。
     * ★ 为什么不直接让前端读 raw：raw 是**引擎私有结构**（maccms/demo 根本没有这个字段），
     *   前端直接读等于把「上游字段名」泄漏到界面层，两边一漂移就出错。
     *   CMS 源恒 `video`（AppleCMS 就是影视站）—— 这是**能力层面的事实**，不是配置。
     */
    sourceType: sourceTypeOf(s.kind, num('bookSourceType')),
    /**
     * `#238` **是否处于置顶态** —— 由服务端的置顶名单决定（不是前端拿 `customOrder` 猜的）。
     *
     * 为什么必须服务端给：多源置顶时，好几个源的 `customOrder` 都比别的小
     * ⇒ 前端「严格小于其余所有源」那种判据**只可能有一个**成立。
     */
    pinned: pinState.ids.includes(s.id),
    /**
     * `B6` **体检结果**（五态 + 质量分 + `deadUntil`）。
     * 前端：源管理列表展示质量列/五态标记；搜索与换源的候选排序按 `effectiveSourceQuality`；
     * `dead` 且未过期的源不参与搜索/换源（`isSourceHealthDeadActive`）。
     */
    health: sourceHealthStore.get(s.id),
  };
}

/**
 * `#237` 引擎 kind + 上游 `bookSourceType` ⇒ 统一的源类型。
 * 映射与 `engine-legado` 的 `mapKind` 一致（0/缺省=文本、1=音频、2=图片、3=文件、4=视频）。
 */
function sourceTypeOf(engineKind: string, bookSourceType: number | undefined): 'text' | 'audio' | 'image' | 'file' | 'video' {
  // CMS 引擎（maccms）产出的永远是影视内容，不看 bookSourceType（它没这个字段）
  if (engineKind === 'maccms') return 'video';
  switch (bookSourceType) {
    case 1:
      return 'audio';
    case 2:
      return 'image';
    case 3:
      return 'file';
    case 4:
      return 'video';
    default:
      return 'text';
  }
}

// 列出已注册引擎
// 内部：桌面端注册/注销 WebViewProvider 渲染桥端口（本机 127.0.0.1，无鉴权）
app.post<{ Body: { port?: number } }>('/api/internal/renderer', async (req, reply) => {
  const port = Number(req.body?.port ?? 0);
  renderBridgePort = port > 0 ? port : 0;
  return reply.send({ ok: true, renderBridgePort });
});

app.get('/api/engines', async () => hub.registry.list());

/**
 * 用户数据存储自检（Phase 1.2）。
 *
 * 为什么要有这个端点：存储层是「静默失效」高发区 —— 一旦 `node:sqlite` 不可用而回落到 JSON 实现，
 * 功能看着正常但性能差一个数量级（书架列表 2ms vs 4228ms）。把实现种类与降级原因暴露出来，
 * 排查时一眼定位，不用去猜。
 */
app.get('/api/user/_health', async (_req, reply) => {
  try {
    const { store, degraded, reason } = await userStoreReady;
    return {
      kind: store.kind,
      degraded,
      ...(reason === undefined ? {} : { reason }),
      dir: DATA_DIR,
      counts: {
        books: await store.countBooks(),
        readRecords: (await store.listReadRecords()).length,
        replaceRules: (await store.listReplaceRules()).length,
        bookGroups: (await store.listBookGroups()).length,
        cacheEntries: (await store.cacheList()).length,
      },
      blobs: { count: Object.keys(blobStore.list()).length, bytes: blobStore.totalSize() },
    };
  } catch (e) {
    // 打不开存储时如实上报，而不是让端点 500 掉
    return reply.code(503).send({ error: 'USER_STORE_UNAVAILABLE', detail: String(e instanceof Error ? e.message : e) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1.3 · 用户数据 REST（/api/user/*）
// ═══════════════════════════════════════════════════════════════════════════
//
// ## 两条刻意的设计选择（别改成"更 RESTful"的样子）
// 1. **标识一律走 query/body，不用路径参数**（`?bookUrl=` 而不是 `/books/:bookUrl`）。
//    因为 `bookUrl` 里含 `/` `:` `?`，当路径参数会破坏路由 —— 项目在「源 id」上踩过同一个坑
//    （见 `safeSourceId`）。用户数据的身份不该为了 URL 好看而被改写。
// 2. **写端点接受"不完整对象"，缺字段用契约层的工厂补默认值**：前端迁移期（1.4）会分批发送，
//    严格要求全字段只会把复杂度推给调用方。补默认值一律用 `emptyXxx()`，**不在端点里手写字面量**
//    （否则默认值会分散到多处漂移）。
//
// ## 为后续 WebDAV 留的余地
// `/api/user/snapshot` 可一次导出全部用户数据（元数据级；`includeChapters=1` 才带目录），
// 打包上传/换设备恢复都走它，不需要新增协议。

/** 去掉值为 `undefined` 的键：否则会把契约默认值覆盖成 undefined（SQLite 不接受 undefined 绑定） */
function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** 取用户数据存储；不可用时回 503 并返回 null（避免每个端点重复 try/catch） */
async function userStoreOr503(reply: FastifyReply): Promise<UserDataStore | null> {
  try {
    const { store, degraded } = await userStoreReady;
    // 降级（JSON 回落实现）对调用方是重要信息：性能差一个数量级，暴露在响应头里便于排查
    if (degraded) reply.header('x-yuedu-user-store-degraded', '1');
    return store;
  } catch (e) {
    void reply.code(503).send({
      error: 'USER_STORE_UNAVAILABLE',
      detail: String(e instanceof Error ? e.message : e),
    });
    return null;
  }
}

/* ============================================================================
 * `#210` 定时更新书架（调度器 + 端点见 /api/shelf-update*）
 * 依赖注入：store 与 hub 都是本文件的既有单例，这里只包一层。
 * ========================================================================== */
const CRASH_LOG_DIR = path.join(DATA_DIR, 'logs');
const shelfUpdater = new ShelfUpdater({
  dataDir: DATA_DIR,
  gapMs: 300,
  listBooks: async () => {
    const { store } = await userStoreReady;
    return store.listBooks();
  },
  // ★ `#302` 两处修复（2026-10-06 用户实测「整轮 14 本全失败」）：
  // ① detail 的 id 不能直接用书行的 bookUrl（那是 encodeItemKey 主键，含 `%00` 分隔符）——
  //    maccms 书会 SELECTOR_MISS、legado 书 URL 前面多了 sourceId 段。先还原成引擎认识的 id。
  // ② saveBook 传的是**补丁**（只有 bookUrl/type/lastCheck* 几个键），直接 upsert 会让
  //    其余字段全是 undefined ⇒ node:sqlite 报「Provided value cannot be bound to SQLite
  //    parameter 1」⇒ 凡是 detail 拉成功的书也全被记成失败。必须先取原行合并。
  saveBook: async (b) => {
    const { store } = await userStoreReady;
    const cur = await store.getBook(b.bookUrl);
    if (!cur) {
      // 书在整轮跑到一半时被移出了书架：不复活、不硬造行（造行必然缺字段）——但必须留痕
      console.warn(`[shelf-update] 书已不在书架，跳过写回：${b.bookUrl}`);
      return;
    }
    await store.upsertBook(normalizeLocalBookOriginName({ ...cur, ...b }));
  },
  // detail 走 hub（护栏/池/trace/超时全部在那层生效）——这里只把「detail 的 id = bookUrl」钉死
  fetchDetail: async (sourceId, bookUrl) =>
    (await hub.run(
      'detail',
      sourceId,
      {
        action: 'detail',
        id: detailIdFromBookUrl(bookUrl),
      },
      undefined,
      // `#496` 书架定时更新是**后台任务** ⇒ 撞 WAF 时不要起有头（用户没在操作）
      { background: true },
    )) as UnifiedDetail,
  recordCrash: (message) => void recordCrash('record', new Error(message), CRASH_LOG_DIR),
});
shelfUpdater.loadConfig(); // 启动即读配置并起 60s 懒时钟（读不到文件 = 默认开 / 60 分钟）

/** 查询参数里的数字（位掩码/分页用同一种"缺省即 undefined"语义） */
function qNum(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const BOOK_SORTS: readonly BookshelfSort[] = ['lastRead', 'manual', 'name', 'author', 'latestChapter', 'updateTime'];
function qSort(v: string | undefined): BookshelfSort | undefined {
  return v && (BOOK_SORTS as readonly string[]).includes(v) ? (v as BookshelfSort) : undefined;
}

/* ---------------- 书架 ---------------- */

app.get<{ Querystring: { group?: string; type?: string; search?: string; sort?: string; limit?: string; offset?: string } }>(
  '/api/user/books',
  async (req, reply) => {
    const store = await userStoreOr503(reply);
    if (!store) return;
    return store.listBooks({
      ...(qNum(req.query.group) === undefined ? {} : { group: qNum(req.query.group)! }),
      ...(qNum(req.query.type) === undefined ? {} : { type: qNum(req.query.type)! }),
      ...(req.query.search ? { search: req.query.search } : {}),
      ...(qSort(req.query.sort) ? { sort: qSort(req.query.sort)! } : {}),
      ...(qNum(req.query.limit) === undefined ? {} : { limit: qNum(req.query.limit)! }),
      ...(qNum(req.query.offset) === undefined ? {} : { offset: qNum(req.query.offset)! }),
    });
  },
);

/**
 * **删除墓碑**（跨端一致删除，用户 2026-11-08）。
 *
 * 前端在启动对齐时先拉这份，把「比墓碑更旧的」本地/服务端条目一并剔除 ——
 * 否则另一端陈旧缓存会把已删行重新 PUT 回来（`pull({ mergeLocal: true })` 的历史行为）。
 * 详见 `@yuedu/core` 契约层的 `BookTombstone` 注释。
 */
app.get<{ Querystring: { since?: string } }>('/api/user/books/deleted', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  return { deleted: await store.listBookTombstones(qNum(req.query.since)) };
});

app.get<{ Querystring: { bookUrl?: string } }>('/api/user/books/one', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = req.query.bookUrl ?? '';
  if (!bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED' });
  const book = await store.getBook(bookUrl);
  if (!book) return reply.code(404).send({ error: 'BOOK_NOT_FOUND' });
  return book;
});

app.put<{ Body: Partial<ShelfBook> }>('/api/user/books', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const body = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  if (typeof body['bookUrl'] !== 'string' || body['bookUrl'] === '') {
    return reply.code(400).send({ error: 'BOOK_URL_REQUIRED' });
  }
  // 缺字段用契约默认值补齐（`emptyShelfBook` 是默认值的唯一来源）
  let book: ShelfBook = { ...emptyShelfBook(), ...(body as Partial<ShelfBook>) };
  // ★ `#217`：**别让前端把 `originName` 冲成空**。前端契约里**没有**这个字段（文件名只存在于
  //   bookUrl 的 payload 里）⇒ 任何一次 PUT（同步进度 / 改分组 / 换封面）都会把它覆盖成 `''`。
  //   归一逻辑已下沉契约层（`normalizeLocalBookOriginName`）—— 这里不再内联反推，
  //   否则就是「同一判据写两处」。
  book = normalizeLocalBookOriginName(book);
  // 反推不出来时**保留库里已有的值**（宁可留旧的，也别清空）：这条只在 PUT 有意义
  // （其它写路径是整对象覆盖，没有「旧值」概念）。
  if (!book.originName) {
    const prev = await store.getBook(book.bookUrl);
    if (prev?.originName) book.originName = prev.originName;
  }
  await store.upsertBook(book);
  return { ok: true, bookUrl: book.bookUrl };
});

/* ============================================================================
 * `#204` 封面自定义 —— 上传 / 回读 / 清除
 *
 * ## 为什么存 blob 而不是直接写文件
 * 已有 {@link blobStore}（`user-store/blobs.ts`）：按 `sha256(key)` 分片落盘 + 独立索引，
 * 天然规避路径穿越，且有 LRU 清理。所以自定义封面**走 blob**，`customCoverUrl` 里存
 * 一个**同源相对 URL**（`/api/blobs/<key>`）—— 不引入新存储概念，也不让前端碰绝对路径。
 *
 * ## 覆盖语义（照上游 Legado 的「换封面」）
 * 用户上传 ⇒ 覆盖同一本书的封面（**替换**，不是叠一层历史版本）；
 * 清除 ⇒ `customCoverUrl` 置 null ⇒ `displayCover` 自动回落到 `coverUrl`（源封面）。
 * blob 本身**不立刻删**：同一本书可能反复换，留着可回滚，且 blob 有 LRU 兜底。
 * ========================================================================== */

/** 允许的封面类型（白名单，不按扩展名猜 —— 用户可能传的是无扩展名的 blob 文件） */
const COVER_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
/** 单张封面上限：8MB。超了直接拒，不截断（截断的图用户看不出问题，只会觉得"糊了"） */
const COVER_MAX_BYTES = 8 * 1024 * 1024;

/** blob key 用书的主键 + 固定前缀 ⇒ 同一本书重复上传是**覆盖同一个 blob** */
/**
 * blob key 由书的主键**哈希**而来（不是直接拼 bookUrl）。
 *
 * ★ 为什么不用 `cover:${bookUrl}` 当 key：本地书的 bookUrl 形如
 *   `loc_book%00{"fileName":"点我封面.txt"}` —— 含 `: { } " %` 等字符。
 *   塞进 URL 就得重度编码（`%2500` 表示「key 里有 `%00`」），**任何一层多解码/少解码一次就 404**，
 *   而且这种 key 出现在日志/报错里完全不可读。哈希后是纯 hex，`customCoverUrl` 干净且稳定。
 */
const coverBlobKey = (bookUrl: string): string => `cover-${createHash('sha256').update(bookUrl).digest('hex').slice(0, 32)}`;

app.put<{ Querystring: { bookUrl?: string } }>('/api/user/books/cover', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = String(req.query?.bookUrl ?? '').trim();
  if (!bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED', detail: '需要 bookUrl' });

  const book = await store.getBook(bookUrl);
  if (!book) return reply.code(404).send({ error: 'BOOK_NOT_FOUND', bookUrl });

  const mime = String((req.headers['x-cover-type'] ?? '') as string).toLowerCase();
  if (!COVER_MIME[mime]) {
    return reply.code(400).send({
      error: 'COVER_TYPE_UNSUPPORTED',
      detail: `不支持的封面类型：${mime || '(空)'}（支持 ${Object.keys(COVER_MIME).join(' / ')}）`,
    });
  }
  const body = req.body as Buffer | undefined;
  if (!body?.length) return reply.code(400).send({ error: 'EMPTY_BODY', detail: '封面文件是空的' });
  if (body.byteLength > COVER_MAX_BYTES) {
    return reply.code(413).send({
      error: 'COVER_TOO_LARGE',
      detail: `封面 ${(body.byteLength / 1024 / 1024).toFixed(1)}MB，超过上限 ${COVER_MAX_BYTES / 1024 / 1024}MB`,
    });
  }

  const key = coverBlobKey(bookUrl);
  blobStore.put(key, body, mime);
  // ★ 只改 customCoverUrl，**其余字段一律沿用库里那份** ——
  //   PUT /api/user/books 是「整条 upsert + 缺字段补默认值」，用它改一个字段会
  //   把没传的字段重置成默认值（实测会丢 durChapterIndex 等进度）。所以必须 get→改→upsert。
  //   ★ `#217`：这里**顺带修复历史脏行** —— 库里的 `originName` 若为空（老版本写入的），
  //   过一趟归一就自愈；自洽的行原样返回（`normalizeLocalBookOriginName` 不碰非空值）。
  const next: ShelfBook = normalizeLocalBookOriginName({ ...book, customCoverUrl: `/api/blobs/${encodeURIComponent(key)}` });
  await store.upsertBook(next);
  return { ok: true, bookUrl, customCoverUrl: next.customCoverUrl, bytes: body.byteLength };
});

/** 清除自定义封面 ⇒ 回落到源封面（`displayCover` 的优先级：persisted > custom > coverUrl） */
app.delete<{ Querystring: { bookUrl?: string } }>('/api/user/books/cover', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = String(req.query?.bookUrl ?? '').trim();
  if (!bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED', detail: '需要 bookUrl' });
  const book = await store.getBook(bookUrl);
  if (!book) return reply.code(404).send({ error: 'BOOK_NOT_FOUND', bookUrl });
  // 同上：整条 upsert，必须带上库里那份
  const next: ShelfBook = normalizeLocalBookOriginName({ ...book, customCoverUrl: null });
  await store.upsertBook(next);
  return { ok: true, bookUrl, customCoverUrl: null };
});

/**
 * 直接把 `customCoverUrl` 设成用户给的图片地址（**不下载、不存 blob**）。
 *
 * 与上传端点的区别：上传是「把字节收进来」，这里是「只记一个外链」。
 * 好处是跨设备可用、零服务端存储；代价是那个 URL 挂了封面就空（所以清除按钮必须留着）。
 * ★ 同样必须 get→改→upsert（理由见上传端点里的注释）。
 */
app.put<{ Querystring: { bookUrl?: string }; Body: { customCoverUrl?: string } }>(
  '/api/user/books/cover-url',
  async (req, reply) => {
    const store = await userStoreOr503(reply);
    if (!store) return;
    const bookUrl = String(req.query?.bookUrl ?? '').trim();
    if (!bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED', detail: '需要 bookUrl' });
    const url = String(req.body?.customCoverUrl ?? '').trim();
    if (!url) return reply.code(400).send({ error: 'COVER_URL_REQUIRED', detail: 'customCoverUrl 不能为空' });
    // ★ 只放行 http(s) 与站内绝对路径：`javascript:` / `data:` 塞进 <img src> 是注入面。
    //   （前端也挡了一次，但服务端不能信任客户端。）
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
      return reply.code(400).send({
        error: 'COVER_URL_INVALID',
        detail: '只支持 http(s) 开头或 / 开头的站内路径',
      });
    }
    const book = await store.getBook(bookUrl);
    if (!book) return reply.code(404).send({ error: 'BOOK_NOT_FOUND', bookUrl });
    const next: ShelfBook = normalizeLocalBookOriginName({ ...book, customCoverUrl: url });
    await store.upsertBook(next);
    return { ok: true, bookUrl, customCoverUrl: url };
  },
);

/** 回读 blob（自定义封面的实际字节）。`type` 来自索引（上传时记的），不是猜的。 */
app.get<{ Params: { key: string } }>('/api/blobs/:key', async (req, reply) => {
  const key = String(req.params?.key ?? '');
  if (!key) return reply.code(400).send({ error: 'KEY_REQUIRED' });
  const meta = blobStore.stat(key);
  if (!meta) return reply.code(404).send({ error: 'BLOB_NOT_FOUND', key });
  const buf = blobStore.get(key);
  if (!buf) return reply.code(404).send({ error: 'BLOB_NOT_FOUND', key });
  return reply
    .header('content-type', meta.type ?? 'application/octet-stream')
    .header('cache-control', 'private, max-age=86400')
    .send(Buffer.from(buf));
});

app.post<{ Body: { books?: Partial<ShelfBook>[] } }>('/api/user/books/batch', async (req, reply) => {  const store = await userStoreOr503(reply);
  if (!store) return;
  const raw = Array.isArray(req.body?.books) ? req.body.books : [];
  const books: ShelfBook[] = [];
  const skipped: number[] = [];
  raw.forEach((it, i) => {
    const merged = { ...emptyShelfBook(), ...stripUndefined((it ?? {}) as Record<string, unknown>) } as ShelfBook;
    if (!merged.bookUrl) skipped.push(i);
    // ★ `#217`：批量写同样要过归一 —— `emptyShelfBook()` 起底会把 `originName` 补成 `''`，
    //   而批量端点**没有**「旧值」可保留（它就是用来覆盖对齐的）⇒ 反推不出来就只能留空。
    else books.push(normalizeLocalBookOriginName(merged));
  });
  const res = await store.upsertBooks(books);
  return { ok: true, ...res, skipped };
});

app.delete<{ Querystring: { bookUrl?: string } }>('/api/user/books', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = req.query.bookUrl ?? '';
  if (!bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED' });
  // 目录随外键级联删除（JSON 回落实现里是手写的等价物）
  return { ok: await store.deleteBook(bookUrl), bookUrl };
});

/** 高频轻量端点：只更新 6 个进度字段，不整本重写（阅读时每次翻章都会打） */
app.put<{ Body: { bookUrl?: string } & Partial<ProgressPatch> }>('/api/user/books/progress', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = req.body ?? {};
  if (!b.bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED' });
  if (typeof b.durChapterIndex !== 'number' || typeof b.durChapterPos !== 'number') {
    return reply.code(400).send({ error: 'PROGRESS_FIELDS_REQUIRED', detail: '需要 durChapterIndex 与 durChapterPos' });
  }
  const patch = stripUndefined({
    durChapterIndex: b.durChapterIndex,
    durChapterPos: b.durChapterPos,
    durChapterTime: b.durChapterTime,
    durChapterTitle: b.durChapterTitle,
    durVolumeIndex: b.durVolumeIndex,
    chapterInVolumeIndex: b.chapterInVolumeIndex,
  }) as ProgressPatch;
  const ok = await store.saveProgress(b.bookUrl, patch);
  if (!ok) return reply.code(404).send({ error: 'BOOK_NOT_FOUND' });
  return { ok: true };
});

/* ---------------- 目录 ---------------- */

app.get<{ Querystring: { bookUrl?: string } }>('/api/user/chapters', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = req.query.bookUrl ?? '';
  if (!bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED' });
  const chapters = await store.listChapters(bookUrl);
  return { total: chapters.length, chapters };
});

app.put<{ Body: { bookUrl?: string; chapters?: Partial<ShelfChapter>[] } }>('/api/user/chapters', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = req.body?.bookUrl ?? '';
  if (!bookUrl) return reply.code(400).send({ error: 'BOOK_URL_REQUIRED' });
  const raw = Array.isArray(req.body?.chapters) ? req.body.chapters : [];
  // 全量替换语义：index 缺省按数组顺序补，避免 (bookUrl,index) 唯一约束撞车
  const chapters: ShelfChapter[] = raw.map((c, i) => {
    const merged = { ...emptyShelfChapter(bookUrl, i), ...stripUndefined((c ?? {}) as Record<string, unknown>) } as ShelfChapter;
    return { ...merged, bookUrl };
  });
  const res = await store.replaceChapters(bookUrl, chapters);
  return { ok: true, bookUrl, ...res };
});

app.post<{ Body: { chapters?: Partial<ShelfChapter>[] } }>('/api/user/chapters/batch', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const raw = Array.isArray(req.body?.chapters) ? req.body.chapters : [];
  const chapters: ShelfChapter[] = [];
  const skipped: number[] = [];
  raw.forEach((c, i) => {
    const merged = { ...emptyShelfChapter(), ...stripUndefined((c ?? {}) as Record<string, unknown>) } as ShelfChapter;
    if (!merged.bookUrl || !merged.url) skipped.push(i);
    else chapters.push(merged);
  });
  const res = await store.upsertChapters(chapters);
  return { ok: true, ...res, skipped };
});

/* ---------------- 书签 ---------------- */

app.get<{ Querystring: { bookName?: string } }>('/api/user/bookmarks', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.listBookmarks(req.query.bookName);
  return { total: list.length, bookmarks: list };
});

app.put<{ Body: Partial<Bookmark> }>('/api/user/bookmarks', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  if (typeof b['time'] !== 'number') return reply.code(400).send({ error: 'TIME_REQUIRED' });
  const mark: Bookmark = { ...emptyBookmark(b['time'] as number), ...(b as Partial<Bookmark>) };
  await store.upsertBookmark(mark);
  return { ok: true, time: mark.time };
});

app.delete<{ Querystring: { time?: string } }>('/api/user/bookmarks', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const time = qNum(req.query.time);
  if (time === undefined) return reply.code(400).send({ error: 'TIME_REQUIRED' });
  return { ok: await store.deleteBookmark(time), time };
});

/* ---------------- 高亮/笔记 ---------------- */

app.get<{ Querystring: { bookUrl?: string } }>('/api/user/highlights', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.listHighlights(req.query.bookUrl);
  return { total: list.length, highlights: list };
});

app.put<{ Body: Partial<BookHighlight> }>('/api/user/highlights', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  if (typeof b['time'] !== 'number') return reply.code(400).send({ error: 'TIME_REQUIRED' });
  const h: BookHighlight = { ...emptyBookHighlight(b['time'] as number), ...(b as Partial<BookHighlight>) };
  await store.upsertHighlight(h);
  return { ok: true, time: h.time };
});

app.delete<{ Querystring: { time?: string } }>('/api/user/highlights', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const time = qNum(req.query.time);
  if (time === undefined) return reply.code(400).send({ error: 'TIME_REQUIRED' });
  return { ok: await store.deleteHighlight(time), time };
});

/* ---------------- 书内备注（Legado BookMemo） ---------------- */

app.get<{ Querystring: { bookUrl?: string } }>('/api/user/book-memos', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.listBookMemos(req.query.bookUrl);
  return { total: list.length, memos: list };
});

app.put<{ Body: Partial<BookMemo> }>('/api/user/book-memos', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  if (typeof b['time'] !== 'number') return reply.code(400).send({ error: 'TIME_REQUIRED' });
  const memo: BookMemo = { ...emptyBookMemo(b['time'] as number), ...(b as Partial<BookMemo>) };
  await store.upsertBookMemo(memo);
  return { ok: true, time: memo.time };
});

app.delete<{ Querystring: { time?: string } }>('/api/user/book-memos', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const time = qNum(req.query.time);
  if (time === undefined) return reply.code(400).send({ error: 'TIME_REQUIRED' });
  return { ok: await store.deleteBookMemo(time), time };
});

/* ---------------- 搜索历史（服务端，跨端可用） ---------------- */

app.get<{ Querystring: { limit?: string } }>('/api/user/search-history', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const limit = qNum(req.query.limit);
  const list = await store.listSearchHistory(limit);
  return { total: list.length, history: list };
});

app.post<{ Body: { word?: string } }>('/api/user/search-history', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const word = String(req.body?.word ?? '').trim();
  if (!word) return reply.code(400).send({ error: 'WORD_REQUIRED' });
  const row = await store.recordSearch(word);
  return { ok: !!row, entry: row };
});

app.delete<{ Querystring: { word?: string; all?: string } }>('/api/user/search-history', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const word = String(req.query.word ?? '').trim();
  if (word && !req.query.all) return { ok: await store.deleteSearchHistory(word), word };
  return { ok: true, cleared: await store.clearSearchHistory() };
});

/* ---------------- 净化规则 ---------------- */

app.get('/api/user/replace-rules', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.listReplaceRules();
  return { total: list.length, rules: list };
});

app.put<{ Body: Partial<ReplaceRule> }>('/api/user/replace-rules', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  const id = typeof b['id'] === 'number' ? (b['id'] as number) : Date.now();
  const rule: ReplaceRule = { ...emptyReplaceRule(id), ...(b as Partial<ReplaceRule>), id };
  await store.upsertReplaceRule(rule);
  return { ok: true, id: rule.id };
});

app.delete<{ Querystring: { id?: string } }>('/api/user/replace-rules', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const id = qNum(req.query.id);
  if (id === undefined) return reply.code(400).send({ error: 'ID_REQUIRED' });
  return { ok: await store.deleteReplaceRule(id), id };
});

// `#266` 导入预览（**不写任何状态**）：text 直传；URL 由服务端抓取（绕开浏览器 CORS）。
// 解析与规范化在 @yuedu/core 的 parseReplaceRuleImport（与前端预览、提交共用同一份实现）。
// ★ 判重不在这里做：规则的写权威在前端 store（upsert → reconcile），
//   「新增/重复」分类由前端对照现有库 + 批内去重完成，提交也由前端走既有 upsert 路径。
app.post<{ Body: { text?: string; url?: string } }>('/api/user/replace-rules/import-preview', async (req, reply) => {
  const got = await resolveImportInput(req.body);
  if (!got.ok) return reply.code(400).send({ error: got.error });
  return { ...parseReplaceRuleImport(got.text), bytes: Buffer.byteLength(got.text, 'utf-8') };
});

/* ---------------- 高亮规则（`#262`：上游 HighlightRule 全链路） ---------------- */

app.get('/api/user/highlight-rules', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.listHighlightRules();
  return { total: list.length, rules: list };
});

app.put<{ Body: Partial<HighlightRule> }>('/api/user/highlight-rules', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  const base = emptyHighlightRule(typeof b['id'] === 'number' && b['id'] > 0 ? b['id'] : Date.now());
  const rule: HighlightRule = { ...base, ...(b as Partial<HighlightRule>) };
  // ★ uuid 是导入合并的判据（上游按 uuid.lowercase() 对齐）—— 缺失/非法就地补一个
  rule.uuid = /^[0-9a-fA-F-]{36}$/.test(String(rule.uuid ?? '')) ? String(rule.uuid) : newHighlightRuleUuid();
  if (!highlightRuleIsValid(rule)) {
    return reply.code(400).send({ error: 'INVALID_RULE', detail: 'pattern 为空，或正则无法编译' });
  }
  await store.upsertHighlightRule(rule);
  // ★ 响应必须回**实际入库**的 id，不能回请求里的：body id<=0 时走存储层 AUTOINCREMENT、
  //   uuid 冲突更新时本地 id 沿用（请求里的 id 会被忽略）—— 探针 #262 A1/A3 抓的正是这两处回显错。
  const saved = (await store.listHighlightRules())
    .find((x) => x.uuid.toLowerCase() === rule.uuid.toLowerCase());
  return { ok: true, id: saved ? saved.id : rule.id, uuid: rule.uuid };
});

app.delete<{ Querystring: { id?: string } }>('/api/user/highlight-rules', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const id = qNum(req.query.id);
  if (id === undefined) return reply.code(400).send({ error: 'ID_REQUIRED' });
  return { ok: await store.deleteHighlightRule(id), id };
});

/* ---------------- 字典规则（`#189`：此前只存前端 localStorage ⇒ 5173/3000 两个 origin 互不相通） ---------------- */

app.get('/api/user/dict-rules', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.listDictRules();
  return { total: list.length, rules: list };
});

app.put<{ Body: Partial<DictRule> }>('/api/user/dict-rules', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  const name = String(b['name'] ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'NAME_REQUIRED', detail: '字典名是主键' });
  const rule: DictRule = {
    name,
    urlRule: String(b['urlRule'] ?? ''),
    showRule: String(b['showRule'] ?? ''),
    enabled: b['enabled'] !== false,
    sortNumber: typeof b['sortNumber'] === 'number' ? (b['sortNumber'] as number) : 0,
  };
  await store.upsertDictRule(rule);
  return { ok: true, name: rule.name };
});

app.delete<{ Querystring: { name?: string } }>('/api/user/dict-rules', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const name = String(req.query?.name ?? '').trim();
  if (!name) return reply.code(400).send({ error: 'NAME_REQUIRED' });
  return { ok: await store.deleteDictRule(name), name };
});

/* ---------------- 本地书（`#202`：txt/epub 导入 + 取正文） ---------------- */

/**
 * 本地书原始文件目录（`<DATA_DIR>/local-books/`）。
 *
 * 为什么文件放服务端而不是浏览器：正文是从**原文件**按偏移/章节取的（见 `core/local-book`），
 * 放在服务端才能被「换设备后接着读」——本地书进了服务端书架，就不再依赖某一台机器的浏览器存储。
 */
const LOCAL_BOOK_DIR = path.join(DATA_DIR, 'local-books');

// Fastify 默认不解析 `application/octet-stream`（前端直接 PUT 文件字节用这个类型）
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),
);

/**
 * 本地书「文件名 → 磁盘路径」三件套都在 `./local-book-file`：
 * `safeLocalBookName`（导入侧洗名字）· `localBookPath`（拼路径 + 越界校验）·
 * `resolveLocalBookFile`（读取侧唯一入口：反推 → 拼路径 → 存在性，失败回 410 不抛）。
 */


/**
 * 把一个「已解析的本地书」落盘并入库（**单本导入与压缩包批量导入共用**，`#212` Step3 抽出）。
 *
 * 步骤（顺序有讲究）：
 * 1. **写文件**（同名覆盖 = 更新）—— 写在入库前：解析成功但写盘失败时**不该**在书架里
 *    留一条打不开的记录；
 * 2. 抽内嵌封面（epub）写 blob → `coverUrl`；
 * 3. 重新导入时**保留**阅读进度/排序/自定义封面/自定义简介；
 * 4. `upsertBook` + **全量替换该书的目录**。
 *
 * 返回**替换的目录行数**（`replaceChapters` 的返回；原单本导入端点回执里有这个字段，
 * 保留以免改变既有响应合同）。
 */
async function persistLocalBook(
  store: NonNullable<Awaited<ReturnType<typeof userStoreOr503>>>,
  parsed: LocalBookImport,
  bytes: Uint8Array,
  fileName: string,
): Promise<{ fileBytes: number; replacedChapters: unknown }> {
  // 先落盘再入库（见上）
  fs.mkdirSync(LOCAL_BOOK_DIR, { recursive: true });
  const filePath = localBookPath(LOCAL_BOOK_DIR, fileName);
  fs.writeFileSync(filePath, bytes);

  // 重新导入同一本书：保留阅读进度与排序（否则用户一更新文件就「从头开始」）
  const existing = await store.getBook(parsed.book.bookUrl);

  /**
   * `#212` Step2：从 epub 里抽出**内嵌封面**，存进 blob 并把 `coverUrl` 指向它。
   *
   * ## 为什么在**导入时**抽（而不是每次显示现取）
   * 书架列表要一次显示几十本的封面；若每本都去开 zip、解压、找 `cover-image`，
   * 一次列表刷新就是几十次 zip 解析。导入时抽一次（本来就在读这个文件）⇒ 之后零成本。
   *
   * ## 为什么写 `coverUrl` 而不是 `customCoverUrl`
   * 语义上内嵌封面是**这本书自带的封面 = 源封面**。`displayCover` 的优先级是
   * **persisted > custom > coverUrl** ⇒ 写 `coverUrl` 时：用户自定义封面仍然压得住它；
   * 用户「清除自定义封面」后又能自然回落到这里（而不是掉回空）。写 `customCoverUrl`
   * 会让「清除」把 epub 自带封面一起抹掉。
   *
   * ## 为什么用**独立的 blob key**（不复用 `coverBlobKey`）
   * `coverBlobKey` 是**用户自定义封面**的位置（`PUT /api/user/books/cover` 写它）。
   * 若两者共用同一个 key，重新导入这本书就会把用户精心挑的封面覆盖掉。
   * 用独立前缀 ⇒ 两套封面各占一个 blob，互不干扰；`displayCover` 负责让自定义的压在上面。
   *
   * ⚠️ 抽不到（无 cover-image / 格式不支持）或用户已有自定义封面 ⇒ 不写、
   * **不报错、不阻断导入**（封面是锦上添花，不能因为它让书导不进来）。
   */
  if (extOf(fileName) === '.epub' && !existing?.customCoverUrl) {
    try {
      const epub = parseEpub(bytes);
      const cover = epub.coverHref ? readEpubAsset(bytes, epub.coverHref) : null;
      if (cover && cover.length) {
        const key = localCoverBlobKey(parsed.book.bookUrl);
        blobStore.put(key, cover, mimeOfAsset(epub.coverHref!));
        parsed.book.coverUrl = `/api/blobs/${encodeURIComponent(key)}`;
      }
    } catch (e) {
      // 留痕但不阻断（封面失败不该让整本书导不进来）
      console.warn(`[local-book] 抽 epub 封面失败（不影响导入）${fileName}：${String(e instanceof Error ? e.message : e)}`);
    }
  }

  /**
   * `#212` Step4：MOBI/AZW3 的封面（EXTH `coverOffset` 指向的资源记录）。
   *
   * 与 epub 同一套落点策略（源封面 ⇒ `coverUrl`，独立 blob key，失败不阻断）。
   * ⚠️ 封面字节可能就是 JPEG/PNG/GIF，但 MOBI 不记扩展名 ⇒ 用**魔数**猜 MIME
   *   （猜不出就 `application/octet-stream`，至少不谎报成图片让 `<img>` 报错）。
   */
  const ext4 = extOf(fileName);
  if ((ext4 === '.mobi' || ext4 === '.azw3') && !existing?.customCoverUrl) {
    try {
      const cover = readMobiCover(bytes);
      if (cover && cover.length) {
        const key = localCoverBlobKey(parsed.book.bookUrl);
        blobStore.put(key, cover, mimeOfImageMagic(cover));
        parsed.book.coverUrl = `/api/blobs/${encodeURIComponent(key)}`;
      }
    } catch (e) {
      console.warn(`[local-book] 抽 mobi 封面失败（不影响导入）${fileName}：${String(e instanceof Error ? e.message : e)}`);
    }
  }

  const books = await store.listBooks();
  if (existing) {
    parsed.book.order = existing.order;
    parsed.book.durChapterIndex = existing.durChapterIndex;
    parsed.book.durChapterTitle = existing.durChapterTitle;
    parsed.book.durChapterPos = existing.durChapterPos;
    parsed.book.durChapterTime = existing.durChapterTime;
    parsed.book.group = existing.group;
    parsed.book.customCoverUrl = existing.customCoverUrl;
    parsed.book.customIntro = existing.customIntro;
  } else {
    // 新书排到最前（照上游 `order = minOrder - 1`）
    parsed.book.order = books.reduce((min, b) => Math.min(min, b.order ?? 0), 0) - 1;
  }

  await store.upsertBook(parsed.book);
  const replacedChapters = await store.replaceChapters(parsed.book.bookUrl, parsed.chapters);
  console.log(
    `[local-book] 导入 ${fileName} → ${parsed.summary.format} ${parsed.chapters.length} 章` +
      `（${parsed.summary.tocRuleName || '按长度切'}）· charset=${parsed.charset}`,
  );
  return { fileBytes: bytes.length, replacedChapters };
}

/**
 * 导入一个本地书文件。
 *
 * 请求：`POST /api/local-books/import`
 * 头：`x-file-name`（**URL 编码**的文件名，避免中文/空格在 HTTP 头里出问题）；
 *     可选 `x-book-charset` 强制指定 txt 编码。
 * 体：文件原始字节（`application/octet-stream`）。
 *
 * 行为：解析 → **写文件**（同名直接覆盖 = 更新）→ upsert 书 → **全量替换该书的目录**。
 * 抛错一律是「这个文件确实解析不了」，文案直接给用户看。
 */
app.post<{ Querystring: { bookUrl?: string } }>('/api/local-books/import', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const rawName = String((req.headers['x-file-name'] ?? '') as string);
  if (!rawName) {
    return reply.code(400).send({ error: 'FILE_NAME_REQUIRED', detail: '需要 x-file-name 头（URL 编码的文件名）' });
  }
  const body = req.body as Buffer | undefined;
  if (!body || !body.length) return reply.code(400).send({ error: 'EMPTY_BODY', detail: '文件是空的' });

  let fileName: string;
  try {
    fileName = safeLocalBookName(rawName);
  } catch (e) {
    return reply.code(400).send({ error: 'BAD_FILE_NAME', detail: String(e instanceof Error ? e.message : e) });
  }

  const charsetHint = String((req.headers['x-book-charset'] ?? '') as string) || null;
  let parsed;
  try {
    parsed = importLocalBook(new Uint8Array(body), fileName, charsetHint);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[local-book] 导入失败 ${fileName}：${msg}`);
    return reply.code(400).send({ error: 'LOCAL_BOOK_PARSE_FAILED', detail: msg, fileName });
  }

  /**
   * `bookUrl`（存储主键）**由前端传**：本仓的主键是前端算出来的
   * （`encodeItemKey(itemKey(origin, payload))`，见 `apps/web/src/utils/user-map.ts`），
   * 服务端自己编一个会导致「前端打开这本书时 key 对不上 ⇒ 认成不在书架」。
   * 不传时（curl / 脚本直连）用 core 给的默认值。
   */
  const clientBookUrl = String(req.query?.bookUrl ?? '').trim();
  if (clientBookUrl) parsed.book.bookUrl = clientBookUrl;

  const { fileBytes, replacedChapters } = await persistLocalBook(store, parsed, new Uint8Array(body), fileName);
  return {
    ok: true,
    book: parsed.book,
    chapterCount: parsed.chapters.length,
    replacedChapters,
    summary: parsed.summary,
    fileBytes,
  };
});

/**
 * 批量导入：把一个 **zip 压缩包**里的所有本地书一次导进书架（`#212` Step3）。
 *
 * 请求：`POST /api/local-books/import-archive`
 * 头：`x-file-name`（压缩包文件名，只用于日志）；可选 `x-book-charset`（透传给包内 txt）。
 * 体：zip 原始字节。
 *
 * ## 为什么放在服务端一次收包、内部逐本导
 * 若让前端先枚举、再逐本发 N 次请求：① 前端要自己解 zip（多一份会被写歪的实现）；
 * ② N 次往返在「一百本书」的量级上既慢又容易被中断。服务端一次收包 ⇒ 复用同一份
 * zip 读取器（`core` 的 `zip.ts`），并在一次请求里把每本都走**与单本导入完全相同**的
 * `persistLocalBook` 落库路径。**不做**「事务式全成功或全失败」——一个坏文件不该让
 * 另外几十本导不进来；失败逐条返回。
 *
 * ## 上限
 * `maxBooks` 默认 300（见 `archive.ts`）；超出部分**报数**（`skipped`），不静默丢弃。
 */
app.post('/api/local-books/import-archive', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const rawName = String((req.headers['x-file-name'] ?? '') as string);
  const body = req.body as Buffer | undefined;
  if (!body || !body.length) return reply.code(400).send({ error: 'EMPTY_BODY', detail: '压缩包是空的' });

  const charsetHint = String((req.headers['x-book-charset'] ?? '') as string) || null;
  const buf = new Uint8Array(body);

  let archive;
  let listed;
  try {
    archive = readCentralDirectory(buf);
    listed = listArchiveBooks(buf);
  } catch (e) {
    // 只在「整包读不出来」时 400（不是 zip / ZIP64 / 加密压缩方式）
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[local-book] 压缩包读取失败 ${rawName}：${msg}`);
    return reply.code(400).send({ error: 'ARCHIVE_READ_FAILED', detail: msg, fileName: rawName });
  }
  if (!listed.length) {
    return reply.code(400).send({
      error: 'ARCHIVE_NO_BOOKS',
      detail: '压缩包里没有可导入的书（只认 txt / epub / umd；会递归子目录，但会跳过 __MACOSX 等垃圾）',
      fileName: rawName,
    });
  }

  const results: Array<{ entry: string; name?: string; ok: boolean; error?: string; chapterCount?: number; format?: string; bookUrl?: string }> = [];
  let ok = 0;
  let failed = 0;
  for (const it of listed) {
    /**
     * 逐本走**与单本导入完全相同**的路径（`persistLocalBook`）。
     * 单个条目解析/落库失败 ⇒ 记原因继续（铁律 3：兜底留痕，绝不静默）。
     */
    let fileName: string;
    try {
      fileName = safeLocalBookName(it.name);
    } catch (e) {
      results.push({ entry: it.entry, name: it.name, ok: false, error: String(e instanceof Error ? e.message : e) });
      failed++;
      continue;
    }
    try {
      const entry = archive.byName.get(it.entry);
      if (!entry) throw new Error('条目在解压前消失了（zip 内同名重复？）');
      const bytes = readEntryBy(buf, entry);
      if (!bytes.length) throw new Error('条目是空的');
      const parsed = importLocalBook(bytes, fileName, charsetHint);
      await persistLocalBook(store, parsed, bytes, fileName);
      results.push({
        entry: it.entry,
        name: fileName,
        ok: true,
        chapterCount: parsed.chapters.length,
        format: parsed.summary.format,
        // 前端要拿它去归组（包内主键前端算不出来，见 user-data.ts 注释）
        bookUrl: parsed.book.bookUrl,
      });
      ok++;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.warn(`[local-book] 压缩包内条目导入失败 ${it.entry}：${msg}`);
      results.push({ entry: it.entry, name: fileName, ok: false, error: msg });
      failed++;
    }
  }

  console.log(`[local-book] 压缩包导入 ${rawName}：成功 ${ok} / 失败 ${failed}（共 ${listed.length} 本候选）`);
  return { ok, failed, total: listed.length, items: results };
});

/**
 * 取某一章的正文（本地书）。
 *
 * `bookUrl` 用**服务端的主键**（= 前端 `encodeItemKey(shelfKey)`，见 `utils/user-map.ts`）。
 * 文件被移走/删掉 ⇒ 410 并说清是哪个文件（不静默给空白，铁律 3）。
 */
app.get<{ Querystring: { bookUrl?: string; index?: string } }>('/api/local-books/content', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = req.query?.bookUrl ?? '';
  const index = qNum(req.query?.index);
  if (!bookUrl || index === undefined) {
    return reply.code(400).send({ error: 'BOOK_AND_INDEX_REQUIRED', detail: '需要 bookUrl 与 index' });
  }
  const book = await store.getBook(bookUrl);
  if (!book) return reply.code(404).send({ error: 'BOOK_NOT_FOUND', bookUrl });
  const chapters = await store.listChapters(bookUrl);
  const chapter = chapters.find((c) => c.index === index);
  if (!chapter) return reply.code(404).send({ error: 'CHAPTER_NOT_FOUND', bookUrl, index });

  // ★ `#228`：`originName` 可能已被前端 PUT 冲成空（前端契约里没这个字段）。
  //   旧代码直接 `localBookPath('')` ⇒ 抛「文件名越界」，而这行**在 try 之外**
  //   ⇒ Fastify 兜成 500 Internal Server Error（实测复现）。
  //   现在整段搬进 `resolveLocalBookFile`（content/asset/file 三端点共用同一个值）：
  //   失败一律 `ok:false` + 410 + 说清原因，**不抛**。（body 里多带的 `ok`/`status`
  //   只是便于排障，HTTP 状态码本身就是 410。）
  const file = resolveLocalBookFile(LOCAL_BOOK_DIR, book, bookUrl);
  if (!file.ok) return reply.code(file.status).send(file);
  const { fileName, filePath } = file;
  try {
    /**
     * `#816` B5 本地书解析缓存：epub 解压 / txt 切章是重复劳动，按「文件 mtime + 大小 + 章号」
     * 缓存**解析结果**。缓存里没有书文件本身，清掉只会重建一次，不影响已导入的书与阅读进度。
     */
    let lbCacheKey = '';
    try {
      const st = fs.statSync(filePath);
      lbCacheKey = `${bookUrl}|${index}|${st.mtimeMs}-${st.size}`;
      const cached = await cacheStore.get('localbook', lbCacheKey);
      if (cached) {
        try {
          return JSON.parse(cached.buf.toString('utf8')) as Record<string, unknown>;
        } catch {
          /* 缓存坏了 ⇒ 忽略，下面重建 */
        }
      }
    } catch {
      /* stat 失败 ⇒ 这次不缓存（真正的读取错误在下面统一报） */
    }
    const buf = new Uint8Array(fs.readFileSync(filePath));
    /**
     * `#212` Step2：给 epub 章一个「zip 内路径 → 可取地址」的映射，正文里的插图才会带出来。
     *
     * ⚠️ 用**根相对路径**（`/api/...`）而不是绝对地址：前端 iframe 的 `<base href>` 指向
     * 源站，根相对会被 `html-shell.ts` 的 resource bridge 解析到**本服务**（同源）——
     * 若给绝对地址则可能被改写成 `/api/proxy?u=…` 绕一跳（bridge 对 `/api/` 已放行，见其注释）。
     */
    // ★ `#217`：`readLocalBookContent` **凭 `originName` 判格式**（`.epub` 走 zip、`.pdf` 走分页…）。
    //   直接把原样的 `book` 传进去 ⇒ `originName` 为空时 `ext === ''` ⇒ 落进「先 txt 后 epub」
    //   的**试探分支** ⇒ 一本真 epub 被当纯文本按字节偏移切，正文变成 **zip 二进制乱码**
    //   （实测：`PK\x03\x04…mimetype application/epub+zip`）。
    //   ⇒ 传**反推后的** `fileName`，判据回到唯一来源。（`#312`：有兜底的函数不能反推判据。）
    const r = readLocalBookContent(buf, { ...book, originName: fileName }, chapter, {
      assetUrl: (zipPath) => localBookAssetUrl(bookUrl, zipPath),
      /**
       * `#212` Step4：PDF 章的「一页一个地址」。
       *
       * 前端渲染器（`pdfjs-dist`）从 `/api/local-books/file` 取整本 PDF，再按这里的
       * 页码逐页画 → 本地址只用来告诉前端「本章要看第几页」，带 `#page=N` 便于定位。
       * 用**页号**而不是页区间：`paragraphs` 数组的每一项就是一张图，
       * 与漫画通路一模一样（前端 `.rd-comic` 分支不用改）。
       */
      pdfPageUrl: (page) => localBookPdfPageUrl(bookUrl, page),
    });
    const payload = {
      title: chapter.title,
      paragraphs: r.paragraphs,
      // 只有含图章才有（其余章保持纯段落，见 `readLocalBookContent` 的注释）
      ...(r.html ? { html: r.html } : {}),
      source: { id: book.origin, name: book.name, url: bookUrl },
    };
    if (lbCacheKey) {
      void cacheStore
        .put('localbook', lbCacheKey, Buffer.from(JSON.stringify(payload), 'utf8'), 'application/json')
        .catch(() => {});
    }
    return payload;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[local-book] 取正文失败 ${fileName} #${index}：${msg}`);
    return reply.code(500).send({ error: 'LOCAL_BOOK_CONTENT_FAILED', detail: msg, fileName, index });
  }
});

/**
 * `#212` Step2：本地书内嵌资源地址（**唯一实现** —— 生成侧与解释侧都走它，避免两处漂移）。
 *
 * 形如 `/api/local-books/asset?bookUrl=<enc>&path=<enc>`（根相对，同源）。
 */
function localBookAssetUrl(bookUrl: string, zipPath: string): string {
  return `/api/local-books/asset?bookUrl=${encodeURIComponent(bookUrl)}&path=${encodeURIComponent(zipPath)}`;
}

/**
 * `#212` Step4：PDF 某一页的**标记地址**（唯一实现 —— 生成侧与前端识别侧共用这个前缀）。
 *
 * ⚠️ 这**不是一个真图片地址**：它只是让「本章要看哪一页」跟着段落数组走。
 * 前端 `ReaderOverlay` 见到 `paragraphs` 里全是这个前缀 ⇒ 交给 `PdfPages` 渲染器
 * （它用 `pdfjs-dist` 从 `/api/local-books/file` 拉整本 PDF、按页号画 canvas）。
 * 之所以不直接给一页一个「服务端渲好的图」，见 `core/local-book/pdf.ts` 顶部注释。
 */
function localBookPdfPageUrl(bookUrl: string, page: number): string {
  return `/api/local-books/pdf-page?bookUrl=${encodeURIComponent(bookUrl)}&page=${page}`;
}

/** 取小写扩展名（含点）；无扩展名返回空串 */
function extOf(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/**
 * `#212` Step2：**本地书内嵌封面**的 blob key。
 *
 * ⚠️ 与 `coverBlobKey`（用户自定义封面）**刻意分开**：共用会让「重新导入」冲掉用户选的封面。
 * 前缀 `localcover-` 让它在 blob 目录里一眼可辨（排查时不用猜哪个文件是谁）。
 */
const localCoverBlobKey = (bookUrl: string): string =>
  `localcover-${createHash('sha256').update(bookUrl).digest('hex').slice(0, 32)}`;

/**
 * `#212` Step2：`GET /api/local-books/asset?bookUrl=…&path=…`
 *
 * 取 epub **内嵌**资源（正文插图 / 封面）的原始字节。与 `content` 端点同一套取文件逻辑
 * （文件名反推 → 路径越界校验 → 文件存在性），失败一律说清原因（铁律 3）。
 *
 * 只服务 `.epub`（其它格式没有内嵌资源概念）；`path` 必须**规范化后**在 zip 内真实存在，
 * 否则 404 —— 不做「模糊匹配」，不猜路径。
 */
app.get<{ Querystring: { bookUrl?: string; path?: string } }>('/api/local-books/asset', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = req.query?.bookUrl ?? '';
  const zipPath = (req.query?.path ?? '').trim();
  if (!bookUrl || !zipPath) {
    return reply.code(400).send({ error: 'BOOK_AND_PATH_REQUIRED', detail: '需要 bookUrl 与 path' });
  }
  const book = await store.getBook(bookUrl);
  if (!book) return reply.code(404).send({ error: 'BOOK_NOT_FOUND', bookUrl });
  // ★ `#217`：**先**反推文件名，**再**用它判格式。
  //   旧代码先 `extOf(book.originName ?? '')` 判 epub ⇒ `originName` 被前端写空时，
  //   一本**真 epub** 会被误判成「非 epub」回 400，内嵌插图/封面整批取不到（已实测复现）。
  //   判据只留一处：`localBookFileName` 是 content/asset/file 三个端点共用的同一个值。
  const fileName = localBookFileName(book, bookUrl);
  if (!fileName) {
    return reply.code(410).send({ error: 'LOCAL_FILE_NAME_UNKNOWN', detail: '记录里没有文件名（重新导入一次即可）', bookUrl });
  }
  if (extOf(fileName) !== '.epub') {
    return reply.code(400).send({ error: 'NOT_EPUB', detail: `只有 epub 有内嵌资源（本书是 ${fileName}）` });
  }
  // 到这里格式已确定是 epub ⇒ 再走唯一入口拿路径（越界 / 文件没了都回 410，不抛）
  const file = resolveLocalBookFile(LOCAL_BOOK_DIR, book, bookUrl);
  if (!file.ok) return reply.code(file.status).send(file);
  const { filePath } = file;
  try {
    const buf = new Uint8Array(fs.readFileSync(filePath));
    // ⚠️ 规范化 zip 路径再查：`../` 会穿出 zip 命名空间（zip 条目名是扁平的，穿不出去但会查不到）
    const bytes = readEpubAsset(buf, normaliseHref('', zipPath));
    if (!bytes) return reply.code(404).send({ error: 'ASSET_NOT_FOUND', detail: `epub 里没有这个资源：${zipPath}`, path: zipPath });
    return reply
      .header('content-type', mimeOfAsset(zipPath))
      // epub 内嵌资源是**这本书的一部分**，跟着书变 ⇒ 不可长缓存（改书即失效）；但允许私有一段时间
      .header('cache-control', 'private, max-age=3600')
      .send(Buffer.from(bytes));
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[local-book] 取资源失败 ${fileName} ${zipPath}：${msg}`);
    return reply.code(500).send({ error: 'LOCAL_BOOK_ASSET_FAILED', detail: msg, fileName, path: zipPath });
  }
});

/**
 * `#212` Step4：PDF 页数据的取数端点。
 *
 * ## 为什么是「转交原始 PDF 字节」而不是「服务端渲染成图」
 * 见 `core/local-book/pdf.ts` 顶部注释：Node 侧没有免原生依赖的 PDF 渲染器。
 * 本仓的选择是**前端渲染**（`pdfjs-dist` 画到 `<canvas>`），所以这里只把**整本 PDF**
 * 以 `application/pdf` 发给前端（带 ETag / 强缓存，一本 PDF 只下一次），
 * 前端拿到后用 `?page=N` 对应的页自己画。
 *
 * ## 与 `asset` 端点的分工
 * `asset` 服务 epub **zip 内的单个资源**（每次给一个小文件）；
 * 本端点服务 PDF **整本文件**（前端要随机访问任意页 ⇒ 必须自己拿到全文）。
 * 两者都复用同一套「文件名反推 → 越界校验 → 存在性」逻辑。
 */
app.get<{ Querystring: { bookUrl?: string } }>('/api/local-books/file', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bookUrl = req.query?.bookUrl ?? '';
  if (!bookUrl) return reply.code(400).send({ error: 'BOOK_REQUIRED', detail: '需要 bookUrl' });
  const book = await store.getBook(bookUrl);
  if (!book) return reply.code(404).send({ error: 'BOOK_NOT_FOUND', bookUrl });
  const file = resolveLocalBookFile(LOCAL_BOOK_DIR, book, bookUrl);
  if (!file.ok) return reply.code(file.status).send(file);
  const { fileName, filePath } = file;
  try {
    const stat = fs.statSync(filePath);
    // ETag = 文件大小 + 修改时间：文件不变则浏览器 304，翻章不重复下载
    const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const buf = fs.readFileSync(filePath);
    return reply
      .header('content-type', mimeOfLocalFile(fileName))
      .header('etag', etag)
      // 本地书文件是**用户自己的书**，只给私有缓存（不同设备/不同用户目录可能不同）
      .header('cache-control', 'private, max-age=86400')
      .send(buf);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[local-book] 取文件失败 ${fileName}：${msg}`);
    return reply.code(500).send({ error: 'LOCAL_BOOK_FILE_FAILED', detail: msg, fileName });
  }
});

/** 本地书整文件的 Content-Type（按后缀；`file` 端点用） */
function mimeOfLocalFile(name: string): string {
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.mobi': 'application/x-mobipocket-ebook',
    '.azw3': 'application/vnd.amazon.ebook',
    '.epub': 'application/epub+zip',
    '.txt': 'text/plain; charset=utf-8',
    '.umd': 'application/octet-stream',
  };
  return map[extOf(name)] ?? 'application/octet-stream';
}

/**
 * 按**魔数**猜图片 MIME（MOBI 封面字节没有扩展名可依）。
 * 猜不出返回 `application/octet-stream`（不谎报成图片 —— 谎报会让 `<img>` 静默失败）。
 */
function mimeOfImageMagic(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

/** 内嵌资源的 Content-Type（按扩展名；未知一律 `application/octet-stream`，不猜） */
function mimeOfAsset(p: string): string {
  const ext = extOf(p);
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.css': 'text/css; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  };
  return map[ext] ?? 'application/octet-stream';
}

/* ---------------- 分组 ---------------- */

app.get('/api/user/groups', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.listBookGroups();
  return { total: list.length, groups: list };
});

app.put<{ Body: Partial<BookGroup> }>('/api/user/groups', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = stripUndefined((req.body ?? {}) as Record<string, unknown>);
  if (typeof b['groupId'] !== 'number') return reply.code(400).send({ error: 'GROUP_ID_REQUIRED' });
  const g: BookGroup = {
    ...emptyBookGroup(b['groupId'] as number),
    ...(b as Partial<BookGroup>),
    groupId: b['groupId'] as number,
  };
  await store.upsertBookGroup(g);
  return { ok: true, groupId: g.groupId };
});

app.delete<{ Querystring: { groupId?: string } }>('/api/user/groups', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const groupId = qNum(req.query.groupId);
  if (groupId === undefined) return reply.code(400).send({ error: 'GROUP_ID_REQUIRED' });
  return { ok: await store.deleteBookGroup(groupId), groupId };
});

/* ---------------- 阅读时长 ---------------- */

app.get<{ Querystring: { aggregate?: string } }>('/api/user/read-records', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  // aggregate=1 → 跨设备按书名合并（对应 Legado `ReadRecordShow`）
  if (req.query.aggregate === '1' || req.query.aggregate === 'true') {
    const shows = await store.listReadRecordShows();
    return { total: shows.length, records: shows };
  }
  const list = await store.listReadRecords();
  return { total: list.length, records: list };
});

app.post<{ Body: { bookName?: string; deltaMs?: number; author?: string; deviceId?: string } }>(
  '/api/user/read-time',
  async (req, reply) => {
    const store = await userStoreOr503(reply);
    if (!store) return;
    const b = req.body ?? {};
    if (!b.bookName) return reply.code(400).send({ error: 'BOOK_NAME_REQUIRED' });
    if (typeof b.deltaMs !== 'number' || b.deltaMs < 0) {
      return reply.code(400).send({ error: 'DELTA_MS_REQUIRED', detail: 'deltaMs 必须是非负数' });
    }
    // 自托管单用户场景：默认 deviceId = 'local'。
    // 保留该字段是为了将来多设备同步时能按 Legado 语义聚合（D2 决策：主键是 (deviceId, bookName)）。
    await store.addReadTime(b.deviceId ?? 'local', b.bookName, b.deltaMs, b.author);
    return { ok: true };
  },
);

/* ---------------- 阅读会话统计（P1，`#863`） ---------------- */

/**
 * 追加阅读会话（幂等）。
 *
 * 客户端在**会话结束时**调用，可批量补传（离线队列），因此：
 * - 单请求上限 200 条（超过大概率是客户端循环 bug，不是正常批量）；
 * - 重复的 `sessionId` 由 store 层 `INSERT OR IGNORE` 干掉，服务端不做额外去重。
 */
app.post<{ Body: { sessions?: ReadSession[] } }>('/api/user/read-sessions', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = req.body?.sessions;
  if (!Array.isArray(list)) return reply.code(400).send({ error: 'SESSIONS_REQUIRED' });
  if (list.length > 200) return reply.code(413).send({ error: 'TOO_MANY_SESSIONS', detail: '单次最多 200 条' });
  const result = await store.appendReadSessions(list);
  return { ok: true, ...result };
});

/** 看板快照：按日 / 按书 / 断点 / 平均单次 / 旧「历史总额」 */
app.get('/api/user/read-stats', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  return store.getReadStats();
});

/**
 * 会话流水（只读）：P2 看板的「阅读节奏」与「单书下钻」。
 * `limit` 默认 200、上限 2000；`bookUrl` 精确过滤（该书日曲线 / 断点轨迹）。
 */
app.get<{ Querystring: { limit?: string; bookUrl?: string } }>('/api/user/read-sessions', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const raw = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(2000, Math.floor(raw))) : 200;
  const bookUrl = typeof req.query.bookUrl === 'string' && req.query.bookUrl.trim()
    ? req.query.bookUrl.trim()
    : undefined;
  return { sessions: await store.listReadSessions(limit, bookUrl) };
});

/* ---------------- 全局阅读偏好 ---------------- */

app.get('/api/user/prefs', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  return store.getReaderPrefs();
});

app.patch<{ Body: Record<string, unknown> }>('/api/user/prefs', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const patch = stripUndefined(req.body ?? {});
  // 合并式写入：只覆盖传来的字段（契约默认值由 store 侧补）
  const next = await store.setReaderPrefs(patch as never);
  return next;
});

/* ---------------- KV 缓存（带 TTL） ---------------- */

app.get<{ Querystring: { prefix?: string } }>('/api/user/cache', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const list = await store.cacheList(req.query.prefix);
  return { total: list.length, entries: list };
});

app.put<{ Body: { key?: string; value?: string | null; ttlMs?: number } }>('/api/user/cache', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const b = req.body ?? {};
  if (!b.key) return reply.code(400).send({ error: 'KEY_REQUIRED' });
  await store.cacheSet(b.key, b.value ?? null, b.ttlMs);
  return { ok: true, key: b.key };
});

app.delete<{ Querystring: { key?: string } }>('/api/user/cache', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const key = req.query.key ?? '';
  if (!key) return reply.code(400).send({ error: 'KEY_REQUIRED' });
  return { ok: await store.cacheDelete(key), key };
});

app.post('/api/user/cache/sweep', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  return { ok: true, removed: await store.cacheSweep() };
});

/* ---------------- 快照（WebDAV / 换设备恢复的载体） ---------------- */

app.get<{ Querystring: { includeChapters?: string } }>('/api/user/snapshot', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  // ★ `#208` ④：组装逻辑抽到 `user-snapshot.ts`，与「整库备份」共用同一份 ——
  //   两处各拼一遍必然漂移（本仓 `#247` 的教训）。
  return buildSnapshot(store, {
    includeChapters: req.query.includeChapters === '1' || req.query.includeChapters === 'true',
  });
});

/**
 * `#201` 快照**导入**（与上面的导出配对）。
 *
 * - 请求体 = 一份快照 JSON（就是导出端点产出的那份）。
 * - `?overwrite=1` ⇒ 主键冲突时以**快照为准**；缺省为**合并**（只补服务端没有的）。
 * - ⚠️ **不删除任何数据**（合并策略全在 `core/user-store/import.ts`，那里有逐实体判据表）。
 * - 体量上限沿用全局 `bodyLimit`（256MB，见 Fastify 构造处）—— 全量快照带目录时可能有几十 MB
 *   （正文不在快照里，最深只到目录）。
 */
app.post<{ Querystring: { overwrite?: string } }>('/api/user/snapshot/import', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const body = req.body as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return reply.code(400).send({ error: 'BAD_SNAPSHOT', detail: '请求体必须是一份快照对象（导出端点的 JSON）' });
  }
  const overwrite = req.query?.overwrite === '1' || req.query?.overwrite === 'true';
  const t0 = Date.now();
  try {
    const result = await importSnapshot(store, body, { overwrite });
    // 导入是低频重操作，日志留痕便于「导入后数据不对」时对照
    console.log(
      `[import] mode=${overwrite ? 'overwrite' : 'merge'} books +${result.books.added}/~${result.books.updated} ` +
        `bookmarks +${result.bookmarks.added} highlights +${result.highlights.added} readRecords +${result.readRecords.added} ` +
        `prefs=${result.prefs.policy}(${result.prefs.fields}) ${Date.now() - t0}ms`,
    );
    return { ok: true, mode: overwrite ? 'overwrite' : 'merge', elapsedMs: Date.now() - t0, result };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[import] 失败：${msg}`);
    return reply.code(500).send({ error: 'IMPORT_FAILED', detail: msg });
  }
});

// 列出已导入源
/**
 * 网络护栏 / 阻塞点 诊断（2026-09-21，缺陷类T）。
 *
 * 为什么要它：用户报告「跑基线时占满带宽 → 同局域网其它设备断网」，而**真正的请求发生在服务端进程**，
 * 从外面看不到「同时在飞多少、跑了多少字节、有没有被截断、事件循环被谁阻塞」。
 * 这个端点把四个量直接暴露出来：
 *   · `guard`   —— 当前生效的并发/带宽/体积上限（对照 env 是否生效）
 *   · `net`     —— 累计请求数、**峰值在飞**、累计字节、被截断次数、限速累计等待时间
 *   · `blocks`  —— 事件循环阻塞计数器（`java.ajax` L1 同步 curl / Chromium spawnSync / Thread.sleep…）
 *   · `blocksText` —— 同一份数据的人读格式
 * 用法：`curl -s localhost:3000/api/diag | python -m json.tool`；
 * `?reset=1` 清零计数器（配合「跑前清零 → 跑后读」得到单次基线窗口的真实占用）。
 */
/**
 * 进程堆**峰值**（每 500ms 采一次；`/api/diag?reset=1` 清零）。
 *
 * 为什么需要：跑批时只读「当前 heapUsed」会漏掉瞬时峰值 —— 而 OOM 恰恰是**峰值**触顶。
 * 2026-09-23 跑全量基线时服务端两次 OOM（堆 4050MB/上限 4144MB），
 * 有了这个读数就能回答「这批源跑下来堆最多顶到多少」。
 */
let memPeakHeapMB = 0;
setInterval(() => {
  const u = Math.round(process.memoryUsage().heapUsed / 1048576);
  if (u > memPeakHeapMB) memPeakHeapMB = u;
}, 500).unref();

app.get('/api/diag', async (req) => {
  const reset = (req.query as { reset?: string } | undefined)?.reset;
  if (reset === '1') {
    resetNetStats();
    resetL1Stats();
    memPeakHeapMB = 0;
    foregroundGate.resetCounters();
  }
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  return {
    guard: netGuardConfig(),
    /**
     * `#651` **这个进程到底在读什么** —— 源库文件 + 条数 + 回收站。
     *
     * 旧版这里报「书源目录 / 是否落在测试夹具（501 个数字 id）」，那是「1 源 1 文件」时代的判据。
     * 现在唯一存储是 SQLite、目录已删，再报目录只会误导 —— 用户实测仍在源管理页看到
     * 「当前服务加载的是⚠️测试夹具源」的红字告警，而实际 746 个源就是从库里读的。
     */
    paths: {
      sourceDb: SOURCE_DB_FILE,
      // 注意：SourceStore#size 是**方法**（`size(): number`），不是 Map 的 size 属性。
      // 写成 `hub.sources.size` 会序列化出一个函数（JSON 里被丢掉）⇒ 前端拿到 undefined。
      sourceCount: hub.sources.size(),
      trashCount: sourceLayer.removedIds().length,
      dataDir: DATA_DIR,
      /**
       * `#757` E 源库连接级 PRAGMA：`journal_mode` 应为 `wal`、`synchronous` 应为 `1`(NORMAL)。
       * 若 `synchronous` 显示 `2`(FULL) ⇒ 单行源开关/编辑又会回到每次提交 fsync（实测 p50 17ms）。
       */
      sourceDbPragma: {
        journalMode: sourceDbOpen.db.pragma('journal_mode'),
        synchronous: sourceDbOpen.db.pragma('synchronous'),
      },
      ...(sourceDbOpen.warnings.length ? { warning: sourceDbOpen.warnings.join('；') } : {}),
    },
    // 进程内存（2026-09-23 加）：定位「跑全量基线到一半 OOM」这类问题。
    // heapUsedMB 贴近 heapLimitMB = 堆触顶前兆；externalMB 是 Buffer / jsdom 之类堆外持有；
    // rssMB 含 worker 线程之外的一切。用法：跑批期间每 30s 采一次，看它随源数是否线性增长。
    mem: {
      heapUsedMB: mb(m.heapUsed),
      heapTotalMB: mb(m.heapTotal),
      heapLimitMB: mb(getHeapStatistics().heap_size_limit),
      externalMB: mb(m.external),
      rssMB: mb(m.rss),
      peakHeapUsedMB: memPeakHeapMB,
      uptimeSec: Math.round(process.uptime()),
    },
    // 本机网络环境事实：**有代理 env 但 Node 的 fetch 不读它**（`proxyMismatch`）——
    // post8 归因时正是这里最容易误判（curl 通 ≠ 引擎通），所以显式暴露。
    env: netEnvFacts(),
    /**
     * `#732` 外链脚本（jsLib / loginUrl / sortUrl）**连续失败到阈值** ⇒ 一条「请手动下载」提示。
     * 每个 URL 只提示一次（core 用 `.hints.json` 跨进程记标记）；设置页「外链脚本」条目原样渲染。
     * **不是** `java.toast` 那条通道（那条给源脚本用）。
     */
    jslibHints: listJsMirrorHints(),
    net: { ...netStats },
    /**
     * `#200` 流量护栏快照（域名/任务/全局三层 + 熔断）：
     * 看 `global.inFlight`（全局在飞）、`domains[]`（各域名在飞与上限）、`breakers`（熔断数）、
     * `warnings`（**占用 ≥80% 的告警**，参考设置要求）。
     */
    traffic: trafficSnapshot(),
    /**
     * `#756` C **交互优先级现场**：前台请求在飞数（`busy/peak`）与图片解密让路情况
     * （`decode.queue/peakQueue`、`runs`、`deferred`、`deferredMs`）。
     * `deferred > 0` = 有解密因交互请求在飞被推迟；空闲时这些值全为 0。
     */
    priority: foregroundGate.snapshot(),
    blocks: blockCounters(),
    blocksText: formatBlocks(),
    /**
     * `#749` D2：L1 求值路由数据。
     *   · `routed`   —— worker / L1 各多少段（默认关时 worker 只含本来就下放的段）
     *   · `eligible` —— 命中「纯 HTTP + 文本」判据的段数（与 routed.worker 的差 = 判据漏放）
     *   · `drops`    —— `l1w-drop` 具体丢了哪些绑定、各多少次
     *   · `reasons`  —— 回落 L1 的**原因分布**（开关没开 / java 桥 / document / DOM 绑定 / 不可克隆）
     *   · `timeout`  —— 单段硬超时 `L1_TIMEOUT` 的次数与最大值
     *   · `curl`     —— `curl` 兜底实际启用 / 被默认策略拦下的次数与原因
     * 用法：跑批前 `?reset=1`，跑完对比 `l1.reasons` 与 `blocks.l1-timeout`。
     */
    l1: l1StatsSnapshot(),
    // `#754` DOM 后端（常驻 worker）状态：预热个数 / 已预热 / 已回收 / 活跃槽位
    dom: domBackendStatus(),
    // `#773` jsdom 解析累计量：`maxMs / maxLen` 直接给「最慢那次解析的是多大的 HTML」，
    // 配合 `[stall]` 的 `freeze open=dom:parse` 就能判断「解析本身慢」还是「主线程没被调度」。
    parse: { ...parseHtmlStats },
    // `#321` 源级限频：键 = 源 id，值 = {窗口内已放行 frequency, 窗口起点距今 ageMs, 规格 spec}。
    // 空对象 = 还没有任何设了 concurrentRate 的源发过请求（限频器不主动产生记录）。
    concurrentRate: concurrentRateSnapshot(),
    /**
     * `#757` E **KV 写队列现场**：`kv.json`（源变量 / 源缓存 / 登录信息）落盘是否还压在主线程。
     * `queued/flushed/coalesced/errors` 是累计计数（`?reset=1` 不清，便于跨窗口观察）；
     * `inFlight/pending` = 此刻是否有快照在飞 / 有未落盘数据。
     * 判据：`writer:on` + `inFlight:0 + pending:0` ⇒ 空闲；`errors` 持续增长说明写线程在回落。
     */
    kv: kvStore.stats(),
    /**
     * `#771` **冻结探针现场**（默认关，`YUEDU_FREEZE_PROBE=1` 才开）。
     * `enabled=false` 时 `marks` 为空 —— 排查停摆时先确认它开着，再对照 `[stall]` 行的
     * `freeze=` 段（哪个同步段开着没退出）与 `main/proc` 的 CPU 差值（到底有没有在跑）。
     */
    freeze: freezeProbeReport(),
  };
});

/* ============================================================================
 * `#625` URL → 书源识别（粘贴一只书籍链接 ⇒ 自动选出该用哪个源）
 * ========================================================================== */

/**
 * 把 registry 里的源投影成识别候选集（上游 `hasBookUrlPattern` 查询的等价物：
 * 只取「启用」的源，带 `bookUrlPattern` / `customOrder`，其它字段不参与判定）。
 *
 * ⚠️ 只走 `hub.listSources()` + `raw`，**不进任何单源引擎**（识别必须是纯本地判定，
 * 不发请求、不求值规则）——上游同样是纯 DAO 查询 + 正则。
 */
function urlMatchCandidates(kind?: string): UrlSourceCandidate[] {
  // `kind` 只用来限定「书源」（`bookUrlPattern` 是 bookSource 字段，RSS/影视源没有）。
  // 上游书架只认书源；这里默认也只看书源，只有显式传 kind 才放开。
  const list = hub.listSources({ enabled: true, ...(kind ? { kind } : {}) });
  return list.map((s) => {
    const raw = (s.raw ?? {}) as Record<string, unknown>;
    const pat = raw['bookUrlPattern'];
    const order = raw['customOrder'];
    return {
      id: s.id,
      url: typeof raw['bookSourceUrl'] === 'string' ? (raw['bookSourceUrl'] as string) : '',
      name: s.name,
      // `#625` 语料里还有源把 pattern 写成 `ruleBookUrlPattern` 旧键（legacy 迁移前）；
      // 这里两键都读，避免「老源识别不到、新源能识别」的诡异二分。
      bookUrlPattern:
        typeof pat === 'string' ? pat : typeof raw['ruleBookUrlPattern'] === 'string' ? (raw['ruleBookUrlPattern'] as string) : undefined,
      order: typeof order === 'number' ? order : undefined,
      enabled: s.state?.enabled !== false,
    } satisfies UrlSourceCandidate;
  });
}

/**
 * `POST /api/shelf/resolve-url` —— 粘贴 URL ⇒ 返回命中源 + 归一化 bookUrl。
 *
 * Body: `{ url: string }`（多行 / 数组都吃；上游 `bookUrls.split("\n")`）
 * 返回: `{ ok, items: [{ url, match?: { sourceId, sourceName, sourceUrl, kind, by, bookUrl, steps } }] }`
 *
 * 语义完全由 core 的 `resolveSourceByUrls` 决定（三级链，见 `source-match.ts` 头注）；
 * 端点不加任何额外判定 —— 这样「界面说命中谁」与「引擎实际用谁」不可能不一致。
 */
app.post<{ Body: { url?: string | string[]; kind?: string } }>('/api/shelf/resolve-url', async (req, reply) => {
  const raw = req.body?.url;
  const input = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw : '';
  const lines = (Array.isArray(input) ? input : String(input).split('\n'))
    .map((s) => String(s ?? '').trim())
    .filter(Boolean);
  if (!lines.length) return reply.code(400).send({ error: 'URL_REQUIRED' });
  const candidates = urlMatchCandidates(req.body?.kind);
  const items = resolveSourceByUrls(lines, candidates).map((r) => ({
    url: r.url,
    match: r.match
      ? {
          sourceId: r.match.source.id,
          sourceName: r.match.source.name ?? '',
          sourceUrl: r.match.source.url,
          kind: hub.sources.get(r.match.source.id)?.kind ?? 'legado',
          by: r.match.by,
          bookUrl: r.match.bookUrl,
          steps: r.match.steps,
        }
      : undefined,
  }));
  return { ok: true, total: items.length, hit: items.filter((i) => i.match).length, candidates: candidates.length, items };
});

/* ============================================================================
 * `#210` 运维端点：更新书架（调度器在上面） + 崩溃日志
 * ========================================================================== */

/** 书架更新状态（界面「运维」分区 5s 轮询这个） */
app.get('/api/shelf-update', async () => shelfUpdater.status());

app.post<{ Body: { enabled?: boolean; intervalMin?: number } }>('/api/shelf-update/config', async (req, reply) => {
  const { enabled, intervalMin } = req.body ?? {};
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return reply.code(400).send({ error: 'BAD_BODY', detail: 'enabled 需要 boolean' });
  }
  if (intervalMin !== undefined && (!Number.isFinite(Number(intervalMin)) || Number(intervalMin) <= 0)) {
    return reply.code(400).send({ error: 'BAD_BODY', detail: 'intervalMin 需要 >0 的数字' });
  }
  const r = shelfUpdater.setConfig({
    ...(enabled === undefined ? {} : { enabled }),
    ...(intervalMin === undefined ? {} : { intervalMin: Number(intervalMin) }),
  });
  return { ok: true, ...r, status: shelfUpdater.status() };
});

/** 手动「立即更新书架」。已有一轮在跑时返回 409（前端提示「正在跑」而不是静默丢请求）。 */
app.post('/api/shelf-update/run', async (_req, reply) => {
  const started = await shelfUpdater.runPass('manual');
  if (!started) return reply.code(409).send({ error: 'ALREADY_RUNNING', status: shelfUpdater.status() });
  return { ok: true, status: shelfUpdater.status() };
});

/** 最近崩溃/大错（内存 ring，跨重启要看 data/logs/crash-*.log） */
app.get('/api/system/errors', async () => ({
  recent: recentCrashes(20),
  logDir: CRASH_LOG_DIR,
  files: listCrashLogs(CRASH_LOG_DIR),
}));

/**
 * **运行形态与实例身份**（只读）。
 *
 * 端口只能证明「有东西在听」，不能证明「这是同一套悦读、同一份数据」。
 * 桌面端与 `start-server.bat` 都拿它做复用/互斥判定：
 *   · `mode=desktop`：由 Electron 外壳托管（`YUEDU_MANAGED_BY_SHELL=1`）；
 *   · `mode=standalone`：裸 node（`start-server.bat` / 手动启动）。
 * `instanceId` 取数据目录的短哈希 —— 两端界面同时显示它，用户可直接比对是否同一套。
 */
const SERVER_MODE = process.env.YUEDU_MANAGED_BY_SHELL === '1' ? 'desktop' : 'standalone';
const SERVER_INSTANCE_ID = createHash('sha1').update(path.resolve(DATA_DIR)).digest('hex').slice(0, 8);
const SERVER_STARTED_AT = new Date().toISOString();

/**
 * 探测「另一套默认端口」上的身份（只读、best-effort）。
 *
 * 只用于界面上的「两端是否共用同一数据目录」提示；握手/互斥判定**不依赖**它
 * （那两条路径必须只看本进程自己的身份）。结果缓存 10s，避免每次开页面都扫端口。
 */
let peerIdentityCacheAt = 0;
let peerIdentityCache: unknown = null;
const PEER_IDENTITY_TTL_MS = 10_000;
async function probePeerIdentity(): Promise<unknown> {
  const peerPort = PORT === 3000 ? 3100 : (PORT === 3100 ? 3000 : null);
  if (!peerPort) return null;
  const now = Date.now();
  if (now - peerIdentityCacheAt < PEER_IDENTITY_TTL_MS) return peerIdentityCache;
  peerIdentityCacheAt = now;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 600);
  try {
    const r = await fetch(`http://127.0.0.1:${peerPort}/api/system/identity`, { signal: ac.signal });
    peerIdentityCache = r.ok ? await r.json() : null;
  } catch {
    peerIdentityCache = null;
  } finally {
    clearTimeout(timer);
  }
  return peerIdentityCache;
}

app.get<{ Querystring: { peer?: string } }>('/api/system/identity', async (req) => {
  const payload = {
    app: 'yuedu',
    mode: SERVER_MODE,
    instanceId: SERVER_INSTANCE_ID,
    pid: process.pid,
    port: PORT,
    dataDir: path.resolve(DATA_DIR),
    sourceDb: SOURCE_DB_FILE,
    startedAt: SERVER_STARTED_AT,
  };
  // `?peer=1` 才扫另一套默认端口；握手路径保持零副作用、低延迟
  return String(req.query?.peer ?? '') === '1'
    ? { ...payload, peer: await probePeerIdentity() }
    : payload;
});

/**
 * `#246` **「请重启我」的退出码**。
 *
 * `start-server.bat` 在循环里跑 node，并用 `if errorlevel 42` 判断「这次退出是用户点了重启」
 * ⇒ 于是重启在**同一个控制台窗口**里发生（而不是服务端 detached 拉一个无窗口的孤儿）。
 * 选 42 而不是 0/1：0 是正常退出、1 是启动失败，都不该触发重启。
 */
const RESTART_EXIT_CODE = 42;

/**
 * **`#242` 停止服务**（侧栏底部「停止」按钮，与「重启」成对）。
 *
 * ## 为什么必须有这个端点
 * `#225` 的重启端点用 `detached: true` 拉起新进程（否则它会随父进程一起没）。
 * 代价是**新进程没有控制台** ⇒ 用户「关掉 cmd 窗口」这个动作**杀不掉它**
 * （2026-10-03 实测：占用 3000 的 PID 23304 其 PPID 12816 已 GONE，典型的孤儿）。
 * 于是用户重开 bat 被挡，而页面上又还显示在线 —— 只能去任务管理器手工找。
 * 这个端点让「停掉它」变成界面上一个按钮。
 *
 * ## 兜底：`managed`（Electron 外壳托管）时**不停**
 * 外壳有看门狗（server 退出 3s 后自动拉起）⇒ 单纯 exit 只会原地复活。
 * 这种情况下返回 `mode: 'shell'` 并明确告诉用户「桌面外壳会自动拉起，请退出桌面程序」。
 */
app.post('/api/system/shutdown', async (_req, reply) => {
  const managed = process.env.YUEDU_MANAGED_BY_SHELL === '1';
  if (managed) {
    reply.send({
      ok: false,
      mode: 'shell',
      message: '服务由桌面外壳托管，退出后会被自动拉起 —— 请直接退出桌面程序（它会一并带走服务）',
    });
    return;
  }
  // 先回响应再退出，否则浏览器只看到「连接被重置」，分不清是停成功还是崩了
  reply.send({ ok: true, mode: 'exit', pid: process.pid });
  setTimeout(() => {
    // ★ 顺序要紧：**先清 PID 文件，再 `app.close()`**（探针实测踩出来的）。
    //   `app.close()` 要等所有连接关掉，而**本端点自己那条 keep-alive 连接还没断**
    //   ⇒ 它可能长时间挂着，于是排在后面的 `clearPidFile()` 永远等不到执行，
    //   留下一个指向已死进程的 PID 文件（下次 `start-server.bat` 会拿它当「占用者」判断依据）。
    clearPidFile();
    void (async () => {
      // `#746` 批处理子进程随服务一起停（子进程侧也有 `disconnect` 兜底，这里是显式路径）
      try {
        await batchRunner.stop();
      } catch {
        /* 关停失败不影响退出 */
      }
      try {
        await app.close();
      } catch (e) {
        console.warn('[shutdown] 关闭监听出错（不影响退出）：', e instanceof Error ? e.message : String(e));
      }
      process.exit(0);
    })();
  }, 150);
});

/**
 * `#757` E **显式落盘端点**（桌面外壳关闭前调用）。
 *
 * ## 为什么需要
 * Windows 下 `child.kill()` 等价于 `TerminateProcess` ⇒ 服务端的 `process.on('exit'/'SIGTERM')`
 * **不会执行**，`kv.json` 里 300ms 防抖窗口内/写线程在飞的最后一次源变量、登录信息、章节缓存
 * 只能靠这条 RPC 先 flush。桌面端在 `before-quit` 里等它响应之后再杀服务进程。
 */
app.post('/api/system/flush', async (_req, reply) => {
  try {
    await kvStore.flush();
    reply.send({ ok: true, kv: kvStore.stats() });
  } catch (e) {
    reply.code(500).send({ ok: false, message: e instanceof Error ? e.message : String(e), kv: kvStore.stats() });
  }
});

/**
 * **`#225` 重启服务**（侧栏底部「重启」按钮）。
 *
 * ⚠️ 两种运行形态必须分开处理，否则会**起两份服务抢同一个端口**：
 *  ① **Electron 外壳托管**（`YUEDU_MANAGED_BY_SHELL=1`，由 `apps/desktop/main.js` 注入）：
 *     外壳有看门狗（server 退出 3s 后自动拉起）⇒ 这里**只退出**，让外壳去拉；
 *  ② **裸 node**（`start-server.bat` 直跑 bundle）：没有看门狗 ⇒ 自己拉一个新进程再退出。
 *
 * 为什么前端要这个：改完前端要 rebuild + 重启才生效（本仓无热更新），
 * 让用户回到桌面去关 cmd 窗口再双击 bat，是纯体力活。
 */
app.post('/api/system/restart', async (_req, reply) => {
  const managed = process.env.YUEDU_MANAGED_BY_SHELL === '1';
  /**
   * `#246` **`start-server.bat` 托管**（`YUEDU_RESTART_BY_SHELL=1`，由 bat 注入）。
   *
   * ## 为什么要有第三档（用户 2026-10-03 19:22 实测报的现象）
   * 原来只有两档：Electron 托管 / 「裸 node 自己 detached 拉一份」。走 detached 那档时：
   *   旧进程退出 → bat 的 `pause` 打印「请按任意键继续」→ 用户一按回车**窗口就关了**
   *   → 而新进程是 `detached + windowsHide` 的**无窗口进程** ⇒ 用户从此**没有任何控制台**。
   * 更糟的是 bat 顶部那行注释「closing this window stops the server」在重启后**已不成立**
   *   （关窗口杀的是 bat，server 照样跑），文档与实际相反 ⇒ 下次还会踩。
   *
   * ## 这一档的做法：**不自己拉进程，只退出并给一个约定的退出码**
   * 服务端 `app.close()` 后 `process.exit(42)`；bat 用 `if errorlevel 42` 接住，
   * 在**同一个窗口里**重新跑一遍 node ⇒
   *   · 控制台一直在，日志直接看得见（不必去 `data/server-restart.log` 里翻）；
   *   · 不产生孤儿进程，关窗口**真的**能停服务（与 bat 顶部那句一致了）；
   *   · 也不需要「detached 拉起 + 探活 + 失败回滚」那一整套（探活仍保留给 detached 档兜底）。
   */
  const byBat = process.env.YUEDU_RESTART_BY_SHELL === '1';
  if (!managed && !byBat) {
    // 把「自己是怎么被启动的」原样复制一份给新进程：
    // execArgv = node 自己的参数（如 --max-old-space-size=4096，丢了会 OOM），
    // argv[1] = 脚本，argv.slice(2) = 脚本后面的参数。
    const script = process.argv[1] ? path.resolve(process.argv[1]) : '';
    if (!script || !fs.existsSync(script)) {
      reply.code(500);
      return { ok: false, mode: 'respawn', message: `找不到启动脚本（argv[1]=${process.argv[1] ?? '空'}）—— 请手动重启服务` };
    }
    // 日志落文件：★ detached 进程**没有控制台**（窗口里看不到输出），不落盘的话
    // 新服务一旦出问题就无从查起 —— 这正是「点了重启，服务没了」最难查的原因。
    const logFile = path.join(DATA_DIR, 'server-restart.log');
    let out: number | 'ignore' = 'ignore';
    try {
      out = fs.openSync(logFile, 'a');
      fs.writeSync(out, `\n[restart] ${new Date().toISOString()} 由重启端点拉起新进程（原 pid=${process.pid}）\n`);
    } catch {
      out = 'ignore'; // 打不开日志文件也不能让重启失败
    }
    try {
      const child = spawn(process.execPath, [...process.execArgv, script, ...process.argv.slice(2)], {
        cwd: process.cwd(),
        env: process.env,
        // ★★ 必须 detached：**非 detached 的子进程会随父进程一起没**
        //    （实测：旧进程 exit 后新进程随即消失，服务就此没了 —— 比不重启还糟）。
        //    detached 的代价是没有控制台 ⇒ 所以上面把 stdio 重定向到日志文件。
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      });
      // 失败必须留痕：否则「点了重启，服务没了」会变成最难查的一类问题
      child.on('error', (e) => console.warn('[restart] 拉起新进程失败：', String(e)));
      // ★ 新进程**立刻退出**也是失败（拉起成功但启动崩了）：只看 error 事件会漏掉这一类
      child.on('exit', (code, sig) =>
        console.warn(`[restart] 新进程退出：code=${code ?? '-'} signal=${sig ?? '-'}`),
      );
      console.log(`[restart] 已拉起新进程 pid=${child.pid}（${script}）`);
      console.log(`[restart] 新进程日志：${logFile}`);
      child.unref();
    } catch (e) {
      reply.code(500);
      return { ok: false, mode: 'respawn', message: `拉起新进程失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  // ★ 先回响应再退出 —— 否则前端只收到「连接被重置」，分不清是重启成功还是服务崩了
  reply.send({ ok: true, mode: managed ? 'shell' : byBat ? 'bat' : 'respawn' });
  setTimeout(() => {
    void (async () => {
      // 关监听 ⇒ 端口立刻释放（不关的话新进程会 EADDRINUSE，表现为「重启后打不开」）
      await app.close();
      if (managed) {
        // 外壳有看门狗（server 退出 3s 后自动拉起）⇒ 退出即可，别自己再拉一份
        process.exit(0);
      }
      // ★★ `#246` bat 托管：只退出，**由 bat 在同一窗口重新拉起**（见上面的说明）
      if (byBat) {
        console.log('[restart] 退出码 42 ⇒ 由 start-server.bat 在本窗口重新拉起（控制台保留）');
        process.exit(RESTART_EXIT_CODE);
      }
      // ★★ 探活后再退：新进程真起来了才 exit。**不能**「spawn 完就 exit」——
      //    那样一旦拉起失败，用户面对的就是「点了重启，服务没了」，且无从查起。
      const up = await waitForSelf(20000);
      if (up) { process.exit(0); return; }
      // 失败兜底：**把服务恢复回来**，别让「点了一下按钮」变成一次事故
      console.warn('[restart] 新进程 20s 内没有起来 ⇒ 恢复原进程监听（自动重启失败）');
      try {
        await app.listen({ port: PORT, host: '127.0.0.1' });
      } catch (e) {
        console.error('[restart] 恢复监听也失败：', String(e));
      }
    })();
  }, 200);
});

/** 探活「自己这个端口上是不是有新进程在听」：旧进程已 `app.close()`，能响应的只可能是新进程 */
async function waitForSelf(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/diag`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

app.get('/api/sources', async (req) => {
  const q = req.query as { kind?: string; enabled?: string };
  const list = hub.listSources({
    kind: q.kind,
    enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
  });
  // removed：回收站里的 id（可一键恢复）
  // trash（`#645`/`#651`）：回收站清单 —— 名字/删除时间都在库里，不再需要「从磁盘文件现读」
  const trash = sourceLayer.trashList();
  return { total: list.length, sources: list.map(publicSource), removed: sourceLayer.removedIds(), trash };
});

// 取单个源（含原始配置，供编辑）
app.get<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
  const s = hub.sources.get(req.params.id);
  if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  return { ...publicSource(s), raw: s.raw };
});

/**
 * `#653` **CMS 分类（本地缓存）**。
 *
 * 用户要求：分类名 + URL 自动生成后就记下来，之后加载本地；只有「刷新分类」才重拉。
 * 实现：缓存放在引擎里（hub 的持久 KV，键 `cms:cats:<sourceId>`），这里只做两个薄接口：
 *  · `GET  /api/sources/:id/categories`          → 命中缓存就**不发网络请求**（除了首页推荐位）；
 *  · `POST /api/sources/:id/categories/refresh`  → 强制重拉并覆盖缓存。
 *
 * 为什么不复用 `/api/run`：那条路径会把整份 `UnifiedListResult`（含推荐位）回给前端，
 * 而工坊/发现页这里只关心「分类清单」；单独收口后也不会跟播放/搜索的埋点混在一起。
 */
async function cmsCategoriesFor(id: string, refresh: boolean): Promise<{ count: number; items: Array<{ label: string; typeId: string }> } | null> {
  const src = hub.sources.get(id);
  if (!src) return null;
  if (src.kind !== 'maccms') throw new Error('ONLY_CMS');
  const res = (await hub.run('home', id, {
    action: 'home',
    // `categoriesOnly`：只回答「分类有哪些」，不抓推荐位 ⇒ 命中缓存时**零网络**
    extra: { categoriesOnly: true, ...(refresh ? { refreshCategories: true } : {}) },
  })) as { filters?: Array<{ key: string; options: Array<{ name: string; value: string }> }> };
  const opts = (res.filters ?? []).find((f) => f.key === 't')?.options ?? [];
  return { count: opts.length, items: opts.map((o) => ({ label: o.name, typeId: o.value })) };
}

app.get<{ Params: { id: string } }>('/api/sources/:id/categories', async (req, reply) => {
  try {
    const r = await cmsCategoriesFor(req.params.id, false);
    if (!r) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(msg === 'ONLY_CMS' ? 400 : 502).send({ error: msg });
  }
});

app.post<{ Params: { id: string } }>('/api/sources/:id/categories/refresh', async (req, reply) => {
  try {
    const r = await cmsCategoriesFor(req.params.id, true);
    if (!r) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(msg === 'ONLY_CMS' ? 400 : 502).send({ error: msg });
  }
});

// 导入一个新源（Web 粘贴 JSON 导入；?preferred= 指定引擎，缺省自动识别）
// 支持粘贴整个合集（数组）→ 批量导入，返回 {imported, failed, results}
app.post<{ Querystring: { preferred?: string } }>('/api/sources', async (req, reply) => {
  try {
    const body = req.body as unknown;
    const preferred = req.query.preferred;
    const opts = preferred ? { preferred } : {};
    if (Array.isArray(body)) {
      const results: Array<{ ok: boolean; name?: string; id?: string; error?: string }> = [];
      let imported = 0;
      for (const raw of body) {
        try {
          const r = hub.importSource(raw, opts);
          imported++;
          sourceLayer.remember(r.id); // 落库（重启不丢）
          results.push({ ok: true, id: r.id, name: r.name });
        } catch (e) {
          results.push({ ok: false, name: String((raw as Record<string, unknown>)?.['bookSourceName'] ?? ''), error: String(e instanceof Error ? e.message : e).slice(0, 120) });
        }
      }
      sourceLayer.persist();
      return { imported, failed: body.length - imported, results };
    }
    if (!body || typeof body !== 'object') return reply.code(400).send({ error: 'BAD_BODY' });
    const r = hub.importSource(body, opts);
    sourceLayer.remember(r.id);
    sourceLayer.persist();
    return { ...r, state: undefined };
  } catch (e) {
    return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
  }
});

// ---------------------------------------------------------------------------
// 导入源：格式识别 + 预览 + 提交（粘贴文本 / 上传文件内容 / URL 抓取）
// ---------------------------------------------------------------------------
// 解析与格式识别都在 @yuedu/facade 的 importer（纯函数，可单测）；这里只做「取文本」。
// URL 导入由**服务端**抓取：绕开浏览器 CORS，且源站各类防盗链也能带上 UA。

/** 服务端抓取导入 URL（限 http(s)、10MB、15s） */
async function fetchImportText(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '只支持 http(s) 地址' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `抓取失败：HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 60 * 1024 * 1024) return { ok: false, error: '文件超过 60MB，请改用「上传文件」' };
    return { ok: true, text: buf.toString('utf-8') };
  } catch (e) {
    return { ok: false, error: `抓取失败：${String(e instanceof Error ? e.message : e)}` };
  }
}

/** 导入入参：text 优先；否则 url 抓取。format 为空/'auto' = 自动识别 */
async function resolveImportInput(
  body: { text?: string; url?: string } | undefined,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const text = typeof body?.text === 'string' ? body.text : '';
  if (text.trim()) return { ok: true, text };
  const url = String(body?.url ?? '').trim();
  if (!url) return { ok: false, error: 'EMPTY_INPUT' };
  return await fetchImportText(url);
}

/**
 * `D5` **导入进度通道**（jobId 轮询）。
 *
 * 为什么需要：上千条合集一次同步入库会把事件循环占死，前端只能干等；分片 + job 之后，
 * `GET /api/sources/import/:jobId` 能拿到 `{done,total,failed[],stage}`。
 * 旧协议（不传 `async`）**保持原样同步返回**，避免破坏既有调用方。
 */
interface ImportJobRecord {
  id: string;
  state: 'running' | 'done' | 'error';
  stage: 'import' | 'persist' | 'done';
  total: number;
  done: number;
  failed: Array<{ index: number; id?: string; name?: string; error: string }>;
  startedAt: number;
  endedAt?: number;
  error?: string;
  result?: {
    format: ImportFormatHint;
    parsedTotal: number;
    parseErrors: Array<{ index: number; reason: string }>;
    inserted: number;
    updated: number;
    skipped: number;
    failed: number;
    results: ImportRowsBatch['results'];
  };
}
let importJobSeq = 0;
const importJobs = new Map<string, ImportJobRecord>();

/** 只留最近 30 个 job（前端轮询拿到 `done/error` 后就不再需要） */
function pruneImportJobs(): void {
  if (importJobs.size <= 30) return;
  for (const [id, job] of importJobs) {
    if (importJobs.size <= 20) break;
    if (job.state !== 'running') importJobs.delete(id);
  }
}

/** 导入预览：识别格式 / 解析条数 / 新增·重复·错误统计（**不写任何状态**） */
app.post<{ Body: { text?: string; url?: string; format?: string; defaultGroup?: string } }>(
  '/api/sources/import-preview',
  async (req, reply) => {
    const got = await resolveImportInput(req.body);
    if (!got.ok) return reply.code(400).send({ error: got.error });
    // previewImport 内部只解析一次（含采样编译），preview 已带 rowCount；rows 不下发以控体积
    const preview = hub.previewImport(got.text, {
      format: (req.body?.format ?? 'auto') as ImportFormatHint,
      defaultGroup: req.body?.defaultGroup,
    });
    return { ...preview, bytes: Buffer.byteLength(got.text, 'utf-8') };
  },
);

/** 导入提交：重新解析同一份文本后入库，结果即最终结果（新增/覆盖/跳过/失败） */
app.post<{
  Body: {
    text?: string;
    url?: string;
    format?: string;
    defaultGroup?: string;
    dedupe?: 'skip' | 'overwrite';
    /**
     * `#351` 自选导入：只处理**解析结果里这些下标**的行（预览页复选框选中的行）。
     * 不传 = 全量。★ 用下标不用 id —— 同一份文本里可以有两条同 id 的源（合集文件常见），
     * 用 id 当键两行会联动，用户没法只留其中一条。
     */
    selectedRows?: number[];
    /**
     * `D5` 进度通道：`true` ⇒ 立即返回 `{jobId,total}`，之后轮询
     * `GET /api/sources/import/:jobId`。不传 = 原有同步协议。
     */
    async?: boolean;
  };
}>('/api/sources/import', async (req, reply) => {
  const got = await resolveImportInput(req.body);
  if (!got.ok) return reply.code(400).send({ error: got.error });
  const format = (req.body?.format ?? 'auto') as ImportFormatHint;
  const defaultGroup = req.body?.defaultGroup;
  const selectedRows = Array.isArray(req.body?.selectedRows) ? req.body.selectedRows : undefined;
  const parsed = parseImportText(got.text, { format, defaultGroup });
  if (req.body?.async === true) {
    // ---- `D5` 异步 job：立即返回 jobId，后台分片入库 ----
    const total = selectedRows
      ? new Set(selectedRows.filter((i) => Number.isInteger(i) && i >= 0 && i < parsed.rows.length)).size
      : parsed.rows.length;
    const job: ImportJobRecord = {
      id: `imp-${Date.now().toString(36)}-${++importJobSeq}`,
      state: 'running', stage: 'import', total, done: 0, failed: [], startedAt: Date.now(),
    };
    importJobs.set(job.id, job);
    pruneImportJobs();
    void (async () => {
      try {
        const out = await runImportInChunks({
          rows: parsed.rows,
          ...(selectedRows ? { selectedRows } : {}),
          dedupe: req.body?.dedupe ?? 'skip',
          importer: (rows, opts) => hub.importRows(rows, opts),
          onProgress: (p) => {
            job.done = p.done;
            job.total = p.total;
            job.failed = p.failed;
            job.stage = p.stage;
          },
        });
        job.done = out.done;
        job.total = out.total;
        job.failed = out.failed;
        job.stage = 'persist';
        // 与同步路径同一套落盘纪律：先收集、再一次事务写、等落盘完成
        for (const r of out.results) {
          if (!r.ok || r.action === 'skipped') continue;
          sourceLayer.remember(r.id);
        }
        sourceLayer.persist();
        await sourceLayer.whenIdle();
        markSourcesChanged('导入源');
        job.result = {
          format: parsed.format,
          parsedTotal: parsed.parsedTotal,
          parseErrors: parsed.errors,
          inserted: out.inserted,
          updated: out.updated,
          skipped: out.skipped,
          failed: out.failedCount,
          results: out.results,
        };
        job.stage = 'done';
        job.state = 'done';
        job.endedAt = Date.now();
      } catch (e) {
        job.error = String(e instanceof Error ? e.message : e).slice(0, 300);
        job.state = 'error';
        job.stage = 'done';
        job.endedAt = Date.now();
      }
    })();
    return reply.code(202).send({ jobId: job.id, total });
  }
  const res = hub.importRows(parsed.rows, {
    dedupe: req.body?.dedupe ?? 'skip',
    ...(selectedRows ? { onlyIndexes: selectedRows } : {}),
  });
  /**
   * `#507` 的老坑（「导入成功但重启即丢，回到旧版」）在 `#651` 之后**结构性消失**：
   * 旧实现要分两条路落盘（文件源写回同名文件 / 用户源进 JSON 覆盖层），漏一条就丢；
   * 现在只有一条路 —— 整行写进 `sources` 表，`dedupe: overwrite` 与否都一样。
   *
   * 仍然保留「先收集、再一次事务写」：批量导入 2000 条时逐条提交会慢一个数量级。
   */
  for (const r of res.results) {
    if (!r.ok || r.action === 'skipped') continue;
    sourceLayer.remember(r.id);
  }
  sourceLayer.persist();
  // 等落盘完成再响应：否则「导入成功」的提示与磁盘状态不一致（用户重启即丢）
  await sourceLayer.whenIdle();
  markSourcesChanged('导入源');
  return {
    format: parsed.format,
    parsedTotal: parsed.parsedTotal,
    parseErrors: parsed.errors,
    ...res,
  };
});

/** `D5` 导入进度轮询：`{done,total,failed[],stage}`；完成时附最终结果 `result`。 */
app.get<{ Params: { jobId: string } }>('/api/sources/import/:jobId', async (req, reply) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) return reply.code(404).send({ error: 'JOB_NOT_FOUND' });
  return {
    id: job.id,
    state: job.state,
    stage: job.stage,
    done: job.done,
    total: job.total,
    failed: job.failed,
    elapsedMs: Date.now() - job.startedAt,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
});

/**
 * `B21` 源订阅地址簿：GET 列表 / PUT 整体替换。
 *
 * ★ 「更新」**不在服务端做静默拉取/写入**：前端拿这里的 url 打开「导入源」，
 * 走同一套抓取 → 预览 → 勾选 → 确认。这样可更新和可新增条目都会出现在预览里，
 * 用户不确认就什么都不写。
 */
app.get('/api/source-subscriptions', async () => ({ items: sourceSubsStore.list() }));

app.put<{ Body: { items?: unknown } }>('/api/source-subscriptions', async (req, reply) => {
  try {
    return { items: sourceSubsStore.replace(req.body?.items ?? []) };
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** `#647` **按 id 保存源**（抽成函数，供两条路由共用）—— 同 `removeSourceById` 的理由：
 * 超长 id 走路径会 414/400，用户看到的「保存失败」就是这条。 */
async function replaceSourceById(id: string, raw: unknown, reply: FastifyReply) {
  try {
    const r = hub.replaceSource(id, raw);
    persistSource(id); // 编辑落库
    markSourcesChanged('编辑源');
    // `#507` 等落盘完成再响应：保存按钮返回即代表「已进库」，重启不丢
    await sourceLayer.whenIdle();
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return reply.code(400).send({ error: msg });
  }
}

/** `#647` 保存源（body 版）：`POST /api/sources/save { id, raw }`。 */
app.post<{ Body: { id?: string; raw?: unknown } }>('/api/sources/save', async (req, reply) => {
  const id = String(req.body?.id ?? '');
  const raw = req.body?.raw;
  if (!id) return reply.code(400).send({ error: 'ID_REQUIRED' });
  if (!raw || typeof raw !== 'object') return reply.code(400).send({ error: 'BAD_BODY' });
  return replaceSourceById(id, raw, reply);
});

/** `#647` 路径版（保留兼容）。 */
app.put<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
  const raw = req.body as unknown;
  if (!raw || typeof raw !== 'object') return reply.code(400).send({ error: 'BAD_BODY' });
  return replaceSourceById(req.params.id, raw, reply);
});

/**
 * 源**置顶 / 置底**（`#166`）+ **多源置顶名单**（`#238`）。
 *
 * ## 为什么用 `customOrder`，不新增字段
 * 上游 `BookSource.customOrder: Int = 0`（`BookSource.kt:46`），且**所有源查询都是
 * `order by customOrder asc`**（`BookSourceDao.kt:27-101`，含 `book_sources_part` 视图）
 * ⇒ 「置顶/置底」= 把它改成**同 kind 里的最小值 −1 / 最大值 +1**。
 * 这是**上游已有的实体**，所以**不需要**往共享契约上加本仓扩展字段
 * （加扩展字段要区分「上游有/本仓有」，能不加就不加）。
 *
 * ## `#238` 为什么必须另存一份「置顶名单」
 * 2026-10-03 用户实测推翻了原实现的两个假设：
 *  ① **允许多个源同时置顶**。前端原判据是「`customOrder` 严格小于其余所有源」
 *     ⇒ 数学上**只可能有一个**满足 ⇒ 点第三个时前两个的箭头就掉回未置顶。
 *  ② **置顶态要跨刷新存活**。原实现的 `orderBeforePin` 是前端内存 `Map`，刷新即丢；
 *     而且「取消置顶要排回原位」这件事服务端**根本算不出来**
 *     （置顶把它覆盖成了 `min−1`，那个数字不含任何原信息）。
 *
 * ⇒ 落一份**有序名单**到 `<DATA_DIR>/source-pins.json`：数组顺序 = 用户的置顶先后，
 *   `saved` 记每个源**置顶前**的 `customOrder` ⇒ 取消时能精确还原。
 *   最后置顶的排在**最顶**（`unshift`），这与用户要求一致，也与 Legado 的
 *   `BookSourceViewModel.topSource`（`minOrder - 1 - index`，越靠前越小）同一套语义。
 *
 * ⚠️ 名单存**独立文件**而**不是**塞进源实体：源实体会跟着导出/导入到处跑（用户的源是共享的），
 *   私有字段污染用户数据；名单是**本机 UI 偏好**，与源内容无关。
 */
interface PinState {
  /** 置顶名单，**索引 0 = 最顶**（最后置顶的在最前） */
  ids: string[];
  /** 置顶前的 `customOrder`，取消置顶时精确还原 */
  saved: Record<string, number>;
}

let pinState: PinState = { ids: [], saved: {} };
/**
 * `#238` 名单落盘：**独立文件 + 同步写**，不进 `hub.storage`。
 *
 * ## 为什么不用 KV（这是实测踩出来的，不是偏好）
 * `createFileKeyValueStore` 是「内存 Map + **300ms 防抖**写文件」（`core/src/store.ts:62-68`）。
 * 探针实测：连续置顶/取消后**直接 kill 进程**，`kv.json` 里**一个键都没有** ——
 * 防抖窗口内的写全丢了，而**同一时刻 `customOrder` 已经写进源文件落盘了**
 * ⇒ 重启后「顺序还是置顶后的样子，但没有任何源被标记为置顶」，
 *   按钮图标全回未置顶，而且用户**再点一次会把它排到最顶而不是取消**（原值也没了）。
 * 这是「数据写了一半」的不可逆损坏，比丢个 UI 偏好严重得多。
 *
 * 置顶是**低频**操作（用户手点），同步写几十字节的 JSON 完全不心疼。
 */
const PINS_FILE = path.join(DATA_DIR, 'source-pins.json');

function loadPins(): PinState {
  try {
    const parsed = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')) as Partial<PinState>;
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids.filter((x) => typeof x === 'string') : [],
      saved: parsed.saved && typeof parsed.saved === 'object' ? (parsed.saved as Record<string, number>) : {},
    };
  } catch {
    // 首次运行 / 文件不存在 / 损坏 ⇒ 空名单（置顶是纯 UI 偏好，丢了不该阻断启动）
    return { ids: [], saved: {} };
  }
}

/** 同步落盘（见上：防抖会丢） */
function savePins(): void {
  try {
    fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true });
    // 先写临时文件再 rename：断电/强杀时不会留下半截 JSON（rename 在同卷上是原子的）
    const tmp = `${PINS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pinState, null, 2), 'utf8');
    fs.renameSync(tmp, PINS_FILE);
  } catch (e) {
    // 落盘失败要让用户看得见：置顶态丢了但顺序已改 = 状态不一致（见上）
    console.error('[yuedu] 置顶名单落盘失败：', e instanceof Error ? e.message : String(e));
  }
}

pinState = loadPins();
// 源可能已被删 ⇒ 名单里的悬空 id 清掉，否则它会一直占着一个排序位
pinState.ids = pinState.ids.filter((id) => hub.sources.has(id));
if (pinState.ids.length) console.log(`[yuedu] 置顶名单：${pinState.ids.length} 个（最顶 = ${pinState.ids[0]}）`);

const isPinned = (id: string): boolean => pinState.ids.includes(id);

/**
 * 按名单重算所有置顶源的 `customOrder`（落盘 + 记忆）。
 *
 * 取值规则（**必须与 `BookSourceDao` 的 `order by customOrder asc` 一致**）：
 *   设非置顶源的最小 `customOrder` 为 `base`（没有非置顶源时取 0），
 *   名单里第 i 个（0 = 最顶）拿 `base - ids.length + i`
 *   ⇒ 最顶那个最小、整组都排在所有非置顶源之前，且组内顺序 = 用户的置顶先后。
 */
async function applyPinOrder(): Promise<void> {
  const orders = hub
    .listSources()
    .map((x) => ({ id: x.id, n: Number((x.raw as Record<string, unknown>)['customOrder'] ?? 0) }))
    .filter((x) => Number.isFinite(x.n));
  const base = Math.min(0, ...orders.filter((x) => !isPinned(x.id)).map((x) => x.n));
  const n = pinState.ids.length;
  for (let i = 0; i < n; i += 1) {
    const id = pinState.ids[i]!;
    const s = hub.sources.get(id);
    if (!s) continue; // 源已删 ⇒ 名单里的它由 cleanupPins 清掉，这里跳过避免复活
    (s.raw as Record<string, unknown>)['customOrder'] = base - n + i;
    persistSource(id);
  }
}

/** 清掉名单里已不存在的源（源被删后不留悬空 id，否则它会一直占着一个排序位） */
function cleanupPins(): void {
  const before = pinState.ids.length;
  pinState.ids = pinState.ids.filter((id) => hub.sources.has(id));
  if (pinState.ids.length !== before) savePins();
}

app.post<{ Params: { id: string }; Body: { position?: 'top' | 'bottom' | 'reset' } }>(
  '/api/sources/:id/order',
  async (req, reply) => {
    const s = hub.sources.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    const raw0 = s.raw as Record<string, unknown>;
    const id = req.params.id;
    const position = req.body?.position ?? 'top';

    if (position === 'reset') {
      // 取消置顶 ⇒ 排回**置顶前**的位置（`pinState.saved` 里有精确原值）
      pinState.ids = pinState.ids.filter((x) => x !== id);
      const back = pinState.saved[id];
      delete pinState.saved[id];
      raw0['customOrder'] = typeof back === 'number' && Number.isFinite(back) ? back : 0;
      persistSource(id);
      savePins();
      // 名单变短 ⇒ 其余置顶源的 customOrder 要重排（否则中间会留一个空档）
      await applyPinOrder();
      return { ok: true, id, position: 'reset', customOrder: raw0['customOrder'], pinned: pinState.ids, approximated: typeof back !== 'number' };
    }

    if (position === 'bottom') {
      // 置底 = 退出置顶名单 + 拿到全局 max+1（与 `#166` 原语义一致）
      pinState.ids = pinState.ids.filter((x) => x !== id);
      delete pinState.saved[id];
      const maxOrder = Math.max(
        0,
        ...hub
          .listSources()
          .map((x) => Number((x.raw as Record<string, unknown>)['customOrder'] ?? 0))
          .filter((n2) => Number.isFinite(n2)),
      );
      raw0['customOrder'] = maxOrder + 1;
      persistSource(id);
      savePins();
      await applyPinOrder();
      return { ok: true, id, position, customOrder: raw0['customOrder'], pinned: pinState.ids };
    }

    // ★ 置顶：记住原值（只在第一次置顶时记）→ 提到名单最前 → 重排
    if (!isPinned(id)) {
      const cur = Number(raw0['customOrder'] ?? 0);
      if (Number.isFinite(cur)) pinState.saved[id] = cur;
    }
    pinState.ids = [id, ...pinState.ids.filter((x) => x !== id)];
    savePins();
    await applyPinOrder();
    return { ok: true, id, position: 'top', customOrder: Number(raw0['customOrder'] ?? 0), pinned: pinState.ids };
  },
);

// 删除源（M5 源管理）
/** 打开交互式登录窗口（人工/安全验证）。同一源重复调用复用同一只浏览器（profile 持久），不会打断正在进行的验证 */
app.post<{ Params: { id: string }; Body: { url?: string } }>('/api/sources/:id/login/window', async (req, reply) => {
  const s = hub.sources.get(req.params.id);
  if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  const raw = s.raw as Record<string, unknown>;
  const plan = classifyLoginUrl(raw['loginUrl'], raw['loginUi']);
  // 未显式给 URL 时：登录页链接 > 源站根域名（「只填了网站域名」的源就是这一支）
  const siteRoot = String(raw['bookSourceUrl'] ?? '').split('#')[0] ?? '';
  const fallback = plan.url || siteRoot;
  const url = String(req.body?.url ?? '').trim() || fallback;
  const r = await openLoginWindow({ sourceId: req.params.id, url });
  if (!r.ok) return reply.code(400).send({ ok: false, error: r.error });
  return { ok: true, url: r.url, pid: r.pid, reused: r.reused };
});

/** 登录窗口状态（前端轮询/回显用）：按调试端口探活，服务重启后也能重新接管已开的窗口 */
app.get<{ Params: { id: string } }>('/api/sources/:id/login/window', async (req) => {
  const st = await loginWindowStatus(req.params.id);
  return { id: req.params.id, ...st };
});

/** 抓取登录窗口里的 Cookie → 写进源 CookieStore（人工登录的「自动回传」）。**默认不关窗** */
app.post<{ Params: { id: string }; Body: { hosts?: string[]; close?: boolean } }>(
  '/api/sources/:id/login/harvest',
  async (req, reply) => {
    const s = hub.sources.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    const raw = s.raw as Record<string, unknown>;
    const plan = classifyLoginUrl(raw['loginUrl'], raw['loginUi']);
    const siteRoot = String(raw['bookSourceUrl'] ?? '').split('#')[0] ?? '';
    const loginUrl = plan.url || siteRoot;
    const hosts = req.body?.hosts?.length
      ? req.body.hosts.map(String)
      : harvestHosts([loginUrl, String(raw['bookSourceUrl'] ?? '')]);
    const h = await harvestLoginCookies(req.params.id, hosts, { close: req.body?.close === true });
    if (!h.ok) return reply.code(400).send({ ok: false, error: h.error });
    const map: Record<string, string> = {};
    for (const c of h.cookies) map[c.name] = c.value;
    if (Object.keys(map).length) hub.mergeSourceCookies(req.params.id, map);
    try {
      persistSourceCookies();
    } catch {
      /* 落盘失败不影响内存态 */
    }
    const cookie = hub.getSourceCookies(req.params.id);
    return {
      ok: Object.keys(map).length > 0,
      count: Object.keys(map).length,
      picked: h.cookies.map((c) => `${c.name}@${c.domain}`),
      hosts,
      total: h.total,
      fromProfile: h.fromProfile === true,
      cookie,
      ...(Object.keys(map).length ? {} : { message: '窗口里没有匹配该域名的 Cookie——确认已在窗口中登录成功' }),
    };
  },
);

/** 关闭登录窗口（不抓取；**profile 保留**，重开即复用登录态） */
app.delete<{ Params: { id: string } }>('/api/sources/:id/login/window', async (req) => {
  await closeLoginWindow(req.params.id);
  return { id: req.params.id, closed: true };
});

/**
 * `#456` **内嵌真浏览器回传 Cookie**（PC 端「应用内登录」的收口）。
 *
 * 为什么必须单开一条：桌面端内嵌 view 的 cookie 在 Electron 的 `persist:src-<id>` partition 里，
 * 而服务端的登录窗 cookie 在**另一只 Chromium 进程**的 profile 里 —— `readCookiesViaCdp` 读不到
 * 桌面端那份，只能由**客户端读出来送过来**。
 * 与 `/login/harvest` 的差别只有「cookie 从哪来」这一步：域过滤（`pickLoginCookies` 双向后缀匹配）、
 * 合并（`hub.mergeSourceCookies`）、落盘（`COOKIES_FILE`）**全部复用同一套**，不新写判据。
 */
app.post<{ Params: { id: string }; Body: { cookies?: Array<{ name?: string; value?: string; domain?: string; path?: string }>; hosts?: string[] } }>(
  '/api/sources/:id/login/cookies',
  async (req, reply) => {
    const s = hub.sources.get(req.params.id);
    if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    const raw = s.raw as Record<string, unknown>;
    const plan = classifyLoginUrl(raw['loginUrl'], raw['loginUi']);
    const siteRoot = String(raw['bookSourceUrl'] ?? '').split('#')[0] ?? '';
    const loginUrl = plan.url || siteRoot;
    const hosts = req.body?.hosts?.length
      ? req.body.hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean)
      : harvestHosts([loginUrl, String(raw['bookSourceUrl'] ?? '')]);
    const all = (req.body?.cookies ?? [])
      .map((c) => ({
        name: String(c?.name ?? '').trim(),
        value: String(c?.value ?? ''),
        domain: String(c?.domain ?? ''),
        path: String(c?.path ?? '/'),
      }))
      .filter((c) => c.name);
    if (!all.length) {
      return reply.code(400).send({ ok: false, error: 'NO_COOKIES', message: '没有收到任何 Cookie（内嵌浏览器里可能还没完成登录）' });
    }
    /**
     * ★ 实测踩到的坑（2026-10-14 首次真机验证就中招）：`pickLoginCookies` 的 `hostMatches` 在
     * **候选为空**时按「全要」处理（那是给「调用方明确要全部」留的口子）。本端点**不能**沿用这个退化：
     * 候选空 = 推导不出该源的域名（源 `bookSourceUrl` 是 `<js>` 这类）⇒ 一旦按「全要」，
     * 会把浏览器里**任意站点**的 cookie（广告/统计域的）写进该源并与源站请求一起发出去。
     * 所以这里显式拒绝：要么由客户端给 `hosts`，要么把源填对域名。
     */
    if (!hosts.length) {
      return reply.code(400).send({
        ok: false,
        error: 'NO_HOSTS',
        message: '推不出该源的域名（登录页与源站地址都取不到 host）——请在请求里显式给 hosts，或先把源的站地址填对',
      });
    }
    const { picked } = pickLoginCookies(all, hosts);
    const map: Record<string, string> = {};
    for (const c of picked) map[c.name] = c.value;
    if (Object.keys(map).length) hub.mergeSourceCookies(req.params.id, map);
    try {
      persistSourceCookies();
    } catch {
      /* 落盘失败不影响内存态 */
    }
    const cookie = hub.getSourceCookies(req.params.id);
    return {
      ok: Object.keys(map).length > 0,
      count: Object.keys(map).length,
      picked: picked.map((c) => `${c.name}@${c.domain}`),
      hosts,
      total: all.length,
      from: 'embedded',
      cookie,
      ...(Object.keys(map).length ? {} : { message: '内嵌浏览器里的 Cookie 都不匹配该源域名——确认已在页面里登录成功' }),
    };
  },
);

// ---------------------------------------------------------------------------
// `#482` Web 端内嵌验证窗（Cloudflare / 验证码：不弹独立 Chrome，在 Web 端浮层里过）
// ---------------------------------------------------------------------------
// 通路：服务端那只**常驻会话浏览器**抓 CDP screencast 帧 → SSE 推前端 canvas；
// 前端鼠标/键盘 → `/input` → CDP `Input.*` 回灌；页面判「已清关」→ `phase` 事件 → 前端自动重试。
// 浏览器本身被 `Browser.setWindowBounds` 移到屏幕外（保住有头指纹，用户看不到弹窗）。

/** 开一个验证会话（同一源复用；浏览器启动在后台跑，本端点**不阻塞**） */
app.post<{ Params: { id: string }; Body: { url?: string; offscreen?: boolean } }>(
  '/api/sources/:id/verify/start',
  async (req, reply) => {
    const src = hub.sources.get(req.params.id);
    const raw = (src?.raw ?? {}) as Record<string, unknown>;
    const siteRoot = String(raw['bookSourceUrl'] ?? '').split('#')[0] ?? '';
    const url = String(req.body?.url ?? '').trim() || siteRoot;
    if (!/^https?:\/\//i.test(url)) {
      return reply
        .code(400)
        .send({ ok: false, error: 'BAD_URL', message: '需要一个 http/https 地址（可传 url，或让源自带 bookSourceUrl）' });
    }
    const meta = await openVerification({
      sourceId: req.params.id,
      url,
      ...(await verificationFingerprint(req.params.id)),
      ...(req.body?.offscreen === false ? { offscreen: false } : {}),
    });
    return { ok: true, ...meta };
  },
);

/**
 * **类CB（2026-10-26）验证清关后把浏览器 Cookie 收进引擎**。
 *
 * 用户实测（Aff）：浮层先显示「已通过验证，正在重试刚才的请求…」然后又回到验证页，
 * 无限循环 + 服务端堆积 8 条永不关闭的 `/api/verify/:id/stream`。
 * 真因：浏览器 profile 里已有放行 Cookie，但引擎的源 CookieStore 仍为空 ⇒ 重试必再被挑战。
 * 这里把「收割 → 合并 → 落盘」三步接上（与 `/login/harvest` 同一条落点）。
 */
/**
 * `#658` 清关时把**浏览器 UA**也收下来：`cf_clearance` 与 UA 绑定，不换 UA 等于白拿 Cookie
 * （实测 138阅读网：jar 里有 clearance、正文仍 403 ⇒ 又被判「需要人工」反复弹窗）。
 */
setVerifyUaSink((sourceId, ua) => {
  if (!sourceId || !ua) return;
  setSessionUa(sourceId, ua); // `#731` 内存 + 落盘（重启后仍与凭据同源）
});

setVerifyCookieSink((sourceId, map) => {
  if (!Object.keys(map).length) return;
  hub.mergeSourceCookies(sourceId, map);
  try {
    persistSourceCookies();
  } catch {
    /* 落盘失败不影响内存态 */
  }
});

/**
 * `#727` `java.getVerificationCode` 收回的 Cookie / UA 落点 —— **与登录/验证窗同一条**：
 * 内存（`hub.mergeSourceCookies`）→ 加密落盘（`persistSourceCookies`）→ UA 走 `sessionUaBySource`
 * （`cf_clearance` 与 UA 绑定，见 `#658`）。后续 `/api/proxy` 与引擎请求读的是同一份。
 */
setVerificationCodeSink((sourceId, map, ua) => {
  if (!sourceId) return;
  if (ua) setSessionUa(sourceId, ua);
  if (!Object.keys(map).length) return;
  hub.mergeSourceCookies(sourceId, map);
  try {
    persistSourceCookies();
  } catch {
    /* 落盘失败不影响内存态 */
  }
});

/** 该源当前有没有在跑的验证会话（前端据此决定是否弹浮层） */
app.get<{ Params: { id: string } }>('/api/sources/:id/verify', async (req) => {
  return { id: req.params.id, session: verificationForSource(req.params.id) };
});

/**
 * 帧流（SSE）：`frame` 事件带 JPEG base64（前端直接塞 `<img>` / canvas），`phase` 事件带验证进度。
 *
 * **类CC（2026-10-26）为什么必须加心跳与寿命上限**：用户实测服务端里堆了 8 条
 * `/api/verify/:id/stream` 挂着 **8000+ 秒**（2.2 小时）没关，同时 `[stall] inflight=` 把它们全列出来
 * ——页面刷新/关标签后浏览器悄悄丢掉连接，而我们**从不写任何东西**（帧停了、阶段不变），
 * 于是 `res.on('close')` 永远不触发、socket 一直占着，前端每次重试再开一条 ⇒ 线性增长。
 *
 * 三条收口：
 *  ① 15s 心跳注释行 —— 既能穿透代理的 idle 超时，又能让**死连接的写失败**暴露出来；
 *  ② 写失败即退订 + 结束（比等 TCP keepalive 的 2 小时快得多）；
 *  ③ 绝对寿命上限 10 分钟 —— 兜住「对端半开」这类无法靠写失败发现的情况。
 */
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_LIFETIME_MS = 10 * 60_000;
app.get<{ Params: { id: string } }>('/api/verify/:id/stream', async (req, reply) => {
  const meta = getVerification(req.params.id);
  if (!meta) return reply.code(404).send({ error: 'VERIFY_NOT_FOUND' });
  const res = reply.raw;
  reply.hijack();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关掉 Nagle：帧是低频小包，攒包会让画面一顿一顿
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  let unsub: (() => void) | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let life: ReturnType<typeof setTimeout> | undefined;
  const teardown = (): void => {
    if (closed) return;
    closed = true;
    if (beat) clearInterval(beat);
    if (life) clearTimeout(life);
    beat = undefined;
    life = undefined;
    try {
      unsub?.();
    } catch {
      /* 忽略 */
    }
    try {
      res.end();
    } catch {
      /* 已断开 */
    }
  };
  res.on('close', teardown);
  res.on('error', teardown);
  const send = (e: unknown): void => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch {
      // 写不出去 = 对端已死（半开连接靠这一条识别，别等 TCP keepalive）
      teardown();
    }
  };
  send({ type: 'hello', ...meta });
  beat = setInterval(() => {
    if (closed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      teardown();
    }
  }, SSE_HEARTBEAT_MS);
  // 定时器不该把进程钉住（SSE 是长连接，但默认的 ref 会让测试/退出挂住）
  beat.unref?.();
  life = setTimeout(() => {
    send({ type: 'phase', phase: 'closed', error: 'STREAM_LIFETIME_EXCEEDED' });
    teardown();
  }, SSE_MAX_LIFETIME_MS);
  life.unref?.();
  /**
   * ★ 订阅即起 screencast、退订即停（`subscribeVerification` 内部按订阅者计数）：
   * 浮层一关就停帧，不把带宽与 Chrome 的编码开销白烧在没人看的画面上。
   */
  unsub = subscribeVerification(req.params.id, (e) => {
    send(e);
    if (e.type === 'closed') teardown();
  });
});

/** 输入回灌：鼠标（click/move/wheel）· 文本 · 按键；坐标是**页面 CSS 像素**（前端按显示尺寸换算） */
app.post<{
  Params: { id: string };
  Body: { type?: string; x?: number; y?: number; text?: string; key?: string; code?: string; deltaY?: number };
}>('/api/verify/:id/input', async (req, reply) => {
  const t = String(req.body?.type ?? '');
  if (!['click', 'move', 'wheel', 'text', 'key'].includes(t)) {
    return reply.code(400).send({ ok: false, error: 'BAD_INPUT_TYPE' });
  }
  const ok = await verificationInput(req.params.id, {
    type: t as 'click' | 'move' | 'wheel' | 'text' | 'key',
    ...(req.body?.x !== undefined ? { x: Number(req.body.x) } : {}),
    ...(req.body?.y !== undefined ? { y: Number(req.body.y) } : {}),
    ...(req.body?.text !== undefined ? { text: String(req.body.text) } : {}),
    ...(req.body?.key !== undefined ? { key: String(req.body.key) } : {}),
    ...(req.body?.code !== undefined ? { code: String(req.body.code) } : {}),
    ...(req.body?.deltaY !== undefined ? { deltaY: Number(req.body.deltaY) } : {}),
  });
  if (!ok) {
    /**
     * `#710` **把真实原因带回前端**：老实现恒定一句「验证会话已结束或浏览器不可用」，
     * 而实际可能是「验证浏览器启动失败（CDP 连接超时）」。用户看到的两个错误自相矛盾
     * （浮层标题说启动失败，输入框又说会话结束），日志里也分不清是哪一类。
     */
    const meta = getVerification(req.params.id);
    const message =
      meta?.phase === 'failed' && meta.error
        ? `${meta.error}（点「刷新」会重新拉起浏览器）`
        : '验证会话已结束或浏览器不可用';
    return reply.code(400).send({ ok: false, error: 'VERIFY_INPUT_FAILED', message });
  }
  return { ok: true };
});

/** 换一个 URL（同一源切分类/点卡片时复用同一只浏览器，不重开进程） */
app.post<{ Params: { id: string }; Body: { url?: string } }>('/api/verify/:id/navigate', async (req, reply) => {
  const ok = await navigateVerification(req.params.id, String(req.body?.url ?? ''));
  if (!ok) return reply.code(400).send({ ok: false, error: 'VERIFY_NAV_FAILED' });
  return { ok: true };
});

/** 收尾抓 Cookie（**与登录窗同一套**过滤/合并/落盘，不新写判据）⇒ 抓完重放就能带上清关凭据 */
app.post<{ Params: { id: string }; Body: { hosts?: string[]; close?: boolean } }>(
  '/api/verify/:id/harvest',
  async (req, reply) => {
    const meta = getVerification(req.params.id);
    if (!meta) return reply.code(404).send({ ok: false, error: 'VERIFY_NOT_FOUND' });
    const sourceId = meta.sourceId;
    const src = hub.sources.get(sourceId);
    const raw = (src?.raw ?? {}) as Record<string, unknown>;
    const siteRoot = String(raw['bookSourceUrl'] ?? '').split('#')[0] ?? '';
    const hosts = req.body?.hosts?.length
      ? req.body.hosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean)
      : harvestHosts([siteRoot, meta.url]);
    const h = await harvestLoginCookies(sourceId, hosts, {});
    if (!h.ok) return reply.code(400).send({ ok: false, error: h.error });
    const map: Record<string, string> = {};
    for (const c of h.cookies) map[c.name] = c.value;
    if (Object.keys(map).length) {
      hub.mergeSourceCookies(sourceId, map);
      try {
        persistSourceCookies();
      } catch {
        /* 落盘失败不影响内存态 */
      }
    }
    if (req.body?.close === true) await closeVerification(req.params.id);
    return {
      ok: Object.keys(map).length > 0,
      count: Object.keys(map).length,
      picked: h.cookies.map((c) => `${c.name}@${c.domain}`),
      hosts,
      total: h.total,
      phase: meta.phase,
    };
  },
);

/** 关闭验证会话（**保留浏览器进程与 profile**：后续反爬重放还要用同一只） */
app.delete<{ Params: { id: string } }>('/api/verify/:id', async (req) => {
  const closed = await closeVerification(req.params.id);
  return { id: req.params.id, closed };
});

// ---------------------------------------------------------------------------
// `#727` `java.getVerificationCode`：桌面端内置窗口的取画面 / 提交 / 取消
// ---------------------------------------------------------------------------
// 服务端负责「拉起/复用 Chromium + 抓画面 + 收 Cookie」；桌面端只负责「把页面开成窗口 + 轮询」。
// 同一源串行、不同源互不串号（实现见 verification-code.ts）。

/** 轮询：当前有哪些验证码请求在等用户输入（`consumer=web|desktop` 决定过滤口径） */
app.get<{ Querystring: { consumer?: string } }>('/api/verify-code/pending', async (req) => {
  return { ok: true, pending: pendingVerificationCodes(normalizeVerifyCodeConsumer(req.query?.consumer)) };
});

/**
 * `#740` 认领：先认领者独占（Web 浮层 / 桌面端窗口都不会双开）。
 * 幂等：同一端重复认领成功；已被另一端认领 ⇒ 409。
 */
app.post<{ Params: { id: string }; Body?: { consumer?: string } }>(
  '/api/verify-code/:id/claim',
  async (req, reply) => {
    const r = claimVerificationCode(req.params.id, normalizeVerifyCodeConsumer(req.body?.consumer));
    if (!r.ok) {
      return reply.code(r.error === 'NOT_PENDING' ? 404 : 409).send(r);
    }
    return { ok: true, claimedBy: r.claimedBy };
  },
);

/** 输入页（由桌面端 BrowserWindow 加载；自包含，不依赖前端构建产物） */
app.get<{ Params: { id: string } }>('/api/verify-code/:id', async (req, reply) => {
  const meta = getVerificationCodeMeta(req.params.id);
  if (!meta || meta.state !== 'waiting') {
    return reply.code(404).type('text/plain; charset=utf-8').send('验证码请求已结束（可能已提交 / 已取消 / 超时）');
  }
  return reply.type('text/html; charset=utf-8').send(renderVerificationCodePage(meta));
});

/** 输入页轮询状态（等待中 / 已提交 / 取消 / 超时 / 失败 + 错误文案） */
app.get<{ Params: { id: string } }>('/api/verify-code/:id/state', async (req, reply) => {
  const meta = getVerificationCodeMeta(req.params.id);
  if (!meta) return reply.code(404).send({ ok: false, error: 'NOT_PENDING' });
  return { ok: true, ...meta };
});

/** 验证码画面（截图 data URL；1.2s 内复用缓存） */
app.get<{ Params: { id: string } }>('/api/verify-code/:id/frame', async (req) => {
  return captureVerificationCodeFrame(req.params.id);
});

/** 用户提交验证码（成功 = 已回收 Cookie + 已把 code 交给等待中的脚本） */
app.post<{ Params: { id: string }; Body: { code?: string } }>('/api/verify-code/:id', async (req, reply) => {
  const r = await submitVerificationCode(req.params.id, String(req.body?.code ?? ''));
  if (!r.ok) return reply.code(r.error === 'NOT_PENDING' ? 410 : 400).send(r);
  return r;
});

/** 取消（桌面端关窗必须调这个；否则 worker 会一直等到超时） */
app.delete<{ Params: { id: string } }>('/api/verify-code/:id', async (req) => {
  const cancelled = cancelVerificationCode(req.params.id);
  return { ok: true, cancelled };
});

/** 「换一张」：重新加载验证码地址（一次性验证码图） */
app.post<{ Params: { id: string } }>('/api/verify-code/:id/refresh', async (req) => {
  const ok = await refreshVerificationCode(req.params.id);
  return { ok };
});

/** 清除该源的浏览器登录数据（删 profile 目录；下次需重新登录） */
app.delete<{ Params: { id: string } }>('/api/sources/:id/login/browser-data', async (req) => {
  const removed = await clearLoginBrowserData(req.params.id);
  return { id: req.params.id, removed, profileDir: browserProfileDir(req.params.id) };
});

/**
 * `#453` 常驻浏览器会话 API（web / 纯服务端用；桌面端有自己的 `/render` 桥，不必经这里）。
 *
 * 为什么单开一组：登录窗那组端点（`/api/sources/:id/login/*`）只关心「人工登录 + 回传 cookie」，
 * 而这一组是**通用会话**——同一个会话键（`src:<sourceId>`）既给登录窗用、也给内容页渲染用，
 * 所以「登录过的 cookie 与后续抓取共用一只浏览器」这件事才成立。
 *
 * `key` 的写法：`src:<sourceId>` 或 `anon`（匿名渲染）。不传 `key` 时按 `sourceId` 推。
 */
function keyToSourceId(key: string, sourceId?: string): string {
  const k = String(key ?? '').trim();
  if (!k) return String(sourceId ?? '').trim();
  if (k === 'anon') return '';
  return k.startsWith('src:') ? k.slice(4) : k;
}

app.post<{ Body: { key?: string; sourceId?: string; url?: string; js?: string; sourceRegex?: string; delayMs?: number } }>(
  '/api/sessions/render',
  async (req, reply) => {
    const url = String(req.body?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ ok: false, error: 'BAD_URL' });
    const sourceId = keyToSourceId(String(req.body?.key ?? ''), req.body?.sourceId);
    const html = await renderWithSession(url, {
      sourceId,
      ...(req.body?.js ? { js: req.body.js } : {}),
      ...(req.body?.sourceRegex ? { sourceRegex: req.body.sourceRegex } : {}),
      ...(typeof req.body?.delayMs === 'number' ? { delayMs: req.body.delayMs } : {}),
    });
    return { ok: !!html, key: sessionKeyOf(sourceId), html };
  },
);

/** 会话状态（前端轮询/诊断用）；服务重启后靠 `DevToolsActivePort` 接管，返回的仍是同一只浏览器 */
app.get<{ Params: { key: string } }>('/api/sessions/:key', async (req) => {
  const key = req.params.key;
  const s = await getSession(key);
  return {
    key,
    open: !!s,
    live: hasLiveSession(key),
    ...(s ? { url: s.url, startedAt: s.startedAt, pinned: s.pinned, headless: s.headless, profileDir: s.profileDir } : {}),
  };
});

/** 关闭某会话（**保留 profile**：登录态在磁盘上，重开即复用） */
app.delete<{ Params: { key: string } }>('/api/sessions/:key', async (req) => {
  const key = req.params.key;
  await release(key, { keepProfile: true });
  return { key, closed: true };
});

// 清除登录态（Legado 登录对话框「清除登录信息」）：登录信息 + 登录头 + Cookie 一起清
app.delete<{ Params: { id: string } }>('/api/sources/:id/login', async (req, reply) => {
  const ok = await hub.clearSourceLogin(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  try {
    persistSourceCookies();
    fs.writeFileSync(LOGIN_INFO_FILE, JSON.stringify(hub.exportSourceLoginInfo(), null, 1));
  } catch {
    /* 落盘失败不影响内存态 */
  }
  return { id: req.params.id, cleared: true };
});

/**
 * `#647` **按 id 删源**（抽成函数，供「路径版」与「body 版」两条路由共用）。
 *
 * 为什么必须有 body 版：源 id = `bookSourceUrl` 规范化，而**部分源的 `bookSourceUrl` 是长文本**
 * （实测 📚木里聚合：120+ 字符，全是项目说明）⇒ 塞进 `DELETE /api/sources/<id>` 的**路径**
 * 会撞 URL 长度上限 ⇒ 前端收到 **414**（「删除失败 414」）；同一个源点几次都删不掉。
 * 走 body 没有长度问题；路径版保留给短 id 与旧前端。
 */
async function removeSourceById(id: string, reply: FastifyReply) {
  /**
   * `#645`/`#651` **删除前先取快照**：`hub.removeSource` 之后 hub 里就没有这个源了。
   * 库里还有整行（正常路径都由 `forget` 从库里取），快照是「刚 import 还没落库就删」时的兜底。
   */
  const before = hub.sources.get(id);
  const snap = before
    ? { kind: before.kind, name: before.name, raw: before.raw, state: before.state, addedAt: before.addedAt }
    : undefined;
  const ok = hub.removeSource(id);
  if (!ok) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  // `B6` 体检记录随源删除一起清掉（否则同 id 重新导入会继承旧的 dead 标记）
  sourceHealthStore.remove(id);
  // `#238` 置顶名单里不能留悬空 id（它会一直占着一个排序位，且 applyPinOrder 会跳过它）
  cleanupPins();
  // `#645`/`#651`：整行进回收站（raw 一起存）⇒ 任何源都可恢复，不再分「文件源/用户源」
  sourceLayer.forget(id, snap);
  sourceLayer.persist();
  markSourcesChanged('删除源');
  /**
   * **清理该源的运行时数据**（登录信息 / 登录头 / Cookie / 源变量 / 源级 KV / 源缓存）。
   *
   * 交接文档 §4.8d 缺口 A：旧实现删源只做 `sources.remove(id)`（一句 `map.delete`），
   * 这些数据**全部残留** ⇒ 删源后重新导入同一个源，**旧登录态与变量会「复活」**。
   * 用户 2026-09-25 决策：**删源即清数据**；源本身仍可从回收站恢复，但**数据不还原**。
   *
   * `sourceStorageKeys` 由引擎提供（不让这里拼字符串 —— 前缀漂移会导致「清理看起来执行了、
   * 数据却还在」的静默残留）。
   */
  const cleared = await hub.purgeSourceData(id, sourceStorageKeys(id));
  /**
   * `#668` **一起清掉两处「过闸记忆」**（此前删源只清 Cookie/变量）：
   *  · `sessionUaBySource`：该源过闸那只浏览器的 UA —— 留着会让**重新导入的同 id 源**
   *    带着上一只浏览器的 UA 去请求（`cf_clearance` 早已失效，反而更容易被判定异常）；
   *  · `verificationPopupAt`：弹窗冷却时间戳 —— 留着会让新导入的源 2 分钟内点不开验证窗。
   */
  sessionUaBySource.delete(id);
  persistSessionUa(); // `#731` 落盘同步（否则重启后已删源的 UA 又「复活」）
  verificationPopupAt.delete(id);
  /**
   * ⚠️ **必须同步刷新这两份「全量导出」文件** —— 登录信息与 Cookie 各有**两条独立落盘路径**：
   *   ① `hub.storage`（`login-info:<id>` / 源 Cookie，走 kv/DB）
   *   ② 这两个 JSON 文件（`exportSourceLoginInfo()` / `exportSourceCookies()` 全量导出），
   *      且**启动时会被载入**（见文件头部的 `if (fs.existsSync(...))`）。
   * 只清 ① 的话，重启后 ② 会把已删源的登录态**载回来** —— 这就是「删源后旧登录态复活」的另一半根因。
   * 清理已在 hub 内存态做过，这里直接按当前内存态重写文件即可。
   */
  try {
    fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
    persistSourceCookies();
    fs.writeFileSync(LOGIN_INFO_FILE, JSON.stringify(hub.exportSourceLoginInfo(), null, 1));
  } catch {
    /* 落盘失败不影响内存态（与其它端点同口径） */
  }
  return { removed: id, softDeleted: true, clearedKeys: cleared };
}

/** `#647` 删除源（body 版）：`POST /api/sources/delete { id }` —— 超长 id 不再撞 URL 长度。 */
app.post<{ Body: { id?: string } }>('/api/sources/delete', async (req, reply) => {
  const id = String(req.body?.id ?? '');
  if (!id) return reply.code(400).send({ error: 'ID_REQUIRED' });
  return removeSourceById(id, reply);
});

/** `#647` 路径版（保留兼容）：id 短的老前端仍可用。 */
app.delete<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) =>
  removeSourceById(req.params.id, reply));


/** 恢复已删除（`#269` 改选择式）：body 给 `ids` ⇒ 只恢复所选；不给 ⇒ 清空墓碑（全部恢复）。
 *  恢复 = 从墓碑移除 + 重新扫描源目录（删掉的文件源回来）。 */
app.post<{ Body: { ids?: string[] } }>('/api/sources/restore-removed', async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string') : undefined;
  const cleared = ids && ids.length ? sourceLayer.restoreSome(ids) : sourceLayer.clearRemoved();
  markSourcesChanged('恢复已删除源');
  /**
   * `#651`：不再需要「重新扫目录把文件源拉回来」—— 回收站里存的是整行 raw，
   * 恢复 = 搬回 `sources` 表 + 重新 importSource。`total` 仍按 hub 现有条数回，
   * 前端只用它刷新列表，语义从「扫目录后的总数」变成「真实总数」（更准）。
   */
  return { cleared, total: hub.listSources().length };
});

/** `#269` 清空已删除列表：`#645` 起语义 = **恢复全部**（旧文案里「清空墓碑⇒全回来」的行为不变） */
app.post('/api/sources/clear-removed', async () => {
  const cleared = sourceLayer.clearRemoved();
  return { cleared };
});

/**
 * `#645` **永久删除**：把所选回收站条目真正丢掉。
 * 用户源的 `raw` 从此消失（不可恢复）；文件源的**文件不删**，只是不再出现在回收站
 * （`purged` 名单压住它，重启也不会被扫描回来）。
 */
app.post<{ Body: { ids?: string[] } }>('/api/sources/purge-removed', async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string') : [];
  const purged = ids.length ? sourceLayer.purgeSome(ids) : sourceLayer.purgeSome(sourceLayer.removedIds());
  return { purged };
});

// 批量静态校验（M5）
/**
 * `#746` B1：静态校验（`hub.validateAll`）默认进子进程；失败/关开关时回落同进程。
 * 它是**纯离线**编译校验，不写任何数据，所以子进程崩了直接回落是安全的。
 */
app.post('/api/sources/validate-all', async () => {
  if (batchProcessEnabled()) {
    try {
      return await batchRunner.run('validate-all');
    } catch (e) {
      console.warn(`[batch] 静态校验子进程失败，回落主进程：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return hub.validateAll();
});

/**
 * `#550` **源医生 · 编辑器内联诊断**（无 LLM、纯离线）。
 *
 * 吃**编辑器里未保存的 raw**（不是磁盘版）⇒ 改一个字就能看到规则有没有问题。
 * 判据来自 core 的 lint 表（`#542`，与 `pnpm check:lint` 同一实现），不复制。
 * 返回的 `fix` 是**字节级补丁**（`search`/`replace`，可选 `all`）⇒ 前端一键应用。
 */
app.post<{ Body: { raw?: Record<string, unknown> } }>('/api/doctor/inspect', async (req, reply) => {
  const raw = req.body?.raw;
  if (!raw || typeof raw !== 'object') return reply.code(400).send({ error: 'RAW_REQUIRED' });
  const o = raw as Record<string, unknown>;
  // `#552`：kind 判定收敛到 core 的 `sourceKindOf`（离线巡检共用同一份，防两处漂移）
  const kind = sourceKindOf(o);
  const findings = lintSource(o, kind);
  const counts = { error: 0, warn: 0, info: 0 } as Record<'error' | 'warn' | 'info', number>;
  for (const f of findings) counts[f.severity] += 1;
  return { ok: true, kind, counts, findings };
});

/* ------------------------------------------------------------------ */
/* `#552` 源医生 v2-F：离线巡检（定时 + 落盘 + 播报出口）                */
/* ------------------------------------------------------------------ */

/**
 * 巡检实例：判据与差分在 core，这里只给它「怎么取全量源」。
 *
 * ⚠️ lint 跑 **raw**（磁盘/导入时的原始 JSON），不是 `rule`（编译后）——
 * lint 判的是**规则写法**（缺括号、零宽字符、语法错），编译会把这些规范化掉，
 * 跑编译后的对象等于「看不到用户实际写了什么」（与 `pnpm check:lint` 同一口径）。
 */
const doctorPatrol = createDoctorPatrol({
  /**
   * `#746` B1：采集（`validateAll` + 全量源清单）默认在**批处理子进程**里做。
   * 结果回主进程后，差分/落盘/播报仍由本进程完成（单写者：子进程不写 `data/**`）。
   * 子进程失败 ⇒ 显式日志 + 回落同进程（巡检是后台任务，宁可慢一轮也不留空窗）。
   */
  collect: async () => {
    if (batchProcessEnabled()) {
      try {
        const t0 = Date.now();
        const rows = (await batchRunner.run('patrol')) as PatrolCollectRow[];
        if (Array.isArray(rows)) {
          if (b2ProcessEnabled()) {
            // B2 摘要模式的**唯一可观测证据**：回传体积与耗时（B1 是整份 raw ≈ 1MB）
            const bytes = Buffer.byteLength(JSON.stringify(rows));
            console.log(`[batch] 巡检摘要回传：${rows.length} 行 · ${Math.round(bytes / 1024)}KB · ${Date.now() - t0}ms`);
          }
          return rows;
        }
      } catch (e) {
        console.warn(`[batch] 源体检测子进程失败，回落主进程：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const v = hub.validateAll();
    const structById = new Map(v.results.map((r) => [r.id, r.issues as ValidationIssue[]]));
    return hub.sources.list().map((s) => ({
      id: s.id,
      kind: s.kind,
      ...(s.name ? { name: s.name } : {}),
      raw: (s.raw ?? {}) as Record<string, unknown>,
      issues: structById.get(s.id) ?? [],
    }));
  },
  dataDir: DATA_DIR,
  log: (m) => console.log(`[doctor] ${m}`),
});

/**
 * **巡检结果出口**（前端轮询用）。
 *
 * `?since=<ms>` = 前端「已消费到哪一轮」的游标 ⇒ 只有 `at > since` 才带 `toast`，
 * 否则同一条播报会每 5 分钟弹一次（这正是「轮询方案」必须解决的唯一问题）。
 * 关掉开关时显式回 `disabled` —— 「没有数据」不能看起来像「坏了」。
 */
app.get<{ Querystring: { since?: string } }>('/api/doctor/patrol', async (req) => {
  const n = Number(req.query.since ?? '');
  return doctorPatrol.view(Number.isFinite(n) && n > 0 ? n : undefined);
});

/** 手动触发一轮（用户不想等下一个间隔；也用于验证巡检本身有没有在工作） */
app.post('/api/doctor/patrol/run', async () => {
  const snap = await doctorPatrol.run();
  if (!snap) return { ok: false, error: 'PATROL_FAILED（看服务端日志）' };
  return { ok: true, ...doctorPatrol.view() };
});

/**
 * `#558` **巡检间隔**（用户：「巡检频率太高，设置页提供接口」）。
 *
 * 只给四档：24h / 3天 / 7天 / 30天，默认 7 天。取回的值里同时带「当前生效」与「选项」，
 * 前端不必自己算 —— 也避免前端硬编码一份档位、后端另一份（两处漂移）。
 */
app.get('/api/doctor/patrol/config', async () => ({
  hours: patrolHours(DATA_DIR),
  options: PATROL_HOUR_OPTIONS,
  defaultHours: PATROL_DEFAULT_HOURS,
  everyMs: doctorPatrol.everyMs(),
  /** 环境变量钉死了就不让改（改了也不生效，说清楚比让人白点一次好） */
  pinned: Number(process.env['YUEDU_DOCTOR_PATROL_EVERY_MS'] ?? '') > 0,
}));

app.post<{ Body: { hours?: number } }>('/api/doctor/patrol/config', async (req, reply) => {
  if (Number(process.env['YUEDU_DOCTOR_PATROL_EVERY_MS'] ?? '') > 0) {
    return reply.code(409).send({
      error: 'PINNED_BY_ENV',
      detail: '巡检间隔被环境变量 YUEDU_DOCTOR_PATROL_EVERY_MS 钉住了，改设置不会生效',
    });
  }
  const hours = Number(req.body?.hours);
  const w = setPatrolHours(DATA_DIR, hours);
  if (!w.ok) return reply.code(400).send({ error: 'BAD_HOURS', detail: w.error });
  const ms = doctorPatrol.setEveryMs(hours * 3_600_000);
  return { ok: true, hours, options: PATROL_HOUR_OPTIONS, everyMs: ms };
});

// 源变量（Legado「设置源变量」：聚合类源靠它注入 JSON 配置）
app.get<{ Params: { id: string } }>('/api/sources/:id/variable', async (req, reply) => {
  if (!hub.sources.has(req.params.id)) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  return { id: req.params.id, value: hub.getSourceVariable(req.params.id) };
});
app.post<{ Params: { id: string }; Body: { value?: string } }>('/api/sources/:id/variable', async (req, reply) => {
  const ok = hub.setSourceVariable(req.params.id, String(req.body?.value ?? ''));
  if (!ok) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  return { id: req.params.id, value: String(req.body?.value ?? '') };
});

// 在线校验（复刻 Legado 书源校验：搜索→发现→详情→目录→正文）
// `#692` Body 新增 `checkSearch` / `checkDiscovery`（二选一，一次只跑一条链）与 `explorePick`（指定发现分类）。
type VerifyBody = {
  keyword?: string;
  checkDomain?: boolean;
  checkContent?: boolean;
  markOnError?: boolean;
  checkDiscoveryDeep?: boolean;
  checkSearch?: boolean;
  checkDiscovery?: boolean;
  explorePick?: { key: string; value: string; name?: string };
};

/**
 * `#695` 请求体 → `hub.verifySource` 选项（**一次性接口与流式接口共用一份映射**）。
 *
 * 抽出来的理由：两处如果各写一份，迟早出现「流式那版忘了透传 `explorePick.name`」这种
 * 只在某一个入口才看的 bug（`#694` 的 name 就是后补的）。
 */
function verifyOptsFromBody(body: VerifyBody | undefined): Parameters<EngineHub['verifySource']>[1] {
  const b = body ?? {};
  return {
    keyword: b.keyword,
    checkDomain: b.checkDomain,
    checkContent: b.checkContent,
    markOnError: b.markOnError,
    checkDiscoveryDeep: b.checkDiscoveryDeep,
    /**
     * `#692` 规则工坊「全链试跑」的三个开关：
     *  · `checkSearch` / `checkDiscovery` 二选一 —— 搜索全链不跑发现、发现全链不跑搜索
     *    （旧接口两者默认都开，一次请求打两条链，工坊里看不出到底哪条挂了）；
     *  · `explorePick` 指定要跑的发现分类（点哪个胶囊跑哪条）。
     */
    ...(typeof b.checkSearch === 'boolean' ? { checkSearch: b.checkSearch } : {}),
    ...(typeof b.checkDiscovery === 'boolean' ? { checkDiscovery: b.checkDiscovery } : {}),
    ...(b.explorePick && typeof b.explorePick.key === 'string' && typeof b.explorePick.value === 'string'
      /**
       * `#694` `name` 透传：工坊时间轴要显示「分类「热血」」，而不是被截断的分类 URL。
       * 只验 `key`/`value` 是字符串，`name` 可选（缺了后端退回「（指定）」）。
       */
      ? {
          explorePick: {
            key: b.explorePick.key,
            value: b.explorePick.value,
            ...(typeof b.explorePick.name === 'string' ? { name: b.explorePick.name } : {}),
          },
        }
      : {}),
  };
}

app.post<{
  Params: { id: string };
  Body: VerifyBody;
}>(
  '/api/sources/:id/verify',
  async (req, reply) => {
    try {
      const r = await hub.verifySource(req.params.id, verifyOptsFromBody(req.body));
      if (req.body?.markOnError) persistSource(req.params.id); // 打标/清标都落盘
      return r;
    } catch (e) {
      return reply.code(404).send({ error: String(e instanceof Error ? e.message : e) });
    }
  },
);

/**
 * `#695` **流式校验**（全链试跑逐段返回）。
 *
 * 为什么要有它：发现全链实测 10~21s，一次性接口在这段时间里前端只知道「正在跑…」，
 * 用户完全看不出卡在哪一段（`#692`/`#693` 的时间轴是跑完才一次性出现的）。
 * 这里把 `verifySource` 的 `onStage` 回调转成 SSE 帧，前端边跑边渲染。
 *
 * 帧格式（与 `/api/run/stream` 同一套纪律，见那里的长注释）：
 *   `event: log`   → `{ at, msg, level? }`（`#696` 调试信息流，逐行，对齐 Legado `Debug.log`）
 *   `event: stage` → `{ stage, ...VerifyStage }`（每段一帧，顺序即执行顺序）
 *   `event: done`  → 完整 `VerifyOutcome`（末帧必须 `end(frame)`，否则 Windows 下会丢）
 */
app.post<{
  Params: { id: string };
  Body: VerifyBody;
}>('/api/sources/:id/verify/stream', async (req, reply) => {
  const res = reply.raw;
  reply.hijack();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.socket?.setNoDelay?.(true);
  const send = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (event === 'done' || event === 'error') {
      res.end(frame);
      return;
    }
    // 配对 cork/uncork：只 write 会被攒批，单调 uncork 会补 0 长度块（客户端提前 EOF）
    res.cork();
    res.write(frame);
    res.uncork();
  };
  /**
   * `#697` 客户端断开（换源/关页/中途取消）⇒ **两层都要停**：
   *  ① 不再往已关闭的 socket 写帧（`aborted`）；
   *  ② `ac.abort()` 把中断信号透传到 `hub.verifySource` → 每次 `run` → `ctx.signal`
   *     ⇒ 在途的抓取/渲染立即停止（`#480` 机制）。
   * 旧实现只有第 ① 层：界面上的「正在跑」停了，引擎却在后台把整条链跑完，
   * 白占流量槽与域名并发（用户实测「切了源，日志里还在跑上一个源的请求」）。
   */
  const ac = new AbortController();
  let aborted = false;
  res.on('close', () => {
    if (res.writableEnded) return;
    aborted = true;
    ac.abort();
  });
  try {
    const outcome = await hub.verifySource(req.params.id, {
      ...verifyOptsFromBody(req.body),
      onStage: (stage, stageResult) => {
        if (aborted) return;
        send('stage', { stage, ...stageResult });
      },
      /**
       * `#696` 调试信息流：引擎/门面每写一条回执就推一帧（`event: log`）。
       * 前端按 `at` 自己算 `[mm:ss.mmm]` —— 时间戳在**服务端**打，比前端收到时刻更接近真实间隔。
       */
      onLog: (line) => {
        if (aborted) return;
        send('log', line);
      },
      signal: ac.signal,
    });
    if (req.body?.markOnError) persistSource(req.params.id);
    send('done', outcome);
  } catch (e) {
    send('error', { message: String(e instanceof Error ? e.message : e) });
  }
});
/**
 * `#200` 批量校验的**异步任务队列**（参考设置第 5 条：「批量任务必须异步队列，
 * **不占用前端 HTTP 线程**」）。
 *
 * 语义三条：
 *  ① 所有批量校验**串行**（同一时刻只跑一个）—— 批量本身就是「后台」，
 *     再并发叠加只会把出口 IP 打得更凶；
 *  ② `wait=0` ⇒ **立即**返回 `jobId`，前端轮询 `/api/sources/verify-jobs/:id`，
 *     不再让一个 HTTP 连接挂着等几分钟（旧实现就是挂着的）；
 *  ③ 不传 `wait` 时保持**旧行为**（同步等结果），避免破坏既有前端调用。
 */
interface VerifyJob {
  id: string;
  total: number;
  done: number;
  state: 'queued' | 'running' | 'done' | 'error';
  results: unknown[];
  error?: string;
  startedAt: number;
  endedAt?: number;
}
/**
 * `startBrowser*`（Legado 浏览器 API）必须由**主进程**执行：批处理子进程不注入
 * `webRenderer` / `verificationCode` / Cookie 收割（见 batch-child.ts 头注），
 * 规则里写 `startBrowserAwait(...)` 的源在子进程里只会被误判成 NETWORK。
 *
 * 判据用源 raw 的全文扫描（与 Legado 规则「任意位置出现即生效」同语义），
 * 只匹配 `startBrowser` 家族，不扩大到 webView —— 后者有静态回退，不强制上浏览器。
 */
function isBrowserOnlySource(raw: unknown): boolean {
  try {
    return /startBrowser\w*\s*\(/.test(JSON.stringify(raw ?? ''));
  } catch {
    return false;
  }
}
const verifyJobs = new Map<string, VerifyJob>();
/** 串行队列尾（保证同一时刻只有一个批量任务在跑） */
let verifyQueueTail: Promise<void> = Promise.resolve();
let verifyJobSeq = 0;

function enqueueVerifyJob(
  ids: string[],
  opts: { keyword?: string; concurrency?: number; markOnError?: boolean; checkDiscoveryDeep?: boolean },
): VerifyJob {
  const job: VerifyJob = {
    id: `v${Date.now().toString(36)}${(verifyJobSeq++).toString(36)}`,
    total: ids.length,
    done: 0,
    state: 'queued',
    results: [],
    startedAt: Date.now(),
  };
  verifyJobs.set(job.id, job);
  // 只保留最近 20 个任务，防止内存无限增长
  if (verifyJobs.size > 20) {
    for (const k of verifyJobs.keys()) {
      if (verifyJobs.size <= 20) break;
      if (k !== job.id) verifyJobs.delete(k);
    }
  }
  verifyQueueTail = verifyQueueTail.then(async () => {
    job.state = 'running';
    try {
      /**
       * `#746` B1：批量在线校验默认进子进程（它会跑源 JS + 同步 HTTP，正是主线程被按死的主因）。
       * · 子进程**只读**源库；`markOnError` 的打标在子进程内存里算，回来通过 `changed`
       *   （只含 `bookSourceComment` / `bookSourceGroup` 两字段）由**主进程**回放到自己的源表并落盘；
       * · 子进程崩溃/超时 ⇒ 本任务置 `error`（**不**自动回落主进程 —— 回落等于把同样的重活再打一遍，
       *   用户会看到双倍等待且仍无结果；下一次任务会自动重启子进程）。
       */
      /**
       * `startBrowser*` 源分流到主进程（Chromium 只在主进程有）：
       * 子进程负责其余源；浏览器源串行（concurrency=1），避免一次弹多个浏览器窗口。
       * 结果仍按「子进程 + 主进程」合并回同一个 job，前端不需要区分。
       */
      const srcById = new Map(hub.listSources().map((s) => [s.id, s] as const));
      const browserIds = ids.filter((id) => isBrowserOnlySource(srcById.get(id)?.raw));
      const browserSet = new Set(browserIds);
      const childIds = ids.filter((id) => !browserSet.has(id));
      if (browserIds.length) {
        console.log(`[verify-job] ${job.id} 浏览器源 ${browserIds.length} 个转主进程（子进程 ${childIds.length} 个）`);
      }
      /**
       * **任务级超时**与「单源 60s」是两层预算，不能都用固定值：
       * 子进程串行跑 N 个源（并发 = min(payload, 子进程自适应：B2 关时上限 2）），
       * 固定 300s 在 ≥8 源时必然 SIGKILL 整批 —— 实测 18 源 303s 被杀，
       * 连已转主进程的浏览器源结果也一起丢弃（job 只保留合并后的最终结果）。
       * 按实际派发并发折算：每源 120s（60s 行动预算 + 外链脚本 HEAD/GET 与重试余量，
       * 实测慢源单源 71~177s）+ 120s 装载余量。
       */
      const childConc = Math.max(1, Math.min(opts.concurrency ?? 3, b2ProcessEnabled() ? 4 : 2));
      const childTimeoutMs = Math.max(300_000, Math.ceil(childIds.length / childConc) * 120_000 + 120_000);
      let results: Array<{ id: string; outcome: unknown }>;
      if (batchProcessEnabled()) {
        const out = childIds.length
          ? ((await batchRunner.verify({
              ids: childIds,
              opts: { keyword: opts.keyword, concurrency: opts.concurrency, markOnError: opts.markOnError },
            }, childTimeoutMs)) as { results: Array<{ id: string; outcome: unknown }>; changed: Array<{ id: string; comment?: string; group?: string }> })
          : { results: [] as Array<{ id: string; outcome: unknown }>, changed: [] as Array<{ id: string; comment?: string; group?: string }> };
        for (const m of out.changed ?? []) {
          const s = hub.sources.list().find((x) => x.id === m.id);
          if (!s) continue;
          const raw = { ...((s.raw ?? {}) as Record<string, unknown>) };
          if (m.comment !== undefined) raw['bookSourceComment'] = m.comment;
          if (m.group !== undefined) raw['bookSourceGroup'] = m.group;
          try {
            hub.replaceSource(m.id, raw);
          } catch {
            /* 回放失败保留主进程原 raw（与同进程打标失败同一口径） */
          }
        }
        results = out.results;
      } else {
        results = await hub.verifySources(ids, {
          keyword: opts.keyword,
          concurrency: opts.concurrency,
          markOnError: opts.markOnError,
        });
      }
      if (batchProcessEnabled() && browserIds.length) {
        const mainOut = await hub.verifySources(browserIds, {
          keyword: opts.keyword,
          concurrency: 1,
          markOnError: opts.markOnError,
        });
        results = [...results, ...mainOut];
      }
      job.results = results;
      job.done = results.length;
      job.state = 'done';
      if (opts.markOnError) for (const r of results) persistSource(r.id); // 打标/清标都落盘
    } catch (e) {
      job.state = 'error';
      job.error = String(e instanceof Error ? e.message : e);
      console.error(`[verify-job] ${job.id} 失败：${job.error}`);
    } finally {
      job.endedAt = Date.now();
    }
  });
  return job;
}

// 批量在线校验（单批≤200；`ids` 可显式指定要校验的源；limit 控制抽样数量；markOnError=true 失败源自动写 //error 注释+分组标记并落盘）
// `wait=0` ⇒ 异步：立即返回 jobId，用 /api/sources/verify-jobs/:id 轮询（不占 HTTP 线程）
app.post<{
  Querystring: { wait?: string };
  Body: { ids?: string[]; limit?: number; concurrency?: number; keyword?: string; kind?: string; markOnError?: boolean; checkDiscoveryDeep?: boolean };
}>('/api/sources/verify-batch', async (req) => {
  const { ids: explicitIds, limit = 20, concurrency = 3, keyword, kind, markOnError, checkDiscoveryDeep } = req.body ?? {};
  // `#800` 显式 ids：按调用方给的顺序校验（用于「只测这批图片源 / 这批浏览器源」），
  // 不做 dead 跳过（显式点名就是要结果），仍限 200 个防止误传全库。
  const enabledIds = new Set(hub.listSources({ kind, enabled: true }).map((s) => s.id));
  // `B6`：`dead` 且未过跳过期 ⇒ 不再参与体检（3 天后自动回来；`includeDead` 不开放下不给口子）
  const now = Date.now();
  const ids = Array.isArray(explicitIds) && explicitIds.length
    ? explicitIds.filter((id): id is string => typeof id === 'string' && enabledIds.has(id)).slice(0, 200)
    : hub.listSources({ kind, enabled: true })
        .filter((s) => !isSourceHealthDeadActive(sourceHealthStore.get(s.id), now))
        .slice(0, Math.min(200, Math.max(1, limit)))
        .map((s) => s.id);
  if (req.query?.wait === '0') {
    const job = enqueueVerifyJob(ids, { keyword, concurrency, markOnError, checkDiscoveryDeep });
    return { total: ids.length, jobId: job.id, async: true };
  }
  const job = enqueueVerifyJob(ids, { keyword, concurrency, markOnError, checkDiscoveryDeep });
  await verifyQueueTail;
  return { total: ids.length, jobId: job.id, results: job.results, ...(job.error ? { error: job.error } : {}) };
});

/* ------------------------------------------------------------------ `B6` 书源体检 */

/**
 * `B6` **体检任务**（与 `#200` 批量校验共用串行队列，避免两条任务同时把出口 IP 打爆）。
 *
 * 与旧批量校验的关键差异：
 *  ① **可中止**：`abort` 后不再取新条目，在途请求随 `signal` 立即停；**已完成条目保留**；
 *  ② **逐条落结果**：每完成一条立刻算五态/质量分并写 `source-health.json`（中止也不丢）；
 *  ③ **跳过 `dead`**：仍在 3 天跳过期的源默认不进任务，过期后自动回到候选。
 */
interface HealthJob {
  id: string;
  total: number;
  done: number;
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'error';
  results: Array<{ id: string; health: SourceHealth }>;
  error?: string;
  startedAt: number;
  endedAt?: number;
  ac: AbortController;
}
const healthJobs = new Map<string, HealthJob>();
let healthJobSeq = 0;

function enqueueHealthJob(
  ids: string[],
  opts: { keyword?: string; concurrency?: number },
): HealthJob {
  const job: HealthJob = {
    id: `h${Date.now().toString(36)}${(healthJobSeq++).toString(36)}`,
    total: ids.length,
    done: 0,
    state: 'queued',
    results: [],
    startedAt: Date.now(),
    ac: new AbortController(),
  };
  healthJobs.set(job.id, job);
  if (healthJobs.size > 20) {
    for (const k of healthJobs.keys()) {
      if (healthJobs.size <= 20) break;
      // 只清理已结束的任务（正在跑的不动）
      if (k !== job.id && healthJobs.get(k)?.state !== 'running' && healthJobs.get(k)?.state !== 'queued') {
        healthJobs.delete(k);
      }
    }
  }
  const concurrency = Math.max(1, Math.min(6, opts.concurrency ?? 3));
  verifyQueueTail = verifyQueueTail.then(async () => {
    if (job.ac.signal.aborted) {
      job.state = 'cancelled';
      job.endedAt = Date.now();
      return;
    }
    job.state = 'running';
    try {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (!job.ac.signal.aborted) {
          const idx = cursor++;
          const id = ids[idx];
          if (!id) return;
          try {
            const outcome = await hub.verifySource(id, {
              ...(opts.keyword ? { keyword: opts.keyword } : {}),
              signal: job.ac.signal,
            });
            job.results.push({ id, health: sourceHealthStore.apply(id, outcome) });
            job.done += 1;
          } catch (e) {
            if (job.ac.signal.aborted) return; // 中止：不把 AbortError 记成体检失败
            job.results.push({
              id,
              health: sourceHealthStore.apply(id, {
                ok: false,
                message: String(e instanceof Error ? e.message : e),
                respondTime: 0,
                stages: {},
              }),
            });
            job.done += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      job.state = job.ac.signal.aborted ? 'cancelled' : 'done';
    } catch (e) {
      job.state = 'error';
      job.error = String(e instanceof Error ? e.message : e);
      console.error(`[health-job] ${job.id} 失败：${job.error}`);
    } finally {
      job.endedAt = Date.now();
    }
  });
  return job;
}

function publicHealthJob(job: HealthJob) {
  return {
    id: job.id,
    state: job.state,
    total: job.total,
    done: job.done,
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    ...(job.error ? { error: job.error } : {}),
    // 中止后也返回已完成条目（「中止后已完成的条目结果要保留」）
    results: job.results,
  };
}

/**
 * 启动体检。`dead` 源默认跳过（3 天跳过期内）；候选按**有效质量分升序**（差的先查）。
 * `ids` 显式给定也走同一过滤（除 `includeDead=true`）。
 */
app.post<{
  Body: { ids?: string[]; limit?: number; concurrency?: number; keyword?: string; includeDead?: boolean; kind?: string };
}>('/api/sources/health/check', async (req) => {
  const b = req.body ?? {};
  const now = Date.now();
  const explicit = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string' && !!x) : null;
  let pool = hub.listSources({ kind: b.kind, enabled: true });
  if (explicit) {
    const wanted = new Set(explicit);
    pool = pool.filter((s) => wanted.has(s.id));
  }
  if (!b.includeDead) pool = pool.filter((s) => !isSourceHealthDeadActive(sourceHealthStore.get(s.id), now));
  pool = pool
    .slice()
    .sort(
      (a, z) =>
        effectiveSourceQuality(sourceHealthStore.get(a.id), now) -
          effectiveSourceQuality(sourceHealthStore.get(z.id), now) || a.id.localeCompare(z.id),
    );
  const limit = Math.max(1, Math.min(200, b.limit ?? 20));
  const ids = pool.slice(0, limit).map((s) => s.id);
  const job = enqueueHealthJob(ids, { keyword: b.keyword, concurrency: b.concurrency });
  return { jobId: job.id, total: ids.length, ids };
});

/** 体检进度/结果（轮询；中止后仍可读到已完成条目） */
app.get<{ Params: { id: string } }>('/api/sources/health/jobs/:id', async (req, reply) => {
  const job = healthJobs.get(req.params.id);
  if (!job) return reply.code(404).send({ error: 'JOB_NOT_FOUND' });
  return publicHealthJob(job);
});

/** 中止体检：不再取新条目 + 中断在途请求；已完成条目保留 */
app.post<{ Params: { id: string } }>('/api/sources/health/jobs/:id/cancel', async (req, reply) => {
  const job = healthJobs.get(req.params.id);
  if (!job) return reply.code(404).send({ error: 'JOB_NOT_FOUND' });
  if (job.state === 'queued' || job.state === 'running') {
    job.ac.abort();
    job.state = 'cancelled';
    job.endedAt = Date.now();
  }
  return publicHealthJob(job);
});

/** 体检结果全表（源管理列表展示质量列/五态；`ids` 可选） */
app.get<{ Querystring: { ids?: string } }>('/api/sources/health', async (req) => {
  const wanted = req.query?.ids
    ? new Set(req.query.ids.split(',').map((x) => x.trim()).filter(Boolean))
    : null;
  const results = sourceHealthStore
    .list()
    .filter((it) => (wanted ? wanted.has(it.id) : true));
  return { results };
});

/** 轮询批量校验任务进度（`#200` 异步队列） */
app.get<{ Params: { id: string } }>('/api/sources/verify-jobs/:id', async (req, reply) => {
  const job = verifyJobs.get(req.params.id);
  if (!job) return reply.code(404).send({ error: 'JOB_NOT_FOUND' });
  return {
    id: job.id,
    state: job.state,
    total: job.total,
    done: job.done,
    elapsedMs: (job.endedAt ?? Date.now()) - job.startedAt,
    ...(job.error ? { error: job.error } : {}),
    ...(job.state === 'done' ? { results: job.results } : {}),
  };
});

// 导出源合集（Legado 导入格式 JSON 数组）：filter=all|ok|failed（以 //error 标记判定）
app.get<{ Querystring: { filter?: string; kind?: string } }>('/api/sources/export', async (req, reply) => {
  const { filter = 'all', kind } = req.query as { filter?: string; kind?: string };
  const list = hub.listSources({ kind }).filter((s) => {
    const raw = s.raw as Record<string, unknown>;
    const comment = typeof raw['bookSourceComment'] === 'string' ? (raw['bookSourceComment'] as string) : '';
    const marked = comment.includes('//error');
    if (filter === 'ok') return !marked;
    if (filter === 'failed') return marked;
    return true;
  });
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="yuedu-sources-${filter}-${list.length}.json"`);
  return list.map((s) => s.raw);
});

/* ---------------- `#208` 源分享（直链上传 + 分享口令） ---------------- */

/**
 * 直链上传规则的落盘文件。
 * 可用 `YUEDU_SHARE_DL_FILE` 覆盖 —— 临时实例做冒烟时不该动用户那份配置（见协作要点里的
 * 「3000 归用户实际使用」）。
 */
const SHARE_DL_FILE = process.env.YUEDU_SHARE_DL_FILE ?? path.join(DATA_DIR, 'direct-link-upload.json');
const shareDlConfig = new DirectLinkUploadConfig(SHARE_DL_FILE);

/** 当前生效规则 + 是否自定义 + 内置 3 条 */
app.get('/api/share/direct-link', async () => shareDlConfig.getState());

/**
 * 保存自定义规则。body 三选一（都指向「一条规则」）：
 *  - 规则本体 `{ uploadUrl, downloadUrlRule, summary, compress, expiryDate }`
 *  - `{ rule: {...} }`
 *  - `{ paste: "<json 文本>" }`（界面「粘贴规则」入口；容忍 `//` 注释与尾逗号）
 */
app.put<{ Body: unknown }>('/api/share/direct-link', async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let candidate: unknown = body;
  if (typeof body['paste'] === 'string') {
    const parsed = parseDirectLinkUploadRules(body['paste']);
    if (!parsed.ok) return reply.code(400).send({ error: 'RULE_INVALID', message: parsed.error });
    if (parsed.rules.length !== 1) {
      return reply.code(400).send({ error: 'RULE_INVALID', message: `粘贴内容里有 ${parsed.rules.length} 条规则，请只留一条` });
    }
    candidate = parsed.rules[0];
  } else if (body['rule'] !== undefined) {
    candidate = body['rule'];
  }
  const v = validateDirectLinkUploadRule(candidate);
  if (!v.ok) return reply.code(400).send({ error: 'RULE_INVALID', message: v.error });
  shareDlConfig.putConfig(v.rule);
  return shareDlConfig.getState();
});

/** 删除自定义规则 ⇒ 回落内置第 1 条 */
app.delete('/api/share/direct-link', async () => {
  shareDlConfig.delConfig();
  return shareDlConfig.getState();
});

/**
 * 「测试」上传（对齐上游配置对话框左下角）：用 `test.json` + `{}` 发一次。
 * body 可带 `rule` 试一条尚未保存的规则；不带则试当前生效规则。
 * ⚠️ 与上游一致：**失败也回 200**（`{ok:false,error}`）——「测试」的语义是「报告结果」，
 * 不是「提交失败」；回 4xx/5xx 会让前端把它当网络错误。
 */
app.post<{ Body: { rule?: unknown } }>('/api/share/direct-link/test', async (req, reply) => {
  const body = (req.body ?? {}) as { rule?: unknown };
  let rule = shareDlConfig.getRule();
  if (body.rule !== undefined) {
    const v = validateDirectLinkUploadRule(body.rule);
    if (!v.ok) return reply.code(400).send({ error: 'RULE_INVALID', message: v.error });
    rule = v.rule;
  }
  try {
    return { ok: true, result: await testDirectLinkRule(rule) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

/**
 * 把一个**已存在的源**分享出去：源 json → 直链上传 → 分享口令。
 *
 * 状态码分工（界面据此给不同文案）：
 *  - 404 源不存在 · 400 源内容为空 · 409 网盘地址编不成口令（**响应里带 downloadUrl**，
 *    「白上传了也要把链接交给用户」）· 502 上传本身失败（错误详情在 message 里）。
 */
app.post<{ Params: { id: string } }>('/api/sources/:id/share-passphrase', async (req, reply) => {
  const s = hub.sources.get(req.params.id);
  if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  const out = await shareSource({ raw: s.raw, name: s.name ?? '' }, shareDlConfig);
  if (!out.ok) {
    const e = out.error;
    const code = e.kind === 'empty' ? 400 : e.kind === 'unshareable' ? 409 : 502;
    return reply.code(code).send({ error: e.kind.toUpperCase(), ...e });
  }
  return out.value;
});

/* ---------------- `#208` WebDAV 同步 ---------------- */

/**
 * WebDAV 配置落盘文件。
 * 可用 `YUEDU_WEBDAV_FILE` 覆盖 —— 临时实例做冒烟时不该动用户那份配置（见协作要点里的
 * 「3000 归用户实际使用」）。
 */
const WEBDAV_FILE = process.env.YUEDU_WEBDAV_FILE ?? path.join(DATA_DIR, 'webdav.json');
const webdavConfig = new WebDavConfigStore(WEBDAV_FILE);

// `#386` 系统代理开关（设置页「服务与网络」）：GET 回显 / PUT 保存并即时生效
app.get('/api/network-proxy', async () => loadNetworkProxyConfig());

app.put<{ Body: { enabled?: boolean; url?: string } }>('/api/network-proxy', async (req, reply) => {
  const b = req.body ?? {};
  const enabled = b.enabled === true;
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  // URL 语法预检（人话报错回设置页；空 = 环境变量模式，合法）
  const v = validateProxyUrl(url);
  if (!v.ok) return reply.code(400).send({ error: 'BAD_PROXY_URL', detail: v.error });
  const r = applySystemProxy(enabled, url);
  if (!r.ok) return reply.code(400).send({ error: 'APPLY_FAILED', detail: r.error });
  const cfg = { enabled, url };
  saveNetworkProxyConfig(cfg);
  console.log(`[yuedu] 系统代理${enabled ? `开启：${url || '(环境变量)'}` : '关闭'}`);
  return cfg;
});

/** 实际生效状态（诊断用：与用户配置分开——apply 失败时两者不同） */
app.get('/api/network-proxy/active', async () => systemProxyState());

/** 当前状态（**密码已被抹掉**：`config.password` 恒为空串，只有 `hasPassword`） */
app.get('/api/webdav', async () => webdavConfig.state());

/**
 * 「新密码为空 ⇒ 沿用已存密码」的合并。
 *
 * ★★ **PUT 与 test 必须共用这一份**（`#298` 探针抓出来的真缺陷）。
 * 背景：界面回显的密码**恒为空串**（`publicWebDavConfig` 抹掉的，回显密码是安全事故），
 * 所以下面这两种**日常动作**都会带着空密码过来：
 *   · 只改了「同步开关/子目录」就点保存；
 *   · 保存完之后点「测试连接」（表单里的密码框本来就是空的）。
 * 原先只有 PUT 做了合并 ⇒ 用户的体验是「保存成功，但测试连接永远失败」，
 * 而且报的还是「密码不能为空」—— 被前端归到「连不上这个地址（DNS/端口/证书）」，
 * 与真因完全不符（**这就是「同一判据写侧读侧各写一遍必然漂移」的实例**）。
 * ⇒ 抽成一份，两个端点都用；要改密码必须真的填一个新值。
 */
function mergeWebDavPassword(raw: unknown): unknown {
  const prev = webdavConfig.getConfig();
  if (!prev || typeof raw !== 'object' || raw === null) return raw;
  return (raw as Record<string, unknown>)['password'] ? raw : { ...(raw as object), password: prev.password };
}

/**
 * 保存配置。body 形态都收：配置本体 / `{config}` / `{config, syncProgress}` /
 * `{backupKeep}`（`B7` ④ 可单独改保留份数）。
 * 空密码的合并见 `mergeWebDavPassword`。
 */
app.put<{ Body: unknown }>('/api/webdav', async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // `B7` ④：只改保留份数时允许 body 不带 config，沿用已存配置。
  // ⚠️ 不能只判「有没有 config 键」：本端点历来也收**裸配置**（body 直接是 url/username/…），
  // 那种形态要照旧走校验，否则老调用方会「保存成功但什么都没改」。
  const hasConfigKeys = ['url', 'username', 'password', 'dir', 'authEncoding'].some((k) => body[k] !== undefined);
  const raw = (body['config'] !== undefined ? body['config'] : body) as unknown;
  const prev = webdavConfig.getConfig();
  const onlyKeep = body['config'] === undefined && !hasConfigKeys && prev !== null;
  const merged = onlyKeep ? prev : mergeWebDavPassword(raw);
  const v = validateWebDavConfig(merged);
  if (!v.ok) return reply.code(400).send({ error: 'WEBDAV_CONFIG_INVALID', message: v.error });
  const syncProgress = body['syncProgress'] === undefined ? webdavConfig.syncProgressEnabled() : body['syncProgress'] !== false;
  const keep = body['backupKeep'] === undefined ? undefined : clampBackupKeep(body['backupKeep']);
  webdavConfig.put(v.config, syncProgress, keep);
  return webdavConfig.state();
});

/** 删除配置（连带关闭同步） */
app.delete('/api/webdav', async () => {
  webdavConfig.del();
  return webdavConfig.state();
});

/**
 * 「测试连接」。body 可带 `config` 试一份尚未保存的配置；不带则试当前配置。
 * ⚠️ **失败也回 200**（`{ok:false,kind,detail}`）—— 语义是「报告结果」，不是「提交失败」；
 * 回 4xx/5xx 会让前端把它当网络错误，用户就看不到「密码不对」还是「连不上」。
 */
app.post<{ Body: { config?: unknown } }>('/api/webdav/test', async (req, reply) => {
  const body = (req.body ?? {}) as { config?: unknown };
  let cfg = webdavConfig.getConfig();
  if (body.config !== undefined) {
    // ★ 与 `PUT /api/webdav` 同一份空密码合并（见 `mergeWebDavPassword`）：
    //   界面回显的密码是空的，不合并的话「保存后点测试」必然报「密码不能为空」。
    const v = validateWebDavConfig(mergeWebDavPassword(body.config));
    if (!v.ok) return reply.code(400).send({ error: 'WEBDAV_CONFIG_INVALID', message: v.error });
    cfg = v.config;
  }
  if (!cfg) return { ok: false, kind: 'unconfigured', detail: '还没填账号密码' };
  const { WebDavClient } = await import('@yuedu/facade');
  return new WebDavClient(cfg).check();
});

/**
 * 同步一次阅读进度。`?pull=1` ⇒ 只拉不传。
 * 失败分两类：配置类（400/409）与远端类（502），**响应体里都带 `message`**。
 */
app.post<{ Querystring: { pull?: string } }>('/api/webdav/sync', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  try {
    return await syncBookProgress(store, webdavConfig, { downloadOnly: req.query.pull === '1' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = /还没配置|已关闭/.test(msg) ? 409 : 502;
    return reply.code(code).send({ error: 'WEBDAV_SYNC_FAILED', message: msg });
  }
});

/* ---------------- `#208` ④ 整库备份 / 恢复 ---------------- */

/** 列远端备份（最新的在前） */
app.get('/api/webdav/backups', async (_req, reply) => {
  try {
    return { backups: await listBackups(webdavConfig) };
  } catch (e) {
    return reply.code(502).send({ error: 'WEBDAV_LIST_FAILED', message: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * 备份当前整库到 WebDAV。
 *
 * `#621`：Body 可带勾选内容与口令 ——
 * ```jsonc
 * { "options": ["bookshelf","annotations","rules","history","settings"], "password": "***" }
 * ```
 * 旧调用方式（`?chapters=1`、无 body）仍然有效：等价于「默认勾选 + 目录」。
 *
 * 文件名按上游格式 `backup<yyyy-MM-dd>.zip` ⇒ **同一天重复备份会覆盖**（与上游一致，
 * 上游也用日期做名；要留多份就手动改天或用设备名后缀）。
 */
app.post<{ Querystring: { chapters?: string }; Body: { options?: string[]; password?: string } | null }>(
  '/api/webdav/backup',
  async (req, reply) => {
    const store = await userStoreOr503(reply);
    if (!store) return;
    const body = (req.body ?? {}) as { options?: string[]; password?: string };
    // 勾选内容优先用 body 里的；没给 body 就退回旧的 `?chapters=1` 语义
    const options = Array.isArray(body.options)
      ? body.options
      : req.query.chapters === '1'
        ? [...defaultBackupOptions(), 'chapters']
        : undefined;
    try {
      const result = await uploadBackup(store, webdavConfig, {
        options,
        password: body.password ?? '',
        // 敏感项数据来自 hub（内存态 + 落盘）；这里不读文件，避免与 `#616` 的加密层打架
        cookies: () => hub.exportSourceCookies(),
        sourceVariables: () => hub.exportSourceVariables(),
      });
      // `B7` ④ 轮转：**只在成功写完一份新备份后**清旧的（删除不可逆，必须与写入绑定）。
      // 清理失败不影响备份成功的结论，单独回 `rotationError` 让界面提示。
      try {
        const rotation = await pruneBackups(webdavConfig, webdavConfig.backupKeepCount());
        return { ...result, rotation };
      } catch (e) {
        return { ...result, rotationError: e instanceof Error ? e.message : String(e) };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // `#621`：勾了敏感项但没口令 ⇒ 400（这是**参数问题**，不是网盘问题），
      // 否则界面会提示「网盘挂了」，用户永远找不到原因
      const code = e instanceof BackupOptionError
        ? 400
        : /还没配置/.test(msg)
          ? 409
          : 502;
      return reply.code(code).send({
        error: e instanceof BackupOptionError ? e.code : 'WEBDAV_BACKUP_FAILED',
        message: msg,
      });
    }
  },
);

/**
 * 从远端备份恢复。**破坏性操作** ⇒ 必须带 `confirm=1`。
 *
 * ⚠️ 走的是**非累加**管线（`importSnapshot` 的 `overwrite`）—— 累加型导入不适合「恢复」：
 * 它会把旧记录再插一遍，而**删掉的东西回不来**。
 *
 * `#621`：Body 可带 `password`（备份里含加密的 Cookie/源变量时必需）。
 * `B7` ③：Body 可带 `mode: 'overwrite' | 'merge'`（默认 overwrite）。
 * 且恢复按备份声明的 `included` 裁剪 —— 备份里没带的内容**一个字段都不动**。
 */
app.post<{ Body: { name?: string; password?: string; mode?: string }; Querystring: { confirm?: string } }>(
  '/api/webdav/restore',
  async (req, reply) => {
    const store = await userStoreOr503(reply);
    if (!store) return;
    if (req.query.confirm !== '1') {
      return reply
        .code(400)
        .send({ error: 'CONFIRM_REQUIRED', message: '恢复会覆盖现有数据：请带 ?confirm=1 再调用（建议先备份一次）' });
    }
    const name = (req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'NAME_REQUIRED', message: '要指定备份文件名（先用 /api/webdav/backups 列出来）' });
    const mode: RestoreMode = req.body?.mode === 'merge' ? 'merge' : 'overwrite';
    try {
      const r = await restoreBackup(store, webdavConfig, name, {
        password: req.body?.password ?? '',
        mode,
        // 写回登录态：必须先设 Cookie 再落盘，否则重启就回到「没登录」
        setCookies: (id, cookie) => hub.setSourceCookies(id, cookie),
        setSourceVariable: (id, value) => hub.setSourceVariable(id, value),
      });
      if (r.cookiesRestored > 0) persistSourceCookies();
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // `#621`：口令问题也是 400 —— 用户改口令就能过，不该当成网盘故障
      const code =
        e instanceof BackupOptionError
          ? 400
          : /还没配置/.test(msg)
            ? 409
            : /不是备份文件|不是一份快照|不是合法 JSON/.test(msg)
              ? 400
              : 502;
      return reply.code(code).send({ error: e instanceof BackupOptionError ? e.code : 'WEBDAV_RESTORE_FAILED', message: msg });
    }
  },
);

/**
 * `#621` 可勾选的备份内容清单。
 *
 * 界面**不该自己写死**这份清单（写死等于第二份真相源，加一项忘一处就漏备份）⇒
 * 由服务端下发，界面照渲染；`unsupported` 也一起给，界面可以拿它解释
 * 「为什么没有『封面』这个勾选框」。
 */
app.get('/api/backup/options', async () => ({
  options: BACKUP_OPTIONS,
  defaultOn: [...defaultBackupOptions()],
  unsupported: UNSUPPORTED_BACKUP_OPTIONS,
}));

/* ------------------------------------------------------------------ *
 * 设置 → 数据备份：Legado 兼容 + 本仓完整（文件模式）
 * ------------------------------------------------------------------ */

/** 预检缓存：zip 上传一次，确认页复用；最多留 3 份，15 分钟过期 */
interface PendingBackup {
  bytes: Uint8Array;
  mode: 'legado' | 'full';
  password: string;
  expiresAt: number;
}
const pendingBackups = new Map<string, PendingBackup>();
const PENDING_BACKUP_TTL = 15 * 60 * 1000;

function putPendingBackup(bytes: Uint8Array, mode: 'legado' | 'full', password: string): string {
  const now = Date.now();
  for (const [k, v] of pendingBackups) if (v.expiresAt <= now) pendingBackups.delete(k);
  if (pendingBackups.size >= 3) {
    const oldest = [...pendingBackups.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) pendingBackups.delete(oldest[0]);
  }
  const token = randomUUID();
  pendingBackups.set(token, { bytes, mode, password, expiresAt: now + PENDING_BACKUP_TTL });
  return token;
}

function takePendingBackup(token: string): PendingBackup {
  const hit = pendingBackups.get(token);
  if (!hit) throw new BackupError('TOKEN_EXPIRED', '预检已过期，请重新选择文件');
  if (hit.expiresAt <= Date.now()) {
    pendingBackups.delete(token);
    throw new BackupError('TOKEN_EXPIRED', '预检已过期，请重新选择文件');
  }
  return hit;
}

function sourceRuntimeList(): Array<{ id: string; kind: string; raw: Record<string, unknown> }> {
  return hub.listSources().map((s) => ({ id: s.id, kind: s.kind, raw: (s.raw ?? {}) as Record<string, unknown> }));
}

const importDeps = {
  sources: {
    list: sourceRuntimeList,
    importRows(rows: ImportRow[], opts: { dedupe: 'skip' | 'overwrite' }) {
      const res = hub.importRows(rows as never, { dedupe: opts.dedupe } as never) as unknown as {
        inserted: number;
        updated: number;
        skipped: number;
        failed: number;
        results: Array<{ ok: boolean; id?: string; action?: string }>;
      };
      for (const r of res.results) if (r.ok && r.id && r.action !== 'skipped') sourceLayer.remember(r.id);
      sourceLayer.persist();
      return res;
    },
    persist() {
      sourceLayer.persist();
    },
  },
  tts: ttsStore,
  setCookies: (id: string, cookie: string) => hub.setSourceCookies(id, cookie),
  setSourceVariable: (id: string, value: string) => hub.setSourceVariable(id, value),
};

function backupErrorReply(reply: FastifyReply, e: unknown) {
  if (e instanceof BackupError) return reply.code(400).send({ error: e.code, detail: e.message });
  return reply.code(500).send({ error: 'BACKUP_FAILED', detail: e instanceof Error ? e.message : String(e) });
}

app.get('/api/backup/modes', async () => ({
  legado: { options: LEGADO_OPTIONS, defaultOn: LEGADO_OPTIONS.filter((o) => o.defaultOn).map((o) => o.id) },
  full: { options: FULL_OPTIONS, defaultOn: FULL_OPTIONS.filter((o) => o.defaultOn).map((o) => o.id) },
}));

/**
 * 预检：上传 zip（原始字节，`application/octet-stream`），只解析不写库。
 * 头 `x-backup-password`：Legado 的敏感条目 / 本仓完整备份的加密条目需要。
 * 查询 `options`：逗号分隔；缺省用各模式默认勾选。完整备份的默认勾选由包内实际内容推断。
 */
app.post<{ Querystring: { options?: string } }>('/api/backup/inspect', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const bytes = req.body as Buffer | undefined;
  if (!bytes || !bytes.length) return reply.code(400).send({ error: 'EMPTY_BODY', detail: '备份文件是空的' });
  const password = String((req.headers['x-backup-password'] ?? '') as string);
  const picked = req.query.options ? req.query.options.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  try {
    const kind = detectArchiveKind(readZip(bytes));
    const token = putPendingBackup(bytes, kind, password);
    if (kind === 'legado') {
      const archive = readLegadoArchive(bytes);
      const index = buildSourceIndex(sourceRuntimeList());
      const preview = await previewLegado(archive, picked, store, index, token);
      // `options` 对客户端一律是**字符串 id**（可直接回传给 apply）；元信息另放 `optionMeta`
      return {
        ...preview,
        token,
        format: 'legado',
        options: normalizeLegadoOptions(picked),
        optionMeta: preview.options,
      };
    }
    const archive = readFullArchive(bytes, password);
    const preview = previewFull(archive, await store.listBooks());
    const options = picked && picked.length ? normalizeFullOptions(picked) : defaultFullRestoreOptions(archive);
    return {
      ...preview,
      token,
      format: 'full',
      options,
      optionMeta: FULL_OPTIONS,
      available: FULL_OPTIONS.filter((o) => fullOptionAvailable(o.id, archive)).map((o) => o.id),
      entries: [...readZip(bytes).entries()].map(([name, data]) => ({
        name: name.split(/[\\/]/).pop() ?? name,
        bytes: data.length,
      })),
    };
  } catch (e) {
    return backupErrorReply(reply, e);
  }
});

function fullOptionAvailable(id: string, archive: ReturnType<typeof readFullArchive>): boolean {
  const snap = archive.snapshot;
  if (id === 'bookshelf') return !!(snap.books || snap.bookGroups || archive.legacy);
  if (id === 'chapters') return !!snap.chapters;
  if (id === 'annotations') return !!(snap.bookmarks || snap.highlights || snap.highlightRules || snap.bookMemos);
  if (id === 'rules') return !!(snap.replaceRules || snap.dictRules);
  if (id === 'history') return !!(snap.readRecords || snap.searchHistory);
  if (id === 'settings') return !!snap.prefs;
  if (id === 'sources') return !!(archive.sources?.bookSources.length || archive.sources?.rssSources.length);
  if (id === 'cmsSources') return !!archive.sources?.cmsSources.length;
  if (id === 'tts') return !!archive.tts;
  if (id === 'cookies') return !!archive.cookies;
  if (id === 'sourceVariables') return !!archive.sourceVariables;
  return false;
}

/** 确认恢复：`{ token, options?, password? }` */
app.post<{ Body: { token?: string; options?: string[]; password?: string } }>('/api/backup/apply', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const token = String(req.body?.token ?? '');
  if (!token) return reply.code(400).send({ error: 'TOKEN_REQUIRED', detail: '缺少预检 token' });
  try {
    const pending = takePendingBackup(token);
    const password = req.body?.password ?? pending.password;
    if (pending.mode === 'legado') {
      const archive = readLegadoArchive(pending.bytes);
      const result = await applyLegado(archive, req.body?.options, store, importDeps, password);
      await sourceLayer.whenIdle();
      markSourcesChanged('Legado 备份恢复');
      pendingBackups.delete(token);
      return result;
    }
    const archive = readFullArchive(pending.bytes, password);
    const options = req.body?.options ?? defaultFullRestoreOptions(archive);
    const result = await applyFull(archive, options, store, importDeps);
    await sourceLayer.whenIdle();
    markSourcesChanged('完整备份恢复');
    pendingBackups.delete(token);
    return result;
  } catch (e) {
    return backupErrorReply(reply, e);
  }
});

/**
 * 导出 zip：`{ mode, options, password? }`。响应是 zip 字节，文件名在 `content-disposition`。
 */
app.post<{ Body: { mode?: string; options?: string[]; password?: string } }>('/api/backup/export', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const mode = req.body?.mode === 'full' ? 'full' : 'legado';
  const password = String(req.body?.password ?? '');
  try {
    if (mode === 'legado') {
      const out = await exportLegado(store, req.body?.options, buildSourceIndex(sourceRuntimeList()), ttsStore);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="legado-backup-${new Date().toISOString().slice(0, 10)}.zip"`)
        .header('x-backup-stats', encodeURIComponent(JSON.stringify({ stats: out.stats, warnings: out.warnings })))
        .send(Buffer.from(out.zip));
    }
    const out = await exportFull(
      store,
      req.body?.options,
      {
        sources: { list: sourceRuntimeList },
        tts: ttsStore,
        cookies: () => hub.exportSourceCookies(),
        sourceVariables: () => hub.exportSourceVariables(),
      },
      password,
    );
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="yuedu-full-backup-${new Date().toISOString().slice(0, 10)}.zip"`)
      .header('x-backup-stats', encodeURIComponent(JSON.stringify({ stats: out.stats, warnings: out.warnings })))
      .send(Buffer.from(out.zip));
  } catch (e) {
    return backupErrorReply(reply, e);
  }
});

/** 按魔数识别图片类型（解密后的图片上游常给 application/octet-stream） */
function sniffImageType(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  // ISO-BMFF（`ftyp`）**不等于 AVIF**：mp4 / m4a / mov 同样是 ftyp 开头，
  // 按 ftyp 一律当 avif 会把「上游 octet-stream 的音频」改写成 image/avif
  // （实测 🔊书音M：m4a 经代理后 Content-Type=image/avif）。
  // 只有 brand 明确是 avif/avis 才认。
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

/**
 * 代理取图用的**源侧请求头**（2026-09-23 新增，用户实测 ②）。
 *
 * 为什么必需：防盗链图站只认「站点自己的 Referer/UA」。实测 📷🔞学姐吧：
 * 同一张封面 URL —— 带 `Referer: https://xuejieba2026.com` → **200 / 61394 字节**；
 * 不带（＝浏览器直连本应用页面时的 Referer）→ **404 text/html**。
 * 前端此前封面用**裸 URL** 直连 → 一律 404 → 被 `@error` 隐藏 → 表现成「无封面」。
 *
 * 合并顺序对齐引擎侧 `makeEnv` 的 `getSourceHeaders`（同一语义，防两处漂移）：
 *   ① 源 `header` 规则（**只处理静态 JSON**；脚本型交给引擎那条路，这里跳过并留痕）
 *   ② 登录头（`source.putLoginHeader` 持久化的 JSON）——**覆盖** ① 的同名项
 *   ③ 源 Cookie（`Cookie` 头）
 * `Referer` 若最后由调用方显式给（`?r=`）则以它为准（前端知道更精确的来源页）。
 */
async function sourceProxyHeaders(sid?: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!sid || !hub.sources.has(sid)) return out;
  const rawHeader = (hub.sources.get(sid)?.raw as Record<string, unknown> | undefined)?.['header'];
  if (typeof rawHeader === 'string' && rawHeader.trim()) {
    const t = rawHeader.trim();
    if (isScriptSourceHeader(t)) {
      if (!warnedScriptHeader.has(sid)) {
        warnedScriptHeader.add(sid);
        console.warn(`[proxy] 源 ${sid} 的 header 是脚本型 —— 取图代理只支持静态 JSON header，本次不带源头`);
      }
    } else {
      // `#467`：与两引擎同一份静态解析（core 唯一实现）；解析不出就少带头，不发错头
      const parsed = parseStaticSourceHeader(t);
      if (parsed) Object.assign(out, parsed);
    }
  }
  try {
    const lh = await hub.loadSourceLoginHeader(sid);
    if (lh) {
      const o = JSON.parse(lh) as Record<string, unknown>;
      for (const [k, v] of Object.entries(o ?? {})) if (v != null) out[k] = String(v);
    }
  } catch {
    /* 登录头解析失败忽略 */
  }
  try {
    const ck = hub.getSourceCookies(sid);
    if (ck && !Object.keys(out).some((k) => k.toLowerCase() === 'cookie')) out['Cookie'] = ck;
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * `#731` **验证会话与引擎请求的 UA 同源**（断点 2）。
 *
 * 取值顺序与引擎实际行为对齐：
 *   ① `sessionUaBySource`（`#658` 过闸后覆盖写入的那一条）—— 这才是引擎**现在**在用的 UA；
 *   ② 源静态 header 的 `User-Agent` / `Accept-Language`；
 *   ③ 都没有 ⇒ 返回空对象，由 `bootInto` 反向登记浏览器 UA（让引擎跟随浏览器）。
 *
 * 为什么不能直接用「Chrome 默认 UA」：clearance 与 UA 绑定，两边不一致等于白过闸。
 */
async function verificationFingerprint(sid: string): Promise<{ ua?: string; acceptLanguage?: string }> {
  const saved = sessionUaBySource.get(sid);
  if (saved) return { ua: saved };
  try {
    const h = await sourceProxyHeaders(sid);
    const pick = (name: string): string => {
      const k = Object.keys(h).find((x) => x.toLowerCase() === name);
      return k ? String(h[k] ?? '').trim() : '';
    };
    const ua = pick('user-agent');
    const al = pick('accept-language');
    return { ...(ua ? { ua } : {}), ...(al ? { acceptLanguage: al } : {}) };
  } catch {
    return {};
  }
}

/**
 * `#428`（`D12`=A）该源是否显式开了「按源忽略 TLS 校验」。
 *
 * 只读源的 `state.allowInsecureTls`（用户在源管理里显式勾选，界面带风险提示；缺省 false）。
 * 用在 `/api/proxy` 两条半边（GET/POST）—— 封面/图片/媒体/沙箱页 ajax 与引擎走**同一条**通路，
 * 不同步的话会出现「列表能出、封面全裂」这类半通状态。
 */
function sourceAllowsInsecureTls(sid?: string): boolean {
  if (!sid) return false;
  return hub.sources.get(sid)?.state?.allowInsecureTls === true;
}

/** 已告警过的「脚本型 header」源（每个只报一次） */
const warnedScriptHeader = new Set<string>();

/**
 * 取图/媒体代理专用的 HTTP 客户端 —— **复用引擎同一份网络护栏**
 * （全局并发 6 / 单主机 2 / 带宽 30% / 响应体 8MB，见 core `net/index.ts`）。
 *
 * 为什么必须：2026-09-23 起封面/图片**统一走代理**（防盗链 + 动图透传），
 * 此前这个路由用的是**裸 `fetch`** —— 一次发现页就可能有 60 张封面在飞，
 * 无上限扇出正是用户实测过的「占满网络 → 同局域网其它设备卡死」（缺陷类T）的自伤形态。
 * 走护栏后：并发被 6/2 封顶、单响应体被 8MB 截断，且流量计入 `/api/diag` 的 `netStats`（可观测）。
 */
const proxyHttp = createHttpClient();

/** `#367` 代理默认 UA（安卓手机，对齐 Legado 移动端语义）与桌面兜底 UA（蓝奏云类 WAF 补发用） */
const PROXY_UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const PROXY_UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* `#551` 源医生 v2-B/C：单字段试跑 + 选择器探针                         */
/* ------------------------------------------------------------------ */

/**
 * 试跑物料：**给 URL 就取页面**，走 `proxyHttp` + `sourceProxyHeaders`
 * —— 与 `/api/proxy` **同一条网络通路**（护栏/源头/Cookie/字符集解码全一致）。
 *
 * 为什么不另开一条裸 fetch：裸 fetch 正是「一页 60 张封面打满 NAT」这类自伤的来源，
 * 而且不带头 ⇒ 拿到的很可能是过闸页，试跑结果会指向完全错误的结论。
 *
 * ⚠️ **不渲染 JS**（`/api/sessions/render` 那档）：试跑是秒级交互，渲染是秒级~十秒级且要开浏览器。
 *    需要渲染后 DOM 的页面，请用户在「站点探查」里取到页面后**粘贴内容**进来。
 */
async function fetchProbePage(
  url: string,
  sid?: string,
  cs?: string,
): Promise<{ content?: string; baseUrl?: string; status?: number; error?: string }> {
  if (!/^https?:\/\//i.test(url)) return { error: 'BAD_URL（只支持 http/https）' };
  try {
    const srcHeaders = await sourceProxyHeaders(sid);
    const res = await proxyHttp.request(url, {
      headers: { 'User-Agent': PROXY_UA_MOBILE, Accept: '*/*', ...srcHeaders },
      // `#428`：与主请求同一判据（源显式开了忽略 TLS ⇒ 探针同样放行）
      ...(sourceAllowsInsecureTls(sid) ? { allowInsecureTls: true } : {}),
      timeout: 20_000,
      // `#470`：一次性 arraybuffer（试跑要把整页喂给选择器，流式没有意义）
      responseType: 'arraybuffer',
      priority: 'low',
    });
    const buf = Buffer.from(res.body as ArrayBuffer);
    const type = String(res.headers?.['content-type'] ?? '');
    // `#439`：字符集判定/解码走 core 唯一实现（否则 GBK 页会整页變成 U+FFFD，试跑结论全错）
    const text = decodeBytes(buf, detectResponseCharset(buf, type, cs ?? ''));
    return { content: text, baseUrl: res.url || url, status: res.status };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `#565` **撞盾后的浏览器过盾链**（无头 ⇒ 有头）—— 搜索试跑 / 动态取页共用一份。
 *
 * 为什么提出来：发现试跑（`#562`/`#564`）里已内联过同一套链，而**搜索试跑与取页没有**
 * ⇒ 用户实测 138阅读网「搜索试跑不过盾、发现试跑能过」——同一台机器两条路，说不通。
 * 提出来后发现试跑那两处也改调它（口径只有一份，不复制）。
 *
 * 口径与发现试跑逐条对齐：
 *  · 判据只看内容特征（`isChallengePage`），不看状态码（挑战页可能回 200/403/503）；
 *  · 先无头 `webRenderer`（便宜、看不见），无头仍挑战页/太短 ⇒ 有头 `antibotPassPage`
 *    （窗口在屏幕外，用户看不见；成功会把 cookie 回收进源 CookieJar ⇒ 后续静态直连）；
 *  · 成功判据用 `onlyVia` **收窄复查**（过盾后正文残留盾方脚本不算失败，`self-fetch.ts` 头注）；
 *  · 「太短」（<500 字）也算没渲出来（`#564`：清关会话 1.2s 快路径会给 39 字节半截 DOM）。
 *
 * @param via 最初静态页命中的盾特征（收窄复查用，见 `isChallengePage` 第二参）
 * @returns 过盾后的正文 + 途径；没过盾回 `{ html: '' }`（调用方按挑战页口径自己报）
 */
async function passChallengeViaBrowser(
  url: string,
  via: string,
  sid?: string,
): Promise<{ html: string; passVia: string }> {
  const tooSmall = (h: string): boolean => !h || h.length < 500;
  let html = await webRenderer(url, { ...(sid ? { sourceId: sid } : {}) }).catch(() => '');
  let passVia = '';
  if ((!html || isChallengePage(html, via).challenge || tooSmall(html)) && sid) {
    const pass = await antibotPassPage(url, sid, { openVerification: true }).catch(() => ({ html: '', via: '' }));
    if (pass.html && !isChallengePage(pass.html, via).challenge && !tooSmall(pass.html)) {
      html = pass.html;
      passVia = pass.via ?? '有头 Chromium 过盾';
    }
  }
  if (html && !isChallengePage(html, via).challenge && !tooSmall(html)) {
    // `#565` 标签别写死「无头」：webRenderer 命中 L3 常驻（**有头**会话，带着已回收的
    // 过盾 cookie）时也是这条路出来的 —— 138阅读网搜索试跑实测正是 L3 出的 115KB 正文。
    // 诊断文字要对得上真实来路，否则用户按提示去排查一个不存在的「无头」问题。
    return { html, passVia: passVia || '浏览器渲染层' };
  }
  return { html: '', passVia: '' };
}

/**
 * **`#551` B：单字段试跑** —— 一条字段规则 + 一份内容 ⇒ 解出的值 / 命中数 / 耗时 / 失败码。
 *
 * 内容两条来路：`content`（前端粘贴，或「站点探查」取到的页面）优先；没有则 `url`（服务端代取，带源头）。
 * 判据全部在 core（`diag/probe.ts`），**与引擎同一个 `AnalyzeRule`** ⇒ 试跑结果 = 真跑结果。
 *
 * ⚠️ 诚实边界（别吹成「等于真跑」）：
 *   · `source` 绑定是**真桩**（`#553`：与引擎同一份 `makeSourceStub`），但两处**有意隔离**：
 *     `putConcurrent` 不改本进程限频表 · `getHeaderMap()` 给 `{}`（探针没有源 header/登录头上下文）。
 *     依赖 `this.getHeaderMap()` 里签名字段的脚本，试跑结果可能与真跑不同。
 *   · 脚本里的 `java.ajax` 走 L1 缺省同步 HTTP（探针不注入 ctx.http）⇒ 慢且会阻塞。
 */
app.post<{
  Body: {
    sourceId?: string;
    field?: string;
    rule?: string;
    content?: string;
    url?: string;
    cs?: string;
    baseUrl?: string;
    mode?: 'string' | 'list' | 'elements';
    isUrl?: boolean;
    /** `#555` 列表项作用域（行内字段：先取列表项，再逐项求值） */
    scopeRule?: string;
    scopeLimit?: number;
    /**
     * `#565` **预处理 init 规则**（`ruleBookInfo.init`）：详情字段的求值内容**先被 init 的
     * 结果替换**（引擎 `BookInfo.kt:58` 语义）。前端草稿态显式传；已存源可由服务端从
     * raw 自动补（见下方 field 前缀判定），老前端不传也不坏。
     */
    initRule?: string;
  };
}>('/api/doctor/probe', async (req, reply) => {
  const b = req.body ?? {};
  const rule = typeof b.rule === 'string' ? b.rule : '';
  if (!rule.trim()) return reply.code(400).send({ error: 'RULE_REQUIRED' });
  let content: string | undefined = typeof b.content === 'string' && b.content ? b.content : undefined;
  let baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl : undefined;
  let fetched: { status?: number; error?: string } = {};
  if (!content && typeof b.url === 'string' && b.url.trim()) {
    const got = await fetchProbePage(b.url.trim(), b.sourceId, b.cs);
    if (got.error) return reply.code(502).send({ error: `FETCH_FAILED: ${got.error}` });
    content = got.content;
    baseUrl = got.baseUrl ?? b.url.trim();
    fetched = { status: got.status };
  }
  /**
   * `#561` **自取数规则不需要页面物料** —— 服务端是这条判据的唯一裁判。
   *
   * 七猫官方这类 API 源：`bookList` 是 `<js>` + `java.ajax`（自己请求接口），分类页本身 404。
   * 前端没有物料时过去直接被「先给试跑物料」挡死 ⇒ 用户看到「点击没有响应」，
   * 且**后续所有行内字段**（name/author…作用域 = bookList）全部连锁没法试跑。
   * 现在：没有物料且（规则或作用域）是自取数 JS ⇒ 服务端放行，用统一占位内容真跑
   * （那条 JS 不读页面内容，占位只为了让探针放行）；否则维持原判（NO_CONTENT）。
   */
  let selfFetch = false;
  if (!content) {
    const scopeRule = typeof b.scopeRule === 'string' ? b.scopeRule : '';
    if (isSelfFetchingRule(rule) || (scopeRule.trim() && isSelfFetchingRule(scopeRule))) {
      content = SELF_FETCH_PLACEHOLDER;
      selfFetch = true;
    }
  }
  const raw = b.sourceId ? (hub.sources.get(b.sourceId)?.raw as Record<string, unknown> | undefined) : undefined;
  /**
   * `#565` **init 预处理链自动接线**：`ruleBookInfo.*`（非 init 自己）的求值内容先被
   * `ruleBookInfo.init` 的结果替换（引擎同口径）。优先级：
   *   ① 前端显式传的 `initRule`（草稿态 —— 源还没存，服务端没有 raw）；
   *   ② 已存源从 `raw.ruleBookInfo.init` 补（老前端不传也能对上）。
   * init 自身不需要（它就是第一棒），空 init 等于没有。
   */
  const fieldPath = typeof b.field === 'string' ? b.field : '';
  let initRule = typeof b.initRule === 'string' ? b.initRule.trim() : '';
  if (!initRule && fieldPath.startsWith('ruleBookInfo.') && fieldPath !== 'ruleBookInfo.init') {
    const rawInit = raw?.['ruleBookInfo'] as { init?: unknown } | undefined;
    if (typeof rawInit?.init === 'string') initRule = rawInit.init.trim();
  }
  const r = await probeField({
    rule,
    content,
    ...(baseUrl ? { baseUrl } : {}),
    ...(b.mode ? { mode: b.mode } : {}),
    ...(b.isUrl ? { isUrl: true } : {}),
    ...(typeof b.scopeRule === 'string' && b.scopeRule.trim() ? { scopeRule: b.scopeRule } : {}),
    ...(typeof b.scopeLimit === 'number' ? { scopeLimit: b.scopeLimit } : {}),
    ...(initRule ? { initRule } : {}),
    ...(typeof raw?.['jsLib'] === 'string' ? { lib: raw['jsLib'] as string } : {}),
    // `#553`：交**原始 JSON** 即可，桩由 core 的 makeSourceStub 建（与引擎同一份）
    ...(raw ? { source: raw } : {}),
    ...(b.field ? { field: b.field } : {}),
  });
  // ⚠️ 不要再套一层 `ok:true` —— `r.ok` 就是试跑结论（「规则跑通了吗」），覆盖它等于撒谎
  return {
    ...r,
    ...(fetched.status !== undefined ? { fetchedStatus: fetched.status } : {}),
    ...(selfFetch ? { selfFetch: true } : {}),
  };
});

/**
 * **`#551` C：选择器探针** —— 命中数 + 元素样本 + **0 命中时的启发式候选**（纯规则，无 LLM）。
 *
 * 候选怎么来的（都写在返回值的 `why` 里，可复核）：
 *  ① 语法变体（去掉 `@attr` / 去 `##正则` / `class.x`⇄`.x` / 去索引）逐个真跑，报各自命中数；
 *  ② 仍 0 命中 ⇒ 页面统计：HTML 给 class 频次 top N，JSON 给键路径 `$.k` / `$.k[*]`。
 */
app.post<{
  Body: {
    sourceId?: string; selector?: string; content?: string; url?: string; cs?: string; baseUrl?: string;
    maxCandidates?: number;
    /** `#677` 样本条数 / 每条字符上限 / 值模式（见 core `SelectorProbeRequest`） */
    sampleLimit?: number; sampleMax?: number; valueMode?: boolean;
  };
}>('/api/doctor/selector-probe', async (req, reply) => {
  const b = req.body ?? {};
  const selector = typeof b.selector === 'string' ? b.selector : '';
  if (!selector.trim()) return reply.code(400).send({ error: 'SELECTOR_REQUIRED' });
  let content: string | undefined = typeof b.content === 'string' && b.content ? b.content : undefined;
  let baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl : undefined;
  if (!content && typeof b.url === 'string' && b.url.trim()) {
    const got = await fetchProbePage(b.url.trim(), b.sourceId, b.cs);
    if (got.error) return reply.code(502).send({ error: `FETCH_FAILED: ${got.error}` });
    content = got.content;
    baseUrl = got.baseUrl ?? b.url.trim();
  }
  const raw = b.sourceId ? (hub.sources.get(b.sourceId)?.raw as Record<string, unknown> | undefined) : undefined;
  const r = await probeSelector({
    selector,
    content: content ?? '',
    ...(baseUrl ? { baseUrl } : {}),
    ...(typeof raw?.['jsLib'] === 'string' ? { lib: raw['jsLib'] as string } : {}),
    ...(typeof b.maxCandidates === 'number' ? { maxCandidates: b.maxCandidates } : {}),
    /**
     * `#677` 物料源码查看器：命中多少就回多少（旧默认只回 3 条 220 字，用户实测
     * 「命中 10 项，下面只显示 3 项」），并且开**值模式**（`img@src` / `a@text` 回取到的值，
     * 元素 HTML 另放 `htmlSamples` 供定位与二次匹配）。
     */
    ...(typeof b.sampleLimit === 'number' ? { sampleLimit: b.sampleLimit } : {}),
    ...(typeof b.sampleMax === 'number' ? { sampleMax: b.sampleMax } : {}),
    ...(b.valueMode === true ? { valueMode: true } : {}),
  });
  return { ...r };
});

/* ------------------------------------------------------------------ */
/* `#555` 试跑前置：连通测试 / 搜索试跑 / 登录界面静态解析               */
/* ------------------------------------------------------------------ */

/** 从 HTML 头 8KB 里取 `<title>`（探活回显用，取不到就空串） */
function titleOfHtml(html: string): string {
  const m = html.slice(0, 8192).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? String(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

/**
 * 「这个页面像不像**被挡在门外**」的静态判据（只判形态，不下结论）。
 * 用户要的是「站点能通」，而通 ≠ 能用：反爬页/登录墙也是 200。
 */
function reachHints(html: string, status: number, finalUrl: string): string[] {
  const hints: string[] = [];
  if (status >= 400) hints.push(`HTTP ${status}：站点拒绝或页面不存在`);
  if (status >= 300 && status < 400) hints.push(`HTTP ${status}：被重定向（最终到 ${finalUrl}）`);
  const head = html.slice(0, 4096).toLowerCase();
  if (/just a moment|cf-challenge|__cf_chl|attention required/.test(head)) {
    hints.push('疑似 Cloudflare 挑战页（浏览器能过、服务端直取过不去）');
  }
  if (/请先登录|请登录后|登录后查看|需要登录/.test(html.slice(0, 20000))) {
    hints.push('页面含「请登录」字样：可能是登录墙，匿名访问取不到内容');
  }
  if (/验证码|captcha|人机验证/.test(html.slice(0, 20000))) {
    hints.push('页面含验证码/人机验证：直取会被拦');
  }
  if (/访问过于频繁|请求过于频繁|rate limit/i.test(html.slice(0, 20000))) {
    hints.push('页面提示访问频繁：限流中');
  }
  return hints;
}

/**
 * **连通测试**（用户 2026-10-21：`bookSourceUrl` 只是网址，只需要「站点能通」）。
 *
 * 与「试跑」的区别：这里**不做任何规则匹配**，只回答：状态码 / 最终 URL / 耗时 / 大小 /
 * 页面标题 / 是否疑似被挡（反爬页、登录墙、限流也可能是 200）。
 * 走与取页同一条通路（源 header + Cookie + 忽略 TLS 开关）⇒ 通不通的结论与真跑一致。
 */
app.post<{ Body: { url?: string; sourceId?: string; cs?: string } }>('/api/doctor/reach', async (req, reply) => {
  const url = String(req.body?.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'BAD_URL（只支持 http/https）' });
  const sid = req.body?.sourceId;
  const t0 = Date.now();
  const srcHeaders = await sourceProxyHeaders(sid);
  try {
    const res = await proxyHttp.request(url, {
      headers: { 'User-Agent': PROXY_UA_MOBILE, Accept: 'text/html,application/xhtml+xml,*/*', ...srcHeaders },
      ...(sourceAllowsInsecureTls(sid) ? { allowInsecureTls: true } : {}),
      timeout: 20_000,
      responseType: 'arraybuffer',
      priority: 'low',
    });
    const buf = Buffer.from(res.body as ArrayBuffer);
    const type = String(res.headers?.['content-type'] ?? '');
    const text = decodeBytes(buf, detectResponseCharset(buf, type, req.body?.cs ?? ''));
    const finalUrl = res.url || url;
    return {
      ok: res.status < 400,
      status: res.status,
      finalUrl,
      ms: Date.now() - t0,
      bytes: buf.length,
      contentType: type,
      title: titleOfHtml(text),
      hints: reachHints(text, res.status, finalUrl),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      ms: Date.now() - t0,
      bytes: 0,
      contentType: '',
      title: '',
      error: e instanceof Error ? e.message : String(e),
      hints: ['请求本身失败（DNS / 连接 / TLS / 超时）—— 这不是规则问题'],
    };
  }
});

/** 搜索试跑返回的单页 */
interface SearchProbePage {
  page: number;
  status: number;
  /** 最终地址（跟过重定向之后） */
  url: string;
  /** 实际请求的地址（`#557`：求值后的 URL，和 `url` 区分开才看得出跳转） */
  requestUrl: string;
  method: string;
  bytes: number;
  title: string;
  /** 列表规则命中数（没给 bookList 则为 null） */
  listCount: number | null;
  /** 第一个列表项解出的书名（判断翻页是否真的换了内容） */
  firstItem: string;
  /** 是否作为「试跑物料」返回正文（`#557`：只有第 1 页给） */
  material: boolean;
  /** 页面文本（第 2 页起为空 —— 只验翻页，不作物料） */
  html: string;
  /** `#565` 这份内容是怎么取得的：`静态` / `无头浏览器渲染` / `有头 Chromium 过盾`（撞盾时区分） */
  via?: string;
}

/**
 * **搜索试跑**（用户 2026-10-21：默认关键词「我的」/ 有 checkKeyWord 用它；有 `{{page}}` 要能验翻页）。
 *
 * `#557` 起 URL **不再靠探针自己拼**：走 `evalUrlTemplate`（引擎同一套求值器，见该函数头注），
 * 所以这四种源写法都能真跑：`,{charset/method/body}` 尾巴、`<js>…</js>` 段、
 * `{{page}}` 表达式、相对路径。求不出来才回 `NEED_REAL_RUN`（**不猜 URL**）。
 *
 *  · 第 1 页：取页 + 在页面上跑 `bookList` 数命中、取第一项书名 ⇒ **正文作为后续试跑物料**；
 *  · 第 2 页：只验「能不能正常返回」（状态/字节/列表命中/首项是否与第 1 页不同）⇒ **不回正文**
 *    （用户 2026-10-21：「page=2 的页面只检测是否正确返回，不返回页面作为物料」）。
 */
app.post<{
  Body: {
    sourceId?: string;
    searchUrl?: string;
    keyword?: string;
    pages?: number;
    cs?: string;
    bookList?: string;
    /** 未保存草稿的源 URL（`sourceId` 缺省时用它做相对路径基准与 `{{baseUrl}}`） */
    bookSourceUrl?: string;
    /**
     * `#565` 未保存草稿的**源原始 JSON**（与 `material` 端点同款）：草稿没有 `sourceId` ⇒
     * 服务端拿不到 `jsLib` ⇒ 规则里的 `HJ_B` 之类直接 ReferenceError（黄金屋实测）。
     * 已存源仍走 `sourceId`（raw 以库里为准，防篡改）。
     */
    source?: Record<string, unknown>;
  };
}>('/api/doctor/search-probe', async (req, reply) => {
  const b = req.body ?? {};
  const raw = (b.sourceId
    ? (hub.sources.get(b.sourceId)?.raw as Record<string, unknown> | undefined)
    : undefined) ?? (b.source as Record<string, unknown> | undefined);
  const searchUrl = (typeof b.searchUrl === 'string' && b.searchUrl.trim()) || String(raw?.['searchUrl'] ?? '');
  if (!searchUrl.trim()) return reply.code(400).send({ error: 'NO_SEARCH_URL', message: '这个源没有搜索地址' });
  const ruleSearch = (raw?.['ruleSearch'] ?? {}) as Record<string, unknown>;
  const keyword = (typeof b.keyword === 'string' && b.keyword.trim()) || defaultSearchKeyword(ruleSearch['checkKeyWord']);
  const bookList = (typeof b.bookList === 'string' && b.bookList.trim()) || String(ruleSearch['bookList'] ?? '');
  const maxPages = Math.min(Math.max(Math.trunc(b.pages ?? 2), 1), 3);

  /**
   * `#557` 求值器：**引擎同一套**（`makeProbeEnv().env.jsEval` + `applyUrlRuleJs`）。
   * 用户 2026-10-21 报的四种 URL 之前都跑不了，根因是探针只做「静态三写法替换」：
   *  · `,{"charset":"gbk","method":"post","body":"…"}` —— 现在切尾巴 + body 也插值；
   *  · `<js>result = getServerHost() + "…"</js>` —— 现在真跑 JS 段（jsLib 的 `getServerHost` 可见）；
   *  · `{{page}}` —— 现在按 JS 表达式求值（`{{page == 1 ? "" : page + ".html"}}` 也算得出来）；
   *  · `page/{{page}}?s={{key}}` —— 现在按源 URL 绝对化。
   */
  const envBundle = makeProbeEnv({
    ...(String(raw?.['bookSourceUrl'] ?? b.bookSourceUrl ?? '').trim()
      ? { baseUrl: String(raw?.['bookSourceUrl'] ?? b.bookSourceUrl) }
      : {}),
    ...(typeof raw?.['jsLib'] === 'string' && raw['jsLib'] ? { lib: raw['jsLib'] as string } : {}),
    ...(raw ? { source: raw } : {}),
    vars: {},
  });
  const env = envBundle.env;
  const srcUrl = String(raw?.['bookSourceUrl'] ?? b.bookSourceUrl ?? '').trim();
  const bindOf = (p: number) => ({ $: '', result: '', key: keyword, page: p, baseUrl: srcUrl, ...(raw ? { source: raw } : {}) });
  const evalExpr = async (expr: string, b: { page: number; key: string }): Promise<unknown> =>
    env.jsEval(expr, { ...bindOf(b.page), key: b.key });
  const evalJsSegment = async (code: string, current: string): Promise<string | null> => {
    const v = await env.jsEval(code, { ...bindOf(1), result: current });
    return v == null ? null : String(v);
  };

  const hasPageTpl = /\{\{[^}]*\bpage\b[^}]*\}\}/i.test(searchUrl) || /<[^<>]*,[^<>]*>/.test(searchUrl);
  const optCharsetOf = (o: Record<string, unknown>): string | undefined =>
    typeof o['charset'] === 'string' ? (o['charset'] as string) : undefined;

  const pages: SearchProbePage[] = [];
  const problems: string[] = [];
  const resolved: { page: number; url: string; method: string; body?: string; charset?: string }[] = [];
  /**
   * `#565` 列表规则是否「自取数」—— 决定撞盾时**失败口径**：
   * 自取数源（黄金屋：规则里自己种 `__sc_clearance` 重抓）即使静态页是挑战页也能跑出列表，
   * 浏览器没过盾也不该判「源坏」；非自取数源（138阅读网）则必须过盾才有物料。
   */
  const selfFetchingBookList = isSelfFetchingRule(bookList);
  for (let p = 1; p <= Math.min(maxPages, hasPageTpl ? 2 : 1); p++) {
    const ev = await evalUrlTemplate(searchUrl, { keyword, page: p, baseUrl: srcUrl, evalExpr, evalJsSegment });
    if (ev.unresolved) {
      return {
        ok: false,
        code: 'NEED_REAL_RUN',
        message: `URL 构造失败：${ev.errors.join('；') || '含求值不了的占位符'}`,
        keyword,
        pageTemplate: hasPageTpl,
        pages: [],
        resolved,
      };
    }
    for (const e of ev.errors) problems.push(`第 ${p} 页：${e}`);
    const method = ev.method;
    const optCharset = optCharsetOf(ev.options);
    const optHeaders = (ev.options['headers'] ?? {}) as Record<string, string>;
    const reqBody = ev.body;
    resolved.push({ page: p, url: ev.url, method, ...(reqBody !== undefined ? { body: reqBody } : {}), ...(optCharset ? { charset: optCharset } : {}) });
    const srcHeaders = await sourceProxyHeaders(b.sourceId);
    try {
      const res = await proxyHttp.request(ev.url, {
        method: method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
        ...(reqBody !== undefined ? { body: reqBody } : {}),
        headers: {
          'User-Agent': PROXY_UA_MOBILE,
          Accept: 'text/html,application/xhtml+xml,*/*',
          ...(reqBody !== undefined && !Object.keys(optHeaders).some((k) => k.toLowerCase() === 'content-type')
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : {}),
          ...srcHeaders,
          ...optHeaders,
        },
        ...(sourceAllowsInsecureTls(b.sourceId) ? { allowInsecureTls: true } : {}),
        timeout: 20_000,
        responseType: 'arraybuffer',
        priority: 'low',
      });
      const buf = Buffer.from(res.body as ArrayBuffer);
      const type = String(res.headers?.['content-type'] ?? '');
      let text = decodeBytes(buf, detectResponseCharset(buf, type, b.cs ?? optCharset ?? ''));
      /**
       * `#565` **撞盾 ⇒ 浏览器过盾链**（与发现试跑同一套 `passChallengeViaBrowser`）。
       * 用户实测 138阅读网：搜索试跑静态取页撞 CF 盾 ⇒ 挑战页当物料 ⇒ 列表 0 命中，
       * 而「发现」tab 已能自动过盾 —— 补上这条链，两侧口径一致。
       * 自取数源（黄金屋）即使没过盾也保留静态页：列表规则自己种 cookie 重抓，照样跑得出。
       */
      let pageVia = '静态';
      let pageStatus = res.status;
      let pageBytes = buf.length;
      const chal0 = isChallengePage(text);
      if (chal0.challenge) {
        const pass = await passChallengeViaBrowser(ev.url, chal0.via ?? '站点安全校验', b.sourceId);
        if (pass.html) {
          text = pass.html;
          pageVia = pass.passVia;
          pageStatus = 200;
          pageBytes = Buffer.byteLength(text, 'utf8');
        } else {
          pageVia = `静态（挑战页：${chal0.via ?? '站点安全校验'}）`;
          if (selfFetchingBookList) {
            pageVia += '；浏览器未过盾，但列表规则自取数可自行过盾';
          } else {
            problems.push(
              `第 ${p} 页取到的是**挑战/校验页**（${chal0.via ?? '站点安全校验'}，HTTP ${res.status}）：` +
                '静态请求过不了盾，无头与有头浏览器层也都没过（这台机器没有完整 Chromium，或该盾需要真人交互）。' +
                '已尝试开内嵌验证窗 —— 在浮层里过一次验证（cookie 会存下来），再回来试跑；或勾选「动态取页」重试。',
            );
          }
        }
      }
      let listCount: number | null = null;
      let firstItem = '';
      if (bookList.trim()) {
        const pr = await probeField({
          rule: bookList,
          content: text,
          baseUrl: ev.url,
          mode: 'elements',
          ...(typeof raw?.['jsLib'] === 'string' ? { lib: raw['jsLib'] as string } : {}),
          ...(raw ? { source: raw } : {}),
        });
        listCount = pr.hitCount;
        if (pr.hitCount && pr.hitCount > 0) {
          // 第一项解出的书名：用它判「第 2 页是不是真的换了内容」
          const nameRule = String(ruleSearch['name'] ?? '');
          if (nameRule.trim()) {
            const nr = await probeField({
              rule: nameRule,
              content: text,
              baseUrl: ev.url,
              scopeRule: bookList,
              scopeLimit: 1,
              ...(typeof raw?.['jsLib'] === 'string' ? { lib: raw['jsLib'] as string } : {}),
              ...(raw ? { source: raw } : {}),
            });
            firstItem = nr.values[0] ?? '';
          }
          /**
           * 没有书名规则（未绑源 / 源没写 `name`）时，用**第一个列表项的元素片段**当身份：
           * 翻页判据只需要「两页首项不是一个东西」，不需要它是书名。
           * 前面加 `[片段]` 是为了让人一眼看出这不是书名（诚实标注来源）。
           */
          if (!firstItem) {
            const s0 = pr.samples[0] ?? '';
            if (s0) firstItem = `[片段] ${s0.replace(/\s+/g, ' ').slice(0, 60)}`;
          }
        }
      }
      /**
       * `#557` **只有第 1 页回正文**：它是「后续试跑物料」。
       * 第 2 页只用来验翻页（状态/字节/列表命中/首项），回 HTML 只会白撑前端内存 ——
       * 用户 2026-10-21 明说「page=2 的页面只检测是否正确返回，不返回页面作为物料」。
       */
      const CAP = 1_500_000;
      const material = p === 1;
      const html = material ? (text.length > CAP ? text.slice(0, CAP) : text) : '';
      pages.push({
        page: p,
        status: pageStatus,
        url: res.url || ev.url,
        requestUrl: ev.url,
        method,
        bytes: pageBytes,
        title: titleOfHtml(text),
        listCount,
        firstItem,
        material,
        html,
        via: pageVia,
      });
      if (pageStatus >= 400) problems.push(`第 ${p} 页 HTTP ${pageStatus}`);
      if (listCount === 0) problems.push(`第 ${p} 页列表规则 0 命中（搜索页取回来了但规则没匹配上）`);
    } catch (e) {
      problems.push(`第 ${p} 页请求失败：${e instanceof Error ? e.message : String(e)}`);
      pages.push({ page: p, status: 0, url: ev.url, requestUrl: ev.url, method, bytes: 0, title: '', listCount: null, firstItem: '', material: p === 1, html: '' });
    }
  }

  let paging: 'n/a' | 'advanced' | 'same' | 'unknown' = 'n/a';
  if (hasPageTpl && pages.length >= 2) {
    const a = pages[0];
    const c = pages[1];
    if (!a || !c || !a.status || !c.status) {
      // 有一页没取到 ⇒ 翻页**无法判定**（别说「一样」，也别默认「有效」）
      paging = 'unknown';
      problems.push('第 2 页没取到，翻页是否生效无法判定');
    } else {
      paging = a.firstItem && c.firstItem ? (a.firstItem === c.firstItem ? 'same' : 'advanced') : 'unknown';
      if (paging === 'same') problems.push('第 2 页首项与第 1 页相同：`{{page}}` 可能没生效（或站点忽略页码）');
      if (paging === 'unknown') problems.push('两页都取到了，但没法比较翻页：列表规则没命中内容');
    }
  }
  return {
    ok: pages.some((p) => p.status > 0 && p.status < 400) && problems.length === 0,
    keyword,
    method: resolved[0]?.method ?? 'GET',
    pageTemplate: hasPageTpl,
    paging,
    pages,
    problems,
    /** `#557` 每页实际请求的地址/方法/请求体 —— 「构造出来的是什么」要看得到，否则没法判断规则对错 */
    resolved,
  };
});

/**
 * **`#558` 试跑物料**：详情 / 目录 / 正文三 tab 的「不给地址就自动往上找」。
 *
 * 链条（用户口径，判据在 core `resolveMaterial`）：
 *   详情 ← 发现首个**有地址**的分类首页 → 首个 bookUrl；没有发现规则 ← 搜索（默认 key，第 1 页）
 *   目录 ← 详情页 tocUrl（没写就共用详情页地址） · 正文 ← 目录首章地址
 *
 * 服务端只做 IO：取页走 `fetchProbePage`（带源 header / Cookie / 字符集），其它全在 core。
 * 返回 `chain` 让人看清「这一页到底是怎么来的」—— 自动取错了，猜是猜不出来的。
 */
app.post<{
  Body: {
    sourceId?: string;
    source?: Record<string, unknown>;
    target?: 'detail' | 'toc' | 'content';
    url?: string;
    keyword?: string;
    bookSourceUrl?: string;
    cs?: string;
  };
}>('/api/doctor/material', async (req, reply) => {
  const b = req.body ?? {};
  const raw = b.sourceId ? (hub.sources.get(b.sourceId)?.raw as Record<string, unknown> | undefined) : b.source;
  if (!raw) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND', detail: '没有这个源，也没给 source' });
  const target = b.target ?? 'detail';
  if (!['detail', 'toc', 'content'].includes(target)) {
    return reply.code(400).send({ error: 'BAD_TARGET', detail: 'target 只支持 detail / toc / content' });
  }
  const srcUrl = String(raw['bookSourceUrl'] ?? b.bookSourceUrl ?? '').trim();
  const r = await resolveMaterial({
    target,
    ...(typeof b.url === 'string' && b.url.trim() ? { url: b.url.trim() } : {}),
    ...(typeof b.keyword === 'string' && b.keyword.trim() ? { keyword: b.keyword } : {}),
    ...(typeof raw['jsLib'] === 'string' && raw['jsLib'] ? { lib: raw['jsLib'] as string } : {}),
    ...(srcUrl ? { baseUrl: srcUrl } : {}),
    source: raw,
    // 取页带源上下文（header / cookie / 字符集），与「取页」按钮同一条通路
    fetch: async (url: string) => {
      const got = await fetchProbePage(url, b.sourceId, b.cs);
      /**
       * `#562` **取到挑战页 ⇒ 自动拉一次浏览器渲染**：详情/目录/正文的物料同样可能撞盾
       * （138阅读网这类），过去只能拿到「0 命中」这种误导结论。渲染过盾成功就用渲染后的正文；
       * 失败如实回挑战页（物料链会按挑战页措辞报错，不甩锅给规则）。
       */
      const chalVia = isChallengePage(got.content ?? '').via;
      if (got.content && chalVia) {
        // `#564` 先无头、仍挑战页则上**有头**常驻会话（138阅读网这类 CF 盾只有有头过得去）；
        // 复查只认**最初那条特征**（过盾后的正文里可能残留盾方脚本引用）
        const html = await webRenderer(url, { ...(b.sourceId ? { sourceId: b.sourceId } : {}) }).catch(() => '');
        const ok = (h: string): boolean => !!h && !isChallengePage(h, chalVia).challenge && h.length >= 500;
        if (ok(html)) return { content: html, status: 200, baseUrl: got.baseUrl ?? url };
        if (b.sourceId) {
          const pass = await antibotPassPage(url, b.sourceId, { openVerification: true }).catch(() => ({ html: '', via: '' }));
          if (ok(pass.html)) return { content: pass.html, status: 200, baseUrl: got.baseUrl ?? url };
        }
      }
      return { content: got.content, status: got.status, error: got.error, baseUrl: got.baseUrl };
    },
  });
  return {
    ok: r.ok,
    target: r.target,
    url: r.url,
    /** 物料正文（未格式化；前端拿到后自己决定要不要美化 —— 美化会动空白，得是用户的动作） */
    content: r.content,
    bytes: Buffer.byteLength(r.content, 'utf8'),
    kind: r.kind,
    chain: r.chain,
    errors: r.errors,
    ...(r.keyword ? { keyword: r.keyword } : {}),
    ms: r.ms,
  };
});

/**
 * **`#558` 物料格式化**：自动识别 json / html / 文本。
 *
 * 放服务端而不是前端各写一份：判据只有 core 一份（`formatMaterial`）——
 * 「JSON 只重排缩进」「HTML 跳过 script/pre」这两条一旦前端自己实现就会漂移，
 * 而漂移的后果是**改坏物料**（往 `<script>` 里插换行会打断 JS 字符串）。
 */
app.post<{
  /**
   * `#681` `kind` 加了 `css` / `js`：自动判定只认 html/json（见 core `detectMaterialKind` 注释），
   * CSS/JS 必须由调用方显式指定（物料查看器有「自动/HTML/CSS/JS/JSON」选择）。
   */
  Body: { text?: string; kind?: 'html' | 'json' | 'css' | 'js' | 'text' };
}>('/api/doctor/format', async (req) => {
  const b = req.body ?? {};
  const r = formatMaterial(String(b.text ?? ''), b.kind);
  return { ok: true, text: r.text, kind: r.kind, changed: r.changed, ...(r.note ? { note: r.note } : {}) };
});

/**
 * **`loginUi` 规则校验**（`#557`；`#555` 的「静态解析 + 排版预览」已被它取代）。
 *
 * 用户 2026-10-21 的第二轮要求：预览**只给代码 + 校验**，要能回答
 *  「能不能按规则预期显示 / 有没有括号逗号问题 / 按钮 action 的函数在不在」；
 *  渲染一遍反而看不出该改哪里。判据全在 core `checkLoginUi`（JSON v1 数组是主流形态，
 *  语料 37 个 loginUi 里 28 个是 JSON 数组 —— 旧实现只解析 HTML，等于对这 28 个什么都没说）。
 *
 *  `loginUrl` / `loginCheckJs` 不单独给按钮（用户明说移除）：它们的源码在这里只当
 *  「action 函数定义的来源」用，取回来做静态检查。
 */
app.post<{
  Body: { sourceId?: string; loginUi?: string; loginUrl?: string; loginCheckJs?: string; jsLib?: string };
}>('/api/doctor/login-ui', async (req) => {
  const b = req.body ?? {};
  const raw = b.sourceId ? (hub.sources.get(b.sourceId)?.raw as Record<string, unknown> | undefined) : undefined;
  const pick = (key: string, given?: string): string =>
    typeof given === 'string' && given.trim() ? given : String(raw?.[key] ?? '');
  const uiRaw = pick('loginUi', b.loginUi);
  const loginJs = pick('loginUrl', b.loginUrl);
  const checkJs = pick('loginCheckJs', b.loginCheckJs);
  const jsLib = pick('jsLib', b.jsLib);
  const srcUrl = String(raw?.['bookSourceUrl'] ?? '').trim();

  let check = checkLoginUi({ raw: uiRaw, loginJs, checkJs, jsLib });

  /**
   * 脚本形态（`@js:`/`<js>`）：行由脚本产出，静态一行也看不到 ⇒ **代跑一次**再校验。
   * 用的是字段试跑同一个源桩（`makeProbeEnv`），binding 与引擎 `loginUi(state)` 同面。
   */
  if (check.needEval && check.kind === 'script') {
    const code = extractInlineJs(uiRaw);
    if (!code) {
      check.problems.push({ code: 'LOGINUI_SCRIPT', message: '脚本形态但取不出脚本内容（`@js:`/`<js>` 包裹不完整）', fixable: false });
    } else {
      try {
        const { env } = makeProbeEnv({
          ...(srcUrl ? { baseUrl: srcUrl } : {}),
          ...(jsLib ? { lib: jsLib } : {}),
          ...(raw ? { source: raw } : {}),
          vars: {},
        });
        const v = await env.jsEval(code, { $: '', infoMap: {}, key: '', page: 1, ...(raw ? { source: raw } : {}) });
        const text = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
        if (!text.trim()) {
          check.problems.push({ code: 'LOGINUI_SCRIPT_EMPTY', message: '脚本跑完了但没返回内容（应返回 JSON 数组文本）', fixable: false });
        } else {
          const inner = checkLoginUi({ raw: text, loginJs, checkJs, jsLib });
          check = { ...inner, kind: 'script', raw: uiRaw, evaluated: text, needEval: true };
        }
      } catch (e) {
        check.problems.push({
          code: 'LOGINUI_SCRIPT_ERR',
          message: `脚本求值失败：${e instanceof Error ? e.message : String(e)}（真跑同样会失败，除非它依赖登录态）`,
          fixable: false,
        });
      }
    }
  }

  const hints = [...check.hints];
  if (!loginJs.trim()) hints.push('这个源没有 loginUrl 脚本：按钮的 action 无处可调（只能用绝对 URL 那种 action）');
  if (!checkJs.trim()) hints.push('没有登录校验 JS：登录是否成功只能看 Cookie 有没有变化（引擎不判成功与否）');
  return { ...check, hints };
});

/**
 * **`#556` 动态取页**：走**引擎同一份渲染器**（`ctx.webRenderer`，见 `renderer.ts` 头注的分层表）。
 *
 * 为什么必须有这个按钮（用户 2026-10-21）：「取页」拿的是**原始响应**（等价 L1 静态抓取），
 * 懒加载列表 / `document.write` / SPA 的 `#app` 空壳都取不到内容；这些页面的规则怎么改都是 0 命中。
 * 此时要的是「渲染后的 DOM」，而引擎本来就有这条路（URL 尾巴 `,{"webView":true}` 走 `webRenderer`）。
 *
 * ⚠️ 边界（如实写在返回里，不假装等价）：
 *  · 渲染是**秒级~十秒级**且会开浏览器（L2 无头 / L3 CDP / L4 桌面桥），与「试跑」的秒级交互不同；
 *  · 分层由 `createLayeredRenderer` 决定，`layers` 报的是**当前可用层**，不是这次实际命中哪层
 *    （L2/L3 内部不回报层号；不编一个「用了 L3」的假数字）；
 *  · 与真跑的唯一差异是**没有该源的 Cookie/登录态**（除非服务端已有该源的常驻会话，`sourceId` 会带进去）。
 */
app.post<{
  Body: {
    url?: string;
    sourceId?: string;
    /** 渲染后是否再跑一次选择器（直接回答「动态取页之后命中了吗」） */
    selector?: string;
    /** 页面内注入脚本（Legado `webJs`） */
    webJs?: string;
    /** L3/L4 的额外等待（L2 dump-dom 不支持，见 `core/net/render.ts`） */
    delayMs?: number;
  };
}>('/api/doctor/fetch-page', async (req, reply) => {
  const b = req.body ?? {};
  const url = String(b.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'BAD_URL（只支持 http/https）' });
  const t0 = Date.now();
  let html = '';
  /** `#565` 最终内容是经哪条路拿到的（空 = 无头渲染层；有头兜底成功时标注） */
  let passedVia = '';
  /** `#565` 两层都没过盾时的说明（进 hints） */
  let challengeNote = '';
  try {
    html = await webRenderer(url, {
      ...(b.sourceId ? { sourceId: b.sourceId } : {}),
      ...(b.webJs ? { js: b.webJs } : {}),
      ...(typeof b.delayMs === 'number' ? { delayMs: Math.min(Math.max(b.delayMs, 0), 15_000) } : {}),
    });
    /**
     * `#565` **无头仍是挑战页 / 太短 ⇒ 有头兜底**（与搜索试跑、发现试跑同一套链）。
     * 用户实测 138阅读网：无头 `chrome-headless-shell` 的 `--dump-dom` 会被 CF 认出来
     * （恒挑战页），而**有头常驻会话**（完整 Chrome + 真实指纹）能跑完 CF 的 JS 挑战
     * ⇒ 「动态取页」只有无头一层时，用户点完拿到的还是过盾页面 —— 补上兜底。
     * 口径与 `passChallengeViaBrowser` 一致：太短（<500 字）也算没渲出来；
     * 原页命中过盾特征时**只收窄复查那一条**（过盾正文残留盾方脚本不算失败）。
     */
    const chal = isChallengePage(html);
    const tooSmall = (h: string): boolean => !h || h.length < 500;
    if ((!html || chal.challenge || tooSmall(html)) && b.sourceId) {
      const pass = await antibotPassPage(url, b.sourceId, { openVerification: true }).catch(() => ({ html: '', via: '' }));
      const stillBad = (h: string): boolean =>
        !h || tooSmall(h) || (chal.via ? isChallengePage(h, chal.via).challenge : isChallengePage(h).challenge);
      if (pass.html && !stillBad(pass.html)) {
        html = pass.html;
        passedVia = pass.via ?? '有头 Chromium 过盾';
      } else if (chal.challenge) {
        // 两层都没过：把「已开过验证窗」说清，别让用户以为按钮没生效
        challengeNote = `无头层被挑战页拦截（${chal.via ?? '站点安全校验'}），有头层也没过（该盾可能需要真人交互）`;
      }
    }
  } catch (e) {
    return { ok: false, rendered: false, ms: Date.now() - t0, layers: webRenderer.layer(), error: e instanceof Error ? e.message : String(e), hints: [] };
  }
  const ms = Date.now() - t0;
  const hints: string[] = [];
  if (challengeNote) hints.push(challengeNote);
  if (!html) {
    hints.push('渲染层返回空：这台机器上没有可用的 Chromium（L2），也没有桌面桥（L4）/ 远端渲染服务（R）');
  } else {
    /**
     * 「取到的是不是空壳」的判据：可见文本极少 + 有 `#app`/`__NUXT__`/`__NEXT_DATA__` 这类挂载点
     * ⇒ 页面靠 JS 拼出来，静态抓取只会拿到骨架。这条比「字节数」可靠（空壳页也可能几十 KB）。
     */
    const textLen = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
    if (textLen < 200 && /id=["'](?:app|root)["']|__NUXT__|__NEXT_DATA__|window\.__INITIAL_STATE__/.test(html)) {
      hints.push('渲染后仍几乎没有可见文本，但页面里有 SPA 挂载点：可能需要更长等待（delayMs）或先登录');
    }
    if (ms > 8000) hints.push(`渲染耗时 ${ms}ms：动态取页是「开浏览器」档，慢是正常的；别把它当逐字段试跑的常规手段`);
  }
  return {
    ok: !!html,
    rendered: true,
    url,
    ms,
    bytes: Buffer.byteLength(html, 'utf8'),
    title: titleOfHtml(html),
    /** 截断到 3MB（够覆盖渲染后的大页面，又不至于把前端撑爆） */
    html: html.length > 3_000_000 ? html.slice(0, 3_000_000) : html,
    truncated: html.length > 3_000_000,
    layers: webRenderer.layer(),
    ...(passedVia ? { passedVia } : {}),
    hints,
    ...(b.selector && b.selector.trim() && html
      ? { selectorProbe: await probeSelector({ selector: b.selector.trim(), content: html, ...(b.sourceId ? { source: (hub.sources.get(b.sourceId)?.raw ?? undefined) as Record<string, unknown> } : {}) }) }
      : {}),
  };
});

/**
 * **`#556` 发现试跑**：`exploreUrl` 不是选择器，它得「产出」一张分类表。
 *
 * 三件事一次给全：
 *  ① **真跑**（`probeExplore`，与字段试跑同一个源桩/求值器）⇒ 分类表 + 每个 title/url；
 *  ② **问题与纠正**：语法错（全角标点 / `::` 误用 / 缺逗号 / 括号未闭合）给 `fixed` 全文，
 *     前端「自动纠正」直接回填；语义问题（缺 title、url 为空）只说明不代改；
 *  ③ **首个可点分类的页面**：引擎拿 `clickable[0].url` 去取页（`engine.ts` 的 `tpl = clickable[0]?.url`），
 *     所以这里也取它 —— 取回来的 HTML 同时作为**发现 tab 的试跑物料**，
 *     紧接着点「书籍列表 / 书籍名」就是在**这张发现页**上匹配（而不是随便一个页面）。
 *
 * ⚠️ 静态构造不出插值（`{{$.id}}`）⇒ 如实报 `NEED_REAL_RUN`，不猜 URL。
 * ⚠️ 相对 url 按 `bookSourceUrl` 绝对化（与引擎 `fillRuleUrl` 同口径），并在 problems 里说明。
 */
app.post<{
  Body: {
    sourceId?: string;
    exploreUrl?: string;
    /** 交互输入态（分类筛选历史）：探针不读盘，前端可显式传 */
    infoMap?: Record<string, string>;
    /** 是否顺带取第一个分类的页面（默认 true） */
    fetch?: boolean;
    /** 发现页需要渲染时（懒加载/SPA）给 true，走 `webRenderer` */
    render?: boolean;
    cs?: string;
    /** 未保存草稿的源 URL（`sourceId` 缺省时用它绝对化分类地址） */
    bookSourceUrl?: string;
    /** `#565` 未保存草稿的源原始 JSON（同 search-probe：草稿没有 sourceId，jsLib 会丢） */
    source?: Record<string, unknown>;
  };
}>('/api/doctor/explore-probe', async (req, reply) => {
  const b = req.body ?? {};
  const raw = (b.sourceId
    ? (hub.sources.get(b.sourceId)?.raw as Record<string, unknown> | undefined)
    : undefined) ?? (b.source as Record<string, unknown> | undefined);
  const exploreRaw = (typeof b.exploreUrl === 'string' && b.exploreUrl.trim() ? b.exploreUrl : String(raw?.['exploreUrl'] ?? '')).trim();
  if (!exploreRaw) return reply.code(400).send({ error: 'NO_EXPLORE_URL', message: '这个源没有发现地址（不是错误，是没有发现页）' });
  const srcUrl = String(raw?.['bookSourceUrl'] ?? b.bookSourceUrl ?? '').trim();

  const pr = await probeExplore({
    raw: exploreRaw,
    ...(raw ? { source: raw } : {}),
    ...(typeof raw?.['jsLib'] === 'string' && raw['jsLib'] ? { lib: raw['jsLib'] as string } : {}),
    ...(srcUrl ? { baseUrl: srcUrl } : {}),
    ...(b.infoMap ? { infoMap: b.infoMap } : {}),
  });

  // 语法纠正：只在**真有可修项**时给全文（没坏就不给，避免「点一下改了一遍格式」）
  // ⚠️ 必须按形态选判据：文本形态的 `::` 是正确分隔符（见 core `autoCorrectExploreRule` 注释）
  const corrected = autoCorrectExploreRule(exploreRaw, pr.kind === 'text' ? 'text' : 'json');
  const fixable = pr.problems.some((x) => x.fixable) || corrected.fixes.length > 0;
  const fixed = fixable && corrected.fixes.length && corrected.text !== exploreRaw ? corrected.text : undefined;

  const problems = [...pr.problems];
  /**
   * `#557` 分类 url 的**求值结果**：`exploreUrl` 的分类地址里也带表达式
   * （`https://…/wanjie/{{page == 1 ? "" : page + ".html"}}`）——
   * 之前只做静态插值 ⇒ 首页地址原样带着 `{{…}}`，看着像「没运算」。
   * 这里对每个可点分类算 page=1 / page=2 两个地址，
   * 并**用 page=1 的那个地址取页**当物料（引擎就是这么取首个分类页的）。
   */
  const evalCtx = (() => {
    const bundle = makeProbeEnv({
      ...(srcUrl ? { baseUrl: srcUrl } : {}),
      ...(typeof raw?.['jsLib'] === 'string' && raw['jsLib'] ? { lib: raw['jsLib'] as string } : {}),
      ...(raw ? { source: raw } : {}),
      vars: {},
    });
    const env = bundle.env;
    const bind = (p: number) => ({ $: '', result: '', key: '', page: p, baseUrl: srcUrl, ...(raw ? { source: raw } : {}) });
    return {
      evalExpr: async (expr: string, bb: { page: number }): Promise<unknown> => env.jsEval(expr, bind(bb.page)),
      evalJsSegment: async (code: string, current: string): Promise<string | null> => {
        const v = await env.jsEval(code, { ...bind(1), result: current });
        return v == null ? null : String(v);
      },
    };
  })();
  const computed: { title: string; raw: string; page1: string; page2: string; errors: string[] }[] = [];
  // 逐条算**所有**可点分类：求值是本地 JS，不发请求，19 个分类也就几十毫秒；
  // 只算前几个会让后几行在界面上仍显示原文 `{{…}}`，又变成「没运算」。
  for (const k of pr.kinds.filter((x) => x.url).slice(0, 60)) {
    const u = String(k.url ?? '');
    const p1 = await evalUrlTemplate(u, { keyword: '', page: 1, baseUrl: srcUrl, ...evalCtx });
    const p2 = await evalUrlTemplate(u, { keyword: '', page: 2, baseUrl: srcUrl, ...evalCtx });
    computed.push({
      title: k.title,
      raw: u,
      page1: p1.url,
      page2: p2.url,
      errors: [...new Set([...p1.errors, ...p2.errors])],
    });
  }
  let page: { url: string; status: number; bytes: number; title: string; html: string; rendered: boolean; ms: number } | undefined;
  /** `#559` 列表规则是否「自取数」（`<js>` + `java.ajax`）—— 决定「页面 404」怎么解释 */
  const exploreListRule = String((raw?.['ruleExplore'] as Record<string, unknown> | undefined)?.['bookList'] ?? '')
    || String((raw?.['ruleSearch'] as Record<string, unknown> | undefined)?.['bookList'] ?? '');
  const selfFetching = isSelfFetchingRule(exploreListRule);
  let pageNote: string | undefined;
  let selfFetch: { rule: string; ok: boolean; count: number; samples: string[]; error?: string } | undefined;
  /** 4xx 的响应体（**只给自取数规则当占位**：那条 JS 不看页面内容，但探针不接受空内容） */
  let pageErrorBody = '';
  const firstComputed = computed.find((c) => c.page1 && c.errors.length === 0) ?? computed[0];
  if (b.fetch !== false && firstComputed?.page1) {
    if (firstComputed.errors.length) {
      problems.push({ code: 'NEED_REAL_RUN', message: `首个分类「${firstComputed.title}」的地址算不出来：${firstComputed.errors.join('；')}`, fixable: false });
    } else {
      const t0 = Date.now();
      if (b.render) {
        const html = await webRenderer(firstComputed.page1, { ...(b.sourceId ? { sourceId: b.sourceId } : {}) }).catch(() => '');
        if (html) {
          page = { url: firstComputed.page1, status: 200, bytes: Buffer.byteLength(html, 'utf8'), title: titleOfHtml(html), html: html.slice(0, 3_000_000), rendered: true, ms: Date.now() - t0 };
        } else {
          problems.push({ code: 'RENDER_EMPTY', message: `「${firstComputed.title}」动态取页返回空（没有可用渲染层）`, fixable: false });
        }
      } else {
        const got = await fetchProbePage(firstComputed.page1, b.sourceId, b.cs);
        if (got.error) {
          problems.push({ code: 'FETCH_FAILED', message: `「${firstComputed.title}」取页失败：${got.error}（可试「动态取页」）`, fixable: false });
        } else if (got.content && isChallengePage(got.content).challenge && !selfFetching) {
          /**
           * `#562` **挑战页 ≠ 规则错**，且**与状态码无关**（138阅读网回 403、不少站点回 200）。
           * 用户问「遇到校验页，也拉起 chromium？」—— 对：这里自动走一次浏览器渲染层
           * （无头 ⇒ 有头，`#565` 起提为共用的 `passChallengeViaBrowser`），
           * 拿回来不再是挑战页就用它当物料。
           * 列表规则自取数的源（黄金屋：规则里自己种 cookie 重抓）不走这条 —— 交给下面那条自取数分支。
           */
          const via = isChallengePage(got.content).via ?? '站点安全校验';
          const t1 = Date.now();
          const pass = await passChallengeViaBrowser(firstComputed.page1, via, b.sourceId);
          if (pass.html) {
            const html = pass.html;
            page = {
              url: firstComputed.page1,
              status: 200,
              bytes: Buffer.byteLength(html, 'utf8'),
              title: titleOfHtml(html),
              html: html.slice(0, 3_000_000),
              rendered: true,
              ms: Date.now() - t1,
            };
            pageNote =
              `静态取页（HTTP ${got.status ?? '?'}）被挑战页拦截（${via}），已**自动${pass.passVia ? '用' + pass.passVia : '用浏览器渲染'}**拿到正文（${page.ms}ms）` +
              ' —— 这份页面是过盾后的正文。';
          } else {
            problems.push({
              code: 'CHALLENGE_PAGE',
              message:
                `「${firstComputed.title}」取到的是**挑战/校验页**（${via}，HTTP ${got.status ?? '?'}）：` +
                '静态请求过不了盾，无头与有头浏览器层也都没过（这台机器没有完整 Chromium，或该盾需要真人交互）。' +
                '已尝试开内嵌验证窗 —— 在浮层里过一次验证（cookie 会存下来），再回来试跑；或勾选「动态取页」重试。',
              fixable: false,
            });
          }
        } else if (got.content && (got.status ?? 0) >= 400) {
          /**
           * `#559` **HTTP 4xx/5xx 的响应体不能当物料**（七猫的发现页正文就是 `404 page not found`，
           * 拿它当页面 ⇒ 书籍列表在错误文本上试跑，全 0 命中还以为是规则错）。
           *
           * ★ 但「页面 404」有两种完全不同的含义，必须分开（`#559` 修过一次误判）：
           *   · 列表规则是**自取数**（`<js>` + `java.ajax`）⇒ 页面 404 **正常**：七猫的分类 url
           *     只是路由提示，数据由 bookList 自己拼 `/api/v1/h5/hall-of-fame/list?gender=1` 取回来。
           *     这时**不能**说源坏了，改为直接跑那条列表规则，把拿到的项摆出来。
           *   · 否则 ⇒ 地址确实打不开，如实报。
           */
          if (selfFetching) {
            pageErrorBody = got.content;
            pageNote =
              `基础页 HTTP ${got.status}，但本源的列表规则是**自取数 JS**（\`java.ajax\` 直连接口）：` +
              '页面本来就不需要能打开，下面是直接执行列表规则的结果。';
          } else {
            const chal = isChallengePage(got.content);
            problems.push({
              code: 'FETCH_HTTP_ERROR',
              message:
                `「${firstComputed.title}」取页 HTTP ${got.status}（地址 ${firstComputed.page1}）：` +
                (chal.challenge
                  ? `拿到的是**挑战/校验页**（${chal.via}）—— 站点要求过盾，静态请求给不出正文。`
                  : '这份地址打不开（路由/参数层面，不是签名或渲染）。') +
                '先换一个分类看是否只有它坏；若换几个都这样，再怀疑源里这组分类地址失效。' +
                '也可以手动取/粘一页当物料。',
              fixable: false,
            });
          }
        } else if (got.content && isChallengePage(got.content).challenge) {
          // 上一分支已处理「挑战页 + 非自取数」（自动拉浏览器）；这里只剩**自取数**这一路：
          // 规则里自带过盾逻辑（黄金屋种 `__sc_clearance` 后重抓）⇒ 直接执行列表规则。
          const via = isChallengePage(got.content).via ?? '站点安全校验';
          pageErrorBody = got.content;
          pageNote =
            `基础页是**挑战/校验页**（${via}，HTTP ${got.status ?? '?'}），但本源的列表规则是**自取数 JS**：` +
            '规则里自带过盾逻辑（种 cookie 后重抓），下面是直接执行列表规则的结果。';
        } else if (got.content) {
          page = {
            url: got.baseUrl ?? firstComputed.page1,
            status: got.status ?? 0,
            bytes: Buffer.byteLength(got.content, 'utf8'),
            title: titleOfHtml(got.content),
            html: got.content.slice(0, 3_000_000),
            rendered: false,
            ms: Date.now() - t0,
          };
        }
      }
    }
  }

  /**
   * `#559` **自取数列表：直接跑那条规则**。
   *
   * 页面拿不到（404）而列表规则自己会发请求时，「取页当物料」这条路对它是无意义的 ——
   * 但试跑仍然有用：把 `bookList` 当规则真跑一次，就能看到「命中几项、每项长什么样」，
   * 用户接着对项内字段试跑（name/author/kind）也能对上。七猫实测：10 项、字段全对得上。
   */
  if (selfFetching && exploreListRule.trim() && !page) {
    try {
      const r = await probeField({
        rule: exploreListRule,
        /** 自取数规则不看页面内容，但探针不接受空内容 ⇒ 用 4xx 正文或占位符 */
        content: pageErrorBody || '<!-- self-fetch: 本规则自行请求接口，页面内容不参与求值 -->',
        ...(firstComputed?.page1 ? { baseUrl: firstComputed.page1 } : {}),
        ...(b.sourceId ? { sourceId: b.sourceId } : {}),
        ...(typeof raw?.['jsLib'] === 'string' && raw['jsLib'] ? { lib: raw['jsLib'] as string } : {}),
        mode: 'elements',
        sampleLimit: 3,
      });
      selfFetch = {
        rule: exploreListRule.slice(0, 120),
        ok: r.ok,
        count: r.hitCount ?? 0,
        samples: (r.samples ?? []).slice(0, 3),
        ...(r.error ? { error: r.error } : {}),
      };
    } catch (e) {
      selfFetch = {
        rule: exploreListRule.slice(0, 120),
        ok: false,
        count: 0,
        samples: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return {
    ok: pr.ok,
    kind: pr.kind,
    kinds: pr.kinds,
    clickable: pr.clickable,
    problems,
    ...(selfFetching ? { selfFetching: true } : {}),
    ...(selfFetch ? { selfFetch } : {}),
    ...(pageNote ? { pageNote } : {}),
    ...(fixed ? { fixed } : {}),
    ...(fixable && corrected.fixes.length ? { fixes: corrected.fixes } : {}),
    ...(pr.error ? { error: pr.error } : {}),
    ms: pr.ms,
    raw: pr.raw,
    ...(page ? { page } : {}),
    /** `#557` 每个可点分类算出来的 page=1 / page=2 地址（看得到「运算后的首页/次页」） */
    computed,
    layers: webRenderer.layer(),
  };
});

// 媒体/图片代理：带 Referer/UA 拉取防盗链资源（漫画图、音频直链、封面）并流式回传
// 用法：/api/proxy?u=<encodeURIComponent(url)>&r=<referer(可选)>&sid=<源 id>&cover=1
// `retry=1`：正文图失败后由前端点击重试时附加 —— 响应头预算 10s（cover=1 优先，仍 6s）
// sid 存在且源声明了 imageDecode / coverDecodeJs 时，服务端在回传前对字节做二次解密
// （对齐 Legado ImageUtils.decode；浏览器无法执行源 JS）
//
// ⚠️ **动图（gif/webp/avif）必须原字节透传**：本路由只做「解密（源要求时）+ content-type 纠正」，
//    不做任何转码/重编码；解密后的类型用**魔数**判定（`sniffImageType` 已覆盖 gif/webp/avif）
//    —— 这样封面是动图时浏览器拿到的是原始动图，动画照常播。
/**
 * `#691` **封面字节缓存** → `#816` B5 起并入 `cache-store`（`cover` 类）。
 *
 * 原因不变：花花短剧/荔枝那类短剧站把图放在 `media.lizdj009.com`，**单张要 8~9 秒**
 * （实测 curl 直连两轮都是 8.9s，不是我们的问题）。发现页一屏 30 张 ⇒ 在 6 个并发槽下
 * 要 40s+，用户切来切去永远在看占位图；而同一批封面在几分钟内会被反复请求（切源回来、
 * 详情页复用、浏览器重排）。
 *
 * 判据与边界（不要放大成「代理全缓存」）：
 *  · 只缓存**完整 200 响应**（图片）；区段/媒体/HTML/JSON 一律不缓存 ——
 *    那些带时效签名或体积巨大，缓存会引发更奇怪的故障；
 *  · 键含 `sid`：同一个图床 URL 在不同源下可能要不同的解密规则；
 *  · 存的是**解密后**的字节（命中零成本）；
 *  · 上限/TTL 不再写死在这里 —— 由 `cache-store` 的配额（设置页可调）统一裁决。
 */
/** 漫画/图集源（Legado `bookSourceType=2`）的页面图单独记到 `manga` 类 */
function isMangaSource(sid: string): boolean {
  const s = hub.sources.get(sid);
  if (!s || String(s.kind) !== 'legado') return false;
  const raw = (s.raw ?? {}) as Record<string, unknown>;
  return Number(raw['bookSourceType']) === 2;
}

/**
 * `#747` **图片解密的串行闸**（同一时刻只跑一张，且每张之前让出一拍事件循环）。
 *
 * 证据（`data/stall-report.log`，2026-11-03 19:58）：
 *   `cover-decode n=87 t=9371ms max=3268ms`、`l1-eval n=53 t=13649ms max=3454ms`，
 *   并伴随 `[stall] recover ms=21351`（事件循环被占死）。
 * 受控实验（本地 1612 章目录 + 本地图床，无公网噪声）：detail 基线 3338ms →
 *   并发 8 张「300ms 同步解密」图 5398ms → 24 张 7595ms → 40 张 7038ms。
 * 对照项：40 张**真实封面**并发时七猫 detail 只从 3477ms 涨到 3530ms（+53ms）⇒
 *   排队不是连接池/调度问题（`/api/proxy` 按 `#424` 收响应头即释放槽，且图片域名与
 *   API 域名不同 origin，undici 池不共享），而是**主线程同步 JS**。
 *
 * 为什么串行 + `setImmediate`：解密脚本在 L1 主线程同步求值，8 张并发就是 8 个
 * 同步块连续占满一拍；串行化把「同时 8 个块」变成「一个块 + 一次让出」。
 * 但**实测只串行还不够**（受控实验：8 张 300ms 解密图时 detail 仍从 1600ms 涨到 3883ms）——
 * 因为队列会在每个块之间立刻接上下一个，只留一个宏任务 tick，目录解析需要很多 tick
 * 才能推进。所以再加一层**前台优先级**：交互请求（`/api/run`、`/api/run/stream`、
 * `/api/aggregate/search`）在飞时解密整体**暂停**（最长 5s，避免图片被彻底饿死），
 * 交互跑完再继续 ⇒ 图片变慢、API 不受拖。
 * 代价是图片更慢（可接受：慢图走占位图），换 API 不再被拖住。失败不阻断后续（`catch` 保证链继续）。
 */
let imageDecodeChain: Promise<unknown> = Promise.resolve();
/**
 * `#756` C 前台在飞闸（`#747` 的 `foregroundBusy` 升级为可观测模块）。
 * 维护者：`/api/run`、`/api/run/stream`、`/api/aggregate/search` 三条**交互**路径。
 * ★ 新加交互路由时必须成对 `enter()/leave()` —— 漏一条就会复现「流式详情被图片解密拖到 8~9s」
 * （受控实验：40 张 300ms 同步解密图 + `/api/run/stream`，详情 0.9s → 6.8~8.4s）。
 */
const foregroundGate = createForegroundGate({ yieldMaxMs: 5_000 });
function queuedDecodeImage(
  sid: string,
  opts: { url: string; bytes: Uint8Array; isCover?: boolean },
): Promise<Uint8Array | null> {
  foregroundGate.noteDecodeQueued();
  const run = imageDecodeChain
    .then(() =>
      foregroundGate.waitIdle().then((waitedMs) => {
        foregroundGate.noteDecodeDeferred(waitedMs);
      }),
    )
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(() => {
      foregroundGate.noteDecodeRun();
      return hub.decodeImage(sid, opts);
    })
    .finally(() => foregroundGate.noteDecodeDone());
  imageDecodeChain = run.catch(() => {});
  return run;
}

app.get<{ Querystring: { u?: string; r?: string; sid?: string; cover?: string; retry?: string; cs?: string; ty?: string; dnsIp?: string; h?: string } }>('/api/proxy', async (req, reply) => {
  // `#326` **本路由唯一的 CORS 例外：回显 `Origin: null`**（`/api/*` 白名单判据不动，见 `cors.ts`）。
  //
  // 为什么需要：RSS 正文里的 `<script>`（源作者写的播放器/加载器，如饭团动漫的
  // `fetch(playUrl)` + hls.js）跑在 `ReaderOverlay` 的 `<iframe srcdoc sandbox>` 里 ——
  // 不透明 origin（opaque）的页面**连同源 3000 都是跨源**，发出的请求 `Origin: null`。
  // 前端（`#326`）把这些请求改写到 `/api/proxy`，但响应没有 ACAO 头 ⇒ 依旧读不到 ⇒
  // `Failed to fetch` 原样复发。`imgSrc()` 的 `<img>` 场景不受 CORS 管，所以以前没暴露。
  //
  // 为什么不违反 `#154`/`#155` 的收紧结论：那两条锁的是**有用户数据/凭据的 `/api` 端点**
  // （snapshot、login-info），且 `corsOriginFor` 回归锁钉死「不出现 `*`」——本路由是
  // **无凭据只读资源端点**（图/音视频/HTML 字节），`sid` 只用于取源头 Referer 与图片解密。
  // `null` 可由父页伪造（`#155` 注释）⇒ 伪造者读到的也只是 proxy 本来就会取的资源，
  // 不涉及任何用户数据端点；请求能力（SSRF 面）与 CORS 无关，加头前后完全一致。
  if (req.headers.origin === 'null') {
    reply.header('access-control-allow-origin', 'null');
    reply.header('vary', 'origin');
    /**
     * `#446` **必须是 `credentials: include` 的那一半**：源作者的页面脚本常用
     * `fetch(u, { credentials: 'include' })` 抓下一页/楼层（千白羽详情页的
     * 「生成 HTML」`downloadThread()` → `Re()` 就是它）。CORS 规范：凭据模式下 **ACAO 不能是
     * `*`**（这里回 `null` ✓）**且必须有 `ACAC: true`**；缺后者时浏览器**直接判 CORS 失败**
     * （字节读不到、`fetch` 抛 TypeError）⇒ 用户看到的「下载 HTML 点了没反应」。
     * 安全性同上面这段：本路由无用户数据，源站 Cookie 由服务端按 `sid` 注入，客户端带不带
     * 凭据都不改变「取到什么」。
     */
    reply.header('access-control-allow-credentials', 'true');
  }
  const raw = req.query.u ?? '';
  /**
   * `#780` ③：封面失败**采样**日志（只观测）。
   * 目的：补上「14/40 到底是 404、429、5xx 还是超时」这个缺失维度 ——
   * 401/403/404 本来就有 `[proxy] 上游 …换 Referer` 痕迹，而 5xx/429/超时此前完全静默。
   * 口径：`cover=1` 才记，每 host 每 60s 最多 5 条（见 `proxy-failure-log.ts`）。
   * 不改重试策略 / 熔断计数 / 超时值 / 响应码，只在 `console.warn` 多一行。
   */
  const proxyFailStartedAt = Date.now();
  const noteProxyFailure = (status?: number, err?: unknown): void => {
    if (!shouldNoteCoverFailure({ cover: req.query.cover, status, hasError: err !== undefined })) return;
    const line = coverFailureSampler.note({
      host: hostOf(raw),
      ...(typeof status === 'number' ? { status } : {}),
      timedOut: err !== undefined ? isTimeoutLikeError(err) : false,
      ms: Date.now() - proxyFailStartedAt,
      url: raw,
    });
    if (line) console.warn(line);
  };
  /**
   * `#462` **把代理请求也登记进「在飞动作」**：用户实测的 stall 报告里第一条 `[stall] stall ms=5235`
   * **没有 inflight**（因为此前只有 `/api/run` 登记）⇒ 现场缺了一半。这里用 `res.on('close')`
   * 收尾（不改流程结构）：响应结束或客户端断开都会触发，天然幂等。
   */
  {
    const endTrack = trackStart(`proxy:${String(raw).slice(0, 90)}`);
    reply.raw.on('close', endTrack);
  }
  /**
   * `#691` **客户端断开 ⇒ abort 上游**（`/api/proxy` 此前没有这一条）。
   *
   * 用户实测（花花短剧切源后）：服务端仍挂着一串
   * `[stall] … req GET /api/proxy?u=…@337s`。浏览器切页/切源时早就把那些 `<img>` 撤了，
   * 但服务端只会**等上游超时**（20s，媒体区段 60s）—— 期间并发槽与在飞登记一直被占，
   * 于是下一次切源要排在这些「尸体请求」后面排队，表现为「切源半天不出图」。
   *
   * `writableEnded` 判据：正常写完也会触发 `close`，那种情况不该 abort（响应已发完）。
   */
  const clientAbort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) clientAbort.abort();
  });
  /**
   * `#441` **内联 `data:image/…` 也要能解密**（91视频：封面与正文图片的 `src` 是
   * `data:image/jpeg;base64,<AES-ECB 密文>`，站点靠自己的 JS 解密后才渲染 ⇒ 我们直接渲染
   * 就是一张裂图）。这条通道没有「上游 URL」可抓 ⇒ 就地：base64 解出字节 → 跑源声明的
   * 图片解密规则（与 http 图片**同一条实现**：`hub.decodeImage`）→ 魔数纠型 → 回传字节。
   *
   * 源**没声明**解密规则 ⇒ 原样回传（等价于浏览器直接渲染该 data URL，零行为变化）。
   * ⚠️ 只认 `data:image/`；其它 `data:`（本地书文本/字体等）不走这里。
   * ⚠️ 前端只在**带 `sid`** 时才会把 `data:image` 送进来（见 `apps/web/src/utils/img.ts`
   * 与壳层 RES 桥）—— 没有源上下文的内联图（主题壁纸、本地书插图）保持原样，不吃这一跳。
   */
  if (/^data:image\//i.test(raw)) {
    const m = /^data:image\/([\w.+-]+);base64,([\s\S]*)$/i.exec(raw);
    if (!m) return reply.code(400).send({ error: 'BAD_DATA_URL' });
    let bytes = Buffer.from(m[2]!, 'base64');
    let inlineType = `image/${m[1]}`;
    const inlineSid = req.query.sid;
    if (inlineSid) {
      try {
        const decoded = await hub.decodeImage(inlineSid, {
          url: 'inline:data-url',
          bytes: new Uint8Array(bytes),
          isCover: req.query.cover === '1',
        });
        if (decoded?.length) bytes = Buffer.from(decoded);
      } catch {
        /* 解密失败 → 回原图（与 http 图片同语义：不打断渲染） */
      }
    }
    const sniffed = sniffImageType(bytes);
    if (sniffed) inlineType = sniffed;
    reply.header('content-type', inlineType);
    reply.header('cache-control', 'public, max-age=3600');
    return reply.send(bytes);
  }
  if (!/^https?:\/\//i.test(raw)) return reply.code(400).send({ error: 'BAD_URL' });
  const sid = req.query.sid;
  /**
   * **Range 透传**（2026-09-24 新增；音频/视频内嵌播放的前提）。
   *
   * 为什么必须有：本路由早期是「一次性 arraybuffer 拉全量 → `reply.send(buf)`」，即
   *   ① 响应里没有 `Accept-Ranges` ⇒ `<audio>`/`<video>` 拖不动进度（拖动=重新整包下载）；
   *   ② 整包还要过 arraybuffer 体积护栏（`YUEDU_NET_MAX_BODY_MB`×4 = 32MB），
   *      长音频/视频会被**静默截断** ⇒ 播到一半就停，且没有任何可观测痕迹。
   * 现在把客户端的 `Range` 原样交给上游，并把 206 的 `Content-Range` 原样回传。
   *
   * 只放行**格式合法的单区段**（`bytes=a-b` / `bytes=a-` / `bytes=-n`）——
   * 多区段（含逗号）与畸形值一律丢弃，退回整包语义（不猜、不自行改写成别的区段）。
   */
  const rangeRaw = typeof req.headers['range'] === 'string' ? req.headers['range'].trim() : '';
  const range = /^bytes=\d*-\d*$/.test(rangeRaw) && rangeRaw !== 'bytes=-' ? rangeRaw : '';
  /**
   * `#780` **响应头预算**（只到「收到响应头」，响应体预算仍是下面的 `imageDeadline`）：
   * `range` 60s / **图片类（cover=1、正文图、retry=1）10s** / 普通非图片 20s，
   * 判据唯一实现见 `proxy-timeout.ts`（图片类靠 `Accept: image/*` 识别，见该文件头注）。
   * 主请求与下面的桌面 UA 补发**共用这一档**（补发不得把预算抬回 20s）。
   */
  const acceptHeader = typeof req.headers.accept === 'string' ? req.headers.accept : '';
  const coverRequest = req.query.cover === '1';
  const imageRequest = isImageProxyRequest(req.query, acceptHeader);
  const headerTimeoutMs = proxyHeaderTimeoutMs({ ...req.query, image: imageRequest }, !!range);
  // 源自己的头（含源 header 规则里的 Referer / UA / 登录头 / Cookie）作为基底
  const srcHeaders = await sourceProxyHeaders(sid);
  const headers: Record<string, string> = {
    'User-Agent': PROXY_UA_MOBILE,
    Accept: '*/*',
    ...srcHeaders,
  };
  // 区段请求必须要求「不压缩」：一旦上游 gzip 了切片，字节偏移就不再对应文件偏移
  if (range) headers['Range'] = range;
  if (range) headers['Accept-Encoding'] = 'identity';
  /**
   * ⚠️ 旧版 Referer 解析顺序（2026-09-23：**不再默认用资源自身的 origin**）已被
   * 「两段阶梯」取代 —— 那时的单值顺序对 CDN 图床正确、对媒体直链会把 Referer 设错（403）。
   * 历史保留在 git；规则与理由见 `proxy-referer.ts`（含回归锁）。
   */
  // `#369`：RSS 源的站点在 `sourceUrl`（legado/MacCMS 才叫 `bookSourceUrl`）——只读后者
  // 会让**全部 RSS 源**的 `srcSite` 为空，referer 阶梯丢「源站点」这一环（AGE 动漫实测）。
  const srcRaw = hub.sources.get(sid ?? '')?.raw as Record<string, unknown> | undefined;
  const srcSite = originOf((srcRaw?.['bookSourceUrl'] ?? srcRaw?.['sourceUrl']) as string | undefined);
  const refKey = Object.keys(headers).find((k) => k.toLowerCase() === 'referer');
  const headerRef = refKey ? headers[refKey]! : '';
  if (refKey) delete headers[refKey]; // 统一由 refererChain 设置，避免出现两个 Referer
  const refChain = refererChain({
    explicit: req.query.r ?? '',
    headerRef,
    srcSite,
    assetOrigin: originOf(raw),
  });
  /**
   * `#691`/`#816` 图片缓存命中：直接回字节（见 `cache-store` 头注）。
   * 位置要求：必须在 `range` 判完之后 —— 有 Range 的是媒体，永远不吃图片缓存。
   * 分类：`cover=1` → 封面；漫画/图集源 → 漫画；其余 → 图片。
   */
  const imageCacheKey = sid && !range ? `${sid}|${raw}` : '';
  const imageCacheCategory: ServerCacheCategory | '' = imageCacheKey
    ? req.query.cover === '1'
      ? 'cover'
      : isMangaSource(sid!)
        ? 'manga'
        : 'image'
    : '';
  if (imageCacheCategory) {
    const hit = await cacheStore.get(imageCacheCategory, imageCacheKey);
    if (hit) {
      reply.header('content-type', hit.type);
      reply.header('x-yuedu-cache', 'hit');
      if (imageCacheCategory === 'cover') reply.header('x-yuedu-cover-cache', 'hit');
      return reply.send(hit.buf);
    }
  }
  let res!: Awaited<ReturnType<typeof proxyHttp.request>>;
  let lastRef = '';
  /**
   * `#424` **音视频走流式**（用户质询：「媒体，流式？边加载边播放？页面内自己就可以播放，
   * 为什么嗅探反而不能？」）。
   *
   * 根因：页面内 `<video>` 的地址**不经本代理**（或经 NET 桥但播放器自己按 Range 续取），
   * 而嗅探走的 `/api/proxy` 是**一次性 arraybuffer 全量** + 体积护栏
   * ⇒ 大 mp4 被截断（`[net-guard] 响应体超过上限 32MB，已截断`）⇒ 播不了。
   *
   * `#470` **升级：全部 GET 先按流式拿响应头，收到头之后按上游 `Content-Type` 分岔**——
   * 旧实现只能在**发请求前**靠 URL 扩展名猜（`isMediaUrl`），而枫叶音乐盒等源的直链
   * （`m801.music.126.net/…/c077/4c933979b7d7aa`）**没有扩展名** ⇒ 猜不中 ⇒ 落回
   * arraybuffer 整包（实测歌单第二首 12.4MB：整包拉完才开始播 = 用户看到的 stall；
   * 超过护栏还会被截断）。现在**上游说了算**：`audio/*|video/*` 一律管道，
   * 其余（图片/文本/HLS 清单）再在服务端转缓冲（见下方 `readStreamLimited`）。
   */
  // `#424`：扩展名判媒体（**不含 `.m3u8`** —— 播放列表要做 HLS 重写，必须缓冲）。
  // `#470` 后这只是**兜底**（上游漏给 Content-Type 的老 CDN），主判据是响应头 MIME。
  const isMediaUrl = /\.(mp4|m4v|mov|webm|mkv|flv|avi|f4v|ts|m4s|mp3|m4a|aac|flac|wav|ogg|opus|mpd)(\?|#|$)/i.test(raw);
  for (let attemptRef = 0; attemptRef < refChain.length; attemptRef++) {
    const h: Record<string, string> = { ...headers };
    /**
     * `#742` **`&h=` Host 头覆盖**（源侧「IP 进 URL + Host 头」形态的接力点，如哔咔封面
     * `http://<CF IP>/static/…,{"headers":{"Host":"storage-b.picacomic.com"}}`）：
     * Cloudflare 按 `Host` 选 vhost，缺了就 404/409 ⇒ 「能登录、图全裂」。
     * 只放行合法主机名（含 `[v6]:port`），含空白/CRLF 的一律丢弃。
     */
    const hostOverride = typeof req.query.h === 'string' ? req.query.h.trim() : '';
    if (hostOverride && /^[a-zA-Z0-9._\-\[\]:]{1,255}$/.test(hostOverride)) h['Host'] = hostOverride;
    const ref = refChain[attemptRef] ?? '';
    lastRef = ref;
    if (ref && /^https?:\/\//i.test(ref)) h['Referer'] = ref;
    try {
      res = await proxyHttp.request(raw, {
        headers: h,
        // `#691`：把「客户端断开」透到 fetch（core 侧 `opts.signal` 已并进内部 controller）
        signal: clientAbort.signal,
        // `#428`：源侧显式开了「忽略 TLS 校验」⇒ 本代理同源同样放行（否则封面/媒体全裂）
        ...(sourceAllowsInsecureTls(sid) ? { allowInsecureTls: true } : {}),
        // 媒体整包/区段都可能很慢（长音频首包、大图床），区段请求给更宽的超时
        timeout: headerTimeoutMs,
        // `#780` 融合方案：封面失败只是缺图，**不计入域名熔断**（正文图/重试照常计数）；
        // 熔断已开时封面仍**照常发出**（bypassBreaker，理由见 docs rounds 792）。
        ...(coverRequest ? { countBreaker: false, bypassBreaker: true } : {}),
        // `#470`：一律流式拿响应（头到了 core 就返回、并发槽即释放），MIME 分岔在下方
        responseType: 'stream',
        /**
         * `#437` **`&cs=` 显式字符集**（沙箱页 `java.ajax(u,',{"charset":"gbk"}')` 走这条）。
         *
         * 为什么必须由**服务端**解：同步 XHR 规范上**不允许设 `responseType`**（只能 text），
         * 所以壳内拿不到原始字节、无法自己按 GBK 解 —— 只有服务端能按指定字符集解对。
         * 不给 `cs` 时走 core 的自动检测（① Content-Type charset → ② `<meta charset>` → ③ UTF-8）。
         */
        ...(req.query.cs ? { charset: req.query.cs } : {}),
        /**
         * `#742` **`&dnsIp=` 按 IP 直连**（源选项 `dnsIp` 的代理侧接力点）：
         * 只改「域名→地址」，Host 头与 TLS SNI/证书校验仍按 `u` 的域名（= `curl --resolve`）。
         * 目前**前端不主动传**：源侧图片一般直接写 IP（`picac_pool` 的封面模式），
         * 传了才生效；不传 ⇒ 与从前完全一致（零行为变化）。
         */
        ...(typeof req.query.dnsIp === 'string' && req.query.dnsIp.trim() ? { dnsIp: req.query.dnsIp } : {}),
        /**
         * **后台资源一律低优先**（2026-09-26，见 `HttpRequestOptions.priority`）。
         *
         * 护栏的并发槽位是**模块级单例**，图片代理与引擎 `/api/run` 共用：
         * 发现页一屏几十张封面 / 漫画一话上百张图会把 6 个槽位占满，用户这时点卡片，
         * detail/toc 只能排在队尾（实测服务端 +820ms、叠加浏览器同源连接限制 +1784ms）。
         * 标成 low 后：**有空槽照样立刻放行**（吞吐不变），只在排队时让位给交互请求。
         * 这里所有 `/api/proxy` 都是「取资源字节」，没有一条是用户正盯着转圈的解析请求。
         */
        priority: 'low',
      });
    } catch (e) {
      // `#780` ③：连接/响应头超时此前只留 PROXY_FAIL、没有状态码 —— 这里只补采样，错误照原样抛
      noteProxyFailure(undefined, e);
      throw e;
    }
    if (res.status < 400 || attemptRef >= refChain.length - 1) break;
    if (!REFERER_RETRY_STATUS.has(res.status)) break;
    /**
     * `#378` **限流不进 Referer 阶梯**：403 既可能是防盗链、也可能是限流。限流时换
     * Referer 毫无用处（限额按 IP+路径记），只会白打一次并把枯竭的限额再扣一次
     * ⇒ 判据见 `proxy-status.isRateLimited`（唯一实现）。
     */
    if (isRateLimited(res.status, res.headers)) break;
    console.warn(
      // `#458`：**把 sid 与阶梯来源一并打出来** —— 用户实测遇到过「换 Referer 重试：A 源站 → B 站」，
      // 只看两个 Referer 分不清"这是第几档、srcSite 是谁推的"（那次的第一档其实来自该请求的 sid 对应源）。
      `[proxy] 上游 ${res.status}，换 Referer 重试：${ref || '(无)'} → ${refChain[attemptRef + 1] || '(无)'}` +
        `（sid=${sid || '(无)'} · srcSite=${srcSite || '(无)'} · 档 ${attemptRef + 1}/${refChain.length}）(${raw.slice(0, 90)})`,
    );
    // `#424`：这一发是流式的错误响应 ⇒ 先丢弃（取消底层流）再重试，别把连接挂住
    if (res.stream) {
      try {
        await res.stream.cancel();
      } catch {
        /* 已断开 ⇒ 忽略 */
      }
    }
  }
  /**
   * `#367` **桌面 UA 补一发**（蓝奏云整类 400 的解法）。
   *
   * 实测（2026-10-09，`moshanging.lanzout.com/b01jab65i`，全变量分离）：
   *   · 手机 UA 直连 lanzout → **302 → `www.lanzoum.com`** 同路径 → **400**（带不带 Referer 都 400）；
   *   · 桌面 UA（curl 同理）→ lanzout **200 直接出页**，根本不发生重定向。
   * 即蓝奏云 WAF 按 UA 分流：手机 UA 被赶到 lanzoum，而 lanzoum 对「手机 UA 的非浏览器请求」
   * 一律 400（真手机浏览器带 Sec-Fetch/sec-ch-ua 等头，服务端代理拼不齐 ⇒ 过不了）。
   * 本代理默认 UA 是安卓手机 ⇒ **整类蓝奏云链接（网盘类文件宿主的主流形态）全部
   * `UPSTREAM_400`**，用户表现为「页内测试版链接 获取：全部 HTTP 502」。
   *
   * 修法：referer 阶梯跑完仍是 **400**、且 UA 还是**本代理默认手机 UA**（源没自定义 UA）
   * 时，换桌面 UA 补一发——拿「桌面真浏览器」的语义。只补一次、只对 400，
   * 不动 4xx 换 Referer 的既有阶梯；源显式配了 UA 时尊重源配置不补。
   *
   * `#378` **扩展**：`400` 之外再加 **`403` / `429`** —— 这两类同样可由「UA 被 WAF 拒」
   * 造成（GitHub API 无 UA 即 403「Request forbidden by administrative rules」），
   * 补一发桌面 UA 能覆盖该整类。
   *
   * ⚠️ **但限流必须排除**：上游是**限流**（`x-ratelimit-remaining: 0`，或 429）时换 UA
   * 毫无用处（限额按 IP 记，与 UA 无关），只是白白多打一次、把本就枯竭的限额再扣一次
   * ⇒ 见到限流头就**直接透传**，不补发。
   */
  const rateLimited = isRateLimited(res.status, res.headers);
  if (
    !rateLimited &&
    UA_RETRY_STATUS.has(res.status) &&
    headers['User-Agent'] === PROXY_UA_MOBILE
  ) {
    // `#470`：响应体现在是流——补发前必须**丢弃旧流**（否则上游连接被挂住不释放）
    if (res.stream) {
      try {
        await res.stream.cancel();
      } catch {
        /* 已断开 ⇒ 忽略 */
      }
    }
    const h: Record<string, string> = { ...headers, 'User-Agent': PROXY_UA_DESKTOP };
    if (lastRef && /^https?:\/\//i.test(lastRef)) h['Referer'] = lastRef;
    try {
      res = await proxyHttp.request(raw, {
        headers: h,
        // `#428`：与主请求同一判据（桌面 UA 补发也要放行，否则「补发一次反而失败」）
        ...(sourceAllowsInsecureTls(sid) ? { allowInsecureTls: true } : {}),
        // `#742`：桌面 UA 补发同样要带上 `dnsIp`，否则「补发一次反而失败」
        ...(typeof req.query.dnsIp === 'string' && req.query.dnsIp.trim() ? { dnsIp: req.query.dnsIp } : {}),
        // `#780`：补发与主请求同一档响应头预算（图片类 10s）
        timeout: headerTimeoutMs,
        // `#780`：封面补发同样不计熔断、熔断中照常发出（与主请求语义一致）
        ...(coverRequest ? { countBreaker: false, bypassBreaker: true } : {}),
        responseType: 'stream',
        priority: 'low',
      });
    } catch (e) {
      noteProxyFailure(undefined, e);
      throw e;
    }
  }
  try {
    /**
     * **上游状态码映射**（`#378`）：4xx 透传真实状态码、5xx→502。
     *
     * 判据唯一实现在 `proxy-status.ts`（`proxyStatusAction`），此处只做接线 ——
     * 该文件的头注记录了完整缺陷类别与实测案例（momoa.cc.cd / GitHub API 限流）。
     * 一句话：**502 只留给真正的中介故障**；上游明确的拒绝（403/404/429）原样透传，
     * 让读状态码的调用方（页内脚本）能区分「限流」与「加载失败」。
     */
    const action = proxyStatusAction(res.status);
    if (action === 'gateway-502') {
      noteProxyFailure(res.status);
      // `#470`：流式响应的错误分支要**丢弃流**（否则上游连接挂住）
      if (res.stream) {
        try {
          await res.stream.cancel();
        } catch {
          /* 已断开 ⇒ 忽略 */
        }
      }
      return reply.code(502).send({ error: `UPSTREAM_${res.status}` });
    }
    if (action === 'passthrough-4xx') {
      noteProxyFailure(res.status);
      // 透传上游的诊断头（限流/重试语义），缺失则不回
      const ra = res.headers['retry-after'];
      if (ra) reply.header('retry-after', String(ra));
      const rl = res.headers['x-ratelimit-remaining'];
      if (rl) {
        reply.header('x-ratelimit-remaining', String(rl));
        const rlReset = res.headers['x-ratelimit-reset'];
        if (rlReset) {
          reply.header('x-ratelimit-reset', String(rlReset));
        }
      }
      // 上游 4xx 的正文一并回传（GitHub 会给 `{"message":"API rate limit exceeded..."}`，
      // 比我们的信封更有诊断价值；站点脚本若读 body 也能拿到）。
      // `#470`：响应体现在是流 ⇒ 错误正文从流里读（错误体都很小，护栏按文本 8MB 足够）
      const errBody: Buffer | Uint8Array = res.stream
        ? Buffer.from((await readStreamLimited(res.stream, netGuardConfig().maxBodyBytes, raw)).buf)
        : Buffer.from((res.body as ArrayBuffer) ?? new ArrayBuffer(0));
      return reply
        .code(res.status)
        .header('content-type', res.headers['content-type'] ?? 'application/json; charset=utf-8')
        .send(errBody);
    }
    let type = res.headers['content-type'] ?? 'application/octet-stream';
    /**
     * `#424`/`#470` **媒体：直接管道回客户端**（不缓冲、不过体积护栏 ⇒ 边下边播）。
     *
     * 判据（`#470` 改为**响应头说了算**）：上游 `Content-Type` 是 `audio/*|video/*`，
     * 或兜底的 URL 扩展名命中（老 CDN 不给准 MIME）。走到这里状态码已是 2xx/3xx。
     * 流式分支**不做**图片解密、魔数纠型、HLS 重写（那三件都要看整包/文本）——
     * 只透传状态 + 头 + 字节。`content-length`/`content-range`/`accept-ranges`
     * 原样给播放器（206 才能续取/拖动）。
     */
    const isMediaMime = /^(audio|video)\//i.test(type);
    /**
     * 客户端显式要了字节段 ⇒ 也按媒体流直通。浏览器媒体元素取音视频固定发
     * `Range: bytes=0-`，而不少音频直链（如 🔊书音M 的 `api.php?kw=…`，302 到
     * kuwo）只有 `application/octet-stream`、URL 也没有扩展名 ⇒ 原来落到下面的
     * 整包缓冲：3.2MB 要 3.6s、9.7MB 超过 10s，`<video>` 一直等不到首包
     * ⇒ 用户看到的是「一直解析媒体地址中」。Range 请求本来就该 206 直出，
     * 流式分支会原样透传 `content-range`/`accept-ranges`，不改变分片语义。
     */
    if (res.stream && (isMediaUrl || isMediaMime || Boolean(range))) {
      reply.code(res.status);
      reply.header('content-type', type);
      if (res.headers['content-length']) reply.header('content-length', res.headers['content-length']);
      if (res.headers['content-range']) reply.header('content-range', res.headers['content-range']);
      if (res.status === 206 || /bytes/i.test(res.headers['accept-ranges'] ?? '')) reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'public, max-age=3600');
      return reply.send(Readable.fromWeb(res.stream as Parameters<typeof Readable.fromWeb>[0]));
    }
    /**
     * `#470` **非媒体：服务端把流转回缓冲**（旧实现靠请求期 `responseType:'arraybuffer'`
     * 在 core 里缓冲；现在统一流式拿头，这里补读）。护栏与旧路径**完全一致**：
     * arraybuffer 档 = 8MB×4 = 32MB、令牌桶限速、`netStats` 计数（`readStreamLimited`）。
     * `truncated` 从读取结果拿（流式响应的 `res.truncated` 恒 undefined）——
     * 206 截断改写（`#420`）靠它。
     */
    let truncatedBody = false;
    let buf: Buffer | Uint8Array;
    if (res.stream) {
      /**
       * `#747` **图片响应的体读取预算 = 10s**（文本/HLS 仍不设限，保持旧行为）：
       * `timeout` 只管到响应头，慢镜像的体过去能挂 40~60s（用户日志里那条 60s 就是它），
       * 挂着的请求会持续占浏览器同源连接、把图片洪峰拉长成持续 CPU 压力
       * ⇒ 目录解析被挤到 9~18s。到点取消流 + 抛 `BODY_DEADLINE` ⇒ 前端占位图，不再拖整批。
       */
      const respType = String((res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? '') as string);
      const imageDeadline = !range && (req.query.cover === '1' || /^image\/|octet-stream/i.test(respType)) ? 10_000 : 0;
      const got = await readStreamLimited(res.stream, netGuardConfig().maxBodyBytes * 4, raw, imageDeadline);
      truncatedBody = got.truncated;
      buf = Buffer.from(got.buf);
    } else {
      buf = Buffer.from(res.body as ArrayBuffer);
      truncatedBody = res.truncated === true;
    }
    /**
     * `#437` **`&ty=hex`：回「原始字节的 hex 串」**（对齐 Legado `AnalyzeUrl.kt:461-463` 的 `type` 分支）。
     *
     * 源作者用它做**兜底解码**：`java.bytesToStr(java.hexDecodeToByteArray(hex),'gbk')`
     * （实测千白羽论坛的 `x8Gbk`）。必须在任何文本处理（解密/`<base>` 注入/charset 改写）**之前**转换，
     * 否则拿到的就不是原始字节了。
     */
    if (String(req.query.ty ?? '').toLowerCase() === 'hex') {
      reply.header('content-type', 'text/plain; charset=utf-8');
      reply.header('cache-control', 'public, max-age=3600');
      return reply.send(Buffer.from(Buffer.from(buf).toString('hex'), 'utf8'));
    }
    /** 区段响应（206）：字节不是完整文件，**一律不做图片解密** */
    const partial = res.status === 206;
    /**
     * `#439` **文本类响应：先按上游字符集解码**（`detectCharset`/`decodeBytes` = core 唯一实现）。
     *
     * 缺陷类别（用户实测：千白羽小说站经本代理整页 `����`；重启多次无效）：
     * 本路由取的是 **原始字节**（`responseType:'arraybuffer'`，为解密/`ty=hex`/HLS 重写服务）
     * ⇒ core 的文本分支**不执行**；而下游的字符串处理（`#435` HTML 文档修补）却写成
     * `buf.toString('utf8')` ⇒ **GBK 字节被按 UTF-8 解**，每个汉字变 U+FFFD `�`，
     * 再 `Buffer.from(str,'utf8')` 回写 ⇒ 不可逆损坏；`#437` 的 content-type 改写
     * （`charset=utf-8`）又让客户端放心按 UTF-8 解 ⇒ 满屏 `�`。
     * 修法：**先解对**（① `&cs=` 显式 → ② 上游 `Content-Type` charset → ③ `<meta charset>`
     * 嗅探 → ④ UTF-8），再做字符串处理，最后统一以 UTF-8 回传（见本文件尾部 `#437` 改写）。
     */
    const textish = /^text\/|html|json|xml|javascript/i.test(type);
    /**
     * `#743` P0 埋点：文本通道的**同步 CPU**（字符集嗅探/解码 + HTML 补丁 + HLS 重写）
     * 此前没有计时。独占一个 `k=proxy-text`，不并入 `dom-select`/`sync-http` 口径。
     * 只对文本响应计时（图片/媒体走别的分支，记 0ms 会把 n 值撑大、误导均值）。
     */
    const tProxyText = Date.now();
    const proxyTextTimed = textish || /html/i.test(type);
    let decoded: string | null = null;
    if (textish && !partial) {
      decoded = decodeBytes(buf, detectResponseCharset(buf, type, String(req.query.cs ?? '')));
    }
    // 源声明了图片解密规则 → 服务端跑 JS 解密（失败回落原图，不打断阅读）
    // ⚠️ 206 绝不解密：解密规则面向完整文件（切条/异或等），对切片跑只会产出坏字节
    /**
     * `#435` **解密只对「像图片」的响应做**：明确是文本/标记/媒体流的响应一律跳过。
     *
     * 实测（91视频，用户日志）：**播放器页**的 URL（`ha2…/t2player.html?url=…m3u8`）也会经代理取到
     * （响应 `text/html`），而旧判据只排除 `audio|video` ⇒ 把整页 HTML 当密文喂给 `coverDecodeJs`
     * ⇒ `Provider routines::wrong final block length` 刷屏，且这条 warn 与「正片播放」无关，
     * 会把排查引偏（用户正是拿它来问「播放器全黑」）。
     * ⚠️ **不能**改成 `/^image\//` 白名单：不少源把封面按 `application/octet-stream` 返回
     *   （见 `apps/web/src/utils/img.ts` 头注「上游把动图当 octet-stream」），白名单会把它们的解密整块关掉。
     * `mpegurl`：嗅探到的 m3u8 清单同样带 `sid` 走本路由，也不是密文图片。
     */
    const notImageish = /^audio|^video|^text\/|json|xml|javascript|xhtml|mpegurl/i.test(type);
    /**
     * `#769` **无解密规则就别排队**：`queuedDecodeImage` 会先进串行链、再等
     * `foregroundGate.waitIdle()`（上限 5s），而 `hub.decodeImage` 对「规则为空」的源只返回 null。
     * ⇒ 交互请求在飞时，没有 `coverDecodeJs` 的源（语料里绝大多数）封面被白白推迟最多 5s。
     * 实测速读谷：直连同一批封面 184~644ms，用户日志里 `/api/proxy` 9~18s（叠加 `#477` 冻结）。
     * 判据与 `decodeImage` 完全一致 ⇒ 有规则的源行为不变。
     */
    const isCoverImg = req.query.cover === '1';
    const needDecode = !!sid && !partial && !notImageish && hub.hasImageDecodeRule(sid, isCoverImg);
    if (needDecode) {
      try {
        const decoded = await queuedDecodeImage(sid, { url: raw, bytes: new Uint8Array(buf), isCover: isCoverImg });
        if (decoded?.length) {
          buf = Buffer.from(decoded);
          // 解密后按魔数纠正 content-type（上游常给 octet-stream，浏览器需要正确类型才渲染）
          const sniffed = sniffImageType(buf);
          if (sniffed) type = sniffed;
        }
      } catch {
        /* 解密失败 → 回传原图 */
      }
    }
    // 上游没给可识别类型时也按魔数纠一次（**只改 type，不动字节** —— 动图靠这条才不会被当成 octet-stream）
    if (!/^image\//i.test(type)) {
      const sniffed = sniffImageType(buf instanceof Buffer ? new Uint8Array(buf) : buf);
      if (sniffed) type = sniffed;
    }
    /**
     * `#691`/`#816` 存图片缓存：只收「完整 200 + 已是图片类型 + 没走 Range」的响应，
     * 且存的是**解密后**的字节。写盘不挡回包（失败只丢本次缓存，不影响这次请求）。
     */
    if (imageCacheCategory && !partial && res.status === 200 && /^image\//i.test(type) && Buffer.isBuffer(buf)) {
      void cacheStore.put(imageCacheCategory, imageCacheKey, buf, type).catch(() => {});
    }
    /**
     * **HLS 播放列表重写**（见 `rewriteHlsPlaylist` 注释）。
     *
     * 位置要求：必须在「图片解密」之后、`content-type` 回传之前 —— 它只改文本不改字节语义，
     * 而区段响应（206）是二进制切片，绝不能走这里。
     *
     * `YUEDU_HLS_REWRITE=0` 可关掉它：这是**故障复现开关** —— 用户实测过「服务端跑旧 bundle
     * （没有这段重写）⇒ master 多码率源的相对子列表被解析到代理 URL 下 ⇒ `levelParsingError`」。
     * 关掉后才能验证「客户端自带重写后，服务端不重写也能播」这条兜底是否真的有效。
     */
    if (!partial && process.env['YUEDU_HLS_REWRITE'] !== '0' && isHlsPlaylist(type, raw)) {
      /**
       * `#432` **实体确认**：URL/type 只是粗筛（91视频的播放器页 `t2player.html?url=…m3u8`
       * 也含 `.m3u8`）。不是真播放列表（不以 `#EXTM3U` 起头）就**原样回传** —— 既不重写、
       * 也不改 `content-type`（否则 HTML 会被当清单糟蹋成 `…%3Chtml%3E…` 并以
       * `application/vnd.apple.mpegurl` 回传 ⇒ hls.js `manifestParsingError`）。
       * 见 `hls.ts` 的 `looksLikeHlsBody`（同文件，判据唯一处）。
       */
      const text = buf.toString('utf8');
      if (looksLikeHlsBody(text)) {
        try {
          buf = Buffer.from(rewriteHlsPlaylist(text, raw), 'utf8');
        } catch {
          /* 重写失败 → 回传原列表（相对地址能不能用取决于 hls.js，但至少不阻断） */
        }
        type = 'application/vnd.apple.mpegurl';
      }
    }
    /**
     * `#435` **被代理的 HTML 文档**：注 `<base href=上游>` + 还原 `location.search`。
     *
     * 场景：正文里的 `<iframe src>` 被壳层换成 `/api/proxy?u=…`（`#363`），
     * 而站点播放器页既用**相对路径**引自己的 JS（`hls7.min.js`），又从
     * `window.location.search` 读 `url=` ⇒ 文档 URL 变成代理地址后两者同时失效
     * ⇒ **播放器全黑**（真机 CDP 复现；判据与修法见 `proxy-doc.ts` 头注）。
     * 只对 HTML 响应做（清单/图片/206 切片都不受影响）。
     */
    /**
     * `#457` 加 `looksLikeHtmlDocument`：**只看 content-type 不够** —— 实测
     * `www.yckceo.com/index/durl/add.html?data=…` 在 `text/html` 下回的是一行纯文本 URL（62 字节），
     * 补丁被注入到纯文本前 ⇒ 站内脚本（经壳层 NET 桥 fetch 它）拿到的是 `<base href=…><script>…` 这串
     * 标记 ⇒ 弹层里"生成地址"被污染 ⇒ 复制到导入框报「请输入 http(s) 开头的地址」（用户 2026-10-14 实测）。
     */
    const docText = decoded ?? buf.toString('utf8');
    if (!partial && /html/i.test(type) && looksLikeHtmlDocument(docText)) {
      // `#439`：用**已按上游字符集解好**的字符串做修补（`decoded` 非空时）——
      // 旧写法 `buf.toString('utf8')` 会把 GBK 文档整篇毁成 `�`（见上面 `#439` 注释）。
      buf = Buffer.from(injectProxiedDocPatches(docText, raw), 'utf8');
      decoded = null; // 已编码回字节（下面不再重复编码）
    }
    /**
     * `#437` **文本响应的 `charset` 必须改写成 `utf-8`**（`#439` 修正了它的前提）。
     *
     * 本路由回传的文本 body 是**先按上游字符集解对、再按 UTF-8 编码**的字节
     * （`#439`：`detectCharset`/`decodeBytes`，见上方注释；`#437` 当时的注释误以为
     *  body 本来就是 core 文本分支解好的串 —— 那条分支在本路由**根本不执行**，
     *  真实情况是原始字节，所以旧实现既没解对、又改了头，成了满屏 `�`）。
     * 而上游头里的 charset 只对**上游原始字节**成立 —— 原样透传 `text/html; charset=gb2312`
     * 会让客户端（沙箱页的 `java.ajax`/`fetch`、任何 `<iframe>` 文档）把 **UTF-8 字节按 GBK 解**
     * ⇒ 整页中文乱码（实测「千白羽的小说站」→「鍗冪櫧缇界殑灏忚」）。
     *
     * ⚠️ 只改**文本类**（html/xml/json/js/plain）；图片、mpegurl 清单、二进制一律不动。
     */
    if (/^text\/|html|json|xml|javascript/i.test(type)) {
      type = type.replace(/;\s*charset\s*=\s*[^;]*/gi, '').trim() + '; charset=utf-8';
    }
    // `#743`：文本通道耗时（解码 + 补丁 + 重写 + 重新编码），只在文本类响应上留痕
    if (proxyTextTimed) {
      recordBlock('proxy-text', Date.now() - tProxyText, `${type.split(';')[0]} ${buf.length}B ${raw.slice(0, 90)}`);
    }
    /**
     * `#439` **把「已解对的字符串」重新编码成 UTF-8 字节**回传。
     * 走到这里 `decoded` 非空的仅两类：① 纯文本类（非 html，没走上面的修补分支）；
     * ② 万一 html 修补分支因 `partial` 跳过（206 已排除解码 ⇒ 不会命中）。
     * 一律「字符串 → UTF-8」⇒ 与上面改写后的 `charset=utf-8` 头自洽。
     */
    if (decoded !== null) buf = Buffer.from(decoded, 'utf8');
    reply.header('content-type', type);
    reply.header('cache-control', 'public, max-age=3600');
    /**
     * `accept-ranges` **跟随上游**，不无条件声明。
     *
     * 实测（禁漫天堂 CDN 的 webp）：同一 URL 直连带 `Range: bytes=0-1023` 也返回
     * `200` 全量、且**没有** `accept-ranges` —— 即该上游根本不支持区段请求。
     * 此时若我们谎称支持，浏览器会对每张图先发一次 Range 再回退全量（白跑一趟），
     * 音频播放器更会被误导成「可以 seek」而卡住。只有上游确实支持（206 或声明了
     * `accept-ranges: bytes`）时才回传。
     */
    if (partial || /bytes/i.test(res.headers['accept-ranges'] ?? '')) {
      reply.header('accept-ranges', 'bytes');
    }
    if (partial) {
      /**
       * 206 透传。`Content-Range` 决定播放器的时间轴长度，**截断时必须改写**：
       * 原样回传一个「总长 N」但只给 M 字节（M < N）会让播放器一直等剩余字节（卡住不动），
       * 改写成 `bytes 0-(M-1)/*` 表示「总长未知的部分内容」，播放器会主动再发 Range 继续取。
       * 未截断时原样透传上游值（含真实总长，进度条才有长度）。
       */
      reply.code(206);
      const cr = res.headers['content-range'] ?? '';
      if (truncatedBody) {
        const len = buf.byteLength;
        /**
         * `#420` **起点不能写死 0**。
         *
         * 用户实测（逆次元_动漫）：拖动/分段播放时客户端发的是 `Range: bytes=<start>-`，
         * 上游 206 的数据**从 start 开始**；旧实现一律改写 `bytes 0-<M-1>/*` ⇒ 播放器把
         * 「第 start 字节的数据」当成「文件第 0 字节」⇒ 时间轴/续取全错。
         * 起点优先取**上游 `Content-Range` 的起点**（最权威），其次取**请求的 `Range` 起点**，
         * 都取不到才回落 0（= 整段请求）。
         */
        const crStart = Number((/bytes\s+(\d+)-/i.exec(String(cr)) || [])[1]);
        const reqStart = Number((/bytes=(\d+)-/i.exec(String(req.headers['range'] ?? '')) || [])[1]);
        const start = Number.isFinite(crStart) ? crStart : Number.isFinite(reqStart) ? reqStart : 0;
        reply.header('content-range', len > 0 ? `bytes ${start}-${start + len - 1}/*` : `bytes */${start}`);
        console.warn(`[proxy] 区段响应被体积护栏截断 → content-range 改写为 bytes ${start}-${start + len - 1}/*（${raw.slice(0, 100)}）`);
      } else if (cr) {
        reply.header('content-range', cr);
      }
      return reply.send(buf);
    }
    return reply.send(buf);
  } catch (e) {
    noteProxyFailure(undefined, e);
    return reply.code(502).send({ error: `PROXY_FAIL: ${String(e instanceof Error ? e.message : e).slice(0, 80)}` });
  }
});

/**
 * `#418` **`/api/proxy` 的 POST 半边** —— 沙箱页（RSS 启动页 `startJs`）里 `java.ajax` 的 POST 出口。
 *
 * ## 为什么必须有
 * Legado 的 `java.ajax` **同步**支持 `url,{options}` 尾巴（`method`/`body`/`headers`，判据唯一实现
 * 在 core `net/url-prep.ts` 的 `splitUrlOptions`）。LOFTER 启动页用它取作者/合集/文章数据
 * （`fetchAuthor` / `updateColName` / `fetchArticle` 全是 `,{method:'POST',body:…}`）。
 * 既有 `app.get('/api/proxy')` 只服务 GET ⇒ 这些请求一律 **404** ⇒ 用户视角「按钮点了没反应」。
 *
 * ## 与 GET 半边**刻意不同**（不搬 Range/HLS/媒体流式/图片解密那一整套）
 * 那些只对 GET 资源语义成立；这里是 **API 调用**（表单体 + JSON 响应，要文本不要字节）。
 * 共用的只有两件：① `sourceProxyHeaders`（源 `header` 规则 ⊕ 登录头 ⊕ Cookie —— 同一函数，防漂移）；
 * ② CORS 例外（`Origin: null` ⇒ 回 `ACAO: null`，与 GET 半边**逐字相同**，理由见该路线注释）。
 *
 * ## 请求体从哪来
 * 前端垫片用 `Content-Type: text/plain` 发（**简单请求 ⇒ 不触发预检**），Fastify 默认解析成
 * 字符串 ⇒ `req.body` 直接就是表单原文；转发上游时**改写**回 `application/x-www-form-urlencoded`
 * （与 core `withFormEncodedBody` 的默认编码一致）。这样无需注册额外的 content-type 解析器。
 *
 * ⚠️ SSRF 面与 GET 半边相同（本服务只绑 127.0.0.1、无鉴权）；本路由只多开「方法」，不多开「可达主机」。
 */
// 表单体原样保留为字符串（Fastify 默认解析器不含 `application/x-www-form-urlencoded`）：
// 启动页垫片用 `text/plain`（默认解析器即有），正文 NET 桥的 fetch 会带**原始** content-type
// ⇒ 这里补一个，两条路都拿到 `req.body` 字符串。
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));
app.post<{ Querystring: { u?: string; sid?: string; r?: string; dnsIp?: string } }>('/api/proxy', async (req, reply) => {
  if (req.headers.origin === 'null') {
    reply.header('access-control-allow-origin', 'null');
    reply.header('vary', 'origin');
    // `#446` 同 GET 半边：源脚本的 `fetch(...,{credentials:'include'})` 要 `ACAC: true` 才不被判 CORS 失败
    reply.header('access-control-allow-credentials', 'true');
  }
  const raw = (req.query.u ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return reply.code(400).send({ error: 'BAD_URL' });
  // `#462` 与 GET 半边同款：登记在飞（收尾用 `res.on('close')`，见 GET 半边的注释）
  {
    const endTrack = trackStart(`proxyPOST:${String(raw).slice(0, 84)}`);
    reply.raw.on('close', endTrack);
  }
  const sid = req.query.sid;
  const srcHeaders = await sourceProxyHeaders(sid);
  const headers: Record<string, string> = { 'User-Agent': PROXY_UA_MOBILE, Accept: '*/*', ...srcHeaders };
  // Referer 统一由 refererChain 给（避免出现两个 Referer，与 GET 半边同一处理）
  const refKey = Object.keys(headers).find((k) => k.toLowerCase() === 'referer');
  const headerRef = refKey ? headers[refKey]! : '';
  if (refKey) delete headers[refKey];
  // `#369`：RSS 源的站点在 `sourceUrl`（legado/MacCMS 才叫 `bookSourceUrl`）
  const srcRaw = hub.sources.get(sid ?? '')?.raw as Record<string, unknown> | undefined;
  const srcSite = originOf((srcRaw?.['bookSourceUrl'] ?? srcRaw?.['sourceUrl']) as string | undefined);
  const ref = refererChain({ explicit: req.query.r ?? '', headerRef, srcSite, assetOrigin: originOf(raw) })[0] ?? '';
  if (ref && /^https?:\/\//i.test(ref)) headers['Referer'] = ref;
  const body = typeof req.body === 'string' ? req.body : '';
  try {
    const res = await proxyHttp.request(raw, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
      // `#428`：与 GET 半边同一判据
      ...(sourceAllowsInsecureTls(sid) ? { allowInsecureTls: true } : {}),
      // `#742`：POST 半边同样接受 `dnsIp`（只改域名→地址，Host/SNI 不变）
      ...(typeof req.query.dnsIp === 'string' && req.query.dnsIp.trim() ? { dnsIp: req.query.dnsIp } : {}),
      timeout: 20_000,
      responseType: 'arraybuffer',
      priority: 'low',
    });
    // 5xx 只留给真正的中介故障（与 GET 半边同一判据：上游明确的拒绝原样透传状态码）
    if (res.status >= 500) return reply.code(502).send({ error: `UPSTREAM_${res.status}` });
    return reply
      .code(res.status)
      .header('content-type', res.headers['content-type'] ?? 'text/plain; charset=utf-8')
      .send(Buffer.from((res.body as ArrayBuffer) ?? new ArrayBuffer(0)));
  } catch (e) {
    return reply.code(502).send({ error: `PROXY_FAIL: ${String(e instanceof Error ? e.message : e).slice(0, 80)}` });
  }
});

/**
 * `#394` **解析云二级解析**：把「解析页 URL」换成「可播直链」。
 *
 * 场景：AGE 等 RSS 源的选集 href 是 `https://jx…:8443/m3u8/?url=…`（解析云播放器页面，
 * 路径带 `/m3u8/` 骗过「像媒体」判据）⇒ 播放器直载一个 HTML 页 ⇒ `manifestParsingError`。
 * 判定逻辑全部住在 `media-resolve.ts`（可测模块，index 是单体导不出东西）。
 *
 * 请求：`GET /api/media-resolve?u=<encodeURIComponent(地址)>&r=<referer 可选>&sid=<源 id 可选>`
 * 响应：`resolveMediaPage` 的 JSON（`{ok,url,format?,kind,reason?}`；`ok:false` 也回 200 ——
 *       「这个解析页提不出直链」是**结果**不是服务端错误，前端按业务失败展示）。
 *
 * ⚠️ 无凭据只读端点（与 `/api/proxy` 同级；`sid` 只用来带源头 header），SSRF 面与 proxy 相同。
 */
app.get<{ Querystring: { u?: string; r?: string; sid?: string } }>('/api/media-resolve', async (req, reply) => {
  const raw = (req.query.u ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return reply.code(400).send({ ok: false, url: '', kind: 'none', reason: 'BAD_URL' });
  const srcHeaders = await sourceProxyHeaders(req.query.sid);
  const headers: Record<string, string> = {
    // 桌面 UA：解析云页面按「桌面浏览器打开」渲染，直链提取不受 UA 分流影响（`#367` 的手机 UA 语义是给网盘类的）
    'User-Agent': PROXY_UA_DESKTOP,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    ...srcHeaders,
  };
  if (req.query.r && /^https?:\/\//i.test(req.query.r)) headers['Referer'] = req.query.r;
  const out = await resolveMediaPage({ url: raw, headers, timeoutMs: 20_000 }, (u, o) =>
    proxyHttp.request(u, { ...o, responseType: 'text' as const, priority: 'low' }),
  );
  return reply.send(out);
});

/**
 * `#516` **清空所有源的 Cookie**（设置页「清理缓存与 Cookie」的服务端一半）。
 *
 * 为什么要连渲染凭证一起清：`data/browser-profiles/<profile>/ctx-cookies.json`（`#515` 的 context
 * 凭证）也是「登录态 / CF clearance」的一部分 —— 只清 `cookies.json` 会留下**已经过期的**
 * clearance，下次渲染反而拿它去撞墙。
 */
app.delete('/api/cookies', async () => {
  let cleared = 0;
  // 用导出表遍历（SourceStore 不是 Map，只暴露 get/has/export）
  for (const id of Object.keys(hub.exportSourceCookies())) {
    if (hub.getSourceCookies(id)) {
      hub.setSourceCookies(id, '');
      cleared += 1;
    }
  }
  try {
    fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
    persistSourceCookies();
  } catch {
    /* 持久化失败不影响内存态 */
  }
  // 渲染上下文里的凭证（`#515`）：逐个删掉，避免残留过期 clearance
  let ctxFiles = 0;
  try {
    const root = path.join(DATA_DIR, 'browser-profiles');
    if (fs.existsSync(root)) {
      for (const d of fs.readdirSync(root)) {
        const f = path.join(root, d, 'ctx-cookies.json');
        if (fs.existsSync(f)) {
          fs.rmSync(f, { force: true });
          ctxFiles += 1;
        }
      }
    }
  } catch {
    /* 目录被占用等：跳过的只是清理力度，不是正确性 */
  }
  return { cleared, ctxFiles };
});

// 源登录 Cookie（GET 读取 / POST 导入 "a=b; c=d" 或 JSON；持久化 data/cookies.json）

app.get<{ Params: { id: string } }>('/api/sources/:id/cookies', async (req, reply) => {
  if (!hub.sources.has(req.params.id)) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  return { id: req.params.id, cookie: hub.getSourceCookies(req.params.id) };
});
app.post<{ Params: { id: string }; Body: { cookie?: string } }>(
  '/api/sources/:id/cookies',
  async (req, reply) => {
    const ok = hub.setSourceCookies(req.params.id, String(req.body?.cookie ?? ''));
    if (!ok) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    try {
      fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
      persistSourceCookies();
    } catch {
      /* 持久化失败不影响内存态 */
    }
    return { id: req.params.id, cookie: hub.getSourceCookies(req.params.id) };
  },
);

// 源登录（Legado BaseSource.login）：
//   GET  → 登录形态与当前状态（loginKind / needBrowser / 已存登录信息 / Cookie 条数）
//   POST → 执行登录脚本（body.info 可一并保存账号密码）；服务端跑不了时返回 action='browser'
/**
 * 判断某个登录信息字段是否**敏感**（不下发真值，只在表单里显示「已保存」占位）。
 *
 * 覆盖范围按用户 2026-09-25 的原话：「**账号密码框**用 `*` 代替，非敏感文本原样回填」——
 * 所以**账号类也在内**（它的 `type` 是 `text`，只看 type 会漏），另外把常见的凭据/token/密钥、
 * 以及手机号/邮箱这类身份标识一并算进来。
 *
 * 为什么倾向「宁可多判」：误判成敏感的代价只是「用户少看到一次回填」，
 * 而**漏判的代价是账号密码明文出现在浏览器内存与网络响应里**。两边不对称，所以偏保守。
 *
 * 判定顺序：先看 `uiFields` 的 `type === 'password'`，再按键名启发式
 * （v1 的信息可能是用户手填的、或来自更早的版本，未必有字段定义）。
 */
function isSecretLoginField(name: string, type?: string): boolean {
  if (type === 'password') return true;
  return /密码|口令|账号|帐号|登录名|用户名|user(name)?|account|pass(word|wd)?|pwd|secret|token|credential|凭据|密钥|api[-_]?key|手机号|邮箱|email|phone/i.test(
    name,
  );
}

/**
 * `#753` B2 **下放判据**：这个源的登录脚本能不能只靠 HTTP 跑完？
 *
 * 能（`false`）⇒ 求值搬子进程：`loginUrl` / `loginUi` 的 `@js:` / `<js>`、`java.*` 登录 API 全在
 * 子进程里跑，结果（toast/表单回填/变量袋/Cookie）经 IPC 回来。
 *
 * 不能（`true`）⇒ **留在主进程**，因为它要真浏览器：
 *  · 静态判据 `plan.needBrowser`（`loginUrl` 里 `"browser"` 段）；
 *  · 动态判据：`jsLib` / `loginUrl` / `loginUi` 里出现 `startBrowserAwait`（Legado 的登录脚本
 *    常把「打开浏览器让用户登录」封装在 jsLib 里，静态 `needBrowser` 看不出来）、`webView`、
 *    `getVerificationCode`、`showBrowser` —— 这些 API 的实现在主进程（CDP 会话 / 验证码认领）。
 *
 * 为什么必须挡：子进程**不注入** `webRenderer` / `verificationCode` / Cookie 收割，
 * 这类脚本下放只会得到「登录失败」而主进程完全不知道原因（静默劣化）。
 */
const BROWSER_LOGIN_API = /\b(startBrowserAwait|startBrowser|showBrowser|openBrowser|webView|getVerificationCode)\b/;
function loginNeedsBrowser(raw: Record<string, unknown>): boolean {
  try {
    if (classifyLoginUrl(raw['loginUrl'], raw['loginUi']).needBrowser) return true;
  } catch {
    /* 分类失败按「需要主进程」更安全 */
    return true;
  }
  const scripts = [raw['jsLib'], raw['loginUrl'], raw['loginUi']]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join('\n');
  return BROWSER_LOGIN_API.test(scripts);
}

/**
 * `#753` B2：在子进程执行登录，并把「该源运行时状态」**只同步进主进程内存**。
 *
 * 单写者：落盘（`kv.json` 的 `login-info:*` / `source-var:*`、`cookies.json`）已由子进程以
 * `kv-write` / `cookie-write` 发起、主进程执行 —— 这里**绝不**再 `storage.set` / `persistSourceCookies()`。
 */
async function loginInBatch(
  sourceId: string,
  opts: { info?: Record<string, unknown>; action?: string; loginState?: string; loginForm?: string },
): Promise<Awaited<ReturnType<typeof hub.login>>> {
  const out = (await batchRunner.login({ sourceId, opts })) as BatchLoginResult;
  hub.setSourceLoginInfo(sourceId, out.loginInfo ?? {}, { persist: false });
  hub.setSourceVariable(sourceId, String(out.variable ?? ''), { persist: false });
  // Cookie 的**清空**走 `cookie-write`（null）；这里只做内存补值，避免登录失败时把已有 Cookie 冲掉
  if (out.cookie) hub.setSourceCookies(sourceId, out.cookie);
  return out.login as Awaited<ReturnType<typeof hub.login>>;
}

/** 是否满足「纯 HTTP 登录 + B2 开关 + B1 子进程可用」三条件 */
function shouldOffloadLogin(raw: Record<string, unknown>): boolean {
  return b2ProcessEnabled() && batchProcessEnabled() && !loginNeedsBrowser(raw);
}

app.get<{ Params: { id: string } }>('/api/sources/:id/login', async (req, reply) => {
  const s = hub.sources.get(req.params.id);
  if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  const raw = s.raw as Record<string, unknown>;
  const plan = classifyLoginUrl(raw['loginUrl'], raw['loginUi']);
  const cookie = hub.getSourceCookies(req.params.id);
  const loginInfo = await hub.loadSourceLoginInfo(req.params.id);
  const loginHeader = await hub.loadSourceLoginHeader(req.params.id);
  /**
   * 登录信息**回填策略**（用户 2026-09-25 决策：「账号密码框用 `*` 代替，非敏感文本原样回填」）。
   *
   * · 非敏感字段 → 放进 `loginInfo` **原样下发**（设备名/接口地址这类，不回填就没意义）；
   * · 敏感字段 → 只把**键名**放进 `loginInfoMasked`，真值**永不出服务端** ——
   *   前端据此在输入框显示「已保存（•），留空则不修改」占位（原设计「值不下发」的安全属性保留）。
   *
   * 敏感判定优先用 `uiFields` 的 `type === 'password'`，否则按键名启发式（见 `isSecretLoginField`）。
   */
  /**
   * `#423` **脚本型 `loginUi` 在打开对话框时就渲染**（用户报 18AV「登录界面表单仍然未正确加载」）。
   *
   * `classifyLoginUrl` 只能解析**静态数组**形态的 `loginUi`；`@js:`/`<js>` 形态被判成
   * `uiIsScript=true`、`fields=[]` ⇒ 前端只显示一句「该源登录界面由脚本动态生成，直接点『登录』执行」
   * —— **空表单**，必须先手点一次「登录」才出现行；上游 Legado 是**打开即渲染**。
   *
   * 这里用一个显式伪动作让引擎**只求值 `loginUi`**：不执行任何登录脚本、不写状态（读接口零副作用，
   * 判据见 core `LOGIN_UI_RENDER_ACTION`）。渲染失败保持空 ⇒ 前端仍显示原提示，不静默变脸。
   */
  let uiFields = plan.fields;
  if (plan.uiIsScript) {
    const rawLogin = s.raw as Record<string, unknown>;
    try {
      /**
       * `#753` B2：脚本型 `loginUi` 的渲染（可能要跑几十 KB 的 JS）也走子进程；
       * 需要浏览器的源仍留主进程（判据见 `loginNeedsBrowser`）。
       * 子进程失败 ⇒ 回落主进程再渲染一次（GET 是读接口，宁可慢也不给空表单）。
       */
      let rendered: Awaited<ReturnType<typeof hub.login>> | null = null;
      if (shouldOffloadLogin(rawLogin)) {
        try {
          rendered = await loginInBatch(req.params.id, { action: LOGIN_UI_RENDER_ACTION });
        } catch (e) {
          console.warn(`[batch] 登录界面渲染子进程失败，回落主进程：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      rendered ??= await hub.login(req.params.id, { action: LOGIN_UI_RENDER_ACTION });
      if (rendered.fields?.length) uiFields = rendered.fields;
    } catch {
      /* 渲染失败 → 保持空（前端原提示），不把 GET 打挂 */
    }
  }
  /** 敏感判定**优先用实际渲染出的行**的 `type === 'password'`（渲染前空 ⇒ 副作用同旧） */
  const fieldTypeOf = new Map((uiFields ?? []).map((f) => [String(f.name), String(f.type)] as const));
  const loginInfoPublic: Record<string, string> = {};
  const loginInfoMaskedKeys: string[] = [];
  for (const [k, v] of Object.entries(loginInfo)) {
    if (isSecretLoginField(k, fieldTypeOf.get(k))) loginInfoMaskedKeys.push(k);
    else loginInfoPublic[k] = v;
  }
  return {
    id: req.params.id,
    kind: plan.kind,
    needBrowser: plan.needBrowser,
    url: plan.url || null,
    /** loginUi 行（text/password 表单 + button/toggle 动作）；脚本型已在上面渲染好（`#423`） */
    uiFields,
    uiIsScript: plan.uiIsScript,
    /** 是否存在 `login()` 登录脚本：决定前端按钮文案（「保存并登录」 vs 仅「保存登录信息」） */
    hasLoginScript: Boolean(String(plan.js ?? '').trim()),
    /** 已保存登录信息里的**非敏感字段**（原样回填表单 —— 用户 2026-09-25 决策） */
    loginInfo: loginInfoPublic,
    /** 有值但**不下发真值**的敏感字段键名（前端输入框显示「已保存（•），留空则不修改」） */
    loginInfoMasked: loginInfoMaskedKeys,
    /** 已保存的登录信息键名（保留：前端「信息：账号/密码」这类只读展示在用） */
    loginInfoKeys: Object.keys(loginInfo),
    hasLoginInfo: Object.keys(loginInfo).length > 0,
    // LoginUiV2：前端看到它就知道「行要等 loginUi(state) 渲染出来」（不是空表单，也不要提示去写表单）
    uiV2: plan.uiV2 === true,
    loginHeaderKeys: loginHeader ? Object.keys(JSON.parse(loginHeader) as Record<string, unknown>) : [],
    hasCookie: !!cookie,
    cookieCount: cookie ? cookie.split(';').filter((x) => x.includes('=')).length : 0,
  };
});

app.post<{
  Params: { id: string };
  Body: {
    info?: Record<string, unknown>;
    action?: string;
    /** LoginUiV2 会话状态（回传引擎，别在服务端解释） */
    loginState?: string;
    /** LoginUiV2 表单快照 JSON（`{key: value}`），动作脚本的第三参 */
    loginForm?: string;
  };
}>('/api/sources/:id/login', async (req, reply) => {
  if (!hub.sources.has(req.params.id)) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  const rawLogin = hub.sources.get(req.params.id)?.raw as Record<string, unknown>;
  /**
   * `#753` B2：纯 HTTP 登录脚本 → 子进程求值（主线程不再被几十 KB 的登录 JS / 同步 HTTP 拖住）。
   * 子进程失败 ⇒ **回落主进程**（登录是用户点按钮的显式动作，宁可多跑一次也不能给假失败）。
   *
   * ★ 落盘分工：`handledByBatch=true` 时子进程已经用 `kv-write` / `cookie-write` 发起过写入，
   * 本路由**不再**自己 `persistSourceCookies()` / `setSourceLoginInfo()` —— 同一键只有一条写入发起路径。
   */
  let handledByBatch = false;
  let result: Awaited<ReturnType<typeof hub.login>> | null = null;
  if (shouldOffloadLogin(rawLogin)) {
    try {
      result = await loginInBatch(req.params.id, {
        info: req.body?.info,
        action: req.body?.action,
        loginState: req.body?.loginState,
        loginForm: req.body?.loginForm,
      });
      handledByBatch = true;
    } catch (e) {
      console.warn(`[batch] 登录子进程失败，回落主进程：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  result ??= await hub.login(req.params.id, {
    info: req.body?.info,
    action: req.body?.action,
    loginState: req.body?.loginState,
    loginForm: req.body?.loginForm,
  });
  if (!handledByBatch) {
    // 登录脚本写入的 Cookie 落盘（与 /cookies 端点同一份存储）
    if (result.cookie) {
      try {
        fs.mkdirSync(path.dirname(COOKIES_FILE), { recursive: true });
        persistSourceCookies();
      } catch {
        /* 持久化失败不影响内存态 */
      }
    }
    if (req.body?.info) {
      try {
        fs.mkdirSync(path.dirname(LOGIN_INFO_FILE), { recursive: true });
        fs.writeFileSync(LOGIN_INFO_FILE, JSON.stringify(hub.exportSourceLoginInfo(), null, 1));
      } catch {
        /* 同上 */
      }
    }
  } else if (req.body?.info) {
    // 旧镜像文件（启动时会载回）仍由主进程刷新；KV 的权威写入已由子进程发起
    try {
      fs.mkdirSync(path.dirname(LOGIN_INFO_FILE), { recursive: true });
      fs.writeFileSync(LOGIN_INFO_FILE, JSON.stringify(hub.exportSourceLoginInfo(), null, 1));
    } catch {
      /* 同上 */
    }
  }
  return { id: req.params.id, ...result };
},
);

// 源登录信息（账号/密码）读写——免浏览器登录脚本靠 source.getLoginInfoMap() 读取
app.get<{ Params: { id: string } }>('/api/sources/:id/login-info', async (req, reply) => {
  if (!hub.sources.has(req.params.id)) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  return { id: req.params.id, info: hub.getSourceLoginInfo(req.params.id) };
});
app.post<{ Params: { id: string }; Body: { info?: Record<string, unknown> } }>(
  '/api/sources/:id/login-info',
  async (req, reply) => {
    const ok = hub.setSourceLoginInfo(req.params.id, req.body?.info ?? {});
    if (!ok) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    try {
      fs.mkdirSync(path.dirname(LOGIN_INFO_FILE), { recursive: true });
      fs.writeFileSync(LOGIN_INFO_FILE, JSON.stringify(hub.exportSourceLoginInfo(), null, 1));
    } catch {
      /* 持久化失败不影响内存态 */
    }
    return { id: req.params.id, info: hub.getSourceLoginInfo(req.params.id) };
  },
);

// 修改单个源的开关（启用/禁用 · 搜索 · 发现）
app.post<{
  Params: { id: string };
  // `#428`：`allowInsecureTls`（D12=A）与另三个开关同路 —— 关校验是**每源**的显式决定
  Body: { enabled?: boolean; searchEnabled?: boolean; exploreEnabled?: boolean; allowInsecureTls?: boolean };
}>(
  '/api/sources/:id/state',
  async (req, reply) => {
    const s = hub.setSourceState(req.params.id, req.body);
    if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
    persistSource(req.params.id); // 开关也是源状态，重启要保留
    markSourcesChanged('源开关');
    return { id: s.id, state: s.state };
  },
);

// 单源静态校验
app.post<{ Params: { id: string } }>('/api/sources/:id/validate', async (req, reply) => {
  const s = hub.sources.get(req.params.id);
  if (!s) return reply.code(404).send({ error: 'SOURCE_NOT_FOUND' });
  const engine = hub.registry.get(s.kind);
  if (!engine) return reply.code(404).send({ error: 'ENGINE_MISSING' });
  const issues = engine.validate?.(s.rule) ?? [];
  return { id: s.id, kind: s.kind, ok: issues.every((i) => i.level !== 'error'), issues };
});

/**
 * 字典查词（用户 4-5）。
 *
 * 规则由**前端持有**（`yuedu-dict-rules`，见 `apps/web/src/stores/dict.ts`）：
 * 字典是纯客户端配置，且要支持「导入/新建/启停」即时生效 —— 先不落服务端库，
 * 与书架分组同一策略（Phase 1.4 用户数据迁移时再统一搬到 server 存储）。
 * 服务端只负责**执行**：`urlRule`（`{{key}}` 取词）→ `showRule` 在响应体上求值。
 */
app.post<{ Body: { word?: string; urlRule?: string; showRule?: string; header?: string; baseUrl?: string } }>(
  '/api/dict/query',
  async (req, reply) => {
    const { word, urlRule, showRule, header, baseUrl } = req.body ?? {};
    if (!String(word ?? '').trim() || !String(urlRule ?? '').trim()) {
      return reply.code(400).send({ error: 'BAD_BODY' });
    }
    try {
      return await hub.dictLookup({
        word: String(word),
        urlRule: String(urlRule),
        ...(showRule ? { showRule: String(showRule) } : {}),
        ...(header ? { header: String(header) } : {}),
        ...(baseUrl ? { baseUrl: String(baseUrl) } : {}),
      });
    } catch (e) {
      const err = e as { code?: string; message?: string; detail?: unknown };
      return reply.code(200).send({ error: err.code ?? 'DICT_FAILED', message: err.message ?? String(e), detail: err.detail });
    }
  },
);

// 单源单动作（search/home/category/detail/content/play）
/**
 * `#195`：**源的身份信息**（给错误响应与日志用）。
 *
 * 为什么必须带：服务端报错此前只有 `error`，看不出**是哪个源**产生的 ⇒ 排查要靠猜
 * （尤其是聚合搜索/批量跑的时候）。
 *
 * ★ **重名源怎么区分**：唯一键是 **`id`** = `bookSourceUrl` 的规范化形态
 * （`https://m.weibo.cn` → `https___m.weibo.cn`，即把 `://` 与 `/` 换成 `_`）。
 * 展示名 `bookSourceName` **可以重复**（语料里就有多个同名源），所以定位一律用 `id`。
 */
function sourceIdentity(sourceId: string): { id: string; name: string; url: string } {
  const src = hub.sources.get(sourceId);
  const raw = src?.raw as Record<string, unknown> | undefined;
  return {
    id: sourceId,
    name: String(raw?.['bookSourceName'] ?? src?.name ?? ''),
    url: String(raw?.['bookSourceUrl'] ?? ''),
  };
}

/** `#195` 日志去重（每源每动作只打一次，避免批量跑时刷屏） */
const runErrLogged = new Set<string>();

app.post<{ Body: { sourceId: string; action: string; keyword?: string; page?: number; filters?: Record<string, string>; id?: string; extra?: Record<string, unknown>; nextUrl?: string } }>(
  '/api/run',
  async (req, reply) => {
    // `#306`：nextUrl 是跨页通道（引擎给的下一页 URL 原样回传），**必须在白名单里**，
    // 否则服务端会静默丢掉它 ⇒ 前端翻页仍走 page+1 重放 ⇒ 这类源永远停在第一页。
    const { sourceId, action, keyword, page, filters, id, extra, nextUrl } = req.body;
    const act = action as EngineAction;
    if (!sourceId || !act) return reply.code(400).send({ error: 'BAD_BODY' });
    const uReq: UnifiedRequest = { action: act, keyword, page, filters, id, extra, nextUrl };
    // `#460`：登记在飞动作 —— 卡死时看门狗会把「卡死前在飞的是哪个源的哪个动作」写进报告
    const endTrack = trackStart(`src:${sourceId} ${act}`);
    /**
     * `#747` **前台在飞计数**：`/api/proxy` 的图片解密（主线程同步 JS）在它 > 0 时会让路。
     * 用户实测「图片请求拖慢目录」的机制就是解密块把目录解析的推进挤掉（见
     * `queuedDecodeImage` 头注的 stall 与受控实验数字）。
     */
    foregroundGate.enter();
    // `#495` 记客户端身份（供 antibot 留痕；Map 有界，防长跑泄漏）
    lastClientOf.set(String(sourceId), {
      ua: String(req.headers['user-agent'] ?? '').slice(0, 70),
      ref: String(req.headers['referer'] ?? req.headers['origin'] ?? '').slice(0, 90),
      act,
      at: Date.now(),
    });
    if (lastClientOf.size > 300) lastClientOf.clear();
    /**
     * `#480`（2026-10-16）**客户端断连 ⇒ abort 引擎**。
     * 用户在 Web 端切源/切分类时前端会 abort 旧请求（#241 abort+seq），但**服务端此前不知道**——
     * 引擎把整条抓取跑完（12s×重试），流量槽/带宽/域名池全被死请求占着 ⇒ 用户日志里
     * 「inflight 4 个 /api/run 互相踩、8s→10s→17s 一路累加」的主因之一。
     * 接法：响应流 close 且**尚未正常写完** ⇒ 客户端已断 ⇒ abort，signal 直达引擎 HttpClient。
     */
    const clientAbort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) clientAbort.abort();
    });
    /**
     * `#482` **把「需要人工过验证」带回给前端**：antibot-replay 撞 CF 且渲染仍失败时，
     * 服务端已经自动开了内嵌验证会话（见上面 antibotReplay 的说明），这里把会话信息挂在
     * 响应上 ⇒ 前端据此弹浮层（用户在同一只浏览器的画面里点验证），`phase` 变 `cleared` 后自动重试。
     *
     * `#642`（`#11`）**补上缺失的那一跳**：旧实现只转发「**已经存在**的会话」
     * （`verificationForSource`），所以「引擎判定撞了挑战页、但重放闸没开窗」的情况
     * ——典型的 CF 硬拦截页（404 + `Attention Required`）、或开窗本身失败（没找到完整浏览器）
     * ——前端只会看到「列表 0 条」，用户完全不知道是站点没让进门。
     * 现在：引擎把未过盾的挑战页记进 `netChallenge`（见 facade `ChallengeHit`）⇒
     * 这里据此**主动开窗**；开窗失败也留痕（前端退化成一条明确提示，不再是静默空列表）。
     *
     * ★ 只在**确实需要**时挂字段：没有会话、也没有 `netChallenge` 就不动响应形状。
     */
    const pickChallengeHit = (res: unknown): { url: string; via: string } | null => {
      const nc = (res as { netChallenge?: { urls?: unknown; via?: unknown } } | null)?.netChallenge;
      if (!nc || typeof nc !== 'object') return null;
      const urls = Array.isArray(nc.urls) ? nc.urls : [];
      const url = typeof urls[0] === 'string' ? urls[0] : '';
      if (!url) return null;
      return { url, via: String(nc.via ?? '挑战/拦截页') };
    };
    const needVerification = async (res?: unknown) => {
      const sid = String(sourceId ?? '');
      const exist = verificationForSource(sid) ?? (() => {
        /**
         * `#675` 兜底：`verificationForSource` 只查 `bySource` 索引，而**反爬重放自己开的窗**
         * 可能没进索引（会话 failed / 被替换 / 索引被清）⇒ 前端拿不到 sessionId，界面毫无反应。
         * 只要「刚为这个源开过的窗」还没 closed，就照样交回前端（浮层里用户自己能看出死活）。
         */
        const last = lastOpenedVerify.get(sid);
        if (!last) return null;
        const meta = getVerification(last.id);
        if (!meta || meta.phase === 'closed') return null;
        return meta;
      })();
      if (exist) {
        // 诊断用：用户贴「浏览器起来了但界面没反应」时，这一行能说明前端到底有没有拿到会话
        console.warn(`[run] needVerification → 会话 ${exist.id}（${exist.phase}）· ${sid}`);
        return { sessionId: exist.id, url: exist.url, phase: exist.phase };
      }
      const hit = pickChallengeHit(res);
      if (!hit) return undefined;
      try {
        const v = await openVerification({ sourceId: sid, url: hit.url, ...(await verificationFingerprint(sid)) });
        console.warn(`[run] 撞挑战/拦截页（${hit.via}）⇒ 已开内嵌验证窗 ${v.id} · ${sid}`);
        return { sessionId: v.id, url: v.url, phase: v.phase };
      } catch (e) {
        // ⚠️ 不能静默：这是「用户只看到 0 条」的另一半真因（开不出窗就没人告诉他要过验证）
        console.warn(`[run] 撞挑战页但开验证窗失败：${sid} · ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    };
    try {
      const r = await hub.run(act, sourceId, uReq, undefined, { signal: clientAbort.signal });
      const need = await needVerification(r);
      if (need) (r as unknown as Record<string, unknown>)['needVerification'] = need;
      return r;
    } catch (e) {
      const detail = (e as { detail?: { input?: unknown; rule?: unknown; cause?: unknown } })?.detail;
      const stack = (e as Error)?.stack ?? '';
      const msg = String(e instanceof Error ? e.message : e);
      // ★ `#195`：错误响应与日志都带上源身份（定位到「哪个源」靠 id，重名也不怕）
      const source = sourceIdentity(sourceId);
      const logKey = `${sourceId}|${act}`;
      if (!runErrLogged.has(logKey)) {
        runErrLogged.add(logKey);
        console.error(`[run] 源 ${source.name || '(无名)'} · id=${source.id}${source.url ? ` · ${source.url}` : ''} · ${act} 失败：${msg}`);
      }
      const need = await needVerification();
      return reply.code(502).send({
        error: msg,
        source,
        // `#482`：失败同样可能只是「还没过 CF」⇒ 带上验证会话，让前端弹浮层而不是干报错
        ...(need ? { needVerification: need } : {}),
        detail: {
          input: detail?.input,
          rule: detail?.rule,
          // 内层异常（引擎包装前的原始错误）的类型+栈：归因「哪一行」靠它，见 engine.ts causeOf
          cause: detail?.cause,
          stack: stack.split('\n').slice(1, 6).join('\n'),
        },
      });
    } finally {
      foregroundGate.leave();
      endTrack();
    }
  },
);

/**
 * `#583` **源脚本 UI 动作**（Legado 图片选项 `click` / `ruleContent.callBackJs`）。
 *
 * 请求体：
 *  · `{ sourceId, code }` —— 正文里图片选项的 `click` 原文（七猫段评气泡 / 本章说 / 神评）；
 *  · `{ sourceId, event }` —— 详情页「源按钮」：服务端从源 `ruleContent.callBackJs` 取脚本
 *    （前端不需要、也不应该持有源 raw），`event` = `clickCustomButton` / `clickBookName`。
 *
 * 响应：`{ value, browserUrl?, toasts? }` —— `browserUrl` 是脚本里 `java.showBrowser`
 * 记录的面板地址（data URL），前端用页内浏览器打开；`value` 供面板里的 `qmRun` RPC 回填。
 *
 * ⚠️ 这是**本机内部端点**（与 `/api/run` 同级），不做远程来源校验；但脚本长度设上限，
 *    防止前端误把整章正文当 code 发上来。
 */
app.post<{
  Body: {
    sourceId?: string;
    code?: string;
    event?: string;
    bookUrl?: string;
    bookName?: string;
    chapterUrl?: string;
  };
}>('/api/source-ui/eval', async (req, reply) => {
  const b = req.body ?? {};
  const sourceId = String(b.sourceId ?? '').trim();
  if (!sourceId) return reply.code(400).send({ error: 'BAD_BODY' });
  const event = String(b.event ?? '').trim() || undefined;
  let code = String(b.code ?? '').trim();
  if (!code && event) {
    const raw = (hub.sources.get(sourceId)?.raw ?? {}) as Record<string, unknown>;
    const rc = (raw['ruleContent'] ?? {}) as Record<string, unknown>;
    code = String(rc['callBackJs'] ?? '').trim();
  }
  if (!code) return reply.code(400).send({ error: 'NO_UI_CODE' });
  if (code.length > 200_000) return reply.code(400).send({ error: 'UI_CODE_TOO_LONG' });
  try {
    return await hub.evalUiAction(sourceId, {
      code,
      ...(event ? { event } : {}),
      ...(b.bookUrl ? { bookUrl: String(b.bookUrl) } : {}),
      ...(b.bookName ? { bookName: String(b.bookName) } : {}),
      ...(b.chapterUrl ? { chapterUrl: String(b.chapterUrl) } : {}),
    });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(`[ui] 源 ${sourceIdentity(sourceId).name || '(无名)'} · UI 动作失败：${msg}`);
    return reply.code(502).send({ error: msg, source: sourceIdentity(sourceId) });
  }
});

/**
 * `#515` 渲染是否共享宿主浏览器（设置页开关；`#525` 10-23 起默认开）。
 * 返回 `enabled`（当前生效值）、`persisted`（落盘值，null = 未设置）、`env`（环境变量是否为 1）。
 */
app.get('/api/browser/context', async () => ({
  enabled: browserContextEnabled(),
  persisted: readBrowserCfg().context ?? null,
  env: process.env['YUEDU_BROWSER_CONTEXT'] === '1',
}));
app.put<{ Body: { enabled?: boolean } }>('/api/browser/context', async (req, reply) => {
  const v = req.body?.enabled;
  if (typeof v !== 'boolean') return reply.code(400).send({ error: 'ENABLED_BOOLEAN_REQUIRED' });
  writeBrowserCfg({ context: v });
  setBrowserContextMode(v);
  // 只对新会话生效（已在跑的会话不受影响，下次 TTL 回收后自然切换）
  console.log(`[yuedu] 渲染共享宿主：${v ? '开' : '关'}（设置已落盘，对新渲染会话生效）`);
  return { enabled: v };
});

/**
 * `#816` B5 **六类缓存治理 API**（设置页「缓存治理」入口）。
 *
 * - `GET /api/cache/stats`：六类分类账。服务端四类（封面/漫画/图片/本地书）带真实
 *   `items/bytes`；浏览器两类（目录/正文）返回 `items/bytes = null`，由设置页用
 *   IndexedDB 本地补齐（服务端读不到浏览器存储）。
 * - `PUT /api/cache/config`：改配额（补丁式，字段级 clamp），立即按新上限淘汰一次。
 * - `POST /api/cache/clear`：清一类或全部。
 *
 * 清理口径（用户要求「不要让用户误删阅读进度之类的数据」）：只删 `cache-store` 记账的
 * 缓存字节；**不碰** cookies、书架/收藏、阅读进度、本地书文件。浏览器两类由前端清
 * IndexedDB —— 本接口明确拒绝服务端清理，避免「以为清了其实没清」。
 */
app.get('/api/cache/stats', async () => cacheStore.stats());

app.put<{ Body: unknown }>('/api/cache/config', async (req) => {
  await cacheStore.updateConfig(req.body ?? {});
  return { ok: true, stats: await cacheStore.stats() };
});

app.post<{ Body: { category?: string } }>('/api/cache/clear', async (req, reply) => {
  const category = String(req.body?.category ?? '').trim();
  if (category === 'all') {
    const cleared = await cacheStore.clear('all');
    return { ok: true, category, cleared, stats: await cacheStore.stats() };
  }
  if (!(SERVER_CACHE_CATEGORIES as readonly string[]).includes(category)) {
    return reply.code(400).send({
      error: 'CACHE_CATEGORY_INVALID',
      detail: '服务端只能清 cover/manga/image/localbook；toc/content 存在浏览器 IndexedDB，请由设置页本地清理',
    });
  }
  const cleared = await cacheStore.clear(category as ServerCacheCategory);
  return { ok: true, category, cleared, stats: await cacheStore.stats() };
});

/**
 * **音频缓存**（P1，对齐上游 `AudioCacheManager`）。
 *
 * - `GET /api/audio`：本地已缓存音频**直出**，支持 Range → 206（拖进度必需）。
 *   未命中回 404 `AUDIO_NOT_CACHED`，前端据此回落到普通 `/api/proxy` 流式播放。
 * - `POST /api/audio/prefetch`：播放时后台整章落盘（策略 A：**首播不阻塞**）。
 *   默认 202 立即返回、后台下载；`wait:true` 时等下载完（自检/测试用）。
 * - `POST /api/audio/status`：目录云朵批量查询，按 `chapterUrl` 查真实文件；
 *   流式源（m3u8）返回 `unsupported`，前端提示「流式源不支持离线」。
 * - `GET /api/audio/stats` / `PUT /api/audio/config` / `POST /api/audio/clear`：
 *   设置页「缓存治理」的音频块（配额默认 2GB，超限只淘汰 stream，manual 永不自动删）。
 */

/** 单区段 Range 解析（`bytes=a-b` / `bytes=a-` / `bytes=-n`）；畸形返回 null */
function parseAudioRange(raw: string, total: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!m) return null;
  const a = m[1] ?? '';
  const b = m[2] ?? '';
  if (!a && !b) return null;
  if (!a) {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(a);
  let end = b ? Number(b) : total - 1;
  if (!Number.isFinite(start) || start >= total) return null;
  if (!Number.isFinite(end) || end >= total) end = total - 1;
  if (end < start) return null;
  return { start, end };
}

app.get<{ Querystring: { bookUrl?: string; chapterUrl?: string; title?: string } }>(
  '/api/audio',
  async (req, reply) => {
    const bookUrl = String(req.query.bookUrl ?? '').trim();
    const chapterUrl = String(req.query.chapterUrl ?? '').trim();
    const title = String(req.query.title ?? '');
    if (!bookUrl || (!chapterUrl && !title)) {
      return reply.code(400).send({ error: 'BAD_QUERY', detail: 'bookUrl 与 chapterUrl（或 title）必填' });
    }
    const hit = await audioCache.locate(bookUrl, chapterUrl, title);
    if (!hit) return reply.code(404).send({ error: 'AUDIO_NOT_CACHED' });
    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', hit.mime || 'application/octet-stream');
    // 本地文件可能被清理/替换，播放器必须每次回源校验（不要被 304 缓存住）
    reply.header('cache-control', 'no-cache');
    const rangeRaw = typeof req.headers.range === 'string' ? req.headers.range : '';
    if (!rangeRaw) {
      reply.header('content-length', String(hit.bytes));
      return reply.send(fs.createReadStream(hit.path));
    }
    const range = parseAudioRange(rangeRaw, hit.bytes);
    if (!range) {
      return reply.code(416).header('content-range', `bytes */${hit.bytes}`).send();
    }
    reply.code(206);
    reply.header('content-range', `bytes ${range.start}-${range.end}/${hit.bytes}`);
    reply.header('content-length', String(range.end - range.start + 1));
    return reply.send(fs.createReadStream(hit.path, { start: range.start, end: range.end }));
  },
);

app.post<{
  Body: {
    bookUrl?: string;
    chapters?: Array<{ chapterUrl?: string; title?: string }>;
  };
}>('/api/audio/status', async (req) => {
  const bookUrl = String(req.body?.bookUrl ?? '').trim();
  const chapters = Array.isArray(req.body?.chapters) ? req.body!.chapters! : [];
  if (!bookUrl) return { cached: [], unsupported: [] };
  return audioCache.status(bookUrl, chapters);
});

/**
 * **音频离线任务**（P1.5 手动下载 / P1 自动预取的统一记账）。
 *
 * - 任务只存内存：`queued / running / done / error / cancelled / unsupported`；
 *   关闭界面后任务仍在服务端跑，重新打开播放列表按 `bookUrl` 拉回状态（不会假装下完）。
 * - 并发上限 3：整本下载不会一次打出几百个上游请求。
 * - `mode:'manual'` 的任务在落盘时写 manual，**永不参与配额自动淘汰**。
 */
type AudioJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'unsupported';

interface AudioJob {
  id: string;
  sid: string;
  bookUrl: string;
  chapterUrl: string;
  title: string;
  mode: 'stream' | 'manual';
  status: AudioJobStatus;
  bytes: number;
  totalBytes: number;
  error?: string;
  quotaOver?: boolean;
  startedAt: number;
  updatedAt: number;
  controller: AbortController;
}

const AUDIO_MAX_CONCURRENT = 3;
const AUDIO_JOB_TTL_MS = 10 * 60_000;
const audioJobs = new Map<string, AudioJob>();
let audioActiveDownloads = 0;
interface AudioSlotWaiter {
  run: () => void;
  cancelled: boolean;
}
const audioSlotQueue: AudioSlotWaiter[] = [];

function pumpAudioSlots(): void {
  while (audioActiveDownloads < AUDIO_MAX_CONCURRENT && audioSlotQueue.length) {
    const w = audioSlotQueue.shift()!;
    if (w.cancelled) continue;
    audioActiveDownloads += 1;
    w.run();
  }
}

function acquireAudioSlot(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('AUDIO_CANCELLED'), { code: 'CANCELLED' }));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      waiter.cancelled = true;
      const i = audioSlotQueue.indexOf(waiter);
      if (i >= 0) audioSlotQueue.splice(i, 1);
      reject(Object.assign(new Error('AUDIO_CANCELLED'), { code: 'CANCELLED' }));
    };
    const waiter: AudioSlotWaiter = {
      run: () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      cancelled: false,
    };
    signal.addEventListener('abort', onAbort, { once: true });
    audioSlotQueue.push(waiter);
    pumpAudioSlots();
  });
}

function releaseAudioSlot(): void {
  if (audioActiveDownloads > 0) audioActiveDownloads -= 1;
  pumpAudioSlots();
}

function audioJobKeyOf(bookUrl: string, chapterUrl: string, chapterTitle?: string): string {
  return `${audioBookKey(bookUrl)}:${audioChapterKey(chapterUrl, chapterTitle)}`;
}

function audioJobPublic(j: AudioJob): Record<string, unknown> {
  return {
    id: j.id,
    bookUrl: j.bookUrl,
    chapterUrl: j.chapterUrl,
    title: j.title,
    mode: j.mode,
    status: j.status,
    bytes: j.bytes,
    totalBytes: j.totalBytes,
    ...(j.error ? { error: j.error } : {}),
    ...(j.quotaOver ? { quotaOver: true } : {}),
    startedAt: j.startedAt,
    updatedAt: j.updatedAt,
  };
}

/** 清掉过期终态任务，并把总条数压到 1000 以内（长会话连续听几百章也不会无限涨） */
function pruneAudioJobs(): void {
  const now = Date.now();
  for (const [key, j] of audioJobs) {
    if (j.status !== 'queued' && j.status !== 'running' && now - j.updatedAt > AUDIO_JOB_TTL_MS) {
      audioJobs.delete(key);
    }
  }
  if (audioJobs.size <= 1000) return;
  const terminal = [...audioJobs.entries()]
    .filter(([, j]) => j.status !== 'queued' && j.status !== 'running')
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [key] of terminal.slice(0, audioJobs.size - 1000)) audioJobs.delete(key);
}

const AUDIO_URL_EXT_RE = /^https?:\/\/[^\s"'<>]+\.(m3u8|mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4)(\?|#|$)/i;

async function prefetchAudioChapter(
  body: {
    sid?: string;
    bookUrl?: string;
    bookTitle?: string;
    chapterUrl?: string;
    chapterTitle?: string;
    payload?: unknown;
    mode?: string;
  },
  job?: AudioJob,
): Promise<{ ok: boolean; cached: boolean; unsupported?: 'hls'; reason?: string; bytes?: number }> {
  const sid = String(body.sid ?? '').trim();
  const bookUrl = String(body.bookUrl ?? '').trim();
  const chapterUrl = String(body.chapterUrl ?? '').trim();
  const chapterTitle = String(body.chapterTitle ?? '');
  // 手动任务在排队期间可能被「升级」为 manual（自动预取任务点了下载按钮）⇒ 以任务为准
  const mode = job?.mode ?? (body.mode === 'manual' ? 'manual' : 'stream');
  if (!sid || !bookUrl || (!chapterUrl && !chapterTitle)) return { ok: false, cached: false, reason: 'BAD_BODY' };
  // 已缓存 ⇒ 不重复下载
  const hit = await audioCache.locate(bookUrl, chapterUrl, chapterTitle);
  if (hit) {
    if (job) {
      job.bytes = hit.bytes;
      job.totalBytes = hit.bytes;
    }
    return { ok: true, cached: true, bytes: hit.bytes };
  }
  // P1：m3u8 不落假缓存，只记标记（供目录提示）
  if (isStreamOnlyAudio(chapterUrl)) {
    await audioCache.markUnsupported(bookUrl, chapterUrl, chapterTitle);
    return { ok: true, cached: false, unsupported: 'hls' };
  }
  const payload = body.payload ?? (chapterUrl ? { chapterUrl, title: chapterTitle } : {});
  let media: { url?: string; format?: string; headers?: Record<string, string>; alternatives?: string[] } | undefined;
  let paragraphs: string[] = [];
  try {
    const r = (await hub.run('content', sid, { action: 'content', id: JSON.stringify(payload) }, undefined, {})) as
      | { media?: typeof media; paragraphs?: string[] }
      | null;
    media = r?.media;
    paragraphs = Array.isArray(r?.paragraphs) ? r!.paragraphs! : [];
  } catch (e) {
    return { ok: false, cached: false, reason: `RESOLVE_FAILED:${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
  }
  const format = String(media?.format ?? '');
  if (isStreamOnlyAudio(chapterUrl, format) || (media?.url && isStreamOnlyAudio(media.url, format))) {
    await audioCache.markUnsupported(bookUrl, chapterUrl, chapterTitle);
    return { ok: true, cached: false, unsupported: 'hls' };
  }
  const rawUrls: string[] = [];
  if (media?.url) rawUrls.push(media.url);
  for (const a of media?.alternatives ?? []) if (a) rawUrls.push(a);
  if (!rawUrls.length) {
    for (const p of paragraphs) if (AUDIO_URL_EXT_RE.test(String(p))) rawUrls.push(String(p));
  }
  const url = rawUrls.find((u) => /^https?:\/\//i.test(u) && !isStreamOnlyAudio(u, format));
  if (!url) return { ok: false, cached: false, reason: 'NO_MEDIA_URL' };

  const srcHeaders = await sourceProxyHeaders(sid);
  const mediaHeaders = media?.headers ?? {};
  const headers: Record<string, string> = {
    'User-Agent': PROXY_UA_MOBILE,
    Accept: '*/*',
    ...srcHeaders,
    ...mediaHeaders,
  };
  /**
   * Referer 不在发请求前写死：走**和 `/api/proxy` 同一条阶梯**（`refererChain` +
   * `REFERER_RETRY_STATUS`/`isRateLimited`，唯一实现见 proxy-referer/proxy-status）。
   * 真实反例（2026-11-16）：书音M 的 aikeu 直链带源站 Referer → 403，带资源自身
   * origin → 200；预取此前只写源站 Referer 且不重试，结果「能播不能离线」。
   */
  const pickReferer = (h: Record<string, string>): string =>
    Object.entries(h).find(([k]) => k.toLowerCase() === 'referer')?.[1] ?? '';
  const declaredRef = pickReferer(mediaHeaders) || pickReferer(srcHeaders);
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === 'referer') delete headers[k];
  }
  const srcRaw = hub.sources.get(sid)?.raw as Record<string, unknown> | undefined;
  const srcSite = originOf((srcRaw?.['bookSourceUrl'] ?? srcRaw?.['sourceUrl']) as string | undefined);
  const refChain = refererChain({ headerRef: declaredRef, srcSite, assetOrigin: originOf(url) });
  let res: Awaited<ReturnType<typeof proxyHttp.request>> | undefined;
  let lastRef = '';
  try {
    for (let attemptRef = 0; attemptRef < refChain.length; attemptRef++) {
      const attemptHeaders: Record<string, string> = { ...headers };
      const ref = refChain[attemptRef] ?? '';
      lastRef = ref;
      if (ref && /^https?:\/\//i.test(ref)) attemptHeaders['Referer'] = ref;
      res = await proxyHttp.request(url, {
        headers: attemptHeaders,
        responseType: 'stream',
        timeout: 60_000,
        ...(job ? { signal: job.controller.signal } : {}),
        ...(sourceAllowsInsecureTls(sid) ? { allowInsecureTls: true } : {}),
      });
      if (res.status < 400 || attemptRef >= refChain.length - 1) break;
      // 判据与 `/api/proxy` 完全一致：只有防盗链类 4xx 才升级；限流/5xx 换 Referer 无用
      if (!REFERER_RETRY_STATUS.has(res.status)) break;
      if (isRateLimited(res.status, res.headers)) break;
      console.warn(
        `[audio-cache] 上游 ${res.status}，换 Referer 重试：${ref || '(无)'} → ${refChain[attemptRef + 1] || '(无)'}` +
          `（sid=${sid} · 档 ${attemptRef + 1}/${refChain.length}）`,
      );
      try {
        await res.stream?.cancel();
      } catch {
        /* 已取消/已结束 */
      }
    }
    /**
     * `#367` **桌面 UA 补发**（与 `/api/proxy` 同一条兜底，判据同 `UA_RETRY_STATUS`）。
     *
     * 真实反例（2026-11-25 · AUD-1 荔枝有声）：同一时刻、同一 URL、同一套 Referer 阶梯，
     * `/api/proxy` 200/206 而预取 403 —— 差别只在代理还有这一步「手机 UA 被 WAF 拒 ⇒ 换桌面 UA
     * 补一发」，预取没有。直连实测：该 CDN 手机 UA → 403、桌面 UA → 200（与 Referer 无关），
     * 即「能播不能离线」的根因就是这条 UA 阶梯缺失，不是源站防盗链。
     *
     * 只补一次、只在 Referer 阶梯跑完仍被拒、且 UA 仍是本代理默认手机 UA（源自己配了 UA 就不动）时；
     * 限流排除口径同代理（限额按 IP 记，换 UA 无用，只会多扣一次额度）。
     */
    if (
      res &&
      UA_RETRY_STATUS.has(res.status) &&
      !isRateLimited(res.status, res.headers) &&
      headers['User-Agent'] === PROXY_UA_MOBILE
    ) {
      try {
        await res.stream?.cancel();
      } catch {
        /* 已取消/已结束 */
      }
      const retryHeaders: Record<string, string> = { ...headers, 'User-Agent': PROXY_UA_DESKTOP };
      if (lastRef && /^https?:\/\//i.test(lastRef)) retryHeaders['Referer'] = lastRef;
      console.warn(
        `[audio-cache] 上游 ${res.status}，换桌面 UA 补发（sid=${sid} · Referer=${lastRef || '(无)'}）`,
      );
      res = await proxyHttp.request(url, {
        headers: retryHeaders,
        responseType: 'stream',
        timeout: 60_000,
        ...(job ? { signal: job.controller.signal } : {}),
        ...(sourceAllowsInsecureTls(sid) ? { allowInsecureTls: true } : {}),
      });
    }
  } catch (e) {
    return { ok: false, cached: false, reason: `FETCH_FAILED:${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
  }
  if (!res) return { ok: false, cached: false, reason: 'FETCH_FAILED:NO_RESPONSE' };
  if (res.status >= 400 || !res.stream) {
    try {
      await res.stream?.cancel();
    } catch {
      /* 已取消/已结束 */
    }
    return { ok: false, cached: false, reason: `UPSTREAM_${res.status}` };
  }
  const mime = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime.startsWith('text/') || mime.includes('html')) {
    try {
      await res.stream.cancel();
    } catch {
      /* 已结束 */
    }
    return { ok: false, cached: false, reason: `NOT_MEDIA:${mime}` };
  }
  const finalUrl = String(res.url || url);
  if (isStreamOnlyAudio(finalUrl, format)) {
    try {
      await res.stream.cancel();
    } catch {
      /* 已结束 */
    }
    await audioCache.markUnsupported(bookUrl, chapterUrl, chapterTitle);
    return { ok: true, cached: false, unsupported: 'hls' };
  }
  const ext = audioExtOf(mime, finalUrl);
  const totalHeader = Number(res.headers['content-length']);
  if (job) {
    job.totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0;
    job.updatedAt = Date.now();
  }
  const saved = await audioCache.saveFromStream({
    bookUrl,
    bookTitle: body.bookTitle,
    chapterUrl,
    chapterTitle,
    mime: mime || `audio/${ext === 'mp3' ? 'mpeg' : ext}`,
    ext,
    mode,
    signal: job?.controller.signal,
    onProgress: (bytes) => {
      if (!job) return;
      job.bytes = bytes;
      job.updatedAt = Date.now();
    },
    // undici 的 web ReadableStream → Node 流（与 `/api/proxy` 的媒体分支同一转换）
    stream: Readable.fromWeb(res.stream as Parameters<typeof Readable.fromWeb>[0]),
  });
  if (!saved.saved) return { ok: false, cached: false, reason: saved.reason ?? 'SAVE_FAILED', bytes: saved.bytes };
  if (job && mode === 'manual') {
    // 手动内容不计入自动淘汰：如实告诉用户「已超配额但不会被删」
    const st = await audioCache.stats();
    job.quotaOver = st.maxBytes > 0 && st.bytes > st.maxBytes;
  }
  return { ok: true, cached: true, bytes: saved.bytes };
}

async function runAudioJob(
  body: {
    sid?: string;
    bookUrl?: string;
    bookTitle?: string;
    chapterUrl?: string;
    chapterTitle?: string;
    payload?: unknown;
    mode?: string;
  },
  job: AudioJob,
): Promise<void> {
  let acquired = false;
  try {
    await acquireAudioSlot(job.controller.signal);
    acquired = true;
    if (job.controller.signal.aborted) throw Object.assign(new Error('AUDIO_CANCELLED'), { code: 'CANCELLED' });
    job.status = 'running';
    job.updatedAt = Date.now();
    const r = await prefetchAudioChapter(body, job);
    if (job.controller.signal.aborted) {
      job.status = 'cancelled';
      job.error = '已取消';
    } else if (r.unsupported) {
      job.status = 'unsupported';
      job.error = '流式源不支持离线';
    } else if (r.ok) {
      job.status = 'done';
      if (r.bytes !== undefined) {
        job.bytes = r.bytes;
        job.totalBytes = r.bytes;
      }
    } else {
      job.status = 'error';
      job.error = r.reason || '下载失败';
    }
  } catch (e) {
    const aborted = job.controller.signal.aborted || (e as { code?: string }).code === 'CANCELLED';
    job.status = aborted ? 'cancelled' : 'error';
    job.error = aborted ? '已取消' : String(e instanceof Error ? e.message : e).slice(0, 200);
  } finally {
    job.updatedAt = Date.now();
    // 只落失败/取消（成功由磁盘文件与云朵证明，不重复记账）；重启后仍能查到原因
    if (job.status === 'error' || job.status === 'cancelled') audioJobHistory.record(job);
    if (acquired) releaseAudioSlot();
  }
}

app.post<{
  Body: {
    sid?: string;
    bookUrl?: string;
    bookTitle?: string;
    chapterUrl?: string;
    chapterTitle?: string;
    payload?: unknown;
    mode?: string;
    wait?: boolean;
  };
}>('/api/audio/prefetch', async (req, reply) => {
  const body = req.body ?? {};
  const mode: 'stream' | 'manual' = body.mode === 'manual' ? 'manual' : 'stream';
  const bookUrl = String(body.bookUrl ?? '').trim();
  const chapterUrl = String(body.chapterUrl ?? '').trim();
  const chapterTitle = String(body.chapterTitle ?? '');
  if (String(body.wait) === 'true' || body.wait === true) {
    return prefetchAudioChapter(body);
  }
  // 手动下载：先在主线程给出「已缓存 / 流式源」的立即结论，UI 不用等任务跑完
  if (mode === 'manual' && bookUrl && (chapterUrl || chapterTitle)) {
    const hit = await audioCache.locate(bookUrl, chapterUrl, chapterTitle);
    if (hit) return { ok: true, cached: true, bytes: hit.bytes };
    if (isStreamOnlyAudio(chapterUrl)) {
      await audioCache.markUnsupported(bookUrl, chapterUrl, chapterTitle);
      return { ok: true, unsupported: 'hls' };
    }
  }
  if (!bookUrl || (!chapterUrl && !chapterTitle)) {
    return reply.code(400).send({ ok: false, error: 'BAD_BODY' });
  }
  const key = audioJobKeyOf(bookUrl, chapterUrl, chapterTitle);
  const existing = audioJobs.get(key);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    // 自动预取在跑时用户点了「离线到本机」⇒ 升级为 manual（永不自动淘汰）
    if (mode === 'manual') existing.mode = 'manual';
    return reply.code(202).send({ ok: true, queued: true, deduped: true, jobId: key, mode: existing.mode });
  }
  const job: AudioJob = {
    id: key,
    sid: String(body.sid ?? '').trim(),
    bookUrl,
    chapterUrl,
    title: chapterTitle,
    mode,
    status: 'queued',
    bytes: 0,
    totalBytes: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    controller: new AbortController(),
  };
  audioJobs.set(key, job);
  pruneAudioJobs();
  void runAudioJob({ ...body, mode }, job);
  return reply.code(202).send({ ok: true, queued: true, jobId: key, mode });
});

/** 任务状态（关闭界面后重新打开播放列表靠它恢复「还在下 / 已下完 / 失败原因」） */
app.get<{ Querystring: { bookUrl?: string } }>('/api/audio/jobs', async (req) => {
  pruneAudioJobs();
  const bookUrl = String(req.query.bookUrl ?? '').trim();
  return {
    jobs: [...audioJobs.values()]
      .filter((j) => !bookUrl || j.bookUrl === bookUrl)
      .map(audioJobPublic),
  };
});

/**
 * **任务历史**（B2 方案 2）：只记失败 / 取消，按时间倒序。
 * 与 `/api/audio/jobs` 分开是刻意的：内存任务表反映「正在下/本次会话」，
 * 历史反映「上次为什么没下下来」，混在一起会让重启后的列表被旧失败占满。
 */
app.get<{ Querystring: { bookUrl?: string; limit?: string } }>('/api/audio/jobs/history', async (req) => {
  const bookUrl = String(req.query.bookUrl ?? '').trim();
  const limit = Number(req.query.limit);
  return {
    jobs: audioJobHistory.list({
      ...(bookUrl ? { bookUrl } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.floor(limit) } : {}),
    }),
    max: AUDIO_JOB_HISTORY_MAX,
    ttlMs: AUDIO_JOB_HISTORY_TTL_MS,
  };
});

app.post<{ Body: { bookUrl?: string; chapterUrl?: string; chapterTitle?: string } }>(
  '/api/audio/cancel',
  async (req) => {
    const bookUrl = String(req.body?.bookUrl ?? '').trim();
    const chapterUrl = String(req.body?.chapterUrl ?? '').trim();
    const chapterTitle = String(req.body?.chapterTitle ?? '');
    if (!bookUrl || (!chapterUrl && !chapterTitle)) return { ok: false, cancelled: false, error: 'BAD_BODY' };
    const job = audioJobs.get(audioJobKeyOf(bookUrl, chapterUrl, chapterTitle));
    if (!job || (job.status !== 'queued' && job.status !== 'running')) {
      return { ok: true, cancelled: false, status: job?.status ?? 'missing' };
    }
    job.controller.abort();
    job.status = 'cancelled';
    job.error = '已取消';
    job.updatedAt = Date.now();
    return { ok: true, cancelled: true };
  },
);

app.get('/api/audio/stats', async () => audioCache.stats());

/**
 * P2：清理残留（进程中断的 `.tmp-*`、空书目录、空索引项）。
 * 已记账的音频文件一个都不动 —— 与 `clear` 区分开，避免用户误以为会删缓存。
 */
app.post('/api/audio/prune', async () => {
  const pruned = await audioCache.prune();
  return { ok: true, pruned, stats: await audioCache.stats() };
});

/**
 * P2：无主缓存**预览**（只读）。
 * 无主 = 目录里有缓存、但对应书已不在书架；用户拍板要「先给清单再确认」，
 * 且清理范围包含 `mode:'manual'`。这里绝不删东西，只回报清单与合计。
 */
app.post('/api/audio/orphans', async (_req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const books = await store.listBooks();
  const scan = await audioCache.listOrphans(makeShelfMatcher(books.map((b) => b.bookUrl)));
  const totals = scan.orphans.reduce(
    (acc, o) => ({
      books: acc.books + 1,
      items: acc.items + o.items,
      bytes: acc.bytes + o.bytes,
      manualItems: acc.manualItems + o.manualItems,
      manualBytes: acc.manualBytes + o.manualBytes,
    }),
    { books: 0, items: 0, bytes: 0, manualItems: 0, manualBytes: 0 },
  );
  return { orphans: scan.orphans, totals, unattributed: scan.unattributed };
});

/**
 * P2：确认后删除无主缓存（**含 manual**，与配额淘汰的「只删 stream」是两套语义）。
 * 双重校验：拿客户端回传的 bookKeys 去重新算一次无主集合，
 * 确认后又被加回书架的书（或 key 不存在）一律跳过，避免误删。
 */
app.post<{ Body: { bookKeys?: string[] } }>('/api/audio/purge-orphans', async (req, reply) => {
  const store = await userStoreOr503(reply);
  if (!store) return;
  const keys = Array.isArray(req.body?.bookKeys) ? req.body.bookKeys.filter((k) => typeof k === 'string') : [];
  if (!keys.length) return reply.code(400).send({ error: 'BAD_BODY' });
  const books = await store.listBooks();
  const scan = await audioCache.listOrphans(makeShelfMatcher(books.map((b) => b.bookUrl)));
  const allowed = new Set(scan.orphans.map((o) => o.bookKey));
  const target = keys.filter((k) => allowed.has(k));
  const cleared = await audioCache.removeBooks(target);
  return {
    ok: true,
    cleared,
    skipped: keys.length - target.length,
    stats: await audioCache.stats(),
  };
});

app.put<{ Body: { maxBytes?: unknown } }>('/api/audio/config', async (req) => {
  await audioCache.updateConfig(req.body ?? {});
  return { ok: true, stats: await audioCache.stats() };
});

app.post<{ Body: { bookUrl?: string; bookKey?: string } }>('/api/audio/clear', async (req) => {
  const bookUrl = String(req.body?.bookUrl ?? '').trim();
  const bookKey = String(req.body?.bookKey ?? '').trim();
  const byKey = /^[0-9a-f]{16}$/i.test(bookKey);
  // 清理前先停掉这本书在跑的任务，避免清完又被写回来（按 bookKey 精确删时无法对应任务，跳过）
  if (!byKey) {
    for (const [key, job] of audioJobs) {
      if (bookUrl && job.bookUrl !== bookUrl) continue;
      if (job.status === 'queued' || job.status === 'running') {
        try {
          job.controller.abort();
        } catch {
          /* 已完成 */
        }
      }
      audioJobs.delete(key);
    }
  }
  // 按 bookKey 精确删：索引重建后 `bookUrl` 为空的条目只能走这条路（按 URL 会误清全盘）
  const cleared = byKey ? await audioCache.removeBooks([bookKey]) : await audioCache.clear(bookUrl || undefined);
  return { ok: true, cleared, stats: await audioCache.stats() };
});

/**
 * `#568` **P3 站点定制配置 API**（本地独立配置，按域名）。
 *
 * 语义要点：
 *  · `GET` 不带 `url` = 设置页列表；带 `url` = 阅读器打开某页时**一次拿到命中规则**
 *    （前端不必自己拉全表再匹配 —— 匹配口径只在 core 一份）。
 *  · `PUT` 空内容 = **删除**（UI「清空并保存」与「恢复默认」同义，见 store 注释）。
 *  · 写入成功后**无需重启**：阅读壳每次打开页面都读这份表。
 */
app.get<{ Querystring: { url?: string } }>('/api/site-customize', async (req) => {
  const url = String(req.query?.url ?? '').trim();
  return {
    items: siteCustomizeStore.list(),
    ...(url ? { match: siteCustomizeStore.match(url) } : {}),
  };
});
app.put<{ Body: Partial<SiteCustomize> }>('/api/site-customize', async (req, reply) => {
  const r = siteCustomizeStore.upsert(req.body ?? {});
  if (!r.ok) return reply.code(400).send({ error: r.error });
  console.log(`[yuedu] 站点定制已保存：${String(req.body?.host ?? '')}${r.item ? '' : '（空 ⇒ 已删除）'}`);
  return { ok: true, item: r.item };
});
app.delete<{ Querystring: { host?: string } }>('/api/site-customize', async (req) => {
  const ok = siteCustomizeStore.remove(req.query?.host);
  return { ok };
});

// `#820` B2 第一批：HTTP TTS 路由（`/api/tts/*`）。UI（设置项/播放按钮）留给后续会话。
// 复用 `proxyHttp`（同一个加固 HttpClient：超时/体积/重定向护栏都在这一层）。
registerTtsRoutes(app, {
  store: ttsStore,
  service: createTtsService({
    store: ttsStore,
    http: proxyHttp,
    // `#873` 引擎级 Cookie 罐（`enabledCookieJar` 才读写；落在 DATA_DIR 下）
    cookieFile: path.join(DATA_DIR, 'tts-cookies.json'),
  }),
});

/**
 * `#512` **详情分阶段（SSE）**：`info` 事件先到（书籍信息，无目录），`done` 带完整结果。

 *
 * 用户建议：目录解析最耗时，详情拿到了就该渲染。`engine.detail` 在 info 求值完、
 * 目录开始前回调 `ctx.onPartial` ⇒ 这里立刻推一帧，前端先渲染详情头部，目录随后补齐。
 *
 * 失败语义：`error` 事件带上 `code/message/detail`（与 `/api/run` 的错误形状一致）；
 * 前端收到任何异常都会回退普通 `/api/run`（保留验证重试等既有语义）。
 */
app.post<{ Body: { sourceId: string; action?: string; id?: string } }>('/api/run/stream', async (req, reply) => {
  const { sourceId, action, id } = req.body ?? ({} as { sourceId?: string; action?: string; id?: string });
  if (!sourceId || action !== 'detail' || !id) return reply.code(400).send({ error: 'BAD_BODY' });
  const res = reply.raw;
  reply.hijack();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const t0 = Date.now();
  /**
   * `#512` **逐帧立即送达，但绝不能调 `flushHeaders()`**（实测踩坑，值得记住）：
   *
   *  · 只 `write` 不处理 ⇒ info 帧被攒到下一次写才发（客户端 1.84s 才收到 350ms 就产生的 info）；
   *  · 加 `flushHeaders()` ⇒ info 立刻到达，**但客户端随后判定 body 结束**：chunked 编码下
   *    `flushHeaders()` 会先写一个 **0 长度 chunk**，而 `0

` 正是「chunked 结束」的信号
   *    ⇒ 客户端读完 info 就 EOF，后面的 done 永远收不到（curl 与 undici 表现一致）。
   *  · 正解 = `setNoDelay(true)`（关 Nagle，小帧不再等合并）+ `write` + `uncork`。
   */
  res.socket?.setNoDelay?.(true);
  if (process.env['YUEDU_SSE_DEBUG']) {
    res.on('close', () => console.log(`[sse] +${Date.now() - t0}ms close ended=${res.writableEnded}`));
    res.on('finish', () => console.log(`[sse] +${Date.now() - t0}ms finish`));
    res.on('error', (e) => console.log(`[sse] error ${String(e)}`));
  }
  const send = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    if (process.env['YUEDU_SSE_DEBUG']) console.log(`[sse] +${Date.now() - t0}ms ${event}`);
    // `#771`：`done` 帧一次带全量 1000+ 章 ⇒ `JSON.stringify` 是可疑边界
    probeEnter('sse:json');
    let frame = '';
    try {
      frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    } finally {
      probeLeave();
    }
    /**
     * ★ 末帧必须用 `end(frame)`：实测「write(done) 之后紧接 end()」在 Windows/Node 下
     * **会把最后一帧丢掉**（客户端只收到 info，服务端日志却打了 done）。`end(chunk)`
     * 把「写数据」与「关闭」合成一次调用，数据不会随连接关闭丢失。
     */
    if (event === 'done' || event === 'error') {
      probeEnter('sse:end');
      try {
        res.end(frame);
      } finally {
        probeLeave();
      }
      return;
    }
    /**
     * ★ **`cork()` 与 `uncork()` 必须配对**（`#512` 实测结论）：
     *  · 只 `write` ⇒ 帧被 Node 的 cork 缓冲攒着，要等下一次写/end 才发（info 从 374ms 拖到 1.8s）；
     *  · 单调 `uncork()`（未 cork）⇒ chunked 下会补一个 **0 长度块**，`0\r\n\r\n` 即「响应结束」
     *    ⇒ 客户端读完 info 就 EOF，done 永远收不到（curl / undici 表现一致）；
     *  · 配对 `cork→write→uncork` ⇒ 只冲这一个帧，不产生空块。
     */
    res.cork();
    probeEnter('sse:write');
    try {
      res.write(frame);
    } finally {
      probeLeave();
    }
    res.uncork();
  };
  const endTrack = trackStart(`src:${sourceId} detail(stream)`);
  /**
   * `#756` C：流式详情也是**交互**路径 —— 必须登记前台在飞。
   * 漏这条时 `#747` 的图片解密暂停不生效：受控实验里 40 张 300ms 同步解密图把
   * 流式详情从 0.9s 拖到 6.8~8.4s（用户「detail(stream) 8~9s」的观感就是这么来的）。
   */
  foregroundGate.enter();
  try {
    const out = await hub.run(
      'detail',
      sourceId,
      { action: 'detail', id },
      undefined,
      { onPartial: (d) => send('info', d) },
    );
    send('done', out);
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: unknown };
    send('error', { error: err.code ?? 'DETAIL_FAILED', message: err.message ?? String(e), detail: err.detail });
  } finally {
    foregroundGate.leave();
    endTrack();
    if (!res.writableEnded) res.end();
  }
});

// 多源聚合搜索（SSE 逐源流式返回）
app.post<{ Body: { keyword: string; kinds?: string[]; groups?: string[]; limit?: number; concurrency?: number; sourceIds?: string[]; page?: number } }>(
  '/api/aggregate/search',
  async (req, reply) => {
    // `#278` 补传 page：单源自动翻页（loadMoreForSource → fetchPages([sid], cursor+1)）
    // 一直在发 page，但本路由此前没透传 ⇒ 引擎恒搜第 1 页 ⇒ 单源「翻页」拉到的全是
    // 第 1 页的重复数据（135 条 ≈ 20 页 × 第 1 页），dedup 后聚合组数纹丝不动 —— 用户实测主根因
    const { keyword, kinds, groups, limit, concurrency, sourceIds, page } = req.body;
    if (!keyword) return reply.code(400).send({ error: 'KEYWORD_REQUIRED' });

    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    let closed = false;
    /**
     * `#292` **中止信号**：客户端断开（关弹窗 / 切页 / 网络重置）时 abort，
     * 让 `hub.aggregateSearch` **未开始**的源立刻不搜。
     *
     * 为什么只靠 `closed` 不够：`closed` 只挡住「往响应里写」，`for await` 里 `break`
     * 只是不再消费事件 —— worker 是 `void Promise.all(workers)` 独立起的循环，照旧把队列里
     * 剩下的源全跑完（用户实测：关掉浮层再点另一个源搜索会很卡，就是前一波还在占带宽）。
     */
    const ac = new AbortController();
    res.on('close', () => {
      closed = true;
      ac.abort();
    });
    const send = (ev: EngineEvent) => {
      if (!closed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    // `#462` 聚合搜索也登记在飞（它并发跑很多源，是「卡住时到底在忙什么」的关键现场）
    const endTrack = trackStart(`aggregate:${String(keyword).slice(0, 60)}`);
    res.on('close', endTrack);
    // `#756` C：聚合搜索是交互路径，图片解密在它跑的时候让路（否则结果解析被同步块挤慢）
    foregroundGate.enter();

    // `B6`：`dead` 且未过 3 天跳过期的源不参与搜索（不占首屏 limit 名额）
    const now = Date.now();
    const skipIds = hub
      .listSources({ enabled: true })
      .filter((s) => isSourceHealthDeadActive(sourceHealthStore.get(s.id), now))
      .map((s) => s.id);
    try {
      for await (const ev of hub.aggregateSearch(keyword, { kinds, groups, limit, concurrency, sourceIds, page, skipIds, signal: ac.signal })) {
        if (closed) break;
        send(ev);
      }
    } catch (e) {
      send({ type: 'trace', sourceId: '-', entry: { stage: 'parse', rule: String(e), at: Date.now() } });
    } finally {
      foregroundGate.leave();
      if (!closed) res.end();
    }
  },
);

// ---------------------------------------------------------------------------
// 静态资源（apps/web/dist）；缺失则回退一个最小可用页面，保证 API 可演示
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // ★ `#PDF-worker` `.mjs` 必须显式声明 JS 类型。缺了它 ⇒ `application/octet-stream`
  //   ⇒ 浏览器对 `import()` / `new Worker(..., {type:'module'})` 做严格 MIME 校验时会**直接拒绝**。
  //   实测症状：PDF 章节 canvas 恒 0，控制台只有一句
  //   「Setting up fake worker failed」（pdf.js 的 worker 加载失败后回落的提示），
  //   `pdf.worker.min-<hash>.mjs` 本身 `200` 但 content-type 是 octet-stream。
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // ★ `#249` 补齐位图格式。**此前只有 png/svg/ico** ⇒ 任何 `.jpg` 资源都被发成
  //   `application/octet-stream`，浏览器**拒绝渲染**（`img.src` 加载成功但不解码，
  //   `naturalWidth=0`）而且**控制台只有一句 MIME 警告**，极难定位 ——
  //   探针实测 14 张内置背景图全部 `200` 但 `content-type: application/octet-stream`。
  //   ⚠️ 别只补 jpg：webp/gif/avif 在 Web 端同样是常见格式，一并补上。
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  // `.wasm`：pdf.js 等库的可选 wasm 后端，类型错会被 `WebAssembly.instantiateStreaming` 拒载
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

app.get('/*', async (req, reply) => {
  // 每次请求重新探测（构建完成后无需重启即可切到正式 UI）
  const WEB_DIST = resolveWebDist();
  // `#323` 判例：index.html 必须 no-cache（否则浏览器启发式缓存旧 index ⇒ 引用旧 hash 资源 ⇒
  // 用户端整套前端停在旧版本）；带 hash 的 assets 才可 immutable 长缓存。判据唯一实现在 web-dist.ts。
  if (!WEB_DIST) return reply.type('text/html').header('cache-control', 'no-cache').send(FALLBACK_HTML);
  const rel = (req.params as { '*': string })['*'] || 'index.html';
  const file = path.join(WEB_DIST, rel);
  // 注意用 resolve 后比较：Windows 下 rel 会带反斜杠，直接 startsWith(WEB_DIST) 在相对/混合分隔符时恒 false
  if (!path.resolve(file).startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    const idx = path.join(WEB_DIST, 'index.html');
    if (fs.existsSync(idx)) return reply.type('text/html').header('cache-control', 'no-cache').send(fs.readFileSync(idx));
    return reply.type('text/html').header('cache-control', 'no-cache').send(FALLBACK_HTML);
  }
  return reply
    .type(MIME[path.extname(file)] ?? 'application/octet-stream')
    .header('cache-control', staticCacheControl(rel))
    .send(fs.readFileSync(file));
});

const FALLBACK_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>EngineHub · 最小演示页</title>
<style>body{font-family:system-ui;margin:40px;background:#0f172a;color:#e2e8f0}input{padding:8px;width:320px}.card{background:#1e293b;padding:12px;margin:8px 0;border-radius:8px}button{padding:8px 16px;cursor:pointer}</style>
</head><body>
<h2>EngineHub 聚合搜索（最小演示页）</h2>
<p>说明：apps/web 尚未构建时显示此回退页。正式 UI 在 <code>apps/web</code> 构建后自动替换。</p>
<input id="kw" placeholder="输入关键词" value="剑来" />
<button onclick="run()">聚合搜索</button>
<div id="out"></div>
<script>
async function run(){
  const kw=document.getElementById('kw').value;
  const out=document.getElementById('out'); out.innerHTML='<p>搜索中…</p>';
  const es=new EventSource('/api/aggregate/search?_='+Date.now());
  // EventSource 仅支持 GET，这里改用 fetch 流式读取
  const resp=await fetch('/api/aggregate/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keyword:kw,limit:8,concurrency:4})});
  const reader=resp.body.getReader(); const dec=new TextDecoder(); let buf='';
  while(true){const {done,value}=await reader.read(); if(done)break; buf+=dec.decode(value,{stream:true});
    let i; while((i=buf.indexOf('\\n\\n'))>=0){const line=buf.slice(0,i); buf=buf.slice(i+2);
      if(line.startsWith('data: ')){const ev=JSON.parse(line.slice(6));
        if(ev.type==='items'){ev.items.forEach(it=>{const d=document.createElement('div');d.className='card';d.textContent=it.kind+': '+it.title;out.appendChild(d);});}
      }}}
  const p=document.createElement('p'); p.textContent='—— 完成 ——'; out.appendChild(p);
}
</script></body></html>`;

/* `#477`：listen 段本身也纳入埋点 —— 端口绑定与 fastify 就绪之间的同步停摆
   （曾见「启动后第一次可读就 recover 70s」）以前没有任何动作可归因。 */
const endBootListen = trackStart('boot:listen');
app.listen({ port: PORT, host: '127.0.0.1' })
  .then(() => {
    endBootListen();
    console.log(`[yuedu] server listening on http://127.0.0.1:${PORT}`);
    writePidFile();
    /**
     * `#552` **源医生离线巡检**：listen 之后才排期（默认 30s 后首轮）。
     *
     * 为什么不在模块顶层就跑：巡检要遍历全源 + lint（实测 733 源 ≈ 247ms），
     * 与启动期的源加载/SQLite 打开挤在一起只会把首轮拖长；且 `hub` 必须已就绪。
     * 首轮**只建基线、不播报**（那几十个 error 源是存量，弹它等于念一遍存量），
     * 之后每 6h 一轮，只播「相对上一轮新增 / 恢复」的。`YUEDU_DOCTOR_PATROL=0` 关。
     */
    doctorPatrol.start();
    /**
     * `#754` **DOM worker 启动预热**（默认关）。
     *
     * 冷启动的 5.34s 主要花在「worker 线程启动 + jsdom 模块装载」；`YUEDU_DOM_WARMUP=N`
     * 在 listen 之后**后台**预热 N 个（上限池大小），用户第一次打开目录不再付这笔钱。
     * 失败只记日志（真实求值仍会懒起 worker，功能不受影响）。
     */
    void prewarmDomBackend()?.then((r) => {
      if (r) console.log(`[dom] 预热结果：${JSON.stringify(r)}`);
    });
  })
  .catch((e: unknown) => {
    endBootListen();
    throw e;
  });

/**
 * `#242` **PID 文件**（`data/server.pid`）—— 让「端口被占」这件事能被说清楚。
 *
 * ## 要解决的真实故障（2026-10-03 用户实测）
 * 用户「关掉了 cmd 窗口」，再双击 `start-server.bat` 被挡：
 * `[YueDu] Port 3000 is ALREADY in use.` 让他以为服务已经停了。
 * 实际占用者是一个**父进程已消失的孤儿**（实测 PID 23304，PPID 12816 已 GONE）——
 * 它是 `#225` 重启端点用 `detached: true` 拉起来的（见 restart 端点的注释：
 * 非 detached 的子进程会随父进程一起没，所以必须 detached）。
 * ⇒ **关 cmd 窗口关不掉它**（它本来就没有控制台），用户陷入「关了又占着」的僵局。
 *
 * 落 PID 文件后：`start-server.bat` 能说出「占用者是本项目的服务，PID=xxxx」，
 * 端点 `/api/system/shutdown` 也能由用户直接把它停掉 —— 不必再去找进程管理器。
 *
 * ## 为什么不能只靠端口号
 * 端口只能证明「有东西在听」，不能证明「那东西是我们自己起的」。
 * PID 文件里额外记 `port` / `argv` / `startedAt`，供脚本与端点核对，避免误杀别人的进程。
 */
const PID_FILE = path.join(DATA_DIR, 'server.pid');

function writePidFile(): void {
  try {
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: process.pid, port: PORT, argv: process.argv.slice(1), startedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (e) {
    // 写不了不能影响服务（顶多用户仍然只能用老办法停它）
    console.warn('[yuedu] 写 PID 文件失败：', e instanceof Error ? e.message : String(e));
  }
}

/** 清 PID 文件 —— 只在**文件里记的确实是自己**时才删（别把别人的记录抹掉） */
function clearPidFile(): void {
  try {
    if (!fs.existsSync(PID_FILE)) return;
    const rec = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')) as { pid?: number };
    if (rec.pid !== process.pid) return;
    fs.unlinkSync(PID_FILE);
  } catch {
    /* 清不掉不影响退出 */
  }
}

// 进程级容错：未捕获的异步异常只记日志，不让整个服务退出（桌面/浏览器都会因此黑屏）
//
// ⚠️ 这里**刻意不关**交互式登录窗口：用户很可能正在窗口里做安全验证（扫码/短信/点选），
// 开发期一次服务重启就把窗口收掉等于把用户的输入毁掉。profile 是持久的，
// 重启后 `ensureSession` 会按 `DevToolsActivePort` **重新接管**同一只浏览器，窗口与登录态继续可用
// （这正是「页面还没操作完就被关掉」那条反馈的根因之一）。
for (const sig of ['SIGINT', 'SIGTERM', 'exit'] as const) {
  process.on(sig, () => {
    /**
     * `#757` E：**KV 的异步写队列必须先 flush** —— 否则 300ms 防抖窗口内/写线程在飞的
     * 源变量、登录信息、章节缓存会在「保存后立刻重启」时丢掉（与 `#507` 源覆盖层同一条纪律）。
     * `flushSync()` 把最终快照排到写线程队尾并等它落完（FIFO ⇒ 文件最终态 = 此刻内存态）。
     */
    try { kvStore.flushSync(); } catch (e) { console.error('[yuedu] KV flushSync 失败：', e); }
    // 关库：SQLite 实现的 close() 体内全是同步操作（checkpoint + db.close()），
    // 所以在 'exit' 事件里调用也能跑完；JSON 实现同理（flush 索引）。
    // `#507`：源覆盖层是**异步落盘**（`#478` 为治 3.3s 阻塞改的）⇒ 退出前必须同步补一次，
    // 否则「保存后立刻重启」会丢掉导入/编辑（用户实测：v3.9.61 导入后重启即消失）。
    try { sourceLayer.flushSync(); } catch (e) { console.error('[yuedu] 源库 flushSync 失败：', e); }
    if (userStoreRef) void userStoreRef.close();
    blobStore.close();
    // `#242`：顺手清掉自己的 PID 文件（重启端点 spawn 出来的那个进程退出时，
    // 不清会让下次 `start-server.bat` 拿到一个已经不存在的 PID，误判「没人占用」）。
    clearPidFile();
  });
}
// `#210`：此前只有 console——窗口一关证据就没了，桌面端更没有控制台。
// 双路：console 照旧（开发时看得见）+ recordCrash（ring + data/logs/crash-*.log）。
// ★ 保持「不退出」的原行为：Fastify 服务偶发空指针就退出，比留着它更伤（用户正在看书）。
process.on('unhandledRejection', (r) => {
  console.error('[yuedu] unhandledRejection:', r);
  recordCrash('unhandledRejection', r, CRASH_LOG_DIR);
});
process.on('uncaughtException', (e) => {
  console.error('[yuedu] uncaughtException:', e);
  recordCrash('uncaughtException', e, CRASH_LOG_DIR);
});
