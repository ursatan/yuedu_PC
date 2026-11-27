<script setup lang="ts">
/**
 * **高亮规则管理对话框** —— `#262`（上游 `HighlightRuleActivity` 的 Web 承载；
 * 入口 = 阅读界面「更多 → 高亮规则」，对齐上游 `ReaderMenuItem.menu_highlight_rule`）。
 *
 * ## 能力（对齐上游管理页）
 * 列表（order 升序）/ 启用开关 / 编辑 / 删除 / **导入**（上游 `ImportHighlightRuleViewModel`
 * 的文件格式 + NEW/UPDATE/EXISTING 三态统计，合并走 `mergeImportedHighlightRules` 同一实现）/
 * **导出**（上游 `HighlightRuleFile` 格式：`{type:'highlightRule', rules:[...]}`）。
 * 排序调整（上游有置顶/拖拽）：规则量小、order 语义是「全量重编」⇒ 本期不做拖拽，只做
 * 上移/下移（直接换 sortOrder 相邻值），后续要拖拽再补。
 *
 * ## 为什么导入在**前端**解析
 * 上游导入统计要与**本地库**比对（NEW/UPDATE/EXISTING）⇒ 前端已有全量列表最方便；
 * 服务器不再加一个 import-preview 端点（与净化规则的 `#266` 路径不同：那边的判重权威
 * 在前端 store，这里直接复用 core 的 `parseHighlightRuleImport` 纯函数）。
 */
import { computed, onMounted, ref } from 'vue';
import {
  HIGHLIGHT_RULE_FILE_TYPE,
  emptyHighlightRule,
  mergeImportedHighlightRules,
  parseHighlightRuleImport,
  type HighlightRule,
  type HighlightRuleImportItem,
} from '@yuedu/core/contract';
import { useHighlightRulesStore } from '../stores/highlight-rules';
import HighlightRuleEditDialog from './HighlightRuleEditDialog.vue';

const emit = defineEmits<{ close: [] }>();
const store = useHighlightRulesStore();

const editOpen = ref(false);
const editDraft = ref<HighlightRule | null>(null);
const creating = ref(false);
const importOpen = ref(false);
const importText = ref('');
const importError = ref('');
const importItems = ref<HighlightRuleImportItem[]>([]);
const importPicked = ref<Set<string>>(new Set());
const toastMsg = ref('');

onMounted(() => void store.refresh());

function toast(msg: string): void {
  toastMsg.value = msg;
  void setTimeout(() => { if (toastMsg.value === msg) toastMsg.value = ''; }, 2600);
}

function openCreate(): void {
  editDraft.value = emptyHighlightRule(Date.now());
  creating.value = true;
  editOpen.value = true;
}
function openEdit(r: HighlightRule): void {
  editDraft.value = { ...r };
  creating.value = false;
  editOpen.value = true;
}
async function onSave(r: HighlightRule): Promise<void> {
  const err = await store.save(r);
  if (err) { toast(err); return; }
  editOpen.value = false;
  toast('已保存规则');
}

/** 上移/下移：与相邻一条**交换 sortOrder**（order 语义是全量槽位，两两交换不影响其它行） */
async function move(r: HighlightRule, dir: -1 | 1): Promise<void> {
  const list = store.rules;
  const i = list.findIndex((x) => x.id === r.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j];
  await store.save({ ...r, order: other.order });
  await store.save({ ...other, order: r.order });
}

/* ---------------- 导入 / 导出 ---------------- */

/** 解析导入文本（**不写库**）：严格校验 + 与本地库三态比对（core 纯函数） */
function previewImport(): void {
  importError.value = '';
  const r = parseHighlightRuleImport(importText.value, store.rules);
  if (!r.ok) {
    importItems.value = [];
    importError.value = r.error ?? '解析失败';
    return;
  }
  importItems.value = r.items;
  importPicked.value = new Set(r.items.map((it) => it.rule.uuid));
}

/** 提交导入：只写勾中的；**合并实现与生效一致**（core `mergeImportedHighlightRules`，order 全量重编） */
async function commitImport(): Promise<void> {
  const picked = importItems.value.filter((it) => importPicked.value.has(it.rule.uuid));
  if (!picked.length) return;
  const merged = mergeImportedHighlightRules(store.rules, picked.map((it) => it.rule));
  // 只把「变了」的写回（新增 + 内容有更新的）；order 重编后全量对齐本地视图
  let n = 0;
  for (const m of merged) {
    const before = store.rules.find((x) => x.uuid.toLowerCase() === m.uuid.toLowerCase());
    const changed = !before || JSON.stringify({ ...before, order: 0 }) !== JSON.stringify({ ...m, order: 0 });
    if (changed) {
      const err = await store.save({ ...m, id: before?.id ?? Date.now() + n });
      if (err) { toast(err); return; }
      n += 1;
    }
  }
  // order 重编：把最终顺序写回（未被改内容的也要拿新 order）
  const after = mergeImportedHighlightRules(store.rules, []);
  for (let i = 0; i < after.length; i += 1) {
    const cur = store.rules.find((x) => x.uuid.toLowerCase() === after[i].uuid.toLowerCase());
    if (cur && cur.order !== i) await store.save({ ...cur, order: i });
  }
  importOpen.value = false;
  importText.value = '';
  importItems.value = [];
  toast(`已导入 ${picked.length} 条规则`);
}

/** 导出（上游 HighlightRuleFile 格式；剪贴板 + 下载各给一条路） */
async function exportRules(): Promise<void> {
  const payload = JSON.stringify(
    { type: HIGHLIGHT_RULE_FILE_TYPE, rules: store.rules.map((r) => ({ ...r })) },
    null,
    2,
  );
  try {
    await navigator.clipboard.writeText(payload);
    toast(`已复制 ${store.rules.length} 条规则到剪贴板`);
  } catch {
    const blob = new Blob([payload], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'highlight-rules.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已下载 highlight-rules.json');
  }
}

const stats = computed(() => ({
  total: store.rules.length,
  enabled: store.rules.filter((r) => r.isEnabled).length,
}));
</script>

<template>
  <div class="hr-mask" data-hr-mgr @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="hr-mgr" role="dialog" aria-modal="true">
      <div class="hr-mgr-head">
        <strong>高亮规则</strong>
        <span class="hr-count" data-hr-mgr-count>{{ stats.enabled }}/{{ stats.total }} 启用</span>
        <span style="flex: 1"></span>
        <button class="btn mini" data-hr-mgr-import @click="importOpen = true; importItems = []; importError = ''">导入</button>
        <button class="btn mini" data-hr-mgr-export @click="exportRules">导出</button>
        <button class="btn mini primary" data-hr-mgr-new @click="openCreate">＋ 新建</button>
        <button class="btn mini" data-hr-mgr-close @click="emit('close')">关闭</button>
      </div>

      <div class="hr-mgr-body">
        <p v-if="!store.rules.length" class="hr-empty">
          还没有规则。高亮规则按「匹配内容」自动高亮命中的文字（不需要手动划选）——
          点「＋ 新建」造一条，或点「导入」把 Legado 导出的规则文件贴进来。
        </p>
        <div
          v-for="(r, i) in store.rules" :key="r.id"
          class="hr-row" :class="{ off: !r.isEnabled }"
          :data-hr-row="r.name || r.pattern"
        >
          <input
            type="checkbox" class="hr-sw" :checked="r.isEnabled" :data-hr-sw="r.id"
            title="启用 / 停用" @change="store.toggle(r.id)"
          />
          <span class="hr-name" :title="r.pattern" @click="openEdit(r)">{{ r.name || r.pattern }}</span>
          <span v-if="r.scope" class="hr-scope" :title="'生效范围：' + r.scope">范围</span>
          <span class="hr-bits">
            <em v-if="r.isRegex" class="bit">正则</em>
            <em v-if="r.applyToTitle" class="bit">标题</em>
            <em v-if="!r.applyToBody" class="bit">不正文</em>
          </span>
          <span class="hr-ops">
            <button class="mini-btn" :disabled="i === 0" title="上移" @click="move(r, -1)">↑</button>
            <button class="mini-btn" :disabled="i === store.rules.length - 1" title="下移" @click="move(r, 1)">↓</button>
            <button class="mini-btn" title="编辑" @click="openEdit(r)">编辑</button>
            <button class="mini-btn danger" title="删除" @click="store.remove(r.id)">删除</button>
          </span>
        </div>
      </div>

      <!-- 导入预览（不写库；确认才提交） -->
      <div v-if="importOpen" class="hr-imp-mask" @click.self="importOpen = false">
        <div class="hr-imp">
          <div class="hr-imp-head">
            <strong>导入高亮规则</strong>
            <span style="flex: 1"></span>
            <button class="btn mini" @click="importOpen = false">关闭</button>
          </div>
          <div class="hr-imp-body">
            <label>粘贴规则 JSON（Legado 导出格式：<code>{"type":"highlightRule","rules":[…]}</code>）</label>
            <textarea v-model="importText" rows="8" data-hr-imp-text placeholder='{"type":"highlightRule","rules":[…]}'></textarea>
            <button class="btn mini" data-hr-imp-parse @click="previewImport">解析预览</button>
            <p v-if="importError" class="hr-warn" data-hr-imp-error>{{ importError }}</p>
            <template v-if="importItems.length">
              <div class="hr-imp-stats" data-hr-imp-stats>
                新增 {{ importItems.filter((x) => x.status === 'new').length }} ·
                更新 {{ importItems.filter((x) => x.status === 'update').length }} ·
                相同 {{ importItems.filter((x) => x.status === 'existing').length }}
              </div>
              <label v-for="it in importItems" :key="it.rule.uuid" class="hr-imp-row" :data-hr-imp-item="it.status">
                <input type="checkbox" :checked="importPicked.has(it.rule.uuid)" @change="importPicked.has(it.rule.uuid) ? importPicked.delete(it.rule.uuid) : importPicked.add(it.rule.uuid)" />
                <span class="hr-imp-st">{{ it.status === 'new' ? '新增' : it.status === 'update' ? '更新' : '相同' }}</span>
                <span>{{ it.rule.name || it.rule.pattern }}</span>
              </label>
              <div class="hr-imp-btns">
                <button class="btn mini primary" :disabled="importPicked.size === 0" data-hr-imp-commit @click="commitImport">
                  导入 {{ importPicked.size }} 条
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 编辑器（新建/编辑共用；探针 #262 B2 抓过：状态在、模板忘挂 ⇒ 按钮是死的） -->
      <HighlightRuleEditDialog
        v-if="editOpen && editDraft"
        :rule="editDraft" :creating="creating"
        @close="editOpen = false"
        @save="onSave"
      />

      <div v-if="toastMsg" class="hr-toast" data-hr-toast>{{ toastMsg }}</div>
    </div>
  </div>
</template>

<style scoped>
.hr-mask {
  position: fixed; inset: 0; z-index: 1200; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px;
}
.hr-mgr {
  width: min(640px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.hr-mgr-head {
  display: flex; align-items: center; gap: 8px; padding: 12px 16px;
  border-bottom: 1px solid var(--border); flex-wrap: wrap;
}
.hr-mgr-head strong { font-size: 15px; color: var(--text-0); }
.hr-count { font-size: 12px; color: var(--muted); }
.hr-mgr-body { padding: 10px 16px 16px; overflow: auto; }
.hr-empty { font-size: 12.5px; color: var(--muted); line-height: 1.7; }
.hr-row {
  display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px;
  border: 1px solid var(--border); margin-bottom: 6px; background: var(--bg-2);
}
.hr-row.off { opacity: 0.55; }
.hr-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--text-0); cursor: pointer; }
.hr-scope { font-size: 10.5px; color: var(--muted); background: var(--bg-3); border-radius: 999px; padding: 1px 7px; flex-shrink: 0; }
.hr-bits { display: flex; gap: 4px; flex-shrink: 0; }
.hr-bits .bit { font-style: normal; font-size: 10.5px; color: var(--muted); background: var(--bg-3); border-radius: 999px; padding: 1px 6px; }
.hr-ops { display: flex; gap: 4px; flex-shrink: 0; }
.mini-btn {
  background: var(--bg-3); color: var(--text-1); border: 1px solid var(--border);
  border-radius: 6px; padding: 2px 7px; font-size: 11px; cursor: pointer;
}
.mini-btn.danger { color: var(--danger, #e53935); }
.mini-btn:disabled { opacity: 0.4; cursor: default; }
.hr-warn { font-size: 12px; color: var(--warning); margin: 8px 0 0; }
.hr-toast {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  background: var(--bg-3); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 6px 14px; font-size: 12.5px; box-shadow: var(--shadow);
}
.hr-imp-mask {
  position: fixed; inset: 0; z-index: 1250; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px;
}
.hr-imp {
  width: min(560px, 94vw); max-height: 80vh; overflow: auto;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.hr-imp-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.hr-imp-head strong { font-size: 14.5px; color: var(--text-0); }
.hr-imp-body { padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 8px; }
.hr-imp-body label { font-size: 12px; color: var(--text-1); }
.hr-imp-body textarea {
  background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 8px; font-family: var(--mono); font-size: 12px; resize: vertical;
}
.hr-imp-body .btn { align-self: flex-start; }
.hr-imp-stats { font-size: 12px; color: var(--text-1); }
.hr-imp-row { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--text-0); }
.hr-imp-st { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--bg-3); color: var(--muted); flex-shrink: 0; }
.hr-imp-row[data-hr-imp-item='new'] .hr-imp-st { color: var(--success); }
.hr-imp-row[data-hr-imp-item='update'] .hr-imp-st { color: var(--warning); }
.hr-imp-btns { display: flex; justify-content: flex-end; }
</style>
