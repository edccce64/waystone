/**
 * Verification for the audit layer (fork addition).
 *
 * Run with: npx tsx test/audit.check.ts
 *
 * The repo's own suite is `bun test`, which is not available in this
 * environment, so these assertions are plain node checks against the same
 * exported functions the extension uses at runtime.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-audit-"));
const memoryDir = path.join(tmpRoot, "memory");
const projectDir = path.join(tmpRoot, "project");

process.env.PI_MEMORY_DIR = memoryDir;
process.env.PI_MEMORY_LEDGER = "on";
process.env.PI_MEMORY_STALE_CHECK = "annotate";

fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
fs.mkdirSync(path.join(memoryDir, "recovery"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "src", "api"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "src", "api", "routes.ts"), "// live file\n");
// projectDir/legacy/old-handler.js is deliberately never created.

const mod = await import("../index.ts");
const {
	_setBaseDir,
	_resetAuditState,
	buildMemoryContext,
	auditContext,
	postProcessContext,
	buildAuditReport,
	splitAuditBlocks,
	extractCandidatePaths,
	missingPathsIn,
	flushAuditLedger,
	resetAuditLedger,
} = mod as typeof import("../index.ts");

_setBaseDir(memoryDir);

let passed = 0;
function check(name: string, fn: () => void) {
	fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

// --- 1. path extraction ----------------------------------------------------

check("extracts a relative source path", () => {
	const found = extractCandidatePaths("The router lives in `src/api/routes.ts`, keep it that way.");
	assert.deepEqual(found, ["src/api/routes.ts"]);
});

check("extracts a directory path with trailing separator", () => {
	assert.deepEqual(extractCandidatePaths("see docs/ for the details"), ["docs/"]);
});

check("ignores URLs, globs and template placeholders", () => {
	const placeholder = "$" + "{HOME}/x.ts";
	assert.deepEqual(extractCandidatePaths(`see https://example.com/a/b.html and src/**/*.ts and ${placeholder}`), []);
});

check("ignores slash-words that are not paths", () => {
	assert.deepEqual(extractCandidatePaths("and/or, input/output, read/write mode"), []);
});

check("strips trailing punctuation from a sentence", () => {
	assert.deepEqual(extractCandidatePaths("moved to src/new/place.ts."), ["src/new/place.ts"]);
});

check("reports a path missing only when every path is gone", () => {
	assert.deepEqual(missingPathsIn("moved from src/api/routes.ts to lib/x.ts", projectDir), []);
	assert.deepEqual(missingPathsIn("the old handler was legacy/old-handler.js", projectDir), ["legacy/old-handler.js"]);
	assert.deepEqual(missingPathsIn("no paths at all here", projectDir), []);
});

// --- 2. block splitting ----------------------------------------------------

check("splits stamped entries and keeps unstamped paragraphs", () => {
	const content = [
		"<!-- 2026-10-16 10:00:00 [aaaa1111] -->",
		"first entry body",
		"",
		"<!-- 2026-10-16 11:00:00 [bbbb2222] -->",
		"second entry body",
		"",
	].join("\n");
	const blocks = splitAuditBlocks(content, "MEMORY.md");
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].body, "first entry body");
	assert.equal(blocks[1].body, "second entry body");
	assert.equal(blocks[0].src, "MEMORY.md");
	assert.notEqual(blocks[0].key, blocks[1].key);
});

check("falls back to paragraph blocks before the first stamp", () => {
	const blocks = splitAuditBlocks("loose para one\n\nloose para two", "MEMORY.md");
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].stamp, null);
});

// --- 3. seed memory files --------------------------------------------------

fs.writeFileSync(
	path.join(memoryDir, "MEMORY.md"),
	[
		"<!-- 2026-10-10 09:00:00 [cccc3333] -->",
		"#preference Use pnpm, never npm. See package.json at the repo root.",
		"",
		"<!-- 2026-10-11 09:00:00 [dddd4444] -->",
		"#decision The HTTP entry point moved to src/api/routes.ts.",
		"",
		"<!-- 2026-10-12 09:00:00 [eeee5555] -->",
		"#lesson The old cron entry was legacy/old-handler.js, now deleted.",
		"",
		"<!-- 2026-10-13 09:00:00 [ffff6666] -->",
		"#preference Use pnpm, never npm. See package.json at the repo root.",
		"",
	].join("\n"),
);

// Today's log: the injected "today" section is what the audit layer sees, so
// the entry under test has to live there. Writing it to a fixed past date made
// this check fail on every day but the day it was written.
const now = new Date();
const pad2 = (n: number) => String(n).padStart(2, "0");
const todayName = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
fs.writeFileSync(
	path.join(memoryDir, "daily", `${todayName}.md`),
	["<!-- 2026-10-16 08:00:00 [7777aaaa] -->", "Shipped the release notes for v2.", ""].join("\n"),
);

// --- 4. auditContext behaviour --------------------------------------------

check("annotates an entry whose file is gone and leaves live ones alone", () => {
	const context = buildMemoryContext("");
	assert.ok(context.length > 0, "expected a non-empty context");
	const audited = auditContext(context, projectDir);
	assert.match(audited, /referenced path no longer exists: legacy\/old-handler\.js/);
	assert.ok(!audited.includes("referenced path no longer exists: src/api/routes.ts"), "live path must not be flagged");
	assert.ok(audited.includes("src/api/routes.ts"), "live path entry must survive intact");
	flushAuditLedger();
});

type LedgerShape = {
	injections: number;
	injectedChars: number;
	entries: Record<string, { k: string; src: string; n: number; last?: string }>;
};

function ledgerOnDisk(): LedgerShape {
	const file = path.join(memoryDir, ".audit", "ledger.json");
	if (!fs.existsSync(file)) return { injections: 0, injectedChars: 0, entries: {} };
	return JSON.parse(fs.readFileSync(file, "utf-8"));
}

check("ledger counts only the entries that reached the context", () => {
	const before = ledgerOnDisk().injections;
	const context = buildMemoryContext("");
	auditContext(context, projectDir);
	flushAuditLedger();
	const ledger = ledgerOnDisk();
	assert.equal(ledger.injections, before + 1);
	// MEMORY.md (4 entries, 2 of which are duplicates sharing one key) plus
	// today's daily log, so 4 distinct keys on the first ever injection.
	const keys = Object.keys(ledger.entries);
	assert.ok(keys.length >= 4, `expected >=4 entries, got ${keys.length}`);
	for (const entry of Object.values(ledger.entries)) {
		assert.ok(entry.n >= 1, "an injected entry must count at least once");
		assert.ok(ledger.injectedChars > 0, "injected chars must accumulate");
	}
});

check("a second snapshot counts as a second injection", () => {
	const before = ledgerOnDisk().injections;
	const context = buildMemoryContext("");
	auditContext(context, projectDir);
	flushAuditLedger();
	const ledger = ledgerOnDisk();
	assert.equal(ledger.injections, before + 1);
	const counts = Object.values(ledger.entries).map((e) => e.n);
	assert.ok(
		counts.every((n) => n >= 2),
		"every entry should now be at least 2",
	);
});

check("fold mode collapses a stale entry to one line", () => {
	process.env.PI_MEMORY_STALE_CHECK = "fold";
	_resetAuditState();
	const audited = auditContext(buildMemoryContext(""), projectDir);
	assert.match(audited, /- \[stale\] #lesson The old cron entry was legacy\/old-handler\.js, now deleted\./);
	assert.ok(!audited.includes("now deleted. _(audit:"), "folded entry drops the original annotation");
	process.env.PI_MEMORY_STALE_CHECK = "annotate";
});

check("off mode leaves the context byte-identical", () => {
	process.env.PI_MEMORY_STALE_CHECK = "off";
	process.env.PI_MEMORY_LEDGER = "off";
	_resetAuditState();
	const context = buildMemoryContext("");
	assert.equal(auditContext(context, projectDir), context);
	process.env.PI_MEMORY_STALE_CHECK = "annotate";
	process.env.PI_MEMORY_LEDGER = "on";
	_resetAuditState();
});

check("audit does not corrupt entries that mention no path", () => {
	const audited = auditContext(buildMemoryContext(""), projectDir);
	assert.ok(audited.includes("Shipped the release notes for v2."));
});

check("the '# Memory' heading survives the audit layer", () => {
	// Regression: auditContext used to strip the heading while reassembling
	// sections, which silently broke anything that prepends to the context.
	const audited = postProcessContext(buildMemoryContext(""), projectDir);
	assert.ok(audited.startsWith("# Memory\n\n## "), `unexpected head: ${JSON.stringify(audited.slice(0, 40))}`);
});

// --- 5. the report ---------------------------------------------------------

check("report finds stale, duplicate and never-injected entries", () => {
	resetAuditLedger();
	const { markdown, summary } = buildAuditReport(projectDir);
	assert.match(summary, /条记忆/);
	assert.match(markdown, /Points at a file that no longer exists \| 1/);
	assert.match(markdown, /Duplicated across files \| 1/);
	// The ledger was just cleared, so nothing has ever reached the model.
	assert.match(markdown, /Never injected \| 5/);
	assert.match(markdown, /legacy\/old-handler\.js/);
});

check("report counts injections but no cost figures", () => {
	const before = ledgerOnDisk().injections;
	auditContext(buildMemoryContext(""), projectDir);
	flushAuditLedger();
	const after = ledgerOnDisk().injections;
	const { markdown, summary } = buildAuditReport(projectDir);
	assert.match(markdown, new RegExp(`Context injections recorded: \\*\\*${after}\\*\\*`));
	assert.match(markdown, /Entries that reached the model at least once: \*\*\d+\/5/);
	// The report no longer estimates what memory costs per turn.
	assert.doesNotMatch(markdown, /Average injected per snapshot/);
	assert.doesNotMatch(markdown, /Lifetime injected/);
	assert.doesNotMatch(markdown, /tokens/);
	assert.doesNotMatch(summary, /字符|tokens/);
	assert.match(summary, /条从未注入/);
	assert.ok(after === before + 1);
});

// --- 6. upstream behaviour is untouched ------------------------------------

check("buildMemoryContext output is unchanged by the audit layer", () => {
	process.env.PI_MEMORY_LEDGER = "off";
	process.env.PI_MEMORY_STALE_CHECK = "off";
	_resetAuditState();
	const context = buildMemoryContext("");
	process.env.PI_MEMORY_LEDGER = "on";
	process.env.PI_MEMORY_STALE_CHECK = "annotate";
	_resetAuditState();
	assert.match(context, /^# Memory\n\n## /);
	assert.ok(context.includes("## Daily log:"), "today's daily section present");
	assert.ok(context.includes("## MEMORY.md (long-term)"), "long-term section present");
	assert.ok(
		context.includes("#lesson The old cron entry was legacy/old-handler.js, now deleted."),
		"stale entry is untouched upstream",
	);
	assert.ok(!context.includes("audit:"), "audit must not leak into the base context");
	assert.ok(!context.includes("[stale]"));
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
