import assert from "node:assert/strict";
import test from "node:test";
import { mapSnapshot } from "./map/model.mjs";
import { factory, loadEntry, put } from "./test/fixture.mjs";

test("the open map follows the real parallel run without issuing calls; participant views stay bound across refresh and re-open", async t => {
	const run = "map-trial", source = ".foundry/example.json", ids = ["editor", "recover", "send"];
	const grains = ids.map(id => ({ id, directory: `lib/${id}`, specification: "spec.md", boundary: ["api.md"],
		check: "check.mjs", needs: id === "send" ? ids.slice(0, 2) : [] }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, target: "refs/heads/main", direction: "Edit, recover and send.",
			productCheck: "product.mjs", grains, seed: ids, squads: [{ id: "squad", charter: "spec.md", grains: ids }] }),
		"spec.md": "Own the complete directory.", "api.md": "One module per directory.", "check.mjs": "", "product.mjs": "",
	});
	const conf = await loadEntry({ sessionId: "owner", on() {} }), canvas = conf.canvases?.[0]; assert.ok(canvas);
	assert.ok("displayName" in canvas); assert.equal(canvas.displayName, "Foundry");
	const ctx = { sessionId: "owner", extensionId: "user:foundry", canvasId: "foundry-board", instanceId: "parallel", input: { run } };
	const hook = { sessionId: "owner", timestamp: new Date(), workingDirectory: f.root };
	await conf.hooks?.onSessionStart?.({ ...hook, source: "startup" }, hook);
	t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, hook));
	const manual = { ...ctx, input: {}, instanceId: "manual" }, manualPanel = await canvas.open(manual);
	t.after(() => canvas.onClose?.(manual)); assert.ok(manualPanel.url);
	assert.equal(manualPanel.title, "Foundry");
	const emptyState = await (await fetch(`${manualPanel.url}state`)).json();
	assert.match(emptyState.notice, /no foundry run.*session/i);
	await f.start();
	const before = await f.status(), { url } = await canvas.open(ctx); assert.ok(url);
	t.after(() => canvas.onClose?.(ctx));
	/** @param {string} at @returns {Promise<import("./map/model.mjs").MapSnapshot>} */
	async function refresh(at) { const r = await fetch(`${at}state`); assert.equal(r.status, 200); return r.json(); }
	assert.deepEqual(await canvas.open(ctx), { url, title: `Foundry · ${run}` });
	assert.deepEqual(await refresh(url), mapSnapshot(before));
	assert.deepEqual(await refresh(manualPanel.url), mapSnapshot(before));
	const other = { ...manual, instanceId: "outside", sessionId: "outsider" }, otherPanel = await canvas.open(other);
	t.after(() => canvas.onClose?.(other)); assert.ok(otherPanel.url);
	assert.deepEqual(await (await fetch(`${otherPanel.url}state`)).json(), emptyState);
	assert.equal((await refresh(url)).timing?.firstWriter, "bound");
	assert.deepEqual((await refresh(url)).nodes.filter(n => n.state === "assigned").map(n => n.id), ["editor", "recover"]);
	assert.deepEqual((await refresh(url)).nodes.find(n => n.id === "send")?.needs, ["editor", "recover"]);
	assert.deepEqual(await f.status(), before);
	assert.equal(f.workers.size, 2); assert.equal(f.checks.length, 0);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "unrelated", sessionId: "outsider" }), /No bound assignment/);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "missing", input: { run: "no-such-run" } }), /Unknown run/);
	const [w] = f.workers.values();
	const workerCtx = { ...manual, sessionId: w.id, instanceId: "participant" }, worker = await canvas.open(workerCtx); assert.ok(worker.url);
	t.after(() => canvas.onClose?.(workerCtx));
	const view = await refresh(worker.url);
	assert.deepEqual(view, mapSnapshot(await f.status(w.id)));
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
