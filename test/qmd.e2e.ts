/**
 * End-to-end check of the qmd path: real collection, real embeddings, real
 * search, through the same functions the extension calls at runtime.
 *
 * Run with: npx tsx test/qmd.e2e.ts
 *
 * Set PI_MEMORY_E2E_QMD=0 to skip when qmd is not installed.
 *
 * The test uses a throwaway collection. The extension hardcodes the name
 * `pi-memory`, which on a real machine points at the live memory dir, so
 * searching that name would read the user's own memories.
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (process.env.PI_MEMORY_E2E_QMD === "0") {
	console.log("skipped (PI_MEMORY_E2E_QMD=0)");
	process.exit(0);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-qmd-"));
const memoryDir = path.join(tmpRoot, "memory");
fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true });
process.env.PI_MEMORY_DIR = memoryDir;
process.env.PI_MEMORY_LEDGER = "off";
process.env.PI_MEMORY_STALE_CHECK = "off";

const collection = `pi-memory-e2e-${process.pid.toString(36)}`;
process.env.PI_MEMORY_QMD_COLLECTION = collection;

const mod = await import("../index.ts");
const { _setBaseDir, detectQmd, runQmdSearch, setupQmdCollection } = mod as typeof import("../index.ts");
_setBaseDir(memoryDir);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void, timeoutMs = 120_000) {
	await Promise.race([
		Promise.resolve().then(fn),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`"${name}" timed out after ${timeoutMs}ms`)), timeoutMs),
		),
	]);
	passed += 1;
	console.log(`  ok  ${name}`);
}

const available = await detectQmd();
if (!available) {
	console.log("skipped: qmd is not on PATH for this shell");
	process.exit(0);
}

await check("qmd is detected", () => {
	assert.equal(available, true);
});

fs.writeFileSync(
	path.join(memoryDir, "MEMORY.md"),
	[
		"<!-- 2026-10-10 09:00:00 [aaaa1111] -->",
		"#preference This repository uses pnpm as its package manager, never npm.",
		"",
		"<!-- 2026-10-11 09:00:00 [bbbb2222] -->",
		"#convention The HTTP router entry point lives in src/api/routes.ts.",
		"",
	].join("\n"),
);

// The extension resolves qmd itself (see isQmdCommand) because on Windows the
// bare name is a .cmd shim that spawn cannot exec directly. Here shell:true
// lets the OS resolve the shim, which is enough for a smoke test.
function runQmd(args: string[]): string {
	return execFileSync("qmd", args, {
		timeout: 600_000,
		stdio: "pipe",
		encoding: "utf-8",
		shell: process.platform === "win32",
	});
}

await check("collection setup succeeds", async () => {
	await setupQmdCollection();
});

// The extension embeds in the background via ensureQmdEmbed(); here we do it
// synchronously so the search assertions below are not racing the model load.
await check(
	"embeddings are generated for the collection",
	() => {
		const started = Date.now();
		runQmd(["embed", "-c", collection]);
		console.log(`      (embed took ${Math.round((Date.now() - started) / 1000)}s)`);
	},
	600_000,
);

await check("keyword search finds a stored fact", async () => {
	const { results } = await runQmdSearch("keyword", "pnpm", 3, 120_000);
	assert.ok(results.length > 0, "expected at least one keyword hit");
	const text = JSON.stringify(results);
	assert.match(text, /pnpm/);
});

await check("semantic search finds it by meaning, not keyword", async () => {
	const { results, stderr } = await runQmdSearch("semantic", "how do I install packages here", 3, 300_000);
	if (results.length === 0) {
		console.log(`      (semantic returned nothing; stderr: ${stderr.slice(0, 200)})`);
	}
	assert.ok(results.length > 0, "expected a vector hit");
	assert.match(JSON.stringify(results), /pnpm/);
});

try {
	runQmd(["collection", "remove", collection]);
	console.log("  ok  the temporary collection is removed");
} catch (err) {
	console.log(`  warn  could not remove ${collection}: ${String(err).slice(0, 120)}`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
