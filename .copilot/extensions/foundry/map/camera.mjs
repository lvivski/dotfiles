/** @typedef {import("./statechart.mjs").Point} Point */
/** @param {SVGSVGElement} svg @param {SVGGElement} world @param {SVGSVGElement} mini @param {(scale:number)=>void} status */
export function camera(svg,world,mini,status) {
	let width=1,height=1,k=1,x=0,y=0;
	const windowRect=document.createElementNS(svg.namespaceURI,"rect");windowRect.setAttribute("class","mini-window");
	const size=()=>({w:Math.max(1,svg.clientWidth),h:Math.max(1,svg.clientHeight)});
	function paint() {
		const {w,h}=size();
		x=Math.min(w*.8,Math.max(w*.2-width*k,x));y=Math.min(h*.8,Math.max(h*.2-height*k,y));
		world.setAttribute("transform",`translate(${x} ${y}) scale(${k})`);status(k);
		const left=Math.max(0,-x/k),top=Math.max(0,-y/k);
		for(const [s,v] of Object.entries({x:left,y:top,width:Math.min(width,(w-x)/k)-left,height:Math.min(height,(h-y)/k)-top})) windowRect.setAttribute(s,String(v));
	}
	/** @param {Point} p */
	function center(p){const {w,h}=size();x=w/2-k*p.x;y=(h-36)/2-k*p.y;paint();}
	/** @param {number} factor @param {Point} [at] */
	function zoom(factor,at) {
		const {w,h}=size(), p=at??{x:w/2,y:h/2}, next=Math.min(3,Math.max(.08,k*factor));
		x=p.x-(p.x-x)*next/k;y=p.y-(p.y-y)*next/k;k=next;paint();
	}
	function fit() {
		const {w,h}=size();k=Math.max(.02,Math.min((w-24)/width,(h-65)/height,1.2));
		x=(w-width*k)/2;y=(h-40-height*k)/2;
		paint();
	}
	/** @param {Point} p */
	function reveal(p){
		const {w,h}=size(),px=x+p.x*k,py=y+p.y*k;
		if(px<35||px>w-35||py<22||py>h-58)center(p);
	}
	/** @param {MouseEvent} e */
	const point=e=>{const b=svg.getBoundingClientRect();return {x:e.clientX-b.left,y:e.clientY-b.top};};
	/** @type {Map<number,Point>} */ const drags=new Map();
	svg.addEventListener("pointerdown",e=>{
		if(e.button!==0 || e.target instanceof Element && e.target.closest('[role="button"]'))return;
		svg.setPointerCapture(e.pointerId);drags.set(e.pointerId,point(e));svg.classList.add("dragging");
	});
	svg.addEventListener("pointermove",e=>{
		const old=drags.get(e.pointerId);if(!old)return;
		const next=point(e),other=[...drags].find(([id])=>id!==e.pointerId)?.[1];drags.set(e.pointerId,next);
		if(other) {
			const was=Math.hypot(old.x-other.x,old.y-other.y),now=Math.hypot(next.x-other.x,next.y-other.y);
			if(was>0 && now>0)zoom(now/was,{x:(old.x+other.x)/2,y:(old.y+other.y)/2});
		}
		x+=(next.x-old.x)/(other?2:1);y+=(next.y-old.y)/(other?2:1);paint();
	});
	svg.addEventListener("lostpointercapture",e=>{drags.delete(e.pointerId);if(!drags.size)svg.classList.remove("dragging");});
	svg.addEventListener("wheel",e=>{
		e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?svg.clientHeight:1;
		if(e.ctrlKey||e.metaKey)zoom(Math.exp(-e.deltaY*unit*.012),point(e));
		else {x-=e.deltaX*unit;y-=e.deltaY*unit;paint();}
	},{passive:false});
	svg.addEventListener("focusin",e=>{
		if(!(e.target instanceof SVGGraphicsElement) || !e.target.matches('[role="button"]:focus-visible'))return;
		const b=e.target.getBoundingClientRect(),matrix=world.getScreenCTM();
		if(matrix)reveal(new DOMPoint(b.x+b.width/2,b.y+b.height/2).matrixTransform(matrix.inverse()));
	});
	svg.addEventListener("keydown",e=>{
		switch(e.key){case "+":case "=":zoom(1.25);break;case "-":zoom(.8);break;case "0":fit();break;
		case "ArrowLeft":x+=48;break;case "ArrowRight":x-=48;break;case "ArrowUp":y+=48;break;case "ArrowDown":y-=48;break;
		default:return;}e.preventDefault();paint();
	});
	mini.addEventListener("pointerdown",e=>{
		const matrix=mini.getScreenCTM();if(matrix) center(new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()));
	});
	return {zoom,fit,reveal,
		/** @param {Point} point @param {number} [minimum] */ locate(point,minimum=1){k=Math.max(minimum,k);center(point);},
		/** A live topology edit may shift the selected node. Keep its screen position and the
		 * user's zoom unless the caller explicitly wants a new overview.
		 * @param {number} w @param {number} h @param {Point} [shift] */
		bounds(w,h,shift){
			width=w;height=h;mini.setAttribute("viewBox",`-5 -5 ${w+10} ${h+10}`);mini.append(windowRect);
			if(shift){x+=shift.x*k;y+=shift.y*k;paint();}else fit();
			return k;
		}
	};
}
