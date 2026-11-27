/**
 * `#574` 站点定制「HTML 源码 + CSS/JS 三栏」与设置页批量管理的接线锁。
 *
 * 用户 2026-10-23 原话：
 *  · 「增加 HTML 源码显示栏…目前 CSS，JS 等于盲写」⇒ 左栏必须是**当前页面原始 HTML**（只读）；
 *  · 「CSS，JS 编辑界面支持双击打开增强编辑器」⇒ 复用 `CodeField`，且**两个实例不能串台**
 *    （旧实现是固定 `id="cf-zoom-host"` + `getElementById`，一屏两个实例必抢同一个宿主）；
 *  · 「补设置页的批量管理列表」⇒ 设置页要有列表 + 编辑/删除入口，且复用同一个编辑器。
 *
 * 这里锁「结构接线」而不是渲染像素：`CodeField` 的交互已由 `#573` 的行为变更约束，
 * 纯逻辑（域名匹配/存储）在 core/server 的测试里。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('#574 站点定制弹窗：左 HTML 只读 + 中 CSS + 右 JS（CodeField）', () => {
  const DLG = read('src/components/SiteCustomizeDialog.vue');
  // 三栏网格（顺序 = HTML / CSS / JS）
  const cols = DLG.match(/<div class="sc-cols">([\s\S]*?)<\/div>\s*<\/div>/);
  assert.ok(cols, '必须有三栏容器 .sc-cols');
  const body = cols[1];
  assert.match(body, /<strong>HTML 源码<\/strong>[\s\S]*?<strong>CSS<\/strong>[\s\S]*?<strong>JS<\/strong>/, '三栏顺序必须是 HTML → CSS → JS');
  assert.match(DLG, /<pre[^>]*class="sc-src"[^>]*data-sc-src/, 'HTML 栏必须是只读 <pre>（不许可编辑）');
  assert.equal((DLG.match(/<CodeField/g) ?? []).length, 2, 'CSS / JS 各用一个 CodeField');
  assert.match(DLG, /import CodeField from '\.\.\/CodeField\.vue'/, '必须复用规则工坊的同一个编辑器组件');
  // 源码来源：父组件给了就用（阅读器手里已有原始 HTML），没给才走 /api/proxy 取原页
  assert.match(DLG, /import \{ fetchWebSource \} from '\.\.\/utils\/web-doc'/, '跨域页源码必须走唯一的取页出口');
  assert.match(DLG, /html\?: string/, '必须接收父组件传入的当前页原始 HTML');
  assert.match(DLG, /width: min\(1500px, 97vw\)/, '弹窗必须加宽（三栏并排）');
  // `#576` 动态取页：与规则工坊同一个端点（懒加载 / SPA 空壳的 DOM 只有它看得到）
  assert.match(DLG, /\/api\/doctor\/fetch-page/, '动态取页必须复用规则工坊的同一端点');
  assert.match(DLG, /data-sc-src-render/, '「重新取页」右边必须有「🖥 动态取页」');
});

test('#574 CodeField：放大宿主改为组件内 ref（多实例不串台）', () => {
  const CF = read('src/CodeField.vue');
  assert.doesNotMatch(CF, /document\.getElementById\('cf-zoom-host'\)/, '不许再用固定 id 取宿主（多实例会抢第一个）');
  assert.doesNotMatch(CF, /<div id="cf-zoom-host"/, '模板里不许再有固定 id（注释里的历史说明不算）');
  assert.match(CF, /const zoomHost = ref<HTMLElement \| null>\(null\)/, '宿主必须是组件内 ref');
  assert.match(CF, /<div ref="zoomHost" class="cf-zoom-host"><\/div>/, '模板宿主必须绑 ref');
});

test('#574 阅读器：把当前页原始 HTML 传给弹窗（不传补壳后的文档）', () => {
  const RO = read('src/components/ReaderOverlay.vue');
  assert.match(RO, /:html="customizeHtml"/, '弹窗必须收到当前页源码');
  assert.match(RO, /:source-id="r\.sourceId \?\? ''"/, '取页要带源身份（Referer/UA/Cookie）');
  assert.match(RO, /interface NavEntry \{[\s\S]*?raw: string;[\s\S]*?\}/, '导航栈要保存原始 HTML（与补壳文档同一次取页带回）');
  assert.match(RO, /const customizeHtml = computed\(\(\) =>\s*navIdx\.value > 0 \? String\(navStack\.value\[navIdx\.value\]\?\.raw/, '有页内导航时必须用当前页的 raw');
  assert.match(RO, /const page = await fetchWebPage\(url/, 'navGo 必须一次取回 raw + doc');
  // `#575`：网页即正文会话的同站链接走页内导航（不重开会话）
  assert.match(RO, /if \(!r\.webDoc && sameSite\(nav\.url, siteUrl\) && looksLikePageUrl\(nav\.url\)\)/, 'webDoc 会话的同站链接必须走 navGo，不能 readFirstDirect 重开会话');
});

test('#574 内置浏览器：内联页直接给源码，跨域页由弹窗自己取', () => {
  const IAB = read('src/components/InAppBrowser.vue');
  assert.match(IAB, /:html="inlineHtml \?\? ''"/, 'data: 内联页的源码必须直接传入');
  assert.match(IAB, /:source-id="props\.sourceId \?\? ''"/, '跨域页取源码要带源身份');
});

test('#574 设置页：站点定制批量管理列表（编辑/删除复用同一弹窗）', () => {
  const SV = read('src/views/SettingsView.vue');
  assert.match(SV, /\{ id: 'site', name: '站点定制' \}/, '设置页必须有「站点定制」分区');
  assert.match(SV, /import \{ listSiteCustomize, removeSiteCustomize, onSiteCustomizeChange \}/, '列表/删除必须走唯一 API 封装');
  assert.match(SV, /<table[^>]*class="kv-table"[^>]*data-site-table/, '必须有批量列表表格');
  assert.match(SV, /data-site-add/, '必须有「新增站点」入口');
  assert.match(SV, /:data-site-edit="c\.host"/, '每行必须有编辑入口');
  assert.match(SV, /:data-site-del="c\.host"/, '每行必须有删除入口');
  assert.match(SV, /<SiteCustomizeDialog[\s\S]*?:current="siteEdit\.current"/, '编辑必须复用同一个站点定制弹窗');
});
