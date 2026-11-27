import { checkedOverlay, resolveInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { buildAt, preparedMember } from "./consent.mjs";
import { evaluatorOverlay } from "./overlay.mjs";
import { priorGoal } from "./feedback.mjs";
import { rolloutFiles, verifyContracts } from "./objects.mjs";
import { digest, fail } from "./values.mjs";

/** Reconstruct physical inputs from the original approved owner scopes and exact Git bytes.
 * The historical call is a comparison witness, never a recipe forwarded to the runner.
 * @param {string} cwd @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e
 * @param {import("./model.js").Adoption} a @returns {import("./model.js").CheckDescription} */
export function approvedRecipe(cwd,run,e,a){
	const r=a.rollout,attempt=e.attempt,commit=a.assembly,check=e.check;
	if(!r || !commit || !check || attempt?.version!==3 || attempt.source.kind!=="approval" || attempt.source.id!==a.id ||
		digest(rolloutFiles(cwd,r.from,commit))!==digest(r.files) ||
		r.followup && digest(rolloutFiles(cwd,r.followup.assembly,commit))!==digest(r.followup.files))fail("invalid_inputs","The complete approved change and assembly do not match");
	verifyContracts(cwd,{...run.policy,contractTarget:r.harness},commit);
	const use=attempt.use,main=use==="component"?undefined:checkedOverlay(evaluatorOverlay(run,use,r.harness)),all=Object.keys(r.included);
	const build=buildAt(cwd,commit);
	/** @param {string} id @param {string|null} member */
	const component=(id,member)=>{
		const n=run.nodes[id],scope=r.included[id]?.scope;
		if(!n || !scope)fail("invalid_inputs","Unknown approved output scope");
		return preparedMember(cwd,commit,n.grain.check,id,scope,build,member);
	};
	const grant=attempt.grant,target=a.revision,contract=target;
	if(use==="component"){
		const step=component(e.grain??fail("invalid_inputs","Missing approved member"),null);
		return {version:1,use,grant,target,contract,evaluation:{kind:"component"},steps:[step]};
	}
	if(run.productRepins?.at(-1)?.resolutions?.length || use==="goal" && priorGoal(run,e))
		fail("current_authority_required","Private goal history or resolved conflicts need an independently bound recipe");
	const scope=use==="goal"?/** @type {const} */({kind:"goal"}):/** @type {const} */({kind:"product",outputs:all.map(id=>({id,...r.included[id].scope}))});
	const end={member:null,build:null,inputs:resolveInputs(cwd,{commit,check,scope,overlay:main})};
	return use==="goal"?{version:1,use,grant,target,contract,evaluation:{kind:"goal",squads:run.policy.squads.map(s=>s.id)},steps:[end]}:
		{version:1,use,grant,target,contract,evaluation:{kind:"product",outputs:all},joined:true,steps:[...all.map(id=>component(id,id)),end]};
}
