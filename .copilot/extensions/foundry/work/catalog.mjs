import { release, releasePreflight } from "./engine.mjs";
import { monitors, workflow } from "./rules/supervision.mjs";
import { quiescence } from "./rules/quiescence.mjs";
import { assignment } from "./rules/assignment.mjs";
import { activity } from "./rules/activity.mjs";
import { call, review } from "./rules/dispatch.mjs";
import { compose } from "./machine.mjs";
import { dialog } from "./rules/dialog.mjs";
import { renewal } from "./rules/renewal.mjs";
import { scheduling } from "./scheduling.mjs";
import { reconciliation } from "./rules/reconciliation.mjs";
import { inspection } from "./rules/inspection.mjs";
import { mending } from "./rules/mending.mjs";
import { drafting } from "./rules/drafts.mjs";
import { strategy } from "./strategy.mjs";

const entities=compose(assignment,review,call,activity,release,workflow,quiescence,dialog,renewal,scheduling,reconciliation,releasePreflight,inspection,mending,strategy,drafting);
export const definitions=()=>({...entities.describe(),...monitors.describe()});
/** Wire projection of the runtime definitions. Reducer code never crosses the canvas boundary. */
export function catalog() {
	return {machines:structuredClone(definitions()),groups:[Object.keys(monitors.describe())]};
}
