/**
 * MacCMS（苹果CMS）引擎离线测试（mock http，不触网）
 *
 * 覆盖：detect/compile、播放链解析（§6.4）、五个动作、封面降级（§6.3）、ac=list 降级（§6.1）。
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
import { parsePlayList, inferFormat } from '../playlist';
import { hasClassContent, hasListContent } from '../normalize';
import type { CmsResponse } from '../model/cms-source';

const noopSandbox = { eval: async () => undefined } as unknown as JsSandboxPool;

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 't',
    sourceId: 't',
    signal: new AbortController().signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

/** mock http：url 命中某个 key 子串即返回对应内容（CmsResponse 自动 JSON 序列化，string 原样返回用于模拟 HTML 反爬页） */
function mockHttp(map: Record<string, CmsResponse | string>): HttpClient {
  return {
    async request(url: string) {
      for (const key of Object.keys(map)) {
        if (url.includes(key)) {
          const v = map[key];
          const body = typeof v === 'string' ? v : JSON.stringify(v);
          return { status: 200, headers: {}, body, url };
        }
      }
      throw new Error(`no mock for ${url}`);
    },
  };
}

const SOURCE = { name: '测试站', api: 'https://api.example.com/api.php/provide/vod/' };

const engine = new MacCmsEngine();

test('detect / compile：识别 MacCMS（苹果CMS）源，归一 api→apiUrl', () => {
  assert.equal(engine.detect(SOURCE), true);
  assert.equal(engine.detect({ bookSourceUrl: 'x', searchUrl: 'y' }), false); // Legado
  assert.equal(engine.detect({ rule: 'function search(){}' }), false); // ZYFun
  const c = engine.compile(SOURCE);
  assert.equal(c.ok, true);
  assert.equal(c.rule?.apiUrl, 'https://api.example.com/api.php/provide/vod');
});

test('parsePlayList：$$$ / # / $ 三层，只切第一个 $', () => {
  const from = 'm3u8$$$mp4';
  const url = '第1集$https://a.com/1.m3u8#第2集$https://a.com/2.m3u8$$$第1集$https://a.com/1.mp4#第2集$https://a.com/2.mp4';
  const plays = parsePlayList(from, url);
  assert.equal(plays.length, 2);
  assert.equal(plays[0]!.from, 'm3u8');
  assert.equal(plays[0]!.episodes.length, 2);
  assert.equal(plays[0]!.episodes[0]!.text, '第1集');
  assert.equal(plays[0]!.episodes[0]!.link, 'https://a.com/1.m3u8');
  // 关键：URL 自带 $ 不被截断
  const trickyUrl = '正片$https://b.com/play?t=1$sign=abc';
  const p2 = parsePlayList('m3u8', trickyUrl);
  assert.equal(p2[0]!.episodes[0]!.link, 'https://b.com/play?t=1$sign=abc');
  // 无 $ 默认「正片」
  const p3 = parsePlayList('m3u8', 'https://c.com/x.mp4');
  assert.equal(p3[0]!.episodes[0]!.text, '正片');
});

test('inferFormat：按后缀判断', () => {
  assert.equal(inferFormat('https://a.com/1.m3u8'), 'm3u8');
  assert.equal(inferFormat('https://a.com/1.mp4'), 'mp4');
  assert.equal(inferFormat('https://a.com/1.mp3'), 'audio');
  assert.equal(inferFormat('https://a.com/parse?id=9'), 'unknown');
});

test('home：ac=class 返回分类 + 推荐', async () => {
  const http = mockHttp({
    'ac=class': {
      code: 1,
      class: [{ type_id: '1', type_name: '电影' }, { type_id: '2', type_name: '电视剧' }],
      list: [{ vod_id: 100, vod_name: '推荐片', vod_pic: 'https://p/1.jpg' }],
    },
  });
  const r = await engine.home(engine.compile(SOURCE).rule!, { action: 'home' }, makeCtx(http));
  assert.equal(r.filters?.[0]!.key, 't');
  assert.equal(r.filters?.[0]!.options.length, 2);
  assert.equal(r.items[0]!.title, '推荐片');
});

test('category：ac=videolist&t=1', async () => {
  const http = mockHttp({
    'ac=videolist&pg=1&t=1': {
      code: 1,
      page: 1,
      pagecount: 3,
      total: 60,
      list: [
        { vod_id: 1, vod_name: '电影A', vod_pic: 'https://p/a.jpg', vod_remarks: 'HD' },
        { vod_id: 2, vod_name: '电影B', vod_pic: 'https://p/b.jpg' },
      ],
    },
  });
  const r = await engine.category(
    engine.compile(SOURCE).rule!,
    { action: 'category', filters: { t: '1' }, page: 1 },
    makeCtx(http),
  );
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]!.subtitle, 'HD');
  assert.equal(r.page.pageCount, 3);
  assert.equal(r.page.hasMore, true);
});

test('`#479` 黑名单：home 分类与 category 卡片按 type_id/type_name 屏蔽', async () => {
  const http = mockHttp({
    'ac=class': {
      code: 1,
      class: [
        { type_id: '1', type_name: '电影' },
        { type_id: '2', type_name: '电视剧' },
        { type_id: '3', type_name: '福利' },
      ],
      list: [{ vod_id: 100, vod_name: '推荐片', vod_pic: 'https://p/1.jpg' }],
    },
    'ac=videolist&pg=1&t=1': {
      code: 1,
      page: 1,
      pagecount: 1,
      total: 2,
      list: [
        { vod_id: 1, vod_name: '电影A', vod_pic: 'https://p/a.jpg', type_id: 1 },
        { vod_id: 9, vod_name: '屏蔽片', vod_pic: 'https://p/x.jpg', type_id: 3 },
      ],
    },
  });
  // 黑名单：id 3 与名字「电视剧」都命中（数组形态 + zyfun 兼容 categories 同法）
  const rule = engine.compile({ ...SOURCE, blacklist: ['3', '电视剧'] }).rule!;
  const h = await engine.home(rule, { action: 'home' }, makeCtx(http));
  const names = (h.filters?.[0]!.options ?? []).map((o) => o.name);
  assert.deepEqual(names, ['电影'], 'id=3 与「电视剧」都应被屏蔽');
  const c = await engine.category(rule, { action: 'category', filters: { t: '1' }, page: 1 }, makeCtx(http));
  assert.equal(c.items.length, 1, 'type_id=3 的卡片应被过滤');
  assert.equal(c.items[0]!.title, '电影A');
  // 字符串形态（工坊表单逗号分隔）+ zyfun 兼容字段 categories
  const rule2 = engine.compile({ ...SOURCE, categories: '3,电视剧' }).rule!;
  const h2 = await engine.home(rule2, { action: 'home' }, makeCtx(http));
  assert.equal(h2.filters?.[0]!.options.length, 1);
});

test('search：ac=videolist&wd=关键词', async () => {
  const http = mockHttp({
    'ac=videolist&wd=': {
      code: 1,
      list: [{ vod_id: 9, vod_name: '搜到的片', vod_pic: 'https://p/s.jpg' }],
    },
  });
  const r = await engine.search(
    engine.compile(SOURCE).rule!,
    { action: 'search', keyword: '关键词' },
    makeCtx(http),
  );
  assert.equal(r.items[0]!.title, '搜到的片');
});

test('search 缺少 keyword 抛 SOURCE_INVALID', async () => {
  const http = mockHttp({});
  await assert.rejects(
    () => engine.search(engine.compile(SOURCE).rule!, { action: 'search' }, makeCtx(http)),
    (e: any) => e.code === 'SOURCE_INVALID',
  );
});

test('detail：解析播放链为 chapters', async () => {
  const http = mockHttp({
    'ac=detail&ids=5': {
      code: 1,
      list: [
        {
          vod_id: 5,
          vod_name: '某剧',
          vod_pic: 'https://p/5.jpg',
          vod_remarks: '更新至10集',
          vod_year: '2024',
          vod_area: '美国',
          vod_director: '张三',
          vod_actor: '李四',
          vod_play_from: 'm3u8$$$mp4',
          vod_play_url: '第1集$https://a/1.m3u8#第2集$https://a/2.m3u8$$$第1集$https://a/1.mp4',
        },
      ],
    },
  });
  const d = await engine.detail(engine.compile(SOURCE).rule!, { action: 'detail', id: '5' }, makeCtx(http));
  assert.equal(d.title, '某剧');
  assert.equal(d.meta?.['年份'], '2024');
  assert.equal(d.meta?.['地区'], '美国');
  assert.equal(d.chapters?.length, 3);
  assert.equal(d.chapters?.[0]!.title, '第1集');
  assert.equal((d.chapters?.[0]!.payload as any).from, 'm3u8');
  assert.equal((d.chapters?.[1]!.payload as any).from, 'm3u8');
  assert.equal((d.chapters?.[2]!.payload as any).from, 'mp4');
});

test('play：直链 m3u8 直接返回', async () => {
  const http = mockHttp({});
  const p = await engine.play(
    engine.compile(SOURCE).rule!,
    { action: 'play', extra: { playRaw: 'https://a/1.m3u8' } },
    makeCtx(http),
  );
  assert.equal(p.url, 'https://a/1.m3u8');
  assert.equal(p.format, 'm3u8');
});

test('play：json: 前缀再解析', async () => {
  const http = mockHttp({
    'resolve.example.com/?url=': { code: 1, url: 'https://real.com/stream.m3u8' },
  });
  const p = await engine.play(
    engine.compile({ ...SOURCE, playUrl: 'json:https://resolve.example.com/?url=' }).rule!,
    { action: 'play', extra: { playRaw: 'encXYZ' } },
    makeCtx(http),
  );
  assert.equal(p.url, 'https://real.com/stream.m3u8');
});

test('封面降级（§6.3）：列表无封面 → 批量补 detail', async () => {
  const http = mockHttp({
    'ac=videolist&wd=': {
      code: 1,
      list: [
        { vod_id: 1, vod_name: '无封面片' }, // 注意：无 vod_pic
      ],
    },
    'ac=detail&ids=1': {
      code: 1,
      list: [{ vod_id: 1, vod_name: '无封面片', vod_pic: 'https://p/fixed.jpg' }],
    },
  });
  const r = await engine.search(
    engine.compile(SOURCE).rule!,
    { action: 'search', keyword: 'x' },
    makeCtx(http),
  );
  assert.equal(r.items[0]!.cover, 'https://p/fixed.jpg');
});

test('封面降级（§6.3）：多条目无封面 → 按 vod_id 逐条补齐，**不得把列表塌成 1 条**', async () => {
  const http = mockHttp({
    'ac=videolist&wd=': {
      code: 1,
      list: [
        { vod_id: 1, vod_name: 'A' },
        { vod_id: 2, vod_name: 'B' },
        { vod_id: 3, vod_name: 'C' },
      ],
    },
    // 键用前缀匹配：`URLSearchParams` 会把逗号编码成 %2C（真实站点接受，见 e2e 验证）
    'ac=detail&ids=': {
      code: 1,
      list: [
        { vod_id: 1, vod_name: 'A', vod_pic: 'https://p/1.jpg' },
        { vod_id: 2, vod_name: 'B', vod_pic: 'https://p/2.jpg' },
        // 3 故意缺失：应保持原样（title 仍是列表里的值）
      ],
    },
  });
  const r = await engine.search(engine.compile(SOURCE).rule!, { action: 'search', keyword: 'x' }, makeCtx(http));
  assert.equal(r.items.length, 3, `条数必须保持 3（旧实现会塌成 1 条），实际 ${r.items.length}`);
  assert.deepEqual(
    r.items.map((i) => i.title),
    ['A', 'B', 'C'],
  );
  assert.equal(r.items[0]!.cover, 'https://p/1.jpg');
  assert.equal(r.items[1]!.cover, 'https://p/2.jpg');
  assert.equal(r.items[2]!.cover, undefined, '详情里没有的条目应保持原样，不臆造');
});

test('ac=list 降级（§6.1）：videolist 失败 → list 成功', async () => {
  const http = mockHttp({
    'ac=videolist&wd=': { code: 0, msg: 'fail' }, // 模拟主接口失败
    'ac=list&wd=': {
      code: 1,
      list: [{ vod_id: 7, vod_name: 'list降级片', vod_pic: 'https://p/l.jpg' }],
    },
  });
  const r = await engine.search(
    engine.compile(SOURCE).rule!,
    { action: 'search', keyword: 'x' },
    makeCtx(http),
  );
  assert.equal(r.items[0]!.title, 'list降级片');
});

test('兼容性 V4：status:200 + page 对象 + data 数组（用户现场形态）', async () => {
  const http = mockHttp({
    'ac=videolist&wd=': {
      status: 200,
      page: { pageindex: '1', pagecount: '122', pagesize: '20', recordcount: '2438' },
      data: [{ vod_id: 285277, vod_name: '现场片', vod_pic: 'https://p/v4.jpg' }],
    } as any,
  });
  const r = await engine.search(engine.compile(SOURCE).rule!, { action: 'search', keyword: 'x' }, makeCtx(http));
  assert.equal(r.items[0]!.title, '现场片');
  assert.equal(r.page.pageCount, 122);
  assert.equal(r.page.total, 2438);
});

test('兼容性 V3：status:200 + data.list 嵌套', async () => {
  const http = mockHttp({
    'ac=videolist&pg=1&t=1': {
      status: 200,
      data: { page: 1, pagecount: 5, total: 100, list: [{ vod_id: 1, vod_name: '嵌套片', vod_pic: 'https://p/n.jpg' }] },
    } as any,
  });
  const r = await engine.category(
    engine.compile(SOURCE).rule!,
    { action: 'category', filters: { t: '1' }, page: 1 },
    makeCtx(http),
  );
  assert.equal(r.items[0]!.title, '嵌套片');
  assert.equal(r.page.pageCount, 5);
});

test('兼容性 V1：code:1 + data.list 嵌套（详情）', async () => {
  const http = mockHttp({
    'ac=detail&ids=9': {
      code: 1,
      data: {
        list: [{ vod_id: 9, vod_name: 'v1片', vod_pic: 'https://p/v1.jpg', vod_play_from: 'm3u8', vod_play_url: 'E1$https://a/1.m3u8' }],
      },
    } as any,
  });
  const d = await engine.detail(engine.compile(SOURCE).rule!, { action: 'detail', id: '9' }, makeCtx(http));
  assert.equal(d.title, 'v1片');
  assert.equal(d.chapters?.length, 1);
});

test('反爬/验证页：返回 HTML → 抛 ANTI_BOT', async () => {
  const http = mockHttp({
    'ac=videolist&wd=':
      '<html><body>本网站使用安全服务防护恶意自动程序。在验证您不是自动程序期间，将显示此页面。</body></html>',
  });
  await assert.rejects(
    () => engine.search(engine.compile(SOURCE).rule!, { action: 'search', keyword: 'x' }, makeCtx(http)),
    (e: any) => e.code === 'ANTI_BOT',
  );
});

test('搜索被禁：code=1002 / 暂不支持搜索 → 优雅返回空', async () => {
  const http = mockHttp({ 'ac=videolist&wd=': { code: 1002, msg: 'Current API forbids keyword search.' } });
  const r = await engine.search(engine.compile(SOURCE).rule!, { action: 'search', keyword: 'x' }, makeCtx(http));
  assert.equal(r.items.length, 0);

  const http2 = mockHttp({ 'ac=videolist&wd=': { code: 0, msg: '暂不支持搜索' } });
  const r2 = await engine.search(engine.compile(SOURCE).rule!, { action: 'search', keyword: 'x' }, makeCtx(http2));
  assert.equal(r2.items.length, 0);
});

test('选集 crlf 格式', () => {
  const url = 'm3u8\r\n第1集,https://a/1.m3u8\r\n第2集,https://a/2.m3u8';
  const plays = parsePlayList('m3u8', url, { split: 'crlf' });
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.from, 'm3u8');
  assert.equal(plays[0]!.episodes.length, 2);
  assert.equal(plays[0]!.episodes[0]!.link, 'https://a/1.m3u8');
});

test('选集 colon 格式', () => {
  const url = 'm3u8|||第1集:https://a/1.m3u8|||第2集:https://a/2.m3u8';
  const plays = parsePlayList('m3u8', url, { split: 'colon' });
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.episodes.length, 2);
  assert.equal(plays[0]!.episodes[1]!.link, 'https://a/2.m3u8');
});

test('源开关：searchEnabled=false → search 返回空', async () => {
  const http = mockHttp({});
  const rule = { ...engine.compile(SOURCE).rule!, state: { searchEnabled: false } };
  const r = await engine.search(rule, { action: 'search', keyword: 'x' }, makeCtx(http));
  assert.equal(r.items.length, 0);
});

test('源开关：enabled=false → category 返回空', async () => {
  const http = mockHttp({});
  const rule = { ...engine.compile(SOURCE).rule!, state: { enabled: false } };
  const r = await engine.category(rule, { action: 'category', filters: { t: '1' }, page: 1 }, makeCtx(http));
  assert.equal(r.items.length, 0);
});

test('自定义参数名 + ac 值：acParam=do / wdParam=q / acList=list 站点', async () => {
  const http = mockHttp({
    'do=list&q=': {
      code: 1,
      list: [{ vod_id: 3, vod_name: '自定义参数片', vod_pic: 'https://p/c.jpg' }],
    },
  });
  const rule = { ...engine.compile(SOURCE).rule!, acParam: 'do', wdParam: 'q', acList: 'list' };
  const r = await engine.search(rule, { action: 'search', keyword: 'x' }, makeCtx(http));
  assert.equal(r.items[0]!.title, '自定义参数片');
});

test('vod_url 兜底：vod_play_url 为空时用 vod_url', () => {
  const plays = parsePlayList('默认线路', undefined, { vodUrl: '第1集$https://a/1.m3u8#第2集$https://a/2.m3u8' });
  assert.equal(plays.length, 1);
  assert.equal(plays[0]!.from, '默认线路');
  assert.equal(plays[0]!.episodes.length, 2);
});

test('分类伪装成 list：status:200 + list[].list_id/list_name → 解析为 filters（兼容 Legado 影视聚合源 结构1）', async () => {
  const http = mockHttp({
    'ac=class': {
      status: 200,
      page: { pageindex: '1', pagecount: '1' },
      list: [
        { list_id: 1, list_name: '电影' },
        { list_id: 2, list_name: '电视剧' },
        { list_id: 3, list_name: '综艺', type_pid: 0 },
      ],
    } as any,
  });
  const r = await engine.home(engine.compile(SOURCE).rule!, { action: 'home' }, makeCtx(http));
  assert.equal(r.filters?.[0]!.key, 't');
  assert.equal(r.filters?.[0]!.options.length, 3);
  assert.equal(r.filters?.[0]!.options[0]!.name, '电影');
  assert.equal(r.filters?.[0]!.options[0]!.value, '1');
  // 关键：分类数组不应被误当成 vod 列表
  assert.equal(r.items.length, 0);
});

test('compile：缺协议补全 https + 去尾部斜杠（对齐 Legado 源 cleanApi 处理）', () => {
  const c = engine.compile({ name: 'x', api: 'www.example.com/api/provide/vod/' });
  assert.equal(c.ok, true);
  assert.equal(c.rule?.apiUrl, 'https://www.example.com/api/provide/vod');
});

/* ── 分类列表兼容（2026-09-21 用户报告：`ac=list` 返回 class + list 时「分类获取失败」）──────────
 *
 * 现场（`api.xjzyapi.com` 小鸡资源，实测）：
 *   · `ac=class` → `{code,limit,list:[20 条 vod]}` —— **没有 class**（该动作在标准 maccms 里不存在）
 *   · `ac=list`  → `class:38 条 + list:20 条 + page/pagecount/total`（标准形态，且支持 t/pg/wd）
 * 旧逻辑在 home() 用 `hasListContent` 判「主请求可用」→ `ac=class` 因 list 有内容而"通过"、不再降级
 * → `classes` 为空 → 前端没有分类。修法：取分类改用 `hasClassContent` 判定 + 候选 ac 逐个尝试。
 */

const XJZY_CLASS = [
  { type_id: 1, type_name: '国产自拍', type_pid: 0 },
  { type_id: 2, type_name: '日韩AV', type_pid: 0 },
];
const XJZY_VOD = [{ vod_id: 106469, vod_name: '李素英合1', vod_pic: 'https://p/1.jpg' }];

test('hasClassContent：区分「有分类」与「只有视频列表」（ac=class 的坑），并识别 list 即分类的结构', () => {
  assert.equal(hasClassContent({ class: XJZY_CLASS }), true);
  assert.equal(hasClassContent({ code: 1, limit: 20, list: XJZY_VOD }), false);
  // 旧判定（仍在用，但只表达"有内容"）会把上一种也算"有内容" —— 这正是踩坑点
  assert.equal(hasListContent({ code: 1, limit: 20, list: XJZY_VOD }), true);
  // list[] 自身就是分类（结构1）
  assert.equal(hasClassContent({ list: [{ list_id: 5, list_name: '电影' }] }), true);
});

test('home：分类在 ac=list 里（标准 maccms / 小鸡资源形态）—— ac=class 只有视频时不得当成"拿到分类"', async () => {
  const http = mockHttp({
    'ac=class': { code: 1, limit: 20, list: XJZY_VOD }, // 只有视频
    'ac=list': { class: XJZY_CLASS, code: 1, limit: 20, list: XJZY_VOD }, // 分类 + 短列表
  });
  const r = await engine.home(engine.compile(SOURCE).rule!, { action: 'home' }, makeCtx(http));
  assert.equal(r.filters?.[0]!.key, 't');
  assert.equal(r.filters?.[0]!.options.length, 2);
  assert.equal(r.filters?.[0]!.options[0]!.name, '国产自拍');
  assert.equal(r.filters?.[0]!.options[0]!.value, '1');
  assert.equal(r.items[0]!.title, '李素英合1');
});

test('home：源显式配 acClass 但站点不实现该动作（返错）→ 容忍失败，继续用 ac=list 取分类', async () => {
  const http = mockHttp({ 'ac=list': { class: XJZY_CLASS, code: 1, list: XJZY_VOD } });
  const rule = engine.compile({ ...SOURCE, acClass: 'class' }).rule!;
  const r = await engine.home(rule, { action: 'home' }, makeCtx(http));
  assert.equal(r.filters?.[0]!.options.length, 2);
  assert.equal(r.items[0]!.title, '李素英合1');
});

test('home：所有候选都不含 class → 不给 filters 但仍返回推荐（不报错、不静默变空）', async () => {
  const http = mockHttp({
    'ac=list': { code: 1, list: XJZY_VOD },
    'ac=class': { code: 1, list: XJZY_VOD },
  });
  const r = await engine.home(engine.compile(SOURCE).rule!, { action: 'home' }, makeCtx(http));
  assert.equal(r.filters, undefined);
  assert.equal(r.items.length, 1);
});

test('home：所有候选都失败 → 报错（不静默返回空首页）', async () => {
  const http = mockHttp({ 'ac=never-matched': { code: 0 } });
  await assert.rejects(() => engine.home(engine.compile(SOURCE).rule!, { action: 'home' }, makeCtx(http)), /no mock for/);
});
