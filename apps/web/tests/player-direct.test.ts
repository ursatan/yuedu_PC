/**
 * `#376` player store **direct 会话扩展**的回归锁：
 *  · `openDirect` 可带 `items`（LIVE 嗅探的选集列表）+ `index` —— 有选集语义；
 *  · `resolve` 的 direct 分支从 `payload.url` **零网络直取**（不跑 `runAction`）；
 *  · `followDirect`：页内切集跟随（换 url + index 对齐；同地址不动作；非 direct/未开不动作）。
 *
 * 为什么要锁：`openDirect` 旧形态 items 恒空 ⇒ PlayerOverlay 选集全禁；`#376` 让
 * direct 会话与 play/content 一样有「选集/上下集/跟随」能力 —— 这是三处（store 组装、
 * resolve 分流、followDirect）协同的行为，任何一处回归用户都会看到「只嗅到一集」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPinia, setActivePinia } from 'pinia';
import { usePlayerStore } from '../src/stores/player';

function setup(): ReturnType<typeof usePlayerStore> {
  setActivePinia(createPinia());
  return usePlayerStore();
}

test('direct · openDirect 带 items ⇒ 有选集列表；resolve 从 payload 直取（零网络）', async () => {
  const p = setup();
  p.openDirect({
    title: '测试片',
    url: 'https://cdn.com/ep2.m3u8',
    items: [
      { url: 'https://cdn.com/ep1.m3u8' },
      { url: 'https://cdn.com/ep2.m3u8' },
      { url: 'https://cdn.com/ep3.m3u8', format: 'm3u8' },
    ],
    index: 1,
  });
  assert.ok(p.open);
  assert.equal(p.session?.mode, 'direct');
  assert.equal(p.total, 3, 'items 进了选集列表 ⇒ PlayerOverlay 按 total 渲染选集');
  assert.equal(p.session?.index, 1);
  assert.equal(p.url, 'https://cdn.com/ep2.m3u8', '开播地址 = 传入 url');
  // resolve 直取走公开面 playAt（resolve 未导出；若它误走 runAction 网络会失败写 err）
  await p.playAt(0);
  assert.equal(p.url, 'https://cdn.com/ep1.m3u8');
  assert.equal(p.err, '', 'direct 直取零网络 ⇒ 无解析错误');
  await p.playAt(2);
  assert.equal(p.url, 'https://cdn.com/ep3.m3u8');
  assert.equal(p.format, 'm3u8', 'format 从 payload 一并直取');
  assert.equal(p.err, '');
});

test('direct · playAt 换集走 resolve 直取（选集切换可用）', async () => {
  const p = setup();
  p.openDirect({
    title: '测试片',
    url: 'https://cdn.com/ep1.m3u8',
    items: [{ url: 'https://cdn.com/ep1.m3u8' }, { url: 'https://cdn.com/ep2.m3u8' }],
  });
  await p.playAt(1);
  assert.equal(p.session?.index, 1);
  assert.equal(p.url, 'https://cdn.com/ep2.m3u8');
  assert.equal(p.err, '', 'direct 直取不应报错');
});

test('direct · resolve 对缺 url 的 payload 报错（不静默，经 playAt 落到 err）', async () => {
  const p = setup();
  p.openDirect({ title: 'x', url: 'https://a/1.m3u8', items: [{ url: 'https://a/1.m3u8' }] });
  // 手工造一个缺 url 的 payload（防御：组装逻辑被改坏时 fail-loud）
  p.session!.items.push({ title: '2', payload: {} });
  await p.playAt(1);
  assert.match(p.err, /没有直链/, 'playAt catch 到 resolve 的错并显示（不静默吞掉）');
});

test('followDirect · 换 url + index 对齐；同地址不动作', () => {
  const p = setup();
  p.openDirect({
    title: '测试片',
    url: 'https://cdn.com/ep1.m3u8',
    items: [{ url: 'https://cdn.com/ep1.m3u8' }, { url: 'https://cdn.com/ep2.m3u8' }, { url: 'https://cdn.com/ep3.m3u8' }],
    index: 0,
  });
  p.followDirect('https://cdn.com/ep3.m3u8', 'm3u8');
  assert.equal(p.url, 'https://cdn.com/ep3.m3u8');
  assert.equal(p.session?.index, 2, 'index 对齐到同地址项');
  assert.equal(p.format, 'm3u8');
  // 同地址 ⇒ 不动作（不重设、不闪）
  const before = p.session?.index;
  p.followDirect('https://cdn.com/ep3.m3u8');
  assert.equal(p.session?.index, before);
});

test('followDirect · 非 direct 会话 / 未打开 / 未知地址时安全不动作', () => {
  const p = setup();
  // 未打开
  p.followDirect('https://a/1.m3u8');
  assert.equal(p.open, false);
  // play 会话不受影响
  p.session = {
    mode: 'play', sourceId: 's1', title: 't', items: [{ title: '1', payload: {} }], index: 0,
  };
  p.open = true;
  p.url = 'https://a/old.m3u8';
  p.followDirect('https://a/1.m3u8');
  assert.equal(p.url, 'https://a/old.m3u8', 'play 会话不跟随 direct 语义');
  // direct 但未知地址：url 换、index 不动
  p.openDirect({ title: 'x', url: 'https://a/1.m3u8', items: [{ url: 'https://a/1.m3u8' }] });
  p.followDirect('https://a/unknown.m3u8');
  assert.equal(p.url, 'https://a/unknown.m3u8', '新地址（观察桥新候选）也接');
  assert.equal(p.session?.index, 0, '不在列表里 ⇒ index 保持');
});
