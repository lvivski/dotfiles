import assert from "node:assert/strict";
import test from "node:test";
import { factory, git, put } from "../test/fixture.mjs";

const run = "dispatch", source = ".foundry/dispatch.json", directory = "desk/items", id = "open-item";
const gap = { id, directory, blocked: 49 }, cleared = { id, directory, passed: true };
const desk = { id: "desk", charter: "desk.md", areas: ["desk"], checks: ["component.mjs"] };
const other = { ...desk, id: "stock", charter: "stock.md", areas: ["stock"] };
const report = { outcome: "no-gap", reason: "No change proposed.", evidence: ["desk.md"], grains: [] };
const grain = { id: "row-action", task: "Open a selected item.", directory, check: "component.mjs", needs: [] };
/** @param {import("node:test").TestContext} t @param {boolean} legacy @param {number} [workers] @param {boolean} [reportsPass] */
function setup(t, legacy, workers = 1, reportsPass = true) {
	return factory(t, run, source, {
		[source]: JSON.stringify({ id: run, version: 2, direction: "Deliver openable items.", target: "refs/heads/main",
			productCheck: "product.mjs", goalCheck: "goal.mjs", limits: { workers }, squads: [other, desk] }),
		".foundry/dispatch/journey.md": "Open an item.", "desk.md": "Own opening an item.", "stock.md": "Own stock counts.",
		"component.mjs": "", "product.mjs": "",
		"goal.mjs": `import {existsSync} from 'node:fs'; const passed=existsSync('${directory}/open');
			console.log(passed ? 'Item opens.' : 'Open failed; 49 dependent journeys not run.');
			if (passed ? ${reportsPass} : !${legacy}) console.log('FOUNDRY_BLOCKERS='+JSON.stringify(passed ? [${JSON.stringify(cleared)}] : [${JSON.stringify(gap)}]));
			process.exit(passed ? 0 : 1);`,
	});
}

test("a shared failed step takes priority; a review without a repair owner escalates once and unrelated work proceeds", async t => {
	const f = setup(t, false), notices = /** @type {string[]} */ ([]);
	const owner = f.runtime(f.root, { notify: async body => { notices.push(body); return "notice"; } });
	await f.start(owner);
	const first = f.scouts[0]; assert.equal(first.squad, "desk", "49 blocked journeys should route the first available review to their producer");
	assert.match(first.prompt, /49 journeys blocked/);
	await first.report(report);
	const row = (await f.status()).sharedBlockers?.[0];
	assert.equal(row?.state, "unowned"); assert.equal(row?.blocked, 49); assert.equal(row?.affected, 50);
	assert.equal(f.scouts[1]?.squad, "stock", "a shared blocker must not gate independent discovery");
	assert.equal(notices.filter(s => s.includes("no repair owner")).length, 1);
	await f.scouts[1].report({ ...report, evidence: ["stock.md"] });
	const reloaded = f.runtime(f.root, { notify: async body => { notices.push(body); return "another"; } });
	reloaded.turn("owner"); await reloaded.flush(); await f.settle();
	assert.equal(f.workers.size, 0); assert.equal(f.scouts.length, 2); assert.equal(f.checks.length, 1);
	assert.equal(notices.filter(s => s.includes("no repair owner")).length, 1);
	assert.equal((await f.status()).sharedBlockers?.[0].state, "unowned");
});

test("after blocker delivery the one review slot rotates to a never-reviewed squad before revisiting an earlier producer", async t => {
	const orders = { ...desk, id: "orders", charter: "orders.md", areas: ["orders"] };
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ id: run, version: 2, direction: "Deliver order handling.", target: "refs/heads/main",
			productCheck: "unit.mjs", goalCheck: "goal.mjs", limits: { workers: 1 },
			squads: [other, desk, orders].map(s => ({ ...s, checks: ["unit.mjs"] })) }),
		".foundry/dispatch/journey.md": "Handle a stocked order.", "desk.md": "Own the item list.",
		"stock.md": "Supply inventory.", "orders.md": "Expose orders.", "unit.mjs": "",
		"goal.mjs": `import {existsSync} from 'node:fs';
			if (!existsSync('stock/items/ready')) console.log('FOUNDRY_SQUAD=stock');
			else if (!existsSync('orders/list/ready')) console.log('FOUNDRY_BLOCKERS=${JSON.stringify([gap])}');
			else { console.log('FOUNDRY_BLOCKERS=${JSON.stringify([cleared])}'); process.exit(0); }
			process.exit(1);`,
	});
	await f.start();
	/** @param {typeof f.scouts[number]} scout @param {string} dir */
	async function publish(scout, dir) {
		await scout.report({ outcome: "regenerate", reason: `Implement ${dir}.`, evidence: [`${scout.squad}.md`],
			grains: [{ id: scout.squad, directory: dir, task: `Supply ${dir}.`, check: "unit.mjs", needs: [] }] });
		const worker = (await f.status()).nodes.find(n => n.directory === dir)?.worker;
		const w = worker && f.workers.get(worker); assert.ok(w);
		put(w.cwd, `${dir}/ready`, "ready"); await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
		await f.settle();
	}
	assert.equal(f.scouts[0]?.squad, "stock");
	await publish(f.scouts[0], "stock/items");
	const first = f.scouts[1]; assert.equal(first?.squad, "desk"); assert.match(first.prompt, /49 journeys blocked/);
	await first.report(report);
	const next = f.scouts[2]; assert.equal(next?.squad, "orders", "stock already received a review; orders never has");
	await publish(next, "orders/list");
	const done = await f.status(); assert.ok(done.qualified); assert.equal(done.sharedBlockers?.[0].verifiedAt, done.qualified);
});

test("attribute a stalled legacy receipt, bind one owner, verify the repaired step only on the next exact goal receipt", async t => {
	const f = setup(t, true); await f.start();
	for (const scout of f.scouts) await scout.report({ ...report, evidence: [`${scout.squad}.md`] });
	const before = await f.owner.operation("status", { run, detail: "proof" }, "owner");
	assert.ok(before.blocker); assert.equal(f.workers.size, 0);
	const receipt = before.goalChecks?.[0]?.id; assert.ok(receipt);
	const args = { run, receipt, ...gap, excerpt: "Open failed; 49 dependent journeys not run." };
	const owner = f.runtime(f.root);
	await assert.rejects(owner.operation("attribute", args, "foreign"), /owner/);
	await assert.rejects(owner.operation("attribute", { ...args, excerpt: "Invented observation" }, "owner"), /verbatim/);
	await owner.operation("attribute", args, "owner"); await f.settle();
	await assert.rejects(owner.operation("attribute", { ...args, blocked: 50 }, "owner"), /already has an attribution/);
	const routed = f.scouts.at(-1); assert.ok(routed && routed.squad === "desk" && routed.prompt.includes(args.excerpt));
	await routed.report({ ...report, outcome: "regenerate", reason: "Fix the root step, not the 49 unrun journeys.",
		grains: [grain], addresses: [{ id, grain: grain.id }] });
	await owner.operation("attribute", args, "owner"); await f.settle();
	const w = [...f.workers.values()][0]; assert.ok(w);
	assert.equal(f.workers.size, 1); assert.equal(f.checks.length, 1); assert.equal(f.scouts.length, 3);
	const open = (await f.status()).sharedBlockers?.[0]; assert.equal(open?.worker, w.id); assert.equal(open?.state, "assigned");
	put(w.cwd, `${directory}/open`, "open");
	await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	const after = await f.status(), closed = after.sharedBlockers?.[0];
	assert.ok(after.qualified && after.qualified !== f.tip);
	assert.equal(closed?.state, "verified"); assert.equal(closed?.verifiedAt, after.qualified);
	assert.equal(git(f.root, "show", `${after.qualified}:${directory}/open`), "open");
});

test("an automatically routed shared blocker can hand off its stopped directory without a new checkpoint", async t => {
	const f = setup(t, false); await f.start();
	const scout = f.scouts[0]; assert.equal(scout.squad, desk.id);
	await scout.report({ ...report, outcome: "regenerate", grains: [{ ...grain, id: "filter-items", task: "Filter the items." }] });
	const old = [...f.workers.values()][0]; assert.ok(old);
	assert.notEqual((await f.status()).sharedBlockers?.[0].worker, old.id, "another writer in the directory does not own the reported defect");
	await f.runtime(old.cwd).operation("submit", { run, token: old.token, missingInput: "The filter specification is unavailable." }, old.id);
	await f.settle();
	const last = f.scouts.at(-1);
	if (last?.squad === "stock") await last.report({ ...report, evidence: ["stock.md"] });
	const fresh = f.scouts.at(-1); assert.ok(fresh && fresh.squad === desk.id && fresh.id !== scout.id);
	await fresh.report({ ...report, outcome: "regenerate", grains: [grain], addresses: [{ id, grain: grain.id }] });
	const w = [...f.workers.values()].find(w => w.id !== old.id);
	assert.ok(w, "The shared-step repair should acquire the stopped directory on the reviewed product");
	assert.equal((await f.status()).sharedBlockers?.[0].worker, w.id);
	assert.equal(f.checks.length, 1); assert.equal(f.workers.size, 2);
	await assert.rejects(f.runtime(old.cwd).operation("submit", { run, token: old.token }, old.id), /assignment|token|worker/i);
	put(w.cwd, `${directory}/open`, "open");
	await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	const result = await f.status(); assert.ok(result.qualified); assert.equal(result.sharedBlockers?.[0].verifiedAt, result.qualified);
});

test("link an existing bound repair without restaffing; an omitted observation does not verify the step", async t => {
	const f = setup(t, true, 3, false); await f.start();
	const ours = f.scouts.find(s => s.squad === desk.id); assert.ok(ours);
	await ours.report({ ...report, outcome: "regenerate", grains: [grain] });
	const w = [...f.workers.values()][0]; assert.ok(w);
	const receipt = (await f.owner.operation("status", { run, detail: "proof" }, "owner")).goalChecks?.[0].id; assert.ok(receipt);
	await f.owner.operation("attribute", { run, receipt, ...gap, excerpt: "Open failed;" }, "owner"); await f.settle();
	const follow = f.scouts.at(-1); assert.ok(follow && follow.squad === desk.id && follow.id !== ours.id);
	assert.ok(follow.prompt.includes(w.id));
	await follow.report({ ...report, reason: "The bound row-action task already covers the open step.",
		addresses: [{ id, grain: grain.id, worker: w.id }] });
	assert.equal((await f.status()).sharedBlockers?.[0].worker, w.id);
	assert.equal(f.workers.size, 1); assert.equal(f.checks.length, 1);
	put(w.cwd, `${directory}/open`, "open");
	await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	const next = await f.status();
	assert.notEqual(next.goal?.commit, f.tip); assert.equal(next.goal?.receipt?.exit, 0);
	assert.equal(next.sharedBlockers?.[0].state, "awaiting-verification");
});
