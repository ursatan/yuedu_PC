/**
 * LoginUiV2（`loginUi` = `{"version":2}`）—— 逐条对齐 Legado `model/login/LoginUiV2.kt`
 * + `ui/login/SourceLoginV2Delegate.kt` 的**协议层**（渲染校验 / 动作结果四命令 / 取值优先级）。
 *
 * ⚠️ 与 v1 的关键区别（照抄，不要"顺手统一"）：
 *  1. **`loginUi` 字段本身只是一个标记**（`{"version":2}`）；真正的登录脚本在 **`loginUrl`** 里
 *     （Legado `BaseSource.getLoginJs()`），且该脚本必须定义两个**全局函数**：
 *       · `loginUi(state)`                     → 返回 `{"rows":[…]}` 的 JSON 字符串
 *       · `loginAction(action, state, form)`   → 返回下面「动作结果」的 JSON 字符串
 *  2. 行的存储键是 **`key`**（不是 v1 的 `name`）；`name` 只是显示名，`label` 行可以没有 key。
 *  3. 动作结果是**命令**（`state` / `error` / `login` / `close`）而不是"跑完就算成功"。
 *
 * 语料现状：**484 源中精确 `{version:2}` 对象 0 个**（`loginUi` 37 个里 19 脚本 / 18 JSON 数组）。
 * 因此本模块**没有真实源可端到端验证**，只能按 Legado 源码逐条对齐 + 单测锁行为 —— 出现真实源时再补验证。
 */
import type { LoginField } from './types';

/** Legado `LoginUiV2.MARKER` */
export const LOGIN_UI_V2_VERSION = 2;

/** 判定是否 V2：必须是 JSON **对象**且 `version == 2`（Legado `LoginUiV2.isV2`：非 `{` 开头直接否） */
export function isLoginUiV2(loginUi: unknown): boolean {
  const text = String(loginUi ?? '').trim();
  if (!text.startsWith('{')) return false;
  try {
    const o = JSON.parse(text) as { version?: unknown } | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    return Number((o as { version?: unknown }).version) === LOGIN_UI_V2_VERSION;
  } catch {
    return false;
  }
}

/** V2 行类型（Legado `RowUi.Type`，六个值） */
export const LOGIN_V2_ROW_TYPES = ['text', 'password', 'button', 'label', 'toggle', 'select'] as const;

/** 需要 `key` 的行（渲染后其值进入 form / loginInfo） */
const KEYED_TYPES = new Set(['text', 'password', 'select', 'toggle']);
/** 带 `action` 的行（点击/切换后派发动作） */
const ACTION_TYPES = new Set(['button', 'toggle']);

/** Legado `RowUi.isValid()` 的逐条翻译 */
function isRowValid(row: LoginField): boolean {
  if (!String(row.name ?? '').trim()) return false; // name 不得为空
  if (typeof row.countdown === 'number' && row.countdown < 0) return false; // countdown 不得为负
  const key = row.key;
  switch (row.type) {
    case 'text':
    case 'password':
      return !!key && String(key).trim() !== '';
    case 'label':
      return true;
    case 'select':
      return !!key && String(key).trim() !== '' && Array.isArray(row.options) && row.options.length > 0;
    case 'toggle':
      return (
        !!key &&
        String(key).trim() !== '' &&
        // value 只允许 null / 'true' / 'false'（Legado 同）
        (row.value == null || row.value === 'true' || row.value === 'false') &&
        (row.action == null || String(row.action).trim() !== '')
      );
    case 'button':
      return !!row.action && String(row.action).trim() !== '';
    default:
      return false; // 未知 type 一律非法（Legado `else -> false`）
  }
}

/** 归一一行（容忍缺省字段；`type` 缺省 = text，对齐 `RowUi.type` 默认值） */
function normalizeRow(raw: unknown): LoginField | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x)) : undefined;
  const row: LoginField = {
    name: String(o['name'] ?? ''),
    type: String(o['type'] ?? 'text').trim() || 'text',
  };
  const put = (k: keyof LoginField, v: unknown, as: 'string' | 'number') => {
    if (v == null) return;
    const bag = row as unknown as Record<string, unknown>;
    if (as === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) bag[k] = v;
      return;
    }
    bag[k] = String(v);
  };
  put('action', o['action'], 'string');
  put('key', o['key'], 'string');
  put('hint', o['hint'], 'string');
  put('value', o['value'], 'string');
  put('default', o['default'], 'string');
  put('countdown', o['countdown'], 'number');
  const chars = strArr(o['chars']);
  if (chars) row.chars = chars;
  const options = strArr(o['options']);
  if (options) row.options = options;
  const style = o['style'];
  if (style && typeof style === 'object' && !Array.isArray(style)) {
    const s = style as Record<string, unknown>;
    const g = typeof s['layout_flexGrow'] === 'number' ? (s['layout_flexGrow'] as number) : undefined;
    const b =
      typeof s['layout_flexBasisPercent'] === 'number'
        ? (s['layout_flexBasisPercent'] as number)
        : undefined;
    if (g !== undefined || b !== undefined) row.style = { ...(g !== undefined ? { flexGrow: g } : {}), ...(b !== undefined ? { flexBasisPercent: b } : {}) };
  }
  // `viewName` 是 Android 视图类名，Web/PC 无意义 → 有意丢弃（见路线图 §5 边界原则 1）
  return row;
}

/**
 * 解析渲染结果（Legado `LoginUiV2.parseRender`）。
 * 返回 `null` 表示「格式错误」——调用方**必须**当作渲染失败处理（不要退化成空表单）。
 */
export function parseLoginUiV2Render(json: unknown): LoginField[] | null {
  const text = typeof json === 'string' ? json.trim() : '';
  if (!text) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rowsRaw = (obj as { rows?: unknown }).rows;
  if (!Array.isArray(rowsRaw)) return null;
  const rows: LoginField[] = [];
  for (const r of rowsRaw) {
    const row = normalizeRow(r);
    if (!row) return null;
    rows.push(row);
  }
  if (!rows.length) return null;
  if (rows.some((r) => !isRowValid(r))) return null;
  // key / action 必须唯一（Legado：keys.size != keys.distinct().size 即判非法）
  const keys = rows.filter((r) => KEYED_TYPES.has(r.type)).map((r) => String(r.key));
  if (new Set(keys).size !== keys.length) return null;
  const actions = rows.filter((r) => ACTION_TYPES.has(r.type)).map((r) => String(r.action));
  if (new Set(actions).size !== actions.length) return null;
  return rows;
}

/** 动作结果（Legado `LoginUiV2.ActionResult`） */
export interface LoginUiV2Action {
  /** 下一条渲染用的会话状态（JSON 字符串）；为空表示**不重渲染** */
  stateJson?: string;
  /** 字段级错误（key → 文案）；key 不在表单里时前端按 toast 处理 */
  error?: Record<string, string>;
  /** 要保存的登录信息（JSON 字符串） */
  loginJson?: string;
  /** 关闭登录对话框 */
  close: boolean;
  /** 协议外的键（Legado 记日志后忽略） */
  unknownKeys: string[];
  /** 命令本身格式非法（调用方应提示"返回了无效命令"并**不要**改状态） */
  malformed: boolean;
}

/** 合法命令名（Legado `knownCommands`） */
const KNOWN_COMMANDS = new Set(['state', 'error', 'login', 'close']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 解析动作结果（Legado `LoginUiV2.parseActionResult`）。
 * ⚠️ 类型不符一律 `malformed = true`（Legado 会对 state/error/login 非对象、close 非布尔直接判非法）。
 */
export function parseLoginUiV2Action(json: unknown): LoginUiV2Action {
  const text = typeof json === 'string' ? json.trim() : '';
  if (!text) return { close: false, unknownKeys: [], malformed: false };
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { close: false, unknownKeys: [], malformed: true };
  }
  if (!isPlainObject(obj)) return { close: false, unknownKeys: [], malformed: true };

  const state = obj['state'];
  const error = obj['error'];
  const login = obj['login'];
  const close = obj['close'];
  if (state != null && !isPlainObject(state)) return { close: false, unknownKeys: [], malformed: true };
  if (login != null && !isPlainObject(login)) return { close: false, unknownKeys: [], malformed: true };
  if (error != null && !isPlainObject(error)) return { close: false, unknownKeys: [], malformed: true };
  if (close != null && typeof close !== 'boolean') return { close: false, unknownKeys: [], malformed: true };

  let errors: Record<string, string> | undefined;
  if (isPlainObject(error)) {
    errors = {};
    for (const [k, v] of Object.entries(error)) {
      // 值必须是可字符串化标量（GSON 的 Map<String,String> 语义：对象/数组会解析失败）
      if (v != null && typeof v === 'object') return { close: false, unknownKeys: [], malformed: true };
      errors[k] = v == null ? '' : String(v);
    }
  }
  return {
    ...(state != null ? { stateJson: JSON.stringify(state) } : {}),
    ...(errors ? { error: errors } : {}),
    ...(login != null ? { loginJson: JSON.stringify(login) } : {}),
    close: close === true,
    unknownKeys: Object.keys(obj).filter((k) => !KNOWN_COMMANDS.has(k)),
    malformed: false,
  };
}

/**
 * 字段取值优先级（Legado `LoginUiV2.resolveFieldValue`）：
 * `row.value` → 本次会话已输入值 → 已保存的 loginInfo。
 */
export function resolveLoginFieldValue(
  renderValue?: string | null,
  sessionInput?: string | null,
  stored?: string | null,
): string | undefined {
  if (renderValue != null) return renderValue;
  if (sessionInput != null) return sessionInput;
  if (stored != null) return stored;
  return undefined;
}

/** 渲染行的 key（text/password/select/toggle）；label 行返回 undefined */
export function loginRowKey(row: LoginField): string | undefined {
  return KEYED_TYPES.has(row.type) ? row.key : undefined;
}
