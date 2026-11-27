<script setup lang="ts">
/**
 * `B21` 源订阅（远程书源订阅）—— **地址簿 + 强制预览入口**。
 *
 * 设计口径（用户拍板）：
 *  - 「更新」不做静默覆盖：点更新 ⇒ 关闭本浮层、用该订阅的 URL 打开**同一个**
 *    `ImportSourcesDialog` ⇒ 抓取 → 预览（新增 / 可更新 / 重复都看得见）→ 勾选 → 确认。
 *    预览/确认交互与「源管理 → 导入源」完全同一套，不另造第二套。
 *  - 可新增的条目同样出现在预览的「新增」区，默认勾选；可更新条目在「更新」区，默认勾选。
 *  - 这里**不缓存源内容**、不做后台轮询：只记 URL，避免“后台悄悄改源”。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  getSourceSubscriptions, putSourceSubscriptions,
  type SourceSubFormat, type SourceSubscription,
} from '../api';

const emit = defineEmits<{
  (e: 'close'): void;
  /** 请求父级用该订阅的 URL 打开「导入源」强制预览 */
  (e: 'refresh', sub: SourceSubscription): void;
}>();

const FORMATS: Array<{ v: SourceSubFormat; label: string }> = [
  { v: 'auto', label: '自动识别' },
  { v: 'legado', label: 'Legado 书源' },
  { v: 'maccms', label: 'CMS 影视源' },
];
const items = ref<SourceSubscription[]>([]);
const loading = ref(true);
const saving = ref(false);
const err = ref('');
const name = ref('');
const url = ref('');
const format = ref<SourceSubFormat>('auto');
/** 正在编辑的订阅 id；空 = 新增模式 */
const editingId = ref('');

function resetForm(): void {
  name.value = '';
  url.value = '';
  format.value = 'auto';
  editingId.value = '';
}

async function load(): Promise<void> {
  loading.value = true;
  err.value = '';
  try {
    items.value = await getSourceSubscriptions();
  } catch (e) {
    err.value = `订阅列表加载失败：${e instanceof Error ? e.message : e}`;
  } finally {
    loading.value = false;
  }
}

async function persist(next: SourceSubscription[], okMsg: string): Promise<boolean> {
  saving.value = true;
  err.value = '';
  try {
    items.value = await putSourceSubscriptions(next);
    if (okMsg) err.value = '';
    return true;
  } catch (e) {
    err.value = `${okMsg || '保存'}失败：${e instanceof Error ? e.message : e}`;
    return false;
  } finally {
    saving.value = false;
  }
}

function formError(): string {
  const u = url.value.trim();
  if (!u) return '请填写订阅地址';
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '订阅地址必须是 http/https';
  } catch {
    return '订阅地址不是合法 URL';
  }
  if (items.value.some((s) => s.url === u && s.id !== editingId.value)) return '这条订阅地址已经存在';
  return '';
}

async function save(): Promise<void> {
  const bad = formError();
  if (bad) {
    err.value = bad;
    return;
  }
  const u = url.value.trim();
  const editing = items.value.find((s) => s.id === editingId.value);
  const next = editingId.value
    ? items.value.map((s) => (s.id === editingId.value
      ? { ...s, name: name.value.trim() || s.name, url: u, format: format.value }
      : s))
    : [
        ...items.value,
        {
          id: '', name: name.value.trim(), url: u, format: format.value,
          createdAt: Date.now(), updatedAt: 0,
        },
      ];
  if (await persist(next, editingId.value ? '保存' : '添加')) resetForm();
}

function startEdit(s: SourceSubscription): void {
  editingId.value = s.id;
  name.value = s.name;
  url.value = s.url;
  format.value = s.format;
  err.value = '';
}

async function remove(s: SourceSubscription): Promise<void> {
  if (!confirm(`删除订阅「${s.name || s.url}」？\n\n只删地址簿记录，已导入的源不受影响。`)) return;
  await persist(items.value.filter((x) => x.id !== s.id), '删除');
  if (editingId.value === s.id) resetForm();
}

function refresh(s: SourceSubscription): void {
  emit('refresh', s);
}

function fmtTime(ts: number): string {
  if (!ts) return '从未确认更新';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => {
  void load();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>📡 源订阅</b>
        <span class="sub">更新前强制预览：新增与可更新条目都先看得到</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>
      <div class="dlg-body">
        <p class="hint">
          记住远程源列表地址；点「更新（预览）」会用该地址打开「导入源」的抓取 → 预览 → 勾选 → 确认流程。
          预览里能同时看到<b>可新增</b>和<b>可更新</b>的条目，确认前不会写入任何源。
        </p>

        <div class="form">
          <div class="row">
            <span class="lab">订阅地址</span>
            <input v-model="url" class="inp" placeholder="https://example.com/sources.json" data-sub-url />
          </div>
          <div class="row">
            <span class="lab">名称</span>
            <input v-model="name" class="inp" placeholder="可空（默认取地址末段）" data-sub-name />
            <span class="lab" style="min-width: auto">格式</span>
            <div class="chips">
              <button
                v-for="f in FORMATS" :key="f.v" type="button" class="chip" :class="{ on: format === f.v }"
                @click="format = f.v"
              >{{ f.label }}</button>
            </div>
          </div>
          <div class="row">
            <span class="lab" />
            <button class="btn sm primary" :disabled="saving" data-sub-save @click="save">
              {{ editingId ? '保存修改' : '＋ 添加订阅' }}
            </button>
            <button v-if="editingId" class="btn sm ghost" @click="resetForm">取消编辑</button>
          </div>
        </div>

        <div v-if="err" class="err">{{ err }}</div>
        <div v-if="loading" class="hint">⟳ 加载订阅…</div>
        <div v-else-if="!items.length" class="empty">
          还没有订阅。粘贴远程源列表地址，添加后就能在更新时先预览再确认。
        </div>
        <ul v-else class="subs">
          <li v-for="s in items" :key="s.id" class="sub-item" :data-sub-id="s.id">
            <div class="sub-main">
              <div class="sub-top">
                <b class="sub-name">{{ s.name }}</b>
                <span class="tag">{{ s.format === 'auto' ? '自动识别' : s.format === 'legado' ? 'Legado' : 'CMS' }}</span>
              </div>
              <div class="sub-url" :title="s.url">{{ s.url }}</div>
              <div class="sub-time">最近确认更新：{{ fmtTime(s.updatedAt) }}</div>
            </div>
            <div class="sub-ops">
              <button class="btn mini primary" :disabled="saving" data-sub-refresh @click="refresh(s)">更新（预览）</button>
              <button class="btn mini ghost" :disabled="saving" @click="startEdit(s)">编辑</button>
              <button class="btn mini ghost" :disabled="saving" @click="remove(s)">删除</button>
            </div>
          </li>
        </ul>
      </div>
      <div class="dlg-foot">
        <button class="btn sm ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 1400;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 6vh 16px; overflow: auto;
}
.dlg { width: min(720px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px;
}
.dlg-head .sub { color: var(--muted); font-size: 12px; }
.dlg-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.hint { font-size: 11.5px; color: var(--muted); line-height: 1.7; margin: 0; }
.err { font-size: 12px; color: #ff8a8a; line-height: 1.7; }
.empty {
  border: 1px dashed var(--border-strong); border-radius: 10px;
  padding: 22px 16px; text-align: center; color: var(--muted); font-size: 12.5px; line-height: 1.7;
}
.form { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg-0); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
.lab { font-size: 12px; color: var(--muted); min-width: 62px; }
.inp {
  flex: 1; min-width: 220px; background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; outline: none;
}
.inp:focus { border-color: var(--acc-dim); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  padding: 4px 10px; font-size: 12px; border-radius: 999px;
  background: var(--bg-2); color: var(--text-1); border: 1px solid var(--border); cursor: pointer;
}
.chip:hover { border-color: var(--acc-dim); color: var(--text); }
.chip.on { background: rgba(108, 124, 255, 0.16); border-color: var(--acc-dim); color: #fff; }
.subs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.sub-item {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; background: var(--bg-0);
}
.sub-main { flex: 1; min-width: 0; }
.sub-top { display: flex; align-items: center; gap: 8px; }
.sub-name { font-size: 13px; }
.sub-url { font-family: var(--mono); font-size: 11px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; margin-top: 2px; }
.sub-time { font-size: 11px; color: var(--muted); margin-top: 3px; }
.sub-ops { display: flex; gap: 6px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.tag {
  flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px;
  color: var(--acc); border: 1px solid var(--acc-dim);
}
</style>
