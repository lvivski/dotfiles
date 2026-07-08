/** @module worktree.test — detached git worktrees: create/remove, dirty preservation, clone, safety. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { join, sep, dirname } from "node:path";

import { WorktreeManager, ensureClone, repoName, repoKey, clonePath, findRepoRoot, _sanitize, _spawnGit } from "./worktree.mjs";
import { Runtime } from "./runtime.mjs";
import { tmpDir, withFakeEnv } from "./fixtures/support.mjs";

/** Create a temp git repo with one commit. @returns {string} */
function makeRepo() {
	const dir = tmpDir();
	const run = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	run(["init", "-q", "-b", "main"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	writeFileSync(join(dir, "README.md"), "hi");
	run(["add", "-A"]);
	run(["commit", "-q", "-m", "init"]);
	return dir;
}

test("_spawnGit resolves { code:0, stdout } on success", async () => {
	const r = await _spawnGit(["rev-parse", "HEAD"], makeRepo());
	assert.equal(r.code, 0);
	assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
});

test("_spawnGit never rejects: a non-zero exit is returned as a code", async () => {
	const r = await _spawnGit(["cat-file", "-e", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], makeRepo());
	assert.notEqual(r.code, 0);
});

test("_spawnGit reports a spawn failure (bad cwd) as code 127", async () => {
	const r = await _spawnGit(["status"], join(tmpDir(), "nope"));
	assert.equal(r.code, 127);
});

test("repoName / repoKey normalize local, GitHub, and ADO forms", () => {
	assert.equal(repoName("https://github.com/o/repo.git"), "repo");
	assert.equal(repoName("https://dev.azure.com/org/proj/_git/My.Repo"), "My.Repo");
	assert.equal(repoKey("git@github.com:o/r.git"), "github.com/o/r");
	assert.equal(repoKey("https://dev.azure.com/org/proj/_git/r"), "ado:org/proj/r");
	assert.equal(_sanitize(".."), "wt");
	assert.match(clonePath("https://github.com/o/r.git", tmpDir()), /[/\\]r$/);
});

test("create makes a detached worktree; clean removal deletes it", async () => {
	const repo = makeRepo();
	const mgr = new WorktreeManager(repo, join(tmpDir(), "wts"));
	const path = await mgr.create("exp");
	assert.ok(existsSync(join(path, ".git")), "worktree has a .git file");
	assert.ok(existsSync(join(path, "README.md")), "checked out at HEAD");
	await mgr.remove(path);
	assert.ok(!existsSync(path), "clean worktree removed");
});

test("dirty worktrees are preserved, not deleted", async () => {
	const repo = makeRepo();
	const mgr = new WorktreeManager(repo, join(tmpDir(), "wts"));
	const path = await mgr.create("dirty");
	writeFileSync(join(path, "scratch.txt"), "uncommitted work");
	await mgr.remove(path);
	assert.ok(existsSync(path), "dirty worktree preserved");
	assert.deepEqual(mgr.preservedDirty, [path]);
});

test("duplicate active name and unsafe names are handled", async () => {
	const repo = makeRepo();
	const mgr = new WorktreeManager(repo, join(tmpDir(), "wts"));
	await mgr.create("dup");
	await assert.rejects(mgr.create("dup"), /already active/);
	const escaped = await mgr.create("../../evil");
	assert.ok(existsSync(escaped), "sanitized name created");
	assert.ok(!escaped.includes(".." + sep), "path cannot escape the base");
});

test("cleanupAll removes clean worktrees and returns preserved dirty ones", async () => {
	const repo = makeRepo();
	const base = join(tmpDir(), "wts");
	const mgr = new WorktreeManager(repo, base);
	const clean = await mgr.create("clean");
	const dirty = await mgr.create("dirty");
	writeFileSync(join(dirty, "x.txt"), "work");
	const preserved = await mgr.cleanupAll();
	assert.ok(!existsSync(clean));
	assert.deepEqual(preserved, [dirty]);
});

test("worktree create() rejects a name whose realpath escapes the base via a symlink", async () => {
	const base = tmpDir();
	const outside = tmpDir();
	symlinkSync(outside, join(base, "escape")); // base/escape is a symlink pointing outside the base
	const mgr = new WorktreeManager("/tmp", base);
	await assert.rejects(mgr.create("escape"), /resolves outside the worktree base/);
});

test("ensureClone does not reuse a dest whose .git is a file, not a directory", async () => {
	const dest = tmpDir();
	writeFileSync(join(dest, ".git"), "gitdir: /elsewhere"); // a .git FILE — not a real clone
	// Must NOT treat it as reusable (old bug returned dest); with a bogus repo it attempts a clone and fails.
	await assert.rejects(ensureClone("/no/such/repo/path", dest), /./);
});

test("ensureClone clones a local repo and validates origin on reuse", async () => {
	const repo = makeRepo();
	const dest = join(tmpDir(), "clone");
	await ensureClone(repo, dest);
	assert.ok(existsSync(join(dest, ".git")));
	await ensureClone(repo, dest); // reuse, same origin -> ok
	const other = makeRepo();
	await assert.rejects(ensureClone(other, dest), /has origin/);
	assert.equal(await findRepoRoot(repo), execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo }).toString().trim());
});

test("runtime worktree(): callback form runs in an isolated checkout and auto-cleans", async () => {
	const repo = makeRepo();
	const rt = new Runtime({ cwd: repo });
	const api = /** @type {any} */ (rt.buildApi(null));
	let captured = "";
	const out = await api.worktree("cb", async (/** @type {string} */ dir) => {
		captured = dir;
		assert.ok(existsSync(join(dir, "README.md")));
		return "RESULT";
	});
	assert.equal(out, "RESULT");
	assert.ok(!existsSync(captured), "clean worktree auto-removed after callback");
	await rt.cleanup();
});

test("runtime worktree.create(): explicit lifecycle form", async () => {
	const repo = makeRepo();
	const rt = new Runtime({ cwd: repo });
	const api = /** @type {any} */ (rt.buildApi(null));
	const wt = await api.worktree.create("life");
	assert.ok(existsSync(join(wt.path, ".git")));
	await wt.cleanup();
	assert.ok(!existsSync(wt.path));
	await rt.cleanup();
});

test("restricted mode forbids worktree()", () => {
	const rt = new Runtime({ restricted: true, cwd: tmpDir() });
	const api = /** @type {any} */ (rt.buildApi(null));
	assert.throws(() => api.worktree("x"), /forbidden in restricted mode/);
});

test("agent isolation:'worktree' runs the subagent inside a fresh worktree", () =>
	withFakeEnv({}, async () => {
		const repo = makeRepo();
		const rt = new Runtime({ cwd: repo, budget: 10 });
		const r = await rt.agent("hi", { isolation: "worktree", label: "iso" });
		assert.equal(r.ok, true);
		assert.equal(r.content, "ECHO: hi");
		const preserved = await rt.cleanup();
		assert.deepEqual(preserved, []); // nothing dirty -> nothing preserved
	}));

test("runtime worktrees live in a temp dir outside the repo; a clean run leaves no trace", () =>
	withFakeEnv({}, async () => {
		const repo = makeRepo();
		const rt = new Runtime({ cwd: repo });
		const api = /** @type {any} */ (rt.buildApi(null));
		const wt = await api.worktree.create("iso");
		assert.ok(existsSync(join(wt.path, ".git")), "a real worktree was created");
		assert.ok(!existsSync(join(repo, ".worktrees")), "no .worktrees/ dir pollutes the repo");
		assert.ok(!realpathSync(wt.path).startsWith(realpathSync(repo) + sep), `worktree lives outside the repo: ${wt.path}`);
		const base = dirname(wt.path); // the per-run temp base ($TMPDIR/cwf-wt-*)
		await wt.cleanup();
		const preserved = await rt.cleanup();
		assert.deepEqual(preserved, []);
		assert.ok(!existsSync(wt.path), "clean worktree removed");
		assert.ok(!existsSync(base), "temp base removed on a clean run (zero footprint)");
	}));
