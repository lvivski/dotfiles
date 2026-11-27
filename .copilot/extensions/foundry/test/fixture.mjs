import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { assignment } from "../work/native.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { ledgerPath, openDatabase } from "../work/database.mjs";
import { record, text } from "../work/values.mjs";

/** @typedef {Parameters<typeof createRuntime>[1]} Host */
/** @typedef {ReturnType<typeof createRuntime>} Runtime */
/** @param {string} root @param {()=>Promise<unknown>} during */
export async function withLedgerLock(root,during){
	const lock=new DatabaseSync(ledgerPath(root));
	try{lock.exec("BEGIN IMMEDIATE");await during();}finally{lock.close();}
}
export function recoveryClock(){
	/** @type {Set<()=>void>} */ const ticks=new Set();
	const tick=()=>{for(const cb of [...ticks])cb();};
	return {tick,watch:(/** @type {()=>void} */ cb)=>{ticks.add(cb);return ()=>{ticks.delete(cb);};},
		async pulse(/** @type {Runtime} */ issuer,n=1){for(let i=0;i<n;i++){tick();await nextTurn();await issuer.flush();}}};
}
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

/** Capture the contributions passed to joinSession without attaching to a live session. @param {object} session */
export async function loadEntry(session) {
	/** @type {import("@github/copilot-sdk/extension").JoinSessionOptions} */ let declaration = {};
	const sdk = "data:text/javascript," + encodeURIComponent(`
		export let joinSession;
		export function use(fn) { joinSession = fn; }
		export class CanvasError extends Error { constructor(code,message) { super(message); this.code=code; } }
		export const createCanvas = ({open,onClose,actions,...metadata}) => ({
			declaration:{...metadata,actions:actions?.map(({handler,...action})=>action)},open,onClose
		});
		export const defineWorkflow = definition => definition;
	`);
	(await import(sdk)).use((/** @type {typeof declaration} */ config) => { declaration = config; return { capabilities: { ui: { elicitation: true } }, ...session }; });
	const loader = registerHooks({ resolve: (specifier, context, next) => specifier === "@github/copilot-sdk/extension"
		? { url: sdk, shortCircuit: true } : next(specifier, context) });
	try { await import(`../extension.mjs?${randomUUID()}`); } finally { loader.deregister(); }
	const tools=declaration.tools?.definitions, canvases=declaration.canvases?.definitions, agents=declaration.agents?.definitions;
	const hooks=declaration.hooks?.handlers, workflows=declaration.workflows;
	assert.ok(tools && canvases && agents && hooks && workflows,"Foundry must register its definitions and hook handlers through the SDK option groups");
	return {tools,canvases,agents,hooks,workflows};
}

/** Stand-in for workflow transport only. A batch has a real issuer and ledger binding but no
 * participant session. Keep its terminal envelope pending until all its callbacks have returned. */
export function workflowHost(delivered=()=>{}) {
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
			if (!waiting.size) finish();else delivered();
		});
		registrations.add(registration);
		try { await registration; } finally { registrations.delete(registration); }
		await completed;
		return { runId: workflowId, status: "completed" };
	}
	return { scouts, launch, settle };
}

/** A deterministic stand-in for the SDK reviewer, not a production approval fallback.
 * The SDK start returns admission only; its separate result identifies the exact component checked.
 * @param {string} root */
export function scriptedInspections(root) {
	/** @type {Map<string,{inspection:string,component:string,candidate:string,outcome:string,summary:string}>} */ const results=new Map();
	return {
		/** @param {string} run @param {string} inspection @param {string} dispatch @param {string} issuer */
		async startInspection(run,inspection,dispatch,issuer) {
			const db=openDatabase(root);
			try {
				const i=db.read(run)?.inspections?.find(i=>i.id===inspection);
				assert.ok(i?.state==="issued" && i.dispatch===dispatch && i.issuer===issuer,"expected a committed review reservation");
				const runId=randomUUID();
				results.set(runId,{inspection,component:i.component,candidate:i.candidate,outcome:"approved",summary:"Scripted independent reviewer approved the fixture output."});
				return {runId,status:"running",workflowName:"foundry-inspect"};
			} finally {db.close();}
		},
		/** @param {string} runId */
		async inspectionState(runId) {
			const result=results.get(runId);assert.ok(result,"unexpected inspection workflow lookup");
			return {runId,status:"completed",workflowName:"foundry-inspect",result};
		},
	};
}

/** Existing fixture submissions represent the end of one delivered writer turn. Settle the
 * immediate scripted review and its resulting work, but never wait here for a real or deferred reviewer.
 * @param {Runtime} r */
export function settleSubmitted(r){
	if(typeof r.inspectionPacket!=="function")return r; // Historical readers have no asynchronous candidate review.
	const operation=r.operation;
	const writerTurn=new AsyncLocalStorage();
	/** @type {Runtime["operation"]} */
	r.operation=(op,args,actor)=>{
		if(op!=="submit" || writerTurn.getStore())return operation(op,args,actor);
		return writerTurn.run(true,async()=>{
			const result=await operation(op,args,actor);
			await nextTurn();await r.flush();
			return r.inspect({run:result.run},actor);
		});
	};
	return r;
}

/** @param {string} root @param {string} [prefix] @param {()=>void} [delivered] */
export function nativeHost(root, prefix = "worker", delivered=()=>{}) {
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
			if (marker) {inbox.push({ worker: text(args.session_id, "recipient"), token: marker.token });delivered();}
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
		delivered();
		return { resultType: "success", structuredContent: { project_session_id: id, path: cwd } };
	};
	return { workers, inbox, checks, execute };
}

/** workers/inbox are writer sessions and their token deliveries only. scouts is an append-only
 * delivery log in batch/job order. start([ownerRuntime]) and settle() wait for registration, not
 * reports. Call scout.report(rawObject) to deliver to the issuing runtime; a reloaded issuer can
 * return its journaled packet receipt together with its report through scoutResult.
 * @param {import("node:test").TestContext} t @param {string} run @param {string} source @param {Record<string,string>} files
 * @param {typeof createRuntime} [edition] */
export function factory(t, run, source, files, edition=createRuntime) {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-graph-")), root = path.join(dir, "repo");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	for (const [name, bytes] of Object.entries(files)) put(root, name, bytes);
	git(root, "add", ".");
	git(root, "commit", "-qm", "fixture");
	const available=new EventEmitter(),delivered=()=>{available.emit("delivery");};
	const tip = git(root, "rev-parse", "HEAD"), { workers, inbox, checks, execute } = nativeHost(root,"worker",delivered), discovery = workflowHost(delivered), inspections=scriptedInspections(root);
	/** @param {string} cwd @param {Partial<Host>} [options] @param {typeof createRuntime} [open] */
	function runtime(cwd, options, open = edition) {
		/** @type {Runtime} */
		const r = open(cwd, { mode: async () => "interactive", permissionBlocker: async () => null, execute, ...inspections,
			scout: (id, dispatch, actor) => discovery.launch(r, id, dispatch, actor),
			notify: async message => {
				const job = assignment(message);
				if (!job) return "owner-notice";
				const w = [...workers.values()].find(w => w.cwd === cwd); assert.ok(w); assert.equal(job.run, run);
				inbox.push({ worker: w.id, token: job.token });delivered();return `message-${job.token}`;
			}, ...options });
		t.after(() => r.close());
		return options && ("startInspection" in options || "inspectionState" in options) ? r : settleSubmitted(r);
	}
	const owner = runtime(root);
	// Fixture assertions and reviewer transport observe without issuing or converting.
	// Tests of what a particular edition can see call that issuer's inspect directly.
	const observer=edition===createRuntime?owner:runtime(root,{},createRuntime);
	/** @param {string} [actor] */
	const status = (actor = "owner") => observer.operation("status", { run }, actor);
	async function start(issuer = owner) {
		await issuer.operation("start", { source }, "owner");
		await discovery.settle();
		return status();
	}
	return { root, tip, owner, scouts: discovery.scouts, settle: discovery.settle, workers, inbox, checks, execute, runtime, status, start,
		onDelivery(/** @type {()=>void} */ fn){available.on("delivery",fn);return ()=>available.off("delivery",fn);}
	};
}
