<script lang="ts">
/**
 * 分类项（label 显示 / value 回传筛选）
 *  layout → Legado FlexChildStyle 子集（0.25 = 一行 4 个；1 = 整行标题）
 *
 * ⚠️ **本组件只管「分类条」**（2026-09-23 重构：功能组件与分类分离）。
 * 交互型控件（select/toggle/text/button）与纯标题型分组标题都已迁到 `CatToolbar.vue`，
 * 由 DiscoverView 先按分组切好再传进来（见 `docs/02-交接文档.md` §4.2 类Q）。
 */
export interface CatOption {
  label: string;
  /**
   * **原始 name**（未经装饰清理）。分类 chip 的选中态比对用它 ——
   * `label` 会被调用方 `clean()` 剥掉首尾装饰符，而 `scrollerValue` 侧用的是原始 name，
   * 两者不一致时「点了分类但不高亮」。
   */
  rawLabel?: string;
  value?: string;
  layout?: { flexGrow?: number; flexBasisPercent?: number };
}
</script>

<script setup lang="ts">
/**
 * CategoryScroller —— 分类横滚条（移植自 OmniFlow，2026-09-23 收为「纯分类条」）
 * 单行横向滚动：滚轮横滑 / 拖拽 / 点击居中 / 右端下拉弹层全量选择 / 位置持久化
 * 只渲染**当前分组**的 url 型子分类；100+ 分类的源靠「分组 + 横滚 + 全量下拉」三层消化。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  categories: CatOption[];
  modelValue?: CatOption | null;
  emptyHint?: string;
  searchable?: boolean;
  /** 滚动位置持久化 key（通常传 sourceId） */
  scopeKey?: string;
  /** 全量下拉弹层的标题（通常是「源名 · 分组名」） */
  popTitle?: string;
}>(), {
  emptyHint: '暂无项目',
  searchable: true,
  scopeKey: '',
  popTitle: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', v: CatOption): void;
  (e: 'change', v: CatOption): void;
}>();

const scrollEl = ref<HTMLDivElement | null>(null);
const popVisible = ref(false);
const search = ref('');
const isDragging = ref(false);
const dragStart = reactive({ x: 0, left: 0, moved: false });
const scrollLeft = ref(0);
const maxScroll = ref(0);
const chipRefs = reactive<Record<string, HTMLElement | null>>({});
const hasScrolled = computed(() => scrollLeft.value > 0 || maxScroll.value > 0);

const innerStyle = computed(() => ({ transform: `translateX(${-scrollLeft.value}px)` }));

/**
 * 分类 chip 的身份键。
 *
 * ⚠️ 用 `rawLabel`（引擎给的 `ExploreKind.title` 原文）而非渲染用的 `label`：
 * `label` 会被调用方 `clean()` 剥掉首尾装饰符（`✲＊*·•-—_`），
 * 而 DiscoverView 传下来的 `modelValue` 用的是**原始 name** —— 两者不一致时
 * 会出现「点了分类但不高亮 / 高亮错项」。
 */
function keyOf(c: CatOption): string {
  return `${c.rawLabel ?? c.label}::${c.value ?? ''}`;
}
function isActive(c: CatOption): boolean {
  if (props.modelValue == null) return false;
  return keyOf(props.modelValue) === keyOf(c);
}
/** Legado FlexChildStyle → chip 尺寸：0.25 → 一行 4 个（窄）；0.5 → 两个；1 → 整行 */
function chipStyle(c: CatOption): Record<string, string> {
  const pct = c.layout?.flexBasisPercent;
  if (pct == null) return {};
  if (pct >= 1) return { minWidth: '150px', fontWeight: '700' };
  if (pct >= 0.5) return { minWidth: '120px' };
  if (pct >= 0.25) return { minWidth: '92px' };
  return {};
}
function setChipRef(k: string, el: HTMLElement | null) { chipRefs[k] = el; }

/* 位置持久化（sessionStorage） */
const CACHE_KEY_PREFIX = 'yuedu.cs.v1.';
interface CsPosCache { scrollLeft: number; activeKey: string; ts: number }
function cacheFullKey(): string { return CACHE_KEY_PREFIX + (props.scopeKey?.trim() || '__default__'); }
function _saveCache(forceActiveKey?: string) {
  try {
    sessionStorage.setItem(cacheFullKey(), JSON.stringify({
      scrollLeft: scrollLeft.value,
      activeKey: forceActiveKey ?? (props.modelValue ? keyOf(props.modelValue) : ''),
      ts: Date.now(),
    } satisfies CsPosCache));
  } catch { /* ignore */ }
}
function _loadCache(): CsPosCache | null {
  try {
    const raw = sessionStorage.getItem(cacheFullKey());
    return raw ? (JSON.parse(raw) as CsPosCache) : null;
  } catch { return null; }
}
function persistPos(forceActiveKey?: string) { _saveCache(forceActiveKey); }
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => persistPos(), 120);
}

function onPick(c: CatOption) {
  popVisible.value = false;
  emit('update:modelValue', c);
  emit('change', c);
  nextTick(() => {
    const host = scrollEl.value;
    const chip = chipRefs[keyOf(c)];
    if (!host || !chip) { persistPos(keyOf(c)); return; }
    const hostRect = host.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const delta = (chipRect.left - hostRect.left) - host.clientWidth / 2 + chipRect.width / 2;
    animateScrollTo(Math.max(0, Math.min(maxScroll.value, scrollLeft.value + delta)));
    persistPos(keyOf(c));
    setTimeout(() => persistPos(keyOf(c)), 320);
  });
}

const filteredCategories = computed(() => {
  if (!search.value.trim()) return props.categories;
  const kw = search.value.trim().toLowerCase();
  return props.categories.filter((c) => c.label.toLowerCase().includes(kw));
});

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function onWheel(e: WheelEvent) {
  const dx = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * (e.deltaY ? 1.2 : 1);
  scrollLeft.value = clamp(scrollLeft.value + dx, 0, maxScroll.value);
  updateTrackHints();
  schedulePersist();
}

/** 交互型控件（select/input/按钮）——不参与拖拽，且不能阻止其默认行为
 *  （此前 track 上挂 `@mousedown.left.prevent` 无条件 preventDefault → 原生
 *    <select> 展不开、「点击无反应」，input 也无法聚焦） */
// 只有弹层按钮/弹层本身不该触发拖拽（交互控件已迁到 CatToolbar）
const INTERACTIVE_SELECTOR = '.cs-pop-btn, .cs-popup';
function onInteractiveTarget(e: MouseEvent): boolean {
  const t = e.target as HTMLElement | null;
  return typeof t?.closest === 'function' && !!t.closest(INTERACTIVE_SELECTOR);
}
function onDragStart(e: MouseEvent) {
  if (onInteractiveTarget(e)) return; // 交给原生控件处理（下拉展开 / 输入聚焦）
  e.preventDefault(); // 只对分类 chip 阻止默认（避免拖拽时选中文本）
  isDragging.value = true;
  dragStart.x = e.clientX;
  dragStart.left = scrollLeft.value;
  dragStart.moved = false;
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
}
function onDragMove(e: MouseEvent) {
  if (!isDragging.value) return;
  const dx = e.clientX - dragStart.x;
  if (Math.abs(dx) > 3) dragStart.moved = true;
  scrollLeft.value = clamp(dragStart.left - dx, 0, maxScroll.value);
}
function onDragEnd() {
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
  if (isDragging.value) {
    isDragging.value = false;
    updateTrackHints();
    if (dragStart.moved) schedulePersist();
  }
}

function animateScrollTo(target: number) {
  const start = scrollLeft.value;
  const delta = target - start;
  const dur = 240;
  const t0 = performance.now();
  function tick(now: number) {
    const p = Math.min(1, (now - t0) / dur);
    const ease = 1 - Math.pow(1 - p, 3);
    scrollLeft.value = clamp(start + delta * ease, 0, maxScroll.value);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function recomputeMax() {
  const host = scrollEl.value; if (!host) { maxScroll.value = 0; return; }
  const inner = host.querySelector('.cs-inner') as HTMLElement | null;
  if (!inner) { maxScroll.value = 0; return; }
  maxScroll.value = Math.max(0, inner.scrollWidth - host.clientWidth);
  if (scrollLeft.value > maxScroll.value) scrollLeft.value = maxScroll.value;
}
function updateTrackHints() {
  const host = scrollEl.value; if (!host) return;
  host.classList.toggle('can-left', scrollLeft.value > 2);
  host.classList.toggle('can-right', scrollLeft.value + 2 < maxScroll.value);
}
function onResize() {
  recomputeMax();
  updateTrackHints();
}
/** 还原 + 选中 chip 居中 */
function restoreAndCenter() {
  nextTick(() => {
    const host = scrollEl.value; if (!host) { recomputeMax(); return; }
    recomputeMax();
    const active = props.modelValue;
    if (!active) { updateTrackHints(); return; }
    const chip = chipRefs[keyOf(active)];
    if (!chip) return;
    const cache = _loadCache();
    const canTrustScroll = !!cache && cache.activeKey === keyOf(active) && maxScroll.value > 0;
    if (canTrustScroll && typeof cache!.scrollLeft === 'number') {
      scrollLeft.value = clamp(cache!.scrollLeft, 0, maxScroll.value);
    }
    nextTick(() => {
      const host2 = scrollEl.value; if (!host2) return;
      recomputeMax();
      const chipNow = chipRefs[keyOf(active)];
      if (!chipNow) { schedulePersist(); updateTrackHints(); return; }
      const hostRect = host2.getBoundingClientRect();
      const chipRect = chipNow.getBoundingClientRect();
      const visibleOk = (chipRect.right + 4) >= hostRect.left + 4 && (chipRect.left - 4) <= hostRect.right - 4;
      if (!visibleOk || !canTrustScroll) {
        const delta = (chipRect.left - hostRect.left) - host2.clientWidth / 2 + chipRect.width / 2;
        animateScrollTo(clamp(scrollLeft.value + delta, 0, maxScroll.value));
      }
      updateTrackHints();
      schedulePersist();
    });
  });
}

onMounted(() => {
  recomputeMax();
  updateTrackHints();
  restoreAndCenter();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onResize);
    if (scrollEl.value) ro.observe(scrollEl.value);
    onBeforeUnmount(() => ro.disconnect());
  }
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  persistPos();
  if (_saveTimer) clearTimeout(_saveTimer);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
});
watch(() => props.categories, () => { restoreAndCenter(); }, { flush: 'post' });
watch(() => props.modelValue, (n) => { if (n) restoreAndCenter(); }, { flush: 'post' });
watch(() => props.scopeKey, () => { restoreAndCenter(); });
</script>

<template>
  <div class="cat-scroller" @mouseleave="() => {}">
    <div
      ref="scrollEl"
      class="cs-track"
      :class="{ dragging: isDragging }"
      @wheel.prevent="onWheel"
      @mousedown.left="onDragStart"
      @mousemove="onDragMove"
      @mouseup="onDragEnd"
      @mouseleave="onDragEnd"
    >
      <div class="cs-inner" :style="innerStyle">
        <!-- 分类 chip（只有 url 型子分类会传进来；交互控件与分组标题在 CatToolbar） -->
        <div
          v-for="c in categories"
          :key="keyOf(c)"
          class="cs-chip"
          :class="{ on: isActive(c) }"
          :style="chipStyle(c)"
          :ref="(el) => setChipRef(keyOf(c), el as HTMLElement | null)"
          @click="onPick(c)"
        >{{ c.label }}</div>
        <span v-if="!categories.length" class="hint-tip">{{ emptyHint }}</span>
      </div>
    </div>

    <!-- 右端固定：全量下拉 -->
    <button
      type="button"
      class="cs-pop-btn"
      :title="'所有项目（共 ' + categories.length + ' 项）· 点击选择'"
      @click="popVisible = !popVisible"
    >
      <em>{{ categories.length }}</em>
    </button>

    <transition name="fade">
      <!-- ⚠️ `#535` **不要挂 `@mouseleave` 关闭**。
           用户实测：「下拉里的筛选框输入中文，下拉界面会失焦收回」。
           根因是 IME 候选窗（Windows 拼音等）是**独立的顶层窗口**：它一出现，指针就被系统判为
           离开了本元素 ⇒ 浏览器补发 `mouseleave` ⇒ 输入到一半弹层自己收回。
           本项目浮层约定是「只由关闭按钮 / ESC 关闭，点浮层外不关」（见 handover 约定），
           所以这里直接去掉 hover 关闭，并在输入框上补 ESC（`@keydown.esc`）。 -->
      <ul v-if="popVisible" class="cs-popup">
        <li class="pop-head">
          <div><b>{{ popTitle ? popTitle + ' · ' : '' }}{{ categories.length }} 项</b></div>
          <span class="pop-close" @click="popVisible = false">×</span>
        </li>
        <li v-if="searchable" class="pop-search">
          <input v-model="search" placeholder="筛选…" @keydown.esc="popVisible = false" />
        </li>
        <li class="pop-list-wrap">
          <div class="pop-list">
            <div
              v-for="c in filteredCategories"
              :key="keyOf(c)"
              class="pop-row"
              :class="{ on: isActive(c) }"
              @click="onPick(c)"
            >
              <span class="r-idx">{{ filteredCategories.indexOf(c) + 1 }}</span>
              <span class="r-label">{{ c.label }}</span>
              <span v-if="isActive(c)" class="r-on">● 已选</span>
            </div>
            <div v-if="!filteredCategories.length" class="pop-empty">无匹配项目</div>
          </div>
        </li>
      </ul>
    </transition>
  </div>
</template>

<style scoped>
.cat-scroller {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 10px;
  padding-right: 52px;
  min-width: 0;
  max-width: 100%;
  overflow: visible;
}
.cs-track {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  border-radius: 12px;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1px solid var(--border);
  user-select: none;
  transition: box-shadow 160ms ease;
}
.cs-track::before, .cs-track::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0;
  width: 36px;
  z-index: 1;
  pointer-events: none;
  transition: opacity 150ms ease;
}
.cs-track::before {
  left: 0;
  background: linear-gradient(90deg, var(--bg-2) 0%, rgba(20, 23, 36, 0) 100%);
  opacity: 0;
}
.cs-track::after {
  right: 0;
  background: linear-gradient(270deg, var(--bg-2) 0%, rgba(20, 23, 36, 0) 100%);
  opacity: 0;
}
.cs-track.can-left::before, .cs-track.can-right::after { opacity: 1; }
.cs-track:hover { border-color: var(--border-strong); }
.cs-track.dragging { cursor: grabbing; box-shadow: 0 0 0 2px rgba(79, 140, 255, 0.2) inset; }
.cs-inner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  white-space: nowrap;
  will-change: transform;
}
.cs-track:not(.dragging) .cs-inner { transition: transform 160ms ease; }
.cs-chip {
  flex-shrink: 0;
  padding: 5px 13px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-1);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 150ms ease;
}
.cs-chip:hover {
  background: var(--bg-3);
  color: var(--text-0);
  border-color: var(--border-strong);
}
.cs-chip.on {
  background: linear-gradient(135deg, rgba(79, 140, 255, 0.22), rgba(160, 112, 255, 0.22));
  color: #fff;
  border-color: rgba(79, 140, 255, 0.5);
  box-shadow: 0 2px 10px rgba(79, 140, 255, 0.18);
  font-weight: 600;
}
.hint-tip { color: var(--muted); font-size: 12px; padding: 4px 6px; }

.cs-pop-btn {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 150ms ease;
}
.cs-pop-btn::after {
  content: '';
  width: 0; height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 7px solid var(--text-0);
}
.cs-pop-btn:hover {
  background: linear-gradient(135deg, rgba(79, 140, 255, 0.18), rgba(160, 112, 255, 0.18));
  border-color: rgba(79, 140, 255, 0.5);
}
.cs-pop-btn em {
  position: absolute;
  top: -6px;
  right: -6px;
  font-style: normal;
  font-size: 10px;
  background: var(--brand);
  color: #fff;
  border-radius: 999px;
  padding: 1px 5px;
  line-height: 1;
  font-weight: 700;
  border: 1px solid var(--bg-0);
}

.cs-popup {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 280px;
  max-width: min(620px, calc(100vw - 32px));
  max-height: 64vh;
  margin: 0;
  padding: 0;
  list-style: none;
  background: var(--bg-1);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text-0);
  font-size: 13px;
}
.pop-close {
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  color: var(--muted);
  padding: 0 4px;
}
.pop-close:hover { color: var(--text-0); }
.pop-search { padding: 8px 14px; border-bottom: 1px solid var(--border); }
.pop-search input {
  width: 100%;
  border: 1px solid var(--border-strong);
  background: var(--bg-2);
  color: var(--text-0);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 13px;
  outline: none;
}
.pop-search input:focus { border-color: rgba(79, 140, 255, 0.55); box-shadow: 0 0 0 2px rgba(79, 140, 255, 0.18); }
.pop-list-wrap { overflow: hidden; }
.pop-list {
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 48vh;
  overflow: auto;
}
.pop-row {
  display: grid;
  grid-template-columns: 34px 1fr auto;
  align-items: center;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-1);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.pop-row:hover { background: var(--bg-2); color: var(--text-0); }
.pop-row .r-idx {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  text-align: center;
  width: 22px;
  padding: 2px 0;
  border-radius: 6px;
  background: var(--bg-2);
}
.pop-row .r-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 8px;
}
.pop-row .r-on { color: var(--green); font-size: 11.5px; font-weight: 600; }
.pop-row.on {
  background: linear-gradient(135deg, rgba(79, 140, 255, 0.18), rgba(160, 112, 255, 0.18));
  color: #fff;
}
.pop-row.on .r-label::before {
  content: '';
  display: inline-block;
  width: 3px;
  height: 11px;
  border-radius: 2px;
  background: var(--green);
  margin-right: 8px;
}
.pop-empty {
  text-align: center;
  color: var(--muted);
  padding: 18px 10px;
  font-size: 12px;
}
.fade-enter-active, .fade-leave-active { transition: opacity 120ms ease, transform 120ms ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
