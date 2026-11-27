/**
 * 源仓库：facade 管理「已导入的源」的内存态。
 *
 * 每个源记录：原始配置 raw、编译后的 rule、检测出的 kind、以及用户可改的 state。
 * state 的读写统一走 resolveSourceState（缺省全 true）—— 这是任务 #11 要求的
 * 「每个源、每个引擎、每个类型都能启用/禁用」的统一落点。
 */
import type { SourceState } from '@yuedu/core';
import { resolveSourceState, sourceIdentityOf } from '@yuedu/core';

export interface HubSource {
  /** 稳定 ID（默认取 bookSourceUrl / apiUrl，缺失则 hash） */
  id: string;
  /** 引擎 kind：legado / applecms / ... */
  kind: string;
  /** 展示名 */
  name?: string;
  /** 原始配置（导入时存一份，便于回写 / 编辑） */
  raw: unknown;
  /** 编译后的规则（引擎私有类型） */
  rule: unknown;
  /** 归一后的开关状态，缺省全 true */
  state: Required<SourceState>;
  /** 导入时间 */
  addedAt: number;
}

/**
 * 源「身份」串：Legado 语义里 `bookSourceUrl` 就是源的主键
 * （同 url = 同一个源，改规则不换源），RSS 订阅源对应 `sourceUrl`，CMS 对应 `apiUrl`。
 * 取不到则返回空串（表示「没有稳定身份」，不参与身份反查）。
 *
 * ★ `#651`：判据**唯一实现在 core**（`sourceIdentityOf`）—— 这里只转调。
 *   此前 core 的源库存储与 facade 各写一份，正是「identity 漂移」的温床。
 */
export function sourceIdentity(raw: unknown): string {
  return sourceIdentityOf(raw);
}

export class SourceStore {
  private map = new Map<string, HubSource>();

  /**
   * `#640` **源身份 → id 反查索引**（身份 = `bookSourceUrl`/`sourceUrl`/`apiUrl`）。
   *
   * ## 为什么需要（指纹上线后的向后兼容）
   * `deriveId` 现在会给「含 URL 表外字符」的 `bookSourceUrl` 追加指纹
   * （`https://八叉书库.luoyacheng.ip-ddns.com` 这类 → 老 id 是 `https_______…`，
   * 新派生是 `https_______…-ab12cd34ef`）。用户库里的老条目 id 是**老形态**，
   * 而 `bookSourceUrl` 一个字都没变 —— 若只按新派生查重，用户再导一次同一份源
   * 就会得到**第二条**（比原来的碰撞更烦人）。
   *
   * ⇒ 查重时先按 id，再按**源身份**兜一层：身份相同就用库里原来那个 id。
   *   `Map` 保持「先到先得」（同一身份出现两条老数据时，以先加载的为准）。
   */
  private byIdentity = new Map<string, string>();

  add(s: { id: string; kind: string; name?: string; raw: unknown; rule: unknown; state?: SourceState }): HubSource {
    const full: HubSource = {
      id: s.id,
      kind: s.kind,
      name: s.name,
      raw: s.raw,
      rule: s.rule,
      state: resolveSourceState(s.state),
      addedAt: Date.now(),
    };
    this.map.set(s.id, full);
    const ident = sourceIdentity(s.raw);
    if (ident && !this.byIdentity.has(ident)) this.byIdentity.set(ident, s.id);
    return full;
  }

  get(id: string): HubSource | undefined {
    return this.map.get(id);
  }

  /** `#640` 按源身份（bookSourceUrl/sourceUrl/apiUrl）查库里已有 id；查不到返回 undefined */
  idForIdentity(identity: string): string | undefined {
    const k = String(identity ?? '').trim();
    return k ? this.byIdentity.get(k) : undefined;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  list(filter?: { kind?: string; enabled?: boolean }): HubSource[] {
    const out = [...this.map.values()].filter((s) => {
      if (filter?.kind && s.kind !== filter.kind) return false;
      if (filter?.enabled !== undefined && s.state.enabled !== filter.enabled) return false;
      return true;
    });
    // `#282` 源置顶跨页统一：上游**所有**源查询都是 `order by customOrder asc`
    // （`BookSourceDao.kt:27-101`，含 book_sources_part 视图）⇒ 置顶/置底（改 customOrder，
    // 见 server 置顶路由）必须在**每一个**消费方生效 —— 发现页/规则工坊/跨源搜索/源管理
    // 的源列表都来自这里。此前本方法返回 Map 插入序（= 文件扫描序），置顶只在源管理页
    // （前端自己补排 customOrder）可见，其余页纹丝不动 —— 用户实测反馈的正是这个。
    // 稳定排序（V8 Array#sort 是稳定的）⇒ 同值保持原序，未设过 customOrder 的源不受影响。
    const ord = (s: HubSource): number => {
      const v = (s.raw as Record<string, unknown> | undefined)?.['customOrder'];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    return out.sort((a, b) => ord(a) - ord(b));
  }

  /** 用户（Web/CLI）修改开关：partial 合并后重新归一 */
  setState(id: string, partial: SourceState): HubSource | undefined {
    const s = this.map.get(id);
    if (!s) return undefined;
    s.state = resolveSourceState({ ...s.state, ...partial });
    return s;
  }

  /** 整体替换 raw + 重新编译（编辑源后回写用） */
  replace(id: string, raw: unknown, rule: unknown, kind: string, name?: string): HubSource | undefined {
    const s = this.map.get(id);
    if (!s) return undefined;
    s.raw = raw;
    s.rule = rule;
    s.kind = kind;
    if (name !== undefined) s.name = name;
    // `#640` 身份索引跟着 raw 走：旧身份若指向本 id 就摘掉，再登记新身份
    for (const [k, v] of this.byIdentity) if (v === id) this.byIdentity.delete(k);
    const ident = sourceIdentity(raw);
    if (ident && !this.byIdentity.has(ident)) this.byIdentity.set(ident, id);
    return s;
  }

  remove(id: string): boolean {
    for (const [k, v] of this.byIdentity) if (v === id) this.byIdentity.delete(k);
    return this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
    this.byIdentity.clear();
  }

  size(): number {
    return this.map.size;
  }
}
