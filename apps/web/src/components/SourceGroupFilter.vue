<script lang="ts">
/**
 * 源分组下拉（「▣书源 · 全部书源」按钮 + 弹层）—— **三个页面共用这一份**。
 *
 * 来历：2026-09-26 用户实测 ①-3 把「▣书源 433」单标签改成下拉式分组筛选（发现页左栏）；
 * 2026-09-28 用户要求规则工坊也加上（「书院发现页，左侧源列表上方已有实现」）⇒ 提取共用，
 * 而不是抄第二份。
 *
 * ⚠️ **class 名原样保留**（`.sg-wrap` / `.sg-btn` / `.sg-menu` / `.sg-none` / `.kc-n` …）：
 * 既有探针（`probe-ui-foundation.mjs` / `probe-discover-toc.mjs`）按这些选择器断言，
 * 改名等于把回归网剪掉。
 */
export interface GroupOption {
  /** 选中值（可能是 `SOURCE_GROUP_UNGROUPED`，见 `source-groups.ts`） */
  name: string;
  /** 展示文案 */
  label: string;
  /** 计数 */
  count: number;
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 选中值（`''` = 全部分组） */
    modelValue?: string;
    /** 可选分组（由调用方用 `sourceGroupOptions(pool, …)` 算好） */
    options: GroupOption[];
    /** 「全部分组」那一行显示的计数（= 池子大小） */
    allCount: number;
    /** 按钮上的角标计数（= 当前筛完后的条数） */
    shownCount?: number;
    /** 按钮文案前缀（如「书源」/「源」） */
    label?: string;
    /** 空列表提示（默认「该类型暂无分组」） */
    emptyText?: string;
  }>(),
  { modelValue: '', shownCount: 0, label: '源', emptyText: '该类型暂无分组' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  /** 选完之后（调用方要做的副作用，如「把选中项调进可视区」） */
  (e: 'change', v: string): void;
}>();

const open = ref(false);
const activeLabel = computed(() => {
  const g = props.modelValue;
  if (!g) return '全部分组';
  return props.options.find((o) => o.name === g)?.label ?? g;
});

function pick(name: string): void {
  open.value = false;
  if (name === props.modelValue) return;
  emit('update:modelValue', name);
  emit('change', name);
}

/** 点组件外面收起（用 `closest` 判，避免给每个 li 都挂监听） */
function onDocClick(e: MouseEvent): void {
  if (!open.value) return;
  if ((e.target as HTMLElement | null)?.closest('.sg-wrap')) return;
  open.value = false;
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div class="sg-wrap">
    <button
      class="sg-btn" :class="{ open }"
      :title="`${label} · ${activeLabel}（点击切换分组）`"
      @click.stop="open = !open"
    >
      <span class="kc-ico">▣</span>
      <span class="sg-text">{{ label }} · {{ activeLabel }}</span>
      <em class="kc-n">{{ shownCount }}</em>
      <span class="sg-caret">▾</span>
    </button>
    <ul v-if="open" class="sg-menu">
      <li :class="{ on: !modelValue }" @click="pick('')">
        <span class="nm">全部分组</span><em>{{ allCount }}</em>
      </li>
      <li
        v-for="g in options" :key="g.name"
        :class="{ on: modelValue === g.name }"
        @click="pick(g.name)"
      >
        <span class="nm" :title="g.label">{{ g.label }}</span>
        <em>{{ g.count }}</em>
      </li>
      <li v-if="!options.length" class="sg-none">{{ emptyText }}</li>
    </ul>
  </div>
</template>

<style scoped>
.sg-wrap { position: relative; margin-bottom: 10px; }
.sg-btn {
  /* `#280` 统一组件高度：32px（与 FilterDropdown .fd-btn / 各页筛选输入框一致）；
     左栏场景的 margin-bottom 由本组件兜底，工具栏场景由调用方覆盖为 0 */
  width: 100%; height: 32px; display: flex; align-items: center; gap: 6px;
  padding: 0 10px; border-radius: 8px; font-size: 12.5px;
  background: var(--brand-soft); border: 1px solid var(--brand); color: #fff;
  cursor: pointer; font-family: var(--font); text-align: left;
}
.sg-btn.open { filter: brightness(1.1); }
.sg-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-caret { font-size: 10px; opacity: 0.85; flex-shrink: 0; }
.kc-ico { font-size: 13px; flex-shrink: 0; }
.kc-n {
  font-style: normal; font-size: 10px; flex-shrink: 0;
  background: rgba(255, 255, 255, 0.15); color: #fff;
  border-radius: 999px; padding: 1px 6px;
}
.sg-menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 30;
  max-height: 330px; overflow: auto; margin: 0; padding: 4px;
  list-style: none; border-radius: 9px;
  background: var(--bg-2); border: 1px solid var(--border-strong);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
}
.sg-menu li {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 9px; border-radius: 7px; font-size: 12.5px;
  color: var(--text-1); cursor: pointer;
}
.sg-menu li:hover { background: var(--bg-3); }
.sg-menu li.on { background: var(--brand-soft); color: #fff; }
.sg-menu li .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-menu li em {
  font-style: normal; font-family: var(--mono); font-size: 10.5px;
  color: var(--muted); background: var(--bg-3); border-radius: 999px; padding: 1px 7px;
}
.sg-menu li.on em { background: rgba(255, 255, 255, 0.15); color: #fff; }
.sg-menu li.sg-none { justify-content: center; color: var(--muted); cursor: default; }
.sg-menu li.sg-none:hover { background: transparent; }
</style>
