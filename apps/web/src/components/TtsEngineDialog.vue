<script setup lang="ts">
/**
 * `#822` B2 HTTP TTS —— **单条引擎的新增/编辑对话框**。
 *
 * 口径：
 *  · 字段名与 Legado `HttpTTS` 同名（`name`/`url`/`contentType`/`header`/`jsLib`/`loginUrl`/`concurrentRate`），
 *    另加本仓扩展（`method`/`body`/`timeoutMs`/`remark`）；
 *  · 支持**整条粘贴**上游 JSON（数组/`{engines:[...]}` 外壳也认，只填第一条）；
 *  · `jsLib` 是脚本 ⇒ **默认折叠**（`<details>` 不展开），一进页面不摊开脚本文本；
 *  · `#821` 副音色槽：勾选「配置副音色」才展开，字段与主槽同名；不勾 = 单音色，保存不带 `secondary`。
 */
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { TTS_LIMITS, type TtsEngineConfig, type TtsVoiceSlotConfig } from '@yuedu/core/tts';
import { parseTtsEngineJson, saveTtsEngine, TtsApiError } from '../utils/tts';

const props = defineProps<{ engine: Partial<TtsEngineConfig> | null }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', engine: TtsEngineConfig): void;
}>();

const form = reactive({
  id: props.engine?.id ?? '',
  name: props.engine?.name ?? '',
  url: props.engine?.url ?? '',
  contentType: props.engine?.contentType ?? '',
  method: props.engine?.method ?? 'GET',
  body: props.engine?.body ?? '',
  header: props.engine?.header ?? '',
  jsLib: props.engine?.jsLib ?? '',
  loginUrl: props.engine?.loginUrl ?? '',
  loginUi: props.engine?.loginUi ?? '',
  loginCheckJs: props.engine?.loginCheckJs ?? '',
  concurrentRate: props.engine?.concurrentRate ?? '',
  pauseDuration: props.engine?.pauseDuration ? String(props.engine.pauseDuration) : '',
  enabledCookieJar: props.engine?.enabledCookieJar === true,
  timeoutMs: props.engine?.timeoutMs ? String(props.engine.timeoutMs) : '',
  remark: props.engine?.remark ?? '',
  enabled: props.engine?.enabled === true,
});
/** 结构化请求头本仓扩展：表单不铺开编辑，编辑时原样保留，粘贴 JSON 时随之带入 */
const keepHeaders = ref<Record<string, string> | undefined>(props.engine?.headers);

/**
 * `#821` 副音色槽（同一条引擎的第二个音色）。
 * `configured=false` ⇒ 保存时**不带** `secondary`（= 单音色，行为与 `#822` 完全一致）。
 * 字段与主槽同名；`url` 留空表示沿用主槽地址、只改其它参数。
 */
const voice2 = reactive({
  configured: !!props.engine?.secondary,
  name: props.engine?.secondary?.name ?? '',
  url: props.engine?.secondary?.url ?? '',
  contentType: props.engine?.secondary?.contentType ?? '',
  method: props.engine?.secondary?.method ?? '',
  body: props.engine?.secondary?.body ?? '',
  header: props.engine?.secondary?.header ?? '',
  jsLib: props.engine?.secondary?.jsLib ?? '',
  timeoutMs: props.engine?.secondary?.timeoutMs ? String(props.engine.secondary.timeoutMs) : '',
  remark: props.engine?.secondary?.remark ?? '',
});
const keepVoice2Headers = ref<Record<string, string> | undefined>(props.engine?.secondary?.headers);

/* 绑定名用常量拼进模板：`{{speakText}}` 直接写在 Vue 模板里会被当成插值 */
const BIND_TEXT = '{{speakText}}';
const BIND_SPEED = '{{speakSpeed}}';
const URL_PLACEHOLDER = `https://…/?text=${BIND_TEXT}&speed=${BIND_SPEED}，也支持 @js: / <js> 形态`;
const PASTE_PLACEHOLDER = `{"name":"示例","url":"https://tts.example.com/?text=${BIND_TEXT}","header":"User-Agent: …"}`;
const BODY_PLACEHOLDER = `POST 体，支持 ${BIND_TEXT} 插值`;

const pasteText = ref('');
const pasteMsg = ref('');
const error = ref('');
const busy = ref(false);
const isNew = !props.engine?.id;

function applyPaste(): void {
  pasteMsg.value = '';
  error.value = '';
  const r = parseTtsEngineJson(pasteText.value);
  if (!r.ok) {
    pasteMsg.value = r.error;
    return;
  }
  const e = r.engine;
  form.id = e.id ?? form.id;
  form.name = e.name ?? '';
  form.url = e.url ?? '';
  form.contentType = e.contentType ?? '';
  form.method = e.method ?? 'GET';
  form.body = e.body ?? '';
  form.header = e.header ?? '';
  form.jsLib = e.jsLib ?? '';
  form.loginUrl = e.loginUrl ?? '';
  form.loginUi = e.loginUi ?? '';
  form.loginCheckJs = e.loginCheckJs ?? '';
  form.concurrentRate = e.concurrentRate ?? '';
  form.pauseDuration = e.pauseDuration ? String(e.pauseDuration) : '';
  form.enabledCookieJar = e.enabledCookieJar === true;
  form.timeoutMs = e.timeoutMs ? String(e.timeoutMs) : '';
  form.remark = e.remark ?? '';
  form.enabled = e.enabled === true;
  keepHeaders.value = e.headers;
  // `#821` 粘贴带 `secondary`（或别名 `voice2`）时一起填入；没有就清空 = 单音色
  voice2.configured = !!e.secondary;
  voice2.name = e.secondary?.name ?? '';
  voice2.url = e.secondary?.url ?? '';
  voice2.contentType = e.secondary?.contentType ?? '';
  voice2.method = e.secondary?.method ?? '';
  voice2.body = e.secondary?.body ?? '';
  voice2.header = e.secondary?.header ?? '';
  voice2.jsLib = e.secondary?.jsLib ?? '';
  voice2.timeoutMs = e.secondary?.timeoutMs ? String(e.secondary.timeoutMs) : '';
  voice2.remark = e.secondary?.remark ?? '';
  keepVoice2Headers.value = e.secondary?.headers;
  pasteMsg.value = `已填入${r.note ? `（${r.note}）` : ''}；请确认后再保存`;
}

/** 副音色表单 → 落盘对象；没勾选/没填任何请求字段 ⇒ undefined（= 单音色） */
function secondaryPayload(): TtsVoiceSlotConfig | undefined {
  if (!voice2.configured) return undefined;
  const slot: TtsVoiceSlotConfig = {
    ...(voice2.name.trim() ? { name: voice2.name.trim() } : {}),
    ...(voice2.url.trim() ? { url: voice2.url.trim() } : {}),
    ...(voice2.contentType.trim() ? { contentType: voice2.contentType.trim() } : {}),
    ...(voice2.method ? { method: voice2.method as 'GET' | 'POST' } : {}),
    ...(voice2.body.trim() ? { body: voice2.body } : {}),
    ...(voice2.header.trim() ? { header: voice2.header } : {}),
    ...(keepVoice2Headers.value && Object.keys(keepVoice2Headers.value).length
      ? { headers: keepVoice2Headers.value }
      : {}),
    ...(voice2.jsLib.trim() ? { jsLib: voice2.jsLib } : {}),
    ...(voice2.timeoutMs.trim() ? { timeoutMs: Number(voice2.timeoutMs) } : {}),
    ...(voice2.remark.trim() ? { remark: voice2.remark.trim() } : {}),
  };
  const configured = !!slot.url || !!slot.contentType || !!slot.method || !!slot.body
    || !!slot.header || !!slot.headers || !!slot.jsLib || slot.timeoutMs != null;
  return configured ? slot : undefined;
}

async function submit(): Promise<void> {
  error.value = '';
  if (!form.name.trim()) {
    error.value = '请填写引擎名';
    return;
  }
  if (!form.url.trim()) {
    error.value = '请填写请求地址';
    return;
  }
  busy.value = true;
  try {
    const v2 = secondaryPayload();
    const payload: Partial<TtsEngineConfig> = {
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim(),
      url: form.url.trim(),
      enabled: form.enabled,
      ...(form.contentType.trim() ? { contentType: form.contentType.trim() } : {}),
      ...(form.method === 'POST' ? { method: 'POST' as const } : {}),
      ...(form.body.trim() ? { body: form.body } : {}),
      ...(form.header.trim() ? { header: form.header } : {}),
      ...(keepHeaders.value && Object.keys(keepHeaders.value).length ? { headers: keepHeaders.value } : {}),
      ...(form.jsLib.trim() ? { jsLib: form.jsLib } : {}),
      ...(form.loginUrl.trim() ? { loginUrl: form.loginUrl.trim() } : {}),
      ...(form.loginUi.trim() ? { loginUi: form.loginUi.trim() } : {}),
      ...(form.loginCheckJs.trim() ? { loginCheckJs: form.loginCheckJs } : {}),
      ...(form.concurrentRate.trim() ? { concurrentRate: form.concurrentRate.trim() } : {}),
      ...(form.pauseDuration.trim() ? { pauseDuration: Number(form.pauseDuration) } : {}),
      ...(form.enabledCookieJar ? { enabledCookieJar: true } : {}),
      ...(form.timeoutMs.trim() ? { timeoutMs: Number(form.timeoutMs) } : {}),
      ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
      ...(v2 ? { secondary: v2 } : {}),
    };
    const r = await saveTtsEngine(payload);
    emit('saved', r.engine);
  } catch (e) {
    error.value = e instanceof TtsApiError
      ? e.message
      : `保存失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="mask tts-mask" @click.self="emit('close')">
    <div class="tts-dlg" role="dialog" aria-modal="true">
      <div class="tts-dlg-head">
        <b>{{ isNew ? '新增朗读引擎' : '编辑朗读引擎' }}</b>
        <button class="tts-x" title="关闭" aria-label="关闭" @click="emit('close')">✕</button>
      </div>

      <!-- 粘贴入口：新增时默认展开；编辑时收起（避免一进来就被一大段 JSON 占满） -->
      <details class="tts-paste" :open="isNew">
        <summary>从 Legado HttpTTS JSON 粘贴（支持数组 / engines 外壳）</summary>
        <textarea
          v-model="pasteText" class="tts-input tts-paste-box" rows="5"
          :placeholder="PASTE_PLACEHOLDER"
        ></textarea>
        <div class="tts-paste-foot">
          <button class="btn mini" :disabled="!pasteText.trim()" @click="applyPaste">解析并填入</button>
          <span v-if="pasteMsg" class="tts-paste-msg">{{ pasteMsg }}</span>
        </div>
      </details>

      <div class="tts-fields">
        <label class="tts-field">
          <span>名称 <i>*</i></span>
          <input v-model="form.name" class="tts-input" :maxlength="TTS_LIMITS.name" placeholder="例如 微软在线朗读" />
        </label>

        <label class="tts-field">
          <span>请求地址 <i>*</i></span>
          <textarea
            v-model="form.url" class="tts-input tts-url" rows="3" :maxlength="TTS_LIMITS.url"
            :placeholder="URL_PLACEHOLDER"
          ></textarea>
          <small class="tts-hint">
            支持 <code>{{ BIND_TEXT }}</code> / <code>{{ BIND_SPEED }}</code> 与
            <code>@js:</code> / <code>&lt;js&gt;</code>（脚本在引擎列表里默认折叠，这里必须能编辑）
          </small>
        </label>

        <div class="tts-grid">
          <label class="tts-field">
            <span>contentType</span>
            <input v-model="form.contentType" class="tts-input" placeholder="如 audio/mpeg（留空按回传头）" />
          </label>
          <label class="tts-field">
            <span>method</span>
            <select v-model="form.method" class="tts-input">
              <option value="GET">GET（默认）</option>
              <option value="POST">POST</option>
            </select>
          </label>
          <label class="tts-field">
            <span>timeoutMs</span>
            <input
              v-model="form.timeoutMs" class="tts-input" inputmode="numeric"
              :placeholder="`${TTS_LIMITS.timeoutDefault}（默认）`"
            />
          </label>
        </div>

        <label v-if="form.method === 'POST'" class="tts-field">
          <span>body</span>
          <textarea v-model="form.body" class="tts-input" rows="3" :maxlength="TTS_LIMITS.body" :placeholder="BODY_PLACEHOLDER"></textarea>
        </label>

        <label class="tts-field">
          <span>header（Legado 原文）</span>
          <textarea
            v-model="form.header" class="tts-input" rows="3" :maxlength="TTS_LIMITS.headerRaw"
            placeholder="逐行 Key: Value，或一段 JSON 对象"
          ></textarea>
        </label>

        <!-- 脚本/高级配置默认折叠：用户主动展开才看到 -->
        <details class="tts-adv">
          <summary>高级（jsLib / 登录 / 并发 / 段间静音 / 备注）{{ form.jsLib.trim() ? ' · 含脚本' : '' }}</summary>
          <label class="tts-field">
            <span>jsLib</span>
            <textarea v-model="form.jsLib" class="tts-input tts-code" rows="6" :maxlength="TTS_LIMITS.jsLib" placeholder="@js 前导脚本（默认折叠，不影响普通引擎）"></textarea>
          </label>
          <div class="tts-grid">
            <label class="tts-field">
              <span>loginUrl（只存不跑）</span>
              <input v-model="form.loginUrl" class="tts-input" placeholder="Legado loginUrl（登录窗后续接入）" />
            </label>
            <label class="tts-field">
              <span>concurrentRate（生效）</span>
              <input v-model="form.concurrentRate" class="tts-input" placeholder="如 1/1500，0 = 不限" />
            </label>
            <label class="tts-field">
              <span>pauseDuration（毫秒）</span>
              <input
                v-model="form.pauseDuration" class="tts-input" inputmode="numeric"
                :placeholder="`0~${TTS_LIMITS.pauseMax}（0 = 用句间停顿）`"
              />
            </label>
          </div>
          <label class="tts-field">
            <span>loginUi（登录表单 JSON，只存+校验）</span>
            <textarea
              v-model="form.loginUi" class="tts-input tts-code" rows="3" :maxlength="TTS_LIMITS.loginUi"
              placeholder='如 [{"name":"账号","type":"text"},{"name":"密码","type":"password"}]'
            ></textarea>
          </label>
          <label class="tts-field">
            <span>loginCheckJs（响应后校验脚本）</span>
            <textarea
              v-model="form.loginCheckJs" class="tts-input tts-code" rows="4" :maxlength="TTS_LIMITS.loginCheckJs"
              placeholder="检查 response.body / response.headers；返回非空字符串 = 该串作为失败原因；返回空 = 通过"
            ></textarea>
          </label>
          <label class="tts-check">
            <input v-model="form.enabledCookieJar" type="checkbox" />
            启用引擎级 Cookie 罐（收响应 Set-Cookie，下次请求自动带上；按引擎隔离）
          </label>
          <label class="tts-field">
            <span>备注</span>
            <input v-model="form.remark" class="tts-input" :maxlength="200" placeholder="给自己看的说明，不参与请求" />
          </label>
          <p v-if="keepHeaders && Object.keys(keepHeaders).length" class="tts-hint">
            原配置另有 {{ Object.keys(keepHeaders).length }} 条结构化请求头，保存时原样保留（不在表单里展开编辑）。
          </p>
        </details>

        <!-- `#821` 副音色槽：勾选才展开；不勾 = 单音色，保存时不带 secondary -->
        <div class="tts-adv tts-voice2">
          <label class="tts-check">
            <input v-model="voice2.configured" type="checkbox" data-tts-voice2-enabled />
            配置副音色（同一条引擎的第二个音色；不勾选 = 单音色）
          </label>
          <template v-if="voice2.configured">
            <p class="tts-hint">
              字段与主音色同名；未填写的字段继承主音色。地址留空 = 沿用主音色地址、只改其它参数。
              不配置副音色时，朗读切到副音色会自动回退主音色（不会报错/静音）。
            </p>
            <div class="tts-grid">
              <label class="tts-field">
                <span>槽位名</span>
                <input v-model="voice2.name" class="tts-input" :maxlength="TTS_LIMITS.name" placeholder="如 旁白 / 对话" />
              </label>
              <label class="tts-field">
                <span>contentType</span>
                <input v-model="voice2.contentType" class="tts-input" placeholder="如 audio/mpeg（留空继承主音色）" />
              </label>
              <label class="tts-field">
                <span>method</span>
                <select v-model="voice2.method" class="tts-input">
                  <option value="">继承主音色（默认）</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </label>
            </div>
            <label class="tts-field">
              <span>副音色请求地址</span>
              <textarea
                v-model="voice2.url" class="tts-input tts-url" rows="2" :maxlength="TTS_LIMITS.url"
                :placeholder="`留空 = 沿用主音色地址；支持 ${BIND_TEXT} / @js:`"
              ></textarea>
            </label>
            <label class="tts-field">
              <span>timeoutMs</span>
              <input
                v-model="voice2.timeoutMs" class="tts-input" inputmode="numeric"
                :placeholder="`留空继承主音色（${TTS_LIMITS.timeoutDefault}）`"
              />
            </label>
            <label v-if="voice2.method === 'POST' || (voice2.method === '' && form.method === 'POST')" class="tts-field">
              <span>副音色 body</span>
              <textarea v-model="voice2.body" class="tts-input" rows="2" :maxlength="TTS_LIMITS.body" :placeholder="BODY_PLACEHOLDER"></textarea>
            </label>
            <label class="tts-field">
              <span>副音色 header</span>
              <textarea
                v-model="voice2.header" class="tts-input" rows="2" :maxlength="TTS_LIMITS.headerRaw"
                placeholder="逐行 Key: Value，或 JSON 对象（留空继承主音色）"
              ></textarea>
            </label>
            <details class="tts-adv">
              <summary>副音色脚本 / 备注{{ voice2.jsLib.trim() ? ' · 含脚本' : '' }}</summary>
              <label class="tts-field">
                <span>副音色 jsLib</span>
                <textarea
                  v-model="voice2.jsLib" class="tts-input tts-code" rows="4" :maxlength="TTS_LIMITS.jsLib"
                  placeholder="只在副音色槽生效的前导脚本（默认折叠）"
                ></textarea>
              </label>
              <label class="tts-field">
                <span>副音色备注</span>
                <input v-model="voice2.remark" class="tts-input" :maxlength="200" placeholder="给自己看的说明，不参与请求" />
              </label>
              <p v-if="keepVoice2Headers && Object.keys(keepVoice2Headers).length" class="tts-hint">
                副音色另有 {{ Object.keys(keepVoice2Headers).length }} 条结构化请求头，保存时原样保留。
              </p>
            </details>
          </template>
        </div>

        <label class="tts-check">
          <input v-model="form.enabled" type="checkbox" />
          启用这条引擎（新建默认关；启用后还要在默认引擎里选中才会出站朗读）
        </label>
      </div>

      <p v-if="error" class="tts-err">{{ error }}</p>

      <div class="tts-dlg-foot">
        <button class="btn sm" :disabled="busy" @click="emit('close')">取消</button>
        <button class="btn sm primary" :disabled="busy" @click="submit">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 1400;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 5vh 16px; overflow: auto;
}
.tts-dlg {
  width: min(660px, 100%);
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 12px;
  box-shadow: var(--shadow); padding: 16px 18px 14px;
  font-size: 12px; color: var(--text-1);
}
.tts-dlg-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.tts-dlg-head b { font-size: 14px; color: var(--text-0); }
.tts-x { border: none; background: transparent; color: var(--muted); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }
.tts-x:hover { color: var(--text-0); background: var(--bg-3); }

.tts-paste { border: 1px dashed var(--border-strong); border-radius: 8px; padding: 8px 10px; margin-bottom: 12px; }
.tts-paste summary { cursor: pointer; font-size: 11.5px; color: var(--muted); }
.tts-paste-box { margin-top: 8px; font-family: var(--mono); font-size: 11.5px; }
.tts-paste-foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.tts-paste-msg { font-size: 11.5px; color: var(--orange); }

.tts-fields { display: flex; flex-direction: column; gap: 10px; }
.tts-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.tts-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.tts-field > span { font-size: 11.5px; color: var(--muted); }
.tts-field > span i { color: var(--red); font-style: normal; }
.tts-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 10px; color: var(--text); font-size: 12px; outline: none; resize: vertical;
}
.tts-input:focus { border-color: var(--acc-dim); }
.tts-url { font-family: var(--mono); font-size: 11.5px; }
.tts-code { font-family: var(--mono); font-size: 11.5px; }
.tts-hint { font-size: 11px; color: var(--faint); line-height: 1.6; }
.tts-hint code { font-family: var(--mono); }

.tts-adv { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.tts-adv summary { cursor: pointer; font-size: 11.5px; color: var(--muted); }
.tts-adv > * + * { margin-top: 10px; }

.tts-check { display: flex; align-items: flex-start; gap: 8px; font-size: 11.5px; color: var(--text-1); line-height: 1.6; cursor: pointer; }
.tts-check input { margin: 2px 0 0; flex-shrink: 0; }
.tts-err {
  margin: 10px 0 0; padding: 7px 10px; border-radius: 8px;
  color: var(--red); border: 1px solid rgba(255, 84, 112, 0.35); background: rgba(255, 84, 112, 0.08);
  white-space: pre-wrap; line-height: 1.6;
}
.tts-dlg-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }

@media (max-width: 640px) {
  .tts-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
