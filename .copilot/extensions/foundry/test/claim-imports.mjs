import {appendFileSync,existsSync,readFileSync} from "node:fs";
import {registerHooks,syncBuiltinESMExports} from "node:module";
import child from "node:child_process";
import {DatabaseSync} from "node:sqlite";
const permitted=new Set(["runner","claims","storage","abi","consent","declarations","feedback","fixed","origin","overlay","publication","series","steps","topology","observations","requirements","receipt","revision","values","preparation","cache","verdict","signals","objects","seals"]);
const marker=process.env.FOUNDRY_TEST_KEYS && process.env.FOUNDRY_TEST_KEYS+".strict";
const mixed=marker && existsSync(marker)?readFileSync(marker,"utf8"):undefined;
if(mixed)for(const file of ["historical","ancestry","approved","archive","inputs"])permitted.add(file);
const lockLog=mixed && mixed+".locks",loadLog=mixed??process.env.FOUNDRY_TEST_LOAD_LOG;
if(lockLog && process.argv[1]?.endsWith("/work/runner.mjs")){
	const writers=new Set(),exec=DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec=function(/** @type {string} */ sql){
		const result=exec.call(this,sql);
		if(/(?:^|;)\s*BEGIN IMMEDIATE\b/.test(sql))writers.add(this);
		if(/^(COMMIT|ROLLBACK)$/.test(sql))writers.delete(this);
		return result;
	};
	child.execFileSync=new Proxy(child.execFileSync,{apply(fn,self,args){
		if(args[0]==="git" && Array.isArray(args[1]) && args[1].some(c=>["ls-tree","diff-tree","cat-file"].includes(c)))
			appendFileSync(lockLog,`${writers.size>0?"locked":"outside"}\n`);
		return Reflect.apply(fn,self,args);
	}});
	syncBuiltinESMExports();
}
registerHooks({resolve(specifier,context,next){
	const result=next(specifier,context),marker="/extensions/foundry/",from=result.url.indexOf(marker);
	if(from>=0){
		const name=result.url.slice(from+marker.length);
		if(!name.startsWith("work/") || !permitted.has(name.slice(5,-4)))throw Error("Forbidden current runner load: "+name);
		if(loadLog)appendFileSync(loadLog,name+"\n");
	}
	if(specifier.includes("copilot-sdk"))throw Error("The evaluator cannot load the host SDK");
	return result;
}});
