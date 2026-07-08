/**
 * @module extension
 *
 * workflow extension — the only SDK-coupled module. It joins the Copilot session, adapts it into a
 * {@link import("./tools.mjs").ToolCtx} (`log` / `send` / `getWorkspaceCwd`), and registers the
 * workflow tools built by `tools.mjs`. The workflow engine (`runtime`/`agent`/`sandbox`/...) is pure Node
 * and imported transitively, keeping it unit-testable under plain `node --test`.
 */
import { joinSession } from "@github/copilot-sdk/extension";

import { buildTools, buildCommands, runsDir, abortRun } from "./tools.mjs";
import { killAllAgents } from "./agent.mjs";
import { startPanel } from "./canvas.mjs";

/** @type {any} */
let session = null;
/** @type {{ url: (runId: string) => string, close: () => Promise<void> } | null} */
let panel = null;

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

// (Experimental) Declare a live web progress panel via the SDK canvas surface, when available. The
// canvas `open` returns a URL to a localhost dashboard that polls the run's state.json; an `abort`
// action lets the user stop the run from the panel. `createCanvas` is grabbed defensively so an
// older SDK (no canvas surface) still loads the tools/commands.
/** @type {any} */
let createCanvas = null;
try {
	({ createCanvas } = await import("@github/copilot-sdk/extension"));
} catch {
	/* older SDK — no canvas surface */
}

/** @type {any[]} */
const canvases = [];
if (typeof createCanvas === "function") {
	try {
		panel = await startPanel({ runsDir: runsDir() });
		process.on("exit", () => panel?.close());
		canvases.push(
			createCanvas({
				id: "workflow-progress",
				displayName: "Copilot Workflow Progress",
				description: "Live fan-out / phase dashboard for a workflow run (pass its runId).",
				inputSchema: { type: "object", properties: { runId: { type: "string", description: "The run id to display." } }, required: ["runId"] },
				open: (/** @type {any} */ req) => {
					const runId = String(req?.input?.runId || "");
					return { url: panel ? panel.url(runId) : "", title: `workflow · ${runId}`, status: "open" };
				},
				actions: [
					{
						name: "abort",
						description: "Abort the in-flight workflow run shown in this panel.",
						inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
						handler: (/** @type {any} */ req) => ({ aborted: abortRun(String(req?.input?.runId || "")) }),
					},
				],
			}),
		);
	} catch (e) {
		ctx.log(`workflow: progress canvas unavailable: ${e instanceof Error ? e.message : e}`, false, "warning");
	}
}

session = await joinSession({ tools: buildTools(ctx), commands: buildCommands(ctx), ...(canvases.length ? { canvases } : {}) });
