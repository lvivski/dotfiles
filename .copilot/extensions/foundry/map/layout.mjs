import {network} from "./network.mjs";
import {arrange} from "./layers.mjs";
import {connector,pathData} from "./connectors.mjs";

/** @typedef {import("./model.mjs").Assignment} Assignment */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{from:string,to:string,points:Point[]}} Wire */
/** @typedef {{width:number,height:number,boxes:({id:string}&Point)[],edges:Wire[]}} Block */

/** @param {Set<string>} group @param {ReturnType<typeof network>} work @param {number} w @param {number} h @param {boolean} vertical @param {number} availableCross @returns {Block} */
function layered(group,work,w,h,vertical,availableCross){
	const along=vertical?h:w,across=vertical?w:h,gutter=vertical?44:74,separation=24;
	const ranks=new Map(),remaining=new Map(),queue=[],links=[];
	for(const id of group){
		const needs=work.nodes.get(id)?.needs.filter(p=>group.has(p))??[];
		remaining.set(id,needs.length);if(!needs.length)queue.push(id);
		for(const from of needs)links.push({from,to:id});
	}
	for(let i=0;i<queue.length;i++)for(const child of work.children.get(queue[i])??[]){
		ranks.set(child,Math.max(ranks.get(child)??0,(ranks.get(queue[i])??0)+1));
		const left=remaining.get(child)-1;remaining.set(child,left);if(!left)queue.push(child);
	}
	if(queue.length!==group.size)throw Error("The assignments contain a dependency cycle.");
	// Bring short branches next to their first consumer without making a crowded
	// rank even wider than the viewport. Real prerequisites always stay upstream.
	/** @type {number[]} */ const population=[];
	for(const id of queue){const r=ranks.get(id)??0;population[r]=(population[r]??0)+1;}
	const capacity=Math.max(...population,Math.floor((availableCross+separation)/(across+separation)));
	for(const id of queue.toReversed()){
		const users=work.children.get(id)??[],at=ranks.get(id)??0;
		if(!users.length)continue;
		let near=Math.min(...users.map(p=>ranks.get(p)))-1;
		while(near>at && population[near]>=capacity)near--;
		if(near>at){ranks.set(id,near);population[at]--;population[near]++;}
	}
	/** @type {string[][]} */ const layers=[];
	for(const id of group)(layers[ranks.get(id)??0]??=[]).push(id);
	/** @type {Map<string,string[]>} */ const inbound=new Map();
	/** @type {Map<string,string[]>} */ const outbound=new Map();
	// Skipped ranks reserve a narrow channel; neighboring cards cannot occupy it.
	const routes=links.map(({from,to},i)=>{
		const via=[from];
		for(let r=(ranks.get(from)??0)+1;r<ranks.get(to);r++){const slot=`\0${i}:${r}`;layers[r].push(slot);via.push(slot);}
		via.push(to);
		for(let j=1;j<via.length;j++){
			const a=via[j-1],b=via[j];if(!outbound.has(a))outbound.set(a,[]);if(!inbound.has(b))inbound.set(b,[]);
			outbound.get(a)?.push(b);inbound.get(b)?.push(a);
		}
		return {from,to,via};
	});
	const {position,width:cross}=arrange(layers.map(ids=>ids.map(id=>({id,size:group.has(id)?across:6}))),
		[...outbound].flatMap(([from,ids])=>ids.map(to=>({from,to}))),separation);
	const length=layers.length*along+(layers.length-1)*gutter;
	/** @type {Map<string,Point>} */ const centers=new Map();
	layers.forEach((ids,r)=>{
		for(const id of ids){
			const c=position(id),a=r*(along+gutter)+along/2;
			centers.set(id,vertical?{x:c,y:a}:{x:a,y:c});
		}
	});
	/** @param {string} id */
	const center=id=>{const p=centers.get(id);if(!p)throw Error(`Missing layout position: ${id}`);return p;};
	/** @param {Map<string,string[]>} neighbors @returns {Map<string,Map<string,number>>} */
	function offsets(neighbors){
		const axis=vertical?"x":"y",ports=new Map();
		for(const [id,peers] of neighbors)if(group.has(id)&&peers.length>1){
			const sorted=[...peers].sort((a,b)=>center(a)[axis]-center(b)[axis]);
			ports.set(id,new Map(sorted.map((p,i)=>[p,((i+.5)/peers.length-.5)*Math.min(48,across*.66)])));
		}
		return ports;
	}
	const arrivals=offsets(inbound),departures=offsets(outbound);
	/** @param {string} id @param {number} side @param {string} neighbor */
	function port(id,side,neighbor){
		const p=center(id),shift=(side===1?departures:arrivals).get(id)?.get(neighbor)??0;
		return vertical?{x:p.x+shift,y:p.y+side*h/2}:{x:p.x+side*w/2,y:p.y+shift};
	}
	return {width:vertical?cross:length,height:vertical?length:cross,boxes:[...group].map(id=>({id,x:center(id).x-w/2,y:center(id).y-h/2})),
		edges:routes.map(({from,to,via})=>({from,to,points:[port(from,1,via[1]),...via.slice(1,-1).flatMap((id,i)=>
			[port(id,-1,via[i]),port(id,1,via[i+2])]),port(to,-1,via[via.length-2])]}))};
}

/** @param {Point[]} points @param {boolean} vertical */
export function wirePath(points,vertical){
	return pathData(connector(points,vertical));
}
/** Each connected subgraph is ranked by real prerequisites. Pack disconnected subgraphs
 * separately so a run with many independent jobs does not become a single enormous rank.
 * @param {Assignment[]} nodes @param {number} available @param {number} [height] */
export function layout(nodes,available,height=600) {
	const work=network(nodes),{nodes:byId,children}=work, vertical=available<660,w=vertical?158:184,h=78,gap=28,pad=16;
	const seen=new Set(), singles=[];
	/** @type {Block[]} */ const blocks=[];
	for(const start of [...byId.keys()].sort()){
		if(seen.has(start))continue;
		const group=new Set([start]);
		for(const id of group){
			seen.add(id);
			for(const p of [...byId.get(id)?.needs??[],...children.get(id)??[]])if(byId.has(p))group.add(p);
		}
		if(group.size===1&&!byId.get(start)?.needs.includes(start)){singles.push(start);continue;}
		blocks.push(layered(group,work,w,h,vertical,(vertical?available:height)-2*pad));
	}
	const ratio=Math.max(.55,Math.min(2.5,available/Math.max(1,height)));
	const area=blocks.reduce((a,b)=>a+(b.width+gap)*(b.height+gap),singles.length*(w+gap)*(h+gap));
	const rowWidth=Math.max(w,...blocks.map(b=>b.width),Math.sqrt(area*ratio));
	blocks.sort((a,b)=>b.height-a.height||b.width-a.width);
	if(singles.length){
		const cols=Math.min(singles.length,Math.max(1,Math.floor((rowWidth+gap)/(w+gap))));
		blocks.push({width:cols*(w+gap)-gap,height:Math.ceil(singles.length/cols)*(h+gap)-gap,edges:[],
			boxes:singles.map((id,i)=>({id,x:i%cols*(w+gap),y:Math.floor(i/cols)*(h+gap)}))});
	}
	/** @type {Block} */ const result={boxes:[],edges:[],width:0,height:0};
	let x=0,y=0,rowH=0;
	for(const b of blocks){
		if(x && x+b.width>rowWidth){x=0;y+=rowH+gap;rowH=0;}
		const dx=x+pad,dy=y+pad;
		for(const n of b.boxes)result.boxes.push({id:n.id,x:n.x+dx,y:n.y+dy});
		for(const e of b.edges)result.edges.push({...e,points:e.points.map(p=>({x:p.x+dx,y:p.y+dy}))});
		result.width=Math.max(result.width,dx+b.width+pad);result.height=Math.max(result.height,dy+b.height+pad);
		x+=b.width+gap;rowH=Math.max(rowH,b.height);
	}
	return {...result,w,h,vertical};
}
