import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const assets = new Map([
	["", ["index.html", "text/html; charset=utf-8"]], ["style.css", ["style.css", "text/css; charset=utf-8"]],
	["view.mjs", ["view.mjs", "text/javascript; charset=utf-8"]], ["layout.mjs", ["layout.mjs", "text/javascript; charset=utf-8"]],
]);

/** @param {()=>Promise<import("./model.mjs").MapSnapshot|{notice:string}>} snapshot */
export async function serveMap(snapshot) {
	const prefix = `/${randomBytes(24).toString("hex")}/`;
	let host = "";
	const server = createServer(async (req, res) => {
		res.setHeader("cache-control", "no-store");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
		if (req.method !== "GET" || req.headers.host !== host || !req.url?.startsWith(prefix)) {
			res.writeHead(404).end(); return;
		}
		const route = req.url.slice(prefix.length).split("?", 1)[0];
		try {
			if (route === "state") {
				const data = await snapshot();
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
			} else if (assets.has(route)) {
				const [file, mime] = /** @type {string[]} */ (assets.get(route));
				const body = await readFile(new URL(file, import.meta.url));
				res.writeHead(200, { "content-type": mime }).end(body);
			} else res.writeHead(404).end();
		} catch (e) {
			res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : "Could not read this map");
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(undefined));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Foundry map did not bind a loopback port");
	host = `127.0.0.1:${address.port}`;
	return { url: `http://${host}${prefix}`,
		close: () => new Promise((resolve, reject) => {
			server.close(error => error ? reject(error) : resolve(undefined));
			server.closeAllConnections();
		}) };
}
