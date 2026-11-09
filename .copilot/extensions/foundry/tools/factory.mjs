import { handler } from "./results.mjs";
import { DIGEST, FACTORY_ARTIFACT, FACTORY_ID, FACTORY_SOURCE, KNOWLEDGE_REF, NON_EMPTY, objectSchema, REFERENCES, REVISION, STRING_LIST } from "./schema.mjs";

/** @typedef {import("../types/json.js").JsonSchema} JsonSchema */
/** Tool transport deliberately does not depend on operation result internals.
 * @typedef {Record<Exclude<keyof import("../operations.mjs").FoundryOperations,
 * "storeFor" | "factoryFor" | "getPlan" | "getWorkflow" | "nextTasks" | "getActive" | "getActivation" | "deactivate">,
 * (input: unknown, options?: {signal?: AbortSignal}) => unknown> & {deactivate: () => unknown}} ToolOperations */

/** @param {ToolOperations} operations */
export function factoryTools(operations) {
	/** @param {string} name @param {string} action @param {string} description @param {string[]} required @param {Record<string, JsonSchema>} properties @param {boolean} [readOnly] */
	const tool = (name, action, description, required, properties, readOnly = false) => ({
		name: `foundry_${name}`, description,
		...(readOnly ? { skipPermission: true } : {}),
		parameters: objectSchema(["repositoryPath", ...required], { repositoryPath: NON_EMPTY(4096), ...properties }),
		handler: handler((args) => {
			if (!args || typeof args !== "object" || Array.isArray(args) || !("repositoryPath" in args)) {
				throw new TypeError("Factory tools require repositoryPath");
			}
			const { repositoryPath, ...input } = args;
			return operations.factoryAction({ repositoryPath, action, input });
		}),
	});
	/** @param {string} name @param {string} action @param {string} description @param {string[]} required @param {Record<string, JsonSchema>} properties */
	const mutation = (name, action, description, required, properties) =>
		tool(name, action, description, ["expectedRevision", ...required], { expectedRevision: REVISION, ...properties });
	return [
		tool("get_factory", "inspect", "Inspect bounded repository capability knowledge, accepted versus proposed authority, candidate lineage/current assurance, and renewal needs. Survives sibling sessions; never imports native run ownership.", [], {
			unitId: FACTORY_ID, candidateId: FACTORY_ID, limit: { type: "integer", minimum: 1, maximum: 100 },
			includeRetired: { type: "boolean" }, environment: NON_EMPTY(2048), workload: NON_EMPTY(2048),
		}, true),
		mutation("define_unit", "createUnit", "Define or revise a coherent capability and its exclusive authority boundaries, conserved contracts and shared dependencies. Revisions are proposals until explicitly pinned in an accepted contract.", ["id", "name", "purpose", "boundary", "dependencies", "relationshipCoverage", "actor"], {
			id: FACTORY_ID, name: NON_EMPTY(160), purpose: NON_EMPTY(8000),
			boundary: objectSchema(["owns", "exposes", "consumes", "preserves"], {
				owns: STRING_LIST(32, 2048, 1), exposes: STRING_LIST(32, 2048, 1),
				consumes: STRING_LIST(32, 2048), preserves: STRING_LIST(32, 2048, 1),
			}),
			dependencies: { type: "array", maxItems: 32, items: FACTORY_ID },
			relationshipCoverage: { type: "string", enum: ["complete", "partial"] },
			actor: NON_EMPTY(256), reason: NON_EMPTY(8000),
		}),
		mutation("record_knowledge", "appendKnowledge", "Append attributed observation, inference, proposal, draft obligation or evaluator. This never approves requirements. Revisions explicitly supersede the prior revision; retain reasons and linked discoveries.", ["id", "unitId", "kind", "statement", "source"], {
			id: FACTORY_ID, unitId: FACTORY_ID,
			kind: { type: "string", enum: ["observation", "inference", "proposal", "obligation", "evaluation"] },
			statement: NON_EMPTY(8000), source: FACTORY_SOURCE,
			uncertainty: { type: ["string", "null"], maxLength: 8000 },
			links: {
				type: "array", maxItems: 64, items: objectSchema(["relation", "target"], {
					relation: { type: "string", enum: ["supports", "contradicts", "derived-from", "supersedes", "depends-on"] }, target: KNOWLEDGE_REF,
				})
			},
			evaluation: objectSchema(["modality", "procedure", "obligations", "environment", "workload", "maxAgeSeconds", "independent", "preservation"], {
				modality: { type: "string", enum: ["implementation-test", "boundary", "operational", "human"] },
				procedure: objectSchema(["kind", "ref", "digest"], {
					kind: { type: "string", enum: ["command", "reference", "judgment"] }, ref: NON_EMPTY(4096), digest: DIGEST,
				}),
				obligations: REFERENCES, environment: NON_EMPTY(2048), workload: NON_EMPTY(2048),
				maxAgeSeconds: { type: "integer", minimum: 1, maximum: 31536000 }, independent: { type: "boolean" }, preservation: { type: "boolean" },
			}),
		}),
		mutation("accept_contract", "acceptContract", "Record explicit human acceptance of immutable obligation/evaluation revisions and boundary ownership. Requires complete evaluation coverage plus independent boundary/preservation checks. Never infer approval from a generated spec.", ["unitId", "unitRevision", "obligations", "evaluations", "actor", "reason"], {
			unitId: FACTORY_ID, unitRevision: { type: "integer", minimum: 1 }, obligations: REFERENCES, evaluations: REFERENCES,
			actor: NON_EMPTY(256), reason: NON_EMPTY(8000),
			rationale: REFERENCES,
			renewalSignalIds: { type: "array", maxItems: 32, items: FACTORY_ID },
			resolutions: { type: "array", maxItems: 64, items: objectSchema(["knowledge", "reason"], { knowledge: KNOWLEDGE_REF, reason: NON_EMPTY(8000) }) },
		}),
		mutation("prepare_candidate", "prepareCandidate", "Seal an attributable candidate against accepted knowledge. Reconstruction separates generation inputs from comparison-only prior implementation and preserves the incumbent. Adoption evaluates pre-existing artifacts without inventing generation provenance. No agents launch.", ["id", "unitId", "contractRevision", "actor", "context"], {
			id: FACTORY_ID, unitId: FACTORY_ID, contractRevision: { type: "integer", minimum: 1 },
			mode: { type: "string", enum: ["adoption", "implementation", "reconstruction"], default: "reconstruction" }, actor: NON_EMPTY(256),
			renewalSignalIds: { type: "array", maxItems: 32, items: FACTORY_ID },
			context: objectSchema(["generation", "comparisonOnly", "independence"], {
				generation: { type: "array", maxItems: 64, items: FACTORY_ARTIFACT },
				comparisonOnly: { type: "array", maxItems: 64, items: FACTORY_ARTIFACT },
				independence: objectSchema(["method", "reason"], {
					method: { type: "string", enum: ["fresh-session", "fresh-process", "declared", "existing-artifact"] }, reason: NON_EMPTY(8000),
				}),
			}),
		}),
		mutation("record_delivery", "recordDelivery", "Record exact external/adopted candidate delivery and original producer provenance. Bound App candidates instead synchronize from their completed task attempt. The artifact and commit remain claims, not attestation.", ["candidateId", "commit", "artifact", "source"], {
			candidateId: FACTORY_ID, commit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
			artifact: FACTORY_ARTIFACT, source: FACTORY_SOURCE,
		}),
		mutation("record_evaluation", "recordEvaluation", "Record actual external evaluation output against an exact candidate, contract/context, evaluator digest, commit and environment/workload. Distinct producer identities establish independent claims, not cryptographic or OS isolation. Bound App reports come through complete_task.", ["id", "candidateId", "evaluation", "contractDigest", "contextDigest", "commit", "procedureDigest", "outcome", "source", "environment", "workload", "independence", "report"], {
			id: FACTORY_ID, candidateId: FACTORY_ID, evaluation: KNOWLEDGE_REF, contractDigest: DIGEST, contextDigest: DIGEST,
			commit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }, procedureDigest: DIGEST,
			outcome: { type: "string", enum: ["passed", "failed", "inconclusive"] }, source: FACTORY_SOURCE,
			environment: NON_EMPTY(2048), workload: NON_EMPTY(2048), report: NON_EMPTY(16000),
			independence: objectSchema(["method", "reason"], {
				method: { type: "string", enum: ["separate-session", "separate-process", "human-review", "same-context"] }, reason: NON_EMPTY(8000),
			}),
		}),
		mutation("decide_candidate", "decideCandidate", "Record explicit acceptance/rejection with reasons. Acceptance requires complete current independent assurance and unchanged incumbent identity. This selects the durable replacement; it does not merge, delete branches, migrate data, or deploy.", ["candidateId", "action", "expectedIncumbentId", "actor", "reason"], {
			candidateId: FACTORY_ID, action: { type: "string", enum: ["accept", "reject"] },
			expectedIncumbentId: { type: ["string", "null"], maxLength: 96 }, actor: NON_EMPTY(256), reason: NON_EMPTY(8000),
		}),
		mutation("record_signal", "recordSignal", "Capture an incident, failed evaluation, changed assumption or stale/context-mismatched evidence. Propose bounded re-evaluation for known dependents and expose localization uncertainty; never rewrite past acceptance or promote observations.", ["id", "kind", "summary", "source"], {
			id: FACTORY_ID, kind: { type: "string", enum: ["incident", "failed-evaluation", "assumption-change", "evidence-expired", "context-mismatch"] },
			summary: NON_EMPTY(8000), source: FACTORY_SOURCE, unitIds: { type: "array", maxItems: 32, items: FACTORY_ID }, knowledgeRefs: REFERENCES,
		}),
		mutation("retire_artifact", "retire", "Explicitly retire/compact a superseded candidate or knowledge revision from default views. Preserve full history, provenance and summary; refuse current/required artifacts. Never delete user data, files or branches.", ["type", "id", "actor", "reason", "summary"], {
			type: { type: "string", enum: ["candidate", "knowledge"] }, id: FACTORY_ID, revision: { type: "integer", minimum: 1 },
			actor: NON_EMPTY(256), reason: NON_EMPTY(8000), summary: NON_EMPTY(8000),
		}),
		mutation("compact_factory", "compactFactory", "After explicit retirement, losslessly compress the retained factory ledger with an attributed reason. Reports actual stored document bytes before/after. Preserves all history and current required artifacts; does not delete user files or guarantee a smaller SQLite file, and does not lift logical history bounds.", ["actor", "reason"], {
			actor: NON_EMPTY(256), reason: NON_EMPTY(8000),
		}),
		tool("export_factory", "exportFactory", "Export exact current-format repository factory JSON including retained historical lineage. Native session execution ownership is not exported as authority to run anything.", [], {}, true),
		tool("export_factory_page", "exportFactoryPage", "Read a bounded page of the exact v2 logical event sequence. Keep revision/throughDigest fixed and pass nextRevision as afterRevision; archival and new appends cannot change that pinned prefix. Use staged import pages for histories above the single-JSON limit.", [], {
			afterRevision: REVISION, throughRevision: REVISION, throughDigest: DIGEST,
			limit: { type: "integer", minimum: 1, maximum: 256 },
		}, true),
		mutation("import_factory_page", "importFactoryPage", "Stage one exact current-format export page into an empty repository authority. No staged history becomes active until the complete pinned sequence validates. Does not import native execution ownership; partial transfers survive restart.", ["importId", "page"], {
			expectedRevision: { const: 0 }, importId: FACTORY_ID,
			page: objectSchema(["format", "repository", "revision", "throughDigest", "afterRevision", "events", "nextRevision", "complete"], {
				format: { const: "foundry-factory-v2" },
				repository: objectSchema(["id", "commonDirectory"], { id: DIGEST, commonDirectory: NON_EMPTY(4096) }),
				revision: REVISION, throughDigest: DIGEST, afterRevision: REVISION, nextRevision: REVISION, complete: { type: "boolean" },
				events: {
					type: "array", maxItems: 256, items: objectSchema(["revision", "at", "action", "input"], {
						revision: { type: "integer", minimum: 1 }, at: NON_EMPTY(64), action: NON_EMPTY(96), input: { type: "object" },
					})
				},
			}),
		}),
		mutation("abandon_factory_import", "abandonFactoryImport", "Explicitly abandon a pending staged import with actor/reason. Staged history is retained, not deleted, and the empty authority can accept new work.", ["importId", "actor", "reason"], {
			expectedRevision: { const: 0 }, importId: FACTORY_ID, actor: NON_EMPTY(256), reason: NON_EMPTY(8000),
		}),
		mutation("import_factory", "importFactory", "Explicitly restore current-format factory JSON only into an empty authority for the same canonical repository. Replays all validation and decisions; never activates plans or adopts another session's native runs.", ["source"], {
			expectedRevision: { const: 0 }, source: { type: "string", minLength: 1, maxLength: 33554432 },
		}),
	];
}
