import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("an archived reader loads its own executable rules, without unrelated or test files",t=>{
	const python=spawnSync("python3",["--version"]);
	if(python.error && "code" in python.error && python.error.code==="ENOENT")return t.skip("building an archive requires Python; reading it does not");
	const tmp=mkdtempSync(join(tmpdir(),"foundry-pack-")),source=join(tmp,"source"),archive=join(tmp,"source.tar.xz");
	t.after(()=>rmSync(tmp,{recursive:true,force:true}));
	for(const dir of ["rules","other"])mkdirSync(join(source,"work",dir),{recursive:true});
	for(const [file,text] of Object.entries({"reader.version":"1\n","runtime.mjs":"import {state} from './rules/release.mjs';process.stdout.write(state);",
		"rules/release.mjs":"export const state='original';","rules/release.test.mjs":"not runtime","other/private.mjs":"not an archive input"}))
		writeFileSync(join(source,"work",file),text);
	execFileSync("python3",[fileURLToPath(new URL("./fixtures/pack-readers.py",import.meta.url)),archive,source]);
	execFileSync("tar",["-xf",archive,"-C",tmp]);
	assert.deepEqual(execFileSync("tar",["-tf",archive],{encoding:"utf8"}).trim().split("\n").sort(),
		["1/work/reader.version","1/work/rules/release.mjs","1/work/runtime.mjs"]);
	assert.equal(execFileSync(process.execPath,[join(tmp,"1/work/runtime.mjs")],{encoding:"utf8"}),"original");
});
