import { layout } from "./layout.mjs";

/** @typedef {import("./model.mjs").MapSnapshot} Snapshot */
/** @typedef {import("./model.mjs").Assignment} Assignment */
/** @param {string} id */
function el(id) {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing map element: ${id}`);
	return node;
}
/** @template {keyof HTMLElementTagNameMap} T @param {T} name @param {string} [value] @param {string} [cls] */
function tag(name, value, cls) {
	const node = document.createElement(name);
	if (value) node.textContent = value;
	if (cls) node.className = cls;
	return node;
}
const ns = "http://www.w3.org/2000/svg";
/** @param {string} name */
function icon(name) {
	const svg = document.createElementNS(ns, "svg"), use = document.createElementNS(ns, "use");
	svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
	use.setAttribute("href", `#${name}`); svg.append(use); return svg;
}
/** @type {Record<string,[string,string,string]>} */
const states = {
	unconfirmed: ["Launch unconfirmed", "clock", "stop"], checking: ["Checking", "inspect", "work"], starting: ["Awaiting binding", "clock", "work"],
	assigned: ["Assigned", "write", "work"], waiting: ["Waiting", "clock", ""], queued: ["Queued", "clock", ""],
	blocked: ["Blocked", "stop", "stop"], published: ["Checked", "tick", "done"], qualified: ["Integrated", "tick", "done"],
	repeated: ["Repeated", "tick", "done"], idle: ["Idle", "clock", ""],
};
/** @type {Snapshot|null} */ let data = null;
/** @type {Map<string,Assignment>} */ let nodes = new Map();
/** @type {string|undefined} */ let selected;
let last = "", width = -1, fetching = false;
/** @param {string} id */
const title = id => id.replace(/[-_]+/g, " ").replace(/^./, s => s.toUpperCase());
/** @param {Assignment} n */
const missing = n => n.needs.filter(id => !nodes.get(id)?.checked);
/** @param {Assignment} n */
const state = n => n.state === "waiting" && !missing(n).length ? "queued" : n.state;
/** @param {string} key @param {string} [text] @param {string} [cls] */
function badge(key, text, cls = "node-status") {
	const [name, glyph, tone] = states[key], span = tag("span", "", cls);
	span.dataset.tone = tone; span.append(icon(glyph), text ?? name); return span;
}
/** @param {string} id @param {boolean} [focus] */
function select(id, focus = false) {
	if (!nodes.has(id)) return;
	selected = id;
	for (const button of el("stage").querySelectorAll("button")) {
		const active = button.dataset.id === id;
		button.setAttribute("aria-pressed", String(active));
		if (active && focus) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: "nearest", inline: "nearest" }); }
	}
	for (const wire of el("stage").querySelectorAll("g")) wire.classList.toggle("traced", wire.dataset.from === id || wire.dataset.to === id);
	drawDetails();
}

function drawMap() {
	const plot = el("plot"), stage = el("stage");
	if (!data?.nodes.length || !plot.clientWidth) return;
	const focused = document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.id : undefined;
	width = plot.clientWidth;
	const g = layout(data.nodes, width);
	stage.classList.toggle("wrapped", !!g.levels.length);
	stage.style.width = `${g.width}px`; stage.style.height = `${g.height}px`;
	const wires = document.createElementNS(ns, "svg");
	wires.id = "wires"; wires.setAttribute("aria-hidden", "true");
	wires.setAttribute("width", String(g.width)); wires.setAttribute("height", String(g.height));
	for (const edge of g.edges) {
		const group = document.createElementNS(ns, "g"), source = nodes.get(edge.from);
		group.dataset.from = edge.from; group.dataset.to = edge.to;
		group.classList.add("wire"); group.classList.toggle("pending", !source?.checked);
		group.classList.toggle("stop", source?.state === "blocked");
		group.classList.toggle("traced", edge.from === selected || edge.to === selected);
		for (const [cls, d] of [["line", edge.d], ["arrow", edge.arrow]]) {
			const path = document.createElementNS(ns, "path");
			path.setAttribute("d", d); path.setAttribute("class", cls); group.append(path);
		}
		wires.append(group);
	}
	const fragment = document.createDocumentFragment(); fragment.append(wires);
	let level = 0, next = 0;
	for (const [i, { id, x, y }] of g.boxes.entries()) {
		if (i === next && level < g.levels.length) {
			const row = g.levels[level++];
			const heading = tag("h3", `Level ${level}`, "level");
			heading.style.cssText = `left:${row.x}px;top:${row.y}px`;
			heading.append(tag("span", `${row.count} ${row.count === 1 ? "assignment" : "assignments"}`));
			fragment.append(heading); next += row.count;
		}
		const n = nodes.get(id); if (!n) continue;
		const key = state(n), button = tag("button", "", "node");
		button.type = "button"; button.dataset.id = id; button.dataset.tone = states[key][2];
		button.style.cssText = `left:${x}px;top:${y}px;width:${g.w}px;height:${g.h}px`;
		button.setAttribute("aria-controls", "inspector"); button.setAttribute("aria-pressed", String(id === selected));
		button.title = `${id} · ${states[key][0]}`;
		button.append(tag("span", title(id), "node-name"), badge(key)); button.onclick = () => select(id);
		fragment.append(button);
	}
	stage.replaceChildren(fragment);
	if (focused) (Array.from(stage.querySelectorAll("button")).find(b => b.dataset.id === focused) ??
		Array.from(stage.querySelectorAll("button")).find(b => b.dataset.id === selected))?.focus({ preventScroll: true });
	el("key").hidden = !g.edges.length;
	el("flow").textContent = g.levels.length ? "Showing links for the selected assignment" : g.vertical ? "Output ↓ dependent" : "Output → dependent";
}
/** @param {string} label @param {string[]} ids @param {string} none */
function relations(label, ids, none) {
	const section = tag("div"), list = tag("div", "", "links");
	section.append(tag("h3", label), list);
	if (!ids.length) list.textContent = none;
	for (const id of ids) {
		if (!nodes.has(id)) { list.append(tag("span", `${id} (not in this view)`)); continue; }
		const b = tag("button", title(id), "relation"); b.type = "button"; b.onclick = () => select(id, true); list.append(b);
	}
	return section;
}
/** @param {string} label @param {string} value */
function metadata(label, value) {
	const span = tag("span"); span.append(`${label} `, tag("code", value)); return span;
}
function drawDetails() {
	const box = el("inspector"), n = selected && nodes.get(selected);
	box.hidden = !n; box.replaceChildren(); if (!n) return;
	const key = state(n), head = tag("div", "", "detail-head"); head.append(tag("h2", title(n.id)), badge(key)); box.append(head);
	if (n.task) box.append(tag("p", n.task, "task"));
	const need = missing(n), unknown = need.some(id => !nodes.has(id));
	const why = key === "waiting" ? (unknown ? "Some required outputs are outside this view." : `Waiting for checked output from ${need.join(", ")}.`)
		: key === "assigned" ? "A writer owns this assignment. Foundry does not track whether its session is busy or idle."
		: key === "unconfirmed" ? "The launch was issued, but no writer binding is confirmed. Recover the original launch; do not start a replacement."
		: key === "starting" ? "No writer binding has been recorded yet."
		: key === "queued" ? "No outstanding input is visible. The assignment has not been issued."
		: key === "repeated" ? "The output is checked, but the combined tree reproduced an earlier goal failure."
		: key === "qualified" ? (data?.owner ? "Included in a checked product. See product evidence for the run outcome." : "Included in a checked product.") : "";
	if (why) box.append(tag("p", why, "why"));
	if (n.reason) {
		const p = tag("p", n.reason, "why"); p.dataset.tone = states[key][2]; box.append(p);
	}
	const links = tag("div", "", "relations");
	links.append(relations("Requires", n.needs, n.state === "blocked" ? "No current prerequisites" : "No prerequisites"),
		relations("Used by", [...nodes.values()].filter(other => other.needs.includes(n.id)).map(other => other.id),
			data?.owner ? "No dependents" : "No visible dependents"));
	const meta = tag("div", "", "metadata");
	meta.append(metadata("ID", n.id), metadata("Directory", n.directory), metadata("Check", n.check));
	if (n.checked) meta.append(metadata("Checked output", n.checked));
	if (n.result) meta.append(metadata("Last check", `exit ${n.result.exit ?? "unknown"} @ ${n.result.commit.slice(0, 9)}`));
	box.append(links, meta);
}

/** @param {Snapshot} s */
function draw(s) {
	data = s; nodes = new Map(s.nodes.map(n => [n.id, n]));
	if (!selected || !nodes.has(selected)) selected = (s.nodes.find(n => n.state === "blocked") ??
		s.nodes.find(n => n.state === "waiting" && missing(n).length) ?? s.nodes[0])?.id;
	el("identity").hidden = false; el("content").hidden = false;
	el("run").textContent = s.run; el("phase").textContent = s.phase;
	el("source").textContent = s.example ? "Example · not live" : s.owner ? "Live view" : "Live · participant view";
	el("direction").textContent = s.direction;
	const alerts = el("alerts"); alerts.replaceChildren();
	for (const [label, messages] of [["Run blocker", [s.blocker]], ["Pending call", s.holds], ["Discovery issue", s.scoutIssues], ["Charter question", s.questions]]) {
		for (const message of messages) if (message) {
			const alert = tag("div", "", "alert"); alert.append(tag("strong", String(label)), tag("p", message)); alerts.append(alert);
		}
	}
	const counts = el("counts"); counts.replaceChildren();
	const totals = new Map();
	for (const n of s.nodes) { const key = state(n); totals.set(key, (totals.get(key) ?? 0) + 1); }
	for (const [key, [name]] of Object.entries(states)) if (totals.has(key))
		counts.append(badge(key, `${totals.get(key)} ${name.toLowerCase()}`, "summary-item"));
	if (s.scouting) counts.append(tag("span", `${s.scouting} scouting`, "summary-item"));
	if (s.scoutsStarting) counts.append(tag("span", `${s.scoutsStarting} ${s.scoutsStarting === 1 ? "scout" : "scouts"} starting`, "summary-item"));
	const empty = el("empty");
	el("stage").hidden = !s.nodes.length; empty.hidden = !!s.nodes.length;
	if (!s.nodes.length) {
		el("stage").replaceChildren(); el("key").hidden = true;
		empty.replaceChildren(tag("h2", s.owner ? "No assignments yet" : "No visible assignments"),
			tag("p", s.phase === "Qualified" ? "The product qualified without an assignment." :
				s.blocker || s.scoutIssues.length || s.holds.length ? "See the diagnostic above." : s.scouting ? "Scouts are reviewing the product. Their assignments will appear here." :
				s.scoutsStarting ? "Waiting for workflow discovery to start." : "Assignments appear here when they enter this run and are visible to this session."));
	} else drawMap();
	drawDetails();
	const result = s.goal?.result;
	const verdict = s.qualified ? "Qualified" : result?.exit === 1 ? "Gap observed" : result?.exit === 2 ? "External evidence missing"
		: result?.exit === 0 ? "Goal passed · not yet qualified" : result ? "Goal check inconclusive" : s.goal ? "Goal check pending" : "No qualified product yet";
	el("evidence").hidden = !s.owner; el("verdict").textContent = verdict;
	const proof = el("proof"); proof.replaceChildren();
	for (const [label, value] of [["Checkpoint", s.checkpoint], ["Goal evaluated at", s.goal?.commit], ["Qualified", s.qualified]])
		if (label && value) { const p = tag("p"); p.append(metadata(label, value)); proof.append(p); }
	if (s.timing) {
		const { firstWriter, writerMs, qualifiedMs } = s.timing;
		proof.append(tag("p", `First confirmed writer: ${writerMs !== null ? `${(writerMs / 1000).toFixed(1)} s after activation` :
			firstWriter === "not-applicable" ? "none required" : firstWriter === "bound" ? "time unknown" : "not yet confirmed"}.`));
		if (qualifiedMs !== null) proof.append(tag("p", `Qualified ${(qualifiedMs / 1000).toFixed(1)} s after activation.`));
	}
	if (result) proof.append(tag("p", `Goal check: exit ${result.exit ?? "unknown"}`));
	if (result?.output) proof.append(tag("pre", result.output));
	if (!proof.childElementCount) proof.append(tag("p", "No product check result to show."));
}
async function refresh() {
	if (fetching) return;
	fetching = true; el("refresh").setAttribute("aria-busy", "true");
	try {
		const response = await fetch("./state", { cache: "no-store", signal: AbortSignal.timeout(12000) });
		if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
		const body = await response.text();
		if (body !== last) {
			const snapshot = JSON.parse(body);
			if ("notice" in snapshot) {
				el("notice").textContent = snapshot.notice;
				return;
			}
			draw(snapshot); last = body;
		}
		el("notice").textContent = "";
	} catch (e) {
		data = null; nodes.clear(); selected = undefined; last = "";
		el("content").hidden = true; el("identity").hidden = true; el("direction").textContent = "";
		el("notice").textContent = `Map unavailable: ${e instanceof Error ? e.message : String(e)}. Refresh to retry.`;
	} finally {
		fetching = false; el("refresh").setAttribute("aria-busy", "false");
	}
}
el("refresh").onclick = refresh;
new ResizeObserver(() => { if (el("plot").clientWidth !== width) drawMap(); }).observe(el("plot"));
const updateIfVisible = () => { if (!document.hidden && !data?.example) void refresh(); };
document.addEventListener("visibilitychange", updateIfVisible);
window.setInterval(updateIfVisible, 5000);
void refresh();
