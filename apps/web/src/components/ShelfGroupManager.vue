<script setup lang="ts">
/**
 * ShelfGroupManager —— **分组管理浮层**（用户实测 ①-1）。
 *
 * 用户要求的动作，逐条落地：
 *   · **新建** → {@link GroupEditDialog}（名称 + 组内排序）
 *   · **排序（分组排序）** → 每行 ↑ / ↓ 调整分组在左栏的先后（写回 `order`）
 *   · **编辑** → 同一个对话框，多一个「在左栏显示」**滑块**（`show` 显示/隐藏分组）
 *   · 另加**删除**（用户没列，但管理页没有删除不成立）：两步确认，
 *     并同时从每本书上清掉该分组的位（照 Legado `delGroup`，见 reader store 注释）
 *
 * 数据来自 `stores/reader.ts`（字段与语义照 Legado `BookGroup`，见 `shelf-groups.ts`）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { bookSortLabel, SHELF_GROUP_MAX, type ShelfGroup } from '../shelf-groups';
import { useReaderStore } from '../stores/reader';
import GroupEditDialog from './GroupEditDialog.vue';

const emit = defineEmits<{ close: [] }>();
const reader = useReaderStore();

/** 当前打开的对话框：新建 / 编辑 */
const editing = ref<{ mode: 'create' | 'edit'; group?: ShelfGroup } | null>(null);
/** 待确认删除的分组 id（两步确认：不用 window.confirm —— 无头浏览器里它恒返回 false，测不了） */
const confirmingDelete = ref<number | null>(null);

function onCreate(p: { groupName: string; bookSort: number }): void {
  reader.createGroup(p.groupName, p.bookSort);
  editing.value = null;
}
function onEdit(p: { groupName: string; bookSort: number }): void {
  const g = editing.value?.group;
  // ⚠️ 只更新名称与组内排序：`show`（显示/隐藏）现在由列表里每行右侧的**滑块**负责，
  // 这里不要把它带进来，否则会覆盖掉滑块刚切的开关（见 GroupEditDialog 头注）。
  if (g) reader.updateGroup(g.groupId, p);
  editing.value = null;
}
function doDelete(groupId: number): void {
  reader.deleteGroup(groupId);
  confirmingDelete.value = null;
}

/**
 * Esc：**一次只关最上面那层**。本浮层里可能再叠 `GroupEditDialog`，
 * 所以有对话框开着时本层不动（让下面那个组件自己的 Esc 生效）。
 */
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (editing.value) return;
  if (confirmingDelete.value !== null) {
    confirmingDelete.value = null;
    e.preventDefault();
    return;
  }
  e.preventDefault();
  emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="sgm-mask" @click.self="emit('close')">
    <div class="sgm-panel">
      <div class="sgm-head">
        <strong>分组管理</strong>
        <span class="sgm-sub">
          共 {{ reader.groupsSorted.length }} 个分组 · 上限 {{ SHELF_GROUP_MAX }} ·
          书架 {{ reader.bookShelf.length }} 本（未分组 {{ reader.ungroupedCount }}）
        </span>
        <span style="flex: 1"></span>
        <button class="btn mini" @click="emit('close')">✕</button>
      </div>

      <div class="sgm-toolbar">
        <button class="btn mini primary" @click="editing = { mode: 'create' }">＋ 新建分组</button>
        <span class="sgm-tip">↑↓ 调整分组顺序；「编辑」改名称与组内书籍排序；右侧滑块控制是否在左栏显示</span>
      </div>

      <div class="sgm-body">
        <div v-if="!reader.groupsSorted.length" class="sgm-empty">
          还没有分组。点「＋ 新建分组」建一个（例如：在看 / 网文 / 工具书）。
        </div>
        <div v-for="(g, i) in reader.groupsSorted" :key="g.groupId" class="sgm-row">
          <div class="sgm-order">
            <button class="sgm-arrow" :disabled="i === 0" title="上移" @click="reader.moveGroup(g.groupId, -1)">↑</button>
            <button
              class="sgm-arrow" :disabled="i === reader.groupsSorted.length - 1" title="下移"
              @click="reader.moveGroup(g.groupId, 1)"
            >↓</button>
          </div>
          <div class="sgm-main">
            <div class="sgm-name">
              {{ g.groupName }}
              <span class="tag acc">{{ bookSortLabel(g.bookSort) }}</span>
              <span v-if="!g.show" class="tag">已隐藏</span>
            </div>
            <div class="sgm-meta">{{ reader.groupBookCount(g.groupId) }} 本 · 排序值 {{ g.order }}</div>
          </div>
          <template v-if="confirmingDelete === g.groupId">
            <span class="sgm-warn">删除该分组？（不会删书）</span>
            <button class="btn mini danger" @click="doDelete(g.groupId)">确定删除</button>
            <button class="btn mini" @click="confirmingDelete = null">取消</button>
          </template>
          <template v-else>
            <button class="btn mini" @click="editing = { mode: 'edit', group: g }">编辑</button>
            <button class="btn mini" @click="confirmingDelete = g.groupId">删除</button>
          </template>
          <!-- 滑块：是否在**左侧分组列表**显示（用户 2026-09-26 要求；原在编辑对话框里的滑块移到这儿）
               只影响左栏的列出，分组与里面的书都还在；关掉后仍可正常往里放书（下拉里会标「已隐藏」） -->
          <button
            class="sgm-switch" :class="{ on: g.show }" role="switch" :aria-checked="g.show"
            :title="g.show ? '在左侧分组列表中显示 —— 点击隐藏' : '已从左侧分组列表隐藏 —— 点击显示'"
            @click="reader.updateGroup(g.groupId, { show: !g.show })"
          >
            <span class="sgm-knob"></span>
          </button>
        </div>
      </div>

      <div class="sgm-foot">
        <button class="btn mini" @click="emit('close')">关闭</button>
      </div>
    </div>

    <GroupEditDialog
      v-if="editing?.mode === 'create'"
      title="新建分组"
      @submit="onCreate"
      @close="editing = null"
    />
    <GroupEditDialog
      v-else-if="editing?.mode === 'edit'"
      title="编辑分组"
      :group="editing.group ?? null"
      @submit="onEdit"
      @close="editing = null"
    />
  </div>
</template>

<style scoped>
.sgm-mask {
  position: fixed; inset: 0; z-index: 1020;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 6vh 16px;
}
.sgm-panel {
  width: min(620px, 100%); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow);
  animation: fadein 0.16s ease;
}
.sgm-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  padding: 12px 14px; border-bottom: 1px solid var(--border);
  color: var(--text-0); font-size: 14px;
}
.sgm-sub { font-size: 11.5px; color: var(--muted); }
.sgm-toolbar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--border);
}
.sgm-tip { font-size: 11px; color: var(--faint); }
.sgm-body { flex: 1; min-height: 0; overflow: auto; padding: 6px 10px 10px; }
.sgm-empty { padding: 34px 12px; text-align: center; color: var(--muted); font-size: 12.5px; }
.sgm-row {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 6px; border-bottom: 1px solid var(--border);
}
.sgm-row:last-child { border-bottom: 0; }
.sgm-order { display: flex; flex-direction: column; gap: 2px; flex: none; }
.sgm-arrow {
  width: 22px; height: 16px; line-height: 1; padding: 0;
  border: 1px solid var(--line); border-radius: 5px;
  background: var(--bg-3); color: var(--text-1); font-size: 10px; cursor: pointer;
}
.sgm-arrow:disabled { opacity: 0.35; cursor: default; }
.sgm-main { flex: 1; min-width: 0; }
.sgm-name { font-size: 13px; font-weight: 600; color: var(--text-0); display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sgm-meta { font-size: 11px; color: var(--faint); margin-top: 2px; font-family: var(--mono); }
.sgm-warn { font-size: 12px; color: var(--orange); }
/* 显示/隐藏滑块（开关形态：点击整块即切换）。
   ⚠️ 用 `<button>` + 两个 span 手写，不用 `<input type="range">` ——
   后者在 Vue 里 `v-model` **不会自动转数字**（字符串 "0" 是真值），且拖动语义不适合开关。 */
.sgm-switch {
  flex: none; width: 36px; height: 20px; border-radius: 999px; padding: 2px;
  border: 1px solid var(--line); background: var(--bg-3); cursor: pointer;
  display: inline-flex; align-items: center; transition: background 0.16s, border-color 0.16s;
}
.sgm-switch .sgm-knob {
  width: 14px; height: 14px; border-radius: 50%; background: var(--muted);
  transition: transform 0.16s, background 0.16s;
}
.sgm-switch.on { background: var(--brand-soft); border-color: var(--brand); }
.sgm-switch.on .sgm-knob { background: var(--brand); transform: translateX(16px); }
.sgm-foot { display: flex; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid var(--border); }
</style>
