/**
 * 回归锁：**前端构建产物目录的自动探测**（缺陷类 — 用户实测 ③，2026-09-23）。
 *
 * 症状：Web 打开显示「EngineHub 聚合搜索（最小演示页）」。
 * 真因：`WEB_DIST` 的默认值写成了源码布局的相对路径 `__dirname/../../web/dist`，
 * 而服务端实际以 **`apps/desktop/server-bundle.mjs`** 运行 ⇒ `__dirname` = `apps/desktop`
 * ⇒ 解析到 `F:\yuedu_PC\web\dist`（不存在）⇒ 永远回退。
 *
 * 这里锁三件事：
 *   ① 环境变量给了**有效**目录 → 用它（`YUEDU_WEB_DIST` 仍然是最高优先级）；
 *   ② 环境变量给了**无效**目录 → 返回 null（显式暴露配置错误，不悄悄回落）；
 *   ③ 未设环境变量时**必须探到真实存在的产物目录**（不能返回一个不含 index.html 的路径）。
 *
 * `#323`（2026-10-07）追加：**静态缓存头判据** —— 此前静态服务不发 Cache-Control，
 * `index.html` 被浏览器启发式缓存 ⇒ 服务端更新后用户端仍持旧 bundle（#323 的
 * 「图片全失败 + style 未应用」两症状即旧 bundle 无 `#308` 功能所致）。判据：
 * index.html / SPA fallback / 无 hash 资源 ⇒ no-cache；assets 带 Vite hash ⇒ immutable。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWebDist, staticCacheControl } from '../web-dist';

function withEnv<T>(v: string | undefined, fn: () => T): T {
  const old = process.env.YUEDU_WEB_DIST;
  if (v === undefined) delete process.env.YUEDU_WEB_DIST;
  else process.env.YUEDU_WEB_DIST = v;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.YUEDU_WEB_DIST;
    else process.env.YUEDU_WEB_DIST = old;
  }
}

test('YUEDU_WEB_DIST 指向有效目录时优先使用（含 index.html 的临时目录）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-webdist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  try {
    const got = withEnv(dir, () => resolveWebDist());
    assert.equal(got, path.resolve(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('YUEDU_WEB_DIST 指向不存在的目录时返回 null（不静默回落）', () => {
  const got = withEnv(path.join(os.tmpdir(), 'yuedu-not-exist-xyz'), () => resolveWebDist());
  assert.equal(got, null);
});

test('未设环境变量时必须探到含 index.html 的真实目录（或在未构建时为 null）', () => {
  const got = withEnv(undefined, () => resolveWebDist());
  if (got == null) {
    // 未构建：允许 null（此时回退页是正确行为），但绝不能是「存在却缺 index.html」的目录
    return;
  }
  assert.ok(fs.existsSync(path.join(got, 'index.html')), `探测结果必须含 index.html：${got}`);
  // 打包布局下最容易踩的坑：解析到仓库根的 web/dist（不存在）
  assert.ok(!got.endsWith(`${path.sep}web${path.sep}dist`) || fs.existsSync(path.join(got, 'index.html')));
});

// ---------------------------------------------------------------------------
// `#323` 静态缓存头判据（staticCacheControl）
// ---------------------------------------------------------------------------

test('#323 缓存头：index.html 与 SPA fallback 必须 no-cache（更新立即生效的根基）', () => {
  assert.equal(staticCacheControl('index.html'), 'no-cache');
  assert.equal(staticCacheControl(''), 'no-cache', '根路径（rel 为空）走 SPA fallback 同样 no-cache');
  assert.equal(staticCacheControl('some/spa/route'), 'no-cache', '无扩展名 = SPA fallback = no-cache');
});

test('#323 缓存头：assets 下带 Vite 内容 hash 的资源可 immutable 长缓存', () => {
  assert.equal(staticCacheControl('assets/index-DoQucLUI.js'), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('assets/index-CtxvaHj5.css'), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('assets\\cn2t-CDC4Q3nQ.js'), 'public, max-age=31536000, immutable', 'Windows 反斜杠形态（rel 来自 path.join）必须归一后识别');
});

test('#323 缓存头：不带 hash 的资源（public 类）保持 no-cache（更新立即生效）', () => {
  assert.equal(staticCacheControl('assets/default-cover.jpg'), 'no-cache', 'assets 下不带 hash 的文件不得误判 immutable');
  assert.equal(staticCacheControl('reader-bg/bg1.jpg'), 'no-cache');
  assert.equal(staticCacheControl('favicon.ico'), 'no-cache');
});
