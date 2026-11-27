import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { factory, git, put } from "../test/fixture.mjs";
import { harnessFiles } from "./harness.mjs";
import { componentScope } from "./inputs.mjs";
import { resolveInputs, withSourceInputs } from "../../../skills/foundry/scripts/materialize.mjs";

test("a mixed directory keeps current production and restores only the selected historical checks, including external helpers",async t=>{
	const f=factory(t,"sample","unused",{unit:"full default suite","module/check":"both phases","module/implementation":"old product",
		"shared/helper":"original assertions"});
	for (const [file,bytes] of [["module/check","one phase"],["module/implementation","current product"],["shared/helper","revised assertions"]])
		put(f.root,file,bytes);
	git(f.root,"commit","-qam","Update product and checks");
	const product=git(f.root,"rev-parse","HEAD");
	const pin={of:"original",checkpoint:"checked",candidate:f.tip,directory:"module",harness:["module/check","shared/helper"],current:["module/implementation"]};
	const observe=(/** @type {typeof pin} */ selection)=>harnessFiles(f.root,product,"unit",selection).files;
	assert.throws(()=>observe({...pin,harness:["module"],current:["shared"]}),/existing or external harness directory: module/);
	assert.throws(()=>observe({...pin,harness:["module/check"]}),/classify changed inputs.*shared\/helper/);
	const inputs=resolveInputs(f.root,{commit:product,check:"unit",scope:componentScope("sample",pin.directory),
		overlay:{revision:pin.candidate,paths:observe(pin).map(e=>e.name)}});
	await withSourceInputs(f.root,inputs,({root})=>{
		assert.deepEqual(["module/check","shared/helper","module/implementation"].map(p=>readFileSync(path.join(root,p),"utf8")),
			["both phases","original assertions","current product"]);
	});
	assert.equal(readFileSync(path.join(f.root,"module/check"),"utf8"),"one phase");
});
