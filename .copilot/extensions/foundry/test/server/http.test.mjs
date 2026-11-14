import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { RENDERER_SCRIPTS } from "../../server/assets.mjs";
import { readJson } from "../../server/http.mjs";
import { fixture } from "./fixture.mjs";

test("complete long Unicode JSON mutation input survives transport beyond the former 32-KiB cutoff", async t => {
	const request = new IncomingMessage(new Socket());
	t.after(() => request.destroy());
	request.headers = { "content-type": "application/json" };
	const original = { reason: `  ${"long \u03bb instruction\n".repeat(4000)}  `, actor: "  source owner  " };
	const bytes = Buffer.from(JSON.stringify(original));
	assert.ok(bytes.length > 32 * 1024);
	request.push(bytes.subarray(0, 17000));
	request.push(bytes.subarray(17000));
	request.push(null);
	assert.deepEqual(await readJson(request), original);
});

test("private bootstrap, state, assets and SSE require the per-instance URL capability and omit referrers", async () => {
	const current = await fixture();
	const controller = new AbortController();
	try {
		const origin = new URL(current.server.url).origin;
		assert.match(new URL(current.server.url).pathname, /^\/c\/[a-f0-9]{48}\/$/);
		for (const pathname of ["/", "/index.html", ...RENDERER_SCRIPTS.map((name) => `/${name}`), "/styles.css", "/api/plan", "/api/workflow?runId=native-run", "/events"]) {
			const response = await fetch(`${origin}${pathname}`);
			assert.equal(response.status, 403, pathname);
			assert.equal(response.headers.get("referrer-policy"), "no-referrer");
		}
		assert.equal(current.snapshotReads.length, 0);
		const wrong = new URL(current.server.url);
		wrong.pathname = wrong.pathname.replace(/[a-f0-9]{48}/, "0".repeat(48));
		assert.equal((await fetch(wrong)).status, 403);
		const htmlResponse = await fetch(current.server.url);
		assert.equal(htmlResponse.status, 200);
		assert.equal(htmlResponse.headers.get("referrer-policy"), "no-referrer");
		const html = await htmlResponse.text();
		assert.match(html, /name="referrer" content="no-referrer"/);
		assert.match(html, /<script type="module" src="app\.mjs"><\/script>/);
		assert.equal([...html.matchAll(/<script\b/g)].length, 1);
		assert.match(html, /href="styles\.css"/);
		for (const resource of [...RENDERER_SCRIPTS, "styles.css", "api/plan"]) {
			const response = await fetch(new URL(resource, current.server.url));
			assert.equal(response.status, 200, resource);
			assert.equal(response.headers.get("referrer-policy"), "no-referrer");
			if (resource !== "api/plan") {
				assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'");
				assert.equal(await response.text(), await readFile(new URL(`../../renderer/${resource}`, import.meta.url), "utf8"));
			}
		}
		for (const resource of ["extension.mjs", "README.md", "app.js", "contracts.js", "../extension.mjs", "..%2fextension.mjs"]) {
			assert.ok([403, 404].includes((await fetch(new URL(resource, current.server.url))).status), resource);
		}
		assert.equal((await fetch(new URL("api/plan", current.server.url), { headers: { Origin: "https://foreign.example" } })).status, 403);
		const stream = await fetch(new URL("events", current.server.url), { signal: controller.signal });
		assert.equal(stream.status, 200);
		assert.equal(stream.headers.get("referrer-policy"), "no-referrer");
		assert.ok(stream.body);
		const reader = stream.body.getReader();
		const first = await reader.read();
		assert.ok(first.value);
		assert.match(Buffer.from(first.value).toString("utf8"), /event: ready/);
		await reader.cancel();
	} finally { controller.abort(); await current.close(); }
});
