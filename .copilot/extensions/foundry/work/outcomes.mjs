import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { digest, fail } from "./values.mjs";
import { sameEvaluation } from "./evidence.mjs";
import { journal } from "./dispatch.mjs";

/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Receipt} Receipt */
/** @param {string} run @param {Effect} e @param {string} document */
function message(run, e, document) {
	return createHash("sha256").update(JSON.stringify([run, e.id, e.issuer, e.callId, e.kind, e.grain ?? null,
		e.commit, e.check, e.evaluatorRevision ?? null, ...(e.productEvaluatorRevision ? [e.productEvaluatorRevision] : []),
		...(e.kind==="component" && e.pair ? [digest(e.pair)] : []),
		...(e.kind==="rerun" && e.rerun ? [digest(e.rerun)] : []),
		...(e.tool==="bash" && e.delivery ? ["delivery",e.delivery] : []),
		...(e.tool==="bash" && e.isolation ? ["independent",e.isolation] : []),
		...(e.kind==="component" && e.observer ? ["observer",digest(e.observer)] : []),
		...(e.kind==="component" && e.remedy ? ["production",digest(e.remedy)] : [])])).update("\n").update(document).digest();
}

/** @param {Effect} e @param {Receipt} receipt */
function checkPin(e, receipt) {
	if (!receipt || receipt.commit !== e.commit || receipt.check !== e.check || !sameEvaluation(receipt,e))
		fail("wrong_outcome", "Runner outcome does not match its evaluator pin");
}

/** The private key stays in the claiming runner; the journal contains no authority to sign another outcome.
 * @param {string} run @param {Effect} e */
export function claimOutcome(run, e) {
	if (e.tool !== "bash" || !(e.kind === "component" || e.kind === "rerun" || e.kind === "product" || e.kind === "goal") ||
		!(e.state === "issued" || e.state === "uncertain") || !e.callId || !e.commit || !e.check || e.runnerStarted || e.receipt)
		fail("unissued_check", "Expected an unclaimed evaluator reservation");
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	e.runnerStarted = true;
	e.runnerClaim = publicKey.export({ format: "jwk" }).x ?? fail("invalid_key", "Expected an Ed25519 runner key");
	/** @param {Receipt} receipt */
	return receipt => {
		checkPin(e, receipt);
		const document = JSON.stringify(receipt);
		return { document, signature: sign(null, message(run, e, document), privateKey).toString("base64") };
	};
}

/** Apply only to the issuing reservation, including when its evaluator has since been superseded.
 * The current decoder validates the resulting snapshot before exposing it.
 * @param {string} run @param {Effect} e @param {string} signature @param {string} document */
export function acceptOutcome(run, e, signature, document) {
	if (e.tool !== "bash" || !e.runnerStarted || !e.callId || !e.runnerClaim ||
		!(e.state === "issued" || e.state === "uncertain" || e.state === "refused" || e.state === "done" && e.receipt) ||
		!verify(null, message(run, e, document), createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: e.runnerClaim } }), Buffer.from(signature, "base64")))
		fail("wrong_outcome", "Runner outcome does not match its exclusive reservation");
	const receipt = JSON.parse(document);
	checkPin(e, receipt);
	if (e.receipt) {
		if (JSON.stringify(e.receipt) !== document) fail("conflicting_outcome", "Reservation already has a different receipt");
		return;
	}
	e.receipt = receipt;
	if (e.state !== "refused") journal(e,"confirm");
}
