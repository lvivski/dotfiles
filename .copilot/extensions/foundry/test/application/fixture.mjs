import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	rm
} from "node:fs/promises";
import path from "node:path";
import { createFactoryService } from "../../factory.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { EVIDENCE_TYPE, TASK_STATUS } from "../../plan/values.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { COMMIT, git, seedRepository } from "../git.mjs";

/** @typedef {import("../../types/workflow.js").WorkflowAnalysisPort} AnalysisPort */
/** @typedef {import("../../operations.mjs").FoundryOperations} Operations */
/** @typedef {{operations: Operations, notifications: import("../../types/plan.js").ChangeEvent[], workspacePath: string}} OperationsFixture */

/** @template T @param {(fixture: OperationsFixture) => T | Promise<T>} operation @param {Partial<import("../../operations.mjs").FoundryOperationsOptions>} [options] */
export async function withOperations(operation, options = {}) {
	const workspacePath = path.resolve(`.foundry-operations-${randomUUID()}`);
	await mkdir(workspacePath, { mode: 0o700 });
	seedRepository(workspacePath);
	const factory = createFactoryService({ repositoryPath: workspacePath, storageRoot: workspacePath });
	const { unit } = factory.createUnit({
		expectedRevision: 0, id: "operation-capability", name: "Operation capability", purpose: "Exercise the coordinator",
		boundary: { owns: ["fixture"], exposes: ["fixture API"], consumes: [], preserves: ["fixture behavior"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture",
	});
	assert.ok(unit);
	/** @type {import("../../types/plan.js").ChangeEvent[]} */
	const notifications = [];
	const analysis = options.analysis ?? analysisStub();
	const importPlanning = analysis.importPlanning;
	analysis.importPlanning = async (...args) => ({
		...await importPlanning(...args),
		factoryContext: {
			repositoryId: factory.repository.id, unitId: unit.id, unitRevision: unit.revision,
			owner: workspacePath, unit, contract: null, knowledge: [], authority: "discovery-only",
		},
	});
	const operations = createFoundryOperations({
		getWorkspacePath: () => workspacePath,
		notify: (event) => notifications.push(event),
		factoryStorageRoot: workspacePath,
		...options,
		analysis,
	});
	try {
		return await operation({ operations, notifications, workspacePath });
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
}

/** @returns {import("../../types/plan.js").PlanBlueprint} */
export function planBlueprint() {
	return {
		title: "Operation plan",
		objective: "Exercise the complete Foundry coordinator lifecycle",
		constraints: ["Keep task scopes separate"],
		tasks: [
			{
				id: "T-001",
				title: "Foundation",
				kind: "implement",
				description: "Create the foundation",
				dependsOn: [],
				acceptanceCriteria: ["Foundation is present"],
				expectedFiles: ["src/foundation.mjs"],
				deliveryRequirement: "branch",
			},
			{
				id: "T-002",
				title: "Integration",
				kind: "implement",
				description: "Integrate the foundation",
				dependsOn: ["T-001"],
				acceptanceCriteria: ["Integration is complete"],
				expectedFiles: ["src/integration.mjs"],
				deliveryRequirement: "commit",
			},
			{
				id: "T-003",
				title: "Verify",
				kind: "verify",
				description: "Verify the final delivery",
				dependsOn: ["T-002"],
				acceptanceCriteria: [],
				expectedFiles: [],
				deliveryRequirement: "commit",
			},
		],
	};
}

/** @param {string} workspacePath */
export function createInput(workspacePath) {
	return {
		expectedRevision: 0,
		id: "operation-plan",
		runId: "planning-run-1",
		repository: {
			workingDirectory: workspacePath,
			baseBranch: "main",
		},
	};
}

/** @param {Partial<AnalysisPort> & {plan?: import("../../types/plan.js").PlanBlueprint, verificationResult?: import("../../types/analysis.js").VerificationOutcome}} [options] @returns {AnalysisPort} */
export function analysisStub(options = {}) {
	const blueprint = options.plan ?? planBlueprint();
	const verificationResult = options.verificationResult ?? {
		passed: true,
		summary: "All acceptance criteria covered",
		evidence: [
			"T-003-A001-E001",
			"T-003-A001-E002",
			"T-003-A001-E003",
			"T-003-A001-E004",
		],
		missingEvidence: [],
		correctionTaskIds: [],
	};
	return {
		...createWorkflowAnalysis(() => null),
		preparePlanning: async () => ({
			workflow: "plan",
			inputDigest: "a".repeat(64),
			launchSpec: { name: "plan", args: {} },
		}),
		importPlanning: async (runId) => ({
			runId,
			inputDigest: "a".repeat(64),
			plan: structuredClone(blueprint),
		}),
		prepareVerification: async (_plan, reservationId) => ({
			workflow: "verify",
			inputDigest: "b".repeat(64),
			launchSpec: {
				name: "verify",
				args: { reservationId },
			},
		}),
		importVerification: async (runId) => ({
			run: {
				runId,
				status: "completed",
			},
			detail: { completedAt: Date.now() },
			result: verificationResult,
		}),
		discoverVerificationRun:
			options.discoverVerificationRun ?? (async () => ({ state: "absent" })),
		assessVerificationRun:
			options.assessVerificationRun ?? (async () => ({ state: "active" })),
		cancelVerificationRun:
			options.cancelVerificationRun ?? (async (runId) => ({
				runId,
				status: "cancelled",
				alreadyTerminal: false,
			})),
		verificationRunIsTerminal: options.verificationRunIsTerminal
			?? (async () => true),
	};
}

/** @param {string} summary */
export function evidence(summary) {
	return [{
		type: EVIDENCE_TYPE.TEST,
		summary,
		source: "node --test",
		outcome: "passed",
	}];
}

/** @param {{id: string, status: string}[]} [sessions] */
export function completeInventory(sessions = []) {
	return {
		complete: true,
		capturedAt: new Date(Date.now() + 1000).toISOString(),
		sessions,
	};
}

/** @param {Operations} operations @param {string} workspacePath */
export async function createApproved(operations, workspacePath) {
	let plan = await operations.createPlan(createInput(workspacePath));
	plan = await operations.submitPlan({
		planId: plan.id,
		expectedRevision: plan.revision,
	});
	return operations.approve({
		planId: plan.id,
		expectedRevision: plan.revision,
		approvedBy: "octocat",
		approvalType: "plan",
	});
}

/** @param {Operations} operations @param {import("../../types/plan.js").FoundryPlan} plan @param {string} taskId
 * @param {Partial<import("../../requests.mjs").Request<"completeTask">> & {reservationId?: string, sessionId?: string, scopeOverride?: import("../../types/plan.js").ScopeOverride}} [options] */
export async function runTask(operations, plan, taskId, options = {}) {
	const task = plan.tasks.find((entry) => entry.id === taskId);
	const taskEvidence = task?.kind === "verify"
		? [
			...plan.tasks
				.filter((entry) => entry.kind === "implement")
				.sort((left, right) => left.id.localeCompare(right.id))
				.flatMap((entry) => entry.acceptanceCriteria.map(
					(_criterion, index) => ({
						checkId: `${entry.id}-C${String(index + 1).padStart(3, "0")}`,
						type: EVIDENCE_TYPE.TEST,
						summary: `${entry.id} criterion passed`,
						source: "node --test",
						outcome: "passed",
					}),
				)),
			{
				checkId: "final-integration",
				type: EVIDENCE_TYPE.INTEGRATION,
				summary: "Integration passed",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "workspace-integrity",
				type: EVIDENCE_TYPE.COMMAND,
				summary: "HEAD and worktree are unchanged",
				source: "git status --porcelain",
				outcome: "passed",
			},
		]
		: evidence(`${taskId} tests passed`);
	const reserved = await operations.reserveTask({
		planId: plan.id,
		taskId,
		expectedRevision: plan.revision,
		reservationId: options.reservationId ?? `reserve-${taskId}-${plan.revision}`,
		scopeOverride: options.scopeOverride,
	});
	plan = reserved.plan;
	const branch = options.branch ?? `work/${taskId.toLowerCase()}`;
	const commit = options.commit ?? COMMIT;
	const worktree = path.join(plan.repository.workingDirectory, "worktrees", `${taskId}-${plan.revision}`);
	if (task?.kind === "verify") {
		git(plan.repository.workingDirectory, "update-ref", `refs/heads/${branch}`, commit);
		git(plan.repository.workingDirectory, "worktree", "add", "--quiet", worktree, branch);
	} else if (commit === COMMIT) git(plan.repository.workingDirectory, "update-ref", `refs/heads/${branch}`, commit);
	plan = await operations.attachTask({
		planId: plan.id,
		taskId,
		attemptId: reserved.attemptId,
		expectedRevision: plan.revision,
		sessionId: options.sessionId ?? `session-${taskId}`,
		branch,
	});
	if (task?.kind === "verify") git(worktree, "checkout", "--quiet", "--detach", commit);
	plan = await operations.completeTask({
		planId: plan.id,
		taskId,
		attemptId: reserved.attemptId,
		expectedRevision: plan.revision,
		status: TASK_STATUS.DONE,
		resultSummary: `${taskId} complete`,
		evidence: options.evidence ?? taskEvidence,
		branch,
		commit,
		prUrl: options.prUrl,
	});
	return { plan, reserved };
}

/** @param {Operations} operations @param {string} workspacePath */
export async function completeImplementation(operations, workspacePath) {
	let plan = await createApproved(operations, workspacePath);
	({ plan } = await runTask(operations, plan, "T-001", {
		reservationId: "complete-foundation",
		sessionId: "complete-foundation-session",
	}));
	({ plan } = await runTask(operations, plan, "T-002", {
		reservationId: "complete-integration",
		sessionId: "complete-integration-session",
	}));
	({ plan } = await runTask(operations, plan, "T-003", {
		reservationId: "complete-verifier",
		sessionId: "complete-verifier-session",
		branch: "work/complete-verifier",
		commit: COMMIT,
	}));
	return plan;
}
