<script setup lang="ts">
/**
 * `#482` **内嵌验证浮层**（Cloudflare / 验证码：不弹独立 Chrome，在页面里过）。
 *
 * ## 为什么不是 iframe
 * CF 这类站点带 `X-Frame-Options: DENY` / `frame-ancestors 'none'` ⇒ 任何 `<iframe>` 都被拒，
 * 所以「在 Web 端里出示页面」只能走**服务端那只常驻浏览器抓屏**：
 *   服务端 CDP `Page.startScreencast` → SSE 帧 → 这里的 `<img>`（≈10fps）
 *   本组件的鼠标/键盘 → `/api/verify/:id/input` → CDP `Input.*` 回灌
 * 浏览器窗口本身被服务端移到屏幕外 ⇒ 用户全程只见这个浮层，不见独立 Chrome。
 *
 * ## 交互口径
 *  · 点画面 = 真点击（按显示尺寸换算回页面 CSS 像素，坐标与 screencast 同源）
 *  · 滚轮 = 真滚动；「填入」= `Input.insertText`（给验证码框/账号框填字）；「回车」= 真按键
 *  · `phase` 变 `cleared` ⇒ 自动 `harvest` 清关 cookie 并 `emit('cleared')`，父组件重试原请求
 *
 * ★ 关浮层**不关浏览器**：那只 Chromium 还要留给后续的反爬重放（`#481` 的热会话）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  startVerification,
  verificationClose,
  verificationHarvest,
  verificationInput,
  verificationNavigate,
  verificationStream,
  type NeedVerification,
} from '../api';

const props = defineProps<{
  sourceId: string;
  /** 服务端 `/api/run` 给的会话 id（没有就自己开一个） */
  sessionId?: string;
  /** 要过的页面地址（缺省用源的 bookSourceUrl） */
  url?: string;
  title?: string;
}>();

const emit = defineEmits<{ cleared: [sessionId: string]; close: [] }>();

const sid = ref('');
const phase = ref<'starting' | 'challenge' | 'cleared' | 'failed' | 'closed'>('starting');
const frame = ref('');
const pageW = ref(960);
const pageH = ref(720);
const pageUrl = ref(props.url ?? '');
const err = ref('');
const busy = ref(false);
const text = ref('');
const screenEl = ref<HTMLElement | null>(null);
let ac: AbortController | null = null;

const PHASE_TEXT: Record<string, string> = {
  starting: '正在拉起验证浏览器…',
  challenge: '请在画面里完成人机验证（勾选 / 输验证码）',
  cleared: '已通过验证，正在重试刚才的请求…',
  failed: '验证浏览器启动失败',
  closed: '验证会话已关闭',
};

function onEvent(ev: Record<string, unknown>): void {
  const t = String(ev['type'] ?? '');
  if (t === 'frame') {
    frame.value = String(ev['data'] ?? '');
    pageW.value = Number(ev['w'] ?? pageW.value) || pageW.value;
    pageH.value = Number(ev['h'] ?? pageH.value) || pageH.value;
    return;
  }
  if (t === 'phase') {
    const p = String(ev['phase'] ?? '');
    phase.value = (['starting', 'challenge', 'cleared', 'failed', 'closed'].includes(p) ? p : 'challenge') as typeof phase.value;
    if (ev['url']) pageUrl.value = String(ev['url']);
    if (ev['error']) err.value = String(ev['error']);
    // 清关即自动收口：抓 cookie → 通知父组件重试（用户不必再点任何按钮）
    if (phase.value === 'cleared') void finish(true);
    return;
  }
  if (t === 'hello') {
    if (ev['url']) pageUrl.value = String(ev['url']);
    if (ev['phase']) phase.value = String(ev['phase']) as typeof phase.value;
    return;
  }
  if (t === 'closed') phase.value = 'closed';
}

async function openStream(id: string): Promise<void> {
  ac = new AbortController();
  try {
    await verificationStream(id, onEvent, ac.signal);
  } catch {
    /* 关浮层/网络重置都走这里，不必报错 */
  }
}

/** 显示坐标 → 页面 CSS 像素（screencast 的 deviceWidth/Height 就是页面 CSS 尺寸） */
function toPage(e: { clientX: number; clientY: number }): { x: number; y: number } {
  const el = screenEl.value;
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { x: 0, y: 0 };
  return { x: Math.round(((e.clientX - r.left) / r.width) * pageW.value), y: Math.round(((e.clientY - r.top) / r.height) * pageH.value) };
}

async function onClick(e: MouseEvent): Promise<void> {
  if (!sid.value || busy.value) return;
  const { x, y } = toPage(e);
  try {
    await verificationInput(sid.value, { type: 'click', x, y });
  } catch (err2) {
    err.value = String(err2 instanceof Error ? err2.message : err2);
  }
}

async function onWheel(e: WheelEvent): Promise<void> {
  if (!sid.value) return;
  const { x, y } = toPage(e);
  try {
    await verificationInput(sid.value, { type: 'wheel', x, y, deltaY: Math.round(e.deltaY) });
  } catch {
    /* 忽略 */
  }
}

async function sendText(): Promise<void> {
  if (!sid.value || !text.value) return;
  try {
    await verificationInput(sid.value, { type: 'text', text: text.value });
    text.value = '';
  } catch (e) {
    err.value = String(e instanceof Error ? e.message : e);
  }
}

async function sendEnter(): Promise<void> {
  if (!sid.value) return;
  try {
    await verificationInput(sid.value, { type: 'key', key: 'Enter', code: 'Enter' });
  } catch {
    /* 忽略 */
  }
}

async function reload(): Promise<void> {
  if (!sid.value || !pageUrl.value) return;
  phase.value = 'starting';
  try {
    await verificationNavigate(sid.value, pageUrl.value);
  } catch (e) {
    err.value = String(e instanceof Error ? e.message : e);
  }
}

/** 收口：抓 cookie → 关流 → 通知父组件重试（`auto` = 由 `phase:cleared` 触发，不重复弹提示） */
async function finish(auto: boolean): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    if (sid.value) {
      try {
        await verificationHarvest(sid.value);
      } catch {
        /* 抓不到 cookie 也不影响重试（重放会自己再走一次渲染） */
      }
      ac?.abort();
      try {
        await verificationClose(sid.value);
      } catch {
        /* 关闭失败无所谓：会话有 TTL 回收 */
      }
    }
  } finally {
    busy.value = false;
    emit('cleared', sid.value);
    if (!auto) emit('close');
  }
}

function onClose(): void {
  ac?.abort();
  if (sid.value) void verificationClose(sid.value).catch(() => undefined);
  emit('close');
}

onMounted(async () => {
  try {
    // 已有会话（服务端 `/api/run` 给的）就不必再开一个：同一源同一只浏览器
    const v: NeedVerification = props.sessionId
      ? { sessionId: props.sessionId, url: props.url ?? '', phase: '' }
      : await startVerification(props.sourceId, props.url);
    sid.value = v.sessionId;
    if (v.url) pageUrl.value = v.url;
    void openStream(v.sessionId);
  } catch (e) {
    phase.value = 'failed';
    err.value = String(e instanceof Error ? e.message : e);
  }
});

onBeforeUnmount(() => {
  ac?.abort();
});
</script>

<template>
  <div class="vf-mask" @click.self="onClose">
    <div class="vf-panel">
      <header class="vf-head">
        <div class="vf-title">
          <strong>{{ title || '站点安全验证' }}</strong>
          <span class="vf-phase" :class="'vf-' + phase">{{ PHASE_TEXT[phase] || phase }}</span>
        </div>
        <button class="vf-x" title="关闭" @click="onClose">✕</button>
      </header>

      <div ref="screenEl" class="vf-screen" @click="onClick" @wheel.prevent="onWheel">
        <img v-if="frame" :src="frame" alt="验证页面画面" draggable="false" />
        <div v-else class="vf-ph">
          <div class="vf-spinner" />
          <p>{{ err || PHASE_TEXT[phase] || '正在连接验证浏览器…' }}</p>
          <p class="vf-sub">浏览器窗口不会弹出 —— 它就在这个浮层里</p>
        </div>
      </div>

      <div class="vf-bar">
        <input
          v-model="text"
          class="vf-input"
          placeholder="验证码 / 账号：填好后点「填入」，再在画面里点一下对应输入框"
          @keydown.enter.prevent="sendText"
        />
        <button :disabled="!text" @click="sendText">填入</button>
        <button title="发送回车键" @click="sendEnter">回车</button>
        <button title="重新加载页面" @click="reload">刷新</button>
        <button class="vf-primary" :disabled="busy" @click="finish(false)">验证完成，重试</button>
      </div>
      <p v-if="err" class="vf-err">{{ err }}</p>
    </div>
  </div>
</template>

<style scoped>
.vf-mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.vf-panel {
  width: min(1040px, 94vw);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg);
  color: var(--fg);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
.vf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.vf-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.vf-phase {
  font-size: 12px;
  color: var(--muted);
}
.vf-phase.vf-challenge {
  color: var(--orange, #e2a03f);
}
.vf-phase.vf-cleared {
  color: var(--green, #3fb950);
}
.vf-phase.vf-failed {
  color: var(--red, #e5534b);
}
.vf-x {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  padding: 2px 8px;
  cursor: pointer;
}
.vf-screen {
  position: relative;
  flex: 1 1 auto;
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0d12;
  overflow: auto;
  cursor: pointer;
}
.vf-screen img {
  display: block;
  width: 100%;
  height: auto;
  image-rendering: auto;
  user-select: none;
}
.vf-ph {
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}
.vf-sub {
  font-size: 12px;
  opacity: 0.75;
}
.vf-spinner {
  width: 26px;
  height: 26px;
  margin: 12px auto;
  border: 2px solid var(--border);
  border-top-color: var(--brand, #4f8cff);
  border-radius: 50%;
  animation: vf-spin 0.9s linear infinite;
}
@keyframes vf-spin {
  to {
    transform: rotate(360deg);
  }
}
.vf-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.vf-input {
  flex: 1 1 240px;
  min-width: 160px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
.vf-bar button {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
}
.vf-bar button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.vf-bar .vf-primary {
  border-color: var(--green, #3fb950);
  color: var(--green, #3fb950);
}
.vf-err {
  margin: 0;
  padding: 0 12px 10px;
  color: var(--red, #e5534b);
  font-size: 12.5px;
  word-break: break-all;
}
</style>
