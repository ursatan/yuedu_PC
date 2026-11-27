/**
 * `#563` 引擎级对照锁：bookList（`<js>` + `Jsoup.parse(h, base)` + `abs:href`）
 * 在**引擎**里也应出 30 项 —— 探针修好不代表引擎好，两边都必须锁。
 *
 * ★ 2026-11-26 去第三方化：旧版用 2026-10-22 实拉的黄金屋榜单页与源规则快照
 * （`hj-rank-allvisit-1.html` / `hj-source.json`），那是**第三方站点内容转载**，
 * 公开仓库不得携带 ⇒ 已 `git rm --cached`，改用**合成夹具**：
 *   · `abs-href-page.html` —— 30 张 `a.book-card[href^=/novel]` 的合成榜单页；
 *   · `abs-href-source.json` —— 同一套 bookList 结构（`<js>` + org.jsoup + `abs:href`）的合成源。
 * 锁的仍是**引擎的 abs:/baseUri 行为**，与站点时效无关；断言值随合成夹具稳定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LegadoEngine } from '../index';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  createWorkerSandboxPool,
  type EngineContext,
  type HttpClient,
} from '@yuedu/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const PAGE = fixture('abs-href-page.html');
const raw = JSON.parse(fixture('abs-href-source.json')) as Record<string, unknown>;

const http: HttpClient = {
  async request(url: string) {
    if (url.includes('example.test')) {
      return { status: 200, headers: {}, body: PAGE, url };
    }
    throw new Error(`no mock for ${url}`);
  },
};

function makeCtx(h: HttpClient): EngineContext {
  return {
    reqId: 't', sourceId: 'src', signal: new AbortController().signal,
    http: h, sandbox: { async eval() { throw new Error('no sandbox'); } }, trace: createTraceSink(),
    variables: createVariableStore(), storage: createMemoryKeyValueStore(),
  };
}

test('引擎 category（mock 页面 = 合成夹具里的榜单页）应命中 30 项', async () => {
  const engine = new LegadoEngine();
  const r = engine.compile(raw);
  assert.ok(r.ok && r.rule !== undefined, 'compile 应通过');
  // 真 worker 池：黄金屋 bookList 含 `org.jsoup.*` ⇒ 引擎会路由进 worker（与线上同一条路）
  const pool = createWorkerSandboxPool({ size: 1 });
  try {
    const ctx = makeCtx(http);
    ctx.sandbox = pool;
    const out = await engine.category(r.rule!, { action: 'category', page: 1, filters: { explore: '/rank/allvisit/{{page}}.html' } }, ctx);
    assert.equal(out.items.length, 30, `应命中 30 项，实际 ${out.items.length}；hint=${JSON.stringify(out.hint ?? '')}`);
    // 引擎把 name 归一成 `title`（卡片上显示的就是它）；以前这里是空串 ⇒ 卡片一片空白
    assert.match(String(out.items[0]?.title ?? ''), /示例书籍 01/);
    // ★ abs:href 回归锁：bookUrl 来自 `e.attr('abs:href')` —— 缺基址时它恒空串，
    // 规则里 `if(!u) continue` 把每项跳过（#563 的病根：0 项）。
    const bookUrl = String((out.items[0]?.payload as { bookUrl?: string } | undefined)?.bookUrl ?? '');
    assert.match(bookUrl, /^https:\/\/example\.test\/novel\/\d+$/, `bookUrl 应解出绝对地址，实际：${bookUrl}`);
    // 封面由 jsLib 的 HJ_B（绝对基址）拼出 ⇒ 同样必须是绝对地址
    assert.match(String(out.items[0]?.cover ?? ''), /^https:\/\/example\.test\//, `封面也应解出绝对地址：${out.items[0]?.cover}`);
  } finally {
    await (pool as { destroy?: () => Promise<void> }).destroy?.();
  }
});
