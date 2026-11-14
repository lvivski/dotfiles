import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { createFactoryService } from "../../factory.mjs";
import { evaluatorBundle } from "../../factory/procedures.mjs";
import { VISUAL_AXES, visualReport, visualSpecification } from "../../factory/visual.mjs";
import { factoryDocument } from "./accessors.mjs";
import { fixture, source } from "../bridge/fixture.mjs";

test("acceptance preview uses the same v3 private-context normalization as persistence", async (t) => {
	const f = await fixture(t);
	const previous = f.factory.snapshot().contracts[0];
	assert.ok(previous);
	const rationale = [];
	for (let index = 0; index < 3; index++) {
		const report = String(index).repeat(48000);
		const result = f.factory.ingestAnalysis({
			expectedRevision: f.factory.snapshot().revision, unitId: previous.unitId, report,
			source: {
				...source(), kind: "audit", ref: `fixture:large-report-${index}`,
				runId: `large-report-${index}`, owner: f.root, digest: analysisInputDigest(report),
			},
		});
		const last = result.knowledge.at(-1);
		assert.ok(last);
		rationale.push({ id: last.id, revision: last.revision });
	}
	const accepted = f.factory.acceptContract({
		expectedRevision: f.factory.snapshot().revision, unitId: previous.unitId, unitRevision: previous.unitRevision,
		obligations: previous.obligations, evaluations: previous.evaluations, rationale,
		actor: "owner", reason: "Accept the portable rationale, retaining raw reports locally",
	}).contract;
	assert.equal(accepted.sealVersion, 3);
	const context = stableStringify(f.factory.contractContext(previous.unitId, accepted.revision));
	assert.ok(Buffer.byteLength(context) < 128 * 1024);
	assert.ok(!context.includes("0".repeat(1000)));
	assert.ok(f.factory.snapshot().knowledge.some((entry) => entry.statement.length === 48000));
});

test("acceptance and generation retain large declarations, selected obligations, rationale and long provenance exactly", async t => {
	const f = await fixture(t);
	const root = path.join(f.root, "large-contract");
	await mkdir(root);
	const factory = createFactoryService({ repositoryPath: f.repo, storageRoot: root, knowledge: "local" });
	const original = factoryDocument(f.factory.exportFactory());
	const declarations = Array.from({ length: 40 }, (_, index) => ` \n\t${index} ${"🙂資料 ".repeat(600)}  \n`);
	const name = ` \t${"capability ".repeat(100)}  \n`;
	const origin = { ...source(), ref: ` \t${"source:資料 ".repeat(1000)}  \n`, actor: ` ${"actor ".repeat(100)} ` };
	/** @param {import("../../types/factory.js").FactoryAction} action @param {Record<string, unknown>} input */
	const append = (action, input) => {
		const event = { revision: original.events.length + 1, at: origin.at, action, input };
		original.events.push(event);
		original.revision++;
	};
	append("createUnit", {
		id: "unit", name, purpose: "Preserve full public declarations",
		boundary: { owns: declarations, exposes: declarations, preserves: declarations, consumes: [] },
		dependencies: [], relationshipCoverage: "complete", actor: origin.actor, reason: "Expand the declared public content without dropping a field",
	});

	await t.test("long evaluator declarations retain all support, argv and visual states without relaxing path or capture checks", () => {
		const directory = Array.from({ length: 20 }, (_, index) => `directory-${index}-${"x".repeat(50)}`).join("/");
		const bundle = {
			version: 1, commit: "a".repeat(40), root: directory, entryPoint: `${directory}/entry.mjs`,
			support: Array.from({ length: 40 }, (_, index) => `support/${directory}/support-${index}.mjs`).sort(),
			invocation: { argv: ["node", `${directory}/entry.mjs`, ...Array.from({ length: 70 }, (_, index) => ` \targument-${index}-${"🙂".repeat(3000)}  \n`)], cwd: "." },
		};
		assert.deepEqual(evaluatorBundle(bundle), bundle);
		assert.throws(() => evaluatorBundle({ ...bundle, support: ["../outside.mjs"] }), { code: "factory_evaluator_path_invalid" });
		assert.throws(() => evaluatorBundle({ ...bundle, invocation: { ...bundle.invocation, argv: ["node", "other.mjs"] } }), { code: "factory_evaluator_unsupported" });
		const visual = {
			capture: ` \t${"capture instructions ".repeat(1000)}  \n`,
			states: Array.from({ length: 10 }, (_, index) => ({
				id: `state-${index}`, intent: ` \t${"state intent 🙂資料 ".repeat(1000)}  \n`,
				reference: { path: `${directory}/reference-${index}.png`, digest: "b".repeat(64) },
			})),
		};
		assert.deepEqual(visualSpecification(visual), visual);
		/** @type {import("../../types/factory.js").EvaluationDefinition} */
		const definition = {
			modality: "boundary", procedure: { kind: "reference", ref: "fixture:visual", digest: "a".repeat(64) },
			obligations: [{ id: "obligation", revision: 1 }], environment: "fixture", workload: "visual",
			maxAgeSeconds: 86400, independent: true, preservation: true, visual,
		};
		const finding = ` \t${"independent finding 🙂資料 ".repeat(1000)}  \n`;
		const report = {
			format: "foundry-visual-report-v1", deliveryCommit: bundle.commit, environment: definition.environment,
			states: visual.states.map(state => ({
				id: state.id, referenceDigest: state.reference.digest,
				capture: { path: ` \t${"fixture-capture/".repeat(400)}${state.id}.png  \n`, digest: "c".repeat(64),
					capturedAt: "2026-01-01T00:00:00.000Z", method: "browser-screenshot", viewport: "fixture" },
				assessment: Object.fromEntries(VISUAL_AXES.map(axis => [axis, { outcome: "passed", finding }])),
			})),
		};
		const retained = visualReport(definition, JSON.stringify(report), bundle.commit, "passed");
		assert.equal(retained?.length, 10);
		assert.ok(retained?.every(state => state.assessment.every(entry => entry.finding === finding)));
		assert.throws(() => visualReport(definition, JSON.stringify({ ...report, states: report.states.slice(1) }), bundle.commit, "passed"), { code: "factory_visual_required" });
	});
	/** @type {import("../../types/factory.js").KnowledgeRef[]} */
	const obligations = [];
	for (let index = 0; index < 40; index++) {
		const id = `large-obligation-${index}`;
		append("appendKnowledge", { id, unitId: "unit", kind: "obligation", source: origin, statement: declarations[index].repeat(4) });
		obligations.push({ id, revision: 1 });
	}
	append("appendKnowledge", {
		id: "large-reference-evaluator", unitId: "unit", kind: "evaluation", source: origin,
		statement: "Evaluate every obligation", evaluation: {
			modality: "boundary", procedure: { kind: "reference", ref: origin.ref, digest: "a".repeat(64) },
			obligations, environment: declarations[0], workload: declarations[1],
			maxAgeSeconds: 2 * 365 * 86400, independent: true, preservation: true,
		},
	});
	const rationale = [];
	for (let index = 0; index < 140; index++) {
		const id = `large-rationale-${index}`;
		append("appendKnowledge", { id, unitId: "unit", kind: "inference", source: origin,
			statement: ` \tPublic lesson ${index}  \n`, links: rationale.length ? [{ relation: "derived-from", target: rationale.at(-1) }] : [] });
		rationale.push({ id, revision: 1 });
	}
	factory.importFactory({ expectedRevision: 0, source: JSON.stringify(original) });
	const accepted = factory.acceptContract({
		expectedRevision: factory.snapshot().revision, unitId: "unit", unitRevision: 2, obligations,
		evaluations: [{ id: "large-reference-evaluator", revision: 1 }], rationale: [rationale.at(-1)],
		resolutions: rationale.slice(0, 70).map(knowledge => ({ knowledge, reason: declarations[0] })),
		actor: origin.actor, reason: declarations[2],
	}).contract;
	const prepared = factory.prepareCandidate({
		expectedRevision: factory.snapshot().revision, id: "large-generation", unitId: "unit", contractRevision: accepted.revision,
		actor: origin.actor, context: {
			generation: Array.from({ length: 70 }, (_, index) => ({ kind: "reference", ref: `${origin.ref}${index}`, digest: "b".repeat(64) })),
			comparisonOnly: [], independence: { method: "fresh-process", reason: declarations[3] },
		},
	});
	assert.equal(accepted.obligations.length, 40);
	assert.equal(accepted.rationale.length, 140);
	assert.deepEqual(prepared.generation.unit.boundary.owns, declarations);
	assert.equal(prepared.generation.unit.name, name);
	assert.equal(prepared.generation.inputs.length, 70);
	assert.ok(Buffer.byteLength(stableStringify(prepared.generation)) > 128 * 1024);
	assert.equal(prepared.generation.obligations[0].statement, declarations[0].repeat(4));
	assert.equal(factory.snapshot().knowledge.find(entry => entry.id === obligations[0].id)?.source.ref, origin.ref);
	const restarted = createFactoryService({ repositoryPath: f.repo, storageRoot: root, knowledge: "local" });
	assert.deepEqual(restarted.generation(prepared.candidate.id), prepared.generation);
	assert.equal(restarted.inspect({ candidateId: prepared.candidate.id }).candidates[0].assurance.ready, false);
	assert.throws(() => restarted.decideCandidate({
		expectedRevision: restarted.snapshot().revision, candidateId: prepared.candidate.id,
		action: "accept", expectedIncumbentId: null, actor: "owner", reason: "Large content is not delivery or independent support",
	}), { code: "factory_assurance_incomplete" });
});
