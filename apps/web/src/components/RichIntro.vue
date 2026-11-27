<script setup lang="ts">
/**
 * 简介渲染（对齐 Legado 对 `book.intro` 的两种处理）。
 *
 * ## 为什么需要它（2026-09-22 用户实测 ②⑤）
 *
 * 引擎侧 `BookInfo.kt:123-133` 把简介分成两类：
 *   · **`<usehtml>` / `<md>` / `<useweb>` 开头** → **原样保留**，由 UI 负责渲染
 *     （Legado 的 `BookInfoActivity.kt:691` 判断 `<useweb>` 后用 **WebView** 渲染）；
 *   · 其余 → `HtmlFormatter.formatIntro`（剥标签、块级标签还原换行）。
 *
 * 于是 UI 必须做两件事，否则用户的感受就是「简介坏了」：
 *   · ② 米读小说的简介是一整张 `<useweb>` **HTML 卡片**（带 `<style>`）——
 *     当纯文本插值就成了满屏源码（用户报「正文错误」其实就是这块）；
 *   · ⑤ 普通简介里的换行是 `formatIntro` 特意还原的（`<div>`/`<p>` → `\n`），
 *     HTML 默认的空白折叠会把它们吃掉 → 「应有的多行效果没有了」。
 *
 * ## 安全
 *
 * `<useweb>` 是**源作者提供的 HTML**，可能含脚本。这里用 `<iframe srcdoc>` +
 * `sandbox="allow-same-origin"`：**禁脚本**（没有 allow-scripts，脚本不会执行），
 * 但保留同源以便读取高度做自适应。比直接 `v-html` 安全得多（不会污染主文档）。
 */
import { computed, onMounted, nextTick, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ text?: string; fallback?: string; indent?: boolean }>(), {
  fallback: '',
  /**
   * `#584+` 详情页简介：按行拆成段落并首行缩进 2em（保住原文的分行/缩进观感）。
   * 其它调用方不传 ⇒ 行为与旧版一致（`pre-wrap` 单块）。
   */
  indent: false,
});

const raw = computed(() => String(props.text ?? props.fallback ?? ''));
/** `<useweb>` / `<usehtml>`：整段是 HTML（Legado 用 WebView 渲染） */
const isHtmlBlock = computed(() => /^\s*<(useweb|usehtml)>/i.test(raw.value));
/** `<md>`：Legado 按 Markdown 渲染；我们没有 markdown 渲染器，退化为等宽纯文本（留待后续） */
const isMarkdown = computed(() => /^\s*<md>/i.test(raw.value));

const htmlBody = computed(() => {
  const t = raw.value.trimStart();
  return t.replace(/^<(useweb|usehtml)>\s*/i, '').replace(/<\/(useweb|usehtml)>\s*$/i, '');
});

/** 纯文本（或 `<md>` 退化）分支的内容：去掉 `<md>` 标记 */
const textBody = computed(() => (isMarkdown.value ? raw.value.trimStart().replace(/^<md>\s*/i, '') : raw.value));
/** `indent` 模式：按行拆段（空行保留为段间距，不吞掉原文的分行结构） */
const plainLines = computed(() => textBody.value.split('\n'));

const frame = ref<HTMLIFrameElement | null>(null);
const frameHeight = ref(40);

/** 从宿主 CSS 变量取前景色，让卡片文字与阅读主题一致（卡片内部大量用 `color:inherit`） */
function hostColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const srcdoc = computed(() => {
  if (!isHtmlBlock.value) return '';
  const color = hostColor('--text-1', '#e5e5e5');
  const muted = hostColor('--muted', '#9ca3af');
  return [
    '<!doctype html><html class="dark"><head><meta charset="utf-8">',
    // 透明背景 + 继承宿主的字号/颜色；`html.dark` 与 App 一致（卡片里有 html.dark 规则）
    `<style>html,body{margin:0;padding:0;background:transparent!important;color:${color};`,
    `font-size:13px;line-height:1.6;font-family:inherit}`,
    `:root{--text-1:${color};--muted:${muted}}</style></head><body>`,
    htmlBody.value,
    '</body></html>',
  ].join('');
});

/** 自适应高度：srcdoc 加载后按文档高度撑开（sandbox 保留 allow-same-origin 才能读） */
async function fit(): Promise<void> {
  await nextTick();
  const doc = frame.value?.contentDocument;
  if (!doc?.body) return;
  const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0);
  if (h > 0) frameHeight.value = h + 2;
}

onMounted(() => void fit());
watch(srcdoc, () => void fit());
</script>

<template>
  <!-- 纯文本：`pre-wrap` 保住 formatIntro 还原出来的换行（⑤）；
       `indent`（详情页）：按行拆成段落 + 首行缩进，保住原文的分段/缩进观感。 -->
  <div v-if="!isHtmlBlock" class="intro-text" :class="{ indented: indent }">
    <template v-if="indent">
      <p v-for="(line, i) in plainLines" :key="i" class="intro-line">{{ line }}</p>
    </template>
    <template v-else>{{ textBody }}</template>
  </div>
  <!-- `<useweb>`/`<usehtml>`：沙箱 iframe 渲染 HTML 卡片（②），禁脚本 -->
  <iframe
    v-else
    ref="frame"
    class="intro-html"
    :srcdoc="srcdoc"
    :style="{ height: frameHeight + 'px' }"
    sandbox="allow-same-origin"
    referrerpolicy="no-referrer"
    loading="lazy"
    title="简介（HTML）"
    @load="fit"
  />
</template>

<style scoped>
.intro-text {
  font-size: 12.5px;
  color: var(--text-1);
  margin-top: 8px;
  line-height: 1.6;
  /* ★ 关键：HTML 默认折叠空白 → 简介的多行效果会被吃掉 */
  white-space: pre-wrap;
  word-break: break-word;
}
/* `indent` 模式：逐行成段 + 首行缩进 2em（`pre-wrap` 交给行距/段距处理） */
.intro-text.indented { white-space: normal; }
.intro-line { margin: 0 0 0.35em; text-indent: 2em; }
.intro-line:last-child { margin-bottom: 0; }
.intro-html {
  width: 100%;
  margin-top: 8px;
  border: 0;
  display: block;
  background: transparent;
  border-radius: 10px;
}
</style>
