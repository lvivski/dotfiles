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
export type Footnote = { file:string; blob:string; excerpt:string; inputs:string[]; reason:string } &
	({inventory:{file:string;keys:string[];blob:string};literal?:never}|{literal:true;inventory?:never});
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
	prior?: "independent" | "unavailable" | { clause:string };
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
	contractTarget?: string;
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

export interface ReferenceSource {
	grain:string; file:string; assignment:string; review:string; worker:string; generation:string; grant:string; revision:string; component?:string;
}
export interface DependencyReference { source:ReferenceSource & {component:string}; pooled:string }
export interface CharterContinuation { file:string; from:string; to:string; target:string; productEvaluator:string; goalEvaluator:string }

export interface Artifact {
	source?:ReferenceSource & {consumer:string;receiver:string;request:string};
	assembly?:string; // The immutable join or unpublished rollout on which the owner offered this diff.
	evaluation?:{from:string;checkpoint:string;goal:string};
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
	state: "idle" | "waiting" | "writing" | "checking" | "reviewing" | "published" | "qualified" | "repeated" | "blocked";
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
	stop?: { kind: "writer-missing-input" | "writer-cannot-repair" | "writer-relinquished"; detail: string;
		input?: {blob:string; after:number; grant?:string; source?:ReferenceSource; hold?:string; decision?:"input"} };
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
	withdrawnHandoff?: { qualifiedAt?:number; goal:string; recheck:string };
}

export interface Inspection {
	id:string;
	component:string;
	grain:string;
	candidate:string;
	generation:string;
	base:string;
	scope:NonNullable<Product["ownership"]>[string];
	task:string;
	specification?:string;
	issuer:string;
	state:"ready"|"issued"|"approved"|"changes"|"unavailable";
	dispatch?:string;
	workflow?:string;
	summary?:string;
	permissionHold?:string;
	previous?:{issuer:string;dispatch:string;workflow:string;summary:string}[];
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

export type OwnerDecision = { status:"presenting"; presentation?:string; presenter?:{host:string;pid:number}; selected?:string } | { status:"dismissed" } | { status:"answered"; answer:string }
	| { status:"unavailable"; reason:string; presentation?:string };

export interface ReviewObstacle {kind:"missing-output"|"overlap"|"stale-review"|"outside-scope"|"repeated-output"|"displaced-input"|"other";subject?:string}
export interface Review extends Dispatch {
	obstacle?:ReviewObstacle;
	providerRecovery?: "needed"|"claimed";
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
	iteration?: { receipt: string; directory: string; files?: string[]; transfer?: Transfer; successor?: Successor; blob: string; question: string; basis?: "checkpoint"; historical?: HistoricalStep & { missing: string }; source?: ProductCitation & { goal: string }; follow?: true };
	renewal?: { checkpoint:string; goal:string; state:"needed"|"presenting"|"approved"|"held"|"closed"; reason?:string };
	diagnostic?: { receipt: string; excerpt: string };
	note?: ReviewNote;
	otherNotes?: ReviewNote[];
	predecessor?: Node;
	correction?: { worker: string; clause: string; file: string; excerpt: string } &
		({blob:string; predecessorCheck?:never; ordinary?:never} | {predecessorCheck:string; blob?:never; ordinary?:never} |
		{ordinary:true; blob?:never; predecessorCheck?:never; resumed?:{prior:Node; token:string}});
	observation?: Observation;
	deferred?: { pins: Record<string, string>; consumers: string[] };
	decision?: OwnerDecision;
}

export type BlockerSignal = { id: string; directory: string } & ({ blocked: number } | { passed: true });
export interface Attribution { receipt: string; id: string; directory: string; blocked: number; excerpt: string }

import type {Checker,VerificationInputs} from "../../../skills/foundry/scripts/recipe-types.js";
export type {VerificationInputs,VerificationScope,Checker} from "../../../skills/foundry/scripts/recipe-types.js";
export interface ComponentObservation {check:string;exit:number|null;inputs?:VerificationInputs;test?:string}
export interface Receipt {
	inputs?:VerificationInputs;
	test?:string; // Historical signed field; new observations use inputs.checker.
	control?:{assertion:string;matched:boolean};
	overlay?:string; // Historical digest only; new observations use inputs.overlay.
	resolutionDigest?:string;
	components?:Record<string,ComponentObservation>;
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

export interface Instruction {
	kind:"blocker"|"correction"|"read"|"observer"|"diagnosis"|"proposal"|"preview"|"footprint"|"subset"|"supply";
	assignment:string;
	source:string;
	evidence:string;
	step?:string;
}

export interface Diagnostic {
	id:string; kind:"observe"|"observer"|"production"|"footprint"; grain:string; assignment:string; attempt:string;
	check:string; checkpoint:string; goal:string; target:string; data:Record<string,Json>;
}
export type FootprintRequest = Pick<Subset,"target"|"checkpoint"|"goal"|"observer"|"selected"> & {id:string;checks:string[]};

/** A reservation binds a use and an ordered physical recipe, not a verdict. The prepared tree digest
 * belongs to the observation; before launch only the immutable build input and hook (or absence) are known. */
export interface CheckDescription {
	version:1;
	use:"component"|"attestation"|"historical-observation"|"calibration"|"product"|"goal"|"subset";
	grant:string;
	target:string;
	contract:string;
	evaluation:{kind:"component"}|{kind:"product",outputs:string[]}|{kind:"goal",squads:string[]};
	steps:{member:string|null,inputs:VerificationInputs,build:null|{commit:string,hook:Checker|null}}[];
	privateInput?:string;
	joined?:true;
	resolutions?:string;
}

export interface NativeCall extends Dispatch, ArtifactReport {
	verification?:CheckDescription;
	attempt?:{version:1;closure?:"never-issued"|"closed-before-runner-claim"} | {version:2;previous?:string};
	instruction?:Instruction;
	testPin?:string; // Stop whose certified observer this evaluation uses; never a production-tree substitution.
	calibration?:{stop:string;role:"oldGood"|"newGood"|"newBad";subject:string};
	lane?:string; // Digest of the exact scoped foreground retry, included in the runner signature.
	replacement?:string; // Exact operator-approved proposal; only its own component can carry this.
	rollout?:string;
	delivery?:string;
	rerun?: Rerun;
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
	baselineStop?:Node;
	continuation?:CharterContinuation;
	input?: {prior:Node; assignment:string; review:string; blob:string; target:string; goal:string; checkpoint?:string; requested:boolean; withdrawn?:string} &
		({offer:number;offerDigest?:string;dependency?:never}|{dependency:DependencyReference;offer?:never;offerDigest?:never});
	readGrant?: Inventory;
	claims?: { actor: string; path: string; start: string; kickoff: string; identity: string }[];
	claimedRequest?: string;
	kind: "writer" | "component" | "rerun" | "product" | "goal" | "repair" | "decision" | "handoff" | "artifact" | "escalation" | "control" | "instruction";
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

export interface Rerun {
	observedTarget?:string;
	of:string;
	checkpoint:string;
	candidate:string;
	directory:Scope;
	harness:string[];
	current:string[];
	after?:string;
}

export interface Delivery {
	id:string;
	checkpoint:string;
	goal:string;
	assembly:string;
	selected:{rerun:string; tree:string; prior:Node}[];
	assessment?:string;
	error?:string;
}

export interface Resolution {
	file:string;
	mode:"100644"|"100755";
	base:string;
	checkpoint:string;
	target:string;
	result:string;
}

export interface OutputOwner {
	source:string; squad:string; directory:Scope; output:string; component:string; binding:string;
}

export interface HarnessRollout {
	from:string; blob:string; harness:string; draft?:string;
	followup?:{proposal:string;assembly:string;check:string;files:HarnessRollout["files"];observation?:0|1|2;recipe?:{file:string;blob:string;command:string}};
	files:{file:string;mode:string;before:string|null;result:string|null}[];
	included:Record<string,{scope:Inspection["scope"];inputs:Record<string,string>;legacy?:string}>;
	owners:Record<string,{output:string;component:string;binding:string;scope:Inspection["scope"];inputs:Record<string,string>;specification?:string}>;
}

export interface Adoption {
	offeredThrough?:number; // Earlier unbound references were not selected for the next assembly.
	evaluator?:{kind:"goal"|"product";from:string;blob:string;files:string[];draft?:string};
	foreground?:{check:string;retry:string;variable:string;grains:Record<string,{file:string;number:number;line:string;blob:string}>};
	id:string;
	basis:string;
	revision:string;
	checkpoint:string;
	goal:string;
	assembly?:string;
	manifest?:{from:string;productFrom:string;goalFrom:string;files:string[];outputs:Record<string,string>;
		ownership:string;retained:string[];resolutions?:Resolution[]};
	failed?:string;
	rollout?:HarnessRollout;
	patch?:{blob:string; grain:string; files:{file:string;mode:string;before:string;result:string}[]; owner?:OutputOwner;draft?:string};
	message:string;
	decision?:OwnerDecision;
	previous?:OwnerDecision[];
}

export type Effect = NativeCall | Review;

export interface ProductPin {
	from:string; revision:string; files:string[]; checkpoint:string; goal:string; recheck:string;
	ownership?:"retain-except-transferred"; targetFrom?:string; acceptance?:string; resolutions?:Resolution[];
	amendments?:{prior:Product; proposal:string; recheck:string; harness?:string}[];
}

export interface TestRule {check:string;probe:string}
export interface DraftSource {
	kind:"owned"|"inherited"|"harness"|"evaluator"; grant:string; grain?:string; component?:string; output?:string; producer?:string;
}
export interface DraftPart {
	source:DraftSource; files:Omit<HarnessRollout["files"][number],"result">[];
	state:"ready"|"issued"|"returned"|"held"; dispatch?:string; workflow?:string; reason?:string; changes?:HarnessRollout["files"];
	awaitingPacket?:true; continued?:true;
}
export interface CorrectionDraft {
	id:string; check:string; checkpoint:string; goal:string; target:string; product:string; assembly:string;
	evaluator?:string; previousCheck?:string; automatic:boolean; decision?:OwnerDecision; previous?:OwnerDecision[]; parts:DraftPart[]; blob?:string;
}
export interface TestRepair {
	stop:string; owner:string; target:string; product:string; pin:string; before:string; driver:string; rule:TestRule; grain?:string; assertion?:string;recheck?:string;
	dispatch?:string;workflow?:string;continuation?:string;continuationAttempt?:number;awaitingPermission?:boolean;
	state:"diagnosing"|"draft"|"authoring"|"checking"|"review"|"reviewing"|"approved"|"applied"|"product"|"unobserved"|"held";
	controls:{oldGood:string;newGood?:string;newBad?:string};
	candidate?:string; revision?:string; blob?:string; reason?:string;wait?:string;
	author?:string; reviewer?:string; subject?:string;
}

export type RunDocument=Omit<Run,"nodes"> & {format:"foundry-run/2";reviewContract:"required"|"legacy-no-review";graph:{nodes:Run["nodes"]}};
export interface Run {
	footprintRequests?:FootprintRequest[];
	diagnostics?:Diagnostic[]; // A writer supplies evidence. Only the existing scoped operation can authorize its use.
	instructions?:NativeCall[]; // Informational deliveries use the native call journal, not the product/assignment queue.
	offerHold?:string;
	correctionDrafts?:CorrectionDraft[];
	testRepairs?:TestRepair[];
	targetProposal?:string;
	adoptions?:Adoption[];
	inspections?:Inspection[]; // Present from activation for runs requiring independent candidate review.
	deliveries?:Delivery[];
	independent?:Subset;
	id: string;
	owner: string;
	references?: Record<string, string>;
	artifacts?: Artifact[];
	pendingReviewNotes?: (ReviewNote & { squad: string; after: number })[];
	attributions?: Attribution[];
	repins?: { from: string; revision: string; files: string[] }[];
	productRepins?: ProductPin[];
	policy: Policy;
	scheduling?: { revision: number; workers?: number; checkpointReviews: boolean };
	activatedAt: number;
	active: boolean;
	pauseReason?: string;
	policyHold?: {issuer:string; effect:string; token:string};
	nodes: Record<string, Node>;
	effects: Effect[];
	products: Product[];
	join?: Product;
	goal?: Assessment & { stall?: string; tried?: string[] };
	blocker?: string;
	conflict?: string;
	discoveryError?: string;
}
