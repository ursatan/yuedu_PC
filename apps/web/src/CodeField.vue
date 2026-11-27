<script setup lang="ts">
/**
 * CodeField —— 代码编辑器（CodeMirror）
 *  - 默认紧凑多行；双击进入增强编辑（放大）
 *  - JS 语法高亮 / 搜索 / 补全 / 字号调节
 *  - 多配色主题切换（One Dark / 浅色 / 静谧蓝）
 *  - 格式化 = js-beautify（JS 方案，对规则代码与 JSON 均适用）
 *  - 常用符号快捷插入
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
// `#162`：JSON 源码 tab 单独上 JSON 语法（含折叠）—— 此前一律用 `javascript()`，
// 结果是「JSON 也当 JS 高亮」，键名/字符串的着色与调试体验都不对。
import { json, jsonParseLinter } from '@codemirror/lang-json';
// `#162`：未闭合括号 lint。json 侧用官方 `jsonParseLinter`（精确），JS 规则侧用我们自己的
// 括号平衡扫描器（纯函数在 `utils/codemirror-lint.ts`，**规则字段本来就是片段**，
// 拿完整 JS 解析器去校验会整片标红 ⇒ 只查括号）。
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { findUnclosedBrackets } from './utils/codemirror-lint';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { oneDark } from '@codemirror/theme-one-dark';
import beautify from 'js-beautify';

const props = withDefaults(defineProps<{
  modelValue: string;
  rows?: number;
  placeholder?: string;
  zoomable?: boolean;
  fillH?: boolean;
  zoomTitle?: string;
  /**
   * **高度随内容自适应**（2026-09-29 用户实测 ②-b）：初始 = 2 行、回车换行向下拉伸、**最多 9 行**（超出转内滚动）。
   *
   * 为什么不用 `rows` 定高：规则字段的 `rows` 各不相同（2/3/4/5/6）⇒ 一屏里编辑框**高矮不一**，
   * 用户明确要求「初始高度应相同」。`rows` 只在**非** `autoH`（如 JSON 源码区）时才有意义。
   */
  autoH?: boolean;
  /**
   * **语言模式**（`#162`）。默认 `'js'` —— 规则字段写的就是 JS 片段。
   * JSON 源码 tab 传 `'json'`：走 `json()`（含折叠）+ `jsonParseLinter`，
   * 而不是像以前那样拿 JS 语法去糊 JSON。
   */
  lang?: 'js' | 'json';
  /**
   * **光标 / 滚动位置的记忆键**（`#162`）。
   *
   * 为什么需要：规则工坊的字段是 `v-for` 渲染的，切 tab 时**整块重挂载**
   * （`WorkshopEditor` 的 `v-else-if="curTab"`）⇒ CodeMirror 实例重建、光标回到开头、
   * 滚动回顶部。用户改动一长条规则时切去看另一页再切回来，位置全丢。
   * 传一个**稳定且唯一**的键（字段用 `f.path`），本组件就会在卸载前存、挂载后恢复。
   *
   * ⚠️ 不传 ⇒ 不记忆（旧行为）。**不要用下标当键** —— 切 tab 后字段集合不同，下标会串。
   */
  posKey?: string;
}>(), { zoomable: true, fillH: false, autoH: false, lang: 'js' });
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const host = ref<HTMLElement | null>(null);
/**
 * `#574` 增强编辑器的宿主。
 *
 * 以前是 `id="cf-zoom-host"` + `document.getElementById` —— 一屏里放**多个** `CodeField`
 * （站点定制弹窗的 CSS / JS 两栏）时，`getElementById` 永远拿到**第一个**实例的节点
 * ⇒ 第二个实例的放大编辑器会把 DOM 挂进第一个实例的浮层里（串台/乱画）。
 * 改成组件内 ref：每个实例只认自己的宿主。
 */
const zoomHost = ref<HTMLElement | null>(null);
const zoomed = ref(false);
const fontSize = ref(13);
const fontComp = new Compartment();
const themeComp = new Compartment();
const themeId = ref<ThemeId>((localStorage.getItem('yuedu.cm-theme') as ThemeId) || 'one-dark');

/* ---- 多配色主题 ---- */
type ThemeId = 'one-dark' | 'light' | 'midnight';
const THEME_LIST: Array<{ id: ThemeId; name: string }> = [
  { id: 'one-dark', name: 'One Dark' },
  { id: 'light', name: '浅色' },
  { id: 'midnight', name: '静谧蓝' },
];
const midnightTheme = EditorView.theme({
  '&': { background: '#10162a', color: '#d5e0f5' },
  '.cm-gutters': { background: '#0c1120', color: '#3d4a66', border: 'none' },
  '.cm-activeLine': { background: '#182242' },
  '.cm-content': { caretColor: '#7ce7f7' },
}, { dark: true });
const midnightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7ce7f7' },
  { tag: t.string, color: '#a5e8a0' },
  { tag: t.number, color: '#f5c518' },
  { tag: t.comment, color: '#5a6a8a', fontStyle: 'italic' },
  { tag: t.function(t.variableName), color: '#c3a6ff' },
  { tag: t.variableName, color: '#e8ecf1' },
  { tag: t.operator, color: '#ff9e64' },
]);
function themeExt(id: ThemeId) {
  if (id === 'one-dark') return [oneDark];
  if (id === 'light') {
    return [EditorView.theme({ '&': { background: '#f7f8fb', color: '#1a2233' }, '.cm-gutters': { background: '#eef0f5', color: '#8a93a6', border: 'none' }, '.cm-activeLine': { background: '#e9edf5' } }, { dark: false }), syntaxHighlighting(defaultHighlightStyle)];
  }
  return [midnightTheme, syntaxHighlighting(midnightHighlight)];
}
function applyTheme(id: ThemeId) {
  themeId.value = id;
  const ext = themeExt(id);
  view?.dispatch({ effects: themeComp.reconfigure(ext) });
  zoomView?.dispatch({ effects: themeComp.reconfigure(ext) });
  localStorage.setItem('yuedu.cm-theme', id);
}

/* ---- Legado 常用 API 自动补全 ---- */
const LEGADO_WORDS = [
  'java.ajax(', 'java.post(', 'java.getString(', 'java.put(', 'java.get(',
  'java.base64Encode(', 'java.base64Decode(', 'java.md5Encode(', 'java.timeFormat(',
  'java.createSymmetricCrypto(', 'java.aesBase64DecodeToString(', 'java.hexDecodeToString(',
  'java.encodeURI(', 'java.randomUUID(', 'java.getHeaderMap(', 'java.getVerification(',
  'source.getKey()', 'source.getVariable()', 'source.setVariable(', 'source.getLoginHeaderMap()',
  'cookie.getCookie(', 'cookie.removeCookie(', 'cache.put(', 'cache.get(', 'cache.putMemory(',
  'baseUrl', 'book.name', 'book.author', 'key', 'page', 'searchWord', 'result', 'src',
  'JSON.stringify(', 'JSON.parse(', 'String(', 'Number(', 'encodeURIComponent(', 'decodeURIComponent(',
];
function legadoCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[\w$.]/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: LEGADO_WORDS.map((w) => ({ label: w, type: 'keyword' })),
    validFor: /^[\w$.]*$/,
  };
}

let view: EditorView | null = null;
let zoomView: EditorView | null = null;
/** `#162`：语言模式的 Compartment（与 `fontComp`/`themeComp` 同一套路，**不重挂载编辑器**） */
const langComp = new Compartment();

/** JS 规则字段用的 linter：只查括号平衡，诊断信息来自纯函数（可单测） */
const jsBracketLinter = linter(
  (v) => findUnclosedBrackets(v.state.doc.toString()) as Diagnostic[],
  { delay: 300 },
);

function langExtension(): unknown[] {
  return props.lang === 'json'
    ? [json(), linter(jsonParseLinter()), lintGutter()]
    : [javascript(), jsBracketLinter, lintGutter()];
}

/**
 * 编辑器扩展。
 *
 * `#573`（用户 2026-10-23）**Ctrl+F 只属于增强编辑器**：
 * 紧凑态（字段下的编辑区）不再挂 `searchKeymap` —— 以前它也会响应 Ctrl+F，
 * 而增强浮层打开但焦点不在里面时，Ctrl+F 会唤起**下层紧凑编辑器**的搜索面板，
 * 面板浮在增强浮层上方（用户实测的错位）。现在只有放大态绑搜索；打开时顺便聚焦放大态。
 */
function makeExtensions(opts: { withSearch: boolean }) {
  return [
    lineNumbers(),
    history(),
    closeBrackets(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    ...(opts.withSearch ? [search({ top: true }), keymap.of([...searchKeymap])] : []),
    autocompletion({ override: [legadoCompletions] }),
    langComp.of(langExtension() as never),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
    fontComp.of(EditorView.theme({ '&': { fontSize: fontSize.value + 'px' } })),
    themeComp.of(themeExt(themeId.value)),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) emit('update:modelValue', u.state.doc.toString());
      /**
       * `#162` 光标记忆：**只在 `selectionSet` 时写**（用户的真实移动），**不跟 `docChanged`**。
       *
       * ⚠️ 为什么必须排除 `docChanged`（踩过：切回来位置还是 0）：重挂载时
       * `WorkshopEditor.switchTab('json')` 会紧接着 `jsonText.value = JSON.stringify(raw, null, 2)`
       * 触发 `watch(modelValue)` → 我们 `dispatch` 整篇替换 → 那也是一次 `docChanged`，
       * 且此时选区在**文档开头** ⇒ 如果跟着写，就会把**刚刚恢复好的位置覆盖成 0**，
       * 表现为「记忆功能没做」。
       * 打字时 `selectionSet` 一定会同时发生 ⇒ 不跟 `docChanged` 不会漏记。
       *
       * ⚠️ 还有一处必须排除：**我们恢复位置时的那次 `dispatch`** 也是 `selectionSet`
       * （踩过：`trace` 里出现 `restore(hit, top:1200)` 紧跟着 `save(top:0)`）——
       * 此时 `scrollTop` 还没被 `applyScrollSoon` 写进去（滚动是异步的），
       * ⇒ 会把**刚恢复好的 1200 覆盖成 0** ⇒ 第二次切走再回来就丢了。用 `restoring` 抑制。
       */
      if (u.selectionSet && !restoring) rememberCursor(u.view);
    }),
  ];
}

/* ---------------- `#162` 光标 / 滚动位置记忆 ----------------
 * 存在**模块级 Map**（会话内有效）—— 需求是「切 tab 再回来位置还在」，
 * 不落 localStorage：那是另一个需求（跨刷新），而且会把用户的编辑位置当数据持久化，没必要。
 */
interface SavedPos {
  anchor: number;
  head: number;
  top: number;
}
/**
 * ⚠️ **挂 `globalThis`，不要只放模块级**（踩过：切回来 `have=[]`，保存明明成功）。
 *
 * 现象：卸载时 `__cfSaved` 显示 `POS.set('__json_src__', {anchor:247, top:240})` 成功，
 * 但重挂载后 `restoreCursor` 读到的是 **空表** ⇒ 存与取拿到的不是同一个 `Map`
 * （Vite 产物里 `CodeField` 只有一份代码，但**模块状态**在路由/tab 切换这条链上不保证是同一份）。
 * ⇒ 直接把表挂在 `globalThis`：它比模块作用域稳，而且探针能直接读（可复核）。
 */
const POS: Map<string, SavedPos> = (() => {
  const g = globalThis as unknown as Record<string, unknown>;
  const cur = g['__cfPos'] as Map<string, SavedPos> | undefined;
  if (cur) return cur;
  const m = new Map<string, SavedPos>();
  g['__cfPos'] = m;
  return m;
})();

/** 正在恢复位置 ⇒ 抑制 `rememberCursor`（见 `makeExtensions` 里 `selectionSet` 的注释） */
let restoring = false;

function rememberCursor(v: EditorView | null | undefined): void {
  if (!v || !props.posKey) return;
  const sel = v.state.selection.main;
  const scroller = v.scrollDOM;
  POS.set(props.posKey, { anchor: sel.anchor, head: sel.head, top: scroller?.scrollTop ?? 0 });
}

/**
 * 把滚动位置**重试几次**写进去，直到真的生效。
 *
 * ⚠️ 为什么不能只赋一次（踩过：赋了 240、读回来还是 0）：
 * ① 刚挂载时 CM 还没量完 DOM，`scrollHeight` 还是估计值 ⇒ 浏览器把超出的值**夹到 0**；
 * ② 外部整篇替换（工坊切回 JSON tab 会 `JSON.stringify` 重排一次）会让 CM 重新测量，
 *    而**整篇替换会把选区按映射规则拉回 0** ⇒ CM 把视口拽回选区 ⇒ 又把 `scrollTop` 冲成 0。
 * ⇒ 在「CM 写完 DOM」的若干时机各写一次，**生效即停**（已到目标就不再写）。
 */
function applyScrollSoon(v: EditorView, top: number): void {
  let tries = 0;
  const apply = () => {
    tries++;
    const scroller = v.scrollDOM;
    if (!scroller) return;
    const off = Math.abs(scroller.scrollTop - top);
    if (off > 1) {
      scroller.scrollTop = top;
      // 还没到（被夹住 / 被 CM 冲掉）就再等一帧；最多 6 帧
      if (Math.abs(scroller.scrollTop - top) > 1 && tries < 6) requestAnimationFrame(apply);
    }
  };
  try {
    v.requestMeasure({ read: () => null, write: apply });
  } catch {
    /* 老版本 API 不支持就直接走下面的时机 */
  }
  requestAnimationFrame(apply);
  // 兜底：headless / 首屏布局更慢时，120ms 后再确认一次
  window.setTimeout(apply, 120);
}

/**
 * 恢复保存的光标 + 滚动位置。位置要**夹到当前文档长度内**（文档可能已被外部重写，如 JSON tab 的重新格式化）。
 *
 * ⚠️ **调用时机不止「挂载后」**：见 `watch(modelValue)` —— 外部整篇替换之后必须**再恢复一次**，
 * 否则那次替换的选区映射会把刚恢复的位置冲掉（现象：记忆功能看起来完全没做）。
 */
function restoreCursor(v: EditorView): void {
  if (!props.posKey) return;
  const s = POS.get(props.posKey);
  if (!s) return;
  const len = v.state.doc.length;
  const anchor = Math.min(s.anchor, len);
  const head = Math.min(s.head, len);
  restoring = true;
  v.dispatch({ selection: { anchor, head } });
  restoring = false;
  applyScrollSoon(v, s.top);
}
/**
 * 紧凑编辑器（非放大态）的**配色常量 —— 唯一出处**。
 *
 * 2026-09-29 用户实测 ②-c：「编辑区域颜色不一致」，指出同一个框里**上下两块底色不同**。
 * 真因：`.cf-compact` 的高度由外层容器给（`fill-h` ⇒ 100%），而 CodeMirror 的 `.cm-editor`
 * 只有**内容高**（约 2 行）⇒ 下面空出来的那一块露出的是**外层 `.rfe-box` 的底色**（`--bg-0`），
 * 与编辑器底色 `#1e293b` 不同。
 * ⇒ 两处一起修：① 让 `.cm-editor` 填满容器（见下面 `'&': { height: '100%' }`）
 *   ② 把这两个颜色**导出成 CSS 变量**（`--cf-bg` / `--cf-border`）供外层容器复用 ——
 *   这样即便仍有 1~2px 空隙也不会看出色差，而且**颜色只在这一处定义**。
 */
const COMPACT_BG = '#1e293b';
const COMPACT_BORDER = '#334155';

const compactTheme = EditorView.theme({
  // `height: 100%` 是 ②-c 的正面修法：容器给多高，编辑器就占多高（不再只占内容高）
  '&': { background: COMPACT_BG, color: '#e2e8f0', borderRadius: '6px', border: `1px solid ${COMPACT_BORDER}`, height: '100%' },
  '.cm-gutters': { background: COMPACT_BG, color: '#475569', border: 'none' },
  '.cm-activeLine': { background: '#26334d' },
  // minHeight 2.8em = 2 行（CM 的行高是 1.4em）⇒ 空字段也占 2 行，与「初始高度相同」一致
  '.cm-scroller': { fontFamily: 'ui-monospace, monospace', minHeight: '2.8em' },
});

onMounted(() => {
  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue ?? '', extensions: [compactTheme, makeExtensions({ withSearch: false })] }),
    parent: host.value as HTMLElement,
  });
  // `#162`：切 tab 回来时恢复上次的光标 / 滚动位置（见 restoreCursor 注释）
  restoreCursor(view);
});

watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v ?? '' } });
    /**
     * ★ `#162`：**外部整篇替换之后必须再恢复一次位置**（踩过：滚动位置 240 → 0）。
     *
     * 整篇替换 `{from:0,to:len,insert:v}` 时，CodeMirror 会把**选区按变更映射**走 ——
     * 落在被替换区间里的位置被拉到插入内容的一端，于是选区回到文档开头，
     * CM 随之把视口拽回选区（`scrollTop` 归 0）⇒ 我们在 `onMounted` 里刚恢复的位置被冲掉。
     * 真实触发路径：工坊 `switchTab('json')` 会 `JSON.stringify(...)` 重排一次 JSON，
     * 这个赋值正好发生在切回来之后 ⇒ 光标记忆「看起来完全没做」。
     *
     * 只在**外部真的改了文档**（`v !== doc`）时走这一步；我们自己打字回流的值相等，
     * 不会触发（否则每次输入都会把光标拽回去）。
     */
    restoreCursor(view);
  }
  if (zoomView && v !== zoomView.state.doc.toString()) {
    zoomView.dispatch({ changes: { from: 0, to: zoomView.state.doc.length, insert: v ?? '' } });
    restoreCursor(zoomView);
  }
});

watch(fontSize, (s) => {
  const tr = EditorView.theme({ '&': { fontSize: s + 'px' } });
  view?.dispatch({ effects: fontComp.reconfigure(tr) });
  zoomView?.dispatch({ effects: fontComp.reconfigure(tr) });
});

function openZoom() {
  zoomed.value = true;
  requestAnimationFrame(() => {
    const zhost = zoomHost.value;
    if (!zhost) return;
    zoomView?.destroy();
    zoomView = new EditorView({
      state: EditorState.create({ doc: props.modelValue ?? '', extensions: [makeExtensions({ withSearch: true })] }),
      parent: zhost,
    });
    // 放大态也接着紧凑态的编辑位置（否则「双击放大」会把光标甩回开头）
    restoreCursor(zoomView);
    // `#573`：打开即聚焦 —— 这样 Ctrl+F 直接落在增强编辑器上（紧凑态已不绑搜索键）
    zoomView?.focus();
  });
}
function closeZoom() {
  zoomView?.destroy();
  zoomView = null;
  zoomed.value = false;
}
function applyZoom() {
  if (zoomView) emit('update:modelValue', zoomView.state.doc.toString());
  closeZoom();
}

/* ---- 常用符号快捷插入 ---- */
const SNIPPETS = ['&&', '||', 'http://', 'https://', '@js:', '##', '##.', '{{', '}}', 'json:$.', '<js>', '</js>', '###'];
function insertSnippet(s: string) {
  if (!zoomView) return;
  const pos = zoomView.state.selection.main.head;
  zoomView.dispatch({ changes: { from: pos, to: pos, insert: s }, selection: { anchor: pos + s.length } });
  zoomView.focus();
}

/* ---- 格式化：js-beautify（JS 方案） ---- */
function formatCode() {
  const v = zoomView ? zoomView.state.doc.toString() : props.modelValue;
  const pretty = beautify.js(v, { indent_size: 2, wrap_line_length: 0, preserve_newlines: true, end_with_newline: false });
  if (zoomView) zoomView.dispatch({ changes: { from: 0, to: zoomView.state.doc.length, insert: pretty } });
  else emit('update:modelValue', pretty);
}

onBeforeUnmount(() => {
  // `#162`：**先存再销毁** —— 切 tab 就是靠这一步把位置留住（销毁后取不到 selection/scrollTop）
  rememberCursor(view);
  view?.destroy();
  zoomView?.destroy();
});

defineExpose({ openZoom });

const compactHeight = computed(() =>
  props.autoH ? 'auto' : props.fillH ? '100%' : Math.min((props.rows ?? 3) * 20 + 8, 220) + 'px',
);

/**
 * `autoH` 时的**上限**：9 行（`#143` 同日用户实测 ②-b「最多高度扩充到可显示 9 行文本」）。
 * 用 `fontSize` 现算而不是写死 px —— 字号是用户在放大编辑器里可调的，写死会在换字号后错位。
 */
const MAX_LINES = 9;
const autoMaxHeight = computed(() => `${Math.round(fontSize.value * 1.4 * MAX_LINES + 10)}px`);
/** 传给外层容器（`RuleFieldEditor` 的 `.rfe-box`）的变量：底色 / 边框与编辑器保持一致 */
const wrapVars = computed(() => ({
  '--cf-bg': COMPACT_BG,
  '--cf-border': COMPACT_BORDER,
}));
</script>

<template>
  <!-- `data-cf-lang`：把「当前是哪种语言模式」暴露到 DOM 上。
       探针据此断言「JSON tab 真的走了 json 模式」（`#162`）—— 否则只能靠猜 token 类名。 -->
  <div
    class="cf-wrap"
    :data-cf-lang="props.lang"
    :data-cf-pos="props.posKey ?? ''"
    :style="[{ ...wrapVars }, props.fillH ? { height: '100%' } : {}]"
    @dblclick="props.zoomable && openZoom()"
  >
    <div
      ref="host"
      class="cf-compact"
      :style="props.autoH ? { maxHeight: autoMaxHeight } : { height: compactHeight }"
    ></div>
    <div class="cf-tip">双击放大编辑（Esc 关闭 / Ctrl+F 搜索）</div>

    <div v-if="zoomed" class="cf-mask" @click.self="closeZoom">
      <div class="cf-panel">
        <div class="cf-head">
          <strong>{{ props.zoomTitle ?? "编辑规则" }}</strong>
          <span class="cf-fs">
            字号
            <button class="mini" @click="fontSize = Math.max(11, fontSize - 1)">A-</button>
            <span>{{ fontSize }}</span>
            <button class="mini" @click="fontSize = Math.min(24, fontSize + 1)">A+</button>
          </span>
          <span class="cf-theme">
            主题
            <select :value="themeId" @change="applyTheme(($event.target as HTMLSelectElement).value as ThemeId)">
              <option v-for="th in THEME_LIST" :key="th.id" :value="th.id">{{ th.name }}</option>
            </select>
          </span>
          <span style="flex: 1"></span>
          <span class="cf-hint">Ctrl+F 搜索 · 补全自动弹出</span>
          <button class="mini" @click="closeZoom">取消</button>
          <button class="mini ok" @click="applyZoom">确定</button>
        </div>
        <div class="cf-snips">
          <button v-for="s in SNIPPETS" :key="s" class="mini" :title="'插入 ' + s" @click="insertSnippet(s)">{{ s }}</button>
          <span style="flex: 1"></span>
          <button class="mini" title="js-beautify 格式化" @click="formatCode">⌗ 格式化</button>
        </div>
        <div ref="zoomHost" class="cf-zoom-host"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cf-wrap { width: 100%; }
.cf-compact { overflow: auto; cursor: text; }
.cf-tip { font-size: 10px; color: #475569; margin-top: 1px; user-select: none; }
.cf-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65); display: flex; align-items: center; justify-content: center; z-index: 90; }
.cf-panel { width: min(1100px, 95vw); height: 88vh; background: #0b1220; border: 1px solid #334155; border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
.cf-head { display: flex; gap: 10px; align-items: center; padding: 8px 14px; border-bottom: 1px solid #1e293b; font-size: 13px; flex-wrap: wrap; }
.cf-fs { display: flex; gap: 6px; align-items: center; color: #94a3b8; font-size: 12px; }
.cf-theme { display: flex; gap: 6px; align-items: center; color: #94a3b8; font-size: 12px; }
.cf-theme select { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 6px; padding: 3px 8px; font-size: 12px; outline: none; }
.cf-hint { font-size: 11px; color: #64748b; }
.cf-snips {
  display: flex; gap: 4px; align-items: center; flex-wrap: wrap;
  padding: 6px 14px; border-bottom: 1px solid #1e293b;
}
.cf-zoom-host { flex: 1; overflow: auto; }
.cf-zoom-host :deep(.cm-editor) { height: 100%; }
.mini { padding: 2px 8px; font-size: 11px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 5px; cursor: pointer; }
.mini.ok { background: #6366f1; color: white; border-color: #6366f1; }
</style>
