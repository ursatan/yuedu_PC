/**
 * 字典规则导入的**纯解析**（`#267`，用户 2026-10-04：字典导入从「点了直接进列表」
 * 改为「先预览（解析条数、新增/重复/错误），确认后再导入」）。
 *
 * 与 `#266` 净化规则导入同一纪律：解析/判重是纯函数，预览与入库用同一份实现；
 * 判重 key = `name`（Legado `DictRule.kt` 的 `@PrimaryKey` 就是 name，同名即同一本）。
 * 纯函数、无 IO ⇒ 可单测；store 的 `importRules` 只负责按 dedupe 模式落库。
 */
import type { DictRule } from '@yuedu/core/contract';

export function dictDedupeKey(r: Pick<DictRule, 'name'>): string {
  return r.name;
}

/** 解析结果（不含判重 —— 判重要对照「现有库」与批内，由调用方拿 {@link dictDedupeKey} 做） */
export interface DictImportParse {
  parsedTotal: number;
  rules: DictRule[];
  errors: Array<{ index: number; reason: string }>;
}

/** 布尔宽容化（与净化规则导入同一套：true/false、1/0、字符串都认） */
function importBool(v: unknown, dflt: boolean): boolean {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return dflt;
}

/**
 * 解析 Legado 导出的字典规则 JSON（对象或数组均可）。
 * ⚠️ **sortNumber 一律丢弃**（由入库方重新编号）：Legado 导出的常是 0/1/2，
 * 与内置三条撞号会让 ↑↓ 失效 —— 这条语义原本就在 `importRules` 里，拆出来时一并带走。
 */
export function parseDictRulesJson(input: string): DictImportParse {
  let j: unknown;
  try {
    j = JSON.parse(input);
  } catch (e) {
    return {
      parsedTotal: 0,
      rules: [],
      errors: [{ index: 0, reason: 'JSON 解析失败：' + (e instanceof Error ? e.message : String(e)) }],
    };
  }
  const list: unknown[] = Array.isArray(j) ? j : [j];
  const rules: DictRule[] = [];
  const errors: Array<{ index: number; reason: string }> = [];
  list.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      errors.push({ index: i + 1, reason: `第 ${i + 1} 条不是 JSON 对象` });
      return;
    }
    const o = it as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
    const urlRule = typeof o['urlRule'] === 'string' ? o['urlRule'].trim() : '';
    if (!name || !urlRule) {
      errors.push({ index: i + 1, reason: `第 ${i + 1} 条缺少 name / urlRule（字典规则必需）` });
      return;
    }
    rules.push({
      name,
      urlRule,
      showRule: typeof o['showRule'] === 'string' ? o['showRule'] : '',
      enabled: importBool(o['enabled'], true),
      sortNumber: 0, // 占位：入库时按「追加末尾 / 保留同名现有位置」重新编号
    });
  });
  return { parsedTotal: list.length, rules, errors };
}
