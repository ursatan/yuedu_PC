<script setup lang="ts">
/**
 * `#676` **物料源码查看器**（只读，规则定位用）。
 *
 * 用户要求（2026-10-29 晚，第二轮）：
 *  - **不要点遮罩关闭**，只走关闭按钮（误触关掉很烦）；
 *  - 源码区要**能格式化**（缩进后能看出层级）；
 *  - 定位规则输入框复用「源编辑各字段」那个编辑框（行号 / 双击进高级编辑 / 支持 JS）；
 *  - 匹配结果**显示全部**（滚动看），不要只给前 3 条；
 *  - 点结果要真的跳到源码对应位置（旧版按原文找、样本是压过空白的 ⇒ 永远找不到）；
 *  - 结果列表**下方再加一组**：规则框 + 匹配 + 结果（对选中的结果做**二次匹配**，
 *    类似「书籍列表 → 书名 / 作者 / 链接」）。
 *
 * 规则求值**不在前端做**：透传 `/api/doctor/selector-probe`（`#551` 那条），内部用引擎同一份
 * `AnalyzeRule` ⇒「这里命中几个」与「引擎实际取到几个」同口径。
 */
import { computed, nextTick, ref, watch } from 'vue';
import RuleFieldEditor from '../RuleFieldEditor.vue';

const props = defineProps<{
  open: boolean;
  /** 物料源码（HTML / JSON 文本） */
  text: string;
  /** 源 id（让服务端带上该源的 jsLib / 源函数） */
  sourceId?: string;
  /** 物料的 baseUrl（`@css:a@href` 之类绝对化要用） */
  baseUrl?: string;
}>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const MAX_LINES = 8000;

/**
 * `#681` 格式化语言：自动 / HTML / CSS / JS / JSON。
 *
 * 为什么要手动选：自动判定只认 html/json（一段普通文字也「像 JS」，猜错会把它按代码重排），
 * 而物料里确实可能有 CSS/JS 片段要看。显式选择才是可预期的。
 */
const formatKind = ref<'' | 'html' | 'css' | 'js' | 'json'>('');

/** 「格式化」只影响**显示**，不改物料本身（物料是源编辑的数据，不能被查看器悄悄改掉） */
const viewText = ref('');
watch(
  () => props.text,
  (v) => {
    viewText.value = String(v ?? '');
  },
  { immediate: true },
);

const rawLines = computed(() => viewText.value.split('\n'));
const truncated = computed(() => rawLines.value.length > MAX_LINES);
const lines = computed(() => (truncated.value ? rawLines.value.slice(0, MAX_LINES) : rawLines.value));
const charCount = computed(() => viewText.value.length);
const lineCount = computed(() => rawLines.value.length);

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function highlight(line: string): string {
  let s = esc(line);
  s = s.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="hv-c">$1</span>');
  s = s.replace(/(&lt;\/?)([a-zA-Z][\w:.-]*)/g, '$1<span class="hv-t">$2</span>');
  s = s.replace(/([\w:.-]+)=(&quot;[^&]*?&quot;)/g, '<span class="hv-a">$1</span>=<span class="hv-v">$2</span>');
  return s;
}

/* ---------------- 格式化（服务端同一个 formatter，不前端另造） ---------------- */
const formatting = ref(false);
const formatNote = ref('');
async function formatSource(): Promise<void> {
  if (!viewText.value.trim()) return;
  formatting.value = true;
  formatNote.value = '';
  try {
    const r = await fetch('/api/doctor/format', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: viewText.value,
        // 空串 = 自动判定（服务端 core `detectMaterialKind`：只判 html/json）
        ...(formatKind.value ? { kind: formatKind.value } : {}),
      }),
    });
    const j = (await r.json()) as { text?: string; kind?: string; changed?: boolean; note?: string };
    if (typeof j.text === 'string' && j.text) {
      viewText.value = j.text;
      // 服务端给了 note（原样返回的原因：解析不了 / 体积膨胀 / 全角清洗…）就照实显示，
      // 否则用户会觉得「点了没反应」。
      formatNote.value = j.note
        ? `${j.changed ? '已格式化' : '保持原样'}（${j.kind ?? ''}）：${j.note}`
        : j.changed ? `已格式化（${j.kind ?? ''}）` : '本来就是规整的，未改动';
    } else {
      formatNote.value = '格式化没有返回内容';
    }
  } catch (e) {
    formatNote.value = '格式化失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    formatting.value = false;
  }
}

/* ---------------- 查找（行级） ---------------- */
const query = ref('');
const hitRows = computed(() => {
  const q = query.value;
  if (!q) return [] as number[];
  const out: number[] = [];
  for (let i = 0; i < lines.value.length; i++) if (lines.value[i]!.includes(q)) out.push(i);
  return out;
});
const hitAt = ref(0);
const codeEl = ref<HTMLElement | null>(null);
/** `#677` 刚跳过去的那一行（闪一下，否则用户「看不出跳没跳」） */
const flashRow = ref(-1);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 滚到某一行并闪一下。
 *
 * 用 `getBoundingClientRect` 的相对位移算 `scrollTop`，不用 `scrollIntoView`——
 * 后者会把**所有祖先滚动容器**一起挪（浮层后面的页面跟着跑）。
 */
async function scrollToRow(row: number): Promise<void> {
  await nextTick();
  const box = codeEl.value;
  if (!box || row < 0) return;
  const el = box.querySelector<HTMLElement>(`[data-row="${row}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  box.scrollTop += r.top - br.top - box.clientHeight / 2 + r.height / 2;
  flashRow.value = row;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashRow.value = -1; }, 1500);
}
watch(hitRows, (v) => {
  hitAt.value = 0;
  if (v.length) void scrollToRow(v[0]!);
});
function nextHit(delta: number): void {
  const n = hitRows.value.length;
  if (!n) return;
  hitAt.value = (hitAt.value + delta + n) % n;
  void scrollToRow(hitRows.value[hitAt.value]!);
}

/* ---------------- 一级匹配 ---------------- */
const rule = ref('');
const busy = ref(false);
const errText = ref('');
const hitCount = ref<number | null>(null);
const samples = ref<string[]>([]);
/**
 * `#677` 每个命中元素的 **outerHTML**（与 `samples` 同序）。
 *
 * 值模式下 `samples` 是「取到的值」（`img@src` → `https://…jpg`），
 * 但**定位源码**与**二次匹配的物料**必须用元素 HTML —— 拿一个 URL 去二次匹配
 * 是什么都选不中的（用户实测：`img@src` 之后怎么都 0 命中）。
 */
const htmlSamples = ref<string[]>([]);
const candidates = ref<Array<{ selector: string; hitCount: number; why: string }>>([]);
const ms = ref(0);
/**
 * `#678` **命中但取值全空**时的解释（探针给的）。
 * 典型 `h3@a`：`@` 最后一段一律当属性名 ⇒ 引擎取到空，要文字得写 `@text`。
 * 不显示的话界面只有一片「（空值）」，看不出该改哪里。
 */
const ruleNote = ref('');
const locateMiss = ref(false);

type ProbeResp = {
  hitCount?: number;
  samples?: unknown;
  htmlSamples?: unknown;
  candidates?: unknown;
  ms?: number;
  error?: string;
  note?: string;
};

async function probeWith(selector: string, content: string): Promise<{
  hitCount: number | null;
  samples: string[];
  htmlSamples: string[];
  candidates: Array<{ selector: string; hitCount: number; why: string }>;
  ms: number;
  error: string;
  note: string;
}> {
  const r = await fetch('/api/doctor/selector-probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selector,
      content,
      ...(props.baseUrl ? { baseUrl: props.baseUrl } : {}),
      ...(props.sourceId ? { sourceId: props.sourceId } : {}),
      /**
       * `#677` 命中多少要多少（旧默认 3 条 220 字 ⇒ 用户看到「命中 10 项、列表只 3 项」），
       * 并且要**值模式**：`img@src` / `a@text` 这类取值规则回值，而不是元素 HTML。
       */
      valueMode: true,
      sampleLimit: 1000,
      sampleMax: 4000,
      maxCandidates: 12,
    }),
  });
  const j = (await r.json()) as ProbeResp;
  const arr = Array.isArray(j.samples) ? (j.samples as unknown[]) : [];
  const html = Array.isArray(j.htmlSamples) ? (j.htmlSamples as unknown[]) : [];
  const cands = Array.isArray(j.candidates) ? (j.candidates as unknown[]) : [];
  const toStr = (x: unknown): string => (x == null ? '' : String(x));
  return {
    hitCount: typeof j.hitCount === 'number' ? j.hitCount : null,
    // 值不再折叠空白（`src` / `text` 折叠后没意义，还会把多行文本挤成一行）
    samples: arr.map(toStr),
    htmlSamples: html.map((x) => toStr(x).replace(/\s+/g, ' ').trim()),
    candidates: cands
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        selector: String(c['selector'] ?? ''),
        hitCount: typeof c['hitCount'] === 'number' ? (c['hitCount'] as number) : 0,
        why: String(c['why'] ?? ''),
      })),
    ms: typeof j.ms === 'number' ? j.ms : 0,
    error: String(j.error ?? ''),
    note: String(j.note ?? ''),
  };
}

async function runRule(): Promise<void> {
  const sel = rule.value.trim();
  if (!sel) return;
  busy.value = true;
  errText.value = '';
  try {
    // 显示**全部**结果（结果区独立滚动）；sampleLimit 已放到 1000（每条 4000 字，够做二次匹配）
    const res = await probeWith(sel, viewText.value);
    hitCount.value = res.hitCount;
    samples.value = res.samples;
    htmlSamples.value = res.htmlSamples;
    candidates.value = res.candidates;
    ms.value = res.ms;
    errText.value = res.error;
    ruleNote.value = res.note;
    subPick.value = 0;
    subHits.value = [];
    subCount.value = null;
  } catch (e) {
    hitCount.value = null;
    samples.value = [];
    htmlSamples.value = [];
    candidates.value = [];
    ruleNote.value = '';
    errText.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * `#677` **定位索引**：把整篇压成两种形状（懒构建，按文本长度失效）。
 *
 * 为什么需要两种（用户实测「点结果，源码没跳转」）：
 *  · 探针回的样本是 **DOM 重排后**的 HTML：标签之间**没有空白**
 *    （`</a><div class="itemtxt">`），而源码里那个位置是**换行 + 缩进**；
 *  · 于是「整篇压空白后找子串」也找不到 —— 源码那边插进了一个空格，样本那边没有。
 * ⇒ 除了「松排」（空白折叠成一个空格），还要一份「紧排」：把 `>` 与 `<` 之间的空白**全部去掉**，
 * 并各自保留「字符下标 → 行号」映射，命中后用起始下标反查行号。
 *
 * 懒构建的原因：8000 行 × 每行几百字符，两份映射 ≈ 几十万个数字，打开浮层就建是白花的。
 */
let locCache: {
  key: string;
  tight: string;
  tightRows: number[];
  spaced: string;
  spacedRows: number[];
} | null = null;

function locator(): NonNullable<typeof locCache> {
  const key = `${lineCount.value}:${charCount.value}`;
  if (locCache && locCache.key === key) return locCache;
  const arr = lines.value;
  const spacedRows: number[] = [];
  let spaced = '';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) {
      spaced += ' ';
      spacedRows.push(i);
    }
    const n = arr[i]!.replace(/\s+/g, ' ').trim();
    spaced += n;
    for (let k = 0; k < n.length; k++) spacedRows.push(i);
  }
  let tight = '';
  const tightRows: number[] = [];
  for (let idx = 0; idx < spaced.length; idx++) {
    const ch = spaced[idx]!;
    if (ch === ' ') {
      let p = tight.length - 1;
      while (p >= 0 && tight[p] === ' ') p--;
      let q = idx + 1;
      while (q < spaced.length && spaced[q] === ' ') q++;
      // 只在「紧邻 `>` 与 `<` 之间」丢空白：这正是 DOM 序列化不吃的那部分
      if (tight[p] === '>' && spaced[q] === '<') continue;
    }
    tight += ch;
    tightRows.push(spacedRows[idx] ?? 0);
  }
  locCache = { key, tight, tightRows, spaced, spacedRows };
  return locCache;
}

/** 逐级缩短的前缀（样本被 `sampleMax` 截断时靠它兜底） */
function shrinkPrefixes(s: string): string[] {
  const out: string[] = [];
  for (const n of [1200, 600, 240, 120, 60, 32, 16]) {
    if (s.length > n) out.push(s.slice(0, n));
  }
  return out;
}

/**
 * `#677` 在源码里找一段（**跨行元素也要能命中**）。
 *
 * 顺序：① 紧排整段 → ② 紧排前缀 → ③ 松排整段 → ④ 松排前缀
 * → ⑤ 用 `src`/`href` 属性值定位（源码里的属性值几乎逐字不变）。
 */
function locateRow(needleRaw: string): number {
  const raw = String(needleRaw ?? '').trim();
  if (!raw) return -1;
  const loc = locator();
  const hitIn = (hay: string, rows: number[], needle: string): number => {
    if (!needle) return -1;
    const at = hay.indexOf(needle);
    return at < 0 ? -1 : (rows[at] ?? -1);
  };
  const tightNeedle = raw.replace(/>\s+</g, '><').replace(/\s+/g, ' ');
  for (const n of [tightNeedle, ...shrinkPrefixes(tightNeedle)]) {
    const row = hitIn(loc.tight, loc.tightRows, n);
    if (row >= 0) return row;
  }
  const spacedNeedle = raw.replace(/\s+/g, ' ');
  for (const n of [spacedNeedle, ...shrinkPrefixes(spacedNeedle)]) {
    const row = hitIn(loc.spaced, loc.spacedRows, n);
    if (row >= 0) return row;
  }
  const attr = /\b(?:src|href|data-src|poster|alt)="([^"]{8,})"/.exec(spacedNeedle)?.[1];
  return attr ? hitIn(loc.spaced, loc.spacedRows, attr) : -1;
}

/**
 * 点一条结果 ⇒ ①滚到源码对应位置 ②把它设为「二级匹配的物料」。
 *
 * 物料用 **元素 HTML**（`htmlSamples`）不是显示值：用户点的 `img@src` 那行是 URL，
 * 拿 URL 当物料做二次匹配必然 0 命中。
 */
async function pickResult(i: number): Promise<void> {
  subPick.value = i;
  subHits.value = [];
  subCount.value = null;
  const mat = htmlSamples.value[i] || samples.value[i] || '';
  const row = locateRow(mat);
  locateMiss.value = row < 0;
  if (row >= 0) await scrollToRow(row);
}

/* ---------------- 二级匹配（对选中的结果再匹配） ---------------- */
const subPick = ref(0);
const subRule = ref('');
const subBusy = ref(false);
const subHits = ref<string[]>([]);
const subCount = ref<number | null>(null);
const subErr = ref('');

/** 二级匹配的物料 = 选中那条的**元素 HTML**（不是显示值，见 `pickResult` 注释） */
const subBase = computed(() => htmlSamples.value[subPick.value] || samples.value[subPick.value] || '');

async function runSub(): Promise<void> {
  const sel = subRule.value.trim();
  if (!sel || !subBase.value) return;
  subBusy.value = true;
  subErr.value = '';
  try {
    const res = await probeWith(sel, subBase.value);
    subCount.value = res.hitCount;
    subHits.value = res.samples;
    subErr.value = res.error;
  } catch (e) {
    subCount.value = null;
    subHits.value = [];
    subErr.value = e instanceof Error ? e.message : String(e);
  } finally {
    subBusy.value = false;
  }
}

/** 点一条候选 ⇒ 填进规则框并立刻跑（0 命中时不用手抄规则） */
function useCandidate(sel: string): void {
  rule.value = sel;
  void runRule();
}

function close(): void {
  emit('update:open', false);
}
</script>

<template>
  <!-- `#676` **点遮罩不关闭**（用户要求）：只有右上角 ✕ 关，避免误触丢掉正在看的位置 -->
  <div v-if="open" class="msv-mask">
    <div class="msv-panel">
      <header class="msv-head">
        <strong>物料源码</strong>
        <span class="msv-meta">{{ lineCount }} 行 · {{ charCount }} 字符 · 只读</span>
        <!-- `#681` 语言选择：自动只判 html/json（猜 JS 会把普通文字按代码重排），其余靠显式选 -->
        <select v-model="formatKind" class="msv-kind" title="按哪种语言格式化（自动 = 只判 HTML / JSON）">
          <option value="">自动</option>
          <option value="html">HTML</option>
          <option value="css">CSS</option>
          <option value="js">JS</option>
          <option value="json">JSON</option>
        </select>
        <button class="msv-btn" :disabled="formatting || !viewText.trim()" title="用服务端同一个 formatter 重排（只影响显示，不改物料）" @click="formatSource">
          {{ formatting ? '格式化…' : '🧹 格式化' }}
        </button>
        <span v-if="formatNote" class="msv-meta">{{ formatNote }}</span>
        <span class="msv-grow" />
        <button class="msv-x" title="关闭" @click="close">✕</button>
      </header>

      <div class="msv-body">
        <!-- 左 2/3：源码 -->
        <section class="msv-left">
          <div class="msv-find">
            <input v-model="query" class="msv-input" placeholder="在源码里查找（回车跳下一个）" @keydown.enter.prevent="nextHit(1)" />
            <template v-if="query">
              <span class="msv-hit">{{ hitRows.length ? `${hitAt + 1}/${hitRows.length} 行` : '无匹配' }}</span>
              <button class="msv-btn" :disabled="!hitRows.length" @click="nextHit(-1)">↑</button>
              <button class="msv-btn" :disabled="!hitRows.length" @click="nextHit(1)">↓</button>
            </template>
          </div>
          <div ref="codeEl" class="msv-code">
              <div
                v-for="(ln, i) in lines"
                :key="i"
                :data-row="i"
                class="msv-line"
                :class="{ 'msv-line-hit': query && hitRows[hitAt] === i, 'msv-line-mark': query && ln.includes(query), 'msv-line-flash': flashRow === i }"
              >
              <span class="msv-ln">{{ i + 1 }}</span>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <span class="msv-tx" v-html="highlight(ln)" />
            </div>
            <div v-if="truncated" class="msv-trunc">已截断：只显示前 {{ MAX_LINES }} 行（共 {{ lineCount }} 行）</div>
          </div>
        </section>

        <!-- 右 1/3：一级规则 + 结果 + 二级规则 + 结果 -->
        <section class="msv-right">
          <div class="msv-rule">
            <RuleFieldEditor v-model="rule" :rows="3" pos-key="__material_rule__" placeholder="定位规则：.card / class.card@tag.a@href / //div（XPath） / @css:… / 正则 / $.data[*]" />
            <div class="msv-rule-row msv-rule-actions">
              <button class="msv-btn msv-primary" :disabled="busy || !rule.trim()" @click="runRule">
                {{ busy ? '匹配…' : '匹配' }}
              </button>
              <span class="msv-rule-stat">
                <template v-if="hitCount !== null">
                  命中 <b>{{ hitCount }}</b> 项<template v-if="ms"> · {{ ms }}ms</template>
                </template>
                <template v-else>未匹配</template>
              </span>
              <span v-if="errText" class="msv-err">{{ errText }}</span>
            </div>
            <!-- `#678` 命中但取值全空时的一句解释（例：`h3@a` 在引擎里取到空，要文字写 `h3@a@text`） -->
            <div v-if="ruleNote" class="msv-note">{{ ruleNote }}</div>
          </div>

          <div class="msv-hits">
            <div class="msv-hits-head">
              匹配结果<span v-if="samples.length">（{{ samples.length }} 条，滚轮查看；点一条 = 定位 + 设为下方二次匹配的物料）</span>
            </div>
            <div v-if="locateMiss" class="msv-err">这条结果在源码里没有连续出现（多为拼接/去标签后的文本）</div>
            <!-- `#677` 0 命中时的候选：点一条直接填进规则框并重跑（旧版把对象 stringify 成「[object Object]」） -->
            <div v-if="candidates.length" class="msv-cands">
              <div class="msv-cands-title">能命中的候选（点一条直接用）</div>
              <button v-for="(c, i) in candidates" :key="`c${i}`" class="msv-cand" :title="c.why" @click="useCandidate(c.selector)">
                <code>{{ c.selector }}</code>
                <span class="msv-cand-n">{{ c.hitCount }} 项</span>
              </button>
            </div>
            <div class="msv-hits-body">
              <div
                v-for="(s, i) in samples"
                :key="i"
                class="msv-sample"
                :class="{ 'msv-sample-on': subPick === i }"
                @click="pickResult(i)"
              >
                <span class="msv-sample-no">{{ i + 1 }}</span>
                <span class="msv-sample-tx">{{ s === '' ? '（空值）' : s }}</span>
              </div>
              <div v-if="!samples.length && !candidates.length" class="msv-empty">
                输入规则后点「匹配」—— 命中项会全部列在这里（列表规则命中成百上千时最多列 1000 条）
              </div>
            </div>
          </div>

          <!-- 二级匹配：对上面选中的那条结果再提字段（书籍列表 → 书名/作者/链接） -->
          <div class="msv-sub">
            <div class="msv-sub-head">
              二次匹配 <span class="msv-meta">物料 = 第 {{ subPick + 1 }} 条{{ subBase ? '' : '（先在上面点一条结果）' }}</span>
            </div>
            <RuleFieldEditor v-model="subRule" :rows="2" pos-key="__material_rule2__" placeholder="对上面那条结果再取：tag.a@href / class.name@text / $.title" />
            <div class="msv-rule-row msv-rule-actions">
              <button class="msv-btn msv-primary" :disabled="subBusy || !subRule.trim() || !subBase" @click="runSub">
                {{ subBusy ? '匹配…' : '匹配' }}
              </button>
              <span class="msv-rule-stat">
                <template v-if="subCount !== null">命中 <b>{{ subCount }}</b> 项</template>
                <template v-else>未匹配</template>
              </span>
              <span v-if="subErr" class="msv-err">{{ subErr }}</span>
            </div>
            <div class="msv-hits-body msv-sub-body">
              <div v-for="(s, i) in subHits" :key="`s${i}`" class="msv-sample">
                <span class="msv-sample-no">{{ i + 1 }}</span>
                <span class="msv-sample-tx">{{ s === '' ? '（空值）' : s }}</span>
              </div>
              <div v-if="!subHits.length" class="msv-empty">选中一条结果后填规则、点匹配 —— 这里列出它在**该条**内的命中</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msv-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 3200;
  display: flex;
  align-items: center;
  justify-content: center;
}
.msv-panel {
  width: 92vw;
  height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-1, #fff);
  color: var(--text-1, #222);
  border: 1px solid var(--border, #ccc);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.msv-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #ddd);
  background: var(--bg-2, #f6f6f6);
}
.msv-meta { font-size: 11.5px; color: var(--text-2, #666); }
/* `#681` 格式化语言选择（自动 / HTML / CSS / JS / JSON） */
.msv-kind {
  font-size: 11.5px;
  padding: 2px 4px;
  border: 1px solid var(--border, #ccc);
  border-radius: 5px;
  background: var(--bg-1, #fff);
  color: var(--text-1, #222);
}
.msv-grow { flex: 1; }
.msv-x {
  border: none;
  background: transparent;
  color: var(--text-2, #666);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
}
.msv-body { flex: 1; display: flex; gap: 10px; padding: 10px; min-height: 0; }
.msv-left { flex: 2; display: flex; flex-direction: column; min-width: 0; }
.msv-right { flex: 1; display: flex; flex-direction: column; min-width: 0; gap: 8px; overflow: hidden; }

.msv-find { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.msv-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border, #ccc);
  border-radius: 5px;
  background: var(--bg-1, #fff);
  color: var(--text-1, #222);
}
.msv-hit { font-size: 11.5px; color: var(--text-2, #666); white-space: nowrap; }
.msv-btn {
  padding: 3px 9px;
  font-size: 11.5px;
  border: 1px solid var(--border, #ccc);
  border-radius: 5px;
  background: var(--bg-2, #f4f4f4);
  color: var(--text-1, #222);
  cursor: pointer;
}
.msv-btn:disabled { opacity: 0.5; cursor: default; }
.msv-primary { background: var(--accent, #2b6cb0); border-color: var(--accent, #2b6cb0); color: #fff; }

.msv-code {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  background: var(--bg-2, #fafafa);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 1.65;
  padding: 6px 0;
}
.msv-line { display: flex; gap: 10px; padding: 0 10px 0 0; white-space: pre-wrap; word-break: break-all; }
.msv-line-mark { background: rgba(255, 214, 0, 0.18); }
.msv-line-hit { background: rgba(255, 170, 0, 0.4); }
/* `#677` 点结果跳过去的行闪一下（否则用户看不出到底跳没跳） */
.msv-line-flash { background: rgba(43, 108, 176, 0.28); transition: background 0.2s; }
.msv-ln {
  flex: 0 0 3.6em;
  text-align: right;
  color: var(--text-2, #999);
  user-select: none;
  padding-right: 6px;
  border-right: 1px solid var(--border, #e5e5e5);
}
.msv-tx { flex: 1; min-width: 0; color: var(--text-1, #222); }
.msv-trunc { padding: 8px 12px; font-size: 11.5px; color: #b45309; }

.msv-tx :deep(.hv-t) { color: #4a90d9; }
.msv-tx :deep(.hv-a) { color: #8a8f98; }
.msv-tx :deep(.hv-v) { color: #c07a3a; }
.msv-tx :deep(.hv-c) { color: #7a8a7a; font-style: italic; }

.msv-rule { border: 1px solid var(--border, #ddd); border-radius: 6px; padding: 8px; background: var(--bg-2, #fafafa); }
.msv-rule-row { display: flex; align-items: center; gap: 8px; }
.msv-rule-actions { margin-top: 6px; }
.msv-rule-stat { font-size: 12px; }
.msv-err { color: #c0392b; font-size: 11.5px; }
/* `#678` 取值全空时的解释（提示怎么改规则，不是报错） */
.msv-note {
  margin-top: 6px;
  padding: 5px 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-1, #333);
  background: rgba(255, 196, 0, 0.14);
  border-left: 2px solid #d9a600;
  border-radius: 4px;
}

.msv-hits { flex: 1; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--border, #ddd); border-radius: 6px; overflow: hidden; }
.msv-hits-head { padding: 6px 8px; font-size: 11.5px; color: var(--text-2, #666); background: var(--bg-2, #f6f6f6); border-bottom: 1px solid var(--border, #e5e5e5); }
.msv-hits-body { flex: 1; overflow: auto; min-height: 0; }
.msv-sample { display: flex; gap: 8px; padding: 5px 8px; border-bottom: 1px dashed var(--border, #eee); cursor: pointer; font-size: 11.5px; }
.msv-sample:hover { background: var(--bg-3, #f0f4ff); }
.msv-sample-on { background: var(--bg-3, #e8f0ff); box-shadow: inset 2px 0 0 var(--accent, #2b6cb0); }
.msv-sample-no { flex: 0 0 2.4em; color: var(--text-2, #999); text-align: right; }
.msv-sample-tx { flex: 1; min-width: 0; word-break: break-all; }
.msv-empty { padding: 12px; font-size: 11.5px; color: var(--text-2, #888); }

/* `#677` 0 命中时的候选条（可点，直接填规则并重跑） */
.msv-cands { padding: 6px 8px; border-bottom: 1px solid var(--border, #e5e5e5); background: var(--bg-2, #fafafa); }
.msv-cands-title { font-size: 11px; color: var(--text-2, #666); margin-bottom: 4px; }
.msv-cand {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 2px 4px; margin-bottom: 2px;
  border: 1px solid transparent; border-radius: 4px;
  background: transparent; color: var(--text-1, #222);
  cursor: pointer; text-align: left; font-size: 11.5px;
}
.msv-cand:hover { border-color: var(--border, #ccc); background: var(--bg-1, #fff); }
.msv-cand code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msv-cand-n { flex: 0 0 auto; color: var(--text-2, #666); }

.msv-sub { border: 1px solid var(--border, #ddd); border-radius: 6px; padding: 8px; background: var(--bg-2, #fafafa); display: flex; flex-direction: column; min-height: 0; }
.msv-sub-head { font-size: 11.5px; color: var(--text-1, #333); margin-bottom: 6px; }
.msv-sub-body { border: 1px solid var(--border, #e5e5e5); border-radius: 5px; margin-top: 6px; max-height: 30vh; }
</style>
