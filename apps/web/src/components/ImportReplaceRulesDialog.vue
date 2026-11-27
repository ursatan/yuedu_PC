<script setup lang="ts">
/**
 * **净化规则导入对话框**（`#266`，用户 2026-10-04）。
 *
 * ## 为什么长这样
 * 对齐 `ImportSourcesDialog.vue`（导入源）的交互 —— 用户原话：「应弹出对话框，展示读取的
 * 规则列表，类似于源管理导入源后的界面：自动预览（识别格式、解析条数、新增/重复/错误），
 * 确认无误再点『导入 N 条』。支持重复跳过和覆盖」。
 *
 * ## 与「导入源」的一个**有意差异**：提交不走服务端
 * 规则的**写权威在前端 store**（`useReplaceRulesStore.upsert → reconcile` 全量对齐服务端）
 * ⇒ 若服务端直接插库，前端内存不知道 ⇒ 下一次对齐可能把导入的条目**抹掉**。
 * 所以：解析/判重用 `@yuedu/core` 的纯函数（与预览同一份实现），提交在本地按
 * 「重复跳过 / 覆盖」处理后走既有 `upsertMany`（一次落盘）。
 * 服务端只有一个 `/api/user/replace-rules/import-preview` 端点，**只**为 URL 通道抓文本。
 *
 * ## 判重（为什么会重复）
 * 旧「粘贴」一律给新 id 直接增量插入 ⇒ 同一批规则导入两次就是两份（`#259` 实测库里
 * 51 组同名同长度）。判重 key = `name + pattern + replacement` 三字段**逐字节**比较
 * （`replaceRuleDedupeKey`）；批内也去重（同一批里两条一样的只算第一条新增）。
 */
import { computed, onMounted, ref } from 'vue';
// ⚠️ 必须 `@yuedu/core/contract`（契约入口）：根入口会带进 node 专属模块（store.ts 的
// readFileSync 等），vite build 直接失败 —— ReadStylePanel 等组件都是这么引的。
import { parseReplaceRuleImport, replaceRuleDedupeKey, type ReplaceRule } from '@yuedu/core/contract';
import { useReplaceRulesStore } from '../stores/replaceRules';
import { replaceRuleImportPreview } from '../api';

const props = defineProps<{
  /** 「粘贴」按钮带来的剪贴板原文（可空 —— 走三通道自己填） */
  initialText?: string;
  /** `#343` 唤起导入带来的 URL（可空）—— 以 URL 通道打开并自动抓取预览 */
  initialUrl?: string;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'imported', r: { inserted: number; updated: number; skipped: number; failed: number }): void;
}>();

const rules = useReplaceRulesStore();

type Mode = 'text' | 'file' | 'url';
const mode = ref<Mode>('text');
const dedupe = ref<'skip' | 'overwrite'>('skip');

const text = ref('');
const url = ref('');
const fileName = ref('');
const fileBytes = ref(0);
const fileContent = ref('');

const parse = ref<ReturnType<typeof parseReplaceRuleImport> | null>(null);
const fetching = ref(false);
const committing = ref(false);
const err = ref('');
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/** 当前通道要解析的文本 */
const payload = computed(() => (mode.value === 'text' ? text.value : fileContent.value));

/** 现有库的判重 key 集合（对照「新增 / 重复」） */
const existingKeys = computed(() => new Set(rules.sorted.map(replaceRuleDedupeKey)));

/** 判重分类：批内同 key 只算第一条新增（批内重复与库内重复同样对待） */
const classified = computed(() => {
  if (!parse.value) return null;
  const batchKeys = new Set<string>();
  const valid: ReplaceRule[] = [];
  const duplicates: ReplaceRule[] = [];
  for (const r of parse.value.rules) {
    const k = replaceRuleDedupeKey(r);
    if (existingKeys.value.has(k) || batchKeys.has(k)) duplicates.push(r);
    else {
      valid.push(r);
      batchKeys.add(k);
    }
  }
  return { valid, duplicates };
});

/** 可导入条数 = 新增 + 重复（重复是否真进取决于 dedupe） */
const importableCount = computed(() => {
  const c = classified.value;
  if (!c) return 0;
  return c.valid.length + (dedupe.value === 'overwrite' ? c.duplicates.length : 0);
});

const rows = computed(() => {
  const c = classified.value;
  if (!c) return [];
  return [
    ...c.valid.map((r) => ({ r, dup: false })),
    ...c.duplicates.map((r) => ({ r, dup: true })),
  ];
});

function runLocalParse(): void {
  err.value = '';
  const t = payload.value;
  parse.value = t.trim() ? parseReplaceRuleImport(t) : null;
}

/** URL 通道：服务端抓取 + 解析一次完成（绕开浏览器 CORS） */
async function fetchUrl(): Promise<void> {
  const u = url.value.trim();
  if (!/^https?:\/\//i.test(u)) {
    err.value = '请输入 http(s) 开头的地址';
    return;
  }
  err.value = '';
  fetching.value = true;
  parse.value = null;
  try {
    const j = await replaceRuleImportPreview({ url: u });
    parse.value = {
      parsedTotal: j.parsedTotal,
      rules: j.rules as unknown as ReplaceRule[],
      errors: j.errors,
      preview: j.preview,
    };
    fileName.value = `URL 抓取（${(j.bytes / 1024).toFixed(1)} KB）`;
    fileBytes.value = j.bytes;
  } catch (e) {
    err.value = '抓取失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    fetching.value = false;
  }
}

const ACCEPT = '.json,.txt';
function pickFile(): void {
  fileInput.value?.click();
}
async function readFile(f: File): Promise<void> {
  err.value = '';
  if (f.size > 60 * 1024 * 1024) {
    err.value = `文件 ${(f.size / 1024 / 1024).toFixed(1)} MB 超过 60MB 上限`;
    return;
  }
  try {
    fileContent.value = await f.text();
    fileName.value = f.name;
    fileBytes.value = f.size;
    runLocalParse();
  } catch (e) {
    err.value = '读取文件失败：' + (e instanceof Error ? e.message : String(e));
  }
}
function onFileChange(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void readFile(f);
}
function onDrop(e: DragEvent): void {
  dragging.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) void readFile(f);
}

/** 提交：新增给新 id 排到末尾；「覆盖」按 key 找到现有规则，只改内容、保留其 id 与排序 */
async function doImport(): Promise<void> {
  const c = classified.value;
  if (!c) return;
  committing.value = true;
  try {
    const maxOrder = rules.sorted.reduce((m, r) => Math.max(m, r.order), 0);
    const toUpsert: ReplaceRule[] = [];
    c.valid.forEach((r, i) => toUpsert.push({ ...r, id: Date.now() + i, order: maxOrder + 1 + i }));
    let updated = 0;
    if (dedupe.value === 'overwrite') {
      for (const d of c.duplicates) {
        const k = replaceRuleDedupeKey(d);
        const existing = rules.rules.find((x) => replaceRuleDedupeKey(x) === k);
        if (existing) {
          toUpsert.push({ ...existing, ...d, id: existing.id, order: existing.order });
          updated++;
        }
      }
    }
    rules.upsertMany(toUpsert);
    emit('imported', {
      inserted: c.valid.length,
      updated,
      skipped: c.duplicates.length - updated,
      failed: parse.value?.errors.length ?? 0,
    });
  } finally {
    committing.value = false;
  }
}

function switchMode(m: Mode): void {
  mode.value = m;
  err.value = '';
  if (m !== 'url') runLocalParse();
  else parse.value = null;
}

onMounted(() => {
  // 「粘贴」按钮带来剪贴板原文 ⇒ 直接预览（用户不用再粘一遍）
  if (props.initialText && props.initialText.trim()) {
    text.value = props.initialText;
    runLocalParse();
    return;
  }
  // `#343` 唤起导入带来 URL ⇒ 自动切到 URL 通道并抓取（用户不用再贴一遍地址）
  if (props.initialUrl && props.initialUrl.trim()) {
    mode.value = 'url';
    url.value = props.initialUrl;
    void fetchUrl();
  }
});
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>⇩ 导入净化规则</b>
        <span class="sub">Legado / 本仓净化规则 JSON（字段同名，缺省字段取默认值）</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <div class="dlg-body">
        <div class="tabs">
          <button class="tab" :class="{ on: mode === 'text' }" @click="switchMode('text')">粘贴文本</button>
          <button class="tab" :class="{ on: mode === 'file' }" @click="switchMode('file')">上传文件</button>
          <button class="tab" :class="{ on: mode === 'url' }" @click="switchMode('url')">粘贴 URL</button>
        </div>

        <template v-if="mode === 'text'">
          <textarea
            v-model="text" class="ta" rows="7" spellcheck="false"
            placeholder="粘贴净化规则 JSON 数组（或单个对象）……"
            @input="runLocalParse"
          ></textarea>
        </template>

        <template v-else-if="mode === 'file'">
          <div
            class="drop" :class="{ over: dragging }"
            @click="pickFile"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <div class="drop-icon">⬆</div>
            <div class="drop-t">拖入文件到此处，或点击选择</div>
            <div class="drop-s">.json / .txt　最大 60MB</div>
            <input ref="fileInput" type="file" :accept="ACCEPT" style="display: none" @change="onFileChange" />
          </div>
          <div v-if="fileName" class="picked">
            已选：<b>{{ fileName }}</b>
            <span v-if="fileBytes">（{{ (fileBytes / 1024).toFixed(1) }} KB）</span>
          </div>
        </template>

        <template v-else>
          <div class="row">
            <input
              v-model="url" style="flex: 1; min-width: 220px"
              placeholder="https://…/rules.json（净化规则合集的直链）"
              @keyup.enter="fetchUrl"
            />
            <button class="btn sm primary" :disabled="fetching" @click="fetchUrl">
              {{ fetching ? '⟳ 抓取中…' : '抓取' }}
            </button>
          </div>
          <div class="hint" style="margin-top: 6px">
            由<b>服务端</b>抓取（绕开浏览器跨域限制）；抓取成功即出预览。
          </div>
        </template>

        <!-- 预览：确认无误再点「导入 N 条」 -->
        <div v-if="parse" class="pv">
          <div class="pv-head">
            <span>共解析 <b>{{ parse.parsedTotal }}</b> 条<span v-if="fileBytes && mode !== 'text'"> · {{ (fileBytes / 1024).toFixed(1) }} KB</span></span>
            <span class="pv-snip">{{ parse.preview }}</span>
          </div>
          <div class="stats">
            <div class="stat green">新增 <b>{{ classified?.valid.length ?? 0 }}</b></div>
            <div class="stat orange">重复 <b>{{ classified?.duplicates.length ?? 0 }}</b></div>
            <div class="stat red">错误 <b>{{ parse.errors.length }}</b></div>
          </div>

          <div v-if="rows.length" class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr><th style="width: 40px">#</th><th>名称</th><th>查找内容</th><th>替换为</th><th style="width: 90px">分组</th><th style="width: 84px">去重判定</th></tr>
              </thead>
              <tbody>
                <tr v-for="(row, i) in rows" :key="i">
                  <td>{{ i + 1 }}</td>
                  <td>{{ row.r.name || '(未命名)' }}</td>
                  <td class="mono" :title="row.r.pattern">{{ row.r.pattern }}</td>
                  <td class="mono" :title="row.r.replacement">{{ row.r.replacement === '' ? '（删除）' : row.r.replacement }}</td>
                  <td class="grp">{{ row.r.group || '—' }}</td>
                  <td><span class="tag" :class="row.dup ? 'orange' : 'green'">{{ row.dup ? '重复' : '新增' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul v-if="parse.errors.length" class="errs">
            <li v-for="(e, i) in parse.errors.slice(0, 12)" :key="i">[{{ e.index || '-' }}] {{ e.reason }}</li>
          </ul>
          <div v-if="parse.errors.length > 12" class="hint">…还有 {{ parse.errors.length - 12 }} 条错误未展开</div>

          <div class="row" style="margin-top: 10px">
            <span class="lab">重复处理</span>
            <button class="chip" :class="{ on: dedupe === 'skip' }" @click="dedupe = 'skip'">重复 → 跳过</button>
            <button class="chip" :class="{ on: dedupe === 'overwrite' }" @click="dedupe = 'overwrite'">重复 → 覆盖</button>
          </div>
        </div>

        <div v-else-if="!fetching" class="hint" style="padding: 4px 2px">
          填入内容后会自动预览（解析条数、新增/重复/错误）。确认无误再点「导入 N 条」。
        </div>
        <div v-if="fetching" class="hint" style="padding: 4px 2px">⟳ 解析中…</div>
        <div v-if="err" class="err">{{ err }}</div>
      </div>

      <div class="dlg-foot">
        <button class="btn sm ghost" @click="emit('close')">取消</button>
        <button class="btn sm primary" :disabled="!parse || importableCount === 0 || committing" @click="doImport">
          {{ committing ? '⟳ 导入中…' : `导入 ${importableCount} 条` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  /** `#413`：同 `ImportSourcesDialog` —— 必须盖在阅读浮层（z-index:1000）之上，否则从阅读页唤起时被盖住 */
  position: fixed; inset: 0; z-index: 1400;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 6vh 16px;
  overflow: auto;
}
.dlg { width: min(760px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px;
}
.dlg-head .sub { color: var(--muted); font-size: 12px; }
.dlg-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dlg-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--border);
}
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lab { font-size: 12px; color: var(--muted); min-width: 58px; }
.hint { font-size: 11.5px; color: var(--muted); line-height: 1.6; }
.chip {
  padding: 4px 10px; font-size: 12px; border-radius: 999px;
  background: var(--bg-2); color: var(--text-1);
  border: 1px solid var(--border); cursor: pointer;
}
.chip:hover { border-color: var(--acc-dim); color: var(--text); }
.chip.on { background: rgba(108, 124, 255, 0.16); border-color: var(--acc-dim); color: #fff; }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); }
.tab {
  background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--muted); font-size: 13px; padding: 7px 12px; cursor: pointer;
}
.tab:hover { color: var(--text-1); }
.tab.on { color: var(--text); border-bottom-color: var(--acc); }
.ta {
  width: 100%; font-family: var(--mono); font-size: 12px;
  background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px; outline: none; resize: vertical;
}
.ta:focus { border-color: var(--acc-dim); }
.drop {
  border: 1px dashed var(--border-strong); border-radius: 10px;
  background: var(--bg-0); text-align: center; padding: 26px 16px; cursor: pointer;
}
.drop.over { border-color: var(--acc); background: rgba(108, 124, 255, 0.07); }
.drop-icon { font-size: 26px; color: var(--muted); }
.drop-t { margin-top: 6px; font-size: 13px; }
.drop-s { margin-top: 4px; font-size: 11.5px; color: var(--muted); }
.picked { font-size: 12px; color: var(--text-1); }
.pv { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg-0); }
.pv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-1); }
.pv-snip { color: var(--muted); font-family: var(--mono); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 100%; }
.stats { display: flex; gap: 10px; margin: 10px 0 8px; }
.stat {
  flex: 1; text-align: center; padding: 7px 0; border-radius: 8px;
  font-size: 12px; background: var(--bg-2); border: 1px solid var(--border);
}
.stat b { font-size: 15px; margin-left: 4px; }
.stat.green b { color: var(--green); }
.stat.orange b { color: var(--orange); }
.stat.red b { color: var(--red); }
.tbl-wrap { max-height: 240px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.tbl-wrap .tbl { width: 100%; }
.tbl-wrap thead th { position: sticky; top: 0; background: var(--bg-2); z-index: 1; }
.mono { font-family: var(--mono); font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grp { color: var(--muted); font-size: 12px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.errs {
  margin: 8px 0 0; padding-left: 18px; font-size: 11.5px; line-height: 1.7;
  color: var(--orange); max-height: 110px; overflow: auto;
}
.err { font-size: 12px; color: var(--red); }
input, textarea { font-family: inherit; font-size: 13px; }
.dlg-body input {
  background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; outline: none;
}
.dlg-body input:focus { border-color: var(--acc-dim); }
</style>
