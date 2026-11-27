<script setup lang="ts">
/**
 * 书内备注（Legado `BookMemo`）。
 *
 * 入口：书籍详情页标题栏「📝 备注」。备注存在服务端（`book_memos` 表），
 * 随书进入两份备份：本仓完整备份直接带；Legado 兼容备份写 `bookMemo.json`。
 *
 * 与书签/划线的区别：备注是用户自己写的文字，可以只写标题/正文而不摘录原文。
 */
import { computed, onMounted, ref } from 'vue';
import { deleteBookMemo, getBookMemos, saveBookMemo, type BookMemo } from '../api';
import { toast } from '../toast';

const props = defineProps<{
  bookUrl: string;
  bookName: string;
  bookAuthor: string;
}>();
const emit = defineEmits<{ close: [] }>();

const list = ref<BookMemo[]>([]);
const loading = ref(false);
const editing = ref<BookMemo | null>(null);
const busy = ref(false);
const error = ref('');

const canSave = computed(() => !!editing.value
  && (editing.value.title.trim() || editing.value.content.trim() || editing.value.bookText.trim()));

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    list.value = await getBookMemos(props.bookUrl);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(() => void load());

function openNew(): void {
  editing.value = {
    time: Date.now(),
    bookUrl: props.bookUrl,
    bookName: props.bookName,
    bookAuthor: props.bookAuthor,
    chapterIndex: 0,
    chapterPos: 0,
    chapterName: '',
    bookText: '',
    title: '',
    content: '',
  };
}

function openEdit(m: BookMemo): void {
  editing.value = { ...m };
}

async function doSave(): Promise<void> {
  if (!editing.value || !canSave.value) return;
  busy.value = true;
  try {
    await saveBookMemo({
      ...editing.value,
      title: editing.value.title.trim(),
      content: editing.value.content.trim(),
      bookText: editing.value.bookText.trim(),
    });
    editing.value = null;
    await load();
    toast('已保存备注', 'ok');
  } catch (e) {
    toast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error');
  } finally {
    busy.value = false;
  }
}

async function doDelete(m: BookMemo): Promise<void> {
  if (!window.confirm('删除这条备注？')) return;
  try {
    await deleteBookMemo(m.time);
    await load();
    toast('已删除备注', 'ok');
  } catch (e) {
    toast('删除失败：' + (e instanceof Error ? e.message : String(e)), 'error');
  }
}

function fmtTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}
</script>

<template>
  <div class="bm-mask" data-bm-dlg @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="bm-panel" role="dialog" aria-modal="true">
      <div class="bm-head">
        <strong>书内备注</strong>
        <span class="bm-book">{{ bookName }}<template v-if="bookAuthor"> · {{ bookAuthor }}</template></span>
        <span style="flex: 1"></span>
        <button class="btn mini primary" data-bm-new @click="openNew">＋ 新建</button>
        <button class="btn mini" data-bm-close @click="emit('close')">关闭</button>
      </div>

      <div class="bm-body">
        <p v-if="loading" class="bm-hint">加载中…</p>
        <p v-else-if="error" class="bm-err" data-bm-err>{{ error }}</p>
        <p v-else-if="!list.length" class="bm-hint" data-bm-empty>还没有备注。点「＋ 新建」写一条书评或摘抄。</p>
        <div v-for="m in list" :key="m.time" class="bm-item" :data-bm-item="m.time">
          <div class="bm-item-head">
            <b>{{ m.title || '（未命名备注）' }}</b>
            <span class="bm-time">{{ fmtTime(m.time) }}<template v-if="m.chapterName"> · {{ m.chapterName }}</template></span>
            <span style="flex: 1"></span>
            <button class="mini-btn" @click="openEdit(m)">编辑</button>
            <button class="mini-btn danger" @click="doDelete(m)">删除</button>
          </div>
          <blockquote v-if="m.bookText" class="bm-quote">{{ m.bookText }}</blockquote>
          <p v-if="m.content" class="bm-content">{{ m.content }}</p>
        </div>
      </div>

      <div v-if="editing" class="bm-edit" data-bm-edit>
        <div class="bm-edit-head">
          <b>{{ list.some((x) => x.time === editing!.time) ? '编辑备注' : '新建备注' }}</b>
          <span style="flex: 1"></span>
          <button class="btn mini" :disabled="busy" @click="editing = null">取消</button>
        </div>
        <label class="bm-lab">标题<input v-model="editing.title" class="ops-input" data-bm-title placeholder="例如：第 3 章伏笔" /></label>
        <label class="bm-lab">摘录<textarea v-model="editing.bookText" rows="2" data-bm-text placeholder="可留空"></textarea></label>
        <label class="bm-lab">备注<textarea v-model="editing.content" rows="5" data-bm-content placeholder="写点什么…"></textarea></label>
        <div class="bm-edit-foot">
          <button class="btn sm primary" :disabled="busy || !canSave" data-bm-save @click="doSave">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bm-mask {
  position: fixed; inset: 0; z-index: 240;
  background: rgba(0, 0, 0, .5); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.bm-panel {
  width: min(640px, 94vw); max-height: min(760px, 90vh); overflow: auto;
  background: var(--bg-1, #fff); color: var(--text-1, #222);
  border: 1px solid var(--border, #ddd); border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, .35);
}
.bm-head, .bm-edit-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border, #ddd); }
.bm-book { color: var(--muted, #888); font-size: 12px; }
.bm-body { padding: 6px 14px 12px; }
.bm-hint { color: var(--muted, #888); font-size: 12.5px; padding: 12px 0; }
.bm-err { color: var(--red, #d9534f); font-size: 12.5px; }
.bm-item { border-bottom: 1px dashed var(--border, #ddd); padding: 10px 0; }
.bm-item-head { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
.bm-time { color: var(--muted, #888); font-size: 11.5px; }
.bm-quote { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid var(--orange, #e0a030); background: var(--bg-0, #f7f7f7); color: var(--muted, #666); font-size: 12px; white-space: pre-wrap; }
.bm-content { margin: 6px 0 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
.bm-edit { padding: 0 14px 14px; }
.bm-edit-head { margin: 0 -14px; }
.bm-lab { display: block; margin-top: 10px; font-size: 12px; color: var(--muted, #888); }
.bm-lab input, .bm-lab textarea { display: block; width: 100%; margin-top: 4px; font-size: 13px; }
.bm-edit-foot { display: flex; justify-content: flex-end; margin-top: 10px; }
</style>
