// Let all original imports complete, then stop immediately before SQLite takes
// the original runner's exclusive claim. The transaction and command are real.
import { DatabaseSync } from "node:sqlite";
import { existsSync, writeFileSync } from "node:fs";
const exec=DatabaseSync.prototype.exec,gate=process.env.FOUNDRY_TEST_CLAIM_GATE;
const claiming=new WeakSet();
DatabaseSync.prototype.exec=function(/** @type {string} */ sql){
	const after=!!process.env.FOUNDRY_TEST_AFTER_CLAIM;
	if(sql==="BEGIN IMMEDIATE")claiming.add(this);
	const result=after?exec.call(this,sql):undefined;
	if(gate && (after?claiming.has(this) && sql==="COMMIT":sql==="BEGIN IMMEDIATE")){
		claiming.delete(this);
		writeFileSync(gate+".loaded","");
		const end=Date.now()+30_000;
		while(!existsSync(gate+".continue")){
			if(Date.now()>end)throw Error("Fixture did not release the claim");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
		}
	}
	return after?result:exec.call(this,sql);
};
