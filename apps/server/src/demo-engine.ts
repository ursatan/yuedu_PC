/**
 * 演示引擎（仅本地 UI 验证用，不参与真实解析）
 *
 * 用途：本沙箱无法访问外网书源站（Phase B 实测 30 源仅 2 源成功），
 * 为了让 Web UI 立刻看到「搜索 → SSE → 列表」的完整链路，内置一个返回
 * 模拟数据的引擎。生产环境不依赖它。
 */
import type { RuleEngine, EngineContext, UnifiedRequest, UnifiedListResult, UnifiedDetail, UnifiedContent, EngineAction } from '@yuedu/core';

export class DemoEngine implements RuleEngine<unknown, unknown> {
  readonly kind = 'demo';
  readonly version = '0.0.0';
  readonly capabilities: EngineAction[] = ['search', 'home', 'category', 'detail', 'content'];
  /** `#652`：本引擎靠 kind 提示认领（`detect` 恒 false 是设计），显式声明给注册表 */
  readonly preferredOnly = true;

  detect(): boolean {
    return false; // 不自动认领任何源；仅通过 preferred 显式注册
  }
  compile(raw: unknown) {
    return { ok: true, rule: raw, issues: [] };
  }

  async search(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedListResult> {
    const kw = (req.keyword ?? '示例').slice(0, 20);
    const base = `https://demo.local/${encodeURIComponent(kw)}`;
    return {
      items: [
        {
          id: `demo-book-1`,
          kind: 'book' as const,
          title: `《${kw}》· 正版全集`,
          subtitle: '演示作者 · 已完结 · 980万字',
          cover: `https://picsum.photos/seed/${encodeURIComponent(kw)}a/120/160`,
          summary: `这是「${kw}」的演示简介：主角在末世觉醒异能，一步步成长为顶尖强者。本书用于验证 UnifiedItem 的完整字段渲染（封面 / 简介 / 标签）。`,
          tags: ['demo', '玄幻', '末世'],
          layout: 'grid-card',
          // ⚠️ 作者/最新章节必须放进 **payload**（与真实引擎同形），别塞进 `subtitle`：
          // 真实引擎在 list 阶段按 Legado `BookList.kt` 逐条求值 `author`/`lastChapter`
          // 并随 payload 带走（`UnifiedItem` 顶层压根没有 author 字段，
          // 见 `packages/core/src/contract/types.ts:92-110`；读取器见 `apps/web/src/utils/list-item.ts`）。
          // 这个 fixture 早先把作者只放在 subtitle 里 ⇒ 前端 `itemAuthor()` 读到空
          // ⇒ **默认封面画不出作者**、② 行也会退化成 subtitle 兜底 —— fixture 与真实源不一致的活样本。
          payload: { url: base + '/1', author: '演示作者', lastChapter: '第 30 章 演示章节' },
        },
        {
          id: `demo-video-1`,
          kind: 'video' as const,
          title: `${kw}· 高清剧场版`,
          subtitle: '1080P · 国语',
          cover: `https://picsum.photos/seed/${encodeURIComponent(kw)}b/120/160`,
          summary: `「${kw}」影视演示条目，验证视频类 UnifiedItem 的卡片渲染与后续详情/播放链路。`,
          tags: ['demo', '影视'],
          layout: 'grid-card',
          payload: { url: base + '/v' },
        },
      ],
      page: { page: req.page ?? 1, pageCount: 1, total: 2, hasMore: false },
    };
  }

  async home(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedListResult> {
    return this.search(_rule, { ...req, keyword: '今日推荐' }, _ctx);
  }

  /** 演示详情：标题/作者 + 30 章模拟目录（payload 带章 id 供 content 用） */
  async detail(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedDetail> {
    const name = String((() => {
      try {
        const p = JSON.parse(String(req.id ?? '{}')) as Record<string, unknown>;
        const u = String(p['url'] ?? '');
        return decodeURIComponent(u.split('/').filter(Boolean).pop() ?? '演示');
      } catch {
        return '演示';
      }
    })());
    const chapters = Array.from({ length: 30 }, (_, i) => ({
      title: `第${i + 1}章 演示章节`,
      payload: { url: `https://demo.local/ch/${i + 1}` },
      order: i,
    }));
    return {
      id: 'demo-detail',
      kind: 'book',
      title: `《${name}》· 正版全集`,
      cover: `https://picsum.photos/seed/${encodeURIComponent(name)}a/120/160`,
      subtitle: '演示作者 · 已完结 · 980万字',
      summary: `「${name}」的演示详情：用于验证 详情 → 目录 → 正文 全链路。`,
      tags: ['demo', '玄幻'],
      meta: { 作者: '演示作者', 状态: '已完结', 字数: '980万' },
      chapters,
    };
  }

  /** 演示正文：按章 id 生成 12 段 */
  async content(_rule: unknown, req: UnifiedRequest, _ctx: EngineContext): Promise<UnifiedContent> {
    let idx = 1;
    try {
      const p = JSON.parse(String(req.id ?? '{}')) as Record<string, unknown>;
      idx = Number(String(p['url'] ?? '').split('/').pop()) || 1;
    } catch { /* 默认第 1 章 */ }
    const paragraphs = Array.from({ length: 12 }, (_, i) =>
      `【第${idx}章 · 第${i + 1}段】这是演示正文段落，用于验证阅读器的分页、字号与主题切换。夜色沉沉，主角立于山巅，远方雷光划破天际——新的试炼即将开始。`,
    );
    return { paragraphs };
  }
}
