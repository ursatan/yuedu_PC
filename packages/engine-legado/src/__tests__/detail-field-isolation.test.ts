/**
 * 详情字段的**逐字段隔离**（2026-09-21，缺陷类 U）。
 *
 * 背景（用户报告「详情静默空」）：🎨快看漫画的 `ruleBookInfo.wordCount` 里 `result.match(/__NUXT__…/[0])`
 * 返回 null → `[0]` 抛错 → **整条详情失败**；而书名/作者/简介/封面/最新章节本来都取到了。
 *
 * 参考实现的行为（Legado `model/webBook/BookInfo.kt:84-152`）：只把
 * **kind / wordCount / lastChapter / intro / coverUrl** 各自包在 try/catch 里；
 * `name` / `author` / `init` **不包** —— 字段内部报错只让该字段为空，不影响其它字段。
 *
 * 本文件锁两件事：
 *  ① 被 Legado 保护的字段出错时：详情仍成功，其它字段照常，且**留痕**（warnOnce）；
 *  ② **边界一致**：`name` / `author` 出错时详情仍应失败（不要把源规则写错掩盖成"字段为空"）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTraceSink,
  createVariableStore,
  createMemoryKeyValueStore,
  type EngineContext,
  type HttpClient,
  type JsSandboxPool,
} from '@yuedu/core';
import { LegadoEngine } from '../engine';

const noopSandbox: JsSandboxPool = {
  async eval() {
    throw new Error('sandbox 不可用（L1 引擎不用它）');
  },
};

function mockHttp(map: Record<string, string>): HttpClient {
  return {
    async request(url: string) {
      for (const key of Object.keys(map)) {
        if (url.includes(key)) return { status: 200, headers: {}, body: map[key]!, url };
      }
      throw new Error(`no mock for ${url}`);
    },
  };
}

function makeCtx(http: HttpClient): EngineContext {
  return {
    reqId: 't',
    sourceId: 'field-isolation',
    signal: new AbortController().signal,
    http,
    sandbox: noopSandbox,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

const engine = new LegadoEngine();
const compile = (raw: Record<string, unknown>) => {
  const r = engine.compile(raw);
  assert.ok(r.ok && r.rule, 'compile 应通过');
  return r.rule;
};
const detailReq = { action: 'detail', id: JSON.stringify({ bookUrl: 'https://t.test/book/1' }) } as never;

/** 详情页：书名/作者/标签/简介/封面/最新章节/目录齐全 */
const DETAIL_HTML = `<html><body>
  <h1>执子之剑</h1>
  <span class="author">鸠也</span>
  <span class="tags">热血,冒险</span>
  <p class="intro">简介文本</p>
  <img class="cover" src="/img/1.jpg">
  <span class="last">第12话</span>
  <ul id="list"><li><a href="/c/1">第1话</a></li><li><a href="/c/2">第2话</a></li></ul>
</body></html>`;

/** 会被 Legado 保护的字段（出错只让该字段为空） */
const GUARDED = ['kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl'] as const;

/** 一个"其它字段都正常、只有一个字段写坏"的源 */
function sourceWithBroken(field: string) {
  const base: Record<string, string> = {
    name: 'h1@text',
    author: '.author@text',
    kind: '.tags@text',
    intro: '.intro@text',
    coverUrl: '.cover@src',
    lastChapter: '.last@text',
    wordCount: '.wc@text',
  };
  // 写坏的形态与快看漫画一致：对 undefined 取属性 → 抛 TypeError
  base[field] = '@js:notExistValue.match(/x/)[0]';
  return {
    bookSourceUrl: 'https://t.test/',
    bookSourceName: '字段隔离',
    ruleBookInfo: base,
    ruleToc: { chapterList: '#list li', chapterName: 'a@text', chapterUrl: 'a@href' },
  };
}

test('① 被保护的字段（wordCount）出错 → 详情仍成功、其它字段照常、且留痕', async () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  };
  try {
    const http = mockHttp({ '/book/1': DETAIL_HTML });
    const r = await engine.detail(compile(sourceWithBroken('wordCount')), detailReq, makeCtx(http));
    assert.equal(r.title, '执子之剑', '书名应正常');
    assert.equal(r.subtitle, '鸠也', '作者应正常');
    assert.equal(r.summary, '简介文本', '简介应正常');
    assert.ok(String(r.cover).includes('1.jpg'), `封面应正常：${r.cover}`);
    assert.equal(r.meta?.['最新章节'], '第12话', '最新章节应正常');
    assert.equal(r.meta?.['字数'], undefined, '坏字段应留空，而不是让整条详情挂掉');
    assert.equal((r.chapters ?? []).length, 2, '目录也应照常解析');
    assert.ok(
      warns.some((w) => w.includes('wordCount') && w.includes('求值失败')),
      `应当留痕（warnOnce），实际 warns=${JSON.stringify(warns.slice(0, 3))}`,
    );
  } finally {
    console.warn = orig;
  }
});

test('① 其余 4 个被保护字段（kind/lastChapter/intro/coverUrl）逐个出错都不影响详情', async () => {
  for (const f of GUARDED.filter((x) => x !== 'wordCount')) {
    const http = mockHttp({ '/book/1': DETAIL_HTML });
    const r = await engine.detail(compile(sourceWithBroken(f)), detailReq, makeCtx(http));
    assert.equal(r.title, '执子之剑', `${f} 出错时书名仍应正常`);
    assert.equal(r.summary === '简介文本' || f === 'intro', true, `${f} 出错只影响自己`);
    assert.equal((r.chapters ?? []).length, 2, `${f} 出错时目录仍应正常`);
  }
});

test('② 边界一致：name / author 出错**不被隔离**（对齐 Legado）→ 详情应失败', async () => {
  for (const f of ['name', 'author'] as const) {
    const http = mockHttp({ '/book/1': DETAIL_HTML });
    await assert.rejects(
      () => engine.detail(compile(sourceWithBroken(f)), detailReq, makeCtx(http)),
      `${f} 出错时**不应**被静默成空值（Legado 也不包这两个字段）`,
    );
  }
});
