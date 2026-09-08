import type { Article, RunOptions, SourceResult, SummaryUsage } from './types.ts';
import { escapeMdLinkText, escapeMdTable, escapeMdText, mdLinkTarget } from './normalize.ts';

export interface ReportInput {
  articles: Article[];
  results: SourceResult[];
  duplicatesMerged: number;
  runStartedAt: Date;
  options: RunOptions;
  summaryUsage: SummaryUsage;
}

function fmt(date: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, ...opts }).format(date);
}

/** YYYY-MM-DD（在显示时区里的日期） */
export function dateKey(date: Date, timeZone: string): string {
  return fmt(date, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** HH:MM（24 小时制） */
function timeOfDay(date: Date, timeZone: string): string {
  return fmt(date, timeZone, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dateTime(date: Date, timeZone: string): string {
  return `${dateKey(date, timeZone)} ${timeOfDay(date, timeZone)}`;
}

/** 形如 UTC+08:00，让报告的时间永不歧义 */
function offsetLabel(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  // Intl 给的是 GMT+08:00，报告里统一写成 UTC+08:00
  return name ? name.replace(/^GMT/, 'UTC') : timeZone;
}

function hoursAgo(from: Date, now: Date): string {
  return `${((now.getTime() - from.getTime()) / 3600_000).toFixed(1)} 小时前`;
}

function sourceStatus(r: SourceResult, hours: number, now: Date): string {
  if (!r.ok) return `抓取失败：${escapeMdTable(r.error ?? '未知错误')}`;
  if (r.inWindowCount > 0) return 'OK';
  if (r.newestAt) return `窗口内无新文章（最新一篇已超出 ${hours}h）`;
  return '源内无可解析条目';
}

function renderStatusTable(results: SourceResult[], hours: number, now: Date, tz: string): string {
  const rows = results.map((r) => {
    const newest = r.newestAt ? `${dateTime(r.newestAt, tz)}（${hoursAgo(r.newestAt, now)}）` : '—';
    return `| ${escapeMdTable(r.name)} | ${r.fetchedCount} | ${r.inWindowCount} | ${newest} | ${sourceStatus(r, hours, now)} |`;
  });
  return [
    '| 来源 | 抓取 | 窗口内 | 最新一篇 | 状态 |',
    '|---|---:|---:|---|---|',
    ...rows,
  ].join('\n');
}

function renderArticle(a: Article, tz: string): string {
  const meta: string[] = [a.sourceName];
  if (typeof a.points === 'number') meta.push(`${a.points} points`);
  if (a.alsoOn?.length) meta.push(`也出现在 ${a.alsoOn.join('、')}`);
  if (a.commentsUrl && a.commentsUrl !== a.url) {
    meta.push(`[讨论](${mdLinkTarget(a.commentsUrl)})`);
  }

  const head = `- \`${timeOfDay(a.publishedAt, tz)}\` [${escapeMdLinkText(a.title)}](${mdLinkTarget(a.url)}) — ${meta.join(' · ')}`;

  // 摘要作为缩进续行；抓不到正文的用斜体，和真摘要视觉可分
  let body = '';
  if (a.summary && a.summaryStatus !== 'unfetchable') {
    body = `\n  ${escapeMdText(a.summary)}`;
  } else if (a.summaryStatus === 'unfetchable') {
    body = '\n  *无法获取正文*';
  } else if (a.summaryStatus === 'error') {
    body = '\n  *摘要生成失败*';
  }
  return head + body;
}

export function renderMarkdown(input: ReportInput): string {
  const { articles, results, duplicatesMerged, runStartedAt, options, summaryUsage } = input;
  const tz = options.timeZone;
  const cutoff = new Date(runStartedAt.getTime() - options.hours * 3600_000);
  const activeSources = results.filter((r) => r.inWindowCount > 0).length;

  const frontmatter = [
    '---',
    `generated_at: ${runStartedAt.toISOString()}`,
    `window_hours: ${options.hours}`,
    `cutoff: ${cutoff.toISOString()}`,
    `timezone: ${tz}`,
    `total_articles: ${articles.length}`,
    `active_sources: ${activeSources}`,
    `configured_sources: ${results.length}`,
    `duplicates_merged: ${duplicatesMerged}`,
    `summary_model: ${summaryUsage.disabledReason ? 'none' : 'claude-opus-5'}`,
    '---',
  ].join('\n');

  const headerLines = [
    `**共收录 ${articles.length} 篇，来自 ${activeSources} 个源**（共配置 ${results.length} 个）`,
    `生成时间：${dateTime(runStartedAt, tz)} (${offsetLabel(runStartedAt, tz)}) ｜ 窗口：最近 ${options.hours} 小时（自 ${dateTime(cutoff, tz)}）`,
    duplicatesMerged > 0 ? `已合并 ${duplicatesMerged} 篇跨源重复` : '',
  ].filter(Boolean);

  const header =
    `# AI 日报 · ${dateKey(runStartedAt, tz)}\n\n` +
    headerLines.join('\n') +
    (summaryUsage.disabledReason ? `\n\n> 未生成摘要（${summaryUsage.disabledReason}）` : '');

  const sections = [
    frontmatter,
    header,
    '## 数据源状态',
    renderStatusTable(results, options.hours, runStartedAt, tz),
    '## 文章（按时间倒序）',
  ];

  if (articles.length === 0) {
    sections.push('> 本时段内未发现新文章。');
  } else {
    // 全局时间倒序的单一流；### 日期只是流里的分隔标记，不是重新分组
    let currentDay = '';
    const lines: string[] = [];
    for (const a of articles) {
      const day = dateKey(a.publishedAt, tz);
      if (day !== currentDay) {
        currentDay = day;
        lines.push(`### ${day}`);
      }
      lines.push(renderArticle(a, tz));
    }
    sections.push(lines.join('\n\n'));
  }

  return `${sections.join('\n\n')}\n`;
}

export function renderJson(input: ReportInput): string {
  const { articles, results, duplicatesMerged, runStartedAt, options, summaryUsage } = input;
  return `${JSON.stringify(
    {
      generatedAt: runStartedAt.toISOString(),
      windowHours: options.hours,
      cutoff: new Date(runStartedAt.getTime() - options.hours * 3600_000).toISOString(),
      timezone: options.timeZone,
      duplicatesMerged,
      summaryUsage,
      sources: results.map(({ articles: _drop, newestAt, ...rest }) => ({
        ...rest,
        newestAt: newestAt?.toISOString(),
      })),
      articles: articles.map((a) => ({ ...a, publishedAt: a.publishedAt.toISOString() })),
    },
    null,
    2,
  )}\n`;
}
