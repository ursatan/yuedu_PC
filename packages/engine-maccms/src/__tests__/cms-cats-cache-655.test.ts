/**
 * `#655` **分类缓存 × 黑名单** 回归锁 —— 用户实测的真 bug：
 *
 * > 「CMS源，非凡资源，已填 blacklist：电影片,连续剧,综艺片，影院→发现页，
 * >   刷新分类，未屏蔽「电影片,连续剧,综艺片」」
 *
 * 真因链（三条，缺一条都复现不出来）：
 *  ① 发现页「刷新分类」走的是 `home`（`discover.ts` 的 `onSourceChange`），
 *     而不是 `/api/sources/:id/categories/refresh`；
 *  ② `home` 命中分类 KV 缓存（`cms:cats:<源>`，TTL **7 天**）后直接 `cached.items.map` 返回，
 *     **命中分支从未套用黑名单** ⇒ 缓存里有什么就显示什么；
 *  ③ 改 `blacklist` 不会让缓存失效 ⇒ 填了等于没填，且 7 天不自愈。
 *
 * 锁的行为：
 *  · `A` 缓存命中 + 黑名单 ⇒ 分类被剔除，且**零请求**（改黑名单立刻见效、不打站点）；
 *  · `B` 探针条件变了（`apiUrl` / `header` / `catAc`…）⇒ 签名不匹配，必须重探；
 *  · `C` 显式 `refreshCategories` ⇒ 一定重探（不受缓存影响）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MacCmsEngine } from '../engine';
import type { EngineContext, HttpClient } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

const API = 'https://api.example.com/api.php/provide/vod/';
const engine = new MacCmsEngine();

const CLASS_BODY = {
  code: 1,
  class: [
    { type_id: 1, type_name: '电影片' },
    { type_id: 2, type_name: '连续剧' },
    { type_id: 3, type_name: '综艺片' },
    { type_id: 4, type_name: '动漫片' },
  ],
  list: [],
};

function mockHttp(handler: (url: string) => unknown): HttpClient & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async request(url: string) {
      urls.push(url);
      const body = handler(url);
      return { status: 200, headers: {}, url, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
  };
}

function ctxOf(http: HttpClient, storage: ReturnType<typeof createMemoryKeyValueStore>): EngineContext {
  return {
    reqId: 't',
    sourceId: 's655',
    signal: AbortSignal.timeout(5000),
    http,
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage,
  } as unknown as EngineContext;
}

/** 只关心分类（不抓推荐位）⇒ 命中缓存时应当「零请求」 */
const CATS_ONLY = { action: 'home', extra: { categoriesOnly: true } } as const;

test('A 缓存命中时也要按黑名单过滤（用户报的那条）', async () => {
  const http = mockHttp(() => CLASS_BODY);
  const storage = createMemoryKeyValueStore();

  // ① 先在没有黑名单时生成缓存（等价于用户「先点过刷新分类，之后才填黑名单」）
  const plain = engine.compile({ name: 'p', apiUrl: API }).rule!;
  const first = await engine.home(plain, CATS_ONLY, ctxOf(http, storage));
  assert.equal(first.filters?.[0]?.options.length, 4, '首次探到 4 个分类');
  assert.ok(http.urls.length > 0, '首次一定打站点');
  await new Promise((r) => setTimeout(r, 10)); // writeCats 是 fire-and-forget

  // ② 用户填了黑名单（**不刷新**，模拟发现页直接进来 / 或刷新只清了前端快照）
  const blocked = engine.compile({ name: 'p', apiUrl: API, cms: { blacklist: ['电影片', '连续剧', '综艺片'] } }).rule!;
  http.urls.length = 0;
  const second = await engine.home(blocked, CATS_ONLY, ctxOf(http, storage));
  const names = (second.filters?.[0]?.options ?? []).map((o) => o.name);
  assert.deepEqual(names, ['动漫片'], `黑名单命中的分类必须从缓存结果里剔除，实际：${names.join(',')}`);
  assert.equal(http.urls.length, 0, `命中缓存时不该发请求，实际：${http.urls.join(', ')}`);
});

test('A2 黑名单按分类 id 也认（缓存分支同一判据）', async () => {
  const http = mockHttp(() => CLASS_BODY);
  const storage = createMemoryKeyValueStore();
  await engine.home(engine.compile({ name: 'q', apiUrl: API }).rule!, CATS_ONLY, ctxOf(http, storage));
  await new Promise((r) => setTimeout(r, 10));

  const blocked = engine.compile({ name: 'q', apiUrl: API, cms: { blacklist: ['2', '3'] } }).rule!;
  const r = await engine.home(blocked, CATS_ONLY, ctxOf(http, storage));
  assert.deepEqual((r.filters?.[0]?.options ?? []).map((o) => o.name), ['电影片', '动漫片']);
});

test('B 探针条件变了（apiUrl / header）⇒ 缓存作废，必须重探', async () => {
  const http = mockHttp(() => CLASS_BODY);
  const storage = createMemoryKeyValueStore();

  const a = engine.compile({ name: 'r', apiUrl: API }).rule!;
  await engine.home(a, CATS_ONLY, ctxOf(http, storage));
  await new Promise((r) => setTimeout(r, 10));

  // 换接口地址：旧分类已经不代表这个源了
  http.urls.length = 0;
  const b = engine.compile({ name: 'r', apiUrl: 'https://api2.example.com/api.php/provide/vod/' }).rule!;
  await engine.home(b, CATS_ONLY, ctxOf(http, storage));
  assert.ok(http.urls.length > 0, '换了 apiUrl 必须重新探测分类');
  assert.ok(http.urls.some((u) => u.includes('api2.example.com')), `应请求新域名：${http.urls.join(', ')}`);

  // 换请求头同样（很多站按 UA/Referer 分流，分类可能不同）
  await new Promise((r) => setTimeout(r, 10));
  http.urls.length = 0;
  const c = engine.compile({ name: 'r', apiUrl: 'https://api2.example.com/api.php/provide/vod/', header: 'User-Agent: X/1' }).rule!;
  await engine.home(c, CATS_ONLY, ctxOf(http, storage));
  assert.ok(http.urls.length > 0, '改了请求头也要重探');
});

test('C 显式 refreshCategories ⇒ 一定重探（不受缓存影响）', async () => {
  const http = mockHttp(() => CLASS_BODY);
  const storage = createMemoryKeyValueStore();
  const rule = engine.compile({ name: 's', apiUrl: API }).rule!;

  await engine.home(rule, CATS_ONLY, ctxOf(http, storage));
  await new Promise((r) => setTimeout(r, 10));

  http.urls.length = 0;
  await engine.home(rule, { action: 'home', extra: { categoriesOnly: true, refreshCategories: true } }, ctxOf(http, storage));
  assert.ok(http.urls.length > 0, '显式刷新必须打站点');
});

test('D 缓存只存站点原样：黑名单清空后分类能自己回来（不用等 7 天）', async () => {
  const http = mockHttp(() => CLASS_BODY);
  const storage = createMemoryKeyValueStore();

  // ① 屏蔽后刷新（真探一次）⇒ 缓存应仍保存全部 4 个，只是展示时剔掉
  const blocked = engine.compile({ name: 'd', apiUrl: API, cms: { blacklist: ['电影片'] } }).rule!;
  const r1 = await engine.home(blocked, { action: 'home', extra: { categoriesOnly: true, refreshCategories: true } }, ctxOf(http, storage));
  assert.deepEqual((r1.filters?.[0]?.options ?? []).map((o) => o.name), ['连续剧', '综艺片', '动漫片']);
  await new Promise((r) => setTimeout(r, 10));
  const raw = JSON.parse((await storage.get('cms:cats:s655'))!);
  assert.ok(raw.items.some((i: { label: string }) => i.label === '电影片'), '缓存里必须保留站点原样分类');

  // ② 清空黑名单（探针条件没变，命中缓存）⇒ 分类应当全部回来，且零请求
  const plain = engine.compile({ name: 'd', apiUrl: API }).rule!;
  http.urls.length = 0;
  const r2 = await engine.home(plain, CATS_ONLY, ctxOf(http, storage));
  assert.equal(r2.filters?.[0]?.options.length, 4, '取消屏蔽后 4 个分类都应回来');
  assert.equal(http.urls.length, 0, '不该为此重探站点');
});
