import { randomUUID } from "node:crypto";
import { isRecord, parseJson, readJsonValue } from "../data.mjs";
import { fail, integer, text } from "../factory/fields.mjs";
import { validatePlan } from "../plan/validation.mjs";

/** @typedef {import("../types/json.js").JsonValue} Json */
/** @typedef {{value: unknown, raw: Json, source: string}} NativeResult */

export class DispatchNativeError extends Error {
	/** @param {string} code @param {string} message
	 * @param {"not-started" | "uncertain" | "definitive-failure"} disposition
	 * @param {Json} [receipt] */
	constructor(code, message, disposition, receipt = null) {
		super(message);
		this.code = code;
		this.disposition = disposition;
		this.receipt = receipt;
	}
}

const offeredNames = new Set(["foundry_get_status", "foundry_reserve_task", "foundry_attach_task",
	"foundry_complete_task", "create_session", "get_session", "list_sessions_and_chats", "send_session_message", "run_dynamic_workflow"]);

/**
 * The owner supplies its offered-tool executor, never session.workflow.run or a workflow ctx.
 * Availability is invocation-route-specific; an offered name alone is not proof of support.
 * No automatic alternate route is attempted after a rejected/disabled invocation.
 *
 * @param {{
 * owner: string, sessionId: string,
 * context: () => {owner: string, sessionId: string, inWorkflow: boolean},
 * executor: import("../types/parallel.js").OfferedToolExecutor,
 * offered: ReadonlySet<string>,
 * availability: (name: string) => "supported" | "unavailable" | "unproven"
 * }} options
 */
export function createOfferedDispatchTransport(options) {
	/** @param {string} name */
	function ensure(name) {
		const current = options.context();
		if (current.owner !== options.owner || current.sessionId !== options.sessionId || current.inWorkflow) {
			throw new DispatchNativeError("dispatch_invocation_owner", "Only the owning coordinator outside a workflow may dispatch", "not-started");
		}
		if (!offeredNames.has(name) || !options.offered.has(name) || options.availability(name) !== "supported") {
			throw new DispatchNativeError("dispatch_capability_unavailable", `${name} is not supported on this invocation route; use bounded coordinator reconciliation`, "not-started");
		}
	}
	return {
		owner: options.owner, sessionId: options.sessionId, ensure,
		/** @param {string} name @param {Json} args @param {string} [toolCallId] @returns {Promise<NativeResult>} */
		async call(name, args, toolCallId = randomUUID()) {
			ensure(name);
			text(toolCallId, "native correlation ID", 512);
			const source = `${options.sessionId}/${name}/${toolCallId}`;
			let raw;
			try {
				raw = readJsonValue(await options.executor.execute({ name, arguments: readJsonValue(args), toolCallId }));
			} catch (error) {
				throw new DispatchNativeError("dispatch_transport_uncertain", String(error), "uncertain", { source, error: String(error) });
			}
			const kind = isRecord(raw) ? raw.resultType : undefined;
			const body = typeof raw === "string" ? raw : isRecord(raw) ? raw.textResultForLlm : undefined;
			let value;
			try { value = typeof body === "string" ? parseJson(body) : undefined; }
			catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				value = body;
			}
			const envelopeError = isRecord(value) && value.ok === false && isRecord(value.error) ? value.error : null;
			if (kind !== undefined && kind !== "success" || envelopeError) {
				const message = envelopeError?.message ?? (isRecord(raw) ? raw.error ?? body : body);
				const code = typeof envelopeError?.code === "string" ? envelopeError.code
					: kind === "denied" || kind === "rejected" ? "dispatch_permission_rejected" : "dispatch_native_failure";
				throw new DispatchNativeError(code, String(message), kind === "denied" || kind === "rejected" ? "definitive-failure" : "uncertain", { source, raw });
			}
			if (typeof raw !== "string" && kind !== "success") {
				throw new DispatchNativeError("dispatch_result_unsupported", "Native result is not the offered SDK ToolResult envelope", "uncertain", { source, raw });
			}
			return { value: isRecord(value) && value.ok === true ? value.value : value, raw, source };
		},
	};
}

/** Native reservation/attachment/completion calls remain the existing plan authority.
 * T-003 owns invocation of reserve and the claim/reservation recovery gap.
 * @param {{transport: ReturnType<typeof createOfferedDispatchTransport>}} options */
export function createNativeAdmission({ transport }) {
	/** @param {unknown} value @param {string} planId */
	function ownedPlan(value, planId) {
		const plan = validatePlan(value);
		if (plan.id !== planId || plan.factory?.owner !== transport.owner) fail("dispatch_foreign_plan", "Native result is not this coordinator's owned plan");
		return plan;
	}
	return {
		/** @param {string} planId */
		async status(planId) {
			const result = await transport.call("foundry_get_status", { planId });
			if (!isRecord(result.value)) fail("dispatch_status_unsupported", "Missing native status");
			return { ...result, plan: ownedPlan(result.value.plan, planId) };
		},
		/** @param {import("../types/parallel.js").AdmissionIdentity} identity @param {number} revision */
		async reserve(identity, revision) {
			if (identity.owner !== transport.owner) fail("dispatch_foreign_plan", "Cannot reserve another owner's attempt");
			const result = await transport.call("foundry_reserve_task", {
				planId: identity.planId, taskId: identity.taskId, reservationId: identity.reservationId, expectedRevision: integer(revision, "plan revision", 0),
			});
			if (!isRecord(result.value)) fail("dispatch_reservation_unsupported", "Missing native reservation result");
			const plan = ownedPlan(result.value.plan, identity.planId);
			const attempt = plan.tasks.find(task => task.id === identity.taskId)?.attempts.find(item => item.reservationId === identity.reservationId);
			if (!attempt || attempt.id !== result.value.attemptId || result.value.taskId !== identity.taskId || attempt.baseBranch !== result.value.baseBranch
				|| plan.factory?.repositoryId !== identity.repositoryId) fail("dispatch_reservation_mismatch", "Native reservation identity differs");
			return { ...result, plan, attempt, value: result.value };
		},
		/** @param {import("../types/parallel.js").AttemptIdentity} attempt @param {number} revision
		 * @param {{sessionId: string, branch: string, worktreePath: string, baseCommit: string}} child @param {string} [correlation] */
		async attach(attempt, revision, child, correlation) {
			if (attempt.owner !== transport.owner) fail("dispatch_foreign_plan", "Cannot attach another owner's attempt");
			const result = await transport.call("foundry_attach_task", {
				planId: attempt.planId, taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: revision,
				sessionId: child.sessionId, branch: child.branch,
				bootstrap: { worktreePath: child.worktreePath, baseCommit: child.baseCommit },
			}, correlation);
			const plan = ownedPlan(result.value, attempt.planId);
			const attached = plan.tasks.find(task => task.id === attempt.taskId)?.attempts.find(item => item.id === attempt.attemptId);
			if (attached?.sessionId !== child.sessionId || attached.branch !== child.branch || attached.reservationId !== attempt.reservationId) fail("dispatch_attachment_mismatch", "Attachment postcondition differs");
			return { ...result, plan };
		},
		/** @param {import("../requests.mjs").Request<"completeTask">} request */
		async complete(request) {
			const result = await transport.call("foundry_complete_task", readJsonValue(request));
			const plan = ownedPlan(result.value, text(request.planId, "planId"));
			const attempt = plan.tasks.find(task => task.id === request.taskId)?.attempts.find(item => item.id === request.attemptId);
			if (attempt?.status !== request.status || request.commit && attempt.commit !== request.commit) fail("dispatch_delivery_mismatch", "Completion postcondition differs");
			return { ...result, plan };
		},
	};
}
