import assert from "node:assert/strict";
import test from "node:test";
import { FOUNDRY_WORKFLOWS } from "../../workflows/registry.mjs";
import { must } from "../assertions.mjs";
import { addedReviewDiff, completeFetch, reviewPullRequest } from "../review/fixture.mjs";
import { securityFinding } from "../security/fixture.mjs";
import { assertClosedOutputSchema, assertOutputSchemas } from "./assertions.mjs";
import { createWorkflowContext, freezePrepared, WorkflowCheckpointPause } from "./runtime.mjs";
import { CHECKPOINT_CASES } from "./checkpoints.mjs";
import { ADDITIONAL_WORKFLOWS } from "./registry.mjs";

/** @typedef {import("@github/copilot-sdk").JsonValue} JsonValue */

test("additional workflows execute through native primitives", async () => {
	/** @type {Array<{key: string, args: JsonValue, expected: RegExp}>} */
	const cases = [
		{
			key: "audit",
			args: { paths: ["src/a.js"] },
			expected: /No verified issues found/,
		},
		{
			key: "deepResearch",
			args: { question: "What changed?", angles: 1 },
			expected: /Coverage: 1 angles researched/,
		},
		{
			key: "reviewQueue",
			args: {
				prs: [reviewPullRequest(1)],
				fetch: completeFetch(),
			},
			expected: /\| Approve \| low \|/,
		},
		{
			key: "securityReview",
			args: { root: "src", perspectives: 1 },
			expected: /No finding survived independent verification/,
		},
		{
			key: "triage",
			args: { tickets: ["The button crashes"] },
			expected: /\| 1 \| Triaged \| bug \| P2 \|/,
		},
	];

	for (const { key, args, expected } of cases) {
		const definition = ADDITIONAL_WORKFLOWS[key];
		const workflow = createWorkflowContext(args);
		const result = await definition.run(workflow);
		if (typeof result !== "string") {
			assert.fail(`${definition.meta.name} returned a non-text result`);
		}
		assert.match(result, expected, definition.meta.name);
		assert.ok(workflow.calls.length > 0, definition.meta.name);
		assert.deepEqual(workflow.pauseCalls, []);
		assertOutputSchemas(workflow);
		const declared = new Set(definition.meta.phases.map(({ title }) => title));
		assert.ok(workflow.phases.every((title) => declared.has(title)), definition.meta.name);
	}
});

test("standalone checkpoints preserve prepared scope, output, and native agent accounting on replay", async (t) => {
	for (const { key, name, args, step, checkpoint, earlyLabels, phase, scope, response } of CHECKPOINT_CASES) {
		await t.test(name ?? key, async () => {
			const definition = ADDITIONAL_WORKFLOWS[key];
			const baseline = createWorkflowContext(args, response);
			const expected = await definition.run(baseline);
			const disabled = createWorkflowContext({ ...args, pauseBeforeWork: false }, response);
			assert.equal(await definition.run(disabled), expected);
			assert.deepEqual(disabled.calls, baseline.calls);
			assert.deepEqual(disabled.pauseCalls, []);

			const pausedArgs = freezePrepared({ ...args, pauseBeforeWork: true });
			const first = createWorkflowContext(pausedArgs, response);
			await assert.rejects(definition.run(first), (error) =>
				error instanceof WorkflowCheckpointPause && error.key === checkpoint && error.name === "AbortError");
			assert.deepEqual(first.calls.map((call) => call.options.label), earlyLabels);
			assert.deepEqual(first.stepCalls, [step]);
			assert.deepEqual(first.stepExecutions, [step]);
			assert.deepEqual(first.pauseCalls, [checkpoint]);
			assert.deepEqual(first.pipelineBatches, []);
			assert.deepEqual(first.parallelBatches, []);
			assert.equal(first.phases.includes(phase), false);
			assert.ok(first.logs.some((message) => scope.test(message)));
			const prepared = JSON.stringify(first.journal.steps.get(step));

			const resumed = createWorkflowContext(pausedArgs, response, first.journal);
			assert.equal(await definition.run(resumed), expected);
			assert.deepEqual(resumed.stepCalls, [step]);
			assert.deepEqual(resumed.stepExecutions, []);
			assert.deepEqual(resumed.pauseCalls, [checkpoint]);
			assert.ok(resumed.phases.includes(phase));
			assert.deepEqual([...first.calls, ...resumed.calls], baseline.calls);
			assert.equal(first.journal.agents.size, baseline.calls.length);
			assert.equal(JSON.stringify(first.journal.steps.get(step)), prepared);
			assert.ok(resumed.logs.some((message) => scope.test(message)));

			const replay = createWorkflowContext(pausedArgs, response, first.journal);
			assert.equal(await definition.run(replay), expected);
			assert.deepEqual(replay.calls, []);
			assert.deepEqual(replay.stepExecutions, []);
		});
	}
});

test("standalone workflows reject malformed pause options before agents or journals", async (t) => {
	for (const { key, name, args } of [
		...CHECKPOINT_CASES,
		{ key: "reviewQueue", name: "empty review queue", args: { prs: [] } },
	]) {
		await t.test(name ?? key, async () => {
			for (const pauseBeforeWork of [null, 0, 1, "true", "false", [], {}]) {
				const workflow = createWorkflowContext({ ...args, pauseBeforeWork });
				await assert.rejects(ADDITIONAL_WORKFLOWS[key].run(workflow), /pauseBeforeWork must be a boolean/);
				assert.deepEqual(workflow.calls, []);
				assert.deepEqual(workflow.stepCalls, []);
				assert.deepEqual(workflow.pauseCalls, []);
			}
		});
	}
});

test("invalid work selection is rejected before scope journaling", async () => {
	/** @type {Array<[key: string, args: import("@github/copilot-sdk").WorkflowJsonSchema]>} */
	const cases = [
		["audit", { paths: [" "] }],
		["audit", { paths: ["src/a.js"], concern: "" }],
		["triage", { tickets: [""] }],
		["triage", { tickets: [{ title: " \t " }] }],
		["reviewQueue", { prs: [reviewPullRequest(1), reviewPullRequest(1)] }],
		["reviewQueue", { prs: [reviewPullRequest(1), reviewPullRequest(2)], max_total_chunks: 1 }],
		["securityReview", { perspectives: 13 }],
		["deepResearch", { question: "Question", angles: 0 }],
	];
	for (const [key, args] of cases) {
		const workflow = createWorkflowContext({ ...args, pauseBeforeWork: true });
		await assert.rejects(ADDITIONAL_WORKFLOWS[key].run(workflow));
		assert.deepEqual(workflow.calls, [], key);
		assert.deepEqual(workflow.stepCalls, [], key);
		assert.deepEqual(workflow.pauseCalls, [], key);
	}
});

test("standalone workflows retain array/string shorthand and question aliases without pausing", async () => {
	/** @type {Array<[key: string, args: import("@github/copilot-sdk").WorkflowJsonSchema, shorthand: JsonValue]>} */
	const cases = [
		["audit", { paths: ["src/a.js"] }, ["src/a.js"]],
		["triage", { tickets: ["A bug"] }, ["A bug"]],
		["reviewQueue", { prs: [reviewPullRequest(1)] }, [reviewPullRequest(1)]],
		["deepResearch", { question: "Question" }, "Question"],
		["deepResearch", { question: "Question" }, { q: "Question" }],
		["securityReview", { root: "src" }, "src"],
		["securityReview", { files: ["src/a.js"] }, ["src/a.js"]],
	];
	for (const [key, args, shorthand] of cases) {
		const baseline = createWorkflowContext(args);
		const workflow = createWorkflowContext(shorthand);
		assert.equal(await ADDITIONAL_WORKFLOWS[key].run(workflow), await ADDITIONAL_WORKFLOWS[key].run(baseline));
		assert.deepEqual(workflow.calls, baseline.calls);
		assert.deepEqual(workflow.pauseCalls, []);
	}
});

test("failed preparation never reaches an opt-in checkpoint", async () => {
	/** @type {Array<[key: string, args: Record<string, unknown>, response: null | []]>} */
	const cases = [
		["deepResearch", { question: "Question" }, null],
		["deepResearch", { question: "Question" }, []],
		["securityReview", { root: "src" }, null],
	];
	for (const [key, args, response] of cases) {
		const workflow = createWorkflowContext({ ...args, pauseBeforeWork: true }, () => response);
		const result = await ADDITIONAL_WORKFLOWS[key].run(workflow);
		assert.ok(typeof result === "string");
		assert.match(result, /incomplete/);
		assert.equal(workflow.calls.length, 1);
		assert.deepEqual(workflow.pauseCalls, []);
	}
});

test("item workflows conserve distinct records beyond former helper and metadata caps without inventing native budgets", async () => {
	const auditWorkflow = createWorkflowContext({
		paths: Array.from(
			{ length: 20 },
			(_, index) => `src/${index}.js`,
		),
	});
	const auditResult = await ADDITIONAL_WORKFLOWS.audit.run(auditWorkflow);
	assert.ok(typeof auditResult === "string");
	assert.match(auditResult, /20\/20 files processed/);
	assert.equal(auditWorkflow.calls.length, 40);

	const triageWorkflow = createWorkflowContext({
		tickets: Array.from(
			{ length: 101 },
			(_, index) => `Ticket ${index}`,
		),
	});
	const triageResult = await ADDITIONAL_WORKFLOWS.triage.run(triageWorkflow);
	assert.ok(typeof triageResult === "string");
	assert.match(triageResult, /101\/101 processed/);
	assert.equal(triageWorkflow.calls.length, 101);

	const reviewWorkflow = createWorkflowContext({
		prs: [reviewPullRequest(1)], fetch: completeFetch(),
		max_total_chunks: 351,
	});
	await ADDITIONAL_WORKFLOWS.reviewQueue.run(reviewWorkflow);
	assert.equal(reviewWorkflow.calls.length, 2);

	const metadataWorkflow = createWorkflowContext({
		fetch: completeFetch(), prs: [reviewPullRequest(1, {
			files: Array.from({ length: 3_001 }, (_, index) => `src/${index}.js`),
		})],
	});
	await ADDITIONAL_WORKFLOWS.reviewQueue.run(metadataWorkflow);
	const prepared = must(metadataWorkflow.journal.steps.get("review-queue:prepared-queue:v3"));
	assert.ok(typeof prepared === "object" && !Array.isArray(prepared));
	assert.ok(Array.isArray(prepared.prs));
	assert.ok(prepared.prs[0] && typeof prepared.prs[0] === "object" && !Array.isArray(prepared.prs[0]));
	assert.equal(Array.isArray(prepared.prs[0].files) && prepared.prs[0].files.length, 3001);

	const securityBudget = 80;
	const securityWorkflow = createWorkflowContext(
		{ root: "src", perspectives: 1 },
		(_prompt, options) => options.label.startsWith("investigate:")
			? Array.from({ length: securityBudget }, (_, index) => securityFinding(index))
			: undefined,
	);
	await ADDITIONAL_WORKFLOWS.securityReview.run(securityWorkflow);
	assert.equal(securityWorkflow.calls.filter(call => call.options.label.startsWith("verify:")).length, 80);
});

test("flat verdict and ticket schemas fit provider-native structured output", async () => {
	/** @type {Array<{key: string, args: JsonValue, label: string}>} */
	const cases = [
		{ key: "audit", args: { paths: ["src/a.js"] }, label: "verify:" },
		{ key: "triage", args: { tickets: ["A bug"] }, label: "ticket:" },
		{
			key: "reviewQueue",
			args: { prs: [reviewPullRequest(1)], fetch: completeFetch() },
			label: "owner/repo#1:verify:",
		},
		{ key: "securityReview", args: { perspectives: 1 }, label: "verify:" },
	];
	for (const { key, args, label } of cases) {
		const workflow = createWorkflowContext(args, (_prompt, options) =>
			options.label.startsWith("investigate:") ? [securityFinding()] : undefined);
		await ADDITIONAL_WORKFLOWS[key].run(workflow);
		const call = workflow.calls.find((entry) => entry.options.label.startsWith(label));
		assert.ok(call, key);
		const { schema } = call.options;
		assertClosedOutputSchema(schema);
		assert.equal(schema.type, "object");
		assert.ok(Object.values(must(schema.properties)).every((entry) =>
			entry.type === "string" || entry.type === "boolean"));
	}
});

test("item budgets count actual agents without reserving schema-correction agents", async (t) => {
	await t.test("audit reserves a separate verifier per path and one report", async () => {
		const workflow = createWorkflowContext(
			{ paths: Array.from({ length: 19 }, (_, index) => `src/${index}.js`) },
			(_prompt, options) => options.label.startsWith("review:") ? "Concrete issue" : undefined,
		);
		const result = await ADDITIONAL_WORKFLOWS.audit.run(workflow);
		assert.ok(typeof result === "string");
		assert.match(result, /19\/19 files processed; 19 verified/);
		assert.equal(workflow.calls.length, 39);
		assert.equal(workflow.calls.filter((call) => call.options.label.startsWith("verify:")).length, 19);
	});

	await t.test("triage admits 100 tickets under its 100-agent ceiling", async () => {
		const workflow = createWorkflowContext({
			tickets: Array.from({ length: 100 }, (_, index) => `Ticket ${index}`),
		});
		const result = await ADDITIONAL_WORKFLOWS.triage.run(workflow);
		assert.ok(typeof result === "string");
		assert.match(result, /100\/100 processed; 100 triaged/);
		assert.equal(workflow.calls.length, 100);
	});

	await t.test("review queue independently verifies all 350 admitted chunks", async () => {
		const workflow = createWorkflowContext({
			fetch: completeFetch(),
			diff_chunk_chars: 4000,
			max_total_chunks: 350,
			prs: [reviewPullRequest(1, {
				diff: addedReviewDiff(["x".repeat(4000 * 350 - 100)]),
			})],
		});
		const result = await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow);
		assert.ok(typeof result === "string");
		assert.match(result, /All 350 complete low-risk chunks passed independent verification/);
		assert.equal(workflow.calls.length, 700);
		assert.equal(workflow.calls.filter((call) => call.options.label.includes(":verify:")).length, 350);
	});

	await t.test("review queue retains all chunks beyond former default capacity without claiming runtime permission", async () => {
		for (const count of [300, 301]) {
			const workflow = createWorkflowContext({
				fetch: completeFetch(),
				diff_chunk_chars: 4000,
				prs: [reviewPullRequest(1, {
					diff: addedReviewDiff(["x".repeat(4000 * count - 100)]),
				})],
			});
			const result = await ADDITIONAL_WORKFLOWS.reviewQueue.run(workflow);
			assert.ok(typeof result === "string");
			assert.ok(result.includes(`All ${count} complete low-risk chunks passed independent verification`));
			assert.equal(workflow.calls.length, count * 2);
		}
	});

	await t.test("security review preserves a verifier for every admitted finding", async () => {
		const workflow = createWorkflowContext(
			{ perspectives: 1 },
			(_prompt, options) => options.label.startsWith("investigate:")
				? Array.from({ length: 78 }, (_, index) => securityFinding(index))
				: undefined,
		);
		const result = await ADDITIONAL_WORKFLOWS.securityReview.run(workflow);
		assert.ok(typeof result === "string");
		assert.match(result, /Candidates: 78\. Confirmed: 78/);
		assert.equal(workflow.calls.length, 80);
		assert.equal(workflow.calls.filter((call) => call.options.label.startsWith("verify:")).length, 78);
		assertOutputSchemas(workflow);
	});
});

test("item-oriented workflows use unique memoization labels", async () => {
	const sharedPrefix = "Regulatory landscape for Example in ";
	const researchWorkflow = createWorkflowContext(
		{ question: "Compare regions", angles: 2 },
		(_prompt, options) => options.label === "plan"
			? [`${sharedPrefix}the European Union`, `${sharedPrefix}the United States`]
			: undefined,
	);
	await FOUNDRY_WORKFLOWS.deepResearch.run(researchWorkflow);
	const researchLabels = researchWorkflow.calls.map((call) => call.options.label);
	assert.equal(new Set(researchLabels).size, researchLabels.length);

	const triageWorkflow = createWorkflowContext({
		tickets: [
			{ id: "duplicate", title: "First ticket" },
			{ id: "duplicate", title: "Second ticket" },
		],
	});
	await ADDITIONAL_WORKFLOWS.triage.run(triageWorkflow);
	const ticketLabels = triageWorkflow.calls
		.map((call) => call.options.label)
		.filter((label) => label.startsWith("ticket:"));
	assert.equal(new Set(ticketLabels).size, ticketLabels.length);
});
