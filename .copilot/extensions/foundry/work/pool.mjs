import { realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { linkedGeneration } from "./binding.mjs";
import { checkReceipt, generationOf } from "./evidence.mjs";
import { canDispatch } from "./native.mjs";
import { owns } from "./lineage.mjs";
import { record, sameScope, text } from "./values.mjs";
import { workspaceName } from "./workspace.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {import("./model.js").Node} Node */
/** @param {Run} run @param {Node} n */
const squadOf = (run,n) => run.policy.squads.find(s => "areas" in s ? owns(s,n.grain.directory) : s.grains.includes(n.grain.id));

/** Preserve eligibility before a later review retires or replaces the grain.
 * @param {Run} run */
export function finishWriters(run) {
	const p = run.products.at(-1);
	if (!p) return;
	const bindings = new Map(), checks = new Map();
	for (const e of run.effects) {
		if (e.kind==="writer" && e.nativeId) bindings.set(e.grain,e);
		if (e.kind==="component") checks.set(e.id,e);
	}
	for (const n of Object.values(run.nodes)) {
		if (n.state!=="qualified" || !n.worker || !n.candidate || p.outputs[n.grain.id]!==n.candidate) continue;
		const w = bindings.get(n.grain.id);
		if (!w || w.finished || w.nativeId!==n.worker || generationOf(w)!==n.generation) continue;
		const c = checks.get(n.check), squad = squadOf(run,n);
		if (squad && c?.kind==="component" && c.issuer===n.worker && c.commit===n.candidate && checkReceipt(c)?.exit===0)
			w.finished = {squad:squad.id,directory:n.grain.directory,component:c.id,product:p.check};
	}
}

/** Only the latest use of each session can lend it. A native idle signal alone cannot release a repair.
 * @param {Run} run @param {Call} job */
export function pool(run, job) {
	const n = job.grain && run.nodes[job.grain];
	if (!n || n.token!==job.token || n.worker || job.reuse || job.observer || job.tool!=="create_session" || job.state!=="ready" || job.callId) return [];
	const squad = squadOf(run,n), busy = new Set([run.owner]), lastComponent = new Map();
	for (const node of Object.values(run.nodes)) if (node.worker && node.state!=="qualified") busy.add(node.worker);
	for (const e of run.effects) {
		if (e.kind==="component") lastComponent.set(e.issuer,e.id);
		if (e.kind==="writer" && e.pooled && run.nodes[e.grain ?? ""]?.workspace===e.id && e.state!=="done")
			busy.add(text(e.tool==="session.send" ? e.issuer : e.args.session_id,"pooled recipient"));
		if (["done","observed","refused","retired","withdrawn","blocked","deferred"].includes(e.state)) continue;
		if (e.kind!=="writer" || e.state!=="ready") busy.add(e.issuer);
		if (typeof e.args.session_id==="string") busy.add(e.args.session_id);
		if (e.kind==="writer" && e.pooled && e.tool==="session.send") busy.add(e.issuer);
	}
	/** @type {Call[]} */ const candidates = [];
	for (let i=run.effects.length-1;i>=0;i--) {
		const w = run.effects[i];
		if (w.kind!=="writer" || !w.nativeId || busy.has(w.nativeId)) continue;
		busy.add(w.nativeId);
		if (w.finished && w.finished.squad===squad?.id && lastComponent.get(w.nativeId)===w.finished.component && w.state==="done") candidates.push(w);
	}
	return candidates.sort((a,b)=>Number(sameScope(b.finished?.directory,n.grain.directory))-Number(sameScope(a.finished?.directory,n.grain.directory)));
}

/** @param {unknown} raw @param {string} worker */
export function idleHome(raw,worker) {
	const v = record(raw);
	if (v.resultType!=="success") return;
	const payload = v.structuredContent ?? (typeof v.textResultForLlm==="string" && v.textResultForLlm.trimStart().startsWith("{") ? JSON.parse(v.textResultForLlm) : undefined);
	if (!payload || typeof payload!=="object") return;
	const s = record(payload);
	if (s.id===worker && (!s.active_session_id || s.active_session_id===worker) && s.session_type==="worktree" && s.activity && record(s.activity).status==="idle" &&
		!record(s.activity).waiting_on && !s.archived && !s.archived_at && !s.was_interrupted && !s.awaiting_user_input && !s.awaiting_input &&
		!s.pending_plan && !s.repository_trust && !s.last_error && s.mode!=="plan" && typeof s.path==="string" && path.isAbsolute(s.path)) return s.path;
}

/** @param {Run} run @param {Call} job @param {Call} w @param {string} home */
function lend(run,job,w,home) {
	const n = run.nodes[text(job.grain,"grain")], prompt = text(record(job.args.kickoff).prompt,"fresh kickoff");
	const workspace = workspaceName(job.id);
	job.pooled = {from:w.id,home,generation:text(job.args.base_branch,"generation")};
	job.tool = job.issuer===w.nativeId ? "session.send" : "send_session_message";
	const message = prompt.replace("\n",`\nNew assignment in the same squad. Earlier messages are context only; do not use former tokens, grants, paths or verdicts. Before editing, call foundry_workspace with this run and token; reload extensions in this session first if stale. Work only in ${workspace}/, including for helpers. Paths below are relative to that checkout; leave the original workspace untouched.\n`);
	job.args = job.tool==="session.send" ? {message} : {session_id:text(w.nativeId,"finished writer"),delivery_mode:"immediate",message};
	n.workspace = job.id;
}

/** Match exact directories across the whole ready batch before lending to other squad work.
 * Native reads are optional and outside the ledger transaction; never wait for a busy writer to finish.
 * @param {string} cwd @param {Run} run @param {Call[]} jobs @param {(id:string)=>Promise<string|undefined>} lookup
 * @param {((message:string)=>void)|undefined} log */
export async function chooseWriters(cwd,run,jobs,lookup,log) {
	/** @type {Map<string,string|undefined>} */ const homes = new Map();
	/** @type {Map<string,{from:string,home:string}>} */ const selected = new Map();
	const used = new Set(), candidates = jobs.map(job=>{
		const n = run.nodes[text(job.grain,"grain")], options = pool(run,job);
		const familiar = new Set(options.length ? run.effects.flatMap(e=>e.kind==="writer" && e.finished && sameScope(e.finished.directory,n.grain.directory) &&
			e.finished.squad===squadOf(run,n)?.id && e.nativeId ? [e.nativeId] : []) : []);
		return {job,options,familiar};
	});
	const deadline = Date.now() + 5000;
	for (const exact of [true,false]) for (const {job,options,familiar} of candidates) {
		if (selected.has(job.id)) continue;
		for (const w of options) {
			const worker = text(w.nativeId,"finished writer");
			if (used.has(worker) || exact && !familiar.has(worker)) continue;
			if (!homes.has(worker)) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) continue;
				const timer = new AbortController();
				let home;
				try {
					const read = await Promise.race([lookup(worker), delay(remaining, undefined, {signal:timer.signal})]);
					if (read) {
						const canonical = realpathSync(read), launch = run.effects.find(e=>e.tool==="create_session" && e.nativeId===worker);
						linkedGeneration(canonical,text(launch?.args.base_branch,"original generation"),cwd);
						home = canonical;
					}
				} catch (error) { log?.(`Cannot verify finished writer ${worker}; keeping fresh launch eligible: ${String(error)}`); }
				finally { timer.abort(); }
				homes.set(worker,home);
			}
			const home = homes.get(worker);
			if (home) { selected.set(job.id,{from:w.id,home}); used.add(worker); break; }
		}
	}
	if (selected.size) return (/** @type {Run} */ live) => {
		for (const [id,{from,home}] of selected) {
			const job = live.effects.find(e=>e.id===id);
			if (job?.kind!=="writer" || job.permissionHold || !canDispatch(live,job)) continue;
			const w = pool(live,job).find(w=>w.id===from);
			if (w && job.issuer===jobs.find(j=>j.id===id)?.issuer) lend(live,job,w,home);
		}
	};
}
