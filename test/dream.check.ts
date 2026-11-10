/**
 * Verification for the dreaming layer and the knowledge index (fork addition).
 *
 * Run with: npx tsx test/dream.check.ts
 *
 * Plain node checks, same as the other .check.ts files: the repo's own suite
 * is `bun test`, which is not available in this environment.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-dream-"));
const memoryDir = path.join(tmpRoot, "memory");

process.env.PI_MEMORY_DIR = memoryDir;

fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
fs.mkdirSync(path.join(memoryDir, "recovery"), { recursive: true });
fs.mkdirSync(path.join(memoryDir, "wiki"), { recursive: true });
fs.mkdirSync(path.join(memoryDir, "topics"), { recursive: true });
fs.mkdirSync(path.join(memoryDir, "transcripts"), { recursive: true });

const mod = await import("../index.ts");
const {
	_setBaseDir,
	buildMemoryContext,
	buildKnowledgeIndex,
	buildSessionDigest,
	collectDreamEntries,
	mergeWikiPage,
	orderByVerification,
	replaceBlockByKey,
	splitAuditBlocks,
	verificationStatus,
	writeVerifiedState,
	buildQmdEnv,
	npmGlobalRoots,
} = mod as typeof import("../index.ts");

_setBaseDir(memoryDir);

let passed = 0;
function check(name: string, fn: () => void) {
	fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

// --- 1. knowledge index ----------------------------------------------------

check("knowledge index lists wiki pages and topic notes", () => {
	fs.writeFileSync(path.join(memoryDir, "wiki", "pi-memory.md"), "# pi-memory\n\nThe memory extension.\n");
	fs.writeFileSync(path.join(memoryDir, "topics", "qmd.md"), "# qmd setup\n\nPATH and collection fix.\n");
	const index = buildKnowledgeIndex();
	assert.equal(index.length, 2);
	assert.equal(index[0].kind, "wiki");
	assert.equal(index[0].title, "pi-memory");
	assert.equal(index[0].file, "wiki/pi-memory.md");
	assert.equal(index[1].kind, "topic");
	assert.equal(index[1].summary, "PATH and collection fix.");
});

check("injected context carries the knowledge index", () => {
	const context = buildMemoryContext("");
	assert.ok(context.includes("Knowledge index"), "knowledge index section missing");
	assert.ok(context.includes("wiki/pi-memory.md"), "wiki page path missing");
});

// --- 2. verification status ------------------------------------------------

check("verification tags are recognised", () => {
	assert.equal(verificationStatus("#rule #已验证 always run bun test"), "verified");
	assert.equal(verificationStatus("#rule #未验证 maybe broken"), "unverified");
	assert.equal(verificationStatus("#rule #待验证 check later"), "pending");
	assert.equal(verificationStatus("#rule no tag"), "pending");
});

check("unverified entries are injected last", () => {
	const memory = [
		"<!-- 2026-01-01 10:00:00 [aaaaaaaa] -->",
		"#rule #未验证 unproven claim",
		"",
		"<!-- 2026-01-01 10:00:01 [bbbbbbbb] -->",
		"#rule #已验证 proven rule",
		"",
	].join("\n");
	const ordered = orderByVerification(memory);
	assert.ok(ordered.indexOf("proven rule") < ordered.indexOf("unproven claim"), "verified entry should come first");
});

check("a hand-written preamble keeps its place", () => {
	const memory = ["# Memory index", "", "<!-- 2026-01-01 10:00:00 [aaaaaaaa] -->", "#rule #已验证 one", ""].join("\n");
	assert.equal(orderByVerification(memory), memory);
});

check("the sidecar can mark an entry verified", () => {
	const memory = [
		"<!-- 2026-01-01 10:00:00 [aaaaaaaa] -->",
		"#rule sidecar marked",
		"",
		"<!-- 2026-01-01 10:00:01 [bbbbbbbb] -->",
		"#rule plain",
		"",
	].join("\n");
	fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), memory, "utf-8");
	const entries = collectDreamEntries();
	assert.equal(entries.length, 2);
	// The sidecar stores the key of the whole stamped block.
	const blocks = splitAuditBlocks(memory, "MEMORY.md");
	writeVerifiedState({ [blocks[1].key]: { status: "verified", evidence: "checked", at: "2026-01-01" } });
	const ordered = orderByVerification(memory);
	assert.ok(
		ordered.indexOf("plain") < ordered.indexOf("sidecar marked"),
		`the sidecar-verified entry should come first:\n${ordered}`,
	);
});

// --- 3. dream helpers ------------------------------------------------------

check("session digests keep prompts, answers and failures", () => {
	const lines = [
		JSON.stringify({ type: "session", id: "s1" }),
		JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "fix the build" }] },
		}),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "the build fails on windows" }] },
		}),
		JSON.stringify({
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text: "Error: command not found" }] },
		}),
		JSON.stringify({
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text: "all good" }] },
		}),
	].join("\n");
	const digest = buildSessionDigest(lines);
	assert.ok(digest.includes("user: fix the build"), digest);
	assert.ok(digest.includes("assistant: the build fails"), digest);
	assert.ok(digest.includes("error: Error: command not found"), digest);
	assert.ok(!digest.includes("all good"), "clean tool output is not evidence");
});

check("a block is replaced by its audit key", () => {
	const memory = [
		"<!-- 2026-01-01 10:00:00 [aaaaaaaa] -->",
		"#rule old text",
		"",
		"<!-- 2026-01-01 10:00:01 [bbbbbbbb] -->",
		"#rule other",
		"",
	].join("\n");
	fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), memory, "utf-8");
	const entries = collectDreamEntries();
	const target = entries.find((e) => e.text.includes("old text"));
	assert.ok(target, "entry not found");
	const updated = replaceBlockByKey(memory, target.key, "#rule new text");
	assert.ok(updated.replaced, "replacement should succeed");
	assert.ok(updated.content.includes("new text"), updated.content);
	assert.ok(updated.content.includes("other"), "other entry must survive");
});

check("wiki pages merge instead of overwrite", () => {
	const merged = mergeWikiPage("# topic\n\n- old line\n", "# topic\n\n- old line\n- new line\n");
	assert.ok(merged.includes("- old line"), merged);
	assert.ok(merged.includes("- new line"), merged);
	assert.equal(merged.match(/- old line/g)?.length, 1, "duplicate line must not be added twice");
});

// --- 4. qmd plumbing -------------------------------------------------------

check("qmd env caps the embed pool", () => {
	const env = buildQmdEnv({ PATH: "C:\\bin" } as NodeJS.ProcessEnv);
	assert.equal(env.QMD_EMBED_PARALLELISM, "1");
	assert.equal(env.NO_COLOR, "1");
});

check("npm global roots cover the Windows npm prefix", () => {
	const roots = npmGlobalRoots({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" } as NodeJS.ProcessEnv);
	assert.ok(
		roots.some((r) => r.includes(path.join("AppData", "Roaming", "npm", "node_modules"))),
		roots.join(","),
	);
});

console.log(`\n${passed} checks passed.`);
