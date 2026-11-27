/**
 * 字典（用户 4-5）。
 *
 * ## 与 Legado 的对应关系
 * 实体照 `app/src/main/java/io/legado/app/data/entities/DictRule.kt` 逐条对齐：
 * ```kotlin
 * data class DictRule(
 *   @PrimaryKey var name: String = "",   // 名称即主键（同名即同一本）
 *   var urlRule: String = "",            // 取正文的 URL 规则（{{key}} 取词）
 *   var showRule: String = "",           // 在响应体上取展示内容的规则；空 = 直接用响应体
 *   var enabled: Boolean = true,
 *   var sortNumber: Int = 0
 * )
 * ```
 * 查词语义（`DictRule.search`）：`urlRule` → 响应体 → 若 `showRule` 非空则在其上求值，否则原样返回。
 * **执行在服务端**（`POST /api/dict/query` → `hub.dictLookup` → 引擎的规则求值器）——
 * 前端没有选择器/JS 规则引擎，把规则发给服务端跑，才与书源规则共用同一套实现（不漂移）。
 *
 * ## 为什么规则存在前端（localStorage）
 * 字典是纯客户端配置，且要「导入/新建/启停」即时生效；与书架分组同一策略。
 * ⏸ Phase 1.4（用户数据迁移）时再统一搬到 server 存储（见 `docs/移植路线图.md`）。
 *
 * ## 本地字典（离线包）
 * ⏸ **远期功能，先占位**：Legado 的本地字典是自定义词典文件的检索（支持 mdx/mdd 之类离线包，
 * 需要词库解析器与索引，属独立工程量）。当前 UI 只给出入口与说明，不做假实现。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { DictRule } from '@yuedu/core/contract';
import {
  deleteDictRule as deleteRemote,
  listDictRules as listRemote,
  putDictRule as putRemote,
} from '../user-data';
import {
  type SyncPlan,
  type SyncSource,
  pull as pullEntity,
  readLocal,
  reconcile as reconcileEntity,
  registerSyncTarget,
  writeLocal,
} from '../utils/server-sync';
import { dictOrigin } from '../utils/dict-html';
import { parseDictRulesJson } from '../utils/dict-transfer';

/** 契约里的字典规则（`#189` 起上服务端；类型转出以保持 `DictView` 的既有 import） */
export type { DictRule };

/**
 * 单条字典的查询状态。
 *
 * `idle` 是关键（用户 2026-09-28 要求）：阅读浮层的字典窗按 **tab 逐个查** ——
 * 打开时**一条请求都不发**，点哪个 tab 才查哪个（`idle` ⇒ 点它才查；`loading`/`done` ⇒ 直接复用）。
 * 这样点开字典不会一次打出 N 个请求（既慢又可能被字典站限流）。
 */
export interface DictResult {
  name: string;
  text: string;
  err: string;
  ms: number;
  state: 'idle' | 'loading' | 'done';
  /**
   * 该字典的**站点 origin**（从 `urlRule` 解析）。
   * 渲染前处理要用它把结果 HTML 里的**相对地址**补全（汉典的图片是 `/images/…`，
   * 不补全就会打到我们自己的服务 ⇒ 404 ⇒ 「图片不显示」），并作为代理的 Referer（防盗链）。
   */
  base: string;
}

/**
 * 内置预设：**取自 Legado 官方默认字典**（`app/src/main/assets/defaultData/dictRules.json`），
 * 优先选**不依赖 Android 专有 API** 的三条（其余两条用了 `data:;base64` 信封 + JsonPath JavaImporter，
 * 依赖较重，留给用户按需导入 —— 不假装它们一定可用）。
 */
export const BUILTIN_DICT_RULES: DictRule[] = [
  {
    name: '海词英文',
    urlRule: 'https://apii.dict.cn/mini.php?q={{key}}',
    showRule: 'tag.body@all',
    enabled: true,
    sortNumber: 1,
  },
  {
    name: '海词中文',
    urlRule: 'https://hanyu.dict.cn/{{key}}',
    showRule:
      '@js:var jsoup = org.jsoup.Jsoup.parse(result)\n' +
      'jsoup.select("script,#header,#footer,#page-share,.mslide,.title,#dictHcBtn,#dictHcBtnTop,#dictHc,#dictHcSettingArea,#dictHcClosetip").remove()\n' +
      'jsoup.select("#cy").html()',
    enabled: true,
    sortNumber: 0,
  },
  {
    name: '有道',
    urlRule: 'https://m.youdao.com/translate,{\n"method": "POST",\n"headers": {\n    "User-Agent": "{{java.getWebViewUA()}}"\n  },\n"body": "inputtext={{key}}&type=AUTO"\n}',
    showRule:
      "@js:\nlet j = org.jsoup.Jsoup.parse(result);\nlet yw = j.select('#inputText').text();\nlet fy = j.select('#translateResult').text();\nresult = '原文：<br>'+yw+'<br>翻译：<br>'+fy;",
    enabled: true,
    sortNumber: 2,
  },
];

const KEY = 'yuedu-dict-rules';
const PENDING_KEY = 'yuedu-dict-rules-pending';

function load(): DictRule[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return BUILTIN_DICT_RULES.map((r) => ({ ...r }));
    const arr = JSON.parse(raw) as DictRule[];
    return Array.isArray(arr) ? arr.filter((r) => r && typeof r.name === 'string') : [];
  } catch {
    return BUILTIN_DICT_RULES.map((r) => ({ ...r }));
  }
}

export const useDictStore = defineStore('dict', () => {
  const rules = ref<DictRule[]>(load());

  /**
   * `#189` 同步方案（照 `stores/replaceRules.ts`）：**本地缓存 + 推服务端**。
   * 为什么必须上服务端：此前只存 localStorage，而 `localhost:5173`（vite dev）与
   * `127.0.0.1:3000` 是**两个 origin** ⇒ 各存各的，用户看到「一边有一边没有」。
   * 写盘顺序与别处一致：先本地（服务端没起也能用）再推服务端，失败留 pending 重传。
   */
  const PLAN: SyncPlan<DictRule> = {
    localKey: KEY,
    pendingKey: PENDING_KEY,
    list: async () => (await listRemote()) as DictRule[],
    put: (r) => putRemote(r),
    remove: (id) => deleteRemote(id),
    toRemote: (r) => ({ ...r }) as unknown as Record<string, unknown>,
    idOf: (r) => String(r.name),
  };

  registerSyncTarget({
    localKey: KEY,
    pendingKey: PENDING_KEY,
    label: '字典规则',
    resync: () => reconcileEntity(PLAN, rules.value),
  });

  function save(): void {
    writeLocal(KEY, rules.value);
    void reconcileEntity(PLAN, rules.value)
      .then((r) => {
        if (r.offline) {
          console.warn('[dict] 已存本地，服务端不可达 ⇒ 标记 pendingSync，下次启动重传');
        }
      })
      .catch((e) => console.warn('[dict] 推送服务端失败（本地已保存，数据未丢）：', e));
  }

  /**
   * 启动时与服务端对齐。★ `#189` 修补（用户实测丢「汉典」）——三条规则：
   *
   * ① **「纯内置」不算用户数据**：本地恰好等于内置全集时视作空（`effectiveLocal=[]`）。
   *    否则另一端首开（本地只有 3 条内置兜底）会把内置当「本地数据」搬迁上服务端，
   *    把真有数据的端**覆盖掉**（实测：5173 首开推了 3 条内置 ⇒ 3000 的 4 条被服务端为准覆盖 ⇒ 汉典丢）。
   * ② **合并而不是二选一**：服务端非空时 = 服务端条目 + **本地独有条目**（按主键 `name`），
   *    本地独有的立即推上去。只看服务端的话，「A 端新增还没同步、B 端先 hydrate」这类
   *    时间差会把 A 的新数据静默清掉。
   * ③ 两端都空 ⇒ 播种内置并推服务端（否则新设备永远拿不到内置字典）。
   *
   * 删除语义不变：显式 `removeRule` 才删（合并只加不删 ⇒ 已删条目两端都不在 ⇒ 不会复活）。
   */
  async function hydrate(): Promise<SyncSource> {
    const local = rules.value;
    const isBuiltinOnly =
      local.length === BUILTIN_DICT_RULES.length &&
      local.every((r) => BUILTIN_DICT_RULES.some((b) => b.name === r.name));
    const effectiveLocal = isBuiltinOnly ? [] : local;
    // `#191`：合并语义已上收到 `server-sync.pull`（`{ mergeLocal: true }`）⇒ 这里只保留
    // 「纯内置视作无用户数据」这一条字典特有的口径（内置兜底不能当用户数据污染服务端）
    const r = await pullEntity(PLAN, effectiveLocal, { mergeLocal: true });
    if (!r.items) return r.source; // 离线：保持本地不动（pull 已清快照防静默丢推）
    if (r.items.length) {
      rules.value = r.items;
      writeLocal(KEY, rules.value);
    } else {
      // 两端都空 ⇒ 播种内置（并推服务端，否则换设备拿不到）
      rules.value = BUILTIN_DICT_RULES.map((x) => ({ ...x }));
      writeLocal(KEY, rules.value);
      save();
    }
    return r.source;
  }
  /** 查词词条 */
  const word = ref('');
  /** 查词结果：顺序 = `enabledRules`；每条带自己的 `state`（tab 模式下「点哪个查哪个」） */
  const results = ref<DictResult[]>([]);
  /** 任何一条还在查 ⇒ true（UI 用它禁用按钮/显示「查询中…」） */
  const querying = computed(() => results.value.some((r) => r.state === 'loading'));
  /** 阅读浮层当前选中的字典 tab（字典名） */
  const activeName = ref('');
  /** 查词浮层开关（阅读界面选中文字 →「字典」） */
  const lookupOpen = ref(false);

  const rulesSorted = computed(() => rules.value.slice().sort((a, b) => a.sortNumber - b.sortNumber));
  const enabledRules = computed(() => rulesSorted.value.filter((r) => r.enabled));

  /** 新建 / 覆盖同名规则（`name` 是主键，与 Legado 一致） */
  function upsertRule(rule: DictRule): void {
    const i = rules.value.findIndex((r) => r.name === rule.name);
    if (i >= 0) rules.value[i] = { ...rule };
    else rules.value = [...rules.value, { ...rule }];
    save();
  }
  function removeRule(name: string): void {
    rules.value = rules.value.filter((r) => r.name !== name);
    save();
  }
  function toggleRule(name: string, enabled: boolean): void {
    const r = rules.value.find((x) => x.name === name);
    if (r) { r.enabled = enabled; save(); }
  }
  /**
   * 上移 / 下移一格。
   *
   * ★★ 用户 2026-09-28 报「新导入的汉典无法排序，而内置三条可以」：真因不是权限或按钮坏了，而是
   * **`sortNumber` 撞号**——旧实现是「把相邻两条的 `sortNumber` 对调」，若两者值相同（导入的规则常带
   * `sortNumber: 0`，与内置「海词中文」的 0 撞上），交换两个相同的值等于**没动**。
   *
   * 现改为：按**当前显示顺序**交换位置后，把整列**重新编号为 0,1,2…** ——
   * 撞号 / 跳号 / 负数都被规范化，任何一条（含新导入的）都能移动，内置三条也不再钉死在原位。
   */
  function moveRule(name: string, delta: number): void {
    const list = rulesSorted.value; // 当前显示顺序（元素与 rules 里同一批对象引用）
    const i = list.findIndex((r) => r.name === name);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const order = list.map((r) => r.name);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
    order.forEach((n, k) => {
      const rule = rules.value.find((r) => r.name === n);
      if (rule) rule.sortNumber = k;
    });
    save();
  }
  /** 下一个可用的排序号 = 现有最大值 + 1（保证**不撞号**；撞号正是「无法排序」的根因） */
  function nextSort(): number {
    return rules.value.reduce((m, r) => Math.max(m, r.sortNumber), -1) + 1;
  }
  /** 导入：接受 `[{name,urlRule,showRule,enabled,sortNumber}, …]`（Legado 导出的字典规则就是这个形状） */
  function importRules(json: string, dedupe: 'skip' | 'overwrite' = 'overwrite'): { added: number; skipped: number; err: string } {
    // ★ `#267`：解析/判重走 `utils/dict-transfer.ts` 的纯函数（与导入预览同一份实现）。
    //   默认 dedupe='overwrite' = 旧行为（同名覆盖）。
    const p = parseDictRulesJson(json);
    if (p.errors.length && !p.rules.length) {
      return { added: 0, skipped: 0, err: p.errors.map((x) => x.reason).join('；') };
    }
    const seen = new Set<string>();
    let added = 0;
    let skipped = 0;
    for (const r of p.rules) {
      const exist = rules.value.find((x) => x.name === r.name);
      if (exist && dedupe === 'skip') { skipped += 1; continue; }
      if (seen.has(r.name)) { skipped += 1; continue; } // 批内同名：第一份已落，其余跳过
      seen.add(r.name);
      upsertRule({
        ...r,
        // ★ 不沿用导入 JSON 里的 sortNumber：Legado 导出的常是 0/1/2，会和内置三条撞号 ⇒ 顺序乱、↑↓ 失效。
        //   新来的追加到末尾；覆盖同名规则时**保留它现在的位置**（别把用户排好的顺序打乱）。
        sortNumber: exist ? exist.sortNumber : nextSort(),
      });
      added += 1;
    }
    return { added, skipped, err: added ? '' : '没有可导入的规则（需要 name + urlRule）' };
  }
  function exportRules(): string {
    return JSON.stringify(rules.value, null, 2);
  }
  function restoreBuiltin(): void {
    // 补齐缺失的内置规则时也走「追加到末尾」⇒ 不会与现有规则撞号
    for (const r of BUILTIN_DICT_RULES) if (!rules.value.some((x) => x.name === r.name)) upsertRule({ ...r, sortNumber: nextSort() });
  }

  /**
   * 打开查词浮层：**只准备 tab 列表，一条请求都不发**（用户 2026-09-28 要求「点一个查一个」）。
   * 真正发请求由 {@link lookupOne} / {@link openTab} 触发。
   */
  function prepareLookup(w: string): void {
    const text = String(w ?? '').trim();
    if (!text) return;
    word.value = text;
    lookupOpen.value = true;
    const targets = enabledRules.value;
    results.value = targets.map((r) => ({ name: r.name, text: '', err: '', ms: 0, state: 'idle' as const, base: dictOrigin(r.urlRule) }));
    activeName.value = targets[0]?.name ?? '';
  }

  /** 内部：真发一次请求（`POST /api/dict/query` → 服务端跑规则），并把结果写回该条 */
  async function runOne(cur: DictResult, rule: DictRule): Promise<void> {
    cur.state = 'loading';
    cur.text = '';
    cur.err = '';
    cur.base = dictOrigin(rule.urlRule); // 渲染前处理要用（相对地址补全 + 代理 Referer）
    const t0 = Date.now();
    let text2 = '';
    let err = '';
    try {
      const res = await fetch('/api/dict/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word: word.value, urlRule: rule.urlRule, showRule: rule.showRule }),
      });
      const j = (await res.json()) as { text?: string; error?: string; message?: string };
      if (j.error) err = j.message ? `${j.error}：${j.message}` : j.error;
      else text2 = String(j.text ?? '');
    } catch (e) {
      err = String(e instanceof Error ? e.message : e);
    }
    cur.text = text2;
    cur.err = err || (text2 ? '' : '（没有任何内容）');
    cur.ms = Date.now() - t0;
    cur.state = 'done';
  }

  /**
   * 查**一个**字典（tab 模式）。
   * ⚠️ 已查过的（`done`）直接复用缓存、**不重复发请求**；要重查传 `force: true`。
   */
  async function lookupOne(name: string, force = false): Promise<void> {
    const cur = results.value.find((x) => x.name === name);
    if (!cur) return;
    if (!force && cur.state !== 'idle') return;
    const rule = enabledRules.value.find((r) => r.name === name);
    if (!rule) { cur.state = 'done'; cur.err = '该字典已被停用，请重新打开查词窗'; return; }
    await runOne(cur, rule);
  }

  /** 点 tab：选中它 + 没查过就查（已查过只是切过去看结果） */
  function openTab(name: string): void {
    if (!results.value.some((x) => x.name === name)) return;
    activeName.value = name;
    void lookupOne(name);
  }

  /**
   * 查词：**一次问所有启用的字典**（并发）。
   * 用途是「工具 → 字典」的**试查**（一次性对比各字典的输出）；
   * 阅读浮层的字典窗走 {@link prepareLookup} + {@link openTab}（点一个查一个）。
   */
  async function lookup(w: string): Promise<void> {
    prepareLookup(w);
    const targets = enabledRules.value;
    await Promise.all(results.value.map((cur) => {
      const rule = targets.find((r) => r.name === cur.name);
      return rule ? runOne(cur, rule) : Promise.resolve();
    }));
  }

  return {
    hydrate,
    rules, rulesSorted, enabledRules, word, querying, results, lookupOpen, activeName,
    save, upsertRule, removeRule, toggleRule, moveRule, importRules, exportRules, restoreBuiltin,
    prepareLookup, lookupOne, openTab, lookup,
  };
});
