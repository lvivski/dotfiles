import { currentReview } from "./graph.mjs";
import { expired } from "./native.mjs";
import { questions, reviews } from "./reviews.mjs";

/** Claim the charter decision before opening its dialog. Native writer requests have
 * their own identity and never answer (or suppress) a scout's question.
 * @param {string} cwd @param {()=>ReturnType<typeof import("./database.mjs").openDatabase>|undefined} liveStore
 * @param {string} id @param {string} owner @param {Parameters<typeof import("./runtime.mjs").createRuntime>[1]} host
 * @param {()=>Promise<boolean>} executable @param {()=>Promise<void>} wake */
export async function presentQuestions(cwd, liveStore, id, owner, host, executable, wake) {
	while (host.ask && await executable() && !await host.permissionBlocker()) {
		const store = liveStore();
		if (!store) return;
		let reviewId = "";
		const claimed = store.change(id, run => {
			reviewId = "";
			if (!run.active || expired(run) || run.owner !== owner) return;
			const q = questions(run).find(r => !r.decision && currentReview(cwd, run, r));
			if (!q?.observation) return;
			q.decision = { status: "presenting" };
			reviewId = q.id;
		});
		const q = reviews(claimed).find(r => r.id === reviewId);
		if (!q?.observation) return;
		const label = `${q.squad} at ${q.base}: ${q.observation.reason}\nEvidence: ${q.observation.evidence.join(", ")}`;
		/** @type {NonNullable<import("./model.js").Review["decision"]>} */ let decision;
		try {
			const answer = await host.ask(`Foundry ${id}: ${label}\nClarify within the committed brief for one fresh review. This cannot change the contract or approve permissions.`);
			decision = answer?.trim() ? { status: "answered", answer } : { status: "dismissed" };
		} catch {
			decision = { status: "unavailable", reason: "Question delivery is unconfirmed; see the original review. It will not be asked again." };
			host.log?.(`Foundry ${id}: ${decision.reason}`);
		}
		// Record a reply even in plan mode or through a pause. Only dispatch needs permission to run.
		if (!liveStore()) return;
		let ready = false;
		store.change(id, run => {
			ready = false;
			const q = reviews(run).find(r => r.id === reviewId);
			if (q?.decision?.status !== "presenting") return;
			q.decision = decision;
			if (decision.status === "answered" && !expired(run) && currentReview(cwd, run, q)) {
				if (run.goal) delete run.goal.stall;
				ready = run.active;
			}
		});
		if (ready) await wake();
	}
}
