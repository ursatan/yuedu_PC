/**
 * `#152` 截断登记环 —— 回归锁。
 *
 * 这个环是「被截断」与「站点返回空」在**用户可见层面**分开的数据基础：
 * `/api/run` 靠「运行前后水位差」把本轮的截断随结果回传前端。
 * 水位语义错了（漏报/重复/乱序）前端就会把「截断」说成「空」，或反过来静默。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetTruncatedLogForTest,
  recordTruncatedFetch,
  takeTruncatedSince,
  truncatedMark,
} from '../net/truncated-log';

test('水位语义：mark 之后登记的才被取到，且 next 单调推进', () => {
  __resetTruncatedLogForTest();
  const m0 = truncatedMark();
  assert.equal(m0, 0, '重置后水位应为 0');

  recordTruncatedFetch('https://a.test/x', 100);
  const { list, next } = takeTruncatedSince(m0);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.url, 'https://a.test/x');
  assert.equal(list[0]?.bytes, 100);
  assert.ok(next > m0, '水位必须推进');

  // 旧水位再取会重复取到（调用方要用 next 更新水位）—— 这是契约的一部分
  assert.equal(takeTruncatedSince(m0).list.length, 1);
  // 用新水位取 ⇒ 空
  assert.equal(takeTruncatedSince(next).list.length, 0);
});

test('环溢出：超过容量后旧记录被丢弃，但水位差仍如实（多报不漏报的边界）', () => {
  __resetTruncatedLogForTest();
  const m = truncatedMark();
  for (let i = 0; i < 260; i += 1) recordTruncatedFetch(`https://x.test/${i}`, i);
  const { list, next } = takeTruncatedSince(m);
  // 容量 200：260 次登记后环里只剩最后 200 条
  assert.equal(list.length, 200);
  assert.equal(list[0]?.url, 'https://x.test/60', '最老的 60 条被挤出环（其 url 已不可考，但 count 如实）');
  assert.equal(next - m, 260, '水位差反映真实发生次数');
});

test('并发交错：其它请求的登记不丢、按序回放', () => {
  __resetTruncatedLogForTest();
  const m = truncatedMark();
  recordTruncatedFetch('https://a.test/1', 1);
  recordTruncatedFetch('https://b.test/2', 2);
  recordTruncatedFetch('https://c.test/3', 3);
  const { list } = takeTruncatedSince(m);
  assert.deepEqual(list.map((t) => t.url), ['https://a.test/1', 'https://b.test/2', 'https://c.test/3'],
    '必须按发生顺序回放（排障时对时间线）');
});
