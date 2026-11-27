/**
 * `#740` **纯 Web 端的验证码浮层逻辑**（与 CF 挑战浮层 `VerificationOverlay` 是两条独立通道）。
 *
 * ## 背景
 * `java.getVerificationCode(url)` 的服务端实现（`#727`）只被**桌面端主进程**消费
 * （`apps/desktop/main.js` 轮询 `/api/verify-code/pending` 开 `BrowserWindow`）。
 * 纯 Web 用户（浏览器直接开 3000）没有人去显示验证码画面 ⇒ 脚本 60s 后收到「验证码超时」。
 *
 * ## 认领语义（避免与桌面端双开窗口）
 *  服务端给每个请求记 `claimedBy`；Web 与桌面端各带 `consumer=web|desktop`：
 *  · 未认领 ⇒ 任一方可认领（先到先得）；
 *  · 同端重复认领 ⇒ 幂等（网页刷新后可以接着显示同一张验证码）；
 *  · 已被另一端认领 ⇒ 不再弹窗；
 *  · 提交 / 取消 / 超时 / 失败 ⇒ entry 删除，认领随之释放。
 *
 * 本模块只放**纯判据 + 文案**（可单测）；HTTP 调用在 `api.ts`，浮层在
 * `components/VerifyCodeOverlay.vue`。
 */

export type VerifyCodeConsumer = 'web' | 'desktop';

export type VerifyCodeState = 'waiting' | 'submitted' | 'cancelled' | 'timeout' | 'failed';

export interface VerifyCodeMeta {
  id: string;
  sourceId: string;
  imageUrl: string;
  createdAt: number;
  expiresAt: number;
  state: VerifyCodeState;
  error?: string;
  claimedBy?: VerifyCodeConsumer;
  claimedAt?: number;
}

/** 剩余秒数（`<= 0` = 已到点；服务端会随后收尾成 `timeout`） */
export function verifyCodeSecondsLeft(expiresAt: number, now = Date.now()): number {
  const ms = Number(expiresAt) - now;
  return ms <= 0 ? 0 : Math.round(ms / 1000);
}

/** 已结束的 state（浮层不再轮询、输入框禁用） */
export function isVerifyCodeTerminal(state: string): boolean {
  return state !== 'waiting';
}

/**
 * 从 pending 列表里挑一个**本端可以认领**的目标。
 *
 * 规则（与服务端过滤口径一致，前端再兜一层）：
 *  · 跳过已被**另一端**认领的；
 *  · 跳过当前正在显示的同一个 id；
 *  · 按 `createdAt` 先到先得（服务端已排序，这里不依赖顺序再排一次）。
 */
export function pickClaimTarget(
  pending: VerifyCodeMeta[],
  currentId = '',
  consumer: VerifyCodeConsumer = 'web',
): VerifyCodeMeta | null {
  const cur = String(currentId ?? '').trim();
  const list = [...(pending ?? [])]
    .filter((p) => p && typeof p.id === 'string' && p.state === 'waiting')
    .filter((p) => p.id !== cur)
    .filter((p) => !p.claimedBy || p.claimedBy === consumer)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return list[0] ?? null;
}

/**
 * 浮层状态文案（**超时 / 取消 / 浏览器不可用 / failed 都必须有明确文案**）。
 *
 * `frame` 为真时等待中的提示改成「请输入」；服务端 error 优先（它是脚本侧看到的同一句原文）。
 */
export function verifyCodeStatusText(
  meta: Pick<VerifyCodeMeta, 'state' | 'error' | 'expiresAt'>,
  opts: { hasFrame?: boolean; now?: number } = {},
): string {
  const state = String(meta?.state ?? 'waiting');
  const err = String(meta?.error ?? '').trim();
  if (state === 'cancelled') {
    return err || '验证码输入已取消：脚本已收到「已取消」，不会继续等待';
  }
  if (state === 'timeout') {
    return err || '验证码超时：等待时间已用尽，脚本已收到超时错误';
  }
  if (state === 'failed') {
    return err || '验证码窗口不可用：无法启动浏览器或抓取画面，脚本已收到失败';
  }
  if (state === 'submitted') {
    return '验证码已提交，正在把结果交回脚本…';
  }
  // waiting
  if (verifyCodeSecondsLeft(meta?.expiresAt ?? 0, opts.now ?? Date.now()) <= 0) {
    return '等待时间已到，正在等服务端收尾…';
  }
  return opts.hasFrame ? '请输入图中的验证码' : '正在获取验证码画面…';
}

/**
 * `/state` 已 404（entry 被服务端删除）时的文案。
 *
 * 服务端在提交/取消/超时后**立刻删除 entry**，所以浮层有可能只看到 404：
 * 到点（本地时钟 ≥ `expiresAt`）按超时说，否则只能是「已提交或已取消」。
 */
export function verifyCodeGoneText(expiresAt: number, now = Date.now()): string {
  return Number(expiresAt) <= now
    ? '验证码超时：等待时间已用尽，脚本已收到超时错误'
    : '验证码请求已结束（可能已提交或已取消）';
}
