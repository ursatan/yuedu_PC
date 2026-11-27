/**
 * JSON 绑定的「Java Map / List 方法」补齐（#76，类别性缺陷）。
 *
 * Legado 的 `result`（以及 JSONPath/JSON 内容绑定）是 **GSON 的 LinkedTreeMap**，
 * 在 Rhino 里是 `NativeJavaObject` → 源脚本**既能** `result.k`（属性）
 * **也能** `result.get("k")` / `size()` / `keySet()` / `values()`（Java Map API）。
 * 我们传的是普通 JS 对象 → 只支持属性访问 → `result.get is not a function`
 * （实测：点众阅读 `ruleBookInfo.kind` = `[result.get("statusTips"), result.get("comScore")+"分"]`）。
 *
 * ⚠️ **方法必须非枚举**（`defineProperty` 默认 enumerable:false）：宿主靠
 * `Object.values()` 判断「可结构化克隆」（见 `js.ts` 的 `isCloneable`），
 * 枚举的话会把这些函数算进去 → 判定不可克隆 → **含 JSON 的脚本被推回 L1**（并发退化）。
 * 非枚举属性同时也不会被 structuredClone 带过去 → **worker 侧必须再挂一次**，
 * 因此这里导出「注入源码字符串」，宿主与 worker **共用同一份**（别手抄，手抄副本已漂移两次）。
 */

/** 宿主实现（TS）：给普通对象/数组挂 Java Map/List 方法（非枚举、幂等） */
export function attachJsonMapMethods<T>(v: T): T {
  if (!v || typeof v !== 'object') return v;
  const o = v as unknown as Record<string, unknown>;
  const def = (k: string, fn: (...a: unknown[]) => unknown): void => {
    if (typeof o[k] === 'function') return; // 已挂过（幂等）
    try {
      Object.defineProperty(o, k, { value: fn, writable: true, configurable: true });
    } catch {
      /* 冻结对象/Proxy 不可定义 —— 跳过 */
    }
  };
  if (Array.isArray(v)) {
    def('get', (i: unknown) => o[Number(i)]);
    def('size', () => (v as unknown[]).length);
    def('isEmpty', () => (v as unknown[]).length === 0);
    // Java List.toArray()（全量基线 2026-10-24：`result.toArray is not a function`）
    def('toArray', () => (v as unknown[]).slice());
    return v;
  }
  const keys = (): string[] => Object.keys(o);
  def('get', (k: unknown) => o[String(k)]);
  def('containsKey', (k: unknown) => Object.prototype.hasOwnProperty.call(o, String(k)));
  def('has', (k: unknown) => Object.prototype.hasOwnProperty.call(o, String(k)));
  def('size', () => keys().length);
  def('keys', () => keys());
  def('keySet', () => keys());
  def('values', () => keys().map((k) => o[k]));
  def('entrySet', () => keys().map((k) => [k, o[k]]));
  def('isEmpty', () => keys().length === 0);
  def('put', (k: unknown, val: unknown) => {
    o[String(k)] = val;
    return val;
  });
  def('remove', (k: unknown) => {
    const prev = o[String(k)];
    delete o[String(k)];
    return prev;
  });
  return v;
}

/**
 * 沙箱注入源码（worker 侧用）：由 `worker-pool.ts` 拼进 `WORKER_SRC`。
 * ⚠️ 注释里**不能出现反引号**（整段在 TS 模板串里）。
 */
export const JSON_MAP_METHODS_SOURCE = `
function __yueduAttachJsonMap(v) {
  if (!v || typeof v !== 'object') return v;
  var def = function (k, fn) {
    if (typeof v[k] === 'function') return;
    try { Object.defineProperty(v, k, { value: fn, writable: true, configurable: true }); } catch (e) {}
  };
  if (Array.isArray(v)) {
    def('get', function (i) { return v[Number(i)]; });
    def('size', function () { return v.length; });
    def('isEmpty', function () { return v.length === 0; });
    def('toArray', function () { return v.slice(); });
    return v;
  }
  var keys = function () { return Object.keys(v); };
  def('get', function (k) { return v[String(k)]; });
  def('containsKey', function (k) { return Object.prototype.hasOwnProperty.call(v, String(k)); });
  def('has', function (k) { return Object.prototype.hasOwnProperty.call(v, String(k)); });
  def('size', function () { return keys().length; });
  def('keys', function () { return keys(); });
  def('keySet', function () { return keys(); });
  def('values', function () { return keys().map(function (k) { return v[k]; }); });
  def('entrySet', function () { return keys().map(function (k) { return [k, v[k]]; }); });
  def('isEmpty', function () { return keys().length === 0; });
  def('put', function (k, val) { v[String(k)] = val; return val; });
  def('remove', function (k) { var p = v[String(k)]; delete v[String(k)]; return p; });
  return v;
}
`;

/** 需要挂 Map/List 方法的绑定名（JSON 内容型绑定） */
export const JSON_MAP_BINDING_KEYS = ['$', 'result', 'src'] as const;
