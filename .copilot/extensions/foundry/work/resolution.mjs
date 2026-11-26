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

/** @param {string} cwd @param {import("./model.js").Product} last @param {string} target @param {unknown} input @param {string[]} conserved */
export function reconciledBase(cwd,last,target,input,conserved) {
	const rows=resolutions(input);
	/** @type {string[]} */ const details=[];
	const base=rejoin(cwd,last,target,false,rows.length ? stages=>{
		const expected=new Set(rows.flatMap(r=>[`${r.mode} ${r.base} 1\t${r.file}`,`${r.mode} ${r.target} 2\t${r.file}`,`${r.mode} ${r.checkpoint} 3\t${r.file}`]));
		if (!isUtf8(stages)) fail("invalid_resolution","Non-UTF-8 conflict paths cannot be reconciled");
		for (const entry of stages.toString().split("\0").filter(Boolean)) if (!expected.delete(entry))
			fail("tree_conflict",`Unlisted conflict or mismatched resolution input: ${entry.slice(entry.indexOf("\t")+1)}`);
		if (expected.size) fail("invalid_resolution",`Resolution is not an exact three-stage conflict: ${[...expected][0].split("\t")[1]}`);
		for (const r of rows) {
			if (!outside(r.file,conserved)) fail("contract_scope",`Cannot reconcile a conserved contract file: ${r.file}`);
			const read=/** @param {string} id */ id=>{
				const bytes=git(cwd,["cat-file","blob",id]);
				if (!isUtf8(bytes) || bytes.includes(0)) fail("invalid_resolution",`Expected a regular UTF-8 text resolution: ${r.file}`);
				return bytes.toString();
			};
			const {before,after,result}=replacement(read(r.base),read(r.checkpoint),read(r.target),r.file);
			if (git(cwd,["hash-object","--stdin"],result).toString().trim()!==r.result)
				fail("invalid_resolution",`The exact replacement does not produce the reviewed resolution blob: ${r.file}`);
			git(cwd,["hash-object","-w","--stdin"],result);
			details.push(`${JSON.stringify(r)}\nReplace ${JSON.stringify(before)} with ${JSON.stringify(after)} once in the checkpoint.`);
		}
		return rows;
	} : undefined);
	return {base,rows,details};
}
