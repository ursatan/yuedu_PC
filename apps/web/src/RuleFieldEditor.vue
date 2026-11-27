<script setup lang="ts">
/**
 * RuleFieldEditor —— 规则字段编辑框（**所有字段共用一个外壳**）
 *
 * 2026-09-29 用户实测 ② 三条都落在这里：
 *  - **b 初始高度统一 + 自动拉伸**：高度**不再由 `rows` 决定**（各字段 `rows` 不同 ⇒ 一屏高矮不一）。
 *    现在一律「空字段 = 2 行」，回车换行向下拉伸、**最多 9 行**（超出转内滚动，见 `CodeField.autoH`）。
 *    同时**去掉手工拉伸把手**（`resize: vertical`）—— 它本身也是「高度看起来不一致」的来源，
 *    而「拖大来编辑长文本」这件事双击进增强编辑器更合适。
 *  - **c 颜色统一**：底色/边框取 `--cf-bg` / `--cf-border`（由 `CodeField` 按紧凑编辑器主题导出）。
 *    否则外框比编辑器高时露出来的那一条是 `--bg-0`，与编辑器底色不同 —— 就是那条色差。
 *  - **a 提示语重复**：删掉这里的逐字段 `.rfe-tip`；整页只留一条，由 `WorkshopEditor` 放在 tab 最上方。
 *
 * 双击 → 直达 `CodeField` 的原生增强编辑器（字号 / 多配色主题 / 补全 / 快捷符号 / 格式化）。
 */
import { ref } from 'vue';
import CodeField from './CodeField.vue';

const props = defineProps<{
  modelValue: string;
  rows?: number;
  label?: string;
  placeholder?: string;
  /**
   * `#162`：透传给 `CodeField` 的**光标记忆键**（字段用它的 `path`）。
   * 不传就不记忆 —— 见 `CodeField.posKey` 的注释（为什么不能用下标当键）。
   */
  posKey?: string;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const cf = ref<InstanceType<typeof CodeField> | null>(null);

/** 双击一次 → 直达原生增强编辑器（zoom 面板） */
function openEnhanced() {
  cf.value?.openZoom();
}
</script>

<template>
  <div class="rfe-wrap">
    <div class="rfe-box" @dblclick="openEnhanced">
      <!-- 高度完全由内容决定（auto-h）：初始 2 行、最多 9 行 -->
      <CodeField
        ref="cf"
        :model-value="modelValue"
        auto-h
        :zoomable="false"
        :zoom-title="label"
        :pos-key="posKey"
        @update:model-value="emit('update:modelValue', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.rfe-wrap { width: 100%; }
.rfe-box {
  /* 高度让编辑器自己撑开（见 CodeField 的 autoH）⇒ 本层只负责圆角、边框与溢出 */
  overflow: hidden;
  border: 1px solid var(--cf-border, var(--border));
  border-radius: 7px;
  /* ★ 与紧凑编辑器**同色**（用 CodeField 导出的变量）—— 这条就是 ②-c 的修法 */
  background: var(--cf-bg, #1e293b);
}
.rfe-box:focus-within { border-color: var(--acc-dim); }
/* 内层编辑器贴合外框：去内边框/圆角/底色，整个区域一体 */
.rfe-box :deep(.cf-wrap .cf-compact) {
  border: none;
  border-radius: 0;
  background: transparent;
}
.rfe-box :deep(.cf-tip) { display: none; }
</style>
