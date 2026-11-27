<script setup lang="ts">
/**
 * `#261` **手动规则集**对话框（用户 2026-10-04 拍板要做）。
 *
 * ## 上游语义（照抄，界面上必须说清）
 * ① 这是**全局互斥的第二模式**：开启后阅读器菜单里「启用替换」换成「手动规则集」
 *    （`ReadBookActivity.kt:537-539`）—— 一开影响**所有书**；
 * ② 本书勾了规则 ⇒ **接管**：跑不跑由手动集决定（书的开关与全局默认**失效**），
 *    且**全局规则一条都不跑**；
 * ③ 取规则**只按 id** ⇒ **无视 `isEnabled`**（停用规则照样跑）、**无视 `scope`/`excludeScope`**；
 * ④ 仍按 `scopeTitle`/`scopeContent` 分流到标题 / 正文。
 *
 * ⚠️ ③ 的「无视」是上游现状，不是本仓发明 ⇒ 对话框里用醒目提示告诉用户，否则会被当成 bug。
 */
import { computed, ref } from 'vue';
import { useReaderStore } from '../stores/reader';
import { useReplaceRulesStore } from '../stores/replaceRules';
import { toast } from '../toast';

const emit = defineEmits<{ (e: 'close'): void }>();
const r = useReaderStore();
const rr = useReplaceRulesStore();

/** 全局开关（上游 `AppConfig.manualReplaceRule`） */
const modeOn = computed({
  get: () => r.prefs.manualReplaceRuleEnabled === true,
  set: (v: boolean) => {
    r.patchPrefs({ manualReplaceRuleEnabled: v });
    if (!v) r.reloadCurrentChapter(); // 关掉 ⇒ 回到「全局规则 + 本书开关」路径
  },
});

/** 候选：全部规则里只排除「纯书源规则」（**不排除已停用** —— 上游现状） */
const candidates = computed(() => rr.manualCandidates());
const picked = ref<Set<number>>(new Set(r.currentBookManualRuleIds ?? []));
const allChecked = computed(() => candidates.value.length > 0 && candidates.value.every((x) => picked.value.has(x.id)));
const someChecked = computed(() => candidates.value.some((x) => picked.value.has(x.id)));

function toggleAll(): void {
  picked.value = allChecked.value ? new Set() : new Set(candidates.value.map((x) => x.id));
}
function invert(): void {
  const s = new Set<number>();
  for (const x of candidates.value) if (!picked.value.has(x.id)) s.add(x.id);
  picked.value = s;
}
function toggle(id: number): void {
  const s = new Set(picked.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  picked.value = s;
}

/** 当前这本书「真正会跑」的规则数（按上游口径：只按 id + scopeTitle/scopeContent 分流） */
const willRun = computed(() => {
  const ids = [...picked.value];
  if (!ids.length) return { title: 0, content: 0 };
  const sets = rr.manualSets ? rr.manualSets(ids) : null;
  return { title: sets?.title.length ?? 0, content: sets?.content.length ?? 0 };
});

function save(): void {
  const ids = [...picked.value];
  // ★ 不在书架 ⇒ 拒绝并如实提示（与 setBookUseReplaceRule 同约定：不偷偷加书架）
  if (!r.setBookManualRuleIds(ids.length ? ids : null)) {
    toast('这本书不在书架 ⇒ 手动规则集只能给书架里的书保存', 'warn');
    return;
  }
  r.reloadCurrentChapter(); // 改完立刻重跑当前章（否则「点了没反应」）
  toast(ids.length ? `已保存：本书只看这 ${ids.length} 条规则` : '已清空本书的手动规则集', 'ok');
  emit('close');
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dlg card">
      <div class="dlg-head">
        <b>手动规则集</b>
        <span class="sub">这本书只用勾中的规则（上层语义：接管 + 无视启用与范围）</span>
        <button class="btn mini ghost" style="margin-left: auto" @click="emit('close')">✕</button>
      </div>

      <div class="dlg-body">
        <label class="mr-switch">
          <input type="checkbox" v-model="modeOn" />
          <span>启用手动规则集模式（<b>全局</b>开关，影响所有书）</span>
        </label>

        <div class="warn">
          ⚠️ 手动集非空时：① 本书的净化开关与全局默认都<b>失效</b>（勾了就跑）；
          ② <b>全局规则一条都不跑</b>；③ 取规则<b>只按勾选</b> ⇒ 规则的「启用」与「作用范围」<b>不生效</b>；
          ④ 只按「作用于标题 / 正文」分流。这些都是上游语义。
        </div>

        <div class="row">
          <label class="mr-all" title="第一次点击＝全选；再点一次＝全部取消">
            <input
              type="checkbox" data-manual-all :checked="allChecked"
              :indeterminate.prop="someChecked && !allChecked" @change="toggleAll"
            />
            <span>全选</span>
          </label>
          <button class="btn sm" @click="invert">反选</button>
          <span class="hint">已选 {{ picked.size }} / 共 {{ candidates.length }} 条</span>
        </div>

        <div class="tbl-wrap">
          <label v-for="x in candidates" :key="x.id" class="mr-row">
            <input type="checkbox" class="mr-check" :checked="picked.has(x.id)" @change="toggle(x.id)" />
            <span class="mr-name">{{ x.name || '(未命名)' }}</span>
            <code class="mr-pat" :title="x.pattern">{{ x.pattern }}</code>
            <span class="tags">
              <span class="tag" :class="x.scopeContent ? 'green' : ''">正文</span>
              <span class="tag" :class="x.scopeTitle ? 'green' : ''">标题</span>
              <span v-if="!x.isEnabled" class="tag orange">已停用（手动集里照样跑）</span>
            </span>
          </label>
          <div v-if="!candidates.length" class="hint" style="padding: 8px">还没有净化规则（设置 → 净化 里添加）</div>
        </div>

        <div class="hint">
          勾选后：正文跑 {{ willRun.content }} 条 · 标题跑 {{ willRun.title }} 条
        </div>
      </div>

      <div class="dlg-foot">
        <button class="btn sm ghost" @click="emit('close')">取消</button>
        <button class="btn sm primary" data-manual-save @click="save">
          保存（{{ picked.size }} 条）
        </button>
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
.dlg { width: min(680px, 96vw); display: flex; flex-direction: column; box-shadow: var(--shadow); }
.dlg-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px;
}
.dlg-head .sub { color: var(--muted); font-size: 12px; }
.dlg-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hint { font-size: 12px; color: var(--muted); }
.warn {
  font-size: 11.5px; line-height: 1.75; color: var(--muted);
  border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg-0);
}
.mr-switch { display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; cursor: pointer; }
.mr-all { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; font-size: 12px; }
.tbl-wrap { max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.mr-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  border-bottom: 1px solid var(--border); font-size: 12px; cursor: pointer;
}
.mr-row:hover { background: var(--bg-2); }
.mr-name { flex: none; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mr-pat {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tags { display: flex; gap: 4px; flex-wrap: wrap; }
.tag { padding: 0 6px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); color: var(--muted); }
.tag.green { color: var(--green, #22c55e); border-color: var(--green, #22c55e); }
.tag.orange { color: var(--orange, #d08700); border-color: var(--orange, #d08700); }
.mr-check { accent-color: var(--brand, #6366f1); }
</style>
