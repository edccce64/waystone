/**
 * Regression checks for the fixes of 2026-11-10.
 *
 * Run with: npx tsx test/fixes.check.ts
 *
 * Every check here fails on the code before the fix.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-fixes-"));
const memoryDir = path.join(tmpRoot, "memory");
const sessionsDir = path.join(tmpRoot, "sessions");
const projectDir = path.join(tmpRoot, "project");

process.env.PI_MEMORY_DIR = memoryDir;

for (const dir of ["daily", "recovery", "wiki", "topics", "transcripts", ".audit"]) {
	fs.mkdirSync(path.join(memoryDir, dir), { recursive: true });
}
fs.mkdirSync(sessionsDir, { recursive: true });

const mod = await import("../index.ts");
const {
	_setBaseDir,
	_setAuditCwd,
	_setProjectTrust,
	_resetSupersedes,
	applyDreamActions,
	auditContext,
	buildAuditReport,
	buildMemoryContext,
	buildSessionDigest,
	collectAuditRows,
	collectDreamEntries,
	collectSeedMessages,
	flushAuditLedger,
	orderByVerification,
	postProcessContext,
	pruneOldFiles,
	resetAuditLedger,
	splitAuditBlocks,
	updateMemoryFile,
	withMemoryLock,
	writeJsonAtomic,
	writeVerifiedState,
} = mod as typeof import("../index.ts");

_setBaseDir(memoryDir);
_setAuditCwd(projectDir);

// The extension is loaded with a recording stub, so the commands and tools
// can be called directly.
type Handler = (event: unknown, ctx: unknown) => unknown;
const commands = new Map<string, { description?: string; handler: Handler }>();
const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();

const pi = {
	on() {
		return () => {};
	},
	registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) {
		tools.set(tool.name, tool);
	},
	registerCommand(name: string, options: { description?: string; handler: Handler }) {
		commands.set(name, options);
	},
	registerShortcut() {},
	registerFlag() {},
	registerProvider() {},
	registerVirtualModel() {},
	registerMcpServer() {},
	registerToolRenderer() {},
	appendEntry() {},
	sendMessage() {},
	sendUserMessage() {},
	setActiveTools() {},
	getActiveTools: () => [],
	getAllTools: () => [],
	events: { on: () => () => {}, emit: () => {} },
	exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
};

const factory = (mod as typeof import("../index.ts")).default;
factory(pi as unknown as Parameters<typeof factory>[0]);

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
	await Promise.resolve().then(fn);
	passed += 1;
	console.log(`  ok  ${name}`);
}

function writeMemory(text: string) {
	fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), text, "utf-8");
}

const TWO_ENTRIES = [
	"<!-- 2026-01-01 10:00:00 [aaaaaaaa] -->",
	"#rule first entry",
	"",
	"<!-- 2026-01-01 10:00:01 [bbbbbbbb] -->",
	"#rule second entry",
	"",
].join("\n");

// --- 1. the verification sidecar reaches the injected order ---------------

await check("a sidecar-verified entry is injected first", () => {
	writeMemory(TWO_ENTRIES);
	const blocks = splitAuditBlocks(TWO_ENTRIES, "MEMORY.md");
	assert.equal(blocks.length, 2);
	// The sidecar stores the key of the whole stamped block.
	writeVerifiedState({ [blocks[1].key]: { status: "verified", evidence: "checked", at: "2026-01-01" } });
	const ordered = orderByVerification(TWO_ENTRIES);
	assert.ok(
		ordered.indexOf("second entry") < ordered.indexOf("first entry"),
		`sidecar status was not honoured:\n${ordered}`,
	);
});

// --- 2. the merge action moves the old body into the target ---------------

await check("merge moves the old entry into the target entry", () => {
	writeMemory(TWO_ENTRIES);
	const entries = collectDreamEntries();
	const oldEntry = entries.find((e) => e.text.includes("first entry"));
	const targetEntry = entries.find((e) => e.text.includes("second entry"));
	assert.ok(oldEntry && targetEntry);
	const report = applyDreamActions(
		{ sessionManager: { getSessionId: () => "test-session" } } as any,
		{
			createdAt: "2026-01-01T00:00:00.000Z",
			days: 30,
			entriesScanned: entries.length,
			transcriptsScanned: 0,
			actions: [{ action: "merge", key: oldEntry.key, into: targetEntry.key }],
			notes: [],
		} as any,
	);
	assert.equal(report.merged, 1, `merge was skipped: ${report.skipped.join(", ")}`);
	const content = fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf-8");
	assert.ok(!content.includes("[aaaaaaaa]"), "the old entry should be gone as its own block");
	assert.ok(content.includes("[bbbbbbbb]"), "the target entry should stay");
	assert.ok(content.includes("first entry"), "the old body should move into the target entry");
	assert.ok(content.includes("second entry"), "the target body should stay");
});

await check("merge without a target entry is skipped", () => {
	writeMemory(TWO_ENTRIES);
	const entries = collectDreamEntries();
	const report = applyDreamActions(
		{ sessionManager: { getSessionId: () => "test-session" } } as any,
		{
			createdAt: "2026-01-01T00:00:00.000Z",
			days: 30,
			entriesScanned: entries.length,
			transcriptsScanned: 0,
			actions: [{ action: "merge", key: entries[0].key, into: "not-a-real-key" }],
			notes: [],
		} as any,
	);
	assert.equal(report.merged, 0);
	assert.ok(report.skipped.length > 0, "the skip should be reported");
});

// --- 3. /audit reset keeps the other state --------------------------------

await check("audit reset keeps the supersede, verification and dream state", () => {
	const auditDir = path.join(memoryDir, ".audit");
	fs.writeFileSync(path.join(auditDir, "ledger.json"), '{"version":1}', "utf-8");
	fs.writeFileSync(path.join(auditDir, "supersedes.json"), '{"a":"b"}', "utf-8");
	fs.writeFileSync(path.join(auditDir, "verified.json"), '{"c":{"status":"verified"}}', "utf-8");
	fs.writeFileSync(path.join(auditDir, "dream-result.json"), '{"actions":[]}', "utf-8");
	fs.writeFileSync(path.join(auditDir, "report-2026-01-01.md"), "# report", "utf-8");

	resetAuditLedger();

	assert.equal(fs.existsSync(path.join(auditDir, "ledger.json")), false, "the ledger should be cleared");
	assert.equal(fs.existsSync(path.join(auditDir, "report-2026-01-01.md")), false, "old reports should be removed");
	for (const keep of ["supersedes.json", "verified.json", "dream-result.json"]) {
		assert.equal(fs.existsSync(path.join(auditDir, keep)), true, `${keep} must survive the reset`);
	}
});

// --- 5. the session digest drops lines with a credential ------------------

await check("a session digest drops lines that carry a credential", () => {
	const lines = [
		JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "token is sk-abcdefghijklmnopqrstuvwxyz012345" }] },
		}),
		JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "use pnpm for this repo" }] },
		}),
	].join("\n");
	const digest = buildSessionDigest(lines);
	assert.ok(!digest.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), digest);
	assert.ok(digest.includes("use pnpm for this repo"), digest);
});

// --- 6. seed mining never sends a credential to the model ----------------

await check("seed mining drops prompts that carry a credential", () => {
	const project = path.join(sessionsDir, "demo-project");
	fs.mkdirSync(project, { recursive: true });
	const today = new Date();
	const stamp = `${today.toISOString().slice(0, 10)}T12-00-00-000Z_session.jsonl`;
	const lines = [
		JSON.stringify({
			type: "message",
			timestamp: new Date().toISOString(),
			message: {
				role: "user",
				content: [{ type: "text", text: "the deploy key is sk-abcdefghijklmnopqrstuvwxyz012345" }],
			},
		}),
		JSON.stringify({
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "we always deploy with pnpm here" }] },
		}),
	].join("\n");
	fs.writeFileSync(path.join(project, stamp), lines, "utf-8");

	const messages = collectSeedMessages(30);
	const texts = messages.map((m) => m.text).join("\n");
	assert.ok(!texts.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), `the credential was collected:\n${texts}`);
	assert.ok(texts.includes("we always deploy with pnpm here"), texts);
});

// --- 7. the project tier counts towards the context budget ----------------

await check("the project tier is inside the overall context budget", () => {
	// A long-term file that fills the whole budget on its own.
	writeMemory(`${"#rule a long rule that fills the budget\n\n".repeat(400)}`);
	fs.mkdirSync(path.join(projectDir, ".pi", "memory"), { recursive: true });
	fs.writeFileSync(path.join(projectDir, ".pi", "memory", "MEMORY.md"), "#rule project rule\n".repeat(200), "utf-8");
	_setProjectTrust(true);
	try {
		const projectSection = postProcessContext("", projectDir).split("\n\n---\n\n")[0];
		const reserve = projectSection.length + 12;
		const context = buildMemoryContext("", reserve);
		const final = postProcessContext(context, projectDir, projectSection);
		assert.ok(final.length <= 16_000, `the injection reached ${final.length} chars`);
	} finally {
		_setProjectTrust(false);
	}
});

// --- 8. the write lock -----------------------------------------------------

await check("the write lock is taken and released", () => {
	const lockPath = path.join(memoryDir, ".audit", "write.lock");
	const value = withMemoryLock(() => {
		assert.ok(fs.existsSync(lockPath), "the lock should exist while the write runs");
		return 42;
	});
	assert.equal(value, 42);
	assert.equal(fs.existsSync(lockPath), false, "the lock should be released");
});

await check("the write lock is re-entrant", () => {
	const value = withMemoryLock(() => withMemoryLock(() => "nested"));
	assert.equal(value, "nested");
	assert.equal(fs.existsSync(path.join(memoryDir, ".audit", "write.lock")), false);
});

await check("a memory file update keeps both changes", () => {
	const file = path.join(memoryDir, "MEMORY.md");
	writeMemory("");
	updateMemoryFile(file, (existing) => `${existing}first\n`);
	updateMemoryFile(file, (existing) => `${existing}second\n`);
	const content = fs.readFileSync(file, "utf-8");
	assert.ok(content.includes("first"), content);
	assert.ok(content.includes("second"), content);
});

await check("a JSON file is written atomically", () => {
	const target = path.join(memoryDir, ".audit", "atomic.json");
	writeJsonAtomic(target, { a: 1 });
	assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { a: 1 });
	assert.equal(fs.existsSync(`${target}.tmp`), false, "the temporary file should be gone");
});

// --- 9. old files are pruned ----------------------------------------------

await check("old transcripts and reports are pruned", () => {
	const transcriptsDir = path.join(memoryDir, "transcripts");
	for (let i = 0; i < 5; i++) {
		const file = path.join(transcriptsDir, `old-${i}.md`);
		fs.writeFileSync(file, `# old ${i}\n`, "utf-8");
		fs.utimesSync(file, new Date(2020, 0, i + 1), new Date(2020, 0, i + 1));
	}
	fs.writeFileSync(path.join(transcriptsDir, "fresh.md"), "# fresh\n", "utf-8");
	const removed = pruneOldFiles(transcriptsDir, "", 2);
	assert.equal(removed, 4, "the three oldest files plus one more should go");
	assert.ok(fs.existsSync(path.join(transcriptsDir, "fresh.md")), "the newest file stays");
	assert.equal(fs.readdirSync(transcriptsDir).length, 2);
});

// --- 10. the seed apply belongs to the repository it was mined in --------

await check("a project seed is not applied in another repository", async () => {
	const otherProject = path.join(tmpRoot, "other-project");
	fs.mkdirSync(otherProject, { recursive: true });
	const auditDir = path.join(memoryDir, ".audit");
	fs.writeFileSync(
		path.join(auditDir, "seed-result.json"),
		JSON.stringify({
			createdAt: new Date().toISOString(),
			days: 30,
			cwd: projectDir,
			target: "project",
			autoApply: false,
			scanned: 1,
			batches: 1,
			failedBatches: [],
			candidates: [{ text: "we use vitest here", category: "convention" }],
			skippedExisting: 0,
		}),
		"utf-8",
	);
	const notifications: string[] = [];
	await commands.get("seed")?.handler("apply", {
		cwd: otherProject,
		hasUI: false,
		ui: { notify: (m: string) => notifications.push(m) },
		sessionManager: { getSessionId: () => "test-session" },
	});
	assert.ok(
		notifications.some((n) => n.includes(projectDir)),
		`the run should point at the original repository: ${notifications.join(" | ")}`,
	);
	assert.equal(
		fs.existsSync(path.join(otherProject, ".pi", "memory", "MEMORY.md")),
		false,
		"nothing may be written into the other repository",
	);
	const projectFile = path.join(projectDir, ".pi", "memory", "MEMORY.md");
	const projectContent = fs.existsSync(projectFile) ? fs.readFileSync(projectFile, "utf-8") : "";
	assert.ok(
		!projectContent.includes("we use vitest here"),
		"the run must not be applied while the wrong repository is open",
	);
});

// --- 11. a note never grows without a limit ------------------------------

await check("a wiki page that is too long is refused", async () => {
	const result = await tools
		.get("memory_write")
		?.execute("call-1", { target: "wiki", topic: "too-long", content: "x".repeat(25_000) }, null, null, {
			sessionManager: { getSessionId: () => "test-session" },
		} as any);
	assert.ok(result?.isError, "the write should be refused");
	assert.equal(fs.existsSync(path.join(memoryDir, "wiki", "too-long.md")), false);
});

console.log(`\n${passed} checks passed`);

// --- 12. the audit report tells the tiers apart ---------------------------

await check("an entry in an old daily log is not counted as never injected", () => {
	const old = new Date(Date.now() - 10 * 86_400_000);
	const oldName = `${old.toISOString().slice(0, 10)}.md`;
	fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
	fs.writeFileSync(path.join(memoryDir, "daily", oldName), "#rule old daily entry\n", "utf-8");
	const rows = collectAuditRows(projectDir);
	const oldRow = rows.find((r) => r.src === `daily/${oldName}`);
	assert.ok(oldRow, "the old daily entry should be listed");
	assert.equal(oldRow.eligible, false, "an old daily log is not injected");
});

await check("a done scratchpad item is not counted as never injected", () => {
	fs.writeFileSync(path.join(memoryDir, "SCRATCHPAD.md"), "- [x] finished task\n", "utf-8");
	const row = collectAuditRows(projectDir).find((r) => r.src === "SCRATCHPAD.md");
	assert.ok(row, "the scratchpad entry should be listed");
	assert.equal(row.eligible, false, "a done item is not injected");
	fs.writeFileSync(path.join(memoryDir, "SCRATCHPAD.md"), "- [ ] open task\n", "utf-8");
	const open = collectAuditRows(projectDir).find((r) => r.src === "SCRATCHPAD.md");
	assert.equal(open?.eligible, true, "an open item is injected");
});

await check("a superseded entry is not reported as an orphan", () => {
	writeMemory(TWO_ENTRIES);
	const blocks = splitAuditBlocks(TWO_ENTRIES, "MEMORY.md");
	writeJsonAtomic(path.join(memoryDir, ".audit", "supersedes.json"), {
		[blocks[0].key]: { by: blocks[1].key, at: "2026-01-01" },
	});
	_resetSupersedes();
	const report = buildAuditReport(projectDir);
	assert.ok(
		!report.markdown.includes("Ledger rows with no file entry | 1"),
		`the superseded entry must not be an orphan:\n${report.markdown.slice(0, 800)}`,
	);
});

// --- 13. a cut section is not a dead entry --------------------------------

await check("a section that was cut off is reported as cut off", () => {
	writeMemory(`${"#rule a long entry\n\n".repeat(400)}`);
	const context = buildMemoryContext("");
	const audited = auditContext(context, projectDir);
	assert.ok(audited.includes("[truncated"), "the context should show the cut");
	flushAuditLedger();
	const report = buildAuditReport(projectDir);
	assert.ok(
		report.markdown.includes("Cut off by the budget"),
		`the report should name the cut:\n${report.markdown.slice(0, 1200)}`,
	);
});

// --- 14. reserved file names ----------------------------------------------

await check("a reserved Windows file name is refused", async () => {
	const result = await tools
		.get("memory_write")
		?.execute("call-2", { target: "topic", topic: "con", content: "reserved" }, null, null, {
			sessionManager: { getSessionId: () => "test-session" },
		} as any);
	assert.ok(result?.isError, "the write should be refused");
	assert.equal(fs.existsSync(path.join(memoryDir, "topics", "con.md")), false);
});
console.log(`
${passed} checks passed`);
