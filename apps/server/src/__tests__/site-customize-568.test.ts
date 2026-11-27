/**
 * `#568` 站点定制存储回归锁：落盘 / 覆盖 / 空即删 / 校验 / 原子写。
 *
 * 为什么值得单测：这是**用户数据**（手写的 CSS/JS）。写坏一次 = 用户配置全丢且难恢复；
 * 而「空内容 = 删除」这类语义如果只写在 UI 里，换个入口（API 直调）就会留下空记录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSiteCustomizeStore } from '../site-customize-store';

function withStore(fn: (file: string, store: ReturnType<typeof createSiteCustomizeStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'yuedu-sc-'));
  const file = join(dir, 'site-customize.json');
  try {
    fn(file, createSiteCustomizeStore(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#568 存储：新增/覆盖/排序，落盘可重新读回', () => {
  withStore((file, store) => {
    assert.equal(store.upsert({ host: 'https://www.Example.com/a', css: 'body{color:red}' }).ok, true);
    assert.equal(store.upsert({ host: 'a.example.com', js: 'void 0' }).ok, true);
    const list = store.list();
    assert.deepEqual(list.map((x) => x.host), ['a.example.com', 'www.example.com'], '按 host 排序');

    // 覆盖同一 host：不产生第二条
    store.upsert({ host: 'www.example.com', css: 'body{color:blue}' });
    assert.equal(store.list().length, 2);
    assert.equal(store.list().find((x) => x.host === 'www.example.com')?.css, 'body{color:blue}');

    // 新实例读同一文件（模拟重启）
    const again = createSiteCustomizeStore(file);
    assert.equal(again.list().length, 2);
    assert.equal(again.match('https://www.example.com/x')?.css, 'body{color:blue}');
    assert.equal(again.match('https://a.example.com/x')?.js, 'void 0');
    assert.equal(again.match('https://evil.com/x'), null);
  });
});

test('#568 存储：空内容 = 删除（不留空记录）', () => {
  withStore((_file, store) => {
    store.upsert({ host: 'example.com', css: 'a{}' });
    assert.equal(store.list().length, 1);
    const r = store.upsert({ host: 'example.com', css: '  ', js: '\n', readerMode: false });
    assert.equal(r.ok, true);
    assert.equal(r.item, null);
    assert.equal(store.list().length, 0);
  });
});

test('#568 存储：校验（非法域名 / 超长）不落盘', () => {
  withStore((_file, store) => {
    assert.deepEqual(store.upsert({ host: 'not a host', css: 'a{}' }), { ok: false, error: 'HOST_INVALID' });
    assert.deepEqual(store.upsert({ host: 'example.com', css: 'x'.repeat(70 * 1024) }), { ok: false, error: 'CSS_TOO_LARGE' });
    assert.deepEqual(store.upsert({ host: 'example.com', js: 'x'.repeat(70 * 1024) }), { ok: false, error: 'JS_TOO_LARGE' });
    assert.equal(store.list().length, 0);
  });
});

test('#568 存储：损坏的 JSON 不抛（整表按空处理），下次保存可覆盖', () => {
  withStore((file, store) => {
    writeFileSync(file, '{ broken json', 'utf-8');
    assert.deepEqual(store.list(), []);
    store.upsert({ host: 'example.com', css: 'a{}' });
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown[];
    assert.equal(raw.length, 1, '损坏文件应被一次成功保存修复');
  });
});
