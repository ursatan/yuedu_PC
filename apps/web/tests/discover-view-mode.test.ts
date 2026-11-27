/**
 * `#184` 发现页内容区布局的**持久化** 回归锁。
 *
 * ## 为什么这几条值得锁（而不是靠真浏览器看一眼）
 * `localStorage` 里的值是**外部输入**：浏览器控制台手改、旧版本残留、别的项目写脏同一个键。
 * 一旦 `viewMode` 拿到一个非法值（比如 `'foo'`），`DiscoverView` 里
 * `viewMode === 'grid' / 'list' / 'wide'` **三个分支全部落空**
 * ⇒ **内容区整块空白，而且不报错、不崩、控制台干净** —— 这正是本项目最怕的那类「看起来坏了」。
 * ⇒ 白名单校验必须是可断言的纯函数，而不是散在 store 里的 `v === 'a' || v === 'b'`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VIEW_MODE,
  DISCOVER_VIEW_MODES,
  VIEW_MODE_KEY,
  loadViewMode,
  normalizeViewMode,
  saveViewMode,
} from '../src/utils/discover-view-mode';

/** ★ Node 测试环境没有 localStorage ⇒ 装一个可编程的最小替身。
 *  用 globalThis 而不是 import.meta.env —— 后者在 Node 下要额外配置。 */
function stubStorage(initial: Record<string, string> = {}): { map: Map<string, string>; throwOnWrite?: boolean } {
  const map = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  return { map };
}

const serial = { concurrency: false }; // 顶层 test() 默认并发，而这几条**共享 globalThis.localStorage**

test('★ 合法值原样通过（三个模式都要认）', serial, () => {
  stubStorage();
  for (const m of DISCOVER_VIEW_MODES) {
    assert.equal(normalizeViewMode(m), m, `${m} 应被认作合法布局`);
  }
  assert.deepEqual([...DISCOVER_VIEW_MODES], ['grid', 'list', 'wide'],
    '模式清单就是这三个（用户 2026-10-01：多列 / 列表 / 横屏；瀑布已移除）');
});

test('★★ 非法值必须回落默认，**不能**被当成合法值放行', serial, () => {
  // 这条是本文件存在的理由：一个非法值会让三个 v-if 全落空 ⇒ 内容区空白且无报错。
  for (const bad of ['', 'foo', 'GRID', 'wide ', 'waterfall', '瀑布', 'null', 'undefined', '0', '1']) {
    assert.equal(normalizeViewMode(bad), DEFAULT_VIEW_MODE,
      `非法值 ${JSON.stringify(bad)} 应回落 ${DEFAULT_VIEW_MODE}，不能原样放行`);
  }
  //非字符串（手改 localStorage 存了个 JSON 对象/数字的情况）
  for (const bad of [null, undefined, 0, 1, {}, [], true]) {
    assert.equal(normalizeViewMode(bad), DEFAULT_VIEW_MODE,
      `非字符串 ${JSON.stringify(bad)} 应回落默认`);
  }
});

test('★ 存-取往返：三种模式各自能读回来', serial, () => {
  stubStorage();
  for (const m of DISCOVER_VIEW_MODES) {
    saveViewMode(m);
    assert.equal(loadViewMode(), m, `${m} 存取往返应一致`);
  }
});

test('★ 键名**不含 kind**（用户偏好是全局一份，不是每个发现页各存）', serial, () => {
  const { map } = stubStorage();
  saveViewMode('list');
  assert.ok(map.has(VIEW_MODE_KEY), `应只写一个键 ${VIEW_MODE_KEY}`);
  // 显式钉住：多写一个按 kind 分的键，就等于「书院选了列表、切到影院又变多列」
  assert.ok(!VIEW_MODE_KEY.includes(':') && !VIEW_MODE_KEY.includes('legado') && !VIEW_MODE_KEY.includes('maccms'),
    `键名 ${VIEW_MODE_KEY} 不该带 kind 分隔 —— 布局是用户偏好，全局一份`);
});

test('★ 读不到 / 存的是坏值 ⇒ 默认（首次访问、隐私模式都走这条）', serial, () => {
  stubStorage();
  assert.equal(loadViewMode(), DEFAULT_VIEW_MODE, '空存储应给默认');
  stubStorage({ [VIEW_MODE_KEY]: '乱写的' });
  assert.equal(loadViewMode(), DEFAULT_VIEW_MODE, '存了坏值应给默认，而不是把界面搞空白');
});

test('★ localStorage 整个不可用时**不抛**（隐私模式 / 无 DOM 环境）', serial, () => {
  // getItem 抛
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceeded'); },
  };
  assert.equal(loadViewMode(), DEFAULT_VIEW_MODE, '读抛异常应回落默认，不能把整个发现页带崩');
  assert.equal(saveViewMode('wide'), false, '写失败要如实返回 false（好让调用方留痕）');
});

test('★ saveViewMode 返回 true 表示真写进去了', serial, () => {
  stubStorage();
  assert.equal(saveViewMode('wide'), true);
  assert.equal(loadViewMode(), 'wide');
});