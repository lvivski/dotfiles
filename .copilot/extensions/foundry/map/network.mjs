/** @typedef {import("./model.mjs").Assignment} Assignment */
/** @type {Record<string,[label:string,glyph:string,tone:string]>} */
export const states={
	blocked:["Blocked","stop","stop"],unconfirmed:["Launch unconfirmed","clock","stop"],
	assigned:["Assigned","write","work"],starting:["Awaiting binding","clock","work"],checking:["Checking","inspect","work"],
	reviewing:["In code review","inspect","work"],
	waiting:["Waiting for input","clock","wait"],queued:["Queued","clock","wait"],idle:["Idle","clock","wait"],
	passed:["Passed on build · not integrated","inspect","work"],published:["Component checked","tick","done"],
	qualified:["Integrated","tick","done"],repeated:["Repeated output","tick","done"],
};
/** @type {Record<string,[glyph:string,tone:string]>} */
export const phases={
	Active:["play","work"],Paused:["pause","hold"],Inactive:["pause","wait"],Qualified:["tick","done"],"Deadline elapsed":["clock","stop"],
};

/** @param {Assignment} n */
export const purpose=n=>n.task || (n.specification?`The required behavior is defined in ${n.specification}.`:"No purpose is recorded for this assignment.");

/** Index only this viewer's projection. Unknown producers may be named in an assignment's
 * requirements, but are not nodes or edges, and cannot be assumed to have passed.
 * @param {Assignment[]} items */
export function network(items) {
	const nodes=new Map(items.map(n=>[n.id,n]));
	if(nodes.size!==items.length)throw Error("Duplicate assignment in work graph");
	const children=new Map(items.map(n=>[n.id,/** @type {string[]} */([])]));
	for(const n of items)for(const id of n.needs)children.get(id)?.push(n.id);
	/** @param {Assignment} n */
	const missing=n=>n.needs.filter(id=>!nodes.get(id)?.checked);
	/** @param {Assignment} n */
	const state=n=>n.passedOnBuild ? "passed" : n.state==="waiting" && !missing(n).length ? "queued" : n.state;
	/** @param {string} start @param {(n:Assignment)=>readonly string[]} next */
	function walk(start,next) {
		const seen=new Set([start]);
		for(const id of seen){const n=nodes.get(id);if(n)for(const p of next(n))if(nodes.has(p))seen.add(p);}
		seen.delete(start);return seen;
	}
	return {nodes,children,missing,state,
		summary(){
			/** @type {Map<string,number>} */ const counts=new Map();
			for(const n of nodes.values()){const key=state(n);counts.set(key,(counts.get(key)??0)+1);}
			return Object.entries(states).flatMap(([key,[label,glyph,tone]])=>counts.has(key)?
				[{key,text:`${counts.get(key)} ${label.toLowerCase()}`,glyph,tone}]:[]);
		},
		/** @param {string} id */
		trace(id) {
			const up=walk(id,n=>n.needs),down=walk(id,n=>children.get(n.id)??[]);
			return {up,down,ids:new Set([id,...up,...down])};
		},
		/** Search never changes an assignment's input availability. @param {string} text @param {string} filter */
		find(text,filter) {
			const words=text.trim().toLowerCase().split(/\s+/).filter(Boolean);
			return items.filter(n=>(!filter||state(n)===filter) && words.every(word=>
				`${n.id} ${n.directory} ${n.task} ${n.specification??""}`.toLowerCase().includes(word)));
		},
	};
}
