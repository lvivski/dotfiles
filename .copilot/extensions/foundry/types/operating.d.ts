import type { ContextArtifact, ContractDependency, FactorySnapshot, KnowledgeRef } from "./factory.js";
import type { ApprovalDelegation, FoundryPlan } from "./plan.js";
import type { Fence, AdmissionPort } from "./parallel.js";

/** Portable attribution is historical, never a native ownership or approval credential. */
export type OperatingIdentity = {
	version: 1; kind: "app" | "human" | "external"; identity: string; source: string;
	authority: "historical";
};
export type OperatingCategory = "observation" | "proposal" | "plan" | "completion"
	| "technical-retry" | "evaluator-renewal" | "contract" | "replacement" | "human" | "external" | "resource";
export type OperatingContext = {
	id: string; kind: "knowledge" | "decision" | "artifact"; digest: string;
	usage: "generation" | "private" | "comparison-only";
	knowledge: KnowledgeRef | null; artifact: ContextArtifact | null;
};
export type OperatingCriterion = {
	id: string; statement: string; obligation: KnowledgeRef | null; evaluations: KnowledgeRef[];
	dependsOn: string[]; environment: string; workload: string;
};
export type OperatingProducer = {
	goal: KnowledgeRef; charter: KnowledgeRef; planId: string; taskId: string; attemptId: string;
	commit: string; artifact: ContextArtifact; contract: ContractDependency | null;
	evaluators: { evaluation: KnowledgeRef; procedureDigest: string }[];
};
type OperatingRecordBase = {
	version: 1; id: string; revision: number; previous: KnowledgeRef | null;
	source: OperatingIdentity; context: OperatingContext[];
};
export type OperatingCharter = OperatingRecordBase & {
	kind: "charter"; name: string; purpose: string; accountable: OperatingIdentity;
	scope: string[]; decisions: OperatingCategory[];
};
export type OperatingGoal = OperatingRecordBase & {
	kind: "goal"; title: string; intent: string; charter: KnowledgeRef;
	authority: "proposed" | "accepted"; contract: ContractDependency | null;
	criteria: OperatingCriterion[]; preserves: string[];
	relationshipCoverage: "complete" | "partial"; candidateId: string | null;
};
export type OperatingRelationship = OperatingRecordBase & {
	kind: "relationship"; relation: "subgoal" | "depends-on" | "artifact";
	from: KnowledgeRef; to: KnowledgeRef | null; requirement: string;
	criterionIds: string[]; producer: OperatingProducer | null;
};
export type OperatingDecision = OperatingRecordBase & {
	kind: "decision"; charter: KnowledgeRef; goal: KnowledgeRef | null;
	category: OperatingCategory; status: "observation" | "inference" | "proposal" | "historical";
	rationale: string; governing: KnowledgeRef[];
};
export type OperatingRecord = OperatingCharter | OperatingGoal | OperatingRelationship | OperatingDecision;

/** Only explicit references are local; no arbitrary payloads, conversations or credentials. */
export type OperatingPrivateReference = {
	id: string; kind: "context" | "source" | "decision" | "comparison"; ref: string; digest: string;
};
export type OperatingBinding = {
	charter: KnowledgeRef; projectId: string; sessionId: string; owner: string;
	planId: string; taskId: string; attemptId: string; observationDigest: string;
};
export type OperatingSnapshot = {
	/** The read set is the complete canonical factory snapshot, including all
	 * operating revisions and resolved knowledge/contracts/evidence. No "latest"
	 * reference may be resolved after validation without taking a new snapshot. */
	version: 1; repositoryId: string; factoryRevision: number; stateDigest: string;
};
export type OperatingBatch = {
	version: 1; id: string; snapshot: OperatingSnapshot; records: OperatingRecord[];
	source: OperatingIdentity;
};
export type OperatingPublication = {
	version: 1; batch: OperatingBatch; digest: string;
	planId: string; planRevision: number; taskId: string; attemptId: string;
	reservationId: string; ownerDigest: string; sessionId: string; at: string;
};
export type OperatingHistory = {
	version: 1; publications: OperatingPublication[];
	/** Local commit markers and references are stripped on both export and import. */
	local: { digest: string; references: OperatingPrivateReference[]; binding: OperatingBinding | null }[];
};
export type OperatingAuthority = {
	planId: string; expectedPlanRevision: number; taskId: string; attemptId: string;
	fence: Fence; binding: OperatingBinding | null; references: OperatingPrivateReference[];
	delegationId: string | null;
};
/** Trusted composition ports, not callable fields accepted from JSON/tool requests. */
export type OperatingRules = {
	charters?: (state: FactorySnapshot, records: readonly OperatingRecord[]) => void;
	goals?: (state: FactorySnapshot, records: readonly OperatingRecord[]) => void;
};
export type OperatingNativePort = {
	/** Trusted composition identity, never accepted from a mutation DTO. Required
	 * for recording a decision under an existing coordinator-local delegation. */
	coordinatorSessionId?: string;
	/** Must recheck the native owner, attachment and any operation-specific delegation.
	 * Called inside the existing admission fence and owner-plan writer. Missing support holds. */
	assertAuthority(plan: FoundryPlan, authority: OperatingAuthority, delegation: ApprovalDelegation | null, publication: OperatingPublication): void;
};
/** Ephemeral validation capability, not a grant. Runtime identity is checked;
 * a structurally identical JSON object cannot authorize an outbox write. */
export type OperatingCommitPermit = { readonly kind: "operating-validated-commit" };
export type OperatingPersistencePort = {
	commit(publication: OperatingPublication, authority: OperatingAuthority, native: OperatingNativePort, permit: OperatingCommitPermit): OperatingPublication;
	require(planId: string, digest: string): OperatingPublication;
};
export type OperatingPorts = {
	/** Optional additional checks; canonical charter/goal rules always run. */
	rules: OperatingRules; persistence: OperatingPersistencePort;
	admission: Pick<AdmissionPort, "withFence">; native: OperatingNativePort;
};
export type OperatingService = {
	snapshot(): { state: FactorySnapshot; token: OperatingSnapshot };
	prepare(input: OperatingBatch): OperatingBatch;
	commit(batch: OperatingBatch, authority: OperatingAuthority): OperatingPublication;
	/** Requires the exact nonimportable owner commit marker. A changed canonical
	 * revision holds, never rebases. Postcommit revocation cannot authorize a new
	 * operation; it also cannot erase this already committed historical intent.
	 * Factory append and repository publication are idempotently recovered, not
	 * a cross-database transaction. Incomplete native/domain composition holds. */
	reconcile(planId: string, digest: string): OperatingPublication;
};
