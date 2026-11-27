import {entries,git,pathKey,pathNames,regularFiles} from "../../../skills/foundry/scripts/git-files.mjs";
import {isUtf8} from "node:buffer";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {contains,fail,roots} from "./values.mjs";

/** @param {import("./model.js").Scope} dir @param {string[]} paths */
export const outside = (dir, paths) => roots(dir).every(root => !paths.some(p => {
	const a = pathKey(root), b = pathKey(p);
	return contains(a, b) || contains(b, a);
}));

/** @param {string} cwd @param {string} base @param {string} file @param {string} excerpt */
export function citedText(cwd,base,file,excerpt){
	const [entry]=regularFiles(cwd,base,[file]),bytes=git(cwd,["cat-file","blob",entry.oid]);
	return !!excerpt && !bytes.includes(0) && isUtf8(bytes) && bytes.toString("utf8").includes(excerpt);
}

/** @param {string} cwd @param {string} ref */
export const commitAt=(cwd,ref)=>git(cwd,["rev-parse","--verify","--end-of-options",`${ref}^{commit}`]).toString().trim();
/** @param {string} cwd */
export const rootAt=cwd=>realpathSync(git(cwd,["rev-parse","--show-toplevel"]).toString().trim());

/** @typedef {(args:string[],input?:string)=>Buffer} Staged */
/** @template T @param {string} cwd @param {(staged:Staged)=>T} use */
export function withIndex(cwd,use){
	const dir=mkdtempSync(path.join(tmpdir(),"foundry-index-"));
	try{return use((args,input)=>git(cwd,["-c","core.splitIndex=false","-c","core.sparseCheckout=false","-c","core.fsmonitor=false",...args],input,path.join(dir,"index")));}
	finally{rmSync(dir,{recursive:true,force:true});}
}

/** Trivial three-way rejoin, never content merge drivers or the user's index.
 * @template T @param {string} cwd @param {import("./model.js").Product} last @param {string} target @param {(staged:Staged)=>T} use
 * @param {(stages:Buffer)=>import("./model.js").Resolution[]} [resolve] */
export function joinedIndex(cwd,last,target,use,resolve){
	return withIndex(rootAt(cwd),staged=>{
		staged(["read-tree","-i","-m","--aggressive",last.target,target,last.commit]);
		const stages=staged(["ls-files","--unmerged","-z"]);
		if(resolve){
			const rows=resolve(stages);
			staged(["update-index","-z","--index-info"],rows.map(r=>`${r.mode} ${r.result}\t${r.file}\0`).join(""));
		}else if(stages.length){
			const [conflict]=stages.toString().split("\0",1);
			fail("tree_conflict",`Concurrent modification since checkpoint: ${conflict.slice(conflict.indexOf("\t")+1)}`);
		}
		return use(staged);
	});
}

/** Compare all staged entries without writing a commit, tree or retention ref.
 * @param {string} cwd @param {import("./model.js").Product} last @param {string} target @param {string} commit */
export const isRejoined=(cwd,last,target,commit)=>git(cwd,["show","-s","--format=%P",commit]).toString().trim()===target &&
	joinedIndex(cwd,last,target,staged=>!staged(["diff-index","--cached","--no-ext-diff","--ignore-submodules=none","--name-only","-z",commit,"--"]).length);

/** @param {string} cwd @param {string} from @param {string} to @param {string[]} [paths] @param {number} [maxBytes] */
export function changedFiles(cwd,from,to,paths=[],maxBytes){
	const raw=git(cwd,["diff-tree","--no-ext-diff","--no-renames","--ignore-submodules=none","-r","--name-only","-z",from,to,"--",...paths],undefined,undefined,maxBytes);
	if(!isUtf8(raw))fail("unsupported_tree","Non-UTF-8 changed paths cannot be represented");
	return raw.toString().split("\0").filter(Boolean);
}

/** @param {import("./model.js").Policy} policy */
export const contractPaths=policy=>policy.sharedBrief || policy.contractTarget?[...policy.files,".foundry"]:policy.files;
/** @param {string} cwd @param {import("./model.js").Policy} policy @param {string} commit */
export function contractConflict(cwd,policy,commit){
	const base=policy.contractTarget??policy.base;
	if(commit!==base){
		const changed=changedFiles(cwd,base,commit,contractPaths(policy));
		if(changed.length)return `The conserved contract changed: ${changed.join(", ")}`;
	}
}
/** @param {string} cwd @param {import("./model.js").Policy} policy @param {string} commit */
export function verifyContracts(cwd,policy,commit){
	const conflict=contractConflict(cwd,policy,commit);
	if(conflict)fail("contract_changed",conflict);
}

/** Complete text-file changes with actual modes and preimages, independent of
 * how permission for the change is sought.
 * @param {string} cwd @param {string} from @param {string} to */
export function rolloutFiles(cwd,from,to){
	const paths=changedFiles(cwd,from,to);
	if(!paths.length)fail("unchanged_candidate","No effective changes");
	const before=new Map(entries(cwd,from,false,paths).map(b=>[b.name,b]));
	const after=new Map(entries(cwd,to,false,paths).map(e=>[e.name,e]));
	pathNames([...entries(cwd,to,true),...before.values()]);
	return paths.map(file=>{
		const b=before.get(file),r=after.get(file),mode=r?.mode??b?.mode;
		if(!mode || !["100644","100755"].includes(mode) || b && r && (b.mode!==r.mode || b.oid===r.oid))
			fail("invalid_patch",`Unsupported mode or type change: ${file}`);
		for(const e of [b,r])if(e){
			const bytes=git(cwd,["cat-file","blob",e.oid]);
			if(!isUtf8(bytes) || bytes.includes(0))fail("invalid_patch",`Not reviewable text: ${file}`);
		}
		return {file,mode,before:b?.oid??null,result:r?.oid??null};
	});
}

/** @param {string} cwd @param {string} oid */
export function retain(cwd, oid) {
	git(cwd, ["update-ref", "--no-deref", `refs/foundry/objects/${oid}`, oid]);
	return oid;
}

/** @param {string} cwd @param {{json:string,legacy:boolean}} value */
export function retainFeedback(cwd, { json, legacy }) {
	const oid = git(cwd, ["hash-object", "-w", "--stdin"], json).toString().trim();
	return { blob: retain(cwd, oid), ...(legacy ? { legacy: true } : {}) };
}
