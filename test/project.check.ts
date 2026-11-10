/**
 * Verification for the project tier (.pi/memory/MEMORY.md).
 *
 * Run with: npx tsx test/project.check.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-project-"));
const memoryDir = path.join(tmpRoot, "memory");
const projectDir = path.join(tmpRoot, "my-repo");

process.env.PI_MEMORY_DIR = memoryDir;
process.env.PI_MEMORY_LEDGER = "on";
process.env.PI_MEMORY_STALE_CHECK = "off";

fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
fs.mkdirSync(path.join(memoryDir, "recovery"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "src", "index.ts"), "// live\n");

const projectMemoryFile = path.join(projectDir, ".pi", "memory", "MEMORY.md");

const mod = await import("../index.ts");
const {
	_setBaseDir,
	_resetAuditState,
	_setAuditCwd,
	_setProjectTrust,
	_isProjectTrusted,
	buildMemoryContext,
	postProcessContext,
	collectAuditRows,
	buildAuditReport,
	flushAuditLedger,
} = mod as typeof import("../index.ts");

_setBaseDir(memoryDir);
_setAuditCwd(projectDir);

let passed = 0;
function check(name: string, fn: () => void) {
	fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

fs.writeFileSync(
	path.join(memoryDir, "MEMORY.md"),
	["<!-- 2026-10-01 10:00:00 [aaaa1111] -->", "#preference Always use pnpm, never npm.", ""].join("\n"),
);

// --- trust gate -----------------------------------------------------------

check("project memory is withheld until the project is trusted", () => {
	fs.mkdirSync(path.join(projectDir, ".pi", "memory"), { recursive: true });
	fs.writeFileSync(
		projectMemoryFile,
		["<!-- 2026-10-02 10:00:00 [bbbb2222] -->", "#convention The router entry is src/index.ts.", ""].join("\n"),
	);

	_setProjectTrust(false);
	assert.equal(_isProjectTrusted(), false);
	const untrusted = postProcessContext(buildMemoryContext(""), projectDir);
	assert.ok(!untrusted.includes("Project memory"), "an untrusted repo must not speak first");
	assert.ok(!untrusted.includes("router entry"));

	_setProjectTrust(true);
	assert.equal(_isProjectTrusted(), true);
	const trusted = postProcessContext(buildMemoryContext(""), projectDir);
	assert.ok(trusted.includes("Project memory"), "a trusted project is injected");
	assert.ok(trusted.includes("router entry"));
});

check("project memory is injected ahead of the global tier", () => {
	const trusted = postProcessContext(buildMemoryContext(""), projectDir);
	assert.ok(
		trusted.indexOf("Project memory") < trusted.indexOf("MEMORY.md (long-term)"),
		"project section must come first",
	);
	assert.ok(trusted.startsWith("# Memory\n\n## Project memory"), "it is the first section");
});

check("the global tier still lands when there is no project memory", () => {
	fs.rmSync(path.join(projectDir, ".pi"), { recursive: true, force: true });
	const context = postProcessContext(buildMemoryContext(""), projectDir);
	assert.ok(context.includes("MEMORY.md (long-term)"));
	assert.ok(!context.includes("Project memory"));
	fs.mkdirSync(path.join(projectDir, ".pi", "memory"), { recursive: true });
	fs.writeFileSync(
		projectMemoryFile,
		["<!-- 2026-10-02 10:00:00 [bbbb2222] -->", "#convention The router entry is src/index.ts.", ""].join("\n"),
	);
});

check("project memory is capped so it cannot crowd out everything else", () => {
	const long = Array.from({ length: 400 }, (_, i) => `line ${i} of a very long project convention file`).join("\n");
	fs.writeFileSync(projectMemoryFile, `<!-- 2026-10-02 10:00:00 [bbbb2222] -->\n${long}\n`);
	const trusted = postProcessContext(buildMemoryContext(""), projectDir);
	const section = trusted.slice(0, trusted.indexOf("---"));
	assert.ok(section.length < 3_600, `project section was ${section.length} chars, expected ~3000`);
	assert.ok(trusted.includes("MEMORY.md (long-term)"), "the global tier survives");
	fs.writeFileSync(
		projectMemoryFile,
		["<!-- 2026-10-02 10:00:00 [bbbb2222] -->", "#convention The router entry is src/index.ts.", ""].join("\n"),
	);
});

// --- audit integration ----------------------------------------------------

check("audit counts project entries as their own source", () => {
	_resetAuditState();
	postProcessContext(buildMemoryContext(""), projectDir);
	flushAuditLedger();
	const ledger = JSON.parse(fs.readFileSync(path.join(memoryDir, ".audit", "ledger.json"), "utf-8"));
	const sources = new Set(Object.values(ledger.entries).map((e: { src: string }) => e.src));
	assert.ok(sources.has("project/MEMORY.md"), "project entries recorded under their own source");
	assert.ok(sources.has("MEMORY.md"), "global entries recorded too");
});

check("the report lists the project tier", () => {
	const rows = collectAuditRows(projectDir);
	assert.ok(
		rows.some((r) => r.src === "project/MEMORY.md"),
		"rows include the project tier",
	);
	const { markdown } = buildAuditReport(projectDir);
	assert.match(markdown, /project\/MEMORY\.md/);
});

check("stale paths are resolved against the project for project memory", () => {
	// src/index.ts exists, so the project convention must not be flagged.
	const rows = collectAuditRows(projectDir);
	const projectRow = rows.find((r) => r.src === "project/MEMORY.md");
	assert.ok(projectRow);
	assert.deepEqual(projectRow.missing, [], "a live path in project memory is not stale");
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
