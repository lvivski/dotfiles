import { takeEffects } from "./machine.mjs";

/** Bind once; execute only effects queued by an accepted transition of this definition.
 * A host may install its snapshot or commit its guarded reservation before calling this.
 * @template C,R @param {import("./machine.mjs").Machine} model @param {Record<string,(context:C)=>R>} handlers */
export function executor(model,handlers) {
	/** @type {Map<string,(context:C)=>R>} */ const bound=new Map();
	for (const edges of Object.values(model.states)) for (const {action} of edges) if (action) {
		if (!Object.hasOwn(handlers,action) || typeof handlers[action]!=="function") throw Error(`Unbound action: ${model.id}.${action}`);
		bound.set(action,handlers[action]);
	}
	/** @param {{effects:readonly import("./machine.mjs").Effect[]}} result @param {C} bindings */
	return (result,bindings)=>takeEffects(model,result).map(({type})=>{
		const perform=bound.get(type);
		if(!perform)throw Error(`Unbound action: ${model.id}.${type}`);
		return perform(bindings);
	});
}
