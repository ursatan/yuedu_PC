/**
 * Legado 引擎对外出口
 *
 * 进度：
 *   ✅ 旧版书源（v1）→ 新版（v3）迁移器
 *   ✅ 新版书源 JSON Schema（117 字段）
 *   ✅ 规则解析引擎（AnalyzeRule 复刻，L1 + L2-lite）
 *   ✅ BookSource 模型 + 导入检测/编译
 *   ✅ 引擎实现：search / home / detail / content（管道）
 *   ⬜ L3（java.* 完整桥接 / webView / zip）
 *   ⬜ JS 书源（mainJs 动态解析）
 */

export * from './legacy/migrate';
export * from './legacy/field-map';
export * from './model/book-source';
export { classifyLoginUrl, extractInlineJs } from './model/login';
export type { LoginKind, LoginPlan } from './model/login';
export * from './engine';
