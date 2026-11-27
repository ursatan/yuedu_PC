/**
 * RssParserByRule 移植（上游 `model/rss/RssParserByRule.kt`，2026-10-06 精读全文 140 行）
 *
 * 上游行为要点（逐条对齐，不猜测）：
 *  - 入口 `parseXML(sortName, sortUrl, redirectUrl, body, rssSource, ruleData)`：
 *    body 空白抛错；ruleArticles 空白回落 RssParserDefault（调用方 engine.ts 已分派）。
 *  - `ruleArticles` 以 `-` 开头 = 结果倒序 —— core `AnalyzeRule.getElements` 已处理
 *    `-`/`+` 前缀（analyze.ts getElementsInner），这里**不重复剥**（#247：同判据两处必漂移）。
 *  - `ruleNextPage`：`PAGE`（大小写不敏感）⇒ nextUrl = sortUrl 本身（配合 URL 里的 {{page}} 递增）；
 *    否则 getString(ruleNextPage) 后 getAbsoluteURL(sortUrl, nextUrl)。
 *  - 逐 item：setRuleData(rssArticle) + setContent(item) 后
 *    title/pubDate/description/image/link 五条规则各自 getString；
 *    link 用 getString(ruleLink, isUrl=true)（相对补全基准 = baseUrl = sortUrl）；
 *    image 用 getAbsoluteURL(**sourceUrl**, it)（基准是源 URL，与 link 不同）；
 *    image 异常吞掉留空（上游 try/catch）；title 空白的 item **丢弃**。
 *  - `type` 是**源级**字段（0网页/1图片/2视频），逐 item 原样继承。
 *  - variable（ruleData.getVariable()）传给 RssArticle —— 本仓 RssArticle 无该字段，不搬。
 */

import { AnalyzeRule, resolveUrl, type AnalyzeEnv } from '@yuedu/core';
import type { RssSourceRule } from '../model/rss-source';
import type { RssArticle } from './rss-xml';

export interface RssRuleParseResult {
  articles: RssArticle[];
  nextUrl: string | null;
}

export async function parseRssByRule(
  body: string,
  sortUrl: string,
  source: RssSourceRule,
  env: AnalyzeEnv,
  sortName: string,
  /** `#698` 调试信息流回调（对齐上游 `RssParserByRule.kt` 的 `Debug.log`，传 undefined = 不记录） */
  log?: (msg: string) => void,
): Promise<RssRuleParseResult> {
  const analyzeRule = new AnalyzeRule(env).setContent(body, sortUrl);
  // 上游 `RssParserByRule.kt:53-55`：先 `┌获取列表`，取完再 `└列表大小:N`
  log?.('┌获取列表');
  const collections = (await analyzeRule.getElements(source.ruleArticles!)) as unknown[];
  log?.(`└列表大小:${collections.length}`);

  // 下一页链接（上游 RssParserByRule.kt:56-67）
  let nextUrl: string | null = null;
  if (source.ruleNextPage) {
    log?.('┌获取下一页链接');
    if (source.ruleNextPage.toUpperCase() === 'PAGE') {
      nextUrl = sortUrl;
    } else {
      const n = await analyzeRule.getString(source.ruleNextPage);
      if (n) nextUrl = resolveUrl(sortUrl, n);
    }
    // 上游 `└$nextUrl`（空就是空行——「没有下一页」这件事本身也是结论）
    log?.(`└${nextUrl ?? ''}`);
  }

  const articles: RssArticle[] = [];
  // 上游 RssArticle 主键 = (origin, link, sort)，RssParserByRule 不设 order（恒 0）；
  // 本仓 order 用于列表展示序号（与 default 路径同从 0 递增）
  let order = 0;
  for (const item of collections) {
    analyzeRule.setContent(item, sortUrl);
    const title = await analyzeRule.getString(source.ruleTitle ?? '');
    if (!title.trim()) continue; // 上游 getItem：title 空白返回 null（丢弃）
    const pubDate = (await analyzeRule.getString(source.rulePubDate ?? '')) || null;
    // ruleDescription 空 = 「描述规则为空，将会解析内容页」（上游 item 日志原话）——描述留空
    const description = source.ruleDescription ? (await analyzeRule.getString(source.ruleDescription)) || null : null;
    let image: string | null = null;
    if (source.ruleImage) {
      try {
        const it = await analyzeRule.getString(source.ruleImage);
        if (it) image = resolveUrl(source.sourceUrl, it);
      } catch {
        // 上游 catch 后只打日志（图规则求值异常不炸列表）——留痕不静默
        console.log(`[rss] 源 ${source.sourceName}(${source.sourceUrl}) ruleImage 求值异常（该条无图）`);
      }
    }
    const link = await analyzeRule.getString(source.ruleLink ?? '', true);
    /**
     * `#698` 只打**第一条**的字段（上游 `RssParserByRule.kt:107-134` 的 `log` 参数是
     * `index == 0`）—— 一页几十条各打 5 行会把信息流淹掉，第一条足以证明规则通不通。
     */
    if (order === 0) {
      log?.(`┌获取标题`);
      log?.(`└${title}`);
      log?.(`┌获取时间`);
      log?.(`└${pubDate ?? ''}`);
      log?.(`┌获取描述`);
      // 上游原话：描述规则为空时说「将会解析内容页」，否则打印描述本身
      log?.(`└${source.ruleDescription ? (description ?? '') : '描述规则为空，将会解析内容页'}`);
      log?.(`┌获取图片url`);
      log?.(`└${image ?? ''}`);
      log?.(`┌获取文章链接`);
      log?.(`└${link}`);
    }
    articles.push({
      origin: source.sourceUrl,
      sort: sortName,
      title,
      order: order++,
      link,
      pubDate,
      description,
      content: null,
      image,
      type: source.type,
    });
  }
  return { articles, nextUrl };
}
