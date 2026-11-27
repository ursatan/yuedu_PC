<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSourcesStore } from '../stores/sources';
import SourcePinButton from '../components/SourcePinButton.vue';
import SourceGroupFilter from '../components/SourceGroupFilter.vue';
// `#280` 引擎/类型筛选统一组件（弹层样式与 SourceGroupFilter 一致）
import FilterDropdown from '../components/FilterDropdown.vue';
import RestoreRemovedDialog from '../components/RestoreRemovedDialog.vue';
import SourceSearchDialog from '../components/SourceSearchDialog.vue';
import SourceLoginDialog from '../components/SourceLoginDialog.vue';
// `#359` 源变量（`source.getVariable()`）：聚合源的 `Get('url')` 靠它，服务端早有端点、缺界面
import SourceVariableDialog from '../components/SourceVariableDialog.vue';
import {
  setSourceState, verifySource, type SourceInfo, type ValidateSummary,
  // `B6` 书源体检：启动/轮询/中止（逐条落结果，中止保留已完成条目）
  startHealthCheck as apiStartHealthCheck, getHealthJob, cancelHealthJob, type HealthJob,
  // `B21` 源订阅：地址簿 + 用订阅 URL 打开「导入源」强制预览
  getSourceSubscriptions, putSourceSubscriptions, type SourceSubscription,
} from '../api';
import ImportSourcesDialog from '../components/ImportSourcesDialog.vue';
import SourceSubscriptionsDialog from '../components/SourceSubscriptionsDialog.vue';
// `#208` ⑤ UI 集成：分享口令（源 → 口令）与口令导入（口令 → 源）
import SharePassphraseDialog from '../components/SharePassphraseDialog.vue';
import PassphraseImportDialog from '../components/PassphraseImportDialog.vue';
// `#280` 筛选框占位文案（名称/URL/注释/分组，四处同一句）
import { SOURCE_QUERY_PLACEHOLDER } from '../utils/source-query';
// `#560` 「这个服务实例读的是哪」的判据来源（`/api/diag` 的 `paths`）
import { getDiag } from '../ops-api';
/**
 * `#310` 门控判据**唯一实现**（源管理页 / 发现页 / 聚合搜索 / 换源搜索共用，见 `utils/source-gate.ts`）。
 * 本页用到四个：
 *  · `canSearch` / `canExplore` —— **能力门**（源里有没有这条规则，服务端算的事实）；
 *  · `searchSwitchEnabled` / `exploreSwitchEnabled` —— 滑块**能不能点**
 *    （能力门 + 源已启用；用户口径：「禁用 ⇒ 发现、搜索都不可用，且不可更改设置」）。
 */
import {
  canSearch, canExplore, searchSwitchEnabled, exploreSwitchEnabled, hasExploreSwitch,
} from '../utils/source-gate';

const router = useRouter();
const route = useRoute();
const st = useSourcesStore();

/**
 * `#283` 行内「更多」操作菜单：保留 置顶/编辑 常驻，登录（仅配了登录的源）/置底/检验/删除
 * 收进 ⋯ 菜单。`opsMenuFor` = 当前展开菜单的源 id（空串 = 全收起，一次只开一个）。
 */
const opsMenuFor = ref('');
/**
 * `#701` 「更多操作」菜单改成 **`position: fixed` + 由 JS 按按钮矩形定位**。
 *
 * 原来的写法是 `position: absolute; right: 8px; top: calc(100% - 4px)`，两个真问题
 * （用户 2026-11-01 实测）：
 *  ① **靠底部的行**：菜单只有一个方向（往下），最后几行弹出后直接落到列表卡片/视口之外
 *     —— `.sm-list` 是 `overflow: auto` 的滚动盒，绝对定位子元素**会被它裁掉**，看着就是「被遮挡」；
 *  ② **最后 2~3 行**：绝对定位的菜单算进滚动盒的 `scrollHeight` ⇒ 列表能被它撑高
 *     （滚动条突然变长、滚到底下面多出一块空白）。
 * `fixed` 一次性解决两条：不参与滚动盒布局、也不受 `overflow` 裁剪。
 * 方向仍然按空间自动翻：下面放不下且上面更宽裕 ⇒ 往上弹。
 */
/**
 * ⚠️ 不用 `ref` 拿菜单节点：它写在 `v-for` 里，Vue 的 string ref 在 `v-for` 中会收集成**数组**
 * （`opsMenuEl.value` 变数组 ⇒ `offsetHeight` 是 undefined ⇒ 位置算成 NaN）。
 * 菜单按构造同时只有一个（`opsMenuFor` 单值 + `v-if`），直接按类名取即可。
 */
function opsMenuNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.src-ops-menu');
}
/** 当前菜单的锚点（那个 ⋯ 按钮）—— 列表滚动/resize 时据此重算位置 */
let opsAnchorEl: HTMLElement | null = null;
const opsMenuStyle = ref<Record<string, string>>({ top: '0px', left: '0px', visibility: 'hidden' });
/** 视口留白（菜单不能贴边） */
const OPS_MARGIN = 8;
/** 菜单与按钮之间的缝隙 */
const OPS_GAP = 4;

/**
 * 按锚点矩形摆放菜单。**必须在菜单渲染后调用**（要量 `offsetHeight` 才知道放不放得下）。
 * 上下都不够时（小窗口）不再硬塞，而是给 `maxHeight` + 内部滚动 —— 宁可滚菜单，不能溢出。
 */
function placeOpsMenu(): void {
  const el = opsMenuNode();
  const anchor = opsAnchorEl;
  if (!el || !anchor || !anchor.isConnected) return;
  const b = anchor.getBoundingClientRect();
  const listEl = el.closest('.sm-list');
  const lb = listEl?.getBoundingClientRect();
  /**
   * 锚点已经滚出列表可视区 ⇒ 直接收起。否则菜单会「凭空」挂在一个看不见的按钮旁边
   * （滚动时 fixed 菜单不会跟着被裁，看起来像没关掉）。
   */
  if (lb && (b.bottom < lb.top + 2 || b.top > lb.bottom - 2)) {
    opsMenuFor.value = '';
    return;
  }
  const h = el.offsetHeight;
  const w = el.offsetWidth;
  const spaceBelow = window.innerHeight - b.bottom - OPS_MARGIN;
  const spaceAbove = b.top - OPS_MARGIN;
  // 下面放得下就往下；放不下且上面更宽裕就往上（两边都放不下也选更宽的那边，再加 maxHeight）
  const up = h > spaceBelow && spaceAbove > spaceBelow;
  const avail = Math.max(0, up ? spaceAbove : spaceBelow);
  const top = up ? Math.max(OPS_MARGIN, b.top - OPS_GAP - Math.min(h, avail)) : Math.min(b.bottom + OPS_GAP, window.innerHeight - OPS_MARGIN - Math.min(h, avail));
  // 右对齐按钮（菜单在右列），再夹住左右边界，避免窄窗口下被推出屏幕
  const left = Math.max(OPS_MARGIN, Math.min(b.right - w, window.innerWidth - OPS_MARGIN - w));
  opsMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    visibility: 'visible',
    ...(h > avail ? { maxHeight: `${Math.round(Math.max(140, avail))}px`, overflowY: 'auto' } : {}),
  };
}

/** 点 ⋯：同一行再点 = 收起；换行 = 先收起再开（一次只开一个） */
async function toggleOpsMenu(s: SourceInfo, ev: MouseEvent): Promise<void> {
  if (opsMenuFor.value === s.id) {
    opsMenuFor.value = '';
    return;
  }
  opsAnchorEl = ev.currentTarget as HTMLElement;
  opsMenuFor.value = s.id;
  // 先摆到 (0,0) 且不可见 ⇒ 渲染后量到真实高度再定位，避免「先闪在错误位置」
  opsMenuStyle.value = { top: '0px', left: '0px', visibility: 'hidden' };
  await nextTick();
  placeOpsMenu();
}
/**
 * 列表滚动 / 窗口尺寸变化 ⇒ 跟着锚点重新定位（capture：`scroll` 不冒泡，只能捕获）。
 * 用 rAF 合并：`placeOpsMenu` 要读 `offsetHeight`（强制布局），滚一下触发几十次不划算。
 */
let opsRaf = 0;
function onOpsReposition(): void {
  if (!opsMenuFor.value || opsRaf) return;
  opsRaf = requestAnimationFrame(() => {
    opsRaf = 0;
    if (opsMenuFor.value) placeOpsMenu();
  });
}
/** `#283` 登录对话框：值非空 = 打开该源的登录 */
const loginFor = ref<{ id: string; name: string } | null>(null);
/** `#359` 源变量对话框：值非空 = 打开该源的源变量编辑 */
const varFor = ref<{ id: string; name: string } | null>(null);
/** `#287` 行内搜索按钮 → 搜索浮层（范围 = 该源）；null = 关闭 */
const searchFor = ref<SourceInfo | null>(null);

/* ---------------- `#552` 源医生：只显示巡检异常的源 ---------------- */
/**
 * 从巡检播报的 toast 点「详情」进来（`/source-mgr?doctor=1`）⇒ 只列异常源。
 *
 * 为什么**不**改 store 的筛选：`st.shownSources` 是全局筛选的产出，
 * 往里塞一个「医生筛选」会污染其它页面共用的口径；这里只是**在显示层加一层局部过滤**，
 * 且给一条显眼的提示条 + 一键清除 —— 用户不会困在「源怎么少了」。
 */
const doctorIds = ref<Set<string>>(new Set());
const doctorOn = computed(() => doctorIds.value.size > 0);
/** 显示列表：医生筛选开时只留异常源，否则原样（**所见即所选**：全选也基于它） */
const shownList = computed(() =>
  doctorOn.value ? st.shownSources.filter((s) => doctorIds.value.has(s.id)) : st.shownSources,
);
function clearDoctorFilter(): void {
  doctorIds.value = new Set();
  void router.replace({ name: 'source-mgr' });
}
/** 拉巡检快照拿异常源 id（toast 只报了个数字，具体是哪几个要问服务端） */
async function loadDoctorIds(): Promise<void> {
  try {
    const r = await fetch('/api/doctor/patrol');
    if (!r.ok) return;
    const j = (await r.json()) as { snapshot?: { issues?: Array<{ id: string }> } | null };
    const ids = (j.snapshot?.issues ?? []).map((i) => i.id);
    if (ids.length) doctorIds.value = new Set(ids);
  } catch {
    /* 拿不到就不筛选（不能因为巡检挂了就看不到源列表） */
  }
}
/** 该源是否显示「登录」项（与发现页同判据：源配了 loginUrl/loginUi ⇒ 服务端 loginKind ≠ none） */
function hasLogin(s: SourceInfo): boolean {
  return !!s.hasLoginInfo || (!!s.loginKind && s.loginKind !== 'none');
}
/**
 * `#293` 该源**能不能搜**（有没有搜索规则）—— 服务端 `hasSearch` 给的**能力事实**。
 *
 * 与 `state.searchEnabled`（用户开关）是两层：能搜的源才有「搜索」滑块与 🔍 入口；
 * 不能搜的源滑块显示为关闭且点不动（用户 2026-10-05：「有搜索规则的源，滑块才处于启用状态，
 * 可主动禁用」）。
 *
 * `#310`：判据实现已移到 `utils/source-gate.ts`（四个页面共用一份），这里只做转发，
 * 不再各自内联 —— 此前发现页/搜索页/换源各写一遍，口径已经漂移过一次。
 */
function onDocClickForOps(): void {
  opsMenuFor.value = '';
}
onMounted(() => {
  document.addEventListener('click', onDocClickForOps);
  // `#701` 菜单是 fixed 定位 ⇒ 列表一滚就得重算（否则菜单会钉在原地、跟按钮脱开）
  document.addEventListener('scroll', onOpsReposition, true);
  window.addEventListener('resize', onOpsReposition);
  // `#552`：从巡检 toast 的「详情」进来（?doctor=1）⇒ 拉异常源 id 做局部筛选
  if (route.query['doctor'] === '1') void loadDoctorIds();
});
onBeforeUnmount(() => {
  healthPollSeq += 1; // `B6` 停止体检轮询（任务本身继续跑，回到页面可再拉状态）
  document.removeEventListener('click', onDocClickForOps);
  document.removeEventListener('scroll', onOpsReposition, true);
  window.removeEventListener('resize', onOpsReposition);
  if (opsRaf) cancelAnimationFrame(opsRaf);
});

/** `#279` 源类型计数（同工坊规则：池子 = 该引擎下的源 `srcGroupPool`，不受其它筛选影响 —— 计数与过滤必须同池） */
const srcTypeCounts = computed(() => st.sourceTypeCounts(st.srcGroupPool));
/** `#280` 引擎下拉选项：全部引擎行 + engineOptions（不含 demo —— 演示源仍列在「全部引擎」下） */
const smEngineOpts = computed(() => [
  { value: 'all', label: '全部引擎', count: st.sources.length },
  ...st.engineOptions,
]);
/** `#280` 类型下拉选项：全部行 + 计数 > 0 的类型（FilterDropdown 的 options 形状） */
const smTypeOpts = computed(() => [
  { value: '', label: '全部类型', count: st.srcGroupPool.length },
  ...srcTypeCounts.value.filter((t) => t.count > 0).map((t) => ({ value: t.value, label: t.label, count: t.count })),
]);

const validating = ref(false);
const validateResult = ref<ValidateSummary | null>(null);
const validateOpen = ref(false);
const verifyingId = ref<string | null>(null);
const batchVerifying = ref(false);

/* ------------------------------------------------------------------ `B6` 书源体检 */
/** 当前/最近一次体检任务（`done/cancelled/error` 后仍保留，便于看已完成条目） */
const healthJob = ref<HealthJob | null>(null);
/** 轮询代次：新任务/卸载自增，旧循环自行退出 */
let healthPollSeq = 0;
const healthBusy = computed(
  () => !!healthJob.value && (healthJob.value.state === 'queued' || healthJob.value.state === 'running'),
);
const HEALTH_STATE_LABELS: Record<string, string> = {
  ok: '正常', slow: '较慢', degraded: '部分可用', broken: '失效', dead: '死亡',
};
function healthLabel(state?: string): string {
  return state ? HEALTH_STATE_LABELS[state] ?? state : '未体检';
}
function healthTip(s: SourceInfo): string {
  const h = s.health;
  if (!h) return '尚未体检（质量分按中性 50 参与排序）';
  const when = h.checkedAt ? new Date(h.checkedAt).toLocaleString() : '—';
  const dead = h.state === 'dead' && h.deadUntil != null && h.deadUntil > Date.now()
    ? `\n跳过至：${new Date(h.deadUntil).toLocaleString()}（3 天内不体检/不搜索/不换源）`
    : h.state === 'dead'
      ? '\n跳过期已过，等待重新体检复评'
      : '';
  return `状态：${healthLabel(h.state)}（质量分 ${h.quality}）\n最近体检：${when}\n耗时 ${h.respondTime}ms\n${h.message ?? ''}${dead}`;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 启动体检：选中了源就只查选中，否则由服务端按「有效质量分升序」取前 20 个
 * （最差的先查；`dead` 且未过 3 天跳过期的源默认不参与）。
 */
async function runHealthCheck(): Promise<void> {
  if (healthBusy.value) return;
  const ids = [...selected.value];
  healthPollSeq += 1;
  healthJob.value = null;
  try {
    const r = await apiStartHealthCheck({
      ...(ids.length ? { ids, limit: ids.length } : { limit: 20 }),
      concurrency: 3,
    });
    const my = healthPollSeq;
    if (!r.total) {
      healthJob.value = {
        id: r.jobId, state: 'done', total: 0, done: 0, elapsedMs: 0, results: [],
      };
      return;
    }
    while (my === healthPollSeq) {
      const j = await getHealthJob(r.jobId);
      if (my !== healthPollSeq) return;
      healthJob.value = j;
      if (j.state === 'done' || j.state === 'cancelled' || j.state === 'error') {
        await st.loadMeta(true); // 刷新质量列/五态标记
        return;
      }
      await sleep(700);
    }
  } catch (e) {
    healthJob.value = {
      id: '', state: 'error', total: 0, done: 0, elapsedMs: 0, results: [], error: String(e),
    };
  }
}

/** 中止：服务端不再取新条目 + 中断在途请求；**已完成条目保留** */
async function cancelHealthCheck(): Promise<void> {
  const job = healthJob.value;
  if (!job || job.state === 'done' || job.state === 'cancelled' || job.state === 'error') return;
  try {
    healthJob.value = await cancelHealthJob(job.id);
    await st.loadMeta(true);
  } catch { /* 忽略：轮询会把最终状态带回来 */ }
}

// 选中项（复选框）
const selected = ref<Set<string>>(new Set());
const allSelected = computed(() => shownList.value.length > 0 && shownList.value.every((s) => selected.value.has(s.id)));
function toggleSel(id: string) {
  const s = new Set(selected.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selected.value = s;
}
function toggleAll() {
  const s = new Set(selected.value);
  if (allSelected.value) shownList.value.forEach((x) => s.delete(x.id));
  else shownList.value.forEach((x) => s.add(x.id));
  selected.value = s;
}
/**
 * `#428`（`D12`=A）**按源忽略 TLS 校验**：开启前二次确认。
 *
 * 为什么必须确认：开了它，该源的请求（引擎规则请求 + `/api/proxy` 的封面/媒体）改用
 * `rejectUnauthorized:false` —— 不再校验服务端身份，**可被中间人替换**。
 * 这是用户显式承担的风险，不能一跳而过；关闭不需要确认（往安全方向走）。
 */
function toggleInsecureTls(s: SourceInfo): void {
  const on = !s.state.allowInsecureTls;
  if (on && !window.confirm(
    `为「${s.name || s.id}」开启「忽略 TLS 校验」？\n\n` +
    '该源的所有请求将不再校验服务端证书（不校验对方身份），可能被中间人替换。\n' +
    '只应在站点证书确已过期/自签名、且你仍要用这个源时开启。',
  )) return;
  void st.toggle(s.id, 'allowInsecureTls', on);
}

// 批量操作下拉
const batchOpen = ref(false);
const batchBusy = ref(false);
type BatchCmd =
  | 'enable' | 'disable'
  | 'enableSearch' | 'disableSearch'
  | 'enableExplore' | 'disableExplore'
  | 'verify' | 'delete' | 'export';
const BATCH_ITEMS: Array<{ cmd: BatchCmd; label: string; danger?: boolean }> = [
  { cmd: 'enable', label: '✔ 启用选中' },
  { cmd: 'disable', label: '✘ 禁用选中' },
  { cmd: 'enableSearch', label: '🔍 搜索启用' },
  { cmd: 'disableSearch', label: '🔍 搜索禁用' },
  { cmd: 'enableExplore', label: '🗂 发现启用' },
  { cmd: 'disableExplore', label: '🗂 发现禁用' },
  { cmd: 'verify', label: '✓ 批量在线校验（选中）' },
  { cmd: 'export', label: '↧ 导出选中（JSON）' },
  { cmd: 'delete', label: '🗑 删除选中', danger: true },
];

async function runBatch(cmd: BatchCmd) {
  batchOpen.value = false;
  const ids = [...selected.value];
  if (!ids.length) return;
  batchBusy.value = true;
  try {
    if (cmd === 'enable' || cmd === 'disable') {
      const v = cmd === 'enable';
      await Promise.all(ids.map((id) => setSourceState(id, { enabled: v })));
    } else if (cmd === 'enableSearch' || cmd === 'disableSearch') {
      const v = cmd === 'enableSearch';
      await Promise.all(ids.map((id) => setSourceState(id, { searchEnabled: v })));
    } else if (cmd === 'enableExplore' || cmd === 'disableExplore') {
      const v = cmd === 'enableExplore';
      await Promise.all(ids.map((id) => setSourceState(id, { exploreEnabled: v })));
    } else if (cmd === 'verify') {
      batchVerifying.value = true;
      const results: string[] = [];
      let ok = 0;
      for (const id of ids.slice(0, 20)) {
        try {
          // `#694` 不传 keyword ⇒ 后端走上游语义「源配了 checkKeyWord 就用它，否则用『我的』」
          const r = await verifySource(id, { markOnError: true });
          if (r.ok) ok++;
          else results.push(`${id}: ${r.message}`);
        } catch (e) {
          results.push(`${id}: ${String(e)}`);
        }
      }
      alert(`批量校验完成：${ok}/${Math.min(ids.length, 20)} 通过。${results.length ? '\n' + results.slice(0, 8).join('\n') : ''}`);
      await st.loadMeta(true);
    } else if (cmd === 'delete') {
      if (!confirm(`确认删除选中的 ${ids.length} 个源？`)) return;
      await Promise.all(ids.map((id) => st.remove(id).catch(() => undefined)));
      selected.value = new Set();
    } else if (cmd === 'export') {
      // 逐个取 raw 打包下载
      const out: unknown[] = [];
      for (const id of ids) {
        try {
          const r = await fetch(`/api/sources/${encodeURIComponent(id)}`);
          const j = await r.json();
          if (j.raw) out.push(j.raw);
        } catch { /* 跳过 */ }
      }
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `yuedu-sources-${ids.length}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    await st.loadMeta(true);
  } finally {
    batchBusy.value = false;
  }
}

/** 导入源对话框（粘贴文本 / 上传文件·拖拽 / URL 抓取 + 预览 + 去重处理） */
const importOpen = ref(false);
const importMsg = ref('');
/**
 * `B21` 源订阅：
 *  - `subsOpen` = 地址簿浮层；
 *  - `importInitial` = 从订阅点「更新（预览）」带来的 URL/格式（`subId` 用于确认后回写时间）。
 * ★ 更新永远复用 `ImportSourcesDialog`，不另造一套预览/确认。
 */
const subsOpen = ref(false);
const importInitial = ref<{ url: string; format: SourceSubscription['format']; subId: string } | null>(null);

function openSubRefresh(sub: SourceSubscription): void {
  subsOpen.value = false;
  importInitial.value = { url: sub.url, format: sub.format, subId: sub.id };
  importOpen.value = true;
}

function closeImport(): void {
  importOpen.value = false;
  importInitial.value = null;
}

/** 确认导入后回写「最近确认更新」；失败只提示，不影响导入结果 */
async function markSubUpdated(id: string): Promise<void> {
  try {
    const items = await getSourceSubscriptions();
    if (!items.some((s) => s.id === id)) return;
    await putSourceSubscriptions(items.map((s) => (s.id === id ? { ...s, updatedAt: Date.now() } : s)));
  } catch (e) {
    importMsg.value += `（订阅时间未回写：${e instanceof Error ? e.message : e}）`;
  }
}

/**
 * `#208` 口令导入对话框（口令文本 → 本地解码 → 服务端抓取 → 预览 → 导入）。
 * ⚠️ 与「导入源」**是两个入口**：这里只吃口令，不做文件/URL 通道（那是「导入源」的活）。
 */
const ppOpen = ref(false);
/** `#208` 分享口令对话框：值非空 = 正在分享该源（上传有副作用 ⇒ 一源一会话，不预载） */
const shareFor = ref<{ id: string; name: string } | null>(null);

onMounted(() => void st.loadMeta());

/**
 * `#651` 服务实例读的是哪个源库。**旧版这里是「书源目录 / 是否落在测试夹具」** ——
 * 那是「1 源 1 文件」时代的判据；目录已删除、源只从 SQLite 读，再报目录就是误导
 * （用户实测：746 个源明明是从库里读的，页面却红字写着「加载的是测试夹具源」）。
 * 现在只在**真出问题**（库版本过新 / 打开失败）时用 `warning` 提示。
 */
const srcPaths = ref<{ sourceDb: string; sourceCount?: number; trashCount?: number; dataDir?: string; warning?: string } | null>(null);
onMounted(() => {
  void getDiag()
    .then((d) => {
      const p = (d as { paths?: typeof srcPaths.value }).paths;
      if (p) srcPaths.value = p;
    })
    .catch(() => {
      srcPaths.value = null;
    });
});

/** 导入完成 → 提示 + 刷新源列表（「导入源」与「口令导入」共用一套收尾） */
async function onImported(r: { inserted: number; updated: number; skipped: number; failed: number }) {
  const subId = importInitial.value?.subId;
  importOpen.value = false;
  importInitial.value = null;
  ppOpen.value = false;
  importMsg.value = `导入完成 · 新增 ${r.inserted} · 覆盖 ${r.updated} · 跳过 ${r.skipped}${r.failed ? ` · 失败 ${r.failed}` : ''}`;
  if (subId) void markSubUpdated(subId);
  await st.loadMeta(true);
}

/** 恢复已删除（清空删除墓碑 + 重扫目录） */
/*
 * `#269` 恢复已删除：改为**选择式对话框**（用户 2026-10-04：不再点一下就全部恢复）。
 * 对话框本体抽成独立组件 `RestoreRemovedDialog.vue`（与「导入源」同一套浮层样式 ——
 * 用户随后要求：不要内嵌式的临时浮层）；这里只管「开关 + 结果提示」。
 */
const restoreOpen = ref(false);
function openRestore(): void {
  restoreOpen.value = true;
}
function onRestored(n: number): void {
  importMsg.value = `已恢复 / 清空 ${n} 个源`;
  restoreOpen.value = false;
}

async function doValidate() {
  validating.value = true;
  validateResult.value = null;
  try {
    validateResult.value = await st.doValidate();
    validateOpen.value = validateResult.value.failedCount > 0;
  } finally {
    validating.value = false;
  }
}

async function verifyOne(s: SourceInfo) {
  verifyingId.value = s.id;
  try {
    const r = await st.verifyOne(s.id);
    const stages = Object.entries(r.stages).map(([k, v]) => k + (v?.ok ? '✓' : '✗')).join(' ');
    alert(`${r.ok ? '✅ 校验成功' : '❌ ' + r.message + '\n（已写 //error 标记到源注释与分组）'}（${r.respondTime}ms）${stages ? '\n' + stages : ''}`);
  } catch (e) {
    alert('校验出错：' + String(e));
  } finally {
    verifyingId.value = null;
  }
}

async function remove(s: SourceInfo) {
  if (!confirm(`确认删除源「${s.name || s.id}」？`)) return;
  try {
    await st.remove(s.id);
  } catch (e) {
    alert('删除失败：' + String(e));
  }
}

function startEdit(s: SourceInfo) {
  void router.push({ path: '/workshop', query: { id: s.id } });
}
</script>

<template>
  <!--
    `#700` 整页改成 **flex 列 + 钉高**：顶部工具区 / 提示条 / 校验结果 `flex: none` 不动，
    只有下方的源列表卡片吃掉剩余高度并在**卡片内部**滚动（表头吸顶）。
    此前整页交给 `.omni-content` 那个滚动盒 ⇒ 往下翻几十行，工具区、筛选行、表头全被卷走，
    每次换个筛选条件都得先滚回顶部。
  -->
  <div class="sm-root">
    <!-- `#651` 源库（SQLite）异常时才提示。正常情况下不显示任何「源目录」文案：
         唯一存储就是库文件，目录概念已删除（`data/sources` / `tests/fixtures/sources` 都不存在了）。 -->
    <div v-if="srcPaths?.warning" class="card src-paths-warn" data-src-paths-warn style="margin-bottom: 14px">
      <b>⚠️ 源库有异常</b>
      <div style="margin-top: 4px; font-size: 12px; line-height: 1.6">
        {{ srcPaths.warning }}<br />
        源库 <code>{{ srcPaths.sourceDb }}</code>（读进 <b>{{ srcPaths.sourceCount ?? '—' }}</b> 条 ·
        回收站 {{ srcPaths.trashCount ?? 0 }} 条）。
      </div>
    </div>
    <!-- 工具栏 -->
    <div class="card" style="padding: 14px 16px; margin-bottom: 14px">
      <div class="toolbar">
        <button class="btn primary sm" @click="importOpen = true">＋ 导入源</button>
        <!-- `#208` ⑤ 口令导入：与「导入源」并列的**第二个入口**（只吃口令，不吃文件/URL）。
             放在「导入源」旁边是因为它也是「把外面的源拿进来」，只是载体不同。 -->
        <button class="btn sm" data-pp-open @click="ppOpen = true">🔗 口令导入</button>
        <!-- `B21` 源订阅：远程源列表地址簿；更新走「导入源」的强制预览（不静默覆盖） -->
        <button class="btn sm" data-subs-open @click="subsOpen = true">📡 源订阅</button>
        <!-- `#268` 新建源入口：在「导入源」按钮后面（选引擎 ⇒ 跳规则工坊加载新建源编辑界面） -->
        <el-dropdown trigger="click" @command="(k: string) => router.push(`/workshop?new=${k}`)">
          <button class="btn sm">新建源 ▾</button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="legado">📚 legado 源</el-dropdown-item>
              <el-dropdown-item command="maccms">🎬 CMS 源</el-dropdown-item>
              <!-- `#365` RSS 订阅源（此前入口漏了 rss kind） -->
              <el-dropdown-item command="rss">📰 RSS 订阅源</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <!-- `#645` 回收站入口**永远显示**：旧版 v-if="removedIds.length" 在列表一空时把整个
             入口藏掉 —— 用户「删了源却找不到恢复入口」就是它。空回收站也点得进去（对话框里有说明）。 -->
        <button class="btn sm" data-restore-open @click="openRestore">
          🗑 回收站{{ st.trashItems.length ? `（${st.trashItems.length}）` : '' }}
        </button>
        <button class="btn sm" :disabled="validating" @click="doValidate">{{ validating ? '校验中…' : '✓ 批量校验（规则）' }}</button>
        <div class="batch-wrap">
          <button class="btn sm" :class="{ primary: selected.size > 0 }" :disabled="!selected.size || batchBusy" @click="batchOpen = !batchOpen">
            ☰ 批量操作{{ selected.size ? `（${selected.size}）` : '' }} ▾
          </button>
          <div v-if="batchOpen" class="batch-menu" @mouseleave="batchOpen = false">
            <div
              v-for="it in BATCH_ITEMS" :key="it.cmd"
              class="batch-item" :class="{ danger: it.danger }"
              @click="runBatch(it.cmd)"
            >{{ it.label }}</div>
          </div>
        </div>
        <!-- `B6` 书源体检：选中则查选中，否则服务端按质量分升序取前 20（dead 未过期不参与） -->
        <button class="btn sm" :disabled="healthBusy" @click="runHealthCheck">
          🩺 {{ healthBusy ? '体检中…' : selected.size ? `体检（选中 ${selected.size}）` : '体检（前 20）' }}
        </button>
        <span class="v-sep"></span>
        <button class="btn sm" @click="st.exportSources('all')">↧ 导出全部</button>
        <button class="btn sm" @click="st.exportSources('ok')">↧ 导出可读</button>
        <button class="btn sm" @click="st.exportSources('failed')">↧ 导出失败</button>
        <div class="src-count">
          共 <b>{{ st.sources.length }}</b> 源 · 可搜索 <b style="color: var(--green)">{{ st.eligible }}</b>
          · 显示 <b style="color: var(--cy)">{{ shownList.length }}</b>
          <template v-if="selected.size"> · 已选 <b style="color: var(--acc)">{{ selected.size }}</b></template>
        </div>
      </div>

      <!-- `#552` 巡检筛选态的提示条：不给它，用户会以为「源怎么少了」 -->
      <div v-if="doctorOn" class="sm-doctor-bar">
        🩺 源医生：只显示规则异常的 <b>{{ doctorIds.size }}</b> 个源（共检出 {{ st.sources.length }} 源）
        <button class="btn sm" @click="clearDoctorFilter">清除筛选</button>
        <span class="sm-doctor-tip">修完可在规则工坊逐字段「▶ 试跑」验证</span>
      </div>

      <!--
        `#279` 筛选一行化；`#280` 引擎/类型下拉改统一组件 FilterDropdown
        （原生 select 的系统弹层与分组弹层两副面孔；组件高度统一 32px）。
        行内顺序：引擎 → 源类型（仅 legado）→ 源分组（组件共用，池子随引擎+类型下钻）→
        筛选框（名称/URL/注释/分组）→ 排序 → 仅启用 → 仅失败标记。
      -->
      <div class="toolbar" style="margin: 12px 0 0">
        <FilterDropdown
          v-model="st.srcKind"
          :options="smEngineOpts"
          label="引擎"
          empty-text="暂无引擎"
        />
        <FilterDropdown
          v-if="st.srcKind === 'legado'"
          v-model="st.srcSourceType"
          :options="smTypeOpts"
          label="类型"
          empty-text="该引擎下暂无类型"
        />
        <!--
          源分组筛选：**与书院/影院/规则工坊共用同一个组件**（2026-09-29 用户实测 ①）。
          此前这里是一个原生 `<select>`，内容只有「全部分组（N）+ 分组名」——
          ① 少「未分组」② 每项没有计数 ⇒ 与其它三个页面「看起来不是一个东西」。
          现在四项内容与观感完全一致（同一份 `SourceGroupFilter` + 同一份 `sourceGroupOptions`）。
        -->
        <div class="src-group-filter">
          <SourceGroupFilter
            v-model="st.srcGroup"
            :options="st.srcGroupOptions"
            :all-count="st.srcGroupPool.length"
            :shown-count="shownList.length"
            label="源"
            empty-text="该分类下暂无分组"
          />
        </div>
        <input v-model="st.srcQuery" :placeholder="SOURCE_QUERY_PLACEHOLDER" style="flex: 1; min-width: 180px" />
        <select v-model="st.srcSort" style="max-width: 160px">
          <option value="default">默认排序</option>
          <option value="customOrder">手动排序值</option>
          <option value="name">名称 A→Z</option>
          <option value="group">分组</option>
          <option value="respondTime">响应时间</option>
          <option value="quality">质量分（高→低）</option>
          <option value="addedAt">导入时间</option>
        </select>
        <label class="chk"><input type="checkbox" v-model="st.srcOnlyEnabled" /> 仅启用</label>
        <label class="chk"><input type="checkbox" v-model="st.srcOnlyError" /> 仅失败标记</label>
      </div>
    </div>

    <!-- 导入结果提示 -->
    <div v-if="importMsg" class="card src-msg" style="margin-bottom: 14px">
      <span>{{ importMsg }}</span>
      <button class="btn mini ghost" @click="importMsg = ''">知道了</button>
    </div>

    <!-- 校验结果 -->
    <div v-if="validateResult" class="card" style="padding: 12px 16px; margin-bottom: 14px; font-size: 13px">
      <strong>规则校验：</strong> 共 {{ validateResult.total }} · 通过 {{ validateResult.okCount }} · 失败 {{ validateResult.failedCount }}
      <button v-if="validateResult.failedCount" class="btn mini ghost" @click="validateOpen = !validateOpen">
        {{ validateOpen ? '收起' : '展开失败(' + validateResult.failedCount + ')' }}
      </button>
      <ul v-if="validateOpen" class="fail-list">
        <li v-for="r in validateResult.results.filter((x) => !x.ok)" :key="r.id">
          <code>{{ r.kind }} · {{ r.name || r.id }}</code>
          <span v-for="(iss, i) in r.issues" :key="i"> → [{{ iss.level }}] {{ iss.path }}: {{ iss.message }}</span>
        </li>
      </ul>
    </div>

    <!-- `B6` 体检进度/结果：可中止；中止后已完成条目仍列在这里 -->
    <div v-if="healthJob" class="card health-panel">
      <div class="health-head">
        <strong>🩺 书源体检：</strong>
        <span>
          {{ healthJob.state === 'queued' ? '排队中' : healthJob.state === 'running' ? '进行中'
            : healthJob.state === 'cancelled' ? '已中止' : healthJob.state === 'error' ? '出错' : '完成' }}
          · {{ healthJob.done }}/{{ healthJob.total }} · {{ Math.round(healthJob.elapsedMs / 1000) }}s
          <template v-if="healthJob.error"> · {{ healthJob.error }}</template>
        </span>
        <button v-if="healthBusy" class="btn mini" @click="cancelHealthCheck">中止（保留已完成）</button>
        <button v-else class="btn mini ghost" @click="healthJob = null">关闭</button>
      </div>
      <ul v-if="healthJob.results.length" class="health-list">
        <li v-for="r in healthJob.results" :key="r.id">
          <span class="health-badge" :class="'h-' + r.health.state">{{ healthLabel(r.health.state) }}</span>
          <b>{{ r.health.quality }}</b>
          <code>{{ r.id }}</code>
          <span class="health-msg">{{ r.health.message }}</span>
        </li>
      </ul>
      <div v-else class="health-empty">
        {{ healthBusy ? '等待首个条目完成…' : '没有符合条件的源（`dead` 源在 3 天跳过期内不参与体检）' }}
      </div>
    </div>

    <!-- 源表格：复选框 + 开关 + 操作（无 全/无 列头按钮） -->
    <ImportSourcesDialog
      v-if="importOpen"
      :initial-url="importInitial?.url"
      :initial-format="importInitial?.format"
      @close="closeImport" @imported="onImported"
    />

    <!-- `B21` 源订阅地址簿：点「更新（预览）」后用它关掉自己、打开「导入源」 -->
    <SourceSubscriptionsDialog
      v-if="subsOpen"
      @close="subsOpen = false" @refresh="openSubRefresh"
    />

    <!-- `#269` 恢复已删除：独立浮层对话框（与「导入源」同一套样式，不是内嵌式） -->
    <RestoreRemovedDialog v-if="restoreOpen" @close="restoreOpen = false" @restored="onRestored" />

    <!-- `#208` ⑤ 口令导入（口令 → 源） -->
    <PassphraseImportDialog v-if="ppOpen" @close="ppOpen = false" @imported="onImported" />

    <!-- `#208` ⑤ 分享口令（源 → 口令）。`v-if` 保证每次打开都是**全新会话**：
         上传是副作用，不能拿上一次的结果复显（否则用户以为这次也传了） -->
    <SharePassphraseDialog
      v-if="shareFor"
      :key="shareFor.id"
      :source-id="shareFor.id" :source-name="shareFor.name"
      @close="shareFor = null"
    />

    <!-- `#287` 行内「🔍」打开的搜索浮层（范围 = 该源；卡片与发现页同款） -->
    <SourceSearchDialog
      :open="!!searchFor"
      :scope-ids="searchFor ? [searchFor.id] : []"
      :scope-label="searchFor ? '源：' + (searchFor.name || searchFor.id) : ''"
      @close="searchFor = null"
    />

    <!-- `#283` 行内「更多 → 登录…」打开的登录对话框（与发现页同一组件） -->
    <SourceLoginDialog
      v-if="loginFor"
      :source-id="loginFor.id" :source-name="loginFor.name"
      @close="loginFor = null"
    />

    <!-- `#359` 行内「更多 → 源变量…」（Legado「设置源变量」）：
         聚合类源的 `Get('url')` 全靠它 —— 没地方填 ⇒ 那批源永远报 JSON 解析错。 -->
    <SourceVariableDialog
      v-if="varFor"
      :id="varFor.id" :name="varFor.name"
      @close="varFor = null"
    />

    <div class="card sm-list">
      <table class="tbl">
        <thead>
          <tr>
            <th style="width: 36px"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
            <th>名称</th><th>分组</th><th>类型</th>
            <th>启用</th><th>搜索</th><th>发现</th>
            <!-- `B6` 书源体检：五态 + 质量分（排序/搜索/换源都吃这个分） -->
            <th style="width: 84px" title="书源体检结果：五态（正常/较慢/部分可用/失效/死亡）+ 质量分 0~100；dead 源 3 天内不体检/不搜索/不换源">体检</th>
            <!-- `#428`（`D12`=A）按源忽略 TLS 校验：站点证书过期/自签名时才开，默认关 -->
            <th style="width: 56px" title="忽略 TLS 校验（⚠️ 该源的请求不再校验服务端身份，可被中间人替换）：仅在站点证书过期/自签名且你仍要用该源时开启">TLS</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in shownList" :key="s.id" :title="(s.comment || '') + '\n' + s.id">
            <td><input type="checkbox" :checked="selected.has(s.id)" @change="toggleSel(s.id)" /></td>
            <td>{{ s.name || s.id }}<span v-if="(s.comment || '').includes('//error')" class="src-err" title="校验失败标记">⚠</span></td>
            <td class="src-group" :title="s.group">{{ s.group || '—' }}</td>
            <td><span class="tag">{{ st.kindIcon(s.kind) }} {{ s.kind }}</span></td>
            <td><div class="switch" :class="{ on: s.state.enabled }" @click="st.toggle(s.id, 'enabled', !s.state.enabled)"></div></td>
            <!--
              `#293` 搜索开关：**只有具备搜索规则的源才处于启用态且可切换**；
              没有搜索规则的源显示为关闭（灰）且不可点（title 说明原因）。
              `#310`：再加一层「源已禁用 ⇒ 不可更改设置」（用户口径：「禁用，源不可用，
              发现、搜索都不可用，且不可更改设置」）—— 要改设置先启用该源。
            -->
            <td>
              <div
                class="switch"
                :class="{ on: s.state.searchEnabled && searchSwitchEnabled(s), off: !searchSwitchEnabled(s) }"
                :title="!s.state.enabled
                  ? '该源已禁用 —— 搜索不可用，需先启用源才能更改此设置'
                  : !canSearch(s)
                    ? '该源未配置搜索规则（searchUrl），无法搜索'
                    : (s.state.searchEnabled ? '点击禁用搜索' : '点击启用搜索')"
                @click="searchSwitchEnabled(s) && st.toggle(s.id, 'searchEnabled', !s.state.searchEnabled)"
              ></div>
            </td>
            <!--
              `#310`（用户 2026-10-07 需求 ①）**RSS 订阅源没有「发现」概念 ⇒ 取消该滑块**。
              依据：上游 `RssSource`（`RssSource.kt:15-117`）没有 `enabledExplore` 字段
              （那是 `BookSource.kt:52` 的），RSS 的分类来自 `sortUrl` 规则/脚本解析，是**必然有**。
              所以这里显示一个不可交互的「—」，而不是给个假开关。
              ⚠️ 与之配套：发现页对 rss **不读** `exploreEnabled`（见 `utils/source-gate.ts`），
              否则一旦该值被写脏，源会从发现页消失却没有任何开关能恢复。
            -->
            <td>
              <span
                v-if="!hasExploreSwitch(s.kind)" class="switch-na"
                title="RSS 订阅源没有「发现」开关：分类由 sortUrl 规则/脚本解析，必然可用（上游 RssSource 无 enabledExplore）"
              >—</span>
              <div
                v-else class="switch"
                :class="{ on: s.state.exploreEnabled && exploreSwitchEnabled(s), off: !exploreSwitchEnabled(s) }"
                :title="!s.state.enabled
                  ? '该源已禁用 —— 发现不可用，需先启用源才能更改此设置'
                  : !canExplore(s)
                    ? '该源未配置发现规则（exploreUrl），无法发现'
                    : (s.state.exploreEnabled ? '点击禁用发现（不出现在发现页）' : '点击启用发现')"
                @click="exploreSwitchEnabled(s) && st.toggle(s.id, 'exploreEnabled', !s.state.exploreEnabled)"
              ></div>
            </td>
            <!-- `B6` 体检：未体检显示 —；dead 且未过期用死亡色标出跳过态 -->
            <td class="src-health" :title="healthTip(s)">
              <span v-if="s.health" class="health-badge" :class="'h-' + s.health.state">
                {{ healthLabel(s.health.state) }} <b>{{ s.health.quality }}</b>
              </span>
              <span v-else class="health-none">—</span>
            </td>
            <!--
              `#428`（`D12`=A，用户 2026-10-12 拍板）**按源忽略 TLS 校验**。

              用例：站点证书过期/自签名（实测 AGE 动漫 `api.agedm.io` 叶子证书当天过期，
              `http` 不通、无替代域）—— 站点续期前，只有「用户显式承担风险」这一条路。

              ⚠️ **开启要二次确认 + 行内标 ⚠**：开了它，该源的请求（引擎规则请求 + `/api/proxy`
              的封面/媒体）都不再校验服务端身份 ⇒ 可被中间人替换。默认**关闭**（安全默认，
              与同表另三个开关的「默认全开」相反 —— 见 core `SourceState.allowInsecureTls`）。
            -->
            <td>
              <div
                class="switch"
                :class="{ on: s.state.allowInsecureTls, warn: s.state.allowInsecureTls }"
                :title="s.state.allowInsecureTls
                  ? '⚠️ 已忽略 TLS 校验：该源请求不校验服务端身份（证书过期/自签名站点才需要）。点击关闭'
                  : '忽略 TLS 校验（默认关）：仅当该站证书过期/自签名、且你仍要用这个源时才开 —— 开启后该源请求不校验服务端身份，可能被中间人替换'"
                @click="toggleInsecureTls(s)"
              ></div>
            </td>
            <td style="white-space: nowrap" class="src-ops">
              <!-- `#166` 置顶 / 置底：改上游 `BookSource.customOrder`（`BookSource.kt:46`；
                   列表顺序 = `order by customOrder asc`）。服务端只改这一个数字并落盘。
                   `#236`：置顶改用组件（图标随状态变 + 再次点击取消置顶排回原位）。
                   `#238`：可同时置顶多个，最后置顶的排最顶；置顶态由服务端名单给出（见 store）。
                   `#282`：置顶的顺序效果在所有页生效（facade listSources 按 customOrder 排）。
                   `#283`：登录/置底/检验/删除收拢进 ⋯更多（删除带确认）。
                   `#287`：按钮顺序 = 编辑 / 搜索 / 置顶 / ⋯更多；搜索 = 弹层搜本源。
                   `#293`（用户 2026-10-05）：行内 🔍 **收进 ⋯ 菜单**，且**只有能搜的源**才给这一项
                   —— 与「登录」（`hasLogin`）完全同一套门控逻辑：能力不具备就不出现入口。
                   常驻按钮回到 编辑 / 置顶 / ⋯ 三个。 -->
              <button class="btn mini" @click="startEdit(s)">编辑</button>
              <SourcePinButton :id="s.id" block @toggle="(id) => st.togglePin(id)" />
              <button
                class="btn mini" :class="{ on: opsMenuFor === s.id }" title="更多操作"
                :data-ops-btn="s.id"
                @click.stop="toggleOpsMenu(s, $event)"
              >⋯</button>
              <div v-if="opsMenuFor === s.id" class="src-ops-menu" :style="opsMenuStyle" @click.stop>
                <!--
                  `#310`：**能力门 + 源已启用**才给这一项。
                  用户口径（2026-10-07 需求 ③）有两句要一起读：
                    ·「禁用搜索 ⇒ ……聚合搜索、换源搜索都不出现在源列表，发现页不提供搜索按钮
                       （**源管理页、源列表，单源后的更多按钮还提供**，可对该源发起搜索）」
                      ⇒ 本项**不看** `searchEnabled`（用户关了搜索也仍要能单源试搜）；
                    ·「禁用（源），源不可用，发现、搜索都不可用」
                      ⇒ 本项**要看** `enabled`（源整体禁用就是不可用）。
                -->
                <button
                  v-if="s.state.enabled && canSearch(s)" class="src-ops-mi"
                  title="搜索这个源（弹层，结果为发现页同款封面卡片）"
                  @click="searchFor = s; opsMenuFor = ''"
                >🔍 搜索…</button>
                <button
                  v-if="hasLogin(s)" class="src-ops-mi"
                  @click="loginFor = { id: s.id, name: s.name || s.id }; opsMenuFor = ''"
                >🔐 登录…</button>
                <!-- `#359` 源变量：**不做能力门**（上游 `BaseSource.getVariable()` 是基类能力，
                     任何源的脚本都能读）⇒ 一律给入口，省得「想配却找不到地方」。 -->
                <button
                  class="src-ops-mi" data-var-open
                  title="配置 source.getVariable() 读到的内容（聚合源的 Get('url') 靠它）"
                  @click="varFor = { id: s.id, name: s.name || s.id }; opsMenuFor = ''"
                >⚙ 源变量…</button>
                <!-- `#208` ⑤ 分享口令（`D5`=B）：源 → 直链上传 → 中文口令。
                     ⚠️ 它**不是**「有搜索规则才给」那类门控项 —— 任何源都能被分享
                     （分享的是源 json 文件本身，与源能不能搜无关）。 -->
                <button
                  class="src-ops-mi" data-share-open
                  title="把这个源上传到网盘并生成分享口令，别人用「口令导入」即可拿到"
                  @click="shareFor = { id: s.id, name: s.name || s.id }; opsMenuFor = ''"
                >📤 分享口令…</button>
                <button class="src-ops-mi" @click="st.setOrder(s.id, 'bottom'); opsMenuFor = ''">
                  <!-- 与置顶按钮（SourcePinButton）同风格的内联 SVG：向下箭头 + 底端横线
                       =「顶到底了」，和「已置顶 = 顶端横线」互为镜像 -->
                  <svg viewBox="0 16 16" width="13" height="13" aria-hidden="true" style="vertical-align: -2px">
                    <path d="M8 3v8.5M8 13l-3.2-3.4M8 13l3.2-3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    <path d="M4.5 14.8h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                  置底
                </button>
                <button
                  class="src-ops-mi" :disabled="verifyingId === s.id"
                  @click="verifyOne(s); opsMenuFor = ''"
                >✓ 检验</button>
                <button class="src-ops-mi danger" @click="remove(s); opsMenuFor = ''">删除…</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!shownList.length" class="empty">没有匹配的源。</div>
    </div>
  </div>
</template>

<style scoped>
/*
 * `#700` 布局：只有列表滚，工具区/表头不动。
 * 三段式 —— `.sm-root`（钉高 flex 列）> 顶部若干卡（`flex: none`）+ `.sm-list`（吃掉剩余）。
 * `min-height: 0` 是 flex 子项能真正收缩的前提（默认 `auto` 会被内容顶开，滚动条就不出现）。
 * `.sm-list` 自带 `min-height`：窄屏工具区换行到很高时，宁可整页出现外层滚动，
 * 也不要把列表压成一条缝（`omni-content` 本身 `overflow: auto`，兜得住）。
 */
.sm-root { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.sm-root > :not(.sm-list) { flex: none; }
.sm-list {
  flex: 1 1 auto; min-height: 260px;
  overflow: auto; padding: 4px 12px 10px;
  /* 滚动发生在卡片内部 ⇒ 表头才有必要吸顶 */
  overscroll-behavior: contain;
}
/*
 * 表头吸顶。三个细节都不能省：
 *  · `background` 必须**不透明**（`--bg-2` 是卡片底色）—— 否则下面的行会从表头字缝里透出来；
 *  · `.tbl` 是 `border-collapse: collapse`，吸顶后 `th` 自己的 `border-bottom` 会跟着滚走
 *    ⇒ 用 `inset box-shadow` 画那条线（视觉一致，且不占布局）；
 *  · `z-index` 要压过 `.src-ops-menu`(60) 之外的普通单元格，但**不能**高到盖住操作菜单 ——
 *    菜单是 `position: absolute` 在 `td` 里、有自己的 60，这里给 2 足够。
 */
.sm-list .tbl thead th {
  position: sticky; top: 0; z-index: 2;
  background: var(--bg-1); /* = `.card` 的底色（theme.css:91），抄错成 --bg-2 会有色差 */
  box-shadow: inset 0 -1px 0 var(--border);
}
.src-count { margin-left: auto; font-size: 12px; color: var(--muted); }
/* `#552` 巡检筛选提示条：橙色左边框 + 浅底，与「筛选生效中」的语义对齐 */
.sm-doctor-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 8px 0 2px; padding: 7px 10px; border-radius: 7px;
  background: var(--bg-2); border: 1px solid var(--border); border-left: 3px solid var(--orange);
  font-size: 12px; color: var(--text-0);
}
.sm-doctor-tip { font-size: 11px; color: var(--faint); margin-left: auto; }
/* `#293` 无搜索规则的源：搜索滑块显示为「不可用」（半透明 + 禁止光标），不参与切换 */
.switch.off { opacity: 0.35; cursor: not-allowed; }
/* `#428` 「已忽略 TLS 校验」的滑块标成警示色 —— 与另三个「正常开关」区分开（风险可见） */
.switch.warn { box-shadow: 0 0 0 1px var(--gold); }
/* `#310` 无该开关的源（RSS 的「发现」列）：显示一个淡色破折号占位，保持列宽一致 */
.switch-na { color: var(--muted); opacity: 0.55; cursor: help; user-select: none; }
/* `#279`/`#280` 引擎/类型下拉已换 FilterDropdown（样式随组件走，高度 32px 与其余控件一致） */
.src-group-filter :deep(.sg-wrap) { margin-bottom: 0; }
.v-sep { width: 1px; height: 18px; background: var(--border-strong); }
.chk { font-size: 12px; color: var(--muted); display: flex; gap: 4px; align-items: center; cursor: pointer; }
.src-err { color: var(--gold); margin-left: 4px; cursor: help; }
/* `#283` 行内「更多」菜单。`#701`：定位交给 JS（`position: fixed` + 内联 top/left），
   这里只留外观 —— `absolute` 会被 `.sm-list` 的 `overflow:auto` 裁掉、还会撑高它的 scrollHeight。 */
.src-ops { position: relative; }
/* `#296`（用户 2026-10-06）操作列三枚按钮「高矮不一 / 颜色不一」的收口。
   ❗根因：三枚按钮来自**两个不同来源** —— `编辑`/`⋯` 是全局 `.btn.mini`
   （`padding:2px 8px` + `font-size:11px` ⇒ 实高随字体行高漂，本机约 19px、
   底色 `--bg3`、字色 `--text`），而 `↑` 是 `SourcePinButton.block`
   （固定 22px、原为透明底 + `--muted` 灰图标）。
   ⇒ 同一行里出现「19px 亮字」与「22px 灰图标」两种观感。
   这里只对齐**在操作列里**的 `btn mini`：定高 22px（与 block 的 22×22 同高）、
   `padding` 竖向归零（高度改由 height 决定，不再受字体行高影响）、`vertical-align: middle`
   让三个 inline-flex 按钮在同一基线上垂直居中。
   ⚠️ 不改全局 `.btn.mini`：`btn mini` 在 24 个文件里都在用，全局定高会波及弹窗工具条。 */
.src-ops > .btn.mini { height: 22px; padding: 0 8px; line-height: 1; vertical-align: middle; }
.src-ops-menu {
  position: fixed; z-index: 60;
  min-width: 118px; padding: 4px; display: flex; flex-direction: column;
  background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: 9px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
  /* 两侧都不够高时（JS 会同时给 maxHeight）内部滚动，绝不溢出视口 */
  overscroll-behavior: contain;
}
.src-ops-mi {
  display: flex; align-items: center; gap: 6px; text-align: left;
  padding: 7px 10px; border: 0; border-radius: 7px; background: transparent;
  color: var(--text-1); font-size: 12.5px; font-family: var(--font); cursor: pointer;
  white-space: nowrap;
}
.src-ops-mi:hover { background: var(--bg-3); }
.src-ops-mi.danger { color: var(--danger, #e53935); }
.src-ops-mi:disabled { opacity: 0.45; cursor: default; }
.src-group { font-size: 12px; color: var(--muted); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-msg { display: flex; align-items: center; gap: 10px; padding: 10px 14px; font-size: 12.5px; color: var(--green); }
.src-paths-warn { padding: 10px 14px; font-size: 12.5px; color: var(--orange); border-left: 3px solid var(--orange); }
.edit-area {
  width: 100%; font-family: var(--mono); font-size: 12px;
  background: var(--bg-0); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px; outline: none;
}
.edit-area:focus { border-color: var(--acc-dim); }
.fail-list { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: var(--danger); line-height: 1.7; }
.fail-list code { color: var(--gold); }
/* `B6` 书源体检：五态徽标 + 进度面板 */
.health-panel { padding: 12px 16px; margin-bottom: 14px; font-size: 13px; }
.health-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.health-list { margin: 8px 0 0; padding: 0; list-style: none; max-height: 220px; overflow: auto; }
.health-list li { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
.health-msg { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.health-empty { margin-top: 8px; color: var(--muted); }
.health-badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 12px; line-height: 18px; white-space: nowrap; }
.health-badge.h-ok { background: rgba(74, 222, 128, 0.16); color: var(--green); }
.health-badge.h-slow { background: rgba(250, 204, 21, 0.16); color: var(--yellow, #facc15); }
.health-badge.h-degraded { background: rgba(250, 204, 21, 0.12); color: var(--yellow, #facc15); }
.health-badge.h-broken { background: rgba(255, 84, 112, 0.14); color: var(--red); }
.health-badge.h-dead { background: rgba(255, 84, 112, 0.2); color: var(--red); text-decoration: line-through; }
.health-none { color: var(--muted); }
.src-health b { font-weight: 600; margin-left: 2px; }

.batch-wrap { position: relative; }
.batch-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 30;
  min-width: 210px;
  background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: 10px;
  box-shadow: var(--shadow); padding: 5px;
}
.batch-item {
  padding: 8px 12px; border-radius: 7px; cursor: pointer;
  font-size: 12.5px; color: var(--text-1); white-space: nowrap;
}
.batch-item:hover { background: var(--brand-soft); color: #fff; }
.batch-item.danger { color: var(--red); }
.batch-item.danger:hover { background: rgba(255, 84, 112, 0.12); color: var(--red); }

/*
 * 共用组件 `.sg-wrap` 自带 `margin-bottom: 10px`（发现页左栏是竖排，需要它）。
 * 源管理这里是横排 toolbar ⇒ 归零，否则按钮会往下偏 10px、与旁边的 select 不齐。
 */
.src-group-filter { width: 220px; flex: 0 0 auto; }
.src-group-filter :deep(.sg-wrap) { margin-bottom: 0; }
</style>
