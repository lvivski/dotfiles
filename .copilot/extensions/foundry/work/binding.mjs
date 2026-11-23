import { realpathSync } from "node:fs";
import { admitted, assignment, current } from "./native.mjs";
import { commitAt, git, rootAt } from "./product.mjs";
import { refusedCall } from "./recovery.mjs";
import { digest, fail, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} NativeCall */
/** @typedef {import("@github/copilot-sdk").CopilotSession["rpc"]["eventLog"]["read"]} Reader */
/** @param {Run} run @param {string} grain */
export function reservation(run, grain) {
	admitted(run);
	const n = run.nodes[grain], matches = run.effects.filter(e => e.kind === "writer" && e.grain === grain && current(run, e));
	const [e] = matches;
	if (matches.length !== 1 || e.kind !== "writer" || e.tool !== "create_session" || e.state !== "uncertain" ||
		!e.callId || e.nativeId || e.permissionHold || !n?.generation || n.worker || n.generation !== e.args.base_branch ||
		e.args.workspace_type !== "worktree" || e.args.coordinate_with_creator !== true ||
		run.effects.some(other => other !== e && (other.callId === e.callId && other.issuer === e.issuer || other.kind === "writer" && other.token === e.token)))
		fail("stale_assignment", "No unique current uncertain, unbound writer reservation");
	const prompt = text(record(e.args.kickoff).prompt, "reserved kickoff"), marker = assignment(prompt);
	if (marker?.run !== run.id || marker.token !== n.token) fail("invalid_reservation", "Kickoff does not match this assignment");
	return { e, prompt, generation: n.generation };
}

/** @param {Reader} read @param {NonNullable<Parameters<Reader>[0]["types"]>} types */
async function* history(read, types) {
	const seen = new Set();
	let cursor;
	for (;;) {
		const page = await read({ view: "history", direction: "forward", includeEphemeral: false, agentScope: "primary", types, cursor, max: 256 });
		if (page.cursorStatus !== "ok") fail("missing_history", "Original native history is unavailable");
		for (const event of page.events) {
			const d = record(event.data);
			if (!event.agentId && !event.checkpoint && !d.agentId && !d.parentToolCallId) yield event;
		}
		if (!page.hasMore) return;
		if (seen.has(page.cursor)) fail("missing_history", "Original native history cursor did not advance");
		seen.add(page.cursor); cursor = page.cursor;
	}
}

/** Parentage is immutable; observe it outside the lock and bind only if the generation still matches.
 * @param {string} origin @param {string} generation */
export function verifyGeneration(origin, generation) {
	if (/^parent /m.test(git(origin, ["cat-file", "-p", generation]).toString().split("\n\n")[0]))
		fail("wrong_worktree", "Expected the original parentless generation");
}

/** Mutable worktree identity and HEAD must still be checked at binding.
 * @param {string} path @param {string} generation @param {string} origin */
export function linkedGeneration(path, generation, origin) {
	const dir = (/** @type {string} */ cwd, /** @type {string} */ flag) =>
		realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", flag]).toString().trim());
	const common = dir(origin, "--git-common-dir");
	if (rootAt(path) !== path || dir(path, "--git-common-dir") !== common || dir(path, "--git-dir") === common ||
		commitAt(path, "HEAD") !== generation ||
		!git(origin, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0\0").some(row =>
			row.startsWith(`worktree ${path}\0HEAD ${generation}\0`)))
		fail("wrong_worktree", "Not the linked writer worktree at the original parentless generation");
}

/** A normal App get_session receipt supplies the creation edge; a copied workspace
 * envelope, tool-shaped prose or onSessionStart.initialPrompt does not.
 * @param {Reader} read @param {string} actor @param {string} path @param {ReturnType<typeof reservation>} job */
export async function childProof(read, actor, path, { e, generation, prompt }) {
	let start, kickoff, identity;
	const lookups = new Set();
	for await (const ev of history(read, ["session.start", "user.message", "external_tool.requested", "tool.execution_complete"])) {
		if (ev.type === "session.start") {
			if (start || kickoff || ev.parentId !== null || ev.data.sessionId !== actor || ev.data.context?.cwd !== path || ev.data.context.headCommit !== generation)
				fail("wrong_origin", "Missing original writer session.start at this path and generation");
			start = ev.id;
		} else if (ev.type === "user.message" && !kickoff) {
			if (!start || ev.data.content !== prompt || ev.data.source !== `agent-${e.issuer}`)
				fail("wrong_kickoff", "The first native user.message is not this issuer's exact reserved kickoff");
			kickoff = ev.id;
		} else if (ev.type === "external_tool.requested" && ev.data.toolName === "get_session" && ev.data.sessionId === actor &&
			!ev.data.providerId && typeof record(ev.data.arguments).project_session_id === "string") {
			lookups.add(ev.data.toolCallId);
		} else if (ev.type === "tool.execution_complete" && lookups.delete(ev.data.toolCallId) && ev.data.success) {
			const content = ev.data.result?.content;
			if (typeof content !== "string" || !content.trim().startsWith("{")) continue;
			const info = record(JSON.parse(content));
			if (info.id !== actor && info.active_session_id !== actor) continue;
			if (info.active_session_id && info.active_session_id !== actor || info.creator_session_id !== e.issuer ||
				info.path !== path || info.session_type !== "worktree") fail("wrong_child", "App session identity, creator or worktree does not match");
			identity = ev.id;
		}
	}
	if (!start || !kickoff || !identity)
		fail("missing_origin", "Need native session.start, the first issuer-sourced user.message and a successful ordinary App get_session lookup of this writer in its own history");
	return { actor, path, start, kickoff, identity };
}

/** @param {Reader} read @param {ReturnType<typeof reservation>} job */
export async function issuerProof(read, { e, prompt }) {
	let request, dismissed = false, started = false;
	const requests = new Set();
	for await (const ev of history(read, ["external_tool.requested", "external_tool.completed", "tool.execution_start", "tool.execution_complete", "permission.completed"])) {
		if (ev.type === "external_tool.completed") {
			if (request && ev.data.requestId === request) {
				if (dismissed) fail("ambiguous_receipt", "Duplicate native request dismissal");
				dismissed = true; // Dismissal is not a launch receipt.
			}
			continue;
		}
		if (ev.type === "external_tool.requested" || ev.type === "tool.execution_start") {
			const d = ev.data;
			if (ev.type === "external_tool.requested") {
				if (requests.has(ev.data.requestId) && (ev.data.toolCallId === e.callId || ev.data.requestId === request))
					fail("ambiguous_receipt", "Conflicting original external request identity");
				requests.add(ev.data.requestId);
			}
			if (d.toolName === "create_session" || d.toolName === "send_session_message") {
				const a = record(d.arguments), k = a.kickoff;
				if ((k && record(k).prompt === prompt || a.message === prompt) && d.toolCallId !== e.callId)
					fail("ambiguous_receipt", "Another native call used the reserved kickoff");
			}
			if (d.toolCallId !== e.callId) continue;
			if (d.toolName !== "create_session" || digest(d.arguments) !== digest(e.args))
				fail("wrong_request", "Original native call does not match the reserved create_session arguments");
			if (ev.type === "external_tool.requested") {
				if (request || ev.data.sessionId !== e.issuer || ev.data.providerId)
					fail("ambiguous_receipt", "Conflicting original external request or issuer");
				request = text(ev.data.requestId, "native request ID");
			} else if (started) fail("ambiguous_receipt", "Conflicting original tool starts");
			else started = true;
		} else if (ev.type === "tool.execution_complete" && ev.data.toolCallId === e.callId || refusedCall(ev) === e.callId)
			fail("conflicting_receipt", "Original call has a native completion or refusal; do not bind by claim");
	}
	if (!request || !dismissed) fail("missing_request", "Missing the issuer's exact external_tool.requested and its matching UI dismissal; do not replay creation");
	return request;
}
