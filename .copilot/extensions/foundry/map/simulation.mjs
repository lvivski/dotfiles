import { compose } from "../work/chart.mjs";

/** @typedef {import("./statechart.mjs").Model} Model */
/** @typedef {Record<string,Record<string,boolean>>} Inputs */
/** @param {Model[]} models */
export function simulate(models) {
	const system=compose(...models), initial=system.actor().snapshot();
	/** @type {Inputs} */ const defaults={};
	for(const m of models) defaults[m.id]=Object.fromEntries(Object.values(m.states).flat().flatMap(e=>(e.when??[]).map(f=>[f.replace(/^!/,""),false])));
	const start={label:"Initial state",states:initial,inputs:defaults,changes:/** @type {ReturnType<typeof system.plan>} */([])};
	const history=[start];let index=0, inputs=defaults;
	const current=()=>history[index];
	/** @param {string} label @param {Record<string,string>} states @param {ReturnType<typeof system.plan>} changes */
	function append(label,states,changes) {
		history.splice(index+1,history.length,{label,states,inputs,changes});index++;
	}
	return {history,current,index:()=>index,inputs:()=>inputs,
		/** @param {string} on */ preview:on=>system.plan(current().states,on,inputs),
		/** @param {string} on */ send(on){
			const actor=system.actor(current().states), changes=actor.send(on,inputs);
			append(on,actor.snapshot(),changes);
		},
		/** @param {string} region @param {string} fact @param {boolean} value */
		setFact(region,fact,value){inputs={...inputs,[region]:{...inputs[region],[fact]:value}};},
		/** Inspecting a state never moves the simulator. Seeding a projected state is an explicit local event.
		 * @param {string} region @param {string} state */
		seed(region,state){
			const actor=system.actor({...current().states,[region]:state});
			append(`Set ${region} to ${state}`,actor.snapshot(),[]);
		},
		/** @param {number} i */
		seek(i){if(!Number.isInteger(i)||i<0||i>=history.length)throw Error("Unknown simulation step");index=i;inputs=current().inputs;},
		reset(){history.splice(1);index=0;inputs=defaults;}
	};
}
