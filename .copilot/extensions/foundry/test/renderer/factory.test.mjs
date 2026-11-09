import assert from "node:assert/strict";
import test from "node:test";
import { browser, buttons, disclosures, flush, posted } from "./browser.mjs";
import { factorySnapshot } from "./fixture.mjs";

test("repository-only inspection shows no fabricated plan or execution controls", async () => {
	const ui = await browser("factory-view");
	ui.requests[0].reply({
		ok: true, value: {
			...factorySnapshot(), bindingId: "factory-view", plan: null, projection: null,
			interactions: { native: false, readOnly: true },
		}
	});
	await flush();
	assert.equal(ui.nodes.get("#plan-title").textContent, "Repository factory");
	assert.match(ui.nodes.get("#surface-label").textContent, /read-only/);
	assert.equal(ui.nodes.get("#task-section").hidden, true);
	assert.equal(ui.nodes.get("#workflow-section").hidden, true);
	assert.equal(ui.nodes.get("#approve-button").hidden, true);
	assert.equal(ui.nodes.get("#cancel-plan-button").hidden, true);
	assert.equal(buttons(ui.nodes.get("#factory")).length, 0);
	assert.match(ui.nodes.get("#factory").textContent, /non-governing observation/);
});

test("contract summaries distinguish capabilities and current versus historical acceptance", async () => {
	const ui = await browser();
	const initial = factorySnapshot();
	const state = {
		...initial, factory: {
			...initial.factory, contracts: [
				{ unitId: "ledger", unitName: "Ledger", revision: 1, current: true, digest: "a", previousDigest: null, obligations: [], evaluations: [], decisionId: "ledger-decision" },
				{ unitId: "reporting", unitName: "Reporting", revision: 1, current: false, digest: "b", previousDigest: null, obligations: [], evaluations: [], decisionId: "reporting-decision" },
			]
		}
	};
	ui.requests[0].reply({ ok: true, value: state });
	await flush();
	const summaries = disclosures(ui.nodes.get("#factory")).map((row) => row.children[0].textContent);
	assert.ok(summaries.includes("Ledger (ledger) - contract v1 - current accepted"));
	assert.ok(summaries.includes("Reporting (reporting) - contract v1 - historical accepted"));
});

test("factory inspection separates authority, preserves disclosures, refreshes idle evidence and rejects older repository snapshots", async () => {
	const ui = await browser();
	ui.requests[0].reply({ ok: true, value: factorySnapshot() });
	await flush();
	const host = ui.nodes.get("#factory");
	assert.match(host.textContent, /non-governing observation/);
	assert.match(host.textContent, /<script>Not authority<\/script>/);
	assert.match(host.textContent, /Uncertain impact: reporting/);
	assert.match(host.textContent, /Existing|Generation inputs/);
	const candidate = disclosures(host).find((row) => row.children[0].textContent.startsWith("fresh -"));
	assert.ok(candidate);
	candidate.toggle(true);
	candidate.children[0].focus();
	assert.equal(ui.timers.size, 1, "Repository evidence refreshes even without active workflows");
	ui.tick();
	ui.requests[1].reply({ ok: true, value: factorySnapshot(2, ["oracle@1: expired"]) });
	await flush();
	assert.equal(disclosures(host).find((row) => row === candidate), candidate);
	assert.equal(candidate.open, true);
	assert.equal(ui.document.activeElement, candidate.children[0]);
	assert.equal(buttons(host).find((button) => button.textContent === "Select replacement")?.disabled, true);
	ui.change();
	ui.requests[2].reply({ ok: true, value: factorySnapshot(1) });
	await flush();
	assert.match(host.textContent, /oracle@1: expired/);
	ui.setHidden(true);
	assert.equal(ui.timers.size, 0);
});

test("factory evidence separates claimed human source identity, observation time and publication receipts", async () => {
	const ui = await browser();
	const state = factorySnapshot();
	ui.requests[0].reply({
		ok: true, value: {
			...state, factory: {
				...state.factory, candidates: [{
					...state.factory.candidates[0], retirementHolds: [{ owner: "coordinator", planId: "read-only-review" }], retirementHoldCount: 1,
					evaluationWork: [{ planId: "read-only-review", active: true }],
					evidence: [{
						id: "publication-receipt", evaluation: { id: "human-rubric", revision: 1 }, outcome: "passed", trust: "independent-claim",
						publicationDisposition: "historical", source: { kind: "human", ref: "fixture:actual-message", judgmentId: "actual-judgment", actor: "reviewer", at: "2026-01-01T00:01:00.000Z" },
						recordedAt: "2026-01-01T00:05:00.000Z", environment: "review-environment", workload: "review-workload", report: "Actual attributed human assessment"
					}],
				}]
			}
		}
	});
	await flush();
	const content = ui.nodes.get("#factory").textContent;
	assert.match(content, /Publication receipt: publication-receipt/);
	assert.match(content, /Claimed judgment source ID: actual-judgment/);
	assert.match(content, /Observation disposition: historical/);
	assert.match(content, /Observed: 2026-01-01T00:01:00.000Z/);
	assert.match(content, /Published: 2026-01-01T00:05:00.000Z/);
	assert.match(content, /Retirement holds: read-only-review \(coordinator\)/);
	assert.match(content, /Active: retirement held/);
});

test("candidate controls send repository revision and incumbent identity through the same serialized action path", async () => {
	const ui = await browser();
	ui.requests[0].reply({ ok: true, value: { ...factorySnapshot(), interactions: { native: true } } });
	await flush();
	const select = buttons(ui.nodes.get("#factory")).find((button) => button.textContent === "Select replacement");
	assert.ok(select);
	const pending = select.click();
	const request = ui.requests[1];
	assert.deepEqual(posted(request), {
		action: "decide-candidate", revision: 1, factoryRevision: 1, candidateId: "fresh", decision: "accept", expectedIncumbentId: "incumbent",
	});
	assert.equal(ui.prompts.length, 0);
	request.reply({ ok: true, value: { action: "decide-candidate" } });
	await pending;
	assert.equal(ui.requests[2].url, "api/plan");
	ui.requests[2].reply({ ok: true, value: factorySnapshot(2) });
	await flush();
});
