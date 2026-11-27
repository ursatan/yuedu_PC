<script setup lang="ts">
/**
 * 字典（用户 4-5）：**在线字典**规则的管理与试查。
 *
 * 结构照 Legado 的三层：`字典 → 在线字典 → 字典规则`（本地字典是独立工程，见 stores/dict.ts 的说明）。
 *  · 规则字段：`name`(主键) / `urlRule` / `showRule` / `enabled` / `sortNumber` —— 与
 *    `DictRule.kt` 逐条对齐；
 *  · 「导入」直接吃 Legado 导出的字典规则 JSON（`[{name,urlRule,showRule,enabled,sortNumber}]`）；
 *  · 「试查」把词发给服务端 `/api/dict/query` 执行 —— **规则求值在服务端**（与书源同一套引擎，不漂移）。
 */
import { computed, ref } from 'vue';
import { useDictStore, BUILTIN_DICT_RULES, type DictRule } from '../stores/dict';
import { toast } from '../toast';
import { decorateDictHtml, dictResultIsPlain, playDictAudio, playDictGif } from '../utils/dict-html';
import { parseDictRulesJson, dictDedupeKey } from '../utils/dict-transfer';

const dict = useDictStore();
const editing = ref<DictRule | null>(null);
const creating = ref(false);
const importOpen = ref(false);
const importText = ref('');
const testWord = ref('');
/** `#267` 重复处理：跳过（保现有）/ 覆盖（同名规则用导入的替换） */
const importDedupe = ref<'skip' | 'overwrite'>('overwrite');

/**
 * `#267` 导入预览：输入边打边解析（与入库同一份实现 ⇒ 「预览说 3 条新增、导入 3 条」），
 * 分类 = 新增（库内与批内都没见过）/ 重复（与现有同名或批内同名，主键 = name）/ 错误。
 */
const importParse = computed(() => (importText.value.trim() ? parseDictRulesJson(importText.value) : null));
const importClassified = computed(() => {
  const p = importParse.value;
  if (!p) return null;
  const existing = new Set(dict.rules.map(dictDedupeKey));
  const batch = new Set<string>();
  const fresh: typeof p.rules = [];
  const dup: typeof p.rules = [];
  for (const r of p.rules) {
    const k = dictDedupeKey(r);
    if (existing.has(k) || batch.has(k)) dup.push(r);
    else { fresh.push(r); batch.add(k); }
  }
  return { fresh, dup };
});
/** 可导入条数 = 新增 + 重复（重复是否真进取决于 dedupe） */
const importableCount = computed(() => {
  const c = importClassified.value;
  if (!c) return 0;
  return c.fresh.length + (importDedupe.value === 'overwrite' ? c.dup.length : 0);
});

/** `{{key}}` 这类字面量在模板里会被当成插值 ⇒ 一律走常量绑定（`{{ '{{' }}` 那种写法太脏） */
const KEY_TOKEN = '{{key}}';
const URL_PLACEHOLDER = 'https://…?q={{key}}';

/** 编辑/新建对话框的草稿（新建时给一份空模板；名称是主键，改名 = 新增） */
const draft = computed<DictRule>(() => {
  if (creating.value) return { name: '', urlRule: '', showRule: '', enabled: true, sortNumber: dict.rules.length };
  return editing.value ?? { name: '', urlRule: '', showRule: '', enabled: true, sortNumber: 0 };
});
const dName = ref('');
const dUrl = ref('');
const dShow = ref('');
const dEnabled = ref(true);

function openEdit(r: DictRule): void {
  creating.value = false;
  editing.value = r;
  dName.value = r.name;
  dUrl.value = r.urlRule;
  dShow.value = r.showRule;
  dEnabled.value = r.enabled;
}
function openCreate(): void {
  creating.value = true;
  editing.value = null;
  dName.value = '';
  dUrl.value = '';
  dShow.value = '';
  dEnabled.value = true;
}
function submitDraft(): void {
  const name = dName.value.trim();
  if (!name) { toast('字典名不能为空', 'warn'); return; }
  if (!dUrl.value.trim()) { toast('URL 规则不能为空', 'warn'); return; }
  const old = editing.value?.name;
  if (old && old !== name) dict.removeRule(old); // 改名 = 换主键（Legado 的 name 就是主键）
  dict.upsertRule({
    name,
    urlRule: dUrl.value.trim(),
    showRule: dShow.value,
    enabled: dEnabled.value,
    sortNumber: editing.value?.sortNumber ?? dict.rules.length,
  });
  toast(old ? '已保存' : '已新建', 'ok');
  editing.value = null;
  creating.value = false;
}
function doImport(): void {
  const c = importClassified.value;
  if (!c) return;
  const r = dict.importRules(importText.value, importDedupe.value);
  const parts: string[] = [];
  if (r.added) parts.push(`导入 ${r.added} 条`);
  if (r.skipped) parts.push(`跳过 ${r.skipped} 条`);
  toast(r.err || `完成：${parts.join(' · ') || '没有可导入的规则'}`, r.err ? 'warn' : 'ok');
  if (!r.err) { importOpen.value = false; importText.value = ''; }
}
async function testLookup(): Promise<void> {
  const w = testWord.value.trim();
  if (!w) { toast('先输入要查的词', 'warn'); return; }
  await dict.lookup(w);
}
/** 试查结果里的发音按钮 / 笔顺动画（汉典等）：站点自己的 JS 我们跑不了 ⇒ 自己接管点击（与阅读浮层同一实现） */
function onResultClick(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  const audioEl = t?.closest?.('[data-dict-audio]');
  if (audioEl) {
    e.preventDefault();
    void playDictAudio(audioEl);
    return;
  }
  const gifEl = t?.closest?.('[data-dict-gif]');
  if (gifEl) {
    e.preventDefault();
    playDictGif(gifEl);
  }
}
</script>

<template>
  <div class="page">
    <div class="card">
      <div class="row-head">
        <h3 style="margin: 0">字典 · 在线字典</h3>
        <span class="sub">共 {{ dict.rules.length }} 条 · 启用 {{ dict.enabledRules.length }} 条</span>
        <span style="flex: 1"></span>
        <button class="btn sm" @click="openCreate()">＋ 新建</button>
        <button class="btn sm" @click="importOpen = true">⇩ 导入</button>
        <button class="btn sm" @click="dict.restoreBuiltin()">↺ 恢复内置</button>
      </div>
      <p class="tip">
        规则来自 Legado 的「字典规则」：<code>urlRule</code> 用 <code>{{ KEY_TOKEN }}</code> 取词，
        <code>showRule</code> 在响应体上求值（CSS / JSONPath / <code>@js:</code>，空则原样展示响应体）。
        阅读时选中文字 → 「字典」即可查询。
      </p>

      <div class="dict-list">
        <!--
          ★ 排序（用户 2026-09-28）：**所有字典都可上下移动**，内置三条也不固定顺序。
          之前「新导入的汉典点 ↑↓ 没反应」的真因在 store：旧实现是「对调相邻两条的 sortNumber」，
          导入的规则若与内置撞号（都是 0）则交换相同的值 = 没动；现在改为按显示顺序**重新编号 0,1,2…**。
          这里把到头的方向置灰，让「已到顶」和「点不动（bug）」区分开。
        -->
        <div v-for="(r, ri) in dict.rulesSorted" :key="r.name" class="dict-row" :class="{ off: !r.enabled }">
          <span class="dict-name">{{ r.name }}</span>
          <span class="dict-url" :data-tip="r.urlRule">{{ r.urlRule }}</span>
          <span class="dict-show" :class="{ none: !r.showRule }">{{ r.showRule ? 'showRule' : '直出响应体' }}</span>
          <button class="btn mini" :disabled="ri === 0" title="上移（查词 tab 的顺序也跟着变）" @click="dict.moveRule(r.name, -1)">↑</button>
          <button class="btn mini" :disabled="ri === dict.rulesSorted.length - 1" title="下移（查词 tab 的顺序也跟着变）" @click="dict.moveRule(r.name, 1)">↓</button>
          <button class="btn mini" @click="dict.toggleRule(r.name, !r.enabled)">{{ r.enabled ? '停用' : '启用' }}</button>
          <button class="btn mini" @click="openEdit(r)">编辑</button>
          <button class="btn mini" @click="dict.removeRule(r.name)">删除</button>
        </div>
        <div v-if="!dict.rules.length" class="empty">还没有字典规则 —— 点「＋ 新建」或「⇩ 导入」。</div>
      </div>
    </div>

    <div class="card">
      <div class="row-head">
        <h3 style="margin: 0">试查</h3>
        <input v-model="testWord" class="kw" placeholder="输入词语后回车（用所有启用的字典查询）" @keyup.enter="testLookup()" />
        <button class="btn sm primary" :disabled="dict.querying" @click="testLookup()">{{ dict.querying ? '查询中…' : '查词' }}</button>
      </div>
      <div class="test-results" @click="onResultClick">
        <div v-for="(res, i) in dict.results" :key="i" class="dict-sec">
          <div class="dict-sec-name">{{ res.name }}<span class="ms">{{ res.ms }}ms</span></div>
          <!-- 这里的「试查」是**一次问全部**（与阅读浮层「点一个查一个」的 tab 模式不同）⇒ 查询中给个提示 -->
          <div v-if="res.state !== 'done'" style="font-size: 12px; color: var(--muted)">查询中…</div>
          <div v-else-if="res.err" class="err-text">{{ res.err }}</div>
          <!-- 站点返回的短文本（未收录该词 / 404）⇒ 如实提示，别当正文渲染 -->
          <div v-else-if="dictResultIsPlain(res.text)" class="dict-note">
            站点返回（不是释义正文）：<code>{{ res.text }}</code>
          </div>
          <!-- 与阅读浮层同一套渲染前处理（相对地址补全 / 图片走代理 / 链接新标签 / 发音按钮接管） -->
          <div v-else class="dict-html" v-html="decorateDictHtml(res.text, res.base)"></div>
        </div>
        <div v-if="!dict.results.length" class="empty">还没查过词。</div>
      </div>
    </div>

    <div class="card dim-card">
      <div class="row-head">
        <h3 style="margin: 0">本地字典（离线词库）</h3>
        <span class="tag">远期</span>
      </div>
      <p class="tip">
        本地字典指**离线词库文件**的检索（词库解析 + 索引 + 查询），与在线字典是两套实现，
        属独立工程量 —— 按需求「先占位、远期实现」，此处不放假入口。届时入口挂在同一个「字典」下。
      </p>
    </div>

    <!-- 新建 / 编辑 -->
    <div v-if="creating || editing" class="mask" @click.self="creating = false; editing = null">
      <div class="dlg">
        <h3 style="margin: 0 0 12px">{{ creating ? '新建字典' : `编辑「${editing?.name}」` }}</h3>
        <label class="fld"><span>名称</span><input v-model="dName" placeholder="唯一，重名即覆盖" /></label>
        <label class="fld"><span>URL 规则</span><input v-model="dUrl" :placeholder="URL_PLACEHOLDER" /></label>
        <label class="fld">
          <span>showRule</span>
          <textarea v-model="dShow" rows="4" placeholder="留空 = 直接展示响应体；支持 CSS / JSONPath / @js:"></textarea>
        </label>
        <label class="fld inline"><span>启用</span><input v-model="dEnabled" type="checkbox" /></label>
        <div class="dlg-btns">
          <button class="btn sm" @click="creating = false; editing = null">取消</button>
          <button class="btn sm primary" @click="submitDraft()">确定</button>
        </div>
      </div>
    </div>

    <!-- 导入（`#267`：先预览「解析条数 / 新增·重复·错误」，确认后再点「导入 N 条」） -->
    <div v-if="importOpen" class="mask" @click.self="importOpen = false">
      <div class="dlg">
        <h3 style="margin: 0 0 8px">导入字典规则</h3>
        <p class="tip" style="margin-top: 0">
          粘贴 Legado 导出的字典规则 JSON（单个对象或数组均可，字段
          <code>name / urlRule / showRule / enabled / sortNumber</code>）。
        </p>
        <textarea v-model="importText" rows="8" placeholder='[{"name":"海词英文","urlRule":"…","showRule":"…","enabled":true,"sortNumber":1}]'></textarea>

        <!-- 预览：确认无误再导入 -->
        <div v-if="importParse" class="pv">
          <div class="pv-stats">
            <span>共解析 <b>{{ importParse.parsedTotal }}</b> 条</span>
            <span class="pv-n green">新增 <b>{{ importClassified?.fresh.length ?? 0 }}</b></span>
            <span class="pv-n orange">重复 <b>{{ importClassified?.dup.length ?? 0 }}</b></span>
            <span class="pv-n red">错误 <b>{{ importParse.errors.length }}</b></span>
          </div>
          <div v-if="importClassified && (importClassified.fresh.length || importClassified.dup.length)" class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th style="width:36px">#</th><th>名称</th><th>URL 规则</th><th style="width:70px">判定</th></tr></thead>
              <tbody>
                <tr v-for="r in importClassified!.fresh" :key="'f' + r.name"><td></td><td>{{ r.name }}</td><td class="mono">{{ r.urlRule }}</td><td><span class="tag green">新增</span></td></tr>
                <tr v-for="r in importClassified!.dup" :key="'d' + r.name"><td></td><td>{{ r.name }}</td><td class="mono">{{ r.urlRule }}</td><td><span class="tag orange">重复</span></td></tr>
              </tbody>
            </table>
          </div>
          <ul v-if="importParse.errors.length" class="errs">
            <li v-for="(e, i) in importParse.errors.slice(0, 8)" :key="i">{{ e.reason }}</li>
          </ul>
          <div class="pv-dedupe">
            <span>重复处理：</span>
            <button class="chip" :class="{ on: importDedupe === 'skip' }" @click="importDedupe = 'skip'">重复 → 跳过</button>
            <button class="chip" :class="{ on: importDedupe === 'overwrite' }" @click="importDedupe = 'overwrite'">重复 → 覆盖</button>
          </div>
        </div>

        <div class="dlg-btns">
          <button class="btn sm" @click="importOpen = false">取消</button>
          <button class="btn sm primary" :disabled="importableCount === 0" @click="doImport()">导入 {{ importableCount }} 条</button>
        </div>
      </div>
    </div>

    <p class="foot">
      内置预设（来自 Legado 官方默认字典）：
      <span v-for="b in BUILTIN_DICT_RULES" :key="b.name" class="chip">{{ b.name }}</span>
    </p>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 14px; }
.card { background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--r); padding: 14px; }
.dim-card { opacity: 0.92; }
.row-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sub { font-size: 12px; color: var(--muted); }
.tip { font-size: 12px; color: var(--muted); line-height: 1.8; }
.tip code { background: var(--bg-3); padding: 1px 4px; border-radius: 4px; font-size: 11.5px; }
.dict-list { margin-top: 10px; }
.dict-row { display: flex; align-items: center; gap: 8px; padding: 7px 6px; border-bottom: 1px solid var(--border); }
.dict-row.off { opacity: 0.5; }
.dict-name { flex: none; width: 96px; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dict-url { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--muted); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dict-show { flex: none; font-size: 11px; color: var(--faint); }
.dict-show.none { color: var(--orange, #d08700); }
.kw { flex: 1 1 260px; padding: 6px 10px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0); font-family: var(--font); font-size: 13px; }
.test-results { margin-top: 12px; max-height: 46vh; overflow: auto; }
.dict-sec { border-bottom: 1px dashed var(--border); padding-bottom: 10px; margin-bottom: 10px; }
.dict-sec-name { font-size: 12.5px; font-weight: 700; color: var(--brand); margin-bottom: 6px; }
.ms { font-size: 10.5px; color: var(--faint); font-family: var(--mono); margin-left: 6px; font-weight: 400; }
.dict-html { font-size: 13px; line-height: 1.8; color: var(--text-1); word-break: break-word; }
.dict-html :deep(img) { max-width: 100%; }
.dict-html :deep(a) { color: var(--brand); }
.dict-html :deep(h1), .dict-html :deep(h2), .dict-html :deep(h3) { font-size: 14px; margin: 10px 0 4px; }
/* 站点返回的短文本提示（未收录该词 / 404） */
.dict-note { font-size: 12.5px; color: var(--muted); background: var(--bg-3); border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; }
.dict-note code { font-family: var(--mono); font-size: 11.5px; color: var(--text-0); word-break: break-all; }
/* 发音按钮（汉典等）：站点自己的样式表没有，我们给基础样式 */
.dict-html :deep([data-dict-audio]) {
  cursor: pointer; margin-left: 4px; border: 1px solid var(--line); border-radius: 6px;
  padding: 1px 6px; background: var(--bg-3); color: var(--text-0);
}
.dict-html :deep([data-dict-audio]:hover) { border-color: var(--acc-dim); color: var(--brand); }
/* 笔顺动画（汉典 data-gif）：容器可点，GIF 由我们插入 */
.dict-html :deep([data-dict-gif]) { display: inline-block; cursor: pointer; border-radius: 6px; }
.dict-html :deep([data-dict-gif]:hover) { outline: 1px dashed var(--acc-dim); outline-offset: 2px; }
.dict-html :deep([data-dict-gif] img.rd-dict-gif) {
  display: block; margin: 6px 0; max-width: 100%; max-height: 180px;
  border: 1px solid var(--border); border-radius: 6px; background: #fff;
}
.mask { position: fixed; inset: 0; z-index: 1200; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; }
.dlg { width: min(620px, 94vw); background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: var(--r); padding: 16px; box-shadow: var(--shadow); }
.dlg textarea { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0); font-family: var(--mono); font-size: 12px; }
.fld { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.fld.inline { align-items: center; }
.fld > span { flex: none; width: 78px; font-size: 12.5px; color: var(--muted); }
.fld input:not([type='checkbox']) { flex: 1; min-width: 0; padding: 6px 9px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--line); color: var(--text-0); font-family: var(--font); font-size: 13px; }
.dlg-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.foot { font-size: 11.5px; color: var(--faint); }
.chip { display: inline-block; margin: 0 4px; padding: 1px 7px; border-radius: 999px; background: var(--bg-3); border: 1px solid var(--border); }

/* ── #267 导入预览 ─────────────────────────────── */
.pv { margin-top: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg-2, rgba(127,127,127,0.06)); }
.pv-stats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.pv-stats b { font-size: 14px; margin-left: 2px; }
.pv-n.green b { color: var(--green, #22c55e); }
.pv-n.orange b { color: var(--orange, #d08700); }
.pv-n.red b { color: var(--red, #ef4444); }
.tbl-wrap { margin-top: 8px; max-height: 180px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th, .tbl td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
.tbl th { position: sticky; top: 0; background: var(--bg-2, var(--bg-1)); }
.tbl .mono { font-family: var(--mono); font-size: 11px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); }
.tag.green { color: var(--green, #22c55e); border-color: var(--green, #22c55e); }
.tag.orange { color: var(--orange, #d08700); border-color: var(--orange, #d08700); }
.errs { margin: 8px 0 0; padding-left: 18px; font-size: 11.5px; line-height: 1.7; color: var(--orange, #d08700); max-height: 90px; overflow: auto; }
.pv-dedupe { margin-top: 8px; display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }
.pv-dedupe .chip { cursor: pointer; }
.pv-dedupe .chip.on { color: var(--text-0); border-color: var(--brand, #6366f1); box-shadow: 0 0 0 1px var(--brand, #6366f1) inset; }
</style>
