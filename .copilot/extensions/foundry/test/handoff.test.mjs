import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../work/database.mjs";
import { archiveCheck, handoff } from "../work/handoff.mjs";
import { factory, git, put } from "./fixture.mjs";

const run = "pages", source = ".foundry/pages.json", component = ".foundry/component.mjs", productCheck = ".foundry/product.mjs", goalCheck = ".foundry/goal.mjs";
const script = fileURLToPath(new URL("../../../skills/foundry/scripts/archive-check.mjs", import.meta.url));
const ids = ["cover", "tables", "reader"];
const invariant = `import {readFileSync} from 'node:fs'; for(const id of ${JSON.stringify(ids)})
	if(readFileSync('lib/'+id+'/value','utf8')!==id) throw Error(id);`;

/** Native transport only is faked. Use the actual dispatcher, captures, evaluator receipts and joined tree.
 * @param {import("node:test").TestContext} t @param {boolean} goal */
async function qualify(t, goal) {
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Build the complete reader", target: "refs/heads/main", productCheck,
			...(goal ? { goalCheck } : { seed: ["cover", "reader"] }), squads: [{ id: "pages", charter: "brief", grains: ids }],
			grains: ids.map(id => ({ id, directory: `lib/${id}`, specification: "brief", boundary: ["api"], check: component, needs: id === "reader" ? ["tables"] : [] })) }),
		brief: "Build the reader", api: "Export value", ".gitignore": "*.ignored\n", "lib/cover/obsolete": "old cover",
		[component]: `import {readFileSync} from 'node:fs'; if(readFileSync(process.env.FOUNDRY_DIRECTORY+'/value','utf8')!==process.env.FOUNDRY_GRAIN) throw Error('wrong value');`,
		[productCheck]: invariant, [goalCheck]: invariant,
	});
	const read = () => {
		const db = openDatabase(f.root);
		try { const state = db.read(run); assert.ok(state); return state; } finally { db.close(); }
	};
	await f.start();
	if (goal) await f.scouts[0].report({ outcome: "regenerate", reason: "Complete the missing pages", evidence: ["brief"], grains: ["cover", "reader"] });
	assert.equal(handoff(read()), null);
	let checkpoint;
	for (const id of ids) {
		const n = read().nodes[id], w = f.workers.get(n.worker ?? ""); assert.ok(w);
		if (id === "cover") {
			if (!goal) git(w.cwd, "switch", "-qc", "native-cover");
			put(w.cwd, "lib/cover/extra.ignored", "kept in the capture, despite .gitignore\n");
		}
		put(w.cwd, `lib/${id}/value`, id);
		const writer = f.runtime(w.cwd, { execute: async (...args) => {
			if (args[0] === "bash" && String(args[1].description).startsWith("Check final goal")) {
				const at = read(), milestone = at.products.at(-1); checkpoint = milestone?.commit;
				assert.ok(checkpoint && milestone?.qualifiedAt === undefined); assert.equal(handoff(at), null, "a checked milestone alone is not the goal");
			}
			return f.execute(...args);
		} });
		await writer.operation("submit", { run, token: w.token }, w.id);
		if (id === "cover") {
			assert.equal(read().nodes.cover.state, "published");
			assert.equal(handoff(read()), null, "component pass is not a product");
		}
	}
	const state = read(), ownerStatus = await f.status(), h = ownerStatus.handoff;
	assert.ok(h && h.commit === ownerStatus.qualified);
	assert.deepEqual(h, handoff(state));
	if (goal) assert.equal(h.commit, checkpoint);
	assert.deepEqual(h.writers.map(w => w.grain), ["cover"]); // tables created reader during submit; neither is an owner leaf.
	const [w] = h.writers, root = realpathSync(f.root), writer = realpathSync(f.workers.get(w.id)?.cwd ?? assert.fail("missing native worktree"));
	assert.ok(!("handoff" in await f.status(w.id)), "writer status is not the owner handoff");
	const native = { caller: "owner", coordinator: "owner", id: w.id, name: w.name, workspace: "local-worktree", path: writer,
		branch: goal ? null : "refs/heads/native-cover", activity: "idle", ongoingWork: false, openPR: false, agentMerge: false,
		automation: false, nestedWork: false, externalWork: false };
	return { state, read, status: f.status, h, w, root, writer, native };
}

test("goal: only the accepted exact product reaches the owner; no inferred authority over delegated work", async t => {
	const { state, h, root, native } = await qualify(t, true);
	assert.equal(h.commit, state.goal?.commit);
	assert.ok(archiveCheck(root, "offer", { handoff: h, native }).offer, "detached native leaf can be checked");
	for (const kind of ["goal", "product", "component"]) {
		const copy = structuredClone(state);
		const id = kind === "goal" ? copy.goal?.check : kind === "product" ? copy.products.at(-1)?.check : copy.nodes.cover.check;
		const e = copy.effects.find(e => e.id === id); assert.ok(e?.receipt);
		e.receipt.commit = h.target; // Exit 0 on another commit attests to nothing here.
		if (kind === "component") assert.deepEqual(handoff(copy)?.writers, []);
		else assert.equal(handoff(copy), null);
	}
	const copy = structuredClone(state);
	const created = copy.effects.find(e => e.nativeId === native.id); assert.ok(created);
	created.state = "uncertain";
	assert.deepEqual(handoff(copy)?.writers, []);
});

test("one-off: verifiable captured untracked work yields one named native handoff, never an action on offer", async t => {
	const { h, w, root, writer, native, read, status } = await qualify(t, false);
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
	const fresh = { handoff: (await status()).handoff, native: { ...native }, selected };
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
	assert.throws(() => archiveCheck(root, "recheck", { ...fresh, handoff: handoff(reassigned) }), /finished writer/);
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
