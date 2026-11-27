/**
 * 源级请求头规则求值 —— **唯一实现**（`#467`）。
 *
 * 对齐 Legado `BaseSource.getHeaderMap`：
 * `extractInlineJs(header)?.let { evalJS(it) } ?: header` 再按 JSON 对象解析，
 * 归一成 `Record<string,string>`；求值失败**不阻断请求**（上游 runCatching），只留痕。
 *
 * ## 为什么必须收敛成一处
 * 同一判据此前有**三份副本**：
 *   · `engine-rss/src/env.ts`（`#464` 才补齐脚本形态，仍各写一份）
 *   · `engine-legado/src/engine.ts`（早有，但只认小写 `<js>`，且 memo/防重入自造）
 *   · `apps/server` 的 `/api/proxy`（只解析静态 JSON，脚本形态靠自造正则识别后跳过）
 * 「同一上游判据在两处各写一份 ⇒ 单边修好另一处漂移」是本仓反复踩的缺陷类
 * （先例：`#313` 规则桥、`#314`/`#315` 登录共享件）。`#464` 只在 RSS 侧补了一条，
 * `#467` 把整条判据下沉到这里，两引擎 + 服务端代理共用。
 */
import { extractInlineJs } from '../login-model';
import type { VariableStore } from '../contract/engine';

/**
 * memo 在 `EngineContext.variables` 里的落点（**每请求一份**）。
 *
 * 为什么落 variables Map 而不是闭包局部变量：
 *   · hybrid worker 池与宿主共享同一个 variables Map —— worker 里执行的脚本
 *     `source.getHeaderMap()` 经 RPC 回宿主读 memo，两边必须看到同一份；
 *   · 各请求出口（引擎 fetchText / 渲染层回落）在**尚未建求值器**时也要同步读它。
 */
export const SOURCE_HEADERS_VAR_KEY = '__srcHeaders';

/** 防重入标志落点（header 脚本内部再取头时，先拿到「求值中」空头而不是无限递归）。 */
export const SOURCE_HEADERS_RUNNING_KEY = '__srcHeadersRunning';

/**
 * 把一份 header 值归一成 `Record<string,string>`：
 * 丢空键与 null/undefined 值，其余一律 String()（与上游 GSON 解析后 putAll 同义）。
 * 非对象（含数组/标量）→ null，调用方按「返回值形状不对」留痕。
 */
export function normalizeHeaderMap(o: unknown): Record<string, string> | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k && v != null) out[k] = String(v);
  }
  return out;
}

/**
 * **纯静态**（非脚本包裹）形态解析：脚本包裹 → null；JSON 对象 → 头表；
 * JSON 数组/标量/畸形 JSON → null（调用方决定留痕口径）。
 */
export function parseStaticSourceHeader(raw: string | null | undefined): Record<string, string> | null {
  const text = String(raw ?? '').trim();
  if (!text || extractInlineJs(text) !== null) return null;
  try {
    return normalizeHeaderMap(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** 源 header 规则是否为脚本形态（`@js:` / `<js></js>`，大小写不敏感 —— 上游 AppPattern.JS_PATTERN）。 */
export function isScriptSourceHeader(raw: string | null | undefined): boolean {
  return extractInlineJs(String(raw ?? '').trim()) !== null;
}

export interface EvaluateSourceHeaderOptions {
  /** 源 header 规则原文 */
  raw: string | null | undefined;
  /**
   * 脚本形态求值器（与 JS 规则段同一求值器，含 jsLib 前导与 `source` 绑定）。
   * 静态形态不会被调用；未提供时脚本形态按空头处理（并经 `warn` 留痕）。
   */
  evalJs?: (code: string) => unknown;
  /**
   * 留痕回调（**不阻断请求**）。`message` 只放**细节**（不含源身份），
   * 由调用方拼「源名(id)」前缀（服务端排障靠源身份，见 `#196`）：
   *   · `channel='shape'` 脚本返回值不是对象；
   *   · `channel='eval'`  脚本求值抛错（message 带错误文本，cause 带原始错误，便于取栈帧）；
   *   · `channel='static'` 静态形态不是合法 JSON 对象。
   */
  warn?: (channel: 'shape' | 'eval' | 'static', message: string, cause?: unknown) => void;
}

/** 把脚本求值结果（对象或 JSON 字符串）归一成头表；非对象 ⇒ null。 */
function headerValueToMap(v: unknown): Record<string, string> | null {
  return typeof v === 'string' ? normalizeHeaderMap(JSON.parse(v) as unknown) : normalizeHeaderMap(v);
}

/**
 * 求值一份源 header 规则（**无 memo，同步求值器**；memo/防重入见 {@link createSourceHeaderResolver}）。
 *
 * @returns 头表；空规则 / 任何失败 / 非对象 ⇒ `{}`（上游 runCatching 语义）。
 */
export function evaluateSourceHeaderRule(opts: EvaluateSourceHeaderOptions): Record<string, string> {
  const raw = String(opts.raw ?? '').trim();
  if (!raw) return {};
  const inline = extractInlineJs(raw);
  if (inline === null) {
    const parsed = parseStaticSourceHeader(raw);
    if (parsed) return parsed;
    opts.warn?.('static', 'header 不是合法 JSON 对象');
    return {};
  }
  if (!opts.evalJs) {
    opts.warn?.('eval', 'header 是脚本形态但当前通路无求值器');
    return {};
  }
  try {
    // 脚本既可返回对象，也可返回 JSON 字符串（语料两种写法都有）
    const parsed = headerValueToMap(opts.evalJs(inline));
    if (parsed) return parsed;
    opts.warn?.('shape', 'header 脚本返回值不是对象');
  } catch (e) {
    opts.warn?.('eval', `header 脚本求值失败：${e instanceof Error ? e.message : String(e)}`, e);
  }
  return {};
}

/**
 * 同上，但求值器是**异步**的（hybrid / worker 池路径，`#463①`）：
 * legado 主抓取通路与 RSS prime 都用它 —— header 脚本里的 `java.ajax` 不占主线程。
 */
export async function evaluateSourceHeaderRuleAsync(
  opts: EvaluateSourceHeaderOptions,
): Promise<Record<string, string>> {
  const raw = String(opts.raw ?? '').trim();
  if (!raw) return {};
  const inline = extractInlineJs(raw);
  if (inline === null) return evaluateSourceHeaderRule(opts);
  if (!opts.evalJs) {
    opts.warn?.('eval', 'header 是脚本形态但当前通路无求值器');
    return {};
  }
  try {
    const parsed = headerValueToMap(await opts.evalJs(inline));
    if (parsed) return parsed;
    opts.warn?.('shape', 'header 脚本返回值不是对象');
  } catch (e) {
    opts.warn?.('eval', `header 脚本求值失败：${e instanceof Error ? e.message : String(e)}`, e);
  }
  return {};
}

/** 读 memo（坏了/没有 → null）。 */
export function readSourceHeaderMemo(variables: VariableStore): Record<string, string> | null {
  const memo = variables.get(SOURCE_HEADERS_VAR_KEY);
  if (typeof memo !== 'string' || !memo) return null;
  try {
    return normalizeHeaderMap(JSON.parse(memo) as unknown);
  } catch {
    return null;
  }
}

/** 写 memo（落不下静默 —— 语义退化为每次重算）。 */
export function writeSourceHeaderMemo(variables: VariableStore, headers: Record<string, string>): void {
  try {
    variables.set(SOURCE_HEADERS_VAR_KEY, JSON.stringify(headers));
  } catch {
    /* ignore */
  }
}

export interface SourceHeaderResolverOptions {
  /** 每请求新建的 variables store（memo 与防重入标志都落这里）。 */
  variables: VariableStore;
  /** 取源 header 规则原文（惰性，支持源对象后建）。 */
  getRaw: () => string | null | undefined;
  /**
   * 同步求值器（L1）。**脚本头在同步上下文被首次取用时**才用它；
   * 异步路径应先 `prime()`（worker 池，`#463①`），命中 memo 后这里永不跑脚本。
   */
  evalJs?: (code: string) => unknown;
  /** 留痕（channel 语义同 {@link EvaluateSourceHeaderOptions.warn}）。 */
  warn?: EvaluateSourceHeaderOptions['warn'];
}

export interface SourceHeaderResolver {
  /**
   * 全量取源规则头：先读 memo；没有就求值并落 memo。
   * **防重入**：header 脚本内部再取头（`java.ajax` / `source.getHeaderMap()`）⇒ 返回 `{}`。
   */
  get(): Record<string, string>;
  /**
   * 请求出口用的**同步只读**路径：有 memo 用 memo；没有就只解析**静态 JSON**，
   * **绝不跑脚本**（否则脚本里的 `java.ajax` 会在请求出口无限递归）。
   */
  readStatic(): Record<string, string>;
  /**
   * 异步预求值（`#463①`）：用 worker 池求值器跑一次脚本形态并落 memo。
   *  · 已有 memo / 非脚本形态 ⇒ 直接读回（静态形态也写 memo，统一出口形状）；
   *  · 求值中被重入（脚本里再取头）⇒ 重入方拿 `{}`；
   *  · 失败 ⇒ 落空头 memo（与同步路径同语义，且**不重复试**）。
   * 后续请求出口 `readStatic()` 即命中 memo，主线程零脚本开销。
   */
  prime(evalAsync: (code: string) => unknown | Promise<unknown>): Promise<Record<string, string>>;
  /** memo 是否已就绪（测试/调度用）。 */
  hasMemo(): boolean;
}

/**
 * 每请求一个：memo（落 variables）+ 防重入 + 同步/异步两条求值路径。
 * 两引擎的取头器都由它构造，删除各自的 memo/重入副本。
 */
export function createSourceHeaderResolver(opts: SourceHeaderResolverOptions): SourceHeaderResolver {
  const { variables, getRaw, warn } = opts;
  const hasMemo = (): boolean => readSourceHeaderMemo(variables) !== null;

  const get = (): Record<string, string> => {
    const memo = readSourceHeaderMemo(variables);
    if (memo) return memo;
    if (variables.get(SOURCE_HEADERS_RUNNING_KEY) === 1) return {};
    variables.set(SOURCE_HEADERS_RUNNING_KEY, 1);
    try {
      const out = evaluateSourceHeaderRule({ raw: getRaw(), evalJs: opts.evalJs, warn });
      writeSourceHeaderMemo(variables, out);
      return out;
    } finally {
      variables.delete(SOURCE_HEADERS_RUNNING_KEY);
    }
  };

  const readStatic = (): Record<string, string> => {
    const memo = readSourceHeaderMemo(variables);
    if (memo) return memo;
    const raw = String(getRaw() ?? '').trim();
    if (!raw) return {};
    const parsed = parseStaticSourceHeader(raw);
    return parsed ?? {};
  };

  const prime = async (evalAsync: (code: string) => unknown | Promise<unknown>): Promise<Record<string, string>> => {
    const existing = readSourceHeaderMemo(variables);
    if (existing) return existing;
    if (variables.get(SOURCE_HEADERS_RUNNING_KEY) === 1) return {};
    const raw = String(getRaw() ?? '').trim();
    // 脚本形态才需要防重入标志（静态解析不会回调任何取头器）。
    const isScript = extractInlineJs(raw) !== null;
    if (isScript) variables.set(SOURCE_HEADERS_RUNNING_KEY, 1);
    try {
      // 失败也落 memo（空头）—— 与同步路径同语义，且同一次请求内不重复试。
      const out = await evaluateSourceHeaderRuleAsync({ raw, evalJs: evalAsync, warn });
      writeSourceHeaderMemo(variables, out);
      return out;
    } finally {
      if (isScript) variables.delete(SOURCE_HEADERS_RUNNING_KEY);
    }
  };

  return { get, readStatic, prime, hasMemo };
}
