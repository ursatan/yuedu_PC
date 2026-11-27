<script setup lang="ts">
/**
 * `#208` ⑤ **分享源口令**对话框（源管理 ⋯ 菜单 →「📤 分享口令…」）。
 *
 * 链路（`D5`=B，对齐上游 `SourceSharePassphrase.kt`）：源 json → **直链上传**到网盘
 * → 拿回下载地址 → 把地址混淆成中文口令 → 用户复制口令发给别人。
 *
 * ★ 三种结果必须**分开说**，不能塌成一句「分享失败」：
 *   · 成功  ⇒ 口令 + 下载地址，都能一键复制；
 *   · `unshareable`（409）—— **已经上传成功、但下载地址里含替身字面量导致编不成口令**。
 *     这时**不能把白上传的文件丢掉**：下面照样把 downloadUrl 给出来让用户手动转发
 *     （上游对这种情况是「按钮不显示」；本仓没有「检测 url」的时机，只能事后补救）；
 *   · `upload`（502）—— 网盘拒绝，`detail` 里是网盘原话。
 *
 * ⚠️ 不带「预览/测试」环节：上传是**有副作用**的动作（真往网盘写一个文件），
 *    不给「先看看会怎样」的假按钮。
 */
import { computed, onMounted, ref } from 'vue';
import { shareSourcePassphrase, type SharePassphraseResult } from '../api';

const props = defineProps<{ sourceId: string; sourceName: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const busy = ref(true);
const result = ref<SharePassphraseResult | null>(null);
type FailKind = 'notfound' | 'empty' | 'unshareable' | 'upload' | 'network';
const fail = ref<{ kind: FailKind; message: string; downloadUrl?: string } | null>(null);
const copied = ref('');

const FAIL_TITLE: Record<FailKind, string> = {
  notfound: '源不存在',
  empty: '源内容为空',
  unshareable: '已上传，但地址编不成口令',
  upload: '上传失败',
  network: '连不上服务',
};
const FAIL_ADVICE: Record<FailKind, string> = {
  notfound: '这个源可能已被删除 —— 关掉对话框刷新一下源列表。',
  empty: '源文件是空的（没有内容可分享），先在规则工坊里检查这个源。',
  unshareable: '★ 文件已经上传成功了，只是下载地址里含有「！©¥^」或替身字（比如域名里带「店」「杠」）导致无法编成口令。可以把下面的下载地址直接发给对方，让对方用「导入源 → 粘贴 URL」导入。',
  upload: '网盘拒绝了这次上传。上面是网盘的原话；换一条直链规则（设置 → 源分享）再试。',
  network: '确认本机服务在运行（端口 3000）后重试。',
};

/** 过期文案：0 = 永久（与口令内容同源，不另算） */
const expiryText = computed(() => {
  const t = result.value?.expiresAt ?? 0;
  if (!t) return '永久有效';
  const d = Math.ceil((t - Date.now()) / 86400000);
  const date = new Date(t).toLocaleDateString();
  return d > 0 ? `${date} 到期（还有 ${d} 天）` : `已于 ${date} 过期`;
});

async function copy(text: string, tag: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = tag;
    setTimeout(() => { if (copied.value === tag) copied.value = ''; }, 1600);
  } catch {
    copied.value = 'fail';
    setTimeout(() => { copied.value = ''; }, 2200);
  }
}

async function load(): Promise<void> {
  busy.value = true;
  fail.value = null;
  const out = await shareSourcePassphrase(props.sourceId);
  if (out.ok) result.value = out.value;
  else fail.value = { kind: out.kind, message: out.message, ...(out.downloadUrl ? { downloadUrl: out.downloadUrl } : {}) };
  busy.value = false;
}

async function retry(): Promise<void> {
  result.value = null;
  await load();
}

onMounted(() => void load());
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>📤 分享源口令</b>
        <span class="sub">{{ sourceName || sourceId }}</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <div class="dlg-body">
        <div v-if="busy" class="hint">⟳ 正在上传源文件到网盘并生成口令…</div>

        <!-- 成功 -->
        <template v-else-if="result">
          <div class="ok-bar" data-share-ok>✓ 上传成功 · {{ result.summary }}</div>

          <div class="lab">口令（复制这一整段发给对方）</div>
          <textarea class="ta" rows="3" readonly data-share-passphrase :value="result.passphrase"></textarea>
          <div class="row">
            <button class="btn sm primary" @click="copy(result.passphrase, 'pp')">
              {{ copied === 'pp' ? '✓ 已复制' : '复制口令' }}
            </button>
            <span class="hint">{{ expiryText }}</span>
          </div>

          <div class="lab" style="margin-top: 4px">下载地址（对方也可用「导入源 → 粘贴 URL」直接导入）</div>
          <div class="url-line" data-share-url :title="result.downloadUrl">{{ result.downloadUrl }}</div>
          <div class="row">
            <button class="btn sm" @click="copy(result.downloadUrl, 'url')">
              {{ copied === 'url' ? '✓ 已复制' : '复制链接' }}
            </button>
          </div>

          <details class="det">
            <summary>上传实况（排障用）</summary>
            <div class="kv"><span>文件名</span><b>{{ result.upload.fileName }}</b></div>
            <div class="kv"><span>大小</span><b>{{ (result.upload.byteLength / 1024).toFixed(1) }} KB{{ result.upload.compressed ? '（已 zip 压缩）' : '' }}</b></div>
            <div class="kv"><span>真正打到</span><b class="mono">{{ result.upload.requestUrl }}</b></div>
            <div class="kv"><span>响应</span><b class="mono">{{ (result.upload.responseBody || '').slice(0, 300) || '（空）' }}</b></div>
          </details>
        </template>

        <!-- 失败（分类） -->
        <template v-else-if="fail">
          <div class="fail-bar">⚠ {{ FAIL_TITLE[fail.kind] }}</div>
          <div class="hint" style="white-space: pre-wrap">{{ FAIL_ADVICE[fail.kind] }}</div>
          <div class="detail-box"><b>服务端原话：</b>{{ fail.message }}</div>

          <!-- ★ unshareable 时链接仍要交出去：上传是真花了流量的 -->
          <template v-if="fail.downloadUrl">
            <div class="lab">下载地址（文件已上传，可直接发给别人）</div>
            <div class="url-line" :title="fail.downloadUrl">{{ fail.downloadUrl }}</div>
            <button class="btn sm" @click="copy(fail.downloadUrl!, 'url2')">
              {{ copied === 'url2' ? '✓ 已复制' : '复制链接' }}
            </button>
          </template>
        </template>
      </div>

      <div class="dlg-foot">
        <button class="btn sm ghost" :disabled="busy" @click="retry">重新分享</button>
        <button class="btn sm" @click="emit('close')">关闭</button>
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
.dlg { width: min(640px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
.dlg-head .sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.dlg-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
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
.ok-bar { font-size: 12.5px; color: var(--green); background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 8px 10px; }
.fail-bar { font-size: 12.5px; color: var(--orange); background: rgba(249, 115, 22, 0.1); border: 1px solid rgba(249, 115, 22, 0.3); border-radius: 8px; padding: 8px 10px; }
.detail-box { font-size: 11.5px; color: var(--text-1); background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; word-break: break-all; }
.url-line {
  font-family: var(--mono); font-size: 11.5px; color: var(--cy);
  background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; word-break: break-all; max-height: 72px; overflow: auto;
}
.det { margin-top: 4px; font-size: 11.5px; color: var(--muted); }
.det summary { cursor: pointer; }
.kv { display: flex; gap: 8px; padding: 3px 0; }
.kv span { color: var(--muted); min-width: 60px; }
.kv b { color: var(--text-1); font-weight: 500; word-break: break-all; }
.mono { font-family: var(--mono); font-size: 11px; }
</style>
