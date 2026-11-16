import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
		const extension = ".copilot/extensions/foundry/extension.mjs";
		const skill = ".copilot/skills/foundry/SKILL.md";
		const recon = ".copilot/extensions/recon/extension.mjs";
		for (const relative of [extension, recon, skill]) {
			const source = path.join(repository, relative);
			const target = path.join(home, relative);
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
		for (const relative of [extension, recon, skill]) {
			assert.equal(readFileSync(path.join(home, relative), "utf8"), "new-version\n");
		}
		for (const relative of stale) assert.equal(existsSync(path.join(home, relative)), false);
		assert.equal(readFileSync(path.join(home, preserved), "utf8"), "preserve unless obsolete\n");
		assert.equal(readFileSync(database, "utf8"), "repository-owned factory data\n");
		assert.equal(existsSync(path.join(home, ".git/foundry/work.sqlite")), false);
	});
}
