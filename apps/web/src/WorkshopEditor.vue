<script setup lang="ts">
/**
 * WorkshopEditor —— 规则工坊嵌入版源编辑器（非浮窗）
 *
 * 三栏中的「中栏」：
 *  - Tab 按引擎类型加载（legado: 基本/搜索/发现/详情/目录/正文/段评；maccms: 基本/CMS 参数；
 *    rss: 基本/启动/列表/WEB_VIEW —— `#330` 对齐上游 RssSourceEditActivity 的四分区）
 *  - JSON 源码（CodeField）+ 可视化字段表单（中文名(englishKey)，textarea）
 *  - 动作条：保存 / 另存为新源 / 导出 / 调试 / 回滚（+ 拷贝/粘贴/Cookie/登录/源变量/校验）
 *  - 字段编辑区双击进入增强编辑（CodeField：高亮/补全/字号/搜索）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { updateSource, setSourceState, verifySource, createSource, getCmsCategories, refreshCmsCategories, type SourceInfo, type SrcState } from './api';
import CodeField from './CodeField.vue';
import RuleFieldEditor from './RuleFieldEditor.vue';
import SourceLoginDialog from './components/SourceLoginDialog.vue';
import MaterialSourceViewer from './components/MaterialSourceViewer.vue';
// `#565` 挑战页判据（`#562` 同一份叶子实现，只看内容特征不看状态码）——
// 窄子路径引入：主出口连着 node:* 依赖，进浏览器 bundle 会炸 build
import { isChallengePage } from '@yuedu/core/self-fetch';

const props = defineProps<{ source: SourceInfo; initialRaw?: Record<string, unknown>; tab?: string }>();
const emit = defineEmits<{ (e: 'saved'): void; (e: 'debug'): void; (e: 'renamed', id: string): void }>();

const raw = ref<Record<string, unknown>>({});
const snapshot = ref(''); // 回滚基线（挂载时的源内容）
const tab = ref('json');
const jsonText = ref('');
const jsonError = ref('');
const saving = ref(false);
const saveMsg = ref('');

/** `#268`：占位源（`draft:` 前缀）—— 新建源还没入库，没有可 GET 的 id */
const isDraft = computed(() => props.source.id.startsWith('draft:'));

/* ---------------- `#550` 源医生 · 内联诊断（无 LLM） ---------------- */
interface InspectorFinding {
  ruleId: string;
  severity: 'error' | 'warn' | 'info';
  field: string;
  message: string;
  line?: number;
  snippet?: string;
  fix?: { field: string; search: string; replace: string; all?: boolean };
}
const inspectFindings = ref<InspectorFinding[]>([]);
const inspectCounts = ref({ error: 0, warn: 0, info: 0 });
const inspecting = ref(false);
let inspectTimer: ReturnType<typeof setTimeout> | null = null;
let inspectSeq = 0;
/** 体检当前编辑器里的 raw（**未保存**版）；失败静默（诊断不能打扰编辑） */
async function runInspect() {
  const seq = ++inspectSeq;
  inspecting.value = true;
  try {
    const r = await fetch('/api/doctor/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: raw.value }),
    });
    if (!r.ok) return;
    const j = (await r.json()) as { findings?: InspectorFinding[]; counts?: { error: number; warn: number; info: number } };
    if (seq !== inspectSeq) return; // 过期回包丢弃（连续打字时）
    inspectFindings.value = j.findings ?? [];
    inspectCounts.value = j.counts ?? { error: 0, warn: 0, info: 0 };
  } catch {
    /* 服务端没起 / 超时 —— 不打扰 */
  } finally {
    if (seq === inspectSeq) inspecting.value = false;
  }
}
const SEV_ORDER: Record<string, number> = { error: 3, warn: 2, info: 1 };
const findingsFor = (path: string): InspectorFinding[] => inspectFindings.value.filter((x) => x.field === path);
/** 该字段的最高级别（'' = 没问题） */
function severityOf(path: string): '' | 'error' | 'warn' | 'info' {
  let best: '' | 'error' | 'warn' | 'info' = '';
  for (const f of findingsFor(path)) if ((SEV_ORDER[f.severity] ?? 0) > (SEV_ORDER[best] ?? 0)) best = f.severity;
  return best;
}
/** 一键应用字节级补丁（`all` = 全局替换），改完立刻复检 */
function applyFix(f: InspectorFinding) {
  const fix = f.fix;
  if (!fix) return;
  const cur = getPath(fix.field);
  if (typeof cur !== 'string') return;
  const next = fix.all ? cur.split(fix.search).join(fix.replace) : cur.replace(fix.search, fix.replace);
  if (next === cur) return;
  setPath(fix.field, next);
  void runInspect();
}
/* ---------------- `#551` 源医生 · 单字段试跑 + 选择器探针（无 LLM） ---------------- */
interface ProbeCandidate {
  selector: string;
  hitCount: number;
  why: string;
}
interface ProbeOut {
  ok: boolean;
  value: string;
  hitCount: number | null;
  length: number;
  ms: number;
  error?: string;
  code?: string;
  hints?: string[];
  candidates?: ProbeCandidate[];
  /** `#555`：作用域模式（行内字段）逐项解出的值 */
  values?: string[];
  /** `#555`：列表项数（给了 scopeRule 才有） */
  itemCount?: number;
  scopeRule?: string;
  /** `#555`：elements 模式的元素片段（bookList / chapterList） */
  samples?: string[];
  /** `#561`：本次是「自取数 JS 直接执行」（服务端用占位内容放行的，页面物料不参与） */
  selfFetch?: boolean;
  /** `#565`：本次先跑了 `ruleBookInfo.init`，字段实际在 init 的结果上求值 */
  initApplied?: boolean;
  /** init 规则原文（回显，超长截断） */
  initRule?: string;
}
/**
 * `#556` **试跑物料按 tab 隔离**（用户 2026-10-21：「对于 JSON 源码 tab、基本 tab 都无需提供；
 * 其余 tab 的可以单独提供」）。
 *
 * 为什么必须隔离：三个 tab 的页面根本不是一张 —— 搜索页、发现页、详情页、目录页、正文页
 * 各自结构不同。以前只有一份全局物料 ⇒ 在「搜索」取了一页，切到「正文」试跑时
 * 用的还是搜索页 ⇒ 结论必然「0 命中」，而人以为是规则写错了。
 */
interface ProbeMaterial { url: string; content: string }
/**
 * `#674` 物料源码增强查看器（双击物料框打开）。
 *
 * 用户实测：物料那块 textarea 只能看见几行、往下拖不动；他需要的是**只读源码查看**
 * （行号 / 高亮 / 查找 / 规则定位 + 匹配个数），不是编辑 ⇒ 独立组件、独立浮层。
 */
const viewerOpen = ref(false);
const materials = ref<Record<string, ProbeMaterial>>({});
function materialOf(id: string): ProbeMaterial {
  let m = materials.value[id];
  if (!m) {
    m = { url: '', content: '' };
    materials.value[id] = m;
  }
  return m;
}
/** 当前 tab 的物料（读写都落到该 tab 自己那份） */
const probeContent = computed<string>({
  get: () => materialOf(tab.value).content,
  set: (v: string) => {
    materialOf(tab.value).content = v;
  },
});
const probeUrl = computed<string>({
  get: () => materialOf(tab.value).url,
  set: (v: string) => {
    materialOf(tab.value).url = v;
  },
});
const probeOpen = ref(false);
const fetchingPage = ref(false);
const renderingPage = ref(false);
const probeMsg = ref('');
/** 动态取页的结论（渲染层 / 耗时 / 字节 / 是否空壳） */
const renderInfo = ref<{ layers: string; ms: number; bytes: number; hints: string[] } | null>(null);
/** 每个字段一份试跑结果（键 = 字段 path） */
const probeResults = ref<Record<string, ProbeOut>>({});
const probing = ref<Record<string, boolean>>({});
/** 每个字段这次试跑的「作用域说明」（发现侧回落 / 用哪个列表），显示在结论第一行下面 */
const probeNotes = ref<Record<string, string>>({});

/** 取页：走 `/api/proxy`（与图片/媒体同一条通路，源头/Cookie 都在）——拿的是**原始响应** */
async function fetchProbePage() {
  const u = probeUrl.value.trim();
  if (!u) return;
  fetchingPage.value = true;
  probeMsg.value = '';
  renderInfo.value = null;
  try {
    const q = `/api/proxy?u=${encodeURIComponent(u)}${isDraft.value ? '' : `&sid=${encodeURIComponent(props.source.id)}`}`;
    const r = await fetch(q);
    if (!r.ok) {
      probeMsg.value = `取页失败 HTTP ${r.status}`;
      return;
    }
    let text = await r.text();
    /**
     * `#565` **静态取页撞盾 ⇒ 自动接浏览器**（与搜索试跑 / 发现试跑同一套链）。
     * 用户实测 138阅读网：「取页」点完回来的还是过盾页面 —— 静态层过不了 CF。
     * 判据用 core 的 `isChallengePage`（`#562` 同一份：只看内容特征，不看状态码）。
     */
    const chal = isChallengePage(text);
    if (chal.challenge) {
      renderingPage.value = true;
      try {
        const r2 = await fetch('/api/doctor/fetch-page', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: u, ...(isDraft.value ? {} : { sourceId: props.source.id }) }),
        });
        const j2 = (await r2.json()) as { ok: boolean; html?: string; passedVia?: string; error?: string };
        if (j2.ok && j2.html && !isChallengePage(j2.html, chal.via).challenge) {
          text = j2.html;
          probeMsg.value = `静态取页被**挑战页**拦截（${chal.via ?? '站点安全校验'}），已自动用${j2.passedVia ?? '浏览器渲染'}拿到正文`;
        } else {
          probeMsg.value = `静态取页拿到的是**挑战/校验页**（${chal.via ?? '站点安全校验'}），浏览器层也没过：在浮层里过一次验证再取，或手动粘贴页面`;
        }
      } catch {
        probeMsg.value = `静态取页拿到的是**挑战/校验页**（${chal.via ?? '站点安全校验'}），自动取渲染页失败（服务端没起或网络不通）`;
      } finally {
        renderingPage.value = false;
      }
      probeContent.value = await autoFormat(text);
      return;
    }
    probeContent.value = await autoFormat(text);
    probeMsg.value = `已取到 ${probeContent.value.length} 字符（静态）`;
    // 静态取页拿到空壳 ⇒ 直接提示改用动态取页（否则用户会以为是规则写错）
    if (looksLikeShell(probeContent.value)) {
      probeMsg.value = `已取到 ${probeContent.value.length} 字符，但**像是空壳页**（几乎无可见文本）⇒ 点「动态取页」取渲染后的 DOM`;
    }
  } catch {
    probeMsg.value = '取页失败（服务端没起或网络不通）';
  } finally {
    fetchingPage.value = false;
  }
}

/* ---------------- `#558` 物料：自动取页链 + 格式化 ---------------- */

interface MaterialStepOut {
  step: string;
  detail: string;
  url?: string;
  rule?: string;
  status?: number;
  value?: string;
}
interface MaterialInfo {
  url: string;
  kind: string;
  chain: MaterialStepOut[];
  errors: string[];
  keyword?: string;
}
/** 每个 tab 一份「这一页是怎么来的」（自动取物料后填） */
const materialInfo = ref<Record<string, MaterialInfo>>({});
const materialBusy = ref(false);
const formatting = ref(false);
/**
 * 哪些 tab 能「自动取物料」：只有详情/目录/正文。
 * 搜索、发现自己就是**入口**（它们的按钮是「试跑」，物料该怎么来由它们自己算）。
 */
const materialTargetOf = computed<'detail' | 'toc' | 'content' | null>(() =>
  tab.value === 'detail' ? 'detail' : tab.value === 'toc' ? 'toc' : tab.value === 'content' ? 'content' : null,
);

/** 自动格式化（走服务端同一份 core 判据；失败就原样返回，绝不吞内容） */
async function autoFormat(text: string): Promise<string> {
  if (!text.trim()) return text;
  try {
    const r = await fetch('/api/doctor/format', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) return text;
    const j = (await r.json()) as { text?: string };
    return typeof j.text === 'string' && j.text ? j.text : text;
  } catch {
    return text;
  }
}

/** 手动「🧹 格式化」：用户粘贴的内容也能用（自动识别 html/json） */
async function formatNow() {
  if (!probeContent.value.trim()) return;
  formatting.value = true;
  try {
    const r = await fetch('/api/doctor/format', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: probeContent.value }),
    });
    if (!r.ok) {
      probeMsg.value = `格式化失败 HTTP ${r.status}`;
      return;
    }
    const j = (await r.json()) as { text: string; kind: string; changed: boolean; note?: string };
    probeContent.value = j.text;
    probeMsg.value = j.changed
      ? `已格式化（识别为 ${j.kind}）${j.note ? ` · ${j.note}` : ''}`
      : `已经是整齐的 ${j.kind}，没改动${j.note ? ` · ${j.note}` : ''}`;
  } catch {
    probeMsg.value = '格式化失败（服务端没起或网络不通）';
  } finally {
    formatting.value = false;
  }
}

/**
 * **自动取物料**：详情 ← 发现/搜索，目录 ← 详情，正文 ← 目录（判据在 core `resolveMaterial`）。
 * 取回后立刻格式化，并把「这一页是怎么来的」记下来 —— 自动取错了，光看页面是看不出来的。
 */
async function autoMaterial() {
  const target = materialTargetOf.value;
  if (!target) return;
  materialBusy.value = true;
  probeMsg.value = '';
  renderInfo.value = null;
  try {
    const r = await fetch('/api/doctor/material', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target,
        ...(isDraft.value ? {} : { sourceId: props.source.id }),
        ...(isDraft.value ? { source: raw.value } : {}),
        ...(probeUrl.value.trim() ? { url: probeUrl.value.trim() } : {}),
      }),
    });
    if (!r.ok) {
      probeMsg.value = `自动取物料失败 HTTP ${r.status}`;
      return;
    }
    const j = (await r.json()) as {
      ok: boolean;
      url: string;
      content: string;
      kind: string;
      chain: MaterialStepOut[];
      errors: string[];
      keyword?: string;
    };
    materialInfo.value = {
      ...materialInfo.value,
      [tab.value]: { url: j.url, kind: j.kind, chain: j.chain ?? [], errors: j.errors ?? [], ...(j.keyword ? { keyword: j.keyword } : {}) },
    };
    if (j.content) {
      // 地址先记下来：后面「取页」要按它补全相对链接
      probeUrl.value = j.url;
      probeContent.value = await autoFormat(j.content);
      probeMsg.value = `已自动取到 ${tab.value === 'detail' ? '详情' : tab.value === 'toc' ? '目录' : '正文'}页 ${probeContent.value.length} 字符`;
    } else {
      /**
       * `#565` **取不到时说清下一步**（用户原话：「要不到提示输入物料地址，或者先跑通前面 tab」）。
       * 链条说明在下面，但一行结论要能直接指路：详情链要「发现/搜索」先通，
       * 目录/正文链要「详情」先通；任何时候都可以直接粘一页当物料。
       */
      const upstream =
        tab.value === 'detail'
          ? '详情链从「发现/搜索」取页 —— 先在「搜索 / 发现」tab 把试跑跑通（那里能直接看到取页结论）'
          : tab.value === 'toc'
            ? '目录链从「详情」取 tocUrl —— 先在「详情」tab 拿到详情页物料'
            : '正文链从「目录」取首章地址 —— 先在「目录」tab 拿到目录页物料';
      probeMsg.value = `自动取物料失败：${upstream}；也可以在「物料地址」里直接粘一个页面地址，或粘贴页面内容`;
    }
  } catch {
    probeMsg.value = '自动取物料失败（服务端没起或网络不通）';
  } finally {
    materialBusy.value = false;
  }
}


/**
 * 「这份 HTML 是不是空壳」—— 静态抓取最常见的失败形状。
 * 判据（两条同时满足才算）：可见文本 < 200 字 **且** 含 SPA 挂载点/框架标记。
 * 只看字数的会误判（有些页面正文全在 JSON 里），只看挂载点的会误判（Nuxt 站也可能已 SSR 出内容）。
 */
function looksLikeShell(html: string): boolean {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < 200 && /id=["'](?:app|root)["']|__NUXT__|__NEXT_DATA__|window\.__INITIAL_STATE__/.test(html);
}

/**
 * **`#556` 动态取页**：让服务端走**引擎同一份渲染器**取「JS 执行后的 DOM」。
 *
 * 为什么需要：「取页」拿的是原始响应；懒加载列表 / `document.write` / SPA 空壳取不到内容，
 * 这时规则怎么改都是 0 命中。引擎侧本来就有这条路（URL 尾巴 `,{"webView":true}`），
 * 这里只是把它单独做成一个按钮 —— 所以「动态取页能命中」就等于「真跑能命中」。
 * ⚠️ 慢（开浏览器，秒级~十秒级），不要拿它做逐字段试跑的常规手段。
 */
async function fetchProbePageRendered() {
  const u = probeUrl.value.trim();
  if (!u) return;
  renderingPage.value = true;
  probeMsg.value = '';
  renderInfo.value = null;
  try {
    const r = await fetch('/api/doctor/fetch-page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: u, ...(isDraft.value ? {} : { sourceId: props.source.id }) }),
    });
    if (!r.ok) {
      probeMsg.value = `动态取页失败 HTTP ${r.status}`;
      return;
    }
    const j = (await r.json()) as {
      ok: boolean;
      html: string;
      ms: number;
      bytes: number;
      layers: string;
      hints: string[];
      error?: string;
      /** `#565` 有头过盾兜底成功时标注途径（无头层被 CF 认出来时走的这条） */
      passedVia?: string;
    };
    if (!j.ok || !j.html) {
      probeMsg.value = `动态取页失败：${j.error ?? '渲染层没有返回内容（这台机器没有可用 Chromium？）'}`;
      return;
    }
    probeContent.value = await autoFormat(j.html);
    renderInfo.value = { layers: j.layers, ms: j.ms, bytes: j.bytes, hints: j.hints ?? [] };
    probeMsg.value = `已取到渲染后的 ${j.html.length} 字符（${j.ms}ms）` + (j.passedVia ? ` · 经${j.passedVia}` : '');
  } catch {
    probeMsg.value = '动态取页失败（服务端没起或网络不通）';
  } finally {
    renderingPage.value = false;
  }
}
/**
 * **试跑一条字段**：先 B（解出什么），0 命中再自动接 C（候选）。
 *
 * 为什么合并成一个按钮：用户要的是「这条字段对不对」，不是「先选 B 还是 C」。
 * 候选是有成本的（每个候选都要真跑一次）⇒ 只在 0 命中时才做。
 */
async function runProbe(
  path: string,
  opts?: { mode?: 'string' | 'list' | 'elements'; scopeRule?: string; ruleOverride?: string; scopeNote?: string },
) {
  const rule = opts?.ruleOverride ?? getPath(path);
  if (typeof rule !== 'string' || !rule.trim()) {
    probeMsg.value = opts?.scopeNote
      ? `该字段与其回落字段都为空 —— ${opts.scopeNote}`
      : '该字段为空（或不是文本规则）—— 留空有时是引擎的有意行为（如 tocUrl 空 = 共用详情页）；要试跑就先填一条规则';
    return;
  }
  /**
   * `#561` **物料为空不再前端挡死**：服务端是「自取数规则不需要物料」的唯一裁判
   * （判据唯一实现 = core `self-fetch.ts` 的 `isSelfFetchingRule`，前端不抄一份）。
   * 规则/作用域是自取数 JS（七猫这类 API 源的 bookList：自己 `java.ajax` 请求接口，
   * 分类页 404 是正常形态）⇒ 服务端用占位内容直接执行规则；否则回 `NO_CONTENT`，
   * 这里照旧提示并弹出物料面板。过去在这里挡死 ⇒ 用户看到「点击没有响应」，
   * 且 bookList 不出结果 ⇒ 后续所有行内字段、详情/目录/正文物料**全部连锁没法试跑**。
   * baseUrl 用发现试跑算出的首个分类地址（自取数 JS 常从 baseUrl 解析路由参数，如七猫的 `gender=`）。
   */
  const noMaterial = !probeContent.value.trim();
  const baseForProbe = probeUrl.value.trim() || (noMaterial ? (exploreResult.value?.computed?.[0]?.page1 ?? '') : '');
  probing.value = { ...probing.value, [path]: true };
  probeMsg.value = '';
  probeNotes.value = { ...probeNotes.value, [path]: opts?.scopeNote ?? '' };
  try {
    /**
     * `#565` **init 预处理链**：`ruleBookInfo.*`（非 init 自己）的求值内容先被
     * `ruleBookInfo.init` 的结果替换（引擎 `BookInfo.kt:58` 同口径）。
     * 黄金屋这类源的详情字段全是 `@js:JSON.parse(result).x`，`result` 是 init 从
     * og:meta 挖出来又 stringify 的 JSON —— 不先跑 init 就是对整页 HTML 做 JSON.parse。
     * 服务端对已存源会自动补，这里显式传一份 ⇒ 草稿态（源未存）也走同一条链。
     */
    const initRule = path.startsWith('ruleBookInfo.') && path !== 'ruleBookInfo.init' ? getPath('ruleBookInfo.init') : undefined;
    const body: Record<string, unknown> = {
      rule,
      content: probeContent.value,
      field: path,
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.scopeRule ? { scopeRule: opts.scopeRule } : {}),
      ...(typeof initRule === 'string' && initRule.trim() ? { initRule: initRule.trim() } : {}),
      ...(isDraft.value ? {} : { sourceId: props.source.id }),
      ...(baseForProbe ? { baseUrl: baseForProbe } : {}),
    };
    const r = await fetch('/api/doctor/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      probeMsg.value = `试跑失败 HTTP ${r.status}`;
      return;
    }
    const j = (await r.json()) as ProbeOut;
    // `#561` 服务端判「真没物料」⇒ 与旧行为一致（提示 + 弹物料面板）
    if (j.code === 'NO_CONTENT') {
      probeMsg.value = '先给试跑物料（粘贴内容 / 从 URL 取页 / 动态取页）';
      probeOpen.value = true;
      return;
    }
    if (j.selfFetch) {
      probeNotes.value = {
        ...probeNotes.value,
        [path]: '本规则是**自取数 JS**（规则里自己 `java.ajax` 请求接口）：不需要页面物料，以上是直接执行规则的结果。',
      };
    }
    // `#565` init 链回显：让用户知道「详情字段的 result 来自 init，不是整页 HTML」
    if (j.initApplied) {
      const initNote =
        '本字段按引擎口径**先跑「预处理 (init)」再求值**：详情字段的 `result` 来自 init 的结果（从 og:meta 等挖出的 JSON），不是整页 HTML';
      const prev = probeNotes.value[path] ?? '';
      probeNotes.value = {
        ...probeNotes.value,
        [path]: prev ? `${prev}；${initNote}` : initNote,
      };
    }
    // 0 命中 ⇒ 接 C：把能命中的候选跑出来（服务端只在 0 命中时给）
    if (!j.ok && j.hitCount === 0) {
      try {
        const r2 = await fetch('/api/doctor/selector-probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ selector: rule, content: probeContent.value, ...(isDraft.value ? {} : { sourceId: props.source.id }) }),
        });
        if (r2.ok) {
          const j2 = (await r2.json()) as { candidates?: ProbeCandidate[] };
          j.candidates = j2.candidates ?? [];
        }
      } catch {
        /* 候选失败不影响试跑结论 */
      }
    }
    probeResults.value = { ...probeResults.value, [path]: j };
  } catch {
    probeMsg.value = '试跑失败（服务端没起或网络不通）';
  } finally {
    probing.value = { ...probing.value, [path]: false };
  }
}
/** 采用候选：把字段规则换成候选选择器，并立刻复跑一次 */
function adoptCandidate(path: string, sel: string) {
  setPath(path, sel);
  void runProbe(path);
}
/** 试跑结论的一行摘要（命中数 null = 纯 JS 规则，没有命中数这回事） */
function probeLine(r: ProbeOut): string {
  if (r.itemCount != null) {
    const first = (r.values ?? [])[0] ?? '';
    return `${r.ok ? '✅' : '❌'} 列表 ${r.itemCount} 项 · 第 1 项${first ? `解出 ${first.length} 字` : '为空'} · ${r.ms}ms`;
  }
  if (r.samples?.length) return `${r.ok ? '✅' : '❌'} 命中 ${r.hitCount ?? 0} 项 · 下面 ${r.samples.length} 个片段 · ${r.ms}ms`;
  const hit = r.hitCount === null ? '命中数不适用（纯 JS）' : `命中 ${r.hitCount}`;
  return `${r.ok ? '✅' : '❌'} ${r.ok ? `解出 ${r.length} 字` : (r.error ?? '失败')} · ${hit} · ${r.ms}ms`;
}

/* ---------------- `#555` 试跑能力矩阵：点一下之前先分清「跑什么」 ----------------
 *
 * 用户 2026-10-21 的评审把「所有字段都挂一个试跑按钮」判为错：
 *  · 源名称/分组/类型/注释/权重/并发率/请求头/JS 库/变量说明…**没有规则可匹配**，试跑无意义；
 *  · 源 URL 只是一个网址 ⇒ 该做的是**连通测试**（站点能不能开），不是拿规则去匹配；
 *  · 纯 JS 字段（loginCheckJs / *Js）要**真跑 JS**；
 *  · 登录三件套（loginUrl / loginUi / loginCheckJs）是**联动**的：URL 走连通、UI 走预览、Check 跑 JS；
 *  · 列表类字段（bookList / chapterList）要给出**匹配到的元素**，而不是整页文字拼成一大坨；
 *  · 行内字段（name/author/…）必须在**列表项内**求值，而不是对着整页求值。
 *
 * 判据集中在这一个函数里（不在模板里散落），新增字段只改它。
 */
type ProbeKind = 'rule' | 'elements' | 'item' | 'js' | 'url' | 'login-ui' | 'search' | 'explore' | 'regex' | 'none';

/** 明确「无规则可匹配」的字段（纯文本/枚举/数字/JSON 配置）——列出来而不是靠猜 */
const PLAIN_PATHS = new Set([
  'bookSourceName', 'bookSourceGroup', 'bookSourceType', 'bookSourceComment',
  'customOrder', 'weight', 'concurrentRate', 'header', 'headers',
  'jsLib', 'coverDecodeJs', 'variableComment', 'exploreScreen', 'enabledCookieJar',
  /**
   * `#557`（用户 2026-10-21 明说移除按钮）：
   *  · `loginUrl` 的「🔌 连通 / 跑 JS」—— 它与「登录」窗口重复，且连通/执行在预览里给不出可信结论；
   *  · `loginCheckJs` 的「▶ 跑 JS」—— 校验脚本要登录态才有意义，单跑必然误判。
   * 两者的源码仍被 `loginUi` 校验用来查「action 的函数有没有定义」。
   */
  'loginUrl', 'loginCheckJs',
  'ruleSearch.checkKeyWord',
  'ruleContent.imageStyle', 'ruleContent.payAction', 'ruleContent.sourceRegex',
  'ruleContent.replaceRegex', 'ruleContent.imageDecode', 'ruleContent.callBackJs',
  'ruleBookInfo.canReName', 'ruleBookInfo.downloadUrls',
  'sourceName', 'sourceUrl', 'sourceIcon', 'sourceGroup', 'sourceComment', 'sortUrl',
  'singleUrl', 'type', 'articleStyle', 'startStyle', 'style',
  'enableJs', 'loadWithBaseUrl', 'showWebLog', 'cacheFirst', 'nextContentUrl',
  'name', 'group', 'format', 'acClass', 'acList', 'acDetail', 'pgParam', 'playUrl',
  'encode', 'blacklist', 'apiUrl',
]);

/** 列表容器字段（试跑要报「命中几个列表项 + 每项片段」，不是整页文本） */
const LIST_PATHS = new Set([
  'ruleSearch.bookList', 'ruleExplore.bookList', 'ruleToc.chapterList',
  'ruleArticles',
]);

/**
 * 行内字段 → 它的作用域（列表容器）。
 *
 * ⚠️ `#556` 起**按引擎口径**算，不按字段名猜（`engine.ts` BookList 段）：
 *  · 搜索：`bookList` 取 `ruleSearch.bookList || ruleExplore.bookList`；
 *  · 发现：`ruleExplore.bookList` **为空 ⇒ 整个 ruleExplore 被 ruleSearch 取代**（不是逐字段回落）；
 *    非空 ⇒ 只用 `ruleExplore`（其中留空的字段就是空，**不会**回落到搜索的同名字段）。
 * 这一点与用户的直觉（「发现页字段空就复用搜索页」）不同，所以要在结论里写明用的是哪一边。
 */
function itemTargetOf(path: string): { rule: string; scopeRule: string; note?: string } {
  const ruleOf = (p: string) => (typeof getPath(p) === 'string' ? String(getPath(p)) : '');
  const rule = ruleOf(path);
  /**
   * `#559` **目录字段必须在「章节列表」里求值**。
   *
   * 用户实测速读谷：`ruleToc.chapterName = @css:a@text` 在目录 tab 试跑，解出
   * `'光阴之外\n作者：耳根\n番外二 花开故…'`（一个值里拼了书名/作者/章节名）—— 因为此前这个函数
   * **没有 ruleToc 分支**，落到了最后一行 `searchList || exploreList`，于是拿**搜索的书籍列表**
   * （`.item` 推荐卡片）当作用域。用 `ruleToc.chapterList` 后每项正好一个章节名。
   */
  if (path.startsWith('ruleToc.')) {
    const list = ruleOf('ruleToc.chapterList');
    return {
      rule,
      scopeRule: list,
      ...(list ? {} : { note: '目录列表（chapterList）为空：章节字段没有可用的作用域，引擎侧同样取不到章节' }),
    };
  }
  const searchList = ruleOf('ruleSearch.bookList').trim();
  const exploreList = ruleOf('ruleExplore.bookList').trim();
  const leaf = path.slice(path.lastIndexOf('.') + 1);
  if (path.startsWith('ruleExplore.')) {
    if (!exploreList) {
      return {
        rule: ruleOf(`ruleSearch.${leaf}`) || rule,
        scopeRule: searchList,
        note: '发现书籍列表为空 ⇒ 引擎整体回落到搜索规则（这里按搜索侧规则试跑）',
      };
    }
    return { rule, scopeRule: exploreList };
  }
  return { rule, scopeRule: searchList || exploreList };
}

/**
 * 列表容器字段 → 实际生效的规则（`#565` 用户实测：发现 tab 的 bookList 空着点「匹配」没反应）。
 *
 * 引擎口径与 `itemTargetOf` 同源：`ruleExplore.bookList` 为空 ⇒ **整个 ruleExplore 被
 * ruleSearch 取代**。此时「发现」tab 的「▶ 匹配」应拿 `ruleSearch.bookList` 跑，
 * 并在结论里写明「发现侧为空，用的是搜索侧规则」—— 不是没响应，也不是让用户自己去复制。
 */
function listTargetOf(path: string): { rule: string; note?: string } {
  const ruleOf = (p: string) => (typeof getPath(p) === 'string' ? String(getPath(p)) : '');
  const own = ruleOf(path).trim();
  if (path === 'ruleExplore.bookList' && !own) {
    const searchList = ruleOf('ruleSearch.bookList').trim();
    return {
      rule: searchList,
      note: searchList
        ? '发现书籍列表为空 ⇒ 引擎整体回落到搜索规则（这里按搜索侧 bookList 试跑）'
        : '发现书籍列表为空，搜索书籍列表也为空 —— 两边都没有列表规则，引擎同样取不到书籍',
    };
  }
  return { rule: own };
}

/**
 * 行内字段 → 是否有「列表项作用域」——**只回答布尔**，具体用哪条规则由 `itemTargetOf` 给。
 * （`#559` 起两个问题分开：这里曾返回 `'ruleToc.chapterList'` 这种**路径字符串**，
 *  调用方一不小心就会把它当**规则**传给探针 ⇒ 0 命中。）
 */
function hasItemScope(path: string): boolean {
  // RSS 订阅源的列表规则是**扁平路径**（`ruleTitle` 等，没有点号）
  if (/^rule(Title|Link|Image|PubDate|Description)$/.test(path)) return true;
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const prefix = path.slice(0, dot);
  const leaf = path.slice(dot + 1);
  /**
   * ⚠️ **只有列表类前缀**才按项求值。`ruleBookInfo.*`（详情页）是**页级**规则 ——
   * 它对着详情页整页求值才对；给它套一个「列表项作用域」会把详情页拆散（`#555` 的教训）。
   */
  if (!/^rule(Search|Explore|Toc|Articles)$/.test(prefix)) return false;
  return /^(name|author|kind|intro|lastChapter|updateTime|bookUrl|coverUrl|wordCount|chapterName|chapterUrl|isVolume|isVip|isPay)$/.test(leaf);
}

function probeKindOf(path: string): ProbeKind {
  if (path === 'bookSourceUrl') return 'url';
  if (path === 'loginUi') return 'login-ui';
  /** `#557`：正则字段不比页面、不跑 JS —— 它是对**一个 URL 串**做匹配，给「正则结果」 */
  if (path === 'bookUrlPattern') return 'regex';
  if (path === 'searchUrl') return 'search';
  /**
   * `exploreUrl` 单独一种：它既不匹配页面、也不是「纯 JS 一段」，
   * 而是**产出一张分类表**（`@js:`/JSON/`名称::URL` 三种形态）⇒ 走 `probeExplore`。
   */
  if (path === 'exploreUrl') return 'explore';
  if (LIST_PATHS.has(path)) return 'elements';
  /**
   * `#654` **`cms.*` 一个都不是选择器** —— 全是「调用协议参数」（参数名 / ac 值 / 分隔符 / 黑名单）。
   * 不拦的话它们会落到默认的 `rule` 分支，白挂一个「▶ 试跑」按钮：点下去是拿
   * `ac=videolist` 当 JSONPath 去匹配整页，必然报「未命中」，把人往错方向带。
   */
  if (path.startsWith('cms.')) return 'none';
  // RSS 扁平行内规则（`ruleTitle` 等）在 `ruleArticles` 的每一项内求值
  if (/^rule(Title|Link|Image|PubDate|Description)$/.test(path)) return 'item';
  if (PLAIN_PATHS.has(path)) return 'none';
  if (hasItemScope(path)) return 'item';
  if (/Js$/.test(path) || /^ruleToc\.preUpdateJs$/.test(path)) return 'js';
  return 'rule';
}

/** 按钮文案：不同形态给不同动词（「试跑」只属于规则匹配） */
function probeLabel(kind: ProbeKind): string {
  switch (kind) {
    case 'url': return '🔌 连通测试';
    case 'login-ui': return '🧾 校验规则';
    case 'js': return '▶ 跑 JS';
    case 'elements': return '▶ 匹配';
    case 'search': return '▶ 搜索试跑';
    case 'explore': return '▶ 发现试跑';
    case 'regex': return '🧾 正则结果';
    case 'item': return '▶ 试跑（按项）';
    default: return '▶ 试跑';
  }
}

/* ---- 连通测试（`bookSourceUrl` / 登录地址是纯网址时） ---- */
interface ReachOut {
  ok: boolean;
  status: number;
  finalUrl: string;
  ms: number;
  bytes: number;
  contentType: string;
  title: string;
  error?: string;
  hints: string[];
}
const reachResults = ref<Record<string, ReachOut>>({});

async function runReach(path: string, url: string) {
  reachResults.value = { ...reachResults.value, [path]: undefined as unknown as ReachOut };
  probing.value = { ...probing.value, [path]: true };
  probeMsg.value = '';
  try {
    const r = await fetch('/api/doctor/reach', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, ...(isDraft.value ? {} : { sourceId: props.source.id }) }),
    });
    if (!r.ok) {
      probeMsg.value = `连通测试失败 HTTP ${r.status}`;
      return;
    }
    reachResults.value = { ...reachResults.value, [path]: (await r.json()) as ReachOut };
  } catch {
    probeMsg.value = '连通测试失败（服务端没起或网络不通）';
  } finally {
    probing.value = { ...probing.value, [path]: false };
  }
}

/* ---- `#557` 书籍 URL 正则（bookUrlPattern）：它匹配的是**一个 URL 串**，不是页面 ----
 *
 * 用户 2026-10-21 问「该字段结果提供给哪里使用」。如实回答：
 *  · Legado 里它是「详情页 URL 正则」—— 用来判断**某个书籍详情页 URL 是否属于本源**（导入/校验类场景）；
 *  · **本仓引擎当前不消费它**（`docs/ref/legado-capability-matrix-full-20260928.md` 标 ❌，
 *    代码里只有 legacy 迁移 `ruleBookUrlPattern → bookUrlPattern` 与编辑器字段表）。
 *    ⇒ 填错**不影响**搜索/详情/目录解析；这个按钮只用来验「正则本身写对没写对」。
 *  · 用浏览器 `RegExp` 判（与运行期同一套，比服务端往返快）；⚠️ Java 专有语法
 *    （占有量词 `*+`、`\p{IsHan}` 之类）浏览器可能不认，编译失败时要按这个方向排查。
 */
interface RegexOut {
  ok: boolean;
  error?: string;
  matches: { url: string; hit: boolean; whole: string; groups: string[] }[];
}
const regexOut = ref<RegexOut | null>(null);
/** 样本 URL：默认用「试跑物料」的地址，也可以自己粘 */
const regexSample = ref('');

function runRegexTest() {
  const pat = String(getPath('bookUrlPattern') ?? '').trim();
  regexOut.value = null;
  if (!pat) {
    probeMsg.value = '正则为空：这个字段可以不填（不填就不做「URL 属于本源」的判断）';
    return;
  }
  const samples = (regexSample.value || probeUrl.value || 'https://www.example.com/book/12345/')
    .split(/\s+/)
    .filter(Boolean);
  try {
    const re = new RegExp(pat);
    const matches = samples.map((u) => {
      const m = re.exec(u);
      return { url: u, hit: !!m, whole: m?.[0] ?? '', groups: m ? m.slice(1).map((x) => x ?? '') : [] };
    });
    regexOut.value = { ok: matches.every((m) => m.hit), matches };
  } catch (e) {
    regexOut.value = { ok: false, error: e instanceof Error ? e.message : String(e), matches: [] };
  }
}

/* ---- 搜索试跑（默认关键词 / 翻页） ---- */
interface SearchPageOut {
  page: number;
  status: number;
  url: string;
  requestUrl: string;
  method: string;
  bytes: number;
  title: string;
  listCount: number | null;
  firstItem: string;
  /** 只有第 1 页为 true（它的正文会作为试跑物料回传） */
  material: boolean;
  html: string;
  /** `#565` 这份内容怎么取得的：静态 / 无头浏览器渲染 / 有头 Chromium 过盾 */
  via?: string;
}
interface SearchOut {
  ok: boolean;
  code?: string;
  message?: string;
  keyword: string;
  method?: string;
  pageTemplate: boolean;
  paging: 'n/a' | 'advanced' | 'same' | 'unknown';
  problems: string[];
  pages: SearchPageOut[];
  /** 每页实际请求的地址/方法/请求体（`#557`：看得到「规则算出来的是什么」） */
  resolved?: { page: number; url: string; method: string; body?: string; charset?: string }[];
}
const searchResult = ref<SearchOut | null>(null);
const searchKeyword = ref('');
/**
 * ⚠️ 模板里**不能**直接写 `'含 {{page}}'`：Vue 会把中间的 `{{page}}` 当成插值表达式，
 * 于是编译期报 `Property 'page' does not exist`。这两个常量就是为了把花括号挡在模板外。
 */
const PAGE_TPL_ON = '含 {{page}}';
const PAGE_TPL_OFF = '无 {{page}}（不需要翻页）';

async function runSearchProbe() {
  const path = 'searchUrl';
  probing.value = { ...probing.value, [path]: true };
  probeMsg.value = '';
  searchResult.value = null;
  try {
    const r = await fetch('/api/doctor/search-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        searchUrl: getPath('searchUrl'),
        bookList: getPath('ruleSearch.bookList'),
        // 未保存草稿也要能绝对化相对地址（`page/{{page}}` 这类）—— 把编辑器里的源 URL 一起送
        bookSourceUrl: getPath('bookSourceUrl'),
        ...(searchKeyword.value.trim() ? { keyword: searchKeyword.value.trim() } : {}),
        ...(isDraft.value ? { source: raw.value } : { sourceId: props.source.id }),
      }),
    });
    if (!r.ok) {
      probeMsg.value = `搜索试跑失败 HTTP ${r.status}`;
      return;
    }
    const j = (await r.json()) as SearchOut;
    searchResult.value = j;
    // 取回的页面直接当「试跑物料」⇒ 下面的书籍列表/书名等字段立刻可逐条试跑
    const first = j.pages[0];
    if (first?.html) {
      probeContent.value = first.html;
      probeUrl.value = first.url;
      probeOpen.value = true;
      probeMsg.value = `已用第 1 页作为试跑物料（${first.html.length} 字符）`;
    }
  } catch {
    probeMsg.value = '搜索试跑失败（服务端没起或网络不通）';
  } finally {
    probing.value = { ...probing.value, [path]: false };
  }
}

/* ---- `#557` loginUi 规则校验（代码 + 结构 + 预期排版；不再渲染界面） ---- */
interface LoginUiRowOut {
  index: number;
  name: string;
  type: string;
  action: string;
  widthPercent: number;
  chars: string[];
  hint: string;
  problems: string[];
}
interface LoginUiOut {
  ok: boolean;
  kind: 'empty' | 'v2' | 'script' | 'json' | 'html';
  raw: string;
  rows: LoginUiRowOut[];
  layout: { line: number; items: { name: string; widthPercent: number }[] }[];
  actions: { row: number; action: string; kind: 'url' | 'fn' | 'inline' | 'none'; defined?: boolean; note?: string }[];
  problems: { code: string; message: string; fixable: boolean; row?: number }[];
  fixes?: { code: string; detail: string; count: number }[];
  fixed?: string;
  error?: string;
  hints: string[];
  needEval: boolean;
  evaluated?: string;
}
const loginUiResult = ref<LoginUiOut | null>(null);

async function runLoginUi() {
  const path = 'loginUi';
  probing.value = { ...probing.value, [path]: true };
  probeMsg.value = '';
  loginUiResult.value = null;
  try {
    const r = await fetch('/api/doctor/login-ui', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        loginUi: getPath('loginUi'),
        // `#557`：action 的函数定义在 loginUrl / loginCheckJs / jsLib 里 —— 编辑器里未保存的也一起送
        loginUrl: getPath('loginUrl'),
        loginCheckJs: getPath('loginCheckJs'),
        jsLib: getPath('jsLib'),
        ...(isDraft.value ? {} : { sourceId: props.source.id }),
      }),
    });
    if (!r.ok) {
      probeMsg.value = `登录界面校验失败 HTTP ${r.status}`;
      return;
    }
    loginUiResult.value = (await r.json()) as LoginUiOut;
  } catch {
    probeMsg.value = '登录界面校验失败（服务端没起或网络不通）';
  } finally {
    probing.value = { ...probing.value, [path]: false };
  }
}

/** 语法自动纠正：回填后立刻复跑（改完就要看到结论） */
function adoptLoginUiFix() {
  const f = loginUiResult.value?.fixed;
  if (!f) return;
  setPath('loginUi', f);
  void runLoginUi();
}

/* ---- `#556` 发现试跑：exploreUrl 不是选择器，它得「产出」一张分类表 ---- */
interface ExploreKindItem {
  title: string;
  url?: string;
  type?: string;
  header?: boolean;
  note?: string;
}
interface ExploreProblemOut {
  code: string;
  message: string;
  fixable: boolean;
}
interface ExploreOut {
  ok: boolean;
  kind: 'js' | 'json' | 'text' | 'empty';
  kinds: ExploreKindItem[];
  clickable: number;
  problems: ExploreProblemOut[];
  fixes?: { code: string; detail: string; count: number }[];
  /** 自动纠正后的全文（有可修项才给） */
  fixed?: string;
  error?: string;
  ms: number;
  layers: string;
  /** `#557` 每个可点分类算出来的 page=1 / page=2 地址（`{{page == 1 ? …}}` 这类要真求值） */
  computed?: { title: string; raw: string; page1: string; page2: string; errors: string[] }[];
  page?: { url: string; status: number; bytes: number; title: string; html: string; rendered: boolean; ms: number };
  /** `#559` 列表规则是「自取数」（`<js>` + `java.ajax`）—— 页面 404 属正常形态 */
  selfFetching?: boolean;
  /** 自取数列表实跑结果（页面拿不到也能看到项） */
  selfFetch?: { rule: string; ok: boolean; count: number; samples: string[]; error?: string };
  /** 页面这一层的说明（404 但自取数等） */
  pageNote?: string;
}
const exploreResult = ref<ExploreOut | null>(null);
/** 发现页需要渲染（懒加载/SPA）时勾上：首个分类的页面走动态取页 */
const exploreRender = ref(false);
/**
 * ⚠️ 模板里**不能**写双花括号的 `page` 插值（Vue 会当表达式求值，编译期就报 `page 不存在`）。
 * 这里的 `{{page}}` 是**给用户看的字面量**，所以只能放常量里。
 */
const EXPLORE_PAGE_HINT =
  '每个分类给出运算后的首页 / 次页（`{{page}}` 表达式已求值）；首个分类的首页会被取回来当试跑物料：';

/**
 * 分类列表第 i 行 ←→ 哪条 `computed`。
 * 服务端就是按「有 url 的分类」原顺序逐条算的，这里用同一顺序对齐（不是按 URL 文本匹配，
 * 免得多行共用同一个 url 时错位）。
 */
const exploreComputedByKind = computed<Record<number, NonNullable<ExploreOut['computed']>[number]>>(() => {
  const out: Record<number, NonNullable<ExploreOut['computed']>[number]> = {};
  const list = exploreResult.value?.computed ?? [];
  const kinds = exploreResult.value?.kinds ?? [];
  let ci = 0;
  for (let i = 0; i < kinds.length; i++) {
    if (!kinds[i].url) continue;
    const hit = list[ci++];
    if (hit) out[i] = hit;
  }
  return out;
});

async function runExploreProbe() {
  const path = 'exploreUrl';
  probing.value = { ...probing.value, [path]: true };
  probeMsg.value = '';
  exploreResult.value = null;
  try {
    const r = await fetch('/api/doctor/explore-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        exploreUrl: getPath('exploreUrl'),
        bookSourceUrl: getPath('bookSourceUrl'),
        render: exploreRender.value,
        // `#565` 草稿态把编辑器里的源 JSON 一起送（服务端没有 sourceId ⇒ jsLib 会丢）
        ...(isDraft.value ? { source: raw.value } : { sourceId: props.source.id }),
      }),
    });
    if (!r.ok) {
      probeMsg.value = `发现试跑失败 HTTP ${r.status}`;
      return;
    }
    const j = (await r.json()) as ExploreOut;
    exploreResult.value = j;
    /**
     * 首个分类的页面**直接当本 tab 的试跑物料** ⇒ 接下来点「书籍列表 / 书籍名…」
     * 就是在**这张发现页**上匹配（用户 2026-10-21：「bookList 是对发现地址的首个地址页面进行匹配」）。
     */
    if (j.page?.html) {
      probeContent.value = j.page.html;
      probeUrl.value = j.page.url;
      probeMsg.value = `已用首个分类「${j.kinds.find((k) => k.url)?.title ?? ''}」第 1 页作为试跑物料（${j.page.html.length} 字符）`;
    }
  } catch {
    probeMsg.value = '发现试跑失败（服务端没起或网络不通）';
  } finally {
    probing.value = { ...probing.value, [path]: false };
  }
}

/** 一键自动纠正：把 `fixed` 回填到 exploreUrl 并立刻复跑（改完就能看到结论） */
function adoptExploreFix() {
  const f = exploreResult.value?.fixed;
  if (!f) return;
  setPath('exploreUrl', f);
  void runExploreProbe();
}

/**
 * **统一入口**：按字段形态决定跑什么（模板只调这一个函数，判据在 `probeKindOf`）。
 *
 * ⚠️ 「试跑」这个词只保留给**规则匹配**；其余分别是连通测试 / 跑 JS / 搜索试跑 / 发现试跑 / 界面预览。
 * 用户 2026-10-21 的评审原话：「都去试跑，匹配是没有意义的」。
 */
function runField(f: FieldDef) {
  const kind = probeKindOf(f.path);
  const v = getPath(f.path);
  const s = typeof v === 'string' ? v.trim() : '';
  if (kind === 'none') {
    probeMsg.value = '这个字段是元数据/配置，没有规则可匹配 —— 不需要试跑';
    return;
  }
  if (kind === 'url') {
    if (!/^https?:\/\//i.test(s)) {
      probeMsg.value = '源 URL 不是 http/https 网址，无法做连通测试';
      return;
    }
    void runReach(f.path, s);
    return;
  }
  if (kind === 'login-ui') {
    void runLoginUi();
    return;
  }
  if (kind === 'regex') {
    runRegexTest();
    return;
  }
  if (kind === 'search') {
    void runSearchProbe();
    return;
  }
  if (kind === 'explore') {
    void runExploreProbe();
    return;
  }
  if (kind === 'elements') {
    /**
     * `#565` 列表容器也按引擎口径回落：`ruleExplore.bookList` 为空 ⇒ 整个 ruleExplore 被
     * ruleSearch 取代 ⇒ 「匹配」拿搜索侧 bookList 跑（旧行为：空规则早退 ⇒ 点击没反应）。
     */
    const t = listTargetOf(f.path);
    if (!t.rule.trim()) {
      probeMsg.value = t.note ?? '该字段为空，无法匹配';
      return;
    }
    void runProbe(f.path, {
      mode: 'elements',
      ...(t.rule !== s ? { ruleOverride: t.rule } : {}),
      ...(t.note ? { scopeNote: t.note } : {}),
    });
    return;
  }
  if (kind === 'item') {
    // RSS 扁平行内规则：作用域恒为 `ruleArticles`（没有 search/explore 之分）
    if (/^rule(Title|Link|Image|PubDate|Description)$/.test(f.path)) {
      void runProbe(f.path, { scopeRule: 'ruleArticles' });
      return;
    }
    // `#556`：作用域与规则**都按引擎口径算**（发现侧 bookList 为空 ⇒ 整体回落搜索规则）
    const t = itemTargetOf(f.path);
    void runProbe(f.path, {
      scopeRule: t.scopeRule || undefined,
      ruleOverride: t.rule,
      ...(t.note ? { scopeNote: t.note } : {}),
    });
    return;
  }
  void runProbe(f.path);
}

/* ---- 常见请求头一键插入（用户 2026-10-21：请求头后面给几个常见 UA） ---- */
const HEADER_PRESETS: { name: string; headers: Record<string, string> }[] = [
  { name: 'PC Chrome', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } },
  { name: 'Android Chrome', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' } },
  { name: 'iOS Safari', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } },
  { name: 'Referer 占位', headers: { Referer: 'https://example.com/' } },
];
function insertHeaderPreset(path: string, preset: (typeof HEADER_PRESETS)[number]) {
  const cur = getPath(path);
  let base: Record<string, string> = {};
  if (typeof cur === 'string' && cur.trim()) {
    try {
      const o = JSON.parse(cur) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) base = o as Record<string, string>;
    } catch {
      /* 现有内容不是 JSON：保留原文，插入后由用户自行整理 */
      probeMsg.value = '现有请求头不是 JSON，已覆盖为预设（请自行补回需要的键）';
    }
  }
  setPath(path, JSON.stringify({ ...base, ...preset.headers }, null, 0));
}

/** 编辑器 raw 变化 → 防抖 700ms 体检；打开时先体检一次 */
watch(
  raw,
  () => {
    if (inspectTimer) clearTimeout(inspectTimer);
    inspectTimer = setTimeout(() => void runInspect(), 700);
  },
  { deep: true },
);

onMounted(async () => {
  if (isDraft.value) {
    // 新建：用占位模板起步（不含任何服务端交互）
    raw.value = { ...(props.initialRaw ?? {}) };
  } else {
    try {
      const r = await fetch(`/api/sources/${encodeURIComponent(props.source.id)}`);
      const j = await r.json();
      raw.value = (j.raw ?? {}) as Record<string, unknown>;
    } catch {
      raw.value = {};
    }
  }
  snapshot.value = JSON.stringify(raw.value, null, 2);
  jsonText.value = snapshot.value;
  void runInspect(); // `#550` 打开即体检一次
});

// ---- path 读写（支持 ruleSearch.bookList 等嵌套） ----
function getPath(path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), raw.value);
}
function setPath(path: string, val: unknown) {
  const keys = path.split('.');
  let o = raw.value as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i] as string;
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1] as string] = val;
}
/**
 * `#460` **契约里本来就是布尔/数字的字段**（路径 → 类型）—— 与字段「当前是否存在」无关地归一。
 *
 * 为什么必须有一张表（而不是只看当前值）：`#330` 的写法是「按**原值类型**写回」，
 * 于是「字段原本不存在」时只能按字符串落盘 ⇒ 新建源（占位模板里没有这些键、用户又在
 * JSON 视图里删过键）仍会被污染。用户 2026-10-15 实测报的就是这一条。
 * 类型污染的后果是**功能级**的：`rss-source.ts` 读 `raw.singleUrl === true` /
 * `typeof raw.articleStyle === 'number'` —— 字符串 `"true"`/`"2"` 会让能力位静默失效、数值静默回落 0。
 *
 * 口径来源：`engine-rss/src/model/rss-source.ts` 的 `RssSourceRaw`（= 上游 `RssSource.kt`）。
 * ⚠️ 只收「契约里确实是 Boolean / Int」的字段：`concurrentRate` 上游是 **String**（"1000/5"），
 *    `customOrder`/`type`/`articleStyle`/`lastUpdateTime` 是 Int，`weight`（书源）也是 Int。
 */
const TYPED_FIELDS: Record<string, 'boolean' | 'number'> = {
  // 书源（`BookSource.kt:34-103` 的非 null 默认值字段）
  enabled: 'boolean', enabledExplore: 'boolean', enabledCookieJar: 'boolean',
  eventListener: 'boolean', customButton: 'boolean',
  customOrder: 'number', weight: 'number', bookSourceType: 'number',
  // `#653` CMS 的每页条数是数字（写成字符串会让引擎 `Number()` 出 NaN ⇒ 静默不发 limit）
  'cms.pageSize': 'number',
  // 订阅源（RssSource）—— WebView 区四个开关 + 列表样式/类型/排序
  singleUrl: 'boolean', enableJs: 'boolean', loadWithBaseUrl: 'boolean',
  showWebLog: 'boolean', cacheFirst: 'boolean', preload: 'boolean',
  articleStyle: 'number', type: 'number', lastUpdateTime: 'number',
};

/**
 * `#654` **列表型字段按「分隔符文本」编辑**（逗号 / 换行），而不是 JSON 数组。
 *
 * 为什么必须做：`cms.blacklist` / `cms.blackId` 在源 JSON 里可能是 `["电影片"]`，
 * 通用 `field()` 会把它显示成 `["电影片"]` —— 用户按提示「逗号分隔」改成
 * `电影片,里番` 后写回的是**字符串**，看起来能用，但同一屏里「数组形态」和「字符串形态」
 * 来回跳，改一次变一次，很容易以为没保存。这里统一成文本进出、数组落盘。
 */
const LIST_TEXT_FIELDS: Record<string, string> = {
  'cms.blacklist': ',',
  'cms.blackId': ',',
  'cms.siteDomains': '\n',
  // 兼容老源（`#479` 平铺形态）—— 在 JSON tab 里仍可能看到
  blacklist: ',',
  categories: ',',
};

function field(path: string) {
  const listSep = LIST_TEXT_FIELDS[path];
  return computed<string>({
    get: () => {
      const v = getPath(path);
      if (listSep && Array.isArray(v)) return v.map((x) => String(x)).join(listSep);
      return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    },
    set: (v: string) => {
      // 列表型：文本 ⇄ 数组（空文本写空数组，而不是留下一个 `[""]`）
      if (listSep) {
        const arr = v.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean);
        setPath(path, arr);
        return;
      }
      // ★ `#330`/`#460`：布尔/数字字段按**原类型**写回。表单只能出字符串，直接 setPath 会把
      //   `true` 改写成 `"true"`（数字同理）——保存后引擎读 `raw.singleUrl === true`
      //   之类判据全部失效（类型污染且无报错）。
      const cur = getPath(path);
      const want = TYPED_FIELDS[path] ?? (typeof cur === 'boolean' ? 'boolean' : typeof cur === 'number' ? 'number' : '');
      if (want === 'boolean') { setPath(path, v.trim() === 'true'); return; }
      if (want === 'number') {
        const n = Number(v);
        // 空串 / 非数字：**照原文保留**（让用户在 JSON 视图里能看到自己写了什么错值），不静默塞 0
        setPath(path, v.trim() !== '' && Number.isFinite(n) ? n : v);
        return;
      }
      setPath(path, v);
    },
  });
}

// ---- Tab / 字段定义（字段集对照 Legado BookSource.kt / SearchRule / ExploreRule / BookInfoRule / TocRule / ContentRule 逐条提取） ----
interface FieldDef {
  path: string;
  label: string;
  /**
   * ⚠️ `rows` / `long` **当前不再用于高度**（2026-09-29 用户实测 ②-b：各字段高度必须一致，
   * 统一为「初始 2 行 / 最多 9 行」，见 `RuleFieldEditor` 与 `CodeField.autoH`）。
   * 保留它们只是「这个字段通常比较长」的备注 —— **不要再拿它去设高度**。
   */
  rows?: number;
  long?: boolean;
}
interface TabDef { id: string; name: string; fields: FieldDef[]; note?: string }

const LEGADO_TABS: TabDef[] = [
  { id: 'basic', name: '基本', fields: [
    { path: 'bookSourceUrl', label: '源 URL (bookSourceUrl)' },
    { path: 'bookSourceName', label: '源名称 (bookSourceName)' },
    { path: 'bookSourceGroup', label: '源分组 (bookSourceGroup)' },
    // 源类型取值以 Legado `BookSourceType.kt` 为准：0 文本 / 1 音频 / 2 图片 /
    // 3 只提供下载服务的网站（文件）/ 4 视频 —— 共 **5** 类（此处文案曾漏掉「4视频」）
    { path: 'bookSourceType', label: '源类型 (bookSourceType)：0文本 1音频 2图片 3文件(下载站) 4视频' },
    { path: 'bookSourceComment', label: '源注释 (bookSourceComment)', rows: 4 },
    { path: 'bookUrlPattern', label: '书籍 URL 正则 (bookUrlPattern)' },
    { path: 'customOrder', label: '手动排序 (customOrder)' },
    { path: 'weight', label: '权重 (weight)' },
    { path: 'concurrentRate', label: '并发率 (concurrentRate)' },
    { path: 'header', label: '请求头 (header)', rows: 4 },
    { path: 'jsLib', label: 'JS 库 (jsLib)', rows: 6 },
    { path: 'loginUrl', label: '登录地址/JS (loginUrl)', rows: 4 },
    { path: 'loginUi', label: '登录界面 (loginUi)', rows: 4 },
    { path: 'loginCheckJs', label: '登录校验 JS (loginCheckJs)', rows: 3 },
    { path: 'coverDecodeJs', label: '封面解密 JS (coverDecodeJs)', rows: 3 },
    { path: 'variableComment', label: '源变量说明 (variableComment)', rows: 3 },
    { path: 'exploreScreen', label: '发现筛选 (exploreScreen)', rows: 2 },
    { path: 'enabledCookieJar', label: '启用 CookieJar (enabledCookieJar)' },
  ]},
  { id: 'search', name: '搜索', fields: [
    { path: 'searchUrl', label: '搜索地址 (searchUrl)', rows: 4 },
    { path: 'ruleSearch.checkKeyWord', label: '校验关键字 (checkKeyWord)' },
    { path: 'ruleSearch.bookList', label: '书籍列表 (bookList)', rows: 4 },
    { path: 'ruleSearch.name', label: '书籍名 (name)', rows: 2 },
    { path: 'ruleSearch.author', label: '作者 (author)', rows: 2 },
    { path: 'ruleSearch.kind', label: '分类 (kind)', rows: 2 },
    { path: 'ruleSearch.intro', label: '简介 (intro)', rows: 3 },
    { path: 'ruleSearch.lastChapter', label: '最新章节 (lastChapter)', rows: 2 },
    { path: 'ruleSearch.updateTime', label: '更新时间 (updateTime)', rows: 2 },
    { path: 'ruleSearch.bookUrl', label: '书籍地址 (bookUrl)', rows: 2 },
    { path: 'ruleSearch.coverUrl', label: '封面 (coverUrl)', rows: 2 },
    { path: 'ruleSearch.wordCount', label: '字数 (wordCount)', rows: 2 },
  ]},
  { id: 'explore', name: '发现', fields: [
    { path: 'exploreUrl', label: '发现地址 (exploreUrl)', rows: 6 },
    { path: 'ruleExplore.bookList', label: '书籍列表 (bookList)', rows: 4 },
    { path: 'ruleExplore.name', label: '书籍名 (name)', rows: 2 },
    { path: 'ruleExplore.author', label: '作者 (author)', rows: 2 },
    { path: 'ruleExplore.kind', label: '分类 (kind)', rows: 2 },
    { path: 'ruleExplore.intro', label: '简介 (intro)', rows: 3 },
    { path: 'ruleExplore.lastChapter', label: '最新章节 (lastChapter)', rows: 2 },
    { path: 'ruleExplore.updateTime', label: '更新时间 (updateTime)', rows: 2 },
    { path: 'ruleExplore.bookUrl', label: '书籍地址 (bookUrl)', rows: 2 },
    { path: 'ruleExplore.coverUrl', label: '封面 (coverUrl)', rows: 2 },
    { path: 'ruleExplore.wordCount', label: '字数 (wordCount)', rows: 2 },
  ]},
  { id: 'detail', name: '详情', fields: [
    { path: 'ruleBookInfo.init', label: '预处理 (init)', rows: 3 },
    { path: 'ruleBookInfo.name', label: '书籍名 (name)', rows: 2 },
    { path: 'ruleBookInfo.author', label: '作者 (author)', rows: 2 },
    { path: 'ruleBookInfo.intro', label: '简介 (intro)', rows: 4 },
    { path: 'ruleBookInfo.kind', label: '分类 (kind)', rows: 2 },
    { path: 'ruleBookInfo.lastChapter', label: '最新章节 (lastChapter)', rows: 2 },
    { path: 'ruleBookInfo.updateTime', label: '更新时间 (updateTime)', rows: 2 },
    { path: 'ruleBookInfo.coverUrl', label: '封面 (coverUrl)', rows: 2 },
    { path: 'ruleBookInfo.tocUrl', label: '目录地址 (tocUrl)', rows: 2 },
    { path: 'ruleBookInfo.wordCount', label: '字数 (wordCount)', rows: 2 },
    { path: 'ruleBookInfo.canReName', label: '允许改名 (canReName)', rows: 2 },
    { path: 'ruleBookInfo.downloadUrls', label: '下载地址 (downloadUrls)', rows: 3 },
  ]},
  { id: 'toc', name: '目录', fields: [
    { path: 'ruleToc.preUpdateJs', label: '目录前置 JS (preUpdateJs)', rows: 4 },
    { path: 'ruleToc.chapterList', label: '目录列表 (chapterList)', rows: 4 },
    { path: 'ruleToc.chapterName', label: '章节名称 (chapterName)', rows: 2 },
    { path: 'ruleToc.chapterUrl', label: '章节地址 (chapterUrl)', rows: 2 },
    { path: 'ruleToc.formatJs', label: '章节名整理 JS (formatJs)', rows: 3 },
    { path: 'ruleToc.isVolume', label: '卷名 (isVolume)', rows: 2 },
    { path: 'ruleToc.isVip', label: 'VIP 标记 (isVip)', rows: 2 },
    { path: 'ruleToc.isPay', label: '付费标记 (isPay)', rows: 2 },
    { path: 'ruleToc.updateTime', label: '更新时间 (updateTime)', rows: 2 },
    { path: 'ruleToc.nextTocUrl', label: '目录下一页 (nextTocUrl)', rows: 2 },
  ]},
  { id: 'content', name: '正文', fields: [
    { path: 'ruleContent.content', label: '正文 (content)', rows: 5 },
    { path: 'ruleContent.title', label: '正文章节名 (title)', rows: 2 },
    { path: 'ruleContent.subContent', label: '副文规则 (subContent)', rows: 3 },
    { path: 'ruleContent.nextContentUrl', label: '正文下一页 (nextContentUrl)', rows: 2 },
    { path: 'ruleContent.webJs', label: '网页 JS (webJs)', rows: 3 },
    { path: 'ruleContent.sourceRegex', label: '源正则 (sourceRegex)', rows: 2 },
    { path: 'ruleContent.replaceRegex', label: '净化规则 (replaceRegex)', rows: 4 },
    { path: 'ruleContent.imageStyle', label: '图片样式 (imageStyle)：0默认 1FULL' },
    { path: 'ruleContent.imageDecode', label: '图片解密 JS (imageDecode)', rows: 3 },
    { path: 'ruleContent.payAction', label: '购买操作 (payAction)', rows: 3 },
    { path: 'ruleContent.callBackJs', label: '事件回调 JS (callBackJs)', rows: 3 },
  ]},
  { id: 'review', name: '段评', fields: [], note: '段评（章节评论）规则字段待对照 Legado 源码逐条核对后开放——不做无依据的字段猜测。' },
];

const MACCMS_TABS: TabDef[] = [
  { id: 'basic', name: '基本', fields: [
    { path: 'apiUrl', label: '接口地址 (apiUrl)' },
    { path: 'format', label: '接口类型 (format)：json / xml，留空自动推断' },
    { path: 'name', label: '名称 (name)' },
    /**
     * MacCMS 的**分组**字段名是 `group`（不是 legado 的 `bookSourceGroup`）。
     * 依据：`apps/server/src/index.ts` 的 `publicSource()` 取 `str('bookSourceGroup') ?? str('group')`
     * —— 源列表的「分组」列与分组筛选读的就是它；引擎不消费这个字段（纯元数据）。
     *
     * 2026-09-29 用户实测 ①：此前 MacCMS 源**只能在导入时指定分组、或手改 JSON 源码**
     * ⇒ 补上这个入口。
     */
    { path: 'group', label: '分组 (group)' },
    /**
     * `#654` **请求头从「进阶」挪到「基本」**：它跟「这个源怎么连」是同一类事，
     * 而不是「接口参数怎么拼」。引擎已接通（`parseHeader` + `fetchJson`）——
     * `#653` 之前这个框是**死字段**（填了引擎不读），是用户实测报「某些源总是反爬页」的隐形原因。
     */
    { path: 'header', label: '请求头 header（每行一个 Key: Value，如 Referer: https://站点/；也可直接粘 JSON）', long: true },
  ]},
  /**
   * `#653` **CMS 参数**（对齐全仓参考实现 OmniFlow 的 `CmsEndpoint`）。
   * `#654` **「进阶」tab 已并入这里并删除** —— 用户实测「进阶的字段和 CMS 参数重复了」：
   * 其中 `pgParam` 与这里同名、`acClass/acList/acDetail` 是四个 `xxxAc` 的旧别名，
   * 同时摆两处只会让人不知道该填哪个。
   *
   * 取舍：**UI 只留新命名**（`catAc/contentAc/detailAc`），旧别名引擎照样读
   * （`compileCmsSource` 的 `pick()`），只是不再占表单位置 —— 老源不用改，新源不会填错。
   *
   * 语义速记（引擎侧 `AC_DEFAULTS` / `explicitAc`）：
   *  · 四个 `xxxAc` 填的是 **ac 的值**（`detail` / `videolist` / `list`），不是参数名；
   *  · 留空 = 自动 fallback（并在成功时自学习记住），填了 = 优先试它；
   *  · 参数名（acParam…）改名才影响「键叫啥」，不影响「值试哪个」。
   */
  { id: 'cms', name: 'CMS 参数', note: '四个 xxxAc 填的是「值」（detail / videolist / list），参数名只管「键叫什么」。留空 = 自动回退并自学习记住。', fields: [
    { path: 'cms.acParam', label: '参数名 · ac（默认 ac；部分 CMS 变体用 action）' },
    { path: 'cms.wdParam', label: '参数名 · 搜索关键词（默认 wd）' },
    { path: 'cms.pgParam', label: '参数名 · 分页页码（默认 pg）' },
    { path: 'cms.typeParam', label: '参数名 · 分类（默认 t）' },
    { path: 'cms.idsParam', label: '参数名 · 详情 id（默认 ids）' },
    { path: 'cms.limitParam', label: '参数名 · 每页条数（默认 limit；不填 pageSize 时不发该参数）' },
    { path: 'cms.pageSize', label: '每页条数 pageSize（留空 = 不发 limit，保持旧行为）' },
    { path: 'cms.searchAc', label: '搜索 ac 值 searchAc（空 = detail → videolist → list）' },
    { path: 'cms.catAc', label: '分类树探测 ac 值 catAc（空 = list → class）' },
    { path: 'cms.contentAc', label: '内容分页 ac 值 contentAc（空 = detail → videolist，卡片有封面）' },
    { path: 'cms.detailAc', label: '详情 ac 值 detailAc（空 = detail → videolist）' },
    { path: 'cms.playUrlSplit', label: '选集分格方案 playUrlSplit：dollar-hash / crlf / colon（留空=自动）' },
    { path: 'cms.playFromSplit', label: '多线路分隔符 playFromSplit（默认 $$$）' },
    { path: 'playUrl', label: '播放解析 playUrl（json:<解析接口>?url= 前缀形态；留空=直链直接播）', long: true },
    { path: 'encode', label: '编码 encode（预留：当前引擎不消费，仅随源导出保留）' },
    { path: 'cms.brand', label: '品牌 brand（maccms / 10cms / feifeicms，仅备注）' },
    { path: 'cms.siteDomains', label: '备用域名 siteDomains（每行一个 https://xxx，主域网络失败时按序重试）', long: true },
    { path: 'cms.blacklist', label: '屏蔽分类 blacklist：逗号分隔 分类id 或 分类名（如 里番,39），命中即整类屏蔽', long: true },
    { path: 'cms.blackId', label: '屏蔽影片 blackId：逗号分隔 vod_id（如 1024,2048），命中的片子不出现在列表', long: true },
    { path: 'cms.extraParams', label: '附加固定参数 extraParams（JSON，如 {"h":"24"}；留空不传）', long: true },
  ]},
];

/**
 * RSS 订阅源 tab（`#330`）—— **对齐上游 `RssSourceEditActivity` 的四分区**
 * （`upSourceView` 里 sourceEntities / startEntities / listEntities / webViewEntities，
 * 2026-10-08 逐条抄录），字段名对照本仓 `packages/engine-rss/src/model/rss-source.ts`
 * （上游 `RssSource.kt` 主构造器 45 字段），中文文案取上游 `values-zh/strings.xml`。
 * ★ 与 legado 的差异（用户报「二者 tab 划分有很大不同」）：RSS **没有** 搜索/发现/详情/目录
 *   这些书源分区 —— 订阅源列表就是文章列表（ruleArticles 族），正文规则上游也归在
 *   WEB_VIEW 区，这里照抄上游、不自创第五种分法。
 * ★ 布尔字段（enableJs 族 / singleUrl）与数字字段（type 族）表单里按文本编辑，
 *   写回时由 `field()` 按原类型落 JSON（true 不会被写成 "true"）。
 */
const RSS_TABS: TabDef[] = [
  { id: 'basic', name: '基本', note: 'sortUrl 是「分类表」而非单个 URL：每行一条 分类名::url，用 && 或换行分隔（#307）。', fields: [
    { path: 'sourceName', label: '源名称 (sourceName)' },
    { path: 'sourceUrl', label: '源 URL (sourceUrl)' },
    { path: 'sourceIcon', label: '图标 (sourceIcon)' },
    { path: 'sourceGroup', label: '源分组 (sourceGroup)' },
    { path: 'sourceComment', label: '源注释 (sourceComment)' },
    { path: 'searchUrl', label: '搜索地址 (searchUrl)' },
    { path: 'sortUrl', label: '分类 URL (sortUrl)' },
    { path: 'singleUrl', label: '单 URL 源 (singleUrl)：true=整源当一篇文章直接打开' },
    { path: 'type', label: '源类型 (type)：0网页 1图片 2视频' },
    { path: 'articleStyle', label: '列表样式 (articleStyle)：0列表 1单列 2双列 3瀑布 4三列' },
    { path: 'loginUrl', label: '登录 URL (loginUrl)' },
    { path: 'loginUi', label: '登录 UI (loginUi)' },
    { path: 'loginCheckJs', label: '登录检查 JS (loginCheckJs)' },
    { path: 'coverDecodeJs', label: '封面解密 JS (coverDecodeJs)' },
    { path: 'header', label: '请求头 (header)' },
    { path: 'variableComment', label: '源变量说明 (variableComment)' },
    { path: 'concurrentRate', label: '并发率 (concurrentRate)' },
    { path: 'jsLib', label: 'JS 库 (jsLib)' },
    { path: 'customOrder', label: '手动排序 (customOrder)' },
  ]},
  { id: 'start', name: '启动', fields: [
    { path: 'startHtml', label: '启动页 HTML (startHtml)' },
    { path: 'startStyle', label: '启动页样式 (startStyle)' },
    { path: 'startJs', label: '启动页 JS (startJs)' },
    { path: 'preloadJs', label: '预注入 JS (preloadJs)' },
  ]},
  { id: 'list', name: '列表', fields: [
    { path: 'ruleArticles', label: '列表规则 (ruleArticles)' },
    { path: 'ruleNextPage', label: '列表下一页规则 (ruleNextPage)' },
    { path: 'ruleTitle', label: '标题规则 (ruleTitle)' },
    { path: 'rulePubDate', label: '时间规则 (rulePubDate)' },
    { path: 'ruleDescription', label: '描述规则 (ruleDescription)' },
    { path: 'ruleImage', label: '图片 URL 规则 (ruleImage)' },
    { path: 'ruleLink', label: '链接规则 (ruleLink)' },
  ]},
  { id: 'webview', name: 'WEB_VIEW', fields: [
    { path: 'enableJs', label: '启用 JavaScript (enableJs)：true/false' },
    { path: 'loadWithBaseUrl', label: '加载 BaseUrl (loadWithBaseUrl)：true/false' },
    { path: 'showWebLog', label: '输出 WebLog (showWebLog)：true/false' },
    { path: 'cacheFirst', label: '优先加载缓存 (cacheFirst)：true/false' },
    { path: 'ruleContent', label: '内容规则 (ruleContent)' },
    { path: 'nextContentUrl', label: '正文下一页 URL 规则 (nextContentUrl)' },
    { path: 'style', label: '样式 (style)' },
    { path: 'injectJs', label: '注入 JS (injectJs)' },
    { path: 'contentWhitelist', label: '白名单 (contentWhitelist)' },
    { path: 'contentBlacklist', label: '黑名单 (contentBlacklist)' },
    { path: 'shouldOverrideUrlLoading', label: 'URL 跳转拦截 JS（返回 true 拦截）(shouldOverrideUrlLoading)' },
  ]},
];

const isCms = computed(() => props.source.kind === 'maccms');
const isRss = computed(() => props.source.kind === 'rss');
const tabs = computed<TabDef[]>(() =>
  [{ id: 'json', name: 'JSON 源码', fields: [] as FieldDef[] }].concat(
    isCms.value ? MACCMS_TABS : isRss.value ? RSS_TABS : LEGADO_TABS,
  ),
);
/**
 * `#653` CMS 分类缓存面板：分类名只**生成一次**（服务端 KV 持久化），
 * 之后打开这个 tab 就是读本地；「刷新分类」才重新打站点。
 */
const cats = ref<Array<{ label: string; typeId: string }>>([]);
const catsLoading = ref(false);
const catsError = ref('');

async function loadCats(refresh: boolean): Promise<void> {
  const id = props.source.id;
  if (!id) return;
  catsLoading.value = true;
  catsError.value = '';
  try {
    const r = refresh ? await refreshCmsCategories(id) : await getCmsCategories(id);
    cats.value = r.items;
  } catch (e) {
    catsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    catsLoading.value = false;
  }
}

watch(
  () => [tab.value, props.source.id] as const,
  ([t]) => {
    // 只在该源是 maccms 且真的切到「CMS 参数」时才读（避免每切一个源都打站点）
    if (t === 'cms' && props.source.kind === 'maccms') void loadCats(false);
  },
  { immediate: true },
);

const curTab = computed(() => tabs.value.find((t) => t.id === tab.value));
/**
 * `#556` 哪些 tab 值得给「试跑物料」：
 *  · `JSON 源码` —— 整篇编辑，没有「字段在某份页面上求值」这回事；
 *  · `基本` —— 源名称/分组/类型/请求头/JS 库/登录三件套…**都不需要页面**（连通测试与跑 JS 自成一路）。
 *  · `CMS 参数`（`#654` 起并入原「进阶」）—— 全是**调用协议参数**，没有「在某份页面上求值」这回事。
 *
 * 其余 tab（搜索/发现/详情/目录/正文、RSS 列表/WEB_VIEW）各自一份物料。
 */
const probeAvailable = computed(
  () =>
    tab.value !== 'json' &&
    tab.value !== 'basic' &&
    // `#654` CMS 参数全是「协议参数」，给页面求值框只会误导
    tab.value !== 'cms' &&
    (curTab.value?.fields.length ?? 0) > 0,
);

// ---- 设置栏开关（SourceState，走 API 实时生效） ----
async function toggleState(field: keyof SrcState, val: boolean) {
  const r = await setSourceState(props.source.id, { [field]: val });
  props.source.state = r.state;
}

// ---- JSON 视图 ----
function syncJsonToRaw() {
  jsonError.value = '';
  try {
    raw.value = JSON.parse(jsonText.value) as Record<string, unknown>;
  } catch (e) {
    jsonError.value = 'JSON 语法错误：' + String(e instanceof Error ? e.message : e);
  }
}
function switchTab(id: string) {
  if (tab.value === 'json' && id !== 'json') syncJsonToRaw();
  if (jsonError.value) return; // JSON 有错时不允许切走
  tab.value = id;
  if (id === 'json') jsonText.value = JSON.stringify(raw.value, null, 2);
}

/** 左栏「编辑分区」⇒ 编辑器跟随切 tab（`#330`：此前左栏按钮只改自身高亮，编辑器从不响应） */
watch(
  () => props.tab,
  (id) => {
    if (id && id !== tab.value && tabs.value.some((t) => t.id === id)) switchTab(id);
  },
);

// ---- 动作条 ----
async function save() {
  saving.value = true;
  saveMsg.value = '';
  if (tab.value === 'json') syncJsonToRaw();
  if (jsonError.value) { saving.value = false; return; }
  try {
    if (isDraft.value) {
      // `#268` 新建源：此刻才真正入库（POST）。
      // ★ 前端先校验必填项 —— 对齐上游 `BookSourceEditViewModel.save`（:52-55）：
      //   「bookSourceUrl / bookSourceName 为空 ⇒ NoStackTraceException(non_null_name_url)」；
      //   maccms 同理（name / apiUrl）；rss（`#365`）同理（sourceName / sourceUrl，
      //   字段名对照上游 `RssSource`，本仓 `engine-rss/src/model/rss-source.ts` 同口径）。
      //   不满足 ⇒ **弹错误提示**，不发请求。
      const nameKey = props.source.kind === 'maccms' ? 'name' : props.source.kind === 'rss' ? 'sourceName' : 'bookSourceName';
      const urlKey = props.source.kind === 'maccms' ? 'apiUrl' : props.source.kind === 'rss' ? 'sourceUrl' : 'bookSourceUrl';
      const name = String(raw.value[nameKey] ?? '').trim();
      const url = String(raw.value[urlKey] ?? '').trim();
      if (!name || !url) {
        const msg = '创建失败：名称与 URL 不能为空（' + nameKey + ' / ' + urlKey + '）—— 对齐上游 non_null_name_url';
        saveMsg.value = msg;
        window.alert(msg);
        saving.value = false;
        return;
      }
      try {
        const r = await createSource(raw.value, props.source.kind);
        saveMsg.value = `已创建源：${r.name || r.id}`;
        emit('renamed', r.id);
        emit('saved');
      } catch (e) {
        const msg = '创建失败：' + String(e instanceof Error ? e.message : e);
        saveMsg.value = msg;
        window.alert(msg);
      }
      return;
    }
    await updateSource(props.source.id, raw.value);
    snapshot.value = JSON.stringify(raw.value, null, 2);
    saveMsg.value = '已保存并重新编译';
    emit('saved');
  } catch (e) {
    saveMsg.value = '保存失败：' + String(e instanceof Error ? e.message : e);
  } finally {
    saving.value = false;
  }
}

async function saveAsNew() {
  if (tab.value === 'json') syncJsonToRaw();
  if (jsonError.value) return;
  try {
    const r = await createSource(raw.value);
    saveMsg.value = `已另存为新源：${r.name || r.id}（id: ${r.id}）`;
    emit('renamed', r.id);
  } catch (e) {
    saveMsg.value = '另存失败：' + String(e instanceof Error ? e.message : e);
  }
}

function exportSource() {
  if (tab.value === 'json') syncJsonToRaw();
  const blob = new Blob([JSON.stringify(raw.value, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(props.source.name || props.source.id).replace(/[\\/:*?"<>|]/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  saveMsg.value = '已导出源 JSON';
}

function rollback() {
  if (!confirm('回滚到打开编辑器时的内容？（之后的修改将丢失）')) return;
  raw.value = JSON.parse(snapshot.value) as Record<string, unknown>;
  jsonText.value = snapshot.value;
  jsonError.value = '';
  saveMsg.value = '已回滚';
}

function doDebug() {
  if (tab.value === 'json') syncJsonToRaw();
  if (jsonError.value) return;
  emit('debug');
}

// ---- 拷贝源 / 粘贴源 ----
async function copySource() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(raw.value, null, 2));
    saveMsg.value = '已拷贝源 JSON 到剪贴板';
  } catch {
    saveMsg.value = '拷贝失败（剪贴板不可用）';
  }
}
async function pasteSource() {
  try {
    const text = await navigator.clipboard.readText();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    raw.value = parsed;
    if (tab.value === 'json') jsonText.value = JSON.stringify(parsed, null, 2);
    saveMsg.value = '已从剪贴板粘贴';
  } catch (e) {
    saveMsg.value = '粘贴失败：' + String(e instanceof Error ? e.message : e);
  }
}

// ---- 源变量 ----
async function editVariable() {
  try {
    const r = await fetch(`/api/sources/${encodeURIComponent(props.source.id)}/variable`);
    const j = await r.json();
    const v = prompt('设置源变量（source.getVariable() 读取；聚合类源通常粘贴 JSON 配置）', j.value ?? '');
    if (v === null) return;
    await fetch(`/api/sources/${encodeURIComponent(props.source.id)}/variable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: v }),
    });
    saveMsg.value = '源变量已保存（对下一次搜索生效）';
  } catch (e) {
    saveMsg.value = '源变量保存失败：' + String(e);
  }
}

// ---- Cookie（源登录态；Legado CookieStore 的文本形式）----
/**
 * 工具栏「Cookie」按钮：读/写该源的 Cookie。
 *
 * 此前模板里 @click="editCookies" 指向了一个**不存在的函数**——按钮点下去毫无反应
 * （Vue 只在控制台警告 property was accessed but is not defined）。这里补齐实现。
 * 接受两种输入（都归一成 `k=v; k=v` 再提交，服务端就是按这个文本形式存的）：
 *   · 文本 `a=b; c=d`（从浏览器 DevTools 直接拷）
 *   · JSON 对象 `{"a":"b"}`（从「编辑此 Cookie」类插件导出）
 */
async function editCookies() {
  const id = encodeURIComponent(props.source.id);
  try {
    const cur = (await (await fetch(`/api/sources/${id}/cookies`)).json()) as { cookie?: string };
    const v = prompt(
      '设置该源的 Cookie（登录态）。\n· 可直接粘贴 "a=b; c=d" 文本\n· 也可粘贴 JSON 对象 {"a":"b"}\n· 清空该源 Cookie：把内容删光后点确定',
      cur.cookie ?? '',
    );
    if (v === null) return;
    let text = v.trim();
    if (text.startsWith('{')) {
      try {
        const o = JSON.parse(text) as Record<string, unknown>;
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('不是对象');
        text = Object.entries(o).map(([k, val]) => `${k}=${String(val)}`).join('; ');
      } catch {
        saveMsg.value = 'Cookie 不是合法 JSON 对象，已取消保存';
        return;
      }
    }
    const r = await fetch(`/api/sources/${id}/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookie: text }),
    });
    const j = (await r.json()) as { error?: string; cookie?: string };
    if (!r.ok) throw new Error(String(j.error ?? r.status));
    const n = (j.cookie ?? '').split(';').filter((x) => x.includes('=')).length;
    saveMsg.value = n ? `Cookie 已保存（${n} 条，对后续请求生效）` : 'Cookie 已清空';
  } catch (e) {
    saveMsg.value = 'Cookie 保存失败：' + String(e instanceof Error ? e.message : e);
  }
}

// ---- 登录（Legado `SourceLoginDialog`）：打开**与书院发现页同一个**登录界面 ----
/**
 * 该源是否有**登录相关规则**（决定标题栏「登录 / 登录信息」两个按钮是否出现）。
 *
 * ★ 判据用服务端下发的 `loginKind`（`/api/sources` 里由 `classifyLoginUrl(loginUrl, loginUi)` 算出），
 *   **不能只看 `loginUrl`**：`ui` 形态（`loginUi` 表单/按钮驱动）的源完全可能没有 `loginUrl`
 *   —— 那种源此前连按钮都不出现。
 *
 * ## 2026-09-29 用户实测 ②：点「登录」打不开登录界面
 * 旧实现自己写了一套简易流程（GET `/login` → 是 `js` 就 POST → 否则若无桌面桥就**只弹一句提示**），
 * 与书院发现页用的 `SourceLoginDialog`（表单 / 按钮行 / LoginUiV2 / 打开登录窗口 / 清除登录 /
 * 敏感字段掩码 …）**是两套东西**。结果就是用户看到的那句
 * 「该源用登录页登录（…），请在桌面端打开登录窗口」而**没有任何界面打开**。
 * ⇒ 现在直接复用同一个对话框组件，桌面端的 `window.yuedu.login` 桥也就不再需要了
 *   （对话框走 `/api/sources/:id/login/window`：真实 Chromium + 持久 profile + 可复用 + Cookie 抓取）。
 */
const loginable = computed(() => {
  const k = props.source.loginKind;
  if (k) return k !== 'none';
  return !!props.source.loginUrl; // 兜底：服务端没给 loginKind 时退回旧判据
});

const loginOpen = ref(false);
/** 打开对话框时是否**自动拉起登录窗口**（`url` / `config-url` 形态：用户要的就是「打开登录页」） */
const loginAutoWindow = ref(false);

async function openLogin(): Promise<void> {
  try {
    const id = encodeURIComponent(props.source.id);
    const plan = (await (await fetch(`/api/sources/${id}/login`)).json()) as { kind?: string };
    loginAutoWindow.value = plan.kind === 'url' || plan.kind === 'config-url';
  } catch {
    loginAutoWindow.value = false;
  }
  loginOpen.value = true;
}

// ---- 登录信息（账号/密码）：免浏览器登录脚本经 source.getLoginInfoMap() 读取 ----
async function editLoginInfo() {
  try {
    const id = encodeURIComponent(props.source.id);
    const cur = (await (await fetch(`/api/sources/${id}/login-info`)).json()) as { info?: Record<string, string> };
    const v = prompt(
      '填写该源的登录信息（JSON，键名须与源脚本一致，例：{"账号":"xxx","密码":"yyy"}）。\n脚本里用 source.getLoginInfoMap().get("账号") 读取。',
      JSON.stringify(cur.info ?? {}),
    );
    if (v === null) return;
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(v) as Record<string, string>;
    } catch {
      saveMsg.value = '登录信息必须是合法 JSON';
      return;
    }
    const r2 = await fetch(`/api/sources/${id}/login-info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ info: parsed }),
    });
    if (!r2.ok) throw new Error(String((await r2.json()).error ?? r2.status));
    saveMsg.value = '登录信息已保存（对下一次登录生效）';
  } catch (e) {
    saveMsg.value = '登录信息保存失败：' + String(e);
  }
}

// ---- 在线校验 ----
const verifying = ref(false);
const verifyMsg = ref('');
async function doVerify() {
  verifying.value = true;
  verifyMsg.value = '';
  try {
    // `#694` 不传 keyword：自动校验用源自己的 checkKeyWord（上游 getCheckKeyword 语义）
    const r = await verifySource(props.source.id);
    const stageText = Object.entries(r.stages)
      .map(([k, v]) => `${k}:${v?.ok ? '✓' : '✗' + (v?.error ?? '')}`)
      .join(' ');
    verifyMsg.value = `${r.ok ? '✅' : '❌'} ${r.message}（${r.respondTime}ms） ${stageText}`;
  } catch (e) {
    verifyMsg.value = '校验失败：' + String(e);
  } finally {
    verifying.value = false;
  }
}

defineExpose({ syncJsonToRaw });
</script>

<template>
  <div class="we card">
    <!-- 头：源标识 + 开关 -->
    <div class="we-head">
      <strong>编辑{{ isCms ? ' MacCMS 影视源' : isRss ? ' RSS 订阅源' : '书源' }}</strong>
      <span class="tag acc">{{ source.kind }}</span>
      <label class="we-toggle"><input type="checkbox" :checked="source.state.enabled" @change="toggleState('enabled', ($event.target as HTMLInputElement).checked)" /> 启用</label>
      <label class="we-toggle"><input type="checkbox" :checked="source.state.searchEnabled" @change="toggleState('searchEnabled', ($event.target as HTMLInputElement).checked)" /> 搜索</label>
      <label class="we-toggle"><input type="checkbox" :checked="source.state.exploreEnabled" @change="toggleState('exploreEnabled', ($event.target as HTMLInputElement).checked)" /> 发现</label>
      <span style="flex: 1"></span>
      <button class="btn mini" @click="editVariable">源变量</button>
      <button class="btn mini" @click="editCookies">Cookie</button>
      <button v-if="loginable" class="btn mini" @click="editLoginInfo">登录信息</button>
      <button v-if="loginable" class="btn mini" @click="openLogin">登录</button>
    </div>

    <!-- Tab 行 -->
    <div class="we-tabs">
      <button v-for="t in tabs" :key="t.id" class="we-tab" :class="{ on: tab === t.id }" @click="switchTab(t.id)">{{ t.name }}</button>
    </div>

    <!-- 编辑区 -->
    <div class="we-body" :class="{ 'we-body-fill': tab === 'json' }">
      <!--
        提示语**整页只留这一条**，放在 tab 内容最上方（2026-09-29 用户实测 ②-a）：
        此前每个字段下面都挂一条（`RuleFieldEditor` 的 `.rfe-tip`），一屏里重复七八遍；
        末尾还另有一条几乎同义的。现在合成一条、挪到顶。
      -->
      <div class="we-hint we-hint-top">
        所有字段均支持 JS 规则；双击编辑区进入增强编辑（语法高亮 / 补全 / 字号 / 快捷符号 / 格式化）。
      </div>
      <!--
        `#551` 试跑物料：给一条字段规则一份「页面」，才能单条试跑。
        `#556`：**按 tab 各自一份**；`JSON 源码` / `基本` 两个 tab 不提供（那里没有需要页面的规则）。
      -->
      <div v-if="probeAvailable" class="we-probe-src">
        <div class="we-probe-head">
          <button class="btn sm" @click="probeOpen = !probeOpen">{{ probeOpen ? '收起试跑物料' : '🧪 试跑物料' }}</button>
          <span class="we-probe-tip">本 tab 自己的页面（粘贴或从 URL 取），下面的字段就在它上面求值</span>
          <span style="flex: 1"></span>
          <span v-if="probeMsg" class="we-msg" :class="{ err: probeMsg.includes('失败') }">{{ probeMsg }}</span>
        </div>
        <div v-if="probeOpen" class="we-probe-body">
          <div class="we-probe-row">
            <input v-model="probeUrl" class="we-input" placeholder="页面 URL（留空则不绝对化相对链接）" />
            <button class="btn sm" :disabled="fetchingPage || renderingPage" @click="fetchProbePage">{{ fetchingPage ? '取页中…' : '取页' }}</button>
            <!-- `#556` 静态取不到目标结果时用这个：走引擎同一份渲染器取「JS 执行后的 DOM」 -->
            <button
              class="btn sm"
              :disabled="fetchingPage || renderingPage"
              :title="'走引擎同一条渲染通路取渲染后的 DOM（懒加载 / document.write / SPA 空壳都靠它）；慢，秒级~十秒级'"
              @click="fetchProbePageRendered"
            >{{ renderingPage ? '渲染中…' : '🖥 动态取页' }}</button>
            <button class="btn sm ghost" @click="probeContent = ''">清空</button>
          </div>
          <!-- `#558` 自动取物料：不填地址也能拿到本 tab 该看的那一页 -->
          <div v-if="materialTargetOf" class="we-probe-row">
            <button class="btn sm" :disabled="materialBusy" @click="autoMaterial">
              {{ materialBusy ? '自动取…' : `🔗 自动取${materialTargetOf === 'detail' ? '详情' : materialTargetOf === 'toc' ? '目录' : '正文'}页` }}
            </button>
            <span class="we-probe-tip">
              留空地址也行：{{
                materialTargetOf === 'detail'
                  ? '详情页 ← 发现首个分类首页 → 首个书籍地址（没有发现规则就自动搜一次）'
                  : materialTargetOf === 'toc'
                    ? '目录页 ← 详情页的「目录地址」，没写就共用详情页'
                    : '正文页 ← 目录里的首章地址'
              }}
            </span>
          </div>
          <textarea
            v-model="probeContent"
            class="we-input we-probe-area"
            rows="8"
            placeholder="粘贴 HTML / JSON（不入库，仅本次编辑会话可见）"
            title="可直接拖右下角调高；双击进入源码查看器（行号 / 高亮 / 查找 / 规则定位）"
            @dblclick="viewerOpen = true"
          ></textarea>
          <div class="we-probe-row">
            <button class="btn sm ghost" :disabled="!probeContent.trim()" @click="viewerOpen = true">
              🔍 源码查看器（行号 / 高亮 / 查找 / 规则定位）
            </button>
            <span class="we-probe-tip">双击上面的框也能打开</span>
          </div>
          <div class="we-probe-row">
            <!-- 用户粘贴的内容也能格式化（自动识别 html/json） -->
            <button class="btn sm ghost" :disabled="formatting || !probeContent.trim()" @click="formatNow">
              {{ formatting ? '格式化…' : '🧹 格式化' }}
            </button>
            <span class="we-probe-tip">自动识别 HTML / JSON：JSON 只重排缩进；HTML 只在块级标签前断行，`&lt;script&gt;`/`&lt;pre&gt;` 原样不动</span>
          </div>
          <!-- `#558` 自动取物料的链条：这一页到底是怎么来的（自动取错了靠这个才看得出来） -->
          <div v-if="materialInfo[tab]" class="we-probe-chain">
            <div class="we-probe-tip">
              这一页的来路（{{ materialInfo[tab].kind }}<template v-if="materialInfo[tab].keyword"> · 搜索 key={{ materialInfo[tab].keyword }}</template>）：
            </div>
            <div v-for="(s, i) in materialInfo[tab].chain" :key="`ms${i}`" class="we-probe-val">
              <span class="we-chain-step">{{ s.step }}</span> {{ s.detail }}
              <template v-if="s.rule"> · 规则 <code>{{ s.rule }}</code></template>
              <template v-if="s.value"> · 值 <code>{{ s.value }}</code></template>
              <template v-if="s.status"> · HTTP {{ s.status }}</template>
            </div>
            <div v-for="(e, i) in materialInfo[tab].errors" :key="`me${i}`" class="we-probe-hint">⚠️ {{ e }}</div>
          </div>
          <div class="we-probe-tip">
            物料 {{ probeContent.length }} 字符 · 静态取页拿的是「原始响应」（不执行 JS）；
            懒加载 / SPA 页面取不到内容时点「动态取页」
          </div>
          <div v-if="renderInfo" class="we-probe-tip">
            已用渲染层取页：{{ renderInfo.ms }}ms · {{ renderInfo.bytes }} 字节 · 可用层 {{ renderInfo.layers }}
          </div>
          <div v-for="(h, i) in renderInfo?.hints ?? []" :key="`ri${i}`" class="we-probe-hint">{{ h }}</div>
          <MaterialSourceViewer
            :open="viewerOpen"
            :text="probeContent"
            :source-id="props.source.id"
            :base-url="probeUrl"
            @update:open="viewerOpen = $event"
          />
        </div>
      </div>
      <template v-if="tab === 'json'">
        <!-- `#162`：JSON 源码 tab 单独走 JSON 语法（含折叠 + `jsonParseLinter`），
             不再拿 JS 语法去糊 JSON；`pos-key` 让它切 tab 回来时接着上次的光标。
             `#693` 加 `fill-h` + 外层 `.we-json` ⇒ 编辑区**撑满剩余高度**
             （旧实现是固定 26 行 ≈ 400px，下面空一大片）。 -->
        <div class="we-json">
          <CodeField v-model="jsonText" :rows="26" lang="json" pos-key="__json_src__" fill-h />
          <div v-if="jsonError" class="err-text" style="flex: none; margin-top: 6px">{{ jsonError }}</div>
        </div>
      </template>
      <template v-else-if="curTab">
        <div v-if="curTab.note" class="card empty">{{ curTab.note }}</div>
        <!-- `#653` 分类只生成一次：首次点开 tab 会生成并落本地，「刷新分类」才重拉 -->
        <div v-if="curTab.id === 'cms'" class="card" style="padding: 10px 12px; margin-bottom: 10px">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
            <b>分类（本地缓存）</b>
            <span class="we-probe-tip">{{ catsLoading ? '加载中…' : cats.length ? `${cats.length} 个` : '空' }}</span>
            <span style="flex: 1"></span>
            <button class="btn sm ghost" :disabled="catsLoading" @click="loadCats(false)">读本地</button>
            <button class="btn sm" :disabled="catsLoading" @click="loadCats(true)">{{ catsLoading ? '刷新中…' : '刷新分类' }}</button>
          </div>
          <div v-if="catsError" class="we-probe-hint" style="color: var(--red)">{{ catsError }}</div>
          <div v-if="cats.length" class="we-cats-list">
            <span v-for="c in cats" :key="c.typeId" class="we-cat-chip">{{ c.label }}<i>{{ c.typeId }}</i></span>
          </div>
          <div v-else-if="!catsLoading && !catsError" class="we-probe-tip">
            还没有缓存：点「刷新分类」让服务端生成一次（分类名 + 该分类的请求地址），之后打开就读本地。
          </div>
        </div>
        <div v-for="f in curTab.fields" :key="f.path" class="we-field">
          <label>
            {{ f.label }}
            <!-- `#550` 内联诊断：红/黄/蓝点（hover 出全部消息） -->
            <span
              v-if="severityOf(f.path)"
              class="we-dot"
              :class="severityOf(f.path)"
              :title="findingsFor(f.path).map((x) => `${x.ruleId}：${x.message}`).join('\n')"
            ></span>
            <span style="flex: 1"></span>
            <!--
              `#555` 按字段形态给不同动作（用户 2026-10-21：元数据字段不该有试跑；
              源 URL 该做连通测试；JS 要跑 JS；搜索地址要真搜一次）
            -->
            <template v-if="probeKindOf(f.path) !== 'none'">
              <input
                v-if="probeKindOf(f.path) === 'search'"
                v-model="searchKeyword"
                class="we-input we-kw"
                :placeholder="`关键词（留空 = 校验关键词 / 我的）`"
              />
              <!-- `#556` 发现页本身是懒加载/SPA 时，首个分类的页面要动态取 -->
              <label v-if="probeKindOf(f.path) === 'explore'" class="we-probe-tip" style="display: flex; align-items: center; gap: 3px; margin-right: 4px">
                <input v-model="exploreRender" type="checkbox" />首个分类动态取页
              </label>
              <button class="btn sm ghost we-probe-btn" :disabled="probing[f.path]" @click="runField(f)">
                {{ probing[f.path] ? '跑…' : probeLabel(probeKindOf(f.path)) }}
              </button>
            </template>
          </label>
          <!-- ⚠️ 不再传 `:rows`：高度已统一为「初始 2 行 / 最多 9 行」（见 FieldDef 的注释） -->
          <!-- `#162`：`pos-key` 用字段的 `path`（**不能用下标**：切 tab 后字段集合不同会串） -->
          <RuleFieldEditor v-model="field(f.path).value" :label="f.label" :pos-key="f.path" />
          <!-- `#555` 请求头：常见 UA 一键插入（PC / Android / iOS） -->
          <div v-if="f.path === 'header' || f.path === 'headers'" class="we-hdr-presets">
            <span class="we-probe-tip">常见请求头：</span>
            <button v-for="p in HEADER_PRESETS" :key="p.name" class="btn sm ghost" @click="insertHeaderPreset(f.path, p)">
              {{ p.name }}
            </button>
          </div>
          <!-- `#555` 连通测试结论（源 URL / 登录地址是纯网址时） -->
          <div v-if="reachResults[f.path]" class="we-probe-out" :class="{ bad: !reachResults[f.path].ok }">
            <div class="we-probe-line">
              {{ reachResults[f.path].ok ? '✅' : '❌' }} HTTP {{ reachResults[f.path].status || '—' }} ·
              {{ reachResults[f.path].bytes }} 字节 · {{ reachResults[f.path].ms }}ms
            </div>
            <div v-if="reachResults[f.path].title" class="we-probe-val">标题：{{ reachResults[f.path].title }}</div>
            <div class="we-probe-val">最终地址：{{ reachResults[f.path].finalUrl }}</div>
            <div v-if="reachResults[f.path].error" class="we-probe-hint">请求失败：{{ reachResults[f.path].error }}</div>
            <div v-for="(h, i) in reachResults[f.path].hints" :key="`r${i}`" class="we-probe-hint">{{ h }}</div>
          </div>
          <!-- `#555` 搜索试跑结论（关键词 / 每页状态 / 翻页是否真的生效） -->
          <div v-if="f.path === 'searchUrl' && searchResult" class="we-probe-out" :class="{ bad: !searchResult.ok }">
            <div class="we-probe-line">
              🔎 关键词「{{ searchResult.keyword }}」· {{ searchResult.method || 'GET' }} ·
              {{ searchResult.pageTemplate ? PAGE_TPL_ON : PAGE_TPL_OFF }}
              <template v-if="searchResult.pageTemplate">
                · 翻页：{{ searchResult.paging === 'advanced' ? '✅ 第 2 页内容不同' : searchResult.paging === 'same' ? '❌ 两页首项相同' : '无法判定' }}
              </template>
            </div>
            <div v-if="searchResult.message" class="we-probe-hint">{{ searchResult.message }}</div>
            <!-- `#557` 规则算出来的到底是什么：地址 / 方法 / 请求体都摊开 -->
            <div v-for="rv in searchResult.resolved ?? []" :key="`rv${rv.page}`" class="we-probe-val">
              第 {{ rv.page }} 页请求：<code>{{ rv.method }} {{ rv.url }}</code>
              <template v-if="rv.body"> · 体 <code>{{ rv.body }}</code></template>
              <template v-if="rv.charset"> · charset {{ rv.charset }}</template>
            </div>
            <div v-for="p in searchResult.pages" :key="`sp${p.page}`" class="we-probe-val">
              第 {{ p.page }} 页：HTTP {{ p.status || '—' }} · {{ p.bytes }} 字节
              <template v-if="p.via && p.via !== '静态'"> · 经{{ p.via }}取得</template>
              <template v-if="p.listCount !== null"> · 列表命中 {{ p.listCount }}</template>
              <template v-if="p.firstItem"> · 首项「{{ p.firstItem }}」</template>
              <template v-if="!p.material"> · 仅验返回（不作物料）</template>
            </div>
            <div v-for="(h, i) in searchResult.problems" :key="`spb${i}`" class="we-probe-hint">{{ h }}</div>
            <div v-if="searchResult.pages[0]?.html" class="we-probe-tip">
              第 1 页已作为试跑物料 ⇒ 下面「书籍列表 / 书籍名 / 作者…」可以直接逐条试跑
            </div>
          </div>
          <!--
            `#556` 发现试跑结论：exploreUrl 不是选择器，产出的是**分类表**。
            这里把「跑出几个分类 / 每个的 title→url / 语法问题 / 自动纠正」一次摊开。
          -->
          <div v-if="f.path === 'exploreUrl' && exploreResult" class="we-probe-out" :class="{ bad: !exploreResult.ok }">
            <div class="we-ex-head">
              <span class="we-ex-kind">
                {{ exploreResult.kind === 'js' ? '脚本(@js)' : exploreResult.kind === 'json' ? 'JSON / 对象数组' : '名称::URL 文本' }}
              </span>
              <span class="we-probe-line" style="margin: 0">
                {{ exploreResult.ok ? '✅' : '❌' }}
                分类 {{ exploreResult.kinds.length }} 个（可点 {{ exploreResult.clickable }}） · {{ exploreResult.ms }}ms
              </span>
            </div>
            <div v-if="exploreResult.error" class="we-probe-hint">{{ exploreResult.error }}</div>
            <!-- `#557` 分类地址里的 `{{page == 1 ? …}}` 要算出来，且**就地**给：首页 / 次页挨着分类名，
                 不再另起一块（另起一块会出现「上面是原文、下面才是结果」，看着还像没运算） -->
            <div v-if="exploreResult.kinds.length" class="we-probe-tip">{{ EXPLORE_PAGE_HINT }}</div>
            <div v-if="exploreResult.kinds.length" class="we-ex-list">
              <div v-for="(k, i) in exploreResult.kinds" :key="`ek${i}`" class="we-ex-item">
                <span class="t">{{ k.title || '(无 title)' }}</span>
                <template v-if="exploreComputedByKind[i]">
                  <span class="we-ex-addr">首页 <code>{{ exploreComputedByKind[i].page1 }}</code></span>
                  <span class="we-ex-addr">次页 <code>{{ exploreComputedByKind[i].page2 }}</code></span>
                  <span
                    v-if="exploreComputedByKind[i].raw !== exploreComputedByKind[i].page1"
                    class="we-ex-raw"
                    title="源里的原文（含未求值的表达式）"
                    >源规则 <code>{{ exploreComputedByKind[i].raw }}</code></span
                  >
                  <span v-for="(e, j) in exploreComputedByKind[i].errors" :key="`eke${j}`" class="we-probe-hint">{{ e }}</span>
                </template>
                <span v-else-if="k.url" class="u">{{ k.url }}</span>
                <span v-else class="h">{{ k.note || '不可点（无 url）' }}</span>
              </div>
            </div>
            <div v-for="(p, i) in exploreResult.problems" :key="`ep${i}`" class="we-probe-hint">
              {{ p.fixable ? '🛠' : '⚠️' }} {{ p.message }}
            </div>
            <div v-if="exploreResult.fixes?.length" class="we-ex-fix">
              <span class="we-probe-tip">
                可自动纠正：{{ exploreResult.fixes.map((x) => x.detail).join('；') }}
              </span>
              <button class="btn sm" @click="adoptExploreFix">🛠 自动纠正并复跑</button>
            </div>
            <div v-if="exploreResult.page" class="we-probe-val">
              首个分类第 1 页：HTTP {{ exploreResult.page.status || '—' }} · {{ exploreResult.page.bytes }} 字节
              <template v-if="exploreResult.page.rendered"> · 已渲染</template>
              <template v-if="exploreResult.page.title"> · 标题「{{ exploreResult.page.title }}」</template>
            </div>
            <!-- `#559` 页面 404 但列表规则自取数：这不是故障，页面本来就不需要能打开 -->
            <div v-if="exploreResult.pageNote" class="we-probe-hint">{{ exploreResult.pageNote }}</div>
            <div v-if="exploreResult.selfFetch" class="we-probe-val">
              列表规则自取数（`&lt;js&gt;` + java.ajax）已直接执行：
              {{ exploreResult.selfFetch.ok ? `✅ 命中 ${exploreResult.selfFetch.count} 项` : `❌ 失败${exploreResult.selfFetch.error ? '：' + exploreResult.selfFetch.error : ''}` }}
              · 规则 {{ exploreResult.selfFetch.rule }}…
            </div>
            <div v-for="(s, i) in exploreResult.selfFetch?.samples ?? []" :key="`sf${i}`" class="we-probe-val">{{ s }}</div>
            <div v-if="exploreResult.page?.html" class="we-probe-tip">
              这一页已作为本 tab 的试跑物料 ⇒ 下面「书籍列表 / 书籍名 / 作者…」就在它上面匹配
            </div>
          </div>
          <!--
            `#557` loginUi **规则校验**（用户 2026-10-21：预览只给代码 + 校验，不要再渲染一遍界面）。
            回答四件事：形态/行数 → 预期排版（按 flex 宽度算）→ 每行问题 → action 的函数是否定义。
          -->
          <div v-if="f.path === 'loginUi' && loginUiResult" class="we-probe-out" :class="{ bad: !loginUiResult.ok }">
            <div class="we-probe-line">
              🧾 {{ loginUiResult.kind === 'json' ? 'JSON 行数组' : loginUiResult.kind === 'script' ? '脚本生成' : loginUiResult.kind === 'v2' ? 'LoginUiV2 标记' : loginUiResult.kind === 'html' ? '旧 HTML 形态' : '空' }}
              · 行 {{ loginUiResult.rows.length }} · 预期排成 {{ loginUiResult.layout.length }} 行 · {{ loginUiResult.ok ? '✅ 可用' : '❌ 有问题' }}
            </div>
            <div v-if="loginUiResult.error" class="we-probe-hint">{{ loginUiResult.error }}</div>
            <!-- 预期排版：宽度按 style.layout_flexBasisPercent × 100，累加换行 -->
            <div v-if="loginUiResult.layout.length" class="we-lu-layout">
              <div v-for="ln in loginUiResult.layout" :key="`ln${ln.line}`" class="we-lu-line">
                <div v-for="(it, i) in ln.items" :key="`lnc${i}`" class="we-lu-cell" :style="{ flexBasis: `${it.widthPercent}%` }">
                  <span class="we-lu-cell-name">{{ it.name }}</span>
                  <span class="we-lu-cell-pct">{{ it.widthPercent }}%</span>
                </div>
              </div>
              <div class="we-probe-tip">↑ 这是按规则算出来的**预期**行排布（不是渲染结果）</div>
            </div>
            <!-- 行明细：type / action / 宽度 / 该行问题 -->
            <div v-for="r in loginUiResult.rows" :key="`lr${r.index}`" class="we-probe-val">
              第 {{ r.index + 1 }} 行「{{ r.name }}」· <code>{{ r.type }}</code>
              <template v-if="r.action"> · action <code>{{ r.action }}</code></template>
              <template v-else> · 无 action</template>
              · 宽 {{ r.widthPercent }}%
              <span v-if="r.problems.length" class="we-probe-why">{{ r.problems.join(' / ') }}</span>
            </div>
            <!-- 函数定义查得到吗（静态；不等于「跑得对」） -->
            <!-- `defined === undefined` 表示本源没有登录脚本 ⇒ **无法判断**，不能算「查不到」 -->
            <div v-if="loginUiResult.actions.length" class="we-probe-val">
              action 接线：{{ loginUiResult.actions.filter((a) => a.kind === 'fn' && a.defined).length }} 个函数查得到定义 ·
              {{ loginUiResult.actions.filter((a) => a.kind === 'fn' && a.defined === false).length }} 个查不到 ·
              <template v-if="loginUiResult.actions.some((a) => a.kind === 'fn' && a.defined === undefined)"
                >{{ loginUiResult.actions.filter((a) => a.kind === 'fn' && a.defined === undefined).length }} 个无法判断（本源没有登录脚本）· </template
              >
              {{ loginUiResult.actions.filter((a) => a.kind === 'url').length }} 个是直接打开页面
            </div>
            <div v-for="(p, i) in loginUiResult.problems" :key="`lp${i}`" class="we-probe-hint">
              {{ p.fixable ? '🛠' : p.row != null ? `⚠️ 第 ${p.row + 1} 行：` : '⚠️' }} {{ p.message }}
            </div>
            <div v-if="loginUiResult.fixes?.length" class="we-ex-fix">
              <span class="we-probe-tip">可自动纠正：{{ loginUiResult.fixes.map((x) => x.detail).join('；') }}</span>
              <button v-if="loginUiResult.fixed" class="btn sm" @click="adoptLoginUiFix">🛠 自动纠正并复跑</button>
            </div>
            <div v-for="(h, i) in loginUiResult.hints" :key="`lh${i}`" class="we-probe-hint">{{ h }}</div>
            <!-- 代码展示：看到的就是要改的那份字节（脚本形态给求值后的文本） -->
            <details class="we-lu-code" :open="!loginUiResult.ok">
              <summary>📄 规则原文{{ loginUiResult.evaluated ? '（脚本已求值）' : '' }}</summary>
              <pre class="we-lu-pre">{{ loginUiResult.evaluated || loginUiResult.raw }}</pre>
            </details>
          </div>
          <!-- `#557` bookUrlPattern：正则结果（匹配的是 URL 串，不是页面） -->
          <div v-if="f.path === 'bookUrlPattern' && regexOut" class="we-probe-out" :class="{ bad: !regexOut.ok }">
            <div class="we-probe-line">
              🧾 正则{{ regexOut.ok ? '✅ 命中' : regexOut.error ? '❌ 编译失败' : '❌ 未命中' }}
              <template v-if="regexOut.matches.length"> · {{ regexOut.matches.length }} 个样本</template>
            </div>
            <div class="we-probe-hint">
              用途：判断「一个书籍详情页 URL 是否属于本源」（Legado 的详情页 URL 正则）。本仓引擎当前<b>未消费</b>该字段 ⇒ 填错不影响搜索/详情/目录解析。
            </div>
            <div class="we-re-sample">
              <input v-model="regexSample" class="we-input" :placeholder="probeUrl || '样本 URL（可留空，用试跑物料的地址）'" />
              <button class="btn sm ghost" @click="runRegexTest">重测</button>
            </div>
            <div v-if="regexOut.error" class="we-probe-hint">编译失败：{{ regexOut.error }}（若用了 Java 专有语法如 `*+`、`\p{IsHan}`，浏览器与运行期可能都不认）</div>
            <div v-for="(m, i) in regexOut.matches" :key="`rg${i}`" class="we-probe-val">
              {{ m.hit ? '✅' : '❌' }} {{ m.url }}
              <div v-if="m.hit" class="we-probe-sample-idx">命中：<code>{{ m.whole }}</code><template v-if="m.groups.length"> · 分组 {{ m.groups.map((g) => g || '(空)').join(' | ') }}</template></div>
            </div>
          </div>
          <!-- `#551`：试跑结论（值 / 命中数 / 耗时 / 候选） -->
          <div v-if="probeResults[f.path]" class="we-probe-out" :class="{ bad: !probeResults[f.path].ok }">
            <div class="we-probe-line">{{ probeLine(probeResults[f.path]) }}</div>
            <!-- `#555` 作用域模式：逐项给值（行内字段的真实语义） -->
            <template v-if="probeResults[f.path].itemCount != null">
              <div v-if="probeNotes[f.path]" class="we-probe-hint">{{ probeNotes[f.path] }}</div>
              <div class="we-probe-val">
                列表 {{ probeResults[f.path].itemCount }} 项（在 <code>{{ probeResults[f.path].scopeRule }}</code> 内求值）
              </div>
              <div v-for="(v, i) in probeResults[f.path].values" :key="`pv${i}`" class="we-probe-val">
                第 {{ i + 1 }} 项：{{ v || '（空）' }}
              </div>
            </template>
            <!--
              `#556` 列表容器：给**命中元素本身**（逐行、完整 HTML），不是元素里的文字。
              用户 2026-10-21 的原始症状：拿「元素文本」当结果显示 ⇒ 一屏「书名已完结仙侠作者：…」糊在一起，
              完全没法照着写行内规则。元素 HTML 才是能对照的东西。
            -->
            <template v-else-if="probeResults[f.path].samples?.length">
              <div class="we-probe-val">
                命中 {{ probeResults[f.path].hitCount ?? probeResults[f.path].samples?.length ?? 0 }} 项 · 下面是前
                {{ probeResults[f.path].samples?.length ?? 0 }} 个元素的 HTML（可滚动）
              </div>
              <div v-for="(s, i) in probeResults[f.path].samples" :key="`ps${i}`">
                <div class="we-probe-sample-idx">#{{ i + 1 }}</div>
                <div class="we-probe-sample">{{ s }}</div>
              </div>
            </template>
            <div v-else-if="probeResults[f.path].ok && probeResults[f.path].value" class="we-probe-val">解出：{{ probeResults[f.path].value.slice(0, 300) }}</div>
            <div v-for="(h, i) in probeResults[f.path].hints ?? []" :key="`h${i}`" class="we-probe-hint">{{ h }}</div>
            <div v-if="probeResults[f.path].candidates?.length" class="we-probe-cands">
              <div class="we-probe-tip">0 命中 —— 下面是这份物料里能命中的写法：</div>
              <div v-for="(c, i) in probeResults[f.path].candidates" :key="i" class="we-probe-cand">
                <code>{{ c.selector }}</code>
                <span class="we-probe-hit">命中 {{ c.hitCount }}</span>
                <span class="we-probe-why">{{ c.why }}</span>
                <button class="btn sm" @click="adoptCandidate(f.path, c.selector)">采用</button>
              </div>
            </div>
          </div>
          <!-- `#550`：该字段的问题与一键修复 -->
          <div v-if="findingsFor(f.path).length" class="we-findings">
            <div v-for="(x, i) in findingsFor(f.path)" :key="i" class="we-finding" :class="x.severity">
              <span class="we-finding-msg">{{ x.ruleId }} · {{ x.message }}</span>
              <button v-if="x.fix" class="btn sm" @click="applyFix(x)">修复</button>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 动作条 -->
    <div class="we-actions">
      <button class="btn sm primary" :disabled="saving" @click="save">{{ saving ? (isDraft ? '创建中…' : '保存中…') : (isDraft ? '💾 创建源' : '💾 保存') }}</button>
      <button v-if="!isDraft" class="btn sm" @click="saveAsNew">另存为新源</button>
      <button class="btn sm" @click="exportSource">导出</button>
      <!--
        `#692` **移除「▶ 试跑」**：每个字段上都有自己的「试跑」（这才是写规则时要看的东西），
        底部这个按钮既不挑字段、也不带参数，点了没有可用信息 —— 没有存在价值。
      -->
      <button class="btn sm" @click="rollback">↩ 回滚</button>
      <span class="v-sep"></span>
      <button class="btn sm ghost" @click="copySource">拷贝源</button>
      <button class="btn sm ghost" @click="pasteSource">粘贴源</button>
      <!--
        `#692` **移除「✓ 全链校验」**：右栏「本源试跑」已经把全链做成两条链
        （搜索全链 / 发现全链，逐段回 ✓/✗ + 错误），这里再放一个固定关键词的校验按钮就是重复入口。
      -->
      <span style="flex: 1"></span>
      <!-- `#550` 源医生体检汇总 -->
      <span v-if="inspecting" class="we-msg">🩺 体检中…</span>
      <span
        v-else-if="inspectCounts.error || inspectCounts.warn || inspectCounts.info"
        class="we-msg"
        :class="{ err: inspectCounts.error > 0 }"
        title="源医生：规则 lint（与 pnpm check:lint 同一判据）"
      >
        🩺
        <template v-if="inspectCounts.error">{{ inspectCounts.error }} 错</template>
        <template v-if="inspectCounts.warn"> / {{ inspectCounts.warn }} 警</template>
        <template v-if="inspectCounts.info"> / {{ inspectCounts.info }} 提示</template>
      </span>
      <span v-if="saveMsg" class="we-msg" :class="{ err: saveMsg.includes('失败') }">{{ saveMsg }}</span>
      <span v-if="verifyMsg" class="we-msg" :class="{ err: verifyMsg.startsWith('❌') }">{{ verifyMsg }}</span>
    </div>

    <!--
      登录界面：**与书院发现页同一个组件**（2026-09-29 用户实测 ②）。
      此前工坊自己写了一套简易流程，`url` 形态的源点「登录」只会弹一句
      「请在桌面端打开登录窗口」——**没有任何界面打开**。
      `@changed` 转发 `saved`：登录会写 Cookie / 登录信息，父组件据此重取源列表
      （「已登录」状态、Cookie 条数才会跟着变）。
    -->
    <SourceLoginDialog
      v-if="loginOpen"
      :source-id="source.id"
      :source-name="source.name"
      :auto-window="loginAutoWindow"
      @close="loginOpen = false"
      @changed="emit('saved')"
    />
  </div>
</template>

<style scoped>
.we { display: flex; flex-direction: column; overflow: hidden; }
.we-head { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 14px; flex-wrap: wrap; }
.we-toggle { display: flex; gap: 3px; align-items: center; font-size: 12px; color: var(--muted); cursor: pointer; }
.we-tabs { display: flex; gap: 2px; padding: 8px 14px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.we-tab {
  background: none; color: var(--muted); padding: 6px 12px; font-size: 13px;
  border-radius: 8px 8px 0 0; border: none; border-bottom: 2px solid transparent; cursor: pointer;
  font-family: var(--font);
}
.we-tab.on { color: var(--text-0); border-bottom-color: var(--acc); background: var(--bg-2); }
.we-body { padding: 14px; overflow: auto; flex: 1; }
/**
 * `#693` JSON tab：body 不再自己滚（交由编辑器内部滚），改成**撑满的 flex 容器**
 * —— 否则编辑区高度由 `rows` 决定，下方留一大块空白。
 */
.we-body-fill { display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
.we-json { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.we-cats-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; max-height: 180px; overflow: auto; }
.we-cat-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
  background: var(--bg-2, rgba(0,0,0,.04)); border: 1px solid var(--line2); font-size: 12px;
}
.we-cat-chip i { font-style: normal; opacity: .55; font-size: 11px; }
.we-field { margin-bottom: 10px; }
/* `#551`：label 行改成 flex，试跑按钮靠右（诊断点在标题后） */
.we-field label { display: flex; align-items: center; gap: 0; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.we-probe-btn { padding: 1px 6px; font-size: 11px; line-height: 1.4; }
/* `#555` 搜索试跑的关键词输入（只挂在搜索地址那一行） */
.we-kw { width: 180px; padding: 1px 6px; font-size: 11px; height: 20px; }
/* `#555` 请求头预设按钮行 */
.we-hdr-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
/* `#555`/`#556` 列表元素片段（bookList / chapterList 的命中项）——
   用户要的是「逐行列出命中元素本身」，所以每条给一块可滚动的等宽区，不用 90px 掐死。 */
.we-probe-sample {
  font-family: var(--mono, monospace); font-size: 11px; color: var(--text-1);
  background: var(--bg-3); border-radius: 4px; padding: 4px 6px; margin-top: 4px;
  white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto;
}
.we-probe-sample-idx { font-size: 10px; color: var(--faint); margin-top: 4px; }
/* `#556` 发现试跑：分类表 / 语法纠正 */
.we-ex-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.we-ex-kind { font-size: 10.5px; color: var(--acc); background: var(--bg-1); border-radius: 4px; padding: 1px 5px; }
.we-ex-list { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow: auto; }
.we-ex-item { display: flex; gap: 6px; font-size: 11px; color: var(--muted); align-items: baseline; flex-wrap: wrap; }
.we-ex-item .t { color: var(--text-1); min-width: 88px; flex-shrink: 0; }
.we-ex-item .u { color: var(--acc); word-break: break-all; }
.we-ex-item .h { color: var(--faint); }
.we-ex-fix { margin-top: 5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* `#557` 发现试跑：就地给出运算后的首页/次页，源里的原文降为淡色补注 */
.we-ex-addr { font-size: 11px; color: var(--muted); word-break: break-all; }
.we-ex-raw { font-size: 10.5px; color: var(--faint); word-break: break-all; }
/* `#557` loginUi 规则校验：预期排版（按 flex 宽度画成格子）+ 代码展示 */
.we-lu-layout { margin: 6px 0; display: flex; flex-direction: column; gap: 3px; }
.we-lu-line { display: flex; gap: 3px; }
.we-lu-cell {
  flex-grow: 1; min-width: 0; display: flex; align-items: center; justify-content: space-between;
  gap: 4px; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--border);
  background: var(--bg-1); font-size: 11px; color: var(--text-1);
}
.we-lu-cell-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.we-lu-cell-pct { color: var(--faint); font-size: 10px; flex-shrink: 0; }
.we-lu-code { margin-top: 6px; }
.we-lu-code summary { font-size: 11px; color: var(--muted); cursor: pointer; }
.we-lu-pre {
  margin: 4px 0 0; padding: 6px 8px; max-height: 220px; overflow: auto; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-1); font-size: 11px; line-height: 1.5;
  color: var(--text-1); white-space: pre-wrap; word-break: break-all;
}
.we-re-sample { display: flex; gap: 6px; align-items: center; margin: 5px 0; }
/* `#551` 试跑物料区 */
.we-probe-src { margin: 0 0 12px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2); }
.we-probe-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
.we-probe-body { display: flex; flex-direction: column; gap: 6px; padding: 0 8px 8px; }
.we-probe-row { display: flex; gap: 6px; align-items: center; }
.we-input {
  flex: 1; min-width: 0; font-family: var(--font); font-size: 12px; color: var(--text-0);
  background: var(--bg-1); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px;
}
/* `#674` 用户实测「往下拖不动」：`resize: vertical` 本来就有，但高度被 `rows=5` + 父级
   裁切压死。这里给最小/最大高度，并把 overflow 显式设为 auto（部分浏览器只在非 visible 时出拖拽手柄）。 */
.we-probe-area {
  width: 100%;
  min-height: 120px;
  max-height: 72vh;
  resize: vertical;
  overflow: auto;
  font-size: 11.5px;
  line-height: 1.5;
}
.we-probe-tip { font-size: 11px; color: var(--faint); }
/* `#551` 试跑结论 */
.we-probe-out { margin-top: 4px; padding: 6px 8px; border-radius: 6px; background: var(--bg-2); border: 1px solid var(--border); }
.we-probe-out.bad { border-color: var(--red); }
.we-probe-line { font-size: 11.5px; color: var(--green); }
.we-probe-out.bad .we-probe-line { color: var(--red); }
.we-probe-val { margin-top: 3px; font-size: 11px; color: var(--muted); word-break: break-all; white-space: pre-wrap; max-height: 90px; overflow: auto; }
.we-probe-hint { margin-top: 3px; font-size: 11px; color: var(--orange); }
/* `#558` 物料取页链：每一步一行，步骤名做成小标签，扫一眼就能看出「卡在哪一步」 */
.we-probe-chain { margin-top: 6px; border-left: 2px solid var(--line); padding-left: 8px; }
.we-chain-step {
  display: inline-block; min-width: 62px; font-size: 10.5px; color: var(--acc);
  background: var(--bg-1); border-radius: 4px; padding: 0 5px; margin-right: 4px;
}
.we-probe-cands { margin-top: 5px; display: flex; flex-direction: column; gap: 3px; }
.we-probe-cand { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted); }
.we-probe-cand code { font-size: 11px; color: var(--acc); background: var(--bg-1); padding: 1px 5px; border-radius: 4px; }
.we-probe-hit { color: var(--green); }
.we-probe-why { color: var(--faint); flex: 1; }
.we-hint { font-size: 12px; color: var(--faint); margin-top: 4px; }
/* 顶部那条唯一提示（②-a）：贴住内容顶、与下面第一个字段拉开一点距离，别和 label 粘在一起 */
.we-hint-top {
  margin: 0 0 12px;
  padding: 7px 10px;
  border-radius: 7px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.5;
}
.we-actions {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 10px 14px; border-top: 1px solid var(--border);
}
.v-sep { width: 1px; height: 18px; background: var(--border-strong); }
.we-msg { font-size: 12px; color: var(--green); }
/* `#550` 内联诊断 */
.we-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-left: 6px; vertical-align: 1px; cursor: help; }
.we-dot.error { background: var(--red); }
.we-dot.warn { background: var(--orange); }
.we-dot.info { background: var(--acc); }
.we-findings { margin-top: 4px; display: flex; flex-direction: column; gap: 3px; }
.we-finding { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--muted); }
.we-finding.error .we-finding-msg { color: var(--red); }
.we-finding.warn .we-finding-msg { color: var(--orange); }
.we-finding.info .we-finding-msg { color: var(--acc); }
.we-msg.err { color: var(--red); }
</style>
