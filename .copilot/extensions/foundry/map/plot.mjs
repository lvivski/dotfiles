import {camera} from "./camera.mjs";
import {layout,wirePath} from "./layout.mjs";
import {purpose,states} from "./network.mjs";
import {button,shape} from "./svg.mjs";

/** @typedef {ReturnType<typeof import("./network.mjs").network>} Work */
/** @param {string} id */
export const title=id=>id.replace(/[-_]+/g," ").replace(/^./,s=>s.toUpperCase());

/** @param {SVGSVGElement} svg @param {SVGGElement} world @param {SVGSVGElement} mini
 * @param {(id:string)=>void} select @param {(scale:number)=>void} scale */
export function workPlot(svg,world,mini,select,scale) {
	const cam=camera(svg,world,mini,scale);
	let key="";
	/** @type {ReturnType<typeof layout>|undefined} */ let scene;
	/** @type {Map<string,ReturnType<typeof card>>} */ const cards=new Map();
	/** @type {{from:string,to:string,path:SVGPathElement,tip:SVGTitleElement}[]} */ let wires=[];

	/** @param {string} id @param {number} x @param {number} y @param {number} w @param {number} h */
	function card(id,x,y,w,h){
		const g=shape("g",{class:"job","data-id":id,transform:`translate(${x} ${y})`}),tip=shape("title",{});
		const caption=shape("text",{class:"job-status",x:31,y:20}),inputs=shape("text",{class:"job-inputs",x:w-10,y:20,"text-anchor":"end"}),symbol=shape("use",{});
		const icon=shape("svg",{x:12,y:8,width:14,height:14,viewBox:"0 0 24 24",class:"job-symbol","aria-hidden":"true"});icon.append(symbol);
		const content=shape("svg",{x:12,y:29,width:w-24,height:44,overflow:"hidden"});
		const label=shape("text",{class:"job-name",y:15}),sub=shape("text",{class:"job-sub",y:34});
		content.append(label,sub);
		g.append(tip,shape("rect",{class:"job-box",width:w,height:h,rx:7}),icon,caption,inputs,content);
		button(g,`Inspect ${id}`,()=>select(id));
		const thumb=shape("rect",{class:"mini-job",x,y,width:w,height:h,rx:4});
		return {g,thumb,caption,inputs,label,sub,tip,symbol,point:{x:x+w/2,y:y+h/2}};
	}
	function clear(){
		key="";scene=undefined;cards.clear();wires=[];world.replaceChildren();mini.replaceChildren();
	}
	return {cam,clear,
		/** @param {string} id @param {boolean} [focus] */
		locate(id,focus=false){const c=cards.get(id);if(c){cam.locate(c.point);if(focus)c.g.focus({preventScroll:true});}},
		/** @param {Work} work @param {string} selected @param {boolean} chain @param {Set<string>|undefined} hits @param {boolean} [fit] */
		render(work,selected,chain,hits,fit=false) {
			if(!svg.clientWidth||!svg.clientHeight)return;
			const trace=work.trace(selected),shown=[...work.nodes.values()].filter(n=>!chain||trace.ids.has(n.id)).sort((a,b)=>a.id.localeCompare(b.id));
			const signature=JSON.stringify([svg.clientWidth,svg.clientHeight,shown.map(n=>[n.id,[...n.needs].sort()])]);
			if(signature!==key || !scene){
				const old=cards.get(selected)?.point,focus=document.activeElement?.closest(".job")?.getAttribute("data-id");
				clear();scene=layout(shown,svg.clientWidth,svg.clientHeight);key=signature;
				for(const {from,to,points} of scene.edges){
					const d=wirePath(points,scene.vertical),path=shape("path",{class:"dep",d,"data-from":from,"data-to":to}),tip=shape("title",{});
					path.append(tip);world.append(path);mini.append(shape("path",{class:"mini-wire",d}));wires.push({from,to,path,tip});
				}
				for(const n of scene.boxes){
					const c=card(n.id,n.x,n.y,scene.w,scene.h);cards.set(n.id,c);world.append(c.g);mini.append(c.thumb);
				}
				const pos=cards.get(selected)?.point;
				cam.bounds(scene.width,scene.height,!fit&&old&&pos?{x:old.x-pos.x,y:old.y-pos.y}:undefined);
				if(focus)(cards.get(focus)??cards.get(selected))?.g.focus({preventScroll:true});
			}else if(fit)cam.fit();
			for(const [id,c] of cards){
				const n=work.nodes.get(id);if(!n)continue;
				const state=work.state(n), [name,glyph,tone]=states[state];
				c.g.dataset.tone=c.thumb.dataset.tone=tone;c.g.dataset.state=state;
				c.g.classList.toggle("selected",id===selected);c.thumb.classList.toggle("selected",id===selected);
				c.g.classList.toggle("no-match",!!hits&&!hits.has(id));c.thumb.classList.toggle("no-match",!!hits&&!hits.has(id));
				c.g.setAttribute("aria-pressed",String(id===selected));c.g.setAttribute("aria-label",`${id}: ${name}. ${n.directory}`);
				c.g.setAttribute("aria-description",purpose(n));
				const ready=n.needs.length-work.missing(n).length;
				c.inputs.textContent=n.needs.length?`${ready}/${n.needs.length}`:"";
				c.tip.textContent=`${id}\n${purpose(n)}\n${name} · ${n.directory}${n.needs.length?`\n${ready} of ${n.needs.length} required outputs confirmed in this view`:""}`;c.symbol.setAttribute("href",`#${glyph}`);
				c.caption.textContent=state==="passed"?"Rerun passed":name;
				const words=title(id).split(" ");let line=words.shift()??"";
				const limit=Math.floor((scene.w-24)/7.6);
				while(words.length && line.length+1+words[0].length<=limit)line+=" "+words.shift();
				c.label.textContent=line.length>limit?line.slice(0,limit-1)+"…":line;
				const tail=words.length?words.join(" "):n.directory;
				c.sub.textContent=tail.length>limit+2?tail.slice(0,limit+1)+"…":tail;c.sub.classList.toggle("continued",words.length>0);
			}
			for(const {from,to,path,tip} of wires){
				const source=work.nodes.get(from);if(!source)continue;
				const upstream=trace.up.has(from)&&(to===selected||trace.up.has(to));
				const downstream=trace.down.has(to)&&(from===selected||trace.down.has(from));
				const tone=source.state==="blocked"?"stop":upstream||downstream?"accent":"base";
				path.classList.toggle("pending",!source.checked);path.dataset.trace=upstream?"up":downstream?"down":"";
				path.dataset.tone=tone;path.setAttribute("marker-end",`url(#dep-${tone})`);
				tip.textContent=`${from} → ${to} · ${source.checked?"checked input":"awaiting checked input"}`;
			}
			return {visible:cards.size,links:wires.length,vertical:scene.vertical};
		}};
}
