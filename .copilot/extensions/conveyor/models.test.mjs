/** @module models.test — pure run model resolution. */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveModelSettings } from "./models.mjs";

test("xtreme binds a concrete parent model and degrades safely when the parent uses Auto", () => {
	const models = [{ id: "gpt-5.6-sol", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }];
	assert.deepEqual(resolveModelSettings({}, true, { modelId: "gpt-5.6-sol", models }), {
		model: "gpt-5.6-sol",
		effort: "xhigh",
		context: "long_context",
		warning: null,
		error: null,
	});
	const auto = resolveModelSettings({}, true, { modelId: "auto", models });
	assert.equal(auto.model, "auto");
	assert.equal(auto.effort, null);
	assert.equal(auto.context, null);
	assert.match(auto.warning ?? "", /Auto routing/);
	assert.match(resolveModelSettings({ model: "auto", effort: "xhigh" }, false, { modelId: "gpt-5.6-sol", models }).error ?? "", /cannot be combined/);
	assert.match(resolveModelSettings({ model: "inherit" }, false, undefined).error ?? "", /requires an initialized parent/);
	assert.equal(resolveModelSettings({ model: "Inherit" }, false, { modelId: "gpt-5.6-sol", models }).model, "gpt-5.6-sol");
	const unsupported = resolveModelSettings({}, true, {
		modelId: "claude-haiku-4.5",
		models: [{ id: "claude-haiku-4.5", capabilities: { supports: { reasoningEffort: false } } }],
	});
	assert.equal(unsupported.model, "claude-haiku-4.5");
	assert.equal(unsupported.effort, null);
	assert.equal(unsupported.context, "long_context");
	assert.match(unsupported.warning ?? "", /default reasoning effort/);
	assert.match(resolveModelSettings({ model: "claude-haiku-4.5", effort: "high" }, false, {
		modelId: "gpt-5.6-sol",
		models: [{ id: "claude-haiku-4.5", capabilities: { supports: { reasoningEffort: false } } }],
	}).error ?? "", /does not support reasoning effort/);
});
