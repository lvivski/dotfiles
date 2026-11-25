import { randomUUID } from "node:crypto";
import { unownedBlockers } from "./blockers.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { fileURLToPath } from "node:url";
import { productPin, qualifiedProduct } from "./evidence.mjs";
import { targetsWriter } from "./plan.mjs";
import { productOwnership } from "./transfer.mjs";
import { partitionConflict } from "./partition.mjs";
import { currentCheck, unissued } from "./reservation.mjs";
import { questions, reading } from "./reviews.mjs";
import { activeDelivery } from "./batch.mjs";
import { deadlineAt, digest, fail, record, text } from "./values.mjs";

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
const noticeRun = value => /^Foundry (?:decision|handoff|artifact|escalation): ([A-Za-z0-9][A-Za-z0-9._-]*) (?:[a-f0-9-]{36}|[a-f0-9]{64})\n/.exec(value)?.[1];

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

/** @param {Run} run @param {string} issuer @param {string} token @param {"repair"|"decision"|"handoff"|"artifact"|"escalation"} kind
 * @param {string} body @param {import("./model.js").Node} [node] @param {import("./model.js").Inventory} [baseline] */
export function reserveNotice(run, issuer, token, kind, body, node, baseline) {
	const to = node ? text(node.worker, "assigned writer") : run.owner;
	const message = `${kind === "repair" ? marker(run.id, token) : `Foundry ${kind}: ${run.id} ${kind === "artifact" ? randomUUID() : token}`}\n${body}`;
	run.effects.push({ id: randomUUID(), issuer, token, state: "ready", kind, ...(node ? { grain: node.grain.id } : {}), ...(baseline ? { baseline } : {}),
		tool: to === issuer ? "session.send" : "send_session_message",
		args: to === issuer ? { message } : { session_id: to, delivery_mode: "immediate", message } });
}

/** @param {Run} run @param {string} issuer @param {string} token @param {string} base @param {string} brief @param {string|undefined} agent @param {string} grain @param {import("./model.js").CandidateReuse} [reuse] @param {import("./model.js").Observer} [observer] @param {import("./model.js").Production} [production] */
export function reserveWorker(run, issuer, token, base, brief, agent, grain, reuse, observer,production) {
	const id = randomUUID();
	const restoration=!observer && !production && run.nodes[grain]?.restoration;
	run.effects.push({ id, issuer, token, state: "ready", kind: "writer", grain, ...(reuse ? {reuse} : {}), ...(restoration && {restoration}), ...(observer && {observer}), ...(production && {production}),
		tool: "create_session", args: {
			name: `${grain.slice(0, 22)} ${token.slice(0, 8)}`, workspace_type: "worktree", base_branch: base,
			coordinate_with_creator: true, notify_on_idle: "once", kickoff: { mode: "autopilot", prompt: `${marker(run.id, token)}\n${brief}`, ...(agent ? { agent } : {}) }
		} });
	return id;
}

/** @param {Run} run @param {string} issuer @param {string} cwd @param {string} commit @param {string} check @param {string} [grain]
 * @param {import("./model.js").ArtifactReport} [reports] @param {import("./model.js").NativeCall["rerun"]} [rerun] */
export function reserveCheck(run, issuer, cwd, commit, check, grain, reports, rerun) {
	const id = randomUUID();
	const kind = rerun ? "rerun" : grain ? "component" : check === run.policy.goalCheck ? "goal" : "product";
	const evaluatorRevision = kind === "goal" ? run.repins?.at(-1)?.revision : kind === "product" ? productPin(run) : undefined;
	const productEvaluatorRevision = kind === "goal" && productPin(run);
	run.effects.push({
		id, issuer, kind, state: "ready", tool: "bash", commit, check, ...(evaluatorRevision ? { evaluatorRevision } : {}),
		...(productEvaluatorRevision ? {productEvaluatorRevision} : {}), ...(grain ? { grain } : {}), ...(rerun && {rerun}), ...reports,
		args: {
			command: `command node ${[runner, cwd, run.id, id].map(quote).join(" ")}`, shellId: `foundry-${id}`, initial_wait: 120,
			description: `Check ${grain ?? (kind === "goal" ? "final goal" : "joined product")} at ${commit.slice(0, 12)}`.slice(0, 100)
		}
	});
	return id;
}

/** @param {Run} run @param {string} issuer @param {string} cwd @param {string} target @param {string} commit @param {Record<string,string>} outputs */
export function reserveProduct(run, issuer, cwd, target, commit, outputs) {
	const conflict=partitionConflict(run,outputs,target);
	if (conflict) fail("ownership_transition",conflict);
	const ownership=productOwnership(run.nodes,outputs);
	run.join = { target, commit, outputs, ...(ownership && {ownership}), check: reserveCheck(run, issuer, cwd, commit, run.policy.productCheck) };
}

/** @param {Run} run */
export const expired = run => run.policy.deadline !== undefined && Date.now() >= (deadlineAt(run.policy.deadline) ?? -Infinity);

/** @param {Run} run @param {Effect} e */
function assignee(run, e) {
	return e.grain ? run.nodes[e.grain] : undefined;
}

/** @param {Run} run @param {Effect} e */
export function current(run, e) {
	if (e.tool === "bash") return currentCheck(run, e);
	if (e.state === "retired" || e.state === "withdrawn") return false;
	if (e.tool === "workflow")
		return reading(e);
	if (e.kind === "decision")
		return questions(run).some(r => r.id === e.token && !r.decision);
	if (e.kind === "escalation")
		return unownedBlockers(run, remainingAssignments(run)).some(g => g.detail === e.token);
	if (e.kind === "handoff") {
		const product = run.products.at(-1);
		return !!product?.qualifiedAt && product.check === e.token;
	}
	return targetsWriter(assignee(run, e), e);
}

/** @param {Run} run @param {boolean} [resume] */
export function admitted(run,resume=false) {
	if (!resume && activeDelivery(run)) fail("dispatch_held","An approved test delivery is in progress");
	const final = run.goal && qualifiedProduct(run);
	if (final) fail("goal_met", `Goal met at ${final.commit}`);
	if (!run.active)
		fail("paused", run.pauseReason ?? "Foundry is paused");
	if (expired(run))
		fail("deadline", "The authorized deadline has elapsed");
}

/** @param {Run} run @param {string} actor @param {string} token */
export function boundWriter(run, actor, token) {
	const n = Object.values(run.nodes).find(n => n.worker === actor && n.token === token);
	if (!n || n.state==="qualified" && run.effects.some(e=>e.kind==="writer" && e.pooled && e.id!==n.workspace && e.grain!==n.grain.id &&
		(e.nativeId===actor || e.args.session_id===actor || e.tool==="session.send" && e.issuer===actor) && current(run,e)))
		fail("stale_assignment", "No current worker assignment matches this token");
	return n;
}

/** A final handoff may notify its owner after goal acceptance. It cannot authorize work.
 * @param {Run} run @param {Effect} e */
export const canDispatch = (run, e) => (run.active && !expired(run) || e.kind === "handoff" && !!run.goal) && current(run, e);

/** Only an unclaimed create from a finished issuer can move. An ordinary/manual
 * call has already visited a native route, even if it has no worker ID yet.
 * @param {Run} run @param {Effect} e */
export function transferableWriter(run, e) {
	return e.kind === "writer" && e.tool === "create_session" && e.issuer !== run.owner && e.state === "ready" &&
		e.callId === undefined && e.nativeId === undefined && e.permissionHold === undefined && !assignee(run, e)?.worker &&
		current(run, e) && Object.values(run.nodes).some(n => n.worker === e.issuer && (n.state === "published" || n.state === "qualified"));
}

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

/** @param {Run} run @param {import("./model.js").NativeCall} e @param {string} reason */
function block(run, e, reason) {
	e.error = reason;
	if (e.kind === "artifact" || e.kind === "rerun" || e.delivery || !current(run, e))
		return;
	const n = assignee(run, e);
	if (e.production && n && e.state==="refused") {
		run.nodes[n.grain.id]=structuredClone(e.production.prior);
		return;
	}
	if (e.remedy) return; // Settle the two observations together, never block the untouched peer.
	if (n) {
		n.state = "blocked";
		n.reason = reason;
	} else if (e.kind === "goal")
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
		const id = workerId(value, e.args.name);
		if (e.claims?.some(c => c.actor !== id))
			fail("ambiguous_receipt", "Original launch reply conflicts with a proven writer claim");
		e.nativeId = id;
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
		if (!e.runnerStarted && !e.runnerClaim && !e.receipt && properties.executionMode === "sync" && properties.shell_error_category === "command_nonzero_exit" &&
			typeof exit === "number" && Number.isSafeInteger(exit) && exit > 0) {
			e.state = "done";
			e.launcherExit = exit;
			block(run, e, `Check launcher exited ${exit} before the evaluator started; no check result.` +
				(exit === 127 ? " Check that Node.js is available on the shell PATH." : " Inspect the original shell diagnostic."));
			return;
		}
		fail("missing_receipt", "The pinned runner has not finished");
	}
	else if (e.tool === "session.send") text(value.messageId, "admitted notice");
	else if (!(typeof value.textResultForLlm === "string" && /^(?:Queued\.?$|Message accepted for priority delivery to session '[^\n]+'\.)/.test(value.textResultForLlm))
		&& !(value.structuredContent && ["accepted", "queued", "delivered"].includes(String(record(value.structuredContent).status))))
		fail("missing_receipt", "Message queue admission was not confirmed");
	if (e.kind === "writer" && e.pooled) {
		e.nativeId = e.tool === "session.send" ? e.issuer : text(e.args.session_id,"pooled recipient");
		e.boundAt = Date.now();
		const n = assignee(run,e);
		if (n && current(run,e)) n.worker = e.nativeId;
	}
	e.state = "done";
	delete e.error;
}
