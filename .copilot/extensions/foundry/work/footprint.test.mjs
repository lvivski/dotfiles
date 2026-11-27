import assert from "node:assert/strict";
import test from "node:test";
import { footprints, stages } from "./footprint.mjs";
import { factory, git, put } from "../test/fixture.mjs";

test("a new match in a pinned package inventory makes the held output dependent",t=>{
	const source='const inputs=readInventory("inputs.json");';
	const f=factory(t,"build",".foundry/build.json",{"check.mjs":source,"inputs.json":JSON.stringify({sources:["src/*.rs"],unused:[]}),
		"src/current.rs":"original","other/change":"unchanged"});
	put(f.root,"other/change","selected");git(f.root,"add","other/change");git(f.root,"commit","-qm","unrelated edit");
	const outside=git(f.root,"rev-parse","HEAD");
	put(f.root,"src/new.rs","selected");git(f.root,"add","src/new.rs");git(f.root,"commit","-qm","new source");
	const assembly=git(f.root,"rev-parse","HEAD");
	const roles=new Map([["held",{commit:f.tip,check:"check.mjs",scope:"src",selected:false}]]);
	const evidence=[{component:"held",stages:Object.fromEntries(stages.map(s=>[s,[{file:"check.mjs",excerpt:source,
		inventory:{file:"inputs.json",keys:[s==="package"?"sources":"unused"]},reason:"Package compiles the source list; the other stages have no additional inputs."}]]))}];
	const proof=(/** @type {string} */ commit)=>footprints(f.root,evidence,roles,f.tip,commit,["src"],git(f.root,"diff","--name-only",f.tip,commit).split("\n"));
	assert.equal(proof(outside)[0].commit,f.tip);
	assert.throws(()=>proof(assembly),{code:"dependent_output"});
	evidence[0].stages.package[0].inventory.keys=["unused"];
	assert.throws(()=>proof(assembly),{code:"incomplete_evidence"});
});

test("directly cited build inputs need no separate JSON inventory, but cannot hide an overlapping read",t=>{
	const build="build src/item.rs config/settings",f=factory(t,"build",".foundry/build.json",{
		"check.sh":build,"src/item.rs":"fixed","config/settings":"existing","other/entry":"old"});
	put(f.root,"other/entry","new");git(f.root,"commit","-qam","unrelated output");const disjoint=git(f.root,"rev-parse","HEAD");
	put(f.root,"config/settings","new");git(f.root,"commit","-qam","overlapping input");const overlap=git(f.root,"rev-parse","HEAD");
	const roles=new Map([["observed",{commit:f.tip,check:"check.sh",scope:"src",selected:false}]]);
	const evidence=(/** @type {string} */ excerpt)=>[{component:"observed",stages:[{file:"check.sh",excerpt,reason:"These literal operands are the complete inputs throughout."}]}];
	const verify=(/** @type {string} */ tree,excerpt=build)=>footprints(f.root,evidence(excerpt),roles,f.tip,tree,["src"],git(f.root,"diff","--name-only",f.tip,tree).split("\n"));
	for(const notes of Object.values(verify(disjoint)[0].stages))assert.deepEqual(notes[0].inputs,["src/item.rs","config/settings"]);
	assert.throws(()=>verify(overlap),{code:"dependent_output"});assert.throws(()=>verify(disjoint,"build src/item.rs"),{code:"incomplete_evidence"});
});
