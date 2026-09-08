export type SourceId = 'techcrunch' | 'theverge' | 'hackernews';

export type SummaryStatus = 'ok' | 'unfetchable' | 'error' | 'skipped' | 'cached';

export interface Article {
  /** 已解码清洗，未做 Markdown 转义 */
  title: string;
  /** 已去跟踪参数，用于展示 */
  url: string;
  /** 更激进的归一化，仅用于去重和缓存 key，不展示 */
  dedupeKey: string;
  publishedAt: Date;
  source: SourceId;
  sourceName: string;
  author?: string;
  /** HN 讨论页 */
  commentsUrl?: string;
  points?: number;
  commentCount?: number;
  /** 去重合并时填充：同一 URL 还出现在哪些源 */
  alsoOn?: SourceId[];
  /** feed 自带的英文描述，作为摘要的补充上下文 */
  snippet?: string;
  /** 中文摘要；未生成/失败时为 undefined */
  summary?: string;
  summaryStatus?: SummaryStatus;
}

export interface SourceResult {
  id: SourceId;
  name: string;
  url: string;
  ok: boolean;
  error?: string;
  elapsedMs: number;
  /** feed 里的条目总数 */
  fetchedCount: number;
  /** 缺标题/链接、或日期不可解析而丢弃的条目数 */
  skippedInvalid: number;
  inWindowCount: number;
  /** 全部条目里最新的一条，不受窗口影响 —— 关键诊断字段 */
  newestAt?: Date;
  /** 已窗口过滤 */
  articles: Article[];
}

export interface RunOptions {
  hours: number;
  outDir: string;
  json: boolean;
  timeZone: string;
  stdout: boolean;
  summary: boolean;
  cache: boolean;
  concurrency: number;
}

export interface SummaryUsage {
  articles: number;
  fromCache: number;
  generated: number;
  unfetchable: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  /** 摘要整体被跳过的原因（无凭证 / --no-summary），用于在报告里说明 */
  disabledReason?: string;
}
