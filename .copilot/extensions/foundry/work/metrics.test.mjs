import assert from "node:assert/strict";
import test from "node:test";
import { metricsFacts } from "./metrics.mjs";
import { usageQuery } from "../../../skills/foundry/scripts/usage.mjs";
import { activation, base, commit, run, tip, writer } from "../test/timing.mjs";

test("latencies use affirmative bindings and the exact qualifying product, not reservations, nodes or a goal checkpoint", () => {
	const r = run();
	r.goal = { commit, target: tip, check: "goal" };
	r.effects.push({ ...writer("reserved", 1), state: "ready" }, { ...writer("issued", 1), state: "issued" },
		{ ...writer("denied", 1), state: "refused" }, { ...writer("maybe", 1), state: "uncertain" });
	r.products.push({ commit: base, target: tip, outputs: {}, check: "previous" });
	assert.equal(metricsFacts(r).firstWriter.state, "unconfirmed");
	assert.equal(metricsFacts(r).qualified.commit, null);
	r.effects.push(writer("later", 30), writer("retired", 9));
	assert.deepEqual(metricsFacts(r).firstWriter, { state: "bound", boundAt: activation + 9, elapsedMs: 9, nativeIds: ["retired"] });
	r.active = false;
	assert.equal(metricsFacts(r).qualified.commit, null, "a stopped goal is not evidence that a checkpoint qualified");
	r.products.push({ commit, target: tip, outputs: { prices: base }, check: "final", qualifiedAt: activation + 99 });
	assert.deepEqual(metricsFacts(r).qualified, { commit, qualifiedAt: activation + 99, elapsedMs: 99, baseline: false });
	assert.ok(!JSON.stringify(metricsFacts(r)).includes("private-token"));
	delete r.effects.at(-1)?.boundAt;
	assert.equal(metricsFacts(r).firstWriter.elapsedMs, null, "an undated earlier binding cannot be ignored");
});

test("a qualified baseline needs no writer; paused/unfinished work and missing clocks have no finish time", () => {
	const r = run();
	r.active = false;
	r.goal = { commit: tip, target: tip, check: "goal" };
	r.products.push({ commit: tip, target: tip, outputs: {}, check: "product" });
	assert.equal(metricsFacts(r).qualified.elapsedMs, null);
	assert.equal(metricsFacts(r).firstWriter.state, "not-bound");
	r.products[0].qualifiedAt = activation + 10;
	const f = metricsFacts(r);
	assert.deepEqual(f.qualified, { commit: tip, qualifiedAt: activation + 10, elapsedMs: 10, baseline: true });
	assert.equal(f.firstWriter.state, "not-applicable"); assert.equal(f.firstWriter.elapsedMs, null);
	assert.equal(usageQuery(f).query, null); assert.equal(usageQuery(f).totalRunUsage, null);
	r.effects.push(writer("from-another-check"));
	delete r.products[0].qualifiedAt;
	assert.equal(metricsFacts(r).qualified.commit, null, "an undated checkpoint is not an accepted product");
	delete r.goal; r.products[0].qualifiedAt = activation + 6;
	assert.equal(metricsFacts(r).qualified.elapsedMs, 6, "a non-goal product qualifies at publication");
	r.products[0].qualifiedAt = activation - 1;
	assert.equal(metricsFacts(r).qualified.elapsedMs, null, "clock reversal is not zero elapsed time");
});
