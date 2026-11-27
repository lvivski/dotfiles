import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { closeSync, constants, cpSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { artifactDigest, entries, git, pathNames, regularFiles, verifyTree, writeBlobs } from "./git-files.mjs";
import { canonical, FoundryError, fail, inputCommits, relative, validInputs, verificationEnvironment } from "./recipe.mjs";
import { isDeepStrictEqual } from "node:util";
export const hook=".foundry/prepare-components";
/** @param {string} cwd @param {string} commit */
export function preparationHook(cwd,commit){
	const [entry]=entries(cwd,commit,false,[hook]);
	if(entry && (entry.type!=="blob" || entry.mode!=="100755"))fail("invalid_artifact",`${hook} must be a pinned executable regular file`);
	return entry;
}
const temporary=()=>realpathSync(mkdtempSync(path.join(tmpdir(),"foundry-prepared-")));
/** @typedef {{source:string,expected:string}} Prepared */

/** @param {string} cwd @param {string} source @param {string} dest @param {string} expected */
export function copyPrepared(cwd,source,dest,expected){
	if(artifactDigest(cwd,source)!==expected)fail("invalid_artifact","Prepared source does not match the original build");
	cpSync(source,dest,{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
	if(artifactDigest(cwd,dest)!==expected)fail("invalid_artifact","Prepared copy does not match the original build");
}
/** @param {string} cwd @param {Prepared} build @param {(copy:string)=>Promise<void>} observe */
export async function withPreparedCopy(cwd,build,observe){
	const copy=temporary();
	try{copyPrepared(cwd,build.source,copy,build.expected);await observe(copy);}
	finally{rmSync(copy,{recursive:true,force:true});}
}
const prefix = Buffer.from("FOUNDRY_GOAL_FEEDBACK=");

/** Keep the JSON spelling so a valid number or deeply nested value isn't changed by reserialization.
 * @param {unknown} value @returns {value is string} */
export function validFeedback(value) {
	if (typeof value !== "string") return false;
	try { JSON.parse(value); return true; } catch { return false; }
}

/** @param {Buffer} stdout @param {Buffer} [file] */
export function feedback(stdout, file) {
	/** @type {string|undefined} */ let record;
	for (let start = 0; start < stdout.length;) {
		const lf = stdout.indexOf(10, start), end = lf < 0 ? stdout.length : lf;
		if (stdout.subarray(start, start + prefix.length).equals(prefix)) {
			const bytes = stdout.subarray(start + prefix.length, stdout[end - 1] === 13 ? end - 1 : end);
			if (file?.length || record !== undefined || !isUtf8(bytes)) return;
			record = bytes.toString();
			if (!validFeedback(record)) return;
		}
		start = end + 1;
	}
	if (!file?.length) return record;
	if (isUtf8(file)) {
		const json = file.toString();
		if (validFeedback(json)) return json;
	}
}
/** @param {{bytes:string,inline:boolean}|undefined} input @param {NodeJS.ProcessEnv} env @param {string} dir */
function bindGoalFiles(input,env,dir){
	env.FOUNDRY_GOAL_FEEDBACK_FILE=join(dir,"feedback.json");
	if(input){
		const file=join(dir,"delta.json");writeFileSync(file,input.bytes,{flag:"wx",mode:0o400});
		env.FOUNDRY_GOAL_DELTA_FILE=file;
		if(input.inline)env.FOUNDRY_GOAL_DELTA=input.bytes;
	}
	return env.FOUNDRY_GOAL_FEEDBACK_FILE;
}
/** @param {{bytes:string,inline:boolean}|undefined} input @param {NodeJS.ProcessEnv} env */
export function goalFiles(input, env) {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-feedback-"));
	/** @type {number|undefined} */ let fd;
	const close = () => {
		try { if (fd !== undefined) closeSync(fd); } finally { rmSync(dir, { recursive: true, force: true }); }
	};
	try {
		fd = openSync(bindGoalFiles(input,env,dir), "wx+", 0o600);
		const original = fd;
		/** @param {Buffer} stdout */
		function collect(stdout) {
			// Read the descriptor we created, not a path the evaluator could replace with a link or FIFO.
			if (fstatSync(original).nlink !== 1) throw new FoundryError("invalid_feedback", "The runner-owned output file was replaced or linked");
			const bytes = readFileSync(original), json = feedback(stdout, bytes);
			if (json !== undefined) return { json, legacy: !bytes.length };
			if (bytes.length || stdout.includes(prefix)) throw new FoundryError("invalid_feedback", "Expected one UTF-8 JSON value from the file or one stdout marker, not both");
		}
		return { close, collect };
	} catch (error) { close(); throw error; }
}

/** @typedef {import("./recipe-types.js").VerificationInputs} Inputs */
/** @typedef {import("./recipe-types.js").VerificationScope} Scope */
/** @typedef {import("./recipe-types.js").Checker} Checker */
/** @typedef {{env?:NodeJS.ProcessEnv,prepared?:Prepared,delta?:string}} Supply */
/** @typedef {{root:string,check:string,executable:string,args:string[],env:NodeJS.ProcessEnv,feedback?:ReturnType<typeof goalFiles>}} Invocation */
/** The execution boundary, not inspection of old repin history, enforces this namespace.
 * A separately approved historical harness has its own exact partition.
 * @param {{paths:string[],revision:string,exact?:string}|undefined} overlay */
export function checkedOverlay(overlay){
	if(overlay && !Array.isArray(overlay.paths))fail("invalid_inputs","Expected exact overlay paths and their source revision");
	if(overlay?.paths.some(p=>!p.startsWith(".foundry/") && p!==overlay.exact))fail("contract_scope","Evaluator overlay includes product paths");
	return overlay;
}
/** @param {string} cwd @param {string} commit @param {(root:string)=>void|Promise<void>} evaluate @param {{paths:string[], revision:string,exact?:string}} [overlay]
 * @param {{file:string,revision:string,blob?:string,before?:string}} [test] The single certified evaluator, never a directory or writable product path. */
export async function withProduct(cwd, commit, evaluate, overlay, test) {
	return withEntries(cwd,resolveExport(cwd,commit,checkedOverlay(overlay),test).items,evaluate);
}

/** Resolve exact paths from their source, including a path absent in that tree.
 * @param {string} cwd @param {string} commit @param {{revision:string,paths:string[]}} [overlay]
 * @param {{file:string,revision:string,blob?:string,before?:string}} [test] */
function resolveExport(cwd,commit,overlay,test){
	const items=new Map(entries(cwd,commit,true).map(e=>[e.name,e]));
	/** @type {OverlayFile[]} */ const inventory=[];
	if(overlay?.paths.length){
		const replaced=new Set(overlay.paths.map(relative));
		for(const p of replaced)items.delete(p);
		for(const e of entries(cwd,overlay.revision,true,[...replaced]))if(replaced.has(e.name))items.set(e.name,e);
		for(const path of replaced){const e=items.get(path);inventory.push({path,mode:e?.mode??null,blob:e?.oid??null});}
	}
	if(test){
		const [entry]=regularFiles(cwd,test.revision,[test.file]),original=items.get(test.file);
		if(!original || original.mode!==entry.mode || test.blob && entry.oid!==test.blob || test.before && original.oid!==test.before)
			fail("contract_scope","Certified test preimage, proposed bytes, path or mode do not match");
		items.set(test.file,entry);
	}
	return {items:[...items.values()],overlay:inventory};
}

/** Write only raw regular blobs to an empty private root. No checkout, filters, hooks or evaluator.
 * @param {string} cwd @param {string} root @param {Entry[]} items */
export async function writeExport(cwd,root,items){
	if(realpathSync(root)!==root || !lstatSync(root).isDirectory() || readdirSync(root).length)
		fail("invalid_inputs","Expected a new, empty export directory");
	pathNames(items);
	for(const e of items)if(relative(e.name)!==e.name || e.type!=="blob" || !["100644","100755"].includes(e.mode))
		fail("unsupported_tree",`Cannot evaluate ${e.name}: not a regular file`);
	await writeBlobs(cwd,root,items);
	verifyTree(cwd,root,items);
}
/** @param {string} cwd @param {Entry[]} items @param {(root:string)=>void|Promise<void>} evaluate */
export async function withEntries(cwd,items,evaluate){
	const root=realpathSync(mkdtempSync(path.join(tmpdir(),"foundry-check-")));
	try{
		await writeExport(cwd,root,items);
		await evaluate(root);
		verifyTree(cwd, root, items);
	}
	finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** @param {string} bytes */
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
/** @template T @param {T} v @returns {T} */
function freeze(v){
	if(v && typeof v==="object"){for(const child of Object.values(v))freeze(child);Object.freeze(v);}
	return v;
}
/** @param {import("./git-files.mjs").Entry} e @returns {Checker} */
function identity(e){
	if(e.mode!=="100644" && e.mode!=="100755")fail("missing_contract",`Expected a regular checker: ${e.name}`);
	return {path:e.name,blob:e.oid,mode:e.mode};
}
/** Resolve only after the controller has established authority for the source selections.
 * @param {string} cwd @param {{commit:string,check:string,scope:Scope,overlay?:Inputs["overlay"],
 * test?:{file:string,revision:string,blob?:string,before?:string},prepared?:Prepared,delta?:{bytes:string,inline:boolean},control?:Inputs["control"]}} spec
 * @returns {Inputs} */
export function resolveInputs(cwd,{commit,check,scope,overlay,test,prepared,delta,control}){
	const from=overlay?.paths.includes(check)?overlay.revision:commit;
	const [original]=regularFiles(cwd,from,[check]);
	const entry=test?regularFiles(cwd,test.revision,[check])[0]:original;
	if(test && (test.file!==check || entry.mode!==original.mode || test.blob && test.blob!==entry.oid || test.before && test.before!==original.oid))
		fail("contract_scope","Certified test does not match the checked path, preimage and mode");
	const inputs=/** @type {Inputs} */ ({version:1,commit,checker:{...identity(entry),
		...(test && {replacement:{revision:test.revision,before:original.oid}})},scope,
		...(overlay && {overlay:{revision:overlay.revision,paths:[...overlay.paths].sort()}}),
		...(prepared && {prepared:prepared.expected}),...(delta && {delta:{hash:sha(delta.bytes),inline:delta.inline}}),...(control && {control})});
	if(!validInputs(inputs))fail("invalid_inputs","Could not resolve immutable verification inputs");
	return freeze(structuredClone(inputs));
}

/** @param {string} cwd @param {string} commit @param {string} path */
export const pinnedChecker=(cwd,commit,path)=>identity(regularFiles(cwd,commit,[path])[0]);
/** Resolution and materialization are separate: the recipient can independently check every Git fact.
 * @param {string} cwd @param {Inputs} v */
function verifiedExport(cwd,v){
	const pins=[...new Set(inputCommits(v))],types=git(cwd,["cat-file","--batch-check=%(objectname) %(objecttype)"],pins.join("\n")+"\n");
	if(types.toString().trimEnd()!==pins.map(id=>`${id} commit`).join("\n"))fail("unavailable_inputs","Missing or non-commit verification source");
	const {checker:c}=v,t=c.replacement,physical=resolveExport(cwd,v.commit,v.overlay,t && {file:c.path,revision:t.revision,blob:c.blob,before:t.before});
	const e=physical.items.find(e=>e.name===c.path);
	if(!e || e.oid!==c.blob || e.mode!==c.mode)fail("invalid_inputs","Actual checker bytes or mode differ from the observation");
	if(v.control){
		const driver=pinnedChecker(cwd,v.control.commit,v.control.checker.path);
		if(driver.mode!=="100755" || driver.blob!==v.control.checker.blob || driver.mode!==v.control.checker.mode)
			fail("invalid_inputs","Actual control differs from its activation pin");
	}
	return physical;
}

/** @param {string} root @param {string} check @param {string[]} args @param {NodeJS.ProcessEnv} env */
function invocation(root,check,args,env){
	const file=join(root,check),js=/\.m?js$/.test(file);
	return {root,check,executable:js?process.execPath:file,args:js?[file,...args]:args,env};
}
/** @param {Inputs} v @param {string|undefined} bytes */
function privateInput(v,bytes){
	if(v.delta ? bytes===undefined || sha(bytes)!==v.delta.hash : bytes!==undefined)
		fail("unavailable_inputs","Exact private scheduling input is required; no evaluator was invoked");
	return v.delta && {bytes:/** @type {string} */ (bytes),inline:v.delta.inline};
}
/** Callback-only materialization; never invoke an evaluator, build hook, or access a run.
 * @param {string} cwd @param {Inputs} inputs @param {(invocation:Invocation)=>void|Promise<void>} observe @param {Supply} [supply] */
export async function withSourceInputs(cwd,inputs,observe,supply={}){
	const v=structuredClone(inputs);
	const {items}=verifiedExport(cwd,v),env=verificationEnvironment(v.scope,supply.env);
	const delta=privateInput(v,supply.delta),files=v.scope.kind==="goal"?goalFiles(delta,env):undefined;
	/** @param {string} root @param {string} check @param {string[]} args */
	const inspect=(root,check,args)=>{
		return observe({...invocation(root,check,args,env),feedback:files});
	};
	/** @param {Prepared} [build] */
	const run=async build=>{
		if(build?.expected!==v.prepared)fail("unavailable_inputs","Prepared bytes differ from the recorded verification inputs");
		await withEntries(cwd,items,async subject=>{
			const invoke=async(/** @type {string|undefined} */ prepared)=>{
				if(prepared)env.FOUNDRY_PREPARED_DIR=prepared;
				const driver=v.control;
				if(driver)await withProduct(cwd,driver.commit,root=>inspect(root,driver.checker.path,[driver.example,subject]));
				else await inspect(subject,v.checker.path,[]);
			};
			if(build)await withPreparedCopy(cwd,build,invoke);else await invoke(undefined);
		});
	};
	try{
		await run(supply.prepared);
	}finally{files?.close();}
}

/** @typedef {import("./git-files.mjs").Entry} Entry */
/** @typedef {{path:string,mode:string|null,blob:string|null}} OverlayFile */
/** @typedef {{tree:string,carrier:string}} Snapshot */
/** @typedef {{subject:Snapshot,overlay:OverlayFile[],preparation?:Snapshot}} Disclosure */
/** @typedef {{inputs:Inputs,disclosure:Disclosure}} Observation */
/** @typedef {(type:"tree"|"commit",id:string,bytes:Buffer)=>void} Store */
/** @param {string} format @param {"tree"|"commit"} type @param {Buffer} bytes @param {Store} [store] */
function objectID(format,type,bytes,store){
	const id=createHash(format).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");store?.(type,id,bytes);return id;
}
/** Hash the actual exported paths in Git's tree order. No source object or ref is written on proof reads.
 * @param {string} format @param {Entry[]} items @param {Store} [store] */
function treeID(format,items,store){
	/** @typedef {Map<string,Branch|Entry>} Branch */
	/** @type {Branch} */ const root=new Map();pathNames(items);
	for(const entry of items){
		if(entry.type!=="blob" || !["100644","100755"].includes(entry.mode))fail("unsupported_tree",`Not a regular replay input: ${entry.name}`);
		const parts=entry.name.split("/"),leaf=parts.pop()??"";let dir=root;
		for(const part of parts){
			if(!dir.has(part))dir.set(part,new Map());
			const child=dir.get(part);if(!(child instanceof Map))fail("tree_conflict","File and directory paths overlap");
			dir=child;
		}
		if(dir.has(leaf))fail("tree_conflict","Duplicate file or directory path");dir.set(leaf,entry);
	}
	/** @param {Branch} dir @returns {string} */
	const tree=dir=>{
		const rows=Array.from(dir,([name,e])=>{
			const branch=e instanceof Map,mode=branch?"40000":e.mode,id=branch?tree(e):e.oid;
			return {key:Buffer.from(name+(branch?"/":"")),data:Buffer.concat([Buffer.from(`${mode} ${name}\0`),Buffer.from(id,"hex")])};
		}).sort((a,b)=>Buffer.compare(a.key,b.key));
		return objectID(format,"tree",Buffer.concat(rows.map(row=>row.data)),store);
	};
	return tree(root);
}
/** @param {Inputs} v @param {OverlayFile[]} overlay @param {"subject"|"preparation"} role @param {string} tree */
function carrierBytes(v,overlay,role,tree){
	const identity=role==="subject"?[role,v,overlay]:[role,v.commit,v.prepared,hook];
	return Buffer.from(`tree ${tree}\nauthor Foundry <foundry@localhost> 1 +0000\ncommitter Foundry <foundry@localhost> 1 +0000\n\nFoundry replay carrier v1\n${sha(canonical(identity))}\n`);
}
/** @param {Inputs} v @param {OverlayFile[]} overlay @param {"subject"|"preparation"} role @param {Entry[]} items @param {Store} [store] */
function snapshot(v,overlay,role,items,store){
	const format=v.commit.length===40?"sha1":"sha256",tree=treeID(format,items,store);
	return {tree,carrier:objectID(format,"commit",carrierBytes(v,overlay,role,tree),store)};
}
/** Only effective subject bytes are disclosed, plus the separately consumed pristine build root if necessary.
 * The overlay inventory proves each selected path, including deletion; a replaced preimage is an ID, not a disclosed blob.
 * @param {string} cwd @param {Inputs} v @param {Store} [store] @returns {Disclosure} */
export function describeDisclosure(cwd,v,store){
	const {items:subject,overlay}=verifiedExport(cwd,v);
	if(v.control)fail("invalid_inputs","A calibration cannot be exported as a qualifying observation");
	const build=v.prepared?entries(cwd,v.commit,true):undefined;
	const blobs=[...new Set([...subject,...build??[]].map(e=>e.oid))];
	if(blobs.length && git(cwd,["cat-file","--batch-check=%(objectname) %(objecttype)"],blobs.join("\n")+"\n").toString().trimEnd()!==blobs.map(id=>`${id} blob`).join("\n"))
		fail("unavailable_inputs","Required source blob is missing");
	const result={subject:snapshot(v,overlay,"subject",subject,store),overlay};
	if(!build)return result;
	if(!preparationHook(cwd,v.commit))fail("invalid_inputs","Missing prepared build hook");
	return {...result,preparation:snapshot(v,overlay,"preparation",build,store)};
}
/** Verify the owner's snapshot against its committed carrier independently of source history.
 * @param {string} cwd @param {Observation} o @param {"subject"|"preparation"} role @param {boolean} [retained] */
export function carrierEntries(cwd,o,role,retained=false){
	const {inputs:v,disclosure:d}=o;if(!validInputs(v) || v.control || !d || !!v.prepared!==!!d.preparation ||
		!Array.isArray(d.overlay) || !isDeepStrictEqual(d.overlay.map(f=>f.path),v.overlay?.paths??[]))fail("invalid_inputs","Invalid replay disclosure");
	const s=d[role],oid=(/** @type {unknown} */ x)=>typeof x==="string" && x.length===v.commit.length && /^[0-9a-f]+$/.test(x);
	if(!s || !oid(s.tree) || !oid(s.carrier))fail("invalid_inputs","Invalid replay carrier identity");
	if(retained && git(cwd,["rev-parse","--verify",`refs/foundry/replay/${s.carrier}`]).toString().trim()!==s.carrier)
		fail("invalid_inputs","Replay carrier was not imported");
	const bytes=git(cwd,["cat-file","commit",s.carrier]);
	if(!bytes.equals(carrierBytes(v,d.overlay,role,s.tree)))fail("invalid_inputs","Carrier has parents, extra metadata, or disagrees with the original recipe");
	const items=entries(cwd,s.carrier,true),byPath=new Map(items.map(e=>[e.name,e]));
	if(!isDeepStrictEqual(snapshot(v,d.overlay,role,items),s))fail("invalid_inputs","Carrier tree or mode inventory disagrees with the approved disclosure");
	if(role==="preparation"){
		if(byPath.get(hook)?.mode!=="100755")fail("invalid_inputs","Missing preparation executable");
	}else{
		const c=v.checker,entry=byPath.get(c.path);
		if(entry?.oid!==c.blob || entry.mode!==c.mode)fail("invalid_inputs","Carrier checker bytes or mode differ from the observation");
		for(const f of d.overlay){
			const current=byPath.get(f.path),blob=f.path===c.path && c.replacement?c.replacement.before:current?.oid??null;
			if(blob!==f.blob || (current?.mode??null)!==f.mode)fail("invalid_inputs",`Carrier overlay disagrees at ${f.path}`);
		}
	}
	return items;
}

/** @typedef {{kind:"prepare"|"check"|"verify"|"copy-prepared",role:string,cwd:string,executable:string,argv:string[],env:NodeJS.ProcessEnv,envFiles?:Record<string,string>}} Step */
/** A private root alone does not isolate a checkout or Node's ancestor package resolution.
 * Check the real parents at materialization and again at replay boundaries. @param {string} value */
export function replayDestination(value){
	const out=path.resolve(value),parent=path.dirname(out),uid=process.getuid?.();
	const p=lstatSync(parent);
	if(out===parent || /^\.git[ .]*$/i.test(path.basename(out)) || realpathSync(parent)!==parent || !p.isDirectory() || uid===undefined || p.uid!==uid || (p.mode&0o777)!==0o700)
		fail("invalid_path","Replay needs a canonical, user-owned private staging parent (0700)");
	for(let d=parent;;d=path.dirname(d)){
		const st=lstatSync(d),has=(/** @type {string} */ name)=>!!lstatSync(join(d,name),{throwIfNoEntry:false});
		if((st.uid!==uid && st.uid!==0) || (st.mode&0o022) && !(st.mode&0o1000))
			fail("invalid_path","Replay staging has an untrusted or shared writable ancestor");
		if(/^\.git[ .]*$/i.test(path.basename(d)) || has(".git") || has("HEAD") && (has("objects") || has("commondir")) ||
			has("package.json") || has("node_modules"))fail("invalid_path","Replay must be outside Git and ambient Node package contexts");
		if(d===path.dirname(d))return out;
	}
}
/** A persistent, inert launch plan. Only the caller may choose to execute its commands.
 * @param {string} cwd @param {string} dest @param {{role:string,observation:Observation}[]} selected
 * @param {string} helper @param {string} [delta] */
export async function materializePlan(cwd,dest,selected,helper,delta){
	dest=replayDestination(dest);
	const inputs=selected.map(({role,observation:o})=>({role,o,items:carrierEntries(cwd,o,"subject",true),
		build:o.disclosure.preparation?carrierEntries(cwd,o,"preparation",true):undefined,
		delta:privateInput(o.inputs,o.inputs.scope.kind==="goal"?delta:undefined)}));
	if(delta!==undefined && !inputs.some(x=>x.delta))fail("invalid_inputs","No selected recipe requested private scheduling data");
	mkdirSync(dest,{mode:0o700});
	/** @type {Step[]} */ const steps=[];
	const dir=(/** @type {string} */ name)=>{const p=join(dest,name);mkdirSync(p,{mode:0o700});return p;};
	/** @param {Step["kind"]} kind @param {string} role @param {string[]} args */
	const utility=(kind,role,args)=>steps.push({kind,role,cwd,executable:process.execPath,argv:[helper,...args],env:{}});
	const prepared=new Map();
	try{
		for(const [i,{role,o,items,build,delta:privateBytes}] of inputs.entries()){
			const v=o.inputs,env=verificationEnvironment(v.scope),root=dir(`check-${i}`),s=o.disclosure;
			await writeExport(cwd,root,items);
			if(build && s.preparation && v.prepared){
				const key=role.startsWith("joined:")?s.preparation.carrier:`standalone-${i}`;
				let source=prepared.get(key);
				if(!source){
					const from=dir(`build-${i}`);await writeExport(cwd,from,build);source=dir(`output-${i}`);prepared.set(key,source);
					const launch=invocation(from,hook,[source],{});
					utility("verify",role,["verify-tree",s.preparation.carrier,from,"--empty-output",source]);
					steps.push({kind:"prepare",role,cwd:from,executable:launch.executable,argv:launch.args,env:{}});
					utility("verify",role,["verify-tree",s.preparation.carrier,from]);
				}
				const copy=join(dest,`prepared-${i}`);
				utility("copy-prepared",role,["copy-prepared",v.prepared,source,copy]);env.FOUNDRY_PREPARED_DIR=copy;
			}
			const feedback=v.scope.kind==="goal"?bindGoalFiles(privateBytes,env,dir(`feedback-${i}`)):undefined;
			const launch=invocation(root,v.checker.path,[],env);
			const envFiles=privateBytes?.inline?{FOUNDRY_GOAL_DELTA:/** @type {string} */ (env.FOUNDRY_GOAL_DELTA_FILE)}:undefined;
			delete env.FOUNDRY_GOAL_DELTA;
			utility("verify",role,["verify-tree",s.subject.carrier,root,...(feedback?["--new-feedback",feedback]:[]),...(v.delta?["--delta",v.delta.hash,/** @type {string} */ (env.FOUNDRY_GOAL_DELTA_FILE)]:[])]);
			steps.push({kind:"check",role,cwd:root,executable:launch.executable,argv:launch.args,env,...(envFiles && {envFiles})});
			utility("verify",role,["verify-tree",s.subject.carrier,root]);
		}
		return {format:"foundry-launch/v2",steps};
	}catch(error){rmSync(dest,{recursive:true,force:true});throw error;}
}
