<script setup lang="ts">
/**
 * **替换（净化）规则编辑对话框** —— 三处**共用唯一一份**（`#260`）。
 *
 * ## 为什么必须共用一个组件
 * 用户 2026-10-04 明确要求「三处替换规则编辑对话框共用」。在那之前本仓有**两份**：
 *   · 设置 → 净化：在列表**下方就地展开**一段编辑区（`ReplaceRulesPanel.vue` 的 `.rr-edit`）；
 *   · 阅读界面选区工具条「替换」：弹一个**只有 4 个字段**的简化弹窗（`ReaderOverlay` 的 `.rd-dlg-replace`）。
 * 两份必然漂移：简化弹窗连「排除范围 / 启用 / 超时 / 分组」都没有 —— 用户从阅读界面建的规则
 * 缺字段、还得回设置页补。共用后「字段清单」只有一份。
 *
 * ## 与上游的对应
 * 上游编辑页是 `ReplaceEditActivity`（独立页面，字段见 `activity_replace_edit.xml`），
 * 本仓 Web 端用**对话框**承载（同一份字段语义）。字段名与默认值一律取自契约
 * `@yuedu/core/contract` 的 `ReplaceRule`（照 `ReplaceRule.kt:26-65` 逐条提取）。
 *
 * ## 预览
 * 上游 `ReplaceEditActivity` 有「输入样本 → 实时显示替换结果」（`ReplacePreview.kt`，250ms 防抖）。
 * 这里做一个**同步**的简化版（同一条纯函数 `applyReplaceRules`，与本仓真正生效的路径**同一份实现**
 * —— 预览用什么、生效就用什么，否则预览会骗人）。防抖在这里没有必要：只跑一条规则、样本还有长度上限。
 *
 * ⚠️ 预览**不落库、不改任何状态**：`isEnabled` 强制按 `true` 试跑（否则用户一边关着开关一边预览
 * 会以为正则写错了）。
 */
import { computed, ref, watch } from 'vue';
import type { ReplaceRule } from '@yuedu/core/contract';
import { applyReplaceRules } from '../utils/replace-rules';

const props = defineProps<{
  /** 要编辑的规则（新建时调用方传一条 `store.newRule()` 出来的草稿）；`null` ⇒ 不渲染内容 */
  rule: ReplaceRule | null;
  /** 新建态（只影响标题/按钮文案） */
  creating?: boolean;
}>();
const emit = defineEmits<{ close: []; save: [rule: ReplaceRule] }>();

/** 本地草稿：**改的是副本**，取消时原对象一字不动（避免「点了取消其实已经改了」） */
const draft = ref<ReplaceRule | null>(props.rule ? { ...props.rule } : null);
watch(
  () => props.rule,
  (r) => { draft.value = r ? { ...r } : null; },
);

/** 预览样本（上游 `etPreviewInput`）。上限 4000 字：预览是给眼睛看的，不是给正则压测的 */
const sample = ref('');

const previewOut = computed(() => {
  const d = draft.value;
  const s = sample.value;
  if (!d || !s.trim()) return '';
  // 强制启用：预览要能试跑「还没保存/暂未启用」的规则（上游预览同样不看 `isEnabled`）
  return applyReplaceRules(s.slice(0, 4000), [{ ...d, isEnabled: true }]).text;
});
const previewChanged = computed(() => !!sample.value.trim() && previewOut.value !== sample.value.slice(0, 4000));

const patternEmpty = computed(() => !draft.value?.pattern.trim());

function onSave(): void {
  const d = draft.value;
  if (!d || !d.pattern.trim()) return;
  emit('save', { ...d });
}
const str = (e: Event): string => (e.target as HTMLInputElement).value;
const num = (e: Event, fallback: number): number => {
  const n = Number((e.target as HTMLInputElement).value);
  return Number.isFinite(n) ? n : fallback;
};
</script>

<template>
  <div class="rr-dlg-mask" data-rr-dlg @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="rr-dlg" role="dialog" aria-modal="true">
      <div class="rr-dlg-head">
        <strong>{{ creating ? '新增净化规则' : '编辑净化规则' }}</strong>
        <span style="flex: 1"></span>
        <button class="btn mini" data-rr-dlg-cancel @click="emit('close')">关闭</button>
      </div>

      <div v-if="draft" class="rr-dlg-body">
        <div class="rr-grid">
          <label>
            名称
            <input :value="draft.name" data-rr-dlg-name @input="draft.name = str($event)" />
          </label>
          <label>
            分组
            <input :value="draft.group ?? ''" data-rr-dlg-group @input="draft.group = str($event)" />
          </label>
          <label class="span2">
            查找内容
            <input :value="draft.pattern" data-rr-dlg-pattern @input="draft.pattern = str($event)" />
          </label>
          <label class="span2">
            替换为（留空 = 删除；<code>@js:</code> 开头 = JS 表达式，<code>result</code> 是命中文本）
            <input
              :value="draft.replacement" data-rr-dlg-replacement
              @input="draft.replacement = str($event)"
            />
          </label>
          <label>
            作用范围（书名或来源名，留空 = 所有书）
            <input :value="draft.scope ?? ''" data-rr-dlg-scope @input="draft.scope = str($event)" />
          </label>
          <label>
            排除范围（留空 = 不排除）
            <input
              :value="draft.excludeScope ?? ''" data-rr-dlg-exclude
              @input="draft.excludeScope = str($event)"
            />
          </label>
          <label class="rr-checks span2">
            <span>
              <input
                type="checkbox" :checked="draft.isRegex" data-rr-dlg-regex
                @change="draft.isRegex = !draft.isRegex"
              /> 正则
            </span>
            <span><input type="checkbox" :checked="draft.scopeContent" @change="draft.scopeContent = !draft.scopeContent" /> 作用于正文</span>
            <span><input type="checkbox" :checked="draft.scopeTitle" @change="draft.scopeTitle = !draft.scopeTitle" /> 作用于标题</span>
            <span><input type="checkbox" :checked="draft.isEnabled" data-rr-dlg-enabled @change="draft.isEnabled = !draft.isEnabled" /> 启用</span>
          </label>
          <label>
            超时（毫秒）
            <input
              type="number" min="0" :value="draft.timeoutMillisecond" data-rr-dlg-timeout
              @change="draft.timeoutMillisecond = num($event, 3000)"
            />
          </label>
        </div>

        <!-- 预览：与生效走**同一条**纯函数（`applyReplaceRules`），不是另写一份演示逻辑 -->
        <div class="rr-preview">
          <label>
            预览样本文本
            <input v-model="sample" data-rr-dlg-sample placeholder="粘一段真实正文，看看会不会被这条规则吃掉太多" />
          </label>
          <div class="rr-preview-out">
            <span class="rr-preview-label">
              替换结果
              <em v-if="sample.trim()" :class="previewChanged ? 'ok' : 'no'">
                {{ previewChanged ? '有改动' : '无改动' }}
              </em>
            </span>
            <pre data-rr-dlg-preview>{{ sample.trim() ? previewOut : '（填了样本才会显示）' }}</pre>
          </div>
        </div>

        <p v-if="patternEmpty" class="rr-warn">「查找内容」不能为空 —— 空规则的 id 会被保留但永不生效。</p>

        <div class="rr-dlg-btns">
          <button class="btn mini" data-rr-dlg-cancel2 @click="emit('close')">取消</button>
          <button class="btn mini primary" :disabled="patternEmpty" data-rr-dlg-save @click="onSave">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩用 `fixed` + 高于阅读浮层（`.se-mask` 是 1000）：同一个组件在设置页与阅读界面都能盖住 */
.rr-dlg-mask {
  position: fixed; inset: 0; z-index: 1200; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px;
}
.rr-dlg {
  width: min(560px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.rr-dlg-head {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.rr-dlg-head strong { font-size: 15px; color: var(--text-0); }
.rr-dlg-body { padding: 14px 16px 16px; overflow: auto; }
.rr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rr-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-1); }
.rr-grid .span2 { grid-column: span 2; }
.rr-grid input {
  background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 5px 8px; font-size: 12.5px;
}
.rr-checks { flex-direction: row !important; gap: 14px !important; flex-wrap: wrap; align-items: center; }
.rr-checks span { display: flex; gap: 4px; align-items: center; }
.rr-preview { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.rr-preview label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-1); }
.rr-preview input {
  background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 5px 8px; font-size: 12.5px;
}
.rr-preview-label { font-size: 12px; color: var(--text-1); display: flex; gap: 8px; align-items: center; }
.rr-preview-label em { font-style: normal; font-size: 11px; padding: 1px 6px; border-radius: 5px; }
.rr-preview-label em.ok { background: rgba(50, 199, 135, 0.16); color: var(--success); }
.rr-preview-label em.no { background: var(--bg-3); color: var(--muted); }
.rr-preview pre {
  margin: 0; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px;
  font-family: var(--mono); font-size: 12px; color: var(--text-0); min-height: 42px;
}
.rr-warn { margin: 10px 0 0; font-size: 12px; color: var(--warning); }
.rr-dlg-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
