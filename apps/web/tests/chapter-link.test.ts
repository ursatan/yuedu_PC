/**
 * `#387d` 回归锁：正文链接 → 本书章节 的识别（AGE动漫「选集」实测口径）。
 *
 * 真数据（`curl https://www.agedm.io/play/20260335/1/2` 实测，2026-10-11）：
 * 章节页 `.card-body` 的选集就是
 *   `<a href="/play/20260335/1/1" class="video_detail_spisode_link">`
 * —— 与 `ruleToc.chapterUrl`（详情页 `.nav-pills … li a@href`）**同形**：
 *   `/play/<bookId>/<线路>/<集>`。
 * 而播放器是 `<iframe id="iframeForVideo" src="https://jx.wuzhoupai.com:8443/vip/?url=age_…">`
 * （第三方**解析**播放页）—— 点选集若走「页内整页跳转」，用户就被带离当前播放页
 * （用户原话：「点击选集会跳转解析云播放器页面，不停留在当前页面」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChapterIndexByUrl } from '../src/utils/chapter-link';

// ⚠️ 形状照**真实 store**：地址在 payload.chapterUrl（见 utils/chapter-link.ts 的 ChapterUrlLike）
const AGE = [
  { payload: { chapterUrl: 'https://www.agedm.io/play/20260335/1/1' } },
  { payload: { chapterUrl: 'https://www.agedm.io/play/20260335/1/2' } },
  { payload: { chapterUrl: 'https://www.agedm.io/play/20260335/2/1' } },
  { payload: { chapterUrl: 'https://www.agedm.io/play/20260335/2/2' } },
];

test('#387d AGE 选集链接命中本书章节 ⇒ 应换章（壳层已把 /play/... 绝对化成 https）', () => {
  assert.equal(findChapterIndexByUrl(AGE, 'https://www.agedm.io/play/20260335/2/1'), 2);
  assert.equal(findChapterIndexByUrl(AGE, 'https://www.agedm.io/play/20260335/1/2'), 1);
});

test('#387d 归一化：scheme / 尾斜杠 / 大小写 / fragment 都不影响判定', () => {
  assert.equal(findChapterIndexByUrl(AGE, 'http://www.agedm.io/play/20260335/1/2'), 1, 'http 与 https 同一章');
  assert.equal(findChapterIndexByUrl(AGE, 'https://www.agedm.io/play/20260335/1/2/'), 1, '尾斜杠');
  assert.equal(findChapterIndexByUrl(AGE, 'https://WWW.AGEDM.IO/play/20260335/1/2'), 1, 'host 大小写');
  assert.equal(findChapterIndexByUrl(AGE, 'https://www.agedm.io/play/20260335/1/2#t=30'), 1, 'fragment 不参与比较');
});

test('#387d 章节目录是**相对路径**时按候选 origin 补全（引擎可能下发相对 url）', () => {
  const rel = [{ url: '/play/9/1/1' }, { payload: { chapterUrl: '/play/9/1/2' } }];
  assert.equal(findChapterIndexByUrl(rel, 'https://www.agedm.io/play/9/1/2'), 1);
});

test('#387d 对偶（防空转）：非章节链接一律 -1 —— 不得把普通链接当换集', () => {
  assert.equal(findChapterIndexByUrl(AGE, 'https://www.agedm.io/rank'), -1, '站内其它页');
  assert.equal(findChapterIndexByUrl(AGE, 'https://jx.wuzhoupai.com:8443/vip/?url=age_x'), -1, '解析播放页');
  assert.equal(findChapterIndexByUrl(AGE, 'https://www.agedm.io/play/20260335/9/9'), -1, '同一站点但不存在的集');
  assert.equal(findChapterIndexByUrl(AGE, 'https://other.site/play/20260335/1/2'), -1, '别的域名（同 path）');
  assert.equal(findChapterIndexByUrl(AGE, 'mailto:a@b.c'), -1, '不可解析');
  assert.equal(findChapterIndexByUrl([], 'https://www.agedm.io/play/1/1'), -1, '空目录');
});

test('#387d 同 host+path 多章时用 query 打破歧义；对不上则不猜（宁当普通链接）', () => {
  const dup = [
    { url: 'https://s.test/w?ep=1' },
    { url: 'https://s.test/w?ep=2' },
  ];
  assert.equal(findChapterIndexByUrl(dup, 'https://s.test/w?ep=2'), 1, 'query 精确命中');
  assert.equal(findChapterIndexByUrl(dup, 'https://s.test/w?ep=9'), -1, 'query 对不上 ⇒ 不猜');
});
