import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { factory, git, put } from "../test/fixture.mjs";

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
