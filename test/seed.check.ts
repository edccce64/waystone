/**
 * Verification for the seed, supersede and correction-capture additions.
 *
 * Run with: npx tsx test/seed.check.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-seed-"));
const memoryDir = path.join(tmpRoot, "memory");
const sessionsDir = path.join(tmpRoot, "sessions");

process.env.PI_MEMORY_DIR = memoryDir;
process.env.PI_MEMORY_LEDGER = "on";
process.env.PI_MEMORY_STALE_CHECK = "off";
process.env.PI_MEMORY_CAPTURE_CORRECTIONS = "on";

fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
fs.mkdirSync(path.join(memoryDir, "recovery"), { recursive: true });
fs.mkdirSync(path.join(sessionsDir, "--proj-alpha--"), { recursive: true });

// Two sessions: one recent, one far in the past. Date comes from the filename.
const recentDay = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const oldDay = "2020-01-05";
function sessionFile(day: string, userTexts: string[]) {
	const lines: string[] = [
		JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: `${day}T10:00:00.000Z`, cwd: "/proj" }),
	];
	for (const [i, text] of userTexts.entries()) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				parentId: null,
				timestamp: `${day}T10:0${i}:00.000Z`,
				message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
			}),
		);
	}
	lines.push(
		JSON.stringify({ type: "custom", id: "c1", parentId: null, timestamp: `${day}T11:00:00.000Z`, customType: "x" }),
	);
	return lines.join("\n");
}

fs.writeFileSync(
	path.join(sessionsDir, "--proj-alpha--", `${recentDay}T10-00-00-000Z_aaaa-bbbb.jsonl`),
	sessionFile(recentDay, [
		"我以后都用 pnpm，别用 npm",
		"ok thanks",
		"/compact",
		"短",
		"重复的句子：帮我看下这个 bug",
		"重复的句子：帮我看下这个 bug",
		"a".repeat(900),
	]),
);
fs.writeFileSync(
	path.join(sessionsDir, "--proj-alpha--", `${oldDay}T10-00-00-000Z_cccc-dddd.jsonl`),
	sessionFile(oldDay, ["很久以前的偏好，应该被时间过滤掉"]),
);

const mod = await import("../index.ts");
const {
	_setBaseDir,
	_resetAuditState,
	_resetSupersedes,
	collectSeedMessages,
	looksLikeSecret,
	detectCorrection,
	recordCorrection,
	todayStr,
	filterSuperseded,
	findConflictCandidates,
	buildAuditReport,
	collectAuditRows,
	auditContext,
	buildMemoryContext,
	flushAuditLedger,
	resetAuditLedger,
} = mod as typeof import("../index.ts");

_setBaseDir(memoryDir);
_resetSupersedes();

let passed = 0;
function check(name: string, fn: () => void) {
	fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

// --- 1. seed collection ----------------------------------------------------

check("collects only durable-looking recent user prompts", () => {
	const messages = collectSeedMessages(30);
	const texts = messages.map((m) => m.text);
	assert.ok(texts.includes("我以后都用 pnpm，别用 npm"), "keeps a real preference");
	assert.ok(!texts.includes("ok thanks"), "text is long enough to keep, but only if not filtered");
	assert.ok(!texts.includes("/compact"), "slash commands are not memory");
	assert.ok(!texts.includes("短"), "too short to be durable");
	assert.ok(!texts.some((t) => t.length > 600), "oversized pastes dropped");
	assert.ok(!texts.includes("很久以前的偏好，应该被时间过滤掉"), "outside the day window");
});

check("deduplicates repeated prompts", () => {
	const messages = collectSeedMessages(30);
	const texts = messages.map((m) => m.text);
	assert.equal(texts.filter((t) => t === "重复的句子：帮我看下这个 bug").length, 1);
});

check("filters by project substring", () => {
	assert.equal(collectSeedMessages(30, "nonexistent").length, 0);
	assert.ok(collectSeedMessages(30, "alpha").length > 0);
});

check("returns newest first", () => {
	const messages = collectSeedMessages(30);
	const times = messages.map((m) => Date.parse(m.at));
	for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], "descending order");
});

// --- 2. secret gate --------------------------------------------------------

check("flags obvious credentials and passes prose", () => {
	assert.ok(looksLikeSecret("token is sk-abcdefghijklmnop1234"));
	assert.ok(looksLikeSecret("AKIAIOSFODNN7EXAMPLE"));
	assert.ok(looksLikeSecret("api_key = 9f8a7b6c5d4e3f2a1b"));
	assert.ok(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----"));
	assert.ok(looksLikeSecret("Authorization: Bearer abcdefghijklmn"));
	assert.ok(!looksLikeSecret("用 pnpm 不用 npm"));
	assert.ok(!looksLikeSecret("入口在 src/api/routes.ts"));
});

// --- 3. correction detection ----------------------------------------------

check("detects corrections in both languages", () => {
	assert.ok(detectCorrection("不对，应该用 pnpm 而不是 npm"));
	assert.ok(detectCorrection("as I said, use bun not npm"));
	assert.ok(detectCorrection("no, that's wrong — the entry is src/index.ts"));
	assert.ok(detectCorrection("别再改那个文件了"));
});

check("ignores ordinary prompts that merely mention those words", () => {
	assert.equal(detectCorrection("帮我把这个函数重构一下"), null);
	assert.equal(detectCorrection("run the tests and report failures"), null);
	assert.equal(detectCorrection("always run bun test"), null, "an instruction is not a correction");
	assert.equal(detectCorrection(""), null);
	assert.equal(detectCorrection(`不对\n\n\`\`\`js\ncode\`\`\``), null, "code blocks are skipped");
});

check("captures only the correcting sentence", () => {
	const captured = detectCorrection("先看下 README。不对，应该先跑 bun test 再改代码。");
	assert.ok(captured);
	assert.ok(captured.includes("bun test"));
	assert.ok(!captured.includes("README"), "keeps the correction, not the whole prompt");
});

check("records a correction once and dedupes repeats", () => {
	// todayStr() is the extension's own local-calendar day; deriving the name
	// from toISOString() here would silently drift across a UTC day boundary.
	const file = path.join(memoryDir, "daily", `${todayStr()}.md`);
	const stamp = "2026-10-16 12:00:00";
	assert.equal(recordCorrection("以后都用 pnpm", stamp, "abcd1234"), true, "first write");
	assert.equal(recordCorrection("以后都用 pnpm", stamp, "abcd1234"), false, "duplicate suppressed");
	const content = fs.readFileSync(file, "utf-8");
	assert.match(content, /#correction 以后都用 pnpm/);
	assert.equal(content.match(/#correction/g)?.length, 1);
});

check("refuses to record a correction containing a credential", () => {
	assert.equal(recordCorrection("key 是 sk-aaaaaaaaaaaaaaaaaaaa", "2026-10-16 12:00:00", "abcd1234"), false);
});

// --- 4. supersede ----------------------------------------------------------

const CONFLICTING = [
	"<!-- 2026-10-01 10:00:00 [a1a1a1a1] -->",
	"#preference Use npm as the package manager for this repository.",
	"",
	"<!-- 2026-10-05 10:00:00 [b2b2b2b2] -->",
	"#preference Use pnpm as the package manager for this repository, never npm.",
	"",
	"<!-- 2026-10-06 10:00:00 [c3c3c3c3] -->",
	"#convention The API entry point lives in src/api/routes.ts.",
	"",
].join("\n");

fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), CONFLICTING);

check("finds a contradiction pair sharing a tag", () => {
	const rows = collectAuditRows(tmpRoot);
	const conflicts = findConflictCandidates(rows);
	assert.equal(conflicts.length, 1, `expected one conflict pair, got ${conflicts.length}`);
	const [a, b] = conflicts[0];
	assert.ok(a.body.includes("npm") && b.body.includes("pnpm"), "pairs the two preferences");
});

check("does not flag an entry that restates another", () => {
	const rows = collectAuditRows(tmpRoot);
	// The routes.ts entry is a single convention with no counterpart.
	const conflicts = findConflictCandidates(rows);
	assert.ok(!conflicts.some(([a, b]) => a.body.includes("routes.ts") || b.body.includes("routes.ts")));
});

check("superseded entries leave the injected context", () => {
	_resetAuditState();
	const context = buildMemoryContext("");
	assert.ok(context.includes("Use npm as the package manager"));
	const rows = collectAuditRows(tmpRoot);
	const npmRow = rows.find((r) => r.body.includes("Use npm as the package"));
	assert.ok(npmRow, "found the entry to retire");

	// Retire it the way the command does.
	fs.mkdirSync(path.join(memoryDir, ".audit"), { recursive: true });
	fs.writeFileSync(
		path.join(memoryDir, ".audit", "supersedes.json"),
		JSON.stringify({ [npmRow.key]: { by: "other", at: "2026-10-16T00:00:00.000Z" } }),
	);
	_resetSupersedes();

	const filtered = filterSuperseded(context);
	assert.ok(!filtered.context.includes("Use npm as the package manager"), "retired entry must be gone");
	assert.equal(filtered.dropped, 1);
	assert.ok(filtered.context.includes("Use pnpm as the package manager"), "the replacement stays");
});

check("report counts superseded entries and lists them", () => {
	const { markdown } = buildAuditReport(tmpRoot);
	assert.match(markdown, /Superseded \(on disk, not injected\) \| 1/);
	assert.match(markdown, /## Superseded/);
	assert.match(markdown, /Contradiction candidates \| 0/, "retiring one side resolves the pair");
});

check("restoring brings an entry back", () => {
	fs.writeFileSync(path.join(memoryDir, ".audit", "supersedes.json"), "{}");
	_resetSupersedes();
	const filtered = filterSuperseded(buildMemoryContext(""));
	assert.equal(filtered.dropped, 0);
	assert.ok(filtered.context.includes("Use npm as the package manager"));
});

check("a malformed sidecar reads as empty instead of throwing", () => {
	fs.writeFileSync(path.join(memoryDir, ".audit", "supersedes.json"), "{ not json", "utf-8");
	_resetSupersedes();
	const filtered = filterSuperseded(buildMemoryContext(""));
	assert.equal(filtered.dropped, 0, "a corrupt chain must not retire anything");
	assert.ok(filtered.context.includes("Use npm as the package manager"), "every entry stays");
});

// --- 5. audit still works with the new layer -------------------------------

check("audit ledger and report survive the new wiring", () => {
	resetAuditLedger();
	auditContext(buildMemoryContext(""), tmpRoot);
	flushAuditLedger();
	const ledger = JSON.parse(fs.readFileSync(path.join(memoryDir, ".audit", "ledger.json"), "utf-8"));
	assert.ok(ledger.injections >= 1);
	const { markdown } = buildAuditReport(tmpRoot);
	assert.match(markdown, /Memory entries on disk: \*\*\d+\*\*/);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
