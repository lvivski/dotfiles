import { validOutcome } from "./contract.mjs";
import { goalReceipt } from "./goal.mjs";
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
const grain = shape({ id, directory: path, specification: path, boundary: list(path), check: path, needs: list(id) });
const squad = shape({ id, charter: path, grains: list(id), agent: optional(string) });
const policy = shape({
	id, direction: string, target: string, source: path, base: commit, productCheck: path, goalCheck: optional(path), grains: list(grain),
	squads: list(squad), workers: optional(positive), repairs: count, deadline: optional(string), seed: optional(list(id))
});
/** @type {Guard} */
const observation = v => object(v) && string(v.reason) && Array.isArray(v.evidence) && v.evidence.length > 0 && v.evidence.every(path) &&
	Array.isArray(v.grains) && v.grains.every(id) && validOutcome(v.outcome, v.grains.length);
const review = shape({
	id, squad: id, state: one("reading", "observed", "blocked"), worker: optional(string), token: id, base: commit,
	version: string, observation: optional(observation), reason: optional(string)
});
const node = shape({
	review: optional(id), state: one("waiting", "writing", "checking", "published", "qualified", "blocked"), token: optional(id), worker: optional(string),
	generation: optional(commit), inputs: optional(named(commit)), base: optional(commit), candidate: optional(commit), check: optional(id),
	repairs: count, reason: optional(string)
});
const assessment = { target: commit, commit, check: id };
const product = shape({ ...assessment, outputs: named(commit) });
const receipt = shape({ commit, check: path, exit: v => v === null || count(v), output: string, repair: optional(id) });
const effect = shape({
	id, issuer: string, kind: one("writer", "scout", "component", "product", "goal", "repair", "capacity"), grain: optional(id),
	token: optional(id), tool: one("create_session", "bash", "send_session_message"), args: object, state: one("ready", "issued", "uncertain", "ordinary", "done", "refused"),
	callId: optional(string), nativeId: optional(string), error: optional(string), commit: optional(commit), check: optional(path),
	runnerStarted: optional(bool), receipt: optional(receipt)
});
const snapshot = shape({
	id, owner: string, policy, capacity: optional(shape({ limit: positive, kept: bool, offer: optional(shape({ id, to: positive })) })),
	active: bool, reviews: list(review), nodes: named(node), effects: list(effect),
	products: list(product), join: optional(product), goal: optional(shape({ ...assessment, stall: optional(string) })), accepted: optional(commit),
	blocker: optional(string), discoveryError: optional(string)
});

/** @param {unknown} value @returns {value is import("./model.js").Run} */
function isRun(value) { return snapshot(value); }

/** @param {unknown} value @returns {import("./model.js").Run} */
export function decode(value) {
	if (!isRun(value) || value.policy.id !== value.id ||
		(value.policy.workers === undefined ? value.capacity !== undefined : !value.capacity || value.capacity.limit < value.policy.workers) ||
		Boolean(value.policy.goalCheck) !== Boolean(value.goal) || value.goal && value.policy.seed ||
		value.capacity?.offer && (value.capacity.kept || value.capacity.offer.to <= value.capacity.limit))
		fail("corrupt_run", "Invalid Foundry execution snapshot");
	if (value.accepted) {
		const last = value.products.at(-1);
		const milestone = value.effects.find(e => e.id === last?.check);
		if (value.active || value.accepted !== value.goal?.commit || value.accepted !== last?.commit || goalReceipt(value)?.exit !== 0 ||
			milestone?.kind !== "product" || milestone.state !== "done" || !milestone.runnerStarted || milestone.receipt?.exit !== 0 ||
			milestone.receipt.commit !== value.accepted || milestone.receipt.check !== value.policy.productCheck)
			fail("corrupt_run", "Goal acceptance requires both exact runner receipts");
	}
	return value;
}
