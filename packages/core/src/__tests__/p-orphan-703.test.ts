/**
 * `#703` 回归锁之二：**游离 `</p>` 的处置必须与 jsoup 一致**（多出来的空 `<p>` 会让
 * 后面所有 `p:nth-of-type(n)` 整体错位一格）。
 *
 * ## 缺陷（精华书阁手机版 V2 详情页，用户实测）
 * 站点把标题写成 `<p><a href="/15281/"><h2>剑来</h2></a></p>`：
 *  · `<h2>` 是块级元素，HTML5 规范**隐式关掉那个 `<p>`**；其后的 `</p>` 就成了「无主」的；
 *  · **parse5/jsdom**（规范）：无 p 在栈上就给一个 `</p>` **造一个空 `<p></p>`**；
 *  · **jsoup**（上游 Legado）：`InBody.endTagP` 在无 p 时 `return false` → 落到 `anyOtherEndTag`
 *    → 找不到匹配元素就**直接忽略**，不造节点。
 *
 * 后果：多出的空 `<p>` 让 `p:nth-of-type(n)` 全部后移一位。该源规则是
 * 作者 = `p:nth-of-type(2)`、分类 = `p:nth-of-type(3)`、最新 = `p:nth-of-type(6)`；
 * 修复前实测：作者 → **空**、分类 → `作者：烽火戏诸侯`、最新 → `更新：…`（每个都偏了正好一行）。
 *
 * ## 修法
 * `parseHtml` 之前把**无主的 `</p>`** 删掉（等价于 jsoup 的忽略）。只删 `</p>`、只删确定无主的那一个。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHtml, stripOrphanPEnd } from '../dom';
import { AnalyzeRule } from '../selector/analyze';
import { createVariableStore } from '../store';

function makeEnv(): never {
  return { jsEval: async () => '', variables: createVariableStore() } as never;
}

test('#703P① 块级元素关掉 p 之后的 `</p>` 被删（jsoup 语义）', () => {
  const input = '<div><p><a><h2>x</h2></a></p><p>y</p></div>';
  assert.equal(stripOrphanPEnd(input), '<div><p><a><h2>x</h2></a><p>y</p></div>');
});

test('#703P② 正常成对的 `</p>` 一个都不动', () => {
  const input = '<div><p>a</p><p>b</p></div>';
  assert.equal(stripOrphanPEnd(input), input);
});

test('#703P③ 重复的 `</p>`：只删无主的那一个', () => {
  assert.equal(stripOrphanPEnd('<div><p>a</p></p></div>'), '<div><p>a</p></div>');
  assert.equal(stripOrphanPEnd('<div></p>x</div>'), '<div>x</div>');
});

test('#703P④ `<div>` 已经隐式关掉 p ⇒ 其后的 `</p>` 视为无主', () => {
  assert.equal(stripOrphanPEnd('<p>a<div>b</div></p>'), '<p>a<div>b</div>');
});

test('#703P⑤ 脚本 / 样式 / 注释里的 `</p>` 是字符串，不动', () => {
  const js = '<script>var s="</p>";</script>';
  const cm = '<!-- </p> -->';
  assert.equal(stripOrphanPEnd(`${js}<div></p></div>`), `${js}<div></div>`);
  assert.equal(stripOrphanPEnd(`${cm}<div></p></div>`), `${cm}<div></div>`);
});

test('#703P⑥ 没有 `</p>` 的页面零改动（含 p 未闭合的常见写法）', () => {
  const input = '<div><p>a</div>';
  assert.equal(stripOrphanPEnd(input), input);
});

test('#703P⑦ 解析后 `p:nth-of-type(n)` 不再错位（真实站点结构）', async () => {
  /** 与精华书阁详情页同构：标题把 h2 塞进 p，后面紧一个 `</p>` */
  const html = `<div class="block_txt2">
  <p><a href="/1/"><h2>书名</h2></a></p>
  <p>作者：某作者</p>
  <p>分类：<a href="/list/2.html">修真小说</a></p>
  <p>状态：连载中</p>
  <p>更新：2026-10-27 06:11:01</p>
  <p>最新：<a href="/1/9.html">第84章</a></p>
</div>`;
  const box = parseHtml(html).document.querySelector('div.block_txt2')!;
  const ps = [...box.querySelectorAll('p')];
  assert.equal(ps.length, 6, `应为 6 个 p（多出来的那一个是 parse5 造的幽灵），实际 ${ps.length}`);
  assert.equal((ps[1]!.textContent ?? '').trim(), '作者：某作者', 'p2 必须是作者行');
  assert.equal((ps[5]!.textContent ?? '').trim(), '最新：第84章', 'p6 必须是最新章行');

  const ar = new AnalyzeRule(makeEnv()).setContent(html, 'https://x.test/1/');
  assert.equal(await ar.getString('@css:div.block_txt2 > p:nth-of-type(2)@text##^作者：'), '某作者');
  assert.equal(await ar.getString('@css:div.block_txt2 > p:nth-of-type(3)@text##^分类：'), '修真小说');
  assert.equal(await ar.getString('@css:div.block_txt2 > p:nth-of-type(6)@text##^最新：'), '第84章');
});

test('#703P⑧ 全文只差那几个字节：其余内容原样（不能顺手改坏别的）', () => {
  const kept = '<p class="a">保留</p><div class="x">正文</div><ul><li><p>列表里的 p</p></li></ul>';
  assert.equal(stripOrphanPEnd(kept), kept);
});
