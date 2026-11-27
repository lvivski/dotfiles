import { createHash, verify } from "node:crypto";
import { publicClaim } from "./seals.mjs";
import { digest, fail } from "./values.mjs";
import { boundInputs } from "./inputs.mjs";
import { sameEvaluation } from "./receipt.mjs";
import { attemptSubject } from "./abi.mjs";

/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Receipt} Receipt */
/** @param {string} run @param {Effect} e @param {string} document */
function legacyMessage(run, e, document) {
	return createHash("sha256").update(JSON.stringify([run, e.id, e.issuer, e.callId, e.kind, e.grain ?? null,
		e.commit, e.check, e.evaluatorRevision ?? null, ...(e.productEvaluatorRevision ? [e.productEvaluatorRevision] : []),
		...(e.kind==="component" && e.pair ? [digest(e.pair)] : []),
		...(e.kind==="rerun" && e.rerun ? [digest(e.rerun)] : []),
		...(e.tool==="bash" && e.delivery ? ["delivery",e.delivery] : []),
		...(e.tool==="bash" && e.isolation ? ["independent",e.isolation] : []),
		...(e.kind==="component" && e.observer ? ["observer",digest(e.observer)] : []),
		...(e.kind==="component" && e.remedy ? ["production",digest(e.remedy)] : []),
		...(e.kind==="control" ? ["calibration",digest(e.calibration)] : []),
		...(e.tool==="bash" && e.testPin ? ["test-repair",e.testPin] : []),
		...(e.kind==="component" && e.rollout ? ["rollout",e.rollout] : []),
		...(e.tool==="bash" && e.lane ? ["foreground",e.lane] : []),
		...(e.kind==="component" && e.replacement ? ["replacement",e.replacement] : [])])).update("\n").update(document).digest();
}

/** Native delivery/settlement and subsequently delivered repairs are not check
 * inputs. All reservation data (including its authority and launch description)
 * belongs to this attempt; a new field is bound by default.
 * @param {import("./model.js").NativeCall} e */
const reservation=e=>[e.id,e.issuer,e.callId??null,e.attempt?.version===2?e.attempt.previous??null:null,digest(e.args),attemptSubject(e),digest(e.verification??null)];
/** @param {string} run @param {import("./model.js").NativeCall} e @param {string} document */
const message=(run,e,document)=>createHash("sha256").update("Foundry evaluator outcome v2\0")
	.update(JSON.stringify([run,...reservation(e)])).update("\n").update(document).digest();
/** @param {Effect} e @param {Receipt} receipt */
function checkPin(e, receipt) {
	if (!receipt || receipt.commit !== e.commit || receipt.check !== e.check || !sameEvaluation(receipt,e))
		fail("wrong_outcome", "Runner outcome does not match its evaluator pin");
	if(e.tool==="bash" && e.attempt?.version===2 && (receipt.exit!==null && !receipt.inputs || Object.values(receipt.components??{}).some(c=>c.exit!==null && !c.inputs)))
		fail("unproven_inputs","A new runner cannot attest a verdict without the inputs it observed");
	if(!boundInputs(e,receipt))fail("wrong_outcome","Runner observation differs from the original reserved input description");
}

/** Read-only verification; no state transition, signer or permission to execute.
 * @param {string} run @param {import("./model.js").NativeCall} e @param {string} signature @param {string} document @param {(document:string)=>Receipt} [parse] */
export function readHistorical(run,e,signature,document,parse=JSON.parse){
	const bind=e.attempt?.version===1?legacyMessage:e.attempt?.version===2?message:undefined;
	if(!bind || !e.runnerStarted || !e.callId || !e.runnerClaim ||
		!verify(null,bind(run,e,document),publicClaim(e.runnerClaim),Buffer.from(signature,"base64")))
		fail("wrong_outcome", "Runner outcome does not match its exclusive reservation");
	if(e.receipt && JSON.stringify(e.receipt)!==document)fail("conflicting_outcome","Reservation already has a different receipt");
	const receipt=e.receipt??parse(document);
	checkPin(e,receipt);
	return receipt;
}
