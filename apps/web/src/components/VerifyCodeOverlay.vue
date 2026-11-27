<script setup lang="ts">
/**
 * `#740` **验证码浮层（纯 Web 端）** —— `java.getVerificationCode` 的浏览器半边。
 *
 * ⚠️ 与 `VerificationOverlay.vue`（`#482` CF 挑战，走 `/api/verify/:id/stream` + 输入回灌）
 * 是**两条独立通道**：那边是「在截图里点/输入」过网页验证；这边是「看图 → 填码 → 提交」
 * 的验证码接口（`/api/verify-code/*`，服务端实现见 `#727`）。
 *
 * 交互口径（项目硬约束）：**只能通过关闭按钮 / Esc 关闭，点浮层外部不关闭**。
 * 关闭 = `DELETE /api/verify-code/:id` ⇒ worker 立刻收到「验证码输入已取消」（不是静默悬挂）。
 *
 * 认领：本浮层只显示 App 已用 `consumer=web` 认领成功的请求（见 `App.vue` 的轮询）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { pushEscLayer } from '../utils/esc-layer';
import {
  verifyCodeCancel,
  verifyCodeFrame,
  verifyCodeRefresh,
  verifyCodeState,
  verifyCodeSubmit,
} from '../api';
import {
  isVerifyCodeTerminal,
  verifyCodeGoneText,
  verifyCodeSecondsLeft,
  verifyCodeStatusText,
  type VerifyCodeMeta,
} from '../utils/verify-code';

const props = defineProps<{ meta: VerifyCodeMeta }>();
const emit = defineEmits<{ close: [] }>();

const state = ref<string>(props.meta.state);
const error = ref(props.meta.error ?? '');
const frame = ref('');
const code = ref('');
const busy = ref(false);
const now = ref(Date.now());
const notice = ref('');
/** 服务端已删除该 entry（提交/取消/超时收尾后 `/state` 会 404） */
const gone = ref(false);

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let closing = false;
let popEsc: (() => void) | null = null;

const terminal = computed(() => gone.value || isVerifyCodeTerminal(state.value));
const secs = computed(() => (terminal.value ? 0 : verifyCodeSecondsLeft(props.meta.expiresAt, now.value)));
const status = computed(() => {
  if (gone.value) return verifyCodeGoneText(props.meta.expiresAt, now.value);
  return verifyCodeStatusText(
    { state: state.value as VerifyCodeMeta['state'], error: error.value, expiresAt: props.meta.expiresAt },
    { hasFrame: !!frame.value, now: now.value },
  );
});

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (ticking || closing) return;
  ticking = true;
  try {
    now.value = Date.now();
    if (terminal.value) {
      stopTimer();
      return;
    }
    let st: VerifyCodeMeta;
    try {
      st = await verifyCodeState(props.meta.id);
    } catch {
      // 404 = 服务端已收尾（提交/取消/超时）；超时与否按本地时钟判断，文案不可含糊
      gone.value = true;
      stopTimer();
      return;
    }
    state.value = st.state;
    if (st.error) error.value = st.error;
    if (isVerifyCodeTerminal(st.state)) {
      stopTimer();
      return;
    }
    const f = await verifyCodeFrame(props.meta.id);
    if (f.ok && f.frame) {
      frame.value = f.frame;
      notice.value = '';
    } else if (f.error === 'NOT_PENDING') {
      gone.value = true;
      stopTimer();
    } else if (f.error === 'STARTING') {
      notice.value = '正在启动验证码浏览器…';
    } else if (f.error) {
      notice.value = `画面获取失败：${f.error}`;
    }
  } finally {
    ticking = false;
  }
}

async function submit(): Promise<void> {
  if (busy.value || terminal.value) return;
  const c = code.value.trim();
  if (!c) {
    notice.value = '请先输入验证码';
    return;
  }
  busy.value = true;
  notice.value = '正在提交…';
  try {
    const r = await verifyCodeSubmit(props.meta.id, c);
    if (r.ok) {
      state.value = 'submitted';
      stopTimer();
      notice.value = '';
      // 让用户看到「已提交」再收起（脚本已经拿到 code 继续跑了）
      setTimeout(() => void close(), 600);
      return;
    }
    notice.value = r.message || '提交失败';
  } catch (e) {
    notice.value = `提交失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
}

async function refresh(): Promise<void> {
  if (busy.value || terminal.value) return;
  busy.value = true;
  try {
    const ok = await verifyCodeRefresh(props.meta.id);
    frame.value = '';
    if (!ok) notice.value = '换一张失败（验证码已结束或浏览器不可用）';
    else void tick();
  } catch (e) {
    notice.value = `换一张失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
}

/** 关闭 = 取消（即使已收尾也 DELETE，服务端回 `cancelled:false` 无害） */
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  stopTimer();
  popEsc?.();
  popEsc = null;
  await verifyCodeCancel(props.meta.id);
  emit('close');
}

onMounted(() => {
  popEsc = pushEscLayer(() => void close());
  void tick();
  timer = setInterval(() => void tick(), 1500);
});

onBeforeUnmount(() => {
  stopTimer();
  popEsc?.();
  popEsc = null;
  // 页面跳走/刷新：同样要释放认领并让脚本收到「已取消」
  if (!closing) void verifyCodeCancel(props.meta.id);
});
</script>

<template>
  <div class="vc-mask">
    <div class="vc-panel" role="dialog" aria-modal="true" aria-label="输入验证码">
      <header class="vc-head">
        <strong>需要输入验证码</strong>
        <span class="vc-sub">此窗口由源脚本请求验证码触发（源 {{ meta.sourceId }}）</span>
        <button class="vc-x" title="关闭" data-vc-close @click="close">✕</button>
      </header>

      <div class="vc-shot" :class="{ 'vc-shot-failed': terminal }">
        <img v-if="frame && !terminal" :src="frame" alt="验证码画面" draggable="false" />
        <div v-else class="vc-ph">
          <div v-if="!terminal" class="vc-spinner" />
          <p>{{ terminal ? status : '正在获取验证码画面…' }}</p>
        </div>
      </div>

      <form class="vc-form" autocomplete="off" @submit.prevent="submit">
        <input
          v-model="code"
          data-vc-input
          placeholder="输入图中的验证码"
          :disabled="terminal || busy"
          @keydown.enter.prevent="submit"
        />
        <button class="vc-primary" type="submit" data-vc-submit :disabled="terminal || busy || !code.trim()">
          提交
        </button>
      </form>

      <div class="vc-bar">
        <button type="button" data-vc-refresh :disabled="terminal || busy" @click="refresh">换一张</button>
        <button type="button" data-vc-cancel @click="close">{{ terminal ? '关闭' : '取消' }}</button>
        <span class="vc-grow" />
        <span class="vc-count" data-vc-count>剩余 {{ secs }}s</span>
      </div>

      <p class="vc-hint" :class="{ 'vc-warn': terminal }" data-vc-status>{{ status }}</p>
      <p v-if="notice" class="vc-notice" data-vc-notice>{{ notice }}</p>
    </div>
  </div>
</template>

<style scoped>
.vc-mask {
  position: fixed;
  inset: 0;
  z-index: 3100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.vc-panel {
  width: min(520px, 94vw);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border, #333a47);
  border-radius: 12px;
  background: var(--bg, #14161b);
  color: var(--fg, #e5e7eb);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  padding-bottom: 6px;
}
.vc-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, #2a2f3a);
}
.vc-sub {
  flex: 1;
  min-width: 0;
  color: var(--muted, #94a3b8);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vc-x {
  border: 1px solid var(--border, #333a47);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  padding: 2px 8px;
  cursor: pointer;
}
.vc-shot {
  margin: 12px;
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0d12;
  border: 1px solid var(--border, #2a2f3a);
  border-radius: 8px;
  overflow: auto;
}
.vc-shot img {
  display: block;
  max-width: 100%;
  max-height: 360px;
}
.vc-ph {
  text-align: center;
  color: var(--muted, #94a3b8);
  font-size: 13px;
  line-height: 1.6;
  padding: 18px;
  word-break: break-all;
}
.vc-shot-failed .vc-ph {
  color: var(--orange, #e2a03f);
}
.vc-spinner {
  width: 26px;
  height: 26px;
  margin: 10px auto;
  border: 2px solid var(--border, #2a2f3a);
  border-top-color: var(--brand, #4f8cff);
  border-radius: 50%;
  animation: vc-spin 0.9s linear infinite;
}
@keyframes vc-spin {
  to {
    transform: rotate(360deg);
  }
}
.vc-form {
  display: flex;
  gap: 8px;
  padding: 0 12px;
}
.vc-form input {
  flex: 1;
  min-width: 0;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--border, #333a47);
  background: var(--bg-1, #1b1f27);
  color: inherit;
  font-size: 16px;
  letter-spacing: 1px;
  outline: none;
}
.vc-form input:focus {
  border-color: var(--brand, #6366f1);
}
.vc-form button,
.vc-bar button {
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border, #333a47);
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}
.vc-primary {
  background: var(--brand, #6366f1) !important;
  border-color: var(--brand, #6366f1) !important;
  color: #fff !important;
  font-weight: 600;
}
.vc-form button:disabled,
.vc-bar button:disabled {
  opacity: 0.55;
  cursor: default;
}
.vc-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 0;
}
.vc-grow {
  flex: 1;
}
.vc-count {
  color: var(--muted, #64748b);
  font-size: 12px;
}
.vc-hint {
  margin: 8px 12px 0;
  min-height: 18px;
  color: var(--muted, #94a3b8);
  font-size: 12px;
  word-break: break-all;
}
.vc-warn {
  color: var(--orange, #e2a03f);
}
.vc-notice {
  margin: 4px 12px 0;
  color: var(--muted, #94a3b8);
  font-size: 12px;
  word-break: break-all;
}
</style>
