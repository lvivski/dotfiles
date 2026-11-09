import { request } from "./client.mjs";
import { FoundryWire } from "./contracts.mjs";

/** @param {{
 * token: string,
 * isNative: () => boolean,
 * refresh: () => Promise<void>,
 * reportError: (message: string) => void,
 * }} dependencies */
export function createActions({ token, isNative, refresh, reportError }) {
	/** @type {Set<string>} */
	const pendingPlanActions = new Set();

	/**
	 * Executes a confirmed, token-authenticated canvas mutation.
	 *
	 * @param {Record<string, unknown>} body
	 * @returns {Promise<void>}
	 */
	async function action(body) {
		try {
			const value = await request("api/action", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-foundry-token": token,
				},
				body: JSON.stringify({ ...body, ...(!isNative() ? { confirmed: true } : {}) }),
			});
			const outcome = value == null ? null : FoundryWire.record(value);
			if (outcome?.status === "error" || outcome?.status === "halted") {
				throw new Error(typeof outcome.error === "string" ? outcome.error : `Workflow ${outcome.runId} settled as ${outcome.status}; inspect the original run.`);
			}
		} finally {
			void refresh();
		}
	}

	/** @param {Record<string, unknown>} body @param {HTMLElement} button @param {() => object | null} fallback */
	async function planAction(body, button, fallback) {
		const key = `${body.action}:${body.candidateId ?? body.taskId ?? body.approvalType ?? ""}`;
		if (pendingPlanActions.has(key)) return;
		const fields = isNative() ? {} : fallback();
		if (!fields) return;
		pendingPlanActions.add(key);
		reportError("");
		button.setAttribute("disabled", "");
		try {
			await action({ ...body, ...fields });
		} catch (error) {
			reportError(FoundryWire.errorMessage(error));
		} finally {
			pendingPlanActions.delete(key);
			button.removeAttribute("disabled");
		}
	}
	return { action, planAction };
}
