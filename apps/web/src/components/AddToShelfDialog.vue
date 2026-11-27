<script setup lang="ts">
/**
 * AddToShelfDialog —— **加入书架 / 修改分组**的对话框（用户实测 ①-3）。
 *
 * 形态（严格按用户列的字段）：
 *   · 现有分组**下拉列表**选择（含「未分组」）
 *   · 「＋ 新建分组」→ 就地展开：分组名称输入框 + 排序下拉框 + 「新建」按钮，
 *     **新建成功后下拉自动选中它**（用户明确要求）
 *   · 底部：取消 / 确认加入；右上角：关闭
 *   · `#extra` 具名插槽：调用方在「分组选择」**之上**插入自己的内容（`#214` 用它放
 *     「选择本地书籍」的文件选择器）—— 组件本身**仍然只管选一个 groupId**，
 *     不 import 任何本地书相关的类型/函数。
 *
 * 分组数据与语义见 `shelf-groups.ts`；这里只负责「选一个 groupId」，
 * 真正把书放进分组由调用方在 `confirm` 里做（阅读浮层走 `addToShelf`，
 * 书架卡片走 `setBookGroup`）—— 避免这个组件知道两种上下文。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { BOOK_SORT_OPTIONS } from '../shelf-groups';
import { useReaderStore } from '../stores/reader';

const props = defineProps<{
  /** 对话框标题，如「加入书架」/「修改分组」 */
  title: string;
  /** 预选分组：`0` = 未分组；已在某分组时传它的 groupId */
  initialGroupId?: number;
  /** 主按钮文案 */
  confirmText?: string;
  /** 书的标题（副标题位置显示，避免对话框脱离上下文） */
  bookTitle?: string;
}>();

const emit = defineEmits<{
  confirm: [groupId: number];
  close: [];
}>();

const reader = useReaderStore();
const selected = ref<number>(props.initialGroupId ?? 0);
/** 新建分组表单展开态 */
const creating = ref(false);
const newName = ref('');
const newSort = ref(-1);
const err = ref('');

/** 下拉选项：未分组 + 全部分组（**不按 `show` 过滤** —— 隐藏只影响左栏列出，仍可归入） */
const options = computed(() => [
  { value: 0, label: `未分组（${reader.ungroupedCount}）` },
  ...reader.groupsSorted.map((g) => ({
    value: g.groupId,
    label: `${g.groupName}${g.show ? '' : '（已隐藏）'}（${reader.groupBookCount(g.groupId)}）`,
  })),
]);

/** 新建分组：建完**立刻选中**（用户要求），并收起表单 */
function createAndSelect(): void {
  const n = newName.value.trim();
  if (!n) {
    err.value = '分组名称不能为空';
    return;
  }
  const g = reader.createGroup(n, newSort.value);
  if (!g) {
    err.value = '分组数量已达上限，请先删除不用的分组';
    return;
  }
  err.value = '';
  selected.value = g.groupId;
  creating.value = false;
  newName.value = '';
}

/** Esc 关自己（先收起新建表单，再关对话框 —— 一次 Esc 只做一件事） */
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (creating.value) {
    creating.value = false;
    return;
  }
  emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="ats-mask" @click.self="emit('close')">
    <div class="ats-panel">
      <div class="ats-head">
        <strong>{{ title }}</strong>
        <span class="ats-sub" v-if="bookTitle" :title="bookTitle">{{ bookTitle }}</span>
        <span style="flex: 1"></span>
        <button class="btn mini" @click="emit('close')">✕</button>
      </div>

      <div class="ats-body">
        <!-- 调用方自定义内容（`#214`：导入本地书时放「选择本地书籍」）——放在分组选择之上，
             因为「先挑文件、再决定归到哪个组」才是自然顺序 -->
        <slot name="extra" />

        <label class="ats-row">
          <span class="ats-label">选择分组</span>
          <select v-model.number="selected" class="ats-input">
            <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>

        <button v-if="!creating" class="ats-new" @click="creating = true">＋ 新建分组</button>

        <!-- 新建分组表单（就地展开，不再套一层对话框） -->
        <div v-else class="ats-create">
          <div class="ats-row">
            <span class="ats-label">名称</span>
            <input
              v-model="newName" class="ats-input" placeholder="新分组名称" maxlength="24"
              @keyup.enter="createAndSelect"
            />
          </div>
          <div class="ats-row">
            <span class="ats-label">组内排序</span>
            <select v-model.number="newSort" class="ats-input">
              <option v-for="o in BOOK_SORT_OPTIONS" :key="o.value" :value="o.value" :title="o.hint">
                {{ o.label }}
              </option>
            </select>
          </div>
          <div class="ats-create-foot">
            <button class="btn mini" @click="creating = false">收起</button>
            <button class="btn mini primary" @click="createAndSelect">新建</button>
          </div>
        </div>

        <div v-if="err" class="err-text ats-err">{{ err }}</div>
      </div>

      <div class="ats-foot">
        <button class="btn mini" @click="emit('close')">取消</button>
        <button class="btn mini primary" @click="emit('confirm', selected)">
          {{ confirmText ?? '确认加入' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ats-mask {
  position: fixed; inset: 0; z-index: 1030;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.ats-panel {
  width: min(440px, 100%);
  background: var(--bg-1); border: 1px solid var(--border-strong);
  border-radius: var(--r); box-shadow: var(--shadow);
  animation: fadein 0.16s ease;
}
.ats-head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 14px; border-bottom: 1px solid var(--border);
  color: var(--text-0); font-size: 14px; min-width: 0;
}
.ats-sub { font-size: 11.5px; color: var(--muted); max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ats-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.ats-row { display: flex; align-items: center; gap: 10px; }
.ats-label { width: 62px; flex: none; font-size: 12.5px; color: var(--muted); }
.ats-input {
  flex: 1; min-width: 0; padding: 7px 9px; border-radius: 8px;
  background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0);
  font-family: var(--font); font-size: 12.5px; outline: none;
}
.ats-input:focus { border-color: var(--acc-dim); }
.ats-new {
  align-self: flex-start; padding: 6px 12px; border-radius: 8px;
  border: 1px dashed var(--border-strong); background: transparent;
  color: var(--text-1); font-size: 12px; cursor: pointer; font-family: var(--font);
}
.ats-new:hover { border-color: var(--acc-dim); color: var(--text-0); }
.ats-create {
  border: 1px solid var(--line); border-radius: 9px; padding: 10px;
  background: var(--bg-2); display: flex; flex-direction: column; gap: 8px;
}
.ats-create-foot { display: flex; justify-content: flex-end; gap: 8px; }
.ats-err { margin: 0; }
.ats-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 11px 14px; border-top: 1px solid var(--border);
}
</style>
