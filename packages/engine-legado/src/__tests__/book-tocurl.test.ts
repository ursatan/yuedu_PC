/**
 * 缺陷类AU 回归锁：**`book.tocUrl` 必须被回填**（2026-09-24 修，实测源 🔊书音M）。
 *
 * ## Legado 语义（权威）
 * `app/src/main/java/io/legado/app/model/webBook/BookInfo.kt:157-158`：
 * ```kotlin
 * book.tocUrl = analyzeRule.getString(infoRule.tocUrl, isUrl = true)
 * if (book.tocUrl.isEmpty()) book.tocUrl = baseUrl
 * ```
 * `book.tocUrl` 是 **Book 的标准字段**，目录/章节的 `@js` 规则可以读它。
 *
 * ## 我们此前的缺陷
 * 引擎只在「需要抓目录页」时**局部**算出 `tocUrlResolved`，从不写回 `env.bookData`
 * ⇒ 依赖它的源静默走错分支。实测（🔊书音M，音频源）：
 * ```js
 * var u=(typeof book!=='undefined'&&book&&book.tocUrl)?String(book.tocUrl):String(baseUrl||'');
 * var m=u.match(/id=(\d+)/); var wid=m?m[1]:'';        // ← book.tocUrl 缺失 ⇒ wid=''
 * …'act=wapseries&id='+wid+'&mod=movie&movieId={{$.id}}…'   // 章节 URL 变成 `id=`
 * ```
 * 站点回 `{"code":0,"data":[],"message":"参数错误"}` ⇒ 正文 0 段（用户看到的「未取到媒体地址」）。
 *
 * ## 两个必须锁住的点
 * 1. `book.tocUrl` 在**章节循环之前**就可用（chapterUrl 脚本要读它）；
 * 2. 回填的是「**实际使用的目录页 URL**」而不是规则原文 —— 当 `tocUrl` 是
 *    `https://…&id={{$.data.detail.id}}&…` 这种**模板**时，规则原文里的 `{{}}` 还没展开，
 *    拿它去 `match(/id=(\d+)/)` 一个数字都取不到（本修复第一版就踩了这个坑）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineContext, HttpResponse } from '@yuedu/core';
import { createMemoryKeyValueStore, createTraceSink, createVariableStore } from '@yuedu/core';

import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';

const BASE = 'https://m.shuyinfm.test';
/** 目录页的「真 URL」（模板 `{{$.data.detail.id}}` 展开后） */
const TOC_URL = `${BASE}/ecmsapi/index.php?mod=movie&act=movielist&id=116759&page=1&pagesize=5000`;

const BODIES: Record<string, string> = {
  // 详情页 = JSON（与书音M 同构：tocUrl 模板从 `$.data.detail.id` 取值）。
  // 注意也带一份 moielist —— 「未声明 tocUrl」的源要从**详情页**解析目录（Legado `tocUrl || bookUrl`）。
  [BASE]: JSON.stringify({
    code: 1,
    data: {
      detail: { id: '116759', title: '剑来' },
      moielist: [{ id: 9, title: '详情页里的章节' }],
    },
  }),
  [TOC_URL]: JSON.stringify({
    code: 1,
    data: { movid: 116759, count: 2, moielist: [{ id: 1, title: '第1集' }, { id: 2, title: '第2集' }] },
  }),
};

function makeCtx(): EngineContext {
  return {
    reqId: 'tocurl-test',
    sourceId: 'test',
    signal: new AbortController().signal,
    http: {
      async request(url: string): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: BODIES[url] ?? '{}', url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

function makeRule() {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '类AU 测试源',
    bookSourceType: 1, // 音频
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.item', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: {
      name: '$.data.detail.title',
      // ★ 模板形态：真 URL 只有在 fetchRuleUrl 内部展开后才知道
      tocUrl: `${BASE}/ecmsapi/index.php?mod=movie&act=movielist&id={{$.data.detail.id}}&page=1&pagesize=5000`,
    },
    ruleToc: {
      chapterList: '$.data.moielist[*]',
      chapterName: '$.title',
      // ★ 与书音M 同构：从 book.tocUrl 里正则取 id（注意 TS 字符串里 `\\d` 才是 JS 正则的 `\d`）
      chapterUrl:
        '@js:var u=String(book.tocUrl||"");var m=u.match(/id=(\\d+)/);var wid=m?m[1]:"";' +
        '"https://x.test/play?id="+wid+"&cid="+$.id',
    },
    ruleContent: { content: '$.data.SeriesUrl' },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

test('类AU：章节规则能读到 book.tocUrl，且回填的是**展开后的真 URL**', async () => {
  const det = (await new LegadoEngine().detail(
    makeRule(),
    { action: 'detail', id: JSON.stringify({ bookUrl: BASE, name: '剑来' }) },
    makeCtx(),
  )) as unknown as { chapters?: Array<{ payload?: { chapterUrl?: string } }> };

  const chapters = det.chapters ?? [];
  assert.equal(chapters.length, 2, `目录应有 2 章，实际 ${chapters.length}`);
  const first = chapters[0]?.payload?.chapterUrl ?? '';
  assert.match(
    first,
    /id=116759&cid=1/,
    `book.tocUrl 必须已回填且是展开后的真 URL（含 id=116759），实际 chapterUrl=${first}`,
  );
});

test('类AU：`ruleBookInfo.tocUrl` 为空时回落 baseUrl（Legado BookInfo.kt:158）', async () => {
  const out = compileBookSource({
    bookSourceUrl: BASE,
    bookSourceName: '类AU 回落测试',
    bookSourceType: 1,
    ruleBookInfo: { name: '$.data.detail.title' }, // 无 tocUrl
    ruleToc: {
      // 注意：没有 tocUrl 时目录直接从**详情页**解析（Legado `tocUrl || bookUrl`），
      // 所以 fixture 里详情页本身要带 moielist —— 否则 0 章，测不出回落。
      chapterList: '$.data.moielist[*]',
      chapterName: '$.title',
      chapterUrl: '@js:var u=String(book.tocUrl||"");"https://x.test/u?len="+u.length',
    },
    ruleContent: { content: '$.data.SeriesUrl' },
  });
  assert.ok(out.ok && out.rule, 'compile 失败');
  const det = (await new LegadoEngine().detail(
    out.rule!,
    { action: 'detail', id: JSON.stringify({ bookUrl: BASE, name: '剑来' }) },
    makeCtx(),
  )) as unknown as { chapters?: Array<{ payload?: { chapterUrl?: string } }> };
  // 回落值 = 详情页 URL，长度应与 BASE 一致（而不是 0 = 未回填）
  assert.equal(
    det.chapters?.[0]?.payload?.chapterUrl ?? '',
    `https://x.test/u?len=${BASE.length}`,
    '未声明 tocUrl 时应回落 baseUrl（Legado BookInfo.kt:158）',
  );
});
