import {arrange,rails} from "./layers.mjs";
import {fillets} from "./connectors.mjs";

/** @typedef {{x:number,y:number}} Point */
/** @typedef {Point & {width:number,height:number}} Box */
/** @typedef {{id:string,size:number,length:number}} Slot */
/** @typedef {"x"|"y"} Axis */

/** @param {Point} a @param {Point} b @param {Axis} normal */
const meets=(a,b,normal)=>Math.abs(a[normal]-b[normal])+1e-8>=Math.abs(normal==="x"?a.y-b.y:a.x-b.x);
/** @param {Point} a @param {Point} p @param {Point} b */
const openTurn=(a,p,b)=>(p.x-a.x)*(b.x-p.x)+(p.y-a.y)*(b.y-p.y)>=-1e-8;

/** Project ordered rays onto a face. Separate crowded ports without favoring
 * either end, or moving an uncrowded port away from its natural bearing.
 * @param {number[]} offsets @param {number} size */
function spread(offsets,size){
	const half=size/2-5,last=offsets.length-1,step=Math.min(9,2*half/Math.max(1,last));
	const left=offsets.map((v,i)=>Math.max(-half+i*step,Math.min(half-(last-i)*step,v))),right=[...left];
	for(let i=1;i<=last;i++)left[i]=Math.max(left[i],left[i-1]+step);
	for(let i=last-1;i>=0;i--)right[i]=Math.min(right[i],right[i+1]-step);
	return left.map((v,i)=>(v+right[i])/2);
}

/** Clip a proposed shortcut against the open interior of a box.
 * @param {Point} a @param {Point} b @param {Box} box */
function crosses(a,b,box){
	let lo=0,hi=1;
	for(const axis of /** @type {const} */(["x","y"])){
		const r=(axis==="x"?box.width:box.height)/2,min=box[axis]-r,max=box[axis]+r,d=b[axis]-a[axis];
		if(!d){if(a[axis]<=min||a[axis]>=max)return false;continue;}
		const u=(min-a[axis])/d,v=(max-a[axis])/d;lo=Math.max(lo,Math.min(u,v));hi=Math.min(hi,Math.max(u,v));
		if(lo>=hi)return false;
	}

	return true;
}
/** Remove needless folds within each leg; preserve an aligned rail and the event center.
 * @param {Point[]} pts @param {Set<Point>} pins @param {Box[]} obstacles @param {Axis} from @param {Axis} to */
function tighten(pts,pins,obstacles,from,to){
	const result=[pts[0]];
	let i=0;
	for(let end=1;end<pts.length;end++)if(end===pts.length-1||pins.has(pts[end])){
		while(i<end){
			let j=end;
			while(j>i+1){
				const a=pts[i],b=pts[j];
				if((i?openTurn(result[result.length-2],a,b):meets(a,b,from)) &&
					(j===pts.length-1?meets(a,b,to):openTurn(a,b,pts[j+1])) &&
					!obstacles.some(box=>crosses(a,b,box)))break;
				j--;
			}
			result.push(pts[j]);i=j;
		}
	}
	return result;
}

/** Reserve labels and intermediate waypoints *before* positioning states. This
 * normalizes each long transition to links between adjacent layers. Returns use
 * the same layout links in reverse, but keep their actual direction and rules.
 * @template {Box & {id:string}} N
 * @template {{source:string,target:string,width:number,height:number}} W
 * @param {N[][]} ranks @param {W[]} wires @param {boolean} vertical @param {boolean} compact */
export function transitions(ranks,wires,vertical,compact){
	const along=vertical?"height":"width",across=vertical?"width":"height";
	const nodes=new Map(ranks.flat().map(n=>[n.id,n])),rank=new Map(ranks.flatMap((layer,i)=>layer.map(n=>/** @type {const} */([n.id,2*i]))));
	/** @type {Slot[][]} */ const layers=Array.from({length:ranks.length*2-1},()=>[]);
	/** @type {Map<string,{before:number,after:number}>} */ const extents=new Map();
	/** @type {Map<W,{side:number,offset:number,spread:number}>} */ const loops=new Map();
	/** @type {Map<string,number>} */ const ports=new Map();
	/** @param {string} id @param {number} side */
	const face=(id,side)=>JSON.stringify([id,side]);
	for(const w of wires)if(w.source!==w.target){
		const side=Math.sign(Number(rank.get(w.target))-Number(rank.get(w.source)));
		for(const key of [face(w.source,side),face(w.target,-side)])ports.set(key,(ports.get(key)??0)+1);
	}
	for(const n of nodes.values()){
		const counts=[ports.get(face(n.id,-1))??0,ports.get(face(n.id,1))??0];
		n[across]=Math.max(n[across],12+Math.max(...counts)*4);
		const sizes=[n[across]/2,n[across]/2],spans=[0,0],own=wires.filter(w=>w.source===n.id&&w.target===n.id);
		for(const [i,w] of own.entries()){
			const k=i%2?1:0,side=k?1:-1,offset=sizes[k]+(compact?10:12)+w[across]/2;
			// Leave room for both perpendicular legs outside this and any nearer loop's label.
			const spread=Math.max(w[along]/2+5,spans[k]+6);
			loops.set(w,{side,offset,spread});sizes[k]=offset+w[across]/2;spans[k]=spread;
			n[along]=Math.max(n[along],2*(spread+5));
		}
		extents.set(n.id,{before:sizes[0],after:sizes[1]});
		layers[Number(rank.get(n.id))].push({id:n.id,size:sizes[0]+sizes[1],length:n[along]});
	}
	/** @type {{from:string,to:string}[]} */ const links=[];
	const routes=wires.map((w,i)=>{
		const s=Number(rank.get(w.source)),t=Number(rank.get(w.target)),step=Math.sign(t-s),via=[w.source];
		if(w.source===w.target)return {w,via,label:""};
		if(!step)throw Error(`Connected states share a layout rank: ${w.source}, ${w.target}`);
		// Use a gap (odd layer) nearest the middle; ties stay near the source.
		const middle=s+step*(2*Math.floor((Math.abs(t-s)-2)/4)+1);
		let label="";
		for(let r=s+step;r!==t;r+=step){
			const id=`\0${i}:${r}`,named=r===middle;
			layers[r].push({id,size:named?w[across]+6:3,length:named?w[along]+6:0});
			if(named)label=id;via.push(id);
		}
		via.push(w.target);
		for(let i=1;i<via.length;i++)links.push(step>0?{from:via[i-1],to:via[i]}:{from:via[i],to:via[i-1]});
		return {w,via,label};
	});
	const separation=compact?8:11,gap=compact?17:21,pitch=compact?6:8;
	const {position:preferred}=arrange(layers,links,separation,true);
	const position=rails(layers,routes.map(r=>r.via),preferred,separation);
	/** @type {Map<string,{u:number,v:number,half:number,rank:number}>} */ const slots=new Map();
	/** @param {number} u @param {number} v */
	const point=(u,v)=>vertical?{x:v,y:u}:{x:u,y:v};
	const lengths=layers.map(layer=>Math.max(separation,...layer.map(s=>s.length)));
	/** @type {number[]} */ const gutters=layers.slice(1).map(()=>gap);
	for(const [i,layer] of layers.entries()){
		for(const s of layer){
			const extent=extents.get(s.id);
			const v=position(s.id)+(extent?(extent.before-extent.after)/2:0);
			slots.set(s.id,{u:0,v,half:lengths[i]/2,rank:i});
		}
	}
	/** @param {string} id */
	function slot(id){const p=slots.get(id);if(!p)throw Error(`Unknown chart waypoint: ${id}`);return p;}
	const u=vertical?"y":"x",v=vertical?"x":"y";
	/** @typedef {{wire:W,lane:number,depth?:number,trim?:number,port?:{tip:Point,normal:Axis}}} End */
	/** @type {Map<string,End[]>} */ const faces=new Map();
	for(const {w,via} of routes)if(via.length>1){
		const side=Math.sign(slot(w.target).rank-slot(w.source).rank);
		for(const [id,dir,neighbor] of /** @type {const} */([[w.source,side,via[1]],[w.target,-side,via[via.length-2]]])){
			const key=face(id,dir),list=faces.get(key)??[];list.push({wire:w,lane:slot(neighbor).v});faces.set(key,list);
		}
	}
	for(const n of nodes.values())for(const dir of [-1,1]){
		const list=faces.get(face(n.id,dir));if(!list)continue;
		list.sort((a,b)=>a.lane-b.lane);
		const s=slot(n.id),gutter=s.rank-(dir<0?1:0);
		for(const bank of [-1,1]){
			const group=list.filter(e=>bank*(e.lane-s.v)>1e-6);
			if(group.length<2)continue;
			if(bank<0)group.reverse(); // Innermost first, on either side of the state.
			const last=group.length-1;
			// Share the existing gutter first; widen only the gap that needs more turns.
			gutters[gutter]=Math.max(gutters[gutter],gap/2+last*pitch+2);
			group.forEach((e,i)=>{
				e.depth=gap/2+(last-i)*pitch;
				e.trim=4+5*i/last;
			});
		}
	}
	let edge=0;
	for(const [i,layer] of layers.entries()){
		for(const {id} of layer){
			const s=slot(id);s.u=edge+s.half;
			const n=nodes.get(id);if(n)Object.assign(n,point(s.u,s.v));
		}
		edge+=lengths[i]+(gutters[i]??0);
	}
	/** Distance from a state's center to the rail turn, or the next slab for an unfanned end.
	 * @param {string} id @param {number} dir @param {End} e */
	const depth=(id,dir,e)=>{const s=slot(id);return s.half+(e.depth??gutters[s.rank-(dir<0?1:0)]);};
	const chips=new Map(routes.map(({w,label})=>{
		const loop=loops.get(w),p=slot(loop?w.source:label),m=point(p.u,p.v+(loop?loop.side*loop.offset:0));
		return [w,{...m,width:w.width+6,height:w.height+6}];
	}));
	const bounds=[...nodes.values(),...chips.values()];
	/** @param {Point} a @param {Point} b @param {W} w */
	const free=(a,b,w)=>!bounds.some(o=>o!==chips.get(w)&&crosses(a,b,o));
	for(const n of nodes.values())for(const dir of [-1,1]){
		const here=slot(n.id),extent=extents.get(n.id);
		if(extent && (dir<0?extent.before:extent.after)>n[across]/2)continue; // This side carries a loop.
		const rays=[-1,1].flatMap(side=>(faces.get(face(n.id,side))??[]).flatMap(e=>{
			const dv=dir*(e.lane-here.v),du=side*depth(n.id,side,e);
			return dv>n[across]/2 && dv*n[along]>Math.abs(du)*n[across]?
				[{e,offset:du/dv*n[across]/2,aim:point(here.u+du,e.lane)}]:[];
		})).sort((a,b)=>a.offset-b.offset);
		const offsets=spread(rays.map(r=>r.offset),n[along]);
		rays.forEach(({e,aim},i)=>{
			const tip=point(here.u+offsets[i],here.v+dir*n[across]/2);
			if(meets(tip,aim,v)&&free(tip,aim,e.wire))e.port={tip,normal:v};
		});
	}
	for(const n of nodes.values())for(const side of [-1,1]){
		const ends=(faces.get(face(n.id,side))??[]).filter(e=>!e.port),s=slot(n.id);
		const offsets=spread(ends.map(e=>(e.lane-s.v)*n[along]/2/depth(n.id,side,e)),n[across]);
		ends.forEach((e,i)=>{e.port={tip:point(s.u+side*n[along]/2,s.v+offsets[i]),normal:u};});
	}
	/** @param {N} n @param {number} side @param {W} w
	 * @returns {{tip:Point,guide?:Point,knee?:Point,trim:number,normal:Axis}} */
	function landing(n,side,w){
		const end=faces.get(face(n.id,side))?.find(e=>e.wire===w);
		if(!end?.port)throw Error(`Missing transition port: ${n.id}`);
		const s=slot(n.id),aim=point(s.u+side*depth(n.id,side,end),end.lane),{tip,normal}=end.port;
		const turn={tip,normal,knee:end.depth===undefined?undefined:aim,trim:end.trim??9};
		if(normal===v || meets(tip,aim,u)&&free(tip,aim,w))return turn;
		// If a loop or neighboring state rules out the side face, stagger the
		// second fold too: equal-length stubs would squeeze the diagonals together.
		const lead=end.depth===undefined?gap/2:end.depth-gap/4,dv=aim[v]-tip[v];
		const guide=point(s.u+side*(s.half+lead),tip[v]+Math.sign(dv)*Math.min(lead,Math.abs(dv)/2));
		if(!free(tip,guide,w))guide[v]=tip[v];
		return {...turn,guide};
	}
	return routes.map(({w,via,label})=>{
		const a=nodes.get(w.source),b=nodes.get(w.target);if(!a||!b)throw Error("Unknown statechart endpoint");
		const s=slot(a.id),t=slot(b.id),loop=loops.get(w);
		const obstacles=bounds.filter(b=>b!==chips.get(w));
		/** A quadratic fits inside the bounds of its two tangency points and corner.
		 * @param {Point} a @param {Point} p @param {Point} b */
		const clear=(a,p,b)=>obstacles.every(o=>Math.max(a.x,p.x,b.x)<=o.x-o.width/2 || Math.min(a.x,p.x,b.x)>=o.x+o.width/2 ||
			Math.max(a.y,p.y,b.y)<=o.y-o.height/2 || Math.min(a.y,p.y,b.y)>=o.y+o.height/2);
		if(loop){
			const {side,offset,spread}=loop,v=s.v+side*a[across]/2,top=s.v+side*offset,m=point(s.u,top);
			const points=[point(s.u-spread,v),point(s.u-spread,top),m,point(s.u+spread,top),point(s.u+spread,v)];
			return {...w,...m,kind:"loop",points,path:fillets(points,m,clear)};
		}
		const side=Math.sign(t.u-s.u),from=landing(a,side,w),to=landing(b,-side,w);
		const at=slot(label),m=point(at.u,at.v),pins=new Set([m]);
		/** @type {Map<Point,number>} */ const trims=new Map();
		for(const end of [from,to])if(end.knee){
			pins.add(end.knee);trims.set(end.knee,end.trim);
			if(end.guide)trims.set(end.guide,end.trim);
		}
		const pts=[from.tip];
		if(from.guide)pts.push(from.guide);
		if(from.knee)pts.push(from.knee);
		// Stay in the assigned channel across a layer's entire slab. This leaves
		// the spaces between layers free for short diagonal connections.
		for(const id of via.slice(1,-1)){
			const r=slot(id),center=id===label?m:point(r.u,r.v);
			pts.push(point(r.u-side*r.half,r.v),center,point(r.u+side*r.half,r.v));
			if(via.length>3&&(!from.knee&&id===via[1]||!to.knee&&id===via[via.length-2]))pins.add(center);
		}
		if(to.knee)pts.push(to.knee);
		if(to.guide)pts.push(to.guide);
		pts.push(to.tip);
		const points=tighten(pts,pins,obstacles,from.normal,to.normal);
		return {...w,...m,kind:side>0?"forward":"return",points,path:fillets(points,m,clear,trims)};
	});
}
