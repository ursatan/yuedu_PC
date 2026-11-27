/**
 * 回归锁：**简介归一化 + HTML 实体解码**（2026-09-22，用户实测 ④⑤）。
 *
 * 用户看到的两类症状：
 *  · ④ 51漫画简介里留着一整段 `<div class="text-sm mb-4 comic-cate-intor">…</div>`（`@html` 的原文）；
 *  · ⑤ 多源简介的换行被吞（应有的多行效果没了）。
 *
 * 权威依据（Legado）：
 *  · `BookInfo.kt:123-133`：intro 以 `<usehtml>/<md>/<useweb>` 开头 → **原样保留**（交给 UI 渲染，
 *    如米读那张 HTML 卡片）；其余走 `HtmlFormatter.formatIntro`。
 *  · `HtmlFormatter.kt`：`nbsp+→空格`、`&ensp;/&emsp;→空格`、`&thinsp;/&zwnj;/&zwj;/U+2009…→删`、
 *    块级标签 `</?(div|p|br|hr|h\d|article|dd|dl)…>→"\n"`、注释删、其余标签删、
 *    `\s*\n+\s*→"\n"`、首尾裁剪。
 *  · 实体表：`StringEscapeUtils.UNESCAPE_HTML4` = BASIC + ISO8859_1 + HTML40_EXTENDED + NumericEntityUnescaper
 *    （数字实体**必须带分号**）。本仓的表由 `scripts/gen-html-entities.mjs` 从 Apache commons-text
 *    源码**程序化生成**（不手抄），落在 `html-entities.generated.ts`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatIntro, isRichIntro, normalizeIntro, unescapeHtml4 } from '../selector/html-format';

test('④ 块级标签还原为换行、其余标签剥离（51漫画 `.comic-cate-intor@html` 的形态）', () => {
  const html = '<div class="text-sm mb-4 comic-cate-intor"> 觉得同辈的男人很无趣？ <br>快来试试中年男子的魅力！ </div>';
  const out = formatIntro(html);
  assert.ok(!out.includes('<'), `不得残留标签，实际：${out}`);
  assert.ok(out.includes('\n'), `块级/br 应还原换行，实际：${JSON.stringify(out)}`);
  assert.ok(out.includes('觉得同辈的男人很无趣？'));
  assert.ok(out.includes('快来试试中年男子的魅力！'));
});

test('⑤ `<p>`/`<div>` 段落之间必须有换行（此前换行被吞的最常见形态）', () => {
  const out = formatIntro('<p>第一段</p><p>第二段</p>');
  assert.equal(out, '第一段\n第二段');
});

test('⑤ 多元素 getString 用 \\n 拼 + 空白归一（连续空行压成一个）', () => {
  const out = formatIntro('第一段<div><br></div><div>   </div><div>第二段</div>');
  assert.equal(out, '第一段\n第二段', `实际：${JSON.stringify(out)}`);
});

test('实体：命名实体全表（含 &lrm; / &emsp; / &thinsp; / &zwnj;）与数字实体（带分号）', () => {
  // —— 用户实测的 `&lrm;` 残留：旧实现只有 6 个实体（amp/lt/gt/quot/apos/nbsp）→ 原样留在简介里 ——
  // 现在走 HTML4 全表：`&lrm;` → U+200E（**不可见字符**）。
  // ⚠️ Legado 的 `formatIntro` 不删 U+200E（NO_PRINT 只含 thinsp/zwnj/zwj 与 U+2009/200C/200D），
  //    所以这里断言的是「字面 `&lrm;` 消失」而不是「字符消失」——与参考实现逐字一致，不自行"优化"。
  assert.equal(unescapeHtml4('a&lrm;b'), 'a\u200Eb');
  assert.ok(!unescapeHtml4('a&lrm;b').includes('&lrm;'), '字面实体必须消失');
  // 组合链路（引擎实际的路径：getString 先 unescape → 再 formatIntro）
  assert.equal(formatIntro(unescapeHtml4('<div>标题&lrm;</div><div>正文&nbsp;续</div>')), '标题\u200E\n正文\u00A0续');
  // `&nbsp;` 有**两条路径**，都要覆盖（Legado 的 `formatIntro` 只认字面实体串）：
  //  · 已解码（DOM 路径：jsoup `text()` 等价物）→ U+00A0，`NBSP_RE` 不再命中 —— 与 Legado 行为一致；
  //  · 字面 `&nbsp;`（JSON / `@js:` 字符串来源）→ 被 `NBSP_RE` 换成普通空格。
  assert.equal(formatIntro(unescapeHtml4('a&nbsp;b')), 'a\u00A0b');
  assert.equal(formatIntro('a&nbsp;b'), 'a b');
  assert.equal(formatIntro('a&emsp;b'), 'a b');
  // 命名实体：ISO8859_1 与 HTML40 扩展段（拉丁重音/希腊/箭头/数学）
  assert.equal(unescapeHtml4('&Aacute;&alpha;&rarr;&sum;'), 'Áα→∑');
  // 数字实体（十进制 + 十六进制）
  assert.equal(unescapeHtml4('&#233;&#x1F600;'), 'é😀');
  // 未带分号的数字实体**不**解码（对齐 NumericEntityUnescaper 默认：要求分号）
  assert.equal(unescapeHtml4('&#233'), '&#233');
  // 未知实体原样保留（不猜）
  assert.equal(unescapeHtml4('&notarealentity;'), '&notarealentity;');
});

test('富文本标记原样保留（② 米读的 useweb 卡片），普通简介才剥标签', () => {
  const webf = '<useweb>\n<style>.card{color:red}</style>\n<div class="card">书源声明</div>\n</useweb>';
  assert.equal(isRichIntro(webf), true);
  assert.equal(normalizeIntro(webf), webf, 'usehtml/md/useweb 必须逐字保留（由 UI 渲染）');
  // 前后空白不影响判定
  assert.equal(normalizeIntro('  <usehtml><b>x</b></usehtml>'), '<usehtml><b>x</b></usehtml>');
  // 普通简介走 formatIntro
  assert.equal(normalizeIntro('<div>纯文本简介</div>'), '纯文本简介');
});

test('`#435` `<style>`/`<script>` 的**内容**也必须删（上游只删标签 ⇒ 卡片会直接漏 CSS 源码）', () => {
  // 用户实测（「影视聚合(资源站)」的 ruleDescription 是整页 HTML）：
  // 「有非简介信息暴露：CSS？</p>标签？」—— 卡片上直接显示 `*{margin:0;padding:0;box-sizing:border-box;}`
  const html = '<style>*{margin:0;padding:0;box-sizing:border-box;}\nbody{background:#111;}</style><p>正文</p><script>var a=1;</script>';
  const out = formatIntro(html);
  assert.ok(!out.includes('box-sizing'), `CSS 内容不得残留，实际：${JSON.stringify(out)}`);
  assert.ok(!out.includes('var a=1'), '脚本内容不得残留');
  assert.equal(out, '正文');
});

test('`#435` 实测形态：整页 HTML 的简介 ⇒ 注释/style/script 全净，只留正文', () => {
  const html =
    '<!-- 关闭阅读新版的放大功能，固定顶部标题为文字而不是链接 -->' +
    '<head><script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>' +
    '<style>body{background:#111;color:#fff;padding:8px;}</style></head>' +
    '<body><p>这是一篇简介</p></body>';
  const out = formatIntro(html);
  assert.ok(!out.includes('关闭阅读新版'), 'HTML 注释不得残留');
  assert.ok(!out.includes('background'), 'CSS 内容不得残留');
  assert.ok(!out.includes('hls.min.js'), '脚本标签不得残留');
  assert.equal(out, '这是一篇简介');
});

test('空值与纯空白不炸、不臆造', () => {
  assert.equal(formatIntro(''), '');
  assert.equal(formatIntro('   \n  '), '');
  assert.equal(normalizeIntro(''), '');
  assert.equal(unescapeHtml4(''), '');
});
