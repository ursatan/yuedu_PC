/**
 * `#310` 源**能力事实**（`hasSearch` / `hasExplore`）的回归锁。
 *
 * ## 为什么值得锁
 * 这两个值决定四个入口的显隐：源列表的「搜索/发现」滑块、发现页的 ⌕ 搜索按钮、
 * 聚合搜索与换源搜索的源列表。判错的方向有两种，**症状完全不同**：
 *  · 判**宽**（说能搜，其实没规则）⇒ 入口出现，点下去拿到
 *    `UNSUPPORTED_ACTION · 该订阅源未配置 searchUrl，不支持搜索`（**用户会来报错**）；
 *  · 判**严**（说不能搜，其实有规则）⇒ 入口**静默消失**，用户以为功能没了（**没人会来报错**）。
 * 后者更危险，所以每条断言都配了「相反方向」的对偶。
 *
 * ## 实测缺陷（`#310`）
 * `hasSearch` 此前只有 `legado` 一个分支走表达式，其余一律 `true` ⇒ **订阅源没有 `searchUrl`
 * 也被当成能搜**（判宽）。同时 `hasExplore` 对非 legado 一律 `true`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeHasSearch, computeHasExplore, computeWebViewOnly, computeHasStartPage } from '../source-caps';

/* ------------------------------------------------------------------ hasSearch */

test('hasSearch · legado：`searchUrl` 与 `ruleSearch.searchUrl` 两条都要认', () => {
  assert.equal(computeHasSearch('legado', { searchUrl: 'https://a/s?q={{key}}' }), true);
  // 空串 / 纯空白 = 没有模板（引擎 trim 后当空）
  assert.equal(computeHasSearch('legado', { searchUrl: '   ' }), false);
  assert.equal(computeHasSearch('legado', {}), false);
  // 旧形态：搜索模板藏在 ruleSearch 里
  assert.equal(computeHasSearch('legado', { ruleSearch: { searchUrl: 'https://a/s?q={{key}}' } }), true);
  assert.equal(computeHasSearch('legado', { ruleSearch: { searchUrl: ' ' } }), false);
});

test('hasSearch · rss【#310 的修复点】：有 `searchUrl` 才算能搜', () => {
  assert.equal(computeHasSearch('rss', { searchUrl: 'https://feed/?q={{key}}' }), true);
  assert.equal(computeHasSearch('rss', {}), false, '没有 searchUrl ⇒ 不能搜（修复前恒 true ⇒ 判宽）');
  assert.equal(computeHasSearch('rss', { searchUrl: '  ' }), false, '空白串同样不算');
});

test('hasSearch【对偶】：legado 的写法不能串到 rss 上（两边判据不同源）', () => {
  // rss 上游只有 `RssSource.searchUrl`（没有 ruleSearch 这一层）
  assert.equal(computeHasSearch('rss', { ruleSearch: { searchUrl: 'https://a' } }), false);
  // 而 legado 认它 —— 证明两条分支**确实不同**，不是被写成同一个
  assert.equal(computeHasSearch('legado', { ruleSearch: { searchUrl: 'https://a' } }), true);
});

test('hasSearch · maccms / demo：恒可搜（搜索请求由引擎按站点形态拼，不依赖源 url）', () => {
  assert.equal(computeHasSearch('maccms', {}), true);
  assert.equal(computeHasSearch('demo', {}), true);
});

/* ----------------------------------------------------------------- hasExplore */

test('hasExplore · legado：看 `exploreUrl`（对齐 BookSourcePart.hasExploreUrl）', () => {
  assert.equal(computeHasExplore('legado', { exploreUrl: 'https://a/class' }), true);
  assert.equal(computeHasExplore('legado', { exploreUrl: '  ' }), false);
  assert.equal(computeHasExplore('legado', {}), false, '只有 ruleExplore 没有 exploreUrl ⇒ 发现页本就不该出现它');
});

test('hasExplore【#310 用户需求①】：rss 恒 true（它没有发现**开关**，不等于没有发现能力）', () => {
  // 上游 RssSource 没有 enabledExplore ⇒ 前端不渲染滑块；但订阅源有 sortUrl 驱动发现页
  assert.equal(computeHasExplore('rss', {}), true);
  assert.equal(computeHasExplore('rss', { exploreUrl: '' }), true, '别把 legado 的判据套上来');
  // 对偶：legado 在同样输入下是 false —— 两条分支确实不同
  assert.equal(computeHasExplore('legado', { exploreUrl: '' }), false);
});

/* --------------------------------------------------------------- webViewOnly（`#335` */

test('webViewOnly · rss：只认 `singleUrl === true`（与引擎 `singleUrlOnly` 同一条判据）', () => {
  assert.equal(computeWebViewOnly('rss', { singleUrl: true }), true);
  assert.equal(computeWebViewOnly('rss', { singleUrl: false }), false);
  assert.equal(computeWebViewOnly('rss', {}), false);
  // ★ 字符串 "true" **不算**：上游是 Boolean 字段，引擎也是 `=== true`；放宽就与引擎分岔
  assert.equal(computeWebViewOnly('rss', { singleUrl: 'true' }), false);
});

test('webViewOnly【对偶】：非 rss 一律 false，且**不掺** legado 的字段', () => {
  assert.equal(computeWebViewOnly('legado', { singleUrl: true }), false);
  assert.equal(computeWebViewOnly('maccms', { singleUrl: true }), false);
  // 用户实测的三个源（全版本汇总 / 源仓库 / XH发布页）都是 singleUrl ⇒ 必须判得出
  assert.equal(computeWebViewOnly('rss', { sourceUrl: 'https://legado.erchuang.online/', singleUrl: true }), true);
});

/* --------------------------------------------------------------- hasStartPage（`#404` */

test('hasStartPage · rss：`startHtml` 非空为真（对偶：空/空白/非 rss 为假）', () => {
  assert.equal(computeHasStartPage('rss', { startHtml: '<html/>' }), true);
  assert.equal(computeHasStartPage('rss', { startHtml: "@js:'<div/>'" }), true);
  assert.equal(computeHasStartPage('rss', { startHtml: '' }), false);
  assert.equal(computeHasStartPage('rss', { startHtml: '   ' }), false);
  assert.equal(computeHasStartPage('rss', {}), false);
  assert.equal(computeHasStartPage('legado', { startHtml: '<html/>' }), false, '书源没有启动页语义');
  assert.equal(computeHasStartPage('maccms', { startHtml: '<html/>' }), false);
});
