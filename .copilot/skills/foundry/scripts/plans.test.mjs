import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("skill resolves an exact committed plan name to its activation source without starting a run", t => {
	const root = mkdtempSync(path.join(tmpdir(), "foundry-plan-name-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = path.join(root, ".foundry");
	mkdirSync(dir);
	/** @param {...string} args */
	const git = (...args) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
		"-c", "user.name=Test", "-c", "user.email=test@invalid", ...args], { encoding: "utf8" }).trim();
	const helper = fileURLToPath(new URL("./plans.mjs", import.meta.url));
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
