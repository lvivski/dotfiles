/** @typedef {import("./model.mjs").Assignment} Assignment */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{x:number,y:number,count:number}} Level */
/** @param {string[][]} ranks @param {{from:string,to:string}[]} routes @param {number} width */
function wrapped(ranks, routes, width) {
	const pad = Math.min(16, Math.floor(width / 6)), gap = 16, h = 56;
	const columns = Math.max(1, Math.floor((width - 2 * pad + gap) / (144 + gap)));
	const w = Math.floor((width - 2 * pad - (columns - 1) * gap) / columns);
	/** @type {Level[]} */ const levels = [];
	/** @type {Map<string,{id:string,x:number,y:number}>} */ const positions = new Map();
	let top = 12;
	for (const ids of ranks) {
		levels.push({ x: pad, y: top, count: ids.length }); top += 30;
		ids.forEach((id, i) => positions.set(id, { id, x: pad + i % columns * (w + gap),
			y: top + Math.floor(i / columns) * (h + gap) }));
		top += Math.ceil(ids.length / columns) * (h + gap) + 6;
	}
	const edges = routes.map(({ from, to }) => {
		const a = positions.get(from), b = positions.get(to);
		if (!a || !b) throw new Error("Missing assignment position");
		// Travel between columns, then enter above the target, never through a wrapped peer.
		const ax = a.x + w / 2, ay = a.y + h, bx = b.x + w / 2, by = b.y - 3;
		const lane = Math.max(1, a.x - gap / 2);
		return { from, to, d: `M${ax},${ay} v6 H${lane} V${b.y - 8} H${bx} V${by}`, arrow: `M${bx - 3},${by - 4} l3,4 3,-4` };
	});
	return { width, height: top, vertical: true, w, h, levels, edges, boxes: [...positions.values()] };
}

/** @param {Assignment[]} nodes @param {number} available */
export function layout(nodes, available) {
	const byId = new Map(nodes.map(n => [n.id, n]));
	const parents = new Map(nodes.map(n => [n.id, n.needs.filter(id => byId.has(id))]));
	/** @type {Map<string,string[]>} */ const children = new Map(nodes.map(n => [n.id, []]));
	for (const [id, needs] of parents) for (const p of needs) children.get(p)?.push(id);

	const remaining = new Map([...parents].map(([id, needs]) => [id, needs.length]));
	const queue = nodes.filter(n => !remaining.get(n.id)).map(n => n.id);
	/** @type {Map<string,number>} */ const depth = new Map();
	/** @type {string[][]} */ const ranks = [];
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i], rank = depth.get(id) ?? 0;
		(ranks[rank] ??= []).push(id);
		for (const child of children.get(id) ?? []) {
			depth.set(child, Math.max(depth.get(child) ?? 0, rank + 1));
			const count = (remaining.get(child) ?? 1) - 1;
			remaining.set(child, count);
			if (!count) queue.push(child);
		}
	}
	if (queue.length !== nodes.length) throw new Error("The assignments contain a dependency cycle.");

	// Give long edges their own lane at each intervening rank.
	/** @type {{from:string,to:string,via:string[]}[]} */ const routes = [];
	/** @type {Map<string,string[]>} */ const inbound = new Map(), outbound = new Map();
	for (const [to, needs] of parents) for (const from of needs) {
		const via = [from];
		for (let r = (depth.get(from) ?? 0) + 1; r < (depth.get(to) ?? 0); r++) {
			const hop = `${from}/${to}/${r}`;
			ranks[r].push(hop); via.push(hop);
		}
		via.push(to); routes.push({ from, to, via });
		for (let i = 1; i < via.length; i++) {
			const a = via[i - 1], b = via[i];
			if (!inbound.has(b)) inbound.set(b, []);
			if (!outbound.has(a)) outbound.set(a, []);
			inbound.get(b)?.push(a); outbound.get(a)?.push(b);
		}
	}
	// Order a rank near its neighbors to reduce crossings. Ties retain their previous order.
	/** @param {string[][]} levels @param {Map<string,string[]>} neighbors */
	function align(levels, neighbors) {
		const position = new Map();
		for (const ids of levels) {
			const score = new Map(ids.map((id, i) => {
				const near = neighbors.get(id);
				return [id, near ? near.reduce((sum, n) => sum + position.get(n), 0) / near.length : i];
			}));
			ids.sort((a, b) => Number(score.get(a)) - Number(score.get(b)));
			ids.forEach((id, i) => position.set(id, i));
		}
	}
	align(ranks, inbound); align(ranks.toReversed(), outbound);

	const vertical = available < 660, pad = vertical ? 12 : 26, gap = vertical ? 14 : 22;
	const w = vertical ? Math.max(116, Math.min(180, Math.floor((available - 2 * pad - 2 * gap - 4) / 2)))
		: Math.max(145, Math.min(204, Math.floor((available - 2 * pad - 100) / 3)));
	const h = 64, step = vertical ? h + 48 : w + 56;
	/** @param {string} id */
	const size = id => byId.has(id) ? vertical ? w : h : 4;
	const spans = ranks.map(ids => ids.reduce((n, id) => n + size(id), 0) + (ids.length - 1) * gap);
	const cross = Math.max(vertical ? available : 188, ...spans.map(s => s + 2 * pad));
	if (vertical && cross > available) return wrapped(ranks.map(ids => ids.filter(id => byId.has(id))), routes, available);
	const along = Math.max(vertical ? 0 : available, 2 * pad + (ranks.length - 1) * step + (vertical ? h : w));
	const start = (along - (ranks.length - 1) * step) / 2;
	/** @type {Map<string,Point>} */ const centers = new Map();
	for (const [r, ids] of ranks.entries()) {
		let at = (cross - spans[r]) / 2;
		for (const id of ids) {
			const c = at + size(id) / 2, a = start + r * step;
			centers.set(id, vertical ? { x: c, y: a } : { x: a, y: c }); at += size(id) + gap;
		}
	}
	/** @param {string} id */
	const center = id => { const p = centers.get(id); if (!p) throw new Error("Missing assignment position"); return p; };
	/** @param {string} id @param {number} end */
	const port = (id, end) => {
		const { x, y } = center(id);
		return vertical ? { x, y: y + end } : { x: x + end, y };
	};
	const half = (vertical ? h : w) / 2;
	const edges = routes.map(({ from, to, via }) => {
		const a = port(from, half), b = port(to, -half - 3);
		const pts = [a, ...via.slice(1, -1).flatMap(id => [port(id, -half), port(id, half)]), b];
		let d = `M${a.x},${a.y}`;
		for (let i = 1; i < pts.length; i++) {
			const p = pts[i - 1], q = pts[i], mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
			d += vertical ? ` C${p.x},${my} ${q.x},${my} ${q.x},${q.y}` : ` C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}`;
		}
		const arrow = vertical ? `M${b.x - 3},${b.y - 4} l3,4 3,-4` : `M${b.x - 4},${b.y - 3} l4,3 -4,3`;
		return { from, to, d, arrow };
	});
	return { width: vertical ? cross : along, height: vertical ? along : cross, vertical, w, h, edges, levels: /** @type {Level[]} */ ([]),
		boxes: ranks.flat().filter(id => byId.has(id)).map(id => ({ id, x: center(id).x - w / 2, y: center(id).y - h / 2 })) };
}
