import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPlanningArgs } from "../../analysis/planning.mjs";
import { validateVerificationResult } from "../../analysis/verdicts.mjs";
import { buildVerificationInput, normalizeVerificationInput } from "../../analysis/verification.mjs";
import { createFactoryService } from "../../factory.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { verificationCheckIds } from "../../plan/graph.mjs";
import { must } from "../assertions.mjs";
import { factoryMutator } from "../factory/accessors.mjs";
import { analysisFixture } from "../native/fixture.mjs";

/** @typedef {import("../../operations.mjs").FoundryOperations} Operations */
/** @typedef {import("../../types/plan.js").FoundryPlan} Plan */
/** @typedef {import("../../types/analysis.js").VerificationInput} VerificationInput */

export const COMMIT = "c".repeat(40);

export const DIGEST = "d".repeat(64);

export const source = () => ({ kind: "discovery", ref: "fixture:recovered-intent", actor: "researcher", at: new Date().toISOString() });

/** @param {string | null} checkId */
const evidence = (checkId) => ({ ...(checkId ? { checkId } : {}), type: "test", summary: "Bounded protocol fixture", source: "fixture evaluator", outcome: "passed" });

/** @param {import("node:test").TestContext} t @param {{human?: boolean}} [options] */
export async function fixture(t, { human = false } = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "foundry-review-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	const storageRoot = path.join(root, "authority");
	await mkdir(repo); await mkdir(storageRoot);
	execFileSync("git", ["-C", repo, "init", "--quiet"]);
	const factory = createFactoryService({ repositoryPath: repo, storageRoot });
	const mutate = factoryMutator(factory);
	mutate("createUnit", {
		id: "unit", name: "Unit", purpose: "Conserve external meaning and caller-owned input",
		boundary: { owns: ["selection"], exposes: ["select(input)"], consumes: [], preserves: ["input identity"] },
		dependencies: [], relationshipCoverage: "complete", actor: "owner"
	});
	mutate("appendKnowledge", { id: "obligation", unitId: "unit", kind: "obligation", statement: "Caller-owned input is immutable", source: source() });
	mutate("appendKnowledge", {
		id: "oracle", unitId: "unit", kind: "evaluation", statement: "Independently evaluate the conserved boundary", source: source(),
		evaluation: {
			modality: "boundary", procedure: { kind: "command", ref: "fixture-boundary-test", digest: DIGEST },
			obligations: [{ id: "obligation", revision: 1 }], environment: "fixture-node", workload: "fixture-workload",
			maxAgeSeconds: 86400, independent: true, preservation: true
		}
	});
	if (human) mutate("appendKnowledge", {
		id: "human-rubric", unitId: "unit", kind: "evaluation", statement: "A human judges the externally visible explanation", source: source(),
		evaluation: {
			modality: "human", procedure: { kind: "judgment", ref: "Review explanation against the published rubric", digest: "a".repeat(64) },
			obligations: [{ id: "obligation", revision: 1 }], environment: "fixture-node", workload: "fixture-workload",
			maxAgeSeconds: 86400, independent: true, preservation: false
		}
	});
	mutate("acceptContract", {
		unitId: "unit", unitRevision: 1, obligations: [{ id: "obligation", revision: 1 }],
		evaluations: [{ id: "oracle", revision: 1 }, ...(human ? [{ id: "human-rubric", revision: 1 }] : [])], actor: "owner", reason: "Accept conserved meaning and independent evaluation"
	});
	const { candidate } = mutate("prepareCandidate", {
		id: "candidate", unitId: "unit", contractRevision: 1, actor: "owner",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "A newly reserved App child owns generation" } }
	});
	/** @typedef {{runId: string, status: "completed", result: {reservationId: string} & Record<string, unknown>}} RecordedRun */
	/** @type {Map<Operations, {workspace: string, runs: Map<string, RecordedRun>, preparedInputs: Map<string, VerificationInput>}>} */
	const backends = new Map();
	/** @param {string} name */
	const createOps = async (name) => {
		const workspace = path.join(root, name);
		await mkdir(workspace);
		/** @type {Map<string, RecordedRun>} */
		const runs = new Map();
		/** @type {Map<string, VerificationInput>} */
		const preparedInputs = new Map();
		const analysis = analysisFixture({
			preparePlanning: async (input) => {
				const args = buildPlanningArgs(input);
				return { workflow: "plan", inputDigest: args.inputDigest, launchSpec: { name: "plan", args } };
			},
			prepareVerification: async (plan, reservationId) => {
				const input = buildVerificationInput(plan);
				normalizeVerificationInput(input);
				preparedInputs.set(reservationId, input);
				return { workflow: "verify", inputDigest: input.inputDigest, launchSpec: { name: "verify", args: { ...input, reservationId } } };
			},
			discoverVerificationRun: async (reservationId) => {
				const run = [...runs.values()].find((run) => run.result.reservationId === reservationId);
				return run ? { state: "found", run: { runId: run.runId, status: "completed" } } : { state: "absent" };
			},
			importVerification: async (runId, plan) => {
				assert.equal(plan.factory?.owner, workspace);
				const run = runs.get(runId);
				assert.ok(run);
				return {
					run, detail: { completedAt: Date.now() },
					result: validateVerificationResult(run.result, buildVerificationInput(plan), must(plan.verification.reservationId))
				};
			},
			listWorkflowRuns: async () => ({ runs: [], omittedOlder: 0 }),
		});
		const operations = createFoundryOperations({ getWorkspacePath: () => workspace, factoryStorageRoot: storageRoot, analysis });
		backends.set(operations, { workspace, runs, preparedInputs });
		return operations;
	};
	const ops = await createOps("coordinator");
	/** @param {Operations} operations @param {Plan} plan */
	const approve = async (operations, plan) => {
		plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		return operations.approve({ planId: plan.id, expectedRevision: plan.revision, approvedBy: "owner" });
	};
	const generationPlan = async (id = "generate") => approve(ops, await ops.createFactoryPlan({
		id, expectedRevision: 0, expectedFactoryRevision: factory.snapshot().revision, candidateId: candidate.id,
		repository: { workingDirectory: repo, baseBranch: "main" },
	}));
	/** @param {Operations} operations @param {Plan} plan @param {string} taskId */
	const attach = async (operations, plan, taskId) => {
		const counter = must(plan.tasks.find((task) => task.id === taskId)).attempts.length + 1;
		const reservation = await operations.reserveTask({ planId: plan.id, expectedRevision: plan.revision, taskId, reservationId: `${plan.id}-${taskId}-${counter}` });
		return operations.attachTask({
			planId: plan.id, expectedRevision: reservation.plan.revision, taskId, attemptId: reservation.attemptId,
			sessionId: `${path.basename(must(backends.get(operations)).workspace)}-${plan.id}-${taskId}-${counter}`, branch: `fixture/${plan.id}`
		});
	};
	/** @param {Plan} plan @param {string} taskId @param {Partial<import("../../requests.mjs").Request<"completeTask">>} [extra] */
	const payload = (plan, taskId, extra = {}) => {
		const task = must(plan.tasks.find((task) => task.id === taskId));
		return {
			planId: plan.id, expectedRevision: plan.revision, taskId, attemptId: must(task.attempts.at(-1)).id, status: "done",
			commit: COMMIT, resultSummary: "Protocol fixture completed",
			evidence: task.kind === "verify" ? verificationCheckIds(plan.tasks, plan.evaluationTarget).map(evidence) : [evidence(null)],
			factoryEvaluations: task.kind === "verify" ? [{
				evaluation: { id: "oracle", revision: 1 }, procedureDigest: DIGEST, environment: "fixture-node", workload: "fixture-workload",
				outcome: /** @type {const} */ ("passed"), report: "Independent fixture report", independenceReason: "Distinct attached read-only verifier",
			}] : [],
			...extra,
		};
	};
	/** @param {Plan} plan @param {Partial<import("../../requests.mjs").Request<"completeTask">>} [extra] */
	const implement = async (plan, extra = {}) => {
		plan = await attach(ops, plan, "T-001");
		return ops.completeTask(payload(plan, "T-001", extra));
	};
	/** @param {Operations} operations @param {Plan} plan */
	const verify = async (operations, plan) => {
		const taskId = must(plan.tasks.find((task) => task.kind === "verify")).id;
		plan = await attach(operations, plan, taskId);
		return operations.completeTask(payload(plan, taskId));
	};
	/** @param {Operations} operations @param {Plan} plan @param {{proposal?: string, complete?: boolean, failed?: boolean}} [options] */
	const finish = async (operations, plan, { proposal = undefined, complete = true, failed = false } = {}) => {
		const reservationId = `verify-${plan.id}-${plan.revision}`;
		({ plan } = await operations.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId }));
		const backend = must(backends.get(operations));
		const input = must(backend.preparedInputs.get(reservationId));
		const runId = `run-${plan.id}-${plan.revision}`;
		const gaps = failed ? [{ summary: "Another independent evaluation is required", taskIds: [input.tasks[0]?.id ?? input.verificationReport.taskId] }] : [];
		const reviews = [{ missingEvidence: gaps, integrationFindings: [], risks: [] },
		{ missingEvidence: [], integrationFindings: [], risks: proposal ? [proposal] : [] }];
		backend.runs.set(runId, {
			runId, status: "completed", result: {
				kind: "foundry-verification-result", planId: plan.id, reservationId, input, inputDigest: input.inputDigest,
				passed: !failed, summary: failed ? "Independent coverage remains incomplete" : "Independent checks support the pinned target", reviews, missingEvidence: gaps, correctionTaskIds: [],
				evidenceIds: input.verificationReport.evidence.filter((entry) => entry.outcome === "passed").map((entry) => entry.id),
			}
		});
		plan = await operations.finishVerification({ planId: plan.id, expectedRevision: plan.revision, runId });
		if (complete && !failed) plan = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, approvedBy: "owner", approvalType: "completion" });
		const factoryInput = must(input.factory);
		const context = must(factoryInput.context);
		return { plan, input: { ...input, factory: { ...factoryInput, context } } };
	};
	return { root, repo, storageRoot, factory, mutate, candidate, ops, createOps, approve, generationPlan, attach, payload, implement, verify, finish };
}
