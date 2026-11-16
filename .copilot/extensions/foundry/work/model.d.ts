export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Mode = "autopilot" | "interactive";
export interface Scope {
	mode: Mode;
	delegation: boolean;
	workTypes: string[];
	paths: string[];
	restrictions: string[];
}
export interface Limits {
	workers?: number;
	credits?: number;
	deadline?: string;
	repairs?: number;
}
export interface Check {
	id: string;
	origin: "user" | "contract" | "standing" | "derived";
	requirement: string;
	kind: "command" | "artifact" | "judgment";
	version: string;
	command: string;
	oracleFiles?: { path: string; sha256: string }[];
	artifactFiles?: string[];
	path?: string;
}
export interface Candidate {
	reference: string;
	version: string;
	files: { path: string; sha256: string; mode: number }[];
}
export interface Output {
	name: string;
	kind: "code" | "analysis" | "design" | "review" | "measurement" | "artifact";
	reference: string;
	version: string;
}
export interface Input {
	taskId: string;
	output: string;
	version?: string;
}
export interface Goal {
	id: string;
	title: string;
	owner: string;
	projectId?: string;
	scope: Scope;
	limits: Limits;
	credits: number;
	createdAt: string;
	source?: { reference: string; sha256: string };
}
export interface FactoryControl {
	id: string;
	owner: string;
	state: "active" | "paused";
	generation: number;
	mechanism: "native" | "stop-hook";
	source: { reference: string; sha256: string };
	definition: Json;
	maximumJobs: number;
	blocks: number;
	unchangedFailures?: number;
	aggregateRepairs?: number;
	pausedWorkers: string[];
	reminders: Record<string, { marker: string; count: number; generation: number }>;
	heartbeat?: {
		state: "issued" | "bound" | "uncertain";
		generation: number;
		request: { interval: "minutes"; every_minutes: number; prompt: string };
		id?: string;
		receipt?: Json;
	};
	sourceCursor?: string;
	reason?: string;
}
export interface GoalCompletion {
	id: string;
	goalId: string;
	owner: string;
	taskId: string;
	factoryId: string;
	revision: number;
	closed: boolean;
	requiredInputs: Input[];
	repairs: number;
	accepted?: { revision: number; tasks: { id: string; version: number; inputs: Input[] }[] };
}
export interface UsageAffinity {
	id: string;
	groupId: string;
	startedAt: string;
	nativeId: string;
	attemptIds: string[];
	token?: string;
}
export interface NativeUsage {
	id: string;
	nativeId: string;
	sourceSessionId: string;
	sequence?: number;
	aliases: string[];
	attemptIds: string[];
	token?: string;
	credits?: number;
	debitedCredits?: number;
	billing: "complete" | "partial" | "unavailable";
	attemptId?: string;
	goalId?: string;
}
export interface Team {
	id: string;
	goalId: string;
	name: string;
	owner: string;
	context: string[];
}
export type TaskState = "ready" | "running" | "waiting" | "blocked" | "failed" | "done" | "cancelled";
export interface Task {
	id: string;
	goalId: string;
	parentId?: string;
	teamId?: string;
	owner: string;
	title: string;
	assignment: string;
	dispatch?: { context: string[]; generator: boolean; agent?: string; baseBranch?: string };
	workType: string;
	scope: Scope;
	checks: Check[];
	inputs: Input[];
	outputs: Output[];
	state: TaskState;
	currentAttemptId?: string;
	version: number;
	repairs?: number;
	repairReservation?: { attemptId: string; worker: string };
	waiting?: { kind: "children" | "input" | "capacity" | "factory"; requestId?: string; reason: string; cause?: "paused" | "stalled" };
}
export interface Attempt {
	id: string;
	taskId: string;
	token: string;
	creator: string;
	nativeId?: string;
	state: "prepared" | "issued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "uncertain";
	taskVersion: number;
	checks: Check[];
	inputs: Input[];
	slot: boolean;
	createdAt: string;
	repairOf?: string;
	assignedOwner?: string;
	endedBy?: string;
	waiting?: Task["waiting"];
}
export interface Evidence {
	id: string;
	attemptId: string;
	checkId: string;
	checkVersion: string;
	outcome: "passed" | "failed" | "pending";
	reference: string;
	summary: string;
	source: "runner-receipt";
	candidate?: Candidate;
	blocker?: "input-artifact";
}
export interface Finding {
	summary: string;
	checkId?: string;
	obligation?: "regression" | "crash" | "data-loss" | "security" | "interface";
	expected?: string;
	observed?: string;
	evidenceIds: string[];
}
export interface Result {
	id: string;
	attemptId: string;
	sender: string;
	reportedBy?: string;
	state: "done" | "failed" | "blocked";
	summary: string;
	outputs: Output[];
	evidence: Evidence[];
	findings: Finding[];
	createdAt: string;
}
export interface Wake {
	id: string;
	owner: string;
	goalId: string;
	generation: number;
	consumed: number;
	reason: string;
	relatedReasons?: string[];
	sent?: number;
	inFlight?: string;
	unavailable?: { effectId: string; generation: number; fallback: string; message: string };
}
export interface Delivery {
	id: string;
	goalId: string;
	wakeId: string;
	generation: number;
	owner: string;
	attemptId?: string;
	state: "issued" | "settled";
	request: Json;
	result?: Json;
}
export interface Effect {
	id: string;
	attemptId: string;
	kind: "create" | "command" | "stop";
	state: "prepared" | "issued" | "settled" | "uncertain";
	owner: string;
	request: Json;
	result?: Json;
	relatedAttemptIds?: string[];
	factoryGeneration?: number;
}
export interface Claim {
	id: string;
	attemptId: string;
	surface: string;
	resource: string;
}
export interface Signal {
	id: string;
	goalId: string;
	taskId?: string;
	teamId?: string;
	kind: string;
	summary: string;
	references: string[];
}
export interface Lesson {
	id: string;
	goalId: string;
	workType: string;
	summary: string;
	references: string[];
}
export interface Snapshot {
	goals: Goal[];
	teams: Team[];
	tasks: Task[];
	attempts: Attempt[];
	wakes: Wake[];
	effects: Effect[];
	claims: Claim[];
	signals: Signal[];
	lessons: Lesson[];
	factories?: FactoryControl[];
	completions?: { goalId: string; factoryId: string; delivered: boolean; settled: boolean; closed: boolean; revision: number }[];
}
