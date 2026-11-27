/**
 * ⚠️ **必须在所有 import 之前**：core 的 package.json 入口指向 `./src/index.ts`（各消费包直接
 * 编译本包源码），而 `jpeg-js` / `pngjs` 这类**无类型声明**的依赖需要在编译期可见 ——
 * triple-slash reference 会随入口文件被加载，消费者（engine-legado / facade / apps/server…）
 * 无需各自再 include 一遍。
 */
/// <reference path="../typings/vendor-shims.d.ts" />
export * from './contract/types';
export * from './contract/error';
export * from './contract/engine';
export * from './contract/user-data';
export * from './contract/login-v2';
export * from './diag/block-stats';
export * from './diag/freeze-probe'; // `#771` 冻结定向探针（默认关；YUEDU_FREEZE_PROBE=1 开）
export * from './diag/l1-stats'; // `#749` D2：l1w 路由/丢绑定/超时/curl 回退计数（/api/diag）
export * from './diag/rule-lint'; // #542 规则 lint 表（源医生/工坊共用）
export * from './diag/diagnose'; // #550 失败归因表（调试诊断卡）
export * from './diag/probe'; // #551 单字段试跑 + 选择器探针（复用引擎同一份 AnalyzeRule）
export * from './diag/url-probe'; // #555 试跑前置判定：URL 模板 / 登录界面静态解析（纯函数，无网络）
export * from './diag/patrol'; // #552 离线巡检的汇总与差分（判据复用 #542 lint + 引擎 validate）
export * from './diag/explore-probe'; // #556 发现规则探针：形态判定 / 真跑分类表 / 语法自动纠正
// `#561`/`#562` 自取数占位 + 挑战页判定（isSelfFetchingRule 随 explore-probe 的 star 出）
export { isChallengePage, SELF_FETCH_PLACEHOLDER } from './diag/self-fetch';
export * from './diag/login-ui-check'; // #557 loginUi 规则校验（JSON v1/v2/脚本/HTML + 预期排版 + action 定义）
export * from './diag/material-chain'; // #558 试跑物料取页链（详情←发现/搜索，目录←详情，正文←目录）
export * from './diag/material-format'; // #558 物料格式化（json 重排缩进 / html 断行且跳过 script/pre）
export { createTraceSink } from './trace';
export type { TraceEntry, TraceSink, TraceTimer } from './trace';
export { EngineRegistry, registry } from './registry';
export { createVariableStore, createMemoryKeyValueStore, createFileKeyValueStore } from './store';
export type { FileKeyValueStore, FileKeyValueStoreOptions, StoreWriteStats } from './store';
export { parseJsonLoose, parseJsonLooseObject } from './json-loose';
// `#457`「响应体像不像 HTML 文档」的唯一判据（`/api/proxy` 的文档补丁与 web 取页共用）
export { looksLikeHtmlDocument } from './net/doc-shape';
// `#208` 源分享口令（encode/decode 纯函数，零 import —— Web/服务端两端共用）
export * from './source-share-passphrase';
// `#625` URL → 书源识别（`bookUrlPattern` 三级反查，pure；服务端/前端/引擎共用同一份判定）
export * from './source-match';
// `#620` 导出 txt/epub（上游 `ExportBookService` + `ExportContentSanitizer` 的移植，浏览器安全）
export * from './export';
// `#614` 字体反爬（上游 `analyzeRule/QueryTTF.java` 的移植：字形轮廓串 ⇄ Unicode）
export * from './font';
// `#208` 直链上传：规则模型 + 校验 + 内置规则表（纯函数；真正的上传动作在 facade）
export * from './direct-link-upload';
// `#208` WebDAV 同步：地址/认证/文件名的纯逻辑；阅读进度的远端形态与「只前进不后退」合并规则
export * from './webdav';
export * from './book-progress';
export * from './user-store';
// `#651` 源库存储：运行时**唯一**的源存储（SQLite，对齐上游 `book_sources` 表）
export * from './source-store';
/**
 * `#314`：`loginUrl` 形态识别（上游 `BaseSource.getLoginJs()`，书源/订阅源**共用**一条判据）
 * 与源登录信息族（`getLoginInfoMap` 等的**唯一实现**）。
 * 此前前者只在 engine-legado 包内、后者内联在 legado 的 source 桩里 ⇒ rss 引擎整块缺失。
 */
export * from './login-model';
export * from './login-flow';
export * from './source-login';
// `#553` source 桩（Legado `bindings["source"]`）的**唯一实现** —— 引擎与试跑探针共用
export * from './source-stub';
// `#262` 高亮规则匹配器（浏览器侧走 package.json 深路径 `./highlight-rule-matcher` 导入 ——
// 根出口连着 user-store 的 node:*，进浏览器 bundle 会炸 vite build）
export * from './highlight-rule-matcher';
// `#202` 本地书（txt/epub）解析与取正文
export * from './local-book';
// `#567` P3 站点定制层：配置模型 / 域名匹配 / CSS·JS 注入（唯一实现，浏览器与 Node 共用）
export * from './site-customize';
export { createWorkerSandboxPool } from './sandbox/worker-pool';
export type { WorkerSandboxOptions } from './sandbox/worker-pool';
// `#754` DOM 后端启动预热 / 状态（服务与批处理子进程启动后调用；默认不预热）
export { prewarmDomBackend, domBackendStatus } from './sandbox/dom-backend';
export type { DomWarmupResult } from './sandbox/dom-backend';
// `#820` B2 第一批：HTTP TTS 的配置/分段/请求构造（纯逻辑，浏览器侧也可走深路径导入）
export * from './tts';

// 运行时实现层（M0 骨架补齐）
export * from './dom';
export * from './selector';
export * from './net';
/**
 * `#346` 媒体直链提取与 `media` 组装（**唯一实现**）—— 此前只存在于 engine-legado，
 * 订阅源（`type===2`）缺这条通路 ⇒ 正文 HTML 进沙箱 iframe，Chromium 无原生 HLS ⇒ 黑屏 0:00。
 */
export * from './content/media-extract';
