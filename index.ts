/**
 * Memory Extension with QMD-Powered Search
 *
 * Plain-Markdown memory system with semantic search via qmd.
 * Core memory tools (write/read/scratchpad) work without qmd installed.
 * The memory_search tool requires qmd for keyword, semantic, and hybrid search.
 *
 * Layout (under ~/.pi/agent/memory/):
 *   MEMORY.md              — curated long-term memory (decisions, preferences, durable facts)
 *   SCRATCHPAD.md           — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md    — daily append-only log (today + yesterday loaded at session start)
 *   recovery/*.json        — durable records for restoring memory_forget deletions
 *
 * Tools:
 *   memory_write   — write to MEMORY.md or daily log
 *   memory_forget  — delete matching memory entries and create a recovery record
 *   memory_restore — restore entries from a memory_forget recovery record
 *   memory_read    — read any memory file or list daily logs
 *   scratchpad     — add/check/uncheck/clear items on the scratchpad checklist
 *   memory_search  — search across all memory files via qmd (keyword, semantic, or deep)
 *
 * Context injection:
 *   - MEMORY.md + SCRATCHPAD.md + today's + yesterday's daily logs injected into every turn
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

type MemoryEnv = Partial<
	Record<"PI_MEMORY_DIR" | "HOME" | "USERPROFILE" | "HOMEDRIVE" | "HOMEPATH", string | undefined>
> & {
	[key: string]: string | undefined;
};

export function resolveMemoryDir(env: MemoryEnv = process.env): string {
	if (env.PI_MEMORY_DIR) return env.PI_MEMORY_DIR;
	const home =
		env.HOME ??
		env.USERPROFILE ??
		(env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined) ??
		"~";
	return path.join(home, ".pi", "agent", "memory");
}

let MEMORY_DIR = resolveMemoryDir();
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");
let AUDIT_DIR = path.join(MEMORY_DIR, ".audit");
let WIKI_DIR = path.join(MEMORY_DIR, "wiki");
let TOPICS_DIR = path.join(MEMORY_DIR, "topics");
let TRANSCRIPTS_DIR = path.join(MEMORY_DIR, "transcripts");

/** Override base directory (for testing). */
export function _setBaseDir(baseDir: string) {
	MEMORY_DIR = baseDir;
	MEMORY_FILE = path.join(baseDir, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(baseDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(baseDir, "daily");
	RECOVERY_DIR = path.join(baseDir, "recovery");
	AUDIT_DIR = path.join(baseDir, ".audit");
	WIKI_DIR = path.join(baseDir, "wiki");
	TOPICS_DIR = path.join(baseDir, "topics");
	TRANSCRIPTS_DIR = path.join(baseDir, "transcripts");
	_resetAuditState();
}

/** Reset to default paths (for testing). */
export function _resetBaseDir() {
	_setBaseDir(resolveMemoryDir());
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(RECOVERY_DIR, { recursive: true });
	fs.mkdirSync(WIKI_DIR, { recursive: true });
	fs.mkdirSync(TOPICS_DIR, { recursive: true });
	fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

// Daily logs are keyed by the user's LOCAL calendar day. toISOString() is UTC,
// which filed every evening write (after 5pm PDT) under tomorrow's date and
// made the injected "today's log" look at the wrong file.
function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function localDateStr(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayStr(): string {
	return localDateStr(new Date());
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return localDateStr(d);
}

export function nowTimestamp(): string {
	const d = new Date();
	return `${localDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath: string, maxBytes?: number): string | null {
	try {
		if (maxBytes !== undefined) {
			const stat = fs.statSync(filePath);
			if (stat.size > maxBytes) {
				// A huge file is read up to the limit only. The head of a session
				// log carries the first messages, which is enough for mining.
				const fd = fs.openSync(filePath, "r");
				try {
					const buffer = Buffer.alloc(maxBytes);
					const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
					return buffer.subarray(0, read).toString("utf-8");
				} finally {
					fs.closeSync(fd);
				}
			}
		}
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/** Names Windows refuses to use as a file name, with or without extension. */
const WINDOWS_RESERVED_NAMES = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function isReservedFileName(name: string): boolean {
	const base = name.replace(/\.[^.]*$/, "").toLowerCase();
	return WINDOWS_RESERVED_NAMES.has(base);
}

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDailyDate(date: string): boolean {
	if (!DAILY_DATE_REGEX.test(date)) return false;
	const [year, month, day] = date.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function dailyPath(date: string): string {
	if (!isValidDailyDate(date)) {
		throw new Error(`Invalid daily date: ${date}. Expected YYYY-MM-DD.`);
	}
	return path.join(DAILY_DIR, `${date}.md`);
}

// ---------------------------------------------------------------------------
// Limits + preview helpers
// ---------------------------------------------------------------------------

const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
const RESPONSE_PREVIEW_MAX_LINES = 120;

const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_SEARCH_MAX_CHARS = 2_500;
const CONTEXT_SEARCH_MAX_LINES = 80;
const CONTEXT_MAX_CHARS = 16_000;

/** Navigation layer: one line per wiki page and topic note. Bodies stay on disk. */
const CONTEXT_KNOWLEDGE_MAX_CHARS = 2_000;
const CONTEXT_KNOWLEDGE_MAX_LINES = 60;

/** Project-tier memory is injected ahead of the global tier, so it gets a smaller budget. */
const PROJECT_MEMORY_MAX_CHARS = 3_000;
/** Room for the separator that joins the project section to the context. */
const PROJECT_MEMORY_SEPARATOR_CHARS = 12;
/** A wiki page or topic note never grows past this. */
const KNOWLEDGE_FILE_MAX_CHARS = 20_000;

const EXIT_SUMMARY_MAX_CHARS = 80_000;
const EXIT_SUMMARY_MIN_MESSAGES = 4;
const EXIT_SUMMARY_SYSTEM_PROMPT = [
	"You are a session recap assistant.",
	"Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
	"Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

type TruncateMode = "start" | "end" | "middle";

interface PreviewResult {
	preview: string;
	truncated: boolean;
	totalLines: number;
	totalChars: number;
	previewLines: number;
	previewChars: number;
}

function normalizeContent(content: string): string {
	return content.trim();
}

function truncateLines(lines: string[], maxLines: number, mode: TruncateMode) {
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, truncated: false };
	}

	if (mode === "end") {
		return { lines: lines.slice(-maxLines), truncated: true };
	}

	if (mode === "middle" && maxLines > 1) {
		const marker = "... (truncated) ...";
		const keep = maxLines - 1;
		const headCount = Math.ceil(keep / 2);
		const tailCount = Math.floor(keep / 2);
		const head = lines.slice(0, headCount);
		const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
		return { lines: [...head, marker, ...tail], truncated: true };
	}

	return { lines: lines.slice(0, maxLines), truncated: true };
}

function truncateText(text: string, maxChars: number, mode: TruncateMode) {
	if (maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}

	if (mode === "end") {
		return { text: text.slice(-maxChars), truncated: true };
	}

	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: text.slice(0, headCount) + marker + text.slice(text.length - tailCount),
				truncated: true,
			};
		}
	}

	return { text: text.slice(0, maxChars), truncated: true };
}

function buildPreview(
	content: string,
	options: { maxLines: number; maxChars: number; mode: TruncateMode },
): PreviewResult {
	const normalized = normalizeContent(content);
	if (!normalized) {
		return {
			preview: "",
			truncated: false,
			totalLines: 0,
			totalChars: 0,
			previewLines: 0,
			previewChars: 0,
		};
	}

	const lines = normalized.split("\n");
	const totalLines = lines.length;
	const totalChars = normalized.length;

	const lineResult = truncateLines(lines, options.maxLines, options.mode);
	const text = lineResult.lines.join("\n");
	const charResult = truncateText(text, options.maxChars, options.mode);
	const preview = charResult.text;

	const previewLines = preview ? preview.split("\n").length : 0;
	const previewChars = preview.length;

	return {
		preview,
		truncated: lineResult.truncated || charResult.truncated,
		totalLines,
		totalChars,
		previewLines,
		previewChars,
	};
}

function formatPreviewBlock(label: string, content: string, mode: TruncateMode) {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode,
	});

	if (!result.preview) {
		return `${label}: empty.`;
	}

	const meta = `${label} (${result.totalLines} lines, ${result.totalChars} chars)`;
	const note = result.truncated
		? `\n[preview truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${meta}\n\n${result.preview}${note}`;
}

function formatContextSection(label: string, content: string, mode: TruncateMode, maxLines: number, maxChars: number) {
	const result = buildPreview(content, { maxLines, maxChars, mode });
	if (!result.preview) {
		return "";
	}
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${label}\n\n${result.preview}${note}`;
}

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

function getQmdUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
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

async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string; // the <!-- timestamp [session] --> comment
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

// Line-preserving mutations. The old parse→mutate→serialize round-trip kept
// only checklist lines, silently deleting anything else in SCRATCHPAD.md
// (hand-written notes, section headers, sub-bullets) on the first write.
// These operate on the raw lines so unknown content survives.

const SCRATCHPAD_ITEM_REGEX = /^- \[([ xX])\] (.+)$/;
const SCRATCHPAD_META_COMMENT_REGEX = /^<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]\r\n]+\] -->$/;
const MEMORY_ENTRY_META_COMMENT_REGEX =
	/^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MemoryTarget = "long_term" | "daily";

interface RecoveryRecord {
	version: 1;
	id: string;
	createdAt: string;
	target: MemoryTarget;
	date?: string;
	removedContent: string[];
	restoredAt?: string;
}

export function scratchpadAdd(content: string, text: string, meta: string): string {
	if (!content.trim()) {
		return serializeScratchpad([{ done: false, text, meta }]);
	}
	const base = content.replace(/\n+$/, "");
	return `${base}\n${meta}\n- [ ] ${text}\n`;
}

export function scratchpadToggle(
	content: string,
	needle: string,
	done: boolean,
): { content: string; matched: boolean } {
	const lines = content.split("\n");
	const lower = needle.toLowerCase();
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(SCRATCHPAD_ITEM_REGEX);
		if (!m) continue;
		if ((m[1].toLowerCase() === "x") === done) continue;
		if (!m[2].toLowerCase().includes(lower)) continue;
		lines[i] = `- [${done ? "x" : " "}] ${m[2]}`;
		return { content: lines.join("\n"), matched: true };
	}
	return { content, matched: false };
}

export function scratchpadClearDone(content: string): { content: string; removed: number } {
	const lines = content.split("\n");
	const out: string[] = [];
	let removed = 0;
	for (const line of lines) {
		const m = line.match(SCRATCHPAD_ITEM_REGEX);
		if (m && m[1].toLowerCase() === "x") {
			removed++;
			// Drop the item's timestamp comment directly above it, if any.
			if (out.length > 0 && SCRATCHPAD_META_COMMENT_REGEX.test(out[out.length - 1])) {
				out.pop();
			}
			continue;
		}
		out.push(line);
	}
	return { content: out.join("\n"), removed };
}

// ---------------------------------------------------------------------------
// Forget helper — deletion as a first-class operation
// ---------------------------------------------------------------------------

/**
 * Remove every generated entry containing `match` (case-insensitive) from
 * `content`. Generated entries start at a pi-memory timestamp comment and end
 * at the next one, so multi-paragraph writes are removed as a unit. Content
 * before the first generated entry falls back to blank-line paragraph blocks.
 * Returns the surviving content and complete removed entries.
 */
export function forgetBlocks(content: string, match: string): { content: string; removed: string[] } {
	const needle = match.trim().toLowerCase();
	if (!needle) return { content, removed: [] };
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedContent = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");

	const blocks: string[] = [];
	let currentLines: string[] = [];
	let currentIsStamped = false;
	const flushCurrent = () => {
		const current = currentLines.join("\n").trim();
		if (!current) return;
		if (currentIsStamped) {
			blocks.push(current);
		} else {
			blocks.push(
				...current
					.split(/\n{2,}/)
					.map((block) => block.trim())
					.filter(Boolean),
			);
		}
	};

	for (const line of normalizedContent.split("\n")) {
		if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
			flushCurrent();
			currentLines = [line];
			currentIsStamped = true;
		} else {
			currentLines.push(line);
		}
	}
	flushCurrent();

	const kept: string[] = [];
	const removed: string[] = [];
	for (const block of blocks) {
		if (block.toLowerCase().includes(needle)) {
			removed.push(block);
		} else {
			kept.push(block);
		}
	}
	if (removed.length === 0) return { content, removed };
	const joined = kept.join("\n\n").trim();
	return {
		content: joined ? `${joined}\n`.replace(/\n/g, newline) : "",
		removed: removed.map((block) => block.replace(/\n/g, newline)),
	};
}

function recoveryPath(recoveryId: string): string | null {
	if (!RECOVERY_ID_REGEX.test(recoveryId)) return null;
	return path.join(RECOVERY_DIR, `${recoveryId}.json`);
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<RecoveryRecord>;
	return (
		record.version === 1 &&
		typeof record.id === "string" &&
		RECOVERY_ID_REGEX.test(record.id) &&
		(record.target === "long_term" || record.target === "daily") &&
		(record.target !== "daily" || (typeof record.date === "string" && isValidDailyDate(record.date))) &&
		Array.isArray(record.removedContent) &&
		record.removedContent.length > 0 &&
		record.removedContent.every((entry) => typeof entry === "string")
	);
}

function writeRecoveryRecord(target: MemoryTarget, date: string | undefined, removedContent: string[]): RecoveryRecord {
	const record: RecoveryRecord = {
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		target,
		...(date ? { date } : {}),
		removedContent,
	};
	const filePath = recoveryPath(record.id);
	if (!filePath) throw new Error("Failed to create a valid recovery ID.");
	fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	return record;
}

function readRecoveryRecord(recoveryId: string): { record: RecoveryRecord; filePath: string } | null {
	const filePath = recoveryPath(recoveryId);
	if (!filePath) return null;
	const content = readFileSafe(filePath);
	if (!content) return null;
	try {
		const record: unknown = JSON.parse(content);
		if (!isRecoveryRecord(record) || record.id !== recoveryId) return null;
		return { record, filePath };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMemoryContext(searchResults?: string, reserveChars = 0): string {
	ensureDirs();
	// Priority order: scratchpad > today's daily > search results > MEMORY.md > yesterday's daily
	const sections: string[] = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const serialized = serializeScratchpad(openItems);
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serialized,
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (searchResults?.trim()) {
		const section = formatContextSection(
			"## Relevant memories (auto-retrieved)",
			searchResults,
			"start",
			CONTEXT_SEARCH_MAX_LINES,
			CONTEXT_SEARCH_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			orderByVerification(longTerm),
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const knowledge = buildKnowledgeIndex();
	if (knowledge.length > 0) {
		const section = formatContextSection(
			"## Knowledge index (wiki + topic notes — read the file for the body)",
			formatKnowledgeIndex(knowledge),
			"start",
			CONTEXT_KNOWLEDGE_MAX_LINES,
			CONTEXT_KNOWLEDGE_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) {
		return "";
	}

	const context = `# Memory\n\n${sections.join("\n\n---\n\n")}`;
	// The project tier is injected in front of this context, so its size is
	// taken out of the overall budget. Without the reservation the total
	// injection could reach the project budget on top of the full context.
	const limit = Math.max(0, CONTEXT_MAX_CHARS - Math.max(0, reserveChars));
	if (context.length > limit) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: limit,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}

	return context;
}

// ---------------------------------------------------------------------------
// Knowledge index (wiki pages + topic notes)
//
// Anthropic's agent-memory write-up keeps a "memory representation" layer: a
// wiki the agent maintains and navigates, separate from the raw notes, with
// only a small index injected. This is the same split. wiki/*.md and
// topics/*.md hold the bodies; the injected index holds one line per file, so
// the model learns what exists and pulls the body on demand with memory_read.
// ---------------------------------------------------------------------------

export interface KnowledgeEntry {
	kind: "wiki" | "topic";
	title: string;
	/** Path relative to the memory dir, using forward slashes. */
	file: string;
	summary: string;
}

function firstHeadingLine(content: string): string | null {
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) return trimmed.replace(/^#+\s*/, "").trim();
	}
	return null;
}

function firstSummaryLine(content: string): string | null {
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#")) continue;
		if (trimmed.startsWith("<!--")) continue;
		return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
	}
	return null;
}

function readKnowledgeDir(dir: string, kind: "wiki" | "topic"): KnowledgeEntry[] {
	let files: string[] = [];
	try {
		files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
	return files.map((file) => {
		const content = readFileSafe(path.join(dir, file)) ?? "";
		return {
			kind,
			title: firstHeadingLine(content) ?? path.basename(file, ".md"),
			file: path.join(kind === "wiki" ? "wiki" : "topics", file).replace(/\\/g, "/"),
			summary: firstSummaryLine(content) ?? "",
		};
	});
}

export function buildKnowledgeIndex(): KnowledgeEntry[] {
	return [...readKnowledgeDir(WIKI_DIR, "wiki"), ...readKnowledgeDir(TOPICS_DIR, "topic")];
}

function formatKnowledgeIndex(entries: KnowledgeEntry[]): string {
	return entries
		.map((entry) =>
			entry.summary ? `- ${entry.title} (${entry.file}) — ${entry.summary}` : `- ${entry.title} (${entry.file})`,
		)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Verification status
//
// A note that records only a conclusion cannot be told apart from a note that
// was never checked. Tags make the difference visible in the markdown, and the
// injected layer puts explicitly unverified notes last so they are less likely
// to be read as established fact.
// ---------------------------------------------------------------------------

export type VerificationStatus = "verified" | "unverified" | "pending";

const VERIFICATION_PATTERNS: [VerificationStatus, RegExp][] = [
	// Chinese tags are followed by a space or punctuation, never a word
	// boundary: \b only matches next to ASCII word characters.
	["unverified", /#(?:未验证|未核实)|#unverified\b/i],
	["verified", /#(?:已验证|已核实)|#verified\b/i],
	["pending", /#(?:待验证|待核实)|#pending\b/i],
];

export function verificationStatus(text: string): VerificationStatus {
	for (const [status, pattern] of VERIFICATION_PATTERNS) {
		if (pattern.test(text)) return status;
	}
	return "pending";
}

/** Sidecar written by /dream. The markdown stays untouched. */
interface VerifiedRecord {
	status: VerificationStatus;
	evidence?: string;
	at?: string;
}

let verifiedStateCache: Record<string, VerifiedRecord> | null = null;
let verifiedStateCacheMtime = -1;

function verifiedStateFile(): string {
	return path.join(AUDIT_DIR, "verified.json");
}

function readVerifiedState(): Record<string, VerifiedRecord> {
	// The sidecar is read on every injection, so the parsed copy is kept and
	// refreshed when the file changes.
	const mtime = fileMtime(verifiedStateFile());
	if (verifiedStateCache && verifiedStateCacheMtime === mtime) return verifiedStateCache;
	verifiedStateCacheMtime = mtime;
	const raw = readFileSafe(verifiedStateFile());
	if (!raw) {
		verifiedStateCache = {};
		return verifiedStateCache;
	}
	try {
		const parsed = JSON.parse(raw);
		verifiedStateCache = parsed && typeof parsed === "object" ? (parsed as Record<string, VerifiedRecord>) : {};
	} catch {
		verifiedStateCache = {};
	}
	return verifiedStateCache;
}

export function writeVerifiedState(state: Record<string, VerifiedRecord>): void {
	fs.mkdirSync(AUDIT_DIR, { recursive: true });
	writeJsonAtomic(verifiedStateFile(), state);
	verifiedStateCache = state;
	verifiedStateCacheMtime = fileMtime(verifiedStateFile());
}

/**
 * Inline tag wins over the sidecar, so a hand-written tag is always honoured.
 *
 * `key` must be the key of the block the sidecar recorded. The sidecar is
 * written with the key of the whole stamped block, so the lookup key and the
 * stored key have to be the same value.
 */
function verificationStatusOf(text: string, key?: string): VerificationStatus {
	const inline = verificationStatus(text);
	if (inline !== "pending") return inline;
	const record = readVerifiedState()[key ?? auditKey(text)];
	return record?.status ?? "pending";
}

/** Lower sorts first. Unverified notes sink to the end of the injected block. */
function verificationRank(status: VerificationStatus): number {
	if (status === "verified") return 0;
	if (status === "pending") return 1;
	return 2;
}

/**
 * Reorder the long-term entries so unverified ones come last.
 *
 * Only applies when every entry is a stamped block: a hand-written preamble
 * (a heading, an index) stays where the author put it.
 */
export function orderByVerification(content: string): string {
	const blocks = splitAuditBlocks(content, "MEMORY.md");
	if (blocks.length < 2) return content;
	if (blocks.some((block) => block.stamp === null)) return content;
	const sorted = [...blocks].sort(
		(a, b) =>
			verificationRank(verificationStatusOf(a.body, a.key)) - verificationRank(verificationStatusOf(b.body, b.key)),
	);
	if (sorted.every((block, i) => block.full === blocks[i].full)) return content;
	return `${sorted.map((block) => block.full).join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Write lock (fork addition)
//
// Every memory write is a read, a change and a write back. Two pi sessions
// that write at the same time lose one of the two writes. The lock is a
// directory: creating a directory is atomic on every platform, so it works
// between processes as well as inside one.
// ---------------------------------------------------------------------------

const MEMORY_LOCK_NAME = "write.lock";
const MEMORY_LOCK_TIMEOUT_MS = 5_000;
const MEMORY_LOCK_STALE_MS = 30_000;

/** Compare two directories, ignoring case and trailing separators on Windows. */
function pathsEqual(a: string, b: string): boolean {
	const norm = (p: string) => {
		const resolved = path.resolve(p).replace(/[\\/]+$/, "");
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return norm(a) === norm(b);
}

/** Block the thread for a moment. Used while another process holds the lock. */
function sleepSync(ms: number): void {
	const buffer = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function memoryLockPath(): string {
	return path.join(AUDIT_DIR, MEMORY_LOCK_NAME);
}

function acquireMemoryLock(): boolean {
	const lockPath = memoryLockPath();
	const deadline = Date.now() + MEMORY_LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			fs.mkdirSync(path.join(AUDIT_DIR), { recursive: true });
			fs.mkdirSync(lockPath);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
			// A process that died while holding the lock leaves it behind.
			try {
				const stat = fs.statSync(lockPath);
				if (Date.now() - stat.mtimeMs > MEMORY_LOCK_STALE_MS) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				// The lock is gone; try again.
			}
			if (Date.now() >= deadline) return false;
			sleepSync(25);
		}
	}
}

function releaseMemoryLock(): void {
	try {
		fs.rmSync(memoryLockPath(), { recursive: true, force: true });
	} catch {
		// Nothing to release.
	}
}

/**
 * Run a memory write while holding the lock.
 *
 * The lock is re-entrant inside one process, so a helper that already holds
 * it can call another one without waiting for itself. The lock is best
 * effort: if it cannot be taken in time the write still runs, because losing
 * a memory entry is worse than losing one concurrent update.
 */
let memoryLockDepth = 0;
export function withMemoryLock<T>(fn: () => T): T {
	if (memoryLockDepth > 0) {
		memoryLockDepth += 1;
		try {
			return fn();
		} finally {
			memoryLockDepth -= 1;
		}
	}
	const locked = acquireMemoryLock();
	memoryLockDepth = 1;
	try {
		return fn();
	} finally {
		memoryLockDepth = 0;
		if (locked) releaseMemoryLock();
	}
}

/** Write JSON through a temporary file, so a crash cannot leave half a file. */
export function writeJsonAtomic(target: string, value: unknown): void {
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	fs.renameSync(tmp, target);
}

/**
 * Read a memory file, change it and write it back while holding the lock.
 *
 * The read has to happen inside the lock, otherwise two sessions can both
 * read the same old content and the second write drops the first one.
 */
export function updateMemoryFile(
	file: string,
	build: (existing: string) => string,
): { existing: string; next: string } {
	return withMemoryLock(() => {
		const existing = readFileSafe(file) ?? "";
		const next = build(existing);
		fs.writeFileSync(file, next, "utf-8");
		return { existing, next };
	});
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
const AUDIT_CHARS_PER_TOKEN = 4;

type StaleMode = "annotate" | "fold" | "off";

interface AuditBlock {
	key: string;
	src: string;
	body: string;
	full: string;
	stamp: string | null;
}

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

interface Ledger {
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
let projectTrusted = false;

function projectMemoryFile(cwd: string): string {
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
	verifiedStateCache = null;
	verifiedStateCacheMtime = -1;
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

function staleMode(): StaleMode {
	const v = (process.env.PI_MEMORY_STALE_CHECK ?? "annotate").toLowerCase();
	if (v === "off" || v === "0" || v === "false") return "off";
	if (v === "fold") return "fold";
	return "annotate";
}

function auditEnabled(): boolean {
	return ledgerEnabled() || staleMode() !== "off";
}

function auditKey(text: string): string {
	return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/**
 * Split a memory file into the same units memory_forget operates on: a
 * timestamp comment starts an entry and it runs to the next one. Unstamped
 * leading content falls back to blank-line paragraph blocks, matching
 * forgetBlocks. Kept separate from forgetBlocks so upstream deletion
 * behaviour stays untouched.
 */
export function splitAuditBlocks(content: string, src: string): AuditBlock[] {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
	const blocks: AuditBlock[] = [];
	let lines: string[] = [];
	let stamped = false;

	const flush = () => {
		const text = lines.join("\n").trim();
		if (!text) return;
		if (stamped) {
			blocks.push({
				key: auditKey(text),
				src,
				body: lines.slice(1).join("\n").trim(),
				full: text,
				stamp: lines[0].trim(),
			});
		} else {
			for (const paragraph of text.split(/\n{2,}/)) {
				const body = paragraph.trim();
				if (!body) continue;
				blocks.push({ key: auditKey(body), src, body, full: body, stamp: null });
			}
		}
	};

	for (const line of normalized.split("\n")) {
		if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
			flush();
			lines = [line];
			stamped = true;
		} else {
			lines.push(line);
		}
	}
	flush();
	return blocks;
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

function readLedger(): Ledger {
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
 * `.audit` hold live state: the supersede chain, the verification sidecar and
 * the pending seed and dream results.
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

/** Timestamp of a file, or -1 when it does not exist. */
function fileMtime(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return -1;
	}
}

function supersedesFile(): string {
	return path.join(AUDIT_DIR, "supersedes.json");
}

function readSupersedes(): SupersedeMap {
	// Another session may have changed the chain. The timestamp says whether
	// the cached copy is still current.
	const mtime = fileMtime(supersedesFile());
	if (supersedesCache && supersedesCacheMtime === mtime) return supersedesCache;
	supersedesCacheMtime = mtime;
	const raw = readFileSafe(supersedesFile());
	if (!raw) {
		supersedesCache = {};
		return supersedesCache;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			supersedesCache = {};
		} else {
			const out: SupersedeMap = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				const record = value as Partial<SupersedeRecord> | null;
				if (!record || typeof record.by !== "string" || typeof record.at !== "string") continue;
				out[key] = {
					by: record.by,
					at: record.at,
					reason: typeof record.reason === "string" ? record.reason : undefined,
				};
			}
			supersedesCache = out;
		}
	} catch {
		supersedesCache = {};
	}
	return supersedesCache;
}

function writeSupersedes(map: SupersedeMap): void {
	supersedesCache = map;
	try {
		fs.mkdirSync(AUDIT_DIR, { recursive: true });
		writeJsonAtomic(supersedesFile(), map);
		supersedesCacheMtime = fileMtime(supersedesFile());
	} catch {
		// Diagnostics only; a lost supersede map is recoverable by hand.
	}
}

/** Live supersede chain, read on demand so /reload picks up external edits. */
function activeSupersedes(): SupersedeMap {
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
// Seeding from past sessions (fork addition)
// ---------------------------------------------------------------------------

const SEED_DEFAULT_DAYS = 30;
/** A session log is read up to this size. Bigger files are read in part. */
const SESSION_FILE_MAX_BYTES = 8 * 1024 * 1024;
const SEED_MIN_CHARS = 4;
const SEED_MAX_CHARS = 600;
const SEED_MAX_MESSAGES = 200;
const SEED_BATCH_SIZE = 40;

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

function sessionsRoot(): string {
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

/** Durable-looking user prompts from past sessions, newest first, deduplicated. */
export function collectSeedMessages(days: number, projectFilter?: string): SeedMessage[] {
	const root = sessionsRoot();
	const cutoff = Date.now() - days * 86_400_000;
	const seen = new Set<string>();
	const out: SeedMessage[] = [];

	let projects: string[] = [];
	try {
		projects = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
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
		}
	}

	out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	return out.slice(0, SEED_MAX_MESSAGES);
}

const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/,
	/\bgh[pousr]_[A-Za-z0-9]{16,}/,
	/\bAKIA[0-9A-Z]{12,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S{8,}/i,
	/\bAuthorization:\s*Bearer\s+\S{12,}/i,
	/\bghp_[A-Za-z0-9]{20,}/,
];

export function looksLikeSecret(text: string): boolean {
	return SECRET_PATTERNS.some((re) => re.test(text));
}

function parseCandidateArray(raw: string): SeedCandidate[] {
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1].trim();
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		if (!Array.isArray(parsed)) return [];
		const out: SeedCandidate[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== "object") continue;
			const record = item as { text?: unknown; category?: unknown };
			if (typeof record.text !== "string") continue;
			const value = record.text.replace(/\s+/g, " ").trim();
			if (value.length < 8 || value.length > 300) continue;
			if (value.includes("\n")) continue;
			if (looksLikeSecret(value)) continue;
			const category =
				typeof record.category === "string" &&
				/^(preference|decision|convention|failure|insight)$/i.test(record.category)
					? record.category.toLowerCase()
					: "insight";
			out.push({ text: value, category });
		}
		return out;
	} catch {
		return [];
	}
}

function buildSeedPrompt(messages: SeedMessage[]): string {
	const lines = messages.map((m, i) => `[${i + 1}] ${m.text.replace(/\s+/g, " ").slice(0, 400)}`);
	return `Past prompts from the user, oldest first. Extract durable memory candidates.\n\n${lines.join("\n")}`;
}

async function extractSeedBatch(
	ctx: ExtensionCommandContext,
	messages: SeedMessage[],
): Promise<{ candidates: SeedCandidate[]; error?: string }> {
	const model = ctx.model;
	if (!model) return { candidates: [], error: "No active model" };
	const apiKey = await resolveExitSummaryApiKey(ctx, model);
	if (!apiKey) return { candidates: [], error: `API key resolution failed for ${model.provider}/${model.id}` };

	try {
		const response = await complete(
			model,
			{
				systemPrompt: SEED_SYSTEM_PROMPT,
				messages: [
					{ role: "user", content: [{ type: "text", text: buildSeedPrompt(messages) }], timestamp: Date.now() },
				],
			},
			{ apiKey },
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return { candidates: parseCandidateArray(text) };
	} catch (err) {
		return { candidates: [], error: err instanceof Error ? err.message : String(err) };
	}
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

function appendStamped(filePath: string, content: string, stamp: string, sessionId: string): void {
	withMemoryLock(() => {
		const existing = readFileSafe(filePath) ?? "";
		const separator = existing.trim() ? "\n\n" : "";
		fs.writeFileSync(filePath, `${existing}${separator}<!-- ${stamp} [${sessionId}] -->\n${content}\n`, "utf-8");
	});
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
interface SeedResult {
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

type SeedTarget = "global" | "project";

let seedInFlight = false;

function seedResultFile(): string {
	return path.join(AUDIT_DIR, "seed-result.json");
}

function readSeedResult(): SeedResult | null {
	const raw = readFileSafe(seedResultFile());
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<SeedResult>;
		if (!parsed || !Array.isArray(parsed.candidates)) return null;
		return parsed as SeedResult;
	} catch {
		return null;
	}
}

function notifySafe(ui: ExtensionCommandContext["ui"], message: string, level: "info" | "warning"): void {
	try {
		ui.notify(message, level);
	} catch {
		// The session may have moved on. /seed status still reads the result file.
	}
}

async function extractAllBatches(
	ctx: ExtensionCommandContext,
	messages: SeedMessage[],
	result: SeedResult,
): Promise<void> {
	const ui = ctx.ui;
	try {
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
				fs.mkdirSync(AUDIT_DIR, { recursive: true });
				fs.writeFileSync(seedResultFile(), `${JSON.stringify(result, null, 2)}\n`, "utf-8");
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

		fs.mkdirSync(AUDIT_DIR, { recursive: true });
		fs.writeFileSync(seedResultFile(), `${JSON.stringify(result, null, 2)}\n`, "utf-8");

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
	} finally {
		seedInFlight = false;
	}
}

/** Destination file for a seed run, creating the project directory if needed. */
function seedAppliedFile(): string {
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
		fs.mkdirSync(AUDIT_DIR, { recursive: true });
		writeJsonAtomic(seedAppliedFile(), {
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

function commitSeedResult(ctx: ExtensionCommandContext, result: SeedResult): void {
	const ts = nowTimestamp();
	const sid = shortSessionId(ctx.sessionManager.getSessionId());
	const body = result.candidates.map((c) => `#${c.category} ${c.text}`).join("\n");
	// A project run writes into the repository it was mined in, not into
	// whichever repository happens to be open when the run is applied.
	const targetCwd = result.cwd ?? ctx.cwd;
	const file = seedTargetFile(result, targetCwd);
	withMemoryLock(() => {
		appendStamped(file, body, ts, sid);
		try {
			fs.rmSync(seedResultFile(), { force: true });
		} catch {
			// Nothing to remove.
		}
	});
	markSeedApplied(result);
	snapshotDirty = true;
	void ensureQmdAvailableForUpdate()
		.then(() => scheduleQmdUpdate())
		.catch(() => {});
	const where = result.target === "project" ? `project memory (${file})` : "MEMORY.md";
	notifySafe(
		ctx.ui,
		`Seeded ${result.candidates.length} entr${result.candidates.length === 1 ? "y" : "ies"} into ${where} (${result.skippedExisting} already known).`,
		"info",
	);
}

function applySeedResult(ctx: ExtensionCommandContext, result: SeedResult): void {
	const candidates = result.candidates;
	if (candidates.length === 0) return;

	// The background extraction may still be running. Applying now would let
	// the next batch write the result file again and revive applied entries.
	if (seedInFlight) {
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

	if (sub === "apply") {
		const result = readSeedResult();
		if (!result) {
			ctx.ui.notify("No pending seed result. Run /seed first.", "warning");
			return;
		}
		applySeedResult(ctx, result);
		return;
	}

	if (sub === "status") {
		const result = readSeedResult();
		if (!result) {
			ctx.ui.notify(
				seedInFlight
					? "Seed extraction is running in the background. Check /seed status again in a minute."
					: "No pending seed result.",
				"info",
			);
			return;
		}
		const preview = result.candidates
			.slice(0, 40)
			.map((c) => `#${c.category} ${c.text}`)
			.join("\n");
		ctx.ui.notify(
			`Seed ready: ${result.candidates.length} candidate(s) from ${result.scanned} prompts, ${result.skippedExisting} already known, target ${result.target} memory.\n${preview}\nRun /seed apply to write.`,
			"info",
		);
		return;
	}

	const yes = /(^|\s)--yes(\s|$)/.test(trimmed);
	const projectMatch = trimmed.match(/--project\s+(\S+)/);
	const daysMatch = trimmed.match(/(?:^|\s)(\d{1,4})d?(?:\s|$)/);
	const days = daysMatch ? Math.min(365, Math.max(1, Number(daysMatch[1]))) : SEED_DEFAULT_DAYS;
	const project = projectMatch?.[1];
	const toMatch = trimmed.match(/--to\s+(global|project)\b/i);
	const target: SeedTarget = toMatch ? (toMatch[1].toLowerCase() as SeedTarget) : "global";

	if (seedInFlight) {
		ctx.ui.notify("A seed run is already in progress. /seed status to check on it.", "info");
		return;
	}

	const messages = collectSeedMessages(days, project);
	if (messages.length === 0) {
		ctx.ui.notify(`No usable user prompts found in the last ${days} day(s) under ${sessionsRoot()}.`, "warning");
		return;
	}

	// Drop any stale result so a fresh run is never confused with an old one.
	try {
		fs.rmSync(seedResultFile(), { force: true });
		fs.rmSync(seedAppliedFile(), { force: true });
	} catch {
		// Nothing to remove.
	}

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

	seedInFlight = true;
	const destination = target === "project" ? projectMemoryFile(ctx.cwd) : MEMORY_FILE;
	ctx.ui.notify(
		`pi-memory /seed: mining ${messages.length} prompt(s) from the last ${days} day(s) across ${result.batches} background batch(es). This returns now; you will be notified when it finishes, then run /seed apply. Result will target ${target} memory (${destination}).`,
		"info",
	);

	// Deliberately not awaited: pi cancels or times out anything that outlives
	// the command request.
	void extractAllBatches(ctx, messages, result);
}

// ---------------------------------------------------------------------------
// Dreaming (fork addition)
//
// Anthropic's agent-memory write-up describes "dreaming": a background pass
// that revisits raw transcripts, corrects notes that no longer match the
// evidence, merges duplicates, and keeps a wiki in shape. This is the same
// idea, implemented conservatively: /dream gathers the raw material (long-term
// notes, daily logs, session transcripts), asks the model for a concrete list
// of edits, and writes nothing until the user applies the list.
// ---------------------------------------------------------------------------

const DREAM_DEFAULT_DAYS = 14;
const DREAM_MAX_ENTRIES = 40;
const DREAM_MAX_TRANSCRIPT_CHARS = 20_000;
const DREAM_MAX_DAILY_CHARS = 8_000;
const DREAM_MAX_PROMPTS_PER_SESSION = 6;
const DREAM_MAX_ANSWERS_PER_SESSION = 8;
const DREAM_MAX_ERRORS_PER_SESSION = 6;
/** How many exported session digests are kept on disk. */
const DREAM_MAX_TRANSCRIPT_FILES = 200;
/** How many audit reports are kept on disk. */
const AUDIT_MAX_REPORT_FILES = 20;

const DREAM_SYSTEM_PROMPT = [
	"You maintain the long-term memory of a coding agent.",
	"You receive the current long-term notes plus raw evidence: session transcripts and daily logs.",
	"Reply with ONLY a JSON array, no prose, no code fences.",
	'Each element is one of: {"action":"verify","key":"<key>","status":"verified|unverified|pending","evidence":"<why>"}',
	'{"action":"fix","key":"<key>","text":"<corrected note>"}',
	'{"action":"add","text":"<new durable note>","category":"preference|decision|convention|failure|insight"}',
	'{"action":"forget","key":"<key>","reason":"<why it is obsolete>"}',
	'{"action":"merge","key":"<oldKey>","into":"<newKey>"}',
	'{"action":"wiki","topic":"<slug>","body":"<markdown page>"}',
	"Rules:",
	"- Report a note as verified only when the evidence shows it.",
	"- Do not repeat a note that already exists.",
	"- Prefer fixing or forgetting an obsolete note over adding a second one.",
	"- Keep at most 3 wiki pages, one per topic.",
	"- Never invent facts that the evidence does not contain.",
	"If nothing needs to change, return [].",
].join("\n");

interface DreamEntry {
	key: string;
	text: string;
}

interface DreamAction {
	action: string;
	key?: string;
	text?: string;
	topic?: string;
	body?: string;
	status?: string;
	evidence?: string;
	reason?: string;
	category?: string;
	into?: string;
}

interface DreamResult {
	createdAt: string;
	days: number;
	entriesScanned: number;
	transcriptsScanned: number;
	actions: DreamAction[];
	notes: string[];
}

let dreamInFlight = false;

function dreamResultFile(): string {
	return path.join(AUDIT_DIR, "dream-result.json");
}

function readDreamResult(): DreamResult | null {
	const raw = readFileSafe(dreamResultFile());
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<DreamResult>;
		if (!parsed || !Array.isArray(parsed.actions)) return null;
		return parsed as DreamResult;
	} catch {
		return null;
	}
}

function writeDreamResult(result: DreamResult): void {
	fs.mkdirSync(AUDIT_DIR, { recursive: true });
	fs.writeFileSync(dreamResultFile(), `${JSON.stringify(result, null, 2)}\n`, "utf-8");
}

const DREAM_ERROR_MARKERS = /error|failed|failure|ENOENT|ECONNRESET|ETIMEDOUT|exception|not found|404|500/i;

/** Compact evidence from one session transcript: prompts, answers, failures. */
export function buildSessionDigest(raw: string): string {
	const lines: string[] = [];
	let prompts = 0;
	let answers = 0;
	let errors = 0;

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: {
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		const content = entry.message?.content;
		if (role === "user") {
			if (prompts >= DREAM_MAX_PROMPTS_PER_SESSION) continue;
			const text = extractUserText(content);
			if (!text) continue;
			// A line that carries a credential never reaches the digest file.
			if (looksLikeSecret(text)) continue;
			prompts++;
			lines.push(`user: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
		} else if (role === "assistant") {
			if (answers >= DREAM_MAX_ANSWERS_PER_SESSION) continue;
			const text = extractUserText(content);
			if (!text) continue;
			if (looksLikeSecret(text)) continue;
			answers++;
			lines.push(`assistant: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
		} else if (role === "toolResult") {
			if (errors >= DREAM_MAX_ERRORS_PER_SESSION) continue;
			const text = extractUserText(content);
			if (!text || !DREAM_ERROR_MARKERS.test(text)) continue;
			if (looksLikeSecret(text)) continue;
			errors++;
			lines.push(`error: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
		}
	}

	return lines.join("\n");
}

interface DreamTranscript {
	date: string;
	session: string;
	project: string;
	digest: string;
}

/** Session transcripts from the last `days` days, newest first. */
export function collectDreamTranscripts(days: number): DreamTranscript[] {
	const root = sessionsRoot();
	const cutoff = Date.now() - days * 86_400_000;
	const out: DreamTranscript[] = [];

	let projects: string[] = [];
	try {
		projects = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}

	for (const project of projects) {
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
			const digest = buildSessionDigest(raw);
			if (!digest.trim()) continue;
			out.push({ date: day, session: path.basename(file).replace(/\.jsonl$/, ""), project, digest });
		}
	}

	out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
	return out;
}

/** Long-term entries, keyed by the same hash the audit report shows. */
export function collectDreamEntries(): DreamEntry[] {
	const content = readFileSafe(MEMORY_FILE);
	if (!content?.trim()) return [];
	return splitAuditBlocks(content, "MEMORY.md")
		.filter((block) => block.body.trim().length > 0)
		.slice(0, DREAM_MAX_ENTRIES)
		.map((block) => ({
			key: block.key.slice(0, 8),
			text: block.body.replace(/\s+/g, " ").slice(0, 400),
		}));
}

/** Daily logs from the last `days` days, newest first. */
function collectDreamDaily(days: number): string {
	const parts: string[] = [];
	for (let i = 0; i < days; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const file = dailyPath(localDateStr(d));
		const content = readFileSafe(file);
		if (!content?.trim()) continue;
		parts.push(`### ${localDateStr(d)}\n${content.trim()}`);
	}
	const joined = parts.join("\n\n");
	return joined.length > DREAM_MAX_DAILY_CHARS ? joined.slice(0, DREAM_MAX_DAILY_CHARS) : joined;
}

function buildDreamPrompt(entries: DreamEntry[], transcripts: DreamTranscript[], daily: string): string {
	const entryLines = entries.map((e) => `[${e.key}] ${e.text}`).join("\n");
	const transcriptText = transcripts
		.map((t) => `### ${t.date} ${t.project} ${t.session}\n${t.digest}`)
		.join("\n\n")
		.slice(0, DREAM_MAX_TRANSCRIPT_CHARS);
	const dailyText = daily ? `\n\nDaily logs:\n${daily}` : "";
	return `Current long-term notes (key in brackets):\n${entryLines}\n\nSession evidence:\n${transcriptText}${dailyText}\n\nReturn the JSON array of edits.`;
}

const DREAM_CATEGORIES = new Set([
	"preference",
	"decision",
	"convention",
	"failure",
	"insight",
	"lesson",
	"issue",
	"project",
]);

function parseDreamActions(raw: string): DreamAction[] {
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1].trim();
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	try {
		const parsed = JSON.parse(text.slice(start, end + 1));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is DreamAction =>
				!!entry && typeof entry === "object" && typeof (entry as DreamAction).action === "string",
		);
	} catch {
		return [];
	}
}

async function runDreamModel(
	ctx: ExtensionCommandContext,
	entries: DreamEntry[],
	transcripts: DreamTranscript[],
	daily: string,
): Promise<{ actions: DreamAction[]; error?: string }> {
	const model = ctx.model;
	if (!model) return { actions: [], error: "No active model" };
	const apiKey = await resolveExitSummaryApiKey(ctx, model);
	if (!apiKey) return { actions: [], error: `API key resolution failed for ${model.provider}/${model.id}` };
	try {
		const response = await complete(
			model,
			{
				systemPrompt: DREAM_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: buildDreamPrompt(entries, transcripts, daily) }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey },
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return { actions: parseDreamActions(text) };
	} catch (err) {
		return { actions: [], error: err instanceof Error ? err.message : String(err) };
	}
}

/** Replace the block whose audit key matches, keeping the stamp comment. */
export function replaceBlockByKey(
	content: string,
	key: string,
	newText: string,
): { content: string; replaced: boolean } {
	const blocks = splitAuditBlocks(content, "MEMORY.md");
	const target = blocks.find((block) => block.key.startsWith(key));
	if (!target) return { content, replaced: false };
	const index = blocks.indexOf(target);
	const rebuilt = [
		...blocks.slice(0, index),
		{ ...target, body: newText, full: target.stamp ? `${target.stamp}\n${newText}` : newText },
		...blocks.slice(index + 1),
	];
	return { content: `${rebuilt.map((block) => block.full).join("\n\n")}\n`, replaced: true };
}

/** Merge a new body into a wiki page, keeping the existing content. */
export function mergeWikiPage(existing: string, body: string): string {
	if (!existing.trim()) return `${body.trim()}\n`;
	const base = existing.trim();
	const additions = body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !base.includes(line));
	if (additions.length === 0) return `${base}\n`;
	return `${base}\n\n${additions.join("\n")}\n`;
}

function slugifyTopic(topic: string): string {
	const slug =
		topic
			.toLowerCase()
			.replace(/[^a-z0-9一-龥]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "topic";
	// A name like "con" cannot be a file on Windows.
	return isReservedFileName(slug) ? `note-${slug}` : slug;
}

export interface DreamApplyReport {
	verified: number;
	fixed: number;
	added: number;
	forgotten: number;
	merged: number;
	wiki: number;
	skipped: string[];
}

export function applyDreamActions(ctx: ExtensionCommandContext, result: DreamResult): DreamApplyReport {
	// The whole read, change and write back runs under the lock, so a
	// concurrent session cannot write the same file in between.
	return withMemoryLock(() => applyDreamActionsLocked(ctx, result));
}

function applyDreamActionsLocked(ctx: ExtensionCommandContext, result: DreamResult): DreamApplyReport {
	const report: DreamApplyReport = {
		verified: 0,
		fixed: 0,
		added: 0,
		forgotten: 0,
		merged: 0,
		wiki: 0,
		skipped: [],
	};
	const ts = nowTimestamp();
	const sid = shortSessionId(ctx.sessionManager.getSessionId());
	let content = readFileSafe(MEMORY_FILE) ?? "";
	const verifiedState = { ...readVerifiedState() };
	// Nothing is written while the actions are processed. The wiki pages and
	// the recovery records are collected and written at the end, so a failure
	// in the middle cannot leave a half-applied state behind.
	const pendingWiki: { file: string; body: string }[] = [];
	const pendingRecovery: string[][] = [];

	for (const action of result.actions) {
		switch (action.action) {
			case "verify": {
				if (!action.key) break;
				const block = splitAuditBlocks(content, "MEMORY.md").find((b) => b.key.startsWith(action.key as string));
				if (!block) {
					report.skipped.push(`verify ${action.key}: entry not found`);
					break;
				}
				const status = (action.status ?? "pending").toLowerCase();
				verifiedState[block.key] = {
					status: status === "verified" ? "verified" : status === "unverified" ? "unverified" : "pending",
					evidence: action.evidence?.slice(0, 300),
					at: new Date().toISOString(),
				};
				report.verified++;
				break;
			}
			case "fix": {
				if (!action.key || !action.text?.trim()) break;
				if (looksLikeSecret(action.text)) {
					report.skipped.push(`fix ${action.key}: text carries a credential`);
					break;
				}
				const updated = replaceBlockByKey(content, action.key, action.text.trim());
				if (!updated.replaced) {
					report.skipped.push(`fix ${action.key}: entry not found`);
					break;
				}
				content = updated.content;
				report.fixed++;
				break;
			}
			case "add": {
				if (!action.text?.trim()) break;
				if (looksLikeSecret(action.text)) {
					report.skipped.push("add: text carries a credential");
					break;
				}
				const requested = (action.category ?? "insight").toLowerCase();
				const category = DREAM_CATEGORIES.has(requested) ? requested : "insight";
				const stamp = `<!-- ${ts} [${sid}] -->`;
				const separator = content.trim() ? "\n\n" : "";
				content = `${content.trimEnd()}${separator}${stamp}\n#${category} ${action.text.trim()}\n`;
				report.added++;
				break;
			}
			case "forget": {
				if (!action.key) break;
				const blocks = splitAuditBlocks(content, "MEMORY.md");
				const target = blocks.find((b) => b.key.startsWith(action.key as string));
				if (!target) {
					report.skipped.push(`forget ${action.key}: entry not found`);
					break;
				}
				const needle = target.body.split("\n")[0]?.trim();
				if (!needle) break;
				const removed = forgetBlocks(content, needle);
				if (removed.removed.length > 0) {
					content = removed.content;
					pendingRecovery.push(removed.removed);
					report.forgotten++;
				}
				break;
			}
			case "merge": {
				if (!action.key) break;
				const blocks = splitAuditBlocks(content, "MEMORY.md");
				const oldBlock = blocks.find((b) => b.key.startsWith(action.key as string));
				if (!oldBlock) {
					report.skipped.push(`merge ${action.key}: entry not found`);
					break;
				}
				const intoKey = action.into?.trim();
				if (!intoKey) {
					report.skipped.push(`merge ${action.key}: no target entry given`);
					break;
				}
				const intoBlock = blocks.find((b) => b.key.startsWith(intoKey));
				if (!intoBlock) {
					report.skipped.push(`merge ${action.key}: target entry ${intoKey} not found`);
					break;
				}
				if (intoBlock.key === oldBlock.key) {
					report.skipped.push(`merge ${action.key}: target is the same entry`);
					break;
				}
				// The old body moves into the target entry, then the old entry goes.
				const mergedBody = intoBlock.body.includes(oldBlock.body)
					? intoBlock.body
					: `${intoBlock.body}\n${oldBlock.body}`.trim();
				const rebuilt = blocks
					.filter((block) => block.key !== oldBlock.key)
					.map((block) =>
						block.key === intoBlock.key
							? {
									...block,
									body: mergedBody,
									full: block.stamp ? `${block.stamp}\n${mergedBody}` : mergedBody,
								}
							: block,
					);
				content = `${rebuilt.map((block) => block.full).join("\n\n")}\n`;
				pendingRecovery.push([oldBlock.full]);
				report.merged++;
				break;
			}
			case "wiki": {
				const topic = action.topic?.trim();
				if (!topic || !action.body?.trim()) break;
				if (looksLikeSecret(action.body)) {
					report.skipped.push(`wiki ${topic}: body carries a credential`);
					break;
				}
				if (action.body.trim().length > KNOWLEDGE_FILE_MAX_CHARS) {
					report.skipped.push(`wiki ${topic}: body is longer than ${KNOWLEDGE_FILE_MAX_CHARS} characters`);
					break;
				}
				fs.mkdirSync(WIKI_DIR, { recursive: true });
				const file = path.join(WIKI_DIR, `${slugifyTopic(topic)}.md`);
				const existing = readFileSafe(file) ?? "";
				pendingWiki.push({ file, body: mergeWikiPage(existing, action.body) });
				report.wiki++;
				break;
			}
			default:
				report.skipped.push(`unknown action ${action.action}`);
		}
	}

	if (content !== (readFileSafe(MEMORY_FILE) ?? "")) {
		fs.writeFileSync(MEMORY_FILE, content, "utf-8");
	}
	for (const page of pendingWiki) {
		fs.writeFileSync(page.file, page.body, "utf-8");
	}
	for (const removed of pendingRecovery) {
		writeRecoveryRecord("long_term", undefined, removed);
	}
	writeVerifiedState(verifiedState);
	return report;
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

/** Write the session digests so qmd can index the raw evidence. */
function exportTranscripts(transcripts: DreamTranscript[]): number {
	fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
	let written = 0;
	for (const t of transcripts) {
		// Second gate: a digest that still holds a credential is not written.
		if (looksLikeSecret(t.digest)) continue;
		const file = path.join(TRANSCRIPTS_DIR, `${t.date}-${t.session}.md`);
		const body = `# ${t.date} ${t.project} ${t.session}\n\n${t.digest}\n`;
		if (readFileSafe(file) === body) continue;
		fs.writeFileSync(file, body, "utf-8");
		written++;
	}
	// The digests are search evidence, not an archive. Old ones are dropped.
	pruneOldFiles(TRANSCRIPTS_DIR, "", DREAM_MAX_TRANSCRIPT_FILES);
	return written;
}

async function runDream(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	const sub = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";

	if (sub === "status") {
		const result = readDreamResult();
		if (!result) {
			ctx.ui.notify(
				dreamInFlight
					? "Dreaming is running in the background. Check /dream status again."
					: "No pending dream result.",
				"info",
			);
			return;
		}
		const preview = result.actions
			.slice(0, 30)
			.map((a) => `${a.action} ${a.key ?? a.topic ?? ""} ${(a.text ?? a.reason ?? a.evidence ?? "").slice(0, 90)}`)
			.join("\n");
		ctx.ui.notify(
			`Dream ready: ${result.actions.length} action(s) from ${result.entriesScanned} entries and ${result.transcriptsScanned} transcript(s).\n${preview}\nRun /dream apply to write them.`,
			"info",
		);
		return;
	}

	if (sub === "apply") {
		const result = readDreamResult();
		if (!result) {
			ctx.ui.notify("No pending dream result. Run /dream first.", "warning");
			return;
		}
		const report = applyDreamActions(ctx, result);
		try {
			fs.rmSync(dreamResultFile(), { force: true });
		} catch {
			// Nothing to remove.
		}
		snapshotDirty = true;
		void ensureQmdAvailableForUpdate()
			.then(() => scheduleQmdUpdate())
			.catch(() => {});
		ctx.ui.notify(
			`Dream applied: ${report.verified} verified, ${report.fixed} fixed, ${report.added} added, ${report.forgotten} forgotten, ${report.merged} merged, ${report.wiki} wiki page(s).${
				report.skipped.length ? ` Skipped: ${report.skipped.join("; ")}` : ""
			}`,
			"info",
		);
		return;
	}

	if (dreamInFlight) {
		ctx.ui.notify("A dream run is already in progress. /dream status to check on it.", "info");
		return;
	}

	const daysMatch = trimmed.match(/(?:^|\s)(\d{1,4})d?(?:\s|$)/);
	const days = daysMatch ? Math.min(365, Math.max(1, Number(daysMatch[1]))) : DREAM_DEFAULT_DAYS;

	if (dreamInFlight) {
		ctx.ui.notify("A dream run is already in progress. /dream status to check on it.", "info");
		return;
	}

	// Collecting the material reads every session file of the last days. That
	// takes longer than the command limit allows, so it runs detached, the
	// same way /seed does.
	dreamInFlight = true;
	ctx.ui.notify(
		`pi-memory /dream: collecting the last ${days} day(s) in the background. This returns now; you will be notified when the result is ready.`,
		"info",
	);

	void (async () => {
		try {
			const entries = collectDreamEntries();
			const transcripts = collectDreamTranscripts(days);
			const daily = collectDreamDaily(days);

			if (entries.length === 0 && transcripts.length === 0) {
				ctx.ui.notify(
					`Nothing to dream about: no long-term entries and no transcripts in the last ${days} day(s).`,
					"warning",
				);
				return;
			}

			// Export the digests first: they are the evidence the model checks
			// against, and they make the raw sessions searchable through qmd.
			const exported = exportTranscripts(transcripts);

			const { actions, error } = await runDreamModel(ctx, entries, transcripts, daily);
			const result: DreamResult = {
				createdAt: new Date().toISOString(),
				days,
				entriesScanned: entries.length,
				transcriptsScanned: transcripts.length,
				actions: actions ?? [],
				notes: exported > 0 ? [`${exported} transcript digest(s) exported to transcripts/`] : [],
			};
			if (error) result.notes.push(`model error: ${error}`);
			writeDreamResult(result);
			void ensureQmdAvailableForUpdate()
				.then(() => scheduleQmdUpdate())
				.catch(() => {});
			ctx.ui.notify(
				`Dream done: ${result.actions.length} action(s) from ${entries.length} entries and ${transcripts.length} transcript(s).\nRun /dream apply to write them, /dream status for all.`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(`Dream failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		} finally {
			dreamInFlight = false;
		}
	})();
}

// ---------------------------------------------------------------------------
// Correction capture (fork addition)
// ---------------------------------------------------------------------------

/**
 * A correction is the highest-value thing a user types and the one most likely
 * to be lost: the agent must notice it and call memory_write unprompted.
 * Detecting it in the raw prompt gives a second chance even when the model
 * ignores the nudge.
 *
 * Narrow on purpose. Matching "always" or "don't" alone fires on ordinary
 * instructions; these patterns need the phrasing of someone contradicting the
 * agent rather than describing a task.
 */
const CORRECTION_PATTERNS: RegExp[] = [
	/不对|不是这样|不对吧|错了|搞错了|别这样|不要这样|别再|重来|改用|应该是|我说过|我(?:之前|上次)说过|说过了/,
	/\bno\b,? (?:not|it's|that's|you)|as i (?:said|told|mentioned)|i (?:already )?(?:said|told) (?:you|that)|wrong\b[^.!?\n]*\b(?:you|agent)|\bnope\b|not what i (?:meant|asked)|instead of that/i,
];

const CORRECTION_MAX_CHARS = 400;

function captureCorrectionsEnabled(): boolean {
	const v = (process.env.PI_MEMORY_CAPTURE_CORRECTIONS ?? "on").toLowerCase();
	return v !== "off" && v !== "0" && v !== "false";
}

/** The sentence carrying the correction, or null when the prompt is not one. */
export function detectCorrection(prompt: string): string | null {
	if (!prompt || prompt.length > CORRECTION_MAX_CHARS) return null;
	if (prompt.includes("```")) return null;
	if (!CORRECTION_PATTERNS.some((re) => re.test(prompt))) return null;
	// Prefer the sentence that actually matched, so the captured line is the
	// correction rather than the surrounding request.
	const sentences = prompt.split(/(?<=[。！？.!?;；])\s*/).filter((s) => s.trim().length > 0);
	const matched = sentences.find((s) => CORRECTION_PATTERNS.some((re) => re.test(s)));
	const correction = (matched ?? prompt).replace(/\s+/g, " ").trim().slice(0, 300);
	// A correction that carries a credential is never captured: it would be
	// injected into the system prompt and asked to be written to memory.
	if (looksLikeSecret(correction)) return null;
	return correction;
}

/** Append a correction to today's log unless the same text is already there. */
export function recordCorrection(text: string, stamp: string, sessionId: string): boolean {
	if (looksLikeSecret(text)) return false;
	return withMemoryLock(() => {
		const filePath = dailyPath(todayStr());
		const existing = readFileSafe(filePath) ?? "";
		const probe = text.replace(/\s+/g, " ").toLowerCase();
		// Ignore blanks and short lines: "".includes(anything) is true, and the
		// stamp comment is too short to be evidence of a duplicate.
		const alreadyPresent = existing
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length >= 8)
			.some((line) => {
				const candidate = line.toLowerCase();
				return candidate.includes(probe) || probe.includes(candidate);
			});
		if (alreadyPresent) return false;
		appendStamped(filePath, `#correction ${text}`, stamp, sessionId);
		return true;
	});
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

// --- report ----------------------------------------------------------------

interface AuditRow {
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

	const totalChars = ledger.injectedChars;
	const avgChars = ledger.injections > 0 ? Math.round(totalChars / ledger.injections) : 0;
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
	lines.push(
		`- Average injected per snapshot: **${avgChars} chars (~${Math.round(avgChars / AUDIT_CHARS_PER_TOKEN)} tokens)**`,
	);
	lines.push(
		`- Lifetime injected: **${totalChars} chars (~${Math.round(totalChars / AUDIT_CHARS_PER_TOKEN)} tokens)**`,
	);
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
		`${stale.length} 条指向已删除文件，平均每次注入 ${avgChars} 字符` +
		`(~${Math.round(avgChars / AUDIT_CHARS_PER_TOKEN)} tokens)`;

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

// ---------------------------------------------------------------------------
// QMD integration
// ---------------------------------------------------------------------------

type ExecFileFn = typeof execFile;

function isQmdCommand(file: string | URL): boolean {
	if (typeof file !== "string") return false;
	const basename = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "qmd" || basename === "qmd.cmd" || basename === "qmd.exe";
}

const QMD_JS_REL = path.join("node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
/** Same entry, relative to an npm module root (a directory named node_modules). */
const QMD_JS_PKG_REL = path.join("@tobilu", "qmd", "dist", "cli", "qmd.js");

let cachedQmdJsPath: string | null | undefined;

// On Windows, cmd-shim writes the literal `/bin/sh` (the package's shebang
// interpreter) into both qmd.cmd and qmd.ps1, so both shims fail with
// "system cannot find the path specified" / "'/bin/sh.exe' is not recognized"
// outside cygwin/git-bash trees. Bypass the shims by locating qmd's JS entry
// in a sibling node_modules directory of a PATH entry and invoking it with
// node directly — the same thing the sh script in bin/qmd does when launched
// via npm.
export function resolveQmdJsPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (cachedQmdJsPath !== undefined) return cachedQmdJsPath;
	const pathStr = env.PATH ?? env.Path ?? "";
	const entries = pathStr.split(path.delimiter).filter(Boolean);
	const candidates: string[] = [];
	for (const dir of entries) candidates.push(path.join(dir, QMD_JS_REL));
	// Windows: npm's global bin directory is often NOT on PATH for GUI apps
	// (the Paseo daemon inherits the PATH from the login shell, not from the
	// shell that ran `npm i -g`). Look the package up under the known global
	// prefixes so the search layer works without a PATH change.
	for (const root of npmGlobalRoots(env)) candidates.push(path.join(root, QMD_JS_PKG_REL));
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) {
				cachedQmdJsPath = candidate;
				return candidate;
			}
		} catch {
			// keep scanning
		}
	}
	cachedQmdJsPath = null;
	return null;
}

/** Known npm global module roots, in priority order. */
export function npmGlobalRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const roots: string[] = [];
	const push = (value: string | undefined) => {
		if (!value) return;
		const normalized = value.replace(/[\\/]+$/, "");
		const candidate = path.join(normalized, "node_modules");
		if (!roots.includes(candidate)) roots.push(candidate);
	};
	push(env.npm_config_prefix);
	push(env.APPDATA ? path.join(env.APPDATA, "npm") : undefined);
	push(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "npm") : undefined);
	push(env.HOME ? path.join(env.HOME, ".npm-global") : undefined);
	return roots;
}

/** Clear the resolved qmd.js cache (for testing). */
export function _resetQmdJsResolutionForTest() {
	cachedQmdJsPath = undefined;
}

export function buildQmdSpawn(
	file: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
	qmdJsPath: string | null = null,
): { file: string; args: string[] } {
	if (platform !== "win32" || !isQmdCommand(file) || !qmdJsPath) {
		return { file, args: [...args] };
	}
	return { file: "node", args: [qmdJsPath, ...args] };
}

export function buildQmdEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const qmdEnv: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };
	delete qmdEnv.FORCE_COLOR;
	// qmd keeps an embedding pool resident in VRAM and reserves room for the
	// reranker next to it. On a 2 GB card the pool leaves too little for the
	// reranker, and `qmd query` dies with a Vulkan allocation error. One embed
	// slot is enough for a memory corpus this size.
	if (!qmdEnv.QMD_EMBED_PARALLELISM) qmdEnv.QMD_EMBED_PARALLELISM = "1";
	return qmdEnv;
}

const execFileWithQmdOptions: ExecFileFn = ((
	file: string,
	args: readonly string[],
	options: ExecFileOptions,
	callback: (...args: any[]) => void,
) => {
	const qmdJs = process.platform === "win32" && isQmdCommand(file) ? resolveQmdJsPath() : null;
	const spawn = buildQmdSpawn(file, args ?? [], process.platform, qmdJs);
	const execOptions = isQmdCommand(file) ? { ...options, env: buildQmdEnv(options.env ?? process.env) } : options;
	return execFile(spawn.file, spawn.args, execOptions, callback as any);
}) as ExecFileFn;

let execFileFn: ExecFileFn = execFileWithQmdOptions;

let qmdAvailable = false;
let qmdAvailabilityCheckedAt = 0;
// Positive results are stable for the session; negative results should refresh
// quickly so users who install qmd (or run setupQmdCollection) mid-session
// don't have to wait through a long TTL before retries succeed.
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5 * 1000;
const DEFAULT_QMD_SEARCH_TIMEOUT_MS = 60_000;
const DEFAULT_EMBED_PROBE_TIMEOUT_MS = 15_000;
const qmdCollectionStatusCache = new Map<string, { checkedAt: number; exists: boolean }>();

function qmdStatusTtl(positive: boolean): number {
	return positive ? QMD_STATUS_CACHE_TTL_MS : QMD_STATUS_NEGATIVE_CACHE_TTL_MS;
}

export function getQmdSearchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_QMD_SEARCH_TIMEOUT_MS;
}

export function getEmbedProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_MEMORY_EMBED_PROBE_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_EMBED_PROBE_TIMEOUT_MS;
}
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let exitSummaryReason: ExitSummaryReason | null = null;
let terminalInputUnsubscribe: (() => void) | null = null;

/** Override execFile implementation (for testing). */
export function _setExecFileForTest(fn: ExecFileFn) {
	execFileFn = fn;
}

/** Reset execFile implementation (for testing). */
export function _resetExecFileForTest() {
	execFileFn = execFileWithQmdOptions;
}

/** Set qmd availability flag (for testing). */
export function _setQmdAvailable(value: boolean) {
	qmdAvailable = value;
	qmdAvailabilityCheckedAt = Date.now();
}

/** Get current qmd availability flag (for testing). */
export function _getQmdAvailable(): boolean {
	return qmdAvailable;
}

/** Get current update timer (for testing). */
export function _getUpdateTimer(): ReturnType<typeof setTimeout> | null {
	return updateTimer;
}

/** Clear the update timer (for testing). */
export function _clearUpdateTimer() {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}
}

/** Clear qmd status caches (for testing). */
export function _clearQmdStatusCaches() {
	qmdAvailabilityCheckedAt = 0;
	qmdCollectionStatusCache.clear();
}

const QMD_REPO_URL = "https://github.com/tobi/qmd";

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd.",
		"",
		"Install qmd (either works):",
		"  npm install -g @tobilu/qmd        # no Bun needed",
		`  bun install -g ${QMD_REPO_URL}   # ensure ~/.bun/bin is on PATH`,
		"",
		"The extension auto-creates the collection on next session start.",
		"To set it up manually instead:",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions(): string {
	return [
		"qmd collection pi-memory is not configured.",
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

/** Auto-create the pi-memory collection and path contexts in qmd. */
/**
 * The qmd collection this extension searches.
 *
 * The default keeps the upstream name, so an existing setup keeps working.
 * A fork that is installed next to the upstream extension needs its own
 * collection, otherwise both read the same index.
 */
export function qmdCollectionName(env: NodeJS.ProcessEnv = process.env): string {
	return (env.PI_MEMORY_QMD_COLLECTION ?? "pi-memory").trim() || "pi-memory";
}

export async function setupQmdCollection(): Promise<boolean> {
	const collection = qmdCollectionName();
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn("qmd", ["collection", "add", MEMORY_DIR, "--name", collection], { timeout: 10_000 }, (err) =>
				err ? reject(err) : resolve(),
			);
		});
	} catch {
		// The collection usually exists already, and "collection add" fails on
		// the second run. That is not fatal: the contexts below still have to be
		// registered, so the flow continues instead of returning early.
	}

	// Contexts must use the virtual path form. A plain filesystem path is
	// rejected unless it points at an indexed *document*, so "/daily" never
	// registers and the daily logs end up without a description.
	const contexts: [string, string][] = [
		[`qmd://${collection}/daily`, "Daily append-only work logs organized by date"],
		[`qmd://${collection}/`, "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFileFn("qmd", ["context", "add", ctxPath, desc], { timeout: 10_000 }, (err) =>
					err ? reject(err) : resolve(),
				);
			});
		} catch {
			// Ignore — context may already exist
		}
	}
	// Seed the cache so checkCollection(qmdCollectionName()) doesn't redundantly re-run
	// setupQmdCollection during the short negative-cache window.
	qmdCollectionStatusCache.set(collection, { checkedAt: Date.now(), exists: true });
	return true;
}

export function detectQmd(): Promise<boolean> {
	const now = Date.now();
	if (qmdAvailabilityCheckedAt && now - qmdAvailabilityCheckedAt < qmdStatusTtl(qmdAvailable)) {
		return Promise.resolve(qmdAvailable);
	}

	return new Promise((resolve) => {
		// `qmd status` can trigger slow model/device probing on some systems (e.g. Vulkan fallback),
		// which may exceed short startup timeouts and produce false negatives.
		// `qmd collection list` is much lighter and still validates the binary is callable.
		execFileFn("qmd", ["collection", "list"], { timeout: 15_000 }, (err) => {
			qmdAvailable = !err;
			qmdAvailabilityCheckedAt = Date.now();
			resolve(qmdAvailable);
		});
	});
}

export function checkCollection(name: string): Promise<boolean> {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve(cached.exists);
	}

	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000 }, (err, stdout) => {
			let exists = false;
			if (!err) {
				try {
					const collections = JSON.parse(stdout);
					if (Array.isArray(collections)) {
						exists = collections.some((entry) => {
							if (typeof entry === "string") return entry === name;
							if (entry && typeof entry === "object" && "name" in entry) {
								return (entry as { name?: string }).name === name;
							}
							return false;
						});
					} else {
						// qmd may output an object with a collections array or similar
						exists = stdout.includes(name);
					}
				} catch {
					// Fallback: just check if the name appears in the output
					exists = stdout.includes(name);
				}
			}
			qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists });
			resolve(exists);
		});
	});
}

// `qmd embed` is incremental: it only embeds new/changed chunks and no-ops in
// well under a second when everything is current. The first run ever may
// download the embedding model, hence the generous timeout.
const QMD_EMBED_TIMEOUT_MS = 10 * 60 * 1000;
let embedInFlight = false;
let embedPending = false;

/**
 * Ensure a background `qmd embed` is running so semantic/deep search stays
 * usable without the user ever running it manually. Returns true if an embed
 * is now running (started here or already in flight), false if embedding is
 * unavailable (qmd missing or background updates disabled).
 *
 * If an embed is already running, the request is queued: another embed runs
 * immediately after the current one finishes, so chunks written while the
 * first embed was already underway don't have to wait for the next session.
 */
export function ensureQmdEmbed(): boolean {
	if (getQmdUpdateMode() !== "background") return false;
	if (!qmdAvailable) return false;
	if (embedInFlight) {
		embedPending = true;
		return true;
	}
	embedInFlight = true;
	execFileFn("qmd", ["embed"], { timeout: QMD_EMBED_TIMEOUT_MS }, () => {
		embedInFlight = false;
		if (embedPending) {
			embedPending = false;
			ensureQmdEmbed();
		}
	});
	return true;
}

/** Get/clear the embed-in-flight flag (for testing). */
export function _getEmbedInFlight(): boolean {
	return embedInFlight;
}
export function _clearEmbedInFlight() {
	embedInFlight = false;
	embedPending = false;
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => ensureQmdEmbed());
	}, 500);
}

async function runQmdUpdateNow() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	await new Promise<void>((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => resolve());
	});
	// Embeds for the final writes are picked up by the session_start catch-up
	// embed; not chained here so shutdown stays fast.
}

/** Search for memories relevant to the user's prompt. Returns formatted markdown or empty string on error. */
export async function searchRelevantMemories(prompt: string): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";

	// Sanitize: strip control chars, limit to 200 chars for the search query
	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: we intentionally strip control chars.
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const hasCollection = await checkCollection(qmdCollectionName());
		if (!hasCollection) return "";

		const results = await Promise.race([
			runQmdSearch("keyword", sanitized, 3),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 3_000);
			}),
		]);

		if (!results || results.results.length === 0) return "";

		const snippets = results.results
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text.trim()}` : text.trim();
			})
			.filter(Boolean);

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

// The limit reaches `qmd -n` as a CLI argument; NaN/0/negative/huge values
// from a confused model would produce broken qmd invocations.
export function clampSearchLimit(value: number | undefined, fallback = 5, max = 25): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

export interface QmdSearchResult {
	path?: string;
	file?: string;
	score?: number;
	content?: string;
	chunk?: string;
	snippet?: string;
	title?: string;
	[key: string]: unknown;
}

function getQmdResultPath(r: QmdSearchResult): string | undefined {
	return r.path ?? r.file;
}

function getQmdResultText(r: QmdSearchResult): string {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

function stripAnsi(text: string): string {
	// qmd may emit spinners/progress bars even with --json, especially on first model download.
	// Strip ANSI CSI/OSC sequences so we can reliably find and parse JSON payloads.
	// CSI parameter bytes include private-mode sequences such as ESC[?25l / ESC[?25h.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	if (trimmed === "No results found." || trimmed === "No results found") return [];

	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) {
		throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	}

	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
	timeoutOverrideMs?: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", qmdCollectionName(), "-n", String(limit), query];
	const timeoutMs = timeoutOverrideMs ?? getQmdSearchTimeoutMs();

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				const cleaned = stripAnsi(stderr ?? "").trim();
				const cleanedMessage = stripAnsi(err.message).trim();
				const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
				const hint = timedOut
					? ` (qmd timed out after ${timeoutMs / 1000}s — first semantic/deep search may download or load models; retry shortly)`
					: "";
				reject(new Error(`${cleaned || cleanedMessage}${hint}`));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed) ? parsed : ((parsed as any).results ?? (parsed as any).hits ?? []);
				resolve({ results, stderr: stderr ?? "" });
			} catch (parseErr) {
				if (parseErr instanceof Error) {
					reject(parseErr);
					return;
				}
				reject(new Error(`Failed to parse qmd output: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

/**
 * Best-effort check of whether vector embeddings are ready for semantic/deep
 * search. Bounded by a timeout because the first semantic query can trigger a
 * model download. Returns "unknown" rather than blocking on it.
 * "ready" means a probe query ran without qmd's "need embeddings" warning —
 * it does not prove the index has content.
 *
 * The bound must stay well clear of normal `qmd vsearch` latency: the probe
 * runs an embed + rerank pass (measured ~2.4-3.6s idle, >4s while a background
 * re-index competes for CPU and the embedding model). A tighter bound made
 * `memory_status` report "unknown" immediately after a write, which is exactly
 * when the index is busy. Override with PI_MEMORY_EMBED_PROBE_TIMEOUT_MS.
 */
export async function probeEmbeddings(): Promise<"ready" | "missing" | "unknown"> {
	const probeTimeoutMs = getEmbedProbeTimeoutMs();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { stderr } = await Promise.race([
			// Bound the child by the same budget so a probe we abandon does not
			// leave a long-running LLM query behind.
			runQmdSearch("semantic", "memory", 1, probeTimeoutMs),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), probeTimeoutMs);
			}),
		]);
		return /need embeddings/i.test(stderr ?? "") ? "missing" : "ready";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/need embeddings/i.test(msg)) return "missing";
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

/** Collect a fast on-disk inventory of the memory files (no qmd needed). */
export function getMemoryInventory(): {
	dir: string;
	longTermChars: number;
	scratchpadOpen: number;
	scratchpadTotal: number;
	dailyCount: number;
	latestDaily: string | null;
} {
	const longTerm = readFileSafe(MEMORY_FILE) ?? "";
	const scratchpad = readFileSafe(SCRATCHPAD_FILE) ?? "";
	const items = parseScratchpad(scratchpad);
	let dailyFiles: string[] = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}
	return {
		dir: MEMORY_DIR,
		longTermChars: longTerm.trim().length,
		scratchpadOpen: items.filter((i) => !i.done).length,
		scratchpadTotal: items.length,
		dailyCount: dailyFiles.length,
		latestDaily: dailyFiles.length ? dailyFiles[dailyFiles.length - 1].replace(/\.md$/, "") : null,
	};
}

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
let snapshotDirty = false;
function refreshMemorySnapshot(reason: string) {
	const projectSection = projectMemorySection(projectCwd);
	const reserve = projectSection ? projectSection.length + PROJECT_MEMORY_SEPARATOR_CHARS : 0;
	memorySnapshot = postProcessContext(buildMemoryContext("", reserve), projectCwd, projectSection);
	snapshotTakenAt = nowTimestamp();
	snapshotTakenOnDate = todayStr();
	snapshotReason = reason;
	snapshotDirty = false;
}

function getSnapshotMode(): "stable" | "refresh" | "per-turn" {
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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
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

		qmdAvailable = await detectQmd();
		if (!qmdAvailable) {
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
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = null;
			}
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
			if (updateTimer) {
				clearTimeout(updateTimer);
				updateTimer = null;
			}
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
	pi.on("before_agent_start", async (event, ctx) => {
		// Capture corrections before the model has any chance to forget them.
		const correction = captureCorrectionsEnabled() ? detectCorrection(event.prompt ?? "") : null;
		if (correction) {
			try {
				if (recordCorrection(correction, nowTimestamp(), shortSessionId(ctx.sessionManager.getSessionId()))) {
					await ensureQmdAvailableForUpdate();
					scheduleQmdUpdate();
				}
			} catch {
				// Capture is a bonus. Never let it break the turn.
			}
		}

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

		if (!memoryContext && !correction) return;

		const headerLines: string[] = [];

		if (correction) {
			headerLines.push(
				"",
				"## Correction captured",
				"",
				`The user's last message corrects a prior assumption: "${correction}".`,
				"It was appended to today's daily log with #correction.",
				"If it establishes a durable rule, write it to memory now with memory_write.",
			);
		}

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
	pi.registerCommand("dream", {
		description:
			"Consolidate memory against raw session transcripts: verify notes, fix wrong ones, merge duplicates, build wiki pages (runs in the background). Usage: /dream [days] | /dream apply | /dream status",
		handler: async (args, ctx) => {
			await runDream(args ?? "", ctx);
		},
	});

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
				snapshotDirty = true;

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
			snapshotDirty = true;

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

	// --- memory_search tool ---
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs).\n" +
			"Modes:\n" +
			"- 'keyword' (default, ~30ms): Fast BM25 search. Best for specific terms, dates, names, #tags, [[links]].\n" +
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts even with different wording.\n" +
			"- 'deep' (~10s): Hybrid search with reranking. Use when other modes don't find what you need.\n" +
			"If semantic/deep warns about missing embeddings, embedding starts automatically in the background — retry shortly.\n" +
			"If the first search doesn't find what you need, try rephrasing or switching modes. " +
			"Keyword mode is best for specific terms; semantic mode finds related concepts even with different wording.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			mode: Type.Optional(
				StringEnum(["keyword", "semantic", "deep"] as const, {
					description: "Search mode. Default: 'keyword'.",
				}),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!qmdAvailable) {
				// Re-check on demand in case qmd was installed after session start.
				qmdAvailable = await detectQmd();
			}

			if (!qmdAvailable) {
				return {
					content: [
						{
							type: "text",
							text: qmdInstallInstructions(),
						},
					],
					isError: true,
					details: {},
				};
			}

			let hasCollection = await checkCollection(qmdCollectionName());
			if (!hasCollection) {
				const created = await setupQmdCollection();
				if (created) {
					hasCollection = true;
				}
			}
			if (!hasCollection) {
				return {
					content: [
						{
							type: "text",
							text: "Could not set up qmd pi-memory collection. Check that qmd is working and the memory directory exists.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const mode = params.mode ?? "keyword";
			const limit = clampSearchLimit(params.limit);

			try {
				const { results, stderr } = await runQmdSearch(mode, params.query, limit);
				const needsEmbed = /need embeddings/i.test(stderr ?? "");
				// Self-heal: any "need embeddings" warning (even with partial
				// results) kicks off an incremental background embed.
				const embedStarted = needsEmbed ? ensureQmdEmbed() : false;

				if (results.length === 0) {
					if (needsEmbed && (mode === "semantic" || mode === "deep")) {
						return {
							content: [
								{
									type: "text",
									text: [
										`No results found for "${params.query}" (mode: ${mode}).`,
										"",
										"qmd reports missing vector embeddings for one or more documents.",
										...(embedStarted
											? [
													"Embedding has been started in the background — retry the search shortly.",
													"(The very first embed may take longer while the embedding model downloads.)",
												]
											: ["Run this once, then retry:", "  qmd embed"]),
									].join("\n"),
								},
							],
							details: { mode, query: params.query, count: 0, needsEmbed: true, embedStarted },
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `No results found for "${params.query}" (mode: ${mode}).`,
							},
						],
						details: { mode, query: params.query, count: 0, needsEmbed },
					};
				}

				const formatted = results
					.map((r, i) => {
						const parts: string[] = [`### Result ${i + 1}`];
						const filePath = getQmdResultPath(r);
						if (filePath) parts.push(`**File:** ${filePath}`);
						if (r.score != null) parts.push(`**Score:** ${r.score}`);
						const text = getQmdResultText(r);
						if (text) parts.push(`\n${text}`);
						return parts.join("\n");
					})
					.join("\n\n---\n\n");

				return {
					content: [{ type: "text", text: formatted }],
					details: { mode, query: params.query, count: results.length, needsEmbed },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `memory_search error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	// --- memory_status tool (doctor) ---
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
