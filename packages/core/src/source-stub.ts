/**
 * Legado `bindings["source"] = BaseSource` 的**唯一实现**（`#553`）。
 *
 * 为什么要有这个文件：这个桩原先长在 `engine-legado/src/engine.ts` 里、**没有导出**，
 * 于是 `#551` 做单字段试跑时只能在服务端另写一个「字段快照 + 自补 `getKey`」的半套桩
 * （`probeSourceOf`）。两份桩的必然结局是漂移 —— 这正是 `#158` 那条「两处各写一份后来漂了」
 * 锁住 6 个源的旧坑。现在探针与引擎吃同一份：**试跑里 `source.xxx` 的行为 = 真跑**。
 *
 * ★ 三个设计点（改之前先读，别原地又长出一份）：
 *
 *  ① **参数是 `SourceStubCtx`，不是 `EngineContext`。**
 *     桩只需要 `variables` / `loginInfo` / `cookies` 三样；探针**没有** http/sandbox/trace，
 *     若强行要求完整 `EngineContext`，探针就只能靠 `as unknown as` 硬塞 —— 那是「假装有」，
 *     后面谁用到 `ctx.http` 就会在探针里静默 undefined。给最小接口，缺什么编译器就报什么。
 *
 *  ② **`putConcurrent` 的落点必须注入，不能写死。**
 *     引擎语义 = `updateConcurrentRate(getKey(), v)`（真改本进程的限频表）；但**试跑不该改限频**
 *     ——验证一条字段规则不是「运行期调参」。故 `opts.onPutConcurrent` 缺省为 no-op：
 *     脚本拿到的返回值仍与真跑一致（`true`），副作用被隔离在探针之外。
 *
 *  ③ **`getHeaderMap()` 缺省 `{}`（不是报错）。**
 *     引擎注入「源 header 规则 ⊕ 登录头」；探针没有请求上下文，只能给空表。这是**诚实边界**：
 *     依赖 `this.getHeaderMap()` 里签名字段的脚本，试跑结果可能与真跑不同 —— 已在
 *     `docs/ref/doctor-editor-assist-2026-10-20.md` 的边界表里登记。
 */

import type { SourceStubCtx } from './contract';
import { makeSourceLoginStub } from './source-login';

/**
 * 源桩所需的**最小**上下文 —— 定义在契约层（`contract/engine.ts`），
 * 因为 `source-login.ts` 也要用它，放在本文件会形成循环。
 * `EngineContext` 结构性满足它 ⇒ 引擎直接传 `ctx` 即可。
 */
export type { SourceStubCtx };

/** 源桩的可注入点（见头注 ②③） */
export interface SourceStubOpts {
  /**
   * 源级请求头（源 header 规则 ⊕ 登录头）——
   * `source.getHeaderMap()` / jsLib 里 `this.getHeaderMap()` 用。
   */
  sourceHeaders?: () => Record<string, string>;
  /**
   * `putConcurrent(v)` 的落点。引擎注入 ⇒ 真改限频；
   * 试跑不注入 ⇒ **不改本进程限频表**（脚本仍拿到 `true`，与真跑同形）。
   */
  onPutConcurrent?: (v: unknown) => void;
}

export const SOURCE_KV_SLOT = '__sourceKV';

/** 读 `source.get/put` 的内存副本（解析失败/未 prime → 空表） */
function readSourceKv(ctx: SourceStubCtx): Record<string, string> {
  const raw = ctx.variables.get(SOURCE_KV_SLOT);
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    return o as Record<string, string>;
  } catch {
    return {};
  }
}

/** Legado `BaseSource.get(key)`：取不到回**空串**（不是 undefined、也不回退到源字段） */
function sourceKvGet(ctx: SourceStubCtx, k: unknown): string {
  const v = readSourceKv(ctx)[String(k)];
  return v == null ? '' : String(v);
}

/** Legado `BaseSource.put(key, value)`：写入并**返回 value**（语料 `return source.put(...)` 依赖） */
function sourceKvPut(ctx: SourceStubCtx, k: unknown, v: unknown): string {
  const value = v == null ? '' : String(v);
  const map = readSourceKv(ctx);
  map[String(k)] = value;
  ctx.variables.set(SOURCE_KV_SLOT, JSON.stringify(map));
  return value;
}

/**
 * 规则对象在**上游是 Kotlin data class**（`SearchRule` / `ExploreRule` / `TocRule` / `ContentRule`），
 * 所以 `String(source.ruleSearch)` 得到的是 `SearchRule(bookList=<js>…</js>, name=…)`。
 *
 * 为什么必须复刻（qyyuapi 系 `user_Check`，实测）：它把
 * `String(source.ruleSearch) + String(source.ruleExplore) + String(source.ruleToc) +
 *  String(source.ruleContent) + String(source.variableComment)` 送进 `java.md5Encode` 比对激活表。
 * 我们这边这些字段是普通 JS 对象 ⇒ 字符串化是 `[object Object]` ⇒ MD5 永远不在表里 ⇒
 * `User` 恒为假、激活后仍只出兜底 1 条。
 *
 * ⚠️ 只要求「属性名紧贴值」（`bookList=<js>` / `chapterList=<js>` / `content=<js>`）：
 * 上游取签名的正则会把 `List=` / `content=` 前后全剥掉，所以**字段顺序与类名不影响 hash**
 * （实测 MYCOMIC 用 4 段 `<js>` 原串 + `variableComment` 算出的 md5 命中官方 `_v31_1` 签名）。
 *
 * ⚠️ 方法不能跨 `postMessage`：worker 侧 `__yueduPrepareBindings` 会在 structuredClone 之后
 * 按同一形态**重建** toString（见 sandbox/worker-pool.ts）。
 */
const RULE_BEAN_CLASSES: Record<string, string> = {
  ruleSearch: 'SearchRule',
  ruleExplore: 'ExploreRule',
  ruleToc: 'TocRule',
  ruleContent: 'ContentRule',
};

/** 给规则对象挂上 Kotlin data class 风格的 `toString`（非枚举：不污染 `Object.keys`/JSON） */
export function attachRuleBeanToString<T extends Record<string, unknown>>(obj: T, cls: string): T {
  try {
    Object.defineProperty(obj, 'toString', {
      value: function (this: Record<string, unknown>): string {
        const parts: string[] = [];
        for (const k of Object.keys(this)) {
          const v = this[k];
          parts.push(`${k}=${v == null ? 'null' : String(v)}`);
        }
        return `${cls}(${parts.join(', ')})`;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* 冻结对象等：保持原样（字符串化退回 [object Object]，与修前一致） */
  }
  return obj;
}

/**
 * Legado `bindings["source"] = BaseSource` 的桩：规则字段 + BaseSource 的 JS 方法。
 * 方法不再是「可下钻空桩」（那样 `source.getLoginInfoMap().get("账号")` 会 TypeError），
 * 而是真实现：getKey / get / put / getVariable / setVariable / getLoginInfoMap /
 * getHeaderMap / putLoginHeader / getComment / hasLogin（BaseSource.kt:95-230）。
 */
export function makeSourceStub(
  ctx: SourceStubCtx,
  rule: Record<string, unknown> | undefined,
  opts?: SourceStubOpts,
): Record<string, unknown> | undefined {
  if (!rule) return undefined;
  const stub: Record<string, unknown> = {
    ...rule,
    bookSourceUrl: String(rule.bookSourceUrl ?? ''),
    bookSourceName: String(rule.bookSourceName ?? ''),
    bookSourceGroup: String(rule.bookSourceGroup ?? ''),
    loginUrl: String(rule.loginUrl ?? ''),
    bookSourceType: Number(rule.bookSourceType ?? 0),
    // Legado `BaseSource.getKey()` 在 Rhino 里是 **JavaBean 属性**：源脚本两种写法都有——
    // `source.getKey()`（42 源）与 `source.key`（26 源，如 51漫画 exploreUrl）。
    // 早期只桩了方法 → `source.key` 得到 undefined，拼出 `undefined/category` 的 URL，
    // 随后 `.select('script').find(...).html()` 炸「Cannot read properties of undefined」。
    key: String(rule.bookSourceUrl ?? ''),
    getKey: () => String(rule.bookSourceUrl ?? ''),
    /**
     * `#682` **JavaBean getter 面**：Legado 的 `BookSource` 是 Kotlin data class，
     * JVM 会为每个 `var` 生成 `getXxx()`，Rhino 里源脚本可以直接调
     * `source.getBookSourceUrl()` —— 语料实测用到 `source.getXxx()` 的源有 113 个、556 处
     * （`getVariable` 261 / `getLoginInfoMap` 144 / `getKey` 68 / … / `getBookSourceUrl` 3）。
     *
     * 本仓此前只给了**字段**（`source.bookSourceUrl`），方法面缺 ⇒ 脚本写
     * `try{root=String(source.getBookSourceUrl())}catch(e){root=''}` 时静默拿到空串
     * ⇒ 黄果短剧的「线路域名」取不到，详情/选集 URL 回落到当前页 baseUrl
     * （`…/ai-duanju/1/video/10841/`）⇒ 站点 404 页「页面不存在或已下架」。
     */
    getBookSourceUrl: () => String(rule.bookSourceUrl ?? ''),
    getBookSourceName: () => String(rule.bookSourceName ?? ''),
    getBookSourceGroup: () => String(rule.bookSourceGroup ?? ''),
    getBookSourceType: () => Number(rule.bookSourceType ?? 0),
    getBookSourceComment: () => String(rule.bookSourceComment ?? ''),
    getLoginUrl: () => String(rule.loginUrl ?? ''),
    getHeader: () => String(rule.header ?? ''),
    getJsLib: () => String(rule.jsLib ?? ''),
    /**
     * `source.get(k)` / `source.put(k, v)` —— Legado `BaseSource.kt:345-356`。
     *
     * ⚠️ **这是一套与 `getVariable/setVariable` 完全不同的命名空间**（2026-09-23 修，缺陷类AN）：
     * Legado 里
     *   · `setVariable(v)` / `getVariable()` → `CacheManager` 键 `sourceVariable_<源key>`（一个 JSON 串）
     *   · `put(k, v)`      / `get(k)`        → `CacheManager` 键 `v_<源key>_<k>`（**逐个键**独立存盘）
     * 两者都落盘、都跨请求可读，但**互不相干**。
     *
     * 我们此前把 `get` 实现成「读源规则字段」、`put` 实现成「写本次请求的 variables」——
     * 两条都不对：`get` 语义错（读到了字段而不是缓存），`put` **根本不落盘**。
     *
     * 实测症状（🏷七猫四合一本地版「发现页无内容卡片：站点返回 {"Status":"Unauthorized"}」）：
     * 该源 jsLib 的 `qmDevice()` 把设备指纹缓存在 `source.get('qm_device') / source.put('qm_device', …)`，
     * `qmLogin()` 把 token 缓存在 `source.get('qm_token') / put('qm_token', …)`。
     * 因为 `put` 不落盘，**每次调用 `qmDevice()` 都重新随机生成 uuid / device_id**：
     *   · 登录请求声称设备 A ⇒ 站点签发**绑定设备 A** 的 token；
     *   · 紧接着的榜单请求又生成设备 B 拼进 `qm-params`（并据此算 `sign`）
     *     ⇒ 站点判「token 与设备不符」⇒ 回 `{"Status":"Unauthorized"}`。
     * 留痕证据：`data/kv.json` 里 `source-var:____________` 与 `source-cache:____________` 均为 `{}`
     * （设备/token 一个都没存下来），而同一轮的 `[ajax:L1] POST …/login/tourist` 是 **200 登录成功**。
     * 站点侧因果链清晰：**登录成功 + 后续带 token 的请求被拒** = 请求方身份漂移。
     */
    get: (k: unknown) => sourceKvGet(ctx, k),
    put: (k: unknown, v: unknown) => sourceKvPut(ctx, k, v),
    /**
     * `source.getVariable()` —— 源码里**从未设置过**时返回 **空串**，不是 `'{}'`。
     *
     * ★★ 上游：`BaseSource.kt:336-338`
     * ```kotlin
     * fun getVariable(): String { return CacheManager.get("sourceVariable_${getKey()}") ?: "" }
     * ```
     * 我们此前写的是 `?? '{}'` —— **这一个字符级的差异会造成整源不可用**，因为
     * 大量源的第一句就是：
     * ```js
     * try { $$$ = JSON.parse(source.getVariable()); if ($$$ == null) throw new Error(); …backfill… }
     * catch (e) { $$$ = original; put($$$); }      // ← 首次运行靠**这里**初始化
     * ```
     * 上游返回 `''` ⇒ `JSON.parse('')` **抛错** ⇒ 走 `catch` ⇒ `$$$ = original`（**有 url/name 的完整默认对象**）。
     * 我们返回 `'{}'` ⇒ 解析**成功** ⇒ `catch` **永不触发** ⇒ 那个 `original` 永远用不上，
     * 而回填代码只补了 `usedIndexes/weekIndex/tag/shunt/lineType/intlLinkIndex/seaLinkIndex`
     * （**没有 `url`、没有 `name`**）⇒ `$$$.url === undefined`。
     *
     * ★ 实测（`#148`，禁漫天堂（`data/sources/book-482/https___jmcomicui.net.json`）`action:'home'`）：
     * ```text
     * {"name":"[▶ undefined ◀]","value":"","header":true}
     * {"name":"全部","value":"undefined/albums?o=mr&page={{page}}"}   ← ★ `undefined` 被拼进 URL
     * ```
     * ⇒ 请求打到 `undefined/albums` 这种地址 ⇒ **发现页 items=0**（原工单记的现象是
     * `GET https://com18j-hbd.space/albums` 无 query —— 同一成因：URL 由 `undefined` 参与拼接）。
     *
     * ⚠️ 顺带纠正原工单里的一个**错误前提**：`#127` 猜「源变量 `usedIndexes` 把标题行也算进候选了」。
     * `usedIndexes` 是**源自己**在 `loginUrl` 里维护的变量（`getRandomUnusedIndex()` 用来在
     * `regexList` 里随机挑一条线路提取正则），**与探索页分类下标毫无关系**；
     * 上游整仓**零处**出现该标识符（已全仓 grep 核实）。
     */
    getVariable: () =>
      (ctx.variables.get('sourceVariable') as string | undefined) ?? '',
    /**
     * ★ **bean 属性形态**（`#317`）：上游 Rhino 把 bean getter 暴露成同名属性
     * （`BaseSource.getVariable()` = `CacheManager.get(...) ?: ""` ⇒ **空串**），
     * 源脚本 `source.variable` **等价于** `source.getVariable()`。缺了它，
     * `String(source.variable) || "默认"` 的防空写法会拿到 `"undefined"`（truthy）⇒ 兜底失效。
     */
    get variable() {
      return (ctx.variables.get('sourceVariable') as string | undefined) ?? '';
    },
    setVariable: (v: unknown) => {
      ctx.variables.set('sourceVariable', String(v));
    },
    /**
     * —— Legado `BaseSource` 登录信息 / 登录头 API（`#314` 收敛为**唯一实现**）——
     *
     * 上游这些方法在 `BaseSource`（BookSource / RssSource / HttpTts 公共父类，`BaseSource.kt:257`），
     * **不是书源专有**；此前本仓把它们内联在这一个桩里，rss 引擎整块没有 ⇒ 订阅源脚本
     * `source.getLoginInfoMap()` 直接 `is not a function`、分类脚本整段崩（用户 2026-10-07 报障）。
     * 现在两个引擎都展开 `makeSourceLoginStub(ctx)`（`@yuedu/core` 的 `source-login.ts`）。
     *
     * 落点：`ctx.variables['__loginInfo']`（JSON 串，primeSourceState 预置、persistSourceState 落盘）。
     * 返回形态：**方括号与 `.get()` 都可用**（上游 Rhino 为 `java.util.Map` 做了 `CatchableNativeJavaMap` 桥；
     * 语料实测 45 处里 `.get()` 35 处、`["键"]` 10 处 —— 旧实现返回 JS `Map`，方括号恒 undefined）。
     */
    ...makeSourceLoginStub(ctx),
    // Legado `BaseSource.getHeaderMap(hasLoginHeader = false)`：源 header 规则解析出的 Map。
    // 旧实现是**空桩** → 源里 `this.getHeaderMap()` 拿不到签名字段 → 请求被站点拒（静默失败形态）。
    getHeaderMap: () => opts?.sourceHeaders?.() ?? {},
    getComment: () => String(rule.bookSourceComment ?? ''),
    /** Legado `BaseSource.putVariable(String?)`（BaseSource.kt:325）——与 setVariable 同一落点 */
    putVariable: (v: unknown) => {
      ctx.variables.set('sourceVariable', v == null ? '{}' : String(v));
    },
    /** Legado `BookSource.putLoginInfoMap(Map)` —— 表单式登录信息写入 */
    putLoginInfoMap: (m: unknown) => {
      try {
        const obj = m instanceof Map ? Object.fromEntries(m as Map<string, string>) : (m as Record<string, unknown>);
        ctx.variables.set('__loginInfo', JSON.stringify(obj ?? {}));
        return true;
      } catch {
        return false;
      }
    },
    // —— App 端 UI/调度动作（BaseSource.kt:361-389）：服务端无对应语义 ——
    // 源脚本调用它们是为了让 **App 清缓存/改并发**；这里给无害桩，避免 `is not a function` 打挂整条规则。
    refreshExplore: () => true,
    refreshJSLib: () => true,
    // ⚙️ `#331`：`putConcurrent(value)` 上游 = `updateConcurrentRate(getKey(), value)`（BaseSource.kt:401）
    // —— 真实现不是桩：改源限频（记录表 keyed by sourceId，闸门 tryAcquire 优先用 rec.spec）。
    putConcurrent: (v: unknown) => {
      opts?.onPutConcurrent?.(v);
      return true;
    },
    hasLogin: () => !!String(rule.loginUrl ?? '').trim() || !!String(rule.loginUi ?? '').trim(),
  };
  /**
   * 规则对象按上游 Kotlin data class 的 `toString` 形态包装（见 `attachRuleBeanToString`）。
   * 复制一份再挂方法：不污染引擎自己持有的 raw rule（那边仍按 JS 对象读字段）。
   */
  for (const [key, cls] of Object.entries(RULE_BEAN_CLASSES)) {
    const v = stub[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      stub[key] = attachRuleBeanToString({ ...(v as Record<string, unknown>) }, cls);
    }
  }
  return stub;
}
