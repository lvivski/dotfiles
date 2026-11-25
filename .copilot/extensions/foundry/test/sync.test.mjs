import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sync = readFileSync(fileURLToPath(new URL("../../../../sync", import.meta.url)));

for (const shell of ["bash", "zsh"]) {
	test(`sync replaces stale Foundry versions and preserves unrelated installations in ${shell}`, t => {
		const root = mkdtempSync(path.join(tmpdir(), "foundry-sync-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const repository = path.join(root, "repository");
		const home = path.join(root, "home");
		const bin = path.join(root, "bin");
		for (const directory of [repository, home, bin]) mkdirSync(directory);
		const database = path.join(repository, ".git/foundry/work.sqlite");
		mkdirSync(path.dirname(database), { recursive: true });
		writeFileSync(database, "repository-owned factory data\n");
		writeFileSync(path.join(repository, "sync"), sync);
		writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		for (const profile of [".bash_profile", ".zprofile"]) writeFileSync(path.join(home, profile), "");
		for (const relative of ["extensions/foundry", "extensions/recon", "skills/foundry", "skills/deep-research",
			"skills/review-queue", "skills/security-review"]) {
			mkdirSync(path.join(repository, ".copilot", relative), { recursive: true });
		}
		const installed = [".copilot/extensions/foundry/extension.mjs", ".copilot/extensions/recon/extension.mjs",
			...["SKILL.md", "references/brief.md", "references/runs.md", "references/assignments.md", "references/handoff.md",
				"references/metrics.md", "scripts/plans.mjs", "scripts/archive-check.mjs", "scripts/usage.mjs", "scripts/qualification.mjs"]
				.map(file => `.copilot/skills/foundry/${file}`)];
		for (const relative of installed) {
			const source = path.join(repository, relative);
			const target = path.join(home, relative);
			mkdirSync(path.dirname(source), { recursive: true });
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(source, "new-version\n");
			writeFileSync(target, "old-version\n");
			utimesSync(source, 1700000000, 1700000000);
			utimesSync(target, 1700000000, 1700000000);
		}
		const stale = [
			".copilot/extensions/foundry/verification/approval.mjs",
			".copilot/extensions/recon/obsolete-analysis.mjs",
			".copilot/skills/foundry/references/activation.md",
		];
		const preserved = ".copilot/extensions/unrelated/extension.mjs";
		const editorPackage = ".copilot/editor/node_modules/typescript/package.json";
		mkdirSync(path.dirname(path.join(repository, editorPackage)), { recursive: true });
		writeFileSync(path.join(repository, editorPackage), "{}");
		for (const relative of [...stale, preserved]) {
			const target = path.join(home, relative);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, "preserve unless obsolete\n");
		}
		/** @type {NodeJS.ProcessEnv} */
		const env = { ...process.env, HOME: home, ZDOTDIR: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
		delete env.ZSH_VERSION;
		execFileSync(shell, ["-c", 'item=caller-value; source ./sync --force; test "$item" = caller-value'],
			{ cwd: repository, env, stdio: "pipe" });
		for (const relative of installed) {
			assert.equal(readFileSync(path.join(home, relative), "utf8"), "new-version\n");
		}
		for (const relative of stale) assert.equal(existsSync(path.join(home, relative)), false);
		assert.equal(readFileSync(path.join(home, preserved), "utf8"), "preserve unless obsolete\n");
		assert.equal(readFileSync(database, "utf8"), "repository-owned factory data\n");
		assert.equal(existsSync(path.join(home, ".git/foundry/work.sqlite")), false);
		assert.equal(existsSync(path.join(home, editorPackage)), false);
	});
}

for (const mode of ["--force", "--pull"]) test(`sync ${mode} leaves worktree pointers and repo instructions untouched`, t => {
	const root = mkdtempSync(path.join(tmpdir(), "dotfiles-worktree-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = path.join(root, "checkout"), home = path.join(root, "home"), bin = path.join(root, "bin");
	for (const dir of [repo, home, bin]) mkdirSync(dir);
	writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // No network pull.
	writeFileSync(path.join(repo, "sync"), sync);
	writeFileSync(path.join(home, ".bash_profile"), "");
	for (const relative of ["extensions/foundry", "extensions/recon", "skills/foundry", "skills/deep-research", "skills/review-queue", "skills/security-review"])
		mkdirSync(path.join(repo, ".copilot", relative), { recursive: true });
	const paths = [".git", ".copilot/extensions/foundry/.git"];
	mkdirSync(path.join(home, ".copilot/extensions/foundry"), { recursive: true });
	for (const p of paths) {
		writeFileSync(path.join(repo, p), "gitdir: /repository/private\n");
		writeFileSync(path.join(home, p), "gitdir: /home/sentinel\n");
	}
	writeFileSync(path.join(repo, "example"), "from repository\n");
	writeFileSync(path.join(home, "example"), "from home\n");
	writeFileSync(path.join(repo, "AGENTS.md"), "Repo instructions\n");
	writeFileSync(path.join(home, "AGENTS.md"), "Personal instructions\n");
	execFileSync("bash", ["-c", 'unset ZSH_VERSION; source ./sync "$1"', "sync-test", mode],
		{ cwd: repo, env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
	const dest = mode === "--force" ? home : repo;
	assert.equal(readFileSync(path.join(dest, "example"), "utf8"), mode === "--force" ? "from repository\n" : "from home\n");
	assert.equal(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), "Repo instructions\n");
	assert.equal(readFileSync(path.join(home, "AGENTS.md"), "utf8"), "Personal instructions\n");
	for (const p of paths) {
		assert.equal(readFileSync(path.join(home, p), "utf8"), "gitdir: /home/sentinel\n");
		assert.equal(readFileSync(path.join(repo, p), "utf8"), "gitdir: /repository/private\n");
	}
});

test("skill resolves an exact committed plan name to its activation source without starting a run", t => {
	const root = mkdtempSync(path.join(tmpdir(), "foundry-plan-name-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = path.join(root, ".foundry");
	mkdirSync(dir);
	/** @param {...string} args */
	const git = (...args) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
		"-c", "user.name=Test", "-c", "user.email=test@invalid", ...args], { encoding: "utf8" }).trim();
	const helper = fileURLToPath(new URL("../../../skills/foundry/scripts/plans.mjs", import.meta.url));
	/** @param {...string} args */
	const resolve = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: "utf8" });
	const policy = { version: 2, id: "release-v2", direction: "Look up the current price", target: "refs/heads/main",
		productCheck: ".foundry/unit.mjs", goalCheck: ".foundry/goal.mjs", squads: [{ id: "prices", charter: ".foundry/ownership",
			areas: ["prices"], boundary: [".foundry/interface"], checks: [".foundry/unit.mjs"] }] };
	git("init", "-q", "-b", "author");
	for (const file of ["unit.mjs", "goal.mjs", "ownership", "interface"]) writeFileSync(path.join(dir, file), "");
	writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(policy));
	writeFileSync(path.join(dir, "catalog-old.json"), JSON.stringify({ ...policy, id: "previous" }));
	git("add", ".foundry"); git("commit", "-qm", "reviewed plans"); git("branch", "main");
	writeFileSync(path.join(dir, "draft.json"), JSON.stringify(policy));
	const expected = { source: ".foundry/catalog.json", run: "release-v2", target: "refs/heads/main" };
	assert.deepEqual(JSON.parse(resolve().stdout).sort(), ["catalog", "catalog-old"]);
	for (const arg of ["catalog", expected.source]) {
		const result = resolve(arg);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), expected);
	}
	for (const arg of ["cat", "draft", "release-v2", "../catalog", ".foundry/../catalog.json"]) {
		const result = resolve(arg);
		assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.ok(result.stderr);
	}
	writeFileSync(path.join(dir, "interface"), "unreviewed change");
	assert.match(resolve("catalog").stderr, /Uncommitted changes.*\n.*interface/);
	git("add", ".foundry/interface");
	assert.match(resolve("catalog").stderr, /Uncommitted changes/);
	git("commit", "-qm", "author only");
	assert.match(resolve("catalog").stderr, /conserved contract changed.*interface/);
	assert.equal(git("for-each-ref", "refs/foundry/"), "");
	assert.equal(existsSync(path.join(root, ".git/foundry")), false);
});
