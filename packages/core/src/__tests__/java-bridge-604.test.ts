/**
 * `#604`：`java.*` 缺口的三个高价值 API —— `openUrl` / `downloadFile` / `ajaxTestAll`。
 *
 * 三个都是**上游正式版有**的（`F:/legado` `JsExtensions.kt:1239-1269` / `:518-570` / `:219-234`），
 * 本仓此前完全没有（未知属性落 Proxy 兜底 ⇒ 静默空转，症状是「点了没反应」/「内容获取失败」）。
 *
 * | API | 语料 | 上游语义要点 |
 * |---|---|---|
 * | `openUrl(url, mime?)` | 22 源 | 超长 `require` 抛错；**UI 不可用静默 return**（源普遍 try/catch 改按钮文案） |
 * | `downloadFile(hex\|data:, url)` / `downloadFile(url)` | 4 源 | 文件名 `<md5Encode16(url)>.<type>`，type 取 `,{"type":"html"}`；**返回相对路径** |
 * | `ajaxTestAll(list, timeout, skip?)` | 2 源 | 返回 `StrResponse[]`；⚠️ 语料里是「Sigma 版特性探测」（`typeof java.ajaxTestAll === 'function'`） |
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJsEvaluator, createHybridJsEvaluator } from '../selector/js';
import { createWorkerSandboxPool } from '../sandbox/worker-pool';
import { createVariableStore } from '../store';
import { fileCacheKey } from '../selector/js-file';

const run = (ev: unknown, code: string, bindings: Record<string, unknown> = {}) =>
  String((ev as (c: string, b: Record<string, unknown>) => unknown)(code, { baseUrl: 'https://x.test', ...bindings }));

test('openUrl：走 browser 通道（kind=show），返回空串（上游 Unit）', () => {
  const opened: Array<{ u: string; kind?: string }> = [];
  const ev = createJsEvaluator({
    variables: createVariableStore(),
    onBrowserOpen: (u, kind) => opened.push({ u, ...(kind ? { kind } : {}) }),
  });
  const url = 'legado://import/addToBookshelf?src=https%3A%2F%2Fx.test%2Fbook%2F1';
  assert.equal(run(ev, `String(java.openUrl(${JSON.stringify(url)}))`), '');
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.u, url);
  assert.equal(opened[0]?.kind, 'show');
});

test('openUrl：空串不回调；超长（≥64KB）抛错（上游 require）', () => {
  const opened: string[] = [];
  const ev = createJsEvaluator({ variables: createVariableStore(), onBrowserOpen: (u) => opened.push(u) });
  run(ev, "String(java.openUrl(''))");
  assert.equal(opened.length, 0, '空地址不应开窗');
  const long = 'x'.repeat(64 * 1024);
  assert.throws(
    () => run(ev, `java.openUrl('${long}')`),
    /too long/,
    '上游 require(url.length < 64*1024) → 超长必须抛',
  );
});

test('downloadFile(hex, url)：返回 <md5Encode16>.<type>，内容按 data URL 存文件层', () => {
  const vars = createVariableStore();
  const ev = createJsEvaluator({ variables: vars });
  const url = 'https://bbs.test/_x8dl_t1.html,{"type":"html"}';
  // "3C68313E" = "<h1>"
  const rel = run(ev, `String(java.downloadFile('3C68313E', ${JSON.stringify(url)}))`);
  assert.equal(rel, `${fileCacheKey(url)}.html`, '文件名 = md5Encode16(url).<type>（type 取自 ,{"type"} 选项）');
  // 内容落在文件层，且以 data URL 形式保存（二进制不丢）
  const bag = JSON.parse(String(vars.get('__srcCache') ?? '{}')) as Record<string, { v?: string }>;
  const stored = bag[`file:${fileCacheKey(url)}`]?.v ?? '';
  assert.match(stored, /^data:text\/html;base64,/);
  assert.equal(Buffer.from(stored.split(',')[1] ?? '', 'base64').toString('utf-8'), '<h1>');
});

test('downloadFile(data: URI, url)：内联内容同样落盘（千白羽的兜底形态）', () => {
  const vars = createVariableStore();
  const ev = createJsEvaluator({ variables: vars });
  const url = 'https://bbs.test/_x8dl_t2.html,{"type":"html"}';
  const dataUri = `data:text/html;base64,${Buffer.from('<p>hi').toString('base64')}`;
  const rel = run(ev, `String(java.downloadFile(${JSON.stringify(dataUri)}, ${JSON.stringify(url)}))`);
  assert.equal(rel, `${fileCacheKey(url)}.html`);
  const bag = JSON.parse(String(vars.get('__srcCache') ?? '{}')) as Record<string, { v?: string }>;
  assert.equal(
    Buffer.from((bag[`file:${fileCacheKey(url)}`]?.v ?? '').split(',')[1] ?? '', 'base64').toString('utf-8'),
    '<p>hi',
  );
});

test('downloadFile：type 缺省时按 URL 后缀（番茄短剧的 .mp4）', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  const rel = run(ev, "String(java.downloadFile('00', 'https://x.test/a/b.mp4'))");
  assert.match(rel, /\.mp4$/);
});

test('ajaxTestAll：返回数组且不抛（失败项也保留，下标语义不变）', () => {
  const ev = createJsEvaluator({ variables: createVariableStore() });
  // 用 data: URL 保证不联网：L1 的 transport 会把它当普通请求失败 ⇒ 走 catch 分支给空响应
  const out = run(
    ev,
    "JSON.stringify(java.ajaxTestAll(['data:,a','data:,b'], 1000).map(function(r){return [String(r.url()), r.code()];}))",
  );
  const arr = JSON.parse(out) as Array<[string, number]>;
  assert.equal(arr.length, 2, '两个输入 → 两个响应项（失败也不剔除）');
});

test('worker：openUrl / downloadFile / ajaxTestAll 三个都在（不得是 undefined）', async () => {
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const opened: string[] = [];
    const ev = createHybridJsEvaluator({
      variables: createVariableStore(),
      pool,
      http: async () => ({ status: 200, headers: {}, body: 'ok' }),
      onBrowserOpen: (u) => opened.push(u),
    }) as (c: string, b: Record<string, unknown>) => unknown | Promise<unknown>;
    const kinds = JSON.parse(
      String(
        await Promise.resolve(
          ev(
            "JSON.stringify({o: typeof java.openUrl, d: typeof java.downloadFile, a: typeof java.ajaxTestAll})",
            {},
          ),
        ),
      ),
    ) as Record<string, string>;
    assert.equal(kinds['o'], 'function');
    assert.equal(kinds['d'], 'function');
    assert.equal(kinds['a'], 'function');
    // 真调一次 openUrl（不应抛、且到宿主）
    await Promise.resolve(ev("java.openUrl('https://x.test/open')", {}));
    assert.equal(opened.includes('https://x.test/open'), true, 'worker 的 openUrl 必须回到宿主 browser 通道');
  } finally {
    await (pool as unknown as { close?: () => Promise<void> }).close?.();
  }
});
