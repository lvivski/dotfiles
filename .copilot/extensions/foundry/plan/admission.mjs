import path from "node:path";
import { fail } from "../factory/fields.mjs";
import { dependencyObservation, resourceClaim, teamClaim } from "./parallel-contracts.mjs";
import { hasSuccessfulDelivery } from "./queries.mjs";
import { resourcePathsMayOverlap, scopesMayOverlap } from "./scope.mjs";

/** @typedef {import("../types/parallel.js").ResourceClaim} ResourceClaim */
/** @typedef {import("../types/parallel.js").TeamClaim} TeamClaim */
/** @typedef {import("../types/parallel.js").AdmissionRecord} AdmissionRecord */
/** @typedef {Pick<AdmissionRecord, "identity" | "phase" | "resources" | "team">} ClaimOccupancy */
/** @typedef {{
 * repositoryId: string, owner: string, planId: string, taskId: string, minimumRevision: number,
 * observation: import("../types/parallel.js").DependencyObservation | null
 * }} ExternalDependency */
/** @typedef {{resources: ResourceClaim[], team: TeamClaim | null, dependencies: ExternalDependency[]}} TaskAdmission */
/** @typedef {{
 * repositoryId: string, owner: string, authorized: boolean, now: string,
 * tasks: Record<string, TaskAdmission>, claims: AdmissionRecord[]
 * }} AdmissionContext */
/** @typedef {{kind: "dependency" | "scope" | "resource" | "team" | "authority" | "observation-completeness", code: string, subject: string}} AdmissionHold */

/** Claim labels are not physical resource identities. Normalize conservatively.
 * @param {ResourceClaim} resource */
export function resourceKey(resource) {
	return JSON.stringify([resource.kind, path.posix.normalize(resource.scope.replace(/\\/g, "/")).toLowerCase()]);
}

/** Path resources reserve their descendants; other kinds retain exact identity semantics.
 * @param {ResourceClaim} left @param {ResourceClaim} right */
function resourcesMayOverlap(left, right) {
	if (left.kind !== right.kind) return false;
	return left.kind === "shared-write" || left.kind === "worktree-build"
		? resourcePathsMayOverlap(left.scope, right.scope)
		: resourceKey(left) === resourceKey(right);
}

/** @param {ResourceClaim[]} resources @param {TeamClaim | null} team */
export function validateClaims(resources, team) {
	const claims = resources.map(resourceClaim);
	if (new Set(claims.map(resourceKey)).size !== claims.length) {
		fail("parallel_duplicate_resource", "A physical resource can appear only once in an admission");
	}
	return { resources: claims, team: team === null ? null : teamClaim(team) };
}

/** Shared by projection and the serialized writer; settled claims still consume capacity.
 * @param {string} repositoryId @param {ResourceClaim[]} resources
 * @param {TeamClaim | null} team @param {ClaimOccupancy[]} records
 * @returns {AdmissionHold[]} */
export function claimHolds(repositoryId, resources, team, records) {
	({ resources, team } = validateClaims(resources, team));
	const held = records.filter(record => record.identity.repositoryId === repositoryId && record.phase !== "released");
	/** @type {AdmissionHold[]} */
	const reasons = [];
	for (const resource of resources) {
		const existing = held.flatMap(record => record.resources).filter(other => resourcesMayOverlap(resource, other));
		if (existing.some(other => other.capacity !== resource.capacity)) {
			reasons.push({ kind: "resource", code: "resource-configuration-conflict", subject: resource.scope });
		} else if (existing.some(other => other.mode === "exclusive" || resource.mode === "exclusive")
			|| existing.reduce((sum, other) => sum + other.units, 0) + resource.units > resource.capacity) {
			reasons.push({ kind: "resource", code: "resource-claimed", subject: resource.scope });
		}
	}
	if (team) {
		const existing = held.flatMap(record => record.team?.id === team.id ? [record.team] : []);
		if (existing.some(other => other.capacity !== team.capacity)) {
			reasons.push({ kind: "team", code: "team-configuration-conflict", subject: team.id });
		} else if (existing.reduce((sum, other) => sum + other.units, 0) + team.units > team.capacity) {
			reasons.push({ kind: "team", code: "team-capacity", subject: team.id });
		}
	}
	return reasons;
}

/** External observations are availability evidence only, never local completion or authority.
 * @param {ExternalDependency[]} dependencies @param {string} now @returns {AdmissionHold[]} */
export function observationHolds(dependencies, now) {
	const time = Date.parse(now);
	if (!Number.isFinite(time)) fail("parallel_observation_time", "Readiness needs an explicit valid observation time");
	return dependencies.flatMap(dependency => {
		const observation = dependency.observation === null ? null : dependencyObservation(dependency.observation);
		const subject = `${dependency.owner}/${dependency.planId}/${dependency.taskId}`;
		if (!Number.isSafeInteger(dependency.minimumRevision) || dependency.minimumRevision < 1) {
			fail("parallel_observation_revision", "An external dependency requires an explicit positive minimum revision");
		}
		let code;
		if (!observation || !observation.complete) code = "observation-incomplete";
		else if (observation.repositoryId !== dependency.repositoryId || observation.owner !== dependency.owner
			|| observation.planId !== dependency.planId || observation.taskId !== dependency.taskId) code = "observation-identity";
		else if (observation.revision < dependency.minimumRevision
			|| Date.parse(observation.capturedAt) > time || Date.parse(observation.validUntil) <= time) code = "observation-stale";
		else if (observation.status !== "available" || !observation.commit) code = "observation-unavailable";
		return code ? [{ kind: /** @type {const} */ ("observation-completeness"), code, subject }] : [];
	});
}

/** Deterministic greedy admission; no attempts, grants or native effects are created here.
 * Omitted context preserves legacy plans; supplied context requires explicit task policies.
 * Candidate filtering limits speculative selection, never actual occupancy or readiness checks.
 * @param {import("../types/plan.js").FoundryPlan} plan
 * @param {AdmissionContext} [context]
 * @param {{scopeOverrideTaskId?: string, candidateTaskIds?: string[]}} [options] */
export function projectAdmission(plan, context, options = {}) {
	const retained = new Set(context?.claims.filter(record => record.phase !== "released"
		&& record.identity.repositoryId === plan.factory?.repositoryId
		&& record.identity.owner === plan.factory?.owner
		&& record.identity.planId === plan.id).map(record => record.identity.taskId) ?? []);
	const active = plan.tasks.filter(task => task.status === "running" || retained.has(task.id));
	const occupied = [...active];
	const candidates = options.candidateTaskIds === undefined ? null : new Set(options.candidateTaskIds);
	/** @type {ClaimOccupancy[]} */
	const claims = context ? [...context.claims] : [];
	/** @type {{taskId: string, reasons: AdmissionHold[]}[]} */
	const holds = [];
	/** @type {string[]} */
	const dispatchableTaskIds = [];
	for (const task of [...plan.tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
		if (task.status !== "planned" && task.status !== "ready") continue;
		if (candidates && !candidates.has(task.id)) continue;
		/** @type {AdmissionHold[]} */
		const reasons = [];
		if (!["approved", "running"].includes(plan.status)) reasons.push({ kind: "authority", code: "plan-not-approved", subject: plan.id });
		for (const id of task.dependsOn) {
			if (!hasSuccessfulDelivery(plan.tasks.find(dependency => dependency.id === id))) {
				reasons.push({ kind: "dependency", code: "dependency-delivery-missing", subject: id });
			}
		}
		if (options.scopeOverrideTaskId !== task.id && occupied.some(other => scopesMayOverlap(task.expectedFiles, other.expectedFiles))) {
			reasons.push({ kind: "scope", code: "scope-overlap", subject: task.id });
		}
		const policy = context?.tasks[task.id];
		if (context) {
			if (!context.authorized || context.repositoryId !== plan.factory?.repositoryId || context.owner !== plan.factory?.owner) {
				reasons.push({ kind: "authority", code: "owner-authority-required", subject: plan.id });
			}
			if (!policy) reasons.push({ kind: "authority", code: "admission-configuration-missing", subject: task.id });
			else {
				reasons.push(...observationHolds(policy.dependencies, context.now));
				reasons.push(...claimHolds(context.repositoryId, policy.resources, policy.team, claims));
			}
			if (claims.some(record => record.phase !== "released" && record.identity.repositoryId === context.repositoryId
				&& record.identity.owner === context.owner && record.identity.planId === plan.id && record.identity.taskId === task.id)) {
				reasons.push({ kind: "resource", code: "reservation-reconciliation-required", subject: task.id });
			}
		}
		if (reasons.length) holds.push({ taskId: task.id, reasons });
		else {
			dispatchableTaskIds.push(task.id);
			occupied.push(task);
			if (context && policy) claims.push({
				identity: { repositoryId: context.repositoryId, owner: context.owner, planId: plan.id, taskId: task.id, reservationId: `projection:${task.id}` },
				phase: "claim-held", resources: policy.resources, team: policy.team,
			});
		}
	}
	return { dispatchableTaskIds, heldTaskIds: holds.map(hold => hold.taskId), occupiedTaskIds: active.map(task => task.id).sort(), holds };
}
