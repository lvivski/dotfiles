export type KnowledgeRef = { id: string; revision: number };

export type RepositoryIdentity = { id: string; commonDirectory: string };

export type Trust = "claimed" | "independent-claim";

export type Outcome = "passed" | "failed" | "inconclusive";

export type SourceKind = "discovery" | "implementation" | "audit" | "research" | "review"
	| "security" | "triage" | "command" | "human" | "operational" | "app-task"
	| "external-run" | "native-workflow";

export type Provenance = {
	kind: SourceKind; ref: string; actor: string; at: string;
	sessionId?: string; planId?: string; taskId?: string; attemptId?: string;
	runId?: string; owner?: string; digest?: string; judgmentId?: string;
};

export type CapabilityUnit = KnowledgeRef & {
	name: string; purpose: string;
	boundary: { owns: string[]; exposes: string[]; consumes: string[]; preserves: string[] };
	dependencies: string[]; relationshipCoverage: "complete" | "partial";
	actor: string; at: string; reason: string;
};

export type EvaluationDefinition = {
	modality: "implementation-test" | "boundary" | "operational" | "human";
	procedure: { kind: "command" | "reference" | "judgment"; ref: string; digest: string };
	obligations: KnowledgeRef[]; environment: string; workload: string;
	maxAgeSeconds: number; independent: boolean; preservation: boolean;
};

export type KnowledgeKind = "observation" | "inference" | "proposal" | "obligation" | "evaluation";

export type KnowledgeLink = {
	relation: "supports" | "contradicts" | "derived-from" | "supersedes" | "depends-on";
	target: KnowledgeRef;
};

export type Knowledge = KnowledgeRef & {
	unitId: string; kind: KnowledgeKind; statement: string; source: Provenance;
	links: KnowledgeLink[]; uncertainty: string | null;
	evaluation: EvaluationDefinition | null; recordedAt: string;
};

export type ProjectedKnowledge = Pick<Knowledge,
	"id" | "revision" | "unitId" | "kind" | "statement" | "uncertainty" | "links"> & {
		authority: "accepted" | "non-governing"; evaluation?: EvaluationDefinition;
	};

export type ProjectedEvaluation = ProjectedKnowledge & { evaluation: EvaluationDefinition };

export type ContractDependency = {
	unitId: string; unitRevision: number; contractRevision: number; contractDigest: string;
};

export type FactoryContract = {
	sealVersion: number; unitId: string; unitRevision: number; revision: number;
	obligations: KnowledgeRef[]; evaluations: KnowledgeRef[]; rationale: KnowledgeRef[];
	decisionId: string; acceptedAt: string; previousDigest: string | null;
	dependencies: ContractDependency[]; decisionIds: string[]; omittedEarlierDecisions: number;
	digest: string;
};

export type ContractDecision = {
	id: string; kind: "accept-contract"; unitId: string;
	actor: string; reason: string; at: string;
	resolutions: { knowledge: KnowledgeRef; reason: string }[];
	renewalSignalIds?: string[];
};

export type CandidateDecision = {
	id: string; kind: "accept-candidate" | "reject-candidate"; unitId: string;
	candidateId: string; incumbentId: string | null; contractDigest: string;
	evidenceIds: string[]; actor: string; reason: string; at: string;
};

export type FactoryDecision = ContractDecision | CandidateDecision;

export type ContextArtifact = {
	kind: "knowledge" | "schema" | "test" | "reference" | "foundation" | "implementation" | "data";
	ref: string; digest: string;
};

export type CandidateContext = {
	generation: ContextArtifact[]; comparisonOnly: ContextArtifact[];
	independence: { method: "fresh-session" | "fresh-process" | "declared" | "existing-artifact"; reason: string };
};

export type Delivery = { commit: string; artifact: ContextArtifact; source: Provenance; recordedAt: string; trust: "claimed" };

export type Completion = {
	source: Provenance; passed: boolean; commit: string | null; evidenceIds: string[]; recordedAt: string;
	disposition?: "cancelled"; reason?: string;
};

export type FactoryBinding = {
	unitId: string; candidateId: string | null; unitRevision: number;
	contractRevision: number | null; contractDigest: string | null; contextDigest: string | null;
	planId: string; owner: string; blueprintDigest: string; at: string;
	purpose?: "evaluation"; evaluations?: KnowledgeRef[]; targetCommit?: string;
	completion?: Completion | null; completions?: Completion[]; active?: boolean; activatedAt?: string;
};

export type EvaluationEvidence = {
	id: string; candidateId: string; evaluation: KnowledgeRef; contractDigest: string;
	contextDigest: string; commit: string; procedureDigest: string; outcome: Outcome;
	source: Provenance; environment: string; workload: string;
	independence: { method: "separate-session" | "separate-process" | "human-review" | "same-context"; reason: string };
	report: string; reportDigest: string; trust: Trust; recordedAt: string;
};

export type Candidate = {
	id: string; unitId: string; contractRevision: number; contractDigest: string;
	mode: "adoption" | "implementation" | "reconstruction"; context: CandidateContext;
	contextDigest: string; actor: string; createdAt: string; incumbentId: string | null;
	binding: FactoryBinding | null; delivery: Delivery | null; completion: Completion | null;
	evidence: EvaluationEvidence[]; renewalSignalIds?: string[];
};

export type Impact = { affectedUnitIds: string[]; uncertainUnitIds: string[]; localization: string };

export type Signal = Impact & {
	id: string; kind: "incident" | "failed-evaluation" | "assumption-change" | "evidence-expired" | "context-mismatch";
	summary: string; unitIds: string[]; knowledgeRefs: KnowledgeRef[]; source: Provenance; recordedAt: string;
};

export type Renewal = Impact & { id: string; signalId: string; status: string; proposal: string; at: string };

export type Retirement = {
	type: "candidate" | "knowledge"; id: string; revision?: number;
	actor: string; reason: string; at: string; summary: string; retention: string;
};

export type Compaction = { id: string; actor: string; reason: string; at: string; retention: string };

export type FactoryState = {
	units: CapabilityUnit[]; knowledge: Knowledge[]; contracts: FactoryContract[];
	candidates: Candidate[]; decisions: FactoryDecision[]; signals: Signal[];
	renewals: Renewal[]; retirements: Retirement[]; compactions: Compaction[]; bindings: FactoryBinding[];
};

export type FactorySnapshot = FactoryState & { repository: RepositoryIdentity; revision: number };

export type EvaluationSupport = {
	evaluation: KnowledgeRef; modality: EvaluationDefinition["modality"]; preservation: boolean;
	evidenceId: string | null; observedAt: string | null; gaps: string[];
};

export type Assurance = { ready: boolean; missing: string[]; evaluationSupport: EvaluationSupport[]; trust: string; observedAt: string };

export type PublicationDisposition = "historical" | "conflicting" | "current" | "corroborating" | "duplicate-origin";

export type Observation = {
	evaluation: KnowledgeRef; receiptId: string; observedAt: string; publishedAt: string;
	disposition: PublicationDisposition; currentEvidenceId: string | null;
};

export type FactoryDefinitions = {
	sealVersion?: number; unit: CapabilityUnit; obligations: ProjectedKnowledge[];
	evaluations: ProjectedEvaluation[]; rationale: ProjectedKnowledge[];
	decisionLineage: FactoryDecision[]; omittedEarlierDecisions?: number;
	foundations: (ContractDependency & { usage: string; boundary: CapabilityUnit["boundary"] })[];
	contract: FactoryContract | null;
};

export type GenerationPackage = Omit<FactoryDefinitions, "contract"> & {
	purpose: string; candidateId: string; contract: FactoryContract;
	inputs: ContextArtifact[]; independence: CandidateContext["independence"];
	contextDigest: string; limitations: string;
};

export type FactoryResults = {
	createUnit: { unit: CapabilityUnit };
	appendKnowledge: { knowledge: Knowledge };
	acceptContract: { contract: FactoryContract; decision: ContractDecision };
	prepareCandidate: { candidate: Candidate; generation: GenerationPackage; comparison: ContextArtifact[] };
	bindPlan: { binding: FactoryBinding };
	bindEvaluationPlan: { binding: FactoryBinding };
	activateEvaluationPlan: { binding: FactoryBinding; idempotent?: true };
	recordDelivery: { candidate: Candidate; idempotent?: true };
	recordEvaluation: {
		evidence: EvaluationEvidence; assurance: Assurance; idempotent?: true;
		publication?: { disposition: PublicationDisposition | undefined; currentEvidenceId: string | null }
	};
	recordCompletion: { candidate: Candidate };
	recordEvaluationCompletion: { binding: FactoryBinding; idempotent?: true };
	abandonPlan: { candidate: Candidate };
	decideCandidate: { candidate: Candidate; decision: CandidateDecision };
	recordSignal: { signal: Signal; renewal: Renewal };
	ingestAnalysis: { knowledge: Knowledge[]; reportDigest: string };
	retire: { retirement: Retirement };
	compactFactory: { compaction: Compaction };
};

export type FactoryAction = keyof FactoryResults;

/** Event inputs stay untrusted until the action-specific replay validator runs. */
export type FactoryEvent<A extends FactoryAction = FactoryAction> = {
	revision: number; at: string; action: A; input: Record<string, unknown>;
};

export type FactoryDocument = { format: string; repository: RepositoryIdentity; revision: number; events: FactoryEvent[] };

export type FactoryExportPage = FactoryDocument & {
	throughDigest: string; afterRevision: number; nextRevision: number; complete: boolean;
};

export type FactoryReceipt = { action: FactoryAction; input: Record<string, unknown>; label?: string };

export type FactoryMutationResult<A extends FactoryAction> = FactoryResults[A] & {
	repository: RepositoryIdentity; revision: number;
	storage?: { encoding: string; previousDocumentBytes: number | null; documentBytes: number; fileSizeMayNotShrink: boolean };
};

export type ApplyFactoryEvent = <A extends FactoryAction>(
	state: FactoryState, event: FactoryEvent<A>, options?: { historical?: boolean },
) => FactoryResults[A];
