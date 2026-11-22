import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readPolicy } from "../work/contract.mjs";
import { verifyContracts } from "../work/product.mjs";
import { factory, git, put } from "./fixture.mjs";

const source = ".foundry/catalog.json", suite = ".foundry/catalog", journey = `${suite}/journey.md`;
const api = "interfaces/launch.txt", helper = `${suite}/observe.mjs`;
const unit = `${suite}/unit.mjs`, goal = `${suite}/goal.mjs`, product = `${suite}/product.mjs`;
const promised = "Fresh launch opens a populated catalog.", pinned = "Select the sample dataset.";
const request = { outcome: "needs-evidence", reason: "Which dataset does normal launch select?", evidence: [journey], grains: [], file: api };
/** @param {import("node:test").TestContext} t @param {Record<string,string>} [extra] */
function trial(t, extra = {}) {
	return factory(t, "catalog-run", source, {
		[source]: JSON.stringify({ version: 2, id: "catalog-run", direction: "Open the catalog.", target: "refs/heads/main",
			productCheck: product, goalCheck: goal, squads: ["runtime", "client"].map(id => ({
				id, charter: `${suite}/${id}.md`, areas: [id], checks: [unit],
			})) }),
		[journey]: "Shared background.\n".repeat(240) + promised, [`${suite}/client.md`]: "Implement the window.", [`${suite}/runtime.md`]: "Supply the dataset.",
		[api]: pinned, [goal]: 'import "./observe.mjs"', [product]: "", [unit]: "",
		[helper]: `import {existsSync, readFileSync} from 'node:fs';
			if (!existsSync('client/catalog') || readFileSync('client/catalog','utf8') !== readFileSync('${api}','utf8')) {
				console.log("catalog missing"); process.exit(1);
			}`, ...extra,
	});
}

test("both scouts receive the same committed journey without declaring any boundary files", async t => {
	const brief = "Shared background.\n".repeat(3000) + promised;
	const f = trial(t, { [journey]: brief }); put(f.root, journey, "Uncommitted direction");
	await f.start(); assert.deepEqual(f.scouts.map(s => s.squad).sort(), ["client", "runtime"]);
	for (const s of f.scouts) {
		assert.ok(s.prompt.includes(brief) && s.prompt.includes("catalog missing"));
		assert.ok(!s.prompt.includes("Uncommitted direction"));
		assert.equal(s.packet.files[journey], git(f.root, "rev-parse", `${f.tip}:${journey}`));
		assert.ok(s.packet.files[`${suite}/${s.squad}.md`]);
		await s.report({ outcome: "no-gap", reason: "No evidenced owned change.", evidence: [journey], grains: [] });
	}
	assert.ok((await f.status()).reviews.every(r => r.state === "observed"));
});

test("a non-text or blank shared brief is rejected before checks or scouts", async t => {
	for (const brief of ["not a brief\0", "  \n"]) {
		const f = trial(t, { [journey]: brief });
		await assert.rejects(() => f.start(), /journey\.md.*text/i);
		assert.equal(f.checks.length, 0); assert.equal(f.scouts.length, 0);
	}
});

test("a long squad name survives plan admission, goal attribution and scout dispatch", async t => {
	const id = "catalog-".repeat(14) + "owner";
	const f = trial(t, { [source]: JSON.stringify({ version: 2, id: "catalog-run", target: "refs/heads/main", direction: promised,
		productCheck: product, goalCheck: goal, squads: [{ id, areas: ["runtime"], charter: `${suite}/runtime.md`, checks: [unit] }] }),
		[goal]: `console.log("FOUNDRY_SQUAD=${id}"); process.exit(1)` });
	await f.start();
	assert.equal(f.scouts[0].squad, id); assert.equal((await f.status()).goal?.receipt?.squad, id);
});

test("a scout discovers a committed interface by name, then requests its contents", async t => {
	const directory = `interfaces-${randomUUID()}`, file = `${directory}/launch-${randomUUID()}.txt`;
	const f = trial(t, { [file]: "custom launch protocol" });
	put(f.root, `${directory}/dirty-only.txt`, "do not list"); await f.start();
	const scout = f.scouts[1];
	const path = /"(interfaces-[^"]+\/launch-[^"]+\.txt)"/.exec(scout.prompt)?.[1];
	assert.equal(path, file, "discover a supporting path from the actual packet");
	assert.equal(scout.packet.files[file], undefined); assert.doesNotMatch(scout.prompt, /custom launch protocol|dirty-only\.txt/);
	await scout.report({ ...request, file: path });
	const focus = f.scouts.at(-1); assert.ok(focus && focus.id !== scout.id);
	assert.equal(focus.packet.files[file], git(f.root, "rev-parse", `${f.tip}:${file}`));
	assert.ok(focus.prompt.includes("custom launch protocol"));
});

test("a scout may cite the pinned interface after requesting it, but not before", async t => {
	const f = trial(t); await f.start(); const [runtime, client] = f.scouts;
	assert.equal(client.packet.partial, false); assert.equal(client.packet.files[api], undefined);
	put(f.root, api, "Dirty alternative");
	await runtime.report({ outcome: "no-gap", reason: "Unsupported conclusion.", evidence: [api], grains: [] });
	await client.report(request);
	const focus = f.scouts[2]; assert.ok(focus, "a complete initial packet may still lack a relevant file");
	assert.equal(focus.squad, "client"); assert.equal(focus.packet.files[api], git(f.root, "rev-parse", `${f.tip}:${api}`));
	assert.ok(focus.prompt.includes(pinned) && !focus.prompt.includes("Dirty alternative"));
	await focus.report({ outcome: "regenerate", reason: "Implement the window against this interface.", evidence: [api], grains: [
		{ id: "launch", directory: "client", task: "Open the catalog.", needs: [], check: unit }] });
	const s = await f.status();
	assert.equal(s.reviews.find(r => r.id === runtime.id)?.state, "blocked");
	assert.equal(s.reviews.find(r => r.id === focus.id)?.state, "observed");
	assert.deepEqual(s.nodes.map(n => [n.directory, n.state]), [["client", "writing"]]);
	const [w] = f.workers.values();
	const pin = /Read-only supporting file: ([0-9a-f]+):([^\n]+)/.exec(w.prompt);
	assert.ok(pin, "writer needs the admitted citation, not the test's hard-coded answer");
	assert.equal(pin[1], focus.base); assert.equal(pin[2], api);
	put(w.cwd, "client/catalog", git(w.cwd, "show", `${pin[1]}:${pin[2]}`));
	await f.runtime(w.cwd).operation("submit", { run: "catalog-run", token: w.token }, w.id);
	const done = await f.status();
	assert.ok(done.qualified && done.qualified !== f.tip);
	assert.equal(done.goal?.receipt?.commit, done.qualified); assert.equal(done.goal?.receipt?.exit, 0);
});

test("a scout can follow a second reference without losing the first or looping back", async t => {
	const second = "interfaces/datasets.txt", value = "v".repeat(300_000) + "Final dataset";
	const f = trial(t, { [api]: second, [second]: value }); await f.start();
	await f.scouts[1].report(request);
	await f.scouts[2].report({ ...request, evidence: [api], file: second });
	const last = f.scouts[3]; assert.ok(last, "a different pinned file is new evidence");
	assert.ok(last.prompt.includes(value) && last.packet.files[api] && last.packet.files[second]);
	await last.report({ ...request, evidence: [second], file: api });
	assert.equal(f.scouts.length, 4); assert.equal((await f.status()).reviews.at(-1)?.state, "blocked");
});

test("reading a shared interface cannot give a squad ownership of it", async t => {
	const f = trial(t); await f.start(); await f.scouts[0].report(request);
	const focus = f.scouts[2]; assert.ok(focus?.packet.files[api]);
	await focus.report({ outcome: "regenerate", reason: "Rewrite the interface instead.", evidence: [api], grains: [
		{ id: "change-api", directory: "interfaces", task: "Change the shared interface.", needs: [], check: unit }] });
	assert.match(String((await f.status()).reviews.at(-1)?.reason), /outside runtime's charter: interfaces/);
	assert.equal(f.workers.size, 0);
});

test("a discovered source may evolve but an unlisted acceptance helper stays pinned", t => {
	const f = trial(t), { policy } = readPolicy(f.root, source);
	put(f.root, api, "New interface"); git(f.root, "commit", "-qam", "interface evolution");
	verifyContracts(f.root, policy, git(f.root, "rev-parse", "HEAD"));
	put(f.root, helper, "process.exit(0)"); git(f.root, "commit", "-qam", "weaken goal helper");
	assert.throws(() => verifyContracts(f.root, policy, git(f.root, "rev-parse", "HEAD")), /contract changed.*observe\.mjs/i);
});

test("a target cannot qualify an empty product by changing a sibling plan's goal helper", async t => {
	const shared = ".foundry/shared-checks/checks.mjs";
	const f = trial(t, { [goal]: 'import "../shared-checks/checks.mjs"', [shared]: 'import "../catalog/observe.mjs"' });
	put(f.root, shared, "export {};"); git(f.root, "commit", "-qam", "change shared acceptance helper");
	git(f.root, "switch", "-q", "--detach", f.tip); // Review the original brief against the advanced target.
	await assert.rejects(async () => {
		const s = await f.start();
		if (s.qualified) assert.fail(`Empty product qualified at ${s.qualified}`);
	}, /contract changed.*shared-checks\/checks\.mjs/i);
	assert.equal(f.checks.length, 0);
});
