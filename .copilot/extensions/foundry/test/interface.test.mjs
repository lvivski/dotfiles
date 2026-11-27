import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { declaredInterface } from "./interface.mjs";
import { definitions } from "../work/catalog.mjs";

test("the registered extension and ordered machine rules match the independent regeneration contract",async()=>{
	const expected = JSON.parse(await readFile(new URL("../spec/interface.json",import.meta.url),"utf8"));
	assert.deepEqual(await declaredInterface(),expected);
});

test("the explorer registers each production machine, not a separately authored lookalike",async()=>{
	const root=new URL("../work/",import.meta.url), live=definitions();
	const exported=new Map();
	for(const file of await readdir(root,{recursive:true})){
		if(!file.endsWith(".mjs")||file.endsWith(".test.mjs"))continue;
		const url=new URL(file,root),source=await readFile(url,"utf8");
		// Avoid starting CLI-only modules such as the exclusive runner.
		if(!/import\s*\{[^}]*\bmachine\b[^}]*\}\s*from\s*["']\.\.?\/machine\.mjs["']/.test(source))continue;
		const module=await import(url.href);
		for(const value of Object.values(module)){
			if(!value || typeof value!=="object" || !Object.hasOwn(value,"states") || !Object.hasOwn(value,"initial"))continue;
			assert.equal(live[value.id],value,`unregistered or duplicate machine: ${file} / ${value.id}`);
			exported.set(value.id,value);
		}
	}
	assert.deepEqual(new Set(exported.keys()),new Set(Object.keys(live)));
});
