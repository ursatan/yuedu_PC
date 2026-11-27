/**
 * `#653` CMS 参数块回归锁 —— 对齐全仓参考实现 OmniFlow 的 `CmsEndpoint`。
 *
 * 锁的都是本轮新增/改动的**行为**（不是字段存在性）：
 *  ① `cms` 嵌套块优先、扁平字段兜底（老源不受影响）；
 *  ② 四接口 ac 各自 fallback，**成功值自学习**（第二次不再试失败的那个）；
 *  ③ `blackId` 剔片子、`playFromSplit` 切线路、`siteDomains` 换域名重试；
 *  ④ `pageSize` 只有显式配置才发 `limit`；
 *  ⑤ 分类缓存：第二次 home 不再请求分类接口，`refreshCategories` 才重拉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MacCmsEngine } from '../engine';
import { compileCmsSource } from '../model/cms-source';
import type { EngineContext, HttpClient } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';
import { parsePlayList } from '../playlist';

const API = 'https://api.example.com/api.php/provide/vod/';

/** 记录每次请求 URL 的 mock（按判定函数返回 body） */
function mockHttp(handler: (url: string) => { body: unknown; status?: number }): HttpClient & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async request(url: string) {
      urls.push(url);
      const { body, status } = handler(url);
      return {
        status: status ?? 200,
        headers: {},
        url,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      };
    },
  };
}

function ctxOf(http: HttpClient, storage = createMemoryKeyValueStore(), sourceId = 's1'): EngineContext {
  return {
    reqId: 't',
    sourceId,
    signal: AbortSignal.timeout(5000),
    http,
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage,
  } as unknown as EngineContext;
}

const engine = new MacCmsEngine();

const LIST_BODY = {
  code: 1,
  class: [{ type_id: 1, type_name: '电影' }],
  list: [{ vod_id: 11, vod_name: '片子A', vod_pic: 'https://p/a.jpg', type_id: 1 }],
};

test('① cms 嵌套块优先，扁平字段兜底（compile 归一）', () => {
  const nested = compileCmsSource({
    name: 'x',
    cms: { base: API, acParam: 'action', wdParam: 'kw', pgParam: 'page', typeParam: 'cat', idsParam: 'vid', limitParam: 'size', pageSize: 20 },
  });
  assert.equal(nested.ok, true);
  assert.equal(nested.rule?.apiUrl, API.replace(/\/$/, ''), 'cms.base 当 apiUrl 用');
  assert.equal(nested.rule?.acParam, 'action');
  assert.equal(nested.rule?.wdParam, 'kw');
  assert.equal(nested.rule?.pageSize, 20);

  const flat = compileCmsSource({ name: 'y', apiUrl: API, acParam: 'ac2' });
  assert.equal(flat.rule?.acParam, 'ac2', '扁平字段仍生效');
});

test('② 四接口 ac 各自 fallback + 成功值自学习', async () => {
  // 只认 ac=detail 搜索（videolist/list 返回空 list）
  const http = mockHttp((url) => {
    if (url.includes('ac=detail') && url.includes('wd=')) return { body: LIST_BODY };
    if (url.includes('ac=detail') && url.includes('ids=')) {
      return { body: { code: 1, list: [{ vod_id: 7, vod_name: '详情片', vod_play_from: 'm3u8', vod_play_url: '第1集$https://a/1.m3u8' }] } };
    }
    return { body: { code: 1, list: [] } };
  });
  const storage = createMemoryKeyValueStore();
  const rule = engine.compile({ name: 'z', apiUrl: API }).rule!;

  const r1 = await engine.search(rule, { action: 'search', keyword: 'x' }, ctxOf(http, storage));
  assert.equal(r1.items.length, 1, 'detail 命中');

  // 第二次：自学习把 detail 放第一位 ⇒ 只发 1 个请求
  http.urls.length = 0;
  const r2 = await engine.search(rule, { action: 'search', keyword: 'x' }, ctxOf(http, storage));
  assert.equal(r2.items.length, 1);
  assert.equal(http.urls.length, 1, `学过 detail 后应只请求一次，实际 ${http.urls.length}: ${http.urls.join(', ')}`);
  assert.match(http.urls[0]!, /ac=detail/);
  assert.equal(await storage.get('cms:ac:s1:search'), 'detail');
});

test('③ blackId 剔除指定 vod_id', async () => {
  const http = mockHttp(() => ({
    body: {
      code: 1,
      class: [{ type_id: 1, type_name: '电影' }],
      list: [
        { vod_id: 11, vod_name: '要的', vod_pic: 'https://p/a.jpg' },
        { vod_id: 99, vod_name: '屏蔽的', vod_pic: 'https://p/b.jpg' },
      ],
    },
  }));
  const rule = engine.compile({ name: 'b', apiUrl: API, cms: { blackId: ['99'] } }).rule!;
  const r = await engine.home(rule, { action: 'home' }, ctxOf(http));
  assert.deepEqual(r.items.map((i) => i.id), ['11']);
  assert.equal(r.items.length, 1, 'blackId 命中的片子不出现在列表');
});

test('③b playFromSplit 自定义线路分隔（默认 $$$ 仍兼容）', () => {
  const defaultSep = parsePlayList('m3u8$$备用', 'E1$https://a/1.m3u8$$E1$https://b/1.m3u8');
  assert.equal(defaultSep.length, 2, '默认 $$$ 两线路');

  // 源用 `@` 分隔：不配 lineSep 只会解析出 1 条（拼接在 URL 里），配了才对
  const withAt = 'm3u8@备用';
  const urls = 'E1$https://a/1.m3u8@E1$https://b/1.m3u8';
  const auto = parsePlayList(withAt, urls);
  assert.equal(auto.length, 1, '未配置时不认 @');
  const fixed = parsePlayList(withAt, urls, { lineSep: '@' });
  assert.equal(fixed.length, 2, '配置 playFromSplit=@ 后切成两条线路');
});

test('③c siteDomains：主域网络失败时换域名重试', async () => {
  const seen: string[] = [];
  const http: HttpClient = {
    async request(url: string) {
      seen.push(url);
      if (url.includes('api.example.com')) throw new Error('fetch failed: ENOTFOUND api.example.com');
      return { status: 200, headers: {}, url, body: JSON.stringify(LIST_BODY) };
    },
  };
  const rule = engine.compile({ name: 'm', apiUrl: API, cms: { siteDomains: ['https://mirror.example.com'] } }).rule!;
  const r = await engine.home(rule, { action: 'home' }, ctxOf(http));
  assert.equal(r.items.length, 1, '镜像域名拿到了数据');
  assert.ok(seen.some((u) => u.includes('mirror.example.com')), `应尝试镜像：${seen.join(' , ')}`);
});

test('④ pageSize 只有显式配置才发 limit', async () => {
  const noLimit = mockHttp(() => ({ body: { code: 1, list: [LIST_BODY.list[0]] } }));
  await engine.search(engine.compile({ name: 'a', apiUrl: API }).rule!, { action: 'search', keyword: 'k' }, ctxOf(noLimit));
  assert.ok(noLimit.urls.every((u) => !u.includes('limit=')), `未配置时不应带 limit：${noLimit.urls[0]}`);

  const withLimit = mockHttp(() => ({ body: { code: 1, list: [LIST_BODY.list[0]] } }));
  await engine.search(engine.compile({ name: 'a', apiUrl: API, cms: { pageSize: 20 } }).rule!, { action: 'search', keyword: 'k' }, ctxOf(withLimit));
  assert.ok(withLimit.urls[0]!.includes('limit=20'), `配置后应带 limit=20：${withLimit.urls[0]}`);
});

test('⑤ 分类缓存：第二次 home 不再请求分类接口；refreshCategories 才重拉', async () => {
  const http = mockHttp((url) => {
    // 分类只由 ac=list 给出（模拟 maccms：ac=detail 没有 class）
    if (url.includes('ac=list')) return { body: LIST_BODY };
    if (url.includes('ac=detail')) return { body: { code: 1, list: LIST_BODY.list } };
    return { body: { code: 1, list: [] } };
  });
  const storage = createMemoryKeyValueStore();
  const rule = engine.compile({ name: 'c', apiUrl: API }).rule!;
  const ctx = ctxOf(http, storage);

  const r1 = await engine.home(rule, { action: 'home' }, ctx);
  assert.equal(r1.filters?.[0]?.options.length, 1);
  const firstUrls = [...http.urls];
  assert.ok(firstUrls.some((u) => u.includes('ac=list')), '首次要探测分类');

  // 等一拍：writeCats 是 fire-and-forget
  await new Promise((r) => setTimeout(r, 10));
  http.urls.length = 0;
  const r2 = await engine.home(rule, { action: 'home' }, ctx);
  assert.equal(r2.filters?.[0]?.options.length, 1, '第二次分类来自缓存');
  assert.ok(!http.urls.some((u) => u.includes('ac=list')), `缓存命中后不该再探测分类：${http.urls.join(', ')}`);

  // `categoriesOnly`：命中缓存时必须**零网络**（工坊/发现页读本地分类就走这条）
  http.urls.length = 0;
  const r2b = await engine.home(rule, { action: 'home', extra: { categoriesOnly: true } }, ctx);
  assert.equal(r2b.filters?.[0]?.options.length, 1);
  assert.equal(r2b.items.length, 0, 'categoriesOnly 不抓推荐位');
  assert.equal(http.urls.length, 0, `读本地分类不该发任何请求，实际：${http.urls.join(', ')}`);

  // 刷新：必须重新拉
  http.urls.length = 0;
  const r3 = await engine.home(rule, { action: 'home', extra: { refreshCategories: true } }, ctx);
  assert.equal(r3.filters?.[0]?.options.length, 1);
  assert.ok(http.urls.some((u) => u.includes('ac=list')), '刷新分类要重新探测');

  // 缓存里带 URL（分类名 + 该分类的请求地址）
  const raw = await storage.get('cms:cats:s1');
  const cache = JSON.parse(raw!) as { items: Array<{ label: string; typeId: string; url: string }> };
  assert.equal(cache.items[0]!.label, '电影');
  assert.match(cache.items[0]!.url, /t=1/);
});
