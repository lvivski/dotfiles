import type { VerificationOutcome } from "./analysis.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { ConceptualReview, FoundryPlan, PlanBlueprint } from "./plan.js";

export type DiscoveredRun = Pick<import("@github/copilot-sdk").WorkflowRunSummary, "runId">
	& Partial<Omit<import("@github/copilot-sdk").WorkflowRunSummary, "runId" | "status">> & { status?: string };

export type WorkflowDiscovery =
	| { state: "absent" }
	| { state: "found"; run: DiscoveredRun; duplicates?: [] }
	| {
		state: "inconclusive"; reason: string;
		candidates?: (DiscoveredRun & { reason?: string })[];
		unattributable?: (DiscoveredRun & { reason?: string })[]
	};

export type WorkflowPreparation = { workflow: string; inputDigest: string; launchSpec: { name: string; args: JsonValue } };

/** The application consumes this port, not unneeded native observations or SDK class internals. */
export type WorkflowAnalysisPort = {
	preparePlanning(input: unknown): Promise<WorkflowPreparation>;
	importPlanning(runId: string, options?: { signal?: AbortSignal }): Promise<{
		runId: string; inputDigest: string; plan: PlanBlueprint; factoryContext?: JsonObject; conceptualReview?: ConceptualReview;
	}>;
	prepareVerification(plan: FoundryPlan, reservationId: string): Promise<WorkflowPreparation>;
	importVerification(runId: string, plan: FoundryPlan, options?: { signal?: AbortSignal; wait?: boolean }): Promise<{
		detail: { completedAt: number | null }; result: VerificationOutcome;
	}>;
	discoverVerificationRun(reservationId: string, reservedAt: string): Promise<WorkflowDiscovery>;
	assessVerificationRun(runId: string, plan: FoundryPlan): Promise<{ state: "paused" | "active" | "importable" | "terminal-nonimportable" }>;
	cancelVerificationRun(runId: string): Promise<{ runId: string; status: import("@github/copilot-sdk").WorkflowRunStatus; alreadyTerminal: boolean }>;
	verificationRunIsTerminal(runId: string): Promise<boolean>;
	inspectWorkflow(runId: string): Promise<import("@github/copilot-sdk").WorkflowRunDetail>;
	isMissingWorkflowRun(error: unknown): boolean;
	isTerminalWorkflowStatus(status: import("@github/copilot-sdk").WorkflowRunStatus): boolean;
	getWorkflowProgress(runId: string, beforeSeq: number): Promise<import("@github/copilot-sdk").WorkflowProgressPage>;
	listWorkflowRuns(): Promise<import("@github/copilot-sdk").WorkflowRunsPage>;
	controlWorkflow(runId: string, action: "pause" | "resume", options?: { signal?: AbortSignal }): Promise<import("@github/copilot-sdk").WorkflowRunResult>;
	importAnalysis(runId: string): Promise<{ report: string; workflowName: string; completedAt: number; runId: string }>;
};
