export type Json = null | boolean | number | string | Json[] | {
	[key: string]: Json;
};

export interface Grain {
	id: string;
	directory: string;
	specification: string;
	boundary: string[];
	check: string;
	needs: string[];
}

export interface Squad {
	id: string;
	charter: string;
	grains: string[];
	agent?: string;
}

export interface Policy {
	id: string;
	direction: string;
	target: string;
	source: string;
	base: string;
	productCheck: string;
	goalCheck?: string;
	grains: Grain[];
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
	grains: string[];
}

export interface Node {
	review?: string;
	state: "waiting" | "writing" | "checking" | "published" | "qualified" | "blocked";
	token?: string;
	worker?: string;
	generation?: string;
	inputs?: Record<string, string>;
	base?: string;
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
}

export interface Effect {
	id: string;
	issuer: string;
	kind: "writer" | "scout" | "component" | "product" | "goal" | "repair" | "capacity";
	grain?: string;
	token?: string;
	tool: "create_session" | "bash" | "send_session_message";
	args: {
		[key: string]: Json;
	};
	state: "ready" | "issued" | "uncertain" | "ordinary" | "done" | "refused";
	callId?: string;
	nativeId?: string;
	error?: string;
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
	reviews: Review[];
	nodes: Record<string, Node>;
	effects: Effect[];
	products: Product[];
	join?: Product;
	goal?: Assessment & { stall?: string };
	accepted?: string;
	blocker?: string;
	discoveryError?: string;
}
