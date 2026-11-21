import { validOutcome } from "./contract.mjs";
import { goalReceipt } from "./goal.mjs";
import { checkReceipt, unissued } from "./native.mjs";
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
const area = shape({ ...charter, areas: list(path), boundary: list(path), checks: list(path) });
const policy = shape({
	id, direction: string, target: string, source: path, base: commit, productCheck: path, goalCheck: optional(path), files: list(path),
	squads: list(s => object(s) && ("areas" in s ? !("grains" in s) && area(s) : fixed(s))),
	workers: optional(positive), repairs: count, deadline: optional(string), seed: optional(list(id))
});
/** @type {Guard} */
const observation = v => object(v) && string(v.reason) && Array.isArray(v.evidence) && v.evidence.length > 0 && v.evidence.every(path) &&
	Array.isArray(v.grains) && v.grains.every(g => id(g) || proposal(g)) && validOutcome(v.outcome, v.grains.length) &&
	(v.replace === undefined || v.outcome === "regenerate" && list(id)(v.replace));
const review = shape({
	id, squad: id, state: one("reading", "observed", "blocked"), worker: optional(string), token: id, base: commit,
	version: string, observation: optional(observation), reason: optional(string)
});
const node = shape({
	grain, review: optional(id), state: one("idle", "waiting", "writing", "checking", "published", "qualified", "repeated", "blocked"), token: optional(id), worker: optional(string),
	generation: optional(commit), inputs: optional(named(commit)), base: optional(commit), replaces: optional(commit), candidate: optional(commit), check: optional(id),
	repairs: count, reason: optional(string)
});
const assessment = { target: commit, commit, check: id };
const product = shape({ ...assessment, outputs: named(commit) });
const receipt = shape({ commit, check: path, exit: v => v === null || count(v), output: string, repair: optional(id), squad: optional(id) });
const effect = shape({
	id, issuer: string, kind: one("writer", "scout", "component", "product", "goal", "repair", "capacity"), grain: optional(id),
	token: optional(id), tool: one("create_session", "bash", "send_session_message", "session.send"), args: object, state: one("ready", "issued", "uncertain", "ordinary", "done", "refused"),
	callId: optional(string), nativeId: optional(string), error: optional(string), permissionHold: optional(string), commit: optional(commit), check: optional(path),
	runnerStarted: optional(bool), receipt: optional(receipt)
});
const snapshot = shape({
	id, owner: string, policy, capacity: optional(shape({ limit: positive, kept: bool, offer: optional(shape({ id, to: positive })) })),
	active: bool, pauseReason: optional(string), reviews: list(review), nodes: named(node), effects: list(effect),
	products: list(product), join: optional(product), goal: optional(shape({ ...assessment, stall: optional(string),
		tried: optional(list(v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) })), accepted: optional(commit),
	blocker: optional(string), conflict: optional(string), discoveryError: optional(string)
});

/** @param {unknown} value @returns {value is import("./model.js").Run} */
function isRun(value) { return snapshot(value); }

/** @param {unknown} value @returns {import("./model.js").Run} */
export function decode(value) {
	if (!isRun(value) || value.policy.id !== value.id || value.active && value.pauseReason !== undefined ||
		(value.policy.workers === undefined ? value.capacity !== undefined : !value.capacity || value.capacity.limit < value.policy.workers) ||
		Boolean(value.policy.goalCheck) !== Boolean(value.goal) || value.goal && value.policy.seed ||
		value.capacity?.offer && (value.capacity.kept || value.capacity.offer.to <= value.capacity.limit))
		fail("corrupt_run", "Invalid Foundry execution snapshot");
	const { policy: p, nodes, products } = value, areas = p.squads.filter(s => "areas" in s), files = new Set(p.files);
	const passed = new Map(value.effects.filter(e => checkReceipt(e)?.exit === 0).map(e => [e.id, e]));
	const last = products.at(-1);
	if (areas.length && (!value.goal || areas.length !== value.policy.squads.length) ||
		value.effects.some(e => e.permissionHold !== undefined && !unissued(e) ||
			e.receipt?.squad !== undefined && (e.kind !== "goal" || e.receipt.exit !== 1 || !p.squads.some(s => s.id === e.receipt?.squad))) ||
		value.effects.some(e => e.tool === "session.send" && (e.kind !== "repair" || !e.grain || !e.token || e.state === "ordinary")) ||
		!areas.length && value.reviews.some(r => r.observation && (r.observation.replace || r.observation.grains.some(g => typeof g !== "string"))) ||
		![p.source, p.productCheck, ...(p.goalCheck ? [p.goalCheck] : []), ...p.squads.flatMap(s => "areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter])].every(f => files.has(f)) ||
		[p.seed ?? [], ...p.squads.flatMap(s => "grains" in s ? [s.grains] : [])].some(ids => ids.some(id => !Object.hasOwn(nodes, id))) ||
		Object.entries(nodes).some(([id, n]) => {
			const g = n.grain, e = n.check && passed.get(n.check);
			if (id !== g.id || ![g.specification, g.check, ...g.boundary].every(f => files.has(f)) || !outside(g.directory, p.files)) return true;
			if (checked(n) && (!e || e.kind !== "component" || e.grain !== id || e.commit !== n.candidate || e.check !== g.check)) return true;
			if (n.state === "qualified" && last?.outputs[id] !== n.candidate) return true;
			return areas.length ? n.state === "idle" || !g.task || !areas.some(s => owns(s, g.directory) && s.checks.includes(g.check) &&
				g.specification === s.charter && g.agent === s.agent && g.boundary.length === s.boundary.length && g.boundary.every((b, i) => b === s.boundary[i])) : g.task !== undefined;
		}))
		fail("corrupt_run", "Invalid Foundry task graph");
	validateNodes(nodes);
	for (const product of products) {
		const e = passed.get(product.check);
		if (e?.kind !== "product" || e.commit !== product.commit || e.check !== p.productCheck)
			fail("corrupt_run", "Checkpoint requires an exact passing product receipt");
	}
	if (value.accepted && (value.active || value.accepted !== value.goal?.commit || value.accepted !== last?.commit || goalReceipt(value)?.exit !== 0))
		fail("corrupt_run", "Goal acceptance requires both exact runner receipts");
	return value;
}
