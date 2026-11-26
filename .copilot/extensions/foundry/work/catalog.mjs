import { release, releasePreflight } from "./engine.mjs";
import { monitors, workflow } from "./supervision.mjs";
import { quiescence } from "./quiescence.mjs";
import { assignment } from "./assignment.mjs";
import { activity } from "./activity.mjs";
import { call, review } from "./dispatch.mjs";
import { compose } from "./machine.mjs";
import { dialog } from "./dialog.mjs";
import { renewal } from "./renewal.mjs";
import { scheduling } from "./scheduling.mjs";
import { reconciliation } from "./reconciliation.mjs";
import { inspection } from "./inspection.mjs";

const entities=compose(assignment,review,call,activity,release,workflow,quiescence,dialog,renewal,scheduling,reconciliation,releasePreflight,inspection);
export const definitions=()=>({...entities.describe(),...monitors.describe()});
/** Wire projection of the runtime definitions. Reducer code never crosses the canvas boundary. */
export function catalog() {
	return {machines:structuredClone(definitions()),groups:[Object.keys(monitors.describe())]};
}
