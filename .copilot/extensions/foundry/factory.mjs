import { contractContext, generationPackage } from "./factory/context.mjs";
import { fail } from "./factory/fields.mjs";
import { createFactoryInspection } from "./factory/projection.mjs";
import { candidateFor, contractFor } from "./factory/records.mjs";
import { FACTORY_FORMAT, applyEvent, replay } from "./factory/replay.mjs";
import { resolveRepositoryIdentity } from "./factory/repository.mjs";
import { createFactoryLedger } from "./factory/storage.mjs";
import { createPortableLedger } from "./factory/portable.mjs";
import { guardFactoryEvidence } from "./evidence/guards.mjs";
import { isRecord } from "./data.mjs";

/**
 * @param {{repositoryPath: string, storageRoot?: string, clock?: () => Date|string|number, busyTimeoutMs?: number,
 * knowledge?: "repository" | "local"}} options
 */
export function createFactoryService(options) {
	const repository = resolveRepositoryIdentity(options.repositoryPath);
	const clock = options.clock ?? (() => new Date());
	const now = () => {
		const value = clock();
		const date = value instanceof Date ? value : new Date(value);
		if (!Number.isFinite(date.getTime())) fail("factory_clock_invalid", "Factory clock is invalid");
		return date.toISOString();
	};
	if (options.knowledge !== undefined && !["repository", "local"].includes(options.knowledge)) fail("factory_input_invalid", "Unknown knowledge persistence mode");
	const local = createFactoryLedger({ repository, format: FACTORY_FORMAT, storageRoot: options.storageRoot, busyTimeoutMs: options.busyTimeoutMs, now, replay, applyEvent, fail });
	const portable = createPortableLedger({ local, repository, repositoryPath: options.repositoryPath });
	const ledger = options.knowledge === "local" ? {
		...local, executionSnapshot: local.snapshot, assertCurrentKnowledge: () => null, migrateFactory: portable.migrateFactory,
	} : portable;
	const { snapshot, exportFactory, importFactory } = ledger;
	/** @template {import("./types/factory.js").FactoryCommand} A
	 * @param {A} action @param {Record<string, unknown>} input */
	const mutate = (action, input) => {
		if (action === "bindPlan" || action === "bindEvaluationPlan") {
			const knowledgeHead = ledger.assertCurrentKnowledge();
			if (knowledgeHead) input = { ...input, knowledgeHead };
		}
		const guarded = ["acceptContract", "recordDelivery", "recordEvaluation"].includes(action)
			|| (action === "decideCandidate" && input.action === "accept")
			|| (action === "appendKnowledge" && isRecord(input.evaluation) && isRecord(input.evaluation.procedure) && input.evaluation.procedure.bundle !== undefined);
		if (!guarded) return ledger.append(action, input);
		const owned = structuredClone(input);
		const state = action === "recordDelivery" || action === "recordEvaluation" ? ledger.executionSnapshot() : snapshot();
		// Validate the receipt's subject/provenance before doing Git reads.
		if (action !== "appendKnowledge") {
			const { expectedRevision, ...receipt } = owned;
			if (expectedRevision !== state.revision) fail("revision_conflict", "Repository factory has changed");
			ledger.preview([{ action, input: receipt }]);
		}
		return ledger.append(action, guardFactoryEvidence(options.repositoryPath, action, owned, state));
	};
	const inspect = createFactoryInspection(ledger, repository, now);
	return Object.freeze({
		repository, databasePath: ledger.databasePath, snapshot, inspect, exportFactory, importFactory,
		executionSnapshot: ledger.executionSnapshot, assertCurrentKnowledge: ledger.assertCurrentKnowledge,
		migrateFactory: ledger.migrateFactory,
		exportFactoryPage: ledger.exportFactoryPage, importFactoryPage: ledger.importFactoryPage,
		abandonFactoryImport: ledger.abandonFactoryImport, storageInfo: ledger.storageInfo,
		createUnit: (/** @type {Record<string, unknown>} */ input) => mutate("createUnit", input),
		appendKnowledge: (/** @type {Record<string, unknown>} */ input) => mutate("appendKnowledge", input),
		acceptContract: (/** @type {Record<string, unknown>} */ input) => mutate("acceptContract", input),
		prepareCandidate: (/** @type {Record<string, unknown>} */ input) => mutate("prepareCandidate", input),
		bindPlan: (/** @type {Record<string, unknown>} */ input) => mutate("bindPlan", input),
		bindEvaluationPlan: (/** @type {Record<string, unknown>} */ input) => mutate("bindEvaluationPlan", input),
		activateEvaluationPlan: (/** @type {Record<string, unknown>} */ input) => mutate("activateEvaluationPlan", input),
		recordDelivery: (/** @type {Record<string, unknown>} */ input) => mutate("recordDelivery", input),
		recordEvaluation: (/** @type {Record<string, unknown>} */ input) => mutate("recordEvaluation", input),
		recordCompletion: (/** @type {Record<string, unknown>} */ input) => mutate("recordCompletion", input),
		recordEvaluationCompletion: (/** @type {Record<string, unknown>} */ input) => mutate("recordEvaluationCompletion", input),
		abandonPlan: (/** @type {Record<string, unknown>} */ input) => mutate("abandonPlan", input),
		decideCandidate: (/** @type {Record<string, unknown>} */ input) => mutate("decideCandidate", input),
		recordSignal: (/** @type {Record<string, unknown>} */ input) => mutate("recordSignal", input),
		ingestAnalysis: (/** @type {Record<string, unknown>} */ input) => mutate("ingestAnalysis", input),
		retire: (/** @type {Record<string, unknown>} */ input) => mutate("retire", input),
		compactFactory: (/** @type {Record<string, unknown>} */ input) => mutate("compactFactory", input),
		preview: ledger.preview,
		contractContext: (/** @type {string} */ unitId, /** @type {number | undefined} */ revision) => {
			const state = ledger.executionSnapshot();
			return { ...contractContext(state, contractFor(state, unitId, revision)), contract: contractFor(state, unitId, revision) };
		},
		generation: (/** @type {string} */ candidateId) => {
			const state = ledger.executionSnapshot();
			return generationPackage(state, candidateFor(state, candidateId));
		},
	});
}
