import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { closedAttempt } from "./requirements.mjs";
import { digest, fail } from "./values.mjs";
import { sameEvaluation } from "./receipt.mjs";
import { observedSteps } from "./observations.mjs";

/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Receipt} Receipt */
/** @param {string} x */
export const publicClaim=x=>createPublicKey({format:"jwk",key:{kty:"OKP",crv:"Ed25519",x}});
/** Not an outcome message: a build seal attests only bytes for these preparation inputs.
 * @param {string} inputs @param {string} tree */
const preparation=(inputs,tree)=>Buffer.from(`Foundry prepared build v1\n${inputs}\n${tree}`);
/** @param {string} claim @param {string} inputs @param {string} tree @param {string} signature */
export const verifyPreparation=(claim,inputs,tree,signature)=>verify(null,preparation(inputs,tree),publicClaim(claim),Buffer.from(signature,"base64url"));
/** @param {string} run @param {import("./model.js").NativeCall} e @param {string} document */
const currentMessage=(run,e,document)=>createHash("sha256").update("Foundry evaluator outcome v3\0")
	.update(JSON.stringify([run,e.id,e.issuer,e.callId,digest(e.args),digest(e.attempt),digest(e.verification)])).update("\n").update(document).digest();

/** Only the store may expose this after checking the current grant and exact on-disk recipe.
 * @param {string} run @param {import("./model.js").NativeCall} e */
export function claimOutcome(run,e) {
	if(!closedAttempt(e) || !e.callId || e.runnerStarted || e.runnerClaim || e.receipt || !["issued","uncertain"].includes(e.state))
		fail("unissued_check","Cannot sign an unissued, claimed or historical check");
	const {publicKey,privateKey}=generateKeyPairSync("ed25519");
	e.runnerStarted=true;e.runnerClaim=publicKey.export({format:"jwk"}).x??fail("invalid_key","Missing runner public key");
	const saved=structuredClone(e);
	return Object.assign((/** @type {Receipt} */ receipt)=>{
		checkCurrentPin(saved,receipt);const document=JSON.stringify(receipt);
		return {document,signature:sign(null,currentMessage(run,saved,document),privateKey).toString("base64")};
	},{signPreparation:(/** @type {string} */ inputs,/** @type {string} */ tree)=>{
		if(saved.attempt?.version!==3 || !saved.attempt.facts.some(f=>f.kind==="build-group") || !saved.verification?.steps.at(-1)?.build?.hook)
			fail("invalid_inputs","This declaration has no scoped preparation grant");
		return sign(null,preparation(inputs,tree),privateKey).toString("base64url");
	}});
}

/** @param {string} run @param {import("./model.js").NativeCall} e @param {string} signature @param {string} document */
export const signedCurrent=(run,e,signature,document)=>!!e.runnerClaim && closedAttempt(e) && verify(null,currentMessage(run,e,document),publicClaim(e.runnerClaim),Buffer.from(signature,"base64"));

/** @param {string} run @param {import("./model.js").NativeCall} e @param {string} signature @param {string} document @param {(s:string)=>Receipt} [parse] */
export function readCurrent(run,e,signature,document,parse=JSON.parse){
	if(!signedCurrent(run,e,signature,document))fail("wrong_outcome","Runner outcome does not match its exclusive reservation");
	if(e.receipt && JSON.stringify(e.receipt)!==document)fail("conflicting_outcome","Reservation already has a different receipt");
	const receipt=e.receipt??parse(document);
	checkCurrentPin(e,receipt);return receipt;
}

/** @param {import("./model.js").NativeCall} e @param {Receipt} r */
export function checkCurrentPin(e,r){
	if(!r || r.commit!==e.commit || r.check!==e.check || !sameEvaluation(r,e) || typeof r.output!=="string" ||
		r.exit!==null && (!Number.isSafeInteger(r.exit) || r.exit<0 || !r.inputs) || !e.verification ||
		r.test!==undefined || r.overlay!==undefined || (!!r.control && !r.inputs?.control) || !observedSteps(e.verification,r))
		fail("wrong_outcome","Runner observation differs from the original reserved recipe and use");
}
