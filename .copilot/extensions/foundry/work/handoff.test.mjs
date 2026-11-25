import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.mjs";
import { handoff, qualification } from "./handoff.mjs";
import { archiveCheck } from "../../../skills/foundry/scripts/archive-check.mjs";
import { status } from "./status.mjs";
import { factory, git, put } from "../test/fixture.mjs";

const run = "pages", source = ".foundry/pages.json", component = ".foundry/component.mjs", productCheck = ".foundry/product.mjs", goalCheck = ".foundry/goal.mjs";
const script = fileURLToPath(new URL("../../../skills/foundry/scripts/archive-check.mjs", import.meta.url));
const transfer = fileURLToPath(new URL("../../../skills/foundry/scripts/qualification.mjs", import.meta.url));
const ids = ["cover", "tables", "reader"];
const invariant = `import {readFileSync} from 'node:fs'; for(const id of ${JSON.stringify(ids)})
	if(readFileSync('lib/'+id+'/value','utf8')!==id) throw Error(id);`;
const goalProgram = `${invariant}\nif(!readFileSync('lib/cover/extra.ignored','utf8').includes('kept in the capture')) throw Error('cover missing');`;

/** Native transport only is faked. Use the actual dispatcher, captures, evaluator receipts and joined tree.
 * @param {import("node:test").TestContext} t @param {boolean} goal @param {boolean} [pair] */
async function qualify(t, goal, pair = false) {
	const grains = ids.map(id => ({ id, directory: `lib/${id}`, check: component, needs: id === "reader" ? ["tables"] : [] }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ id: run, direction: "Build the complete reader", target: "refs/heads/main", productCheck, ...(goal
			? { version: 2, goalCheck, squads: [{ id: "pages", charter: "brief", areas: ["lib"], boundary: ["api"], checks: [component] }] }
			: { version: 1, seed: ["cover", "reader"], squads: [{ id: "pages", charter: "brief", grains: ids }],
				grains: grains.map(g => ({ ...g, specification: "brief", boundary: ["api"] })) }) }),
		brief: "Build the reader", api: "Export value", ".gitignore": "*.ignored\n", "lib/cover/obsolete": "old cover",
		[component]: `import {readFileSync} from 'node:fs'; for(const dir of JSON.parse(process.env.FOUNDRY_DIRECTORIES))
			if(readFileSync(dir+'/value','utf8')!==process.env.FOUNDRY_GRAIN) throw Error('wrong value');`,
		[productCheck]: invariant, [goalCheck]: goalProgram,
	});
	const read = () => {
		const db = openDatabase(f.root);
		try { const state = db.read(run); assert.ok(state); return state; } finally { db.close(); }
	};
	await f.start();
	if (goal) await f.scouts[0].report({ outcome: "regenerate", reason: "Complete the missing pages", evidence: ["brief"],
		grains: grains.map(g => ({ ...g, directory:pair && g.id==="cover" ? [g.directory,"lib/illustrations"] : g.directory, task: `Render the ${g.id} page` })) });
	assert.equal(handoff(read()), null);
	let checkpoint;
	for (const id of ids) {
		const n = read().nodes[id], w = f.workers.get(n.worker ?? ""); assert.ok(w);
		if (id === "cover") {
			if (pair) put(w.cwd,"lib/illustrations/value",id);
			if (!goal) git(w.cwd, "switch", "-qc", "native-cover");
			put(w.cwd, "lib/cover/extra.ignored", "kept in the capture, despite .gitignore\n");
		}
		put(w.cwd, `lib/${id}/value`, id);
		const writer = f.runtime(w.cwd, { execute: async (...args) => {
			if (args[0] === "bash" && String(args[1].description).startsWith("Check final goal")) {
				const at = read(), milestone = at.products.at(-1); checkpoint = milestone?.commit;
				assert.ok(checkpoint && milestone?.qualifiedAt === undefined); assert.equal(handoff(at), null, "a checked milestone alone is not the goal");
				assert.equal(qualification(at), null);
			}
			return f.execute(...args);
		} });
		await writer.operation("submit", { run, token: w.token }, w.id);
		if (id === "cover") {
			assert.equal(read().nodes.cover.state, "published");
			assert.equal(handoff(read()), null, "component pass is not a product");
			assert.equal(qualification(read()), null);
		}
	}
	/** @param {string} detail @param {string} [actor] */
	const details = (detail, actor = "owner") => f.owner.operation("status", { run, detail }, actor);
	const state = read(), ownerStatus = await f.status(), h = (await details("cleanup")).handoff;
	assert.ok(h?.writers && h.commit === ownerStatus.qualified);
	assert.deepEqual(ownerStatus.handoff, { mode: goal ? "goal" : "one-off", commit: h.commit, target: h.target, targetRef: h.targetRef });
	assert.deepEqual(h, handoff(state, true));
	assert.ok(!("qualification" in ownerStatus) && ownerStatus.metrics && !("history" in ownerStatus.metrics));
	assert.ok("history" in ((await details("usage")).metrics ?? {}));
	if (goal) assert.equal(h.commit, checkpoint);
	assert.deepEqual(h.writers.map(w => w.grain), ["cover"]); // tables created reader during submit; neither is an owner leaf.
	const [w] = h.writers, root = realpathSync(f.root), writer = realpathSync(f.workers.get(w.id)?.cwd ?? assert.fail("missing native worktree"));
	assert.ok(!("handoff" in await f.status(w.id)), "writer status is not the owner handoff");
	for (const detail of ["proof", "cleanup", "usage"]) await assert.rejects(details(detail, w.id), { code: "foreign_run" });
	const native = { caller: "owner", coordinator: "owner", id: w.id, name: w.name, workspace: "local-worktree", path: writer,
		branch: goal ? null : "refs/heads/native-cover", activity: "idle", ongoingWork: false, openPR: false, agentMerge: false,
		automation: false, nestedWork: false, externalWork: false };
	return { state, read, details, h, w, root, writer, native };
}

test("cleanup rechecks every root in the selected qualified writer capture", async t => {
	const {h,native,root,writer} = await qualify(t,true,true);
	const {offer} = archiveCheck(root,"offer",{handoff:h,native}); assert.ok(offer);
	assert.deepEqual(offer.directory,["lib/cover","lib/illustrations"]);
	const input = {handoff:h,native,selected:offer};
	assert.deepEqual(archiveCheck(root,"recheck",input),{tool:"archive_session",arguments:{id:native.id}});
	assert.throws(()=>archiveCheck(root,"recheck",{...input,selected:{...offer,directory:"lib/cover"}}),/Selection/);
	put(writer,"lib/illustrations/value","private change");
	assert.throws(()=>archiveCheck(root,"recheck",input),/changed/i);
	put(writer,"lib/illustrations/value","cover"); put(writer,"lib/neighbor/private","unrelated");
	assert.throws(()=>archiveCheck(root,"recheck",input),/Unexpected path/);
});

test("goal: only the accepted exact product reaches the owner; no inferred authority over delegated work", async t => {
	const { state, h, root, native, details } = await qualify(t, true);
	assert.equal(h.commit, state.goal?.commit);
	assert.ok(archiveCheck(root, "offer", { handoff: h, native }).offer, "detached native leaf can be checked");
	const proof = (await details("proof")).qualification;
	assert.ok(proof); assert.deepEqual(proof, qualification(state));
	assert.deepEqual(proof.receipts, { product: { commit: h.commit, check: productCheck, exit: 0 }, goal: { commit: h.commit, check: goalCheck, exit: 0 } });
	const reader = proof.outputs.find(o => o.id === "reader"), n = state.nodes.reader;
	assert.deepEqual(reader, { id: "reader", directory: "lib/reader", commit: n.candidate, behavior: "Render the reader page",
		specification: "brief", squad: "pages", charter: "brief", boundary: ["api"], receipt: { commit: n.candidate, check: component, exit: 0 },
		base: n.base, generation: n.generation, needs: ["tables"], inputs: { tables: state.nodes.tables.candidate } });
	const privateState = structuredClone(state);
	for (const e of privateState.effects) {
		e.issuer = "private session"; e.callId = "private call"; e.args = { kickoff: { prompt: "private prompt" } };
		if (e.receipt) e.receipt.output = "private diagnostic";
		if (e.kind === "scout") e.decision = { status: "answered", answer: "private answer" };
	}
	for (const n of Object.values(privateState.nodes)) { n.worker = "private writer"; n.token = "private token"; }
	assert.deepEqual(qualification(privateState), proof);
	let kickoffReads = 0;
	for (const e of privateState.effects.filter(e => e.kind === "writer")) Object.defineProperty(e.args, "kickoff", {
		get() { kickoffReads++; return { prompt: "private prompt" }; },
	});
	status(privateState, state.owner); status(privateState, state.owner, "proof");
	assert.equal(kickoffReads, 0, "an ordinary status or proof must not reconstruct usage");
	status(privateState, state.owner, "usage"); assert.ok(kickoffReads > 0);
	for (const kind of ["goal", "product", "component"]) {
		const copy = structuredClone(state);
		const id = kind === "goal" ? copy.goal?.check : kind === "product" ? copy.products.at(-1)?.check : copy.nodes.cover.check;
		const e = copy.effects.find(e => e.id === id); assert.ok(e?.receipt);
		e.receipt.commit = h.target; // Exit 0 on another commit attests to nothing here.
		assert.equal(qualification(copy), null);
		if (kind === "component") assert.deepEqual(handoff(copy, true)?.writers, []);
		else assert.equal(handoff(copy), null);
		e.receipt.commit = e.commit ?? assert.fail("missing check commit");
		delete e.runnerStarted;
		assert.equal(qualification(copy), null, "native success without a runner receipt");
		e.runnerStarted = true; e.receipt.exit = 2;
		assert.equal(qualification(copy), null, "missing external observation is never a pass");
	}
	const stale = structuredClone(state);
	stale.nodes.reader.inputs = {};
	assert.equal(qualification(stale), null, "never guess missing assignment pins");
	stale.nodes.reader.inputs = n.inputs;
	stale.nodes.reader.candidate = h.target;
	assert.equal(qualification(stale), null, "never describe a different output version under the same grain name");
	const copy = structuredClone(state);
	assert.ok(copy.goal); copy.goal.target = h.commit;
	assert.equal(qualification(copy), null, "same commit but another target assessment");
	copy.goal.target = h.target;
	const created = copy.effects.find(e => e.nativeId === native.id); assert.ok(created);
	created.state = "uncertain";
	assert.deepEqual(handoff(copy, true)?.writers, []);
});

test("a goal already met on a different target tip exports both exact baseline receipts without a writer", async t => {
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Build the complete reader", target: "refs/heads/main", productCheck, goalCheck,
			squads: [{ id: "pages", charter: "brief", grains: ["reader"] }],
			grains: [{ id: "reader", directory: "lib/reader", specification: "brief", boundary: ["api"], check: component }] }),
		brief: "Build the reader", api: "Export value", [component]: "", [productCheck]: "", [goalCheck]: "",
	});
	git(f.root, "switch", "-qc", "author"); put(f.root, "unrelated", "newer than the target"); git(f.root, "add", "unrelated");
	git(f.root, "commit", "-qm", "unrelated author change");
	await f.start();
	const { qualification: p } = await f.owner.operation("status", { run, detail: "proof" }, "owner");
	assert.ok(p); assert.equal(p.commit, f.tip); assert.deepEqual(p.target, { ref: "refs/heads/main", commit: f.tip });
	assert.deepEqual(p.contract, { path: source, commit: git(f.root, "rev-parse", "HEAD"), version: 1 });
	assert.notEqual(p.contract.commit, p.target.commit); assert.deepEqual(p.outputs, []); assert.equal(f.workers.size, 0);
	assert.equal(p.receipts.product.commit, p.commit); assert.equal(p.receipts.goal.commit, p.commit);
});

test("offline transfer to an ordinary clone includes the parentless captures and inputs, never a branch update", async t => {
	const { root, details } = await qualify(t, true);
	const proof = (await details("proof")).qualification; assert.ok(proof);
	const directory = path.dirname(root), dest = path.join(directory, "clean"), bundle = path.join(directory, "proof.bundle");
	/** @param {string} location */
	const cleanClone = location => git(root, "clone", "-q", "--no-local", "--no-tags", "--single-branch", "--branch", "main", "--", root, location);
	cleanClone(dest);
	const sourceRefs = git(root, "show-ref"), destRefs = git(dest, "show-ref"), tip = git(dest, "rev-parse", "HEAD");
	assert.equal(tip, proof.target.commit); assert.throws(() => git(dest, "cat-file", "-e", proof.commit));
	const reader = proof.outputs.find(o => o.id === "reader"); assert.ok(reader);
	for (const pin of [reader.generation, reader.commit, reader.inputs.tables]) {
		assert.equal(git(root, "rev-list", "--parents", "-1", pin), pin);
		assert.throws(() => git(dest, "cat-file", "-e", pin));
	}
	/** @param {string} cwd @param {string} action @param {string} file @param {unknown} [manifest] */
	const cli = (cwd, action, file, manifest = proof) => spawnSync(process.execPath, [transfer, action, file],
		{ cwd, input: JSON.stringify(manifest), encoding: "utf8" });
	const pack = cli(root, "pack", bundle);
	assert.equal(pack.status, 0, pack.stderr); assert.equal(git(root, "show-ref"), sourceRefs);
	assert.notEqual(cli(root, "pack", bundle).status, 0, "never overwrite an existing export");
	const wrong = { ...proof, receipts: { ...proof.receipts, goal: { ...proof.receipts.goal, commit: tip } } };
	assert.notEqual(cli(dest, "import", bundle, wrong).status, 0);
	const incomplete = path.join(directory, "candidate-only.bundle");
	git(root, "bundle", "create", incomplete, `refs/foundry/objects/${proof.commit}`);
	assert.match(cli(dest, "import", incomplete).stderr, /exact qualification pins/);
	const extra = path.join(directory, "extra-head.bundle");
	const pins = git(root, "bundle", "list-heads", bundle).split("\n").map(line => line.split(" ")[1]);
	git(root, "bundle", "create", extra, ...pins, "refs/heads/main");
	assert.match(cli(dest, "import", extra).stderr, /exact qualification pins/);
	assert.equal(git(dest, "show-ref"), destRefs); assert.throws(() => git(dest, "cat-file", "-e", proof.commit));
	const imported = cli(dest, "import", bundle);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(git(dest, "rev-parse", "HEAD"), tip); assert.equal(git(dest, "status", "--porcelain"), "");
	assert.equal(git(dest, "show-ref").split("\n").filter(s => !s.includes(" refs/foundry/objects/")).join("\n"), destRefs);
	assert.equal(git(root, "show-ref"), sourceRefs); assert.equal(existsSync(path.join(dest, ".git/foundry")), false);
	for (const out of proof.outputs) {
		for (const pin of [out.commit, out.generation, out.base, ...Object.values(out.inputs)])
			assert.equal(git(dest, "rev-parse", `refs/foundry/objects/${pin}^{commit}`), pin);
		assert.equal(git(dest, "rev-parse", `${out.commit}:${out.directory}`), git(dest, "rev-parse", `${proof.commit}:${out.directory}`));
		for (const file of [out.charter, out.specification, ...out.boundary, out.receipt.check])
			assert.equal(git(dest, "rev-parse", `${proof.contract.commit}:${file}`), git(dest, "rev-parse", `${out.generation}:${file}`));
	}
	// Import does not execute code. Independently replay these two trusted fixture checks on the imported revision.
	const replay = path.join(directory, "replay"), outputs = Object.fromEntries(proof.outputs.map(o => [o.id, o.directory]));
	git(dest, "worktree", "add", "-q", "--detach", replay, proof.commit);
	for (const [kind, receipt] of Object.entries(proof.receipts)) {
		assert.equal(git(replay, "rev-parse", "HEAD"), receipt.commit);
		const result = spawnSync(process.execPath, [receipt.check], { cwd: replay, encoding: "utf8",
			env: { PATH: process.env.PATH, ...(kind === "product" ? { FOUNDRY_OUTPUTS: JSON.stringify(outputs) } : {}) } });
		assert.equal(result.status, receipt.exit, `${kind}: ${result.stderr}`);
	}
	git(dest, "worktree", "remove", replay);
	assert.equal(git(dest, "rev-parse", proof.target.ref), tip);
	const collision = path.join(directory, "collision"); cleanClone(collision);
	git(collision, "symbolic-ref", `refs/foundry/objects/${proof.commit}`, proof.target.ref);
	const prior = git(collision, "show-ref");
	assert.notEqual(cli(collision, "import", bundle).status, 0, "never follow, overwrite or partially install over an existing pin");
	assert.equal(git(collision, "show-ref"), prior); assert.equal(git(collision, "rev-parse", "HEAD"), tip);
	const badBundle = path.join(directory, "bad.bundle"), ref = `refs/foundry/objects/${reader.generation}`;
	git(root, "update-ref", ref, tip, reader.generation); // right name, wrong contents
	assert.match(cli(root, "pack", badBundle).stderr, /exact qualification pins/); assert.equal(existsSync(badBundle), false);
	git(root, "update-ref", "-d", ref, tip);
	assert.notEqual(cli(root, "pack", badBundle).status, 0, "a missing source pin cannot be replaced by its SHA in a document");
	assert.equal(existsSync(badBundle), false); assert.equal(git(root, "rev-parse", "main"), tip);
});

test("one-off: verifiable captured untracked work yields one named native handoff, never an action on offer", async t => {
	const { h, w, root, writer, native, read, details } = await qualify(t, false);
	assert.equal((await details("proof")).qualification, null, "one-off product checks never become goal proof");
	const ongoing = read(); delete ongoing.policy.seed;
	assert.equal(handoff(ongoing)?.mode, "ongoing"); assert.equal(qualification(ongoing), null);
	assert.notEqual(h.commit, w.candidate);
	assert.equal(git(root, "rev-list", "--parents", "-1", w.generation), w.generation); // Parentless, and no old grain.
	assert.equal(git(root, "rev-parse", `${h.commit}^`), h.target);
	assert.ok(git(writer, "ls-files", "--others", "--exclude-standard").includes("lib/cover/value"));
	assert.equal(git(root, "show", `${h.commit}:lib/cover/extra.ignored`), "kept in the capture, despite .gitignore");
	const index = git(writer, "rev-parse", "--path-format=absolute", "--git-path", "index");
	const before = { index: readFileSync(index), refs: git(root, "show-ref") };
	/** @param {string} phase @param {object} data */
	const cli = (phase, data) => spawnSync(process.execPath, [script, phase], { cwd: root, input: JSON.stringify(data), encoding: "utf8" });
	const offered = cli("offer", { handoff: h, native });
	assert.equal(offered.status, 0, offered.stderr);
	const { offer: selected, tool } = JSON.parse(offered.stdout);
	assert.ok(selected); assert.equal(tool, undefined); assert.equal(selected.id, w.id); assert.equal(selected.commit, h.commit);
	const fresh = { handoff: (await details("cleanup")).handoff, native: { ...native }, selected };
	const call = cli("recheck", fresh);
	assert.equal(call.status, 0, call.stderr);
	assert.deepEqual(JSON.parse(call.stdout), { tool: "archive_session", arguments: { id: w.id } });
	assert.deepEqual({ index: readFileSync(index), refs: git(root, "show-ref") }, before);

	// During the choice dialog: neither an old "idle" nor an earlier green scan is a lease.
	for (const key of ["ongoingWork", "openPR", "agentMerge", "automation", "nestedWork", "externalWork"]) {
		for (const value of [true, undefined]) assert.throws(() =>
			archiveCheck(root, "recheck", { ...fresh, native: { ...native, [key]: value } }), /not verified clear/, key);
	}
	for (const changed of [{ caller: "another owner" }, { coordinator: null }, { id: "other child" }, { name: "renamed" },
		{ activity: "busy" }, { activity: "unknown" }, { workspace: "cloud" }, { path: root }, { branch: null }])
		assert.throws(() => archiveCheck(root, "recheck", { ...fresh, native: { ...native, ...changed } }));
	for (const approval of [undefined, "all", { ...selected, commit: h.target }, { ...selected, id: "sibling" }])
		assert.throws(() => archiveCheck(root, "recheck", { ...fresh, selected: approval }), /Selection/);
	const reassigned = read(); reassigned.nodes.cover.state = "writing";
	assert.throws(() => archiveCheck(root, "recheck", { ...fresh, handoff: handoff(reassigned, true) }), /finished writer/);
	assert.throws(() => archiveCheck(root, "offer", { handoff: { ...h, commit: w.generation }, native }), /included grain/);

	put(writer, "other/notes.ignored", "the only copy");
	const changed = cli("recheck", fresh);
	assert.equal(changed.status, 1); assert.equal(changed.stdout, ""); assert.match(changed.stderr, /product_changed|unsupported_tree/);
	assert.equal(readFileSync(path.join(writer, "other/notes.ignored"), "utf8"), "the only copy");
	rmSync(path.join(writer, "other"), { recursive: true });
	for (const [p, data] of [["lib/cover/value", "new value"], ["api", "unrelated edit"], ["lib/cover/draft", "untracked"]]) {
		put(writer, p, data);
		assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "product_changed" });
		if (p === "lib/cover/draft") rmSync(path.join(writer, p)); else put(writer, p, p === "api" ? "Export value" : "cover");
	}
	chmodSync(path.join(writer, "lib/cover/value"), 0o755);
	assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "product_changed" });
	chmodSync(path.join(writer, "lib/cover/value"), 0o644);
	mkdirSync(path.join(writer, "lib/cover/uncaptured-empty"));
	assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "product_changed" });
	rmSync(path.join(writer, "lib/cover/uncaptured-empty"), { recursive: true });
	linkSync(path.join(writer, "api"), path.join(root, "external-link"));
	assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "unsupported_tree" });
	rmSync(path.join(root, "external-link"));
	put(writer, "api", "index-only work"); git(writer, "add", "api"); put(writer, "api", "Export value");
	assert.throws(() => archiveCheck(root, "recheck", fresh), /Index/);
	git(writer, "restore", "--staged", "--", "api");
	mkdirSync(path.join(writer, "lib/cover/.git"));
	assert.throws(() => archiveCheck(root, "recheck", fresh), /path|\.git/);
	rmSync(path.join(writer, "lib/cover/.git"), { recursive: true });
	const unique = git(writer, "commit-tree", `${w.generation}^{tree}`, "-p", w.generation, "-m", "unique writer history");
	git(writer, "update-ref", "HEAD", unique, w.generation);
	assert.throws(() => archiveCheck(root, "recheck", fresh), /generation/);
	git(writer, "update-ref", "HEAD", w.generation, unique);
	assert.throws(() => archiveCheck(root, "recheck", fresh), /history/);
});
