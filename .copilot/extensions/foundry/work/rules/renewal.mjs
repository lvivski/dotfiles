import { machine, to, update } from "../machine.mjs";

/** @typedef {import("../renewal.mjs").Pins} Pins */
/** @typedef {import("../renewal.mjs").Renewal} Renewal */
const pins=update("record-renewal-pins",(/** @type {Pins|undefined} */ _,/** @type {Pins} */ e)=>({
	checkpoint:e.checkpoint,goal:e.goal,...(e.reason && {reason:e.reason})}));
/** @param {string} on @param {Renewal["state"]} target @param {string} description @param {...string} when */
const record=(on,target,description,...when)=>({...to(on,target,description),when,...pins});
const consider=[record("evidence","held","Keep the saved report on hold because its inputs or ownership conflict.","conflict"),
	{...record("evidence","approved","Use the original report after its inputs and current permissions have been revalidated.","permitted"),action:"admit-report"},
	record("evidence","needed","Keep the eligible report until the issuing session has permission to admit it.")];
export const renewal=machine("renewal","initial",{
	initial:consider,held:consider,needed:consider,approved:[...consider,record("invalid","closed","Retain the admission error rather than rerunning or silently changing the report.")],
	// Older readers may already have presented an approval. Silence is not permission to replace it.
	presenting:[],closed:[],
},{description:"Determines whether an existing scout report can be admitted after a checkpoint changes.",states:{
	initial:"The saved report has not been assessed for renewal.",held:"An input or ownership conflict prevents reuse of the report.",
	needed:"The evidence supports renewal, but current permission is missing.",approved:"The report may be admitted on the reviewed checkpoint and goal.",
	presenting:"A previous reader already presented a decision; it must not be silently replaced.",
	closed:"The renewed proposal failed admission. Preserve its diagnostic.",
}});
