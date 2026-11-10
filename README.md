# pi-memory

[![npm version](https://img.shields.io/npm/v/pi-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-memory)
[![npm downloads](https://img.shields.io/npm/dm/pi-memory?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-memory)
[![license](https://img.shields.io/npm/l/pi-memory)](LICENSE)

**The most popular memory extension for [pi](https://github.com/earendil-works/pi/)** — listed in the [official pi package directory](https://pi.dev/packages?name=pi-memory), with semantic search powered by [qmd](https://github.com/tobi/qmd).

Thanks to https://github.com/skyfallsin/pi-mem for inspiration.

Your coding agent forgets everything between sessions. pi-memory gives it a memory: durable facts and decisions, a running daily log, and a scratchpad of things to come back to — all as plain markdown files you can read, edit, and commit. With optional [qmd](https://github.com/tobi/qmd) it also gets keyword, semantic, and hybrid **search** across everything it has ever remembered.

## What it feels like

```text
# Session 1
you ▸ I always use pnpm in this repo, never npm. Remember that.
pi  ▸ Got it — saved to long-term memory.   (writes MEMORY.md)

# …days later, brand new session…
you ▸ add prettier as a dev dependency
pi  ▸ pnpm add -D prettier
      (recalled your package-manager preference from memory — no reminder needed)
```

Everything lives in `~/.pi/agent/memory/` as markdown, so you can also just `cat` it:

```bash
$ cat ~/.pi/agent/memory/MEMORY.md
<!-- 2026-06-07 10:12:03 [a1b2c3d4] -->
#preference [[package-manager]] Always use pnpm in this repo, never npm.
```

## Installation

```bash
# Install from npm (recommended)
pi install npm:pi-memory

# …or from a local checkout
pi install ./pi-memory
```

That's it — the six core tools (`memory_write`, `memory_forget`, `memory_restore`,
`memory_read`, `scratchpad`, `memory_status`) work immediately with no other setup.
Search is opt-in below.

### Optional: enable search with qmd

`memory_search` (and selective injection) need [qmd](https://github.com/tobi/qmd). Either install method works:

```bash
npm install -g @tobilu/qmd                      # no Bun required
bun install -g https://github.com/tobi/qmd      # ensure ~/.bun/bin is on PATH
```

When qmd is present, the extension **automatically creates** the `pi-memory`
collection and path contexts on the next session start — no manual step. Run
`memory_status` any time to confirm qmd, the collection, and embeddings are ready.

Semantic/deep modes need vector embeddings; the extension keeps them current
automatically (`qmd embed` runs in the background at session start and after
writes). The very first embed downloads the embedding model, so semantic search
may take a minute to come online on a fresh install. To set the collection up
by hand:

```bash
qmd collection add ~/.pi/agent/memory --name pi-memory
qmd context add qmd://pi-memory/daily "Daily append-only work logs organized by date"
qmd context add qmd://pi-memory/ "Curated long-term memory: decisions, preferences, facts, lessons"
qmd embed
```

The context paths are the virtual form. A plain path is rejected unless it
points at an indexed document, so `/daily` never registers.

Without qmd, the core tools still work fully — only `memory_search` and selective injection require it.

## Tools

| Tool | Description |
|------|-------------|
| `memory_write` | Write to MEMORY.md (long-term), the project tier, a daily log, a topic note or a wiki page |
| `memory_forget` | Delete matching entries and create a durable recovery record |
| `memory_restore` | Restore a deletion using the recovery ID returned by `memory_forget` |
| `memory_read` | Read any memory file, or list daily logs, wiki pages, topic notes and session digests |
| `scratchpad` | Add/done/undo/clear/list checklist items |
| `memory_search` | Search across all memory files (requires qmd) |
| `memory_status` | Health check: where files live, qmd/collection/embeddings state, active config |

### memory_search modes

| Mode | Speed | Method | Best for |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names, #tags, [[links]] |
| `semantic` | ~2s | Vector search | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | When other modes miss |

If the first search doesn't find what you need, try rephrasing or switching modes.

## File layout

```
~/.pi/agent/memory/
  MEMORY.md              # Curated long-term memory (index + conclusions)
  SCRATCHPAD.md           # Checklist of things to fix/remember
  daily/
    2026-02-15.md         # Daily append-only log
    2026-02-14.md
    ...
  topics/<name>.md        # Topic notes: the body of one subject
  wiki/<name>.md          # Wiki pages: linked knowledge the agent maintains
  transcripts/            # Session digests from earlier versions (still readable)
  recovery/
    <recovery-id>.json    # Complete payload and restore state for a memory_forget deletion
```

## How it works

### Context injection

Before every agent turn, the following are injected into the system prompt (in priority order):

1. **Open scratchpad items** (up to 2K chars)
2. **Today's daily log** (up to 3K chars, tail)
3. **MEMORY.md** (up to 4K chars, middle-truncated)
4. **Yesterday's daily log** (up to 3K chars, tail — lowest priority, trimmed first)

Total injection is capped at 16K chars.

### KV cache-stable snapshot (default)

Local prefix-caching runtimes (llama.cpp, vLLM, MLX) invalidate from the first divergent token onward. If the injected memory block changes turn-to-turn, every subsequent user / assistant / tool token gets reprocessed — effectively the entire conversation history each turn.

To keep the prefix byte-stable, the extension snapshots the memory context at deliberate checkpoints and emits the same bytes for every turn in between. Snapshots refresh on:

- **`session_start`** — fresh snapshot per session
- **`session_before_compact`** — handoff is written then snapshot refreshes (one intentional cache boundary at compaction)
- **`session_start`** is the only checkpoint in `stable` mode. Long-term writes and day rollovers do **not** re-render the block: a refresh rewrites the tail of the system prompt and voids the prefix cache for the whole conversation, which is the cost the snapshot exists to avoid, paid on the most common in-session event. The written fact is already in tool-call history, and `memory_read` / `memory_search` reach the files directly.
- **Deletions and restores** intentionally refresh the snapshot. These are rare, authority-changing operations: forgotten content must disappear from the prompt immediately, and pi does not copy deleted content into a persisted correction message merely to preserve the cache.
- Set `PI_MEMORY_SNAPSHOT=refresh` for the old behaviour (refresh on long-term write and day rollover, with a `Snapshot <reason> at <hh:mm:ss>` caveat line).

`memory_write` with `target: daily` and `scratchpad` writes do **not** mark dirty — they're high-frequency and the write content is already echoed via tool-call args. The model can always call `memory_read` / `memory_search` for the authoritative latest state.

Set `PI_MEMORY_SNAPSHOT=per-turn` to opt out and restore the old per-turn rebuild behavior, including automatic per-prompt qmd search injection.

### Selective injection (opt-in via `per-turn` mode)

When `PI_MEMORY_SNAPSHOT=per-turn` is set and qmd is available, the extension automatically searches memory using the user's prompt before each turn. The top 3 keyword results are injected alongside the standard context. This surfaces relevant past decisions without an explicit `memory_search` call, at the cost of busting the KV cache every turn (the search is prompt-dependent and cannot be cached).

The search has a 3-second timeout and fails silently. In the default `stable` mode, the model gets the same capability by calling `memory_search` on demand.

### Tags and links

Use `#tags` and `[[wiki-links]]` in memory content to improve searchability:

```markdown
#decision [[database-choice]] Chose PostgreSQL for all backend services.
#preference [[editor]] User prefers Neovim with LazyVim config.
#lesson [[api-versioning]] URL prefix versioning (/v1/) avoids CDN cache issues.
```

These are content conventions, not enforced metadata. qmd's full-text indexing makes them searchable for free.

### Session handoff

When the context window compacts, the extension automatically captures a handoff entry in today's daily log:

```markdown
<!-- HANDOFF 2026-02-15 14:30:00 [a1b2c3d4] -->
## Session Handoff
**Open scratchpad items:**
- [ ] Fix auth bug
- [ ] Review PR #42
**Recent daily log context:**
...last 15 lines of today's log...
```

This ensures in-progress context survives compaction and is visible in the next turn (via today's daily log injection).

### Other behavior

- **Persistence**: Memory files are plain markdown on disk — readable, editable, and git-friendly.
- **Recoverable deletion**: `memory_forget` stores complete deleted entries under `recovery/` before changing memory and returns a recovery ID that `memory_restore` can use. Recovery JSON is outside qmd's `**/*.md` index.
- **Tool response previews**: Write/scratchpad tools return size-capped previews instead of full file contents.
- **qmd auto-setup**: On first session start with qmd available, the extension creates the collection and path contexts automatically.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking) unless disabled via `PI_MEMORY_QMD_UPDATE`.
- **qmd embeddings**: Vector embeddings for semantic/deep search are kept current automatically — `qmd embed` (incremental) runs in the background after each re-index and as a catch-up at session start. Disabled along with re-indexing via `PI_MEMORY_QMD_UPDATE`.
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

### Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PI_MEMORY_DIR` | path | `~/.pi/agent/memory` | Override the memory storage directory |
| `PI_MEMORY_SNAPSHOT` | `stable`, `refresh`, `per-turn` | `stable` | `stable` snapshots once at session start and never re-renders it (deletions append a correction); `refresh` also re-renders on long-term writes and day rollover; `per-turn` rebuilds every turn (legacy behavior) |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Controls automatic `qmd update` + `qmd embed` after writes |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | positive integer (milliseconds) | `60000` | Sets the timeout for explicit `memory_search` qmd queries |
| `PI_MEMORY_QMD_COLLECTION` | name | `pi-memory` | The qmd collection this extension searches. Change it when this extension is installed next to another one that uses the same collection. |
| `PI_MEMORY_EMBED_PROBE_TIMEOUT_MS` | positive integer (milliseconds) | `15000` | Sets the timeout for the `memory_status` embeddings readiness probe. Raise it on slower machines if the probe reports `unknown` |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable selective injection in `per-turn` mode (no effect in `stable` mode) |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also write exit summaries during lifecycle transitions (`/reload`, `/new`, `/resume`, `/fork`). By default these transitions skip summaries for speed. |
| `PI_MEMORY_EXIT_SUMMARY` | `0`, `off`, `false`, `no` to disable | unset (enabled) | Disable the exit summary on real quit (Ctrl+D, `/quit`, session end). Quitting then does no LLM call and no `qmd update`, so it is instant; explicit `memory_write` during sessions is unaffected. |
| `PI_MEMORY_EXIT_SUMMARY_MODEL` | `provider/model-id` | unset (session model) | Model used to write the exit summary, e.g. a cheaper/faster one. Unresolvable specs fall back to the session model with a warning. |
| `PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT` | `minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`none`/`off` | `low` | Reasoning effort for the exit-summary LLM call. Some providers reject certain values (e.g. Baseten GLM-5.2 only accepts `high`/`max`/`none` and returns HTTP 400 for `low`, silently breaking exit summaries). Set this to a value your `PI_MEMORY_EXIT_SUMMARY_MODEL` accepts. Use `off` to omit the parameter and let the provider apply its own default. |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | positive integer (milliseconds) | `10000` | Self-imposed timeout for exit-summary generation on quit. Pi awaits shutdown handlers with no timeout, so a hanging provider would otherwise block quitting indefinitely. On expiry nothing is persisted. |

## Memory audit (fork addition)

This fork adds a read-only audit layer that answers three questions the tools above leave open:

- **Which memories actually reach the model, and how often.** Upstream injects a fixed slice (scratchpad, today's log, `MEMORY.md`, yesterday's log) truncated to a char budget, so a memory written today may never enter a single prompt. Every injection is tallied per entry.
- **Which memories point at files that no longer exist.** An entry naming `src/api/routes.ts` keeps costing prompt tokens after that file was renamed or deleted.
- **What memory costs.** Characters injected per snapshot, converted to a rough token figure.

The layer does not change the on-disk format. Entries are keyed by a hash of their own text, so the ledger survives edits and `memory_forget` / `memory_restore`, and the markdown stays readable by qmd, `memory_read`, and a human with `cat`. Ledger state lives in `~/.pi/agent/memory/.audit/ledger.json` and is keyed independently of the markdown files.

### Commands

| Command | What it does |
|---------|--------------|
| `/audit` | Writes a health report and notifies a one-line summary |
| `/audit reset` | Clears the ledger and the reports. The supersede chain and the pending `/seed` result stay. |

Reports land in `~/.pi/agent/memory/.audit/report-<timestamp>.md`. The newest 20 reports are kept, the rest are deleted. Findings are ranked: entries pointing at deleted files first, then entries written but never injected, then duplicates across files, then ledger rows whose text is no longer on disk.

The report keeps the tiers apart:

| Section | What it means |
|---------|---------------|
| Never injected | The entry is part of what the injection reads, but it never reached the model |
| Cut off by the budget | The entry sits behind the part of its file that the budget cut off |
| Outside the injected part of memory | The entry lives where the injection never looks: an older daily log, or a scratchpad item that is already done |
| Ledger rows with no file entry | The text was injected once and is no longer in any memory file |

### Stale-path handling

| `PI_MEMORY_STALE_CHECK` | Behaviour |
|-------------------------|-----------|
| `annotate` (default) | Keeps the entry and appends `_(audit: referenced path no longer exists: …)_` so the model knows to verify before relying on it |
| `fold` | Collapses the entry to a single `- [stale] …` line |
| `off` | No path checking at all |

Path detection is deliberately conservative. A token must contain a separator plus either a file extension or a trailing separator, and URLs, globs and template placeholders are rejected. An entry is only flagged when **every** path it mentions is gone — a memory that also names a file which still exists is more likely partially stale than wholly obsolete. A wrong "missing" flag hides real memory, so when in doubt nothing is flagged.

### Ledger

| `PI_MEMORY_LEDGER` | Behaviour |
|--------------------|-----------|
| `on` (default) | Record injections per entry |
| `off` | Disable the ledger entirely |

Writes are debounced and coalesced, flushed on `session_shutdown`, and written through a temp file plus rename. A failed write is ignored: the ledger is diagnostics and never breaks a session.

The counter measures **injection**, not usage — it answers "was this memory in the model's context", not "did the model act on it". Measuring the latter would need a judge model and is not attempted here.

## Project memory (fork addition)

Two tiers, one format:

| Tier | File | Scope | Shared with the team |
|------|------|-------|----------------------|
| global | `~/.pi/agent/memory/MEMORY.md` | follows you across every project | no |
| project | `<repo>/.pi/memory/MEMORY.md` | this repository only | yes — commit it |

Project memory is injected **ahead of** the global tier, because it describes this repository and is therefore more relevant here. It gets a smaller budget (3,000 chars) so it cannot crowd out everything else. The size of the project tier is taken out of the overall context budget, so the whole injection stays within the limit.

**The model uses it too.** `memory_write` and `memory_read` take a `project` target:

```
memory_write target: 'project', content: '#convention Tests run with vitest run, not npm test'
memory_read  target: 'project'
```

Anything scoped to one codebase should go here. Only facts that follow you everywhere belong in the global tier.

### Trust

Pi's own project-trust prompt only fires for the resources pi itself loads: `.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`. A repository carrying **only** `.pi/memory/MEMORY.md` triggers no prompt, and `isProjectTrusted()` then returns true by default.

Project memory is prompt-shaped text that lands in front of the model before your first message, so it is injected **only when you have actually answered pi's trust question for that project**. A file you have never been asked about stays out of the context. Grant trust, or keep the file out of the repo.

## Seeding from past sessions (fork addition)

A fresh memory system starts empty, and the prompts that already contain your preferences are sitting in `~/.pi/agent/sessions/`. `/seed` mines them.

```bash
/seed                       # start mining (returns immediately)
/seed 90                    # wider window
/seed 30 --project claude   # only mine sessions whose directory name matches
/seed --to project          # write into <repo>/.pi/memory/MEMORY.md instead of the global tier
/seed --yes                 # write automatically when extraction finishes
/seed status                # what is waiting
/seed apply                 # review and write the candidates
```

`--project` and `--to` are orthogonal: `--project` chooses *which sessions to mine*, `--to` chooses *where the result lands*.

**`/seed` never blocks.** Extraction is one model call per batch of prompts, which on a real history takes minutes — long enough for pi's 60s command limit to kill an inline implementation. So the command collects the prompts, returns straight away, and runs the model calls detached. You get a notification after each batch, then one when it finishes. Nothing is written until `/seed apply`.

The flow: collect user prompts → filter to durable-looking ones → ask the active model to extract durable facts as JSON → filter secrets → drop anything already in memory → hand you the result to approve.

If the session ends before extraction finishes, the partial result is still on disk in `~/.pi/agent/memory/.audit/seed-result.json` and `/seed status` will pick it up next time.

Filters applied before the model ever sees the text:

| Filter | Why |
|--------|-----|
| `/…` messages dropped | slash commands are not memory |
| < 4 or > 600 chars dropped | one-offs and pasted logs |
| exact duplicates dropped | a repeated prompt is one fact |
| outside the day window dropped | `30` means 30 days |
| credential-shaped text rejected | both before and after extraction |
| at most 200 prompts scanned | `SEED_MAX_MESSAGES`, newest first |

Extraction uses the session's active model.

Re-running is safe: anything already present in `MEMORY.md` or any daily log is skipped, so `/seed` twice writes nothing new. Seeded entries are tagged `#preference`, `#decision`, `#convention`, `#failure` or `#insight` like any other memory.

A project run belongs to the repository it was mined in. `/seed apply` refuses
to run when another repository is open, and the entries land in the repository
the run started in. `/seed apply` also refuses while the extraction is still
running, and an applied run cannot be revived by a later batch.

## Knowledge index (fork addition)

Anthropic's architecture keeps a "memory representation" layer: a wiki the
agent maintains and navigates, separate from the raw notes, with only a small
index injected. This is the same split.

```
~/.pi/agent/memory/
  topics/<name>.md        # topic notes: the body of one subject
  wiki/<name>.md          # wiki pages: linked knowledge the agent maintains
  transcripts/<date>-<session>.md   # session digests from earlier versions
```

- The injected context carries one line per file (title, path, first line).
  The bodies stay on disk.
- `memory_read` with target `wiki`, `topics` or `transcripts` lists the files,
  or reads one when `name` is given.
- `memory_write` with target `topic` or `wiki` writes a file. Give the name in
  the `topic` parameter. A note cannot grow past 20,000 characters.

## Verification status (fork addition)

A note that records only a conclusion cannot be told apart from a note that
was never checked.

- Tags: `#已验证` / `#未验证` / `#待验证` (also `#verified`, `#unverified`,
  `#pending`).
- The injected layer puts explicitly unverified notes last, so they are less
  likely to be read as established fact.

## Superseding contradictions (fork addition)

Two memories that contradict each other both stay in context, and the model re-resolves them every turn. `/audit` reports contradiction candidates — same `#tag`, largely the same wording, neither one restating the other — using word overlap. It is a heuristic, not a verdict, so nothing happens automatically.

```bash
/supersede list                     # current chain
/supersede <oldKey> <newKey>        # retire oldKey in favour of newKey
/supersede restore <key>            # undo
```

Keys are the 8-character prefixes shown throughout the `/audit` report; any unambiguous prefix works.

State lives in `~/.pi/agent/memory/.audit/supersedes.json`, not in the markdown. A superseded entry stops being injected but stays on disk, stays searchable by qmd, and is one command away from coming back. Nothing about the memory format changes, and the audit ledger keys stay stable because the text itself is never rewritten.

## Concurrent writes (fork addition)

Every memory write is a read, a change and a write back. Two pi sessions that
write at the same time used to overwrite each other.

- All writes run under a lock. The lock is a directory, so it works between
  processes as well as inside one. A lock left behind by a crashed process is
  taken over after 30 seconds.
- The read happens inside the lock, so the second writer sees the result of
  the first one.
- If the lock cannot be taken within 5 seconds, the write still runs. Losing a
  memory entry is worse than losing one concurrent update.
- `verified.json` and `supersedes.json` are written through a temporary file
  and a rename, so a crash cannot leave half a file behind.

## Troubleshooting

Run the `memory_status` tool first — it reports most of these at a glance.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `memory_search` says qmd is required | qmd not installed or not on `PATH` | Install qmd (`npm install -g @tobilu/qmd`); if installed via Bun, ensure `~/.bun/bin` is on `PATH` |
| Search returns nothing for terms you know exist | Index is stale | A background `qmd update` runs after writes; if disabled (`PI_MEMORY_QMD_UPDATE=off`), run `qmd update` manually |
| “need embeddings” on semantic/deep search | Vectors not built yet | Embedding starts automatically in the background — retry shortly. If `PI_MEMORY_QMD_UPDATE` is `manual`/`off`, run `qmd embed` yourself |
| Collection `pi-memory` missing | Auto-setup didn't run (qmd installed mid-session) | Run any `memory_search` (auto-creates it) or `qmd collection add ~/.pi/agent/memory --name pi-memory` |
| qmd works in the shell but not from pi on Windows | Broken `.cmd`/`.ps1` shims | The extension bypasses them by invoking qmd's JS entry with `node`; make sure the npm global `node_modules` dir is on `PATH` |
| Memory isn't being injected after a write | The snapshot is taken once per session and deliberately not re-rendered | The write is visible in tool-call history; use `memory_read` / `memory_search` for the current state, or set `PI_MEMORY_SNAPSHOT=refresh` (costs a full prompt reprocess per write) |

## Running tests

```bash
# Unit tests (no LLM, no qmd — fast, deterministic). Requires Bun.
npm test

# Fork check suites (no LLM, no qmd). Run with tsx, no Bun needed.
npx tsx test/audit.check.ts
npx tsx test/fixes.check.ts
npx tsx test/project.check.ts
npx tsx test/seed.check.ts
npx tsx test/wiring.check.ts

# Live search against the real qmd collection on this machine
npx tsx test/live-search.check.ts

# End-to-end tests (requires pi + API key, optionally qmd)
npm run test:e2e

# Recall effectiveness eval (requires pi + API key + qmd)
npm run test:eval

# Pin provider/model for cheaper eval runs
PI_E2E_PROVIDER=openai PI_E2E_MODEL=gpt-4o-mini npm run test:eval

# Multiple runs for statistical robustness
EVAL_RUNS=3 npm run test:eval
```

The end-to-end suite backs up and restores the memory files it touches. The qmd
end-to-end suite (`test/qmd.e2e.ts`) talks to the real qmd collection, so it
belongs to a machine, not to a clean CI run.

### Test levels

| Level | Command | Requirements | What it tests |
|-------|---------|-------------|---------------|
| Unit | `npm test` (`test/unit.test.ts`) | Bun | Context builder, truncation, handoff, scratchpad parsing, qmd plumbing |
| Checks | `npx tsx test/*.check.ts` | tsx only | Audit layer, project tier, seeding, command wiring, and the regressions of the 2026-11-10 fixes |
| Live search | `npx tsx test/live-search.check.ts` | qmd on this machine | The real collection answers a keyword and a semantic query |
| E2E | `npm run test:e2e` (`test/e2e.ts`) | pi + API key | Tool registration, write/recall, scratchpad lifecycle, search |
| Eval | `npm run test:eval` (`test/eval-recall.ts`) | pi + API key + qmd | Recall accuracy with vs without selective injection |

## Development

This is a single-file extension (`index.ts`). No build step required — pi loads TypeScript directly.

```bash
# Test with pi directly
pi -p -e ./index.ts "remember: I prefer dark mode"

# Verify memory was written
cat ~/.pi/agent/memory/MEMORY.md
```

## Publishing (maintainers)

Releases are tag-driven. Pushing a `v*` tag runs the publish workflow, which
lints, builds, runs the unit tests, verifies the tag matches `package.json`,
and then publishes to npm.

```bash
# Bump version + create the matching git tag (updates package.json)
npm version patch   # or minor / major

# Push the commit and tag — this triggers .github/workflows/publish-npm.yml
git push --follow-tags

# Verify the published install
pi install npm:pi-memory
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
