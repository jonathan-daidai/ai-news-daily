# ai-news

AI 新闻聚合 CLI：抓取多个 RSS 源，去重后用 Claude Sonnet 5 生成一句话中文摘要，输出 Markdown 日报。

```markdown
- `07:56` [WeatherNext 3: Our most advanced global weather AI model](https://blog.google/...) — Hacker News (AI) · 11 points · [讨论](https://news.ycombinator.com/item?id=49604257)
  Google DeepMind 与 Google Research 发布 WeatherNext 3，直接学习实时卫星与气象站观测数据，
  实现每小时更新、最高 5 公里分辨率的全球预报，降水准确度大幅提升，已接入搜索、Gemini、地图与云服务。

- `14:13` [Major Math Breakthrough by AI](https://mastodon.social/@tristanbuckmaster/117233413705701198) — Hacker News (AI) · 4 points
  *无法获取正文*
```

## 数据源

| 源 | 说明 |
|---|---|
| TechCrunch AI | `techcrunch.com/category/artificial-intelligence/feed/` |
| The Verge AI | `theverge.com/rss/ai-artificial-intelligence/index.xml` |
| Hacker News (AI) | `hnrss.org/newest?q=AI&count=30` |

改 `src/sources.ts` 里的 `SOURCES` 即可增删。每个源自带一个 `adapt`，
所有 adapter 只返回 `null` 而不抛异常，坏条目计入 `skippedInvalid` 而不会中断整次运行。

## 环境要求

- Node.js 22+
- 一个已开通 Claude 模型的 Google Cloud 项目（摘要走 Vertex AI）

摘要是可选的：加 `--no-summary` 就完全不碰 API，只出标题 + 元信息的日报，零成本、无需任何凭证。

## 安装与配置

```bash
npm install
```

摘要走 **Vertex AI**，凭证用 GCP ADC，**不需要 `ANTHROPIC_API_KEY`**：

```bash
gcloud auth application-default login          # 在 GCE/Cloud Run 上可省略，走元数据服务器
```

两个环境变量都是**可选**的：

| 变量 | 不设时 |
|---|---|
| `ANTHROPIC_VERTEX_PROJECT_ID` | 从 ADC 解析（GCE 元数据服务器、或 ADC 文件里的 `quota_project_id`）；解析不出来才报错 |
| `CLOUD_ML_REGION` | 默认 `global` |

只有当 ADC 本身不带项目（常见于用户凭证登录且没设 quota project）时才需要显式 export：

```bash
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
```

## 用法

```bash
npm start                      # 最近 24 小时，写 output/ai-news-YYYY-MM-DD.md
npm start -- --json            # 同时输出结构化 .json
npm start -- --hours 48        # 放宽到 48 小时
npm start -- --stdout          # 打到 stdout，不落盘
npm start -- --no-summary      # 跳过摘要，不调 API
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--hours <n>` | `24` | 时间窗口小时数，接受小数 |
| `--out <dir>` | `output` | 输出目录 |
| `--tz <IANA>` | `Asia/Shanghai` | 报告里所有时间的显示时区 |
| `--json` | 关 | 额外输出 `.json` |
| `--stdout` | 关 | 打印到 stdout 而不写文件 |
| `--no-summary` | 关 | 跳过中文摘要（不调用 API，零成本） |
| `--no-cache` | 关 | 忽略摘要缓存，强制重新生成 |
| `--concurrency <n>` | `4` | 摘要并发数 |

退出码：`0` 正常（窗口内 0 篇、摘要全失败都算正常结果）；`1` 三个源全部抓取失败；`2` 参数错误。

## 工作流程

```
sources.ts  →  pipeline.ts  →  extract.ts  →  summarize.ts  →  report.ts
  RSS 配置      抓取/解析/去重     本地抓正文      Claude 摘要      Markdown / JSON
```

1. **抓取**（`fetch.ts`）— 自己发请求而不用 `rss-parser` 的 `parseURL`，为的是拿到 UA、超时和重试的控制权。网络错误/超时/5xx 重试一次。
2. **去重**（`pipeline.ts`）— **只按归一化后的 URL 去重**，刻意不做标题模糊匹配：TechCrunch 和 Verge 报道同一事件、标题相近，是两篇正当的不同文章。跨源命中时原发媒体优先于聚合器，附加信息（HN 分数、讨论链接）始终合并。
3. **抓正文**（`extract.ts`）— 见下。
4. **摘要**（`summarize.ts`）— Claude Sonnet 5，`effort: low`，40–60 字一句话。
5. **渲染**（`report.ts`）— 带 frontmatter 的 Markdown，可选同名 `.json`。

### 为什么正文是本地抓的

Vertex AI **不提供服务端 `web_fetch` 工具**（只有基础版 `web_search`），所以正文由 `extract.ts`
在本地抓好后直接塞进 prompt。这么做还有个附带好处：本地抓不到就直接判定「无法获取正文」，
**一个 token 都不花**，不用先付钱让模型去发现它读不到。

抓不到的典型情况：付费墙、Cookie 同意页、人机验证、PDF、纯 JS 渲染的页面。
这些在报告里显示为斜体的 *无法获取正文* —— 与真摘要视觉可分，且模型被明确要求
宁可输出这六个字也不要根据标题编造内容。

### 缓存

摘要按 `dedupeKey`（归一化 URL）缓存在 `<outDir>/.cache/summaries.json`，TTL 7 天。
启动时会剪掉两类条目：**过期的**，以及**别的模型生成的** —— 换 `MODEL` 后旧摘要必须失效，
否则报告 frontmatter 里的 `summary_model` 会和实际内容对不上。

同一天重复运行基本全部命中，花费 $0.00。`--no-cache` 强制重算，注意它**既不读也不写**缓存，
所以用它重跑的结果不会落盘。

## 输出

- `output/ai-news-YYYY-MM-DD.md` — YAML frontmatter（`generated_at` / `window_hours` / `total_articles` / `duplicates_merged` / `summary_model` 等）、数据源状态表、按时间倒序的文章流。
- `output/ai-news-YYYY-MM-DD.json` — 同样的数据，外加每篇的 `summaryStatus` 和整体 `summaryUsage`（token 数与估算花费）。

数据源状态表会把「抓取失败」和「源没更新」分开报：`newestAt` 在窗口过滤**之前**计算，
所以 The Verge 三天没发 AI 稿子和 The Verge 挂了，在报告里是两行不同的状态。

## 成本

摘要的 token 花费在运行结束时打印。费率按官方 API 的 Sonnet 5（$3 / $15 每百万 token）估算，
**Vertex 实际按 Google Cloud 费率结算**，数字仅供参考。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # tsx watch
```
