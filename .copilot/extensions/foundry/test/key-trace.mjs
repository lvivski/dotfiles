import crypto from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
crypto.generateKeyPairSync=new Proxy(crypto.generateKeyPairSync,{apply(generate,self,args){
	const file=process.env.FOUNDRY_TEST_KEYS;
	if(file && args[0]==="ed25519" && process.argv[1]?.endsWith("/work/runner.mjs"))appendFileSync(file,process.argv.at(-1)+"\n");
	return Reflect.apply(generate,self,args);
}});
syncBuiltinESMExports();
if(process.argv[1]?.endsWith("/work/runner.mjs") && process.env.FOUNDRY_TEST_KEYS && existsSync(process.env.FOUNDRY_TEST_KEYS+".strict"))
	await import("./claim-imports.mjs");
