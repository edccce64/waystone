/**
 * Commands and tools: the surface the user and the model call.
 *
 * Split out of the single-file extension; import order below is the only
 * dependency order: memory-core <- search <- maintenance <- commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AuditRow, DreamResult, SeedResult, SeedTarget } from "./maintenance.js";
import {
	AUDIT_MAX_REPORT_FILES,
	activeSupersedes,
	applyDreamActions,
	clearSidecar,
	collectSeedMessages,
	commitSeedResult,
	DREAM_DEFAULT_DAYS,
	dreamInBackground,
	dreamJob,
	dreamResultFile,
	extractAllBatches,
	findConflictCandidates,
	flushAuditLedger,
	getExitSummaryReasoningEffort,
	getExitSummaryTimeoutMs,
	getSnapshotMode,
	handleJobSubcommand,
	isExitSummaryEnabled,
	markSnapshotDirty,
	missingPathsIn,
	notifySafe,
	parseDaysArg,
	projectMemoryFile,
	projectTrusted,
	pruneOldFiles,
	readLedger,
	refreshMemorySnapshot,
	resetAuditLedger,
	SEED_BATCH_SIZE,
	SEED_DEFAULT_DAYS,
	scheduleQmdRefresh,
	seedAppliedFile,
	seedJob,
	seedResultFile,
	sessionsRoot,
	staleMode,
	startDetachedJob,
	writeSupersedes,
} from "./maintenance.js";
import type { MemoryTarget } from "./memory-core.js";
import {
	AUDIT_DIR,
	type AuditBlock,
	auditKey,
	buildPreview,
	DAILY_DIR,
	dailyPath,
	ensureDirs,
	forgetBlocks,
	formatPreviewBlock,
	isReservedFileName,
	isValidDailyDate,
	KNOWLEDGE_FILE_MAX_CHARS,
	MEMORY_FILE,
	nowTimestamp,
	parseScratchpad,
	pathsEqual,
	RESPONSE_PREVIEW_MAX_CHARS,
	RESPONSE_PREVIEW_MAX_LINES,
	readFileSafe,
	readRecoveryRecord,
	recoveryPath,
	SCRATCHPAD_FILE,
	scratchpadAdd,
	scratchpadClearDone,
	scratchpadToggle,
	serializeScratchpad,
	shortSessionId,
	splitAuditBlocks,
	TOPICS_DIR,
	TRANSCRIPTS_DIR,
	todayStr,
	updateMemoryFile,
	WIKI_DIR,
	withMemoryLock,
	writeRecoveryRecord,
	yesterdayStr,
} from "./memory-core.js";
import {
	checkCollection,
	detectQmd,
	ensureQmdAvailableForUpdate,
	ensureQmdEmbed,
	getEmbedProbeTimeoutMs,
	getMemoryInventory,
	getQmdSearchTimeoutMs,
	getQmdUpdateMode,
	probeEmbeddings,
	qmdAvailable,
	qmdCollectionName,
	qmdInstallInstructions,
	scheduleQmdUpdate,
} from "./search.js";

function applySeedResult(ctx: ExtensionCommandContext, result: SeedResult): void {
	const candidates = result.candidates;
	if (candidates.length === 0) return;

	// The background extraction may still be running. Applying now would let
	// the next batch write the result file again and revive applied entries.
	if (seedJob.inFlight) {
		notifySafe(ctx.ui, "Seed extraction is still running. Apply again when /seed status says it is done.", "warning");
		return;
	}

	// A project run belongs to the repository it was mined in.
	if (result.target === "project" && result.cwd && !pathsEqual(result.cwd, ctx.cwd)) {
		notifySafe(
			ctx.ui,
			`This seed run was collected in ${result.cwd}. Run /seed apply there, so the entries land in that repository.`,
			"warning",
		);
		return;
	}

	if (!ctx.hasUI) {
		commitSeedResult(ctx, result);
		return;
	}

	const preview = candidates
		.slice(0, 40)
		.map((c) => `#${c.category} ${c.text}`)
		.join("\n");
	const targetCwd = result.cwd ?? ctx.cwd;
	const where = result.target === "project" ? `project memory (${projectMemoryFile(targetCwd)})` : "MEMORY.md";
	notifySafe(
		ctx.ui,
		`Writing ${candidates.length} entr${candidates.length === 1 ? "y" : "ies"} to ${where}:\n${preview}${candidates.length > 40 ? `\n…and ${candidates.length - 40} more` : ""}`,
		"info",
	);
	// Fire-and-forget so the confirm dialog can never trip the 60s command cap.
	void (async () => {
		let approved = false;
		try {
			approved = await ctx.ui.confirm(
				`Write ${candidates.length} memory entries to MEMORY.md?`,
				preview.slice(0, 600),
			);
		} catch {
			approved = false;
		}
		if (approved) commitSeedResult(ctx, result);
		else notifySafe(ctx.ui, "Seed cancelled. /seed status still holds the candidates.", "info");
	})();
}

async function runSeed(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	const sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";

	if (handleJobSubcommand(seedJob, ctx, sub, (result) => applySeedResult(ctx, result))) return;

	const yes = /(^|\s)--yes(\s|$)/.test(trimmed);
	const projectMatch = trimmed.match(/--project\s+(\S+)/);
	const days = parseDaysArg(trimmed, SEED_DEFAULT_DAYS);
	const project = projectMatch?.[1];
	const toMatch = trimmed.match(/--to\s+(global|project)\b/i);
	const target: SeedTarget = toMatch ? (toMatch[1].toLowerCase() as SeedTarget) : "global";

	if (seedJob.inFlight) {
		ctx.ui.notify("A seed run is already in progress. /seed status to check on it.", "info");
		return;
	}

	const messages = collectSeedMessages(days, project);
	if (messages.length === 0) {
		ctx.ui.notify(`No usable user prompts found in the last ${days} day(s) under ${sessionsRoot()}.`, "warning");
		return;
	}

	// Drop any stale result so a fresh run is never confused with an old one.
	clearSidecar(seedResultFile());
	clearSidecar(seedAppliedFile());

	const result: SeedResult = {
		createdAt: new Date().toISOString(),
		days,
		project,
		cwd: ctx.cwd,
		target,
		autoApply: yes,
		scanned: messages.length,
		batches: Math.ceil(messages.length / SEED_BATCH_SIZE),
		failedBatches: [],
		candidates: [],
		skippedExisting: 0,
	};

	const destination = target === "project" ? projectMemoryFile(ctx.cwd) : MEMORY_FILE;
	ctx.ui.notify(
		`pi-memory /seed: mining ${messages.length} prompt(s) from the last ${days} day(s) across ${result.batches} background batch(es). This returns now; you will be notified when it finishes, then run /seed apply. Result will target ${target} memory (${destination}).`,
		"info",
	);

	// Deliberately not awaited: pi cancels or times out anything that outlives
	// the command request.
	startDetachedJob(seedJob, () => extractAllBatches(ctx, messages, result));
}

async function runDream(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	const sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";

	if (handleJobSubcommand(dreamJob, ctx, sub, (result) => applyDreamResult(ctx, result))) return;

	if (dreamJob.inFlight) {
		ctx.ui.notify("A dream run is already in progress. /dream status to check on it.", "info");
		return;
	}

	const days = parseDaysArg(trimmed, DREAM_DEFAULT_DAYS);

	// Collecting the material reads every session file of the last days. That
	// takes longer than the command limit allows, so it runs detached, the
	// same way /seed does.
	ctx.ui.notify(
		`pi-memory /dream: collecting the last ${days} day(s) in the background. This returns now; you will be notified when the result is ready.`,
		"info",
	);
	startDetachedJob(dreamJob, () => dreamInBackground(ctx, days));
}

/** `/dream apply`: write the pending actions, then drop the sidecar. */
function applyDreamResult(ctx: ExtensionCommandContext, result: DreamResult): void {
	const report = applyDreamActions(ctx, result);
	clearSidecar(dreamResultFile());
	markSnapshotDirty();
	scheduleQmdRefresh();
	ctx.ui.notify(
		`Dream applied: ${report.verified} verified, ${report.fixed} fixed, ${report.added} added, ${report.forgotten} forgotten, ${report.merged} merged, ${report.wiki} wiki page(s).${
			report.skipped.length ? ` Skipped: ${report.skipped.join("; ")}` : ""
		}`,
		"info",
	);
}

/**
 * The detached half of /dream: gather the evidence, ask the model, publish.
 *
 * Kept as a function rather than an inline closure so `runDream` stays a
 * straight line of subcommand handling.
 */

// --- report ----------------------------------------------------------------

/**
 * Whether an entry on disk is inside the part of memory that is injected.
 *
 * Only today's and yesterday's daily log, the open scratchpad items and the
 * long-term file reach the model. An entry in an older daily log was never
 * injected, so counting it as "never injected" would be wrong.
 */
function isInInjectionScope(src: string, block: AuditBlock, scope: { today: string; yesterday: string }): boolean {
	if (src === "MEMORY.md") return true;
	if (src === "project/MEMORY.md") return projectTrusted;
	if (src === "SCRATCHPAD.md") return block.body.includes("- [ ]");
	if (src.startsWith("daily/")) {
		const date = src.slice("daily/".length).replace(/\.md$/, "");
		return date === scope.today || date === scope.yesterday;
	}
	return false;
}

function scanAllMemoryBlocks(cwd?: string): { src: string; blocks: AuditBlock[] }[] {
	const groups: { src: string; blocks: AuditBlock[] }[] = [];

	// Project tier first: it is the most specific, so it reads first.
	if (cwd) {
		const projectContent = readFileSafe(projectMemoryFile(cwd));
		if (projectContent?.trim()) {
			groups.push({ src: "project/MEMORY.md", blocks: splitAuditBlocks(projectContent, "project/MEMORY.md") });
		}
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) groups.push({ src: "MEMORY.md", blocks: splitAuditBlocks(longTerm, "MEMORY.md") });

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) groups.push({ src: "SCRATCHPAD.md", blocks: splitAuditBlocks(scratchpad, "SCRATCHPAD.md") });

	let dailyFiles: string[] = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}
	for (const file of dailyFiles) {
		const content = readFileSafe(path.join(DAILY_DIR, file));
		if (content?.trim()) groups.push({ src: `daily/${file}`, blocks: splitAuditBlocks(content, `daily/${file}`) });
	}

	return groups;
}

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function collectAuditRows(cwd: string): AuditRow[] {
	const ledger = readLedger();
	const rows: AuditRow[] = [];
	const scope = { today: todayStr(), yesterday: yesterdayStr() };
	for (const group of scanAllMemoryBlocks(cwd)) {
		for (const block of group.blocks) {
			const entry = ledger.entries[block.key];
			rows.push({
				key: block.key,
				src: group.src,
				body: block.body,
				stamp: block.stamp,
				injections: entry?.n ?? 0,
				first: entry?.first,
				last: entry?.last,
				missing: missingPathsIn(block.body, cwd),
				eligible: isInInjectionScope(group.src, block, scope),
			});
		}
	}
	return rows;
}

export function buildAuditReport(cwd: string): { markdown: string; summary: string } {
	const ledger = readLedger();
	const rows = collectAuditRows(cwd);
	const supersedes = activeSupersedes();
	const supersededKeys = new Set(Object.keys(supersedes));
	const live = rows.filter((r) => !supersededKeys.has(r.key));

	const neverInjected = live.filter((r) => r.eligible && r.injections === 0);
	const truncatedSources = new Set(ledger.truncatedSources ?? []);
	const cutOff = neverInjected.filter((r) => truncatedSources.has(r.src));
	const outOfScope = live.filter((r) => !r.eligible);
	const stale = live.filter((r) => r.missing.length > 0);
	const singleUse = live.filter((r) => r.injections === 1);
	// Every entry that is on disk counts as known, including a superseded one:
	// it is still there, only retired.
	const allKeys = new Set(rows.map((r) => r.key));
	const orphaned = Object.values(ledger.entries).filter(
		(e) => !allKeys.has(e.k) && e.src !== "search" && e.src !== "knowledge-index",
	);
	const byBody = new Map<string, AuditRow[]>();
	for (const row of live) {
		const k = auditKey(row.body);
		byBody.set(k, [...(byBody.get(k) ?? []), row]);
	}
	const duplicates = [...byBody.values()].filter((group) => group.length > 1);
	const conflicts = findConflictCandidates(live);

	const knownRows = live.filter((r) => r.injections > 0).length;
	// The denominator is the part of memory that is injected at all.
	const eligibleCount = live.filter((r) => r.eligible).length;

	const lines: string[] = [];
	lines.push("# Memory audit report", "");
	lines.push(`Generated ${new Date().toISOString()} — project \`${cwd}\``, "");
	lines.push("## Overview", "");
	lines.push(
		`- Memory entries on disk: **${rows.length}**${supersededKeys.size ? ` (**${supersededKeys.size} superseded**, kept on disk but not injected)` : ""}`,
	);
	lines.push(`- Context injections recorded: **${ledger.injections}**`);
	lines.push(`- Entries that reached the model at least once: **${knownRows}/${eligibleCount}**`);
	lines.push(`- Stale-path detection: \`${staleMode()}\``);
	lines.push("");

	lines.push("## Findings", "");
	lines.push(`| Finding | Count |`, `| --- | --- |`);
	lines.push(`| Never injected | ${neverInjected.length} |`);
	lines.push(`| Cut off by the budget | ${cutOff.length} |`);
	lines.push(`| Outside the injected part of memory | ${outOfScope.length} |`);
	lines.push(`| Points at a file that no longer exists | ${stale.length} |`);
	lines.push(`| Injected exactly once | ${singleUse.length} |`);
	lines.push(`| Duplicated across files | ${duplicates.length} |`);
	lines.push(`| Ledger rows with no matching file entry | ${orphaned.length} |`);
	lines.push(`| Contradiction candidates | ${conflicts.length} |`);
	lines.push(`| Superseded (on disk, not injected) | ${supersededKeys.size} |`);
	lines.push("");

	if (conflicts.length > 0) {
		lines.push("## Contradiction candidates", "");
		lines.push(
			"Same #tag, largely the same wording, yet neither restates the other. This is a heuristic, not a verdict — check each pair, then retire the loser with `/supersede <old> <new>`.",
			"",
		);
		for (const [older, newer] of conflicts) {
			lines.push(`- \`${older.key.slice(0, 8)}\` (${older.src}) ${oneLine(older.body, 90)}`);
			lines.push(`  vs \`${newer.key.slice(0, 8)}\` (${newer.src}) ${oneLine(newer.body, 90)}`);
		}
		lines.push("");
	}

	if (supersededKeys.size > 0) {
		lines.push("## Superseded", "");
		for (const row of rows.filter((r) => supersededKeys.has(r.key))) {
			const record = supersedes[row.key];
			lines.push(
				`- \`${row.key.slice(0, 8)}\` ${oneLine(row.body, 90)} — retired ${record.at}, superseded by \`${record.by.slice(0, 8)}\``,
			);
		}
		lines.push("");
	}

	if (stale.length > 0) {
		lines.push("## Stale: referenced file is gone", "");
		lines.push("These entries still reach the model. Confirm the new location, then update or remove them.", "");
		for (const row of stale) {
			lines.push(`- \`${row.key.slice(0, 8)}\` (${row.src}) — ${oneLine(row.body)}`);
			lines.push(`  - missing: ${row.missing.join(", ")}`);
		}
		lines.push("");
	}

	if (neverInjected.length > 0) {
		lines.push("## Never injected", "");
		lines.push(
			"Written but never present in any model context. Either it is redundant, it is too far down a file, or the file it lives in is not read at session start.",
			"",
		);
		for (const row of neverInjected.slice(0, 80)) {
			lines.push(`- \`${row.key.slice(0, 8)}\` (${row.src}) — ${oneLine(row.body)}`);
		}
		if (neverInjected.length > 80) lines.push(`- …and ${neverInjected.length - 80} more`);
		lines.push("");
	}

	if (cutOff.length > 0) {
		lines.push("## Cut off by the budget", "");
		lines.push(
			"These entries sit behind the part of their file that the injection budget cut off. They are not dead weight, they are simply too far down the file to reach the model.",
			"",
		);
		for (const row of cutOff.slice(0, 40)) {
			lines.push(`- \`${row.key.slice(0, 8)}\` (${row.src}) — ${oneLine(row.body)}`);
		}
		if (cutOff.length > 40) lines.push(`- …and ${cutOff.length - 40} more`);
		lines.push("");
	}

	if (outOfScope.length > 0) {
		lines.push("## Outside the injected part of memory", "");
		lines.push(
			'These entries live in a place the injection never reads: an older daily log, or a scratchpad item that is already done. They are counted here, but they are not "never injected" — the injection was never supposed to read them.',
			"",
		);
		for (const row of outOfScope.slice(0, 20)) {
			lines.push(`- \`${row.key.slice(0, 8)}\` (${row.src}) — ${oneLine(row.body)}`);
		}
		if (outOfScope.length > 20) lines.push(`- …and ${outOfScope.length - 20} more`);
		lines.push("");
	}

	if (duplicates.length > 0) {
		lines.push("## Duplicates", "");
		for (const group of duplicates) {
			lines.push(`- ${group.map((g) => `\`${g.src}\``).join(" + ")} — ${oneLine(group[0].body)}`);
		}
		lines.push("");
	}

	if (orphaned.length > 0) {
		lines.push("## Ledger rows with no file entry", "");
		lines.push("Recorded as injected once, but the text is no longer in any memory file (edited or forgotten).", "");
		for (const entry of orphaned.slice(0, 40)) {
			lines.push(`- \`${entry.src}\` — injected ${entry.n}x, last ${entry.last ?? "unknown"}`);
		}
		lines.push("");
	}

	lines.push("## Ledger", "");
	if (Object.keys(ledger.entries).length === 0) {
		lines.push("Empty. The ledger fills in as sessions start and snapshots are taken.", "");
	} else {
		lines.push(`| Injections | Last seen | Source | Entry |`, `| --- | --- | --- | --- |`);
		const sorted = Object.values(ledger.entries)
			.sort((a, b) => b.n - a.n)
			.slice(0, 60);
		for (const entry of sorted) {
			const row = rows.find((r) => r.key === entry.k);
			lines.push(
				`| ${entry.n} | ${entry.last ?? "-"} | \`${entry.src}\` | ${oneLine(row?.body ?? "(entry no longer on disk)", 90)} |`,
			);
		}
		lines.push("");
	}

	const summary =
		`${rows.length} 条记忆，${neverInjected.length} 条从未注入，` +
		`${stale.length} 条指向已删除文件，${duplicates.length} 条重复`;

	return { markdown: lines.join("\n"), summary };
}

function writeAuditReport(markdown: string): string {
	const stamp = nowTimestamp().replace(/[: ]/g, "-");
	const file = path.join(AUDIT_DIR, `report-${stamp}.md`);
	fs.mkdirSync(AUDIT_DIR, { recursive: true });
	fs.writeFileSync(file, markdown, "utf-8");
	pruneOldFiles(AUDIT_DIR, "report-", AUDIT_MAX_REPORT_FILES);
	return file;
}

/**
 * Experimental commands, off unless the user opts in. Same parsing as the other
 * switches: trim, lowercase, and only on/1/true count.
 */
function experimentalEnabled(): boolean {
	const value = (process.env.PI_MEMORY_EXPERIMENTAL ?? "").trim().toLowerCase();
	return value === "on" || value === "1" || value === "true";
}

/** /audit, /seed and /supersede, plus /dream when experimental commands are on. */
export function registerCommands(pi: ExtensionAPI) {
	pi.registerCommand("audit", {
		description:
			"Memory health report: entries never injected, entries pointing at deleted files, duplicates, and what memory costs per turn",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "reset") {
				resetAuditLedger();
				ctx.ui.notify("Memory audit ledger cleared.", "info");
				return;
			}
			if (sub !== "" && sub !== "report") {
				ctx.ui.notify("Usage: /audit   |   /audit reset", "info");
				return;
			}
			flushAuditLedger();
			const { markdown, summary } = buildAuditReport(ctx.cwd);
			const file = writeAuditReport(markdown);
			ctx.ui.notify(`${summary}\nFull report: ${file}`, "info");
		},
	});

	// --- /seed: bootstrap memory from past sessions ---
	pi.registerCommand("seed", {
		description:
			"Mine durable memories from your past session prompts (runs in the background). Usage: /seed [days] [--project <substring>] [--to global|project] [--yes] | /seed apply | /seed status",
		handler: async (args, ctx) => {
			await runSeed(args ?? "", ctx);
		},
	});

	// --- /dream: consolidate memory against the raw session evidence ---
	// Experimental: the command is only registered when the user opts in.
	if (experimentalEnabled()) {
		pi.registerCommand("dream", {
			description:
				"Consolidate memory against raw session transcripts: verify notes, fix wrong ones, merge duplicates, build wiki pages (runs in the background). Usage: /dream [days] | /dream apply | /dream status",
			handler: async (args, ctx) => {
				await runDream(args ?? "", ctx);
			},
		});
	}

	// --- /supersede: retire a memory a newer one replaces ---
	pi.registerCommand("supersede", {
		description:
			"Stop injecting a memory that a newer entry replaces. Usage: /supersede <oldKey> <newKey> | /supersede list | /supersede restore <key>",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();
			const rows = collectAuditRows(ctx.cwd);
			const byKey = new Map(rows.map((r) => [r.key, r]));

			// Accept any unambiguous prefix of a key so /audit's 8-char display works.
			const resolve = (input: string): string | null => {
				const needle = input.toLowerCase();
				const exact = rows.find((r) => r.key === needle);
				if (exact) return exact.key;
				const matches = rows.filter((r) => r.key.startsWith(needle));
				if (matches.length === 1) return matches[0].key;
				if (matches.length > 1) {
					ctx.ui.notify(`"${input}" matches ${matches.length} entries. Use more characters.`, "warning");
				}
				return null;
			};

			if (sub === "list" || parts.length === 0) {
				const map = activeSupersedes();
				const keys = Object.keys(map);
				if (keys.length === 0) {
					ctx.ui.notify("No superseded memories. Use /audit to see contradiction candidates.", "info");
					return;
				}
				const lines = keys
					.map((key) => {
						const row = byKey.get(key);
						const record = map[key];
						return `- ${key.slice(0, 8)} ${oneLine(row?.body ?? "(entry no longer on disk)", 70)} → ${record.by.slice(0, 8)} (${record.at})`;
					})
					.join("\n");
				ctx.ui.notify(`Superseded (${keys.length}):\n${lines}`, "info");
				return;
			}

			if (sub === "restore") {
				if (parts.length !== 2) {
					ctx.ui.notify("Usage: /supersede restore <key>", "info");
					return;
				}
				const key = resolve(parts[1]);
				if (!key) {
					ctx.ui.notify(`No memory entry matches "${parts[1]}".`, "warning");
					return;
				}
				const map = { ...activeSupersedes() };
				if (!(key in map)) {
					ctx.ui.notify(`${key.slice(0, 8)} is not superseded.`, "warning");
					return;
				}
				delete map[key];
				writeSupersedes(map);
				ctx.ui.notify(`${key.slice(0, 8)} is live again.`, "info");
				return;
			}

			if (parts.length !== 2) {
				ctx.ui.notify(
					"Usage: /supersede <oldKey> <newKey>   (keys come from /audit)\n       /supersede list | /supersede restore <key>",
					"info",
				);
				return;
			}

			const oldKey = resolve(parts[0]);
			const newKey = resolve(parts[1]);
			if (!oldKey) {
				ctx.ui.notify(`No memory entry matches "${parts[0]}".`, "warning");
				return;
			}
			if (!newKey) {
				ctx.ui.notify(`No memory entry matches "${parts[1]}".`, "warning");
				return;
			}
			if (oldKey === newKey) {
				ctx.ui.notify("An entry cannot supersede itself.", "warning");
				return;
			}

			const map = { ...activeSupersedes() };
			map[oldKey] = { by: newKey, at: new Date().toISOString() };
			writeSupersedes(map);

			const oldRow = byKey.get(oldKey);
			const newRow = byKey.get(newKey);
			if (ctx.hasUI) {
				const approved = await ctx.ui.confirm(
					`Stop injecting ${oldKey.slice(0, 8)}?`,
					`retiring: ${oneLine(oldRow?.body ?? "", 120)}\nkept as:  ${oneLine(newRow?.body ?? "", 120)}`,
				);
				if (!approved) {
					delete map[oldKey];
					writeSupersedes(map);
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}

			refreshMemorySnapshot("supersede");
			ctx.ui.notify(
				`${oldKey.slice(0, 8)} is retired. It stays on disk; /supersede restore ${oldKey.slice(0, 8)} brings it back.`,
				"info",
			);
		},
	});
}

/** The five memory tools that need no search: write, forget, restore, read, scratchpad. */
export function registerTools(pi: ExtensionAPI) {
	// --- memory_write tool ---
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to memory files. Five targets:",
			"- 'long_term': Write to the global MEMORY.md (curated durable facts that follow you across projects). Mode: 'append' or 'overwrite'.",
			"- 'project': Write to this repository's own .pi/memory/MEMORY.md (conventions, architecture and decisions that only make sense here). Commit it to share with the team.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"- 'topic': Write a topic note to topics/<name>.md. Use the 'topic' parameter for the name.",
			"- 'wiki': Write a wiki page to wiki/<name>.md. Use the 'topic' parameter for the name.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
			"Use #tags (e.g. #decision, #preference, #lesson, #bug) and [[links]] (e.g. [[auth-strategy]]) in content to improve searchability.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "project", "daily", "topic", "wiki"] as const, {
				description:
					"Where to write: 'long_term' for the global MEMORY.md, 'project' for this repo's .pi/memory/MEMORY.md, 'daily' for today's daily log, 'topic' for a topic note, 'wiki' for a wiki page.",
			}),
			content: Type.String({ description: "Content to write (Markdown)" }),
			topic: Type.Optional(
				Type.String({
					description: "File name (without .md) for the 'topic' and 'wiki' targets.",
				}),
			),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "Write mode for long_term and project targets. Default: 'append'. Daily always appends.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const { target, content, mode } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			if (target === "topic" || target === "wiki") {
				const name = (params.topic ?? "").trim();
				if (!name) {
					return {
						content: [
							{ type: "text", text: `The '${target}' target needs a 'topic' parameter with the file name.` },
						],
						isError: true,
						details: { target },
					};
				}
				const fileName = `${name.replace(/[^\w一-龥.-]+/g, "-")}.md`;
				if (isReservedFileName(fileName)) {
					return {
						content: [
							{
								type: "text",
								text: `"${name}" is a reserved file name on Windows. Choose another name.`,
							},
						],
						isError: true,
						details: { target, topic: name },
					};
				}
				const dir = target === "wiki" ? WIKI_DIR : TOPICS_DIR;
				fs.mkdirSync(dir, { recursive: true });
				const file = path.join(dir, fileName);
				const written = withMemoryLock(() => {
					const existing = readFileSafe(file) ?? "";
					const next =
						mode === "overwrite" ? content : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${content}\n`;
					if (next.length > KNOWLEDGE_FILE_MAX_CHARS) return { ok: false as const, size: next.length };
					fs.writeFileSync(file, next, "utf-8");
					return { ok: true as const, size: next.length };
				});
				if (!written.ok) {
					return {
						content: [
							{
								type: "text",
								text: `The ${target} note would reach ${written.size} characters. The limit is ${KNOWLEDGE_FILE_MAX_CHARS}. Shorten the note or split it into several notes.`,
							},
						],
						isError: true,
						details: { target, path: file, limit: KNOWLEDGE_FILE_MAX_CHARS },
					};
				}
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Wrote ${target} note: ${file}` }],
					details: { path: file, target, topic: name, timestamp: ts },
				};
			}

			if (target === "project") {
				const projectFile = projectMemoryFile(ctx.cwd);
				const existing = readFileSafe(projectFile) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "middle",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing project MEMORY.md preview", existing, "middle")}`
					: "\n\nProject MEMORY.md was empty.";

				fs.mkdirSync(path.dirname(projectFile), { recursive: true });
				markSnapshotDirty();

				if (mode === "overwrite") {
					const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
					updateMemoryFile(projectFile, () => stamped);
					await ensureQmdAvailableForUpdate();
					scheduleQmdUpdate();
					return {
						content: [{ type: "text", text: `Overwrote ${projectFile}${existingSnippet}` }],
						details: {
							path: projectFile,
							target,
							mode: "overwrite",
							sessionId: sid,
							timestamp: ts,
							qmdUpdateMode: getQmdUpdateMode(),
							existingPreview,
						},
					};
				}

				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				updateMemoryFile(projectFile, (existing) => {
					const separator = existing.trim() ? "\n\n" : "";
					return existing + separator + stamped;
				});
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Appended to project memory: ${projectFile}${existingSnippet}` }],
					details: {
						path: projectFile,
						target,
						mode: "append",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "end",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing daily log preview", existing, "end")}`
					: "\n\nDaily log was empty.";

				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				updateMemoryFile(filePath, (existing) => {
					const separator = existing.trim() ? "\n\n" : "";
					return existing + separator + stamped;
				});
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Appended to daily log: ${filePath}${existingSnippet}`,
						},
					],
					details: {
						path: filePath,
						target,
						mode: "append",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// long_term
			const existing = readFileSafe(MEMORY_FILE) ?? "";
			const existingPreview = buildPreview(existing, {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "middle",
			});
			const existingSnippet = existingPreview.preview
				? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", existing, "middle")}`
				: "\n\nMEMORY.md was empty.";

			// Long-term writes change the ambient "background context" the model
			// should always see. Mark snapshot dirty so the next turn refreshes.
			// Daily writes are high-frequency and already echoed via tool-call
			// args — they are intentionally NOT marked dirty.
			markSnapshotDirty();

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				updateMemoryFile(MEMORY_FILE, () => stamped);
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text", text: `Overwrote MEMORY.md${existingSnippet}` }],
					details: {
						path: MEMORY_FILE,
						target,
						mode: "overwrite",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// append (default)
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			updateMemoryFile(MEMORY_FILE, (existing) => {
				const separator = existing.trim() ? "\n\n" : "";
				return existing + separator + stamped;
			});
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [{ type: "text", text: `Appended to MEMORY.md${existingSnippet}` }],
				details: {
					path: MEMORY_FILE,
					target,
					mode: "append",
					sessionId: sid,
					timestamp: ts,
					qmdUpdateMode: getQmdUpdateMode(),
					existingPreview,
				},
			};
		},
	});

	// --- scratchpad tool ---
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, {
				description: "What to do",
			}),
			text: Type.Optional(
				Type.String({
					description: "Item text for add, or substring to match for done/undo",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureDirs();
			const { action, text } = params;
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();

			const existing = readFileSafe(SCRATCHPAD_FILE) ?? "";
			const items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return {
						content: [{ type: "text", text: "Scratchpad is empty." }],
						details: {},
					};
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				return {
					content: [
						{
							type: "text",
							text: formatPreviewBlock("Scratchpad preview", serialized, "start"),
						},
					],
					details: {
						count: items.length,
						open: items.filter((i) => !i.done).length,
						preview,
					},
				};
			}

			if (action === "add") {
				if (!text) {
					return {
						content: [{ type: "text", text: "Error: 'text' is required for add." }],
						details: {},
					};
				}
				const serialized = scratchpadAdd(existing, text, `<!-- ${ts} [${sid}] -->`);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Added: - [ ] ${text}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					return {
						content: [
							{
								type: "text",
								text: `Error: 'text' is required for ${action}.`,
							},
						],
						details: {},
					};
				}
				const targetDone = action === "done";
				const toggled = scratchpadToggle(existing, text, targetDone);
				if (!toggled.matched) {
					return {
						content: [
							{
								type: "text",
								text: `No matching ${targetDone ? "open" : "done"} item found for: "${text}"`,
							},
						],
						details: {},
					};
				}
				const serialized = toggled.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Updated.\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "clear_done") {
				const cleared = scratchpadClearDone(existing);
				const removed = cleared.removed;
				const serialized = cleared.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text",
							text: `Cleared ${removed} done item(s).\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
						},
					],
					details: {
						action,
						removed,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			return {
				content: [{ type: "text", text: `Unknown action: ${action}` }],
				details: {},
			};
		},
	});

	// --- memory_read tool ---
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read the global MEMORY.md",
			"- 'project': Read this repository's .pi/memory/MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'list': List all daily log files.",
			"- 'wiki': List wiki pages, or read one. Pass name (without .md).",
			"- 'topics': List topic notes, or read one. Pass name (without .md).",
			"- 'transcripts': List exported session digests, or read one. Pass name (without .md).",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(
				["long_term", "project", "scratchpad", "daily", "list", "wiki", "topics", "transcripts"] as const,
				{
					description: "What to read",
				},
			),
			date: Type.Optional(
				Type.String({
					description: "Date for daily log (YYYY-MM-DD). Default: today.",
				}),
			),
			name: Type.Optional(
				Type.String({
					description: "File name without .md for the 'wiki', 'topics' and 'transcripts' targets.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const { target, date, name } = params;

			if (target === "wiki" || target === "topics" || target === "transcripts") {
				const dir = target === "wiki" ? WIKI_DIR : target === "topics" ? TOPICS_DIR : TRANSCRIPTS_DIR;
				const label = target === "wiki" ? "Wiki pages" : target === "topics" ? "Topic notes" : "Session digests";
				if (name?.trim()) {
					const file = path.join(dir, `${name.trim().replace(/[^\w一-龥.-]+/g, "-")}.md`);
					const content = readFileSafe(file);
					if (!content) {
						return {
							content: [{ type: "text", text: `No ${target} file named ${name} (${file}).` }],
							details: { path: file },
						};
					}
					return { content: [{ type: "text", text: content }], details: { path: file } };
				}
				let files: string[] = [];
				try {
					files = fs
						.readdirSync(dir)
						.filter((f) => f.endsWith(".md"))
						.sort()
						.reverse();
				} catch {
					files = [];
				}
				if (files.length === 0) {
					return { content: [{ type: "text", text: `No ${label} found in ${dir}.` }], details: { dir } };
				}
				return {
					content: [{ type: "text", text: `${label}:\n${files.map((f) => `- ${f}`).join("\n")}` }],
					details: { dir, files },
				};
			}

			if (target === "project") {
				const projectFile = projectMemoryFile(_ctx.cwd);
				const content = readFileSafe(projectFile);
				if (!content?.trim()) {
					return {
						content: [
							{
								type: "text",
								text: `No project memory for this repository (${projectFile}). Write one with memory_write target: 'project'.`,
							},
						],
						details: { path: projectFile },
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: projectFile },
				};
			}

			if (target === "list") {
				try {
					const files = fs
						.readdirSync(DAILY_DIR)
						.filter((f) => f.endsWith(".md"))
						.sort()
						.reverse();
					if (files.length === 0) {
						return {
							content: [{ type: "text", text: "No daily logs found." }],
							details: {},
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`,
							},
						],
						details: { files },
					};
				} catch {
					return {
						content: [{ type: "text", text: "No daily logs directory." }],
						details: {},
					};
				}
			}

			if (target === "daily") {
				const d = date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text", text: `Invalid date format: ${d}. Use YYYY-MM-DD.` }],
						isError: true,
						details: { date: d },
					};
				}
				const filePath = dailyPath(d);
				const content = readFileSafe(filePath);
				if (!content) {
					return {
						content: [{ type: "text", text: `No daily log for ${d}.` }],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: filePath, date: d },
				};
			}

			if (target === "scratchpad") {
				const content = readFileSafe(SCRATCHPAD_FILE);
				if (!content?.trim()) {
					return {
						content: [
							{
								type: "text",
								text: "SCRATCHPAD.md is empty or does not exist.",
							},
						],
						details: {},
					};
				}
				return {
					content: [{ type: "text", text: content }],
					details: { path: SCRATCHPAD_FILE },
				};
			}

			// long_term
			const content = readFileSafe(MEMORY_FILE);
			if (!content) {
				return {
					content: [{ type: "text", text: "MEMORY.md is empty or does not exist." }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: content }],
				details: { path: MEMORY_FILE },
			};
		},
	});

	// --- memory_forget tool ---
	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description: [
			"Delete outdated or incorrect facts from memory. Removes every entry/paragraph",
			"containing the match string (case-insensitive substring) from MEMORY.md, or from",
			"a daily log when target='daily'. Every deletion creates a durable recovery record",
			"whose visible recovery ID can be passed to memory_restore if the deletion was wrong.",
			"Use this when the user corrects a stored fact or a memory is no longer true —",
			"stale entries keep resurfacing in retrieval and cause confidently wrong answers.",
		].join("\n"),
		parameters: Type.Object({
			match: Type.String({
				description: "Case-insensitive substring identifying the fact(s) to remove",
			}),
			target: Type.Optional(
				StringEnum(["long_term", "daily"] as const, {
					description: "Where to delete from: 'long_term' (MEMORY.md, default) or 'daily'",
				}),
			),
			date: Type.Optional(
				Type.String({ description: "Daily log date (YYYY-MM-DD) when target='daily'. Default: today." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const target: MemoryTarget = params.target ?? "long_term";
			if (!params.match.trim()) {
				return {
					content: [{ type: "text", text: "Error: 'match' must not be empty." }],
					isError: true,
					details: {},
				};
			}
			let filePath: string;
			let recoveryDate: string | undefined;
			if (target === "daily") {
				const d = params.date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text", text: `Invalid date format: ${d}. Use YYYY-MM-DD.` }],
						isError: true,
						details: { date: d },
					};
				}
				filePath = dailyPath(d);
				recoveryDate = d;
			} else {
				filePath = MEMORY_FILE;
			}

			const existing = readFileSafe(filePath);
			if (!existing?.trim()) {
				return {
					content: [{ type: "text", text: `Nothing stored in ${filePath} — nothing to forget.` }],
					details: { path: filePath, removed: 0 },
				};
			}

			const result = forgetBlocks(existing, params.match);
			if (result.removed.length === 0) {
				return {
					content: [{ type: "text", text: `No entries matching "${params.match}" in ${filePath}.` }],
					details: { path: filePath, removed: 0 },
				};
			}

			// Persist the complete recovery payload before mutating the source file.
			// If either write fails, we never report a successful unrecoverable deletion.
			const recovery = writeRecoveryRecord(target, recoveryDate, result.removed);
			fs.writeFileSync(filePath, result.content, "utf-8");
			// Forget is a privacy-sensitive mutation. Refresh the snapshot immediately
			// so deleted content disappears from authoritative context without being
			// copied into persisted correction messages. This intentionally spends one
			// cache invalidation on an explicit deletion.
			refreshMemorySnapshot("memory_forget");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();

			const removedPreview = buildPreview(result.removed.join("\n\n"), {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "start",
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Removed ${result.removed.length} entr${result.removed.length === 1 ? "y" : "ies"} from ${filePath}. ` +
							`Recovery ID: ${recovery.id}. To undo this deletion, call memory_restore with that ID.\n\n` +
							"Removed content preview:\n\n" +
							removedPreview.preview,
					},
				],
				details: {
					path: filePath,
					target,
					removed: result.removed.length,
					recoveryId: recovery.id,
					recoveryPath: recoveryPath(recovery.id),
					removedPreview,
				},
			};
		},
	});

	// --- memory_restore tool ---
	pi.registerTool({
		name: "memory_restore",
		label: "Memory Restore",
		description: [
			"Restore entries removed by memory_forget using the recovery ID returned by that tool.",
			"Restoration is idempotent and appends only missing entries, so later memory writes survive.",
		].join("\n"),
		parameters: Type.Object({
			recoveryId: Type.String({ description: "Recovery ID returned by memory_forget" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const loaded = readRecoveryRecord(params.recoveryId);
			if (!loaded) {
				return {
					content: [{ type: "text", text: `No valid recovery record found for ID ${params.recoveryId}.` }],
					isError: true,
					details: { recoveryId: params.recoveryId },
				};
			}

			const { record, filePath: recordPath } = loaded;
			if (record.restoredAt) {
				return {
					content: [{ type: "text", text: `Recovery ${record.id} was already restored at ${record.restoredAt}.` }],
					details: { recoveryId: record.id, restoredAt: record.restoredAt },
				};
			}

			const targetPath = record.target === "daily" ? dailyPath(record.date as string) : MEMORY_FILE;
			const existing = readFileSafe(targetPath) ?? "";
			const missingEntries = record.removedContent.filter((entry) => !existing.includes(entry));
			if (missingEntries.length > 0) {
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(targetPath, `${existing}${separator}${missingEntries.join("\n\n")}\n`, "utf-8");
				// Restore changes which durable facts are authoritative, so refresh the
				// snapshot instead of persisting restored content in a correction message.
				refreshMemorySnapshot("memory_restore");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
			}

			record.restoredAt = new Date().toISOString();
			fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
			return {
				content: [
					{
						type: "text",
						text:
							missingEntries.length > 0
								? `Restored ${missingEntries.length} entr${missingEntries.length === 1 ? "y" : "ies"} to ${targetPath}.`
								: `Recovery ${record.id} was already present in ${targetPath}; marked as restored.`,
					},
				],
				details: {
					recoveryId: record.id,
					target: record.target,
					path: targetPath,
					restored: missingEntries.length,
				},
			};
		},
	});

	// --- memory_status tool ---
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description:
			"Report the health of the memory system: where files live, what's stored, " +
			"whether qmd search is available, whether the pi-memory collection exists, " +
			"whether embeddings are ready, and the active configuration. " +
			"Use this when search behaves unexpectedly or to confirm setup.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			ensureDirs();
			const inv = getMemoryInventory();

			const qmdOk = qmdAvailable || (await detectQmd());
			let collectionOk = false;
			let embeddings: "ready" | "missing" | "unknown" | "n/a" = "n/a";
			if (qmdOk) {
				collectionOk = await checkCollection(qmdCollectionName());
				embeddings = collectionOk ? await probeEmbeddings() : "n/a";
			}

			const mark = (ok: boolean) => (ok ? "✓" : "✗");
			const lines: string[] = [
				"# Memory status",
				"",
				`- Memory dir: ${inv.dir}`,
				`- MEMORY.md: ${inv.longTermChars} chars`,
				`- Scratchpad: ${inv.scratchpadOpen} open / ${inv.scratchpadTotal} total`,
				`- Daily logs: ${inv.dailyCount}${inv.latestDaily ? ` (latest ${inv.latestDaily})` : ""}`,
				"",
				"## Search (qmd)",
				`- qmd available: ${mark(qmdOk)}`,
			];

			if (qmdOk) {
				lines.push(`- Collection \`pi-memory\`: ${mark(collectionOk)}`);
				if (collectionOk) {
					const embMark = embeddings === "ready" ? "✓" : embeddings === "missing" ? "⚠" : "?";
					lines.push(`- Embeddings (semantic/deep): ${embMark} ${embeddings}`);
					if (embeddings === "missing") {
						if (ensureQmdEmbed()) {
							lines.push("  - Embedding started in the background — re-run memory_status to confirm.");
						} else {
							lines.push("  - Run `qmd embed` once to enable semantic/deep search.");
						}
					} else if (embeddings === "unknown") {
						lines.push(
							`  - Could not verify within the ${getEmbedProbeTimeoutMs() / 1000}s probe timeout; run a semantic search to confirm.`,
							"  - A background re-index can slow the probe. Raise PI_MEMORY_EMBED_PROBE_TIMEOUT_MS if it persists.",
						);
					}
				} else {
					lines.push("  - Run a `memory_search` (auto-creates it) or `qmd collection add` manually.");
				}
			} else {
				lines.push("", qmdInstallInstructions());
			}

			lines.push(
				"",
				"## Configuration",
				`- PI_MEMORY_SNAPSHOT: ${getSnapshotMode()}`,
				`- PI_MEMORY_QMD_UPDATE: ${getQmdUpdateMode()}`,
				`- PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: ${getQmdSearchTimeoutMs()}`,
				`- PI_MEMORY_EMBED_PROBE_TIMEOUT_MS: ${getEmbedProbeTimeoutMs()}`,
				`- PI_MEMORY_DIR: ${process.env.PI_MEMORY_DIR ? "set" : "default"}`,
				`- PI_MEMORY_EXIT_SUMMARY: ${isExitSummaryEnabled() ? "enabled" : "disabled"}`,
				`- PI_MEMORY_EXIT_SUMMARY_MODEL: ${process.env.PI_MEMORY_EXIT_SUMMARY_MODEL?.trim() || "session model"}`,
				`- PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT: ${getExitSummaryReasoningEffort() ?? "off"}`,
				`- PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS: ${getExitSummaryTimeoutMs()}`,
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					...inv,
					qmd: qmdOk,
					collection: collectionOk,
					embeddings,
					snapshotMode: getSnapshotMode(),
					qmdUpdateMode: getQmdUpdateMode(),
				},
			};
		},
	});
}
