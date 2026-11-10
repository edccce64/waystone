/**
 * Live check: the extension must find qmd and search the real memory dir even
 * when the npm global bin directory is not on PATH.
 *
 * Run with: npx tsx test/live-search.check.ts
 *
 * This check talks to the machine it runs on. It needs qmd, the `pi-memory`
 * collection and memory content to search.
 *
 *   PI_MEMORY_E2E_QMD=0     skip the check
 *   PI_MEMORY_E2E_QUERY=... the word to search for (default: "memory")
 */

import * as assert from "node:assert/strict";

if (process.env.PI_MEMORY_E2E_QMD === "0") {
	console.log("skipped (PI_MEMORY_E2E_QMD=0)");
	process.exit(0);
}

const query = process.env.PI_MEMORY_E2E_QUERY ?? "memory";

const mod = await import("../index.ts");
const { detectQmd, checkCollection, runQmdSearch, resolveQmdJsPath } = mod as typeof import("../index.ts");

const jsPath = resolveQmdJsPath();
console.log(`qmd js entry: ${jsPath ?? "(not found)"}`);
assert.ok(jsPath, "qmd must be resolvable without a PATH change");

const available = await detectQmd();
console.log(`qmd available: ${available}`);
assert.equal(available, true, "qmd must be detected");

const hasCollection = await checkCollection("pi-memory");
console.log(`collection pi-memory: ${hasCollection}`);
assert.equal(hasCollection, true, "the pi-memory collection must exist");

const keyword = await runQmdSearch("keyword", query, 3);
console.log(`keyword hits: ${keyword.results.length}`);
assert.ok(keyword.results.length > 0, `keyword search must find "${query}"`);

const semantic = await runQmdSearch("semantic", query, 3);
console.log(`semantic hits: ${semantic.results.length}`);
assert.ok(semantic.results.length > 0, `semantic search must return hits for "${query}"`);

console.log("\nlive search check passed.");
