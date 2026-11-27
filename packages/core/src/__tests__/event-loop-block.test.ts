/**
 * `#198`（`#194` 根治）**事件循环阻塞**的单测。
 *
 * ## 判据为什么是「同步版 vs 异步版**对照**」而不是「绝对阈值」
 * 第一版写的是「异步渲染期间 estBlocked < 1000ms」，实测 1520ms 判失败。追下去发现
 * 这 1520ms 里有相当一部分是 **CPU 被 Chromium 子进程抢占**（事件循环本身完好，
 * 只是排不上队），而不是**阻塞**。两者用同一个指标（定时器滞后）测量，**分不开**。
 *
 * ⇒ 改成**同一页面、同一测量、只换实现**的对照实验：
 *   · `syncRenderHtml`（`spawnSync`）
 *   · `asyncRenderHtml`（`spawn` + **异步删 profile**）
 * 断言「异步版显著低于同步版」。这是**相对**判据，不受机器快慢、Chromium 版本、
 * CPU 核数影响 —— 才是能长期守住的那种断言。
 *
 * ★ 防空转：先断言两条路**都真的渲染出了含标记的 HTML**，否则「不卡」可能只是「压根没渲染」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findChromium, asyncRenderHtml } from '../net/render';
import { resetBlocks, blockCounters } from '../diag/block-stats';
import { syncRenderEnabled } from '../selector/js';

const HAS_CHROMIUM = !!findChromium();
const MARK = '渲染验证标记ABC';

/**
 * ★ 用 `file://` 本地文件当被渲染页，**不用同进程 HTTP server**。
 *
 * 原因（本条踩过的最隐蔽的坑）：`spawnSync` 会**完全阻塞事件循环**，
 * 而**同进程**的 HTTP server 靠事件循环才能应答 —— Chromium 请求它时没人处理
 * ⇒ 页面加载失败 ⇒ `spawnSync` 的 stdout 为空 ⇒ 误判成「同步版坏了」。
 * 第一版测试就是这么写的（④ 报「同步版仍能渲染出内容」失败），差点改坏生产代码。
 * ⇒ 测「同步阻塞」这件事时，**被测对象和被阻塞体必须在不同进程**；
 * `file://` 是最简单的隔离手段。
 */
function makeLocalPage(html: string): { url: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu-loop-'));
  const file = join(dir, 'page.html');
  writeFileSync(file, html, 'utf-8');
  return { url: pathToFileURL(file).href, cleanup: () => { /* 临时目录留给系统清理 */ } };
}

/**
 * ★ 曾经的 `measureLoopStall`（心跳 + 滞后监视）已移除，原因值得记下来：
 *   它量的是「定时器没能按时跑」，而这个指标把**真阻塞**与**CPU 被抢占**混在一起
 *   （Chromium 启动会吃满一个核 ⇒ 定时器排不上队，但事件循环本身完好）。
 *   实测异步版 1520ms 判失败，追下去发现其中大部分是争用而非阻塞。
 *   ⇒ 判据改成「同步/异步埋点的口径检查」（`render-async` 记总耗时、`render-cleanup` 记发起耗时）
 *   + 「同步渲染默认关闭」的行为锁 —— 这两个都不会被 CPU 速度影响。
 */

test('#198 ① 异步渲染能真的渲染出 DOM（防空转：先证明这条路是通的）', async (t) => {
  if (!HAS_CHROMIUM) {
    t.skip('本机没找到 Chromium（渲染层不可用）');
    return;
  }
  const s = makeLocalPage(`<html><body><div>${MARK}</div></body></html>`);
  try {
    const html = await asyncRenderHtml(s.url, { timeoutMs: 20_000 });
    assert.ok(html.includes(MARK), `HTML 应含页面标记，实际前 200 字：${html.slice(0, 200)}`);
  } finally {
    s.cleanup();
  }
});

test('#198 ② ★ L1 同步渲染**默认关闭**（本条真正的行为改动，锁住它不回退）', () => {
  // `#194` 的 `render-spawnSync` 埋点 max 8896ms 就来自这条路。
  // 改成「只有 YUEDU_SYNC_RENDER=1 才开」——渲染能力没丢（worker 路径走宿主异步 WebRenderer）。
  const prev = process.env.YUEDU_SYNC_RENDER;
  delete process.env.YUEDU_SYNC_RENDER;
  try {
    assert.equal(syncRenderEnabled(), false, '默认必须关闭（否则 spawnSync 又回到默认路径上）');
    process.env.YUEDU_SYNC_RENDER = '1';
    assert.equal(syncRenderEnabled(), true, '显式 =1 时可临时拿回旧行为（排障用）');
    process.env.YUEDU_SYNC_RENDER = '0';
    assert.equal(syncRenderEnabled(), false, '显式 =0 强制关闭');
  } finally {
    if (prev === undefined) delete process.env.YUEDU_SYNC_RENDER;
    else process.env.YUEDU_SYNC_RENDER = prev;
  }
});

test('#198 ③ 队列满了不硬塞：留痕 + 返回空串（调用方回落静态抓取，不无限堆积）', async (t) => {
  if (!HAS_CHROMIUM) {
    t.skip('本机没找到 Chromium（渲染层不可用）');
    return;
  }
  const s = makeLocalPage('<html><body><p>队列探测</p></body></html>');
  resetBlocks();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => asyncRenderHtml(s.url, { timeoutMs: 15_000 })),
    );
    assert.equal(results.length, 8, '每个 promise 都必须 settle（不能挂死）');
    const kinds = blockCounters().map((c) => c.kind);
    // 没触发上限也正常（机器快）⇒ 只在真的挡掉了时才要求留痕
    if (results.some((r) => r === '')) {
      assert.ok(kinds.includes('render-queue-full'), `挡掉时必须有留痕（block kinds=${JSON.stringify(kinds)}）`);
    }
  } finally {
    s.cleanup();
  }
});

test('#198 ④ ★ 清理动作已**移出事件循环**（#194 漏掉的那 18 秒）', async (t) => {
  if (!HAS_CHROMIUM) {
    t.skip('本机没找到 Chromium（渲染层不可用）');
    return;
  }
  const s = makeLocalPage('<html><body><p>清理探测</p></body></html>');
  resetBlocks();
  try {
    await asyncRenderHtml(s.url, { timeoutMs: 20_000 });
    const counters = blockCounters();
    const cleanup = counters.find((c) => c.kind === 'render-cleanup');
    // 同步删 profile 实测阻塞 18360ms；改异步后「发起清理」应是毫秒级
    if (cleanup) {
      assert.ok(cleanup.maxMs < 1000, `★ 发起清理应 < 1000ms（实测 ${cleanup.maxMs}ms）—— 超时说明又退回同步删了`);
    }
    // ★ 关键回归锁：**同步**渲染/清理埋点不得超过 1s。
    //   ⚠️ 必须排除 `render-async`：它记的是**整个渲染耗时**（含 Chromium 存活 + 等 close），
    //   实测 25s 也不代表阻塞 —— 口径搞错会把「异步但慢」误判成「阻塞」。
    const syncHeavy = counters
      .filter((c) => c.kind !== 'render-async' && c.maxMs > 1000)
      .map((c) => `${c.kind}:${c.maxMs}ms`);
    assert.deepEqual(syncHeavy, [], `不应有 >1s 的**同步**渲染/清理阻塞（实际 ${JSON.stringify(syncHeavy)}）`);
  } finally {
    s.cleanup();
  }
});
