import type { KnowledgeRef, Outcome, Trust } from "./factory.js";

export type DeliveryRequirement = "branch" | "commit" | "pr";
export type TaskKind = "implement" | "verify";

export type ClockValue = Date | string | number;

export type ConceptualReview = { proposals: string[]; gaps: string[] };

export type Repository = { workingDirectory: string; baseBranch: string };

export type ChangeEvent = { workspacePath: string; planId: string; revision: number };

export type PlanStatus = "draft" | "awaiting-approval" | "approved" | "running"
	| "awaiting-completion-approval" | "cancelling" | "completed" | "cancelled" | "failed";

export type TaskStatus = "planned" | "ready" | "running" | "done" | "blocked" | "failed" | "cancelled";

export type AttemptStatus = "reserved" | "running" | "done" | "blocked" | "failed" | "cancel-requested" | "cancelled";

export type EvidenceType = "command" | "test" | "integration" | "commit" | "pr" | "session" | "artifact" | "manual";

export type EvidenceOutcome = "passed" | "failed" | "informational";

export type EvidenceFields = { type: EvidenceType; summary: string; source: string | null; outcome: EvidenceOutcome };

export type EvidenceInput = Omit<EvidenceFields, "source" | "outcome"> & {
	source?: string | null; outcome?: EvidenceOutcome; checkId?: string | null;
};

export type FoundryEvidence = EvidenceFields & { id: string; producer: string; checkId: string | null; trust: Trust };

export type IntegrationEntry = { taskId: string; attemptId: string; branch: string | null; commit: string | null; prUrl: string | null };

export type ScopeOverride = { approvedBy: string; reason: string };

export type Learning = { kind: "observation" | "inference" | "proposal"; statement: string; uncertainty?: string | null };

export type EvaluationReport = {
	evaluation: KnowledgeRef; procedureDigest: string; environment: string; workload: string;
	outcome: Outcome; report: string; independenceReason: string;
};

export type FoundryAttempt = {
	id: string; reservationId: string; status: AttemptStatus; baseBranch: string;
	integrationRequired: IntegrationEntry[]; scopeOverride: ScopeOverride | null;
	sessionId: string | null; branch: string | null; commit: string | null; prUrl: string | null;
	resultSummary: string | null; evidence: FoundryEvidence[]; learning?: Learning[];
	factoryEvaluations?: EvaluationReport[]; error: string | null; reservedAt: string;
	startedAt: string | null; sessionTerminatedAt: string | null;
	cancelRequestedAt: string | null; completedAt: string | null;
};

export type BlueprintTask = {
	id: string; title: string; kind: TaskKind; description: string; dependsOn: string[];
	acceptanceCriteria: string[]; expectedFiles: string[]; deliveryRequirement: DeliveryRequirement;
};

export type FoundryTask = BlueprintTask & { status: TaskStatus; attempts: FoundryAttempt[] };

export type EvaluationTarget = { candidateId: string; commit: string; criteria: string[]; evaluations: KnowledgeRef[] };

export type PlanBlueprint = {
	title: string; objective: string; constraints: string[]; tasks: BlueprintTask[]; evaluationTarget?: EvaluationTarget;
};

export type PlanFactoryBinding = {
	repositoryId: string; unitId: string; unitRevision: number; candidateId: string | null;
	contractRevision: number | null; contractDigest: string | null; contextDigest: string | null;
	blueprintDigest: string; owner: string; purpose?: "generation" | "evaluation";
};

export type Planning = { runId: string; inputDigest: string; conceptualReview?: ConceptualReview };

export type VerificationReplacement = {
	supersededReservationId: string; supersededRunId: string | null;
	reason: string; requestedBy: string; at: string;
};

export type Verification = {
	status: "not-started" | "reserved" | "passed" | "failed"; reservationId: string | null;
	runId: string | null; inputDigest: string | null; summary: string | null; evidence: string[];
	missingEvidence: string[]; correctionTaskIds: string[]; replacement: VerificationReplacement | null;
	reservedAt: string | null; completedAt: string | null; conceptualReview?: ConceptualReview;
};

export type CancellationDisposition = {
	attemptId: string; disposition: "session-terminated" | "no-session-created"; sessionId?: string | null;
};

export type FinalizationOverride = { reason: string; attestedBy: string };

export type Cancellation = {
	requestId: string; reason: string; requestedBy: string; requestedAt: string; requiredAttemptIds: string[];
	verificationReservationId: string | null; verificationRunId: string | null;
	acknowledgements: (CancellationDisposition & { sessionId: string | null; acknowledgedBy: string; acknowledgedAt: string })[];
	verificationDisposition: "run-terminated" | "no-run-created" | null;
	finalizationOverride: FinalizationOverride | null; verificationTerminatedAt: string | null;
	finalizedBy: string | null; finalizedAt: string | null;
};

export type FoundryActivity = {
	event: string; at: string; revision: number; actor?: string; verificationRunId?: string;
};

export type FoundryPlan = {
	revision: number; id: string; title: string; objective: string; constraints: string[]; status: PlanStatus;
	repository: Repository; planning: Planning | null; factory?: PlanFactoryBinding | null;
	evaluationTarget?: EvaluationTarget | null;
	/** Persisted JSON is validated as a frozen context by analysis before use. */
	factoryVerification?: Record<string, unknown> | null;
	tasks: FoundryTask[];
	gates: { planApprovedAt: string | null; planApprovedBy: string | null; completionApprovedAt: string | null; completionApprovedBy: string | null };
	verification: Verification; cancellation: Cancellation | null; activity: FoundryActivity[];
	createdAt: string; updatedAt: string;
};

export type ProjectionAction = {
	kind: string; taskId?: string; taskIds?: string[]; attemptId?: string;
	sessionId?: string | null; sessionState?: string; baseBranch?: string;
	reason?: string; candidateId?: string; recommendedTools?: string[];
	reservationId?: string | null; runId?: string; requiredAttemptIds?: string[];
	verificationRunId?: string | null; evaluations?: KnowledgeRef[];
};

export type PlanProjection = {
	planId: string; revision: number; status: PlanStatus;
	progress: { total: number; done: number; percent: number; byStatus: Record<string, number>; attempts: number };
	activeAttempts: {
		taskId: string; attemptId: string; status: AttemptStatus; sessionId: string | null;
		sessionState: string; baseBranch: string; integrationRequired: IntegrationEntry[];
		reservedAt: string; startedAt: string | null; staleReservation: boolean;
	}[];
	dependencyWaits: { taskId: string; dependencies: { taskId: string; status: TaskStatus }[] }[];
	scheduling: {
		readyTaskIds: string[]; dispatchableTaskIds: string[]; heldTaskIds: string[]; occupiedTaskIds: string[];
		scopeConflicts: { taskIds: [string, string]; reason: string }[];
		launches: { taskId: string; launch: { baseBranch: string; dependencies: IntegrationEntry[]; integrationRequired: IntegrationEntry[] } }[];
	};
	sessionInventory: { supplied: boolean; complete: boolean; capturedAt: string | null };
	actions: ProjectionAction[]; nextAction: ProjectionAction;
	factoryHold?: { code: string; reason: string; blocksAllExecution: boolean };
};
