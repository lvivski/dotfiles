import { createHash } from "node:crypto";
import { stableStringify } from "../digest.mjs";
import { digest, fail, integer, object, text } from "../factory/fields.mjs";

/** @param {string} prompt */
export const assignmentDigest = prompt => createHash("sha256").update(prompt, "utf8").digest("hex");

/** @param {{planId: string, taskId: string, attemptId: string}} identity */
export const payloadAcknowledgement = identity => `Foundry payload received: ${identity.planId}/${identity.taskId}/${identity.attemptId}`;

/** @param {{planId: string, taskId: string, attemptId: string}} identity */
function gate(identity) {
	return `Receive this complete immutable Foundry assignment, then STOP before task execution.
Before current valid attachment, perform only bounded startup receipt/identity work: do not inspect task source, run task commands, edit files, change branches, create commits, launch workers or materialize inputs.
The assignment below is conditional on successful exact current attachment to its creating coordinator, project, repository, child, physical worktree, reserved base, task and attempt, followed by that coordinator's short identity/digest-bound activation. Receipt alone authorizes no substantive work.
After activation, corroborate those current bindings and cancellation state through supported native authority before acting; missing authoritative observations or permissions are holds. Never accept a stale/foreign activation or a second assignment transmission.
Normal App startup, repository trust and native permissions still apply. Prompt text is not authentication, permission, a sandbox or OS enforcement.
Reply exactly "${payloadAcknowledgement(identity)}" and end this turn; wait for activation of this already-received payload.

`;
}

/** Seal only the final factory-context/input-enriched body.
 * @param {{planId: string, taskId: string, attemptId: string}} identity @param {string} body
 * @returns {import("../types/plan.js").TaskStartup} */
export function sealTaskStartup(identity, body) {
	const delegationPrompt = gate(identity) + text(body, "complete assignment");
	text(delegationPrompt, "complete kickoff");
	return { recipe: "complete-kickoff-v1", assignmentDigest: assignmentDigest(delegationPrompt), delegationPrompt };
}

/** No migration: absence is the original setup/attach/full-handoff recipe.
 * @param {unknown} value @returns {import("../types/plan.js").TaskStartup} */
export function taskStartup(value) {
	object(value, ["recipe", "assignmentDigest", "delegationPrompt"], "sealed startup");
	const delegationPrompt = text(value.delegationPrompt, "complete kickoff");
	const sealedDigest = digest(value.assignmentDigest, "assignment digest");
	if (value.recipe !== "complete-kickoff-v1" || sealedDigest !== assignmentDigest(delegationPrompt)) {
		fail("dispatch_startup_invalid", "Unknown recipe or changed sealed assignment");
	}
	return { recipe: "complete-kickoff-v1", assignmentDigest: sealedDigest, delegationPrompt };
}

/** @param {{planId: string, taskId: string, attemptId: string}} identity @param {unknown} value */
export function startupInitialization(identity, value) {
	const startup = taskStartup(value);
	if (!startup.delegationPrompt.startsWith(gate(identity))) fail("dispatch_startup_invalid", "Startup gate belongs to another task/attempt");
	return {
		recipe: startup.recipe, assignmentDigest: startup.assignmentDigest,
		acknowledgement: payloadAcknowledgement(identity),
		kickoff: { mode: /** @type {const} */ ("interactive"), prompt: startup.delegationPrompt },
	};
}

/** @param {import("../types/parallel.js").ParallelReservation} reservation
 * @param {import("../types/parallel.js").ParallelChild} child @param {number} attachedRevision */
export function taskActivation(reservation, child, attachedRevision) {
	if (!reservation.initialization.recipe) fail("dispatch_startup_invalid", "Legacy reservations require the original full handoff");
	startupInitialization(reservation.attempt, {
		recipe: reservation.initialization.recipe, assignmentDigest: reservation.initialization.assignmentDigest,
		delegationPrompt: reservation.delegationPrompt,
	});
	if (child.projectId !== reservation.projectId) fail("dispatch_child_mismatch", "Activation project differs");
	return {
		recipe: /** @type {const} */ ("complete-kickoff-v1"), attempt: reservation.attempt,
		projectId: reservation.projectId, child,
		baseBranch: reservation.baseBranch, baseCommit: reservation.baseCommit,
		assignmentDigest: reservation.initialization.assignmentDigest,
		attachedRevision: integer(attachedRevision, "attached revision"),
	};
}

/** Keep the legacy journal payload byte-for-byte; the same effect means activation only
 * when its creation reservation explicitly declares the new recipe.
 * @param {import("../types/parallel.js").ParallelReservation} reservation
 * @param {import("../types/parallel.js").ParallelChild} child @param {number} attachedRevision */
export function taskHandoffPayload(reservation, child, attachedRevision) {
	return reservation.initialization.recipe
		? { child, activation: taskActivation(reservation, child, attachedRevision) }
		: { child, delegationPrompt: reservation.delegationPrompt, inputs: reservation.inputs };
}

/** @param {ReturnType<typeof taskActivation>} activation */
export const activationMessage = activation => `Foundry activate received assignment:\n${stableStringify(activation)}`;
