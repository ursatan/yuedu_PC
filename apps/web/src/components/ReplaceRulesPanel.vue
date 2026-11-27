<script setup lang="ts">
/**
 * **用户全局净化（替换）规则**管理面板（`#144`）。
 *
 * ## 上游依据
 * 实体 `ReplaceRule.kt:26-65`（契约已对齐，14 字段）；列表页 `ReplaceRuleActivity` +
 * `ReplaceRuleAdapter`；编辑页 `ReplaceRuleEditDialog`。
 *
 * ## 本仓做了什么（**没做的都写明**）
 * ✅ 启停 / 新增 / 编辑 / 删除 / 排序 / 分组 / 作用域 / 正则开关 / 超时；
 * ⏸ **导入导出**（上游有 JSON 导入导出与在线规则订阅）**未做** ——
 *    跨设备已由「服务端同步」覆盖，而在线订阅是另一个功能面，不在这里假装支持。
 * ⏸ `scopeSource`（校正书源内容）与「手动挑选规则」未做（本仓没有源内容编辑界面）。
 *
 * ## 字段说明（界面上必须说清的三件事）
 * ① **作用范围 `scope`**：填**完整书名**或**完整来源名**（SQL 是 `scope LIKE '%'||name||'%'`）
 *    ⇒ 填书名的一部分（「斗破」配《斗破苍穹》）**不会命中**；留空 = 对所有书生效。
 * ② **替换为空**：正文里会真的删掉；但**标题被整条规则清空时保留原标题**（照抄上游）。
 * ③ **`@js:` 替换**（`#257` 起实现）：`replacement` 以 `@js:` 开头时按 **JS 表达式**逐匹配求值
 *    （`result` = 命中文本，另有 `chapter` / `book` / `java`），返回值再按 Java 的组引用语义展开
 *    （`$1` 是分组、`\` 是字面量）。脚本抛错 ⇒ **只跳过这一条**并留痕（不静默）。
 */
import { computed, onMounted, ref } from 'vue';
import type { ReplaceRule } from '@yuedu/core';
import { useReplaceRulesStore } from '../stores/replaceRules';
import { toast } from '../toast';
import ReplaceRuleDialog from './ReplaceRuleDialog.vue';
import ImportReplaceRulesDialog from './ImportReplaceRulesDialog.vue';

const rules = useReplaceRulesStore();
const editing = ref<ReplaceRule | null>(null);
/** 是否「新建」（只影响弹窗标题；`editing` 为 null 时弹窗不渲染 ⇒ 不需要单独的 open 标志） */
const editingIsNew = ref(false);
const filterGroup = ref('');
/** 批量选择的规则 id */
const selectedIds = ref<Set<number>>(new Set());
/** 拷贝/粘贴用的剪贴板缓冲（同浏览器会话内也可用） */
let clipboardBuffer: ReplaceRule[] | null = null;
/** `#266` 导入对话框：`showImport` 开关；`importInitialText` = 「粘贴」按钮带进来的剪贴板原文 */
const showImport = ref(false);
const importInitialText = ref('');

onMounted(() => rules.ensureLoaded());

const shown = computed(() => {
  const g = filterGroup.value.trim();
  const list = rules.sorted;
  return g ? list.filter((r) => (r.group ?? '').trim() === g) : list;
});

const selectedRules = computed(() => rules.sorted.filter((r) => selectedIds.value.has(r.id)));

function toggleSelected(id: number): void {
  const s = new Set(selectedIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selectedIds.value = s;
}
function selectNone(): void {
  selectedIds.value = new Set();
}
function invertSelection(): void {
  const s = new Set<number>();
  for (const r of shown.value) if (!selectedIds.value.has(r.id)) s.add(r.id);
  selectedIds.value = s;
}

/* ---------------- `#253` 【全选】复选框 ----------------
 * 用户 2026-10-04 的要求：「增加【全选】复选框：第一次点击全选所有规则；再次点击取消全部选中」。
 *
 * ★ 为什么必须是**复选框**而不是按钮：复选框能表达**三种状态**（全选 / 半选 / 未选），
 *   按钮只有「点了」这一个动作 ⇒ 用户看不出「当前是不是已经全选」。
 *   半选态用 DOM 属性 `indeterminate`（它不是 attribute，是 property）⇒ 模板里要写
 *   `:indeterminate.prop`，直接写 `:indeterminate` 会被当成 attribute 而不生效。
 *
 * ★ 作用域 = **当前筛选后可见的规则**（`shown`）：按分组筛选时「全选」只选这一组，
 *   符合直觉；而已选集合里可能有被筛掉的旧选择 ⇒ 判「全选」时只看可见的那些。
 */
const shownIds = computed(() => shown.value.map((r) => r.id));
const allShownSelected = computed(
  () => shownIds.value.length > 0 && shownIds.value.every((id) => selectedIds.value.has(id)),
);
const someShownSelected = computed(() => shownIds.value.some((id) => selectedIds.value.has(id)));
/** 第一次点击 = 全选；已经全选时再点 = 取消全部选中 */
function toggleAll(): void {
  selectedIds.value = allShownSelected.value ? new Set() : new Set(shownIds.value);
}

/* ---------------- 拷贝 / 粘贴 / 导入（`#266`） ---------------- */
async function copyRules(): Promise<void> {
  const list = selectedRules.value.length ? selectedRules.value : rules.sorted;
  if (!list.length) {
    toast('没有规则可拷贝', 'warn');
    return;
  }
  const payload = JSON.stringify(list, null, 2);
  clipboardBuffer = list.map((r) => ({ ...r }));
  try {
    await navigator.clipboard.writeText(payload);
    toast(`已拷贝 ${list.length} 条规则`, 'ok');
  } catch {
    toast('已复制到内部缓冲（浏览器未授权剪贴板）', 'info');
  }
}

/**
 * `#266`（用户 2026-10-04）：旧「粘贴」把剪贴板规则**直接增量灌进列表**（一律给新 id、
 * 无重复/错误判断）⇒ 同一批导入两次就是两份（`#259` 实测库里 51 组同名同长度重复）。
 * 现在：读剪贴板 ⇒ 弹**预览对话框**（解析条数、新增/重复/错误），确认后才导入。
 */
async function pasteRules(): Promise<void> {
  let text = '';
  if (clipboardBuffer) {
    text = JSON.stringify(clipboardBuffer, null, 2);
  } else {
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast('浏览器未授权读取剪贴板 —— 可用「导入」粘贴文本', 'warn');
      return;
    }
  }
  if (!text.trim()) {
    toast('剪贴板是空的', 'warn');
    return;
  }
  importInitialText.value = text;
  showImport.value = true;
}

/** 「导入」入口（拷贝按钮前）：粘贴文本 / 上传文件 / 粘贴 URL 三通道，同一套预览确认 */
function openImport(): void {
  importInitialText.value = '';
  showImport.value = true;
}
function onImported(r: { inserted: number; updated: number; skipped: number; failed: number }): void {
  showImport.value = false;
  const parts: string[] = [];
  if (r.inserted) parts.push(`新增 ${r.inserted}`);
  if (r.updated) parts.push(`覆盖 ${r.updated}`);
  if (r.skipped) parts.push(`跳过重复 ${r.skipped}`);
  if (r.failed) parts.push(`错误 ${r.failed}（未导入）`);
  toast(parts.length ? `导入完成：${parts.join(' · ')}` : '没有可导入的规则', r.inserted || r.updated ? 'ok' : 'warn');
}

/* ---------------- 批量操作 ---------------- */
function batchSetEnabled(enabled: boolean): void {
  for (const r of selectedRules.value) rules.upsert({ ...r, isEnabled: enabled });
  toast(enabled ? '已启用所选规则' : '已禁用所选规则', 'ok');
}
function batchAddGroup(): void {
  const g = window.prompt('要添加到的分组名', '');
  if (g === null) return;
  const name = g.trim();
  if (!name) return;
  for (const r of selectedRules.value) rules.upsert({ ...r, group: name });
  toast(`已把 ${selectedRules.value.length} 条规则移入「${name}」`, 'ok');
}
function batchRemoveGroup(): void {
  for (const r of selectedRules.value) rules.upsert({ ...r, group: null });
  toast('已移除所选规则的分组', 'ok');
}
function batchTop(): void {
  const list = rules.sorted;
  const selected = selectedRules.value;
  let order = 1;
  for (const r of selected) rules.upsert({ ...r, order: order++ });
  // 其余规则依次排后面
  const selectedIdsSet = new Set(selected.map((r) => r.id));
  for (const r of list) {
    if (selectedIdsSet.has(r.id)) continue;
    rules.upsert({ ...r, order: order++ });
  }
  toast('已置顶所选规则', 'ok');
}
function batchBottom(): void {
  const list = rules.sorted;
  const selected = selectedRules.value;
  const selectedIdsSet = new Set(selected.map((r) => r.id));
  let order = 1;
  for (const r of list) {
    if (selectedIdsSet.has(r.id)) continue;
    rules.upsert({ ...r, order: order++ });
  }
  for (const r of selected) rules.upsert({ ...r, order: order++ });
  toast('已置底所选规则', 'ok');
}
async function exportSelected(): Promise<void> {
  const list = selectedRules.value;
  if (!list.length) {
    toast('没有选中的规则', 'warn');
    return;
  }
  const payload = JSON.stringify(list, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    toast(`已导出 ${list.length} 条规则到剪贴板`, 'ok');
  } catch {
    toast('导出失败（浏览器未授权剪贴板）', 'warn');
  }
}

function startNew() {
  editing.value = rules.newRule();
  editingIsNew.value = true;
}
function startEdit(r: ReplaceRule) {
  editing.value = { ...r };
  editingIsNew.value = false;
}
function save() {
  if (!editing.value) return;
  const e = editing.value;
  if (!e.pattern) {
    window.alert('「查找内容」不能为空 —— 空规则的 id 会被保留但永不生效');
    return;
  }
  rules.upsert(e);
  editing.value = null;
}
function cancel() {
  editing.value = null;
}
/** 对话框「保存」：它交回的是**副本**，先落到 `editing` 再走同一个 `save()`（校验只此一份） */
function onDialogSave(r: ReplaceRule) {
  editing.value = r;
  save();
}
function remove(r: ReplaceRule) {
  if (!confirm(`删除规则「${r.name || r.pattern}」？`)) return;
  rules.remove(r.id);
}

/** `#271` 批量删除所选（用户 2026-10-04 晚 Add）：一次落盘；确认弹窗点名条数 */
function batchRemoveSelected(): void {
  const n = selectedRules.value.length;
  if (!n) return;
  if (!confirm(`删除所选的 ${n} 条规则？此操作不可撤销。`)) return;
  rules.removeMany([...selectedIds.value]);
  selectedIds.value = new Set();
  toast(`已删除 ${n} 条规则`, 'ok');
}
/** 上移 / 下移：与相邻规则**交换 `order**（上游的排序就是这个字段，SQL `order by sortOrder`） */
function move(r: ReplaceRule, dir: -1 | 1) {
  const list = rules.sorted;
  const i = list.findIndex((x) => x.id === r.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const other = list[j]!;
  rules.upsert({ ...r, order: other.order });
  rules.upsert({ ...other, order: r.order });
}
</script>

<template>
  <div class="rr-panel">
    <div class="rr-head">
      <div class="rr-tip">
        净化规则在**阅读时**应用（缓存里存的仍是原文）⇒ 改完**重新打开该章**即可看到效果。
      </div>
      <div class="rr-actions">
        <select v-model="filterGroup" class="rr-sel" data-rr-group-filter>
          <option value="">全部分组</option>
          <option v-for="g in rules.groupNames" :key="g" :value="g">{{ g }}</option>
        </select>
        <button class="btn sm" data-rr-import @click="openImport">导入</button>
        <button class="btn sm" @click="copyRules">拷贝</button>
        <button class="btn sm" data-rr-paste @click="pasteRules">粘贴</button>
        <button class="btn sm ok" data-rr-new @click="startNew">＋ 新建规则</button>
      </div>
    </div>

    <!--
      `#253` 批量操作条：**常驻一条**（原来「有选中」和「没选中」是两个互斥分支
      ⇒ 一选中就把【全选】【反选】整个藏起来，用户没法继续改选择 —— 这正是用户报的
      「选中多条后找不到全选/反选」）。现在左半是选择操作（常驻），右半是批量操作
      （**选中后才展开**，已有的批量实现全部保留）。
    -->
    <div class="rr-batch">
      <label class="rr-all" title="第一次点击＝全选当前列表；再点一次＝全部取消">
        <input
          type="checkbox" class="rr-check" data-rr-all
          :checked="allShownSelected"
          :indeterminate.prop="someShownSelected && !allShownSelected"
          @change="toggleAll"
        />
        <span>全选</span>
      </label>
      <span class="rr-batch-info">已选 {{ selectedRules.length }} / 共 {{ shown.length }} 条</span>
      <button class="btn sm" data-rr-invert @click="invertSelection">反选</button>
      <button class="btn sm" data-rr-none @click="selectNone" :disabled="!selectedIds.size">清空选择</button>
      <template v-if="selectedRules.length">
        <span class="rr-sep" aria-hidden="true"></span>
        <button class="btn sm" data-rr-en @click="batchSetEnabled(true)">启用所选</button>
        <button class="btn sm" data-rr-dis @click="batchSetEnabled(false)">禁用所选</button>
        <button class="btn sm" @click="batchAddGroup">添加分组</button>
        <button class="btn sm" @click="batchRemoveGroup">移除分组</button>
        <button class="btn sm" @click="batchTop">置顶所选</button>
        <button class="btn sm" @click="batchBottom">置底所选</button>
        <button class="btn sm" data-rr-batch-del @click="batchRemoveSelected">删除所选</button>
        <button class="btn sm" @click="exportSelected">导出所选</button>
      </template>
    </div>

    <div v-if="!shown.length" class="rr-empty">
      还没有净化规则。常见用法：把正文里的「本章未完，请点击下一页」这类**广告/水印**替换成空。
    </div>

    <div
      v-for="r in shown" :key="r.id" class="rr-row"
      :class="{ sel: selectedIds.has(r.id) }"
      :data-rr-row="r.id" :data-rr-on="r.isEnabled ? '1' : '0'"
      title="双击进入编辑"
      @dblclick="startEdit(r)"
    >
      <div class="rr-main">
        <input
          type="checkbox" class="rr-check" :checked="selectedIds.has(r.id)"
          @change="toggleSelected(r.id)"
        />
        <div class="rr-text">
          <b :data-rr-name="r.id">{{ r.name || '(未命名)' }}</b>
          <span v-if="r.group" class="rr-group">{{ r.group }}</span>
          <code class="rr-pat" :data-rr-pattern="r.id">{{ r.pattern }}</code>
          <span class="rr-arrow">→</span>
          <code class="rr-rep">{{ r.replacement === '' ? '（删除）' : r.replacement }}</code>
          <span class="rr-scopes">
            <span class="tag" :class="r.scopeContent ? 'green' : ''">正文</span>
            <span class="tag" :class="r.scopeTitle ? 'green' : ''">标题</span>
            <span v-if="r.scope" class="tag">范围：{{ r.scope }}</span>
            <span v-if="r.excludeScope" class="tag orange">排除：{{ r.excludeScope }}</span>
            <span class="tag">{{ r.isRegex ? '正则' : '文本' }}</span>
          </span>
        </div>
      </div>
      <div class="rr-btns">
        <label class="rr-sw" :title="r.isEnabled ? '停用' : '启用'">
          <input type="checkbox" :checked="r.isEnabled" data-rr-toggle @change="rules.toggle(r.id)" />
          <span class="rr-sw-track"><i class="rr-sw-knob"></i></span>
        </label>
        <button class="btn sm" title="上移" data-rr-up @click="move(r, -1)">↑</button>
        <button class="btn sm" title="下移" data-rr-down @click="move(r, 1)">↓</button>
        <button class="btn sm" data-rr-edit @click="startEdit(r)">编辑</button>
        <button class="btn sm danger" data-rr-del @click="remove(r)">删除</button>
      </div>
    </div>

    <!--
      `#260`：编辑改成**共用对话框**（用户 2026-10-04：「设置-净化界面的规则列表，点击编辑，
      是在列表下方展开编辑区域，修正为替换规则编辑对话框；三处替换规则编辑对话框共用」）。
      原先就地展开有两个实际问题：① 规则多时编辑区在列表**最下方**，点「编辑」后要自己滚下去找；
      ② 与阅读界面那套简化弹窗**字段不一致**（少分组/排除范围/启用/超时）。
    -->
    <ReplaceRuleDialog
      v-if="editing" :rule="editing" :creating="editingIsNew"
      @close="cancel()" @save="onDialogSave"
    />

    <!-- `#266` 导入预览：粘贴按钮把剪贴板原文经 `importInitialText` 带进来直接预览 -->
    <ImportReplaceRulesDialog
      v-if="showImport" :initial-text="importInitialText"
      @close="showImport = false" @imported="onImported"
    />
  </div>
</template>

<style scoped>
.rr-panel { display: flex; flex-direction: column; gap: 8px; }
.rr-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.rr-tip { font-size: 12px; color: var(--fg-3, #94a3b8); }
.rr-actions { display: flex; gap: 6px; align-items: center; }
.rr-sel { background: var(--bg-2, #1e293b); color: var(--fg-1, #e2e8f0); border: 1px solid var(--bd, #334155); border-radius: 6px; padding: 3px 8px; font-size: 12px; }
.rr-empty { font-size: 12px; color: var(--fg-3, #94a3b8); padding: 10px; border: 1px dashed var(--bd, #334155); border-radius: 8px; }
.rr-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; padding: 7px 10px; border: 1px solid var(--bd, #334155); border-radius: 8px; background: var(--bg-1, #0f172a); }
.rr-row[data-rr-on='0'] { opacity: 0.55; }
.rr-main { display: flex; gap: 8px; align-items: center; min-width: 0; }
.rr-sw { display: flex; align-items: center; }
.rr-text { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; font-size: 12px; }
.rr-text b { color: var(--fg-0, #e2e8f0); }
.rr-group { color: var(--fg-3, #94a3b8); }
.rr-pat, .rr-rep { font-family: ui-monospace, monospace; background: var(--bg-2, #1e293b); padding: 1px 6px; border-radius: 4px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rr-arrow { color: var(--fg-3, #94a3b8); }
.rr-scopes { display: flex; gap: 4px; flex-wrap: wrap; }
.rr-btns { display: flex; gap: 4px; flex-shrink: 0; }

/* ── 批量操作条 / 选择 ───────────────────────────────────────── */
.rr-batch {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  padding: 6px 8px; border: 1px dashed var(--bd, #334155); border-radius: 8px;
  background: var(--bg-2, #1e293b);
}
.rr-batch-info { font-size: 12px; color: var(--fg-3, #94a3b8); }
/* `#253` 【全选】是**复选框**（三态）：整块可点（不必精准点中方框），且能看出「半选」 */
.rr-all { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; font-size: 12px; color: var(--fg-2, #cbd5e1); }
.rr-all input { accent-color: var(--brand, #6366f1); cursor: pointer; }
.rr-sep { width: 1px; height: 16px; background: var(--bd, #334155); margin: 0 2px; }
.rr-row.sel { border-color: var(--brand, #6366f1); box-shadow: 0 0 0 1px var(--brand, #6366f1) inset; }
.rr-check { accent-color: var(--brand, #6366f1); }

/* ── 启用/禁用滑块（放在「编辑」前）──────────────────────────── */
.rr-sw { display: inline-flex; align-items: center; cursor: pointer; }
.rr-sw input { position: absolute; opacity: 0; pointer-events: none; }
.rr-sw-track {
  width: 34px; height: 18px; border-radius: 999px; background: var(--bg-3, #334155);
  position: relative; transition: background 0.15s;
}
.rr-sw-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; transition: transform 0.15s;
}
.rr-sw input:checked + .rr-sw-track { background: var(--ok, #22c55e); }
.rr-sw input:checked + .rr-sw-track .rr-sw-knob { transform: translateX(16px); }
</style>
