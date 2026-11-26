import { FoundryError, fail, fields, record } from "./values.mjs";

/** @typedef {Pick<ReturnType<typeof import("./runtime.mjs").createRuntime>, "inspect"|"claimWriter"|"operation"|"readReference">} Commands */
export const primaryOnly = "Foundry operations belong to the assigned native session, not its subagents";
/** @param {{sessionId:string,agentId?:string,parentAgentId?:string,agentType?:string}} input @param {string} primary */
export const fromHelper = (input, primary) => !!(input.agentId || input.parentAgentId || input.agentType) || input.sessionId !== primary;
const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string, uniqueItems: true };
const stop = {type:"object",properties:{check:string,reason:string},required:["check","reason"],additionalProperties:false};
const resolutions={type:"array",minItems:1,items:{type:"object",properties:{file:string,mode:{enum:["100644","100755"]},base:string,checkpoint:string,target:string,result:string},
	required:["file","mode","base","checkpoint","target","result"],additionalProperties:false}};
const notes={type:"array",minItems:1,items:{type:"object",properties:{file:string,excerpt:string,
	inventory:{type:"object",properties:{file:string,keys:{type:"array",items:string}},required:["file","keys"],additionalProperties:false},reason:string},
	required:["file","excerpt","inventory","reason"],additionalProperties:false}};
/** @typedef {Record<string,import("./model.js").Json>} Properties */
/** @typedef {[operation:string,description:string,required:Properties,optional?:Properties]} Form */
const observer={grain:string,pair:string,file:string,blob:string};
const previous={type:"object",properties:{check:string,candidate:string,phases:{type:"array",minItems:2,maxItems:8,uniqueItems:true,items:string}},required:["check","candidate","phases"],additionalProperties:false};
const baseline={grains:{...strings,minItems:1}};
const oneChoice={minProperties:2,maxProperties:2}; // run plus one selector
/** @type {Record<string,Properties>} */
const limits={
	claim:oneChoice,
	configure:{minProperties:3}, // run, revision and at least one setting
};
/** @type {Record<string,Record<string,Form>>} */
const choices={
	review:{
		compare:["iterate","Open a scoped comparison of an offered blob in its production directory. Use the unmet goal receipt, or the passing checkpoint check while its goal is pending. On a settled exit 2, use the current goal and a checked source for a new approved review, or historical evidence for an omitted same-product failure. A superseded exhausted-directory overlap can use its original directory/blob on unchanged inputs.",{directory:string,receipt:string,blob:string,question:string},
			{files:{...strings,minItems:1,description:"Exact existing integration files for a source-backed review; never grants a parent directory."},historical:{type:"object",properties:{receipt:string,step:string},required:["receipt","step"],additionalProperties:false},
				transfer:{type:"object",description:"Conditional transfer from the qualified parent to a new ID. Requires source, files and an exclusion-aware checker.",properties:{from:string,candidate:string,to:string},required:["from","candidate","to"],additionalProperties:false},
				successor:{type:"object",description:"Separately approved narrower assignment after a writer stop. Requires source and the original signed component check. Cannot release an ownership hold.",properties:{from:string,check:string,to:string},required:["from","check","to"],additionalProperties:false},
				source:{type:"object",properties:{commit:string,file:string,excerpt:string},required:["commit","file","excerpt"],additionalProperties:false}}],
		retry:["rereview","On explicit request, recover one existing blocked review with proven scout-budget failure or missing approved source. Issue one fresh scout on the same comparison, never replay its report.",{review:string}],
	},
	check:{
		recover:["recheck","Recover a confirmed pre-claim launcher exit or signed null goal on its current pins. No retry of an unknown call.",{check:string}],
		observe:["recheck","Append a non-qualifying observation of a stopped numeric component on the full current checked commit. Approve the complete historical test harness and account for changed inputs kept current; do not guess unknown inputs.",{check:string,product:string,harness:strings},{current:strings}],
		repeat:["recheck","Only on explicit repeat request: inherit the approved harness and inputs of the latest signed observation on the same product.",{check:string,product:string,after:string}],
		pair:["pair","After a signed exit-1 restoration, observe the same primary with the published retainer's different integration bytes. Name the unchanged checkpoint, goal and passing retainer component. No writer, edits or retry of a negative pair.",{grain:string,failed:string,checkpoint:string,goal:string,retainer:string,candidate:string,component:string}],
	},
	grant:{
		inherited:["inherit","On explicit request, select or reopen this owner-offered patch for unowned inherited files after a signed adopted-component failure. The operator confirms the exact diff, not the target again. No writer grant.",{check:string,blob:string}],
		inspectBaseline:["inspectBaseline","Allow the original missing-input writers to read their exact prior directories. No write permission or new work; eligible even during a check.",baseline],
		repairBaseline:["repairBaseline","Authorize one bounded repair for each original missing-input writer from its unchanged baseline after a settled goal. Inspection alone does not authorize repair.",baseline],
		reuse:["reuse","Seed one new writer from the exhausted assignment's exact failed candidate and already-offered correction on the current product. No old verdict is promoted.",{grain:string,check:string,candidate:string,blob:string}],
		restore:["restore","Attest only the unchanged orphaned primary of a formerly checked mixed grant. The retaining owner keeps all integration files. Name the historical/current product and settled goal checks.",{from:string,historical:string,retainer:string,to:string,checkpoint:string,goal:string}],
		observer:["diagnose","Authorize a writer for one existing observer file after a signed negative pair. For a final replacement supply its predecessor's failed check, candidate, phases and approved file blob. No production edits.",observer,{previous}],
		approveObserver:["diagnose","Review and approve the bound writer's exact observer preview and fault controls. Use the same grant inputs; this does not authorize another writer.",{...observer,preview:string},{previous}],
		production:["remediate","After the final signed diagnostic fails, grant the named producer exact production and regression files. No observer edit or replay; both components, product and goal need fresh passes.",{diagnostic:string,candidate:string,checkpoint:string,goal:string,producer:string,files:{...strings,minItems:1},task:string}],
	},
};
/** @type {Form[]} */
const definitions = [
	["grant","Owner, on operator direction: request one scoped baseline, reuse, restoration, observer, production or inherited-file correction approval.",{run:string}],
	["check","Owner, on operator request: recover a check, observe or repeat a historical harness, or pair a failed restoration with its retainer. Never replace a verdict.",{run:string}],
	["review","Owner: start one scoped scout comparison or retry an eligible blocked review. To queue context without a launch use foundry_review_note.",{run:string}],
	["deliver","Owner, on request: approve the inventory of whole, absent, disjoint test directories with latest signed passing reruns on this product. Preserve owners and attempts; freshly check components, product and goal.",{run:string,checkpoint:string,goal:string,reruns:{...strings,minItems:1}}],
	["checkpoint","Owner, on request after a failed paired observer: verify one non-release subset of published outputs. Prove complete build and runtime inputs for selected and held components; unknown inputs are ineligible. No retry or release.",{
		run:string,observer:string,target:string,checkpoint:string,goal:string,selected:{type:"array",minItems:1,items:{type:"object",properties:{grain:string,candidate:string,component:string},required:["grain","candidate","component"],additionalProperties:false}},
		evidence:{type:"array",minItems:1,items:{type:"object",properties:{component:string,stages:{type:"object",properties:{component:notes,generated:notes,package:notes,runtime:notes},required:["component","generated","package","runtime"],additionalProperties:false}},required:["component","stages"],additionalProperties:false}}}],
	["workspace", "Pooled writer: open or verify this assignment's checkout inside your native worktree. Work only in the returned workspace. No branch switch, old-work copy or check.", {run:string,token:string}],
	["correct", "Owner: approve removing one contradictory clause from an unsubmitted task. Cite the assigning review and frozen verbatim source, in grant for a checked handoff. A bound writer rereads status; only an ordinary missing-input stop without a verdict can use its exact preview for one same-writer repair. No new read grant or check.", {run:string, grain:string, review:string, worker:string, clause:string, file:string, excerpt:string},{preview:string}],
	["attribute", "Owner: route a shared failure missing from structured blocker data. Quote the current unmet goal receipt. Count dependent journeys not run, excluding the failure; this changes scheduling, not its verdict.", {run:string,receipt:string,id:string,directory:string,excerpt:string,blocked:{type:"integer",minimum:1}}],
	["configure", "Owner, on request: change future reservations at the current scheduling revision. workers:null restores the brief ceiling. checkpointReviews governs new checkpoint comparisons and surveys, not existing work.", {run:string,revision:{type:"integer",minimum:0}}, {workers:{type:["integer","null"],minimum:1},checkpointReviews:{type:"boolean"}}],
	["preview", "Bound writer, after joining helpers: pin all assigned roots on the frozen generation for inspection. No submission, evaluator or change of authority.", {run: string, token: string}],
	["review_note", "Owner: queue a historical goal receipt and question for a squad's next normal review. Use a proof receipt ID and optional verbatim excerpt. No discovery or assignment.", { run: string, squad: string, receipt: string, question: string }, { excerpt: string }],
	["start", "On explicit operator direction, activate a new run for a committed .foundry brief. Repeating start does not advance or resume an existing run. Use foundry_resume for recovery.", { source: string }],
	["resume", "On explicit owner request, continue an existing source from its ledger pins. Use run to disambiguate. Never create a run or replay an issued call.", { source: string }, {run:string}],
	["pause", "Stop new Foundry work without discarding native calls, evidence, worktrees or checked products.", { run: string }],
	["claim", "Bind an existing uncertain writer only. The child proves its kickoff and native session identity by token or grain; the original issuer confirms by grain. Never launch another writer.", { run: string }, { grain: string, token: string }],
	["retire", "On explicit owner request and native proof, approve retiring a dead pre-journal goal reservation without a verdict. Integrate retained work; never rerun the old goal.", { run: string, check: string }],
	["clarify", "On explicit owner request, reopen the exact lost charter dialog from status. Only the operator answers. No contract change or permission grant.", { run: string, review: string, presentation: string }],
	["repin", "Owner, on request: omit kind for a goal-only diff; product rechecks the same checkpoint; target adopts a reviewed mixed descendant. Name the exact diff and pins. Target adoption requires explicit approval, acceptance changes, any exact unowned conflict resolutions, and fresh component/product/goal checks. No branch change or retroactive grant.", { run: string, from: string, revision: string, files: strings }, {kind:{type:"string",enum:["product","target"]},ownership:{type:"string",enum:["retain-except-transferred"]},checkpoint:string,goal:string,acceptance:string,resolutions}],
	["submit", "Bound writer, after joining helpers: submit all assigned roots, or report one stop. Use missingInput for a genuine missing input; cannotRepair for a status-listed check when further repair is forbidden; relinquish for a status-listed numeric failure with neither a fix nor missing input. Stops do not capture or recheck. For changed work after an incomplete check use changedFrom from status.", { run: string, token: string }, { missingInput: string, cannotRepair:stop, relinquish:stop, changedFrom: string, usedArtifacts: strings, comparedArtifacts: strings }],
	["publish", "Offer one reference file to named output directories or charter areas. A bound writer must supply its token. Publishing grants no baseline access or repair authority.", {run:string,file:string,to:{...strings,minItems:1}}, {token:string}],
	["status", "Read scoped work, blockers and receipts without advancing or archiving. permissions reads this issuer's live policy and mode; proof, cleanup and usage are owner-only.", { run: string }, { detail: { type: "string", enum: ["proof", "cleanup", "usage", "permissions"] } }],
	["reference", "Bound researcher only: read permitted UTF-8 text at a published commit in a local sibling repository. Not working-tree or visual evidence.", { run: string, review: string, repo: string, revision: string, path: string }],
];

/** @param {Properties} required @param {Properties} [optional] */
const object=(required,optional={})=>({type:"object",properties:{...required,...optional},required:Object.keys(required),additionalProperties:false});
/** Enforce the selected form even when a host invokes a handler without schema validation.
 * The domain command still validates all values, authority and live pins.
 * @param {unknown} args @param {ReturnType<typeof object>} schema */
function input(args,schema){
	const a=record(args);
	fields(a,Object.keys(schema.properties));
	for(const key of schema.required)if(!Object.hasOwn(a,key)||a[key]===undefined)fail("missing_field",`Missing required field: ${key}`);
	return a;
}

/** @param {Commands} runtime @param {()=>string} primary @param {ReturnType<typeof import("./permissions.mjs").permissionCheck>["snapshot"]} permissions @returns {import("@github/copilot-sdk").Tool[]} */
export function buildTools(runtime, primary, permissions) {
	return definitions.map(([op,description,required,optional])=>{
		const variants=choices[op];
		const forms=Object.fromEntries(Object.entries(variants??{}).map(([key,[,description,req,opt]])=>[key,{description,...object(req,opt)}]));
		const parameters={...object(required,variants?forms:optional),...(variants?oneChoice:limits[op])};
		return {name:`foundry_${op}`,description,parameters,handler: async (args, invocation) => {
			try {
				if (op === "reference") {
					if (invocation.sessionId !== primary() || !invocation.agentId) throw new Error("Only a bound research subagent may use the pinned reader");
					return await runtime.readReference(input(args,parameters), invocation.sessionId, invocation.agentId);
				}
				if (fromHelper(invocation, primary()))
					throw new Error(primaryOnly);
				const a=input(args,parameters);
				if(variants){
					const selected=Object.keys(a).filter(k=>k!=="run");
					if(selected.length!==1)fail("invalid_selector",`Choose exactly one ${op} operation: ${Object.keys(variants).join(", ")}`);
					const [key]=selected,[command]=variants[key],body=input(a[key],forms[key]);
					return JSON.stringify(await runtime.operation(command,{run:a.run,...body},invocation.sessionId));
				}
				if (op === "status") {
					const {detail, ...base} = a;
					if (detail !== "permissions") return JSON.stringify(runtime.inspect(a, invocation.sessionId));
					runtime.inspect(base, invocation.sessionId);
					return JSON.stringify({session:invocation.sessionId, ...await permissions()});
				}
				if (op === "claim") return JSON.stringify(await runtime.claimWriter(a, invocation.sessionId));
				return JSON.stringify(await runtime.operation(op, a, invocation.sessionId));
			}
			catch (error) {
				if (error instanceof FoundryError && error.code === "approval_declined")
					return { resultType: "rejected", textResultForLlm: error.message };
				return { resultType: "failure", textResultForLlm: error instanceof Error ? error.message : String(error) };
			}
		}};
	});
}
