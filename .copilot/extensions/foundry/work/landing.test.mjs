import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {createRuntime} from "./runtime.mjs";
import {applyExpectedTip} from "./promotion.mjs";
import {record, text} from "./values.mjs";

/** @param {import("node:test").TestContext} t @param {{restrictions?:string[],hostLease?:boolean,unsplit?:boolean}} [options] */
function fixture(t, options = {}) {
	const root = path.resolve(`.foundry-delivery-fixture-${randomUUID()}`);
	mkdirSync(root);
	/** @param {...string} args */
	const git = (...args) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
		"-c", "user.email=fixture@localhost", ...args], {encoding:"utf8"}).trim();
	git("init","-q","-b","work");
	writeFileSync(path.join(root,"base.txt"),"base");
	git("add","base.txt"); git("commit","-qm","fixture baseline"); git("branch","product");
	mkdirSync(path.join(root,".foundry"));
	const runtime = createRuntime({directory:root, stopHookQualified:true, readMode:async () => "interactive",
		withLandingLease: options.hostLease === false ? undefined : async (request, apply) => {
			assert.equal(request.databasePath,path.join(root,".git","foundry","work.sqlite"));
			apply(); // The disposable fixture is exclusively owned by this test.
		},
		log:() => {}, execute: async (name,args,callId) => {
			if (name !== "bash") return {resultType:"unsupported"};
			runtime.pre(name,args,"director",callId);
			const execution = spawnSync("/bin/sh",["-c",text(record(args).command,"command")],{cwd:root,encoding:"utf8"});
			if (execution.status !== 0 && !execution.stderr.includes("delivery_checked_out")) assert.fail(execution.stderr);
			const response = {resultType:execution.status === 0 ? "success" : "failure", textResultForLlm:execution.stdout + execution.stderr};
			runtime.post(name,args,response,"director");
			return response;
		},
	});
	t.after(() => {runtime.close(); rmSync(root,{recursive:true});});
	/** @param {string} id @param {string} filename @param {string} content @param {string} [level] @param {string} [acceptance] @param {string} [productCommand] */
	async function lane(id, filename, content, level="landed", acceptance="artifact-command", productCommand=`test "$(cat base.txt)" = base && test "$(cat ${filename})" = ${content}`) {
		const check = {id:"test", origin:"contract", kind:"command", requirement:"Check exact files", command:`test "$(cat ${filename})" = ${content}`, artifactFiles:[filename]};
		const source = `.foundry/${id}.json`;
		writeFileSync(path.join(root,source),JSON.stringify({format:"foundry-factory",version:2,id,mechanism:"stop-hook", completionTaskId:"accept",
			delivery:{level, acceptance, targetRef:"refs/heads/product"},
			goal:{title:id,scope:{mode:"interactive",delegation:true,workTypes:["code"],paths:["."],restrictions:options.restrictions ?? []},tasks:[
				...(options.unsplit ? [] : [{id:"produce",title:"Produce",assignment:"Publish bundle",workType:"code",checks:[check]}]),
				{id:"accept",title:"Qualify",assignment:"Evaluate joined product",workType:"code",
					checks:[{...check,command:productCommand}],inputs:options.unsplit ? [] : [{taskId:"produce",output:"bundle"}]},
			]}}));
		const started = record(await runtime.operation("start_factory",{source},"director"));
		const goalId = text(record(started.goal).id,"goal");
		const tasks = runtime.store().snapshot().tasks.filter(task => task.goalId === goalId);
		const producer = tasks[0], final = tasks.at(-1);
		assert.ok(final);
		const finalId = final.id;
		writeFileSync(path.join(root,filename),content);
		await runtime.operation("start_task",{taskId:producer.id},"director");
		const published = record(await runtime.operation("run_check",{taskId:producer.id,checkId:"test",publish:options.unsplit ? "product" : "bundle"},"director"));
		assert.equal(published.state,"passed",JSON.stringify(published));
		/** @param {string} action @param {string} [manifestId] @param {string} [actor] */
		const deliver = async (action,manifestId,actor="director") => record(await runtime.operation("delivery",
			{goalId,action,...(manifestId ? {manifestId} : {})},actor));
		async function verify() {
			await runtime.operation("start_task",{taskId:finalId},"director");
			return record(await runtime.operation("run_check",{taskId:finalId,checkId:"test",publish:"product"},"director"));
		}
		return {goalId, final, deliver, verify};
	}
	return {root, git, runtime, lane};
}

test("isolated lanes requalify only a stale join, land exact bytes, never conflate release with landing",async t => {
	const {lane,git,root} = fixture(t);
	const a = await lane("one","a.txt","one"), b = await lane("two","b.txt","two");
	const [pa,pb] = await Promise.all([a.deliver("prepare"),b.deliver("prepare")]);
	const ma = text(pa.manifestId,"manifest"), mb = text(pb.manifestId,"manifest");
	await assert.rejects(a.deliver("qualify",ma,"other"),{code:"forbidden"});
	await assert.rejects(a.deliver("land",ma),{code:"delivery_not_qualified"});
	assert.equal((await a.verify()).state,"passed"); assert.equal((await b.verify()).state,"passed");
	assert.equal((await a.deliver("qualify",ma)).closed,false);
	await b.deliver("qualify",mb);
	const original = git("rev-parse","HEAD");
	const first = await a.deliver("land",ma);
	assert.ok(first.landed,JSON.stringify(first)); assert.equal(first.closed,true); assert.equal(first.released,false);
	assert.equal(git("rev-parse","HEAD"),original);
	assert.equal(git("show","product:a.txt"),"one");
	await assert.rejects(b.deliver("land",mb),{code:"delivery_stale_tip"});
	const fresh = text((await b.deliver("prepare")).manifestId,"manifest"); assert.notEqual(fresh,mb);
	await assert.rejects(b.deliver("qualify",fresh),{code:"delivery_not_qualified"});
	await b.verify(); await b.deliver("qualify",fresh);
	assert.ok((await b.deliver("land",fresh)).landed);
	assert.equal(git("show","product:a.txt"),"one"); assert.equal(git("show","product:b.txt"),"two");
	assert.equal(git("rev-parse","product^"),first.newTip);
	assert.equal(readFileSync(path.join(root,"base.txt"),"utf8"),"base");
});

test("checked-out target in a linked worktree is retained; release and interactive routes remain unsupported",async t => {
	const {lane,git,root} = fixture(t);
	const a = await lane("release","a.txt","one","released");
	const id = text((await a.deliver("prepare")).manifestId,"manifest");
	await a.verify(); await a.deliver("qualify",id);
	const tip = git("rev-parse","product");
	git("worktree","add","-q",path.join(root,"checked"),"product");
	await assert.rejects(a.deliver("land",id),{code:"delivery_checked_out"});
	const refused = await a.deliver("status");
	assert.equal(record(refused.intent).reason,"delivery_checked_out"); assert.equal(refused.landed,null); assert.equal(git("rev-parse","product"),tip);
	git("-C",path.join(root,"checked"),"switch","--detach","-q",tip);
	const landed = await a.deliver("land",id);
	assert.ok(landed.landed,JSON.stringify(landed)); assert.equal(landed.closed,false); assert.equal(landed.released,false);
	const ui = await lane("ui","ui.txt","two","qualified","interactive");
	await assert.rejects(ui.deliver("prepare"),{code:"interactive_product_unsupported"});
});

test("conflicting output or failed whole-product check retains the lane without ref mutation",async t => {
	const {lane,git} = fixture(t);
	const a = await lane("alpha","app.txt","one"), b = await lane("beta","app.txt","two");
	const id = text((await a.deliver("prepare")).manifestId,"manifest");
	await b.deliver("prepare");
	await a.verify(); await a.deliver("qualify",id); await a.deliver("land",id);
	await assert.rejects(b.deliver("prepare"),{code:"delivery_conflict"});
	const c = await lane("bad","core.txt","three","landed","artifact-command","test ! -e base.txt");
	const mid = text((await c.deliver("prepare")).manifestId,"manifest");
	assert.equal((await c.verify()).state,"failed");
	await assert.rejects(c.deliver("qualify",mid),{code:"delivery_not_qualified"});
	assert.equal(git("show","product:app.txt"),"one");
});

test("advance qualifies with scope restrictions but cannot infer permission for a shared ref",async t => {
	const {lane,runtime,git} = fixture(t,{restrictions:["Only the isolated scenario is authorized"]});
	const job = await lane("restricted","core.txt","three");
	const status = await job.deliver("status"); assert.equal(status.published,true); assert.equal(status.qualified,null);
	await job.deliver("prepare"); await job.verify();
	const advance = () => runtime.operation("advance",{goalId:job.goalId},"director");
	await advance(); assert.ok((await job.deliver("status")).qualified);
	const next = record(await advance()); assert.ok(Array.isArray(next.productDeliveries));
	assert.equal(record(next.productDeliveries[0]).blocked,"delivery_restricted");
	assert.equal(git("rev-parse","product"),git("rev-parse","HEAD"));
});

test("missing checkout lease is unsupported even on a host which can run shell checks",async t => {
	const {lane,git} = fixture(t,{hostLease:false});
	const job = await lane("unsupported","leaf.txt","one");
	const id = text((await job.deliver("prepare")).manifestId,"manifest");
	await job.verify(); await job.deliver("qualify",id);
	await assert.rejects(job.deliver("land",id),{code:"landing_host_unsupported"});
	assert.equal((await job.deliver("status")).intent,null);
	assert.equal(git("rev-parse","product"),git("rev-parse","HEAD"));
});

test("uncertain issuance never reissues or treats tip equality as its own receipt",async t => {
	const {lane,runtime,git} = fixture(t);
	const job = await lane("uncertain","leaf.txt","one"), db = runtime.store();
	const id = text((await job.deliver("prepare")).manifestId,"manifest");
	await job.verify(); await job.deliver("qualify",id);
	const intent = db.issueLanding(job.goalId,id,"director");
	await assert.rejects(job.deliver("reconcile",id),{code:"delivery_uncertain"});
	await assert.rejects(job.deliver("land",id),{code:"delivery_uncertain"});
	// Simulate lost host response after a real authorized fast-forward.
	applyExpectedTip(db.databasePath,intent.target,intent.token);
	assert.equal((await job.deliver("status")).landed,null);
	assert.equal(git("rev-parse","product"),intent.target.newTip);
	assert.ok((await job.deliver("reconcile",id)).landed);
	assert.equal((await job.deliver("reconcile",id)).closed,true);
});

test("an unsplit job must recheck its named product on the whole joined tree, not reuse its preliminary publication",async t => {
	const {lane,git} = fixture(t,{unsplit:true});
	const job = await lane("unsplit","solo.txt","yes","qualified","artifact-command","test \"$(cat solo.txt)\" = yes");
	assert.equal((await job.deliver("status")).closed,false);
	const id = text((await job.deliver("prepare")).manifestId,"manifest");
	await assert.rejects(job.deliver("qualify",id),{code:"delivery_not_qualified"});
	assert.equal((await job.verify()).state,"passed");
	const status = await job.deliver("qualify",id);
	assert.ok(status.qualified); assert.equal(status.closed,true); assert.equal(status.landed,null);
	assert.equal(git("rev-parse","product"),git("rev-parse","HEAD"));
});
