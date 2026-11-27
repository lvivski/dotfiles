import { validInstruction } from "./notice.mjs";
import { planDirectory, validOutcome } from "./contract.mjs";
import { indexRevision } from "./revision.mjs";
import { validWorkflows } from "./workflow.mjs";
import { hash as sha256, oid as commit, validName as id } from "../../../skills/foundry/scripts/recipe.mjs";
import { attemptSubject } from "./abi.mjs";
import { recordedAttempt, closedAttempt } from "./requirements.mjs";
import { sourceAt } from "./description.mjs";
import { correctionBasis, revisedTask } from "./amendment.mjs";
import { memberApproval } from "./receipt.mjs";
import { approvedInput } from "./consent.mjs";
import { validSignals } from "./signals.mjs";
import { changeOffer, changeOwners, checkpointReceipt, checkReceipt, comparisonVerdict, exhaustedCandidate, generationOf, goalReceipt, inconclusiveRepair, launcherFailure, missingInput, mixedVerification, omittedStep, productReceiptAt, relinquishable, sameEvaluation, verificationSource } from "./evidence.mjs";
import { validFeedback } from "./feedback.mjs";
import { validLead } from "./leads.mjs";
import { attachedNotes, noteId, noteText, sourceReceipt } from "./notes.mjs";
import { deliveredFile, indexBudgetError, rejectedSource, validMatch } from "./pages.mjs";
import { assignmentCount } from "./capacity.mjs";
import { candidateHandoff, checked, inputAttempt, originalAttempt, originalScope, owns, poolSource, validateNodes, writerVersion } from "./lineage.mjs";
import { continuationNotice, inputMessage, inputReference } from "./reference.mjs";
import { validDiagnostic } from "./diagnostics.mjs";
import { recordedDependency, sourceBinding, supplied as suppliedOffer } from "./supplier.mjs";
import { outside } from "./product.mjs";
import { comparison, investigation, readerInterrupted, successorDirectory } from "./charter.mjs";
import { assignmentDirectory, comparisonScope, contains, covers, digest, fail, members, mixed, ownership, relative, sameScope, roots as scopePaths } from "./values.mjs";
import { productOwnership, retainedMode, understandsTransfers } from "./transfer.mjs";
import { narrower, stoppedCheck } from "./successor.mjs";
import { historicalGrant, observerInput, restoredProduct, validRestoration } from "./partition.mjs";
import { validIsolation } from "./isolation.mjs";
import { validRemedy } from "./remedy.mjs";
import { validDeliveries } from "./batch.mjs";
import { resolutions } from "./resolution.mjs";
import { validOffers } from "./offers.mjs";
import { validDrafts } from "./drafts.mjs";
import { drafting } from "./rules/drafts.mjs";
import { validDraftScope } from "./preimages.mjs";
import { productLineage } from "./migrations.mjs";
import { frozenSubmission } from "./assignment.mjs";
import { assignment } from "./rules/assignment.mjs";
import { currentInspection, priorReview, reviewedGrant } from "./inspection.mjs";
import { inspection } from "./rules/inspection.mjs";
import { observedComponent, publicationVerdict } from "./publication.mjs";
import { disabledRoute, unissued } from "./dispatch.mjs";
import { call, review as discovery } from "./rules/dispatch.mjs";
import { controlSubject, failedTest, priorTest } from "./calibration.mjs";
import { boundInputs, described, replacementBlob, validInputs } from "./inputs.mjs";

/** @typedef {(value:unknown)=>boolean} Guard */
/** @type {Guard} */
const string = value => typeof value === "string";
/** @type {Guard} */
const path = value => typeof value === "string" && relative(value) === value;
/** @type {Guard} */
const count = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** @type {Guard} */
const positive = v => count(v) && v !== 0;
/** @type {Guard} */
const bool = value => typeof value === "boolean";
/** @param {unknown} v @returns {v is Record<string,unknown>} */
const object = v => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {...string} states @returns {Guard} */
const one = (...states) => v => typeof v === "string" && states.includes(v);
/** @param {Guard} guard @returns {Guard} */
const optional = guard => v => v === undefined || guard(v);
/** @param {Guard} guard @returns {Guard} */
const list = guard => v => Array.isArray(v) && v.every(guard);
/** @param {Guard} guard @returns {Guard} */
const named = guard => v => object(v) && Object.entries(v).every(([k, item]) => id(k) && guard(item));
/** @param {Record<string,Guard>} fields @returns {Guard} */
const shape = fields => v => object(v) && Object.entries(fields).every(([key, guard]) => guard(v[key]));
/** @type {Guard} */
const scope = v => path(v) || Array.isArray(v) && v.length > 1 && v.every((dir,i)=>path(dir) && (!i || v[i-1] < dir)) ||
	object(v) && path(v.primary) && Array.isArray(v.files) && v.files.length > 0 && digest(v) === digest(assignmentDirectory(v).directory);
const baseline = shape({directory:path,revision:commit,tree:commit});
/** @type {Guard} */
const inventory = v => baseline(v) || Array.isArray(v) && v.length>0 && v.every(baseline);
const output = { id, directory: scope, revision: optional(commit), check: path, needs: list(id),
	prior:optional(v=>one("independent","unavailable")(v) || shape({clause:noteText})(v)) };
const grain = shape({ ...output, specification: path, boundary: list(path), task: optional(string), agent: optional(string) });
const proposal = shape({ ...output, task: string });
const charter = { id, charter: path, agent: optional(string) };
const fixed = shape({ ...charter, grains: list(id) });
const area = shape({ ...charter, areas: list(path), boundary: list(path), checks: list(path), researchAgent: optional(id) });
const policy = shape({
	id, direction: string, target: string, source: path, sharedBrief: optional(path), base: commit, contractTarget:optional(commit), productCheck: path, ownership:optional(one("exact-files",retainedMode)), goalCheck: optional(path), files: list(path),
	squads: list(s => object(s) && ("areas" in s ? !("grains" in s) && area(s) : fixed(s))),
	workers: optional(positive), assignments: optional(count), repairs: count, deadline: optional(string), seed: optional(list(id))
});
/** @type {Guard} */
const observation = v => object(v) && string(v.reason) && Array.isArray(v.evidence) && v.evidence.length > 0 && v.evidence.every(path) &&
	Array.isArray(v.grains) && v.grains.every(g => id(g) || proposal(g)) && validOutcome(v.outcome, v.grains.length) &&
	(v.ownerInput === undefined || v.outcome === "needs-decision" && one("product-choice", "external-action")(v.ownerInput)) &&
	(v.references === undefined || Array.isArray(v.findings) && list(shape({ repo: id, revision: commit }))(v.references)) &&
	(v.findings === undefined ? v.outcome !== "researched" : (v.outcome === "researched" || v.outcome === "needs-decision" || v.outcome === "unresolved" || v.outcome === "waiting") &&
		list(shape({ kind: string, source: string, finding: string }))(v.findings) && (v.outcome !== "researched" || Array.isArray(v.findings) && v.findings.length > 0)) &&
	(v.outcome === "waiting" ? id(v.waitFor) || typeof v.waitFor === "string" && v.waitFor.startsWith("reference:") && id(v.waitFor.slice(10)) : v.waitFor === undefined) &&
	[v.file, v.receipt, v.detail].filter(k => k !== undefined).length === Number(v.outcome === "needs-evidence") &&
	optional(path)(v.file) && optional(id)(v.receipt) && optional(id)(v.detail) &&
	(v.offset === undefined || v.outcome === "needs-evidence" && count(v.offset)) &&
	(v.match === undefined || v.outcome === "needs-evidence" && validMatch(v.match)) &&
	(v.addresses === undefined || Array.isArray(v.addresses) && v.addresses.length > 0 &&
		v.addresses.every(shape({ id, grain: id, worker: optional(noteText) })) &&
		new Set(v.addresses.map(a => a.id)).size === v.addresses.length) &&
	(v.replace === undefined || v.outcome === "regenerate" && list(id)(v.replace));
/** @param {unknown} v @returns {v is import("./model.js").Packet} */
export const isPacket = v => object(v) && id(v.review) && commit(v.base) && bool(v.partial) && object(v.files) &&
	(v.sources === undefined || Array.isArray(v.sources) && v.sources.every(s => typeof s === "string" &&
		(s.startsWith("receipt:") && id(s.slice(8)) || s.startsWith("detail:") && commit(s.slice(7))))) &&
	(v.read === undefined || v.partial === true && object(v.read) && typeof v.read.source === "string" &&
		[v.read.start, v.read.end, v.read.length].every(count) && Number(v.read.end) <= Number(v.read.length) &&
		(v.read.hit === undefined || count(v.read.hit) && Number(v.read.start) <= Number(v.read.hit) && Number(v.read.hit) < Number(v.read.end)) &&
		(v.read.miss === true ? v.read.start === v.read.end && v.read.hit === undefined : v.read.miss === undefined && Number(v.read.start) < Number(v.read.end)) &&
		(v.read.source.startsWith("file:") ? path(v.read.source.slice(5)) && (v.read.miss === true || object(v.excerpt) &&
			v.read.source.slice(5) === v.excerpt.path && v.excerpt.start === v.read.start && v.excerpt.end === v.read.end && v.excerpt.length === v.read.length) :
			Array.isArray(v.sources) && v.sources.includes(v.read.source))) &&
	(v.excerpt === undefined || v.partial === true && object(v.excerpt) && path(v.excerpt.path) && commit(v.excerpt.oid) &&
		[v.excerpt.start, v.excerpt.end, v.excerpt.length].every(count) && Number(v.excerpt.start) < Number(v.excerpt.end) &&
		Number(v.excerpt.end) <= Number(v.excerpt.length) && !Object.hasOwn(v.files, String(v.excerpt.path))) &&
	Object.entries(v.files).every(([p, oid]) => path(p) && commit(oid)) && named(commit)(v.outputs);
/** @type {Guard} */
const decision = v => object(v) && (v.status === "presenting" && optional(id)(v.presentation) && optional(sha256)(v.selected) &&
	optional(shape({host:s=>typeof s==="string" && /^[0-9a-f]{64}$/.test(s),pid:n=>positive(n) && Number(n)<=2147483647}))(v.presenter) || v.status === "dismissed" ||
	v.status === "answered" && string(v.answer) ||
	v.status === "unavailable" && string(v.reason) && optional(id)(v.presentation));
const restoration=shape({from:id,historical:id,checkpoint:id,goal:id,retainer:id,tree:commit});
const referenceSource={grain:id,file:path,assignment:id,review:id,worker:noteText,generation:commit,grant:sha256,revision:commit,component:optional(id)};
const nodeShape = shape({
	retained: optional(list(shape({review:id,to:id,primary:path,files:list(path)}))),
	successor: optional(shape({review:id,to:id,directory:scope})),
	restoration: optional(restoration),
	grain, review: optional(id), state: one(...Object.keys(assignment.states)), token: optional(id), worker: optional(string),
	generation: optional(commit), inputs: optional(named(commit)), base: optional(commit), replaces: optional(commit), candidate: optional(commit), check: optional(id),
	supporting: optional(list(path)), excluded: optional(v => shape({path,revision:commit})(v) || shape({grain:id,revision:commit})(v)),
	priorSource: optional(inventory), reuse: optional(id), workspace: optional(id),
	repairs: count, reason: optional(string), artifactCursor: optional(count), preview: optional(commit),
	stop: optional(shape({kind: one("writer-missing-input","writer-cannot-repair","writer-relinquished"), detail: noteText,
		input:optional(shape({blob:commit,after:count,grant:optional(sha256),hold:optional(noteText),decision:optional(one("input")),source:optional(shape(referenceSource))}))}))
});
/** @type {Guard} */
const node = n => nodeShape(n) && object(n) && (n.excluded === undefined || n.state === "blocked") && (n.stop === undefined ||
	n.state === "blocked" && !!n.worker && !!n.token && !!n.generation && object(n.stop) && (n.stop.input===undefined ||
		n.stop.kind==="writer-missing-input" && !n.check && !n.candidate && !n.restoration && !n.reuse));
const assessment = { target: commit, commit, check: id };
const paths=shape({directories:list(path),files:list(path)});
/** @type {Guard} */
const ownedPaths=v=>object(v) && paths(v) && optional(paths)(v.exclude);
const scopes=named(ownedPaths);
const codeReview=shape({id,component:id,grain:id,issuer:noteText,candidate:commit,generation:commit,base:commit,scope:ownedPaths,task:noteText,assignment:optional(noteText),specification:optional(path),
	state:one(...Object.keys(inspection.states)),dispatch:optional(id),workflow:optional(noteText),summary:optional(noteText),permissionHold:optional(noteText),
	previous:optional(list(shape({issuer:noteText,dispatch:id,workflow:noteText,summary:noteText,assignment:optional(v=>v===true)})))});
const product = shape({ ...assessment, outputs: named(commit), ownership:optional(scopes), qualifiedAt: optional(positive),
	withdrawnHandoff:optional(shape({qualifiedAt:optional(positive),goal:id,recheck:id})) });
const proofNote=shape({file:path,blob:commit,excerpt:string,inputs:list(path),reason:string}), inventoryNote=shape({file:path,keys:list(string),blob:commit});
const proofNotes=list(v=>object(v) && proofNote(v) && (v.literal===true?v.inventory===undefined:v.literal===undefined && inventoryNote(v.inventory)));
const subset=shape({observer:id,checkpoint:id,goal:id,target:commit,assembly:commit,basis:sha256,ownership:scopes,
	hold:shape({historical:id,grain:id,original:id,pair:id,retainer:id,candidate:commit,component:id}),
	selected:list(shape({grain:id,candidate:commit,component:id})),
	evidence:list(shape({component:id,commit,stages:shape({component:proofNotes,generated:proofNotes,package:proofNotes,runtime:proofNotes})})),
	product:id,assessment:optional(id)});
const receipt = shape({ commit, check: path, inputs:optional(validInputs),test:optional(commit), control:optional(shape({assertion:id,matched:bool})),completedAt:optional(positive), evaluatorRevision: optional(commit), productEvaluatorRevision:optional(commit), exit: v => v === null || count(v), output: string,
	components:optional(named(shape({check:path,exit:v=>v===null || count(v),inputs:optional(validInputs),test:optional(commit)}))), resolutionDigest:optional(sha256),overlay:optional(sha256),
	failure: optional(one("changed-export", "incomplete")), repair: optional(id), squad: optional(id), blockers: optional(validSignals), feedback: optional(validFeedback),
	feedbackFile: optional(shape({ blob: commit, legacy: optional(bool) })) });
const preparedSource=shape({commit,hook:v=>v===null || shape({path:p=>p===".foundry/prepare-components",mode:one("100755"),blob:commit})(v)});
const checkStep=shape({member:v=>v===null || id(v),inputs:v=>validInputs(v) && v.prepared===undefined,build:v=>v===null || preparedSource(v)});
const description=shape({version:v=>v===1,use:one("component","attestation","historical-observation","calibration","product","goal","subset"),grant:sha256,
	target:commit,contract:commit,evaluation:v=>object(v) && (v.kind==="component" || v.kind==="product" && list(id)(v.outputs) || v.kind==="goal" && list(id)(v.squads)),
	privateInput:optional(commit),joined:optional(v=>v===true),resolutions:optional(sha256),steps:v=>Array.isArray(v) && v.length>0 && v.every(checkStep) &&
	v.at(-1).member===null && v.slice(0,-1).every((s,i)=>s.member && s.inputs.scope.grain===s.member && !v.slice(0,i).some(p=>p.member===s.member))});
export const receiptShape=receipt;
const dispatch = { id, issuer: string, args: object, evaluatorRevision: optional(commit), productEvaluatorRevision:optional(commit), callId: optional(string), error: optional(string), permissionHold: optional(string) };
const noteFields = { receipt: id, question: noteText, excerpt: optional(noteText) };
const scout = shape({ ...dispatch, kind: one("scout"), tool: one("workflow"), squad: id, base: commit, version: string,
	obstacle:optional(shape({kind:one("missing-output","overlap","stale-review","outside-scope","repeated-output","displaced-input","other"),subject:optional(noteText)})),
	state: one(...Object.keys(discovery.states)), observation: optional(observation),
	deferred: optional(shape({ pins: v => named(commit)(v) && object(v) && Object.keys(v).length > 0,
		consumers: v => Array.isArray(v) && v.length > 0 && v.every(id) && new Set(v).size === v.length })),
	workflowId: optional(string), providerRecovery:optional(one("needed","claimed")), decision: optional(decision), packet: optional(isPacket), retryOf: optional(id), retrySource: optional(commit), note: optional(shape(noteFields)),
	lead: optional(v => object(v) && id(v.receipt) && id(v.checkpoint) && optional(id)(v.priorReview) &&
		(v.pending === undefined ? id(v.missing) : v.missing === undefined && id(v.pending))),
	iteration: optional(shape({receipt: id, directory: path, files:optional(list(path)), blob: commit, question: noteText, basis: optional(one("checkpoint")),
		transfer:optional(shape({from:id,candidate:commit,to:id})),successor:optional(shape({from:id,check:id,to:id})),historical: optional(shape({receipt:id, missing:id, step:noteText})), source: optional(shape({goal:id,commit,file:path,excerpt:noteText})),follow:optional(v=>v===true)})), predecessor: optional(node),
	renewal:optional(shape({checkpoint:id,goal:id,state:one("needed","presenting","approved","held","closed"),reason:optional(noteText)})),
	correction: optional(shape({ worker: noteText, clause: noteText, file: path, excerpt: noteText, blob: optional(commit), predecessorCheck: optional(id),
		ordinary:optional(v=>v===true),resumed:optional(shape({prior:node,token:id})) })),
	otherNotes: optional(list(shape(noteFields))), diagnostic: optional(shape({ receipt: id, excerpt: noteText })), wake: optional(shape({ review: id, key: string })) });
const native = shape({
	verification:optional(description),
	attempt:optional(v=>object(v) && (v.version===1 && optional(one("never-issued","closed-before-runner-claim"))(v.closure) && Object.keys(v).every(k=>k==="version" || k==="closure") ||
		v.version===2 && optional(id)(v.previous) && Object.keys(v).every(k=>k==="version" || k==="previous") || v.version===3)),
	testPin:optional(id),
	calibration:optional(shape({stop:id,role:one("oldGood","newGood","newBad"),subject:sha256})),
	lane:optional(sha256),
	rollout:optional(sha256),
	replacement:optional(sha256),
	delivery:optional(sha256),
	rerun:optional(shape({of:id,checkpoint:id,candidate:commit,directory:scope,harness:list(path),current:list(path),after:optional(id),observedTarget:optional(commit)})),
	production:optional(shape({diagnostic:id,candidate:commit,checkpoint:id,goal:id,files:list(path),task:noteText,prior:node})),
	remedy:optional(shape({writer:id,basis:sha256})),
	isolation:optional(sha256),
	observer:optional(shape({pair:id,file:path,before:commit,after:optional(commit),previous:optional(shape({check:id,candidate:commit,
		phases:v=>Array.isArray(v) && v.length>=2 && v.length<=8 && new Set(v).size===v.length && v.every(p=>typeof p==="string" && p.trim()===p && p.length>0 && p.length<=120 && !/[\0\r\n]/.test(p))}))})),
	restoration:optional(restoration),
	pair:optional(shape({failed:id,component:id,candidate:commit,retainer:id,checkpoint:id,goal:id,target:commit,tree:commit})),
	...dispatch, kind: one("writer", "component", "rerun", "product", "goal", "repair", "decision", "handoff", "artifact", "escalation","control"), grain: optional(id), inlineRepair: optional(id),
	usedArtifacts: optional(list(commit)), comparedArtifacts: optional(list(commit)),
	reuse: optional(shape({predecessor:node, blob:commit, checkpoint:id, goal:id})),
	finished: optional(shape({squad:id,directory:scope,component:id,product:id})),
	pooled: optional(shape({from:id,home:v=>typeof v==="string" && v.startsWith("/") && !v.includes("\0"),generation:commit})),
	baseline: optional(inventory),
	baselineStop:optional(node),
	continuation:optional(shape({file:path,from:commit,to:commit,target:commit,productEvaluator:commit,goalEvaluator:commit})),
	input:optional(v=>object(v) && shape({prior:node,assignment:id,review:id,blob:commit,target:commit,goal:id,checkpoint:optional(id),requested:bool,withdrawn:optional(noteText)})(v) &&
		(v.dependency===undefined ? count(v.offer) && optional(sha256)(v.offerDigest) :
			v.offer===undefined && v.offerDigest===undefined && shape({source:shape({...referenceSource,component:id}),pooled:id})(v.dependency))),
	readGrant: optional(inventory),
	claims: optional(list(shape({ actor: string, path: string, start: string, kickoff: string, identity: string }))), claimedRequest: optional(string),
	retirement: optional(shape({ notification: id, read: id, completion: id })),
	token: optional(id), tool: one("create_session", "bash", "send_session_message", "session.send"), state: one(...Object.keys(call.states)),
	nativeId: optional(string), boundAt: optional(positive), commit: optional(commit), check: optional(path),
	launcherExit: optional(positive), recheck: optional(shape({ of:id, target:commit, goalPin:commit, productPin:commit })),
	runnerStarted: optional(bool), runnerClaim: optional(v => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v)), receipt: optional(receipt)
});
const rolloutFile=shape({file:path,mode:one("100644","100755"),before:v=>v===null||commit(v),result:v=>v===null||commit(v)});
const snapshot = shape({
	footprintRequests:optional(list(shape({id:sha256,observer:id,checkpoint:id,goal:id,target:commit,selected:list(shape({grain:id,candidate:commit,component:id})),checks:list(id)}))),
	diagnostics:optional(list(shape({id:sha256,kind:one("observe","observer","production","footprint"),grain:id,assignment:id,attempt:sha256,
		check:id,checkpoint:id,goal:id,target:commit,data:object}))),
	instructions:optional(list(shape({...dispatch,kind:one("instruction"),tool:one("session.send","send_session_message"),
		instruction:shape({kind:one("blocker","correction","read","observer","diagnosis","proposal","preview","footprint","subset","supply"),assignment:id,source:id,evidence:id,step:optional(id)}),
		token:id,grain:id,state:one(...Object.keys(call.states))}))),
	correctionDrafts:optional(list(shape({id:sha256,check:id,checkpoint:id,goal:id,target:commit,product:commit,assembly:commit,
		evaluator:optional(path),previousCheck:optional(id),finding:optional(shape({inspection:id,stamp:sha256,frontier:id})),automatic:bool,decision:optional(decision),previous:optional(list(decision)),blob:optional(commit),parts:list(shape({
			source:shape({kind:one("owned","inherited","harness","evaluator"),grant:string,grain:optional(id),component:optional(id),output:optional(commit),producer:optional(string)}),
			files:list(shape({file:path,before:v=>v===null || commit(v),mode:one("100644","100755")})),state:one(...Object.keys(drafting.states)),
			dispatch:optional(id),workflow:optional(id),changes:optional(list(rolloutFile)),reason:optional(string),awaitingPacket:optional(v=>v===true),continued:optional(v=>v===true)}))}))),
	testRepairs:optional(list(shape({stop:id,owner:id,target:commit,product:commit,pin:commit,before:commit,driver:commit,grain:optional(id),assertion:optional(id),
		rule:shape({check:path,probe:path}),controls:shape({oldGood:id,newGood:optional(id),newBad:optional(id)}),
		state:one("diagnosing","draft","authoring","checking","review","reviewing","approved","applied","product","unobserved","held"),reason:optional(string),wait:optional(string),
		author:optional(id),reviewer:optional(id),subject:optional(sha256),dispatch:optional(id),workflow:optional(id),continuation:optional(id),continuationAttempt:optional(positive),awaitingPermission:optional(v=>v===true),candidate:optional(commit),revision:optional(commit),blob:optional(commit),recheck:optional(id)}))),
	targetProposal:optional(sha256),offerHold:optional(noteText),
	adoptions:optional(list(shape({id:sha256,basis:v=>sha256(v) || typeof v==="string" && /^inputs\/1:[0-9a-f]{64}$/.test(v),revision:commit,checkpoint:id,goal:id,assembly:optional(commit),message:noteText,offeredThrough:optional(count),
		accepted:optional(shape({presentation:id,after:id,inputs:optional(list(approvedInput)),order:optional(list(id))})),
		evaluator:optional(shape({kind:one("goal","product"),from:commit,blob:commit,files:list(path),draft:optional(sha256)})),
		foreground:optional(shape({check:id,retry:id,variable:string,grains:named(shape({file:path,number:positive,line:string,blob:commit}))})),
		rollout:optional(shape({from:commit,blob:commit,harness:commit,files:list(rolloutFile),draft:optional(sha256),
			followup:optional(shape({proposal:sha256,assembly:commit,check:id,files:list(rolloutFile),observation:optional(v=>v===0 || v===1 || v===2),recipe:optional(shape({file:path,blob:commit,command:noteText}))})),
			included:named(shape({scope:ownedPaths,inputs:named(commit),legacy:optional(id)})),
			owners:named(shape({output:commit,component:id,binding:sha256,scope:ownedPaths,inputs:named(commit),specification:optional(path)}))})),
		failed:optional(id),patch:optional(shape({blob:commit,grain:id,draft:optional(sha256),files:list(shape({file:path,mode:one("100644","100755"),before:commit,result:commit})),
			owner:optional(shape({source:id,squad:id,directory:scope,output:commit,component:id,binding:sha256}))})),
		manifest:optional(shape({from:commit,productFrom:commit,goalFrom:commit,files:list(path),outputs:named(commit),ownership:one("directories","exact-files",retainedMode),
			retained:list(id),resolutions:optional(v=>resolutions(v).length>0)})),decision:optional(decision),previous:optional(list(decision))}))),
	inspections:optional(list(codeReview)),
	deliveries:optional(list(shape({id:sha256,checkpoint:id,goal:id,assembly:commit,selected:list(shape({rerun:id,tree:commit,prior:node})),assessment:optional(id),error:optional(string)}))),
	independent:optional(subset),
	id, owner: string, policy, references: optional(named(commit)),
	scheduling: optional(shape({ revision: positive, workers: optional(positive), checkpointReviews: bool })),
	repins: optional(list(shape({ from: commit, revision: commit, files: list(path), assessment:optional(id) }))),
	productRepins: optional(list(shape({ from:commit, revision:commit, files:list(path), checkpoint:id, goal:id, recheck:id, ownership:optional(one(retainedMode)), targetFrom:optional(commit),acceptance:optional(noteText),resolutions:optional(v=>resolutions(v).length>0),
		amendments:optional(list(shape({prior:product,proposal:sha256,recheck:id,harness:optional(commit)}))) }))),
	artifacts: optional(list(shape({ file: path, blob: commit, base: commit, publisher: string, to: list(path),assembly:optional(commit),
		evaluation:optional(shape({from:commit,checkpoint:id,goal:id})),source:optional(shape({...referenceSource,consumer:id,receiver:noteText,request:sha256})) }))),
	pendingReviewNotes: optional(list(shape({ ...noteFields, squad: id, after: count }))),
	attributions: optional(list(shape({ receipt: id, id, directory: path, blocked: positive, excerpt: noteText }))),
	active: bool, activatedAt: positive, pauseReason: optional(string), policyHold:optional(shape({issuer:string,effect:id,token:id})), nodes: named(node), effects: list(v => scout(v) || native(v)),
	products: list(product), join: optional(product), goal: optional(shape({ ...assessment, stall: optional(string),
		tried: optional(list(v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) })),
	blocker: optional(string), conflict: optional(string), discoveryError: optional(string)
});

/** @param {unknown} value @returns {value is import("./model.js").Run} */
function isRun(value) { return snapshot(value); }

/** A signed component, an admitted workflow and an independent approval are three different facts.
 * Historical approvals remain tied to their component even after its assignment leaves the graph.
 * @param {import("./model.js").Run} run @param {Map<string,import("./model.js").Effect>} effects */
function inspectLineage(run,effects){
	/** @type {Map<string,import("./model.js").Inspection>} */ const reviews=new Map();
	const approved=new Set(), ids=new Set(effects.keys()), tickets=new Set();
	for(const i of run.inspections??[]){
		const e=observedComponent(effects.get(i.component),i.grain,i.candidate)?.component;
		if(ids.has(i.id) || reviews.has(i.component) || !e || i.issuer!==e.issuer && i.issuer!==run.owner ||
			i.assignment!==undefined && priorReview(run,e)?.task!==i.assignment || i.previous?.some(a=>a.assignment && !i.assignment) ||
			i.specification!==undefined && (!run.policy.files.includes(i.specification) || run.nodes[i.grain]?.grain.specification!==i.specification ||
				run.nodes[i.grain].grain.task!==undefined || e.remedy || e.delivery || e.observer) ||
			!i.scope.directories.length && !i.scope.files.length || (i.state==="ready")!==!i.dispatch || i.workflow && !i.dispatch ||
			["approved","changes","unavailable"].includes(i.state) && (!i.summary || !i.workflow))
			fail("corrupt_run","Invalid independent review or component lineage");
		for(const a of [...i.previous??[],i]){
			if(a.issuer!==e.issuer && a.issuer!==run.owner || a.dispatch && tickets.has(a.dispatch))
				fail("corrupt_run","Invalid independent review issuer or ticket");
			if(a.dispatch)tickets.add(a.dispatch);
		}
		ids.add(i.id);reviews.set(i.component,i);
		if(publicationVerdict(i)==="approved")approved.add(`${i.grain}:${i.candidate}`);
	}
	if(run.inspections && (run.join ? [...run.products,run.join] : run.products).some(p=>
		Object.entries(p.outputs).some(([grain,sha])=>!approved.has(`${grain}:${sha}`))))
		fail("corrupt_run","A product includes an output without an independent review approval");
	return reviews;
}

/** @param {import("./model.js").Run} run @param {import("./model.js").Effect} e
 * @param {Map<string,import("./model.js").Effect>} effects @param {Map<string,import("./model.js").Product>} products */
function validDispatch(run, e, effects, products) {
	if("instruction" in e)return false;
	if(e.tool==="bash"){
		const a=e.attempt;
		if(a?.version===3 && (!closedAttempt(e) || !run.history || (a.previous===undefined?a.source.kind==="activation" && run.effects[0]!==e:
			!run.history[a.previous]) || (!e.runnerStarted || a.source.kind==="approval") && !recordedAttempt(run,e,sourceAt(run,e)) || !!e.runnerStarted!==!!e.runnerClaim))return false;
		if(a?.version===2 && (!described(e) || !!e.runnerStarted!==!!e.runnerClaim || e.receipt && !e.runnerClaim || e.lane))return false;
		if(a?.version===1 && a.closure && (e.runnerStarted || e.runnerClaim || e.receipt || e.launcherExit ||
			(a.closure==="never-issued"?!["ready","withdrawn"].includes(e.state) || e.callId!==undefined || e.error!==undefined || e.permissionHold!==undefined:
				!e.callId || !["issued","uncertain","done","refused"].includes(e.state))))return false;
		if(a?.version===2 && a.previous){
			const old=effects.get(a.previous);
			if(old?.tool!=="bash" || old.attempt?.version!==1 || !old.attempt.closure || !["withdrawn","done"].includes(old.state) ||
				old.issuer!==e.issuer || attemptSubject(old)!==attemptSubject(e) ||
				old.callId!==undefined && old.callId===e.callId || run.effects.indexOf(old)>=run.effects.indexOf(e) ||
				run.effects.some(x=>x!==e && x.tool==="bash" && x.attempt?.version===2 && x.attempt.previous===old.id))return false;
		}
	}
	const r=e.receipt,inputs=r?.inputs;
	if(r && !boundInputs(e,r))return false;
	const test=replacementBlob(r);
	if("testPin" in e){
		const job=run.testRepairs?.find(j=>j.stop===e.testPin),stop=e.testPin && effects.get(e.testPin);
		if(!job || !stop || job.state!=="applied" || job.recheck!==e.id || e.kind!==stop.kind || e.commit!==stop.commit ||
			e.check!==stop.check || e.grain!==stop.grain || e.issuer!==run.owner || e.rollout!==("rollout" in stop?stop.rollout:undefined))return false;
		if(r?.exit===0 && (job.grain && e.kind==="product"?replacementBlob(r.components?.[job.grain]):test)!==job.blob)return false;
	}
	if(test && e.kind!=="control" && !(e.tool==="bash" && (e.testPin && run.testRepairs?.some(j=>j.recheck===e.id && j.blob===test && j.rule.check===e.check) ||
		priorTest(run,e,e.grain)?.blob===test)))return false;
	if(r?.components && Object.entries(r.components).some(([grain,c])=>{
		const b=replacementBlob(c);
		return b && !run.testRepairs?.some(j=>j.state==="applied" && j.grain===grain && j.rule.check===c.check && j.blob===b);
	}))return false;
	if(e.kind==="control"){
		const k=e.calibration,j=run.testRepairs?.find(j=>j.stop===k?.stop);
		return !!k && !!j && j.controls[k.role]===e.id && e.issuer===run.owner && j.owner===run.owner && e.tool==="bash" &&
			e.check===j.rule.probe && e.commit===(k.role==="oldGood"?j.product:j.candidate) && k.subject===controlSubject(j,k.role) &&
			(!inputs || inputs.control?.commit===run.policy.base && inputs.control.checker.blob===j.driver && inputs.checker.path===j.rule.check &&
				inputs.checker.blob===(k.role==="oldGood"?j.before:j.blob) && (inputs.commit===j.product || inputs.commit===e.commit)) &&
			!e.grain && !e.rollout && !e.replacement && !e.recheck && !e.lane && !e.evaluatorRevision && !e.productEvaluatorRevision &&
			(!e.runnerClaim || !!e.runnerStarted && !!e.callId) && (!e.receipt || e.receipt.commit===e.commit && e.receipt.check===e.check &&
				!e.receipt.evaluatorRevision && !e.receipt.productEvaluatorRevision && !e.receipt.overlay &&
				(!e.receipt.control || e.receipt.exit===(e.receipt.control.matched?0:1)));
	}
	if("calibration" in e || e.receipt?.control)return false;
	if("lane" in e && !(e.kind==="component" && e.rollout || e.kind==="product" && mixedVerification(run,e.id)?.amendments?.some(s=>
		s.recheck===e.id && run.adoptions?.some(a=>a.id===s.proposal && a.foreground && digest(a.foreground)===e.lane))))return false;
	if("rollout" in e || "replacement" in e){
		if(e.kind!=="component" || e.issuer!==run.owner || !changeOffer(run,e) ||
			e.evaluatorRevision || e.productEvaluatorRevision || e.rerun || e.delivery || e.remedy || e.pair || e.observer || e.recheck ||
			e.isolation || e.inlineRepair || e.token || e.production || e.restoration || e.reuse || e.readGrant)return false;
	}
	if ((e.receipt?.components || e.receipt?.resolutionDigest) && !(e.kind==="product" && mixedVerification(run,verificationSource(run,e.id)))) return false;
	if(e.receipt?.overlay && (!e.evaluatorRevision || !e.runnerClaim || !(e.kind==="goal" || e.kind==="product")))return false;
	if (e.tool!=="workflow") {
		if (e.kind==="rerun" || e.rerun) {
			const pin=e.rerun;
			if (e.kind!=="rerun" || !pin || e.issuer!==run.owner || e.tool!=="bash" || e.recheck || e.pair || e.observer || e.remedy || e.isolation ||
				e.evaluatorRevision || e.productEvaluatorRevision || e.token || e.inlineRepair || e.receipt?.repair) return false;
			const prior=run.effects.slice(0,run.effects.indexOf(e)), old=effects.get(pin.of), p=products.get(pin.checkpoint);
			const last=prior.findLast(x=>x.kind==="rerun" && x.rerun?.of===pin.of && x.commit===e.commit);
			if (old?.kind!=="component" || old.pair || old.observer || old.remedy || !old.runnerClaim || !checkReceipt(old)?.exit ||
				!prior.includes(old) || old.grain!==e.grain || old.check!==e.check || old.commit!==pin.candidate ||
				!p || p.commit!==e.commit || !prior.some(x=>x.id===p.check && x.kind==="product") ||
				last?.id!==pin.after || last && (last.kind!=="rerun" || !checkReceipt(last) ||
					digest([last.rerun?.harness,last.rerun?.current])!==digest([pin.harness,pin.current]))) return false;
		}
		if ((e.remedy || e.production) && !validRemedy(run,e)) return false;
		if (e.observer) {
			const o=e.observer, old=effects.get(o.pair), prior=run.effects.slice(0,run.effects.indexOf(e));
			const original=prior.find(w=>old?.kind==="component" && w.kind==="writer" && w.restoration?.goal===old.pair?.goal &&
				w.grain===old.grain && !!w.restoration);
			const h=original?.kind==="writer" && original.restoration && historicalGrant(run,original.restoration.from,original.restoration.historical);
			if (!h || !o.file.startsWith(h.scope.primary+"/") || old?.kind!=="component" || !old.pair || old.grain!==e.grain ||
				!prior.includes(old) || !old.runnerClaim || checkReceipt(old)?.exit!==1 || e.pair || e.recheck || e.reuse || e.restoration ||
				o.before===o.after || !(e.kind==="writer" || e.kind==="component")) return false;
			const source=observerInput(prior,o), count=o.previous?1:0;
			const jobs=prior.filter(w=>w.kind==="writer" && w.observer?.pair===o.pair), w=jobs[count];
			if (!source?.commit || (o.previous && source.observer?.before===o.after) ||
				(e.kind==="writer" ? jobs.length!==count || e.tool!=="create_session" || e.issuer!==run.owner || e.args.base_branch!==source.commit :
				jobs.length!==count+1 || w?.kind!=="writer" || w.nativeId!==e.issuer || old.check!==e.check || !o.after ||
				digest(o)!==digest(w.observer) || e.commit===source.commit || prior.some(c=>c.kind==="component" && c.observer?.pair===o.pair &&
					c.observer.previous?.check===o.previous?.check))) return false;
		}
		if (e.launcherExit!==undefined && launcherFailure(e)!==e.launcherExit) return false;
		if (e.pair) {
			const a=e.pair, prior=run.effects.slice(0,run.effects.indexOf(e)), old=effects.get(a.failed), held=effects.get(a.component);
			const w=prior.findLast(x=>x.kind==="writer" && x.grain===e.grain), r=w?.kind==="writer" && w.restoration;
			const p=products.get(a.checkpoint), goal=prior.findLast(x=>x.kind==="goal");
			if (!r || e.kind!=="component" || e.issuer!==run.owner || e.recheck || !p || p.target!==a.target ||
				r.checkpoint!==a.checkpoint || r.goal!==a.goal || r.retainer!==a.retainer ||
				goal?.id!==a.goal || goal.commit!==p.commit || ![1,2].includes(checkReceipt(goal)?.exit ?? -1) ||
				old?.kind!=="component" || old.pair || old.grain!==e.grain || old.check!==e.check || old.commit===e.commit ||
				old.issuer!==w.nativeId || !old.runnerClaim || checkReceipt(old)?.exit!==1 || prior.indexOf(old)<=prior.indexOf(w) ||
				held?.kind!=="component" || held.grain!==a.retainer || !prior.includes(held) || held.commit!==a.candidate ||
				!held.runnerClaim || checkReceipt(held)?.exit!==0 || prior.some(x=>x.kind==="component" && x.pair?.failed===a.failed)) return false;
		}
		if (e.recheck) {
			const old = effects.get(e.recheck.of);
			if (e.tool!=="bash" || old?.tool!=="bash" || old===e || run.effects.indexOf(old)>=run.effects.indexOf(e) ||
				!launcherFailure(old) && !(old.kind==="goal" && old.runnerClaim && checkReceipt(old)?.exit===null) ||
				!(old.kind===e.kind && e.check===old.check && e.grain===old.grain || old.kind==="goal" && e.kind==="product") ||
				(e.kind==="component" ? e.issuer!==old.issuer || e.commit!==old.commit : e.issuer!==run.owner) ||
				(e.kind==="goal" && e.recheck.goalPin!==(e.evaluatorRevision ?? run.policy.base) ||
				e.kind==="product" && e.recheck.productPin!==(e.evaluatorRevision ?? run.policy.base)) ||
				run.effects.some(x=>x!==e && x.tool==="bash" && x.recheck?.of===old.id)) return false;
		}
	}
	if (e.state==="withdrawn" && !(e.tool==="bash" && e.attempt?.version===1 && e.attempt.closure==="never-issued")){
		const input=e.kind==="repair" && (e.input || e.continuation && e.baselineStop);
		if((e.callId || e.error) && !(input && e.callId && e.error===disabledRoute) || e.permissionHold || e.claims || e.reuse || e.observer || e.receipt || !e.grain)return false;
		if(e.kind==="component"){
			const id=memberApproval(e);
			if(!id || e.runnerStarted || !run.adoptions?.some(a=>a.rollout?.followup?.proposal===id && a.decision?.status==="answered"))return false;
		}else if(e.kind!=="writer" && !input || !e.token || run.nodes[e.grain]?.token===e.token)return false;
	}
	if (e.state === "retired" || "retirement" in e) {
		if (e.kind !== "goal" || e.state !== "retired" || !e.retirement || e.issuer !== run.owner || !e.runnerStarted ||
			!e.callId || e.receipt || e.runnerClaim || e.permissionHold || e.args.shellId !== `foundry-${e.id}` ||
			new Set(Object.values(e.retirement)).size !== 3) return false;
	}
	if (e.runnerClaim !== undefined && (e.tool !== "bash" || !e.runnerStarted || !e.callId ||
		!(e.kind === "component" || e.kind === "rerun" || e.kind === "product" || e.kind === "goal"))) return false;
	if (e.permissionHold !== undefined && !unissued(e)) return false;
	if (e.receipt?.feedback !== undefined && e.receipt.feedbackFile) return false;
	if (e.receipt?.blockers && (e.kind !== "goal" || !e.runnerStarted || !e.callId ||
		e.receipt.exit !== 1 && !((e.receipt.exit === 0 || e.receipt.exit === 2) && e.receipt.blockers.every(s => "passed" in s)))) return false;
	if ((e.receipt?.feedback !== undefined || e.receipt?.feedbackFile) && (e.kind !== "goal" || !e.runnerStarted || !e.callId ||
		e.receipt.exit !== 0 && e.receipt.exit !== 1)) return false;
	if (e.evaluatorRevision && e.kind !== "product" && (!(e.kind === "goal" || e.kind === "scout") || !run.repins?.some(p => p.revision === e.evaluatorRevision))) return false;
	if (e.receipt?.failure && (e.kind !== "component" && e.kind!=="rerun" || !e.runnerStarted || !e.callId || e.receipt.exit !== null ||
		e.receipt.repair || e.receipt.squad || e.state !== "done" && e.state !== "refused")) return false;
	if (e.tool === "workflow") {
		const squad = run.policy.squads.find(s => s.id === e.squad), report = e.observation;
		if (e.lead && (!squad || !("areas" in squad) || e.iteration || !validLead(run, e.lead, e, squad))) return false;
		if (e.iteration) {
			const i = e.iteration, r = sourceReceipt(run.effects.find(g => g.id === i.receipt), i);
			if (i.follow && (!i.source || i.transfer || i.successor)) return false;
			if (i.transfer && (!i.files || !i.source || !understandsTransfers(run,e.productEvaluatorRevision) ||
				run.products.find(p=>p.check===i.receipt)?.outputs[i.transfer.from]!==i.transfer.candidate)) return false;
			if (i.successor) {
				const s=i.successor, old=effects.get(s.check), receipt=checkReceipt(old);
				if (i.transfer || !i.source || !covers(comparisonScope(i),i.source.file) || s.from===s.to ||
					old?.kind!=="component" || old.grain!==s.from || !old.runnerClaim || !receipt?.exit ||
					run.effects.indexOf(old)>=run.effects.indexOf(e) || products.get(i.receipt)?.outputs[s.from]) return false;
			}
			if (i.files && (!i.source || !(run.policy.ownership || e.productEvaluatorRevision) || !scope(comparisonScope(i)) ||
				!squad || !("areas" in squad) || !owns(squad,comparisonScope(i)) || !outside(comparisonScope(i),run.policy.files))) return false;
			if (!squad || !("areas" in squad) || !owns(squad, i.directory) || e.issuer !== run.owner || e.retryOf || e.wake ||
				!(i.basis ? productReceiptAt(run, i.receipt, e.base,e.productEvaluatorRevision) : r?.exit === 1 && r.commit === e.base && sameEvaluation(r,e)) ||
				i.historical && (!i.basis || run.effects.findIndex(g => g.id === i.historical?.missing) >= run.effects.indexOf(e) ||
					!omittedStep(run, i.historical, e.base, e.evaluatorRevision,e.productEvaluatorRevision)) ||
				!run.artifacts?.some(a => a.blob === i.blob && a.to.some(dir => contains(dir, i.directory)))) return false;
			if (i.source) {
				const goal = run.effects.slice(0,run.effects.indexOf(e)).findLast(g=>g.kind==="goal");
				if (!i.basis || i.historical || i.source.commit !== e.base || !owns(squad,i.source.file) ||
					goal?.id !== i.source.goal || goal.commit !== e.base || goal.check !== run.policy.goalCheck ||
					!sameEvaluation(goal,e) || !comparisonVerdict(checkReceipt(goal)?.exit,i.successor)) return false;
			}
		}
		if (e.renewal) {
			const n=e.renewal, i=comparison(run,e), p=products.get(n.checkpoint), g=effects.get(n.goal);
			if (!i?.source || i.transfer || i.successor || !p || p.commit===e.base || p.target!==products.get(i.receipt)?.target ||
				!productReceiptAt(run,n.checkpoint,p.commit,e.productEvaluatorRevision) || g?.kind!=="goal" || g.commit!==p.commit ||
				checkReceipt(g)?.exit!==2 || !sameEvaluation(g,e) || !e.packet || !e.workflowId || !e.callId ||
				report?.outcome!=="regenerate" || report.grains.length!==1 || report.replace?.length ||
				typeof report.grains[0]!=="object" || !sameScope(report.grains[0].directory,comparisonScope(i)) ||
				(n.state==="held" || n.state==="closed")!==!!n.reason || (e.state!=="blocked" && !(n.state==="approved" && e.state==="observed"))) return false;
		}
		if (e.correction) {
			const c = e.correction, basis=correctionBasis(run,e,c.file), g = report?.grains[0];
			if (typeof g !== "object" || !basis || basis.blob!==c.blob || basis.predecessorCheck!==c.predecessorCheck || basis.ordinary!==c.ordinary ||
				!revisedTask(e,g.id,c.clause) || !run.effects.some(w => w.kind === "writer" && w.state === "done" && w.grain === g.id && w.nativeId === c.worker)) return false;
			if ("resumed" in c && c.resumed) {
				const {prior,token}=c.resumed, notice=run.effects.find(w=>w.kind==="repair" && w.token===token);
				if (!c.ordinary || prior.review!==e.id || prior.worker!==c.worker || prior.base!==e.base || !prior.preview ||
					prior.check || prior.candidate || missingInput(prior)===undefined || prior.grain.task!==g.task || prior.grain.id!==g.id ||
					!sameScope(prior.grain.directory,g.directory) || prior.grain.check!==g.check || prior.token===token ||
					!notice || notice.issuer!==run.owner || notice.grain!==g.id || notice.args.session_id!==c.worker ||
					!run.effects.slice(run.effects.indexOf(e)+1,run.effects.indexOf(notice)).some(w=>w.kind==="writer" && w.token===prior.token &&
						w.grain===g.id && w.nativeId===c.worker && w.state==="done" && generationOf(w)===prior.generation)) return false;
			}
		}
		if (e.diagnostic) {
			const d = e.diagnostic, src = run.effects.find(r => r.id === e.retryOf), receipt = sourceReceipt(run.effects.find(r => r.id === d.receipt), d);
			if (src?.kind !== "scout" || src.error !== indexBudgetError || src.packet || src.note ||
				receipt?.exit !== 1 || receipt.commit !== e.base || !sameEvaluation(receipt,e) || e.packet && !e.packet.partial) return false;
		}
		if (e.predecessor) {
			const n = e.predecessor, g = report?.grains[0];
			if (e.state !== "observed" || report?.outcome !== "regenerate" || report.grains.length !== 1 || typeof g !== "object" ||
				(n.candidate ? !candidateHandoff(run, n, g, e) : missingInput(n) === undefined) ||
				!n.worker || !n.base || (n.candidate || e.retryOf || n.base === e.base) && !sameScope(successorDirectory(run, e, report),g.directory) ||
				g.task === n.grain.task ||
				g.id === n.grain.id || !sameScope(g.directory,n.grain.directory) || g.check !== n.grain.check ||
				!run.effects.some(w => w.kind === "writer" && w.grain === n.grain.id && w.nativeId === n.worker && w.state === "done")) return false;
		}
		if (e.retrySource && (!e.retryOf || e.wake || e.lead || e.diagnostic)) return false;
		if (e.retryOf) {
			const src = effects.get(e.retryOf);
			if (src?.kind !== "scout" || src.retryOf || src.state !== "blocked" || !src.workflowId ||
				e.issuer !== run.owner && (e.issuer !== src.issuer || !readerInterrupted(src)) ||
				src.squad !== e.squad || src.base !== e.base || src.version !== e.version || !sameEvaluation(src,e) ||
				run.effects.indexOf(src) >= run.effects.indexOf(e) ||
				run.effects.some(other => other !== e && other.kind === "scout" && other.retryOf === e.retryOf)) return false;
			if (e.retrySource ? src.issuer !== e.issuer || !src.iteration?.source || !rejectedSource(src, e.retrySource) ||
				e.packet && !deliveredFile(e.packet, src.iteration.source.file, e.retrySource) : !!src.observation) return false;
		}
		return !!squad && !e.nativeId && !e.token && !e.receipt && !e.boundAt && (!e.workflowId || !!e.callId) &&
			(e.state !== "suspended" && !e.providerRecovery || !!e.workflowId) &&
			(e.wake?.key !== "research" && report?.outcome !== "needs-research" || "areas" in squad && !!squad.researchAgent) &&
			(!report || investigation(e, squad) === (report.findings !== undefined)) &&
			(!e.packet || e.packet.review === e.id && e.packet.base === e.base) &&
			(e.state !== "reported" && e.state !== "observed" && e.state !== "deferred" || !!report && !!e.workflowId && !!e.packet) &&
			(e.state === "deferred" ? !!e.deferred && "areas" in squad && report?.outcome === "regenerate" : !e.deferred) &&
			(e.wake?.key !== "released-inputs" || run.effects.some(src => src.kind === "scout" && src.state === "deferred" &&
				src.squad === e.squad && src.id === e.wake?.review)) &&
			(!e.decision || e.state === "observed" && report?.outcome === "needs-decision") &&
			("areas" in squad || !report || !report.replace && report.grains.every(g => typeof g === "string"));
	}
	if (e.workflowId || Boolean(e.nativeId) !== Boolean(e.boundAt)) return false;
	if (e.restoration && (e.kind!=="writer" || e.issuer!==run.owner || !e.grain || e.reuse ||
		!historicalGrant(run,e.restoration.from,e.restoration.historical) || !products.has(e.restoration.checkpoint) ||
		effects.get(e.restoration.goal)?.kind!=="goal" || run.effects.findIndex(x=>x.id===e.restoration?.goal)>=run.effects.indexOf(e) ||
		!restoredProduct(run,e) && digest(run.nodes[e.grain]?.restoration ?? null)!==digest(e.restoration))) return false;
	if (e.finished) {
		const f=e.finished,c=effects.get(f.component),p=products.get(f.product);
		if (e.kind!=="writer" || e.state!=="done" || !e.nativeId || c?.kind!=="component" || c.grain!==e.grain || c.issuer!==e.nativeId ||
			!c.commit || checkReceipt(c)?.exit!==0 || !e.grain || p?.outputs[e.grain]!==c.commit ||
			!run.policy.squads.some(s=>s.id===f.squad && ("areas" in s ? owns(s,f.directory) : s.grains.includes(e.grain ?? "")))) return false;
	}
	if(e.pooled && !poolSource(run,e,id=>effects.get(id)))return false;
	if (e.reuse) {
		const {predecessor:n,blob,checkpoint,goal} = e.reuse, p = run.products.find(p => p.check === checkpoint);
		const at = run.effects.find(h => h.id === goal);
		if (e.kind !== "writer" || e.issuer !== run.owner || e.grain !== n.grain.id || !exhaustedCandidate(run,n) ||
			!p || at?.kind !== "goal" || at.commit !== p.commit || !run.artifacts?.some(a => a.blob === blob && scopePaths(n.grain.directory).some(dir => covers(a.to,dir))) ||
			run.effects.some(other => other !== e && other.kind === "writer" && other.reuse?.predecessor.check === n.check)) return false;
	}
	if (e.readGrant && (e.kind !== "writer" || e.state !== "done" || !e.callId)) return false;
	const stopped=e.input?.prior??e.baselineStop;
	if(stopped?.stop?.input?.grant && stopped.stop.input.grant!==writerVersion(stopped))return false;
	if(e.continuation){
		const n=e.input?.prior??e.baselineStop, pair=e.continuation;
		const prior=run.effects.slice(0,run.effects.indexOf(e));
		if(e.kind!=="repair" || !n || !n.review || !originalScope(run,n,effects.get(n.review)) || n.grain.specification!==pair.file ||
			pair.from===pair.to || e.input && e.input.target!==pair.target ||
			!run.products.some(p=>p.target===pair.target && prior.some(c=>c.id===p.check && (c.evaluatorRevision??run.policy.base)===pair.productEvaluator) &&
				prior.some(g=>g.kind==="goal" && g.commit===p.commit && (g.evaluatorRevision??run.policy.base)===pair.goalEvaluator)) ||
			[n.grain.check,...n.grain.boundary].includes(pair.file) ||
			typeof e.args.message!=="string" || !e.args.message.endsWith(continuationNotice(pair)))return false;
	}
	if (e.input) {
		const {prior:n,assignment,review,blob,offer,dependency,target,goal,checkpoint,requested}=e.input;
		const w=effects.get(assignment),r=effects.get(review),a=inputReference(run,e.input),g=effects.get(goal),p=checkpoint?products.get(checkpoint):undefined;
		const at=run.effects.indexOf(e),history={...run,effects:run.effects.slice(0,at)};
		if(!a || n.stop?.input && n.stop.input.blob!==blob)return false;
		if("dependency" in a){
			if(!dependency || requested!==!!n.stop?.input?.source || !recordedDependency(history,n,dependency,p))return false;
		}else if(offer===undefined || a.blob!==blob || (a.source || e.continuation || e.input.offerDigest) && e.input.offerDigest!==digest(a) ||
			(a.source ? requested!==!!n.stop?.input || !suppliedOffer(history,n,a,offer) : a.publisher!==run.owner || n.stop?.input?.source) ||
			a.assembly || a.evaluation || !scopePaths(n.grain.directory).some(d=>covers(a.to,d)) ||
			requested && (!n.stop?.input || offer<n.stop.input.after || !scopePaths(n.grain.directory).some(d=>a.to.includes(d))))return false;
		if (e.kind!=="repair" || (e.state==="withdrawn")!==!!e.input.withdrawn || e.tool!=="send_session_message" || e.args.session_id!==n.worker || e.issuer!==run.owner || e.grain!==n.grain.id ||
			!n.base || !n.generation || !n.token || n.token===e.token || missingInput(n)===undefined || n.check || n.candidate || n.review!==review ||
			!originalScope(run,n,r) || w?.kind!=="writer" || !w.callId || w.state!=="done" || w.error || w.reuse || w.observer || w.production || w.restoration ||
			inputAttempt(history,n)!==w ||
			g?.kind!=="goal" || run.effects.indexOf(g)>=at || (checkpoint ? !p || p.target!==target || g.commit!==p.commit : g.commit!==target) ||
			e.args.message!==`Foundry assignment: ${run.id} ${e.token}\n${inputMessage(a,n)}${continuationNotice(e.continuation)}` ||
			run.effects.slice(0,at).some(other=>other.kind==="repair" && other.state!=="withdrawn" && other.input && (other.input.prior.token===n.token ||
				other.input.assignment===assignment && other.input.blob===blob))) return false;
	}
	if (e.baseline && (e.kind !== "repair" || e.issuer !== run.owner || e.tool !== "send_session_message" ||
		!run.effects.some(w => w.kind === "writer" && w.state === "done" && w.grain === e.grain && w.nativeId === e.args.session_id))) return false;
	if (e.baselineStop){
		const n=e.baselineStop,w=originalAttempt({...run,effects:run.effects.slice(0,run.effects.indexOf(e))},n);
		if(!e.baseline || e.input || !w || n.grain.id!==e.grain || n.worker!==e.args.session_id || n.token===e.token ||
			!n.generation || generationOf(w)!==n.generation || missingInput(n)===undefined || n.candidate || n.check ||
			members(e.baseline).some(b=>b.revision!==(n.grain.revision??n.base) || !ownership(n.grain.directory).directories.includes(b.directory)) ||
			n.priorSource && digest(n.priorSource)!==digest(e.baseline))return false;
	}
	if (e.claims && (e.kind !== "writer" || !e.callId || !e.claims.length ||
		new Set(e.claims.map(c => c.actor)).size !== e.claims.length)) return false;
	if (e.claimedRequest && (e.state !== "done" || e.claims?.length !== 1 || e.claims[0].actor !== e.nativeId)) return false;
	if (e.inlineRepair && (e.kind !== "component" || !checkReceipt(e))) return false;
	if ((e.usedArtifacts || e.comparedArtifacts) && e.kind !== "component") return false;
	if (e.kind === "writer") return (e.tool === "create_session" || !!e.pooled) && !!e.grain && !!e.token && (e.state === "done") === !!e.nativeId;
	if (e.nativeId) return false;
	if (e.kind === "goal" || e.kind === "product" || e.kind === "component" || e.kind==="rerun")
		return e.tool === "bash" && !!e.commit && !!e.check && (e.kind === "component" || e.kind==="rerun") === !!e.grain &&
			(!e.receipt || e.receipt.commit === e.commit && e.receipt.check === e.check && sameEvaluation(e.receipt,e)) &&
			(!e.receipt?.squad || e.kind === "goal" && e.receipt.exit === 1 && run.policy.squads.some(s => s.id === e.receipt?.squad));
	if (!e.token || e.receipt || !string(e.args.message)) return false;
	if (e.kind === "escalation") return !e.grain && /^[a-f0-9]{64}$/.test(e.token) && (e.issuer === run.owner ?
		e.tool === "session.send" && e.state !== "ordinary" : e.tool === "send_session_message" && e.args.session_id === run.owner);
	if (e.kind === "repair" || e.kind === "artifact") return !!e.grain && (e.tool === "send_session_message" || e.tool === "session.send" && e.state !== "ordinary");
	return e.issuer === run.owner ? e.kind === "handoff" && e.tool === "session.send" && e.state !== "ordinary"
		: e.tool === "send_session_message" && e.args.session_id === run.owner;
}

/** @param {unknown} value @param {boolean} [storeView] @returns {import("./model.js").Run} */
export function decode(value,storeView=false) {
	if (!isRun(value) || value.policy.id !== value.id || value.active && value.pauseReason !== undefined ||
		value.scheduling?.workers !== undefined && value.policy.workers !== undefined && value.scheduling.workers > value.policy.workers ||
		"capacity" in value || value.policy.assignments !== undefined && assignmentCount(value) > value.policy.assignments ||
		Boolean(value.policy.goalCheck) !== Boolean(value.goal) || value.goal && value.policy.seed)
		fail("corrupt_run", "Invalid Foundry execution snapshot");
	const { policy: p, nodes, products } = value, areas = p.squads.filter(s => "areas" in s), files = new Set(p.files);
	if(value.artifacts?.some(a=>a.source && (a.assembly || a.evaluation || a.to.length!==1 || a.source.grain===a.source.consumer || a.source.worker===a.source.receiver ||
		a.base!==a.source.revision || a.file!==a.source.file || a.publisher!==a.source.worker || !sourceBinding(value,a.source))) ||
		Object.values(nodes).some(n=>n.stop?.input?.source && !sourceBinding(value,n.stop.input.source)))
		fail("corrupt_run","Invalid original producer, source or recipient of a reference");
	const effects = new Map(value.effects.map(e => [e.id, e]));
	if(!validWorkflows(value))fail("corrupt_run","Native workflow belongs to more than one subject or dispatch");
	const diagnostics=value.diagnostics??[];
	const requests=value.footprintRequests??[];
	if(new Set(requests.map(q=>q.id)).size!==requests.length || requests.some(({id,...q})=>{
		const p=products.find(p=>p.check===q.checkpoint),g=effects.get(q.goal),o=effects.get(q.observer);
		return digest(q)!==id || !p || p.target!==q.target || g?.kind!=="goal" || g.commit!==p.commit || o?.kind!=="component" || !o.observer ||
			!q.selected.length || !q.checks.includes(q.observer) || new Set(q.checks).size!==q.checks.length || q.checks.some(c=>effects.get(c)?.kind!=="component") ||
			q.selected.some(s=>!q.checks.includes(s.component) || effects.get(s.component)?.grain!==s.grain || effects.get(s.component)?.commit!==s.candidate);
	}))fail("corrupt_run","Invalid scoped diagnostic evidence request");
	if(new Set(diagnostics.map(d=>d.id)).size!==diagnostics.length || diagnostics.some(d=>!validDiagnostic(value,d)))
		fail("corrupt_run","Invalid writer-supplied diagnostic evidence");
	const notices=value.instructions??[];
	const calls=new Set(value.effects.filter(e=>e.callId).map(e=>JSON.stringify([e.issuer,e.callId])));
	if(new Set(notices.map(c=>c.id)).size!==notices.length || notices.some(c=>{
		if(effects.has(c.id) || !validInstruction(value,c))return true;
		if(!c.callId)return false;
		const key=JSON.stringify([c.issuer,c.callId]);if(calls.has(key))return true;calls.add(key);return false;
	}))
		fail("corrupt_run","Invalid scoped writer instruction or delivery");
	const repairs=value.testRepairs??[];
	if(new Set(repairs.map(j=>j.stop)).size!==repairs.length || repairs.some(j=>{
		const original=effects.get(j.stop),old=effects.get(j.controls.oldGood);
		const good=j.controls.newGood && effects.get(j.controls.newGood),bad=j.controls.newBad && effects.get(j.controls.newBad);
		const certified=["review","reviewing","approved","applied"].includes(j.state);
		const subject=original?.tool==="bash" && failedTest(original);
		return !subject || !original || original.commit!==j.product || subject.check!==j.rule.check || subject.grain!==j.grain ||
			j.rule.probe!==j.rule.check+".control" || !p.files.includes(j.rule.check) || j.owner!==value.owner ||
			old?.kind!=="control" || old.calibration?.stop!==j.stop || old.calibration.role!=="oldGood" ||
			j.state==="product" && (subject.missing || !checkReceipt(old)?.control?.matched) ||
			j.state==="unobserved" && (!subject.missing || !["done","refused"].includes(old.state) || checkReceipt(old)?.control?.matched===false || !!good || !!bad) ||
			!!good!==!!bad || good && (good.kind!=="control" || good.calibration?.stop!==j.stop || good.calibration.role!=="newGood") ||
			bad && (bad.kind!=="control" || bad.calibration?.stop!==j.stop || bad.calibration.role!=="newBad") ||
			certified && (!j.assertion || [old,good,bad].some(c=>!c || checkReceipt(c)?.control?.assertion!==j.assertion)) ||
			certified && !(checkReceipt(old)?.control?.matched===false && good && checkReceipt(good)?.control?.matched===true &&
				bad && checkReceipt(bad)?.control?.matched===false && j.author && j.revision && j.blob && j.candidate) ||
			(j.workflow && !j.dispatch || j.continuation && j.continuation!==j.workflow || j.continuationAttempt && !j.continuation || j.awaitingPermission && !j.workflow ||
				["authoring","reviewing"].includes(j.state) && (!j.subject || !j.dispatch)) ||
			(j.state==="approved" || j.state==="applied") && (!j.reviewer || j.reviewer===j.author || !j.subject || j.workflow && j.workflow!==j.reviewer) ||
			j.state==="applied" && (original.kind==="goal"? !value.repins?.some(p=>p.from===j.pin && p.revision===j.revision && digest(p.files)===digest([j.rule.check])) :
				!j.recheck || effects.get(j.recheck)?.kind!==original.kind || !value.effects.some(e=>e.tool==="bash" && e.id===j.recheck && e.testPin===j.stop));
	}))fail("corrupt_run","Invalid test-repair control or adoption lineage");
	const inspections=inspectLineage(value,effects);
	if (value.policyHold && (value.active || !value.pauseReason ||
		(effects.get(value.policyHold.effect)??value.inspections?.find(i=>i.id===value.policyHold?.effect)??notices.find(c=>c.id===value.policyHold?.effect))?.issuer!==value.policyHold.issuer))
		fail("corrupt_run","Invalid managed permission hold");
	const attributions = value.attributions ?? [];
	if (new Set(attributions.map(a => `${a.receipt}:${a.id}`)).size !== attributions.length || attributions.some(a => {
		const r = sourceReceipt(effects.get(a.receipt), a);
		return r?.exit !== 1 || r.blockers?.some(s => s.id === a.id) || !Number.isSafeInteger(a.blocked + 1);
	})) fail("corrupt_run", "Invalid shared blocker attribution");
	const grants = new Map(value.effects.flatMap(e => e.kind === "writer" && e.readGrant ? [[e.token, e]] : []));
	const supplied=new Map(value.effects.flatMap(e=>e.kind==="repair" && (e.input || e.baselineStop && e.continuation) ? [[e.token,e]] : []));
	const observers = new Map(value.effects.flatMap(e => e.kind==="writer" && e.observer ? [[e.token,e]] : []));
	const queued = value.pendingReviewNotes ?? [];
	if (new Set(queued.map(n => `${n.squad}:${noteId(n)}`)).size !== queued.length || queued.some(n => n.after > value.effects.length ||
		!p.squads.some(s => s.id === n.squad) || !sourceReceipt(effects.get(n.receipt), n)) ||
		value.effects.some(e => e.kind === "scout" && (e.otherNotes && !e.note || e.note && (!e.workflowId || e.retryOf ||
			p.squads.some(s => s.id === e.squad && investigation(e, s)) || attachedNotes(e).some(n => !sourceReceipt(effects.get(n.receipt), n))))))
		fail("corrupt_run", "Invalid historical receipt for scout review");
	const pins = value.repins ?? [];
	if (pins.length && (!value.goal || new Set([p.base, ...pins.map(pin => pin.revision)]).size !== pins.length + 1 ||
		pins.some((pin, i) => pin.from !== (i ? pins[i-1].revision : p.base) || !pin.files.length ||
			new Set(pin.files).size !== pin.files.length || !pin.files.every(f => f.startsWith(".foundry/") ||
				f===p.goalCheck && repairs.some(j=>j.state==="applied" && !j.grain && j.rule.check===f && j.revision===pin.revision) ||
				p.files.includes(f) && value.productRepins?.some(q=>q.targetFrom && q.revision===pin.revision)))))
		fail("corrupt_run", "Invalid goal evaluator pin history");
	const last = products.at(-1);
	const checkpoints = new Map(products.map(p=>[p.check,p]));
	if(!validDrafts(value) || value.correctionDrafts?.some(d=>!validDraftScope(value,d)))fail("corrupt_run","Invalid correction-author source, dispatch or returned manifest");
	if(!validOffers(value,checkpoints,effects))fail("corrupt_run","Invalid mixed-target adoption proposal or approval lineage");
	if (!validDeliveries(value)) fail("corrupt_run","Invalid test delivery or component lineage");
	if (!validIsolation(value)) fail("corrupt_run","Invalid independent checkpoint or original ownership hold");
	if (!productLineage(value,checkpoints,effects)) fail("corrupt_run","Invalid product evaluator lineage");
	if (effects.size !== value.effects.length || value.effects.some(e => !validDispatch(value, e, effects, checkpoints)))
		fail("corrupt_run", "Invalid Foundry dispatch");
	if (areas.length && (!value.goal || areas.length !== value.policy.squads.length) ||
		p.sharedBrief !== undefined && (!areas.length || p.sharedBrief !== `${planDirectory(p.source)}/journey.md` ||
			areas.some(s => s.boundary.length !== 1 || s.boundary[0] !== p.sharedBrief)) ||
		![p.source, p.productCheck, ...(p.goalCheck ? [p.goalCheck] : []), ...p.squads.flatMap(s => "areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter])].every(f => files.has(f)) ||
		[p.seed ?? [], ...p.squads.flatMap(s => "grains" in s ? [s.grains] : [])].some(ids => ids.some(id => !Object.hasOwn(nodes, id))) ||
		Object.entries(nodes).some(([id, n]) => {
			const g = n.grain, e = n.check ? effects.get(n.check) : undefined;
			const notice=supplied.get(n.token), prior=notice?.input?.prior??notice?.baselineStop;
			if (notice && prior && (n.state==="writing" || frozenSubmission(n)) && (notice.state==="refused" ||
				n.state!=="writing" && notice.state!=="done" || n.worker!==prior.worker || n.generation!==prior.generation || n.base!==prior.base ||
				n.review!==prior.review || n.workspace!==prior.workspace || n.repairs!==prior.repairs+1 || n.retained || n.successor || n.restoration || n.reuse ||
				digest(n.grain)!==digest(prior.grain) || digest(n.inputs)!==digest(prior.inputs) || digest(n.supporting??[])!==digest(prior.supporting??[]) ||
				digest(n.priorSource??null)!==digest(prior.priorSource??null))) return true;
			if (e?.kind==="rerun") return true;
			if (n.restoration && (!validRestoration(value,n) || !value.effects.some(w=>w.kind==="writer" && w.grain===id &&
				digest(w.restoration ?? null)===digest(n.restoration)))) return true;
			if (n.retained && (!n.retained.length || new Set(n.retained.map(c=>c.to)).size!==n.retained.length ||
				!understandsTransfers(value,value.productRepins?.at(-1)?.revision) || n.retained.some(c=>{
					const r=effects.get(c.review), i=r?.kind==="scout" && comparison(value,r), scope={primary:c.primary,files:c.files};
					return !i || !i.transfer || r?.state!=="observed" || i.transfer.from!==id || i.transfer.to!==c.to ||
						!sameScope(comparisonScope(i),scope) || !sameScope(nodes[c.to]?.grain.directory,scope) || nodes[c.to].review!==c.review ||
						!scopePaths(scope).every(p=>ownership(g.directory).directories.some(d=>p.startsWith(d+"/")));
				}))) return true;
			const review = n.review && effects.get(n.review);
			if (n.successor) {
				const c=n.successor,r=effects.get(c.review),i=r?.kind==="scout" && comparison(value,r),s=i && i.successor;
				const child=nodes[c.to], origin=review && review.kind==="scout" && review.squad;
				if (!s || !stoppedCheck(value,s) || n.retained || r?.state!=="observed" || r.kind!=="scout" || r.squad!==origin ||
					s.from!==id || s.to!==c.to || !narrower(g.directory,c.directory) || !sameScope(comparisonScope(i),c.directory) ||
					!child || child.review!==c.review || !sameScope(child.grain.directory,c.directory) || child.grain.check!==g.check ||
					child.grain.revision || child.grain.needs.includes(id) || child.successor || child.reuse) return true;
			}
			if (review && review.kind==="scout") {
				const s=comparison(value,review)?.successor;
				if (s && (s.to!==id || nodes[s.from]?.successor?.review!==review.id)) return true;
			}
			if (mixed(g.directory)) {
				const i=review && review.kind==="scout" ? comparison(value,review) : undefined;
				if (!i?.source || !sameScope(g.directory,comparisonScope(i))) return true;
				if (i.transfer && (i.transfer.to!==id || !nodes[i.transfer.from]?.retained?.some(c=>c.review===n.review && c.to===id))) return true;
			}
			const launch = n.reuse ? effects.get(n.reuse) : undefined;
			if (n.workspace) {
				const w = effects.get(n.workspace);
				if (w?.kind!=="writer" || !w.pooled || w.grain!==id || w.nativeId!==n.worker || w.pooled.generation!==n.generation ||
					w.state!=="done" && w.token!==n.token) return true;
				const src = effects.get(w.pooled.from);
				if (src?.kind!=="writer" || !src.finished || !p.squads.some(s=>s.id===src.finished?.squad &&
					("areas" in s ? owns(s,g.directory) : s.grains.includes(id)))) return true;
			}
			const reuse = launch?.kind === "writer" ? launch.reuse : undefined;
			if (n.reuse && (!reuse || launch?.grain !== id || launch.token !== n.token || launch.nativeId !== n.worker ||
				launch.args.base_branch !== n.generation || reuse.predecessor.review !== n.review || n.repairs !== reuse.predecessor.repairs ||
				digest(g) !== digest(reuse.predecessor.grain))) return true;
			if (review && review.kind === "scout" && review.correction && ((reuse?.predecessor.worker ?? n.worker) !== review.correction.worker ||
				g.task !== revisedTask(review,g.id,review.correction.clause))) return true;
			if (n.priorSource && (!n.base || Array.isArray(n.priorSource)!==Array.isArray(g.directory) ||
				members(n.priorSource).some(b=>!ownership(g.directory).directories.includes(b.directory) || b.revision !== (g.revision ?? n.base)))) return true;
			const w = grants.get(n.token);
			const observer=observers.get(n.token);
			if (observer && (observer.grain!==id || observer.nativeId!==n.worker || observer.args.base_branch!==n.generation ||
				(e && (e.kind!=="component" || !e.observer || e.issuer!==n.worker || digest(e.observer)!==digest(observer.observer))))) return true;
			if (w?.readGrant && (w.grain !== id || w.nativeId !== n.worker || !n.priorSource || digest(w.readGrant)!==digest(n.priorSource))) return true;
			if (id !== g.id || ![g.specification, g.check, ...g.boundary].every(f => files.has(f)) || !outside(g.directory, p.files)) return true;
			if (n.stop?.kind === "writer-cannot-repair" && (!n.candidate || inconclusiveRepair(n,e)?.commit !== n.candidate)) return true;
			if (n.stop?.kind === "writer-relinquished" && (n.candidate || !relinquishable(value,n))) return true;
			if ((frozenSubmission(n) || checked(n)) && (e?.kind !== "component" || e.grain !== id || e.commit !== n.candidate || e.check !== g.check)) return true;
			const i=n.check && inspections.get(n.check);
			const substitution=e?.kind==="component" && (memberApproval(e) || e.replacement);
			if(checked(n) && e?.kind==="component" && substitution){
				const a=changeOffer(value,e),o=a && changeOwners(a)[id],base=a?.rollout?.from??(a?.failed && effects.get(a.failed)?.commit);
				if(!a || !o || !base || n.worker || n.token || n.workspace || n.base!==base || n.generation!==base || n.replaces!==o.output ||
					"inputs" in o && digest(n.inputs??null)!==digest(o.inputs) || !value.productRepins?.some(p=>p.amendments?.some(s=>s.proposal===a.id)))return true;
			}
			if(n.state==="reviewing" && (!i || !currentInspection(value,i)) || value.inspections && checked(n) &&
				(!i || publicationVerdict(i)!=="approved" || e?.kind==="component" && !e.remedy && !e.delivery && !substitution && !reviewedGrant(value,n,e,i)))return true;
			if (checked(n) && checkReceipt(e)?.exit !== 0) return true;
			if (n.state === "qualified" && last?.outputs[id] !== n.candidate) return true;
			return areas.length ? n.state === "idle" || !g.task || !areas.some(s => owns(s, g.directory) && s.checks.includes(g.check) &&
				g.specification === s.charter && g.agent === s.agent && g.boundary.length === s.boundary.length && g.boundary.every((b, i) => b === s.boundary[i])) : g.task !== undefined || Array.isArray(g.directory);
		}))
		fail("corrupt_run", "Invalid Foundry task graph");
	validateNodes(nodes);
	for (const product of value.join ? [...products, value.join] : products) {
		const e = effects.get(product.check);
		if (e?.kind !== "product" || e.commit !== product.commit || e.check !== p.productCheck)
			fail("corrupt_run", "Product does not match its exact check reservation");
		const w=product.withdrawnHandoff;
		if(w){
			const g=effects.get(w.goal),c=effects.get(w.recheck),next=products[products.indexOf(product)+1]??value.join;
			const prior=c && value.effects.slice(0,value.effects.indexOf(c));
			if(product===value.join || product.qualifiedAt || !value.goal || !next || next.check!==w.recheck ||
				next.commit!==product.commit || next.target!==product.target || digest([next.outputs,next.ownership])!==digest([product.outputs,product.ownership]) ||
				!e.runnerClaim || g?.kind!=="goal" || g.commit!==product.commit || g.check!==p.goalCheck || !g.runnerClaim || checkReceipt(g)?.exit!==0 ||
				c?.kind!=="product" || c.issuer!==value.owner || c.evaluatorRevision!==e.evaluatorRevision ||
				g.productEvaluatorRevision!==e.evaluatorRevision || prior?.findLast(x=>x.kind==="goal")!==g || prior.findLast(x=>x.kind==="product")!==e ||
				!!w.qualifiedAt!==prior.some(x=>x.kind==="handoff" && x.token===product.check))
				fail("corrupt_run","A withdrawn handoff needs its exact earlier goal and a fresh verification of the same checkpoint and ownership");
		}
		if (product.ownership) {
			const transfer=understandsTransfers(value,e.evaluatorRevision);
			const restore=!transfer && !Object.values(product.ownership).some(s=>s.exclude) && value.effects.some(w=>w.kind==="writer" &&
				w.restoration && (product===value.join ? w.grain && nodes[w.grain]?.restoration && product.outputs[w.grain] : restoredProduct(value,w)===product));
			if (!transfer && !restore && value.independent?.product!==product.check || digest(Object.keys(product.ownership).sort())!==digest(Object.keys(product.outputs).sort()))
				fail("corrupt_run","Invalid product ownership snapshot");
		}
		if (product===value.join && value.independent?.product!==product.check && product.ownership && Object.keys(product.outputs).every(id=>nodes[id]) &&
			digest(product.ownership)!==digest(productOwnership(nodes,product.outputs) ?? null))
			fail("corrupt_run","Product reservation does not match its partition of the current outputs");
		if (product === value.join ? product.qualifiedAt !== undefined :
			checkReceipt(e)?.exit !== 0 || (!value.goal && !product.qualifiedAt || value.goal && product.qualifiedAt && last !== product))
			fail("corrupt_run", "Checkpoint requires an exact passing product receipt");
	}
	if (last?.qualifiedAt && value.goal && (value.active || last.commit !== value.goal.commit ||
		last.target !== value.goal.target || !checkpointReceipt(value,last.check,last.commit) || goalReceipt(value)?.exit !== 0))
		fail("corrupt_run", "Goal acceptance requires both exact runner receipts");
	if(storeView)indexRevision(value,effects,checkpoints,inspections);
	return value;
}
