import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactDigest } from "../../../skills/foundry/scripts/git-files.mjs";
import { preparationHook, withProduct } from "../../../skills/foundry/scripts/materialize.mjs";
export {copyPrepared} from "../../../skills/foundry/scripts/materialize.mjs";
const temporary=()=>realpathSync(mkdtempSync(path.join(tmpdir(),"foundry-prepared-")));
/** @typedef {import("../../../skills/foundry/scripts/materialize.mjs").Prepared} Prepared */

/** Hold the original build for a batch. Every observer still owns a separate verified copy.
 * @param {string} cwd @param {string} commit @param {(root:string,hook:string,output:string)=>void} prepare
 * @param {(prepared?:Prepared)=>Promise<void>} checks @param {ReturnType<typeof import("./cache.mjs").buildCache>} [cache]
 * @param {NonNullable<import("./model.js").CheckDescription["steps"][number]["build"]>} [expectedHook] */
export async function withPreparation(cwd,commit,prepare,checks,cache,expectedHook) {
	const entry=preparationHook(cwd,commit);
	if(expectedHook && (expectedHook.commit!==commit || (entry?.oid??null)!==(expectedHook.hook?.blob??null) ||
		entry && (entry.name!==expectedHook.hook?.path || entry.mode!==expectedHook.hook?.mode)))throw Error("Reserved preparation hook changed");
	if (!entry) return checks();
	const cached=cache?.get(),source=cached?.source??temporary();
	try {
		if(!cached)await withProduct(cwd,commit,root=>prepare(root,entry.name,source));
		const expected=cached?.expected??artifactDigest(cwd,source);
		if(!cached)cache?.put(source,expected);
		await checks({source,expected});
	} finally { if(!cached)rmSync(source,{recursive:true,force:true}); }
}
