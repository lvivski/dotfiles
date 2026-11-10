import assert from "node:assert/strict";
import test from "node:test";
import { browser, flush } from "./browser.mjs";
import { factorySnapshot } from "./fixture.mjs";

test("the board exposes retrieval reasons, supersession and bounded snapshot paging guidance", async () => {
	const ui = await browser();
	const snapshot = factorySnapshot();
	ui.requests[0].reply({
		ok: true, value: {
			...snapshot, factory: {
				...snapshot.factory,
				page: { revision: 1, offset: 0, limit: 50, nextCursor: "opaque-cursor", omittedBefore: { knowledge: 0 }, omittedAfter: { knowledge: 115 } },
				truncated: { knowledge: true },
				knowledge: snapshot.factory.knowledge.map((entry) => ({
					...entry, selectionReasons: ["subject:allocation", "causal-relationship"], revisionStatus: "superseded",
					supersededBy: [{ id: entry.id, revision: 2 }], omittedSuperseders: 0,
				})),
			},
		},
	});
	await flush();
	const content = ui.nodes.get("#factory").textContent;
	assert.match(content, /Inspection snapshot 1: at most 50 records per collection/);
	assert.match(content, /115 knowledge/);
	assert.match(content, /foundry_get_factory filters and page.nextCursor/);
	assert.match(content, /Selected because: subject:allocation; causal-relationship/);
	assert.match(content, /Revision status: superseded/);
	assert.match(content, /Superseded by: .*@2/);
});
