/**
 * @module extension
 *
 * workflow extension — the only SDK-coupled module. It joins the Copilot session, adapts it into a
 * {@link import("./tools.mjs").ToolCtx} (`log` / `send` / `getWorkspaceCwd`), and registers the
 * workflow tools built by `tools.mjs`. The workflow engine (`runtime`/`agent`/`sandbox`/...) is pure Node
 * and imported transitively, keeping it unit-testable under plain `node --test`.
 */
import { joinSession } from "@github/copilot-sdk/extension";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

import { buildTools, buildCommands } from "./tools.mjs";
import { createAgentRunner, killAllAgents, loadCustomAgentConfig } from "./agent.mjs";

/** @type {any} */
let session = null;
const agentBackend = createAgentRunner(
	{ CopilotClient, RuntimeConnection },
	{
		bin: process.execPath,
		async resolveAgent(name, enableMcp) {
			const result = await session?.rpc?.agent?.list?.();
			const info = result?.agents?.find?.((agent) => agent?.name === name || agent?.id === name);
			return loadCustomAgentConfig(info, { enableMcp });
		},
	},
);

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
		// A completion wakeup must never crash the extension, but a dropped one should be visible:
		// the run has already finished, so this notice is the only signal the session will get.
		const failed = (/** @type {unknown} */ e) => ctx.log(`workflow: completion notice was not delivered: ${e instanceof Error ? e.message : e}`, false, "warning");
		try {
			const p = session?.send?.({ prompt, mode: "enqueue" });
			if (p && typeof p.catch === "function") p.catch(failed);
		} catch (e) {
			failed(e);
		}
	},
	async getWorkspaceCwd() {
		try {
			return (await session?.rpc?.workspaces?.getWorkspace())?.workspace?.cwd;
		} catch {
			return undefined;
		}
	},
	async getPermissionContext() {
		try {
			const [allowAll, paths, metadata] = await Promise.all([
				session?.rpc?.permissions?.getAllowAll?.(),
				session?.rpc?.permissions?.paths?.list?.(),
				session?.rpc?.metadata?.snapshot?.(),
			]);
			return {
				allowAll: typeof allowAll?.enabled === "boolean" ? allowAll.enabled : null,
				mode: ["off", "on", "auto"].includes(allowAll?.mode) ? allowAll.mode : allowAll?.enabled === true ? "on" : "off",
				sessionMode: typeof metadata?.currentMode === "string" ? metadata.currentMode : null,
				directories: Array.isArray(paths?.directories) ? paths.directories : [],
			};
		} catch {
			return undefined;
		}
	},
	agentBackend,
	async requestBudgetIncrease({ runId, current, spent, increment, proposed }) {
		try {
			if (!session?.capabilities?.ui?.elicitation) return null;
			const approved = await session.ui.confirm(
				`Workflow ${runId} reached its ${current.toFixed(2)} AIC budget after spending ${spent.toFixed(2)} AIC. Add ${increment.toFixed(2)} AIC of headroom once? In-flight work may make the resulting ceiling higher than ${proposed.toFixed(2)} AIC.`,
			);
			return approved;
		} catch {
			return null;
		}
	},
};

session = await joinSession({ tools: buildTools(ctx), commands: buildCommands(ctx) });
