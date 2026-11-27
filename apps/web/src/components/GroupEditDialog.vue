<script setup lang="ts">
/**
 * GroupEditDialog —— **新建 / 编辑书架分组**的对话框。
 *
 * 用户实测 ① 要求三处**共用同一个对话框**：
 *   · ①-1 分组管理 → 「新建」「编辑」
 *   · ①-2 书架左栏底部 → 「新建分组」
 *   · ①-3 「加入书架」→ 「新建分组」
 * 所以它只做「收集字段 + 校验」，不碰存储（调用方拿 `submit` 去建/改）。
 *
 * 字段与取值范围全部来自 `shelf-groups.ts`（照 Legado `BookGroup` 契约）：
 * `groupName` / `bookSort`。
 *
 * ⚠️ 2026-09-26 用户调整：**移除本对话框的「在左栏显示/隐藏」滑块** ——
 * 显示/隐藏改到**分组管理列表里每行删除按钮右侧的滑块**上（见 `ShelfGroupManager.vue`），
 * 那里更直接（一目了然看到每个分组当前是否显示，点一下就切）。
 * 所以本对话框**不再产出 `show`**，调用方更新分组时也不会碰到这个字段。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { BOOK_SORT_OPTIONS, type ShelfGroup } from '../shelf-groups';

const props = defineProps<{
  /** 对话框标题，如「新建分组」/「编辑分组」 */
  title: string;
  /** 编辑时传入；新建时不给 */
  group?: ShelfGroup | null;
}>();

const emit = defineEmits<{
  submit: [{ groupName: string; bookSort: number }];
  close: [];
}>();

const name = ref(props.group?.groupName ?? '');
const bookSort = ref(props.group ? props.group.bookSort : -1);
const err = ref('');

function submit(): void {
  const n = name.value.trim();
  if (!n) {
    err.value = '分组名称不能为空';
    return;
  }
  emit('submit', { groupName: n, bookSort: bookSort.value });
}

/** Esc 关自己（一次 Esc 只做一件事；父级浮层各自有闸门，见 ShelfGroupManager） */
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="ged-mask" @click.self="emit('close')">
    <div class="ged-panel">
      <div class="ged-head">
        <strong>{{ title }}</strong>
        <span style="flex: 1"></span>
        <button class="btn mini" @click="emit('close')">✕</button>
      </div>
      <div class="ged-body">
        <label class="ged-row">
          <span class="ged-label">分组名称</span>
          <input
            v-model="name" class="ged-input" placeholder="例如：在看 / 网文 / 工具书"
            maxlength="24" @keyup.enter="submit"
          />
        </label>
        <label class="ged-row">
          <span class="ged-label">组内书籍排序</span>
          <select v-model.number="bookSort" class="ged-input">
            <option v-for="o in BOOK_SORT_OPTIONS" :key="o.value" :value="o.value" :title="o.hint">
              {{ o.label }}
            </option>
          </select>
        </label>
        <div class="ged-hint">
          {{ BOOK_SORT_OPTIONS.find((o) => o.value === bookSort)?.hint }}
        </div>
        <div v-if="err" class="err-text ged-err">{{ err }}</div>
      </div>
      <div class="ged-foot">
        <button class="btn mini" @click="emit('close')">取消</button>
        <button class="btn mini primary" @click="submit">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ged-mask {
  position: fixed; inset: 0; z-index: 1030;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.ged-panel {
  width: min(420px, 100%);
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow);
  animation: fadein 0.16s ease;
}
.ged-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px; border-bottom: 1px solid var(--border);
  color: var(--text-0); font-size: 14px;
}
.ged-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.ged-row { display: flex; align-items: center; gap: 10px; }
.ged-label { width: 84px; flex: none; font-size: 12.5px; color: var(--muted); }
.ged-input {
  flex: 1; min-width: 0; padding: 7px 9px; border-radius: 8px;
  background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0);
  font-family: var(--font); font-size: 12.5px; outline: none;
}
.ged-input:focus { border-color: var(--acc-dim); }
.ged-hint { font-size: 11px; color: var(--faint); padding-left: 94px; line-height: 1.5; }
.ged-err { margin: 0; }
.ged-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 11px 14px; border-top: 1px solid var(--border);
}
</style>
