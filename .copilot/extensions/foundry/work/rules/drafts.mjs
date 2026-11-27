import { guard, machine, to, update } from "../machine.mjs";
import { text } from "../values.mjs";

/** @typedef {import("../drafts.mjs").Context} Context */
const bound=guard("bound",(/** @type {Context} */ c)=>!!c.dispatch && !!c.workflow),
	explain=update("record-author-reason",(/** @type {Context} */ c,/** @type {Context} */ e)=>({...c,reason:text(e.reason,"author diagnostic")})),
	hold={...to("hold","held","Keep the original subject and record the concrete reason no proposal can be used."),...explain};
export const drafting=machine("correction-author","ready",{
	ready:[{...to("claim","issued","Journal one native author call for this exact source, before launching it."),action:"start-author",
		...update("claim-source",(_,/** @type {Context} */ e)=>({dispatch:text(e.dispatch,"author dispatch")}))},hold],
	issued:[
		{...to("bind","issued","Bind only the original proposal workflow, never a replacement identity."),
			...guard("sameWorkflow",(/** @type {Context} */ c,/** @type {Context} */ e)=>!!c.dispatch && (!c.workflow || c.workflow===e.workflow)),
			...update("bind-author",(/** @type {Context} */ c,/** @type {Context} */ e)=>({...c,workflow:text(e.workflow,"native author workflow"),awaitingPacket:e.awaitingPacket}))},
		{...to("observe","issued","Reobserve only the original bound author after reload."),...bound,action:"observe-author"},
		{...to("continue","issued","Journal one continuation of the same native author after its verified permission checkpoint or provider disconnect."),
			...guard("uncontinued",(/** @type {Context} */ c)=>!!c.workflow && !!c.dispatch && !c.continued),
			...update("claim-continuation",(/** @type {Context} */ c)=>({...c,continued:/** @type {const} */(true)})),action:"continue-author"},
		{...to("return","returned","Keep only a bound author's verified changes to its frozen file list."),...bound,
			...update("record-manifest",(/** @type {Context} */ c,/** @type {Context} */ e)=>({...c,changes:e.changes,reason:text(e.reason,"author result")}))},
		{...to("capacity","ready","Only a confirmed pre-admission capacity refusal releases this reservation."),
			...guard("unbound",(/** @type {Context} */ c)=>!!c.dispatch && !c.workflow),...update("queue-source",()=>({reason:"Waiting for native workflow capacity."}))},
		{...to("uncertain","issued","An unavailable reply retains the original dispatch for a possible late binding."),...explain},hold],
	returned:[],held:[],
},{description:"One proposal author for one disjoint source. A returned draft is neither a write grant nor acceptance.",states:{
	ready:"An exact source is available to a bounded proposal author.",issued:"Observe the one original native call; never replay an unknown launch.",
	returned:"The answer and changed blob manifest are frozen for exact operator consent.",held:"No further author call is authorized on this scope."}});
