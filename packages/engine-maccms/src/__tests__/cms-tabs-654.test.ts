/**
 * `#654` CMS 源「tab 合并 + 请求头接通 + 黑名单归一」回归锁。
 *
 * 用户实测报的三件事，逐条锁行为（不是锁字段存在性）：
 *  ① 工坊「进阶」tab 与「CMS 参数」重复 ⇒ 进阶已删除；`header` 挪到「基本」并且**引擎真的会发**；
 *  ② `blacklist`（屏蔽分类）与 `blackId`（屏蔽 vod_id）**不是**同一功能 —— 谁都不能被对方吞掉；
 *  ③ `cms.blacklist` 支持「分类 id 或 分类名」，且 home / category / search 三处判据一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MacCmsEngine } from '../engine';
import { compileCmsSource, parseHeader } from '../model/cms-source';
import type { EngineContext, HttpClient } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

const API = 'https://api.example.com/api.php/provide/vod/';
const engine = new MacCmsEngine();

/** 记录 URL 与请求头（`#654` 要验 header 真的发出去了） */
function mockHttp(handler: (url: string) => unknown): HttpClient & { urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  return {
    urls,
    headers,
    async request(url: string, opts?: { headers?: Record<string, string> }) {
      urls.push(url);
      headers.push(opts?.headers ?? {});
      const body = handler(url);
      return { status: 200, headers: {}, url, body: typeof body === 'string' ? body : JSON.stringify(body) };
    },
  };
}

function ctxOf(http: HttpClient, storage = createMemoryKeyValueStore(), sourceId = 's654'): EngineContext {
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

const LIST_BODY = {
  code: 1,
  class: [
    { type_id: 1, type_name: '电影' },
    { type_id: 39, type_name: '里番' },
  ],
  list: [
    { vod_id: 11, vod_name: '要的', vod_pic: 'https://p/a.jpg', type_id: 1, type_name: '电影' },
    { vod_id: 99, vod_name: '分类被屏蔽', vod_pic: 'https://p/b.jpg', type_id: 39, type_name: '里番' },
  ],
};

test('① parseHeader 三种写法都认：对象 / JSON 字符串 / 逐行 Key: Value', () => {
  assert.deepEqual(parseHeader({ Referer: 'https://a/', 'X-Token': 't1' }), { Referer: 'https://a/', 'X-Token': 't1' });
  assert.deepEqual(parseHeader('{"Referer":"https://a/"}'), { Referer: 'https://a/' });
  assert.deepEqual(parseHeader('Referer: https://a/\nX-Token: t2'), { Referer: 'https://a/', 'X-Token': 't2' });
  assert.deepEqual(parseHeader('Referer=https://a/'), { Referer: 'https://a/' }, '等号也认');
  assert.equal(parseHeader(''), undefined);
  assert.equal(parseHeader('这不是头'), undefined, '解析不出来就当没填，不抛错');
});

test('② header 真的并进请求：自定义 UA 覆盖默认，Referer 一起带上', async () => {
  // 编译期也要归一（工坊表单里是**文本**，直连 JSON 里可能是对象）
  assert.deepEqual(
    compileCmsSource({ apiUrl: API, header: '{"Referer":"https://x/"}' }).rule?.header,
    { Referer: 'https://x/' },
    'compile 阶段就把文本头归一成对象',
  );

  const http = mockHttp(() => LIST_BODY);
  const rule = engine.compile({
    name: 'h',
    apiUrl: API,
    header: 'User-Agent: MyReader/1.0\nReferer: https://site.example.com/',
  }).rule!;
  await engine.home(rule, { action: 'home' }, ctxOf(http));
  assert.ok(http.headers.length > 0, '应该有请求发出');
  const h = http.headers[0] as Record<string, string>;
  assert.equal(h['User-Agent'], 'MyReader/1.0', '源里配的 UA 要覆盖默认 UA');
  assert.equal(h['Referer'], 'https://site.example.com/');
});

test('③ cms.blacklist 按分类名屏蔽：分类 chips + 卡片 + 搜索三处一致', async () => {
  const http = mockHttp(() => LIST_BODY);
  const rule = engine.compile({ name: 'b', apiUrl: API, cms: { blacklist: ['里番'] } }).rule!;

  const home = await engine.home(rule, { action: 'home' }, ctxOf(http));
  const optNames = (home.filters?.[0]?.options ?? []).map((o) => o.name);
  assert.deepEqual(optNames, ['电影'], '按名命中的分类不出现在 chips 里');
  assert.deepEqual(home.items.map((i) => i.id), ['11'], '推荐位卡片同步剔除');

  const cat = await engine.category(rule, { action: 'category', filters: { t: '1' } }, ctxOf(http));
  assert.deepEqual(cat.items.map((i) => i.id), ['11'], '分类列表同步剔除（按 type_name 命中）');

  const search = await engine.search(rule, { action: 'search', keyword: 'x' }, ctxOf(http));
  assert.deepEqual(search.items.map((i) => i.id), ['11'], '搜索结果同样剔除');
});

test('③b cms.blacklist 也认分类 id；blackId 与 blacklist 互不误伤', async () => {
  const http = mockHttp(() => LIST_BODY);
  // 分类 id=39 屏蔽（等价于勾掉「里番」）
  const byId = engine.compile({ name: 'c', apiUrl: API, cms: { blacklist: ['39'] } }).rule!;
  const r1 = await engine.home(byId, { action: 'home' }, ctxOf(http));
  assert.deepEqual(r1.items.map((i) => i.id), ['11'], '按 id 命中同样屏蔽');

  /**
   * ★ 这条是「为什么不能把两个字段合成一个列表」的证明：
   * 分类 id 与 vod_id 都是小整数 —— `blacklist: ['1']` 若顺带当 vod_id 用，
   * 就会把 `vod_id=1` 的片子也屏蔽掉（而用户只想屏蔽分类 1）。
   */
  const http2 = mockHttp(() => ({
    code: 1,
    class: [{ type_id: 1, type_name: '电影' }],
    list: [
      { vod_id: 1, vod_name: 'vod_id 与分类 id 撞号', type_id: 1, type_name: '电影' },
      { vod_id: 2, vod_name: '正常', type_id: 1, type_name: '电影' },
    ],
  }));
  const catRule = engine.compile({ name: 'd', apiUrl: API, cms: { blacklist: ['999'] } }).rule!;
  const r2 = await engine.category(catRule, { action: 'category', filters: { t: '1' } }, ctxOf(http2));
  assert.deepEqual(r2.items.map((i) => i.id), ['1', '2'], '分类没被屏蔽时，vod_id 不该被分类黑名单误伤');

  // 只有 blackId 才剔片子
  const http3 = mockHttp(() => LIST_BODY);
  const idRule = engine.compile({ name: 'e', apiUrl: API, cms: { blackId: ['99'] } }).rule!;
  const r3 = await engine.home(idRule, { action: 'home' }, ctxOf(http3));
  assert.deepEqual(r3.items.map((i) => i.id), ['11'], 'blackId 命中 vod_id=99');
  assert.equal(r3.filters?.[0]?.options.length, 2, 'blackId 不影响分类清单');
});
