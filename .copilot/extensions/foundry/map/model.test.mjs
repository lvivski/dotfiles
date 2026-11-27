import assert from "node:assert/strict";
import test from "node:test";
import { mapSnapshot } from "./model.mjs";
import { boardFacts } from "../work/visibility.mjs";
import { openDatabase } from "../work/database.mjs";
import { recover } from "../work/recovery.mjs";
import { status } from "../work/status.mjs";
import { factory, git, put } from "../test/fixture.mjs";

/** @param {import("../work/model.js").Run} run @param {string} actor */
const boardSnapshot=(run,actor)=>mapSnapshot(boardFacts(run,actor));

test("a saved run with eight bound writers and a lost launch reports assignments, not nine active sessions", async t => {
	const run = "writers", source = ".foundry/writers.json", ids = [...Array.from({ length: 8 }, (_, i) => `part-${i}`), "journal"];
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, target: "refs/heads/main", direction: "Collect reports.", productCheck: "check.mjs", seed: ids,
			grains: ids.map(id => ({ id, directory: `src/${id}`, specification: "spec", boundary: ["interface"], check: "check.mjs" })) }),
		spec: "Submit the report.", interface: "One file per report.", "check.mjs": "",
	});
	const issuer = f.runtime(f.root, { execute: async (tool, args, id) => {
		const reply = await f.execute(tool, args, id);
		if (tool === "create_session" && String(args.name).includes("journal")) throw Error("lost writer launch reply");
		return reply;
	} });
	await f.start(issuer); issuer.close();
	const db = openDatabase(f.root); t.after(() => db.close());
	const saved = db.read(run); assert.ok(saved);
	const s = await f.status(), board = boardSnapshot(saved, "owner");
	assert.equal(s.nodes.filter(n => n.state === "writing").length, 9);
	assert.equal(s.pending.filter(e => e.kind === "writer" && e.state === "uncertain" && e.grain === "journal").length, 1);
	assert.deepEqual(s.writerAssignments, { bound: 8, pending: 0, unconfirmed: 1, sessionActivity: "not-observed" });
	assert.equal(board.nodes.filter(n => n.state === "assigned").length, 8);
	assert.equal(board.nodes.find(n => n.id === "journal")?.state, "unconfirmed");
	assert.deepEqual(board, mapSnapshot(s));
	assert.deepEqual(db.read(run), saved); assert.equal(f.workers.size, 9); assert.deepEqual(f.checks, []);

	const n = s.nodes.find(n => n.grain === "part-0"), w = f.workers.get(n?.worker ?? ""); assert.ok(w);
	put(w.cwd, "src/part-0/report", "done");
	await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	const after = await f.status();
	assert.deepEqual(after.writerAssignments, { bound: 7, pending: 0, unconfirmed: 1, sessionActivity: "not-observed" });
	const receipt = after.nodes.find(n => n.grain === "part-0")?.receipt;
	assert.ok(receipt); assert.equal(receipt.exit, 0); assert.equal(git(f.root, "show", `${receipt.commit}:src/part-0/report`), "done");
	assert.ok(after.pending.some(e => e.grain === "journal" && e.state === "uncertain")); assert.equal(f.workers.size, 9);
});

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
	const r = structuredClone(db.read(run)); assert.ok(r);
	const e = r.effects.find(e => e.kind === "goal"); assert.ok(e);
	assert.equal(e.state, "uncertain"); assert.equal(launches, 1);
	const snap = () => boardSnapshot(r, "owner");
	assert.deepEqual(snap().holds, ["Goal check: Original call is not confirmed; it will not be replayed"]);
	e.runnerStarted = true;
	e.error = "Receipt lookup returned no event."; // Transport wording is not evaluator state.
	assert.deepEqual(snap().holds, ["Goal check started; no evaluator result recorded yet."]);
	assert.equal(snap().phase, "Active"); assert.equal(snap().goal?.result, null); assert.equal(snap().qualified, null);
	e.permissionHold = "Native permission requires attention.";
	assert.ok(snap().holds.some(message => message.includes("Native permission requires attention.")));
	const expected = mapSnapshot(status(r, "owner"));
	// A former participant may still inspect the run, but not owner checks or timings.
	r.effects.push({ kind: "writer", tool: "create_session", id: "prior-binding", issuer: "owner", state: "done", nativeId: "retired", args: {} });
	const retired = boardSnapshot(r, "retired");
	assert.deepEqual(retired, mapSnapshot(status(r, "retired")));
	assert.equal(retired.owner, false); assert.equal(retired.goal, null);
	assert.equal(retired.timing, null); assert.deepEqual(retired.holds, []); assert.deepEqual(retired.nodes, []);
	r.effects.pop();
	Object.defineProperty(r, "artifacts", { get() { throw Error("Board read chat-only artifact extracts"); } });
	Object.defineProperty(r.policy, "target", { get() { throw Error("Board requested the live target"); } });
	assert.deepEqual(snap(), expected);
});
