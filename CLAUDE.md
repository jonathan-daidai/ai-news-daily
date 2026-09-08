# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

架构、数据源、CLI 参数、缓存与成本说明见 README.md，此处只记 README 里没有的东西。
注释、文档、commit message 一律中文。

## 验证手段

```bash
npm run typecheck   # tsc --noEmit —— 唯一的自动化检查
```

**没有测试、没有 linter、没有构建步骤。** tsx 直接跑 `.ts`（ESM，import 路径要带 `.ts` 后缀）。
改完只能靠 typecheck 加真跑一次。

**跑摘要是真金白银**，全量约 $0.4。改抓取/渲染逻辑用 `--no-summary`；必须验证摘要时用
`--hours 2` 缩小样本，或靠缓存（同一天重复跑基本全命中，$0.00）。

## 不要破坏的约定

**失败不中断。** adapter 只返回 `null` 不抛异常，`runSource()` 永远 resolve —— 所以 `collect()`
用普通 `Promise.all` 就够了。

**退出码是契约**：`0` 正常（窗口内 0 篇、摘要全失败都算正常）；`1` 只在三个源全挂时；`2` 参数错误。

**`runStartedAt` 只取一次**，保证 cutoff、报告时间戳、文件名三者一致。

**输出要字节稳定**（便于 diff 历史日报）：排序的 priority 和 `localeCompare` 两级纯粹是 tiebreak。

**HN 的 `<link>` 是原文外链、`<comments>` 才是讨论页** —— 跨源去重能生效的前提。

**feed 标题是不可信输入**，进 Markdown 前必须走 `normalize.ts` 的转义函数
（`escapeMdTable` / `escapeMdLinkText` / `escapeMdText` / `mdLinkTarget`）。

## Vertex AI 的坑

**Vertex 没有服务端 `web_fetch`**，`extract.ts` 就是为此存在。不要「简化」回 `web_fetch` 工具。

**不要在 `createClient()` 里校验 projectId** —— SDK 会先读环境变量，读不到再从 ADC 解析。
在这里提前抛错会把 SDK 能自己搞定的场景堵死（PR #1 修的就是这个）。

**`fatalReason()` 的判据不能松**：凭证类错误对每篇都会失败，必须第一次就收手，否则刷 N 行同样的错。
陷阱是 SDK 把 ADC 获取失败包成 `APIConnectionError`，它**属于** `Anthropic.APIError`，
用 `!(e instanceof Anthropic.APIError)` 当判据会漏掉。

**刻意不禁用 thinking** —— Opus 5 上关掉会让模型偶尔把内部标记漏进可见文本。
