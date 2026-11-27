<script setup lang="ts">
/**
 * Android 风格 Toast 宿主（挂在 App.vue 根部，全局唯一）。
 *
 * 视觉对齐 Android 原生 Toast：**底部居中、半透明深色胶囊、白字、向下渐隐**。
 * 挂载点与 `ToastHost`（右上角卡片）分开 —— 见 `src/android-toast.ts` 顶部的取舍说明。
 */
import { useAndroidToasts } from '../android-toast';

const { items, dismiss } = useAndroidToasts();
</script>

<template>
  <!--
    `aria-live=polite` + `role=status`：屏幕阅读器会播报，且不打断当前朗读
    （源脚本的提示多为「未登录」这类需要用户知晓但不紧急的信息）。
  -->
  <div class="android-toast-host" aria-live="polite" role="status">
    <TransitionGroup name="at">
      <div
        v-for="t in items"
        :key="t.id"
        class="android-toast"
        :title="t.text"
        @click="dismiss(t.id)"
      >
        {{ t.text }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.android-toast-host {
  position: fixed;
  /* 底部居中（Android 原生位置） */
  left: 50%;
  /*
   * 抬高到 88px：右下角有音频/视频浮窗（`AudioPlayer.vue` 的 `.ap-wrap` 是 bottom 18px），
   * 贴底会被它压住。88px 让两者视觉上不打架，无浮窗时也不显得贴边。
   */
  bottom: 88px;
  transform: translateX(-50%);
  /* 盖住一切（音频浮窗 900、普通 toast 300）——toast 必须永远可见 */
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: min(560px, 88vw);
  pointer-events: none;
}

.android-toast {
  pointer-events: auto;
  cursor: pointer;
  /* 半透明深色胶囊 + 白字：深色主题下不刺眼，浅色主题下也读得清（同 Android 原生） */
  background: rgba(24, 26, 32, 0.82);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 22px;
  padding: 10px 18px;
  font-size: 13.5px;
  line-height: 1.55;
  text-align: center;
  word-break: break-word;
  white-space: pre-wrap;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(8px);
}

/* 入场：轻微上浮 + 淡入（Android 11+ 的 Toast 动效） */
.at-enter-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
/* 退场：**向下渐隐**（用户明确要求的形态） */
.at-leave-active {
  transition: opacity 0.34s ease, transform 0.34s ease;
}
.at-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.at-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
/* 多条堆叠时让被顶下去的那条平滑移动 */
.at-move {
  transition: transform 0.22s ease;
}
</style>
