/**
 * `#689` 播放器「自动连播」开关的持久化回归锁。
 *
 * 为什么值得锁：这是**跨会话的观看偏好**。写坏了只有两种表现，都不明显：
 *   · 键名/取值写错 ⇒ 每次重开都回到默认，用户以为「开关不管用」；
 *   · 存储被禁（隐私模式）时抛错 ⇒ 整条播放链路连带失败（本不该）。
 * `localStorage` 的值属于**外部输入**（手改、旧版本残留、别的项目写脏同一个键），
 * 所以还要锁「非法值回落默认」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { usePlayerStore } from '../src/stores/player';

const KEY = 'yuedu-player-autonext';

/** Node 环境没有 localStorage ⇒ 装一个可编程替身（同 `discover-view-mode.test.ts` 的写法） */
function stubStorage(initial: Record<string, string> = {}): { map: Map<string, string> } {
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

function setup(): ReturnType<typeof usePlayerStore> {
  setActivePinia(createPinia());
  return usePlayerStore();
}

const serial = { concurrency: false }; // 共享 globalThis.localStorage ⇒ 必须串行

test('A-① 没有存过 ⇒ 默认开（短剧连看是主场景）', serial, () => {
  stubStorage();
  assert.equal(setup().autoNext, true);
});

test('A-② 关掉后写盘，重新进入仍是关', serial, () => {
  const { map } = stubStorage();
  const p = setup();
  p.setAutoNext(false);
  assert.equal(p.autoNext, false);
  assert.equal(map.get(KEY), '0', '落盘用 0/1，便于人肉排查');
  // 新 pinia 实例（等价于刷新页面后重新进 store）应读到 0
  assert.equal(setup().autoNext, false);
});

test('A-③ 存的是非法值（手改/旧版本残留）⇒ 回落默认开，不抛错', serial, () => {
  for (const bad of ['foo', '', 'true', '2']) {
    stubStorage({ [KEY]: bad });
    assert.equal(setup().autoNext, true, `非法值 ${JSON.stringify(bad)} 应回落默认`);
  }
});

test('A-④ 存储不可用（隐私模式写会抛）⇒ 只影响本次持久化，不改内存值也不抛', serial, () => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    get length() { return 0; },
  };
  const p = setup();
  assert.equal(p.autoNext, true, '读不到就按默认');
  assert.doesNotThrow(() => p.setAutoNext(false));
  assert.equal(p.autoNext, false, '写盘失败也要让本次会话生效');
});
