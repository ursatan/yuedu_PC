/**
 * 源登录信息（Legado `BaseSource` 登录信息族）的**唯一实现**（`#314`）。
 *
 * 为什么要有这个文件：上游这些方法在 **`BaseSource`**（BookSource / RssSource / HttpTTS 公共父类，
 * `BaseSource.kt:257` `getLoginInfoMap(): MutableMap<String,String>`），**不是书源专有**；
 * 而本仓此前把它们内联在 legado 引擎的 source 桩里，rss 引擎的桩**整块没有**
 * ⇒ 源脚本第一行 `let loginInfo = source.getLoginInfoMap();` 直接
 * `source.getLoginInfoMap is not a function` ⇒ **整个分类脚本崩、分类退化成「整源」**
 * （用户 2026-10-07 报障的真实根因；探针实测见 `tmp/probe-rss-login.log`）。
 *
 * 三个必须由**一处**决定、否则必然漂移的点：
 *  1. **合并规则**：`variables['__loginInfo']`（引擎 prime 过的） ⊕ `ctx.loginInfo`（宿主注入，优先）。
 *     hub 每次请求 `new` 一个 variables store，只注入 `ctx.loginInfo` ⇒ 只读 variables 会「看起来没登录」。
 *  2. **JS 可见形态**：上游是 Java `MutableMap`，Rhino 下 **`map["键"]` 与 `map.get("键")` 都能用**
 *     （`RhinoWrapFactory.kt:80-81` 为 `java.util.Map` 专门做了 `CatchableNativeJavaMap` 视图）。
 *     语料实测（`#314` 扫描）：`getLoginInfoMap()` 共 6 源 45 处，其中 `.get("键")` 35 处、
 *     `["键"]` 10 处 ⇒ **两种写法都必须可用**。所以统一返回「纯对象 + 非枚举 Map 方法」
 *     （复用 `selector/json-map.ts` 的 `attachJsonMapMethods`，与 JSON 绑定同一份实现）。
 *     ⚠️ 方法必须**非枚举**：否则 `Object.keys(loginInfo)` 会多出 `get/put/size` 等键。
 *  3. **L1 / worker 同形**：worker 侧（`sandbox/worker-pool.ts`）用同一份注入源码
 *     `__yueduAttachJsonMap` 重建 ⇒ 两侧同形，不再「L1 给 JS Map（方括号恒 undefined）、worker 给对象」。
 *
 * 落盘：`LOGIN_INFO_PREFIX` / `LOGIN_HEADER_PREFIX` 在契约层（`contract/types.ts`），两引擎共用。
 */

import { LOGIN_HEADER_PREFIX, LOGIN_INFO_PREFIX, type EngineContext, type SourceStubCtx } from './contract';
import { attachJsonMapMethods } from './selector/json-map';

/**
 * 读**有效**登录信息：`variables['__loginInfo']` ⊕ `ctx.loginInfo`（后者优先）。
 *
 * 为什么 ctx 优先：hub 的 `sourceLoginInfo` 是内存真值（UI 刚提交的值立刻在这里），
 * storage 那份是持久层。两者本应一致，但 UI 刚保存、尚未 await 落盘的窗口内只有 ctx 是最新的。
 */
export function readLoginInfo(ctx: SourceStubCtx): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = ctx.variables.get('__loginInfo');
  if (typeof raw === 'string' && raw) {
    try {
      const o = JSON.parse(raw) as unknown;
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (v != null) out[k] = String(v);
      }
    } catch {
      /* 非 JSON：当作没有（与 Legado 的 try/catch 兜底同义） */
    }
  }
  if (ctx.loginInfo) {
    for (const [k, v] of ctx.loginInfo) if (v != null) out[k] = String(v);
  }
  return out;
}

/**
 * 源脚本看到的 `getLoginInfoMap()` 返回值 —— 方括号与 `.get()` 都能用（见头注 ②）。
 * 返回**普通对象**（可 `JSON.stringify`、可结构化克隆），Map 方法用非枚举方式挂。
 */
export function loginInfoMapForJs(ctx: SourceStubCtx): Record<string, unknown> {
  return attachJsonMapMethods({ ...readLoginInfo(ctx) });
}

/** 读登录头 map（Legado `BaseSource.getLoginHeaderMap()` 返回 Map 或 null） */
export function loginHeaderMapForJs(ctx: SourceStubCtx): Record<string, unknown> | null {
  const raw = String(ctx.variables.get('__loginHeader') ?? '');
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) out[k] = v == null ? '' : String(v);
    return attachJsonMapMethods(out);
  } catch {
    return null;
  }
}

/**
 * `BaseSource` 登录信息 API 的 source 桩方法集 —— **两个引擎展开同一份**。
 *
 * 读写落点都是引擎上下文的 `variables`（脚本内是同步 API，不能 await storage）；
 * 由调用方在动作收尾时用 `persistSourceLogin()` 落盘（对齐 Legado putLoginInfo 即持久化）。
 */
export function makeSourceLoginStub(ctx: SourceStubCtx): Record<string, unknown> {
  return {
    getLoginInfoMap: () => loginInfoMapForJs(ctx),
    /** Legado `getLoginInfo(): String` —— JSON 串；给**合并后**的值，否则只读变量会返回 `{}` */
    getLoginInfo: () => JSON.stringify(readLoginInfo(ctx)),
    putLoginInfo: (v: unknown) => {
      try {
        const t = String(v ?? '');
        const o = JSON.parse(t) as unknown;
        if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
        ctx.variables.set('__loginInfo', t);
        return true;
      } catch {
        return false;
      }
    },
    removeLoginInfo: () => {
      ctx.variables.set('__loginInfo', '{}');
    },
    /** Legado `BaseSource.kt:213` —— 书耽等源直接读它 */
    getLoginHeaderMap: () => loginHeaderMapForJs(ctx),
    getLoginHeader: () => ctx.variables.get('__loginHeader') || '',
    putLoginHeader: (h: unknown) => {
      const t = String(h ?? '');
      try {
        const o = JSON.parse(t) as Record<string, string>;
        if (!o || typeof o !== 'object') return;
        ctx.variables.set('__loginHeader', t);
        // 同时把 Cookie 落进 CookieStore（对齐 Legado CookieStore.replaceCookie）
        const ck = o['Cookie'] ?? o['cookie'] ?? '';
        for (const pair of String(ck).split(';')) {
          const eq = pair.indexOf('=');
          if (eq > 0) ctx.cookies?.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      } catch {
        /* 非 JSON 忽略（Legado 同样 try/catch） */
      }
    },
    removeLoginHeader: () => {
      ctx.variables.set('__loginHeader', '');
      ctx.cookies?.clear?.();
    },
  };
}

/**
 * 把脚本写过的登录信息 / 登录头**落盘**（Legado `putLoginInfo`/`putLoginHeader` 都持久化）。
 *
 * ⚠️ 空表也写（`'{}'`）——否则 `source.removeLoginInfo()` 只清了内存那份，storage 里旧值
 *    下次 prime 又「复活」（同 `__srcCache` 的纪律，见 `#238`）。
 * `__loginInfo` 为 undefined 表示本次没经过 prime（如直接调引擎工具函数）⇒ 不写，避免造垃圾键。
 */
export async function persistSourceLogin(ctx: EngineContext): Promise<void> {
  try {
    const info = ctx.variables.get('__loginInfo');
    if (typeof info === 'string' && info) {
      if (info === '{}') await ctx.storage.delete(LOGIN_INFO_PREFIX + ctx.sourceId);
      else await ctx.storage.set(LOGIN_INFO_PREFIX + ctx.sourceId, info);
    }
  } catch {
    /* 存储失败不影响本次结果 */
  }
  try {
    const header = ctx.variables.get('__loginHeader');
    if (typeof header === 'string') {
      if (header) await ctx.storage.set(LOGIN_HEADER_PREFIX + ctx.sourceId, header);
      else await ctx.storage.delete(LOGIN_HEADER_PREFIX + ctx.sourceId);
    }
  } catch {
    /* 存储失败不影响本次结果 */
  }
}
