/**
 * Search: qmd discovery, collection setup, retrieval, and the status probe.
 *
 * Split out of the single-file extension; import order below is the only
 * dependency order: memory-core <- search <- maintenance <- commands.
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DAILY_DIR, MEMORY_DIR, MEMORY_FILE, parseScratchpad, readFileSafe, SCRATCHPAD_FILE } from "./memory-core.js";

export function getQmdUpdateMode(): "background" | "manual" | "off" {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

export async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

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

export let qmdAvailable = false;
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
export let updateTimer: ReturnType<typeof setTimeout> | null = null;

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
	cancelQmdUpdate();
}

/** Drop a pending index refresh. */
export function cancelQmdUpdate(): void {
	if (!updateTimer) return;
	clearTimeout(updateTimer);
	updateTimer = null;
}

/** Detect qmd once for this session and remember the answer. */
export async function detectQmdForSession(): Promise<boolean> {
	qmdAvailable = await detectQmd();
	return qmdAvailable;
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

export async function runQmdUpdateNow() {
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

/** memory_search and memory_status. */
export function registerSearchTools(pi: ExtensionAPI) {
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
}
