<script setup lang="ts">
/**
 * `#359` **源变量**（对齐 Legado「设置源变量」）—— 一个源一个 JSON 袋，源脚本用
 * `source.getVariable()` / `Get('键')` 读它。
 *
 * ## 为什么要有这个界面
 * qyyuapi 那一类聚合源（`Movieffm` / `剧迷` / `西瓜卡通` / `袋鼠影视` / `爱动漫网`）的
 * `sourceUrl` 写成 `名@js:Get('url')...`，而它们的 jsLib 里 `Get` 的定义就是：
 *
 *     function Get(e) { var get = JSON.parse(source.getVariable()); return get[e]; }
 *
 * ⇒ **源变量为空 ⇒ `JSON.parse('')` ⇒ `Unexpected end of JSON input`**，整源不可用。
 * 这不是解析缺陷：上游 `BaseSource.getVariable()` 同样是
 * `CacheManager.get("sourceVariable_…") ?: ""`（`BaseSource.kt:351`），
 * App 端也是用户在「设置源变量」里手动填的（`RssSortActivity:318/411`）。
 * 服务端 `/api/sources/:id/variable` 早就有 GET/POST，**缺的只是能填的地方**。
 *
 * ★ 判据纪律：本组件只做「取 / 存 / 校验 JSON」，不猜变量结构 ——
 *   键名与内容由源作者规定（通常写在 `variableComment`），我们如实透传。
 */
import { onMounted, ref } from 'vue';
import { getSourceVariable, setSourceVariable } from '../api';

const props = defineProps<{ id: string; name?: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', value: string): void }>();

const text = ref('');
const loading = ref(true);
const saving = ref(false);
const err = ref('');
const ok = ref('');

onMounted(async () => {
  try {
    text.value = await getSourceVariable(props.id);
  } catch (e) {
    err.value = '读取失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
});

/** 非空必须是合法 JSON —— 存个坏串进去会让 `Get()` 抛更难懂的错（兜底必须留痕） */
function jsonError(): string {
  const t = text.value.trim();
  if (!t) return '';
  try {
    JSON.parse(t);
    return '';
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
}

async function save(): Promise<void> {
  const bad = jsonError();
  if (bad) {
    err.value = '不是合法 JSON：' + bad;
    return;
  }
  saving.value = true;
  err.value = '';
  ok.value = '';
  try {
    const v = await setSourceVariable(props.id, text.value.trim());
    text.value = v;
    ok.value = v ? '已保存。回到发现页刷新该源即可生效。' : '已清空（源脚本再读就是空串）。';
    emit('saved', v);
  } catch (e) {
    err.value = '保存失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>⚙ 源变量</b>
        <span class="sub">{{ props.name || props.id }}</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <div class="dlg-body">
        <p class="tip">
          源脚本里 <code>source.getVariable()</code> 读的就是这一份内容（通常是一个 JSON 对象，如
          <code>{ "url": "https://…" }</code>）。<b>键名由源作者规定</b> —— 一般写在源的「变量说明」
          里，或在分享页/源注释中找到。留空 = 脚本读到空串。
        </p>
        <textarea
          v-model="text" class="ta" rows="10" spellcheck="false" data-var-input
          placeholder='{ "url": "https://example.com" }'
          :disabled="loading"
        ></textarea>
        <div v-if="loading" class="hint">读取中…</div>
        <div v-else-if="jsonError()" class="err-text" data-var-err>不是合法 JSON：{{ jsonError() }}</div>
        <div v-else-if="text.trim()" class="hint ok" data-var-ok>格式合法（{{ text.trim().length }} 字符）</div>
        <div v-else class="hint">当前为空 —— 依赖它的源会报「Unexpected end of JSON input」之类的错。</div>
        <div v-if="err" class="err-text">{{ err }}</div>
        <div v-else-if="ok" class="hint ok">{{ ok }}</div>
      </div>

      <div class="dlg-foot">
        <button class="btn sm ghost" @click="emit('close')">关闭</button>
        <button class="btn sm primary" :disabled="saving || loading" @click="save()">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 1300;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4vh 16px;
}
.dlg {
  width: min(620px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  animation: fadein 0.18s ease;
}
.dlg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.28));
}
.dlg-head .sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted, #888);
}
.dlg-body {
  padding: 12px 14px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tip {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--muted, #888);
}
.tip code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.16);
  font-size: 12px;
}
.ta {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font-family: var(--font, monospace);
  font-size: 12.5px;
  line-height: 1.6;
}
.hint { font-size: 12px; color: var(--muted, #888); }
.hint.ok { color: #2e7d32; }
.dlg-foot {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 10px 14px;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.28));
}
@keyframes fadein {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}
</style>
