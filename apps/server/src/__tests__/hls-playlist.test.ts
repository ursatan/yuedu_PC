/**
 * HLS 播放列表重写的回归锁（2026-09-25）。
 *
 * ## 为什么必须有
 * 播放列表里可能是**相对地址**，而 hls.js 是相对「它拿到的播放列表 URL」解析的。
 * 播放列表一旦经 `/api/proxy`（**CORS 决定它必须经**：实测直连 `Failed to fetch`），
 * 相对地址就会被解析成 `/api/proxy?u=…/seg1.ts` 这种垃圾地址 ⇒ 整条流放不出来，
 * 而错误信息只显示 `no supported source`，完全指不到原因。
 *
 * 所以代理在回传前把相对地址补成绝对。这里锁住四类行：
 *   ① 裸地址行（分片 / 子播放列表）  ② `#EXT-X-KEY` 的 `URI="…"`（AES-128 密钥）
 *   ③ `#EXT-X-MAP` 的 `URI="…"`（初始化段）  ④ 已是绝对的地址**不得被改动**
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isHlsPlaylist, looksLikeHlsBody, rewriteHlsPlaylist } from '../hls';

const BASE = 'https://mdcmai4.test/api/v1/m3u8/proxy?path=jpg%2F2026%2Fx.m3u8';

test('① 裸地址行：相对分片补成绝对（否则会被解析到代理路径下）', () => {
  const out = rewriteHlsPlaylist('#EXTM3U\nseg1.ts\n', 'https://cdn.test/hls/main.m3u8');
  assert.match(out, /https:\/\/cdn\.test\/hls\/seg1\.ts/, '相对分片必须补成绝对上游地址');
});

test('② #EXT-X-KEY 的 URI 必须补成绝对（AES-128 密钥在另一个域名上）', () => {
  const src = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="enc/key",IV=0x00\n';
  const out = rewriteHlsPlaylist(src, BASE);
  assert.match(out, /URI="https:\/\/mdcmai4\.test\/api\/v1\/m3u8\/enc\/key"/, 'key 的相对 URI 必须补基址');
  assert.match(out, /IV=0x00/, '同一行其它参数必须原样保留');
});

test('② 绝对 URI 不得被改写（幂等）', () => {
  const src = '#EXT-X-KEY:METHOD=AES-128,URI="https://gwbe.test/enc/key"\n';
  assert.equal(rewriteHlsPlaylist(src, BASE), src, '已是绝对的地址原样保留');
});

test('③ 子播放列表（master m3u8 指向子列表）同样补基址', () => {
  const src = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p/index.m3u8\n';
  const out = rewriteHlsPlaylist(src, 'https://cdn.test/master.m3u8');
  assert.match(out, /https:\/\/cdn\.test\/720p\/index\.m3u8/);
});

test('多域名混合（本仓真实形态）：绝对分片保留、相对 key 补基址', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="/api/resource-pool/m3u8/enc/key"',
    '#EXTINF:4.1,',
    'https://acfan.test/x/seg0.ts?auth_key=1',
  ].join('\n');
  const out = rewriteHlsPlaylist(src, BASE);
  assert.match(out, /URI="https:\/\/mdcmai4\.test\/api\/resource-pool\/m3u8\/enc\/key"/);
  assert.match(out, /https:\/\/acfan\.test\/x\/seg0\.ts\?auth_key=1/);
  assert.ok(!out.includes(`${BASE}/https`), '不得把绝对地址二次拼接（会产生畸形 URL）');
});

test('识别：pathname 里没有 m3u8、只有 query 带（麻豆形态）也要认出', () => {
  assert.equal(isHlsPlaylist('application/octet-stream', 'https://mdcmai4.test/api/v1/m3u8/proxy?path=x.m3u8'), true);
  assert.equal(isHlsPlaylist('application/vnd.apple.mpegurl', 'https://x.test/whatever'), true);
  assert.equal(isHlsPlaylist('image/png', 'https://x.test/a.png'), false);
});

/**
 * `#432` 实体判据：URL 含 `.m3u8` **不等于**实体是播放列表。
 *
 * 91视频（2026-10-13 实测）：正文页里播放器 iframe 的地址是
 * `…/t2player.html?url=https://…/xxx.m3u8` —— `isHlsPlaylist` 粗筛命中，旧实现把
 * 这个 **HTML 页**逐行当分片地址改写（`https://host/%3Chtml%3E…`）并以
 * `application/vnd.apple.mpegurl` 回传 ⇒ hls.js `manifestParsingError`。
 * 现在重写前必须过 `looksLikeHlsBody`，不通过就原样回传（type 也不改）。
 */
test('实体判据：真清单通过（含 BOM/前导空行），HTML 播放器页不通过', () => {
  assert.equal(looksLikeHlsBody('#EXTM3U\n#EXTINF:4.1,\nseg0.ts\n'), true);
  assert.equal(looksLikeHlsBody('\uFEFF\n\n#EXTM3U\n'), true, 'BOM + 前导空行也算');
  assert.equal(looksLikeHlsBody('<!doctype html><html><head><title>t2player</title>'), false);
  assert.equal(looksLikeHlsBody('  \n<html>'), false);
  assert.equal(looksLikeHlsBody(''), false);
});
