/**
 * `#394` 解析云二级解析（`media-resolve.ts`）—— 契约锁：
 *
 *  ① **任何输入都不抛**：脏输入（空串 / 非 http / 抓取函数抛错）一律 `ok:false` + 原因；
 *  ② 直链扩展名（`MEDIA_EXT_RE`）零网络直返（fetch 不该被调用）；
 *  ③ 响应是媒体 Content-Type ⇒ 最终 URL 即直链（不再跑 mediaFromRaw）；
 *  ④ HTML 页 ⇒ core `mediaFromRaw` 提直链 —— 用 **AGE jx 页的真实形态**做 fixture
 *     （`var Vurl = 'https://…/index.m3u8';`，服务端渲染、无需浏览器）；
 *  ⑤ 页面里没有媒体候选 ⇒ `NO_MEDIA_IN_PAGE`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveMediaPage, type MediaPageFetch } from '../media-resolve';

/** AGE jx 解析页的最小还原（真实页面 6406 字节，关键就这几行） */
const AGE_JX_HTML = `<!DOCTYPE html>
<html><head><title>云播放器</title>
<script src="https://xcdn.example/hls.min.js"></script>
<script src="https://xcdn.example/artplayer.min.js"></script>
</head><body>
<div id="loading"></div>
<script>
var Isios = false;
var Vurl = 'https://vip.ffzy-plays.com/20261005/59106_9a4e19be/index.m3u8';
var Vurl_id = 'e390ea53d8935562285608f244ae6121';
var art = new Artplayer({ url: Vurl, container: '#loading' });
</script>
</body></html>`;

function okFetch(body: string, ct = 'text/html; charset=utf-8', finalUrl?: string): MediaPageFetch {
  return async () => ({ status: 200, headers: { 'content-type': ct }, body, url: finalUrl });
}

test('① 脏输入一律 ok:false 不抛（空/非http/fetch抛错/非文本体）', async () => {
  const never: MediaPageFetch = async () => {
    throw new Error('boom');
  };
  for (const u of ['', '  ', 'javascript:alert(1)', 'ftp://x/a.m3u8', '/relative/path']) {
    const r = await resolveMediaPage({ url: u }, okFetch(AGE_JX_HTML));
    assert.equal(r.ok, false, u);
    assert.equal(r.url, '');
    assert.ok(r.reason, u);
  }
  const rNet = await resolveMediaPage({ url: 'https://jx.test/m3u8/?url=x' }, never);
  assert.equal(rNet.ok, false);
  assert.match(rNet.reason ?? '', /^NETWORK:boom/);
  const rBin = await resolveMediaPage({ url: 'https://jx.test/m3u8/?url=x' }, async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: new ArrayBuffer(8), // 非文本体 ⇒ EMPTY_BODY（不能把它当字符串吞）
  }));
  assert.equal(rBin.ok, false);
  assert.equal(rBin.reason, 'EMPTY_BODY');
});

test('② 直链扩展名零网络直返（fetch 不被调用）', async () => {
  let called = 0;
  const fetchFn: MediaPageFetch = async () => {
    called++;
    return { status: 200, headers: {}, body: '' };
  };
  for (const u of [
    'https://cdn.test/a/index.m3u8',
    'https://cdn.test/a/video.mp4?token=x',
    'https://cdn.test/a/song.mp3#t=1',
  ]) {
    const r = await resolveMediaPage({ url: u }, fetchFn);
    assert.equal(r.ok, true, u);
    assert.equal(r.kind, 'direct');
    assert.equal(r.url, u);
  }
  assert.equal(called, 0);
});

test('③ 响应本身是媒体类型 ⇒ 最终 URL 即直链', async () => {
  const r = await resolveMediaPage(
    { url: 'https://jx.test/m3u8/?url=x' },
    okFetch('<html></html>', 'application/vnd.apple.mpegurl', 'https://cdn.test/real/index.m3u8'),
  );
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://cdn.test/real/index.m3u8');
});

test('④ AGE jx 页形态 ⇒ 提出真实 m3u8（kind=page）', async () => {
  const r = await resolveMediaPage(
    { url: 'https://jx.ejtsyc.com:8443/m3u8/?url=age_x' },
    okFetch(AGE_JX_HTML, 'text/html', 'https://jx.ejtsyc.com:8443/m3u8/?url=age_x'),
  );
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'page');
  assert.equal(r.url, 'https://vip.ffzy-plays.com/20261005/59106_9a4e19be/index.m3u8');
});

test('⑤ 无媒体候选的页面 ⇒ NO_MEDIA_IN_PAGE；上游 4xx ⇒ UPSTREAM_ 状态码', async () => {
  const r = await resolveMediaPage({ url: 'https://jx.test/x' }, okFetch('<html><body>纯文本</body></html>'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_MEDIA_IN_PAGE');
  const r4 = await resolveMediaPage({ url: 'https://jx.test/x' }, async () => ({
    status: 403,
    headers: { 'content-type': 'text/html' },
    body: '<html>403</html>',
  }));
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, 'UPSTREAM_403');
});
