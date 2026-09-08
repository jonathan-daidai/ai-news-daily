import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

import { extractArticleText } from './extract.ts';
import type { Article, RunOptions, SummaryUsage } from './types.ts';

/** Vertex 上当代模型用不带前缀的原始 ID */
const MODEL = 'claude-opus-5';
/** 按官方 API 的 Opus 5 费率 $5 / $25 每百万 token 估算；Vertex 实际按 GCP 费率结算 */
const COST_IN_PER_TOKEN = 5 / 1_000_000;
const COST_OUT_PER_TOKEN = 25 / 1_000_000;

/** 正文没有实质内容时模型必须原样输出的哨兵串 */
const SENTINEL = '无法获取正文';

const CACHE_TTL_MS = 7 * 24 * 3600_000;

const SYSTEM_PROMPT = `你是一个中文科技新闻编辑。用户会给你一篇文章的标题、链接和正文节选。

工作流程：
1. 读正文节选，输出一句话中文摘要，40-60 字，说清「谁做了什么、为什么值得看」。
2. 如果节选只是付费墙提示、Cookie 同意页、人机验证、导航菜单、报错页等没有实质内容的东西：
   只输出这六个字「${SENTINEL}」，不要有任何其他内容。

硬性要求：
- 只输出摘要正文本身，不要前缀、不要引号、不要 Markdown 标记、不要换行。
- 只依据节选里真实出现的信息，绝对不要根据标题猜测或编造。判断不了就用上面那六个字。
- 正文节选可能被截断或夹杂模板噪音，忽略噪音即可，不要在摘要里提这件事。
- 用简体中文。保留必要的英文专有名词（公司名、产品名、模型名）。`;

interface CacheEntry {
  summary: string;
  status: 'ok' | 'unfetchable';
  model: string;
  createdAt: string;
}

type Cache = Record<string, CacheEntry>;

async function loadCache(cachePath: string): Promise<Cache> {
  try {
    const raw = JSON.parse(await readFile(cachePath, 'utf8')) as Cache;
    const cutoff = Date.now() - CACHE_TTL_MS;
    // 启动时剪掉过期条目，免得缓存无限膨胀
    return Object.fromEntries(
      Object.entries(raw).filter(([, v]) => new Date(v.createdAt).getTime() >= cutoff),
    );
  } catch {
    return {};
  }
}

async function saveCache(cachePath: string, cache: Cache): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 走 Vertex AI，凭证是 GCP ADC（GCE 元数据服务器或
 * `gcloud auth application-default login`），不需要 ANTHROPIC_API_KEY。
 */
function createClient(): AnthropicVertex {
  const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!projectId) throw new Error('未设置 ANTHROPIC_VERTEX_PROJECT_ID');
  return new AnthropicVertex({ projectId, region: process.env.CLOUD_ML_REGION ?? 'global' });
}

/**
 * 判断这个错误是不是「对每一篇都会同样失败」的环境问题。
 * 是的话返回给用户看的原因，否则返回 undefined 当作单篇失败。
 */
function fatalReason(e: unknown): string | undefined {
  if (e instanceof Anthropic.AuthenticationError) return '凭证无效（401）';
  if (e instanceof Anthropic.PermissionDeniedError) {
    return `无权访问 Vertex 上的 ${MODEL}（403）`;
  }
  if (e instanceof Anthropic.NotFoundError) {
    return `Vertex 上找不到 ${MODEL}，检查 CLOUD_ML_REGION 与模型开通状态（404）`;
  }
  // google-auth-library 在拿不到 ADC 时抛的是普通 Error，不是 APIError
  if (e instanceof Error && !(e instanceof Anthropic.APIError) && /credential|auth/i.test(e.message)) {
    return `无法获取 GCP 凭证：${e.message}`;
  }
  return undefined;
}

/** 摘要整体不可用：保留已有结果，其余标 skipped，并把原因写进报告 */
function disableAll(usage: SummaryUsage, articles: Article[], reason: string): SummaryUsage {
  usage.disabledReason = reason;
  for (const a of articles) {
    if (!a.summary) a.summaryStatus = 'skipped';
  }
  console.error(`摘要：${reason}，已跳过剩余摘要。`);
  console.error('  Vertex 凭证：运行 `gcloud auth application-default login`，');
  console.error(`  并确认 ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION 指向已开通 ${MODEL} 的项目。`);
  return usage;
}

interface OneResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 单篇摘要。正文由 extract.ts 在本地抓好后直接塞进 prompt ——
 * Vertex AI 不提供服务端 web_fetch 工具，所以没有工具轮，一次请求出结果。
 */
async function summarizeOne(
  client: AnthropicVertex,
  article: Article,
  body: string,
): Promise<OneResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // 摘要是轻任务，low 足够且省钱。刻意不禁用 thinking ——
    // Opus 5 上关掉 thinking 会让模型偶尔把内部标记漏进可见文本。
    output_config: { effort: 'low' },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `标题：${article.title}`,
              `链接：${article.url}`,
              article.snippet ? `RSS 摘要（仅供参考，可能不完整）：${article.snippet}` : '',
              '',
              '正文节选：',
              body,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      },
    ],
  });

  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;

  if (response.stop_reason === 'refusal') {
    return { text: SENTINEL, inputTokens, outputTokens };
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .at(-1);

  return { text: text ?? SENTINEL, inputTokens, outputTokens };
}

/** 简单的并发闸门，不值得为此引入 p-limit */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function summarizeAll(
  articles: Article[],
  options: RunOptions,
): Promise<SummaryUsage> {
  const usage: SummaryUsage = {
    articles: articles.length,
    fromCache: 0,
    generated: 0,
    unfetchable: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };

  const cachePath = path.join(options.outDir, '.cache', 'summaries.json');
  const cache = options.cache ? await loadCache(cachePath) : {};

  const pending: Article[] = [];
  for (const article of articles) {
    const hit = options.cache ? cache[article.dedupeKey] : undefined;
    if (hit) {
      article.summary = hit.summary;
      article.summaryStatus = hit.status === 'unfetchable' ? 'unfetchable' : 'cached';
      usage.fromCache += 1;
      if (hit.status === 'unfetchable') usage.unfetchable += 1;
    } else {
      pending.push(article);
    }
  }

  if (pending.length === 0) {
    console.error(`摘要：${usage.fromCache} 篇全部命中缓存，本次花费 $0.00`);
    return usage;
  }

  let client: AnthropicVertex;
  try {
    client = createClient();
  } catch (e) {
    return disableAll(usage, articles, e instanceof Error ? e.message : String(e));
  }

  let fatal: string | undefined;

  await mapLimit(pending, options.concurrency, async (article) => {
    if (fatal) return;
    try {
      // 先在本地抓正文：抓不到就直接判定 unfetchable，一个 token 都不花
      const body = await extractArticleText(article.url);
      if (body === null) {
        article.summary = SENTINEL;
        article.summaryStatus = 'unfetchable';
        usage.unfetchable += 1;
        cache[article.dedupeKey] = {
          summary: SENTINEL,
          status: 'unfetchable',
          model: MODEL,
          createdAt: new Date().toISOString(),
        };
        return;
      }

      let result: OneResult;
      try {
        result = await summarizeOne(client, article, body);
      } catch (e) {
        // 429 退避重试一次
        if (e instanceof Anthropic.RateLimitError) {
          await sleep(5_000);
          result = await summarizeOne(client, article, body);
        } else {
          throw e;
        }
      }

      usage.inputTokens += result.inputTokens;
      usage.outputTokens += result.outputTokens;

      const unfetchable = result.text.replace(/[「」"'。.\s]/g, '') === SENTINEL;
      article.summary = result.text;
      article.summaryStatus = unfetchable ? 'unfetchable' : 'ok';
      if (unfetchable) usage.unfetchable += 1;
      else usage.generated += 1;

      cache[article.dedupeKey] = {
        summary: result.text,
        status: unfetchable ? 'unfetchable' : 'ok',
        model: MODEL,
        createdAt: new Date().toISOString(),
      };
    } catch (e) {
      // 凭证/权限/模型未开通会对每一篇都失败，第一次就收手，别刷 31 行同样的错
      const reason = fatalReason(e);
      if (reason) {
        fatal = reason;
        return;
      }
      usage.errors += 1;
      article.summaryStatus = 'error';
      console.error(`摘要失败 [${article.title.slice(0, 40)}]: ${e instanceof Error ? e.message : e}`);
    }
  });

  if (fatal) {
    if (options.cache) await saveCache(cachePath, cache);
    return disableAll(usage, articles, fatal);
  }

  usage.estimatedCostUsd =
    usage.inputTokens * COST_IN_PER_TOKEN + usage.outputTokens * COST_OUT_PER_TOKEN;

  if (options.cache) await saveCache(cachePath, cache);

  console.error(
    `摘要：生成 ${usage.generated}，无法获取正文 ${usage.unfetchable}，失败 ${usage.errors}，缓存命中 ${usage.fromCache}`,
  );
  console.error(
    `  token: 输入 ${usage.inputTokens.toLocaleString()} / 输出 ${usage.outputTokens.toLocaleString()}，估算花费 $${usage.estimatedCostUsd.toFixed(3)}`,
  );

  return usage;
}
