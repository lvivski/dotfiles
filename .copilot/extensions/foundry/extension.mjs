import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { foundryBoard } from "./canvas.mjs";
import { critiqueDefinition, inspectionToolBlocked } from "./work/critique.mjs";
import { identify } from "./work/native.mjs";
import { idleHome } from "./work/pool.mjs";
import { permissionCheck } from "./work/permissions.mjs";
import { confirmNoReport, recover, scoutFailure } from "./work/recovery.mjs";
import { researchAgent } from "./work/research.mjs";
import { createRuntime } from "./work/runtime.mjs";
import { scoutAgent, scoutDefinition } from "./work/scouts.mjs";
import { buildTools, fromHelper, primaryOnly } from "./work/tools.mjs";

/** @type {import("@github/copilot-sdk/extension").JoinedSession} */
let session;
const executionMode = () => session.rpc.mode.get();
const permissions = permissionCheck(() => session.rpc.managedSettings.get(), () => session.rpc.permissions.getMode());
/** @param {string} message */
const confirm = async message => (await session.ui.elicitation({ message, requestedSchema: { type: "object", properties: {} } })).action === "accept";
/** The task registry also contains direct agents of discovery workflows hosted by this writer.
 * Only an exact native identity from one of its bound workflows can exempt a running task.
 * @param {string[]} workflows */
async function runningHelpers(workflows) {
	const tasks = (await session.rpc.tasks.list()).tasks.filter(t => t.type === "agent" && t.status === "running");
	if (!tasks.length || !workflows.length) return tasks.map(t => t.id);
	/** @type {Map<string,string>} */ const discoveries = new Map();
	for (const id of workflows) {
		const detail = await session.workflow.getRunDetail(id);
		if (detail.runId === id && detail.workflowName === "foundry-scout")
			for (const a of detail.agents)
				if (a.runId === id && a.status === "running") discoveries.set(a.agentId, a.toolCallId);
	}
	// A new helper may have started while workflow details were being read.
	return (await session.rpc.tasks.list()).tasks.flatMap(t => t.type === "agent" && t.status === "running" &&
		!(discoveries.has(t.id) && discoveries.get(t.id) === t.toolCallId) ? [t.id] : []);
}
const runtime = createRuntime(process.cwd(), {
	mode: executionMode,
	idleWriter: async id => idleHome(await session.rpc.tools.execute({name:"get_session",arguments:{project_session_id:id}}),id),
	runningHelpers,
	async scoutBudget() {
		const { contextAttribution: info } = await session.rpc.metadata.getContextAttribution();
		if (!info || !Number.isSafeInteger(info.promptTokenLimit) || info.promptTokenLimit <= 0)
			throw Error("Foundry could not determine the issuing session's effective prompt budget.");
		// Size one evidence page against the host window. A fresh scout does not
		// inherit the owner's conversation. Count UTF-8 bytes conservatively.
		const c = info.categories;
		return Math.max(0, info.promptTokenLimit - c.systemPrompt - c.customInstructions - c.systemTools - c.mcpTools);
	},
	scoutFailure: (id, label) => scoutFailure(session, id, label),
	confirmNoReport: review => confirmNoReport(session, review),
	async isResearcher(id, agentId) {
		const detail = await session.workflow.getRunDetail(id);
		const running = detail.agents.filter(a => a.status === "running"), [direct] = running;
		if (detail.runId !== id || detail.workflowName !== "foundry-scout" || detail.status !== "running" ||
			running.length !== 1 || direct.runId !== id || direct.agentId !== agentId || !direct.toolCallId) return false;
		const tasks = (await session.rpc.tasks.list()).tasks.filter(t => t.id === agentId);
		return tasks.length === 1 && tasks[0].type === "agent" && tasks[0].status === "running" && tasks[0].toolCallId === direct.toolCallId;
	},
	permissionBlocker: permissions.blocker,
	ask: message => session.ui.input(message),
	confirm,
	autoConfirm: () => permissions.autoConfirm(executionMode),
	execute: (name, args, toolCallId) => session.rpc.tools.execute({ name, arguments: args, toolCallId }),
	scout: (run, dispatch) => session.workflow.run("foundry-scout", { args: { run, dispatch }, notifyOnComplete: false }),
	startInspection: (run, inspection, dispatch) => session.workflow.start("foundry-inspect", { args: { run, inspection, dispatch }, notifyOnComplete: false }),
	scoutState: id => session.workflow.waitForRun(id),
	scoutSnapshot: id => session.workflow.getRun(id),
	resumeScout: id => session.workflow.resume(id, { notifyOnComplete: false }),
	notify: prompt => session.send({ source: "system", mode: "enqueue", prompt }),
	recover: effect => recover(page => session.rpc.eventLog.read(page), effect),
	readHistory: page => session.rpc.eventLog.read(page),
	log: message => session.log(message, { level: "warning" }),
});
session = await joinSession({
	agents: { definitions: [scoutAgent, researchAgent] },
	workflows: [defineWorkflow(scoutDefinition(() => runtime)),defineWorkflow(critiqueDefinition(() => runtime))],
	tools: { definitions: buildTools(runtime, () => session.sessionId, permissions.snapshot) },
	canvases: { definitions: [foundryBoard(runtime.readBoard, runtime.defaultMapRun, runtime.readSpecification)] },
	hooks: { handlers: {
		onSessionStart(input, ctx) {
			if (!fromHelper(input, ctx.sessionId)) runtime.sessionStart(ctx.sessionId, input.workingDirectory, input.initialPrompt);
		},
		async onPreToolUse(input, ctx) {
			if (await inspectionToolBlocked(runtime,session.sessionId,ctx.sessionId,input,id=>session.workflow.getRunDetail(id)))
				return {permissionDecision:"deny",permissionDecisionReason:"Factory candidate reviewers may only use their frozen packet; no tool is authorized."};
			const name = input.toolName.split(".").at(-1) ?? "";
			if (fromHelper(input, ctx.sessionId) && name !== "rename_branch") {
				if ((name.startsWith("foundry_") && name !== "foundry_reference") || identify(name, input.toolArgs))
					return { permissionDecision: "deny", permissionDecisionReason: primaryOnly };
				return;
			}
			if (!["create_session", "send_session_message", "bash", "rename_branch"].includes(name))
				return;
			try {
				await runtime.pre(name, input.toolArgs, ctx.sessionId, input.toolCallId ?? "");
			}
			catch (error) {
				return { permissionDecision: "deny", permissionDecisionReason: String(error) };
			}
		},
		onPostToolUse(input, ctx) {
			if (input.toolCallId && !fromHelper(input, ctx.sessionId))
				runtime.post(input.toolCallId, input.toolResult, ctx.sessionId);
		},
		onSessionEnd(input, ctx) { if (!fromHelper(input, ctx.sessionId)) runtime.close(); },
	} },
});
session.on("assistant.turn_start", event => {
	if (!event.agentId && !event.data.parentToolCallId)
		runtime.turn(session.sessionId);
});
session.on("system.notification", event => {
	const kind = event.data.kind;
	if (!event.agentId && kind.type === "shell_completed")
		runtime.turn(session.sessionId, kind.shellId); // A matching shell wakes the ledger, not proof its check passed.
});
session.on("permission.completed", event => runtime.refusal(event, session.sessionId));
session.on("tool.execution_complete", event => {
	runtime.refusal(event,session.sessionId);
	if (event.data.success && !event.agentId && !("parentToolCallId" in event.data && event.data.parentToolCallId))
		runtime.completion(event.data.toolCallId,session.sessionId);
});
