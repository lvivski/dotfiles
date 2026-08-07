import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";

import { consumeConveyorPlan, loadConveyorPlan, persistConveyorPlan } from "./plans.mjs";
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

test("consuming a persisted plan removes it once and rejects unsafe ids", () =>
	withFakeEnv({ CONVEYOR_PLANS_DIR: tmpDir() }, () => {
		const plan = persistConveyorPlan({
			source: `return "ok";`,
			args: null,
			cfg: { cwd: tmpDir(), limits: { maxAiCredits: 1 } },
			plannedAgents: 1,
		});
		assert.equal(existsSync(plan.scriptPath), true);
		assert.equal(consumeConveyorPlan(plan.planId), true);
		assert.equal(loadConveyorPlan(plan.planId), null);
		assert.equal(consumeConveyorPlan(plan.planId), false);
		assert.equal(consumeConveyorPlan("../outside"), false);
	}));
