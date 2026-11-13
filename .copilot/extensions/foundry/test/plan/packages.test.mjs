import assert from "node:assert/strict";
import test from "node:test";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { blueprintDigest, evaluationCriterion } from "../../bridge/pinning.mjs";
import { visualCriterion } from "../../factory/visual.mjs";
import { validateTaskTopology, verificationCheckIds } from "../../plan/graph.mjs";
import { canonicalBindings, compilePackageGraph, compilePackages, readPackageDecomposition } from "../../plan/packages.mjs";
import { LIMITS } from "../../plan/values.mjs";

/** @typedef {import("../../types/parallel.js").GoverningBindings} GoverningBindings */
/** @typedef {import("../../types/parallel.js").PackageDecomposition} PackageDecomposition */
/** @typedef {import("../../types/parallel.js").WorkPackage} WorkPackage */
/** @typedef {import("../../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {{id: string, revision: number, criterion: string, human: boolean}} Criterion */

/** @param {string} id @param {number} [revision] */
const ref = (id, revision = 1) => ({ id, revision });
/** @returns {GoverningBindings} */
function bindings() {
	return {
		authority: "accepted-contract", repositoryId: "a".repeat(64), unit: ref("synthetic-unit"),
		contract: { revision: 3, digest: "b".repeat(64) },
		requirements: [ref("behavior"), ref("preservation"), ref("usability")],
		evaluators: [
			{ ...ref("boundary"), procedureDigest: "c".repeat(64), requirements: [ref("behavior"), ref("preservation")], independent: true, modality: "boundary" },
			{ ...ref("human"), procedureDigest: "d".repeat(64), requirements: [ref("usability")], independent: true, modality: "human" },
			{ ...ref("visual"), procedureDigest: "e".repeat(64), requirements: [ref("usability")], independent: true, modality: "operational" },
		],
		visualEvaluation: ref("visual"),
	};
}

/** @param {GoverningBindings} governing @returns {import("../../types/factory.js").ProjectedEvaluation} */
function visualFixture(governing) {
	const visual = governing.visualEvaluation;
	assert.ok(visual);
	const evaluator = governing.evaluators.find((entry) => entry.id === visual.id && entry.revision === visual.revision);
	assert.ok(evaluator);
	return {
		id: evaluator.id, revision: evaluator.revision, unitId: governing.unit.id, kind: "evaluation",
		statement: "Synthetic visual fidelity fixture", uncertainty: null, links: [],
		authority: governing.authority === "accepted-contract" ? "accepted" : "non-governing",
		evaluation: {
			modality: evaluator.modality, independent: evaluator.independent, preservation: true,
			procedure: {
				kind: "command", ref: "evaluators/visual/check.mjs", digest: evaluator.procedureDigest,
				bundle: {
					version: 1, commit: "a".repeat(40), root: "evaluators/visual",
					entryPoint: "evaluators/visual/check.mjs", support: [],
					invocation: { argv: ["node", "evaluators/visual/check.mjs"], cwd: "." },
				},
			},
			obligations: structuredClone(evaluator.requirements),
			environment: "Synthetic browser", workload: "Synthetic final screen", maxAgeSeconds: 3600,
			visual: {
				capture: "Capture the final synthetic screen",
				states: [{
					id: "final", intent: "Compare final composition independently",
					reference: { path: "references/final.png", digest: "f".repeat(64) },
				}],
			},
		},
	};
}

/** @param {GoverningBindings} governing @returns {Criterion[]} */
const criteria = (governing) => governing.evaluators.map((entry) => ({
	id: entry.id, revision: entry.revision, human: entry.modality === "human",
	criterion: governing.visualEvaluation?.id === entry.id && governing.visualEvaluation.revision === entry.revision
		? visualCriterion(visualFixture(governing))
		: entry.modality === "human" ? "An independent person explicitly decides the usability rubric."
			: `Run pinned ${entry.id}@${entry.revision} with procedure ${entry.procedureDigest}.`,
}));

/** @param {string} id @returns {WorkPackage} */
const workPackage = (id) => ({
	id, title: `Implement ${id}`, expectedFiles: [`src/${id}.mjs`], inputs: [],
	outputs: [{ id: "module", path: `src/${id}.mjs` }], requirements: [], evaluators: [],
});

/** @returns {PackageDecomposition} */
function decomposition() {
	const governing = bindings();
	const alpha = workPackage("alpha"), beta = workPackage("beta"), product = workPackage("product");
	product.requirements = structuredClone(governing.requirements);
	product.evaluators = governing.evaluators.map(({ id, revision }) => ({ id, revision }));
	product.inputs = ["alpha", "beta"].map((producer) => ({
		producer, output: "module", destination: `inputs/${producer}.mjs`,
	}));
	return { format: "foundry-packages-v1", bindings: governing, packages: [alpha, beta, product], target: "product" };
}

/** @param {PackageDecomposition} value */
const options = (value) => ({ governing: structuredClone(value.bindings), evaluationCriteria: criteria(value.bindings) });
/** @param {(value: PackageDecomposition) => void} mutate @param {string} code */
function rejects(mutate, code) {
	const value = decomposition();
	mutate(value);
	assert.throws(() => compilePackageGraph(value, bindings()), { code });
}
/** @param {ReturnType<typeof compilePackages>} result */
const blueprintHash = (result) => blueprintDigest({
	title: "Synthetic compiler fixture", objective: "Pure compilation", constraints: [], tasks: result.tasks,
	repository: { workingDirectory: "/synthetic", baseBranch: "main" },
});

test("PF-PKG-01 three disjoint packages compile without collapse, with one final-only verifier", () => {
	const value = decomposition(), original = structuredClone(value);
	const result = compilePackages(value, options(value));
	assert.deepEqual(value, original);
	assert.deepEqual(result.taskIds, { alpha: "T-001", beta: "T-002", product: "T-003" });
	assert.deepEqual(result.dependencies, { alpha: [], beta: [], product: ["alpha", "beta"] });
	assert.equal(result.tasks.length, 4);
	assert.deepEqual(result.tasks.map((entry) => entry.kind), ["implement", "implement", "implement", "verify"]);
	assert.deepEqual(result.tasks.map((entry) => entry.dependsOn), [[], [], ["T-001", "T-002"], ["T-003"]]);
	const { targetTask, verifyTask } = validateTaskTopology(result.tasks);
	assert.equal(targetTask?.id, "T-003");
	assert.equal(targetTask?.deliveryRequirement, "commit");
	assert.deepEqual(verifyTask.expectedFiles, []);
	assert.deepEqual(verifyTask.acceptanceCriteria, []);
	assert.deepEqual(result.tasks.slice(0, 3).map((entry) => entry.expectedFiles), value.packages.map((entry) => entry.expectedFiles));
	assert.ok(result.tasks.slice(0, 2).every((entry) => entry.acceptanceCriteria[0].includes("Deliver every declared output")));
	assert.equal(result.digest, analysisInputDigest(result.decomposition));
	assert.deepEqual(readPackageDecomposition(result.tasks, { governing: value.bindings, digest: result.digest }), result.decomposition);
});

test("PF-PKG-02 equivalent package, binding, reference and declaration orders are identical", () => {
	const value = decomposition();
	value.packages[0].expectedFiles.push("src/alpha-support.mjs");
	value.packages[0].outputs.push({ id: "support", path: "src/alpha-support.mjs" });
	value.packages[2].inputs.push({ producer: "alpha", output: "support", destination: "inputs/alpha-support.mjs" });
	const shuffled = structuredClone(value);
	shuffled.packages.reverse();
	shuffled.bindings.requirements.reverse();
	shuffled.bindings.evaluators.reverse();
	for (const evaluator of shuffled.bindings.evaluators) evaluator.requirements.reverse();
	for (const entry of shuffled.packages) {
		entry.inputs.reverse(); entry.outputs.reverse(); entry.expectedFiles.reverse();
		entry.requirements.reverse(); entry.evaluators.reverse();
	}
	const before = structuredClone(shuffled);
	const a = compilePackages(value, options(value));
	const b = compilePackages(shuffled, { governing: value.bindings, evaluationCriteria: criteria(value.bindings).reverse() });
	assert.deepEqual(a, b);
	assert.equal(blueprintHash(a), blueprintHash(b));
	assert.deepEqual(shuffled, before);
	assert.deepEqual(canonicalBindings(shuffled.bindings), canonicalBindings(value.bindings));
	assert.deepEqual(readPackageDecomposition(b.tasks, { governing: shuffled.bindings, digest: a.digest }), a.decomposition);
});

test("PF-PKG-02 binding digests preserve full authority, procedure, independence, modality and visual identity", () => {
	const value = decomposition(), baseline = compilePackages(value, options(value));
	/** @type {Array<(governing: GoverningBindings) => void>} */
	const changes = [
		(governing) => { governing.contract = { revision: 4, digest: "f".repeat(64) }; },
		(governing) => { governing.evaluators[0].procedureDigest = "f".repeat(64); },
		(governing) => { governing.evaluators[0].independent = false; },
		(governing) => { governing.evaluators[0].modality = "implementation-test"; },
		(governing) => { governing.visualEvaluation = ref("boundary"); },
		(governing) => { governing.repositoryId = "f".repeat(64); },
		(governing) => { governing.unit.revision = 2; },
		(governing) => { governing.authority = "discovery-only"; governing.contract = null; },
	];
	for (const change of changes) {
		const changed = decomposition();
		change(changed.bindings);
		assert.throws(() => compilePackageGraph(changed, value.bindings), { code: "parallel_binding_mismatch" });
		const result = compilePackages(changed, options(changed));
		assert.notEqual(result.digest, baseline.digest);
		assert.notEqual(blueprintHash(result), blueprintHash(baseline));
		assert.deepEqual(result.decomposition.bindings, canonicalBindings(changed.bindings));
	}
	const discovery = decomposition();
	discovery.bindings.authority = "discovery-only";
	discovery.bindings.contract = null;
	assert.throws(() => compilePackageGraph(value, discovery.bindings), { code: "parallel_binding_mismatch" });
	assert.throws(() => canonicalBindings({ ...discovery.bindings, contract: value.bindings.contract }), { code: "parallel_authority_mismatch" });
});

test("PF-PKG-04 malformed, empty, duplicate and incompatible declarations fail specifically", () => {
	for (const value of [undefined, null, [], { ...decomposition(), unknown: true }]) {
		assert.throws(() => compilePackageGraph(value, bindings()), { code: "factory_input_invalid" });
	}
	assert.throws(() => compilePackageGraph({}, bindings()), { code: "parallel_format" });
	rejects((value) => { value.packages = []; }, "parallel_packages_empty");
	rejects((value) => { value.packages[0].id = "Not valid"; }, "factory_input_invalid");
	rejects((value) => { value.packages.push(structuredClone(value.packages[0])); }, "parallel_duplicate");
	rejects((value) => { value.packages[0].outputs.push({ id: "module", path: "src/other.mjs" }); }, "parallel_duplicate");
	rejects((value) => { value.target = "missing"; }, "parallel_target_missing");
	rejects((value) => { value.packages[2].requirements[0].revision = 99; }, "parallel_binding_mismatch");
	rejects((value) => { value.packages[2].evaluators[0].revision = 99; }, "parallel_binding_mismatch");
	rejects((value) => { value.packages[0].outputs[0].path = "../outside"; }, "factory_evaluator_path_invalid");
	for (const invalid of ["../outside", "./src/alpha.mjs", "src\\alpha.mjs", "/src/alpha.mjs", ".git/config", "src/*.mjs", "src/{a,b}.mjs", "."]) {
		const value = decomposition();
		value.packages[0].expectedFiles = [invalid];
		assert.throws(() => compilePackageGraph(value, value.bindings), /scope|repository-relative/);
	}
	const contradictory = bindings();
	contradictory.requirements.push(ref("behavior", 2));
	contradictory.evaluators[0].requirements.push(ref("behavior", 2));
	assert.throws(() => canonicalBindings(contradictory), { code: "parallel_binding_mismatch" });
});

test("PF-PKG-04 graph rejects missing producers and outputs, cycles, disconnected work and dangling outputs", () => {
	rejects((value) => { value.packages[2].inputs[0].producer = "missing"; }, "parallel_producer_missing");
	rejects((value) => { value.packages[2].inputs[0].output = "missing"; }, "parallel_output_missing");
	rejects((value) => { value.packages[0].inputs = [{ producer: "alpha", output: "module", destination: "inputs/self.mjs" }]; }, "self_dependency");
	rejects((value) => { value.packages[0].inputs = [{ producer: "product", output: "module", destination: "inputs/product.mjs" }]; }, "dependency_cycle");
	rejects((value) => { value.packages[2].inputs.pop(); }, "parallel_package_disconnected");
	rejects((value) => {
		value.packages[0].outputs.push({ id: "unused", path: "src/unused.mjs" });
		value.packages[0].expectedFiles.push("src/unused.mjs");
	}, "parallel_output_unused");
});

test("PF-PKG-04 ownership rejects case aliases, ancestor outputs, ambiguous scopes and input overwrites", () => {
	rejects((value) => {
		value.packages[1].outputs[0].path = "SRC/ALPHA.MJS";
		value.packages[1].expectedFiles = ["SRC/ALPHA.MJS"];
	}, "parallel_output_overlap");
	rejects((value) => {
		value.packages[1].outputs[0].path = "src/alpha.mjs/nested";
		value.packages[1].expectedFiles = ["src/alpha.mjs/nested"];
	}, "parallel_output_overlap");
	rejects((value) => {
		value.packages[0].expectedFiles = ["src"];
	}, "parallel_scope_overlap");
	rejects((value) => { value.packages[0].expectedFiles = ["other.mjs"]; }, "parallel_output_scope");
	rejects((value) => { value.packages[0].expectedFiles = ["SRC/ALPHA.MJS"]; }, "parallel_output_scope");
	rejects((value) => { value.packages[0].expectedFiles.push("src/unowned.mjs"); }, "parallel_output_scope");
	rejects((value) => { value.packages[0].expectedFiles.push("SRC/ALPHA.MJS"); }, "parallel_scope_overlap");
	rejects((value) => { value.packages[2].inputs[1].destination = "INPUTS/ALPHA.MJS"; }, "parallel_input_overlap");
	rejects((value) => { value.packages[2].inputs[0].destination = "SRC/PRODUCT.MJS"; }, "parallel_input_overlap");
	rejects((value) => { value.packages[2].inputs[1].destination = "inputs/alpha.mjs/nested"; }, "parallel_input_overlap");
	const directories = decomposition();
	for (const entry of directories.packages) {
		entry.expectedFiles = [`modules/${entry.id}/**`];
		entry.outputs[0].path = `modules/${entry.id}/index.mjs`;
	}
	assert.equal(compilePackageGraph(directories, directories.bindings).decomposition.packages.length, 3);
	directories.packages[0].expectedFiles = ["modules/**"];
	assert.throws(() => compilePackageGraph(directories, directories.bindings), { code: "parallel_scope_overlap" });
});

test("PF-PKG-05 mappings conserve every complete evaluator and obligation, not just aggregate coverage", () => {
	rejects((value) => { value.packages[2].evaluators.pop(); }, "parallel_evaluator_coverage");
	rejects((value) => {
		value.packages[0].evaluators = [ref("boundary")];
		value.packages[0].requirements = [ref("behavior"), ref("preservation")];
	}, "parallel_evaluator_coverage");
	rejects((value) => {
		value.packages[2].requirements = [ref("behavior"), ref("usability")];
		value.packages[1].requirements = [ref("preservation")];
	}, "parallel_evaluator_requirements");
	const distributed = decomposition();
	distributed.packages[0].evaluators = [ref("boundary")];
	distributed.packages[0].requirements = [ref("preservation"), ref("behavior")];
	distributed.packages[2].evaluators = [ref("human"), ref("visual")];
	distributed.packages[2].requirements = [ref("usability")];
	const result = compilePackages(distributed, options(distributed));
	assert.deepEqual(result.tasks[0].acceptanceCriteria, [criteria(distributed.bindings)[0].criterion]);
	assert.deepEqual(result.tasks[2].acceptanceCriteria, criteria(distributed.bindings).filter((entry) => !entry.human).map((entry) => entry.criterion));
	assert.equal(verificationCheckIds(result.tasks).length, 6);
});

test("PF-PKG-05 exact criteria are complete, human judgment remains separate and visual is final", () => {
	const value = decomposition(), supplied = options(value), result = compilePackages(value, supplied);
	const human = supplied.evaluationCriteria.find((entry) => entry.human);
	const visual = supplied.evaluationCriteria.find((entry) => entry.id === "visual");
	assert.ok(human && visual);
	assert.ok(result.tasks[2].description.includes(human.criterion));
	assert.ok(result.tasks.every((entry) => !entry.acceptanceCriteria.includes(human.criterion)));
	assert.ok(result.tasks[2].acceptanceCriteria.includes(visual.criterion));
	for (const missing of ["human", "visual", "boundary"]) {
		assert.throws(() => compilePackages(value, { ...supplied, evaluationCriteria: supplied.evaluationCriteria.filter((entry) => entry.id !== missing) }), { code: "parallel_evaluation_coverage" });
	}
	assert.throws(() => compilePackages(value, { ...supplied, evaluationCriteria: [] }), { code: "parallel_evaluation_coverage" });
	assert.throws(() => compilePackages(value, { ...supplied, evaluationCriteria: [...supplied.evaluationCriteria, supplied.evaluationCriteria[0]] }), { code: "parallel_evaluation_mismatch" });
	assert.throws(() => compilePackages(value, { ...supplied, evaluationCriteria: supplied.evaluationCriteria.map((entry) => ({ ...entry, revision: 2 })) }), { code: "parallel_evaluation_mismatch" });
	assert.throws(() => compilePackages(value, { ...supplied, evaluationCriteria: supplied.evaluationCriteria.map((entry) => ({ ...entry, human: false })) }), { code: "parallel_evaluation_mismatch" });
	assert.throws(() => compilePackages(value, { ...supplied, evaluationCriteria: supplied.evaluationCriteria.map((entry) => ({ ...entry, human: true })) }), { code: "parallel_visual_required" });
	const judgment = supplied.evaluationCriteria.map((entry) => ({ ...entry, human: entry.id !== "visual" }));
	const humanProcedure = compilePackages(value, { ...supplied, evaluationCriteria: judgment });
	assert.deepEqual(humanProcedure.tasks[2].acceptanceCriteria, [visual.criterion], "A non-human modality may have a judgment procedure");
	assert.ok(humanProcedure.tasks[2].description.includes(judgment[0].criterion));
});

test("PF-PKG-05 human-only packages deliver artifacts without fabricating automatic judgment", () => {
	const value = decomposition();
	value.bindings.requirements = [ref("usability")];
	value.bindings.evaluators = [value.bindings.evaluators[1]];
	value.bindings.visualEvaluation = null;
	value.packages[2].requirements = [ref("usability")];
	value.packages[2].evaluators = [ref("human")];
	const result = compilePackages(value, options(value));
	assert.equal(result.tasks[2].acceptanceCriteria.length, 1);
	assert.match(result.tasks[2].acceptanceCriteria[0], /delivery does not satisfy separate human judgment/);
	assert.match(result.tasks[2].description, /An independent person explicitly decides/);
});

test("PF-PKG-05 final visual criterion equals the existing sealed visual and generation formatters", () => {
	const value = decomposition();
	const fixture = visualFixture(value.bindings);
	const expected = visualCriterion(fixture);
	assert.equal(evaluationCriterion(fixture), expected);
	const result = compilePackages(value, options(value));
	const { targetTask } = validateTaskTopology(result.tasks);
	assert.ok(targetTask);
	assert.ok(targetTask.acceptanceCriteria.includes(expected));
});

/** @type {{name: string, substitute: (criterion: string) => string}[]} */
const visualSubstitutions = [
	{ name: "geometry-only", substitute: () => "Pass geometry" },
	{ name: "control-only", substitute: () => "Pass control presence and click targets" },
	{ name: "another procedure digest", substitute: (criterion) => criterion.replace("e".repeat(64), "a".repeat(64)) },
	{ name: "another evaluator revision", substitute: (criterion) => criterion.replace("visual@1", "visual@2") },
];
for (const { name, substitute } of visualSubstitutions) {
	test(`PF-PKG-05 rejects ${name} substitution for the declared visual criterion`, () => {
		const value = decomposition(), supplied = options(value);
		const visual = supplied.evaluationCriteria.find((entry) => entry.id === "visual");
		assert.ok(visual);
		const changed = substitute(visual.criterion);
		assert.notEqual(changed, visual.criterion);
		visual.criterion = changed;
		assert.throws(() => compilePackages(value, supplied), { code: "parallel_visual_required" });
	});
}

test("PF-PKG-06 protected and comparison-only policy checks scopes, outputs and materialized inputs", () => {
	const value = decomposition(), supplied = options(value);
	for (const blocked of ["src", "SRC/ALPHA.MJS", "src/alpha.mjs/support", "src/**", "src/*.mjs", "inputs/alpha.mjs", "*"]) {
		assert.throws(() => compilePackages(value, { ...supplied, protectedPaths: [blocked] }), { code: "parallel_protected_path" });
		assert.throws(() => compilePackages(value, { ...supplied, comparisonOnlyPaths: [blocked] }), { code: "parallel_comparison_only_path" });
	}
	assert.equal(compilePackages(value, { ...supplied, protectedPaths: ["checks", "reference/assets"], comparisonOnlyPaths: ["prior", "https://example.invalid/prior", "sha256:opaque", "/external/prior", "External issue #123"] }).tasks.length, 4);
	assert.throws(() => compilePackages(value, { ...supplied, comparisonOnlyPaths: ["https://example.invalid/prior", "src/alpha.mjs"] }), { code: "parallel_comparison_only_path" });
	assert.throws(() => compilePackages(value, { ...supplied, protectedPaths: ["../src"] }), { code: "parallel_policy_invalid" });
	const directory = decomposition();
	directory.packages[0].outputs[0].path = "modules/alpha/index.mjs";
	directory.packages[0].expectedFiles = ["modules/alpha/**"];
	assert.throws(() => compilePackages(directory, { ...options(directory), protectedPaths: ["modules/alpha/protected/ref.png"] }), { code: "parallel_protected_path" });
});

test("PF-PKG-02 restart recovery requires trusted digest, conserved bindings and exact task ownership", () => {
	const value = decomposition(), result = compilePackages(value, options(value));
	const supplied = { governing: value.bindings, digest: result.digest };
	assert.throws(() => readPackageDecomposition(result.tasks, { ...supplied, digest: "f".repeat(64) }), { code: "parallel_package_digest" });
	const changedBindings = bindings();
	changedBindings.evaluators[0].procedureDigest = "f".repeat(64);
	assert.throws(() => readPackageDecomposition(result.tasks, { ...supplied, governing: changedBindings }), { code: "parallel_binding_mismatch" });
	const manifestChanged = structuredClone(result.tasks);
	manifestChanged[0].description = manifestChanged[0].description.replace('"title":"Implement alpha"', '"title":"Changed title"');
	assert.throws(() => readPackageDecomposition(manifestChanged, supplied), { code: "parallel_package_digest" });
	/** @type {Array<(tasks: typeof result.tasks) => void>} */
	const mutations = [
		(tasks) => { tasks[0].expectedFiles = ["src"]; },
		(tasks) => { tasks[2].dependsOn = ["T-001"]; },
		(tasks) => { tasks[0].id = "T-010"; },
		(tasks) => { tasks[3].acceptanceCriteria = ["Forged verification"]; },
		(tasks) => { tasks[3].dependsOn = ["T-001", "T-003"]; },
		(tasks) => { [tasks[0].description, tasks[1].description] = [tasks[1].description, tasks[0].description]; },
		(tasks) => { tasks.reverse(); },
	];
	for (const mutate of mutations) {
		const tasks = structuredClone(result.tasks);
		mutate(tasks);
		assert.throws(() => readPackageDecomposition(tasks, supplied), { code: "parallel_package_task_mismatch" });
	}
	const missing = structuredClone(result.tasks);
	missing[0].description = "Digest-only prose cannot restore inputs";
	assert.throws(() => readPackageDecomposition(missing, supplied), { code: "parallel_package_manifest_missing" });
});

/** @param {number} count @returns {PackageDecomposition} */
function workload(count) {
	const governing = bindings();
	governing.requirements = [ref("behavior")];
	governing.evaluators = [{ ...governing.evaluators[0], requirements: [ref("behavior")] }];
	governing.visualEvaluation = null;
	const packages = Array.from({ length: count }, (_unused, index) => workPackage(`package-${String(index).padStart(3, "0")}`));
	const target = packages[0];
	// A wide final fan-in exercises real distinct producer references, not fake dependency arrays.
	target.inputs = packages.slice(1).map((entry) => ({ producer: entry.id, output: "module", destination: `inputs/${entry.id}.mjs` }));
	target.requirements = governing.requirements;
	target.evaluators = [ref("boundary")];
	return { format: "foundry-packages-v1", bindings: governing, packages, target: target.id };
}

test("PF-PKG-01 deterministic 32/128 package pure workloads retain every edge and stable task ID", () => {
	for (const count of [32, 128]) {
		const value = workload(count), first = compilePackageGraph(value, value.bindings);
		const shuffled = structuredClone(value);
		shuffled.packages.reverse();
		shuffled.packages.forEach((entry) => entry.inputs.reverse());
		const second = compilePackageGraph(shuffled, value.bindings);
		assert.deepEqual(first, second);
		assert.equal(first.decomposition.packages.length, count);
		assert.equal(first.dependencies[value.target].length, count - 1);
		assert.equal(first.taskIds[`package-${String(count - 1).padStart(3, "0")}`], `T-${String(count).padStart(3, "0")}`);
	}
	const value = workload(32);
	assert.equal(compilePackages(value, options(value)).tasks.length, 33);
});

test("PF-PKG-06 executable limits reject instead of collapsing or truncating packages, criteria and manifests", () => {
	const tooManyTasks = workload(128);
	assert.throws(() => compilePackages(tooManyTasks, options(tooManyTasks)), { code: "array_too_long" });
	const evidence = workload(63);
	assert.throws(() => compilePackages(evidence, options(evidence)), { code: "too_many_verification_checks" });
	const maximum = workload(62);
	assert.equal(verificationCheckIds(compilePackages(maximum, options(maximum)).tasks).length, LIMITS.evidence);
	const tooManyCriteria = decomposition();
	tooManyCriteria.bindings.evaluators = Array.from({ length: LIMITS.acceptanceCriteria + 1 }, (_unused, index) => ({
		...tooManyCriteria.bindings.evaluators[0], id: `oracle-${String(index).padStart(3, "0")}`,
		requirements: tooManyCriteria.bindings.requirements,
	}));
	tooManyCriteria.bindings.visualEvaluation = null;
	tooManyCriteria.packages[2].evaluators = tooManyCriteria.bindings.evaluators.map(({ id, revision }) => ({ id, revision }));
	assert.throws(() => compilePackages(tooManyCriteria, options(tooManyCriteria)), { code: "array_too_long" });
	const oversized = decomposition();
	oversized.packages[0].expectedFiles = ["module/**"];
	oversized.packages[0].outputs = Array.from({ length: 60 }, (_unused, index) => ({ id: `output-${index}`, path: `module/${"x".repeat(200)}-${index}.mjs` }));
	oversized.packages[2].inputs = [
		...oversized.packages[0].outputs.map((output, index) => ({ producer: "alpha", output: output.id, destination: `inputs/a-${index}.mjs` })),
		oversized.packages[2].inputs[1],
	];
	assert.throws(() => compilePackages(oversized, options(oversized)), /description/);
	assert.equal(stableStringify(oversized).includes("output-59"), true);
});
