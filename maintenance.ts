/**
 * Maintenance: audit ledger, supersedes, the /seed pipeline, lifecycle hooks.
 *
 * Split out of the single-file extension; import order below is the only
 * dependency order: memory-core <- search <- maintenance <- commands.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	_onBaseDirChange,
	AUDIT_DIR,
	appendStamped,
	buildMemoryContext,
	buildPreview,
	DAILY_DATE_REGEX,
	DAILY_DIR,
	dailyPath,
	EXIT_SUMMARY_MAX_CHARS,
	EXIT_SUMMARY_MIN_MESSAGES,
	EXIT_SUMMARY_SYSTEM_PROMPT,
	ensureDirs,
	fileMtime,
	looksLikeSecret,
	MEMORY_DIR,
	MEMORY_FILE,
	nowTimestamp,
	PROJECT_MEMORY_MAX_CHARS,
	PROJECT_MEMORY_SEPARATOR_CHARS,
	parseScratchpad,
	readFileSafe,
	readJsonSidecar,
	SCRATCHPAD_FILE,
	shortSessionId,
	splitAuditBlocks,
	todayStr,
	truncateText,
	withMemoryLock,
	writeJsonSidecar,
} from "./memory-core.js";
import {
	cancelQmdUpdate,
	checkCollection,
	detectQmdForSession,
	ensureQmdAvailableForUpdate,
	ensureQmdEmbed,
	qmdCollectionName,
	qmdInstallInstructions,
	runQmdUpdateNow,
	scheduleQmdUpdate,
	searchRelevantMemories,
	setupQmdCollection,
} from "./search.js";

type ExitSummaryReason = "ctrl+d" | "slash-quit" | "session-end";

interface ExitSummaryResult {
	summary: string | null;
	error?: string;
	hasMessages: boolean;
}

function formatExitSummaryReason(reason: ExitSummaryReason): string {
	if (reason === "ctrl+d") return "ctrl+d";
	if (reason === "slash-quit") return "/quit";
	return "session-end";
}

function truncateConversationForSummary(conversationText: string): {
	text: string;
	truncated: boolean;
	totalChars: number;
} {
	const trimmed = conversationText.trim();
	if (!trimmed) {
		return { text: "", truncated: false, totalChars: 0 };
	}
	const truncated = truncateText(trimmed, EXIT_SUMMARY_MAX_CHARS, "end");
	return {
		text: truncated.text,
		truncated: truncated.truncated,
		totalChars: trimmed.length,
	};
}

function buildExitSummaryPrompt(conversationText: string, truncated: boolean, totalChars: number): string {
	const lines = [
		"Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
		"Return markdown only with these exact headings:",
		"### Decisions",
		"### Lessons Learned",
		"### Notes",
		"### Follow-ups",
		'Use bullet points under each heading. If there is nothing, write "None.".',
	];

	if (truncated) {
		lines.push(
			`Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`,
		);
	}

	lines.push("", "<conversation>", conversationText, "</conversation>");
	return lines.join("\n");
}

function formatExitSummaryEntry(
	summary: string,
	reason: ExitSummaryReason,
	sessionId: string,
	timestamp: string,
): string {
	const header = `## Session Summary (auto, exit: ${formatExitSummaryReason(reason)})`;
	return [`<!-- ${timestamp} [${sessionId}] -->`, header, "", summary.trim()].join("\n");
}

function getSessionBranch(ctx: ExtensionContext): SessionEntry[] | null {
	const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getBranch?: () => SessionEntry[];
	};
	if (typeof sessionManager?.getBranch !== "function") {
		return null;
	}
	return sessionManager.getBranch();
}

async function resolveExitSummaryApiKey(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
): Promise<string | undefined> {
	const modelRegistry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		getApiKey?: (model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>;
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};

	if (typeof modelRegistry?.getApiKey === "function") {
		return modelRegistry.getApiKey(model);
	}

	if (typeof modelRegistry?.getApiKeyForProvider === "function") {
		return modelRegistry.getApiKeyForProvider(model.provider);
	}

	return undefined;
}

/**
 * Model used for exit summaries. Defaults to the session's active model;
 * PI_MEMORY_EXIT_SUMMARY_MODEL="provider/model-id" overrides it (e.g. to a
 * cheaper/faster model). Unresolvable specs fall back to the session model.
 */
function resolveExitSummaryModel(ctx: ExtensionContext): ExtensionContext["model"] {
	const spec = (process.env.PI_MEMORY_EXIT_SUMMARY_MODEL ?? "").trim();
	if (!spec) return ctx.model;

	const slash = spec.indexOf("/");
	const modelRegistry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		find?: (provider: string, modelId: string) => ExtensionContext["model"];
	};
	const found = slash > 0 ? modelRegistry?.find?.(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
	if (found) return found;

	if (ctx.hasUI) {
		try {
			ctx.ui.notify(
				`pi-memory: PI_MEMORY_EXIT_SUMMARY_MODEL "${spec}" not resolved; using session model`,
				"warning",
			);
		} catch {
			/* UI may already be tearing down during shutdown */
		}
	}
	return ctx.model;
}

async function generateExitSummary(ctx: ExtensionContext): Promise<ExitSummaryResult> {
	const branch = getSessionBranch(ctx);
	if (!branch) {
		return { summary: null, error: "Session branch unavailable", hasMessages: false };
	}

	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	// Curated-write gate: auto-summarizing trivial sessions (a lone `ls`, a
	// one-liner Q&A) appends noise the daily-log injection and search then
	// faithfully resurface forever. Only sessions with enough exchange to
	// plausibly contain decisions/lessons earn an automatic summary.
	if (messages.length < EXIT_SUMMARY_MIN_MESSAGES) {
		return { summary: null, hasMessages: false };
	}

	const model = resolveExitSummaryModel(ctx);
	if (!model) {
		return { summary: null, error: "No active model", hasMessages: true };
	}

	const apiKey = await resolveExitSummaryApiKey(ctx, model);
	if (!apiKey) {
		return {
			summary: null,
			error: `API key resolution unavailable for ${model.provider}/${model.id}`,
			hasMessages: true,
		};
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const { text: truncatedText, truncated, totalChars } = truncateConversationForSummary(conversationText);
	if (!truncatedText.trim()) {
		return { summary: null, error: "No conversation text to summarize", hasMessages: true };
	}

	const summaryMessages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: buildExitSummaryPrompt(truncatedText, truncated, totalChars) }],
			timestamp: Date.now(),
		},
	];

	try {
		const response = await complete(
			model,
			{ systemPrompt: EXIT_SUMMARY_SYSTEM_PROMPT, messages: summaryMessages },
			{ apiKey, reasoningEffort: getExitSummaryReasoningEffort() },
		);

		const summaryText = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!summaryText) {
			return { summary: null, error: "Summary was empty", hasMessages: true };
		}

		return { summary: summaryText, hasMessages: true };
	} catch (err) {
		return { summary: null, error: err instanceof Error ? err.message : String(err), hasMessages: true };
	}
}

export function shouldSummarizeLifecycleTransitions(): boolean {
	const value = (process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS ?? "").toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Exit summaries on real quit (Ctrl+D, /quit, session end) can be disabled
 * with PI_MEMORY_EXIT_SUMMARY=0 (aliases: off/false/no). Default: enabled.
 */
export function isExitSummaryEnabled(): boolean {
	const value = (process.env.PI_MEMORY_EXIT_SUMMARY ?? "").trim().toLowerCase();
	return !(value === "0" || value === "off" || value === "false" || value === "no");
}

/**
 * True when a generated exit summary carries no actual content — every section
 * is empty or "None.". The summary prompt instructs the model to write "None."
 * under each heading when nothing is worth recording; persisting those blocks
 * would pollute the daily log (re-injected every session start) and the qmd
 * index with boilerplate.
 */
export function isExitSummaryEmpty(summary: string): boolean {
	const contentLines = summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	if (contentLines.length === 0) return true;
	return contentLines.every((line) => /^none\.?$/i.test(line.replace(/^[-*+]\s*/, "")));
}

const DEFAULT_EXIT_SUMMARY_TIMEOUT_MS = 10_000;

/**
 * Self-imposed timeout for the exit-summary work on session_shutdown. Pi core
 * awaits shutdown handlers with no timeout, and generateExitSummary() is only
 * bounded by the provider's own timeout — a hanging provider would otherwise
 * block quitting indefinitely. Override with PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS.
 */
export function getExitSummaryTimeoutMs(): number {
	const configured = Number(process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_EXIT_SUMMARY_TIMEOUT_MS;
}

const DEFAULT_EXIT_SUMMARY_REASONING_EFFORT = "low";

/**
 * Reasoning effort passed to the exit-summary LLM call. Defaults to "low".
 *
 * Some providers reject certain efforts — e.g. Baseten's GLM-5.2 only accepts
 * "high"/"max"/"none" and returns HTTP 400 for "low", silently breaking exit
 * summaries (the error is caught, summary is null, nothing is persisted).
 * Override with PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT to a value the
 * configured PI_MEMORY_EXIT_SUMMARY_MODEL accepts. Set to "off" to omit the
 * parameter entirely and let the provider apply its own default.
 */
export function getExitSummaryReasoningEffort(): string | undefined {
	const value = (process.env.PI_MEMORY_EXIT_SUMMARY_REASONING_EFFORT ?? "").trim().toLowerCase();
	if (value === "off") return undefined;
	if (value === "") return DEFAULT_EXIT_SUMMARY_REASONING_EFFORT;
	return value;
}

export function shouldSkipExitSummaryForReason(reason: string | undefined): boolean {
	if (!reason) return false;
	if (shouldSummarizeLifecycleTransitions()) return false;
	return ["reload", "new", "resume", "fork"].includes(reason);
}

// ---------------------------------------------------------------------------
// Audit layer (fork addition)
//
// Upstream answers "what does the agent remember" but never "which memories
// actually reached the model", "which of them still point at anything", or
// "what does all of that cost per turn". This layer answers those three
// without changing the on-disk format: entries are keyed by a hash of their own
// text, so the ledger survives edits and forget/restore, and the markdown stays
// readable by qmd, memory_read, and a human with `cat`.
//
// It hooks the FINAL injected text rather than the source files. That is
// deliberate: by that point truncation has already happened, so what remains is
// exactly what the model saw. A memory cut out of the context by the char
// budget is never counted as injected.
//
// Cost: one pass over the injected text per snapshot, plus one fs.accessSync
// per distinct path (cached per process). No model calls.
// ---------------------------------------------------------------------------

const AUDIT_LEDGER_VERSION = 1;
const AUDIT_WRITE_DEBOUNCE_MS = 2_000;
const AUDIT_STALE_FOLD_HEAD = 160;
/** Rough chars-per-token for English + code. Good enough for a cost ballpark. */
export const AUDIT_CHARS_PER_TOKEN = 4;
/** How many audit reports are kept on disk. */
export const AUDIT_MAX_REPORT_FILES = 20;

type StaleMode = "annotate" | "fold" | "off";

interface LedgerEntry {
	/** content hash of the entry, whitespace-normalised */
	k: string;
	/** MEMORY.md | SCRATCHPAD.md | daily/YYYY-MM-DD.md | search */
	src: string;
	/** ISO timestamp of first sight */
	first: string;
	/** times this entry was actually present in an injected context */
	n: number;
	/** ISO timestamp of the most recent injection */
	last?: string;
	/** characters this entry contributed across all injections */
	chars?: number;
}

export interface Ledger {
	version: number;
	/** context injections recorded */
	injections: number;
	/** characters injected, all sections, all snapshots */
	injectedChars: number;
	entries: Record<string, LedgerEntry>;
	/**
	 * Sources whose section was cut before it reached the model. The entries
	 * that sit behind the cut are not "never injected", they were cut off.
	 */
	truncatedSources?: string[];
}

let ledgerCache: Ledger | null = null;
let ledgerCacheMtime = -1;
let ledgerDirty = false;
let ledgerTimer: ReturnType<typeof setTimeout> | null = null;
let pathExistsCache = new Map<string, boolean>();

/** Project directory used to resolve relative paths found in memory. */
let projectCwd = process.cwd();

/**
 * Whether pi's project trust covers the current project.
 *
 * Pi's own trust prompt only fires for the resources pi itself loads
 * (.pi/settings.json, .pi/extensions, .pi/skills, .pi/prompts, .pi/themes,
 * SYSTEM.md, APPEND_SYSTEM.md). A repository carrying only
 * .pi/memory/MEMORY.md triggers no prompt, so isProjectTrusted() then returns
 * true by default. Project memory is prompt-shaped text that lands in front of
 * the model, so the conservative reading is required: inject it only when the
 * user has actually answered pi's trust question for this project.
 */
export let projectTrusted = false;

export function projectMemoryFile(cwd: string): string {
	return path.join(cwd, ".pi", "memory", "MEMORY.md");
}

function projectMemoryLabel(cwd: string): string {
	const name = path.basename(cwd) || cwd;
	return `## Project memory (${name})`;
}

/** Section injected ahead of the global tier, or "" when unusable. */
function projectMemorySection(cwd: string): string {
	if (!projectTrusted) return "";
	const file = projectMemoryFile(cwd);
	const content = readFileSafe(file);
	if (!content?.trim()) return "";
	const preview = buildPreview(content, {
		maxLines: 120,
		maxChars: PROJECT_MEMORY_MAX_CHARS,
		mode: "start",
	});
	if (!preview.preview) return "";
	const note = preview.truncated ? `\n\n[truncated: showing ${preview.previewChars}/${preview.totalChars} chars]` : "";
	return `${projectMemoryLabel(cwd)}\n\n${preview.preview}${note}`;
}

/** Reset all in-memory audit state (for testing and after _setBaseDir). */
export function _resetAuditState() {
	ledgerCache = null;
	ledgerCacheMtime = -1;
	ledgerDirty = false;
	if (ledgerTimer) {
		clearTimeout(ledgerTimer);
		ledgerTimer = null;
	}
	pathExistsCache = new Map();
	supersedesCache = null;
}

export function _setAuditCwd(cwd: string) {
	projectCwd = cwd;
	pathExistsCache = new Map();
}

/** Record whether pi considers the current project trusted. */
export function _setProjectTrust(trusted: boolean) {
	projectTrusted = trusted;
}

export function _isProjectTrusted(): boolean {
	return projectTrusted;
}

function ledgerEnabled(): boolean {
	const v = (process.env.PI_MEMORY_LEDGER ?? "on").toLowerCase();
	return v !== "off" && v !== "0" && v !== "false";
}

export function staleMode(): StaleMode {
	const v = (process.env.PI_MEMORY_STALE_CHECK ?? "annotate").toLowerCase();
	if (v === "off" || v === "0" || v === "false") return "off";
	if (v === "fold") return "fold";
	return "annotate";
}

function auditEnabled(): boolean {
	return ledgerEnabled() || staleMode() !== "off";
}

// --- path extraction -------------------------------------------------------

const PATH_TOKEN_SPLIT = /[\s`"'()[\]<>|,;]+/;
const CODE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const PATH_PREFIX = /^(\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|[\\/]|[A-Za-z0-9_.-]+[\\/])/;

/**
 * Pull file- and directory-looking tokens out of free text.
 *
 * Deliberately conservative: it requires a path separator plus either a file
 * extension or a trailing separator, and rejects URLs, globs and template
 * placeholders. A wrong "missing" flag hides real memory, so when in doubt we
 * extract nothing rather than guess.
 */
export function extractCandidatePaths(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of text.split(PATH_TOKEN_SPLIT)) {
		if (!raw) continue;
		const token = raw.replace(/^[#*+>]+/, "").replace(/[.,;:]+$/, "");
		if (token.length < 3) continue;
		if (token.includes("://") || token.includes("*") || token.includes("?") || token.includes("${")) continue;
		if (!token.includes("/") && !token.includes("\\")) continue;
		if (!CODE_EXTENSION.test(token) && !/[\\/]$/.test(token)) continue;
		if (!PATH_PREFIX.test(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
}

function resolveCandidate(token: string, cwd: string): string {
	if (/^~[\\/]/.test(token)) return path.join(homedir(), token.slice(2));
	if (path.isAbsolute(token)) return path.resolve(token);
	return path.resolve(cwd, token);
}

/**
 * Memory files live in the memory dir, not in the project. A note that points
 * at `topics/foo.md` or `daily/2026-01-01.md` refers to the memory dir, so
 * those paths are resolved against it too. Without this, every index line in
 * MEMORY.md is reported as pointing at a file that does not exist.
 */
function statExists(target: string): boolean {
	const cached = pathExistsCache.get(target);
	if (cached !== undefined) return cached;
	let exists = false;
	try {
		fs.accessSync(target, fs.constants.F_OK);
		exists = true;
	} catch {
		exists = false;
	}
	pathExistsCache.set(target, exists);
	return exists;
}

function candidateMissing(token: string, cwd: string): boolean {
	const resolved = resolveCandidate(token, cwd);
	if (statExists(resolved)) return false;
	if (!path.isAbsolute(token) && !/^~[\\/]/.test(token)) {
		if (statExists(path.resolve(MEMORY_DIR, token))) return false;
	}
	return true;
}

/**
 * Paths that are gone. Only reports a path when EVERY path-like token in the
 * text is missing — a memory that also mentions a file which still exists is
 * more likely partially stale than wholly obsolete.
 */
export function missingPathsIn(text: string, cwd: string): string[] {
	const candidates = extractCandidatePaths(text);
	if (candidates.length === 0) return [];
	const missing = candidates.filter((t) => candidateMissing(t, cwd));
	return missing.length === candidates.length ? missing : [];
}

// --- ledger ----------------------------------------------------------------

function ledgerFile(): string {
	return path.join(AUDIT_DIR, "ledger.json");
}

function emptyLedger(): Ledger {
	return { version: AUDIT_LEDGER_VERSION, injections: 0, injectedChars: 0, entries: {}, truncatedSources: [] };
}

export function readLedger(): Ledger {
	// Another session may have written the ledger. The file's timestamp says
	// whether the cached copy is still current.
	const mtime = fileMtime(ledgerFile());
	if (ledgerCache && ledgerCacheMtime === mtime) return ledgerCache;
	ledgerCacheMtime = mtime;
	const raw = readFileSafe(ledgerFile());
	if (!raw) {
		ledgerCache = emptyLedger();
		return ledgerCache;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<Ledger>;
		const entries = parsed?.entries;
		if (
			parsed?.version !== AUDIT_LEDGER_VERSION ||
			!entries ||
			typeof entries !== "object" ||
			Array.isArray(entries)
		) {
			ledgerCache = emptyLedger();
			return ledgerCache;
		}
		ledgerCache = {
			version: AUDIT_LEDGER_VERSION,
			injections: typeof parsed.injections === "number" ? parsed.injections : 0,
			injectedChars: typeof parsed.injectedChars === "number" ? parsed.injectedChars : 0,
			entries: entries as Record<string, LedgerEntry>,
		};
	} catch {
		ledgerCache = emptyLedger();
	}
	return ledgerCache;
}

function writeLedgerNow(): void {
	if (!ledgerDirty || !ledgerCache) return;
	ledgerDirty = false;
	try {
		fs.mkdirSync(AUDIT_DIR, { recursive: true });
		const target = ledgerFile();
		const tmp = `${target}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(ledgerCache, null, 2)}\n`, "utf-8");
		fs.renameSync(tmp, target);
	} catch {
		// Diagnostics only. A failed ledger write must never break a session.
	}
}

function scheduleLedgerWrite(): void {
	if (!ledgerEnabled()) return;
	ledgerDirty = true;
	if (ledgerTimer) return;
	ledgerTimer = setTimeout(() => {
		ledgerTimer = null;
		writeLedgerNow();
	}, AUDIT_WRITE_DEBOUNCE_MS);
	ledgerTimer.unref?.();
}

/** Flush pending ledger writes. Called from session_shutdown. */
export function flushAuditLedger(): void {
	if (ledgerTimer) {
		clearTimeout(ledgerTimer);
		ledgerTimer = null;
	}
	writeLedgerNow();
}

/**
 * Drop all recorded injections.
 *
 * Only the ledger and the generated reports are removed. The other files in
 * `.audit` hold live state: the supersede chain and the pending seed result.
 */
export function resetAuditLedger(): void {
	_resetAuditState();
	try {
		fs.rmSync(ledgerFile(), { force: true });
	} catch {
		// Nothing to remove.
	}
	try {
		for (const name of fs.readdirSync(AUDIT_DIR)) {
			if (!/^report-.*\.md$/.test(name)) continue;
			fs.rmSync(path.join(AUDIT_DIR, name), { force: true });
		}
	} catch {
		// The directory may not exist.
	}
}

/** Keep the newest `keep` files that match `prefix`, delete the rest. */
export function pruneOldFiles(dir: string, prefix: string, keep: number): number {
	try {
		const names = fs
			.readdirSync(dir)
			.filter((name) => name.startsWith(prefix))
			.map((name) => {
				let mtime = 0;
				try {
					mtime = fs.statSync(path.join(dir, name)).mtimeMs;
				} catch {
					// Keep the file if it cannot be dated; it is not worth guessing.
				}
				return { name, mtime };
			})
			.sort((a, b) => b.mtime - a.mtime);
		let removed = 0;
		for (const old of names.slice(keep)) {
			try {
				fs.rmSync(path.join(dir, old.name), { force: true });
				removed++;
			} catch {
				// Nothing to remove.
			}
		}
		return removed;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Supersedes (fork addition)
//
// Two memories that contradict each other both stay in context, and the model
// re-litigates them every turn. Upstream has no way to retire one.
//
// State lives in .audit/supersedes.json rather than in the markdown, so the
// memory format is untouched, the chain is reversible, and the audit ledger
// keys stay stable. A superseded entry is dropped from the injected context but
// stays on disk, searchable by qmd and recoverable from history.
// ---------------------------------------------------------------------------

interface SupersedeRecord {
	by: string;
	at: string;
	reason?: string;
}

type SupersedeMap = Record<string, SupersedeRecord>;

let supersedesCache: SupersedeMap | null = null;
let supersedesCacheMtime = -1;

function supersedesFile(): string {
	return path.join(AUDIT_DIR, "supersedes.json");
}

/** Keep only the entries that carry the two required fields. */
function asSupersedeMap(value: unknown): SupersedeMap | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const out: SupersedeMap = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		const record = entry as Partial<SupersedeRecord> | null;
		if (!record || typeof record.by !== "string" || typeof record.at !== "string") continue;
		out[key] = {
			by: record.by,
			at: record.at,
			reason: typeof record.reason === "string" ? record.reason : undefined,
		};
	}
	return out;
}

function readSupersedes(): SupersedeMap {
	const file = supersedesFile();
	// Another session may have changed the chain. The timestamp says whether
	// the cached copy is still current.
	const mtime = fileMtime(file);
	if (supersedesCache && supersedesCacheMtime === mtime) return supersedesCache;
	supersedesCacheMtime = mtime;
	supersedesCache = readJsonSidecar(file, asSupersedeMap) ?? {};
	return supersedesCache;
}

export function writeSupersedes(map: SupersedeMap): void {
	supersedesCache = map;
	try {
		writeJsonSidecar(supersedesFile(), map);
		supersedesCacheMtime = fileMtime(supersedesFile());
	} catch {
		// Diagnostics only; a lost supersede map is recoverable by hand.
	}
}

/** Live supersede chain, read on demand so /reload picks up external edits. */
export function activeSupersedes(): SupersedeMap {
	return readSupersedes();
}

/**
 * Drop blocks that have been superseded. Runs on every injected context, so it
 * must stay cheap: the map is read once per process unless /supersede writes.
 */
export function filterSuperseded(context: string): { context: string; dropped: number } {
	const map = activeSupersedes();
	const keys = Object.keys(map);
	if (!context || keys.length === 0) return { context, dropped: 0 };
	const lookup = new Set(keys);

	const body = context.startsWith("# Memory\n\n") ? context.slice("# Memory\n\n".length) : context;
	let dropped = 0;
	const chunks = body.split("\n\n---\n\n").map((chunk) => {
		const newline = chunk.indexOf("\n\n");
		if (newline === -1) return chunk;
		const label = chunk.slice(0, newline);
		const content = chunk.slice(newline + 2);
		const kept = splitAuditBlocks(content, sourceFromLabel(label)).filter((block) => {
			if (!lookup.has(block.key)) return true;
			dropped += 1;
			return false;
		});
		return `${label}\n\n${kept.map((b) => b.full).join("\n\n")}`;
	});

	return { context: `# Memory\n\n${chunks.join("\n\n---\n\n")}`, dropped };
}

/** Combine supersede filtering, the audit layer and project-tier injection. */
export function postProcessContext(context: string, cwd: string, projectSection?: string): string {
	// Project memory is assembled first so it goes through the same supersede
	// filter and audit pass as everything else. Building it afterwards left it
	// injected but never measured, never staleness-checked and never retireable.
	let assembled = context;
	const section = projectSection !== undefined ? projectSection : projectMemorySection(cwd);
	if (section) {
		const header = context.startsWith("# Memory\n\n") ? "# Memory\n\n" : "";
		const body = context.slice(header.length);
		assembled = body ? `${header}${section}\n\n---\n\n${body}` : `${header}${section}`;
	}
	const filtered = filterSuperseded(assembled).context;
	return auditEnabled() ? auditContext(filtered, cwd) : filtered;
}

export function _resetSupersedes() {
	supersedesCache = null;
}

/**
 * Candidate contradictions, for the report only. Two entries conflict when they
 * share a #tag, talk about largely the same words, and yet one is not simply
 * restating the other. No automatic judgement is made: deciding which of two
 * remembered facts is true needs a human or a model, not token overlap.
 */
export interface AuditRow {
	key: string;
	src: string;
	body: string;
	stamp: string | null;
	injections: number;
	first?: string;
	last?: string;
	missing: string[];
	/** True when the entry is part of what the injection reads. */
	eligible: boolean;
}

export function findConflictCandidates(rows: AuditRow[]): [AuditRow, AuditRow][] {
	const tagOf = (body: string) => body.match(/(?:^|\s)#([a-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? "";
	const wordsOf = (body: string) => {
		const set = new Set<string>();
		for (const w of body.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) set.add(w);
		return set;
	};
	const pairs: [AuditRow, AuditRow][] = [];
	const tagged = rows.filter((r) => tagOf(r.body) !== "");

	for (let i = 0; i < tagged.length; i++) {
		for (let j = i + 1; j < tagged.length; j++) {
			const a = tagged[i];
			const b = tagged[j];
			if (tagOf(a.body) !== tagOf(b.body)) continue;
			const aBody = a.body.toLowerCase();
			const bBody = b.body.toLowerCase();
			if (aBody.includes(bBody) || bBody.includes(aBody)) continue;
			const wa = wordsOf(a.body);
			const wb = wordsOf(b.body);
			if (wa.size < 3 || wb.size < 3) continue;
			let shared = 0;
			for (const w of wa) if (wb.has(w)) shared += 1;
			const jaccard = shared / (wa.size + wb.size - shared);
			if (jaccard >= 0.45) pairs.push([a, b]);
		}
	}
	return pairs;
}

// ---------------------------------------------------------------------------
// Background jobs (fork addition)
//
// A command that reports a pending sidecar, applies it, or starts a run that
// outlives the command. /seed is the one user of this layer.
// ---------------------------------------------------------------------------

/** What the shared lifecycle needs from one job. */
interface SidecarJob<TResult> {
	read: () => TResult | null;
	write: (result: TResult) => void;
	/** Body of `status` when the sidecar holds a result. */
	describe: (result: TResult) => string;
	emptyMessage: string;
	runningMessage: string;
	noResultMessage: string;
	/** Set while the detached run is going; `status` reports on it. */
	inFlight: boolean;
}

/** `<cmd> status` / `<cmd> apply`. Returns false for every other subcommand. */
export function handleJobSubcommand<TResult>(
	job: SidecarJob<TResult>,
	ctx: ExtensionCommandContext,
	sub: string,
	apply: (result: TResult) => void,
): boolean {
	if (sub !== "status" && sub !== "apply") return false;
	const result = job.read();
	if (!result) {
		if (sub === "apply") ctx.ui.notify(job.noResultMessage, "warning");
		else ctx.ui.notify(job.inFlight ? job.runningMessage : job.emptyMessage, "info");
		return true;
	}
	if (sub === "apply") apply(result);
	else ctx.ui.notify(job.describe(result), "info");
	return true;
}

/**
 * Start the slow half of a job without awaiting it: pi caps a command at 60s.
 * The flag clears when the body ends, which is what `status` reports on. Each
 * job keeps its own error handling.
 */
export function startDetachedJob<TResult>(job: SidecarJob<TResult>, body: () => Promise<void>): void {
	job.inFlight = true;
	void (async () => {
		try {
			await body();
		} finally {
			job.inFlight = false;
		}
	})();
}

/** Refresh the qmd index in the background. A failure is not the turn's problem. */
export function scheduleQmdRefresh(): void {
	void ensureQmdAvailableForUpdate()
		.then(() => scheduleQmdUpdate())
		.catch(() => {});
}

/** Drop a sidecar, so a fresh run is never confused with an old one. */
export function clearSidecar(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Nothing to remove.
	}
}

/** `--days`, `14d` or a bare `14` on a command line, clamped to a sane range. */
export function parseDaysArg(trimmed: string, fallback: number): number {
	const daysMatch = trimmed.match(/(?:^|\s)(\d{1,4})d?(?:\s|$)/);
	return daysMatch ? Math.min(365, Math.max(1, Number(daysMatch[1]))) : fallback;
}

/** The JSON array in a model reply, ignoring code fences and surrounding prose. */
function parseJsonArray<T>(raw: string, map: (item: unknown) => T | null): T[] {
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1].trim();
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		if (!Array.isArray(parsed)) return [];
		const out: T[] = [];
		for (const item of parsed) {
			const value = map(item);
			if (value) out.push(value);
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * One model call: a system prompt and a single user message. The prompt and
 * the answer parser stay with the job that owns them.
 */
async function callModelOnce(
	ctx: ExtensionCommandContext,
	systemPrompt: string,
	prompt: string,
): Promise<{ text: string; error?: string }> {
	const model = ctx.model;
	if (!model) return { text: "", error: "No active model" };
	const apiKey = await resolveExitSummaryApiKey(ctx, model);
	if (!apiKey) return { text: "", error: `API key resolution failed for ${model.provider}/${model.id}` };
	try {
		const response = await complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{ apiKey },
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return { text };
	} catch (err) {
		return { text: "", error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// Seeding from past sessions (fork addition)
// ---------------------------------------------------------------------------

export const SEED_DEFAULT_DAYS = 30;
/** A session log is read up to this size. Bigger files are read in part. */
const SESSION_FILE_MAX_BYTES = 8 * 1024 * 1024;
const SEED_MIN_CHARS = 4;
const SEED_MAX_CHARS = 600;
const SEED_MAX_MESSAGES = 200;
export const SEED_BATCH_SIZE = 40;

const SEED_SYSTEM_PROMPT = [
	"You extract durable memory candidates from a user's past prompts to a coding agent.",
	"Reply with ONLY a JSON array, no prose, no code fences.",
	'Each element: {"text": "<one durable fact, <= 120 chars>", "category": "preference|decision|convention|failure|insight"}.',
	"Keep only what stays true after the session ends: tool and workflow preferences, project conventions,",
	"constraints the user insists on, and corrections they made to the agent.",
	'Phrase each item as a rule in the user\'s own terms ("Always run bun test, not npm test").',
	"Exclude: one-off task requests, transient state, anything obvious from the repo, greetings,",
	"and anything that looks like a key, token or credential.",
	"If nothing durable is present, return [].",
].join("\n");

interface SeedMessage {
	text: string;
	project: string;
	at: string;
}

interface SeedCandidate {
	text: string;
	category: string;
}

export function sessionsRoot(): string {
	// MEMORY_DIR is <agent dir>/memory, so the sessions tree is its sibling.
	return path.join(path.dirname(MEMORY_DIR), "sessions");
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				!!b && typeof b === "object" && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join(" ")
		.trim();
}

const SLASH_COMMAND_ONLY = /^\/[a-z][\w-]*$/i;

interface SessionFile {
	project: string;
	file: string;
	day: string;
	raw: string;
}

/** Every session file inside the cutoff, handed over with its raw text. */
function walkSessionFiles(days: number, visit: (session: SessionFile) => void, projectFilter?: string): void {
	const root = sessionsRoot();
	const cutoff = Date.now() - days * 86_400_000;

	let projects: string[] = [];
	try {
		projects = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return;
	}

	for (const project of projects) {
		if (projectFilter && !project.toLowerCase().includes(projectFilter.toLowerCase())) continue;
		let files: string[] = [];
		try {
			files = fs.readdirSync(path.join(root, project)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			const day = file.slice(0, 10);
			if (!DAILY_DATE_REGEX.test(day)) continue;
			const at = Date.parse(`${day}T12:00:00Z`);
			if (Number.isFinite(at) && at < cutoff) continue;
			const raw = readFileSafe(path.join(root, project, file), SESSION_FILE_MAX_BYTES);
			if (!raw) continue;
			visit({ project, file, day, raw });
		}
	}
}

/** Durable-looking user prompts from past sessions, newest first, deduplicated. */
export function collectSeedMessages(days: number, projectFilter?: string): SeedMessage[] {
	const seen = new Set<string>();
	const out: SeedMessage[] = [];

	walkSessionFiles(
		days,
		({ project, day, raw }) => {
			for (const line of raw.split("\n")) {
				if (!line.includes('"role":"user"')) continue;
				let entry: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (entry?.type !== "message" || entry.message?.role !== "user") continue;
				const text = extractUserText(entry.message.content);
				if (text.length < SEED_MIN_CHARS || text.length > SEED_MAX_CHARS) continue;
				// Slash commands and code dumps are not memory candidates.
				if (text.startsWith("/")) continue;
				if (SLASH_COMMAND_ONLY.test(text)) continue;
				// A prompt that carries a credential never reaches the model.
				if (looksLikeSecret(text)) continue;
				const fingerprint = text.replace(/\s+/g, " ").toLowerCase();
				if (seen.has(fingerprint)) continue;
				seen.add(fingerprint);
				out.push({ text, project, at: entry.timestamp ?? day });
			}
		},
		projectFilter,
	);

	out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	return out.slice(0, SEED_MAX_MESSAGES);
}

function parseCandidateArray(raw: string): SeedCandidate[] {
	return parseJsonArray<SeedCandidate>(raw, (item) => {
		if (!item || typeof item !== "object") return null;
		const record = item as { text?: unknown; category?: unknown };
		if (typeof record.text !== "string") return null;
		const value = record.text.replace(/\s+/g, " ").trim();
		if (value.length < 8 || value.length > 300) return null;
		if (value.includes("\n")) return null;
		if (looksLikeSecret(value)) return null;
		const category =
			typeof record.category === "string" &&
			/^(preference|decision|convention|failure|insight)$/i.test(record.category)
				? record.category.toLowerCase()
				: "insight";
		return { text: value, category };
	});
}

function buildSeedPrompt(messages: SeedMessage[]): string {
	const lines = messages.map((m, i) => `[${i + 1}] ${m.text.replace(/\s+/g, " ").slice(0, 400)}`);
	return `Past prompts from the user, oldest first. Extract durable memory candidates.\n\n${lines.join("\n")}`;
}

async function extractSeedBatch(
	ctx: ExtensionCommandContext,
	messages: SeedMessage[],
): Promise<{ candidates: SeedCandidate[]; error?: string }> {
	const { text, error } = await callModelOnce(ctx, SEED_SYSTEM_PROMPT, buildSeedPrompt(messages));
	if (error) return { candidates: [], error };
	return { candidates: parseCandidateArray(text) };
}

/** Skip anything already present in memory, so a re-run stays idempotent. */
function readDailyContents(): string[] {
	try {
		return fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.map((f) => readFileSafe(path.join(DAILY_DIR, f)) ?? "");
	} catch {
		return [];
	}
}

/**
 * Candidates already present anywhere the chosen tier reads from. Project tier
 * writes must not be deduplicated against global memory, or a fact already in
 * MEMORY.md could never be re-scoped into a repository.
 */
function filterAgainstExisting(candidates: SeedCandidate[], target: SeedTarget, cwd: string) {
	const parts = [readFileSafe(MEMORY_FILE) ?? ""];
	if (target === "global") {
		parts.push(...(readDailyContents() as string[]), readFileSafe(projectMemoryFile(cwd)) ?? "");
	} else {
		parts.push(readFileSafe(projectMemoryFile(cwd)) ?? "");
	}
	const existing = parts.join("\n").toLowerCase();

	const seen = new Set<string>();
	const fresh: SeedCandidate[] = [];
	let skipped = 0;
	for (const candidate of candidates) {
		const probe = candidate.text.replace(/\s+/g, " ").toLowerCase();
		if (existing.includes(probe) || seen.has(probe)) {
			skipped += 1;
			continue;
		}
		seen.add(probe);
		fresh.push(candidate);
	}
	return { fresh, skipped };
}

/**
 * /seed never blocks.
 *
 * Extraction is one model call per batch of prompts, which on a real history
 * runs for minutes. Pi caps a command (and an RPC prompt) at 60s, so anything
 * awaited inline dies with "Pi RPC request timed out". Collection is instant
 * and returns immediately; the model calls run detached and land their result
 * in .audit/seed-result.json, with a notification when they finish. /seed apply
 * is then instant.
 */
export interface SeedResult {
	createdAt: string;
	days: number;
	project?: string;
	/** The directory the run started in. A project target is written there. */
	cwd?: string;
	target: SeedTarget;
	autoApply: boolean;
	scanned: number;
	batches: number;
	failedBatches: string[];
	candidates: SeedCandidate[];
	skippedExisting: number;
}

export type SeedTarget = "global" | "project";

export function seedResultFile(): string {
	return path.join(AUDIT_DIR, "seed-result.json");
}

/** A finished run is only trusted when it carries its candidate list. */
function asSeedResult(value: unknown): SeedResult | null {
	if (!value || !Array.isArray((value as Partial<SeedResult>).candidates)) return null;
	return value as SeedResult;
}

function readSeedResult(): SeedResult | null {
	return readJsonSidecar(seedResultFile(), asSeedResult);
}

export function notifySafe(ui: ExtensionCommandContext["ui"], message: string, level: "info" | "warning"): void {
	try {
		ui.notify(message, level);
	} catch {
		// The session may have moved on. /seed status still reads the result file.
	}
}

/** Lifecycle, sidecar and messages of /seed. The pipeline itself is below. */
export const seedJob: SidecarJob<SeedResult> = {
	read: readSeedResult,
	write: (result) => writeJsonSidecar(seedResultFile(), result),
	describe: (result) => {
		const preview = result.candidates
			.slice(0, 40)
			.map((c) => `#${c.category} ${c.text}`)
			.join("\n");
		return `Seed ready: ${result.candidates.length} candidate(s) from ${result.scanned} prompts, ${result.skippedExisting} already known, target ${result.target} memory.\n${preview}\nRun /seed apply to write.`;
	},
	emptyMessage: "No pending seed result.",
	runningMessage: "Seed extraction is running in the background. Check /seed status again in a minute.",
	noResultMessage: "No pending seed result. Run /seed first.",
	inFlight: false,
};

export async function extractAllBatches(
	ctx: ExtensionCommandContext,
	messages: SeedMessage[],
	result: SeedResult,
): Promise<void> {
	const ui = ctx.ui;
	for (let i = 0; i < messages.length; i += SEED_BATCH_SIZE) {
		const batch = messages.slice(i, i + SEED_BATCH_SIZE);
		const done = Math.min(i + SEED_BATCH_SIZE, messages.length);
		try {
			const extracted = await extractSeedBatch(ctx, batch);
			if (extracted.error) {
				result.failedBatches.push(`batch ${i / SEED_BATCH_SIZE + 1}: ${extracted.error}`);
			} else {
				result.candidates.push(...extracted.candidates);
			}
		} catch (err) {
			result.failedBatches.push(
				`batch ${i / SEED_BATCH_SIZE + 1}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Persist after every batch. Extraction runs detached from the command,
		// so a session that quits mid-run must not lose what it already paid for.
		if (seedWasApplied()) {
			notifySafe(ui, "pi-memory /seed: the result was applied, stopping.", "info");
			return;
		}
		try {
			seedJob.write(result);
		} catch {
			// Non-fatal; the final write below still tries.
		}

		notifySafe(
			ui,
			`pi-memory /seed: ${done}/${messages.length} prompts processed, ${result.candidates.length} candidate(s) so far.`,
			"info",
		);
	}

	const { fresh, skipped } = filterAgainstExisting(result.candidates, result.target, projectCwd);
	result.candidates = fresh;
	result.skippedExisting = skipped;

	if (seedWasApplied()) {
		notifySafe(ui, "pi-memory /seed: the result was applied, stopping.", "info");
		return;
	}

	seedJob.write(result);

	if (result.candidates.length === 0) {
		notifySafe(
			ui,
			result.skippedExisting > 0
				? `pi-memory /seed done: all ${result.skippedExisting} candidate(s) already in memory. Nothing to do.`
				: "pi-memory /seed done: no durable candidates found.",
			"info",
		);
		return;
	}

	if (result.autoApply) {
		commitSeedResult(ctx, result);
		return;
	}

	const preview = result.candidates
		.slice(0, 10)
		.map((c) => `#${c.category} ${c.text}`)
		.join("\n");
	const failures = result.failedBatches.length ? ` (${result.failedBatches.length} batch(es) failed)` : "";
	notifySafe(
		ui,
		`pi-memory /seed done${failures}: ${result.candidates.length} candidate(s), ${result.skippedExisting} already known.\n${preview}\nRun /seed apply to write them, /seed status for all.`,
		"info",
	);
}

/** Destination file for a seed run, creating the project directory if needed. */
export function seedAppliedFile(): string {
	return path.join(AUDIT_DIR, "seed-applied.json");
}

/**
 * A run that was applied must not be revived by the background extraction
 * writing its result file again after the apply.
 */
function seedWasApplied(): boolean {
	return fs.existsSync(seedAppliedFile());
}

function markSeedApplied(result: SeedResult): void {
	try {
		writeJsonSidecar(seedAppliedFile(), {
			appliedAt: new Date().toISOString(),
			candidates: result.candidates.length,
			target: result.target,
		});
	} catch {
		// Non-fatal.
	}
}
/** Destination file for a seed run, creating the project directory if needed. */
function seedTargetFile(result: SeedResult, cwd: string): string {
	if (result.target !== "project") return MEMORY_FILE;
	const file = projectMemoryFile(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return file;
}

export function commitSeedResult(ctx: ExtensionCommandContext, result: SeedResult): void {
	const ts = nowTimestamp();
	const sid = shortSessionId(ctx.sessionManager.getSessionId());
	const body = result.candidates.map((c) => `#${c.category} ${c.text}`).join("\n");
	// A project run writes into the repository it was mined in, not into
	// whichever repository happens to be open when the run is applied.
	const targetCwd = result.cwd ?? ctx.cwd;
	const file = seedTargetFile(result, targetCwd);
	withMemoryLock(() => {
		appendStamped(file, body, ts, sid);
		clearSidecar(seedResultFile());
	});
	markSeedApplied(result);
	snapshotDirty = true;
	scheduleQmdRefresh();
	const where = result.target === "project" ? `project memory (${file})` : "MEMORY.md";
	notifySafe(
		ctx.ui,
		`Seeded ${result.candidates.length} entr${result.candidates.length === 1 ? "y" : "ies"} into ${where} (${result.skippedExisting} already known).`,
		"info",
	);
}

// --- injection processing --------------------------------------------------

function sourceFromLabel(label: string): string {
	if (label.includes("SCRATCHPAD")) return "SCRATCHPAD.md";
	if (label.includes("Project memory")) return "project/MEMORY.md";
	if (label.includes("MEMORY.md")) return "MEMORY.md";
	if (label.includes("Knowledge index")) return "knowledge-index";
	if (label.includes("auto-retrieved")) return "search";
	const daily = label.match(/Daily log:\s*(\d{4}-\d{2}-\d{2})/);
	if (daily) return `daily/${daily[1]}.md`;
	return "unknown";
}

/**
 * Inspect the final injected memory context: record which entries reached the
 * model, and flag entries whose files no longer exist. Returns the (possibly
 * annotated) text that should be injected.
 */
export function auditContext(context: string, cwd: string): string {
	if (!context || !auditEnabled()) return context;

	const mode = staleMode();
	const now = new Date().toISOString();
	const ledger = ledgerEnabled() ? readLedger() : null;

	// The context is `# Memory` followed by sections joined by a rule. A section
	// that fell past CONTEXT_MAX_CHARS was cut from the END, which is why we
	// attribute from the assembled text rather than from the source files.
	const body = context.startsWith("# Memory\n\n") ? context.slice("# Memory\n\n".length) : context;
	const chunks = body.split("\n\n---\n\n");

	if (ledger) {
		ledger.injections += 1;
		ledger.injectedChars += context.length;
	}

	const rebuilt = chunks.map((chunk) => {
		const newline = chunk.indexOf("\n\n");
		if (newline === -1) return chunk;
		const label = chunk.slice(0, newline);
		const content = chunk.slice(newline + 2);
		const src = sourceFromLabel(label);
		const blocks = splitAuditBlocks(content, src);

		if (ledger) {
			// A section that was cut holds fragments, not entries. Counting them
			// would make every real entry look like it was never injected.
			const cut = content.includes("[truncated");
			if (cut) {
				if (!ledger.truncatedSources) ledger.truncatedSources = [];
				const sources = ledger.truncatedSources;
				if (!sources.includes(src)) sources.push(src);
			} else if (src !== "knowledge-index") {
				for (const b of blocks) {
					if (!b.body) continue;
					const existing = ledger.entries[b.key];
					if (existing) {
						existing.n += 1;
						existing.last = now;
						existing.chars = (existing.chars ?? 0) + b.body.length;
					} else {
						ledger.entries[b.key] = { k: b.key, src, first: now, n: 1, last: now, chars: b.body.length };
					}
				}
			}
		}

		if (mode === "off") return chunk;

		const annotated = blocks.map((b) => {
			const missing = missingPathsIn(b.body, cwd);
			if (missing.length === 0) return b.full;
			const note = missing.join(", ");
			if (mode === "fold") {
				const head = b.body.replace(/\s+/g, " ").trim().slice(0, AUDIT_STALE_FOLD_HEAD);
				return `- [stale] ${head} _(referenced path no longer exists: ${note})_`;
			}
			return `${b.full}\n_(audit: referenced path no longer exists: ${note} — verify before relying on this)_`;
		});
		return `${label}\n\n${annotated.join("\n\n")}`;
	});

	if (ledger) scheduleLedgerWrite();
	// The "# Memory" heading belongs to the context, not to any section. Stripping
	// it here made the injected text lose its heading and silently broke every
	// caller that prepends to it.
	const header = context.startsWith("# Memory\n\n") ? "# Memory\n\n" : "";
	return `${header}${rebuilt.join("\n\n---\n\n")}`;
}

let exitSummaryReason: ExitSummaryReason | null = null;
let terminalInputUnsubscribe: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Memory snapshot (Option P: KV cache-stable context injection)
//
// The system prompt must be byte-stable across turns so local prefix caches
// (llama.cpp, vLLM, MLX) don't invalidate the entire conversation tail on each
// turn. We snapshot the memory context at deliberate checkpoints
// (session_start, session_before_compact, long_term writes, day rollover) and
// emit the same bytes for every turn in between.
// ---------------------------------------------------------------------------

let memorySnapshot: string | null = null;
let snapshotTakenAt: string | null = null;
let snapshotTakenOnDate: string | null = null;
let snapshotReason: string | null = null;
export let snapshotDirty = false;

/** Mark the cached injected context stale; the next session rebuilds it. */
export function markSnapshotDirty(): void {
	snapshotDirty = true;
}

export function refreshMemorySnapshot(reason: string) {
	const projectSection = projectMemorySection(projectCwd);
	const reserve = projectSection ? projectSection.length + PROJECT_MEMORY_SEPARATOR_CHARS : 0;
	memorySnapshot = postProcessContext(buildMemoryContext("", reserve), projectCwd, projectSection);
	snapshotTakenAt = nowTimestamp();
	snapshotTakenOnDate = todayStr();
	snapshotReason = reason;
	snapshotDirty = false;
}

export function getSnapshotMode(): "stable" | "refresh" | "per-turn" {
	const mode = (process.env.PI_MEMORY_SNAPSHOT ?? "stable").toLowerCase();
	if (mode === "per-turn") return "per-turn";
	if (mode === "refresh") return "refresh";
	return "stable";
}

/** Reset snapshot state (for testing). */
export function _resetMemorySnapshot() {
	memorySnapshot = null;
	snapshotTakenAt = null;
	snapshotTakenOnDate = null;
	snapshotReason = null;
	snapshotDirty = false;
}

/** Every pi lifecycle hook: start, shutdown, input, injection, compaction. */
export function registerLifecycleHooks(pi: ExtensionAPI) {
	// --- session_start: detect qmd, auto-setup collection ---
	pi.on("session_start", async (_event, ctx) => {
		exitSummaryReason = null;
		// Relative paths inside memory entries resolve against the project, so the
		// stale-path check needs the live cwd and a cold existence cache.
		_setAuditCwd(ctx.cwd);
		_setProjectTrust(ctx.isProjectTrusted());
		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}
		if (ctx.hasUI) {
			terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
				if (!data.includes("\u0004")) return undefined;
				if (!ctx.isIdle()) return undefined;
				if (ctx.ui.getEditorText().trim()) return undefined;
				exitSummaryReason = "ctrl+d";
				return undefined;
			});
		}

		if (!(await detectQmdForSession())) {
			if (ctx.hasUI) {
				ctx.ui.notify(qmdInstallInstructions(), "info");
			}
			refreshMemorySnapshot("session_start");
			return;
		}

		const hasCollection = await checkCollection(qmdCollectionName());
		if (!hasCollection) {
			await setupQmdCollection();
		}
		// Catch-up embed: covers writes from previous sessions (shutdown skips
		// embedding) and fresh installs where the collection exists but was
		// never embedded. Incremental, so a no-op when already current.
		ensureQmdEmbed();
		refreshMemorySnapshot("session_start");
	});

	// --- session_shutdown: write exit summary + clean up timer ---
	pi.on("session_shutdown", async (event, ctx) => {
		flushAuditLedger();
		const shutdownReason = (event as { reason?: string }).reason;

		if (terminalInputUnsubscribe) {
			terminalInputUnsubscribe();
			terminalInputUnsubscribe = null;
		}

		// Lifecycle transitions are usually not final session exits. By default,
		// avoid generating LLM summaries and running qmd updates during /reload,
		// /new, /resume, and /fork because that makes those transitions slow.
		// Users who prefer the old behavior can opt in with
		// PI_MEMORY_SUMMARIZE_TRANSITIONS=1.
		if (shouldSkipExitSummaryForReason(shutdownReason) || !isExitSummaryEnabled()) {
			exitSummaryReason = null;
			cancelQmdUpdate();
			return;
		}

		const reason = exitSummaryReason ?? "session-end";
		exitSummaryReason = null;

		let summaryTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (reason) {
				ensureDirs();
				// Race the summary against a self-imposed timeout: pi core awaits
				// shutdown handlers with no timeout, so a hanging provider would
				// otherwise block quitting indefinitely. On expiry nothing is
				// persisted (the late result, if any, is simply dropped).
				const summaryWork = generateExitSummary(ctx);
				const expired = new Promise<null>((resolve) => {
					summaryTimer = setTimeout(() => resolve(null), getExitSummaryTimeoutMs());
				});
				const result = await Promise.race([summaryWork, expired]);
				// Only persist real summaries. The old fallback appended an
				// all-"None." boilerplate block on every failed summarization
				// (no API key, empty response, …), polluting the daily log —
				// which is then re-injected into context every session start.
				// Successful-but-empty summaries (every section "None.") are
				// filtered out for the same reason.
				if (result?.hasMessages && result.summary && !isExitSummaryEmpty(result.summary)) {
					const summary = result.summary;
					const sid = shortSessionId(ctx.sessionManager.getSessionId());
					const ts = nowTimestamp();
					const entry = formatExitSummaryEntry(summary, reason, sid, ts);
					const filePath = dailyPath(todayStr());
					const existing = readFileSafe(filePath) ?? "";
					const separator = existing.trim() ? "\n\n" : "";
					fs.writeFileSync(filePath, existing + separator + entry, "utf-8");
					await ensureQmdAvailableForUpdate();
					await runQmdUpdateNow();
				}
			}
		} finally {
			if (summaryTimer) clearTimeout(summaryTimer);
			cancelQmdUpdate();
		}
	});

	// --- input: detect /quit for shutdown summary ---
	pi.on("input", async (event, _ctx) => {
		if (event.source !== "extension" && event.text.trim() === "/quit") {
			exitSummaryReason = "slash-quit";
		}
		return { action: "continue" };
	});

	// --- Inject memory context before every agent turn ---
	pi.on("before_agent_start", async (event, _ctx) => {
		const mode = getSnapshotMode();

		let memoryContext: string;
		let snapshotCaveat = "";

		if (mode === "per-turn") {
			const skipSearch = process.env.PI_MEMORY_NO_SEARCH === "1";
			const searchResults = skipSearch ? "" : await searchRelevantMemories(event.prompt ?? "");
			const projectSection = projectMemorySection(projectCwd);
			const reserve = projectSection ? projectSection.length + PROJECT_MEMORY_SEPARATOR_CHARS : 0;
			memoryContext = postProcessContext(buildMemoryContext(searchResults, reserve), projectCwd, projectSection);
		} else {
			// "stable" means stable: once taken, the block is emitted byte-for-byte
			// for the rest of the session. Refreshing on a long-term write or a
			// midnight rollover rewrites the tail of the system prompt and voids the
			// whole conversation's prefix cache — the exact cost the snapshot exists
			// to avoid, paid on the single most common in-session event. The fresh
			// state is not lost: the write is in tool-call history a few messages
			// back, deletions are sent as a correction message below, and
			// memory_read / memory_search reach the files directly. "refresh" restores the old
			// checkpoint behaviour.
			const today = todayStr();
			const stale = mode === "refresh" && (snapshotDirty || snapshotTakenOnDate !== today);
			if (memorySnapshot === null || stale) {
				const reason =
					memorySnapshot === null ? "before_agent_start" : snapshotDirty ? "long_term_write" : "day_rollover";
				refreshMemorySnapshot(reason);
			}
			memoryContext = memorySnapshot ?? "";
			// Deliberately carries no timestamp and no reason word: both change
			// between turns without the memory itself changing, which is enough on
			// its own to invalidate the cache this branch is trying to preserve.
			snapshotCaveat =
				mode === "refresh"
					? `Snapshot ${snapshotReason} at ${snapshotTakenAt}. ` +
						"Use memory_read / memory_search for the authoritative latest state; " +
						"recent writes may also be visible in tool-call history."
					: "Loaded once at session start and not re-read since. Use memory_read / memory_search " +
						"for the authoritative latest state; anything written this session is in tool-call history.";
		}

		if (!memoryContext) return;

		const headerLines: string[] = [];

		if (!memoryContext) {
			return { systemPrompt: `${event.systemPrompt}\n${headerLines.join("\n")}` };
		}

		headerLines.unshift("\n\n## Memory");
		if (snapshotCaveat) headerLines.push(`(${snapshotCaveat})`);
		headerLines.push(
			"The following memory files have been loaded. Use the memory_write tool to persist important information.",
			"- Decisions, preferences, and durable facts that follow you across projects \u2192 MEMORY.md (target: 'long_term')",
			"- Conventions, architecture and decisions scoped to THIS repository \u2192 .pi/memory/MEMORY.md (target: 'project')",
			"- Day-to-day notes and running context \u2192 daily/<YYYY-MM-DD>.md",
			"- Things to fix later or keep in mind \u2192 scratchpad tool",
			"- Use memory_search to find past context across all memory files (keyword, semantic, or deep search).",
			"- Use #tags (e.g. #decision, #preference) and [[links]] (e.g. [[auth-strategy]]) in memory content to improve future search recall.",
			'- If someone says "remember this," write it immediately.',
			"",
			memoryContext,
		);

		return {
			systemPrompt: event.systemPrompt + headerLines.join("\n"),
		};
	});

	// --- Pre-compaction: auto-capture session handoff ---
	pi.on("session_before_compact", async (_event, ctx) => {
		ensureDirs();
		const sid = shortSessionId(ctx.sessionManager.getSessionId());
		const ts = nowTimestamp();
		const parts: string[] = [];

		// Capture open scratchpad items
		const scratchpad = readFileSafe(SCRATCHPAD_FILE);
		if (scratchpad?.trim()) {
			const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
			if (openItems.length > 0) {
				parts.push("**Open scratchpad items:**");
				for (const item of openItems) {
					parts.push(`- [ ] ${item.text}`);
				}
			}
		}

		// Capture last few lines from today's daily log
		const todayContent = readFileSafe(dailyPath(todayStr()));
		if (todayContent?.trim()) {
			const lines = todayContent.trim().split("\n");
			const tail = lines.slice(-15).join("\n");
			parts.push(`**Recent daily log context:**\n${tail}`);
		}

		// Intentional cache boundary: compaction drops tool history, so the
		// snapshot must catch up to disk on every compaction — even when no
		// handoff is written. Otherwise stale pre-compaction state (e.g. a
		// completed scratchpad item that no longer appears in the snapshot
		// source files) would keep being injected.
		try {
			if (parts.length === 0) return;

			const handoff = [`<!-- HANDOFF ${ts} [${sid}] -->`, "## Session Handoff", ...parts].join("\n");

			const filePath = dailyPath(todayStr());
			const existing = readFileSafe(filePath) ?? "";
			const separator = existing.trim() ? "\n\n" : "";
			fs.writeFileSync(filePath, existing + separator + handoff, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
		} finally {
			refreshMemorySnapshot("session_before_compact");
		}
	});

	// --- /audit: memory health report ---
}

// A base-dir change has to clear the caches that live in this layer too.
_onBaseDirChange(_resetAuditState);
