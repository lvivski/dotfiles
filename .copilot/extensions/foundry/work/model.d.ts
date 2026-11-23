export type Json = null | boolean | number | string | Json[] | {
	[key: string]: Json;
};

export interface Output {
	id: string;
	directory: string;
	revision?: string;
	check: string;
	needs: string[];
}

export interface Grain extends Output {
	specification: string;
	boundary: string[];
	task?: string;
	agent?: string;
}

export interface Proposal extends Output {
	task: string;
}

interface Charter {
	id: string;
	charter: string;
	agent?: string;
}

export interface Area extends Charter {
	researchAgent?: string;
	areas: string[];
	boundary: string[];
	checks: string[];
}

export type Squad = Area | (Charter & { grains: string[] });

export interface Policy {
	id: string;
	direction: string;
	target: string;
	source: string;
	sharedBrief?: string;
	base: string;
	productCheck: string;
	goalCheck?: string;
	files: string[];
	squads: Squad[];
	workers?: number;
	assignments?: number;
	repairs: number;
	deadline?: string;
	seed?: string[];
}

export interface Observation {
	outcome: "regenerate" | "no-gap" | "unresolved" | "needs-decision" | "waiting" | "needs-evidence" | "needs-research" | "researched";
	ownerInput?: "product-choice" | "external-action";
	reason: string;
	evidence: string[];
	grains: (string | Proposal)[];
	replace?: string[];
	addresses?: { id: string; grain: string; worker?: string }[];
	waitFor?: string;
	file?: string;
	receipt?: string;
	detail?: string;
	offset?: number;
	match?: string;
	findings?: Finding[];
	references?: Reference[];
}

export interface Finding { kind: string; source: string; finding: string }
export interface Reference { repo: string; revision: string }

export interface Artifact {
	file: string;
	blob: string;
	publisher: string;
	base: string;
	to: string[];
}

export type Packet = { review: string; base: string; files: Record<string, string>; outputs: Record<string, string>; partial: boolean;
	sources?: string[];
	read?: { source: string; start: number; end: number; length: number; hit?: number; miss?: true };
	excerpt?: { path: string; oid: string; start: number; end: number; length: number } };

export interface Node {
	grain: Grain;
	review?: string;
	state: "idle" | "waiting" | "writing" | "checking" | "published" | "qualified" | "repeated" | "blocked";
	token?: string;
	worker?: string;
	generation?: string;
	inputs?: Record<string, string>;
	base?: string;
	priorSource?: Baseline;
	replaces?: string;
	artifactCursor?: number;
	preview?: string;
	candidate?: string;
	check?: string;
	repairs: number;
	reason?: string;
	stop?: { kind: "writer-missing-input"; detail: string };
}

export interface Assessment {
	target: string;
	commit: string;
	check: string;
}

export interface Product extends Assessment {
	outputs: Record<string, string>;
	qualifiedAt?: number;
}

export interface ReviewNote {
	receipt: string;
	question: string;
	excerpt?: string;
}

export interface Review extends Dispatch {
	kind: "scout";
	tool: "workflow";
	state: "ready" | "issued" | "uncertain" | "suspended" | "reported" | "observed" | "blocked" | "deferred";
	squad: string;
	base: string;
	version: string;
	packet?: Packet;
	wake?: { review: string; key: string };
	retryOf?: string;
	iteration?: { receipt: string; directory: string; blob: string; question: string; basis?: "checkpoint" };
	diagnostic?: { receipt: string; excerpt: string };
	note?: ReviewNote;
	otherNotes?: ReviewNote[];
	predecessor?: Node;
	observation?: Observation;
	deferred?: { pins: Record<string, string>; consumers: string[] };
	decision?: { status: "presenting"; presentation?: string } | { status: "dismissed" } | { status: "answered"; answer: string }
		| { status: "unavailable"; reason: string; presentation?: string };
}

export type BlockerSignal = { id: string; directory: string } & ({ blocked: number } | { passed: true });
export interface Attribution { receipt: string; id: string; directory: string; blocked: number; excerpt: string }

export interface Receipt {
	commit: string;
	check: string;
	evaluatorRevision?: string;
	exit: number | null;
	output: string;
	feedback?: string;
	feedbackFile?: { blob: string; legacy?: boolean };
	failure?: "changed-export" | "incomplete";
	repair?: string;
	squad?: string;
	blockers?: BlockerSignal[];
}

interface Dispatch {
	id: string;
	issuer: string;
	grain?: string;
	token?: string;
	args: {
		[key: string]: Json;
	};
	callId?: string;
	nativeId?: string;
	boundAt?: number;
	workflowId?: string;
	error?: string;
	permissionHold?: string;
	commit?: string;
	check?: string;
	evaluatorRevision?: string;
	runnerStarted?: boolean;
	runnerClaim?: string;
	receipt?: Receipt;
}

export interface ArtifactReport {
	usedArtifacts?: string[];
	comparedArtifacts?: string[];
}

export interface Baseline {
	directory: string;
	revision: string;
	tree: string;
}

export interface NativeCall extends Dispatch, ArtifactReport {
	retirement?: { notification: string; read: string; completion: string };
	baseline?: Baseline;
	readGrant?: Baseline;
	claims?: { actor: string; path: string; start: string; kickoff: string; identity: string }[];
	claimedRequest?: string;
	kind: "writer" | "component" | "product" | "goal" | "repair" | "decision" | "handoff" | "artifact" | "escalation";
	inlineRepair?: string;
	tool: "create_session" | "bash" | "send_session_message" | "session.send";
	state: "ready" | "issued" | "uncertain" | "ordinary" | "done" | "refused" | "retired";
}

export type Effect = NativeCall | Review;

export interface Run {
	id: string;
	owner: string;
	references?: Record<string, string>;
	artifacts?: Artifact[];
	pendingReviewNotes?: (ReviewNote & { squad: string; after: number })[];
	attributions?: Attribution[];
	repins?: { from: string; revision: string; files: string[] }[];
	policy: Policy;
	scheduling?: { revision: number; workers?: number; checkpointReviews: boolean };
	activatedAt: number;
	active: boolean;
	pauseReason?: string;
	nodes: Record<string, Node>;
	effects: Effect[];
	products: Product[];
	join?: Product;
	goal?: Assessment & { stall?: string; tried?: string[] };
	blocker?: string;
	conflict?: string;
	discoveryError?: string;
}
