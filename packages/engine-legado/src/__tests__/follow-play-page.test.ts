/**
 * 「播放页 → 跟随一层」回归锁（2026-09-25，A 项「视频源分层解析」第②层）。
 *
 * ## 背景
 * 很多视频源**不把直链放进正文产物**，而是给出**播放页 URL**。实测 🎬茶杯狐狸 `ruleContent`：
 * ```
 * var pUrl = result.match(/"url_next":"([^"]*)"/)[1].replace(/\\/g, '');
 * java.startBrowserAwait(pUrl, title);   // ← 播放页地址本来就在手里
 * "请刷新查看内容";                       // ← 规则只返回这句提示
 * ```
 * 规则产物是提示文案 ⇒ `media` 必为空 ⇒ 用户看到「未取到媒体地址」。
 *
 * ## 本轮做法（第②层）
 * 把「本请求内脚本要求打开的 URL」（`java.startBrowser` / `startBrowserAwait` → `onBrowserOpen`
 * → `ctx.variables['__browserUrls']`）当候选，**仅在 `media` 为空时跟随一层**：
 * 抓该页 → 在返回 HTML 里再找媒体直链 → 命中即用。
 *
 * 第①层（页面内已有直链）由 `collectMediaCandidates` 覆盖（见 `media-fallback.test.ts`）；
 * 第③层（无头嗅探）与第④层（弹窗兜底）**不在本轮**。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';

const BASE = 'https://media.test';
const CHAPTER_URL = `${BASE}/chapter/1`;
const PLAY_URL = `${BASE}/play/1`;

/** 正文页只返回提示文案（复刻茶杯狐狸） */
const CHAPTER_HTML = '<html><body><div>请刷新查看内容</div></body></html>';
/** 播放页里才有真正的直链 */
const PLAY_HTML =
  '<html><body><script>var player_aaaa={"file":"https:\\/\\/cdn.test\\/real\\/index.m3u8"};</script></body></html>';

interface CtxOpts {
  /** 模拟脚本已调用 startBrowser(Await) 累积的 URL 列表 */
  browserUrls?: string[];
  /** 播放页 HTML（不给则用 PLAY_HTML） */
  playHtml?: string;
  /** 命中统计，用于断言「不该跟随时不发请求」 */
  hits?: string[];
  /**
   * `#470②` 探测响应表（按 URL）——**仅当请求带 `responseType:'stream'`** 时生效，
   * 用来复刻「候选无扩展名」时的两种真实形态：3xx + `Location` 是媒体、或自身 `audio/*`。
   */
  probeResponses?: Record<string, { status: number; headers: Record<string, string> }>;
  /** 被 `cancel()` 掉的探测 URL —— 断言「探测不缓冲响应体」（`#470②` 的核心约束） */
  cancelled?: string[];
}

function makeCtx(opts: CtxOpts = {}): EngineContext {
  const variables = createVariableStore();
  if (opts.browserUrls) variables.set('__browserUrls', opts.browserUrls);
  return {
    reqId: 'follow-play-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string, reqOpts?: { responseType?: string }): Promise<HttpResponse> {
        opts.hits?.push(url);
        // `#470②` 探测：只给头 + 一个可 cancel 的流（**绝不带 body**）
        const spec = opts.probeResponses?.[url];
        if (spec && reqOpts?.responseType === 'stream') {
          return {
            status: spec.status,
            headers: spec.headers,
            body: '',
            url,
            stream: {
              async cancel() {
                opts.cancelled?.push(url);
              },
            },
          } as unknown as HttpResponse;
        }
        const body = /\/(chapter|play)\//.test(url) && url.includes('/play/') ? (opts.playHtml ?? PLAY_HTML) : CHAPTER_HTML;
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables,
    storage: createMemoryKeyValueStore(),
  };
}

/** 视频源（type=4，content 规则产出提示文案） */
function makeRule(contentHtml = CHAPTER_HTML) {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '跟随一层测试',
    bookSourceType: 4,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#l li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: `@js:${JSON.stringify(contentHtml)}` },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

async function runRule(rule: ReturnType<typeof makeRule>, ctx: EngineContext) {
  return (await new LegadoEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ chapterUrl: CHAPTER_URL, title: '第1集' }) },
    ctx,
  )) as unknown as { media?: { url?: string; format?: string }; paragraphs?: string[] };
}

test('② 正文无直链时，跟随「脚本要求打开的播放页」一层并取出直链', async () => {
  const r = await runRule(makeRule(), makeCtx({ browserUrls: [PLAY_URL] }));
  assert.equal(r.media?.url, 'https://cdn.test/real/index.m3u8');
  assert.equal(r.media?.format, 'm3u8', '格式必须判成 m3u8（前端据此起 hls）');
});

test('② 没有任何「要求开浏览器」的记录时不跟随（不得凭空多抓一页）', async () => {
  const hits: string[] = [];
  const r = await runRule(makeRule(), makeCtx({ hits }));
  assert.equal(r.media?.url, undefined);
  assert.equal(hits.filter((u) => u.includes('/play/')).length, 0, '没有候选就不该请求播放页');
});

test('② 播放页里找不到直链时静默返回空（不抛错、不把正文带崩）', async () => {
  const r = await runRule(
    makeRule(),
    makeCtx({ browserUrls: [PLAY_URL], playHtml: '<html><body><p>需要验证码</p></body></html>' }),
  );
  assert.equal(r.media?.url, undefined, '跟随失败必须静默（media 为空），不得抛错');
});

test('② 文本源（bookSourceType=0，茶杯狐狸形态）同样能跟随播放页取到直链', async () => {
  // 茶杯狐狸是**文本源**，正文规则只返回一句提示文案 —— 依赖本轮新增的跟随逻辑
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '文本视频源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'h1@text' },
    ruleToc: { chapterList: '#l li', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: `@js:${JSON.stringify('请刷新查看内容')}` },
  });
  assert.ok(out.ok && out.rule);
  const r = await runRule(out.rule, makeCtx({ browserUrls: [PLAY_URL] }));
  assert.equal(r.media?.url, 'https://cdn.test/real/index.m3u8');
});

test('② 候选与正文页相同（自环）时必须跳过', async () => {
  const hits: string[] = [];
  const r = await runRule(makeRule(), makeCtx({ browserUrls: [CHAPTER_URL], hits }));
  assert.equal(r.media?.url, undefined);
  assert.equal(hits.filter((u) => u === CHAPTER_URL).length, 1, '只应抓正文页一次，不得再自环抓一次');
});

test('① 页面内已有直链时**不**跟随（第①层优先，省一次请求）', async () => {
  const hits: string[] = [];
  const inline = '<html><body><video src="https://cdn.test/inline/movie.mp4"></video></body></html>';
  const r = await runRule(makeRule(inline), makeCtx({ browserUrls: [PLAY_URL], hits }));
  assert.equal(r.media?.url, 'https://cdn.test/inline/movie.mp4');
  assert.equal(hits.filter((u) => u.includes('/play/')).length, 0, '已有直链就不该再抓播放页');
});

test('② 多个候选时取最后一个（脚本最后一次要求打开的更可能是真播放页）', async () => {
  const r = await runRule(
    makeRule(),
    makeCtx({
      browserUrls: [`${BASE}/play/old`, PLAY_URL],
      // old 页没有直链，只有真播放页有
      playHtml: PLAY_HTML,
    }),
  );
  assert.equal(r.media?.url, 'https://cdn.test/real/index.m3u8');
});

/**
 * `#374`（2026-10-09）：候选**自身就是媒体直链**时直接采用，不当页面抓。
 *
 * 用户实测：把茶杯狐狸 `ruleContent` 改成 `result=pUrl` 后可正常转播放 ⇒
 * `url_next` 抽出来的就是**可直接播放的直链**（m3u8/mp4），不是「要再解析一层的页面」。
 * 旧逻辑对直链也走 fetchRuleUrl ⇒ 抓回来的是二进制/空壳 ⇒ `collectMediaCandidates` 必
 * miss ⇒ `follow-play-miss`，整个跟随层形同虚设。
 */
test('`#374` 候选自身是媒体直链时直接采用（不发抓取请求）', async () => {
  const hits: string[] = [];
  const direct = 'https://cdn.test/real/index.m3u8';
  const r = await runRule(makeRule(), makeCtx({ browserUrls: [direct], hits }));
  assert.equal(r.media?.url, direct, '直链候选必须原样成为 media.url');
  assert.equal(r.media?.format, 'm3u8');
  assert.equal(hits.filter((u) => u.includes('/play/') || u === direct).length, 0, '直链候选不得再被抓取');
});

test('`#374` 直链候选带 query 参数（麻豆形态 /api/v1/m3u8/proxy?path=x.m3u8）同样直取', async () => {
  const proxy = 'https://mdc.test/api/v1/m3u8/proxy?path=xxx/index.m3u8';
  const r = await runRule(makeRule(), makeCtx({ browserUrls: [proxy] }));
  assert.equal(r.media?.url, proxy, 'query 里带 .m3u8 的直链候选也必须直取');
  assert.equal(r.media?.format, 'm3u8');
});

test('`#374` 直链候选优先于「当页面抓」：直链在前时命中即返回，不再抓后续候选', async () => {
  const hits: string[] = [];
  const r = await runRule(
    makeRule(),
    makeCtx({ browserUrls: ['https://cdn.test/real/index.mp4', `${BASE}/play/old`], hits }),
  );
  assert.equal(r.media?.url, 'https://cdn.test/real/index.mp4');
  assert.equal(hits.filter((u) => u.includes('/play/')).length, 0, '直链命中后不得再抓后续播放页候选');
});

/**
 * `#470②`（2026-10-15，用户实测枫叶音乐盒）：**无扩展名候选先轻探测**。
 *
 * 缺陷形态：`meting/?server=netease&type=url&id=…` 这类地址**没有媒体扩展名**，旧逻辑把它
 * 当「播放页」用 `fetchRuleUrl` 整包抓 ⇒ 跟随 302 把 **10.85MB 音频**当文本拉回来
 * ⇒ 撞文本通道 8MB 护栏（用户可见 `[net-guard] 响应体超过上限 8MB，已截断` +
 * `[legado] … 首个被截断 URL：…/meting/…`）。实测 `meting` 302 只 268B，
 * `redirect:follow` 后才 200 / `audio/mpeg` / 10.85MB。
 * 修法：探测用 `redirect:'manual'` + `responseType:'stream'`（core 在 `readBodyLimited`
 * 之前早退）⇒ **只看头、一个字节都不缓冲**，命中即直取媒体、不再整包抓。
 */
test('`#470②` 无扩展名候选 302 → `Location` 是媒体：直取且**不缓冲**（不抓整包）', async () => {
  const hits: string[] = [];
  const cancelled: string[] = [];
  const meting = 'https://api.test/meting/?server=netease&type=url&id=29722351';
  const cdn = 'https://cdn.test/a/b/da77d1d623bb.mp3';
  const r = await runRule(
    makeRule(),
    makeCtx({
      browserUrls: [meting],
      hits,
      cancelled,
      probeResponses: { [meting]: { status: 302, headers: { location: cdn } } },
    }),
  );
  assert.equal(r.media?.url, cdn, '302 的 Location 是媒体直链 ⇒ 必须直取');
  assert.ok(cancelled.includes(meting), '探测必须 cancel 响应流（证明不缓冲响应体）');
  assert.equal(hits.filter((u) => u === cdn).length, 0, '不得再抓媒体直链本身（那会拉整包 ⇒ 8MB 截断）');
  assert.equal(hits.filter((u) => u === meting).length, 1, '候选只探测一次，不该再走整包抓取');
});

test('`#470②` 无扩展名候选自身是 `audio/*`：直取（无扩展名 CDN 直链形态）', async () => {
  const cdn = 'https://m801.music.126.net/20261015/jdymusic/obj/wo3DlMOGwrbDjj7DisKw/60929864023';
  const r = await runRule(
    makeRule(),
    makeCtx({
      browserUrls: [cdn],
      probeResponses: { [cdn]: { status: 200, headers: { 'content-type': 'audio/mpeg' } } },
    }),
  );
  assert.equal(r.media?.url, cdn);
});

test('`#470②` 302 → 非媒体（HTML 页）时**回落**原路径，不误判为直链', async () => {
  const hits: string[] = [];
  const cand = 'https://api.test/redirect-page';
  const r = await runRule(
    makeRule(),
    makeCtx({
      browserUrls: [cand],
      hits,
      probeResponses: { [cand]: { status: 302, headers: { location: 'https://site.test/real-page.html' } } },
    }),
  );
  assert.equal(r.media?.url, undefined, '302 目标是 HTML 页 ⇒ 不得直取');
  assert.equal(hits.filter((u) => u === cand).length, 2, '探测 1 次 + 回落原路径 1 次（原行为不变）');
});

test('`#470②` HLS 清单（`audio/mpegurl`）**不**被探测直取（否则 m3u8 文本规则会被跳过）', async () => {
  const hits: string[] = [];
  const cand = 'https://api.test/playlist/m3u';
  const r = await runRule(
    makeRule(),
    makeCtx({
      browserUrls: [cand],
      hits,
      probeResponses: { [cand]: { status: 200, headers: { 'content-type': 'audio/mpegurl' } } },
    }),
  );
  assert.equal(r.media?.url, undefined, 'mpegurl 是播放列表文本 ⇒ 必须留给原路径抓正文');
  assert.equal(hits.filter((u) => u === cand).length, 2, '探测 1 次 + 原路径 1 次');
});
