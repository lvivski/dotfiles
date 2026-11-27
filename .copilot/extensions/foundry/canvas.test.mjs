import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mapSnapshot } from "./map/model.mjs";
import { factory, loadEntry, put } from "./test/fixture.mjs";
import { compose, step } from "./work/machine.mjs";
import { catalog, definitions as runtimeModels } from "./work/catalog.mjs";

test("a board with no planner, runner, ledger or effect executor can load the actual chart",()=>{
	const script=`
		import { registerHooks } from "node:module";
		const root=new URL("./",process.argv[1]);
		const sdk="data:text/javascript,export const createCanvas=x=>x;export class CanvasError extends Error{}";
		const pure=new Set(["catalog","machine","engine","projection","strategy","scheduling","values"].map(n=>"work/"+n+".mjs"));
		registerHooks({resolve(s,ctx,next){
			if(s==="@github/copilot-sdk/extension")return {url:sdk,shortCircuit:true};
			const result=next(s,ctx),local=result.url.startsWith(root.href)&&result.url.slice(root.href.length);
			if(result.url.startsWith("node:") && !["node:crypto","node:fs/promises","node:http"].includes(result.url))
				throw Error("Unexpected board capability: "+result.url);
			const memberData=local==="work/prerequisites.json" && ctx.importAttributes.type==="json" && ctx.parentURL===new URL("work/strategy.mjs",root).href;
			if(local && local.startsWith("work/") && !local.startsWith("work/rules/") && !pure.has(local) && !memberData)
				throw Error("Board reached a non-renderer dependency: "+local);
			return result;
		}});
		const {foundryBoard}=await import(process.argv[1]);
		const unused=()=>{throw Error("Simulation accessed a run");};
		const board=foundryBoard(unused,unused,unused);
		const ctx={instanceId:"probe",sessionId:"viewer",input:{machine:true}};
		try {
			const {url}=await board.open(ctx);
			const chart=await (await fetch(new URL("machines",url))).json();
			process.stdout.write(JSON.stringify(chart));
		} finally {await board.onClose(ctx);}
	`;
	const result=execFileSync(process.execPath,["--input-type=module","-e",script,new URL("./canvas.mjs",import.meta.url).href],{encoding:"utf8"});
	assert.deepEqual(JSON.parse(result),catalog());
});

/** @param {string} url */
async function panelModules(url){
	const html=await (await fetch(url)).text();
	const script=new URL(/<script type="module" src="([^"]+)"/.exec(html)?.[1] ?? assert.fail("missing module"),url);
	const modules=new Set([script.href]);
	for(const href of modules) {
		const r=await fetch(href);assert.equal(r.status,200,href);assert.match(r.headers.get("content-type")??"",/javascript/);
		const js=(await r.text()).replace(/\/\*\*[\s\S]*?\*\//g,""); // Type-only imports are not browser requests.
		for(const [,file] of js.matchAll(/(?:^import [^\n]*? from "|import\(")(\.{1,2}\/[^"]+\.mjs)"/gm)){
			const next=new URL(file,href);assert.ok(next.href.startsWith(url));modules.add(next.href);
		}
	}
	return {html,modules};
}
test("the state explorer serves the executable models and browser selector without a run",async t=>{
	const conf=await loadEntry({sessionId:"viewer",on(){}}), canvas=conf.canvases?.[0]; assert.ok(canvas);
	const ctx={sessionId:"viewer",extensionId:"user:foundry",canvasId:"foundry-board",instanceId:"logic",input:{machine:true}};
	const {url}=await canvas.open(ctx); assert.ok(url); t.after(()=>canvas.onClose?.(ctx));
	const {html,modules}=await panelModules(url);assert.match(html,/State explorer/);
	assert.ok(modules.has(`${url}work/machine.mjs`),"the browser uses the real interpreter");
	assert.ok(modules.has(`${url}map/statechart.mjs`));
	assert.ok([...modules].every(href=>!href.includes("/vendor/")),"the explorer uses only first-party modules");
	assert.equal((await fetch(`${url}studio.css`)).status,200);
	const definitions=await (await fetch(`${url}machines`)).json(); assert.deepEqual(definitions,catalog());const model=definitions.machines;
	// Compute the browser representation independently, without using catalog() as its own oracle.
	assert.deepEqual(model,JSON.parse(JSON.stringify(runtimeModels())));
	for(const id of ["scheduling","reconciliation","release-preflight"])assert.ok(model[id],`${id} must be available in the real explorer`);
	assert.equal(step(model.supervision,"managed-policy","sample",{permitted:false})?.action,"wait");
	assert.equal(step(model.supervision,"managed-policy","sample",{permitted:true})?.action,"reactivate");
	assert.equal(step(model.call,"uncertain","issue"),undefined);
	assert.equal(step(model.review,"reported","admit")?.target,"observed");
	const sim=compose(model.supervision,model.history).actor({supervision:"managed-policy",history:"pending"});
	assert.deepEqual(sim.send("sample",{supervision:{permitted:false}}).map(s=>s.edge.action),["wait","lookup"]);
	assert.equal((await fetch(`${url}machines`,{method:"POST"})).status,404);
});

test("the open map follows the real parallel run without issuing calls; participant views stay bound across refresh and re-open", async t => {
	const run = "map-trial", source = ".foundry/example.json", ids = ["editor", "recover", "send"];
	const grains = ids.map(id => ({ id, directory: `lib/${id}`, specification: id==="recover"?"recover.md":"spec.md", boundary: ["api.md"],
		check: "check.mjs", needs: id === "send" ? ids.slice(0, 2) : [] }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, target: "refs/heads/main", direction: "Edit, recover and send.",
			productCheck: "product.mjs", grains, seed: ids, squads: [{ id: "squad", charter: "spec.md", grains: ids }] }),
		"spec.md": "Own the complete directory.", "recover.md":"Restore the pending entries.", "api.md": "One module per directory.", "check.mjs": "", "product.mjs": "",
	});
	const conf = await loadEntry({ sessionId: "owner", on() {} }), canvas = conf.canvases?.[0]; assert.ok(canvas);
	assert.equal(canvas.declaration.displayName, "Foundry");
	const ctx = { sessionId: "owner", extensionId: "user:foundry", canvasId: "foundry-board", instanceId: "parallel", input: { run } };
	const hook = { sessionId: "owner", timestamp: new Date(), workingDirectory: f.root };
	await conf.hooks?.onSessionStart?.({ ...hook, source: "startup" }, hook);
	t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, hook));
	const manual = { ...ctx, input: {}, instanceId: "manual" }, manualPanel = await canvas.open(manual);
	t.after(() => canvas.onClose?.(manual)); assert.ok(manualPanel.url);
	assert.equal(manualPanel.title, "Foundry");
	const emptyState = await (await fetch(`${manualPanel.url}state`)).json();
	assert.match(emptyState.notice, /no foundry run.*session/i);
	await f.start();
	const before = await f.status(), { url } = await canvas.open(ctx); assert.ok(url);
	t.after(() => canvas.onClose?.(ctx));
	const panel=await panelModules(url);
	assert.match(panel.html,/Work graph/);assert.ok(panel.modules.has(`${url}map/plot.mjs`) && panel.modules.has(`${url}map/camera.mjs`));
	assert.equal((await fetch(`${url}run.css`)).status,200);
	/** @param {string} at @returns {Promise<import("./map/model.mjs").MapSnapshot>} */
	async function refresh(at) { const r = await fetch(`${at}state`); assert.equal(r.status, 200); return r.json(); }
	assert.deepEqual(await canvas.open(ctx), { url, title: `Foundry · ${run}` });
	assert.deepEqual(await refresh(url), mapSnapshot(before));
	assert.deepEqual(await refresh(manualPanel.url), mapSnapshot(before));
	const other = { ...manual, instanceId: "outside", sessionId: "outsider" }, otherPanel = await canvas.open(other);
	t.after(() => canvas.onClose?.(other)); assert.ok(otherPanel.url);
	assert.deepEqual(await (await fetch(`${otherPanel.url}state`)).json(), emptyState);
	assert.equal((await refresh(url)).timing?.firstWriter, "bound");
	assert.deepEqual((await refresh(url)).nodes.filter(n => n.state === "assigned").map(n => n.id), ["editor", "recover"]);
	assert.deepEqual((await refresh(url)).nodes.find(n => n.id === "send")?.needs, ["editor", "recover"]);
	assert.deepEqual(await f.status(), before);
	assert.equal(f.workers.size, 2); assert.equal(f.checks.length, 0);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "unrelated", sessionId: "outsider" }), /No bound assignment/);
	await assert.rejects(async () => canvas.open({ ...ctx, instanceId: "missing", input: { run: "no-such-run" } }), /Unknown run/);
	const [w] = f.workers.values();
	const workerCtx = { ...manual, sessionId: w.id, instanceId: "participant" }, worker = await canvas.open(workerCtx); assert.ok(worker.url);
	t.after(() => canvas.onClose?.(workerCtx));
	const view = await refresh(worker.url);
	assert.deepEqual(view, mapSnapshot(await f.status(w.id)));
	assert.equal(view.owner, false); assert.equal(view.timing, null); assert.deepEqual(view.nodes.map(n => n.id), ["editor"]);
	assert.equal(view.nodes[0].specification,"spec.md");
	put(f.root,"spec.md","Uncommitted replacement purpose.");
	assert.equal(await (await fetch(`${worker.url}specification/editor`)).text(),"Own the complete directory.");
	assert.equal(await (await fetch(`${url}specification/recover`)).text(),"Restore the pending entries.");
	for(const id of ["recover","recover.md","not-visible"]){
		/** @type {Response} */ const response=await fetch(`${worker.url}specification/${id}`);
		assert.equal(response.status,404);assert.doesNotMatch(await response.text(),/Restore the pending entries/);
	}
	assert.ok(!JSON.stringify(view).includes(w.token) && !("prepared" in view));
	put(w.cwd, "lib/editor/unit.mjs", "export default 1;");
	await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	const after = await refresh(url);
	assert.equal(after.nodes.find(n => n.id === "editor")?.result?.exit, 0);
	assert.equal(after.nodes.find(n => n.id === "send")?.state, "waiting");
	await f.owner.operation("pause", { run }, "owner");
	assert.equal((await refresh(url)).phase, "Paused");
	await canvas.onClose?.(ctx); await assert.rejects(fetch(`${url}state`));
	const reopened = await canvas.open(ctx); assert.ok(reopened.url && reopened.url !== url);
	assert.deepEqual(await refresh(reopened.url), mapSnapshot(await f.status()));
});
