import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "./database.mjs";
import { handoff, qualification } from "./handoff.mjs";
import { archiveCheck } from "../../../skills/foundry/scripts/archive-check.mjs";
import { status } from "./status.mjs";
import { factory, git, put } from "../test/fixture.mjs";
import { installTools } from "../test/install.mjs";
import { guideReplay, launchPlan, launchStep, recipient as transferTo } from "../test/portable.mjs";
import { createRuntime } from "./runtime.mjs";

const run = "pages", source = ".foundry/pages.json", component = ".foundry/component.mjs", productCheck = ".foundry/product.mjs", goalCheck = ".foundry/goal.mjs";
const script = fileURLToPath(new URL("../../../skills/foundry/scripts/archive-check.mjs", import.meta.url));
const transfer = fileURLToPath(new URL("../../../skills/foundry/scripts/qualification.mjs", import.meta.url));
const ids = ["cover", "tables", "reader"];
const invariant = `import {readFileSync} from 'node:fs'; for(const id of ${JSON.stringify(ids)})
	if(readFileSync('lib/'+id+'/value','utf8')!==id) throw Error(id);`;
const goalProgram = `${invariant}\nif(!readFileSync('lib/cover/extra.ignored','utf8').includes('kept in the capture')) throw Error('cover missing');`;
const trace=`if(process.env.FOUNDRY_TEST_HANDOFF_NOTE)console.log(process.env.FOUNDRY_TEST_HANDOFF_NOTE);`;

/** Native transport only is faked. Use the actual dispatcher, captures, evaluator receipts and joined tree.
 * @param {import("node:test").TestContext} t @param {boolean} goal @param {boolean} [pair] */
async function qualify(t, goal, pair = false) {
	const grains = ids.map(id => ({ id, directory: `lib/${id}`, check: component, needs: id === "reader" ? ["tables"] : [] }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ id: run, direction: "Build the complete reader", target: "refs/heads/main", productCheck, ...(goal
			? { version: 2, goalCheck, squads: [{ id: "pages", charter: "brief", areas: ["lib"], boundary: ["api"], checks: [component] }] }
			: { version: 1, seed: ["cover", "reader"], squads: [{ id: "pages", charter: "brief", grains: ids }],
				grains: grains.map(g => ({ ...g, specification: "brief", boundary: ["api"] })) }) }),
		brief: "Build the reader", api: "Export value", ".gitignore": "*.ignored\n", "lib/cover/obsolete": "old cover",
		[component]: `import {readFileSync} from 'node:fs'; for(const dir of JSON.parse(process.env.FOUNDRY_DIRECTORIES))
			if(readFileSync(dir+'/value','utf8')!==process.env.FOUNDRY_GRAIN) throw Error('wrong value');${trace}`,
		[productCheck]: invariant+trace, [goalCheck]: goalProgram+trace,
	});
	const read = () => {
		const db = openDatabase(f.root);
		try { const state = db.read(run); assert.ok(state); return state; } finally { db.close(); }
	};
	await f.start();
	if (goal) await f.scouts[0].report({ outcome: "regenerate", reason: "Complete the missing pages", evidence: ["brief"],
		grains: grains.map(g => ({ ...g, directory:pair && g.id==="cover" ? [g.directory,"lib/illustrations"] : g.directory, task: `Render the ${g.id} page` })) });
	assert.equal(handoff(read()), null);
	let checkpoint;
	for (const id of ids) {
		const n = read().nodes[id], w = f.workers.get(n.worker ?? ""); assert.ok(w);
		if (id === "cover") {
			if (pair) put(w.cwd,"lib/illustrations/value",id);
			if (!goal) git(w.cwd, "switch", "-qc", "native-cover");
			put(w.cwd, "lib/cover/extra.ignored", "kept in the capture, despite .gitignore\n");
		}
		put(w.cwd, `lib/${id}/value`, id);
		const writer = f.runtime(w.cwd, { execute: async (...args) => {
			if (args[0] === "bash" && String(args[1].description).startsWith("Check final goal")) {
				const at = read(), milestone = at.products.at(-1); checkpoint = milestone?.commit;
				assert.ok(checkpoint && milestone?.qualifiedAt === undefined); assert.equal(handoff(at), null, "a checked milestone alone is not the goal");
				assert.equal(qualification(at), null);
			}
			return f.execute(...args);
		} });
		await writer.operation("submit", { run, token: w.token }, w.id);
		if (id === "cover") {
			assert.equal(read().nodes.cover.state, "published");
			assert.equal(handoff(read()), null, "component pass is not a product");
			assert.equal(qualification(read()), null);
		}
	}
	/** @param {string} detail @param {string} [actor] */
	const details = (detail, actor = "owner") => f.owner.operation("status", { run, detail }, actor);
	const state = read(), ownerStatus = await f.status(), h = (await details("cleanup")).handoff;
	assert.ok(h?.writers && h.commit === ownerStatus.qualified);
	assert.deepEqual(ownerStatus.handoff, { mode: goal ? "goal" : "one-off", commit: h.commit, target: h.target, targetRef: h.targetRef });
	assert.deepEqual(h, handoff(state, true));
	assert.ok(!("qualification" in ownerStatus) && ownerStatus.metrics && !("history" in ownerStatus.metrics));
	assert.ok("history" in ((await details("usage")).metrics ?? {}));
	if (goal) assert.equal(h.commit, checkpoint);
	assert.deepEqual(h.writers.map(w => w.grain), ["cover"]); // tables created reader during submit; neither is an owner leaf.
	const [w] = h.writers, root = realpathSync(f.root), writer = realpathSync(f.workers.get(w.id)?.cwd ?? assert.fail("missing native worktree"));
	assert.ok(!("handoff" in await f.status(w.id)), "writer status is not the owner handoff");
	for (const detail of ["proof", "cleanup", "usage"]) await assert.rejects(details(detail, w.id), { code: "foreign_run" });
	const native = { caller: "owner", coordinator: "owner", id: w.id, name: w.name, workspace: "local-worktree", path: writer,
		branch: goal ? null : "refs/heads/native-cover", activity: "idle", ongoingWork: false, openPR: false, agentMerge: false,
		automation: false, nestedWork: false, externalWork: false };
	return { state, read, details, h, w, root, writer, native };
}

test("cleanup rechecks every root in the selected qualified writer capture", async t => {
	const {h,native,root,writer} = await qualify(t,true,true);
	const {offer} = archiveCheck(root,"offer",{handoff:h,native}); assert.ok(offer);
	assert.deepEqual(offer.directory,["lib/cover","lib/illustrations"]);
	const input = {handoff:h,native,selected:offer};
	assert.deepEqual(archiveCheck(root,"recheck",input),{tool:"archive_session",arguments:{id:native.id}});
	assert.throws(()=>archiveCheck(root,"recheck",{...input,selected:{...offer,directory:"lib/cover"}}),/Selection/);
	put(writer,"lib/illustrations/value","private change");
	assert.throws(()=>archiveCheck(root,"recheck",input),/changed/i);
	put(writer,"lib/illustrations/value","cover"); put(writer,"lib/neighbor/private","unrelated");
	assert.throws(()=>archiveCheck(root,"recheck",input),/Unexpected path/);
});

test("goal: only the accepted exact product reaches the owner; no inferred authority over delegated work", async t => {
	const note=randomUUID(),prior=process.env.FOUNDRY_TEST_HANDOFF_NOTE;
	process.env.FOUNDRY_TEST_HANDOFF_NOTE=note;
	t.after(()=>{if(prior===undefined)delete process.env.FOUNDRY_TEST_HANDOFF_NOTE;else process.env.FOUNDRY_TEST_HANDOFF_NOTE=prior;});
	const { state, h, root, native, details } = await qualify(t, true);
	assert.equal(h.commit, state.goal?.commit);
	assert.ok(archiveCheck(root, "offer", { handoff: h, native }).offer, "detached native leaf can be checked");
	const proof = (await details("proof")).qualification;
	const db=openDatabase(root);t.after(()=>db.close());
	const inspect=(/** @type {typeof state} */ r)=>qualification(r,{cwd:root,verify:e=>db.verifySigned(run,e)});
	assert.ok(proof); assert.deepEqual(proof, inspect(state));
	const manifest=JSON.stringify(proof),ids=[state.nodes.reader.check,state.products.at(-1)?.check,state.goal?.check];
	for(const id of ids){
		const c=state.effects.find(e=>e.id===id);
		assert.ok(c?.tool==="bash" && c.callId && c.receipt?.output.includes(note));db.verifySigned(run,c);
		assert.ok(!manifest.includes(note),"signed diagnostic leaked into the portable manifest");
		assert.ok(!manifest.includes(JSON.stringify(c.issuer)),"native issuer leaked into the portable manifest");
		assert.ok(!manifest.includes(c.callId),"native call ID leaked into the portable manifest");
	}
	const grant=state.effects.find(e=>e.kind==="writer" && e.nativeId===native.id);
	assert.ok(grant?.token);assert.ok(!manifest.includes(grant.token),"writer token leaked into the portable manifest");
	for(const [kind,check] of /** @type {const} */ ([["product",productCheck],["goal",goalCheck]])){
		/** @type {ReturnType<typeof import("./portable.mjs").portableReceipt>} */ const r=proof.receipts[kind];
		assert.deepEqual([r.commit,r.check,r.exit],[h.commit,check,0]);
		assert.equal(r.inputEvidence,"signed");assert.equal(r.inputs.checker.blob,git(root,"rev-parse",`${r.commit}:${check}`));
	}
	const reader = proof.outputs.find(o => o.id === "reader"), n = state.nodes.reader;
	assert.ok(reader);const {inputs:verified,inputEvidence,disclosure,...observed}=reader.receipt;
	assert.equal(disclosure.overlay.length,0);
	assert.equal(inputEvidence,"signed");assert.deepEqual(verified.scope,{kind:"component",grain:"reader",directories:["lib/reader"],files:[]});
	assert.deepEqual({...reader,receipt:observed}, { id: "reader", directory: "lib/reader", commit: n.candidate, behavior: "Render the reader page",
		specification: "brief", squad: "pages", charter: "brief", boundary: ["api"], receipt: { commit: n.candidate, check: component, exit: 0 },
		base: n.base, generation: n.generation, needs: ["tables"], inputs: { tables: state.nodes.tables.candidate } });
	const privateState = structuredClone(state);
	const wrongCommand=structuredClone(state),check=wrongCommand.effects.find(e=>e.id===state.goal?.check);assert.ok(check);
	check.args={command:"not the original native request"};
	assert.equal(inspect(wrongCommand),null,"the verifier requires the signed original; the report does not disclose its native arguments");
	for (const e of privateState.effects) {
		if(e.tool!=="bash")e.args = { kickoff: { prompt: "private prompt" } };
		if (e.kind === "scout") e.decision = { status: "answered", answer: "private answer" };
	}
	for (const n of Object.values(privateState.nodes)) { n.worker = "private writer"; n.token = "private token"; }
	assert.deepEqual(inspect(privateState), proof);
	const changed=structuredClone(state), signed=changed.effects.find(e=>e.id===changed.nodes.reader.check)?.receipt;assert.ok(signed?.inputs);
	signed.inputs.scope={kind:"component",grain:"reader",directories:["lib/other"],files:[]};
	assert.equal(inspect(changed),null,"a modified signed input is not a portable proof");
	let kickoffReads = 0;
	for (const e of privateState.effects.filter(e => e.kind === "writer")) Object.defineProperty(e.args, "kickoff", {
		get() { kickoffReads++; return { prompt: "private prompt" }; },
	});
	status(privateState, state.owner); status(privateState, state.owner, "proof");
	assert.equal(kickoffReads, 0, "an ordinary status or proof must not reconstruct usage");
	status(privateState, state.owner, "usage"); assert.ok(kickoffReads > 0);
	for (const kind of ["goal", "product", "component"]) {
		const copy = structuredClone(state);
		const id = kind === "goal" ? copy.goal?.check : kind === "product" ? copy.products.at(-1)?.check : copy.nodes.cover.check;
		const e = copy.effects.find(e => e.id === id); assert.ok(e?.receipt);
		e.receipt.commit = h.target; // Exit 0 on another commit attests to nothing here.
		assert.equal(inspect(copy), null);
		if (kind === "component") assert.deepEqual(handoff(copy, true)?.writers, []);
		else assert.equal(handoff(copy), null);
		e.receipt.commit = e.commit ?? assert.fail("missing check commit");
		delete e.runnerStarted;
		assert.equal(inspect(copy), null, "native success without a runner receipt");
		e.runnerStarted = true; e.receipt.exit = 2;
		assert.equal(inspect(copy), null, "missing external observation is never a pass");
	}
	const stale = structuredClone(state);
	stale.nodes.reader.inputs = {};
	assert.equal(inspect(stale), null, "never guess missing assignment pins");
	stale.nodes.reader.inputs = n.inputs;
	stale.nodes.reader.candidate = h.target;
	assert.equal(inspect(stale), null, "never describe a different output version under the same grain name");
	const copy = structuredClone(state);
	assert.ok(copy.goal); copy.goal.target = h.commit;
	assert.equal(inspect(copy), null, "same commit but another target assessment");
	copy.goal.target = h.target;
	const created = copy.effects.find(e => e.nativeId === native.id); assert.ok(created);
	created.state = "uncertain";
	assert.deepEqual(handoff(copy, true)?.writers, []);
});

test("a goal already met on a different target tip exports both exact baseline receipts without a writer", async t => {
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Build the complete reader", target: "refs/heads/main", productCheck, goalCheck,
			squads: [{ id: "pages", charter: "brief", grains: ["reader"] }],
			grains: [{ id: "reader", directory: "lib/reader", specification: "brief", boundary: ["api"], check: component }] }),
		brief: "Build the reader", api: "Export value", [component]: "", [productCheck]: "", [goalCheck]: "",
	});
	git(f.root, "switch", "-qc", "author"); put(f.root, "unrelated", "newer than the target"); git(f.root, "add", "unrelated");
	git(f.root, "commit", "-qm", "unrelated author change");
	await f.start();
	const { qualification: p } = await f.owner.operation("status", { run, detail: "proof" }, "owner");
	assert.ok(p); assert.equal(p.commit, f.tip); assert.deepEqual(p.target, { ref: "refs/heads/main", commit: f.tip });
	assert.deepEqual(p.contract, { path: source, commit: git(f.root, "rev-parse", "HEAD"), version: 1 });
	assert.notEqual(p.contract.commit, p.target.commit); assert.deepEqual(p.outputs, []); assert.equal(f.workers.size, 0);
	assert.equal(p.receipts.product.commit, p.commit); assert.equal(p.receipts.goal.commit, p.commit);
});

test("v5 discloses effective trees only and rejects an unadvertised packed object before adoption",async t=>{
	const previous=process.env.FOUNDRY_CARRIER_BEFORE;
	/** @type {typeof factory} */ const make=previous?(await import(path.join(previous,"test/fixture.mjs"))).factory:factory;
	const ancestor="private-ancestor",outside="unselected-source",f=make(t,run,source,{
		[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Check the current export.",productCheck,goalCheck,
			squads:[{id:"pages",charter:"brief",grains:["reader"]}],grains:[{id:"reader",directory:"lib/reader",specification:"brief",boundary:["api"],check:component}]}),
		brief:"Read the checked tree.",api:"Observe its files.",[component]:"",[productCheck]:"",[goalCheck]:"",[ancestor]:randomUUID()});
	const home=realpathSync(path.dirname(f.root)),trace=path.join(home,"actual-evaluations"),log=`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(trace)},`;
	const trigger=path.join(home,"contaminate-next-goal");
	put(f.root,productCheck,log+`"product\\n");import {existsSync,readFileSync,writeFileSync} from "node:fs";
		if(existsSync(${JSON.stringify(trigger)}))writeFileSync(readFileSync(${JSON.stringify(trigger)},"utf8"),"prior product output");`);
	put(f.root,goalCheck,log+`"goal\\n");process.exit(2);`);
	const oldBlob=git(f.root,"rev-parse",`HEAD:${ancestor}`);put(f.root,ancestor,"public replacement\n");git(f.root,"commit","-qam","Replace ancestor bytes and freeze checks");
	const target=git(f.root,"rev-parse","HEAD");git(f.root,"switch","-qc","contract");put(f.root,outside,randomUUID());
	git(f.root,"add",outside);git(f.root,"commit","-qm","Provide the original contract, not this extra file");
	const excluded=git(f.root,"rev-parse",`HEAD:${outside}`),from=git(f.root,"rev-parse","HEAD");await f.start();
	put(f.root,goalCheck,log+`"goal\\n");import {lstatSync} from "node:fs";const st=lstatSync(process.env.FOUNDRY_GOAL_FEEDBACK_FILE);
		if(!st.isFile() || st.size!==0 || st.nlink!==1 || st.uid!==process.getuid() || (st.mode&0o777)!==0o600)throw Error("Goal did not receive fresh private output");`);
	git(f.root,"commit","-qam","Make the selected goal observation available");
	const pin=git(f.root,"rev-parse","HEAD"),owner=f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("repin",{run,from,revision:pin,files:[goalCheck]},"owner");await owner.flush();
	const original=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(original);
	const db=openDatabase(f.root);t.after(()=>db.close());const saved=db.read(run),issued=f.checks.slice();owner.close();f.owner.close();
	const current=f.runtime(f.root,{execute:async()=>assert.fail("Proof inspection may not dispatch")},createRuntime);
	const proof=current.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof);assert.equal(proof.commit,target);
	const priorTrace=readFileSync(trace,"utf8"),bundle=path.join(home,"replay.bundle");
	const cli=(/** @type {string} */ cwd,/** @type {string[]} */ args,script=transfer,manifest=proof)=>spawnSync(process.execPath,[script,...args],{cwd,input:JSON.stringify(manifest),encoding:"utf8"});
	const bare=(/** @type {string} */ name)=>{const d=path.join(home,name);git(f.root,"init","-q","--object-format="+git(f.root,"rev-parse","--show-object-format"),d);return d;};
	if(previous){
		assert.ok(!original.receipts.goal.disclosure);assert.match(cli(f.root,["pack",bundle],transfer,original).stderr,/fresh owner proof/);
	}
	const packed=cli(f.root,["pack",bundle]);assert.equal(packed.status,0,packed.stderr);
	const refFile=path.join(f.root,".git/refs/heads/not-a-bundle");assert.notEqual(cli(f.root,["pack",refFile]).status,0);assert.ok(!existsSync(refFile));
	const inspect=bare("inventory");git(inspect,"bundle","unbundle",bundle);
	const all=git(inspect,"cat-file","--batch-all-objects","--batch-check=%(objectname)").split("\n");
	assert.ok(!all.includes(oldBlob),"replay disclosed an ancestor-only blob");
	assert.ok(all.includes(git(f.root,"rev-parse",`${target}:${ancestor}`)),"only the current version of the path is needed");
	assert.ok(!all.includes(excluded),"replay disclosed an out-of-scope blob from the activation commit");
	assert.equal(git(f.root,"rev-parse",`${pin}:${outside}`),excluded,"marker really exists in the selected overlay source");
	assert.ok(![target,proof.contract.commit,pin].some(id=>all.includes(id)),"provenance is not a replay head");
	assert.ok(all.includes(proof.receipts.goal.inputs.checker.blob),"the selected off-target goal bytes are required");
	assert.equal(proof.receipts.product.disclosure.subject.tree,git(f.root,"rev-parse",`${target}^{tree}`),"unchanged complete snapshots retain their tree identity");
	for(const line of git(inspect,"bundle","list-heads",bundle).split("\n")){
		const [id]=line.split(" ");assert.equal(git(inspect,"rev-list","--parents","-1",id),id,"only parentless carriers");
	}
	const extra=execFileSync("git",["-C",inspect,"hash-object","-w","--stdin"],{input:randomUUID(),encoding:"utf8"}).trim();
	const hidden=path.join(home,"unadvertised.bundle"),raw=readFileSync(bundle),end=raw.indexOf("\n\n")+2;assert.ok(end>1);
	const payload=execFileSync("git",["-C",inspect,"pack-objects","--stdout"],{input:[...all,extra].join("\n")+"\n"});
	writeFileSync(hidden,Buffer.concat([raw.subarray(0,end),payload]));
	assert.equal(git(inspect,"bundle","list-heads",bundle),git(inspect,"bundle","list-heads",hidden));
	const recipient=bare("isolated"),bad=cli(recipient,["import",hidden]);assert.notEqual(bad.status,0);assert.match(bad.stderr,/inventory|undisclosed/);
	const truncated=path.join(home,"missing-input.bundle"),remaining=all.filter(id=>id!==proof.receipts.goal.inputs.checker.blob);
	writeFileSync(truncated,Buffer.concat([raw.subarray(0,end),execFileSync("git",["-C",inspect,"pack-objects","--stdout"],{input:remaining.join("\n")+"\n"})]));
	assert.notEqual(cli(recipient,["import",truncated]).status,0,"a complete external ref list cannot replace missing checker bytes");
	const seeded=bare("already-has-blob"),required=proof.receipts.goal.inputs.checker.blob;
	assert.equal(execFileSync("git",["-C",seeded,"hash-object","-w","--stdin"],{input:execFileSync("git",["-C",inspect,"cat-file","blob",required]),encoding:"utf8"}).trim(),required);
	assert.notEqual(cli(seeded,["import",truncated]).status,0,"recipient objects cannot mask an incomplete transfer");
	assert.equal(git(seeded,"cat-file","--batch-all-objects","--batch-check=%(objectname)"),required);
	const surplus=path.join(home,"trailing.bundle");writeFileSync(surplus,Buffer.concat([raw,Buffer.from("undisclosed trailing payload")]));
	assert.notEqual(cli(recipient,["import",surplus]).status,0);
	const changed=structuredClone(proof);changed.receipts.goal.inputs.checker.mode="100755";
	assert.notEqual(cli(recipient,["import",bundle],transfer,changed).status,0,"a real carrier is not an observation at a different mode");
	const foreign=structuredClone(proof);foreign.receipts.goal.inputs.overlay={revision:from,paths:[goalCheck]};foreign.receipts.goal.evaluatorRevision=from;
	assert.notEqual(cli(recipient,["import",bundle],transfer,foreign).status,0,"the same blob cannot relabel a carrier's source");
	assert.equal(git(recipient,"cat-file","--batch-all-objects","--batch-check=%(objectname)"),"","invalid pack never touches recipient objects");
	const helper=installTools(path.join(home,"offline-tools"));
	const idle=spawnSync(process.execPath,["--input-type=module","-e",`await import(${JSON.stringify(pathToFileURL(helper).href)})`],{cwd:path.dirname(helper),encoding:"utf8"});
	assert.deepEqual([idle.status,idle.stdout,idle.stderr],[0,"",""],"loading only the distributed scripts is inert even outside a repository");
	const good=cli(recipient,["import",bundle],helper);assert.equal(good.status,0,good.stderr);
	await t.test("a CLI without import.meta.main fails explicitly instead of reporting success",()=>{
		// Load the distributed CLI bytes unchanged with an older Node import.meta shape.
		const loader=`import {readFileSync} from "node:fs";import {pathToFileURL} from "node:url";
import {SourceTextModule,SyntheticModule} from "node:vm";
const url=pathToFileURL(process.argv[1]);
const m=new SourceTextModule(readFileSync(url,"utf8"),{identifier:url.href,initializeImportMeta(meta){meta.url=url.href;}});
await m.link(async spec=>{const ns=await import(new URL(spec,url));return new SyntheticModule(Object.keys(ns),function(){for(const k of Object.keys(ns))this.setExport(k,ns[k]);});});
await m.evaluate();`;
		const result=spawnSync(process.execPath,["--no-warnings","--experimental-vm-modules","--input-type=module","-e",loader,helper,"import",bundle],
			{cwd:recipient,input:JSON.stringify(proof),encoding:"utf8"});
		assert.notEqual(result.status,0,"missing entrypoint support cannot silently skip the requested command");
		assert.match(result.stderr,/22\.18\.0.*24\.2\.0/);
	});
	await t.test("materialization requires a private parent outside Git and ambient package contexts",()=>{
		const linked=path.join(home,"linked"),nested=path.join(recipient,"nested"),bare=path.join(home,"separate-admin");
		git(f.root,"worktree","add","-q","--detach",linked,target);git(f.root,"init","-q",nested);git(f.root,"init","--bare","-q",bare);
		const parents=[recipient,f.root,linked,nested,bare].map(root=>{const dir=path.join(root,"private-stage");mkdirSync(dir,{mode:0o700});return dir;});
		const shared=path.join(home,"shared-stage"),pkg=path.join(home,"package-stage"),deps=path.join(home,"dependency-stage"),alias=path.join(home,"stage-alias");
		mkdirSync(shared,{mode:0o755});chmodSync(shared,0o755);mkdirSync(pkg,{mode:0o700});put(pkg,"package.json","{}");
		mkdirSync(deps,{mode:0o700});mkdirSync(path.join(deps,"node_modules"));
		symlinkSync(home,alias,"dir");
		const accepted=[];
		for(const parent of [...parents,shared,pkg,deps,alias]){
			const dest=path.join(parent,"not-a-launch"),r=cli(recipient,["materialize","release",dest],helper);
			if(r.status===0 || existsSync(dest))accepted.push(parent);
		}
		assert.deepEqual(accepted,[],"no worktree, Git admin, shared, package or aliased context may acquire a materialization");
	});
	assert.notEqual(cli(recipient,["import",bundle],helper).status,0,"never replace existing replay refs");
	const badDest=path.join(recipient,".git/refs/heads/not-a-plan");assert.notEqual(cli(recipient,["materialize","release",badDest],helper).status,0);assert.ok(!existsSync(badDest));
	const historyFile=path.join(home,"explicit-history.bundle"),historical=bare("deliberate-history");
	const hp=cli(f.root,["pack","--history",historyFile],helper);assert.equal(hp.status,0,hp.stderr);assert.match(hp.stderr,/reachable history/);
	const hi=cli(historical,["import","--history",historyFile],helper);assert.equal(hi.status,0,hi.stderr);
	for(const marker of [oldBlob,excluded])assert.equal(git(historical,"cat-file","-t",marker),"blob","the separate history request discloses ancestry");
	assert.notEqual(cli(historical,["materialize","goal",path.join(home,"no-fallback")],helper).status,0,"history is never a replay fallback");
	assert.equal(readFileSync(trace,"utf8"),priorTrace,"pack and import did not run a checker");
	await t.test("rematerialize obsolete launch descriptions without executing them",()=>{
		const priorCLI=process.env.FOUNDRY_REPLAY_BEFORE;
		const older=priorCLI?cli(recipient,["materialize","release",path.join(home,"original-launch")],priorCLI):undefined;
		if(older){assert.equal(older.status,0,older.stderr);assert.equal(JSON.parse(older.stdout).format,"foundry-launch/v1");}
		const obsolete=guideReplay(recipient,older?.stdout??JSON.stringify({format:"foundry-launch/v1",steps:[]}));
		assert.notEqual(obsolete.status,0);assert.match(obsolete.stderr,/rematerialize/i);assert.equal(readFileSync(trace,"utf8"),priorTrace);
	});
	const beforeReplay=readFileSync(trace,"utf8");
	const dest=path.join(home,"launch"),materialized=cli(recipient,["materialize","release",dest],helper);assert.equal(materialized.status,0,materialized.stderr);
	/** @type {{steps:import("../../../skills/foundry/scripts/materialize.mjs").Step[]}} */ const plan=JSON.parse(materialized.stdout);
	assert.deepEqual(plan.steps.filter(s=>s.kind==="check").map(s=>s.role),["product","goal"]);
	assert.notEqual(cli(recipient,["materialize","release",dest],helper).status,0,"never overwrite an earlier materialization");
	assert.equal(readFileSync(trace,"utf8"),beforeReplay,"materialization did not run a checker");
	const changedFile=path.join(plan.steps.find(s=>s.role==="goal" && s.kind==="check")?.cwd??assert.fail(),goalCheck);
	chmodSync(changedFile,0o755);assert.notEqual(launchStep(plan.steps.find(s=>s.role==="goal" && s.kind==="verify")??assert.fail()).status,0);
	chmodSync(changedFile,0o644);
	const replay=guideReplay(recipient,materialized.stdout);assert.equal(replay.status,0,replay.stderr);
	assert.equal(readFileSync(trace,"utf8"),beforeReplay+"product\ngoal\n");assert.deepEqual(db.read(run),saved);assert.deepEqual(f.checks,issued);
	await t.test("a preceding product cannot prepopulate the next goal's feedback output",()=>{
		const r=cli(recipient,["materialize","release",path.join(home,"contaminated")],helper);assert.equal(r.status,0,r.stderr);
		/** @type {typeof plan} */ const next=JSON.parse(r.stdout);const feedback=next.steps.find(s=>s.kind==="check" && s.role==="goal")?.env.FOUNDRY_GOAL_FEEDBACK_FILE;
		assert.ok(feedback);const before=readFileSync(trace,"utf8");writeFileSync(trigger,feedback);
		const result=guideReplay(recipient,r.stdout);rmSync(trigger);
		assert.equal(readFileSync(trace,"utf8"),before+"product\n","the goal must not launch with a contaminated binding");
		assert.notEqual(result.status,0,"goal received private output from a previous step");
		assert.match(result.stderr,/feedback/i);
		assert.equal(readFileSync(feedback,"utf8"),"prior product output","do not truncate stale data to make a dirty replay pass");
	});
	await t.test("an existing linked, shared, or even empty goal output is never adopted",()=>{
		const target=path.join(home,"unrelated-private-file");writeFileSync(target,"",{mode:0o600});
		const admitted=[];
		for(const variant of ["hardlink","symlink","shared","empty"]){
			const r=cli(recipient,["materialize","goal",path.join(home,"reserved-"+variant)],helper);assert.equal(r.status,0,r.stderr);
			/** @type {typeof plan} */ const next=JSON.parse(r.stdout);const file=next.steps.find(s=>s.kind==="check")?.env.FOUNDRY_GOAL_FEEDBACK_FILE;
			assert.ok(file);rmSync(file,{force:true});
			if(variant==="hardlink")linkSync(target,file);else if(variant==="symlink")symlinkSync(target,file);
			else {writeFileSync(file,"");chmodSync(file,variant==="shared"?0o644:0o600);}
			const before=readFileSync(trace,"utf8"),result=guideReplay(recipient,r.stdout);
			if(result.status===0 || !/feedback/i.test(result.stderr) || readFileSync(trace,"utf8")!==before)admitted.push(variant);
		}
		assert.deepEqual(admitted,[]);assert.equal(readFileSync(target,"utf8"),"");
	});
});

test("default replay discloses release carriers but not standalone captures",async t=>{
	const {root,details}=await qualify(t,true),proof=(await details("proof")).qualification;assert.ok(proof);
	const dest=transferTo(root,proof),heads=(/** @type {string} */ cwd)=>git(cwd,"for-each-ref","--format=%(objectname)","refs/foundry/replay").split("\n").sort();
	assert.deepEqual(heads(dest),[proof.receipts.product.disclosure.subject.carrier,proof.receipts.goal.disclosure.subject.carrier].sort());
	assert.ok(launchPlan(dest,"release").some(s=>s.kind==="check" && s.role==="goal"));
	const captured=proof.outputs[0];
	assert.throws(()=>git(dest,"cat-file","-e",captured.receipt.disclosure.subject.carrier));
	const selected=transferTo(root,proof,"selected","component:"+captured.id);
	assert.deepEqual(heads(selected),[captured.receipt.disclosure.subject.carrier]);
});

test("explicit history transfer to an ordinary clone includes original captures and inputs, never a branch update", async t => {
	const { root, details } = await qualify(t, true);
	const proof = (await details("proof")).qualification; assert.ok(proof);
	const directory = path.dirname(root), dest = path.join(directory, "clean"), bundle = path.join(directory, "proof.bundle");
	/** @param {string} location */
	const cleanClone = location => git(root, "clone", "-q", "--no-local", "--no-tags", "--single-branch", "--branch", "main", "--", root, location);
	cleanClone(dest);
	const sourceRefs = git(root, "show-ref"), destRefs = git(dest, "show-ref"), tip = git(dest, "rev-parse", "HEAD");
	assert.equal(tip, proof.target.commit); assert.throws(() => git(dest, "cat-file", "-e", proof.commit));
	const reader = proof.outputs.find(o => o.id === "reader"); assert.ok(reader);
	for (const pin of [reader.generation, reader.commit, reader.inputs.tables]) {
		assert.equal(git(root, "rev-list", "--parents", "-1", pin), pin);
		assert.throws(() => git(dest, "cat-file", "-e", pin));
	}
	/** @param {string} cwd @param {string} action @param {string} file @param {unknown} [manifest] */
	const cli = (cwd, action, file, manifest = proof) => spawnSync(process.execPath, [transfer, action, "--history", file],
		{ cwd, input: JSON.stringify(manifest), encoding: "utf8" });
	const pack = cli(root, "pack", bundle);
	assert.equal(pack.status, 0, pack.stderr); assert.equal(git(root, "show-ref"), sourceRefs);
	assert.notEqual(cli(root, "pack", bundle).status, 0, "never overwrite an existing export");
	const altered=structuredClone(proof),badMode=path.join(directory,"wrong-mode.bundle");
	altered.receipts.product.inputs.checker.mode="100755";
	assert.match(cli(root,"pack",badMode,altered).stderr,/checker bytes or mode/);assert.equal(existsSync(badMode),false);
	const wrong = { ...proof, receipts: { ...proof.receipts, goal: { ...proof.receipts.goal, commit: tip } } };
	assert.notEqual(cli(dest, "import", bundle, wrong).status, 0);
	const incomplete = path.join(directory, "candidate-only.bundle");
	git(root, "bundle", "create", incomplete, `refs/foundry/objects/${proof.commit}`);
	assert.match(cli(dest, "import", incomplete).stderr, /exact qualification pins/);
	const extra = path.join(directory, "extra-head.bundle");
	const pins = git(root, "bundle", "list-heads", bundle).split("\n").map(line => line.split(" ")[1]);
	git(root, "bundle", "create", extra, ...pins, "refs/heads/main");
	assert.match(cli(dest, "import", extra).stderr, /exact qualification pins/);
	assert.equal(git(dest, "show-ref"), destRefs); assert.throws(() => git(dest, "cat-file", "-e", proof.commit));
	const imported = cli(dest, "import", bundle);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(git(dest, "rev-parse", "HEAD"), tip); assert.equal(git(dest, "status", "--porcelain"), "");
	assert.equal(git(dest, "show-ref").split("\n").filter(s => !s.includes(" refs/foundry/objects/")).join("\n"), destRefs);
	assert.equal(git(root, "show-ref"), sourceRefs); assert.equal(existsSync(path.join(dest, ".git/foundry")), false);
	for (const out of proof.outputs) {
		for (const pin of [out.commit, out.generation, out.base, ...Object.values(out.inputs)])
			assert.equal(git(dest, "rev-parse", `refs/foundry/objects/${pin}^{commit}`), pin);
		assert.equal(git(dest, "rev-parse", `${out.commit}:${out.directory}`), git(dest, "rev-parse", `${proof.commit}:${out.directory}`));
		for (const file of [out.charter, out.specification, ...out.boundary, out.receipt.check])
			assert.equal(git(dest, "rev-parse", `${proof.contract.commit}:${file}`), git(dest, "rev-parse", `${out.generation}:${file}`));
	}
	assert.match(imported.stderr,/original commits and reachable history/);
	assert.equal(git(dest, "rev-parse", proof.target.ref), tip);
	const collision = path.join(directory, "collision"); cleanClone(collision);
	git(collision, "symbolic-ref", `refs/foundry/objects/${proof.commit}`, proof.target.ref);
	const prior = git(collision, "show-ref");
	assert.notEqual(cli(collision, "import", bundle).status, 0, "never follow, overwrite or partially install over an existing pin");
	assert.equal(git(collision, "show-ref"), prior); assert.equal(git(collision, "rev-parse", "HEAD"), tip);
	const badBundle = path.join(directory, "bad.bundle"), ref = `refs/foundry/objects/${reader.generation}`;
	git(root, "update-ref", ref, tip, reader.generation); // right name, wrong contents
	assert.match(cli(root, "pack", badBundle).stderr, /exact qualification pins/); assert.equal(existsSync(badBundle), false);
	git(root, "update-ref", "-d", ref, tip);
	assert.notEqual(cli(root, "pack", badBundle).status, 0, "a missing source pin cannot be replaced by its SHA in a document");
	assert.equal(existsSync(badBundle), false); assert.equal(git(root, "rev-parse", "main"), tip);
});

test("one-off: verifiable captured untracked work yields one named native handoff, never an action on offer", async t => {
	const { h, w, root, writer, native, read, details } = await qualify(t, false);
	assert.equal((await details("proof")).qualification, null, "one-off product checks never become goal proof");
	const ongoing = structuredClone(read()); delete ongoing.policy.seed;
	assert.equal(handoff(ongoing)?.mode, "ongoing"); assert.equal(qualification(ongoing), null);
	assert.notEqual(h.commit, w.candidate);
	assert.equal(git(root, "rev-list", "--parents", "-1", w.generation), w.generation); // Parentless, and no old grain.
	assert.equal(git(root, "rev-parse", `${h.commit}^`), h.target);
	assert.ok(git(writer, "ls-files", "--others", "--exclude-standard").includes("lib/cover/value"));
	assert.equal(git(root, "show", `${h.commit}:lib/cover/extra.ignored`), "kept in the capture, despite .gitignore");
	const index = git(writer, "rev-parse", "--path-format=absolute", "--git-path", "index");
	const before = { index: readFileSync(index), refs: git(root, "show-ref") };
	/** @param {string} phase @param {object} data */
	const cli = (phase, data) => spawnSync(process.execPath, [script, phase], { cwd: root, input: JSON.stringify(data), encoding: "utf8" });
	const offered = cli("offer", { handoff: h, native });
	assert.equal(offered.status, 0, offered.stderr);
	const { offer: selected, tool } = JSON.parse(offered.stdout);
	assert.ok(selected); assert.equal(tool, undefined); assert.equal(selected.id, w.id); assert.equal(selected.commit, h.commit);
	const fresh = { handoff: (await details("cleanup")).handoff, native: { ...native }, selected };
	const call = cli("recheck", fresh);
	assert.equal(call.status, 0, call.stderr);
	assert.deepEqual(JSON.parse(call.stdout), { tool: "archive_session", arguments: { id: w.id } });
	assert.deepEqual({ index: readFileSync(index), refs: git(root, "show-ref") }, before);

	// During the choice dialog: neither an old "idle" nor an earlier green scan is a lease.
	for (const key of ["ongoingWork", "openPR", "agentMerge", "automation", "nestedWork", "externalWork"]) {
		for (const value of [true, undefined]) assert.throws(() =>
			archiveCheck(root, "recheck", { ...fresh, native: { ...native, [key]: value } }), /not verified clear/, key);
	}
	for (const changed of [{ caller: "another owner" }, { coordinator: null }, { id: "other child" }, { name: "renamed" },
		{ activity: "busy" }, { activity: "unknown" }, { workspace: "cloud" }, { path: root }, { branch: null }])
		assert.throws(() => archiveCheck(root, "recheck", { ...fresh, native: { ...native, ...changed } }));
	for (const approval of [undefined, "all", { ...selected, commit: h.target }, { ...selected, id: "sibling" }])
		assert.throws(() => archiveCheck(root, "recheck", { ...fresh, selected: approval }), /Selection/);
	const reassigned = structuredClone(read()); reassigned.nodes.cover.state = "writing";
	assert.throws(() => archiveCheck(root, "recheck", { ...fresh, handoff: handoff(reassigned, true) }), /finished writer/);
	assert.throws(() => archiveCheck(root, "offer", { handoff: { ...h, commit: w.generation }, native }), /included grain/);

	put(writer, "other/notes.ignored", "the only copy");
	const changed = cli("recheck", fresh);
	assert.equal(changed.status, 1); assert.equal(changed.stdout, ""); assert.match(changed.stderr, /product_changed|unsupported_tree/);
	assert.equal(readFileSync(path.join(writer, "other/notes.ignored"), "utf8"), "the only copy");
	rmSync(path.join(writer, "other"), { recursive: true });
	for (const [p, data] of [["lib/cover/value", "new value"], ["api", "unrelated edit"], ["lib/cover/draft", "untracked"]]) {
		put(writer, p, data);
		assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "product_changed" });
		if (p === "lib/cover/draft") rmSync(path.join(writer, p)); else put(writer, p, p === "api" ? "Export value" : "cover");
	}
	chmodSync(path.join(writer, "lib/cover/value"), 0o755);
	assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "product_changed" });
	chmodSync(path.join(writer, "lib/cover/value"), 0o644);
	mkdirSync(path.join(writer, "lib/cover/uncaptured-empty"));
	assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "product_changed" });
	rmSync(path.join(writer, "lib/cover/uncaptured-empty"), { recursive: true });
	linkSync(path.join(writer, "api"), path.join(root, "external-link"));
	assert.throws(() => archiveCheck(root, "recheck", fresh), { code: "unsupported_tree" });
	rmSync(path.join(root, "external-link"));
	put(writer, "api", "index-only work"); git(writer, "add", "api"); put(writer, "api", "Export value");
	assert.throws(() => archiveCheck(root, "recheck", fresh), /Index/);
	git(writer, "restore", "--staged", "--", "api");
	mkdirSync(path.join(writer, "lib/cover/.git"));
	assert.throws(() => archiveCheck(root, "recheck", fresh), /path|\.git/);
	rmSync(path.join(writer, "lib/cover/.git"), { recursive: true });
	const unique = git(writer, "commit-tree", `${w.generation}^{tree}`, "-p", w.generation, "-m", "unique writer history");
	git(writer, "update-ref", "HEAD", unique, w.generation);
	assert.throws(() => archiveCheck(root, "recheck", fresh), /generation/);
	git(writer, "update-ref", "HEAD", w.generation, unique);
	assert.throws(() => archiveCheck(root, "recheck", fresh), /history/);
});
