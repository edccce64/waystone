/**
 * Memory core: paths, files, locks, sidecars, verification, injection assembly.
 *
 * Split out of the single-file extension; import order below is the only
 * dependency order: memory-core <- search <- maintenance <- commands.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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

export let MEMORY_DIR = resolveMemoryDir();
export let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
export let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
export let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");
export let AUDIT_DIR = path.join(MEMORY_DIR, ".audit");
export let WIKI_DIR = path.join(MEMORY_DIR, "wiki");
export let TOPICS_DIR = path.join(MEMORY_DIR, "topics");
export let TRANSCRIPTS_DIR = path.join(MEMORY_DIR, "transcripts");

/** Override base directory (for testing). */
/**
 * Reset that the layers above have to run when the base directory changes.
 * Paths are owned here, so the hook keeps the dependency pointing one way.
 */
let baseDirResetHook: (() => void) | null = null;

/** Register the cache reset a base-dir change has to run. */
export function _onBaseDirChange(hook: () => void): void {
	baseDirResetHook = hook;
}

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
	baseDirResetHook?.();
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

export function localDateStr(d: Date): string {
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

export const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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

export const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
export const RESPONSE_PREVIEW_MAX_LINES = 120;

const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_SEARCH_MAX_CHARS = 2_500;
const CONTEXT_SEARCH_MAX_LINES = 80;
export const CONTEXT_MAX_CHARS = 16_000;

/** Navigation layer: one line per wiki page and topic note. Bodies stay on disk. */
const CONTEXT_KNOWLEDGE_MAX_CHARS = 2_000;
const CONTEXT_KNOWLEDGE_MAX_LINES = 60;

/** Project-tier memory is injected ahead of the global tier, so it gets a smaller budget. */
export const PROJECT_MEMORY_MAX_CHARS = 3_000;
/** Room for the separator that joins the project section to the context. */
export const PROJECT_MEMORY_SEPARATOR_CHARS = 12;
/** A wiki page or topic note never grows past this. */
export const KNOWLEDGE_FILE_MAX_CHARS = 20_000;

export const EXIT_SUMMARY_MAX_CHARS = 80_000;
export const EXIT_SUMMARY_MIN_MESSAGES = 4;
export const EXIT_SUMMARY_SYSTEM_PROMPT = [
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

export function truncateText(text: string, maxChars: number, mode: TruncateMode) {
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

export function buildPreview(
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

export function formatPreviewBlock(label: string, content: string, mode: TruncateMode) {
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
export const MEMORY_ENTRY_META_COMMENT_REGEX =
	/^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MemoryTarget = "long_term" | "daily";

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

export function recoveryPath(recoveryId: string): string | null {
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

export function writeRecoveryRecord(
	target: MemoryTarget,
	date: string | undefined,
	removedContent: string[],
): RecoveryRecord {
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

export function readRecoveryRecord(recoveryId: string): { record: RecoveryRecord; filePath: string } | null {
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

/** Shape check only: the sidecar is a map of key -> record. */
function asVerifiedMap(value: unknown): Record<string, VerifiedRecord> | null {
	if (!value || typeof value !== "object") return null;
	return value as Record<string, VerifiedRecord>;
}

export function readVerifiedState(): Record<string, VerifiedRecord> {
	const file = verifiedStateFile();
	// The sidecar is read on every injection, so the parsed copy is kept and
	// refreshed when the file changes.
	const mtime = fileMtime(file);
	if (verifiedStateCache && verifiedStateCacheMtime === mtime) return verifiedStateCache;
	verifiedStateCacheMtime = mtime;
	verifiedStateCache = readJsonSidecar(file, asVerifiedMap) ?? {};
	return verifiedStateCache;
}

export function writeVerifiedState(state: Record<string, VerifiedRecord>): void {
	writeJsonSidecar(verifiedStateFile(), state);
	verifiedStateCache = state;
	verifiedStateCacheMtime = fileMtime(verifiedStateFile());
}

/** Drop the cached sidecar, so the next read comes from disk. */
export function _resetVerifiedState(): void {
	verifiedStateCache = null;
	verifiedStateCacheMtime = -1;
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
export function pathsEqual(a: string, b: string): boolean {
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
 * Read a JSON sidecar.
 *
 * Every sidecar is derived state that can be rebuilt, so a missing, unparsable
 * or malformed file reads as null instead of throwing. `parse` returns the
 * value shaped for its caller, or null when the shape is not trustworthy.
 */
export function readJsonSidecar<T>(file: string, parse: (value: unknown) => T | null): T | null {
	const raw = readFileSafe(file);
	if (!raw) return null;
	try {
		return parse(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

/** Write a JSON sidecar atomically. Every sidecar write goes through here. */
export function writeJsonSidecar(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeJsonAtomic(file, value);
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
// Shared audit primitives (fork addition)
//
// The audit layer, the seed pipeline and correction capture key entries by a
// hash of their own text, split a file into the same units, and refuse to
// handle a credential. The primitives live here, below all of them.
// ---------------------------------------------------------------------------

export interface AuditBlock {
	key: string;
	src: string;
	body: string;
	full: string;
	stamp: string | null;
}

export function auditKey(text: string): string {
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

export function appendStamped(filePath: string, content: string, stamp: string, sessionId: string): void {
	withMemoryLock(() => {
		const existing = readFileSafe(filePath) ?? "";
		const separator = existing.trim() ? "\n\n" : "";
		fs.writeFileSync(filePath, `${existing}${separator}<!-- ${stamp} [${sessionId}] -->\n${content}\n`, "utf-8");
	});
}

/** Timestamp of a file, or -1 when it does not exist. */
export function fileMtime(file: string): number {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return -1;
	}
}
