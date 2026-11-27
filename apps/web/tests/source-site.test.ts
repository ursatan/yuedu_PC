/**
 * `#448` **站地址 / 同站判定 / 「像不像页面」**的回归锁。
 *
 * 为什么要有：这条判据现在同时决定**两个**入口的分流 ——
 *  · 发现页启动页外链（`#440`）：同站 ⇒ 交阅读页；异站 ⇒ 应用内浏览器；
 *  · 阅读页正文内跳转（`#448`）：同站**且像页面** ⇒ 交源规则重渲染；否则页内浏览器。
 * 以前它写在 `DiscoverView.vue` 里（无法单测），抽到 `utils/source-site.ts` 后两端共用一份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sameSite, sourceSiteUrlOf, looksLikePageUrl } from '../src/utils/source-site';

test('#448 sameSite：同 host / 互为子域 / www 互认；异站与坏值一律 false', () => {
  const site = 'https://bbs.example.com/';
  assert.equal(sameSite('https://bbs.example.com/forum.php?mod=viewthread&tid=1', site), true);
  assert.equal(sameSite('https://m.bbs.example.com/x', site), true, '子域算同站');
  assert.equal(sameSite('https://example.com/x', site), true, '父域算同站（互为子域）');
  assert.equal(sameSite('https://www.example.com/x', site), true, 'www 去掉后比较');
  assert.equal(sameSite('https://other.com/x', site), false);
  assert.equal(sameSite('https://evil-bbs.example.com/x', site), false, '不能靠后缀包含误判');
  assert.equal(sameSite('', site), false);
  assert.equal(sameSite('https://bbs.example.com/x', ''), false, '源没有 url ⇒ 当异站');
  assert.equal(sameSite('not a url', site), false);
});

test('#448 sourceSiteUrlOf：按 id 取源的站地址；取不到给空串（不反解 id）', () => {
  const sources = [{ id: 'https___bbs_x_com_index', url: 'https://bbs.x.com/' }];
  assert.equal(sourceSiteUrlOf(sources, 'https___bbs_x_com_index'), 'https://bbs.x.com/');
  assert.equal(sourceSiteUrlOf(sources, '不存在'), '');
});

test('#448 looksLikePageUrl：页面放行；图片/媒体/压缩包/附件一律排除（否则点附件会被当正文解析）', () => {
  assert.equal(looksLikePageUrl('https://bbs.test/forum.php?mod=viewthread&tid=1'), true);
  assert.equal(looksLikePageUrl('https://site.test/archives/123/'), true);
  assert.equal(looksLikePageUrl('https://site.test/archives/123.html'), true, '`.html` 是页面不是资源');
  assert.equal(looksLikePageUrl('https://site.test/a.jpg'), false);
  assert.equal(looksLikePageUrl('https://site.test/a.jpeg?x=1'), false, '带查询串也算资源');
  assert.equal(looksLikePageUrl('https://site.test/v/x.m3u8'), false);
  assert.equal(looksLikePageUrl('https://site.test/pack.zip'), false);
  assert.equal(looksLikePageUrl('https://site.test/x.pdf'), false);
  assert.equal(looksLikePageUrl('ftp://site.test/a'), false, '非 http(s) 不放行');
});
