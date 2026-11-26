import { release } from "./engine.mjs";
import { monitors, workflow } from "./supervision.mjs";
import { quiescence } from "./quiescence.mjs";
import { assignment } from "./assignment.mjs";
import { activity } from "./activity.mjs";
import { call, review } from "./dispatch.mjs";
import { compose } from "./chart.mjs";
import { dialog } from "./dialog.mjs";
import { renewal } from "./renewal.mjs";

const entities=compose(assignment,review,call,activity,release,workflow,quiescence,dialog,renewal);
export function catalog() {
	const parallel=monitors.describe();
	return {machines:{...entities.describe(),...parallel},groups:[Object.keys(parallel)]};
}
