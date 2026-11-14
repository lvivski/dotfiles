import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { errorCode, isOneOf, isRecord } from "../data.mjs";
import { contractContext } from "./context.mjs";
import { digest, enumeration, fail, integer, list, object, text, timestamp } from "./fields.mjs";
import { FACTORY_ACTIONS, FACTORY_FORMAT, applyEvent, replay } from "./replay.mjs";
import { privateKnowledge, privateStatement } from "./records.mjs";
import { createKnowledgeRepository } from "./repository.mjs";

/** @typedef {import("../types/factory.js").FactoryDocument} FactoryDocument */
/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryAction} FactoryAction */
/** @typedef {import("../types/factory.js").RepositoryIdentity} RepositoryIdentity */
/** @typedef {{id: string, digest: string, candidateId: string, unitId: string, action: string,
 * actor: string, reason: string, at: string, commit: string|null, evidence: string[]}} HistoricalSelection */
/** @typedef {{format: "foundry-knowledge-v1", parent: string|null, document: FactoryDocument,
 * selections: HistoricalSelection[], migration: {sourceDigest: string, actor: string, reason: string}|null}} Publication */

const KNOWLEDGE_ACTIONS = /** @type {const} */ (["createUnit", "appendKnowledge", "acceptContract", "recordSignal", "retire", "checkpoint", "recordOperating"]);

/** @param {unknown} value @returns {FactoryDocument} */
export function readKnowledgeDocument(value) {
	object(value, ["format", "repository", "revision", "events", "portable"], "knowledge document");
	object(value.repository, ["id", "commonDirectory"], "repository");
	if (value.format !== FACTORY_FORMAT || value.portable !== true) fail("factory_format_unsupported", "Expected a portable factory knowledge projection");
	const repository = { id: digest(value.repository.id, "repository.id"), commonDirectory: text(value.repository.commonDirectory, "repository.commonDirectory", 4096) };
	const events = list(value.events, "events", 1_000_000).map((entry) => {
		object(entry, ["revision", "at", "action", "input"], "event");
		if (!isRecord(entry.input)) fail("factory_input_invalid", "Knowledge event input must be an object");
		const action = enumeration(entry.action, FACTORY_ACTIONS, "event.action");
		if (!isOneOf(action, KNOWLEDGE_ACTIONS) || (action === "retire" && entry.input.type !== "knowledge")) {
			fail("factory_execution_not_portable", "Repository knowledge cannot restore candidates, native bindings, execution receipts or live selection authority");
		}
		return { revision: integer(entry.revision, "event.revision", 1), at: timestamp(entry.at, "event.at"),
			action, input: entry.input };
	});
	const result = { format: FACTORY_FORMAT, repository, revision: integer(value.revision, "revision"), events, portable: /** @type {const} */ (true) };
	replay(result, repository);
	return result;
}

/** @param {unknown} value @returns {Publication} */
export function readPublication(value) {
	object(value, ["format", "parent", "document", "selections", "migration"], "knowledge publication");
	if (value.format !== "foundry-knowledge-v1") fail("factory_format_unsupported", "Unknown knowledge publication format");
	const selections = list(value.selections, "selections", 100_000).map((entry) => {
		object(entry, ["id", "digest", "candidateId", "unitId", "action", "actor", "reason", "at", "commit", "evidence"], "historical selection");
		return {
			id: text(entry.id, "selection.id", 256), digest: digest(entry.digest, "selection.digest"),
			candidateId: text(entry.candidateId, "candidateId", 96), unitId: text(entry.unitId, "unitId", 96),
			action: enumeration(entry.action, ["accept-candidate", "reject-candidate"], "selection.action"),
			actor: text(entry.actor, "actor", 256), reason: text(entry.reason, "reason", 8000), at: timestamp(entry.at, "selection.at"),
			commit: entry.commit === null ? null : text(entry.commit, "commit", 64),
			evidence: list(entry.evidence, "evidence", 128).map((item) => digest(item, "evidence digest")),
		};
	});
	let migration = null;
	if (value.migration !== null) {
		object(value.migration, ["sourceDigest", "actor", "reason"], "migration");
		migration = { sourceDigest: digest(value.migration.sourceDigest, "migration.sourceDigest"),
			actor: text(value.migration.actor, "actor", 256), reason: text(value.migration.reason, "reason", 8000) };
	}
	return {
		format: "foundry-knowledge-v1", parent: value.parent === null ? null : digest(value.parent, "parent"),
		document: readKnowledgeDocument(value.document), selections, migration,
	};
}

/** @param {Record<string, unknown>} input */
function portableSource(input) {
	if (!isRecord(input.source)) return input;
	const origin = structuredClone(input.source);
	for (const field of ["ref", "owner"]) {
		if (typeof origin[field] === "string" && /^(?:\/|[a-z]:[\\/]|file:|~[\\/])/i.test(origin[field])) {
			origin[field] = `local-source:${analysisInputDigest(origin[field])}`;
		}
	}
	return { ...input, source: origin };
}

/** @param {import("../types/factory.js").Knowledge} entry */
function knowledgeInput(entry) {
	const { revision, recordedAt, ...input } = entry;
	return {
		...portableSource(input),
		sourceCommitment: entry.sourceCommitment ?? analysisInputDigest(entry.source),
		statementCommitment: entry.statementCommitment ?? analysisInputDigest(entry.statement),
		statement: privateKnowledge(entry) ? privateStatement(entry) : entry.statement,
	};
}

/** @param {FactoryDocument} original @param {HistoricalSelection[]} [retained] */
export function projectKnowledge(original, retained = []) {
	const state = replay({ ...original, revision: 0, events: [] }, original.repository);
	/** @type {FactoryEvent[]} */
	const events = [];
	const selections = new Map(retained.map((entry) => [entry.id, entry]));
	let through = 0;
	for (const entry of original.events) {
		const previousKnowledgeCount = state.knowledge.length;
		applyEvent(state, entry, { historical: true, portable: original.portable === true });
		let portable = entry;
		switch (entry.action) {
			case "recordOperating":
				through = entry.revision;
				break;
			case "createUnit":
			case "recordSignal":
				portable = { ...entry, input: portableSource(entry.input) };
				through = entry.revision;
				break;
			case "appendKnowledge":
				portable = { ...entry, input: knowledgeInput(state.knowledge[previousKnowledgeCount]) };
				through = entry.revision;
				break;
			case "ingestAnalysis":
				portable = { ...entry, action: "checkpoint", input: {
					digest: analysisInputDigest(entry), knowledge: state.knowledge.slice(previousKnowledgeCount).map(knowledgeInput),
				} };
				through = entry.revision;
				break;
			case "acceptContract": {
				const contract = state.contracts.at(-1);
				if (!contract) fail("factory_contract_missing", "Accepted knowledge has no contract");
				portable = { ...entry, input: {
					...entry.input,
					...(contract.sealVersion === 2 && entry.input.historicalSeal === undefined
						? { historicalSeal: contract.digest, contextSeal: analysisInputDigest(contractContext(state, contract)), historicalOnly: true } : {}),
				} };
				through = entry.revision;
				break;
			}
			case "retire":
				if (entry.input.type === "knowledge") through = entry.revision;
				else portable = { ...entry, action: "checkpoint", input: { digest: analysisInputDigest(entry) } };
				break;
			case "decideCandidate": {
				const decision = state.decisions.at(-1);
				if (!decision || decision.kind === "accept-contract") fail("factory_context_invalid", "Candidate selection has no historical decision");
				const candidate = state.candidates.find((item) => item.id === decision.candidateId);
				if (!candidate) fail("factory_candidate_missing", "Candidate selection has no subject");
				const historical = {
					id: decision.id, digest: analysisInputDigest(decision), candidateId: candidate.id, unitId: candidate.unitId,
					action: decision.kind, actor: decision.actor, reason: decision.reason, at: decision.at,
					commit: candidate.delivery?.commit ?? null,
					evidence: candidate.evidence.filter((item) => decision.evidenceIds.includes(item.id)).map((item) => analysisInputDigest(item)),
				};
				const existing = selections.get(historical.id);
				if (existing && stableStringify(existing) !== stableStringify(historical)) fail("factory_knowledge_conflict", "Historical selection identities conflict");
				selections.set(historical.id, historical);
				portable = { ...entry, action: "checkpoint", input: { digest: analysisInputDigest(entry) } };
				through = entry.revision;
				break;
			}
			case "checkpoint":
				if (entry.input.knowledge !== undefined) through = entry.revision;
				break;
			default:
				portable = { ...entry, action: "checkpoint", input: { digest: analysisInputDigest(entry) } };
		}
		events.push(portable);
	}
	// Imported selection summaries may terminate in a checkpoint, not a contract.
	through = Math.max(through, ...retained.map((entry) => Number(entry.id.replace(/^decision-/, ""))).filter(Number.isSafeInteger));
	/** @type {FactoryDocument} */
	const document = {
		format: original.format, repository: { id: original.repository.id, commonDirectory: `repository:${original.repository.id}` },
		revision: through, events: events.slice(0, through), portable: true,
	};
	try {
		const projected = replay(document, document.repository);
		for (const contract of state.contracts) {
			const restored = projected.contracts.find((item) => item.unitId === contract.unitId && item.revision === contract.revision);
			if (!restored || restored.digest !== contract.digest) fail("factory_knowledge_integrity", "Portable publication changed an accepted contract");
		}
	} catch (error) {
		if (errorCode(error) !== "factory_knowledge_missing") throw error;
		throw Object.assign(new Error("Knowledge cannot be published without private report data; recover an explicit portable lesson instead of linking a raw session report", { cause: error }), { code: "factory_knowledge_not_portable" });
	}
	return { document, selections: [...selections.values()] };
}

/**
 * SQLite is a durable local outbox and execution journal. Portable knowledge
 * becomes visible only after its immutable object and head have been published.
 * @param {{local: ReturnType<typeof import("./storage.mjs").createFactoryLedger>,
 * repository: RepositoryIdentity, repositoryPath: string}} options
 */
export function createPortableLedger({ local, repository, repositoryPath }) {
	const files = createKnowledgeRepository({ repository, repositoryPath });
	/** @returns {{digest: string, publication: Publication}|null} */
	const current = () => {
		const head = files.head();
		if (!head) return null;
		const publication = readPublication(head.value);
		if (publication.document.repository.id !== repository.id) fail("factory_repository_mismatch", "Knowledge publication belongs to a different repository");
		return { digest: head.digest, publication };
	};
	const localDocument = local.readDocument;
	/** @param {boolean} [writing] @param {Publication["migration"]} [migration] */
	function synchronize(writing = false, migration = null) {
		let head = current();
		let metadata = local.knowledgeMetadata();
		let document = localDocument();
		if (metadata.mode === "local") {
			const transfers = local.storageInfo().transfers;
			if (document.revision === 0 && transfers.length) {
				if (writing && transfers.some((entry) => entry.status === "pending")) fail("factory_import_pending", "Complete or abandon the explicit staged import before publishing knowledge");
				if (writing && head) fail("factory_knowledge_conflict", "An abandoned local import does not replace existing repository knowledge");
				if (!writing) return head;
			}
			if (document.revision === 0 && head) {
				local.importFactory({ source: JSON.stringify({ ...head.publication.document, repository }), expectedRevision: 0 });
				local.setKnowledgeMetadata({ mode: "repository", head: head.digest });
				metadata = local.knowledgeMetadata();
				document = localDocument();
			} else if (document.revision !== 0 && !migration) {
				if (writing) fail("factory_migration_required", "This local ledger needs explicit migration before publishing repository-owned knowledge");
				return head;
			} else if (writing || migration) {
				if (migration && head) {
					const projected = projectKnowledge(document, head.publication.selections);
					if (stableStringify(projected) !== stableStringify({ document: head.publication.document, selections: head.publication.selections })) {
						fail("factory_knowledge_conflict", "Migration cannot replace divergent repository-owned knowledge");
					}
				}
				local.setKnowledgeMetadata({ mode: "repository", head: head?.digest ?? null });
				metadata = local.knowledgeMetadata();
			} else return head;
		}
		const projected = projectKnowledge(document, head?.publication.selections);
		const matches = head && stableStringify(projected) === stableStringify({ document: head.publication.document, selections: head.publication.selections });
		if ((head?.digest ?? null) !== metadata.head) {
			if (head && head.publication.parent === metadata.head && matches) {
				local.setKnowledgeMetadata({ mode: "repository", head: head.digest });
				return head;
			}
			fail("factory_knowledge_conflict", "The checked-out knowledge head differs from this execution journal; keep both branches and reconcile explicitly");
		}
		if ((matches && (!migration || stableStringify(migration) === stableStringify(head?.publication.migration)))
			|| (!document.revision && !head)) return head;
		const publication = { format: /** @type {const} */ ("foundry-knowledge-v1"), parent: metadata.head, ...projected,
			migration: migration ?? head?.publication.migration ?? null };
		const next = files.publish(metadata.head, publication);
		local.setKnowledgeMetadata({ mode: "repository", head: next });
		head = { digest: next, publication };
		return head;
	}
	/** @template T @param {() => T} operation */
	const reading = (operation) => files.exclusive(() => { synchronize(); return operation(); });
	/** @param {FactoryAction} action @param {Record<string, unknown>} input */
	const executionReceipt = (action, input) => ["recordDelivery", "recordEvaluation", "recordCompletion", "recordEvaluationCompletion", "abandonPlan"].includes(action)
		|| (action === "appendKnowledge" && ["observation", "inference", "proposal"].includes(String(input.kind))
			&& isRecord(input.source) && input.source.kind === "app-task");
	const executionSnapshot = () => files.exclusive(() => {
		try { synchronize(); }
		catch (error) { if (errorCode(error) !== "factory_knowledge_conflict") throw error; }
		return local.snapshot();
	});
	/** @template {FactoryAction} A @param {A} action @param {Record<string, unknown>} input
	 * @param {Parameters<typeof local.append>[2]} [validate] */
	const append = (action, input, validate) => files.exclusive(() => {
		let head;
		try { head = synchronize(true); }
		catch (error) {
			if (!["factory_knowledge_conflict", "factory_migration_required"].includes(errorCode(error) ?? "") || !executionReceipt(action, input)) throw error;
			return { ...local.append(action, input), knowledgePublication: errorCode(error) };
		}
		if (action === "recordOperating" && !validate) fail("operating_authority_unavailable", "Operating publication requires its owner-local commit");
		const result = local.append(action, input, (document, state) => {
			projectKnowledge(document, head?.publication.selections);
			validate?.(document, state);
		});
		try { synchronize(true); }
		catch (cause) {
			throw Object.assign(new Error("The factory mutation is durable locally, but knowledge publication is pending; inspect or reopen the factory to recover without repeating the mutation", { cause }), {
				code: "factory_publication_pending", revision: result.revision,
			});
		}
		return result;
	});
	/** @param {{expectedRevision: number, actor: string, reason: string}} input */
	const migrateFactory = (input) => files.exclusive(() => {
		const document = localDocument();
		if (input.expectedRevision !== document.revision) fail("revision_conflict", "Factory changed before migration");
		const migration = { sourceDigest: analysisInputDigest(document), actor: text(input.actor, "actor", 256), reason: text(input.reason, "reason", 8000) };
		projectKnowledge(document, current()?.publication.selections);
		const head = synchronize(true, migration);
		return { repository, revision: document.revision, head: head?.digest ?? null, migrated: true, originalJournalRetained: true, executionOwnership: "not-transferred" };
	});
	return {
		...local, append, migrateFactory, executionSnapshot,
		assertCurrentKnowledge: () => reading(() => local.knowledgeMetadata().head),
		snapshot: () => reading(local.snapshot),
		preview: (/** @type {Parameters<typeof local.preview>[0]} */ receipts) => files.exclusive(() => {
			try { synchronize(); }
			catch (error) {
				if (errorCode(error) !== "factory_knowledge_conflict" || !receipts.every((receipt) => executionReceipt(receipt.action, receipt.input))) throw error;
			}
			return local.preview(receipts);
		}),
		exportFactory: () => reading(local.exportFactory),
		exportFactoryPage: (/** @type {Parameters<typeof local.exportFactoryPage>[0]} */ input = {}) => reading(() => local.exportFactoryPage(input)),
		storageInfo: () => reading(() => ({
			...local.storageInfo(), knowledge: { ...local.knowledgeMetadata(), authority: ".foundry/repository.json",
				historicalSelections: (current()?.publication.selections ?? []).slice(-50),
				historicalSelectionCount: current()?.publication.selections.length ?? 0, importedExecutionOwnership: false },
		})),
	};
}
