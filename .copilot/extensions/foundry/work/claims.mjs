import { randomUUID } from "node:crypto";
import { outstanding } from "./effects.mjs";
import { current, requireAdmission, requireOwner, requireReporter } from "./policy.mjs";
import { FoundryError, containsPath, resourcePath, text } from "./values.mjs";

/** @typedef {import("./model.d.ts").Attempt} Attempt */
/** @typedef {import("./model.d.ts").Claim} Claim */

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt */
export function releaseOwnedClaims(tx, attempt) {
	if (attempt.nativeId === undefined || !["done", "failed", "cancelled"].includes(attempt.state) || attempt.endedBy !== attempt.nativeId
		|| outstanding(tx, attempt, true) || tx.get("tasks", attempt.taskId).repairReservation?.attemptId === attempt.id) return;
	tx.db.prepare("DELETE FROM claims WHERE json_extract(document,'$.attemptId')=?").run(attempt.id);
}

/** @param {import("./database.mjs").Transaction} tx @param {{attemptId: string, surface: string, resource: string}} input @param {string} actor @returns {Claim} */
export function claim(tx, input, actor) {
	const attempt = tx.get("attempts", input.attemptId);
	const task = current(tx, attempt);
	requireAdmission(tx, task);
	requireOwner(tx, task, actor);
	const surface = text(input.surface, "surface");
	const resource = resourcePath(input.resource);
	if (!task.scope.paths.some((base) => containsPath(base, resource))) {
		throw new FoundryError("scope_widening", "Claim is outside the task's path scope");
	}
	if (!attempt.slot) throw new FoundryError("capacity_required", "A write claim requires admitted execution");
	if (!["prepared", "issued", "running"].includes(attempt.state)) {
		throw new FoundryError("invalid_transition", "A terminal or waiting attempt cannot acquire new write claims");
	}
	for (const claim of tx.list("claims", "WHERE json_extract(document,'$.surface')=?", [surface])) {
		if (claim.attemptId === attempt.id && claim.resource === resource) return claim;
		if (claim.attemptId !== attempt.id && (containsPath(claim.resource, resource) || containsPath(resource, claim.resource))) {
			throw new FoundryError("claim_conflict", `Surface ${surface} is already claimed at ${claim.resource}`);
		}
	}
	const claim = { id: randomUUID(), attemptId: attempt.id, surface, resource };
	tx.put("claims", claim);
	return claim;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} claimId @param {string} actor @returns {Claim} */
export function releaseClaim(tx, claimId, actor) {
	const claim = tx.get("claims", claimId);
	const attempt = tx.get("attempts", claim.attemptId);
	requireReporter(tx, attempt, actor);
	if (outstanding(tx, attempt, true)) throw new FoundryError("effects_outstanding", "This attempt's substantive issued effects must settle before releasing its claim");
	tx.db.prepare("DELETE FROM claims WHERE id=?").run(claimId);
	return claim;
}
