import { readHistorical } from "./archive.mjs";
import { readCurrent } from "./seals.mjs";
export {claimOutcome,verifyPreparation} from "./seals.mjs";
import { fail } from "./values.mjs";
import { journal } from "./dispatch.mjs";

/** Apply an authentic result only to its own attempt. A refused original never becomes an approval.
 * @param {string} run @param {import("./model.js").Effect} e @param {string} signature @param {string} document
 * @param {(document:string)=>import("./model.js").Receipt} [parse] */
export function acceptOutcome(run,e,signature,document,parse=JSON.parse){
	if(e.tool!=="bash" || !e.runnerStarted || !e.callId || !e.runnerClaim ||
		!(["issued","uncertain","refused"].includes(e.state) || e.state==="done" && e.receipt))fail("wrong_outcome","Runner outcome does not match its exclusive reservation");
	const receipt=(e.attempt?.version===3?readCurrent:readHistorical)(run,e,signature,document,parse);
	if(!e.receipt){
		e.receipt=receipt;
		if(e.state!=="refused")journal(e,"confirm");
	}
}
