/**
 * `#196` 回归锁：`[java-bridge] 未实现的 Java 类/成员` 这类**留痕必须带源身份**。
 *
 * 为什么必须锁：类AO 这类缺陷的症状是「静默空值」，唯一的线索就是那行 warn；
 * 不带源身份时几百个源里无从定位（用户 2026-10-02 明确指出只有 `[java-bridge]` 一个前缀）。
 *
 * 三条断言：
 *  ① 带 `sourceLabel` 求值 ⇒ warn 文本里出现 `源 名字(id)`；
 *  ② **防空转**：不带 `sourceLabel` 时**不得**出现 ` · 源 `（说明是标签在起作用，不是文案里本来就有）；
 *  ③ 求值结束后标签被复位（另一次不带标签的求值不会沿用上一个源的标签）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJsEvaluator } from '../selector/js';
import { createVariableStore } from '../store';

function captureWarn<T>(fn: () => T): { out: T; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warns.push(a.map((x) => String(x)).join(' '));
  };
  try {
    return { out: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

/** 每次用**不同的类路径**，绕过 `warnedJavaClasses` 的「每路径一次」去重 */
let seq = 0;
const uniquePath = () => `org.test196.p${(seq += 1)}`;

test('#196 java-bridge 留痕带源身份（`源 名字(id)`）', () => {
  const p = uniquePath();
  const ev = createJsEvaluator({ variables: createVariableStore(), sourceLabel: '测试源(https___t.com)' });
  const { warns } = captureWarn(() => ev(`Packages.${p}.Foo.bar()`, {}));
  const hit = warns.find((w) => w.includes('[java-bridge]'));
  assert.ok(hit, `应有 java-bridge 留痕，实得：${JSON.stringify(warns)}`);
  assert.match(hit, /源 测试源\(https___t\.com\)/, `留痕必须带源身份，实得：${hit}`);
});

test('#196 防空转：不带 sourceLabel 时不得出现「· 源」字样', () => {
  const p = uniquePath();
  const ev = createJsEvaluator({ variables: createVariableStore() });
  const { warns } = captureWarn(() => ev(`Packages.${p}.Foo.bar()`, {}));
  const hit = warns.find((w) => w.includes('[java-bridge]'));
  assert.ok(hit, '应仍有留痕（只是不带源身份）');
  assert.ok(!hit.includes('源 '), `无标签时不得凭空出现「源 」：${hit}`);
});

test('#196 求值结束后标签复位（不会把上一个源的身份串给下一次求值）', () => {
  const pA = uniquePath();
  const pB = uniquePath();
  const evA = createJsEvaluator({ variables: createVariableStore(), sourceLabel: '源A(https___a.com)' });
  const evB = createJsEvaluator({ variables: createVariableStore() });
  captureWarn(() => evA(`Packages.${pA}.x()`, {}));
  const { warns } = captureWarn(() => evB(`Packages.${pB}.x()`, {}));
  const hit = warns.find((w) => w.includes('[java-bridge]'));
  assert.ok(hit, 'B 的留痕要在');
  assert.ok(!hit.includes('源A'), `B 不得沿用 A 的标签：${hit}`);
});
