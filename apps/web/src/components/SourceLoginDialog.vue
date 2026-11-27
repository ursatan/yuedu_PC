<script setup lang="ts">
/**
 * 源登录对话框（对齐 Legado `SourceLoginDialog` + 工具栏）：
 *
 *  · `loginUi` 表单（text/password）→ 填写后点「登录」提交；
 *  · `loginUi` 按钮行（button/toggle）→ action 是**绝对 URL** 就直接打开登录页
 *    （Legado `handleButtonClick` 的 `openUrl(action)`），否则把 action 作为脚本回传执行；
 *  · `loginUrl` 是登录页链接 → 「打开登录页」让用户在真实浏览器完成人工/安全验证；
 *  · 脚本内部调用 `java.startBrowserAwait/webView` → 服务端返回 `action:'browser'` + url，
 *    前端同样引导打开登录页；
 *  · 顶部工具栏等价物：显示登录信息键名 / 清除登录信息（登录信息 + 登录头 + Cookie）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from '../toast';
// 源脚本的 java.toast / longToast 只走这一条通道（底部居中 Android 形态）—— 与应用反馈（右上角）分开
import { androidToast } from '../android-toast';
import { isLoginRowFull, loginRowStyle } from '../utils/login-layout';
// toggle 行取值口径（`chars[1]/chars[0]`，不是 'true'/'false'）—— 见 utils/login-toggle.ts
import { isToggleOn, toggleValueFor } from '../utils/login-toggle';
// `#456` 内嵌真浏览器：应用内登录 + cookie 回传服务端（harvest 通道）
import { embeddedAvailable, embeddedHarvest } from '../utils/embedded-webview';
import InAppBrowser from './InAppBrowser.vue';

const props = defineProps<{ sourceId: string; sourceName?: string; autoWindow?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>();

/**
 * 一行登录 UI —— **照 Legado `RowUi.kt` 逐条对齐**（`data class RowUi`）：
 * `name` / `type` / `action` / `chars` / `default` / `viewName` / `style` / `key` / `hint` /
 * `value` / `options` / `countdown`（本仓只用得到其中 12 个，`viewName` 未用）。
 *
 * ⚠️ **v1（`loginUi` 的 `RowUi` 数组）与 v2（源脚本 `loginUi(state)` 产出的 rows）共用这一个类型**：
 *  · v1 的存储键是 `name`；
 *  · **v2 的存储键是 `key`**（Legado `SourceLoginV2Delegate` 一律以 key 作 `fieldKey`）。
 * `key` / `value` / `countdown` 三个字段**此前没声明**，于是 `fieldKey(f)` 与模板里的 `f.value`
 * 全是 TS2339 —— 运行期一直是好的（源脚本给的 JSON 里确实有这些键），**只有类型漏了**。
 * Type 取值见 `RowUi.Type`：`text` / `password` / `button` / `label` / `toggle` / `select`。
 *
 * `style` 与 `@yuedu/core` 的 `LoginField.style`（`{flexGrow, flexBasisPercent}`）同形 ——
 * `normalizeLoginField` 把上游 `FlexChildStyle.layout_*` 归一到这两个键，前端 `rowStyle()` 消费。
 */
interface LoginField {
  name: string;
  type: string;
  /** **v2 的存储键**（v1 用 `name`）。见 `fieldKey()` */
  key?: string;
  action?: string;
  chars?: string[];
  default?: string;
  hint?: string;
  options?: string[];
  /** 行的当前值（v2 toggle 行的初始勾选态用它） */
  value?: string;
  /** v2 按钮行：点击后的倒计时秒数 */
  countdown?: number;
  /**
   * 行级 flex 布局（Legado `RowUi.style` → `FlexChildStyle.apply`）。
   * `flexBasisPercent` 是**小数比例**（`1` = 整行、`0.25` = 一行 4 个），见 `rowStyle()`。
   */
  style?: { flexGrow?: number; flexBasisPercent?: number };
}

interface Plan {
  kind?: string;
  url?: string | null;
  needBrowser?: boolean;
  uiFields?: LoginField[];
  uiIsScript?: boolean;
  /** 是否存在 login() 登录脚本（决定 ✓ 按钮文案） */
  hasLoginScript?: boolean;
  loginInfoKeys?: string[];
  hasLoginInfo?: boolean;
  /**
   * 已保存登录信息里的**非敏感字段**（服务端原样回填 —— 用户 2026-09-25 决策：
   * 「账号密码框用 `*` 代替，非敏感文本原样回填」）。
   */
  loginInfo?: Record<string, string>;
  /** 有值但**不下发真值**的敏感字段键名（输入框改为 placeholder 提示「已保存，留空则不修改」） */
  loginInfoMasked?: string[];
  loginHeaderKeys?: string[];
  hasCookie?: boolean;
  cookieCount?: number;
  /** LoginUiV2（`loginUi = {"version":2}`）：行由源脚本 `loginUi(state)` 渲染，打开对话框先渲染一次 */
  uiV2?: boolean;
}

interface LoginResult {
  ok?: boolean;
  action?: string;
  url?: string;
  fields?: LoginField[];
  /** LoginUiV2（`loginUi = {"version":2}`）：fields 是「本次渲染」的行，前端整表重绘 */
  uiV2?: boolean;
  /** v2：会话状态 —— 原样保存、下次动作原样回传（引擎/UI 都不解释它） */
  loginState?: string;
  /** v2：字段级错误（key → 文案） */
  fieldErrors?: Record<string, string>;
  /** v2：源脚本要求关闭对话框（`{"close":true}`） */
  close?: boolean;
  needBrowser?: boolean;
  /**
   * `#392` 打开页面的**目的**（core 契约 `UnifiedLoginResult.browserKind`）：
   * `show` ⇒ 应用内极简浏览器；`cookie` ⇒ 本机真浏览器（要回传 Cookie）。
   */
  browserKind?: 'show' | 'cookie';
  cookie?: string;
  count?: number;
  loginHeader?: string;
  hasLoginInfo?: boolean;
  /** `#397` 本次运行是否**新写了**登录态（Cookie/登录头/loginInfo delta；判「按钮是否真登录」唯一判据） */
  wroteLoginState?: boolean;
  message?: string;
  error?: string;
  /** 登录脚本执行期间 `java.toast` / `java.longToast` 弹出的文本（服务端收集回传） */
  toasts?: string[];
  /**
   * `java.upLoginData(map)`：脚本要求**实时更新界面字段值**（键 = 行的 `name`）。
   * 上游只改 UI、不落库（`SourceLoginJsExtensions.kt:35-37`）。用户 2026-10-15 实测 18AV
   * 「🌐获取网址」：toast 说「已填写最新网址」而输入框仍空 —— 前端必须把它回填进 `info`。
   */
  loginData?: Record<string, string>;
}

const plan = ref<Plan>({});
const fields = ref<LoginField[]>([]);
const info = ref<Record<string, string>>({});
/**
 * `java.upLoginData` 的**界面覆盖值**（键 = 行 `name`）。
 * 它只是「界面值」，不是登录信息：服务端不落库（上游同）⇒ 必须由前端记住，
 * 否则每次 `loadPlan()` 用服务端 `loginInfo` 重写 `info` 就把它冲掉了。
 */
const upLoginData = ref<Record<string, string> | null>(null);

/** 把 `upLoginData` 覆盖到表单（只认确实是 text/password 的行键；不认识的键不动） */
function applyUpLoginData(): void {
  const src = upLoginData.value;
  if (!src) return;
  // 行键用 `fieldKey`（v1 = `name`；**v2 = `key`**）—— 与模板 `v-model="info[fieldKey(f)]"` 同一口径，
  // 否则 v2 源的 `java.upLoginData({'k':…})` 会因键对不上而静默不回填。
  const names = new Set(fields.value.filter((f) => f.type === 'text' || f.type === 'password').map((f) => fieldKey(f)));
  const next = { ...info.value };
  let hit = 0;
  for (const [k, v] of Object.entries(src)) {
    if (names.has(k)) {
      next[k] = String(v ?? '');
      hit += 1;
    }
  }
  if (hit) info.value = next;
}
/** 服务端「有值但不下发真值」的敏感字段键（用于 placeholder 提示 + 「留空＝不修改」判定） */
const savedSecretKeys = ref<Set<string>>(new Set());
/** LoginUiV2：源脚本的会话状态（原样存、原样回传） */
const uiState = ref('{}');
/** LoginUiV2：字段级错误（key → 文案；key 不在表单里时按 toast） */
const fieldErrors = ref<Record<string, string>>({});
/** LoginUiV2：按钮倒计时（action → 剩余秒） */
const countdown = ref<Record<string, number>>({});
const countdownTimers = new Map<string, ReturnType<typeof setInterval>>();
/** 本次登录流程是否走 LoginUiV2（由服务端结果决定） */
const isV2 = ref(false);
/**
 * v2 的 `login` 命令把登录信息写进**源变量**（引擎 `ctx.variables['__loginInfo']`，Legado `putLoginInfo` 同义），
 * 而面板顶部那个「已登录」标记读的是 hub 层的 `/login-info`（v1 表单值走这条）——两者不是一个存储。
 * 所以这里用结果里的 `hasLoginInfo` 兜一层，避免「刚登录成功却显示未登录」。
 */
const v2LoggedIn = ref(false);
const busy = ref(false);
const msg = ref('');
const lastUrl = ref('');
const loading = ref(true);
/**
 * `#392` 应用内极简浏览器（空 = 关闭）。
 *
 * 用户诉求：「登录界面打开的网页，能否…是 iframe 还是什么，具备极简浏览器的功能，
 * 可前进，后退，刷新的？**而不是跳转 Chrome**」——
 * `java.startBrowser`（fire-and-forget、只为「给人看」）走这里；需要**浏览器 Cookie** 的
 * （`startBrowserAwait` / 登录页型）仍走本机 Chromium（跨域 cookie 取不回服务端，见组件头注释）。
 */
const iabUrl = ref('');

/** 在内置浏览器打开（`browserKind === 'show'` 的按钮动作 / 手动查看） */
function openInApp(url?: string | null): void {
  const u = String(url ?? '').trim();
  if (!u) {
    toast('该源没有给出可打开的地址', 'warn');
    return;
  }
  iabUrl.value = u;
}

/**
 * `#456` **桌面端「应用内登录」**：用内嵌真浏览器打开登录页 —— 用户在里面就地完成
 * 登录/验证码（这正是「弹起窗口输入验证码，应用内做不到」的那个缺口）。
 *
 * 回传由 `harvest()` 的**内嵌通道**负责（cookie 在 Electron partition 里，服务端读不到，
 * 见 `utils/embedded-webview.ts` 的 `embeddedHarvest`）。非桌面端 / 老桌面端不显示这个入口。
 */
const inAppAvail = computed(() => embeddedAvailable() && !!props.sourceId);

function openInAppLogin(): void {
  const u = lastUrl.value || plan.value.url || '';
  if (!u) {
    toast('该源没有给出可打开的登录地址', 'warn');
    return;
  }
  winMsg.value = '已在内嵌真浏览器里打开登录页：完成登录 / 安全验证后回到这里点「✓ 完成并保存 Cookie」即可回传。';
  openInApp(u);
}

/** 内置浏览器里点「本机 ↗」⇒ 换成真浏览器窗口（需要 Cookie 的场景） */
function onOpenExternal(url: string): void {
  iabUrl.value = '';
  void openWindow(url);
}
/** 交互式登录窗口（人工/安全验证 → Cookie 自动回传） */
const winOpen = ref(false);
const winBusy = ref(false);
const winMsg = ref('');
/** 窗口期静默回传到的 Cookie 条数（关闭窗口时用于给出结论） */
const harvested = ref(0);
/** 该源是否已有浏览器登录数据（profile 存在）——关窗后仍可复用 */
const hasProfile = ref(false);
/** 静默回传进行中（避免与手动 harvest 撞车） */
let harvestBusy = false;
let winPoll: ReturnType<typeof setInterval> | null = null;

const isAbsUrl = (s: string): boolean => /^https?:\/\//i.test(String(s ?? '').trim());

async function loadPlan(opts: { silent?: boolean } = {}): Promise<void> {
  /**
   * `#469②`（用户实测「点按钮，登录界面都会关闭一下再打开」）：模板里 `v-if="loading"` 的
   * 「读取登录方案…」与 `v-else` 的**整个登录体**（状态标签 + 全部 loginUi 行）是互斥的，
   * 所以每次重载只要把 `loading=true`，界面就会整体变成一行提示、再变回来 —— 视觉上就是
   * 「关一下又开一下」。动作完成后的**重载**（见下方 `void loadPlan({ silent: true })`）
   * 走 `silent`：不切 loading，直接在原地把新 plan / 新行贴上去（无闪断）。
   */
  if (!opts.silent) loading.value = true;
  try {
    const r = (await (await fetch(`/api/sources/${props.sourceId}/login`)).json()) as Plan;
    plan.value = r;
    fields.value = r.uiFields ?? [];
    // 表单默认值（Legado：`RowUi.default`）+ **服务端回填**（用户 2026-09-25 决策）：
    //  · 非敏感字段（设备名/接口地址…）**原样回填真值**（`plan.loginInfo`）；
    //  · 账号密码类**不下发真值**（`plan.loginInfoMasked` 只给键名）⇒ 输入框改用 placeholder
    //    提示「已保存（•），留空则不修改」，提交时留空即**不覆盖**旧值。
    const init: Record<string, string> = {};
    for (const f of fields.value) if (f.default != null && f.default !== '') init[f.name] = f.default;
    for (const [k, v] of Object.entries(r.loginInfo ?? {})) init[k] = v;
    info.value = init;
    // 服务端 `loginInfo` 刚重写了整个 `info` ⇒ 把 `upLoginData` 的界面覆盖值再叠回来
    // （否则「脚本已填好的网址」会被这次重载清掉）
    applyUpLoginData();
    savedSecretKeys.value = new Set(r.loginInfoMasked ?? []);
    lastUrl.value = r.url ?? '';
    isV2.value = r.uiV2 === true;
    if (r.kind === 'none') msg.value = '该源未配置登录';
    else if (isV2.value) {
      // v2 的行要由源脚本 `loginUi(state)` 产出来 —— 打开对话框就先渲染一次（Legado 同）
      uiState.value = '{}';
      fieldErrors.value = {};
      void post({ loginState: '{}' });
    } else if (r.uiIsScript && !fields.value.length) msg.value = '该源登录界面由脚本动态生成，直接点「登录」执行';
  } catch (e) {
    msg.value = '读取登录方案失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  await loadPlan();
  // 已在窗口中的会话要能回显；窗口已关但 profile 里有登录数据时也要提示（可复用，不必重新登录）
  try {
    const st = (await (await fetch(`/api/sources/${props.sourceId}/login/window`)).json()) as {
      open?: boolean;
      hasProfile?: boolean;
    };
    hasProfile.value = st.hasProfile === true;
    if (st.open) {
      winOpen.value = true;
      winMsg.value = '登录窗口已打开，请完成登录后点「✓ 完成并保存 Cookie」';
      startWinPoll();
    } else if (hasProfile.value) {
      winMsg.value = '该源已有浏览器登录数据（上次登录留下的）——点「打开登录窗口」会直接复用，无需重新登录';
    }
  } catch {
    /* ignore */
  }
  /**
   * 「只能靠登录页登录」的源：打开对话框即自动开登录窗口（上游 Legado `showBrowser` 语义）。
   *
   * 判据（**组件内自足，不依赖宿主传 `autoWindow`**）：`kind` 是登录页链接
   * （`url` / `config-url`）—— 这类源**除了开浏览器没有别的出路**（引擎在形态早退里
   * 直接回 `action:'browser'`，压根不跑脚本）。
   *
   * ⚠️ 有意**不**把 `plan.needBrowser` 算进来：它是**静态扫描**的提示位，`login-model.ts`
   * 与 `engine.ts` 都注明「实际是否需要浏览器由运行时错误判定」。`ui`/`js` 形的源里，
   * 浏览器 API 常在无关函数中出现（七猫实测：`startBrowser` 在别的函数里，真正报错是
   * `this.setcsh is not a function`）⇒ 一开对话框就弹浏览器会**误伤**。那类源交给
   * 运行时：脚本真调了 `startBrowserAwait` 时会返回 `action:'browser'`，我们再自动开。
   *
   * ⚠️ 修前只有 `props.autoWindow && kind=url/config-url` 自动开，而 `autoWindow` 只有
   * `DiscoverView` 传（源管理页没传）⇒ 同一个源从两个入口打开，一个自动开窗、一个要手点。
   */
  // ⚠️ `#392`：登录页型**仍然是本机窗口**，不换成内置浏览器 —— 它的目的就是拿回归登录 Cookie
  //    （`core/login-flow.ts` 的形态早退给的就是 `browserKind:'cookie'`）。想要「只看不动」的
  //    版本，下面有「在内置浏览器中查看」按钮。
  const pageOnly = plan.value.kind === 'url' || plan.value.kind === 'config-url';
  if ((props.autoWindow ?? true) && pageOnly && !winOpen.value && !winBusy.value) {
    void openWindow(plan.value.url ?? undefined);
  }
});

/**
 * `Esc` 关闭本对话框 —— 与 `#459` 的三浮层同一条用户口径：
 * **点击浮层外部不关闭，只认「关闭按钮 + Esc」**。
 *
 * 为什么要与 `#459` 的 `pushEscLayer` 分开写而不是入那套栈：本对话框**不是**整屏浮层的层叠成员
 * （它的三个宿主 = 发现页 / 源管理 / 规则工坊，都不是 `ReaderOverlay`/`PlayerOverlay`/`VDetailOverlay`），
 * 而且它下面还挂着**子层**——内置浏览器（`InAppBrowser` 自带 Esc 处理）。
 * 入栈会让「Esc 关子层还是关本层」的判据分裂成两处 ⇒ 这里用**子层开着就让位**的显式守卫
 * （`iabUrl` 非空 = 内置浏览器开着 ⇒ 不关本层），与 `esc-layer.ts` 头注里「子对话框各自处理 Esc」
 * 的同一条纪律一致。
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // 子层（内置浏览器）开着 ⇒ 让给它（它有自己的 Esc 监听；否则一次 Esc 关两层）
  if (iabUrl.value) return;
  // 焦点在输入框里 ⇒ 让给输入框自己（与 `esc-layer.ts` 的判据一致）
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
  emit('close');
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  stopWinPoll();
});
watch(
  () => props.sourceId,
  () => {
    msg.value = '';
    void loadPlan();
  },
);

/**
 * 打开登录页 —— **一律走本机登录窗口**（真 Chromium + 该源专属持久 profile）。
 *
 * ⚠️ 为什么不再用 `window.open` 新标签页：那是在**用户日常浏览器**里打开，cookie 落在用户的
 * Chrome/Edge profile 里，我们既读不到、也没法回传（用户实测反馈：「浏览器新标签页打开无法传回 cookie」）。
 * 登录窗口是我们自己启动的 Chromium，带 `--remote-debugging-port`，能经 CDP 把 cookie 读回源存储。
 */
async function openPage(url: string): Promise<void> {
  if (!url) return;
  await openWindow(url);
}

/**
 * 打开本机交互式登录窗口。
 * 适合：登录页链接、需要人工/验证码、或脚本内部 startBrowserAwait 的源。
 * 「自动回传」= 窗口开着时**每 5 秒**静默读一次 cookie（读操作**不关窗**），
 * 用户也可以随时点「✓ 完成并保存 Cookie」显式收尾。
 */
async function openWindow(url?: string): Promise<void> {
  if (winBusy.value) return;
  winBusy.value = true;
  winMsg.value = '正在启动登录窗口…';
  try {
    const r = (await (
      await fetch(`/api/sources/${props.sourceId}/login/window`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(url ? { url } : {}),
      })
    ).json()) as { ok?: boolean; url?: string; reused?: boolean; error?: string };
    if (!r.ok) {
      winMsg.value = `打开失败：${r.error ?? '未知原因'}`;
      toast(winMsg.value, 'warn');
      return;
    }
    winOpen.value = true;
    winMsg.value = r.reused
      ? `已复用该源原有的登录窗口（登录态保留）：${r.url}`
      : `登录窗口已打开：${r.url}　请在其中完成登录/安全验证（窗口不会被自动关闭）`;
    toast(r.reused ? '已复用登录窗口' : '登录窗口已打开，请在其中完成登录/验证', 'ok');
    startWinPoll();
  } catch (e) {
    winMsg.value = '打开登录窗口失败：' + (e instanceof Error ? e.message : String(e));
    toast(winMsg.value, 'error');
  } finally {
    winBusy.value = false;
  }
}

/**
 * 轮询登录窗口状态 + **周期性回传 Cookie**（读操作**不关窗**）。
 *
 * ⚠️ 两条踩过的坑（都体现在这里）：
 *  1. 「用户随手关窗 → 信息没保存」：关窗 = Chromium 进程结束、CDP 会话消失 → 之后抓不到 cookie。
 *     所以窗口开着时每 5s 静默 harvest 一次（对齐 Legado WebView 登录“随写随存”的语义）。
 *  2. 「页面还没操作完，浏览器就自动关闭」：服务端旧实现 harvest 的 finally 里顺手 `closeLoginWindow()`，
 *     于是这个 5s 轮询等于「开窗 5 秒后自动关窗」，用户根本来不及做完安全验证（腾讯漫画实测）。
 *     现在服务端 harvest **只读不关**，关窗只由显式动作触发（本文件的「✓ 完成并保存 Cookie」/「关闭窗口」）。
 */
function startWinPoll(): void {
  if (winPoll) return;
  winPoll = setInterval(() => {
    void fetch(`/api/sources/${props.sourceId}/login/window`)
      .then((x) => x.json())
      .then(async (st: { open?: boolean; hasProfile?: boolean }) => {
        if (st.hasProfile) hasProfile.value = true;
        if (!st.open) {
          if (winOpen.value) {
            winOpen.value = false;
            stopWinPoll();
            // 关窗前的那次静默 harvest 已经把 Cookie 落库；这里只提示结果
            winMsg.value = harvested.value
              ? `登录窗口已关闭；已回传 Cookie ${harvested.value} 条 ✅`
              : '登录窗口已关闭。若尚未登录成功，可重新打开窗口（会复用同一浏览器数据）或导入 Cookie。';
          }
          return;
        }
        await silentHarvest();
      })
      .catch(() => undefined);
  }, 5000);
}

/** 静默回传（不弹 toast、不关窗）：窗口开着时周期性执行，保证「随手关窗」也不丢登录态 */
async function silentHarvest(): Promise<void> {
  if (winBusy.value || harvestBusy) return;
  harvestBusy = true;
  try {
    const r = (await (
      await fetch(`/api/sources/${props.sourceId}/login/harvest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as { ok?: boolean; count?: number };
    if (r.ok && (r.count ?? 0) > 0 && (r.count ?? 0) !== harvested.value) {
      harvested.value = r.count ?? 0;
      winMsg.value = `已回传 Cookie ${harvested.value} 条（窗口关闭后仍保留）`;
      emit('changed');
    }
  } catch {
    /* 窗口未就绪 / CDP 抖动：下一轮再试 */
  } finally {
    harvestBusy = false;
  }
}

function stopWinPoll(): void {
  if (winPoll) {
    clearInterval(winPoll);
    winPoll = null;
  }
}

/**
 * 抓取窗口里的 Cookie → 写进源（人工登录的自动回传）。
 * 「✓ 完成并保存 Cookie」= harvest + **显式关窗**（profile 保留，重开即复用登录态）。
 * 若窗口已被用户手动关掉，服务端会用同一 profile 起无头实例补读一次（只能拿到持久 cookie）。
 */
async function harvest(): Promise<void> {
  if (winBusy.value) return;
  winBusy.value = true;
  winMsg.value = '正在读取 Cookie…';
  try {
    /**
     * `#456` **内嵌通道优先**：桌面端应用内登录的 cookie 在 Electron 的 `persist:src-<id>`
     * partition 里，服务端的 `/login/harvest` 读的是**另一只 Chromium 进程** ⇒ 必须先把这边
     * 的 cookie 送过去（域过滤/合并/落盘都在服务端，见 `embeddedHarvest`）。
     * 内嵌里没有 cookie（用户走的是服务端登录窗那条路）⇒ 自动回落既有 harvest，行为不变。
     */
    if (inAppAvail.value) {
      const emb = await embeddedHarvest(props.sourceId);
      if (emb.ok) {
        harvested.value = emb.count ?? 0;
        winMsg.value = `✅ 已从内嵌浏览器回传 ${harvested.value} 条 Cookie：${(emb.picked ?? []).slice(0, 6).join('、')}`;
        toast(`已回传 ${harvested.value} 条 Cookie`, 'ok');
        emit('changed');
        void loadPlan();
        return;
      }
      // 「内嵌里还没登录」不算失败（要回落服务端通路）；真失败才说清楚
      if (emb.error && emb.error !== 'NO_COOKIES' && emb.message) winMsg.value = emb.message;
    }
    const r = (await (
      await fetch(`/api/sources/${props.sourceId}/login/harvest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json()) as {
      ok?: boolean; count?: number; picked?: string[]; error?: string; message?: string; fromProfile?: boolean;
    };
    if (r.ok) {
      winMsg.value = `✅ 已回传 ${r.count ?? 0} 条 Cookie：${(r.picked ?? []).slice(0, 6).join('、')}${
        r.fromProfile ? '（窗口已关闭，从该源浏览器数据里补读）' : ''
      }`;
      toast(`已回传 ${r.count ?? 0} 条 Cookie`, 'ok');
      emit('changed');
      void loadPlan();
      await closeWindow(true); // 显式收尾：关窗但保留 profile
      winMsg.value += '　窗口已关闭（登录态保留，下次「打开登录窗口」直接复用）';
    } else {
      winMsg.value = r.error ?? r.message ?? '没有取到匹配的 Cookie';
      toast(winMsg.value, 'warn');
    }
  } catch (e) {
    winMsg.value = '读取 Cookie 失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    winBusy.value = false;
  }
}

/** 关闭窗口（`silent`= 不覆盖已有提示文案） */
async function closeWindow(silent = false): Promise<void> {
  if (!silent) await silentHarvest();
  try {
    await fetch(`/api/sources/${props.sourceId}/login/window`, { method: 'DELETE' });
  } catch {
    /* ignore */
  }
  winOpen.value = false;
  stopWinPoll();
  if (!silent) winMsg.value = '已关闭登录窗口（登录态保留在源专属浏览器数据里）';
}

/** 清除该源的浏览器登录数据（删 profile；下次需重新登录） */
async function clearBrowserData(): Promise<void> {
  if (winBusy.value) return;
  winBusy.value = true;
  try {
    const r = (await (
      await fetch(`/api/sources/${props.sourceId}/login/browser-data`, { method: 'DELETE' })
    ).json()) as { removed?: boolean };
    winOpen.value = false;
    stopWinPoll();
    harvested.value = 0;
    winMsg.value = r.removed ? '已清除该源的浏览器登录数据（Cookie 存储里的登录态未动，可另点「清除登录」）' : '该源没有浏览器登录数据';
  } catch (e) {
    winMsg.value = '清除失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    winBusy.value = false;
  }
}

/**
 * 表单当前值（Legado `SourceLoginDialog.kt:811-824 getLoginData(rowUis)`）：
 * **每个 text/password 行都取**，空文本存空字符串（而不是删键）；服务端 `setSourceLoginInfo`
 * 会与已存信息**合并**，所以只填一部分字段不会清掉其它键。
 */
/** 行的存储键：**v2 用 `key`**（Legado `RowUi.key`）、v1 用 `name` */
function fieldKey(f: LoginField): string {
  return String(f.key ?? f.name ?? '');
}

/**
 * 登录行的 flex 布局（对齐 Legado `RowUi.style()` → `FlexChildStyle.apply`）。
 *
 * ★ 上游把**所有行**（text / password / select / button / toggle / label）都 addView 进
 *   **同一个 `FlexboxLayout`**（`SourceLoginDialog.kt:316/374/488/504/569` 全是 `binding.flexbox.addView`），
 *   每行按自己的 `style()` 决定占比。源作者就是用 `layout_flexBasisPercent` 表达排版的：
 *     · `1`    → 整行（如「点击切换分流」「每周必看索引」这类分隔标题）
 *     · `0.25` → 一行 4 个（时间/阅读/最爱/收藏）
 *     · `0.2`  → 一行 5 个（重置/随机/+1/-1）
 *     · `0.3`  → 一行约 3 个
 *
 * ⚠️ 本仓此前**完全丢弃** `flexBasisPercent`，把所有 button 抽进独立的 `.lg-actions` 等宽平铺
 *   ⇒ 用户报的「按钮/输入框没有按 loginUi 排列」。现在改成单一 flex 容器 + 每行 basis。
 *
 * 实现抽到 `utils/login-layout.ts`（判据唯一实现 + 可加回归锁，见项目铁律）。
 */
const rowStyle = loginRowStyle;
const isRowFull = isLoginRowFull;

function currentFormValues(opts: { skipUnchangedSecret?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields.value) {
    const k = fieldKey(f);
    if (!k) continue;
    // 「留空＝不修改」：服务端回填过（savedSecretKeys）的敏感字段，用户没输入就不发送 ——
    // 否则发空串会把服务端已存的密码**覆盖成空**（`setSourceLoginInfo` 是合并语义，
    // 但空串是合法值，会真的覆盖）。仅 v1 通道启用；v2 的值由源脚本自己解释，不改其语义。
    if (opts.skipUnchangedSecret && savedSecretKeys.value.has(k) && !String(info.value[k] ?? '').trim()) continue;
    if (f.type === 'text' || f.type === 'password' || f.type === 'select') out[k] = info.value[k] ?? '';
    // toggle 落的是 `chars[1]/chars[0]`（不是 'true'/'false'）—— 见 utils/login-toggle.ts 的缺陷类别
    else if (f.type === 'toggle') out[k] = toggleValueFor(f, isToggleOn(f, info.value[k] ?? f.value ?? f.default));
  }
  return out;
}

/** v2：toggle 行的勾选（Legado：改变即派发它的 action）。落盘值 = `chars` 里那个字符 */
function onToggleChange(f: LoginField, ev: Event): void {
  const k = fieldKey(f);
  const on = (ev.target as HTMLInputElement).checked;
  info.value = { ...info.value, [k]: toggleValueFor(f, on) };
  if (f.action) void runField(f);
}

/** v2：按钮倒计时（Legado `SourceLoginV2Delegate.startCountdown`：按钮文案 `名称 (Ns)` 且禁用） */
function startCountdown(action: string, seconds: number): void {
  const old = countdownTimers.get(action);
  if (old) clearInterval(old);
  countdown.value = { ...countdown.value, [action]: seconds };
  const timer = setInterval(() => {
    const left = (countdown.value[action] ?? 1) - 1;
    if (left <= 0) {
      clearInterval(timer);
      countdownTimers.delete(action);
      const next = { ...countdown.value };
      delete next[action];
      countdown.value = next;
    } else {
      countdown.value = { ...countdown.value, [action]: left };
    }
  }, 1000);
  countdownTimers.set(action, timer);
}

/**
 * 提交表单登录（`result` = 登录信息 map，Legado `getLoginData`）。
 *
 * ⚠️ **它只服务 v1**。LoginUiV2 里**没有**这个「全局提交」按钮 ——
 * Legado `SourceLoginDialog.kt` 明确写着 `binding.toolBar.menu.findItem(R.id.menu_ok)?.isVisible
 * = !isLoginUiV2`：v2 的每个动作都由**行自己的 `action`** 驱动（`loginAction(action, state, form)`），
 * 表单值随每个动作一起发（见 `runField` / `onToggleChange`）。
 *
 * 所以模板里那个按钮 `v-if="!isV2"`、这里也没有 v2 分支 ——
 * 修前它是一段**永远跑不通**的代码（引用了不存在的 `action` / `f`，一点就抛 ReferenceError）。
 */
async function submit(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  msg.value = '';
  fieldErrors.value = {};
  try {
    const body: Record<string, unknown> = {};
    const payload = currentFormValues({ skipUnchangedSecret: true });
    if (Object.keys(payload).length) body['info'] = payload;
    await post(body);
  } finally {
    busy.value = false;
  }
}

/**
 * 点击 loginUi 的按钮/开关行（Legado `handleButtonClick`，`SourceLoginDialog.kt:785-809`）。
 *
 * ⚠️ Legado 会把**表单当前值**作为 `result` 一起传给按钮脚本（`put("result", getLoginData(rowUis))`）——
 * 源里的按钮函数常写 `result.账号` / `result.密码`。此前我们只发 `{action}`，
 * 脚本读不到用户刚填的内容（按钮「点了没反应」的真因之一）。这里连同 `info` 一起发：
 * 服务端既把它作为脚本 `result`，也顺手落库（避免「填了没保存」）。
 *
 * ⚠️ **v1 / v2 的通道不同**（见函数内的分支与注释）：v1 发 `info`；**v2 必须发
 * `loginState` + `loginForm`**（Legado `evalLoginActionV2(action, stateJson, formJson)`）。
 */
async function runField(f: LoginField): Promise<void> {
  const action = String(f.action ?? '').trim();
  if (isAbsUrl(action)) {
    openPage(action);
    return;
  }
  if (!action) {
    msg.value = `「${f.name}」没有配置动作`;
    toast(msg.value, 'warn');
    return;
  }
  if (busy.value) return;
  busy.value = true;
  msg.value = '';
  try {
    const vals = currentFormValues();
    /**
     * ★★ **v2 的动作必须带三个参数**（Legado `SourceLoginV2Delegate.dispatch`：
     * `source.evalLoginActionV2(action, stateJson, formJson)`）：
     *   · `action` —— 行的动作名（引擎 `loginAction(__loginAction, …)` 的第一参）；
     *   · `loginState` —— **会话状态**，源脚本每次动作**可以换一个新的**，必须原样回传
     *     （多步登录全靠它，如「先发验证码 → 再填码」）；
     *   · `loginForm` —— 表单快照，脚本里常写 `form.账号`。
     *
     * 修前这里只发 `{action, info}` ⇒ 引擎拿到的是 `stateIn='{}'` / `formIn='{}'`
     * （`engine.ts:3181-3182` 的缺省），**多步登录会在第二步断掉、脚本读不到用户刚填的值**。
     * v1 仍走 `info`（v1 的语义就是「表单值直接落 loginInfo」），两条通道不能混。
     */
    if (isV2.value) {
      await post({ action, loginState: uiState.value, loginForm: JSON.stringify(vals) });
      // Legado `startCountdown`：只在**没有字段错误**时开始倒计时（否则用户要能立刻改完重试）
      const cd = Number(f.countdown ?? 0);
      if (cd > 0 && !Object.keys(fieldErrors.value).length) startCountdown(action, cd);
    } else {
      await post({ action, ...(Object.keys(vals).length ? { info: vals } : {}) });
    }
  } finally {
    busy.value = false;
  }
}

/**
 * 执行登录动作并给出**双通道反馈**：
 *  ① 对话框内一行状态文字（msg，保持原有行为）；
 *  ② 全局 toast —— 源脚本自己 `java.toast/longToast` 的原话优先（服务端在 `r.toasts` 回传），
 *     其次才是引擎/UI 的结论。禁漫天堂那类「按钮只改源变量」的源，反馈全在 toast 里。
 */
async function post(body: Record<string, unknown>): Promise<void> {
  try {
    const r = (await (
      await fetch(`/api/sources/${props.sourceId}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as LoginResult;
    if (r.fields?.length) fields.value = r.fields;
    if (r.uiV2) {
      isV2.value = true;
      if (r.loginState != null) uiState.value = r.loginState;
      fieldErrors.value = r.fieldErrors ?? {};
      if (r.hasLoginInfo) v2LoggedIn.value = true;
    }
    /**
     * 脚本自己弹的 toast：**逐条**弹，并且走**底部 Android 通道**（`androidToast`）——
     * 这就是用户 2026-10-15 追问「为什么有时候在屏幕中间下方、有时候在右上角」的答案：
     *  · 源脚本的 `java.toast` / `java.longToast`（发现页/搜索/正文/聚合搜索走 `runAction` 与 SSE）
     *    一律落 `android-toast.ts` → `<AndroidToastHost>`（**页面底部居中、向下渐隐**，用户当初点名的 Android 形态）；
     *  · `toast.ts` → `<ToastHost>`（右上角卡片）是**应用自己**的反馈（保存成功 / Cookie 已回传 …）。
     * 本对话框此前把脚本 toast 混进了「应用反馈」通道 ⇒ 同一个源脚本的话在这里右上角、在发现页底部
     * ⇒ 已按同一口径归位（脚本 toast 只走 Android 通道；应用反馈仍走右上角）。
     *
     * ⚠️ 不再做「一批只弹最后一条」：那会吞掉错误信息（用户明确否决，按原正常 toast 通路逐条走）。
     */
    const said = (r.toasts ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
    for (const t of said) androidToast(t);
    // `java.upLoginData` **实时回填**（上游 `handleUpUiData`：只改 UI、不落库）。
    // ⚠️ 必须记下来：`post()` 走完后还会 `loadPlan()` 重新拉一次 plan，而它会用服务端
    // `loginInfo` 重写整个 `info` ⇒ 不记住这份「UI 值」就会被重载冲掉（用户实测「toast 说已填写、
    // 重新检测后输入框又空了」）。见 `loadPlan()` 末尾的二次回填。
    if (r.loginData) {
      upLoginData.value = { ...(upLoginData.value ?? {}), ...r.loginData };
      applyUpLoginData();
    }
    // ── LoginUiV2：结果由**命令**决定（state/error/login/close），不是「跑完就成功」 ──
    if (r.uiV2) {
      if (r.close) {
        msg.value = r.message ?? '登录流程已关闭';
        emit('changed');
        emit('close');
        return;
      }
      msg.value = r.message ?? (r.ok ? '已执行' : '未能完成');
      if (!said.length) toast(msg.value, r.ok ? 'ok' : 'warn');
      emit('changed');
      return;
    }
    /**
     * 服务端/引擎判定「这个登录必须用真浏览器」⇒ `action:'browser'` + 登录页 URL。
     *
     * 两种来源：① `kind=url/config-url` 的形态早退（`core/login-flow.ts`）；
     * ② 脚本运行时调用了 `startBrowserAwait/webView`（`engine.ts` 读 `__browserUrl`）
     *    或抛出了指向浏览器 API 的错误（`needBrowserFromError`）。
     *
     * ⚠️ 修前这里只 `lastUrl → toast` 提示，**不打开窗口** —— 用户按提示去找「打开登录窗口」
     * 按钮；而 `kind=url` 的源本来在 `autoWindow` 时是自动开的，走脚本路径的却要手点，
     * 行为不一致（上游 Legado 是 `showBrowser(url)` 直接弹）。这里统一成**自动打开**。
     */
    if (r.action === 'browser' && r.url) {
      lastUrl.value = r.url;
      /**
       * `#392` **两种浏览器分道**（判据来自引擎 `UnifiedLoginResult.browserKind`，前端**不猜**）：
       *  · `show`   → **应用内极简浏览器**：`java.startBrowser` 打开的是「给人看」的页面
       *               （密钥 / 发布页 / 源作者内联的 `data:text/html;base64` 更新页）。
       *               只有应用内才点得动页面里的「导入书源」—— 外部浏览器点了没用。
       *  · `cookie` → **本机真浏览器**（服务端 Chromium + CDP 回传）：脚本在等浏览器里的结果。
       *               跨域站点的 Cookie 取不回服务端，内置 iframe 做不到（安全模型，不是取舍）。
       * 缺省（旧引擎 / 未标注）按 `cookie` 走 —— 与 core 契约的缺省一致（保守，不猜）。
       */
      if (r.browserKind === 'show') {
        msg.value = r.message ? `${r.message}（已在内置浏览器打开；页面里的「导入书源」可直接点）` : '已在内置浏览器打开';
        toast('已在内置浏览器打开', 'info');
        openInApp(r.url);
        return;
      }
      msg.value = `${r.message ?? '需要浏览器'}（正在打开登录窗口）`;
      toast(msg.value, 'warn');
      // 打开失败时 openWindow 自己会 toast，这里不再补提示
      if (!winOpen.value && !winBusy.value) void openWindow(r.url);
      return;
    }
    if (r.ok) {
      /**
       * `#354` **区分两种成功**：
       *  · 真的登录成功（本次**新写了** Cookie / 登录头 / 登录信息）→ 「✅ 登录成功(N 条 Cookie)」；
       *  · 「只改源变量」的按钮动作（禁漫天堂的线路/分流切换：引擎判 `ok:true` 依据是
       *    `actionOk = !!loginAction`，即「点了按钮脚本跑通」）→ 显示「✅ 登录成功」是错的，
       *    用户会以为在登录，实际只是切了线路。这类必须用**源作者自己的 toast 原话**
       *    （含「已切换 (2/2)…请刷新探索页」），并按 `emit('changed')` 让宿主重算分类。
       *
       *  判据（`#397` 唯一）：`wroteLoginState` = 引擎回报的**本次 delta**（Cookie/登录头/loginInfo
       *  是否真的被这次运行改写）。⚠️ 不能拿 `hasLoginInfo`/`count` 判 —— 那是**当前状态**：
       *  ˃̶͈ ꇴ ˂̶͈ 的 TD()/setzt() 每次按钮都重写「密钥」loginInfo、会话 jar 里可能已有 Cookie
       *  ⇒ 纯动作按钮（「书源更新」「点击试试」）被误报成「登录成功」。
       *  旧服务端没有该字段时回退旧判据（count/loginHeader）。
       */
      const wrote =
        r.wroteLoginState ?? Boolean(r.count || r.loginHeader);
      const onlySourceVars = !!String(body['action'] ?? '').trim() && !wrote;
      msg.value = onlySourceVars
        ? (said.at(-1) ?? '按钮动作已执行')
        : /**
           * `#469①`：无 `action`（=「保存并登录」）且本次**没有真的写登录态**时，引擎可能带回
           * 明确文案（如「该源没有 login() 登录脚本：已保存现有登录信息（如有）并关闭」）——
           * 这时不要套用「✅ 登录成功」误导用户（那只有真登进去才该说）。
           */
          (r.message && !wrote ? r.message : `✅ 登录成功${r.count ? `（Cookie ${r.count} 条）` : ''}`);
      // 有脚本 toast 时不再重复弹结论（避免「已切换分流」+「✅ 登录成功」两条并存造成误解）
      if (!said.length) toast(msg.value, 'ok');
      // 只改源变量的按钮动作：宿主（发现页）据此重算分类 —— 用户「返回」即见新线路的分类
      emit('changed');
      void loadPlan({ silent: true }); // `#469②`：原地重贴新 plan（不切 loading ⇒ 不再「关一下又开一下」）
      /**
       * ★ **「✓ 保存并登录」成功即关窗**（对齐上游 `SourceLoginDialog.kt:832-862` 的 `login()`）：
       * ```
       *   source.putLoginInfo(json)            // 表单值先落库
       *   … runScript(loginJs + login.apply(this)) …
       *   toastOnUi(R.string.success); dismiss()      // ← 成功就 toast + 关窗
       * （失败/抛错 ⇒ 只 toast「登录出错」，**不关**，把对话框留给用户改）
       * ```
       * 判据：本次**没有** `action`（= 这是那个全局 ✓ 按钮，而不是某个行按钮）。
       * 行按钮**不能**关 —— 用户可能还要接着点别的行（禁漫天堂切线路、本源的「密钥」等）。
       */
      if (!String(body['action'] ?? '').trim()) {
        emit('close');
        return;
      }
      return;
    }
    msg.value = r.message ?? r.error ?? '登录未完成';
    if (!said.length) toast(msg.value, 'warn');
  } catch (e) {
    msg.value = '登录请求失败：' + (e instanceof Error ? e.message : String(e));
    toast(msg.value, 'error');
  }
}

/** 清除登录（Legado 工具栏「清除登录信息」：登录信息 + 登录头 + Cookie） */
async function clearLogin(): Promise<void> {
  try {
    await fetch(`/api/sources/${props.sourceId}/login`, { method: 'DELETE' });
    msg.value = '已清除登录信息、登录头与 Cookie';
    toast(msg.value, 'ok');
    emit('changed');
    void loadPlan();
  } catch (e) {
    msg.value = '清除失败：' + (e instanceof Error ? e.message : String(e));
    toast(msg.value, 'error');
  }
}

defineExpose({ loadPlan });
</script>

<template>
  <div class="lg-mask">
    <div class="lg-panel card">
      <div class="lg-head">
        <h4>登录 · {{ sourceName || sourceId }}</h4>
        <button class="btn sm" @click="emit('close')">关闭</button>
      </div>

      <div v-if="loading" class="lg-hint">读取登录方案…</div>
      <template v-else>
        <div class="lg-state">
          <span class="tag" :class="{ acc: plan.hasCookie || plan.hasLoginInfo }">
            {{ plan.hasCookie || plan.hasLoginInfo || v2LoggedIn ? '已登录' : '未登录' }}
          </span>
          <span v-if="plan.cookieCount" class="tag">Cookie {{ plan.cookieCount }}</span>
          <span v-if="plan.loginInfoKeys?.length" class="tag">信息：{{ plan.loginInfoKeys.join('/') }}</span>
          <span v-if="plan.loginHeaderKeys?.length" class="tag">登录头：{{ plan.loginHeaderKeys.join('/') }}</span>
          <span class="tag">形态：{{ plan.kind }}</span>
        </div>

        <!--
          loginUi 行区：**单一 flex 容器按 order 渲染**（对齐 Legado `binding.flexbox`）。
          每行用 `rowStyle()` 落地自己的 `layout_flexBasisPercent / flexGrow`。
          ⚠️ 不要按 type 分组（「先表单后按钮」）——那正是源作者排版意图丢失的原因：
             禁漫天堂的「点击切换分流」是 button 但 flexBasisPercent=1 的**分隔标题**，
             它必须插在上一组按钮之后、下一组之前。
        -->
        <div v-if="fields.length" class="lg-flex">
          <template v-for="f in fields" :key="fieldKey(f) || f.name">
            <!-- 表单行：text/password/select（v2 用 key 作存储键；v1 用 name） -->
            <div
              v-if="f.type === 'text' || f.type === 'password' || f.type === 'select'"
              class="lg-cell lg-row"
              :class="{ full: isRowFull(f) }"
              :style="rowStyle(f)"
            >
              <label class="lg-label">{{ f.name }}</label>
              <!--
                `#311` 选项来源 = **`chars`**（上游 `SourceLoginDialog.kt:429-482` 的 `Type.select` 分支：
                `val chars = rowUi.chars?.filterNotNull() ?: listOf("chars","is null")`，
                选项列表与提交值都用 `chars[position]`）。
                ⚠️ 本仓此前读的是 `f.options` —— 那个字段只在类型里声明过，
                **服务端/脚本从来不产出它**（`engine-legado/src/model/login.ts` 的
                `normalizeLoginField` 只把 `options` 当独立字段读，而 legado 源里写的是 `chars`）
                ⇒ 下拉框恒为 0 个选项。这正是用户报的「登录页，下拉列表未正确展开列表项」。
                `options` 保留为兜底（类型里仍声明着，供 v2 脚本产出的行使用）。
              -->
              <select v-if="f.type === 'select'" class="lg-input" v-model="info[fieldKey(f)]">
                <option v-for="o in (f.chars ?? f.options ?? [])" :key="o" :value="o">{{ o }}</option>
              </select>
              <input
                v-else
                class="lg-input"
                :class="{ 'lg-input-err': !!fieldErrors[fieldKey(f)] }"
                :type="f.type === 'password' ? 'password' : 'text'"
                :placeholder="savedSecretKeys.has(fieldKey(f)) ? '已保存（•），留空则不修改' : f.hint || f.default || ''"
                v-model="info[fieldKey(f)]"
              />
            </div>
            <!-- v2 说明行（label）：只显示文字，不参与提交 -->
            <div v-else-if="f.type === 'label'" class="lg-cell lg-row lg-note full" :style="rowStyle(f)">
              {{ f.name }}
            </div>
            <!-- v2 开关行（toggle）：改变即派发 action -->
            <div v-else-if="f.type === 'toggle'" class="lg-cell lg-row" :class="{ full: isRowFull(f) }" :style="rowStyle(f)">
              <label class="lg-label">{{ f.name }}</label>
              <label class="lg-note" style="cursor: pointer">
                <input
                  type="checkbox"
                  :checked="isToggleOn(f, info[fieldKey(f)] ?? f.value ?? f.default)"
                  @change="onToggleChange(f, $event)"
                />
                已开启
              </label>
            </div>
            <!-- 动作行（button；v2 支持 countdown 倒计时） -->
            <button
              v-else-if="f.type === 'button'"
              class="btn sm lg-cell lg-btn"
              :class="{ full: isRowFull(f) }"
              :style="rowStyle(f)"
              :disabled="busy || (countdown[String(f.action ?? '')] ?? 0) > 0"
              :title="f.action || ''"
              @click="runField(f)"
            >
              {{ f.name
              }}<span v-if="countdown[String(f.action ?? '')]"> ({{ countdown[String(f.action ?? '')] }}s)</span
              >{{ isAbsUrl(String(f.action ?? '')) ? ' ↗' : '' }}
            </button>
            <div v-if="fieldErrors[fieldKey(f)]" class="lg-cell lg-row lg-err full" :style="rowStyle(f)">
              {{ fieldErrors[fieldKey(f)] }}
            </div>
          </template>
        </div>

        <!-- 登录窗口（人工/安全验证 → Cookie 自动回传）：登录页型的源主打这条路 -->
        <div class="lg-win" :class="{ primary: plan.kind === 'url' || plan.kind === 'config-url' }">
          <div class="lg-win-head">
            <b>登录窗口</b>
            <span class="lg-win-sub">
              在本机打开真浏览器（该源<b>专属</b>浏览器数据，不影响你日常浏览器；关窗/重启都不丢登录态），
              完成登录/验证码后 Cookie 自动回传
            </span>
          </div>
          <div class="lg-foot">
            <button class="btn sm primary" :disabled="winBusy" @click="openWindow(lastUrl || plan.url || undefined)">
              {{ winOpen ? '回到登录窗口 ↗' : hasProfile ? '打开登录窗口（复用上次登录）↗' : '打开登录窗口 ↗' }}
            </button>
            <!-- `#392`：同一地址的「只读」入口 —— 应用内浏览器（前进/后退/刷新 + 导入桥） -->
            <button
              v-if="lastUrl || plan.url"
              class="btn sm"
              title="应用内打开（可前进/后退/刷新；页面里的「导入书源」可点）"
              @click="openInApp(lastUrl || plan.url)"
            >
              内置浏览器打开
            </button>
            <!-- `#456` 桌面端「应用内登录」：真浏览器就地过关（验证码不用切窗口），完成后用下面那颗回传 -->
            <button
              v-if="inAppAvail && (lastUrl || plan.url)"
              class="btn sm"
              title="在应用内用真浏览器打开登录页（就地完成登录/验证码），登录完成后点「✓ 完成并保存 Cookie」回传"
              @click="openInAppLogin"
            >
              应用内登录（真浏览器）
            </button>
            <button v-if="winOpen || inAppAvail" class="btn sm acc" :disabled="winBusy" @click="harvest">✓ 完成并保存 Cookie</button>
            <button v-if="winOpen" class="btn sm" :disabled="winBusy" @click="closeWindow(false)">关闭窗口</button>
            <button v-if="!winOpen && hasProfile" class="btn sm" :disabled="winBusy" @click="clearBrowserData">清除浏览器数据</button>
            <span v-if="winOpen" class="tag acc">窗口已打开</span>
            <span v-else-if="hasProfile" class="tag">有登录数据</span>
          </div>
          <div v-if="winMsg" class="lg-hint">{{ winMsg }}</div>
        </div>

        <div class="lg-foot">
          <!-- LoginUiV2 **没有**这个全局提交按钮（Legado：`menu_ok.isVisible = !isLoginUiV2`）——
               v2 的每个动作由表单里自己的按钮/开关行驱动，见 `submit()` 的注释 -->
          <button v-if="!isV2" class="btn sm primary" :disabled="busy" @click="submit">
            {{ busy ? '⟳ 处理中…' : plan.hasLoginScript ? '✓ 保存并登录' : '✓ 保存登录信息' }}
          </button>
          <span v-else class="tag">该源用「登录UI v2」：请按上面的按钮/开关操作</span>
          <button v-if="lastUrl" class="btn sm" @click="openPage(lastUrl)">登录页在登录窗口打开 ↗</button>
          <button class="btn sm" :disabled="busy" @click="loadPlan()">重新检测</button>
          <button class="btn sm" :disabled="busy" @click="clearLogin">清除登录</button>
        </div>

        <div v-if="msg" class="lg-hint">{{ msg }}</div>
        <div class="lg-tip">
          说明：<b>✓ 保存并登录</b> 对齐 Legado 登录对话框的「✓」—— 先**保存**表单里的账号/密码
          （只填一部分不会清掉其它已存字段），源里有 `login()` 脚本时再执行它；
          源没有登录脚本时该按钮就是纯「保存登录信息」（值供规则里的 `getLoginInfo()` 使用）。<br />
          <b>内置浏览器打开</b>用于「给人看」的页面（源作者的密钥页 / 发布页 / 更新页）——
          可前进/后退/刷新，页面里的「导入书源」点了就生效（外部浏览器点了没用）。<br />
          <b>登录窗口</b>解决人工登录/验证码 —— 本机真浏览器打开登录页，<b>窗口不会被自动关闭</b>；
          只要窗口开着就每 5 秒自动把 Cookie 回传一次，也可以点「✓ 完成并保存 Cookie」手动收尾。<br />
          该源有专属的浏览器数据目录：<b>关掉窗口、甚至重启服务都不丢登录态</b>，
          再点「打开登录窗口」会复用同一只浏览器继续登录（不会再弹一个需要重新登录的新窗口）。<br />
          <b>为什么不在你日常浏览器的新标签页打开</b>：那样 Cookie 落在你自己的浏览器 profile 里，
          我们既读不到也无法回传；所有登录页统一在本机登录窗口打开，才能自动回传。
        </div>
      </template>
    </div>

    <!-- `#392` 应用内极简浏览器（自带遮罩 + 更高 z-index ⇒ 盖在登录对话框之上）
         `#453`：带上 `source-id` —— 桌面端有真 view 时用它渲染（与源的登录态共用同一 partition） -->
    <InAppBrowser
      v-if="iabUrl"
      :url="iabUrl"
      :title="sourceName"
      :source-id="sourceId"
      @close="iabUrl = ''"
      @open-external="onOpenExternal"
    />
  </div>
</template>

<style scoped>
.lg-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35);
  display: flex; align-items: center; justify-content: center; z-index: 60;
}
.lg-panel { width: min(560px, 92vw); max-height: 84vh; overflow: auto; padding: 16px 18px; background: var(--bg); }
.lg-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.lg-head h4 { margin: 0; font-size: 14px; }
.lg-state { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
/*
 * loginUi 行区：**单一 flex 容器**（对齐 Legado `FlexboxLayout`）。
 * — 行宽由每行的 `flex-basis`（来自 `layout_flexBasisPercent`）决定，见 `rowStyle()`；
 * — `.full` 是「整行」行的兜底（表单控件与分隔标题）；
 * — 行内间距用 gap，不再靠每个元素的 margin 拼。
 */
.lg-flex { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.lg-cell { min-width: 0; }
.lg-flex > .full { flex: 1 1 100%; max-width: 100%; }
.lg-row { display: flex; align-items: center; gap: 10px; }
/* 按钮：不带 style 时按内容宽（基数是内容），带 basis 时由 inline style 覆盖 */
.lg-btn { flex: 0 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lg-label { flex: 0 0 auto; min-width: 62px; color: var(--muted); font-size: 12.5px; }
/* LoginUiV2：说明行 / 字段级错误 / 出错输入框 */
.lg-note { color: var(--muted); font-size: 12.5px; }
.lg-err { color: var(--red, #e5534b); font-size: 12.5px; padding-left: 72px; }
.lg-input-err { border-color: var(--red, #e5534b) !important; }
.lg-input {
  flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg); color: var(--fg); font-size: 13px;
}
.lg-foot { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.lg-win {
  margin-top: 12px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 8px;
  background: color-mix(in srgb, var(--bg) 92%, var(--fg) 8%);
}
.lg-win.primary { border-style: solid; border-color: var(--green); }
.lg-win-head { display: flex; flex-direction: column; gap: 4px; }
.lg-win-head b { font-size: 13px; }
.lg-win-sub { font-size: 11.5px; color: var(--muted); line-height: 1.6; }
.lg-hint { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.6; word-break: break-all; }
.lg-tip { margin-top: 10px; font-size: 11.5px; color: var(--muted); line-height: 1.7; border-top: 1px dashed var(--border); padding-top: 8px; }
</style>
