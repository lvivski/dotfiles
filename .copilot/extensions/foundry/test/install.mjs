import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Only the documented trusted distribution, never an extension or source checkout.
 * @param {string} dest */
export function installTools(dest){
	mkdirSync(dest,{recursive:true});
	for(const f of ["qualification.mjs","materialize.mjs","git-files.mjs","recipe.mjs"])
		copyFileSync(new URL(`../../../skills/foundry/scripts/${f}`,import.meta.url),join(dest,f));
	return join(dest,"qualification.mjs");
}
/** Runner ABI tests replace modules inside a real paired directory layout. @param {string} home */
export function pairedWork(home){
	installTools(join(home,"skills/foundry/scripts"));
	return join(home,"extensions/foundry/work");
}
