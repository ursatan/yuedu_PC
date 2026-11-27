/**
 * 用户**高亮规则**（`#262`）—— 按 `pattern` 自动高亮全书/标题（不需要用户划选）。
 *
 * ## 上游对应关系
 * 实体 `HighlightRule`（`HighlightRule.kt:23-41`，12 字段，契约已对齐）、表 `highlightRules`；
 * 服务端端点 `GET/PUT/DELETE /api/user/highlight-rules`；
 * 管理入口 = 阅读界面「更多 → 高亮规则」（对齐上游 `ReaderMenuItem.menu_highlight_rule`）。
 *
 * ## 应用语义
 * **展示时匹配**（不是落库时）：阅读器每章按当前启用的规则跑
 * `matchHighlightRules`（core，上游 `HighlightRuleMatcher` 的移植），
 * 命中区间用规则自带的样式渲染 —— **不写 highlights 表**、不可点动作栏
 * （管理在规则列表里，同上游 ContentTextView 把规则命中画进 span 但不建 BookHighlight）。
 *
 * ## scope 过滤（上游 DAO `findEnabledByBook` 的 WHERE，见契约 `highlightRuleAppliesToBook`）
 * 规则量小（几十条）⇒ 前端拿全量后按书名/源 URL 过滤，不在 SQL 里做。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  highlightRuleAppliesToBook,
  highlightRuleIsValid,
  type HighlightRule,
} from '@yuedu/core/contract';

import {
  deleteHighlightRule as deleteRemote,
  listHighlightRules as listRemote,
  putHighlightRule as putRemote,
} from '../user-data';

export const useHighlightRulesStore = defineStore('highlightRules', () => {
  const rules = ref<HighlightRule[]>([]);
  const loaded = ref(false);

  async function refresh(): Promise<void> {
    try {
      rules.value = await listRemote();
      loaded.value = true;
    } catch (e) {
      // 服务端没起（旧 bundle 还没重启 ⇒ 端点 404 也落这里）：如实留痕，不影响阅读
      console.warn('[highlight-rules] 拉取失败（服务端不可达或未重启）：', e);
    }
  }

  /** 保存（新建或编辑）。校验不过返回错误文案，通过返回 null */
  async function save(r: HighlightRule): Promise<string | null> {
    if (!highlightRuleIsValid(r)) {
      return r.pattern ? '正则无法编译，请检查写法' : '匹配内容不能为空';
    }
    try {
      await putRemote(r);
      const i = rules.value.findIndex((x) => x.uuid.toLowerCase() === r.uuid.toLowerCase());
      if (i >= 0) rules.value[i] = { ...r };
      else rules.value = [...rules.value, { ...r }];
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async function remove(id: number): Promise<void> {
    try {
      await deleteRemote(id);
    } catch (e) {
      console.warn('[highlight-rules] 删除请求失败（本地仍会移除）：', e);
    }
    rules.value = rules.value.filter((r) => r.id !== id);
  }

  /** 启/停（就地改isEnabled后保存） */
  async function toggle(id: number): Promise<void> {
    const r = rules.value.find((x) => x.id === id);
    if (!r) return;
    await save({ ...r, isEnabled: !r.isEnabled });
  }

  /** 当前书生效的规则（isEnabled + scope 子串筛选；order 已按服务端排序） */
  function enabledFor(bookName: string, origin: string): HighlightRule[] {
    return rules.value.filter((r) => highlightRuleAppliesToBook(r, bookName, origin));
  }

  const enabledCount = computed(() => rules.value.filter((r) => r.isEnabled).length);

  return { rules, loaded, enabledCount, refresh, save, remove, toggle, enabledFor };
});
