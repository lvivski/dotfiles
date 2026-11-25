import assert from "node:assert/strict";
import test from "node:test";
import { layout } from "./layout.mjs";
import { example } from "./model.mjs";

test("a fork and join keep the same real edges in both orientations, including a skipped rank", () => {
	for (const width of [340, 900]) {
		const g = layout(example.nodes, width), axis = g.vertical ? "y" : "x";
		const boxes = new Map(g.boxes.map(n => [n.id, n]));
		assert.equal(g.width, width);
		assert.equal(g.vertical, width < 660);
		assert.deepEqual(g.edges.map(e => `${e.from}/${e.to}`).sort(), example.nodes.flatMap(n => n.needs.map(id => `${id}/${n.id}`)).sort());
		for (const edge of g.edges) assert.ok(Number(boxes.get(edge.from)?.[axis]) < Number(boxes.get(edge.to)?.[axis]));
		assert.equal(boxes.get("file-reader")?.[axis], boxes.get("csv-format")?.[axis]);
	}
	const partial = layout(example.nodes.filter(n => n.id === "export-results"), 340);
	assert.deepEqual(partial.edges, []); // No invented assignments from outside the viewer's scope.
});

test("crowded levels stay inside the panel without hiding peers or losing a dependency", () => {
	const root = example.nodes[0], peers = Array.from({ length: 12 }, (_, i) => ({
		...root, id: `peer-${i}`, needs: [root.id],
	}));
	const join = { ...root, id: "join", needs: [root.id, ...peers.map(n => n.id)] };
	const nodes = [root, ...peers, join];
	for (const width of [240, 340, 650, 900]) {
		const g = layout(nodes, width);
		assert.equal(g.width, width);
		assert.deepEqual(g.boxes.map(b => b.id).sort(), nodes.map(n => n.id).sort());
		for (const [i, b] of g.boxes.entries()) {
			assert.ok(b.x >= 0 && b.x + g.w <= width && b.y >= 0 && b.y + g.h <= g.height);
			assert.ok(g.boxes.slice(i + 1).every(o => o.x >= b.x + g.w || b.x >= o.x + g.w ||
				o.y >= b.y + g.h || b.y >= o.y + g.h));
		}
		assert.deepEqual(g.edges.map(e => `${e.from}/${e.to}`).sort(), nodes.flatMap(n => n.needs.map(p => `${p}/${n.id}`)).sort());
	}
});
