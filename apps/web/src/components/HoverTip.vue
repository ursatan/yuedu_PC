<script setup lang="ts">
/**
 * HoverTip —— 全局**文本 Tooltip**（用户实测 ②：长章节名/集数名被省略号截断，看不到全名）。
 *
 * ## 设计取舍（为什么是自研的小组件，而不是原生 `title`）
 *
 * 发现页的卡片文字此前用的是原生 `title`（浏览器那个 OS 风格的提示）。这次要覆盖的是
 * **目录（2000+ 项）与选集**这种高频 hover 的场景 —— 原生 `title` 有两个硬伤：
 * ① **延迟约 1 秒**才弹，快速扫目录时基本等不到；② 不能控制位置（贴边时会被裁）、
 * 也不能跟随主题。所以做成一个全局单例：**悬停即出（0.12s 防抖）**、跟随光标右下角、
 * 贴边自动回退，全站同一套外观。发现页那三行也随之改用它 ⇒ 两处行为**真正一致**。
 *
 * ## 用法
 * 给元素加 `data-tip="完整文本"` 即可（内容一般填被 CSS 截断的那个字段）。
 *   · **只在文字真的被截断时才弹**（`scrollWidth > clientWidth`，含子元素，因为
 *     `.t`/`.pc-title` 这类是真正常省略号的那个节点）—— 短名字不会满屏弹气泡；
 *     需要"永远弹"就再加 `data-tip-always`。
 *   · 事件委托挂在 `document` 上 ⇒ 2000 个目录项**不需要各自绑监听**，也不占内存。
 *   · `pointer-events: none` + `aria-hidden`：气泡不吃鼠标事件（否则会打断 hover）。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

const visible = ref(false);
const text = ref('');
const pos = ref<{ x: number; y: number }>({ x: 0, y: 0 });
const bubble = ref<HTMLElement | null>(null);

/** 当前悬停的那个 `[data-tip]` 元素 */
let cur: HTMLElement | null = null;
/** 光标位置（跟随锚点） */
let anchor = { x: 0, y: 0 };
let timer: ReturnType<typeof setTimeout> | null = null;

const GAP_X = 14;
const GAP_Y = 18;
const EDGE = 8;

function isTruncated(el: HTMLElement): boolean {
  if (el.dataset['tipAlways'] !== undefined) return true;
  if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) return true;
  // 子元素（`.t` 这类真正挂 text-overflow 的节点）被截断也算
  for (const c of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
    if (c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1) return true;
  }
  return false;
}

/** 定位：光标右下角；右边/下边放不下就回退（下边不够时翻到光标上方） */
function place(): void {
  const el = bubble.value;
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  let x = anchor.x + GAP_X;
  let y = anchor.y + GAP_Y;
  if (x + w > window.innerWidth - EDGE) x = Math.max(EDGE, window.innerWidth - w - EDGE);
  if (y + h > window.innerHeight - EDGE) {
    const up = anchor.y - h - 10;
    y = up >= EDGE ? up : Math.max(EDGE, window.innerHeight - h - EDGE);
  }
  pos.value = { x, y };
}

function hide(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  cur = null;
  visible.value = false;
}

function onOver(e: PointerEvent): void {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]') ?? null;
  if (!el || el === cur) return;
  hide();
  const tip = el.dataset['tip'] ?? '';
  if (!tip || !isTruncated(el)) return; // 没被截断就别打扰
  cur = el;
  anchor = { x: e.clientX, y: e.clientY };
  timer = setTimeout(() => {
    text.value = tip;
    visible.value = true;
    void nextTick(place);
  }, 120);
}

function onMove(e: PointerEvent): void {
  if (!cur) return;
  anchor = { x: e.clientX, y: e.clientY };
  if (visible.value) place();
}

function onOut(e: PointerEvent): void {
  // 在同一条 data-tip 元素内部移动（比如从 `.t` 挪到同按钮的 tag 上）不关
  const to = e.relatedTarget as Node | null;
  if (cur && to && cur.contains(to)) return;
  hide();
}

onMounted(() => {
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerout', onOut, true);
  // 滚动/点击/Esc/失焦都收回 —— 否则气泡会停在原地变成"鬼影"
  window.addEventListener('scroll', hide, true);
  window.addEventListener('pointerdown', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('keydown', onEsc);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerover', onOver, true);
  document.removeEventListener('pointermove', onMove, true);
  document.removeEventListener('pointerout', onOut, true);
  window.removeEventListener('scroll', hide, true);
  window.removeEventListener('pointerdown', hide, true);
  window.removeEventListener('blur', hide);
  window.removeEventListener('keydown', onEsc);
});
function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') hide();
}
</script>

<template>
  <div
    v-if="visible" ref="bubble" class="ht-bubble" aria-hidden="true"
    :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
  >{{ text }}</div>
</template>

<style scoped>
.ht-bubble {
  position: fixed; z-index: 1020;
  max-width: min(560px, 72vw); max-height: 40vh; overflow: hidden;
  padding: 6px 9px; border-radius: 7px;
  background: var(--bg-3); color: var(--text-0);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
  font-size: 12px; line-height: 1.5; font-family: var(--font);
  white-space: pre-wrap; word-break: break-word;
  pointer-events: none;
  animation: ht-in 0.1s ease;
}
@keyframes ht-in {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
</style>
