import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { researchResult } from "../work/research.mjs";
import { scoutDefinition } from "../work/scouts.mjs";
import { factory, git, put } from "./fixture.mjs";

const question = "Does normal launch select the SDK's restore mode rather than replay?";
const profile = "launch-investigator", run = "launch", source = ".foundry/launch.json";
/** @typedef {Parameters<ReturnType<typeof scoutDefinition>["run"]>[0]} Context */

for (const scenario of ["correct", "replay", "denied"]) test(`pre-writer research: ${scenario}`, async t => {
	const squad = { id: "client", areas: ["app"], charter: "charter", checks: ["unit.mjs"], boundary: ["interface"], researchAgent: profile };
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, direction: "Restore on normal launch.", target: "refs/heads/main",
			squads: [squad], productCheck: "product.mjs", goalCheck: "goal.mjs", limits: { assignments: 8 } }),
		charter: "Investigate launch wiring before changing the client.", interface: "Use the approved adapter checkout and SDK manual.",
		"app/start.mjs": `export const launchMode = "${scenario === "replay" ? "B" : "A"}";`,
		"goal.mjs": "process.exit(1)", "product.mjs": "", "unit.mjs": "",
	});
	const ref = path.join(path.dirname(f.root), "adapter");
	mkdirSync(ref); git(ref, "init", "-q", "-b", "main");
	put(ref, "src/binding.mjs", 'export const modes = {A: 12, B: 71};');
	git(ref, "add", "."); git(ref, "commit", "-qm", "adapter"); const pin = git(ref, "rev-parse", "HEAD");
	put(ref, "src/binding.mjs", "throw Error('do not investigate the dirty checkout')");
	const server = createServer((req, res) => {
		if (req.url === "/search?q=launch") res.end("/manual/v3");
		else if (req.url === "/manual/v3" && scenario === "denied") { res.writeHead(403); res.end(); }
		else if (req.url === "/manual/v3") res.end("SDK v3: restore=12; replay=71.");
		else { res.statusCode = 404; res.end(); }
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	let researchers = 0, finalScouts = 0, probes = 0;
	/** @type {Context["agent"]} */
	const agent = async (prompt, options) => {
		if (options?.agent === profile) {
			researchers++; assert.match(prompt, /Does normal launch/); assert.ok(prompt.includes(f.tip));
			assert.deepEqual(options.schema?.required, ["status", "reason", "findings"], "research cannot directly issue a writer proposal");
			assert.equal(f.workers.size, 0);
			const binding = git(ref, "grep", "-l", "export const modes", pin, "--", "src").slice(pin.length + 1);
			assert.equal(binding, "src/binding.mjs");
			const entry = git(f.root, "show", `${f.tip}:app/start.mjs`);
			const adapter = git(ref, "show", `${pin}:${binding}`);
			const findings = [{ kind: "code", source: `${pin}:${binding}`, finding: adapter }];
			const url = new URL(await (await fetch(origin + "/search?q=launch")).text(), origin);
			const response = await fetch(url);
			if (response.status === 403) return { status: "unknown", reason: "SDK manual access denied; numeric modes are ambiguous.", findings };
			assert.equal(response.status, 200); const manual = await response.text();
			const cwd = mkdtempSync(path.join(path.dirname(f.root), "probe-"));
			put(cwd, "binding.mjs", adapter); put(cwd, "start.mjs", entry);
			const value = execFileSync(process.execPath, ["--input-type=module", "-e",
				`import {launchMode} from './start.mjs'; import {modes} from './binding.mjs'; console.log(modes[launchMode])`], { cwd, encoding: "utf8" }).trim();
			probes++;
			return { status: "answered", reason: "Compared the observed mode with the SDK manual.", findings: [...findings,
				{ kind: "docs", source: url.href, finding: manual }, { kind: "probe", source: `${f.tip}:app/start.mjs`, finding: `normal launch returned ${value}` }] };
		}
		assert.equal(options?.agent, "foundry-scout");
		const report = { evidence: ["charter"], grains: [] };
		if (!researchers) return { ...report, outcome: "needs-research", reason: question };
		finalScouts++;
		assert.ok(prompt.includes(pin)); assert.ok(prompt.includes(origin + "/manual/v3"));
		const actual = /normal launch returned (\d+)/.exec(prompt), restore = /restore=(\d+)/.exec(prompt);
		assert.ok(actual && restore, "the deciding scout needs the probe and its interpretation");
		if (actual[1] === restore[1]) return { ...report, outcome: "no-gap", reason: "The observed mode is restore." };
		return { ...report, outcome: "regenerate", reason: "Normal launch selected the replay mode.", grains: [
			{ id: "fix-launch", directory: "app", task: "Route normal launch through restore.", check: "unit.mjs", needs: [] }] };
	};
	/** @type {Promise<unknown>[]} */ const calls = [];
	let counter = 0;
	const issuer = f.runtime(f.root, { scout: (id, ticket, actor) => {
		const runId = `workflow-${++counter}`;
		const work = scoutDefinition(() => issuer).run({ args: { run: id, dispatch: ticket }, runId, agent,
			session: /** @type {Context["session"]} */ ({ sessionId: actor }), signal: new AbortController().signal,
			step: async (_key, produce) => produce(), parallel: fns => Promise.all(fns.map(fn => fn())), phase() {}, log() {},
			pause: () => assert.fail(), pipeline: () => assert.fail(), workflow: () => assert.fail() });
		calls.push(work); return work.then(() => ({ runId, status: "completed" }));
	} });
	await f.start(issuer);
	for (const call of calls) await call;
	await issuer.flush();
	const s = await f.status();
	assert.equal(researchers, 1); assert.equal(s.qualified, null); assert.equal(git(f.root, "rev-parse", "HEAD"), f.tip);
	assert.equal(s.assignments?.used, scenario === "denied" ? 2 : scenario === "correct" ? 3 : 4);
	assert.equal(probes, scenario === "denied" ? 0 : 1); assert.equal(finalScouts, probes);
	assert.deepEqual(s.nodes.map(n => [n.grain, n.state]), scenario === "replay" ? [["fix-launch", "writing"]] : []);
	assert.equal(f.workers.size, scenario === "replay" ? 1 : 0);
	if (scenario === "denied") assert.match(String(s.questions?.[0]?.question), /access denied/);
	else assert.equal(s.reviews.at(-1)?.observation?.outcome, scenario === "correct" ? "no-gap" : "regenerate");
});

for (const optedIn of [false, true]) test(`research cannot bypass charter or assignment limit: opted in ${optedIn}`, async t => {
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, direction: "Check launch.", target: "refs/heads/main",
			squads: [{ id: "client", areas: ["app"], charter: "charter", checks: ["unit.mjs"], boundary: ["interface"],
				...(optedIn ? { researchAgent: profile } : {}) }], limits: { assignments: 1 }, productCheck: "product.mjs", goalCheck: "goal.mjs" }),
		charter: "Check launch.", interface: "Restore on normal launch.", "goal.mjs": "process.exit(1)", "product.mjs": "", "unit.mjs": "",
	});

	await f.start();
	await f.scouts[0].report({ outcome: "needs-research", reason: question, evidence: ["charter"], grains: [] });
	const s = await f.status(); assert.equal(s.assignments?.used, 1); assert.equal(f.scouts.length, 1);
	assert.equal(s.reviews[0].state, optedIn ? "observed" : "blocked");
	if (!optedIn) assert.match(String(s.reviews[0].reason), /opted-in/);
	assert.equal(f.workers.size, 0); assert.equal(s.qualified, null);
});

test("research text is bounded across the whole report without dropping citations", () => {
	const entry = { kind: "code", source: "repo@rev:file", finding: "x".repeat(12_300) };
	const report = { status: "answered", reason: "Observed in source.", findings: [entry] };
	assert.deepEqual(researchResult(report, "charter").findings, [entry]);
	assert.throws(() => researchResult({ ...report, findings: [entry, entry] }, "charter"), /report exceeds its text budget/i);
});

test("a descriptive source label does not strand the Mac charter before the window check", async t => {
	const squads = ["runtime", "mac"].map(id => ({ id, areas: [id], charter: `${id}.md`, boundary: ["interface"],
		checks: ["unit.mjs"], ...(id === "mac" ? { researchAgent: profile } : {}) }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, direction: "Open the offline account.", target: "refs/heads/main",
			squads, productCheck: "product.mjs", goalCheck: "goal.mjs" }),
		"runtime.md": "Provide the offline account.", "mac.md": "Research the ordinary launch before assigning the Mac client.",
		interface: "Launch without a registration.", "product.mjs": "", "unit.mjs": "",
		"goal.mjs": `import {existsSync} from "node:fs";
			if (!existsSync("runtime/account")) process.exit(1);
			console.log("Window observer unavailable"); process.exit(2);`,
	});
	const plan = (/** @type {string} */ id) => ({ outcome: "regenerate", reason: `Fix ${id} launch.`,
		evidence: [`${id}.md`], grains: [{ id, directory: id, check: "unit.mjs", needs: [], task: `Implement ${id}.` }] });
	await f.start();
	const mac = f.scouts.find(r => r.squad === "mac"), core = f.scouts.find(r => r.squad === "runtime");
	assert.ok(mac && core); await core.report(plan("runtime"));
	await mac.report({ outcome: "needs-research", reason: question, evidence: ["mac.md"], grains: [] });
	const kind = "local checkout: static source inspection (not a runtime observation)";
	await f.scouts.at(-1)?.report({ status: "answered", reason: "Compared the two launch paths.",
		findings: [{ kind, source: "reference@abc:src/restore", finding: "The reference restores without a registration." }] });
	const decision = f.scouts.at(-1); assert.ok(decision && decision.prompt.includes(kind), "a fresh scout must get the attributed finding");
	await decision.report(plan("mac"));
	assert.equal(f.workers.size, 2);
	for (const [id, file] of [["runtime", "account"], ["mac", "window"]]) {
		const n = (await f.status()).nodes.find(n => n.grain === id);
		const w = n?.worker && f.workers.get(n.worker); assert.ok(w);
		put(w.cwd, `${id}/${file}`, "implemented");
		await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	}
	const s = await f.status(); assert.ok(s.checkpoint);
	assert.deepEqual(Object.keys(s.outputs ?? {}).sort(), ["mac", "runtime"]);
	assert.equal(s.goal?.receipt?.exit, 2); assert.equal(s.qualified, null);
});
