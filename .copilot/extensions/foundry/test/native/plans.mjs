import { buildVerificationInput } from "../../analysis/verification.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, createDraftPlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { ATTEMPT_STATUS, EVIDENCE_TYPE, PLAN_STATUS } from "../../plan/values.mjs";
import { reserveVerification } from "../../plan/verification.mjs";
import { must } from "../assertions.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { validatePlanningArgs } from "../../analysis/planning.mjs";
import { readJsonValue, readRecord } from "../../data.mjs";
import { createFactoryService } from "../../factory.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { createRepairJournal } from "../../storage/repair.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { run as runRepair } from "../../workflows/repair.mjs";
import { factoryMutator } from "../factory/accessors.mjs";
import { fixtureRoot, seedRepository } from "../git.mjs";
import { createWorkflowContext } from "../workflows/runtime.mjs";
import { fakeApi } from "./api.mjs";

/** Synthetic native owner, confined by the existing isolated runner.
 * @template {object} T @param {T} workflow @param {string} [owner] */
export function withPlanningOwner(workflow, owner = mkdtempSync(path.join(process.cwd(), "planning-owner-"))) {
	return { ...workflow, runId: "workflow-run", session: { sessionId: "synthetic-planner", workspacePath: owner } };
}

/** Actual operations/journal/workflow composition with explicitly synthetic native transport.
 * @param {import("node:test").TestContext} t */
export async function repairNativeFixture(t) {
	const root = await fixtureRoot(t, "planning-repair");
	const previousHome = process.env.COPILOT_HOME;
	process.env.COPILOT_HOME = root;
	t.after(() => {
		if (previousHome === undefined) delete process.env.COPILOT_HOME;
		else process.env.COPILOT_HOME = previousHome;
	});
	const repositoryPath = path.join(root, "repo");
	const owner = path.join(root, "owner");
	mkdirSync(repositoryPath); mkdirSync(owner); seedRepository(repositoryPath);
	const factory = createFactoryService({ repositoryPath });
	const mutate = factoryMutator(factory);
	mutate("createUnit", {
		id: "repair-unit", name: "Synthetic repair unit", purpose: "Deliver checked code with independent final confirmation",
		boundary: { owns: ["src/change.mjs"], exposes: ["checked behavior"], consumes: [], preserves: ["all checks", "data"] },
		dependencies: [], relationshipCoverage: "complete", actor: "synthetic-owner",
	});
	/** @type {Record<string, import("./api.mjs").FakeRunRecord>} */
	const records = {};
	/** @type {Record<string, string[]>} */
	const labels = {};
	const api = fakeApi(records);
	const originalDetail = api.getRunDetail.bind(api);
	api.getRunDetail = async runId => ({
		...readRecord(await originalDetail(runId)),
		agents: (labels[runId] ?? []).map((label, index) => ({
			agentId: `${runId}-agent-${index}`, toolCallId: `${runId}-call-${index}`, runId, label, status: "completed",
		})),
	});
	const analysis = createWorkflowAnalysis(() => api);
	const sessionId = "synthetic-owner";
	const context = { invocation: { sessionId, toolCallId: "native-invocation" } };
	/** @type {Array<{name: string, arguments: import("../../types/json.js").JsonValue, toolCallId?: string}>} */
	const launches = [];
	let nextRunId = "repair-native-run";
	/** @type {(input: {name: string, arguments: import("../../types/json.js").JsonValue}) => Promise<unknown>} */
	let executor = async input => {
		const args = readRecord(readRecord(input.arguments).args);
		assertRepairIntent(String(args.preparationId), String(args.preparationDigest));
		records[nextRunId] = {
			workflowName: "plan-repair", run: { runId: nextRunId, status: "running" }, createdAt: 2000, completedAt: null, progress: [],
		};
		return { resultType: "success", textResultForLlm: JSON.stringify({ runId: nextRunId }) };
	};
	/** @param {string} id @param {string} digest */
	function assertRepairIntent(id, digest) {
		const record = createRepairJournal({ workspacePath: owner, sessionId }).read(id, digest);
		if (record.state !== "intent") throw new Error("Native invocation preceded durable intent");
	}
	const session = {
		sessionId, workspacePath: owner,
		rpc: { tools: { async execute(/** @type {{name: string, arguments: import("../../types/json.js").JsonValue, toolCallId?: string}} */ input) {
				launches.push(structuredClone(input)); return executor(input);
			} },
		},
	};
	const createOps = (withExecutor = true) => createFoundryOperations({
		getWorkspacePath: () => owner,
		getSession: () => withExecutor ? session : { sessionId, workspacePath: owner }, analysis,
	});
	const ops = createOps();
	const preparedPlan = await ops.preparePlan({
		repositoryPath, unitId: "repair-unit", objective: "Deliver producer evidence and then independent final verification",
		constraints: ["Only src/change.mjs may change. Local commits only, no merge.", "Support matrix artifacts are permitted."],
		repositoryContext: "Synthetic native fixture. Support macOS/Linux/Windows with passing platform checks and conserved data.",
		maxTasks: 1,
	});
	const input = validatePlanningArgs(preparedPlan.launchSpec.args);
	const original = planningResult(input);
	original.status = "needs-review";
	original.verification = { passed: false, issues: ["Producer acceptance requires its dependent final verifier to finish first."] };
	original.issues = [...original.verification.issues];
	original.plan.tasks[0].acceptanceCriteria = ["T-002 must independently confirm platform tests and conserved data before T-001 completes."];
	original.plan.tasks[1].description = "Independently confirm platform tests and conserved data after producer delivery.";
	records.source = { workflowName: "plan", run: { runId: "source", status: "completed", result: original }, createdAt: 1000, completedAt: 1500 };
	labels.source = ["plan:decomposer", "plan:architecture-critic", "plan:delivery-risk-critic", "plan:synthesizer", "plan:verifier"];
	const repaired = structuredClone(original.plan);
	repaired.tasks[0].acceptanceCriteria = ["Producer supplies passing platform-test and data-conservation evidence; T-002 independently confirms after delivery."];
	const prepare = () => ops.preparePlanRepair({ runId: "source", repositoryPath }, context);
	/** @param {Awaited<ReturnType<typeof prepare>>} prepared */
	async function execute(prepared) {
		const workflow = createWorkflowContext(readJsonValue(prepared.launchSpec.args), (_prompt, options) => {
			if (options.label === "plan:semantic-repair") return repaired;
			if (options.label === "plan:conservation-review") return { passed: true, issues: [] };
			throw new Error(`Unexpected upstream generation: ${options.label}`);
		});
		const record = records[nextRunId];
		if (!record) throw new Error("No synthetic native admission");
		const executing = { ...workflow, runId: nextRunId, session: { ...session, workflow: api } };
		const result = await runRepair(executing);
		record.run.status = "completed";
		record.run.result = result;
		record.completedAt = 3000;
		record.progress = workflow.logs;
		if (workflow.calls.length) labels[nextRunId] = workflow.calls.map(call => call.options.label);
		return { result, workflow };
	}
	return {
		root, repositoryPath, owner, sessionId, context, session, factory, mutate, records, labels, api, analysis, ops, createOps, input, original, repaired, prepare, execute, launches,
		journal: () => createRepairJournal({ workspacePath: owner, sessionId }),
		setExecutor: (/** @type {typeof executor} */ value) => { executor = value; },
		setRunId: (/** @type {string} */ value) => { nextRunId = value; },
	};
}

/** @param {import("../../analysis/planning.mjs").PlanningArgs} input
 * @returns {import("../../types/analysis.js").PlanningCandidateResult} */
export function planningResult(input) {
	return {
		kind: "foundry-plan-result",
		inputDigest: input.inputDigest,
		input,
		status: "ready",
		plan: {
			title: "Plan",
			objective: input.objective,
			constraints: input.constraints,
			tasks: [
				{
					id: "T-001",
					title: "Implement",
					kind: "implement",
					description: "Implement",
					dependsOn: [],
					acceptanceCriteria: ["Tests pass"],
					expectedFiles: ["src/change.mjs"],
					deliveryRequirement: "commit",
				},
				{
					id: "T-002",
					title: "Verify",
					kind: "verify",
					description: "Verify the final delivery",
					dependsOn: ["T-001"],
					acceptanceCriteria: [],
					expectedFiles: [],
					deliveryRequirement: "commit",
				},
			],
		},
		critiques: [
			{ verdict: "accept", risks: [], requiredChanges: [] },
			{ verdict: "accept", risks: [], requiredChanges: [] },
		],
		verification: { passed: true, issues: [] },
		synthesisRepair: null,
		missingPerspectives: [],
		issues: [],
	};
}

export function completedPlan() {
	let plan = createDraftPlan({
		id: "workflow-plan",
		title: "Workflow plan",
		objective: "Validate native Workflow integration",
		constraints: [],
		repository: { workingDirectory: "/tmp/workflow-plan", baseBranch: "main" },
		tasks: [
			{
				id: "T-001",
				title: "Implement",
				kind: "implement",
				description: "Implement",
				dependsOn: [],
				acceptanceCriteria: ["Tests pass"],
				expectedFiles: ["src/change.mjs"],
				deliveryRequirement: "commit",
			},
			{
				id: "T-002",
				title: "Verify",
				kind: "verify",
				description: "Verify",
				dependsOn: ["T-001"],
				acceptanceCriteria: [],
				expectedFiles: [],
				deliveryRequirement: "commit",
			},
		],
	}, { now: "2026-08-07T00:00:00.000Z" });
	plan = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, {
		at: "2026-08-07T00:01:00.000Z",
	});
	plan = approvePlan(plan, "tester", { at: "2026-08-07T00:02:00.000Z" });
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "workflow-reservation",
		at: "2026-08-07T00:03:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-001", "T-001-A001", {
		sessionId: "session-1",
		branch: "work/workflow",
		at: "2026-08-07T00:04:00.000Z",
	});
	plan = completeTaskAttempt(plan, "T-001", "T-001-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Implemented",
		evidence: [{
			type: EVIDENCE_TYPE.TEST,
			summary: "Tests pass",
			source: "node --test",
			outcome: "passed",
		}],
		branch: "work/workflow",
		commit: "a".repeat(40),
		at: "2026-08-07T00:05:00.000Z",
	});
	plan = reserveTaskAttempt(plan, "T-002", {
		reservationId: "workflow-verifier",
		at: "2026-08-07T00:07:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-002", "T-002-A001", {
		sessionId: "session-2",
		branch: "work/workflow-verifier",
		at: "2026-08-07T00:08:00.000Z",
	});
	return completeTaskAttempt(plan, "T-002", "T-002-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Independent report",
		evidence: [
			{
				checkId: "T-001-C001",
				type: EVIDENCE_TYPE.TEST,
				summary: "Tests pass",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "final-integration",
				type: EVIDENCE_TYPE.INTEGRATION,
				summary: "Integration passes",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "workspace-integrity",
				type: EVIDENCE_TYPE.COMMAND,
				summary: "Workspace is clean",
				source: "git status --porcelain",
				outcome: "passed",
			},
		],
		branch: "work/workflow-verifier",
		commit: "a".repeat(40),
		at: "2026-08-07T00:09:00.000Z",
	});
}

export function reservedPlan(reservationId = "verification-reservation") {
	const plan = completedPlan();
	const input = buildVerificationInput(plan);
	const reserved = reserveVerification(plan, {
		reservationId,
		inputDigest: input.inputDigest,
		at: "2026-08-07T00:06:00.000Z",
	});
	return {
		...reserved,
		verification: {
			...reserved.verification,
			reservationId: must(reserved.verification.reservationId),
			reservedAt: must(reserved.verification.reservedAt),
			inputDigest: must(reserved.verification.inputDigest),
		},
	};
}
