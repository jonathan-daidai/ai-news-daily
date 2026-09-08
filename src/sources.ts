import Parser from 'rss-parser';
import type { Article, SourceId } from './types.ts';
import { cleanSnippet, cleanTitle, normalizeUrl } from './normalize.ts';

/**
 * 本地声明 raw item 形状，不去和 rss-parser 的泛型较劲。
 * rss-parser 把 RSS 2.0 的 <pubDate> 和 Atom 的 <published>/<updated>
 * 都归一到 isoDate，把 Atom 的 <link rel="alternate" href> 归一到 link，
 * 于是三个源的格式差异在这里就消失了。
 */
export interface RawItem {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  creator?: string;
  content?: string;
  contentSnippet?: string;
  comments?: string;
}

export interface SourceConfig {
  id: SourceId;
  name: string;
  url: string;
  /** 去重时数字小的胜出，排序 tiebreak 同理：原发媒体优先于聚合器 */
  priority: number;
  adapt(raw: RawItem, cfg: SourceConfig): Article | null;
}

export const parser = new Parser<Record<string, unknown>, RawItem>({
  customFields: { item: ['comments'] },
});

/** 未来 6 小时以外的时间戳当作垃圾数据 */
const FUTURE_SLACK_MS = 6 * 3600_000;

function parseDate(raw: RawItem): Date | null {
  const d = new Date(raw.isoDate ?? raw.pubDate ?? '');
  if (Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + FUTURE_SLACK_MS) return null;
  return d;
}

/** 所有 adapter 都只返回 null，绝不抛异常 —— 调用方据此计入 skippedInvalid */
function baseAdapt(raw: RawItem, cfg: SourceConfig): Article | null {
  const title = cleanTitle(raw.title);
  if (!title || !raw.link) return null;
  const publishedAt = parseDate(raw);
  if (!publishedAt) return null;

  const { display, key } = normalizeUrl(raw.link);
  return {
    title,
    url: display,
    dedupeKey: key,
    publishedAt,
    source: cfg.id,
    sourceName: cfg.name,
    author: raw.creator?.trim() || undefined,
    snippet: cleanSnippet(raw.contentSnippet ?? raw.content),
  };
}

/** hnrss 把分数和评论数塞在 description 的 HTML 里 */
function parseIntOrUndefined(text: string | undefined, re: RegExp): number | undefined {
  const m = text?.match(re);
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

export const SOURCES: SourceConfig[] = [
  {
    id: 'techcrunch',
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    priority: 1,
    adapt: baseAdapt,
  },
  {
    id: 'theverge',
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    priority: 2,
    adapt: baseAdapt,
  },
  {
    id: 'hackernews',
    name: 'Hacker News (AI)',
    url: 'https://hnrss.org/newest?q=AI&count=30',
    priority: 3,
    adapt(raw, cfg) {
      const article = baseAdapt(raw, cfg);
      if (!article) return null;

      // HN 的 <link> 是原文外链（这正是跨源去重能生效的前提），
      // <comments> 才是 HN 讨论页。Ask HN 这类自帖两者相同。
      const isSelfPost = /(^|\.)news\.ycombinator\.com$/i.test(
        (() => {
          try {
            return new URL(article.url).hostname;
          } catch {
            return '';
          }
        })(),
      );

      article.commentsUrl = raw.comments ?? (isSelfPost ? article.url : undefined);
      article.points = parseIntOrUndefined(raw.content, /Points:\s*(\d+)/);
      article.commentCount = parseIntOrUndefined(raw.content, /#\s*Comments:\s*(\d+)/);
      // hnrss 的 description 只有 "Article URL / Comments URL / Points" 样板，
      // 不是正文，当摘要上下文只会误导模型。
      article.snippet = undefined;
      return article;
    },
  },
];
