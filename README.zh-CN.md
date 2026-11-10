# Waystone

[English](README.md) · [简体中文](README.zh-CN.md)

**为 [pi](https://github.com/earendil-works/pi) 编码智能体准备的记忆：把上下文窗口当成一份预算，而不是堆放杂物的仓库。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-197%20unit%20%2B%2069%20checks-brightgreen.svg)](#测试)

Waystone 给编码智能体一份能跨会话存活的记忆——决策、偏好、约定、每日笔记、便签（scratchpad）——并且硬性限制到底有多少内容会进入 system prompt。所有内容都是磁盘上的普通 markdown：没有数据库、没有向量库、没有要运行的服务。装上 [qmd](https://github.com/tobi/qmd) 之后，它还能对智能体写下过的所有内容做关键词、语义和混合检索。

它面向每天使用 `pi`、厌倦了反复解释自己技术栈的人，也面向想读、想改、想版本化、想审计智能体究竟记住了什么，而不是信任一个黑盒的人。

**状态：** 3 个命令、7 个工具、5 个生命周期钩子、197 个单元测试、5 套共 69 项检查。`pi` 需要 0.81.1 或更新；从源码运行需要 Node 22.19+。

## 为什么选 Waystone

**文件就是真相源。** 记忆就是 `MEMORY.md`、`SCRATCHPAD.md`、`daily/<date>.md`、`topics/` 和 `wiki/`——你可以 `cat`、手动编辑、diff、提交的普通 markdown。

**上下文是有预算的。** 注入量硬性上限 16,000 字符，并按区分配（长期记忆 4,000 字符 / 150 行，便签 2,000 / 120，每份每日日志 3,000 / 120，检索片段 2,500 / 80，知识索引 2,000 / 60）。其余内容不必待在每一轮 prompt 里，需要时一次 `memory_search` 就能取到。

**可审计。** `.audit/ledger.json` 记录每一条真正被注入过的条目。`/audit` 报告从未进入过上下文的条目、指向已不存在文件的条目，以及跨文件重复的条目。

**KV cache 保持常热。** 默认的 `stable` 快照每个会话只构建一次记忆块，之后每轮输出完全相同的字节，本地前缀缓存不会因为记忆变动而失效。有三处刻意的例外：`memory_forget`、`memory_restore` 和 `/supersede` 会立即刷新它，因为删除必须从 prompt 里消失。

**项目记忆是一个可以提交的文件。** `<repo>/.pi/memory/MEMORY.md` 在全局层之前注入，团队只要提交一个文件就能共享约定。只有在你回答过 pi 的项目信任问题之后，它才会被注入。

**退役而不是删除。** `/supersede <old> <new>` 让被更新事实取代的记忆停止注入。条目留在磁盘上、仍然可检索，`/supersede restore` 可以把它放回来。

## 演示

示意会话 —— 这段对话是示例，不是真实录制的一次运行：

```text
you ▸ I always use pnpm in this repo, never npm. Remember that.
pi  ▸ memory_write(target: "project", content: "#preference Use pnpm, never npm.")
      Wrote project note: .pi/memory/MEMORY.md

# …days later, a fresh session in the same repo…
you ▸ add prettier as a dev dependency
pi  ▸ pnpm add -D prettier        (the project tier was already in context)
```

记忆本身就是文本：

```text
$ cat ~/.pi/agent/memory/MEMORY.md
<!-- 2026-11-10 09:14:00 [a1b2c3d4] -->
#decision Use pnpm in this repository, never npm.

<!-- 2026-11-10 09:20:11 [a1b2c3d4] -->
#convention Tests run with `bun test`, not `npm test`.
```

## 安装

```bash
# 1. from a clone
git clone https://github.com/edccce64/waystone.git && cd waystone && pi install .

# 2. (optional) search and selective injection need qmd
npm install -g @tobilu/qmd      # or: bun install -g https://github.com/tobi/qmd

# 3. check the wiring
#    in pi: memory_status
```

六个本地工具（`memory_write`、`memory_forget`、`memory_restore`、`memory_read`、`scratchpad`、`memory_status`）装好即可用，不需要其他配置。`memory_search` 需要 qmd；在 qmd 存在的情况下第一次会话启动时，Waystone 会自己创建 `pi-memory` 集合及其路径上下文。

## 命令

| 命令 | 作用 |
|---|---|
| `/audit` | 把健康报告写到 `.audit/report-<timestamp>.md`，并通知一行摘要。`/audit reset` 清空账本和报告，保留退役链和待处理的 `/seed` 结果。 |
| `/seed` | 在后台用会话模型从你过去的 prompt 里挖取持久事实。`/seed status` 查看待处理结果，`/seed apply` 写入。参数：`[days]`、`--project <substring>`、`--to global\|project`、`--yes`。 |
| `/supersede` | 让被新记忆取代的旧记忆退役：`/supersede <oldKey> <newKey>`。`/supersede list` 和 `/supersede restore <key>` 补全整条链。键是审计报告里的 8 字符前缀。 |

## 工具

| 工具 | 用途 |
|---|---|
| `memory_write` | 往 `MEMORY.md`、项目层、每日日志、主题笔记或 wiki 页面写一条；`overwrite` 模式会替换整个文件。 |
| `memory_read` | 读取某个记忆文件，或列出每日日志、wiki 页面、主题笔记和会话摘要。 |
| `memory_search` | 用 qmd 检索全部记忆文件：`keyword`、`semantic` 或 `deep`。 |
| `memory_forget` | 删除匹配某个字符串的条目，删除前先写一份恢复记录。 |
| `memory_restore` | 用恢复 ID 撤销一次 `memory_forget`。 |
| `scratchpad` | 添加、勾选、取消勾选、清空或列出清单项。 |
| `memory_status` | 报告文件位置、qmd 与集合状态、嵌入是否就绪，以及当前生效的配置。 |

## 工作原理

1. **`session_start`** —— 检测 qmd 并建立集合，读取项目信任状态，重置写锁状态，构建第一份记忆快照。
2. **快照** —— 依次拼接项目记忆、未完成的便签项、今天的日志、`MEMORY.md`、昨天的日志和知识索引（各自受上限约束），再做后处理：丢掉已退役的条目、按验证标签排序、为失效路径加注、更新审计账本。
3. **`before_agent_start`** —— 在 `stable` 模式下把存好的字节追加到 system prompt，不重建任何内容，因此前缀缓存成立。在 `refresh`/`per-turn` 模式下，则按该模式允许的触发条件重建。
4. **本轮对话中** —— 模型调用工具。写入经过目录锁，落到 markdown，并安排一次去抖的 `qmd update` 和一次增量 `qmd embed`。
5. **`session_before_compact`** —— 把带未完成便签项的交接条目追加到今天的日志，并刷新快照；这是上下文本来就要重建的时刻，只花一次有意的缓存边界。
6. **`session_shutdown`** —— 把退出摘要写进每日日志（除非被关闭），刷出审计账本，取消或冲刷已安排的 qmd 工作。
7. **`/audit`** —— 拿账本对照磁盘上的文件，列出从未进入过模型的、指向已删除文件的、以及重复的内容。

## 配置

下面每个变量在代码里都真实存在；除此之外不读取任何变量。

| 变量 | 取值 | 默认值 | 作用 |
|---|---|---|---|
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | 记忆存放位置。 |
| `PI_MEMORY_SNAPSHOT` | `stable`、`refresh`、`per-turn` | `stable` | `stable` 每个会话构建一次记忆块；`refresh` 还会在长期记忆写入和跨日时重建；`per-turn` 每轮都重建。 |
| `PI_MEMORY_LEDGER` | `on`、`off` | `on` | 在 `.audit/ledger.json` 里记录每个条目被注入的次数。 |
| `PI_MEMORY_STALE_CHECK` | `annotate`、`fold`、`off` | `annotate` | 当一个条目引用的路径全部消失时怎么处理：加注、折叠成一行 `[stale]`，或忽略。 |
| `PI_MEMORY_QMD_UPDATE` | `background`、`manual`、`off` | `background` | 写入后自动执行 `qmd update` 和 `qmd embed`。 |
| `PI_MEMORY_QMD_COLLECTION` | name | `pi-memory` | 要检索的 qmd 集合。只有当另一份安装使用同一集合时才需要改。 |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | 正整数 | `60000` | 一次显式 `memory_search` 的超时。 |
| `PI_MEMORY_EMBED_PROBE_TIMEOUT_MS` | 正整数 | `15000` | `memory_status` 探测嵌入是否就绪的超时。 |
| `PI_MEMORY_NO_SEARCH` | `1` | 未设置 | 在 `per-turn` 模式下跳过每轮自动检索。 |
| `PI_MEMORY_EXIT_SUMMARY` | `0`、`off`、`false`、`no` | 未设置（启用） | 真正退出时是否写退出摘要。 |
| `PI_MEMORY_EXIT_SUMMARY_MODEL` | `provider/model-id` | 未设置（会话模型） | 写退出摘要所用的模型。 |
| `PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT` | `minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`none`、`off` | `low` | 该次调用的推理强度。 |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | 正整数 | `10000` | 退出摘要的自设超时。 |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`、`true`、`yes`、`on` | 未设置 | 在 `/reload`、`/new`、`/resume`、`/fork` 时也写摘要。 |

## 记忆存在哪里

```
~/.pi/agent/memory/
  MEMORY.md                 curated long-term memory, one entry per block
  SCRATCHPAD.md             checklist of open items
  daily/YYYY-MM-DD.md       append-only daily log
  topics/<name>.md          the body of one subject
  wiki/<name>.md            linked knowledge pages
  transcripts/              session digests written by earlier versions (readable)
  recovery/<id>.json        payload of a memory_forget, for memory_restore
  .audit/ledger.json        injection counts per entry
  .audit/supersedes.json    the supersede chain
  .audit/seed-result.json   a pending /seed result
  .audit/report-<ts>.md     generated audit reports (newest 20 kept)

<repo>/.pi/memory/MEMORY.md project tier: committed and shared with the team
```

| 文件 | 作用 |
|---|---|
| `MEMORY.md` | 跨项目跟随你的持久事实。会被注入、受上限约束、按验证标签排序。 |
| `SCRATCHPAD.md` | 只放未完成项；已勾选项从注入中去掉，但仍留在文件里。 |
| `daily/<date>.md` | 某一天发生的所有事。今天和昨天会被注入；更早的只能检索。 |
| `topics/`、`wiki/` | 长篇笔记。只注入每个文件的一行索引；正文靠 `memory_read` 取。 |
| `recovery/` | 完整的已删除内容。不在 qmd 的 `**/*.md` 索引范围内。 |
| `.audit/` | 诊断数据：账本、退役链、待处理结果、报告。从不注入。 |

## 审计

下面是在一份 fixture 上真实运行 `buildAuditReport` 的输出。已裁剪：生成时间那一行和账本表格。

```text
# Memory audit report

## Overview

- Memory entries on disk: **5**
- Context injections recorded: **1**
- Entries that reached the model at least once: **5/5**
- Stale-path detection: `annotate`

## Findings

| Finding | Count |
| --- | --- |
| Never injected | 0 |
| Cut off by the budget | 0 |
| Outside the injected part of memory | 0 |
| Points at a file that no longer exists | 1 |
| Injected exactly once | 5 |
| Duplicated across files | 1 |
| Ledger rows with no matching file entry | 0 |
| Contradiction candidates | 0 |
| Superseded (on disk, not injected) | 0 |

## Stale: referenced file is gone

- `1186779c` (MEMORY.md) — #convention The API entry point lives in src/api/routes.ts.
  - missing: src/api/routes.ts

## Duplicates

- `MEMORY.md` + `MEMORY.md` — #preference Prefer small commits with Conventional Commit messages.
```

账本统计的是*注入*，不是*使用*：它回答的是「这条记忆是否进过模型的上下文」，而不是「模型是否据此行动」。条目按自身文本的哈希建键，所以计数在编辑和 forget/restore 之后依然有效。

## 对比

智能体记忆的四种形态，按各自优化的目标来分：

| 做法 | 优化的是什么 | 真相存在哪里 |
|---|---|---|
| 一份静态指令文件 | 零机制：一个文件，启动时读一遍 | 仓库里的一个文件 |
| 托管的抽取服务 | 不必操心写入 | 厂商的存储 |
| agent runtime 内置记忆 | 不用额外安装 | runtime 自己的存储 |
| 图记忆或向量记忆库 | 关系与相似度召回 | 一个需要查询的索引 |

Waystone 是第五种形态：它优化的是*注入预算*和*审计线索*，并把真相留在你本来就拥有的 markdown 里。这个取舍是否合适，取决于你有多在意 prompt 里装了什么，以及你是否需要能手工读完整个记忆。

## 常见问题

**没有 qmd 能用吗？** 能。写入、读取、遗忘、恢复、便签和状态都是本地的。`memory_search` 会返回安装说明而不是结果。

**为什么我写的内容没有立刻出现在 system prompt 里？** 默认的 `stable` 模式故意每个会话只构建一次记忆块，这样前缀缓存才能存活。写入在工具调用历史里可见，也能通过 `memory_read` 取到；`memory_forget`、`memory_restore` 和 `/supersede` 确实会刷新它。如果你宁愿每次写入都付一次缓存失效的代价，设 `PI_MEMORY_SNAPSHOT=refresh`。

**可以手动改这些文件吗？** 可以。没有任何 schema 解析；手写的 `#已验证` 标签优先于一切，失效的条目直接删掉即可。

**两个会话同时写入会怎样？** 写入要拿一把目录锁（跨进程有效），读发生在锁内。如果 5 秒内拿不到锁，写入照样执行，因为丢掉一条记忆比丢掉一次并发更新更糟。

**它会自己调用模型吗？** 只有你运行 `/seed` 时，以及退出时的退出摘要（`PI_MEMORY_EXIT_SUMMARY=off` 可关闭）。注入本身是本地文件操作，外加在 `per-turn` 模式下的一次 qmd 检索。

## 参与贡献

- `npm run build`（tsc）和 `npm run lint`（Biome）必须通过；测试必须保持全绿。
- 提交信息用 Conventional Commits，祈使句。
- 保持模块顺序：`memory-core` ← `search` ← `maintenance` ← `commands` ← `index`。反向 import 属于设计变更，不是修 bug。
- 行为变更必须带一个在改动前会失败的测试。

### 测试

```bash
npm test                          # 197 unit tests (Bun, no LLM, no qmd)
npm run test:checks               # 5 suites, 69 checks (tsx only)
npx tsx test/live-search.check.ts # needs qmd and the real collection
npm run test:e2e                  # needs pi + an API key
npx tsx test/perf.check.ts        # timings only, no thresholds
```

五套检查覆盖审计层、项目层、seed 挖取、命令接线以及此前的回归；端到端测试会备份并还原它动过的记忆文件。

## 许可证

[MIT](LICENSE)。

## 鸣谢

Waystone 基于 **[jayzeng/pi-memory](https://github.com/jayzeng/pi-memory)**（MIT）分支而来，记忆工具、注入层和审计设计都起源于那里。检索使用 [qmd](https://github.com/tobi/qmd)。原项目把灵感归功于 [skyfallsin/pi-mem](https://github.com/skyfallsin/pi-mem)。
