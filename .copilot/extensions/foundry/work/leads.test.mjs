import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import test from "node:test";
import { factory, git, put } from "../test/fixture.mjs";

for (const phase of ["settled", "already issued", "unreached", "conflicting", "structured","partial charter"]) test(`a newer step observation narrows historical routing / ${phase}`, async t => {
	const run = "views", source = ".foundry/views.json", squads = ["shell","orders","loader"];
	const excerpt = "item.open: gap - initial window not observed";
	const marker = {id:"open-window",directory:"shell/view"};
	const lines = phase === "structured" ? ["FOUNDRY_BLOCKERS="+JSON.stringify([{...marker,passed:true}])] :
		phase === "unreached" ? ["item.open.details: passed","item.open: not run"] :
		phase === "conflicting" ? ["item.open: passed",excerpt] : ["item.open: passed"];
	const answered = phase !== "unreached" && phase !== "conflicting";
	const f = factory(t,run,source,{
		[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Open an item and display orders.",goalCheck:"goal.mjs",productCheck:"unit.mjs",
			squads:squads.map(id=>({id,charter:`${id}.md`,areas:[id],checks:["unit.mjs"]}))}),
		".foundry/views/journey.md":"Open an item and display its orders.","unit.mjs":"","orders/view/content":"empty",
		...Object.fromEntries(squads.map(id=>[`${id}.md`,`Own ${id}.`])),
		"goal.mjs":`import {existsSync as has} from "node:fs"; if (!has("loader/view/data")) {
			console.log(${JSON.stringify(excerpt)}); console.log("item.save: gap - draft discarded"); process.exit(1); }
			if (!has("orders/view/content-ready")) {
				for(const line of ${JSON.stringify(lines)}) console.log(line);
				console.log('Release verification was not run.\\nFOUNDRY_GOAL_FEEDBACK={"gaps":[]}'); process.exit(2); }
			if (!has("orders/view/release")) {console.log("Release unavailable.");process.exit(2);}`,
	});
	const proof = () => f.owner.inspect({run,detail:"proof"},"owner");
	const proposal = (/** @type {string} */ id, /** @type {string} */ file) => ({outcome:"regenerate",reason:`Build ${id}.`,evidence:[file],
		grains:[{id,directory:`${id}/view`,task:`Build ${id}.`,check:"unit.mjs",needs:[]}]});
	await f.start();
	const prior = proof().goalChecks?.at(-1); assert.ok(prior?.receipt?.exit===1);
	await f.owner.operation("attribute",{run,receipt:prior.id,...marker,blocked:9,excerpt},"owner");
	if (phase==="partial charter") await f.owner.operation("attribute",{run,receipt:prior.id,id:"save-draft",directory:"shell/drafts",
		blocked:1,excerpt:"item.save: gap - draft discarded"},"owner");
	for (const s of f.scouts) await s.report(s.squad==="loader" ? proposal("loader","loader.md") : s.squad==="orders" ?
		{outcome:"unresolved",reason:"Need loaded order data.",evidence:["orders/view/content"],grains:[]} :
		{outcome:"no-gap",reason:"No supported change.",evidence:["shell.md"],grains:[]});
	const [w] = f.workers.values(), count = f.scouts.length;
	const held = phase==="already issued", events = new EventEmitter(), pending = once(events,"pending"), release = once(events,"release");
	if (!held) await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const writer = f.runtime(w.cwd,{execute:async(tool,args,call)=>{
		if (held && tool==="bash" && String(args.description).includes("final goal")) { events.emit("pending"); await release; }
		return f.execute(tool,args,call);
	}});
	put(w.cwd,"loader/view/data","loaded");
	const submit = writer.operation("submit",{run,token:w.token},w.id);
	try {
		if (held) {
			await Promise.race([pending,submit.then(()=>assert.fail("goal was not issued"))]); await f.settle();
			assert.ok(f.scouts.slice(count).some(s=>s.squad==="shell"));
		}
		events.emit("release"); await submit; await f.settle();
		if (!held) await f.runtime(f.root).operation("configure",{run,revision:1,checkpointReviews:true},"owner");
		await f.settle();
		const newer = proof().goalChecks?.at(-1); assert.equal(newer?.receipt?.exit,2); assert.equal(proof().qualified,null);
		const blocker = proof().sharedBlockers?.find(b=>b.id===marker.id);
		assert.equal(blocker?.schedulingPass,answered ? newer?.id : undefined);
		assert.equal(blocker?.state,phase==="structured" ? "verified" : "awaiting-verification");
		const shell = f.scouts.slice(count).find(s=>s.squad==="shell");
		if (held) {
			assert.ok(shell); await shell.report(proposal("shell","shell.md"));
			assert.ok(!proof().nodes.some(n=>n.grain==="shell"),"record the original reply without starting another observer writer");
			assert.equal(proof().reviews.find(r=>r.id===shell.id)?.workflowId,shell.workflowId);
		} else if (phase==="partial charter") {
			assert.ok(shell && shell.prompt.includes("open-window") && shell.prompt.includes(newer?.id ?? "missing"));
			assert.equal(proof().sharedBlockers?.find(b=>b.id==="save-draft")?.schedulingPass,undefined);
			const draft = proposal("shell","shell.md"); draft.grains[0].directory = "shell/drafts";
			await shell.report(draft);
			assert.ok(proof().nodes.find(n=>n.directory==="shell/drafts")?.worker);
		} else assert.equal(!!shell,!answered,"only an explicit pass for the attributed step retires its owner's lead");
		const orders = f.scouts.slice(count).find(s=>s.squad==="orders"); assert.ok(orders);
		await orders.report(proposal("orders","orders/view/content"));
		const peer = f.workers.get(proof().nodes.find(n=>n.grain==="orders")?.worker ?? ""); assert.ok(peer);
		put(peer.cwd,"orders/view/content-ready","yes");
		await f.runtime(peer.cwd).operation("submit",{run,token:peer.token},peer.id); await f.settle();
		const end = proof(); assert.equal(end.goal?.receipt?.exit,2); assert.equal(end.qualified,null);
		assert.equal(git(f.root,"show",`${end.checkpoint}:orders/view/content-ready`),"yes");
		if (answered && phase!=="partial charter") assert.ok(!f.scouts.some(s=>s.base===end.checkpoint && s.squad==="shell"),"a later pending or generic exit 2 must not resurrect the old lead");
		assert.deepEqual(end.goalChecks?.find(g=>g.id===prior.id),prior);
		assert.deepEqual(end.goalChecks?.find(g=>g.id===newer?.id),newer);
	} finally { events.emit("release"); await submit; }
});

for (const phase of ["missing", "pending", "one slot", "automatic pending", "pass during investigation", "packet refusal"]) test(`an attributed blocker prioritizes but does not monopolize checkpoint discovery / ${phase}`, async t => {
	const run = "panels", source = ".foundry/panels.json", areas = ["stock","quiet","shell","loader"];
	const held = ["pending","automatic pending","pass during investigation"].includes(phase);
	const limited = phase === "one slot" || phase === "packet refusal";
	const f = factory(t,run,source,{
		[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Expose stock on the dashboard.",
			goalCheck:"goal.mjs",productCheck:"unit.mjs",...(phase === "packet refusal" ? {limits:{workers:1}} : {}),
			squads:areas.map(id => ({id,charter:`${id}.md`,areas:[id],checks:["unit.mjs"],
				...(id === "shell" && phase === "pending" ? {researchAgent:"inspector"} : {})}))}),
		".foundry/panels/journey.md":"Read the view and quantity.","unit.mjs":"",
		...Object.fromEntries(areas.map(id => [`${id}.md`,`Own the ${id} view.`])),
		"shell/view/layout":"no selected pane","stock/view/value":"no quantity","quiet/view/value":"ready",
		"goal.mjs":`import {existsSync} from 'node:fs';
			if (!existsSync('loader/data/ready')) {
				console.log('Open failed. Dependent journeys did not run.');
				console.log('FOUNDRY_BLOCKERS=[{"id":"open-pane","directory":"shell/view","blocked":9}]');process.exit(1);
			}
			if (${phase !== "pass during investigation"} && !['shell','stock'].every(id=>existsSync(id+'/view/ready'))) {
				console.log('Baseline OK; release has not been verified.');process.exit(2);
			}`,
	});
	/** @param {string} id @param {string} file */
	const proposal = (id,file) => ({outcome:"regenerate",reason:`Implement ${id} from ${file}.`,evidence:[file],
		grains:[{id,directory:id==="loader"?"loader/data":`${id}/view`,task:`Implement ${id}.`,check:"unit.mjs",needs:id==="loader"?[]:["loader"]}]});
	// Start Stock separately with an insufficient native context; keep every other charter and the later checkpoint usable.
	let batch = 0;
	const starter = phase === "packet refusal" ? f.runtime(f.root,{scoutBudget:async()=>batch++ === 1 ? 0 : 100_000}) : f.owner;
	await f.start(starter);
	for (const s of f.scouts) {
		if (s.squad === "loader") await s.report(proposal("loader","loader.md"));
		else if (s.squad === "stock") await s.report({outcome:"unresolved",reason:"Need the loaded data to evaluate the absent quantity.",evidence:["stock/view/value"],grains:[]});
		else await s.report({outcome:"no-gap",reason:"No independent change supported yet.",evidence:[`${s.squad}.md`],grains:[]});
	}
	if (phase === "packet refusal") {
		const st = await f.owner.operation("status",{run,detail:"proof"},"owner");
		assert.ok(st.reviews.some(r=>r.squad==="stock" && r.state==="blocked" && !r.observation));
	}
	if (phase !== "automatic pending") await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const [w] = f.workers.values(), events = new EventEmitter(), pending = once(events,"pending"), release = once(events,"release");
	const loader = f.runtime(w.cwd,{execute:async(tool,args,id)=>{
		if (held && tool === "bash" && String(args.description).includes("final goal")) {
			events.emit("pending"); await release;
		}
		return f.execute(tool,args,id);
	}});
	put(w.cwd,"loader/data/ready","loaded");
	const submission = loader.operation("submit",{run,token:w.token},w.id), initial = f.scouts.length;
	const owner = f.runtime(f.root), proof = () => owner.inspect({run,detail:"proof"},"owner");
	try {
		if (held) await Promise.race([pending, submission.then(()=>assert.fail("expected an issued goal"))]);
		else await submission;
		await f.settle(); if (phase !== "automatic pending") assert.equal(f.scouts.length,initial);
		const before = proof(), [prior,at] = before.goalChecks?.slice(-2) ?? [];
		assert.ok(prior.receipt?.exit === 1 && at.commit === before.checkpoint);
		assert.equal(at.receipt?.exit,held ? undefined : 2);
		if (phase !== "automatic pending") await owner.operation("configure",{run,revision:1,checkpointReviews:true,...(phase === "one slot" ? {workers:1} : {})},"owner");
		await f.settle();
		const scouts = f.scouts.slice(initial);
		assert.deepEqual(scouts.map(s=>s.squad),limited ? ["shell"] : ["shell","stock"],
			"prioritize the blocker, admit the independent open question and skip the settled charters");
		if (limited) {
			await scouts[0].report({outcome:"unresolved",reason:"No permitted shell change.",evidence:["shell/view/layout"],grains:[]});
			assert.deepEqual(f.scouts.slice(initial).map(s=>s.squad),["shell","stock"]);
			if (phase === "packet refusal") {
				const stock = f.scouts.at(-1); assert.ok(stock);
				assert.match(stock.prompt,/scout budget/);
				await stock.report(proposal("stock","stock.md"));
				assert.match(proof().reviews.find(r=>r.id===stock.id)?.reason ?? "",/delivered evidence in its own product area/);
				assert.equal(f.workers.size,1);
			}
			return;
		}
		let [shell,stock] = scouts;
		assert.ok(stock.prompt.includes("stock/view/value") && stock.prompt.includes(prior.id));
		const leads = proof().reviews.filter(r => r.base === at.commit).map(r=>r.lead);
		assert.ok(leads.every(l=>l && (held ? l.pending === at.id && !l.missing : l.missing === at.id && !l.pending)));
		assert.ok(leads.some(l => l?.priorReview === before.reviews.find(r=>r.squad==="stock")?.id));
		if (phase === "pass during investigation") {
			events.emit("release"); await submission; await f.settle();
			assert.equal(proof().goal?.receipt?.exit,0); assert.equal(proof().qualified,null);
		}
		if (phase === "pending") {
			await shell.report({outcome:"needs-research",reason:"What selects the initial pane?",evidence:["shell/view/layout"],grains:[]});
			shell = f.scouts.at(-1) ?? assert.fail("no shell investigation");
			assert.match(shell.prompt,/Investigate one question/);
		}
		await stock.report(proposal("stock","stock/view/value"));
		const independent = proof().nodes.find(n=>n.grain==="stock");
		assert.ok(independent?.worker,"stock must bind while the blocker scout is still reading");
		if (phase === "pending") {
			await shell.report({status:"answered",reason:"The initial pane is unset.",findings:[
				{kind:"code",source:`${at.commit}:shell/view/layout`,finding:"No initial selection."}]});
			shell = f.scouts.at(-1) ?? assert.fail("no deciding scout");
			assert.match(shell.prompt,/No initial selection/);
		}
		await shell.report(proposal("shell","shell/view/layout"));
		const active = proof(); assert.deepEqual(active.nodes.filter(n=>n.state==="writing").map(n=>n.grain).sort(),["shell","stock"]);
		owner.turn("owner"); await owner.flush(); await f.settle();
		assert.equal(f.scouts.length,initial + (phase === "pending" ? 4 : 2));
		if (phase !== "pass during investigation") assert.deepEqual(proof().goalChecks,before.goalChecks);
		if (held) { events.emit("release"); await submission; await f.settle(); }
		for (const id of ["stock","shell"]) {
			const worker = f.workers.get(active.nodes.find(n=>n.grain===id)?.worker ?? ""); assert.ok(worker);
			put(worker.cwd,`${id}/view/ready`,id);
			await f.runtime(worker.cwd).operation("submit",{run,token:worker.token},worker.id); await f.settle();
		}
		const end = proof(); assert.ok(end.qualified && end.goal?.receipt?.commit === end.qualified);
		assert.notEqual(end.qualified,at.commit);
		for (const id of ["stock","shell"]) assert.equal(git(f.root,"show",`${end.qualified}:${id}/view/ready`),id);
		assert.equal(end.goalChecks?.filter(g=>g.commit===at.commit).length,1);
	} finally { events.emit("release"); await submission; }
});

for (const held of [false,true]) test(`missing release evidence automatically fans out historical leads / ${held ? "reconnect after hold" : "writer transition"}`, async t => {
	const run = "catalog", source = ".foundry/catalog.json", areas = ["load","price","stock"];
	const f = factory(t,run,source,{
		[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Display prices and quantities.",
			goalCheck:"goal.mjs",productCheck:"unit.mjs",squads:areas.map(id => ({id,charter:`${id}.md`,areas:[id],checks:["unit.mjs"]}))}),
		".foundry/catalog/journey.md":"Open the catalog.","unit.mjs":"",
		...Object.fromEntries(areas.map(id => [`${id}.md`,`Own the ${id} view.`])),
		"price/view/item":"Shows no price.","stock/view/item":"Shows no quantity.",
		"goal.mjs":`import {existsSync} from 'node:fs';
			if (!existsSync('load/ready')) {
				console.log('Price and quantity are missing.');
				console.log('FOUNDRY_BLOCKERS='+JSON.stringify(['price','stock'].map(id=>({id,directory:id+'/view',blocked:1}))));
				process.exit(1);
			}
			if (!['price','stock'].every(id=>existsSync(id+'/view/ready'))) {
				console.log('Release observation unavailable.');process.exit(2);
			}`,
	});
	await f.start();
	const proof = () => f.owner.operation("status",{run,detail:"proof"},"owner");
	const previous = (await proof()).goalChecks?.[0]; assert.ok(previous);
	for (const scout of [...f.scouts]) {
		if (scout.squad === "load") await scout.report({outcome:"regenerate",reason:"Load the catalog.",evidence:["load.md"],
			grains:[{id:"load",directory:"load",task:"Load the catalog.",check:"unit.mjs",needs:[]}]});
		else await scout.report({outcome:"no-gap",reason:"No repair from the initial survey.",evidence:[`${scout.squad}.md`],grains:[]});
	}
	const submit = async (/** @type {string} */ id, /** @type {string} */ file) => {
		const w = f.workers.get((await f.status()).nodes.find(n=>n.grain===id)?.worker ?? "");assert.ok(w);
		put(w.cwd,file,"ready"); await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id); await f.settle();
	};
	if (held) await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const count = f.scouts.length;
	await submit("load","load/ready");
	const at = await proof(), missing = at.goalChecks?.at(-1); assert.ok(missing?.receipt?.exit === 2);
	assert.equal(at.qualified,null);
	if (held) {
		assert.equal(f.scouts.length,count);
		const reloaded = f.runtime(f.root);
		await reloaded.operation("configure",{run,revision:1,checkpointReviews:true},"owner"); await f.settle();
	}
	const scouts = f.scouts.slice(count);
	assert.deepEqual(scouts.map(s=>s.squad).sort(),["price","stock"],"both independent charters should start without owner routing");
	const checks = [...f.checks];
	for (let s of scouts) {
		assert.equal(s.base,missing.commit); assert.ok(s.prompt.includes(previous.id) && s.prompt.includes(missing.id));
		if (s.squad === "price") {
			await s.report({outcome:"needs-evidence",receipt:previous.id,reason:"Locate the old price observation.",evidence:["price.md"],grains:[]});
			const follow = f.scouts.at(-1); assert.ok(follow?.packet.read?.source === `receipt:${previous.id}`);
			s = follow;
		}
		await s.report({outcome:"regenerate",reason:"The current view still omits its value.",evidence:[`${s.squad}/view/item`],
			grains:[{id:s.squad,directory:`${s.squad}/view`,task:"Show the checked catalog value.",needs:["load"],check:"unit.mjs"}]});
	}
	assert.equal(f.workers.size,3); assert.deepEqual(f.checks,checks,"no unchanged release retry");
	const n = f.scouts.length, reload = f.runtime(f.root); reload.turn("owner"); await reload.flush(); await f.settle();
	assert.equal(f.scouts.length,n);
	await submit("price","price/view/ready");
	assert.equal((await proof()).goalChecks?.at(-1)?.receipt?.exit,2);
	assert.deepEqual(f.scouts.slice(n).map(s=>s.squad),["price"],"new price bytes do not reopen the unchanged stock survey");
	await submit("stock","stock/view/ready");
	const after = await proof(); assert.ok(after.qualified && after.goal?.receipt?.commit === after.qualified);
	for (const id of ["price","stock"]) assert.equal(git(f.root,"show",`${after.qualified}:${id}/view/ready`),"ready");
	assert.deepEqual(after.goalChecks?.find(g=>g.id===missing.id),missing);
});

for (const moved of [false,true]) test(`an unstructured failure on the same product under a previous evaluator / ${moved ? "target moved" : "fresh charter evidence"}`, async t => {
	const run = "catalog", source = ".foundry/catalog.json", goal = ".foundry/catalog/goal.mjs";
	const f = factory(t,run,source,{
		[source]: JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Open a catalog item.",
			goalCheck:goal,productCheck:"unit.mjs",squads:["index","detail"].map(id => ({id,charter:`${id}.md`,areas:[id],checks:["unit.mjs"]}))}),
		".foundry/catalog/journey.md":"Select an item to open it.", "index.md":"List items.", "detail.md":"Open the selected item.", "unit.mjs":"", "detail/view/button":"disabled",
		[goal]:`console.log("catalog/research/item.open: gap - First failed step: cannot open the selected item"); process.exit(1)`,
	});
	await f.start();
	const [index,detail] = f.scouts; assert.ok(index.squad === "index" && detail.squad === "detail");
	await index.report({outcome:"regenerate",reason:"Build the catalog index.",evidence:["index.md"],
		grains:[{id:"list",directory:"index/list",check:"unit.mjs",task:"Build the index.",needs:[]}]});
	await detail.report({outcome:"no-gap",reason:"No further evidence yet.",evidence:["detail.md"],grains:[]});
	const [w] = f.workers.values(); put(w.cwd,"index/list/ready","ready");
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id); await f.settle();
	const prior = f.scouts.slice(2);
	assert.deepEqual(prior.map(r=>r.squad).sort(),["detail","index"]);
	await prior.find(r=>r.squad === "index")?.report({outcome:"no-gap",reason:"The index is present on this revision.",evidence:["index/list/ready"],grains:[]});
	const owner = f.runtime(f.root,{confirm:async () => true});
	const overlay = path.join(path.dirname(f.root),"overlay");
	git(f.root,"worktree","add","-q","--detach",overlay,f.tip);
	put(overlay,goal,`import {readFileSync} from "node:fs"; if (readFileSync("detail/view/button","utf8") !== "enabled") {
		console.log("Baseline complete; release observation missing."); process.exit(2); }`);
	git(overlay,"commit","-qam","Use a baseline observation");
	const count = f.scouts.length;
	await owner.operation("repin",{run,from:f.tip,revision:git(overlay,"rev-parse","HEAD"),files:[goal]},"owner"); await f.settle();
	const fresh = f.scouts.slice(count);
	assert.deepEqual(fresh.map(r=>r.squad),["detail"],"only the charter without a settled survey of the prior failure should run");
	const proof = () => owner.operation("status",{run,detail:"proof"},"owner");
	const before = await proof(), [failed,missing] = before.goalChecks?.slice(-2) ?? [];
	assert.ok(failed.receipt?.exit === 1 && !failed.receipt.blockers && !failed.receipt.squad && missing.receipt?.exit === 2 &&
		failed.commit === missing.commit && failed.receipt.evaluatorRevision !== missing.receipt.evaluatorRevision);
	assert.ok(fresh[0].prompt.includes(failed.id) && fresh[0].prompt.includes(missing.id));
	await prior.find(r=>r.squad === "detail")?.report({outcome:"no-gap",reason:"Late observation on obsolete inputs.",evidence:["detail.md"],grains:[]});
	if (moved) {
		put(f.root,"neighbor","Changed target"); git(f.root,"add","neighbor"); git(f.root,"commit","-qm","Move target");
	}
	await fresh[0].report({outcome:"regenerate",reason:"The button remains disabled in the checked view.",evidence:["detail/view/button"],
		grains:[{id:"open",directory:"detail/view",check:"unit.mjs",task:"Enable selection.",needs:["list"]}]});
	const admitted=await proof();
	assert.equal(admitted.reviews.find(r=>r.id===fresh[0].id)?.state,"observed");
	assert.equal(admitted.reviews.find(r=>r.id===prior.find(s=>s.squad==="detail")?.id)?.state,"blocked");
	assert.deepEqual(admitted.goalChecks,before.goalChecks); assert.equal(admitted.qualified,null);
	const writer = f.workers.get((await f.status()).nodes.find(n=>n.grain === "open")?.worker ?? ""); assert.ok(writer);
	put(writer.cwd,"detail/view/button","enabled");
	await f.runtime(writer.cwd).operation("submit",{run,token:writer.token},writer.id); await f.settle();
	const after = await proof(); assert.ok(after.qualified && after.goal?.receipt?.commit === after.qualified);
	assert.deepEqual(after.goalChecks?.slice(0,-1),before.goalChecks);
	assert.equal(git(f.root,"show",`${after.qualified}:detail/view/button`),"enabled");
	if (moved) assert.equal(git(f.root,"show",`${after.qualified}:neighbor`),"Changed target");
});
