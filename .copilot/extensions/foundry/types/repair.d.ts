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
export type RepairLaunch = { name: "plan-repair"; args: { preparationId: string; preparationDigest: string } };
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
};
