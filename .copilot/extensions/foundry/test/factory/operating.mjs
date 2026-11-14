import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { analysisInputDigest } from "../../digest.mjs";
import { createFactoryService } from "../../factory.mjs";
import { effectiveOperatingRecords } from "../../factory/operating.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createAdmissionStore } from "../../storage/admission.mjs";
import { attachTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { fixtureRoot, seedRepository } from "../git.mjs";
import { makePlan } from "../storage/fixture.mjs";

/** @typedef {import("../../types/operating.js").OperatingRecord} OperatingRecord */
/** @typedef {import("../../types/operating.js").OperatingRules} Rules */
export const historicalIdentity = {
	version: /** @type {const} */ (1), kind: /** @type {const} */ ("app"),
	identity: analysisInputDigest("fixture-worker"), source: analysisInputDigest("fixture-source"),
	authority: /** @type {const} */ ("historical"),
};
/** @param {string} [id] @param {number} [revision] @returns {import("../../types/operating.js").OperatingCharter} */
export function charter(id = "squad", revision = 1) {
	return { version: 1, kind: "charter", id, revision, previous: revision === 1 ? null : { id, revision: revision - 1 },
		source: historicalIdentity, context: [], name: "Fixture squad", purpose: "Exercise the frozen canonical store contract",
		accountable: historicalIdentity, scope: ["fixture"], decisions: ["observation", "proposal"] };
}
/** @param {string} id @param {number} [revision] @returns {import("../../types/operating.js").OperatingGoal} */
export function goal(id, revision = 1) {
	return { version: 1, kind: "goal", id, revision, previous: revision === 1 ? null : { id, revision: revision - 1 },
		source: historicalIdentity, context: [], title: "Fixture goal", intent: "Keep acceptance open without evidence",
		charter: { id: "squad", revision: 1 }, authority: "proposed", contract: null,
		criteria: [{ id: "criterion", statement: "Independently evaluate the boundary", obligation: null, evaluations: [], dependsOn: [],
			environment: "fixture-node", workload: "fixture" }], preserves: ["user data"], relationshipCoverage: "partial", candidateId: null };
}
/** Synthetic domain rule, not squad policy or goal assurance: at most one goal may
 * consume a fixture-only exclusive label. Different goal revisions can write-skew it.
 * Leaves replace these validators with their own production policy. */
export const fixtureRules = /** @satisfies {Rules} */ ({
	charters(state, records) {
		for (const record of [...effectiveOperatingRecords(state), ...records]) {
			if (record.kind === "charter") assert.ok(record.scope.includes("fixture"), "fixture charter scope required");
		}
	},
	goals(state, records) {
		const effective = new Map([...effectiveOperatingRecords(state), ...records].map(record => [record.id, record]));
		assert.ok([...effective.values()].filter(record => record.kind === "goal" && record.intent === "exclusive").length <= 1,
			"fixture cross-record invariant");
	},
});

/** Every repository/common directory, SQLite store and output is under the runner's
 * private cwd. Native observations are synthetic; authorization/storage are real.
 * @param {import("node:test").TestContext} t
 * @param {{rules?: Rules, local?: boolean}} [options] */
export async function operatingFixture(t, options = {}) {
	const root = await fixtureRoot(t, "operating");
	const repo = path.join(root, "repo");
	const storageRoot = path.join(root, "factory");
	const owner = path.join(root, "owner");
	await mkdir(repo); await mkdir(storageRoot); await mkdir(owner);
	seedRepository(repo);
	const base = createFactoryService({ repositoryPath: repo, storageRoot, knowledge: options.local ? "local" : "repository" });
	base.createUnit({ expectedRevision: 0, id: "unit", name: "Fixture", purpose: "Canonical checkpoint",
		boundary: { owns: ["fixture"], exposes: ["fixture"], consumes: [], preserves: ["history"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture" });
	const store = createPlanStore({ workspacePath: owner });
	let plan = makePlan(repo, "operating-plan");
	plan.factory = { repositoryId: base.repository.id, unitId: "unit", unitRevision: 1, candidateId: null,
		contractRevision: null, contractDigest: null, contextDigest: null, blueprintDigest: analysisInputDigest("fixture-blueprint"), owner };
	plan = await store.create(plan, 0);
	const approved = approvePlan(transitionPlan(plan, "awaiting-approval"), "fixture");
	plan = await store.update(plan.id, plan.revision, reserveTaskAttempt(approved, "T-001", { reservationId: "fixture-reservation" }));
	plan = await store.update(plan.id, plan.revision, attachTaskAttempt(plan, "T-001", "T-001-A001", { sessionId: "fixture-worker", branch: "fixture/model" }));
	const admission = createAdmissionStore({ workspacePath: root, directoryParts: ["admission"], repositoryId: base.repository.id, owner });
	const identity = { repositoryId: base.repository.id, owner, planId: plan.id, taskId: "T-001", reservationId: "fixture-reservation" };
	const claim = admission.claim({ identity, expectedRevision: 0, resources: [], team: null });
	const bound = admission.bindReservation({ admission: identity, revision: claim.revision, epoch: claim.epoch }, { ...identity, attemptId: "T-001-A001" });
	const fence = { admission: identity, revision: bound.revision, epoch: bound.epoch };
	const observation = { allowed: true, sessionId: "fixture-worker" };
	/** @type {import("../../types/operating.js").OperatingNativePort} */
	const native = { assertAuthority(current, authority) {
		assert.ok(observation.allowed, "fixture native denial");
		assert.equal(current.factory?.owner, owner);
		assert.equal(authority.binding?.projectId, "fixture-project");
		assert.equal(authority.binding?.sessionId, observation.sessionId);
	} };
	const rules = options.rules ?? fixtureRules;
	const ports = { rules, persistence: store.operating, admission, native };
	const open = () => createFactoryService({ repositoryPath: repo, storageRoot, knowledge: options.local ? "local" : "repository", operating: ports });
	const factory = open();
	/** @returns {import("../../types/operating.js").OperatingAuthority} */
	const authority = () => ({
		planId: plan.id, expectedPlanRevision: store.readCurrent(plan.id).revision, taskId: "T-001", attemptId: "T-001-A001",
		fence, delegationId: null, references: [], binding: { charter: { id: "squad", revision: 1 }, projectId: "fixture-project",
			sessionId: "fixture-worker", owner, planId: plan.id, taskId: "T-001", attemptId: "T-001-A001", observationDigest: analysisInputDigest("fixture-observation") },
	});
	/** @param {string} id @param {OperatingRecord[]} records */
	const batch = (id, records) => factory.operating.prepare({ version: 1, id, snapshot: factory.operating.snapshot().token, records, source: historicalIdentity });
	return { root, repo, storageRoot, owner, store, planId: plan.id, admission, fence, observation, native, ports, factory, open, authority, batch };
}
