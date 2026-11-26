/** A pending, unbound, unavailable or permission-held review is neither approval nor a confirmed code defect.
 * @param {import("./model.js").Inspection|undefined} i */
export const publicationVerdict=i=>i?.dispatch && i.workflow && i.summary && !i.permissionHold && (i.state==="approved" || i.state==="changes") ? i.state : undefined;

/** A new component observation cannot inherit approval from another check of this grain or tree.
 * The caller separately verifies the evaluator receipt and its ownership.
 * @param {import("./model.js").Run} run @param {string|undefined} component @param {string} grain @param {string|undefined} candidate */
export function approvedPublication(run,component,grain,candidate) {
	return run.inspections===undefined || run.inspections.some(i=>publicationVerdict(i)==="approved" && i.component===component &&
		i.grain===grain && i.candidate===candidate);
}
