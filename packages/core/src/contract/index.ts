/**
 * 契约层**独立出口**（`@yuedu/core/contract`）—— Phase 1.4 的前置条件（评估文档明确要求）。
 *
 * ## 为什么必须单开一个出口
 * core 的根出口（`src/index.ts`）是 `export *`，它连带导出了 `user-store` / `net` / `dom`，
 * 而那些模块 import 了 `node:sqlite` / `node:fs` / `jsdom` —— 浏览器里连**加载**都会失败。
 * 而 Web 端真正需要的只是**类型**（`ShelfBook` / `Bookmark` / `EngineContext`…）。
 *
 * 于是给契约单独开一个出口，Web 端这样用：
 *   `import type { ShelfBook } from '@yuedu/core/contract'`
 * ⇒ 编译期擦除、运行时**零依赖**，「浏览器直接打开」这条部署形态不受影响。
 *
 * ## 硬约束（改这个文件前先读）
 * 这里**只能** re-export 契约模块，且契约模块内部只允许 `import type`（现状已核实：
 * `engine/error/login-v2/types/user-data` 五个文件**全是** `import type`）。
 * 一旦引入任何带副作用的实现（jsdom / node 内建 / 真实函数），Web 端就会被打包进浏览器无法运行的东西。
 * 回归锁：`apps/web` 的构建产物不得出现 `node:` 内建（见交接文档 §4.10）。
 *
 * ### 已知的两处**放行**（`#208`，2026-10-06）—— 都是纯函数，依赖闭包已逐个核实
 * 上面那条「只允许 `import type`」是针对**契约模块**的；下面两个是**实现型模块**，
 * 但它们**整个依赖闭包**里没有 `node:` 内建、没有 jsdom、没有副作用，属实测可放行：
 *   · `source-share-passphrase.ts` —— **零 import**（文件头已写明「Web/服务端两端共用」）。
 *     Web 端要**在本地解码口令**（`navigator.clipboard` 拿到口令后先判「是不是口令 / 过没过期 /
 *     是什么类型」再决定要不要发请求），这是运行时函数，不是类型。
 *   · `direct-link-upload.ts` —— 只 import `./json-loose`（同样是纯解析，零依赖）。
 *     Web 端只取它的**类型** `DirectLinkUploadRule`（`export type` ⇒ 运行时零影响）。
 * ⚠️ 往这里加东西前必须自证「依赖闭包无 node: 内建 / 无 jsdom / 无副作用」，
 *    并把闭包列出来 —— 别凭印象说「它应该是纯的」。
 */
export * from './engine';
export * from './error';
export * from './login-v2';
export * from './types';
export * from './user-data';

// ── `#208` 放行（见文件头「已知的两处放行」）─────────────────────────────
export * from '../source-share-passphrase';
export type { DirectLinkUploadRule } from '../direct-link-upload';

// ── `#312` 放行：源格式归属识别（唯一实现，零 import / 无副作用，性质同上）──────
//   为什么放这里：`@yuedu/facade` 与 `@yuedu/engine-legado` 都要用同一条判据，
//   而 facade **只依赖 `@yuedu/core`**（不能 import 引擎包）⇒ 下沉到契约层是唯一出路。
export * from './source-kind';
