/**
 * `loginUi` **开关行（`toggle`）的取值口径** —— 唯一实现（页面勾选态 / 提交值 / 回填判定三处共用）。
 *
 * ## 缺陷类别（2026-10-12 用户报：18AV「勾选了启动页，点击源还是落的分类」）
 *
 * Legado `RowUi.Toggle` 的 `chars` 是**两个字**：`[关, 开]`，**存的不是布尔串而是那个字符**。
 * 18AV 语料（`loginUi` 原文）：
 * ```json
 * { "name": "启动页", "type": "toggle", "chars": ["🔳", "✅"], "default": "✅" }
 * ```
 * 而源脚本（`startHtml` / `ruleContent`）一律按**字符**判定：
 * ```js
 * var info = source.getLoginInfoMap();
 * if (info['启动页'] != '✅') return '';          // 返回空 ⇒ 前端回落常规分类列表
 * ... info['预览截图'] == '✅' / info['自动播放'] == '✅' / info['继续播放'] == '✅' ...
 * ```
 *
 * 本仓旧实现把 toggle 一律折算成 `'true' / 'false'`
 * （`currentFormValues` 与 `onToggleChange`），于是：
 *   · 用户在对话框里勾上「启动页」→ 落盘 `"启动页":"true"`；
 *   · 源脚本 `'true' != '✅'` ⇒ **启动页永远返回空** ⇒ 点源直接落分类列表。
 * 实测取证：`GET /api/sources/<18AV id>/login-info` 回的正是 `"启动页":"true"`（不是 `✅`）。
 *
 * ## 口径
 *  · **开** = `chars[1]`（缺 `chars` 回落 `'true'` —— 兼容本仓旧数据与不写 `chars` 的源）；
 *  · **关** = `chars[0]`（缺 `chars` 回落 `'false'`）；
 *  · **判定勾选**：`v === 开值` **或** `v === 'true'`（后半个是**迁移**：老落盘的 `'true'` 仍显示为开，
 *    用户再提交一次就会被改写成 `chars[1]`，无需手工清登录信息）。
 *
 * ⚠️ 这三条必须**只有这一份**：模板的 `:checked`、`toggle` 的 `@change`、v1 的提交值
 * 三处若各写一遍，必然漂移（本仓铁律）。
 */

/** 开关的「开」值：`chars[1]`（Legado `RowUi.chars` = `[关, 开]`） */
export function toggleOnValue(f: { chars?: string[] }): string {
  const on = f.chars?.[1];
  return on == null || on === '' ? 'true' : String(on);
}

/** 开关的「关」值：`chars[0]` */
export function toggleOffValue(f: { chars?: string[] }): string {
  const off = f.chars?.[0];
  return off == null || off === '' ? 'false' : String(off);
}

/** 该行当前是否勾选（含「老数据 `'true'`」的迁移判定） */
export function isToggleOn(f: { chars?: string[] }, raw: unknown): boolean {
  const v = String(raw ?? '');
  if (!v) return false;
  return v === toggleOnValue(f) || v === 'true';
}

/** 勾选态 → 落盘值 */
export function toggleValueFor(f: { chars?: string[] }, on: boolean): string {
  return on ? toggleOnValue(f) : toggleOffValue(f);
}