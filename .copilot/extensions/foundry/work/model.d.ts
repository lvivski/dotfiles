export type Json = null | boolean | number | string | Json[] | {
	[key: string]: Json;
};

export interface Output {
	id: string;
	directory: string;
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
	waitFor?: string;
	file?: string;
	findings?: Finding[];
}

export interface Finding { kind: string; source: string; finding: string }

export type Packet = { review: string; base: string; files: Record<string, string>; outputs: Record<string, string>; partial: boolean };

export interface Node {
	grain: Grain;
	review?: string;
	state: "idle" | "waiting" | "writing" | "checking" | "published" | "qualified" | "repeated" | "blocked";
	token?: string;
	worker?: string;
	generation?: string;
	inputs?: Record<string, string>;
	base?: string;
	replaces?: string;
	candidate?: string;
	check?: string;
	repairs: number;
	reason?: string;
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

export interface Review extends Dispatch {
	kind: "scout";
	tool: "workflow";
	state: "ready" | "issued" | "uncertain" | "reported" | "observed" | "blocked";
	squad: string;
	base: string;
	version: string;
	packet?: Packet;
	wake?: { review: string; key: string };
	observation?: Observation;
	decision?: { status: "presenting" | "dismissed" } | { status: "answered"; answer: string }
		| { status: "unavailable"; reason: string };
}

export interface Receipt {
	commit: string;
	check: string;
	exit: number | null;
	output: string;
	repair?: string;
	squad?: string;
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
	runnerStarted?: boolean;
	receipt?: Receipt;
}

export interface NativeCall extends Dispatch {
	kind: "writer" | "component" | "product" | "goal" | "repair" | "decision" | "handoff";
	inlineRepair?: string;
	tool: "create_session" | "bash" | "send_session_message" | "session.send";
	state: "ready" | "issued" | "uncertain" | "ordinary" | "done" | "refused";
}

export type Effect = NativeCall | Review;

export interface Run {
	id: string;
	owner: string;
	policy: Policy;
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
