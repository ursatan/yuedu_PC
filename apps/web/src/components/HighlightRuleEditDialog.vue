<script setup lang="ts">
/**
 * **高亮规则编辑对话框** —— `#262`（上游 `HighlightRuleEditDialog` 的 Web 承载）。
 *
 * ## 字段（全部来自契约 `HighlightRule`，上游 `HighlightRule.kt:23-41`）
 * name / pattern / isRegex / scope / applyToTitle / applyToBody / timeoutMillisecond / style。
 * ⚠️ 上游编辑框里**没有** isEnabled / id / uuid / order：isEnabled 在列表页管理、
 * id/uuid/order 由系统分配 —— 本对话框同样不露这三样。
 *
 * ## 样式
 * 上游「样式」按钮打开独立的 HighlightStyleDialog（`#256`/`#258` 已有 Web 版）。
 * 这里先用**预设下拉**（`HIGHLIGHT_PRESETS`，上游 7 条）承载——够用且不引入浮层嵌套；
 * 与生效路径同一份 `parseHighlightStyle` / `highlightClass` / `highlightStyleVars`。
 *
 * ## 试匹配预览（对齐上游「保存前校验」+ 本仓 ReplaceRuleDialog 的预览传统）
 * 用与生效**同一条**匹配器（`matchHighlightRules`，core）跑一段样本，展示命中区间——
 * 预览用什么实现、正文渲染就用什么实现，否则预览会骗人。强制按启用试跑。
 */
import { computed, ref, watch } from 'vue';
import type { HighlightRule } from '@yuedu/core/contract';
// ⚠️ 匹配器走深路径（@yuedu/core 根出口连着 user-store 的 node:*，进浏览器 bundle 会炸 build）
import { matchHighlightRules } from '@yuedu/core/highlight-rule-matcher';
import {
  HIGHLIGHT_PRESETS,
  highlightClass,
  highlightStyleVars,
  parseHighlightStyle,
  serializeHighlightStyle,
  visibleHighlightStyle,
} from '../utils/highlight-style';

const props = defineProps<{
  /** 要编辑的规则草稿（调用方负责新建/复制）；`null` ⇒ 不渲染内容 */
  rule: HighlightRule | null;
  /** 新建态（只影响标题文案） */
  creating?: boolean;
}>();
const emit = defineEmits<{ close: []; save: [rule: HighlightRule] }>();

const draft = ref<HighlightRule | null>(props.rule ? { ...props.rule } : null);
watch(
  () => props.rule,
  (r) => { draft.value = r ? { ...r } : null; },
);

/** 当前样式解析结果（style JSON 草稿的双向视图） */
const styleIdx = computed({
  get: () => {
    const d = draft.value;
    if (!d) return 0;
    const s = serializeHighlightStyle(visibleHighlightStyle(parseHighlightStyle(d.style)));
    const i = HIGHLIGHT_PRESETS.findIndex((p) => serializeHighlightStyle(p.style) === s);
    return i >= 0 ? i : 0;
  },
  set: (i: number) => {
    const d = draft.value;
    if (!d) return;
    d.style = serializeHighlightStyle(HIGHLIGHT_PRESETS[i]?.style ?? HIGHLIGHT_PRESETS[0].style);
  },
});

/** 预览样本（上限 4000 字：预览是给眼睛看的，不是给正则压测的） */
const sample = ref('');

const previewHits = computed(() => {
  const d = draft.value;
  const s = sample.value;
  if (!d || !s.trim() || !d.pattern) return null;
  // 强制按启用试跑（与 ReplaceRuleDialog 预览同一理由）；整段当正文（titleEnd=0）
  const r = matchHighlightRules(
    s.slice(0, 4000),
    [{
      id: d.id,
      pattern: d.pattern,
      isRegex: d.isRegex,
      timeoutMillisecond: d.timeoutMillisecond,
      applyToTitle: false,
      applyToBody: true,
    }],
    0,
  );
  if (!r.completed) return { hits: 0, incomplete: true as const, segs: [], st: null };
  const st = visibleHighlightStyle(parseHighlightStyle(d.style));
  const text = s.slice(0, 4000);
  // 命中区间 → 交替片段（最多展示前 30 个命中，防样本里爆量把对话框撑爆）
  const shown = r.matches.slice(0, 30);
  const segs: Array<{ text: string; hit: boolean }> = [];
  let cur = 0;
  for (const m of shown) {
    if (m.start > cur) segs.push({ text: text.slice(cur, m.start), hit: false });
    segs.push({ text: text.slice(m.start, m.end), hit: true });
    cur = m.end;
  }
  if (cur < text.length) segs.push({ text: text.slice(cur), hit: false });
  return { hits: r.matches.length, incomplete: false as const, segs, st };
});

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
  <div class="hr-dlg-mask" data-hr-dlg @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="hr-dlg" role="dialog" aria-modal="true">
      <div class="hr-dlg-head">
        <strong>{{ creating ? '新建高亮规则' : '编辑高亮规则' }}</strong>
        <span style="flex: 1"></span>
        <button class="btn mini" data-hr-dlg-cancel @click="emit('close')">关闭</button>
      </div>

      <div v-if="draft" class="hr-dlg-body">
        <div class="hr-grid">
          <label>
            规则名（留空显示匹配内容）
            <input :value="draft.name" data-hr-dlg-name @input="draft.name = str($event)" />
          </label>
          <label>
            样式
            <select v-model.number="styleIdx" data-hr-dlg-style>
              <option v-for="(p, i) in HIGHLIGHT_PRESETS" :key="p.label" :value="i">{{ p.label }}</option>
            </select>
          </label>
          <label class="span2">
            匹配内容（{{ draft.isRegex ? '正则' : '字面量，逐字匹配' }}）
            <input :value="draft.pattern" data-hr-dlg-pattern @input="draft.pattern = str($event)" />
          </label>
          <label class="span2">
            生效范围（包含**书名**或**源 URL** 才对那本书生效；留空 = 全部书）
            <input :value="draft.scope ?? ''" data-hr-dlg-scope @input="draft.scope = str($event) === '' ? null : str($event)" />
          </label>
          <label class="hr-checks span2">
            <span><input type="checkbox" :checked="draft.isRegex" data-hr-dlg-regex @change="draft.isRegex = !draft.isRegex" /> 正则</span>
            <span><input type="checkbox" :checked="draft.applyToBody" data-hr-dlg-body @change="draft.applyToBody = !draft.applyToBody" /> 高亮正文</span>
            <span><input type="checkbox" :checked="draft.applyToTitle" data-hr-dlg-title @change="draft.applyToTitle = !draft.applyToTitle" /> 高亮标题</span>
            <span class="hr-timeout">超时
              <input
                type="number" min="1" :value="draft.timeoutMillisecond" data-hr-dlg-timeout
                @change="draft.timeoutMillisecond = num($event, 3000)"
              /> 毫秒
            </span>
          </label>
        </div>

        <!-- 试匹配：与生效走同一条匹配器（matchHighlightRules），不是另写一份演示逻辑 -->
        <div class="hr-preview">
          <label>
            试匹配样本文本
            <input v-model="sample" data-hr-dlg-sample placeholder="粘一段真实正文或标题，看看会命中多少处" />
          </label>
          <div v-if="previewHits" class="hr-preview-out" data-hr-dlg-preview>
            <span class="hr-preview-label">
              命中 {{ previewHits.hits }} 处
              <em v-if="previewHits.incomplete" class="warn">样本过大或超时，未跑完</em>
              <em v-else-if="previewHits.hits === 0" class="no">无命中</em>
            </span>
            <p>
              <template v-for="(s, i) in previewHits.segs" :key="i">
                <mark
                  v-if="s.hit" class="hr-hit"
                  :class="highlightClass(previewHits.st)" :style="highlightStyleVars(previewHits.st)"
                >{{ s.text }}</mark>
                <template v-else>{{ s.text }}</template>
              </template>
            </p>
          </div>
        </div>

        <p v-if="patternEmpty" class="hr-warn">「匹配内容」不能为空 —— 空规则保存不了。</p>

        <div class="hr-dlg-btns">
          <button class="btn mini" data-hr-dlg-cancel2 @click="emit('close')">取消</button>
          <button class="btn mini primary" :disabled="patternEmpty" data-hr-dlg-save @click="onSave">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hr-dlg-mask {
  position: fixed; inset: 0; z-index: 1200; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px;
}
.hr-dlg {
  width: min(560px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.hr-dlg-head {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.hr-dlg-head strong { font-size: 15px; color: var(--text-0); }
.hr-dlg-body { padding: 14px 16px 16px; overflow: auto; }
.hr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.hr-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-1); }
.hr-grid .span2 { grid-column: span 2; }
.hr-grid input, .hr-grid select {
  background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 5px 8px; font-size: 12.5px;
}
.hr-checks { flex-direction: row !important; gap: 14px !important; flex-wrap: wrap; align-items: center; }
.hr-checks span { display: flex; gap: 4px; align-items: center; }
.hr-timeout input { width: 72px; }
.hr-preview { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.hr-preview label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-1); }
.hr-preview input {
  background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border-strong);
  border-radius: 6px; padding: 5px 8px; font-size: 12.5px;
}
.hr-preview-out {
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px;
  max-height: 140px; overflow: auto;
}
.hr-preview-label { font-size: 12px; color: var(--text-1); display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.hr-preview-label em { font-style: normal; font-size: 11px; padding: 1px 6px; border-radius: 5px; }
.hr-preview-label em.no { background: var(--bg-3); color: var(--muted); }
.hr-preview-label em.warn { background: var(--bg-3); color: var(--warning); }
.hr-preview-out p { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 12.5px; }
.hr-hit { border-radius: 3px; }
.hr-warn { margin: 10px 0 0; font-size: 12px; color: var(--warning); }
.hr-dlg-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
