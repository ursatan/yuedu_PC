/**
 * `#652` **`kind` 是提示，不是强制** —— 库里那列存错，源也必须能装起来。
 *
 * ## 事故
 * `#651` 统一源库时暴露出「3 条编译失败（`RULE_PARSE@validate`）」：明月书阁 / LOFTER / 示例 AppleCMS (T1)。
 * 查下来三条的 raw 分别是 **RSS / RSS / MacCMS**，而 `sources.kind` 列都是 `legado`。旧
 * `EngineRegistry.detect(raw, preferred)` 只要引擎存在就**无条件返回它**（不看它认不认这份配置）⇒
 * `LegadoEngine.compile` 报「不是 Legado 书源」⇒ 永久装不起来，而报错指向**规则**，把人带偏。
 *
 * ## 语义
 *  · `preferred` = 提示：**它认才用它**，不认就继续自动识别（`detect` 是唯一判据）；
 *  · 例外：声明 `preferredOnly` 的引擎（内置 `DemoEngine`，`detect` 恒 false 是设计）仍按提示认领。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineRegistry } from '../registry';
import type { RuleEngine, EngineContext } from '../contract/engine';
import type { UnifiedListResult, EngineAction } from '../contract/types';

/** 极简引擎桩：detect 由 `accepts` 判据决定 */
function mkEngine(kind: string, accepts: (raw: unknown) => boolean, opts: { preferredOnly?: boolean } = {}): RuleEngine {
  const e: RuleEngine = {
    kind,
    version: '0.0.0',
    capabilities: ['search'] as EngineAction[],
    detect: (raw: unknown) => accepts(raw),
    compile: (raw: unknown) => ({ ok: true, rule: raw, issues: [] }),
    search: async (_r, _req: unknown, _c: EngineContext): Promise<UnifiedListResult> =>
      ({ items: [], page: { page: 1, pageCount: 0, total: 0, hasMore: false } }) as UnifiedListResult,
  };
  return opts.preferredOnly ? { ...e, preferredOnly: true } : e;
}

const looksRss = (raw: unknown): boolean => !!raw && typeof raw === 'object' && 'sourceUrl' in (raw as Record<string, unknown>);
const looksLegado = (raw: unknown): boolean => !!raw && typeof raw === 'object' && 'bookSourceUrl' in (raw as Record<string, unknown>);

test('#652 ①：preferred 认不出这份配置 ⇒ 回落到自动识别（不再硬塞）', () => {
  const reg = new EngineRegistry();
  reg.register(mkEngine('legado', looksLegado));
  reg.register(mkEngine('rss', looksRss));
  const rssRaw = { sourceUrl: 'https://www.lofter.com' };
  // 库里 kind 写错成 legado，但内容是 RSS
  assert.equal(reg.detect(rssRaw, 'legado').kind, 'rss', '必须回落到真正认领的引擎');
  // 正常情况：提示正确就用它
  assert.equal(reg.detect({ bookSourceUrl: 'x' }, 'legado').kind, 'legado');
  assert.equal(reg.detect(rssRaw, 'rss').kind, 'rss');
});

test('#652 ②：preferredOnly 引擎仍按提示认领（演示源）', () => {
  const reg = new EngineRegistry();
  reg.register(mkEngine('legado', looksLegado));
  reg.register(mkEngine('demo', () => false, { preferredOnly: true }));
  assert.equal(reg.detect({ name: '演示源' }, 'demo').kind, 'demo');
});

test('#652 ③：全都不认 ⇒ SOURCE_INVALID（错误不被降级成「随便挑一个」）', () => {
  const reg = new EngineRegistry();
  reg.register(mkEngine('legado', looksLegado));
  assert.throws(() => reg.detect({ foo: 1 }, 'legado'), /SOURCE_INVALID|不是/);
});
