import { spawnSync } from "node:child_process";
import path from "node:path";
import { withSourceInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { verificationEnvironment } from "../../../skills/foundry/scripts/recipe.mjs";
import { buildCache } from "./cache.mjs";
import { openClaims } from "./claims.mjs";
import { retainFeedback } from "./objects.mjs";
import { withPreparation } from "./preparation.mjs";
import { git } from "../../../skills/foundry/scripts/git-files.mjs";
import { closureExit } from "./abi.mjs";
import { deadlineAt, fail } from "./values.mjs";
import { controlObservation, interpret, interrupted } from "./verdict.mjs";

/** @typedef {import("./model.js").CheckDescription["steps"][number]} Step */
const [cwd,runId,effectId]=process.argv.slice(2),db=openClaims(cwd,runId,effectId);
try{
	const mode=db.mode();
	if(mode==="historical"){
		(await import("./closure.mjs")).close(cwd,runId,effectId);
		fail("closed-before-runner-claim","closed-before-runner-claim: original slot closed without evaluating");
	}
	const command=db.claim(mode==="mixed"?await import("./historical.mjs"):undefined);
	const {recipe,pin,deadline,guard}=command,main=recipe.steps.at(-1)??fail("invalid_inputs","Reserved check has no main invocation");
	/** @type {import("./model.js").Receipt} */ let receipt={...pin,exit:null,output:""};
	/** @type {NonNullable<typeof receipt.components>} */ const components={};
	/** @type {string[]} */ const notes=[];
	/** @type {import("./model.js").VerificationInputs|undefined} */ let actual;
	/** @type {ReturnType<ReturnType<typeof import("./feedback.mjs").goalFiles>["collect"]>} */ let feedbackValue;
	/** @param {string} root @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} env */
	function execute(root,executable,args,env){
		guard();
		const timeout=deadline===undefined?undefined:(deadlineAt(deadline)??-Infinity)-Date.now();
		if(timeout!==undefined && timeout<=0)fail("deadline","Deadline elapsed before evaluation");
		return spawnSync(executable,args,{cwd:root,env,timeout,maxBuffer:Infinity,stdio:["ignore","pipe","pipe"]});
	}
	/** @param {Step["build"]} build @param {(p?:import("./preparation.mjs").Prepared)=>Promise<void>} consume
	 * @param {import("./cache.mjs").Batch|undefined} [batch] */
	async function prepared(build,consume,batch){
		if(!build)return consume();
		guard();
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
