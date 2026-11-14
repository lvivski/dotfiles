import { readJsonValue } from "../data.mjs";
import { object, text } from "../factory/fields.mjs";
import { DispatchNativeError } from "./admission.mjs";
import { createNativeHost, createRpcWarmHandoffRoute, createRpcWorkflowRoute } from "./host.mjs";

/** @typedef {import("../types/parallel.js").NativeCapability} Capability */
/** @typedef {import("../types/repair.js").RepairSession} Session */

const route = "extension-rpc";
const prerequisites = Object.freeze({
	create_session: "authenticated setup acknowledgement and canonical child/Git observations",
	get_session: "operation-specific supported RPC binding and authenticated canonical child observations",
	list_sessions_and_chats: "operation-specific supported RPC binding and exhaustive authenticated session/run inventory",
	foundry_get_status: "operation-specific permission-preserving RPC admission binding",
	foundry_reserve_task: "operation-specific permission-preserving RPC admission binding",
	foundry_attach_task: "operation-specific permission-preserving RPC admission binding",
	foundry_complete_task: "operation-specific permission-preserving RPC admission binding",
	cold_first_assignment: "App support for coordinator-only cold admission before bootstrap",
	observeSetup: "authenticated cross-child setup transcript provider",
	observeChild: "authenticated current child/project/creator/worktree/base/Git provider",
	reconcile: "authoritative correlated original native operation result provider",
	observeRecovery: "exhaustive authenticated current session AND run termination provider",
	observeOutcomes: "authoritative correlated native effect outcome provider",
	readReviews: "independent current delivery-bound review-authority provider",
	readContributors: "complete current delivery-bound contributor provider, including runtime helpers",
	technical_execution: "bounded permission-preserving TechnicalExecutor provider",
	completion_notification: "canonical completion notification identity and existing retention transaction/outbox",
	retention_persistence: "existing canonical archive transaction/outbox; dispatch storage is not a substitute",
	archive_session: "preserved artifacts, current eligibility/holds, host-wide action-time/all-writer guard, native permission and correlated original-result reconciliation",
});

/** Bind only public offered-tool callbacks. No metadata lookup, permission override,
 * SDK launcher, second journal, event invention or alternate-route replay.
 * @param {{getSession: () => Session | null | undefined}} options */
export function createSupportedRuntime({ getSession }) {
	function session() {
		const current = getSession();
		if (!current?.sessionId || !current.workspacePath || typeof current.rpc?.tools?.execute !== "function") {
			throw new DispatchNativeError("dispatch_identity_unavailable",
				"Current owning extension session and public tools.execute binding are required", "not-started",
				{ route, prerequisite: "current native owner session/workspace and tools.execute", disposition: "held" });
		}
		return { sessionId: current.sessionId, workspacePath: current.workspacePath,
			rpc: { tools: current.rpc.tools }, execute: current.rpc.tools.execute };
	}
	/** @template T @param {string} operation @param {(current: ReturnType<typeof session>) => Promise<T>} invoke */
	async function call(operation, invoke) {
		const before = session();
		const raw = await invoke(before);
		const after = getSession();
		if (!after || after.sessionId !== before.sessionId || after.workspacePath !== before.workspacePath
			|| after.rpc?.tools !== before.rpc.tools || after.rpc?.tools?.execute !== before.execute) {
			throw new DispatchNativeError("dispatch_invocation_owner", "Native owner changed during admission; reconcile the original operation",
				"uncertain", { operation, route, raw: readJsonValue(raw) });
		}
		return raw;
	}
	/** @param {Parameters<ReturnType<typeof createRpcWorkflowRoute>>[0]} args @param {string} correlation */
	const workflow = (args, correlation) => call("run_dynamic_workflow", current => createRpcWorkflowRoute(current)(args, correlation));
	/** @param {Parameters<ReturnType<typeof createRpcWarmHandoffRoute>>[0]} args @param {string} correlation */
	const warmHandoff = (args, correlation) => call("send_session_message", current => createRpcWarmHandoffRoute(current)(args, correlation));
	/** Callable is not admitted or effected. Native receipts, not this projection,
	 * establish those later stages for a particular operation.
	 * @returns {Capability[]} */
	function capabilities() {
		const current = getSession();
		const callable = Boolean(current?.sessionId && current.workspacePath && typeof current.rpc?.tools?.execute === "function");
		return [
			...["run_dynamic_workflow", "send_session_message"].map(operation => ({
				operation, route, advertised: null, callable, admission: /** @type {const} */ ("unobserved"),
				effect: /** @type {const} */ ("unobserved"), disposition: callable ? /** @type {const} */ ("callable") : /** @type {const} */ ("held"),
				prerequisite: callable ? null : "current native owner session/workspace and tools.execute",
			})),
			...Object.entries(prerequisites).map(([operation, prerequisite]) => ({
				operation, route, advertised: null, callable: false, admission: /** @type {const} */ ("unobserved"),
				effect: /** @type {const} */ ("unobserved"), disposition: /** @type {const} */ ("held"), prerequisite,
			})),
		];
	}
	/** The SDK does not expose authenticated project/observation authority here.
	 * Trusted host integration may bind it, but tool JSON and metadata cannot.
	 * @param {Omit<import("./host.mjs").NativeHostAccess, "route" | "primary" | "workflow" | "warmHandoff">} [access]
	 * @returns {import("../types/parallel.js").ParallelHost} */
	function host(access) {
		if (access) {
			const current = () => {
				const owner = session(), context = access.current();
				if (!context || context.sessionId !== owner.sessionId || context.workspacePath !== owner.workspacePath) {
					throw new DispatchNativeError("dispatch_invocation_owner",
						"Trusted host context must retain the actual owning extension session and workspace", "not-started",
						{ operation: "parallel-host", route, prerequisite: "matching current native owner", disposition: "held" });
				}
				return context;
			};
			return { ...createNativeHost({ ...access, current, route, workflow, warmHandoff }), route,
				capability: operation => capabilities().find(item => item.operation === operation) };
		}
		return { state: "partial", route, capabilities: capabilities(),
			reason: "Workflow and warm coordinator-only callbacks are bound; automatic parallel admission still requires authenticated current project, setup, child and recovery providers" };
	}
	/** A canonical notification may trigger assessment only through the existing
	 * retention binding. No completion payload, cleanup flag or archive call is accepted.
	 * @param {unknown} input
	 * @param {(repositoryPath: string) => Pick<ReturnType<typeof import("../application/retention.mjs").createRetentionOperations>, "completionEvent">} retentionFor */
	async function completionEvent(input, retentionFor) {
		object(input, ["repositoryPath", "eventId"], "canonical completion notification");
		session();
		const repositoryPath = text(input.repositoryPath, "repository path", 4096);
		const eventId = text(input.eventId, "canonical completion event", 256);
		return retentionFor(repositoryPath).completionEvent({ eventId });
	}
	return Object.freeze({ route, workflow, warmHandoff, capabilities, host, completionEvent });
}
