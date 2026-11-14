import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createFactoryService } from "../../factory.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { startServer } from "../../server.mjs";
import { factoryMutator } from "../factory/accessors.mjs";
import { analysisFixture, workflowDetail } from "../native/fixture.mjs";
import { PROCEDURE, seedRepository } from "../git.mjs";

/** @typedef {Pick<import("@github/copilot-sdk").SessionUiApi, "confirm" | "select" | "elicitation">} TestUi */

/** @param {{getUi?: () => import("../../server.mjs").FoundryUi | undefined, control?: (runId: string, action: string) => Promise<import("@github/copilot-sdk").WorkflowRunResult>}} [options] */
export async function fixture({ getUi, control } = {}) {
	const workspacePath = path.resolve(`.foundry-canvas-${randomUUID()}`);
	await mkdir(workspacePath, { mode: 0o700 });
	seedRepository(workspacePath);
	const factory = createFactoryService({ repositoryPath: workspacePath, storageRoot: workspacePath });
	const { unit } = factory.createUnit({
		expectedRevision: 0, id: "board", name: "Board", purpose: "Render a safe plan board",
		boundary: { owns: ["board-state"], exposes: ["board"], consumes: [], preserves: ["approval semantics"] },
		dependencies: [], relationshipCoverage: "complete", actor: "fixture",
	});
	assert.ok(unit);
	/** @type {((event: import("../../events.mjs").FoundryChangeEvent) => void) | null} */
	let subscriber = null;
	const workflow = workflowDetail({
		runId: "native-run", workflowName: "audit", status: "running", revision: 1,
		createdAt: Date.now(), canResume: false, currentPhase: { id: "audit", ordinal: 0 },
		liveAgentCount: 1, totalSpawnedAgentCount: 1, terminal: null,
		observedAt: Date.now(),
		consumed: { activeMs: 2000, subagents: 1, nanoAiu: 250_000_000 },
		declaredLimits: { maxTotalSubagents: 40, maxAiCredits: 10 },
		approved: { maxTotalSubagents: 40, maxAiCredits: 10 },
		phases: [], agents: [],
		progress: { records: [], oldestSeq: 20, newestSeq: 30, hasMoreOlder: true, hasMoreNewer: false, revision: 1 },
	});
	/** @type {Array<{runId: string, action: "pause" | "resume"}>} */
	const workflowCalls = [];
	/** @type {unknown[]} */
	const snapshotReads = [];
	const operations = createFoundryOperations({
		getWorkspacePath: () => workspacePath,
		factoryStorageRoot: workspacePath,
		notify: (event) => subscriber?.(event),
		analysis: analysisFixture({
			listWorkflowRuns: async () => ({ runs: [workflow], omittedOlder: 0 }),
			inspectWorkflow: async () => workflow,
			getWorkflowProgress: async (_runId, beforeSeq) => ({
				records: [{ seq: beforeSeq - 1, attempt: 1, phaseId: null, recordedAt: Date.now(), kind: "log", text: "Older scope" }],
				oldestSeq: beforeSeq - 1, newestSeq: beforeSeq - 1, hasMoreOlder: false, hasMoreNewer: true, revision: 1,
			}),
			controlWorkflow: async (runId, action) => {
				workflowCalls.push({ runId, action });
				if (control) return control(runId, action);
				workflow.status = action === "pause" ? "paused" : "completed";
				workflow.canResume = action === "pause";
				workflow.revision++;
				subscriber?.({ workflowRunId: runId, workflowRevision: workflow.revision });
				return { runId, status: workflow.status };
			},
			importPlanning: async (runId) => ({
				runId,
				inputDigest: "a".repeat(64),
				factoryContext: { repositoryId: factory.repository.id, unitId: unit.id, unitRevision: 1, unit, contract: null, owner: workspacePath },
				plan: {
					title: "Canvas plan",
					objective: "Render a safe plan board",
					constraints: [],
					tasks: [
						{
							id: "T-001",
							title: "Render",
							kind: "implement",
							description: "Render the plan",
							dependsOn: [],
							acceptanceCriteria: ["Board is visible"],
							expectedFiles: ["renderer/**"],
							deliveryRequirement: "commit",
						},
						{
							id: "T-002",
							title: "Verify",
							kind: "verify",
							description: "Verify the board",
							dependsOn: ["T-001"],
							acceptanceCriteria: [],
							expectedFiles: [],
							deliveryRequirement: "commit",
						},
					],
				},
			}),
		}),
	});
	let plan = await operations.createPlan({
		expectedRevision: 0,
		id: "canvas-plan",
		runId: "canvas-planning-run",
		repository: {
			workingDirectory: workspacePath,
			baseBranch: "main",
		},
	});
	assert.ok(!("state" in plan));
	plan = await operations.submitPlan({
		planId: plan.id,
		expectedRevision: plan.revision,
	});
	const server = await startServer({
		instanceId: "canvas-test",
		planId: plan.id,
		workspacePath,
		operations: {
			...operations,
			getStatus: async (input) => {
				snapshotReads.push(input);
				return operations.getStatus(input);
			},
		},
		getUi,
		subscribe: (_workspace, _plan, listener) => {
			subscriber = listener;
			return () => {
				subscriber = null;
			};
		},
	});
	return {
		workspacePath,
		operations,
		plan,
		server: {
			...server,
			async snapshot() {
				const value = await server.snapshot();
				assert.ok(value.plan !== null);
				return value;
			},
		},
		workflowCalls,
		snapshotReads,
		workflow,
		async close() {
			await server.close();
			await rm(workspacePath, { recursive: true, force: true });
		},
	};
}

export function gate() {
	let release = () => { };
	const promise = new Promise((resolve) => { release = () => resolve(undefined); });
	return { promise, release };
}

/** @param {Partial<TestUi>} [handlers] */
export function nativeUi(handlers = {}) {
	/** @type {TestUi} */
	const ui = {
		confirm: async () => true,
		select: async () => null,
		elicitation: async () => ({ action: "accept", content: { approvedBy: "native-user" } }),
		...handlers,
	};
	return ui;
}

/** @param {Awaited<ReturnType<typeof fixture>>} current */
export async function poster(current) {
	const html = await (await fetch(current.server.url)).text();
	const token = html.match(/name="foundry-token" content="([a-f0-9]+)"/)?.[1];
	assert.ok(token);
	/** @param {Record<string, unknown>} body @param {RequestInit} [options] */
	return (body, options = {}) => fetch(new URL("api/action", current.server.url), {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-foundry-token": token },
		body: JSON.stringify(body),
		...options,
	});
}

/** @param {Awaited<ReturnType<typeof fixture>>} current */
export function prepareBoardCandidate(current) {
	const service = current.operations.factoryFor(current.workspacePath);
	const call = factoryMutator(service);
	const source = { kind: "discovery", ref: "fixture:board", actor: "owner", at: new Date().toISOString() };
	call("appendKnowledge", { id: "board-contract", unitId: "board", kind: "obligation", statement: "Preserve approval boundaries", source });
	call("appendKnowledge", {
		id: "board-oracle", unitId: "board", kind: "evaluation", statement: "Evaluate the boundary", source,
		evaluation: {
			modality: "boundary", procedure: structuredClone(PROCEDURE),
			obligations: [{ id: "board-contract", revision: 1 }], environment: "node", workload: "board", maxAgeSeconds: 86400, independent: true, preservation: true
		}
	});
	call("acceptContract", { unitId: "board", unitRevision: 1, obligations: [{ id: "board-contract", revision: 1 }], evaluations: [{ id: "board-oracle", revision: 1 }], actor: "owner", reason: "Accepted scope" });
	call("prepareCandidate", {
		id: "board-candidate", unitId: "board", contractRevision: 1, actor: "producer",
		context: { generation: [], comparisonOnly: [], independence: { method: "fresh-session", reason: "Fresh producer" } }
	});
	return service;
}
