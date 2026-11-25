export type Json = null | boolean | number | string | Json[] | {
	[key: string]: Json;
};

export interface FileScope { primary: string; files: string[] }
export interface Transfer { from: string; candidate: string; to: string }
export interface Successor { from: string; check: string; to: string }
export interface Restoration { from: string; historical: string; checkpoint: string; goal: string; retainer: string; tree: string }
export interface Observer { pair: string; file: string; before: string; after?: string; previous?: {check:string; candidate:string; phases:string[]} }
export interface Production { diagnostic:string; candidate:string; checkpoint:string; goal:string; files:string[]; task:string; prior:Node }
export interface Pairing { failed: string; component: string; candidate: string; retainer: string; checkpoint: string; goal: string; target: string; tree: string }
export interface Footnote { file:string; blob:string; excerpt:string; inventory:{file:string; keys:string[]; blob:string}; inputs:string[]; reason:string }
export interface Footprint { component:string; commit:string; stages:Record<"component"|"generated"|"package"|"runtime",Footnote[]> }
export interface Subset {
	observer:string; checkpoint:string; goal:string; target:string; assembly:string; basis:string;
	hold:{historical:string; grain:string; original:string; pair:string; retainer:string; candidate:string; component:string};
	ownership:NonNullable<Product["ownership"]>;
	selected:{grain:string; candidate:string; component:string}[]; evidence:Footprint[];
	product:string; assessment?:string;
}
export interface Retained extends FileScope { review: string; to: string }
export type Scope = string | string[] | FileScope;

export interface Output {
	id: string;
	directory: Scope;
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
	ownership?: "exact-files" | "retain-except-transferred";
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
	retained?: Retained[];
	successor?: { to: string; review: string; directory: Scope };
	restoration?: Restoration;
	review?: string;
	state: "idle" | "waiting" | "writing" | "checking" | "published" | "qualified" | "repeated" | "blocked";
	token?: string;
	worker?: string;
	generation?: string;
	inputs?: Record<string, string>;
	supporting?: string[]; // External read-only files actually named in this writer's brief, at review.base.
	excluded?: { path: string; revision: string } | { grain: string; revision: string };
	base?: string;
	priorSource?: Inventory;
	workspace?: string;
	reuse?: string;
	replaces?: string;
	artifactCursor?: number;
	preview?: string;
	candidate?: string;
	check?: string;
	repairs: number;
	reason?: string;
	stop?: { kind: "writer-missing-input" | "writer-cannot-repair" | "writer-relinquished"; detail: string };
}

export interface Assessment {
	target: string;
	commit: string;
	check: string;
}

export interface Product extends Assessment {
	outputs: Record<string, string>;
	ownership?: Record<string,{directories:string[];files:string[];exclude?:{directories:string[];files:string[]}}>;
	qualifiedAt?: number;
}

export interface ReviewNote {
	receipt: string;
	question: string;
	excerpt?: string;
}

export interface HistoricalStep {
	receipt: string;
	step: string;
}

export interface ProductCitation {
	commit: string;
	file: string;
	excerpt: string;
}

export type DiscoveryLead = { receipt: string; checkpoint: string; priorReview?: string } &
	({ missing: string; pending?: never } | { pending: string; missing?: never });

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
	retrySource?: string; // Pinned blob omitted from the original reported comparison.
	lead?: DiscoveryLead;
	iteration?: { receipt: string; directory: string; files?: string[]; transfer?: Transfer; successor?: Successor; blob: string; question: string; basis?: "checkpoint"; historical?: HistoricalStep & { missing: string }; source?: ProductCitation & { goal: string } };
	diagnostic?: { receipt: string; excerpt: string };
	note?: ReviewNote;
	otherNotes?: ReviewNote[];
	predecessor?: Node;
	correction?: { worker: string; clause: string; file: string; excerpt: string } &
		({blob:string; predecessorCheck?:never} | {predecessorCheck:string; blob?:never});
	observation?: Observation;
	deferred?: { pins: Record<string, string>; consumers: string[] };
	decision?: { status: "presenting"; presentation?: string } | { status: "dismissed" } | { status: "answered"; answer: string }
		| { status: "unavailable"; reason: string; presentation?: string };
}

export type BlockerSignal = { id: string; directory: string } & ({ blocked: number } | { passed: true });
export interface Attribution { receipt: string; id: string; directory: string; blocked: number; excerpt: string }

export interface Receipt {
	completedAt?: number;
	commit: string;
	check: string;
	evaluatorRevision?: string;
	productEvaluatorRevision?: string;
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
	productEvaluatorRevision?: string;
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
export type Inventory = Baseline | Baseline[];

export interface NativeCall extends Dispatch, ArtifactReport {
	production?:Production;
	remedy?:{writer:string; basis:string};
	isolation?:string;
	restoration?: Restoration;
	pair?: Pairing;
	observer?: Observer;
	launcherExit?: number;
	recheck?: { of:string; target:string; goalPin:string; productPin:string };
	finished?: {squad:string; directory:Scope; component:string; product:string};
	pooled?: {from:string; home:string; generation:string};
	reuse?: CandidateReuse;
	retirement?: { notification: string; read: string; completion: string };
	baseline?: Inventory;
	readGrant?: Inventory;
	claims?: { actor: string; path: string; start: string; kickoff: string; identity: string }[];
	claimedRequest?: string;
	kind: "writer" | "component" | "product" | "goal" | "repair" | "decision" | "handoff" | "artifact" | "escalation";
	inlineRepair?: string;
	tool: "create_session" | "bash" | "send_session_message" | "session.send";
	state: "ready" | "issued" | "uncertain" | "ordinary" | "done" | "refused" | "retired" | "withdrawn";
}

export interface CandidateReuse {
	predecessor: Node;
	blob: string;
	checkpoint: string;
	goal: string;
}

export type Effect = NativeCall | Review;

export interface Run {
	independent?:Subset;
	id: string;
	owner: string;
	references?: Record<string, string>;
	artifacts?: Artifact[];
	pendingReviewNotes?: (ReviewNote & { squad: string; after: number })[];
	attributions?: Attribution[];
	repins?: { from: string; revision: string; files: string[] }[];
	productRepins?: { from: string; revision: string; files: string[]; checkpoint: string; goal: string; recheck: string; ownership?: "retain-except-transferred" }[];
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
