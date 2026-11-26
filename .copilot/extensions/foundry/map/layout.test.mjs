import assert from "node:assert/strict";
import test from "node:test";
import { layout,wirePath } from "./layout.mjs";
import { example } from "./model.mjs";

test("an ordinary oblique work dependency eases out of the producer and lands on its original bearing",()=>{
	const a={x:4,y:12},b={x:110,y:76},d=wirePath([a,b],false);
	const c=d.match(/C([^LC]+)/)?.[1].trim().split(/\s+/).map(Number);
	assert.ok(c,"an unobstructed dependency must not be a rigid diagonal");
	const initial=(c[1]-a.y)/(c[0]-a.x),bearing=(b.y-a.y)/(b.x-a.x);
	assert.ok(initial>=0 && initial<bearing*.7,"the start tangent eases into the diagonal");
	const [px,py,x,y]=(d.match(/-?[\d.]+/g)??[]).slice(-4).map(Number);
	assert.ok(Math.abs((y-py)/(x-px)-bearing)<1e-6 && Math.hypot(x-px,y-py)>=16,"the visible shaft and arrowhead agree");
});

test("arrowheads follow the last routed span into the consumer, not the layout axis or the source center",()=>{
	for(const vertical of [true,false]){
		const point=(/** @type {number} */ along,/** @type {number} */ across)=>vertical?{x:across,y:along}:{x:along,y:across};
		for(const offset of [-30,0,30,-220,220]){
			// The skipped rank puts the last port on the opposite side of the target from the source.
			const tip=point(180,offset),points=[point(0,offset*2),point(52,0),point(136,0),tip];
			const numbers=wirePath(points,vertical).match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number)??[];
			const [px,py,x,y]=numbers.slice(-4);assert.deepEqual({x,y},tip);
			const forward=vertical?y-py:x-px,side=vertical?x-px:y-py;
			assert.ok(forward>0);assert.equal(Math.sign(side),Math.sign(offset),"tip must point along the incoming span");
			if(Math.abs(offset)<=44)assert.ok(Math.abs(side/forward-offset/44)<1e-6,"ordinary approaches keep their bearing");
			// Even on a grazing approach the back corners of the 9-by-8 marker stay outside the card.
			assert.ok(9*forward>4*Math.abs(side));
		}
	}
});

test("a fork and join keep the same real edges in both orientations, including a skipped rank", () => {
	for (const width of [340, 900]) {
		const g = layout(example.nodes, width), axis = g.vertical ? "y" : "x";
		const boxes = new Map(g.boxes.map(n => [n.id, n]));
		assert.equal(g.vertical, width < 660);
		assert.deepEqual(g.edges.map(e => `${e.from}/${e.to}`).sort(), example.nodes.flatMap(n => n.needs.map(id => `${id}/${n.id}`)).sort());
		for (const edge of g.edges) {
			assert.ok(Number(boxes.get(edge.from)?.[axis]) < Number(boxes.get(edge.to)?.[axis]));
			assert.ok(edge.points.length>=2 && edge.points.every(p=>Number.isFinite(p.x+p.y)));
			edge.points.slice(1).forEach((p,i)=>{
				const q=edge.points[i];
				for(const b of boxes.values())if(b.id!==edge.from && b.id!==edge.to)assert.ok(
					Math.max(p.x,q.x)<=b.x||Math.min(p.x,q.x)>=b.x+g.w||Math.max(p.y,q.y)<=b.y||Math.min(p.y,q.y)>=b.y+g.h,
					`${edge.from} → ${edge.to} would cross ${b.id}`);
			});
		}
		assert.equal(boxes.get("file-reader")?.[axis], boxes.get("csv-format")?.[axis]);
	}
	const partial = layout(example.nodes.filter(n => n.id === "export-results"), 340);
	assert.deepEqual(partial.edges, []); // No invented assignments from outside the viewer's scope.
});

test("crowded layers fit one navigable graph without hiding peers or losing a dependency", () => {
	const root = example.nodes[0], peers = Array.from({ length: 12 }, (_, i) => ({
		...root, id: `peer-${i}`, needs: [root.id],
	}));
	const join = { ...root, id: "join", needs: [root.id, ...peers.map(n => n.id)] };
	const nodes = [root, ...peers, join];
	for (const width of [240, 340, 650, 900]) {
		const g = layout(nodes, width);
		assert.deepEqual(g.boxes.map(b => b.id).sort(), nodes.map(n => n.id).sort());
		for (const [i, b] of g.boxes.entries()) {
			assert.ok(b.x >= 0 && b.x + g.w <= g.width && b.y >= 0 && b.y + g.h <= g.height);
			assert.ok(g.boxes.slice(i + 1).every(o => o.x >= b.x + g.w || b.x >= o.x + g.w ||
				o.y >= b.y + g.h || b.y >= o.y + g.h));
		}
		assert.deepEqual(g.edges.map(e => `${e.from}/${e.to}`).sort(), nodes.flatMap(n => n.needs.map(p => `${p}/${n.id}`)).sort());
	}
});

test("a short independent input sits beside its consumer instead of taking an unnecessary bypass around a rank",()=>{
	const node=(/** @type {string} */ id,/** @type {string[]} */ needs)=>({...example.nodes[0],id,needs});
	const nodes=[node("base",[]),node("parse",["base"]),node("short",[]),node("join",["short","parse"])];
	for(const width of [340,900]){
		const g=layout(nodes,width),axis=g.vertical?"y":"x",byId=Object.fromEntries(g.boxes.map(n=>[n.id,n]));
		assert.equal(byId.short[axis],byId.parse[axis]);
		assert.equal(g.edges.find(e=>e.from==="short")?.points.length,2);
	}
});

test("a narrow fork keeps its curved bypass clear of the intervening cards",()=>{
	const g=layout(example.nodes,340),box=new Map(g.boxes.map(n=>[n.id,n]));
	assert.ok(g.width<3*g.w,"do not add a third full-width card just to shorten an edge on a phone");
	const skip=g.edges.find(e=>e.points.length>2);assert.ok(skip);
	const p=skip.points,parts=[...wirePath(p,true).matchAll(/([MCL])([^MCL]+)/g)].map(m=>m[2].trim().split(/\s+/).map(Number));
	assert.ok(parts.some(s=>s.length===6),"a bypass is smooth, not a series of hard folds");
	for(let i=1;i<parts.length;i++){
		const coords=[...parts[i-1].slice(-2),...parts[i]],xs=coords.filter((_,k)=>k%2===0),ys=coords.filter((_,k)=>k%2===1);
		for(const b of box.values())if(b.id!==skip.from && b.id!==skip.to){
			assert.ok(Math.max(...xs)<=b.x || Math.min(...xs)>=b.x+g.w || Math.max(...ys)<=b.y || Math.min(...ys)>=b.y+g.h,
				"the entire curve, including its controls, must clear other cards");
		}
	}
});

test("disconnected assignments use both axes, without inventing links even in a participant view",()=>{
	const nodes=Array.from({length:90},(_,i)=>({...example.nodes[0],id:`item-${i}`,needs:i%2?["private-input"]:[]}));
	const g=layout(nodes,820);
	assert.equal(g.edges.length,0);assert.equal(g.boxes.length,nodes.length);
	assert.ok(new Set(g.boxes.map(n=>n.x)).size>1 && new Set(g.boxes.map(n=>n.y)).size>1);
	assert.deepEqual(layout(nodes.toReversed(),820),g);
	assert.throws(()=>layout([{...nodes[0],needs:[nodes[1].id]},{...nodes[1],needs:[nodes[0].id]}],820),/cycle/);
});
