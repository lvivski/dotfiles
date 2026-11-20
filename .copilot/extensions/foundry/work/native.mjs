import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { digest, fail, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Run} Run */
const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
/** @param {string} value */
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
/** @param {string} run @param {string} token */
const marker = (run, token) => `Foundry assignment: ${run} ${token}`;

/** @param {string} value */
export function assignment(value) {
	const match = /^Foundry assignment: ([A-Za-z0-9][A-Za-z0-9._-]*) ([a-f0-9-]{36})(?:\n|$)/.exec(value);
	return match ? { run: match[1], token: match[2] } : undefined;
}

/** @param {string} value */
export const capacityNotice = value => /^Foundry capacity: ([A-Za-z0-9][A-Za-z0-9._-]*) [a-f0-9-]{36}\n/.exec(value)?.[1];

/** @param {Run} run @param {string} issuer @param {string} token @returns {Effect} */
export function notifyOwner(run, issuer, token) {
	return { id: randomUUID(), issuer, kind: "capacity", token, state: "ready", tool: "send_session_message",
		args: { session_id: run.owner, delivery_mode: "immediate",
			message: `Foundry capacity: ${run.id} ${token}\nReady work is waiting at the worker cap. The owner session will present the choice if it is still needed. This notice does not authorize an increase.` } };
}

/** @param {Run} run @param {string} issuer @param {"writer"|"scout"|"repair"} kind @param {string} token @param {string} base
 * @param {string} brief @param {{grain?:string,worker?:string,agent?:string}} [target] @returns {Effect} */
export function assignmentEffect(run, issuer, kind, token, base, brief, target = {}) {
	const message = `${marker(run.id, token)}\n${brief}`;
	return {
		id: randomUUID(), issuer, kind, token, state: "ready", ...(target.grain ? { grain: target.grain } : {}),
		tool: target.worker ? "send_session_message" : "create_session", args: target.worker ? {
			session_id: target.worker, delivery_mode: "immediate", message,
		} : {
			name: `${(target.grain ?? "Review").slice(0, 22)} ${token.slice(0, 8)}`, workspace_type: "worktree", base_branch: base,
			coordinate_with_creator: true, notify_on_idle: "once", kickoff: { mode: "autopilot", prompt: message, ...(target.agent ? { agent: target.agent } : {}) }
		}
	};
}

/** @param {Run} run @param {string} issuer @param {string} cwd @param {string} commit @param {string} check @param {string} [grain] @returns {Effect} */
export function checkEffect(run, issuer, cwd, commit, check, grain) {
	const id = randomUUID();
	return {
		id, issuer, kind: grain ? "component" : "product", state: "ready", tool: "bash", commit, check, ...(grain ? { grain } : {}),
		args: {
			command: [process.execPath, runner, cwd, run.id, id].map(quote).join(" "), shellId: `foundry-${id}`, initial_wait: 120,
			description: `Check ${grain ?? "joined product"} at ${commit.slice(0, 12)}`.slice(0, 100)
		}
	};
}

/** @param {Run} run @param {Effect} e */
function assignee(run, e) {
	return e.kind === "scout" ? run.reviews.find(r => r.token === e.token) : e.grain ? run.nodes[e.grain] : undefined;
}

/** @param {Run} run @param {Effect} e */
export function current(run, e) {
	if (e.kind === "capacity")
		return !!e.token && run.capacity.offer?.id === e.token;
	if (e.kind === "product")
		return !run.blocker && run.join?.check === e.id;
	const n = assignee(run, e);
	if (e.kind === "component")
		return n?.state === "checking" && n.check === e.id;
	return !!n && n.token === e.token && n.state === (e.kind === "scout" ? "reading" : "writing");
}

/** @param {Run} run */
export function admitted(run) {
	if (!run.active)
		fail("paused", "Foundry is paused");
	if (run.policy.deadline && Date.now() >= Date.parse(run.policy.deadline))
		fail("deadline", "The authorized deadline has elapsed");
}

/** @param {Run} run @param {string} actor @param {string} tool @param {unknown} args @param {string} callId @param {string} id */
export function issue(run, actor, tool, args, callId, id) {
	const e = run.effects.find(e => e.id === id);
	if (!e || e.issuer !== actor || e.tool !== tool || digest(e.args) !== digest(args) || !current(run, e))
		fail("stale_call", "Only the current exact reserved call may execute");
	const issued = e.state === "issued" && e.callId === callId;
	if (!issued || tool !== "bash") admitted(run);
	if (issued)
		return;
	if (e.state !== "ready" && e.state !== "ordinary")
		fail("already_issued", "Do not repeat an issued or uncertain native call");
	e.callId = text(callId, "original call ID");
	e.state = "issued";
	delete e.error;
}

/** @param {Run} run @param {Effect} e @param {string} reason */
function block(run, e, reason) {
	e.error = reason;
	if (!current(run, e))
		return;
	const n = assignee(run, e);
	if (n) {
		n.state = "blocked";
		n.reason = reason;
	} else if (e.kind === "product")
		run.blocker = reason;
}

/** @param {Run} run @param {Effect} e @param {unknown} raw @param {boolean} automatic */
export function receive(run, e, raw, automatic) {
	const value = record(raw);
	if (automatic && value.resultType === "failure" && value.error === "This session management tool is disabled" &&
		!value.structuredContent && !value.textResultForLlm && e.tool !== "bash") {
		e.state = "ordinary";
		e.error = "Native route disabled; execute the exact prepared call in its owner session";
		return;
	}
	if (["denied", "rejected"].includes(String(value.resultType))) {
		e.state = "refused";
		block(run, e, "Native permission refused");
		return;
	}
	if (value.resultType !== "success")
		fail("native_unconfirmed", typeof value.error === "string" ? value.error : "No conclusive native receipt");
	if (e.tool === "create_session") {
		const content = typeof value.textResultForLlm === "string" ? value.textResultForLlm.trim() : "";
		const data = record(value.structuredContent ?? (content.startsWith("{") ? JSON.parse(content) : {}));
		const prefix = `Created session '${e.args.name}' (id: `;
		const printed = content.startsWith(prefix) ? /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\)/i.exec(content.slice(prefix.length))?.[1] : undefined;
		e.nativeId = text(data.project_session_id ?? data.id ?? data.session_id ?? printed, "native worker identity");
		if (current(run, e)) {
			const entry = assignee(run, e);
			if (entry)
				entry.worker = e.nativeId;
		}
	}
	else if (e.tool === "bash")
		fail("missing_receipt", "The pinned runner has not finished");
	else if (!(typeof value.textResultForLlm === "string" && /^(?:Queued\.?$|Message accepted for priority delivery to session '[^\n]+'\.)/.test(value.textResultForLlm))
		&& !(value.structuredContent && ["accepted", "queued", "delivered"].includes(String(record(value.structuredContent).status))))
		fail("missing_receipt", "Message queue admission was not confirmed");
	e.state = "done";
	delete e.error;
}
