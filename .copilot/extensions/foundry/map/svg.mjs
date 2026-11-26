/** @template {keyof SVGElementTagNameMap} K @param {K} tag @param {Record<string,string|number>} attrs @param {string} [text] */
export function shape(tag,attrs,text) {
	const el=document.createElementNS("http://www.w3.org/2000/svg",tag);
	for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));
	if(text!==undefined)el.textContent=text;
	return el;
}
/** @param {SVGGElement} g @param {string} name @param {()=>void} invoke */
export function button(g,name,invoke) {
	g.setAttribute("role","button");g.setAttribute("tabindex","0");g.setAttribute("aria-label",name);
	g.addEventListener("click",invoke);
	g.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();invoke();}});
}

