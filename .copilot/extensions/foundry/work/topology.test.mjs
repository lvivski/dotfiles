import assert from "node:assert/strict";
import test from "node:test";
import { topology } from "./topology.mjs";
import { queuedWriters,waiting,writerInputs } from "./plan.mjs";
import { obstruction } from "../test/walk.mjs";

test("graph edits stay local to new edges, but deletion must account for surviving consumers",()=>{
	const nodes=new Map([["a",[]],["peer",[]],["b",["a"]],["c",["a","b"]]]), visited=new Set();
	const graph=topology(id=>{visited.add(id);return nodes.get(id);});
	graph.validate(nodes.keys());visited.clear();
	nodes.set("d",["c"]);
	graph.validateEdit(["d"],[],()=>assert.fail("no surviving-edge scan for an insertion"));
	assert.deepEqual(visited,new Set(["d","c","a","b"]));assert.deepEqual([...graph.upstream(["d"])],["d","c","a","b"]);
	nodes.set("a",["d"]);assert.throws(()=>graph.validateEdit(["a"],[],()=>nodes.keys()),{code:"dependency_cycle"});
	nodes.delete("a");assert.throws(()=>graph.validateEdit([],["a"],()=>nodes.keys()),{code:"unknown_grain"});
});

test("incremental acceptance equals full validation for every single rewire in a four-node DAG",()=>{
	const ids=["a","b","c","d"];
	for(let seed=0;seed<64;seed++) {
		let bit=0;
		const start=new Map(ids.map((id,i)=>[id,ids.slice(0,i).filter(()=>seed & 1<<bit++)]));
		for (const id of ids) for(let mask=0;mask<16;mask++) {
			const candidate=new Map(start).set(id,ids.filter((_,i)=>mask & 1<<i));
			const g=topology(key=>candidate.get(key));
			/** @param {()=>void} f */
			const verdict=f=>{try{f();return "ok";}catch(e){if(e instanceof Error && "code" in e)return e.code;throw e;}};
			assert.equal(verdict(()=>g.validateEdit([id],[],()=>ids)),verdict(()=>g.validate(ids)));
		}
	}
});

test("all four-job DAGs: late edge admission agrees with closure and every staffing order drains exactly once",()=>{
	const ids=["a","b","c","d"], pairs=ids.flatMap((_,i)=>ids.flatMap((_,j)=>i===j?[]:[[i,j]]));
	let dags=0;
	for(let graph=0;graph<2**pairs.length;graph++){
		const direct=ids.map(()=>0);
		pairs.forEach(([i,j],k)=>{if(graph & 1<<k)direct[i]|=1<<j;});
		// Independent Warshall oracle. Production traverses adjacency lists using DFS.
		const reach=[...direct];
		for(let k=0;k<4;k++)for(let i=0;i<4;i++)if(reach[i] & 1<<k)reach[i]|=reach[k];
		if(reach.some((mask,i)=>mask & 1<<i))continue;
		dags++;
		/** @param {number} mask */
		const members=mask=>ids.filter((_,i)=>mask & 1<<i);
		const links=Object.fromEntries(ids.map((id,i)=>[id,members(direct[i])]));
		for(const [i,held] of ids.entries()){
			const nodes=Object.fromEntries(ids.map(id=>[id,waiting({id,directory:id,needs:links[id],specification:"spec",boundary:[],check:"unit"})]));
			for(const state of /** @type {const} */ (["blocked","idle"])){
				nodes[held].state=state;
				assert.equal(queuedWriters(nodes),ids.filter((id,j)=>id!==held && !(reach[j] & 1<<i)).length);
			}
		}
		for(const [i,j] of pairs)if(!(direct[i] & 1<<j)){
			const changed={...links,[ids[i]]:[...links[ids[i]],ids[j]]}, view=topology(id=>changed[id]);
			const edit=()=>view.validateEdit([ids[i]],[],()=>ids);
			if(reach[j] & 1<<i){assert.throws(edit,{code:"dependency_cycle"});continue;}
			edit();
			for(const [k,id] of ids.entries()){
				const upstream=reach[k] | (k===i || reach[k] & 1<<i ? (1<<j)|reach[j] : 0);
				assert.deepEqual([...view.upstream(changed[id])].sort(),members(upstream));
			}
		}
		/** @param {number} checked */
		const successors=checked=>{
			const nodes=Object.fromEntries(ids.map((id,i)=>{
				const n=waiting({id,directory:id,needs:links[id],specification:"spec",boundary:[],check:"unit"});
				if(checked & 1<<i){n.state="qualified";n.candidate=`pin-${id}`;}
				return [id,n];
			}));
			return ids.flatMap((id,i)=>{
				const pins=writerInputs(nodes,nodes[id]), ready=!(checked & 1<<i) && !(reach[i] & ~checked);
				assert.deepEqual(pins,ready?Object.fromEntries(members(reach[i]).map(dep=>[dep,`pin-${dep}`])):undefined);
				return pins?[checked | 1<<i]:[];
			});
		};
		assert.equal(obstruction(0,successors,mask=>mask===15),undefined,`stuck or repeated job in ${JSON.stringify(links)}`);
	}
	assert.equal(dags,543);
});
