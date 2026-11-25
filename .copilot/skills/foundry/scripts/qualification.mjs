// Transfer objects for a trusted owner record. No Foundry installation, ledger or evaluator is needed.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";

const git = (args, input, out = "pipe") => execFileSync("git",
	["--no-pager", "--no-replace-objects", "--no-lazy-fetch", "-c", "core.hooksPath=/dev/null", ...args], {
		input, stdio: ["pipe", out, "pipe"], encoding: "utf8",
		env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "" },
	});
const oid = s => {
	if (typeof s !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s)) throw Error("Expected a full Git object ID");
	return s;
};

function objects(record) {
	const { product, goal } = record?.receipts ?? {};
	const passed = (r, commit) => r && r.commit === commit && r.exit === 0 && typeof r.check === "string" && r.check.length;
	const format = record?.ownership !== undefined ? "foundry-qualification/v4" : product?.evaluatorRevision !== undefined ? "foundry-qualification/v3" : goal?.evaluatorRevision !== undefined ? "foundry-qualification/v2" : "foundry-qualification/v1";
	if (record?.format !== format || goal?.productEvaluatorRevision !== product?.evaluatorRevision || !passed(product, record.commit) || !passed(goal, record.commit) ||
		product.check === goal.check || !Array.isArray(record.outputs)) throw Error("Expected the owner's exact goal qualification record");
	if (record.ownership && Object.keys(record.ownership).sort().join("\0")!==record.outputs.map(o=>o.id).sort().join("\0"))
		throw Error("Ownership map does not match the checked output IDs");
	const pins = [record.commit, record.contract.commit, record.target.commit];
	if (product.evaluatorRevision !== undefined) pins.push(oid(product.evaluatorRevision));
	if (goal.evaluatorRevision !== undefined) pins.push(oid(goal.evaluatorRevision));
	for (const out of record.outputs) {
		if (!passed(out.receipt, out.commit) || !out.inputs || typeof out.inputs !== "object" || Array.isArray(out.inputs))
			throw Error("Missing included component receipt or input pins");
		pins.push(out.commit, out.base, out.generation, ...Object.values(out.inputs));
		if (out.replaces !== undefined) pins.push(out.replaces);
	}
	return [...new Set(pins.map(oid))].sort();
}

try {
	const [action, filename, ...extra] = process.argv.slice(2);
	if (!["pack", "import"].includes(action) || !filename || extra.length)
		throw Error("Usage: node qualification.mjs pack|import BUNDLE < qualification.json");
	const file = path.resolve(filename), ids = objects(JSON.parse(readFileSync(0, "utf8")));
	const refs = ids.map(id => `refs/foundry/objects/${id}`);
	const heads = ids.map((id, i) => `${id} ${refs[i]}`).join("\n");
	const exactHeads = listing => {
		if (listing.trimEnd().split("\n").sort().join("\n") !== heads) throw Error("Bundle heads do not match the exact qualification pins");
	};
	const checkCommits = () => {
		const types = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], ids.join("\n") + "\n");
		if (types.trimEnd() !== ids.map(id => `${id} commit`).join("\n")) throw Error("Missing or non-commit qualification pin");
	};
	if (action === "pack") {
		checkCommits();
		if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false") throw Error("Export from a complete source repository");
		const fd = openSync(file, "wx", 0o600); // Never overwrite an earlier export.
		try {
			git(["bundle", "create", "-", "--stdin"], refs.join("\n") + "\n", fd);
			exactHeads(git(["bundle", "list-heads", file]));
		} catch (error) { unlinkSync(file); throw error; } finally { closeSync(fd); }
	} else {
		exactHeads(git(["bundle", "list-heads", file]));
		git(["bundle", "verify", file]);
		exactHeads(git(["-c", "transfer.fsckObjects=true", "bundle", "unbundle", file]));
		checkCommits();
		// One create-only transaction. No target, branch, tag, FETCH_HEAD or network involved.
		git(["update-ref", "--no-deref", "--stdin"], refs.map((ref, i) => `create ${ref} ${ids[i]}\n`).join(""));
	}
	console.log(`${action === "pack" ? "Bundled" : "Retained"} ${ids.length} qualification pins; no branch updated.`);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
