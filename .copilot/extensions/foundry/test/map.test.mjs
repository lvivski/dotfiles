import assert from "node:assert/strict";
import test from "node:test";
import { layout } from "../map/layout.mjs";
import { example, mapSnapshot } from "../map/model.mjs";
import { factory, loadEntry, put } from "./fixture.mjs";

test("a fork and join keep the same real edges in both orientations, including a skipped rank", () => {
	for (const width of [340, 900]) {
		const g = layout(example.nodes, width), axis = g.vertical ? "y" : "x";
		const boxes = new Map(g.boxes.map(n => [n.id, n]));
		assert.equal(g.width, width);
		assert.equal(g.vertical, width < 660);
		assert.deepEqual(g.edges.map(e => `${e.from}/${e.to}`).sort(), example.nodes.flatMap(n => n.needs.map(id => `${id}/${n.id}`)).sort());
		for (const edge of g.edges) assert.ok(Number(boxes.get(edge.from)?.[axis]) < Number(boxes.get(edge.to)?.[axis]));
		assert.equal(boxes.get("file-reader")?.[axis], boxes.get("csv-format")?.[axis]);
	}
	const partial = layout(example.nodes.filter(n => n.id === "export-results"), 340);
	assert.deepEqual(partial.edges, []); // No invented assignments from outside the viewer's scope.
});

test("the open map follows the real parallel run without issuing calls; participant views stay bound across refresh and re-open", async t => {
	const run = "map-trial", source = ".foundry/example.json", ids = ["editor", "recover", "send"];
	const grains = ids.map(id => ({ id, directory: `lib/${id}`, specification: "spec.md", boundary: ["api.md"],
		check: "check.mjs", needs: id === "send" ? ids.slice(0, 2) : [] }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, target: "refs/heads/main", direction: "Edit, recover and send.",
			productCheck: "product.mjs", grains, seed: ids, squads: [{ id: "squad", charter: "spec.md", grains: ids }] }),
		"spec.md": "Own the complete directory.", "api.md": "One module per directory.", "check.mjs": "", "product.mjs": "",
	});
	await f.start();
	const conf = await loadEntry({ sessionId: "owner", on() {} }), canvas = conf.canvases?.[0]; assert.ok(canvas);
	const ctx = { sessionId: "owner", extensionId: "user:foundry", canvasId: "foundry-board", instanceId: "parallel", input: { run } };
	const hook = { sessionId: "owner", timestamp: new Date(), workingDirectory: f.root };
	await conf.hooks?.onSessionStart?.({ ...hook, source: "startup" }, hook);
	t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, hook));
	const before = await f.status(), { url } = await canvas.open(ctx); assert.ok(url);
	t.after(() => canvas.onClose?.(ctx));
	/** @param {string} at @returns {Promise<import("../map/model.mjs").MapSnapshot>} */
	async function refresh(at) { const r = await fetch(`${at}state`); assert.equal(r.status, 200); return r.json(); }
	assert.deepEqual(await canvas.open(ctx), { url, title: `Foundry · ${run}` });
	assert.deepEqual(await refresh(url), mapSnapshot(before));
	assert.equal((await refresh(url)).timing?.firstWriter, "bound");
	assert.deepEqual((await refresh(url)).nodes.filter(n => n.state === "writing").map(n => n.id), ["editor", "recover"]);
	assert.deepEqual((await refresh(url)).nodes.find(n => n.id === "send")?.needs, ["editor", "recover"]);
	assert.deepEqual(await f.status(), before);
	assert.equal(f.workers.size, 2); assert.equal(f.checks.length, 0);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "unrelated", sessionId: "outsider" }), /No bound assignment/);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "missing", input: { run: "no-such-run" } }), /Unknown run/);
	const [w] = f.workers.values();
	const workerCtx = { ...ctx, sessionId: w.id, instanceId: "participant" }, worker = await canvas.open(workerCtx); assert.ok(worker.url);
	t.after(() => canvas.onClose?.(workerCtx));
	const view = await refresh(worker.url);
	assert.equal(view.owner, false); assert.equal(view.timing, null); assert.deepEqual(view.nodes.map(n => n.id), ["editor"]);
	assert.ok(!JSON.stringify(view).includes(w.token) && !("prepared" in view));
	put(w.cwd, "lib/editor/unit.mjs", "export default 1;");
	await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	const after = await refresh(url);
	assert.equal(after.nodes.find(n => n.id === "editor")?.result?.exit, 0);
	assert.equal(after.nodes.find(n => n.id === "send")?.state, "waiting");
	await f.owner.operation("pause", { run }, "owner");
	assert.equal((await refresh(url)).phase, "Paused");
	await canvas.onClose?.(ctx); await assert.rejects(fetch(`${url}state`));
	const reopened = await canvas.open(ctx); assert.ok(reopened.url && reopened.url !== url);
	assert.deepEqual(await refresh(reopened.url), mapSnapshot(await f.status()));
});
