import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { factory, git, put } from "./fixture.mjs";

/** @param {string} directory @param {string[]} needs @param {string} body */
const part = (directory, needs, body) => ({ directory, squad: directory.split("/")[0], id: path.basename(directory), needs, body });
const outbox = {
	id: "outbox", direction: "After reopening a two-client outbox, preserve an unacknowledged reply without resending it. A different account can still send.",
	parts: [
		part("core/key", [], "(account,id)=>JSON.stringify([account,id])"),
		part("desktop/editor", [], "text=>({kind:'reply',text})"),
		part("mobile/composer", [], "text=>({kind:'post',text})"),
		part("delivery/transport", [], "async(send,message)=>{try{await send(message);return 'sent'}catch{return 'unknown'}}"),
		part("core/journal", ["key"], "(rows,account,id,message)=>rows[key(account,id)]??=( {account,id,...message,state:'draft'} )"),
		part("delivery/dispatch", ["journal","transport"], `async(rows,account,id,msg,send)=>{
			const entry=journal(rows,account,id,msg);if(entry.state==='draft'){entry.state='unknown';entry.state=await transport(send,{...entry})}return entry.state}`),
		part("desktop/reply", ["editor","dispatch"], "(rows,account,id,text,send)=>dispatch(rows,account,id,editor(text),send)"),
		part("mobile/post", ["composer","dispatch"], "(rows,account,id,text,send)=>dispatch(rows,account,id,composer(text),send)"),
		part("core/workspace", ["reply","post"], "rows=>({reply:(...a)=>reply(rows,...a),post:(...a)=>post(rows,...a)})")
	],
	fault: "component", bad: "rows=>({reply:(...a)=>reply(rows,...a)})",
	shortcut: "()=>({reply:(...a)=>reply({},...a),post:(...a)=>post({},...a)})", gap: "Reopening duplicated a send",
	smoke: "assert.equal(typeof unit({}).post,'function','missing mobile client');",
	invariant: "assert.equal(typeof unit({}).reply,'function');",
	journey: `const rows={},calls=[];const lose=m=>{calls.push(m);throw Error('ack lost')};
		assert.equal(await unit(rows).reply('a','1','draft body',lose),'unknown');
		const reopened=JSON.parse(JSON.stringify(rows));
		assert.equal(await unit(reopened).reply('a','1','wrong retry body',lose),'unknown');
		assert.equal(await unit(reopened).post('b','1','hello',m=>calls.push(m)),'sent');
		assert.deepEqual(calls.map(m=>[m.account,m.kind,m.text]),[['a','reply','draft body'],['b','post','hello']],'Reopening duplicated a send');
		assert.equal(Object.values(reopened).find(m=>m.account==='a').text,'draft body');`
};
const stock = {
	id: "stock", direction: "Process scanned sales and cancellations. Report remaining stock per SKU without double-counting retried sales or overselling.",
	parts: [
		part("catalog/sku", [], "s=>s.trim().toUpperCase()"),
		part("register/units", [], "n=>Number.isSafeInteger(n)&&n>0?n:0"),
		part("ledger/total", [], "changes=>changes.reduce((a,b)=>a+b,0)"),
		part("catalog/item", ["sku","units"], "(name,n)=>({sku:sku(name),n:units(n)})"),
		part("ledger/balance", ["total"], "(initial,rows,sku)=>initial[sku]+total(Object.values(rows).filter(r=>r.sku===sku&&!r.void).map(r=>-r.n))"),
		part("register/hold", ["item","balance"], `(initial,rows,id,name,n)=>{const line=item(name,n);
			if(!rows[id]&&line.n&&balance(initial,rows,line.sku)>=line.n)rows[id]=line;return rows[id]}`),
		part("register/sale", ["hold"], "(initial,rows,c)=>hold(initial,rows,c.id,c.sku,c.n)"),
		part("ledger/cancel", ["item"], "(rows,c)=>{if(rows[c.id]?.sku===item(c.sku,1).sku)rows[c.id].void=true}"),
		part("audit/closeout", ["balance","sale","cancel"], `(initial,commands)=>{const rows={};
			for(const c of commands){if(c.op==='sale')sale(initial,rows,c);else cancel(rows,c)}
			return Object.fromEntries(Object.keys(initial).map(s=>[s,balance(initial,rows,s)]))}`)
	],
	fault: "product", bad: `(initial,commands)=>{const rows={};for(const c of commands)if(c.op==='sale')sale(initial,rows,c);
		return Object.fromEntries(Object.keys(initial).map(s=>[s,balance(initial,rows,s)]))}`,
	shortcut: `(initial,commands)=>{const rows={};for(const c of commands)if(Object.hasOwn(initial,c.sku)){
		if(c.op==='sale')sale(initial,rows,c);else cancel(rows,c)}return Object.fromEntries(Object.keys(initial).map(s=>[s,balance(initial,rows,s)]))}`,
	gap: "A scanned SKU disappeared from closeout",
	smoke: "assert.deepEqual(unit({P:3},[{op:'sale',id:'s',sku:'P',n:1}]),{P:2});",
	invariant: `const sale={op:'sale',id:'s',sku:'P',n:1};assert.deepEqual(unit({P:3},[sale,{...sale,op:'cancel'}]),{P:3},'cancellation did not restore stock');`,
	journey: `const sale={op:'sale',id:'s',sku:' p ',n:2};assert.deepEqual(unit({P:3,Q:4},[sale,sale,
		{...sale,id:'oversell',n:5},{...sale,op:'cancel',sku:'Q'},{...sale,op:'cancel'},sale,{...sale,id:'q',sku:'q',n:3}]),{P:3,Q:1},'A scanned SKU disappeared from closeout');`
};

const source = ".foundry/policy.json", unitCheck = ".foundry/unit.mjs", productCheck = ".foundry/product.mjs", goalCheck = ".foundry/goal.mjs";
/** @param {typeof outbox} app @param {number|undefined} cap */
function contract(app, cap) {
	const entry = app.parts.at(-1); assert.ok(entry);
	const squads = [...new Set(app.parts.map(p => p.squad))].map(id => ({
		id, areas: [id], charter: `.foundry/${id}.md`, boundary: [".foundry/api.md"], checks: [unitCheck]
	}));
	const load = `import assert from 'node:assert/strict';import {existsSync,writeFileSync} from 'node:fs';import {setTimeout as wait} from 'node:timers/promises';
		const gate=process.env.FOUNDRY_TEST_GATE;if(gate){writeFileSync(gate+'/started','', {flag:'wx'});
			const end=Date.now()+15000;while(!existsSync(gate+'/finish')){assert.ok(Date.now()<end,'gate timed out');await wait(10)}}
		const file=${JSON.stringify(entry.directory + "/index.mjs")};`;
	return {
		[source]: JSON.stringify({ version: 2, id: app.id, direction: app.direction, target: "refs/heads/main", productCheck, goalCheck, squads, ...(cap ? { limits: { workers: cap } } : {}) }),
		".foundry/api.md": app.direction, ...Object.fromEntries(squads.map(s => [s.charter, `Own the ${s.id} implementation for: ${app.direction}`])),
		[unitCheck]: `${load}const unit=(await import('../'+process.env.FOUNDRY_DIRECTORY+'/index.mjs')).default;
			assert.equal(typeof unit,'function');if(process.env.FOUNDRY_DIRECTORY===${JSON.stringify(entry.directory)}){${app.smoke}}`,
		[productCheck]: `${load}const outputs=Object.entries(JSON.parse(process.env.FOUNDRY_OUTPUTS));
			for(const [,dir] of outputs)assert.equal(typeof (await import('../'+dir+'/index.mjs')).default,'function');
			if(existsSync(file)){const unit=(await import('../'+file)).default;try{${app.invariant}}catch(e){
				console.log('FOUNDRY_REPAIR='+outputs.find(([,d])=>file===d+'/index.mjs')[0]);throw e}}`,
		[goalCheck]: `${load}if(!existsSync(file)){console.log(${JSON.stringify(app.direction)});process.exit(1)}
			const unit=(await import('../'+file)).default;${app.journey}`
	};
}

/** Return only after the actual evaluator has started, but before it is allowed to write its receipt.
 * @param {import("node:test").TestContext} t @param {string} cwd @param {string} command */
async function slowCheck(t, cwd, command) {
	const gate = mkdtempSync(path.join(tmpdir(), "foundry-slow-check-"));
	t.after(() => rmSync(gate, { recursive: true, force: true }));
	const child = promisify(execFile)("/bin/sh", ["-c", command], { cwd, env: { ...process.env, FOUNDRY_TEST_GATE: gate }, timeout: 30000 });
	const started = async () => {
		const end = Date.now() + 15000;
		while (!existsSync(path.join(gate, "started"))) { assert.ok(Date.now() < end, "runner did not start"); await wait(10); }
	};
	await Promise.race([started(), child.then(() => assert.fail("runner exited before release"))]);
	return async () => { put(gate, "finish", ""); await child; };
}

for (const app of [outbox, stock]) for (const delivery of ["inline", "later", "no receipt", "replan", ...(app === stock ? ["notice unconfirmed"] : [])]) {
	const replan = delivery === "replan";
	test(`long factory: ${app.id} / late ${replan ? "goal" : app.fault} failure / ${delivery}`, async t => {
		const run = app.id, cap = app === stock ? 2 : undefined, f = factory(t, run, source, contract(app, cap));
		const last = app.parts.at(-1); assert.ok(last);
		const parts = new Map(app.parts.map(p => [p.id, p]));
		/** @type {Map<string,number>} */ const attempted = new Map();
		const handled = new Set();
		/** @type {Awaited<ReturnType<typeof f.status>>["nodes"][number]|undefined} */ let originalWriter;
		/** @type {NonNullable<Awaited<ReturnType<typeof f.status>>["products"]>} */ let beforeFault = [];
		let peak = 0, withheld = false, notices = 0;
		await f.start(); // No later owner turns or starts to propel the factory.
		for (let event = f.inbox.shift(); event; event = f.inbox.shift()) {
			const { worker, token } = event, w = f.workers.get(worker); assert.ok(w);
			assert.ok(!handled.has(token) && handled.size < 60, "duplicate dispatch or unbounded rework"); handled.add(token);
			const state = await f.status(worker), review = state.reviews.find(r => r.token === token);
			if (review) {
				if (review.state === "blocked") {
					assert.ok(!state.active && (await f.status()).qualified, "only an accepted product can obsolete a delivered, unread scout here");
					continue;
				}
				assert.equal(review.state, "reading");
				const present = (/** @type {string} */ id) => existsSync(path.join(w.cwd, parts.get(id)?.directory ?? assert.fail(id), "index.mjs"));
				const next = app.parts.filter(p => p.squad === review.squad && !present(p.id) && p.needs.every(present));
				if (replan && review.squad === last.squad && present(last.id) && w.prompt.includes(app.gap)) {
					const gap = await f.status();
					assert.equal(gap.qualified, null); assert.equal(gap.products?.length, beforeFault.length + 1);
					assert.equal(gap.goal?.receipt?.exit, 1); assert.equal(gap.checkpoint, review.base);
					next.push(last); // An observed user journey failed despite a passing integration milestone.
				}
				await f.runtime(w.cwd).operation("observe", { run, token, outcome: next.length ? "regenerate" : "no-gap", reason: "Implement missing behavior using the available interfaces",
					evidence: [`.foundry/${review.squad}.md`], grains: next.map(p => ({ id: p.id, task: `Implement ${p.id} for ${app.direction}`, directory: p.directory, needs: p.needs, check: unitCheck })) }, worker);
				continue;
			}
			const n = state.nodes.find(n => n.token === token && n.state === "writing"); assert.ok(n, "a delivered assignment must be writable");
			const p = parts.get(n.grain); assert.ok(p);
			const s = await f.status(); peak = Math.max(peak, s.nodes.filter(n => n.state === "writing").length);
			const count = attempted.get(p.id) ?? 0; attempted.set(p.id, count + 1);
			const broken = p === last && count === 0;
			if (broken) {
				originalWriter = n;
				assert.ok(s.products && s.products.length >= 4, "inject the failure only after at least four checked milestones");
				assert.ok(s.products.every(p => p.receipt?.commit === p.commit && p.receipt.exit === 0));
				beforeFault = s.products;
				assert.equal(s.qualified, null);
				assert.ok(s.goal?.receipt?.exit === 1 && s.goal.receipt.commit === s.checkpoint);
			} else if (p === last) {
				assert.ok(originalWriter);
				if (replan) { assert.notEqual(n.worker, originalWriter.worker); assert.equal(n.repairs, 0); }
				else {
					assert.equal(n.worker, originalWriter.worker); assert.equal(n.generation, originalWriter.generation);
					assert.equal(n.repairs, 1);
				}
				assert.deepEqual(n.inputs, originalWriter.inputs);
			}
			const imports = p.needs.map(id => {
				const dep = parts.get(id); assert.ok(dep);
				assert.equal(n.inputs?.[id], s.outputs?.[id]);
				return `import ${id} from './${path.relative(p.directory, dep.directory)}/index.mjs';`;
			});
			put(w.cwd, `${p.directory}/index.mjs`, [...imports, `export default ${broken ? (replan ? app.shortcut : app.bad) : p.body};`].join("\n"));
			let shell = "";
			/** @type {(()=>Promise<void>)|undefined} */ let finish;
			const r = f.runtime(w.cwd, { execute: async (...args) => {
				if (broken && !replan && args[0] === "bash" && String(args[1].description).startsWith(`Check ${app.fault === "component" ? last.id : "joined product"} at `)) {
					shell = String(args[1].shellId);
					if (delivery === "inline") {
						const duplicate = await r.operation("submit", { run, token }, worker);
						assert.ok(!duplicate.nodes.some(n => n.worker === worker && n.state === "writing"));
						const result = await f.execute(...args);
						r.turn(worker, shell); await r.flush(); // Completion races the still-open submit response.
						return result;
					}
					assert.ok(!withheld, "never reissue the late check"); withheld = true;
					if (delivery !== "no receipt") finish = await slowCheck(t, w.cwd, String(args[1].command));
					return { resultType: "unconfirmed" }; // No completion verdict in this native reply.
				}
				return f.execute(...args);
			} });
			const reply = await r.operation("submit", { run, token }, worker);
			const inline = reply.nodes.find(a => a.worker === worker && a.state === "writing" && a.token !== token);
			if (inline?.token) f.inbox.push({ worker, token: inline.token }); // Only a token actually returned to this submitter.
			r.close();
			if (broken && !replan && delivery !== "inline") {
				assert.ok(!inline);
				const delivered = [...f.inbox]; // An unrelated scout may still be reading when the product check starts.
				assert.ok(delivered.every(d => s.reviews.some(r => r.worker === d.worker)));
				await finish?.();
				const reopened = f.runtime(w.cwd, delivery === "notice unconfirmed" ? { remind: async () => { notices++; throw Error("No queue admission receipt"); } } : {});
				reopened.turn(worker, "foundry-00000000-0000-0000-0000-000000000000"); await reopened.flush();
				assert.deepEqual(f.inbox, delivered, "unrelated completion is not a Foundry wakeup");
				reopened.turn(worker, shell); reopened.turn(worker, shell); await reopened.flush();
				const held = await f.status();
				assert.deepEqual(held.products, s.products, "a late failure cannot erase or advance a checkpoint");
				assert.equal(held.qualified, null);
				if (delivery === "no receipt") {
					assert.deepEqual(f.inbox, delivered); assert.ok(held.pending.some(e => e.kind === app.fault && ["uncertain","issued"].includes(e.state)));
				} else if (delivery === "notice unconfirmed") {
					reopened.close(); const again = f.runtime(w.cwd, { remind: async () => { notices++; return "duplicate"; } });
					again.turn(worker); await again.flush(); assert.equal(notices, 1);
					assert.ok(held.pending.some(e => e.kind === "repair" && e.state === "uncertain"));
				}
			}
		}
		const done = await f.status();
		assert.equal(withheld, !replan && delivery !== "inline"); assert.equal(git(f.root, "rev-parse", "main"), f.tip);
		assert.deepEqual([...attempted.keys()].sort(), [...parts.keys()].sort());
		for (const [id, count] of attempted) if (id !== last.id) assert.equal(count, 1, `do not rebuild ${id}`);
		assert.ok(beforeFault.length && done.products);
		assert.deepEqual(done.products.slice(0, beforeFault.length), beforeFault);
		if (delivery === "no receipt" || delivery === "notice unconfirmed") {
			assert.equal(done.products.length, beforeFault.length); assert.equal(attempted.get(last.id), 1); assert.equal(done.qualified, null); return;
		}
		assert.ok(done.qualified, `Factory drained after ${done.products?.length} checkpoints: ${done.blocker ?? JSON.stringify(done.nodes.filter(n => n.state === "writing").map(n => [n.grain,n.state,n.repairs]))}`);
		assert.equal(attempted.get(last.id), 2); assert.equal(done.products.length - beforeFault.length, replan ? 2 : 1);
		assert.equal(done.products.at(-1)?.receipt?.commit, done.qualified); assert.equal(done.goal?.receipt?.commit, done.qualified);
		assert.ok(peak >= 2); if (cap) assert.ok(peak <= cap);
	});
}
