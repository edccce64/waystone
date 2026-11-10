# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/), and this project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `test/perf.check.ts`: prints the timings of the hot paths (context
  building, the audit pass, qmd search p95) with a fixed fixture. It sets no
  thresholds and is not part of `npm run test:checks` or CI.
- `/dream`: consolidates long-term memory against the raw session evidence.
  It collects the long-term entries, the daily logs and the session
  transcripts, exports a compact digest of every session into `transcripts/`,
  and asks the model for a concrete list of edits (`verify`, `fix`, `add`,
  `forget`, `merge`, `wiki`). The list lands in `.audit/dream-result.json`;
  `/dream apply` is the only step that writes to memory. Forgotten entries
  still get a recovery record.
- Knowledge index: `topics/<name>.md` and `wiki/<name>.md` hold the bodies,
  and the injected context carries one line per file. `memory_read` lists or
  reads them with the new `wiki`, `topics` and `transcripts` targets.
  `memory_write` gained the `topic` and `wiki` targets.
- Verification status: entries can be tagged `#已验证` / `#未验证` /
  `#待验证` (also `#verified`, `#unverified`, `#pending`). The injected layer
  puts explicitly unverified entries last. `/dream` records its verdicts in
  `.audit/verified.json` and leaves the markdown untouched.
- `PI_MEMORY_QMD_COLLECTION` names the qmd collection this extension
  searches. It defaults to `pi-memory`, the upstream name, so an existing
  setup keeps working. Change it when this extension runs next to another
  one that uses the same collection.

### Changed

- The extension is split across five modules: `memory-core.ts` (paths, files,
  locks, sidecars, verification, context assembly), `search.ts` (qmd),
  `maintenance.ts` (audit, supersede, `/seed`, `/dream`, lifecycle hooks),
  `commands.ts` (commands and tools) and `index.ts` (wiring only). The import
  order is one-way, and `pi.extensions` still points at `./index.ts`, so
  installing is unchanged. Command arguments, messages and `.audit` formats
  are untouched.
- The stale-path check is on by default. A memory entry that mentions a file
  which no longer exists is annotated in the injected context. Set
  `PI_MEMORY_STALE_CHECK=off` to turn it off.
- The knowledge index is part of the injected context whenever `wiki/` or
  `topics/` holds a file.
- Entries that carry a verification tag are reordered, so the unverified ones
  sink to the end of the injected block.

### Removed

- Correction capture. Detecting a correction in the raw prompt, appending it
  to the daily log, and injecting a matching system-prompt block are gone,
  together with the environment switch that enabled them. In practice it fired
  on ordinary requests that happened to contain a matching phrase, and each
  such turn paid for a daily-log write and a system-prompt rewrite. The model
  is still told to persist durable rules with `memory_write`.

### Fixed

- The audit report tells the tiers apart. An entry in an older daily log, or a
  scratchpad item that is already done, was counted as "never injected",
  although the injection never reads those places. They are now listed as
  "outside the injected part of memory".
- The audit report has a new section, "cut off by the budget". A file that
  was cut before it reached the model holds fragments, not entries. The
  ledger now records which sources were cut, so the entries behind the cut
  are not reported as dead weight.
- A superseded entry is no longer reported as a ledger row without a file
  entry. It is still on disk, only retired.
- The knowledge index and the retrieved snippets are no longer counted as
  ledger rows without a file entry.
- The ledger, the supersede chain and the verification sidecar are re-read
  when the file on disk changes. Another session's change is now visible
  without a restart.
- `/dream apply` writes nothing until every action has been processed. A
  failure in the middle can no longer leave a wiki page written and the
  long-term file untouched.
- `/dream` collects its material in the background. Reading every session
  file of the last days took longer than the command limit allows.
- A session file is read up to 8 MB. A bigger file is read in part.
- A wiki page or topic note cannot be named `con`, `nul`, `com1` and the
  other names Windows refuses.
- The verification sidecar is parsed once and kept in memory. Every
  injection read the file again.
- Every memory write now runs under a lock. Two sessions that write at the
  same time used to overwrite each other, because each one read the file,
  changed it and wrote it back.
- `verified.json` and `supersedes.json` are written through a temporary file
  and a rename. A crash in the middle of a write used to leave half a file,
  which the reader silently treated as an empty state.
- Every sidecar now shares one reader and one atomic writer, including the
  `/dream` and `/seed` result files. A crash in the middle of a write can no
  longer leave a truncated result that the next command refuses to read.
- `/seed apply` no longer writes into the repository that happens to be open.
  A project run belongs to the repository it was mined in, and the run is
  refused elsewhere.
- `/seed apply` refuses to run while the background extraction is still
  running, and an applied run cannot be revived by a later batch.
- The exported session digests and the audit reports are pruned. The digests
  are search evidence, not an archive.
- A wiki page or topic note cannot grow past 20 000 characters.
- The verification sidecar now reaches the injected order. `/dream verify`
  stored its verdict under the key of the whole stamped block, while the
  injection looked it up under the key of the body, so the two never matched
  and every entry kept its `pending` rank.
- `/dream`'s `merge` action now merges. It only deleted the old entry and
  ignored the `into` field, so the body of the old entry was lost. The old
  body now moves into the target entry and the old entry is retired with a
  recovery record.
- `/audit reset` no longer deletes the whole `.audit` directory. It clears the
  ledger and the generated reports and keeps the supersede chain, the
  verification sidecar and the pending `/seed` and `/dream` results.
- A correction that carries a credential is no longer captured. It used to be
  injected into the system prompt and offered to the model as a memory to
  write, while only the write to disk was blocked.
- The session digests that `/dream` exports no longer contain lines with a
  credential, and `/seed` no longer sends such prompts to the model. The
  filtering now happens before the model call, as the README claims.
- `/dream`'s `add`, `fix` and `wiki` actions refuse text that carries a
  credential, and `add` only accepts a known category.
- The project tier now counts towards the overall context budget. It used to
  be injected on top of the full budget, so the injection could reach about
  19 000 characters instead of 16 000.
- qmd is now located through the known npm global prefixes
  (`%APPDATA%\npm\node_modules` and friends) when the npm bin directory is not
  on `PATH`. GUI-launched agents inherit a `PATH` that does not contain it,
  which silently disabled `memory_search`, the automatic re-index and the
  automatic embedding.
- `qmd context add` now uses the virtual path form (`qmd://pi-memory/daily`).
  A plain path is rejected unless it points at an indexed document, so the
  daily logs never got a context description.
- `QMD_EMBED_PARALLELISM=1` is set for every qmd call. On a 2 GB GPU the
  embedding pool leaves no room for the reranker, and `qmd query` died with a
  Vulkan allocation error.
- `setupQmdCollection` no longer aborts when the collection already exists.
  The path contexts are registered either way.
- The audit check suite no longer depends on the calendar: the entry it
  inspects is written to today's log.
- The end-to-end suite runs on Windows. It piped the prompt through `base64`,
  which the Windows shell does not provide, and its mock of the extension API
  lacked `registerCommand`, so five cases failed before any test ran.
- The qmd end-to-end check no longer reads the live memory. It uses a
  throwaway collection, so a machine with real memories is not disturbed.
- The live search check no longer hardcodes one machine's memory content. It
  searches for `memory` by default, takes the word from
  `PI_MEMORY_E2E_QUERY` and skips with `PI_MEMORY_E2E_QMD=0`.
- The fork check suites run in CI on Linux and Windows. The one assertion that
  depended on a Windows path separator was rewritten.
- The end-to-end suite no longer leaves anything behind. It names the daily
  files with the local date, the same way the extension does, turns the exit
  summary of its own pi sessions off, and restores every daily log it
  touched.

## [0.4.2] — 2026-08-10

### Added

- `PI_MEMORY_EXIT_SUMMARY=0` (aliases: `off`/`false`/`no`) disables the exit
  summary on real quit (Ctrl+D, `/quit`, session end). With summaries disabled,
  quitting performs no LLM call and no `qmd update`, so it is instant.
  Lifecycle-transition skips are unchanged. (#26)
- `PI_MEMORY_EXIT_SUMMARY_MODEL=provider/model-id` overrides the model used to
  write exit summaries (default: the session's active model), e.g. to route
  summaries to a cheaper/faster model. Unresolvable specs fall back to the
  session model with a warning. (#26)

### Fixed

- Exit summaries whose every section is "None." (trivial sessions with nothing
  worth recording) are no longer persisted to the daily log, completing the
  curated-write gate — previously such boilerplate entries were appended,
  re-injected at every session start, and indexed by qmd. (#26)
- Exit-summary generation on `session_shutdown` is now bounded by a
  self-imposed timeout (`PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS`, default 10s).
  Pi core awaits shutdown handlers with no timeout, so a hanging provider
  previously blocked quitting indefinitely. On expiry nothing is persisted.
  (#26)

### Changed

- npm releases now run on the package's supported Node.js 22.19 runtime and
  publish provenance attestations after lint, build, and unit-test gates pass.

## [0.4.1] — 2026-08-08

### Changed

- Reduced pull-request CI duplication and setup overhead by consolidating the
  fast verification jobs, canceling superseded runs, moving API-backed e2e to
  an explicit workflow, and caching the path-filtered Windows qmd smoke test.
- Migrated Pi runtime imports and peer dependencies from the retired
  `@mariozechner` scope to `@earendil-works` 0.81.1+, including its unified
  TypeBox exports and compatibility API. The minimum Node.js version is now
  22.19.0 to match the current Pi runtime. Refreshed the development pins and
  npm/Bun dependency locks against the current 0.84.1 release.

## [0.4.0] — 2026-07-19

### Changed

- Daily logs and timestamps now use the user's local calendar date instead of
  UTC, preventing evening writes from landing in the following day's file.
- Scratchpad mutations preserve hand-written notes, headings, comments, and
  sub-bullets instead of rebuilding the file from checklist items alone.
- Exit summaries are skipped for trivial sessions and are only written when a
  real summary is generated, keeping boilerplate and low-value entries out of
  the daily log.
- `memory_search` clamps result limits to the supported range and reliably
  clears its search timeout.
- `memory_forget` now recognizes generated entry boundaries in CRLF-formatted
  memory files and files with a UTF-8 BOM instead of treating them as
  unstructured deletion blocks.

### Added

- Recoverable deletion: `memory_forget` writes the complete removed entries to
  `recovery/<id>.json` before changing memory and returns the ID visibly. The
  new `memory_restore` tool restores that record without overwriting later
  memory writes.

## [0.3.14] — 2026-06-10

- Packaging-only version bump; no runtime changes from 0.3.13.

## [0.3.13] — 2026-06-10

### Changed

- **Peer dependency floors raised**: `@mariozechner/pi-ai` and
  `@mariozechner/pi-coding-agent` now require `>=0.52.0` (previously
  `>=0.0.1`). If you run an older pi, stay on 0.3.12.
- **`postinstall` no longer touches your git config.** It previously ran
  `git config core.hooksPath .githooks` unconditionally, which — when pi-memory
  was installed as a dependency — repointed the *consumer's* repo at a hooks
  directory that isn't shipped. Dev-only hook setup is now gated to a real
  source checkout.
- **`postinstall` is quiet.** The qmd install instructions are no longer printed
  on every install; the extension already surfaces them in-session (once) when
  qmd is missing.
- **`npm test` runs the fast unit suite** (no API key, ~0.5s). End-to-end and
  recall-eval suites moved to `npm run test:e2e` and `npm run test:eval`.
- The npm publish workflow now runs lint + build + unit tests and verifies the
  pushed `v*` tag matches `package.json` before publishing. Manual
  (`workflow_dispatch`) runs must also be dispatched from a release tag.

### Added

- **Automatic embeddings — no more manual `qmd embed`.** An incremental
  `qmd embed` now runs in the background after each debounced `qmd update`, as
  a catch-up at session start, and when `memory_search`/`memory_status` detect
  missing embeddings. Semantic/deep search comes online without any manual
  step (the very first embed may take a minute while the model downloads).
  Disabled together with re-indexing via `PI_MEMORY_QMD_UPDATE=manual|off`.
- `memory_status` tool — reports qmd availability, collection state, and whether
  embeddings are ready, so search health is one tool call away.
- `engines.node >= 20`.

### Removed

- `test/unit.ts`, the stale 18-test predecessor of `test/unit.test.ts`.

## [0.3.12] — 2026-05-22

- Windows: bypass broken qmd `.cmd`/`.ps1` shims (cmd-shim writes a literal
  `/bin/sh` interpreter) by invoking qmd's JS entry with `node` directly.
- CI: add a Windows job and a qmd smoke test; install qmd via npm
  (`@tobilu/qmd`) on Windows; enforce LF line endings via `.gitattributes`.
- Bump dependencies.

## [0.3.10] — 2026-05-21

- **KV cache-stable memory snapshot** (default `PI_MEMORY_SNAPSHOT=stable`): the
  injected memory block is byte-stable across turns, so local prefix caches
  (llama.cpp, vLLM, MLX) hit on every normal turn instead of reprocessing the
  conversation tail. The snapshot refreshes only at deliberate checkpoints —
  `session_start`, `session_before_compact`, `memory_write(target: long_term)`,
  and day rollover.
- Per-turn qmd search is **no longer auto-injected by default**; the model
  retains on-demand recall via `memory_search`. Set `PI_MEMORY_SNAPSHOT=per-turn`
  to restore the old behavior.
- Snapshot system-prompt header now includes the snapshot reason and timestamp.
- qmd detection uses the lighter `qmd collection list` instead of `qmd status`
  (which could trigger slow device probing and false negatives).
- Negative qmd-availability results use a short TTL so installing qmd mid-session
  is picked up quickly; the collection cache is seeded on setup.
- Skip exit-summary generation on `/reload` (and other lifecycle transitions) to
  keep those transitions fast. Opt back in with `PI_MEMORY_SUMMARIZE_TRANSITIONS=1`.

## [0.3.8] — 2026-04-14

- Auto exit summaries on session shutdown (`ctrl+d`, `/quit`, session-end),
  written to the daily log; hardened against missing models/API keys.
- Validate the daily-log date in `memory_read` to prevent path traversal.

## [0.3.6] — 2026-03-22

- Added `PI_MEMORY_DIR` to redirect memory storage from the default
  `~/.pi/agent/memory`.

## [0.3.5] — 2026-03-22

- Exit summaries on shutdown (initial implementation; `/quit` and session-end
  reasons).

## [0.3.3] — 2026-02-16

- Improve qmd search output parsing and tests.

## [0.3.2] — 2026-02-15

- Switch tooling to Biome; rely on `publishConfig` in the publish workflow.

## [0.3.0] — 2026-02-15

- Override `glob`/`rimraf` transitive dependencies.

## [0.2.0]

- **Selective injection**: before each turn, the user's prompt is searched
  against memory via qmd and top results are injected alongside standard context.
- **qmd auto-setup**: the extension creates the `pi-memory` collection and path
  contexts on session start when qmd is available.
- **Tags and links**: `#tags` and `[[wiki-links]]` encouraged as searchable
  content conventions.
- **Session handoff on compaction**: `session_before_compact` writes a handoff
  entry to the daily log with open scratchpad items and recent context.
- Context priority reordering (scratchpad > today > search > MEMORY.md > yesterday).
- `PI_MEMORY_NO_SEARCH` env var for A/B testing.
- Deterministic unit tests and a recall-effectiveness eval.

## [0.1.0]

- Initial release: `memory_write`, `memory_read`, `scratchpad`, `memory_search`.
- Context injection of MEMORY.md, scratchpad, and today/yesterday daily logs.
- qmd integration for keyword, semantic, and hybrid search.
- Debounced background `qmd update` after writes.

[Unreleased]: https://github.com/jayzeng/pi-memory/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jayzeng/pi-memory/compare/v0.3.14...v0.4.0
[0.3.14]: https://github.com/jayzeng/pi-memory/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/jayzeng/pi-memory/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/jayzeng/pi-memory/compare/v0.3.10...v0.3.12
[0.3.10]: https://github.com/jayzeng/pi-memory/compare/v0.3.8...v0.3.10
[0.3.8]: https://github.com/jayzeng/pi-memory/compare/v0.3.6...v0.3.8
[0.3.6]: https://github.com/jayzeng/pi-memory/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/jayzeng/pi-memory/releases/tag/v0.3.5
