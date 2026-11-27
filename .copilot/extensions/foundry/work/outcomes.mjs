import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { digest, fail } from "./values.mjs";
import { sameEvaluation } from "./receipt.mjs";
import { journal } from "./dispatch.mjs";
import { boundInputs, described } from "./inputs.mjs";
import { attemptSubject } from "./abi.mjs";

/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Receipt} Receipt */
/** @param {string} x */
const publicClaim=x=>createPublicKey({format:"jwk",key:{kty:"OKP",crv:"Ed25519",x}});
/** Not an outcome message: a build seal attests only bytes for these preparation inputs.
 * @param {string} inputs @param {string} tree */
const preparation=(inputs,tree)=>Buffer.from(`Foundry prepared build v1\n${inputs}\n${tree}`);
/** @param {string} claim @param {string} inputs @param {string} tree @param {string} signature */
export const verifyPreparation=(claim,inputs,tree,signature)=>verify(null,preparation(inputs,tree),publicClaim(claim),Buffer.from(signature,"base64url"));
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

/** The private key stays in the claiming runner; the journal contains no authority to sign another outcome.
 * @param {string} run @param {Effect} e */
export function claimOutcome(run, e) {
	if (e.tool !== "bash" || e.attempt?.version!==2 || !described(e) || e.lane ||
		!(e.state === "issued" || e.state === "uncertain") || !e.callId || !e.commit || !e.check || e.runnerStarted || e.receipt)
		fail("unissued_check", "Expected an unclaimed evaluator reservation");
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	e.runnerStarted = true;
	e.runnerClaim = publicKey.export({ format: "jwk" }).x ?? fail("invalid_key", "Expected an Ed25519 runner key");
	const claimed=structuredClone(e);
	/** @param {Receipt} receipt */
	const seal=receipt => {
		checkPin(claimed, receipt);
		const document = JSON.stringify(receipt);
		return { document, signature: sign(null, message(run, claimed, document), privateKey).toString("base64") };
	};
	return Object.assign(seal,{signPreparation:(/** @type {string} */ inputs,/** @type {string} */ tree)=>
		sign(null,preparation(inputs,tree),privateKey).toString("base64url")});
}

/** Apply only to the issuing reservation, including when its evaluator has since been superseded.
 * The current decoder validates the resulting snapshot before exposing it.
 * @param {string} run @param {Effect} e @param {string} signature @param {string} document @param {(document:string)=>Receipt} [parse] */
export function acceptOutcome(run, e, signature, document, parse=JSON.parse) {
	if (e.tool !== "bash" || !e.attempt || !e.runnerStarted || !e.callId || !e.runnerClaim ||
		!(e.state === "issued" || e.state === "uncertain" || e.state === "refused" || e.state === "done" && e.receipt) ||
		!verify(null, (e.attempt.version===1?legacyMessage:message)(run,e,document),publicClaim(e.runnerClaim),Buffer.from(signature,"base64")))
		fail("wrong_outcome", "Runner outcome does not match its exclusive reservation");
	if (e.receipt) {
		if (JSON.stringify(e.receipt) !== document) fail("conflicting_outcome", "Reservation already has a different receipt");
		checkPin(e,e.receipt);
		return;
	}
	const receipt=parse(document);
	checkPin(e,receipt);
	e.receipt = receipt;
	if (e.state !== "refused") journal(e,"confirm");
}
