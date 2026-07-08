/**
 * @module canvas
 *
 * (Experimental) A tiny localhost web panel that renders a cwf run's live progress as a dashboard,
 * for the SDK `createCanvas` surface. Deliberately SDK-free (pure `node:http`) so it unit-tests
 * under plain `node --test`; `extension.mjs` declares the canvas and points its `open` handler at
 * {@link Panel.url}. The page polls the run's `state.json` (the engine's live snapshot) and
 * re-renders client-side using `textContent` only — untrusted subagent labels/models/errors are
 * never inserted as HTML. Bound to 127.0.0.1; runIds are validated to block path traversal.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** A run id is a bare token — no separators, so it can't traverse out of the runs dir. */
const SAFE_RUNID = /^[A-Za-z0-9._-]+$/;

/** @param {unknown} s @returns {string} HTML-escaped text. */
export const escapeHtml = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => /** @type {any} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** JSON safe to embed inside a `<script>` tag: escapes `<` (so `</script>` can't break out) + JS line separators. @param {unknown} v */
const jsEmbed = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/**
 * Render the dashboard HTML shell for one run. Live values are filled by the embedded client from
 * the `state` poll; a small server-rendered summary gives a no-JS first paint.
 * @param {string} runId a SAFE_RUNID-validated id (safe to embed in HTML/JS string contexts)
 * @param {any} [state] initial snapshot (best-effort)
 * @returns {string}
 */
export function renderDashboardHtml(runId, state = {}) {
	const title = escapeHtml(state.title || runId);
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cwf · ${title}</title>
<style>
:root{color-scheme:dark light}
body{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:16px;background:#0d1117;color:#c9d1d9}
h1{font-size:15px;margin:0 0 2px;font-weight:600}
.sub{color:#8b949e;margin-bottom:14px}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;text-transform:uppercase;font-size:11px}
.running{background:#1f6feb33;color:#58a6ff}.complete{background:#23863633;color:#3fb950}
.error,.failed,.timeout{background:#da363333;color:#f85149}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;min-width:88px}
.card .n{font-size:20px;font-weight:600}.card .k{color:#8b949e;font-size:11px;text-transform:uppercase}
table{border-collapse:collapse;width:100%;margin:6px 0 18px}
th{text-align:left;color:#8b949e;font-weight:600;font-size:11px;text-transform:uppercase;border-bottom:1px solid #30363d;padding:4px 8px}
td{padding:4px 8px;border-bottom:1px solid #21262d}
.sec{font-size:11px;text-transform:uppercase;color:#8b949e;font-weight:600;margin:0 0 4px}
.err td{color:#f85149}.dim{color:#8b949e}.ok{color:#3fb950}
.empty{color:#8b949e;font-style:italic;padding:4px 8px}
</style></head>
<body>
<h1>cwf · <span id="title">${title}</span></h1>
<div class="sub"><span id="status" class="badge running">…</span> &nbsp; phase <span id="phase">—</span> &nbsp; <span id="elapsed" class="dim"></span></div>
<div class="cards">
	<div class="card"><div class="n ok" id="c-done">0</div><div class="k">done</div></div>
	<div class="card"><div class="n" id="c-failed">0</div><div class="k">failed</div></div>
	<div class="card"><div class="n dim" id="c-cached">0</div><div class="k">cached</div></div>
	<div class="card"><div class="n dim" id="c-skipped">0</div><div class="k">skipped</div></div>
	<div class="card"><div class="n" id="c-aic">0.0</div><div class="k">AIC</div></div>
	<div class="card"><div class="n" id="c-tok">0</div><div class="k">tokens</div></div>
</div>
<div class="sec">Running</div>
<table><thead><tr><th>label</th><th>model</th><th>phase</th></tr></thead><tbody id="running"></tbody></table>
<div class="sec">Recent</div>
<table><thead><tr><th>label</th><th>status</th><th>AIC</th></tr></thead><tbody id="recent"></tbody></table>
<div class="sec">Errors</div>
<table><tbody id="errors"></tbody></table>
<script>
const RUN=${jsEmbed(runId)};
const $=(id)=>document.getElementById(id);
const started=Date.parse(${jsEmbed(state.startedAt || "")})||Date.now();
function rows(tb,items,cols,cls){tb.textContent="";if(!items||!items.length){const tr=tb.insertRow();const td=tr.insertCell();td.colSpan=cols.length||1;td.className="empty";td.textContent="—";return;}for(const it of items){const tr=tb.insertRow();if(cls)tr.className=cls(it);for(const c of cols){const td=tr.insertCell();td.textContent=c(it);}}}
function render(s){
	s=s||{};const c=s.counts||{};
	$("title").textContent=s.title||RUN;
	const st=$("status");st.textContent=s.status||"…";st.className="badge "+(s.status||"running");
	$("phase").textContent=s.phase||"—";
	$("c-done").textContent=c.done||0;$("c-failed").textContent=c.failed||0;
	$("c-cached").textContent=c.cached||0;$("c-skipped").textContent=c.skipped||0;
	$("c-aic").textContent=(+(s.aic||0)).toFixed(2);$("c-tok").textContent=s.outputTokens||0;
	rows($("running"),s.running,[a=>a.label||"",a=>a.model||"",a=>a.phase||""]);
	rows($("recent"),s.recent,[a=>a.label||"",a=>a.status||"",a=>(+(a.aic||0)).toFixed(3)]);
	rows($("errors"),s.errors,[a=>a.label||"",a=>a.error||""],()=>"err");
}
function elapsed(){const s=Math.max(0,(Date.now()-started)/1000);$("elapsed").textContent=s.toFixed(0)+"s";}
async function tick(){try{const r=await fetch("/r/"+encodeURIComponent(RUN)+"/state",{cache:"no-store"});if(r.ok)render(await r.json());}catch(e){}elapsed();}
render(${jsEmbed(state)});elapsed();tick();setInterval(tick,1000);
</script>
</body></html>`;
}

/**
 * Start the localhost progress-panel server. Routes: `GET /r/<id>` → dashboard HTML, and
 * `GET /r/<id>/state` → the JSON at `<runsDir>/<id>/state.json`.
 * @param {{ runsDir: string, host?: string }} opts
 * @returns {Promise<{ port: number, url: (runId: string) => string, close: () => Promise<void> }>}
 */
export function startPanel({ runsDir, host = "127.0.0.1" }) {
	const server = createServer((req, res) => {
		const path = (req.url || "").split("?")[0];
		const m = /^\/r\/([^/]+)(\/state)?\/?$/.exec(path);
		const runId = m ? decodeURIComponent(m[1]) : "";
		if (!m || !SAFE_RUNID.test(runId)) {
			res.writeHead(m ? 400 : 404, { "content-type": "text/plain" });
			res.end(m ? "invalid run id" : "not found");
			return;
		}
		const statePath = join(runsDir, runId, "state.json");
		if (m[2]) {
			const body = existsSync(statePath) ? readOr(statePath, "{}") : "{}";
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(body);
		} else {
			let state = {};
			try {
				state = JSON.parse(readOr(statePath, "{}"));
			} catch {
				/* first paint with empty state */
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(renderDashboardHtml(runId, state));
		}
	});
	return new Promise((resolve) => {
		server.listen(0, host, () => {
			const addr = /** @type {any} */ (server.address());
			resolve({
				port: addr.port,
				url: (runId) => `http://${host}:${addr.port}/r/${encodeURIComponent(runId)}`,
				close: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}

/** @param {string} path @param {string} fallback @returns {string} */
function readOr(path, fallback) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return fallback;
	}
}
