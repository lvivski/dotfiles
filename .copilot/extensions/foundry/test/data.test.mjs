import assert from "node:assert/strict";
import test from "node:test";
import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { arrayOf, isList, isRecord, optional, parseJson, property, readBoolean, readJsonValue, readNumber, readString, recordOf } from "../data.mjs";
import { FoundryAnalysisError } from "../errors.mjs";
import { createDraftPlan } from "../plan/lifecycle.mjs";
import { decodeRequest } from "../requests.mjs";

test("JSON readers retain valid values without borrowing mutable input", () => {
	const shared = { result: [1, null, false, "claim"] };
	const input = { first: shared, second: shared };
	const owned = readJsonValue(input);
	assert.deepEqual(owned, input);
	assert.notEqual(owned, input);
	assert.equal(analysisInputDigest(owned), analysisInputDigest(input));
	assert.equal(isRecord(parseJson("[]")), false);
	assert.equal(isList(parseJson("[]")), true);
	assert.equal(isRecord(parseJson("null")), false);
	assert.equal(isRecord(parseJson("{}")), true);
});

test("JSON readers reject non-wire values, sparse arrays, and cyclic context", () => {
	const invalid = [
		undefined, () => { }, Symbol("not-json"), 1n, NaN, Infinity,
		new Date(), new Map(), { missing: undefined }, [undefined], new Array(1),
	];
	for (const value of invalid) assert.throws(() => readJsonValue(value), TypeError);
	/** @type {unknown[]} */
	const cyclicArray = [];
	cyclicArray.push(cyclicArray);
	/** @type {Record<string, unknown>} */
	const cyclicObject = {};
	cyclicObject.self = cyclicObject;
	assert.throws(() => readJsonValue(cyclicArray), TypeError);
	assert.throws(() => readJsonValue(cyclicObject), TypeError);
});

test("canonical hashing rejects circular arrays explicitly without changing valid JSON digests", () => {
	/** @type {unknown[]} */
	const cyclic = [];
	cyclic.push(cyclic);
	assert.throws(() => analysisInputDigest(cyclic), (error) => {
		assert.ok(error instanceof FoundryAnalysisError);
		assert.equal(error.constructor, FoundryAnalysisError);
		assert.equal(error.name, "FoundryAnalysisError");
		assert.equal(error.code, "invalid_analysis_input");
		assert.equal(error.message, "Cannot digest a circular value");
		assert.equal(error.details, null);
		return true;
	});
	assert.throws(() => stableStringify(() => { }), { name: "FoundryAnalysisError", code: "invalid_analysis_input" });
	assert.equal(stableStringify(undefined), "null");
	assert.equal(stableStringify({ z: [2, { b: 1, a: 0 }], a: false }), '{"a":false,"z":[2,{"a":0,"b":1}]}');
});

test("mapped record decoders check every exposed leaf and preserve optional absence", () => {
	const decode = recordOf({ name: readString, active: readBoolean, count: optional(readNumber), tags: arrayOf(readString) });
	assert.deepEqual(decode({ name: "test", active: false, tags: [] }), { name: "test", active: false, count: undefined, tags: [] });
	assert.throws(() => decode({ name: "test", active: "false", tags: [] }), TypeError);
	assert.throws(() => decode({ name: "test", active: false, count: "1", tags: [] }), TypeError);
	assert.throws(() => decode({ name: "test", active: false, tags: [1] }), TypeError);
});

test("operation decoders keep semantically unvalidated evidence unknown", () => {
	const evidence = { malformed: true };
	const input = decodeRequest("completeTask", {
		planId: "typed-plan", taskId: "T-001", attemptId: "T-001-A001", expectedRevision: 1, status: "done", evidence,
	});
	assert.equal(input.evidence, evidence);
	assert.throws(() => decodeRequest("importPlan", { expectedRevision: 1, source: "{}" }), { code: "invalid_expected_revision" });
	assert.throws(() => decodeRequest("getWorkflow", { planId: "typed-plan", runId: null }), { code: "workflow_run_invalid" });
});

test("operation decoders preserve unknown keys for downstream closed-object validation", () => {
	const input = decodeRequest("createPlan", {
		id: "typed-plan", expectedRevision: 0, runId: "native-run", unexpected: true,
		repository: { workingDirectory: "/tmp/typed-plan", baseBranch: "main", unexpected: true },
	});
	assert.equal(property(input, "unexpected"), true);
	assert.equal(property(input.repository, "unexpected"), true);
	assert.equal(property(decodeRequest("factoryInspect", { unexpected: true }), "unexpected"), true);
	assert.throws(() => createDraftPlan({
		id: input.id, title: "Typed plan", objective: "Check closed repository fields",
		repository: input.repository,
		tasks: [
			{ id: "T-001", title: "Build", kind: "implement", description: "Build", dependsOn: [], acceptanceCriteria: ["Works"], expectedFiles: [], deliveryRequirement: "commit" },
			{ id: "T-002", title: "Verify", kind: "verify", description: "Verify", dependsOn: ["T-001"], acceptanceCriteria: [], expectedFiles: [], deliveryRequirement: "commit" },
		],
	}), { code: "unknown_field", path: "repository.unexpected" });
});
