<script setup lang="ts">
/**
 * `#822` B2 HTTP TTS —— **设置页「朗读」分区**。
 *
 * 用户 2026-11-06 拍板的三条口径，在界面上各有落点：
 *  ① **总开关默认关**：`cfg.enabled` 缺省 false，界面不预设、不自动打开；
 *     打开后**还必须选默认引擎**才可用（列表里点「设为默认」）。
 *  ② **允许 `@js:` 但默认折叠**：带脚本的引擎在列表里只显示一行「展开脚本」，
 *     用户主动点开才看到 `url`/`jsLib` 原文。
 *  ③ **双音色（`#821`）**：总开关**默认关**；开启后可切「主音色 / 副音色」，
 *     副音色未配置时服务端自动回退主音色。切换粒度本轮只做「全局主/副」。
 *
 * 配置字段与 Legado `HttpTTS` 同名，新增/编辑对话框支持整条 JSON 粘贴。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { getTtsConfig, removeTtsEngine, saveTtsEngine, saveTtsSettings, TtsApiError } from '../utils/tts';
import type { TtsConfigView, TtsEngineView } from '../utils/tts';
import type { TtsEngineConfig } from '@yuedu/core/tts';
import { DEFAULT_GAP_MS, GAP_MAX_MS } from '../utils/read-aloud-core';
import { useReadAloudStore } from '../stores/read-aloud';
import { toast } from '../toast';
import TtsEngineDialog from './TtsEngineDialog.vue';

/**
 * `#842` 句间停顿是**朗读偏好**（localStorage），不是服务端 TTS 配置 ⇒ 读写都走朗读 store。
 * 这样设置页改完立刻对阅读页生效，也不需要把偏好塞进 user 端点。
 */
const al = useReadAloudStore();
const gapText = ref(String(al.prefs.gapMs));
watch(() => al.prefs.gapMs, (v) => { gapText.value = String(v); });

function commitGap(): void {
  const n = Math.round(Number(gapText.value));
  if (!Number.isFinite(n)) { gapText.value = String(al.prefs.gapMs); return; }
  al.setGapMs(n); // store 内部 clamp 到 0~800
  gapText.value = String(al.prefs.gapMs);
  toast(`句间停顿：${al.prefs.gapMs} ms${al.prefs.gapMs ? '' : '（紧接）'}`);
}

const cfg = ref<TtsConfigView | null>(null);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const busyId = ref('');
/** 展开脚本的引擎 id（默认空 ⇒ 全部折叠） */
const openScripts = ref<string[]>([]);
const dialog = ref<{ open: boolean; engine: Partial<TtsEngineConfig> | null }>({ open: false, engine: null });

const engines = computed(() => cfg.value?.engines ?? []);
const defaultEngine = computed(() => engines.value.find((e) => e.id === cfg.value?.defaultEngineId));

const defaultHint = computed(() => {
  if (!cfg.value?.enabled) return '总开关关闭：点朗读仍使用系统语音';
  if (!defaultEngine.value) return '已打开，但还没选默认引擎 —— 在下方列表点「设为默认」';
  if (!defaultEngine.value.enabled) return `默认引擎「${defaultEngine.value.name}」未启用 —— 打开它或换一条`;
  return `当前默认：${defaultEngine.value.name}`;
});

/**
 * `#821` 双音色提示：只说**当前会怎样**，不预测用户看不懂的结果。
 * 副槽缺失时明确写「自动回退主音色」—— 这是用户拍板的回退语义。
 */
const dualHint = computed(() => {
  if (!cfg.value?.dualVoice) return '默认关。开启后可在主音色 / 副音色之间切换，关掉即回到单音色。';
  const e = defaultEngine.value;
  if (!e) return '双音色已开，但还没选默认引擎。';
  if (!e.hasSecondary) return `「${e.name}」没有配副音色 ⇒ 选副音色时自动回退主音色（不会报错/静音）。`;
  if (cfg.value.activeVoice === 'secondary') {
    const label = e.secondary?.name?.trim() || '副音色';
    return `当前用「${label}」朗读；切回主音色随时生效。`;
  }
  return '当前用主音色朗读；切到副音色随时生效。';
});

function errText(e: unknown): string {
  return e instanceof TtsApiError ? e.message : `请求失败：${e instanceof Error ? e.message : String(e)}`;
}

/**
 * `#873` 设置面 → 朗读后端的**即时回灌**。
 *
 * 之前只有阅读页「开朗读前」读一次配置 ⇒ 在设置页换默认引擎/开关/音色槽后，
 * 正在念的仍是旧引擎，而且没有任何提示。这里每次保存/删除后立刻让 store 重读配置：
 * 指纹变了就 `cancel()` 作废旧 utterance/预取，再按当前句位置重新开念，并给切换提示。
 */
function syncReader(): void {
  void al.refreshTtsBackend();
}

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  try {
    cfg.value = await getTtsConfig();
    error.value = '';
  } catch (e) {
    error.value = `读取朗读配置失败：${errText(e)}`;
  } finally {
    loading.value = false;
  }
}
onMounted(() => { void load(); });

async function setEnabled(v: boolean): Promise<void> {
  if (!cfg.value || busy.value) return;
  busy.value = true;
  try {
    cfg.value = (await saveTtsSettings({ enabled: v })).config;
    syncReader();
    toast(v ? '在线朗读已打开（还需要选一条默认引擎）' : '在线朗读已关闭，朗读回到系统语音');
  } catch (e) {
    toast(`保存失败：${errText(e)}`, 'warn');
  } finally {
    busy.value = false;
  }
}

/**
 * `#821` 双音色总开关。
 * ★ 关掉时**只改开关**，不动 `activeVoice` —— 用户下次打开还回到上次选的那个槽。
 */
async function setDualVoice(v: boolean): Promise<void> {
  if (!cfg.value || busy.value) return;
  busy.value = true;
  try {
    cfg.value = (await saveTtsSettings({ dualVoice: v })).config;
    syncReader();
    toast(v ? '双音色已开启：可在主音色 / 副音色之间切换' : '双音色已关闭：回到单音色（主音色）');
  } catch (e) {
    toast(`保存失败：${errText(e)}`, 'warn');
  } finally {
    busy.value = false;
  }
}

/** 主 / 副音色切换（持久化到 `activeVoice`；副槽缺失由服务端回退） */
async function setVoiceSlot(slot: 'primary' | 'secondary'): Promise<void> {
  if (!cfg.value || busy.value || cfg.value.activeVoice === slot) return;
  busy.value = true;
  try {
    cfg.value = (await saveTtsSettings({ activeVoice: slot })).config;
    syncReader();
    toast(slot === 'secondary' ? '已切换到副音色' : '已切换到主音色');
  } catch (e) {
    toast(`切换失败：${errText(e)}`, 'warn');
  } finally {
    busy.value = false;
  }
}

async function setDefault(id: string): Promise<void> {
  if (!cfg.value || busy.value) return;
  busy.value = true;
  try {
    cfg.value = (await saveTtsSettings({ defaultEngineId: id })).config;
    syncReader();
    const name = engines.value.find((e) => e.id === id)?.name;
    toast(name ? `默认朗读引擎：${name}` : '已取消默认朗读引擎');
  } catch (e) {
    toast(`保存失败：${errText(e)}`, 'warn');
  } finally {
    busy.value = false;
  }
}

async function toggleEngine(e: TtsEngineView): Promise<void> {
  if (busyId.value) return;
  busyId.value = e.id;
  try {
    await saveTtsEngine({ ...e, enabled: !e.enabled });
    await load(true);
    syncReader();
    toast(e.enabled ? `已停用「${e.name}」` : `已启用「${e.name}」`);
  } catch (err) {
    toast(`保存失败：${errText(err)}`, 'warn');
  } finally {
    busyId.value = '';
  }
}

async function del(e: TtsEngineView): Promise<void> {
  if (busyId.value) return;
  if (!window.confirm(`删除朗读引擎「${e.name}」？`)) return;
  busyId.value = e.id;
  try {
    await removeTtsEngine(e.id);
    await load(true);
    syncReader();
    toast(`已删除「${e.name}」`);
  } catch (err) {
    toast(`删除失败：${errText(err)}`, 'warn');
  } finally {
    busyId.value = '';
  }
}

function hasScript(e: TtsEngineView): boolean {
  return !!e.jsRule || !!e.jsLib || !!e.loginCheckJs
    || (!!e.secondary && (e.secondary.url?.includes('@js:') === true || !!e.secondary.jsLib));
}
function scriptText(e: TtsEngineView): string {
  const parts = [
    e.jsRule ? e.url : '',
    e.jsLib ?? '',
    e.loginCheckJs ? `/* loginCheckJs */\n${e.loginCheckJs}` : '',
    e.secondary?.url && e.secondary.url.includes('@js:') ? e.secondary.url : '',
    e.secondary?.jsLib ?? '',
  ].filter(Boolean);
  return parts.join('\n\n');
}
function isScriptOpen(id: string): boolean {
  return openScripts.value.includes(id);
}
function toggleScript(id: string): void {
  openScripts.value = isScriptOpen(id)
    ? openScripts.value.filter((x) => x !== id)
    : [...openScripts.value, id];
}

function openNew(): void {
  dialog.value = { open: true, engine: null };
}
function openEdit(e: TtsEngineView): void {
  dialog.value = { open: true, engine: { ...e } };
}
function onSaved(): void {
  dialog.value = { open: false, engine: null };
  void load(true);
  syncReader();
  toast('朗读引擎已保存');
}
</script>

<template>
  <h3>朗读</h3>
  <div class="sh-sub">
    `#822` 在线朗读（HTTP TTS）—— 与 Legado `HttpTTS` 同名字段，可直接粘贴一条引擎 JSON。
    总开关**默认关闭**，打开后还要自己选一条默认引擎；`@js:` 引擎的脚本默认折叠。
  </div>

  <p v-if="error" class="tts-banner err">
    {{ error }}
    <button class="btn mini" @click="load()">重试</button>
  </p>

  <div v-if="loading" class="tts-banner">读取配置中…</div>

  <template v-else-if="cfg">
    <div class="tts-row">
      <div class="tts-info">
        <b>总开关</b>
        <span>默认关闭。关掉时朗读回到浏览器系统语音，不会请求任何在线引擎。</span>
      </div>
      <div
        class="switch" :class="{ on: cfg.enabled }" role="switch"
        :aria-checked="cfg.enabled" data-tts-enabled @click="setEnabled(!cfg.enabled)"
      ></div>
    </div>

    <div class="tts-row">
      <div class="tts-info">
        <b>默认引擎</b>
        <span>{{ defaultHint }}</span>
      </div>
      <select
        class="tts-select" data-tts-default :value="cfg.defaultEngineId"
        @change="setDefault(($event.target as HTMLSelectElement).value)"
      >
        <option value="">未选择</option>
        <option
          v-for="e in engines" :key="e.id" :value="e.id"
          :disabled="!e.enabled && e.id !== cfg.defaultEngineId"
        >{{ e.name }}{{ e.enabled ? '' : '（未启用）' }}</option>
      </select>
    </div>

    <div class="tts-row">
      <div class="tts-info">
        <b>双音色</b>
        <span>总开关默认关闭。开启后可切主/副音色；副音色没配时自动回退主音色。</span>
      </div>
      <div
        class="switch" :class="{ on: cfg.dualVoice }" role="switch"
        :aria-checked="cfg.dualVoice" data-tts-dual @click="setDualVoice(!cfg.dualVoice)"
      ></div>
    </div>

    <div v-if="cfg.dualVoice" class="tts-row">
      <div class="tts-info">
        <b>当前音色</b>
        <span>{{ dualHint }}</span>
      </div>
      <div class="tts-slots" role="radiogroup" aria-label="当前音色">
        <button
          class="btn mini" :class="{ primary: cfg.activeVoice === 'primary' }"
          data-tts-slot="primary" :disabled="busy"
          @click="setVoiceSlot('primary')"
        >主音色</button>
        <button
          class="btn mini" :class="{ primary: cfg.activeVoice === 'secondary' }"
          data-tts-slot="secondary" :disabled="busy"
          @click="setVoiceSlot('secondary')"
        >副音色{{ defaultEngine && !defaultEngine.hasSecondary ? '（回退）' : '' }}</button>
      </div>
    </div>

    <div class="tts-row">
      <div class="tts-info">
        <b>句间停顿</b>
        <span>两段朗读之间留白 0~{{ GAP_MAX_MS }} ms，0 = 紧接；默认 {{ DEFAULT_GAP_MS }} ms。引擎配了 `pauseDuration`（&gt;0）时优先用引擎值。</span>
      </div>
      <div class="tts-gap">
        <input
          class="tts-select" data-tts-gap type="number"
          min="0" :max="GAP_MAX_MS" step="10"
          v-model="gapText" @change="commitGap" @keyup.enter="commitGap"
        />
        <span class="tts-unit">ms</span>
      </div>
    </div>

    <div class="tts-bar">
      <button class="btn sm" data-tts-add @click="openNew">＋ 新增引擎</button>
      <span class="tts-count">共 {{ engines.length }} 条</span>
      <span class="tts-hint">发布包不内置任何引擎，需要自己添加</span>
    </div>

    <p v-if="!engines.length" class="tts-empty">
      还没有朗读引擎。点「新增引擎」，或把一条 Legado HttpTTS JSON 粘贴进对话框。
    </p>

    <div v-for="e in engines" :key="e.id" class="tts-card" :class="{ off: !e.enabled }">
      <div class="tts-card-head">
        <b>{{ e.name }}</b>
        <span v-if="cfg.defaultEngineId === e.id" class="tag acc">默认</span>
        <span class="tag" :class="e.enabled ? 'green' : 'red'">{{ e.enabled ? '已启用' : '未启用' }}</span>
        <span v-if="e.jsRule" class="tag gold">@js</span>
        <span v-if="e.method === 'POST'" class="tag cy">POST</span>
        <span v-if="e.hasSecondary" class="tag green">副音色</span>
        <span v-if="e.pauseDuration" class="tag cy">停顿 {{ e.pauseDuration }}ms</span>
        <span v-if="e.concurrentRate" class="tag">限速 {{ e.concurrentRate }}</span>
        <span v-if="e.enabledCookieJar" class="tag">Cookie</span>
        <span v-if="e.loginUrl" class="tag">登录</span>
      </div>
      <div class="tts-url" :title="e.url">{{ e.url }}</div>
      <div v-if="e.remark" class="tts-remark">{{ e.remark }}</div>

      <!-- `@js:` / jsLib：默认折叠，用户主动展开才显示脚本文本 -->
      <div v-if="hasScript(e)" class="tts-script">
        <button class="tts-script-btn" :aria-expanded="isScriptOpen(e.id)" @click="toggleScript(e.id)">
          {{ isScriptOpen(e.id) ? '▾ 收起脚本' : '▸ 展开脚本' }}
        </button>
        <pre v-if="isScriptOpen(e.id)" class="tts-code">{{ scriptText(e) }}</pre>
      </div>

      <div class="tts-card-foot">
        <button
          class="btn mini" :disabled="busy || cfg.defaultEngineId === e.id"
          @click="setDefault(e.id)"
        >设为默认</button>
        <button class="btn mini" :disabled="busyId === e.id" @click="toggleEngine(e)">
          {{ e.enabled ? '停用' : '启用' }}
        </button>
        <button class="btn mini" :disabled="busyId === e.id" @click="openEdit(e)">编辑</button>
        <button class="btn mini tts-del" :disabled="busyId === e.id" @click="del(e)">删除</button>
      </div>
    </div>

    <p class="tts-hint tts-foot">
      双音色状态：已实现 · 默认关 · 观察中（连续 4 天无错后再默认启用，见 backlog `#821`）。
      切换粒度本轮只做「全局主/副」；按角色（旁白/对话）自动分流留待后续。
    </p>
  </template>

  <TtsEngineDialog
    v-if="dialog.open"
    :engine="dialog.engine"
    @close="dialog = { open: false, engine: null }"
    @saved="onSaved"
  />
</template>

<style scoped>
.tts-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 0 0 10px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--border); font-size: 12px; color: var(--muted);
}
.tts-banner.err { color: var(--red); border-color: rgba(255, 84, 112, 0.35); background: rgba(255, 84, 112, 0.08); }
.tts-row {
  display: flex; justify-content: space-between; align-items: center; gap: 20px;
  padding: 13px 0; border-bottom: 1px solid var(--border);
}
.tts-info b { font-size: 13px; display: block; color: var(--text-0); }
.tts-info span { font-size: 11px; color: var(--muted); margin-top: 3px; display: block; line-height: 1.6; }
.tts-select {
  width: 220px; background: var(--bg-3); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 12px; color: var(--text); font-size: 12px; outline: none;
}
.tts-select:focus { border-color: var(--acc-dim); }
.tts-slots { display: flex; gap: 6px; flex-shrink: 0; }
.tts-slots .btn.primary { border-color: var(--acc-dim); color: var(--text-0); background: var(--bg-3); }
.tts-gap { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.tts-gap .tts-select { width: 96px; }
.tts-unit { color: var(--text-2); font-size: 12px; }

.tts-bar { display: flex; align-items: center; gap: 10px; margin: 12px 0 10px; flex-wrap: wrap; }
.tts-count { font-size: 11.5px; color: var(--muted); }
.tts-hint { font-size: 11.5px; color: var(--muted); line-height: 1.7; }
.tts-empty {
  padding: 18px 12px; text-align: center; font-size: 12px; color: var(--muted);
  border: 1px dashed var(--border-strong); border-radius: 10px;
}

.tts-card {
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-0);
  padding: 10px 12px; margin-bottom: 10px;
}
.tts-card.off { opacity: 0.72; }
.tts-card-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tts-card-head b { font-size: 13px; color: var(--text-0); }
.tts-url {
  margin-top: 5px; font-family: var(--mono); font-size: 11.5px; color: var(--cy);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tts-remark { margin-top: 4px; font-size: 11px; color: var(--faint); }
.tts-script { margin-top: 7px; }
.tts-script-btn {
  border: none; background: transparent; color: var(--muted); cursor: pointer;
  font-size: 11.5px; padding: 2px 0;
}
.tts-script-btn:hover { color: var(--text-0); }
.tts-code {
  margin: 6px 0 0; padding: 8px 10px; max-height: 220px; overflow: auto;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: 8px;
  font-family: var(--mono); font-size: 11px; color: var(--text-1);
  white-space: pre-wrap; word-break: break-all;
}
.tts-card-foot { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
.tts-del { color: var(--red); }
.tts-del:hover { border-color: var(--red); }
.tts-foot { margin-top: 14px; }
</style>
