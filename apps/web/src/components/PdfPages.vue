<script setup lang="ts">
/**
 * PDF 页渲染器（`#212` Step4）
 *
 * ## 它解决什么
 * 本仓的 PDF 通路是**前端渲染**（见 `core/local-book/pdf.ts` 顶部注释）：服务端只数页数、
 * 切章，并把整本 PDF 经 `/api/local-looks/file` 交给前端；真正把某页画出来要靠 `pdfjs-dist`。
 * 这个组件就是那个「画」的落点。
 *
 * ## 为什么单独一个组件（而不是塞进 ReaderOverlay 的漫画分支）
 * ① 漫画分支是 `<img src=…>`（浏览器自己解码）；PDF 页是 canvas 绘制 —— 两条通路
 *    **渲染机制完全不同**，硬塞会让那个分支同时长两种逻辑。
 * ② `pdfjs-dist` 是**懒加载**的（`import()`）：不打开 PDF 的用户不该为它付 1MB 的包体。
 *    单独组件让 `import()` 的边界清清楚楚。
 *
 * ## 与阅读器的接线
 * `ReaderOverlay` 见到某章 `paragraphs` 全是 `/api/local-looks/pdf-page?…` 前缀 ⇒ 走本组件，
 * 并把 `page` 参数解析出来传进来（`bookUrl` 用于取整本 PDF）。
 *
 * ## 2026-11-09 卡死修复（实测证据见回报）
 * 事故 PDF 的「分段_1」只有 1 页，但该页由 7 张 `7440×10524` 的 JPEG 拼成（约 78M 像素/张）。
 * pdf.js 在 Chromium 里会把 JPEG 按**原始像素**解码（`drawWidth = 图片字典宽度`），单张 RGBA
 * 约 313MB；实测该页 `getOperatorList` 24s、`render` 75s、浏览器进程峰值 **3.6GB**。
 * 旧实现还有两个放大器：
 *   · 打开一章就**串行渲染整章所有页**（分段_0 = 10 页一起排队）；
 *   · `<PdfPages>` 按章 `:key` 重挂，`onBeforeUnmount` 销毁 doc ⇒ 每换一章都重新下载/解析
 *     12MB PDF（实测 `getDocument` 11~18s）。
 * 现在的策略：doc 跨章复用、页面**进入视口才渲染**、canvas 像素预算封顶、单页渲染加
 * 看门狗（超时取消并给出「继续渲染」入口），避免一页巨图把整台机器拖死。
 *
 * ## 2026-11-10 补充：巨图在解码前拦截
 * 看门狗只能「事后取消」——pdf.js 在 `getOperatorList` 阶段就已按原始像素解码图片，
 * 取消时内存已经吃掉（这解释了为何 8GB 机器会整机停摆百秒）。
 * 因此 `getDocument` 增加 `maxImageSize = 36M px`：超过的嵌入图在解码前直接跳过，
 * 事故页（7×78M px）从「24s + 3.6GB」降到约 0.7s；白底页会显示「内容可能已跳过」提示。
 * 取消时还会 `destroy()` 文档 + worker，立刻归还已解码内存（下一页重新打开文档）。
 */

import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';

const props = defineProps<{
  /** 整本 PDF 的取数地址（`/api/local-looks/file?bookUrl=…`） */
  fileUrl: string;
  /** 本章要渲染的页码（0 基，升序） */
  pages: number[];
  /** 单页渲染宽度上限（px）；`0` = 跟随容器宽度 */
  maxWidth?: number;
}>();

const host = ref<HTMLElement | null>(null);
/** 每页的状态：待渲染 / 绘制中 / 完成 / 失败 / 超大图暂停（失败带原因，铁律 3） */
type PageState = {
  status: 'idle' | 'loading' | 'ok' | 'err' | 'heavy' | 'skipped';
  error?: string;
  /** 页宽高比（宽/高），用于渲染前占位，避免整章高度塌成 0 */
  ratio?: number;
};
const states = ref<PageState[]>([]);
/** 正在取页尺寸/打开文档（这段时间页面还没有占位高度） */
const preparing = ref(false);
/** 已绘制完成的 canvas（`shallowRef`：canvas 元素不需要深层响应式） */
const canvases = shallowRef<(HTMLCanvasElement | null)[]>([]);

/** 单页 canvas 像素预算（约 3M px ≈ 12MB RGBA），防止高分屏把整章画爆 */
const MAX_PAGE_PIXELS = 3_000_000;
/**
 * 单张嵌入图的最大像素数：超过它的图在 pdf.js **解码前**就被跳过（`maxImageSize`）。
 * 事故页由 7 张 `7440×10524`（≈78M px）JPEG 拼成，Chromium 会按原始像素解码，
 * 单张 RGBA ≈ 313MB、整页实测 3.6GB / 99s —— 8GB 机器会直接卡死（实测整机停摆 110s）。
 * 36M px 以内（≈600dpi A4 扫描 34.8M）仍正常渲染，只拦真正病态的超大拼图。
 */
const MAX_IMAGE_PIXELS = 36_000_000;
/** 单页渲染看门狗：超过该时长先取消，交给用户决定是否继续（巨图页实测 99s/3.6GB） */
const PAGE_RENDER_BUDGET_MS = 8000;

/**
 * pdf.js 文档句柄 —— **模块级缓存**。
 * 阅读器按章重挂 `<PdfPages>`，若跟着组件销毁 doc，每次跨章都要重新下载+解析整本 PDF
 * （事故文件实测 11~18s）。同一 `fileUrl` 复用一份 doc；换书时再销毁旧的。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let doc: any = null;
let loadedFileUrl = '';
let loadSeq = 0;

async function getPdfjs() {
  const [lib, workerSrc] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  const mod = lib as unknown as { GlobalWorkerOptions: { workerSrc: string }; getDocument: (o: unknown) => unknown; version: string };
  mod.GlobalWorkerOptions.workerSrc = (workerSrc as { default: string }).default;
  return mod;
}

/** 销毁文档句柄 + 其 worker（卡死页取消后调用，立刻归还几 GB 解码内存） */
async function resetDoc(): Promise<void> {
  const old = doc;
  doc = null;
  loadedFileUrl = '';
  if (old) {
    try {
      await old.destroy();
    } catch {
      /* 销毁失败无所谓 */
    }
  }
}

async function ensureDoc(): Promise<unknown> {
  if (doc && loadedFileUrl === props.fileUrl) return doc;
  const pdfjs = await getPdfjs();
  await resetDoc();
  doc = await (pdfjs as { getDocument: (o: unknown) => { promise: Promise<unknown> } }).getDocument({
    url: props.fileUrl,
    // 逐页请求（`range` 端点是 Fastify 静态文件，未开 range ⇒ 整本取；这里不启用 range 分块）
    disableAutoFetch: false,
    // 超大嵌入图在解码前直接跳过：这是「一页巨图拖死整机」的唯一预防手段
    maxImageSize: MAX_IMAGE_PIXELS,
  }).promise;
  loadedFileUrl = props.fileUrl;
  return doc;
}

/* ==================== 页面槽 / 视口懒渲染 ==================== */

/** 真实 DOM 槽（不能用响应式数组，否则每次重渲染都会把 canvas 丢掉） */
let slots: HTMLElement[] = [];
let io: IntersectionObserver | null = null;
/** 待渲染队列（按进入视口的先后，串行消费） */
const queue: number[] = [];
let pumping = false;

function setSlot(i: number, el: HTMLElement | null): void {
  if (el) slots[i] = el;
}

/** 找到阅读器真正的滚动容器（`.se-body` 等）；拿不到就退回视口 */
function scrollRoot(): HTMLElement | Element | null {
  let el = host.value?.parentElement ?? null;
  while (el && el !== document.body) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 8) return el;
    el = el.parentElement;
  }
  return null;
}

function disconnectIo(): void {
  io?.disconnect();
  io = null;
}

function observePages(): void {
  disconnectIo();
  if (typeof IntersectionObserver === 'undefined') {
    // 老浏览器：直接全排（仍然是串行渲染）
    queue.push(...states.value.map((_, i) => i));
    void pump();
    return;
  }
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        // 高度为 0 ⇒ 布局还没落位（隐藏的浮层 / 占位宽高比未生效）。此时「相交」是假象，
        // 一旦入队就会把整章排进渲染；等布局变化后 IO 会再回调一次。
        if ((e.target as HTMLElement).getBoundingClientRect().height <= 0) continue;
        const i = Number((e.target as HTMLElement).dataset['pi']);
        if (Number.isInteger(i)) enqueue(i);
      }
    },
    { root: scrollRoot(), rootMargin: '900px 0px' },
  );
  for (const el of slots) if (el) io.observe(el);
}

function enqueue(i: number): void {
  const st = states.value[i];
  if (!st || (st.status !== 'idle' && st.status !== 'heavy' && st.status !== 'err')) return;
  if (queue.includes(i)) return;
  queue.push(i);
  void pump();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const i = queue.shift()!;
      // eslint-disable-next-line no-await-in-loop
      await renderOne(i, false);
    }
  } finally {
    pumping = false;
  }
}

/* ==================== 单页渲染 ==================== */

function setState(i: number, patch: Partial<PageState>): void {
  states.value = states.value.map((s, k) => (k === i ? { ...s, ...patch } : s));
}

/**
 * 采样判断这一页是不是「白底无墨」。
 * `maxImageSize` 会在**解码前**丢掉超大图（防止 3.6GB 卡死），代价是这类页只剩白底 ——
 * 采样 24×24，如果完全没有非白像素就当成「超大扫描图已跳过」，给用户明确提示而不是一片白。
 */
function isBlankCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    const g = document.createElement('canvas');
    g.width = 24;
    g.height = 24;
    const x = g.getContext('2d', { willReadFrequently: true });
    if (!x) return false;
    x.drawImage(canvas, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    for (let k = 0; k < d.length; k += 4) {
      if (d[k + 3]! > 8 && (d[k]! < 245 || d[k + 1]! < 245 || d[k + 2]! < 245)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 画一页。
 * @param force 用户点「仍然渲染」时为 true：不加看门狗（巨图页可能要 100s+，由用户自己确认）
 */
async function renderOne(i: number, force: boolean): Promise<void> {
  const seq = loadSeq;
  const pageNo = props.pages[i]! + 1; // pdf.js 的页号是 1 基
  setState(i, { status: 'loading', error: undefined });
  let page: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdf = (await ensureDoc()) as any;
    page = await pdf.getPage(pageNo);
    if (seq !== loadSeq) return;
    const containerW = host.value?.clientWidth || 800;
    const cap = props.maxWidth && props.maxWidth > 0 ? props.maxWidth : containerW;
    const base = page.getViewport({ scale: 1 });
    // 渲染精度跟设备像素比走（否则高清屏上字发虚）
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let scale = (cap / base.width) * dpr;
    // 像素预算封顶：一页 canvas 不超过 4.2M 像素
    const wantPixels = base.width * base.height * scale * scale;
    if (wantPixels > MAX_PAGE_PIXELS) scale = Math.sqrt(MAX_PAGE_PIXELS / (base.width * base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.className = 'pdf-page-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 canvas 2d');
    const task = page.render({ canvasContext: ctx, viewport });
    let cancelled = false;
    const timer = force
      ? 0
      : window.setTimeout(() => {
          cancelled = true;
          try {
            task.cancel();
          } catch {
            /* 已结束则忽略 */
          }
        }, PAGE_RENDER_BUDGET_MS);
    try {
      await task.promise;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
    if (seq !== loadSeq) return;
    // 整页白底 ⇒ 该页的超大扫描图在解码前被 maxImageSize 跳过（否则会占数 GB）
    if (isBlankCanvas(canvas)) {
      setState(i, { status: 'skipped' });
      return;
    }
    canvases.value = canvases.value.map((c, k) => (k === i ? canvas : c));
    setState(i, { status: 'ok' });
  } catch (e) {
    if (seq !== loadSeq) return;
    // 看门狗取消 ⇒ 多半是超大图页（Chromium 下 pdf.js 按原始像素解码 JPEG）
    if ((e as { name?: string })?.name === 'RenderingCancelledException') {
      // 取消不会停掉 worker 里已开始的图片解码（可能已占数 GB）——销毁 doc/worker 立刻归还内存，
      // 下一页渲染时 ensureDoc 会重新打开文档（本地 12MB，实测 1~2s）。
      void resetDoc();
      setState(i, { status: 'heavy' });
      return;
    }
    const msg = String((e as Error)?.message ?? e);
    setState(i, { status: 'err', error: `第 ${pageNo} 页渲染失败：${msg}` });
  } finally {
    try {
      page?.cleanup?.();
    } catch {
      /* 忽略 */
    }
  }
}

/* ==================== 章切换 / 生命周期 ==================== */

async function prepare(): Promise<void> {
  const seq = ++loadSeq;
  disconnectIo();
  slots = [];
  queue.length = 0;
  preparing.value = true;
  const pages = props.pages;
  states.value = pages.map(() => ({ status: 'idle' as const }));
  canvases.value = pages.map(() => null);
  let d: unknown;
  try {
    d = await ensureDoc();
  } catch (e) {
    if (seq !== loadSeq) return;
    const msg = String((e as Error)?.message ?? e);
    states.value = pages.map(() => ({ status: 'err' as const, error: `打不开 PDF：${msg}` }));
    preparing.value = false;
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdf = d as any;
  // 先拿每页的原始尺寸做占位（只取 page dict，不渲染），避免整章高度塌成 0
  const ratios: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    try {
      const p = await pdf.getPage(pages[i]! + 1);
      const vp = p.getViewport({ scale: 1 });
      ratios.push(vp.width / vp.height);
      p.cleanup?.();
    } catch {
      ratios.push(842 / 595);
    }
    if (seq !== loadSeq) return;
  }
  states.value = states.value.map((s, i) => ({ ...s, ratio: ratios[i] }));
  preparing.value = false;
  // 等 DOM 槽落位后再观察
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  if (seq !== loadSeq) return;
  observePages();
}

watch(() => [props.fileUrl, props.pages.join(',')], () => void prepare(), { immediate: true, flush: 'post' });
/*
 * 注意：**不要**在 `onMounted` 里提前补一次 `observePages()`。
 * 实测（`tmp/probe-pdf-lazy.mjs`）：`prepare()` 要为每页取一次 `getViewport` 才有宽高比，
 * 在那之前 10 个 `.pdf-page` 高度都是 0、全部落在视口里 ⇒ IO 会把整章一次性入队，
 * 懒渲染直接失效（10 页全渲）。观察必须发生在 `ratio` 落位之后，`prepare()` 末尾已负责。 */

onBeforeUnmount(() => {
  loadSeq++;
  disconnectIo();
  slots = [];
  queue.length = 0;
  // doc 故意不销毁：模块级缓存供下一章复用（换书时 ensureDoc 会销毁旧的）
});

const anyErr = computed(() => states.value.find((s) => s.status === 'err')?.error ?? '');
</script>

<template>
  <div ref="host" class="pdf-pages">
    <div v-if="preparing" class="pdf-page-load"><span class="rd-spin"></span>正在打开 PDF…</div>
    <div
      v-for="(st, i) in states"
      :key="i"
      class="pdf-page"
      :class="st.status"
      :data-pi="i"
      :ref="(el) => setSlot(i, el as HTMLElement | null)"
      :style="st.status !== 'ok' && st.ratio ? { aspectRatio: String(st.ratio) } : undefined"
    >
      <!-- 每页一个槽：画好后把 canvas 挂进来（v-if + ref 的方式会丢 ctx，直接操作 DOM 槽） -->
      <div :ref="(el) => { const d = el as HTMLElement | null; if (d && canvases[i] && d.firstChild !== canvases[i]) { d.replaceChildren(canvases[i]!); } }" />
      <div v-if="st.status === 'loading'" class="pdf-page-load">
        <span class="rd-spin"></span>第 {{ pages[i]! + 1 }} 页渲染中…
      </div>
      <div v-else-if="st.status === 'heavy'" class="pdf-page-heavy">
        <p>第 {{ pages[i]! + 1 }} 页含超大扫描图，自动渲染已暂停以避免卡死。</p>
        <p class="pdf-page-heavy-sub">这类页面在浏览器里会按原始像素解码，实测可占数 GB 内存、耗时约 1~2 分钟。</p>
        <button type="button" class="pdf-page-heavy-btn" @click="renderOne(i, true)">仍然渲染这一页</button>
      </div>
      <div v-else-if="st.status === 'skipped'" class="pdf-page-heavy">
        <p>第 {{ pages[i]! + 1 }} 页没有可显示的内容。</p>
        <p class="pdf-page-heavy-sub">若原文是整页扫描图，其中的超大图片可能已被安全跳过：这类图在浏览器里按原始像素解码，实测单页峰值约 3.6GB、耗时 1~2 分钟，低内存机器会整机失去响应。</p>
      </div>
      <div v-else-if="st.status === 'err'" class="pdf-page-err">{{ st.error }}</div>
    </div>
    <p v-if="anyErr && states.every((s) => s.status !== 'ok')" class="pdf-hint">
      整个 PDF 都打不开 —— 文件可能不是有效的 PDF，或服务端上的原文件已丢失。
    </p>
  </div>
</template>

<style scoped>
.pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; }
.pdf-page { width: 100%; display: flex; flex-direction: column; align-items: center; background: #fff; }
.pdf-page.idle { background: transparent; }
.pdf-page.loading { min-height: 40vh; justify-content: center; background: transparent; }
.pdf-page-canvas { display: block; max-width: 100%; }
.pdf-page-load { display: flex; align-items: center; gap: 8px; opacity: 0.75; font-size: 13px; padding: 24px 0; }
/* PDF 纸张底色恒为白，提示文字固定用深灰，避免跟随阅读器主题变浅后看不清 */
.pdf-page-heavy { max-width: 560px; margin: auto 0; padding: 24px 16px; color: #444; text-align: center; font-size: 13px; line-height: 1.7; }
.pdf-page-heavy p { margin: 0 0 8px; }
.pdf-page-heavy-sub { color: #777; font-size: 12px; }
.pdf-page-heavy-btn {
  margin-top: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit;
}
.pdf-page-err { color: #c0392b; font-size: 13px; padding: 16px; text-align: center; }
.pdf-hint { opacity: 0.7; font-size: 12px; margin-top: 8px; }
</style>
