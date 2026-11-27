<script setup lang="ts">
/**
 * `#568` **P3 站点定制编辑器**（per-site CSS / JS / 阅读模式）。
 * `#574` 三栏改造：**左只读 HTML 源码 · 中 CSS · 右 JS**，加宽 + CodeField 双击增强编辑。
 *
 * 入口：阅读器标题栏「🎨 定制」· 应用内浏览器工具条「🎨 定制」。
 * 配置落**本地独立文件**（`data/site-customize.json`，按域名）——用户 2026-10-22 拍板，
 * 不进书源定义（源要能干净导入导出、升级不覆盖定制）。
 *
 * ## 为什么要「HTML 源码」栏（用户 2026-10-23 原话）
 * 「不能看源码，目前 CSS，JS 等于盲写，或者还要切出去看源码。」
 * ⇒ 左栏显示**当前页面原始 HTML**（不显示我们壳层注入的脚本/样式，否则选择器判断被干扰）。
 *   · 阅读器把 `chapter.html` / 页内导航栈里的 `raw` 直接传进来；
 *   · 内置浏览器跨域页读不到 DOM ⇒ 传空，本组件用 `fetchWebSource` 走 `/api/proxy` 取一份原页。
 *
 * ## CSS / JS 用 CodeField
 * 与规则工坊源编辑区**同一个组件**：双击放大、放大态 Ctrl+F 搜索、补全、格式化。
 * ⚠️ 紧凑态**不绑搜索键**（`#573`）—— 一屏两个实例时 Ctrl+F 不会抢到下层。
 *
 * 交互纪律：只通过「关闭 / ESC」退出（与本仓浮层约定一致，点浮层外不关）。
 *
 * ⚠️ 示例按钮填的是**保守通用选择器**（`[class*=ad]` 这类）：真实站点 class 名千奇百怪，
 *    用户按站点微调即可；示例只用来「一眼看到生效」，不是万能规则。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { SiteCustomize } from '@yuedu/core/site-customize';
import { hostOfUrl } from '@yuedu/core/site-customize';
import { removeSiteCustomize, saveSiteCustomize } from '../site-customize';
import { fetchWebSource } from '../utils/web-doc';
import CodeField from '../CodeField.vue';

const props = defineProps<{
  /** 当前页面地址（决定默认域名） */
  url: string;
  /** 已命中的配置（可空） */
  current?: SiteCustomize | null;
  /** 标题（哪个页面在定制） */
  title?: string;
  /** `#574` 当前页面**原始 HTML**（阅读器手里已有；内置浏览器跨域页可为空） */
  html?: string;
  /** `#574` 取页用的源身份（`/api/proxy` 要带 sid 才带得上 Referer/UA/Cookie） */
  sourceId?: string;
}>();
const emit = defineEmits<{ close: []; saved: [SiteCustomize | null] }>();

const host = ref('');
const css = ref('');
const js = ref('');
const readerMode = ref(false);
const busy = ref(false);
const err = ref('');

/* ---------------- `#574` HTML 源码（只读） ---------------- */
const htmlView = ref('');
const htmlBusy = ref(false);
const htmlRendering = ref(false);
const htmlErr = ref('');
const htmlSize = computed(() => (htmlView.value ? `${htmlView.value.length} 字符` : ''));

/**
 * 取源码：优先用父组件给的（阅读器 = 当前章/当前导航页的原始 HTML），
 * 没有才自己取（内置浏览器的跨域页 / 设置页里按域名编辑）。
 */
async function loadSource(): Promise<void> {
  htmlErr.value = '';
  const given = String(props.html ?? '');
  if (given.trim()) {
    htmlView.value = given;
    return;
  }
  const u = String(props.url ?? '');
  if (!/^https?:\/\//i.test(u)) {
    htmlView.value = '';
    return;
  }
  htmlBusy.value = true;
  htmlView.value = '';
  try {
    htmlView.value = await fetchWebSource(u, String(props.sourceId ?? ''));
  } catch (e) {
    htmlErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    htmlBusy.value = false;
  }
}

watch(
  () => [props.url, props.current] as const,
  () => {
    const cfg = props.current ?? null;
    host.value = cfg?.host || hostOfUrl(props.url);
    css.value = cfg?.css ?? '';
    js.value = cfg?.js ?? '';
    readerMode.value = cfg?.readerMode === true;
    err.value = '';
  },
  { immediate: true },
);
watch(() => [props.url, props.html] as const, () => void loadSource(), { immediate: false });
onMounted(() => { void loadSource(); });

/**
 * `#576` **动态取页**（与规则工坊「试跑物料 → 🖥 动态取页」同一个出口）。
 *
 * 为什么放在这里：站点定制是**按页面 DOM 写选择器**，而静态取页拿到的是原始响应 ——
 * 懒加载列表 / `document.write` / SPA 空壳在源码里根本看不到目标节点，
 * 用户只能对着空壳写 CSS，注定不生效。走引擎同一份渲染器取「JS 执行后的 DOM」，
 * 才能看到真实结构。端点唯一：`POST /api/doctor/fetch-page`（见 `#556`）。
 */
async function loadRenderedSource(): Promise<void> {
  const u = String(props.url ?? '');
  if (!/^https?:\/\//i.test(u)) return;
  htmlRendering.value = true;
  htmlErr.value = '';
  try {
    const r = await fetch('/api/doctor/fetch-page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: u, ...(props.sourceId ? { sourceId: props.sourceId } : {}) }),
    });
    if (!r.ok) throw new Error(`动态取页失败 HTTP ${r.status}`);
    const j = (await r.json()) as { ok?: boolean; html?: string; error?: string };
    if (!j?.ok || !j.html) throw new Error(j?.error || '渲染层没有返回内容（这台机器没有可用 Chromium？）');
    htmlView.value = j.html;
  } catch (e) {
    htmlErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    htmlRendering.value = false;
  }
}

const canSave = computed(() => hostOfUrl(`https://${host.value.replace(/^\*\./, '')}`) !== '' && !busy.value);

/** 示例：去广告 / 暗色 / 正文排版。只填 CSS，不动用户已写的 JS。 */
const PRESETS: Array<{ label: string; css: string }> = [
  {
    label: '去广告',
    css: `/* 通用去广告（示例）：按 class/id 关键词隐藏常见广告位 */\n` +
      `[class*="ad-"], [class*="ads"], [id*="ad-"], [id*="ads"],\n` +
      `[class*="banner"], [class*="popup"], [class*="float-ad"] {\n  display: none !important;\n}`,
  },
  {
    label: '暗色',
    css: `/* 通用暗色（示例）：整页反色偏柔，图片保持原样 */\n` +
      `html, body { background: #17191c !important; color: #d7dbe0 !important; }\n` +
      `article, main, .content { background: transparent !important; color: inherit !important; }\n` +
      `a { color: #7fb2ff !important; }\n` +
      `img, video { opacity: .92; }`,
  },
  {
    label: '正文排版',
    css: `/* 阅读排版（示例）：限制行宽、放大字号、行高舒适 */\n` +
      `article, main, .content, .post-content {\n  max-width: 42em !important; margin: 0 auto !important;\n  font-size: 18px !important; line-height: 1.85 !important;\n}\n` +
      `article img, main img { max-width: 100% !important; height: auto !important; }`,
  },
];

function applyPreset(i: number): void {
  const p = PRESETS[i];
  if (!p) return;
  css.value = css.value.trim() ? `${css.value}\n\n${p.css}` : p.css;
}

async function onSave(): Promise<void> {
  if (!canSave.value) {
    err.value = '域名格式不对：只填域名（如 example.com）或通配符（*.example.com）';
    return;
  }
  busy.value = true;
  err.value = '';
  try {
    const item = await saveSiteCustomize({
      host: host.value,
      css: css.value,
      js: js.value,
      readerMode: readerMode.value,
    });
    emit('saved', item);
    emit('close');
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function onReset(): Promise<void> {
  if (!host.value) return;
  busy.value = true;
  try {
    await removeSiteCustomize(host.value);
    emit('saved', null);
    emit('close');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="sc-mask" @keydown.esc="emit('close')">
    <div class="sc-dlg" role="dialog" aria-modal="true" data-site-customize-dlg>
      <div class="sc-head">
        <strong>🎨 站点定制</strong>
        <span class="sc-sub" :title="url">{{ title || url }}</span>
        <span class="sc-host">
          域名
          <input v-model="host" class="sc-input" data-sc-host spellcheck="false" placeholder="example.com 或 *.example.com" />
        </span>
        <span style="flex: 1"></span>
        <button class="btn mini" data-sc-close @click="emit('close')">关闭</button>
      </div>
      <p class="sc-hint sc-hint-bar">裸域名同时作用于其子域；`*.example.com` 只作用于子域。配置只存本地。CSS/JS 编辑区双击放大（放大后 Ctrl+F 搜索）。</p>

      <div class="sc-body">
        <div class="sc-cols">
          <!-- ① 左：当前页面原始 HTML（只读） -->
          <section class="sc-col">
            <div class="sc-col-head">
              <strong>HTML 源码</strong>
              <span class="sc-dim">{{ htmlBusy ? '取页中…' : htmlRendering ? '渲染中…' : htmlSize }}</span>
              <span style="flex: 1"></span>
              <button class="btn mini" :disabled="htmlBusy || htmlRendering" data-sc-src-reload @click="loadSource()">↻ 重新取页</button>
              <!-- `#576` 与规则工坊同一个端点：懒加载 / SPA 空壳要看渲染后的 DOM -->
              <button
                class="btn mini" :disabled="htmlBusy || htmlRendering" data-sc-src-render
                title="走引擎同一条渲染通路取 JS 执行后的 DOM（懒加载 / document.write / SPA 空壳都靠它）；慢，秒级~十秒级"
                @click="loadRenderedSource()"
              >{{ htmlRendering ? '渲染中…' : '🖥 动态取页' }}</button>
            </div>
            <div v-if="htmlErr" class="sc-err" data-sc-src-err>{{ htmlErr }}</div>
            <pre v-else-if="htmlView" class="sc-src" data-sc-src>{{ htmlView }}</pre>
            <div v-else class="sc-empty">{{ htmlBusy ? '正在取当前页面源码…' : '没有可显示的源码（本地书 / 纯文本正文没有网页源码）' }}</div>
          </section>

          <!-- ② 中：CSS -->
          <section class="sc-col">
            <div class="sc-col-head">
              <strong>CSS</strong>
              <span class="sc-dim">注入到该站页面</span>
            </div>
            <div class="sc-presets">
              <span class="sc-dim">示例</span>
              <button v-for="(p, i) in PRESETS" :key="p.label" class="btn mini" :data-sc-preset="p.label" @click="applyPreset(i)">{{ p.label }}</button>
            </div>
            <div class="sc-editor">
              <CodeField
                v-model="css" fill-h :rows="14" data-sc-css
                zoom-title="站点定制 · CSS" pos-key="site-customize-css"
              />
            </div>
          </section>

          <!-- ③ 右：JS -->
          <section class="sc-col">
            <div class="sc-col-head">
              <strong>JS</strong>
              <span class="sc-dim">在页面里执行（沙箱 iframe，无 Node 权限）</span>
            </div>
            <div class="sc-editor sc-editor-js">
              <CodeField
                v-model="js" fill-h :rows="14" data-sc-js
                zoom-title="站点定制 · JS" pos-key="site-customize-js"
              />
            </div>
          </section>
        </div>
      </div>

      <div class="sc-foot">
        <label class="sc-check">
          <input v-model="readerMode" type="checkbox" data-sc-readermode />
          <span>阅读模式：自动抽正文（去导航/侧栏/广告后重排）</span>
        </label>
        <span class="sc-hint">作用于「网页即正文」会话与有 HTML 的书籍正文（漫画 / PDF / 无 HTML 的正文不适用）。</span>
        <span style="flex: 1"></span>
        <button class="btn mini" :disabled="busy" data-sc-reset @click="onReset()">恢复默认（删除该站配置）</button>
        <button class="btn mini primary" :disabled="!canSave" data-sc-save @click="onSave()">{{ busy ? '保存中…' : '保存' }}</button>
      </div>
      <p v-if="err" class="sc-err sc-err-foot" data-sc-err>{{ err }}</p>
    </div>
  </div>
</template>

<style scoped>
.sc-mask {
  position: fixed; inset: 0; z-index: 1300; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 3vh 16px;
}
/* `#574` 加宽：三栏并排（HTML / CSS / JS），高度固定以便三栏各自滚动 */
.sc-dlg {
  width: min(1500px, 97vw); height: 92vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.sc-head { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.sc-sub { font-size: 12px; color: var(--text-2); max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-host { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--text-2); }
.sc-hint-bar { padding: 6px 14px; margin: 0; border-bottom: 1px solid var(--border); }
.sc-body { flex: 1; min-height: 0; padding: 10px 14px; }
.sc-cols {
  height: 100%; min-height: 0;
  display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 0.9fr); gap: 12px;
}
.sc-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.sc-col-head { display: flex; gap: 8px; align-items: center; font-size: 12px; padding: 2px 0 6px; }
.sc-dim { font-size: 11px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-input {
  width: 230px; padding: 5px 8px; background: var(--bg-0); color: var(--text-0);
  border: 1px solid var(--border-strong); border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px;
}
.sc-src {
  flex: 1; min-height: 0; margin: 0; overflow: auto; padding: 8px; background: var(--bg-0); color: var(--text-1);
  border: 1px solid var(--border-strong); border-radius: 6px;
  font-family: ui-monospace, monospace; font-size: 11.5px; line-height: 1.55; white-space: pre;
}
.sc-empty {
  flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 12px;
  border: 1px dashed var(--border-strong); border-radius: 6px; color: var(--text-2); font-size: 12px; text-align: center;
}
.sc-presets { display: flex; gap: 6px; align-items: center; padding-bottom: 6px; flex-wrap: wrap; }
/* CodeField 的 `fill-h` 需要父容器给出确定高度；这里由 grid 行撑满 */
.sc-editor { flex: 1; min-height: 0; overflow: hidden; }
/* 弹窗顶部已写明「双击放大」⇒ 不重复占一行（也避免挤掉编辑区高度） */
.sc-editor :deep(.cf-tip) { display: none; }
.sc-editor-js { padding-top: 0; }
.sc-check { display: flex; gap: 8px; align-items: center; font-size: 12.5px; }
.sc-hint { margin: 0; font-size: 11.5px; color: var(--text-2); }
.sc-err { margin: 0 0 6px; font-size: 12px; color: var(--danger, #f66); }
.sc-err-foot { padding: 0 14px 8px; }
.sc-foot { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--border); flex-wrap: wrap; }
</style>
