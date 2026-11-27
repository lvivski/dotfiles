import { fail } from "./values.mjs";

/** A view of the current proposal, not a second store of work. Traversal and cycle validation
 * are iterative and read only the requested subgraph; candidate versions are a separate concern.
 * @param {(id:string)=>readonly string[]|undefined} links */
export function topology(links) {
	/** @param {string} id */
	const needs=id=>links(id) ?? fail("unknown_grain",`Unknown required output: ${id}`,{kind:"missing-output",subject:id});
	/** @param {Iterable<string>} seeds */
	function validate(seeds) {
		const complete=new Set(), active=new Set();
		for (const id of seeds) {
			if (complete.has(id)) continue;
			const stack=[{id,edges:needs(id),i:0}];active.add(id);
			while (stack.length) {
				const top=stack[stack.length-1];
				if (top.i===top.edges.length) {
					stack.pop();active.delete(top.id);complete.add(top.id);continue;
				}
				const dep=top.edges[top.i++];
				if (complete.has(dep)) continue;
				if (active.has(dep)) fail("dependency_cycle",`Output cycle at ${dep}`);
				active.add(dep);stack.push({id:dep,edges:needs(dep),i:0});
			}
		}
	}
	return {validate,
		/** @param {Iterable<string>} seeds */
		upstream(seeds) {
			const found=new Set(seeds);
			for (const id of found) for (const dep of needs(id)) found.add(dep);
			return found;
		},
		/** The previous graph is valid. Only a new edge can create a cycle; removing a producer
		 * also requires checking that no surviving direct edge dangles.
		 * @param {Iterable<string>} changed @param {Iterable<string>} deleted @param {()=>Iterable<string>} survivors */
		validateEdit(changed,deleted,survivors) {
			const lost=new Set([...deleted].filter(id=>links(id)===undefined));
			if (lost.size) for (const id of survivors()) for (const dep of needs(id))
				if (lost.has(dep)) fail("unknown_grain",`Unknown required output: ${dep} (required by ${id})`);
			validate(changed);
		}};
}
