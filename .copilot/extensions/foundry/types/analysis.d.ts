import type { CapabilityUnit, EvaluationDefinition, EvaluationEvidence, FactoryContract, KnowledgeRef, Observation, Provenance } from "./factory.js";
import type { ConceptualReview, DeliveryRequirement, EvaluationReport, EvaluationTarget, FoundryEvidence, IntegrationEntry, PlanFactoryBinding } from "./plan.js";

export type FrozenFactoryContext = {
	version: 1;
	/** Only fields checked at the frozen-input boundary are exposed to analysis. */
	definitions: {
		unit: Pick<CapabilityUnit, "id" | "revision" | "name" | "purpose" | "boundary" | "dependencies" | "visualEvaluation">;
		visualEvaluation?: KnowledgeRef & { statement: string; evaluation: EvaluationDefinition };
		obligations: (KnowledgeRef & { kind: "obligation"; unitId: string; authority: "accepted"; statement: string })[];
		evaluations: (KnowledgeRef & { kind: "evaluation"; unitId: string; authority: "accepted"; statement: string; evaluation: EvaluationDefinition })[];
		rationale: (KnowledgeRef & { authority: "non-governing"; statement: string })[];
		contract: Pick<FactoryContract, "digest" | "unitId" | "revision" | "unitRevision" | "obligations" | "evaluations"> | null;
	};
	humanEvidence: (Pick<EvaluationEvidence, "evaluation" | "candidateId" | "contractDigest" | "contextDigest"
		| "procedureDigest" | "outcome" | "report" | "reportDigest" | "trust" | "commit" | "environment" | "workload"> & {
			source: Pick<Provenance, "kind" | "actor" | "ref" | "at">; independence: { method: "human-review" };
		})[];
	observations?: Observation[];
};

export type VerificationOutcome = {
	passed: boolean; summary: string; evidence: string[]; missingEvidence: string[];
	correctionTaskIds: string[]; conceptualReview?: ConceptualReview;
};

export type VerificationTask = {
	id: string; attemptId: string; criteria: { id: string; text: string }[]; resultSummary: string | null;
	evidence: (FoundryEvidence & { attemptId: string })[];
	delivery: {
		requirement: DeliveryRequirement; baseBranch: string; branch: string | null;
		commit: string | null; prUrl: string | null; integrationRequired: IntegrationEntry[]
	};
};

export type VerificationReport = {
	taskId: string; attemptId: string; sessionId: string;
	target: { candidateId?: string; taskId: string | null; attemptId: string | null; branch: string | null; commit: string | null; prUrl: string | null };
	observedCommit: string | null; resultSummary: string | null; evidence: (FoundryEvidence & { attemptId: string })[];
};

export type VerificationFactory = { binding: PlanFactoryBinding; evaluations: EvaluationReport[]; context?: FrozenFactoryContext };

export type VerificationInput = {
	planId: string; objective: string; tasks: VerificationTask[]; verificationReport: VerificationReport;
	inputDigest: string; factory?: VerificationFactory; evaluationTarget?: EvaluationTarget;
};
