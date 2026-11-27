/**
 * `D1` **章节错误文案不入缓存**的回归锁。
 *
 * 缺陷形态：源规则失效时会把「提示语」当正文返回（语料实测 `请刷新查看内容` /
 * `未取到媒体地址` 等）。一旦写进 IndexedDB，以后每次点这一章都命中这条坏缓存，
 * 「刷新正文」也绕不过去 ⇒ 必须**写入前**就拒收。
 *
 * 判据只实现在 `putCachedChapter` 一处；本用例锁两件事：
 *  ① 错误文案（正文或标题）**不落库**；
 *  ② 正常正文照常写入并能读回（防止判据过宽把所有正文都杀掉）。
 *
 * ⚠️ 本仓 web 测试用 `tsx --test` 跑，没有 jsdom/IndexedDB ⇒ 这里注入一个**最小内存版**
 * IndexedDB（只实现 chapter-cache 用到的 open / createObjectStore / transaction / put / get）。
 *
 * 运行：`pnpm --filter @yuedu/web test`
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getCachedChapter, putCachedChapter } from '../src/utils/chapter-cache';

interface FakeDb {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string): unknown;
}

/** 最小可用 IndexedDB 假实现（同步内存 + 微任务回调） */
function makeFakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<unknown, unknown>>();
  const db: FakeDb = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      return {};
    },
    transaction: (name) => {
      const store = (): Record<string, unknown> => ({
        put(value: unknown, key: unknown): void {
          stores.get(name)!.set(key, value);
          queueMicrotask(() => (tx as { oncomplete?: () => void }).oncomplete?.());
        },
        get(key: unknown): unknown {
          const req: Record<string, unknown> = {};
          queueMicrotask(() => {
            req.result = stores.get(name)!.get(key);
            (req.onsuccess as (() => void) | undefined)?.();
          });
          return req;
        },
      });
      const tx: Record<string, unknown> = { objectStore: store };
      return tx;
    },
  };
  return {
    open: (): unknown => {
      const req: Record<string, unknown> = {};
      setTimeout(() => {
        req.result = db;
        // 真 IndexedDB 首次打开会先触发 upgradeneeded（建 store 的时机）
        if (!stores.size) (req.onupgradeneeded as (() => void) | undefined)?.();
        (req.onsuccess as (() => void) | undefined)?.();
      }, 0);
      return req;
    },
  } as unknown as IDBFactory;
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: makeFakeIndexedDb(), configurable: true });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'indexedDB', original);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

const payload = { chapterUrl: 'https://site.test/1.html' };

test('D1 ①: 正文段落命中错误文案 ⇒ 不写入缓存', async () => {
  await putCachedChapter('src', payload, { title: '第 1 章', paragraphs: ['请刷新查看内容'] });
  assert.equal(await getCachedChapter('src', payload), null, '错误文案不得落库');

  await putCachedChapter('src', payload, { title: '第 2 章', paragraphs: ['正文加载失败（已自动重试一次）：timeout'] });
  assert.equal(await getCachedChapter('src', payload), null, '带后缀的错误提示同样不得落库');
});

test('D1 ②: 标题命中错误文案 ⇒ 不写入缓存', async () => {
  await putCachedChapter('src', payload, { title: '本章正文为空', paragraphs: [] });
  assert.equal(await getCachedChapter('src', payload), null);
});

test('D1 ③: 正常正文照常写入并读回（判据不得误杀）', async () => {
  const body = {
    title: '第 3 章 加载失败之后',
    paragraphs: ['他说加载失败只是暂时的，别慌。', '第二段正常正文。'],
  };
  await putCachedChapter('src', payload, body);
  const hit = await getCachedChapter('src', payload);
  assert.ok(hit, '正常正文必须写入');
  assert.deepEqual(hit!.paragraphs, body.paragraphs);
  assert.equal(hit!.title, body.title);
});
