<script setup lang="ts">
/**
 * **起效的替换规则**对话框（`#260`）—— 对齐上游 `EffectiveReplacesDialog`。
 *
 * ## 上游依据（逐条核实）
 * · 入口：阅读菜单 `menu_effective_replaces -> showDialogFragment<EffectiveReplacesDialog>()`
 *   （`ReadBookActivity.kt:905`）；
 * · 数据源：`ReadBook.curTextChapter?.effectiveReplaceRules`（`EffectiveReplacesDialog.kt:59`）
 *   —— 是**当前章**的结论，不是「库里启用的规则」，也不是「这本书选中的规则」；
 * · 「起效」的判据在写入侧：`ContentProcessor.kt:193` `if (mContent != tmp) effectiveReplaceRules.add(item)`
 *   ⇒ 只有**真的改动了正文**的规则才进这个列表；
 * · 点条目 → `ReplaceEditActivity.startIntent(ctx, item.id)`（编辑）；
 * · 点 ✕ → `item.isEnabled = false; appDb.replaceRuleDao.insert(item)`（`EffectiveReplacesDialog.kt:110-111`）
 *   ★ 即：**把那条全局规则停用**（不是「本书不用」）—— 这是上游语义，照抄，但界面必须说清，
 *     否则用户会以为「只对这本书关了」。
 * · 上游还会在开头插一条**繁简转换**伪规则（`chineseConvert`，✕ 时把 `chineseConverterType` 置 0）——
 *   本仓同样列出来：繁简转换也确实会改正文，不列就是「列表不完整、用户以为没生效的东西不在里面」。
 *
 * ## 本仓的两个差异（写清，不藏）
 * ① **只列正文规则**：上游那个 List 也只来自 `getContent()` 的正文替换（标题替换在
 *    `getDisplayTitle()` 里另算，不进这个 List）⇒ 本仓一致。标题专门起效的规则不会出现在这里。
 * ② 关掉一条规则后**立刻用缓存原文重跑本章**（`reloadCurrentChapter()`，不联网）——
 *    净化只在展示时做（缓存存原文），不重跑的话列表里删了、正文却没变，看着像没生效。
 */
import { computed, ref } from 'vue';
import type { ReplaceRule } from '@yuedu/core/contract';
import { useReaderStore } from '../stores/reader';
import { useReplaceRulesStore } from '../stores/replaceRules';
import { isChineseConvertOn } from '../utils/chinese-convert';
import { toast } from '../toast';
import ReplaceRuleDialog from './ReplaceRuleDialog.vue';

const emit = defineEmits<{ close: [] }>();

const r = useReaderStore();
const rr = useReplaceRulesStore();
rr.ensureLoaded();

/** 点开的规则（`null` = 没开编辑弹窗） */
const editing = ref<ReplaceRule | null>(null);

const ids = computed(() => new Set(r.effectiveReplaceIds));
/** 本章起效的规则（按 `order` 排 —— 与真正应用的顺序一致，不另排一套） */
const rows = computed(() => rr.sorted.filter((x) => ids.value.has(x.id)));

/** 简繁转换也是「会改正文」的一环（上游同款伪规则） */
const convertOn = computed(() => isChineseConvertOn(r.prefs.chineseConverterType));
const convertLabel = computed(() => (r.prefs.chineseConverterType === 1 ? '繁体 → 简体' : '简体 → 繁体'));

/** 关闭起效（上游语义：**停用那条全局规则**） */
function disableRule(x: ReplaceRule): void {
  if (!confirm(`关闭「${x.name || x.pattern}」的起效？\n\n这会**停用这条全局净化规则**（设置 → 净化里也会显示为停用），不只是这本书。`)) return;
  rr.upsert({ ...x, isEnabled: false });
  r.reloadCurrentChapter();
  toast(`已停用规则「${x.name || x.pattern}」`, 'ok');
}

/** 关掉繁简转换（上游：`chineseConverterType = 0`） */
function disableConvert(): void {
  r.patchPrefs({ chineseConverterType: 0 });
  r.reloadCurrentChapter();
  toast('已关闭简繁转换', 'ok');
}

function onSaved(x: ReplaceRule): void {
  rr.upsert(x);
  editing.value = null;
  r.reloadCurrentChapter();
  toast('已保存规则（本章已重跑）', 'ok');
}
</script>

<template>
  <div class="eff-mask" data-eff-dlg @click.self="emit('close')">
    <div class="eff-panel" role="dialog" aria-modal="true">
      <div class="eff-head">
        <strong>起效的替换规则</strong>
        <span class="eff-sub">本章正文</span>
        <span style="flex: 1"></span>
        <button class="btn mini" data-eff-close-btn @click="emit('close')">关闭</button>
      </div>

      <div class="eff-body">
        <p class="eff-tip">
          这里列的是**本章真正改动了正文的**规则（不是「库里启用的」）。
          点条目去编辑；点 ✕ 关闭起效 —— ⚠️ 那是**停用这条全局规则**，别的书也不再用它。
        </p>

        <div v-if="!rows.length && !convertOn" class="eff-empty" data-eff-empty>
          本章没有规则起效。可能是：规则里没有匹配上；或这本书的净化开关是关的；或规则的作用范围不含本书。
        </div>

        <div
          v-for="x in rows" :key="x.id" class="eff-row"
          :data-eff-row="x.id" @click="editing = { ...x }"
        >
          <span class="eff-name" :data-eff-name="x.id">{{ x.name || '(未命名)' }}</span>
          <span v-if="x.group" class="tag">{{ x.group }}</span>
          <code class="eff-pat">{{ x.pattern }}</code>
          <span class="eff-arrow">→</span>
          <code class="eff-rep">{{ x.replacement === '' ? '（删除）' : x.replacement }}</code>
          <span style="flex: 1"></span>
          <button
            class="btn mini danger" title="关闭起效（停用这条全局规则）"
            :data-eff-off="x.id" @click.stop="disableRule(x)"
          >✕ 关闭起效</button>
        </div>

        <!-- 繁简转换（上游同款伪规则）：它也改正文，不列出来这列表就是残缺的 -->
        <div v-if="convertOn" class="eff-row eff-row-convert" data-eff-row-convert>
          <span class="eff-name">繁简转换</span>
          <span class="tag">阅读样式 · 全局</span>
          <span class="eff-sub2">{{ convertLabel }}</span>
          <span style="flex: 1"></span>
          <button class="btn mini danger" data-eff-off-convert title="关闭简繁转换" @click="disableConvert()">✕ 关闭起效</button>
        </div>
      </div>
    </div>

    <!-- 共用编辑对话框（第三处接入，`#260`） -->
    <ReplaceRuleDialog
      v-if="editing" :rule="editing"
      @close="editing = null" @save="onSaved"
    />
  </div>
</template>

<style scoped>
.eff-mask {
  position: fixed; inset: 0; z-index: 1100; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px;
}
.eff-panel {
  width: min(680px, 94vw); max-height: 84vh; display: flex; flex-direction: column;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); box-shadow: var(--shadow);
}
.eff-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.eff-head strong { font-size: 15px; color: var(--text-0); }
.eff-sub { font-size: 11.5px; color: var(--muted); }
.eff-body { padding: 12px 16px 16px; overflow: auto; }
.eff-tip { margin: 0 0 10px; font-size: 12px; color: var(--text-1); line-height: 1.7; }
.eff-empty { font-size: 12px; color: var(--muted); padding: 12px; border: 1px dashed var(--border-strong); border-radius: 8px; }
.eff-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; margin-bottom: 6px; cursor: pointer;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2);
}
.eff-row:hover { border-color: var(--brand); }
.eff-row-convert { cursor: default; }
.eff-name { font-size: 13px; color: var(--text-0); font-weight: 600; }
.eff-pat, .eff-rep {
  font-family: var(--mono); font-size: 11.5px; background: var(--bg-3);
  padding: 1px 6px; border-radius: 4px; color: var(--text-1);
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.eff-arrow { color: var(--muted); }
.eff-sub2 { font-size: 12px; color: var(--text-1); }
</style>
