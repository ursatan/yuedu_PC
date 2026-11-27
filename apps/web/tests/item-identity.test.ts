/**
 * `#176` 列表项**身份键**（`v-for` 的 `:key`）—— 回归锁。
 *
 * ## 要防的那个 bug（用户 2026-10-01 实测）
 * 「书院/影院发现页，切换分类，加载图片时会看到之前图片残留」。
 *
 * ## 根因与为什么单测能锁住它
 * `:key="i"`（数组下标）在切分类时**两批数据的 key 完全相同**（都是 `0,1,2…`）
 * ⇒ Vue 判定「还是这批 DOM 节点」，只更新属性、**不重建节点** ⇒ 封面 `<img>` 实例被复用。
 * 而浏览器在 `<img src>` 变更时**不会立刻卸载旧图**（要等新图 `decode()` 完成）
 * ⇒ 旧封面就闪在新的卡片上。
 *
 * ⚠️ 这类 bug **不能用「跑起来看看」来锁**：DOM 复用的后果依赖时序（网络快慢、
 * 滚动位置、缓存命中），很容易「这次没复现」就算过。所以改成锁**不变量**：
 *「两个不同条目拿到不同的 key」—— 这个性质一旦破了，`v-for` 复用就一定会发生。
 *
 * @see apps/web/src/utils/list-item.ts 的 itemIdentity
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { itemIdentity } from '../src/utils/list-item';

/** 造一个最小 `UnifiedItem`（字段按契约，够 itemIdentity 用即可） */
function item(over: Record<string, unknown> = {}): never {
  return {
    id: '', kind: 'book', title: '', payload: {}, ...over,
  } as never;
}

test('★ 不同条目 ⇒ 不同 key（下标复用会发生的条件，必须不成立）', () => {
  // 模拟「切换分类」：两组数据，下标相同但内容不同
  const before = [
    item({ title: '斗破苍穹', payload: { bookUrl: 'https://a.com/1' } }),
    item({ title: '庆余年', payload: { bookUrl: 'https://a.com/2' } }),
  ];
  const after = [
    item({ title: '诡秘之主', payload: { bookUrl: 'https://b.com/1' } }),
    item({ title: '凡人修仙传', payload: { bookUrl: 'https://b.com/2' } }),
  ];
  const kb = before.map(itemIdentity);
  const ka = after.map(itemIdentity);
  for (const k of kb) assert.ok(!ka.includes(k), `切换分类后 key 撞了：${k}`);
  //同一条数据多次渲染必须稳定（否则每次重渲染都重建节点，性能崩）
  assert.deepEqual(kb, before.map(itemIdentity));
});

test('★ 同一批里两个同名条目（标题相同、内容身份不同）也不能撞', () => {
  const a = item({ title: '三体', payload: { bookUrl: 'https://x.com/a' } });
  const b = item({ title: '三体', payload: { bookUrl: 'https://y.com/b' } });
  assert.notEqual(itemIdentity(a), itemIdentity(b));
});

test('跨源同书：kind 带进 key，避免两个源的同一本书共用节点', () => {
  const fromA = item({ kind: 'book', title: '红楼梦', payload: { bookUrl: 'https://a.com/hlm' } });
  const fromB = item({ kind: 'video', title: '红楼梦', payload: { bookUrl: 'https://a.com/hlm' } });
  assert.notEqual(itemIdentity(fromA), itemIdentity(fromB));
});

test('视频条目：vodId 与 bookUrl 同等对待（MacCMS 源只给 vodId）', () => {
  const k = itemIdentity(item({ kind: 'video', title: '某剧', payload: { vodId: 'v-42' } }));
  assert.ok(k.includes('v-42'), `应含 vodId，实际 ${k}`);
});

test('payload 是脏数据（非对象/缺字段）⇒ 不抛，且退化到 engine id + 标题', () => {
  assert.equal(itemIdentity(null), '');
  assert.equal(itemIdentity(undefined), '');
  for (const bad of [null, undefined, 42, 'str', []]) {
    const k = itemIdentity(item({ id: 'e-1', title: '兜底', payload: bad }) as never);
    assert.ok(typeof k === 'string' && k.length > 0, `脏数据 ${JSON.stringify(bad)} 应得到非空 key`);
  }
});

test('字段顺序不同但内容相同 ⇒ key 相同（不能因payload 字段顺序而抖动）', () => {
  const a = itemIdentity(item({ title: 'A', payload: { bookUrl: 'u', author: 'x' } }));
  const b = itemIdentity(item({ title: 'A', payload: { author: 'x', bookUrl: 'u' } }));
  assert.equal(a, b);
});

test('空白要裁掉：源给的 URL 常常首尾带换行/空格', () => {
  const a = itemIdentity(item({ payload: { bookUrl: '  https://a.com/1 \n' } }));
  const b = itemIdentity(item({ payload: { bookUrl: 'https://a.com/1' } }));
  assert.equal(a, b);
});