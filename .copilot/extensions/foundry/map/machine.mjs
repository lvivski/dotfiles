export {};
/** @typedef {import("./statechart.mjs").Model} Model */
/** @typedef {import("./statechart.mjs").Transition} Transition */
/** @param {string} id */
const el=id=>document.getElementById(id) ?? (()=>{throw Error(`Missing studio control: ${id}`);})();
/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [text] @param {string} [cls] */
function html(tag,text,cls) {
	const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(cls)element.className=cls;return element;
}
/** @param {string} text @param {string} cls @param {string} key @param {()=>void} fn */
function control(text,cls,key,fn) {
	const b=html("button",text,cls);b.type="button";b.dataset.key=key;b.onclick=fn;return b;
}
/** @param {Record<string,string>} states */
const configuration=states=>Object.entries(states).map(([id,s])=>`${id}.${s}`).join(" ∥ ");

/** @param {{machines:Record<string,Model>,groups:string[][]}} definitions */
async function studio({machines,groups}) {
	const [{camera},{drawChart},{simulate}]=await Promise.all([import("./camera.mjs"),import("./drawing.mjs"),import("./simulation.mjs")]);
	const picker=/** @type {HTMLSelectElement} */(el("machine")),pane=el("pane");
	const svg=/** @type {SVGSVGElement} */(document.querySelector("#diagram")),world=/** @type {SVGGElement} */(document.querySelector("#world"));
	const mini=/** @type {SVGSVGElement} */(document.querySelector("#overview"));
	const cam=camera(svg,world,mini,k=>{el("zoom").textContent=`${Math.round(k*100)}%`;});
	let region=Object.hasOwn(machines,"activity")?"activity":Object.keys(machines)[0], tab="state", signal="", sender="";
	/** @type {Map<string,ReturnType<typeof simulate>>} */ const sessions=new Map();
	const members=()=>groups.find(g=>g.includes(region)) ?? [region];
	function session(){
		const group=members(), key=JSON.stringify(group), prior=sessions.get(key);
		if(prior)return prior;
		const created=simulate(group.map(id=>machines[id]));sessions.set(key,created);return created;
	}
	let selectedState=session().current().states[region];
	/** @type {Transition|undefined} */ let inspectedLink;
	/** @type {ReturnType<typeof drawChart>|undefined} */ let drawing;
	const announce=/** @param {string} message */ message=>{el("announce").textContent=message;};
	function alignSignal(){
		const events=machines[region].states[selectedState].map(e=>e.on);
		if(!events.includes(signal))signal=events[0]??"";
	}
	/** @param {string} id @param {string} state @param {Transition} [link] */
	function inspect(id,state,link) {
		showInspector(true);
		region=id;picker.value=id;selectedState=state;inspectedLink=link;signal=link?.signal??"";alignSignal();tab="state";pane.scrollTop=0;render();
	}
	/** @param {string} id @param {Transition} e @param {ReturnType<ReturnType<typeof simulate>["preview"]>} steps */
	function matches(id,e,steps) {
		return steps.some(s=>s.region===id && s.from===e.source && e.rules.some(i=>machines[id].states[e.source][i]===s.edge));
	}
	function follow() {
		inspectedLink=undefined;selectedState=session().current().states[region];alignSignal();render();
		const p=drawing?.point(region,selectedState);if(p)cam.reveal(p);
	}
	/** @param {string} on */
	function send(on) {
		const sim=session();sim.send(on);
		const f=sim.current();
		announce(f.changes.length?`${on}: ${configuration(f.states)}`:`${on} was ignored.`);follow();
	}
	/** @param {string} id @param {Transition} e */
	function onTransition(id,e) {
		if(!matches(id,e,session().preview(e.signal)))return inspect(id,e.source,e);
		region=id;picker.value=id;signal=e.signal;send(e.signal);
	}
	function rebuild() {
		const {width,height}=svg.getBoundingClientRect();if(!width||!height)return;
		drawing=drawChart(world,mini,members().map(id=>machines[id]),Math.max(1,width-24),Math.max(1,height-65),inspect,onTransition);
		const fit=cam.bounds(drawing.width,drawing.height),point=drawing.point(region,selectedState);
		// Preserve a compact overview of a small region; open a dense chart at
		// a readable local scale with space to see its neighboring lanes.
		const small=members().reduce((n,id)=>n+Object.keys(machines[id].states).length,0)<=5;
		if(fit<(small ? .60 : .82) && point)cam.locate(point,.82);
		render();
	}
	/** @param {number} i */
	function seek(i){session().seek(i);announce(`Step ${i}: ${configuration(session().current().states)}`);follow();}
	function choose(){
		region=picker.value;selectedState=session().current().states[region];inspectedLink=undefined;signal="";sender="";alignSignal();pane.scrollTop=0;rebuild();
	}
	function statePanel(){
		const sim=session(), frame=sim.current(), rules=machines[region].states[selectedState], active=frame.states[region]===selectedState;
		const header=html("div",undefined,"state-heading"),picker=html("select",undefined,"state-picker");
		picker.setAttribute("aria-label",`Inspect state in ${region}`);picker.dataset.key="pick-state";
		for(const state of Object.keys(machines[region].states))picker.append(new Option(state,state));
		picker.value=selectedState;picker.onchange=()=>{
			const state=picker.value;inspect(region,state);const p=drawing?.point(region,state);if(p)cam.locate(p);
		};
		header.append(html("h2",selectedState,"sr-only"),picker,html("span",active?"Active":"Inspecting",active?"active-tag":"inactive-tag"));
		pane.append(header,html("p",machines[region].info?.states[selectedState]??"No state purpose supplied.","purpose"));
		if(!active)pane.append(html("p",`${region} · active state: ${frame.states[region]}`,"subcopy"));
		if(!active)pane.append(control("Set as test state","plain","seed",()=>{sim.seed(region,selectedState);follow();announce(`Simulation set to ${region}.${selectedState}`);}));
		const names=[...new Set(rules.map(e=>e.on))];
		pane.append(html("h3","Outgoing events","pane-title"));
		if(!names.length)pane.append(html("p","No outgoing events in this state.","pane-help"));
		for(const name of names) {
			const row=html("div",undefined,"event-line"), pick=control(name,"event-choice",`event:${name}`,()=>{inspectedLink=undefined;signal=name;render();});
			pick.setAttribute("aria-pressed",String(name===signal));pick.title=`Inspect rules for ${name}`;
			const fire=control("▶","send",`fire:${name}`,()=>send(name));
			fire.disabled=!active || !sim.preview(name).some(s=>s.region===region);
			fire.setAttribute("aria-label",`Send ${name}`);fire.title=fire.disabled?"Not enabled in the current configuration":`Send ${name}`;
			row.append(pick,fire);pane.append(row);
		}
		if(!signal)return;
		const options=rules.filter(e=>e.on===signal), selected=sim.preview(signal);
		const winning=active?selected.find(s=>s.region===region)?.edge:undefined;
		const inspected=inspectedLink?.rules.map(i=>rules[i]);
		const candidates=inspected??options;
		const primary=candidates.find(e=>e===winning)??(candidates.length===1?candidates[0]:undefined);
		pane.append(html("h3",`On ${signal}`,"pane-title"));
		if(inspected)pane.append(html("p","Inspected branch","pane-help"));
		pane.append(html("p",primary?(primary.description??primary.reason??"No transition purpose supplied."):
			`${candidates.length} possible outcomes. Inspect the ordered rules to see when each applies.`,"purpose"));
		const field=html("fieldset",undefined,"facts");field.append(html("legend","Guard inputs"));
		for(const id of members()){
			const at=id===region?selectedState:frame.states[id], edges=machines[id].states[at].filter(e=>e.on===signal);
			for(const fact of new Set(edges.flatMap(e=>(e.when??[]).map(s=>s.replace(/^!/,""))))) {
				const label=html("label"), box=html("input");box.type="checkbox";box.name=fact;box.dataset.key=`guard:${id}:${fact}`;
				box.checked=sim.inputs()[id][fact];box.onchange=()=>{sim.setFact(id,fact,box.checked);render();};
				label.append(box,id===region?fact:`${id}.${fact}`);field.append(label);
			}
		}
		if(field.childElementCount>1)pane.append(field);
		const disclosure=html("details"),summary=html("summary",`Ordered rules (${options.length})`),list=html("ol",undefined,"rule-list");
		disclosure.dataset.key=`rules:${region}:${selectedState}:${signal}`;summary.dataset.key=`open:${disclosure.dataset.key}`;
		for(const e of options) {
			const wins=e===winning,row=html("li",undefined,wins?"wins":"");
			row.append(html("span",(wins?"● ":"")+(e.when?.length?`[${e.when.join(" & ")}] `:"")+`→ ${e.target??"(stay)"}`),
				html("p",e.description??e.reason??"No transition purpose supplied.","pane-help"));
			const detail=[inspected?.includes(e)&&"Inspected branch",e.update&&`Context update: ${e.update}`,e.action&&`Queued effect: ${e.action}`,
				e.fork&&`Parallel events: ${e.fork.join(", ")}`,e.admission&&`Admission: ${e.admission}`,e.description && e.reason].filter(Boolean).join(" · ");
			if(detail)row.append(html("small",detail));
			if(wins)row.setAttribute("aria-current","true");list.append(row);
		}
		disclosure.append(summary,list);pane.append(disclosure);
		const peers=selected.filter(s=>s.region!==region);
		if(peers.length)pane.append(html("p","In parallel: "+peers.map(s=>`${s.region}.${s.to}${s.edge.action?` / ${s.edge.action}`:""}`).join("; "),"pane-help"));
	}
	function eventsPanel(){
		const sim=session(), options=[...new Set(members().flatMap(id=>Object.values(machines[id].states).flat().map(e=>e.on)))];
		pane.append(html("h2","Events"),html("p","Send an event or return to a recorded step. Sending from an earlier step starts a new branch.","subcopy"));
		const group=html("div",undefined,"pane-actions"), menu=html("select");menu.setAttribute("aria-label","Event to send");menu.dataset.key="sender";
		for(const on of options)menu.append(new Option(on,on));
		menu.value=options.includes(sender)?sender:options[0];menu.onchange=()=>{sender=menu.value;};
		const fire=control("Send","plain","send",()=>send(menu.value));fire.disabled=!options.length;
		group.append(menu,fire);pane.append(group,html("h3","Event log","pane-title"));
		const log=html("ol",undefined,"event-log");
		sim.history.forEach((f,i)=>{
			const row=html("li"),b=control(`${i}  ${f.label}`,"history-row",`step:${i}`,()=>seek(i));
			b.append(html("small",f.changes.length ? f.changes.map(s=>`${s.region}: ${s.from} → ${s.to}${s.edge.action?` / ${s.edge.action}`:""}${s.fork.length?` · fork: ${s.fork.join(" ∥ ")}`:""}`).join("; ") : configuration(f.states)+(i&&!f.label.startsWith("Set ")?" · ignored":"")));
			if(i===sim.index())b.setAttribute("aria-current","step");row.append(b);log.append(row);
		});pane.append(log);
	}
	function definitionPanel(){
		pane.append(html("h2",region),html("p",machines[region].info?.description??"No machine purpose supplied.","purpose"),
			html("p","Projected from the running definition. Simulation never writes the ledger or executes effects.","subcopy"));
		const pre=html("pre",undefined,"definition"),source=JSON.stringify(machines[region],null,2);
		for(const token of source.split(/("(?:[^"\\]|\\.)*"(?=:))/g)){
			if(token.startsWith('"'))pre.append(html("span",token,"key"));else pre.append(token);
		}
		pane.append(pre);
	}
	const tabs=["state","events","definition"];
	function render(){
		const sim=session(),frame=sim.current(),memo=new Map();
		drawing?.highlight(frame.states,{id:region,state:selectedState,link:inspectedLink},(id,e)=>{
			if(!memo.has(e.signal))memo.set(e.signal,sim.preview(e.signal));
			return matches(id,e,memo.get(e.signal));
		},(id,e)=>matches(id,e,frame.changes));
		const focus=pane.contains(document.activeElement)&&document.activeElement instanceof HTMLElement?document.activeElement.dataset.key:undefined;
		const scroll=pane.scrollTop,expanded=pane.querySelector("details[open]")?.getAttribute("data-key");pane.replaceChildren();
		for(const t of tabs){const b=el(`tab-${t}`);b.tabIndex=tab===t?0:-1;b.setAttribute("aria-selected",String(tab===t));}
		pane.setAttribute("aria-labelledby",`tab-${tab}`);
		if(tab==="state")statePanel();else if(tab==="events")eventsPanel();else definitionPanel();
		const details=pane.querySelector("details");if(details && expanded===details.dataset.key)details.open=true;
		el("event-count").textContent=String(sim.history.length-1);el("step-number").textContent=`Step ${sim.index()} of ${sim.history.length-1}`;
		el("configuration").textContent=configuration(frame.states);
		for(const [id,disabled] of /** @type {const} */([["back",sim.index()===0],["forward",sim.index()===sim.history.length-1],["reset",sim.history.length===1 && sim.inputs()===frame.inputs]]))
			/** @type {HTMLButtonElement} */(el(id)).disabled=disabled;
		if(focus){
			const replacement=pane.querySelector(`[data-key="${CSS.escape(focus)}"]`);
			(replacement instanceof HTMLElement && !replacement.matches(":disabled")?replacement:pane).focus({preventScroll:true});
		}
		pane.scrollTop=scroll;
	}
	for(const t of tabs){
		const b=el(`tab-${t}`);
		b.onclick=()=>{tab=t;pane.scrollTop=0;render();};
		b.onkeydown=e=>{const i=tabs.indexOf(t);
			const next=e.key==="Home"?0:e.key==="End"?tabs.length-1:e.key==="ArrowRight"?(i+1)%tabs.length:e.key==="ArrowLeft"?(i+tabs.length-1)%tabs.length:-1;
			if(next<0)return;e.preventDefault();const target=el(`tab-${tabs[next]}`);target.click();target.focus();
		};
	}
	el("smaller").onclick=()=>cam.zoom(.8);el("larger").onclick=()=>cam.zoom(1.25);el("fit").onclick=()=>cam.fit();
	el("locate").onclick=()=>{const p=drawing?.point(region,session().current().states[region]);if(p)cam.locate(p);};
	function showInspector(open=el("inspector-panel").hidden) {
		el("inspector-panel").hidden=!open;el("workbench").classList.toggle("chart-only",!open);
		el("inspector-toggle").setAttribute("aria-expanded",String(open));
	}
	el("inspector-toggle").onclick=()=>showInspector();
	el("back").onclick=()=>seek(session().index()-1);el("forward").onclick=()=>seek(session().index()+1);
	el("reset").onclick=()=>{session().reset();follow();announce("Simulation reset to its initial state.");};
	for(const [id,m] of Object.entries(machines)){const option=new Option(id,id);option.title=m.info?.description??id;picker.append(option);}
	picker.value=region;picker.disabled=false;picker.onchange=choose;alignSignal();
	el("notice").hidden=true;el("workbench").hidden=false;new ResizeObserver(rebuild).observe(svg);rebuild();
}
try {
	el("return-to-work").hidden=new URL(location.href).searchParams.get("from")!=="run";
	const response=await fetch("./machines");if(!response.ok)throw Error(`HTTP ${response.status}`);
	await studio(await response.json());
} catch(error){el("workbench").hidden=true;el("notice").hidden=false;el("notice").textContent=`State explorer could not load: ${String(error)}. Reload the Foundry extension in this session, then reopen the panel.`;}
