<script setup lang="ts">
/**
 * 侧栏导航图标（统一线性风格）
 *
 * 为什么单独一套 SVG：此前导航用的是字符（`⌂ ⌕ ❑ ▷ ≋ 字 ⚙`），
 * 字形来自不同符号字体，描边粗细、留白、基线都不受控，还会出现
 * 「字」这种字符字与线性图标混排。这里统一为：
 *   · 24×24 视框、stroke-width 1.6、圆端点圆连接、无填充；
 *   · 只画轮廓线条，不混面性图标（RSS 的圆点也走描边）；
 *   · 颜色一律 currentColor，跟随 el-menu 的文字色/激活色自动变化。
 *
 * 语义区分：书架=三本并列书+搁板；书院=摊开的书；字典=合上的书+文字行；
 * 影视=播放框；影院=场记板 —— 不再出现「书架与影视源轮廓雷同」。
 */
defineProps<{ name: string }>();
</script>

<template>
  <svg
    class="nav-icon"
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- 首页：房子 -->
    <template v-if="name === 'home'">
      <path d="M3.6 10.4 12 3.6l8.4 6.8v9.2a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1Z" />
      <path d="M9.4 20.6v-5.3h5.2v5.3" />
    </template>

    <!-- 跨源搜索：放大镜 -->
    <template v-else-if="name === 'search'">
      <circle cx="10.6" cy="10.6" r="6.1" />
      <path d="m15.2 15.2 4.8 4.8" />
    </template>

    <!-- 书架：两本竖书 + 一本斜靠 + 搁板（避免与「阅读统计」的柱形混淆） -->
    <template v-else-if="name === 'shelf'">
      <path d="M4.9 19.9V6.2a1.1 1.1 0 0 1 1.1-1.1h1.9a1.1 1.1 0 0 1 1.1 1.1v13.7" />
      <path d="M9.6 19.9V4.6a1.1 1.1 0 0 1 1.1-1.1h1.9a1.1 1.1 0 0 1 1.1 1.1v15.3" />
      <path d="M16.4 6.3 19.8 7.2 17 19.8 13.6 18.9Z" />
      <path d="M3.4 20.6h17.4" />
    </template>

    <!-- 下载管理：向下箭头 + 托盘底线 -->
    <template v-else-if="name === 'download'">
      <path d="M12 3.8v10.6" />
      <path d="m7.6 10 4.4 4.4 4.4-4.4" />
      <path d="M4.4 19.9h15.2" />
    </template>

    <!-- 影视：播放框 -->
    <template v-else-if="name === 'video'">
      <rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.4" />
      <path d="M10.2 9 15.1 12l-4.9 3Z" />
    </template>

    <!-- 书院 · 书源：摊开的书 -->
    <template v-else-if="name === 'book-open'">
      <path d="M12 6.9C10.3 5.5 8.2 4.9 5.7 4.9H3.4v13.5h2.3c2.5 0 4.6.6 6.3 2" />
      <path d="M12 6.9c1.7-1.4 3.8-2 6.3-2h2.3v13.5h-2.3c-2.5 0-4.6.6-6.3 2Z" />
      <path d="M12 6.9v13.5" />
    </template>

    <!-- 影院 · 影视源：场记板 -->
    <template v-else-if="name === 'clapper'">
      <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
      <path d="m6.2 5.3 3.1 3.9" />
      <path d="m12.4 3.4 3.1 4" />
      <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </template>

    <!-- RSS 订阅：同心弧 + 圆点 -->
    <template v-else-if="name === 'rss'">
      <circle cx="5.2" cy="18.8" r="1.2" />
      <path d="M5.2 11.6a7.2 7.2 0 0 1 7.2 7.2" />
      <path d="M5.2 4.6a14.2 14.2 0 0 1 14.2 14.2" />
    </template>

    <!-- 规则工坊：扳手 -->
    <template v-else-if="name === 'wrench'">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      />
    </template>

    <!-- 源管理：双机架 + 指示灯 -->
    <template v-else-if="name === 'server'">
      <rect x="3.2" y="4.2" width="17.6" height="7" rx="1.8" />
      <rect x="3.2" y="12.8" width="17.6" height="7" rx="1.8" />
      <path d="M7 7.7h.01" />
      <path d="M7 16.3h.01" />
    </template>

    <!-- 字典：合上的书 + 词条行 -->
    <template v-else-if="name === 'dict'">
      <path d="M5.2 20.2V5.6A2.6 2.6 0 0 1 7.8 3h11.6v17.2H7.8a2.6 2.6 0 0 1 0-5.2h11.6" />
      <path d="M9 7.4h6.4" />
      <path d="M9 10.6h7.2" />
    </template>

    <!-- 阅读统计：坐标轴 + 折线 -->
    <template v-else-if="name === 'chart'">
      <path d="M3.6 3.8v16.8h16.8" />
      <path d="m7 15.8 3.5-4 3 2.3 4.5-5.6" />
    </template>

    <!-- 设置：齿轮（Feather 齿形，与侧栏底部「服务」齿轮同族；缩到 0.86 与其他图标视觉等大） -->
    <template v-else-if="name === 'gear'">
      <g transform="translate(12 12) scale(.86) translate(-12 -12)">
        <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
        <path
          d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.36a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"
        />
      </g>
    </template>
  </svg>
</template>
