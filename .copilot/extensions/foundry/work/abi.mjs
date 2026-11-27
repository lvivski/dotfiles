import { fileURLToPath } from "node:url";
import { digest, fail } from "./values.mjs";

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
/** @param {import("./model.js").Run} r @param {Check} e @param {string} cwd @param {boolean} [local] */
export function exactRunner(r,e,cwd,local=true){
	const m=typeof e.args.command==="string" && abi.exec(e.args.command);
	if(!m || typeof e.args.description!=="string" || !m[1].startsWith("/") ||
		r.effects.some(x=>x!==e && (x.args.shellId===e.args.shellId || e.callId && x.callId===e.callId && x.issuer===e.issuer)))return false;
	const entry=m[1].replaceAll("'\\''","'");
	return (!local || entry===runner) && digest(e.args)===digest(runnerArgs(cwd,r.id,e.id,e.args.description,entry));
}
export const closureExit=78;
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
/** @param {Check} e */
export function legacyWait(e){
	if(e.attempt?.version!==1 || e.receipt || e.runnerStarted || ["retired","withdrawn","refused"].includes(e.state))return;
	if(e.attempt.closure==="closed-before-runner-claim")return e.state==="done"?"closed; waiting for a provable current obligation":
		"closed-before-runner-claim; waiting for the original native settlement";
	if(e.attempt.closure==="never-issued")return "closed as unissued; waiting for provable inputs and the original issuer";
	if(e.state==="ready")return "waiting for the original issuer and provable, never-issued inputs";
	if(e.state==="ordinary" || e.state==="issued" || e.state==="uncertain")return "waiting for the original native call; absence is not permission to replay";
}
/** @param {Check} e */
export const attachedLegacy=e=>e.tool==="bash" && e.attempt?.version===1 && !!e.callId && !e.runnerStarted && !e.runnerClaim && !e.receipt &&
	(e.state==="issued" || e.state==="uncertain");
/** Close inside the original SQLite claim lock. The caller reports a refusal
 * only after commit; no signer, preparation or evaluation takes place.
 * @param {import("./model.js").Run} r @param {Check} e @param {string} cwd */
export function closeLegacy(r,e,cwd){
	if(e.attempt?.version!==1 || !attachedLegacy(e) || !exactRunner(r,e,cwd))
		fail("unissued_check","Historical check has no exclusive unclaimed slot for this command");
	e.attempt.closure="closed-before-runner-claim";
}
