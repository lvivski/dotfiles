/** @param {string[]} keys @param {(id:string)=>HTMLElement} el @param {(key:string)=>void} select */
export function bindTabs(keys,el,select){
	const tabs=keys.map(key=>el(`tab-${key}`));
	tabs.forEach((button,i)=>{
		button.onclick=()=>select(keys[i]);
		button.onkeydown=e=>{
			const n=tabs.length, next=e.key==="Home"?0:e.key==="End"?n-1:e.key==="ArrowLeft"?(i+n-1)%n:e.key==="ArrowRight"?(i+1)%n:-1;
			if(next<0)return;
			e.preventDefault();tabs[next].click();tabs[next].focus();
		};
	});
}
