import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

import { loadWorkflowPlan, persistWorkflowPlan } from "./plans.mjs";
import { tmpDir, withFakeEnv } from "./fixtures/support.mjs";

test("persisted workflow plans bind script, args, and hard limits", () =>
	withFakeEnv({ CWF_PLANS_DIR: tmpDir() }, () => {
		const plan = persistWorkflowPlan({
			source: "export const meta = { name: \"test\", description: \"test workflow\" };\nreturn \"ok\";",
			args: { x: 1 },
			cfg: { cwd: tmpDir(), budget: 10, model: "m", progressMode: "dashboard" },
			plannedAgents: 3,
		});
		const loaded = loadWorkflowPlan(plan.planId);
		assert.equal(loaded.maxAgents, 3);
		assert.deepEqual(loaded.args, { x: 1 });
		appendFileSync(loaded.scriptPath, "\n// changed");
		assert.equal(loadWorkflowPlan(plan.planId), null);
	}));
