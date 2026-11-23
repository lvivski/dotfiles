import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { factory, git, put } from "./fixture.mjs";

test("a scoped comparison can start product work alongside an independent writer without repeating release validation", async t => {
	const run = "panels", source = ".foundry/panels.json";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ id: run, version: 2, target: "refs/heads/main", direction: "Build a working chart.", goalCheck: "goal.mjs", productCheck: "unit.mjs",
			squads: ["screen", "data"].map(id => ({ id, charter: `${id}.md`, areas: [id], checks: ["unit.mjs"] })) }),
		".foundry/panels/journey.md": "Inspect the real product.", "screen.md": "The graph must stay visible next to its legend.",
		"data.md": "Publish the data.", "unit.mjs": "", "goal.mjs": "process.exit(1);",
	});
	await f.start();
	const screen = f.scouts.find(s => s.squad === "screen"), data = f.scouts.find(s => s.squad === "data"); assert.ok(screen && data);
	await screen.report({ outcome: "no-gap", reason: "No mismatch in this evidence.", evidence: ["screen.md"], grains: [] });
	await data.report({ outcome: "regenerate", reason: "Produce independent data.", evidence: ["data.md"],
		grains: [{ id: "input", directory: "data/input", check: "unit.mjs", task: "Produce the values.", needs: [] }] });
	const file = "references/comparison.txt"; put(f.root, file, "At normal width the legend displaces the graph.");
	const [artifact] = (await f.owner.operation("publish", { run, file, to: ["screen/layout"] }, "owner")).artifacts;
	const [receipt] = (await f.owner.operation("status", { run, detail: "proof" }, "owner")).goalChecks ?? [];
	const args = { run, directory: "screen/layout", blob: artifact.blob, receipt: receipt.id, question: "Keep the graph wider than the legend." };
	const checks = [...f.checks];
	assert.equal(f.scouts.length, 2, "an ordinary reference offer isn't an assignment");
	await f.owner.operation("iterate", args, "owner"); await f.settle();
	const focused = f.scouts.at(-1); assert.ok(focused && focused.squad === "screen" && focused.id !== screen.id);
	assert.ok(focused.prompt.includes(args.question) && focused.prompt.includes(artifact.blob));
	await f.runtime(f.root).operation("iterate", args, "owner"); await f.settle(); assert.equal(f.scouts.length, 3);
	await assert.rejects(f.owner.operation("iterate", { ...args, directory: "data/input" }, "owner"), /not offered/);
	await assert.rejects(f.owner.operation("iterate", args, "worker-1"), /owner/);
	await focused.report({ outcome: "regenerate", reason: "Implement the observed sizing change.", evidence: ["screen.md"],
		grains: [{ id: "layout", directory: args.directory, check: "unit.mjs", task: "Give the graph the larger column.", needs: [] }] });
	assert.equal(f.workers.size, 2); assert.deepEqual(f.checks, checks);
	const status = await f.status();
	assert.deepEqual(status.nodes.filter(n => n.state === "writing").map(n => n.grain).sort(), ["input", "layout"]);
	assert.equal(status.qualified, null);
});

for (const scenario of ["pending", "superseded", "changed input", "pass during review"]) test(`a checked checkpoint can staff an independent comparison without qualifying the old tree: ${scenario}`, async t => {
	const run = "pending", source = ".foundry/pending.json", goalCheck = ".foundry/pending/goal.mjs";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({id: run, version: 2, target: "refs/heads/main", direction: "Show a graph with its data.", goalCheck, productCheck: "unit.mjs",
			squads: ["screen", "data"].map(id => ({id, charter: `${id}.md`, areas: [id], checks: ["unit.mjs"]}))}),
		".foundry/pending/journey.md": "Show data and legend.", "screen.md": "Build the graph.", "data.md": "Supply data.",
		"layout-guide.txt": "The legend must fit beside the graph.",
		"unit.mjs": "", [goalCheck]: 'import {existsSync} from "node:fs"; process.exit(existsSync("data/input/value") ? 0 : 1);',
	});
	const file = "comparison.txt"; put(f.root, file, "The legend hides the data.");
	await f.start(); const [artifact] = (await f.owner.operation("publish", {run, file, to: ["screen/layout"]}, "owner")).artifacts;
	const original = (await f.owner.operation("status", {run, detail:"proof"}, "owner")).goalChecks?.[0]; assert.ok(original);
	const screen = f.scouts.find(r => r.squad === "screen"), data = f.scouts.find(r => r.squad === "data"); assert.ok(screen && data);
	await screen.report({outcome:"no-gap", reason:"No layout comparison yet.", grains:[], evidence:["screen.md"]});
	await data.report({outcome:"regenerate", reason:"Provide data.", evidence:["data.md"], grains:[{id:"input",directory:"data/input",task:"Generate the values.",check:"unit.mjs",needs:[]}]});
	const [w] = f.workers.values(), events = new EventEmitter(), waiting = once(events, "pending"), release = once(events, "release");
	const writer = f.runtime(w.cwd, {execute: async (tool, args, id) => {
		if (tool === "bash" && String(args.description).includes("final goal")) { events.emit("pending"); await release; }
		return f.execute(tool,args,id);
	}});
	put(w.cwd, "data/input/value", "42");
	const first = writer.operation("submit", {run,token:w.token}, w.id);
	try {
		await Promise.race([waiting, first.then(() => assert.fail("Expected an in-flight goal"))]);
		if (scenario === "superseded") {
			const side = path.join(path.dirname(f.root), "evaluator");
			git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
			put(side, goalCheck, readFileSync(path.join(side, goalCheck), "utf8") + "\n// Correct diagnostic.\n");
			git(side, "commit", "-qam", "Reviewed evaluator");
			await f.runtime(f.root, {confirm: async () => true}).operation("repin", {run, from:f.tip, revision:git(side,"rev-parse","HEAD"), files:[goalCheck]}, "owner");
		}
		const status = await f.status(), checkpoint = status.products?.at(-1); assert.ok(checkpoint?.receipt?.exit === 0);
		const checks = [...f.checks], scoutCount = f.scouts.length;
		const input = {run, directory:"screen/layout", blob:artifact.blob, receipt:checkpoint.check, question:"Keep the data visible beside the legend."};
		if (scenario === "pending") {
			await f.owner.operation("configure", {run, revision:0, checkpointReviews:false}, "owner");
			await assert.rejects(f.owner.operation("iterate", input, "owner"), /scheduling policy/);
			await f.owner.operation("configure", {run, revision:1, checkpointReviews:true}, "owner");
		}
		await assert.rejects(f.owner.operation("iterate", {...input, receipt:original.id}, "owner"), /checkpoint/);
		await f.owner.operation("iterate", input, "owner"); await f.settle();
		await f.runtime(f.root).operation("iterate", {...input, question:"Same comparison."}, "owner"); await f.settle();
		assert.equal(f.scouts.length, scoutCount + 1);
		let review = f.scouts.at(-1); assert.ok(review && review.base === checkpoint.commit && review.prompt.includes(input.question));
		assert.match(review.prompt, /passing product checkpoint, not a goal verdict/);
		if (scenario === "pending") await f.owner.operation("configure", {run, revision:2, checkpointReviews:false}, "owner");
		if (scenario === "pass during review") {
			events.emit("release"); await first;
			assert.equal((await f.status()).qualified, null);
			await review.report({outcome:"needs-evidence",reason:"Check the layout rule.",evidence:["screen.md"],file:"layout-guide.txt",grains:[]});
			review = f.scouts.at(-1); assert.ok(review && review.prompt.includes("The legend must fit beside the graph.") && review.prompt.includes(input.question));
		}
		await review.report({outcome:"regenerate",reason:"Use the checked values beside the narrower legend.",evidence:["screen.md"],
			grains:[{id:"layout",directory:input.directory,check:"unit.mjs",task:"Resize the graphic.",needs:["input"]}]});
		const worker = [...f.workers.values()].find(x => x.id !== w.id); assert.ok(worker, "writer must start before the goal returns");
		assert.equal(git(worker.cwd, "show", "HEAD:data/input/value"), "42");
		assert.equal(f.checks.length, checks.length + Number(scenario === "pass during review"));
		assert.equal(f.scouts.length, scoutCount + (scenario === "pass during review" ? 2 : 1));
		put(f.root, "comparison.txt", "A different comparison of the same live pane.");
		const [other] = (await f.owner.operation("publish", {run,file,to:[input.directory]},"owner")).artifacts.filter(a => a.blob !== input.blob);
		await assert.rejects(f.owner.operation("iterate",{...input,blob:other.blob},"owner"), /existing assignment|checkpoint/);
		if (scenario === "changed input") {
			put(f.root, "data/input/value", "99"); git(f.root,"add","data/input/value"); git(f.root,"commit","-qm","Change the checked prerequisite");
		}
		put(worker.cwd, "screen/layout/legend", "narrow"); await f.runtime(worker.cwd).operation("submit",{run,token:worker.token},worker.id);
		const pending = await f.status();
		if (scenario !== "pass during review") {
			assert.equal(pending.nodes.find(n => n.grain === "layout")?.state,"published");
			assert.equal(pending.checkpoint, checkpoint.commit); assert.equal(pending.qualified,null);
		}
	} finally { events.emit("release"); await first; }
	const result = await f.status();
	if (scenario === "changed input") {
		assert.equal(result.qualified, null); assert.equal(result.products?.length, 1); assert.match(result.blocker ?? "", /modification|changed/i); return;
	}
	assert.ok(result.qualified && result.qualified === result.goal?.receipt?.commit);
	assert.equal(git(f.root, "show", `${result.qualified}:screen/layout/legend`), "narrow");
	assert.equal(result.products?.at(-1)?.receipt?.commit, result.qualified);
});

test("midpoint previews keep the same writer and never submit or validate the product", async t => {
	const run = "draft", source = ".foundry/draft.json";
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 1, id: run, direction: "Draw the chart.", target: "refs/heads/main",
		productCheck: "unit.mjs", seed: ["chart"], grains: [{id:"chart", directory:"screen", specification:"spec", boundary:["api"], check:"unit.mjs"}] }),
		spec:"Draw it.", api:"A label.", "unit.mjs":"", "shell.txt":"frozen shell" });
	await f.start(); const [w] = f.workers.values(), writer = f.runtime(w.cwd), args = { run, token: w.token };
	put(w.cwd, "screen/label", "small"); put(w.cwd, "shell.txt", "outside the assignment");
	await writer.operation("preview", args, w.id);
	const first = (await f.status()).nodes[0].preview; assert.ok(first);
	assert.equal(git(f.root, "show", `${first}:screen/label`), "small"); assert.equal(git(f.root, "show", `${first}:shell.txt`), "frozen shell");
	await writer.operation("preview", args, w.id); assert.equal((await f.status()).nodes[0].preview, first);
	put(w.cwd, "screen/label", "corrected"); await writer.operation("preview", args, w.id);
	const next = (await f.status()).nodes[0]; assert.ok(next.preview && next.preview !== first);
	assert.equal(next.checked, undefined); assert.equal(next.state, "writing"); assert.deepEqual(f.checks, []);
	await assert.rejects(writer.operation("preview", args, "stranger"), /assignment/);
	await writer.operation("submit", args, w.id); assert.ok(f.checks.length);
	await assert.rejects(writer.operation("preview", args, w.id), /writable|submitted/);
});

test("a late mockup reaches its live screen writer and future reviewer without changing either worktree or the contract", async t => {
	const run = "screen", source = ".foundry/screen.json", file = "targets/chart.svg";
	const squads = ["chart", "review", "other"].map(id => ({ id, charter: `${id}.md`, areas: [id], checks: ["unit.mjs"] }));
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ id: run, version: 2, target: "refs/heads/main", direction: "Review the real screen.", squads, goalCheck: "goal.mjs", productCheck: "product.mjs" }),
		".foundry/screen/journey.md": "Only the packaged screen counts.", "chart.md": "Build the screen.", "review.md": "Compare the result.",
		"other.md": "Independent work.", "unit.mjs": "", "product.mjs": "", "goal.mjs": "process.exit(1)",
	});
	/** @type {Array<{to:string, message:string}>} */ const notices = [];
	let decline = false;
	const owner = f.runtime(f.root, { execute: async (tool, args, id) => {
		if (tool === "send_session_message") {
			notices.push({ to: String(args.session_id), message: String(args.message) });
			if (decline) return { resultType: "denied" };
		}
		return f.execute(tool, args, id);
	} });
	await f.start(owner);
	const assign = (/** @type {string} */ id) => f.scouts.find(r => r.squad === id)?.report({ outcome: "regenerate", evidence: [`${id}.md`],
		reason: "Missing behavior.", grains: [{ id, directory: id === "review" ? "review/visual" : id, check: "unit.mjs", task: "Implement the charter.", needs: [] }] });
	await assign("chart"); await assign("other");
	const [chart, other] = f.workers.values(), worker = f.runtime(chart.cwd);
	const publish = { run, file, to: ["chart", "review/visual"] }, svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Chart</title></svg>';
	put(f.root, file, svg);
	await owner.operation("publish", publish, "owner");
	const art = (await f.status()).artifacts?.[0]; assert.ok(art);
	assert.equal(git(chart.cwd, "cat-file", "blob", art.blob), svg);
	assert.equal(f.workers.size, 2); assert.equal(notices.length, 1); assert.equal(notices[0].to, chart.id);
	assert.ok(notices[0].message.includes(art.blob)); assert.ok(!existsSync(path.join(chart.cwd, file)));
	assert.deepEqual((await f.status(other.id)).artifacts, []);
	await owner.operation("publish", { ...publish, to: ["review/visual", "chart"] }, "owner"); assert.equal(notices.length, 1);
	decline = true; put(f.root, file, "<svg>new draft</svg>"); await owner.operation("publish", publish, "owner");
	assert.equal(notices.length, 2); assert.equal(git(chart.cwd, "cat-file", "blob", art.blob), svg);
	assert.equal((await f.status(chart.id)).nodes[0].token, chart.token);
	await assign("review"); const reviewer = [...f.workers.values()].at(-1); assert.ok(reviewer && reviewer.prompt.includes(art.blob));
	const visual = execFileSync("/bin/sh", ["-c", art.extract], { cwd: reviewer.cwd, encoding: "utf8" }).trim();
	try { assert.equal(path.extname(visual), ".svg"); assert.equal(readFileSync(visual, "utf8"), svg); }
	finally { unlinkSync(visual); rmdirSync(path.dirname(visual)); }
	put(chart.cwd, "chart/pane", "view");
	await assert.rejects(worker.operation("submit", { run, token: chart.token, usedArtifacts: ["b".repeat(40)] }, chart.id), /not offered/);
	await worker.operation("submit", { run, token: chart.token, usedArtifacts: [art.blob] }, chart.id);
	put(f.root, file, "<svg>after submission</svg>"); await owner.operation("publish", publish, "owner");
	assert.deepEqual(notices.map(n => n.to), [chart.id, chart.id, reviewer.id]); assert.equal(f.workers.size, 3);
	put(reviewer.cwd, "review/visual/result", "Mismatch"); await f.runtime(reviewer.cwd).operation("submit", { run, token: reviewer.token, comparedArtifacts: [art.blob] }, reviewer.id);
	const status = await f.status();
	assert.deepEqual(status.artifactReports.find(n => n.worker === chart.id)?.usedArtifacts, [art.blob]);
	assert.equal(status.artifactReports.find(n => n.worker === chart.id)?.comparedArtifacts, undefined);
	assert.deepEqual(status.artifactReports.find(n => n.worker === reviewer.id)?.comparedArtifacts, [art.blob]);
	assert.equal(status.qualified, null); assert.equal(git(f.root, "rev-parse", "HEAD"), f.tip);
	assert.equal(git(f.root, "ls-files", file), "");
});

test("publishing requires explicit recipients and a regular file owned by the publisher", async t => {
	const run = "icons", source = ".foundry/icons.json";
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 1, id: run, direction: "Publish an icon.", target: "refs/heads/main",
		productCheck: "product.mjs", seed: ["icon"], squads: [{ id: "art", charter: "charter", grains: ["icon"] }],
		grains: [{ id: "icon", directory: "icons", specification: "charter", boundary: ["api"], check: "unit.mjs" }] }),
		charter: "Produce an icon.", api: "", "unit.mjs": "", "product.mjs": "" });
	await f.start(); const [w] = f.workers.values(), writer = f.runtime(w.cwd);
	const pub = { run, token: w.token, file: "icons/work.png", to: ["icons"] };
	put(w.cwd, "icons/empty", ""); writeFileSync(path.join(w.cwd, pub.file), Buffer.from([0, 255, 210, 10]));
	await assert.rejects(writer.operation("publish", { ...pub, file: "api" }, w.id), /outside/);
	await assert.rejects(writer.operation("publish", pub, "unrelated"), /assignment/);
	await assert.rejects(writer.operation("publish", { ...pub, to: ["unknown"] }, w.id), /recipient/);
	symlinkSync(path.join(w.cwd, "api"), path.join(w.cwd, "icons/link"));
	await assert.rejects(writer.operation("publish", { ...pub, file: "icons/link" }, w.id), /regular|link/);
	await writer.operation("publish", pub, w.id);
	const [artifact] = (await f.status()).artifacts ?? []; assert.ok(artifact);
	assert.equal(artifact.blob, git(w.cwd, "hash-object", "--no-filters", pub.file));
});

test("publication during an unconfirmed writer launch waits for the original binding", async t => {
	const run = "binding", source = ".foundry/binding.json";
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 1, id: run, direction: "Build a screen.", target: "refs/heads/main",
		productCheck: "check", seed: ["screen"], grains: [{ id: "screen", directory: "ui", specification: "spec", boundary: ["api"], check: "check" }] }),
		spec: "", api: "", check: "" });
	const events = new EventEmitter(), launched = once(events, "launch"), release = once(events, "release");
	/** @type {string[]} */ const messages = [];
	const owner = f.runtime(f.root, { execute: async (tool, args, id) => {
		const result = await f.execute(tool, args, id);
		if (tool === "create_session") { events.emit("launch"); await release; }
		if (tool === "send_session_message") messages.push(String(args.message));
		return result;
	} });
	const starting = f.start(owner);
	try {
		await launched; put(f.root, "layout.svg", "<svg/>");
		const result = await owner.operation("publish", { run, file: "layout.svg", to: ["ui"] }, "owner");
		assert.equal(result.artifacts.length, 1); assert.equal(messages.length, 0);
	} finally { events.emit("release"); await starting; }
	owner.turn("owner"); await owner.flush();
	assert.equal(f.workers.size, 1); assert.equal(messages.length, 1);
	assert.ok(messages[0].includes((await f.status()).artifacts[0].blob));
});
