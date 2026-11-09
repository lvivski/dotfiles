import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseJson, readRecord } from "../../data.mjs";
import { createFactoryService } from "../../factory.mjs";

/** @param {string | Uint8Array} content */
export const digest = (content) => createHash("sha256").update(content).digest("hex");

/** Git writes are confined to newly created fixture repositories, never the checkout. */
export async function createLab(parent = os.tmpdir()) {
	const directory = await mkdtemp(path.join(parent, "foundry-proof-"));
	await mkdir(path.join(directory, "repository"));
	await mkdir(path.join(directory, "storage"));
	await writeFile(path.join(directory, "fixture.json"), JSON.stringify({ kind: "foundry-regeneration-proof" }));
	const lab = await openLab(directory, true);
	lab.git(["init", "--quiet", "--initial-branch=main", "--template=", "."]);
	return lab;
}

/** @param {string} directory @param {boolean} [initializing] */
export async function openLab(directory, initializing = false) {
	const root = await realpath(directory);
	assert.ok(path.basename(root).startsWith("foundry-proof-"));
	assert.equal(readRecord(parseJson(await readFile(path.join(root, "fixture.json"), "utf8"))).kind, "foundry-regeneration-proof");
	const repositoryPath = await realpath(path.join(root, "repository"));
	assert.equal(repositoryPath, path.join(root, "repository"));
	const storageRoot = await realpath(path.join(root, "storage"));
	/** @param {string[]} args */
	const git = (args) => execFileSync("git", [
		"-c", "user.name=Foundry proof",
		"-c", "user.email=foundry-proof@example.invalid",
		"-c", "commit.gpgsign=false",
		"-c", "core.hooksPath=/dev/null",
		...args,
	], {
		cwd: repositoryPath,
		env: {
			PATH: process.env.PATH,
			HOME: root,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			LC_ALL: "C",
		},
		encoding: "utf8",
	}).trim();
	if (!initializing) assert.equal(await realpath(git(["rev-parse", "--show-toplevel"])), repositoryPath);
	return {
		directory: root,
		repositoryPath,
		storageRoot,
		git,
		/** @param {Omit<Parameters<typeof createFactoryService>[0], "repositoryPath" | "storageRoot">} [options] */
		service: (options = {}) => createFactoryService({ repositoryPath, storageRoot, ...options }),
		/** @param {string} filename @param {string} content */
		async commitArtifact(filename, content) {
			assert.match(filename, /^[a-z][a-z0-9-]*\.mjs$/);
			assert.equal(await realpath(git(["rev-parse", "--show-toplevel"])), repositoryPath);
			await writeFile(path.join(repositoryPath, filename), content);
			git(["add", "--", filename]);
			git(["commit", "--quiet", "-m", `Proof artifact: ${filename}`]);
			return {
				commit: git(["rev-parse", "HEAD"]),
				artifact: { kind: "implementation", ref: path.join(repositoryPath, filename), digest: digest(content) },
			};
		},
	};
}
