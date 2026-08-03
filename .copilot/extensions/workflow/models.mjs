/** @module models — model-setting normalization and compatibility checks. */

/** @param {unknown} value @returns {string|null} */
export function normalizeModelId(value) {
	if (typeof value !== "string") return null;
	const model = value.trim();
	if (!model) return null;
	const keyword = model.toLowerCase();
	return keyword === "auto" || keyword === "inherit" ? keyword : model;
}

/**
 * Return a validation error for an incompatible model/effort pair.
 * Missing catalog metadata is not an error because the child session remains authoritative.
 * @param {string|null|undefined} model
 * @param {string|null|undefined} effort
 * @param {unknown[]} [models]
 * @returns {string|null}
 */
export function modelEffortError(model, effort, models = []) {
	if (!effort || !model) return null;
	if (model === "auto") {
		return `model "auto" cannot be combined with reasoning effort "${effort}"; choose a concrete model or omit effort`;
	}
	const info = models.find((candidate) => candidate && typeof candidate === "object" && /** @type {any} */ (candidate).id === model);
	if (!info) return null;
	const supported = /** @type {any} */ (info).supportedReasoningEfforts;
	if (Array.isArray(supported) && !supported.includes(effort)) {
		return `model "${model}" does not support reasoning effort "${effort}" (supported: ${supported.join(", ") || "none"})`;
	}
	if (/** @type {any} */ (info).capabilities?.supports?.reasoningEffort === false) {
		return `model "${model}" does not support reasoning effort configuration`;
	}
	return null;
}

/**
 * Pure run-level model policy. Callers decide how to surface `error` and `warning`.
 * @param {any} input
 * @param {boolean} preset
 * @param {{ modelId?: string|null, models?: unknown[] }|undefined} parent
 */
export function resolveModelSettings(input, preset, parent) {
	const requested = normalizeModelId(input.model);
	const inherit = requested === "inherit" || (preset && requested == null);
	const parentModel = normalizeModelId(parent?.modelId);
	if (requested === "inherit" && !parentModel) {
		return { model: null, effort: null, context: null, warning: null, error: 'model "inherit" requires an initialized parent session model' };
	}
	let model = inherit ? parentModel || "auto" : requested;
	let effort = input.effort ?? (preset ? "xhigh" : null);
	let context = input.context ?? (preset ? "long_context" : null);
	let warning = null;
	const legacyPlan = !!input._planId;
	if (model === "auto" && effort && ((preset && input.effort == null) || legacyPlan)) {
		effort = null;
		if ((preset && input.context == null) || legacyPlan) context = null;
		warning = "workflow: Auto routing cannot apply the xtreme effort/context overrides; using the selected Auto model's defaults";
	}
	let error = modelEffortError(model, effort, parent?.models);
	if (error && effort && ((preset && input.effort == null) || legacyPlan)) {
		effort = null;
		warning = `workflow: ${error}; using the model's default reasoning effort`;
		error = null;
	}
	return { model, effort, context, warning, error };
}
