/**
 * Waystone: memory for the pi coding agent.
 *
 * This file is the entry point and nothing else: it wires the modules
 * together. Everything it exports is re-exported from them, so tests and
 * the pi runtime keep working through the same module.
 *
 * Layout (under ~/.pi/agent/memory/):
 *   MEMORY.md              — curated long-term memory
 *   SCRATCHPAD.md          — checklist of things to keep in mind
 *   daily/YYYY-MM-DD.md    — daily append-only log
 *   recovery/*.json        — records for restoring memory_forget deletions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands, registerTools } from "./commands.js";
import { registerLifecycleHooks } from "./maintenance.js";
import { registerSearchTools } from "./search.js";

export * from "./commands.js";
export * from "./maintenance.js";
export * from "./memory-core.js";
export * from "./search.js";

export default function (pi: ExtensionAPI) {
	registerLifecycleHooks(pi);
	registerSearchTools(pi);
	registerCommands(pi);
	registerTools(pi);
}
