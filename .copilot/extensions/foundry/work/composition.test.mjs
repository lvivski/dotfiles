import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import reviewFirst from "../test/fixtures/review-first.json" with {type:"json"};

/** @param {import("node:test").TestContext} t @param {unknown} declaration */
function variant(t,declaration){
	const root=resolve(import.meta.dirname,"../../.."),home=mkdtempSync(join(tmpdir(),"foundry-edition-"));
	t.after(()=>rmSync(home,{recursive:true,force:true}));
	for(const path of ["extensions/foundry","skills/foundry"])cpSync(join(root,path),join(home,path),{recursive:true});
	const file=join(home,"extensions/foundry/work/prerequisites.json");
	writeFileSync(file,JSON.stringify(declaration));
	return {root,home,file};
}
test("one trusted declaration can require both original publications without changing executable code",{timeout:150000},t=>{
	const {root,home}=variant(t,[{when:["multipleOwners"],requires:["included-publications","declared-dependencies"]},{requires:[]}]);
	/** @param {string} edition @param {boolean} cross */
	function exercise(edition,cross){
		const file=join(edition,"extensions/foundry/work/series.test.mjs");
		const {NODE_TEST_CONTEXT,...base}=process.env;
		const r=spawnSync(process.execPath,["--test","--test-reporter=tap","--test-name-pattern=^a newly approved two-writer series",file],{encoding:"utf8",timeout:65000,
			env:{...base,FOUNDRY_TEST_SERIES_SOURCES:cross?"cross":"ordinary",FOUNDRY_TEST_SERIES_CALIBRATION:""}});
		assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/# pass 2/);assert.match(r.stdout,/# skipped 0/);
		const line=r.stdout.split("\n").find(l=>l.startsWith('# {"series":'));assert.ok(line);
		const result=JSON.parse(line.slice(2));assert.equal(result.extraPrerequisite,cross);
		return result.series;
	}
	const standard=exercise(root,false),extended=exercise(home,true);
	assert.deepEqual(extended,standard,"compare actual Git trees, output bytes, observation order, reviews, builds, consent and independent replay");
	t.diagnostic(JSON.stringify({standard,extended}));
});

test("one trusted declaration orders only real dependencies before their consumers",{timeout:90000},t=>{
	const {home}=variant(t,reviewFirst);
	const {NODE_TEST_CONTEXT,...env}=process.env;
	const result=spawnSync(process.execPath,["--test","--test-reporter=tap","--test-name-pattern=^an admitted review dependency|^independent members",
		join(home,"extensions/foundry/work/series.test.mjs")],{encoding:"utf8",timeout:65000,env:{...env,FOUNDRY_TEST_SEQUENCE:"reviewed"}});
	assert.equal(result.status,0,result.stdout+result.stderr);
	assert.match(result.stdout,/# pass 3/);
});

test("reject an unknown prerequisite, guard, action or missing fallback before admitting any work",t=>{
	const {home,file}=variant(t,[]);
	for(const row of [{requires:["skip-review"]},{when:["unknown"],requires:[]},{requires:[],action:"draft"},{when:["multipleOwners"],requires:[]}]){
		writeFileSync(file,JSON.stringify([row]));
		const result=spawnSync(process.execPath,[join(home,"extensions/foundry/work/strategy.mjs")],{encoding:"utf8"});
		assert.ifError(result.error);assert.notEqual(result.status,0,JSON.stringify(row));assert.match(result.stderr,/approved-member/);
	}
});
