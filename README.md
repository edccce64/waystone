# Waystone

[English](README.md) · [简体中文](README.zh-CN.md)

**Memory for the [pi](https://github.com/earendil-works/pi) coding agent that treats the context window as a budget, not a dumping ground.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-197%20unit%20%2B%2069%20checks-brightgreen.svg)](#testing)

Waystone gives a coding agent a memory that survives sessions — decisions, preferences, conventions, daily notes, a scratchpad — and puts a hard cap on how much of it ever reaches the system prompt. Everything is plain markdown on disk: no database, no vector store, no service to run. With [qmd](https://github.com/tobi/qmd) installed it also gets keyword, semantic and hybrid search across everything the agent has ever written down.

It is for people who run `pi` daily and are tired of re-explaining their stack, and who want to read, edit, version and audit what their agent remembers instead of trusting a black box.

**Status:** 3 commands, 7 tools, 5 lifecycle hooks, 197 unit tests, 69 checks in 5 suites. `pi` 0.81.1 or newer; Node 22.19+ to run from source.

## Why Waystone

**Files are the source of truth.** Memory is `MEMORY.md`, `SCRATCHPAD.md`, `daily/<date>.md`, `topics/` and `wiki/` — ordinary markdown you can `cat`, edit by hand, diff and commit.

**The context has a budget.** Injection is hard-capped at 16,000 characters, split per section (long-term memory 4,000 chars / 150 lines, scratchpad 2,000 / 120, each daily log 3,000 / 120, search snippets 2,500 / 80, knowledge index 2,000 / 60). Everything else is one `memory_search` away instead of sitting in every prompt.

**It is auditable.** `.audit/ledger.json` counts every entry that was actually injected. `/audit` reports the entries that never made it, the entries pointing at files that no longer exist, and the entries duplicated across files.

**KV cache stays warm.** The default `stable` snapshot builds the memory block once per session and emits the same bytes on every turn, so a local prefix cache is not invalidated by memory churn. Deliberate exceptions: `memory_forget`, `memory_restore` and `/supersede` refresh it immediately, because a deletion has to leave the prompt.

**Project memory is a file you can commit.** `<repo>/.pi/memory/MEMORY.md` is injected ahead of the global tier, so a team shares conventions by committing one file. It only goes in when you have answered pi's project-trust question.

**Retire instead of delete.** `/supersede <old> <new>` stops injecting a memory that a newer fact replaced. The entry stays on disk, stays searchable, and `/supersede restore` puts it back.

## Demo

Illustrative session — the transcript is an example, not a recorded run:

```text
you ▸ I always use pnpm in this repo, never npm. Remember that.
pi  ▸ memory_write(target: "project", content: "#preference Use pnpm, never npm.")
      Wrote project note: .pi/memory/MEMORY.md

# …days later, a fresh session in the same repo…
you ▸ add prettier as a dev dependency
pi  ▸ pnpm add -D prettier        (the project tier was already in context)
```

The memory itself is just text:

```text
$ cat ~/.pi/agent/memory/MEMORY.md
<!-- 2026-11-10 09:14:00 [a1b2c3d4] -->
#decision Use pnpm in this repository, never npm.

<!-- 2026-11-10 09:20:11 [a1b2c3d4] -->
#convention Tests run with `bun test`, not `npm test`.
```

## Install

```bash
# 1. from a clone
git clone https://github.com/edccce64/waystone.git && cd waystone && pi install .

# 2. (optional) search and selective injection need qmd
npm install -g @tobilu/qmd      # or: bun install -g https://github.com/tobi/qmd

# 3. check the wiring
#    in pi: memory_status
```

The six local tools (`memory_write`, `memory_forget`, `memory_restore`, `memory_read`, `scratchpad`, `memory_status`) work with no further setup. `memory_search` needs qmd; on the first session start with qmd present, Waystone creates the `pi-memory` collection and its path contexts by itself.

## Commands

| Command | What it does |
|---|---|
| `/audit` | Writes a health report to `.audit/report-<timestamp>.md` and notifies a one-line summary. `/audit reset` clears the ledger and the reports and leaves the supersede chain and the pending `/seed` result. |
| `/seed` | Mines your past session prompts for durable facts with the session model, in the background. `/seed status` shows the pending result, `/seed apply` writes it. Flags: `[days]`, `--project <substring>`, `--to global\|project`, `--yes`. |
| `/supersede` | Retires a memory a newer one replaces: `/supersede <oldKey> <newKey>`. `/supersede list` and `/supersede restore <key>` complete the chain. Keys are the 8-character prefixes from the audit report. |

## Tools

| Tool | Purpose |
|---|---|
| `memory_write` | Write an entry to `MEMORY.md`, the project tier, a daily log, a topic note or a wiki page; `overwrite` mode replaces the file. |
| `memory_read` | Read a memory file, or list daily logs, wiki pages, topic notes and session digests. |
| `memory_search` | Search all memory files with qmd: `keyword`, `semantic` or `deep`. |
| `memory_forget` | Delete entries matching a string and write a recovery record first. |
| `memory_restore` | Undo a `memory_forget` by its recovery ID. |
| `scratchpad` | Add, check, uncheck, clear or list checklist items. |
| `memory_status` | Report file locations, qmd and collection state, embedding readiness, and the active configuration. |

## How it works

1. **`session_start`** — qmd is detected and the collection set up, project trust is read, the write lock state is reset, and the first memory snapshot is built.
2. **Snapshot** — the block is assembled from project memory, open scratchpad items, today's log, `MEMORY.md`, yesterday's log and the knowledge index, each capped, then post-processed: superseded entries dropped, verification-tagged entries ordered, stale paths annotated, and the audit ledger updated.
3. **`before_agent_start`** — in `stable` mode the stored bytes are appended to the system prompt. Nothing is rebuilt, so the prefix cache holds. In `refresh`/`per-turn` modes the block is rebuilt on the triggers that mode allows.
4. **During the turn** — the model calls the tools. Writes go through a directory lock, land in markdown, and schedule a debounced `qmd update` plus an incremental `qmd embed`.
5. **`session_before_compact`** — a handoff entry with open scratchpad items is appended to today's log and the snapshot is refreshed, one intentional cache boundary at the moment the context is rebuilt anyway.
6. **`session_shutdown`** — an exit summary is written to the daily log (unless disabled), the audit ledger is flushed, and the scheduled qmd work is cancelled or flushed.
7. **`/audit`** — reads the ledger against the files on disk and ranks what never reached the model, what points at deleted files, and what is duplicated.

## Configuration

Every variable below exists in the code; nothing else is read.

| Variable | Values | Default | Effect |
|---|---|---|---|
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | Where memory lives. |
| `PI_MEMORY_SNAPSHOT` | `stable`, `refresh`, `per-turn` | `stable` | `stable` builds the block once per session; `refresh` also rebuilds on long-term writes and day rollover; `per-turn` rebuilds every turn. |
| `PI_MEMORY_LEDGER` | `on`, `off` | `on` | Record per-entry injection counts in `.audit/ledger.json`. |
| `PI_MEMORY_STALE_CHECK` | `annotate`, `fold`, `off` | `annotate` | What to do with an entry whose every referenced path is gone: annotate it, fold it to one `[stale]` line, or ignore. |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Automatic `qmd update` and `qmd embed` after writes. |
| `PI_MEMORY_QMD_COLLECTION` | name | `pi-memory` | The qmd collection to search. Change it only when another install uses the same collection. |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | positive integer | `60000` | Timeout for an explicit `memory_search`. |
| `PI_MEMORY_EMBED_PROBE_TIMEOUT_MS` | positive integer | `15000` | Timeout for the `memory_status` embedding readiness probe. |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Skip the automatic per-prompt search in `per-turn` mode. |
| `PI_MEMORY_EXIT_SUMMARY` | `0`, `off`, `false`, `no` | unset (enabled) | Write an exit summary on real quit. |
| `PI_MEMORY_EXIT_SUMMARY_MODEL` | `provider/model-id` | unset (session model) | Model for the exit summary. |
| `PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `none`, `off` | `low` | Reasoning effort for that call. |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | positive integer | `10000` | Self-imposed timeout for the exit summary. |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also write summaries on `/reload`, `/new`, `/resume` and `/fork`. |

## Where memory lives

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

| File | Role |
|---|---|
| `MEMORY.md` | Durable facts that follow you across projects. Injected, capped, ordered by verification tag. |
| `SCRATCHPAD.md` | Open items only; checked items are dropped from the injection but stay in the file. |
| `daily/<date>.md` | Everything that happened on a day. Today and yesterday are injected; older days are search-only. |
| `topics/`, `wiki/` | Long-form notes. Only a one-line index per file is injected; `memory_read` fetches the body. |
| `recovery/` | Complete deleted payloads. Outside qmd's `**/*.md` index. |
| `.audit/` | Diagnostics: ledger, supersede chain, pending results, reports. Never injected. |

## Audit

Real output from `buildAuditReport` over a fixture. Trimmed: the generated-at line and the ledger table.

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

The ledger counts *injection*, not *use*: it answers "was this entry in the model's context", not "did the model act on it". Entries are keyed by a hash of their own text, so the counts survive edits and forget/restore.

## Comparison

Four shapes of agent memory, by what each one optimises:

| Approach | Optimises for | Where the truth lives |
|---|---|---|
| A static instruction file | Zero machinery: one file, read at startup | A file in the repo |
| A hosted extraction service | Not having to think about writes | A vendor's store |
| An agent runtime's built-in memory | No extra install | The runtime's own store |
| A graph or vector memory store | Relation and similarity recall | An index you query |

Waystone is a fifth shape: it optimises the *injection budget* and the *audit trail*, and keeps the truth in markdown you already own. Whether that is the right trade depends on how much you care about what is in your prompt and whether you can read the whole memory by hand.

## FAQ

**Does it work without qmd?** Yes. Write, read, forget, restore, scratchpad and status are local. `memory_search` returns install instructions instead of results.

**Why is my write not in the system prompt right away?** In the default `stable` mode the block is built once per session on purpose, so the prefix cache survives. The write is visible in tool-call history and through `memory_read`; `memory_forget`, `memory_restore` and `/supersede` do refresh it. Set `PI_MEMORY_SNAPSHOT=refresh` if you would rather pay a cache invalidation per write.

**Can I edit the files by hand?** Yes. Nothing parses a schema; a hand-written `#已验证` tag beats anything else, and a stale entry can just be deleted.

**What happens when two sessions write at once?** Writes take a directory lock (works across processes), and the read happens inside it. If the lock cannot be taken within 5 seconds the write still runs, because losing an entry is worse than losing one concurrent update.

**Does it call a model on its own?** Only `/seed` (when you run it) and the exit summary on quit, which `PI_MEMORY_EXIT_SUMMARY=off` disables. Injection itself is local file work plus, in `per-turn` mode, a qmd search.

## Contributing

- `npm run build` (tsc) and `npm run lint` (Biome) must pass; tests must stay green.
- Conventional Commits, imperative mood.
- Keep the module order: `memory-core` ← `search` ← `maintenance` ← `commands` ← `index`. A backwards import is a design change, not a fix.
- Behaviour changes come with a test that fails before the change.

### Testing

```bash
npm test                          # 197 unit tests (Bun, no LLM, no qmd)
npm run test:checks               # 5 suites, 69 checks (tsx only)
npx tsx test/live-search.check.ts # needs qmd and the real collection
npm run test:e2e                  # needs pi + an API key
npx tsx test/perf.check.ts        # timings only, no thresholds
```

The five check suites cover the audit layer, the project tier, seeding, command wiring and earlier regressions. The end-to-end suite backs up and restores the memory files it touches.

## License

[MIT](LICENSE).

## Credits

Waystone is a fork of **[jayzeng/pi-memory](https://github.com/jayzeng/pi-memory)** (MIT), which is where the memory tools, the injection layer and the audit design started. Search is [qmd](https://github.com/tobi/qmd). The original project credits [skyfallsin/pi-mem](https://github.com/skyfallsin/pi-mem) for inspiration.
