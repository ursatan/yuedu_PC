/**
 * 前端构建产物目录（`apps/web/dist`）的解析 —— **纯函数，无副作用**（便于回归测试）。
 *
 * ⚠️ **不能再用 `__dirname` 的相对默认值**（2026-09-23 修，用户实测 ③）：
 * 源码布局下 `apps/server/src/../../web/dist` = `apps/web/dist` ✅，
 * 但服务端会被 `apps/desktop/build-server.sh` 打包成 **`apps/desktop/server-bundle.mjs`**，
 * 此时 `__dirname` = `apps/desktop` ⇒ 解析到 `F:\yuedu_PC\web\dist`（不存在）
 * ⇒ `/*` 路由永远走 `FALLBACK_HTML`，用户看到「EngineHub 聚合搜索（最小演示页）」。
 *
 * 现在按**候选列表探测**第一个含 `index.html` 的目录，并且**每次请求重新调用**：
 * 回退页的文案承诺「apps/web 构建后自动替换」——只有重新探测才兑现这句话（不必重启服务）。
 *
 * 优先级：环境变量 `YUEDU_WEB_DIST` > 探测候选。
 * 环境变量给了但目录不存在 → 返回 null（**不要**悄悄回落到别的目录：配置写错就该显式暴露）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 当前模块所在目录。
 *
 * 三种运行形态都要能算出来：
 *   · **打包产物** `apps/desktop/server-bundle.mjs`（esbuild `--format=esm` + node interop）→ 会注入 `__dirname`
 *   · **CJS**（`tsc` 产物 / `node` 直跑 `.js`）→ 有 `__dirname`
 *   · **纯 ESM**（`tsx` 直跑 `.ts`，例如单测）→ **没有** `__dirname`，只能走 `import.meta.url`
 *
 * 用 `typeof` 探测（未声明标识符用 `typeof` 不会抛），拿不到再退回 `process.cwd()`。
 */
const MODULE_DIR: string = (() => {
  if (typeof __dirname === 'string' && __dirname) return __dirname;
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

export function resolveWebDist(): string | null {
  const fromEnv = process.env.YUEDU_WEB_DIST;
  if (fromEnv) {
    const p = path.resolve(fromEnv);
    return fs.existsSync(p) ? p : null;
  }
  const candidates = [
    path.resolve(MODULE_DIR, '../../web/dist'), // 源码布局：apps/server/src → apps/web/dist
    path.resolve(MODULE_DIR, '../web/dist'), // 打包布局：apps/desktop/server-bundle.mjs → apps/web/dist
    path.resolve(MODULE_DIR, 'web-dist'), // Electron 打包：resources/web-dist
    path.resolve(process.cwd(), 'apps/web/dist'), // 以仓库根为 cwd 启动
    path.resolve(process.cwd(), 'web/dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

/**
 * 静态资源的 `Cache-Control` 判据（`#323` 判例，纯函数便于回归锁）。
 *
 * **为什么必须有**：此前静态服务**不发任何 Cache-Control** ⇒ `index.html` 被浏览器
 * 启发式缓存 ⇒ 服务端已更新、用户浏览器还拿着旧 `index.html` ⇒ 引用到旧 hash 的
 * js/css ⇒ **整套前端逻辑停在旧版本**。#323 的「正文图片全失败 + style 未应用」
 * 正是这个形态：旧 bundle 里没有 `#308` 的 iframe/script 执行与 style 注入，
 * 两个症状同时命中（引擎侧与前端机制经多路探针实证无罪）。
 *
 * 判据（对齐 Vite 产物形态）：
 *   · `index.html` / 无扩展名（SPA fallback）/ 不带 hash 的资源（`reader-bg/`、
 *     `default-cover.jpg` 等 public 类） ⇒ `no-cache`（可缓存但每次协商，更新立即生效）；
 *   · `assets/<name>-<hash>.<ext>`（Vite 内容 hash，8 位 [A-Za-z0-9_-]） ⇒
 *     `public, max-age=31536000, immutable`（内容变了 hash 必变 ⇒ 可放心长缓存，
 *     而 index.html 是 no-cache ⇒ 新版本发布后用户必然拿到新引用）。
 */
const VITE_HASH_RE = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

export function staticCacheControl(rel: string): string {
  const norm = rel.replaceAll('\\', '/');
  if (norm === '' || norm === 'index.html' || !norm.includes('.')) return 'no-cache';
  if (norm.startsWith('assets/') && VITE_HASH_RE.test(norm)) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}
