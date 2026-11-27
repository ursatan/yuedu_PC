/**
 * 引擎注册表 + 门面分发
 *
 * 上层只认识这里，不认识任何具体引擎。
 * 新增引擎 = 实现 RuleEngine 接口 + 往 registry 里一注册，其他代码零改动。
 */

import type { RuleEngine, EngineContext, CompileResult, ValidationIssue } from './contract/engine';
import type { UnifiedRequest, UnifiedListResult, EngineAction } from './contract/types';
import { EngineError } from './contract/error';

// 用 unknown 擦掉泛型，让注册表能同时持有不同 TRule 的引擎。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEngine = RuleEngine<any, any>;

export class EngineRegistry {
  private engines = new Map<string, AnyEngine>();

  /** 注册引擎。重复注册同名会抛错，避免静默覆盖 */
  register(engine: AnyEngine): void {
    if (this.engines.has(engine.kind)) {
      throw new Error(`引擎已注册: ${engine.kind}`);
    }
    this.engines.set(engine.kind, engine);
  }

  unregister(kind: string): void {
    this.engines.get(kind)?.dispose?.();
    this.engines.delete(kind);
  }

  get(kind: string): AnyEngine | undefined {
    return this.engines.get(kind);
  }

  list(): Array<{ kind: string; version: string; capabilities: EngineAction[] }> {
    return [...this.engines.values()].map((e) => ({
      kind: e.kind,
      version: e.version,
      capabilities: e.capabilities,
    }));
  }

  /**
   * 自动识别：问每个引擎「这份配置你认不认」，第一个认的接管。
   * 全都不认则抛 SOURCE_INVALID。
   *
   * ## `#652` `preferred` 是**提示**，不是**强制**
   * 旧实现 `if (preferred) { const e = get(preferred); if (e) return e; }` —— 只要库里有这个
   * kind 就直接返回它，**不看它认不认这份配置**。于是「kind 列存错」的源永远装不起来：
   * 三条实测（`#652`）的 raw 分别是 RSS / RSS / MacCMS，kind 却是 `legado` ⇒
   * `RULE_PARSE@validate · 不是 Legado 书源`，报错指向**规则**，把人查偏（用户原话：
   * 「源库里有 3 条编译失败」，看着像规则坏了）。
   * 现在：preferred 自己认才用它，不认就继续自动识别（引擎的 `detect` 本来就是唯一判据）。
   */
  detect(raw: unknown, preferred?: string): AnyEngine {
    if (preferred) {
      const e = this.engines.get(preferred);
      if (e) {
        /**
         * 声明 `preferredOnly` 的引擎（内置演示源）：`detect` 恒 false 是**设计**，
         * 它本来就只靠 kind 提示认领 ⇒ 尊重提示。
         */
        if (e.preferredOnly) return e;
        let ok = false;
        try {
          ok = e.detect(raw);
        } catch {
          ok = false; // 该引擎的 detect 自己抛错 ⇒ 当它不认
        }
        if (ok) return e;
      }
    }
    for (const e of this.engines.values()) {
      try {
        if (e.detect(raw)) return e;
      } catch {
        // 某个引擎 detect 抛错不能影响其他引擎
      }
    }
    throw new EngineError('SOURCE_INVALID', 'validate', {
      engine: '-',
      sourceId: '',
      input: raw,
      trace: [],
    });
  }

  /** 编译。编译结果由调用方缓存（key 建议是源的 URL） */
  compile(raw: unknown, preferred?: string): { engine: AnyEngine; result: CompileResult<unknown> } {
    const engine = this.detect(raw, preferred);
    return { engine, result: engine.compile(raw) };
  }

  /** 统一分发入口 */
  async invoke(
    raw: unknown,
    req: UnifiedRequest,
    ctx: EngineContext,
    preferred?: string,
  ): Promise<UnifiedListResult> {
    const engine = this.detect(raw, preferred);
    const result = engine.compile(raw);
    if (!result.ok || !result.rule) {
      throw new EngineError('RULE_PARSE', 'validate', {
        engine: engine.kind,
        sourceId: ctx.sourceId,
        input: result.issues,
        trace: ctx.trace.tail(20),
      });
    }

    const fn =
      req.action === 'search'
        ? engine.search
        : req.action === 'home'
          ? engine.home
          : req.action === 'category'
            ? engine.category
            : undefined;

    if (!fn) {
      throw new EngineError('UNSUPPORTED_ACTION', 'validate', {
        engine: engine.kind,
        sourceId: ctx.sourceId,
        rule: req.action,
        trace: ctx.trace.tail(20),
      });
    }

    return fn.call(engine, result.rule, req, ctx) as Promise<UnifiedListResult>;
  }

  /** 批量静态校验（导入源时用） */
  validateAll(raw: unknown): Array<{ kind: string; issues: ValidationIssue[] }> {
    const out: Array<{ kind: string; issues: ValidationIssue[] }> = [];
    for (const e of this.engines.values()) {
      if (!e.detect(raw)) continue;
      const result = e.compile(raw);
      const issues = [...result.issues, ...(e.validate?.(result.rule) ?? [])];
      out.push({ kind: e.kind, issues });
    }
    return out;
  }

  dispose(): void {
    for (const e of this.engines.values()) e.dispose?.();
    this.engines.clear();
  }
}

/** 全局单例。一般够用；要做多租户/测试隔离就自己 new 一个 */
export const registry = new EngineRegistry();
