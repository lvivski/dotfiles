import { randomUUID } from "node:crypto";
import { currentReview } from "./graph.mjs";
import { admitted, expired } from "./native.mjs";
import { commitAt } from "./product.mjs";
import { presentation, questions, reviews } from "./reviews.mjs";
import { fail } from "./values.mjs";

/** @typedef {{review:string,presentation:string}} Recovery */
const stale = () => fail("stale_question", "This charter question or presentation is not current; read foundry_status.");

/** Claim the charter decision before opening its dialog. Native writer requests have
 * their own identity and never answer (or suppress) a scout's question.
 * @param {string} cwd @param {()=>ReturnType<typeof import("./database.mjs").openDatabase>|undefined} liveStore
 * @param {string} id @param {string} owner @param {Parameters<typeof import("./runtime.mjs").createRuntime>[1]} host
 * @param {()=>Promise<boolean>} executable @param {()=>Promise<void>} wake @param {Recovery} [recover] */
export async function presentQuestions(cwd, liveStore, id, owner, host, executable, wake, recover) {
	do {
		const block = await host.permissionBlocker();
		if (!host.ask || block || !await executable()) {
			if (recover) fail("question_unavailable", block?.message ?? "The owner session cannot present a question now.");
			return;
		}
		const store = liveStore();
		if (!store) return;
		let reviewId = "";
		const next = recover && randomUUID();
		const claimed = store.change(id, run => {
			reviewId = "";
			if (recover) {
				if (run.owner !== owner) fail("foreign_run", "Only the run owner can recover its question");
				admitted(run);
			} else if (!run.active || expired(run) || run.owner !== owner) return;
			const target = recover && commitAt(cwd, run.policy.target);
			const q = questions(run).find(r => (recover
				? r.id === recover.review && r.observation?.ownerInput && presentation(r) === recover.presentation
				: !r.decision) && currentReview(cwd, run, r, target));
			if (recover && !q) stale();
			if (!q?.observation) return;
			q.decision = { status: "presenting", ...(next ? { presentation: next } : {}) };
			reviewId = q.id;
			if (target) return () => commitAt(cwd, run.policy.target) === target;
		});
		const q = reviews(claimed).find(r => r.id === reviewId);
		if (!q?.observation) return;
		const label = `${q.squad} at ${q.base}: ${q.observation.reason}\nEvidence: ${q.observation.evidence.join(", ")}`;
		/** @type {NonNullable<import("./model.js").Review["decision"]>} */ let decision;
		try {
			const answer = await host.ask(`Foundry ${id}: ${label}\nClarify within the committed brief for one fresh review. This cannot change the contract or approve permissions.`);
			decision = answer?.trim() ? { status: "answered", answer } : { status: "dismissed" };
		} catch {
			decision = { status: "unavailable", presentation: next ?? reviewId,
				reason: "Question delivery is unconfirmed. Only an explicit owner request can reopen it." };
			host.log?.(`Foundry ${id}: ${decision.reason}`);
		}
		// Record a reply even in plan mode or through a pause. Only dispatch needs permission to run.
		if (!liveStore()) return;
		let ready = false;
		store.change(id, run => {
			ready = false;
			const q = reviews(run).find(r => r.id === reviewId);
			if (!q || presentation(q) !== (next ?? reviewId)) {
				if (recover) stale();
				return;
			}
			const target = recover && commitAt(cwd, run.policy.target);
			const current = (recover || decision.status === "answered") && !expired(run) && currentReview(cwd, run, q, target);
			if (recover && (!current || !questions(run).includes(q))) stale();
			q.decision = decision;
			if (decision.status === "answered" && current) {
				if (run.goal) delete run.goal.stall;
				ready = run.active;
			}
			if (target) return () => commitAt(cwd, run.policy.target) === target;
		});
		if (ready) await wake();
	} while (!recover);
}
