/**
 * `#482` **验证门**：`runAction` 拿到 `needVerification` 后的统一收口。
 *
 * ## 为什么单独抽一个模块
 * 「撞 CF ⇒ 弹浮层 ⇒ 过验证 ⇒ 自动重试」这件事**不该**散在 discover / reader / player 各自的实现里：
 *  · 同一源连续几个动作（分类页 → 详情页 → 目录页）会**同时**回来好几个 `needVerification`，
 *    没有去重就会叠出好几个浮层（而它们背后是同一只浏览器、同一份验证）；
 *  · 调用方（store）只关心「结果」，不该知道「要不要弹窗、弹给谁」。
 *
 * ## 分工
 *  · 本模块：**去重 + 等待**（同一 `sourceId` 只弹一次，其余请求挂在同一扇门上一起放行）；
 *  · `App.vue`：注册 `opener`（真正渲染 `VerificationOverlay`）；
 *  · `api.ts`：`runAction` 在拿到 `needVerification` 时 `await` 这扇门，通过后**自动重跑一次**。
 *
 * ★ 没注册 opener 时（CLI/测试宿主）立即返回 `false` —— 绝不让请求永远挂着。
 */
export interface VerificationRequest {
  sourceId: string;
  sessionId: string;
  url: string;
  title?: string;
}

/** opener 签名：`done(true)` = 已过验证（调用方该重试），`done(false)` = 用户放弃/失败 */
export type VerificationOpener = (req: VerificationRequest, done: (ok: boolean) => void) => void;

let opener: VerificationOpener | null = null;

interface Gate {
  req: VerificationRequest;
  waiters: Array<(ok: boolean) => void>;
}
const gates = new Map<string, Gate>();

export function registerVerificationOpener(fn: VerificationOpener | null): void {
  opener = fn;
}

/** 有没有已注册的浮层宿主（决定 `requestVerification` 是等还是直接放行） */
export function hasVerificationOpener(): boolean {
  return opener !== null;
}

/** 请求人工过验证；返回「是否通过了验证」 */
export function requestVerification(req: VerificationRequest): Promise<boolean> {
  const key = String(req.sourceId || req.sessionId || 'anon');
  const cur = gates.get(key);
  // 同一源已有门在等 ⇒ 挂上去（一起放行），不重复弹窗
  if (cur) return new Promise<boolean>((resolve) => cur.waiters.push(resolve));

  if (!opener) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const gate: Gate = { req, waiters: [resolve] };
    gates.set(key, gate);
    opener!(
      {
        sourceId: req.sourceId,
        sessionId: req.sessionId,
        url: req.url,
        ...(req.title ? { title: req.title } : {}),
      },
      (ok) => {
        gates.delete(key);
        for (const w of gate.waiters) w(ok);
      },
    );
  });
}
