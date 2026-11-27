import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import App from './App.vue';
import router from './router';
import './styles/theme.css';
import { useReplaceRulesStore } from './stores/replaceRules';
import { useDictStore } from './stores/dict';
import { useReaderStore } from './stores/reader';
import { useSyncStore } from './stores/sync';
import { resolveImageProxyOrigin } from './utils/image-origin';
// 自定义默认封面（`#793`）：IndexedDB → 对象地址，必须在首帧之前就绪（否则会先闪内置图再换图）
import { hydrateDefaultCoverImage } from './utils/default-cover';
// `#209` 桌面端（Electron 外壳）能力接线：托盘 / 全局快捷键 / 双击 txt·epub 打开
import { initDesktopBridge, isDesktop } from './desktop';

document.documentElement.classList.add('dark');
/* 桌面外壳右上角是 WCO 原生窗口按钮（最小化/最大化/关闭）——
   标记到 <html> 上，让右上角浮层（ToastHost）按 `--overlay-safe-top` 下移避让。 */
document.documentElement.classList.toggle('is-desktop-shell', isDesktop());

const pinia = createPinia();
const reader = useReaderStore(pinia);
const sync = useSyncStore(pinia);

/**
 * 把 pinia 实例挂到 `window.__pinia` —— **只给端到端探针用**（`scripts/probe-*.mjs`）。
 *
 * 为什么需要：`#203` 朗读要验状态机（暂停位置、逐句推进、语速换算），而**无头 Chromium
 * 没有任何 TTS 音色**（`getVoices()` 空）、真的发声在页面上也**没有任何可观察痕迹**。
 * 探针因此要注入一个替身引擎（`readAloud.__setEngine`），而 store 实例只有从这里才拿得到。
 *
 * ⚠️ 这是**调试口**，不是业务 API：它只暴露 store 容器，不新增任何能力，
 * 且生产构建里同样存在（要判断构建类型再剔除反而更绕）。若将来要移除，
 * 需同步改 `scripts/probe-203-read-aloud.mjs`。
 */
(window as unknown as { __pinia?: typeof pinia }).__pinia = pinia;

/**
 * Phase 1.4（`#66`）：启动时与**服务端**对齐用户数据（书架分组 / 书架 / 书签）。
 *
 * ⚠️ **必须在 `mount` 之前完成**（所以下面用 async IIFE 而不是「挂载后再后台对齐」）：
 * 策略里有一条「服务端非空 ⇒ 以服务端为准」，若界面先渲染，用户在最初几十毫秒里加的那本书
 * 会被随后到达的服务端数据**覆盖掉** —— 静默丢数据，且无法复现取证。
 *
 * 离线（服务端没起 —— 用户关掉 `start-server.bat` 是常态）时三个 `hydrateX()` **都不抛错**，
 * 保持 localStorage 里那份继续用；非离线错误（如 503 用户数据不可用）在这里**留痕但不阻断** ——
 * 对齐失败不该让整个应用白屏。
 *
 * 不用顶层 `await`：Vite 默认 `build.target = 'modules'`（es2020）**不支持 TLA**，会直接构建失败。
 */
void (async () => {
  const results = await Promise.allSettled([
    reader.hydrateGroups(),
    reader.hydrateShelf(),
    reader.hydrateBookmarks(),
    // `#146`：划线高亮/笔记（与书签同构 —— 同一个「mount 前完成」的约束）
    reader.hydrateHighlights(),
    // `#145`：阅读偏好（字号/主题/排版）也上服务端 —— 同一套策略、同一个「mount 前完成」的约束
    reader.hydratePrefs(),
    // `#144`：用户全局净化规则 —— 同一个「mount 前完成」的约束（否则阅读首章会先显示未净化的正文）
    useReplaceRulesStore(pinia).hydrate(),
    // `#189`：字典规则也上服务端（此前只存 localStorage ⇒ 不同 origin 各存各的）
    useDictStore(pinia).hydrate(),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.warn('[main] 用户数据对齐失败（保持本地缓存）：', r.reason);
  }
  /**
   * 阶段 1.5（`#143`）：把**离线指示与自动重传**挂上。
   * 放在对齐之后、挂载之前都不影响（它只订阅状态 + 起定时器），但必须**在挂载前**——
   * 否则首帧渲染时 `online` 还是初始值，界面上会闪一下「离线」。
   */
  sync.start();
  /**
   * `#702` **图片代理换 origin**（`127.0.0.1` ↔ `localhost`）：让一页几十张慢图去占
   * 另一个 origin 的 6 条连接，而不是把本页那 6 条吃满（吃满 ⇒ 心跳排队 ⇒ 误报「服务离线」）。
   * 内部自带自检（真加载一张 1×1 GIF），失败静默回落到同源，且**不抛错**。
   * 放在 mount 之前：首屏封面渲染时 `imgSrc()` 就已经拿到正确的 origin。
   */
  await resolveImageProxyOrigin();
  /**
   * 自定义默认封面：图在 IndexedDB 里，启动时还原成 `blob:` 地址。
   * 放在 mount 之前 —— 首屏封面渲染时 `customDefaultCoverUrl` 已经有值，
   * 不会出现「先画内置宣纸、下一帧换成自定义图」的闪动。
   * 内部吞错：读不到/图坏了 ⇒ 保持空串 ⇒ 全局回落内置默认封面。
   */
  await hydrateDefaultCoverImage();
  createApp(App).use(pinia).use(router).use(ElementPlus).mount('#app');
  /**
   * `#209` 桌面端能力接线（托盘/快捷键/双击打开）。**必须在挂载之后**：
   * 它要用 pinia（导入本地书要走 reader store）与 router（托盘菜单跳设置页）。
   * 浏览器里 `window.yuedu` 不存在 ⇒ 整个函数是 no-op。
   * ★ router **由这里注入**（而不是 desktop.ts 自己 import）—— 否则
   *   `router → MainLayout → desktop → router` 会构成循环依赖，dev 模式白屏。
   * ⚠️ 顺序也在它自己内部管着：先挂监听、再通知主进程「我准备好了」（`rendererReady`），
   *    否则主进程可能在监听还没挂上时就把「双击打开」的文件发出来。
   */
  initDesktopBridge({ navigate: (p) => { void router.push(p); } });
})();
