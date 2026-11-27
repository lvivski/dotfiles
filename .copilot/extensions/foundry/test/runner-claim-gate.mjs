// Let all original imports complete, then stop immediately before SQLite takes
// the original runner's exclusive claim. The transaction and command are real.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs,{ appendFileSync, existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const count=process.env.FOUNDRY_TEST_KEY_COUNT;
const exporting=process.env.FOUNDRY_TEST_EXPORT_GATE;
if(exporting && process.argv[1]?.endsWith("/work/runner.mjs")){
	const original=fs.mkdtempSync;
	fs.mkdtempSync=new Proxy(original,{apply(fn,self,args){
		const directory=Reflect.apply(fn,self,args);
		if(String(args[0]).endsWith("/foundry-check-") && !existsSync(exporting+".ready")){
			writeFileSync(exporting+".ready","");until(exporting+".release");
		}
		return directory;
	}});
	syncBuiltinESMExports();
}
/** @param {string} file */
function until(file){
	const end=Date.now()+30_000;
	while(!existsSync(file)){
		if(Date.now()>end)throw Error("Fixture did not release the runner");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
	}
}
if(count){
	if(process.argv[1]?.endsWith("/unit.mjs"))appendFileSync(count+".evaluators","evaluator\n");
	crypto.generateKeyPairSync=new Proxy(crypto.generateKeyPairSync,{apply(fn,self,args){
		if(args[0]==="ed25519")appendFileSync(count,"key\n");
		return Reflect.apply(fn,self,args);
	}});
	syncBuiltinESMExports();
}
const exec=DatabaseSync.prototype.exec,gate=process.env.FOUNDRY_TEST_CLAIM_GATE;
const claiming=new WeakSet();
DatabaseSync.prototype.exec=function(/** @type {string} */ sql){
	const after=!!process.env.FOUNDRY_TEST_AFTER_CLAIM;
	if(sql==="BEGIN IMMEDIATE")claiming.add(this);
	const result=after?exec.call(this,sql):undefined;
	if(gate && (after?claiming.has(this) && sql==="COMMIT":sql==="BEGIN IMMEDIATE")){
		claiming.delete(this);
		writeFileSync(gate+".loaded","");
		until(gate+".continue");
	}
	return after?result:exec.call(this,sql);
};
