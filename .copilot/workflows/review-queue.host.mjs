import { isAbsolute, relative, resolve } from "node:path";
import { lstatSync, realpathSync, statSync } from "node:fs";

function confined(root, file) {
	const lexical = resolve(root, file);
	const lexicalRel = relative(root, lexical);
	if (lexicalRel === ".." || lexicalRel.startsWith("../") || isAbsolute(lexicalRel)) throw new Error("path escapes checkout");
	return lexical;
}

export async function inspectCheckout(input = {}) {
	const root = realpathSync(String(input.root || ""));
	const present = [];
	const missing = [];
	const uninspectable = [];
	for (const raw of Array.isArray(input.files) ? input.files : []) {
		const file = String(raw || "").replace(/^\/+/, "");
		if (!file || file.startsWith("../") || isAbsolute(file)) {
			uninspectable.push(file || String(raw || ""));
			continue;
		}
		try {
			const lexical = confined(root, file);
			if (lstatSync(lexical).isSymbolicLink()) {
				uninspectable.push(file);
				continue;
			}
			const real = realpathSync(lexical);
			const realRel = relative(root, real);
			if (realRel === ".." || realRel.startsWith("../") || isAbsolute(realRel) || !statSync(real).isFile()) uninspectable.push(file);
			else present.push(file);
		} catch {
			missing.push(file);
		}
	}
	return { present, missing, uninspectable };
}
