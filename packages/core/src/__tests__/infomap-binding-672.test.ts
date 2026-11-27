/**
 * `#672` `infoMap` 绑定要复刻上游 `InfoMap` 类（不是裸 Map）。
 *
 * 上游 `io/legado/app/utils/InfoMap.kt:10-45`：
 * ```kotlin
 * class InfoMap(val sourceUrl: String): MutableMap<String, String> {
 *     fun save(time: Int = 0, need: Boolean = true)   // 只置 needSave
 *     fun saveNow()                                    // 真正落盘
 *     fun get(): MutableMap<String, String>            // 无参重载！
 *     fun set(value: Map<String, String>)              // 整体替换
 *     override fun get(key: String) / put / remove …
 * }
 * ```
 *
 * 实测缺陷（用户 2026-10-29，媚色MM）：`exploreUrl` 脚本末尾有 `infoMap.save()`，
 * 本仓绑定只有 Map 接口 ⇒ `infoMap.save is not a function` ⇒ 发现页只剩一条 `ERROR:` 分类、
 * 0 内容卡片。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeInfoMapBinding } from '../selector/js';

test('#672 save()/saveNow() 存在，且会通知调用方落盘', () => {
  let saves = 0;
  const map = new Map<string, string>([['排序', '默认']]);
  const b = makeInfoMapBinding(map, { onSave: () => { saves++; } }) as Record<string, unknown>;

  assert.equal(typeof b['save'], 'function', 'infoMap.save 必须是函数（上游 InfoMap.save）');
  assert.equal(typeof b['saveNow'], 'function');

  (b['save'] as () => void)();
  (b['saveNow'] as () => void)();
  assert.equal(saves, 2, 'save/saveNow 都应通知落盘');
});

test('#672 get() 无参返回整个 map（上游重载 get(): MutableMap）', () => {
  const map = new Map<string, string>([['排序', '热度'], ['频道', '男生']]);
  const b = makeInfoMapBinding(map) as Record<string, unknown>;
  const get = b['get'] as (k?: unknown) => unknown;

  assert.deepEqual(get(), { 排序: '热度', 频道: '男生' }, '无参必须返回全部键值');
  assert.equal(get('排序'), '热度', '带参仍是取单项');
  assert.equal(get('不存在'), undefined);
});

test('#672 set(map) 是整体替换，set(k, v) 仍是写入', () => {
  const map = new Map<string, string>([['旧键', '1'], ['排序', '默认']]);
  const b = makeInfoMapBinding(map) as Record<string, unknown>;
  const set = b['set'] as (a: unknown, b?: unknown) => unknown;

  set({ 排序: '最新' });
  assert.deepEqual(Object.fromEntries(map), { 排序: '最新' }, '单参对象必须整体替换（旧键清掉）');

  set('频道', '女生');
  assert.equal(map.get('频道'), '女生', '两参仍是普通写入');
});

test('#672 方括号读写与 put 不受影响（回归）', () => {
  const map = new Map<string, string>();
  const b = makeInfoMapBinding(map) as Record<string, unknown>;

  b['分组'] = '完本';
  assert.equal(map.get('分组'), '完本', '方括号赋值要落到宿主 Map');

  (b['put'] as (k: unknown, v: unknown) => unknown)('页', 2);
  assert.equal(map.get('页'), '2', 'put 要把数字转成字符串（上游 MutableMap<String,String>）');
});
