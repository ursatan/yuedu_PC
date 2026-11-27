<script setup lang="ts">
/**
 * `#208` ⑤ **口令导入**对话框（源管理工具栏「🔗 口令导入」）。
 *
 * 链路：口令文本 → **本地解码**（`decodeSourceSharePassphrase`，纯函数）→ 得到下载地址 →
 * 服务端抓取 + 预览 → 确认导入。`D7`=A：**手动**点「📋 读剪贴板」，不做「打开页面自动读」
 * （PC 上常驻读剪贴板观感很差）。
 *
 * ★ 解码放**前端**、抓取放**服务端**，两件事的理由不同：
 *   · 解码是纯函数（`source-share-passphrase.ts` **零 import**，文件头写明两端共用）⇒
 *     本机能立刻回答「这不是口令 / 已过期 / 是哪种类型的口令」，**在发任何请求之前**。
 *   · 抓取必须服务端做：网盘地址是任意的，浏览器直连会撞 CORS，而服务端还能带 UA。
 *
 * ★ **一期只导入书源（`sy`）** —— 口令格式认得 7 种类型（上游如此），但本仓的
 *   `/api/sources/import` 只吃书源 JSON。其余类型**明确说不支持**，不要让人以为
 *   「点了没反应」（那正是本仓最讨厌的静默失败）。
 */
import { computed, ref } from 'vue';
import { decodeSourceSharePassphrase } from '@yuedu/core/contract';
import { importCommit, importPreview, type ImportPreview } from '../api';
import { toast } from '../toast';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'imported', r: { inserted: number; updated: number; skipped: number; failed: number }): void;
}>();

/** 口令类型代码 → 人话（上游 `Type` 枚举 7 种；一期只「生成」sy，但 decode 认全部） */
const TYPE_LABEL: Record<string, string> = {
  sy: '📚 书源',
  dy: '📡 订阅源（RSS）',
  zd: '📖 字典规则',
  jh: '🧹 替换规则',
  ml: '📑 目录规则',
  ld: '🔊 朗读规则',
  rw: '⏰ 自动任务',
};

const text = ref('');
const decoding = ref(false);
const fetching = ref(false);
const committing = ref(false);
const preview = ref<ImportPreview | null>(null);
const dedupe = ref<'skip' | 'overwrite'>('skip');
const hint = ref('');

/** 解码结果（每敲一个字就重算 —— 纯函数，零成本） */
const decoded = computed(() => {
  const t = text.value.trim();
  if (!t) return null;
  return decodeSourceSharePassphrase(t);
});

const typeCode = computed(() => (decoded.value?.kind === 'success' ? decoded.value.value.type : ''));
const typeLabel = computed(() => TYPE_LABEL[typeCode.value] ?? typeCode.value);
/** 一期只吃书源口令（见文件头） */
const importableType = computed(() => typeCode.value === 'sy');

const expiryText = computed(() => {
  if (decoded.value?.kind !== 'success') return '';
  const t = decoded.value.value.expiresAt;
  if (!t) return '永久有效';
  const d = Math.ceil((t - Date.now()) / 86400000);
  const date = new Date(t).toLocaleDateString();
  return d > 0 ? `${date} 到期（还有 ${d} 天）` : `已于 ${date} 过期（文件可能已被网盘删除）`;
});

const DECODE_MSG: Record<string, string> = {
  'not-found': '这不是一段分享口令 —— 口令以「复制口令到阅读导入」开头。也可能复制时开头被截掉了。',
  invalid: '口令格式不对（还原不出可用的地址）—— 可能复制过程中字符被改动或丢了。',
  expired: '口令已过期。文件可能已被网盘删除，导入多半会失败；若对方重新分享，请用新口令。',
};

const importableCount = computed(() => {
  const p = preview.value;
  if (!p) return 0;
  return p.valid.length + (dedupe.value === 'overwrite' ? p.duplicates.length : 0);
});

function onInput(): void {
  preview.value = null;
  hint.value = '';
}

async function readClipboard(): Promise<void> {
  try {
    const t = await navigator.clipboard.readText();
    if (!t.trim()) {
      toast('剪贴板是空的', 'warn');
      return;
    }
    text.value = t.trim();
    onInput();
  } catch {
    toast('浏览器未授权读取剪贴板 —— 可手动粘贴口令', 'warn');
  }
}

/** 服务端抓取 + 预览一次完成（抓取本身就是预览，避免两次请求） */
async function fetchAndPreview(): Promise<void> {
  const url = decoded.value?.kind === 'success' ? decoded.value.value.url : '';
  if (!url) return;
  fetching.value = true;
  hint.value = '';
  preview.value = null;
  try {
    const p = await importPreview({ url });
    preview.value = p;
  } catch (e) {
    hint.value = '抓取失败：' + (e instanceof Error ? e.message : String(e)) + '（若站点需要登录，请让对方改发文件）';
  } finally {
    fetching.value = false;
  }
}

async function doImport(): Promise<void> {
  const url = decoded.value?.kind === 'success' ? decoded.value.value.url : '';
  if (!url || !preview.value) return;
  committing.value = true;
  hint.value = '';
  try {
    const r = await importCommit({ url, dedupe: dedupe.value });
    emit('imported', { inserted: r.inserted, updated: r.updated, skipped: r.skipped, failed: r.failed });
  } catch (e) {
    hint.value = '导入失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    committing.value = false;
  }
}

/** 读剪贴板后自动抓一次（用户点了按钮 = 意图明确，不必再点第二次） */
async function readClipboardAndGo(): Promise<void> {
  await readClipboard();
  if (decoded.value?.kind === 'success') await fetchAndPreview();
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>🔗 口令导入</b>
        <span class="sub">粘贴别人发来的分享口令（形如「复制口令到阅读导入…¥Legado^」）</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <div class="dlg-body">
        <div class="row">
          <button class="btn sm primary" data-read-clipboard @click="readClipboardAndGo">📋 读剪贴板</button>
          <span class="hint">口令的粘贴也走这里；本仓不会自动读剪贴板（`D7`=A：手动触发）</span>
        </div>

        <textarea
          v-model="text" class="ta" rows="4" spellcheck="false"
          data-pp-input
          placeholder="把口令整段粘到这里（含开头的「复制口令到阅读导入」与结尾的「Legado^」）……"
          @input="onInput"
        ></textarea>

        <!-- 解码结果：成功 -->
        <div v-if="decoded?.kind === 'success'" class="box ok" data-pp-decoded>
          <div class="row" style="justify-content: space-between">
            <span>识别为 <b>{{ typeLabel }}</b></span>
            <span class="hint">{{ expiryText }}</span>
          </div>
          <div class="url-line" :title="decoded.value.url">{{ decoded.value.url }}</div>
          <div v-if="!importableType" class="warn-line" data-pp-unsupported>
            ⚠ 本仓目前只能导入<b>书源</b>口令；这条是「{{ typeLabel }}」，对应的导入通道还没做 —— 请把口令发给手机端 Legado 使用。
          </div>
        </div>

        <!-- 解码结果：失败分类 -->
        <div v-else-if="decoded" class="box bad" data-pp-decodefail>
          <div class="hint" style="white-space: pre-wrap">{{ DECODE_MSG[decoded.kind] ?? '口令无法识别' }}</div>
        </div>

        <div class="row">
          <button
            class="btn sm" data-pp-fetch
            :disabled="decoded?.kind !== 'success' || !importableType || fetching"
            @click="fetchAndPreview"
          >{{ fetching ? '⟳ 抓取中…' : '抓取并预览' }}</button>
          <span v-if="importableType && !preview" class="hint">由<b>服务端</b>抓取（绕开浏览器跨域）</span>
        </div>

        <!-- 预览 -->
        <div v-if="preview" class="box pv" data-pp-preview>
          <div class="pv-head">
            <span class="tag acc">{{ preview.format }}</span>
            <span>共解析 <b>{{ preview.parsedTotal }}</b> 条 · {{ (preview.bytes / 1024).toFixed(1) }} KB</span>
          </div>
          <div class="stats">
            <div class="stat green">新增 <b>{{ preview.valid.length }}</b></div>
            <div class="stat orange">重复 <b>{{ preview.duplicates.length }}</b></div>
            <div class="stat red">错误 <b>{{ preview.errors.length }}</b></div>
          </div>
          <div v-if="preview.errors.length" class="errs">
            <div v-for="(e, i) in preview.errors.slice(0, 6)" :key="i">[{{ e.index || '-' }}] {{ e.reason }}</div>
          </div>
          <div class="row">
            <span class="lab">重复处理</span>
            <button class="chip" :class="{ on: dedupe === 'skip' }" @click="dedupe = 'skip'">重复 → 跳过</button>
            <button class="chip" :class="{ on: dedupe === 'overwrite' }" @click="dedupe = 'overwrite'">重复 → 覆盖</button>
          </div>
        </div>

        <div v-if="hint" class="err">{{ hint }}</div>
      </div>

      <div class="dlg-foot">
        <button class="btn sm ghost" @click="emit('close')">取消</button>
        <button
          class="btn sm primary" data-pp-import
          :disabled="!preview || importableCount === 0 || committing" @click="doImport"
        >{{ committing ? '⟳ 导入中…' : `导入 ${importableCount} 条` }}</button>
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
.dlg { width: min(700px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
.dlg-head .sub { color: var(--muted); font-size: 12px; }
.dlg-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lab { font-size: 12px; color: var(--muted); }
.hint { font-size: 11.5px; color: var(--muted); line-height: 1.7; }
.ta {
  width: 100%; font-family: var(--mono); font-size: 12px;
  background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px; outline: none; resize: vertical;
}
.ta:focus { border-color: var(--acc-dim); }
.box { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--bg-0); display: flex; flex-direction: column; gap: 8px; }
.box.ok { border-color: rgba(34, 197, 94, 0.35); }
.box.bad { border-color: rgba(249, 115, 22, 0.35); }
.warn-line { font-size: 11.5px; color: var(--orange); line-height: 1.7; }
.url-line {
  font-family: var(--mono); font-size: 11.5px; color: var(--cy);
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 9px; word-break: break-all; max-height: 64px; overflow: auto;
}
.pv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-1); }
.stats { display: flex; gap: 10px; }
.stat { flex: 1; text-align: center; padding: 6px 0; border-radius: 8px; font-size: 12px; background: var(--bg-2); border: 1px solid var(--border); }
.stat b { font-size: 15px; margin-left: 4px; }
.stat.green b { color: var(--green); }
.stat.orange b { color: var(--orange); }
.stat.red b { color: var(--red); }
.errs { font-size: 11.5px; line-height: 1.7; color: var(--orange); max-height: 90px; overflow: auto; }
.chip {
  padding: 4px 10px; font-size: 12px; border-radius: 999px;
  background: var(--bg-2); color: var(--text-1); border: 1px solid var(--border); cursor: pointer;
}
.chip:hover { border-color: var(--acc-dim); color: var(--text); }
.chip.on { background: rgba(108, 124, 255, 0.16); border-color: var(--acc-dim); color: #fff; }
.err { font-size: 12px; color: var(--red); }
</style>
