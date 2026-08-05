import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

import { loadConveyorPlan, persistConveyorPlan } from "./plans.mjs";
import { tmpDir, withFakeEnv } from "./fixtures/support.mjs";

test("persisted conveyor plans bind script, args, and hard limits", () =>
	withFakeEnv({ CONVEYOR_PLANS_DIR: tmpDir() }, () => {
		const plan = persistConveyorPlan({
			source: "export const meta = { name: \"test\", description: \"test conveyor\" };\nreturn \"ok\";",
			args: { x: 1 },
			cfg: { cwd: tmpDir(), budget: 10, model: "m", progressMode: "dashboard" },
			plannedAgents: 3,
		});
		const loaded = loadConveyorPlan(plan.planId);
		assert.equal(loaded.maxAgents, 3);
		assert.deepEqual(loaded.args, { x: 1 });
		appendFileSync(loaded.scriptPath, "\n// changed");
		assert.equal(loadConveyorPlan(plan.planId), null);
	}));
