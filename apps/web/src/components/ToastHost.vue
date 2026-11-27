<script setup lang="ts">
/**
 * 全局 Toast 宿主（挂在 App.vue 根部）。
 * 样式贴齐应用主题变量，右上角堆叠，点击即关。
 */
import { useRouter } from 'vue-router';
import { useToasts } from '../toast';

const { items, dismiss } = useToasts();
const router = useRouter();

/**
 * `#552` toast 上的「详情」一跳（巡检播报 → 源管理筛选）。
 *
 * ⚠️ 只有带 `action` 的 toast 才有按钮；点按钮**不触发**整条的 dismiss 行为
 * （卡片的 `@click="dismiss"` 是「点空白处关闭」，按钮要 `@click.stop`）。
 */
function go(t: { id: number; action?: { to: string | Record<string, unknown> } }): void {
  if (!t.action) return;
  void router.push(t.action.to as never);
  dismiss(t.id);
}
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <div
      v-for="t in items"
      :key="t.id"
      class="toast"
      :class="t.level"
      :title="t.text"
      @click="dismiss(t.id)"
    >
      <span class="txt">{{ t.text }}</span>
      <!-- `#552`：巡检播报的「详情」（没有 action 的 toast 不显示这个按钮） -->
      <button v-if="t.action" class="act" @click.stop="go(t)">{{ t.action.label }}</button>
      <button class="x" @click.stop="dismiss(t.id)">✕</button>
    </div>
  </div>
</template>

<style scoped>
.toast-host {
  /**
   * `#413`：toast 要**盖在阅读浮层（z-index:1000）之上** —— 否则「源已导入 / 已切换」这类反馈
   * 在阅读页里点了也看不见（用户实测：从阅读页唤起导入，结果反馈全被阅读页盖住）。
   * `--overlay-safe-top` 见 `styles/theme.css`：桌面外壳有 WCO 窗口按钮时整体下移到 44px，
   * 浏览器（无窗口按钮）保持 14px。
   */
  position: fixed; top: var(--overlay-safe-top, 14px); right: var(--overlay-safe-right, 14px); z-index: 1500;
  display: flex; flex-direction: column; gap: 8px;
  max-width: min(420px, 82vw); pointer-events: none;
}
.toast {
  pointer-events: auto; cursor: pointer;
  display: flex; align-items: flex-start; gap: 8px;
  padding: 9px 11px; border-radius: 9px;
  background: var(--bg-1, #1b1d24); color: var(--fg, #e6e8ef);
  border: 1px solid var(--border, #333);
  box-shadow: var(--shadow, 0 6px 22px rgba(0, 0, 0, 0.35));
  font-size: 12.5px; line-height: 1.6;
  animation: toast-in 0.16s ease-out;
}
.toast .txt { flex: 1; min-width: 0; word-break: break-word; white-space: pre-wrap; }
.toast .x {
  flex: 0 0 auto; background: transparent; border: none; cursor: pointer;
  color: var(--muted, #8b90a0); font-size: 11px; padding: 0 2px;
}
/* `#552`「详情」：跟着 level 走色（warn=橙 / ok=绿），让用户一眼看出这是可点的 */
.toast .act {
  flex: 0 0 auto; cursor: pointer; font-size: 11px; padding: 1px 7px;
  border-radius: 6px; background: transparent; color: var(--acc, #58a6ff);
  border: 1px solid var(--border, #333); font-family: var(--font);
}
.toast.warn .act { color: var(--orange, #d29922); border-color: var(--orange, #d29922); }
.toast.ok .act { color: var(--green, #3fb950); border-color: var(--green, #3fb950); }
.toast .act:hover { background: var(--bg-2, #22252e); }
.toast.ok { border-color: var(--green, #3fb950); }
.toast.warn { border-color: var(--orange, #d29922); }
.toast.error { border-color: var(--red, #f85149); }
@keyframes toast-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
</style>
