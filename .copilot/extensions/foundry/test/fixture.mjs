import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { assignment } from "../work/native.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { record, text } from "../work/values.mjs";

/** @typedef {Parameters<typeof createRuntime>[1]} Host */
/** @param {string} cwd @param {...string} args */
export const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=test@invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** @param {string} dir @param {string} p @param {string} bytes */
export function put(dir, p, bytes) { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), bytes); }

/** Load the real extension, substituting only the joined SDK session. @param {object} session */
export async function loadEntry(session) {
	/** @type {import("@github/copilot-sdk/extension").JoinSessionConfig} */ let declaration = {};
	const sdk = "data:text/javascript,export let joinSession; export function use(fn) { joinSession = fn; }";
	(await import(sdk)).use((/** @type {typeof declaration} */ config) => { declaration = config; return session; });
	const loader = registerHooks({ resolve: (specifier, context, next) => specifier === "@github/copilot-sdk/extension"
		? { url: sdk, shortCircuit: true } : next(specifier, context) });
	try { await import(`../extension.mjs?${randomUUID()}`); } finally { loader.deregister(); }
	return declaration;
}

/** @param {string} root @param {string} [prefix] */
export function nativeHost(root, prefix = "worker") {
	/** @type {Map<string,{id:string,token:string,cwd:string,prompt:string}>} */ const workers = new Map();
	/** @type {{worker:string,token:string}[]} */ const inbox = [];
	/** @type {string[]} */ const checks = [];
	/** @type {Host["execute"]} */
	const execute = async (tool, args) => {
		if (tool === "bash") {
			checks.push(String(args.description));
			const result = spawnSync("/bin/sh", ["-c", text(args.command, "runner")], { cwd: root, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			return { resultType: "success", textResultForLlm: result.stdout };
		}
		if (tool === "send_session_message") {
			const marker = assignment(text(args.message, "message"));
			if (marker) inbox.push({ worker: text(args.session_id, "recipient"), token: marker.token });
			return { resultType: "success", structuredContent: { status: "accepted" } };
		}
		assert.equal(tool, "create_session");
		const prompt = text(record(args.kickoff).prompt, "kickoff"), marker = assignment(prompt);
		assert.ok(marker);
		const id = `${prefix}-${workers.size + 1}`, cwd = path.join(path.dirname(root), id);
		git(root, "worktree", "add", "-q", "--detach", cwd, text(args.base_branch, "generation"));
		workers.set(id, { id, token: marker.token, cwd, prompt });
		inbox.push({ worker: id, token: marker.token });
		return { resultType: "success", structuredContent: { project_session_id: id, path: cwd } };
	};
	return { workers, inbox, checks, execute };
}

/** @param {import("node:test").TestContext} t @param {string} run @param {string} source @param {Record<string,string>} files */
export function factory(t, run, source, files) {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-graph-")), root = path.join(dir, "repo");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	for (const [name, bytes] of Object.entries(files)) put(root, name, bytes);
	git(root, "add", ".");
	git(root, "commit", "-qm", "fixture");
	const tip = git(root, "rev-parse", "HEAD"), { workers, inbox, checks, execute } = nativeHost(root);
	/** @param {string} cwd @param {Partial<Host>} [options] */
	function runtime(cwd, options) {
		const r = createRuntime(cwd, { mode: async () => "interactive", permissionBlocker: async () => null, confirm: async () => true, select: async () => null, execute,
			remind: async (id, token) => {
				const w = [...workers.values()].find(w => w.cwd === cwd); assert.ok(w); assert.equal(id, run);
				inbox.push({ worker: w.id, token }); return `message-${token}`;
			}, ...options });
		t.after(() => r.close()); return r;
	}
	const owner = runtime(root);
	/** @param {string} [actor] */
	const status = (actor = "owner") => owner.operation("status", { run }, actor);
	return { root, tip, owner, workers, inbox, checks, execute, runtime, status, start: () => owner.operation("start", { source }, "owner") };
}
