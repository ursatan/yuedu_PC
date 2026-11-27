/**
 * 页面卷曲渲染组件。
 *
 * 对外只认四件事：`front / back / next` 三张纹理、`progress`（0~1）、`direction`（1 / -1）。
 * 渲染器选择、网格密度、降级阈值都在内部；父组件不需要知道 WebGL 是否可用。
 *
 * 降级链（默认不依赖 WebGL）：
 *   Canvas2D（默认首选） → WebGL（可选加速档，仅当 2D 帧率不达标时尝试一次）
 *   → CSS 透视近似 → 无动画（reduce motion）
 *
 * 几何是**单页、书脊在左缘**：正向与回翻共用同一套（正向 p 增、回翻 p 减），
 * 平展正面始终在折线左侧、下一页始终从右侧露出。
 */
<template>
  <div ref="host" class="page-curl" :style="{ width: `${cssW}px`, height: `${cssH}px` }">
    <canvas
      v-if="tier === 'webgl' || tier === 'canvas2d'"
      :key="canvasKey"
      ref="canvasRef"
      class="page-curl__canvas"
    ></canvas>

    <div v-else-if="tier === 'css'" class="page-curl__css" :style="cssBoxStyle">
      <canvas ref="nextRef" class="page-curl__css-page"></canvas>
      <canvas ref="sheetRef" class="page-curl__css-page page-curl__css-sheet" :style="sheetStyle"></canvas>
    </div>

    <canvas v-else ref="flatRef" class="page-curl__canvas"></canvas>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { PageCurlEngine } from './engine';
import type { CurlDegradeInfo, CurlRendererName, CurlTextureSource } from './engine';

const props = withDefaults(
  defineProps<{
    /** 当前页正面 */
    front: CurlTextureSource | null;
    /** 当前页背面 */
    back: CurlTextureSource | null;
    /** 翻页后露出的下一页 */
    next: CurlTextureSource | null;
    /** 0~1 */
    progress: number;
    /** 1 = 从右向左；-1 = 从左向右 */
    direction?: 1 | -1;
    /** 正文区宽（CSS px） */
    width?: number;
    /** 正文区高（CSS px） */
    height?: number;
    /** 四周透明留白 */
    padding?: number;
    /** 纹理/绘制分辨率倍数 */
    dpr?: number;
    /** 网格密度；不传按宽度自动（>=1200 用 32×16，否则 20×10） */
    grid?: [number, number];
  }>(),
  {
    direction: 1,
    width: 918,
    height: 700,
    padding: 56,
    dpr: 1,
  },
);

const emit = defineEmits<{
  (e: 'degrade', info: CurlDegradeInfo): void;
  (e: 'rendered', phase: 'idle' | 'curl'): void;
}>();

const host = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const nextRef = ref<HTMLCanvasElement | null>(null);
const sheetRef = ref<HTMLCanvasElement | null>(null);
const flatRef = ref<HTMLCanvasElement | null>(null);

const tier = ref<'webgl' | 'canvas2d' | 'css' | 'none'>('canvas2d');
/** 换渲染器重建引擎必须换一张新 canvas（同一画布拿不回第二个上下文） */
const canvasKey = ref(0);
let engine: PageCurlEngine | null = null;
let pendingDegrade: CurlDegradeInfo | null = null;
let forcedRenderer: CurlRendererName | null = null;
/** WebGL 只作为「可选加速档」尝试一次，避免在 2D↔GL 之间来回抖动 */
let triedWebgl = false;
let lastProgressAt = 0;
let reducedMotion = false;
/** CSS 层的帧率采样（CSS 档没有引擎，只能在这里量） */
let cssFrames: number[] = [];
let cssLastAt = 0;
let cssBadWindows = 0;

const cssW = computed(() => props.width + props.padding * 2);
const cssH = computed(() => props.height + props.padding * 2);
const cssBoxStyle = computed(() => ({
  left: `${props.padding}px`,
  top: `${props.padding}px`,
  width: `${props.width}px`,
  height: `${props.height}px`,
}));
const sheetStyle = computed(() => {
  const p = Math.max(0, Math.min(1, props.progress));
  // CSS 兜底档也用同一前提：轴心在**左缘**；回翻只是 p 从 1 走到 0（同一公式）
  return {
    transformOrigin: 'left center',
    transform: `perspective(1400px) rotateY(${-70 * p}deg)`,
    opacity: String(1 - 0.08 * p),
  };
});

function autoGrid(): [number, number] {
  if (props.grid) return props.grid;
  return props.width >= 1200 ? [32, 16] : [20, 10];
}

function makeEngine(): PageCurlEngine | null {
  const canvas = canvasRef.value;
  if (!canvas) return null;
  try {
    return new PageCurlEngine(canvas, {
      layout: { width: props.width, height: props.height, padding: props.padding, dpr: props.dpr },
      renderer: forcedRenderer ?? 'auto',
      grid: autoGrid(),
      onDegrade: (info) => {
        if (!engine) {
          pendingDegrade = info;
          return;
        }
        handleDegrade(info);
      },
    });
  } catch {
    tier.value = 'css';
    return null;
  }
}

/**
 * 降级链：Canvas2D --(帧率不达标)--> WebGL（可选，只试一次）--(还不达标)--> CSS 透视近似 --> 无动画。
 * WebGL 构造失败 / 软件渲染时引擎会回调 `from: 'webgl'`，这里直接落到 CSS。
 */
function handleDegrade(info: CurlDegradeInfo): void {
  emit('degrade', info);
  if (reducedMotion) {
    toTier('none');
    return;
  }
  if (info.from === 'canvas2d' && info.reason === 'fps' && !triedWebgl) {
    triedWebgl = true;
    forcedRenderer = 'webgl';
    rebuild();
    return;
  }
  toTier('css');
}

function rebuild(): void {
  disposeEngine();
  canvasKey.value += 1;
  void nextTick(() => {
    const e = makeEngine();
    if (!e) {
      toTier('css');
      return;
    }
    engine = e;
    tier.value = e.getStats().renderer;
    e.setDirection(props.direction);
    e.setProgress(props.progress);
    setTextures();
    e.render();
    // 构造 WebGL 失败时引擎会同步回调，此时 engine 还没赋值 ⇒ 先存后放
    if (pendingDegrade) {
      const d = pendingDegrade;
      pendingDegrade = null;
      handleDegrade(d);
    }
  });
}

function toTier(next: 'css' | 'none'): void {
  disposeEngine();
  tier.value = next;
  if (next === 'css') {
    void nextTick(() => paintCss());
  } else {
    void nextTick(() => paintFlat());
  }
}

function disposeEngine(): void {
  engine?.dispose();
  engine = null;
}

function drawInto(target: HTMLCanvasElement | null, src: CurlTextureSource | null): void {
  if (!target || !src) return;
  const w = 'width' in src ? src.width : 0;
  const h = 'height' in src ? src.height : 0;
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(src, 0, 0);
}

function paintCss(): void {
  if (tier.value !== 'css') return;
  drawInto(nextRef.value, props.next);
  drawInto(sheetRef.value, props.front);
}

function paintFlat(): void {
  if (tier.value !== 'none') return;
  drawInto(flatRef.value, props.front);
}

function setTextures(): void {
  if (engine) {
    engine.setTextures({ front: props.front, back: props.back, next: props.next });
  }
  paintCss();
  paintFlat();
}

function render(): void {
  if (engine) {
    engine.setProgress(props.progress);
    engine.setDirection(props.direction);
    engine.render();
    return;
  }
  paintCss();
}

function noteFrame(): void {
  const now = performance.now();
  if (engine) {
    if (props.progress > 0.01 && props.progress < 0.99 && lastProgressAt > 0) {
      engine.noteFrame(now - lastProgressAt);
    }
  } else {
    // CSS 档没有引擎，自己量：连续 2 个 60 帧窗口的中位帧率 < 40 ⇒ 退回无动画
    sampleCss(now);
  }
  lastProgressAt = now;
}

function sampleCss(now: number): void {
  if (tier.value !== 'css' || props.progress <= 0.01 || props.progress >= 0.99) {
    cssLastAt = now;
    return;
  }
  if (cssLastAt > 0) {
    cssFrames.push(now - cssLastAt);
    if (cssFrames.length >= 60) {
      const sorted = cssFrames.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
      cssFrames = [];
      if (1000 / median < 40) {
        cssBadWindows += 1;
        if (cssBadWindows >= 2) toTier('none');
      } else {
        cssBadWindows = 0;
      }
    }
  }
  cssLastAt = now;
}

onMounted(() => {
  reducedMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) {
    tier.value = 'none';
    void nextTick(paintFlat);
    return;
  }
  const e = makeEngine();
  if (!e) {
    tier.value = 'css';
    void nextTick(paintCss);
    return;
  }
  engine = e;
  const renderer: CurlRendererName = e.getStats().renderer;
  tier.value = renderer;
  e.setDirection(props.direction);
  e.setProgress(props.progress);
  e.setTextures({ front: props.front, back: props.back, next: props.next });
  e.render();
  if (pendingDegrade) {
    const d = pendingDegrade;
    pendingDegrade = null;
    handleDegrade(d);
  }
});

onBeforeUnmount(() => {
  disposeEngine();
});

watch(
  () => [props.front, props.back, props.next],
  () => {
    setTextures();
    render();
  },
);

watch(
  () => props.progress,
  () => {
    noteFrame();
    render();
    emit('rendered', props.progress > 0.001 && props.progress < 0.999 ? 'curl' : 'idle');
  },
);

watch(
  () => props.direction,
  () => {
    engine?.setDirection(props.direction);
    render();
  },
);

watch(
  () => [props.width, props.height, props.padding, props.dpr],
  () => {
    engine?.resize({
      width: props.width,
      height: props.height,
      padding: props.padding,
      dpr: props.dpr,
    });
    render();
  },
);

defineExpose({
  /** 当前实际使用的层级，便于宿主做埋点/设置页展示 */
  getTier: (): string => tier.value,
  getStats: () => engine?.getStats() ?? null,
  /** 宿主自己驱动 rAF 时，可把帧间隔交给引擎做降级判定 */
  noteFrame: (dtMs: number) => engine?.noteFrame(dtMs),
});
</script>

<style scoped>
.page-curl {
  position: relative;
  overflow: hidden;
  contain: layout paint;
}
.page-curl__canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.page-curl__css {
  position: absolute;
  transform-style: preserve-3d;
}
.page-curl__css-page {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.22);
  transition: none;
}
.page-curl__css-sheet {
  box-shadow: -16px 0 30px rgba(0, 0, 0, 0.35);
}
</style>
