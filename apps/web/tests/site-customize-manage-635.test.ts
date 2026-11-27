/**
 * `#635` 设置页「站点定制管理列表」的可验证判据。
 *
 * 用户要求：列表至少看到「站点名/源 id、启用状态、更新时间」；操作有
 * 编辑（复用现有弹窗）、启停、删除（二次确认）；空态/加载态/错误态都要有。
 *
 * 设计约束（本轮只改 `apps/web/**`）：服务端 `upsert()` 会重建条目、丢弃未知字段，
 * 所以「启用」只能存**本机 localStorage**，并由 `fetchSiteCustomize` 这个**唯一读出口**
 * 统一过滤。这里锁的就是这条链路，而不是渲染像素。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SITE_CUSTOMIZE_DISABLED_KEY,
  formatSiteUpdatedAt,
  isSiteCustomizeEnabled,
  readDisabledHosts,
  setSiteCustomizeEnabled,
  siteCustomizeSummary,
  siteSourceRefs,
} from '../src/utils/site-customize-manage';
import {
  fetchSiteCustomize,
  invalidateSiteCustomize,
  listSiteCustomize,
  removeSiteCustomize,
  setSiteCustomizeEnabled as toggleSiteCustomize,
} from '../src/site-customize';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

/** 测试内替换全局 localStorage（模块内是**懒读**的，替换后立即生效） */
function installStorage(): MemStorage {
  const s = new MemStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: s });
  return s;
}

test('#635 停用清单：归一化、去重、非法 JSON 不抛', () => {
  const s = installStorage();
  assert.deepEqual(readDisabledHosts(), []);

  s.setItem(SITE_CUSTOMIZE_DISABLED_KEY, 'not-json');
  assert.deepEqual(readDisabledHosts(), [], '非法 JSON 按空清单处理');

  s.setItem(SITE_CUSTOMIZE_DISABLED_KEY, JSON.stringify({ a: 1 }));
  assert.deepEqual(readDisabledHosts(), [], '非数组按空清单处理');

  s.setItem(
    SITE_CUSTOMIZE_DISABLED_KEY,
    JSON.stringify(['Example.COM', 'bad host', '*.x.com', 'example.com']),
  );
  assert.deepEqual(
    [...readDisabledHosts()].sort(),
    ['*.x.com', 'example.com'],
    '归一化 + 去重；非法域名直接丢弃',
  );
});

test('#635 启停：缺省启用，切换落盘并在同会话立即可读', () => {
  installStorage();
  assert.equal(isSiteCustomizeEnabled('a.com'), true, '没记录 = 启用');

  const list = setSiteCustomizeEnabled('https://www.Example.com/path', false);
  assert.deepEqual(list, ['www.example.com'], '输入整条 URL 也要归一化成域名');
  assert.equal(isSiteCustomizeEnabled('www.example.com'), false);

  setSiteCustomizeEnabled('www.example.com', true);
  assert.deepEqual(readDisabledHosts(), [], '再开启会从清单里移除');
});

test('#635 隐私模式：读属性就抛也不崩（按空清单 / 内存态继续工作）', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: localStorage is disabled');
    },
  });
  assert.deepEqual(readDisabledHosts(), [], '读失败按空清单处理');
  assert.doesNotThrow(() => setSiteCustomizeEnabled('x.com', false), '写失败不得抛出');
});

test('#635 源归属：复用 core 的域名命中判据（含子域 / 通配符）', () => {
  const sources = [
    { id: 's1', name: '示例源', url: 'https://www.example.com/book' },
    { id: 's2', name: '别的源', url: 'https://other.test/x' },
    { id: 's3', name: '无 URL 的老源' },
  ];
  assert.deepEqual(
    siteSourceRefs('example.com', sources),
    [{ id: 's1', name: '示例源' }],
    '裸域名命中自身及子域',
  );
  assert.deepEqual(
    siteSourceRefs('*.example.com', sources),
    [{ id: 's1', name: '示例源' }],
    '通配符只命中子域（www 是子域）',
  );
  assert.deepEqual(siteSourceRefs('other.test', sources), [{ id: 's2', name: '别的源' }]);
  assert.deepEqual(siteSourceRefs('nomatch.io', sources), [], '无命中时返回空（界面显示「未匹配到源」）');
});

test('#635 更新时间与内容摘要：脏值不显示 1970', () => {
  const ts = Date.UTC(2026, 10, 2, 3, 4); // 2026-11-02
  assert.match(formatSiteUpdatedAt(ts), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  for (const bad of [undefined, null, 0, -1, NaN, 'oops']) {
    assert.equal(formatSiteUpdatedAt(bad), '—', `脏值 ${String(bad)} 必须显示 —`);
  }
  assert.equal(
    siteCustomizeSummary({ host: 'x.com', css: 'abc', js: 'defg', readerMode: true }),
    'CSS 3 字符 · JS 4 字符 · 阅读模式 开',
  );
  assert.equal(siteCustomizeSummary({ host: 'y.com' }), '无 CSS · 无 JS');
});

test('#635 listSiteCustomize 失败必须抛错（空态与错误态可区分）', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await assert.rejects(() => listSiteCustomize(), /无法连接服务端/);
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    await assert.rejects(() => listSiteCustomize(), /site-customize 503/);
  } finally {
    globalThis.fetch = real;
  }
});

test('#635 fetchSiteCustomize 是唯一过滤点：停用 ⇒ 返回 null（等价于没配置）', async () => {
  installStorage();
  const real = globalThis.fetch;
  setSiteCustomizeEnabled('blocked.com', false);
  invalidateSiteCustomize();
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ match: { host: 'blocked.com', css: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    assert.equal(await fetchSiteCustomize('https://blocked.com/a'), null, '停用后不得注入');
    toggleSiteCustomize('blocked.com', true);
    invalidateSiteCustomize();
    assert.equal((await fetchSiteCustomize('https://blocked.com/a'))?.host, 'blocked.com');
  } finally {
    globalThis.fetch = real;
    setSiteCustomizeEnabled('blocked.com', true);
  }
});

test('#635 删除配置后清掉停用痕迹（重新新增不会「默认是关的」）', async () => {
  installStorage();
  const real = globalThis.fetch;
  setSiteCustomizeEnabled('gone.com', false);
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    assert.equal(await removeSiteCustomize('gone.com'), true);
    assert.deepEqual(readDisabledHosts(), []);
  } finally {
    globalThis.fetch = real;
  }
});

test('#635 设置页结构锁：源归属 / 启用开关 / 更新时间 / 三态 + 原有入口不变', () => {
  const SV = read('src/views/SettingsView.vue');
  // 原有 `#574` 锁定的入口必须原样保留（编辑复用同一个弹窗）
  assert.match(SV, /v-for="c in siteList"/);
  assert.match(SV, /:data-site-edit="c\.host"/);
  assert.match(SV, /:data-site-del="c\.host"/);
  assert.match(SV, /<SiteCustomizeDialog[\s\S]*?:current="siteEdit\.current"/);
  // 新增列 / 操作
  assert.match(SV, /data-site-source/, '每行必须有源归属列');
  assert.match(SV, /:data-site-enabled=/, '每行必须有启停状态');
  assert.match(SV, /data-site-updated/, '每行必须有更新时间');
  assert.match(SV, /data-site-loading/, '必须有加载态');
  assert.match(SV, /data-site-retry/, '错误态必须能重试');
  assert.match(SV, /siteSourceRefs/, '源归属必须复用纯函数，不另写一套域名比较');
  assert.match(SV, /formatSiteUpdatedAt/, '更新时间必须复用纯函数');
  assert.match(SV, /setSiteCustomizeEnabled/, '开关必须走统一接线层');
  // 删除仍走二次确认（现有约定）
  assert.match(SV, /window\.confirm\(`删除 \$\{c\.host\}/);
});
