/**
 * `#567` P3 站点定制层回归锁：域名归一 / 匹配优先级 / 注入转义 / 阅读模式闸门。
 *
 * 这些判据是**三个消费方**（Web 阅读器 · 桌面 WebContentsView · 服务端渲染器）的共同前提，
 * 任何一条漂移都会表现成「用户配了却不生效」或「配 A 站却影响 B 站」—— 两者都极难从现象反推。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SITE_CUSTOMIZE_LIMITS,
  hostOfUrl,
  injectSiteCustomize,
  isSiteCustomizeEmpty,
  matchSiteCustomize,
  normalizeSiteHost,
  readerModeAppliesTo,
  siteCustomizePayload,
  siteHostMatches,
  type SiteCustomize,
} from '../site-customize';

test('#567 normalizeSiteHost：URL / 裸域 / 通配符 都归一成域名模式', () => {
  assert.equal(normalizeSiteHost('https://www.Example.com/a/b?x=1'), 'www.example.com');
  assert.equal(normalizeSiteHost('www.example.com/path'), 'www.example.com');
  assert.equal(normalizeSiteHost('example.com:8080'), 'example.com');
  assert.equal(normalizeSiteHost('*.example.com'), '*.example.com');
  assert.equal(normalizeSiteHost('//example.com/x'), 'example.com');
  // 认不出的形态一律 ''（调用方拒绝保存，而不是存一条永不命中的规则）
  assert.equal(normalizeSiteHost(''), '');
  assert.equal(normalizeSiteHost('not a host'), '');
  assert.equal(normalizeSiteHost('例え.jp'), '');
  assert.equal(normalizeSiteHost('a'.repeat(SITE_CUSTOMIZE_LIMITS.host + 1)), '');
});

test('#567 hostOfUrl：只认 http(s)，其它一律空', () => {
  assert.equal(hostOfUrl('https://News.Example.com/x'), 'news.example.com');
  assert.equal(hostOfUrl('http://127.0.0.1:3000/a'), '127.0.0.1');
  assert.equal(hostOfUrl('data:text/html,<p>x</p>'), '');
  assert.equal(hostOfUrl('file:///f:/a.html'), '');
  assert.equal(hostOfUrl(''), '');
});

test('#567 siteHostMatches：裸域含子域；*. 只含子域', () => {
  assert.equal(siteHostMatches('example.com', 'example.com'), true);
  assert.equal(siteHostMatches('example.com', 'www.example.com'), true);
  assert.equal(siteHostMatches('example.com', 'a.b.example.com'), true);
  assert.equal(siteHostMatches('example.com', 'notexample.com'), false);
  assert.equal(siteHostMatches('example.com', 'example.com.evil.net'), false);
  assert.equal(siteHostMatches('*.example.com', 'example.com'), false, '通配符不含 apex');
  assert.equal(siteHostMatches('*.example.com', 'www.example.com'), true);
});

test('#567 matchSiteCustomize：最具体者胜，且不吃错站', () => {
  const list: SiteCustomize[] = [
    { host: 'example.com', css: '.ad{display:none}' },
    { host: 'news.example.com', css: '.sidebar{display:none}' },
    { host: '*.other.com', js: 'void 0' },
  ];
  assert.equal(matchSiteCustomize(list, 'https://news.example.com/1')?.host, 'news.example.com');
  assert.equal(matchSiteCustomize(list, 'https://www.example.com/1')?.host, 'example.com');
  assert.equal(matchSiteCustomize(list, 'https://a.other.com/1')?.host, '*.other.com');
  assert.equal(matchSiteCustomize(list, 'https://other.com/1'), null, 'apex 不被 *. 命中');
  assert.equal(matchSiteCustomize(list, 'https://evil.com/?u=news.example.com'), null);
  assert.equal(matchSiteCustomize(list, 'data:text/html,x'), null);
});

test('#567 injectSiteCustomize：先 CSS 后 JS，且转义闭合标签', () => {
  const cfg: SiteCustomize = { host: 'x.com', css: 'body{color:#eee}', js: 'document.body.dataset.x="1"' };
  const out = injectSiteCustomize('<html><head><title>t</title></head><body>b</body></html>', cfg);
  assert.ok(out.startsWith('<html><head><style>body{color:#eee}</style><script>document.body.dataset.x="1"</script>'));
  assert.ok(out.includes('<title>t</title>'), '原有 head 内容必须保留');

  // 没有 head：补一个
  const noHead = injectSiteCustomize('<html><body>b</body></html>', cfg);
  assert.ok(noHead.includes('<html><head><style>'), noHead);

  // 片段（无 html/head）：前置注入
  const frag = injectSiteCustomize('<p>hi</p>', cfg);
  assert.ok(frag.startsWith('<style>'));

  // 关闭标签必须被转义，否则会提前结束注入块
  const danger = injectSiteCustomize('<html><head></head></html>', {
    host: 'x.com', css: 'a{}', js: 'var s="</script><script>alert(1)</script>"',
  });
  // ⚠️ 只数**真正的闭合标签**：用户 JS 文本里出现的 `<script>` 在 script 元素内是普通文本，
  //    不是标签（HTML 解析器只在 `</script` 处结束块）。所以判据是「未转义的 `</script>` 只有我们那一个」。
  assert.equal(danger.split('</script>').length - 1, 1, danger);
  assert.ok(danger.includes('<\\/script>'), '闭合标签要转义成 <\\/script>');
});

test('#567 injectSiteCustomize：空内容零改动；isSiteCustomizeEmpty 判空', () => {
  const html = '<html><head><title>t</title></head></html>';
  assert.equal(injectSiteCustomize(html, null), html);
  assert.equal(injectSiteCustomize(html, { host: 'x.com', css: '   ', js: '\n' }), html);
  assert.equal(injectSiteCustomize('', { host: 'x.com', css: 'a{}' }), '');
  assert.equal(isSiteCustomizeEmpty({ host: 'x.com' }), true);
  assert.equal(isSiteCustomizeEmpty({ host: 'x.com', readerMode: false }), true);
  assert.equal(isSiteCustomizeEmpty({ host: 'x.com', readerMode: true }), false);
  assert.equal(isSiteCustomizeEmpty({ host: 'x.com', css: 'a{}' }), false);
});

test('#567 siteCustomizePayload：桌面通路拿到的就是原文（不做 HTML 转义）', () => {
  const p = siteCustomizePayload({ host: 'x.com', css: 'a{}', js: 'var s = 1 < 2;' });
  assert.deepEqual(p, { css: 'a{}', js: 'var s = 1 < 2;' });
  assert.deepEqual(siteCustomizePayload(null), { css: '', js: '' });
});

test('#567/#712 readerModeAppliesTo：网页与书籍正文都放行（书籍按文本化落地）', () => {
  assert.equal(readerModeAppliesTo('web'), true);
  assert.equal(readerModeAppliesTo('book'), true, '#712 书籍 HTML 正文按文本化启用（不新增 iframe 分支）');
});
