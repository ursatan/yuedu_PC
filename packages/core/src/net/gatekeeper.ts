/**
 * 「gatekeeper」站点挑战的自动解证（`#151`）。
 *
 * ## 挑战形态（2026-10-10 对 `cn.baozimhcn.com` 实测取证）
 * 1. 业务请求被站点网关拦下：**403 + JSON**
 *    `{"challenge_url":"/__gatekeeper_challenge/start?return=%2F","error":"challenge_required"}`；
 * 2. GET `challenge_url` ⇒ 「正在验证浏览器」页 + `Set-Cookie: __Host-gk_browser_*`（初始绑定）；
 * 3. 页面内联脚本给出 `cfg`：`challengeId` · `ticket` · `verifyUrl` · `difficultyBits`
 *    （实例 16）· `lifeMs/computeMs/submitMs`；验证页加载 `challenge.js` + `worker.js`；
 * 4. 浏览器跑 **SHA-256 PoW**：对 `"gatekeeper-pow-v1:" + challengeId + ":" + nonce`
 *    （nonce 为十进制字符串，从 "0" 递增）求前导零 bit 数 ≥ `difficultyBits` 的 nonce；
 * 5. POST `verifyUrl`，body `{challenge_id, ticket, nonce}` —— **必须带 same-origin 的
 *    `Origin` + `Referer`**（实测缺失 ⇒ `403 {"error":"binding_mismatch"}`，这才是
 *    「请允许 Cookie 后重试」提示的真实原因，跟 Cookie 关系不大）；
 * 6. 通过 ⇒ `{"status":"passed","mode":"navigate"|"manual"}` + 放行 `Set-Cookie`
 *    ⇒ 重试原请求即 200。
 *
 * ## 为什么引擎内可自动解（而不是「自动升级浏览器」）
 * 挑战是**纯 PoW**，不查浏览器指纹：Node 的 `crypto` 同步算 SHA-256 比浏览器 Worker
 * 还快（16 bit 实测 5.5 万~9 万次、<1s）。**不需要真浏览器。**
 *
 * ## 边界（重要）
 * - 这套只认 **gatekeeper 形态**（403 + JSON `challenge_required`）。别的挑战
 *   （腾讯云 WAF 的 403 硬拦截页——得间 `wechat.idejian.com` 现状、无 JS 无 cookie 通路）
 *   **不在此列**：那类站点无自动放行通路，本模块不会碰。
 * - 解证**只重试原请求一次**；失败时把**原 403 响应**原样返回（不吞、不伪装成功），
 *   上层报错链路照旧。
 */
import crypto from 'node:crypto';

/** 挑战指引（业务请求 403 的 JSON body） */
export interface GatekeeperGuide {
  challenge_url: string;
}

/** 验证页内联脚本里的求解配置 */
export interface GatekeeperCfg {
  challengeId: string;
  ticket: string;
  verifyUrl: string;
  difficultyBits: number;
}

/**
 * 这条 403 是不是 gatekeeper 挑战指引？
 * 判据（从严，防误触发）：`content-type` 是 JSON 且 body 恰是
 * `{"challenge_url":"...","error":"challenge_required"}` 形态。
 */
export function parseGatekeeperGuide(
  status: number,
  contentType: string | undefined,
  bodyText: string,
): string | null {
  if (status !== 403) return null;
  if (!contentType || !/application\/json/i.test(contentType)) return null;
  const t = bodyText.trim();
  if (t.length > 512) return null;
  try {
    const j = JSON.parse(t) as Partial<GatekeeperGuide> & { error?: string };
    if (j.error === 'challenge_required' && typeof j.challenge_url === 'string' && j.challenge_url.startsWith('/')) {
      return j.challenge_url;
    }
  } catch {
    /* 不是 JSON */
  }
  return null;
}

/**
 * 从验证页 HTML 提取求解配置（内联脚本的 `gatekeeperChallenge.start({...})`）。
 * 取不到 ⇒ `null`（页面形态变了，别硬猜）。
 */
export function parseGatekeeperCfg(pageHtml: string): GatekeeperCfg | null {
  const pick = (key: string): string | null => {
    const m = pageHtml.match(new RegExp(key + ':"([^"]+)"'));
    return m?.[1] ?? null;
  };
  const challengeId = pick('challengeId');
  const ticket = pick('ticket');
  const verifyUrl = pick('verifyUrl');
  if (!challengeId || !ticket || !verifyUrl) return null;
  const bits = Number(pageHtml.match(/difficultyBits:(\d+)/)?.[1] ?? 0);
  // 防御性上限：16 是实测常态；>24 意味着上亿次哈希，不是给人算的 ⇒ 拒解
  if (!Number.isFinite(bits) || bits < 1 || bits > 24) return null;
  return { challengeId, ticket, verifyUrl, difficultyBits: bits };
}

/** 前导零 bit 数（对拍 worker.js 的 `leadingZeroBits`：逐 bit 数，遇 1 即止） */
export function leadingZeroBits(buf: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const b: number = buf[i] ?? 0;
    if (b === 0) {
      n += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit--) {
      if (((b >> bit) & 1) === 0) n++;
      else return n;
    }
    break;
  }
  return n;
}

/** PoW 结果；`attempts` 供日志/测试断言 */
export interface GatekeeperPow {
  nonce: string;
  attempts: number;
  /** `#476` 让出版：**单次最长连续哈希块**的毫秒数（判「是否还冻主线程」的判据，非总耗时） */
  maxChunkMs?: number;
}

/**
 * 解 PoW：`SHA-256("gatekeeper-pow-v1:" + challengeId + ":" + nonce)` 的前导零
 * bit 数 ≥ `difficultyBits`；nonce 是**十进制字符串**，从 "0" 起递增（worker.js 同款）。
 *
 * 同步算（Node `crypto` 比浏览器的 `crypto.subtle` 快得多）； attempts 上限
 * `2^24`（≈1677 万，本机 <10s）——到顶仍解不出 ⇒ 返回 `null`（放弃，别吊死）。
 */
export function solveGatekeeperPow(cfg: GatekeeperCfg): GatekeeperPow | null {
  const PREFIX = 'gatekeeper-pow-v1:';
  const prefix = Buffer.from(PREFIX + cfg.challengeId + ':', 'utf8');
  const maxAttempts = 1 << 24;
  for (let i = 0; i < maxAttempts; i++) {
    const nonce = String(i);
    const digest = crypto.createHash('sha256').update(prefix).update(Buffer.from(nonce, 'utf8')).digest();
    if (leadingZeroBits(digest) >= cfg.difficultyBits) {
      return { nonce, attempts: i + 1 };
    }
  }
  return null;
}

/**
 * `#476` **让出版本的 PoW 求解**（生产唯一入口）。
 *
 * 背景（2026-10-15 用户实测「卡得没法用」）：`solveGatekeeperPow` 是**主线程紧循环**，
 * 一次求解动辄上万次 SHA-256（实测日志 `PoW 25163 次通过`）——期间事件循环完全停摆
 * （`/api/diag` 的 `blocks` **没有**这一项埋点，所以此前一直看不到真凶）。
 * 这里每 `yieldEvery` 次尝试 `await setImmediate` 让出一次 ⇒ 单次阻塞被切到毫秒级，
 * 求解总时长几乎不变（`setImmediate` 开销可忽略），但主线程保持可响应。
 *
 * 同步版 `solveGatekeeperPow` 保留：回归锁直接测它的语义（不依赖事件循环）。
 */
export async function solveGatekeeperPowAsync(
  cfg: GatekeeperCfg,
  yieldEvery = 2000,
): Promise<GatekeeperPow | null> {
  const PREFIX = 'gatekeeper-pow-v1:';
  const prefix = Buffer.from(PREFIX + cfg.challengeId + ':', 'utf8');
  const maxAttempts = 1 << 24;
  const step = Math.max(100, Math.trunc(yieldEvery) || 2000);
  let chunkStart = Date.now();
  let maxChunkMs = 0;
  for (let i = 0; i < maxAttempts; i++) {
    const nonce = String(i);
    const digest = crypto.createHash('sha256').update(prefix).update(Buffer.from(nonce, 'utf8')).digest();
    if (leadingZeroBits(digest) >= cfg.difficultyBits) {
      return { nonce, attempts: i + 1, maxChunkMs: Math.max(maxChunkMs, Date.now() - chunkStart) };
    }
    if (i > 0 && i % step === 0) {
      maxChunkMs = Math.max(maxChunkMs, Date.now() - chunkStart);
      await new Promise<void>((resolve) => setImmediate(resolve));
      chunkStart = Date.now();
    }
  }
  return null;
}
