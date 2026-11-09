import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowContext } from "./runtime.mjs";
import { ADDITIONAL_WORKFLOWS } from "./registry.mjs";

test("audit retains every verified finding regardless of narrative success", async (t) => {
	for (const narrative of [null, "", "Short narrative omitting the concrete findings."]) {
		await t.test(String(narrative), async () => {
			const workflow = createWorkflowContext({ paths: ["a.js", "b.js", "c.js"] }, (_prompt, options) => {
				if (options.label.startsWith("review:")) return `Verified issue in ${options.label.slice(7)}:42`;
				if (options.label === "verify:c.js") return null;
				if (options.label === "report") return narrative;
			});
			const result = await ADDITIONAL_WORKFLOWS.audit.run(workflow);
			assert.ok(typeof result === "string");
			assert.match(result, /Verified issue in a.js:42/);
			assert.match(result, /Verified issue in b.js:42/);
			assert.doesNotMatch(result, /Verified issue in c.js:42/);
			assert.match(result, /2 verified, 0 clean, 0 rejected, 1 failed/);
			assert.equal(workflow.calls.length, 7);
		});
	}
});
