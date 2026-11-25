import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { openDatabase } from "./database.mjs";
import { put } from "../test/fixture.mjs";
import { fixture, noGap, proof, propose, readFile, run, submit, worker } from "../test/release.mjs";

for(const scenario of ["stopped","refused","unfunded writer","unfunded read","funded read","live","uncertain","held"]) test(`passing checkpoint obligations / ${scenario}`,async t=>{
	const read=scenario.endsWith("read"), capped=read || scenario==="unfunded writer";
	const f=fixture(t,["core","side"],`has("core/ok")`,capped ? scenario==="funded read"?5:4 : undefined);
	let manual=false;
	const owner=f.runtime(f.root,{execute:async(tool,args,call)=>{
		if(tool==="create_session" && String(args.name).startsWith("side ")) {
			if(scenario==="refused") return {resultType:"denied"};
			if(scenario==="uncertain") throw Error("launch acknowledgement lost");
		}
		return f.execute(tool,args,call);
	},permissionBlocker:async()=>manual ? {scope:"session",message:"Manual dispatch hold."} : null});
	await f.start(owner);
	for(const s of [...f.scouts]) await s.report(s.squad==="core"?propose("core"):noGap("side"));
	const artifact=(await owner.operation("publish",{run,file:"reference",to:["side"]},"owner")).artifacts[0];
	const core=worker(f,"core"), events=new EventEmitter(), held=once(events,"held"), release=once(events,"release");
	const issuer=f.runtime(core.cwd,{execute:async(tool,args,call)=>{
		if(tool==="bash" && String(args.description).startsWith("Check final goal")) {events.emit("held"); await release;}
		return f.execute(tool,args,call);
	}});
	put(core.cwd,"core/ok","yes");
	const first=issuer.operation("submit",{run,token:core.token},core.id);
	try {
		await Promise.race([held,first.then(()=>assert.fail("missing issued goal"))]);
		const product=proof(f).products?.at(-1); assert.ok(product);
		await owner.operation("iterate",{run,directory:"side",receipt:product.check,blob:artifact.blob,question:"Compare the side output."},"owner");
		await f.settle();
		const job=f.scouts.at(-1); assert.equal(job?.squad,"side");
		manual=scenario==="held";
		await job.report(read?readFile("manual/next"):propose("side"));
		if(scenario==="stopped") {
			const w=worker(f,"side");
			await f.runtime(w.cwd).operation("submit",{run,token:w.token,missingInput:"Reference is unavailable."},w.id);
		}
		events.emit("release"); await first; await f.settle();
		const end=proof(f); assert.equal(end.goal?.receipt?.exit,0); assert.equal(end.checkpoint,product.commit);
		if(["live","uncertain","held","funded read"].includes(scenario)) {
			assert.equal(end.qualified,null);
			if(scenario==="live") {
				const w=worker(f,"side"); put(w.cwd,"side/ok","yes"); await submit(f,w);
				assert.ok(proof(f).qualified && proof(f).qualified!==product.commit);
			} else if(scenario==="funded read") {
				const next=f.scouts.at(-1); assert.ok(next && next.id!==job.id); await next.report(noGap("side"));
				assert.equal(proof(f).qualified,product.commit);
			} else assert.ok(end.pending.some(e=>e.grain==="side" && (scenario==="held"?!!e.reason:e.state==="uncertain")));
		} else {
			assert.equal(end.qualified,product.commit);
			assert.equal(end.qualification?.receipts.goal.commit,product.commit);
			assert.equal(end.qualification?.receipts.product.commit,product.commit);
			assert.equal(f.checks.filter(c=>c.startsWith("Check final goal")).length,2);
			const db=openDatabase(f.root); t.after(()=>db.close());
			const note=db.read(run)?.effects.find(e=>e.kind==="handoff")?.args.message;
			assert.match(String(note),scenario==="stopped"?/Reference is unavailable/:scenario==="refused"?/permission refused/:/no assignment remains/i);
		}
	} finally {events.emit("release"); await first;}
});
