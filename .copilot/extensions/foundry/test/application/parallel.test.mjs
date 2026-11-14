import assert from "node:assert/strict";
import test from "node:test";
import { arrayOf, parseJson, readRecord } from "../../data.mjs";
import { canonicalBindings } from "../../plan/packages.mjs";
import { buildFoundryTools } from "../../tools.mjs";
import { fixture } from "../bridge/fixture.mjs";
import { must } from "../assertions.mjs";
import path from "node:path";
import { createFactoryBridge } from "../../bridge.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createFoundryOperations } from "../../operations.mjs";
import { analysisFixture } from "../native/fixture.mjs";
import { createdChild } from "../../native/dispatch.mjs";
import { git } from "../git.mjs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isRecord } from "../../data.mjs";

const readList = arrayOf(value => value);

/** @param {import("../../operations.mjs").FoundryOperations} operations
 * @param {string} name @param {unknown} args */
async function invoke(operations, name, args) {
	const tool = must(buildFoundryTools(operations).find(entry => entry.name === name));
	return tool.handler(args, { sessionId: "coordinator", toolCallId: `${name}-fixture`, toolName: name, arguments: args });
}

/** The fake replaces only the offered App transport and its observations; all factory,
 * plan, input, admission, journal and dispatch services are production instances.
 * @param {import("node:test").TestContext} t */
async function composedFixture(t) {
	const f = await fixture(t, { human: true });
	const owner = path.join(f.root, "coordinator");
	/** @type {Map<string, import("../../types/parallel.js").ParallelChild>} */
	const children = new Map();
	/** @type {Map<string, string>} */
	const messages = new Map();
	/** @type {Map<string, string>} */
	const kickoffs = new Map();
	/** @type {((child: import("../../types/parallel.js").ParallelChild) => Promise<void>) | null} */
	let beforeHandoff = null;
	/** @type {string | null} */
	let reviewerOverride = null;
	let completeAuthors = true;
	let sequence = 0, timestamp = Date.now();
	const capturedAt = () => new Date(timestamp = Math.max(timestamp + 1, Date.now())).toISOString();
	/** @type {import("../../operations.mjs").FoundryOperations} */
	let operations;
	/** @type {import("../../types/parallel.js").ParallelHost} */
	const host = {
		state: "available", session: { workspacePath: owner, sessionId: "coordinator", projectId: "fixture-project", inWorkflow: false },
		offered: new Set(["foundry_get_status", "foundry_reserve_task", "foundry_attach_task", "foundry_complete_task",
			"create_session", "get_session", "list_sessions_and_chats", "send_session_message"]),
		availability: () => "supported",
		taskPolicies: plan => Object.fromEntries(plan.tasks.map(task => [task.id, {
			resources: task.expectedFiles.map((scope, index) => ({
				id: `${task.id.toLowerCase()}-${index}`, kind: "shared-write", scope, mode: "exclusive", capacity: 1, units: 1,
			})),
			team: { id: "fixture-builders", capacity: 2, units: 1 }, dependencies: [],
		}])),
		executor: {
			async execute({ name, arguments: args }) {
				if (name.startsWith("foundry_")) return invoke(operations, name, args);
				const input = readRecord(args);
				let value;
				if (name === "create_session") {
					assert.equal(input.workspace_type, "worktree");
					assert.equal(input.coordinate_with_creator, true);
					assert.equal(input.project_id, "fixture-project");
					assert.equal(input.notify_on_idle, "always");
					assert.ok(isRecord(input.kickoff) && input.kickoff.mode === "interactive");
					assert.match(String(input.kickoff.prompt), /STOP before task execution/);
					const sessionId = `child-${++sequence}`, branch = `parallel-${sequence}`;
					const worktreePath = path.join(f.root, sessionId);
					git(f.repo, "worktree", "add", "--quiet", "-b", branch, worktreePath, String(input.base_branch));
					value = { sessionId, branch, worktreePath, projectId: "fixture-project", creatorSessionId: "coordinator" };
					children.set(sessionId, value);
					kickoffs.set(sessionId, String(input.kickoff.prompt));
				} else if (name === "get_session") {
					value = must(children.get(String(input.project_session_id)));
				} else if (name === "list_sessions_and_chats") {
					value = { complete: true, sessions: [...children.values()] };
				} else if (name === "send_session_message") {
					const child = must(children.get(String(input.session_id)));
					assert.equal(input.coordinator_only, true);
					assert.equal(input.delivery_mode, "immediate");
					assert.equal(input.mode, "autopilot");
					assert.ok(!messages.has(child.sessionId), "A successful handoff is not sent twice");
					assert.match(String(input.message), /^Foundry activate received assignment:/);
					assert.ok(String(input.message).length < 16000);
					await beforeHandoff?.(child);
					messages.set(child.sessionId, String(input.message));
					value = { sessionId: child.sessionId, accepted: true };
				} else {
					throw new Error(`Unexpected native operation: ${name}`);
				}
				return { resultType: "success", textResultForLlm: JSON.stringify(value) };
			},
		},
		decodeCreated: createdChild,
		decodeHandoff(value) {
			const entry = readRecord(value);
			assert.equal(typeof entry.sessionId, "string");
			assert.equal(entry.accepted, true);
			return { sessionId: String(entry.sessionId), accepted: true };
		},
		async observeSetup(child, reservation) {
			assert.ok(children.has(child.sessionId));
			assert.ok(!messages.has(child.sessionId));
			assert.equal(git(child.worktreePath, "status", "--porcelain"), "");
			return { sessionId: child.sessionId, message: reservation.initialization.acknowledgement,
				at: capturedAt(), source: "synthetic native setup transcript" };
		},
		async observeChild({ child, detail, inventory }) {
			assert.deepEqual(detail.value, children.get(child.sessionId));
			assert.ok(isRecord(inventory.value) && inventory.value.complete === true);
			const plan = await operations.getPlan({ planId: "composed-packages" });
			const attempt = must(plan.tasks.flatMap(task => task.attempts).find(entry => entry.status === "reserved"));
			const head = git(child.worktreePath, "rev-parse", "HEAD");
			return {
				child, capturedAt: capturedAt(), source: "synthetic native complete inventory plus real Git worktree",
				complete: true, aliases: [child.sessionId], baseBranch: attempt.baseBranch,
				baseCommit: git(f.repo, "rev-parse", `${attempt.baseBranch}^{commit}`), head,
				clean: git(child.worktreePath, "status", "--porcelain", "--untracked-files=all") === "",
			};
		},
		async readReviews({ plan, taskId }) {
			const reviewer = must(plan.tasks.find(task => task.kind === "verify")?.attempts.at(-1)?.sessionId);
			assert.ok(children.has(reviewer) && messages.has(reviewer), "Review authority comes from the actual independent native fixture child");
			return /** @type {const} */ (["implementation", "architecture", "security", "visual"]).map(kind => ({
				kind,
				required: kind === "implementation" || kind === "architecture" && taskId === "T-003",
				reason: `Synthetic JSON-output fixture ${kind} applicability`,
				reviewers: kind === "implementation" || kind === "architecture" && taskId === "T-003" ? [reviewerOverride ?? reviewer] : [],
			}));
		},
		async readContributors({ plan, taskId }) {
			const authors = new Set(["runtime-helper"]), seen = new Set();
			/** @param {string} id */
			const visit = id => {
				if (seen.has(id)) return;
				seen.add(id);
				const task = must(plan.tasks.find(entry => entry.id === id));
				authors.add(must(task.attempts.at(-1)?.sessionId));
				task.dependsOn.forEach(visit);
			};
			visit(taskId);
			return { complete: completeAuthors, source: "synthetic native complete contributor capture",
				capturedAt: new Date().toISOString(), commit: must(plan.tasks.find(task => task.id === taskId)?.attempts.at(-1)?.commit),
				authors: [...authors] };
		},
	};
	const restart = () => {
		operations = createFoundryOperations({
			getWorkspacePath: () => owner, getSession: () => ({ sessionId: "coordinator", workspacePath: owner }),
			getParallelHost: () => host, factoryStorageRoot: f.storageRoot, analysis: analysisFixture(),
		});
	};
	restart();
	return {
		...f, get operations() { return operations; }, host, owner, children, messages, kickoffs, restart,
		/** @param {(child: import("../../types/parallel.js").ParallelChild) => Promise<void>} callback */
		beforeHandoff(callback) { beforeHandoff = callback; },
		/** @param {string | null} reviewer */
		useReviewer(reviewer) { reviewerOverride = reviewer; },
		/** @param {boolean} complete */
		completeAuthors(complete) { completeAuthors = complete; },
	};
}

/** @param {unknown} value */
function assuranceReport(value) {
	const subject = readRecord(value), delivery = readRecord(subject.delivery);
	const obligations = readList(subject.reviews).map(readRecord);
	const scope = readList(subject.requirements);
	return {
		format: "foundry-package-assurance-v1", subjectDigest: subject.digest, observedAt: new Date().toISOString(),
		evaluations: readList(subject.definitions).map(readRecord).filter(entry => readRecord(entry.evaluation).modality !== "human").map(entry => {
			const evaluation = readRecord(entry.evaluation);
			const kind = evaluation.modality === "boundary" || evaluation.preservation ? "architecture" : "implementation";
			return { evaluation: { id: entry.id, revision: entry.revision },
				procedureDigest: readRecord(evaluation.procedure).digest, environment: evaluation.environment, workload: evaluation.workload,
				outcome: "passed", report: "Synthetic fixture independently checks the exact pinned JSON-output boundary",
				reviewer: readList(must(obligations.find(item => item.kind === kind)).reviewers)[0],
				independenceReason: "Actual separate native fixture verifier, not any contributing producer" };
		}),
		reviews: obligations.filter(entry => entry.required).map(entry => ({
			kind: entry.kind, author: subject.producer, reviewer: readList(entry.reviewers)[0], commit: delivery.commit,
			scope, outcome: "passed",
			findings: scope.length
				? scope.map(requirement => ({ requirement, observation: "Both pinned producer values were consumed and conserved",
					evidence: `git:${delivery.commit}:product.json` }))
				: readList(delivery.outputs).map(output => ({ output: readRecord(output).id, observation: "The exact declared JSON output was independently read",
					evidence: `git:${delivery.commit}:${readRecord(readRecord(output).artifact).path}` })),
		})),
	};
}

/** @param {Awaited<ReturnType<typeof fixture>>} f
 * @returns {import("../../types/parallel.js").PackageDecomposition} */
function packages(f) {
	const generation = f.factory.generation(f.candidate.id);
	const bindings = canonicalBindings({
		authority: "accepted-contract", repositoryId: f.factory.repository.id,
		unit: { id: generation.unit.id, revision: generation.unit.revision },
		contract: { revision: generation.contract.revision, digest: generation.contract.digest },
		requirements: generation.obligations.map(({ id, revision }) => ({ id, revision })),
		evaluators: generation.evaluations.map(({ id, revision, evaluation }) => ({
			id, revision, procedureDigest: evaluation.procedure.digest, requirements: evaluation.obligations,
			independent: evaluation.independent, modality: evaluation.modality,
		})),
		visualEvaluation: generation.unit.visualEvaluation ?? null,
	});
	return {
		format: "foundry-packages-v1", bindings, target: "product",
		packages: [
			...["alpha", "beta"].map(id => ({
				id, title: `Produce ${id}`, expectedFiles: [`${id}.json`], inputs: [],
				outputs: [{ id: "value", path: `${id}.json` }], requirements: [], evaluators: [],
			})),
			{
				id: "product", title: "Consume both exact outputs", expectedFiles: ["product.json"],
				inputs: ["alpha", "beta"].map(producer => ({
					producer, output: "value", destination: `inputs/${producer}.json`,
				})),
				outputs: [{ id: "product", path: "product.json" }], requirements: bindings.requirements,
				evaluators: bindings.evaluators.map(({ id, revision }) => ({ id, revision })),
			},
		],
	};
}

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {string} id */
function request(f, id) {
	return {
		id, candidateId: f.candidate.id, expectedRevision: 0,
		expectedFactoryRevision: f.factory.snapshot().revision,
		repository: { workingDirectory: f.repo, baseBranch: "main" },
	};
}

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {unknown} args */
async function createThroughTool(f, args) {
	const tool = must(buildFoundryTools(f.ops).find(entry => entry.name === "foundry_create_factory_plan"));
	return tool.handler(args, {
		sessionId: "coordinator", toolCallId: "package-plan", toolName: tool.name, arguments: args,
	});
}

test("registered factory planning exposes closed decomposition and compiles two producer edges without execution", async t => {
	const f = await fixture(t, { human: true, visual: true });
	const tool = must(buildFoundryTools(f.ops).find(entry => entry.name === "foundry_create_factory_plan"));
	const schema = must(tool.parameters.properties.decomposition);
	assert.equal(schema.additionalProperties, false);
	assert.ok(!tool.parameters.required.includes("decomposition"));
	const packageSchema = must(must(must(schema.properties).packages.items));
	assert.equal(packageSchema.additionalProperties, false);
	assert.ok(must(packageSchema.required).includes("inputs"));
	assert.ok(must(packageSchema.required).includes("outputs"));
	assert.equal(tool.skipPermission, undefined);
	const result = await createThroughTool(f, { ...request(f, "public-packages"), decomposition: packages(f) });
	assert.equal(result.resultType, "success", result.textResultForLlm);
	const plan = await f.ops.getPlan({ planId: "public-packages" });
	assert.equal(plan.status, "draft");
	assert.ok(plan.tasks.every(task => task.attempts.length === 0));
	assert.deepEqual(plan.tasks.map(({ id, dependsOn }) => ({ id, dependsOn })), [
		{ id: "T-001", dependsOn: [] }, { id: "T-002", dependsOn: [] },
		{ id: "T-003", dependsOn: ["T-001", "T-002"] }, { id: "T-004", dependsOn: ["T-003"] },
	]);
	assert.ok(plan.tasks[2].acceptanceCriteria.some(criterion => criterion.includes("real output captures and independent reference-to-output assessment")));
	assert.ok(!plan.tasks.flatMap(task => task.acceptanceCriteria).some(criterion => criterion.includes("Pass pinned human")));
	assert.match(plan.tasks[2].description, /human-rubric/);
});

test("registered planning rejects malformed, substituted and protected package inputs without authority mutation", async t => {
	const f = await fixture(t);
	const valid = packages(f), before = f.factory.snapshot().revision;
	const protectedOutput = structuredClone(valid);
	protectedOutput.packages[0].expectedFiles = ["package-lock.json"];
	protectedOutput.packages[0].outputs[0].path = "package-lock.json";
	for (const decomposition of [
		null, { ...valid, grants: ["imported"] }, { ...valid, packages: [] },
		{ ...valid, bindings: { ...valid.bindings, contract: { revision: 1, digest: "f".repeat(64) } } },
		protectedOutput,
	]) {
		const result = await createThroughTool(f, { ...request(f, "rejected-packages"), decomposition });
		assert.equal(result.resultType, "failure");
		assert.equal(readRecord(parseJson(result.textResultForLlm)).ok, false);
		assert.equal(f.factory.snapshot().revision, before);
		assert.equal((await f.ops.listPlans({})).plans.length, 0);
	}
});

test("registered planning keeps the omitted-decomposition two-task recipe", async t => {
	const f = await fixture(t);
	const result = await createThroughTool(f, request(f, "legacy-packages"));
	assert.equal(result.resultType, "success", result.textResultForLlm);
	const plan = await f.ops.getPlan({ planId: "legacy-packages" });
	assert.deepEqual(plan.tasks.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })), [
		{ id: "T-001", kind: "implement", dependsOn: [] },
		{ id: "T-002", kind: "verify", dependsOn: ["T-001"] },
	]);
});

test("package recovery derives its digest only from the current owner-sealed blueprint", async t => {
	const f = await fixture(t);
	const decomposition = packages(f);
	const result = await createThroughTool(f, { ...request(f, "sealed-packages"), decomposition });
	assert.equal(result.resultType, "success", result.textResultForLlm);
	const plan = await f.ops.getPlan({ planId: "sealed-packages" });
	const owner = path.join(f.root, "coordinator"), store = createPlanStore({ workspacePath: owner });
	const bridge = createFactoryBridge({
		workspace: () => owner, storeFor: () => store, storageRoot: f.storageRoot, notify: () => {},
	});
	const recovered = must(bridge.packageContext(plan));
	assert.equal(recovered.decomposition.target, "product");
	assert.deepEqual(recovered.taskIds, { alpha: "T-001", beta: "T-002", product: "T-003" });
	assert.deepEqual(recovered.governing, decomposition.bindings);
	assert.ok(recovered.policy.protectedPaths.includes("evaluators"));
	assert.deepEqual(recovered.policy.forbiddenWorktreePaths, [f.repo]);
	const altered = structuredClone(plan);
	altered.tasks[0].description = altered.tasks[0].description.replace("alpha.json", "substituted.json");
	assert.throws(() => bridge.packageContext(altered), { code: "factory_plan_mismatch" });
	const foreign = createFactoryBridge({
		workspace: () => path.join(f.root, "foreign"), storeFor: () => store, storageRoot: f.storageRoot, notify: () => {},
	});
	assert.throws(() => foreign.packageContext(plan), { code: "factory_execution_foreign" });
});

test("registered composition consumes both exact Git deliveries after handoff and prepares final independent verification", async t => {
	const f = await composedFixture(t);
	const created = await createThroughTool(f, { ...request(f, "composed-packages"), decomposition: packages(f) });
	assert.equal(created.resultType, "success", created.textResultForLlm);
	let plan = await f.approve(f.operations, await f.operations.getPlan({ planId: "composed-packages" }));
	/** @param {string} name @param {unknown} args */
	const success = async (name, args) => {
		const result = await invoke(f.operations, name, args);
		assert.equal(result.resultType, "success", result.textResultForLlm);
		return readRecord(parseJson(result.textResultForLlm)).value;
	};
	f.beforeHandoff(async child => {
		if (child.sessionId !== "child-3") return;
		const current = await f.operations.getPlan({ planId: plan.id });
		const attempt = must(current.tasks[2].attempts.at(-1));
		const held = readRecord(await success("foundry_materialize_inputs", { planId: plan.id, taskId: "T-003", attemptId: attempt.id }));
		assert.equal(held.state, "held");
		assert.equal(held.code, "parallel_consumer_held", "Attachment alone cannot authorize input writes before successful unchanged handoff");
		assert.equal(git(child.worktreePath, "status", "--porcelain"), "");
	});

	const firstDispatch = await success("foundry_dispatch_ready", { planId: plan.id, limit: 2 });
	plan = await f.operations.getPlan({ planId: plan.id });
	assert.deepEqual(plan.tasks.map(task => task.status), ["running", "running", "planned", "planned"], JSON.stringify(firstDispatch));
	assert.equal(f.children.size, 2);
	f.restart();
	await success("foundry_dispatch_ready", { planId: plan.id, limit: 2 });
	assert.equal(f.children.size, 2, "Restart reuses durable creation and handoff results");
	/** @type {Map<string, string>} */
	const commits = new Map();
	for (const [taskId, name] of [["T-002", "beta"], ["T-001", "alpha"]]) {
		plan = await f.operations.getPlan({ planId: plan.id });
		const attempt = must(plan.tasks.find(task => task.id === taskId)?.attempts.at(-1));
		const child = must(f.children.get(must(attempt.sessionId)));
		assert.ok(f.messages.has(child.sessionId));
		await writeFile(path.join(child.worktreePath, `${name}.json`), JSON.stringify({ producer: name, value: name === "alpha" ? 7 : 11 }));
		git(child.worktreePath, "add", "--", `${name}.json`);
		git(child.worktreePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", `Produce ${name}`);
		const commit = git(child.worktreePath, "rev-parse", "HEAD");
		commits.set(name, commit);
		const completion = f.payload(plan, taskId, { commit });
		await success("foundry_complete_task", completion);
		await success("foundry_complete_task", completion);
		if (name === "beta") {
			await success("foundry_dispatch_ready", { planId: plan.id, limit: 2 });
			assert.equal(f.children.size, 2, "One completed predecessor does not authorize the consumer");
		}
	}
	const consumerDispatch = await success("foundry_dispatch_ready", { planId: plan.id, limit: 2 });
	plan = await f.operations.getPlan({ planId: plan.id });
	assert.ok(plan.tasks[2].attempts.length, JSON.stringify(consumerDispatch));
	const consumer = must(plan.tasks[2].attempts.at(-1));
	assert.ok(consumer.sessionId, JSON.stringify(consumerDispatch));
	const child = must(f.children.get(must(consumer.sessionId)));
	assert.equal(f.children.size, 3);
	assert.ok(f.messages.has(child.sessionId));
	assert.equal(git(child.worktreePath, "status", "--porcelain"), "", "Setup and dispatch never materialize inputs");
	const bootstrapCommit = git(child.worktreePath, "rev-parse", "HEAD");
	const producer = must(f.children.get("child-1"));
	await writeFile(path.join(producer.worktreePath, "alpha.json"), JSON.stringify({ producer: "substituted-branch-tip", value: 999 }));
	git(producer.worktreePath, "add", "--", "alpha.json");
	git(producer.worktreePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Untrusted later branch movement");
	const substitutedCommit = git(producer.worktreePath, "rev-parse", "HEAD");
	assert.notEqual(substitutedCommit, commits.get("alpha"));
	const changedDelivery = await invoke(f.operations, "foundry_complete_task", f.payload(plan, "T-001", { commit: substitutedCommit }));
	assert.equal(changedDelivery.resultType, "failure", "A later branch tip cannot replace an immutable successful attempt");
	const materialized = readRecord(await success("foundry_materialize_inputs", { planId: plan.id, taskId: "T-003", attemptId: consumer.id }));
	assert.equal(materialized.state, "materialized");
	const alpha = JSON.parse(await readFile(path.join(child.worktreePath, "inputs/alpha.json"), "utf8"));
	const beta = JSON.parse(await readFile(path.join(child.worktreePath, "inputs/beta.json"), "utf8"));
	assert.deepEqual(alpha, { producer: "alpha", value: 7 });
	assert.deepEqual(beta, { producer: "beta", value: 11 });
	assert.ok(must(f.kickoffs.get(child.sessionId)).includes(must(commits.get("alpha"))));
	assert.ok(must(f.kickoffs.get(child.sessionId)).includes(must(commits.get("beta"))));
	assert.equal(must(f.kickoffs.get(child.sessionId)), must(consumer.startup).delegationPrompt);
	assert.match(must(f.kickoffs.get(child.sessionId)), /Pinned package inputs/);
	assert.equal(must(f.messages.get(child.sessionId)).includes("Pinned package inputs"), false);
	assert.equal(must(f.messages.get(child.sessionId)).includes('"deliveries"'), false);
	const repeated = await invoke(f.operations, "foundry_materialize_inputs", { planId: plan.id, taskId: "T-003", attemptId: consumer.id });
	const repeatHold = readRecord(readRecord(parseJson(repeated.textResultForLlm)).value);
	assert.equal(repeatHold.state, "held", "Already materialized snapshots cannot be overwritten");
	assert.equal(await readFile(path.join(child.worktreePath, "inputs/alpha.json"), "utf8"), JSON.stringify(alpha));
	assert.equal(await readFile(path.join(child.worktreePath, "inputs/beta.json"), "utf8"), JSON.stringify(beta));
	for (const commit of commits.values()) git(child.worktreePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--quiet", "--no-edit", commit);
	const consumerSource = `
		import { readFileSync, writeFileSync } from "node:fs";
		const alpha = JSON.parse(readFileSync("inputs/alpha.json", "utf8"));
		const beta = JSON.parse(readFileSync("inputs/beta.json", "utf8"));
		const product = { sum: alpha.value + beta.value, producers: [alpha.producer, beta.producer] };
		writeFileSync("product.json", JSON.stringify(product));
		process.stdout.write(JSON.stringify(product));
	`;
	const consumerArgv = ["--input-type=module", "-e", consumerSource];
	const executed = readRecord(parseJson(execFileSync(process.execPath, consumerArgv, {
		cwd: child.worktreePath, encoding: "utf8",
	})));
	assert.deepEqual(executed, { sum: 18, producers: ["alpha", "beta"] });
	await unlink(path.join(child.worktreePath, "inputs/alpha.json"));
	await unlink(path.join(child.worktreePath, "inputs/beta.json"));
	git(child.worktreePath, "add", "--", "product.json");
	git(child.worktreePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Consume exact predecessor outputs");
	const product = git(child.worktreePath, "rev-parse", "HEAD");
	assert.deepEqual(JSON.parse(git(child.worktreePath, "show", `${product}:product.json`)), { sum: 18, producers: ["alpha", "beta"] });
	for (const commit of commits.values()) git(child.worktreePath, "merge-base", "--is-ancestor", commit, product);
	await success("foundry_complete_task", f.payload(plan, "T-003", {
		commit: product,
		evidence: [{ type: "integration", outcome: "passed", source: `git:${product}:product.json`,
			summary: "Actual materialized alpha=7 and beta=11 produced sum=18; both exact delivered commits are ancestors." }],
	}));
	await success("foundry_dispatch_ready", { planId: plan.id, limit: 1 });
	plan = await f.operations.getPlan({ planId: plan.id });
	assert.equal(plan.tasks[3].kind, "verify");
	assert.equal(plan.tasks[3].status, "running");
	assert.notEqual(plan.tasks[3].attempts.at(-1)?.sessionId, consumer.sessionId);
	await success("foundry_complete_task", f.payload(plan, "T-004", { commit: product }));
	plan = await f.operations.getPlan({ planId: plan.id });
	assert.ok(plan.tasks.every(task => task.status === "done"));
	const rootSubject = readRecord(await success("foundry_assess_package", { planId: plan.id, taskId: "T-001" })).subject;
	assert.deepEqual(readRecord(rootSubject).requirements, []);
	assert.deepEqual(readRecord(rootSubject).definitions, []);
	const rootAssessment = readRecord(await success("foundry_assess_package", {
		planId: plan.id, taskId: "T-001", report: assuranceReport(rootSubject),
	}));
	assert.equal(readRecord(rootAssessment.assessment).passed, true, "An empty local obligation set uses exact output review");
	const finalSubject = readRecord(await success("foundry_assess_package", { planId: plan.id, taskId: "T-003" })).subject;
	assert.deepEqual(new Set(readList(readRecord(finalSubject).authors)), new Set(["child-1", "child-2", "child-3", "runtime-helper"]));
	assert.equal(readList(readRecord(finalSubject).definitions).length, 2, "Final target reselects every governing evaluator");
	f.useReviewer("runtime-helper");
	const authoredReview = readRecord(await success("foundry_assess_package", { planId: plan.id, taskId: "T-003" }));
	assert.equal(authoredReview.state, "held");
	assert.equal(authoredReview.code, "parallel_review_independence", "A contributing runtime helper is not an independent reviewer");
	f.useReviewer(null);
	f.completeAuthors(false);
	const incompleteAuthors = readRecord(await success("foundry_assess_package", { planId: plan.id, taskId: "T-003" }));
	assert.equal(incompleteAuthors.state, "held", "An incomplete contributor inventory cannot authorize independent review");
	f.completeAuthors(true);
	const report = assuranceReport(finalSubject);
	const substituted = readRecord(await success("foundry_assess_package", {
		planId: plan.id, taskId: "T-003", report: { ...report, subjectDigest: "f".repeat(64) },
	}));
	assert.equal(substituted.state, "held");
	assert.equal(substituted.code, "parallel_assurance_subject");
	const finalAssessment = readRecord(readRecord(await success("foundry_assess_package", {
		planId: plan.id, taskId: "T-003", report,
	})).assessment);
	assert.equal(finalAssessment.executablePassed, true);
	assert.equal(finalAssessment.passed, false);
	assert.deepEqual(finalAssessment.pendingHuman, [{ id: "human-rubric", revision: 1 }]);
	await assert.rejects(f.operations.prepareVerification({
		planId: plan.id, expectedRevision: plan.revision, reservationId: "before-human",
	}), { code: "factory_human_judgment_pending" });
	await success("foundry_record_human_judgment", {
		repositoryPath: f.repo, expectedRevision: f.factory.snapshot().revision, id: "composed-human-fixture", candidateId: f.candidate.id,
		evaluation: { id: "human-rubric", revision: 1 }, contractDigest: f.candidate.contractDigest, contextDigest: f.candidate.contextDigest,
		commit: product, procedureDigest: "a".repeat(64), outcome: "passed", environment: "fixture-node", workload: "fixture-workload",
		report: "Synthetic fixture only: the separate human evidence port is exercised, not a real human judgment.", actor: "synthetic-human",
		reason: "Separate synthetic human fixture", sourceRef: "fixture:composed-human", judgmentId: "composed-human-source",
		performedAt: new Date().toISOString(),
	});
	const prepared = await f.operations.prepareVerification({
		planId: plan.id, expectedRevision: plan.revision, reservationId: "composed-verification",
	});
	assert.equal(prepared.plan.verification.reservationId, "composed-verification");
	assert.equal(f.factory.generation(f.candidate.id).contract.digest, packages(f).bindings.contract?.digest);
	assert.equal(git(child.worktreePath, "status", "--porcelain"), "");
	t.diagnostic(JSON.stringify({
		proofBoundary: "Real Git/input consumption with synthetic App transport; not live App or human acceptance",
		consumer: { taskId: "T-003", attemptId: consumer.id, sessionId: child.sessionId, worktreePath: child.worktreePath, bootstrapCommit },
		materialized, producerCommits: Object.fromEntries(commits), rejectedBranchTip: substitutedCommit,
		execution: { argv: [process.execPath, ...consumerArgv], cwd: child.worktreePath, result: executed },
		deliveryCommit: product, verifierSessionId: plan.tasks[3].attempts.at(-1)?.sessionId,
		pendingHumanBeforeSyntheticJudgment: finalAssessment.pendingHuman,
		verificationReservationId: prepared.plan.verification.reservationId,
	}));
});

test("a successful terminal claim without declared output bytes holds its consumer, not unrelated completion", async t => {
	const f = await composedFixture(t);
	const created = await createThroughTool(f, { ...request(f, "composed-packages"), decomposition: packages(f) });
	assert.equal(created.resultType, "success", created.textResultForLlm);
	let plan = await f.approve(f.operations, await f.operations.getPlan({ planId: "composed-packages" }));
	await invoke(f.operations, "foundry_dispatch_ready", { planId: plan.id, limit: 2 });
	plan = await f.operations.getPlan({ planId: plan.id });
	assert.equal(f.children.size, 2);
	const missing = await invoke(f.operations, "foundry_complete_task", f.payload(plan, "T-001", { commit: f.commit }));
	assert.equal(missing.resultType, "success", missing.textResultForLlm);
	const beta = must(f.children.get("child-2"));
	await writeFile(path.join(beta.worktreePath, "beta.json"), "{\"value\":11}");
	git(beta.worktreePath, "add", "--", "beta.json");
	git(beta.worktreePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Unrelated valid output");
	plan = await f.operations.getPlan({ planId: plan.id });
	const independent = await invoke(f.operations, "foundry_complete_task", f.payload(plan, "T-002", {
		commit: git(beta.worktreePath, "rev-parse", "HEAD"),
	}));
	assert.equal(independent.resultType, "success", independent.textResultForLlm);
	f.restart();
	for (let request = 0; request < 2; request++) {
		await invoke(f.operations, "foundry_dispatch_ready", { planId: plan.id, limit: 2 });
		plan = await f.operations.getPlan({ planId: plan.id });
		assert.equal(plan.tasks[0].status, "done");
		assert.equal(plan.tasks[1].status, "done");
		assert.equal(plan.tasks[2].attempts.length, 0, "A DONE receipt alone is not a consumable producer output");
		assert.equal(f.children.size, 2);
	}
});
