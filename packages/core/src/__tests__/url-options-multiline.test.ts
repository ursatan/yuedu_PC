/**
 * 回归锁：**跨行的 `,{options}` 尾巴不得被截断**（用户实测回归，2026-09-22）。
 *
 * ## 现场
 *
 * ⚡📂绿柠小说 的搜索书名页规则（Legado 的 UrlOption 写在**下一行**）：
 * ```
 * https://android.goreadnovels.com/getBooksList,{
 *   "body": "bids={{$.bid}}",
 *   "method": "POST"
 * }
 * ```
 *
 * `isUrl=true` 的字段求值会走 `AnalyzeRule.absolutize()`，而它旧实现是
 * `v.split('\n').find(s => s.trim() !== '')` —— **只取第一行**：
 *   · 产出被截成 `…getBooksList,{`（坏值）
 *   · 详情请求退化成 **GET**（`method`/`body` 全丢）→ 站点返回的不是详情数据
 *   · ⇒ 所有字段空 → `bid` 空 → **目录 0 章、正文空**
 *
 * 用户对比 `post7` 基线（那会儿 toc/content 都通过）发现的回归。
 *
 * 对齐 Legado：`NetworkUtils.getAbsoluteURL(base, url)` 只判断「是否已是绝对地址」，**不切行**；
 * `,{options}` 交给后续 `AnalyzeUrl` 统一解析（它本身允许跨行 JSON）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyzeRule } from '../selector/analyze';
import { createVariableStore } from '../store';

/** 最小 env：只给 `toAbsolute`（引擎注入的那一个） */
function makeRule(doc: string) {
  const env = {
    variables: createVariableStore(),
    toAbsolute: (v: string) => (v.startsWith('http') ? v : `https://base.test/${v.replace(/^\//, '')}`),
  };
  return new AnalyzeRule(env as never).setContent(doc);
}

const GREENLEMON_BOOK_URL =
  'https://android.goreadnovels.com/getBooksList,{\n  "body": "bids={{$.bid}}",\n  "method": "POST"\n}';

test('isUrl 字段求值：跨行的 ,{options} 尾巴必须完整保留（绿柠 getBooksList 形态）', () => {
  const ar = makeRule('{"bid": "449"}');
  const out = ar.syncGetString(GREENLEMON_BOOK_URL, true);
  assert.ok(out.includes('"method": "POST"'), `method 不得丢：${JSON.stringify(out)}`);
  assert.ok(out.includes('bids=449'), `body 里的插值必须求值：${JSON.stringify(out)}`);
  assert.ok(out.startsWith('https://android.goreadnovels.com/getBooksList'), `URL 前缀保留：${JSON.stringify(out)}`);
  assert.ok(!/^\S+,?\{$/.test(out.trim()), `不得被截成 …,{ —— 实际：${JSON.stringify(out)}`);
});

test('isUrl=false 时同样不得截断（字段求值的两条分支都要保）', () => {
  const ar = makeRule('{"bid": "449"}');
  const out = ar.syncGetString(GREENLEMON_BOOK_URL, false);
  assert.ok(out.includes('"method": "POST"'), `同步分支也不得丢选项：${JSON.stringify(out)}`);
  assert.ok(out.includes('bids=449'));
});

test('单行 URL 仍照常绝对化（历史行为不变）', () => {
  // ⚠️ 真实源里的 URL 规则几乎都带占位符（纯字面 URL 会被规则解析器当正则/DOM 串，不属本函数职责）
  const ar = makeRule('{"bid": "449"}');
  assert.equal(ar.syncGetString('https://cdn.test/{{$.bid}}.js', true), 'https://cdn.test/449.js');
  assert.equal(ar.syncGetString('{{baseUrl}}/chapter/list.do', true), 'https://base.test/chapter/list.do');
});

test('空值不绝对化（否则空属性会被拼成站点根）', () => {
  const ar = makeRule('{}');
  assert.equal(ar.syncGetString('', true), '');
});

test('多行但**不含** `,{` 时仍取首个非空行（避免改变其它源的既有语义）', () => {
  const ar = makeRule('{"bid": "449"}');
  assert.equal(
    ar.syncGetString('https://a.test/{{$.bid}}\n\n  https://b.test/{{$.bid}}', true),
    'https://a.test/449',
  );
});
