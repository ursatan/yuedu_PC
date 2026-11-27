<script setup lang="ts">
/**
 * `#392` **应用内极简浏览器**（登录页 / 源作者的发布页·更新页 / 任意指定地址）。
 *
 * ## 为什么要有它（用户实测）
 * 「登录界面打开的网页，能否像 RSS 源打开『源仓库』的阅读页一样，可以是源规则生成的，
 *   也可以是指定地址的网页，…具备极简浏览器的功能，可前进，后退，刷新的？
 *   而不是跳转 Chrome？…外部浏览器的话书源更新页面，有书源导入按钮，也无法起作用了。」
 *
 * ## 判据（谁该走这里、谁该走本机真浏览器）
 * 由引擎给出（`UnifiedLoginResult.browserKind`，唯一来源 = core `selector/js.ts` 的 `BrowserOpenKind`）：
 *  · `show`   → **本组件**：`java.startBrowser(url,'密钥'|'更新'|'发布页')` 是 fire-and-forget
 *               「打开给人看」。页面里的 `legado://import/…` 链接要靠宿主接住 ⇒ 只有应用内才点得动。
 *  · `cookie` → **本机真浏览器**（服务端 Chromium + CDP 回传）：脚本在等浏览器里的结果
 *               （`startBrowserAwait` / 登录页）。跨域站点的 Cookie **取不回服务端**，
 *               内置 iframe 做不到 —— 这不是实现取舍，是浏览器安全模型。
 *               ⇒ 本组件保留「本机浏览器 ↗」出口，让这两种需求都能走通。
 *
 * ## 三条渲染路径（`#453` 起按可用性自上而下）
 *  ① **真浏览器 view**（桌面端 Electron ≥30，`window.yuedu.webviewOpen` 可用）：把 `WebContentsView`
 *     挂到本组件的占位元素上 —— 页内跳转/返回走 Chromium **原生**能力，cookie 按 partition 隔离。
 *     这就是「启动页 → 内容页 → 返回 + 各页脚本照常执行」那条诉求的落点。
 *  ② `data:text/html[;base64],…`（源作者内联的整页 HTML）⇒ 我们**自己解码**后交 `buildHtmlDoc`
 *     （无条件注入壳层导航桥 + 存储垫片）再 `srcdoc` 渲染 ⇒ 导入链接可点（见 `utils/data-url.ts`）。
 *  ③ `http(s)://…` ⇒ `src` 直连（cookie/存储按站点原生走，只加 sandbox 去掉 top 导航权）。
 * ②③ 是**回落**：拿不到真 view（web 端 / 老桌面端）时行为与 `#453` 之前**完全一致**。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { buildHtmlDoc } from '../utils/html-shell';
import { dataUrlHtml } from '../utils/data-url';
import { dispatchSchemeImport } from '../utils/scheme-import';
// `#453` 内嵌真浏览器出口（**不 import Electron API**，能力探测由它负责）
import {
  embeddedAvailable, embeddedAttach, embeddedDetach, embeddedInject, embeddedKeyOf, embeddedNav, embeddedOpen, embeddedStatus,
  onEmbeddedEvent, type WebviewBounds, type WebviewEvent,
} from '../utils/embedded-webview';
// `#568` P3 站点定制：iframe 通路走壳层注入；真 view 通路走 `webviewInject`
import { fetchSiteCustomize, onSiteCustomizeChange } from '../site-customize';
import { hostOfUrl, siteCustomizeHeadHtml, siteCustomizePayload, type SiteCustomize } from '@yuedu/core/site-customize';
import SiteCustomizeDialog from './SiteCustomizeDialog.vue';
/** `#583` 面板里的 `qmRun` RPC：脚本求值仍在**引擎侧**（源 jsLib 只有服务端有） */
import { evalSourceUi } from '../api';

const props = defineProps<{
  /** 初始地址（父组件用 `v-if` 控制挂载 ⇒ 挂载即打开） */
  url?: string;
  /** 标题（显示在工具条左侧） */
  title?: string;
  /** 源身份（`#453`）：真 view 按 `src:<id>` 会话键隔离 ⇒ 与源登录共用一个 partition */
  sourceId?: string;
  /**
   * `#583` **半宽面板**：源脚本 `showBrowser` 弹出的评论/段评面板（Legado 是半屏弹层）。
   * 默认宽度 920px 对这类内容太宽（用户 2026-10-23 复测）⇒ 传 `compact` 收一半。
   */
  compact?: boolean;
}>();

const emit = defineEmits<{ (e: 'close'): void; (e: 'open-external', url: string): void }>();

const stack = ref<string[]>([]);
const idx = ref(-1);
const input = ref('');
const err = ref('');
/** 重建 iframe 用（srcdoc 没有「重新加载」，换 key 是唯一可靠办法） */
const nonce = ref(0);
/** `#444` 本组件的 iframe —— 只认它的报文（`onMessage` 的来源过滤） */
const webFrame = ref<HTMLIFrameElement | null>(null);

/* ---------------- `#453` 真 view 模式 ---------------- */

/** 走真浏览器 view（拿不到就 false ⇒ 回落 iframe 通路） */
const useView = ref(false);
/** 真 view 的占位元素（bounds 从它量） */
const host = ref<HTMLDivElement | null>(null);
/** 真 view 的当前地址（iframe 模式下用本地栈，view 模式下用原生历史） */
const viewUrl = ref('');
const viewTitle = ref('');
/** view 的原生历史状态（前进/后退按钮的禁用判据） */
const vstate = ref<{ canGoBack: boolean; canGoForward: boolean }>({ canGoBack: false, canGoForward: false });
let offEvent: (() => void) | null = null;
let boundsObserver: ResizeObserver | null = null;

const cur = computed(() => (useView.value ? viewUrl.value : (stack.value[idx.value] ?? '')));
const shownTitle = computed(() => props.title || viewTitle.value || '');
/** `data:` 内联页 ⇒ 解码后的 HTML（null = 走 src 直连） */
const inlineHtml = computed(() => dataUrlHtml(cur.value));

/* ── `#568` 站点定制（按当前地址的域名） ──────────────────────────────
 * iframe 通路：注入 `extraHead`（与阅读器同一份 `siteCustomizeHeadHtml`）；
 * 真 view 通路：`navigated` 后调 `webviewInject`（见 `applyCustomizeToView`）。
 */
const siteCfg = ref<SiteCustomize | null>(null);
const siteDlgOpen = ref(false);
const siteHost = computed(() => hostOfUrl(cur.value));
let siteSeq = 0;
async function resolveSiteCfg(u: string): Promise<SiteCustomize | null> {
  const seq = ++siteSeq;
  const hit = u ? await fetchSiteCustomize(u) : null;
  if (seq === siteSeq) siteCfg.value = hit;
  return hit;
}
/** 真 view：注入当前地址命中的定制（无命中 ⇒ 什么都不做） */
async function applyCustomizeToView(u: string): Promise<void> {
  if (!useView.value || !u) return;
  const cfg = await resolveSiteCfg(u);
  if (!cfg) return;
  const p = siteCustomizePayload(cfg);
  if (!p.css && !p.js) return;
  await embeddedInject({ sourceId: props.sourceId, ...p });
}

const doc = computed(() =>
  inlineHtml.value == null
    ? ''
    : buildHtmlDoc(inlineHtml.value, { extraHead: siteCustomizeHeadHtml(siteCfg.value) }),
);
const src = computed(() => (inlineHtml.value != null ? '' : cur.value));
onBeforeUnmount(onSiteCustomizeChange(() => {
  if (useView.value) void applyCustomizeToView(viewUrl.value);
  else void resolveSiteCfg(cur.value);
}));

function syncBounds(): void {
  const el = host.value;
  if (!el || !useView.value) return;
  const r = el.getBoundingClientRect();
  const bounds: WebviewBounds = {
    x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
  };
  void embeddedAttach({ sourceId: props.sourceId, bounds });
}

/** 真浏览器里发出的页内事件（**只报不判**：主进程先拦下，判据在渲染进程） */
function onViewEvent(ev: WebviewEvent): void {
  if (ev.key !== embeddedKeyOf(props.sourceId)) return;
  const u = String(ev.url ?? '');
  if (ev.type === 'navigate' || ev.type === 'open') {
    // 深链（导入书源 / 换源）必须由宿主接住 —— 这正是「外部浏览器点了没用」的那件事（见文件头）
    if (/^(legado|yuedu):/i.test(u)) { dispatchSchemeImport(u); return; }
    // 真浏览器里就该像浏览器一样跳（`will-navigate` 已被主进程拦下 ⇒ 这里放行）
    if (/^https?:\/\//i.test(u)) void navTo(u);
    return;
  }
  if (ev.type === 'navigated' && u) {
    viewUrl.value = u;
    input.value = u;
    void refreshStatus();
    // `#568` 页面换了 ⇒ 按新地址重新解析站点定制再注入（旧文档已销毁，旧样式随之失效）
    void applyCustomizeToView(u);
  }
  if (ev.type === 'title' && ev.title) viewTitle.value = ev.title;
}

async function refreshStatus(): Promise<void> {
  if (!useView.value) return;
  const s = await embeddedStatus({ sourceId: props.sourceId });
  if (!s.ok || !s.exists) return;
  vstate.value = { canGoBack: !!s.canGoBack, canGoForward: !!s.canGoForward };
  if (s.url) {
    viewUrl.value = s.url;
    input.value = s.url;
  }
}

async function navTo(u: string): Promise<void> {
  const r = await embeddedNav({ sourceId: props.sourceId, url: u });
  if (r.ok) {
    viewUrl.value = r.url || u;
    input.value = viewUrl.value;
    vstate.value = { canGoBack: !!r.canGoBack, canGoForward: !!r.canGoForward };
    err.value = '';
    return;
  }
  if (r.error === 'NO_VIEW' || r.error === 'NOT_SUPPORTED') {
    // view 没了（被回收/老版本）⇒ 回落 iframe，并说清原因（不静默空转）
    useView.value = false;
    err.value = `内嵌真浏览器不可用（${r.error}），已回落到内置框架`;
    goTo(u);
    return;
  }
  err.value = `打开失败：${r.error}`;
}

/** 建立/复用真 view 并挂到占位元素上；拿不到就回落（**不静默**） */
async function openView(u: string): Promise<void> {
  const el = host.value;
  const rect = el ? el.getBoundingClientRect() : null;
  const bounds: WebviewBounds | undefined = rect
    ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    : undefined;
  const r = await embeddedOpen({ sourceId: props.sourceId, url: u, ...(bounds ? { bounds } : {}) });
  if (r.ok) {
    viewUrl.value = r.url || u;
    input.value = viewUrl.value;
    void refreshStatus();
    return;
  }
  useView.value = false;
  err.value = `内嵌真浏览器不可用（${r.error || '未知'}），已回落到内置框架`;
  goTo(u);
}

function startBoundsSync(): void {
  const onResize = (): void => syncBounds();
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    boundsObserver = new ResizeObserver(() => syncBounds());
    boundsObserver.observe(host.value);
  }
}

/* ---------------- iframe / srcdoc 通路（回落，行为不变） ---------------- */

function goTo(url: string, push = true): void {
  const u = String(url ?? '').trim();
  if (!u) return;
  if (useView.value && /^https?:\/\//i.test(u)) { void navTo(u); return; }
  const supported = /^https?:\/\//i.test(u) || dataUrlHtml(u) != null;
  if (!supported) {
    err.value = `这里只能打开 http(s) 网页或源内联的 data: 页面：${u.slice(0, 90)}` +
      (u.startsWith('legado:') || u.startsWith('yuedu:') ? '（导入链接请直接从页面里点）' : '');
    return;
  }
  err.value = '';
  if (push) {
    const keep = stack.value.slice(0, idx.value + 1);
    if (keep[keep.length - 1] !== u) keep.push(u);
    stack.value = keep;
    idx.value = keep.length - 1;
  }
  input.value = u;
  nonce.value++;
}

function back(): void {
  if (useView.value) { void embeddedNav({ sourceId: props.sourceId, action: 'back' }).then(refreshStatus); return; }
  if (idx.value > 0) {
    idx.value--;
    input.value = cur.value;
    nonce.value++;
  }
}
function forward(): void {
  if (useView.value) { void embeddedNav({ sourceId: props.sourceId, action: 'forward' }).then(refreshStatus); return; }
  if (idx.value < stack.value.length - 1) {
    idx.value++;
    input.value = cur.value;
    nonce.value++;
  }
}
function reload(): void {
  if (useView.value) { void embeddedNav({ sourceId: props.sourceId, action: 'reload' }).then(refreshStatus); return; }
  if (cur.value) nonce.value++;
}
function submitUrl(): void {
  goTo(input.value);
}

/**
 * 页内导航桥 / `legado://` 导入链接的**统一入口**（`#336`/`#343`）。
 * ⚠️ 不在这里自己判型/开对话框：唯一实现在 `ReaderOverlay.onLegadoUrl`，用
 * `dispatchSchemeImport` 投递（`desktop.ts` 走的是同一个派发器）。
 */
function onMessage(e: MessageEvent): void {
  /**
   * `#444` **按报文来源过滤**（与 `DiscoverView.onStartJavaMessage` / `ReaderOverlay.onHtmlFrameMessage`
   * 同一处缺陷类别）：三个宿主都把监听器挂在 `window` 上、都不看 `e.source` ⇒ 一次点击会被
   * 多个宿主同时处理（用户实测：阅读页渲染 json 的同时，这里又开了一份，页面白字白底）。
   */
  if (e.source !== webFrame.value?.contentWindow) return;
  const d = e.data as {
    yueduNav?: { url?: string; kind?: string };
    yueduSourceRun?: { code?: unknown; id?: unknown };
  } | null;
  /**
   * `#583` 源面板里的 `qmRun('<脚本片段>')`（Legado `showBrowser` 第三参 `run` 的等价物）。
   * 七猫评论面板靠它加载「更多评论 / 回复」——脚本只能在**引擎侧**（源 jsLib）跑，这里做转发。
   */
  const sr = d?.yueduSourceRun;
  if (sr && sr.code != null) {
    /**
     * ⚠️ **只接受「源内联面板」（data URL）的 RPC**：`InAppBrowser` 也会打开**真实站点**
     * （登录页 / 发布页）。若对 http 源也放行，任何被打开的站点都能 `postMessage` 一段 JS
     * ⇒ 在源引擎里执行（有 `java.*` / `source` / 网络）＝任意代码执行入口。
     * 判据与渲染分支同一份：`inlineHtml != null` ⇔ 当前是 srcdoc 面板。
     */
    if (inlineHtml.value == null) return;
    const id = Number(sr.id ?? 0) || 0;
    const reply = (value: string): void => {
      try {
        webFrame.value?.contentWindow?.postMessage({ yueduSourceRunResult: { id, value } }, '*');
      } catch {
        /* 已卸载：面板那边 Promise 会一直挂着，但不影响其它功能 */
      }
    };
    const sid = String(props.sourceId ?? '');
    if (!sid) {
      reply('');
      return;
    }
    evalSourceUi(sid, { code: String(sr.code) })
      .then((r) => reply(String(r.value ?? '')))
      .catch(() => reply(''));
    return;
  }
  const n = d?.yueduNav;
  const u = String(n?.url ?? '');
  if (!u) return;
  if (n?.kind === 'legado') {
    dispatchSchemeImport(u);
    return;
  }
  goTo(u);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(async () => {
  window.addEventListener('message', onMessage);
  window.addEventListener('keydown', onKey);
  const u = String(props.url ?? '');
  // `#568` iframe 通路：先把定制解析出来（`doc` computed 依赖它；真 view 走 navigated 事件）
  if (!(u && /^https?:\/\//i.test(u) && embeddedAvailable())) void resolveSiteCfg(u);
  // `#453`：桌面端有真 view 且地址是 http(s) ⇒ 走真浏览器（页内跳转/返回用 Chromium 原生能力）
  if (u && /^https?:\/\//i.test(u) && embeddedAvailable()) {
    useView.value = true;
    viewUrl.value = u;
    input.value = u;
    offEvent = onEmbeddedEvent(onViewEvent);
    await nextTick();
    await openView(u);
    if (useView.value) startBoundsSync();
    return;
  }
  goTo(u);
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  window.removeEventListener('keydown', onKey);
  offEvent?.();
  offEvent = null;
  boundsObserver?.disconnect();
  boundsObserver = null;
  // ⚠️ 只 **detach**（挂回后台、**不销毁**）：TTL 内重新打开还是同一个页面、同一份登录态
  if (useView.value) void embeddedDetach({ sourceId: props.sourceId });
});
// 同一会话内父组件换地址（如再点另一个按钮）
watch(
  () => props.url,
  (u) => {
    const v = String(u ?? '');
    if (!v || v === cur.value) return;
    goTo(v);
  },
);
// `#568` iframe 通路：地址一变就按新域名解析定制（真 view 由 `navigated` 事件驱动）
watch(cur, (u) => {
  if (!useView.value) void resolveSiteCfg(u);
});
</script>

<template>
  <div class="iab-mask">
    <div class="iab" :class="{ 'iab-compact': props.compact }">
      <div class="iab-bar">
        <span v-if="shownTitle" class="iab-title" :title="shownTitle">{{ shownTitle }}</span>
        <button class="iab-btn" :disabled="useView ? !vstate.canGoBack : idx <= 0" title="后退" @click="back">←</button>
        <button class="iab-btn" :disabled="useView ? !vstate.canGoForward : idx >= stack.length - 1" title="前进" @click="forward">→</button>
        <button class="iab-btn" :disabled="!cur" title="重新加载本页" @click="reload">⟳</button>
        <input
          v-model="input"
          class="iab-url"
          spellcheck="false"
          placeholder="http(s):// 或源内联的 data: 页面"
          @keydown.enter="submitUrl"
        />
        <button v-if="cur && siteHost" class="iab-btn" data-iab-site title="站点定制（CSS/JS · 阅读模式）" @click="siteDlgOpen = true">🎨</button>
        <button v-if="cur" class="iab-btn" title="用本机真浏览器打开（需要浏览器 Cookie 的源用这个）" @click="emit('open-external', cur)">
          本机 ↗
        </button>
        <button class="iab-btn" title="关闭（Esc）" @click="emit('close')">关闭</button>
      </div>
      <div v-if="err" class="iab-err">{{ err }}</div>
      <!-- `#568` 站点定制编辑器（与本组件同一页面地址） -->
      <SiteCustomizeDialog
        v-if="siteDlgOpen"
        :url="cur"
        :current="siteCfg"
        :title="shownTitle"
        :html="inlineHtml ?? ''"
        :source-id="props.sourceId ?? ''"
        @close="siteDlgOpen = false"
        @saved="siteCfg = $event"
      />
      <!-- `#453` 真浏览器 view：占位元素只提供位置与尺寸，真浏览器由主进程挂在这块区域上 -->
      <div v-if="useView" ref="host" class="iab-frame iab-host"></div>
      <!-- ⚠️ 两种 sandbox 是有意不同的（回落通路，行为与 #453 之前一致）：
           · srcdoc（**源作者可控的 HTML**）⇒ 不能给 allow-same-origin，否则它能读到本应用的
             DOM/localStorage（正文壳层同理，见 ReaderOverlay 的 `.rd-html-frame`）；
           · src（真实站点）⇒ 给 allow-same-origin 让 cookie/存储按站点原生走，
             但**不给** allow-top-navigation ⇒ 站点无法把整个应用导航走。
           ★ **也不给 allow-popups / allow-popups-to-escape-sandbox**（用户 2026-10-15 报障）：
             跨域 iframe 的 DOM 我们读不到 ⇒ 站点的 `<a target="_blank">` / `window.open`
             （如 ˃̶͈ ꇴ ˂̶͈ 发布页里的跳转）**只能由浏览器自己开**，`allow-popups-to-escape-sandbox`
             更把它放进用户的日常浏览器标签页 —— 与「Web 端所有浏览尽量留在 Web 内」直接冲突。
             ⚠️ 代价：这类链接**点了不再有任何反应**（浏览器静默拦下）—— 需要真浏览器请用「本机 ↗」。
             真正「页内跳转」需把抓取改写成同源壳层渲染（本仓 `html-shell` 的导航桥），
             那会牺牲站点的原生 JS/接口环境（GitHub 这类重 JS 站点），见 backlog。 -->
      <iframe
        v-else-if="src"
        ref="webFrame"
        :key="'src-' + nonce"
        class="iab-frame"
        :src="src"
        sandbox="allow-scripts allow-forms allow-downloads allow-modals allow-same-origin"
        referrerpolicy="no-referrer"
        title="内置浏览器"
      ></iframe>
      <iframe
        v-else-if="doc"
        ref="webFrame"
        :key="'doc-' + nonce"
        class="iab-frame"
        :srcdoc="doc"
        sandbox="allow-scripts allow-popups allow-forms allow-presentation"
        referrerpolicy="no-referrer"
        title="源内联页面"
      ></iframe>
      <div v-else class="iab-empty">（没有可显示的地址）</div>
      <div class="iab-tip">
        应用内浏览器：源作者的「更新 / 发布页 / 仓库」这类页面在这里打开 —— 页面里的
        <b>导入书源</b> 按钮点了就生效（外部浏览器点了没用）。<br />
        需要<b>浏览器 Cookie</b> 的登录（源用 `startBrowserAwait` / 登录页型）请点「本机 ↗」：
        跨域站点的 Cookie 取不回服务端，只能由本机真浏览器登录后自动回传。<br />
        <b>页内新窗口链接（`target="_blank"` / `window.open`）在本应用内不弹出</b> ——
        免得把您甩到浏览器标签页；需要真浏览器请点上面的「本机 ↗」。
        <template v-if="useView"><br />（当前由<b>内嵌真浏览器</b>渲染：页内跳转 / 返回走浏览器原生能力）</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.iab-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 70;
}
.iab {
  width: min(920px, 94vw); height: min(84vh, 760px); background: var(--bg);
  display: flex; flex-direction: column; overflow: hidden;
}
/* `#583` 源面板半宽（920 → 460；窄屏仍按 94vw 自适应） */
.iab.iab-compact { width: min(460px, 94vw); }
.iab-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.iab-title { flex: 0 0 auto; font-size: 12.5px; color: var(--muted); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iab-btn {
  flex: 0 0 auto; background: none; border: 1px solid var(--line); color: inherit;
  border-radius: 6px; padding: 3px 9px; font-size: 12.5px; cursor: pointer;
}
.iab-btn:disabled { opacity: 0.4; cursor: default; }
.iab-url {
  flex: 1 1 auto; min-width: 0; background: var(--bg-soft, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px;
  font-size: 12.5px; color: inherit;
}
.iab-err { padding: 8px 12px; color: #e06c75; font-size: 12.5px; }
.iab-frame { flex: 1 1 auto; width: 100%; border: 0; background: #fff; }
/* 真 view 的占位：透明即可 —— 真浏览器由主进程画在这块区域上 */
.iab-host { min-height: 0; background: transparent; }
.iab-empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; }
.iab-tip { flex: 0 0 auto; padding: 8px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; line-height: 1.6; }
</style>
