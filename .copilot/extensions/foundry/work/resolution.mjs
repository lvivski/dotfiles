import { isUtf8 } from "node:buffer";
import { git, outside, rejoin } from "./product.mjs";
import { fail, fields, record, relative } from "./values.mjs";

/** @typedef {import("./model.js").Resolution} Resolution */
/** @param {unknown} value @returns {Resolution[]} */
export function resolutions(value) {
	if (value===undefined) return [];
	if (!Array.isArray(value) || !value.length) fail("invalid_resolution","Expected a nonempty exact file resolution list");
	const files=new Set();
	return value.map(raw=>{
		const r=record(raw), file=relative(r.file), mode=r.mode;
		fields(r,["file","mode","base","checkpoint","target","result"]);
		const key=file.normalize("NFC").toLowerCase();
		if (files.has(key) || mode!=="100644" && mode!=="100755") fail("invalid_resolution",`Duplicate path or invalid resolution mode: ${file}`);
		files.add(key);
		/** @param {unknown} id */
		const oid=id=>typeof id==="string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id) ? id : fail("invalid_resolution",`Expected a full resolution blob ID: ${file}`);
		const ids=[r.base,r.checkpoint,r.target,r.result].map(oid), [base,checkpoint,target,result]=ids;
		if (new Set(ids).size!==4 || ids.some(id=>id.length!==base.length)) fail("invalid_resolution",`Expected four distinct resolution blobs: ${file}`);
		return {file,mode,base,checkpoint,target,result};
	});
}

/** Preserve line endings and the final newline. Only an exact, unique, reversible replacement is eligible.
 * @param {string} base @param {string} checkpoint @param {string} target @param {string} file */
export function replacement(base,checkpoint,target,file) {
	const a=base.match(/[^\n]*\n|[^\n]+$/g) ?? [], b=target.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let start=0, end=0;
	while (start<a.length && start<b.length && a[start]===b[start]) start++;
	while (end<a.length-start && end<b.length-start && a[a.length-1-end]===b[b.length-1-end]) end++;
	const before=a.slice(start,a.length-end).join(""), after=b.slice(start,b.length-end).join("");
	/** @param {string} s @param {string} span */
	function position(s,span) {
		const i=s.indexOf(span);
		if (!span || i<0 || s.indexOf(span,i+1)!==-1 || i>0 && s[i-1]!=="\n" || !span.endsWith("\n") && i+span.length!==s.length)
			fail("invalid_resolution",`No unique whole-line resolution for ${file}`);
		return i;
	}
	position(base,before);position(target,after);
	const at=position(checkpoint,before), result=checkpoint.slice(0,at)+after+checkpoint.slice(at+before.length);
	if (position(result,after)!==at) fail("invalid_resolution",`Resolution is not reversible: ${file}`);
	return {before,after,result};
}

/** @param {string} cwd @param {string} id @param {string} file */
function readText(cwd,id,file) {
	const bytes=git(cwd,["cat-file","blob",id]);
	if (!isUtf8(bytes) || bytes.includes(0)) fail("invalid_resolution",`Expected a regular UTF-8 text resolution: ${file}`);
	return bytes.toString();
}

/** @param {string} cwd @param {import("./model.js").Product} last @param {string} target @param {unknown} input @param {string[]} conserved
 * @param {{id:string,directory:import("./model.js").Scope}[]} [owners] When preparing a proposal, derive only unique reversible replacements outside every included grant. */
export function reconciledBase(cwd,last,target,input,conserved,owners) {
	const rows=resolutions(input);
	/** @type {string[]} */ const details=[];
	const base=rejoin(cwd,last,target,false,rows.length || owners ? stages=>{
		if (!isUtf8(stages)) fail("invalid_resolution","Non-UTF-8 conflict paths cannot be reconciled");
		const supplied=new Map(rows.map(r=>[r.file,r]));
		/** @type {Map<string,Map<string,{mode:string,oid:string}>>} */ const conflicts=new Map();
		for(const entry of stages.toString().split("\0").filter(Boolean)){
			const match=/^([0-7]+) ([a-f0-9]+) ([123])\t(.+)$/s.exec(entry)??fail("invalid_resolution","Invalid staged conflict");
			const [,mode,oid,stage,path]=match,file=relative(path), group=conflicts.get(file)??new Map();
			group.set(stage,{mode,oid});conflicts.set(file,group);
		}
		for(const [file,group] of conflicts){
			const a=group.get("1"), b=group.get("3"), c=group.get("2"), given=supplied.get(file);
			if(!given && !owners)fail("tree_conflict",`Unlisted conflict or mismatched resolution input: ${file}`);
			if(!a || !b || !c || a.mode!=="100644" && a.mode!=="100755" || b.mode!==a.mode || c.mode!==a.mode ||
				given && (given.mode!==a.mode || given.base!==a.oid || given.checkpoint!==b.oid || given.target!==c.oid))
				fail("invalid_resolution",`No exact three-stage regular-file resolution: ${file}`);
			if(!outside(file,conserved))fail("contract_scope",`Cannot reconcile a conserved contract file: ${file}`);
			const owner=owners?.find(o=>!outside(o.directory,[file]));
			if(owner)fail("tree_conflict",`Target edited owned output ${owner.id}: ${file}. No automatic resolution is eligible.`);
			const {before,after,result}=replacement(readText(cwd,a.oid,file),readText(cwd,b.oid,file),readText(cwd,c.oid,file),file);
			const oid=git(cwd,["hash-object","--stdin"],result).toString().trim();
			if(given && oid!==given.result)fail("invalid_resolution",`The exact replacement does not produce the reviewed resolution blob: ${file}`);
			const r=given??resolutions([{file,mode:a.mode,base:a.oid,checkpoint:b.oid,target:c.oid,result:oid}])[0];
			if(!given)rows.push(r);
			supplied.delete(file);git(cwd,["hash-object","-w","--stdin"],result);
			details.push(`${JSON.stringify(r)}\nReplace ${JSON.stringify(before)} with ${JSON.stringify(after)} once in the checkpoint.`);
		}
		if(supplied.size)fail("invalid_resolution",`Resolution is not an exact three-stage conflict: ${supplied.keys().next().value}`);
		return rows;
	} : undefined);
	return {base,rows,details};
}
