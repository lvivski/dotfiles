import type { PlanningArgs } from "../analysis/planning.mjs";
import type { JsonObject, JsonValue } from "./json.js";

export type PlanningCritique = { verdict: "accept" | "revise"; risks: string[]; requiredChanges: string[] };
export type PlanningVerdict = { passed: boolean; issues: string[] };
export type RepairMaterial = {
	input: PlanningArgs;
	candidate: JsonValue;
	critiques: [PlanningCritique, PlanningCritique];
	diagnostics: string[];
	verification: PlanningVerdict | null;
	decomposition: JsonValue;
	stage: "structural" | "semantic";
};
export type RepairPreparation = {
	format: "foundry-plan-repair-v1";
	id: string;
	digest: string;
	owner: string;
	sessionId: string;
	rootRunId: string;
	inputDigest: string;
	sourceDigest: string;
	mode: "inline" | "recovery";
	repositoryPath: string | null;
	authority: JsonObject | null;
	source: JsonObject | null;
	material: RepairMaterial;
};
export type RepairCandidate = { candidate: JsonValue; issue: string | null };
export type RepairState = "prepared" | "intent" | "admitted" | "executing" | "completed" | "denied" | "unavailable" | "uncertain";
export type RepairRecord = {
	preparation: RepairPreparation;
	state: RepairState;
	runId: string | null;
	candidate: RepairCandidate | null;
	result: JsonObject | null;
};
export type RepairSource = {
	runId: string;
	inputDigest: string;
	resultDigest: string;
	result: JsonObject;
	material: RepairMaterial;
	native: JsonObject;
};
export type RepairLaunch = { name: "plan-repair"; args: { preparationId: string; preparationDigest: string; effectId?: string } };
export type RepairSession = Pick<import("@github/copilot-sdk").CopilotSession, "sessionId" | "workspacePath"> & {
	rpc?: { tools?: { execute: (input: { name: string; arguments: JsonValue }) => Promise<unknown> } };
};
export type RepairOutcome = {
	plan: JsonObject;
	verification: PlanningVerdict | null;
	synthesisRepair: {
		original: JsonValue; diagnostic: string; candidate: JsonValue; issue: string | null;
		stage: "structural" | "semantic"; originalVerification: PlanningVerdict | null;
	};
	issues: string[];
	repairBudget: { rootRunId: string; used: true; preparationId: string; preparationDigest: string };
	recovery?: JsonObject;
};

export type RepairIdentity = { agentId: string; toolCallId: string; runId: string };
export type RepairEvidence = {
	id: string; digest: string; evaluatorId: string; inputDigest: string;
	producer: RepairIdentity; causalFor: string[];
};
export type RepairComparisonState = {
	format: "foundry-repair-comparison-v1"; protected: JsonObject;
	candidateDigest: string; diagnosticsDigest: string;
	obligations: {
		id: string; evaluatorId: string; evaluatorDigest: string; inputDigest: string;
		status: "unresolved" | "supported" | "uncertain"; evidence: RepairEvidence[];
	}[];
	contributors: RepairIdentity[];
	reviewer: RepairIdentity;
};
export type RepairEffect = {
	format: "foundry-repair-effect-v1"; id: string; kind: "launch" | "author" | "review";
	preparationId: string; preparationDigest: string; rootRunId: string; inputDigest: string;
	sourceDigest: string; authority: JsonObject | null; historyDigest: string;
	candidate: JsonValue; diagnostics: JsonValue; contributors: RepairIdentity[];
	runId: string | null; operation: JsonObject;
};
export type RepairEffectReview = {
	effectDigest: string; passed: boolean; issues: string[]; targets: string[];
	reviewer: RepairIdentity; evidence: RepairEvidence[];
};
export type RepairAdmissionReceipt = {
	effectDigest: string; disposition: "admitted" | "denied" | "unavailable" | "uncertain";
	transactionId: string; nativeRunId: string; consumed: boolean;
	checks: {
		authority: boolean; revision: boolean; approval: boolean; revocation: boolean;
		cancellation: boolean; provider: boolean; resources: boolean; budgets: boolean;
	};
	resourceClaims: JsonObject; budgetClaims: JsonObject;
	contributors: RepairIdentity[];
	output?: JsonValue;
};
/**
 * Trusted constructor wiring only. admit must atomically revalidate current authority,
 * revision, approval/revocation, cancellation, provider and applicable explicit budgets/
 * resources, durably claim/consume and enqueue once at the native transaction boundary.
 * A local outbox, tools.execute or an agent claim cannot implement this capability.
 * Matching reconciliation never enqueues again; uncertain consumption remains fenced.
 */
export type RepairHostPort = {
	prepare(preparation: RepairPreparation): Promise<unknown>;
	propose?(preparation: RepairPreparation, history: unknown[], continuationOf: string, context?: JsonObject): Promise<unknown>;
	review(effect: RepairEffect, history: unknown[]): Promise<unknown>;
	admit(effect: RepairEffect, review: RepairEffectReview, invoke: () => Promise<unknown>, signal?: AbortSignal): Promise<unknown>;
	reconcile(effect: RepairEffect): Promise<unknown>;
	authenticate(evidence: unknown): Promise<boolean>;
	observeCandidate(preparation: RepairPreparation, candidate: JsonValue, verdict: JsonValue, history: unknown[], receipts: JsonValue[], diagnostics: JsonValue): Promise<unknown>;
};
