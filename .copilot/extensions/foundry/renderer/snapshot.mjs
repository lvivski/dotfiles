/** @typedef {ReturnType<typeof import("./contracts.mjs").FoundryWire.snapshot>} PlanSnapshot */
/** @typedef {{plan: PlanSnapshot["plan"], projection: PlanSnapshot["projection"],
 * factory: PlanSnapshot["factory"] | null, workflows: PlanSnapshot["workflows"] | null,
 * native: boolean, readOnly: boolean}} BoardState */

/** Durable lifecycle wins first; live observations may advance at an equal revision.
 * @param {{revision: number, observedAt?: number}} left @param {{revision: number, observedAt?: number}} right */
export function newerObservation(left, right) {
	return left.revision > right.revision
		|| (left.revision === right.revision && (left.observedAt ?? 0) > (right.observedAt ?? 0));
}

/** @param {BoardState | null} current @param {PlanSnapshot} snapshot @param {string} planId */
export function mergeSnapshot(current, snapshot, planId) {
	if ((snapshot.plan?.id ?? snapshot.bindingId) !== planId
		|| (current?.plan && snapshot.plan && snapshot.plan.revision < current.plan.revision)) return null;
	const planChanged = !current?.plan || current.plan.revision !== snapshot.plan?.revision
		|| JSON.stringify(current.projection) !== JSON.stringify(snapshot.projection);
	let workflows = current?.workflows ?? null;
	if (snapshot.workflows) {
		const previous = new Map(current?.workflows?.state === "available"
			? current.workflows.runs.map((run) => [run.runId, run]) : []);
		workflows = snapshot.workflows.state === "available" ? {
			...snapshot.workflows,
			runs: snapshot.workflows.runs.map((run) => {
				const newer = previous.get(run.runId);
				return newer && newerObservation(newer, run) ? {
					...newer,
					actions: run.workflowName === "verify"
						&& (snapshot.plan?.status !== "running" || run.actions.length === 0)
						? [] : newer.actions,
				} : run;
			}),
		} : snapshot.workflows;
	}
	let factory = current?.factory ?? null;
	const incoming = snapshot.factory ?? null;
	if (!factory || !incoming || incoming.state !== "available" || factory.state !== "available"
		|| (incoming.revision >= factory.revision && (incoming.revision !== factory.revision
			|| (incoming.observedAt !== undefined && factory.observedAt !== undefined && incoming.observedAt >= factory.observedAt)))) {
		factory = incoming;
	}
	return {
		planChanged,
		state: {
			plan: snapshot.plan, projection: snapshot.projection, factory, workflows,
			native: snapshot.interactions?.native === true, readOnly: snapshot.interactions?.readOnly === true
		},
	};
}
