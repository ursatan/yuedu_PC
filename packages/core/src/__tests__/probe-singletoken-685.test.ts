/**
 * `#685` 查看器要分清「元素」与「取值」，两种用户实测形态：
 *
 * 1. **单 token**（`a` / `href` / `title` / `text`）是双义的：
 *    填在**取值位置**（chapterName / chapterUrl）时末段是**属性名/关键字**；
 *    填在**列表位置**（chapterList / bookList）时是元素选择器。
 *    旧实现一律走元素路径 ⇒ `href` 显示「0 命中」、`text` 显示一堆元素 HTML。
 * 2. **含 JS 段的规则**（`选择器 + 换行 + <js>…</js>`）必须按上游 `splitSourceRule` 分段求值，
 *    旧实现把整串当 CSS 选择器 ⇒ 「0 命中 · 选择器没匹配到元素」，
 *    而同一规则喂引擎 `getString` 明明能出值。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeSelector } from '../diag/probe';

const LI = '<li class="chapter"><a href="/142/1.html" title="第1章 开始">第1章 开始</a></li>';

const probe = async (selector: string, content = LI) => probeSelector({ selector, content, valueMode: true, sampleLimit: 5 });

test('Y-① 单 token `a`：元素路径回元素，但必须说明「取值位置会按属性名取」', async () => {
  const r = await probe('a');
  assert.equal(r.ok, true);
  assert.equal(r.hitCount, 1);
  assert.match(String(r.samples[0]), /^<a /, '列表位置：回元素');
  assert.match(String(r.note), /属性名/, '要提示双义，否则用户以为 `a` 与 `a@text` 等价');
  assert.match(String(r.note), /第1章 开始/, '要顺便把「按取值口径得到什么」写出来');
});

test('Y-② 单 token `href` / `title`：这是**属性规则**，不是 0 命中', async () => {
  const href = await probe('href');
  assert.equal(href.ok, true, 'chapterUrl: "href" 是语料里最常见的写法（241 处）');
  assert.deepEqual(href.samples, ['/142/1.html']);

  const title = await probe('title');
  assert.deepEqual(title.samples, ['第1章 开始']);
  assert.match(String(title.note), /属性名/);
});

test('Y-③ 单 token 关键字 `text`：取当前内容的文本，不是「含自有文本的元素」', async () => {
  const r = await probe('text');
  assert.equal(r.hitCount, 1);
  assert.deepEqual(r.samples, ['第1章 开始'], '旧实现会回一串元素 HTML');
});

test('Y-④ `选择器 + 换行 + <js>` 要走整条求值（用户实测 0 命中）', async () => {
  const r = await probe('a\n<js>result.length</js>');
  assert.equal(r.ok, true, '上游 splitSourceRule 是整串扫 <js>，前面的文本成为选择器段');
  assert.equal(r.hitCount, 1);
  assert.match(String(r.samples[0]), /^\d+$/, '应回脚本算出的数字');
  assert.match(String(r.note), /JS 段/);
});

test('Y-⑤ 用户那条 Nuxt 内嵌 JSON：`script[id="__NUXT_DATA__"]` + <js> 提取 m3u8', async () => {
  const page = '<script type="application/json" data-ssr="true" id="__NUXT_DATA__">'
    + '[["ShallowReactive",1],{"media":2},"https:\\u002F\\u002Fhls.example.cn\\u002Fv\\u002Fa.m3u8?auth_key=1-2-0-3&v=3"]'
    + '</script>';
  /** 注意：规则里的 `\\u002F` 在 JS 正则里等于「字面量 \u002F」；写成 `\u002F` 就变成 `/`，匹配不到页面文本 */
  const rule = 'script[id="__NUXT_DATA__"]\n<js>\n'
    + 'const matches = result.match(/https:(?:\\\\u002F|\\/){2}[^"]+?\\.m3u8(?:\\?[^"]*)?/g) || [];\n'
    + 'result = matches[0]?.replace(/\\\\u002F/g, "/") || "";\n'
    + 'result\n</js>';
  const r = await probe(rule, page);
  assert.equal(r.ok, true);
  assert.deepEqual(r.samples, ['https://hls.example.cn/v/a.m3u8?auth_key=1-2-0-3&v=3']);
});

test('Y-⑥ 纯选择器不受影响：`class.x@tag.a` 仍回元素（列表规则要的是卡片 HTML）', async () => {
  const r = await probe('class.chapter@tag.a');
  assert.match(String(r.samples[0]), /^<a /);
  assert.equal(r.note, undefined, '非单 token 不该加提示');
});
