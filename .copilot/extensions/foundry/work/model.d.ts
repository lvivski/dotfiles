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
export interface Direction {
	revision: number;
	outcomes: { id: string; title: string; priority: number; success: string }[];
	nonGoals: string[];
	constraints: string[];
}
export interface DirectionRecord extends Direction {
	id: string;
	factoryId: string;
	direction: Direction;
	source: string;
}
export interface Squad {
	id: string;
	factoryId: string;
	name: string;
	goalId: string;
	taskId: string;
	outcomes: string[];
	templates: string[];
	scope: Scope;
	discoveryLimit: number;
	questions: number;
	generation: number;
	handled: number;
	reason: string;
	revision: number;
}
export interface BacklogItem {
	id: string;
	factoryId: string;
	squad: string;
	outcome: string;
	gapKey: string;
	kind: "gap" | "question" | "advisory";
	state: "proposal" | "queued" | "pulled" | "accepted" | "retired";
	revision: number;
	currentRevision: number;
	template: string;
	title: string;
	gap: string;
	improvement: string;
	stop: string;
	evidence: Json[];
	observations: Json[];
	scope: Scope;
	dependencies: string[];
	sources: Record<string, string>;
	owner: string;
	createdAt: string;
	severity: number;
	cost: number;
	predecessor?: string;
	reason?: string;
	goalId?: string;
	resultId?: string;
	capacityReleased: boolean;
	splits: { id: string; hash: string; plan: Json; taskIds: string[] }[];
}
export interface ProductRule {
	consumer: string;
	producer: string;
	output: string;
}
export interface BacklogView {
	directions: DirectionRecord[];
	squads: (Squad & {
		owner: string;
		bound: boolean;
		activation: number;
		active: boolean;
		requiredProducts: (ProductRule & { sources: { itemId: string; title: string; state: BacklogItem["state"]; resultId?: string }[] })[];
		pinned?: FactoryControl["pin"];
		knowledgeFiles: Record<string, unknown>[];
		readyItems: string[];
		pullable: boolean;
		needsDiscovery: boolean;
		dispatch: boolean;
	})[];
	items: BacklogItem[];
}
export interface Check {
	id: string;
	origin: "user" | "contract" | "standing" | "derived";
	requirement: string;
	kind: "command" | "artifact" | "judgment";
	version: string;
	command: string;
	oracleFiles?: { path: string; sha256: string }[];
	oracleCommit?: string;
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
export interface PinnedInput extends Input {
	version: string;
}
export interface DispatchCall {
	taskId: string;
	attemptId: string;
	token: string;
	effectId: string;
	tool: "create_session";
	arguments: Json;
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
	pin?: { schema: number; engine: string; policy: string };
	owner: string;
	state: "active" | "paused";
	generation: number;
	mechanism: "native" | "stop-hook";
	source: { reference: string; sha256: string };
	definition: Json;
	maximumJobs: number;
	blocks?: number;
	settingOrigins?: {
		maximumJobs: "policy" | "default";
		blocks?: "policy" | "default";
	};
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
export interface CompletionStatus {
	goalId: string;
	factoryId: string;
	taskId: string;
	delivered: boolean;
	settled: boolean;
	cancelled: boolean;
	closed: boolean;
	revision: number;
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
export interface Unit {
	id: string;
	goalId: string;
	name: string;
	owner: string;
	context: string[];
	parentId?: string;
	taskId?: string;
	kind?: string;
	coordinatorTaskId?: string;
}
export interface Coordination {
	generation: number;
	handled: number;
	causes: string[];
	escalated?: number;
	disposition?: { generation: number; reason: string; relatedIds: string[] };
}
export interface Collaboration {
	id: string;
	goalId: string;
	destinationGoalId: string;
	sourceTaskId: string;
	destinationTaskId: string;
	consumerTaskId: string;
	sourceOwner: string;
	sourceVersion: number;
	destinationVersion: number;
	consumerVersion: number;
	title: string;
	output: string;
	required: boolean;
	revision: number;
	state: "proposed" | "accepted" | "blocked" | "fulfilled" | "declined" | "cancelled";
	proposal: string;
	lastAction?: string;
	producerTaskId?: string;
	delivery?: Input;
	bound: boolean;
	reason?: string;
}
export type TaskState = "ready" | "running" | "waiting" | "blocked" | "failed" | "done" | "cancelled";
export interface Task {
	id: string;
	createdAt?: string;
	deliverable?: string;
	goalId: string;
	parentId?: string;
	unitId?: string;
	role: "producer" | "coordinator";
	coordination?: Coordination;
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
	waiting?: { kind: "children" | "input" | "capacity" | "factory" | "events"; requestId?: string; reason: string; cause?: "paused" | "stalled" };
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
	supersededBy?: string;
	baseCommit?: string;
	startCommit?: string;
	executionDirectory?: string;
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
	blocker?: "input-artifact" | "oracle-input";
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
	retry?: { generation: number; failures: number; after?: string; reason: string };
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
	kind: "create" | "command" | "stop" | "archive";
	state: "prepared" | "issued" | "settled" | "uncertain";
	owner: string;
	request: Json;
	assignment?: string;
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
	unitId?: string;
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
	lanes?: { taskId: string; owner: string; reason: string; next: string }[];
	deliveries?: Delivery[];
	products?: import("./landing.mjs").ProductStatus[];
	landingCapability?: "guarded-native-lease" | "unsupported";
	backlog?: BacklogView;
	goals: Goal[];
	units: Unit[];
	collaborations: Collaboration[];
	tasks: Task[];
	attempts: Attempt[];
	wakes: Wake[];
	effects: Effect[];
	claims: Claim[];
	signals: Signal[];
	lessons: Lesson[];
	factories?: FactoryControl[];
	completions?: CompletionStatus[];
}
