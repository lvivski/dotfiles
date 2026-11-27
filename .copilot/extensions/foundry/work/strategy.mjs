import { machine } from "./machine.mjs";
import declaration from "./prerequisites.json" with {type:"json"};
import { canonical } from "../../../skills/foundry/scripts/recipe.mjs";

const meaning={
	"included-publications":"Verify every included original publication.",
	"declared-dependencies":"Verify the original publications granted as inputs.",
	"dependency-reviews":"Wait for independent review of a changed dependency before checking its consumer.",
};
/** @param {unknown} v @returns {v is keyof typeof meaning} */
const requirement=v=>typeof v==="string" && Object.hasOwn(meaning,v);
/** @param {unknown} v @returns {v is string} */
const guard=v=>typeof v==="string" && ["multipleOwners","includedInputs"].includes(v.replace(/^!/,""));
/** @template {string} T @param {unknown} value @param {(v:unknown)=>v is T} valid @param {string} field */
function list(value,valid,field){
	if(!Array.isArray(value) || !value.every(valid) || new Set(value).size!==value.length)throw Error(`Invalid approved-member ${field}`);
	return Object.freeze([...value]);
}
export const memberAction="source-member";
/** @param {unknown} raw */
function memberRules(raw){
	if(!Array.isArray(raw) || !raw.length)throw Error("Missing approved-member declaration");
	const rows=raw.map(row=>{
		if(!row || typeof row!=="object" || Array.isArray(row) || Object.keys(row).some(k=>k!=="requires" && k!=="when"))
			throw Error("Unsupported approved-member field");
		const requires=list(row.requires,requirement,"prerequisite"),when=list(Object.hasOwn(row,"when")?row.when:[],guard,"guard");
		const description=["Check each admitted member against its own original reviewed output. Exact byte approval, predecessor checks and final review remain mandatory.",
			...requires.map(k=>meaning[k])].join(" ");
		return {on:"approved-members",action:memberAction,description,requires,...(when.length && {when})};
	});
	if(rows.at(-1)?.when)throw Error("Missing unconditional approved-member fallback");
	return rows;
}
const members=memberRules(declaration);
const edition=canonical(declaration);
/** Compare to the data actually compiled above, not a second disk read during startup.
 * @param {unknown} data */
export const samePrerequisites=data=>canonical(data)===edition;
/** The selected executable edge already owns its validated input list.
 * @param {import("./machine.mjs").Edge|undefined} edge */
export const memberInputs=edge=>members.find(row=>row===edge)?.requires;

/** Rules propose a registered operation. Its own verifier, not the matching edge, decides whether it needs consent. */
export const strategy=machine("recovery","select",{
	select:[
		{on:"reference",when:["targeted"],action:"input",description:"Propose the requested bytes after an authorized source supplies them to this output."},
		{on:"reference",when:["approved"],action:"input",description:"Propose the previously approved match on its original pins after a proven non-delivery."},
		{on:"correction",when:["includedProducer","unclaimedSource"],action:"draft",description:"Send a signed adopted stop to its bounded included source without asking the owner to write a patch."},
		...members,
	],
},{description:"Selects a recovery proposal from observed evidence. Selection never issues work or grants permission.",
	states:{select:"Consider one stopped attempt and its evidence on this wake. Nothing is persisted by selection."}});
