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
	base: string;
	productCheck: string;
	goalCheck?: string;
	files: string[];
	squads: Squad[];
	workers?: number;
	repairs: number;
	deadline?: string;
	seed?: string[];
}

export interface Observation {
	outcome: "regenerate" | "no-gap" | "needs-decision";
	reason: string;
	evidence: string[];
	grains: (string | Proposal)[];
	replace?: string[];
}

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
}

export interface Review {
	id: string;
	squad: string;
	state: "reading" | "observed" | "blocked";
	worker?: string;
	token: string;
	base: string;
	version: string;
	observation?: Observation;
	reason?: string;
}

export interface Receipt {
	commit: string;
	check: string;
	exit: number | null;
	output: string;
	repair?: string;
	squad?: string;
}

export interface Effect {
	id: string;
	issuer: string;
	kind: "writer" | "scout" | "component" | "product" | "goal" | "repair" | "capacity";
	grain?: string;
	token?: string;
	tool: "create_session" | "bash" | "send_session_message" | "session.send";
	args: {
		[key: string]: Json;
	};
	state: "ready" | "issued" | "uncertain" | "ordinary" | "done" | "refused";
	callId?: string;
	nativeId?: string;
	error?: string;
	permissionHold?: string;
	commit?: string;
	check?: string;
	runnerStarted?: boolean;
	receipt?: Receipt;
}

export interface Run {
	id: string;
	owner: string;
	policy: Policy;
	capacity?: { limit: number; kept: boolean; offer?: { id: string; to: number } };
	active: boolean;
	pauseReason?: string;
	reviews: Review[];
	nodes: Record<string, Node>;
	effects: Effect[];
	products: Product[];
	join?: Product;
	goal?: Assessment & { stall?: string; tried?: string[] };
	accepted?: string;
	blocker?: string;
	conflict?: string;
	discoveryError?: string;
}
