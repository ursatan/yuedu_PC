/**
 * 内嵌真浏览器（`WebContentsView` 常驻池）的**纯逻辑**：不 `require('electron')`、不碰真窗口。
 *
 * ## 为什么单独一个文件（`#453`，与 `desktop-lib.js` 同一理由）
 * 本机（Agent 沙箱）**起不了 Electron**（无桌面会话，进程秒退无输出）⇒「view 真挂上去了没 /
 * 焦点与 bounds 对不对」在开发期拿不到运行态证据。所以把**可分判定的决策**收在这里：
 * 会话键归一 / partition 隔离命名 / 池的 TTL 与 LRU 回收计划 / bounds 夹取。
 *
 * ⚠️ **边界**：本文件证明的是「**决策**对不对」，不是「Electron 真的照做了」。
 * 后者只能由真机手测（千白羽：启动页 → 内容页 → 返回）。
 *
 * ⚠️ **同站判据不在这里**：`will-navigate` / `setWindowOpenHandler` 只上报、不自行判同站 ——
 * 同站判据全仓只有一份（`apps/web/src/utils/source-site.ts` 的 `sameSite()`），由渲染进程回判。
 */
'use strict';

/* ------------------------------------------------------------------ *
 * 会话键：与服务端 `sessionKeyOf` 同一口径（`src:<sourceId>` / `anon`）
 * ------------------------------------------------------------------ */

/**
 * 归一化会话键。接受的入参形态：
 *  · `'src:abc'` / `'anon'`（已归一，原样用）；
 *  · `'abc'`（源 id）⇒ `'src:abc'`；
 *  · 空 ⇒ `'anon'`（匿名渲染）。
 * 第三个参数给 `sourceId` 时，键优先（保持「一个键一只 view」）。
 */
function normalizeKey(key, sourceId) {
  const k = String(key ?? '').trim();
  if (k === 'anon') return 'anon';
  if (k.startsWith('src:')) return k;
  const id = k || String(sourceId ?? '').trim();
  return id ? `src:${id}` : 'anon';
}

/**
 * 会话键 → Electron 的 `partition`。**必须**每源一个（登录态 / storage 不许串），
 * 且与**服务端**的 `profileDirForKey` 同一条纪律：只做字符白名单，不产生目录层级。
 */
function partitionFor(key) {
  const safe = String(key || 'anon').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'anon';
  return `persist:${safe}`;
}

/* ------------------------------------------------------------------ *
 * bounds 夹取：前端给的坐标是**相对主窗口内容区**的，越界会让 view 跑到看不见的地方
 * ------------------------------------------------------------------ */

function clampBounds(bounds, container) {
  const num = (v, d) => (Number.isFinite(v) ? Math.round(v) : d);
  const cw = Math.max(0, num(container && container.width, 0));
  const ch = Math.max(0, num(container && container.height, 0));
  const x = Math.min(Math.max(0, num(bounds && bounds.x, 0)), cw || Number.MAX_SAFE_INTEGER);
  const y = Math.min(Math.max(0, num(bounds && bounds.y, 0)), ch || Number.MAX_SAFE_INTEGER);
  const w = Math.max(0, num(bounds && bounds.width, cw));
  const h = Math.max(0, num(bounds && bounds.height, ch));
  return {
    x,
    y,
    width: cw ? Math.max(0, Math.min(w, cw - x)) : w,
    height: ch ? Math.max(0, Math.min(h, ch - y)) : h,
  };
}

/* ------------------------------------------------------------------ *
 * 常驻池的元数据（**只记决策所需的东西**；真正的 WebContentsView 在 main.js 里）
 * ------------------------------------------------------------------ */

/**
 * 池规则：
 *  · `pinned`（用户正看着的、已挂进主窗口的 view）**永不回收**；
 *  · 非 pinned 且 `lastUsedAt` 超过 `ttlMs` ⇒ 回收（无头/后台渲染完就该让位）；
 *  · 非 pinned 且总数超过 `max` ⇒ 按「最久未用」回收（LRU）。
 */
class WebViewPool {
  constructor(opts = {}) {
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 5 * 60_000;
    this.max = Number.isFinite(opts.max) ? opts.max : 6;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.records = new Map();
  }

  /** 登记/取一条记录并刷新使用时间（不存在就建） */
  acquire(key, opts = {}) {
    const k = normalizeKey(key);
    let r = this.records.get(k);
    if (!r) {
      r = { key: k, pinned: false, createdAt: this.now(), lastUsedAt: this.now(), uses: 0 };
      this.records.set(k, r);
    }
    r.lastUsedAt = this.now();
    r.uses += 1;
    if (opts.pinned) r.pinned = true;
    return r;
  }

  peek(key) {
    return this.records.get(normalizeKey(key)) || null;
  }

  setPinned(key, pinned) {
    const r = this.records.get(normalizeKey(key));
    if (r) r.pinned = !!pinned;
    return r || null;
  }

  forget(key) {
    return this.records.delete(normalizeKey(key));
  }

  size() {
    return this.records.size;
  }

  /** 回收**计划**（纯决策，不销毁任何东西 ⇒ 可单测）：返回要回收的键列表 */
  evictPlan(nowMs = this.now()) {
    const expired = [];
    for (const r of this.records.values()) {
      if (r.pinned) continue;
      if (nowMs - r.lastUsedAt >= this.ttlMs) expired.push(r);
    }
    const dead = new Set(expired.map((r) => r.key));
    const live = [...this.records.values()].filter((r) => !r.pinned && !dead.has(r.key));
    const overflow = live.length - this.max;
    if (overflow > 0) {
      live.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt);
      for (const r of live.slice(0, overflow)) expired.push(r);
    }
    return expired.map((r) => r.key);
  }
}

module.exports = { normalizeKey, partitionFor, clampBounds, WebViewPool };
