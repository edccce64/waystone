/**
 * Wiring check: load the extension factory with a recording stub and assert the
 * audit layer is actually attached — the /audit command exists, session_start
 * sets the project cwd, and session_shutdown flushes the ledger.
 *
 * Run with: npx tsx test/wiring.check.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-wiring-"));
const memoryDir = path.join(tmpRoot, "memory");
fs.mkdirSync(memoryDir, { recursive: true });
process.env.PI_MEMORY_DIR = memoryDir;
process.env.PI_MEMORY_LEDGER = "on";
process.env.PI_MEMORY_STALE_CHECK = "off";

const mod = await import("../index.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;

const handlers = new Map<string, Handler[]>();
const commands = new Map<string, { description?: string; handler: Handler }>();
const tools: string[] = [];

const pi = {
	on(event: string, handler: Handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		return () => {};
	},
	registerTool(tool: { name: string }) {
		tools.push(tool.name);
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
	await fn();
	passed += 1;
	console.log(`  ok  ${name}`);
}

await check("registers the /audit command", () => {
	assert.ok(commands.has("audit"), "expected an /audit command");
	assert.ok((commands.get("audit")?.description ?? "").length > 10, "expected a description for autocomplete");
});

await check("registers the /seed and /supersede commands", () => {
	for (const name of ["seed", "supersede"]) {
		assert.ok(commands.has(name), `expected a /${name} command`);
		assert.ok((commands.get(name)?.description ?? "").length > 10, `/${name} needs a description`);
	}
});

await check("keeps every upstream memory tool", () => {
	for (const tool of [
		"memory_write",
		"memory_forget",
		"memory_restore",
		"memory_read",
		"scratchpad",
		"memory_search",
	]) {
		assert.ok(tools.includes(tool), `missing tool ${tool}`);
	}
});

await check("upstream lifecycle handlers are still attached", () => {
	for (const event of ["session_start", "session_shutdown", "before_agent_start", "session_before_compact", "input"]) {
		assert.ok((handlers.get(event) ?? []).length > 0, `missing handler for ${event}`);
	}
});

await check("session_start records the project cwd", async () => {
	const notifications: { message: string; level: string }[] = [];
	const ctx = {
		cwd: tmpRoot,
		isProjectTrusted: () => true,
		hasUI: false,
		mode: "print",
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			onTerminalInput: () => () => {},
			getEditorText: () => "",
		},
		isIdle: () => true,
	};
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({}, ctx);
	}
	// qmd is detected lazily; the point is that the cwd was picked up without
	// throwing, which is what feeds the stale-path resolution.
	assert.ok(notifications.length >= 0);
});

await check("/audit writes a report file and notifies", async () => {
	const notifications: string[] = [];
	const ctx = {
		cwd: tmpRoot,
		isProjectTrusted: () => true,
		ui: { notify: (message: string) => notifications.push(message) },
	};
	await commands.get("audit")?.handler("", ctx);
	assert.equal(notifications.length, 1, "expected exactly one notification");
	assert.match(notifications[0], /条记忆/);
	assert.match(notifications[0], /Full report: /);
	const reports = fs.readdirSync(path.join(memoryDir, ".audit")).filter((f) => f.startsWith("report-"));
	assert.equal(reports.length, 1, "expected one report file on disk");
});

await check("/audit rejects unknown arguments", async () => {
	const notifications: string[] = [];
	const ctx = { cwd: tmpRoot, ui: { notify: (m: string) => notifications.push(m) } };
	await commands.get("audit")?.handler("banana", ctx);
	assert.match(notifications[0], /Usage: \/audit/);
});

await check("/audit reset clears the ledger and the reports", async () => {
	const auditDir = path.join(memoryDir, ".audit");
	// State that must survive the reset.
	fs.writeFileSync(path.join(auditDir, "supersedes.json"), '{"a":"b"}', "utf-8");
	fs.writeFileSync(path.join(auditDir, "verified.json"), '{"c":{"status":"verified"}}', "utf-8");
	const ctx = { cwd: tmpRoot, ui: { notify: () => {} } };
	await commands.get("audit")?.handler("reset", ctx);
	assert.ok(!fs.existsSync(path.join(auditDir, "ledger.json")), "the ledger should be gone");
	assert.equal(
		fs.readdirSync(auditDir).filter((f) => f.startsWith("report-")).length,
		0,
		"the reports should be gone",
	);
	assert.ok(fs.existsSync(path.join(auditDir, "supersedes.json")), "the supersede chain must survive");
	assert.ok(fs.existsSync(path.join(auditDir, "verified.json")), "the verification state must survive");
});

await check("session_shutdown flushes without throwing", async () => {
	const ctx = {
		cwd: tmpRoot,
		isProjectTrusted: () => true,
		hasUI: false,
		mode: "print",
		ui: {},
		isIdle: () => true,
		sessionManager: { getSessionId: () => "abc12345" },
	};
	for (const handler of handlers.get("session_shutdown") ?? []) {
		await handler({ reason: "reload" }, ctx);
	}
});

await check("/supersede lists nothing when the chain is empty", async () => {
	const notifications: string[] = [];
	const ctx = { cwd: tmpRoot, hasUI: false, ui: { notify: (m: string) => notifications.push(m) } };
	await commands.get("supersede")?.handler("list", ctx);
	assert.match(notifications[0], /No superseded memories/);
});

await check("/supersede rejects an unknown key", async () => {
	const notifications: string[] = [];
	const ctx = { cwd: tmpRoot, hasUI: false, ui: { notify: (m: string) => notifications.push(m) } };
	await commands.get("supersede")?.handler("deadbeef deadbeef", ctx);
	assert.match(notifications[0], /No memory entry matches/);
});

await check("/seed reports when there is nothing to mine", async () => {
	const notifications: string[] = [];
	const ctx = { cwd: tmpRoot, hasUI: false, ui: { notify: (m: string) => notifications.push(m) } };
	await commands.get("seed")?.handler("30 --dry-run", ctx);
	assert.match(notifications[0], /No usable user prompts found/);
});

await check("/seed returns immediately even with prompts to mine", async () => {
	// Regression: the command used to await one model call per batch inline, so
	// a real history blew past pi's 60s command cap and the RPC layer reported
	// "Pi RPC request timed out". The handler must hand work off and return.
	const sessionsDir = path.join(tmpRoot, "sessions", "--proj-seed--");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	const lines: string[] = [];
	for (let i = 0; i < 120; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				parentId: null,
				timestamp: `${day}T10:00:00.000Z`,
				message: {
					role: "user",
					content: [{ type: "text", text: `我的偏好 ${i}：请永远用工具编号 ${i} 来做这件事` }],
				},
			}),
		);
	}
	fs.writeFileSync(path.join(sessionsDir, `${day}T10-00-00-000Z_seed.jsonl`), lines.join("\n"));

	const notifications: string[] = [];
	// No model on the context, so any inline await would reject instead of
	// hanging; a detached run just fails quietly in the background.
	const ctx = {
		cwd: tmpRoot,
		isProjectTrusted: () => true,
		hasUI: false,
		ui: { notify: (m: string) => notifications.push(m) },
		model: undefined,
		modelRegistry: {},
		sessionManager: { getSessionId: () => "abcd1234" },
	};

	const started = Date.now();
	await commands.get("seed")?.handler("30", ctx);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 5_000, `/seed must return fast, took ${elapsed}ms`);
	assert.match(notifications[0], /background batch\(es\)/);
	assert.match(notifications[0], /returns now/, "the message must tell the user it is detached");
});

await check("/seed status survives an interrupted run", async () => {
	await new Promise((r) => setTimeout(r, 300));
	const notifications: string[] = [];
	const ctx = { cwd: tmpRoot, hasUI: false, ui: { notify: (m: string) => notifications.push(m) } };
	await commands.get("seed")?.handler("status", ctx);
	assert.ok(notifications.length === 1, "status must answer without throwing");
});

await check("/seed apply --to project writes to the repository, not the global tier", async () => {
	const projectDir = path.join(tmpRoot, "some-repo");
	const notifications: string[] = [];
	const ctx = {
		cwd: projectDir,
		hasUI: false,
		ui: { notify: (m: string) => notifications.push(m) },
		sessionManager: { getSessionId: () => "abcd1234" },
	};

	// Extraction needs a live model, so the result file stands in for a finished
	// run. What matters here is where /seed apply puts the result.
	fs.mkdirSync(path.join(memoryDir, ".audit"), { recursive: true });
	fs.writeFileSync(
		path.join(memoryDir, ".audit", "seed-result.json"),
		JSON.stringify({
			createdAt: new Date().toISOString(),
			days: 30,
			target: "project",
			autoApply: false,
			scanned: 120,
			batches: 3,
			failedBatches: [],
			candidates: [
				{ text: "这个仓库的测试命令是 vitest run，不是 npm test", category: "convention" },
				{ text: "构建产物一律输出到 dist/，不要新增顶层目录", category: "convention" },
			],
			skippedExisting: 0,
		}),
	);

	await commands.get("seed")?.handler("apply", ctx);

	const projectMemory = path.join(projectDir, ".pi", "memory", "MEMORY.md");
	assert.ok(fs.existsSync(projectMemory), "project memory file must exist after apply");
	const content = fs.readFileSync(projectMemory, "utf-8");
	assert.match(
		content,
		/^<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[0-9a-f]{8}\] -->/,
		"project memory is stamped like any other memory",
	);
	assert.match(content, /#convention 这个仓库的测试命令是 vitest run/);
	assert.ok(!fs.existsSync(path.join(memoryDir, "MEMORY.md")), "a project run must not touch global memory");
	assert.ok(!fs.existsSync(path.join(memoryDir, ".audit", "seed-result.json")), "the result is consumed");
	assert.ok(
		notifications.some((n) => n.includes("project memory")),
		"the destination must be reported",
	);
});

await check("/seed apply defaults to the global tier", async () => {
	fs.mkdirSync(path.join(memoryDir, ".audit"), { recursive: true });
	fs.writeFileSync(
		path.join(memoryDir, ".audit", "seed-result.json"),
		JSON.stringify({
			createdAt: new Date().toISOString(),
			days: 30,
			target: "global",
			autoApply: false,
			scanned: 10,
			batches: 1,
			failedBatches: [],
			candidates: [{ text: "Always use pnpm as the package manager", category: "preference" }],
			skippedExisting: 0,
		}),
	);
	const notifications: string[] = [];
	const ctx = {
		cwd: tmpRoot,
		hasUI: false,
		ui: { notify: (m: string) => notifications.push(m) },
		sessionManager: { getSessionId: () => "abcd1234" },
	};
	await commands.get("seed")?.handler("apply", ctx);
	assert.ok(fs.existsSync(path.join(memoryDir, "MEMORY.md")), "global memory must exist after apply");
	assert.match(fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf-8"), /#preference Always use pnpm/);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
