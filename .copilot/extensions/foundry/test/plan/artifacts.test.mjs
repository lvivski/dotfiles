import assert from "node:assert/strict";
import test from "node:test";
import { planArtifactRetention, readArtifactManifest } from "../../plan/artifacts.mjs";

function inventory() {
	return {
		subject: { repositoryId: "repo", ownerId: "owner", sessionId: "child", planId: "plan", taskId: "T-002", attemptId: "T-002-A001" },
		storeId: "private-store",
		commits: [{ commit: "a".repeat(40), sourceRef: "refs/heads/work", durableRef: "refs/foundry/retained/child/source" }],
		artifacts: ["report", "evaluator", "context", "decision", "failure"].map(kind => ({
			id: kind, kind, originalId: `${kind}-original`, producerId: "producer", root: "work", path: `${kind}.json`,
			sha256: "b".repeat(64), bytes: 42,
		})),
	};
}

test("manifest is deterministic, complete, private metadata only, and not a preservation grant", () => {
	const input = inventory(), before = structuredClone(input);
	const planned = planArtifactRetention(input);
	assert.deepEqual(planArtifactRetention({ ...input, artifacts: [...input.artifacts].reverse() }), planned);
	assert.deepEqual(input, before);
	assert.deepEqual(readArtifactManifest(planned), planned);
	assert.deepEqual(planned.subject, input.subject);
	for (const item of planned.artifacts) {
		assert.equal(item.destination, `child/${item.id}-${item.sha256}.bin`);
		assert.equal(item.originalId, `${item.kind}-original`);
		assert.equal(item.producerId, "producer");
	}
	assert.equal("retained" in planned, false);
	assert.throws(() => planArtifactRetention({ ...input, permission: true }));
	assert.throws(() => planArtifactRetention({ ...input, complete: true }));
	assert.throws(() => planArtifactRetention({ ...input, artifacts: input.artifacts.map(item => ({ ...item, content: "private-secret" })) }));
});

test("missing categories, empty or sparse inventories, unknown fields and incomplete identities fail closed", () => {
	for (const kind of ["report", "evaluator", "context", "decision", "failure"]) {
		const input = inventory();
		input.artifacts = input.artifacts.filter(item => item.kind !== kind);
		assert.throws(() => planArtifactRetention(input), /requires original/);
	}
	for (const input of [
		{ ...inventory(), artifacts: [] }, { ...inventory(), commits: [] },
		{ ...inventory(), artifacts: new Array(5) },
		{ ...inventory(), subject: { ...inventory().subject, sessionId: "" } },
		{ ...inventory(), subject: { ...inventory().subject, approved: true } },
	]) assert.throws(() => planArtifactRetention(input));
});

test("conflicting duplicate content, case aliases and duplicate refs never silently drop inventory", () => {
	for (const mutation of [
		(input = inventory()) => { input.artifacts.push({ ...input.artifacts[0], sha256: "c".repeat(64) }); return input; },
		(input = inventory()) => { input.artifacts[1].path = input.artifacts[0].path.toUpperCase(); return input; },
		(input = inventory()) => { input.artifacts[1].id = input.artifacts[0].id.toUpperCase(); return input; },
		(input = inventory()) => { input.commits.push({ ...input.commits[0], commit: "c".repeat(40) }); return input; },
	]) assert.throws(() => planArtifactRetention(mutation()), /Duplicate|duplicate|Conflicting/);
});

test("complete inventories exceed old entry and byte cutoffs without losing identities; malformed byte counts still fail", () => {
	const input = inventory();
	input.artifacts.push(...Array.from({ length: 140 }, (_, index) => ({
		...input.artifacts[0], id: `full-${index}`, originalId: `full-original-${index}`,
		path: `report-${index}.json`, bytes: 17 * 1024 * 1024,
	})));
	input.commits = Array.from({ length: 140 }, (_, index) => ({
		...input.commits[0], durableRef: `refs/foundry/retained/child/source-${index}`,
	}));
	const complete = planArtifactRetention(input);
	assert.equal(complete.artifacts.length, 145);
	assert.deepEqual(complete.artifacts.find(item => item.id === "full-139"), {
		...input.artifacts.at(-1), destination: `child/full-139-${"b".repeat(64)}.bin`,
	});
	assert.equal(complete.commits.length, 140);
	assert.deepEqual(readArtifactManifest(complete), complete);
	for (const bytes of [-1, 0.1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => planArtifactRetention({ ...inventory(), artifacts: inventory().artifacts.map(item => ({ ...item, bytes })) }));
	}
});

test("unqualified refs, foreign destinations and path aliases are rejected", () => {
	for (const filename of ["../report", "/report", "a/../report", "a//report", "a/./report", "a\\report", "C:report", "NUL.json", "report.", "a/%2e%2e/report"]) {
		const input = inventory(); input.artifacts[0].path = filename;
		assert.throws(() => planArtifactRetention(input), /relative paths/, filename);
	}
	for (const sourceRef of ["main", "HEAD", "refs/heads/../bad", "refs/heads/main.lock"]) {
		const input = inventory(); input.commits[0].sourceRef = sourceRef;
		assert.throws(() => planArtifactRetention(input));
	}
	const input = inventory(); input.commits[0].durableRef = "refs/foundry/retained/foreign/source";
	assert.throws(() => planArtifactRetention(input), /exact retained subject/);
	const manifest = planArtifactRetention(inventory()); manifest.artifacts[0].destination = "../escape";
	assert.throws(() => readArtifactManifest(manifest), /cannot override/);
});
