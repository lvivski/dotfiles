import { fileURLToPath } from "node:url";
import { closedAttempt } from "./requirements.mjs";
import { digest, fail } from "./values.mjs";
import { revisionLookup } from "./revision.mjs";

/** @typedef {import("./model.js").NativeCall} Check */
const runner=fileURLToPath(new URL("./runner.mjs",import.meta.url));
/** @param {string} s */
const quote=s=>`'${s.replaceAll("'","'\\''")}'`;
const abi=/^command node '((?:[^']|'\\'')*\/work\/runner\.mjs)' '((?:[^']|'\\'')*)' '([A-Za-z0-9][A-Za-z0-9._-]*)' '([a-f0-9-]{36})'$/;
/** @param {string} cwd @param {string} run @param {string} id @param {string} description @param {string} [entry] */
export const runnerArgs=(cwd,run,id,description,entry=runner)=>({command:`command node ${[entry,cwd,run,id].map(quote).join(" ")}`,
	shellId:`foundry-${id}`,initial_wait:120,description});
/** @param {Record<string,unknown>} a */
export function runnerRun(a){
	const command=typeof a.command==="string"?a.command:"";
	if(!String(a.shellId).startsWith("foundry-") && !/^\s*(?:command\s+)?node\s+['"][^\n]*\/work\/runner\.mjs['"](?:\s|$)/.test(command))return;
	const m=abi.exec(command);
	if(!m || a.shellId!==`foundry-${m[4]}`)fail("unreserved_call","Malformed or unmatched Foundry runner call");
	return m[3];
}
/** One scan per census rather than one full scan for each historical slot. A
 * repeated identity points to neither contender. Only frozen revisions may reuse it. */
export const runnerIndex=revisionLookup(run=>{
	/** @type {Map<string,import("./model.js").Effect|null>} */ const shells=new Map(),calls=new Map();
	for(const e of run.effects){
		const shell=e.args.shellId;
		if(typeof shell==="string")shells.set(shell,shells.has(shell)?null:e);
		if(e.callId){const id=JSON.stringify([e.issuer,e.callId]);calls.set(id,calls.has(id)?null:e);}
	}
	return (/** @type {Check} */ e)=>typeof e.args.shellId==="string" && shells.get(e.args.shellId)===e &&
		(!e.callId || calls.get(JSON.stringify([e.issuer,e.callId]))===e);
});
/** Decode only the complete original ABI, never a path parsed from arbitrary shell input.
 * @param {import("./model.js").Run} r @param {Check} e @param {ReturnType<typeof runnerIndex>} [unique] */
export function runnerBinding(r,e,unique=runnerIndex(r)){
	const m=typeof e.args.command==="string" && abi.exec(e.args.command);
	if(!m || typeof e.args.description!=="string" || !m[1].startsWith("/") || !m[2].startsWith("/") || !unique(e))return;
	const entry=m[1].replaceAll("'\\''","'"),cwd=m[2].replaceAll("'\\''","'");
	if(digest(e.args)===digest(runnerArgs(cwd,r.id,e.id,e.args.description,entry)))return {cwd,entry};
}
/** @param {import("./model.js").Run} r @param {Check} e @param {string} cwd @param {boolean} [local] */
export function exactRunner(r,e,cwd,local=true){
	const b=runnerBinding(r,e);
	return !!b && b.cwd===cwd && (!local || b.entry===runner);
}
export const closureExit=78;
/** No historical or unknown check declares current execution authority. The current
 * grant implementation must supply a positive closed-format check here before enabling
 * a new shell reservation. Non-check calls retain their own normal admission checks.
 * @param {import("./model.js").Effect} e */
export const supportedNewCall=e=>e.tool!=="bash" || closedAttempt(e);
/** Exact native request identity, including the run and runner path in the original argv.
 * @param {import("./model.js").Effect} e */
export const callBinding=e=>digest([e.id,e.issuer,e.callId??null,e.tool,e.args]);
/** An original and its linked successor share this obligation. The signer separately binds
 * each attempt's identity, arguments and physical description. Delivery history is not an input.
 * @param {Check} e */
export function attemptSubject(e){
	const {id,issuer,args,callId,state,runnerStarted,runnerClaim,receipt,error,permissionHold,launcherExit,inlineRepair,retirement,attempt,verification,...subject}=e;
	return digest(subject);
}
/** A linked attempt occupies the original slot in the obligations' order.
 * The original remains in history. @param {Check[]} calls */
export function batchMembers(calls){
	const next=new Map(calls.flatMap(c=>c.attempt?.version===2 && c.attempt.previous?[[c.attempt.previous,c]]:[]));
	return next.size?calls.filter(c=>!(c.attempt?.version===2 && c.attempt.previous)).map(c=>next.get(c.id)??c):calls;
}
