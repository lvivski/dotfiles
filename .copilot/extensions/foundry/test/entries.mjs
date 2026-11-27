import { releaseFacts } from "../work/facts.mjs";
import { releaseState } from "../work/engine.mjs";
import { historyState } from "../work/supervision.mjs";

/** Representative inputs to the production projections, not a list of states to bless.
 * These exercise classification; they do not issue checks, sign receipts or grant authority.
 * @param {Iterable<string>} assignments */
export function entryWitnesses(assignments) {
	/** @type {import("../work/model.js").Run} */
	const base={id:"sample",active:true,owner:"owner",activatedAt:1,effects:[],nodes:{},products:[],
		policy:{id:"sample",base:"tip",source:"plan",target:"main",direction:"Check the item",files:[],squads:[],repairs:0,productCheck:"product"}};
	const at={target:"tip",commit:"tip",check:"g"};
	/** @type {import("../work/model.js").NativeCall} */
	const goal={id:"g",issuer:"owner",tool:"bash",args:{},kind:"goal",state:"issued",callId:"call",commit:"tip",check:"goal"};
	const assessing={...base,policy:{...base.policy,goalCheck:"goal"},goal:at,effects:[goal]};
	const product={...at,outputs:{},check:"p"};
	/** @param {number|null} exit @returns {import("../work/model.js").NativeCall} */
	const verdict=exit=>({...goal,state:"done",runnerStarted:true,receipt:{commit:"tip",check:"goal",exit,output:"original observation"}});
	/** @type {import("../work/model.js").NativeCall} */
	const passed={...verdict(0),id:"p",kind:"product",check:"product",receipt:{commit:"tip",check:"product",exit:0,output:"checked product"}};
	const pin={from:"tip",revision:"upgrade",files:["goal"]};
	const upgrade={...pin,checkpoint:"p",goal:"g",recheck:"fresh"};
	/** @type {import("../work/model.js").NativeCall} */
	const rejoin={...goal,id:"fresh",kind:"product",check:"product",recheck:{of:"g",target:"tip",goalPin:"tip",productPin:"tip"}};
	/** @type {[string,import("../work/model.js").Run][]} */
	const cases=[
		["No goal",base],["Operator pause",{...assessing,active:false}],
		["Qualified product",{...assessing,active:false,products:[{...product,qualifiedAt:1}],effects:[verdict(0),passed]}],
		["Run blocker",{...assessing,blocker:"Stopped"}],["Outstanding goal",assessing],
		["Awaiting upgraded product",{...assessing,products:[product],productRepins:[upgrade]}],
		["Historical handoff awaiting fresh product evidence",{...assessing,
			products:[{...product,withdrawnHandoff:{qualifiedAt:1,goal:"g",recheck:"fresh"}}],
			join:{...product,check:"fresh"},effects:[passed,verdict(0),{...passed,id:"fresh",state:"ready",receipt:undefined}]}],
		["Original goal outstanding after repin",{...assessing,repins:[pin]}],
		["Original goal settled after repin",{...assessing,repins:[pin],effects:[verdict(2)]}],
		["Retirement without verdict",{...assessing,effects:[{...goal,state:"retired"}]}],
		["Recheck reserved",{...assessing,effects:[goal,rejoin]}],
		["New checked commit",{...assessing,products:[{...product,commit:"next"}]}],
	];
	for(const exit of [0,1,2,null])cases.push([`Current goal receipt: exit ${exit}`,{...assessing,effects:[verdict(exit)]}]);
	/** @type {Record<string,Map<string,string>>} */
	const projected={
		release:new Map(cases.map(([why,run])=>[releaseState(releaseFacts(run,"tip")),why])),
		quiescence:new Map([...assignments].map(s=>[s,`Inspect reachable assignment.${s}`])),
		history:new Map([[historyState(false,0),"No pending observation"],[historyState(false,1),"Bound workflow read owed"]]),
	};
	/** @type {Record<string,Map<string,string>>} */
	const restored={renewal:new Map([["presenting","Persisted unanswered presentation from a previous reader; no automatic exit"]])};
	return {projected,restored};
}
