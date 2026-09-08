import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { collect } from './pipeline.ts';
import { dateKey, renderJson, renderMarkdown } from './report.ts';
import { summarizeAll } from './summarize.ts';
import type { RunOptions, SummaryUsage } from './types.ts';

const HELP = `
ai-news — AI 新闻聚合日报

用法: npm start -- [options]

  --hours <n>        时间窗口小时数，接受小数 (默认 24)
  --out <dir>        输出目录 (默认 output)
  --tz <IANA>        显示时区 (默认 Asia/Shanghai)
  --json             同时输出 .json
  --stdout           打印到 stdout 而不写文件
  --no-summary       跳过中文摘要（不调用 API，零成本）
  --no-cache         忽略摘要缓存，强制重新生成
  --concurrency <n>  摘要并发数 (默认 4)
  --help             显示本帮助
`.trim();

function fail(msg: string): never {
  console.error(`错误：${msg}`);
  process.exit(2);
}

function parseOptions(): RunOptions {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        hours: { type: 'string' },
        out: { type: 'string' },
        tz: { type: 'string' },
        json: { type: 'boolean', default: false },
        stdout: { type: 'boolean', default: false },
        // Node 的 parseArgs 不支持 --no-x 负向语法，只能显式声明
        'no-summary': { type: 'boolean', default: false },
        'no-cache': { type: 'boolean', default: false },
        concurrency: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  if (parsed.values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const hours = parsed.values.hours ? Number(parsed.values.hours) : 24;
  if (!Number.isFinite(hours) || hours <= 0) fail('--hours 必须是大于 0 的有限数字');

  const concurrency = parsed.values.concurrency ? Number(parsed.values.concurrency) : 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail('--concurrency 必须是大于等于 1 的整数');
  }

  const timeZone = parsed.values.tz ?? 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    fail(`--tz 不是合法的 IANA 时区：${timeZone}`);
  }

  return {
    hours,
    outDir: parsed.values.out ?? 'output',
    json: parsed.values.json ?? false,
    timeZone,
    stdout: parsed.values.stdout ?? false,
    summary: !parsed.values['no-summary'],
    cache: !parsed.values['no-cache'],
    concurrency,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  // 只取一次，保证 cutoff / 报告时间戳 / 文件名三者一致
  const runStartedAt = new Date();
  const cutoff = new Date(runStartedAt.getTime() - options.hours * 3600_000);

  const { results, articles, duplicatesMerged } = await collect(cutoff);

  for (const r of results) {
    const status = r.ok
      ? `抓取 ${r.fetchedCount}，窗口内 ${r.inWindowCount}${r.skippedInvalid ? `，跳过无效 ${r.skippedInvalid}` : ''}`
      : `失败：${r.error}`;
    console.error(`[${r.ok ? ' ok ' : 'FAIL'}] ${r.name.padEnd(18)} ${status} (${r.elapsedMs}ms)`);
  }

  let summaryUsage: SummaryUsage = {
    articles: articles.length,
    fromCache: 0,
    generated: 0,
    unfetchable: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };

  if (!options.summary) {
    summaryUsage.disabledReason = '--no-summary';
    for (const a of articles) a.summaryStatus = 'skipped';
  } else if (articles.length > 0) {
    summaryUsage = await summarizeAll(articles, options);
  }

  const input = { articles, results, duplicatesMerged, runStartedAt, options, summaryUsage };
  const markdown = renderMarkdown(input);

  if (options.stdout) {
    process.stdout.write(markdown);
  } else {
    await mkdir(options.outDir, { recursive: true });
    const stem = `ai-news-${dateKey(runStartedAt, options.timeZone)}`;
    const mdPath = path.join(options.outDir, `${stem}.md`);
    await writeFile(mdPath, markdown, 'utf8');
    console.error(`已写入 ${mdPath}`);

    if (options.json) {
      const jsonPath = path.join(options.outDir, `${stem}.json`);
      await writeFile(jsonPath, renderJson(input), 'utf8');
      console.error(`已写入 ${jsonPath}`);
    }
  }

  // 窗口内 0 篇、摘要全失败都是合法结果；只有三个源全挂才算真故障
  process.exit(results.every((r) => !r.ok) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
