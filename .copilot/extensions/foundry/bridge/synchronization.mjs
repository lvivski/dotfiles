import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { errorCode, errorMessage } from "../data.mjs";
import { origin, pendingReceipts, receiptPresent, receiptsFor } from "./receipts.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */

/**
 * @param {ReturnType<typeof import("./authority.mjs").createAuthority>["stateFor"]} stateFor
 * @param {ReturnType<typeof import("./dispatch.mjs").createDispatchBridge>["activateEvaluation"]} activateEvaluation
 */
export function createSynchronization(stateFor, activateEvaluation) {

	/** @param {FoundryPlan} rawPlan */
	const preflight = (rawPlan) => {
		const { factory, state, plan } = stateFor(rawPlan);
		factory.preview(pendingReceipts(plan, state));
	};

	/** @param {FoundryPlan} rawPlan */
	const sync = (rawPlan) => {
		const { factory, binding, plan } = stateFor(rawPlan);
		let state = factory.snapshot();
		if (plan.evaluationTarget && binding.active !== true && !["completed", "failed", "cancelled"].includes(plan.status)
			&& !state.retirements.some((entry) => entry.type === "candidate" && entry.id === plan.factory.candidateId)) {
			activateEvaluation(plan);
			state = factory.snapshot();
		}
		let published = 0;
		for (const receipt of receiptsFor(plan, state)) {
			if (receiptPresent(state, receipt)) continue;
			factory[receipt.action]({ expectedRevision: state.revision, ...receipt.input });
			published++;
			state = factory.snapshot();
		}
		return { revision: state.revision, synchronized: true, published };
	};

	/** @param {FoundryPlan} rawPlan @param {string} taskId @param {{attemptId: string} & Record<string, unknown>} report @param {unknown} error */
	const captureRejectedReport = (rawPlan, taskId, report, error) => {
		const { factory, state, plan } = stateFor(rawPlan);
		const task = plan.tasks.find((entry) => entry.id === taskId);
		const attempt = task?.attempts.find((entry) => entry.id === report.attemptId);
		if (!task || !attempt?.sessionId) return null;
		const id = `rejected-${analysisInputDigest([plan.id, plan.factory.owner, report, errorCode(error)]).slice(0, 40)}`;
		if (state.knowledge.some((entry) => entry.id === id)) return { id };
		factory.appendKnowledge({
			expectedRevision: state.revision, id, unitId: plan.factory.unitId, kind: "observation",
			statement: `Rejected task report (${errorCode(error)}): ${errorMessage(error)}. ${stableStringify(report).slice(0, 6500)}`,
			uncertainty: "Rejected, non-governing report excerpt. The task was not completed and no assurance was accepted.",
			links: [], source: { ...origin(plan, task, attempt), at: new Date().toISOString() },
		});
		return { id };
	};
	return { preflight, sync, captureRejectedReport };
}
