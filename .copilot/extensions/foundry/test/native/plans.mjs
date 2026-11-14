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
import { DatabaseSync } from "node:sqlite";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { buildRepairEffect, repairComparisonState, repairLaunch, repairObject } from "../../analysis/repair.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createSupportedRuntime } from "../../native/supported-runtime.mjs";

/** Explicit synthetic resource grant, not a live provider or production default.
 * The same production admitRepairEffect seam consumes this transaction-backed port.
 * @param {string} databasePath @param {{remaining: number, resourceId: string, nativeRunId?: () => string, agentIndex?: () => number, initialContributors?: () => import("../../types/repair.js").RepairIdentity[]}} grant */
export function createFixtureRepairHost(databasePath, grant) {
	const db = new DatabaseSync(databasePath);
	db.exec(`CREATE TABLE IF NOT EXISTS fixture_native_resource (id TEXT PRIMARY KEY, remaining INTEGER NOT NULL) STRICT;
		CREATE TABLE IF NOT EXISTS fixture_native_effect (id TEXT PRIMARY KEY, receipt TEXT NOT NULL) STRICT;
		CREATE TABLE IF NOT EXISTS fixture_native_attestation (digest TEXT PRIMARY KEY) STRICT;`);
	db.prepare("INSERT OR IGNORE INTO fixture_native_resource VALUES (?,?)").run(grant.resourceId, grant.remaining);
	const checks = { authority: true, revision: true, approval: true, revocation: true, cancellation: true, provider: true, resources: true, budgets: true };
	/** @type {Map<string, Promise<unknown>>} */
	const inFlight = new Map();
	/** @type {import("../../types/repair.js").RepairIdentity[]} */
	const contributors = [];
	/** @param {unknown} value */
	function attest(value) {
		db.prepare("INSERT OR IGNORE INTO fixture_native_attestation VALUES (?)").run(analysisInputDigest(value));
		return structuredClone(value);
	}
	/** @param {unknown} value @returns {boolean} */
	function authentic(value) {
		if (db.prepare("SELECT digest FROM fixture_native_attestation WHERE digest=?").get(analysisInputDigest(value))) return true;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const raw = readRecord(value);
			return Array.isArray(raw.receipts) && raw.receipts.length > 0 && raw.receipts.every(authentic)
				&& authentic(raw.comparison) && Array.isArray(raw.history) && raw.history.every(authentic);
		}
		return false;
	}
	/** @param {string} id */
	function identity(id) { return { agentId: `${id}-agent`, toolCallId: `${id}-call`, runId: `${id}-run` }; }
	/** @type {import("../../types/repair.js").RepairHostPort} */
	const host = {
		async authenticate(value) { return authentic(value); },
		async prepare(preparation) {
			const source = preparation.source?.native;
			const rawAgents = source && typeof source === "object" && !Array.isArray(source) ? readRecord(source).agents : [];
			const native = Array.isArray(rawAgents) && rawAgents.length ? rawAgents.map(value => {
				const raw = readRecord(value);
				return { agentId: String(raw.agentId), toolCallId: String(raw.toolCallId), runId: String(raw.runId) };
			}) : grant.initialContributors ? grant.initialContributors() : preparation.mode === "inline" && preparation.rootRunId === "source"
				? Array.from({ length: preparation.material.stage === "structural" ? 4 : 5 }, (_, index) => ({
					agentId: `source-agent-${index}`, toolCallId: `source-call-${index}`, runId: "source",
				})) : [];
			return attest({
				format: "foundry-repair-comparison-v1",
				protected: { preparationId: preparation.id, preparationDigest: preparation.digest,
					rootRunId: preparation.rootRunId, inputDigest: preparation.inputDigest, sourceDigest: preparation.sourceDigest,
					authority: preparation.authority, evaluatorDefinition: "synthetic-pinned-planning-evaluator" },
				candidateDigest: analysisInputDigest(preparation.material.candidate), diagnosticsDigest: analysisInputDigest(preparation.material.diagnostics),
				obligations: [
					{ id: "planning-deadlock", evaluatorId: "synthetic-planning", evaluatorDigest: "e".repeat(64), inputDigest: preparation.inputDigest, status: "unresolved", evidence: [] },
					{ id: "conserved-checks", evaluatorId: "synthetic-conservation", evaluatorDigest: "f".repeat(64), inputDigest: preparation.inputDigest, status: "unresolved", evidence: [] },
				],
				contributors: native, reviewer: identity(`baseline-${preparation.id}`),
			});
		},
		async propose(preparation, history, continuationOf, context) {
			const rows = db.prepare("SELECT payload FROM planning_repair_events WHERE id=? AND event='recovery-result' ORDER BY seq").all(preparation.id);
			const row = rows.map(row => JSON.parse(String(row.payload))).find(value => value.runId === continuationOf);
			if (!row) throw new Error("No exact retained continuation source");
			return attest(buildRepairEffect(preparation, "launch", history, row.result.synthesisRepair.candidate, row.result.issues,
				null, repairObject({ launch: repairLaunch(preparation), continuationOf, ...(context ? { context } : {}) })));
		},
		async review(effect, history) {
			const baseline = repairComparisonState(history.at(-1));
			const reviewer = identity(`admission-review-${effect.id}`);
			const result = {
				effectDigest: effect.id, passed: true, issues: [], reviewer,
				targets: baseline.obligations.filter(item => item.status === "unresolved").map(item => item.id),
				evidence: baseline.obligations.filter(item => item.status === "unresolved").map(item => ({
					id: `preparation-${effect.id}-${item.id}`, digest: analysisInputDigest({ proposedEffect: effect.id, obligation: item.id }),
					evaluatorId: item.evaluatorId, inputDigest: item.inputDigest,
					producer: identity(`preparation-evidence-${effect.id}-${item.id}`), causalFor: [item.id],
				})),
			};
			contributors.push(reviewer);
			return attest(result);
		},
		async admit(effect, _review, invoke, signal) {
			const existing = db.prepare("SELECT receipt FROM fixture_native_effect WHERE id=?").get(effect.id);
			if (existing) return inFlight.get(effect.id) ?? JSON.parse(String(existing.receipt));
			db.exec("BEGIN IMMEDIATE");
			try {
				const duplicate = db.prepare("SELECT receipt FROM fixture_native_effect WHERE id=?").get(effect.id);
				if (duplicate) { db.exec("COMMIT"); return JSON.parse(String(duplicate.receipt)); }
				const row = db.prepare("SELECT remaining FROM fixture_native_resource WHERE id=?").get(grant.resourceId);
				const permitted = Object.values(checks).every(Boolean) && !signal?.aborted && row && Number(row.remaining) > 0;
				const receipt = {
					effectDigest: effect.id, disposition: permitted ? "admitted" : "denied", consumed: Boolean(permitted),
					transactionId: `synthetic-native-transaction-${effect.id}`, nativeRunId: effect.runId ?? grant.nativeRunId?.() ?? "repair-native-run",
					checks: { ...checks }, resourceClaims: { id: grant.resourceId, consumed: permitted ? 1 : 0 },
					budgetClaims: { explicitFixtureGrant: grant.resourceId, consumed: permitted ? 1 : 0 },
					contributors: [],
				};
				if (permitted) db.prepare("UPDATE fixture_native_resource SET remaining=remaining-1 WHERE id=? AND remaining>0").run(grant.resourceId);
				db.prepare("INSERT INTO fixture_native_effect VALUES (?,?)").run(effect.id, stableStringify(receipt));
				attest(receipt);
				db.exec("COMMIT");
				if (!permitted) return receipt;
				const executing = (async () => {
					try {
						const output = readJsonValue(await invoke());
						const role = grant.agentIndex ? grant.agentIndex() : effect.runId === "source"
							? (effect.kind === "author" ? (effect.operation.label === "plan:synthesis-repair" ? 4 : 5) : (effect.operation.label === "plan:verifier" ? 5 : 6))
							: effect.kind === "author" ? 0 : 1;
						const native = effect.kind === "launch" ? [] : [{ agentId: `${receipt.nativeRunId}-agent-${role}`, toolCallId: `${receipt.nativeRunId}-call-${role}`, runId: receipt.nativeRunId }];
						contributors.push(...native);
						let disposition = receipt.disposition;
						let nativeRunId = receipt.nativeRunId;
						if (effect.kind === "launch") {
							const raw = readRecord(output);
							if (raw.resultType === "success") {
								const decoded = JSON.parse(String(raw.textResultForLlm));
								const value = decoded.ok === true ? decoded.value : decoded;
								if (typeof value.runId !== "string" || !value.runId) disposition = "uncertain";
								else nativeRunId = value.runId;
							} else disposition = ["denied", "rejected"].includes(String(raw.resultType)) ? "denied" : "uncertain";
						}
						const settled = { ...receipt, disposition, nativeRunId, output, contributors: native };
						db.prepare("UPDATE fixture_native_effect SET receipt=? WHERE id=?").run(stableStringify(settled), effect.id);
						return attest(settled);
					} catch (error) {
						const uncertain = { ...receipt, disposition: "uncertain", failure: String(error) };
						db.prepare("UPDATE fixture_native_effect SET receipt=? WHERE id=?").run(stableStringify(uncertain), effect.id);
						attest(uncertain);
						inFlight.delete(effect.id);
						throw error;
					}
				})();
				inFlight.set(effect.id, executing);
				return executing;
			} catch (error) {
				if (db.isTransaction) db.exec("ROLLBACK");
				throw error;
			}
		},
		async reconcile(effect) {
			const active = inFlight.get(effect.id);
			if (active) return active;
			const row = db.prepare("SELECT receipt FROM fixture_native_effect WHERE id=?").get(effect.id);
			return row ? JSON.parse(String(row.receipt)) : null;
		},
		async observeCandidate(preparation, candidate, verdict, history, receipts, diagnostics) {
			const state = structuredClone(repairComparisonState(history.at(-1)));
			state.candidateDigest = analysisInputDigest(candidate);
			state.diagnosticsDigest = analysisInputDigest(diagnostics);
			const passed = verdict && typeof verdict === "object" && !Array.isArray(verdict) && readRecord(verdict).passed === true;
			const changed = analysisInputDigest(candidate) !== analysisInputDigest(preparation.material.candidate);
			const nativeReview = receipts[1] && typeof receipts[1] === "object" && !Array.isArray(receipts[1]) ? readRecord(receipts[1]) : {};
			const native = Array.isArray(nativeReview.contributors) ? readRecord(nativeReview.contributors[0]) : null;
			state.reviewer = native ? { agentId: String(native.agentId), toolCallId: String(native.toolCallId), runId: String(native.runId) } : identity("missing-review");
			state.contributors.push(...contributors.filter(item => item.agentId !== state.reviewer.agentId));
			if (passed && changed) for (const obligation of state.obligations.filter(item => item.status === "unresolved")) {
				obligation.status = "supported";
				obligation.evidence.push({
					id: `causal-${obligation.id}`, digest: analysisInputDigest({ candidate, obligation: obligation.id }),
					evaluatorId: obligation.evaluatorId, inputDigest: obligation.inputDigest,
					producer: identity(`independent-causal-${obligation.id}`), causalFor: [obligation.id],
				});
			}
			return attest(state);
		},
	};
	return { host, checks, attest, close: () => db.close(),
		remaining: () => Number(db.prepare("SELECT remaining FROM fixture_native_resource WHERE id=?").get(grant.resourceId)?.remaining) };
}

/** @param {{session: {workspacePath: string}, calls?: unknown[], runId?: string}} workflow */
export async function repairWorkflowHost(workflow) {
	await createPlanStore({ workspacePath: workflow.session.workspacePath }).list();
	return createFixtureRepairHost(path.join(workflow.session.workspacePath, "files/foundry/foundry.sqlite"),
		{ remaining: 20, resourceId: "explicit-synthetic-workflow-grant", agentIndex: () => (workflow.calls?.length ?? 1) - 1,
			initialContributors: () => (workflow.calls ?? []).map((_call, index) => ({
				agentId: `${workflow.runId}-agent-${index}`, toolCallId: `${workflow.runId}-call-${index}`, runId: workflow.runId ?? "workflow-run",
			})) });
}

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
	const sessionId = "synthetic-owner";
	let nextRunId = "repair-native-run";
	await createPlanStore({ workspacePath: owner }).list();
	const nativeHost = createFixtureRepairHost(path.join(owner, "files/foundry/foundry.sqlite"), { remaining: 20, resourceId: "explicit-synthetic-native-grant", nativeRunId: () => nextRunId });
	t.after(nativeHost.close);
	const analysis = createWorkflowAnalysis(() => api, nativeHost.host);
	const context = { invocation: { sessionId, toolCallId: "native-invocation" } };
	/** @type {Array<{name: string, arguments: import("../../types/json.js").JsonValue, toolCallId?: string}>} */
	const launches = [];
	/** @type {(input: {name: string, arguments: import("../../types/json.js").JsonValue}) => Promise<unknown>} */
	let executor = async input => {
		const args = readRecord(readRecord(input.arguments).args);
		assertRepairIntent(String(args.preparationId), String(args.preparationDigest), typeof args.effectId === "string" ? args.effectId : undefined);
		records[nextRunId] = {
			workflowName: "plan-repair", run: { runId: nextRunId, status: "running" }, createdAt: 2000, completedAt: null, progress: [],
		};
		return { resultType: "success", textResultForLlm: JSON.stringify({ runId: nextRunId }) };
	};
	/** @param {string} id @param {string} digest @param {string} [effectId] */
	function assertRepairIntent(id, digest, effectId) {
		const journal = createRepairJournal({ workspacePath: owner, sessionId });
		const record = journal.read(id, digest);
		const inlineIntent = record.preparation.mode === "inline" && journal.effects(id, digest).some(row => row.state === "intent"
			&& typeof row.effect === "object" && row.effect !== null && !Array.isArray(row.effect) && row.effect.id === effectId);
		if (!inlineIntent && !["intent", "uncertain", "admitted"].includes(record.state)) throw new Error("Native invocation preceded durable intent");
	}
	const session = {
		sessionId, workspacePath: owner,
		rpc: { tools: { async execute(/** @type {{name: string, arguments: import("../../types/json.js").JsonValue, toolCallId?: string}} */ input) {
				launches.push(structuredClone(input)); return executor(input);
			} },
		},
	};
	const runtime = createSupportedRuntime({ getSession: () => session });
	const createOps = (withExecutor = true, withHost = true) => createFoundryOperations({
		getWorkspacePath: () => owner,
		getSession: () => withExecutor ? session : { sessionId, workspacePath: owner }, analysis,
		repairHost: withHost ? nativeHost.host : undefined,
		getNativeRuntime: withExecutor ? () => runtime : undefined,
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
		const result = await runRepair(executing, nativeHost.host);
		record.run.status = "completed";
		record.run.result = result;
		record.completedAt = 3000;
		record.progress = workflow.logs;
		if (workflow.calls.length) labels[nextRunId] = workflow.calls.map(call => call.options.label);
		return { result, workflow };
	}
	return {
		root, repositoryPath, owner, sessionId, context, session, factory, mutate, records, labels, api, analysis, ops, createOps, input, original, repaired, prepare, execute, launches, nativeHost,
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
