/**
 * @module extension
 *
 * cwf extension — the only SDK-coupled module. It joins the Copilot session, adapts it into a
 * {@link import("./tools.mjs").ToolCtx} (`log` / `send` / `getWorkspaceCwd`), and registers the
 * cwf tools built by `tools.mjs`. The workflow engine (`runtime`/`agent`/`sandbox`/…) is pure Node
 * and imported transitively, keeping it unit-testable under plain `node --test`.
 */
import { joinSession } from "@github/copilot-sdk/extension";

import { buildTools, buildCommands } from "./tools.mjs";
import { killAllAgents } from "./agent.mjs";

/** @type {any} */
let session = null;

// Reap any live subagents if the extension is torn down mid-run, so they don't orphan (and keep
// spending). `exit` covers clean exits; the SIGTERM handler converts the CLI's shutdown signal.
process.on("exit", () => killAllAgents());
process.on("SIGTERM", () => process.exit());

/** @type {import("./tools.mjs").ToolCtx} */
const ctx = {
	log(message, ephemeral = false, level = "info") {
		try {
			const p = session?.log(message, { level, ephemeral: ephemeral || undefined });
			if (p && typeof p.catch === "function") p.catch(() => {});
		} catch {
			/* logging must never throw */
		}
	},
	send(prompt) {
		try {
			const p = session?.send?.({ prompt, mode: "enqueue" });
			if (p && typeof p.catch === "function") p.catch(() => {});
		} catch {
			/* best-effort wake */
		}
	},
	async getWorkspaceCwd() {
		try {
			return (await session?.rpc?.workspaces?.getWorkspace())?.workspace?.cwd;
		} catch {
			return undefined;
		}
	},
};

session = await joinSession({ tools: buildTools(ctx), commands: buildCommands(ctx) });
