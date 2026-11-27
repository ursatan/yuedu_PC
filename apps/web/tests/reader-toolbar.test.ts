/**
 * `#221`：顶部工具栏「固定 / 收进更多」的配置读写。
 *
 * 判据是**老用户的数据**（只存了部分键）与**坏数据**：
 * 最危险的失败是「新增的按钮静默消失」—— 用户会以为功能被删了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { READER_TOOLS, loadToolPins, saveToolPins } from '../src/utils/reader-toolbar';

const KEY = 'yuedu.reader.toolbar.pins';

/** ★ Node 测试环境没有 localStorage ⇒ 装一个可编程的最小替身（同 `discover-view-mode.test.ts`） */
function stubStorage(initial: Record<string, string> = {}): void {
  const map = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
}

const serial = { concurrency: false }; // 这几条共享 globalThis.localStorage ⇒ 必须串行

test('#221 ① 没有任何存过 ⇒ 返回全部默认，且每个按钮都有明确取值', serial, () => {
  stubStorage();
  const p = loadToolPins();
  assert.deepEqual(Object.keys(p).sort(), READER_TOOLS.map((t) => t.id).sort());
  for (const t of READER_TOOLS) {
    assert.equal(typeof p[t.id], 'boolean', `${t.id} 必须有确定的布尔值，不能是 undefined`);
  }
});

test('#221 ② 老用户只存了部分键（老名单没有 cache）⇒ 新按钮按默认补齐，**不是静默消失**', serial, () => {
  stubStorage({ [KEY]: JSON.stringify({ refresh: false, readAloud: true }) });
  const p = loadToolPins();
  assert.equal(p.refresh, false, '存过的要照读');
  assert.equal(p.readAloud, true);
  assert.equal(typeof p.cache, 'boolean', '没存过的键必须补默认值');
  assert.equal(p.cache, false, 'cache 默认收进「更多」');
  // `#254`：替换（净化）开关默认收进「更多」—— 用户原话就是「放在更多按钮组里」。
  // 老用户（存过 pin 但没这个键）也必须补成 false，否则会凭空在标题栏多出一枚按钮。
  assert.equal(p.replace, false, 'replace 默认收进「更多」（#254）');
});

test('#221 ③ 坏数据（非法 JSON / 非对象 / 值不是布尔）⇒ 回落默认，不抛', serial, () => {
  stubStorage({ [KEY]: 'not-json{' });
  assert.equal(typeof loadToolPins().refresh, 'boolean');
  stubStorage({ [KEY]: '"一个字符串"' });
  assert.equal(loadToolPins().refresh, true, '非对象 ⇒ 全默认');
  stubStorage({ [KEY]: JSON.stringify({ refresh: 'yes' }) });
  assert.equal(loadToolPins().refresh, true, '值不是布尔 ⇒ 用默认，不当作 true');
});

test('#221 ④ 存了再读 ⇒ 逐键一致（含关掉的按钮）', serial, () => {
  stubStorage();
  const v = Object.fromEntries(READER_TOOLS.map((t, i) => [t.id, i % 2 === 0])) as Record<
    (typeof READER_TOOLS)[number]['id'],
    boolean
  >;
  saveToolPins(v);
  assert.deepEqual(loadToolPins(), v);
});

test('#221 ⑤ localStorage 整个不可用（隐私模式）⇒ 读回落默认、写不抛', serial, () => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(loadToolPins().refresh, true, '读不到 ⇒ 默认值，不抛');
  assert.doesNotThrow(() => saveToolPins({ refresh: false }));
});

/**
 * `#260`：新增的「起效替换」默认**收进「更多」**，且**老用户存的旧名单里没有这个键**时
 * 必须按默认补齐 —— 与 `#221` ② 同一个坑（新按钮静默消失 / 凭空多一枚）。
 */
test('#260 新增「起效替换」：默认收进「更多」，老名单缺键也补齐', serial, () => {
  stubStorage();
  assert.equal(loadToolPins().effectiveReplaces, false, '默认不常显');

  // 老用户（存过 pin，但那时还没有 effectiveReplaces 这个键）
  stubStorage({ [KEY]: JSON.stringify({ refresh: false, replace: true }) });
  const p = loadToolPins();
  assert.equal(p.replace, true, '存过的要照读');
  assert.equal(p.refresh, false);
  assert.equal(p.effectiveReplaces, false, '缺键必须补默认，不能是 undefined');
  assert.equal(typeof p.effectiveReplaces, 'boolean');
});
