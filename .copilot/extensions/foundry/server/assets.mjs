import { readFile } from "node:fs/promises";

// Only these packaged assets can be read; request paths never become filesystem paths.
export const RENDERER_SCRIPTS = Object.freeze([
	"app.mjs", "actions.mjs", "client.mjs", "contracts.mjs", "dom.mjs",
	"factory.mjs", "plan.mjs", "reader.mjs", "snapshot.mjs", "workflows.mjs",
]);
export const rendererTemplate = readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
const assets = new Map([
	["/styles.css", {
		type: "text/css; charset=utf-8",
		content: readFile(new URL("../renderer/styles.css", import.meta.url), "utf8"),
	}],
	...RENDERER_SCRIPTS.map((name) => /** @type {const} */([`/${name}`, {
		type: "text/javascript; charset=utf-8",
		content: readFile(new URL(`../renderer/${name}`, import.meta.url), "utf8"),
	}])),
]);

/** @param {string} pathname */
export function assetFor(pathname) {
	return assets.get(pathname);
}
