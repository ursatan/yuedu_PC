<script lang="ts">
/**
 * 分类条「功能组件区」的数据形态（与 CategoryScroller 的 CatOption 同源，见其定义）。
 * 这里只用得到 `label/value/rawLabel/kind/chars/default/action/layout`。
 */
export interface ToolbarOption {
  /** 渲染用文案（可能被调用方做过装饰清理） */
  label: string;
  /** 引擎给的原始 `ExploreKind.title` —— 交互值读写 infoMap 必须用它 */
  rawLabel?: string;
  value?: string;
  kind?: string;
  layout?: { flexGrow?: number; flexBasisPercent?: number };
  chars?: string[];
  default?: string;
  action?: string;
}
/** 一个「分组」（Legado exploreKinds 里 url 为空的纯标题 = 分组标题，其后的 url 项归它） */
export interface ToolbarGroup {
  /** 分组标题（空串 = 源里没有分组标题，全部子分类同属一组） */
  title: string;
  /** 该组下的子分类数量（用于 chip 上的角标） */
  count: number;
}
</script>

<script setup lang="ts">
/**
 * CatToolbar —— 发现页「**功能组件区**」（2026-09-23，用户实测 ① 的重构）。
 *
 * 分工（对照参考实现的语义，见 `docs/02-交接文档.md` §4.2 类Q/类AJ）：
 *   · **功能组件区（本组件）**：Legado `ExploreKind` 的交互型控件（select / toggle / text / button）
 *     **＋ 纯标题型分组标题**（`url` 为空且非交互型）提升上来的「分组选择器」。
 *   · **分类条（CategoryScroller）**：只显示**当前分组下**的 url 型子分类。
 *
 * 为什么要分离：部分源的 `exploreUrl` 会产出 100+ 个分类（🏷七猫[官方]v3.1 实测 50 项、
 * 其中 41 个 url 项；四合一 33 项 / 3 个分组标题）。全部平铺在一条横滚里既点不准也看不出层次。
 * 分成「组件 + 分组」后：交互控件横排一行，分组标题点一下就把分类条切成那一组，
 * 每个分组内的分类数落在十几到几十个，配合横滚与全量下拉即可用。
 *
 * ⚠️ **两个「不」**：
 *   ① 点击分组标题**不重跑源脚本**（子分类本来就在同一次 explore 结果里，纯前端分组）；
 *      真正会触发重算的是交互控件改值（Combo `input` 事件 → 引擎 infoMap → 重跑 exploreUrl）。
 *   ② 交互控件读写 `inputs` 必须用 **`rawLabel`**（引擎 infoMap 的键 = `ExploreKind.title` 原文），
 *      用渲染用的 `label` 会在做过装饰清理的源上对不上 → 显示旧值。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 交互型分类（select/toggle/text/button） */
    interactives: ToolbarOption[];
    /** 分组列表（含每个分组的子分类数量） */
    groups: ToolbarGroup[];
    /** 当前分组下标 */
    activeGroup: number;
    /** 交互输入态（Legado infoMap）：控件名 → 当前值 */
    inputs?: Record<string, string>;
    /** 重算中（禁用重算按钮） */
    loading?: boolean;
    /** 是否显示「重算分类」手动兜底按钮 */
    showRecompute?: boolean;
  }>(),
  { inputs: () => ({}), loading: false, showRecompute: true },
);

const emit = defineEmits<{
  /** 交互输入变更（select/toggle/text）——回传引擎持久化（Legado infoMap） */
  (e: 'input', p: { name: string; value: string; action?: string }): void;
  /** button 型被点击（Legado ExploreKind.action） */
  (e: 'action', p: ToolbarOption): void;
  /** 切换分组（纯前端过滤，不发请求） */
  (e: 'pick-group', idx: number): void;
  /** 手动重算分类（保留交互输入态重跑 exploreUrl） */
  (e: 'recompute'): void;
}>();

/** infoMap 键：优先原始 name（`label` 可能被调用方清理过装饰符） */
function inputKey(c: ToolbarOption): string {
  return c.rawLabel ?? c.label;
}
/** 交互输入态当前值（Legado infoMap[name]；未设置时用 default / chars[0]） */
function inputValue(c: ToolbarOption): string {
  return props.inputs?.[inputKey(c)] ?? c.default ?? c.chars?.[0] ?? '';
}
/** Legado FlexChildStyle → 控件最小宽度（0.6 → 关键字框更宽；0.25 → 窄） */
function ctrlStyle(c: ToolbarOption): Record<string, string> {
  const pct = c.layout?.flexBasisPercent;
  if (pct == null) return {};
  if (pct >= 0.6) return { minWidth: '190px', flex: '1 1 190px' };
  if (pct >= 0.4) return { minWidth: '112px' };
  if (pct >= 0.25) return { minWidth: '96px' };
  return {};
}
function onToggle(c: ToolbarOption) {
  const chars = c.chars?.length ? c.chars : [inputValue(c)];
  const cur = inputValue(c);
  const next = chars[(Math.max(0, chars.indexOf(cur)) + 1) % chars.length] ?? chars[0] ?? '';
  emit('input', { name: inputKey(c), value: next, ...(c.action ? { action: c.action } : {}) });
}
function onSelect(c: ToolbarOption, ev: Event) {
  emit('input', { name: inputKey(c), value: (ev.target as HTMLSelectElement).value, ...(c.action ? { action: c.action } : {}) });
}
function onTextInput(c: ToolbarOption, ev: Event) {
  const v = (ev.target as HTMLInputElement).value ?? '';
  if (v !== inputValue(c)) emit('input', { name: inputKey(c), value: v, ...(c.action ? { action: c.action } : {}) });
}
/** 有分组标题时才渲染分组选择器（只有一个分组 = 源没分组，不占位置） */
const showGroups = computed(() => props.groups.length > 1);
</script>

<template>
  <div class="cat-toolbar card" :class="{ compact: !interactives.length && !showGroups }">
    <!-- 交互型控件（Legado ExploreKind: select / toggle / text / button） -->
    <template v-for="c in interactives" :key="'ctl-' + inputKey(c)">
      <select
        v-if="c.kind === 'select'"
        class="tb-chip tb-select"
        :style="ctrlStyle(c)"
        :value="inputValue(c)"
        :title="`${inputKey(c)}：${(c.chars ?? []).join(' / ')}`"
        @change="onSelect(c, $event)"
      >
        <option v-for="ch in (c.chars ?? [])" :key="ch" :value="ch">{{ ch }}</option>
      </select>
      <div
        v-else-if="c.kind === 'toggle'"
        class="tb-chip tb-toggle"
        :style="ctrlStyle(c)"
        :title="`${inputKey(c)}（点击切换：${(c.chars ?? []).join(' / ')}）`"
        @click="onToggle(c)"
      >{{ inputValue(c) }}</div>
      <input
        v-else-if="c.kind === 'text'"
        class="tb-chip tb-text"
        :style="ctrlStyle(c)"
        :value="inputValue(c)"
        :placeholder="c.label"
        :title="inputKey(c)"
        @change="onTextInput(c, $event)"
        @keyup.enter="onTextInput(c, $event)"
      />
      <button
        v-else-if="c.kind === 'button'"
        type="button"
        class="tb-chip tb-btn"
        :style="ctrlStyle(c)"
        :title="c.action ? `动作：${c.action}` : '动作按钮'"
        @click="emit('action', c)"
      >{{ c.label }}</button>
    </template>

    <!-- 分组选择器：**纯标题型分组标题提升到这里**（点击 → 分类条加载该组子分类） -->
    <div v-if="showGroups" class="tb-groups" role="tablist">
      <button
        v-for="(g, i) in groups"
        :key="'grp-' + (g.title || i)"
        type="button"
        class="tb-chip tb-group"
        :class="{ on: i === activeGroup }"
        role="tab"
        :aria-selected="i === activeGroup"
        :title="`${g.title || '全部'}（${g.count} 个分类）`"
        @click="emit('pick-group', i)"
      >
        {{ g.title || '全部' }}<em>{{ g.count }}</em>
      </button>
    </div>

    <!-- 手动兜底：交互控件改值会自动重算，这里给一个显式入口（保留交互输入态） -->
    <button
      v-if="showRecompute && interactives.length"
      type="button"
      class="tb-chip tb-recompute"
      :disabled="loading"
      title="保留当前交互筛选，重跑源的 exploreUrl 脚本重算分类（Legado java.refreshExplore 等价）"
      @click="emit('recompute')"
    >{{ loading ? '⟳ 重算中…' : '↻ 重算分类' }}</button>
  </div>
</template>

<style scoped>
.cat-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  margin-bottom: 10px;
  border-radius: 12px;
  background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
  border: 1px solid var(--border);
}
.cat-toolbar.compact { display: none; }

.tb-chip {
  flex-shrink: 0;
  padding: 6px 13px;
  border-radius: 9px;
  font-size: 13px;
  color: var(--text-1);
  background: var(--bg-3);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  transition: all 150ms ease;
  font-family: inherit;
}
.tb-chip:hover { color: var(--text-0); border-color: rgba(79, 140, 255, 0.5); }

/* 交互型控件 */
.tb-select {
  appearance: none;
  padding-right: 26px;
  background-image: linear-gradient(45deg, transparent 50%, var(--text-1) 50%), linear-gradient(135deg, var(--text-1) 50%, transparent 50%);
  background-position: calc(100% - 14px) 55%, calc(100% - 9px) 55%;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  background-color: var(--bg-3);
}
.tb-select option { background: var(--bg-1); color: var(--text-0); }
.tb-toggle { font-weight: 600; }
.tb-text {
  outline: none;
  cursor: text;
  background: var(--bg-2);
}
.tb-text:focus { border-color: rgba(79, 140, 255, 0.55); box-shadow: 0 0 0 2px rgba(79, 140, 255, 0.18); }
.tb-btn {
  background: linear-gradient(135deg, rgba(79, 140, 255, 0.22), rgba(160, 112, 255, 0.22));
  border-color: rgba(79, 140, 255, 0.45);
  color: #fff;
  font-weight: 600;
}
.tb-btn:hover { border-color: rgba(79, 140, 255, 0.8); }

/* 分组选择器（纯标题类提升上来的） */
.tb-groups {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-left: 2px;
  padding-left: 12px;
  border-left: 1px dashed var(--border-strong);
}
.tb-group { font-weight: 700; letter-spacing: 0.2px; }
.tb-group.on {
  background: linear-gradient(135deg, rgba(79, 140, 255, 0.28), rgba(160, 112, 255, 0.28));
  border-color: rgba(79, 140, 255, 0.6);
  color: #fff;
}
.tb-group em {
  font-style: normal;
  font-size: 10.5px;
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: inherit;
  opacity: 0.85;
}

.tb-recompute { margin-left: auto; font-size: 12.5px; color: var(--muted); }
.tb-recompute:disabled { opacity: 0.55; cursor: default; }
</style>
