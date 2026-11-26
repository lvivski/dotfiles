/** @typedef {{id:string,size:number}} Slot */
/** @typedef {{from:string,to:string}} Link */

/** Order neighboring ranks by their connections. Pull short branches toward their
 * neighbors without changing that order or overlapping the footprints in a rank.
 * @param {Slot[][]} layers @param {Link[]} links @param {number} gap @param {boolean} [reduceCrossings] */
export function arrange(layers,links,gap,reduceCrossings=false){
	/** @type {Map<string,string[]>} */ const inbound=new Map();
	/** @type {Map<string,string[]>} */ const outbound=new Map();
	for(const {from,to} of links){
		if(!inbound.has(to))inbound.set(to,[]);if(!outbound.has(from))outbound.set(from,[]);
		inbound.get(to)?.push(from);outbound.get(from)?.push(to);
	}
	/** @type {Map<string,number>} */ const pos=new Map();
	/** @type {Map<string,number>} */ const order=new Map();
	/** @param {Map<string,number>} values @param {string} id */
	function at(values,id){const v=values.get(id);if(v===undefined)throw Error(`Missing layout slot: ${id}`);return v;}
	/** @param {string} id @param {Map<string,string[]>} links @param {Map<string,number>} values */
	function average(id,links,values){
		const ids=links.get(id);return ids?.length?ids.reduce((v,i)=>v+at(values,i),0)/ids.length:at(values,id);
	}
	const reverse=layers.toReversed();
	for(const layer of layers)layer.forEach((s,i)=>order.set(s.id,i));
	for(const [levels,neighbors] of /** @type {const} */([[layers,inbound],[reverse,outbound]])){
		for(const layer of levels){
			const scores=new Map(layer.map(s=>[s.id,average(s.id,neighbors,order)]));
			layer.sort((a,b)=>at(scores,a.id)-at(scores,b.id));layer.forEach((s,i)=>order.set(s.id,i));
		}
	}
	if(reduceCrossings){
		// Adjacent slots can swap only when it reduces actual crossings across
		// their two gutters. An equal score preserves the stable lane order.
		const delta=(/** @type {string} */ a,/** @type {string} */ b)=>{
			let change=0;
			for(const neighbors of [inbound,outbound])for(const p of neighbors.get(a)??[])for(const q of neighbors.get(b)??[])
				change+=Math.sign(at(order,q)-at(order,p));
			return change;
		};
		let changed;
		do{
			changed=false;
			for(const layer of layers)for(let i=1;i<layer.length;i++){
				const a=layer[i-1],b=layer[i];if(delta(a.id,b.id)>=0)continue;
				layer[i-1]=b;layer[i]=a;order.set(b.id,i-1);order.set(a.id,i);changed=true;
			}
		}while(changed);
	}
	const span=layers.map(layer=>layer.reduce((n,s)=>n+s.size,0)+Math.max(0,layer.length-1)*gap);
	const width=Math.max(0,...span);
	layers.forEach((layer,i)=>{let u=(width-span[i])/2;for(const s of layer){pos.set(s.id,u+s.size/2);u+=s.size+gap;}});
	// Pool overlapping desired positions before clamping the rank to its original
	// span budget. A fork and its join can center on their own branch, not the page.
	for(const [levels,neighbors] of /** @type {const} */([[reverse,outbound],[layers,inbound]])){
		for(const layer of levels){
			/** @type {{start:number,n:number,sum:number}[]} */ const pools=[];
			let edge=0;
			const offsets=layer.map((s,i)=>{
				const at=edge+s.size/2;edge+=s.size+gap;
				const want=average(s.id,neighbors,pos);
				let pool={start:i,n:1,sum:want-at};
				while(pools.length){
					const left=pools[pools.length-1];if(left.sum/left.n<=pool.sum/pool.n)break;
					pools.pop();pool={start:left.start,n:left.n+pool.n,sum:left.sum+pool.sum};
				}
				pools.push(pool);return at;
			});
			const slack=width-edge+gap;
			for(const p of pools)for(let i=p.start;i<p.start+p.n;i++)pos.set(layer[i].id,offsets[i]+Math.max(0,Math.min(slack,p.sum/p.n)));
		}
	}
	return {position:(/** @type {string} */ id)=>at(pos,id),width};
}

/** Line up a long transition's intermediate slots on one rail without changing
 * the crossing-reduced order of any rank. A cycle of spacing constraints means
 * those two lanes must cross: align shorter runs on either side instead.
 * @param {Slot[][]} layers @param {string[][]} routes
 * @param {(id:string)=>number} preferred @param {number} gap */
export function rails(layers,routes,preferred,gap){
	const slots=layers.flat(),group=new Map(slots.map(s=>[s.id,s.id]));
	/** @param {string} id */
	const key=id=>group.get(id)??id;
	function constraints(){
		const blocks=new Map([...new Set(group.values())].map(id=>[id,{id,half:0,want:0,n:0,degree:0,
			next:new Map(/** @type {[string,number][]} */([])),left:0,right:0}]));
		for(const s of slots){
			const b=blocks.get(key(s.id));if(!b)throw Error(`Missing rail: ${s.id}`);
			b.half=Math.max(b.half,s.size/2);b.want+=preferred(s.id);b.n++;
		}
		for(const layer of layers)for(let i=1;i<layer.length;i++){
			const a=layer[i-1],b=layer[i],from=blocks.get(key(a.id)),to=blocks.get(key(b.id));
			if(!from||!to)throw Error("Missing ranked slot");
			if(!from.next.has(to.id))to.degree++;
			from.next.set(to.id,Math.max(from.next.get(to.id)??0,(a.size+b.size)/2+gap));
		}
		const queue=[...blocks.values()].filter(b=>!b.degree);
		for(const b of queue)for(const id of b.next.keys()){
			const after=blocks.get(id);if(after && !--after.degree)queue.push(after);
		}
		return queue.length===blocks.size?{queue,blocks}:undefined;
	}
	/** @param {string[]} ids */
	function align(ids){
		if(ids.length<2)return;
		for(const id of ids)group.set(id,ids[0]);
		if(constraints())return;
		for(const id of ids)group.set(id,id);
		const mid=Math.ceil(ids.length/2);align(ids.slice(0,mid));align(ids.slice(mid));
	}
	for(const route of routes.toSorted((a,b)=>b.length-a.length))align(route.slice(1,-1));
	const graph=constraints();if(!graph)throw Error("Inconsistent statechart lane order");
	const {queue,blocks}=graph;
	let width=0;
	for(const b of queue){
		b.left=Math.max(b.left,b.half);width=Math.max(width,b.left+b.half);
		for(const [id,d] of b.next){const c=blocks.get(id);if(c)c.left=Math.max(c.left,b.left+d);}
	}
	for(const b of queue.toReversed()){
		b.right=b.half;for(const [id,d] of b.next){const c=blocks.get(id);if(c)b.right=Math.max(b.right,c.right+d);}
	}
	const oldWidth=Math.max(...slots.map(s=>preferred(s.id)+s.size/2));
	for(const b of queue){
		b.left=Math.max(b.left,Math.min(width-b.right,b.want/b.n+(width-oldWidth)/2));
		for(const [id,d] of b.next){const c=blocks.get(id);if(c)c.left=Math.max(c.left,b.left+d);}
	}
	return (/** @type {string} */ id)=>{const b=blocks.get(key(id));if(!b)throw Error(`Unknown rail: ${id}`);return b.left;};
}
