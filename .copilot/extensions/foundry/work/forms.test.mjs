import assert from "node:assert/strict";
import test from "node:test";
import { formIdle, formVacant } from "./forms.mjs";

test("a missing or competing native request is never mistaken for two clear input queues",async()=>{
	const ui={processing:false,agentTurnActive:false,pendingUserInputRequests:[],pendingExitPlanModeRequests:[],pendingElicitationRequests:[]};
	const s={id:"owner",active_session_id:"owner",activity:{status:"busy"},was_interrupted:false,awaiting_user_input:false};
	for(const key of ["pendingElicitationRequests","pendingUserInputRequests","pendingExitPlanModeRequests"])for(const pending of [undefined,[{requestId:"original"}]]){
		const snapshot={...ui,[key]:pending};assert.equal(formIdle(snapshot),false);
		assert.equal(await formVacant("owner",async()=>snapshot,async()=>assert.fail("Do not probe the desktop after an unresolved native queue")),false);
	}
	for(const dirty of [{agentTurnActive:true},{processing:true},{agentTurnActive:undefined}])assert.equal(formIdle({...ui,...dirty}),false);
	assert.equal(formIdle(ui),true);
	for(const peer of [{awaiting_user_input:true},{awaiting_user_input:undefined},{awaiting_inputs:[{request_id:"original"}]},
		{awaiting_input:{kind:"elicitation"}},{activity:{status:"unknown"}},{activity:{status:"busy",waiting_on:"elicitation"}},
		{id:"peer"},{active_session_id:undefined},{active_session_id:"peer"},{was_interrupted:true},{pending_plan:{}}]){
		assert.equal(await formVacant("owner",async()=>ui,async()=>({resultType:"success",structuredContent:{...s,...peer}})),false);
	}
	assert.equal(await formVacant("owner",async()=>ui,async()=>({resultType:"denied",structuredContent:s})),false);
	for(const raw of [JSON.stringify(s),{resultType:"success",structuredContent:s},{resultType:"success",textResultForLlm:JSON.stringify(s)}])
		assert.equal(await formVacant("owner",async()=>ui,async()=>raw),true);
});
