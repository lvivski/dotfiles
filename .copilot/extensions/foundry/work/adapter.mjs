/** Bind named actions at composition time, separately from pure selection. Never infer an
 * implementation for a new action or allow arbitrary method names through a dispatch.
 * @template C,R @param {import("./chart.mjs").Machine} model @param {Record<string,(context:C)=>R>} handlers */
export function implement(model,handlers) {
	/** @type {Map<string,(context:C)=>R>} */ const bound=new Map();
	for (const edges of Object.values(model.states)) for (const {action} of edges) if (action) {
		if (!Object.hasOwn(handlers,action) || typeof handlers[action]!=="function") throw Error(`Unbound action: ${model.id}.${action}`);
		bound.set(action,handlers[action]);
	}
	/** @param {string} action @param {C} context */
	return (action,context)=>{
		const run=bound.get(action);
		if (!run) throw Error(`Unknown action: ${model.id}.${action}`);
		return run(context);
	};
}
