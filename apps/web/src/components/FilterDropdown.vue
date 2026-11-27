<script lang="ts">
/**
 * 通用「筛选下拉」（按钮 + 弹层）—— `#280` 引擎/类型筛选的**统一实现**。
 *
 * ## 为什么要有它
 * 此前引擎/类型筛选在各页是原生 `<select>`：弹层是系统样式，与分组筛选
 * （`SourceGroupFilter` 的 sg-menu 弹层）**两副面孔**，高度也参差
 * （用户 `#280`：「统一组件高度，统一弹出列表样式」）。
 * 现在引擎/类型下拉统一用本组件，弹层样式与 `sg-menu` **逐值一致**（圆角/行高/计数徽章）。
 *
 * ## 约定
 * - 「全部」行由**调用方**放进 `options` 第一项（各页的 all 值不同：搜索页 `'all'`、其余 `''`）；
 * - 计数徽章随项显示，调用方保证「计数 = 选中该项后列表条数」（本仓铁律：计数与过滤同池）。
 *
 * ⚠️ class 名 `fd-*` 是 `#280` 探针（probe-280）的断言选择器，改名等于剪掉回归网。
 */
export interface FilterOption {
  /** 选中值 */
  value: string;
  /** 展示文案 */
  label: string;
  /** 该项命中数（徽章） */
  count: number;
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 选中值（= 命中的 `options[].value`） */
    modelValue?: string;
    /** 可选项（含调用方放置的「全部」行） */
    options: FilterOption[];
    /** 按钮文案前缀（如「引擎」「类型」）——空则只显示当前项 */
    label?: string;
    /** 空列表提示 */
    emptyText?: string;
    /** `#281` 纵向排列场景满宽（宽度 = 分组筛选组件；横向工具栏场景不给即保持 auto） */
    full?: boolean;
  }>(),
  { modelValue: '', label: '', emptyText: '暂无可选项', full: false },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'change', v: string): void;
}>();

const open = ref(false);
const active = computed(() => props.options.find((o) => o.value === props.modelValue));
const activeLabel = computed(() => active.value?.label ?? props.modelValue);

function pick(v: string): void {
  open.value = false;
  if (v === props.modelValue) return;
  emit('update:modelValue', v);
  emit('change', v);
}

/** 点组件外面收起（与 SourceGroupFilter 同判据） */
function onDocClick(e: MouseEvent): void {
  if (!open.value) return;
  if ((e.target as HTMLElement | null)?.closest('.fd-wrap')) return;
  open.value = false;
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div class="fd-wrap" :class="{ full }">
    <button
      class="fd-btn" :class="{ open }" type="button"
      :title="`${label || '筛选'}：${activeLabel}（点击切换）`"
      @click.stop="open = !open"
    >
      <span v-if="label" class="fd-tag">{{ label }}</span>
      <span class="fd-text">{{ activeLabel }}</span>
      <em v-if="active" class="fd-n">{{ active.count }}</em>
      <span class="fd-caret">▾</span>
    </button>
    <ul v-if="open" class="fd-menu">
      <li
        v-for="o in options" :key="o.value"
        :class="{ on: o.value === modelValue }"
        @click="pick(o.value)"
      >
        <span class="nm" :title="o.label">{{ o.label }}</span>
        <em>{{ o.count }}</em>
      </li>
      <li v-if="!options.length" class="fd-none">{{ emptyText }}</li>
    </ul>
  </div>
</template>

<style scoped>
/* 弹层样式与 SourceGroupFilter 的 .sg-menu **逐值一致**（#280 统一弹出列表样式）；
   按钮高度 32px 与 .sg-btn / 各页筛选输入框统一（#280 统一组件高度）。 */
.fd-wrap { position: relative; flex: none; }
/* `#281` 纵向排列场景（书院发现页/规则工坊左栏）：满宽 = 分组筛选组件（sg-btn width:100% 无上限） */
.fd-wrap.full { flex: 1 1 100%; width: 100%; }
.fd-wrap.full .fd-btn { width: 100%; max-width: none; }
.fd-btn {
  height: 32px; display: flex; align-items: center; gap: 6px;
  padding: 0 10px; border-radius: 8px; font-size: 12px;
  background: var(--bg3, var(--bg-3)); color: var(--text);
  border: 1px solid var(--line, var(--border));
  cursor: pointer; font-family: var(--font); max-width: 200px;
  /* `#284` 回归修正（用户 2026-10-05）：fd-text 加 flex:1 撑满后，继承了祖先的
     text-align:center 就显形了（引擎/类型名居中）。与 SourceGroupFilter 的 .sg-btn
     同一道保险：显式 text-align:left（sg-btn 一直有，所以分组组件没这毛病）。 */
  text-align: left;
}
.fd-btn.open { border-color: var(--acc-dim); filter: brightness(1.08); }
.fd-tag { color: var(--muted); flex-shrink: 0; }
/* `#284` 计数与箭头**居右**：文字占满中间（与 SourceGroupFilter 的 .sg-text flex:1 同一套，
   分组组件本来就是数字+箭头贴右，引擎/类型对齐它） */
.fd-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd-caret { font-size: 10px; opacity: 0.75; flex-shrink: 0; }
.fd-n {
  font-style: normal; font-family: var(--mono); font-size: 10.5px; flex-shrink: 0;
  color: var(--muted); background: var(--bg-3); border-radius: 999px; padding: 1px 7px;
}
.fd-menu {
  position: absolute; left: 0; top: calc(100% + 4px); z-index: 40;
  min-width: 180px; max-width: 280px; max-height: 330px; overflow: auto;
  margin: 0; padding: 4px; list-style: none; border-radius: 9px;
  background: var(--bg-2); border: 1px solid var(--border-strong);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
}
.fd-menu li {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 9px; border-radius: 7px; font-size: 12.5px;
  color: var(--text-1); cursor: pointer; white-space: nowrap;
}
.fd-menu li:hover { background: var(--bg-3); }
.fd-menu li.on { background: var(--brand-soft); color: #fff; }
.fd-menu li .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fd-menu li em {
  font-style: normal; font-family: var(--mono); font-size: 10.5px;
  color: var(--muted); background: var(--bg-3); border-radius: 999px; padding: 1px 7px;
}
.fd-menu li.on em { background: rgba(255, 255, 255, 0.15); color: #fff; }
.fd-menu li.fd-none { justify-content: center; color: var(--muted); cursor: default; }
.fd-menu li.fd-none:hover { background: transparent; }
</style>
