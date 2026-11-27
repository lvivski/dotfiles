import { machine, to, update } from "../machine.mjs";

/** @typedef {import("../quiescence.mjs").Queue} Queue */
/** @typedef {import("../quiescence.mjs").Check} Check */
/** @param {string} reason */
const hold=reason=>({on:"inspect",reason,...update("hold-assignment",
	(/** @type {Queue} */ q,/** @type {{label:string}} */ e)=>({...q,held:[e.label]}))});
const retain={on:"inspect",when:["retarget","unissuedUnavailable"],reason:"Keep the unavailable attempt outside the adopted product",
	...update("retain-unavailable-check",(/** @type {Queue} */ q,/** @type {{check?:Check}} */ e)=>{
		if (!e.check) throw Error("Missing observation to retain during target adoption");
		return {...q,retained:[e.check]};
	})};
/** @param {string} state */
const settled=state=>[to("inspect",state,"No mutable assignment")];
export const quiescence=machine("quiescence","idle",{
	idle:settled("idle"),qualified:settled("qualified"),repeated:settled("repeated"),blocked:settled("blocked"),
	writing:[hold("Current writer reservation")],checking:[hold("Current component observation")],
	reviewing:[hold("The passing candidate still needs independent review")],
	waiting:[retain,hold("A pending assignment still needs scheduler admission")],
	published:[{...to("inspect","published","Recheck the published output on the adopted assembly"),when:["retarget"]},hold("Pending integration")],
},{description:"Determines whether an assignment needs current authority before a checkpoint or target can change.",states:{
	idle:"No work was requested for this output.",qualified:"The output already belongs to a checked product.",
	repeated:"The output was retained without a changed product.",blocked:"The stop is recorded; it is not an active writer or evaluator.",
	writing:"A writer reservation must be accounted for before changing the assembly.",checking:"An outstanding component observation must keep its original inputs.",
	reviewing:"A candidate in code review cannot be adopted or treated as a published output.",
	waiting:"Distinguish a live queue obligation from an unavailable observation that nobody can act on.",
	published:"A component passed but awaits integration; adoption requires observing it on the new assembly.",
}});
