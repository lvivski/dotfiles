import { statechart } from "./statechart.mjs";
import { shape,button } from "./svg.mjs";
import {pathData} from "./connectors.mjs";

/** @typedef {import("./statechart.mjs").Model} Model */
/** @typedef {import("./statechart.mjs").Transition} Transition */
/** @typedef {import("./statechart.mjs").Point} Point */

/** @type {WeakMap<Model,Map<string,ReturnType<typeof statechart>>>} */ const cache=new WeakMap();
/** @param {Model} m @param {boolean} vertical @param {boolean} compact */
function layout(m,vertical,compact) {
	const key=`${vertical}:${compact}`,existing=cache.get(m)?.get(key);if(existing)return existing;
	const scene=statechart(m,vertical,compact), entries=cache.get(m)??new Map();
	entries.set(key,scene);cache.set(m,entries);return scene;
}
/** @param {Model[]} models @param {boolean} vertical @param {boolean} compact */
function pack(models,vertical,compact) {
	const parallel=models.length>1, margin=parallel?16:0;
	let x=margin,y=parallel?46:0,w=0,h=0;
	const frames=models.map(m=>{
		const scene=layout(m,vertical,compact), frame={m,scene,x,y};
		w=Math.max(w,x+scene.width+margin);h=Math.max(h,y+scene.height+margin);
		if(vertical)x+=scene.width+16;else y+=scene.height+16;
		return frame;
	});
	return {frames,width:w,height:h};
}

/** @param {SVGGElement} world @param {SVGSVGElement} mini @param {Model[]} models @param {number} w @param {number} h
 * @param {(id:string,state:string)=>void} inspect @param {(id:string,link:Transition)=>void} event */
export function drawChart(world,mini,models,w,h,inspect,event) {
	const best=[pack(models,false,w<440),pack(models,true,w<440)].sort((a,b)=>Math.min(w/b.width,h/b.height)-Math.min(w/a.width,h/a.height))[0];
	world.replaceChildren();mini.replaceChildren();
	/** @type {{id:string,state:string,g:SVGGElement,mini:SVGRectElement,center:Point}[]} */ const states=[];
	/** @type {{id:string,link:Transition,chip:SVGGElement,line?:SVGPathElement}[]} */ const badges=[];
	if(models.length>1)world.append(shape("rect",{class:"frame parallel-frame",x:0,y:0,width:best.width,height:best.height,rx:7}),
		shape("text",{x:14,y:25,class:"frame-name"},"Parallel regions"));
	for(const {m,scene,x,y} of best.frames){
		const frame=shape("g",{transform:`translate(${x} ${y})`,"data-region":m.id,role:"group","aria-label":`${m.id}: ${m.info?.description??"Statechart"}`});
		frame.append(shape("rect",{class:"frame",width:scene.width,height:scene.height,rx:5}),
			shape("rect",{class:"frame-head",x:1,y:1,width:scene.width-2,height:29,rx:4}),
			shape("text",{class:"frame-name",x:12,y:20},m.id),
			shape("text",{class:"frame-kind",x:scene.width-12,y:20,"text-anchor":"end"},`${scene.nodes.length} ${scene.nodes.length===1?"state":"states"}`));
		const wires=shape("g",{}), boxes=shape("g",{}), labels=shape("g",{});
		frame.append(wires,boxes,labels);world.append(frame);
		const [start,entry]=scene.start;
		wires.append(shape("path",{d:`M${start.x} ${start.y} L${entry.x} ${entry.y}`,class:"wire start-wire","marker-end":"url(#hot-tip)"}),shape("circle",{class:"start-dot",cx:start.x,cy:start.y,r:4}));
		/** @param {Transition} e @param {number} cx @param {number} cy @param {number} width @param {SVGPathElement} [line] */
		function badge(e,cx,cy,width,line) {
			const g=shape("g",{class:"event-chip",transform:`translate(${cx} ${cy})`,"data-region":m.id,"data-source":e.source,"data-event":e.signal});
			if(e.target!==undefined)g.dataset.target=e.target;
			if(line){
				line.dataset.source=e.source;line.dataset.event=e.signal;if(e.target!==undefined)line.dataset.target=e.target;
				const trace=()=>line.classList.toggle("reading",g.matches(":hover,:focus"));
				for(const type of ["pointerenter","pointerleave","focus","blur"])g.addEventListener(type,trace);
			}
			const description=e.rules.map(i=>{
				const r=m.states[e.source][i];return [r.when?.length && `[${r.when.join(" & ")}]`,r.description??r.reason].filter(Boolean).join(" ");
			}).join("\n");
			g.setAttribute("aria-description",description);
			g.append(shape("title",{},description),shape("rect",{x:-width/2,y:-10.5,width,height:21,rx:10.5}),
				shape("path",{class:"chip-play",d:`M${-width/2+5} -3 l4.5 3 -4.5 3z`}),
				shape("text",{y:4,"text-anchor":"middle"},e.signal+(e.rules.length>1?` ×${e.rules.length}`:"")));
			button(g,description,()=>event(m.id,e));
			labels.append(g);badges.push({id:m.id,link:e,chip:g,line});
		}
		for(const e of scene.wires) {
			const d=pathData(e.path),p=shape("path",{class:"wire","data-route":e.kind,d,"marker-end":"url(#tip)"});
			wires.append(p);badge(e,e.x,e.y,e.width,p);
			mini.append(shape("path",{class:"mini-wire",d,transform:`translate(${x} ${y})`}));
		}
		for(const n of scene.nodes) {
			const left=n.x-n.width/2,top=n.y-n.height/2,cy=top+(n.internal.length?19:n.height/2);
			const g=shape("g",{class:"sc-node","data-region":m.id,"data-state":n.id});
			const purpose=m.info?.states[n.id]??"No state purpose supplied.";
			g.setAttribute("aria-description",purpose);
			g.append(shape("title",{},purpose),shape("rect",{class:"state-box",x:left,y:top,width:n.width,height:n.height,rx:5}),
				shape("circle",{class:"state-indicator",cx:left+13,cy,r:3.2}),
				shape("text",{class:"state-name",x:left+24,y:cy+5},n.id));
			button(g,`Inspect ${m.id}.${n.id}`,()=>inspect(m.id,n.id));boxes.append(g);
			const miniature=shape("rect",{class:"mini-node",x:x+left,y:y+top,width:n.width,height:n.height,rx:4});mini.append(miniature);
			states.push({id:m.id,state:n.id,g,mini:miniature,center:{x:x+n.x,y:y+n.y}});
			n.internal.forEach((e,i)=>badge(e,n.x,top+43+i*26,Math.min(n.width-10,Math.max(52,e.signal.length*7+34))));
		}
	}
	return {width:best.width,height:best.height,
		/** @param {string} id @param {string} state */
		point:(id,state)=>states.find(s=>s.id===id&&s.state===state)?.center,
		/** @param {Record<string,string>} active @param {{id:string,state:string,link?:Transition}} inspected
		 * @param {(id:string,e:Transition)=>boolean} enabled @param {(id:string,e:Transition)=>boolean} taken */
		highlight(active,inspected,enabled,taken) {
			for(const s of states) {
				const on=active[s.id]===s.state, selected=s.id===inspected.id&&s.state===inspected.state;
				s.g.classList.toggle("active",on);s.mini.classList.toggle("active",on);s.g.classList.toggle("inspected",selected);
				s.g.setAttribute("aria-pressed",String(selected));s.g.setAttribute("aria-label",`Inspect ${s.id}.${s.state}${on?", active":""}`);
			}
			for(const {id,link,chip,line} of badges) {
				const can=enabled(id,link),last=taken(id,link);
				const isInspected=id===inspected.id && inspected.link?.source===link.source && inspected.link.signal===link.signal && inspected.link.target===link.target;
				chip.classList.toggle("inspected",isInspected);
				chip.classList.toggle("enabled",can);chip.classList.toggle("branch",!can && active[id]===link.source);chip.classList.toggle("taken",last);
				chip.setAttribute("aria-label",`${can?"Send":"Inspect"} ${link.signal} from ${id}.${link.source}${link.target?` to ${link.target}`:" (internal)"}`);
				if(line){
					line.classList.toggle("enabled",can);line.classList.toggle("taken",last&&!can);line.classList.toggle("inspected",isInspected);
					line.classList.toggle("context",!can&&!last&&!isInspected && !(id===inspected.id && (link.source===inspected.state||link.target===inspected.state)));
					line.setAttribute("marker-end",`url(#${can||last||isInspected?"hot-tip":"tip"})`);
				}
			}
		}};
}
