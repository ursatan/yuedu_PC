/**
 * `#539` **段评字段对齐**回归锁（上游 `ReviewRule.kt`，2026-10-20 对差）。
 *
 * 锁三件事：
 *  ① 对象形态的 `ruleReview`（27 字段全 populate）过编译**一个不少**（字段对齐的判据）；
 *  ② 字符串旧格式（上游 jsonDeserializer 兼容的形态）被规范化成 `{ reviewUrl }`；
 *  ③ 没配 ruleReview 的源不受影响（不凭空造字段）。
 *
 * 只锁**字段保命**（导入/编辑/导出不丢）；段评引擎求值与 UI 未实现（语料 0 覆盖）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileBookSource, type ReviewRule } from '../model/book-source';

const base = {
  bookSourceName: '段评对齐测试源',
  bookSourceUrl: 'https://review.test',
  searchUrl: 'https://review.test/search?q={{key}}',
  ruleSearch: { bookList: '.item', name: '.name', author: '.author', bookUrl: '.name@href' },
};

test('① ruleReview 30 字段过编译一个不少（#539 对齐上游 ReviewRule.kt）', () => {
  const ruleReview: ReviewRule = {
    reviewUrl: 'https://r.test/review?c={{chapterUrl}}',
    avatarRule: '.avatar@src',
    contentRule: '.content',
    postTimeRule: '.time',
    reviewQuoteUrl: 'https://r.test/quote',
    voteUpUrl: 'https://r.test/up',
    voteDownUrl: 'https://r.test/down',
    postReviewUrl: 'https://r.test/post',
    postQuoteUrl: 'https://r.test/postQuote',
    deleteUrl: 'https://r.test/delete',
    enabled: true,
    reviewSummaryUrl: 'https://r.test/summary',
    summaryListRule: '.sum-list',
    summaryParagraphIndexRule: '.p-index',
    summaryParagraphDataRule: '.p-data',
    summaryCountRule: '.count',
    reviewDetailUrl: 'https://r.test/detail',
    reviewDetailNextPageUrl: 'https://r.test/detail?p={{page}}',
    detailListRule: '.d-list',
    detailIdRule: '.d-id',
    detailAvatarRule: '.d-avatar',
    detailNameRule: '.d-name',
    detailBadgeRule: '.d-badge',
    detailContentRule: '.d-content',
    replyListRule: '.r-list',
    replyIdRule: '.r-id',
    replyAvatarRule: '.r-avatar',
    replyNameRule: '.r-name',
    replyBadgeRule: '.r-badge',
    replyContentRule: '.r-content',
  };
  const out = compileBookSource({ ...base, ruleReview });
  assert.equal(out.ok, true, `编译应通过：${JSON.stringify(out.issues)}`);
  const got = out.rule?.ruleReview as ReviewRule | undefined;
  assert.ok(got, 'ruleReview 不能丢');
  // 逐字段对拍（一个都不能少、一个都不能变）
  for (const [k, v] of Object.entries(ruleReview)) {
    assert.deepEqual(got[k], v, `字段 ${k} 丢失或变了`);
  }
  assert.equal(Object.keys(got).length, 30, '字段数应与上游一致（30）');
});

test('② ruleReview 字符串旧格式规范化成 { reviewUrl }（上游 jsonDeserializer 同语义）', () => {
  const out = compileBookSource({ ...base, ruleReview: 'https://r.test/legacy?u={{chapterUrl}}' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.rule?.ruleReview, { reviewUrl: 'https://r.test/legacy?u={{chapterUrl}}' });
});

test('③ 没配 ruleReview 的源不凭空造字段', () => {
  const out = compileBookSource({ ...base });
  assert.equal(out.ok, true);
  assert.equal('ruleReview' in (out.rule ?? {}), false, '不应凭空添加 ruleReview');
});
