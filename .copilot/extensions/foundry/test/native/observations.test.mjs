import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPackageInputs } from "../../bridge/package-inputs.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { readRecord } from "../../data.mjs";
import { createOfferedDispatchTransport } from "../../native/admission.mjs";
import { createNativeDispatch, createdChild, dispatchReservation } from "../../native/dispatch.mjs";
import { createNativeHost } from "../../native/host.mjs";
import { bindNativeContext, createNativeAssurance, createNativeInputs, createNativeObservations } from "../../native/observations.mjs";
import { reserveTaskAttempt } from "../../plan/execution.mjs";
import { approved } from "../plan/fixture.mjs";
import { fixture as visualFixture } from "../bridge/fixture.mjs";
import { fixtureRoot, git, seedRepository } from "../git.mjs";
import { must } from "../assertions.mjs";

/** @typedef {import("../../native/observations.mjs").Capture} Capture */
/** @typedef {import("../../native/observations.mjs").Context} Context */
/** @typedef {import("../../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../../types/parallel.js").ConsumerEntry} Entry */
const now = "2026-11-14T06:00:02.000Z", before = "2026-11-14T06:00:00.000Z", ackAt = "2026-11-14T06:00:01.000Z";
/** @param {string | Buffer} bytes */
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture() {
	/** @type {Context} */
	const current = { workspacePath: "/fixture/owner", sessionId: "owner", projectId: "project", repositoryId: "a".repeat(64), inWorkflow: false };
	const plan = approved({ id: "observations" });
	plan.factory = { repositoryId: current.repositoryId, owner: current.workspacePath, unitId: "unit", unitRevision: 1,
		candidateId: null, contractRevision: null, contractDigest: null, contextDigest: null, blueprintDigest: "b".repeat(64) };
	Object.assign(plan, reserveTaskAttempt(plan, "T-001", { reservationId: "observation-reservation", at: before }));
	const attempt = { repositoryId: current.repositoryId, owner: current.workspacePath, planId: plan.id, taskId: "T-001",
		reservationId: "observation-reservation", attemptId: "T-001-A001" };
	const child = { sessionId: "child", projectId: current.projectId, creatorSessionId: current.sessionId, branch: "isolated", worktreePath: "/fixture/child" };
	const reservation = dispatchReservation({ attempt, projectId: current.projectId, baseBranch: "base", baseCommit: "c".repeat(40),
		initialization: { acknowledgement: `Foundry setup ready: ${plan.id}/T-001/T-001-A001`, kickoff: { mode: "interactive", prompt: "Setup only" } },
		delegationPrompt: "Unchanged complete task", inputs: null, requiredInputs: [] });
	const check = bindNativeContext(() => current);
	/** @param {unknown} input @param {unknown} value @param {Partial<Capture>} [changes] @returns {Capture} */
	const capture = (input, value, changes = {}) => ({ context: structuredClone(current), subjectDigest: analysisInputDigest(input),
		capturedAt: now, source: "recording host observation, not live App evidence", complete: true, value, ...changes });
	/** @param {import("../../native/observations.mjs").ObservationReaders} readers */
	const observations = readers => createNativeObservations({ check, readPlan: () => plan, readers, clock: () => now });
	/** @type {Receipt} */
	const receipt = { id: "creation", attempt, kind: "creation", epoch: 0, payloadDigest: sha("exact payload"), state: "uncertain",
		sessionId: null, runId: null, source: "recording native call", at: before };
	return { current, plan, attempt, child, reservation, check, capture, observations, receipt };
}

test("fresh sourced setup and canonical child observations flow through production dispatch corroboration", async () => {
	const f = fixture();
	/** @type {string[]} */
	const calls = [];
	const ports = f.observations({
		setup: async input => {
			calls.push("setup-turn");
			return f.capture(input, { sessionId: f.child.sessionId, message: f.reservation.initialization.acknowledgement, at: ackAt, source: "actual fixture transcript turn" });
		},
		child: async input => {
			calls.push("canonical-observation");
			assert.deepEqual(calls, ["setup-turn", "get_session", "list_sessions_and_chats", "canonical-observation"]);
			return f.capture(input, { child: f.child, aliases: [f.child.sessionId], baseBranch: f.reservation.baseBranch,
				baseCommit: f.reservation.baseCommit, head: f.reservation.baseCommit, clean: true, coordinatingCreatorSessionId: f.current.sessionId });
		},
	});
	const transport = createOfferedDispatchTransport({ owner: f.current.workspacePath, sessionId: f.current.sessionId,
		context: () => ({ owner: f.current.workspacePath, sessionId: f.current.sessionId, inWorkflow: false }),
		executor: { async execute(call) { calls.push(call.name); return { resultType: "success", textResultForLlm: "{}" }; } },
		offered: new Set(["get_session", "list_sessions_and_chats"]), availability: () => "supported" });
	const native = createNativeDispatch({ transport, ...ports, decodeCreated: createdChild });
	const result = await native.corroborate(f.child, f.reservation, before);
	assert.deepEqual(result.child, f.child);
	assert.equal(readRecord(result.acknowledgement).source, "actual fixture transcript turn");
	assert.equal(calls.filter(name => /attach|handoff|complete|release|archive/.test(name)).length, 0);
	console.log("observation trace:", JSON.stringify({ calls, result }));
});

test("missing, incomplete, stale, future, foreign and substituted observation captures cannot advance setup", async () => {
	/** @type {Partial<Capture>[]} */
	const changes = [{ complete: false }, { capturedAt: before }, { capturedAt: "2026-11-14T06:00:03.000Z" },
		{ subjectDigest: "f".repeat(64) }, { source: "" }, { context: { ...fixture().current, projectId: "foreign" } }];
	for (const change of changes) {
		const f = fixture(), ports = f.observations({ setup: async input => f.capture(input, {
			sessionId: f.child.sessionId, message: f.reservation.initialization.acknowledgement, at: ackAt, source: "transcript",
		}, change) });
		await assert.rejects(must(ports.observeSetup)(f.child, f.reservation));
	}
	const f = fixture();
	assert.deepEqual(Object.keys(f.observations({})), []);
	for (const change of [{ message: "session.idle" }, { sessionId: "foreign" }, { at: "2026-11-14T06:00:04.000Z" }]) {
		const ports = f.observations({ setup: async input => f.capture(input, { sessionId: f.child.sessionId,
			message: f.reservation.initialization.acknowledgement, at: ackAt, source: "transcript", ...change }) });
		await assert.rejects(must(ports.observeSetup)(f.child, f.reservation), { code: "dispatch_setup_unconfirmed" });
	}
	const drift = f.observations({ setup: async input => {
		const result = f.capture(input, null); f.current.sessionId = "changed"; return result;
	} });
	await assert.rejects(must(drift.observeSetup)(f.child, f.reservation), { code: "dispatch_invocation_owner" });
});

test("child provider rejects ambiguous alias, missing coordinating owner and substituted identity", async () => {
	const f = fixture();
	const input = { child: f.child, detail: { value: {}, raw: {}, source: "detail" }, inventory: { value: {}, raw: {}, source: "inventory" }, after: ackAt };
	for (const change of [{ aliases: ["child", "alias"] }, { coordinatingCreatorSessionId: "foreign" },
		{ child: { ...f.child, worktreePath: "/another/worktree" } }, { clean: undefined }]) {
		const ports = f.observations({ child: async request => f.capture(request, {
			child: f.child, aliases: ["child"], baseBranch: "base", baseCommit: f.reservation.baseCommit,
			head: f.reservation.baseCommit, clean: true, coordinatingCreatorSessionId: "owner", ...change,
		}) });
		await assert.rejects(must(ports.observeChild)(input));
	}
});

test("recovery retains idle and unknown states without inventing terminal, absent or replay evidence", async () => {
	const f = fixture(), { attemptId, ...identity } = f.attempt;
	for (const status of ["idle", "unknown", "running", "archived"]) {
		const ports = f.observations({ recovery: async input => {
			const capture = f.capture(input, null);
			capture.value = { complete: true, capturedAt: capture.capturedAt, source: capture.source,
				sessions: [{ id: "child", status, attempt: f.attempt }], runs: [{ id: "run", status: "running", attempt: f.attempt }] };
			return capture;
		} });
		const inventory = await must(ports.observeRecovery)({ identity, after: before });
		assert.equal(inventory.sessions[0].status, status);
		assert.equal(inventory.runs[0].status, "running");
	}
	for (const change of [{ complete: false }, { runs: undefined },
		{ sessions: [{ id: "child", status: "archived", attempt: { ...f.attempt, attemptId: "T-001-A002" } }] }]) {
		const ports = f.observations({ recovery: async input => {
			const capture = f.capture(input, null);
			capture.value = { complete: true, capturedAt: capture.capturedAt, source: capture.source, sessions: [], runs: [], ...change };
			return capture;
		} });
		await assert.rejects(must(ports.observeRecovery)({ identity, after: before }));
	}
});

test("outcome and reconciliation readers retain exact attempt, effect, payload, session and run correlation", async () => {
	const f = fixture(), { attemptId, ...identity } = f.attempt;
	const receipt = { ...f.receipt, sessionId: "child" }, payload = { exact: ["unchanged", "payload"] };
	const outcome = { ...receipt, state: /** @type {const} */ ("succeeded"), at: now };
	const ports = f.observations({
		outcomes: async input => f.capture(input, [outcome]),
		reconcile: async input => f.capture(input, { receipt: input.receipt, payload: input.payload,
			result: { value: { child: "child" }, raw: "retained original response", source: "original-native-receipt" } }),
	});
	assert.deepEqual(await must(ports.observeOutcomes)({ identity, receipts: [receipt] }), [outcome]);
	assert.equal((await must(ports.reconcile)(receipt, payload))?.source, "original-native-receipt");
	for (const change of [{ sessionId: "other" }, { runId: "invented" }, { payloadDigest: sha("changed") }, { id: "another-effect" },
		{ attempt: { ...f.attempt, attemptId: "T-001-A002" } }, { epoch: 1 }, { at: "2026-11-14T05:59:59.000Z" }, { state: "in-flight" }]) {
		const rejected = f.observations({ outcomes: async input => f.capture(input, [{ ...outcome, ...change }]) });
		await assert.rejects(must(rejected.observeOutcomes)({ identity, receipts: [receipt] }));
	}
	const missing = f.observations({ reconcile: async input => f.capture(input, null) });
	assert.equal(await must(missing.reconcile)(receipt, payload), null);
	const changed = f.observations({ reconcile: async input => f.capture(input, { receipt, payload: { exact: ["truncated"] }, result: {} }) });
	await assert.rejects(must(changed.reconcile)(receipt, payload), { code: "dispatch_observation_mismatch" });
});

/** @param {import("node:test").TestContext} t */
async function inputsFixture(t) {
	const root = await fixtureRoot(t, "nativeinputs"), repo = path.join(root, "repo");
	seedRepository(repo);
	chmodSync(path.join(repo, "implementation.mjs"), 0o755);
	git(repo, "add", "implementation.mjs");
	git(repo, "commit", "--quiet", "-m", "Executable input fixture");
	const base = git(repo, "rev-parse", "HEAD"), consumer = path.join(root, "consumer");
	git(repo, "worktree", "add", "--quiet", "-b", "consumer", consumer, base);
	const repositoryId = "a".repeat(64), owner = path.join(root, "owner"), planId = "native-inputs";
	const context = { workspacePath: owner, sessionId: "coordinator", projectId: "project", repositoryId, inWorkflow: false };
	/** @param {string} taskId */
	const attempt = taskId => ({ repositoryId, owner, planId, taskId, reservationId: `reserved-${taskId}`, attemptId: `${taskId}-A001` });
	/** @type {import("../../types/parallel.js").PackageDecomposition} */
	const decomposition = { format: "foundry-packages-v1", target: "product",
		bindings: { authority: "discovery-only", repositoryId, unit: { id: "unit", revision: 1 }, contract: null, requirements: [], evaluators: [], visualEvaluation: null },
		packages: [
			{ id: "alpha", title: "Input", expectedFiles: ["implementation.mjs"], inputs: [], outputs: [{ id: "module", path: "implementation.mjs" }], requirements: [], evaluators: [] },
			{ id: "beta", title: "Manifest", expectedFiles: ["package.json"], inputs: [], outputs: [{ id: "manifest", path: "package.json" }], requirements: [], evaluators: [] },
			{ id: "product", title: "Consumer", expectedFiles: ["result.json"],
				inputs: [{ producer: "alpha", output: "module", destination: "inputs/module.mjs" },
					{ producer: "beta", output: "manifest", destination: "inputs/package.json" }],
				outputs: [{ id: "result", path: "result.json" }], requirements: [], evaluators: [] },
		] };
	const artifact = { repositoryId, commit: base, path: "implementation.mjs", mode: /** @type {const} */ ("100755"), digest: sha(readFileSync(path.join(repo, "implementation.mjs"))) };
	const delivery = { packageId: "alpha", attempt: attempt("T-001"), commit: base, outputs: [{ id: "module", artifact }] };
	const manifest = { packageId: "beta", attempt: attempt("T-002"), commit: base, outputs: [{ id: "manifest",
		artifact: { repositoryId, commit: base, path: "package.json", mode: /** @type {const} */ ("100644"), digest: sha(readFileSync(path.join(repo, "package.json"))) } }] };
	/** @type {Entry | null} */
	let entry = null;
	let handedOff = false, currentDelivery = true;
	/** @param {import("../../types/parallel.js").ReservedInputs} descriptor */
	const readEntry = descriptor => handedOff && entry?.inputDigest === descriptor.digest ? entry : null;
	const canonical = createPackageInputs({ repositoryPath: repo, repositoryId, owner, planId, decomposition, taskIds: { alpha: "T-001", beta: "T-002", product: "T-003" },
		policy: { protectedPaths: ["evaluators"], comparisonOnlyPaths: [], comparisonOnlyDigests: [], forbiddenWorktreePaths: [] },
		readOwnedDelivery: query => {
			const selected = query.packageId === "alpha" ? delivery : manifest;
			return currentDelivery ? { delivery: selected, worktreePath: repo,
				receipt: { attempt: selected.attempt, sessionId: `producer-${query.packageId}`, commit: base, planRevision: 10, source: "canonical completion fixture", terminalRunIds: [] } } : null;
		},
		readAuthorizedConsumerEntry: readEntry });
	const port = createNativeInputs({ check: bindNativeContext(() => context), inputs: canonical, entry: readEntry });
	const bootstrap = { repositoryId, branch: "main", commit: base }, required = decomposition.packages[2].inputs;
	const descriptor = port.resolve(attempt("T-003"), bootstrap, required);
	const supplied = { attempt: descriptor.consumer, sessionId: "consumer", worktreePath: consumer, attachedRevision: 12, handoffReceiptId: "exact-handoff", inputDigest: descriptor.digest };
	entry = supplied;
	return { port, descriptor, supplied, repo, consumer, required, bootstrap,
		/** @param {boolean} value */ handoff(value) { handedOff = value; },
		/** @param {boolean} value */ delivery(value) { currentDelivery = value; } };
}

test("canonical materializer through native context preserves full Git inputs and rejects pre-handoff, stale, wrong and dirty consumption", async t => {
	const f = await inputsFixture(t);
	await assert.rejects(f.port.materialize(f.descriptor, f.supplied), { code: "parallel_consumer_held" });
	assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
	f.handoff(true);
	await assert.rejects(f.port.materialize(f.descriptor, { ...f.supplied, handoffReceiptId: "changed-handoff" }), { code: "parallel_consumer_held" });
	await assert.rejects(f.port.materialize(f.descriptor, { ...f.supplied, attempt: { ...f.supplied.attempt, reservationId: "wrong" } }));
	f.delivery(false);
	await assert.rejects(f.port.materialize(f.descriptor, f.supplied), { code: "parallel_delivery_unavailable" });
	f.delivery(true);
	assert.throws(() => f.port.resolve(f.descriptor.consumer, f.bootstrap, []), { code: "parallel_input_coverage" });
	writeFileSync(path.join(f.consumer, "implementation.mjs"), "dirty\n");
	await assert.rejects(f.port.materialize(f.descriptor, f.supplied), { code: "parallel_bootstrap_dirty" });
	assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
	writeFileSync(path.join(f.consumer, "implementation.mjs"), readFileSync(path.join(f.repo, "implementation.mjs")));
	const result = await f.port.materialize(f.descriptor, f.supplied);
	assert.deepEqual(result, f.descriptor.inputs.map(input => input.artifact));
	assert.equal(sha(readFileSync(path.join(f.consumer, "inputs/module.mjs"))), result[0].digest);
	assert.equal(sha(readFileSync(path.join(f.consumer, "inputs/package.json"))), result[1].digest);
	assert.equal(statSync(path.join(f.consumer, "inputs/module.mjs")).mode & 0o777, 0o755);
	assert.equal(statSync(path.join(f.consumer, "inputs/package.json")).mode & 0o777, 0o644);
	assert.equal(git(f.consumer, "rev-parse", "HEAD"), f.bootstrap.commit);
	console.log("canonical input consumption:", JSON.stringify({ descriptor: f.descriptor, entry: f.supplied, artifacts: result }));
});

/** @param {import("node:test").TestContext} t */
async function assuranceFixture(t) {
	const f = await visualFixture(t, { visual: true }), plan = await f.implement(await f.generationPlan());
	const producer = must(plan.tasks[0].attempts.at(-1)?.sessionId), attempt = must(plan.tasks[0].attempts.at(-1));
	const context = { workspacePath: must(plan.factory).owner, sessionId: "coordinator", projectId: "project",
		repositoryId: f.factory.repository.id, inWorkflow: false };
	const identity = { repositoryId: context.repositoryId, owner: context.workspacePath, planId: plan.id, taskId: "T-001",
		attemptId: attempt.id, reservationId: attempt.reservationId };
	const definitions = f.factory.generation(f.candidate.id).evaluations;
	const requirements = [{ id: "obligation", revision: 1 }], evaluator = definitions[0];
	/** @type {import("../../types/parallel.js").GoverningBindings} */
	const governing = { authority: "accepted-contract", repositoryId: context.repositoryId, unit: { id: "unit", revision: 2 },
		contract: { revision: 1, digest: f.candidate.contractDigest }, requirements,
		evaluators: [{ id: evaluator.id, revision: evaluator.revision, procedureDigest: evaluator.evaluation.procedure.digest,
			requirements, independent: true, modality: "boundary" }], visualEvaluation: { id: evaluator.id, revision: evaluator.revision } };
	const body = { format: /** @type {const} */ ("foundry-reserved-inputs-v1"), consumer: identity,
		bootstrap: { repositoryId: context.repositoryId, branch: "main", commit: f.commit }, deliveries: [], inputs: [] };
	const delivery = { packageId: "product", attempt: identity, commit: f.commit, outputs: [{ id: "module",
		artifact: { repositoryId: context.repositoryId, commit: f.commit, path: "implementation.mjs",
			mode: /** @type {const} */ ("100644"), digest: sha(readFileSync(path.join(f.repo, "implementation.mjs"))) } }] };
	/** @type {import("../../analysis/assurance.mjs").ReviewObligation[]} */
	const reviews = ["implementation", "architecture", "security", "visual"].map(kind => ({
		kind: /** @type {import("../../analysis/assurance.mjs").ReviewKind} */ (kind), required: kind !== "security",
		reason: "Retain exact synthetic UI applicability", reviewers: kind === "security" ? [] : ["independent-reviewer"],
	}));
	let reviewer = "independent-reviewer", subjectPlanId = plan.id;
	/** @type {{reviews: Partial<Capture>, contributors: Partial<Capture>}} */
	const changes = { reviews: {}, contributors: {} };
	/** @type {string[]} */
	const calls = [];
	/** @param {unknown} request @param {unknown} value @returns {Capture} */
	const capture = (request, value) => ({ context, subjectDigest: analysisInputDigest(request), source: "recording native provenance including runtime helper",
		capturedAt: new Date().toISOString(), complete: true, value });
	const ports = createNativeHost({ current: () => context, route: "primary-app", readPlan: () => plan, taskPolicies: () => ({}),
		primary: { foundry_complete_task: async () => { calls.push("completion"); throw new Error("Assurance must not complete"); } },
		observations: {
		reviews: async input => {
			calls.push("reviews");
			return { ...capture(input, reviews.map(review => ({ ...review, reviewers: review.required ? [reviewer] : [] }))), ...changes.reviews };
		},
		contributors: async input => {
			calls.push("contributors");
			return { ...capture(input, { commit: f.commit, authors: [producer, "runtime-helper"] }), ...changes.contributors };
		},
	} });
	const request = { plan, taskId: "T-001" };
	const assuranceOptions = { check: bindNativeContext(() => context), observations: ports,
		readSubject: () => ({ plan, taskId: "T-001", repository: f.repo, input: { governing,
			decomposition: { format: "foundry-packages-v1", bindings: governing, target: "product",
				packages: [{ id: "product", title: "Synthetic UI", expectedFiles: ["implementation.mjs"], inputs: [], outputs: [{ id: "module", path: "implementation.mjs" }],
					requirements, evaluators: [{ id: evaluator.id, revision: evaluator.revision }] }] },
			packageId: "product", inputs: (() => {
				const value = { ...body, consumer: { ...body.consumer, planId: subjectPlanId } };
				return { ...value, digest: analysisInputDigest(value) };
			})(), delivery: { ...delivery, attempt: { ...delivery.attempt, planId: subjectPlanId } }, producer,
			definitions } }) };
	const assurance = createNativeAssurance(assuranceOptions);
	const subject = () => assurance.prepare();
	const selected = await subject();
	const report = { format: "foundry-package-assurance-v1", subjectDigest: selected.digest, observedAt: new Date().toISOString(),
		evaluations: [{ evaluation: { id: evaluator.id, revision: evaluator.revision }, procedureDigest: evaluator.evaluation.procedure.digest,
			environment: evaluator.evaluation.environment, workload: evaluator.evaluation.workload, outcome: "passed", report: JSON.stringify(f.visualResult()),
			independenceReason: "Recording independent provider, not a live human claim", reviewer: "independent-reviewer" }],
		reviews: reviews.filter(review => review.required).map(review => ({ kind: review.kind, author: producer, reviewer: "independent-reviewer",
			commit: f.commit, scope: requirements, outcome: "passed", findings: [{ requirement: requirements[0],
				observation: "Synthetic capture and reference remain bound to the exact delivered source and UI criterion",
				evidence: "confined Git/reference/capture fixture; not live perception" }] })) };
	return { ...f, plan, ports, request, subject, selected, report, assurance, assuranceOptions, changes, calls, context,
		/** @param {string} value */ subjectPlan(value) { subjectPlanId = value; },
		/** @param {string} value */ reviewer(value) { reviewer = value; } };
}

test("production UI assurance preserves the valid synthetic comparison and full runtime contributor set", async t => {
	const f = await assuranceFixture(t);
	assert.deepEqual(f.selected.authors.slice(-1), ["runtime-helper"]);
	assert.equal((await f.assurance.assess(f.report)).passed, true);
	assert.equal(f.selected.reviews.find(review => review.kind === "visual")?.required, true);
	assert.equal(f.plan.tasks[1].status, "planned", "Assurance did not complete or release the verifier");
	assert.equal(f.calls.filter(call => call !== "reviews" && call !== "contributors").length, 0);
});

test("UI assurance cannot substitute missing review or contributor providers with successful empty inventories", async t => {
	const f = await assuranceFixture(t), before = f.calls.length;
	for (const missing of ["readReviews", "readContributors"]) {
		const observations = { ...f.ports, [missing]: undefined };
		const assurance = createNativeAssurance({ ...f.assuranceOptions, observations });
		await assert.rejects(assurance.assess(f.report), { code: "dispatch_observation_unavailable" });
	}
	assert.equal(f.calls.length, before, "Missing providers hold before observations or mutation");
});

for (const scenario of ["missing-native", "missing-reference", "failed-comparison", "stale-capture", "wrong-commit", "wrong-reference",
	"wrong-evaluator", "incomplete-contributors", "runtime-self-review", "stale-contributors", "caller-authority", "foreign-contributors",
	"incomplete-reviews", "stale-reviews", "foreign-reviews", "wrong-subject-attempt", "future-capture"]) {
	test(`UI-applicable native assurance holds ${scenario} without completion or release`, async t => {
		const f = await assuranceFixture(t), original = stableStringify(f.plan);
		if (scenario === "incomplete-contributors") f.changes.contributors.complete = false;
		if (scenario === "stale-contributors") f.changes.contributors.capturedAt = before;
		if (scenario === "foreign-contributors") f.changes.contributors.context = { ...f.context, projectId: "foreign" };
		if (scenario === "incomplete-reviews") f.changes.reviews.complete = false;
		if (scenario === "stale-reviews") f.changes.reviews.capturedAt = before;
		if (scenario === "foreign-reviews") f.changes.reviews.context = { ...f.context, projectId: "foreign" };
		if (scenario === "wrong-subject-attempt") f.subjectPlan("substituted-plan");
		if (scenario === "runtime-self-review") f.reviewer("runtime-helper");
		if (scenario === "caller-authority") {
			const foreign = structuredClone(f.request);
			foreign.plan.revision++;
			await assert.rejects(must(f.ports.readReviews)(foreign), { code: "dispatch_context_stale" });
		} else if (["incomplete-contributors", "stale-contributors", "foreign-contributors", "runtime-self-review",
			"incomplete-reviews", "stale-reviews", "foreign-reviews", "wrong-subject-attempt"].includes(scenario)) {
			await assert.rejects(f.subject());
		} else {
			const visual = JSON.parse(f.report.evaluations[0].report);
			if (scenario === "missing-native") { visual.states[0].capture = null; visual.states[0].blocker = "native capture unavailable"; }
			if (scenario === "missing-reference") visual.states[0].referenceDigest = undefined;
			if (scenario === "failed-comparison") visual.states[0].assessment.composition.outcome = "failed";
			if (scenario === "stale-capture") visual.states[0].capture.capturedAt = "2020-01-01T00:00:00.000Z";
			if (scenario === "future-capture") visual.states[0].capture.capturedAt = "2099-01-01T00:00:00.000Z";
			if (scenario === "wrong-commit") visual.deliveryCommit = "f".repeat(40);
			if (scenario === "wrong-reference") visual.states[0].referenceDigest = "f".repeat(64);
			if (scenario === "wrong-evaluator") f.report.evaluations[0].evaluation.revision++;
			f.report.evaluations[0].report = JSON.stringify(visual);
			await assert.rejects(f.assurance.assess(f.report));
		}
		assert.equal(stableStringify(f.plan), original, "No completion or release mutation");
		assert.equal(f.calls.filter(call => call !== "reviews" && call !== "contributors").length, 0, "Zero mutation invocations");
		assert.equal(f.selected.reviews.find(review => review.kind === "visual")?.required, true);
	});
}
