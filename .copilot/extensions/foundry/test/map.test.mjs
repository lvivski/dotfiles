import assert from "node:assert/strict";
import test from "node:test";
import { layout } from "../map/layout.mjs";
import { example, mapSnapshot } from "../map/model.mjs";
import { openDatabase } from "../work/database.mjs";
import { recover } from "../work/recovery.mjs";
import { status } from "../work/status.mjs";
import { factory, loadEntry, put } from "./fixture.mjs";

test("the map distinguishes a missing shell receipt from a check that recorded its start", async t => {
	const run = "pending-map", source = ".foundry/pending.json";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, target: "refs/heads/main", direction: "Open the catalog.",
			productCheck: "product.mjs", goalCheck: "goal.mjs", squads: [{ id: "catalog", areas: ["app"], charter: "spec", boundary: ["api"], checks: ["unit.mjs"] }] }),
		spec: "Open catalog.", api: "Show records.", "goal.mjs": "", "product.mjs": "", "unit.mjs": "",
	});
	let launches = 0;
	const issuer = f.runtime(f.root, { execute: async () => { launches++; return { resultType: "success" }; },
		recover: e => recover(async () => ({ events: [], cursor: "", cursorStatus: "ok", hasMore: false }), e) });
	await f.start(issuer); issuer.turn("owner"); await issuer.flush();
	const db = openDatabase(f.root); t.after(() => db.close());
	const r = db.read(run); assert.ok(r);
	const e = r.effects.find(e => e.kind === "goal"); assert.ok(e);
	assert.equal(e.state, "uncertain"); assert.equal(launches, 1);
	const snap = () => mapSnapshot(status(r, "owner"));
	assert.deepEqual(snap().holds, ["Goal check: Original call is not confirmed; it will not be replayed"]);
	e.runnerStarted = true;
	assert.deepEqual(snap().holds, ["Goal check started; no evaluator result recorded yet."]);
	assert.equal(snap().phase, "Active"); assert.equal(snap().goal?.result, null); assert.equal(snap().qualified, null);
	e.permissionHold = "Native permission requires attention.";
	assert.ok(snap().holds.some(message => message.includes("Native permission requires attention.")));
});

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

test("crowded levels stay inside the panel without hiding peers or losing a dependency", () => {
	const root = example.nodes[0], peers = Array.from({ length: 12 }, (_, i) => ({
		...root, id: `peer-${i}`, needs: [root.id],
	}));
	const join = { ...root, id: "join", needs: [root.id, ...peers.map(n => n.id)] };
	const nodes = [root, ...peers, join];
	for (const width of [240, 340, 650, 900]) {
		const g = layout(nodes, width);
		assert.equal(g.width, width);
		assert.deepEqual(g.boxes.map(b => b.id).sort(), nodes.map(n => n.id).sort());
		for (const [i, b] of g.boxes.entries()) {
			assert.ok(b.x >= 0 && b.x + g.w <= width && b.y >= 0 && b.y + g.h <= g.height);
			assert.ok(g.boxes.slice(i + 1).every(o => o.x >= b.x + g.w || b.x >= o.x + g.w ||
				o.y >= b.y + g.h || b.y >= o.y + g.h));
		}
		assert.deepEqual(g.edges.map(e => `${e.from}/${e.to}`).sort(), nodes.flatMap(n => n.needs.map(p => `${p}/${n.id}`)).sort());
	}
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
	/** @param {string} at @returns {Promise<import("../map/model.mjs").MapSnapshot>} */
	async function refresh(at) { const r = await fetch(`${at}state`); assert.equal(r.status, 200); return r.json(); }
	assert.deepEqual(await canvas.open(ctx), { url, title: `Foundry · ${run}` });
	assert.deepEqual(await refresh(url), mapSnapshot(before));
	assert.deepEqual(await refresh(manualPanel.url), mapSnapshot(before));
	const other = { ...manual, instanceId: "outside", sessionId: "outsider" }, otherPanel = await canvas.open(other);
	t.after(() => canvas.onClose?.(other)); assert.ok(otherPanel.url);
	assert.deepEqual(await (await fetch(`${otherPanel.url}state`)).json(), emptyState);
	assert.equal((await refresh(url)).timing?.firstWriter, "bound");
	assert.deepEqual((await refresh(url)).nodes.filter(n => n.state === "writing").map(n => n.id), ["editor", "recover"]);
	assert.deepEqual((await refresh(url)).nodes.find(n => n.id === "send")?.needs, ["editor", "recover"]);
	assert.deepEqual(await f.status(), before);
	assert.equal(f.workers.size, 2); assert.equal(f.checks.length, 0);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "unrelated", sessionId: "outsider" }), /No bound assignment/);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "missing", input: { run: "no-such-run" } }), /Unknown run/);
	const [w] = f.workers.values();
	const workerCtx = { ...manual, sessionId: w.id, instanceId: "participant" }, worker = await canvas.open(workerCtx); assert.ok(worker.url);
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
