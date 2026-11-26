import assert from "node:assert/strict";
import test from "node:test";
import {arrange} from "./layers.mjs";

test("rank ordering accounts for crossings on both sides of a shared middle layer",()=>{
	const layers=["a","b","c"].map(s=>[0,1,2].map(n=>({id:s+n,size:20})));
	const links="a0:b1 a1:b0 a1:b1 a1:b2 a2:b2 b0:c0 b0:c2 b1:c1 b1:c2 b2:c1".split(" ").map(pair=>{
		const [from,to]=pair.split(":");return {from,to};
	});
	const {position}=arrange(layers,links,10,true);
	const crossings=links.reduce((n,a,i)=>n+links.slice(0,i).filter(b=>a.from[0]===b.from[0] &&
		(position(a.from)-position(b.from))*(position(a.to)-position(b.to))<0).length,0);
	assert.ok(crossings<=1,`a better order is available: ${crossings} crossings`);
});
