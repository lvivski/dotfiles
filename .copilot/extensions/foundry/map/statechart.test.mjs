import assert from "node:assert/strict";
import test from "node:test";
import { catalog } from "../work/catalog.mjs";
import { statechart } from "./statechart.mjs";
import {pathData} from "./connectors.mjs";
import { machine } from "../work/machine.mjs";

/** @typedef {import("./connectors.mjs").Point} Point */

/** @param {{x:number,y:number,width:number,height:number}|undefined} n @param {{x:number,y:number}|undefined} p */
function boundary(n,p){
	assert.ok(n&&p);const dx=Math.abs(p.x-n.x),dy=Math.abs(p.y-n.y);
	assert.ok(dx<=n.width/2+1e-7 && dy<=n.height/2+1e-7 && Math.min(Math.abs(dx-n.width/2),Math.abs(dy-n.height/2))<1e-7,"endpoint on the actual state boundary");
}
/** Sample the actual Bézier, independently of the router's control-hull test.
 * @param {import("./connectors.mjs").Path} path */
function samples(path){
	let a=path.start;const points=[a];
	for(const {controls,to:d} of path.segments){
		const b=controls?.[0],steps=Math.max(1,Math.ceil(b?Math.hypot(b.x-a.x,b.y-a.y)+Math.hypot(d.x-b.x,d.y-b.y):Math.hypot(d.x-a.x,d.y-a.y)));
		assert.ok(!controls || controls.length===1,"state transitions round their corners, not the whole span");
		for(let j=1;j<=steps;j++){const t=j/steps,u=1-t;points.push(b?{x:u*u*a.x+2*u*t*b.x+t*t*d.x,y:u*u*a.y+2*u*t*b.y+t*t*d.y}:
			{x:u*a.x+t*d.x,y:u*a.y+t*d.y});}
		a=d;
	}
	return points;
}

test("a fork fans out and rejoins by topology, even with a return to the initial state",()=>{
	const m=machine("fork","start",{
		end:[{on:"restart",target:"start"}],left:[{on:"accept",target:"end"},{on:"repeat",target:"left"}],
		start:[{on:"choose-left",target:"left"},{on:"choose-right",target:"right"}],right:[{on:"accept",target:"end"}],
	});
	for(const vertical of [false,true]){
		const g=statechart(m,vertical),axis=vertical?"y":"x",cross=vertical?"x":"y";
		const [end,left,start,right]=g.nodes;
		assert.equal(left[axis],right[axis],"siblings share a rank rather than a single-file spine");
		assert.ok(start[axis]<left[axis] && left[axis]<end[axis] && left[cross]!==right[cross]);
		const loop=g.wires.find(w=>w.source===w.target);assert.ok(loop);
		assert.ok(loop.points.length>=3 && loop.points.every(p=>Math.hypot(p.x-left.x,p.y-left.y)<Math.max(left.width,left.height)),
			"the self-loop stays local to its state");
	}
});

test("every shipped region explains the purpose of its states and ordered alternatives",()=>{
	for(const m of Object.values(catalog().machines)){
		const info=m.info;assert.ok(info,m.id);assert.ok(info.description.trim(),m.id);
		assert.deepEqual(Object.keys(info.states).sort(),Object.keys(m.states).sort());
		for(const [state,edges] of Object.entries(m.states)){
			assert.match(info.states[state],/\w \w/,`${m.id}.${state}`);
			for(const e of edges)assert.match(e.description??("reason" in e && typeof e.reason==="string"?e.reason:""),/\w \w/,`${m.id}.${state} on ${e.on}`);
		}
	}
});

test("dense transitions retain straight runs, with rounding confined to actual bends",()=>{
	for(const id of ["activity","assignment","review"])for(const vertical of [false,true]){
		const g=statechart(catalog().machines[id],vertical),axis=vertical?"y":"x";
		assert.ok(g.wires.some(w=>pathData(w.path).includes("Q")),"real bends must be rounded");
		for(const w of g.wires)if(w.kind==="forward"||w.kind==="return"){
			const pts=samples(w.path),sign=Math.sign(pts[pts.length-1][axis]-pts[0][axis]);
			assert.ok(sign!==0 && pts.every((p,i)=>!i||sign*(p[axis]-pts[i-1][axis])>=-1e-6),`${id}: ${w.source}.${w.signal} reverses direction`);
			let start=w.path.start;
			for(const seg of w.path.segments){
				if(seg.controls){
					const [corner]=seg.controls;
					assert.ok(Math.hypot(start.x-corner.x,start.y-corner.y)<=9.000001 &&
						Math.hypot(seg.to.x-corner.x,seg.to.y-corner.y)<=9.000001,"bends remain local");
				}
				assert.ok(seg.to.x!==start.x||seg.to.y!==start.y,"route segments have a bearing");start=seg.to;
			}
		}
	}
});

test("a return spanning several ranks has a straight lane rather than a row of unrelated diagonal hops",()=>{
	const m=machine("return","start",{start:[{on:"begin",target:"writing"}],writing:[{on:"submit",target:"check"}],
		check:[{on:"pass",target:"done"}],done:[{on:"reset",target:"start"}]});
	for(const vertical of [false,true]){
		const s=statechart(m,vertical),edge=s.wires.find(w=>w.signal==="reset");assert.ok(edge);
		const u=vertical?"y":"x",v=vertical?"x":"y",cross=edge[v];
		const rail=edge.points.filter(p=>Math.abs(p[v]-cross)<1e-6).map(p=>p[u]);
		const span=Math.abs(edge.points[0][u]-edge.points[edge.points.length-1][u]);
		assert.ok(Math.max(...rail)-Math.min(...rail)>span*.55,"long return retains a distinct parallel run through its label");
	}
});

test("parallel returns into one state peel off in nested order, with smaller inner bends",()=>{
	const m=machine("retry","start",{start:[{on:"begin",target:"write"}],write:[{on:"submit",target:"check"}],
		check:[{on:"pass",target:"end"}],end:Array.from({length:6},(_,i)=>({on:`redo-${i}`,target:"start"}))});
	for(const vertical of [false,true])for(const compact of [false,true]){
		const g=statechart(m,vertical,compact),target=g.nodes[0],along=vertical?"y":"x",across=vertical?"x":"y";
		for(const side of [-1,1]){
			const fan=g.wires.filter(w=>w.target==="start" && side*(w[across]-target[across])>5)
				.sort((a,b)=>side*(a[across]-b[across]));
			assert.ok(fan.length>=2);
			const turns=fan.map(w=>{
				const rail=w.points.filter(p=>Math.abs(p[across]-w[across])<1e-6);
				const knee=rail.at(-1);assert.ok(knee);
				const bend=w.path.segments.findIndex(s=>s.controls?.[0].x===knee.x&&s.controls[0].y===knee.y);
				assert.ok(bend>0,"peel-off remains a visible rounded turn");
				const before=w.path.segments[bend-1].to;
				return {depth:Math.abs(knee[along]-target[along]),length:Math.abs(knee[along]-rail[0][along]),
					round:Math.hypot(before.x-knee.x,before.y-knee.y)};
			});
			turns.slice(1).forEach((outer,i)=>{
				const inner=turns[i];
				assert.ok(inner.depth>outer.depth+2 && outer.length>inner.length+2,"inner lane leaves earlier than the outer lane");
				assert.ok(inner.round<outer.round,"inner corner should use less rounding");
			});
		}
	}
});

test("nested approaches leave visible space between the painted paths all the way to their ports",()=>{
	const retry=machine("retry","start",{start:[{on:"go",target:"write"},{on:"hold",target:"start"},{on:"review",target:"start"}],
		write:[{on:"submit",target:"check"}],check:[{on:"pass",target:"end"}],
		end:Array.from({length:6},(_,i)=>({on:`redo-${i}`,target:"start"}))});
	const {assignment,activity}=catalog().machines;
	for(const [m,id] of /** @type {const} */([[retry,"start"],[assignment,"waiting"],[assignment,"published"],[activity,"active"]])){
		for(const vertical of [false,true])for(const compact of [false,true]){
			const g=statechart(m,vertical,compact),n=g.nodes.find(n=>n.id===id);assert.ok(n);
			const along=vertical?"y":"x",across=vertical?"x":"y";
			// These are the two directions of travel through the same gutter.
			const ends=g.wires.filter(w=>w.source===id&&w.kind==="forward"||w.target===id&&w.kind==="return");
			let pairs=0;
			for(const bank of [-1,1]){
				/** @type {{knee:Point,paint:Point[]}[]} */
				const group=ends.filter(w=>bank*(w[across]-n[across])>2).sort((a,b)=>bank*(a[across]-b[across])).map(w=>{
					const outward=w.source===id?w.points:w.points.toReversed();
					const knee=outward.find(p=>Math.abs(p[across]-w[across])<1e-6);assert.ok(knee);
					return {knee,paint:samples(w.path).filter(p=>p[along]<=knee[along])};
				});
				for(let i=1;i<group.length;i++){
					const inner=group[i-1],outer=group[i];pairs++;
					assert.ok(!inner.paint.some(p=>outer.paint.some(q=>(q.x-p.x)**2+(q.y-p.y)**2<9)),
						`${id}: neighboring strokes bunch up between their turns and the state`);
					assert.ok(inner.knee[along]>outer.knee[along]+2,`${id}: inner rail turns farther from the state`);
				}
			}
			assert.ok(pairs>=2,`${id}: exercise a fan, not an isolated arrow`);
		}
	}
});

test("self-loops and transitions through offset event labels have no acute interior corners",()=>{
	for(const m of Object.values(catalog().machines))for(const vertical of [false,true])for(const compact of [false,true]){
		for(const w of statechart(m,vertical,compact).wires){
			const pts=w.points;
			for(let i=1;i<pts.length-1;i++){
				const a=pts[i-1],p=pts[i],b=pts[i+1];
				assert.ok((a.x-p.x)*(b.x-p.x)+(a.y-p.y)*(b.y-p.y)<=1e-6,
					`${m.id}: ${w.source}.${w.signal} doubles back at ${p.x},${p.y}`);
			}
		}
	}
});

test("the painted endpoints meet state faces rather than skimming their borders",()=>{
	const fan=machine("fan","source",Object.fromEntries(["source",...Array.from({length:7},(_,i)=>`leaf-${i}`)].map((s,_,ids)=>
		[s,s==="source"?ids.slice(1).map(target=>({on:`to-${target}`,target})):[]])));
	for(const m of [fan,...Object.values(catalog().machines)])for(const vertical of [false,true])for(const compact of [false,true]){
		const g=statechart(m,vertical,compact),nodes=new Map(g.nodes.map(n=>[n.id,n]));
		const sides=new Set();
		for(const w of g.wires){
			const {start,segments}=w.path,last=segments[segments.length-1],prior=segments.at(-2)?.to??start;
			for(const [id,p,q] of /** @type {const} */([[w.source,start,segments[0].controls?.[0]??segments[0].to],
				[w.target,last.to,last.controls?.at(-1)??prior]])){
				const n=nodes.get(id);assert.ok(n);
				const xFace=Math.abs(Math.abs(p.x-n.x)-n.width/2)<1e-6,dx=Math.abs(q.x-p.x),dy=Math.abs(q.y-p.y);
				assert.ok(Math.hypot(dx,dy)>0 && (xFace?dx:dy)*Math.sqrt(3)+1e-6>=(xFace?dy:dx),
					`${m.id}: ${w.source}.${w.signal} grazes ${id}`);
				if(id==="source")sides.add(xFace);
			}
		}
		if(m===fan)assert.equal(sides.size,2,"oblique and straight branches can use different state faces");
	}
});

test("both layouts draw every rule at its real endpoints, including loops, parallel guards and internal actions",()=>{
	for(const m of Object.values(catalog().machines))for(const vertical of [true,false])for(const compact of [true,false]){
		const s=statechart(m,vertical,compact);
		assert.deepEqual(s.nodes.map(n=>n.id),Object.keys(m.states));
		assert.ok(s.width>0 && s.height>0);
		boundary(s.nodes.find(n=>n.id===m.initial),s.start.at(-1));
		for(const n of s.nodes){
			const links=[...n.internal,...s.wires.filter(e=>e.source===n.id)];
			assert.deepEqual(links.flatMap(l=>l.rules).sort((a,b)=>a-b),m.states[n.id].map((_,i)=>i));
			for(const link of links)for(const i of link.rules){
				const rule=m.states[n.id][i];assert.equal(link.target,rule.target);assert.equal(link.signal,rule.on);
			}
			for(const link of n.internal)assert.equal(link.target,undefined,"an action is not a state");
		}
		for(const e of s.wires){
			assert.ok(Number.isFinite(e.x+e.y));assert.doesNotMatch(pathData(e.path),/NaN|Infinity/);
			const first=e.path.start,last=e.path.segments.at(-1)?.to;
			boundary(s.nodes.find(n=>n.id===e.source),first);boundary(s.nodes.find(n=>n.id===e.target),last);
			assert.ok(e.path.segments.some(s=>s.to.x===e.x && s.to.y===e.y),"event labels sit on the painted route");
			if(e.target===e.source)assert.notDeepEqual(first,last,"an explicit loop returns to a second port on the same state");
		}
	}
});

test("routing leaves state boxes and event labels unobstructed in both orientations",()=>{
	const stress=machine("branches","one",{
		one:[{on:"stay-on-one",target:"one"},{on:"stay-again",target:"one"},{on:"skip-middle",target:"three"},{on:"advance",target:"two"}],
		two:[{on:"retry",target:"one"},{on:"inspect",action:"observe"},{on:"complete",target:"three"}],
		three:[{on:"restart",target:"one"},{on:"return",target:"two"},{on:"review",target:"three"}],
	});
	for(const m of [...Object.values(catalog().machines),stress])for(const vertical of [false,true])for(const compact of [true,false]){
		const s=statechart(m,vertical,compact),boxes=[...s.nodes,...s.wires];
		const paint=s.wires.map(w=>({w,points:samples(w.path)}));
		for(const [i,b] of boxes.entries()){
			const left=b.x-b.width/2,right=b.x+b.width/2,top=b.y-b.height/2,bottom=b.y+b.height/2;
			assert.ok(left>=0 && top>=30 && right<=s.width && bottom<=s.height,`${m.id}: frame contains box`);
			for(const other of boxes.slice(i+1))assert.ok(Math.abs(b.x-other.x)>=(b.width+other.width)/2 ||
				Math.abs(b.y-other.y)>=(b.height+other.height)/2,`${m.id}: boxes must not overlap`);
			for(const {w,points} of paint)if(w!==b)assert.ok(!points.some(p=>
				p.x>left+1e-6 && p.x<right-1e-6 && p.y>top+1e-6 && p.y<bottom-1e-6),
				`${m.id}: ${w.source}.${w.signal} crosses ${"id" in b?b.id:b.signal}`);
		}
	}
});
