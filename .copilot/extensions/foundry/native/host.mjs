import { readJsonValue, readRecord } from "../data.mjs";
import { object, text } from "../factory/fields.mjs";
import { decodeRequest, requestShapes } from "../requests.mjs";
import { createdChild } from "./dispatch.mjs";
import { bindNativeContext, createNativeObservations, hold, requireOwnedPlan } from "./observations.mjs";

/** @typedef {import("./observations.mjs").Context} Context */
/** @typedef {import("../types/parallel.js").ParallelHost & {state: "available"}} Host */
/** @typedef {import("../types/json.js").JsonValue} Json */
/** @typedef {{
 * foundry_get_status: import("../requests.mjs").Request<"getStatus">,
 * foundry_reserve_task: import("../requests.mjs").Request<"reserveTask">,
 * foundry_attach_task: import("../requests.mjs").Request<"attachTask">,
 * foundry_complete_task: import("../requests.mjs").Request<"completeTask">,
 * create_session: {project_id: string, base_branch: string, workspace_type: "worktree", coordinate_with_creator: true,
 *   notify_on_idle: "always", kickoff: {mode: "interactive", prompt: string}},
 * get_session: {project_session_id: string},
 * list_sessions_and_chats: Record<string, never>,
 * send_session_message: {session_id: string, message: string, coordinator_only: true, delivery_mode: "immediate", mode: "autopilot"},
 * run_dynamic_workflow: {name: string, args?: Json, limits?: Json}
 * }} NativeArguments */
/** @typedef {{[K in keyof NativeArguments]?: (args: NativeArguments[K], correlation: string) => Promise<unknown>}} PrimaryRoutes */
/** @typedef {{
 * current: () => Context | null,
 * route: "primary-app" | "extension-rpc",
 * primary?: PrimaryRoutes,
 * workflow?: (args: NativeArguments["run_dynamic_workflow"], correlation: string) => Promise<unknown>,
 * readPlan: (planId: string) => import("../types/plan.js").FoundryPlan,
 * taskPolicies: Host["taskPolicies"],
 * decodeCreated?: Host["decodeCreated"], decodeHandoff?: Host["decodeHandoff"],
 * decodeRun?: (value: unknown) => string,
 * observations?: import("./observations.mjs").ObservationReaders
 * }} NativeHostAccess */

const names = /** @type {const} */ (["foundry_get_status", "foundry_reserve_task", "foundry_attach_task", "foundry_complete_task",
	"create_session", "get_session", "list_sessions_and_chats", "send_session_message", "run_dynamic_workflow"]);

/** Only this operation has an observed working extension-RPC invocation route.
 * The owning composition still checks current invocation and durable single admission.
 * @param {{rpc: Pick<import("@github/copilot-sdk").CopilotSession["rpc"], "tools">}} session */
export function createRpcWorkflowRoute(session) {
	const tools = session.rpc.tools;
	if (!tools) hold("dispatch_capability_unavailable", "This SDK has no offered-tool execution API");
	/** @param {NativeArguments["run_dynamic_workflow"]} args @param {string} toolCallId */
	return (args, toolCallId) => tools.execute({ name: "run_dynamic_workflow", arguments: readJsonValue(args), toolCallId });
}

/** Decode the observed public get_session detail, not create_session's prose receipt.
 * Additional UI metadata is not authority. Creation needs a correlated fresh detail
 * provider before this decoder can be used as its synchronous composition port.
 * @param {unknown} value @param {Context} context */
export function decodeSessionDetail(value, context) {
	const entry = readRecord(value);
	if (entry.session_type !== "worktree" || entry.project_id !== context.projectId
		|| entry.creator_session_id !== context.sessionId || entry.coordinating_creator_session_id !== context.sessionId) {
		hold("dispatch_child_mismatch", "Native detail is not this coordinator's isolated child");
	}
	return createdChild({ sessionId: entry.id, projectId: entry.project_id, creatorSessionId: entry.creator_session_id,
		worktreePath: entry.path, branch: entry.branch });
}

/** Trusted composition boundary, not a public tool, provider discovery or general proxy.
 * Callable primary routes must come from the App's normal permission pipeline. No
 * public SDK binding for them is assumed. The known disabled RPC session-management
 * route stays unavailable, even if primary callbacks or matching metadata are present.
 * Canonical admission/journal services remain responsible for reservation and effects.
 * @param {NativeHostAccess} access
 * @returns {Host & {decodeRun?: (value: unknown) => string}} */
export function createNativeHost(access) {
	const check = bindNativeContext(access.current), context = check();
	if (!["primary-app", "extension-rpc"].includes(access.route) || typeof access.readPlan !== "function" || typeof access.taskPolicies !== "function") {
		hold("dispatch_identity_unavailable", "Current host access and canonical plan/policy readers are required");
	}
	/** @type {PrimaryRoutes} */
	const primary = access.route === "primary-app" ? { ...access.primary } : {};
	const workflow = access.route === "extension-rpc" ? access.workflow : primary.run_dynamic_workflow;
	/** @type {Set<string>} */
	const offered = new Set(names.filter(name => typeof (name === "run_dynamic_workflow" ? workflow : primary[name]) === "function"));
	/** @template T @param {string} name @param {((args: T, correlation: string) => Promise<unknown>) | undefined} operation
	 * @param {T} args @param {string} correlation */
	async function invoke(name, operation, args, correlation) {
		check();
		if (!operation) hold("dispatch_capability_unavailable", `${name} has no supported primary App binding; no alternate route will be attempted`);
		const raw = await operation(args, correlation);
		check("uncertain", { name, raw: readJsonValue(raw) });
		return raw;
	}
	/** @param {string} planId */
	function plan(planId) {
		const result = access.readPlan(planId);
		requireOwnedPlan(check(), result);
		if (result.id !== planId) hold("dispatch_foreign_plan", "Plan reader returned another plan");
		return result;
	}
	/** Decode without adding absent optional wire fields or accepting extra authority.
	 * @template {"getStatus" | "reserveTask" | "attachTask" | "completeTask"} K
	 * @param {K} name @param {Json} args */
	function request(name, args) {
		object(args, Object.keys(requestShapes[name]), "native plan request");
		const decoded = decodeRequest(name, args), current = plan(text(args.planId, "owned plan", 64));
		for (const key of Object.keys(decoded)) if (!Object.hasOwn(args, key)) Reflect.deleteProperty(decoded, key);
		if ("taskId" in decoded) {
			const task = current.tasks.find(task => task.id === decoded.taskId);
			if (!task || "attemptId" in decoded && task.attempts.at(-1)?.id !== decoded.attemptId) {
				hold("dispatch_attempt_mismatch", "Native mutation requires the exact current owned task/attempt");
			}
		}
		return decoded;
	}
	/** @type {Host["executor"]} */
	const executor = {
		async execute({ name, arguments: args, toolCallId }) {
			check();
			if (!offered.has(name)) hold("dispatch_capability_unavailable", `${name} is unavailable on this exact route`);
			const correlation = text(toolCallId, "native correlation ID", 512);
			switch (name) {
				case "foundry_get_status": {
					return invoke(name, primary[name], request("getStatus", args), correlation);
				}
				case "foundry_reserve_task": {
					return invoke(name, primary[name], request("reserveTask", args), correlation);
				}
				case "foundry_attach_task": {
					return invoke(name, primary[name], request("attachTask", args), correlation);
				}
				case "foundry_complete_task": {
					return invoke(name, primary[name], request("completeTask", args), correlation);
				}
				case "create_session": {
					object(args, ["project_id", "base_branch", "workspace_type", "coordinate_with_creator", "notify_on_idle", "kickoff"], "setup-only creation");
					object(args.kickoff, ["mode", "prompt"], "setup kickoff");
					if (args.project_id !== context.projectId || args.workspace_type !== "worktree" || args.coordinate_with_creator !== true
						|| args.notify_on_idle !== "always" || args.kickoff.mode !== "interactive") hold("dispatch_setup_invalid", "Creation must retain the owning project and setup-only worktree options");
					return invoke(name, primary[name], { project_id: context.projectId, base_branch: text(args.base_branch, "reserved base", 512),
						workspace_type: "worktree", coordinate_with_creator: true, notify_on_idle: "always",
						kickoff: { mode: "interactive", prompt: text(args.kickoff.prompt, "setup prompt", 16000) } }, correlation);
				}
				case "get_session":
					object(args, ["project_session_id"], "child detail request");
					return invoke(name, primary[name], { project_session_id: text(args.project_session_id, "canonical child", 512) }, correlation);
				case "list_sessions_and_chats":
					object(args, [], "complete inventory request");
					return invoke(name, primary[name], {}, correlation);
				case "send_session_message":
					object(args, ["session_id", "message", "coordinator_only", "delivery_mode", "mode"], "unchanged handoff");
					if (args.coordinator_only !== true || args.delivery_mode !== "immediate" || args.mode !== "autopilot") {
						hold("dispatch_handoff_unconfirmed", "Handoff must retain its coordinator-only immediate task admission");
					}
					return invoke(name, primary[name], { session_id: text(args.session_id, "attached child", 512),
						message: text(args.message, "exact delegation", 2_000_000), coordinator_only: true, delivery_mode: "immediate", mode: "autopilot" }, correlation);
				case "run_dynamic_workflow": {
					object(args, ["name", "args", "limits"], "exact prepared workflow");
					text(args.name, "workflow name", 512);
					if (!workflow) hold("dispatch_capability_unavailable", "No supported prepared-workflow route");
					const request = { name: text(args.name, "workflow name", 512), ...(args.args !== undefined ? { args: readJsonValue(args.args) } : {}),
						...(args.limits !== undefined ? { limits: readJsonValue(args.limits) } : {}) };
					const raw = await workflow(request, correlation);
					check("uncertain", { name, raw: readJsonValue(raw) });
					return raw;
				}
				default: return hold("dispatch_capability_unavailable", "Operation is outside the native boundary");
			}
		},
	};
	const observations = createNativeObservations({ check, readPlan: plan, readers: access.observations });
	const decodeCreation = access.decodeCreated, decodeHandoff = access.decodeHandoff, decodeRun = access.decodeRun;
	return Object.freeze({
		state: "available", session: { workspacePath: context.workspacePath, sessionId: context.sessionId,
			projectId: context.projectId, inWorkflow: false }, executor, offered: new Set(offered),
		availability(name) { check(); return offered.has(name) ? "supported" : "unavailable"; },
		taskPolicies(requested) {
			requireOwnedPlan(check(), requested);
			const actual = plan(requested.id);
			if (actual.revision !== requested.revision) hold("dispatch_context_stale", "Admission policies require the current plan revision");
			const policies = access.taskPolicies(actual);
			check();
			return structuredClone(policies);
		},
		...observations,
		...(decodeCreation ? { decodeCreated(/** @type {unknown} */ value) {
			check(); const child = createdChild(decodeCreation(value)); check();
			if (child.projectId !== context.projectId || child.creatorSessionId !== context.sessionId) hold("dispatch_child_mismatch", "Created child belongs to another coordinator/project");
			return child;
		} } : {}),
		...(decodeHandoff ? { decodeHandoff(/** @type {unknown} */ value) {
			check(); const result = decodeHandoff(value); check();
			object(result, ["sessionId", "accepted"], "handoff result");
			if (result.accepted !== true) hold("dispatch_handoff_unconfirmed", "No actual admission receipt");
			return { sessionId: text(result.sessionId, "admitted child", 512), accepted: true };
		} } : {}),
		...(decodeRun ? { decodeRun(/** @type {unknown} */ value) {
			check(); const id = text(decodeRun(value), "native run identity", 512); check(); return id;
		} } : {}),
	});
}
