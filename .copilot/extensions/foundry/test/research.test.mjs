import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { researchResult, researchSchema } from "../work/research.mjs";
import { scoutDefinition } from "../work/scouts.mjs";
import { factory, git, loadEntry, put } from "./fixture.mjs";

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
		assert.ok(prompt.includes(pin));
		if (scenario === "denied") {
			assert.match(prompt, /SDK manual access denied/);
			return { ...report, outcome: "unresolved", reason: "SDK manual access denied; cannot decide the launch mode." };
		}
		assert.ok(prompt.includes(origin + "/manual/v3"));
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
	assert.equal(s.assignments?.used, scenario === "replay" ? 4 : 3);
	assert.equal(probes, scenario === "denied" ? 0 : 1); assert.equal(finalScouts, 1);
	assert.deepEqual(s.nodes.map(n => [n.grain, n.state]), scenario === "replay" ? [["fix-launch", "writing"]] : []);
	assert.equal(f.workers.size, scenario === "replay" ? 1 : 0);
	if (scenario === "denied") {
		assert.deepEqual(s.questions, []);
		assert.equal(s.reviews.at(-1)?.observation?.outcome, "unresolved");
		assert.match(String(s.reviews.at(-1)?.observation?.reason), /access denied/);
	}
	else assert.equal(s.reviews.at(-1)?.observation?.outcome, scenario === "correct" ? "no-gap" : "regenerate");
});

test("partial command research reaches the inventory writer with its citations and remaining gap", async t => {
	const charter = "coverage.md", check = "unit.mjs", goal = "goal.mjs";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, direction: "Inventory each surface.", target: "refs/heads/main",
			squads: [{ id: "coverage", areas: ["inventory"], charter, checks: [check], researchAgent: profile }],
			productCheck: "product.mjs", goalCheck: goal }),
		".foundry/launch/journey.md": "Publish the supported rows incrementally. Do not declare unknown surfaces complete.",
		[charter]: "Publish one inventory per surface using format.md.", "format.md": "Each row names the command and its source.",
		[check]: "", "product.mjs": "", [goal]: "console.log('Missing surface inventories'); process.exit(1)",
	});
	await f.start();
	const base = { evidence: [charter], grains: [] };
	await f.scouts[0].report({ ...base, outcome: "needs-research", reason: "Which commands exist on each surface?" });
	const ref = path.join(path.dirname(f.root), "adapter");
	mkdirSync(ref); git(ref, "init", "-q", "-b", "main");
	put(ref, "messages/menu", "Archive appears in the message menu."); git(ref, "add", "."); git(ref, "commit", "-qm", "message command");
	const sourceAt = `${git(ref, "rev-parse", "HEAD")}:messages/menu`;
	const finding = { kind: "code", source: `adapter@${sourceAt}`, finding: git(ref, "show", sourceAt) };
	const reason = "The nested thread menu remains unobserved.";
	await f.scouts[1].report({ status: "unknown", reason, findings: [finding] });
	const decision = f.scouts[2]; assert.ok(decision, "partial findings need a deciding scout, not a terminal research stall");
	assert.ok(decision.prompt.includes(finding.source) && decision.prompt.includes(reason));
	await decision.report({ ...base, outcome: "needs-evidence", file: "format.md", reason: "Read the required row format." });
	const focused = f.scouts[3]; assert.ok(focused.prompt.includes(finding.source) && focused.prompt.includes(reason));
	await focused.report({ ...base, evidence: [charter, "format.md"], outcome: "regenerate", reason: "Only the message surface is ready.",
		grains: [{ id: "messages", task: "Publish the supported inventory rows.", directory: "inventory/messages", check, needs: [] }] });
	const [w] = f.workers.values(); assert.ok(w);
	assert.ok(w.prompt.includes(finding.source) && w.prompt.includes(finding.finding) && w.prompt.includes(reason),
		"the writer must not have to reconstruct the citation or guess which surface remains unknown");
	assert.equal((await f.status()).qualified, null);
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

test("all attributed research reaches the scout regardless of count or length", () => {
	const findings = Array.from({ length: 16 }, (_, i) => ({ kind: "code", source: `repo@rev:file${i}`, finding: "x".repeat(3000) }));
	assert.deepEqual(researchResult({ status: "answered", reason: "Observed in source.", findings }, "charter").findings, findings);
	assert.ok(!("maxItems" in researchSchema.properties.findings));
});

test("a waiting design squad reads coverage's frozen revision before any inventory or writer exists", async t => {
	const squads = ["design", "coverage", "other"].map(id => ({ id, areas: [id], charter: `${id}.md`, checks: ["unit.mjs"], researchAgent: "foundry-research" }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, direction: "Share the reference revision.", target: "refs/heads/main",
			squads, productCheck: "product.mjs", goalCheck: "goal.mjs" }),
		".foundry/launch/journey.md": "Coverage freezes the adapter checkout. Design uses that same revision.",
		"coverage.md": "Freeze ../adapter during discovery.", "design.md": "Compare the layout in ../adapter.", "other.md": "Independent work.",
		"goal.mjs": "process.exit(1)", "product.mjs": "", "unit.mjs": "",
	});
	const ref = path.join(path.dirname(f.root), "adapter");
	mkdirSync(ref); git(ref, "init", "-q", "-b", "main"); put(ref, "layout", "three panes");
	git(ref, "add", "."); git(ref, "commit", "-qm", "original"); const revision = git(ref, "rev-parse", "HEAD");
	await f.start();
	const latest = (/** @type {string} */ squad) => {
		const s = f.scouts.findLast(r => r.squad === squad); assert.ok(s); return s;
	};
	const request = (/** @type {string} */ id) => ({ outcome: "needs-research", reason: "Inspect the reference.", evidence: [`${id}.md`], grains: [] });
	await latest("design").report({ outcome: "waiting", waitFor: "reference:adapter", reason: "Read the frozen layout.", evidence: ["design.md"], grains: [] });
	await latest("other").report({ outcome: "waiting", waitFor: "coverage", reason: "Need the finished inventory.", evidence: ["other.md"], grains: [] });
	await latest("coverage").report(request("coverage"));
	await latest("coverage").report({ status: "unknown", reason: "Inventory is incomplete.", findings: [
		{ kind: "code", source: "coverage-only-locator", finding: "coverage-only-note" }], references: [{ repo: "adapter", revision }, { repo: "other-adapter", revision }] });
	const research = latest("design");
	assert.equal(f.scouts.filter(r => r.squad === "other").length, 1, "a pin is not a checked output");
	const publisher = latest("coverage");
	assert.ok(publisher.prompt.includes("coverage-only-note"), "the publisher gets its partial findings for a decision");
	await publisher.report({ outcome: "unresolved", reason: "Remaining commands inaccessible.", evidence: ["coverage.md"], grains: [] });
	assert.equal(latest("coverage").id, publisher.id, "publishing must not restart the investigation");
	assert.ok(research.prompt.includes(revision), "publication must wake the repository wait before inventory is complete");
	put(ref, "layout", "one pane"); git(ref, "commit", "-qam", "changed upstream"); put(ref, "layout", "dirty");
	const pin = JSON.parse(research.prompt.split("\n").find(line => line.startsWith('{"repo":"adapter"')) ?? "null");
	assert.deepEqual(pin, { repo: "adapter", revision });
	assert.doesNotMatch(research.prompt, /coverage-only-/);
	const ctx = { sessionId: "owner" }, hook = { ...ctx, timestamp: new Date(), workingDirectory: f.root };
	const extension = await loadEntry({ ...ctx, on() {}, rpc: { mode: { get: async () => "interactive" } } });
	await extension.hooks?.onSessionStart?.({ ...hook, source: "startup" }, ctx);
	t.after(() => extension.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	const tool = extension.tools?.find(t => t.name === "foundry_reference");
	assert.ok(tool?.handler && extension.customAgents?.find(a => a.name === "foundry-research")?.tools?.includes(tool.name));
	const actor = { ...ctx, agentId: "research-helper", toolName: tool.name, toolCallId: "read" };
	const args = { run, review: research.id, repo: pin.repo, revision: pin.revision, path: "layout" };
	assert.notEqual((await extension.hooks?.onPreToolUse?.({ ...hook, ...actor, toolArgs: args }, ctx))?.permissionDecision, "deny");
	const read = (more = {}) => tool.handler?.({ ...args, ...more }, { ...actor, arguments: { ...args, ...more } });
	const observed = await read();
	assert.equal(observed, "three panes");
	assert.match(JSON.stringify(await read({ repo: "other-adapter" })), /not bound to that reference/, "knowing another published pin does not expand this read");
	for (const changed of [{ revision: git(ref, "rev-parse", "HEAD") }, { repo: "../adapter" }, { path: "../layout" }, { review: latest("other").id }])
		assert.match(JSON.stringify(await read(changed)), /"resultType":"failure"/);
	await research.report({ status: "answered", reason: "Read the frozen layout.", findings: [{ kind: "code", source: `${revision}:layout`, finding: observed }] });
	assert.match(latest("design").prompt, /three panes/);
	assert.match(JSON.stringify(await read()), /"resultType":"failure"/, "a settled research job cannot read again");
	assert.equal(f.workers.size, 0); assert.equal((await f.status()).qualified, null);
});

test("late waits reuse the run-wide pin and a conflicting publication by another squad is rejected atomically", async t => {
	const squads = ["coverage", "design", "peer", "confirm"].map(id => ({ id, areas: [id], charter: `${id}.md`, checks: ["unit"], researchAgent: profile }));
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 2, id: run, direction: "Investigate.", target: "refs/heads/main",
		squads, productCheck: "product.mjs", goalCheck: "goal.mjs" }), ".foundry/launch/journey.md": "Share the frozen revision.",
		"coverage.md": "Freeze the reference.", "design.md": "Use coverage's revision.", "peer.md": "Investigate.", "confirm.md": "Confirm the revision.", "goal.mjs": "process.exit(1)", "product.mjs": "", unit: "" });
	const latest = (/** @type {string} */ squad) => { const r = f.scouts.findLast(r => r.squad === squad); assert.ok(r); return r; };
	const investigate = (/** @type {string} */ squad) => latest(squad).report({ outcome: "needs-research", evidence: [`${squad}.md`], grains: [], reason: "Inspect source." });
	await f.start(); await investigate("design"); const early = latest("design");
	await investigate("coverage");
	const pin = { repo: "adapter", revision: "1".repeat(40) };
	const partial = { status: "unknown", reason: "Still surveying.", findings: [] };
	await latest("coverage").report({ ...partial, references: [pin] });
	await investigate("confirm"); await latest("confirm").report({ ...partial, references: [pin] });
	assert.equal((await f.status()).reviews.filter(r => r.squad === "confirm").at(-1)?.state, "observed");
	await investigate("peer");
	const rejected = "2".repeat(40);
	await latest("peer").report({ ...partial, references: [{ repo: "spurious", revision: rejected }, { ...pin, revision: rejected }] });
	assert.match(String((await f.status()).reviews.filter(r => r.squad === "peer").at(-1)?.reason), /already frozen/);
	assert.ok(!early.prompt.includes(pin.revision)); await early.report({ ...partial, waitFor: "reference:adapter" });
	const ready = latest("design"); assert.ok(ready.prompt.includes(pin.revision)); assert.ok(!ready.prompt.includes(rejected));
	await ready.report({ ...partial, waitFor: "reference:adapter" });
	assert.equal(latest("design").id, ready.id, "an unchanged reference cannot repeatedly wake the same investigation");
	assert.deepEqual((await f.status()).questions, []);
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
