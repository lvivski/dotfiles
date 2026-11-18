import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCandidate } from "./artifacts.mjs";
import { FoundryError, digest, json } from "./values.mjs";

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) { throw new FoundryError(code, message); }
/** @param {string} oid */
function objectId(oid) {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) fail("delivery_object", "Expected an immutable local Git object");
	return oid;
}
/** @param {string} ref @returns {string} */
export function branchRef(ref) {
	if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || /(?:\.\.|\/\/|\/\.|\/$|\.$|\.lock(?:\/|$))/.test(ref)) {
		fail("delivery_ref", "Delivery authority must name one full, literal local branch ref");
	}
	return ref;
}
/** @param {string} databasePath @param {string[]} args @param {string|Buffer} [input] */
function git(databasePath, args, input) {
	const dir = path.dirname(path.dirname(databasePath));
	return execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-lazy-fetch", `--git-dir=${dir}`,
		"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "core.logAllRefUpdates=true", ...args], {
		env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "",
			GIT_AUTHOR_NAME: "Foundry", GIT_AUTHOR_EMAIL: "foundry@localhost", GIT_COMMITTER_NAME: "Foundry",
			GIT_COMMITTER_EMAIL: "foundry@localhost", GIT_AUTHOR_DATE: "@1 +0000", GIT_COMMITTER_DATE: "@1 +0000" },
		input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 30000,
	});
}
/** @param {string} db @param {string} ref @returns {string} */
export function targetTip(db, ref) {
	branchRef(ref);
	// symbolic-ref exits 1 specifically for a direct ref; inspection errors are not proof.
	const result = spawnSync("git", ["--git-dir", path.dirname(path.dirname(db)), "symbolic-ref", "--quiet", ref],
		{ env: { PATH: process.env.PATH }, encoding: "utf8" });
	if (result.status !== 1) fail("delivery_ref", "Cannot authorize an indirect or uninspectable target ref");
	const tip = objectId(git(db, ["show-ref", "--verify", "--hash", ref]).toString().trim());
	if (git(db, ["cat-file", "-t", tip]).toString().trim() !== "commit") fail("delivery_ref", "Target must directly name a commit");
	return tip;
}
/** @param {string} name */
function regularPath(name) {
	if (!/^[\x20-\x7e]+$/.test(name) || /[\\:]/.test(name) || name.split("/").some(part =>
		!part || part === "." || part === ".." || /\.git[ .]*$/i.test(part) || /[ .]$/.test(part))) {
		fail("delivery_tree_unsupported", "Product tree contains an unsupported or ambiguous filename");
	}
	return name;
}
/** @typedef {{mode:string,oid:string}} Entry */
/** @param {string} db @param {string} oid @returns {Map<string,Entry>} */
function tree(db, oid) {
	const bytes = git(db, ["ls-tree", "-r", "-z", objectId(oid)]);
	const entries = new Map(), aliases = new Set();
	for (const line of bytes.toString("utf8").split("\0").filter(Boolean)) {
		const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(line);
		if (!match) fail("delivery_tree_unsupported", "This host qualifies regular-file product trees only (no links or submodules)");
		const name = regularPath(match[3]);
		if (aliases.has(name.toLowerCase())) fail("delivery_tree_unsupported", "Case-aliased product paths cannot be materialized portably");
		aliases.add(name.toLowerCase());
		entries.set(name, { mode: match[1], oid: objectId(match[2]) });
	}
	return entries;
}
/** @param {Entry|undefined} left @param {Entry|undefined} right */
const same = (left, right) => left?.mode === right?.mode && left?.oid === right?.oid;

/** Build detached objects only; never use a checkout, ref or shared index as a staging area.
 * @param {string} db @param {string} expectedTip @param {{output:import("./model.d.ts").Output,base:string}[]} sources @returns {string} */
export function joinTree(db, expectedTip, sources) {
	const base = tree(db, expectedTip), merged = new Map(base);
	/** @type {Map<string,Entry>} */
	const changes = new Map();
	for (const source of sources) {
		const output = source.output;
		const candidate = readCandidate(output.reference, output.version, db);
		if (!candidate || candidate.reference !== path.join(path.dirname(db), "artifacts", output.version)) {
			fail("delivery_unpublished", "Join requires an immutable published output, not a mutable checkout or arbitrary path");
		}
		const original = tree(db, objectId(source.base));
		const files = candidate.files.filter(file => output.reference === candidate.reference || output.reference === path.join(candidate.reference, file.path));
		for (const file of files) {
			const name = regularPath(file.path);
			const content = readFileSync(path.join(candidate.reference, name));
			if (createHash("sha256").update(content).digest("hex") !== file.sha256) fail("candidate_changed", "Published bytes changed before joining");
			const entry = { mode: file.mode & 0o100 ? "100755" : "100644", oid: objectId(git(db,
				["hash-object", "-w", "--no-filters", "--stdin"], content).toString().trim()) };
			if (changes.has(name) && !same(changes.get(name), entry)
				|| !same(base.get(name), original.get(name)) && !same(base.get(name), entry)) {
				fail("delivery_conflict", `Required output conflicts with another delivery at ${name}; retain the published candidate`);
			}
			changes.set(name, entry);
			merged.set(name, entry);
		}
	}
	/** @param {[string,Entry][]} items @returns {string} */
	function build(items) {
		const leaves = new Map();
		/** @type {Map<string,[string,Entry][]>} */
		const directories = new Map();
		const aliases = new Map();
		for (const [pathname, file] of items) {
			const [name, ...tail] = pathname.split("/");
			if (aliases.has(name.toLowerCase()) && aliases.get(name.toLowerCase()) !== name) fail("delivery_conflict", "Case-conflicting product paths");
			aliases.set(name.toLowerCase(), name);
			if (tail.length) {
				const children = directories.get(name) ?? [];
				children.push([tail.join("/"), file]);
				directories.set(name, children);
			} else leaves.set(name, `${file.mode} blob ${file.oid}\t${name}\0`);
		}
		for (const [name, children] of directories) {
			if (leaves.has(name)) fail("delivery_conflict", "File/directory conflict in joined product");
			leaves.set(name, `040000 tree ${build(children)}\t${name}\0`);
		}
		return objectId(git(db, ["mktree", "-z"], [...leaves.values()].join("")).toString().trim());
	}
	return build([...merged]);
}

/** @param {string} db @param {string} treeId @param {string} expectedTip @param {string} id @returns {string} */
export function candidateCommit(db, treeId, expectedTip, id) {
	return objectId(git(db, ["commit-tree", objectId(treeId), "-p", objectId(expectedTip)], `Foundry delivery ${id}\n`).toString().trim());
}

/** @param {string} db @param {string} treeId @returns {string} */
export function materializeProduct(db, treeId) {
	const root = path.join(path.dirname(db), `product-${randomUUID()}`);
	mkdirSync(root, { mode: 0o700 });
	for (const [name, file] of tree(db, treeId)) {
		const filename = path.join(root, name);
		mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
		writeFileSync(filename, git(db, ["cat-file", "blob", file.oid]), { flag: "wx" });
		chmodSync(filename, file.mode === "100755" ? 0o755 : 0o644);
	}
	return root;
}
/** @param {string} db @param {string} treeId @param {string} root @returns {void} */
export function verifyProduct(db, treeId, root) {
	const entries = tree(db, treeId);
	/** @param {string} dir */
	function walk(dir) {
		for (const name of readdirSync(dir)) {
			const file = path.join(dir, name), stat = lstatSync(file);
			if (stat.isDirectory()) { walk(file); continue; }
			const key = path.relative(root, file), expected = entries.get(key);
			if (!expected || !stat.isFile() || stat.nlink !== 1 || realpathSync(file) !== path.join(realpathSync(root), key)
				|| (stat.mode & 0o777) !== (expected.mode === "100755" ? 0o755 : 0o644)
				|| git(db, ["hash-object", "--no-filters", "--stdin"], readFileSync(file)).toString().trim() !== expected.oid) {
				fail("product_changed", "Product acceptance must preserve its exact joined bytes and modes");
			}
			entries.delete(key);
		}
	}
	if (!lstatSync(root).isDirectory()) fail("product_changed", "Joined product directory was replaced");
	walk(root);
	if (entries.size) fail("product_changed", "Product acceptance removed joined files");
}

/** @typedef {{targetRef:string,expectedTip:string,newTip:string,tree:string}} Target */
/** @param {string} db @param {Target} target @param {string} token @returns {void} */
export function applyExpectedTip(db, target, token) {
	const { targetRef, expectedTip, newTip } = target;
	if (targetTip(db, targetRef) !== expectedTip) fail("delivery_stale_tip", "Target moved; prepare a new join and requalify it");
	const parent = git(db, ["rev-list", "--parents", "-1", objectId(newTip)]).toString().trim();
	if (parent !== `${newTip} ${objectId(expectedTip)}` || git(db, ["rev-parse", `${newTip}^{tree}`]).toString().trim() !== target.tree) {
		fail("delivery_non_fast_forward", "Only the exact qualified single-parent fast-forward can land");
	}
	const common = realpathSync(path.dirname(path.dirname(db)));
	// Never bypass a repository or host ref-transaction policy. The lease
	// protects configuration as well as worktree topology until CAS returns.
	const hooks = execFileSync("git", ["--git-dir", common, "rev-parse", "--path-format=absolute", "--git-path", "hooks/reference-transaction"],
		{encoding:"utf8"}).trim();
	if (!path.isAbsolute(hooks) || existsSync(hooks)) fail("delivery_ref_policy", "A reference-transaction hook needs a dedicated policy-aware landing adapter");
	const worktrees = git(db, ["worktree", "list", "--porcelain", "-z"]).toString().trimEnd().split("\0\0").filter(Boolean);
	for (const entry of worktrees) {
		const fields = entry.split("\0");
		if (!fields[0]?.startsWith("worktree ") || fields.some(f => f === "bare" || f.startsWith("prunable"))) {
			fail("delivery_checkout_unknown", "Cannot positively inspect every registered checkout");
		}
		const cwd = fields[0].slice(9);
		const dir = realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim());
		const rel = path.relative(common, dir);
		if (rel && !/^worktrees\/[A-Za-z0-9._-]+$/.test(rel) || ["rebase-merge","rebase-apply","BISECT_LOG"].some(name => existsSync(path.join(dir, name)))) {
			fail("delivery_checkout_unknown", "Worktree is in an ambiguous or reserved branch state");
		}
		const branch = fields.find(f => f.startsWith("branch "))?.slice(7);
		if (branch === targetRef) fail("delivery_checked_out", "Target is checked out; leave it and its files untouched");
		if (branch) branchRef(branch);
		else if (!fields.includes("detached")) fail("delivery_checkout_unknown", "Worktree HEAD is unobservable");
	}
	if (!worktrees.length) fail("delivery_checkout_unknown", "No observable local worktrees");
	// A qualified native lease freezes checkout and worktree topology across this
	// inspection and update. Git's expected-old-value lock independently excludes
	// concurrent updates of the target; it does NOT freeze worktree registration.
	try {
		git(db, ["update-ref", "--no-deref", "--create-reflog", "-m", `foundry-landing:${digest(json(token))}`,
			targetRef,newTip,expectedTip]);
	} catch (error) {
		// An explicit expected-old-value mismatch is a Git refusal, not an
		// unknown outcome. Other failures require original-intent reconciliation.
		if (error && typeof error === "object" && "stderr" in error && Buffer.isBuffer(error.stderr)
			&& /is at [a-f0-9]+ but expected [a-f0-9]+/.test(error.stderr.toString())) {
			fail("delivery_stale_tip", "Git refused the stale expected tip; prepare and qualify a new manifest");
		}
		throw error;
	}
}
/** @param {string} db @param {Target} target @param {string} token @returns {boolean} */
export function observedLanding(db, target, token) {
	// Tip equality alone does not establish who performed an uncertain update.
	const mark = `foundry-landing:${digest(json(token))}`;
	return git(db, ["reflog", "show", "--format=%H%x00%gs", branchRef(target.targetRef)]).toString()
		.split("\n").some(line => line === `${target.newTip}\0${mark}`);
}
