<script setup lang="ts">
/**
 * **源回收站**对话框（`#269` 建立，`#645` 重做）。
 *
 * 样式与交互对齐 `ImportSourcesDialog`（导入源）：独立浮层 + `.dlg-head / .dlg-body / .dlg-foot`
 * 三段式，而不是内嵌在设置行里的临时浮层。
 *
 * ## `#645` 为什么重做（用户实测：「删掉的源没进回收站，恢复入口也没了」）
 *  · 旧版只对**文件源**记墓碑；用户源（界面导入的）删除即从覆盖层丢条目 —— raw 没了 ⇒ 真没了。
 *  · 旧版入口按钮 `v-if="removedIds.length"` ⇒ 列表一空，整个入口消失。
 * 现在服务端把两种源都放进 `trash`（用户源连 `raw` 一起存），本对话框读 `st.trashItems`，
 * 入口按钮**永远显示**（`SourceManagerView`）。
 *
 * ## 三个动作的语义（必须在界面上说清）
 *  · **恢复所选**：文件源 = 出栈 + 重扫目录；用户源 = 用服务端存的 `raw` 重新入库。
 *  · **恢复全部**：所有条目都恢复。
 *  · **永久删除所选**：用户源 `raw` 从此丢弃（不可恢复）；文件源**文件不删**，只是不再出现在
 *    回收站、也不再被扫描加载（要真删文件请去磁盘上删）。
 */
import { computed, ref } from 'vue';
import { useSourcesStore } from '../stores/sources';

const emit = defineEmits<{ (e: 'close'): void; (e: 'restored', n: number): void }>();
const st = useSourcesStore();

const items = computed(() => st.trashItems);

/** 勾选的 id（默认全选 —— 多数场景就是要全恢复） */
const checked = ref<Set<string>>(new Set(items.value.map((t) => t.id)));
const busy = ref(false);

const allChecked = computed(() => items.value.length > 0 && items.value.every((t) => checked.value.has(t.id)));
const someChecked = computed(() => items.value.some((t) => checked.value.has(t.id)));
function toggleAll(): void {
  checked.value = allChecked.value ? new Set() : new Set(items.value.map((t) => t.id));
}
function invert(): void {
  const s = new Set<string>();
  for (const t of items.value) if (!checked.value.has(t.id)) s.add(t.id);
  checked.value = s;
}

function toggle(id: string): void {
  const s = new Set(checked.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  checked.value = s;
}

const fmtTime = (ts: number): string =>
  ts > 0 ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

async function restoreSelected(): Promise<void> {
  const ids = [...checked.value];
  if (!ids.length) return;
  busy.value = true;
  try {
    const n = await st.doRestoreRemoved(ids);
    emit('restored', n);
  } finally {
    busy.value = false;
  }
}

async function restoreAll(): Promise<void> {
  if (!items.value.length) return;
  busy.value = true;
  try {
    const n = await st.doClearRemoved();
    emit('restored', n);
  } finally {
    busy.value = false;
  }
}

async function purgeSelected(): Promise<void> {
  const ids = [...checked.value];
  if (!ids.length) return;
  const names = items.value.filter((t) => checked.value.has(t.id)).map((t) => t.name ?? t.id);
  if (!confirm(`永久删除 ${ids.length} 个源？\n\n${names.slice(0, 8).join('、')}${names.length > 8 ? ' …' : ''}\n\n· 用户导入的源：配置（raw）从此丢弃，不可恢复\n· 磁盘文件源：文件不删，只是不再加载、不再出现在回收站`)) return;
  busy.value = true;
  try {
    await st.doPurgeRemoved(ids);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>🗑 源回收站</b>
        <span class="sub">删除的源都进这里（用户源连配置一起存），随时可恢复</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <div class="dlg-body">
        <div class="row">
          <label class="rr-all" title="第一次点击＝全选；再点一次＝全部取消">
            <input
              type="checkbox" class="restore-checkbox" data-restore-all
              :checked="allChecked"
              :indeterminate.prop="someChecked && !allChecked"
              @change="toggleAll"
            />
            <span>全选</span>
          </label>
          <button class="btn sm" data-restore-invert @click="invert">反选</button>
          <span class="hint">已选 {{ checked.size }} / 共 {{ items.length }} 条</span>
        </div>

        <div class="tbl-wrap">
          <!-- ★ 只在 checkbox 上绑事件：label 自带「点击文字 ⇒ 触发内部 checkbox」的行为，
               两处都绑会**触发两次**（取消又勾回）—— 探针 V3 实测抓到。 -->
          <label v-for="t in items" :key="t.id" class="rs-row">
            <input type="checkbox" class="restore-check" :value="t.id" :checked="checked.has(t.id)" @change="toggle(t.id)" />
            <span class="nm" :title="t.id">{{ t.name || t.id }}</span>
            <span class="tag" :class="t.fileBacked ? 'tag-file' : 'tag-user'">{{ t.fileBacked ? '文件源' : '用户源' }}</span>
            <span v-if="!t.fileBacked && !t.hasRaw" class="tag tag-warn" title="删除于旧版本，配置未保存，无法恢复">无法恢复</span>
            <span class="when">{{ fmtTime(t.deletedAt) }}</span>
          </label>
          <div v-if="!items.length" class="empty">
            回收站是空的 —— 删除的源会出现在这里（包括界面导入的「用户源」）。
          </div>
        </div>

        <div class="note">
          · <b>恢复</b>：文件源重新扫描磁盘文件；用户源用服务端保存的配置重新入库（删除时清掉的登录/缓存**不**还原）。<br />
          · <b>永久删除</b>：用户源配置从此丢弃；文件源文件不删，只是不再加载。
        </div>
      </div>

      <div class="dlg-foot">
        <button class="btn sm danger" :disabled="busy || !checked.size" @click="purgeSelected">永久删除所选</button>
        <span style="flex: 1"></span>
        <button class="btn sm ghost" @click="emit('close')">取消</button>
        <button class="btn sm" :disabled="busy || !items.length" @click="restoreAll">恢复全部</button>
        <button
          class="btn sm primary" data-restore-commit
          :disabled="busy || checked.size === 0" @click="restoreSelected"
        >{{ busy ? '⟳ 处理中…' : `恢复所选 ${checked.size} 个` }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 6vh 16px; overflow: auto;
}
.dlg { width: min(680px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px;
}
.dlg-head .sub { color: var(--muted); font-size: 12px; }
.dlg-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dlg-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--border);
}
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--muted); }
.note {
  font-size: 11.5px; line-height: 1.7; color: var(--muted);
  border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg-0);
}
.rr-all { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; font-size: 12px; color: var(--text-1); }
.tbl-wrap { max-height: 300px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.rs-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12px;
}
.rs-row:hover { background: var(--bg-2); }
.nm { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { flex: none; color: var(--muted); font-size: 11px; }
.tag {
  flex: none; font-size: 10.5px; line-height: 1; padding: 3px 6px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted);
}
.tag-file { color: var(--text-1); }
.tag-warn { color: #b45309; border-color: #f59e0b66; }
.empty { padding: 18px 10px; text-align: center; color: var(--muted); font-size: 12px; }
.restore-check, .restore-checkbox { accent-color: var(--brand, #6366f1); cursor: pointer; }
</style>
