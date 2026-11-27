/**
 * `#346` 媒体直链提取（`content/media-extract.ts`）—— 下沉 core 的唯一实现。
 *
 * 这批断言锁的是**用户实测的两个真实形态**：
 *  ① 麻豆传媒（RSS，`type` 写成 0）：`ruleContent` 产出
 *     `<video src="https://…/index.m3u8" width="100%" controls></video>` ——
 *     必须能抽出 m3u8 直链；此前无一实现 ⇒ 黑屏播放器 0:00。
 *  ② 普通文本正文：**不得**被误判成媒体（防止同一分支把文章正文吞成「无内容」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectMediaCandidates,
  inferPlayFormat,
  mediaFromRaw,
  toMedia,
  parseMediaCandidate,
  unescapeJsUrl,
  unwrapPlayerUrl,
  bodyUsesHls,
  bodyHasHlsLib,
} from '../content/media-extract';

const MADOU_HTML =
  '<style>iframe{\n\twidth:100%;\n\theight:auto;\n\t}</style>' +
  '<video src="https://m3u8.cdn202608.com/videos/202609/23/6ab3d17a91867c24a41b05b3/b2bd24/index.m3u8" width="100%" height="auto" controls></video>';

test('#346 麻豆形态：<video src="…m3u8"> 能抽出主候选', () => {
  const m = mediaFromRaw(MADOU_HTML, 'https://madoue.life/video/play/1-1-1.html');
  assert.ok(m, '必须产出 media（否则前端仍是黑屏播放器）');
  assert.equal(m!.url, 'https://m3u8.cdn202608.com/videos/202609/23/6ab3d17a91867c24a41b05b3/b2bd24/index.m3u8');
  assert.equal(m!.format, 'm3u8', 'format 必须是 m3u8（播放器据此选 hls.js 内核）');
});

test('#346 裸 m3u8 直链（无标签）也能抽出', () => {
  const m = mediaFromRaw('https://cdn.test/a/b/index.m3u8', 'https://x.test/p/1.html');
  assert.equal(m?.url, 'https://cdn.test/a/b/index.m3u8');
});

test('#346 相对路径按 base 补全为绝对地址', () => {
  const m = mediaFromRaw('<video src="/hls/main.m3u8"></video>', 'https://x.test/play/1.html');
  assert.equal(m?.url, 'https://x.test/hls/main.m3u8');
});

test('#346 query 里带 .m3u8 的代理直链（pathname 无扩展名）仍判 m3u8', () => {
  const u = 'https://mdcmai4.xyz/api/v1/m3u8/proxy?path=%2Fv%2Fx.m3u8';
  assert.equal(inferPlayFormat(u), 'm3u8', 'pathname 判不出时必须回看整串（真实形态）');
});

test('#346 普通文本正文**不得**被当成媒体（防回归）', () => {
  const text = '这是一篇普通文章。\n\n第二段：参考 https://example.com/about 了解更多。';
  assert.equal(mediaFromRaw(text, 'https://x.test/a/1.html'), undefined);
});

test('#346 只有 <img> 的图集正文不误判为媒体', () => {
  const html = '<p>图集</p><img src="https://img.test/a.jpg"><img src="https://img.test/b.jpg">';
  assert.equal(mediaFromRaw(html, 'https://x.test/a/1.html'), undefined);
});

test('#346 播放器 JSON 键 + 反向转义（https:\\/\\/）', () => {
  const raw = 'var player={"url_next":"https:\\/\\/cdn.test\\/v\\/a.m3u8"};';
  const cands = collectMediaCandidates(raw);
  assert.ok(cands.includes('https://cdn.test/v/a.m3u8'), `反向转义后应命中，实得 ${JSON.stringify(cands)}`);
});

test('#346 toMedia 备选去重且不含主候选', () => {
  const m = toMedia('https://a.test/x.m3u8', 'https://a.test/', ['https://a.test/x.m3u8', 'https://b.test/y.mp4']);
  assert.equal(m?.url, 'https://a.test/x.m3u8');
  assert.deepEqual(m?.alternatives, ['https://b.test/y.mp4']);
});

test('#346 parseMediaCandidate 解析 ,{options} 的 headers', () => {
  const p = parseMediaCandidate('https://a.test/x.m3u8,{"headers":{"Referer":"https://a.test/"}}');
  assert.equal(p.url, 'https://a.test/x.m3u8');
  assert.equal(p.headers?.['Referer'], 'https://a.test/');
});

test('#346 unescapeJsUrl 处理 \\u0026 与 \\/', () => {
  assert.equal(unescapeJsUrl('https:\\/\\/a.test\\/x?y\\u0026z=1'), 'https://a.test/x?y&z=1');
});

// ===================== `#352` 嗅探门控判据（bodyUsesHls / bodySelfPlaying） =====================

test('#352 bodyUsesHls：真调用 Hls API 才算，只提 m3u8 字样不算', () => {
  assert.equal(bodyUsesHls('<script>var hls=new Hls();hls.loadSource(u);</script>'), true);
  assert.equal(bodyUsesHls('<script>if(Hls.isSupported()){…}</script>'), true);
  assert.equal(bodyUsesHls('<video src="https://a.test/x.m3u8"></video>'), false, '麻豆形态：只有直链没有播放器');
  assert.equal(bodyUsesHls('https://jx.test/m3u8/?url=x'), false, 'URL 里的 m3u8 字样不等于调用 Hls API');
});

test('#352 bodyHasHlsLib：自带 <script src=…hls…> 才算', () => {
  assert.equal(bodyHasHlsLib('<script src="https://a.test/hls.min.js"></script>'), true);
  assert.equal(bodyHasHlsLib('<script>new Hls()</script>'), false);
});

// `#430`：`bodySelfPlaying` 已删除（用户拍板「嗅探与源规则展示并行」⇒ 不再有嗅探门控）。
// `bodyUsesHls` / `bodyHasHlsLib` 仍在用（壳层按需注入 hls.js），上面两条锁保留。

// ===================== `#432` 「播放器页包裹直链」（91视频实证） =====================

/**
 * 91视频（2026-10-13 实测）：正文把**播放器页**当播放地址，真 m3u8 在 `?url=` 参数里：
 * ```js
 * ifa.src = "https://ha2.dd.frcfwb.cn/t2player.html?url=https://ehapp2.dd.frcfwb.cn/cshort/xxx.m3u8"
 * ```
 * 旧实现只按「值里含 `.m3u8`」过审 ⇒ 候选[0] = 那个 **HTML 播放器页** ⇒ hls.js
 * `manifestParsingError`（且经 `/api/proxy` 还会被当播放列表改坏）。现在必须解出内层直链。
 */
test('#432 播放器页包裹直链：候选取 ?url= 内的真 m3u8，不得含 t2player.html', () => {
  const html =
    '<script>var ifa=document.createElement("iframe");' +
    'ifa.src="https://ha2.dd.frcfwb.cn/t2player.html?url=https://ehapp2.dd.frcfwb.cn/cshort/WeNysCBVtCY.m3u8";' +
    'document.body.appendChild(ifa);</script>';
  const cands = collectMediaCandidates(html);
  assert.equal(
    cands[0],
    'https://ehapp2.dd.frcfwb.cn/cshort/WeNysCBVtCY.m3u8',
    `候选[0] 必须是真直链，实得 ${JSON.stringify(cands)}`,
  );
  assert.ok(!cands.some((c) => c.includes('t2player.html')), '不得把播放器页当候选');
  const m = mediaFromRaw(html, 'https://cn8.x-91short.com/v/1.html');
  assert.equal(m?.url, 'https://ehapp2.dd.frcfwb.cn/cshort/WeNysCBVtCY.m3u8');
  assert.equal(m?.format, 'm3u8');
});

test('#432 百分号编码的 ?url= 同样能解出内层直链', () => {
  assert.equal(
    unwrapPlayerUrl('https://p.test/player.html?url=https%3A%2F%2Fcdn.test%2Fv%2Fx.m3u8'),
    'https://cdn.test/v/x.m3u8',
  );
});

test('#432 不带直链参数时不解包（普通带参 URL 原样保留，不误伤）', () => {
  assert.equal(unwrapPlayerUrl('https://cdn.test/v/x.m3u8?t=1'), null);
  assert.equal(unwrapPlayerUrl('https://cdn.test/v/a.mp4'), null);
  // 参数里不是媒体验证也不解（避免把 ?url= 指向的详情页当直链）
  assert.equal(unwrapPlayerUrl('https://p.test/player.html?url=https://site.test/post/1.html'), null);
});

test('#432 非网页入口的解析页**不碰**（AGE 动漫口径：前端负责二级解析）', () => {
  // AGE 的 jx 解析页：路径不是网页扩展名 ⇒ 必须原样保留（`#430` 的产品口径）
  assert.equal(unwrapPlayerUrl('https://jx.ejtsyc.com:8443/m3u8/?url=https://s.x.com/a/index.m3u8'), null);
  const html = '<iframe id="ageplayer" src="https://jx.ejtsyc.com:8443/m3u8/?url=https://s.x.com/a/index.m3u8"></iframe>';
  assert.equal(collectMediaCandidates(html)[0], 'https://jx.ejtsyc.com:8443/m3u8/?url=https://s.x.com/a/index.m3u8');
});

// ===================== `#438` MacCMS/Legado「播放列表串」（影视聚合 实证） =====================

/**
 * 「影视聚合(资源站)」（MacCMS API 壳）的 `ruleDescription` 是整页 hls.js 播放器：站点把
 * `vod_play_url`（形态 `集名$直链#集名$直链#…`）原样填进正文脚本
 * （`tplPlayUrl.innerHTML = `集名$直链#…``）。
 *
 * 旧字符类（只排除空白/引号/尖括号/反斜杠）会把整串当一个 URL 抓走 ⇒ 候选 =
 * `https://…/a.m3u8#第02集$https://…/b.m3u8#…``（**尾巴还带着模板反引号**）
 * ⇒ ① hls.js `networkError` / `manifestParsingError`；② 整张选集列表塌成 **1 条**。
 * 修法：裸 URL 扫描止步于 `#` 与反引号 ⇒ 匹配只从 `https://` 起、集名自然跳过。
 */
test('#438 播放列表串：每条直链各自成候选，不得混入集名/反引号', () => {
  const bt = String.fromCharCode(96);
  const raw =
    '<script>\n' +
    'tplPlayUrl.innerHTML = ' + bt + '第01集$https://cd.com/a.m3u8#第02集$https://cd.com/b.m3u8#第03集$https://cd.com/c.m3u8' + bt + ';\n' +
    '</script>\n<video id="myVideo" controls></video>\n';
  const cands = collectMediaCandidates(raw);
  assert.deepEqual(
    cands,
    ['https://cd.com/a.m3u8', 'https://cd.com/b.m3u8', 'https://cd.com/c.m3u8'],
    `实得 ${JSON.stringify(cands)}`,
  );
  const m = mediaFromRaw(raw, 'https://hongniuzy2.com/');
  assert.equal(m?.url, 'https://cd.com/a.m3u8');
  assert.deepEqual(m?.alternatives, ['https://cd.com/b.m3u8', 'https://cd.com/c.m3u8']);
  assert.ok(cands.every((c) => !c.includes('第0')), '集名不得混进地址');
  assert.ok(cands.every((c) => !c.includes(bt)), '不得带模板反引号');
});

/**
 * `#440` **多线路源**（真机实测 4 家 MacCMS API：subocj / guangsuapi / hhzyapi / hongniuzy2）：
 * `vod_play_url` 是 `线路1的集列表$$$线路2的集列表` —— 第 1 条线路的每集是**播放页**
 * （`/play/xxx` 无扩展名），第 2 条线路才是 `.m3u8` 直链；`$$$` 是**线路分隔符且不含 `#`**。
 * 只排除 `#` 时，第一个 `https://` 会一路吃到 `$$$第1集$` 再吞下第 2 条线路的 `https://…index.m3u8`
 * ⇒ 候选[0]（= 第 1 集）是坏地址 ⇒ `/api/proxy` 请求它必然 **404**（用户报「第一集播放失败：
 * 播放列表取不到：HTTP 404」，其余集正常）。修：裸扫同时**止步于 `$`**。
 */
test('#440 多线路 `$$$`：候选必须是干净的各集直链（第 1 集尤其不能带 `$$$第1集$`）', () => {
  const bt = String.fromCharCode(96);
  const pu =
    '第1集$https://play.x/play/aaa#第2集$https://play.x/play/bbb' + '$$$' +
    '第1集$https://play.x/play/aaa/index.m3u8#第2集$https://play.x/play/bbb/index.m3u8';
  const raw = '<script>\ntplPlayUrl.innerHTML = ' + bt + pu + bt + ';\n</script>\n';
  const cands = collectMediaCandidates(raw);
  assert.deepEqual(
    cands,
    ['https://play.x/play/aaa/index.m3u8', 'https://play.x/play/bbb/index.m3u8'],
    `实得 ${JSON.stringify(cands)}`,
  );
  const m = mediaFromRaw(raw, 'https://site.test/');
  assert.equal(m?.url, 'https://play.x/play/aaa/index.m3u8', '第 1 集必须是干净直链（否则代理 404）');
});

test('#445 正文前面混入 `<script src=…hls.min.js>` ⇒ 剔掉坏候选，仍要取到真正的 m3u8', () => {
  const raw = '<script src="/usr/plugins/DPlayer/plugin/hls.min.js?v=1"></script>'
    + '<div class="dplayer" data-config=\'{"video":{"url":"https://cdn.test/a/b.m3u8?auth=x","type":"hls"}}\'></div>';
  const m = mediaFromRaw(raw, 'https://site.test/p/1');
  assert.equal(m?.url, 'https://cdn.test/a/b.m3u8?auth=x', '首个候选是 .js 不能导致「整条放弃」（实测 91 吃瓜 media 从有变无）');
  assert.equal(m?.format, 'm3u8');
});

test('#445 对偶：整篇只有脚本/样式资源 ⇒ 仍然 undefined（不误认）', () => {
  const raw = '<script src="/a/hls.min.js?v=1"></script><link rel="stylesheet" href="/b/site.css">';
  assert.equal(mediaFromRaw(raw, 'https://site.test/'), undefined);
});

test('#445 属性被正确转义（`&quot;` + `&amp;`）时，扫描要归一后仍取到干净直链', () => {
  const raw = '<div class="dplayer" data-config="{&quot;video&quot;:{&quot;url&quot;:&quot;https://cdn.test/a/b.m3u8?k=v&amp;t=1&quot;,&quot;type&quot;:&quot;hls&quot;}}"></div>';
  const m = mediaFromRaw(raw, 'https://site.test/p/1');
  assert.equal(m?.url, 'https://cdn.test/a/b.m3u8?k=v&t=1', '`&amp;` 必须归一成 `&`，否则播放器请求会 404');
});
