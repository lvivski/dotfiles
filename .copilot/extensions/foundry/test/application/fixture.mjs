import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createFactoryBridge } from "../../bridge.mjs";
import { resolveEvaluatorBundle } from "../../evidence/bundles.mjs";
import { createFactoryService } from "../../factory.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { EVIDENCE_TYPE, TASK_STATUS } from "../../plan/values.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { factoryMutator } from "../factory/accessors.mjs";
import { COMMIT, fixtureRoot, git, seedRepository } from "../git.mjs";

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

export const technicalOwner = { sessionId: "technical-owner", toolCallId: "technical-native-call" };
export const technicalAuthority = {
	instruction: "Delegate bounded failed discovery corrections and the pinned cancellation-over-late-denial assertion alignment. Preserve every other gate and scope.",
	grantedBy: "requesting-user",
	source: { kind: "direct-user", sessionId: technicalOwner.sessionId, messageRef: "explicit-technical-instruction", messageRevision: 7 },
};
export const technicalReason = "The executable cancellation reference preserves previously granted access, data and focus; align only the obsolete late-denial outcome assertion.";

/** Real protected Git bytes and real Node executions; only native owner/resource ports are simulated.
 * @param {import("node:test").TestContext} t
 * @param {{
 * changeCases?: (cases: import("../../types/factory.js").TechnicalCase[]) => void,
 * changeFiles?: (files: Record<string, string>) => void,
 * changeDefinition?: (definition: import("../../types/factory.js").EvaluationDefinition) => void,
 * changeKnowledge?: (knowledge: Record<string, unknown>) => void,
 * secondaryEvaluator?: boolean,
 * executeTechnical?: import("../../types/factory.js").TechnicalExecutor | null,
 * }} [options] */
export async function technicalFixture(t, options = {}) {
	const root = await fixtureRoot(t, "technical");
	const repositoryPath = path.join(root, "repo");
	const workspacePath = path.join(root, "owner");
	const storageRoot = path.join(root, "authority");
	await Promise.all([mkdir(repositoryPath), mkdir(workspacePath), mkdir(storageRoot)]);
	seedRepository(repositoryPath);
	const agreement = {
		format: "foundry-cancellation-agreement-v1", obligation: { id: "cancellation", revision: 1 },
		scenarioId: "cancel-late-denial", casesPath: "technical/cases.json", referencePath: "technical/reference.mjs",
		assertion: "expected.outcome", from: "denied", to: "cancelled",
	};
	/** @type {import("../../types/factory.js").TechnicalCase[]} */
	const beforeCases = [
		{ id: "cancel-late-denial", input: { cancelled: true, lateResult: "denied", access: "granted", data: ["caller-owned"], focus: "#retry" }, expected: { outcome: "denied", access: "granted", data: ["caller-owned"], focus: "#retry" } },
		{ id: "denial-control", input: { cancelled: false, lateResult: "denied", access: "denied", data: ["denial-data"], focus: "#request" }, expected: { outcome: "denied", access: "denied", data: ["denial-data"], focus: "#request" } },
		{ id: "grant-control", input: { cancelled: false, lateResult: "granted", access: "granted", data: ["grant-data"], focus: "#continue" }, expected: { outcome: "granted", access: "granted", data: ["grant-data"], focus: "#continue" } },
		{ id: "cancel-grant-control", input: { cancelled: true, lateResult: "granted", access: "granted", data: ["cancel-data"], focus: "#cancel" }, expected: { outcome: "cancelled", access: "granted", data: ["cancel-data"], focus: "#cancel" } },
	];
	const canonical = (/** @type {unknown} */ value) => `${JSON.stringify(value, null, 2)}\n`;
	/** @type {Record<string, string>} */
	const files = {
		"technical/agreement.json": canonical(agreement),
		"technical/cases.json": canonical(beforeCases),
		"technical/reference.mjs": `export function evaluate(input) {
	return { outcome: input.cancelled ? "cancelled" : input.lateResult,
		access: input.cancelled ? input.access : input.lateResult, data: [...input.data], focus: input.focus };
}
`,
		"technical/run.mjs": `	import { readFileSync } from "node:fs";
	import { isDeepStrictEqual } from "node:util";
	import { evaluate } from "./reference.mjs";
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const traces = cases.map(({ id, input, expected }) => {
	const actual = evaluate(input);
	if (!isDeepStrictEqual(actual, expected)) {
		console.error(JSON.stringify({ id, expected, actual }));
		process.exitCode = 1;
	}
	return { id, actual };
});
console.log(JSON.stringify(traces));
`,
		"technical/native-reference.svg": '<svg xmlns="http://www.w3.org/2000/svg"><text>Preserve access, data and focus</text></svg>\n',
	};
	/** @param {Record<string, string>} content @param {string} message */
	const commitFiles = async (content, message) => {
		for (const [filename, value] of Object.entries(content)) {
			await mkdir(path.dirname(path.join(repositoryPath, filename)), { recursive: true });
			await writeFile(path.join(repositoryPath, filename), value);
		}
		git(repositoryPath, "add", "--", "technical");
		git(repositoryPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message);
		return git(repositoryPath, "rev-parse", "HEAD");
	};
	const beforeCommit = await commitFiles(files, "Synthetic accepted cancellation evaluator");
	const afterCases = structuredClone(beforeCases);
	afterCases[0].expected.outcome = "cancelled";
	options.changeCases?.(afterCases);
	const afterFiles = { ...files, "technical/cases.json": canonical(afterCases) };
	options.changeFiles?.(afterFiles);
	const afterCommit = await commitFiles(afterFiles, "Synthetic assertion-only successor");
	/** @param {string} commit */
	const resolve = (commit) => resolveEvaluatorBundle(repositoryPath, {
		version: 1, commit, root: "technical", entryPoint: "technical/run.mjs",
		support: ["package.json", "package-lock.json"], invocation: { argv: ["node", "technical/run.mjs"], cwd: "." },
	});
	const before = resolve(beforeCommit), after = resolve(afterCommit);
	const agreementDigest = createHash("sha256").update(files["technical/agreement.json"]).digest("hex");
	const factory = createFactoryService({ repositoryPath, storageRoot });
	const mutate = factoryMutator(factory);
	const source = { kind: "discovery", ref: "fixture:independently-pinned-agreement", actor: "fixture-human", at: new Date().toISOString() };
	mutate("createUnit", {
		id: "technical-unit", name: "Cancellation boundary", purpose: "Preserve cancellation and caller state",
		boundary: { owns: ["selection"], exposes: ["select"], consumes: [], preserves: ["granted access", "data", "focus"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture-human",
	});
	mutate("appendKnowledge", {
		id: "cancellation", unitId: "technical-unit", kind: "obligation", statement: "Cancellation wins over late denial without revoking granted access or changing caller data/focus.",
		source: { ...source, digest: agreementDigest },
	});
	/** @type {import("../../types/factory.js").EvaluationDefinition} */
	const definition = {
		modality: "boundary", procedure: { kind: "command", ref: "node technical/run.mjs", digest: before.digest, bundle: before.bundle },
		obligations: [{ id: "cancellation", revision: 1 }], environment: "fixture-node", workload: "cancellation-controls",
		maxAgeSeconds: 3600, independent: true, preservation: true,
		visual: { capture: "Use the native screenshot permission gate; compare actual focus and access state.", states: [{
			id: "cancelled", intent: "Granted access and caller focus remain unchanged.",
			reference: { path: "technical/native-reference.svg", digest: createHash("sha256").update(files["technical/native-reference.svg"]).digest("hex") },
		}] },
	};
	mutate("appendKnowledge", {
		id: "cancellation-oracle", unitId: "technical-unit", kind: "evaluation", statement: "Check cancellation precedence and every conservation control",
		source, uncertainty: null, evaluation: definition,
	});
	mutate("appendKnowledge", {
		id: "human-rubric", unitId: "technical-unit", kind: "evaluation", statement: "A human must judge the delivered explanation.",
		source, evaluation: {
			modality: "human", procedure: { kind: "judgment", ref: "Human explanation review", digest: "a".repeat(64) },
			obligations: [{ id: "cancellation", revision: 1 }], environment: "fixture-node", workload: "cancellation-controls",
			maxAgeSeconds: 3600, independent: true, preservation: false,
		},
	});
	if (options.secondaryEvaluator) mutate("appendKnowledge", {
		id: "secondary-cancellation-oracle", unitId: "technical-unit", kind: "evaluation",
		statement: "A different accepted evaluator shares the same protected agreement bytes.", source, evaluation: definition,
	});
	mutate("appendKnowledge", {
		id: "cancellation-rationale", unitId: "technical-unit", kind: "observation",
		statement: "The independently pinned reference preserves prior access, data and focus when cancellation wins.", source,
	});
	mutate("recordSignal", {
		id: "original-cancellation-failure", kind: "failed-evaluation", summary: "The obsolete late-denial expectation failed.",
		knowledgeRefs: [{ id: "cancellation-oracle", revision: 1 }], source,
	});
	const { contract } = mutate("acceptContract", {
		unitId: "technical-unit", unitRevision: 1, obligations: [{ id: "cancellation", revision: 1 }],
		evaluations: [{ id: "cancellation-oracle", revision: 1 }, { id: "human-rubric", revision: 1 },
			...(options.secondaryEvaluator ? [{ id: "secondary-cancellation-oracle", revision: 1 }] : [])],
		rationale: [{ id: "cancellation-rationale", revision: 1 }],
		resolutions: [{ knowledge: { id: "cancellation", revision: 1 }, reason: "The pre-existing independent agreement fixes the intended cancellation semantics." }],
		renewalSignalIds: ["original-cancellation-failure"],
		actor: "fixture-human", reason: "Synthetic accepted contract pinned before correction.",
	});
	const successor = structuredClone(definition);
	successor.procedure = { ...successor.procedure, digest: after.digest, bundle: after.bundle };
	options.changeDefinition?.(successor);
	const successorKnowledge = {
		id: "cancellation-oracle", unitId: "technical-unit", kind: "evaluation", statement: "Check cancellation precedence and every conservation control",
		source, uncertainty: null, evaluation: successor,
		links: [{ relation: "supersedes", target: { id: "cancellation-oracle", revision: 1 } }],
	};
	options.changeKnowledge?.(successorKnowledge);
	mutate("appendKnowledge", successorKnowledge);
	/** @type {{commit: string, stdout: string, stderr: string, exitCode: number}[]} */
	const executions = [];
	/** @type {import("../../types/factory.js").TechnicalExecutor} */
	const executor = async (input, signal) => {
		const traces = [];
		for (const bundle of [input.before, input.after]) {
			signal?.throwIfAborted();
			const material = resolveEvaluatorBundle(input.repositoryPath, bundle);
			const directory = path.join(root, `execution-${randomUUID()}`);
			await mkdir(directory);
			for (const file of material.files) {
				const filename = path.join(directory, file.path);
				assert.ok(filename.startsWith(`${directory}${path.sep}`), "Only confined protected paths may materialize");
				await mkdir(path.dirname(filename), { recursive: true });
				await writeFile(filename, Buffer.from(file.content, "base64"));
				await chmod(filename, file.mode === "100755" ? 0o755 : 0o644);
			}
			assert.equal(bundle.invocation.argv[0], "node");
			const run = spawnSync(process.execPath, bundle.invocation.argv.slice(1), {
				cwd: path.join(directory, bundle.invocation.cwd), encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
			});
			assert.equal(run.error, undefined);
			assert.equal(run.signal, null);
			assert.notEqual(run.status, null);
			const exitCode = /** @type {number} */ (run.status);
			executions.push({ commit: bundle.commit, stdout: run.stdout, stderr: run.stderr, exitCode });
			t.diagnostic(JSON.stringify({ kind: "technical-execution", ...executions.at(-1) }));
			traces.push({ exitCode, values: JSON.parse(run.stdout) });
			signal?.throwIfAborted();
		}
		return {
			source: `fixture:confined-node:${beforeCommit}:${afterCommit}`, environment: "fixture-node",
			beforeExitCode: traces[0].exitCode, afterExitCode: traces[1].exitCode, before: traces[0].values, after: traces[1].values,
		};
	};
	const session = { sessionId: technicalOwner.sessionId, workspacePath };
	const ui = { calls: 0, elicitation: async () => { ui.calls++; throw new Error("Technical authority must not elicit another form"); } };
	const analysis = analysisStub();
	/** @param {Partial<import("../../operations.mjs").FoundryOperationsOptions>} [overrides] */
	const reopen = (overrides = {}) => {
		const ports = {
			getWorkspacePath: () => workspacePath, factoryStorageRoot: storageRoot, analysis,
			getSession: () => session, getUi: () => ui,
			...(options.executeTechnical === null ? {} : { executeTechnical: options.executeTechnical ?? executor }),
			...overrides,
		};
		return createFoundryOperations(ports);
	};
	const operations = reopen();
	const bridge = createFactoryBridge({ workspace: () => workspacePath, storeFor: operations.storeFor, notify: () => {}, storageRoot });
	analysis.importPlanning = async (runId) => ({
		runId, inputDigest: "a".repeat(64), plan: planBlueprint(),
		factoryContext: bridge.context(repositoryPath, "technical-unit"),
	});
	const plan = await operations.createPlan({ ...createInput(repositoryPath), id: "technical-discovery" });
	const grantInput = {
		action: "grant", id: "technical-grant", planId: plan.id, expectedRevision: plan.revision, approvalType: "technical",
		technical: { kinds: ["retry", "consumer-expectation"], agreement: { evaluation: { id: "cancellation-oracle", revision: 1 }, path: "technical/agreement.json", digest: agreementDigest } },
		authority: technicalAuthority,
	};
	/** @param {Operations} [ops] */
	const grant = (ops = operations) => ops.planApprovalDelegation(grantInput, { invocation: { ...technicalOwner, toolCallId: "native-technical-grant" } });
	/** @param {Operations} [ops] */
	const request = async (ops = operations) => ({
		repositoryPath, action: "acceptContract",
		input: {
			expectedRevision: factory.snapshot().revision, unitId: "technical-unit", unitRevision: 1,
			obligations: contract.obligations, evaluations: contract.evaluations.map((ref) => ref.id === "cancellation-oracle" ? { ...ref, revision: 2 } : ref),
			reason: technicalReason,
			technical: { id: "align-cancellation", planId: plan.id, expectedPlanRevision: (await ops.getPlan({ planId: plan.id })).revision,
				delegationId: "technical-grant", previous: { id: "cancellation-oracle", revision: 1 }, next: { id: "cancellation-oracle", revision: 2 },
				failures: ["cancel-late-denial: expected denied; reference returned cancelled"] },
		},
	});
	return {
		root, repositoryPath, workspacePath, storageRoot, factoryStorageRoot: storageRoot, factory, mutate, operations, reopen, session, ui,
		plan, grant, grantInput, request, beforeCases, afterCases, before, after, executor, executions, contract, definition,
	};
}
