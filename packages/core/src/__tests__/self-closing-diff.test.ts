/**
 * `#188` 自闭合差值的回归锁：jsdom（HTML5）把 `<a/>` 的斜杠忽略 ⇒ 后续内容被吞进 `<a>`；
 * jsoup（上游解析器）尊重 `/>` ⇒ 空元素。`parseHtml` 必须归一到 jsoup 语义。
 *
 * 判别式断言：同一份 HTML，修前 `.chapter_content` 的直接文本节点只有 1 段（正文被吞），
 * 修后 3 段（正文回到容器里）——这正是 ⚡📂33文学「App 能匹配、我们正文空」的真因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHtml } from '../dom/index';

/** 取直接子文本节点（与 css.ts `@textNodes` 同一语义，上游 `AnalyzeByJSoup.kt:239-251`） */
function textNodesOf(html: string, sel: string): string[] {
  const { root } = parseHtml(html);
  const el = root.querySelector(sel);
  assert.ok(el, `应能选中 ${sel}`);
  const tn: string[] = [];
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) {
      const t = (n.textContent ?? '').trim();
      if (t) tn.push(t);
    }
  });
  return tn;
}

test('#188 `<a/>` 后的正文必须留在容器里（jsoup 语义；HTML5 会把它吞进 <a>）', () => {
  const html = `<div class="chapter_content">您现在阅读的是<a href="https://x">303文学<a/>www.x.com提供的《某书》(第1/2页)<br/><br/>&nbsp;&nbsp;&nbsp;&nbsp;正文第一段<br/><br/>&nbsp;&nbsp;&nbsp;&nbsp;正文第二段</div>`;
  const tn = textNodesOf(html, '.chapter_content');
  // 4 段 = 提示行 + `<a></a>` 结束到 `<br/>` 之间的声明 + 两段正文（与 App/jsoup 一致）
  assert.equal(tn.length, 4, `直接文本节点应有 4 段，实得 ${tn.length}：${JSON.stringify(tn)}`);
  assert.match(tn[2] ?? '', /正文第一段/);
  assert.match(tn[3] ?? '', /正文第二段/);
});

test('#188 void 元素的自闭合不动（`<br/>` 展开成 `<br></br>` 会多插一个换行）', () => {
  const html = `<div class="c">A<br/>B<img src="x"/>C<input type="text"/>D</div>`;
  const { root } = parseHtml(html);
  const el = root.querySelector('.c');
  assert.ok(el);
  assert.equal(el.querySelectorAll('br').length, 1, 'br 只许 1 个（</br> 会再插一个）');
  assert.equal(el.querySelectorAll('img').length, 1);
  assert.equal(el.querySelectorAll('input').length, 1);
  assert.match(el.textContent ?? '', /^ABC?D$/s);
});

test('#188 `<script>` 里的 `/>` 原样保留（JS 的除法/正则不是标记）', () => {
  const html = `<script>var re = /<a\\/>/; var x = 4/>2;</script><div class="c">正文<a/></div>`;
  const { root } = parseHtml(html);
  const script = root.querySelector('script');
  assert.ok(script);
  assert.match(script.textContent ?? '', /<a\\\/>/, '脚本内容必须原样');
  const el = root.querySelector('.c');
  assert.ok(el);
  // `<a/>` 展开为空元素 ⇒ 正文留在容器
  assert.match(el.textContent ?? '', /正文/);
  assert.equal(el.querySelectorAll('a').length, 1);
  assert.equal(el.querySelector('a')?.childNodes.length, 0, '展开后 a 是空元素');
});

test('#188 非自闭合的普通标签行为不变（防误伤回归）', () => {
  const html = `<div class="c"><a href="/x">链接</a><p>段落</p></div>`;
  const { root } = parseHtml(html);
  const el = root.querySelector('.c');
  assert.ok(el);
  assert.equal(el.querySelectorAll('a').length, 1);
  assert.equal(el.querySelectorAll('p').length, 1);
  assert.match(el.querySelector('a')?.textContent ?? '', /链接/);
});

test('#188 HTML 注释里的 `/>` 不动', () => {
  const html = `<!-- <div/> 注释示例 --><div class="c">内容</div>`;
  const { root } = parseHtml(html);
  assert.equal(root.querySelectorAll('div').length, 1, '注释里的标签不得成为真实节点');
});
