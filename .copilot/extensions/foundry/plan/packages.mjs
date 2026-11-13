import { isRecord, parseJson, readBoolean } from "../data.mjs";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { digest as readDigest, fail, list, object, reference, text } from "../factory/fields.mjs";
import { repositoryPath } from "../factory/procedures.mjs";
import { validateDependencyGraph } from "./graph.mjs";
import { createDraftPlan } from "./lifecycle.mjs";
import { assertConservedBindings, governingBindings, packageDecomposition, refKey } from "./parallel-contracts.mjs";
import { LIMITS } from "./values.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {import("../types/parallel.js").GoverningBindings} GoverningBindings */
/** @typedef {import("../types/parallel.js").PackageDecomposition} PackageDecomposition */
/** @typedef {import("../types/parallel.js").WorkPackage} WorkPackage */
/** @typedef {import("../types/plan.js").BlueprintTask} BlueprintTask */
/** @typedef {{id: string, revision: number, criterion: string, human: boolean}} EvaluationCriterion */

const FRAME_START = "\n[foundry-package-v1]\n";
const FRAME_END = "\n[/foundry-package-v1]";

/** @param {string} left @param {string} right */
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
/** @param {KnowledgeRef} left @param {KnowledgeRef} right */
const compareRefs = (left, right) => compare(left.id, right.id) || left.revision - right.revision;
/** @param {number} index */
const taskId = (index) => `T-${String(index + 1).padStart(3, "0")}`;

/** @template {KnowledgeRef} T @param {T[]} refs @returns {T[]} */
function canonicalRefs(refs) {
	if (new Set(refs.map((ref) => ref.id)).size !== refs.length) {
		fail("parallel_binding_mismatch", "One binding cannot select incompatible revisions of the same reference");
	}
	return [...refs].sort(compareRefs);
}

/** Validate without promoting discovery authority; all binding arrays are sets.
 * @param {unknown} value @returns {GoverningBindings} */
export function canonicalBindings(value) {
	const bindings = governingBindings(value);
	return {
		...bindings,
		requirements: canonicalRefs(bindings.requirements),
		evaluators: canonicalRefs(bindings.evaluators).map((entry) => ({
			...entry, requirements: canonicalRefs(entry.requirements),
		})),
	};
}

/** Only literal paths and terminal recursive-directory scopes are supported.
 * @param {string} value */
function scope(value) {
	const descendants = value.endsWith("/**");
	const base = descendants ? value.slice(0, -3) : value.replace(/\/$/, "");
	if (/[{}*?[\]]/.test(base)) fail("parallel_scope_invalid", `Unsupported package scope: ${value}`);
	repositoryPath(base, "package scope");
	return { value: descendants ? `${base}/**` : base, path: base, base: base.toLowerCase().normalize("NFC"), descendants };
}

/** @param {string} value */
function exactPath(value) {
	repositoryPath(value, "package path");
	if (/[{}]/.test(value)) fail("parallel_scope_invalid", `Ambiguous package path: ${value}`);
	return value.toLowerCase().normalize("NFC");
}

/** @param {string} left @param {string} right */
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
/** @param {ReturnType<typeof scope>} declared @param {string} output */
const covers = (declared, output) => (!declared.descendants && declared.path === output) || output.startsWith(`${declared.path}/`);

/** @param {PackageDecomposition} decomposition */
function validateOwnership(decomposition) {
	const owned = decomposition.packages.map((entry) => ({
		entry, scopes: entry.expectedFiles.map(scope), outputs: entry.outputs.map((output) => exactPath(output.path)),
	}));
	for (const { entry, scopes, outputs } of owned) {
		for (const [index, declared] of scopes.entries()) {
			if (scopes.slice(index + 1).some((other) => overlaps(declared.base, other.base))) {
				fail("parallel_scope_overlap", `Package ${entry.id} has aliased or overlapping file scopes`);
			}
			if (!entry.outputs.some((output) => covers(declared, output.path))) {
				fail("parallel_output_scope", `Package ${entry.id} scope ${declared.value} has no declared output`);
			}
		}
		for (const output of entry.outputs.map((entry) => entry.path)) {
			if (!scopes.some((declared) => covers(declared, output))) {
				fail("parallel_output_scope", `Package ${entry.id} output ${output} is outside its owned scope`);
			}
		}
		const destinations = entry.inputs.map((input) => exactPath(input.destination));
		for (const [index, destination] of destinations.entries()) {
			if (destinations.slice(index + 1).some((other) => overlaps(destination, other))
				|| scopes.some((declared) => overlaps(destination, declared.base))) {
				fail("parallel_input_overlap", `Package ${entry.id} input ${destination} aliases an input or writable scope`);
			}
		}
	}
	const outputs = owned.flatMap(({ entry, outputs }) => outputs.map((output) => ({ packageId: entry.id, output })));
	for (const [index, left] of outputs.entries()) {
		const right = outputs.slice(index + 1).find((other) => overlaps(left.output, other.output));
		if (right) fail("parallel_output_overlap", `Outputs ${left.packageId}:${left.output} and ${right.packageId}:${right.output} overlap`);
	}
	for (const [index, left] of owned.entries()) {
		for (const right of owned.slice(index + 1)) {
			if (left.scopes.some((a) => right.scopes.some((b) => overlaps(a.base, b.base)))) {
				fail("parallel_scope_overlap", `Packages ${left.entry.id} and ${right.entry.id} have overlapping writable scopes`);
			}
		}
	}
}

/** @param {PackageDecomposition} decomposition */
function validateMappings({ bindings, packages }) {
	for (const evaluator of bindings.evaluators) {
		const owners = packages.filter((entry) => entry.evaluators.some((ref) => refKey(ref) === refKey(evaluator)));
		if (owners.length !== 1) {
			fail("parallel_evaluator_coverage", `Evaluator ${refKey(evaluator)} must belong to exactly one package, not ${owners.length}`);
		}
		const missing = evaluator.requirements.filter((required) =>
			!owners[0].requirements.some((ref) => refKey(ref) === refKey(required)));
		if (missing.length) {
			fail("parallel_evaluator_requirements", `Package ${owners[0].id} omits obligations of ${refKey(evaluator)}: ${missing.map(refKey).join(", ")}`);
		}
	}
	for (const required of bindings.requirements) {
		if (!packages.some((entry) => entry.requirements.some((ref) => refKey(ref) === refKey(required)))) {
			fail("parallel_requirement_coverage", `No package owns requirement ${refKey(required)}`);
		}
	}
}

/** Pure graph compilation deliberately retains the shared 128-package wire limit,
 * independent of the smaller executable-plan limits.
 * @param {unknown} value @param {GoverningBindings} governing
 * @returns {{decomposition: PackageDecomposition, taskIds: Record<string, string>, dependencies: Record<string, string[]>}} */
export function compilePackageGraph(value, governing) {
	if (isRecord(value) && Array.isArray(value.packages) && value.packages.length === 0) {
		fail("parallel_packages_empty", "An explicit package decomposition cannot be empty");
	}
	const parsed = packageDecomposition(value);
	const bindings = canonicalBindings(parsed.bindings);
	assertConservedBindings(bindings, canonicalBindings(governing));
	/** @type {PackageDecomposition} */
	const decomposition = {
		...parsed, bindings,
		packages: parsed.packages.map((entry) => ({
			...entry,
			expectedFiles: entry.expectedFiles.map((file) => scope(file).value).sort(compare),
			inputs: [...entry.inputs].sort((a, b) => compare(a.producer, b.producer) || compare(a.output, b.output) || compare(a.destination, b.destination)),
			outputs: [...entry.outputs].sort((a, b) => compare(a.id, b.id)),
			requirements: canonicalRefs(entry.requirements), evaluators: canonicalRefs(entry.evaluators),
		})).sort((a, b) => compare(a.id, b.id)),
	};
	validateOwnership(decomposition);
	validateMappings(decomposition);
	const byId = new Map(decomposition.packages.map((entry) => [entry.id, entry]));
	const consumed = new Set();
	const dependencies = Object.fromEntries(decomposition.packages.map((entry) => {
		for (const input of entry.inputs) {
			const producer = byId.get(input.producer);
			if (!producer) fail("parallel_producer_missing", `Package ${entry.id} names missing producer ${input.producer}`);
			if (!producer.outputs.some((output) => output.id === input.output)) {
				fail("parallel_output_missing", `Package ${entry.id} needs missing output ${input.producer}:${input.output}`);
			}
			consumed.add(`${input.producer}:${input.output}`);
		}
		return [entry.id, [...new Set(entry.inputs.map((input) => input.producer))].sort(compare)];
	}));
	validateDependencyGraph(decomposition.packages.map((entry) => ({ id: entry.id, dependsOn: dependencies[entry.id] })));
	const upstream = new Set();
	/** @param {string} id */
	const visit = (id) => {
		if (upstream.has(id)) return;
		upstream.add(id);
		dependencies[id].forEach(visit);
	};
	visit(decomposition.target);
	for (const entry of decomposition.packages) {
		if (!upstream.has(entry.id)) fail("parallel_package_disconnected", `Package ${entry.id} does not contribute to final target ${decomposition.target}`);
		if (entry.id === decomposition.target) continue;
		for (const output of entry.outputs) {
			if (!consumed.has(`${entry.id}:${output.id}`)) fail("parallel_output_unused", `Non-final output ${entry.id}:${output.id} never contributes to the target`);
		}
	}
	return {
		decomposition, dependencies,
		taskIds: Object.fromEntries(decomposition.packages.map((entry, index) => [entry.id, taskId(index)])),
	};
}

/** @param {unknown} value @param {GoverningBindings} bindings @returns {EvaluationCriterion[]} */
function criteriaFor(value, bindings) {
	const criteria = list(value, "evaluation criteria", 128).map((entry) => {
		object(entry, ["id", "revision", "criterion", "human"], "evaluation criterion");
		return { ...reference({ id: entry.id, revision: entry.revision }),
			criterion: text(entry.criterion, "evaluation criterion", LIMITS.acceptanceCriterion), human: readBoolean(entry.human) };
	}).sort(compareRefs);
	if (new Set(criteria.map(refKey)).size !== criteria.length) fail("parallel_evaluation_mismatch", "Evaluation criteria repeat a pinned evaluator");
	for (const criterion of criteria) {
		const evaluator = bindings.evaluators.find((entry) => refKey(entry) === refKey(criterion));
		if (!evaluator || (evaluator.modality === "human" && !criterion.human)) {
			fail("parallel_evaluation_mismatch", `Criterion ${refKey(criterion)} substituted an evaluator or automated human judgment`);
		}
	}
	for (const evaluator of bindings.evaluators) {
		if (!criteria.some((entry) => refKey(entry) === refKey(evaluator))) {
			fail("parallel_evaluation_coverage", `Missing exact criterion for evaluator ${refKey(evaluator)}`);
		}
	}
	const visual = bindings.visualEvaluation;
	if (visual) {
		const evaluator = bindings.evaluators.find((entry) => refKey(entry) === refKey(visual));
		const criterion = criteria.find((entry) => refKey(entry) === refKey(visual));
		// Match visualCriterion without inventing the visual specification absent from these bindings.
		const expected = evaluator && `Pass declared visual fidelity evaluation ${refKey(visual)} (${evaluator.procedureDigest}) using real output captures and independent reference-to-output assessment.`;
		if (!criterion || criterion.human || criterion.criterion !== expected) {
			fail("parallel_visual_required", "The declared visual evaluator must retain its exact automatic final criterion");
		}
	}
	return criteria;
}

/** Policy globs conservatively protect their whole literal prefix. Opaque external
 * comparison refs are not repository paths; they never suppress other path rules.
 * @param {string[] | undefined} values @param {boolean} external */
function policyScopes(values, external) {
	return list(values ?? [], "path policy", 128).flatMap((raw) => {
		const value = text(raw, "path policy", 4096);
		if (external && (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || /\s/.test(value))) return [];
		const wildcard = value.search(/[*?[\]{}]/);
		const prefix = (wildcard < 0 ? value : value.slice(0, wildcard)).replace(/\/+$/, "");
		if (prefix === "." || !prefix) return [{ value, prefix: "", glob: true }];
		try {
			repositoryPath(prefix, "policy path");
		} catch {
			fail("parallel_policy_invalid", `Path policy is not a supported repository scope or external reference: ${value}`);
		}
		return [{ value, prefix: prefix.toLowerCase().normalize("NFC"), glob: wildcard >= 0 }];
	});
}

/** @param {PackageDecomposition} decomposition @param {string[] | undefined} values @param {boolean} comparison */
function enforcePolicy(decomposition, values, comparison) {
	const policies = policyScopes(values, comparison);
	for (const entry of decomposition.packages) {
		const paths = [...entry.expectedFiles.map((file) => scope(file).base),
			...entry.outputs.map((output) => exactPath(output.path)),
			...entry.inputs.map((input) => exactPath(input.destination))];
		for (const policy of policies) {
			if (paths.some((file) => !policy.prefix || overlaps(file, policy.prefix) || (policy.glob && file.startsWith(policy.prefix)))) {
				fail(comparison ? "parallel_comparison_only_path" : "parallel_protected_path",
					`Package ${entry.id} intersects ${comparison ? "comparison-only" : "protected"} path ${policy.value}`);
			}
		}
	}
}

/** @param {BlueprintTask[]} tasks */
function validateExecutable(tasks) {
	// Validation only: fixed metadata avoids clocks, repository access or persistence.
	createDraftPlan({
		id: "package-compiler", title: "Compiled packages", objective: "Validate exact package tasks",
		repository: { workingDirectory: "/foundry-package-validation", baseBranch: "validation" },
		constraints: [], tasks,
	}, { now: "2000-01-01T00:00:00.000Z" });
}

/** @param {unknown} value
 * @param {{governing: GoverningBindings, evaluationCriteria: EvaluationCriterion[], protectedPaths?: string[], comparisonOnlyPaths?: string[]}} options
 * @returns {{decomposition: PackageDecomposition, taskIds: Record<string, string>, dependencies: Record<string, string[]>, tasks: BlueprintTask[], digest: string}} */
export function compilePackages(value, options) {
	const graph = compilePackageGraph(value, options.governing);
	const { decomposition, taskIds, dependencies } = graph;
	const criteria = criteriaFor(options.evaluationCriteria, decomposition.bindings);
	enforcePolicy(decomposition, options.protectedPaths, false);
	enforcePolicy(decomposition, options.comparisonOnlyPaths, true);
	const digest = analysisInputDigest(decomposition);
	const governingDigest = analysisInputDigest(decomposition.bindings);
	/** @type {BlueprintTask[]} */
	const tasks = decomposition.packages.map((entry) => {
		const applicable = entry.id === decomposition.target ? criteria
			: criteria.filter((criterion) => entry.evaluators.some((ref) => refKey(ref) === refKey(criterion)));
		const automatic = applicable.filter((criterion) => !criterion.human).map((criterion) => criterion.criterion);
		const human = applicable.filter((criterion) => criterion.human);
		const manifest = { format: "foundry-package-v1", digest, governingDigest, target: decomposition.target, package: entry };
		return {
			id: taskIds[entry.id], title: entry.title, kind: "implement",
			description: [
				`Implement package ${entry.id}; own only its declared output scopes and consume every exact producer input.`,
				"Integrate delivered predecessor commits; materialized inputs are read-only and do not replace delivery ancestry.",
				`Governing authority: ${decomposition.bindings.authority}. Do not change pinned obligations, procedures, independence or modality.`,
				"Human decisions are separate explicit judgments, never automatic passes.",
				`Human decisions: ${stableStringify(human)}`,
			].join("\n") + FRAME_START + stableStringify(manifest) + FRAME_END,
			dependsOn: dependencies[entry.id].map((id) => taskIds[id]),
			acceptanceCriteria: automatic.length ? automatic : [
				`Deliver every declared output of package ${entry.id} at an immutable commit within its exact owned scope; delivery does not satisfy separate human judgment.`,
			],
			expectedFiles: [...entry.expectedFiles], deliveryRequirement: "commit",
		};
	});
	tasks.push({
		id: taskId(tasks.length), title: "Independently verify the final package", kind: "verify",
		description: `Independently evaluate the exact final commit and every pinned automatic criterion. Preserve the declared visual gate. Record human decisions separately, never as automatic passes. Do not repair outputs or alter governing bindings. Package decomposition digest: ${digest}. Governing bindings digest: ${governingDigest}.`,
		dependsOn: [taskIds[decomposition.target]], acceptanceCriteria: [], expectedFiles: [], deliveryRequirement: "commit",
	});
	validateExecutable(tasks);
	return { ...graph, tasks, digest };
}

/** Recover only with a caller-supplied trusted descriptor digest and governing
 * bindings. Framed prose alone never establishes authority or executable approval.
 * @param {unknown} value @param {{governing: GoverningBindings, digest: string}} options
 * @returns {PackageDecomposition} */
export function readPackageDecomposition(value, options) {
	const expectedDigest = readDigest(options.digest, "trusted package decomposition digest");
	const bindings = canonicalBindings(options.governing);
	const governingDigest = analysisInputDigest(bindings);
	const tasks = list(value, "compiled package tasks", LIMITS.tasks, 2);
	/** @type {unknown[]} */
	const packages = [];
	let target;
	for (const task of tasks) {
		if (!isRecord(task) || !["implement", "verify"].includes(String(task.kind))) {
			fail("parallel_package_task_mismatch", "Recovery requires complete implementation and verifier tasks");
		}
		if (task.kind === "verify") continue;
		const description = text(task.description, "package description", LIMITS.taskDescription);
		const start = description.lastIndexOf(FRAME_START);
		if (start === -1 || !description.endsWith(FRAME_END)) {
			fail("parallel_package_manifest_missing", "Implementation task has no complete canonical package manifest");
		}
		const manifest = parseJson(description.slice(start + FRAME_START.length, -FRAME_END.length));
		object(manifest, ["format", "digest", "governingDigest", "target", "package"], "package manifest");
		if (manifest.format !== "foundry-package-v1" || manifest.digest !== expectedDigest) {
			fail("parallel_package_digest", "Package manifest does not match the caller's trusted decomposition digest");
		}
		if (manifest.governingDigest !== governingDigest) fail("parallel_binding_mismatch", "Package manifest changed governing bindings");
		if (target !== undefined && target !== manifest.target) fail("parallel_package_digest", "Package manifests disagree on final target");
		target = manifest.target;
		packages.push(manifest.package);
	}
	const graph = compilePackageGraph({ format: "foundry-packages-v1", bindings, packages, target }, bindings);
	if (analysisInputDigest(graph.decomposition) !== expectedDigest) fail("parallel_package_digest", "Recovered package declarations changed");
	const expectedIds = [...graph.decomposition.packages.map((entry) => graph.taskIds[entry.id]), taskId(packages.length)];
	if (stableStringify(tasks.map((task) => isRecord(task) ? task.id : null)) !== stableStringify(expectedIds)) {
		fail("parallel_package_task_mismatch", "Compiled task identities or canonical order changed");
	}
	for (const [index, task] of tasks.entries()) {
		if (!isRecord(task)) fail("parallel_package_task_mismatch", "Invalid compiled task");
		const entry = graph.decomposition.packages[index];
		const manifestPackage = packages[index];
		const expectedDependencies = entry ? graph.dependencies[entry.id].map((id) => graph.taskIds[id]) : [graph.taskIds[graph.decomposition.target]];
		if ((entry && (!isRecord(manifestPackage) || manifestPackage.id !== entry.id))
			|| task.kind !== (entry ? "implement" : "verify")
			|| task.deliveryRequirement !== "commit"
			|| stableStringify(task.dependsOn) !== stableStringify(expectedDependencies)
			|| stableStringify(task.expectedFiles) !== stableStringify(entry?.expectedFiles ?? [])
			|| (!entry && stableStringify(task.acceptanceCriteria) !== "[]")) {
			fail("parallel_package_task_mismatch", "Compiled task topology, delivery or output ownership changed");
		}
	}
	return graph.decomposition;
}
