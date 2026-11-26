import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { example } from "./model.mjs";
import { serveMap } from "./server.mjs";

const browser=process.env.FOUNDRY_TEST_BROWSER;
test("a paused board renders a phase icon and a colored, labeled indicator per visible status",
	{skip:!browser && "Set FOUNDRY_TEST_BROWSER to a Chromium executable"},async t=>{
	assert.ok(browser);
	const profile=await mkdtemp(join(tmpdir(),"foundry-status-"));t.after(()=>rm(profile,{recursive:true,force:true}));
	const nodes=["blocked","waiting","published","qualified"].map(state=>({...example.nodes[0],state,id:state}));
	const server=await serveMap(async()=>({...example,phase:"Paused",nodes}));t.after(server.close);
	const {stdout}=await promisify(execFile)(browser,["--headless","--no-first-run","--disable-background-networking",
		`--user-data-dir=${profile}`,"--virtual-time-budget=2000","--dump-dom",server.url],{timeout:20000});
	const footer=/<footer\b[^>]*>([\s\S]*?)<\/footer>/.exec(stdout)?.[1];assert.ok(footer);
	const indicators=[...footer.matchAll(/<(?:span|li)\b([^>]*)>(<svg\b[^>]*>[\s\S]*?<\/svg>)([^<]+)<\/(?:span|li)>/g)];
	assert.deepEqual(indicators.map(([,attrs,svg,label])=>{
		assert.match(svg,/aria-hidden="true"/);
		return [label,/href="#([^"]+)"/.exec(svg)?.[1],/data-tone="([^"]+)"/.exec(attrs)?.[1]];
	}),[["Paused","pause","hold"],["1 blocked","stop","stop"],["1 queued","clock","wait"],
		["1 component checked","tick","done"],["1 integrated","tick","done"]]);
});

test("inactive pause and resume controls keep their visible outlines without hover", {skip:!browser},async t=>{
	assert.ok(browser);
	const dir=await mkdtemp(join(tmpdir(),"foundry-events-"));t.after(()=>rm(dir,{recursive:true,force:true}));
	const page=join(dir,"events.html"),base=new URL("./",import.meta.url).href;
	await writeFile(page,`<!doctype html><base href="${base}"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="studio.css">
		<body class="studio"><svg>${["pause","resume"].map(e=>`<g class="event-chip"><rect width="52" height="21"/><text>${e}</text></g>`).join("")}</svg>
		<script>onload=()=>{document.body.textContent=[...document.querySelectorAll(".event-chip rect")].map(r=>{
			const s=getComputedStyle(r);return s.stroke!=="none" && s.stroke!=="transparent" && !s.stroke.endsWith(", 0)") && s.stroke!==s.fill && parseFloat(s.strokeWidth)>0;
		}).join(",")}</script>`);
	const {stdout}=await promisify(execFile)(browser,["--headless","--no-first-run","--disable-background-networking",
		`--user-data-dir=${join(dir,"profile")}`,"--dump-dom",pathToFileURL(page).href],{timeout:20000});
	assert.match(stdout,/<body class="studio">true,true<\/body>/);
});

test("the painted inspector icon follows the same WebKit canvas across a resize", {
	skip:process.platform!=="darwin" || process.env.FOUNDRY_TEST_WEBKIT!=="1" ? "Set FOUNDRY_TEST_WEBKIT=1 on macOS" : false,
},async t=>{
	const dir=await mkdtemp(join(tmpdir(),"foundry-dock-"));t.after(()=>rm(dir,{recursive:true,force:true}));
	const server=await serveMap(async()=>example);t.after(server.close);
	const bin=join(dir,"inspector"),probe=fileURLToPath(new URL("../test/fixtures/inspector.swift",import.meta.url));
	await promisify(execFile)("xcrun",["swiftc","-parse-as-library",probe,"-o",bin],{timeout:60000});
	await promisify(execFile)(bin,[server.url],{timeout:30000});
});
