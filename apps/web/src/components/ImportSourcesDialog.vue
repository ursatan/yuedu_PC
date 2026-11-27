<script setup lang="ts">
/**
 * 导入源对话框（对齐 OmniFlow 的导入体验）：
 *   ① 格式选择（自动识别 / Legado 书源 / CMS 影视源）
 *   ② 三种输入方式：粘贴文本 · 上传文件（拖拽或点选）· 粘贴 URL（服务端抓取，免 CORS）
 *   ③ 导入前**预览**：识别格式 / 共解析 N 条 / **新增·更新·重复·错误**四统计 / 逐条名称·类型·分组·判定
 *   ④ `#351` **自选导入**：每行一个复选框 + 表头全选；**默认勾选「新增 + 更新」**（重复不勾）；
 *      点「导入 N 条」只导入勾中的行 ⇒ 新增的新增、更新的更新（已存在的选中即覆盖）。
 *
 * 解析放在**服务端**（@yuedu/facade/importer）：预览与入库用同一份实现，
 * 不会出现「预览 29 条新增、导入 0 条」。
 *
 * ## `#351` 为什么把「重复 → 跳过/覆盖」全局开关换成逐行复选框
 * 用户原话：「预览源列表前应有复选框（提供全选复选框，默认勾选更新、新增源），支持自选导入；
 * 修正导入源时的跳过、覆盖功能 -> 功能可被导入 + 自选覆盖，可移除」。
 * 一个全局开关表达不了「这批里我要 A 的更新、不要 B 的更新」；逐行勾选可以，
 * 且「默认勾更新+新增」正好等于旧行为里最常用的组合。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  importCommit, importPreview,
  type ImportFormatHint, type ImportJobProgress, type ImportPreview, type ImportPreviewItem,
} from '../api';

const props = defineProps<{
  defaultGroup?: string;
  /** `#343` 唤起导入带来的 URL（可空）—— 开箱即切 URL 通道并自动抓取预览 */
  initialUrl?: string;
  /** `#343` 唤起导入带来的已抓文本（可空）—— 开箱即用文本通道预览 */
  initialText?: string;
  /** 唤起导入时锁定的格式提示（可空，默认 auto） */
  initialFormat?: ImportFormatHint;
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'imported', r: { inserted: number; updated: number; skipped: number; failed: number }): void }>();

const FORMATS: Array<{ v: ImportFormatHint; label: string; icon: string }> = [
  { v: 'auto', label: '自动识别', icon: '✨' },
  { v: 'legado', label: 'Legado 书源', icon: '📚' },
  { v: 'maccms', label: 'CMS 影视源', icon: '🎬' },
  { v: 'rss', label: 'RSS 订阅源', icon: '📰' },
];

type Mode = 'text' | 'file' | 'url';
const mode = ref<Mode>('text');
const formatHint = ref<ImportFormatHint>('auto');
const group = ref(props.defaultGroup ?? '');

const text = ref('');
const url = ref('');
const fileName = ref('');
const fileBytes = ref(0);
/** 文件/URL 通道的内容（与 text 互斥：当前 tab 决定用哪一份） */
const fileContent = ref('');

const preview = ref<ImportPreview | null>(null);
const busy = ref(false);
const fetching = ref(false);
const committing = ref(false);
/** `D5` 导入 job 进度（提交后轮询填充；失败行留着供二次提交重试） */
const progress = ref<ImportJobProgress | null>(null);
/** 上一次提交的入参（「重试失败行」复用同一份文本/URL 与格式） */
const lastCommitBody = ref<(Parameters<typeof importCommit>[0]) | null>(null);
const failedRows = computed(() => progress.value?.failed ?? []);
const jobTotal = computed(() => progress.value?.total || (committing.value ? checkedCount.value : 0));
const jobDone = computed(() => progress.value?.done ?? 0);
const jobPct = computed(() => (jobTotal.value ? Math.min(100, Math.round((jobDone.value / jobTotal.value) * 100)) : 0));
const jobStageLabel = computed(() => {
  if (!committing.value) return progress.value?.state === 'error' ? '导入出错' : '导入完成';
  return progress.value?.stage === 'persist' ? '⟳ 正在落盘…' : '⟳ 正在入库…';
});
const err = ref('');
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/**
 * `#351` 勾选状态 —— **显式存「已勾选集」**，不存「排除集」。
 *
 * ★ 为什么不能存「未勾选的反集」：默认勾选规则是「新增 + 更新，**重复不勾**」，
 *   而反集（`unchecked`）只能从默认集里**减**、永远加不回来 ⇒ 两条真实缺陷（实测）：
 *     ① 点「重复」行的复选框**改不动模型**（反集里删掉一个本就不在默认集里的下标，
 *        `checked` 仍是默认集过滤的结果）；复选框被浏览器原生翻转 ⇒ 界面与模型不一致。
 *     ② 表头「全选」**完全无效**（把反集清空只能恢复默认集，选不中重复行）。
 *   改成显式集后，勾/取消都是普通增删，语义直接。
 */
const checked = ref<Set<number>>(new Set());
/** 预设：新增 + 更新（重复默认不勾，用户想强推时可手动勾）。键 = 行下标（`r.index`） */
const defaultChecked = computed(() => allRows.value.filter((r) => r.verdict !== 'dup').map((r) => r.index));
const checkedCount = computed(() => checked.value.size);
const allChecked = computed(() => allRows.value.length > 0 && allRows.value.every((r) => checked.value.has(r.index)));
const someChecked = computed(() => checkedCount.value > 0 && !allChecked.value);
/** 首次拿到预览时把默认勾选灌进 `checked`（之后完全由用户操作驱动） */
function seedChecked(): void {
  checked.value = new Set(defaultChecked.value);
}
function isChecked(index: number): boolean {
  return checked.value.has(index);
}
function toggleRow(index: number): void {
  const s = new Set(checked.value);
  if (s.has(index)) s.delete(index);
  else s.add(index);
  checked.value = s;
}
function toggleAll(): void {
  if (allChecked.value) checked.value = new Set();
  else checked.value = new Set(allRows.value.map((r) => r.index));
}

/** 当前通道要提交的文本 */
const payload = computed(() => (mode.value === 'text' ? text.value : fileContent.value));

/** `#351` 三种判定 */
type RowKind = 'new' | 'update' | 'dup';
interface Row extends ImportPreviewItem {
  verdict: RowKind;
}
/** 预览表全量行（新增 → 更新 → 重复 的顺序，与统计条一致） */
const allRows = computed<Row[]>(() => {
  const p = preview.value;
  if (!p) return [];
  return [
    ...p.valid.map((r) => ({ ...r, verdict: 'new' as const })),
    ...p.updatable.map((r) => ({ ...r, verdict: 'update' as const })),
    ...p.duplicates.map((r) => ({ ...r, verdict: 'dup' as const })),
  ];
});
/** 提交用的勾选集（就是 `checked` 本身，保留此别名让模板/提交处语义清晰） */
const checkedIds = checked;

const FMT_LABEL: Record<string, string> = { legado: 'Legado 书源', maccms: 'CMS 影视源', rss: 'RSS 订阅源' };

let timer: ReturnType<typeof setTimeout> | null = null;
function schedulePreview(delay = 400): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runPreview(), delay);
}

async function runPreview(): Promise<void> {
  err.value = '';
  if (mode.value === 'url') {
    // URL 通道：抓取动作本身就是预览（避免「先抓取再预览」两次请求）
    preview.value = null;
    return;
  }
  if (!payload.value.trim()) {
    preview.value = null;
    return;
  }
  busy.value = true;
  try {
    preview.value = await importPreview({
      text: payload.value,
      format: formatHint.value,
      ...(group.value.trim() ? { defaultGroup: group.value.trim() } : {}),
    });
    seedChecked();
  } catch (e) {
    preview.value = null;
    err.value = '预览失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}

/** URL 通道：服务端抓取 + 预览一次完成 */
async function fetchUrl(): Promise<void> {
  const u = url.value.trim();
  if (!/^https?:\/\//i.test(u)) {
    err.value = '请输入 http(s) 开头的地址';
    return;
  }
  err.value = '';
  fetching.value = true;
  preview.value = null;
  try {
    const p = await importPreview({
      url: u,
      format: formatHint.value,
      ...(group.value.trim() ? { defaultGroup: group.value.trim() } : {}),
    });
    preview.value = p;
    seedChecked();
    fileName.value = `URL 抓取（${(p.bytes / 1024).toFixed(1)} KB）`;
    fileBytes.value = p.bytes;
  } catch (e) {
    err.value = '抓取失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    fetching.value = false;
  }
}

const ACCEPT = '.json,.txt,.csv,.js';
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
    await runPreview();
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

async function doImport(): Promise<void> {
  if (!preview.value || checkedCount.value === 0) return;
  committing.value = true;
  err.value = '';
  progress.value = null;
  try {
    // URL 通道始终用服务端抓取（此前抓取时已经拿到同一份内容），其余通道用本地文本
    const body = mode.value === 'url' ? { url: url.value.trim() } : { text: payload.value };
    const commitBody = {
      ...body,
      format: formatHint.value,
      // `#351` 只提交勾中的行（按**行下标**）：「勾了的新增」条数 = inserted，「勾了的已存在」= updated（覆盖）
      selectedRows: [...checkedIds.value],
      ...(group.value.trim() ? { defaultGroup: group.value.trim() } : {}),
    };
    lastCommitBody.value = commitBody;
    // `D5`：异步 job + 进度回调（逐片刷新 `done/total` 与失败行）
    const r = await importCommit(commitBody, (p) => { progress.value = p; });
    emit('imported', { inserted: r.inserted, updated: r.updated, skipped: r.skipped, failed: r.failed });
    /**
     * `#357` **导入成功即关闭对话框**（用户 2026-10-08：从订阅源正文里点
     * `legado://import/bookSource?src=…` 唤起导入界面，导入成功但界面不关）。
     *
     * ★ 放在**组件内**而不是两个宿主（阅读浮层 / 源管理页）各写一遍 —— 同一判据写两处
     *   必然漂移。★ 有失败的行**不关**：这时用户需要留在界面上看清哪条没进去，
     *   `emit('imported')` 的 toast 也会带上「失败 N」。
     */
    if (!r.failed) emit('close');
  } catch (e) {
    err.value = '导入失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    committing.value = false;
  }
}

/** `D5` 只重试失败行：用**原始行下标**二次提交，成功后清空失败清单 */
async function retryFailed(): Promise<void> {
  const base = lastCommitBody.value;
  const indexes = failedRows.value.map((f) => f.index);
  if (!base || !indexes.length || committing.value) return;
  committing.value = true;
  err.value = '';
  try {
    const r = await importCommit({ ...base, selectedRows: indexes }, (p) => { progress.value = p; });
    emit('imported', { inserted: r.inserted, updated: r.updated, skipped: r.skipped, failed: r.failed });
    if (!r.failed) {
      progress.value = null;
      emit('close');
    }
  } catch (e) {
    err.value = '重试失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    committing.value = false;
  }
}

function switchMode(m: Mode): void {
  mode.value = m;
  preview.value = null;
  err.value = '';
}

watch([formatHint, group], () => {
  if (mode.value !== 'url') schedulePreview(200);
});
watch(mode, (m) => {
  if (m === 'text' && text.value.trim()) schedulePreview(150);
  if (m === 'file' && fileContent.value.trim()) schedulePreview(150);
});

onMounted(() => {
  preview.value = null;
  // `#343` 唤起导入：带上 URL ⇒ 切 URL 通道并**走预览**（不静默导入）；带上文本 ⇒ 文本通道预览。
  // 用户要求「不管是源导入还是订阅源导入，导入都应有预览」—— 与恢复备份（直接还原）语义不同。
  if (props.initialUrl && props.initialUrl.trim()) {
    mode.value = 'url';
    url.value = props.initialUrl.trim();
    if (props.initialFormat) formatHint.value = props.initialFormat;
    void fetchUrl();
    return;
  }
  if (props.initialText && props.initialText.trim()) {
    mode.value = 'text';
    text.value = props.initialText;
    if (props.initialFormat) formatHint.value = props.initialFormat;
    schedulePreview(0);
  }
});
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>＋ 导入源</b>
        <span class="sub">支持 Legado 书源 / Legado RSS 订阅源 JSON、MacCMS 影视源（含「name,apiUrl」文本清单）</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <div class="dlg-body">
        <!-- ① 格式 -->
        <div class="row">
          <span class="lab">格式</span>
          <div class="chips">
            <button
              v-for="f in FORMATS" :key="f.v"
              class="chip" :class="{ on: formatHint === f.v }"
              @click="formatHint = f.v"
            >{{ f.icon }} {{ f.label }}</button>
          </div>
          <span class="hint">「自动识别」按内容特征判断，认错时可手动指定</span>
        </div>

        <!-- ② 输入方式 -->
        <div class="tabs">
          <button class="tab" :class="{ on: mode === 'text' }" @click="switchMode('text')">粘贴文本</button>
          <button class="tab" :class="{ on: mode === 'file' }" @click="switchMode('file')">上传文件</button>
          <button class="tab" :class="{ on: mode === 'url' }" @click="switchMode('url')">粘贴 URL</button>
        </div>

        <!-- 粘贴文本 -->
        <template v-if="mode === 'text'">
          <textarea
            v-model="text" class="ta" rows="7" spellcheck="false"
            placeholder="粘贴 Legado 书源 JSON 数组、RSS 订阅源 JSON（含 sourceUrl）、单个书源对象、MacCMS 影视源（apiUrl/name），或每行「name,apiUrl」的 CMS 文本清单……"
            @input="schedulePreview()"
          ></textarea>
        </template>

        <!-- 上传文件（拖拽 / 点选） -->
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
            <div class="drop-s">.json / .txt / .csv　最大 60MB（Legado 书源 / RSS 订阅源 / MacCMS 影视源 含「name,apiUrl」清单）</div>
            <input ref="fileInput" type="file" :accept="ACCEPT" style="display: none" @change="onFileChange" />
          </div>
          <div v-if="fileName" class="picked">
            已选：<b>{{ fileName }}</b>
            <span v-if="fileBytes">（{{ (fileBytes / 1024).toFixed(1) }} KB）</span>
          </div>
        </template>

        <!-- 粘贴 URL -->
        <template v-else>
          <div class="row">
            <input
              v-model="url" style="flex: 1; min-width: 220px"
              placeholder="https://…/sources.json（书源合集 / RSS 订阅源 / CMS 影视源清单的直链）"
              @keyup.enter="fetchUrl"
            />
            <button class="btn sm primary" :disabled="fetching" @click="fetchUrl">
              {{ fetching ? '⟳ 抓取中…' : '抓取' }}
            </button>
          </div>
          <div class="hint" style="margin-top: 6px">
            由<b>服务端</b>抓取（绕开浏览器跨域限制，可带 UA）；抓取成功即出预览。若站点需要登录/校验，请先下载文件再用「上传文件」。
          </div>
        </template>

        <!-- 可选默认分组 -->
        <div class="row">
          <span class="lab">默认分组</span>
          <input v-model="group" placeholder="可选：源自身没有分组时套用它" style="flex: 1; max-width: 260px" />
        </div>

        <!-- ③ 预览 -->
        <div v-if="preview" class="pv">
          <div class="pv-head">
            <span class="tag acc">{{ FMT_LABEL[preview.format] ?? preview.format }}</span>
            <span>共解析 <b>{{ preview.parsedTotal }}</b> 条<span v-if="preview.bytes"> · {{ (preview.bytes / 1024).toFixed(1) }} KB</span></span>
            <span class="pv-snip">{{ preview.preview }}</span>
          </div>
          <div class="stats">
            <div class="stat green">新增 <b>{{ preview.valid.length }}</b></div>
            <div class="stat blue">更新 <b>{{ preview.updatable.length }}</b></div>
            <div class="stat orange">重复 <b>{{ preview.duplicates.length }}</b></div>
            <div class="stat red">错误 <b>{{ preview.errors.length }}</b></div>
          </div>
          <div v-if="preview.note" class="hint" style="margin-top: 8px">{{ preview.note }}</div>

          <div v-if="allRows.length" class="tbl-wrap">
            <div class="tbl-bar">
              <label class="pick">
                <input type="checkbox" :checked="allChecked" :indeterminate="someChecked" @change="toggleAll" />
                <span>全选</span>
              </label>
              <span class="tbl-hint">默认勾选「新增 + 更新」；重复默认不勾（勾中会<b>覆盖</b>）。已选 <b>{{ checkedCount }}</b> / {{ allRows.length }} 条</span>
            </div>
            <table class="tbl">
              <thead>
                <tr>
                  <th style="width: 34px"></th>
                  <th style="width: 40px">#</th>
                  <th>名称</th>
                  <th style="width: 72px">类型</th>
                  <th style="width: 120px">分组</th>
                  <th style="width: 84px">判定</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in allRows" :key="r.index" :class="{ off: !isChecked(r.index) }">
                  <td><input type="checkbox" :checked="isChecked(r.index)" @change="toggleRow(r.index)" /></td>
                  <td>{{ i + 1 }}</td>
                  <td :title="r.id">{{ r.name }}</td>
                  <td><span class="tag">{{ r.kind }}</span></td>
                  <td class="grp">{{ r.group || '—' }}</td>
                  <td>
                    <span class="tag" :class="r.verdict === 'new' ? 'green' : r.verdict === 'update' ? 'blue' : 'orange'">
                      {{ r.verdict === 'new' ? '新增' : r.verdict === 'update' ? '更新' : '重复' }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <ul v-if="preview.errors.length" class="errs">
            <li v-for="(e, i) in preview.errors.slice(0, 12)" :key="i">[{{ e.index || '-' }}] {{ e.reason }}</li>
          </ul>
          <div v-if="preview.errors.length > 12" class="hint">…还有 {{ preview.errors.length - 12 }} 条错误未展开</div>
        </div>

        <div v-else-if="!busy && !fetching" class="hint" style="padding: 4px 2px">
          填入内容后会自动预览（识别格式、解析条数、新增/更新/重复/错误）。勾选要导入的条目，再点「导入 N 条」。
        </div>
        <div v-if="busy || fetching" class="hint" style="padding: 4px 2px">⟳ 解析中…</div>
        <div v-if="err" class="err">{{ err }}</div>

        <!-- `D5` 异步导入进度 + 失败行二次提交 -->
        <div v-if="committing || failedRows.length" class="job">
          <div class="job-top">
            <span class="job-stage">{{ jobStageLabel }}</span>
            <span class="job-count">{{ jobDone }} / {{ jobTotal }}（{{ jobPct }}%）</span>
          </div>
          <div class="job-bar"><i :style="{ width: jobPct + '%' }" /></div>
          <div v-if="failedRows.length" class="job-fail">
            <div class="job-fail-head">失败 {{ failedRows.length }} 条（可二次提交重试）</div>
            <ul class="errs">
              <li v-for="f in failedRows.slice(0, 8)" :key="f.index">
                [{{ f.index || '-' }}] {{ f.name || f.id || '未知源' }}：{{ f.error }}
              </li>
            </ul>
            <div v-if="failedRows.length > 8" class="hint">…还有 {{ failedRows.length - 8 }} 条未展开</div>
            <button class="btn sm" :disabled="committing" @click="retryFailed">重试失败 {{ failedRows.length }} 条</button>
          </div>
        </div>
      </div>

      <div class="dlg-foot">
        <button class="btn sm ghost" @click="emit('close')">取消</button>
        <button class="btn sm primary" :disabled="!preview || checkedCount === 0 || committing" @click="doImport">
          {{ committing ? '⟳ 导入中…' : `导入已选 ${checkedCount} 条` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  /**
   * `#413`（用户实测）：**必须盖在阅读浮层之上** —— `ReaderOverlay` 是 `fixed z-index:1000`，
   * 而本对话框原为 `z-index:90`（与其它常规模态同档）⇒ 从**阅读页里**点 `legado://…` 唤起导入
   * （`SchemeImportHost`，常驻但层级低）时，导入界面被阅读页整块盖住，用户原话：
   * 「源导入界面置底被阅读界面遮盖，看不到，关掉阅读界面才能看到」。
   */
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
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
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
.stat.blue b { color: var(--acc); }
.stat.orange b { color: var(--orange); }
.stat.red b { color: var(--red); }
.tbl-bar {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 6px 10px; border-bottom: 1px solid var(--border);
  background: var(--bg-2); position: sticky; top: 0; z-index: 2;
}
.pick { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-1); cursor: pointer; }
.pick input { width: 14px; height: 14px; accent-color: var(--acc); cursor: pointer; }
.tbl-hint { font-size: 11.5px; color: var(--muted); }
.tbl-wrap { max-height: 240px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.tbl-wrap .tbl { width: 100%; }
.tbl-wrap thead th { position: sticky; top: 0; background: var(--bg-2); z-index: 1; }
.tbl tbody tr.off { opacity: 0.45; }
.tbl tbody input[type='checkbox'] { width: 14px; height: 14px; accent-color: var(--acc); cursor: pointer; }
.tag.blue { color: var(--acc); border-color: var(--acc-dim); }
.grp { color: var(--muted); font-size: 12px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.errs {
  margin: 8px 0 0; padding-left: 18px; font-size: 11.5px; line-height: 1.7;
  color: var(--orange); max-height: 110px; overflow: auto;
}
.err { font-size: 12px; color: var(--red); }

/* `D5` 导入进度 / 失败行 */
.job { margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.job-top { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.job-stage { color: var(--text-1); }
.job-bar { height: 6px; border-radius: 999px; background: var(--bg-0); border: 1px solid var(--border); overflow: hidden; }
.job-bar i { display: block; height: 100%; background: var(--acc); transition: width 0.2s ease; }
.job-fail { margin-top: 10px; }
.job-fail-head { font-size: 12px; color: var(--red); margin-bottom: 4px; }
.job-fail .errs { color: var(--red); max-height: 140px; }
.job-fail .btn { margin-top: 8px; }
input, textarea { font-family: inherit; font-size: 13px; }
.dlg-body input {
  background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; outline: none;
}
.dlg-body input:focus { border-color: var(--acc-dim); }
</style>
