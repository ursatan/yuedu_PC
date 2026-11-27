/**
 * `#250` **背景作用域与透明度**的回归锁（纯函数层）。
 *
 * ## 为什么这三条要单测锁死
 * 这三点都是**「设了但看不出变化 / 变化在错的地方」**型的静默缺陷 —— 界面上不报错，
 * 探针也容易漏（要同时看「底色像素」「图片层 opacity」「栏位是否透图」三处才抓得到）。
 * 本文件把判据从「Vue 组件里的一坨 computed」提到**纯函数**，于是：
 * ① 改坏了这里一定红；② 顺带把「上游凭什么这么写」钉在注释里，避免后人凭印象改回去。
 *
 * ## 上游依据（三处都读源码确认过，不靠印象）
 * · `PageView.kt:329-336` `upBg()`：`vwRoot.background = LayerDrawable(bgMeanColor, ReadBookConfig.bg)`
 *   —— **两层**：第一层是均色（`bgMeanColor`，`:279` 由位图算出），第二层是当前背景 Drawable。
 * · `PageView.kt:342-344` `upBgAlpha()`：`ReadBookConfig.bg?.alpha = (bgAlpha / 100f * 255).toInt()`
 *   —— **只给第二层设 alpha**，第一层恒不透明。
 *   ⇒ **有背景图时：拖 `bgAlpha` 淡的是「图」，底色不动**（用户 2026-10-04 报的就是这个）。
 * · `view_book_page.xml`：`ll_header` / `ll_footer` **自身没有 `android:background`**
 *   ⇒ 它们恒透明、背景从 `vwRoot` 透上来；而工具栏在**另一个 Activity 层**，上游管不到。
 *   ⇒ 本仓 Web 把三者收进同一个浮层，才需要「标题栏 / 页眉 / 页脚」三个透明开关（本仓扩展）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyGlobalReaderPrefs, mergeReadStyle, type ReadStyle } from '@yuedu/core/contract';
import { bgColorOf } from '../src/styles/reader-theme';
import { resolveReaderBgUrl } from '../src/utils/reader-bg';

/** 一份最小可用的 ReadStyle（其余字段一律用契约默认值补齐） */
function styleOf(patch: Partial<ReadStyle> = {}): ReadStyle {
  return mergeReadStyle(emptyGlobalReaderPrefs(), patch);
}

/* ============ ① `bgAlpha` 不再混进底色（本次 bug 的根因） ============ */

test('#250 底色恒不透明：bgAlpha 不得影响 bgColorOf 的结果', () => {
  const day = 'day' as const;
  const full = styleOf({ bgStr: '#EEEEEE', bgAlpha: 100 });
  const half = styleOf({ bgStr: '#EEEEEE', bgAlpha: 50 });
  const zero = styleOf({ bgStr: '#EEEEEE', bgAlpha: 0 });
  // ★ 旧实现（`bgWithAlpha` 混色）会让这三个值不同 ⇒ 底色在淡 ⇒ 测试红。
  // ⚠️ 期望值全小写：`bgColorOf` 内部的 `cssHexColor` 会把色值归一成小写。
  assert.equal(bgColorOf(full, day), '#eeeeee');
  assert.equal(bgColorOf(half, day), '#eeeeee', 'bgAlpha=50 不得让底色变淡（上游那层恒不透明）');
  assert.equal(bgColorOf(zero, day), '#eeeeee', 'bgAlpha=0 也一样：alpha 归背景图层管');
});

test('#250 底色按颜色集取（白天/夜间/墨水屏各自独立）', () => {
  const s = styleOf({ bgStr: '#EEEEEE', bgStrNight: '#000000', bgStrEInk: '#FFFFFF' });
  assert.equal(bgColorOf(s, 'day'), '#eeeeee');
  assert.equal(bgColorOf(s, 'night'), '#000000');
  assert.equal(bgColorOf(s, 'eink'), '#ffffff');
});

/* ============ ② 背景图取值解析（有图 / 无图 / 三套槽） ============ */

test('#250 背景图：无值返回 null（调用方据此走「纯色」分支）', () => {
  assert.equal(resolveReaderBgUrl(null, 'http://x'), null);
  assert.equal(resolveReaderBgUrl('', 'http://x'), null, '空串等同无图（不能当 URL 解析）');
});

test('#250 背景图：内置图 id → origin 上的绝对 URL', () => {
  const url = resolveReaderBgUrl('护眼漫绿', 'http://localhost:5173');
  assert.ok(url, '内置图必须解析出 URL');
  assert.match(url, /^http:\/\/localhost:5173\//, '必须挂在 origin 下（Electron 跑 file:// 时相对路径会 404）');
  assert.match(url, /reader-bg/, '路径应落在 /reader-bg/ 下');
});

test('#250 背景图：http(s) 与 data URL 原样透传', () => {
  const http = 'https://example.com/a.jpg';
  assert.equal(resolveReaderBgUrl(http, 'http://x'), http);
  const data = 'data:image/png;base64,AAAA';
  assert.equal(resolveReaderBgUrl(data, 'http://x'), data);
});

/* ============ ③ 栏位透明开关的默认值（与上游「恒透明」同观感） ============ */

test('#250 栏位透明默认全开：老用户升级后背景图直接铺满整个界面', () => {
  const s = emptyGlobalReaderPrefs();
  assert.equal(s.toolbarTransparent, true, '标题栏默认透明（否则升级后标题栏变成一条色带）');
  assert.equal(s.headerTransparent, true, '页眉默认透明（上游 ll_header 无 background）');
  assert.equal(s.footerTransparent, true, '页脚默认透明（上游 ll_footer 无 background）');
});

test('#250 栏位不透明度默认 100：关掉透明时是「完全盖住」而不是「全透明」', () => {
  const s = emptyGlobalReaderPrefs();
  // ★ 反过来写会出事：默认 0 意味着「用户关掉透明 ⇒ 栏位彻底隐形」⇒ 按钮/文字凭空消失。
  assert.equal(s.toolbarAlpha, 100);
  assert.equal(s.headerAlpha, 100);
  assert.equal(s.footerAlpha, 100);
});

test('#250 三个栏位开关彼此独立（不能共用一个字段）', () => {
  const s = styleOf({ headerTransparent: false, headerAlpha: 40 });
  assert.equal(s.headerTransparent, false, '页眉应被单独关掉');
  assert.equal(s.headerAlpha, 40);
  assert.equal(s.footerTransparent, true, '关页眉不许连带关页脚');
  assert.equal(s.toolbarTransparent, true, '关页眉不许连带关标题栏');
});
