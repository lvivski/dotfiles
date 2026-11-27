import { bindTabs } from "./tabs.mjs";
/** @typedef {import("./model.mjs").MapSnapshot} Snapshot */
/** @typedef {import("./model.mjs").Assignment} Assignment */
/** @param {string} id */
const el=id=>document.getElementById(id)??(()=>{throw Error(`Missing work graph control: ${id}`);})();
/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [text] @param {string} [cls] */
function html(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
/** @param {string} name */
function icon(name){
	const ns="http://www.w3.org/2000/svg",s=document.createElementNS(ns,"svg"),u=document.createElementNS(ns,"use");
	s.setAttribute("aria-hidden","true");s.setAttribute("class","icon");u.setAttribute("href",`#${name}`);s.append(u);return s;
}
/** @param {HTMLElement} node @param {string} text @param {string} glyph @param {string} tone */
function badge(node,text,glyph,tone){
	node.classList.add("work-badge");node.dataset.tone=tone;node.replaceChildren(icon(glyph),text);return node;
}
/** @param {string} text @param {string} key @param {()=>void} fn */
function link(text,key,fn){
	const b=html("button",text,"work-link");b.type="button";b.dataset.key=key;b.onclick=fn;return b;
}
/** @param {HTMLElement} box @param {string} name @param {string} value */
function fact(box,name,value){const row=html("div",undefined,"fact");row.append(html("dt",name),html("dd",value));box.append(row);}
/** @param {HTMLElement} box @param {()=>void} draw */
function replace(box,draw){
	const scroll=box.scrollTop,focus=box.contains(document.activeElement)&&document.activeElement instanceof HTMLElement?document.activeElement.dataset.key:undefined;
	const open=new Set([...box.querySelectorAll("details[open]")].map(d=>d.getAttribute("data-key")));
	box.replaceChildren();draw();
	for(const d of box.querySelectorAll("details"))if(open.has(d.dataset.key??""))d.open=true;
	if(focus){const next=box.querySelector(`[data-key="${CSS.escape(focus)}"]`);(next instanceof HTMLElement?next:box).focus({preventScroll:true});}
	box.scrollTop=scroll;
}
async function board(){
	const [{workPlot,title},{network,phases,purpose,states}]=await Promise.all([import("./plot.mjs"),import("./network.mjs")]);
	/** @type {Snapshot|undefined} */ let data;
	let work=network([]),selected="",chain=false,last="",busy=false,tab="detail";
	const search=/** @type {HTMLInputElement} */(el("query")),filter=/** @type {HTMLSelectElement} */(el("filter"));
	const svg=/** @type {SVGSVGElement} */(document.querySelector("#diagram")),world=/** @type {SVGGElement} */(document.querySelector("#world"));
	const plot=workPlot(svg,world,/** @type {SVGSVGElement} */(document.querySelector("#overview")),id=>select(id),k=>{el("zoom").textContent=`${Math.round(k*100)}%`;});
	const tabs=["detail","find","proof"];
	/** @param {boolean} open */
	function inspector(open){el("rail").hidden=!open;el("workbench").classList.toggle("chart-only",!open);el("toggle").setAttribute("aria-expanded",String(open));}
	/** @param {string} key */
	function showTab(key){
		tab=key;inspector(true);
		for(const t of tabs){
			el(t).hidden=t!==key;const b=el(`tab-${t}`);b.tabIndex=key===t?0:-1;b.setAttribute("aria-selected",String(key===t));
		}
		if(key==="find")drawFind();
	}
	/** @param {string} id @param {boolean} [locate] */
	function select(id,locate=false){
		if(!work.nodes.has(id))return;
		selected=id;showTab("detail");el("detail").scrollTop=0;drawDetails();drawPlot(chain);
		if(locate)plot.locate(id,true);
		el("announce").textContent=`Selected ${id}.`;
	}
	/** @param {boolean} [fit] */
	function drawPlot(fit=false){
		if(!data||!selected)return;
		const hits=search.value.trim()||filter.value?new Set(work.find(search.value,filter.value).map(n=>n.id)):undefined;
		const g=plot.render(work,selected,chain,hits,fit);
		if(g){
			el("flow").textContent=`${g.visible}${chain?` of ${work.nodes.size}`:""} ${g.visible===1&&!chain?"assignment":"assignments"} · ${g.links} ${g.links===1?"link":"links"}`;
			el("flow").title=g.vertical?"Required output ↓ consumer":"Required output → consumer";
		}
	}
	/** @param {Assignment} n */
	function nodeBadge(n){return badge(html("span"),...states[work.state(n)]);}
	/** @param {string} caption @param {string[]} ids */
	function relations(caption,ids){
		const group=html("section",undefined,"work-section");group.append(html("h3",`${caption} · ${ids.length}`));
		if(!ids.length)group.append(html("p",caption==="Requires"?"No producer outputs declared.":"No visible assignment declares this output.","muted"));
		for(const id of ids){
			const n=work.nodes.get(id);
			if(!n){group.append(html("p",`${id} · outside this view`,"muted"));continue;}
			const b=link(title(id),`${caption}:${id}`,()=>select(id,true));b.append(nodeBadge(n));group.append(b);
		}
		return group;
	}
	/** @param {NonNullable<Assignment["attempts"]>[number]} a */
	function attempt(a){
		const box=html("div",undefined,"attempt"),label=a.kind==="delivery"?"Delivery check":a.kind==="rerun"?"Component rerun":"Component check";
		box.append(html("strong",`${label}: ${a.status}`),html("code",a.check));const dl=html("dl");
		if(a.commit)fact(dl,a.kind==="component"?"Candidate":"Build",a.commit);
		if(a.exit!==undefined&&a.exit!==null)fact(dl,"Exit",String(a.exit));box.append(dl);return box;
	}
	/** @param {Assignment} n */
	function specification(n){
		const d=html("details"),summary=html("summary","Read assigned specification"),body=html("pre");
		d.dataset.key=`spec:${n.id}`;summary.dataset.key=`open:${d.dataset.key}`;d.append(summary,body);
		let loaded=false;
		d.ontoggle=async()=>{
			if(!d.open || loaded)return;loaded=true;body.textContent="Loading pinned text…";
			try{
				const r=await fetch(`./specification/${encodeURIComponent(n.id)}`,{cache:"no-store",signal:AbortSignal.timeout(12000)});
				if(!r.ok)throw Error((await r.text()).trim()||`HTTP ${r.status}`);
				body.textContent=await r.text();
			}catch(e){loaded=false;body.textContent=`Specification unavailable: ${e instanceof Error?e.message:String(e)}. Close and reopen to retry.`;}
		};
		return d;
	}
	function drawDetails(){
		const box=el("detail"),n=work.nodes.get(selected);
		replace(box,()=>{
			if(!n){box.append(html("h2","No assignment selected"),html("p","Select a node to see its inputs, consumers and checks.","muted"));return;}
			box.append(nodeBadge(n),html("h2",title(n.id)),html("p",purpose(n),"task"));
			if(n.specification)box.append(specification(n));
			const trace=work.trace(n.id),missing=work.missing(n),state=work.state(n);
			const why=state==="waiting"?`${missing.length} of ${n.needs.length} required outputs ${missing.length===1?"is":"are"} not confirmed in this view.`:
				state==="queued"?"No declared producer output is pending in this view. Other prerequisites or resources may still be missing.":
				state==="assigned"?"A writer is bound. Session activity is not observed.":
				state==="unconfirmed"?"The launch was issued, but no binding is confirmed. Do not launch another writer.":
				state==="starting"?"No writer binding has been recorded.":
				state==="reviewing"?"The component passed. Its output cannot be used until Rubber Duck approves it.":
				state==="passed"?"The rerun passed on this checkpoint; its output is not integrated or usable by dependents.":
				state==="repeated"?"The checked output did not change the assessed product.":
				state==="qualified"?"Included in a checked product. This is not the run’s release verdict.":"";
			if(n.reason)box.append(html("p",n.reason,"diagnostic"));if(why)box.append(html("p",why,"muted"));
			const traceButton=link(chain?"Show all work":`Trace ${trace.up.size} upstream · ${trace.down.size} downstream`,"lineage",toggleChain);
			traceButton.classList.add("trace-link");box.append(traceButton);
			box.append(relations("Requires",n.needs),relations("Used by",work.children.get(n.id)??[]));
			const details=html("details",undefined,"work-section"), dl=html("dl"),summary=html("summary","Assignment evidence");
			details.dataset.key=`evidence:${n.id}`;summary.dataset.key=`open:${details.dataset.key}`;details.append(summary,dl);
			fact(dl,"ID",n.id);fact(dl,"Scope",n.directory);fact(dl,"Evaluator",n.check);
			if(n.checked)fact(dl,"Checked output",n.checked);
			if(n.result&&!n.attempts?.length){fact(dl,"Last candidate",n.result.commit);fact(dl,"Exit",String(n.result.exit??"unknown"));}
			box.append(details);const latest=n.attempts?.at(-1);
			if(latest && n.attempts){
				box.append(attempt(latest));if(latest.kind==="rerun")box.append(html("p","A rerun does not change assignment or release status.","muted"));
				if(n.attempts.length>1){
					const d=html("details"),summary=html("summary",`Previous attempts (${n.attempts.length-1})`);d.dataset.key=`attempts:${n.id}`;summary.dataset.key=`expand:${n.id}`;
					d.append(summary,...n.attempts.slice(0,-1).reverse().map(attempt));box.append(d);
				}
			}
		});
	}
	function toggleChain(){
		if(!selected)return;chain=!chain;
		el("chain").setAttribute("aria-pressed",String(chain));drawPlot(true);drawDetails();
	}
	function drawFind(){
		const found=work.find(search.value,filter.value);
		el("matches").textContent=`${found.length} of ${work.nodes.size} visible assignments${found.length?"":" · no matches"}`;
		replace(el("results"),()=>{
			for(const n of found){
				const b=link(title(n.id),`result:${n.id}`,()=>select(n.id,true));
				b.title=n.id;b.append(nodeBadge(n),html("code",n.directory));el("results").append(b);
			}
		});
	}
	/** @param {Snapshot} s @param {ReturnType<typeof work.summary>} totals */
	function drawRun(s,totals){
		const box=el("proof");
		replace(box,()=>{
			box.append(html("h2",s.run),html("p",s.direction,"task"));
			const counts=html("div",undefined,"counts");
			for(const {key,text,glyph,tone} of totals){
				const b=link("",`status:${key}`,()=>{search.value="";filter.value=key;showTab("find");drawPlot();filter.focus();});
				counts.append(badge(b,text,glyph,tone));
			}
			box.append(counts);
			if(s.scouting||s.scoutsStarting)box.append(html("p",`Discovery: ${s.scouting} scouting · ${s.scoutsStarting} awaiting start`,"muted"));
			const issues=Number(!!s.blocker)+s.holds.length+s.scoutIssues.length+s.questions.length;
			el("issues").textContent=issues?String(issues):"";el("issues").hidden=!issues;
			for(const [label,rows] of /** @type {const} */([["Run blocker",s.blocker?[s.blocker]:[]],["Pending calls",s.holds],["Discovery issues",s.scoutIssues],["Charter questions",s.questions]])){
				if(rows.length){box.append(html("h3",label,"pane-title"));for(const message of rows)box.append(html("p",message,"diagnostic"));}
			}
			if(!s.owner){box.append(html("p","Participant view. Only your visible assignments and calls are shown.","muted"));return;}
			const r=s.goal?.result,verdict=s.qualified?"Qualified":r?.exit===1?"Gap observed":r?.exit===2?"External evidence missing":
				r?.exit===0?"Goal passed · not yet qualified":r?"Goal check inconclusive":s.goal?"Goal check pending":"No qualified product yet";
			box.append(html("h3","Product evidence","pane-title"),html("strong",verdict));
			const dl=html("dl");if(s.checkpoint)fact(dl,"Checkpoint",s.checkpoint);if(s.goal)fact(dl,"Goal evaluated at",s.goal.commit);
			if(s.qualified)fact(dl,"Qualified",s.qualified);if(r)fact(dl,"Goal exit",String(r.exit??"unknown"));
			if(s.timing){
				fact(dl,"First confirmed writer",s.timing.writerMs!==null?`${(s.timing.writerMs/1000).toFixed(1)} s after activation`:
					s.timing.firstWriter==="not-applicable"?"None required":s.timing.firstWriter==="bound"?"Time unknown":"Not yet confirmed");
				if(s.timing.qualifiedMs!==null)fact(dl,"Time to qualification",`${(s.timing.qualifiedMs/1000).toFixed(1)} s`);
			}
			box.append(dl);if(r?.output)box.append(html("pre",r.output));
		});
	}
	function hideGraph(/** @type {string} */ message){
		data=undefined;work=network([]);plot.clear();selected="";last="";chain=false;search.value="";filter.value="";
		el("workbench").hidden=true;el("notice").textContent=message;el("notice").hidden=false;
		for(const id of ["detail","proof","results","phase","source","run","activity","matches","issues","flow"])el(id).replaceChildren();
		el("run").removeAttribute("title");filter.replaceChildren(new Option("All statuses",""));
		el("scope").textContent="Read only";/** @type {HTMLButtonElement} */(el("toggle")).disabled=true;
	}
	/** @param {Snapshot} s */
	function draw(s){
		const first=!data||data.run!==s.run||data.owner!==s.owner;
		if(first){plot.clear();selected="";chain=false;filter.value="";search.value="";}
		data=s;work=network(s.nodes);
		if(!work.nodes.has(selected)){
			chain=false;selected=(s.nodes.find(n=>n.state==="blocked"||n.state==="unconfirmed")??s.nodes.find(n=>n.state==="assigned")??s.nodes[0])?.id??"";
		}
		el("notice").hidden=true;el("workbench").hidden=false;el("chain").setAttribute("aria-pressed",String(chain));
		el("run").textContent=s.run;el("run").title=s.run;el("source").textContent=s.example?"Example":s.owner?"Live":"Participant";
		badge(el("phase"),s.phase,...phases[s.phase]);
		const counts=work.summary();
		el("activity").replaceChildren(...counts.map(({text,glyph,tone})=>badge(html("li"),text,glyph,tone)));
		el("scope").textContent=s.example?"Example data · not live":s.owner?"Owner view · read only":"Participant view · read only";
		/** @type {HTMLButtonElement} */(el("toggle")).disabled=false;
		/** @type {HTMLButtonElement} */(el("chain")).disabled=!selected;
		const old=filter.value;filter.replaceChildren(new Option("All statuses",""));
		const keys=new Set(counts.map(s=>s.key));
		for(const [k,[name]] of Object.entries(states))if(keys.has(k)||k===old)filter.append(new Option(name,k));filter.value=old;
		if(first)showTab(selected?"detail":"proof");
		el("empty").hidden=!!selected;
		for(const control of document.querySelectorAll(".camera-tools,#overview,.graph-key"))if(control instanceof HTMLElement||control instanceof SVGElement)control.toggleAttribute("hidden",!selected);
		if(!selected){
			plot.clear();el("empty").replaceChildren(html("h2",s.owner?"No assignments yet":"No visible assignments"),
				html("p",s.phase==="Qualified"?"The product qualified without an assignment.":s.scouting||s.scoutsStarting?"Scouts are reviewing the product. Admitted assignments will appear here.":
					s.blocker||s.holds.length||s.scoutIssues.length?"The Run tab has the current diagnostic.":"Assignments appear when they enter the run and are visible to this session."));
		}
		drawDetails();if(tab==="find")drawFind();drawRun(s,counts);drawPlot(first);
	}
	async function refresh(){
		if(busy)return;busy=true;el("refresh").setAttribute("aria-busy","true");
		try{
			const r=await fetch("./state",{cache:"no-store",signal:AbortSignal.timeout(12000)});
			if(!r.ok)throw Error((await r.text()).trim()||`HTTP ${r.status}`);
			const body=await r.text();if(body===last)return;
			const s=JSON.parse(body);if("notice" in s){hideGraph(s.notice);return;}
			draw(s);last=body;
		}catch(e){hideGraph(`Work graph unavailable: ${e instanceof Error?e.message:String(e)}. Refresh to retry.`);}
		finally{busy=false;el("refresh").setAttribute("aria-busy","false");}
	}
	bindTabs(tabs,el,showTab);
	el("refresh").onclick=refresh;el("toggle").onclick=()=>inspector(el("rail").hasAttribute("hidden"));
	el("smaller").onclick=()=>plot.cam.zoom(.8);el("larger").onclick=()=>plot.cam.zoom(1.25);el("fit").onclick=()=>plot.cam.fit();
	el("locate").onclick=()=>plot.locate(selected,true);el("chain").onclick=toggleChain;
	search.oninput=()=>{showTab("find");drawPlot();};
	filter.onchange=()=>{drawFind();drawPlot();};
	search.onkeydown=e=>{if(e.key==="Enter"){const first=work.find(search.value,filter.value)[0];if(first){e.preventDefault();select(first.id,true);}}};
	document.addEventListener("keydown",e=>{if(e.key==="/" && data && !e.ctrlKey&&!e.metaKey&&!e.altKey && !(e.target instanceof HTMLInputElement||e.target instanceof HTMLSelectElement)){
		e.preventDefault();showTab("find");search.focus();search.select();
	}});
	new ResizeObserver(()=>drawPlot()).observe(svg);
	const live=()=>{if(!document.hidden&&!data?.example)void refresh();};
	document.addEventListener("visibilitychange",live);window.setInterval(live,5000);
	await refresh();
}
board().catch(e=>{el("notice").hidden=false;el("notice").textContent=`Work graph could not load: ${String(e)}. Reload the extension in this session and reopen the panel.`;});
