import { spawnSync } from "node:child_process";
import path from "node:path";
import { withSourceInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { verificationEnvironment } from "../../../skills/foundry/scripts/recipe.mjs";
import { buildCache } from "./cache.mjs";
import { controlObservation } from "./calibration.mjs";
import { openDatabase } from "./database.mjs";
import { claimable, executionAllowed } from "./eligibility.mjs";
import { retainFeedback } from "./feedback.mjs";
import { withPreparation } from "./preparation.mjs";
import { commitAt, git } from "./product.mjs";
import { closeLegacy, closureExit } from "./abi.mjs";
import { deadlineAt, fail, text } from "./values.mjs";
import { interpret, interrupted } from "./verdict.mjs";

/** @typedef {import("./model.js").CheckDescription["steps"][number]} Step */
const [cwd,runId,effectId]=process.argv.slice(2),db=openDatabase(cwd);
try{
	const command=db.mutateLocked(runId,run=>{
		const e=run.effects.find(e=>e.id===effectId);
		if(e?.tool!=="bash")fail("unissued_check","No evaluator reservation for this command");
		if(e.attempt?.version===1){closeLegacy(run,e,cwd);return;}
		claimable(cwd,run,e);
		const recipe=e.verification??fail("unissued_check","No immutable check description; do not claim or replay a legacy reservation");
		const publish=db.outcomeWriter(runId,e);
		const batch=e.rollout?{rollout:e.rollout,prior:run.effects.flatMap(c=>c.kind==="component" && c.rollout===e.rollout && c.commit===e.commit &&
			c.receipt && c.runnerClaim?[{id:c.id,claim:c.runnerClaim}]:[]).reverse()}:undefined;
		return {recipe,publish,batch,ref:run.policy.target,deadline:run.policy.deadline,guarded:!!(e.rollout || e.replacement || e.delivery || e.rerun),
			pin:{commit:text(e.commit,"reserved commit"),check:text(e.check,"reserved evaluator"),
				...(e.evaluatorRevision && {evaluatorRevision:e.evaluatorRevision}),...(e.productEvaluatorRevision && {productEvaluatorRevision:e.productEvaluatorRevision})}};
	});
	if(!command)fail("closed-before-runner-claim","closed-before-runner-claim: original slot closed without evaluating");
	const {recipe,pin,deadline,guarded,ref}=command,main=recipe.steps.at(-1)??fail("invalid_inputs","Reserved check has no main invocation");
	/** @type {import("./model.js").Receipt} */ let receipt={...pin,exit:null,output:""};
	/** @type {NonNullable<typeof receipt.components>} */ const components={};
	/** @type {string[]} */ const notes=[];
	/** @type {import("./model.js").VerificationInputs|undefined} */ let actual;
	/** @type {ReturnType<ReturnType<typeof import("./feedback.mjs").goalFiles>["collect"]>} */ let feedbackValue;
	/** @param {string} root @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} env */
	function execute(root,executable,args,env){
		const timeout=deadline===undefined?undefined:(deadlineAt(deadline)??-Infinity)-Date.now();
		if(timeout!==undefined && timeout<=0)fail("deadline","Deadline elapsed before evaluation");
		return spawnSync(executable,args,{cwd:root,env,timeout,maxBuffer:Infinity,stdio:["ignore","pipe","pipe"]});
	}
	function ensureCurrent(){
		if(recipe.joined && commitAt(cwd,ref)!==recipe.target)fail("stale_pin","The approved mixed target moved before verification");
		if(guarded){
			const r=db.read(runId),e=r?.effects.find(x=>x.id===effectId);
			if(!r || e?.tool!=="bash" || !e.runnerStarted)fail("stale_assignment","Original grant unavailable");
			executionAllowed(cwd,r,e);
		}
	}
	/** @param {Step["build"]} build @param {(p?:import("./preparation.mjs").Prepared)=>Promise<void>} consume
	 * @param {import("./cache.mjs").Batch|undefined} [batch] */
	async function prepared(build,consume,batch){
		if(!build)return consume();
		ensureCurrent();
		const env=verificationEnvironment({kind:"goal"},process.env);
		return withPreparation(cwd,build.commit,(root,hook,output)=>{
			const result=interpret({kind:"component"},execute(root,path.join(root,hook),[output],env));
			if(result.fields.exit!==0)fail("preparation_failed",`${hook} did not complete successfully: ${result.fields.output || result.fields.exit}`);
		},consume,batch && buildCache(cwd,build.commit,env,batch),build);
	}
	try{
		const delta=recipe.privateInput?git(cwd,["cat-file","blob",recipe.privateInput]).toString():undefined;
		/** @param {Step} step @param {import("./preparation.mjs").Prepared} [build] */
		async function observe(step,build){
			const inputs=build?{...step.inputs,prepared:build.expected}:step.inputs;
			const id=step.member;
			/** @type {Pick<import("./model.js").Receipt,"exit"|"output">} */ let observed={exit:null,output:""};
			if(id!==null)components[id]={check:inputs.checker.path,exit:null};
			await withSourceInputs(cwd,inputs,({root,executable,args,env,feedback})=>{
				ensureCurrent();
				const result=execute(root,executable,args,env),{fields,feedback:stdout}=interpret(id===null?recipe.evaluation:{kind:"component"},result);
				if(id!==null){
					components[id].inputs=inputs;
					observed=fields;
				}else{
					actual=inputs;receipt={...pin,...fields};
					if(inputs.control){
						const witness=controlObservation(result.stdout,fields.exit);if(witness)receipt.control=witness;
					}else if(stdout && feedback){
						try{feedbackValue=feedback.collect(stdout);}
						catch(error){receipt.output+=`\nFoundry scheduling feedback unavailable: ${error instanceof Error?error.message:String(error)}`;}
					}
				}
			},{env:process.env,prepared:build,delta:id===null?delta:undefined});
			if(id!==null){
				components[id].exit=observed.exit;
				if(observed.exit!==0)fail("component_failed",`Component ${id} (${inputs.checker.path}) did not pass on the joined target: ${observed.output || observed.exit}`);
			}
		}
		const members=recipe.steps.slice(0,-1);
		if(members.length)await prepared(members[0].build,async build=>{for(const s of members)await observe(s,build);});
		const batch=command.batch && {...command.batch,ledger:db.file,run:runId,effect:effectId,sign:command.publish.signPreparation,
			note:(/** @type {string} */ message)=>{const line=`Foundry preparation: ${message}`;notes.push(line);process.stdout.write(line+"\n");}};
		await prepared(main.build,p=>observe(main,p),batch);
		if(feedbackValue){
			try{receipt.feedbackFile=retainFeedback(cwd,feedbackValue);}
			catch(error){receipt.output+=`\nFoundry scheduling feedback unavailable: ${error instanceof Error?error.message:String(error)}`;}
		}
	}catch(error){receipt={...pin,...interrupted(recipe.evaluation,receipt.exit,error)};}
	if(actual)receipt.inputs=actual;
	if(recipe.joined)receipt.components=components;
	if(recipe.resolutions)receipt.resolutionDigest=recipe.resolutions;
	if(notes.length)receipt.output=[receipt.output,...notes].filter(Boolean).join("\n");
	if(deadline!==undefined)receipt.completedAt=Date.now();
	command.publish(receipt);
	process.stdout.write(`Foundry evaluated ${receipt.commit}: ${receipt.exit??"blocked"}\n`);
}catch(error){
	if(!(error instanceof Error && "code" in error && error.code==="closed-before-runner-claim"))throw error;
	process.stderr.write(`${error.message}\n`);process.exitCode=closureExit;
}finally{db.close();}
