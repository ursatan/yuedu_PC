/**
 * `utils/list-item.ts` 的回归锁 —— 作者/最新章节**在 `payload` 里，不在顶层**。
 *
 * ## 为什么这个文件值得有锁
 * `UnifiedItem`（`packages/core/src/contract/types.ts:92-110`）**没有 `author` 字段**，
 * 但前端多处把列表项当 `Record<string, unknown>` 用 ⇒ 写 `it.author` **既不报错也不报错**，
 * 只是恒为空串。这类 bug 没有任何编译期/运行期信号，**只能靠锁**。
 * 本轮就真出现过 3 处（`DiscoverView` 网格 + 列表、`SearchView`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemAuthor, itemLastChapter } from '../src/utils/list-item';

test('itemAuthor：作者在 payload.author —— 顶层 author 反而要被忽略', () => {
  // 引擎 list 阶段的真实形状（照抄 /api/run 的 items 结构；也正是 demo-engine.ts 现在产出的形状）
  assert.equal(itemAuthor({ payload: { url: 'x', author: '天蚕土豆', lastChapter: '第 1 章' } }), '天蚕土豆');
  // ★ 本轮的真缺陷：`it.author` 恒为空，但类型上不报错。必须证明这里**不**认它。
  assert.equal(itemAuthor({ author: '顶层作者', payload: {} }), '', 'payload 没有 author ⇒ 空（不拿顶层顶替）');
  assert.equal(itemAuthor({ author: '顶层作者' }), '', 'payload 整个缺失 ⇒ 空');
  // ★ 反向锁：**旧 fixture 的形状**（作者只在 subtitle、payload 里没有）必须读成空 ——
  //   这条的意义是「如果哪天又有人把作者挪出 payload，这条会立刻红」。
  assert.equal(itemAuthor({ subtitle: '演示作者 · 已完结 · 980万字', payload: { url: 'x' } }), '',
    '作者只在 subtitle 里 ⇒ 读成空（这正是本轮修掉的 fixture/前端不匹配）');
});

test('itemAuthor：留空不编造 —— 源没给作者就空（不拿 subtitle 顶替）', () => {
  // DiscoverView.vue:399-403 记着这条教训：subtitle = 作者 || 更新至，
  // 顶替会让「最新章节」被填进作者位（两行一起错位）。
  assert.equal(itemAuthor({ subtitle: '第 123 章 决战', payload: {} }), '', 'subtitle 不顶替作者');
  assert.equal(itemAuthor({ payload: null }), '');
  assert.equal(itemAuthor({ payload: '不是对象' }), '', 'payload 是脏数据也不抛错');
  assert.equal(itemAuthor(null), '');
  assert.equal(itemAuthor(undefined), '');
});

test('itemAuthor：非字符串一律当空（不 [object Object]）', () => {
  assert.equal(itemAuthor({ payload: { author: 123 } }), '', '数字不是字符串');
  assert.equal(itemAuthor({ payload: { author: { name: 'x' } } }), '', '对象不是字符串');
  assert.equal(itemAuthor({ payload: { author: '  天蚕土豆  ' } }), '天蚕土豆', '两端空白要裁（与 authorOf 原行为一致）');
  assert.equal(itemAuthor({ payload: { author: '   ' } }), '', '纯空白 = 空');
});

test('itemLastChapter：同样只在 payload 里', () => {
  assert.equal(itemLastChapter({ payload: { lastChapter: '第 1 章' } }), '第 1 章');
  assert.equal(itemLastChapter({ lastChapter: '顶层' }), '');
  assert.equal(itemLastChapter(null), '');
});
