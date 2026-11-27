<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import { useReaderStore } from './stores/reader';
// 全局 Toast 宿主（源登录按钮等操作的反馈出口，见 src/toast.ts）
import ToastHost from './components/ToastHost.vue';
// Android 风格 Toast 宿主（源脚本 `java.toast` / `java.longToast` 的原话，见 src/android-toast.ts）
import AndroidToastHost from './components/AndroidToastHost.vue';
// 全局文本 Tooltip（`data-tip` 驱动；长章节名/集数名被截断时悬停看全名，见组件注释）
import HoverTip from './components/HoverTip.vue';
// `#482` 内嵌验证浮层（撞 CF/验证码时不弹独立 Chrome，在页面里过）
import VerificationOverlay from './components/VerificationOverlay.vue';
// `#740` 纯 Web 端验证码浮层（`java.getVerificationCode` 的看图填码，独立通道）
import VerifyCodeOverlay from './components/VerifyCodeOverlay.vue';
import { registerVerificationOpener, type VerificationRequest } from './utils/verification-gate';
// `#740` 验证码认领：Web 与桌面端各带 consumer，先认领者独占（不双开窗口）
import { claimVerifyCode, verifyCodePending } from './api';
import { pickClaimTarget, type VerifyCodeMeta } from './utils/verify-code';
import { isDesktop, toggleFullscreen } from './desktop';
// `#552` 巡检播报的出口（带「详情」一跳的那条，见 toast.ts 的 ToastAction）
import { toast } from './toast';

const reader = useReaderStore();

/**
 * `#482` 验证浮层的**全局宿主**。
 *
 * 为什么挂在这里（而不是发现页/阅读页各自弹）：撞 CF 的不止发现页 —— 详情页、目录页、
 * 正文页都会撞（`antibot-replay` 是引擎的**每一跳**都过）。放在 App 上任何 `runAction`
 * 都能用同一扇门（去重见 `utils/verification-gate.ts`），不必在每个页面重复接一遍。
 */
const vfReq = ref<VerificationRequest | null>(null);
let vfDone: ((ok: boolean) => void) | null = null;

/**
 * `#740` **纯 Web 端验证码浮层**的宿主轮询。
 *
 * 为什么在 App 上轮询：验证码请求是「脚本在后台发出的」，前端没有任何动作能触发它
 * （不像 CF 挑战有 `needVerification` 随响应回来），只能定时问服务端有没有 pending。
 *
 * 为什么桌面端不轮询：Electron 主进程（`apps/desktop/main.js`）已经在轮询并开
 * 独立 `BrowserWindow`；Web 再轮询会**双开窗口**。两端通过 `consumer` 认领互斥，
 * 这里再用 `isDesktop()` 直接跳过（少一轮无意义的请求）。
 */
const vcReq = ref<VerifyCodeMeta | null>(null);
let vcPollTimer: ReturnType<typeof setInterval> | null = null;
let vcPollBusy = false;

async function pollVerifyCodes(): Promise<void> {
  if (vcReq.value || vcPollBusy) return;
  vcPollBusy = true;
  try {
    const pending = await verifyCodePending('web');
    const target = pickClaimTarget(pending, '', 'web');
    if (!target) return;
    // 认领失败 = 桌面端已抢占（或请求已结束）⇒ 不弹窗，下一拍再看
    const r = await claimVerifyCode(target.id, 'web');
    if (r.ok) vcReq.value = target;
  } catch {
    /* 服务端没起 / 网络不通：下一拍再看 */
  } finally {
    vcPollBusy = false;
  }
}

function stopVerifyCodePoll(): void {
  if (vcPollTimer) clearInterval(vcPollTimer);
  vcPollTimer = null;
}

/**
 * `#552` **源医生巡检播报**（服务端定时跑，前端来取）。
 *
 * 为什么是**轮询**而不是服务端推送：toast 通道是「请求内」的（`ctx.toastSink` 随响应回传），
 * 服务端**没有**主动推前端的路；为一条每 6h 才有的播报新建常驻 SSE 不划算。
 * 代价只有一个 —— 同一条会重复弹 ⇒ 用 `since` 游标消掉：
 * 服务端只在 `at > since` 时回 `toast`，前端把消费过的 `at` 记在 localStorage
 * （跨刷新也不重复弹；换设备/清缓存 ⇒ 重新弹一次，可接受）。
 *
 * 失败**不打扰**：巡检播报是锦上添花，服务端没起/接口不通时静默，绝不能用 toast 报「巡检挂了」。
 */
const PATROL_SEEN_KEY = 'yuedu.doctorPatrolSeenAt';
const PATROL_POLL_MS = 5 * 60 * 1000;
let patrolTimer: ReturnType<typeof setInterval> | null = null;
async function pollDoctorPatrol(): Promise<void> {
  try {
    const seen = Number(localStorage.getItem(PATROL_SEEN_KEY) ?? '0');
    const r = await fetch(`/api/doctor/patrol${seen > 0 ? `?since=${seen}` : ''}`);
    if (!r.ok) return;
    const j = (await r.json()) as {
      at?: number | null;
      toast?: { text: string; level: 'warn' | 'ok' } | null;
      disabled?: boolean;
    };
    if (j.disabled) return; // 用户关了巡检 ⇒ 安静
    if (typeof j.at === 'number' && j.at > 0) localStorage.setItem(PATROL_SEEN_KEY, String(j.at));
    if (j.toast) {
      toast(j.toast.text, j.toast.level === 'ok' ? 'ok' : 'warn', 8_000, {
        label: '详情',
        to: { name: 'source-mgr', query: { doctor: '1' } },
      });
    }
  } catch {
    /* 服务端没起 / 网络不通 —— 巡检播报不该打扰用户 */
  }
}

/**
 * `D4`：F11 全屏。**放在 App 的全局 keydown**（不是阅读浮层）—— 任何路由/浮层下都该生效；
 * 桌面端交给主进程 `setFullScreen`，Web 端回退 Fullscreen API（见 `desktop.ts`）。
 * 只认无修饰键的 F11（Ctrl+F11 等留给开发者工具），且忽略长按产生的 key repeat。
 */
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.code !== 'F11' || e.repeat) return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  void toggleFullscreen();
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown);
  registerVerificationOpener((req, done) => {
    vfReq.value = req;
    vfDone = done;
  });
  // `#740` 纯 Web 端才轮询验证码；桌面端由主进程开窗（避免双开）
  if (!isDesktop()) {
    void pollVerifyCodes();
    vcPollTimer = setInterval(() => void pollVerifyCodes(), 1500);
  }
  // 巡检播报：挂载后先取一次（可能已有待播报的），之后每 5 分钟一次
  void pollDoctorPatrol();
  patrolTimer = setInterval(() => void pollDoctorPatrol(), PATROL_POLL_MS);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  registerVerificationOpener(null);
  stopVerifyCodePoll();
  if (patrolTimer) clearInterval(patrolTimer);
  patrolTimer = null;
});
function settleVerification(ok: boolean): void {
  const done = vfDone;
  vfDone = null;
  vfReq.value = null;
  done?.(ok);
}

/**
 * `#163`：把**界面主题**的 CSS 变量写到 `<html>`（inline style ⇒ 覆盖 `theme.css` 的 `:root` 字面值）。
 *
 * ## 为什么放在这里（而不是 main.ts / App 挂载后）
 * `main.ts` 在 **mount 之前** await 了 `hydratePrefs()` —— 所以 App 首次 setup 时
 * 偏好已经对齐完，`watchEffect` 首次执行（`immediate` 默认就是同步首跑）拿到的就是**正确值**，
 * 不存在「先按默认画一帧再跳变」的闪烁。
 *
 * ## 两个同时要做的联动
 * · `color-scheme` —— 浏览器原生控件（滚动条 / input / EP 弹层）按它选明暗；
 * · `html.dark` —— Element Plus 的暗色变量走 `.dark` 选择器（`element-plus/theme-chalk/dark/css-vars.css`），
 *   界面换成亮色主题时**必须摘掉**，否则设置页里的 EP 输入框还是黑底白字（实测过）。
 *   `main.ts` 里那个无条件的 `classList.add('dark')` 只是**首帧前的初值**，这里会纠正它。
 */
watchEffect(() => {
  const root = document.documentElement;
  const vars = reader.uiThemeVars;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  // 背景色决定明暗（不用 isNightTheme：本仓「深色」预设 isNightTheme=true，
  // 但用户完全可以把一套 isNightTheme=false 的主题配色改成暗的 —— 看底色说话才不会自相矛盾）
  const light = reader.uiBgIsLight;
  root.style.colorScheme = light ? 'light' : 'dark';
  root.classList.toggle('dark', !light);
});
</script>

<template>
  <router-view />
  <ToastHost />
  <AndroidToastHost />
  <HoverTip />
  <VerificationOverlay
    v-if="vfReq"
    :source-id="vfReq.sourceId"
    :session-id="vfReq.sessionId"
    :url="vfReq.url"
    :title="vfReq.title"
    @cleared="settleVerification(true)"
    @close="settleVerification(false)"
  />
  <!-- `#740` 纯 Web 端验证码浮层：关闭即取消（组件内 DELETE），宿主持有认领状态 -->
  <VerifyCodeOverlay v-if="vcReq" :meta="vcReq" @close="vcReq = null" />
</template>

