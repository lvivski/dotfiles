import { fail } from "./values.mjs";
import { decode } from "./snapshot.mjs";
import { validHistory } from "./historical.mjs";
import { closedAttempt } from "./requirements.mjs";
import { writerFormat } from "./lineage.mjs";

/** @typedef {import("./model.js").Run} Run */
const format="foundry-run/3";
const invalid=()=>fail("corrupt_run","Invalid Foundry execution snapshot or unsupported document format");
/** @param {import("./model.js").Effect} e */
const bound=e=>e.tool==="bash"?e.attempt?.version===3?closedAttempt(e):e.attempt?.version===2?!!e.verification:e.attempt?.version===1 && !("verification" in e):
	!("attempt" in e) && !("verification" in e);
/** Source discovery and native writer identity intentionally keep their original SQL paths.
 * Neither old decoder accepts a document without its required root nodes member.
 * @param {string} document @returns {Run} */
export function readDocument(document){
	let v;try{v=JSON.parse(document);}catch{return invalid();}
	if(!v || typeof v!=="object" || !Array.isArray(v.effects) || v.effects.some((/** @type {unknown} */ e)=>!e || typeof e!=="object"))return invalid();
	if(Object.hasOwn(v,"format") || Object.hasOwn(v,"graph") || Object.hasOwn(v,"reviewContract")){
		const {format:tag,graph,reviewContract,...rest}=v;
		if(tag!==format && tag!=="foundry-run/2" || (tag===format)!==Object.hasOwn(rest,"history") || !graph || typeof graph!=="object" || !("nodes" in graph) ||
			Object.keys(graph).length!==1 || Object.hasOwn(rest,"nodes") ||
			reviewContract!==(Object.hasOwn(rest,"inspections")?"required":"legacy-no-review") ||
			!v.effects.every(bound) || tag!==format && v.effects.some((/** @type {import("./model.js").NativeCall} */ e)=>e.attempt?.version===3))return invalid();
		const run=decode({...rest,nodes:graph.nodes},true);
		if(tag===format ? !validHistory(run) || !writerFormat(run) : run.historicalPrefix || run.effects.some(e=>"writing" in e))return invalid();
		return run;
	}
	if(Object.hasOwn(v,"history") || Object.hasOwn(v,"historicalPrefix") || !Object.hasOwn(v,"nodes") || v.effects.some((/** @type {object} */ e)=>"attempt" in e || "verification" in e || "writing" in e))return invalid();
	for(const e of v.effects)if(e?.tool==="bash")e.attempt={version:1};
	return decode(v,true);
}
/** @param {Run} run @param {"required"|"legacy-no-review"} reviewContract */
export function writeDocument(run,reviewContract){
	const {nodes,...rest}=run;
	if("format" in rest || "graph" in rest || "reviewContract" in rest || !validHistory(run) || !writerFormat(run) ||
		(reviewContract==="required"?!Array.isArray(run.inspections):Object.hasOwn(run,"inspections")) || !run.effects.every(bound))return invalid();
	/** @type {import("./model.js").RunDocument} */ const wire={format,reviewContract,...rest,graph:{nodes}};
	return JSON.stringify(wire);
}
