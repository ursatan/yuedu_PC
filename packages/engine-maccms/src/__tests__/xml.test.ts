/**
 * MacCMS XML 接口测试（离线，不触网）
 *
 * 覆盖：isXmlText 判定、cmsXmlToJson（分类/列表/分页/详情播放组），
 * 以及引擎 raw() 走 XML 分支后的 home/detail 全链（mock http 返回 XML）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
} from '@yuedu/core';
import { MacCmsEngine } from '../engine';
import { isXmlText, cmsXmlToJson } from '../xml';

const LIST_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1">
  <class>
    <type id="1">电影</type>
    <type id="2">电视剧</type>
  </class>
  <list page="1" pagecount="9" recordcount="120" pagesize="20">
    <video>
      <id>101</id><tid>1</tid><name>测试电影A</name><pic>http://x/a.jpg</pic><note>HD</note>
      <year>2024</year><area>大陆</area><director>张三</director><actor>甲,乙</actor>
      <content>简介A</content>
    </video>
    <video>
      <id>102</id><tid>2</tid><name>测试剧B</name><pic>http://x/b.jpg</pic><note>连载至10集</note>
      <dl>
        <dd flag="qq">第01集$http://v/1.m3u8#第02集$http://v/2.m3u8</dd>
        <dd flag="m3u8">全集$http://v/all.m3u8</dd>
      </dl>
    </video>
  </list>
</rss>`;

const DETAIL_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1">
  <list page="1" pagecount="1" recordcount="1">
    <video>
      <id>102</id><tid>2</tid><name>测试剧B</name><pic>http://x/b.jpg</pic><note>连载至10集</note>
      <director>李四</director><actor>丙,丁</actor><content>简介B</content>
      <dl>
        <dd flag="qq">第01集$http://v/1.m3u8#第02集$http://v/2.m3u8</dd>
        <dd flag="m3u8">全集$http://v/all.m3u8</dd>
      </dl>
    </video>
  </list>
</rss>`;

test('isXmlText 判定', () => {
  assert.ok(isXmlText('<?xml version="1.0"?><rss>..</rss>'));
  assert.ok(isXmlText('<rss version="5.1">'));
  assert.ok(!isXmlText('{"code":1}'));
});

test('cmsXmlToJson：分类 + 分页 + 列表映射', () => {
  const j = cmsXmlToJson(LIST_XML);
  assert.equal(j.code, 1);
  assert.deepEqual(j.class, [
    { type_id: '1', type_name: '电影' },
    { type_id: '2', type_name: '电视剧' },
  ]);
  assert.equal(j.page, 1);
  assert.equal(j.pagecount, 9);
  assert.equal(j.total, 120);
  assert.equal(j.list?.length, 2);
  const a = j.list![0]! as Record<string, unknown>;
  assert.equal(a['vod_id'], '101');
  assert.equal(a['vod_name'], '测试电影A');
  assert.equal(a['vod_pic'], 'http://x/a.jpg');
  assert.equal(a['vod_remarks'], 'HD');
  // tid=1 → class 回填 type_name
  assert.equal(a['type_name'], '电影');
  // 无 dl 的条目不给播放字段
  assert.equal(a['vod_play_from'], undefined);
  const b = j.list![1]! as Record<string, unknown>;
  assert.equal(b['vod_play_from'], 'qq$$$m3u8');
  assert.equal(b['vod_play_url'], '第01集$http://v/1.m3u8#第02集$http://v/2.m3u8$$$全集$http://v/all.m3u8');
});

test('引擎 raw() XML 分支：home/detail 走通（mock http 返回 XML）', async () => {
  const http: HttpClient = {
    async request(url: string) {
      return {
        status: 200,
        headers: {},
        body: /ids=/.test(url) ? DETAIL_XML : LIST_XML,
      } as unknown as ReturnType<HttpClient['request']>;
    },
  };
  const noopSandbox = { eval: async () => undefined } as unknown as JsSandboxPool;
  const ctx = {
    http,
    vars: createVariableStore(),
    kv: createMemoryKeyValueStore(),
    cookies: { get: async () => undefined, set: async () => {}, header: () => undefined },
    sourceId: 'xml-test',
    trace: createTraceSink(),
    sandbox: noopSandbox,
  } as unknown as EngineContext;

  const eng = new MacCmsEngine();
  const rule = eng.compile({ name: 'xml源', apiUrl: 'https://x.com/api.php/provide/at/xml/' }).rule!;
  assert.equal(rule.format, 'xml', 'apiUrl 含 at/xml 应推断 format=xml');

  const home = await eng.home(rule, { action: 'home' }, ctx);
  assert.equal(home.filters?.[0]?.options.length, 2);
  assert.equal(home.items.length, 2);
  assert.equal(home.items[0]!.title, '测试电影A');

  const detail = await eng.detail(rule, { action: 'detail', id: '102' }, ctx);
  assert.equal(detail.title, '测试剧B');
  // dd flag="qq" 2 集 + dd flag="m3u8" 1 集 = 3 章
  assert.equal(detail.chapters?.length, 3);
  assert.equal(detail.chapters?.[0]?.title, '第01集');
});

test('detail 的 id 为 JSON payload 时解出纯 vod_id', async () => {
  const seenUrls: string[] = [];
  const http: HttpClient = {
    async request(url: string) {
      seenUrls.push(url);
      return { status: 200, headers: {}, body: DETAIL_XML } as unknown as ReturnType<HttpClient['request']>;
    },
  };
  const noopSandbox = { eval: async () => undefined } as unknown as JsSandboxPool;
  const ctx = {
    http,
    vars: createVariableStore(),
    kv: createMemoryKeyValueStore(),
    cookies: { get: async () => undefined, set: async () => {}, header: () => undefined },
    sourceId: 'xml-test',
    trace: createTraceSink(),
    sandbox: noopSandbox,
  } as unknown as EngineContext;

  const eng = new MacCmsEngine();
  const rule = eng.compile({ name: 'xml源', apiUrl: 'https://x.com/api.php/provide/at/xml/' }).rule!;
  // 前端统一契约：id = JSON.stringify(payload)
  await eng.detail(rule, { action: 'detail', id: JSON.stringify({ vod_id: '193483' }) }, ctx);
  const detailUrl = seenUrls.find((u) => u.includes('ac=detail'));
  assert.ok(detailUrl?.includes('ids=193483'), `ids 参数应为纯 vod_id，实际: ${detailUrl}`);
  assert.ok(!detailUrl?.includes('%7B'), '不应把 JSON 花括号带进 ids');
});
