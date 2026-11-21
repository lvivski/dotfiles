import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { assignment } from "../work/native.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { record, text } from "../work/values.mjs";

/** @typedef {Parameters<typeof createRuntime>[1]} Host */
/** @typedef {ReturnType<typeof createRuntime>} Runtime */
/** @typedef {{id:string,squad:string,base:string,prompt:string,packet:import("../work/model.js").Packet,issuer:string,dispatch:string,workflowId:string,report:(raw:unknown)=>Promise<void>}} Scout */
/** @param {string} cwd @param {...string} args */
export const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=test@invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** @param {string} dir @param {string} p @param {string} bytes */
export function put(dir, p, bytes) { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), bytes); }
/** Scripted discovery inspects the pinned tree, never the issuer's checkout or the current target.
 * @param {string} root @param {string} base */
export function pinnedFiles(root, base) {
	assert.match(base, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "scripted scouts require an immutable Git revision");
	return new Set(git(root, "--no-replace-objects", "ls-tree", "-r", "-z", "--name-only", base).split("\0").filter(Boolean));
}

/** Load the real extension, substituting only the joined SDK session. @param {object} session */
export async function loadEntry(session) {
	/** @type {import("@github/copilot-sdk/extension").JoinSessionConfig} */ let declaration = {};
	const sdk = "data:text/javascript,export let joinSession; export class CanvasError extends Error { constructor(code,message){super(message);this.code=code} } export const createCanvas = options => options; export const defineWorkflow = definition => definition; export function use(fn) { joinSession = fn; }";
	(await import(sdk)).use((/** @type {typeof declaration} */ config) => { declaration = config; return { capabilities: { ui: { elicitation: true } }, ...session }; });
	const loader = registerHooks({ resolve: (specifier, context, next) => specifier === "@github/copilot-sdk/extension"
		? { url: sdk, shortCircuit: true } : next(specifier, context) });
	try { await import(`../extension.mjs?${randomUUID()}`); } finally { loader.deregister(); }
	return declaration;
}

/** Stand-in for workflow transport only. A batch has a real issuer and ledger binding but no
 * participant session. Keep its terminal envelope pending until all its callbacks have returned. */
export function workflowHost() {
	const body = new AsyncLocalStorage();
	/** @type {Scout[]} */ const scouts = [];
	/** @type {Set<Promise<void>>} */ const registrations = new Set();
	async function settle() {
		await nextTurn();
		while (registrations.size) await Promise.all([...registrations]);
	}
	/** @param {Runtime} runtime @param {string} run @param {string} dispatch @param {string} issuer */
	async function launch(runtime, run, dispatch, issuer) {
		if (body.getStore()) throw Error("workflow.run is not allowed while a workflow body is running on this call path");
		const workflowId = randomUUID();
		let finish = () => {};
		const completed = new Promise(resolve => { finish = () => resolve(undefined); });
		const registration = body.run(workflowId, () => runtime.scoutBatch(run, dispatch, issuer, workflowId)).then(jobs => {
			const waiting = new Set(jobs.map(job => job.id));
			for (const job of jobs) scouts.push({ ...job, issuer, dispatch, workflowId, async report(raw) {
				await body.run(workflowId, () => runtime.scoutResult(run, dispatch, issuer, workflowId, job.id, raw, job.packet));
				waiting.delete(job.id);
				if (!waiting.size) finish();
				await settle();
			} });
			if (!waiting.size) finish();
		});
		registrations.add(registration);
		try { await registration; } finally { registrations.delete(registration); }
		await completed;
		return { runId: workflowId, status: "completed" };
	}
	return { scouts, launch, settle };
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
		assert.match(prompt, /\bfoundry_submit\b/, "only writers get native sessions");
		const id = `${prefix}-${workers.size + 1}`, cwd = path.join(path.dirname(root), id);
		git(root, "worktree", "add", "-q", "--detach", cwd, text(args.base_branch, "generation"));
		workers.set(id, { id, token: marker.token, cwd, prompt });
		inbox.push({ worker: id, token: marker.token });
		return { resultType: "success", structuredContent: { project_session_id: id, path: cwd } };
	};
	return { workers, inbox, checks, execute };
}

/** workers/inbox are writer sessions and their token deliveries only. scouts is an append-only
 * delivery log in batch/job order. start([ownerRuntime]) and settle() wait for registration, not
 * reports. Call scout.report(rawObject) to deliver to the issuing runtime; a reloaded issuer can
 * return its journaled packet receipt together with its report through scoutResult.
 * @param {import("node:test").TestContext} t @param {string} run @param {string} source @param {Record<string,string>} files */
export function factory(t, run, source, files) {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-graph-")), root = path.join(dir, "repo");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	for (const [name, bytes] of Object.entries(files)) put(root, name, bytes);
	git(root, "add", ".");
	git(root, "commit", "-qm", "fixture");
	const tip = git(root, "rev-parse", "HEAD"), { workers, inbox, checks, execute } = nativeHost(root), discovery = workflowHost();
	/** @param {string} cwd @param {Partial<Host>} [options] */
	function runtime(cwd, options) {
		/** @type {Runtime} */
		const r = createRuntime(cwd, { mode: async () => "interactive", permissionBlocker: async () => null, confirm: async () => true, execute,
			scout: (id, dispatch, actor) => discovery.launch(r, id, dispatch, actor),
			notify: async message => {
				const job = assignment(message);
				if (!job) return "owner-notice";
				const w = [...workers.values()].find(w => w.cwd === cwd); assert.ok(w); assert.equal(job.run, run);
				inbox.push({ worker: w.id, token: job.token }); return `message-${job.token}`;
			}, ...options });
		t.after(() => r.close()); return r;
	}
	const owner = runtime(root);
	/** @param {string} [actor] */
	const status = (actor = "owner") => owner.operation("status", { run }, actor);
	async function start(issuer = owner) {
		await issuer.operation("start", { source }, "owner");
		await discovery.settle();
		return status();
	}
	return { root, tip, owner, scouts: discovery.scouts, settle: discovery.settle, workers, inbox, checks, execute, runtime, status, start };
}
