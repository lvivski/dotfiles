import { isDeepStrictEqual } from "node:util";
import { currentReview } from "./graph.mjs";
import { awaitingReply, current, expired } from "./native.mjs";
import { questions, reviews } from "./reviews.mjs";
import { fail, record, text } from "./values.mjs";

/** Read only the request identity from a get_session call targeted at this bound writer.
 * The question and its choices belong to the native request, not to Foundry.
 * @param {string} writer @param {unknown} result */
export function writerRequest(writer, result) {
	const response = record(result);
	if (response.resultType !== "success") fail("session_unavailable", "Could not inspect the writer's native input state");
	const s = record(response.structuredContent ?? JSON.parse(text(response.textResultForLlm, "writer session")));
	if (s.id !== writer) fail("session_unavailable", "Native input state belongs to a different or unidentified session");
	const input = s.awaiting_input ?? (Array.isArray(s.awaiting_inputs) ? s.awaiting_inputs[0] : undefined);
	if (input) return text(record(input).request_id, "native request ID");
	if (s.awaiting_user_input === false) return null;
	fail("session_unavailable", "Native input state or request ID is unavailable");
}

/** Only current assignments can already be asking on this run's behalf.
 * A null slot is a possibly created writer with no trustworthy native identity yet.
 * @param {import("./model.js").Run} run @returns {(string|null)[]} */
function writerBindings(run) {
	const bound = new Set(Object.values(run.nodes).flatMap(n =>
		n.worker && (n.state === "waiting" || n.state === "writing" || n.state === "checking") ? [n.worker] : []));
	const unconfirmed = run.effects.some(e => e.kind === "writer" && awaitingReply(e) && current(run, e));
	return unconfirmed ? [...bound, null] : [...bound];
}
/** @param {(string|null)[]} writers @param {((writer:string)=>Promise<string|null>)|undefined} lookup
 * @returns {Promise<Extract<NonNullable<import("./model.js").Review["decision"]>,{status:"writer"|"unavailable"}>|undefined>} */
async function outstandingInput(writers, lookup) {
	let unknown = "";
	for (const writer of writers) {
		if (!writer) { unknown ||= "A writer launch is unconfirmed; check its original native call before asking."; continue; }
		try {
			if (!lookup) throw Error("Native session inspection unavailable");
			const request = await lookup(writer);
			if (request) return { status: "writer", writer, request };
		} catch {
			unknown ||= `Check the original input in writer ${writer}; Foundry could not verify its native request state.`;
		}
	}
	if (unknown) return { status: "unavailable", reason: unknown };
}

/** No scheduler wake waits for a human answer. Claim before asking: after disconnect the
 * question remains in status, but an unconfirmed dialog is never presented twice.
 * @param {string} cwd @param {ReturnType<typeof import("./database.mjs").openDatabase>} store
 * @param {string} id @param {string} owner @param {Parameters<typeof import("./runtime.mjs").createRuntime>[1]} host
 * @param {()=>Promise<boolean>} executable */
export async function presentQuestions(cwd, store, id, owner, host, executable) {
	while (host.ask && await executable()) {
		const run = store.read(id);
		if (!run?.active || expired(run) || run.owner !== owner) return;
		const q = questions(run).find(r => !r.decision && currentReview(cwd, run, r));
		if (!q?.observation || await host.permissionBlocker()) return;
		const writers = writerBindings(run), existing = await outstandingInput(writers, host.writerInput);
		if (!await executable() || await host.permissionBlocker()) return;
		let claimed = false;
		store.change(id, r => {
			claimed = false;
			const live = questions(r).find(v => v.id === q.id);
			if (!live || !r.active || expired(r) || live.decision || !currentReview(cwd, r, live) ||
				!isDeepStrictEqual(writers, writerBindings(r))) return;
			live.decision = existing ?? { status: "presenting" };
			claimed = true;
		});
		if (!claimed) continue;
		const label = `${q.squad} at ${q.base}: ${q.observation.reason}\nEvidence: ${q.observation.evidence.join(", ")}`;
		if (existing) {
			host.log?.(`Foundry ${id}: ${label}\n${existing.status === "writer" ? `See writer ${existing.writer}'s existing native request ${existing.request}. No duplicate question was asked.` : existing.reason}`);
			continue;
		}
		/** @type {import("./model.js").Review["decision"]} */ let decision;
		try {
			const answer = await host.ask(`Foundry ${id}: ${label}\nAnswer for context only. This cannot change the committed brief, resume work or approve permissions.`);
			decision = answer?.trim() ? { status: "answered", answer } : { status: "dismissed" };
		} catch {
			decision = { status: "unavailable", reason: "Could not confirm question delivery. Read the question in foundry_status; it will not be sent again." };
			host.log?.(`Foundry ${id}: ${decision.reason}`);
		}
		if (!await executable()) return;
		store.update(id, r => {
			const review = reviews(r).find(v => v.id === q.id);
			if (review?.decision?.status === "presenting") review.decision = decision;
		});
	}
}
