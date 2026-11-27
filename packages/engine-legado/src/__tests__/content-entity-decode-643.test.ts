/**
 * 回归锁：**正文的「净化 + 实体解码」两步**（`#643`，对齐上游 `BookContent.kt:252-255`）。
 *
 * 上游原文：
 * ```kotlin
 * content = HtmlFormatter.formatKeepImg(content, rUrl)      // 内含 (&nbsp;)+ → ' ' + 删标签
 * if (content.indexOf('&') > -1) content = StringEscapeUtils.unescapeHtml4(content)
 * ```
 *
 * 我们这条链是自研的（要保留 `[图]` 占位与 `uiMarks` 按钮），但**两步都不能少**：
 *  · 缺 ① `(&nbsp;)+` → 空格：用实体做缩进的正文会把 160 个 `&nbsp;` 原样显示给用户；
 *  · 缺 ② `unescapeHtml4`：`&amp;` / `&ldquo;` / `&hellip;` 全部以字面量出现在阅读区。
 *
 * 实测（`#643` 笔趣阁·恋爱呀 `https___m.lianaiya.com_`）：修补前整章 2478 字含
 * **160 处字面 `&nbsp;`**；修补后 0。
 *
 * ⚠️ 顺序是有语义的，改这里前先读 `entityNormalized` / `decoded` 两处注释：
 * ① 必须在**删标签之前**（否则 `&nbsp;` 已被当普通文本处理，合并规则失效）；
 * ② 必须在**删标签之后**（否则 `&lt;div&gt;` 解出的 `<div>` 会被当标签删掉）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LegadoEngine } from '../engine';
import { compileBookSource } from '../model/book-source';
import type { EngineContext, HttpRequestOptions, HttpResponse } from '@yuedu/core';
import { createTraceSink, createVariableStore, createMemoryKeyValueStore } from '@yuedu/core';

const BASE = 'https://e643.test';

function makeSrc(content: string) {
  const out = compileBookSource({
    bookSourceUrl: `${BASE}/`,
    bookSourceName: '正文实体回归源',
    bookSourceType: 0,
    searchUrl: `${BASE}/s?q={{key}}`,
    ruleSearch: { bookList: '.i', name: 'a@text', bookUrl: 'a@href' },
    ruleBookInfo: { name: 'bookName' },
    ruleContent: { content },
  });
  assert.ok(out.ok && out.rule, `compile 失败：${JSON.stringify(out.issues)}`);
  return out.rule!;
}

function makeCtx(body: string): EngineContext {
  return {
    reqId: 'e643',
    sourceId: 'test643',
    signal: new AbortController().signal,
    http: {
      async request(url: string, _o?: HttpRequestOptions): Promise<HttpResponse> {
        return { status: 200, headers: { 'content-type': 'text/html' }, body, url };
      },
    },
    sandbox: { async eval() { return ''; } } as never,
    trace: createTraceSink(),
    variables: createVariableStore(),
    storage: createMemoryKeyValueStore(),
  };
}

async function paragraphsOf(html: string): Promise<string[]> {
  const rule = makeSrc(`@js: ${JSON.stringify(html)}`);
  const out = await new LegadoEngine().content(
    rule,
    { action: 'content', id: JSON.stringify({ chapterUrl: `${BASE}/c` }) },
    makeCtx(html),
  );
  return out.paragraphs;
}

test('#643 正文里的字面 &nbsp; 必须变成空格（上游 nbspRegex），不得显示给用户', async () => {
  const ps = await paragraphsOf('<div id="c">&nbsp;&nbsp;&nbsp;&nbsp;第一段正文</div>');
  assert.equal(ps.length, 1, `应 1 段，实际 ${ps.length}`);
  const joined = ps.join('\n');
  assert.ok(!joined.includes('&nbsp;'), `不得残留 &nbsp;：${JSON.stringify(joined)}`);
  assert.equal(joined, '第一段正文', '首部实体缩进应被吃掉（上游 trim 语义）');
});

test('#643 用 &nbsp; 做段内缩进的整章：实体清空且段落边界仍在', async () => {
  // 真实形态：段与段之间用 <br> 分隔，每段开头用 4 个 &nbsp; 缩进
  const html =
    '<div>&nbsp;&nbsp;&nbsp;&nbsp;维斯特洛，征服纪元299年。<br>' +
    '&nbsp;&nbsp;&nbsp;&nbsp;红色彗星在天际划出一道伤口。<br>' +
    '&nbsp;&nbsp;&nbsp;&nbsp;它的光芒愈发璀璨。</div>';
  const ps = await paragraphsOf(html);
  assert.equal(ps.length, 3, `应 3 段，实际 ${ps.length}：${JSON.stringify(ps)}`);
  assert.ok(ps.every((p) => !p.includes('&nbsp;')), `不得残留 &nbsp;：${JSON.stringify(ps)}`);
  assert.equal(ps[0], '维斯特洛，征服纪元299年。');
});

test('#643 其余命名实体也要解码（上游 unescapeHtml4），但不许把转义标签解成真标签', async () => {
  const ps = await paragraphsOf('<div>A&amp;B &ldquo;引号&rdquo; &hellip; &#8226; 圆点</div>');
  const joined = ps.join('\n');
  assert.equal(joined, 'A&B “引号” … • 圆点', `实体解码不对：${JSON.stringify(joined)}`);
});

test('#643 解码时机必须在删标签之后：&lt;div&gt; 只能变成文本，不能被当标签删掉', async () => {
  const ps = await paragraphsOf('<div>前面&lt;div&gt;后面</div>');
  const joined = ps.join('\n');
  assert.ok(joined.includes('前面'), `前半段丢失：${JSON.stringify(joined)}`);
  assert.ok(joined.includes('后面'), `后半段丢失：${JSON.stringify(joined)}`);
  // 关键断言：既不能残留 &lt;div&gt; 字面量，也不能因为解码出 <div> 而把「后面」连带当成标签内容删掉
  assert.equal(joined, '前面<div>后面', `实际：${JSON.stringify(joined)}`);
});

test('#643 无实体的普通正文零影响（不误伤 & 号与正常文本）', async () => {
  const ps = await paragraphsOf('<p>2024 &amp; 2025 年</p><p>纯文本一段</p>');
  assert.deepEqual(ps, ['2024 & 2025 年', '纯文本一段']);
});
