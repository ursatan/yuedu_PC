import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectRssSource, compileRssSource, parseRssDefaultXml, htmlToParagraphs, extractImageUrls, fillUrlTemplate } from './index';
import { RssEngine } from './engine';
import type { RssSourceRaw } from './model/rss-source';

// ---------------------------------------------------------------------------
// detect / compile（判别依据 = 语料实测：无 sourceKind，靠特征字段）
// ---------------------------------------------------------------------------

test('detect：RSS 特征字段（ruleArticles/sortUrl/articleStyle）可识别', () => {
  assert.equal(detectRssSource({ sourceUrl: 'https://a.com/feed', ruleArticles: 'ul@li' }), true);
  assert.equal(detectRssSource({ sourceUrl: 'https://a.com/feed', sortUrl: 'https://a.com/feed' }), true);
  assert.equal(detectRssSource({ sourceUrl: 'https://a.com/feed', articleStyle: 2 }), true);
});

test('detect：书源主键 bookSourceUrl 存在时排除（即使混入 RSS 特征）', () => {
  assert.equal(detectRssSource({ bookSourceUrl: 'https://a.com', ruleArticles: 'x' }), false);
});

test('detect：纯书源形状不误判', () => {
  assert.equal(detectRssSource({ bookSourceUrl: 'https://a.com', sourceName: 'x' }), false);
  assert.equal(detectRssSource({}), false);
  assert.equal(detectRssSource(null), false);
});

test('compile：默认值对齐上游主构造器（type=0 / articleStyle=0 / enabledCookieJar=true）', () => {
  const r = compileRssSource({ sourceUrl: 'https://a.com/feed', sourceName: '测试' } as RssSourceRaw);
  assert.equal(r.type, 0);
  assert.equal(r.articleStyle, 0);
  assert.equal(r.enabled, true);
  assert.equal(r.enabledCookieJar, true);
  assert.equal(r.ruleArticles, null);
  assert.equal(r.singleUrlOnly, false);
  assert.deepEqual(r.webViewFeatures, { startHtml: false, shouldOverrideUrlLoading: false, injectJs: false, preloadJs: false });
});

// ★ `#317` 旧锁已反转：`#307` 的 `webViewOnly` 把「无 ruleArticles 且有 webView 字段」判整源拒绝。
//   上游（逐行核实）没有这个门控：`startHtml`/`shouldOverrideUrlLoading` 只作用于渲染层
//   （`ReadRssActivity.loadStartHtml` / 页面内跳转拦截），`singleUrl` 是「单 URL 源」能力位
//   （`RssFragment.openRss:183` → `getSingleUrl` → `ReadRssActivity.start`）。
test('compile：webView 字段只进 webViewFeatures 注记（不门控）；singleUrl ⇒ singleUrlOnly', () => {
  const withStartHtml = compileRssSource({ sourceUrl: 'https://b.com', sourceName: 'b', startHtml: '<html/>' } as RssSourceRaw);
  assert.equal(withStartHtml.webViewFeatures.startHtml, true);
  assert.equal(withStartHtml.singleUrlOnly, false); // 有 startHtml ≠ 单 URL 源（两回事）

  const single = compileRssSource({ sourceUrl: 'https://www.24ao.cc', singleUrl: true } as RssSourceRaw);
  assert.equal(single.singleUrlOnly, true); // 上游语义：把它当「一篇文章」打开
  assert.deepEqual(single.webViewFeatures, { startHtml: false, shouldOverrideUrlLoading: false, injectJs: false, preloadJs: false });

  const both = compileRssSource({ sourceUrl: 'https://c.com', singleUrl: true, shouldOverrideUrlLoading: 'js', injectJs: 'x' } as RssSourceRaw);
  assert.equal(both.singleUrlOnly, true);
  assert.equal(both.webViewFeatures.shouldOverrideUrlLoading, true);
  assert.equal(both.webViewFeatures.injectJs, true);
});

test('语料实测：330 个 RSS 源 detect 全命中、compile 不抛', () => {
  /**
   * `#651` 语料只剩一处：`data/seed/rssSource.json`（单个数组）。
   * 原来是 `tests/fixtures/sources/rss/*.json`（330 个文件），该目录已随 `tests/` 整体删除。
   * 该语料是第三方订阅源的转载集，**不进公开仓库**（`git rm --cached`，本地自备）
   * ⇒ 缺失时跳过本用例，而不是 ENOENT 失败。
   */
  const corpusFile = join(import.meta.dirname, '../../../data/seed/rssSource.json');
  if (!existsSync(corpusFile)) {
    console.log(`[语料实测] 跳过：${corpusFile} 不在仓库内（本地自备）`);
    return;
  }
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
  const list = Array.isArray(corpus) ? corpus : [corpus];
  let total = 0;
  let detected = 0;
  const undetected: string[] = [];
  for (const raw of list) {
    total++;
    if (detectRssSource(raw)) {
      detected++;
      assert.doesNotThrow(() => compileRssSource(raw as RssSourceRaw));
    } else {
      undetected.push(String(raw?.sourceName ?? raw?.sourceUrl));
    }
  }
  assert.ok(total >= 300, `语料总量异常: ${total}`);
  // detect 覆盖率：至少 95%（剩余为畸形源，登记不猜测）
  assert.ok(
    detected / total >= 0.95,
    `detect 覆盖率 ${(detected / total).toFixed(3)}（${detected}/${total}）不足；未识别样例: ${undetected.slice(0, 5).join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// parseRssDefaultXml（RssParserDefault 移植）
// ---------------------------------------------------------------------------

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>示例站</title>
<item>
  <title><![CDATA[第一篇: 带图文章]]></title>
  <link>https://a.com/1</link>
  <media:thumbnail url="https://img.a.com/t1.jpg"/>
  <description><![CDATA[<p>摘要一 <b>加粗</b></p>]]></description>
  <content:encoded><![CDATA[<p>正文一</p><p>段落二</p>]]></content:encoded>
  <pubDate>Mon, 06 Oct 2026 08:00:00 GMT</pubDate>
</item>
<item>
  <title>第二篇: enclosure 图</title>
  <link>https://a.com/2</link>
  <enclosure url="https://img.a.com/e1.png" type="image/png" length="1"/>
  <description>&lt;p&gt;实体摘要&lt;/p&gt;&lt;img src="https://img.a.com/d1.jpg"&gt;</description>
</item>
<item>
  <title>第三篇: 描述抠首图</title>
  <link>https://a.com/3</link>
  <description><img src="https://img.a.com/desc.jpg"> 无 enclosure</description>
</item>
<item>
  <title>第四篇: 嵌套日期跳过 + time 兜底</title>
  <link>https://a.com/4</link>
  <description>纯文本</description>
  <pubDate><invalid/></pubDate>
  <time>2026-10-06</time>
</item>
</channel></rss>`;

test('parseRssDefaultXml：字段映射与图片四级优先级', () => {
  const { articles, nextUrl } = parseRssDefaultXml(SAMPLE_XML, 'https://a.com/feed', '订阅');
  assert.equal(nextUrl, null);
  assert.equal(articles.length, 4);

  // 第一篇：media:thumbnail 优先于描述/正文首图
  assert.equal(articles[0]!.title, '第一篇: 带图文章');
  assert.equal(articles[0]!.image, 'https://img.a.com/t1.jpg');
  assert.equal(articles[0]!.description, '<p>摘要一 <b>加粗</b></p>');
  assert.equal(articles[0]!.pubDate, 'Mon, 06 Oct 2026 08:00:00 GMT');
  assert.equal(articles[0]!.origin, 'https://a.com/feed');
  assert.equal(articles[0]!.sort, '订阅');

  // 第二篇：无 thumbnail → enclosure(image/*)；描述是实体编码 HTML；无 pubDate
  assert.equal(articles[1]!.image, 'https://img.a.com/e1.png');
  assert.equal(articles[1]!.description!.startsWith('<p>实体摘要</p>'), true);
  assert.equal(articles[1]!.pubDate, null);

  // 第三篇：描述抠首图兜底
  assert.equal(articles[2]!.image, 'https://img.a.com/desc.jpg');

  // 第四篇：pubDate 内嵌子标签 → 跳过；time 兜底
  assert.equal(articles[3]!.pubDate, '2026-10-06');
});

test('parseRssDefaultXml：order 递增、type 继承源', () => {
  const { articles } = parseRssDefaultXml('<rss><item><title>t</title></item></rss>', 'o', 's', 1);
  assert.equal(articles[0]!.order, 0);
  assert.equal(articles[0]!.type, 1);
});

// ---------------------------------------------------------------------------
// HTML → 段落 / 图片抽取 / URL 模板
// ---------------------------------------------------------------------------

test('htmlToParagraphs：块级切分 + 剥标签 + 实体', () => {
  const ps = htmlToParagraphs('<p>第一段</p><p>第二段 &amp; 更多</p><div>第三段</div><script>bad()</script>');
  assert.deepEqual(ps, ['第一段', '第二段 & 更多', '第三段']);
});

test('extractImageUrls：全量图片（区别于首图）', () => {
  const imgs = extractImageUrls('<img src="https://a.com/1.jpg"><p>x</p><img src="https://a.com/2.jpg">');
  assert.deepEqual(imgs, ['https://a.com/1.jpg', 'https://a.com/2.jpg']);
});

test('fillUrlTemplate：{{key}} 编码 + {{page}}', () => {
  assert.equal(fillUrlTemplate('https://a.com?q={{key}}&p={{page}}', { key: '中文 词', page: 3 }), 'https://a.com?q=%E4%B8%AD%E6%96%87%20%E8%AF%8D&p=3');
});

// ---------------------------------------------------------------------------
// 引擎：content 三分支（内嵌正文 / 图片型 / 不支持）
// ---------------------------------------------------------------------------

const ENGINE_RULE = compileRssSource({ sourceUrl: 'https://a.com/feed', sourceName: '测试源' } as RssSourceRaw);
const engine = new RssEngine();
const stubCtx = { trace: { tail: (): never[] => [] } } as unknown as import('@yuedu/core').EngineContext;

test('content：内嵌 description → (#308) 原样作 HTML 下发', async () => {
  const c = await engine.content(
    ENGINE_RULE,
    { action: 'content', id: JSON.stringify({ title: 't', description: '<p>段一</p><p>段二</p>' }) },
    stubCtx,
  );
  // `#308`：上游把这串当完整 HTML 给 WebView（`loadDataWithBaseURL`），标签不能丢
  assert.equal(c.paragraphs.length, 0);
  assert.match(c.html ?? '', /<p>段一<\/p>/);
});

test('content：图片型（type=1）→ 图片 URL 数组 + FULL', async () => {
  const c = await engine.content(
    ENGINE_RULE,
    { action: 'content', id: JSON.stringify({ title: 't', type: 1, image: 'https://a.com/0.jpg', description: '<img src="https://a.com/1.jpg">' }) },
    stubCtx,
  );
  assert.equal(c.imageStyle, 'FULL');
  assert.deepEqual(c.paragraphs, ['https://a.com/0.jpg', 'https://a.com/1.jpg']);
});

test('content：无内嵌正文且无 ruleContent → 显式 UNSUPPORTED（不静默）', async () => {
  await assert.rejects(
    () => engine.content(ENGINE_RULE, { action: 'content', id: JSON.stringify({ title: 't', link: 'https://a.com/1' }) }, stubCtx),
    (e: unknown) => (e as { code?: string }).code === 'UNSUPPORTED_ACTION',
  );
});

/**
 * `#314`（2026-10-07）：**旧锁已反转**。
 *
 * 旧断言是「第一批不含 play/login」—— 那时登录确实没做（rss 桩连 `getLoginInfoMap` 都没有）。
 * 但上游订阅源登录是**一等功能**（`RssSource.kt:40-44` 继承 loginUrl/loginUi；
 * `RssSourceDao.kt:85` / `RssAdapter.kt:68` / `RssSortActivity.kt:303` 三处都有登录入口），
 * 且本仓 RSS 语料 31 源里 9 个有 loginUrl、7 个有 loginUi ⇒ 用户报的「引擎 rss 不支持登录」
 * 是**整块能力缺失**。现在补上 login（`play` 仍不做 —— 订阅源没有播放语义）。
 */
test('engine capabilities：含 login（订阅源登录是一等功能）+ start（`#404` 启动页），仍不含 play', () => {
  assert.deepEqual([...engine.capabilities].sort(), ['category', 'content', 'detail', 'home', 'login', 'search', 'start']);
});

// ---------------------------------------------------------------------------
// `#346` content 媒体分支：订阅源正文里的播放直链 ⇒ media
// `#352` 嗅探化：**html 与 media 并存**（源规则的展示结果不再被播放器替换）。
// `#430`（用户拍板）**取消嗅探门控**：嗅探与源规则展示**并行** —— 页面自带 hls.js /
//   内嵌 `<iframe>` 播放页**同样**下发 media（前端进页先提示、10s 收缩成悬浮按钮，
//   不点就完全不影响页内播放）⇒ 下面两条从「不附带 media」翻成「同样附带」。
// ---------------------------------------------------------------------------

/** 带 `ruleContent` 的源（媒体分支要求有规则才去抓内容页，见 engine.ts 的守卫） */
const MEDIA_RULE = compileRssSource({
  sourceUrl: 'https://v.example.com',
  sourceName: '视频源',
  ruleContent: '{{@@body@html}}',
} as RssSourceRaw);

/** 桩：`ruleContent` 直接命中内嵌 description，不需要真网络 */
const ctxWithHttp = {
  trace: { tail: (): never[] => [] },
  http: { request: async () => ({ status: 200, headers: {}, body: '' }) },
} as unknown as import('@yuedu/core').EngineContext;

test('#346/#352 content：type=2 且正文含 .m3u8 ⇒ html + media 并存（嗅探，不丢 HTML）', async () => {
  const c = await engine.content(
    MEDIA_RULE,
    {
      action: 'content',
      id: JSON.stringify({
        title: 'v',
        type: 2,
        description: '<video controls src="https://cdn.x.com/hls/index.m3u8"></video>',
      }),
    },
    ctxWithHttp,
  );
  assert.equal(c.media?.url, 'https://cdn.x.com/hls/index.m3u8');
  assert.equal(c.media?.format, 'm3u8');
  // `#352`：源规则的展示结果（HTML）必须原样下发 —— 前端渲染正文 + 浮现嗅探按钮，
  // 不再像旧实现那样只给 media 把 HTML 丢掉（用户实测「改变了源规则的结果展示」）。
  assert.match(c.html ?? '', /<video/, 'html 与 media 并存：正文照常渲染');
});

test('#346/#352 content：type 没标对（写 0）但正文是视频 ⇒ 仍按**内容形态**附带 media', async () => {
  const c = await engine.content(
    MEDIA_RULE,
    { action: 'content', id: JSON.stringify({ title: 'v', type: 0, description: '<video src="https://cdn.x.com/a.mp4"></video>' }) },
    ctxWithHttp,
  );
  assert.equal(c.media?.url, 'https://cdn.x.com/a.mp4', '源作者 type 写错是常态 ⇒ 按内容兜底');
  assert.match(c.html ?? '', /<video/);
});

test('#430 content：正文自带 hls.js 播放器 ⇒ **同样**附带 media（嗅探与源规则展示并行）', async () => {
  const c = await engine.content(
    MEDIA_RULE,
    {
      action: 'content',
      id: JSON.stringify({
        title: 'v',
        type: 0,
        description:
          '<div id="player"></div><script>var hls=new Hls();hls.loadSource("https://cdn.x.com/hls/index.m3u8");</script>',
      }),
    },
    ctxWithHttp,
  );
  assert.match(c.media?.url ?? '', /index\.m3u8$/, '用户拍板：页面能自播也照样下发 media（嗅探是并行补充能力）');
  assert.match(c.html ?? '', /Hls/, 'html 与 media 并存：HTML 原样渲染，壳层按需注入 hls.js 库');
});

test('#430 content：正文内嵌 iframe 播放页 ⇒ **同样**附带 media（AGE动漫形态）', async () => {
  // AGE动漫实测：ruleContent 产出 <iframe src="https://jx…:8443/m3u8/?url=…">。
  // 该 URL 是**解析页**（不是直链）—— 但它照旧可作为嗅探候选下发：
  // 前端走播放器时会经 `#394` 的 `/api/media-resolve` 做二级解析拿到真直链。
  const c = await engine.content(
    MEDIA_RULE,
    {
      action: 'content',
      id: JSON.stringify({
        title: 'v',
        type: 0,
        description: '<iframe id="ageplayer" src="https://jx.ejtsyc.com:8443/m3u8/?url=https://s.x.com/a/index.m3u8"></iframe>',
      }),
    },
    ctxWithHttp,
  );
  assert.match(c.media?.url ?? '', /^https:\/\/jx\.ejtsyc\.com/, '嗅探候选可以是解析页，前端负责二级解析');
  assert.match(c.html ?? '', /<iframe/, 'html 与 media 并存：正常加载规则界面（原样渲染）');
});

test('#346 content：普通图文（无媒体候选）⇒ 保持 HTML 通路（零回归）', async () => {
  const c = await engine.content(
    MEDIA_RULE,
    { action: 'content', id: JSON.stringify({ title: 't', type: 0, description: '<p>一段文字</p><img src="https://a.com/x.jpg">' }) },
    ctxWithHttp,
  );
  assert.equal(c.media, undefined, '只有图片不是视频 ⇒ 不能误判成 media');
  assert.match(c.html ?? '', /一段文字/);
});

test('#346 content：type=2 但正文提不到媒体 ⇒ 显式 SELECTOR_MISS（不静默黑屏）', async () => {
  await assert.rejects(
    () => engine.content(
      MEDIA_RULE,
      { action: 'content', id: JSON.stringify({ title: 'v', type: 2, description: '<p>没有播放地址</p>' }) },
      ctxWithHttp,
    ),
    (e: unknown) => (e as { code?: string }).code === 'SELECTOR_MISS',
  );
});

test('#346 content：无 ruleContent 的 link 型源**不**去抓内容页（守卫不能被绕过）', async () => {
  // 这条正是旧行为：无内嵌正文 + 无 ruleContent + 无渲染层 ⇒ 显式 UNSUPPORTED
  await assert.rejects(
    () => engine.content(
      ENGINE_RULE,
      { action: 'content', id: JSON.stringify({ title: 't', link: 'https://a.com/1' }) },
      stubCtx,
    ),
    (e: unknown) => (e as { code?: string }).code === 'UNSUPPORTED_ACTION',
  );
});
