import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { changedFiles, commitAt, entries, git, rootAt, verifyTree, versionOf } from "../../../extensions/foundry/work/product.mjs";
import { contains, fail, record, relative, text } from "../../../extensions/foundry/work/values.mjs";

/** @param {unknown} ok @param {string} reason @returns {asserts ok} */
function requireProof(ok, reason) { if (!ok) fail("keep_writer", reason); }
/** @param {unknown} value */
function oid(value) {
	requireProof(typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value), "Expected a full checked object ID");
	return value;
}
/** @param {string} file */
function regular(file) {
	const s = lstatSync(file);
	requireProof(s.isFile() && s.nlink === 1 && realpathSync(file) === file, "Linked or special file");
	return s;
}

/** Reject private Git state that removing a worktree could lose, including an earlier, reset-away HEAD.
 * Deliberately supports only ordinary files-backend linked worktrees.
 * @param {string} owner @param {string} root @param {string} generation @param {string|null} branch */
function linkedWriter(owner, root, generation, branch) {
	requireProof(root === realpathSync(root) && root === rootAt(root) && owner === rootAt(owner) &&
		!contains(owner, root) && !contains(root, owner), "Expected separate canonical owner and writer worktree roots");
	const commonOf = (/** @type {string} */ dir) => realpathSync(git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trimEnd());
	const common = commonOf(owner), admin = git(root, ["rev-parse", "--absolute-git-dir"]).toString().trimEnd();
	regular(path.join(root, ".git"));
	requireProof(commonOf(root) === common && path.dirname(admin) === path.join(common, "worktrees") &&
		admin === realpathSync(admin), "Writer is not a linked worktree of the owner's repository");
	const backlink = path.join(admin, "gitdir");
	regular(backlink);
	requireProof(path.resolve(admin, readFileSync(backlink, "utf8").trimEnd()) === path.join(root, ".git"), "Worktree registration points elsewhere");
	const registered = git(owner, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0\0");
	const rows = registered.filter(row => row.startsWith(`worktree ${root}\0`));
	requireProof(rows.length === 1 && rows[0] === [`worktree ${root}`, `HEAD ${generation}`, branch === null ? "detached" : `branch ${branch}`].join("\0") &&
		(branch === null || registered.filter(row => row.split("\0").includes(`branch ${branch}`)).length === 1),
		"Worktree registration, lock, branch or generation changed");
	requireProof(commitAt(root, "HEAD") === generation, "Writer left its frozen generation");
	for (const item of readdirSync(admin)) {
		const file = path.join(admin, item);
		if (item === "logs" || item === "refs") {
			requireProof(lstatSync(file).isDirectory() && readdirSync(file).every(s => item === "logs" && s === "HEAD"), "Additional private Git refs or logs");
		} else {
			requireProof(["HEAD", "ORIG_HEAD", "index", "gitdir", "commondir"].includes(item), "Private Git work, lock or unknown metadata");
			regular(file);
			if (item === "ORIG_HEAD") requireProof(readFileSync(file, "utf8").trimEnd() === generation, "Another revision in ORIG_HEAD");
		}
	}
	for (const log of [path.join(admin, "logs/HEAD"), ...(branch ? [path.join(common, "logs", branch)] : [])]) {
		regular(log);
		const lines = readFileSync(log, "utf8").trimEnd().split("\n"), first = `${"0".repeat(generation.length)} ${generation} `;
		requireProof(lines[0].startsWith(first) && lines.slice(1).every(line => line.startsWith(`${generation} ${generation} `)), "Unverified worktree or branch history");
	}
}

/** A capture is generation + the whole new grain, not a commit on the writer's branch.
 * Compare the real index to the generation, raw disk to the capture, and its grain to the qualified product.
 * @param {string} owner @param {string} root @param {string} generation @param {string} candidate @param {string} directory @param {string} commit */
function verifyCapture(owner, root, generation, candidate, directory, commit) {
	for (const sha of [generation, candidate, commit])
		requireProof(commitAt(owner, `refs/foundry/objects/${sha}`) === sha, "Foundry object no longer pinned");
	requireProof(changedFiles(owner, generation, candidate).every(p => contains(directory, p)) &&
		versionOf(owner, candidate, [directory]) === versionOf(owner, commit, [directory]), "Capture is not the included grain");
	const index = new Set(git(root, ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "-v", "--stage", "--resolve-undo", "-z"]).toString().split("\0").filter(Boolean));
	const base = entries(owner, generation, true);
	requireProof(index.size === base.length && base.every(e => index.has(`H ${e.mode} ${e.oid} 0\t${e.name}`)), "Index differs from the generation");
	verifyTree(owner, root, entries(owner, candidate, true), true);
}

/** Read-only skill preflight; native observations must be collected anew by the actual owner.
 * The second pass only describes a single native call. It cannot grant consent or execute it.
 * @param {string} cwd @param {string} phase @param {unknown} input */
export function archiveCheck(cwd, phase, input) {
	const data = record(input), h = record(data.handoff), n = record(data.native);
	requireProof(phase === "offer" || phase === "recheck", "Use offer or recheck");
	const owner = text(h.owner, "Foundry owner"), id = text(n.id, "native session ID");
	requireProof(n.caller === owner && n.coordinator === owner && id !== owner && Array.isArray(h.writers), "Unverified owner or direct native writer");
	const matches = h.writers.map(record).filter(w => w.id === id), [w] = matches;
	requireProof(matches.length === 1 && text(w.name, "bound writer name") === n.name, "Not this individually named finished writer");
	requireProof(n.workspace === "local-worktree" && n.activity === "idle" &&
		["ongoingWork", "openPR", "agentMerge", "automation", "nestedWork", "externalWork"].every(key => n[key] === false),
		"Native work, relationships, PR, Agent merge or automation not verified clear");
	const root = text(n.path, "native worktree root"), branch = n.branch;
	requireProof(branch === null || typeof branch === "string" && branch.startsWith("refs/heads/") && branch !== h.targetRef, "Unknown or target branch");
	const targetRef = text(h.targetRef, "target ref"), target = oid(h.target), commit = oid(h.commit);
	const generation = oid(w.generation), candidate = oid(w.candidate), directory = relative(w.directory);
	const offer = { run: text(h.run, "run"), owner, targetRef, target, commit, id, name: n.name, grain: text(w.grain, "grain"), directory, generation, candidate, path: root, branch };
	if (phase === "recheck") requireProof(isDeepStrictEqual(data.selected, offer), "Selection does not match this exact writer and product");
	requireProof(targetRef.startsWith("refs/heads/") && commitAt(cwd, targetRef) === target, "Checked target tip changed");
	linkedWriter(cwd, root, generation, branch);
	verifyCapture(cwd, root, generation, candidate, directory, commit);
	return phase === "offer" ? { offer } : { tool: "archive_session", arguments: { id } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv.length !== 3) throw new Error("Expected offer or recheck and one JSON document on stdin");
		console.log(JSON.stringify(archiveCheck(process.cwd(), process.argv[2], JSON.parse(readFileSync(0, "utf8")))));
	} catch (error) {
		console.error(`Keep writer: ${error instanceof Error && "code" in error ? `${error.code}: ` : ""}${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
