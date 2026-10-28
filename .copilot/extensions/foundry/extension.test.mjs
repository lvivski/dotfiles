import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWorkflowAnalysis, FOUNDRY_WORKFLOWS } from "./workflow.mjs";
import { publishPlanChange, publishWorkflowChange, subscribeToPlan } from "./events.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const WORKFLOW_ROOT = path.resolve(ROOT, "workflows");

/**
 * Recursively lists production JavaScript used by extension safety checks.
 *
 * @param {string} [directory]
 * @returns {Promise<string[]>}
 */
async function sourceFiles(directory = ROOT) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
			if (entry.name !== "test") {
				files.push(...await sourceFiles(target));
			}
        } else if (/\.(?:mjs|js)$/.test(entry.name)
            && !entry.name.endsWith(".test.mjs")
            && entry.name !== "worker.mjs") {
            files.push(target);
        }
    }
    return files;
}

test("share manifest and extension entry point satisfy discovery contracts", async () => {
    const manifest = JSON.parse(await readFile(
        path.join(ROOT, "copilot-extension.json"),
        "utf8",
    ));
    assert.deepEqual(manifest, { name: "foundry" });

    const entry = await readFile(path.join(ROOT, "extension.mjs"), "utf8");
    assert.match(entry, /joinSession\(/);
    assert.match(entry, /buildFoundryTools/);
    assert.match(entry, /buildFoundryHooks/);
    assert.match(entry, /defineWorkflow/);
    assert.match(entry, /joinSession\(\{\s+workflows,/);
    assert.match(entry, /session\?\.workflow\b/);
	assert.match(entry, /session\.on\("workflow\.run_updated", \(event\) => publishWorkflowChange\(event\.data\)\)/);
});

test("native invalidations preserve plan revisions and unsubscribe with the board", () => {
	const received = [];
	const unsubscribe = subscribeToPlan("/workspace", "plan", (event) => received.push(event));
	try {
		publishPlanChange({ workspacePath: "/workspace", planId: "other", revision: 99 });
		publishPlanChange({ workspacePath: "/workspace", planId: "plan", revision: 2 });
		publishWorkflowChange({ runId: "events-run", revision: 7 });
		publishWorkflowChange({ runId: "events-run", revision: 7 });
		publishWorkflowChange({ runId: "events-run", revision: 6 });
		publishWorkflowChange({ runId: "events-run", revision: 8 });
		assert.deepEqual(received, [
			{ workspacePath: "/workspace", planId: "plan", revision: 2 },
			{ workflowRunId: "events-run", workflowRevision: 7 },
			{ workflowRunId: "events-run", workflowRevision: 8 },
		]);
	} finally {
		unsubscribe();
	}
	publishWorkflowChange({ runId: "events-run", revision: 9 });
	assert.equal(received.length, 3);
});

test("native controls preserve run identity and limits and reject ineligible runs", async () => {
	/** @type {import("@github/copilot-sdk").WorkflowRunDetail} */
	const detail = {
		runId: "native-run", workflowName: "deep-research", status: "running", revision: 1,
		createdAt: 1, completedAt: null, canResume: false, currentPhase: { title: "Research" },
		liveAgentCount: 1, totalSpawnedAgentCount: 1, terminal: null,
		progress: { records: [], oldestSeq: null, newestSeq: null, hasMoreOlder: false, hasMoreNewer: false, revision: 1 },
	};
	const calls = [];
	const backend = {
		getRun: async () => ({ runId: detail.runId, status: detail.status }),
		getRunDetail: async () => detail,
		getRunProgress: async () => detail.progress,
		listRuns: async () => ({ runs: [detail, { ...detail, workflowName: "foreign" }], omittedOlder: 4 }),
		pause: async (runId) => {
			calls.push({ action: "pause", runId });
			detail.status = "paused";
			detail.canResume = true;
			detail.terminal = { pauseInfo: { type: "user" } };
			return { runId, status: detail.status };
		},
		resume: async (runId, options) => {
			calls.push({ action: "resume", runId, options });
			detail.status = "completed";
			detail.canResume = false;
			return { runId, status: detail.status };
		},
	};
	const analysis = createWorkflowAnalysis(() => backend);
	assert.equal((await analysis.controlWorkflow("native-run", "pause")).status, "paused");
	const page = await analysis.listWorkflowRuns();
	assert.equal(page.runs.length, 1);
	assert.equal(page.omittedOlder, 4);
	assert.equal(page.runs[0].terminal?.pauseInfo?.type, "user");
	assert.equal((await analysis.controlWorkflow("native-run", "resume")).status, "completed");
	assert.deepEqual(calls, [
		{ action: "pause", runId: "native-run" },
		{ action: "resume", runId: "native-run", options: { notifyOnComplete: true, logPhaseNames: true } },
	]);
	await assert.rejects(analysis.controlWorkflow("native-run", "resume"), { code: "workflow_not_resumable" });
	await assert.rejects(analysis.controlWorkflow("native-run", "pause"), { code: "workflow_not_active" });
	detail.canResume = true;
	detail.terminal = {
		pauseInfo: null,
		failure: { type: "workflow_limit_reached", runId: detail.runId, kind: "maxAiCredits", value: 10 },
	};
	await assert.rejects(analysis.controlWorkflow("native-run", "resume"), { code: "workflow_limit_reached" });
	detail.workflowName = "foreign";
	await assert.rejects(analysis.controlWorkflow("native-run", "resume"), { code: "workflow_run_identity_mismatch" });
	detail.workflowName = "audit";
	detail.status = "running";
	await assert.rejects(createWorkflowAnalysis(() => ({ ...backend, pause: undefined }))
		.controlWorkflow("native-run", "pause"), { code: "workflow_backend_unavailable" });
	for (const response of [
		{ runId: "wrong", status: "paused" },
		{ runId: "native-run", status: "running" },
	]) {
		await assert.rejects(createWorkflowAnalysis(() => ({ ...backend, pause: async () => response }))
			.controlWorkflow("native-run", "pause"), {
			code: response.runId === "wrong" ? "workflow_run_identity_mismatch" : "workflow_control_incomplete",
		});
	}
	assert.equal(calls.length, 2);
	detail.status = "paused";
	detail.terminal = { pauseInfo: { type: "user" } };
	const controller = new AbortController();
	let completeResume = (_result) => {};
	let markStarted = () => {};
	const started = new Promise((resolve) => { markStarted = () => resolve(undefined); });
	const interruptible = createWorkflowAnalysis(() => ({
		...backend,
		resume: () => new Promise((resolve) => {
			completeResume = resolve;
			detail.status = "running";
			markStarted();
		}),
	}));
	const resuming = interruptible.controlWorkflow("native-run", "resume", { signal: controller.signal });
	await started;
	controller.abort();
	await assert.rejects(resuming, { name: "AbortError" });
	assert.equal(detail.status, "running");
	assert.equal(calls.length, 2);
	completeResume({ runId: "native-run", status: "completed" });
});

test("production source has no stdout logging", async () => {
    for (const filename of await sourceFiles()) {
        const source = await readFile(filename, "utf8");
        assert.doesNotMatch(source, /\bconsole\.log\s*\(/, filename);
    }
});

test("bundled workflows use only native Workflow primitives", async () => {
	const expectedTimeouts = {
		audit: 900,
		"deep-research": 3600,
		plan: 900,
		"review-queue": 3600,
		"security-review": 3600,
		triage: 900,
		verify: 900,
	};
    for (const specification of Object.values(FOUNDRY_WORKFLOWS)) {
		assert.ok(
			specification.meta.phases.every(
				(phase) => typeof phase?.title === "string" && phase.title.trim(),
			),
		);
		assert.equal(specification.meta.limits.maxAiCredits, 10000);
		assert.equal(
			specification.meta.limits.timeoutSeconds,
			expectedTimeouts[specification.meta.name],
		);
		const filename = path.join(WORKFLOW_ROOT, `${specification.meta.name}.mjs`);
        const source = await readFile(filename, "utf8");
		assert.match(source, new RegExp(`name:\\s*"${specification.meta.name}"`));
		assert.doesNotMatch(source, /\b(?:profile|agentType|effort|cwd|validate|retries):/);
        assert.doesNotMatch(source, /\bhost\./);
        assert.doesNotMatch(source, /\bworkspace\./);
    }
});
