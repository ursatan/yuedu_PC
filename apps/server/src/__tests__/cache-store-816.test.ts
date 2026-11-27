/**
 * `#816` B5：六类缓存的分区记账 / 配额 / LRU 驱逐 / 清理。
 *
 * 这里只测服务端四类（`cover`/`manga`/`image`/`localbook`）——
 * 浏览器端 `toc`/`content` 的统计与清理由设置页在 IndexedDB 侧完成（见 `chapter-cache.ts`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_CATEGORIES,
  CACHE_CATEGORY_SPECS,
  DEFAULT_CACHE_CONFIG,
  createCacheStore,
  mergeCacheConfig,
  resolveCacheConfig,
} from '../cache-store';

function tmpRoot(): { root: string; dir: string; cfg: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuedu-cache-'));
  return { root, dir: path.join(root, 'cache'), cfg: path.join(root, 'cache-config.json') };
}

test('#816 六类默认值与归属：封面/目录/正文/漫画/图片/本地书', () => {
  assert.deepEqual([...CACHE_CATEGORIES], ['cover', 'toc', 'content', 'manga', 'image', 'localbook']);
  const labels = CACHE_CATEGORY_SPECS.map((s) => s.label);
  assert.deepEqual(labels, ['封面缓存', '目录缓存', '正文缓存', '漫画缓存', '图片缓存', '本地书缓存']);
  const browser = CACHE_CATEGORY_SPECS.filter((s) => s.storage === 'browser').map((s) => s.key);
  assert.deepEqual(browser, ['toc', 'content'], '目录/正文的权威数据在浏览器 IndexedDB');
  // 默认上限照 ref 文档 §3-B5 的拍板建议
  const MB = 1024 * 1024;
  assert.deepEqual(DEFAULT_CACHE_CONFIG.categories.cover, { maxItems: 300, maxBytes: 50 * MB, ttlMs: 30 * 60_000 });
  assert.deepEqual(DEFAULT_CACHE_CONFIG.categories.toc, { maxItems: 200, maxBytes: 20 * MB, ttlMs: 0 });
  assert.deepEqual(DEFAULT_CACHE_CONFIG.categories.content, { maxItems: 200, maxBytes: 50 * MB, ttlMs: 0 });
  assert.deepEqual(DEFAULT_CACHE_CONFIG.categories.manga, { maxItems: 1000, maxBytes: 150 * MB, ttlMs: 7 * 24 * 60 * 60_000 });
  assert.deepEqual(DEFAULT_CACHE_CONFIG.categories.image, { maxItems: 500, maxBytes: 100 * MB, ttlMs: 7 * 24 * 60 * 60_000 });
  assert.deepEqual(DEFAULT_CACHE_CONFIG.categories.localbook, { maxItems: 50, maxBytes: 30 * MB, ttlMs: 24 * 60 * 60_000 });
  assert.equal(DEFAULT_CACHE_CONFIG.totalMaxBytes, 200 * MB);
});

test('#816 配额补丁：只改给出的字段，坏值 clamp 回默认', () => {
  const merged = mergeCacheConfig(DEFAULT_CACHE_CONFIG, {
    totalMaxBytes: 10 * 1024 * 1024,
    categories: { cover: { maxItems: 3 } },
  });
  assert.equal(merged.totalMaxBytes, 10 * 1024 * 1024);
  assert.equal(merged.categories.cover.maxItems, 3);
  assert.equal(merged.categories.cover.maxBytes, DEFAULT_CACHE_CONFIG.categories.cover.maxBytes, '未给的字段保持原值');
  assert.equal(merged.categories.image.maxItems, DEFAULT_CACHE_CONFIG.categories.image.maxItems);
  // 负数/NaN 一律回落默认值（不能因为一次输入把整类缓存关掉）
  const bad = resolveCacheConfig({ totalMaxBytes: -1, categories: { cover: { maxItems: -5, maxBytes: 'x' } } });
  assert.equal(bad.totalMaxBytes, DEFAULT_CACHE_CONFIG.totalMaxBytes);
  assert.equal(bad.categories.cover.maxItems, DEFAULT_CACHE_CONFIG.categories.cover.maxItems);
  assert.equal(bad.categories.cover.maxBytes, DEFAULT_CACHE_CONFIG.categories.cover.maxBytes);
  // 0 是合法值：关闭该类缓存
  const off = mergeCacheConfig(DEFAULT_CACHE_CONFIG, { categories: { image: { maxBytes: 0 } } });
  assert.equal(off.categories.image.maxBytes, 0);
});

test('#816 存取往返 + 命中刷新 LRU + 分类统计', async () => {
  const { dir, cfg } = tmpRoot();
  const store = createCacheStore({ dir, configFile: cfg, persistDebounceMs: 0 });
  await store.init();
  assert.equal(await store.put('cover', 's1|http://a/1.jpg', Buffer.from('aaa'), 'image/jpeg'), true);
  const hit = await store.get('cover', 's1|http://a/1.jpg');
  assert.equal(hit?.buf.toString(), 'aaa');
  assert.equal(hit?.type, 'image/jpeg');
  const stats = await store.stats();
  const cover = stats.categories.find((c) => c.key === 'cover')!;
  assert.equal(cover.items, 1);
  assert.equal(cover.bytes, 3);
  // 浏览器两类不由服务端记账
  const toc = stats.categories.find((c) => c.key === 'toc')!;
  assert.equal(toc.items, null);
  assert.equal(toc.bytes, null);
  assert.equal(stats.total.bytes, 3);
  await store.dispose();
});

test('#816 TTL：过期条目读取时被删，统计也不再计入', async () => {
  const { dir, cfg } = tmpRoot();
  let now = 1_000_000;
  const store = createCacheStore({ dir, configFile: cfg, now: () => now, persistDebounceMs: 0 });
  await store.updateConfig({ categories: { cover: { ttlMs: 1000 } } });
  await store.put('cover', 'k', Buffer.from('x'), 'image/png');
  assert.ok(await store.get('cover', 'k'));
  now += 2000;
  assert.equal(await store.get('cover', 'k'), null, 'TTL 到期后不得再返回旧字节');
  const stats = await store.stats();
  assert.equal(stats.categories.find((c) => c.key === 'cover')!.items, 0);
  await store.dispose();
});

test('#816 每类条数上限：超了删最久没用的（LRU 命中会保命）', async () => {
  const { dir, cfg } = tmpRoot();
  let now = 1_000;
  const store = createCacheStore({ dir, configFile: cfg, now: () => now, persistDebounceMs: 0 });
  await store.updateConfig({ categories: { cover: { maxItems: 2, maxBytes: 10 * 1024 * 1024 } } });
  await store.put('cover', 'a', Buffer.from('a'), 'image/png');
  now += 100;
  await store.put('cover', 'b', Buffer.from('b'), 'image/png');
  now += 100;
  await store.get('cover', 'a'); // 命中 ⇒ a 变成最近使用
  now += 100;
  await store.put('cover', 'c', Buffer.from('c'), 'image/png'); // 触发淘汰：应删 b
  assert.equal(await store.get('cover', 'b'), null);
  assert.ok(await store.get('cover', 'a'));
  assert.ok(await store.get('cover', 'c'));
  await store.dispose();
});

test('#816 总上限：跨类按 LRU 淘汰（分项没满也要让位）', async () => {
  const { dir, cfg } = tmpRoot();
  let now = 1_000;
  const store = createCacheStore({ dir, configFile: cfg, now: () => now, persistDebounceMs: 0 });
  await store.updateConfig({
    totalMaxBytes: 8,
    categories: {
      cover: { maxItems: 10, maxBytes: 10 },
      image: { maxItems: 10, maxBytes: 10 },
    },
  });
  await store.put('cover', 'c1', Buffer.from('1234'), 'image/png');
  now += 100;
  await store.put('image', 'i1', Buffer.from('1234'), 'image/png');
  now += 100;
  await store.put('image', 'i2', Buffer.from('1234'), 'image/png'); // 总 12 > 8 ⇒ 删最早的 c1
  assert.equal(await store.get('cover', 'c1'), null);
  assert.ok(await store.get('image', 'i1'));
  assert.ok(await store.get('image', 'i2'));
  const stats = await store.stats();
  assert.ok(stats.total.bytes <= 8);
  await store.dispose();
});

test('#816 单条超限拒收；关闭某类后不再写盘', async () => {
  const { dir, cfg } = tmpRoot();
  const store = createCacheStore({ dir, configFile: cfg, maxEntryBytes: 4, persistDebounceMs: 0 });
  assert.equal(await store.put('cover', 'big', Buffer.from('12345'), 'image/png'), false);
  await store.updateConfig({ categories: { image: { maxBytes: 0 } } });
  assert.equal(await store.put('image', 'k', Buffer.from('12'), 'image/png'), false);
  assert.equal(await store.get('image', 'k'), null);
  await store.dispose();
});

test('#816 单类清理 / 全部清理：文件同时从磁盘删掉', async () => {
  const { dir, cfg } = tmpRoot();
  const store = createCacheStore({ dir, configFile: cfg, persistDebounceMs: 0 });
  await store.put('cover', 'c', Buffer.from('cover'), 'image/png');
  await store.put('image', 'i', Buffer.from('image'), 'image/png');
  await store.put('localbook', 'b', Buffer.from('book'), 'application/json');
  const cleared = await store.clear('cover');
  assert.deepEqual(cleared, { items: 1, bytes: 5 });
  assert.equal(await store.get('cover', 'c'), null);
  assert.ok(await store.get('image', 'i'), '单类清理不得误伤其他类');
  const files = fs.readdirSync(path.join(dir, 'cover')).filter((n) => n.endsWith('.bin'));
  assert.equal(files.length, 0);
  const all = await store.clear('all');
  assert.equal(all.items, 2);
  assert.equal((await store.stats()).total.bytes, 0);
  // 浏览器两类交给前端清：服务端 clear('toc') 返回 0
  assert.deepEqual(await store.clear('toc'), { items: 0, bytes: 0 });
  await store.dispose();
});

test('#816 配置落盘 + 索引可重载（重启后缓存与配额都还在）', async () => {
  const { dir, cfg } = tmpRoot();
  const a = createCacheStore({ dir, configFile: cfg, persistDebounceMs: 0 });
  await a.updateConfig({ totalMaxBytes: 7, categories: { cover: { maxItems: 9 } } });
  await a.put('cover', 'k', Buffer.from('hello'), 'image/png');
  await a.dispose();

  const b = createCacheStore({ dir, configFile: cfg, persistDebounceMs: 0 });
  await b.init();
  assert.equal(b.getConfig().totalMaxBytes, 7);
  assert.equal(b.getConfig().categories.cover.maxItems, 9);
  const hit = await b.get('cover', 'k');
  assert.equal(hit?.buf.toString(), 'hello', '重启后缓存应命中（不用回源）');
  await b.dispose();
});

test('#816 索引缺失时孤儿文件被清理（不会把错图当对图发）', async () => {
  const { dir, cfg } = tmpRoot();
  fs.mkdirSync(path.join(dir, 'cover'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cover', 'orphan.bin'), 'x');
  const store = createCacheStore({ dir, configFile: cfg, persistDebounceMs: 0 });
  await store.init();
  assert.equal(fs.existsSync(path.join(dir, 'cover', 'orphan.bin')), false);
  await store.dispose();
});
