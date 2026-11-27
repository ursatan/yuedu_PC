/**
 * `#459` 壳层图片样式**两档**的行为锁。
 *
 * ## 用户原话（2026-10-14）
 * 「多个 RSS 源：图片显示宽图不是 CSS 设置的 100%，是接管滚动的原因么？如图，24 凹凸吧；
 *   凹凸吧，24MM 等。」
 *
 * ## 归因（两条合起来才成立，缺一即错）
 *  · `#212` 给壳里的 `img` 加了 `max-height:90vh`（为 epub 整页插图）；当时 iframe 是
 *    **按内容高度撑开**的，`vh` ≈ 内容全高 ⇒ 这条上限几乎永不生效；
 *  · `#432` 把 iframe 改成**定高自滚** ⇒ `vh` = 正文格可见高 ⇒ 上限真的生效，而替换元素
 *    在 `max-height` 绑定时**宽度按比例一起被压** ⇒ 竖长图只渲染出半宽。
 *  ⇒ 所以用户那句猜测（「是接管滚动的原因么」）是**对的**，但他看到的不是规则错、也不是 CSS 没写。
 *
 * 修法：按调用方分档（`capTallImages`），RSS 文章不带上限、书籍两侧不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// 走深路径（与 `ReaderOverlay` 同一条：壳不依赖 DOM，纯字符串进出）
import { buildHtmlDoc } from '../src/utils/html-shell';

const CAP = 'max-height:90vh';

test('#459 缺省仍是「不超一屏高」（#212 的 epub 语义不能被顺手改掉）', () => {
  const doc = buildHtmlDoc('<p>正文</p>');
  assert.ok(doc.includes(CAP), '缺省必须保留 90vh 上限');
  assert.ok(doc.includes('object-fit:contain'), '缺省的 contain 也要在（否则竖图会被拉变形）');
});

test('#459 传 capTallImages:false ⇒ 只放开高度上限，不额外提权 width', () => {
  const doc = buildHtmlDoc('<p>正文</p>', { capTallImages: false });
  assert.ok(!doc.includes(CAP), '图集类 RSS 文章不得再有高度上限');
  assert.ok(!doc.includes('object-fit:contain'), 'contain 是配合上限用的，一并去掉');
  // ★ 关键取舍：**不提权 `width:100%`** —— 站点常用 1×1 占位 gif，强拉 100% 会撑爆版面
  // 注意：`max-width:100%` 里也含 `width:100%` 子串 ⇒ 只看「声明开头」（`{` 或 `;` 之后）
  //
  // ⚠️ 断言必须**只看 `img` 规则**：`iframe{…width:100% !important…}` 是**故意**的
  //    （小部件 iframe 要铺满，见 `html-shell.ts` 的 IMG_CSS 旁注），笼统扫全文会把那条一并判失败。
  //    本条锁因此长期误红（与 `#459` 的 img 语义无关）—— 修锁只收窄判据，不改任何产品行为。
  const imgRules = [...doc.matchAll(/img\{([^}]*)\}/g)].map((m) => m[1]!);
  assert.ok(imgRules.length > 0, '必须存在 img 规则');
  assert.ok(!imgRules.some((r) => /(;|\{)width:100%/.test(r)), '不得把 img 宽度强拉到 100%');
  assert.ok(imgRules.some((r) => /max-width:100% !important/.test(r)), '仍要限「不超宽」（大图铺满正文格）');
});

test('#459 阅读浮层按会话类型分档：RSS 文章 false、书籍走缺省 true', () => {
  const src = readFileSync(join(process.cwd(), 'src/components/ReaderOverlay.vue'), 'utf8');
  assert.match(src, /capTallImages: !r\.rssArticle/, '唯一接线点：RSS 文章关上限、书籍保留');
});
