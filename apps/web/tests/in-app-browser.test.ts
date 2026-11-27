/**
 * `#392` 应用内极简浏览器（登录界面 / 书源更新页）的**结构锁**。
 *
 * ## 为什么用源码断言而不是挂载组件
 * web 包没有 jsdom / vue test-utils（既有约定，见 `discover-login-refresh.test.ts`）——
 * 这里要锁的是「**接线**」：`browserKind` 有没有真的分道、内置浏览器有没有真的接到
 * 「导入书源」派发器上。真正的行为锁在 core / engine（`browser-open-kind` 那几条）。
 *
 * ## 用户原话（本次需求）
 * 「登录界面打开的网页，能否…具备极简浏览器的功能，可前进，后退，刷新的？而不是跳转 Chrome？
 *   …如RSS源：˃̶͈ ꇴ ˂̶͈，登录界面「密钥」按钮，点击就无需跳转浏览器，「书源更新」按钮，
 *   也无需跳转浏览器，外部浏览器的话书源更新页面，有书源导入按钮，也无法起作用了，
 *   而RSS源，源仓库(官方纯净)，已经可以页面导入书源了。」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

const DIALOG = read('src/components/SourceLoginDialog.vue');
const IAB = read('src/components/InAppBrowser.vue');

test('#392 登录结果按 browserKind 分道：show ⇒ 应用内浏览器（不调 /login/window）', () => {
  assert.match(DIALOG, /r\.browserKind === 'show'/, '必须按引擎给的目的分道 —— 前端不许自己猜');
  // show 分支里必须是 openInApp（内置浏览器），而不是 openWindow（服务端 Chromium）
  const showBranch = DIALOG.slice(DIALOG.indexOf("r.browserKind === 'show'"));
  const body = showBranch.slice(0, showBranch.indexOf('return;'));
  assert.match(body, /openInApp\(r\.url\)/, 'show ⇒ 必须在**内置浏览器**里打开');
  assert.doesNotMatch(body, /openWindow\(/, 'show 分支不得再开服务端 Chromium 窗口（那正是用户要摆脱的跳转）');
  // 对偶：cookie 路径必须**保留**服务端 Chromium（跨域 Cookie 唯一出路）
  assert.match(DIALOG, /if \(!winOpen\.value && !winBusy\.value\) void openWindow\(r\.url\)/, 'cookie 路径必须保留真浏览器');
  assert.match(DIALOG, /browserKind\?: 'show' \| 'cookie'/, '本地 LoginResult 必须声明 browserKind（否则 TS 读不到）');
});

test('#392 登录对话框挂了内置浏览器，且给了「只读」入口与「本机 ↗」出口', () => {
  assert.match(DIALOG, /import InAppBrowser from '\.\/InAppBrowser\.vue'/);
  assert.match(DIALOG, /<InAppBrowser[\s\S]*?:url="iabUrl"[\s\S]*?@close="iabUrl = ''"[\s\S]*?@open-external="onOpenExternal"/);
  // 同一地址的两个入口：本机窗口（登录用）+ 内置浏览器（查看/导入用）
  assert.match(DIALOG, /内置浏览器打开/, '必须有内置浏览器入口（源作者的更新页/发布页要看这个）');
  assert.match(DIALOG, /function onOpenExternal\(url: string\)[\s\S]*?void openWindow\(url\)/, '「本机 ↗」必须能切到真浏览器');
});

test('#392 内置浏览器具备极简浏览器能力：前进/后退/刷新 + 地址栏', () => {
  assert.match(IAB, /title="后退"/);
  assert.match(IAB, /title="前进"/);
  assert.match(IAB, /title="重新加载本页"/);
  assert.match(IAB, /v-model="input"/, '地址栏必须可编辑（用户明确要「极简浏览器」）');
  assert.match(IAB, /title="用本机真浏览器打开/, '必须留出「本机 ↗」出口（需要 Cookie 的场景）');
});

test('#392 内置浏览器必须接住「导入书源」：data: 内联页走壳层 srcdoc + 派发器', () => {
  // ① 源作者内联页（`data:text/html;base64,…`，真语料 `update()`）⇒ 我们自己解码 + buildHtmlDoc
  assert.match(IAB, /dataUrlHtml\(\.\.\.|dataUrlHtml\(cur\.value\)/, 'data: 页面必须解码后走壳层，否则注入不了导航桥');
  assert.match(IAB, /buildHtmlDoc\(/, '必须过 buildHtmlDoc（它无条件注入导航桥 + 存储垫片）');
  assert.match(IAB, /:srcdoc="doc"/, 'data: 页面必须 srcdoc 渲染（直接给 iframe src 是 opaque origin，注入不了）');
  // ② 导入链接必须投到**唯一实现**（ReaderOverlay 注册的处理器），不许在本地重写判型
  assert.match(IAB, /dispatchSchemeImport\(/, '`legado://` 导入链接必须走统一派发器（#343）');
  assert.doesNotMatch(IAB, /new URL\(.*\)\.pathname/, '不许在本组件里重写判型/分发（同一判据写两处必然漂移）');
});

test('#392 两种 sandbox 有意不同：源内联 html **不给** allow-same-origin（可读本应用 DOM）', () => {
  // `#453`：src 那份 iframe 现在排在真 view 的占位之后（从 `v-if` 变成 `v-else-if`），故两形态都认
  const srcFrame = /v-(?:else-)?if="src"[\s\S]*?sandbox="([^"]+)"/.exec(IAB);
  const docFrame = /v-else-if="doc"[\s\S]*?sandbox="([^"]+)"/.exec(IAB);
  assert.ok(srcFrame, '必须能找到 src（真实站点）那份 iframe');
  assert.ok(docFrame, '必须能找到 srcdoc（源内联页）那份 iframe');
  assert.match(srcFrame![1]!, /allow-same-origin/, '真实站点要保留自身 origin（cookie/存储才正常）');
  assert.doesNotMatch(srcFrame![1]!, /allow-top-navigation/, '不得把整个应用交给站点导航走');
  assert.doesNotMatch(
    docFrame![1]!,
    /allow-same-origin/,
    '源作者可控的 HTML 绝不能拿到本应用同源权限（与阅读页壳层同规格）',
  );
  assert.match(docFrame![1]!, /allow-scripts/, '内联页自己的脚本（switchTab 等）要能跑');
});

/**
 * `#453`（D13 = A+B）**内嵌真浏览器**的接线锁（三端：出口工具 / 组件 / 两个调用点）。
 *
 * 锁的是「**有 view 走 view、没有就维持现状**」这条纪律真的被接线了：
 *  · 能力探测只在 `utils/embedded-webview.ts`（**不许**在组件里 import Electron API）；
 *  · 组件侧：真 view 的占位、页内事件订阅（深链必须接住）、卸载必须 detach；
 *  · 回落通路（src / srcdoc 两份 iframe）**原样保留** —— 这是「保留现有 web 实现」的判据；
 *  · 取页侧：`fetchWebDoc` 有会话先试真浏览器，失败回落 `/api/proxy`（不许把整页塞进 view）。
 */
test('#453 内嵌真浏览器：能力探测单一出口 + 组件占位/事件/detach + 回落通路原样', () => {
  const UTIL = read('src/utils/embedded-webview.ts');
  // ① 出口工具：不 import Electron API，能力探测只看 window.yuedu 上的方法
  assert.doesNotMatch(UTIL, /from 'electron'|require\('electron'\)/, '不许在渲染进程里 import Electron API');
  assert.match(UTIL, /typeof w\.webviewOpen === 'function'/, '能力判据 = preload 上那个方法在不在');
  assert.match(UTIL, /export function embeddedAvailable\(/, '必须给出唯一的能力探测');
  assert.match(UTIL, /onWebviewEvent\(cb\)/, '事件订阅必须收在这里');

  // ② 组件：占位 + 事件 + 卸载 detach（**不销毁**：TTL 内重开还是同一个页面与登录态）
  assert.match(IAB, /embeddedAvailable\(\)/, '走不走真 view 必须由能力探测决定（浏览器里恒 false）');
  assert.match(IAB, /v-if="useView"[\s\S]*?ref="host"/, '真 view 必须有占位元素（bounds 从它量出来）');
  assert.match(IAB, /getBoundingClientRect\(\)/, 'bounds 必须从占位元素实测（不许写死）');
  assert.match(IAB, /onEmbeddedEvent\(onViewEvent\)/, '必须订阅主进程上报的页内事件');
  assert.match(IAB, /dispatchSchemeImport\(u\)/, '真浏览器里的 legado: 深链也必须接住（否则「导入书源」在 view 里点不动）');
  assert.match(IAB, /embeddedDetach\(/, '卸载必须 detach（挂回后台、不销毁）');
  assert.match(IAB, /action: 'back'/, '后退/前进必须走浏览器原生历史（真 view 模式下）');
  // 回落通路必须原样保留（「保留现有 web 实现」）
  assert.match(IAB, /v-else-if="src"/, 'src 直连通路必须保留 = 回落');
  assert.match(IAB, /v-else-if="doc"/, 'srcdoc 通路必须保留 = 回落');

  // ③ 两个调用点都把源身份带上（真 view 按 src:<id> 隔离 ⇒ 与源登录共用同一 partition）
  assert.match(DIALOG, /<InAppBrowser[\s\S]*?:source-id="sourceId"/, '登录对话框的内置浏览器必须带 source-id');
  assert.match(read('src/views/DiscoverView.vue'), /<InAppBrowser[\s\S]*?:source-id="b\.sourceId"/, '启动页外链的内置浏览器必须带 source-id');

  // ④ 取页：有该源会话先试真浏览器（`/api/sessions/render`），失败回落既有 /api/proxy
  const WEBDOC = read('src/utils/web-doc.ts');
  assert.match(WEBDOC, /\/api\/sessions\/render/, '有会话的源优先用真浏览器取页（登录态/cookie/TLS 指纹）');
  assert.match(WEBDOC, /\/api\/proxy\?u=/, '回落通路必须原样保留');
  assert.match(WEBDOC, /if \(sid && origin\)/, '没有源身份 / 拿不到服务端 origin 时不试会话通路（直接走代理）');
});

/**
 * `#456` **内嵌浏览器的 cookie 回传（harvest 通道）**的接线锁。
 *
 * 锁的是「谁读、谁判、谁落盘」三层不串位：
 *  · 主进程只读它自己的 partition（`webviewCookies`）；
 *  · 渲染进程负责「读出来 + POST 给服务端」，**不重写任何域过滤判据**；
 *  · 服务端是唯一收口（`/api/sources/:id/login/cookies`，复用 `pickLoginCookies`）。
 */
test('#456 内嵌浏览器 cookie 回传：读 partition → 服务端唯一收口（不许重写域判据）', () => {
  const UTIL = read('src/utils/embedded-webview.ts');
  assert.match(UTIL, /webviewCookies\(o\)/, '必须只经 preload 的只读出口读 cookie');
  assert.match(UTIL, /\/api\/sources\/\$\{encodeURIComponent\(id\)\}\/login\/cookies/, '回传必须走服务端唯一收口端点');
  assert.match(UTIL, /export async function embeddedHarvest\(/, '回传逻辑必须收在这一个函数里');
  assert.doesNotMatch(UTIL, /hostMatches|endsWith\(`\.\$\{/, '域过滤不许在前端重写（服务端 pickLoginCookies 是唯一实现）');

  // 登录对话框：「应用内登录」入口 + 「完成并保存」先试内嵌通道、再回落服务端窗口
  assert.match(DIALOG, /import \{ embeddedAvailable, embeddedHarvest \}/, '对话框必须走唯一出口');
  assert.match(DIALOG, /const inAppAvail = computed\(\(\) => embeddedAvailable\(\)/, '入口只在桌面端（有真 view）出现');
  assert.match(DIALOG, /应用内登录（真浏览器）/, '必须有「应用内登录」入口（就地过验证码）');
  assert.match(DIALOG, /const emb = await embeddedHarvest\(props\.sourceId\)/, '「完成并保存」必须先试内嵌通道');
  assert.match(DIALOG, /\/api\/sources\/\$\{props\.sourceId\}\/login\/harvest/, '内嵌里没 cookie 时必须回落既有服务端 harvest');

  // 服务端：唯一收口端点 + 复用既有域过滤/合并
  const SRV = read('../../apps/server/src/index.ts');
  assert.match(SRV, /'\/api\/sources\/:id\/login\/cookies'/, '服务端必须有收口端点');
  assert.match(SRV, /const \{ picked \} = pickLoginCookies\(all, hosts\)/, '域过滤必须复用既有实现');
  assert.match(SRV, /hub\.mergeSourceCookies\(req\.params\.id, map\)/, '合并必须复用既有实现（cookie 存储唯一一份）');
});

/**
 * `#392` **实测挖出的真缺陷**：唤起导入的处理器与对话框原来住在 `ReaderOverlay` 里，
 * 而它的模板根节点是 `<div class="se-mask" v-if="r.open">` —— 阅读页**没打开**时整棵子树
 * 都不渲染 ⇒ 在**登录界面**的内置浏览器里点「导入书源」什么都不会发生
 * （`srcImportOpen` 置真了，但对话框的父级没渲染；连提示都没有）。
 * 只有「阅读页里点导入链接」这条路看着是好的 —— 用户原话「RSS源，源仓库(官方纯净)，
 * 已经可以页面导入书源了」正是**阅读页**场景。
 *
 * ⇒ 处理器与对话框必须住在**不受浮层门控**的常驻宿主里。这几条锁住那次搬迁。
 */
test('#392 唤起导入宿主必须**常驻且不受 r.open 门控**（否则非阅读页点导入链接毫无反应）', () => {
  const HOST = read('src/components/SchemeImportHost.vue');
  const LAYOUT = read('src/layouts/MainLayout.vue');
  const reader = DIALOG;
  void reader;

  // ① 宿主自己注册处理器（这是 message → 派发器 → 对话框 的接线点）
  assert.match(HOST, /setSchemeImportHandler\(/, '宿主必须注册统一派发器的处理器');
  assert.match(HOST, /<ImportSourcesDialog/, '书源/订阅源导入对话框必须住在宿主里');
  assert.match(HOST, /<ImportReplaceRulesDialog/, '净化规则导入对话框同理');

  // ② 宿主挂在常驻布局里（与 ReaderOverlay 平级，不在任何 v-if 门控内）
  assert.match(LAYOUT, /<SchemeImportHost\s*\/>/, '必须挂进 MainLayout（常驻）');
  const line = LAYOUT.split('\n').find((l) => l.includes('<SchemeImportHost'))!;
  assert.doesNotMatch(line, /v-if|v-show/, '宿主不得被门控 —— 这就是本次缺陷的根因');

  // ③ ReaderOverlay 交出宿主身份：只投递，不再自己注册/渲染导入对话框
  const overlay = read('src/components/ReaderOverlay.vue');
  assert.doesNotMatch(overlay, /setSchemeImportHandler\(/, '不得再在 ReaderOverlay 里注册（那会又回到受 r.open 门控的旧结构）');
  assert.doesNotMatch(overlay, /<ImportSourcesDialog/, '导入对话框不得再住在 ReaderOverlay 里');
  assert.match(overlay, /dispatchSchemeImport\(nav\.url\)/, '正文里的导入链接必须走统一派发器');
  // 对偶：根节点仍是 v-if="r.open"（正是「导入宿主不能住这儿」的原因，别顺手改成常驻）
  assert.match(overlay, /<div class="se-mask" v-if="r\.open"/, 'ReaderOverlay 根节点仍是阅读态门控（本次结论的前提）');
});
