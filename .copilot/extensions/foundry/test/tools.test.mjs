import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { parseJson, readRecord } from "../data.mjs";
import { createdChild } from "../native/dispatch.mjs";
import { createFoundryOperations } from "../operations.mjs";
import { requestPlanCancellation } from "../plan/cancellation.mjs";
import { canonicalBindings } from "../plan/packages.mjs";
import { createParallelStorage } from "../storage.mjs";
import { buildFoundryTools } from "../tools.mjs";
import { must } from "./assertions.mjs";
import { fixture } from "./bridge/fixture.mjs";
import { git } from "./git.mjs";
import { analysisFixture } from "./native/fixture.mjs";
import { deferred } from "./promises.mjs";

/** @param {(name: string, input: unknown, options?: import("../requests.mjs").OperationContext) => unknown} [call]
 * @returns {import("../tools.mjs").ToolOperations} */
function operationsStub(call = (operation, input) => ({ operation, input })) {
	/** @type {import("../tools.mjs").ToolOperations} */
	const target = { ...createFoundryOperations({ getWorkspacePath: () => undefined, analysis: analysisFixture() }) };
	return new Proxy(target, {
		get: (_target, name) => async (/** @type {unknown} */ input, /** @type {import("../requests.mjs").OperationContext} */ options) => call(String(name), input, options),
	});
}

/** @param {ReturnType<typeof buildFoundryTools>} tools @param {string} name */
function toolNamed(tools, name) {
	const tool = tools.find((entry) => entry.name === name);
	assert.ok(tool, `Missing tool ${name}`);
	return tool;
}

test("Foundry registers the complete globally unique tool surface", () => {
	const tools = buildFoundryTools(operationsStub());
	assert.deepEqual(tools.map((tool) => tool.name), [
		"foundry_get_factory",
		"foundry_define_unit",
		"foundry_record_knowledge",
		"foundry_accept_contract",
		"foundry_prepare_candidate",
		"foundry_record_delivery",
		"foundry_record_evaluation",
		"foundry_decide_candidate",
		"foundry_record_signal",
		"foundry_retire_artifact",
		"foundry_compact_factory",
		"foundry_export_factory",
		"foundry_export_factory_page",
		"foundry_import_factory_page",
		"foundry_abandon_factory_import",
		"foundry_import_factory",
		"foundry_migrate_factory",
		"foundry_dispatch_ready",
		"foundry_reconcile_parallel",
		"foundry_materialize_inputs",
		"foundry_assess_package",
		"foundry_capture_analysis",
		"foundry_create_evaluation_plan",
		"foundry_record_human_judgment",
		"foundry_create_factory_plan",
		"foundry_sync_factory",
		"foundry_prepare_plan",
		"foundry_create_plan",
		"foundry_control_workflow",
		"foundry_get_status",
		"foundry_list_plans",
		"foundry_export_plan",
		"foundry_import_plan",
		"foundry_quarantine_plan",
		"foundry_submit_plan",
		"foundry_plan_approval_delegation",
		"foundry_approve_plan",
		"foundry_reserve_task",
		"foundry_attach_task",
		"foundry_complete_task",
		"foundry_retry_task",
		"foundry_prepare_verification",
		"foundry_complete_verification",
		"foundry_cancel",
		"foundry_cancel_verification_run",
		"foundry_finalize_cancellation",
		"foundry_activate_plan",
		"foundry_deactivate_plan",
	]);
	assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
	for (const tool of tools) {
		assert.equal(tool.namespace.name, "foundry");
		assert.match(tool.namespace.description, /task reservations/);
		assert.equal("defer" in tool, false);
	}
	const control = toolNamed(tools, "foundry_control_workflow");
	assert.equal(control.skipPermission, undefined);
	assert.deepEqual(control.parameters.required, ["runId", "action"]);
	assert.deepEqual(control.parameters.properties.action.enum, ["pause", "resume"]);
	assert.ok(control.parameters.properties.planId);
	assert.ok(control.parameters.properties.expectedRevision);
	const approve = toolNamed(tools, "foundry_approve_plan");
	assert.equal(approve.parameters.properties.retryStatus.const, "running");
	const create = toolNamed(tools, "foundry_create_plan");
	assert.deepEqual(create.parameters.required, [
		"expectedRevision",
		"id",
		"runId",
		"repository",
	]);
	const completeVerification = toolNamed(tools, "foundry_complete_verification");
	assert.deepEqual(completeVerification.parameters.required, [
		"planId",
		"expectedRevision",
		"runId",
	]);
	const prepareVerification = toolNamed(tools, "foundry_prepare_verification");
	assert.deepEqual(prepareVerification.parameters.required, [
		"planId",
		"expectedRevision",
		"reservationId",
	]);
	assert.equal(prepareVerification.skipPermission, undefined);
	const reserve = toolNamed(tools, "foundry_reserve_task");
	assert.deepEqual(reserve.parameters.required, [
		"planId",
		"taskId",
		"expectedRevision",
		"reservationId",
	]);
	const completeTask = toolNamed(tools, "foundry_complete_task");
	assert.equal(
		must(must(completeTask.parameters.properties.evidence.items).properties).trust,
		undefined,
	);
	assert.ok(must(must(completeTask.parameters.properties.evidence.items).properties).checkId);
	assert.ok(completeTask.parameters.properties.sessionInventory);
	const cancel = toolNamed(tools, "foundry_cancel");
	assert.ok(cancel.parameters.required.includes("requestedBy"));
	assert.ok(cancel.parameters.required.includes("requestId"));
	const quarantine = toolNamed(tools, "foundry_quarantine_plan");
	assert.equal(quarantine.skipPermission, undefined);
	assert.deepEqual(quarantine.parameters.required, [
		"planId",
		"reason",
		"requestedBy",
	]);
	const cancelVerification = toolNamed(tools, "foundry_cancel_verification_run");
	assert.deepEqual(cancelVerification.parameters.required, [
		"planId",
		"expectedRevision",
		"requestId",
	]);
	const finalize = toolNamed(tools, "foundry_finalize_cancellation");
	assert.ok(finalize.parameters.required.includes("sessionInventory"));
	const imported = toolNamed(tools, "foundry_import_plan");
	assert.equal(imported.skipPermission, undefined);
	assert.deepEqual(imported.parameters.required, ["source", "expectedRevision"]);
	assert.equal(imported.parameters.properties.expectedRevision.const, 0);
	assert.equal(toolNamed(tools, "foundry_export_plan").skipPermission, true);
});

test("approval tools receive native invocation separately from caller-supplied JSON and retain native permission checks", async () => {
	const supplied = { invocation: { sessionId: "forged", toolCallId: "forged" } };
	const invocation = { sessionId: "owner", toolCallId: "native-call", toolName: "approval", arguments: supplied };
	const tools = buildFoundryTools(operationsStub((_name, input, options) => {
		assert.equal(input, supplied);
		assert.equal(options?.invocation, invocation);
	}));
	for (const name of ["foundry_approve_plan", "foundry_plan_approval_delegation",
		"foundry_dispatch_ready", "foundry_reconcile_parallel", "foundry_materialize_inputs", "foundry_assess_package",
		"foundry_reserve_task", "foundry_attach_task", "foundry_complete_task", "foundry_cancel"]) {
		const tool = toolNamed(tools, name);
		assert.equal(tool.skipPermission, undefined);
		assert.equal(tool.parameters.properties.invocation, undefined);
		assert.equal((await tool.handler(supplied, invocation)).resultType, "success");
	}
});

test("parallel public requests reject caller authority and malformed bounds before accessing stores", async () => {
	const tools = buildFoundryTools(createFoundryOperations({ getWorkspacePath: () => undefined, analysis: analysisFixture() }));
	const requests = [
		{ name: "foundry_dispatch_ready", args: { planId: "plan", limit: 1 } },
		{ name: "foundry_reconcile_parallel", args: { planId: "plan", taskId: "T-001", reservationId: "original" } },
		{ name: "foundry_materialize_inputs", args: { planId: "plan", taskId: "T-001", attemptId: "T-001-A001" } },
		{ name: "foundry_assess_package", args: { planId: "plan", taskId: "T-001" } },
	];
	for (const { name, args } of requests) {
		const tool = toolNamed(tools, name);
		assert.equal(tool.skipPermission, undefined);
		assert.equal(tool.parameters.additionalProperties, false);
		for (const key of ["owner", "sessionId", "worktreePath", "receipt", "grants", "history", "claims", "sessionInventory", "invocation", "reviewers", "taskPolicies", "contributors", "authors", "capturedAt", "source", "commit"]) {
			const supplied = { ...args, [key]: "forged" };
			const result = await tool.handler(supplied, { sessionId: "coordinator", toolCallId: "closed-request", toolName: name, arguments: supplied });
			assert.equal(result.resultType, "failure", `${name}:${key}`);
			assert.equal(readRecord(readRecord(parseJson(result.textResultForLlm)).error).code, "unknown_field");
		}
	}
	for (const limit of [0, 129, 1.5, NaN, "1"]) {
		const args = { planId: "plan", limit };
		const result = await toolNamed(tools, "foundry_dispatch_ready").handler(args, {
			sessionId: "coordinator", toolCallId: "bounded-request", toolName: "foundry_dispatch_ready", arguments: args,
		});
		assert.equal(readRecord(readRecord(parseJson(result.textResultForLlm)).error).code, "parallel_request_invalid");
	}
});

/** Real factory/plan/admission/journal/dispatch/recovery composition. Only the offered
 * transport and its supported native host observations are fixture implementations.
 * @param {import("node:test").TestContext} t @param {boolean} [decomposed] */
async function publicParallelFixture(t, decomposed = false) {
	const f = await fixture(t);
	let plan;
	if (decomposed) {
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
		plan = await f.approve(f.ops, await f.ops.createFactoryPlan({
			id: "public-parallel", expectedRevision: 0, expectedFactoryRevision: f.factory.snapshot().revision,
			candidateId: f.candidate.id, repository: { workingDirectory: f.repo, baseBranch: "main" },
			decomposition: {
				format: "foundry-packages-v1", bindings, target: "implementation",
				packages: [{
					id: "implementation", title: "Implement the conserved boundary", expectedFiles: ["implementation.mjs"], inputs: [],
					outputs: [{ id: "implementation", path: "implementation.mjs" }], requirements: bindings.requirements,
					evaluators: bindings.evaluators.map(({ id, revision }) => ({ id, revision })),
				}],
			},
		}));
	} else plan = await f.generationPlan("public-parallel");
	const workspacePath = path.join(f.root, "coordinator");
	const storage = createParallelStorage({
		workspacePath: f.factory.repository.commonDirectory, directoryParts: ["foundry", "parallel"],
		repositoryId: f.factory.repository.id, owner: workspacePath,
	});
	const control = { unproven: "", loseCreation: false, recovered: false, terminal: false, recoveries: 0 };
	/** @type {string[]} */
	const calls = [];
	/** @type {Map<string, import("../types/parallel.js").ParallelChild>} */
	const children = new Map();
	/** @type {Map<string, import("../types/parallel.js").ParallelChild>} */
	const created = new Map();
	/** @type {ReturnType<typeof buildFoundryTools>} */
	let tools;
	/** @param {unknown} value */
	const success = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });
	/** @type {Extract<import("../types/parallel.js").ParallelHost, {state: "available"}>} */
	const host = {
		state: "available",
		session: { workspacePath, sessionId: "coordinator", projectId: "fixture-project", inWorkflow: false },
		offered: new Set(["foundry_get_status", "foundry_reserve_task", "foundry_attach_task", "foundry_complete_task",
			"create_session", "get_session", "list_sessions_and_chats", "send_session_message"]),
		availability: name => control.unproven === name ? "unproven" : "supported",
		taskPolicies: current => Object.fromEntries(current.tasks.map(task => [task.id, { resources: [], team: null, dependencies: [] }])),
		executor: { async execute({ name, arguments: args, toolCallId }) {
			calls.push(name);
			const input = readRecord(args);
			if (name.startsWith("foundry_")) {
				const tool = toolNamed(tools, name);
				return tool.handler(input, {
					sessionId: host.session.sessionId, toolCallId: must(toolCallId), toolName: name, arguments: input,
				});
			}
			if (name === "create_session") {
				const number = children.size + 1;
				const child = { sessionId: `child-${number}`, projectId: host.session.projectId, creatorSessionId: host.session.sessionId,
					worktreePath: path.join(f.root, `child-${number}`), branch: `child-${number}` };
				git(f.repo, "worktree", "add", "--quiet", "-b", child.branch, child.worktreePath, String(input.base_branch));
				children.set(child.sessionId, child);
				created.set(must(toolCallId), child);
				if (control.loseCreation) throw new Error("Recorded host created the child; transport result was lost");
				return success(child);
			}
			if (name === "get_session") return success(must(children.get(String(input.project_session_id))));
			if (name === "list_sessions_and_chats") return success({ complete: true, sessions: [...children.values()] });
			if (name === "send_session_message") {
				assert.equal(input.coordinator_only, true);
				return success({ sessionId: input.session_id, accepted: true });
			}
			throw new Error(`No fixture route for ${name}`);
		} },
		decodeCreated: createdChild,
		decodeHandoff: value => {
			const result = readRecord(value);
			assert.equal(typeof result.sessionId, "string");
			return { sessionId: String(result.sessionId), accepted: result.accepted === true };
		},
		observeSetup: async (child, reservation) => ({
			sessionId: child.sessionId, message: reservation.initialization.acknowledgement,
			at: new Date(Date.now() + 1000).toISOString(), source: "recorded fixture setup turn",
		}),
		observeChild: async ({ child, after }) => ({
			child, capturedAt: new Date(Date.parse(after) + 1).toISOString(), source: "recorded complete canonical host observation",
			complete: true, aliases: [child.sessionId], baseBranch: "main", baseCommit: f.commit, head: f.commit, clean: true,
		}),
		reconcile: async receipt => {
			const child = created.get(receipt.id);
			return control.recovered && child ? { value: child, raw: child, source: "exact fixture creation correlation" } : null;
		},
		observeRecovery: async ({ identity, after }) => {
			control.recoveries++;
			const record = must(storage.admission.read(identity));
			return {
				complete: true, capturedAt: new Date(Date.parse(after) + 2000).toISOString(), source: "recorded complete native fixture inventory",
				runs: [], sessions: [...children.values()].map(child => ({
					id: child.sessionId, status: control.terminal ? "completed" : "idle", attempt: must(record.attempt),
				})),
			};
		},
	};
	const open = () => createFoundryOperations({
		getWorkspacePath: () => workspacePath, factoryStorageRoot: f.storageRoot, analysis: analysisFixture(),
		getParallelHost: () => host,
	});
	let operations = open();
	tools = buildFoundryTools(operations);
	/** @param {string} name @param {unknown} args
	 * @param {Partial<import("@github/copilot-sdk").ToolInvocation>} [invocation] */
	const invoke = async (name, args, invocation = {}) => {
		const result = await toolNamed(tools, name).handler(args, {
			sessionId: "coordinator", toolCallId: "public-invocation", toolName: name, arguments: args, ...invocation,
		});
		const decoded = readRecord(parseJson(result.textResultForLlm));
		return { result, value: readRecord(decoded.ok ? decoded.value : decoded.error) };
	};
	return {
		f, plan, storage, host, control, calls, children, invoke,
		operations: () => operations,
		reopen() { operations = open(); tools = buildFoundryTools(operations); },
	};
}

test("registered bounded dispatch uses the actual shared admission and never re-creates after a lost response", async t => {
	const f = await publicParallelFixture(t);
	f.control.loseCreation = true;
	const first = await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
	assert.equal(first.result.resultType, "success");
	assert.equal(f.children.size, 1);
	const record = must(f.storage.admission.list()[0]);
	assert.equal(record.phase, "reserved");
	assert.equal(record.receipts[0].state, "uncertain");
	const attempt = must(record.attempt);
	const prepared = f.storage.journal.payload(attempt, "creation");
	assert.ok(prepared);
	f.reopen();
	const held = await f.invoke("foundry_reconcile_parallel", {
		planId: f.plan.id, taskId: record.identity.taskId, reservationId: record.identity.reservationId,
	});
	assert.equal(held.value.code, "dispatch_effect_uncertain");
	assert.equal(f.children.size, 1);
	f.control.recovered = true;
	const resumed = await f.invoke("foundry_reconcile_parallel", {
		planId: f.plan.id, taskId: record.identity.taskId, reservationId: record.identity.reservationId,
	});
	assert.equal(resumed.value.state, "handed-off", JSON.stringify(resumed.value));
	assert.equal(f.children.size, 1);
	assert.deepEqual(f.storage.journal.payload(attempt, "creation"), prepared);
	assert.deepEqual(must(f.storage.admission.read(record.identity)).receipts.map(receipt => receipt.state), ["succeeded", "succeeded", "succeeded"]);
	assert.equal((await f.operations().getPlan({ planId: f.plan.id })).tasks[0].attempts.length, 1);
	assert.equal(f.calls.filter(name => name === "create_session").length, 1);
	assert.equal(f.calls.filter(name => name === "send_session_message").length, 1);
});

test("parallel writes reject unavailable routes, workflow/subagent/foreign invocation and manual materialization", async t => {
	const f = await publicParallelFixture(t);
	const args = { planId: f.plan.id, limit: 1 };
	f.control.unproven = "create_session";
	assert.equal((await f.invoke("foundry_dispatch_ready", args)).value.code, "dispatch_capability_unavailable");
	f.control.unproven = "";
	for (const invocation of [{ sessionId: "foreign" }, { agentId: "worker" }]) {
		assert.equal((await f.invoke("foundry_dispatch_ready", args, invocation)).value.code, "parallel_invocation_owner");
	}
	f.host.session.inWorkflow = true;
	assert.equal((await f.invoke("foundry_dispatch_ready", args)).value.code, "parallel_invocation_owner");
	f.host.session.inWorkflow = false;
	const setup = f.host.observeSetup;
	delete f.host.observeSetup;
	assert.equal((await f.invoke("foundry_dispatch_ready", args)).value.code, "dispatch_observation_unavailable");
	f.host.observeSetup = setup;
	assert.equal(f.storage.admission.list().length, 0);
	assert.deepEqual(f.calls, []);
	const direct = await f.operations().dispatchReady(args);
	assert.ok("code" in direct && direct.code === "parallel_invocation_owner");
	const noHost = createFoundryOperations({
		getWorkspacePath: () => f.host.session.workspacePath, factoryStorageRoot: f.f.storageRoot, analysis: analysisFixture(),
	});
	const missing = await noHost.dispatchReady(args, { invocation: { sessionId: "coordinator", toolCallId: "missing-host" } });
	assert.equal(missing.state, "held");
	assert.ok("code" in missing && missing.code === "parallel_host_unavailable");
	const materialized = await f.invoke("foundry_materialize_inputs", { planId: f.plan.id, taskId: "T-001", attemptId: "T-001-A001" });
	assert.equal(materialized.value.code, "parallel_attempt_mismatch");
	assert.equal((await f.invoke("foundry_assess_package", { planId: f.plan.id, taskId: "T-001" })).value.code, "parallel_review_port_unavailable");
	f.host.readReviews = async () => [];
	assert.equal((await f.invoke("foundry_assess_package", { planId: f.plan.id, taskId: "T-001" })).value.code, "parallel_contributor_port_unavailable");
});

test("registered assurance requires current complete exact-delivery contributor evidence and excludes runtime helpers", async t => {
	const f = await publicParallelFixture(t, true);
	await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
	const current = await f.operations().getPlan({ planId: f.plan.id });
	const completed = await f.invoke("foundry_complete_task", f.f.payload(current, "T-001"));
	assert.equal(completed.result.resultType, "success", JSON.stringify(completed.value));
	const reviews = /** @type {const} */ (["implementation", "architecture", "security", "visual"]).map(kind => ({
		kind, required: ["implementation", "architecture"].includes(kind), reason: `Fixture ${kind} applicability`,
		reviewers: ["implementation", "architecture"].includes(kind) ? ["reviewer"] : [],
	}));
	f.host.readReviews = async () => reviews;
	const capture = async () => ({
		complete: true, source: "recorded scoped fixture contributor capture", capturedAt: new Date().toISOString(),
		commit: f.f.commit, authors: ["runtime-helper"],
	});
	f.host.readContributors = capture;
	const request = { planId: f.plan.id, taskId: "T-001" };
	const prepared = await f.invoke("foundry_assess_package", request);
	assert.equal(prepared.value.state, "subject", JSON.stringify(prepared.value));
	const authors = readRecord(prepared.value.subject).authors;
	assert.ok(Array.isArray(authors));
	assert.deepEqual(new Set(authors), new Set(["child-1", "runtime-helper"]),
		"The bridge always includes the actual native producer, even when the host only lists its runtime helper");
	for (const [overrides, code] of /** @type {[Partial<import("../types/parallel.js").ParallelContributors>, string][]} */ ([
		[{ complete: false }, "parallel_contributors_incomplete"],
		[{ capturedAt: "2000-01-01T00:00:00.000Z" }, "parallel_contributors_stale"],
		[{ capturedAt: "2100-01-01T00:00:00.000Z" }, "parallel_contributors_stale"],
		[{ commit: "a".repeat(40) }, "parallel_contributors_mismatch"],
		[{ source: "" }, "factory_input_invalid"],
		[{ authors: [] }, "factory_input_invalid"],
	])) {
		f.host.readContributors = async () => ({ ...await capture(), ...overrides });
		const held = await f.invoke("foundry_assess_package", request);
		assert.equal(held.value.state, "held");
		assert.equal(held.value.code, code);
	}
	f.host.readContributors = capture;
	f.host.readReviews = async () => reviews.map(review => ({ ...review, reviewers: review.required ? ["runtime-helper"] : [] }));
	assert.equal((await f.invoke("foundry_assess_package", request)).value.code, "parallel_review_independence");
	f.host.readReviews = async ({ plan }) => {
		await f.operations().storeFor().update(plan.id, plan.revision, plan);
		return reviews;
	};
	assert.equal((await f.invoke("foundry_assess_package", request)).value.code, "parallel_review_context_changed");
});

test("registered cancellation recovery joins actual plan fencing and sourced termination without treating idle as terminal", async t => {
	const f = await publicParallelFixture(t);
	await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
	const record = must(f.storage.admission.list()[0]);
	const current = await f.operations().getPlan({ planId: f.plan.id });
	const cancelled = await f.invoke("foundry_cancel", {
		planId: current.id, expectedRevision: current.revision, requestId: "owner-stop", reason: "Stop fixture work", requestedBy: "owner",
	});
	assert.equal(cancelled.value.status, "cancelling");
	assert.equal(must(f.storage.admission.read(record.identity)).phase, "cancelling");
	const planIdentity = { repositoryId: record.identity.repositoryId, owner: record.identity.owner, planId: current.id };
	const fenced = f.storage.admission.readCancellation(planIdentity);
	assert.ok(fenced.fence);
	f.reopen();
	assert.deepEqual(f.storage.admission.readCancellation(planIdentity), fenced);
	const finalization = {
		planId: current.id, expectedRevision: Number(cancelled.value.revision), finalizedBy: "owner",
		dispositions: [{ attemptId: must(record.attempt).attemptId, disposition: "session-terminated", sessionId: "child-1" }],
		sessionInventory: { complete: true, capturedAt: new Date(Date.now() + 4000).toISOString(), sessions: [{ id: "child-1", status: "completed" }] },
	};
	assert.equal((await f.invoke("foundry_finalize_cancellation", finalization)).value.code, "parallel_cancellation_join_pending",
		"Installing the plan fence does not settle uncertain native obligations");
	const request = { planId: current.id, taskId: record.identity.taskId, reservationId: record.identity.reservationId };
	const first = await f.invoke("foundry_reconcile_parallel", request);
	assert.equal(first.value.state, "held");
	assert.equal(must(f.storage.admission.read(record.identity)).phase, "cancelling");
	assert.equal(f.control.recoveries, 1);
	f.control.terminal = true;
	const second = await f.invoke("foundry_reconcile_parallel", request);
	assert.equal(second.value.state, "released", JSON.stringify(second.value));
	assert.equal(f.control.recoveries, 2);
	assert.equal(must(f.storage.admission.read(record.identity)).phase, "released");
	assert.equal(f.children.size, 1);
	const lateIdentity = { ...record.identity, taskId: "T-002", reservationId: "stale-writer-after-census" };
	assert.throws(() => f.storage.admission.claim({ identity: lateIdentity, expectedRevision: 0, resources: [], team: null }),
		{ code: "parallel_fenced" }, "The permanent plan fence rejects a restarted stale writer after every previous admission was released");
	assert.equal(f.storage.admission.read(lateIdentity), null);
	f.control.terminal = false;
	assert.equal((await f.invoke("foundry_finalize_cancellation", finalization)).value.code, "parallel_cancellation_join_pending",
		"Released claims and caller-supplied terminal inventory cannot replace fresh native termination evidence");
	assert.equal((await f.operations().getPlan({ planId: current.id })).status, "cancelling");
	const observe = f.host.observeRecovery;
	delete f.host.observeRecovery;
	assert.equal((await f.invoke("foundry_finalize_cancellation", finalization)).value.code, "parallel_observation_unavailable");
	f.host.observeRecovery = observe;
	f.control.terminal = true;
	const finalized = await f.invoke("foundry_finalize_cancellation", finalization);
	assert.equal(finalized.value.status, "cancelled", JSON.stringify(finalized.value));
	assert.equal((await f.invoke("foundry_finalize_cancellation", finalization)).value.status, "cancelled", "Response-loss retry retains the same terminal receipt");
	assert.equal(f.storage.admission.readCancellation(planIdentity).fence?.cancelledAt, fenced.fence.cancelledAt);
});

test("registered finalization checks native ownership retained by already-delivered admissions", async t => {
	const f = await publicParallelFixture(t);
	await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
	let plan = await f.operations().getPlan({ planId: f.plan.id });
	await f.invoke("foundry_complete_task", f.f.payload(plan, "T-001"));
	const delivered = must(f.storage.admission.list()[0]);
	assert.equal(delivered.phase, "released");
	assert.ok(delivered.delivery);
	plan = await f.operations().getPlan({ planId: f.plan.id });
	await f.invoke("foundry_cancel", {
		planId: plan.id, expectedRevision: plan.revision, requestId: "stop-after-delivery",
		reason: "Stop remaining work after producer delivery", requestedBy: "owner",
	});
	plan = await f.operations().getPlan({ planId: f.plan.id });
	assert.deepEqual(plan.cancellation?.requiredAttemptIds, [], "Legacy active-attempt cancellation does not include this completed producer");
	const input = {
		planId: plan.id, expectedRevision: plan.revision, finalizedBy: "owner", dispositions: [],
		sessionInventory: { complete: true, capturedAt: new Date(Date.now() + 4000).toISOString(), sessions: [] },
	};
	assert.equal((await f.invoke("foundry_finalize_cancellation", input)).value.code, "parallel_cancellation_join_pending");
	f.control.terminal = true;
	assert.equal((await f.invoke("foundry_finalize_cancellation", input)).value.status, "cancelled");
	assert.deepEqual(f.storage.admission.read(delivered.identity), delivered, "Finalization does not rewrite delivery or released history");
});

test("registered cancellation fences every current owned admission before a stale create or handoff status resumes", async t => {
	for (const point of ["creation", "handoff"]) await t.test(point, async t => {
		const f = await publicParallelFixture(t);
		const identity = {
			repositoryId: f.f.factory.repository.id, owner: f.host.session.workspacePath,
			planId: f.plan.id, taskId: "T-001", reservationId: "retained-reservation",
		};
		f.storage.admission.claim({ identity, expectedRevision: 0, resources: [], team: null });
		const foreign = createParallelStorage({
			workspacePath: f.f.factory.repository.commonDirectory, directoryParts: ["foundry", "parallel"],
			repositoryId: identity.repositoryId, owner: path.join(f.f.root, "foreign-owner"),
		});
		const foreignIdentity = { ...identity, owner: path.join(f.f.root, "foreign-owner") };
		const foreignRecord = foreign.admission.claim({ identity: foreignIdentity, expectedRevision: 0, resources: [], team: null });
		const execute = f.host.executor.execute;
		let cancelled = false;
		f.host.executor.execute = async input => {
			const result = await execute(input);
			const record = f.storage.admission.read(identity);
			if (input.name === "foundry_get_status" && !cancelled && record?.attempt
				&& (point === "creation" ? record.receipts.some(receipt => receipt.kind === "creation" && receipt.state === "intent")
					: record.receipts.some(receipt => receipt.kind === "attachment" && receipt.state === "succeeded"))) {
				cancelled = true;
				// The after-read holds another original claim that never appears in
				// the plan's active-attempt snapshot; cancellation must enumerate it.
				f.storage.admission.claim({
					identity: { ...identity, taskId: "T-002", reservationId: "retained-unbound-verifier" },
					expectedRevision: 0, resources: [], team: null,
				});
				const plan = await f.operations().getPlan({ planId: f.plan.id });
				const pending = record.receipts;
				const cancellation = await f.invoke("foundry_cancel", {
					planId: plan.id, expectedRevision: plan.revision, requestId: "stale-status-stop",
					reason: "Cancel before the retained status resumes", requestedBy: "owner",
				});
				assert.equal(cancellation.value.status, "cancelling");
				const owned = f.storage.admission.list().filter(entry => entry.identity.owner === identity.owner);
				assert.equal(owned.length, 2);
				assert.ok(owned.every(entry => entry.phase === "cancelling"));
				assert.deepEqual(must(f.storage.admission.read(identity)).receipts, pending, "Cancellation preserves intents/outcomes for journal recovery");
				assert.deepEqual(foreign.admission.read(foreignIdentity), foreignRecord);
			}
			return result;
		};
		await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
		assert.ok(cancelled);
		assert.equal(f.calls.filter(name => name === "create_session").length, point === "creation" ? 0 : 1);
		assert.equal(f.calls.includes("send_session_message"), false);
		const retained = must(f.storage.admission.read(identity));
		assert.equal(retained.phase, "cancelling");
		assert.equal(retained.delivery, null);
		await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
		assert.equal(f.calls.filter(name => name === "create_session").length, point === "creation" ? 0 : 1);
		assert.equal(f.calls.includes("send_session_message"), false);
	});
});

test("the executor boundary rechecks a plan cancelled after journal start without releasing the uncertain effect", async t => {
	for (const point of ["create_session", "send_session_message"]) await t.test(point, async t => {
		const f = await publicParallelFixture(t);
		/** @type {Promise<import("../types/plan.js").FoundryPlan> | undefined} */
		let committed;
		f.host.availability = name => {
			const record = f.storage.admission.list().find(entry => entry.identity.owner === f.host.session.workspacePath);
			const kind = point === "create_session" ? "creation" : "handoff";
			if (name === point && !committed && record?.receipts.some(receipt => receipt.kind === kind && receipt.state === "in-flight")) {
				const plan = f.operations().storeFor().readCurrent(f.plan.id);
				// Real plan persistence models interruption after the first database
				// commit, before the cancellation join can fence the second database.
				committed = f.operations().storeFor().update(plan.id, plan.revision, requestPlanCancellation(plan, {
					requestId: "between-databases", reason: "Stop before native invocation", requestedBy: "owner",
				}));
				assert.equal(f.operations().storeFor().readCurrent(plan.id).status, "cancelling");
			}
			return "supported";
		};
		await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
		assert.ok(committed);
		const plan = await committed;
		assert.equal(f.calls.includes(point), false, "No actual executor invocation after the final durable cancellation read");
		const record = must(f.storage.admission.list()[0]);
		const uncertain = must(record.receipts.find(receipt => receipt.kind === (point === "create_session" ? "creation" : "handoff")));
		assert.equal(uncertain.state, "uncertain");
		const outcome = await f.invoke("foundry_cancel", {
			planId: plan.id, expectedRevision: plan.revision, requestId: "between-databases",
			reason: "Stop before native invocation", requestedBy: "owner",
		});
		assert.equal(outcome.value.status, "cancelling");
		assert.equal(must(f.storage.admission.read(record.identity)).phase, "cancelling");
		assert.equal(must(f.storage.admission.read(record.identity)).receipts.find(receipt => receipt.id === uncertain.id)?.state, "uncertain");
	});
});

test("a delayed offered reservation cannot admit work after registered cancellation", async t => {
	const f = await publicParallelFixture(t);
	/** @type {ReturnType<typeof deferred<void>>} */
	const reached = deferred();
	/** @type {ReturnType<typeof deferred<void>>} */
	const resume = deferred();
	const execute = f.host.executor.execute;
	f.host.executor.execute = async input => {
		if (input.name === "foundry_reserve_task") {
			reached.resolve();
			await resume.promise;
		}
		return execute(input);
	};
	const dispatch = f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
	await reached.promise;
	try {
		const cancellation = await f.invoke("foundry_cancel", {
			planId: f.plan.id, expectedRevision: f.plan.revision, requestId: "reservation-stop",
			reason: "Stop while the offered reserve call is delayed", requestedBy: "owner",
		});
		assert.equal(cancellation.value.status, "cancelling");
		assert.deepEqual(f.storage.admission.list(), []);
		const noHost = createFoundryOperations({
			getWorkspacePath: () => f.host.session.workspacePath, factoryStorageRoot: f.f.storageRoot, analysis: analysisFixture(),
		});
		await assert.rejects(noHost.finalizeCancellation({
			planId: f.plan.id, expectedRevision: Number(cancellation.value.revision), finalizedBy: "owner", dispositions: [],
			sessionInventory: { complete: true, capturedAt: new Date(Date.now() + 4000).toISOString(), sessions: [] },
		}), { code: "parallel_host_unavailable" }, "Even an empty durable fence cannot downgrade to legacy finalization after host loss");
	} finally { resume.resolve(); }
	await dispatch;
	assert.deepEqual(f.storage.admission.list(), []);
	assert.equal(f.children.size, 0);
});

test("a stale T003 claim after the plan commit is fenced when its reservation call settles", async t => {
	const f = await publicParallelFixture(t);
	/** @type {Promise<import("../types/plan.js").FoundryPlan> | undefined} */
	let committed;
	f.host.taskPolicies = plan => {
		if (!committed) committed = f.operations().storeFor().update(plan.id, plan.revision, requestPlanCancellation(plan, {
			requestId: "claim-stop", reason: "Stop after T003 reads its reservation snapshot", requestedBy: "owner",
		}));
		return Object.fromEntries(plan.tasks.map(task => [task.id, { resources: [], team: null, dependencies: [] }]));
	};
	const result = await f.invoke("foundry_reserve_task", {
		planId: f.plan.id, taskId: "T-001", expectedRevision: f.plan.revision, reservationId: "stale-native-reservation",
	});
	assert.equal(result.value.code, "revision_conflict");
	assert.ok(committed);
	await committed;
	const record = must(f.storage.admission.list()[0]);
	assert.equal(record.identity.reservationId, "stale-native-reservation");
	assert.equal(record.phase, "cancelling");
	assert.equal(record.attempt, null, "Unknown reservation outcome stays held, never released or replaced");
	assert.equal(f.children.size, 0);
});

test("registered dispatch resumes the original held claim and completion persists delivery before readiness", async t => {
	const f = await publicParallelFixture(t);
	const identity = {
		repositoryId: f.f.factory.repository.id, owner: f.host.session.workspacePath,
		planId: f.plan.id, taskId: "T-001", reservationId: "original-held-reservation",
	};
	f.storage.admission.claim({ identity, expectedRevision: 0, resources: [], team: null });
	assert.deepEqual((await f.operations().nextTasks({ planId: f.plan.id })).tasks, []);
	const dispatch = await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 1 });
	assert.equal(dispatch.value.state, "bounded");
	let record = must(f.storage.admission.read(identity));
	assert.equal(record.phase, "reserved");
	assert.equal(f.storage.admission.list().length, 1);
	const current = await f.operations().getPlan({ planId: f.plan.id });
	assert.equal(current.tasks[0].attempts[0].reservationId, identity.reservationId);
	const noHost = createFoundryOperations({
		getWorkspacePath: () => f.host.session.workspacePath, factoryStorageRoot: f.f.storageRoot, analysis: analysisFixture(),
	});
	await assert.rejects(noHost.completeTask(f.f.payload(current, "T-001")), { code: "parallel_host_unavailable" });
	await assert.rejects(noHost.reserveTask({
		planId: current.id, taskId: "T-001", reservationId: identity.reservationId, expectedRevision: current.revision,
	}), { code: "parallel_host_unavailable" });
	const forged = await f.invoke("foundry_complete_task", {
		...f.f.payload(current, "T-001"), sessionInventory: { complete: true, capturedAt: new Date().toISOString(), sessions: [] },
	});
	assert.equal(forged.value.code, "parallel_inventory_untrusted");
	const completed = await f.invoke("foundry_complete_task", f.f.payload(current, "T-001"));
	assert.equal(completed.result.resultType, "success", JSON.stringify(completed.value));
	record = must(f.storage.admission.read(identity));
	assert.equal(record.phase, "released");
	assert.equal(record.delivery?.commit, f.f.commit);
	assert.equal(record.delivery?.sessionId, current.tasks[0].attempts[0].sessionId);
	f.reopen();
	assert.deepEqual((await f.operations().nextTasks({ planId: f.plan.id })).tasks.map(task => task.id), ["T-002"]);
	const replay = await f.invoke("foundry_complete_task", f.f.payload(current, "T-001"));
	assert.equal(replay.result.resultType, "success");
	assert.deepEqual(f.storage.admission.read(identity), record);
});

test("shared repository admission sees another owner without accepting its claims as mutable authority", async t => {
	const f = await publicParallelFixture(t);
	const resource = {
		id: "compiler", kind: /** @type {const} */ ("shared-write"), scope: "/fixture/shared-output",
		mode: /** @type {const} */ ("exclusive"), capacity: 1, units: 1,
	};
	f.host.taskPolicies = plan => Object.fromEntries(plan.tasks.map(task => [task.id, { resources: [resource], team: null, dependencies: [] }]));
	const foreign = createParallelStorage({
		workspacePath: f.f.factory.repository.commonDirectory, directoryParts: ["foundry", "parallel"],
		repositoryId: f.f.factory.repository.id, owner: path.join(f.f.root, "other-owner"),
	});
	const identity = {
		repositoryId: f.f.factory.repository.id, owner: path.join(f.f.root, "other-owner"),
		planId: "competing-plan", taskId: "T-001", reservationId: "other-reservation",
	};
	const claimed = foreign.admission.claim({ identity, expectedRevision: 0, resources: [resource], team: null });
	assert.equal(f.storage.admission.databasePath, foreign.admission.databasePath);
	const status = await f.operations().getStatus({ planId: f.plan.id });
	assert.deepEqual(status.projection.scheduling.dispatchableTaskIds, []);
	assert.ok(status.projection.scheduling.holds.some(hold => hold.reasons.some(reason => reason.kind === "resource")));
	const dispatch = await f.invoke("foundry_dispatch_ready", { planId: f.plan.id, limit: 2 });
	assert.deepEqual(dispatch.value.results, []);
	assert.equal(f.children.size, 0);
	assert.deepEqual(foreign.admission.read(identity), claimed);
});

test("waiting tools forward host cancellation signals outside model arguments", async () => {
	const controller = new AbortController();
	const tools = buildFoundryTools(operationsStub(async (_name, _input, options) => {
		assert.equal(options?.signal, controller.signal);
		controller.signal.throwIfAborted();
		return null;
	}));
	for (const name of ["foundry_create_plan", "foundry_complete_verification", "foundry_control_workflow"]) {
		const tool = toolNamed(tools, name);
		const invocation = {
			sessionId: "session", toolCallId: "call", toolName: name, arguments: {}, signal: controller.signal,
		};
		const success = await tool.handler({}, invocation);
		assert.equal(success.resultType, "success");
		assert.equal(tool.parameters.properties.signal, undefined);
	}
	controller.abort();
	const failure = await toolNamed(tools, "foundry_create_plan").handler({}, {
		sessionId: "session", toolCallId: "call", toolName: "foundry_create_plan", arguments: {}, signal: controller.signal,
	});
	assert.equal(failure.resultType, "failure");
	assert.equal(readRecord(readRecord(parseJson(failure.textResultForLlm)).error).code, "foundry_operation_aborted");
});

test("tool handlers return structured success and failure envelopes", async () => {
	const successTools = buildFoundryTools(operationsStub());
	const successArgs = { planId: "sample-plan" };
	const success = await toolNamed(successTools, "foundry_get_status")
		.handler(successArgs, {
			sessionId: "session",
			toolCallId: "call",
			toolName: "foundry_get_status",
			arguments: successArgs,
		});
	assert.equal(success.resultType, "success");
	assert.deepEqual(success.toolTelemetry, { foundry: { outcome: "success" } });
	assert.equal(readRecord(parseJson(success.textResultForLlm)).ok, true);

	const failureTools = buildFoundryTools(operationsStub(async () => {
		/** @type {Error & {code?: string, details?: unknown}} */
		const error = new Error("stale revision");
		error.code = "revision_conflict";
		error.details = { latestRevision: 3 };
		throw error;
	}));
	const failureArgs = { planId: "sample-plan", expectedRevision: 2 };
	const failure = await toolNamed(failureTools, "foundry_submit_plan")
		.handler(failureArgs, {
			sessionId: "session",
			toolCallId: "call",
			toolName: "foundry_submit_plan",
			arguments: failureArgs,
		});
	assert.equal(failure.resultType, "failure");
	assert.deepEqual(failure.toolTelemetry, { foundry: { outcome: "failure" } });
	assert.deepEqual(parseJson(failure.textResultForLlm), {
		ok: false,
		error: {
			code: "revision_conflict",
			message: "stale revision",
			path: null,
			details: { latestRevision: 3 },
		},
	});
});
