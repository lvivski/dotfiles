// A separate loaded edition and a scripted native transport; never select a
// runner here. The shell receives the exact command stored by its issuer.
import { spawnSync } from "node:child_process";
import { readFileSync,rmSync,writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { git, scriptedInspections } from "./fixture.mjs";
import { openDatabase } from "../work/database.mjs";
const [install,root]=process.argv.slice(2),job=JSON.parse(readFileSync(0,"utf8"));
if(typeof job.now==="number")Date.now=()=>job.now;
/** @type {typeof import("../work/runtime.mjs")} */ const {createRuntime}=await import(pathToFileURL(`${install}/work/runtime.mjs`).href);
/** @type {typeof import("../work/recovery.mjs")} */ const {recover}=await import(pathToFileURL(`${install}/work/recovery.mjs`).href);
/** @type {Record<string,unknown>[]} */ const calls=[],/** @type {{actor:string,id:unknown}[]} */permissions=[];
/** @type {string[]} */ const logs=[];
let moved=false;
const runtime=createRuntime(root,{log:line=>logs.push(line),mode:async()=>"interactive",permissionBlocker:async()=>{
	if(job.moveBeforeIssue && !moved){
		const db=openDatabase(root);
		try{
			if(db.read(job.moveBeforeIssue)?.effects.some(c=>c.tool==="bash" && c.attempt?.version===3 && c.attempt.previous===job.id && c.state==="ready")){
				git(root,"commit","--allow-empty","-qm","Synthetic target movement during native permission observation");moved=true;
			}
		}finally{db.close();}
	}
	return job.blocked?{scope:"session",message:"Native permissions withheld"}:null;
},
	...(["approved","changes"].includes(job.review) && (()=>{
		const transport=scriptedInspections(root);
		return {...transport,inspectionState:async(/** @type {string} */ workflow)=>{
			const reply=await transport.inspectionState(workflow);
			return {...reply,result:{...reply.result,outcome:job.review,summary:`Scripted ${job.review} for the exact workflow and candidate.`}};
		}};
	})()),
	scout:async()=>{throw Error("No scout expected");},notify:async()=>"message",
	recover:async e=>e.id!==job.id || !job.reply && !job.events?{resultType:"unconfirmed"}:recover(async()=>({cursor:"fixture",cursorStatus:"ok",hasMore:false,events:job.events??[
		{type:"tool.execution_start",id:"start",data:{toolName:"bash",arguments:job.nativeArgs??e.args,toolCallId:e.callId,turnId:"original"}},
		job.reply.resultType==="denied"?{type:"permission.completed",id:"denial",data:{toolCallId:e.callId,result:{kind:"denied-by-rules"}}}:
			{type:"tool.execution_complete",id:"end",data:{toolCallId:e.callId,turnId:"original",success:true,toolTelemetry:job.reply.toolTelemetry}}
	]}),e),
	execute:async(tool,args,callId)=>{
		if(tool!=="bash")throw Error(`Unexpected tool: ${tool}`);
		calls.push(args);const actor=job.actor??"owner";await runtime.pre(tool,args,actor,callId);
		permissions.push({actor,id:args.shellId});if(job.denyFresh)return {resultType:"denied"};
		if(job.holdFresh)return {resultType:"unconfirmed"};
		const marker=job.traceNew && process.env.FOUNDRY_TEST_KEYS && process.env.FOUNDRY_TEST_KEYS+".strict";
		if(marker)writeFileSync(marker,job.traceNew,{flag:"wx"});
		try{
			const r=spawnSync("/bin/sh",["-c",String(args.command)],{cwd:root,encoding:"utf8"});
			if(r.status!==0)throw Error(r.stderr);
			return {resultType:"success",textResultForLlm:r.stdout};
		}finally{if(marker)rmSync(marker);}
	}});
try{
	const actor=job.actor??"owner";let value;
	if(job.action==="pre")await runtime.pre("bash",job.args,actor,job.callId);
	else if(job.action==="post"){
		await runtime.pre("bash",job.args,actor,job.callId);runtime.post(job.callId,job.reply,actor);await runtime.flush();
	}
	else if(job.action==="turn"){runtime.sessionStart(actor,root);runtime.turn(actor);await runtime.flush();}
	else value=await runtime.operation(job.action,job.params,actor);
	console.log(JSON.stringify({ok:true,calls,permissions,value,logs}));
}catch(e){console.log(JSON.stringify({ok:false,code:e instanceof Error && "code" in e?e.code:undefined,message:String(e),calls,permissions}));}
finally{runtime.close();}
