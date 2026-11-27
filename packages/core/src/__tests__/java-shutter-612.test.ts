/**
 * `#612` **ClassShutter 敏感类可达面**回归锁。
 *
 * 依据：`F:\legado/modules/rhino/src/main/java/com/script/rhino/RhinoClassShutter.kt:47-191`
 *   · 黑名单里的类/包 ⇒ 对脚本**不可见**（`Packages.x.Y` = `undefined`）；
 *   · 语义与 `ClassNameMatcher.matchInternal` 一致：全名相等 或 包边界前缀。
 *
 * 本仓的**具体缺口**（改之前）：`Packages.*` 有「未知路径 → 调用返回空串」的兜底 Proxy，
 * 于是上游被挡的 `Packages.com.script.*` 在本仓变成**可调用、静默返回空串**。
 * 判据（legado-parity §8 `#612`）：危险类**调用抛错**（或不可见）**而不是返回空串**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isShutteredJavaPath, JAVA_SHUTTER_EXACT, JAVA_SHUTTER_PREFIX } from '../selector/java-shutter';
import { makeJavaPackages } from '../selector/java-bridge';
import { createVariableStore } from '../store';
import { createJsEvaluator } from '../selector/js';

const ev = createJsEvaluator({ variables: createVariableStore() }) as (
  code: string,
  bindings: Record<string, unknown>,
) => unknown;

test('#612 ① 包边界语义与上游 ClassNameMatcher 一致', () => {
  // 全名相等
  assert.equal(isShutteredJavaPath('java.io.File'), true);
  assert.equal(isShutteredJavaPath('java.lang.Runtime'), true);
  assert.equal(isShutteredJavaPath('java.nio.file.Files'), true);
  // 包前缀（必须落在包边界：`java.nio.file.X` 挡、`java.niofileX` 不挡）
  assert.equal(isShutteredJavaPath('java.nio.file.Paths'), true);
  assert.equal(isShutteredJavaPath('com.script.ScriptEngine'), true);
  assert.equal(isShutteredJavaPath('org.mozilla.javascript.Context'), true);
  // 非黑名单：java.io 只挡具体类，ByteArrayOutputStream 上游允许
  assert.equal(isShutteredJavaPath('java.io.ByteArrayOutputStream'), false);
  assert.equal(isShutteredJavaPath('java.lang.String'), false);
  assert.equal(isShutteredJavaPath('org.jsoup.Jsoup'), false);
  assert.equal(isShutteredJavaPath('java.niofileX.Y'), false);
  // 清单本身不为空（防止有人把整表删掉还让测试过）
  assert.ok(JAVA_SHUTTER_EXACT.length >= 40 && JAVA_SHUTTER_PREFIX.length >= 10);
});

test('#612 ② 危险类不可见：Runtime 取值 undefined，调用抛错而非返回空串', () => {
  const pkgs = makeJavaPackages() as unknown as Record<string, unknown>;
  const lang = pkgs['java'] as Record<string, unknown>;
  const langNs = lang['lang'] as Record<string, unknown>;
  assert.equal(langNs['Runtime'], undefined, 'Runtime 必须不可见（上游 ClassShutter 黑名单）');
  assert.equal(langNs['ProcessBuilder'], undefined);
  assert.equal(langNs['Class'], undefined);
  // 调用链：抛 TypeError（不是静默空串）
  assert.throws(() => ev('String(Packages.java.lang.Runtime.getRuntime().exec("id"))', {}), /getRuntime/);
});

test('#612 ③ com.script（上游整包被挡）不再是可调用空串桩', () => {
  const r = ev('typeof Packages.com.script', {});
  assert.equal(r, 'undefined', 'com.script 必须不可见');
  // 关键回归：以前这里返回 'function'，调用静默返回空串
  assert.throws(() => ev('Packages.com.script.ScriptEngine.eval("1+1")', {}), /ScriptEngine/);
});

test('#612 ④ java.lang.System.exit 抛错（上游 systemClassProtectedName）', () => {
  assert.throws(
    () => ev('Packages.java.lang.System.exit(0)', {}),
    /systemClassProtectedName/,
    '必须抛带上游依据的错误，而不是静默空',
  );
  // 正常成员不受影响
  assert.equal(typeof ev('Packages.java.lang.System.currentTimeMillis()', {}), 'number');
});

test('#612 ⑤ 正常类不受影响（jsoup / String 仍可用）', () => {
  assert.equal(typeof ev('Packages.java.lang.String("abc").length()', {}), 'number');
  assert.equal(ev('typeof Packages.org.jsoup.Jsoup', {}), 'object');
});
