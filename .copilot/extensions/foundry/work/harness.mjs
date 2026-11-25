import { entries } from "./product.mjs";
import { contains, covers, fail, ownership } from "./values.mjs";

/** Reconstruct the observed check, not the old application. Account for every differing
 * file, including helpers outside the assignment. Git cannot classify an arbitrary
 * program's inputs; the operator reviews the partition before authorizing execution.
 * @param {string} cwd @param {string} product @param {string} check @param {import("./model.js").Rerun} pin */
export function harnessFiles(cwd, product, check, pin) {
	const old=new Map(entries(cwd,pin.candidate,true).map(e=>[e.name,e]));
	const live=new Map(entries(cwd,product,true).map(e=>[e.name,e]));
	const paths=[...new Set([...old.keys(),...live.keys()])].sort();
	const changed=paths.filter(p=>old.get(p)?.oid!==live.get(p)?.oid || old.get(p)?.mode!==live.get(p)?.mode);
	const evaluator=old.get(check);
	if (!evaluator || !["100644","100755"].includes(evaluator.mode) || changed.includes(check))
		fail("unavailable_harness",`Original component evaluator is absent or changed: ${check}`);
	const inputs=[...pin.harness,...pin.current];
	for (const [i,root] of inputs.entries()) {
		if (!paths.some(p=>contains(root,p))) fail("unavailable_harness",`Unknown input in both revisions: ${root}`);
		if (inputs.slice(i+1).some(other=>contains(root,other) || contains(other,root)))
			fail("ambiguous_harness",`Overlapping historical harness or current product declarations: ${root}`);
	}
	const uncovered=changed.filter(p=>!inputs.some(root=>contains(root,p)));
	if (uncovered.length) fail("unavailable_harness",`Cannot reconstruct ${check}: classify changed inputs as historical harness or current product: ${uncovered.join(", ")}`);
	for (const root of pin.harness) {
		const existing=paths.some(p=>contains(root,p) && live.has(p));
		if (!old.has(root) && (!covers(pin.directory,root) || existing && changed.some(p=>contains(root,p))))
			fail("ambiguous_harness",`Cannot replace an existing or external harness directory: ${root}. Name its exact test files, never production files.`);
	}
	for (const root of ownership(pin.directory).directories) {
		if (paths.some(p=>contains(root,p) && live.has(p))) continue;
		const missing=changed.filter(p=>contains(root,p) && !pin.harness.some(h=>contains(h,p)));
		if (missing.length) fail("unavailable_harness",`Original assignment directory ${root} is absent; cannot omit ${missing.join(", ")} from its check`);
	}
	const files=changed.filter(p=>pin.harness.some(root=>contains(root,p))).map(p=>{
		const file=old.get(p);
		if (!file || !["100644","100755"].includes(file.mode) || live.has(p) && !["100644","100755"].includes(live.get(p)?.mode ?? "") ||
			paths.some(other=>other!==p && live.has(other) && (contains(p,other) || contains(other,p))))
			fail("unavailable_harness",`Cannot restore a regular test file without removing a product path: ${p}`);
		return file;
	});
	return {files,current:changed.filter(p=>pin.current.some(root=>contains(root,p)))};
}
