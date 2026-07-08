/** @module canvas.test — the (experimental) progress web panel: render, serve, traversal guard. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { renderDashboardHtml, escapeHtml, startPanel } from "./canvas.mjs";
import { tmpDir } from "./fixtures/support.mjs";

test("escapeHtml neutralizes HTML metacharacters", () => {
	assert.equal(escapeHtml(`<b>&"'`), "&lt;b&gt;&amp;&quot;&#39;");
});

test("renderDashboardHtml embeds the runId, escapes untrusted state, and includes the live poller", () => {
	const html = renderDashboardHtml("run-1", { title: "<script>x</script>", startedAt: new Date().toISOString() });
	assert.match(html, /run-1/);
	assert.doesNotMatch(html, /<script>x<\/script>/); // the title is escaped in the server-rendered header
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /setInterval\(tick/); // client polls for live updates
});

test("panel serves dashboard HTML + the run's state.json, empties unknown runs, blocks traversal", async () => {
	const runs = tmpDir();
	mkdirSync(join(runs, "abc"), { recursive: true });
	writeFileSync(join(runs, "abc", "state.json"), JSON.stringify({ status: "running", counts: { done: 2 } }));
	const panel = await startPanel({ runsDir: runs });
	try {
		const base = `http://127.0.0.1:${panel.port}`;

		const html = await fetch(`${base}/r/abc`);
		assert.equal(html.status, 200);
		assert.match(html.headers.get("content-type") || "", /text\/html/);

		const state = await fetch(`${base}/r/abc/state`);
		assert.equal(state.status, 200);
		assert.equal(/** @type {any} */ (await state.json()).counts.done, 2);

		const unknown = await fetch(`${base}/r/nope/state`);
		assert.equal(unknown.status, 200);
		assert.deepEqual(await unknown.json(), {}); // unknown run -> empty state, not an error

		const traversal = await fetch(`${base}/r/bad%2Fid/state`);
		assert.equal(traversal.status, 400); // a runId with a separator is rejected
	} finally {
		await panel.close();
	}
});
