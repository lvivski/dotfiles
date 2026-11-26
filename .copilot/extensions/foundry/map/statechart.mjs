import {transitions} from "./routes.mjs";

/** @typedef {import("../work/chart.mjs").Edge & {reason?:string,admission?:string}} Rule */
/** @typedef {import("../work/chart.mjs").Machine<Record<string,readonly Rule[]>>} Model */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{source:string,signal:string,target?:string,rules:number[]}} Transition */
/** @param {Model} model */
function bundles(model) {
	/** @type {Map<string,Transition>} */ const groups=new Map();
	for (const [source,rules] of Object.entries(model.states)) rules.forEach((r,index)=>{
		const key=JSON.stringify([source,r.on,r.target]), link=groups.get(key);
		if (link) link.rules.push(index);
		else groups.set(key,{source,signal:r.on,target:r.target,rules:[index]});
	});
	return [...groups.values()];
}

/** Depth-first finishing order breaks cycles for placement only. The forward
 * lifecycle stays together; an edge returning up the ranks keeps its direction.
 * @param {string[]} ids @param {string} initial @param {{source:string,target:string}[]} wires */
function levels(ids,initial,wires){
	const children=new Map(ids.map(id=>[id,new Set(wires.filter(w=>w.source===id&&w.target!==id).map(w=>w.target))]));
	const neighbors=new Map(ids.map(id=>[id,new Set(children.get(id))]));
	for(const {source,target} of wires)if(source!==target)neighbors.get(target)?.add(source);
	const seen=new Set(),rank=new Map(),order=[];
	for(const root of [initial,...ids])if(!seen.has(root)){
		const finished=[],stack=[{id:root,next:children.get(root)?.values()}];seen.add(root);
		while(stack.length){
			const f=stack[stack.length-1],step=f.next?.next();
			if(!step || step.done){finished.push(f.id);stack.pop();continue;}
			if(!seen.has(step.value)){seen.add(step.value);stack.push({id:step.value,next:children.get(step.value)?.values()});}
		}
		order.push(...finished.reverse());
	}
	const passed=new Set();
	for(const id of order){passed.add(id);for(const child of neighbors.get(id)??[])if(!passed.has(child))
		rank.set(child,Math.max(rank.get(child)??0,(rank.get(id)??0)+1));
	}
	/** @type {string[][]} */ const layers=[];
	for(const id of order)(layers[rank.get(id)??0]??=[]).push(id);
	return layers;
}

/** A targetless action stays in the state. Draw it inside the state rather than inventing
 * destination nodes for action names. Only rules with identical event and endpoints share a wire.
 * @param {Model} model @param {boolean} vertical @param {boolean} [compact] */
export function statechart(model,vertical,compact=false) {
	const links=bundles(model);
	const nodes=Object.keys(model.states).map(id=>{
		const internal=links.filter(e=>e.source===id && e.target===undefined);
		const width=Math.max(compact?78:94,id.length*8+(compact?30:36),...internal.map(e=>e.signal.length*7+54));
		return {id,width,height:internal.length ? 38+internal.length*26+6 : compact?38:42,internal,x:0,y:0};
	});
	const order=[...nodes.filter(n=>n.id===model.initial),...nodes.filter(n=>n.id!==model.initial)];
	const wires=links.flatMap(e=>e.target===undefined ? [] : [{...e,target:e.target,
		width:Math.max(compact?42:50,e.signal.length*7+(compact?17:22)+(e.rules.length>1?19:0)),height:22}]);
	if (!wires.length) {
		const cols=Math.min(order.length,vertical?2:Math.ceil(Math.sqrt(order.length*1.5)));
		const dx=Math.max(...nodes.map(n=>n.width))+26, dy=Math.max(...nodes.map(n=>n.height))+24;
		order.forEach((n,i)=>{n.x=36+(i%cols)*dx+n.width/2;n.y=52+Math.floor(i/cols)*dy+n.height/2;});
		const first=order[0];
		return {id:model.id,width:36+cols*dx,height:52+Math.ceil(nodes.length/cols)*dy,nodes,wires:[],
			start:[{x:12,y:first.y},{x:first.x-first.width/2,y:first.y}]};
	}
	const pad=compact?12:18;
	const byId=new Map(nodes.map(n=>[n.id,n])),layers=levels(nodes.map(n=>n.id),model.initial,wires).map(ids=>ids.map(id=>{
		const n=byId.get(id);if(!n)throw Error(`Missing layout state: ${id}`);return n;
	}));
	const drawn=transitions(layers,wires,vertical,compact),first=order[0];
	const start=vertical?[{x:first.x,y:first.y-first.height/2-23},{x:first.x,y:first.y-first.height/2}]:
		[{x:first.x-first.width/2-23,y:first.y},{x:first.x-first.width/2,y:first.y}];
	const boxes=[...nodes,...drawn],points=[...start,...drawn.flatMap(w=>[...w.points,w.path.start,...w.path.segments.flatMap(s=>[s.to,...s.controls??[]])])];
	const left=Math.min(...points.map(p=>p.x),...boxes.map(b=>b.x-b.width/2))-pad;
	const top=Math.min(...points.map(p=>p.y),...boxes.map(b=>b.y-b.height/2))-pad-30;
	const width=Math.max(...points.map(p=>p.x),...boxes.map(b=>b.x+b.width/2))-left+pad;
	const height=Math.max(...points.map(p=>p.y),...boxes.map(b=>b.y+b.height/2))-top+pad;
	for(const p of new Set([...boxes,...points])){p.x-=left;p.y-=top;}
	return {id:model.id,width,height,nodes,wires:drawn,start};
}

