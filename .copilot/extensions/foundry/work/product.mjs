import { execFileSync } from "node:child_process";
import {changedFiles,commitAt,joinedIndex,retain,rootAt,withIndex} from "./objects.mjs";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { covers, fail, members, mixed, ownership, relative, roots } from "./values.mjs";
import { touchesCut } from "./transfer.mjs";
import {git,gitArgs,env,entries,regularFiles,pathKey,pathNames,blobIds,diskEntries} from "../../../skills/foundry/scripts/git-files.mjs";
export {git,entries,regularFiles,regularEntry,pathKey,blobText,artifactDigest,verifyTree} from "../../../skills/foundry/scripts/git-files.mjs";
export {checkedOverlay,withProduct} from "../../../skills/foundry/scripts/materialize.mjs";
/** @typedef {import("../../../skills/foundry/scripts/git-files.mjs").Entry} Entry */
export {changedFiles,commitAt,contractPaths,contractConflict,outside,rolloutFiles,rootAt,verifyContracts} from "./objects.mjs";
/** @param {string} cwd @param {string} tip @param {string} ancestor */
export function descendsFrom(cwd,tip,ancestor) {
	try { git(cwd,["merge-base","--is-ancestor",ancestor,tip]); return true; }
	catch (error) {
		if (error instanceof Error && "status" in error && error.status===1) return false;
		throw error;
	}
}
/** @param {string} cwd @param {string} commit @param {string[]} paths */
export const versionOf = (cwd, commit, paths) => createHash("sha256").update(git(cwd, ["ls-tree", "--full-tree", "-z", commit, "--", ...paths])).digest("hex");

/** @param {string} cwd @param {string} commit @param {string} filename */
export function committedFile(cwd, commit, filename) {
	const [entry] = regularFiles(cwd, commit, [filename]);
	return git(cwd, ["cat-file", "blob", entry.oid]);
}

/** @param {string} cwd @param {Entry[]} items */
function build(cwd, items) {
	pathNames(items);
	return git(cwd, ["mktree", "-z"], items.map(e => `${e.mode} ${e.type} ${e.oid}\t${e.name}\0`).join("")).toString().trim();
}

/** @param {string} cwd @param {string} tree @param {string} directory */
function subtree(cwd, tree, directory) {
	const found = entries(cwd, tree, false, [relative(directory)])[0];
	if (found && found.type !== "tree")
		fail("tree_conflict", `${directory} is not a directory`);
	return found?.oid ?? null;
}

/** @param {string} cwd @param {string} revision @param {string} directory */
export function directoryBaseline(cwd, revision, directory) {
	const tree = subtree(cwd, revision, directory);
	return tree ? { directory, revision, tree } : undefined;
}

/** A new subtree may be absent, but none of its ancestors can be a file or a differently spelled alias.
 * @param {string} cwd @param {string} commit @param {string} directory */
export function checkDirectory(cwd,commit,directory) {
	let tree=commit;
	for (const part of relative(directory).split("/")) {
		const e=entries(cwd,tree).find(e=>pathKey(e.name)===pathKey(part));
		if (!e) return;
		if (e.name!==part || e.type!=="tree") fail("tree_conflict",`Not an unambiguous directory at ${commit}:${directory}`);
		tree=e.oid;
	}
}

/** @param {string} cwd @param {string} revision @param {import("./model.js").Scope} scope */
export function inventory(cwd, revision, scope) {
	if (mixed(scope)) return directoryBaseline(cwd,revision,scope.primary);
	if (!Array.isArray(scope)) return directoryBaseline(cwd,revision,scope);
	const found = scope.flatMap(dir => directoryBaseline(cwd,revision,dir) ?? []);
	return found.length ? found : undefined;
}

/** @param {import("./model.js").Inventory} source */
export const describeInventory = source => members(source).map(b=>`${b.revision}:${b.directory}/ (tree ${b.tree})`).join(", ");

/** @param {string} cwd @param {string} revision @param {string} directory */
export function verifyDirectoryPin(cwd, revision, directory) {
	if (git(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${revision}\n`).toString().trimEnd() !== `${revision} commit`)
		fail("invalid_baseline", `Expected a full local commit ID: ${revision}`);
	if (!directoryBaseline(cwd, revision, directory))
		fail("invalid_baseline", `No prior directory at ${revision}:${directory}`);
}

/** @param {string} cwd @param {string|null} tree @param {string} directory @param {string|null} replacement @param {string|null} [expected] @returns {string|null} */
function replace(cwd, tree, directory, replacement, expected) {
	const [name, ...tail] = relative(directory).split("/");
	const items = tree ? entries(cwd, tree) : [], child = items.find(e => e.name === name);
	if (child && child.type !== "tree")
		fail("tree_conflict", `Non-directory at ${name}`);
	let value = replacement;
	const current = child?.oid ?? null;
	if (tail.length)
		value = replace(cwd, current, tail.join("/"), replacement, expected);
	else if (expected !== undefined && current !== expected && current !== replacement)
		fail("tree_conflict", `Concurrent modification of ${directory}`);
	if (current === value)
		return tree;
	const rest = items.filter(e => e.name !== name);
	if (value)
		rest.push({ name, type: "tree", mode: "040000", oid: value });
	return rest.length ? build(cwd, rest) : null;
}

export {retain} from "./objects.mjs";

/** Pin only the explicitly selected file, including untracked or binary data. Never touch the index.
 * @param {string} cwd @param {string} file */
function diskBlob(cwd, file) {
	const source = path.join(cwd, relative(file));
	const stat = lstatSync(source);
	if (!stat.isFile() || stat.nlink !== 1 || realpathSync(source) !== source || stat.dev !== lstatSync(cwd).dev)
		fail("unsupported_tree", `Expected a regular, unlinked file: ${file}`);
	const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || realpathSync(source) !== source)
			fail("artifact_changed", `File changed during publication: ${file}`);
		const oid = execFileSync("git", gitArgs(cwd, ["hash-object", "-w", "--stdin"]), { env, stdio: [fd, "pipe", "pipe"] }).toString().trim();
		const after = fstatSync(fd);
		if (opened.ctimeMs !== after.ctimeMs || opened.size !== after.size) fail("artifact_changed", `File changed during publication: ${file}`);
		return {name:path.basename(file),oid,type:"blob",mode:opened.mode & 0o100 ? "100755" : "100644"};
	} finally { closeSync(fd); }
}

/** @param {string} cwd @param {string} file */
export const pinFile = (cwd,file) => retain(cwd,diskBlob(cwd,file).oid);

/** Replace an existing regular blob only. An absent path or a tree is never an empty file grant.
 * @param {string} cwd @param {string} tree @param {string} file @param {Entry} replacement @param {Entry} expected */
function replaceFile(cwd, tree, file, replacement, expected) {
	const [name,...tail]=relative(file).split("/"), items=entries(cwd,tree), child=items.find(e=>e.name===name);
	if (!child) fail("tree_conflict",`Missing exact file: ${file}`);
	if (tail.length) {
		if (child.type!=="tree") fail("tree_conflict",`Not a directory: ${name}`);
		child.oid=replaceFile(cwd,child.oid,tail.join("/"),replacement,expected);
	} else {
		if (!["100644","100755"].includes(child.mode) || ![expected,replacement].some(e=>e.mode===child.mode && e.oid===child.oid))
			fail("tree_conflict",`Concurrent modification of exact file: ${file}`);
		child.oid=replacement.oid; child.mode=replacement.mode;
	}
	return build(cwd,items);
}

/** @param {string} cwd @param {string|null} tree @param {string} label @param {string} [parent] */
function commitTree(cwd, tree, label, parent) {
	return git(cwd, ["-c", "commit.gpgSign=false", "commit-tree", tree ?? build(cwd, []), ...(parent ? ["-p", parent] : [])], `${label}\n`).toString().trim();
}
/** @param {string} cwd @param {string|null} tree @param {string} label @param {string} [parent] */
const pin=(cwd,tree,label,parent)=>retain(cwd,commitTree(cwd,tree,label,parent));

/** @param {string} cwd @param {string} commit */
export const treeOf = (cwd, commit) => git(cwd, ["rev-parse", "--verify", `${commit}^{tree}`]).toString().trim();
/** Omit the removed scope for a successor starting with the checked product in a parentless generation.
 * @param {string} cwd @param {string} commit @param {import("./model.js").Scope} [directory] */
export function withoutGrain(cwd, commit, directory) {
	/** @type {string|null} */ let tree = treeOf(cwd,commit);
	if (directory) for (const dir of ownership(directory).directories) tree = replace(cwd,tree,dir,null);
	return pin(cwd,tree,"Foundry generation base");
}

/** @param {string} root @param {string} directory @param {import("./model.js").Retained[]} [cuts] */
function grainTree(root, directory,cuts) {
	let dir = root;
	for (const part of relative(directory).split("/")) {
		dir = path.join(dir, part);
		const stat = lstatSync(dir, { throwIfNoEntry: false });
		if (!stat) return null;
		if (!stat.isDirectory() || realpathSync(dir) !== dir) fail("unsupported_tree", `Invalid grain directory: ${dir}`);
	}
	const files = diskEntries(dir,undefined,false,cuts && (name=>cuts.some(c=>roots(c).some(p=>pathKey(p)===pathKey(`${directory}/${name}`))))).filter(e=>e.mode!=="040000");
	if (!files.length) return null;
	pathNames(files);
	const ids = blobIds(root, files.map(f => `./${directory}/${f.name}`), true);
	return withIndex(root, staged => {
		staged(["update-index", "-z", "--index-info"], files.map((f, i) => `${f.mode} ${ids[i]}\t${f.name}\0`).join(""));
		// update-index can exit successfully after ignoring a path. Never publish a partial directory.
		const indexed = new Set(staged(["ls-files", "-z"]).toString().split("\0"));
		for (const f of files) if (!indexed.has(f.name)) fail("unsupported_tree", `Git cannot index ${f.name}`);
		return staged(["write-tree"]).toString().trim();
	});
}

/** @param {string} cwd @param {string} generation */
export function generationRoot(cwd, generation) {
	const root = rootAt(cwd);
	const [local, common, head] = git(root, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "HEAD"]).toString().trimEnd().split("\n");
	if (head !== generation || local === common)
		fail("wrong_workspace", "Submit from the assigned native worktree at its frozen generation base");
	return root;
}

/** Compose a subtree from owned entries of one tree and transferred entries of the other.
 * Both tree IDs are relative to directory. Refuse case aliases and file/directory collisions.
 * @param {string} cwd @param {string} directory @param {string|null} owned @param {string|null} excluded
 * @param {import("./model.js").Retained[]} cuts */
function partition(cwd,directory,owned,excluded,cuts) {
	const take=(/** @type {string|null} */ tree,/** @type {boolean} */ transferred)=>(tree ? entries(cwd,tree,true) : []).filter(e=>{
		const p=`${directory}/${e.name}`, match=cuts.some(c=>covers(c,p));
		if (!match && touchesCut(cuts,p)) fail("tree_conflict",`Path aliases or changes the type of a transferred path: ${p}`);
		return match===transferred;
	});
	const items=[...take(owned,false),...take(excluded,true)];
	if (!items.length) return null;
	pathNames(items);
	return withIndex(cwd,staged=>{
		staged(["update-index","-z","--index-info"],items.map(e=>`${e.mode} ${e.oid}\t${e.name}\0`).join(""));
		const tree=staged(["write-tree"]).toString().trim();
		if (entries(cwd,tree,true).length!==items.length) fail("tree_conflict","Cannot represent the retained package without losing a path");
		return tree;
	});
}

/** @param {string} cwd @param {string} generation @param {import("./model.js").Scope} directory
 * @param {import("./model.js").Retained[]} [cuts] @param {string} [checkpoint] */
export function capture(cwd, generation, directory,cuts,checkpoint) {
	const root = generationRoot(cwd, generation);
	/** @type {string|null} */ let tree = treeOf(root,generation);
	const scope=ownership(directory);
	for (const dir of scope.directories) {
		const owned=grainTree(root,dir,cuts);
		tree=replace(root,tree,dir,cuts ? partition(root,dir,owned,subtree(root,checkpoint ?? fail("stale_assignment","Missing retained parent checkpoint"),dir),cuts) : owned);
	}
	for (const file of scope.files) {
		const [original]=regularFiles(root,generation,[file]);
		tree=replaceFile(root,tree ?? fail("tree_conflict","Missing exact file tree"),file,diskBlob(root,file),original);
	}
	return pin(root,tree,"Foundry grain candidate");
}

/** @typedef {{directory:string,from:string,to:string,exact?:boolean,retained?:import("./model.js").Retained[]}} Update */
/** @param {string} cwd @param {string} base @param {Update[]} updates */
export function combinedTree(cwd, base, updates) {
	/** @type {string|null} */ let tree = treeOf(cwd, base);
	for (const { directory, from, to, exact, retained } of updates) {
		if (exact) {
			tree=replaceFile(cwd,tree ?? fail("tree_conflict","Missing exact file tree"),directory,
				regularFiles(cwd,to,[directory])[0],regularFiles(cwd,from,[directory])[0]);
			continue;
		}
		const before = from === base ? undefined : subtree(cwd, from, directory);
		if (retained) {
			const live=tree && subtree(cwd,tree,directory), after=subtree(cwd,to,directory);
			const replacement=partition(cwd,directory,after,live,retained);
			if (before!==undefined && live!==replacement && partition(cwd,directory,before,live,retained)!==live)
				fail("tree_conflict",`Concurrent modification of retained files in ${directory}`);
			tree=replace(cwd,tree,directory,replacement);
			continue;
		}
		try {
			tree = replace(cwd, tree, directory, subtree(cwd, to, directory), before);
		}
		catch (error) {
			if (error instanceof Error && "code" in error && error.code === "tree_conflict")
				fail("tree_conflict", `Concurrent modification of ${directory}: ${error.message}`);
			throw error;
		}
	}
	return tree ?? build(cwd, []);
}

/** @param {string} cwd @param {string} base @param {Update[]} updates @param {string} [parent] @param {string} [attribution] */
export function combine(cwd,base,updates,parent,attribution) {
	return pin(cwd,combinedTree(cwd,base,updates),attribution ? `Foundry product candidate\nChecked ownership restoration: ${attribution}` : "Foundry product candidate",parent);
}
/** Compute the exact non-release commit for consent without retaining a ref.
 * @param {string} cwd @param {string} base @param {Update[]} updates */
export const stageCheckpoint=(cwd,base,updates)=>commitTree(cwd,combinedTree(cwd,base,updates),"Foundry independent checkpoint",base);
/** Same tree, parent and commit identity as the ordinary join, without retaining an unapproved candidate.
 * @param {string} cwd @param {string} base @param {Update[]} updates @param {string} target */
export const stageDelivery=(cwd,base,updates,target)=>commitTree(cwd,combinedTree(cwd,base,updates),"Foundry product candidate",target);

/** @param {string} cwd @param {string} base @param {(staged:(args:string[],input?:string)=>Buffer)=>void} edit */
function stageTree(cwd,base,edit){
	return withIndex(cwd,staged=>{
		staged(["read-tree",base]);
		edit(staged);
		return staged(["write-tree"]).toString().trim();
	});
}

/** Apply bytes as data to a private index. Neither the real index nor any checkout is an input.
 * @param {string} cwd @param {string} base @param {string} target @param {string} patch */
export function stagePatch(cwd,base,target,patch){
	const tree=stageTree(cwd,base,staged=>{
		try{staged(["apply","--cached","--whitespace=nowarn","-"],patch);}
		catch(error){
			if(!(error instanceof Error && "status" in error && (error.status===1 || error.status===128)))throw error;
			fail("invalid_patch","The offered diff does not apply cleanly to the failed assembly");
		}
	});
	return commitTree(cwd,tree,"Foundry product candidate",target);
}

/** The last rollout can revert every helper to the target. Keep a distinct evaluator pin even then.
 * @param {string} cwd @param {string} target @param {string} patch */
export const stageHarness=(cwd,target,patch)=>patch?stagePatch(cwd,target,target,patch):commitTree(cwd,treeOf(cwd,target),"Foundry product candidate",target);

/** Generate the reviewable full-index diff from verified author result blobs, never from a working copy.
 * @param {string} cwd @param {string} base @param {import("./model.js").HarnessRollout["files"]} changes */
export function draftDiff(cwd,base,changes){
	const tree=stageTree(cwd,base,staged=>staged(["update-index","-z","--index-info"],changes.map(f=>
		`${f.result===null?"0":f.mode} ${f.result??"0".repeat(base.length)}\t${relative(f.file)}\0`).join("")));
	return git(cwd,["diff","--no-color","--no-ext-diff","--no-textconv","--no-renames","--full-index","--src-prefix=a/","--dst-prefix=b/",base,tree,"--"]).toString();
}

/** Replace only an existing regular blob on a private index, preserving its exact path and mode.
 * @param {string} cwd @param {string} base @param {string} file @param {string} blob */
export function stageTest(cwd,base,file,blob){
	const [e]=regularFiles(cwd,base,[file]);
	if(e.oid===blob)fail("unchanged_candidate","The proposed test repair has identical bytes");
	const tree=stageTree(cwd,base,staged=>staged(["update-index","-z","--index-info"],`${e.mode} ${blob}\t${e.name}\0`));
	return commitTree(cwd,tree,"Foundry test repair",base);
}

/** Pin effective changes, not patch headers, for independent consent and runner verification.
 * @param {string} cwd @param {string} from @param {string} to */
export function changedBlobs(cwd,from,to){
	const paths=changedFiles(cwd,from,to);
	if(!paths.length)fail("unchanged_candidate","The patch does not change the failed assembly");
	const before=regularFiles(cwd,from,paths), result=regularFiles(cwd,to,paths);
	return before.map((b,i)=>{
		const r=result[i];
		if(b.mode!==r.mode || b.oid===r.oid)fail("invalid_patch",`Only content changes to existing regular files are eligible: ${b.name}`);
		return {file:b.name,mode:b.mode,before:b.oid,result:r.oid};
	});
}

/** @param {string} cwd @param {string} tree */
export const pairedCommit=(cwd,tree)=>pin(cwd,tree,"Foundry paired observation");
/** Carry the actual checkpoint delta onto a moved target, not a reconstruction from past jobs.
 * read-tree does only trivial three-way merges; no worktree, content merge drivers or real index.
 * @param {string} cwd @param {import("./model.js").Product} last @param {string} target @param {boolean} [keep]
 * @param {(stages:Buffer)=>import("./model.js").Resolution[]} [resolve] */
export function rejoin(cwd, last, target, keep=true,resolve) {
	return joinedIndex(cwd,last,target,staged=>(keep?pin:commitTree)(cwd,staged(["write-tree"]).toString().trim(),"Foundry checkpoint on new target"),resolve);
}
