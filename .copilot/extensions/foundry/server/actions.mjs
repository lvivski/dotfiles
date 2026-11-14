import { isOneOf } from "../data.mjs";
import { FoundryHttpError, json } from "./http.mjs";

/** @typedef {Pick<import("@github/copilot-sdk").SessionUiApi, "confirm" | "elicitation">} FoundryUi */

/**
 * Validates an explicitly supplied actor identity.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireActor(value, field) {
	if (typeof value !== "string"
		|| value.trim().length === 0 || value.includes("\0")) {
		throw new FoundryHttpError(
			400,
			`${field} must be a non-empty string without NUL`,
		);
	}
	return value;
}

/** @param {Record<string, unknown>} body @param {string} planId */
function actionMessage(body, planId) {
	switch (body?.action) {
		case "approve":
			if (!isOneOf(body.approvalType, ["plan", "completion"])) {
				throw new FoundryHttpError(400, "Canvas approvalType must be plan or completion");
			}
			return body.approvalType === "plan"
				? `Approve plan ${planId} at revision ${body.revision} and make dependency-ready tasks available?`
				: `Approve plan ${planId} at revision ${body.revision} as complete?`;
		case "cancel":
			return `Request cancellation for ${planId} at revision ${body.revision}? External App sessions keep running until explicitly stopped.`;
		case "decide-candidate":
			if (!isOneOf(body.decision, ["accept", "reject"]) || typeof body.candidateId !== "string"
				|| !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(body.candidateId)
				|| typeof body.factoryRevision !== "number" || !Number.isSafeInteger(body.factoryRevision) || body.factoryRevision < 1) {
				throw new FoundryHttpError(400, "A candidate, decision and repository revision are required");
			}
			return `${body.decision === "accept" ? "Select" : "Reject"} candidate ${body.candidateId} at repository revision ${body.factoryRevision}? Selection records authority only; it does not deploy, merge or delete artifacts.`;
		case "sync-factory":
			return `Recover repository learning and evidence from persisted attempts in ${planId}? No requirements or candidates will be approved.`;
		case "retry":
			if (typeof body.taskId !== "string" || !body.taskId.trim()) {
				throw new FoundryHttpError(400, "A task ID is required");
			}
			return `Retry ${body.taskId} in plan ${planId} with a fresh attempt?`;
		case "pause-workflow":
		case "resume-workflow":
			if (typeof body.runId !== "string" || !body.runId.trim()) {
				throw new FoundryHttpError(400, "A workflow run ID is required");
			}
			return body.action === "pause-workflow"
				? `Pause workflow ${body.runId}? In-flight work may need to repeat on resume. App task sessions keep running.`
				: `Resume workflow ${body.runId} with its existing journal and limits? This does not approve the plan.`;
		default:
			throw new FoundryHttpError(404, "Unknown canvas action");
	}
}

/**
 * Collect native decisions server-side; renderer fields are not approval evidence.
 * @param {FoundryUi} ui
 * @param {Record<string, unknown>} body
 * @param {string} message
 */
async function nativeActionInput(ui, body, message) {
	if (body.action === "decide-candidate") {
		const result = await ui.elicitation({
			message,
			requestedSchema: {
				type: "object",
				properties: {
					actor: { type: "string", title: "Decision by", minLength: 1 },
					reason: { type: "string", title: "Decision reason", minLength: 1 },
				},
				required: ["actor", "reason"],
			},
		});
		if (result.action === "decline" || result.action === "cancel") return null;
		if (result.action !== "accept") throw new FoundryHttpError(400, "Invalid native dialog response");
		return { ...body, actor: requireActor(result.content?.actor, "actor"), reason: result.content?.reason };
	}
	if (body.action !== "approve" && body.action !== "cancel") {
		return await ui.confirm(message) === true ? body : null;
	}
	const approval = body.action === "approve";
	const result = await ui.elicitation({
		message,
		requestedSchema: {
			type: "object",
			properties: approval ? {
				approvedBy: { type: "string", title: "Approved by", minLength: 1 },
			} : {
				requestedBy: { type: "string", title: "Requested by", minLength: 1 },
				reason: { type: "string", title: "Cancellation reason", minLength: 1 },
			},
			required: approval ? ["approvedBy"] : ["requestedBy", "reason"],
		},
	});
	if (result.action === "decline" || result.action === "cancel") return null;
	if (result.action !== "accept") throw new FoundryHttpError(400, "Invalid native dialog response");
	return approval
		? { ...body, approvedBy: requireActor(result.content?.approvedBy, "approvedBy") }
		: {
			...body,
			requestedBy: requireActor(result.content?.requestedBy, "requestedBy"),
			reason: result.content?.reason,
		};
}

/** @param {{
 * operations: Pick<import("../operations.mjs").FoundryOperations, "getPlan" | "factoryAction" | "controlWorkflow" | "approve" | "retry" | "cancel" | "syncFactory">,
 * planId: string | undefined,
 * getUi: (() => FoundryUi | undefined) | undefined,
 * broadcast: () => void,
 * }} dependencies */
export function createActionController({ operations, planId, getUi, broadcast }) {

	/** @type {Set<AbortController>} */
	const actionWaits = new Set();

	let nativeDialogPending = false;

	/** @param {Record<string, unknown>} body @param {boolean} [mutate] */
	const candidateDecision = async (body, mutate = false) => {
		const plan = await operations.getPlan({ planId });
		if (!plan.factory) throw new FoundryHttpError(400, "Plan has no durable capability context");
		const unitId = plan.factory.unitId;
		const current = await operations.factoryAction({
			repositoryPath: plan.repository.workingDirectory, action: "inspect",
			input: { candidateId: body.candidateId, includeRetired: true },
		});
		if (current.revision !== body.factoryRevision) throw new FoundryHttpError(409, "Repository authority changed; refresh before deciding", "revision_conflict");
		if (!current.candidates.some((entry) => entry.id === body.candidateId && entry.unitId === unitId)) {
			throw new FoundryHttpError(400, "Candidate does not belong to this board's capability");
		}
		if (mutate) return operations.factoryAction({
			repositoryPath: plan.repository.workingDirectory, action: "decideCandidate",
			input: {
				expectedRevision: body.factoryRevision, candidateId: body.candidateId, action: body.decision,
				expectedIncumbentId: body.expectedIncumbentId, actor: requireActor(body.actor, "actor"), reason: body.reason,
			},
		});
	};
	/** @param {Record<string, unknown>} body @param {import("node:http").ServerResponse} response */
	async function handle(body, response) {
		if (!planId) throw new FoundryHttpError(403, "This board is read-only");

		const ui = getUi?.();
		if (!ui && body?.confirmed !== true) {
			throw new FoundryHttpError(400, "Explicit confirmation is required");
		}
		const message = actionMessage(body, planId);
		const controller = new AbortController();
		actionWaits.add(controller);
		const disconnected = () => controller.abort();
		response.once("close", disconnected);
		try {
			if (ui) {
				if (nativeDialogPending) {
					throw new FoundryHttpError(409, "A decision is already pending for this board");
				}
				nativeDialogPending = true;
				try {
					const original = await operations.getPlan({ planId });
					if (original.revision !== body.revision) {
						throw new FoundryHttpError(409, "Plan changed; refresh before deciding", "revision_conflict");
					}
					if (body.action === "decide-candidate") await candidateDecision(body);
					controller.signal.throwIfAborted();
					const decision = await nativeActionInput(ui, body, message);
					controller.signal.throwIfAborted();
					if (!decision) {
						json(response, 200, { ok: true, cancelled: true });
						return;
					}
					body = decision;
					const current = await operations.getPlan({ planId });
					controller.signal.throwIfAborted();
					if (current.revision !== body.revision) {
						throw new FoundryHttpError(409, "Plan changed while awaiting your decision; refresh and decide again", "revision_conflict");
					}
				} finally {
					nativeDialogPending = false;
				}
			}
			/** @type {import("@github/copilot-sdk").WorkflowRunResult | undefined} */
			let workflowResult;
			if (body.action === "pause-workflow" || body.action === "resume-workflow") {
				workflowResult = await operations.controlWorkflow({
					runId: body.runId,
					action: body.action === "pause-workflow" ? "pause" : "resume",
					planId,
					expectedRevision: body.revision,
				}, { signal: controller.signal });
			} else if (body.action === "approve") {
				await operations.approve({
					planId,
					expectedRevision: body.revision,
					approvedBy: requireActor(body.approvedBy, "approvedBy"),
					approvalType: body.approvalType,
				});
			} else if (body.action === "retry") {
				await operations.retry({
					planId,
					taskId: body.taskId,
					expectedRevision: body.revision,
				});
			} else if (body.action === "cancel") {
				await operations.cancel({
					planId,
					expectedRevision: body.revision,
					requestId: body.requestId,
					reason: body.reason,
					requestedBy: requireActor(body.requestedBy, "requestedBy"),
				});
			} else if (body.action === "decide-candidate") {
				await candidateDecision(body, true);
				broadcast();
			} else if (body.action === "sync-factory") {
				await operations.syncFactory({ planId });
				broadcast();
			}
			json(response, 200, {
				ok: true,
				value: {
					action: body.action,
					...(workflowResult ? {
						runId: workflowResult.runId,
						status: workflowResult.status,
						...(workflowResult.error ? { error: workflowResult.error } : {}),
					} : {}),
				},
			});
			return;
		} finally {
			response.off("close", disconnected);
			actionWaits.delete(controller);
		}

	}
	return {
		handle,
		close() {
			for (const controller of actionWaits) controller.abort();
			actionWaits.clear();
		},
	};
}
