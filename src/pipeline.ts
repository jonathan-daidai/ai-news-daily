import { fetchText } from './fetch.ts';
import { parser, SOURCES, type SourceConfig } from './sources.ts';
import type { Article, SourceId, SourceResult } from './types.ts';

const PRIORITY = new Map<SourceId, number>(SOURCES.map((s) => [s.id, s.priority]));

/**
 * 把 fetch+parse+adapt+filter 全包在一个 try/catch 里，**永远 resolve**。
 * 因此调用方用普通的 Promise.all 就够了，不需要 allSettled ——
 * 挂掉一个源只会在报告里多一行错误状态，不会让整次运行失败。
 */
export async function runSource(
  cfg: SourceConfig,
  cutoff: Date,
): Promise<SourceResult> {
  const startedAt = Date.now();
  const base = {
    id: cfg.id,
    name: cfg.name,
    url: cfg.url,
    fetchedCount: 0,
    skippedInvalid: 0,
    inWindowCount: 0,
    articles: [] as Article[],
  };

  try {
    const xml = await fetchText(cfg.url);
    const feed = await parser.parseString(xml);
    const items = feed.items ?? [];

    let skippedInvalid = 0;
    const parsed: Article[] = [];
    for (const raw of items) {
      const article = cfg.adapt(raw, cfg);
      if (article) parsed.push(article);
      else skippedInvalid += 1;
    }

    // newestAt 在窗口过滤**之前**算 —— 这就是让「源没更新」和「抓取失败」
    // 得以区分的诊断字段。
    const newestAt = parsed.reduce<Date | undefined>(
      (max, a) => (!max || a.publishedAt > max ? a.publishedAt : max),
      undefined,
    );

    const inWindow = parsed.filter((a) => a.publishedAt.getTime() >= cutoff.getTime());

    return {
      ...base,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      fetchedCount: items.length,
      skippedInvalid,
      inWindowCount: inWindow.length,
      newestAt,
      articles: inWindow,
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export interface CollectResult {
  results: SourceResult[];
  articles: Article[];
  duplicatesMerged: number;
}

/**
 * 只按 URL 同一性去重。**刻意不做标题模糊匹配** —— TechCrunch 和 Verge
 * 报道同一事件、标题相近，是两篇正当的不同文章，按标题归并会静默删掉一篇。
 */
function dedupe(articles: Article[]): { merged: Article[]; duplicatesMerged: number } {
  const byKey = new Map<string, Article>();
  let duplicatesMerged = 0;

  for (const article of articles) {
    const existing = byKey.get(article.dedupeKey);
    if (!existing) {
      byKey.set(article.dedupeKey, { ...article });
      continue;
    }

    duplicatesMerged += 1;
    const pWin = PRIORITY.get(existing.source) ?? 99;
    const pNew = PRIORITY.get(article.source) ?? 99;
    // priority 小的拿标题/URL/来源标识
    const winner = pNew < pWin ? { ...article } : existing;
    const loser = pNew < pWin ? existing : article;

    // 附加信息始终合并，不管谁赢
    winner.commentsUrl ??= loser.commentsUrl;
    winner.points ??= loser.points;
    winner.commentCount ??= loser.commentCount;
    winner.snippet ??= loser.snippet;
    // 原发时间必早于 HN 提交时间，取更早的那个
    if (loser.publishedAt < winner.publishedAt) winner.publishedAt = loser.publishedAt;
    winner.alsoOn = [
      ...new Set([...(existing.alsoOn ?? []), ...(article.alsoOn ?? []), existing.source, article.source]),
    ].filter((s) => s !== winner.source);

    byKey.set(article.dedupeKey, winner);
  }

  return { merged: [...byKey.values()], duplicatesMerged };
}

/** 时间降序 → priority 升序 → 标题 localeCompare（后两项保证输出字节稳定，便于 diff） */
function sortArticles(articles: Article[]): Article[] {
  return articles.sort((a, b) => {
    const byTime = b.publishedAt.getTime() - a.publishedAt.getTime();
    if (byTime !== 0) return byTime;
    const byPriority = (PRIORITY.get(a.source) ?? 99) - (PRIORITY.get(b.source) ?? 99);
    if (byPriority !== 0) return byPriority;
    return a.title.localeCompare(b.title);
  });
}

export async function collect(cutoff: Date): Promise<CollectResult> {
  const results = await Promise.all(SOURCES.map((cfg) => runSource(cfg, cutoff)));
  const { merged, duplicatesMerged } = dedupe(results.flatMap((r) => r.articles));
  return { results, articles: sortArticles(merged), duplicatesMerged };
}
