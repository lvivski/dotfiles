import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./fixture.mjs";
import { installTools } from "./install.mjs";

/** @typedef {NonNullable<ReturnType<typeof import("../work/handoff.mjs").qualification>>} Proof */
/** @param {string} root @param {Proof} proof @param {string} [label] @param {string} [selection] */
export function recipient(root,proof,label="recipient",selection){
	const home=realpathSync(dirname(root)),dest=join(home,label),bundle=join(home,`${label}.bundle`);
	git(root,"init","-q","--object-format="+git(root,"rev-parse","--show-object-format"),dest);
	const helper=installTools(join(dest,"trusted-tools")),history=proof.format!=="foundry-qualification/v5";
	writeFileSync(join(dest,"manifest.json"),JSON.stringify(proof));
	for(const [action,cwd] of [["pack",root],["import",dest]]){
		/** @type {import("node:child_process").SpawnSyncReturns<string>} */ const result=spawnSync(process.execPath,[helper,action,...(history?["--history",bundle]:[bundle,...(selection?[selection]:[])])],{cwd,input:JSON.stringify(proof),encoding:"utf8"});
		assert.equal(result.status,0,result.stderr);
		if(history)assert.match(result.stderr,/Historical object transfer only/);
	}
	assert.equal(existsSync(join(dest,".git/foundry")),false);return dest;
}
/** @param {string} dest @param {string} selection @param {string} [deltaFile] */
export function launchDescription(dest,selection,deltaFile){
	const result=spawnSync(process.execPath,[join(dest,"trusted-tools/qualification.mjs"),"materialize",selection,join(dirname(dest),randomUUID()),
		...(deltaFile?["--delta-file",deltaFile]:[])],{cwd:dest,input:readFileSync(join(dest,"manifest.json")),encoding:"utf8"});
	if(result.status!==0)throw Error(result.stderr);
	return result.stdout;
}
/** @param {string} dest @param {string} selection @param {string} [deltaFile] @returns {import("../../../skills/foundry/scripts/materialize.mjs").Step[]} */
export const launchPlan=(dest,selection,deltaFile)=>JSON.parse(launchDescription(dest,selection,deltaFile)).steps;
/** Only for negative controls on inert validation utilities. Actual build/check observations use the guide.
 * @param {import("../../../skills/foundry/scripts/materialize.mjs").Step} s */
export function launchStep(s){
	assert.ok(s.kind==="verify" || s.kind==="copy-prepared");
	return spawnSync(s.executable,s.argv,{cwd:s.cwd,env:{PATH:process.env.PATH},encoding:"utf8"});
}
/** Exercise the exact published program as a standalone consumer. The caller has real input
 * and regular output files, so accidental descriptor inheritance is observable without a TTY.
 * @param {string} dest @param {string} description Verbatim CLI output. */
export function guideReplay(dest,description){
	const guide=readFileSync(new URL("../../../skills/foundry/references/handoff.md",import.meta.url),"utf8");
	const section=guide.split("### Inspect or independently observe one check\n")[1]?.split("\n## ")[0];assert.ok(section);
	const blocks=[...section.matchAll(/^```js\n([\s\S]*?)^```$/gm)];assert.equal(blocks.length,1);
	const prefix=join(dirname(dest),randomUUID()),script=prefix+".mjs",plan=prefix+".json";
	writeFileSync(script,blocks[0][1]);writeFileSync(plan,description);
	writeFileSync(prefix+".in","private caller input\n");
	const fds=[openSync(prefix+".in","r"),openSync(prefix+".out","wx"),openSync(prefix+".err","wx")];
	try{
		const r=spawnSync(process.execPath,[script,plan],{cwd:dest,env:{PATH:process.env.PATH},stdio:fds});
		assert.ifError(r.error);
		return {status:r.status,stdout:readFileSync(prefix+".out","utf8"),stderr:readFileSync(prefix+".err","utf8")};
	}finally{for(const fd of fds)closeSync(fd);}
}
/** @param {string} dest @param {string} selection */
export async function observed(dest,selection){
	return guideReplay(dest,launchDescription(dest,selection));
}
/** @param {import("../work/model.js").Receipt["components"]} observations */
export const verdicts=observations=>observations && Object.fromEntries(Object.entries(observations).map(([id,{check,exit}])=>[id,{check,exit}]));
