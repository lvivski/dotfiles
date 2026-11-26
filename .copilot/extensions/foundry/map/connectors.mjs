/** @typedef {{x:number,y:number}} Point */
/** @typedef {{start:Point,segments:({to:Point,controls?:[Point]|[Point,Point]})[]}} Path */

/** Soft, monotone work dependencies. Keep each span in its ranked channel.
 * @param {Point[]} points @param {boolean} vertical @returns {Path} */
export function connector(points,vertical){
	const u=vertical?"y":"x",v=vertical?"x":"y";
	const pts=points.filter((p,i)=>!i || p.x!==points[i-1].x || p.y!==points[i-1].y);
	const slopes=pts.slice(1).map((p,i)=>(p[v]-pts[i][v])/(p[u]-pts[i][u]));
	const tangents=[0];
	for(let i=1;i<slopes.length;i++){
		const a=slopes[i-1],b=slopes[i];tangents.push(a*b>0?2/(1/a+1/b):0);
	}
	/** @type {Path} */ const path={start:pts[0],segments:[]};
	for(let i=1;i<pts.length;i++){
		const a=pts[i-1],b=pts[i],run=b[u]-a[u],s=slopes[i-1];
		const p={...a,[u]:a[u]+run/3,[v]:a[v]+tangents[i-1]*run/3};
		const final=i===pts.length-1;
		if(final){
			// Leave a straight shaft under the arrowhead. Limit grazing approaches
			// so neither wing is buried in the destination card.
			const slope=Math.max(-2,Math.min(2,s));
			const d=Math.sign(run)*Math.min(Math.abs(run)*.35,18/Math.hypot(1,slope));
			const end={...b,[u]:b[u]-d,[v]:b[v]-d*slope};
			const q={...b,[u]:b[u]-run/2,[v]:b[v]-run*slope/2};
			path.segments.push({controls:[p,q],to:end},{to:b});
		}else{
			const q={...b,[u]:b[u]-run/3,[v]:b[v]-tangents[i]*run/3};
			path.segments.push({controls:[p,q],to:b});
		}
	}
	return path;
}

/** Round a tight fold without cutting through its event label, changing the
 * direction of the final shaft, or turning a self-loop into a chart-wide arc.
 * @param {Point[]} points @param {Point} label @param {(a:Point,p:Point,b:Point)=>boolean} clear
 * @param {ReadonlyMap<Point,number>} [trims] @returns {Path} */
export function fillets(points,label,clear,trims){
	const pts=points.filter((p,i)=>!i||p.x!==points[i-1].x||p.y!==points[i-1].y);
	/** @type {Path} */ const path={start:pts[0],segments:[]};
	for(let i=1;i<pts.length-1;i++){
		const a=pts[i-1],p=pts[i],b=pts[i+1];
		const before=Math.hypot(a.x-p.x,a.y-p.y),after=Math.hypot(b.x-p.x,b.y-p.y);
		if(p.x===label.x&&p.y===label.y){path.segments.push({to:p});continue;}
		if(Math.abs((p.x-a.x)*(b.y-p.y)-(p.y-a.y)*(b.x-p.x))<1e-7)continue;
		let r=Math.min(trims?.get(p)??9,before*.45,after*.45);
		for(;;r/=2){
			if(r<.125){path.segments.push({to:p});break;}
			const l={x:p.x+(a.x-p.x)*r/before,y:p.y+(a.y-p.y)*r/before},h={x:p.x+(b.x-p.x)*r/after,y:p.y+(b.y-p.y)*r/after};
			if(clear(l,p,h)){path.segments.push({to:l},{controls:[p],to:h});break;}
		}
	}
	path.segments.push({to:pts[pts.length-1]});return path;
}

/** @param {Path} path */
export function pathData({start,segments}){
	return `M${start.x} ${start.y}`+segments.map(({controls,to})=>controls?.length===2?
		` C${controls[0].x} ${controls[0].y} ${controls[1].x} ${controls[1].y} ${to.x} ${to.y}`:
		controls?` Q${controls[0].x} ${controls[0].y} ${to.x} ${to.y}`:` L${to.x} ${to.y}`).join("");
}
