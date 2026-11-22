import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { qualifiedProduct } from "./evidence.mjs";
import { questions, reading } from "./reviews.mjs";
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
const noticeRun = value => /^Foundry (?:decision|handoff|artifact): ([A-Za-z0-9][A-Za-z0-9._-]*) [a-f0-9-]{36}\n/.exec(value)?.[1];

/** @param {string} tool @param {unknown} args */
export function identify(tool, args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	const a = record(args);
	const message = tool === "create_session" && a.kickoff && typeof a.kickoff === "object" && "prompt" in a.kickoff
		? a.kickoff.prompt : tool === "send_session_message" ? a.message : undefined;
	if (typeof message === "string") return assignment(message)?.run ?? (tool === "send_session_message" ? noticeRun(message) : undefined);
	if (tool === "bash" && typeof a.command === "string" && a.command.includes("/work/runner.mjs' ") && /^foundry-[a-f0-9-]{36}$/.test(String(a.shellId)))
		return / '([A-Za-z0-9][A-Za-z0-9._-]*)' '[a-f0-9-]{36}'$/.exec(a.command)?.[1];
}

/** @param {Run} run @param {string} issuer @param {string} token @param {"repair"|"decision"|"handoff"|"artifact"} kind
 * @param {string} body @param {import("./model.js").Node} [node] */
export function reserveNotice(run, issuer, token, kind, body, node) {
	const to = node ? text(node.worker, "assigned writer") : run.owner;
	const message = `${kind === "repair" ? marker(run.id, token) : `Foundry ${kind}: ${run.id} ${kind === "artifact" ? randomUUID() : token}`}\n${body}`;
	run.effects.push({ id: randomUUID(), issuer, token, state: "ready", kind, ...(node ? { grain: node.grain.id } : {}),
		tool: to === issuer ? "session.send" : "send_session_message",
		args: to === issuer ? { message } : { session_id: to, delivery_mode: "immediate", message } });
}

/** @param {Run} run @param {string} issuer @param {string} token @param {string} base @param {string} brief @param {string|undefined} agent @param {string} grain */
export function reserveWorker(run, issuer, token, base, brief, agent, grain) {
	run.effects.push({ id: randomUUID(), issuer, token, state: "ready", kind: "writer", grain,
		tool: "create_session", args: {
			name: `${grain.slice(0, 22)} ${token.slice(0, 8)}`, workspace_type: "worktree", base_branch: base,
			coordinate_with_creator: true, notify_on_idle: "once", kickoff: { mode: "autopilot", prompt: `${marker(run.id, token)}\n${brief}`, ...(agent ? { agent } : {}) }
		} });
}

/** @param {Run} run @param {string} issuer @param {string} cwd @param {string} commit @param {string} check @param {string} [grain]
 * @param {import("./model.js").ArtifactReport} [reports] */
export function reserveCheck(run, issuer, cwd, commit, check, grain, reports) {
	const id = randomUUID();
	const kind = grain ? "component" : check === run.policy.goalCheck ? "goal" : "product";
	run.effects.push({
		id, issuer, kind, state: "ready", tool: "bash", commit, check, ...(grain ? { grain } : {}), ...reports,
		args: {
			command: `command node ${[runner, cwd, run.id, id].map(quote).join(" ")}`, shellId: `foundry-${id}`, initial_wait: 120,
			description: `Check ${grain ?? (kind === "goal" ? "final goal" : "joined product")} at ${commit.slice(0, 12)}`.slice(0, 100)
		}
	});
	return id;
}

/** @param {Run} run @param {string} issuer @param {string} cwd @param {string} target @param {string} commit @param {Record<string,string>} outputs */
export function reserveProduct(run, issuer, cwd, target, commit, outputs) {
	run.join = { target, commit, outputs, check: reserveCheck(run, issuer, cwd, commit, run.policy.productCheck) };
}

/** @param {Effect} e */
export const unissued = e => e.state === "ready" || e.state === "ordinary";
/** @param {Effect} e */
export const awaitingReply = e => e.state === "issued" || e.state === "uncertain";
/** @param {Run} run */
export const expired = run => !!run.policy.deadline && Date.now() >= Date.parse(run.policy.deadline);

/** Count reservations, not deliveries or today's graph. An inline repair has no notice;
 * its new assignment token is recorded on the writer's preceding component check.
 * @param {Run} run */
export const assignmentCount = run => run.effects.filter(e => e.kind === "scout" || e.kind === "writer" ||
	e.kind === "repair" || e.kind === "component" && e.inlineRepair).length;

/** @param {Run} run @param {Effect} e */
function assignee(run, e) {
	return e.grain ? run.nodes[e.grain] : undefined;
}

/** @param {Run} run @param {Effect} e */
export function current(run, e) {
	if (e.tool === "workflow")
		return reading(e);
	if (run.conflict && (e.kind === "product" || e.kind === "goal") && e.state === "ready") return false;
	if (e.kind === "decision")
		return questions(run).some(r => r.id === e.token && !r.decision);
	if (e.kind === "handoff") {
		const product = run.products.at(-1);
		return !!product?.qualifiedAt && product.check === e.token;
	}
	if (e.kind === "goal")
		return !qualifiedProduct(run) && !run.blocker && run.goal?.check === e.id;
	if (e.kind === "product")
		return !run.blocker && run.join?.check === e.id;
	const n = assignee(run, e);
	if (e.kind === "component")
		return n?.state === "checking" && n.check === e.id;
	if (e.tool === "session.send" && n?.worker !== e.issuer) return false;
	return !!n && n.token === e.token && n.state === "writing";
}

/** @param {Run} run */
export function admitted(run) {
	const final = run.goal && qualifiedProduct(run);
	if (final) fail("goal_met", `Goal met at ${final.commit}`);
	if (!run.active)
		fail("paused", run.pauseReason ?? "Foundry is paused");
	if (expired(run))
		fail("deadline", "The authorized deadline has elapsed");
}

/** @param {Run} run @param {string} actor @param {string} token */
export function boundWriter(run, actor, token) {
	return Object.values(run.nodes).find(n => n.worker === actor && n.token === token) ??
		fail("stale_assignment", "No current worker assignment matches this token");
}

/** A final handoff may notify its owner after goal acceptance. It cannot authorize work.
 * @param {Run} run @param {Effect} e */
export const canDispatch = (run, e) => !expired(run) && (run.active || e.kind === "handoff" && !!run.goal) && current(run, e);

/** Claim exactly the reservation seen before the permission read, inside the ledger transaction.
 * @param {Run} run @param {Effect} expected @param {string} callId */
export function issue(run, expected, callId) {
	const e = run.effects.find(e => e.id === expected.id);
	if (!e || e.issuer !== expected.issuer || e.state !== expected.state || e.tool !== expected.tool ||
		digest(e.args) !== digest(expected.args) || !current(run, e)) return false;
	if (e.state === "issued") {
		if (e.callId !== callId) return false;
		if (e.tool !== "bash" && !canDispatch(run, e)) return false; // An already-issued runner may finish through a pause.
		return true;
	}
	if (!canDispatch(run, e) || e.permissionHold || !unissued(e)) return false;
	e.callId = text(callId, "original call ID");
	e.state = "issued";
	delete e.error;
	return true;
}

/** @param {Run} run @param {Effect} e @param {string} reason */
function block(run, e, reason) {
	e.error = reason;
	if (e.kind === "artifact" || !current(run, e))
		return;
	const n = assignee(run, e);
	if (n) {
		n.state = "blocked";
		n.reason = reason;
	} else if (e.kind === "product" || e.kind === "goal")
		run.blocker = reason;
}

/** Decode a confirmed launch only. Contradictory IDs must be reconciled against the
 * original call rather than attaching a submit token to the wrong session.
 * @param {Record<string,unknown>} value @param {import("./model.js").Json} name */
function workerId(value, name) {
	const content = typeof value.textResultForLlm === "string" ? value.textResultForLlm.trim() : "";
	const sources = [value.structuredContent, content.startsWith("{") ? JSON.parse(content) : undefined];
	const prefix = `Created session '${name}' (id: `;
	const printed = content.startsWith(prefix) ? /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\)/i.exec(content.slice(prefix.length))?.[1] : undefined;
	const ids = new Set([printed, ...sources.filter(s => s != null).map(record).flatMap(s => [s.project_session_id, s.id, s.session_id])].filter(id => id != null));
	if (ids.size > 1) fail("ambiguous_receipt", "Conflicting native worker identities in the original launch reply");
	return text([...ids][0], "native worker identity");
}

/** @param {Run} run @param {import("./model.js").NativeCall} e @param {unknown} raw @param {boolean} automatic */
export function receive(run, e, raw, automatic) {
	const value = record(raw);
	if (automatic && value.resultType === "failure" && value.error === "This session management tool is disabled" &&
		!value.structuredContent && !value.textResultForLlm && (e.tool === "create_session" || e.tool === "send_session_message")) {
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
		e.nativeId = workerId(value, e.args.name);
		e.boundAt = Date.now();
		if (current(run, e)) {
			const entry = assignee(run, e);
			if (entry)
				entry.worker = e.nativeId;
		}
	}
	else if (e.tool === "bash") {
		const telemetry = record(value.toolTelemetry ?? {}), properties = record(telemetry.properties ?? {});
		const exit = record(telemetry.metrics ?? {}).exit_code;
		if (!e.runnerStarted && properties.executionMode === "sync" && properties.shell_error_category === "command_nonzero_exit" &&
			typeof exit === "number" && Number.isSafeInteger(exit) && exit > 0) {
			e.state = "done";
			block(run, e, `Check launcher exited ${exit} before the evaluator started; no check result. Verify Node.js with node:sqlite is on the shell PATH.`);
			return;
		}
		fail("missing_receipt", "The pinned runner has not finished");
	}
	else if (e.tool === "session.send") text(value.messageId, "admitted notice");
	else if (!(typeof value.textResultForLlm === "string" && /^(?:Queued\.?$|Message accepted for priority delivery to session '[^\n]+'\.)/.test(value.textResultForLlm))
		&& !(value.structuredContent && ["accepted", "queued", "delivered"].includes(String(record(value.structuredContent).status))))
		fail("missing_receipt", "Message queue admission was not confirmed");
	e.state = "done";
	delete e.error;
}
