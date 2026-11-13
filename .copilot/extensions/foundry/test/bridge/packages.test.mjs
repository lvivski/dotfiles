import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { createPackageInputs } from "../../bridge/package-inputs.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { requireAncestor } from "../../evidence/git.mjs";
import { fixtureRoot, git, seedRepository } from "../git.mjs";

/** @typedef {import("../../bridge/package-inputs.mjs").OwnedDelivery} OwnedDelivery
 * @typedef {import("../../bridge/package-inputs.mjs").InputPolicy} InputPolicy
 * @typedef {import("../../types/parallel.js").ReservedInputs} ReservedInputs
 * @typedef {import("../../types/parallel.js").ConsumerEntry} ConsumerEntry
 */
const REPOSITORY = "a".repeat(64), owner = "package-owner", planId = "package-fixture";
/** @param {string | Buffer} bytes */
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @param {string} taskId @returns {import("../../types/parallel.js").AttemptIdentity} */
const attempt = (taskId) => ({ repositoryId: REPOSITORY, owner, planId, taskId, reservationId: `reserved-${taskId}`, attemptId: `${taskId}-A001` });
/** @param {string} directory @param {string} message */
function commit(directory, message) {
	git(directory, "add", "--all");
	git(directory, "-c", "user.name=Foundry fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", message);
	return git(directory, "rev-parse", "HEAD");
}

const program = `#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
const descriptor = JSON.parse(readFileSync(process.argv[2], "utf8"));
let result = 0;
const provenance = descriptor.inputs.map(input => {
  const bytes = readFileSync(input.destination);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const mode = statSync(input.destination).mode & 0o111 ? "100755" : "100644";
  assert.equal(digest, input.artifact.digest);
  assert.equal(mode, input.artifact.mode);
  result += JSON.parse(bytes.toString()).value;
  return { ...input.artifact, digest, mode, destination: input.destination };
});
assert.equal(result, 42, "Must calculate from the two actual immutable producer outputs");
writeFileSync("result.json", JSON.stringify({ result, provenance }) + "\\n");
`;

/** @returns {import("../../types/parallel.js").PackageDecomposition} */
function decomposition() {
	const requirements = [{ id: "sum", revision: 1 }], evaluators = [{ id: "sum-check", revision: 1 }];
	return {
		format: "foundry-packages-v1", target: "product",
		bindings: { authority: "accepted-contract", repositoryId: REPOSITORY, unit: { id: "sum-unit", revision: 1 },
			contract: { revision: 1, digest: sha("contract") }, requirements, visualEvaluation: null,
			evaluators: [{ ...evaluators[0], procedureDigest: sha("oracle"), requirements, independent: true, modality: "boundary" }] },
		packages: [
			{ id: "alpha", title: "First input", expectedFiles: ["outputs/alpha.json"], inputs: [],
				outputs: [{ id: "value", path: "outputs/alpha.json" }], requirements: [], evaluators: [] },
			{ id: "beta", title: "Second input", expectedFiles: ["outputs/beta.json"], inputs: [],
				outputs: [{ id: "value", path: "outputs/beta.json" }], requirements: [], evaluators: [] },
			{ id: "product", title: "Calculate", expectedFiles: ["result.json"],
				inputs: [{ producer: "beta", output: "value", destination: "inputs/beta.json" },
					{ producer: "alpha", output: "value", destination: "inputs/alpha.json" }],
				outputs: [{ id: "result", path: "result.json" }], requirements, evaluators },
		],
	};
}

/** @param {import("node:test").TestContext} t */
async function fixture(t) {
	const root = await fixtureRoot(t, "package-inputs");
	const repository = path.join(root, "repository");
	seedRepository(repository);
	writeFileSync(path.join(repository, "consumer.mjs"), program, { mode: 0o755 });
	const bootstrap = { repositoryId: REPOSITORY, branch: "main", commit: commit(repository, "Executable consumer bootstrap") };
	/** @type {Map<string, OwnedDelivery>} */
	const deliveries = new Map();
	for (const [index, packageId] of ["alpha", "beta"].entries()) {
		const worktreePath = path.join(root, packageId);
		git(repository, "worktree", "add", "--quiet", "-b", packageId, worktreePath, bootstrap.commit);
		const output = `outputs/${packageId}.json`, bytes = `${JSON.stringify({ value: index ? 25 : 17 })}\n`;
		mkdirSync(path.join(worktreePath, "outputs"));
		writeFileSync(path.join(worktreePath, output), bytes, { mode: index ? 0o755 : 0o644 });
		const deliveredCommit = commit(worktreePath, `Deliver ${packageId}`), identity = attempt(`T-00${index + 1}`);
		deliveries.set(packageId, {
			receipt: { attempt: identity, sessionId: `native-${packageId}`, commit: deliveredCommit, planRevision: index + 10,
				source: `owner-local:complete-task:${packageId}`, terminalRunIds: [`run-${packageId}`] },
			delivery: { packageId, attempt: identity, commit: deliveredCommit,
				outputs: [{ id: "value", artifact: { repositoryId: REPOSITORY, commit: deliveredCommit, path: output,
					mode: index ? "100755" : "100644", digest: sha(bytes) } }] }, worktreePath,
		});
	}
	const consumer = path.join(root, "consumer");
	git(repository, "worktree", "add", "--quiet", "-b", "consumer", consumer, bootstrap.commit);
	const declaration = decomposition(), taskIds = { alpha: "T-001", beta: "T-002", product: "T-003" };
	/** @type {InputPolicy} */
	const policy = { protectedPaths: ["evaluators", "package.json", "package-lock.json"], comparisonOnlyPaths: ["prior-source"],
		comparisonOnlyDigests: [], forbiddenWorktreePaths: [] };
	/** @type {{setup: boolean, attached: boolean, handedOff: boolean, entry: ConsumerEntry | null}} */
	const gate = { setup: false, attached: false, handedOff: false, entry: null };
	/** @type {import("../../bridge/package-inputs.mjs").PackageInputOptions} */
	const options = { repositoryPath: repository, repositoryId: REPOSITORY, owner, planId, decomposition: declaration, taskIds, policy,
		readOwnedDelivery(query) {
			assert.deepEqual(query, { repositoryId: REPOSITORY, owner, planId, taskId: taskIds[/** @type {"alpha" | "beta"} */ (query.packageId)], packageId: query.packageId });
			return deliveries.get(query.packageId) ?? null;
		},
		readAuthorizedConsumerEntry(descriptor) {
			if (!gate.setup || !gate.attached || !gate.handedOff || gate.entry?.inputDigest !== descriptor.digest) return null;
			return gate.entry;
		},
	};
	const port = createPackageInputs(options);
	const inputs = declaration.packages[2].inputs;
	const resolve = () => port.resolve(attempt("T-003"), bootstrap, inputs);
	/** @param {ReservedInputs} descriptor */
	const entry = (descriptor) => ({ attempt: descriptor.consumer, sessionId: "native-consumer", worktreePath: consumer,
		attachedRevision: 20, handoffReceiptId: "handoff-receipt", inputDigest: descriptor.digest });
	/** @param {ReservedInputs} descriptor */
	const authorize = (descriptor) => {
		gate.setup = gate.attached = gate.handedOff = true;
		gate.entry = entry(descriptor);
		return gate.entry;
	};
	/** @param {string} packageId */
	const delivery = (packageId) => {
		const value = deliveries.get(packageId);
		assert.ok(value);
		return value;
	};
	return { root, repository, bootstrap, consumer, deliveries, declaration, taskIds, policy, gate, options, port, inputs, resolve, entry, authorize, delivery };
}

/** @param {string} directory */
function snapshot(directory) {
	return { head: git(directory, "rev-parse", "HEAD"), status: git(directory, "status", "--porcelain=v1", "--untracked-files=all"),
		outputs: readdirSync(path.join(directory, "outputs")).map((name) => {
			const filename = path.join(directory, "outputs", name);
			return { name, mode: lstatSync(filename).mode, digest: sha(readFileSync(filename)) };
		}) };
}

test("PF-INPUT-01: actual independently committed outputs reach an executable consumer only after authorized handoff", async (t) => {
	const f = await fixture(t);
	const before = snapshot(f.delivery("alpha").worktreePath), second = snapshot(f.delivery("beta").worktreePath);
	const descriptor = f.resolve(), entry = f.entry(descriptor);
	assert.deepEqual(descriptor.deliveries.map((item) => item.packageId), ["alpha", "beta"]);
	assert.deepEqual(descriptor.inputs.map((item) => item.producer), ["alpha", "beta"]);
	assert.notEqual(descriptor.deliveries[0].commit, descriptor.deliveries[1].commit);
	for (const delivery of descriptor.deliveries) {
		assert.equal(git(f.repository, "rev-parse", `${delivery.commit}^`), f.bootstrap.commit);
	}
	assert.deepEqual(f.port.resolve(attempt("T-003"), f.bootstrap, [...f.inputs].reverse()), descriptor);
	for (const stage of ["setup", "attached", "handedOff"]) {
		await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_consumer_held", details: { disposition: "inconclusive" } });
		assert.equal(git(f.consumer, "rev-parse", "HEAD"), f.bootstrap.commit);
		assert.equal(git(f.consumer, "status", "--porcelain"), "");
		assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
		if (stage === "setup") f.gate.setup = true;
		if (stage === "attached") f.gate.attached = true;
	}
	assert.deepEqual(snapshot(f.delivery("alpha").worktreePath), before);
	assert.deepEqual(snapshot(f.delivery("beta").worktreePath), second);
	for (const packageId of ["alpha", "beta"]) {
		const current = f.delivery(packageId);
		writeFileSync(path.join(current.worktreePath, current.delivery.outputs[0].artifact.path), '{"value":999}\n');
		commit(current.worktreePath, "Advance mutable producer tip after successful delivery");
	}
	const producerSnapshots = [...f.deliveries.values()].map((item) => snapshot(item.worktreePath));
	const authorized = f.authorize(descriptor);
	const artifacts = await f.port.materialize(descriptor, authorized);
	assert.deepEqual(artifacts, descriptor.inputs.map((input) => input.artifact));
	assert.equal(git(f.consumer, "rev-parse", "HEAD"), f.bootstrap.commit);
	assert.equal(lstatSync(path.join(f.consumer, "consumer.mjs")).mode & 0o111, 0o111);
	const manifest = path.join(f.root, "reserved-inputs.json");
	writeFileSync(manifest, JSON.stringify(descriptor));
	execFileSync(process.execPath, ["consumer.mjs", manifest], { cwd: f.consumer, encoding: "utf8" });
	const result = JSON.parse(readFileSync(path.join(f.consumer, "result.json"), "utf8"));
	assert.equal(result.result, 42);
	assert.deepEqual(result.provenance, descriptor.inputs.map((input) => ({ ...input.artifact, destination: input.destination })));
	assert.deepEqual([...f.deliveries.values()].map((item) => snapshot(item.worktreePath)), producerSnapshots);
	assert.equal(git(f.repository, "status", "--porcelain"), "");
	assert.equal(git(f.consumer, "rev-parse", "HEAD"), f.bootstrap.commit);
	for (const delivery of descriptor.deliveries) {
		assert.throws(() => requireAncestor(f.repository, delivery.commit, git(f.consumer, "rev-parse", "HEAD")), { code: "factory_integration_mismatch" });
	}
	console.log("PF-INPUT-01 evidence:", JSON.stringify({ bootstrap: descriptor.bootstrap, inputDigest: descriptor.digest, result }));
});

test("immutable declarations, exact scope and complete predecessors cannot be replaced with supplied subsets", async (t) => {
	const f = await fixture(t);
	assert.throws(() => createPackageInputs({ ...f.options, taskIds: { ...f.taskIds, alpha: "T-088" } }),
		{ code: "parallel_package_mapping" });
	const duplicateEvaluator = decomposition();
	duplicateEvaluator.packages[0].requirements = duplicateEvaluator.packages[2].requirements;
	duplicateEvaluator.packages[0].evaluators = duplicateEvaluator.packages[2].evaluators;
	assert.throws(() => createPackageInputs({ ...f.options, decomposition: duplicateEvaluator }),
		{ code: "parallel_evaluator_coverage" });
	const inputs = structuredClone(f.inputs);
	f.declaration.packages[2].inputs.pop();
	f.taskIds.alpha = "T-088";
	assert.throws(() => f.port.resolve(attempt("T-003"), f.bootstrap, f.declaration.packages[2].inputs), { code: "parallel_input_coverage" });
	// The production map is pinned; restore only the fixture reader's current lookup expectation.
	f.taskIds.alpha = "T-001";
	const descriptor = f.port.resolve(attempt("T-003"), f.bootstrap, inputs);
	for (const foreign of [{ owner: "foreign" }, { planId: "foreign-plan" }, { repositoryId: "b".repeat(64) }]) {
		assert.throws(() => f.port.resolve({ ...attempt("T-003"), ...foreign }, f.bootstrap, inputs), { code: "parallel_foreign_owner" });
	}
	assert.throws(() => f.port.resolve(attempt("T-003"), f.bootstrap, [{ ...inputs[0], destination: "../escape" }, inputs[1]]));
	const subset = structuredClone(descriptor);
	subset.inputs.pop(); subset.deliveries.pop();
	const { digest: ignored, ...body } = subset;
	subset.digest = analysisInputDigest(body);
	await assert.rejects(f.port.materialize(subset, f.authorize(subset)), { code: "parallel_input_coverage" });
	await assert.rejects(createPackageInputs({ ...f.options, decomposition: decomposition() }).materialize(descriptor, f.authorize(descriptor)),
		{ code: "parallel_input_unreserved" });
});

test("delivery receipts and every declared output are validated against immutable Git objects", async (t) => {
	const f = await fixture(t);
	const original = structuredClone(f.delivery("alpha"));
	/** @type {((value: OwnedDelivery) => void)[]} */
	const mutations = [
		(value) => { value.delivery.outputs[0].artifact.digest = sha("different bytes"); },
		(value) => { value.delivery.outputs[0].artifact.mode = "100755"; },
		(value) => { value.delivery.outputs[0].artifact.path = "outputs/beta.json"; },
		(value) => { value.delivery.outputs[0].artifact.repositoryId = "b".repeat(64); },
		(value) => { value.delivery.outputs[0].artifact.commit = f.bootstrap.commit; },
		(value) => { value.delivery.outputs.push(structuredClone(value.delivery.outputs[0])); },
		(value) => { value.delivery.attempt = { ...value.delivery.attempt, reservationId: "substituted" }; },
		(value) => { value.delivery.attempt = { ...value.delivery.attempt, attemptId: "T-001-A002" }; },
		(value) => { value.receipt.commit = f.bootstrap.commit; },
		(value) => { value.receipt.attempt = { ...value.receipt.attempt, owner: "foreign-owner" }; },
		(value) => { value.delivery.packageId = "beta"; },
	];
	for (const mutate of mutations) {
		const changed = structuredClone(original);
		mutate(changed); f.deliveries.set("alpha", changed);
		assert.throws(f.resolve);
		assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
	}
	f.deliveries.set("alpha", original);
	f.options.decomposition.packages[0].outputs.push({ id: "missing", path: "outputs/missing.json" });
	f.options.decomposition.packages[0].expectedFiles.push("outputs/missing.json");
	f.inputs.push({ producer: "alpha", output: "missing", destination: "inputs/missing.json" });
	const added = { id: "missing", artifact: { ...original.delivery.outputs[0].artifact, path: "outputs/missing.json" } };
	original.delivery.outputs.push(added);
	const port = createPackageInputs(f.options);
	assert.throws(() => port.resolve(attempt("T-003"), f.bootstrap, f.inputs), { code: "parallel_output_unavailable", details: { disposition: "inconclusive" } });
});

test("missing owner-local delivery, commit and output explicitly hold; imported documents are not authority", async (t) => {
	const f = await fixture(t);
	const original = structuredClone(f.delivery("alpha"));
	f.deliveries.delete("alpha");
	assert.throws(f.resolve, { code: "parallel_delivery_unavailable", details: { disposition: "inconclusive" } });
	const history = { ...original, authority: "history-only" };
	f.deliveries.set("alpha", history);
	assert.throws(f.resolve, { code: "factory_input_invalid" });
	const unavailable = structuredClone(original), missing = "f".repeat(40);
	unavailable.receipt.commit = unavailable.delivery.commit = unavailable.delivery.outputs[0].artifact.commit = missing;
	f.deliveries.set("alpha", unavailable);
	assert.throws(f.resolve, { code: "factory_commit_missing", details: { commit: missing, disposition: "inconclusive" } });
	unavailable.receipt.commit = unavailable.delivery.commit = unavailable.delivery.outputs[0].artifact.commit = f.bootstrap.commit;
	f.deliveries.set("alpha", unavailable);
	assert.throws(f.resolve, { code: "parallel_output_unavailable", details: { disposition: "inconclusive" } });
});

test("materialization re-reads current receipt, attempt, reservation, commit and producer worktree bindings", async (t) => {
	const f = await fixture(t), descriptor = f.resolve(), entry = f.authorize(descriptor);
	const original = structuredClone(f.delivery("alpha"));
	/** @type {((value: OwnedDelivery) => void)[]} */
	const mutations = [
		(value) => { value.receipt.planRevision++; },
		(value) => { value.receipt.source = "different receipt"; },
		(value) => { value.receipt.sessionId = "different producer"; },
		(value) => { value.receipt.terminalRunIds = ["different-run"]; },
		(value) => { value.receipt.attempt.attemptId = value.delivery.attempt.attemptId = "T-001-A002"; },
		(value) => { value.receipt.attempt.reservationId = value.delivery.attempt.reservationId = "different-reservation"; },
		(value) => { value.worktreePath = f.consumer; },
	];
	for (const mutate of mutations) {
		const changed = structuredClone(original);
		mutate(changed); f.deliveries.set("alpha", changed);
		await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_delivery_stale" });
		assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
	}
	f.deliveries.delete("alpha");
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_delivery_unavailable" });
	f.deliveries.set("alpha", original);
	writeFileSync(path.join(original.worktreePath, "outputs/alpha.json"), '{"value":100}\n');
	const newer = commit(original.worktreePath, "New delivered generation");
	const changed = structuredClone(original);
	changed.receipt.commit = changed.delivery.commit = changed.delivery.outputs[0].artifact.commit = newer;
	changed.delivery.outputs[0].artifact.digest = sha('{"value":100}\n');
	f.deliveries.set("alpha", changed);
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_delivery_stale" });
});

test("consumer entry syntax alone cannot authorize setup, a different consumer, dirty bootstrap or a different HEAD", async (t) => {
	const f = await fixture(t), descriptor = f.resolve(), entry = f.authorize(descriptor);
	for (const patch of [{ sessionId: "foreign-child" }, { handoffReceiptId: "other-handoff" }, { attachedRevision: 21 },
		{ attempt: { ...entry.attempt, reservationId: "other-reservation" } }, { inputDigest: "b".repeat(64) }]) {
		await assert.rejects(f.port.materialize(descriptor, { ...entry, ...patch }), { code: "parallel_consumer_mismatch" });
	}
	writeFileSync(path.join(f.consumer, "dirty"), "not setup-only");
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_bootstrap_dirty" });
	commit(f.consumer, "Wrong consumer HEAD");
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_bootstrap_mismatch" });
	assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
});

test("ignored paths, hidden tracked changes and filemode overrides cannot attest a clean bootstrap", async (t) => {
	const f = await fixture(t), descriptor = f.resolve(), entry = f.authorize(descriptor);
	git(f.consumer, "update-index", "--assume-unchanged", "implementation.mjs");
	writeFileSync(path.join(f.consumer, "implementation.mjs"), "hidden modification");
	assert.equal(git(f.consumer, "status", "--porcelain"), "");
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_bootstrap_unverifiable" });
	git(f.consumer, "update-index", "--no-assume-unchanged", "implementation.mjs");
	git(f.consumer, "restore", "--worktree", "implementation.mjs");
	git(f.consumer, "config", "core.filemode", "false");
	chmodSync(path.join(f.consumer, "implementation.mjs"), 0o755);
	assert.equal(git(f.consumer, "status", "--porcelain"), "");
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_bootstrap_dirty" });
	chmodSync(path.join(f.consumer, "implementation.mjs"), 0o644);
	mkdirSync(path.join(f.repository, ".git/info"), { recursive: true });
	writeFileSync(path.join(f.repository, ".git/info/exclude"), "ignored-input\n");
	writeFileSync(path.join(f.consumer, "ignored-input"), "ignored");
	assert.equal(git(f.consumer, "status", "--porcelain"), "");
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_bootstrap_dirty" });
	assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
});

test("source, main, producer, foreign repository and noncanonical consumer worktrees are rejected", async (t) => {
	const f = await fixture(t), descriptor = f.resolve();
	const other = path.join(f.root, "foreign");
	seedRepository(other);
	const alias = path.join(f.root, "consumer-alias");
	symlinkSync(f.consumer, alias, "dir");
	const subdirectory = path.join(f.consumer, "evaluators");
	for (const worktreePath of [f.repository, f.delivery("alpha").worktreePath, other, alias, subdirectory]) {
		const entry = { ...f.authorize(descriptor), worktreePath };
		f.gate.entry = entry;
		await assert.rejects(f.port.materialize(descriptor, entry), { code: "parallel_consumer_worktree" });
	}
	assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
	const policyPort = createPackageInputs({ ...f.options, policy: { ...f.policy, forbiddenWorktreePaths: [f.consumer] } });
	const value = policyPort.resolve(attempt("T-003"), f.bootstrap, f.inputs);
	await assert.rejects(policyPort.materialize(value, f.authorize(value)), { code: "parallel_consumer_worktree" });
});

test("all destinations are preflighted: existing identical files, case aliases, overlaps and symlinks fail without writes", async (t) => {
	const f = await fixture(t);
	/** @type {string[][]} */
	const pairs = [["inputs/alpha.json", "inputs/alpha.json"], ["Inputs/alpha.json", "inputs/beta.json"],
		["inputs", "inputs/alpha.json"], ["inputs/alpha.json", "inputs/ALPHA.json"]];
	for (const destinations of pairs) {
		const declaration = decomposition();
		declaration.packages[2].inputs.forEach((input, index) => { input.destination = destinations[index]; });
		assert.throws(() => createPackageInputs({ ...f.options, decomposition: declaration }));
	}
	for (const destination of ["../outside", "inputs/../../outside", "/absolute", ".git/config", "inputs\\escape"]) {
		const declaration = decomposition();
		declaration.packages[2].inputs[0].destination = destination;
		assert.throws(() => createPackageInputs({ ...f.options, decomposition: declaration }));
	}
	const descriptor = f.resolve(), entry = f.authorize(descriptor);
	mkdirSync(path.join(f.consumer, "inputs"));
	writeFileSync(path.join(f.consumer, "inputs/beta.json"), '{"value":25}\n');
	await assert.rejects(f.port.materialize(descriptor, entry));
	assert.equal(existsSync(path.join(f.consumer, "inputs/alpha.json")), false);
	assert.equal(readFileSync(path.join(f.consumer, "inputs/beta.json"), "utf8"), '{"value":25}\n');
	rmSync(path.join(f.consumer, "inputs"), { recursive: true });
	const outside = path.join(f.root, "outside");
	mkdirSync(outside);
	symlinkSync(outside, path.join(f.consumer, "inputs"), "dir");
	await assert.rejects(f.port.materialize(descriptor, entry));
	assert.deepEqual(readdirSync(outside), []);
	rmSync(path.join(f.consumer, "inputs"));
	mkdirSync(path.join(f.consumer, "Inputs"));
	writeFileSync(path.join(f.consumer, "Inputs/keep"), "keep");
	await assert.rejects(f.port.materialize(descriptor, entry));
	assert.equal(readFileSync(path.join(f.consumer, "Inputs/keep"), "utf8"), "keep");
});

test("tracked destination and tracked symlink ancestors cannot be overwritten even with clean bootstrap status", async (t) => {
	const f = await fixture(t);
	const declaration = decomposition();
	declaration.packages[2].inputs[0].destination = "implementation.mjs";
	const port = createPackageInputs({ ...f.options, decomposition: declaration });
	const descriptor = port.resolve(attempt("T-003"), f.bootstrap, declaration.packages[2].inputs);
	await assert.rejects(port.materialize(descriptor, f.authorize(descriptor)), { code: "parallel_destination_conflict" });
	assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
	symlinkSync("../alpha/outputs", path.join(f.consumer, "inputs"), "dir");
	const bootstrap = { ...f.bootstrap, commit: commit(f.consumer, "Tracked symlink ancestor") };
	const next = f.port.resolve(attempt("T-003"), bootstrap, f.inputs);
	await assert.rejects(f.port.materialize(next, f.authorize(next)), { code: "parallel_destination_escape" });
	assert.equal(readFileSync(path.join(f.delivery("alpha").worktreePath, "outputs/alpha.json"), "utf8"), '{"value":17}\n');
});

test("comparison-only path/digest leakage and evaluator bundle/helper/lock destinations fail closed", async (t) => {
	const f = await fixture(t);
	for (const policy of [
		{ ...f.policy, comparisonOnlyPaths: ["outputs/alpha.json"] },
		{ ...f.policy, comparisonOnlyPaths: ["INPUTS"] },
		{ ...f.policy, comparisonOnlyDigests: [f.delivery("alpha").delivery.outputs[0].artifact.digest] },
	]) {
		const port = createPackageInputs({ ...f.options, policy });
		assert.throws(() => port.resolve(attempt("T-003"), f.bootstrap, f.inputs), { code: "parallel_comparison_leakage" });
	}
	const extra = structuredClone(f.delivery("alpha"));
	const unconsumed = { id: "comparison", artifact: { ...extra.delivery.outputs[0].artifact, path: "implementation.mjs",
		digest: sha(readFileSync(path.join(extra.worktreePath, "implementation.mjs"))) } };
	extra.delivery.outputs.push(unconsumed);
	const extraDeclaration = decomposition();
	extraDeclaration.packages[0].outputs.push({ id: unconsumed.id, path: unconsumed.artifact.path });
	extraDeclaration.packages[0].expectedFiles.push(unconsumed.artifact.path);
	f.deliveries.set("alpha", extra);
	assert.throws(() => createPackageInputs({ ...f.options, decomposition: extraDeclaration,
		policy: { ...f.policy, comparisonOnlyDigests: [unconsumed.artifact.digest] } }), { code: "parallel_output_unused" });
	extra.delivery.outputs.pop();
	for (const destination of ["evaluators/check.mjs", "evaluators/helper.mjs", "EVALUATORS/new.mjs", "package-lock.json", "package.json"]) {
		const declaration = decomposition();
		declaration.packages[2].inputs[0].destination = destination;
		const port = createPackageInputs({ ...f.options, decomposition: declaration });
		assert.throws(() => port.resolve(attempt("T-003"), f.bootstrap, declaration.packages[2].inputs), { code: "parallel_protected_destination" });
	}
	const policy = { ...f.policy, comparisonOnlyDigests: [f.delivery("alpha").delivery.outputs[0].artifact.digest] };
	const port = createPackageInputs({ ...f.options, policy });
	policy.comparisonOnlyDigests.length = 0;
	assert.throws(() => port.resolve(attempt("T-003"), f.bootstrap, f.inputs), { code: "parallel_comparison_leakage" });
	assert.equal(git(f.consumer, "status", "--porcelain"), "");
});

test("later write failure rolls back only this invocation's files and directories without altering HEAD", async (t) => {
	const f = await fixture(t), descriptor = f.resolve(), entry = f.authorize(descriptor);
	mkdirSync(path.join(f.consumer, "inputs"));
	const original = fs.writeFileSync;
	let writes = 0;
	const mock = t.mock.method(fs, "writeFileSync", (/** @type {Parameters<typeof fs.writeFileSync>} */ ...args) => {
		if (typeof args[0] === "number" && ++writes === 2) throw Object.assign(new Error("Fixture full disk"), { code: "ENOSPC" });
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
	await assert.rejects(f.port.materialize(descriptor, entry), { code: "ENOSPC" });
	assert.deepEqual(readdirSync(path.join(f.consumer, "inputs")), []);
	assert.equal(git(f.consumer, "rev-parse", "HEAD"), f.bootstrap.commit);
	assert.equal(git(f.consumer, "status", "--porcelain"), "");
	mock.mock.restore(); syncBuiltinESMExports();
	rmdirSync(path.join(f.consumer, "inputs"));
	let calls = 0;
	const second = t.mock.method(fs, "writeFileSync", (/** @type {Parameters<typeof fs.writeFileSync>} */ ...args) => {
		if (typeof args[0] === "number" && ++calls === 2) throw new Error("Fixture second failure");
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { second.mock.restore(); syncBuiltinESMExports(); });
	await assert.rejects(f.port.materialize(descriptor, entry), /Fixture second failure/);
	assert.equal(existsSync(path.join(f.consumer, "inputs")), false);
});

test("read-only Git ignores ambient repository overrides and replacement objects", async (t) => {
	const f = await fixture(t), alpha = f.delivery("alpha"), originalCommit = alpha.delivery.commit;
	writeFileSync(path.join(alpha.worktreePath, "outputs/alpha.json"), '{"value":999}\n');
	const changedCommit = commit(alpha.worktreePath, "Replacement object is not delivery");
	git(f.repository, "replace", originalCommit, changedCommit);
	const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
	process.env.GIT_DIR = path.join(f.root, "unrelated-git");
	process.env.GIT_WORK_TREE = path.join(f.root, "unrelated-tree");
	process.env.GIT_INDEX_FILE = path.join(f.root, "unrelated-index");
	try {
		const descriptor = f.resolve();
		await f.port.materialize(descriptor, f.authorize(descriptor));
		assert.equal(readFileSync(path.join(f.consumer, "inputs/alpha.json"), "utf8"), '{"value":17}\n');
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
	assert.equal(realpathSync(f.consumer), f.consumer);
});
