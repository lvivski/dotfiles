import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { factory, git, put } from "../test/fixture.mjs";
import { assignment } from "./native.mjs";
import { idleHome } from "./pool.mjs";

for (const phase of ["idle","busy","late status","lost acknowledgement"]) test(`finished squad writers / ${phase}`, async t => {
	const available = phase==="idle" || phase==="lost acknowledgement";
	const run = "desk", source = ".foundry/desk.json";
	const f = factory(t,run,source,{
		[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Ship all panels.",goalCheck:"goal.mjs",productCheck:"unit.mjs",
			squads:[{id:"ui",areas:["panels"],charter:"ui.md",checks:["unit.mjs"]}]}),
		".foundry/desk/journey.md":"Read every panel.", "ui.md":"Own the panels.",
		"unit.mjs":`import {existsSync} from "node:fs"; if(process.env.FOUNDRY_GRAIN==="second" && !existsSync("panels/main/repair"))process.exit(1);`,
		"goal.mjs":`import {existsSync} from "node:fs"; if(!existsSync("panels/end/done"))process.exit(1);`,
	});
	let lost = false;
	const maybeLose = (/** @type {unknown} */ msg) => {
		if (phase==="lost acknowledgement" && !lost && String(msg).includes("New assignment in the same squad.")) {
			lost = true; throw Error("Message delivered; queue acknowledgement unavailable");
		}
	};
	const execute = async (/** @type {string} */ tool, /** @type {import("./model.js").NativeCall["args"]} */ args, /** @type {string} */ call) => {
		const result = await f.execute(tool,args,call); if (tool==="send_session_message") maybeLose(args.message); return result;
	};
	const idleWriter = async (/** @type {string} */ id) => {
		if (phase==="late status") await delay(6500);
		return idleHome({resultType:"success",structuredContent:{id,active_session_id:id,path:f.workers.get(id)?.cwd,
			session_type:"worktree",awaiting_user_input:false,was_interrupted:false,activity:{status:phase==="busy"?"busy":"idle"}}},id);
	};
	const log = (/** @type {string} */ s) => t.diagnostic(s);
	const owner = f.runtime(f.root,{execute,idleWriter,log}), proof = () => owner.inspect({run,detail:"proof"},"owner");
	await f.start(owner);
	const write = async (/** @type {string} */ grain, /** @type {string} */ dir, /** @type {string} */ file) => {
		const n = proof().nodes.find(n=>n.grain===grain), w = f.workers.get(n?.worker ?? ""); assert.ok(w);
		const writer = f.runtime(w.cwd,{execute,idleWriter,log,notify:async msg=>{
			const a=assignment(msg); if (a) f.inbox.push({worker:w.id,token:a.token});
			maybeLose(msg); return "accepted";
		}}), status = writer.inspect({run},w.id).nodes.find(n=>n.grain===grain);
		assert.ok(status?.token);
		let root = w.cwd;
		if (status.workspace) {
			await writer.operation("workspace",{run,token:status.token},w.id);
			root = path.join(root,status.workspace);
			assert.equal(git(root,"rev-parse","HEAD"),status.generation);
			assert.equal(existsSync(path.join(root,dir)),false,"old directory must not leak into a new assignment");
			await assert.rejects(writer.operation("workspace",{run,token:w.token},w.id),/assignment|token/);
			await writer.operation("workspace",{run,token:status.token},w.id);
		}
		put(root,`${dir}/${file}`,grain);
		const preview = await writer.operation("preview",{run,token:status.token},w.id);
		const pin = preview.nodes.find(n=>n.grain===grain)?.preview; assert.ok(pin);
		assert.equal(git(f.root,"show",`${pin}:${dir}/${file}`),grain);
		if (status.workspace) {
			const offered = await writer.operation("publish",{run,token:status.token,file:`${dir}/${file}`,to:[dir]},w.id);
			assert.equal(git(f.root,"cat-file","blob",offered.artifacts.at(-1)?.blob ?? ""),grain);
		}
		const submitted = await writer.operation("submit",{run,token:status.token},w.id);
		if (grain==="second") {
			const repair = submitted.nodes.find(n=>n.grain===grain);
			assert.ok(repair?.token && repair.token!==status.token && repair.repairs===1 && repair.workspace===status.workspace);
			if (repair.workspace) await writer.operation("workspace",{run,token:repair.token},w.id);
			put(root,`${dir}/repair`,"fixed");
			await writer.operation("submit",{run,token:repair.token},w.id);
		}
		await f.settle(); return w;
	};
	const propose = async (/** @type {string[][]} */ jobs) => {
		const s = f.scouts.at(-1); assert.ok(s && s.base===proof().goal?.commit);
		await s.report({outcome:"regenerate",reason:"Required panels are missing.",evidence:["ui.md"],
			grains:jobs.map(([id,directory])=>({id,directory,task:`Deliver ${id}.`,check:"unit.mjs",needs:[]}))});
	};
	await propose([["first","panels/main"]]);
	const first = await write("first","panels/main","first");
	const originalHead = git(first.cwd,"rev-parse","HEAD");
	put(first.cwd,"unsubmitted-note","preserve");
	await propose([["parallel","panels/side"],["second","panels/main"]]);
	if (phase==="lost acknowledgement") {
		assert.ok(lost); const pending = proof().pending.find(e=>e.kind==="writer" && e.state==="uncertain"); assert.equal(pending?.grain,"second");
		const delivery = f.inbox.filter(m=>m.worker===first.id).at(-1); assert.ok(delivery && delivery.token!==first.token);
		owner.turn("owner"); await owner.flush();
		assert.equal(f.inbox.filter(m=>m.token===delivery.token).length,1);
		await assert.rejects(owner.operation("workspace",{run,token:delivery.token},"owner"),/assignment/);
		await f.runtime(first.cwd).operation("workspace",{run,token:delivery.token},first.id);
	}
	const second = proof().nodes.find(n=>n.grain==="second"), peer = proof().nodes.find(n=>n.grain==="parallel");
	assert.ok(second?.worker && peer?.worker); assert.notEqual(second.worker,peer.worker);
	assert.equal(second.worker===first.id,available,"reuse a finished same-directory writer when idle");
	assert.equal(f.workers.size,available?2:3);
	await write("second","panels/main","second");
	// Keep the peer bound: even an idle native session isn't finished until its work is checked.
	await propose([["last","panels/end"]]);
	const last = proof().nodes.find(n=>n.grain==="last"); assert.ok(last?.worker);
	assert.equal(last.worker===second.worker,available,"use a finished same-squad writer across directories");
	assert.notEqual(last.worker,peer.worker);
	if (available) {
		const old = f.runtime(first.cwd);
		assert.deepEqual(old.inspect({run},first.id).nodes.map(n=>n.grain),["last"]);
	}
	await write("parallel","panels/side","side");
	await write("last","panels/end","done");
	const end = proof(); assert.ok(end.qualified && end.qualified===end.goal?.receipt?.commit);
	for (const [file,value] of [["main/second","second"],["side/side","parallel"],["end/done","last"]])
		assert.equal(git(f.root,"show",`${end.qualified}:panels/${file}`),value);
	assert.equal(git(first.cwd,"rev-parse","HEAD"),originalHead);
	assert.ok(existsSync(path.join(first.cwd,"unsubmitted-note")) && existsSync(path.join(first.cwd,"panels/main/first")));
});
