import { planDirectory, validOutcome } from "./contract.mjs";
import { checkReceipt, goalReceipt } from "./evidence.mjs";
import { assignmentCount, unissued } from "./native.mjs";
import { checked, owns, validateNodes } from "./plan.mjs";
import { outside } from "./product.mjs";
import { fail, relative } from "./values.mjs";

/** @typedef {(value:unknown)=>boolean} Guard */
/** @type {Guard} */
const string = value => typeof value === "string";
/** @type {Guard} */
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !Object.hasOwn(Object.prototype, value);
/** @type {Guard} */
const commit = value => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
/** @type {Guard} */
const path = value => typeof value === "string" && relative(value) === value;
/** @type {Guard} */
const count = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** @type {Guard} */
const positive = v => count(v) && v !== 0;
/** @type {Guard} */
const bool = value => typeof value === "boolean";
/** @param {unknown} v @returns {v is Record<string,unknown>} */
const object = v => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {...string} states @returns {Guard} */
const one = (...states) => v => typeof v === "string" && states.includes(v);
/** @param {Guard} guard @returns {Guard} */
const optional = guard => v => v === undefined || guard(v);
/** @param {Guard} guard @returns {Guard} */
const list = guard => v => Array.isArray(v) && v.every(guard);
/** @param {Guard} guard @returns {Guard} */
const named = guard => v => object(v) && Object.entries(v).every(([k, item]) => id(k) && guard(item));
/** @param {Record<string,Guard>} fields @returns {Guard} */
const shape = fields => v => object(v) && Object.entries(fields).every(([key, guard]) => guard(v[key]));
const output = { id, directory: path, check: path, needs: list(id) };
const grain = shape({ ...output, specification: path, boundary: list(path), task: optional(string), agent: optional(string) });
const proposal = shape({ ...output, task: string });
const charter = { id, charter: path, agent: optional(string) };
const fixed = shape({ ...charter, grains: list(id) });
const area = shape({ ...charter, areas: list(path), boundary: list(path), checks: list(path), researchAgent: optional(id) });
const policy = shape({
	id, direction: string, target: string, source: path, sharedBrief: optional(path), base: commit, productCheck: path, goalCheck: optional(path), files: list(path),
	squads: list(s => object(s) && ("areas" in s ? !("grains" in s) && area(s) : fixed(s))),
	workers: optional(positive), assignments: optional(count), repairs: count, deadline: optional(string), seed: optional(list(id))
});
/** @type {Guard} */
const observation = v => object(v) && string(v.reason) && Array.isArray(v.evidence) && v.evidence.length > 0 && v.evidence.every(path) &&
	Array.isArray(v.grains) && v.grains.every(g => id(g) || proposal(g)) && validOutcome(v.outcome, v.grains.length) &&
	(v.ownerInput === undefined || v.outcome === "needs-decision" && one("product-choice", "external-action")(v.ownerInput)) &&
	(v.findings === undefined ? v.outcome !== "researched" : (v.outcome === "researched" || v.outcome === "needs-decision" || v.outcome === "unresolved") &&
		list(shape({ kind: string, source: string, finding: string }))(v.findings) && (v.outcome !== "researched" || Array.isArray(v.findings) && v.findings.length > 0)) &&
	(v.outcome === "waiting" ? id(v.waitFor) : v.waitFor === undefined) &&
	(v.outcome === "needs-evidence" ? path(v.file) : v.file === undefined) &&
	(v.replace === undefined || v.outcome === "regenerate" && list(id)(v.replace));
/** @param {unknown} v @returns {v is import("./model.js").Packet} */
export const isPacket = v => object(v) && id(v.review) && commit(v.base) && bool(v.partial) && object(v.files) &&
	Object.entries(v.files).every(([p, oid]) => path(p) && commit(oid)) && named(commit)(v.outputs);
/** @type {Guard} */
const decision = v => object(v) && (one("presenting", "dismissed")(v.status) ||
	v.status === "answered" && string(v.answer) ||
	v.status === "unavailable" && string(v.reason));
const node = shape({
	grain, review: optional(id), state: one("idle", "waiting", "writing", "checking", "published", "qualified", "repeated", "blocked"), token: optional(id), worker: optional(string),
	generation: optional(commit), inputs: optional(named(commit)), base: optional(commit), replaces: optional(commit), candidate: optional(commit), check: optional(id),
	repairs: count, reason: optional(string)
});
const assessment = { target: commit, commit, check: id };
const product = shape({ ...assessment, outputs: named(commit), qualifiedAt: optional(positive) });
const receipt = shape({ commit, check: path, exit: v => v === null || count(v), output: string, repair: optional(id), squad: optional(id) });
const dispatch = { id, issuer: string, args: object, callId: optional(string), error: optional(string), permissionHold: optional(string) };
const scout = shape({ ...dispatch, kind: one("scout"), tool: one("workflow"), squad: id, base: commit, version: string,
	state: one("ready", "issued", "uncertain", "reported", "observed", "blocked"), observation: optional(observation),
	workflowId: optional(string), decision: optional(decision), packet: optional(isPacket), wake: optional(shape({ review: id, key: string })) });
const native = shape({
	...dispatch, kind: one("writer", "component", "product", "goal", "repair", "decision", "handoff"), grain: optional(id), inlineRepair: optional(id),
	token: optional(id), tool: one("create_session", "bash", "send_session_message", "session.send"), state: one("ready", "issued", "uncertain", "ordinary", "done", "refused"),
	nativeId: optional(string), boundAt: optional(positive), commit: optional(commit), check: optional(path),
	runnerStarted: optional(bool), receipt: optional(receipt)
});
const snapshot = shape({
	id, owner: string, policy,
	active: bool, activatedAt: positive, pauseReason: optional(string), nodes: named(node), effects: list(v => scout(v) || native(v)),
	products: list(product), join: optional(product), goal: optional(shape({ ...assessment, stall: optional(string),
		tried: optional(list(v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) })),
	blocker: optional(string), conflict: optional(string), discoveryError: optional(string)
});

/** @param {unknown} value @returns {value is import("./model.js").Run} */
function isRun(value) { return snapshot(value); }

/** @param {import("./model.js").Run} run @param {import("./model.js").Effect} e */
function validDispatch(run, e) {
	if (e.permissionHold !== undefined && !unissued(e)) return false;
	if (e.tool === "workflow") {
		const squad = run.policy.squads.find(s => s.id === e.squad), report = e.observation;
		return !!squad && !e.nativeId && !e.token && !e.receipt && !e.boundAt && (!e.workflowId || !!e.callId) &&
			(e.wake?.key !== "research" && report?.outcome !== "needs-research" || "areas" in squad && !!squad.researchAgent) &&
			(!report || (e.wake?.key === "research") === (report.findings !== undefined)) &&
			(!e.packet || e.packet.review === e.id && e.packet.base === e.base) &&
			(e.state !== "reported" && e.state !== "observed" || !!report && !!e.workflowId && !!e.packet) &&
			(!e.decision || e.state === "observed" && report?.outcome === "needs-decision") &&
			("areas" in squad || !report || !report.replace && report.grains.every(g => typeof g === "string"));
	}
	if (e.workflowId || Boolean(e.nativeId) !== Boolean(e.boundAt)) return false;
	if (e.inlineRepair && (e.kind !== "component" || !checkReceipt(e))) return false;
	if (e.kind === "writer") return e.tool === "create_session" && !!e.grain && !!e.token && (e.state === "done") === !!e.nativeId;
	if (e.nativeId) return false;
	if (e.kind === "goal" || e.kind === "product" || e.kind === "component")
		return e.tool === "bash" && !!e.commit && !!e.check && (e.kind === "component") === !!e.grain &&
			(!e.receipt || e.receipt.commit === e.commit && e.receipt.check === e.check) &&
			(!e.receipt?.squad || e.kind === "goal" && e.receipt.exit === 1 && run.policy.squads.some(s => s.id === e.receipt?.squad));
	if (!e.token || e.receipt || !string(e.args.message)) return false;
	if (e.kind === "repair") return !!e.grain && (e.tool === "send_session_message" || e.tool === "session.send" && e.state !== "ordinary");
	return e.issuer === run.owner ? e.kind === "handoff" && e.tool === "session.send" && e.state !== "ordinary"
		: e.tool === "send_session_message" && e.args.session_id === run.owner;
}

/** @param {unknown} value @returns {import("./model.js").Run} */
export function decode(value) {
	if (!isRun(value) || value.policy.id !== value.id || value.active && value.pauseReason !== undefined ||
		"capacity" in value || value.policy.assignments !== undefined && assignmentCount(value) > value.policy.assignments ||
		Boolean(value.policy.goalCheck) !== Boolean(value.goal) || value.goal && value.policy.seed)
		fail("corrupt_run", "Invalid Foundry execution snapshot");
	const { policy: p, nodes, products } = value, areas = p.squads.filter(s => "areas" in s), files = new Set(p.files);
	const effects = new Map(value.effects.map(e => [e.id, e]));
	const last = products.at(-1);
	if (effects.size !== value.effects.length || value.effects.some(e => !validDispatch(value, e)))
		fail("corrupt_run", "Invalid Foundry dispatch");
	if (areas.length && (!value.goal || areas.length !== value.policy.squads.length) ||
		p.sharedBrief !== undefined && (!areas.length || p.sharedBrief !== `${planDirectory(p.source)}/journey.md` ||
			areas.some(s => s.boundary.length !== 1 || s.boundary[0] !== p.sharedBrief)) ||
		![p.source, p.productCheck, ...(p.goalCheck ? [p.goalCheck] : []), ...p.squads.flatMap(s => "areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter])].every(f => files.has(f)) ||
		[p.seed ?? [], ...p.squads.flatMap(s => "grains" in s ? [s.grains] : [])].some(ids => ids.some(id => !Object.hasOwn(nodes, id))) ||
		Object.entries(nodes).some(([id, n]) => {
			const g = n.grain, e = n.check ? effects.get(n.check) : undefined;
			if (id !== g.id || ![g.specification, g.check, ...g.boundary].every(f => files.has(f)) || !outside(g.directory, p.files)) return true;
			if ((n.state === "checking" || checked(n)) && (e?.kind !== "component" || e.grain !== id || e.commit !== n.candidate || e.check !== g.check)) return true;
			if (checked(n) && checkReceipt(e)?.exit !== 0) return true;
			if (n.state === "qualified" && last?.outputs[id] !== n.candidate) return true;
			return areas.length ? n.state === "idle" || !g.task || !areas.some(s => owns(s, g.directory) && s.checks.includes(g.check) &&
				g.specification === s.charter && g.agent === s.agent && g.boundary.length === s.boundary.length && g.boundary.every((b, i) => b === s.boundary[i])) : g.task !== undefined;
		}))
		fail("corrupt_run", "Invalid Foundry task graph");
	validateNodes(nodes);
	for (const product of value.join ? [...products, value.join] : products) {
		const e = effects.get(product.check);
		if (e?.kind !== "product" || e.commit !== product.commit || e.check !== p.productCheck)
			fail("corrupt_run", "Product does not match its exact check reservation");
		if (product === value.join ? product.qualifiedAt !== undefined :
			checkReceipt(e)?.exit !== 0 || (!value.goal && !product.qualifiedAt || value.goal && product.qualifiedAt && last !== product))
			fail("corrupt_run", "Checkpoint requires an exact passing product receipt");
	}
	if (last?.qualifiedAt && value.goal && (value.active || last.commit !== value.goal.commit ||
		last.target !== value.goal.target || goalReceipt(value)?.exit !== 0))
		fail("corrupt_run", "Goal acceptance requires both exact runner receipts");
	return value;
}
