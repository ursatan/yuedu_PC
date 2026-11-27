/**
 * `#354` 「登录页选线路 → 返回刷新分类」前端接线的回归锁。
 *
 * ## 为什么值得锁
 * 后端（引擎 `login` + `hub.login` 源变量回写 + `exploreUrl` 用新线路）链路已由
 * `engine-legado/login.test.ts` ⑭ 与 `facade/hub.test.ts` 的 `#354` 条覆盖。
 * 前端这最后一环是**接线**：`SourceLoginDialog` 动作成功后 `emit('changed')`，
 * 宿主（`DiscoverView`）必须**重算分类**（`disc.reloadCategories`）。
 *
 * 风险：`@changed` 曾经只绑 `refreshLoginPlan`（仅刷新登录标记）—— 用户按提示
 * 「返回刷新分类」时看到的还是旧线路的分类，而**界面不报错**，静默失效。
 * 本锁把这个接线钉住，防止有人改回去或新加视图时漏接。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('#354 DiscoverView：登录对话框 @changed 必须触发「重算分类」（不能只刷登录标记）', () => {
  const src = read('src/views/DiscoverView.vue');

  // ① @changed 绑定到专用处理器（而不是裸 refreshLoginPlan）
  assert.match(
    src,
    /<SourceLoginDialog[\s\S]*?@changed="onLoginChanged"/,
    '登录对话框的 @changed 必须绑 onLoginChanged（只绑 refreshLoginPlan ⇒ 选完线路分类不变）',
  );

  // ② onLoginChanged 体内同时做两件事：刷登录标记 + 重算分类
  const fn = src.match(/async function onLoginChanged[\s\S]*?\n\}/);
  assert.ok(fn, 'onLoginChanged 必须存在');
  assert.match(fn![0], /refreshLoginPlan\(\)/, '仍要刷新登录标记（原行为）');
  assert.match(
    fn![0],
    /reloadCategories\(kind\.value\)/,
    '必须调 disc.reloadCategories(kind) 重跑 exploreUrl 脚本 —— 这是「返回刷新分类」的实现',
  );
});

test('#354 SourceLoginDialog：按钮动作成功不得显示成「✅ 登录成功」', () => {
  const src = read('src/components/SourceLoginDialog.vue');
  // 只改源变量的按钮动作（无 cookie / 无登录头 / 无登录信息 + 本次带 action）
  // ⇒ 用源作者 toast 原话，而不是「✅ 登录成功」
  assert.match(src, /onlySourceVars/, '需要有「只改源变量」的判据');
  assert.match(
    src,
    /onlySourceVars[\s\S]*?said\.at\(-1\)[\s\S]*?✅ 登录成功/,
    '只改源变量时优先用 toast 原话，否则才显示「✅ 登录成功」',
  );
});

/**
 * `#354`（排版）：loginUi 行必须渲染进**同一个 flex 容器、按源数组顺序**。
 *
 * 修前是「表单区 + `fields.filter(type==='button')` 独立按钮区」两段 ——
 * 按钮按 type 被抽出来集中平铺，源作者用 `layout_flexBasisPercent: 1` 标的**分隔标题**
 * （「点击切换分流」）被混进按钮堆里 ⇒ 用户报的「没按 loginUi 排列」。
 *
 * 这条锁按**结构**断言：模板里必须只有一个行容器，且遍历的是 `fields` 本身
 * （而不是 `fields.filter(...)`），并用 `rowStyle()` 落地每行的 basis。
 */
test('#354 SourceLoginDialog：行必须按 fields 原序渲染进单一 flex 容器', () => {
  const src = read('src/components/SourceLoginDialog.vue');

  // ① 存在单一行容器 `.lg-flex`，且遍历的是 fields（不是 filter 后的子集）
  assert.match(src, /class="lg-flex"/, '需要单一 flex 容器（对齐 Legado binding.flexbox）');
  assert.match(src, /v-for="f in fields"/, '必须按 fields 原序渲染（不能用 fields.filter 抽按钮单独排）');

  // ② 不允许再出现「按 type 过滤出按钮再集中渲染」的旧结构
  assert.doesNotMatch(
    src,
    /v-for="f in fields\.filter\(/,
    '禁止按 type 过滤分组渲染 —— 那会丢掉源作者的排版顺序（分隔标题得留在原位）',
  );

  // ③ button 行自己带 lg-cell + rowStyle（而不是被塞进 lg-actions 平铺容器）
  assert.match(src, /class="btn sm lg-cell lg-btn"/, 'button 行要参与同一 flex 容器');
  assert.match(src, /:style="rowStyle\(f\)"/, '每行都要落地自己的 flex basis');

  // ④ 旧的等宽平铺容器不应再渲染
  assert.doesNotMatch(src, /class="lg-actions"/, 'lg-actions 平铺容器应已移除');
});

/**
 * `#354`（浏览器区分，前端侧）：引擎判定「必须用真浏览器」⇒ `action:'browser'` 时，
 * 前端应**自动打开登录窗口**，而不是只弹一句提示让用户自己找按钮。
 *
 * 上游 Legado 是 `showBrowser(url)` 直接弹窗；本仓修前只 `lastUrl → toast`。
 * 另：`kind=url/config-url` 的自动开窗判据要**组件自足**（不能只靠宿主传 `autoWindow` ——
 * 源管理页没传，同一个源从两个入口打开会一个自动开、一个要手点）。
 */
test('#354 SourceLoginDialog：action=browser 应自动开登录窗口（并组件内自足判定）', () => {
  const src = read('src/components/SourceLoginDialog.vue');

  // ① browser 分支里要真的调 openWindow
  const branch = src.match(/if \(r\.action === 'browser' && r\.url\)[\s\S]*?\n    \}/);
  assert.ok(branch, 'browser 分支必须存在');
  assert.match(branch![0], /openWindow\(/, 'browser 分支必须自动打开登录窗口（不能只 toast）');

  // ② 自动开窗判据不依赖宿主 autoWindow（`?? true` = 未传时也开）
  assert.match(
    src,
    /props\.autoWindow \?\? true/,
    'autoWindow 未传时也应自动开窗（源管理页不传 ⇒ 修前那个入口要手点）',
  );
  // ③ 且有意**不**把静态 needBrowser 算进来（避免误伤 ui 源）
  assert.match(src, /pageOnly/, '自动开窗只认 kind=url/config-url（needBrowser 是提示位，会误伤）');
});
