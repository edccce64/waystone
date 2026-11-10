/**
 * Performance snapshot: prints timings, sets no thresholds.
 *
 * Run with: npx tsx test/perf.check.ts
 *
 * This file is deliberately NOT part of `npm run test:checks` or CI. It exists
 * so a change that makes the hot path slower is visible before it lands, and
 * so the numbers are comparable across machines and commits. A slow run is
 * information, not a failure: nothing here exits non-zero.
 *
 *   PI_MEMORY_PERF_RUNS=10   repetitions per measurement (default 10)
 *   PI_MEMORY_PERF_QMD=0     skip the qmd measurement
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUNS = Math.max(3, Number(process.env.PI_MEMORY_PERF_RUNS ?? 10) || 10);

const mod = await import("../index.ts");
const {
	_resetBaseDir,
	_setBaseDir,
	_setQmdAvailable,
	auditContext,
	buildMemoryContext,
	checkCollection,
	detectQmd,
	ensureDirs,
	runQmdSearch,
} = mod as typeof import("../index.ts");

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, index)];
}

function ms(value: number): string {
	return `${value.toFixed(2)} ms`;
}

/** A fixed memory tree, so the numbers do not drift with the real files. */
function writeFixture(dir: string): void {
	fs.mkdirSync(path.join(dir, "daily"), { recursive: true });
	fs.mkdirSync(path.join(dir, "wiki"), { recursive: true });

	const entries: string[] = [];
	for (let i = 0; i < 40; i++) {
		entries.push(`<!-- 2026-10-${String((i % 28) + 1).padStart(2, "0")} 10:00:00 [a1b2c3d${i % 10}] -->
#decision #已验证 Use pnpm for repository ${i}, never npm. The workspace is rooted at packages/app-${i}.`);
	}
	fs.writeFileSync(path.join(dir, "MEMORY.md"), `${entries.join("\n\n")}\n`, "utf-8");

	const scratchpad: string[] = [];
	for (let i = 0; i < 12; i++) {
		scratchpad.push(`- [${i % 3 === 0 ? "x" : " "}] Follow up on item ${i} <!-- 2026-10-20 09:00:00 [a1b2c3d4] -->`);
	}
	fs.writeFileSync(path.join(dir, "SCRATCHPAD.md"), `${scratchpad.join("\n")}\n`, "utf-8");

	const today = mod.todayStr();
	const yesterday = mod.yesterdayStr();
	for (const [name, start, count] of [
		[today, 0, 30],
		[yesterday, 30, 30],
	] as const) {
		const lines: string[] = [];
		for (let i = start; i < start + count; i++) {
			lines.push(
				`<!-- 2026-10-22 11:00:00 [a1b2c3d4] -->\n#lesson #已验证 Entry ${i} records a durable fact about module ${i}.`,
			);
		}
		fs.writeFileSync(path.join(dir, "daily", `${name}.md`), `${lines.join("\n\n")}\n`, "utf-8");
	}

	fs.writeFileSync(
		path.join(dir, "wiki", "architecture.md"),
		"# Architecture\n\nThe extension loads one entry point and imports its modules.\n",
		"utf-8",
	);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-perf-"));
_setBaseDir(path.join(tmp, "memory"));
ensureDirs();
writeFixture(path.join(tmp, "memory"));
_setQmdAvailable(false);

console.log(`fixture: ${path.join(tmp, "memory")}`);
console.log(`runs per measurement: ${RUNS}`);

// --- buildMemoryContext -----------------------------------------------------
{
	const timings: number[] = [];
	let chars = 0;
	for (let i = 0; i < RUNS; i++) {
		const started = performance.now();
		const context = buildMemoryContext("");
		timings.push(performance.now() - started);
		chars = context.length;
	}
	console.log(
		`buildMemoryContext: median ${ms(median(timings))} (min ${ms(Math.min(...timings))}, max ${ms(Math.max(...timings))}) — ${chars} chars`,
	);
}

// --- auditContext -----------------------------------------------------------
{
	const context = buildMemoryContext("");
	const timings: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const started = performance.now();
		auditContext(context, tmp);
		timings.push(performance.now() - started);
	}
	console.log(
		`auditContext:       median ${ms(median(timings))} (min ${ms(Math.min(...timings))}, max ${ms(Math.max(...timings))}) — ${context.length} chars in`,
	);
}

// --- qmd search -------------------------------------------------------------
const qmdEnabled = process.env.PI_MEMORY_PERF_QMD !== "0";
if (!qmdEnabled) {
	console.log("qmd search:         skipped (PI_MEMORY_PERF_QMD=0)");
} else {
	let available = false;
	try {
		available = await detectQmd();
	} catch {
		available = false;
	}
	const collection = available ? await checkCollection(mod.qmdCollectionName()) : false;
	if (!available || !collection) {
		console.log("qmd search:         skipped (qmd not installed or the collection does not exist)");
	} else {
		const timings: number[] = [];
		let failures = 0;
		const searches = Math.max(RUNS, 20);
		let warm = true;
		for (let i = 0; i < searches; i++) {
			const started = performance.now();
			try {
				await runQmdSearch("keyword", "memory", 5);
				timings.push(performance.now() - started);
			} catch {
				failures++;
			}
			if (warm) {
				// The first call pays process start-up; keep it out of the percentiles.
				timings.length = 0;
				warm = false;
			}
		}
		if (timings.length === 0) {
			console.log(`qmd search:         skipped (all ${failures} keyword searches failed)`);
		} else {
			console.log(
				`qmd search keyword: p50 ${ms(percentile(timings, 50))}, p95 ${ms(percentile(timings, 95))} over ${timings.length} runs (${failures} failed, query "memory", limit 5)`,
			);
		}
	}
}

_resetBaseDir();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\nperf snapshot complete (no thresholds, exit 0).");
